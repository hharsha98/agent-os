// Stop and quit (SP3, Task S7). The Stop sequence never types into the
// terminal: the agent's soft stop (at most 2 s), then the process tree with a
// 3 s grace. Quitting writes "ended (Agent OS quit)" before any kill and stays
// inside the 8 s hard exit. Fakes for the logic; the W1 TUI fakes in a real PTY
// for the process tree and the hung `claude agents --json`. PATH is a fake bin
// folder with all six agent names plus the system folders, and SHELL is W1's
// stand-in login shell, so no real agent and no real shell setup ever runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDescendants } from "../server/runtime/process-tree.js";
import { HARD_EXIT_MS, SHUTDOWN_TASK_LIMIT_MS, shutdown } from "../server/runtime/shutdown.js";
import {
  SHUTDOWN_GUARD_MS,
  STOP_GRACE_MS,
  createSessionManager,
  getSessionManager
} from "../server/runtime/sessions/manager.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { SOFT_STOP_LIMIT_MS, runSoftStop } from "../server/runtime/sessions/soft-stop.js";
import { writeJson as writeJsonFile } from "../server/runtime/store.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { NO_GIT_OPTIONS } from "./helpers/no-git.js";

const isWindows = process.platform === "win32";
const SKIP_POSIX = { skip: isWindows ? "the fake agents are POSIX shell shims" : false };
// Node's own folder is left out on purpose: it can hold real agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const CLAUDE_UUID = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
const T0 = Date.parse("2026-10-14T09:00:00.000Z");
const FALLBACK_AGENTS = new Set(["hermes", "codex", "cursor"]);

