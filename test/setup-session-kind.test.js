// The setup session kind (plan brains, Task B1a): OpenClaw's ChatGPT sign-in in
// a terminal inside Agent OS (docs/superpowers/specs/2026-10-15-plan-brains-design.md
// §1, the server half of §3's version gate, §7's two sign-in routes; Safety 2
// and 5; Review Focus 1 and 2).
//   1. The kind's profile and argv rules (profiles.js): built with W1's
//      stand-in login shell, never spawned.
//   2. The 2026.9.7 version gate (setup/openclaw-version.js, and the two
//      helpers resolve.js now exports).
//   3. The manager with injected fakes (no process, no PTY): in memory only,
//      not counted, one at a time, the quit check, Stop, quitting, the end.
//   4. POST and GET /api/setup/openclaw/signin-terminal in process, mounted
//      as server/index.js mounts them: index.js's admin check and local mode,
//      confirm, a fresh detection and the version gate, the 409s, 503, and
//      POST /api/sessions never making a setup session.
//   5. One real sign-in in a PTY against W1's fake `openclaw`.
// Temp HOME and AGENT_OS_HOME (real paths), SHELL = FAKE_LOGIN_SHELL, PATH =
// the fake bin plus the system folders, and none of the H1 variables. Never a
// real agent.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { ADAPTERS } from "../server/runtime/agents/index.js";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { requireAdminWhenPublic } from "../server/runtime/auth.js";
import { parseVersion, versionAtLeast } from "../server/runtime/builders/resolve.js";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { errorBody } from "../server/runtime/sessions/errors.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { createMirror } from "../server/runtime/sessions/mirror.js";
import {
  OPENCLAW_SIGNIN_ACTION,
  SETUP_ACTIONS,
  assertSessionArgvSafe,
  buildSessionProfile
} from "../server/runtime/sessions/profiles.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { createRecordingsRouter, createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import {
  OPENCLAW_SIGNIN_MIN_VERSION,
  OPENCLAW_TOO_OLD_MESSAGE,
  OPENCLAW_VERSION_UNKNOWN_MESSAGE,
  openclawVersionInfo
} from "../server/runtime/setup/openclaw-version.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { fakeSiwcProfile, readFakeAgentState, setFakeKnob } from "./helpers/fake-knobs.js";
import { NO_GIT_OPTIONS } from "./helpers/no-git.js";
import { H1_ENV_NAMES, withoutH1Env } from "./helpers/plan-brains-safety.js";

const isWindows = process.platform === "win32";
const POSIX_ONLY = { skip: isWindows ? "the fake agents and the stand-in login shell are POSIX shell scripts" : false };
// Node's own folder is left out on purpose: it can hold real agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNIN_ARGS = ["models", "auth", "login", "--provider", "openai", "--method", "siwc"];
const SIGNIN_PATH = "/api/setup/openclaw/signin-terminal";
const SETUP_RUNNING = "A ChatGPT sign-in is already open in Agent OS.";
const UNKNOWN_KIND = "Agent OS can't start that kind of session.";
const PTY_MESSAGE = "Agent OS could not load its terminal module on this computer, so sessions can't start.";
const OPENCLAW_MISSING = "OpenClaw isn't installed, or Agent OS can't find it. Install it in Setup, then try again.";
const UNKNOWN_SESSION = { error: "unknown_session", message: "That session doesn't exist anymore." };
const NOT_AVAILABLE = { status: 404, body: { error: "not_available" } };
// The admin-token public mode: index.js's requireAdminWhenPublic answers a request without the token first.
const ADMIN_TOKEN = "admin-test";
const AS_ADMIN = { "x-hermes-admin-token": ADMIN_TOKEN };
const ADMIN_REFUSED = { status: 403, body: { ok: false, error: "Admin token required." } };
const TOO_OLD = { status: 409, body: { error: "openclaw_too_old", message: OPENCLAW_TOO_OLD_MESSAGE } };
const VERSION_UNKNOWN = { status: 409, body: { error: "openclaw_version_unknown", message: OPENCLAW_VERSION_UNKNOWN_MESSAGE } };
// What the fake sign-in shows and what the person types: none of it may be kept anywhere.
const LINK = "https://auth.openai.com/fake-signin?state=agentos-test";
const CODE = "FAKE-1234";
const TYPED = "typed-approval-5150";
const SUMMARY_KEYS = [
  "id",
  "kind",
  "agentId",
  "agentLabel",
  "folder",
  "folderName",
  "folderShown",
  "branch",
  "status",
  "stateSince",
  "startedAt",
  "endedAt",
  "exitCode",
  "signal",
  "endedBy",
  "dismissed",
  "brain",
  "resume",
  "nothingToResume",
  "alerts",
  "alert",
  "idleBy",
  "resetAt",
  "trustNeeded",
  "hooksOff",
  "meter",
  "copyOf",
  "handoff",
  "keepGoingFailure",
  "recordingBytes"
];
const T0 = Date.parse("2026-10-16T09:00:00.000Z");
// A detection the route would hand over (section 4 tests the real one).
const DETECTED = Object.freeze({ installed: true, path: "/fake/bin/openclaw", version: "OpenClaw 2026.9.7", features: {} });
const isUnknownSession = (error) => error?.status === 404 && error?.code === "unknown_session";
const isUnknownKind = (error) => error?.status === 400 && error?.code === "unknown_kind" && error?.message === UNKNOWN_KIND;

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

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

