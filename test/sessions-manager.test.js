// The session manager (SP3, Task S6): lifecycle, meta.json, the limit, the
// Look only gate, activity states, writer and viewer windows with flow
// control, the update kind, resume rules, dismiss and recovery. Most tests
// drive the manager with injected fakes, so no process starts at all; the last
// two start the TUI-like fake agents from test/helpers/fake-agents.js in a
// real PTY. No real agent ever starts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as sessionErrors from "../server/runtime/sessions/errors.js";
import { recentSessionFolders } from "../server/runtime/sessions/folders.js";
import {
  CLOSE_LAG_BYTES,
  IDLE_AFTER_MS,
  MAX_INPUT_BYTES,
  PAUSED_DROP_MS,
  PAUSE_LAG_BYTES,
  SESSION_AGENT_LABEL,
  SESSION_ID_RE,
  createSessionManager,
  getSessionManager,
  isSessionId,
  readGitBranch,
  sessionError
} from "../server/runtime/sessions/manager.js";
import { SESSION_AGENT_LABEL as PROFILE_AGENT_LABEL } from "../server/runtime/sessions/profiles.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { createRecorder, enforceRecordingCap } from "../server/runtime/sessions/recorder.js";
import { HELD_CHECK_MS, MARKERS_MAX, TURN_DONE_BACKSTOP_MS } from "../server/runtime/sessions/signals.js";
import { RUNTIME_VERSION, writeJson } from "../server/runtime/store.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const isWindows = process.platform === "win32";
const SKIP_POSIX = { skip: isWindows ? "the fake agents are POSIX shell shims" : false };
// Node's own folder is left out on purpose: it can hold real agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const CLAUDE_UUID = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
const T0 = Date.parse("2026-10-14T09:00:00.000Z");
const FALLBACK_AGENTS = new Set(["hermes", "codex", "cursor"]);
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
  "recordingBytes"
];
const FAKE_MODES = {
  altScreen: false,
  bracketedPaste: false,
  mouseTracking: false,
  mouseEncoding: "default",
  focusReporting: false,
  cursorKeysApp: false,
  kittyFlags: 0
};

// A temp HOME (with two project folders and an empty fake-bin folder for the
// real-PTY tests in it) and a separate temp AGENT_OS_HOME, both canonical
// paths, and a clean environment: SHELL is W1's stand-in login shell (never
// a real one), and PATH is the fake bin plus the system folders only.
// Restored after.
async function withSessionEnv(fn) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-sessions-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-sessions-data-")));
  const project = path.join(home, "projects", "demo");
  const other = path.join(home, "projects", "other");
  const bin = path.join(home, "fake-bin");
  await mkdir(project, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(bin, { recursive: true });
  const vars = {
    HOME: home,
    USERPROFILE: home,
    AGENT_OS_HOME: agentOsHome,
    AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
    HERMES_AGENT_OS_HOME: undefined,
    HERMES_HOME: undefined,
    HERMES_AGENT_OS_ENABLE_EXEC: undefined,
    SHELL: FAKE_LOGIN_SHELL,
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter)
  };
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    assert.equal(os.homedir(), home, "tests must never see the real home folder");
    return await fn({ home, agentOsHome, project, other, bin });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
  }
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

async function metaOnDisk(agentOsHome, id) {
  try {
    return JSON.parse(await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

// Waits until meta.json holds at least `count` markers. It polls with
// setImmediate, not setTimeout, because the activity tests replace setTimeout
// with Node's mock timers. Every test that makes an alert waits for its marker,
// so no meta.json write is still running when the temp folders are removed.
async function markersOnDisk(agentOsHome, id, count) {
  for (let i = 0; i < 5000; i += 1) {
    const meta = await metaOnDisk(agentOsHome, id);
    if ((meta?.markers?.length ?? 0) >= count) return meta.markers;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`meta.json never held ${count} markers`);
}

// ---- injected fakes -----------------------------------------------------------------------------

function fakePty(pid, options) {
  const dataListeners = new Set();
  const exitListeners = new Set();
  const pty = {
    pid,
    opts: options,
    writes: [],
    resizes: [],
    kills: [],
    paused: false,
    pauseCalls: 0,
    resumeCalls: 0,
    write(data) {
      pty.writes.push(data);
    },
    resize(cols, rows) {
      pty.resizes.push([cols, rows]);
    },
    kill(signal = "SIGTERM") {
      pty.kills.push(signal);
    },
    pause() {
      pty.paused = true;
      pty.pauseCalls += 1;
    },
    resume() {
      pty.paused = false;
      pty.resumeCalls += 1;
    },
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

// snapshot() captures the screen when it is called (the barrier the real
// mirror keeps) and can be held open with snapshotGate, so a test can send
// output while a window is attaching.
function fakeMirror(options) {
  const counted = new Set();
  const mirror = {
    opts: options,
    written: [],
    writerAttached: null,
    disposed: false,
    cols: options.cols,
    rows: options.rows,
    snapshotGate: null,
    write(chunk) {
      mirror.written.push(chunk);
    },
    resize(cols, rows) {
      mirror.cols = cols;
      mirror.rows = rows;
    },
    async snapshot() {
      const data = mirror.written.join("");
      const size = { cols: mirror.cols, rows: mirror.rows };
      if (mirror.snapshotGate) await mirror.snapshotGate;
      return { data, ...size, modes: { ...FAKE_MODES } };
    },
    setWriterAttached(value) {
      mirror.writerAttached = value;
    },
    onCountedOutput(cb) {
      counted.add(cb);
      return () => counted.delete(cb);
    },
    counted() {
      for (const cb of [...counted]) cb();
    },
    dispose() {
      mirror.disposed = true;
    }
  };
  return mirror;
}

function fakeRecorder(options) {
  const recorder = {
    opts: options,
    outputs: [],
    markers: [],
    resizes: [],
    closed: false,
    output(chunk) {
      recorder.outputs.push(chunk);
    },
    marker(text) {
      recorder.markers.push(text);
    },
    resize(cols, rows) {
      recorder.resizes.push([cols, rows]);
    },
    async close() {
      recorder.closed = true;
    }
  };
  return recorder;
}

// What buildSessionProfile (Task S3) answers, without a login shell or a file.
function fakeProfile({ agentId, folder, kind, resume }) {
  return {
    command: `/fake/bin/${agentId}`,
    args: kind === "update" ? ["update"] : [],
    cwd: folder || os.homedir(),
    env: { TERM: "xterm-256color" },
    agentSessionId: agentId === "claude" ? resume?.agentSessionId || CLAUDE_UUID : null,
    settingsFile: null,
    softStop: kind === "update" ? null : agentId === "claude" ? "claude-bg" : agentId === "openclaw" ? "openclaw-abort" : null,
    resumeMode: kind === "update" ? null : FALLBACK_AGENTS.has(agentId) ? "fallback" : "id",
    folderShown: !(kind === "agent" && agentId === "openclaw"),
    notes: []
  };
}

// The folder policy's answers for the cases these tests use (Task S2 tests the real policy).
async function fakeCheckFolder(input) {
  const home = await realpath(os.homedir());
  let real;
  try {
    real = await realpath(String(input || ""));
  } catch {
    return { ok: false, code: "missing", message: "That folder doesn't exist." };
  }
  if (!real.startsWith(home + path.sep)) {
    return { ok: false, code: "outside_home", message: "Pick a folder inside your home folder." };
  }
  return { ok: true, path: real, name: path.basename(real) };
}

function fakeWorld(over = {}) {
  const world = {
    clock: T0,
    gate: true,
    pty: { ok: true, reason: null },
    installed: new Set(["claude", "codex", "cursor", "hermes", "openclaw"]),
    ptys: [],
    mirrors: [],
    recorders: [],
    profileInputs: [],
    capCalls: 0,
    capArgs: [],
    nextPid: 41000,
    // The next spawn waits for this promise (a one-shot hold, so a test can
    // look at the manager while a start is still in flight).
    spawnGate: null,
    spawnCalls: 0,
    // Every killTree call, [pid, options]. The fake pids are not real
    // processes, so no test ever signals them.
    kills: []
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
    recorderFactory: (options) => {
      const recorder = fakeRecorder(options);
      world.recorders.push(recorder);
      return recorder;
    },
    mirrorFactory: (options) => {
      const mirror = fakeMirror(options);
      world.mirrors.push(mirror);
      return mirror;
    },
    isExecutionAllowed: async () => world.gate,
    checkFolder: fakeCheckFolder,
    ptyCheck: async () => world.pty,
    detect: async (agentId) =>
      world.installed.has(agentId) ? { installed: true, path: `/fake/bin/${agentId}` } : { installed: false, path: "" },
    resolveBrain: async () => null,
    readSettings: async () => ({ claudeFullscreen: false }),
    enforceCap: async (options) => {
      world.capCalls += 1;
      world.capArgs.push(options);
      return { deleted: [] };
    },
    killTree: async (pid, options) => {
      world.kills.push([pid, options]);
    },
    ...over
  };
  world.manager = createSessionManager(world.deps);
  return world;
}

async function attachFake(manager, id, attachmentId = "w") {
  const frames = [];
  const closes = [];
  const attached = await manager.attach(id, {
    id: attachmentId,
    send: (frame) => frames.push(frame),
    close: (reason) => closes.push(reason)
  });
  return { frames, closes, detach: attached.detach, snapshot: attached.snapshot };
}

const outs = (frames) => frames.filter((frame) => frame.t === "out");
const outText = (frames) => outs(frames).map((frame) => frame.d).join("");

async function ended(world, id) {
  return waitFor(async () => {
    const summary = await world.manager.get(id);
    return summary.status === "exited" ? summary : null;
  });
}

// ---- lifecycle ----------------------------------------------------------------------------------

test("create: starts the agent from its profile, keeps meta.json private and answers a SessionSummary", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });

    assert.match(summary.id, SESSION_ID_RE);
    assert.deepEqual(Object.keys(summary).sort(), [...SUMMARY_KEYS].sort());
    assert.equal(summary.kind, "agent");
    assert.equal(summary.agentId, "claude");
    assert.equal(summary.agentLabel, "Claude Code");
    assert.equal(summary.folder, project);
    assert.equal(summary.folderName, "demo");
    assert.equal(summary.folderShown, true);
    assert.equal(summary.branch, null);
    assert.equal(summary.status, "starting");
    assert.equal(summary.stateSince, "2026-10-14T09:00:00.000Z");
    assert.equal(summary.startedAt, "2026-10-14T09:00:00.000Z");
    assert.equal(summary.endedAt, null);
    assert.equal(summary.exitCode, null);
    assert.equal(summary.signal, null);
    assert.equal(summary.endedBy, null);
    assert.equal(summary.dismissed, false);
    assert.deepEqual(summary.brain, { kind: "plan", label: "Plan" });
    assert.deepEqual(summary.resume, { available: false, reason: null, fallback: false });
    assert.equal(summary.alerts, "basic");
    // SP4's fields, with their defaults (filled by signals or by later tasks).
    assert.equal(summary.alert, null);
    assert.equal(summary.idleBy, null);
    assert.equal(summary.resetAt, null);
    assert.equal(summary.trustNeeded, false);
    assert.deepEqual(summary.hooksOff, { alerts: null, meter: null });
    assert.equal(summary.meter, null);
    assert.equal(summary.copyOf, null);
    assert.equal(summary.handoff, null);
    assert.equal(summary.recordingBytes, 0);

    // The profile got exactly what it needs to build the launch.
    const input = world.profileInputs[0];
    assert.equal(input.agentId, "claude");
    assert.equal(input.folder, project);
    assert.equal(input.sessionId, summary.id);
    assert.equal(input.kind, "agent");
    assert.equal(input.resume, null);
    assert.deepEqual(input.settings, { claudeFullscreen: false });
    assert.deepEqual(input.detected, { installed: true, path: "/fake/bin/claude" });
    assert.equal(input.brain, null);
    assert.equal(input.agentOsVersion, RUNTIME_VERSION);

    // The PTY runs the profile's argv (never a shell), at the starting size.
    assert.deepEqual(world.ptys[0].opts, {
      command: "/fake/bin/claude",
      args: [],
      cwd: project,
      env: { TERM: "xterm-256color" },
      cols: 120,
      rows: 32
    });

    // Files: the session folders are 0700, meta.json is 0600.
    const dir = path.join(agentOsHome, "sessions", summary.id);
    const meta = await metaOnDisk(agentOsHome, summary.id);
    assert.equal(meta.version, 1);
    assert.equal(meta.id, summary.id);
    assert.equal(meta.kind, "agent");
    assert.equal(meta.status, "starting");
    assert.equal(meta.folder, project);
    assert.equal(meta.agentSessionId, CLAUDE_UUID);
    assert.equal(meta.resumeMode, "id");
    assert.equal(meta.createdAt, "2026-10-14T09:00:00.000Z");
    assert.equal(meta.lastUsedAt, "2026-10-14T09:00:00.000Z");
    assert.equal(meta.resumes, 0);
    if (!isWindows) {
      assert.equal((await stat(path.join(agentOsHome, "sessions"))).mode & 0o777, 0o700);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(dir, "meta.json"))).mode & 0o777, 0o600);
    }

    // The recording and the mirror are made for the same folder and size.
    const recorder = world.recorders[0];
    assert.equal(recorder.opts.dir, dir);
    assert.equal(recorder.opts.append, false);
    assert.deepEqual([recorder.opts.cols, recorder.opts.rows], [120, 32]);
    assert.deepEqual([world.mirrors[0].opts.cols, world.mirrors[0].opts.rows], [120, 32]);
    assert.equal(world.mirrors[0].writerAttached, false, "no window is the writer yet");
  });
});

test("branch: a folder inside a git checkout shows its branch; a detached or plain folder shows none", async () => {
  await withSessionEnv(async ({ home, project, other }) => {
    assert.equal(await readGitBranch(project), null);

    await mkdir(path.join(project, ".git"));
    await writeFile(path.join(project, ".git", "HEAD"), "ref: refs/heads/feat/sessions\n");
    const sub = path.join(project, "src");
    await mkdir(sub);
    assert.equal(await readGitBranch(project), "feat/sessions");
    assert.equal(await readGitBranch(sub), "feat/sessions", "found from a subfolder too");

    // A worktree: .git is a file that points at its git folder.
    const gitdir = path.join(home, "wt-git");
    await mkdir(gitdir);
    await writeFile(path.join(gitdir, "HEAD"), "ref: refs/heads/agentos/codex-1\n");
    await writeFile(path.join(other, ".git"), `gitdir: ${gitdir}\n`);
    assert.equal(await readGitBranch(other), "agentos/codex-1");

    // A detached HEAD has no branch.
    await writeFile(path.join(gitdir, "HEAD"), "3f2a9c1d5e7b8a0c4d6e8f1a2b3c4d5e6f7a8b9c\n");
    assert.equal(await readGitBranch(other), null);

    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    assert.equal(summary.branch, "feat/sessions");
  });
});