// A temp HOME (with two project folders in it), a separate temp AGENT_OS_HOME
// and a fake bin folder that holds all six agent names (POSIX shims), all
// canonical paths. PATH is the fake bin plus the system folders only, and
// SHELL is the stand-in login shell (rulings R15, R16). Restored after.
async function withSessionEnv(fn) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-stop-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-stop-data-")));
  const bin = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-stop-bin-")));
  const project = path.join(home, "projects", "demo");
  const other = path.join(home, "projects", "other");
  const vars = {
    HOME: home,
    USERPROFILE: home,
    AGENT_OS_HOME: agentOsHome,
    HERMES_AGENT_OS_HOME: undefined,
    HERMES_HOME: undefined,
    HERMES_AGENT_OS_ENABLE_EXEC: undefined,
    HERMES_AGENT_OS_SCHEDULER: "0",
    SHELL: FAKE_LOGIN_SHELL,
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter)
  };
  const saved = {};
  try {
    await mkdir(project, { recursive: true });
    await mkdir(other, { recursive: true });
    if (!isWindows) await makeFakeAgentBin(bin);
    for (const [key, value] of Object.entries(vars)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(os.homedir(), home, "tests must never see the real home folder");
    return await fn({ home, agentOsHome, bin, project, other });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
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

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function metaOnDisk(agentOsHome, id) {
  try {
    return JSON.parse(await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

// What every meta.json on disk says right now: { id: { status, endedBy } }.
async function allMetas() {
  const root = process.env.AGENT_OS_HOME;
  const result = {};
  for (const name of await readdir(path.join(root, "sessions")).catch(() => [])) {
    const meta = await metaOnDisk(root, name);
    if (meta) result[name] = { status: meta.status, endedBy: meta.endedBy };
  }
  return result;
}

// ---- injected fakes (the same shapes as in test/sessions-manager.test.js) --------------------------

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
    },
    resume() {
      pty.paused = false;
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

function fakeMirror(options) {
  const counted = new Set();
  const mirror = {
    opts: options,
    written: [],
    writerAttached: null,
    disposed: false,
    write(chunk) {
      mirror.written.push(chunk);
    },
    resize() {},
    async snapshot() {
      return {
        data: mirror.written.join(""),
        cols: options.cols,
        rows: options.rows,
        modes: {
          altScreen: false,
          bracketedPaste: false,
          mouseTracking: "none",
          mouseEncoding: "default",
          focusReporting: false,
          cursorKeysApp: false,
          kittyFlags: 0
        }
      };
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

function fakeRecorder(options) {
  const recorder = {
    opts: options,
    closed: false,
    output() {},
    marker() {},
    resize() {},
    async close() {
      recorder.closed = true;
    }
  };
  return recorder;
}

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
    folderShown: kind === "update" || agentId !== "openclaw",
    notes: []
  };
}

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

// killTree records what every meta.json said at the moment of the kill, and
// (by default) makes the fake process end with SIGTERM, like a real one.
function fakeWorld(over = {}) {
  const world = {
    clock: T0,
    gate: true,
    ptys: [],
    events: [],
    softCalls: [],
    softTimes: [],
    softDelayMs: 0,
    killCalls: [],
    killMakesExit: true,
    nextPid: 52000
  };
  world.deps = {
    now: () => world.clock,
    spawn: async (options) => {
      const pty = fakePty(world.nextPid, options);
      world.nextPid += 1;
      world.ptys.push(pty);
      return pty;
    },
    buildProfile: async (input) => fakeProfile(input),
    recorderFactory: fakeRecorder,
    mirrorFactory: fakeMirror,
    isExecutionAllowed: async () => world.gate,
    checkFolder: fakeCheckFolder,
    ptyCheck: async () => ({ ok: true, reason: null }),
    detect: async (agentId) => ({ installed: true, path: `/fake/bin/${agentId}` }),
    resolveBrain: async () => null,
    readSettings: async () => ({ claudeFullscreen: false }),
    enforceCap: async () => ({ deleted: [] }),
    softStop: async (input) => {
      world.events.push("soft");
      world.softCalls.push(input);
      const start = Date.now();
      if (world.softDelayMs) await new Promise((resolve) => setTimeout(resolve, world.softDelayMs));
      world.softTimes.push({ start, end: Date.now() });
      return { outcome: "none", note: null };
    },
    killTree: async (pid, options) => {
      world.events.push("kill");
      world.killCalls.push({ pid, options, metas: await allMetas() });
      const pty = world.ptys.find((candidate) => candidate.pid === pid);
      if (pty && world.killMakesExit) pty.exit(null, "SIGTERM");
    },
    // No real git in these tests (SP4 X7): only test/sessions-changes.test.js runs it.
    ...NO_GIT_OPTIONS,
    ...over
  };
  world.manager = createSessionManager(world.deps);
  return world;
}

async function ended(world, id) {
  return waitFor(async () => {
    const summary = await world.manager.get(id);
    return summary.status === "exited" ? summary : null;
  });
}

// ---- Stop -----------------------------------------------------------------------------------------

test("stop: the agent's soft stop first, then the process tree with a 3 s grace; nothing is typed into the terminal; the session ends as stopped by you", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    assert.equal(STOP_GRACE_MS, 3000);
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const pty = world.ptys[0];
    const frames = [];
    await world.manager.attach(summary.id, { id: "w", send: (frame) => frames.push(frame), close() {} });
    assert.equal(world.manager.focus(summary.id, "w"), true);

    world.clock = Date.parse("2026-10-14T09:10:00.000Z");
    const result = await world.manager.stop(summary.id);

    assert.deepEqual(world.events, ["soft", "kill"]);
    assert.deepEqual(world.softCalls[0], {
      softStop: "claude-bg",
      command: "/fake/bin/claude",
      env: { TERM: "xterm-256color" },
      cwd: project,
      agentSessionId: CLAUDE_UUID,
      pid: pty.pid
    });
    assert.equal(world.killCalls.length, 1);
    assert.equal(world.killCalls[0].pid, pty.pid);
    assert.deepEqual(world.killCalls[0].options, { graceMs: 3000 });
    assert.deepEqual(pty.writes, [], "Stop never types into the terminal");
    assert.deepEqual(pty.kills, [], "nor does it use the PTY's own kill");

    assert.equal(result.id, summary.id);
    assert.equal(result.status, "exited");
    assert.equal(result.endedBy, "stop");
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.exitCode, null);
    assert.equal(result.endedAt, "2026-10-14T09:10:00.000Z");
    assert.equal(result.note, null);
    assert.deepEqual(frames.at(-1), { t: "state", status: "exited", exitCode: null, signal: "SIGTERM", endedBy: "stop" });
    assert.equal((await metaOnDisk(agentOsHome, summary.id)).endedBy, "stop");
  });
});

test("stop: OpenClaw ends with the honest note while its Gateway abort waits for spike S5", async () => {
  await withSessionEnv(async () => {
    const world = fakeWorld({ softStop: runSoftStop });
    const summary = await world.manager.create({ agentId: "openclaw" });
    const result = await world.manager.stop(summary.id);
    assert.equal(result.note, "Stopped the terminal. OpenClaw may still be finishing its last step.");
    assert.equal(result.endedBy, "stop");
    assert.equal(result.status, "exited");
    assert.equal(world.killCalls.length, 1, "the terminal is still killed");
  });
});

test("stop: an ended session answers as it is, an unknown id is unknown, and two Stops at once run the sequence once", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const done = await world.manager.create({ agentId: "claude", folder: project });
    const running = await world.manager.create({ agentId: "codex", folder: project });
    world.ptys[0].exit(0, null);
    await ended(world, done.id);

    const again = await world.manager.stop(done.id);
    assert.equal(again.status, "exited");
    assert.equal(again.endedBy, null, "it ended on its own, and stays that way");
    assert.equal(again.note, null);
    assert.equal(world.killCalls.length, 0);
    assert.equal(world.softCalls.length, 0);

    const isUnknown = (error) => error.status === 404 && error.code === "unknown_session";
    await assert.rejects(world.manager.stop(crypto.randomUUID()), isUnknown);
    await assert.rejects(world.manager.stop("../../etc"), isUnknown);

    const [first, second] = await Promise.all([world.manager.stop(running.id), world.manager.stop(running.id)]);
    assert.equal(world.softCalls.length, 1);
    assert.equal(world.killCalls.length, 1);
    assert.equal(first.status, "exited");
    assert.equal(second.status, "exited");
  });
});