// A temp HOME (with W1's six fakes in fake-bin/ when `fakes`) and a separate
// temp AGENT_OS_HOME, both real paths, with the stand-in login shell, the
// short PATH, local mode and none of the H1 variables (withoutH1Env), so
// whatever reaches a fake was set by Agent OS. Restored after.
async function withSetupEnv(fn, { fakes = true } = {}) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-kind-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-setup-kind-data-")));
  const bin = path.join(home, "fake-bin");
  const log = path.join(home, "fake-agent.log");
  const project = path.join(home, "projects", "demo");
  try {
    await mkdir(project, { recursive: true });
    if (fakes) await makeFakeAgentBin(bin); // all six names, mode tui
    else await mkdir(bin, { recursive: true });
    return await withEnv(
      withoutH1Env({
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        HERMES_AGENT_OS_HOME: undefined,
        AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
        SHELL: FAKE_LOGIN_SHELL,
        PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
        // The variables that point a shell at startup files, and the two that would hand the developer's
        // own PATH to the stand-in login shell (ruling R15; Task S3's fix round).
        ZDOTDIR: undefined,
        ENV: undefined,
        BASH_ENV: undefined,
        AGENT_OS_LAUNCH_PATH: undefined,
        npm_lifecycle_event: undefined,
        HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
        HERMES_AGENT_OS_ENABLE_EXEC: undefined,
        // Local mode.
        DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_PUBLIC_MODE: undefined,
        HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
        FAKE_AGENT_LOG: log,
        FAKE_AGENT_MODE: undefined,
        FAKE_AGENT_VERSION: undefined
      }),
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        clearDetectCaches();
        resetLoginShellEnvForTests();
        try {
          return await fn({ home, agentOsHome, bin, log, project });
        } finally {
          resetLoginShellEnvForTests();
          clearDetectCaches();
        }
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(agentOsHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// The session folders under AGENT_OS_HOME ([] when sessions/ was never made).
async function sessionFolders(agentOsHome) {
  try {
    return (await readdir(path.join(agentOsHome, "sessions"))).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Every file under a folder, as full paths ([] when the folder is missing).
async function filesUnder(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else files.push(full);
  }
  return files;
}

// W1's fake log: one JSON line per event ({ name, pid, at, event, ... }).
async function readFakeLog(file) {
  const text = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---- injected fakes (the pattern of test/sessions-manager.test.js) ---------------------------------

function fakePty(pid, options) {
  const dataListeners = new Set();
  const exitListeners = new Set();
  const pty = {
    pid,
    opts: options,
    writes: [],
    resizes: [],
    write(data) {
      pty.writes.push(data);
    },
    resize(cols, rows) {
      pty.resizes.push([cols, rows]);
    },
    kill() {},
    pause() {},
    resume() {},
    onData(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    emit(data) {
      for (const cb of [...dataListeners]) cb(data);
    },
    exit(exitCode = 0, signal) {
      for (const cb of [...exitListeners]) cb({ exitCode, signal });
    }
  };
  return pty;
}

function fakeMirror(options) {
  const counted = new Set();
  const mirror = {
    opts: options,
    written: [],
    disposed: false,
    writerAttached: null,
    write(chunk) {
      mirror.written.push(chunk);
    },
    resize() {},
    async snapshot() {
      return { data: mirror.disposed ? "" : mirror.written.join(""), cols: options.cols, rows: options.rows, modes: {} };
    },
    setWriterAttached(value) {
      mirror.writerAttached = value;
    },
    onCountedOutput(cb) {
      counted.add(cb);
      return () => counted.delete(cb);
    },
    dispose() {
      mirror.disposed = true;
    }
  };
  return mirror;
}

// What buildSessionProfile answers (section 1 tests the real one): the setup
// kind runs the action's argv in HOME with no soft stop.
function fakeProfile({ agentId, folder, kind, setupAction }) {
  const base = {
    command: `/fake/bin/${agentId}`,
    env: { TERM: "xterm-256color" },
    agentSessionId: null,
    settingsFile: null,
    softStop: null,
    notes: []
  };
  if (kind === "setup") {
    return { ...base, args: [...SETUP_ACTIONS[setupAction].args], cwd: os.homedir(), resumeMode: null, folderShown: false };
  }
  return { ...base, args: [], cwd: folder || os.homedir(), resumeMode: agentId === "claude" ? "id" : "fallback", folderShown: true };
}

function fakeWorld(over = {}) {
  const world = {
    clock: T0,
    gate: true,
    pty: { ok: true, reason: null },
    ptys: [],
    mirrors: [],
    profileInputs: [],
    detectCalls: [],
    folderChecks: 0,
    recorderCalls: 0,
    writes: [],
    capCalls: 0,
    kills: [],
    softStops: [],
    nextPid: 52000,
    // The next spawn waits for this promise (one shot), so a test can look at
    // the manager while a start is still in flight.
    spawnGate: null,
    spawnCalls: 0
  };
  world.deps = {
    now: () => world.clock,
    spawn: async (options) => {
      world.spawnCalls += 1;
      const gate = world.spawnGate;
      world.spawnGate = null;
      if (gate) await gate;
      const pty = fakePty(world.nextPid, options);
      world.nextPid += 1;
      world.ptys.push(pty);
      return pty;
    },
    buildProfile: async (input) => {
      world.profileInputs.push(input);
      return fakeProfile(input);
    },
    recorderFactory: () => {
      world.recorderCalls += 1;
      return { output() {}, marker() {}, resize() {}, async close() {} };
    },
    mirrorFactory: (options) => {
      const mirror = fakeMirror(options);
      world.mirrors.push(mirror);
      return mirror;
    },
    isExecutionAllowed: async () => world.gate,
    checkFolder: async (input) => {
      world.folderChecks += 1;
      return { ok: true, path: String(input), name: path.basename(String(input)) };
    },
    ptyCheck: async () => world.pty,
    detect: async (agentId) => {
      world.detectCalls.push(agentId);
      return { installed: true, path: `/fake/bin/${agentId}`, version: "OpenClaw 2026.9.7", features: {} };
    },
    resolveBrain: async () => null,
    readSettings: async () => ({ claudeFullscreen: false }),
    enforceCap: async () => {
      world.capCalls += 1;
      return { deleted: [] };
    },
    // meta.json writes are only counted: these tests read nothing back from disk.
    writeJson: async (file) => {
      world.writes.push(file);
    },
    // The process tree "dies" at once, as SIGTERM would end it.
    killTree: async (pid, options) => {
      world.kills.push([pid, options]);
      world.ptys.find((pty) => pty.pid === pid)?.exit(null, "SIGTERM");
    },
    softStop: async (input) => {
      world.softStops.push(input);
      return { outcome: "none", note: null };
    },
    // No real git in these tests (SP4 X7): only test/sessions-changes.test.js runs it.
    ...NO_GIT_OPTIONS,
    ...over
  };
  world.manager = createSessionManager(world.deps);
  return world;
}

// An app on a free local port with `mount`'s routers, and an error handler
// like server/index.js's last one: anything passed on with next(error) answers
// the error's own status (requireAdminWhenPublic's 403), else 500, as
// { ok: false, error: <message> }. `call(method, url, body, headers)` answers
// { status, body }.
async function withApp(mount, fn) {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use((error, _req, res, _next) => res.status(error?.status || 500).json({ ok: false, error: String(error?.message || error) }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, body, headers = {}) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  }
  try {
    return await fn({ base, call });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// The routers as server/index.js mounts them: the setup router behind
// requireAdminWhenPublic (its new routes also carry requireLocalMode
// themselves), the sessions and recordings routers behind requireLocalMode.
function withSetupApp(manager, fn) {
  return withApp((app) => {
    app.use("/api/setup", requireAdminWhenPublic, createSetupRouter({ sessionManager: manager }));
    app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
    app.use("/api/recordings", requireLocalMode, createRecordingsRouter({ manager }));
  }, fn);
}

// `running` holds the pids this test started and has not seen exit; the
// clean-up signals only those (a pid seen exiting may belong to another
// process by now).
function track(running, handle) {
  running.add(handle.pid);
  handle.onExit(() => {
    running.delete(handle.pid);
  });
  return handle;
}

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

// =====================================================================
// 1. The kind's profile and argv rules (profiles.js)
// =====================================================================

function buildSetupProfile(ctx, over = {}) {
  return buildSessionProfile({
    agentId: "openclaw",
    folder: null,
    sessionId: crypto.randomUUID(),
    kind: "setup",
    setupAction: OPENCLAW_SIGNIN_ACTION,
    settings: { claudeFullscreen: false },
    detected: { installed: true, path: path.join(ctx.bin, "openclaw"), version: "OpenClaw 2026.9.7", features: {} },
    agentOsVersion: "9.9.9-test",
    ...over
  });
}

test("profile: the setup kind runs exactly the sign-in argv in HOME, with the H2 environment, no folder shown, no soft stop and no resume", POSIX_ONLY, async () => {
  await withSetupEnv(async (ctx) => {
    const sessionId = crypto.randomUUID();
    const profile = await buildSetupProfile(ctx, {
      sessionId,
      // None of these reaches the setup kind: a folder (the policy would refuse /etc), a resume, the fullscreen opt-in.
      folder: "/etc",
      resume: { agentSessionId: `agentos-${sessionId}` },
      settings: { claudeFullscreen: true }
    });
    assert.equal(profile.command, path.join(ctx.bin, "openclaw"), "the detected openclaw (H1)");
    assert.deepEqual(profile.args, SIGNIN_ARGS);
    assert.notEqual(profile.args, SETUP_ACTIONS[OPENCLAW_SIGNIN_ACTION].args, "a fresh copy, never the table's own array");
    assert.equal(profile.cwd, ctx.home, "HOME, the one other exception to the folder policy");
    assert.equal(profile.folderShown, false);
    assert.equal(profile.softStop, null, "never openclaw-abort: a sign-in has no last step to finish");
    assert.equal(profile.resumeMode, null);
    assert.equal(profile.agentSessionId, null);
    assert.equal(profile.settingsFile, null);
    assert.deepEqual(profile.notes, []);
    const { env } = profile;
    assert.equal(env.HOME, ctx.home, "H1: HOME as the person has it");
    assert.equal(env.PWD, ctx.home);
    assert.equal(env.TERM, "xterm-256color");
    assert.equal(env.TERM_PROGRAM, "AgentOS");
    assert.equal(env.TERM_PROGRAM_VERSION, "9.9.9-test");
    assert.equal(env.AGENT_OS_SESSION_ID, sessionId);
    assert.equal(env.CLAUDE_CODE_NO_FLICKER, undefined, "the fullscreen opt-in is Claude Code's only");
    for (const name of H1_ENV_NAMES) assert.equal(env[name], undefined, `${name} is never set (Safety 4)`);
    assert.deepEqual(Object.keys(env).filter((key) => key.startsWith("OPENCLAW_")), []);
    assert.deepEqual(Object.keys(env).filter((key) => key.startsWith("AGENT_OS_") && key !== "AGENT_OS_SESSION_ID"), []);
    assert.deepEqual([...SETUP_ACTIONS[OPENCLAW_SIGNIN_ACTION].args], SIGNIN_ARGS, "the table is unchanged");
  });
});

test("profile: the setup kind is refused for an unknown action, a prototype name or another agent; an OpenClaw agent session still runs its TUI", POSIX_ONLY, async () => {
  await withSetupEnv(async (ctx) => {
    for (const setupAction of [null, undefined, "", "openclaw-codex-signin", "constructor", "__proto__", "toString", "hasOwnProperty", 42]) {
      await assert.rejects(() => buildSetupProfile(ctx, { setupAction }), isUnknownKind, String(setupAction));
    }
    for (const agentId of ["claude", "codex", "cursor", "hermes"]) {
      await assert.rejects(() => buildSetupProfile(ctx, { agentId }), isUnknownKind, agentId);
    }
    await assert.rejects(() => buildSetupProfile(ctx, { kind: "shell" }), isUnknownKind, "any other kind name is still unknown");
    // The action name never turns an agent session into a sign-in.
    const sessionId = crypto.randomUUID();
    const agent = await buildSetupProfile(ctx, { kind: "agent", sessionId });
    assert.deepEqual(agent.args, ["tui", "--session", `agentos-${sessionId}`]);
    assert.equal(agent.softStop, "openclaw-abort");
  });
});

test("assertSessionArgvSafe: the setup kind accepts only the action's own argv, item by item (Safety 2); an agent session can never run it; two-argument callers are unchanged", () => {
  const signIn = { kind: "setup", setupAction: OPENCLAW_SIGNIN_ACTION };
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  assert.doesNotThrow(() => assertSessionArgvSafe("openclaw", [...SIGNIN_ARGS], signIn));
  const refused = [
    ["openclaw", SIGNIN_ARGS.slice(0, -1), signIn],
    ["openclaw", [...SIGNIN_ARGS, "--device-code"], signIn],
    ["openclaw", ["models", "auth", "login", "--provider", "openai", "--method", "oauth"], signIn],
    ["openclaw", ["models", "auth", "login", "--provider", "openai", "--method", "SIWC"], signIn],
    ["openclaw", ["models", "auth", "setup-token", "--provider", "anthropic"], signIn],
    ["openclaw", ["models", "auth", "paste-token", "--provider", "anthropic"], signIn],
    ["openclaw", ["auth", "models", "login", "--provider", "openai", "--method", "siwc"], signIn],
    ["openclaw", ["tui", "--session", `agentos-${uuid}`], signIn],
    ["openclaw", [], signIn],
    ["openclaw", SIGNIN_ARGS.join(" "), signIn],
    ["hermes", [...SIGNIN_ARGS], signIn],
    ["claude", [...SIGNIN_ARGS], signIn],
    ["constructor", [...SIGNIN_ARGS], signIn],
    ["openclaw", [...SIGNIN_ARGS], { kind: "setup", setupAction: "constructor" }],
    ["openclaw", [...SIGNIN_ARGS], { kind: "setup", setupAction: "__proto__" }],
    ["openclaw", [...SIGNIN_ARGS], { kind: "setup", setupAction: null }],
    ["openclaw", [...SIGNIN_ARGS], { kind: "setup" }],
    // Every other kind keeps today's shapes, so the sign-in argv is never an agent or update session's.
    ["openclaw", [...SIGNIN_ARGS], { kind: "agent", setupAction: OPENCLAW_SIGNIN_ACTION }],
    ["openclaw", [...SIGNIN_ARGS], { kind: "update" }],
    ["openclaw", [...SIGNIN_ARGS], {}],
    ["openclaw", [...SIGNIN_ARGS], undefined]
  ];
  for (const [agentId, args, options] of refused) {
    assert.throws(
      () => assertSessionArgvSafe(agentId, args, options),
      (error) => error.status === 500 && error.code === "unsafe_argv" && /never adds\.$/.test(error.message),
      `${agentId} ${JSON.stringify(args)} ${JSON.stringify(options)}`
    );
  }
  // Two-argument callers keep today's answers.
  assert.doesNotThrow(() => assertSessionArgvSafe("openclaw", ["tui", "--session", `agentos-${uuid}`]));
  assert.throws(() => assertSessionArgvSafe("openclaw", [...SIGNIN_ARGS]), (error) => error.code === "unsafe_argv");
  // The table: one action, frozen all the way down.
  assert.equal(OPENCLAW_SIGNIN_ACTION, "openclaw-chatgpt-signin");
  assert.deepEqual(Object.keys(SETUP_ACTIONS), [OPENCLAW_SIGNIN_ACTION]);
  assert.equal(SETUP_ACTIONS[OPENCLAW_SIGNIN_ACTION].agentId, "openclaw");
  assert.ok(Object.isFrozen(SETUP_ACTIONS));
  assert.ok(Object.isFrozen(SETUP_ACTIONS[OPENCLAW_SIGNIN_ACTION]));
  assert.ok(Object.isFrozen(SETUP_ACTIONS[OPENCLAW_SIGNIN_ACTION].args));
});

// =====================================================================
// 2. The 2026.9.7 version gate
// =====================================================================

test("resolve.js exports parseVersion and versionAtLeast, unchanged: three numbers from a version line, compared as arrays", () => {
  assert.deepEqual(parseVersion("OpenClaw 2026.9.6 (eb377ac)"), [2026, 9, 6]);
  assert.deepEqual(parseVersion("openclaw 9.9.9-fake"), [9, 9, 9]);
  for (const text of ["OpenClaw unknown", "OpenClaw 2026.9", "", null, undefined]) assert.equal(parseVersion(text), null, String(text));
  assert.equal(versionAtLeast([2026, 9, 6], [2026, 9, 7]), false);
  assert.equal(versionAtLeast([2026, 9, 7], [2026, 9, 7]), true);
  assert.equal(versionAtLeast([2026, 10, 1], [2026, 9, 7]), true);
  assert.equal(versionAtLeast([2027, 0, 0], [2026, 9, 7]), true);
  assert.equal(versionAtLeast([2025, 12, 31], [2026, 9, 7]), false);
});

test("openclawVersionInfo: the three numbers of OpenClaw's version line against 2026.9.7, and null when OpenClaw is missing or its line holds no version", () => {
  assert.equal(OPENCLAW_SIGNIN_MIN_VERSION, "2026.9.7");
  assert.equal(OPENCLAW_TOO_OLD_MESSAGE, "Update OpenClaw first: its ChatGPT sign-in needs version 2026.9.7 or newer.");
  assert.equal(OPENCLAW_VERSION_UNKNOWN_MESSAGE, "Agent OS couldn't read OpenClaw's version.");
  const installed = (version) => ({ installed: true, path: "/fake/bin/openclaw", version, features: {} });
  const unread = { have: null, need: "2026.9.7", newEnough: null };
  const cases = [
    [installed("OpenClaw 2026.9.6 (eb377ac)"), { have: "2026.9.6", need: "2026.9.7", newEnough: false }],
    [installed("OpenClaw 2026.9.7"), { have: "2026.9.7", need: "2026.9.7", newEnough: true }],
    [installed("OpenClaw 2026.10.1"), { have: "2026.10.1", need: "2026.9.7", newEnough: true }],
    [installed("openclaw 9.9.9-fake"), { have: "9.9.9", need: "2026.9.7", newEnough: false }],
    [installed("OpenClaw unknown"), unread],
    [installed("OpenClaw 2026.9"), unread],
    [installed(""), unread],
    [{ installed: false, path: "", version: "OpenClaw 2026.9.7", features: {} }, unread],
    [undefined, unread],
    [null, unread]
  ];
  for (const [detected, expected] of cases) assert.deepEqual(openclawVersionInfo(detected), expected, JSON.stringify(detected));
});

// =====================================================================
// 3. The manager, with injected fakes
// =====================================================================

test("createSetupSession: one sign-in in memory only, in HOME, with the action's argv: not gated by Safety, no folder check, no brain, no session folder, no meta.json, no recording", async () => {
  await withSetupEnv(
    async ({ home, agentOsHome }) => {
      const world = fakeWorld();
      world.gate = false; // Look only: a sign-in is a Setup step, not agent work (spec §1, Limits)
      const summary = await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      assert.match(summary.id, UUID);
      assert.deepEqual(Object.keys(summary).sort(), [...SUMMARY_KEYS].sort(), "the same 30 keys as every session, and no new one");
      assert.deepEqual(
        { ...summary, id: "-", stateSince: "-", startedAt: "-" },
        {
          id: "-",
          kind: "setup",
          agentId: "openclaw",
          agentLabel: "OpenClaw",
          folder: home,
          folderName: path.basename(home),
          folderShown: false,
          branch: null,
          status: "starting",
          stateSince: "-",
          startedAt: "-",
          endedAt: null,
          exitCode: null,
          signal: null,
          endedBy: null,
          dismissed: false,
          brain: null,
          resume: { available: false, reason: null, fallback: false },
          nothingToResume: false,
          alerts: "basic",
          alert: null,
          idleBy: null,
          resetAt: null,
          trustNeeded: false,
          hooksOff: { alerts: null, meter: null },
          meter: null,
          copyOf: null,
          handoff: null,
          keepGoingFailure: null,
          recordingBytes: 0
        }
      );
      assert.deepEqual(world.profileInputs, [
        {
          agentId: "openclaw",
          folder: null,
          sessionId: summary.id,
          kind: "setup",
          setupAction: OPENCLAW_SIGNIN_ACTION,
          settings: { claudeFullscreen: false },
          detected: DETECTED
        }
      ]);
      assert.equal(world.ptys.length, 1);
      assert.deepEqual(world.ptys[0].opts.args, SIGNIN_ARGS);
      assert.equal(world.ptys[0].opts.cwd, home);
      assert.deepEqual(world.detectCalls, [], "the route's fresh detection is used as it is");
      assert.equal(world.folderChecks, 0, "HOME is not put through the folder policy");
      assert.equal(world.recorderCalls, 0, "the recorder factory is never called");
      assert.deepEqual(world.writes, [], "no meta.json");
      assert.deepEqual(await sessionFolders(agentOsHome), [], "no session folder");
      assert.equal((await world.manager.liveSetupSession()).id, summary.id);

      // Without a detection of its own, the manager detects OpenClaw itself.
      await world.manager.stop(summary.id);
      await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION });
      assert.deepEqual(world.detectCalls, ["openclaw"]);
      assert.equal(world.profileInputs[1].detected.path, "/fake/bin/openclaw");
    },
    { fakes: false }
  );
});

test("one sign-in at a time: a second start gets 409 setup_running with the first one's id and action, while it is still starting and once it runs; it never takes one of the 8 places", async () => {
  await withSetupEnv(
    async ({ project }) => {
      const world = fakeWorld({ maxLive: 1 });
      const start = () => world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      let release;
      world.spawnGate = new Promise((resolve) => {
        release = resolve;
      });
      const first = start();
      await waitFor(() => world.spawnCalls === 1);

      const whileStarting = await start().then(
        () => null,
        (error) => error
      );
      assert.equal(whileStarting?.status, 409);
      assert.equal(whileStarting.code, "setup_running");
      assert.match(whileStarting.extra.sessionId, UUID);
      assert.deepEqual(errorBody(whileStarting), {
        error: "setup_running",
        message: SETUP_RUNNING,
        sessionId: whileStarting.extra.sessionId,
        setupAction: OPENCLAW_SIGNIN_ACTION
      });
      assert.equal(await world.manager.liveSetupSession(), null, "a start still before its spawn is not live yet");

      // The limit (1 here, 8 in Agent OS) does not count the sign-in: an agent session still starts...
      await world.manager.create({ agentId: "claude", folder: project });
      release();
      const summary = await first;
      assert.equal(summary.id, whileStarting.extra.sessionId, "the 409 named the very session that was starting");

      const whileLive = await start().then(
        () => null,
        (error) => error
      );
      assert.deepEqual(errorBody(whileLive), {
        error: "setup_running",
        message: SETUP_RUNNING,
        sessionId: summary.id,
        setupAction: OPENCLAW_SIGNIN_ACTION
      });
      assert.equal((await world.manager.liveSetupSession()).id, summary.id);
      // ... while the limit still holds for agent sessions.
      await assert.rejects(
        world.manager.create({ agentId: "codex", folder: project }),
        (error) => error.status === 409 && error.code === "too_many_sessions"
      );
      const signIns = world.ptys.filter((pty) => pty.opts.args.join(" ") === SIGNIN_ARGS.join(" "));
      assert.equal(signIns.length, 1, "the refused starts spawned nothing");
    },
    { fakes: false }
  );
});

test("an unknown action is refused before anything starts; a terminal module that can't load answers 503; neither leaves the one place taken", async () => {
  await withSetupEnv(
    async () => {
      const world = fakeWorld();
      for (const action of ["", "openclaw-codex-signin", "constructor", "__proto__", "toString", "hasOwnProperty", undefined, null, 42, [OPENCLAW_SIGNIN_ACTION]]) {
        await assert.rejects(world.manager.createSetupSession({ action, detected: DETECTED }), isUnknownKind, String(action));
      }
      await assert.rejects(world.manager.createSetupSession(), isUnknownKind, "no options at all");
      assert.equal(world.spawnCalls, 0);
      world.pty = { ok: false, reason: "test: no terminal module" };
      await assert.rejects(
        world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED }),
        (error) => error.status === 503 && error.code === "pty_unavailable" && error.message === PTY_MESSAGE
      );
      assert.equal(world.spawnCalls, 0);
      world.pty = { ok: true, reason: null };
      const summary = await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      assert.equal(summary.kind, "setup", "no refusal left the place taken");
    },
    { fakes: false }
  );
});

test("lists and the quit question: a sign-in is left out of the default list and the quit check, listed with kind=all (live only too), and found by get while it runs", async () => {
  await withSetupEnv(
    async ({ project }) => {
      const world = fakeWorld();
      const agent = await world.manager.create({ agentId: "claude", folder: project });
      const setup = await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      assert.deepEqual(
        (await world.manager.list()).map((summary) => summary.id),
        [agent.id],
        "not a Sessions tab, not on Home, not in the menu's count"
      );
      assert.deepEqual(
        (await world.manager.list({ includeUpdate: true })).map((summary) => `${summary.kind}:${summary.id}`).sort(),
        [`agent:${agent.id}`, `setup:${setup.id}`].sort()
      );
      assert.deepEqual(
        (await world.manager.list({ includeUpdate: true, liveOnly: true })).map((summary) => summary.kind).sort(),
        ["agent", "setup"],
        "Hold to stop all's list"
      );
      assert.deepEqual((await world.manager.quitCheck()).live, [{ id: agent.id, title: "Claude Code · demo", kind: "agent" }]);
      assert.equal((await world.manager.get(setup.id)).kind, "setup");
      assert.equal(world.manager.isLive(setup.id), true);
    },
    { fakes: false }
  );
});

test("when a sign-in ends: its mirror is disposed at once, nothing is written or recorded, and it is gone: get, Stop, Resume and Dismiss answer 404, a window can't attach, and the recording cap does not run", async () => {
  await withSetupEnv(
    async ({ agentOsHome }) => {
      const world = fakeWorld();
      const setup = await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      const [pty] = world.ptys;
      const [mirror] = world.mirrors;
      const frames = [];
      const closes = [];
      await world.manager.attach(setup.id, { id: "card", send: (frame) => frames.push(frame), close: (reason) => closes.push(reason) });
      pty.emit(`Code: ${CODE}\r\n`);
      pty.exit(0);
      // In the same step as the exit: there is nothing to close or write first.
      assert.equal(mirror.disposed, true, "the mirror is disposed when it ends");
      assert.equal(world.manager.isLive(setup.id), false, "the sessions WebSocket refuses a new window (ws.js asks isLive)");
      assert.deepEqual(frames.at(-1), { t: "state", status: "exited", exitCode: 0, signal: null, endedBy: null });
      assert.deepEqual(closes, ["session_ended"]);
      await assert.rejects(world.manager.get(setup.id), isUnknownSession);
      await assert.rejects(world.manager.stop(setup.id), isUnknownSession);
      await assert.rejects(world.manager.resume(setup.id), isUnknownSession);
      await assert.rejects(world.manager.dismiss(setup.id), isUnknownSession);
      await assert.rejects(world.manager.attach(setup.id, { id: "late", send() {}, close() {} }), isUnknownSession);
      assert.equal(await world.manager.liveSetupSession(), null);
      assert.equal(world.recorderCalls, 0);
      assert.deepEqual(world.writes, []);
      assert.equal(world.capCalls, 0, "no recording, so no cap run");
      assert.deepEqual(await sessionFolders(agentOsHome), []);
      // A new sign-in can start at once.
      assert.equal((await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED })).kind, "setup");
    },
    { fakes: false }
  );
});

test("a sign-in's input is a byte pipe: the writer's bytes reach the PTY as they are and are never scanned (no activity from input); a viewer can't type; resize reaches the PTY and no recorder", async () => {
  await withSetupEnv(
    async ({ project }) => {
      const world = fakeWorld();
      const agent = await world.manager.create({ agentId: "claude", folder: project }); // the control
      const setup = await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      const setupPty = world.ptys.find((pty) => pty.opts.args.join(" ") === SIGNIN_ARGS.join(" "));
      for (const id of [agent.id, setup.id]) {
        await world.manager.attach(id, { id: "w", send() {}, close() {} });
        assert.equal(world.manager.focus(id, "w"), true);
      }
      assert.equal(world.manager.write(agent.id, "w", "a"), true);
      assert.equal((await world.manager.get(agent.id)).status, "live", "control: a key wakes an agent session");

      assert.equal(world.manager.write(setup.id, "w", `${CODE}\r`), true);
      assert.deepEqual(setupPty.writes, [`${CODE}\r`], "the bytes reach the PTY as they are");
      assert.equal((await world.manager.get(setup.id)).status, "starting", "input is never scanned, so typing is not activity");

      await world.manager.attach(setup.id, { id: "viewer", send() {}, close() {} });
      assert.equal(world.manager.write(setup.id, "viewer", "x"), false, "only the writer types");
      assert.deepEqual(setupPty.writes, [`${CODE}\r`]);

      assert.equal(world.manager.resize(setup.id, "w", 100, 30), true);
      assert.deepEqual(setupPty.resizes, [[100, 30]]);
      assert.equal(world.recorderCalls, 1, "only the agent session's recorder was ever made");

      setupPty.emit("Signed in.\r\n");
      assert.equal((await world.manager.get(setup.id)).status, "live", "its activity comes from its output");
    },
    { fakes: false }
  );
});

test("Stop with no window attached, and quitting: a sign-in stops like any session, with no soft stop and no note; shutdownAll stops it and writes no meta.json for it", async () => {
  await withSetupEnv(
    async ({ agentOsHome, project }) => {
      const world = fakeWorld();
      const setup = await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      const stopped = await world.manager.stop(setup.id);
      assert.equal(stopped.id, setup.id);
      assert.equal(stopped.kind, "setup");
      assert.equal(stopped.status, "exited");
      assert.equal(stopped.endedBy, "stop");
      assert.equal(stopped.signal, "SIGTERM");
      assert.equal(stopped.note, null, "never OpenClaw's 'last step' note: a sign-in has none");
      assert.deepEqual(world.softStops.map((input) => input.softStop), [null], "no soft stop");
      assert.deepEqual(world.kills.map(([, options]) => options), [{ graceMs: 3000 }], "the process tree, as every Stop");
      assert.equal(world.manager.isLive(setup.id), false);

      // Quitting Agent OS (the "sessions" shutdown task): both kinds stop; only the agent session's meta.json is written.
      const again = await world.manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION, detected: DETECTED });
      const agent = await world.manager.create({ agentId: "claude", folder: project });
      world.writes.length = 0;
      assert.deepEqual(await world.manager.shutdownAll({ reason: "quit" }), { stopped: 2 });
      assert.equal(world.manager.isLive(again.id), false);
      assert.equal(world.manager.isLive(agent.id), false);
      assert.ok(world.writes.some((file) => file.includes(agent.id)), "control: the agent session's meta.json says it ended by quit");
      assert.deepEqual(world.writes.filter((file) => file.includes(again.id)), [], "no meta.json for the sign-in");
      assert.deepEqual(await sessionFolders(agentOsHome), [agent.id], "only the agent session has a folder");
      assert.deepEqual((await world.manager.quitCheck()).live, []);
    },
    { fakes: false }
  );
});