test("brain: the Brain row comes from the resolved brain, which also goes to the profile; Hermes and OpenClaw have none", async () => {
  await withSessionEnv(async ({ project }) => {
    const brains = {
      claude: {
        mode: "local",
        model: "qwen3-coder",
        local: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "agentos-qwen3-coder:64k" }
      },
      codex: { mode: "openrouter", model: "openai/gpt-5.5" }
    };
    const world = fakeWorld({ resolveBrain: async (agentId) => brains[agentId] || null });
    const claude = await world.manager.create({ agentId: "claude", folder: project });
    const codex = await world.manager.create({ agentId: "codex", folder: project });
    const cursor = await world.manager.create({ agentId: "cursor", folder: project });
    const hermes = await world.manager.create({ agentId: "hermes", folder: project });
    assert.deepEqual(claude.brain, { kind: "local", label: "Local" });
    assert.deepEqual(codex.brain, { kind: "openrouter", label: "OpenRouter" });
    assert.deepEqual(cursor.brain, { kind: "plan", label: "Plan" });
    assert.equal(hermes.brain, null);
    assert.deepEqual(world.profileInputs[0].brain, brains.claude);
    assert.deepEqual(world.profileInputs[1].brain, brains.codex);
    assert.equal(world.profileInputs[2].brain, null);
  });
});

test("Look only: create and resume are refused with the Safety sentence, while an open session keeps running and list, writes and dismiss still work", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const open = await world.manager.create({ agentId: "claude", folder: project });
    const done = await world.manager.create({ agentId: "codex", folder: project });
    world.ptys[1].exit(0);
    await ended(world, done.id);

    world.gate = false; // Safety switched to Look only
    const lookOnly = (error) =>
      error.status === 409 &&
      error.code === "execution_gate_off" &&
      error.message === "Safety is on Look only, so no session can start. Allow running agents in Safety, then try again.";
    await assert.rejects(world.manager.create({ agentId: "claude", folder: project }), lookOnly);
    await assert.rejects(world.manager.resume(done.id), lookOnly);
    assert.equal(world.ptys.length, 2, "nothing new started");

    // The session that was already open keeps running until someone stops it.
    const win = await attachFake(world.manager, open.id, "w");
    world.ptys[0].emit("still working");
    assert.equal(outText(win.frames), "still working");
    assert.equal((await world.manager.get(open.id)).status, "live");
    assert.equal(world.ptys[0].kills.length, 0, "Look only stops nothing");
    assert.equal(world.manager.focus(open.id, "w"), true);
    assert.equal(world.manager.write(open.id, "w", "ls\r"), true);
    assert.deepEqual(world.ptys[0].writes, ["ls\r"]);
    assert.equal((await world.manager.list()).length, 2);
    assert.equal((await world.manager.dismiss(done.id)).dismissed, true);
  });
});

test("limit: at most 8 live agent sessions even when starts race; an update session is not counted; an ended session frees its slot", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => world.manager.create({ agentId: "claude", folder: project }))
    );
    const started = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    assert.equal(started.length, 8);
    assert.equal(refused.length, 2);
    for (const result of refused) {
      assert.equal(result.reason.status, 409);
      assert.equal(result.reason.code, "too_many_sessions");
      assert.equal(result.reason.message, "Agent OS runs at most 8 sessions at once. Stop one, then try again.");
    }
    assert.equal(world.ptys.length, 8);

    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    assert.equal(update.kind, "update", "the update kind is not counted toward the 8");

    world.ptys[0].exit(0);
    await waitFor(async () => (await world.manager.list()).some((summary) => summary.status === "exited"));
    const ninth = await world.manager.create({ agentId: "claude", folder: project });
    assert.equal(ninth.status, "starting");
  });
});

test("create refuses an unknown agent, a refused folder (with the folder's own code and sentence), a missing terminal module, a terminal that can't be made and a failed start, and leaves nothing behind", async () => {
  await withSessionEnv(async ({ home, agentOsHome, project }) => {
    const notInstalled = Object.assign(
      new Error("Codex isn't installed, or Agent OS can't find it. Install it in Setup, then try again."),
      { status: 409, code: "agent_not_installed" }
    );
    const world = fakeWorld({
      buildProfile: async (input) => {
        if (input.agentId === "codex") throw notInstalled;
        return fakeProfile(input);
      }
    });
    await assert.rejects(
      world.manager.create({ agentId: "bash", folder: project }),
      (error) => error.status === 400 && error.code === "unknown_agent"
    );
    await assert.rejects(
      // The temp folder that holds the test's home: it exists on every OS (Windows has no /etc) and is outside home.
      world.manager.create({ agentId: "claude", folder: path.dirname(home) }),
      (error) =>
        error.status === 400 &&
        error.code === "folder_refused" &&
        error.extra.code === "outside_home" &&
        error.message === "Pick a folder inside your home folder."
    );
    await assert.rejects(
      world.manager.create({ agentId: "claude", folder: path.join(project, "nope") }),
      (error) => error.code === "folder_refused" && error.extra.code === "missing" && error.message === "That folder doesn't exist."
    );
    await assert.rejects(world.manager.create({ agentId: "codex", folder: project }), (error) => error === notInstalled);
    world.pty = { ok: false, reason: "Agent OS could not load its terminal module on this computer." };
    await assert.rejects(
      world.manager.create({ agentId: "claude", folder: project }),
      (error) =>
        error.status === 503 &&
        error.code === "pty_unavailable" &&
        error.message === "Agent OS could not load its terminal module on this computer, so sessions can't start."
    );
    assert.equal(world.ptys.length, 0, "nothing was started");

    const broken = fakeWorld({
      spawn: async () => {
        throw new Error("posix_spawnp failed.");
      }
    });
    await assert.rejects(
      broken.manager.create({ agentId: "claude", folder: project }),
      (error) =>
        error.status === 500 &&
        error.code === "start_failed" &&
        error.message === "Agent OS could not start Claude Code. Check that it is installed, then try again."
    );
    assert.equal(broken.mirrors[0].disposed, true);
    assert.equal(broken.recorders.length, 0, "a start that fails never opens the recording");

    // The terminal program says exactly why it can't start (its folder is gone,
    // say): that sentence is passed on, as a start_failed answer.
    const exact = "Agent OS couldn't start claude. Check that it is installed and that the folder still exists.";
    const vanished = fakeWorld({
      spawn: async () => {
        throw sessionError(500, "spawn_failed", exact);
      }
    });
    await assert.rejects(
      vanished.manager.create({ agentId: "claude", folder: project }),
      (error) => error.status === 500 && error.code === "start_failed" && error.message === exact
    );
    assert.equal(vanished.mirrors[0].disposed, true);
    assert.equal(vanished.recorders.length, 0);

    // The terminal module loaded but could not make a terminal: the same 503 and sentence.
    const lost = fakeWorld({
      spawn: async () => {
        throw Object.assign(new Error("Agent OS could not load its terminal module on this computer."), {
          code: "pty_unavailable"
        });
      }
    });
    await assert.rejects(
      lost.manager.create({ agentId: "claude", folder: project }),
      (error) =>
        error.status === 503 &&
        error.code === "pty_unavailable" &&
        error.message === "Agent OS could not load its terminal module on this computer, so sessions can't start."
    );
    assert.equal(lost.recorders.length, 0);
    assert.equal(lost.mirrors[0].disposed, true);

    let left = [];
    try {
      left = await readdir(path.join(agentOsHome, "sessions"));
    } catch {
      left = [];
    }
    assert.deepEqual(left, [], "no session folder was left behind");

    // A refused start never keeps a slot.
    world.pty = { ok: true, reason: null };
    assert.equal((await world.manager.create({ agentId: "claude", folder: project })).status, "starting");
  });
});

test("OpenClaw: no folder is asked for or checked while OpenClaw's folder is not honoured, and its title says Set by OpenClaw", async () => {
  await withSessionEnv(async ({ home }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "openclaw" });
    assert.equal(world.profileInputs[0].folder, null);
    assert.equal(summary.folderShown, false);
    assert.equal(summary.folder, home);
    assert.equal(summary.branch, null);
    assert.deepEqual((await world.manager.quitCheck()).live, [
      { id: summary.id, title: "OpenClaw · Set by OpenClaw", kind: "agent" }
    ]);
  });
});

// ---- activity -----------------------------------------------------------------------------------

test("activity: starting, then live on the first output; idle after 20 s without counted output; counted output and keystrokes wake it, automatic replies and the redraw right after a resize do not", async (t) => {
  await withSessionEnv(async ({ project }) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(IDLE_AFTER_MS, 20000);
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "hermes", folder: project });
    const pty = world.ptys[0];
    const mirror = world.mirrors[0];
    const win = await attachFake(world.manager, summary.id, "w");
    assert.equal(world.manager.focus(summary.id, "w"), true);
    const current = () => world.manager.get(summary.id);
    assert.equal((await current()).status, "starting");

    pty.emit("\x1b[?25l"); // output of any kind, even an invisible one
    assert.equal((await current()).status, "live");

    t.mock.timers.tick(IDLE_AFTER_MS - 1);
    pty.emit("\x1b[30;1Hstatus line redraw"); // not counted: the mirror did not call back
    assert.equal((await current()).status, "live");
    world.clock = T0 + 20000;
    t.mock.timers.tick(1);
    const idle = await current();
    assert.equal(idle.status, "idle");
    assert.equal(idle.stateSince, "2026-10-14T09:00:20.000Z");

    pty.emit("\x1b[30;1Hstatus line redraw");
    assert.equal((await current()).status, "idle", "output that is not counted never wakes it");

    mirror.counted();
    assert.equal((await current()).status, "live");
    t.mock.timers.tick(IDLE_AFTER_MS - 1);
    mirror.counted(); // more counted output starts the 20 s again
    t.mock.timers.tick(IDLE_AFTER_MS - 1);
    assert.equal((await current()).status, "live");
    t.mock.timers.tick(1);
    assert.equal((await current()).status, "idle");

    // A resize makes the agent redraw, and the mirror may count that reflow.
    // For 1 s after a resize, counted output is not activity.
    assert.equal(world.manager.resize(summary.id, "w", 100, 30), true);
    world.clock += 999;
    mirror.counted();
    assert.equal((await current()).status, "idle", "the redraw right after a resize does not wake it");
    world.clock += 1;

    // Query replies (DA1, DSR), focus reports and mouse motion are not user input.
    for (const frame of ["\x1b[?1;2c", "\x1b[12;40R", "\x1b[I", "\x1b[O", "\x1b[<35;10;5M"]) {
      assert.equal(world.manager.write(summary.id, "w", frame), true, "they still reach the agent");
    }
    assert.equal((await current()).status, "idle");
    assert.equal(world.manager.write(summary.id, "w", "y"), true); // a keystroke is
    assert.equal((await current()).status, "live");

    t.mock.timers.tick(IDLE_AFTER_MS);
    assert.equal((await current()).status, "idle");
    mirror.counted(); // 1 s after the resize, counted output is activity again
    assert.equal((await current()).status, "live");

    assert.deepEqual(
      win.frames.filter((frame) => frame.t === "state").map((frame) => frame.status),
      ["starting", "live", "idle", "live", "idle", "live", "idle", "live"]
    );
  });
});

test("exit: the session ends with its exit code or signal, meta.json keeps it, open windows get the last state and are closed, and the recording cap runs without touching a live session's recording", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    const a = await world.manager.create({ agentId: "claude", folder: project });
    const b = await world.manager.create({ agentId: "codex", folder: project });
    const win = await attachFake(world.manager, a.id, "w");
    world.clock = Date.parse("2026-10-14T09:05:00.000Z");
    world.ptys[0].exit(3);
    world.ptys[1].exit(0, 9);
    await waitFor(() => world.capCalls === 2);

    const endedA = await world.manager.get(a.id);
    assert.equal(endedA.status, "exited");
    assert.equal(endedA.exitCode, 3);
    assert.equal(endedA.signal, null);
    assert.equal(endedA.endedBy, null);
    assert.equal(endedA.endedAt, "2026-10-14T09:05:00.000Z");
    assert.equal(endedA.stateSince, "2026-10-14T09:05:00.000Z");
    const endedB = await world.manager.get(b.id);
    assert.equal(endedB.exitCode, null, "a signal ends a process without an exit code");
    assert.equal(endedB.signal, "SIGKILL");

    assert.deepEqual(win.frames.at(-1), { t: "state", status: "exited", exitCode: 3, signal: null, endedBy: null });
    assert.deepEqual(win.closes, ["session_ended"]);
    assert.equal(world.recorders[0].closed, true);
    assert.equal(world.mirrors[0].disposed, true);

    const meta = await metaOnDisk(agentOsHome, a.id);
    assert.equal(meta.status, "exited");
    assert.equal(meta.exitCode, 3);
    assert.equal(meta.lastUsedAt, "2026-10-14T09:05:00.000Z");

    await assert.rejects(
      world.manager.attach(a.id, { id: "late", send() {}, close() {} }),
      (error) => error.status === 409 && error.code === "session_ended" && error.message === "That session has ended. Its recording is in Runs."
    );
    assert.equal(world.manager.write(a.id, "w", "x"), false);
    assert.deepEqual((await world.manager.quitCheck()).live, []);

    // The cap is told which sessions the manager still has, so it never removes
    // a recording that is still being written (during a quit, every live
    // session's meta.json already says "exited" before its process ends).
    const { isLive } = world.capArgs[0];
    assert.equal(typeof isLive, "function");
    assert.equal(isLive(a.id), false);
    assert.equal(isLive(b.id), false);
    const c = await world.manager.create({ agentId: "hermes", folder: project });
    assert.equal(isLive(c.id), true, "a running session's recording is never removed");
    // The same live view, for the recordings routes (Task S8, ruling R8).
    assert.equal(world.manager.isLive(c.id), true);
    assert.equal(world.manager.isLive(a.id), false);
  });
});

// ---- SP4: activity, alerts and markers (signals.js drives the table) --------------------------