// Controller ruling (S6 left the busy set; S7 honours it): while a Resume or a
// Dismiss of an ended session is in progress, a Stop for it answers
// session_busy, never the ended summary of a session that is about to run again.
test("a Stop that meets an ended session being resumed right now answers session_busy", async () => {
  await withSessionEnv(async ({ project }) => {
    let inResume = false;
    let releaseResume;
    const resumeGate = new Promise((resolve) => {
      releaseResume = resolve;
    });
    const world = fakeWorld({
      buildProfile: async (input) => {
        if (input.resume) {
          inResume = true;
          await resumeGate;
        }
        return fakeProfile(input);
      }
    });
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    world.ptys[0].exit(0, null);
    await ended(world, summary.id);

    const resuming = world.manager.resume(summary.id);
    await waitFor(() => inResume);
    await assert.rejects(world.manager.stop(summary.id), (error) => error.status === 409 && error.code === "session_busy");
    assert.equal(world.softCalls.length, 0, "a busy session is left alone");
    assert.equal(world.killCalls.length, 0);

    releaseResume();
    assert.notEqual((await resuming).status, "exited");
    const stopped = await world.manager.stop(summary.id);
    assert.equal(stopped.status, "exited", "once the Resume is done, Stop works as usual");
    assert.equal(stopped.endedBy, "stop");
    assert.equal(world.killCalls.length, 1);
  });
});

// Review Focus 5: Safety is switched to Look only while a session is open.
// The session keeps running and Stop still works (Task S6 tests that a new
// session and Resume are refused).
test("Look only: an open session keeps running and can still be stopped", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    world.gate = false;
    assert.notEqual((await world.manager.get(summary.id)).status, "exited", "Look only does not end an open session");
    const result = await world.manager.stop(summary.id);
    assert.equal(result.status, "exited");
    assert.equal(result.endedBy, "stop");
    assert.equal(world.killCalls.length, 1);
  });
});

