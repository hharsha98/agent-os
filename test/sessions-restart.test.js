// Session versions and Restart session (SP5, Task V4; ruling R40; spec "Updates and open sessions").
// A session remembers the agent version it started (and resumed) on. After an update, Restart session stops a
// running agent session with the Stop sequence and resumes it in the same tab and folder, pressing no keys. It is
// only ever started by the person's click (POST /api/sessions/:id/restart); an update never calls it.
//
// Most tests drive the manager with injected fakes (the same shapes as test/sessions-stop.test.js), so no process
// starts. The last test starts the W1 TUI fake as a real terminal, with the real agent detection reading the fake's
// `--version`, to see the whole thing once. PATH is a fake bin folder plus the system folders and SHELL is W1's
// stand-in login shell, so no real agent and no real shell setup ever runs. No network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAdapter } from "../server/runtime/agents/index.js";
import { sessionError } from "../server/runtime/sessions/errors.js";
import { BUSY_MESSAGE, createSessionManager } from "../server/runtime/sessions/manager.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { setFakeKnob } from "./helpers/fake-knobs.js";
import { NO_GIT_OPTIONS } from "./helpers/no-git.js";

const isWindows = process.platform === "win32";
const SKIP_POSIX = { skip: isWindows ? "the fake agents are POSIX shell shims" : false };
// Node's own folder is left out on purpose: it can hold real agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const CLAUDE_UUID = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
const T0 = Date.parse("2026-10-31T09:00:00.000Z");
const FALLBACK_AGENTS = new Set(["hermes", "codex", "cursor"]);
const SHARED_FOLDER =
  "More than one ended Hermes session used this folder, so Agent OS can't tell which conversation to resume.";
const NOT_STOPPED =
  "Agent OS could not stop this session, so it was not restarted. Try again.";
const NOTHING_TO_RESUME =
  "Claude Code has nothing saved for this conversation, so there is nothing to resume. Start a new session in this folder.";
// A Claude Code session with its hooks wired: the manager is given the server's port (it is 0 in these tests otherwise).
const HOOKS_ON = { getPort: () => 4567, newHookToken: () => "test-token" };
// What a UserPromptSubmit hook event looks like once hooks.js has mapped it.
const PROMPT_EVENT = { event: "UserPromptSubmit", signals: [], newTurn: true, promptMarker: true };