test("signals: a bell makes an agent session waiting with the basic text, one alert frame, one permission marker and one alert line; more bells add nothing; output never clears it, user input does with a resolved frame; update sessions never alert", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const lines = [];
    const world = fakeWorld({ onAlertLine: (payload) => lines.push(payload) });
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const win = await attachFake(world.manager, summary.id, "w");
    assert.equal(world.manager.focus(summary.id, "w"), true);
    const pty = world.ptys[0];
    const mirror = world.mirrors[0];
    pty.emit("ready");
    world.clock = T0 + 5000;
    mirror.opts.onAlert("bel");
    mirror.opts.onAlert("9;4;1;50"); // a progress report is not an alert
    mirror.opts.onAlert("9;Build finished");
    mirror.opts.onAlert("bel");

    const waiting = await world.manager.get(summary.id);
    assert.equal(waiting.status, "waiting");
    assert.deepEqual(waiting.alert, { kind: "waiting", text: "May need you", at: "2026-10-14T09:00:05.000Z" });
    assert.equal(waiting.alerts, "basic", "a bell never makes a session turn-done");
    const alertFrames = () => win.frames.filter((frame) => frame.t === "alert");
    assert.deepEqual(alertFrames(), [{ t: "alert", kind: "waiting", text: "May need you" }]);
    assert.deepEqual(lines, [{ sessionId: summary.id, agent: "Claude Code", kind: "waiting", text: "May need you" }]);
    const stored = await markersOnDisk(agentOsHome, summary.id, 1);
    assert.deepEqual(stored, [{ at: "2026-10-14T09:00:05.000Z", type: "permission", text: "May need you" }]);
    assert.deepEqual(await world.manager.markers(summary.id), stored);

    pty.emit("\x1b[30;1Hredraw");
    mirror.counted();
    assert.equal((await world.manager.get(summary.id)).status, "waiting", "output never clears waiting");
    assert.equal(world.manager.write(summary.id, "w", "\x1b[I"), true); // a focus report is not user input
    assert.equal((await world.manager.get(summary.id)).status, "waiting");
    assert.equal(world.manager.write(summary.id, "w", "y"), true);
    const answered = await world.manager.get(summary.id);
    assert.equal(answered.status, "live");
    assert.equal(answered.alert, null);
    assert.deepEqual(alertFrames().at(-1), { t: "alert", kind: "resolved", text: "" });
    assert.deepEqual(win.frames.filter((frame) => frame.t === "state").map((frame) => frame.status), ["starting", "live", "waiting", "live"]);
    assert.equal(lines.length, 1, "clearing an alert prints nothing");

    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    world.mirrors[1].opts.onAlert("bel");
    const listed = (await world.manager.list({ includeUpdate: true })).find((session) => session.id === update.id);
    assert.notEqual(listed.status, "waiting");
    assert.equal(listed.alert, null);
    assert.equal(lines.length, 1, "an update session never alerts");
  });
});

test("activity (SP4): a turn-done session stays idle through redraws and status line refreshes and leaves idle only on user input or a new-turn hook; without a turn_done it is idle 120 s after its last counted output (K5)", async (t) => {
  await withSessionEnv(async ({ project }) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    assert.equal(TURN_DONE_BACKSTOP_MS, 120000);
    const world = fakeWorld();
    const { id } = await world.manager.create({ agentId: "claude", folder: project });
    const win = await attachFake(world.manager, id, "w");
    assert.equal(world.manager.focus(id, "w"), true);
    const pty = world.ptys[0];
    const mirror = world.mirrors[0];
    const current = () => world.manager.get(id);
    pty.emit("hello");
    assert.equal(world.manager.markSourceSeen(id), true);
    assert.equal((await current()).alerts, "full");
    t.mock.timers.tick(IDLE_AFTER_MS);
    assert.equal((await current()).status, "live", "a turn-done session has no 20 s rule");

    assert.equal(world.manager.applySignal(id, { kind: "turn_done", source: "hook" }), true);
    let now = await current();
    assert.equal(now.status, "idle");
    assert.equal(now.idleBy, "turn_done");
    for (let i = 0; i < 5; i += 1) {
      pty.emit("\x1b[30;1Hstatus line");
      mirror.counted();
      t.mock.timers.tick(1000);
    }
    assert.equal((await current()).status, "idle", "redraws and status line refreshes never wake it");

    assert.equal(world.manager.markNewTurn(id), true);
    now = await current();
    assert.equal(now.status, "live");
    assert.equal(now.idleBy, null);
    world.manager.applySignal(id, { kind: "turn_done", source: "hook" });
    assert.equal(world.manager.write(id, "w", "next\r"), true);
    assert.equal((await current()).status, "live", "user input wakes it");

    // K5: this turn's turn_done never comes (an API error, Esc).
    t.mock.timers.tick(TURN_DONE_BACKSTOP_MS - 1000);
    mirror.counted(); // counted output starts the 120 s again
    t.mock.timers.tick(TURN_DONE_BACKSTOP_MS - 1);
    assert.equal((await current()).status, "live");
    t.mock.timers.tick(1);
    now = await current();
    assert.equal(now.status, "idle");
    assert.equal(now.idleBy, "timer");
    world.manager.applySignal(id, { kind: "turn_done", source: "hook" });
    assert.equal((await current()).idleBy, "turn_done", "a late turn_done still says the turn is done");
    assert.deepEqual(
      win.frames.filter((frame) => frame.t === "state").map((frame) => frame.status),
      ["starting", "live", "idle", "live", "idle", "live", "idle"]
    );
    assert.deepEqual(win.frames.filter((frame) => frame.t === "alert"), [], "turn_done travels in the state frame, never as an alert (K8)");
  });
});

test("activity (SP4): a basic session keeps the 20 s rule and has no idle time while it waits; a resolved signal makes it live; a turn_done signal while waiting makes the session idle and clears its alert (K4)", async (t) => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const world = fakeWorld();
    const cursor = await world.manager.create({ agentId: "cursor", folder: project });
    world.ptys[0].emit("ready");
    const get = (id) => world.manager.get(id);
    assert.equal(world.manager.applySignal(cursor.id, { kind: "waiting", text: "May need you", source: "bel" }), true);
    t.mock.timers.tick(IDLE_AFTER_MS * 3);
    assert.equal((await get(cursor.id)).status, "waiting", "no idle time runs while it waits");
    assert.equal(world.manager.applySignal(cursor.id, { kind: "resolved", source: "title" }), true);
    assert.equal((await get(cursor.id)).status, "live");
    t.mock.timers.tick(IDLE_AFTER_MS - 1);
    assert.equal((await get(cursor.id)).status, "live");
    t.mock.timers.tick(1);
    const idle = await get(cursor.id);
    assert.equal(idle.status, "idle");
    assert.equal(idle.idleBy, "timer");
    assert.equal(idle.alerts, "basic");

    const codex = await world.manager.create({ agentId: "codex", folder: project });
    world.ptys[1].emit("ready");
    world.manager.applySignal(codex.id, { kind: "waiting", text: "Approval requested: npm test", source: "osc" });
    world.manager.applySignal(codex.id, { kind: "turn_done", text: "Agent turn complete", source: "osc" });
    const done = await get(codex.id);
    assert.equal(done.status, "idle");
    assert.equal(done.idleBy, "turn_done");
    assert.equal(done.alert, null);
    assert.equal(done.alerts, "full");
    await markersOnDisk(agentOsHome, cursor.id, 1);
    await markersOnDisk(agentOsHome, codex.id, 1);
  });
});

test("alert frames and the AGENT_OS_ALERT line (K7, K8): a line when an alert starts or changes kind, none for new text of the same kind, for clearing, or for a hold that only learns its reset time; a frame for every change", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const lines = [];
    const world = fakeWorld({ onAlertLine: (payload) => lines.push(payload) });
    const { id } = await world.manager.create({ agentId: "claude", folder: project });
    const win = await attachFake(world.manager, id, "w");
    world.ptys[0].emit("ready");
    const limitText = "Claude Code's plan limit was reached.";
    world.manager.applySignal(id, { kind: "waiting", text: "Wants to use Bash", source: "hook" });
    world.manager.applySignal(id, { kind: "waiting", text: "Wants to use Bash", source: "hook" });
    world.manager.applySignal(id, { kind: "waiting", text: "Has a question for you", source: "hook" });
    world.manager.applySignal(id, { kind: "resolved", source: "hook" });
    assert.equal(world.manager.setHeld(id, { text: limitText, source: "hook" }), true);
    world.clock = T0 + 60000;
    world.manager.setHeld(id, { resetAt: "2026-10-14T14:00:00.000Z", text: limitText, source: "status" });
    const held = await world.manager.get(id);
    assert.equal(held.resetAt, "2026-10-14T14:00:00.000Z");
    assert.deepEqual(held.alert, { kind: "limit", text: limitText, at: "2026-10-14T09:00:00.000Z" }, "the same limit keeps the time it began");
    assert.equal(world.manager.clearHeld(id), true);
    assert.equal((await world.manager.get(id)).status, "idle");
    assert.deepEqual(
      win.frames.filter((frame) => frame.t === "state" || frame.t === "alert"),
      [
        { t: "state", status: "starting" },
        { t: "state", status: "live" },
        { t: "state", status: "waiting" },
        { t: "alert", kind: "waiting", text: "Wants to use Bash" },
        { t: "alert", kind: "waiting", text: "Has a question for you" },
        { t: "state", status: "live" },
        { t: "alert", kind: "resolved", text: "" },
        { t: "state", status: "held" },
        { t: "alert", kind: "limit", text: limitText },
        { t: "state", status: "held", resetAt: "2026-10-14T14:00:00.000Z" },
        { t: "state", status: "idle" },
        { t: "alert", kind: "resolved", text: "" }
      ]
    );

    const openclaw = await world.manager.create({ agentId: "openclaw" });
    const cardWin = await attachFake(world.manager, openclaw.id, "o");
    world.manager.applySignal(openclaw.id, { kind: "approval", text: "exec: npm test", source: "openclaw" });
    world.mirrors[1].opts.onAlert("bel"); // M4: a basic bell never overwrites the approval
    assert.deepEqual((await world.manager.get(openclaw.id)).alert, {
      kind: "approval",
      text: "exec: npm test",
      at: "2026-10-14T09:01:00.000Z"
    });
    assert.deepEqual(
      cardWin.frames.filter((frame) => frame.t === "alert"),
      [{ t: "alert", kind: "approval", text: "exec: npm test" }],
      "the bell sent no frame"
    );
    assert.equal(lines.length, 3, "and no second line");
    // A specific alert of another kind does replace it.
    world.manager.applySignal(openclaw.id, { kind: "waiting", text: "Has a question for you", source: "hook" });
    assert.deepEqual(lines, [
      { sessionId: id, agent: "Claude Code", kind: "waiting", text: "Wants to use Bash" },
      { sessionId: id, agent: "Claude Code", kind: "limit", text: limitText },
      { sessionId: openclaw.id, agent: "OpenClaw", kind: "approval", text: "exec: npm test" },
      { sessionId: openclaw.id, agent: "OpenClaw", kind: "waiting", text: "Has a question for you" }
    ]);
    assert.deepEqual(
      (await markersOnDisk(agentOsHome, id, 1)).map((marker) => marker.text),
      ["Wants to use Bash"],
      "one marker per question that started; none for the limit"
    );
    assert.deepEqual(
      (await markersOnDisk(agentOsHome, openclaw.id, 2)).map((marker) => marker.text),
      ["exec: npm test", "Has a question for you"],
      "the bell added no marker"
    );
  });
});

test("held: setHeld shows the limit alert and the reset time in the summary and the state frame; output and other signals never clear it; user input makes it live; the reset timer makes it idle; a hold without a reset time stays until clearHeld", async (t) => {
  await withSessionEnv(async ({ project }) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const world = fakeWorld();
    const { id } = await world.manager.create({ agentId: "claude", folder: project });
    const win = await attachFake(world.manager, id, "w");
    assert.equal(world.manager.focus(id, "w"), true);
    const pty = world.ptys[0];
    const mirror = world.mirrors[0];
    pty.emit("ready");
    const resetAt = "2026-10-14T09:30:00.000Z";
    const text = "Claude Code's plan limit was reached.";
    const lastState = () => win.frames.filter((frame) => frame.t === "state").at(-1);
    assert.equal(world.manager.setHeld(id, { resetAt, text, source: "hook" }), true);
    let now = await world.manager.get(id);
    assert.equal(now.status, "held");
    assert.equal(now.resetAt, resetAt);
    assert.deepEqual(now.alert, { kind: "limit", text, at: "2026-10-14T09:00:00.000Z" });
    assert.equal(now.idleBy, null);
    assert.deepEqual(lastState(), { t: "state", status: "held", resetAt });

    pty.emit("\x1b[30;1Hstatus line");
    mirror.counted();
    world.manager.applySignal(id, { kind: "turn_done", source: "hook" });
    world.manager.applySignal(id, { kind: "waiting", text: "Wants to use Bash", source: "hook" });
    world.manager.applySignal(id, { kind: "resolved", source: "hook" });
    world.manager.markNewTurn(id);
    t.mock.timers.tick(TURN_DONE_BACKSTOP_MS * 2);
    assert.equal((await world.manager.get(id)).status, "held", "output, signals and time before the reset never clear a hold");

    assert.equal(world.manager.write(id, "w", "y"), true);
    now = await world.manager.get(id);
    assert.equal(now.status, "live");
    assert.equal(now.alert, null);
    assert.equal(now.resetAt, null);

    // The reset time passes while the Mac is awake: the reset timer fires. This
    // world compares the clock with the reset time only every 10 hours, so only
    // the timer at the reset time (K3's first half) can end the hold; the 60 s
    // wall-clock check is the next test's. A hold repeated without a reset time
    // keeps the known one, and its timer stays armed (M2).
    const timerWorld = fakeWorld({ heldCheckMs: 10 * 60 * 60 * 1000 });
    const timed = await timerWorld.manager.create({ agentId: "claude", folder: project });
    timerWorld.ptys[0].emit("ready");
    timerWorld.manager.setHeld(timed.id, { resetAt, text, source: "hook" });
    timerWorld.manager.setHeld(timed.id, { text, source: "status" });
    assert.equal((await timerWorld.manager.get(timed.id)).resetAt, resetAt, "a repeated hold without a reset time keeps the known one");
    t.mock.timers.tick(Date.parse(resetAt) - timerWorld.clock - 1);
    assert.equal((await timerWorld.manager.get(timed.id)).status, "held", "one millisecond before the reset time nothing has fired");
    timerWorld.clock = Date.parse(resetAt);
    t.mock.timers.tick(1);
    now = await timerWorld.manager.get(timed.id);
    assert.equal(now.status, "idle", "the reset timer ended the hold");
    assert.equal(now.idleBy, null);
    assert.equal(now.alert, null);
    assert.equal(now.resetAt, null);

    // A hold whose reset time is unknown: no resetAt in the frame, and no timer.
    world.manager.setHeld(id, { text, source: "status" });
    assert.deepEqual(lastState(), { t: "state", status: "held" });
    assert.equal((await world.manager.get(id)).resetAt, null);
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    assert.equal((await world.manager.get(id)).status, "held");
    assert.equal(world.manager.clearHeld(id), true); // R4: the status shows the window cleared
    assert.equal((await world.manager.get(id)).status, "idle");
  });
});

