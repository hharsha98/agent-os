// SP4 Task X2b: the statusLine wrapper (H6, rulings R10 and K18), finding the person's own status
// line and the settings that keep Agent OS's hooks or the Live meter out (R9, K10), the Live meter
// feed (R11) and its place in the Claude limit rule (R4, K2), and the re-link from the statusLine
// JSON (R1).
//   1. The wrapper as Claude runs it: <node> statusline.mjs, Claude's JSON on stdin.
//   2. Reading Claude's settings files: four files, five keys, never ~/.claude.json.
//   3. parseStatusLine: the statusLine JSON as the Live meter.
//   4. The launch profile: the per-session settings file's statusLine and the helper files.
//   5. The manager and the hooks router in process (a terminal that runs nothing): the meter,
//      trustNeeded, hooksOff, the re-link and the limit's second signal; then one real-PTY run of
//      W1's fake Claude Code.
// Temp HOME, AGENT_OS_HOME and managed-settings path only: never the person's ~/.claude and never
// the system's managed settings. W1's stand-in login shell; fake agents only. Never a real agent.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import * as alertsUi from "../src/ui/alertsShared.ts";
import * as ss from "../src/ui/sessionsShared.ts";
import { helperCommandLine } from "../server/runtime/secrets/keystore.js";
import {
  MANAGED_SETTINGS_PATHS,
  SETTINGS_READ_KEYS,
  STATUSLINE_WRAPPER_SOURCE,
  detectHooksOff,
  encodeClaudeProjectPath,
  findUserStatusLine,
  parseStatusLine,
  readClaudeSettingsLayers,
  statusLineCommand,
  writeStatusLineHelper
} from "../server/runtime/sessions/claude-session.js";
import { createClaudeAgentsPoller } from "../server/runtime/sessions/claude-agents-poll.js";
import { createHooksRouter } from "../server/runtime/sessions/hooks.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { buildSessionProfile } from "../server/runtime/sessions/profiles.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { postHook } from "./helpers/hook-client.js";
import { NO_GIT_OPTIONS } from "./helpers/no-git.js";
import { spyOnFileAccess } from "./helpers/plan-brains-safety.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const POSIX = { skip: isWindows ? "the wrapper runs the person's command with /bin/sh; the fakes are POSIX shims" : false };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SYSTEM_PATH = SYSTEM_PATH_DIRS.join(path.delimiter);
// Made-up values: a hook token, Agent OS session ids and a Claude conversation id.
const TOKEN = "statusline-test-token-not-real-0123456789A";
const SESSION_ID = crypto.randomUUID();
const CLAUDE_UUID = "5d1f3b2a-7c4e-4f60-9a8b-1c2d3e4f5a6b";
const VERSION = "9.9.9-test";
const HOUR_S = 3600;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const modeOf = async (file) => (await stat(file)).mode & 0o777;

// Every limit here only bounds how long a healthy run may take; the condition is what the test waits for. A
// machine under heavy load (load averages of 10 to 250 were seen) needs many times the seconds a quiet one
// does, so a call site's figure is what a quiet machine needs and the wait runs for at least LOADED_WAIT_MS.
const LOADED_WAIT_MS = 60000;

async function waitFor(check, timeoutMs = 10000, what = "a condition") {
  const limitMs = Math.max(timeoutMs, LOADED_WAIT_MS);
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${limitMs} ms waiting for ${what}`);
    await delay(25);
  }
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeSettings(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

// Claude Code's statusLine JSON (statusline docs, "Available data"; made-up values), with the
// rate-limit resets relative to `nowMs`.
function statusJson({ nowMs = Date.now(), fiveHour = 23.5, sevenDay = 41.2, sessionId = CLAUDE_UUID, extra = {} } = {}) {
  const inSeconds = (seconds) => Math.floor(nowMs / 1000) + seconds;
  return {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: "/tmp/not-read.jsonl",
    cwd: "/tmp/project",
    model: { id: "claude-opus-5-5", display_name: "Opus 5.5 · 1M" },
    workspace: { current_dir: "/tmp/project", project_dir: "/tmp/project" },
    version: "2.1.292",
    output_style: { name: "default" },
    cost: { total_cost_usd: 0.4213, total_duration_ms: 45000, total_api_duration_ms: 2300, total_lines_added: 156, total_lines_removed: 23 },
    context_window: {
      total_input_tokens: 15234,
      total_output_tokens: 4521,
      context_window_size: 200000,
      used_percentage: 41.5,
      remaining_percentage: 58.5,
      current_usage: { input_tokens: 8500, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 2000 }
    },
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: inSeconds(2 * HOUR_S) },
      seven_day: { used_percentage: sevenDay, resets_at: inSeconds(72 * HOUR_S) }
    },
    ...extra
  };
}
const isoIn = (nowMs, seconds) => new Date((Math.floor(nowMs / 1000) + seconds) * 1000).toISOString();
const STATUS_BYTES = Buffer.from(JSON.stringify(statusJson()));

// Runs a program the way Claude runs a status line command: stdin written and closed at once,
// stdout and stderr kept as bytes. onStdout(child, soFar) sees the output as it arrives.
function run(file, args, { env = { PATH: SYSTEM_PATH, HOME: os.tmpdir() }, cwd, stdin = Buffer.alloc(0), onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => {
      out.push(chunk);
      onStdout?.(child, Buffer.concat(out).toString("latin1"));
    });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
        ms: Number(process.hrtime.bigint() - started) / 1e6
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
const runWrapper = (script, options = {}) => run(process.execPath, [script], { stdin: STATUS_BYTES, ...options });
const runShell = (command, options = {}) => run("/bin/sh", ["-c", command], options);
const nodeStartMs = async () => (await run(process.execPath, ["-e", ""])).ms;

// A session folder holding the wrapper and the person's command (null: none), as a start writes them.
async function makeHelper(command, { folderName = "sessions" } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-statusline-")));
  const dir = path.join(base, folderName, crypto.randomUUID());
  const { script, config } = await writeStatusLineHelper({ dir, userStatusLine: command === null ? null : { command, from: "user" } });
  return { base, dir, script, config, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const hookEnv = (port) => ({
  PATH: SYSTEM_PATH,
  HOME: os.tmpdir(),
  AGENT_OS_HOOK_URL: `http://127.0.0.1:${port}/hooks/sessions/${SESSION_ID}`,
  AGENT_OS_HOOK_TOKEN: TOKEN
});

// A stand-in for Agent OS's hooks endpoint that records every request; with answer: false it
// never replies (a stalled Agent OS).
async function withStatusServer({ answer = true } = {}, fn) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (answer) res.writeHead(204).end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn({ port: server.address().port, requests });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

// A port nothing listens on (Agent OS is down).
async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// =====================================================================
// 1. The wrapper
// =====================================================================

test("statusLine wrapper: the person's command output comes back byte for byte (colours, a non-UTF-8 byte, CR LF, no newline at the end) and nothing is added", POSIX, async () => {
  const helper = await makeHelper("printf '\\033[1;32mOpus\\033[0m \\377 | 41%%\\r\\nsecond line'");
  try {
    const result = await runWrapper(helper.script);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout, Buffer.concat([Buffer.from("\x1b[1;32mOpus\x1b[0m "), Buffer.from([0xff]), Buffer.from(" | 41%\r\nsecond line")]));
    assert.equal(result.stderr, "", "the wrapper prints nothing of its own");
  } finally {
    await helper.cleanup();
  }
});

test("statusLine wrapper: the command gets the same stdin bytes, the unchanged environment and the current folder", POSIX, async () => {
  const helper = await makeHelper("cat; printf '|%s|%s|%s' \"$COLUMNS\" \"$CUSTOM_STATUS_VAR\" \"$PWD\"");
  try {
    const result = await runWrapper(helper.script, {
      cwd: helper.base,
      env: { PATH: SYSTEM_PATH, HOME: os.tmpdir(), COLUMNS: "101", CUSTOM_STATUS_VAR: "from the person" }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout, Buffer.concat([STATUS_BYTES, Buffer.from(`|101|from the person|${helper.base}`)]));
  } finally {
    await helper.cleanup();
  }
});

test("statusLine wrapper: the command's exit code is the wrapper's, with the same bytes", POSIX, async () => {
  const failing = await makeHelper("printf 'half a line'; exit 1");
  const three = await makeHelper("exit 3");
  try {
    const one = await runWrapper(failing.script);
    assert.equal(one.code, 1);
    assert.equal(one.stdout.toString(), "half a line");
    const other = await runWrapper(three.script);
    assert.equal(other.code, 3);
    assert.equal(other.stdout.length, 0);
  } finally {
    await failing.cleanup();
    await three.cleanup();
  }
});

test("statusLine wrapper: with no command of the person's own (or no statusline.json) it prints nothing and exits 0, and the copy still goes to the Live meter", POSIX, async () => {
  const none = await makeHelper(null);
  try {
    assert.deepEqual(JSON.parse(await readFile(none.config, "utf8")), { version: 1, command: null });
    await withStatusServer({}, async ({ port, requests }) => {
      const result = await runWrapper(none.script, { env: hookEnv(port) });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.length, 0, "H6: nothing printed when the person has no status line");
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].body, STATUS_BYTES);
    });
    await rm(none.config);
    const missing = await runWrapper(none.script);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(missing.stdout.length, 0);
  } finally {
    await none.cleanup();
  }
});