// A temp HOME (with two project folders) and a separate temp AGENT_OS_HOME, both canonical paths, and a fake bin
// folder that holds all six agent names (POSIX shims). PATH is the fake bin plus the system folders only, and SHELL
// is the stand-in login shell. Restored after.
async function withSessionEnv(fn) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-restart-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-restart-data-")));
  const bin = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-restart-bin-")));
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
    // A session's last meta.json write can still land while the folders are removed; rm tries again.
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(agentOsHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

function metaFile(agentOsHome, id) {
  return path.join(agentOsHome, "sessions", id, "meta.json");
}

async function metaOnDisk(agentOsHome, id) {
  try {
    return JSON.parse(await readFile(metaFile(agentOsHome, id), "utf8"));
  } catch {
    return null;
  }
}

// ---- injected fakes (the same shapes as in test/sessions-stop.test.js) ---------------------------------------

function fakePty(pid, options) {
  const dataListeners = new Set();
  const exitListeners = new Set();
  const pty = {
    pid,
    opts: options,
    // Every byte the manager types into this terminal: Restart must leave it empty.
    writes: [],
    write(data) {
      pty.writes.push(data);
    },
    resize() {},
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
    setWriterAttached() {},
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
  return {
    opts: options,
    output() {},
    marker() {},
    resize() {},
    async close() {}
  };
}

// What buildSessionProfile answers, without a login shell: the argv shows whether the run is new or a resume.
function fakeProfile({ agentId, folder, kind, resume, sessionId }) {
  const agentSessionId = agentId === "claude" ? resume?.agentSessionId || CLAUDE_UUID : null;
  return {
    command: `/fake/bin/${agentId}`,
    args:
      kind === "update" ? ["update"] : resume ? ["--resume", ...(agentSessionId ? [agentSessionId] : [])] : ["--new", sessionId],
    cwd: folder || os.homedir(),
    env: { TERM: "xterm-256color" },
    agentSessionId,
    settingsFile: null,
    softStop: kind === "update" ? null : agentId === "claude" ? "claude-bg" : null,
    resumeMode: kind === "update" ? null : FALLBACK_AGENTS.has(agentId) ? "fallback" : "id",
    folderShown: true,
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

// killTree records its call and makes the fake process end with SIGTERM, like a real one (unless a test says the
// kill did not take). `versions` is what detection answers per agent (an agent without an entry has no version).
function fakeWorld(over = {}) {
  const world = {
    clock: T0,
    gate: true,
    installed: new Set(["claude", "codex", "cursor", "hermes", "openclaw"]),
    versions: {},
    detectCalls: 0,
    // The options each detect call got (a restart asks with { refresh: true }).
    detectOptions: [],
    // A promise the fresh detection of a restart (detect with { refresh: true }) waits for, so a test can act while the
    // restart's stop is over and its new process is not started yet; `refreshAsked` counts those fresh detections.
    refreshGate: null,
    refreshAsked: 0,
    // The agents whose update runs now, as the update service would say (the manager's isUpdateRunning).
    updating: new Set(),
    // true: detection answers from a memory (the 30 s one of agents/detect.js) unless asked to refresh.
    staleDetect: false,
    detectMemory: new Map(),
    ptys: [],
    profileInputs: [],
    // What Claude Code's profile says about the person's hook settings (profile.claude), or none.
    claudeProfile: null,
    events: [],
    killCalls: [],
    killMakesExit: true,
    // A promise the soft stop waits for, so a test can act while a Stop is in progress.
    softGate: null,
    // Set to make the brain check or the terminal check refuse, or the next spawn fail with its message. `brainGate`
    // holds the brain check open until a test releases it.
    brainError: null,
    brainGate: null,
    brainChecks: 0,
    ptyOk: true,
    spawnError: null,
    nextPid: 61000
  };
  world.deps = {
    now: () => world.clock,
    spawn: async (options) => {
      if (world.spawnError) {
        const message = world.spawnError;
        world.spawnError = null;
        throw Object.assign(new Error(message), { code: "spawn_failed" });
      }
      const pty = fakePty(world.nextPid, options);
      world.nextPid += 1;
      world.ptys.push(pty);
      return pty;
    },
    buildProfile: async (input) => {
      world.profileInputs.push(input);
      return { ...fakeProfile(input), ...(world.claudeProfile && input.agentId === "claude" ? { claude: world.claudeProfile } : {}) };
    },
    recorderFactory: fakeRecorder,
    mirrorFactory: fakeMirror,
    isExecutionAllowed: async () => world.gate,
    checkFolder: fakeCheckFolder,
    ptyCheck: async () => (world.ptyOk ? { ok: true, reason: null } : { ok: false, reason: "no terminal module" }),
    isUpdateRunning: (agentId) => world.updating.has(agentId),
    detect: async (agentId, options) => {
      world.detectCalls += 1;
      world.detectOptions.push(options ?? null);
      if (options?.refresh) {
        world.refreshAsked += 1;
        if (world.refreshGate) await world.refreshGate;
      }
      const answer = () => {
        if (!world.installed.has(agentId)) return { installed: false, path: "" };
        const version = world.versions[agentId];
        return { installed: true, path: `/fake/bin/${agentId}`, ...(version === undefined ? {} : { version }) };
      };
      if (!world.staleDetect) return answer();
      if (options?.refresh || !world.detectMemory.has(agentId)) world.detectMemory.set(agentId, answer());
      return world.detectMemory.get(agentId);
    },
    resolveBrain: async () => {
      world.brainChecks += 1;
      if (world.brainGate) await world.brainGate;
      if (world.brainError) throw world.brainError;
      return null;
    },
    readSettings: async () => ({ claudeFullscreen: false }),
    enforceCap: async () => ({ deleted: [] }),
    softStop: async () => {
      world.events.push("soft");
      if (world.softGate) await world.softGate;
      return { outcome: "none", note: null };
    },
    killTree: async (pid) => {
      world.events.push("kill");
      world.killCalls.push(pid);
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

// The session ends by itself (its own exit code), as when the person quits the agent.
async function endOnItsOwn(world, id, pty) {
  pty.exit(0);
  return ended(world, id);
}

// ---- the version a session starts on -----------------------------------------------------------------------

test("a new session records the agent's detected version in meta.json and in its summary; with no version detected it is null", async () => {
  await withSessionEnv(async ({ agentOsHome, project, other }) => {
    const world = fakeWorld();
    world.versions.claude = "2.1.309 (Claude Code)";
    const claude = await world.manager.create({ agentId: "claude", folder: project });
    assert.equal(claude.agentVersion, "2.1.309 (Claude Code)");
    assert.equal((await world.manager.get(claude.id)).agentVersion, "2.1.309 (Claude Code)");
    assert.equal((await metaOnDisk(agentOsHome, claude.id)).agentVersion, "2.1.309 (Claude Code)");

    // Detection that found no version, or an empty one, records none: no banner can be built on a guess.
    const codex = await world.manager.create({ agentId: "codex", folder: other });
    assert.equal(codex.agentVersion, null);
    assert.equal((await metaOnDisk(agentOsHome, codex.id)).agentVersion, null);
    world.versions.cursor = "   ";
    const cursor = await world.manager.create({ agentId: "cursor", folder: path.dirname(project) });
    assert.equal(cursor.agentVersion, null);
  });
});

test("a session started before SP5 (a meta.json without agentVersion) lists agentVersion: null, in get and in the list", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    world.versions.claude = "2.1.309 (Claude Code)";
    const made = await world.manager.create({ agentId: "claude", folder: project });
    await endOnItsOwn(world, made.id, world.ptys[0]);
    // The status is "exited" in memory a moment before the exit handler writes meta.json: wait for the file.
    await waitFor(async () => (await metaOnDisk(agentOsHome, made.id))?.status === "exited");

    // Take the field out of the file, the way a session saved by an older Agent OS looks.
    const file = metaFile(agentOsHome, made.id);
    const meta = JSON.parse(await readFile(file, "utf8"));
    delete meta.agentVersion;
    await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`);

    const reader = createSessionManager(world.deps);
    assert.equal((await reader.get(made.id)).agentVersion, null);
    assert.deepEqual((await reader.list()).map((summary) => summary.agentVersion), [null]);
  });
});

test("resume records the version the agent has now, not the one the session first started on", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    world.versions.claude = "2.1.309 (Claude Code)";
    const made = await world.manager.create({ agentId: "claude", folder: project });
    await endOnItsOwn(world, made.id, world.ptys[0]);

    world.versions.claude = "2.2.0 (Claude Code)"; // an update happened while the session was ended
    const resumed = await world.manager.resume(made.id);
    assert.equal(resumed.agentVersion, "2.2.0 (Claude Code)");
    assert.equal((await metaOnDisk(agentOsHome, made.id)).agentVersion, "2.2.0 (Claude Code)");

    // The agent can't say its version now: keeping the old one would show a restart banner for nothing, so none is kept.
    await endOnItsOwn(world, made.id, world.ptys[1]);
    delete world.versions.claude;
    const again = await world.manager.resume(made.id);
    assert.equal(again.agentVersion, null);
  });
});

// ---- restart: { available, reason } on a summary -------------------------------------------------------------

test("a live agent session carries restart { available, reason } worked out by the resume rule as if it had ended; every other kind or status carries null", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    const claude = await world.manager.create({ agentId: "claude", folder: project });
    assert.deepEqual(claude.restart, { available: true, reason: null });

    // A live Hermes alone in its folder: it does not count against itself.
    world.clock += 1000;
    const lonely = await world.manager.create({ agentId: "hermes", folder: other });
    assert.deepEqual(lonely.restart, { available: true, reason: null });

    // An ended session says nothing about restart (its summary.resume answers that).
    const done = await endOnItsOwn(world, lonely.id, world.ptys[1]);
    assert.equal(done.restart, null);
    assert.equal(done.resume.available, true);

    // The update kind never restarts.
    world.clock += 1000;
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: other });
    assert.equal(update.restart, null);

    // The list carries the same answers.
    const listed = await world.manager.list({ includeUpdate: true });
    assert.deepEqual(
      listed.map((summary) => [summary.kind, summary.status === "exited", summary.restart]),
      [
        ["agent", false, { available: true, reason: null }],
        ["agent", true, null],
        ["update", false, null]
      ]
    );
  });
});

test("restart is unavailable for the reasons Resume has: another ended Hermes session in the folder, or the agent no longer installed", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const first = await world.manager.create({ agentId: "hermes", folder: project });
    await endOnItsOwn(world, first.id, world.ptys[0]);
    const second = await world.manager.create({ agentId: "hermes", folder: project });
    // Stopping this one would leave two ended Hermes sessions in the folder: Hermes could not tell which to resume.
    assert.deepEqual(second.restart, { available: false, reason: SHARED_FOLDER });
    assert.deepEqual((await world.manager.get(second.id)).restart, { available: false, reason: SHARED_FOLDER });

    const claude = await world.manager.create({ agentId: "claude", folder: path.dirname(project) });
    assert.deepEqual(claude.restart, { available: true, reason: null });
    world.installed.delete("claude");
    assert.deepEqual((await world.manager.get(claude.id)).restart, {
      available: false,
      reason: "Claude Code isn't installed anymore."
    });
  });
});

test("the live-only list reads memory only: it detects no agent and its restart is null, because only the running sessions are in view", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    assert.deepEqual(made.restart, { available: true, reason: null });
    world.installed.delete("claude");
    const before = world.detectCalls;
    const [live] = await world.manager.list({ liveOnly: true });
    assert.equal(world.detectCalls, before, "no agent CLI is asked, so Hold to stop all never waits on one");
    assert.equal(live.restart, null, "not worked out there: the folder rule needs the ended sessions too");
    assert.equal(live.agentVersion, null, "the other new field is still in the summary");
    // The ordinary list still works it out.
    const [ordinary] = await world.manager.list();
    assert.equal(ordinary.restart.available, false);
  });
});

// ---- restart ------------------------------------------------------------------------------------------------

test("restart: the Stop sequence ends the old process, the same tab id resumes in the same folder with the agent's resume argv, and nothing is typed", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld();
    world.versions.claude = "2.1.309 (Claude Code)";
    const made = await world.manager.create({ agentId: "claude", folder: project });
    const frames = [];
    await world.manager.attach(made.id, { id: "w", send: (frame) => frames.push(frame), close() {} });
    assert.equal(world.manager.focus(made.id, "w"), true);
    const oldPty = world.ptys[0];

    world.versions.claude = "2.2.0 (Claude Code)"; // the update the person is restarting for
    world.clock = Date.parse("2026-10-31T09:30:00.000Z");
    const restarted = await world.manager.restart(made.id);

    // The same Stop sequence as Stop session: the agent's soft stop, then the process tree.
    assert.deepEqual(world.events, ["soft", "kill"]);
    assert.deepEqual(world.killCalls, [oldPty.pid]);
    assert.equal(world.ptys.length, 2, "one new process");

    // The same tab and folder, on the agent's own resume.
    assert.equal(restarted.id, made.id);
    assert.equal(restarted.status, "starting");
    assert.equal(restarted.startedAt, "2026-10-31T09:30:00.000Z");
    assert.equal(restarted.endedAt, null);
    assert.equal(restarted.endedBy, null);
    assert.equal(restarted.dismissed, false);
    assert.equal(restarted.folder, project);
    assert.deepEqual(world.profileInputs[1].resume, { agentSessionId: CLAUDE_UUID });
    assert.deepEqual(world.ptys[1].opts.args, ["--resume", CLAUDE_UUID]);
    assert.equal(world.ptys[1].opts.cwd, project);

    // It runs on the version the agent has now.
    assert.equal(restarted.agentVersion, "2.2.0 (Claude Code)");
    const meta = await metaOnDisk(agentOsHome, made.id);
    assert.equal(meta.agentVersion, "2.2.0 (Claude Code)");
    assert.equal(meta.resumes, 1);
    assert.notEqual(meta.status, "exited");

    // No keys: not one byte went into either terminal.
    assert.deepEqual(
      world.ptys.map((pty) => pty.writes),
      [[], []]
    );
    assert.deepEqual(world.ptys[0].opts.args, ["--new", made.id], "the first run was the new session");
  });
});

test("restart refuses without resume: 409 resume_unavailable with the resume rule's own reason, before anything stops, and the session is still live", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const first = await world.manager.create({ agentId: "hermes", folder: project });
    await endOnItsOwn(world, first.id, world.ptys[0]);
    const second = await world.manager.create({ agentId: "hermes", folder: project });

    await assert.rejects(
      world.manager.restart(second.id),
      (error) => error.status === 409 && error.code === "resume_unavailable" && error.message === SHARED_FOLDER
    );
    assert.deepEqual(world.events, [], "no soft stop and no kill: nothing was stopped");
    assert.equal(world.ptys.length, 2, "and nothing was started");
    assert.equal((await world.manager.get(second.id)).status, "starting");
    assert.deepEqual(world.ptys[1].writes, []);

    // The agent was removed while the session ran: it could not start again, so the session is not stopped.
    const claude = await world.manager.create({ agentId: "claude", folder: path.dirname(project) });
    world.installed.delete("claude");
    await assert.rejects(
      world.manager.restart(claude.id),
      (error) =>
        error.status === 409 && error.code === "resume_unavailable" && error.message === "Claude Code isn't installed anymore."
    );
    assert.deepEqual(world.events, []);
    assert.notEqual((await world.manager.get(claude.id)).status, "exited");
  });
});

test("restart of an update session is 400 and runs nothing; an unknown id is 404 and an ended session is 409", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    await assert.rejects(
      world.manager.restart(update.id),
      (error) =>
        error.status === 400 && error.code === "not_restartable" && error.message === "Only an agent session can be restarted."
    );
    assert.deepEqual(world.events, []);
    assert.notEqual((await world.manager.get(update.id)).status, "exited", "the update session is still running");

    await assert.rejects(world.manager.restart(crypto.randomUUID()), (error) => error.status === 404 && error.code === "unknown_session");
    await assert.rejects(world.manager.restart("not-an-id"), (error) => error.status === 404 && error.code === "unknown_session");

    const made = await world.manager.create({ agentId: "claude", folder: other });
    await endOnItsOwn(world, made.id, world.ptys[1]);
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 409 && error.code === "session_ended",
      "an ended session is brought back with Resume, not Restart"
    );
    assert.equal(world.ptys.length, 2, "nothing started");
  });
});

test("restart with Look only on: 409 execution_gate_off before anything stops, so the conversation is not left stopped", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    world.gate = false;
    await assert.rejects(world.manager.restart(made.id), (error) => error.status === 409 && error.code === "execution_gate_off");
    assert.deepEqual(world.events, []);
    assert.notEqual((await world.manager.get(made.id)).status, "exited");
  });
});

test("two restarts at once: the second is told the session is busy, and only one new process starts", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    const results = await Promise.allSettled([world.manager.restart(made.id), world.manager.restart(made.id)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const refused = results.find((result) => result.status === "rejected").reason;
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "session_busy");
    assert.equal(world.ptys.length, 2, "one new process, not two");
    assert.deepEqual(world.events, ["soft", "kill"]);
  });
});

test("restart whose process does not end after the Stop sequence: 409 and no resume, and the sentence stays with the session when it ends a moment late", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    world.killMakesExit = false; // the kill did not take within Stop's wait
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 409 && error.code === "session_live" && error.message === NOT_STOPPED
    );
    assert.equal(world.ptys.length, 1, "no second process was started, so none runs beside the first");
    assert.notEqual((await world.manager.get(made.id)).status, "exited");

    // The kill lands just after the wait: the ended session carries why it was not restarted (I4).
    world.ptys[0].exit(null, "SIGTERM");
    const done = await ended(world, made.id);
    assert.equal(done.keepGoingFailure, NOT_STOPPED);
    assert.equal(world.ptys.length, 1);

    // Resume brings it back, and the sentence goes with the run that follows.
    await world.manager.resume(made.id);
    const again = await endOnItsOwn(world, made.id, world.ptys[1]);
    assert.equal(again.keepGoingFailure, null);
  });
});

// ---- a Stop during a restart wins (I1) ---------------------------------------------------------------------

// A promise a test settles by hand, so it can act while the soft stop of a Stop is still running.
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("a Stop during a restart's stop wins: both are answered with the ended session and nothing is resumed", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    const held = gate();
    world.softGate = held.promise;

    const restarting = world.manager.restart(made.id);
    await waitFor(() => world.events.includes("soft")); // the restart's own stop is running
    const stopped = world.manager.stop(made.id); // the person's Stop joins that sequence
    held.open();
    const [restartAnswer, stopAnswer] = await Promise.all([restarting, stopped]);

    assert.equal(stopAnswer.status, "exited");
    assert.equal(restartAnswer.status, "exited", "the restart answers the ended session");
    assert.equal(restartAnswer.id, made.id);
    assert.equal(world.ptys.length, 1, "the agent did not come back after the Stop that said it was stopped");
    assert.deepEqual(world.events, ["soft", "kill"], "one Stop sequence, shared");
    assert.equal(world.profileInputs.length, 1, "no resume was even prepared");
    assert.equal((await world.manager.get(made.id)).status, "exited");
  });
});

test("Hold to stop all during a restart's stop wins as well: nothing is resumed", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    const held = gate();
    world.softGate = held.promise;

    const restarting = world.manager.restart(made.id);
    await waitFor(() => world.events.includes("soft"));
    const all = world.manager.shutdownAll({ reason: "stop" });
    held.open();
    const [restartAnswer, result] = await Promise.all([restarting, all]);

    assert.deepEqual(result, { stopped: 1 });
    assert.equal(restartAnswer.status, "exited");
    assert.equal(world.ptys.length, 1, "no new process after an emergency stop that reported success");
    assert.equal((await world.manager.get(made.id)).status, "exited");
  });
});

test("a Stop that comes in while the restart is still checking also wins: the restart stops nothing more and resumes nothing", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    // The saved brain takes a moment to check; the person's Stop arrives meanwhile.
    const slowBrain = gate();
    const checksBefore = world.brainChecks;
    world.brainGate = slowBrain.promise;

    const restarting = world.manager.restart(made.id);
    await waitFor(() => world.brainChecks > checksBefore); // past the other checks, waiting on the brain
    const stopped = await world.manager.stop(made.id);
    slowBrain.open();
    const answer = await restarting;

    assert.equal(stopped.status, "exited");
    assert.equal(answer.status, "exited");
    assert.equal(world.ptys.length, 1, "nothing was resumed");
    assert.deepEqual(world.events, ["soft", "kill"], "only the person's Stop ran");
  });
});

test("Restart clicked while a Stop is already running is refused as busy, and the Stop's result stands", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    const held = gate();
    world.softGate = held.promise;

    const stopped = world.manager.stop(made.id);
    await waitFor(() => world.events.includes("soft"));
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 409 && error.code === "session_busy" && error.message === BUSY_MESSAGE
    );
    held.open();
    assert.equal((await stopped).status, "exited");
    assert.equal(world.ptys.length, 1, "the agent did not come back");
    assert.deepEqual(world.events, ["soft", "kill"]);

    // The refused click left nothing behind: the next Restart of a session that runs again works.
    await world.manager.resume(made.id);
    world.softGate = null;
    const restarted = await world.manager.restart(made.id);
    assert.equal(restarted.status, "starting");
  });
});

// ---- a restart is not offered while that agent's update runs (SP5 E1, M1) ---------------------------------------

test("restart is refused with update_running while that agent's update runs, before anything stops; other agents are not in its way, and it works again once the update ends", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    const claude = await world.manager.create({ agentId: "claude", folder: project });
    const codex = await world.manager.create({ agentId: "codex", folder: other });
    world.updating.add("claude");

    await assert.rejects(
      world.manager.restart(claude.id),
      (error) => error.status === 409 && error.code === "update_running" && error.message === "Claude Code is already updating."
    );
    assert.deepEqual(world.events, [], "nothing was stopped");
    assert.equal(world.ptys.length, 2, "and nothing started");
    assert.notEqual((await world.manager.get(claude.id)).status, "exited", "the session is still live");
    assert.equal(world.refreshAsked, 0, "the agent was not even asked for its version");

    // Another agent's session is not in its way.
    const restartedCodex = await world.manager.restart(codex.id);
    assert.equal(restartedCodex.status, "starting");

    world.updating.clear();
    assert.equal((await world.manager.restart(claude.id)).status, "starting", "the update ended: the restart works");
  });
});

test("restart is refused while an update SESSION of that agent is live in this manager (Hermes), whatever the update service says", async () => {
  await withSessionEnv(async ({ project, other }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "hermes", folder: project });
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: other });
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 409 && error.code === "update_running" && error.message === "Hermes is already updating."
    );
    assert.deepEqual(world.events, []);
    assert.notEqual((await world.manager.get(made.id)).status, "exited");

    // The update session ends: the restart is allowed.
    world.ptys[1].exit(0);
    await ended(world, update.id);
    assert.equal((await world.manager.restart(made.id)).status, "starting");
  });
});

// ---- a Stop after the restart's stop and before its new process starts (SP5 E1, L44) -------------------------------

test("a Stop that lands while the restart's fresh version check runs wins: no new process starts, and the restart answers the ended session", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    const held = gate();
    world.refreshGate = held.promise;

    const restarting = world.manager.restart(made.id);
    await waitFor(() => world.refreshAsked > 0); // the old process is stopped; the resume waits on the version check
    assert.equal((await world.manager.get(made.id)).status, "exited");
    // The session is being changed right now, so this Stop may be answered "busy"; either way it counts and cancels the restart.
    const stopAnswer = await world.manager.stop(made.id).then(
      (summary) => summary,
      (error) => error
    );
    assert.ok(stopAnswer.status === "exited" || stopAnswer.code === "session_busy", `Stop answered ${stopAnswer.code ?? stopAnswer.status}`);
    held.open();
    const answer = await restarting;

    assert.equal(answer.status, "exited", "the restart answers the ended session");
    assert.equal(answer.id, made.id);
    assert.equal(world.ptys.length, 1, "no new process: the agent did not come back after the Stop");
    assert.equal((await world.manager.get(made.id)).status, "exited");
    assert.deepEqual(world.events, ["soft", "kill"], "one Stop sequence, the restart's own");
    // Nothing is left half done: the session can be resumed by the person and the next restart works.
    assert.equal((await world.manager.resume(made.id)).status, "starting");
  });
});

for (const reason of ["stop", "quit"]) {
  test(`Hold to stop all (${reason}) that lands while the restart's fresh version check runs wins as well: no new process starts`, async () => {
    await withSessionEnv(async ({ project }) => {
      const world = fakeWorld();
      const made = await world.manager.create({ agentId: "claude", folder: project });
      const held = gate();
      world.refreshGate = held.promise;

      const restarting = world.manager.restart(made.id);
      await waitFor(() => world.refreshAsked > 0);
      // The old process has ended, so the stop-all list does not hold this session: it must still stop the restart.
      const result = await world.manager.shutdownAll({ reason });
      assert.deepEqual(result, { stopped: 0 });
      held.open();
      const answer = await restarting;

      assert.equal(answer.status, "exited");
      assert.equal(world.ptys.length, 1, "no new process after an emergency stop that reported success");
      assert.equal((await world.manager.get(made.id)).status, "exited");
    });
  });
}

// Hold to stop all runs in the browser: it reads the live-only list and stops each session that isn't "exited". In
// the moment between a restart's stop and the new process, the old process has ended, so the session must still be
// in that list (as "starting"), or the hold never reaches it and the agent comes back after it reported success.
test("the live-only list still shows a session in the middle of a restart, so Hold to stop all's Stop reaches it and nothing comes back", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    const held = gate();
    world.refreshGate = held.promise;

    const restarting = world.manager.restart(made.id);
    await waitFor(() => world.refreshAsked > 0); // the old process is stopped; the resume waits on the version check
    const listed = (await world.manager.list({ liveOnly: true })).filter((session) => session.id === made.id);
    assert.equal(listed.length, 1, "the restarting session is in the list the hold reads");
    assert.notEqual(listed[0].status, "exited", "and it is not shown as ended, so the hold stops it");
    // What the hold does with it: one Stop, which may be answered "busy" while the session changes.
    await world.manager.stop(made.id).catch(() => {});
    held.open();
    const answer = await restarting;

    assert.equal(answer.status, "exited");
    assert.equal(world.ptys.length, 1, "no new process after the hold");
    assert.deepEqual(
      (await world.manager.list({ liveOnly: true })).filter((session) => session.id === made.id),
      [],
      "once the restart is over, an ended session is no longer listed"
    );
  });
});

// ---- everything that can refuse is asked before the stop (I2) -----------------------------------------------

test("restart with the session's folder gone: refused with the folder rule's sentence before anything stops, and the session is still live", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    await rm(project, { recursive: true, force: true }); // removed while the session runs
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 400 && error.code === "folder_refused" && error.message === "That folder doesn't exist."
    );
    assert.deepEqual(world.events, [], "nothing was stopped");
    assert.equal(world.ptys.length, 1);
    assert.notEqual((await world.manager.get(made.id)).status, "exited");
  });
});