test("Review Focus 3: the Mac sleeps through the plan's reset time; the next 60 s wall-clock check, not the reset timer, moves the held session to idle, clears the alert and sends a resolved frame", async (t) => {
  await withSessionEnv(async ({ project }) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    assert.equal(HELD_CHECK_MS, 60000);
    const world = fakeWorld();
    const { id } = await world.manager.create({ agentId: "claude", folder: project });
    const win = await attachFake(world.manager, id, "w");
    world.ptys[0].emit("ready");
    const text = "Claude Code's plan limit was reached.";
    const resetAt = new Date(T0 + 3 * 60 * 60 * 1000).toISOString();
    assert.equal(world.manager.setHeld(id, { resetAt, text, source: "hook" }), true);
    t.mock.timers.tick(5 * HELD_CHECK_MS);
    world.clock += 5 * HELD_CHECK_MS;
    assert.equal((await world.manager.get(id)).status, "held", "five minutes in, the reset is still ahead");

    // The lid closes and Node's timers stop. It opens five hours later: the
    // wall clock is two hours past the reset, and the reset timer (three
    // hours of timer time away) has not fired.
    world.clock = Date.parse(resetAt) + 2 * 60 * 60 * 1000;
    t.mock.timers.tick(HELD_CHECK_MS);
    const woke = await world.manager.get(id);
    assert.equal(woke.status, "idle");
    assert.equal(woke.alert, null);
    assert.equal(woke.resetAt, null);
    assert.equal(woke.stateSince, new Date(world.clock).toISOString());
    assert.deepEqual(win.frames.filter((frame) => frame.t === "state" || frame.t === "alert").slice(-4), [
      { t: "state", status: "held", resetAt },
      { t: "alert", kind: "limit", text },
      { t: "state", status: "idle" },
      { t: "alert", kind: "resolved", text: "" }
    ]);
  });
});

test("markers: kept in meta.json (the newest 500), read from memory while the session runs and from disk after it ends; a prompt marker never carries the prompt's text (R23); unknown ids are 404; update sessions and unknown types keep none", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    assert.equal(MARKERS_MAX, 500);
    const world = fakeWorld();
    const { id } = await world.manager.create({ agentId: "claude", folder: project });
    assert.deepEqual(await world.manager.markers(id), []);
    world.clock = T0 + 1000;
    assert.equal(await world.manager.addMarker(id, { type: "prompt", text: "my secret prompt" }), true);
    assert.deepEqual(await world.manager.markers(id), [{ at: "2026-10-14T09:00:01.000Z", type: "prompt" }]);
    assert.deepEqual(await markersOnDisk(agentOsHome, id, 1), [{ at: "2026-10-14T09:00:01.000Z", type: "prompt" }]);
    assert.equal(JSON.stringify(await metaOnDisk(agentOsHome, id)).includes("my secret prompt"), false, "a prompt's text is never stored");

    assert.equal(await world.manager.addMarker(id, { type: "shell", text: "x" }), false);
    for (let i = 0; i < 505; i += 1) {
      assert.equal(await world.manager.addMarker(id, { type: "permission", text: `Wants to use tool ${i}` }), true);
    }
    const kept = await world.manager.markers(id);
    assert.equal(kept.length, 500);
    assert.equal(kept[0].text, "Wants to use tool 5", "the oldest go first");
    assert.equal(kept.at(-1).text, "Wants to use tool 504");
    assert.deepEqual((await metaOnDisk(agentOsHome, id)).markers, kept);

    world.ptys[0].exit(0);
    await ended(world, id);
    await waitFor(() => !world.manager.isLive(id));
    assert.deepEqual(await world.manager.markers(id), kept, "after the end, read from meta.json");
    assert.equal(await world.manager.addMarker(id, { type: "prompt" }), false, "an ended session takes no marker");

    for (const unknownId of [crypto.randomUUID(), "not-a-uuid"]) {
      await assert.rejects(world.manager.markers(unknownId), (error) => error.status === 404 && error.code === "unknown_session");
    }
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    assert.equal(await world.manager.addMarker(update.id, { type: "prompt" }), false);
    assert.deepEqual(await world.manager.markers(update.id), []);
  });
});

test("liveAgentSessions and onLiveChange: copies of the running agent sessions only, in start order; listeners run after an agent session starts and after it ends; a listener that throws is logged and never stops anything", async (t) => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args.map(String).join(" ")));
    const world = fakeWorld();
    const seen = [];
    const off = world.manager.onLiveChange(() => seen.push(world.manager.liveAgentSessions().map((session) => session.id)));
    world.manager.onLiveChange(() => {
      throw new Error("listener boom");
    });
    assert.throws(() => world.manager.onLiveChange("not a function"), TypeError);

    const a = await world.manager.create({ agentId: "claude", folder: project });
    const b = await world.manager.create({ agentId: "codex", folder: project });
    await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    assert.deepEqual(seen, [[a.id], [a.id, b.id]], "an update session is not an agent session");

    const all = world.manager.liveAgentSessions();
    assert.deepEqual(all.map((session) => session.id), [a.id, b.id]);
    assert.deepEqual(world.manager.liveAgentSessions("codex").map((session) => session.id), [b.id]);
    assert.deepEqual(world.manager.liveAgentSessions("hermes"), []);
    const profile = { command: "/fake/bin/claude", args: [], cwd: project, env: { TERM: "xterm-256color" } };
    assert.deepEqual(all[0], {
      id: a.id,
      agentId: "claude",
      agentSessionId: CLAUDE_UUID,
      folder: project,
      status: "starting",
      alert: null,
      pid: world.ptys[0].pid,
      lastInputAt: 0,
      profile
    });
    all[0].profile.env.AGENT_OS_TOKEN = "leak";
    all[0].profile.args.push("--yolo");
    assert.deepEqual(world.manager.liveAgentSessions()[0].profile, profile, "callers get copies");
    world.mirrors[0].opts.onAlert("bel");
    assert.deepEqual(world.manager.liveAgentSessions()[0].alert, {
      kind: "waiting",
      text: "May need you",
      at: "2026-10-14T09:00:00.000Z",
      source: "bel"
    });
    await attachFake(world.manager, a.id, "w");
    assert.equal(world.manager.focus(a.id, "w"), true); // only the writer's input counts
    world.clock = T0 + 1000;
    assert.equal(world.manager.write(a.id, "w", "y"), true);
    assert.equal(world.manager.liveAgentSessions()[0].lastInputAt, T0 + 1000, "the time of the last user input");

    world.ptys[1].exit(0);
    await ended(world, b.id);
    assert.deepEqual(seen.at(-1), [a.id]);
    assert.equal(errors.filter((line) => line.includes("listener boom")).length, 3, "logged for two starts and one end");

    off();
    await world.manager.create({ agentId: "cursor", folder: project });
    assert.equal(seen.length, 3, "an unsubscribed listener is not called again");
    await markersOnDisk(agentOsHome, a.id, 1);
  });
});

test("signal entry points: false for an unknown, ended or non-agent session; a limit never goes straight to the activity, and an unknown kind or source is a caller's bug (TypeError)", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const a = await world.manager.create({ agentId: "claude", folder: project });
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    const waiting = { kind: "waiting", text: "Wants to use Bash", source: "hook" };
    for (const id of [crypto.randomUUID(), "not-a-uuid", update.id]) {
      assert.equal(world.manager.applySignal(id, waiting), false, id);
      assert.equal(world.manager.markSourceSeen(id), false, id);
      assert.equal(world.manager.markNewTurn(id), false, id);
      assert.equal(world.manager.setHeld(id, { text: "x", source: "hook" }), false, id);
      assert.equal(world.manager.clearHeld(id), false, id);
    }
    assert.equal((await world.manager.list({ includeUpdate: true })).find((session) => session.id === update.id).alert, null);
    assert.throws(() => world.manager.applySignal(a.id, { kind: "limit", text: "x", source: "hook" }), TypeError);
    assert.throws(() => world.manager.applySignal(a.id, { kind: "done", source: "hook" }), TypeError);
    assert.throws(() => world.manager.applySignal(a.id, { kind: "waiting", source: "email" }), TypeError);
    assert.throws(() => world.manager.setHeld(a.id, { text: "x", source: "email" }), TypeError);
    assert.equal((await world.manager.get(a.id)).status, "starting", "a refused call changes nothing");

    world.ptys[0].exit(0);
    await ended(world, a.id);
    assert.equal(world.manager.applySignal(a.id, waiting), false, "an ended session takes no signal");
    assert.equal(world.manager.setHeld(a.id, { text: "x", source: "hook" }), false);
  });
});

test("exit with an alert (M3): a session that ends while it waits or is held sends the resolved alert frame just before the exited state; a session with no alert sends none", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    const waiting = await world.manager.create({ agentId: "claude", folder: project });
    const held = await world.manager.create({ agentId: "codex", folder: project });
    const calm = await world.manager.create({ agentId: "cursor", folder: project });
    const winWaiting = await attachFake(world.manager, waiting.id, "a");
    const winHeld = await attachFake(world.manager, held.id, "b");
    const winCalm = await attachFake(world.manager, calm.id, "c");
    for (const pty of world.ptys) pty.emit("ready");
    world.mirrors[0].opts.onAlert("bel");
    assert.equal(world.manager.setHeld(held.id, { text: "Usage limit reached", source: "text" }), true);
    const story = (win) => win.frames.filter((frame) => frame.t === "state" || frame.t === "alert").map((frame) => `${frame.t}:${frame.status ?? frame.kind}`);

    for (const [index, session] of [waiting, held, calm].entries()) {
      world.ptys[index].exit(0);
      await ended(world, session.id);
      await waitFor(() => !world.manager.isLive(session.id));
    }
    assert.deepEqual(story(winWaiting), ["state:starting", "state:live", "state:waiting", "alert:waiting", "alert:resolved", "state:exited"]);
    assert.deepEqual(story(winHeld), ["state:starting", "state:live", "state:held", "alert:limit", "alert:resolved", "state:exited"]);
    assert.deepEqual(story(winCalm), ["state:starting", "state:live", "state:exited"], "no alert, no resolved frame");
    assert.deepEqual(winWaiting.frames.at(-1), { t: "state", status: "exited", exitCode: 0, signal: null, endedBy: null });
    assert.deepEqual(winWaiting.frames.filter((frame) => frame.t === "alert").at(-1), { t: "alert", kind: "resolved", text: "" });
    assert.equal((await world.manager.get(waiting.id)).alert, null, "the ended session's summary has no alert");
    await markersOnDisk(agentOsHome, waiting.id, 1);
  });
});

// ---- windows: attach, writer and viewers, flow control -------------------------------------------

test("attach: snapshot first, then the state, then output; output that arrives while the snapshot is taken is neither lost nor sent twice; a bell reaches the window as the waiting state and one alert frame", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const pty = world.ptys[0];
    const mirror = world.mirrors[0];
    pty.emit("before ");

    let release;
    mirror.snapshotGate = new Promise((resolve) => {
      release = resolve;
    });
    const frames = [];
    const attaching = world.manager.attach(summary.id, { id: "w", send: (frame) => frames.push(frame), close() {} });
    pty.emit("during "); // arrives while the snapshot is being taken
    release();
    const { snapshot } = await attaching;
    pty.emit("after");

    assert.equal(snapshot.data, "before ");
    assert.deepEqual(frames.map((frame) => frame.t), ["snapshot", "state", "out", "out"]);
    assert.deepEqual(frames[0], { t: "snapshot", data: "before ", cols: 120, rows: 32, modes: FAKE_MODES });
    assert.deepEqual(frames[1], { t: "state", status: "live" });
    assert.deepEqual(frames.slice(2).map((frame) => frame.d), ["during ", "after"]);
    assert.deepEqual(frames.slice(2).map((frame) => frame.seq), [7, 12]);

    mirror.opts.onAlert("bel");
    mirror.opts.onAlert("9;Build finished"); // the same basic alert again: nothing new to send
    assert.deepEqual(frames.slice(4), [
      { t: "state", status: "waiting" },
      { t: "alert", kind: "waiting", text: "May need you" }
    ]);
    assert.equal(frames.some((frame) => "raw" in frame), false, "SP3's raw alert frame is gone");
    assert.deepEqual(world.recorders[0].outputs, ["before ", "during ", "after"], "the recording gets every byte");
    await markersOnDisk(agentOsHome, summary.id, 1);
  });
});

test("attach: a snapshot that never comes ends the attach after the time limit, so the window's place and the pause for slow windows are not held (blank-terminal fix)", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld({ attachSnapshotMs: 100 });
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const pty = world.ptys[0];
    const mirror = world.mirrors[0];
    await attachFake(world.manager, summary.id, "w1"); // never acks
    mirror.snapshotGate = new Promise(() => {}); // the second window's snapshot never comes
    const frames = [];
    const attaching = world.manager.attach(summary.id, { id: "w2", send: (frame) => frames.push(frame), close() {} });
    pty.emit("x".repeat(PAUSE_LAG_BYTES + 1));
    assert.equal(pty.paused, false, "a window still attaching keeps the terminal running");

    const outcome = await Promise.race([
      attaching.then(
        () => "attached",
        (error) => error
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2000))
    ]);
    assert.ok(outcome instanceof Error, `the attach fails (got ${String(outcome)}), so its socket closes with attach_failed`);
    assert.notEqual(outcome.code, "session_ended");
    assert.deepEqual(frames, [], "nothing was sent to that window");
    assert.equal(pty.paused, true, "with that window gone, the one that lags pauses the terminal again");

    mirror.snapshotGate = null;
    const again = await attachFake(world.manager, summary.id, "w2");
    assert.equal(again.frames[0].t, "snapshot", "the same window can attach again: its old place is gone");
  });
});