test("stop never hangs: when the process outlives the kill, Stop still answers, and does not claim the session ended", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    world.killMakesExit = false;
    const summary = await world.manager.create({ agentId: "hermes", folder: project });
    const started = Date.now();
    const result = await world.manager.stop(summary.id);
    assert.ok(Date.now() - started < 3000, "bounded wait after the kill");
    assert.notEqual(result.status, "exited");
    world.ptys[0].exit(null, "SIGKILL"); // it dies later
    const later = await ended(world, summary.id);
    assert.equal(later.endedBy, "stop");
    assert.equal(later.signal, "SIGKILL");
  });
});

// A Stop that ends without seeing the exit (a kill that did not take) is not
// remembered: the next Stop, and the quit, run the sequence again.
test("a Stop that did not take can be tried again, by the next Stop and by the quit", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    world.killMakesExit = false;
    const a = await world.manager.create({ agentId: "hermes", folder: project });
    const b = await world.manager.create({ agentId: "codex", folder: other });
    const [firstA, firstB] = await Promise.all([world.manager.stop(a.id), world.manager.stop(b.id)]);
    assert.notEqual(firstA.status, "exited");
    assert.notEqual(firstB.status, "exited");
    assert.equal(world.killCalls.length, 2);

    world.killMakesExit = true;
    const again = await world.manager.stop(a.id);
    assert.equal(world.killCalls.length, 3, "the second Stop killed the tree again instead of answering the old summary");
    assert.equal(world.softCalls.length, 3);
    assert.equal(again.status, "exited");
    assert.equal(again.endedBy, "stop");

    assert.deepEqual(await world.manager.shutdownAll({ reason: "quit" }), { stopped: 1 });
    assert.equal(world.killCalls.length, 4, "the quit killed the session that was still there");
    const later = await world.manager.get(b.id);
    assert.equal(later.status, "exited");
    assert.equal(later.endedBy, "stop", "it keeps the reason of the Stop that came first");
  });
});

// The same busy rule as above, for an ended session that is still in the list
// of running ones because its recording is still closing.
test("a Stop that meets an ended session whose recording is still closing, while a Resume holds it, answers session_busy", async () => {
  await withSessionEnv(async ({ project }) => {
    let releaseClose;
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });
    const world = fakeWorld({
      recorderFactory: (options) => {
        const recorder = fakeRecorder(options);
        recorder.close = async () => {
          await closeGate;
          recorder.closed = true;
        };
        return recorder;
      }
    });
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    world.ptys[0].exit(0, null); // ended; its recording is still closing, so the session is still in `live`
    const resuming = world.manager.resume(summary.id); // holds the id, waits for that exit to finish
    const started = Date.now();
    await assert.rejects(world.manager.stop(summary.id), (error) => error.status === 409 && error.code === "session_busy");
    assert.ok(Date.now() - started < 500, "it answered at once");
    assert.equal(world.softCalls.length, 0);
    assert.equal(world.killCalls.length, 0);

    releaseClose();
    assert.notEqual((await resuming).status, "exited");
  });
});

// ---- Quit -----------------------------------------------------------------------------------------

test("quit: shutdownAll writes 'ended (Agent OS quit)' into every live session's meta.json before any kill, then stops both kinds at the same time", async () => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    const world = fakeWorld();
    world.softDelayMs = 300;
    const a = await world.manager.create({ agentId: "claude", folder: project });
    const b = await world.manager.create({ agentId: "codex", folder: other });
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    const earlier = await world.manager.create({ agentId: "cursor", folder: project });
    world.ptys[3].exit(0, null);
    await ended(world, earlier.id);

    world.clock = Date.parse("2026-10-14T12:00:00.000Z");
    assert.deepEqual(await world.manager.shutdownAll({ reason: "quit" }), { stopped: 3 });

    assert.equal(world.killCalls.length, 3);
    for (const pty of world.ptys) assert.deepEqual(pty.writes, [], "quitting never types into a terminal (Security 6)");
    for (const call of world.killCalls) {
      for (const id of [a.id, b.id, update.id]) {
        assert.deepEqual(call.metas[id], { status: "exited", endedBy: "quit" }, "written before this kill");
      }
    }
    assert.equal(world.softTimes.length, 3);
    const lastStart = Math.max(...world.softTimes.map((time) => time.start));
    const firstEnd = Math.min(...world.softTimes.map((time) => time.end));
    assert.ok(lastStart < firstEnd, "every soft stop started before the first one finished: they ran at the same time");

    for (const id of [a.id, b.id, update.id]) {
      const meta = await metaOnDisk(agentOsHome, id);
      assert.equal(meta.status, "exited");
      assert.equal(meta.endedBy, "quit");
      assert.equal(meta.endedAt, "2026-10-14T12:00:00.000Z");
      assert.equal(meta.signal, "SIGTERM");
    }
    assert.equal((await world.manager.get(earlier.id)).endedBy, null, "a session that had already ended is left as it was");
    assert.equal((await world.manager.get(a.id)).resume.available, true, "Resume stays available after a quit");
    assert.deepEqual((await world.manager.quitCheck()).live, []);
  });
});