test("restart with a saved brain that no longer resolves: refused with the brain's own error before anything stops", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    world.brainError = sessionError(409, "brain_unavailable", "The saved brain can't be used anymore.");
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 409 && error.code === "brain_unavailable" && error.message === "The saved brain can't be used anymore."
    );
    assert.deepEqual(world.events, []);
    assert.equal(world.ptys.length, 1);
    assert.notEqual((await world.manager.get(made.id)).status, "exited");
  });
});

test("restart with the terminal module unavailable: 503 before anything stops", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    world.ptyOk = false;
    await assert.rejects(world.manager.restart(made.id), (error) => error.status === 503 && error.code === "pty_unavailable");
    assert.deepEqual(world.events, []);
    assert.notEqual((await world.manager.get(made.id)).status, "exited");
  });
});

// ---- a fresh Claude Code session cannot be restarted (I3) ---------------------------------------------------

test("a fresh Claude Code session with its hooks on is not restartable (nothing was ever sent); one prompt makes it restartable", async () => {
  await withSessionEnv(async ({ agentOsHome, project }) => {
    const world = fakeWorld(HOOKS_ON);
    const made = await world.manager.create({ agentId: "claude", folder: project });
    assert.deepEqual(made.restart, { available: false, reason: NOTHING_TO_RESUME });
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 409 && error.code === "resume_unavailable" && error.message === NOTHING_TO_RESUME
    );
    assert.deepEqual(world.events, [], "nothing was stopped");

    // The person sends a first prompt: Claude's UserPromptSubmit hook says so, and a conversation now exists.
    world.manager.onHook(made.id, PROMPT_EVENT);
    assert.deepEqual((await world.manager.get(made.id)).restart, { available: true, reason: null });
    await waitFor(async () => (await metaOnDisk(agentOsHome, made.id))?.prompted === true); // kept in meta.json
    const restarted = await world.manager.restart(made.id);
    assert.equal(restarted.status, "starting");
    assert.equal(world.ptys.length, 2);

    // A resumed run already had its conversation: restartable again with no new prompt.
    assert.deepEqual((await world.manager.get(made.id)).restart, { available: true, reason: null });
  });
});