// =====================================================================
// 4. POST and GET /api/setup/openclaw/signin-terminal, in process
// =====================================================================

test("outside local mode nothing starts: the public demo and an admin request get 404 not_available before anything else, a request without the admin token gets index.js's 403 first; POST needs { confirm: true }", async () => {
  await withSetupEnv(
    async () => {
      const world = fakeWorld();
      await withSetupApp(world.manager, async ({ call }) => {
        for (const body of [undefined, {}, { confirm: "true" }, { confirm: 1 }, { confirm: false }]) {
          assert.deepEqual(
            await call("POST", SIGNIN_PATH, body),
            { status: 400, body: { ok: false, error: "confirm must be true" } },
            JSON.stringify(body)
          );
        }
        // The public demo: requireAdminWhenPublic lets every request through, and requireLocalMode answers.
        for (const vars of [{ DEMO_PUBLIC: "1" }, { HERMES_AGENT_OS_DEMO_PUBLIC: "1" }]) {
          await withEnv(vars, async () => {
            assert.deepEqual(await call("POST", SIGNIN_PATH, { confirm: true }), NOT_AVAILABLE, JSON.stringify(vars));
            assert.deepEqual(await call("POST", SIGNIN_PATH, {}), NOT_AVAILABLE, "local mode is checked before the body");
            assert.deepEqual(await call("GET", SIGNIN_PATH), NOT_AVAILABLE);
          });
        }
        // The admin-token public mode: index.js's requireAdminWhenPublic refuses a request without the admin
        // token first (403); an admin request reaches requireLocalMode and gets 404 not_available.
        for (const mode of [{ HERMES_AGENT_OS_PUBLIC_MODE: "1" }, { HERMES_AGENT_OS_REQUIRE_AUTH: "1" }]) {
          await withEnv({ ...mode, HERMES_AGENT_OS_ADMIN_TOKEN: ADMIN_TOKEN }, async () => {
            assert.deepEqual(await call("POST", SIGNIN_PATH, { confirm: true }), ADMIN_REFUSED, JSON.stringify(mode));
            assert.deepEqual(await call("GET", SIGNIN_PATH), ADMIN_REFUSED, JSON.stringify(mode));
            assert.deepEqual(await call("POST", SIGNIN_PATH, { confirm: true }, AS_ADMIN), NOT_AVAILABLE, `${JSON.stringify(mode)}, admin`);
            assert.deepEqual(await call("POST", SIGNIN_PATH, {}, AS_ADMIN), NOT_AVAILABLE, "local mode is checked before the body");
            assert.deepEqual(await call("GET", SIGNIN_PATH, undefined, AS_ADMIN), NOT_AVAILABLE);
          });
        }
        assert.equal(world.spawnCalls, 0, "nothing started");
        assert.deepEqual(await call("GET", SIGNIN_PATH), { status: 200, body: { session: null } });
      });
    },
    { fakes: false }
  );
});