test("quit: a session the person is already stopping keeps 'stopped by you', and its one Stop sequence is shared", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    world.softDelayMs = 200;
    const summary = await world.manager.create({ agentId: "claude", folder: project });
    const stopping = world.manager.stop(summary.id);
    await waitFor(() => world.softCalls.length === 1);

    assert.deepEqual(await world.manager.shutdownAll({ reason: "quit" }), { stopped: 1 });
    const stopped = await stopping;

    assert.equal(world.softCalls.length, 1, "the quit did not start a second soft stop");
    assert.equal(world.killCalls.length, 1);
    assert.deepEqual(world.killCalls[0].metas[summary.id], { status: "exited", endedBy: "stop" }, "written before the kill");
    assert.equal(stopped.endedBy, "stop");
    assert.equal((await metaOnDisk(agentOsHome, summary.id)).endedBy, "stop");
  });
});

test("quit: shutdownAll never waits more than 7 s, even when a stop hangs", async (t) => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    assert.equal(SHUTDOWN_GUARD_MS, 7000);
    assert.ok(
      SHUTDOWN_GUARD_MS <= SHUTDOWN_TASK_LIMIT_MS && SHUTDOWN_TASK_LIMIT_MS < HARD_EXIT_MS,
      "the sessions' quit fits inside shutdown.js's task limit and the 8 s hard exit"
    );
    const world = fakeWorld({
      killTree: async (pid, options) => {
        world.killCalls.push({ pid, options });
        await new Promise(() => {}); // never returns
      }
    });
    const summary = await world.manager.create({ agentId: "hermes", folder: project });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let finished = false;
    const quitting = world.manager.shutdownAll({ reason: "quit" }).then((result) => {
      finished = true;
      return result;
    });
    while (world.killCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(SHUTDOWN_GUARD_MS - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await quitting, { stopped: 1 });
    const meta = await metaOnDisk(agentOsHome, summary.id);
    assert.equal(meta.status, "exited");
    assert.equal(meta.endedBy, "quit", "the record says why it ended, even though the process outlived the stop");
  });
});

// The 7 s limit starts with the first meta.json write: slow writes and the
// stops together stay inside it (otherwise the server's 8 s hard exit fires first).
test("a quit's 7 s limit starts before the meta.json writes, so slow writes and the stops together never take longer", async (t) => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const WRITE_DELAY_MS = 3000;
    let slow = false;
    const world = fakeWorld({
      writeJson: async (file, data) => {
        if (slow) await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
        return writeJsonFile(file, data);
      },
      killTree: async (pid, options) => {
        world.killCalls.push({ pid, options });
        await new Promise(() => {}); // never returns
      }
    });
    const summary = await world.manager.create({ agentId: "hermes", folder: project });
    slow = true;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const settle = async () => {
      for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    let finished = false;
    const quitting = world.manager.shutdownAll({ reason: "quit" }).then((result) => {
      finished = true;
      return result;
    });
    await settle();
    t.mock.timers.tick(WRITE_DELAY_MS); // the slow writes are done; the stops start
    while (world.killCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(SHUTDOWN_GUARD_MS - WRITE_DELAY_MS - 1);
    await settle();
    assert.equal(finished, false, "not before 7 s after the quit began");
    t.mock.timers.tick(1);
    await settle();
    assert.equal(finished, true, "7 s after the quit began, writes included, and not 3 s later");
    assert.deepEqual(await quitting, { stopped: 1 });
    assert.equal((await metaOnDisk(agentOsHome, summary.id)).endedBy, "quit");
  });
});