test("two windows: only the focused one types and sets the size, the other's keys are dropped, and the mirror answers terminal queries only while no window is the writer", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const pty = world.ptys[0];
    const mirror = world.mirrors[0];
    const w1 = await attachFake(world.manager, summary.id, "w1");
    const w2 = await attachFake(world.manager, summary.id, "w2");
    assert.equal(mirror.writerAttached, false);

    mirror.opts.onQueryReply("\x1b[?1;2c"); // the mirror answers DA1 while no window is the writer
    assert.deepEqual(pty.writes, ["\x1b[?1;2c"]);

    assert.equal(world.manager.write(summary.id, "w1", "a"), false, "nobody has focused yet");
    assert.equal(world.manager.focus(summary.id, "w1"), true);
    assert.equal(mirror.writerAttached, true);
    assert.equal(world.manager.write(summary.id, "w1", "a"), true);
    assert.equal(world.manager.write(summary.id, "w2", "b"), false, "a viewer's keys are dropped");
    assert.equal(world.manager.resize(summary.id, "w2", 80, 24), false, "a viewer's size is ignored");
    assert.equal(world.manager.resize(summary.id, "w1", 100, 30), true);
    for (const [cols, rows] of [[1, 30], [501, 30], [100, 0], [100, 201], [10.5, 20], ["80", 24]]) {
      assert.equal(world.manager.resize(summary.id, "w1", cols, rows), false, `${cols}x${rows} is ignored`);
    }
    assert.deepEqual(pty.resizes, [[100, 30]]);
    assert.deepEqual([mirror.cols, mirror.rows], [100, 30]);
    assert.deepEqual(world.recorders[0].resizes, [[100, 30]], "the recording keeps each applied size");

    assert.equal(world.manager.focus(summary.id, "w2"), true); // the other window gains focus
    assert.equal(world.manager.write(summary.id, "w1", "c"), false);
    assert.equal(world.manager.write(summary.id, "w2", "d"), true);
    assert.equal(world.manager.write(summary.id, "w2", "x".repeat(MAX_INPUT_BYTES + 1)), false, "a frame over 64 KB is refused");
    assert.equal(world.manager.write(summary.id, "w2", "é".repeat(MAX_INPUT_BYTES / 2)), true, "64 KB of UTF-8 is fine");
    assert.deepEqual(pty.writes.slice(0, 3), ["\x1b[?1;2c", "a", "d"]);

    w2.detach(); // the writer's window closes
    assert.equal(mirror.writerAttached, false, "with no writer the mirror answers queries again");
    assert.equal(world.manager.write(summary.id, "w2", "e"), false);
    assert.equal(world.manager.write(summary.id, "w1", "f"), false, "a viewer does not become the writer without focus");
    assert.equal(world.manager.focus(summary.id, "nobody"), false);
    assert.equal(world.manager.focus(crypto.randomUUID(), "w1"), false);
    assert.deepEqual(world.recorders[0].outputs, [], "typed input and the mirror's query replies are never recorded (Security 5)");
    w1.detach();
  });
});

test("back-pressure: seq counts UTF-8 bytes; the PTY pauses only when every window lags over 512 KB, resumes when one catches up, never with no windows; a window 4 MB behind is closed and can attach again", async () => {
  await withSessionEnv(async ({ project }) => {
    assert.equal(PAUSE_LAG_BYTES, 512 * 1024);
    assert.equal(CLOSE_LAG_BYTES, 4 * 1024 * 1024);
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const pty = world.ptys[0];
    const w1 = await attachFake(world.manager, summary.id, "w1");
    const w2 = await attachFake(world.manager, summary.id, "w2");
    const lastSeq = (win) => outs(win.frames).at(-1).seq;

    pty.emit("é");
    assert.deepEqual(outs(w1.frames).at(-1), { t: "out", seq: 2, d: "é" });
    assert.deepEqual(outs(w2.frames).at(-1), { t: "out", seq: 2, d: "é" });

    const big = "x".repeat(256 * 1024);
    pty.emit(big);
    assert.equal(pty.paused, false, "256 KB behind is fine");
    pty.emit(big);
    assert.equal(pty.paused, true, "both windows are more than 512 KB behind");
    assert.equal(pty.pauseCalls, 1);

    assert.equal(world.manager.ack(summary.id, "w1", lastSeq(w1)), true);
    assert.equal(pty.paused, false, "one window caught up");
    assert.equal(pty.resumeCalls, 1);

    pty.emit(big);
    assert.equal(world.manager.ack(summary.id, "w1", lastSeq(w1)), true);
    assert.equal(pty.paused, false, "w2 lags, but not every window does");

    w1.detach();
    assert.equal(pty.paused, true, "the only open window lags");
    w2.detach();
    assert.equal(pty.paused, false, "never paused with no windows: the mirror and the recording keep reading");
    assert.equal(world.manager.ack(summary.id, "w2", 1), false, "a closed window is gone at once");

    const w3 = await attachFake(world.manager, summary.id, "w3");
    for (let i = 0; i < 16; i += 1) pty.emit(big);
    assert.deepEqual(w3.closes, [], "exactly 4 MB behind is still open");
    pty.emit(big);
    assert.deepEqual(w3.closes, ["too_far_behind"]);
    assert.equal(pty.paused, false, "the closed window left the count at once");
    const sent = outs(w3.frames).length;
    pty.emit("z");
    assert.equal(outs(w3.frames).length, sent, "nothing more goes to a closed window");

    // Its client attaches again and starts over from a fresh snapshot, with seq from 0.
    const again = await attachFake(world.manager, summary.id, "w3");
    assert.deepEqual(again.frames.slice(0, 2).map((frame) => frame.t), ["snapshot", "state"]);
    pty.emit("q");
    assert.deepEqual(outs(again.frames).at(-1), { t: "out", seq: 1, d: "q" });
    assert.equal(pty.paused, false);
    again.detach();
  });
});

test("back-pressure: a PTY paused for 10 s closes the windows that still lag and reads again, so a hidden or sleeping window never stalls the agent; a window leaving does not restart the 10 s", async (t) => {
  await withSessionEnv(async ({ project }) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(PAUSED_DROP_MS, 10000);
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const pty = world.ptys[0];

    // A hidden window that never acks: once the PTY pauses, no more output
    // reaches it, so it could never become 4 MB behind on its own.
    const hidden = await attachFake(world.manager, summary.id, "hidden");
    pty.emit("x".repeat(PAUSE_LAG_BYTES + 1));
    assert.equal(pty.paused, true);
    assert.equal(pty.pauseCalls, 1);

    t.mock.timers.tick(PAUSED_DROP_MS - 1);
    assert.deepEqual(hidden.closes, [], "still open just before 10 s");
    assert.equal(pty.paused, true);
    t.mock.timers.tick(1);
    assert.deepEqual(hidden.closes, ["too_far_behind"], "its client reattaches with a fresh snapshot");
    assert.equal(pty.paused, false);
    assert.equal(pty.resumeCalls, 1);
    assert.equal(world.manager.ack(summary.id, "hidden", 1), false, "the closed window is gone");

    // A window that catches up in time keeps its place, and the timer stops.
    const awake = await attachFake(world.manager, summary.id, "awake");
    pty.emit("y".repeat(PAUSE_LAG_BYTES + 1));
    assert.equal(pty.paused, true);
    assert.equal(pty.pauseCalls, 2);
    t.mock.timers.tick(PAUSED_DROP_MS - 1);
    assert.equal(world.manager.ack(summary.id, "awake", outs(awake.frames).at(-1).seq), true);
    assert.equal(pty.paused, false);
    assert.equal(pty.resumeCalls, 2);
    t.mock.timers.tick(PAUSED_DROP_MS);
    assert.deepEqual(awake.closes, [], "a PTY that read again never closes a window later");
    awake.detach();

    // Two windows that both stop reading: when one of them leaves during the
    // pause, the timer keeps counting from the pause.
    const leaves = await attachFake(world.manager, summary.id, "leaves");
    const stays = await attachFake(world.manager, summary.id, "stays");
    pty.emit("z".repeat(PAUSE_LAG_BYTES + 1));
    assert.equal(pty.paused, true);
    assert.equal(pty.pauseCalls, 3);
    t.mock.timers.tick(PAUSED_DROP_MS / 2);
    leaves.detach();
    assert.equal(pty.paused, true, "the window that stays still lags");
    t.mock.timers.tick(PAUSED_DROP_MS / 2 - 1);
    assert.deepEqual(stays.closes, []);
    t.mock.timers.tick(1);
    assert.deepEqual(stays.closes, ["too_far_behind"], "10 s after the pause began, not 10 s after the other window left");
    assert.deepEqual(leaves.closes, [], "a window that left by itself is not closed again");
    assert.equal(pty.paused, false);
    assert.equal(pty.resumeCalls, 3);
  });
});

// ---- the update kind ------------------------------------------------------------------------------

test("update kind: not gated, not counted, one at a time, hidden from the default list, named in the quit check, never resumed", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    world.gate = false; // Look only does not block the updater
    await assert.rejects(
      world.manager.createUpdateSession({ agentId: "bash", folder: project }),
      (error) => error.status === 400 && error.code === "unknown_agent"
    );
    await assert.rejects(
      world.manager.createUpdateSession({ agentId: "claude", folder: project }),
      (error) =>
        error.status === 400 && error.code === "update_not_available" && error.message === "Only Hermes is updated in a session."
    );
    await assert.rejects(
      world.manager.createUpdateSession({ agentId: "hermes", folder: "/etc" }),
      (error) => error.status === 400 && error.code === "folder_refused"
    );
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    assert.equal(update.kind, "update");
    assert.equal(update.brain, null);
    assert.deepEqual(update.resume, { available: false, reason: null, fallback: false });
    const input = world.profileInputs[0];
    assert.equal(input.kind, "update");
    assert.equal(input.resume, null);
    assert.equal(input.brain, null);
    assert.deepEqual(world.ptys[0].opts.args, ["update"]);

    await assert.rejects(
      world.manager.createUpdateSession({ agentId: "hermes", folder: project }),
      (error) =>
        error.status === 409 &&
        error.code === "update_running" &&
        error.message === "An update is already running. Wait for it to finish, then try again."
    );
    assert.deepEqual(await world.manager.list(), []);
    assert.deepEqual(
      (await world.manager.list({ includeUpdate: true })).map((summary) => [summary.id, summary.kind]),
      [[update.id, "update"]]
    );
    assert.deepEqual((await world.manager.quitCheck()).live, [{ id: update.id, title: "Hermes update", kind: "update" }]);

    world.ptys[0].exit(0);
    await ended(world, update.id);
    await assert.rejects(
      world.manager.resume(update.id),
      (error) => error.status === 409 && error.code === "not_resumable" && error.message === "An update session can't be resumed."
    );
    assert.equal((await world.manager.createUpdateSession({ agentId: "hermes", folder: project })).status, "starting");
  });
});

// ---- the live-only list (Task S10, fix round 1) ------------------------------------------------------

test("list({ liveOnly }): only the sessions that are running, from memory: no ended session is read and no agent is detected", async () => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    const detected = [];
    const world = fakeWorld({
      detect: async (agentId) => {
        detected.push(agentId);
        return { installed: true, path: `/fake/bin/${agentId}` };
      }
    });
    world.gate = true;
    const running = await world.manager.create({ agentId: "claude", folder: project });
    const finished = await world.manager.create({ agentId: "codex", folder: other });
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    world.ptys[1].exit(0);
    await ended(world, finished.id);
    // An ended session on disk that this manager never held (a session from before a restart).
    const old = crypto.randomUUID();
    await mkdir(path.join(agentOsHome, "sessions", old), { recursive: true });
    await writeFile(
      path.join(agentOsHome, "sessions", old, "meta.json"),
      JSON.stringify({ id: old, kind: "agent", agentId: "cursor", agentLabel: "Cursor", folder: other, folderName: "other", status: "exited", startedAt: "2026-10-13T09:00:00.000Z" })
    );
    detected.length = 0;

    const agents = await world.manager.list({ liveOnly: true });
    assert.deepEqual(agents.map((summary) => summary.id), [running.id], "the agent kind unless includeUpdate; the ended ones are left out");
    const both = await world.manager.list({ includeUpdate: true, liveOnly: true });
    assert.deepEqual(both.map((summary) => [summary.id, summary.kind, summary.status !== "exited"]), [
      [running.id, "agent", true],
      [update.id, "update", true]
    ]);
    for (const summary of both) {
      assert.deepEqual(Object.keys(summary), SUMMARY_KEYS, "the same summary as every other list");
      assert.equal(summary.resume.available, false);
    }
    assert.deepEqual(detected, [], "no agent CLI was asked anything: a slow one cannot delay the emergency stop's list");

    // The ordinary list still reads the ended sessions and detects their agents for Resume.
    const everything = await world.manager.list({ includeUpdate: true });
    assert.equal(everything.length, 4);
    assert.deepEqual([...detected].sort(), ["codex", "cursor"]);

    // A session that has ended while its process is still being cleared away is not running either.
    world.ptys[0].exit(0);
    await ended(world, running.id);
    assert.deepEqual((await world.manager.list({ includeUpdate: true, liveOnly: true })).map((summary) => summary.id), [update.id]);
  });
});

// ---- dismiss, recovery, resume --------------------------------------------------------------------

test("dismiss: refused while live; an ended session is hidden and stays hidden after a restart", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    await assert.rejects(
      world.manager.dismiss(summary.id),
      (error) =>
        error.status === 409 && error.code === "session_live" && error.message === "That session is still running. Stop it first, then dismiss it."
    );
    world.ptys[0].exit(0);
    // Right after the end, while the recording is still being closed: Dismiss waits, never refuses.
    assert.equal((await world.manager.dismiss(summary.id)).dismissed, true);
    assert.equal((await world.manager.dismiss(summary.id)).dismissed, true, "dismissing twice is harmless");

    const restarted = createSessionManager(world.deps);
    const after = await restarted.get(summary.id);
    assert.equal(after.dismissed, true);
    assert.equal(after.resume.available, true, "Resume stays available from Runs");
    await assert.rejects(restarted.dismiss(crypto.randomUUID()), (error) => error.status === 404 && error.code === "unknown_session");
  });
});