test("POST signin-terminal reads OpenClaw's version fresh each time, never the 30 s detection cache: too old and unreadable are refused with their sentences, 2026.9.7 or newer starts the sign-in (201)", POSIX_ONLY, async () => {
  await withSetupEnv(async ({ home, bin }) => {
    const world = fakeWorld();
    await withSetupApp(world.manager, async ({ call }) => {
      const post = () => call("POST", SIGNIN_PATH, { confirm: true });
      // No knob: W1's fake prints "openclaw 9.9.9-fake", older than 2026.9.7 (the default stays too old).
      assert.deepEqual(await post(), TOO_OLD);
      await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.6 (eb377ac)");
      assert.deepEqual(await post(), TOO_OLD);
      await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw unknown");
      assert.deepEqual(await post(), VERSION_UNKNOWN);
      assert.equal(world.spawnCalls, 0, "a refused version starts nothing");

      // Review Focus 1: OpenClaw is updated while the card is open. Detection's 30 s cache still holds
      // 2026.9.6 when the person presses Sign in with ChatGPT again a moment later.
      await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.6 (eb377ac)");
      assert.equal((await ADAPTERS.openclaw.detect({ refresh: true })).version, "OpenClaw 2026.9.6 (eb377ac)");
      await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.7");
      assert.equal((await ADAPTERS.openclaw.detect()).version, "OpenClaw 2026.9.6 (eb377ac)", "the cache still says 2026.9.6");
      const started = await post();
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.deepEqual(Object.keys(started.body), ["session"]);
      assert.equal(started.body.session.kind, "setup");
      assert.equal(started.body.session.agentId, "openclaw");
      assert.equal(started.body.session.folderShown, false);
      const input = world.profileInputs.at(-1);
      assert.equal(input.detected.version, "OpenClaw 2026.9.7", "the manager got the fresh detection");
      assert.equal(input.detected.path, path.join(bin, "openclaw"));
      assert.equal(input.setupAction, OPENCLAW_SIGNIN_ACTION);
      assert.deepEqual(world.detectCalls, [], "the manager never falls back to its own (cached) detection here");
      assert.equal((await call("GET", SIGNIN_PATH)).body.session.id, started.body.session.id);

      await world.manager.stop(started.body.session.id);
      await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.10.1");
      assert.equal((await post()).status, 201, "newer is fine too");
    });
  });
});