test("with the hooks off for the run the prompt can't be seen, so a fresh Claude Code session stays restartable; so do the other agents and a server with no hook address", async () => {
  await withSessionEnv(async ({ project, other }) => {
    // The person's settings keep Agent OS's hooks out of this run.
    const off = fakeWorld(HOOKS_ON);
    off.claudeProfile = { hookUrl: "http://127.0.0.1:4567/hooks", hooksOff: { alerts: "http_hook_urls", meter: null }, statusLineFrom: null };
    const blocked = await off.manager.create({ agentId: "claude", folder: project });
    assert.deepEqual(blocked.restart, { available: true, reason: null });

    // Hooks on, but the agent is not Claude Code: no such prediction.
    const on = fakeWorld(HOOKS_ON);
    const codex = await on.manager.create({ agentId: "codex", folder: other });
    assert.deepEqual(codex.restart, { available: true, reason: null });

    // No hook address was given (the server had no port yet): no prompt would ever be seen, so no prediction.
    const noPort = fakeWorld();
    const claude = await noPort.manager.create({ agentId: "claude", folder: project });
    assert.deepEqual(claude.restart, { available: true, reason: null });
  });
});

// ---- a failure after the stop leaves its sentence on the ended session (I4) ---------------------------------

test("restart whose resume fails after the stop: the ended session carries the failure's sentence, and the next run clears it", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    const made = await world.manager.create({ agentId: "claude", folder: project });
    world.spawnError = "Agent OS could not start Claude Code in that folder.";
    await assert.rejects(
      world.manager.restart(made.id),
      (error) => error.status === 500 && error.code === "start_failed" && error.message === "Agent OS could not start Claude Code in that folder."
    );
    assert.deepEqual(world.events, ["soft", "kill"], "it was stopped before the start failed");

    const done = await ended(world, made.id);
    assert.equal(done.keepGoingFailure, "Agent OS could not start Claude Code in that folder.");
    assert.equal((await world.manager.get(made.id)).keepGoingFailure, done.keepGoingFailure, "and it stays on the next read");
    assert.equal(done.resume.available, true, "the person can still resume it");

    // Running again clears it (and so does a later Restart before its stop).
    await world.manager.resume(made.id);
    const second = await endOnItsOwn(world, made.id, world.ptys[1]);
    assert.equal(second.keepGoingFailure, null);
  });
});