test("restart after a hard kill: sessions still marked running come back ended by quit with Resume; when a folder is gone, Resume refuses with the folder sentence and the recent folders drop it", async () => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    const world = fakeWorld();
    const a = await world.manager.create({ agentId: "claude", folder: project });
    const b = await world.manager.create({ agentId: "hermes", folder: other });

    // Agent OS was killed hard: no exit handler ran. The next start reads the same folder.
    world.clock = Date.parse("2026-10-14T10:00:00.000Z");
    const restarted = createSessionManager(world.deps);
    assert.deepEqual(await restarted.recoverStaleSessions(), { recovered: 2 });
    const listed = await restarted.list();
    assert.equal(listed.length, 2);
    for (const summary of listed) {
      assert.equal(summary.status, "exited");
      assert.equal(summary.endedBy, "quit");
      // Nothing was ever recorded, so the last known time is the start, not
      // this restart (10:00).
      assert.equal(summary.endedAt, "2026-10-14T09:00:00.000Z");
      assert.equal(summary.exitCode, null);
      assert.equal(summary.signal, null);
      assert.equal(summary.resume.available, true);
    }
    const meta = await metaOnDisk(agentOsHome, a.id);
    assert.equal(meta.status, "exited");
    assert.equal(meta.endedBy, "quit");
    assert.deepEqual(await restarted.recoverStaleSessions(), { recovered: 0 }, "a second recovery changes nothing");

    // A broken meta.json is skipped, never a crash.
    const broken = path.join(agentOsHome, "sessions", crypto.randomUUID());
    await mkdir(broken);
    await writeFile(path.join(broken, "meta.json"), "{not json");
    assert.deepEqual(await restarted.recoverStaleSessions(), { recovered: 0 });
    assert.equal((await restarted.list()).length, 2);

    // The New session dialog's recent folders (Task S2) read these meta.json files.
    const recentPaths = async () => (await recentSessionFolders()).map((folder) => folder.path);
    if (!isWindows) assert.deepEqual((await recentPaths()).sort(), [other, project].sort());

    // The folder was deleted: Resume refuses with the folder policy's own
    // sentence, and the recent folders no longer offer it.
    await rm(other, { recursive: true, force: true });
    await assert.rejects(
      restarted.resume(b.id),
      (error) =>
        error.status === 400 && error.code === "folder_refused" && error.extra.code === "missing" && error.message === "That folder doesn't exist."
    );
    if (!isWindows) assert.deepEqual(await recentPaths(), [project]);
    assert.equal((await restarted.resume(a.id)).status, "starting");
  });
});

test("restart: a session whose exit was never recorded ended when it last wrote (its recording, else its status time, else its start), not when Agent OS restarted", async () => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    const world = fakeWorld();
    const a = await world.manager.create({ agentId: "claude", folder: project });
    const b = await world.manager.create({ agentId: "claude", folder: other });
    const c = await world.manager.create({ agentId: "claude", folder: other });
    const dirOf = (id) => path.join(agentOsHome, "sessions", id);

    // Agent OS was killed on Monday, and restarted on Friday.
    const lastWrite = new Date("2026-10-14T09:42:17.000Z");
    const cast = path.join(dirOf(a.id), "screen.cast");
    await writeFile(cast, '{"version":2,"width":120,"height":32,"timestamp":1791968400}\n');
    await utimes(cast, lastWrite, lastWrite);
    // b has no recording, but its meta.json names when its status last changed.
    const bMeta = await metaOnDisk(agentOsHome, b.id);
    await writeFile(path.join(dirOf(b.id), "meta.json"), JSON.stringify({ ...bMeta, stateSince: "2026-10-14T09:30:00.000Z" }));
    world.clock = Date.parse("2026-10-17T08:00:00.000Z");

    const restarted = createSessionManager(world.deps);
    assert.deepEqual(await restarted.recoverStaleSessions(), { recovered: 3 });
    const endedAt = async (id) => (await restarted.get(id)).endedAt;
    assert.equal(await endedAt(a.id), "2026-10-14T09:42:17.000Z", "the recording's last write");
    assert.equal(await endedAt(b.id), "2026-10-14T09:30:00.000Z", "no recording: when its status last changed");
    assert.equal(await endedAt(c.id), "2026-10-14T09:00:00.000Z", "neither: when it started");
    const meta = await metaOnDisk(agentOsHome, a.id);
    assert.equal(meta.endedAt, "2026-10-14T09:42:17.000Z");
    assert.equal(meta.lastUsedAt, "2026-10-14T09:42:17.000Z");
    assert.equal(meta.endedBy, "quit");
  });
});

test("restart: a meta.json that can't be rewritten is reported once and never stops the sessions after it from being recovered", async (t) => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    const world = fakeWorld();
    for (const folder of [project, other, project]) await world.manager.create({ agentId: "claude", folder });
    // The first one the recovery meets is the one it can't write.
    const ids = (await readdir(path.join(agentOsHome, "sessions"))).filter((name) => isSessionId(name));
    assert.equal(ids.length, 3);
    const stuck = ids[0];
    const stuckFile = path.join(agentOsHome, "sessions", stuck, "meta.json");

    const reported = t.mock.method(console, "error", () => {});
    const restarted = createSessionManager({
      ...world.deps,
      writeJson: async (file, data) => {
        if (file === stuckFile) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        return writeJson(file, data);
      }
    });
    assert.deepEqual(await restarted.recoverStaleSessions(), { recovered: 2 });
    assert.equal(reported.mock.calls.length, 1, "each failure is reported once");
    const line = String(reported.mock.calls[0].arguments[0]);
    assert.ok(line.includes(stuck) && line.includes("EACCES"), line);
    const byStatus = (await restarted.list()).map((summary) => [summary.id === stuck, summary.status]);
    assert.deepEqual(byStatus.filter(([isStuck]) => !isStuck).map(([, status]) => status), ["exited", "exited"]);
    assert.deepEqual(byStatus.filter(([isStuck]) => isStuck).map(([, status]) => status), ["starting"]);

    // A later start (with a disk that works) picks the one that was left.
    const healthy = createSessionManager(world.deps);
    assert.deepEqual(await healthy.recoverStaleSessions(), { recovered: 1 });
    assert.equal((await healthy.get(stuck)).status, "exited");
  });
});

test("resume: the same id and tab, a new process, the recording continues after a marker, and the status starts again", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    await assert.rejects(world.manager.resume(summary.id), (error) => error.status === 409 && error.code === "session_live");
    world.ptys[0].exit(0);
    await ended(world, summary.id);
    await world.manager.dismiss(summary.id);

    world.clock = Date.parse("2026-10-14T11:00:00.000Z");
    const resumed = await world.manager.resume(summary.id);
    assert.equal(resumed.id, summary.id);
    assert.equal(resumed.status, "starting");
    assert.equal(resumed.startedAt, "2026-10-14T11:00:00.000Z");
    assert.equal(resumed.endedAt, null);
    assert.equal(resumed.exitCode, null);
    assert.equal(resumed.endedBy, null);
    assert.equal(resumed.dismissed, false, "the tab comes back");

    assert.equal(world.ptys.length, 2, "a new process");
    assert.equal(world.recorders[1].opts.append, true, "the recording continues after a marker");
    assert.deepEqual(world.recorders[1].markers, [], "the recorder writes that marker itself, never the manager");
    assert.equal(world.recorders[1].opts.dir, world.recorders[0].opts.dir);
    assert.deepEqual(world.profileInputs[1].resume, { agentSessionId: CLAUDE_UUID });
    assert.equal(world.profileInputs[1].sessionId, summary.id);
    assert.equal(world.profileInputs[1].kind, "agent");

    const meta = await metaOnDisk(agentOsHome, summary.id);
    assert.equal(meta.resumes, 1);
    assert.equal(meta.createdAt, "2026-10-14T09:00:00.000Z");
    assert.equal(meta.status, "starting");

    await assert.rejects(world.manager.resume(crypto.randomUUID()), (error) => error.status === 404 && error.code === "unknown_session");
  });
});

test("resume rules: Hermes, Codex and Cursor refuse with a written reason when the folder is shared or busy; Claude resumes by id; a missing agent says so", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    const finish = async (index, id) => {
      world.ptys[index].exit(0);
      await ended(world, id);
    };

    const h1 = await world.manager.create({ agentId: "hermes", folder: project });
    const h2 = await world.manager.create({ agentId: "hermes", folder: project });
    await finish(0, h1.id);
    await finish(1, h2.id);
    const shared = "More than one ended Hermes session used this folder, so Agent OS can't tell which conversation to resume.";
    for (const id of [h1.id, h2.id]) {
      assert.deepEqual((await world.manager.get(id)).resume, { available: false, reason: shared, fallback: true });
    }
    await assert.rejects(
      world.manager.resume(h1.id),
      (error) => error.status === 409 && error.code === "not_resumable" && error.message === shared
    );

    const c1 = await world.manager.create({ agentId: "codex", folder: other });
    await finish(2, c1.id);
    assert.deepEqual((await world.manager.get(c1.id)).resume, { available: true, reason: null, fallback: true });
    await world.manager.create({ agentId: "codex", folder: other }); // live in the same folder
    assert.deepEqual((await world.manager.get(c1.id)).resume, {
      available: false,
      reason: "Another Codex session is open in this folder. Stop it first.",
      fallback: true
    });

    const k1 = await world.manager.create({ agentId: "claude", folder: project });
    const k2 = await world.manager.create({ agentId: "claude", folder: project });
    await finish(4, k1.id);
    await finish(5, k2.id);
    assert.deepEqual((await world.manager.get(k1.id)).resume, { available: true, reason: null, fallback: false });

    world.installed.delete("claude");
    assert.deepEqual((await world.manager.get(k1.id)).resume, {
      available: false,
      reason: "Claude Code isn't installed anymore.",
      fallback: false
    });
    await assert.rejects(
      world.manager.resume(k1.id),
      (error) => error.code === "not_resumable" && error.message === "Claude Code isn't installed anymore."
    );
  });
});

test("resume rules: a Cursor session with an exact chat id resumes by it whatever else is open in its folder; one without an id keeps the fallback rules (spike S6)", async () => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    // What buildSessionProfile answers for Cursor: a new session gets a chat id from `create-chat`
    // (when the call works), a resume gets the id kept in meta.json.
    let chatIds = true;
    const world = fakeWorld({
      buildProfile: async (input) => {
        world.profileInputs.push(input);
        const profile = fakeProfile(input);
        if (input.agentId !== "cursor") return profile;
        const id = input.resume ? input.resume.agentSessionId : chatIds ? crypto.randomUUID() : null;
        return { ...profile, agentSessionId: id, resumeMode: id ? "id" : "fallback" };
      }
    });
    const finish = async (index, id) => {
      world.ptys[index].exit(0);
      await ended(world, id);
    };

    const a = await world.manager.create({ agentId: "cursor", folder: project });
    const b = await world.manager.create({ agentId: "cursor", folder: project });
    const chatA = (await metaOnDisk(agentOsHome, a.id)).agentSessionId;
    const chatB = (await metaOnDisk(agentOsHome, b.id)).agentSessionId;
    assert.match(chatA, SESSION_ID_RE);
    assert.notEqual(chatA, chatB);
    assert.equal((await metaOnDisk(agentOsHome, a.id)).resumeMode, "id");
    // The other Cursor session in the folder is still open: an id resume does not care.
    await finish(0, a.id);
    const idResume = { available: true, reason: null, fallback: false };
    assert.deepEqual((await world.manager.get(a.id)).resume, idResume);
    await finish(1, b.id);
    assert.deepEqual((await world.manager.get(a.id)).resume, idResume, "two ended sessions in one folder are not ambiguous");
    assert.deepEqual((await world.manager.get(b.id)).resume, idResume);

    // Each opens its own chat.
    await world.manager.resume(b.id);
    assert.deepEqual(world.profileInputs.at(-1).resume, { agentSessionId: chatB });
    const resumedB = await metaOnDisk(agentOsHome, b.id);
    assert.deepEqual([resumedB.agentSessionId, resumedB.resumeMode], [chatB, "id"]);
    await world.manager.resume(a.id); // while B is running in the same folder
    assert.deepEqual(world.profileInputs.at(-1).resume, { agentSessionId: chatA });
    assert.equal((await metaOnDisk(agentOsHome, a.id)).agentSessionId, chatA);

    // Sessions with no id (create-chat failed, or saved before it existed) keep the picker and its rules.
    chatIds = false;
    const c = await world.manager.create({ agentId: "cursor", folder: other });
    const d = await world.manager.create({ agentId: "cursor", folder: other });
    assert.deepEqual([(await metaOnDisk(agentOsHome, c.id)).agentSessionId, (await metaOnDisk(agentOsHome, c.id)).resumeMode], [null, "fallback"]);
    await finish(4, c.id);
    assert.deepEqual((await world.manager.get(c.id)).resume, {
      available: false,
      reason: "Another Cursor session is open in this folder. Stop it first.",
      fallback: true
    });
    await finish(5, d.id);
    const shared = "More than one ended Cursor session used this folder, so Agent OS can't tell which conversation to resume.";
    assert.deepEqual((await world.manager.get(c.id)).resume, { available: false, reason: shared, fallback: true });
    await assert.rejects(
      world.manager.resume(c.id),
      (error) => error.status === 409 && error.code === "not_resumable" && error.message === shared
    );
  });
});

test("resume rules: a New session still starting in the same folder counts as open, so a fallback resume refuses instead of resuming the wrong conversation", async () => {
  await withSessionEnv(async ({ other }) => {
    const world = fakeWorld();
    const first = await world.manager.create({ agentId: "codex", folder: other });
    world.ptys[0].exit(0);
    await ended(world, first.id);
    const available = { available: true, reason: null, fallback: true };
    const blocked = {
      available: false,
      reason: "Another Codex session is open in this folder. Stop it first.",
      fallback: true
    };
    assert.deepEqual((await world.manager.get(first.id)).resume, available);

    // A New session in the same folder is still starting: its spawn is held.
    let fail;
    world.spawnGate = new Promise((_, reject) => {
      fail = reject;
    });
    const doomed = world.manager.create({ agentId: "codex", folder: other });
    await waitFor(() => world.spawnCalls === 2);
    assert.deepEqual((await world.manager.get(first.id)).resume, blocked);
    await assert.rejects(
      world.manager.resume(first.id),
      (error) => error.status === 409 && error.code === "not_resumable" && error.message === blocked.reason
    );
    assert.equal(world.spawnCalls, 2, "the resume started nothing");

    // The start fails: it no longer counts, and the same Resume works.
    fail(new Error("posix_spawnp failed."));
    await assert.rejects(doomed, (error) => error.code === "start_failed");
    assert.deepEqual((await world.manager.get(first.id)).resume, available);

    // The Resume itself, held at its spawn, does not block its own session's row.
    let hold;
    world.spawnGate = new Promise((resolve) => {
      hold = resolve;
    });
    const resuming = world.manager.resume(first.id);
    await waitFor(() => world.spawnCalls === 3);
    assert.deepEqual((await world.manager.get(first.id)).resume, available);
    hold();
    assert.equal((await resuming).status, "starting");
  });
});

// ---- a Claude resume with nothing saved (spike S7) ------------------------------------------------

const NOTHING_TO_RESUME =
  "Claude Code has nothing saved for this conversation, so there is nothing to resume. Start a new session in this folder.";
const NO_CONVERSATION_PREFIX = "No conversation found with session ID: ";
const noConversationLine = (uuid = CLAUDE_UUID) => `${NO_CONVERSATION_PREFIX}${uuid}`;