test("statusLine wrapper: a copy of the JSON is posted to <AGENT_OS_HOOK_URL>/status with the session's token, exactly as Claude wrote it", POSIX, async () => {
  const helper = await makeHelper("printf line");
  try {
    await withStatusServer({}, async ({ port, requests }) => {
      const result = await runWrapper(helper.script, { env: hookEnv(port) });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.toString(), "line", "the person's output, and nothing else");
      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request.method, "POST");
      assert.equal(request.url, `/hooks/sessions/${SESSION_ID}/status`);
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.headers["content-type"], "application/json");
      assert.deepEqual(request.body, STATUS_BYTES, "the same bytes Claude wrote");
    });
  } finally {
    await helper.cleanup();
  }
});

test("statusLine wrapper: no copy is posted without a token or to any address but 127.0.0.1", POSIX, async () => {
  const helper = await makeHelper("printf line");
  try {
    await withStatusServer({}, async ({ port, requests }) => {
      const base = hookEnv(port);
      const cases = [
        ["no token", { ...base, AGENT_OS_HOOK_TOKEN: "" }],
        ["localhost is not 127.0.0.1", { ...base, AGENT_OS_HOOK_URL: `http://localhost:${port}/hooks/sessions/${SESSION_ID}` }],
        ["127.0.0.1 only as a user name", { ...base, AGENT_OS_HOOK_URL: `http://127.0.0.1:${port}@example.invalid/hooks/sessions/${SESSION_ID}` }],
        ["https", { ...base, AGENT_OS_HOOK_URL: `https://127.0.0.1:${port}/hooks/sessions/${SESSION_ID}` }]
      ];
      for (const [what, env] of cases) {
        const result = await runWrapper(helper.script, { env });
        assert.equal(result.code, 0, `${what}: ${result.stderr}`);
        assert.equal(result.stdout.toString(), "line", what);
      }
      await delay(100);
      assert.equal(requests.length, 0);
    });
  } finally {
    await helper.cleanup();
  }
});

test("Review Focus 5: with Agent OS down (a closed port) the wrapper finishes within 600 ms and reproduces the output byte for byte; exit 1 stays exit 1; nothing stays nothing", POSIX, async () => {
  const port = await closedPort();
  const printing = await makeHelper("printf '\\033[2mhud\\033[0m ok'");
  const failing = await makeHelper("printf 'half'; exit 1");
  const silent = await makeHelper("true");
  try {
    const baseline = await nodeStartMs();
    const ok = await runWrapper(printing.script, { env: hookEnv(port) });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(ok.stdout, Buffer.from("\x1b[2mhud\x1b[0m ok"));
    assert.ok(ok.ms < baseline + 600, `the wrapper took ${ok.ms} ms; Node itself starts in ${baseline} ms`);
    const failed = await runWrapper(failing.script, { env: hookEnv(port) });
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout.toString(), "half");
    const quiet = await runWrapper(silent.script, { env: hookEnv(port) });
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stdout.length, 0);
  } finally {
    await printing.cleanup();
    await failing.cleanup();
    await silent.cleanup();
  }
});

test("statusLine wrapper: an Agent OS that never answers holds it at most 500 ms from its start (K18)", POSIX, async () => {
  const helper = await makeHelper("printf line");
  try {
    await withStatusServer({ answer: false }, async ({ port, requests }) => {
      const baseline = await nodeStartMs();
      const result = await runWrapper(helper.script, { env: hookEnv(port) });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.toString(), "line");
      assert.ok(result.ms >= 500, `it gave the copy its 500 ms (took ${result.ms} ms)`);
      assert.ok(result.ms < baseline + 900, `the wrapper took ${result.ms} ms; Node itself starts in ${baseline} ms`);
      assert.equal(requests.length, 1, "the copy was sent; only the answer never came");
    });
  } finally {
    await helper.cleanup();
  }
});

test("statusLine wrapper: SIGTERM is passed on to the person's command, and its exit code comes back", POSIX, async () => {
  const helper = await makeHelper("trap 'printf TERM; exit 7' TERM; printf ready; while :; do sleep 0.05; done");
  try {
    let sent = false;
    const result = await runWrapper(helper.script, {
      onStdout: (child, soFar) => {
        if (!sent && soFar.includes("ready")) {
          sent = true;
          child.kill("SIGTERM");
        }
      }
    });
    assert.equal(sent, true);
    assert.equal(result.code, 7, "the command's own exit code, after its TERM trap ran");
    assert.equal(result.stdout.toString(), "readyTERM");
  } finally {
    await helper.cleanup();
  }
});

test("statusLine wrapper: a signal after the person's command has ended (a background child still holds its output) ends the wrapper as the default action would", POSIX, async () => {
  // The shell exits at once; the subshell's `sleep 3` keeps the output pipe open for 3 s. Its own stderr is
  // sent away so that only the wrapper holds the test's pipes.
  const helper = await makeHelper("printf hud; (sleep 3) 2>/dev/null &");
  let timer = null;
  try {
    const result = await runWrapper(helper.script, {
      onStdout: (child, soFar) => {
        if (!timer && soFar.includes("hud")) timer = setTimeout(() => child.kill("SIGTERM"), 300);
      }
    });
    assert.equal(result.signal, "SIGTERM", "ended by the signal, as it would be without a handler");
    assert.equal(result.stdout.toString(), "hud");
    assert.ok(result.ms < 2000, `the wrapper ended after ${result.ms} ms, not when the background child let go (3 s)`);
  } finally {
    clearTimeout(timer);
    await helper.cleanup();
  }
});

test("statusLine wrapper: a large status line (300 KB) comes through whole", POSIX, async () => {
  const helper = await makeHelper("head -c 300000 /dev/zero | tr '\\000' x");
  try {
    const result = await runWrapper(helper.script);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.length, 300000);
    assert.ok(result.stdout.every((byte) => byte === 0x78));
  } finally {
    await helper.cleanup();
  }
});

test("statusLineCommand quotes the bundled Node and the script for Claude's shell; run with /bin/sh -c it starts the wrapper, also from a folder with a space and an apostrophe", POSIX, async () => {
  const helper = await makeHelper("printf 'from the wrapper'", { folderName: "Agent OS's sessions" });
  try {
    const line = statusLineCommand(helper.script);
    assert.equal(line, helperCommandLine({ command: process.execPath, args: [helper.script] }));
    assert.ok(line.includes("'\\''"), "the apostrophe is quoted for the shell");
    assert.equal(
      statusLineCommand("C:\\Agent OS\\statusline.mjs", "win32"),
      helperCommandLine({ command: process.execPath, args: ["C:\\Agent OS\\statusline.mjs"] }, "win32")
    );
    const result = await runShell(line, { stdin: Buffer.from("{}") });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.toString(), "from the wrapper");
  } finally {
    await helper.cleanup();
  }
});