test("quit: the shared session manager is a shutdown task, so shutdown() ends every session", async () => {
  await withSessionEnv(async () => {
    const manager = getSessionManager();
    assert.equal(getSessionManager(), manager);
    assert.equal(typeof manager.stop, "function");
    assert.equal(typeof manager.shutdownAll, "function");
    const calls = [];
    const original = manager.shutdownAll;
    manager.shutdownAll = async (options) => {
      calls.push(options);
      return original(options);
    };
    try {
      await shutdown({});
    } finally {
      manager.shutdownAll = original;
    }
    assert.deepEqual(calls, [{ reason: "quit" }]);
  });
});

// ---- real PTY, with the W1 TUI fakes ----------------------------------------------------------------

// The environment of a fake agent's terminal, which the soft stop's CLI calls
// also get (the session's own environment, decision Q11): the fake bin and the
// system folders only, the stand-in login shell, and the fake's mode (the
// shims use FAKE_AGENT_MODE from their environment). `extra` adds fake-only
// variables (what `claude agents --json` prints, the fake's event log).
function ptyEnv({ home, bin, mode, pidFile = null, extra = {} }) {
  return {
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    SHELL: FAKE_LOGIN_SHELL,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    FAKE_AGENT_MODE: mode,
    ...(pidFile ? { FAKE_AGENT_PIDFILE: pidFile } : {}),
    ...extra
  };
}

// `running` holds the pids this test started and has not seen exit. A pid
// leaves it the moment its exit is seen, because the operating system may give
// that number to another process afterwards. A terminal's pid leaves with its
// exit report (as in test/sessions-manager.test.js); any other pid (a CLI call
// of the soft stop, a grandchild, a descendant) leaves with watchPid.
function track(running, handle) {
  running.add(handle.pid);
  handle.onExit(() => {
    running.delete(handle.pid);
  });
  return handle;
}

function watchPid(running, pid) {
  running.add(pid);
  (async () => {
    while (running.has(pid) && isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
    running.delete(pid);
  })();
}

// Waits until the pid is gone, and drops it from `running` at once. A pid that
// is still there when the wait runs out stays in `running`.
async function gone(running, pid, timeoutMs = 5000) {
  await waitFor(() => !isAlive(pid), { timeoutMs });
  running.delete(pid);
}

// Clean-up for a test that failed half way: it signals only the pids in
// `running`, never one that has already been seen gone (and so may belong to
// another process by now).
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

// Real PTY, mirror, recorder, folder policy, process-tree kill and soft stop;
// only the profiles, the gate, detection and the brain are given, so no real
// agent can start. Every terminal and every CLI call the soft stop starts joins
// `running`; `outcomes` collects what each soft stop answered.
function realDeps(profiles, { spawned, running, cliPids, outcomes = [] }) {
  return {
    ...NO_GIT_OPTIONS,
    isExecutionAllowed: async () => true,
    detect: async (agentId) => ({ installed: true, path: profiles[agentId].command }),
    resolveBrain: async () => null,
    buildProfile: async (input) => {
      const profile = profiles[input.agentId];
      return {
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
      };
    },
    spawn: async (options) => {
      const handle = track(running, await spawnPty(options));
      spawned.push(handle);
      return handle;
    },
    softStop: async (input) => {
      const result = await runSoftStop({
        ...input,
        onSpawn: (pid) => {
          cliPids.push(pid);
          watchPid(running, pid);
        }
      });
      outcomes.push(result);
      return result;
    }
  };
}

// Waits until meta.json on disk says the session ended.
async function settled(agentOsHome, id) {
  return waitFor(async () => {
    const meta = await metaOnDisk(agentOsHome, id);
    return meta?.status === "exited" ? meta : null;
  });
}

// The grandchild's pid, from the file the fake writes in mode setsid-grandchild.
async function grandchildPid(pidFile) {
  return Number(await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim()));
}

