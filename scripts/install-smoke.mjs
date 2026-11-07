#!/usr/bin/env node
// Install smoke: proves that an INSTALLED Agent OS (not the source tree) works. Plain Node, no
// dependencies, no real agents. The package-check workflow runs it on all four systems after it
// installs the installer it just built (.github/workflows/package-check.yml).
//
//   node scripts/install-smoke.mjs --resources <dir> [--app <binary>]
//
//   --resources  the app's "resources" folder, the one that holds node/ and server/. Where it is:
//                  macOS    Agent OS.app/Contents/Resources/resources
//                  Windows  <install folder>\resources
//                  Linux    /usr/lib/Agent OS/resources (the .deb), or the unpacked AppImage's
//                  desktop/src-tauri/resources when run on a prepared checkout
//   --app        the app's own program (Contents/MacOS/agent-os-desktop, agent-os-desktop.exe, ...).
//                Without it, check 4 is skipped (that is how it runs on a development computer).
//
// The checks:
//   1  the licence files, the server bundle, the bundled node and node-pty's LICENSE are there
//   2  the bundled node starts the bundled server the way the app does, /api/health answers, the
//      page answers 200 with the login token, and the quit line on stdin stops the server
//   3  the bundled node loads the bundled node-pty and runs a command through a real terminal
//   4  the real app starts a server from the bundled path; a second launch exits by itself and
//      leaves exactly one server (the single-instance plugin); killing the app makes the server
//      exit by itself (it watches its stdin pipe)
//
// Prints PASS or FAIL for each check and exits 1 if any failed. Login tokens are random, kept in
// memory only, and removed from anything printed.
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const SHUTDOWN_LINE = "AGENT_OS_SHUTDOWN\n"; // desktop/src-tauri/src/main.rs, SHUTDOWN_LINE
const READY_PREFIX = "AGENT_OS_READY:"; // main.rs, READY_LINE_PREFIX

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(test, timeoutMs, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() >= end) return null;
    await sleep(everyMs);
  }
}

function parseArgs(argv) {
  const args = { resources: null, app: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--resources") args.resources = argv[++i];
    else if (argv[i] === "--app") args.app = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}. Use --resources <dir> [--app <binary>].`);
  }
  if (!args.resources) throw new Error("--resources <dir> is required.");
  return { resources: path.resolve(args.resources), app: args.app ? path.resolve(args.app) : null };
}

// Linux has no display or session bus on a CI machine, and the app needs both (a window, and the
// single-instance plugin talks over the session bus). So on Linux, with --app, run this same script
// again inside `dbus-run-session -- xvfb-run -a`, once: both launches then share one bus.
function rerunInsideLinuxDisplay(argv) {
  if (process.platform !== "linux" || !argv.includes("--app") || process.env.AGENT_OS_SMOKE_WRAPPED === "1") return;
  const result = spawnSync("dbus-run-session", ["--", "xvfb-run", "-a", process.execPath, fileURLToPath(import.meta.url), ...argv], {
    stdio: "inherit",
    env: { ...process.env, AGENT_OS_SMOKE_WRAPPED: "1" },
  });
  if (result.error) {
    console.error(`FAIL  could not start dbus-run-session and xvfb-run (${result.error.message}). Install the dbus-daemon and xvfb packages.`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// ---- results ---------------------------------------------------------------

const results = [];
const hiddenWords = [];

function scrub(text) {
  let out = String(text);
  for (const word of hiddenWords) if (word) out = out.split(word).join("[hidden]");
  return out;
}

async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? ` (${scrub(detail)})` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}: ${scrub(error?.message || error)}`);
  }
}

// ---- where things are ------------------------------------------------------

function locations(resources) {
  const server = path.join(resources, "server");
  return {
    server,
    entry: path.join(server, "server.mjs"),
    web: path.join(server, "web"),
    node: path.join(resources, "node", isWindows ? "node.exe" : path.join("bin", "node")),
    ptyLicense: path.join(server, "node_modules", "node-pty", "LICENSE"),
  };
}

// The environment main.rs's spawn_server gives the server (names and values), plus a temporary data
// folder. Everything else is the caller's environment, as it is for the real app.
function serverEnv(where, token, home) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("AGENT_OS_") || name === "HERMES_AGENT_OS_HOME") delete env[name];
  return {
    ...env,
    AGENT_OS_PORT: "0",
    AGENT_OS_TOKEN: token,
    AGENT_OS_STATIC_DIR: where.web,
    AGENT_OS_PACKAGED: "1",
    AGENT_OS_STDIN_SHUTDOWN: "1",
    AGENT_OS_LAUNCH_PATH: process.env.PATH || "",
    HOST: "127.0.0.1",
    AGENT_OS_HOME: home,
  };
}