test("writeStatusLineHelper writes statusline.mjs (a byte copy of the wrapper) and statusline.json, both 0600 in a 0700 folder, and replaces older files", POSIX, async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-statusline-files-")));
  try {
    assert.equal(STATUSLINE_WRAPPER_SOURCE, path.join(root, "server", "runtime", "sessions", "statusline-wrapper.mjs"));
    const dir = path.join(base, "sessions", crypto.randomUUID());
    const first = await writeStatusLineHelper({ dir, userStatusLine: { command: "printf one", padding: 1, from: "user" } });
    assert.deepEqual(first, { script: path.join(dir, "statusline.mjs"), config: path.join(dir, "statusline.json") });
    assert.deepEqual(await readFile(first.script), await readFile(STATUSLINE_WRAPPER_SOURCE));
    assert.deepEqual(JSON.parse(await readFile(first.config, "utf8")), { version: 1, command: "printf one" });
    assert.equal(await modeOf(dir), 0o700);
    assert.equal(await modeOf(first.script), 0o600);
    assert.equal(await modeOf(first.config), 0o600);
    await chmod(first.script, 0o644);
    await chmod(first.config, 0o644);
    await writeStatusLineHelper({ dir, userStatusLine: null });
    assert.deepEqual(JSON.parse(await readFile(first.config, "utf8")), { version: 1, command: null });
    assert.equal(await modeOf(first.script), 0o600, "an older, looser file is replaced by a 0600 one");
    assert.equal(await modeOf(first.config), 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ["statusline.json", "statusline.mjs"], "no temp file is left behind");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// =====================================================================
// 2. Reading Claude's settings files (H1 reads, R9, R10)
// =====================================================================

async function withSettingsFiles(fn) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-claude-settings-")));
  const ctx = { base, home: path.join(base, "home"), managedPath: path.join(base, "managed-settings.json") };
  ctx.project = path.join(ctx.home, "projects", "app");
  ctx.files = {
    managed: ctx.managedPath,
    local: path.join(ctx.project, ".claude", "settings.local.json"),
    project: path.join(ctx.project, ".claude", "settings.json"),
    user: path.join(ctx.home, ".claude", "settings.json")
  };
  await mkdir(ctx.project, { recursive: true });
  try {
    return await fn(ctx);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("readClaudeSettingsLayers reads managed, local project, project and user settings and keeps only the five keys it needs", async () => {
  await withSettingsFiles(async ({ home, project, managedPath, files }) => {
    const statusLine = { type: "command", command: "printf hud", padding: 1 };
    await writeSettings(files.managed, { statusLine, allowManagedHooksOnly: false, permissions: { deny: ["Bash"] } });
    await writeSettings(files.local, { statusLine, apiKeyHelper: "never-kept", env: { SECRET: "never-kept" } });
    await writeSettings(files.project, { disableAllHooks: false, hooks: { Stop: [] }, model: "opus" });
    await writeSettings(files.user, { allowedHttpHookUrls: ["http://127.0.0.1:*"], httpHookAllowedEnvVars: ["AGENT_OS_HOOK_TOKEN"], enabledPlugins: { x: true } });
    const layers = await readClaudeSettingsLayers({ folder: project, env: {}, home, managedPath });
    assert.deepEqual(layers, {
      managed: { statusLine, allowManagedHooksOnly: false },
      local: { statusLine },
      project: { disableAllHooks: false },
      user: { allowedHttpHookUrls: ["http://127.0.0.1:*"], httpHookAllowedEnvVars: ["AGENT_OS_HOOK_TOKEN"] }
    });
    assert.deepEqual([...SETTINGS_READ_KEYS], ["statusLine", "disableAllHooks", "allowManagedHooksOnly", "allowedHttpHookUrls", "httpHookAllowedEnvVars"]);
    assert.deepEqual({ ...MANAGED_SETTINGS_PATHS }, {
      darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
      linux: "/etc/claude-code/managed-settings.json",
      win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json"
    });
  });
});

test("readClaudeSettingsLayers: missing, broken, non-object and unreadable files read as null; CLAUDE_CONFIG_DIR (absolute only) moves the user file", async () => {
  await withSettingsFiles(async ({ base, home, project, files }) => {
    await writeSettings(files.local, "{ broken");
    await writeSettings(files.project, [1, 2]);
    await mkdir(files.user, { recursive: true }); // a folder where the file would be
    const empty = await readClaudeSettingsLayers({ folder: project, env: {}, home, managedPath: path.join(base, "missing.json") });
    assert.deepEqual(empty, { managed: null, local: null, project: null, user: null });
    const configDir = path.join(base, "claude-config");
    await writeSettings(path.join(configDir, "settings.json"), { disableAllHooks: true });
    const moved = await readClaudeSettingsLayers({ folder: project, env: { CLAUDE_CONFIG_DIR: configDir }, home, managedPath: files.managed });
    assert.deepEqual(moved.user, { disableAllHooks: true });
    for (const ignored of ["relative/claude", ""]) {
      const layers = await readClaudeSettingsLayers({ folder: project, env: { CLAUDE_CONFIG_DIR: ignored }, home, managedPath: files.managed });
      assert.equal(layers.user, null, `CLAUDE_CONFIG_DIR=${JSON.stringify(ignored)} falls back to ~/.claude`);
    }
    const noFolder = await readClaudeSettingsLayers({ folder: "relative/folder", env: { CLAUDE_CONFIG_DIR: configDir }, home, managedPath: files.managed });
    assert.equal(noFolder.local, null);
    assert.equal(noFolder.project, null);
  });
});

test("readClaudeSettingsLayers opens only those four files: never ~/.claude.json, never anything else under ~/.claude", async () => {
  await withSettingsFiles(async ({ base, home, project, managedPath, files }) => {
    await writeSettings(path.join(home, ".claude.json"), { oauthAccount: "never-read" });
    await writeSettings(path.join(home, ".claude", ".credentials.json"), { never: "read" });
    await writeSettings(files.user, { disableAllHooks: false });
    const seen = [];
    const restore = spyOnFileAccess(seen);
    try {
      await readClaudeSettingsLayers({ folder: project, env: {}, home, managedPath });
    } finally {
      restore();
    }
    const touched = seen.filter((file) => file.startsWith(base));
    assert.deepEqual([...new Set(touched)].sort(), Object.values(files).sort());
    assert.ok(!seen.some((file) => file.endsWith(`${path.sep}.claude.json`)), "never ~/.claude.json");
  });
});

// Something that is not a plain file where a settings file belongs, made inside the temp folders only.
// Opens a pipe for writing at the end, so a read that did wait for it (the bug) lets go of its thread.
async function withHostileSettings(files, fn) {
  const fifo = files.local;
  await mkdir(path.dirname(fifo), { recursive: true });
  execFileSync("mkfifo", [fifo]);
  try {
    return await fn();
  } finally {
    try {
      closeSync(openSync(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK));
    } catch {
      // nothing to release
    }
  }
}

const within = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer after ${ms} ms`)), ms).unref())]);

test("B-I1: a pipe, a device and a file over 1 MB where a settings file belongs are ignored at once (the layer reads as null) and the other layers are still read", POSIX, async () => {
  await withSettingsFiles(async ({ home, project, managedPath, files }) => {
    await writeSettings(files.managed, { allowManagedHooksOnly: true });
    await withHostileSettings(files, async () => {
      await mkdir(path.dirname(files.project), { recursive: true });
      await symlink("/dev/zero", files.project);
      // Valid JSON, but 1 MB and one byte long: not read. One of exactly 1 MB is.
      const json = '{"disableAllHooks":true}';
      await mkdir(path.dirname(files.user), { recursive: true });
      await writeFile(files.user, json + " ".repeat(1024 * 1024 + 1 - json.length));
      const answered = await within(readClaudeSettingsLayers({ folder: project, env: {}, home, managedPath }), 3000, "readClaudeSettingsLayers");
      assert.deepEqual(answered, { managed: { allowManagedHooksOnly: true }, local: null, project: null, user: null });
      await writeFile(files.user, json + " ".repeat(1024 * 1024 - json.length));
      const atTheLimit = await within(readClaudeSettingsLayers({ folder: project, env: {}, home, managedPath }), 3000, "the file at the limit");
      assert.deepEqual(atTheLimit.user, { disableAllHooks: true });
      // A link to a real settings file is followed (a person's dotfiles); a pipe or a device never is.
      await rm(files.project);
      await writeSettings(path.join(home, "dotfiles", "project-settings.json"), { disableAllHooks: false });
      await symlink(path.join(home, "dotfiles", "project-settings.json"), files.project);
      const linked = await within(readClaudeSettingsLayers({ folder: project, env: {}, home, managedPath }), 3000, "the linked file");
      assert.deepEqual(linked.project, { disableAllHooks: false });
    });
  });
});

test("B-I1: a pipe at <folder>/.claude/settings.local.json does not stop a Claude start: the start goes on without that layer, the person's other settings still apply, and the server's file calls still answer", POSIX, async () => {
  await withProfileWorld(async (ctx) => {
    await writeSettings(path.join(ctx.home, ".claude", "settings.json"), { statusLine: { type: "command", command: "printf user-line" } });
    const files = { local: path.join(ctx.project, ".claude", "settings.local.json") };
    await withHostileSettings(files, async () => {
      // Two starts at once: with the old read each would sit in one of Node's file threads for good.
      const sessionIds = [crypto.randomUUID(), crypto.randomUUID()];
      const profiles = await within(Promise.all(sessionIds.map((sessionId) => startClaude(ctx, { sessionId }))), 5000, "two Claude starts");
      for (const profile of profiles) assert.equal(profile.claude.statusLineFrom, "user");
      const probe = path.join(ctx.agentOsHome, "still-answers.txt");
      await within(writeFile(probe, "ok"), 2000, "an unrelated file write");
      assert.equal(await readFile(probe, "utf8"), "ok");
    });
  });
});

test("findUserStatusLine: managed, then local project, project and user; only a command status line; padding, refreshInterval and hideVimModeIndicator copied when they are valid", () => {
  const line = (command, extra = {}) => ({ statusLine: { type: "command", command, ...extra } });
  const none = { managed: null, local: null, project: null, user: null };
  assert.deepEqual(findUserStatusLine({ managed: line("m"), local: line("l"), project: line("p"), user: line("u") }), { command: "m", from: "managed" });
  assert.deepEqual(findUserStatusLine({ ...none, local: line("l"), project: line("p"), user: line("u") }), { command: "l", from: "local" });
  assert.deepEqual(findUserStatusLine({ ...none, project: line("p"), user: line("u") }), { command: "p", from: "project" });
  assert.deepEqual(
    findUserStatusLine({ ...none, user: line("u", { padding: 0, refreshInterval: 5, hideVimModeIndicator: true, other: "dropped" }) }),
    { command: "u", padding: 0, refreshInterval: 5, hideVimModeIndicator: true, from: "user" }
  );
  // Only a command status line with a non-empty command counts; the next file is used.
  assert.deepEqual(
    findUserStatusLine({ managed: { statusLine: { type: "static", command: "x" } }, local: { statusLine: { type: "command", command: "   " } }, project: { statusLine: "printf hi" }, user: line("u") }),
    { command: "u", from: "user" }
  );
  // A display key with the wrong JSON type is left out: Claude could refuse the whole settings file.
  assert.deepEqual(findUserStatusLine({ ...none, user: line("u", { padding: "2", refreshInterval: null, hideVimModeIndicator: "yes" }) }), { command: "u", from: "user" });
  assert.equal(findUserStatusLine(none), null);
  assert.equal(findUserStatusLine(null), null);
});

const HOOK_URL = `http://127.0.0.1:51234/hooks/sessions/${SESSION_ID}`;
const NO_LAYERS = { managed: null, local: null, project: null, user: null };
const off = (layers) => detectHooksOff({ ...NO_LAYERS, ...layers }, { hookUrl: HOOK_URL });

test("detectHooksOff: every code, in its order, field by field (R9, K10)", () => {
  const corpLine = { type: "command", command: "corp-line" };
  assert.deepEqual(off({}), { alerts: null, meter: null });
  assert.deepEqual(off({ managed: { allowManagedHooksOnly: true } }), { alerts: "managed_hooks_only", meter: "managed_hooks_only" });
  assert.deepEqual(off({ managed: { allowManagedHooksOnly: false } }), { alerts: null, meter: null });
  assert.deepEqual(off({ user: { allowManagedHooksOnly: true } }), { alerts: null, meter: null }, "only managed settings can allow managed hooks only");
  for (const where of ["managed", "local", "project", "user"]) {
    assert.deepEqual(off({ [where]: { disableAllHooks: true } }), { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" }, where);
  }
  assert.deepEqual(off({ project: { allowedHttpHookUrls: ["https://hooks.example.com/*"] } }), { alerts: "http_hook_urls", meter: null });
  assert.deepEqual(off({ user: { httpHookAllowedEnvVars: ["MY_TOKEN"] } }), { alerts: "http_hook_env_vars", meter: null });
  assert.deepEqual(off({ managed: { statusLine: corpLine } }), { alerts: null, meter: "managed_status_line" });
  // The first match per field.
  assert.deepEqual(off({ managed: { allowManagedHooksOnly: true, statusLine: corpLine }, user: { disableAllHooks: true } }), { alerts: "managed_hooks_only", meter: "managed_hooks_only" });
  assert.deepEqual(off({ local: { disableAllHooks: true, allowedHttpHookUrls: [] } }), { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" });
  assert.deepEqual(off({ managed: { statusLine: corpLine }, project: { allowedHttpHookUrls: [], httpHookAllowedEnvVars: [] } }), { alerts: "http_hook_urls", meter: "managed_status_line" });
  assert.deepEqual(off({ user: { allowedHttpHookUrls: ["http://127.0.0.1:*"], httpHookAllowedEnvVars: [] } }), { alerts: "http_hook_env_vars", meter: null });
});

test("detectHooksOff: allowedHttpHookUrls patterns use * as the only wildcard and merge across files; httpHookAllowedEnvVars must name AGENT_OS_HOOK_TOKEN", () => {
  for (const pattern of ["*", "http://127.0.0.1:*", "http://127.0.0.1:*/hooks/sessions/*", HOOK_URL]) {
    assert.equal(off({ user: { allowedHttpHookUrls: [pattern] } }).alerts, null, pattern);
  }
  for (const pattern of ["http://localhost:*", "http://127.0.0.1:51234/hooks", "http://127.0.0.1:51234/hooks/sessions/.*", "https://127.0.0.1:*"]) {
    assert.equal(off({ user: { allowedHttpHookUrls: [pattern] } }).alerts, "http_hook_urls", pattern);
  }
  // Lists merge across files: one file's entry allows the URL although another file's does not.
  assert.equal(off({ managed: { allowedHttpHookUrls: ["https://corp.example/*"] }, user: { allowedHttpHookUrls: ["http://127.0.0.1:*"] } }).alerts, null);
  assert.equal(off({ project: { httpHookAllowedEnvVars: ["OTHER"] }, user: { httpHookAllowedEnvVars: ["AGENT_OS_HOOK_TOKEN"] } }).alerts, null);
  // Not a list: Agent OS does not read it as one (Claude's own validation decides).
  assert.equal(off({ user: { allowedHttpHookUrls: "http://localhost:*" } }).alerts, null);
});

// =====================================================================
// 3. parseStatusLine: the Live meter (R11) and the limit's status signal (R4, K2)
// =====================================================================

const NOW_MS = Date.parse("2026-10-29T12:00:00.000Z");

test("parseStatusLine: Claude's statusLine JSON becomes the Live meter (model, context, 5-hour and weekly windows, Claude's cost estimate)", () => {
  assert.deepEqual(parseStatusLine(statusJson({ nowMs: NOW_MS }), NOW_MS), {
    meter: {
      model: "Opus 5.5 · 1M",
      contextPercent: 41.5,
      contextTokens: 15500,
      plan: { usedPercent: 23.5, resetsAt: isoIn(NOW_MS, 2 * HOUR_S) },
      weekly: { usedPercent: 41.2, resetsAt: isoIn(NOW_MS, 72 * HOUR_S) },
      costUsd: 0.4213,
      at: "2026-10-29T12:00:00.000Z"
    },
    claudeSessionId: CLAUDE_UUID,
    atLimit: false,
    resetAt: null
  });
  assert.equal(parseStatusLine({ session_id: CLAUDE_UUID.toUpperCase() }, NOW_MS).claudeSessionId, CLAUDE_UUID);
  assert.equal(parseStatusLine({ session_id: "../../etc/passwd" }, NOW_MS).claudeSessionId, null);
  const model = parseStatusLine({ model: { display_name: `Opus\x1b[31m\n${"x".repeat(200)}` } }, NOW_MS).meter.model;
  assert.equal([...model].length, 80);
  assert.doesNotMatch(model, /[\x00-\x1f\x7f]/);
});

test("parseStatusLine: missing or early fields read as unknown; no rate_limits (OpenRouter, Local) gives no plan rows and no limit", () => {
  const unknown = {
    meter: { model: null, contextPercent: null, contextTokens: null, plan: null, weekly: null, costUsd: null, at: "2026-10-29T12:00:00.000Z" },
    claudeSessionId: null,
    atLimit: false,
    resetAt: null
  };
  for (const input of [{}, null, "text", 42, []]) assert.deepEqual(parseStatusLine(input, NOW_MS), unknown, JSON.stringify(input));
  const early = parseStatusLine(statusJson({ nowMs: NOW_MS, extra: { context_window: { used_percentage: null, current_usage: null }, cost: { total_cost_usd: -1 } } }), NOW_MS);
  assert.equal(early.meter.contextPercent, null);
  assert.equal(early.meter.contextTokens, null);
  assert.equal(early.meter.costUsd, null);
  const { rate_limits: _dropped, ...noLimits } = statusJson({ nowMs: NOW_MS });
  const openRouter = parseStatusLine(noLimits, NOW_MS);
  assert.equal(openRouter.meter.plan, null);
  assert.equal(openRouter.meter.weekly, null);
  assert.equal(openRouter.atLimit, false);
  assert.equal(openRouter.meter.costUsd, 0.4213, "the cost is still Claude's own estimate");
  assert.equal(parseStatusLine({ context_window: { used_percentage: 130 } }, NOW_MS).meter.contextPercent, 100);
  assert.equal(parseStatusLine({ context_window: { used_percentage: -5 } }, NOW_MS).meter.contextPercent, 0);
});

test("parseStatusLine: a window at 100 % with its reset ahead is at the limit (the later reset of two); a window past its reset counts as cleared (R4)", () => {
  const five = parseStatusLine(statusJson({ nowMs: NOW_MS, fiveHour: 100 }), NOW_MS);
  assert.equal(five.atLimit, true);
  assert.equal(five.resetAt, isoIn(NOW_MS, 2 * HOUR_S));
  assert.deepEqual(five.meter.plan, { usedPercent: 100, resetsAt: isoIn(NOW_MS, 2 * HOUR_S) });
  const both = parseStatusLine(statusJson({ nowMs: NOW_MS, fiveHour: 100, sevenDay: 100 }), NOW_MS);
  assert.equal(both.resetAt, isoIn(NOW_MS, 72 * HOUR_S), "both windows spent: the later reset");
  const over = parseStatusLine(statusJson({ nowMs: NOW_MS, fiveHour: 104.2 }), NOW_MS);
  assert.equal(over.meter.plan.usedPercent, 100);
  assert.equal(over.atLimit, true);
  const passedAt = Math.floor(NOW_MS / 1000) - 60;
  const passed = parseStatusLine({ rate_limits: { five_hour: { used_percentage: 100, resets_at: passedAt } } }, NOW_MS);
  assert.equal(passed.meter.plan, null);
  assert.equal(passed.atLimit, false);
  const noReset = parseStatusLine({ rate_limits: { five_hour: { used_percentage: 100 } } }, NOW_MS);
  assert.deepEqual(noReset.meter.plan, { usedPercent: 100, resetsAt: null });
  assert.equal(noReset.atLimit, false, "at the limit only with a reset ahead (contract)");
  const millis = parseStatusLine({ rate_limits: { seven_day: { used_percentage: 5, resets_at: NOW_MS + 3600000 } } }, NOW_MS);
  assert.equal(millis.meter.weekly.resetsAt, new Date(NOW_MS + 3600000).toISOString());
});

// =====================================================================
// 4. The launch profile (H3, H6, R9, R10; Security 5)
// =====================================================================

// A temp world: HOME, AGENT_OS_HOME, a managed-settings path nothing else uses, stand-in agent
// binaries (never run here) and a login shell that runs `startupLines(base)` (what the person's
// startup files would do) before W1's stand-in login shell.
async function withProfileWorld(fn, { startupLines = () => [] } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-statusline-world-")));
  const ctx = {
    base,
    home: path.join(base, "home"),
    agentOsHome: path.join(base, "agent-os-home"),
    bin: path.join(base, "bin"),
    managedPath: path.join(base, "managed-settings.json"),
    detected: {}
  };
  ctx.project = path.join(ctx.home, "projects", "app");
  for (const dir of [ctx.project, ctx.agentOsHome, ctx.bin]) await mkdir(dir, { recursive: true });
  for (const agentId of ["claude", "codex"]) {
    const file = path.join(ctx.bin, agentId);
    await writeFile(file, "#!/bin/sh\necho 'fake agent: these tests never start it' >&2\nexit 1\n");
    await chmod(file, 0o755);
    ctx.detected[agentId] = { installed: true, path: file, version: "9.9.9", features: {} };
  }
  ctx.shell = path.join(base, "login-shell");
  await writeFile(ctx.shell, ["#!/bin/sh", ...startupLines(base), `exec ${shQuote(FAKE_LOGIN_SHELL)} "$@"`, ""].join("\n"));
  await chmod(ctx.shell, 0o755);
  resetLoginShellEnvForTests();
  try {
    return await withEnv(
      {
        HOME: ctx.home,
        USERPROFILE: ctx.home,
        AGENT_OS_HOME: ctx.agentOsHome,
        HERMES_AGENT_OS_HOME: undefined,
        AGENT_OS_MANAGED_ROOT: path.join(base, "managed-node"),
        SHELL: ctx.shell,
        ZDOTDIR: undefined,
        ENV: undefined,
        BASH_ENV: undefined,
        AGENT_OS_LAUNCH_PATH: undefined,
        npm_lifecycle_event: undefined,
        CLAUDE_CONFIG_DIR: undefined,
        HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
        PATH: [ctx.bin, ...SYSTEM_PATH_DIRS].join(path.delimiter)
      },
      async () => {
        assert.equal(os.homedir(), ctx.home, "tests must never see the real home folder");
        return await fn(ctx);
      }
    );
  } finally {
    resetLoginShellEnvForTests();
    // A session's last meta.json write can still land while the folder is removed (ENOTEMPTY under load:
    // its status is "exited" in memory a moment before the file is written); rm tries again.
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function startClaude(ctx, extra = {}) {
  return buildSessionProfile({
    agentId: "claude",
    folder: ctx.project,
    sessionId: crypto.randomUUID(),
    settings: { claudeFullscreen: false },
    detected: ctx.detected.claude,
    brain: null,
    agentOsVersion: VERSION,
    hook: { port: ctx.port ?? 51234, token: TOKEN },
    managedSettingsPath: ctx.managedPath,
    ...extra
  });
}

const sessionFile = (ctx, sessionId, name) => path.join(ctx.agentOsHome, "sessions", sessionId, name);
const readJsonFile = async (file) => JSON.parse(await readFile(file, "utf8"));

test("profile (Claude Code, with a hook): the settings file's statusLine runs Agent OS's wrapper with the bundled Node, copies the person's padding, refresh and vim choice, and the helper files are 0600; a resume writes them again", POSIX, async () => {
  await withProfileWorld(async (ctx) => {
    await writeSettings(path.join(ctx.home, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "printf user-line", padding: 2, refreshInterval: 7, hideVimModeIndicator: true },
      permissions: { allow: ["Bash(ls)"] }
    });
    const sessionId = crypto.randomUUID();
    const profile = await startClaude(ctx, { sessionId });
    const script = sessionFile(ctx, sessionId, "statusline.mjs");
    assert.deepEqual(profile.args.slice(-2), ["--settings", sessionFile(ctx, sessionId, "claude-settings.json")]);
    const settings = await readJsonFile(sessionFile(ctx, sessionId, "claude-settings.json"));
    assert.deepEqual(settings.statusLine, { type: "command", command: statusLineCommand(script), padding: 2, refreshInterval: 7, hideVimModeIndicator: true });
    assert.equal(settings.statusLine.command, helperCommandLine({ command: process.execPath, args: [script] }), "the bundled Node's absolute path");
    assert.deepEqual(Object.keys(settings), ["hooks", "statusLine"], "nothing else of the person's settings is copied");
    assert.deepEqual(await readFile(script), await readFile(STATUSLINE_WRAPPER_SOURCE));
    assert.deepEqual(await readJsonFile(sessionFile(ctx, sessionId, "statusline.json")), { version: 1, command: "printf user-line" });
    for (const name of ["claude-settings.json", "statusline.mjs", "statusline.json"]) {
      assert.equal(await modeOf(sessionFile(ctx, sessionId, name)), 0o600, name);
    }
    assert.equal(await modeOf(path.join(ctx.agentOsHome, "sessions", sessionId)), 0o700);
    assert.deepEqual(profile.claude, {
      hookUrl: `http://127.0.0.1:51234/hooks/sessions/${sessionId}`,
      hooksOff: { alerts: null, meter: null },
      statusLineFrom: "user"
    });
    // The person changed their status line before resuming: the files follow.
    await writeSettings(path.join(ctx.project, ".claude", "settings.local.json"), { statusLine: { type: "command", command: "printf local-line" } });
    const resumed = await startClaude(ctx, { sessionId, resume: { agentSessionId: profile.agentSessionId } });
    assert.equal(resumed.claude.statusLineFrom, "local");
    assert.deepEqual(await readJsonFile(sessionFile(ctx, sessionId, "statusline.json")), { version: 1, command: "printf local-line" });
    assert.deepEqual((await readJsonFile(sessionFile(ctx, sessionId, "claude-settings.json"))).statusLine, { type: "command", command: statusLineCommand(script) });
  });
});

test("profile: through the settings file Claude reads, the person's status line prints byte for byte and its JSON reaches <hook url>/status with the session's token (H6)", POSIX, async () => {
  await withStatusServer({}, async ({ port, requests }) => {
    await withProfileWorld(async (ctx) => {
      await writeSettings(path.join(ctx.home, ".claude", "settings.json"), {
        statusLine: { type: "command", command: "printf '\\033[2m%s\\033[0m' \"$AGENT_OS_SESSION_ID\"; cat > /dev/null" }
      });
      const sessionId = crypto.randomUUID();
      const profile = await startClaude({ ...ctx, port }, { sessionId });
      const settings = await readJsonFile(sessionFile(ctx, sessionId, "claude-settings.json"));
      const input = Buffer.from(JSON.stringify(statusJson()));
      const result = await runShell(settings.statusLine.command, { env: profile.env, cwd: profile.cwd, stdin: input });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.stdout, Buffer.from(`\x1b[2m${sessionId}\x1b[0m`));
      await waitFor(() => requests.length === 1, 3000, "the copy for the Live meter");
      assert.equal(requests[0].url, `/hooks/sessions/${sessionId}/status`);
      assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(requests[0].body, input);
    });
  });
});

test("profile: with no status line of the person's own, Agent OS's wrapper is still set, prints nothing and still feeds the meter; statusLineFrom is null", POSIX, async () => {
  await withStatusServer({}, async ({ port, requests }) => {
    await withProfileWorld(async (ctx) => {
      const sessionId = crypto.randomUUID();
      const profile = await startClaude({ ...ctx, port }, { sessionId });
      assert.equal(profile.claude.statusLineFrom, null);
      assert.deepEqual(await readJsonFile(sessionFile(ctx, sessionId, "statusline.json")), { version: 1, command: null });
      const settings = await readJsonFile(sessionFile(ctx, sessionId, "claude-settings.json"));
      assert.deepEqual(settings.statusLine, { type: "command", command: statusLineCommand(sessionFile(ctx, sessionId, "statusline.mjs")) });
      const input = Buffer.from(JSON.stringify(statusJson()));
      const result = await runShell(settings.statusLine.command, { env: profile.env, cwd: profile.cwd, stdin: input });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.length, 0, "H6: nothing printed when the person has no status line");
      await waitFor(() => requests.length === 1, 3000, "the copy for the Live meter");
      assert.deepEqual(requests[0].body, input);
    });
  });
});

test("profile: settings that keep hooks or the status line out give hooksOff codes (CLAUDE_CONFIG_DIR honoured, managed settings first), and Agent OS never writes those keys", POSIX, async () => {
  await withProfileWorld(
    async (ctx) => {
      const configDir = path.join(ctx.base, "claude-config");
      // The person's startup file moved Claude's folder, so ~/.claude/settings.json is not theirs any more.
      await writeSettings(path.join(ctx.home, ".claude", "settings.json"), { disableAllHooks: true });
      await writeSettings(path.join(configDir, "settings.json"), { allowedHttpHookUrls: ["http://localhost:*"], statusLine: { type: "command", command: "printf moved" } });
      const moved = await startClaude(ctx);
      assert.equal(moved.env.CLAUDE_CONFIG_DIR, configDir, "H1: passed through as the person has it");
      assert.deepEqual(moved.claude.hooksOff, { alerts: "http_hook_urls", meter: null });
      assert.equal(moved.claude.statusLineFrom, "user");
      assert.deepEqual(Object.keys(await readJsonFile(moved.settingsFile)), ["statusLine"], "alerts off: no event hooks to fail, the wrapper stays");
      // A project that turns every hook off.
      await writeSettings(path.join(ctx.project, ".claude", "settings.json"), { disableAllHooks: true });
      const sessionId = crypto.randomUUID();
      const allOff = await startClaude(ctx, { sessionId });
      assert.deepEqual(allOff.claude.hooksOff, { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" });
      assert.deepEqual(Object.keys(await readJsonFile(sessionFile(ctx, sessionId, "claude-settings.json"))), [], "hooks and meter both off: nothing for Claude to run, and never disableAllHooks or any allowlist of Agent OS's own");
      // Managed settings win (R10), and a managed status line turns the Live meter off.
      await rm(path.join(ctx.project, ".claude", "settings.json"));
      await writeSettings(ctx.managedPath, { statusLine: { type: "command", command: "printf corp" } });
      const managed = await startClaude(ctx);
      assert.equal(managed.claude.statusLineFrom, "managed");
      assert.deepEqual(managed.claude.hooksOff, { alerts: "http_hook_urls", meter: "managed_status_line" });
      assert.deepEqual(Object.keys(await readJsonFile(managed.settingsFile)), [], "both off: an empty settings file");
    },
    { startupLines: (base) => [`CLAUDE_CONFIG_DIR=${shQuote(path.join(base, "claude-config"))}`, "export CLAUDE_CONFIG_DIR"] }
  );
});

test("profile: when alerts are off for any reason the settings file has no event hooks (no hook error in the person's transcript); the wrapper stays unless the meter is off too", POSIX, async () => {
  const cases = [
    // [what is wrong in the person's settings, hooksOff, keys of the written file]
    ["none", null, { alerts: null, meter: null }, ["hooks", "statusLine"]],
    ["http_hook_urls", ["user", { allowedHttpHookUrls: ["https://hooks.example.com/*"] }], { alerts: "http_hook_urls", meter: null }, ["statusLine"]],
    ["http_hook_env_vars", ["user", { httpHookAllowedEnvVars: ["SOME_OTHER_VARIABLE"] }], { alerts: "http_hook_env_vars", meter: null }, ["statusLine"]],
    ["all_hooks_disabled", ["project", { disableAllHooks: true }], { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" }, []],
    ["managed_hooks_only", ["managed", { allowManagedHooksOnly: true }], { alerts: "managed_hooks_only", meter: "managed_hooks_only" }, []],
    ["managed_status_line", ["managed", { statusLine: { type: "command", command: "printf corp" } }], { alerts: null, meter: "managed_status_line" }, ["hooks"]]
  ];
  for (const [what, wrong, hooksOff, keys] of cases) {
    await withProfileWorld(async (ctx) => {
      const files = { user: path.join(ctx.home, ".claude", "settings.json"), project: path.join(ctx.project, ".claude", "settings.json"), managed: ctx.managedPath };
      if (wrong) await writeSettings(files[wrong[0]], wrong[1]);
      const sessionId = crypto.randomUUID();
      const profile = await startClaude(ctx, { sessionId });
      assert.deepEqual(profile.claude.hooksOff, hooksOff, what);
      const settings = await readJsonFile(sessionFile(ctx, sessionId, "claude-settings.json"));
      assert.deepEqual(Object.keys(settings), keys, `${what}: keys of the written settings file`);
      assert.deepEqual(profile.args.slice(-2), ["--settings", sessionFile(ctx, sessionId, "claude-settings.json")], `${what}: --settings is still passed`);
      assert.equal(profile.env.AGENT_OS_HOOK_URL, `http://127.0.0.1:51234/hooks/sessions/${sessionId}`, `${what}: the hook address stays in the environment (X2a)`);
      // The wrapper's files exist exactly when the settings file names the wrapper.
      for (const name of ["statusline.mjs", "statusline.json"]) {
        if (keys.includes("statusLine")) assert.ok((await stat(sessionFile(ctx, sessionId, name))).isFile(), `${what}: ${name}`);
        else await assert.rejects(stat(sessionFile(ctx, sessionId, name)), { code: "ENOENT" }, `${what}: no ${name} when the meter is off`);
      }
      // Nothing of the person's settings and nothing that switches hooks off is ever written.
      assert.doesNotMatch(JSON.stringify(settings), /disableAllHooks|allowManagedHooksOnly|allowedHttpHookUrls|httpHookAllowedEnvVars/, what);
    });
  }
});

test("profile: no hook (no port yet) or another agent: no statusLine and no helper files (SP3 behaviour)", POSIX, async () => {
  await withProfileWorld(async (ctx) => {
    await writeSettings(path.join(ctx.home, ".claude", "settings.json"), { statusLine: { type: "command", command: "printf user-line" } });
    const plainId = crypto.randomUUID();
    const plain = await startClaude(ctx, { sessionId: plainId, hook: null });
    assert.equal(plain.claude, null);
    assert.equal(plain.settingsFile, null);
    assert.deepEqual(plain.args, ["--session-id", plain.agentSessionId]);
    for (const name of ["claude-settings.json", "statusline.mjs", "statusline.json"]) {
      await assert.rejects(stat(sessionFile(ctx, plainId, name)), { code: "ENOENT" }, name);
    }
    const codexId = crypto.randomUUID();
    const codex = await buildSessionProfile({
      agentId: "codex",
      folder: ctx.project,
      sessionId: codexId,
      settings: { claudeFullscreen: false },
      detected: ctx.detected.codex,
      brain: null,
      agentOsVersion: VERSION,
      hook: { port: 51234, token: TOKEN },
      managedSettingsPath: ctx.managedPath
    });
    assert.equal(codex.claude ?? null, null);
    for (const name of ["claude-settings.json", "statusline.mjs", "statusline.json"]) {
      await assert.rejects(stat(sessionFile(ctx, codexId, name)), { code: "ENOENT" }, name);
    }
  });
});

// =====================================================================
// 5. The manager and the hooks router, in process
// =====================================================================

// A terminal that runs nothing: these tests are about what the status line feeds, not about the
// process (sessions-manager.test.js covers that).
function fakePty(pid, options) {
  const data = new Set();
  const exits = new Set();
  const pty = {
    pid,
    options,
    exited: false,
    write() {},
    resize() {},
    pause() {},
    resume() {},
    kill(signal = "SIGTERM") {
      setImmediate(() => pty.exit(null, signal));
    },
    onData(listener) {
      data.add(listener);
      return () => data.delete(listener);
    },
    onExit(listener) {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    emit(chunk) {
      for (const listener of [...data]) listener(chunk);
    },
    exit(exitCode = 0, signal) {
      if (pty.exited) return;
      pty.exited = true;
      for (const listener of [...exits]) listener({ exitCode, signal });
    }
  };
  return pty;
}

function track(running, handle) {
  running.add(handle.pid);
  handle.onExit(() => running.delete(handle.pid));
  return handle;
}

// Only pids still in `running` (never one already seen exiting: the number could be reused).
function killLeftovers(running) {
  for (const pid of [...running]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    running.delete(pid);
  }
}

// The real manager (X1a-X2a) with the real profile, behind the real hooks router on a real port.
// realPty: W1's fake Claude Code in a real terminal; otherwise a terminal that runs nothing.
async function withManagerWorld(fn, { realPty = false, startupLines } = {}) {
  return withProfileWorld(async (ctx) => {
    const running = new Set();
    const ptys = [];
    let port = 0;
    const command = realPty ? (await makeFakeAgentBin(path.join(ctx.base, "fake-bin"), { names: ["claude"] })).paths.claude : ctx.detected.claude.path;
    const deps = {
      ptyCheck: async () => ({ ok: true }),
      isExecutionAllowed: async () => true,
      detect: async () => ({ installed: true, path: command, version: "9.9.9", features: {} }),
      resolveBrain: async () => null,
      readSettings: async () => ({ claudeFullscreen: false }),
      buildProfile: (options) => buildSessionProfile({ ...options, managedSettingsPath: ctx.managedPath }),
      getPort: () => port,
      newHookToken: () => TOKEN,
      // No real git in these tests (SP4 X7): only test/sessions-changes.test.js runs it.
      ...NO_GIT_OPTIONS
    };
    if (realPty) {
      deps.spawn = async (options) => track(running, await spawnPty(options));
    } else {
      deps.spawn = async (options) => {
        const pty = fakePty(41000 + ptys.length, options);
        ptys.push(pty);
        return pty;
      };
      deps.softStop = async () => ({ outcome: "none", note: null });
      deps.killTree = async () => {};
    }
    const manager = createSessionManager(deps);
    const app = express();
    app.use("/hooks", createHooksRouter({ manager, isLocal: () => true }));
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    port = server.address().port;
    try {
      return await fn({ ...ctx, manager, ptys, port });
    } finally {
      for (const pty of ptys) pty.exit(0);
      await manager.shutdownAll({ reason: "quit" }).catch(() => {});
      killLeftovers(running);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }, { startupLines });
}

const summaryWhen = (manager, id, check) =>
  async () => {
    const summary = await manager.get(id);
    return check(summary) ? summary : null;
  };

test("manager: Claude's statusLine run through the settings file reaches the Live meter; the meter clears trustNeeded but never makes the session turn-done", POSIX, async () => {
  await withManagerWorld(async (ctx) => {
    await writeSettings(path.join(ctx.home, ".claude", "settings.json"), { statusLine: { type: "command", command: "printf 'hud %s' \"$AGENT_OS_SESSION_ID\"" } });
    const summary = await ctx.manager.create({ agentId: "claude", folder: ctx.project });
    ctx.ptys[0].emit("> ");
    assert.equal(summary.trustNeeded, true, "alerts wait for the folder to be trusted (X2a)");
    assert.equal(summary.meter, null);
    const { args, env, cwd } = ctx.ptys[0].options;
    const settings = await readJsonFile(args[args.indexOf("--settings") + 1]);
    const nowMs = Date.now();
    const result = await runShell(settings.statusLine.command, { env, cwd, stdin: Buffer.from(JSON.stringify(statusJson({ nowMs }))) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.toString(), `hud ${summary.id}`);
    const after = await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.meter), 5000, "the Live meter");
    assert.deepEqual({ ...after.meter, at: null }, {
      model: "Opus 5.5 · 1M",
      contextPercent: 41.5,
      contextTokens: 15500,
      plan: { usedPercent: 23.5, resetsAt: isoIn(nowMs, 2 * HOUR_S) },
      weekly: { usedPercent: 41.2, resetsAt: isoIn(nowMs, 72 * HOUR_S) },
      costUsd: 0.4213,
      at: null
    });
    assert.equal(after.trustNeeded, false, "Claude runs a status line only in a trusted folder");
    assert.equal(after.alerts, "basic", "a status line is not a hook: the 20 s rule still applies");
    const posted = await postHook({ port: ctx.port, sessionId: summary.id, token: TOKEN, body: statusJson({ nowMs, fiveHour: 61 }), path: "/status" });
    assert.equal(posted.status, 204);
    await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.meter?.plan?.usedPercent === 61), 5000, "the newer status");
  });
});

test("manager: hooksOff codes found at the start reach the session summary and stay as found", POSIX, async () => {
  await withManagerWorld(async (ctx) => {
    await writeSettings(path.join(ctx.project, ".claude", "settings.json"), { disableAllHooks: true });
    const first = await ctx.manager.create({ agentId: "claude", folder: ctx.project });
    assert.deepEqual(first.hooksOff, { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" });
    const other = path.join(ctx.home, "projects", "other");
    await mkdir(other, { recursive: true });
    await writeSettings(path.join(ctx.home, ".claude", "settings.json"), { allowedHttpHookUrls: ["http://localhost:*"] });
    const second = await ctx.manager.create({ agentId: "claude", folder: other });
    assert.deepEqual(second.hooksOff, { alerts: "http_hook_urls", meter: null });
    assert.deepEqual((await ctx.manager.get(first.id)).hooksOff, { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" }, "found at the start, not read again");
  });
});

test("A-I1: a Claude session whose hooks are kept out stays basic after the poller's idle: the panel says basic, never 'Agent OS alerts you' above 'Alerts are off', and counted output wakes it", POSIX, async () => {
  await withManagerWorld(async (ctx) => {
    await writeSettings(path.join(ctx.project, ".claude", "settings.json"), { allowedHttpHookUrls: ["https://hooks.example.invalid/*"] });
    const summary = await ctx.manager.create({ agentId: "claude", folder: ctx.project });
    assert.equal(summary.hooksOff.alerts, "http_hook_urls");
    ctx.ptys[0].emit("> ");
    const agentSessionId = ctx.manager.liveAgentSessions("claude")[0].agentSessionId;
    const answers = [];
    const poller = createClaudeAgentsPoller({
      manager: ctx.manager,
      intervalMs: 20,
      runCli: async () => {
        answers.push(Date.now());
        return { ok: true, code: 0, stdout: JSON.stringify([{ sessionId: agentSessionId, status: "idle" }]) };
      }
    });
    try {
      const idle = await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.status === "idle"), 5000, "the poller's idle");
      assert.equal(idle.idleBy, "turn_done");
      assert.equal(idle.alerts, "basic", "the poller is no hook and no OSC 9: still the 20 s rule");
      poller.stop();
      // Counted output wakes a basic session; the panel then reads as basic, and the hooks-off line is the one reason shown.
      for (let line = 0; line < 3; line += 1) ctx.ptys[0].emit(`working on it, step ${line}\r\n`);
      const live = await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.status === "live"), 5000, "counted output to wake it");
      assert.equal(live.alerts, "basic");
      assert.equal(ss.sessionPanelLine(live, Date.now()), "Working. Alerts for Claude Code are basic.");
      const lines = alertsUi.panelAlertLines(live);
      assert.deepEqual(lines, ["Alerts are off for this session: your Claude settings allow hooks to reach only the addresses they list."]);
      assert.ok(!ss.sessionPanelLine(live, Date.now()).includes("Agent OS alerts you"), "the full-alerts line never sits above 'Alerts are off'");
    } finally {
      poller.stop();
    }
  });
});

test("manager: the statusLine's session_id re-links only to a conversation whose transcript exists (R1)", POSIX, async () => {
  await withManagerWorld(async (ctx) => {
    const summary = await ctx.manager.create({ agentId: "claude", folder: ctx.project });
    ctx.ptys[0].emit("> ");
    const current = () => ctx.manager.liveAgentSessions("claude")[0].agentSessionId;
    const first = current();
    const post = (sessionId, fiveHour) =>
      postHook({ port: ctx.port, sessionId: summary.id, token: TOKEN, body: statusJson({ sessionId, fiveHour }), path: "/status" });
    assert.equal((await post(crypto.randomUUID(), 11)).status, 204);
    await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.meter?.plan?.usedPercent === 11), 5000, "the first status");
    await delay(150);
    assert.equal(current(), first, "no transcript: no re-link");
    const relinked = crypto.randomUUID();
    const transcripts = path.join(ctx.home, ".claude", "projects", encodeClaudeProjectPath(ctx.project));
    await mkdir(transcripts, { recursive: true });
    await writeFile(path.join(transcripts, `${relinked}.jsonl`), "");
    assert.equal((await post(relinked.toUpperCase(), 12)).status, 204);
    await waitFor(() => current() === relinked, 5000, "the re-link");
    const metaFile = path.join(ctx.agentOsHome, "sessions", summary.id, "meta.json");
    await waitFor(async () => (await readJsonFile(metaFile)).agentSessionId === relinked, 5000, "meta.json to hold the new id");
  });
});

test("manager: the status line's rate limits confirm a hook's limit hint, never hold alone, and clear a hold they confirmed (R4, K2)", POSIX, async () => {
  await withManagerWorld(async (ctx) => {
    const summary = await ctx.manager.create({ agentId: "claude", folder: ctx.project });
    ctx.ptys[0].emit("> ");
    const nowMs = Date.now();
    const status = (fiveHour) => postHook({ port: ctx.port, sessionId: summary.id, token: TOKEN, body: statusJson({ nowMs, fiveHour }), path: "/status" });
    assert.equal((await status(100)).status, 204);
    await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.meter?.plan?.usedPercent === 100), 5000, "the meter at 100 %");
    await delay(200);
    assert.notEqual((await ctx.manager.get(summary.id)).status, "held", "the status line alone is one signal: never a hold");
    const agentSessionId = ctx.manager.liveAgentSessions("claude")[0].agentSessionId;
    const hook = await postHook({ port: ctx.port, sessionId: summary.id, token: TOKEN, body: { hook_event_name: "StopFailure", session_id: agentSessionId, error: "rate_limit" } });
    assert.equal(hook.status, 204);
    assert.equal((await status(100)).status, 204);
    const held = await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.status === "held"), 5000, "held");
    assert.equal(held.resetAt, isoIn(nowMs, 2 * HOUR_S));
    assert.equal(held.alert?.kind, "limit");
    assert.equal((await status(40)).status, 204);
    const cleared = await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.status === "idle"), 5000, "the hold to clear");
    assert.equal(cleared.alert, null);
    assert.equal(cleared.resetAt, null);
  });
});

test("manager: a status line whose rate_limits window is absent (none at all, or a window past its reset that Claude drops itself) clears a hold the status line confirmed (R4); E1 test gap", POSIX, async () => {
  await withManagerWorld(async (ctx) => {
    const summary = await ctx.manager.create({ agentId: "claude", folder: ctx.project });
    ctx.ptys[0].emit("> ");
    const nowMs = Date.now();
    const agentSessionId = ctx.manager.liveAgentSessions("claude")[0].agentSessionId;
    const post = (body) => postHook({ port: ctx.port, sessionId: summary.id, token: TOKEN, body, path: "/status" });
    const hold = async () => {
      const hook = await postHook({ port: ctx.port, sessionId: summary.id, token: TOKEN, body: { hook_event_name: "StopFailure", session_id: agentSessionId, error: "rate_limit" } });
      assert.equal(hook.status, 204);
      assert.equal((await post(statusJson({ nowMs, fiveHour: 100 }))).status, 204);
      return waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.status === "held"), 5000, "held");
    };
    const cleared = () => waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.status === "idle"), 5000, "the hold to clear");

    assert.equal((await hold()).alert?.kind, "limit");
    // No rate_limits at all (an OpenRouter or Local brain, or a Claude that dropped both windows).
    const { rate_limits: _dropped, ...noLimits } = statusJson({ nowMs });
    assert.equal((await post(noLimits)).status, 204);
    const first = await cleared();
    assert.equal(first.alert, null);
    assert.equal(first.resetAt, null);

    // Held again. Now the 5-hour window is still named but its reset time has passed: Claude drops such a window
    // itself, so it reads as absent (and a window that is still open but below 100 % is not the case tested here).
    assert.equal((await hold()).alert?.kind, "limit");
    const past = statusJson({ nowMs, fiveHour: 100 });
    past.rate_limits = { five_hour: { used_percentage: 100, resets_at: Math.floor(nowMs / 1000) - 60 } };
    assert.equal((await post(past)).status, 204);
    const second = await cleared();
    assert.equal(second.alert, null);
  });
});