// What the fake agents logged (FAKE_AGENT_LOG), one JSON object per line.
async function loggedEvents(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("real PTY clean-up: it signals only the pids the test started and has not seen exit, never a number the system may have given to another process", async () => {
  const running = new Set();
  const stillThere = track(running, fakePty(910001));
  const reaped = track(running, fakePty(910002));
  reaped.exit(0); // reported as exited: its pid may belong to someone else by now
  assert.deepEqual([...running], [910001]);

  // A pid of a process this test started: it leaves `running` as soon as it is seen gone.
  const short = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  watchPid(running, short.pid);
  assert.equal(running.has(short.pid), true);
  await waitFor(() => !running.has(short.pid));
  const waited = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  running.add(waited.pid);
  await gone(running, waited.pid);
  assert.equal(running.has(waited.pid), false);

  // A pid that is still there when the wait runs out stays, to be cleaned up.
  running.add(process.pid);
  await assert.rejects(gone(running, process.pid, 100), /timed out/);
  assert.equal(running.has(process.pid), true);
  running.delete(process.pid); // this test process is never signalled

  const signalled = [];
  killLeftovers(running, (pid, signal) => signalled.push([pid, signal]));
  assert.deepEqual(signalled, [[910001, "SIGKILL"]]);
  assert.equal(running.size, 0);

  stillThere.exit(0);
  killLeftovers(running, () => {
    assert.fail("nothing is left to signal");
  });
});

test("real PTY: Stop kills the whole tree, including a grandchild that left the process group with setsid", SKIP_POSIX, async () => {
  await withSessionEnv(async ({ home, agentOsHome, bin, project }) => {
    const pidFile = path.join(bin, "grandchild.pid");
    const running = new Set();
    const spawned = [];
    const cliPids = [];
    try {
      const manager = createSessionManager(
        realDeps(
          {
            hermes: {
              command: path.join(bin, "hermes"),
              args: [],
              env: ptyEnv({ home, bin, mode: "setsid-grandchild", pidFile }),
              softStop: null,
              resumeMode: "fallback"
            }
          },
          { spawned, running, cliPids }
        )
      );
      const summary = await manager.create({ agentId: "hermes", folder: project });
      const pid = spawned[0].pid;
      const grandchild = await grandchildPid(pidFile);
      watchPid(running, grandchild);
      const descendants = await waitFor(async () => {
        const found = await listDescendants(pid);
        return found.includes(grandchild) ? found : null;
      });
      for (const each of descendants) watchPid(running, each);

      await manager.stop(summary.id);
      for (const each of [pid, grandchild, ...descendants]) await gone(running, each);
      const meta = await settled(agentOsHome, summary.id);
      assert.equal(meta.endedBy, "stop");
      assert.equal((await manager.get(summary.id)).status, "exited");
      assert.deepEqual(cliPids, [], "Hermes has no soft stop, so no CLI call was made");
    } finally {
      killLeftovers(running);
    }
  });
});

test("real PTY: quitting while Claude's `claude agents --json` hangs still finishes inside the 8 s hard exit, kills every process and records the quit", SKIP_POSIX, async () => {
  await withSessionEnv(async ({ home, agentOsHome, bin, project, other }) => {
    const pidFile = path.join(bin, "grandchild.pid");
    const running = new Set();
    const spawned = [];
    const cliPids = [];
    try {
      const manager = createSessionManager(
        realDeps(
          {
            claude: {
              command: path.join(bin, "claude"),
              args: ["--session-id", CLAUDE_UUID],
              env: ptyEnv({ home, bin, mode: "agents-hang" }),
              agentSessionId: CLAUDE_UUID,
              softStop: "claude-bg",
              resumeMode: "id"
            },
            hermes: {
              command: path.join(bin, "hermes"),
              args: [],
              env: ptyEnv({ home, bin, mode: "setsid-grandchild", pidFile }),
              softStop: null,
              resumeMode: "fallback"
            }
          },
          { spawned, running, cliPids }
        )
      );
      const claude = await manager.create({ agentId: "claude", folder: project });
      const hermes = await manager.create({ agentId: "hermes", folder: other });
      await waitFor(async () => (await manager.list()).every((summary) => summary.status === "live"));
      const grandchild = await grandchildPid(pidFile);
      watchPid(running, grandchild);
      const descendants = await waitFor(async () => {
        const found = await listDescendants(spawned[1].pid);
        return found.includes(grandchild) ? found : null;
      });
      for (const each of descendants) watchPid(running, each);

      const started = Date.now();
      assert.deepEqual(await manager.shutdownAll({ reason: "quit" }), { stopped: 2 });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= SOFT_STOP_LIMIT_MS - 100, `it waited for the hung CLI up to the 2 s limit (${elapsed} ms)`);
      assert.ok(elapsed < HARD_EXIT_MS, `inside the 8 s hard exit (${elapsed} ms)`);
      assert.ok(cliPids.length >= 1, "claude agents --json was asked");

      for (const pid of [spawned[0].pid, spawned[1].pid, grandchild, ...descendants, ...cliPids]) {
        await gone(running, pid);
      }
      for (const id of [claude.id, hermes.id]) {
        const meta = await settled(agentOsHome, id);
        assert.equal(meta.endedBy, "quit");
      }
    } finally {
      killLeftovers(running);
    }
  });
});

