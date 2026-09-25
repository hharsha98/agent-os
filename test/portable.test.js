// Portability: the bundled server running outside a repo checkout, the
// cross-platform executable lookup, process-tree kill, and graceful shutdown.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { killProcessTree, spawnTracked } from "../server/runtime/process-tree.js";
import { which } from "../server/runtime/safety.js";
import { shutdown } from "../server/runtime/shutdown.js";

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

  test("boots from a temp dir, serves the UI, and reports packaged mode", async (t) => {
    if (!bundleDir) {
      t.skip(skipReason);
      return;
    }
    const tmpServer = await mkdtemp(path.join(os.tmpdir(), "agent-os-bundle-"));
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-bundle-home-"));
    await cp(bundleDir, tmpServer, { recursive: true });
    const child = spawn(process.execPath, [path.join(tmpServer, "server.mjs")], {
      cwd: tmpServer,
      env: {
        ...process.env,
        PORT: "0",
        AGENT_OS_STATIC_DIR: path.join(tmpServer, "web"),
        AGENT_OS_HOME: tmpHome,
        AGENT_OS_TOKEN: "t",
        AGENT_OS_PACKAGED: "1",
        HERMES_AGENT_OS_SCHEDULER: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const logs = collectLogs(child);
    try {
      const port = await waitForReady(child, logs);
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
    } finally {
      await killChild(child);
      await rm(tmpServer, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
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
  test("SIGTERM to the real server exits within 3 seconds", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-shutdown-"));
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: "0",
        AGENT_OS_HOME: homeDir,
        AGENT_OS_TOKEN: "t",
        HERMES_AGENT_OS_SCHEDULER: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const logs = collectLogs(child);
    try {
      await waitForReady(child, logs);
      const start = Date.now();
      child.kill("SIGTERM");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server did not exit within 3s of SIGTERM")), 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      assert.ok(Date.now() - start <= 3500);
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