// A Claude session that ended by itself and was then resumed: the next fake PTY is the resumed run.
async function resumedClaude(world, project) {
  const first = await world.manager.create({ agentId: "claude", folder: project });
  world.ptys[0].exit(0);
  await ended(world, first.id);
  await world.manager.resume(first.id);
  return { id: first.id, run: world.ptys[1] };
}

test("nothing to resume: a Claude resume that prints 'No conversation found' for its own id and fails by itself is remembered, shown plainly, survives a restart, and is never offered again", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    const first = await world.manager.create({ agentId: "claude", folder: project });
    assert.equal((await metaOnDisk(agentOsHome, first.id)).nothingToResume, false, "a fresh run starts clean");
    assert.equal(first.nothingToResume, false);
    world.ptys[0].exit(0);
    await ended(world, first.id);
    await world.manager.resume(first.id);

    // The line arrives wrapped in colour codes, then Claude exits 1 at once.
    world.ptys[1].emit(`\x1b[31m${noConversationLine()}\x1b[39m\r\n`);
    world.ptys[1].exit(1);
    const done = await ended(world, first.id);
    assert.equal(done.exitCode, 1);
    assert.equal(done.endedBy, null);
    assert.equal(done.nothingToResume, true);
    assert.deepEqual(done.resume, { available: false, reason: NOTHING_TO_RESUME, fallback: false });
    await waitFor(async () => (await metaOnDisk(agentOsHome, first.id))?.nothingToResume === true);
    assert.equal((await metaOnDisk(agentOsHome, first.id)).exitCode, 1);

    // Resume now refuses with that reason, and starts nothing.
    const spawnsBefore = world.spawnCalls;
    await assert.rejects(
      world.manager.resume(first.id),
      (error) => error.status === 409 && error.code === "not_resumable" && error.message === NOTHING_TO_RESUME
    );
    assert.equal(world.spawnCalls, spawnsBefore, "no process started: no Resume loop");

    // It is a saved fact: a new manager (a restart) reads it from meta.json.
    const restarted = createSessionManager(world.deps);
    const again = await restarted.get(first.id);
    assert.equal(again.nothingToResume, true);
    assert.deepEqual(again.resume, { available: false, reason: NOTHING_TO_RESUME, fallback: false });
    assert.equal((await restarted.list()).find((row) => row.id === first.id).nothingToResume, true);
  });
});

test("nothing to resume: the line is found when colour codes or the words are split between chunks, after other output inside the first 16 KB, and even when more output follows it", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const { id, run } = await resumedClaude(world, project);
    run.emit("x".repeat(10 * 1024));
    run.emit("\x1b[1;3"); // an escape code cut in two
    run.emit(`1mNo conversation found wi`);
    run.emit(`th session ID: ${CLAUDE_UUID}\x1b[0m`);
    run.emit("y".repeat(20 * 1024)); // more output after the line does not undo it
    run.exit(1);
    const done = await ended(world, id);
    assert.equal(done.nothingToResume, true);
    assert.equal(done.resume.available, false);
  });
});

test("nothing to resume: the line is found even when more than 4 KB of other output follows it in the same chunk", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const { id, run } = await resumedClaude(world, project);
    // One chunk: the line, then 5000 more characters. The search must run before the 4 KB tail is cut.
    run.emit(`${noConversationLine()}\r\n${"z".repeat(5000)}`);
    run.exit(1);
    const done = await ended(world, id);
    assert.equal(done.nothingToResume, true);
    assert.equal(done.resume.available, false);
  });
});

test("nothing to resume: only the start of the run is watched, so the text printed after more than 16 KB of other output (a real conversation quoting it) is ignored", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const { id, run } = await resumedClaude(world, project);
    for (let i = 0; i < 5; i += 1) run.emit("q".repeat(4096)); // 20 KB, past the 16 KB window
    run.emit(`${noConversationLine()}\r\n`);
    run.exit(1);
    const done = await ended(world, id);
    assert.equal(done.exitCode, 1);
    assert.equal(done.nothingToResume, false);
    assert.equal(done.resume.available, true);
  });
});

test("nothing to resume: only the last 4 KB of raw output is kept, so a line whose two halves are more than 4 KB apart (escape codes between them) is not found", async () => {
  await withSessionEnv(async ({ project }) => {
    // Control: the same split, with only a few escape codes between the halves, is found.
    let world = fakeWorld();
    let { id, run } = await resumedClaude(world, project);
    run.emit(NO_CONVERSATION_PREFIX);
    run.emit("\x1b[0m".repeat(10));
    run.emit(CLAUDE_UUID);
    run.exit(1);
    let done = await ended(world, id);
    assert.equal(done.nothingToResume, true);

    // 1100 x 4 = 4400 characters of escape codes (they strip away to nothing) push the first half
    // out of the kept tail, still well inside the 16 KB window.
    world = fakeWorld();
    ({ id, run } = await resumedClaude(world, project));
    run.emit(NO_CONVERSATION_PREFIX);
    run.emit("\x1b[0m".repeat(1100));
    run.emit(CLAUDE_UUID);
    run.exit(1);
    done = await ended(world, id);
    assert.equal(done.exitCode, 1);
    assert.equal(done.nothingToResume, false);
    assert.equal(done.resume.available, true);
  });
});

test("nothing to resume: not set when the run exits 0, is ended by a signal, or is stopped or quit by Agent OS (even with exit code 1)", async () => {
  await withSessionEnv(async ({ project }) => {
    // Exit code 0: a normal end.
    let world = fakeWorld();
    let { id, run } = await resumedClaude(world, project);
    run.emit(`${noConversationLine()}\r\n`);
    run.exit(0);
    let done = await ended(world, id);
    assert.equal(done.nothingToResume, false);
    assert.deepEqual(done.resume, { available: true, reason: null, fallback: false });

    // Ended by a signal: no exit code at all.
    world = fakeWorld();
    ({ id, run } = await resumedClaude(world, project));
    run.emit(`${noConversationLine()}\r\n`);
    run.exit(0, 15);
    done = await ended(world, id);
    assert.equal(done.signal, "SIGTERM");
    assert.equal(done.nothingToResume, false);

    // A Stop during the run: the person ended it.
    world = fakeWorld({ softStop: async () => ({ outcome: "none", note: null }) });
    ({ id, run } = await resumedClaude(world, project));
    run.emit(`${noConversationLine()}\r\n`);
    const stopping = world.manager.stop(id);
    run.exit(1);
    await stopping;
    done = await ended(world, id);
    assert.equal(done.endedBy, "stop");
    assert.equal(done.exitCode, 1);
    assert.equal(done.nothingToResume, false);
    assert.equal(done.resume.available, true);

    // A quit during the run.
    world = fakeWorld({ softStop: async () => ({ outcome: "none", note: null }) });
    ({ id, run } = await resumedClaude(world, project));
    run.emit(`${noConversationLine()}\r\n`);
    const quitting = world.manager.shutdownAll({ reason: "quit" });
    run.exit(1);
    await quitting;
    done = await ended(world, id);
    assert.equal(done.endedBy, "quit");
    assert.equal(done.nothingToResume, false);
  });
});

test("nothing to resume: not set for a different conversation id, for a fresh session that prints the line, for text that only looks like it, or for another agent's resume", async () => {
  await withSessionEnv(async ({ project, other }) => {
    // The line names another conversation.
    let world = fakeWorld();
    let { id, run } = await resumedClaude(world, project);
    run.emit(`${noConversationLine(crypto.randomUUID())}\r\n`);
    run.exit(1);
    let done = await ended(world, id);
    assert.equal(done.exitCode, 1);
    assert.equal(done.nothingToResume, false);
    assert.equal(done.resume.available, true);

    // Only the start of the line, or the words without the id.
    world = fakeWorld();
    ({ id, run } = await resumedClaude(world, project));
    run.emit("No conversation found with session ID: \r\nno conversation found\r\n");
    run.exit(1);
    done = await ended(world, id);
    assert.equal(done.nothingToResume, false);

    // A fresh session (not a resume) that prints the very line and fails.
    world = fakeWorld();
    const fresh = await world.manager.create({ agentId: "claude", folder: project });
    world.ptys[0].emit(`${noConversationLine()}\r\n`);
    world.ptys[0].exit(1);
    done = await ended(world, fresh.id);
    assert.equal(done.exitCode, 1);
    assert.equal(done.nothingToResume, false);
    assert.equal(done.resume.available, true);

    // Another agent's resume is never watched, even one that has an agent session id (Hermes's
    // is its own `agentos-<id>`) and prints the very same sentence for it.
    const HERMES_ID = "agentos-test-conversation";
    world = fakeWorld({ buildProfile: async (input) => ({ ...fakeProfile(input), agentSessionId: HERMES_ID }) });
    const hermes = await world.manager.create({ agentId: "hermes", folder: other });
    world.ptys[0].exit(0);
    await ended(world, hermes.id);
    await world.manager.resume(hermes.id);
    world.ptys[1].emit(`${noConversationLine(HERMES_ID)}\r\n`);
    world.ptys[1].exit(1);
    done = await ended(world, hermes.id);
    assert.equal(done.exitCode, 1);
    assert.equal(done.nothingToResume, false);
    assert.equal(done.resume.available, true);
  });
});

test("nothing to resume: an older meta.json without the field reads as false and can be resumed, a true written by hand refuses Resume, and the new run writes the field false", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    const { id, run } = await resumedClaude(world, project);
    run.emit(`${noConversationLine()}\r\n`);
    run.exit(1);
    await ended(world, id);
    await waitFor(async () => (await metaOnDisk(agentOsHome, id))?.nothingToResume === true);

    // An older meta.json (before this field) has no key at all.
    const metaPath = path.join(agentOsHome, "sessions", id, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    delete meta.nothingToResume;
    await writeFile(metaPath, `${JSON.stringify(meta)}\n`);
    const reader = createSessionManager(world.deps);
    const old = await reader.get(id);
    assert.equal(old.nothingToResume, false);
    assert.equal(old.resume.available, true);

    // Resuming it works and writes the field false into the new run's meta.json.
    meta.nothingToResume = true; // as if set by hand: Resume is refused while it says true
    await writeFile(metaPath, `${JSON.stringify(meta)}\n`);
    await assert.rejects(reader.resume(id), (error) => error.code === "not_resumable");
    delete meta.nothingToResume;
    await writeFile(metaPath, `${JSON.stringify(meta)}\n`);
    const resumedAgain = await reader.resume(id);
    assert.equal(resumedAgain.nothingToResume, false);
    assert.equal((await metaOnDisk(agentOsHome, id)).nothingToResume, false);
  });
});

test("resume: the recording is opened only after the spawn, so a recording cap that runs during the spawn never leaves a resumed session writing into a deleted file", async () => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    const capRuns = [];
    let capBytes = 1024 * 1024 * 1024;
    const world = fakeWorld({
      recorderFactory: createRecorder,
      // The real cap, with the manager's own isLive; capBytes = 0 stands for a disk over 1 GB.
      enforceCap: (options) => {
        const run = enforceRecordingCap({ ...options, capBytes });
        capRuns.push(run);
        return run;
      }
    });
    const castOf = (id) => path.join(agentOsHome, "sessions", id, "screen.cast");
    const castText = async (id) => readFile(castOf(id), "utf8").catch(() => "");
    const a = await world.manager.create({ agentId: "claude", folder: project });
    world.ptys[0].emit("first run\r\n");
    await waitFor(async () => (await castText(a.id)).includes("first run"));
    world.ptys[0].exit(0);
    await settled(agentOsHome, a.id);
    await waitFor(() => capRuns.length === 1);
    await Promise.all(capRuns);
    assert.ok((await castText(a.id)).includes("first run"), "an ended recording under the cap is kept");

    // Another session is running. Resume the ended one, with its spawn held.
    const b = await world.manager.create({ agentId: "codex", folder: other });
    let release;
    world.spawnGate = new Promise((resolve) => {
      release = resolve;
    });
    const resuming = world.manager.resume(a.id);
    await waitFor(() => world.spawnCalls === 3);

    // While it spawns, the other session ends and the cap runs over 1 GB.
    capBytes = 0;
    world.ptys[1].exit(0);
    await settled(agentOsHome, b.id);
    await waitFor(() => capRuns.length === 2);
    await capRuns[1];
    release();
    const resumed = await resuming;
    assert.equal(resumed.status, "starting");
    assert.equal(world.manager.isLive(a.id), true);

    // Everything the resumed agent prints is in a recording that exists.
    world.ptys[2].emit("after resume\r\n");
    await waitFor(async () => (await castText(a.id)).includes("after resume"));
    assert.ok((await castText(a.id)).includes("--- resumed ---"));

    // And while it runs, the cap leaves it alone: a third session ends over the cap.
    const c = await world.manager.create({ agentId: "hermes", folder: other });
    world.ptys[3].exit(0);
    await settled(agentOsHome, c.id);
    await waitFor(() => capRuns.length === 3);
    await capRuns[2];
    assert.ok((await castText(a.id)).includes("after resume"), "a running session's recording is never removed");

    world.ptys[2].exit(0);
    await settled(agentOsHome, a.id);
    await waitFor(() => capRuns.length === 4);
    await Promise.all(capRuns);
  });
});

test("resume: a start that fails never touches the recording, and a start that can't be saved is stopped", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const castOf = (id) => path.join(agentOsHome, "sessions", id, "screen.cast");
    let failSpawn = false;
    let failWrites = 0;
    const world = fakeWorld({
      recorderFactory: createRecorder,
      spawn: async (options) => {
        if (failSpawn) throw new Error("posix_spawnp failed.");
        const pty = fakePty(world.nextPid, options);
        world.nextPid += 1;
        world.ptys.push(pty);
        return pty;
      },
      writeJson: async (file, data) => {
        if (failWrites > 0) {
          failWrites -= 1;
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return writeJson(file, data);
      }
    });
    const a = await world.manager.create({ agentId: "claude", folder: project });
    world.ptys[0].emit("first run\r\n");
    await waitFor(async () => (await readFile(castOf(a.id), "utf8").catch(() => "")).includes("first run"));
    world.ptys[0].exit(0);
    await settled(agentOsHome, a.id);
    const recorded = await readFile(castOf(a.id), "utf8");

    // The spawn fails: no marker, no resize event, nothing is added to the recording.
    failSpawn = true;
    await assert.rejects(world.manager.resume(a.id), (error) => error.code === "start_failed");
    failSpawn = false;
    assert.equal(await readFile(castOf(a.id), "utf8"), recorded, "the recording is exactly as it was");
    assert.equal((await world.manager.get(a.id)).status, "exited");

    // The agent starts, but its first meta.json write fails: it is stopped, and the session stays ended.
    failWrites = 1;
    await assert.rejects(
      world.manager.resume(a.id),
      (error) =>
        error.status === 500 &&
        error.code === "start_failed" &&
        error.message === "Agent OS could not save this session, so it was stopped. Check the free disk space, then try again."
    );
    assert.deepEqual(world.kills, [[41001, { graceMs: 3000 }]]);
    assert.equal(world.manager.isLive(a.id), false);
    assert.equal((await world.manager.get(a.id)).status, "exited");
    assert.equal((await metaOnDisk(agentOsHome, a.id)).resumes, 0, "the saved session is as it was");
    assert.deepEqual((await world.manager.quitCheck()).live, []);

    // Nothing stays busy: the next resume works.
    const again = await world.manager.resume(a.id);
    assert.equal(again.status, "starting");
    world.ptys[2].exit(0);
    await ended(world, a.id);
  });
});