// The real runCli path from end to end: Claude's own background list names
// this session, so Stop runs `claude stop <id>` with the session's own
// environment (the fake prints the list from FAKE_CLAUDE_AGENTS_JSON, which
// only the session's environment holds), then kills the terminal.
test("real PTY: Stop runs `claude agents --json` and then `claude stop <id>` through the real runCli, with the session's own environment, and ends the terminal", SKIP_POSIX, async () => {
  await withSessionEnv(async ({ home, agentOsHome, bin, project }) => {
    const logFile = path.join(bin, "agent-events.log");
    const agentsJson = JSON.stringify([
      { id: "bg-other", kind: "background", sessionId: "11111111-2222-4333-8444-555555555555" },
      { id: "bg-1", kind: "background", sessionId: CLAUDE_UUID }
    ]);
    const running = new Set();
    const spawned = [];
    const cliPids = [];
    const outcomes = [];
    try {
      const manager = createSessionManager(
        realDeps(
          {
            claude: {
              command: path.join(bin, "claude"),
              args: ["--session-id", CLAUDE_UUID],
              env: ptyEnv({
                home,
                bin,
                mode: "tui",
                extra: { FAKE_CLAUDE_AGENTS_JSON: agentsJson, FAKE_AGENT_LOG: logFile }
              }),
              agentSessionId: CLAUDE_UUID,
              softStop: "claude-bg",
              resumeMode: "id"
            }
          },
          { spawned, running, cliPids, outcomes }
        )
      );
      const summary = await manager.create({ agentId: "claude", folder: project });
      const pid = spawned[0].pid;

      const result = await manager.stop(summary.id);
      assert.deepEqual(outcomes, [{ outcome: "stopped-background", note: null }]);
      assert.equal(cliPids.length, 2, "one `agents --json` and one `stop`");
      const calls = (await loggedEvents(logFile)).filter((entry) => entry.event === "agents" || entry.event === "stop");
      assert.deepEqual(
        calls.map((entry) => (entry.event === "agents" ? ["agents", ...entry.args] : ["stop", entry.id])),
        [["agents", "agents", "--json"], ["stop", "bg-1"]],
        "only this session's own background entry is stopped"
      );

      assert.equal(result.status, "exited");
      assert.equal(result.endedBy, "stop");
      await gone(running, pid);
      for (const each of cliPids) await gone(running, each);
      assert.equal((await settled(agentOsHome, summary.id)).endedBy, "stop");
    } finally {
      killLeftovers(running);
    }
  });
});