// ---- check 1 ---------------------------------------------------------------

function checkFiles(where, resources) {
  const wanted = [
    ["LICENSE", path.join(where.server, "LICENSE")],
    ["THIRD_PARTY_NOTICES.md", path.join(where.server, "THIRD_PARTY_NOTICES.md")],
    ["server bundle (server.mjs)", where.entry],
    ["bundled node", where.node],
    ["node-pty LICENSE", where.ptyLicense],
  ];
  const missing = wanted.filter(([, file]) => !existsSync(file)).map(([label]) => label);
  if (missing.length) throw new Error(`missing under ${resources}: ${missing.join(", ")}`);
  return `${wanted.length} files`;
}

// ---- check 2 ---------------------------------------------------------------

async function checkServer(where) {
  const token = randomBytes(32).toString("hex");
  hiddenWords.push(token);
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-os-smoke-home-"));
  const child = spawn(where.node, [where.entry], { env: serverEnv(where, token, home), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-20000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-20000);
  });
  try {
    const port = await waitFor(() => {
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(READY_PREFIX));
      return line ? Number(line.slice(READY_PREFIX.length).trim()) : exited ? -1 : 0;
    }, 30000);
    if (!port || port < 0) throw new Error(`the server did not print ${READY_PREFIX}<port>. It said: ${stderr.trim().split("\n").slice(-5).join(" | ") || "nothing"}`);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await health.json().catch(() => ({}));
    if (!health.ok || body.ok !== true) throw new Error(`/api/health answered ${health.status} ${JSON.stringify(body)}`);

    const page = await fetch(`http://127.0.0.1:${port}/?launch=${token}&desktop=1`, { redirect: "manual" });
    if (page.status !== 200) throw new Error(`/ with the login token answered ${page.status}, not 200`);

    child.stdin.write(SHUTDOWN_LINE);
    const stopped = await waitFor(() => exited, 15000);
    if (!stopped) throw new Error("the server did not exit within 15 s of the quit line");
    return `port ${port}, health ok, page 200, quit line stops it`;
  } finally {
    if (!exited) child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- check 3 ---------------------------------------------------------------

function checkPty(where) {
  const marker = isWindows ? "agentos-pty-ok" : "agentos-pty-42"; // on unix 42 comes from arithmetic, never from the echoed command
  const command = isWindows ? ["cmd.exe", ["/c", "echo agentos-pty-ok"]] : ["/bin/sh", ["-c", "echo agentos-pty-$((6*7))"]];
  // Runs inside the bundled node, which must find node-pty beside server.mjs (the same way the server does).
  const script = `
    const { createRequire } = require("node:module");
    const require2 = createRequire(process.env.SMOKE_ENTRY);
    const pty = require2("node-pty");
    const [file, args] = JSON.parse(process.env.SMOKE_COMMAND);
    let out = "";
    const term = pty.spawn(file, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.env.SMOKE_CWD, env: process.env });
    term.onData((data) => { out += data; });
    const timer = setTimeout(() => { console.log("TIMEOUT " + JSON.stringify(out.slice(-200))); process.exit(2); }, 15000);
    term.onExit(() => { clearTimeout(timer); console.log(out.includes(process.env.SMOKE_MARKER) ? "PTY_OK" : "PTY_MISSING " + JSON.stringify(out.slice(-200))); process.exit(0); });
  `;
  const result = spawnSync(where.node, ["-e", script], {
    env: { ...process.env, SMOKE_ENTRY: where.entry, SMOKE_COMMAND: JSON.stringify(command), SMOKE_MARKER: marker, SMOKE_CWD: os.tmpdir() },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  const said = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.error) throw new Error(`could not run the bundled node: ${result.error.message}`);
  if (!said.includes("PTY_OK")) throw new Error(`node-pty did not give the text back: ${said.slice(-300) || "no output"}`);
  return `${command[0]} ran in a real terminal and its text came back`;
}

// ---- check 4 ---------------------------------------------------------------

// The processes that are the bundled node running server.mjs. A path can be spelt two ways (a
// symbolic link such as macOS's /var), so both spellings count.
async function listBundledServers(where) {
  const spellings = new Set([where.node, safeRealpath(where.node)].map((entry) => (isWindows ? entry.toLowerCase() : entry)));
  const lines = await new Promise((resolve) => {
    if (isWindows) {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }";
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { maxBuffer: 1 << 24, windowsHide: true }, (error, out) => resolve(error ? [] : out.split(/\r?\n/)));
    } else {
      execFile("ps", ["-axww", "-o", "pid=,args="], { maxBuffer: 1 << 24 }, (error, out) => resolve(error ? [] : out.split("\n")));
    }
  });
  const found = [];
  for (const line of lines) {
    if (isWindows) {
      const [pid, exe = "", command = ""] = line.split("\t");
      if (pid && spellings.has(exe.toLowerCase()) && command.includes("server.mjs")) found.push(Number(pid));
    } else {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match && [...spellings].some((spelling) => match[2].startsWith(`${spelling} `)) && match[2].includes("server.mjs")) found.push(Number(match[1]));
    }
  }
  return found;
}