test("create: a first meta.json write that fails stops the process, frees its slot and leaves no folder, with the save sentence", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    let failWrites = 1;
    const world = fakeWorld({
      maxLive: 1,
      writeJson: async (file, data) => {
        if (failWrites > 0) {
          failWrites -= 1;
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return writeJson(file, data);
      }
    });
    await assert.rejects(
      world.manager.create({ agentId: "claude", folder: project }),
      (error) =>
        error.status === 500 &&
        error.code === "start_failed" &&
        error.message === "Agent OS could not save this session, so it was stopped. Check the free disk space, then try again."
    );
    assert.deepEqual(world.kills, [[41000, { graceMs: 3000 }]], "the process tree is stopped");
    assert.equal(world.recorders[0].closed, true);
    assert.equal(world.mirrors[0].disposed, true);
    assert.deepEqual((await world.manager.quitCheck()).live, []);
    assert.deepEqual(await world.manager.list(), []);
    assert.deepEqual(await readdir(path.join(agentOsHome, "sessions")), [], "no session folder was left behind");

    // The only slot (maxLive 1) is free again.
    const next = await world.manager.create({ agentId: "claude", folder: project });
    assert.equal(next.status, "starting");
    assert.equal(world.kills.length, 1);
  });
});

test("resume: a second resume or dismiss of a session that is already being changed gets session_busy, not 'still running', and only one agent starts", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    world.ptys[0].exit(0);
    await ended(world, summary.id);
    const isBusy = (error) =>
      error.status === 409 && error.code === "session_busy" && error.message === "This session is already being changed. Try again in a moment.";

    // A double click on Resume.
    const twice = await Promise.allSettled([world.manager.resume(summary.id), world.manager.resume(summary.id)]);
    assert.deepEqual(twice.map((result) => result.status), ["fulfilled", "rejected"]);
    assert.ok(isBusy(twice[1].reason), twice[1].reason?.message);
    assert.equal(world.ptys.length, 2, "exactly one agent was started");
    // Once it runs, "still running" is the true answer again.
    await assert.rejects(world.manager.resume(summary.id), (error) => error.code === "session_live");
    await assert.rejects(world.manager.dismiss(summary.id), (error) => error.code === "session_live");

    // A double click on Dismiss.
    world.ptys[1].exit(0);
    await ended(world, summary.id);
    const dismissed = await Promise.allSettled([world.manager.dismiss(summary.id), world.manager.dismiss(summary.id)]);
    assert.deepEqual(dismissed.map((result) => result.status), ["fulfilled", "rejected"]);
    assert.equal(dismissed[0].value.dismissed, true);
    assert.ok(isBusy(dismissed[1].reason), dismissed[1].reason?.message);

    // A Dismiss and a Resume together: whichever came second is told to wait.
    const mixed = await Promise.allSettled([world.manager.resume(summary.id), world.manager.dismiss(summary.id)]);
    assert.deepEqual(mixed.map((result) => result.status), ["fulfilled", "rejected"]);
    assert.ok(isBusy(mixed[1].reason));
    assert.equal(world.ptys.length, 3);

    // Nothing stays busy afterwards.
    world.ptys[2].exit(0);
    await ended(world, summary.id);
    assert.equal((await world.manager.dismiss(summary.id)).dismissed, true);
  });
});

test("quit check: names every live session of both kinds with its kind, and none that ended", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    const a = await world.manager.create({ agentId: "claude", folder: project });
    const b = await world.manager.create({ agentId: "codex", folder: other });
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    world.ptys[1].exit(0);
    await ended(world, b.id);
    // The kind lets the quit question leave out "you can resume them later"
    // when an update session is listed (an update is never resumed).
    assert.deepEqual((await world.manager.quitCheck()).live, [
      { id: a.id, title: "Claude Code · demo", kind: "agent" },
      { id: update.id, title: "Hermes update", kind: "update" }
    ]);
  });
});

test("quit: once shutdownAll has started, a new session, an update, a sign-in and a resume are all refused with agent_os_quitting, and the running session still stops", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    const running = await world.manager.create({ agentId: "claude", folder: project });
    const earlier = await world.manager.create({ agentId: "codex", folder: other });
    world.ptys[1].exit(0);
    await ended(world, earlier.id);
    const spawnsBefore = world.spawnCalls;
    const isQuitting = (error) =>
      error.status === 409 && error.code === "agent_os_quitting" && error.message === "Agent OS is quitting, so no new session can start.";

    // Not awaited: the quit is under way, and the refusals must not wait for it.
    const quitting = world.manager.shutdownAll({ reason: "quit" });
    await assert.rejects(world.manager.create({ agentId: "claude", folder: other }), isQuitting);
    await assert.rejects(world.manager.createUpdateSession({ agentId: "hermes", folder: project }), isQuitting);
    await assert.rejects(world.manager.createSetupSession({ action: "openclaw-chatgpt-signin", detected: { installed: true, path: "/fake/bin/openclaw" } }), isQuitting);
    await assert.rejects(world.manager.resume(earlier.id), isQuitting);
    assert.deepEqual(await quitting, { stopped: 1 }, "the running session is still stopped");
    // Still refused afterwards, and nothing was started.
    await assert.rejects(world.manager.create({ agentId: "claude", folder: other }), isQuitting);
    assert.equal(world.spawnCalls, spawnsBefore, "no process started");
    assert.equal((await world.manager.get(running.id)).endedBy, "quit");
  });
});

test("ids: anything that is not a session id is unknown before any file is touched", async () => {
  await withSessionEnv(async () => {
    const world = fakeWorld();
    const isUnknown = (error) =>
      error.status === 404 && error.code === "unknown_session" && error.message === "That session doesn't exist anymore.";
    for (const bad of ["../../etc", "", "not-a-uuid", crypto.randomUUID().toUpperCase(), null, undefined, 42]) {
      await assert.rejects(world.manager.get(bad), isUnknown);
      await assert.rejects(world.manager.resume(bad), isUnknown);
      await assert.rejects(world.manager.dismiss(bad), isUnknown);
      await assert.rejects(world.manager.attach(bad, { id: "w", send() {}, close() {} }), isUnknown);
      assert.equal(world.manager.write(bad, "w", "x"), false);
    }
    await assert.rejects(world.manager.get(crypto.randomUUID()), isUnknown);
  });
});

test("getSessionManager: one manager per server, with every method the routes and the socket use; the shared names are re-exported, never redefined", () => {
  assert.equal(SESSION_ID_RE, sessionErrors.SESSION_ID_RE);
  assert.equal(isSessionId, sessionErrors.isSessionId);
  assert.equal(sessionError, sessionErrors.sessionError);
  assert.equal(SESSION_AGENT_LABEL, PROFILE_AGENT_LABEL);
  assert.equal(SESSION_AGENT_LABEL.codex, "Codex");

  const manager = getSessionManager();
  assert.equal(getSessionManager(), manager);
  for (const name of [
    "create",
    "createUpdateSession",
    "list",
    "get",
    "attach",
    "focus",
    "write",
    "resize",
    "ack",
    "resume",
    "dismiss",
    "quitCheck",
    "isLive",
    "recoverStaleSessions",
    "applySignal",
    "markSourceSeen",
    "markNewTurn",
    "setHeld",
    "clearHeld",
    "addMarker",
    "markers",
    "liveAgentSessions",
    "onLiveChange"
  ]) {
    assert.equal(typeof manager[name], "function", name);
  }
  assert.equal(manager.isLive("00000000-0000-4000-8000-000000000000"), false);
});

// ---- real PTY, with the W1 TUI fakes ----------------------------------------------------------------

// The environment the fake agent gets in its terminal: the fake bin (all six
// names) plus the system folders, and the stand-in login shell.
function ptyEnv(home, bin) {
  return {
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    SHELL: FAKE_LOGIN_SHELL,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8"
  };
}

// Real PTY, mirror, recorder, folder policy, settings and recording cap; only
// the profile, the gate, detection and the brain are given, so no real agent
// can start.
function realDeps(profile, running) {
  return {
    isExecutionAllowed: async () => true,
    detect: async () => ({ installed: true, path: profile.command }),
    resolveBrain: async () => null,
    buildProfile: async (input) => ({
      command: profile.command,
      args: profile.args,
      cwd: input.folder ?? os.homedir(),
      env: profile.env,
      agentSessionId: profile.agentSessionId ?? null,
      settingsFile: null,
      softStop: profile.softStop ?? null,
      resumeMode: profile.resumeMode ?? null,
      folderShown: true,
      notes: []
    }),
    spawn: async (options) => track(running, await spawnPty(options))
  };
}

// `running` holds the pids this test started and has not seen exit. A pid
// leaves it the moment its exit is reported, because the operating system may
// give that number to another process afterwards.
function track(running, handle) {
  running.add(handle.pid);
  handle.onExit(() => {
    running.delete(handle.pid);
  });
  return handle;
}

// Clean-up for a test that failed half way: it signals only the pids in
// `running`, never one that has already exited (and so may belong to another
// process by now).
function killLeftovers(running, kill = (pid, signal) => process.kill(pid, signal)) {
  for (const pid of [...running]) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    running.delete(pid);
  }
}

// Waits until the exit handler has written meta.json, so nothing writes into
// the temp folder after the test removes it.
async function settled(agentOsHome, id) {
  return waitFor(async () => {
    const meta = await metaOnDisk(agentOsHome, id);
    return meta?.status === "exited" ? meta : null;
  });
}

test("real PTY clean-up: it signals only the pids the test started and has not seen exit, never a number the system may have given to another process", () => {
  const running = new Set();
  const stillThere = track(running, fakePty(910001));
  const reaped = track(running, fakePty(910002));
  reaped.exit(0); // reported as exited: its pid may belong to someone else by now
  assert.deepEqual([...running], [910001]);

  const signalled = [];
  killLeftovers(running, (pid, signal) => signalled.push([pid, signal]));
  assert.deepEqual(signalled, [[910001, "SIGKILL"]]);
  assert.equal(running.size, 0);

  stillThere.exit(0);
  killLeftovers(running, () => {
    assert.fail("nothing is left to signal");
  });
});

test("real PTY: a fake TUI agent shows what the writer types, ends with its own exit code, and its recording holds the output", SKIP_POSIX, async () => {
  await withSessionEnv(async ({ home, agentOsHome, project, bin }) => {
    const running = new Set();
    let id = null;
    try {
      await makeFakeAgentBin(bin); // all six names, mode tui
      const manager = createSessionManager(
        realDeps(
          {
            command: path.join(bin, "claude"),
            args: ["--session-id", CLAUDE_UUID],
            env: ptyEnv(home, bin),
            agentSessionId: CLAUDE_UUID,
            softStop: "claude-bg",
            resumeMode: "id"
          },
          running
        )
      );
      const summary = await manager.create({ agentId: "claude", folder: project });
      id = summary.id;
      assert.equal(summary.folder, project);

      const frames = [];
      await manager.attach(id, { id: "w", send: (frame) => frames.push(frame), close() {} });
      assert.equal(manager.focus(id, "w"), true);
      await waitFor(async () => (await manager.get(id)).status === "live");

      assert.equal(manager.write(id, "w", "hello-sp3\r"), true);
      await waitFor(() => outText(frames).includes("hello-sp3"));
      assert.equal(manager.write(id, "w", "exit 3\r"), true);
      const meta = await settled(agentOsHome, id);
      assert.equal(meta.exitCode, 3);
      assert.equal(meta.signal, null);
      assert.equal(meta.endedBy, null);
      const done = await manager.get(id);
      assert.equal(done.status, "exited");
      assert.equal(done.exitCode, 3);

      let total = 0;
      for (const frame of outs(frames)) {
        total += Buffer.byteLength(frame.d, "utf8");
        assert.equal(frame.seq, total, "seq is the running UTF-8 byte count");
      }
      assert.deepEqual(frames.at(-1), { t: "state", status: "exited", exitCode: 3, signal: null, endedBy: null });

      const cast = await readFile(path.join(agentOsHome, "sessions", id, "screen.cast"), "utf8");
      assert.match(cast, /hello-sp3/);
    } finally {
      killLeftovers(running);
      if (id) await settled(agentOsHome, id).catch(() => {});
    }
  });
});

test("real PTY: an updater started as an update session asks its question and gets the answer typed into its terminal; it stays out of the tab list", SKIP_POSIX, async () => {
  await withSessionEnv(async ({ home, agentOsHome, project, bin }) => {
    const running = new Set();
    let id = null;
    try {
      await makeFakeAgentBin(bin, { mode: "updater" }); // all six names; only hermes runs
      const manager = createSessionManager(
        realDeps({ command: path.join(bin, "hermes"), args: ["update"], env: ptyEnv(home, bin) }, running)
      );
      const update = await manager.createUpdateSession({ agentId: "hermes", folder: project });
      id = update.id;
      const frames = [];
      const { snapshot } = await manager.attach(id, { id: "w", send: (frame) => frames.push(frame), close() {} });
      assert.equal(manager.focus(id, "w"), true);
      await waitFor(() => `${snapshot.data}${outText(frames)}`.includes("Update now?"));

      assert.deepEqual(await manager.list(), [], "not a Sessions tab");
      assert.deepEqual((await manager.list({ includeUpdate: true })).map((summary) => summary.kind), ["update"]);
      assert.deepEqual((await manager.quitCheck()).live, [{ id, title: "Hermes update", kind: "update" }]);

      assert.equal(manager.write(id, "w", "y\r"), true);
      await waitFor(() => outText(frames).includes("ANSWER y"));
    } finally {
      killLeftovers(running);
      if (id) await settled(agentOsHome, id).catch(() => {});
    }
  });
});