test("POST signin-terminal: OpenClaw missing is refused with the sessions sentence (409 agent_not_installed) before its version is looked at", async () => {
  await withSetupEnv(
    async () => {
      const world = fakeWorld();
      const original = ADAPTERS.openclaw.detect;
      const asked = [];
      // A stand-in detection: "not found" is never left to the real lookup, which also searches
      // /opt/homebrew/bin and /usr/local/bin, where a real OpenClaw may live.
      ADAPTERS.openclaw.detect = async (options) => {
        asked.push(options);
        return {
          installed: false,
          path: "",
          version: "OpenClaw 2026.9.7",
          features: {},
          error: "openclaw was not found on PATH or in common install locations."
        };
      };
      try {
        await withSetupApp(world.manager, async ({ call }) => {
          assert.deepEqual(await call("POST", SIGNIN_PATH, { confirm: true }), {
            status: 409,
            body: { error: "agent_not_installed", message: OPENCLAW_MISSING }
          });
        });
      } finally {
        ADAPTERS.openclaw.detect = original;
      }
      assert.deepEqual(asked, [{ refresh: true }], "one fresh detection");
      assert.equal(world.spawnCalls, 0);
    },
    { fakes: false }
  );
});

test("one sign-in at a time over HTTP (Review Focus 2): a second POST answers 409 with the first one's id while it starts and while it runs; GET finds it with no window attached; Close (Stop) works with no window; a 503 frees the place; POST /api/sessions never makes one", POSIX_ONLY, async () => {
  await withSetupEnv(async ({ home }) => {
    await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.7");
    const world = fakeWorld();
    await withSetupApp(world.manager, async ({ call }) => {
      let release;
      world.spawnGate = new Promise((resolve) => {
        release = resolve;
      });
      const firstPost = call("POST", SIGNIN_PATH, { confirm: true });
      await waitFor(() => world.spawnCalls === 1);

      const whileStarting = await call("POST", SIGNIN_PATH, { confirm: true });
      assert.equal(whileStarting.status, 409);
      assert.deepEqual(Object.keys(whileStarting.body).sort(), ["error", "message", "sessionId", "setupAction"]);
      assert.equal(whileStarting.body.error, "setup_running");
      assert.equal(whileStarting.body.message, SETUP_RUNNING);
      assert.equal(whileStarting.body.setupAction, OPENCLAW_SIGNIN_ACTION);
      assert.match(whileStarting.body.sessionId, UUID);
      assert.deepEqual(await call("GET", SIGNIN_PATH), { status: 200, body: { session: null } }, "still starting: nothing to attach to yet");

      release();
      const first = await firstPost;
      assert.equal(first.status, 201);
      assert.equal(first.body.session.id, whileStarting.body.sessionId, "the 409 named the session that was starting");

      const whileLive = await call("POST", SIGNIN_PATH, { confirm: true });
      assert.deepEqual(whileLive, {
        status: 409,
        body: { error: "setup_running", message: SETUP_RUNNING, sessionId: first.body.session.id, setupAction: OPENCLAW_SIGNIN_ACTION }
      });
      // Found again with no window attached (the card was closed, the page left or reloaded).
      assert.equal((await call("GET", SIGNIN_PATH)).body.session.id, first.body.session.id);
      assert.equal(world.ptys.length, 1, "the refused starts spawned nothing");

      // Close: the card stops it through the sessions route, with no window attached.
      const stopped = await call("POST", `/api/sessions/${first.body.session.id}/stop`, {});
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.status, "exited");
      assert.equal(stopped.body.endedBy, "stop");
      assert.equal(stopped.body.note, null);
      assert.deepEqual(await call("GET", SIGNIN_PATH), { status: 200, body: { session: null } });
      assert.deepEqual(await call("GET", `/api/sessions/${first.body.session.id}`), { status: 404, body: UNKNOWN_SESSION });

      // The terminal module can't load: 503 with the manager's sentence, and the place is free again after.
      world.pty = { ok: false, reason: "test: no terminal module" };
      assert.deepEqual(await call("POST", SIGNIN_PATH, { confirm: true }), {
        status: 503,
        body: { error: "pty_unavailable", message: PTY_MESSAGE }
      });
      world.pty = { ok: true, reason: null };
      const next = await call("POST", SIGNIN_PATH, { confirm: true });
      assert.equal(next.status, 201);
      assert.notEqual(next.body.session.id, first.body.session.id);

      // Spec §1: only this route makes a setup session. POST /api/sessions takes only agentId and folder from
      // its body, so a kind and an action sent there start an ordinary OpenClaw agent session.
      const viaSessions = await call("POST", "/api/sessions", {
        agentId: "openclaw",
        folder: null,
        kind: "setup",
        setupAction: OPENCLAW_SIGNIN_ACTION
      });
      assert.equal(viaSessions.status, 201, JSON.stringify(viaSessions.body));
      assert.equal(viaSessions.body.kind, "agent");
      assert.equal(world.profileInputs.at(-1).kind, "agent");
      assert.ok(!("setupAction" in world.profileInputs.at(-1)), "no action reaches the profile");
      assert.equal((await call("POST", `/api/sessions/${viaSessions.body.id}/stop`, {})).status, 200);
      assert.equal((await call("GET", SIGNIN_PATH)).body.session.id, next.body.session.id, "the sign-in is still the one running");
    });
  });
});

