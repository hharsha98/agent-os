// Portability: the bundled server running outside a repo checkout, the
// cross-platform executable lookup, process-tree kill, and graceful shutdown.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { killProcessTree, spawnTracked } from "../server/runtime/process-tree.js";
import { runCommand, which, withSiblingNodePath } from "../server/runtime/safety.js";
import { shutdown } from "../server/runtime/shutdown.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function readyPort(text) {
  const match = text.match(/AGENT_OS_READY:(\d+)/);
  return match ? Number(match[1]) : null;
}

function collectLogs(child) {
  const ref = { text: "" };
  child.stdout?.on("data", (chunk) => {
    ref.text += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    ref.text += chunk;
  });
  return ref;
}

async function waitForReady(child, logsRef, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const port = readyPort(logsRef.text);
    if (port) return port;
    if (child.exitCode != null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logsRef.text.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never printed AGENT_OS_READY:\n${logsRef.text.slice(-2000)}`);
}

async function killChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// The terminal's exit code, or a plain failure after `seconds`: a hung terminal must not hold a test until
// the runner's own limit. (The caller stops the terminal it started.)
function exitCodeWithin(term, seconds = 15) {
  let timer;
  const exit = new Promise((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)));
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the bundled terminal did not exit within ${seconds} s`)), seconds * 1000);
  });
  return Promise.race([exit, late]).finally(() => clearTimeout(timer));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("bundled server runs outside the repo", () => {
  let bundleDir = null;
  let skipReason = "";
  // The prebuilt node-pty folder the bundle carries when it is built for this computer.
  const hostPrebuild = `${process.platform}-${process.arch}`;

  // Retries: on a Windows runner a virus scanner can hold a freshly copied .exe or .dll for a moment.
  const removeDir = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // A fresh temp folder at its real path (macOS: /var is a link to /private/var).
  const makeTemp = async (prefix) => realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));

  before(async () => {
    const distDir = path.join(root, "dist");
    if (!existsSync(distDir)) {
      skipReason = "dist/ is missing; run `npm run build` before this test.";
      return;
    }
    await new Promise((resolve, reject) => {
      const build = spawn(process.execPath, ["scripts/build-server-bundle.mjs"], {
        cwd: root,
        stdio: "inherit"
      });
      build.once("error", reject);
      build.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build-server-bundle.mjs exited ${code}`))));
    });
    const candidate = path.join(root, "build", "server");
    if (existsSync(path.join(candidate, "server.mjs"))) {
      bundleDir = candidate;
    } else {
      skipReason = "build-server-bundle.mjs did not produce build/server/server.mjs";
    }
  });

  // The bundle in a temp folder, outside the repo, with a temp HOME (tests only, H1), started the
  // way the desktop shell starts it: AGENT_OS_PORT=0 and no PORT (decision Q11a).
  // `inherited` is the environment the server would inherit from the developer's shell.
  async function startBundle(tmpServer, tmpHome, inherited = process.env) {
    // The six fake agents first on PATH, then the system folders only (decision Q1c): nothing the
    // server looks up can reach a real agent in /opt/homebrew/bin or /usr/local/bin. POSIX only.
    const fakeBin = path.join(tmpHome, "fake-bin");
    if (!isWindows) await makeFakeAgentBin(fakeBin);
    const env = {
      ...inherited,
      AGENT_OS_PORT: "0",
      AGENT_OS_STATIC_DIR: path.join(tmpServer, "web"),
      AGENT_OS_HOME: tmpHome,
      AGENT_OS_TOKEN: "t",
      AGENT_OS_PACKAGED: "1",
      HERMES_AGENT_OS_SCHEDULER: "0",
      // Keep agent detection away from the developer's real CLIs (~/.local/bin etc.).
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      // In local mode the server reads the login shell's environment right after READY (SP3):
      // W1's stand-in login shell, never the developer's own shell setup, never a real login sh.
      SHELL: FAKE_LOGIN_SHELL,
      PATH: [...(isWindows ? [] : [fakeBin]), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter)
    };
    delete env.PORT; // the desktop shell never passes PORT
    // The sessions routes exist in local mode only: variables that turn it off, set in the
    // developer's own shell, must not reach the server (the same four as test/sessions-routes.test.js).
    delete env.DEMO_PUBLIC;
    delete env.HERMES_AGENT_OS_DEMO_PUBLIC;
    delete env.HERMES_AGENT_OS_REQUIRE_AUTH;
    delete env.HERMES_AGENT_OS_PUBLIC_MODE;
    const child = spawn(process.execPath, [path.join(tmpServer, "server.mjs")], {
      cwd: tmpServer,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { child, logs: collectLogs(child) };
  }

  async function sessionsList(base) {
    const response = await fetch(`${base}/api/sessions`, { headers: { "x-agent-os-token": "t" } });
    assert.equal(response.status, 200, "GET /api/sessions answers in local mode");
    return response.json();
  }

  test("boots from a temp dir as the desktop app starts it, serves the UI, reports packaged mode, and finds node-pty next to itself", async (t) => {
    if (!bundleDir) {
      t.skip(skipReason);
      return;
    }
    // The bundle carries node-pty for this computer next to server.mjs, where Node looks for it.
    const ptyDir = path.join(bundleDir, "node_modules", "node-pty");
    assert.ok(existsSync(path.join(ptyDir, "package.json")), "node-pty's package.json is in the bundle");
    assert.ok(existsSync(path.join(ptyDir, "lib", "index.js")), "node-pty's lib/ is in the bundle");
    assert.deepEqual(await readdir(path.join(ptyDir, "prebuilds")), [hostPrebuild], "only this computer's prebuilt binary");
    const bundleInfo = JSON.parse(await readFile(path.join(bundleDir, "bundle.json"), "utf8"));
    assert.equal(bundleInfo.target, hostPrebuild);
    // node-pty stays outside server.mjs: esbuild cannot bundle a native module.
    const serverSource = await readFile(path.join(bundleDir, "server.mjs"), "utf8");
    assert.match(serverSource, /["']node-pty["']/, "server.mjs still imports node-pty by name");
    assert.doesNotMatch(serverSource, /loadNativeModule/, "node-pty's own code is not inside server.mjs");
    // ws's optional speed-ups are not looked up on disk at run time: a bare require would search every
    // folder above the installed app (scripts/build-server-bundle.mjs swaps in a module that throws).
    assert.doesNotMatch(serverSource, /require\(["'](bufferutil|utf-8-validate)["']\)/, "no bare require of bufferutil or utf-8-validate");

    let tmpServer = null;
    let tmpHome = null;
    let child = null;
    let logs = null;
    try {
      tmpServer = await makeTemp("agent-os-bundle-");
      tmpHome = await makeTemp("agent-os-bundle-home-");
      await cp(bundleDir, tmpServer, { recursive: true });
      ({ child, logs } = await startBundle(tmpServer, tmpHome));
      const port = await waitForReady(child, logs);
      // AGENT_OS_PORT=0 let the system pick a free port; without it the server would take 8090.
      assert.notEqual(port, 8090, "the bundle reads AGENT_OS_PORT, the desktop shell's name for its port");
      const base = `http://127.0.0.1:${port}`;

      const homepage = await fetch(`${base}/`);
      assert.equal(homepage.status, 200);
      assert.match(await homepage.text(), /<html/i);

      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
      const healthBody = await health.json();
      assert.equal(healthBody.packaged, true);

      const exportPrepare = await fetch(`${base}/api/admin/export/prepare`, {
        method: "POST",
        headers: { "x-agent-os-token": "t", "Content-Type": "application/json" },
        body: "{}"
      });
      assert.equal(exportPrepare.status, 409);

      // The packaged server, outside the repo, loads node-pty from its own folder and starts a
      // program in a terminal with it (pty-host.js's probe; on macOS that runs spawn-helper).
      const sessions = await sessionsList(base);
      assert.deepEqual(sessions.pty, { ok: true, reason: null }, `${logs.text.slice(-1500)}`);
    } finally {
      await killChild(child);
      if (tmpServer) await removeDir(tmpServer);
      if (tmpHome) await removeDir(tmpHome);
    }
  });

  test("without node-pty the bundled server still boots, and says sessions cannot start", async (t) => {
    if (!bundleDir) {
      t.skip(skipReason);
      return;
    }
    let tmpServer = null;
    let tmpHome = null;
    let child = null;
    let logs = null;
    try {
      tmpServer = await makeTemp("agent-os-bundle-nopty-");
      tmpHome = await makeTemp("agent-os-bundle-nopty-home-");
      await cp(bundleDir, tmpServer, { recursive: true });
      await removeDir(path.join(tmpServer, "node_modules"));
      ({ child, logs } = await startBundle(tmpServer, tmpHome));
      const port = await waitForReady(child, logs);
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${base}/api/health`)).status, 200, "it boots: node-pty is only loaded when a terminal is needed");
      const sessions = await sessionsList(base);
      // The plain reason from pty-host.js (PTY_UNAVAILABLE_REASON).
      assert.deepEqual(sessions.pty, { ok: false, reason: "Agent OS could not load its terminal module on this computer." });
    } finally {
      await killChild(child);
      if (tmpServer) await removeDir(tmpServer);
      if (tmpHome) await removeDir(tmpHome);
    }
  });

  test("a developer's own public-mode variables do not turn the bundled server's local mode off", async (t) => {
    if (!bundleDir) {
      t.skip(skipReason);
      return;
    }
    let tmpServer = null;
    let tmpHome = null;
    let child = null;
    let logs = null;
    try {
      tmpServer = await makeTemp("agent-os-bundle-env-");
      tmpHome = await makeTemp("agent-os-bundle-env-home-");
      await cp(bundleDir, tmpServer, { recursive: true });
      // As if the developer had these exported in their shell: each one turns local mode off.
      const inherited = {
        ...process.env,
        DEMO_PUBLIC: "1",
        HERMES_AGENT_OS_DEMO_PUBLIC: "1",
        HERMES_AGENT_OS_REQUIRE_AUTH: "1",
        HERMES_AGENT_OS_PUBLIC_MODE: "1"
      };
      ({ child, logs } = await startBundle(tmpServer, tmpHome, inherited));
      const port = await waitForReady(child, logs);
      const sessions = await sessionsList(`http://127.0.0.1:${port}`);
      assert.equal(sessions.maxLive, 8, `${logs.text.slice(-1500)}`);
    } finally {
      await killChild(child);
      if (tmpServer) await removeDir(tmpServer);
      if (tmpHome) await removeDir(tmpHome);
    }
  });

  test("the bundled server never loads bufferutil or utf-8-validate from a folder above it, and still answers on the sessions WebSocket path", async (t) => {
    if (!bundleDir) {
      t.skip(skipReason);
      return;
    }
    let tmpOuter = null;
    let tmpHome = null;
    let child = null;
    let logs = null;
    try {
      tmpOuter = await makeTemp("agent-os-bundle-above-");
      tmpHome = await makeTemp("agent-os-bundle-above-home-");
      // An installed app: <folder>/app/resources/server/server.mjs, with a node_modules in a folder above it,
      // where Node's lookup from server.mjs would find these two. Each leaves a marker file if it is loaded.
      const tmpServer = path.join(tmpOuter, "app", "resources", "server");
      await mkdir(tmpServer, { recursive: true });
      await cp(bundleDir, tmpServer, { recursive: true });
      const planted = ["bufferutil", "utf-8-validate"];
      for (const name of planted) {
        const dir = path.join(tmpOuter, "node_modules", name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
        const marker = JSON.stringify(path.join(tmpHome, `${name}.loaded`));
        await writeFile(path.join(dir, "index.js"), `require("node:fs").writeFileSync(${marker}, "loaded");\nmodule.exports = { mask() {}, unmask() {} };\n`);
      }
      ({ child, logs } = await startBundle(tmpServer, tmpHome));
      const port = await waitForReady(child, logs);
      await sessionsList(`http://127.0.0.1:${port}`);
      for (const name of planted) {
        assert.ok(!existsSync(path.join(tmpHome, `${name}.loaded`)), `${name} from a folder above the app was not loaded`);
      }
      // The sessions WebSocket path is still served by the bundled ws: an upgrade without an Origin is
      // refused with 403 by the sessions upgrade check (server/runtime/sessions/ws.js).
      const status = await new Promise((resolve, reject) => {
        const request = http.request({
          host: "127.0.0.1",
          port,
          path: "/api/sessions/3f2c9a7e-1b4d-4c8e-9f00-0123456789ab/attach",
          headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" }
        });
        request.once("response", (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        request.once("upgrade", () => reject(new Error("the upgrade was accepted without an Origin")));
        request.once("error", reject);
        request.end();
      });
      assert.equal(status, 403);
    } finally {
      await killChild(child);
      if (tmpOuter) await removeDir(tmpOuter);
      if (tmpHome) await removeDir(tmpHome);
    }
  });

  test(
    "the node-pty copied with the bundle opens a real terminal (spawn-helper is still runnable after the copy)",
    { skip: isWindows ? "uses /bin/sh as the terminal program" : false },
    async (t) => {
      if (!bundleDir) {
        t.skip(skipReason);
        return;
      }
      let tmpServer = null;
      let term = null;
      let exited = false;
      try {
        tmpServer = await makeTemp("agent-os-bundle-pty-");
        await cp(bundleDir, tmpServer, { recursive: true });
        // Resolved the way server.mjs resolves it: from the bundle's own folder.
        const nodePty = createRequire(path.join(tmpServer, "server.mjs"))("node-pty");
        // spawn(file, args, options) → IPty with onData and onExit (node-pty 1.2, typings/node-pty.d.ts).
        term = nodePty.spawn("/bin/sh", ["-c", "printf pty-ok"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: tmpServer,
          env: { PATH: "/usr/bin:/bin" }
        });
        term.onExit(() => {
          exited = true;
        });
        let output = "";
        term.onData((data) => {
          output += data;
        });
        const exitCode = await exitCodeWithin(term);
        const deadline = Date.now() + 2000;
        while (!output.includes("pty-ok") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(exitCode, 0);
        assert.match(output, /pty-ok/);
      } finally {
        // Only the terminal this test started, and only while it still runs (a finished one's pid could be reused).
        if (term && !exited) {
          try {
            term.kill();
          } catch {
            // already gone
          }
        }
        if (tmpServer) await removeDir(tmpServer);
      }
    }
  );
});

test("exitCodeWithin: a terminal that never exits fails with a plain sentence, one that exits gives its code", async () => {
  const hung = { onExit() {} };
  await assert.rejects(exitCodeWithin(hung, 0.05), /^Error: the bundled terminal did not exit within 0\.05 s$/);
  const quick = { onExit: (listener) => setTimeout(() => listener({ exitCode: 7 }), 10) };
  assert.equal(await exitCodeWithin(quick, 5), 7);
});

test("which(\"node\") returns an absolute path", async () => {
  const located = await which("node");
  assert.ok(located, "expected which(\"node\") to find the running interpreter");
  assert.ok(path.isAbsolute(located));
});

test(
  "which() finds an executable via HERMES_AGENT_OS_EXECUTABLE_PATHS",
  { skip: isWindows ? "chmod-based fake executable is POSIX-only" : false },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-which-"));
    const fake = path.join(dir, "fakeagent");
    const previousExtra = process.env.HERMES_AGENT_OS_EXECUTABLE_PATHS;
    const previousPath = process.env.PATH;
    try {
      await writeFile(fake, "#!/bin/sh\necho fake\n");
      await chmod(fake, 0o755);
      process.env.HERMES_AGENT_OS_EXECUTABLE_PATHS = dir;
      process.env.PATH = "/usr/bin:/bin";
      const found = await which("fakeagent");
      assert.equal(found, fake);
    } finally {
      if (previousExtra === undefined) delete process.env.HERMES_AGENT_OS_EXECUTABLE_PATHS;
      else process.env.HERMES_AGENT_OS_EXECUTABLE_PATHS = previousExtra;
      process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "killProcessTree kills a spawned child and its grandchild",
  { skip: isWindows ? "process groups are POSIX-only" : false },
  async () => {
    const child = spawnTracked(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process');" +
          "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);" +
          "console.log('GRANDCHILD:' + g.pid);"
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    let grandchildPid = null;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && grandchildPid == null) {
      const match = buffer.match(/GRANDCHILD:(\d+)/);
      if (match) {
        grandchildPid = Number(match[1]);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(grandchildPid, "expected the tracked child to report its grandchild pid");

    const childPid = child.pid;
    await killProcessTree(childPid);

    assert.equal(isAlive(childPid), false);
    assert.equal(isAlive(grandchildPid), false);
  }
);

test(
  "killProcessTree waits for a grandchild that ignores SIGTERM after the leader exits",
  { skip: isWindows ? "process groups are POSIX-only" : false },
  async () => {
    const child = spawnTracked(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process');" +
          "const g = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"]);" +
          "console.log('GRANDCHILD:' + g.pid);" +
          "setInterval(()=>{},1000);"
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    let grandchildPid = null;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && grandchildPid == null) {
      const match = buffer.match(/GRANDCHILD:(\d+)/);
      if (match) grandchildPid = Number(match[1]);
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(grandchildPid, "expected the tracked child to report its grandchild pid");
    // Give the grandchild time to install its SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await killProcessTree(child.pid, { graceMs: 500 });

    assert.equal(isAlive(child.pid), false);
    assert.equal(isAlive(grandchildPid), false);
  }
);

describe("graceful shutdown", () => {
  test("SIGTERM to the real server exits well inside the 8 second hard exit", async () => {
    // Real path: on macOS os.tmpdir() sits behind a symlink (Global Constraints).
    const homeDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-shutdown-")));
    // The six fake agents, first on PATH (R16); the shims are POSIX only.
    const fakeBin = path.join(homeDir, "fake-bin");
    if (!isWindows) await makeFakeAgentBin(fakeBin);
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: "0",
        AGENT_OS_HOME: homeDir,
        AGENT_OS_TOKEN: "t",
        HERMES_AGENT_OS_SCHEDULER: "0",
        // Keep agent detection away from the developer's real CLIs (~/.local/bin etc.).
        HOME: homeDir,
        USERPROFILE: homeDir,
        // The sessions' login-shell lookup (SP3) runs W1's stand-in login shell (R15):
        // never the developer's own shell setup, never a real login sh.
        SHELL: FAKE_LOGIN_SHELL,
        // The fakes first, then the system folders only: detection finds a fake
        // before it searches /opt/homebrew/bin and /usr/local/bin.
        PATH: [...(isWindows ? [] : [fakeBin]), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
        // stdin is "ignore" here: a developer's AGENT_OS_STDIN_SHUTDOWN=1 would
        // read end-of-input at once and quit the server before SIGTERM is sent.
        AGENT_OS_STDIN_SHUTDOWN: undefined
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const logs = collectLogs(child);
    try {
      await waitForReady(child, logs);
      const start = Date.now();
      child.kill("SIGTERM");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server did not exit within 8s of SIGTERM (the hard exit)")), 8000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      // An idle server has nothing to stop, so it never needs the hard exit.
      const elapsed = Date.now() - start;
      assert.ok(elapsed <= 3500, `an idle server took ${elapsed} ms to exit after SIGTERM`);
    } finally {
      await killChild(child);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test(
    "shutdown() kills a fake tracked child",
    { skip: isWindows ? "process groups are POSIX-only" : false },
    async () => {
      const fakeChild = spawnTracked(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
      const pid = fakeChild.pid;
      await shutdown({});
      assert.equal(isAlive(pid), false);
    }
  );
});

test(
  "a node-shebang tool runs on the node beside it, not an older one earlier on PATH",
  { skip: isWindows ? "shebang scripts are POSIX-only; npm .cmd shims pick node.exe themselves" : false },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-sibling-node-"));
    try {
      // A stand-in "node" that proves which interpreter ran the tool.
      await writeFile(path.join(dir, "node"), "#!/bin/sh\necho SIBLING-NODE-RAN\n");
      await chmod(path.join(dir, "node"), 0o755);
      const tool = path.join(dir, "fake-tool");
      await writeFile(tool, "#!/usr/bin/env node\nconsole.log('system node ran');\n");
      await chmod(tool, 0o755);

      const env = withSiblingNodePath(tool, { PATH: "/usr/bin:/bin" });
      assert.equal(env.PATH.split(path.delimiter)[0], dir);

      // Generous timeout: the full suite runs files in parallel and a busy
      // machine can take seconds to start even this tiny script.
      const result = await runCommand(tool, [], 20000, { env: { PATH: "/usr/bin:/bin" } });
      assert.match(result.stdout, /SIBLING-NODE-RAN/);

      // Non-node tools (e.g. a Python CLI) are left alone.
      const pyTool = path.join(dir, "py-tool");
      await writeFile(pyTool, "#!/usr/bin/env python3\nprint('hi')\n");
      assert.equal(withSiblingNodePath(pyTool, { PATH: "/usr/bin" }).PATH, "/usr/bin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);