// ---- the version a restart records (M3) ---------------------------------------------------------------------

test("a restart asks the agent again (refresh) before it records the version, so an update made outside Agent OS a moment ago is seen", async () => {
  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld();
    world.staleDetect = true; // detection answers from its 30 s memory unless asked to refresh
    world.versions.claude = "2.1.309 (Claude Code)";
    const made = await world.manager.create({ agentId: "claude", folder: project });
    assert.equal(made.agentVersion, "2.1.309 (Claude Code)");

    world.versions.claude = "2.2.0 (Claude Code)"; // Claude's own auto-updater, seconds ago: the memory is stale
    const restarted = await world.manager.restart(made.id);
    assert.equal(restarted.agentVersion, "2.2.0 (Claude Code)");
    assert.equal(world.detectOptions.filter((options) => options?.refresh === true).length, 1, "only the restart's resume refreshes");

    // An ordinary resume keeps using the memory (no extra work for Resume, nothing changes there).
    await endOnItsOwn(world, made.id, world.ptys[1]);
    world.versions.claude = "2.3.0 (Claude Code)";
    const plain = await world.manager.resume(made.id);
    assert.equal(plain.agentVersion, "2.2.0 (Claude Code)");
    assert.equal(world.detectOptions.filter((options) => options?.refresh === true).length, 1);
  });
});