test("POST signin-terminal looks for a running or starting sign-in first: a second POST answers 409 setup_running at once and runs no openclaw --version", POSIX_ONLY, async () => {
  await withSetupEnv(async ({ home, log }) => {
    await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.7");
    const world = fakeWorld();
    // How many times OpenClaw was asked its version: W1's fake logs each quick answer as a "probe".
    const versionReads = async () =>
      (await readFakeLog(log)).filter((entry) => entry.event === "probe" && entry.name === "openclaw" && entry.argv.join(" ") === "--version").length;
    await withSetupApp(world.manager, async ({ call }) => {
      let release;
      world.spawnGate = new Promise((resolve) => {
        release = resolve;
      });
      const firstPost = call("POST", SIGNIN_PATH, { confirm: true });
      firstPost.catch(() => {}); // a failed assertion below must show itself, not this request closing with the server
      await waitFor(() => world.spawnCalls === 1);
      const readByFirst = await versionReads();
      assert.ok(readByFirst >= 1, "the first POST read the version fresh, before its sign-in was reserved");

      // While the first one is still starting (reserved, not yet running).
      const whileStarting = await call("POST", SIGNIN_PATH, { confirm: true });
      assert.equal(whileStarting.status, 409);
      assert.deepEqual(Object.keys(whileStarting.body).sort(), ["error", "message", "sessionId", "setupAction"]);
      assert.equal(whileStarting.body.error, "setup_running");
      assert.equal(whileStarting.body.message, SETUP_RUNNING);
      assert.equal(whileStarting.body.setupAction, OPENCLAW_SIGNIN_ACTION);
      assert.match(whileStarting.body.sessionId, UUID);
      assert.equal(await versionReads(), readByFirst, "the 409 came before any new openclaw --version");

      release();
      const first = await firstPost;
      assert.equal(first.status, 201);
      assert.equal(first.body.session.id, whileStarting.body.sessionId, "the 409 named the session that was starting");

      // While it runs.
      const whileLive = await call("POST", SIGNIN_PATH, { confirm: true });
      assert.deepEqual(whileLive, {
        status: 409,
        body: { error: "setup_running", message: SETUP_RUNNING, sessionId: first.body.session.id, setupAction: OPENCLAW_SIGNIN_ACTION }
      });
      assert.equal(await versionReads(), readByFirst, "no openclaw --version for the second refusal either");
      assert.equal(world.ptys.length, 1, "the refused starts spawned nothing");

      // The order after the check is unchanged: once it is stopped, the next POST reads the version again, then starts.
      assert.equal((await call("POST", `/api/sessions/${first.body.session.id}/stop`, {})).status, 200);
      const next = await call("POST", SIGNIN_PATH, { confirm: true });
      assert.equal(next.status, 201, JSON.stringify(next.body));
      assert.equal(await versionReads(), readByFirst + 1, "a free place reads the version fresh again");
    });
  });
});