function safeRealpath(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function launchApp(app, home) {
  const env = { ...process.env, AGENT_OS_HOME: home };
  for (const name of Object.keys(env)) if (name !== "AGENT_OS_HOME" && name.startsWith("AGENT_OS_")) delete env[name];
  const child = spawn(app, [], { env, stdio: "ignore", windowsHide: false });
  const state = { child, exited: false, code: null };
  child.on("exit", (code) => {
    state.exited = true;
    state.code = code;
  });
  child.on("error", () => {
    state.exited = true;
  });
  return state;
}

async function checkApp(where, app) {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-os-smoke-app-"));
  const started = [];
  try {
    const before = await listBundledServers(where);
    if (before.length) throw new Error(`a server from the bundled path is already running (pids ${before.join(", ")}); close it and run the check again`);

    const first = launchApp(app, home);
    started.push(first);
    const servers = await waitFor(async () => {
      if (first.exited) return null;
      const list = await listBundledServers(where);
      return list.length ? list : null;
    }, 60000, 500);
    if (!servers) throw new Error(first.exited ? `the app exited by itself (code ${first.code}) before it started a server` : "no server from the bundled path was running 60 s after the app started");
    console.log(`PASS  the app started the bundled server (pid ${servers[0]})`);

    // Second launch: it must end by itself and not start a second server.
    const second = launchApp(app, home);
    started.push(second);
    const secondEnded = await waitFor(() => second.exited, 15000, 250);
    if (!secondEnded) throw new Error("a second launch was still running after 15 s (the single-instance plugin did not stop it)");
    await sleep(1500);
    const afterSecond = await listBundledServers(where);
    if (afterSecond.length !== 1) throw new Error(`after the second launch there are ${afterSecond.length} servers, not exactly 1`);
    if (first.exited) throw new Error("the first copy of the app ended when the second one was started");
    console.log(`PASS  a second launch exited by itself (code ${second.code}) and left exactly one server`);

    // Kill only the app (not its children): the server must notice its stdin pipe closing and stop.
    first.child.kill("SIGKILL");
    const gone = await waitFor(async () => (await listBundledServers(where)).length === 0, 20000, 500);
    if (!gone) throw new Error("the server was still running 20 s after the app was killed (it should stop when its stdin pipe closes)");
    return "one server per app, and it stops by itself when the app dies";
  } finally {
    for (const entry of started) if (!entry.exited) entry.child.kill("SIGKILL");
    for (const pid of await listBundledServers(where)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await sleep(500);
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  rerunInsideLinuxDisplay(argv);

  const where = locations(args.resources);
  console.log(`Install smoke on ${process.platform}/${process.arch}, resources ${args.resources}`);

  await check("1 the licence files, server bundle, bundled node and node-pty licence are installed", () => checkFiles(where, args.resources));
  await check("2 the bundled node runs the bundled server, and it answers and quits", () => checkServer(where));
  await check("3 the bundled node runs a command through node-pty", () => checkPty(where));
  if (args.app) {
    if (!existsSync(args.app)) {
      results.push({ name: "4 the app", ok: false });
      console.log(`FAIL  4 the real app: ${args.app} does not exist`);
    } else {
      await check("4 the real app: one server, a second launch exits, killing the app stops the server", () => checkApp(where, args.app));
    }
  } else {
    console.log("SKIP  4 the real app (no --app given)");
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(failed.length ? `\n${failed.length} of ${results.length} checks FAILED.` : `\nAll ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(scrub(error?.stack || error));
  process.exit(1);
});