// ---- real PTY, with the W1 TUI fake -------------------------------------------------------------------------

// The environment of the fake agent's terminal: the fake bin and the system folders, the stand-in login shell.
function ptyEnv(home, bin, logFile) {
  return {
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    SHELL: FAKE_LOGIN_SHELL,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    FAKE_AGENT_MODE: "tui",
    FAKE_AGENT_LOG: logFile
  };
}

// What the fake agent logged (FAKE_AGENT_LOG), one JSON object per line.
async function loggedEvents(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("real PTY: the session records the version the fake CLI prints for --version, and Restart moves the same tab to a new process on the new version with no input", SKIP_POSIX, async () => {
  await withSessionEnv(async ({ home, agentOsHome, bin, project }) => {
    const logFile = path.join(bin, "agent-events.log");
    const running = new Set();
    const typed = [];
    let id = null;
    try {
      await setFakeKnob(home, "FAKE_CLAUDE_VERSION", "2.1.309 (Claude Code)");
      const manager = createSessionManager({
        ...NO_GIT_OPTIONS,
        isExecutionAllowed: async () => true,
        // The real agent detection: it runs the fake's `--version` from the fake bin (refresh: no 30 s memory here).
        detect: (agentId) => getAdapter(agentId).detect({ refresh: true }),
        resolveBrain: async () => null,
        buildProfile: async (input) => ({
          command: path.join(bin, "claude"),
          args: input.resume ? ["--resume", CLAUDE_UUID] : ["--session-id", CLAUDE_UUID],
          cwd: input.folder ?? os.homedir(),
          env: ptyEnv(home, bin, logFile),
          agentSessionId: CLAUDE_UUID,
          settingsFile: null,
          softStop: null,
          resumeMode: "id",
          folderShown: true,
          notes: []
        }),
        spawn: async (options) => {
          const handle = await spawnPty(options);
          running.add(handle.pid);
          handle.onExit(() => running.delete(handle.pid));
          // The terminal handle is frozen, so a copy that records what is typed stands in for it.
          return {
            ...handle,
            write(data) {
              typed.push(data);
              return handle.write(data);
            }
          };
        }
      });

      const made = await manager.create({ agentId: "claude", folder: project });
      id = made.id;
      assert.equal(made.agentVersion, "2.1.309 (Claude Code)", "the fake's --version line");
      assert.equal((await metaOnDisk(agentOsHome, id)).agentVersion, "2.1.309 (Claude Code)");
      const [firstStart] = await waitFor(async () => {
        const found = (await loggedEvents(logFile)).filter((entry) => entry.event === "start");
        return found.length === 1 ? found : null;
      });
      const oldPid = firstStart.pid;
      assert.deepEqual(firstStart.argv, ["--session-id", CLAUDE_UUID]);

      // "An update": the fake now prints another version.
      await setFakeKnob(home, "FAKE_CLAUDE_VERSION", "2.2.0 (Claude Code)");
      const restarted = await manager.restart(id);
      assert.equal(restarted.id, id);
      assert.equal(restarted.agentVersion, "2.2.0 (Claude Code)");
      assert.equal(restarted.folder, project);

      const starts = await waitFor(async () => {
        const found = (await loggedEvents(logFile)).filter((entry) => entry.event === "start");
        return found.length === 2 ? found : null;
      });
      assert.deepEqual(starts[1].argv, ["--resume", CLAUDE_UUID], "the agent's own resume");
      assert.equal(starts[1].cwd, await realpath(project), "in the same folder");
      assert.notEqual(starts[1].pid, oldPid, "a new process");
      await waitFor(() => !isAlive(oldPid));

      // Nothing was typed: the manager wrote no byte, and the fake read no line, paste, key or reply.
      assert.deepEqual(typed, []);
      const inputs = (await loggedEvents(logFile)).filter((entry) => ["line", "paste", "key", "reply"].includes(entry.event));
      assert.deepEqual(inputs, [], "the fake recorded no input");
      assert.equal((await metaOnDisk(agentOsHome, id)).resumes, 1);

      // Clean up through the manager, then wait for meta.json so nothing writes into the temp folder after it goes.
      await manager.stop(id);
      await waitFor(async () => (await metaOnDisk(agentOsHome, id))?.status === "exited");
    } finally {
      for (const pid of [...running]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
        running.delete(pid);
      }
    }
  });
});