test("real PTY: the fake Claude Code runs the statusLine from its settings file; the person's output comes back byte for byte and the Live meter fills", POSIX, async () => {
  await withManagerWorld(
    async (ctx) => {
      await writeSettings(path.join(ctx.home, ".claude", "settings.json"), { statusLine: { type: "command", command: "printf '\\033[2mhud\\033[0m %s' \"$AGENT_OS_SESSION_ID\"" } });
      const summary = await ctx.manager.create({ agentId: "claude", folder: ctx.project });
      const frames = [];
      await ctx.manager.attach(summary.id, { id: "probe", send: (frame) => frames.push(frame), close() {} });
      assert.equal(ctx.manager.focus(summary.id, "probe"), true);
      const screen = () => frames.map((frame) => (frame.t === "snapshot" ? frame.data : frame.t === "out" ? frame.d : "")).join("");
      await waitFor(() => screen().includes("FAKE_ARGV"), 15000, "the fake's start line");
      assert.equal(ctx.manager.write(summary.id, "probe", `statusline ${JSON.stringify(statusJson())}\r`), true);
      const match = await waitFor(() => /STATUSLINE (\d+) ("(?:[^"\\]|\\.)*")/.exec(screen()), 15000, "the status line run");
      assert.equal(match[1], "0");
      assert.equal(JSON.parse(match[2]), `\x1b[2mhud\x1b[0m ${summary.id}`);
      const after = await waitFor(summaryWhen(ctx.manager, summary.id, (s) => s.meter), 10000, "the Live meter");
      assert.equal(after.meter.model, "Opus 5.5 · 1M");
      assert.equal(after.trustNeeded, false);
    },
    { realPty: true }
  );
});