// =====================================================================
// 5. One real sign-in in a PTY, against W1's fake `openclaw`
// =====================================================================

test("a real sign-in in a PTY against W1's fake: the link and the code are shown, the typed line reaches the program, it signs in and ends, and nothing is kept (Safety 5)", POSIX_ONLY, async () => {
  await withSetupEnv(async ({ home, agentOsHome, log }) => {
    await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.7");
    const running = new Set();
    const mirrors = [];
    let disposeCalls = 0;
    let recorderCalls = 0;
    // The real manager, PTY, mirror, login shell and profile. Only the spawn is tracked (for the clean-up),
    // the mirror's dispose is counted, and a recorder that is ever asked for fails the start.
    const manager = createSessionManager({
      ...NO_GIT_OPTIONS,
      spawn: async (options) => track(running, await spawnPty(options)),
      mirrorFactory: (options) => {
        const real = createMirror(options);
        mirrors.push(real);
        return {
          ...real,
          dispose() {
            disposeCalls += 1;
            return real.dispose();
          }
        };
      },
      recorderFactory: () => {
        recorderCalls += 1;
        throw new Error("a setup session must never be recorded");
      }
    });
    try {
      await withSetupApp(manager, async ({ call }) => {
        const started = await call("POST", SIGNIN_PATH, { confirm: true });
        assert.equal(started.status, 201, JSON.stringify(started.body));
        const { session } = started.body;
        assert.equal(session.kind, "setup");
        assert.equal(session.folder, home);
        assert.equal(session.folderShown, false);
        assert.equal(session.recordingBytes, 0);
        const { id } = session;
        assert.equal((await call("GET", SIGNIN_PATH)).body.session.id, id);

        // Listed only with kind=all (Hold to stop all's list), never as a tab or in the quit question.
        assert.deepEqual((await call("GET", "/api/sessions")).body.sessions, []);
        assert.deepEqual(
          (await call("GET", "/api/sessions?kind=all")).body.sessions.map((item) => `${item.kind}:${item.id}`),
          [`setup:${id}`]
        );
        assert.deepEqual((await call("GET", "/api/sessions?kind=all&live=1")).body.sessions.map((item) => item.id), [id]);
        assert.deepEqual(await call("POST", "/api/sessions/quit-check", {}), { status: 200, body: { live: [] } });

        // The card's window, in process: the manager's attach, focus and write, which ws.js calls for every
        // window, and the frames ws.js would send. The upgrade itself is ws.js's and unchanged: it asks isLive,
        // and test/sessions-ws.test.js covers its 403 for an ended or unknown session.
        const frames = [];
        const closes = [];
        await manager.attach(id, { id: "card", send: (frame) => frames.push(frame), close: (reason) => closes.push(reason) });
        assert.equal(manager.focus(id, "card"), true);
        const screen = () => frames.map((frame) => (frame.t === "snapshot" ? frame.data : frame.t === "out" ? frame.d : "")).join("");
        await waitFor(() => screen().includes("Press Enter after you approve in your browser."));
        assert.ok(screen().includes(`Sign in with ChatGPT: ${LINK}`), "the sign-in link is on screen");
        assert.ok(screen().includes(`Code: ${CODE}`), "and the one-time code");

        assert.equal(manager.write(id, "card", `${TYPED}\r`), true);
        await waitFor(() => screen().includes("Signed in."));
        await waitFor(() => !manager.isLive(id));
        assert.deepEqual(frames.at(-1), { t: "state", status: "exited", exitCode: 0, signal: null, endedBy: null });
        assert.deepEqual(closes, ["session_ended"]);
        assert.deepEqual(
          (await readFakeAgentState(home)).authRows,
          [fakeSiwcProfile()],
          "the program signed in (the fake saved its row, as OpenClaw saves the profile)"
        );

        // Gone at once, and nothing kept.
        assert.equal(disposeCalls, 1, "the mirror was disposed when it ended");
        assert.equal((await mirrors[0].snapshot()).data, "", "so no screen of it is ever served");
        assert.equal(recorderCalls, 0, "no recorder was ever made");
        assert.deepEqual(await call("GET", `/api/sessions/${id}`), { status: 404, body: UNKNOWN_SESSION });
        assert.deepEqual(await call("POST", `/api/sessions/${id}/stop`, {}), { status: 404, body: UNKNOWN_SESSION });
        assert.deepEqual(await call("GET", SIGNIN_PATH), { status: 200, body: { session: null } });
        assert.equal(manager.isLive(id), false, "the sessions WebSocket refuses a new window with a bare 403 (ws.js asks isLive)");
        await assert.rejects(manager.attach(id, { id: "late", send() {}, close() {} }), isUnknownSession);
        const recordings = await call("GET", "/api/recordings");
        assert.equal(recordings.status, 200);
        assert.deepEqual(recordings.body.recordings, [], "never in Runs' session recordings");
        assert.deepEqual(await sessionFolders(agentOsHome), [], "no session folder, so startup recovery never sees it");
        const kept = await filesUnder(agentOsHome);
        assert.deepEqual(kept.filter((file) => file.endsWith(".cast") || path.basename(file) === "meta.json"), []);
        for (const file of kept) {
          const text = await readFile(file, "utf8").catch(() => "");
          for (const secret of [CODE, TYPED, LINK]) assert.ok(!text.includes(secret), `${file} holds nothing of the sign-in`);
        }

        // The program ran in HOME with exactly the sign-in argv, in a real terminal.
        const start = (await readFakeLog(log)).find((entry) => entry.event === "start" && entry.name === "openclaw");
        assert.deepEqual(start.argv, SIGNIN_ARGS);
        assert.equal(start.cwd, home);
        assert.equal(start.isTTY, true);
      });
    } finally {
      await manager.shutdownAll({ reason: "quit" });
      killLeftovers(running);
    }
  });
});
