// Session manager (SP3): the one place that owns a session's life.
//
// It starts an agent's own terminal program in a PTY (pty-host.js) with the
// profile from profiles.js, feeds every byte of output to the screen mirror
// (mirror.js) and the recording (recorder.js), hands that output to every
// window attached to the session with flow control, works out the activity
// state, and keeps <AGENT_OS_HOME>/sessions/<id>/meta.json (0600, in a 0700
// folder).
//
// Hard rules (spec "SP3 Sessions engine and page", Security 6):
// - The only bytes this file writes into a PTY are the writer's input
//   (write()) and the mirror's replies to terminal queries, which the mirror
//   sends only while no window is the writer (startProcess()).
// - An agent session starts or resumes only when Safety allows running agents
//   (decision Q15). The update kind is not gated.
// - At most `maxLive` live agent sessions. Update sessions are not counted,
//   and at most one update session runs at a time.
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getAdapter } from "../agents/index.js";
import { BUILDER_AGENT_IDS } from "../builders/brains.js";
import { resolveBrainForRun } from "../builders/resolve.js";
import { isExecutionEnabled } from "../execution-gate.js";
import { killProcessTree } from "../process-tree.js";
import { registerShutdownTask } from "../shutdown.js";
import { RUNTIME_VERSION, ensurePrivateDir, readJson, runtimePaths, writeJson as writeJsonFile } from "../store.js";
import { isSessionId, sessionError } from "./errors.js";
import { checkSessionFolder } from "./folders.js";
import { createMirror, isUserInput } from "./mirror.js";
import { OPENCLAW_FOLDER_HONOURED, SESSION_AGENTS, SESSION_AGENT_LABEL, buildSessionProfile } from "./profiles.js";
import { ptyAvailable, spawnPty } from "./pty-host.js";
import { CAST_FILE, createRecorder, enforceRecordingCap } from "./recorder.js";
import { readSessionSettings } from "./settings.js";
import { runSoftStop } from "./soft-stop.js";

// Each shared name has one home: errors.js (the id pattern and the error
// shape) and profiles.js (the agents' short names). Re-exported here so
// routes.js, ws.js and the tests may import them from the manager.
export { SESSION_ID_RE, isSessionId, sessionError } from "./errors.js";
export { SESSION_AGENT_LABEL } from "./profiles.js";

// The basic activity rule, used for every session in SP3.
export const IDLE_AFTER_MS = 20 * 1000;
// Flow control (spec "WebSocket protocol", Back-pressure).
export const PAUSE_LAG_BYTES = 512 * 1024;
export const CLOSE_LAG_BYTES = 4 * 1024 * 1024;
// A PTY paused this long closes the windows that still lag (updateFlow()).
export const PAUSED_DROP_MS = 10 * 1000;
// One `in` frame carries at most 64 KB.
export const MAX_INPUT_BYTES = 64 * 1024;
// The Stop sequence (spec "Persistence, quit and Stop"): the kill grace after
// the soft stop, and the cap on a whole quit. Soft stop at most 2 s, then one
// `ps` listing (usually tens of milliseconds), the 3 s grace, at most 1 s after
// the SIGKILL and at most 1 s to see the exit: about 7 s, and a quit never
// waits longer than SHUTDOWN_GUARD_MS (the same 7 s as shutdown.js's task
// limit), inside the server's 8 s hard exit and the desktop shell's 10 s
// QUIT_GRACE.
export const STOP_GRACE_MS = 3000;
export const SHUTDOWN_GUARD_MS = 7000;
const EXIT_WAIT_MS = 1000;

const START_COLS = 120;
const START_ROWS = 32;
// After a resize the agent redraws for the new size, and the mirror may count
// that reflow; for this long it is not activity (Task S4 Notes item 4).
const RESIZE_QUIET_MS = 1000;
const META_FILE = "meta.json";
const META_VERSION = 1;
const RECORDING_FILES = ["screen.cast", "screen.prev.cast"];
const BRAIN_LABEL = { plan: "Plan", openrouter: "OpenRouter", local: "Local" };
const LOOK_ONLY_MESSAGE = "Safety is on Look only, so no session can start. Allow running agents in Safety, then try again.";
const PTY_MESSAGE = "Agent OS could not load its terminal module on this computer, so sessions can't start.";
const UNKNOWN_MESSAGE = "That session doesn't exist anymore.";
const BUSY_MESSAGE = "This session is already being changed. Try again in a moment.";
const SAVE_FAILED_MESSAGE = "Agent OS could not save this session, so it was stopped. Check the free disk space, then try again.";
// How long a process that started but could not be saved gets to end on its own
// before it is killed (the same grace as Stop).
const FAILED_START_GRACE_MS = 3000;
const SIGNAL_NAMES = signalNameTable();

// ---- small helpers ----------------------------------------------------------------------------------

function unknownSession() {
  return sessionError(404, "unknown_session", UNKNOWN_MESSAGE);
}

function assertSessionId(id) {
  if (!isSessionId(id)) throw unknownSession();
}

// The first name for each signal number (SIGABRT before SIGIOT).
function signalNameTable() {
  const table = {};
  for (const [name, number] of Object.entries(os.constants.signals)) {
    if (!(number in table)) table[number] = name;
  }
  return table;
}

function signalName(signal) {
  if (typeof signal === "string" && signal) return signal;
  if (typeof signal === "number" && signal > 0) return SIGNAL_NAMES[signal] || `SIG${signal}`;
  return null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function sessionsRoot() {
  return runtimePaths().sessions;
}

function sessionDir(id) {
  return path.join(sessionsRoot(), id);
}

async function readMeta(id) {
  const meta = await readJson(path.join(sessionDir(id), META_FILE), null);
  return meta && typeof meta === "object" && meta.id === id ? meta : null;
}

async function listSessionIds() {
  try {
    return (await fs.readdir(sessionsRoot())).filter((name) => isSessionId(name));
  } catch {
    return [];
  }
}

async function recordingBytes(id) {
  let total = 0;
  for (const name of RECORDING_FILES) {
    try {
      total += (await fs.stat(path.join(sessionDir(id), name))).size;
    } catch {
      // no such segment yet
    }
  }
  return total;
}

// When a session whose exit was never recorded (a hard kill, a crash) was last
// known to be alive: its recording's last write, else the time its status last
// changed, else its start. null when meta.json holds no usable time.
async function lastKnownTime(id, meta) {
  try {
    const { mtimeMs } = await fs.stat(path.join(sessionDir(id), CAST_FILE));
    if (Number.isFinite(mtimeMs) && mtimeMs > 0) return iso(mtimeMs);
  } catch {
    // no recording yet
  }
  for (const candidate of [meta.stateSince, meta.startedAt]) {
    if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) return candidate;
  }
  return null;
}

// The branch the folder is on, read from git's own files (no git process):
// walk up to the nearest .git, follow a worktree's "gitdir:" file, and read
// HEAD. A detached HEAD or no checkout at all gives null.
export async function readGitBranch(folder) {
  let dir = path.resolve(String(folder || "/"));
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(dir, ".git");
    let info = null;
    try {
      info = await fs.stat(dotGit);
    } catch {
      info = null;
    }
    if (info) {
      let gitDir = dotGit;
      if (info.isFile()) {
        const pointer = await fs.readFile(dotGit, "utf8").catch(() => "");
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
        if (!match) return null;
        gitDir = path.resolve(dir, match[1]);
      }
      const head = await fs.readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "");
      const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head.trim());
      return ref ? ref[1].slice(0, 200) : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// The Brain row of the side panel. Hermes and OpenClaw keep their model in
// their own config, so Agent OS shows no brain for them.
function brainSummary(agentId, resolved) {
  if (!BUILDER_AGENT_IDS.includes(agentId)) return null;
  const kind = resolved && Object.hasOwn(BRAIN_LABEL, resolved.mode) ? resolved.mode : "plan";
  return { kind, label: BRAIN_LABEL[kind] };
}

function titleOf(meta) {
  if (meta.kind === "update") return `${meta.agentLabel} update`;
  return `${meta.agentLabel} · ${meta.folderShown === false ? "Set by OpenClaw" : meta.folderName}`;
}

function byCreated(a, b) {
  return String(a.createdAt || a.startedAt || "").localeCompare(String(b.createdAt || b.startedAt || ""));
}

function safeSend(attachment, frame) {
  try {
    attachment.send(frame);
  } catch {
    // a closing window must never break the session
  }
}

function defaultDetect(agentId) {
  const adapter = getAdapter(agentId);
  return adapter ? adapter.detect() : Promise.resolve({ installed: false, path: "" });
}

function defaultResolveBrain(agentId) {
  return resolveBrainForRun(agentId, undefined, { prepare: true });
}

// ---- the manager --------------------------------------------------------------------------------------

export function createSessionManager({
  now = Date.now,
  spawn = spawnPty,
  buildProfile = buildSessionProfile,
  recorderFactory = createRecorder,
  mirrorFactory = createMirror,
  maxLive = 8,
  isExecutionAllowed = isExecutionEnabled,
  checkFolder = checkSessionFolder,
  ptyCheck = ptyAvailable,
  detect = defaultDetect,
  resolveBrain = defaultResolveBrain,
  readSettings = readSessionSettings,
  enforceCap = enforceRecordingCap,
  writeJson = writeJsonFile,
  killTree = killProcessTree,
  softStop = runSoftStop
} = {}) {
  // id -> state, while the session's process runs. Disk is the truth for
  // every ended session.
  const live = new Map();
  // ids being resumed or dismissed right now, so two requests never race: a
  // second request for one of them is answered "session_busy".
  const busy = new Set();
  // Slots held by starts that have not finished yet.
  let reservedAgents = 0;
  let reservedUpdate = false;
  // The same starts, by agent and folder (set once the folder is known), so the
  // fallback-resume rule also sees a New session that is still starting there.
  const openStarts = new Set();

  function liveCount(kind) {
    let count = 0;
    for (const state of live.values()) {
      if (state.meta.kind === kind && state.status !== "exited") count += 1;
    }
    return count;
  }

  function reserve(kind) {
    if (kind === "update") {
      if (reservedUpdate || liveCount("update") > 0) {
        throw sessionError(409, "update_running", "An update is already running. Wait for it to finish, then try again.");
      }
      reservedUpdate = true;
      return;
    }
    if (liveCount("agent") + reservedAgents >= maxLive) {
      throw sessionError(409, "too_many_sessions", `Agent OS runs at most ${maxLive} sessions at once. Stop one, then try again.`);
    }
    reservedAgents += 1;
  }

  // Returns { release, claim }. release() gives the slot back once; it runs as
  // soon as the session is in `live` (where liveCount sees it), or when the
  // start fails, so a session is never counted twice. claim(agentId, folder, id)
  // tells the fallback-resume rule which agent and folder this start is for
  // (id is the session being resumed, null for a new one).
  function reserveSlot(kind) {
    reserve(kind);
    const start = { agentId: null, folder: null, id: null };
    openStarts.add(start);
    let held = true;
    return {
      claim(agentId, folder, id = null) {
        start.agentId = agentId;
        start.folder = folder;
        start.id = id;
      },
      release() {
        if (!held) return;
        held = false;
        openStarts.delete(start);
        if (kind === "update") reservedUpdate = false;
        else reservedAgents -= 1;
      }
    };
  }

  async function requirePty() {
    const status = await ptyCheck();
    if (!status?.ok) throw sessionError(503, "pty_unavailable", PTY_MESSAGE);
  }

  // The folder a session runs in. OpenClaw picks its own folder until spike
  // S5 shows it honours one, so no folder is asked for or checked for it.
  async function resolveFolder(agentId, kind, folder) {
    if (kind === "agent" && agentId === "openclaw" && !OPENCLAW_FOLDER_HONOURED) return { folder: null, shown: false };
    const checked = await checkFolder(typeof folder === "string" ? folder : "");
    if (!checked?.ok) {
      throw sessionError(400, "folder_refused", checked?.message || "That folder can't be used.", {
        code: checked?.code || "refused"
      });
    }
    return { folder: checked.path, shown: true };
  }

  function newState(dir, meta) {
    let resolveExited;
    const exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    return {
      dir,
      meta,
      profile: null,
      status: "starting",
      stateSince: meta.startedAt,
      handle: null,
      mirror: null,
      recorder: null,
      attachments: new Map(),
      writerId: null,
      paused: false,
      pauseTimer: null,
      idleTimer: null,
      ignoreCountedUntil: 0,
      offs: [],
      writes: Promise.resolve(),
      cols: START_COLS,
      rows: START_ROWS,
      endedBy: null,
      exitSeen: false,
      exited,
      resolveExited
    };
  }

  // meta.json writes for one session run one after another, each writing the
  // newest meta, so an older write can never land last.
  function persist(state) {
    const write = () => writeJson(path.join(state.dir, META_FILE), { ...state.meta });
    const next = state.writes.then(write, write);
    state.writes = next.catch(() => {});
    return next;
  }

  function stateFrame(state) {
    const frame = { t: "state", status: state.status };
    if (state.status === "exited") {
      frame.exitCode = state.meta.exitCode;
      frame.signal = state.meta.signal;
      frame.endedBy = state.meta.endedBy;
    }
    return frame;
  }

  function broadcast(state, frame, { queue = false } = {}) {
    for (const attachment of [...state.attachments.values()]) {
      if (attachment.pending) {
        if (queue) attachment.pending.push({ frame });
      } else {
        safeSend(attachment, frame);
      }
    }
  }

  function setStatus(state, status) {
    if (state.status === status) return;
    state.status = status;
    state.stateSince = iso(now());
    broadcast(state, stateFrame(state));
  }

  function armIdle(state) {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (state.status === "live") setStatus(state, "idle");
    }, IDLE_AFTER_MS);
    state.idleTimer.unref?.();
  }

  // Counted output or user input: the session is live, and the 20 s start again.
  function markActive(state) {
    if (state.status === "exited") return;
    if (state.status !== "live") setStatus(state, "live");
    armIdle(state);
  }

  // Pause reading the PTY only when every open window lags more than 512 KB;
  // never with no window at all (the mirror and the recording keep reading).
  // While paused, no output reaches a window, so its lag never grows to the
  // 4 MB close. A window that keeps the PTY paused for PAUSED_DROP_MS (a
  // hidden window, a throttled browser tab, a sleeping second screen) is closed
  // instead, so the agent never blocks on its own output. A window that leaves
  // resumes the PTY through this function, which stops the timer; while the
  // other windows still lag, the timer keeps running.
  function updateFlow(state) {
    if (!state.handle || state.status === "exited") return;
    const open = [...state.attachments.values()];
    const shouldPause =
      open.length > 0 && open.every((attachment) => !attachment.pending && attachment.sent - attachment.acked > PAUSE_LAG_BYTES);
    if (shouldPause && !state.paused) {
      state.paused = true;
      state.handle.pause();
      armPausedDrop(state);
    } else if (!shouldPause && state.paused) {
      state.paused = false;
      clearPausedDrop(state);
      state.handle.resume();
    }
  }

  function armPausedDrop(state) {
    clearPausedDrop(state);
    state.pauseTimer = setTimeout(() => {
      state.pauseTimer = null;
      for (const attachment of [...state.attachments.values()]) {
        if (!attachment.pending && attachment.sent - attachment.acked > PAUSE_LAG_BYTES) {
          dropAttachment(state, attachment.id, "too_far_behind");
        }
      }
      updateFlow(state);
    }, PAUSED_DROP_MS);
    state.pauseTimer.unref?.();
  }

  function clearPausedDrop(state) {
    clearTimeout(state.pauseTimer);
    state.pauseTimer = null;
  }

  function removeAttachment(state, attachmentId) {
    const attachment = state.attachments.get(attachmentId);
    if (!attachment) return null;
    state.attachments.delete(attachmentId);
    if (state.writerId === attachmentId) {
      state.writerId = null;
      try {
        state.mirror.setWriterAttached(false);
      } catch {
        // the mirror is gone once the session has ended
      }
    }
    updateFlow(state);
    return attachment;
  }

  function dropAttachment(state, attachmentId, reason) {
    const attachment = removeAttachment(state, attachmentId);
    if (!attachment) return;
    try {
      attachment.close?.(reason);
    } catch {
      // already closing
    }
  }

  function sendOut(state, attachment, chunk, bytes = Buffer.byteLength(chunk, "utf8")) {
    attachment.sent += bytes;
    safeSend(attachment, { t: "out", seq: attachment.sent, d: chunk });
    if (attachment.sent - attachment.acked > CLOSE_LAG_BYTES) dropAttachment(state, attachment.id, "too_far_behind");
  }

  function onOutput(state, data) {
    const chunk = typeof data === "string" ? data : String(data ?? "");
    if (!chunk) return;
    try {
      state.recorder.output(chunk);
    } catch {
      // the recording must never stop the terminal
    }
    try {
      state.mirror.write(chunk);
    } catch {
      // nor must the mirror
    }
    if (state.status === "starting") markActive(state);
    const bytes = Buffer.byteLength(chunk, "utf8");
    for (const attachment of [...state.attachments.values()]) {
      if (attachment.pending) attachment.pending.push({ chunk });
      else sendOut(state, attachment, chunk, bytes);
    }
    updateFlow(state);
  }

  async function onProcessExit(state, event = {}) {
    if (state.exitSeen) return;
    state.exitSeen = true;
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    clearPausedDrop(state);
    for (const off of state.offs.splice(0)) {
      try {
        off();
      } catch {
        // already unsubscribed
      }
    }
    const signal = signalName(event.signal);
    const endedAt = state.meta.endedAt || iso(now());
    state.meta.status = "exited";
    state.meta.endedAt = endedAt;
    state.meta.exitCode = signal ? null : Number.isInteger(event.exitCode) ? event.exitCode : null;
    state.meta.signal = signal;
    state.meta.endedBy = state.endedBy || null;
    state.meta.lastUsedAt = endedAt;
    state.status = "exited";
    state.stateSince = endedAt;
    const frame = stateFrame(state);
    for (const attachment of [...state.attachments.values()]) {
      if (!attachment.pending) safeSend(attachment, frame);
      dropAttachment(state, attachment.id, "session_ended");
    }
    try {
      state.mirror.dispose();
    } catch {
      // already disposed
    }
    try {
      await state.recorder.close();
    } catch {
      // the recording keeps what it has
    }
    try {
      await persist(state);
    } catch {
      // recovery at the next start covers a failed write
    }
    live.delete(state.meta.id);
    state.resolveExited();
    try {
      // A session stays in `live` until its recording is closed and meta.json
      // is written, so the cap never removes a recording that is still being
      // written. meta.json alone can't tell: during a quit, shutdownAll (Task
      // S7) marks every live session "exited" before its process ends.
      await enforceCap({ isLive: (sessionId) => live.has(sessionId) });
    } catch {
      // the cap runs again at the next start
    }
  }

  // Spawns the profile in a PTY with a fresh mirror and recording.
  //
  // The recording is opened only after the spawn succeeded, and in the same
  // synchronous step the session goes into `live` and gives its slot back. So
  // the recording cap and a Delete from Runs (both ask isLive) never see a
  // recording that is being written as an ended one, and a start that fails
  // never touches the recording at all. Output that arrives before the
  // listeners below are added is handed to the first onData listener by
  // pty-host.js, so nothing is lost.
  async function startProcess(state, profile, { append, releaseSlot }) {
    state.profile = profile;
    state.mirror = mirrorFactory({
      cols: state.cols,
      rows: state.rows,
      now,
      // Security 6: the mirror answers standard terminal queries only while no
      // window is the writer (mirror.js decides); its reply goes to the agent.
      onQueryReply: (reply) => {
        if (state.handle && state.status !== "exited") state.handle.write(reply);
      },
      onAlert: (raw) => broadcast(state, { t: "alert", raw }, { queue: true })
    });
    state.mirror.setWriterAttached(false);
    try {
      state.handle = await spawn({
        command: profile.command,
        args: profile.args,
        cwd: profile.cwd,
        env: profile.env,
        cols: state.cols,
        rows: state.rows
      });
    } catch (error) {
      try {
        state.mirror.dispose();
      } catch {
        // nothing to dispose
      }
      // pty-host.js marks a terminal module that loaded but can't make a terminal.
      if (error?.code === "pty_unavailable") throw sessionError(503, "pty_unavailable", PTY_MESSAGE);
      // ... and says exactly why a program or its folder can't be started; that
      // sentence is more useful than the general one below.
      if (error?.code === "spawn_failed" && typeof error.message === "string" && error.message) {
        throw sessionError(500, "start_failed", error.message);
      }
      throw sessionError(
        500,
        "start_failed",
        `Agent OS could not start ${state.meta.agentLabel}. Check that it is installed, then try again.`
      );
    }
    // From here to the end of this function nothing awaits.
    state.recorder = recorderFactory({ dir: state.dir, cols: state.cols, rows: state.rows, append, now });
    live.set(state.meta.id, state);
    releaseSlot();
    state.offs.push(state.handle.onData((data) => onOutput(state, data)));
    state.offs.push(
      state.handle.onExit((event) => {
        onProcessExit(state, event);
      })
    );
    // Counted output wakes the session, except the redraw right after a resize.
    state.offs.push(
      state.mirror.onCountedOutput(() => {
        if (now() < state.ignoreCountedUntil) return;
        markActive(state);
      })
    );
  }

  // Stops a process that started but whose session could not be saved: its
  // process tree, then its mirror and recording, then its place in `live` (the
  // slot is free as soon as the status says "exited"). A process that ended by
  // itself in the meantime is left to its own exit handler.
  async function abandonStarted(state) {
    if (state.exitSeen) {
      await state.exited;
      return;
    }
    state.exitSeen = true;
    state.status = "exited";
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    clearPausedDrop(state);
    for (const off of state.offs.splice(0)) {
      try {
        off();
      } catch {
        // already unsubscribed
      }
    }
    for (const attachment of [...state.attachments.values()]) dropAttachment(state, attachment.id, "session_ended");
    try {
      await killTree(state.handle.pid, { graceMs: FAILED_START_GRACE_MS });
    } catch {
      // killProcessTree never rejects; nothing else to do here
    }
    try {
      state.mirror.dispose();
    } catch {
      // already disposed
    }
    try {
      await state.recorder.close();
    } catch {
      // the recording keeps what it has
    }
    live.delete(state.meta.id);
    state.resolveExited();
  }

  // The first meta.json write of a start. A process that runs with no record
  // on disk would hold a slot and be lost to the person, so when the write
  // fails the process is stopped and the start fails.
  async function saveStarted(state) {
    try {
      await persist(state);
    } catch {
      await abandonStarted(state);
      throw sessionError(500, "start_failed", SAVE_FAILED_MESSAGE);
    }
  }

  // ---- summaries ------------------------------------------------------------------------------------

  function viewOfState(state) {
    return { ...state.meta, status: state.status, stateSince: state.stateSince };
  }

  function viewOfMeta(meta) {
    return { ...meta, stateSince: meta.status === "exited" ? meta.endedAt || meta.startedAt : meta.startedAt };
  }

  async function collectViews() {
    const ids = new Set([...(await listSessionIds()), ...live.keys()]);
    const views = await Promise.all(
      [...ids].map(async (id) => {
        const state = live.get(id);
        if (state) return viewOfState(state);
        const meta = await readMeta(id);
        return meta ? viewOfMeta(meta) : null;
      })
    );
    return views.filter(Boolean);
  }

  // Resume rules (spec "Resume per agent", decision Q36), worked out on every read.
  function resumeOf(view, views, installed) {
    const fallback = view.kind === "agent" && view.resumeMode === "fallback";
    if (view.kind !== "agent" || view.status !== "exited") return { available: false, reason: null, fallback };
    const label = view.agentLabel;
    if (installed.get(view.agentId) === false) {
      return { available: false, reason: `${label} isn't installed anymore.`, fallback };
    }
    if (fallback) {
      const sameFolder = views.filter(
        (other) => other.kind === "agent" && other.agentId === view.agentId && other.folder === view.folder
      );
      // A session still starting in this folder is not in `views` yet. The
      // resume of this very session never counts against itself.
      const startingHere = [...openStarts].some(
        (start) => start.id !== view.id && start.agentId === view.agentId && start.folder === view.folder
      );
      if (startingHere || sameFolder.some((other) => other.status !== "exited")) {
        return { available: false, reason: `Another ${label} session is open in this folder. Stop it first.`, fallback };
      }
      if (sameFolder.filter((other) => other.status === "exited").length > 1) {
        return {
          available: false,
          reason: `More than one ended ${label} session used this folder, so Agent OS can't tell which conversation to resume.`,
          fallback
        };
      }
    }
    return { available: true, reason: null, fallback };
  }

  async function toSummary(view, views, installed) {
    return {
      id: view.id,
      kind: view.kind,
      agentId: view.agentId,
      agentLabel: view.agentLabel,
      folder: view.folder,
      folderName: view.folderName,
      folderShown: view.folderShown !== false,
      branch: view.branch ?? null,
      status: view.status,
      stateSince: view.stateSince,
      startedAt: view.startedAt,
      endedAt: view.endedAt ?? null,
      exitCode: view.exitCode ?? null,
      signal: view.signal ?? null,
      endedBy: view.endedBy ?? null,
      dismissed: view.dismissed === true,
      brain: view.brain ?? null,
      resume: resumeOf(view, views, installed),
      alerts: "basic",
      recordingBytes: await recordingBytes(view.id)
    };
  }

  async function summaries(views, wanted) {
    const endedAgents = new Set(
      wanted.filter((view) => view.kind === "agent" && view.status === "exited").map((view) => view.agentId)
    );
    const installed = new Map();
    await Promise.all(
      [...endedAgents].map(async (agentId) => {
        try {
          installed.set(agentId, (await detect(agentId))?.installed !== false);
        } catch {
          installed.set(agentId, true); // unknown: let Resume try, it checks again
        }
      })
    );
    return Promise.all(wanted.map((view) => toSummary(view, views, installed)));
  }

  async function list({ includeUpdate = false } = {}) {
    const views = await collectViews();
    const wanted = views.filter((view) => includeUpdate || view.kind === "agent").sort(byCreated);
    return summaries(views, wanted);
  }

  async function get(id) {
    assertSessionId(id);
    const views = await collectViews();
    const view = views.find((candidate) => candidate.id === id);
    if (!view) throw unknownSession();
    return (await summaries(views, [view]))[0];
  }

  // ---- starting, resuming, dismissing -----------------------------------------------------------------

  async function startNew({ kind, agentId, folder }) {
    if (!SESSION_AGENTS.includes(agentId)) {
      throw sessionError(400, "unknown_agent", "Agent OS can't start a session for that agent.");
    }
    if (kind === "update" && agentId !== "hermes") {
      throw sessionError(400, "update_not_available", "Only Hermes is updated in a session.");
    }
    if (kind === "agent" && !(await isExecutionAllowed())) {
      throw sessionError(409, "execution_gate_off", LOOK_ONLY_MESSAGE);
    }
    const slot = reserveSlot(kind);
    let id = null;
    try {
      await requirePty();
      const where = await resolveFolder(agentId, kind, folder);
      if (kind === "agent") slot.claim(agentId, where.folder);
      const detected = await detect(agentId);
      const brain = kind === "agent" ? await resolveBrain(agentId) : null;
      const settings = await readSettings();
      id = crypto.randomUUID();
      const dir = sessionDir(id);
      await ensurePrivateDir(sessionsRoot());
      await ensurePrivateDir(dir);
      const profile = await buildProfile({
        agentId,
        folder: where.folder,
        sessionId: id,
        kind,
        resume: null,
        settings,
        detected,
        brain,
        agentOsVersion: RUNTIME_VERSION
      });
      const at = iso(now());
      const folderPath = where.folder ?? profile.cwd;
      const shown = profile.folderShown ?? where.shown;
      const meta = {
        version: META_VERSION,
        id,
        kind,
        agentId,
        agentLabel: SESSION_AGENT_LABEL[agentId],
        folder: folderPath,
        folderName: path.basename(folderPath),
        folderShown: shown,
        branch: shown ? await readGitBranch(folderPath) : null,
        status: "starting",
        createdAt: at,
        startedAt: at,
        endedAt: null,
        exitCode: null,
        signal: null,
        endedBy: null,
        dismissed: false,
        brain: kind === "agent" ? brainSummary(agentId, brain) : null,
        agentSessionId: profile.agentSessionId ?? null,
        resumeMode: kind === "agent" ? profile.resumeMode ?? null : null,
        resumes: 0,
        lastUsedAt: at
      };
      const state = newState(dir, meta);
      // startProcess puts the session into `live` and gives the slot back.
      await startProcess(state, profile, { append: false, releaseSlot: slot.release });
      await saveStarted(state);
      return get(id);
    } catch (error) {
      if (id && !live.has(id)) await fs.rm(sessionDir(id), { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      slot.release();
    }
  }

  function create({ agentId, folder } = {}) {
    return startNew({ kind: "agent", agentId, folder });
  }

  // The update kind (spec "Session kinds"): made only by the update service,
  // never by POST /api/sessions.
  function createUpdateSession({ agentId, folder } = {}) {
    return startNew({ kind: "update", agentId, folder });
  }

  // True while the session's process runs. A session whose process has just
  // ended may still be closing its recording and writing meta.json; it counts
  // as ended, and callers wait for that to finish (finishedExit) instead of
  // refusing.
  function isRunning(id) {
    const state = live.get(id);
    return Boolean(state) && state.status !== "exited";
  }

  async function finishedExit(id) {
    const state = live.get(id);
    if (state && state.status === "exited") await state.exited;
  }

  async function resume(id) {
    assertSessionId(id);
    // A session another request is resuming or dismissing right now is not
    // "still running" (a double click), so it gets its own answer.
    if (busy.has(id)) throw sessionError(409, "session_busy", BUSY_MESSAGE);
    if (isRunning(id)) {
      throw sessionError(409, "session_live", "That session is still running, so there is nothing to resume.");
    }
    busy.add(id);
    try {
      await finishedExit(id);
      const meta = await readMeta(id);
      if (!meta) throw unknownSession();
      if (meta.kind !== "agent") throw sessionError(409, "not_resumable", "An update session can't be resumed.");
      if (meta.status !== "exited") {
        throw sessionError(409, "session_live", "That session is still running, so there is nothing to resume.");
      }
      if (!(await isExecutionAllowed())) throw sessionError(409, "execution_gate_off", LOOK_ONLY_MESSAGE);
      const slot = reserveSlot("agent");
      slot.claim(meta.agentId, meta.folder, id);
      try {
        await requirePty();
        const views = await collectViews();
        const view = views.find((candidate) => candidate.id === id) || viewOfMeta(meta);
        const [summary] = await summaries(views, [view]);
        if (!summary.resume.available) {
          throw sessionError(409, "not_resumable", summary.resume.reason || "This session can't be resumed.");
        }
        const where = await resolveFolder(meta.agentId, "agent", meta.folder);
        const detected = await detect(meta.agentId);
        const brain = await resolveBrain(meta.agentId);
        const settings = await readSettings();
        const dir = sessionDir(id);
        await ensurePrivateDir(dir);
        const profile = await buildProfile({
          agentId: meta.agentId,
          folder: where.folder,
          sessionId: id,
          kind: "agent",
          resume: { agentSessionId: meta.agentSessionId ?? null },
          settings,
          detected,
          brain,
          agentOsVersion: RUNTIME_VERSION
        });
        const at = iso(now());
        const folderPath = where.folder ?? profile.cwd;
        const shown = profile.folderShown ?? where.shown;
        const state = newState(dir, {
          ...meta,
          folder: folderPath,
          folderName: path.basename(folderPath),
          folderShown: shown,
          branch: shown ? await readGitBranch(folderPath) : null,
          status: "starting",
          startedAt: at,
          endedAt: null,
          exitCode: null,
          signal: null,
          endedBy: null,
          dismissed: false,
          brain: brainSummary(meta.agentId, brain),
          agentSessionId: profile.agentSessionId ?? meta.agentSessionId ?? null,
          resumeMode: profile.resumeMode ?? meta.resumeMode ?? null,
          resumes: (Number(meta.resumes) || 0) + 1,
          lastUsedAt: at
        });
        // The recorder writes the "--- resumed ---" marker itself (append: true).
        // startProcess puts the session into `live` and gives the slot back.
        await startProcess(state, profile, { append: true, releaseSlot: slot.release });
        await saveStarted(state);
        return get(id);
      } finally {
        slot.release();
      }
    } finally {
      busy.delete(id);
    }
  }

  // Hides an ended tab (decision Q37). The recording and Resume stay in Runs.
  async function dismiss(id) {
    assertSessionId(id);
    const stillRunning = () =>
      sessionError(409, "session_live", "That session is still running. Stop it first, then dismiss it.");
    if (busy.has(id)) throw sessionError(409, "session_busy", BUSY_MESSAGE);
    if (isRunning(id)) throw stillRunning();
    busy.add(id);
    try {
      await finishedExit(id);
      const meta = await readMeta(id);
      if (!meta) throw unknownSession();
      if (meta.status !== "exited") throw stillRunning();
      if (meta.dismissed !== true) {
        meta.dismissed = true;
        await writeJson(path.join(sessionDir(id), META_FILE), meta);
      }
    } finally {
      busy.delete(id);
    }
    return get(id);
  }

  // ---- windows ------------------------------------------------------------------------------------------

  // The manager sends the snapshot frame itself, then the state, then every
  // output chunk that arrived while the snapshot was taken, so nothing is lost
  // or sent twice.
  async function attach(id, attachment) {
    assertSessionId(id);
    const state = live.get(id);
    if (!state || state.status === "exited") {
      if (state || (await readMeta(id))) {
        throw sessionError(409, "session_ended", "That session has ended. Its recording is in Runs.");
      }
      throw unknownSession();
    }
    if (!attachment || typeof attachment.id !== "string" || !attachment.id || typeof attachment.send !== "function") {
      throw new TypeError("attach() needs { id, send, close }.");
    }
    if (state.attachments.has(attachment.id)) throw new TypeError("That window is already attached.");
    const entry = { id: attachment.id, send: attachment.send, close: attachment.close, sent: 0, acked: 0, pending: [] };
    state.attachments.set(entry.id, entry);
    updateFlow(state);
    let snapshot;
    try {
      snapshot = await state.mirror.snapshot();
    } catch (error) {
      removeAttachment(state, entry.id);
      throw error;
    }
    const detach = () => {
      removeAttachment(state, entry.id);
    };
    if (state.attachments.get(entry.id) !== entry) return { snapshot, detach }; // closed while attaching
    safeSend(entry, { t: "snapshot", data: snapshot.data, cols: snapshot.cols, rows: snapshot.rows, modes: snapshot.modes });
    safeSend(entry, stateFrame(state));
    const pending = entry.pending;
    entry.pending = null;
    for (const item of pending) {
      if (state.attachments.get(entry.id) !== entry) break;
      if (item.frame) safeSend(entry, item.frame);
      else sendOut(state, entry, item.chunk);
    }
    updateFlow(state);
    return { snapshot, detach };
  }

  function attachmentOf(id, attachmentId) {
    const state = live.get(id);
    if (!state || state.status === "exited") return null;
    const attachment = state.attachments.get(attachmentId);
    return attachment ? { state, attachment } : null;
  }

  // {t:"focus"}: this window becomes the writer, the previous writer a viewer.
  function focus(id, attachmentId) {
    const found = attachmentOf(id, attachmentId);
    if (!found) return false;
    found.state.writerId = attachmentId;
    found.state.mirror.setWriterAttached(true);
    return true;
  }

  // {t:"in"}: accepted only from the writer, at most 64 KB per frame. The
  // writer's input is the only other thing ever written into the PTY.
  function write(id, attachmentId, data) {
    const found = attachmentOf(id, attachmentId);
    if (!found || found.state.writerId !== attachmentId) return false;
    if (typeof data !== "string" || data.length === 0) return false;
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) return false;
    found.state.handle.write(data);
    if (isUserInput(data)) markActive(found.state);
    return true;
  }

  // {t:"resize"}: applied only from the writer, cols 2-500 and rows 1-200.
  function resize(id, attachmentId, cols, rows) {
    const found = attachmentOf(id, attachmentId);
    if (!found || found.state.writerId !== attachmentId) return false;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false;
    if (cols < 2 || cols > 500 || rows < 1 || rows > 200) return false;
    const { state } = found;
    state.cols = cols;
    state.rows = rows;
    state.ignoreCountedUntil = now() + RESIZE_QUIET_MS;
    state.handle.resize(cols, rows);
    try {
      // An asciicast "r" event, so a replay draws at the right width.
      state.recorder.resize?.(cols, rows);
    } catch {
      // the recording must never stop the terminal
    }
    try {
      state.mirror.resize(cols, rows);
    } catch {
      // the mirror catches up on its next write
    }
    return true;
  }

  // {t:"ack", seq}: what this window has processed; never past what was sent.
  function ack(id, attachmentId, seq) {
    const found = attachmentOf(id, attachmentId);
    if (!found || !Number.isFinite(seq)) return false;
    const { state, attachment } = found;
    attachment.acked = Math.max(attachment.acked, Math.min(Math.floor(seq), attachment.sent));
    updateFlow(state);
    return true;
  }

  // ---- quit check and recovery ------------------------------------------------------------------------

  async function quitCheck() {
    const running = [...live.values()]
      .filter((state) => state.status !== "exited")
      .map((state) => state.meta)
      .sort(byCreated);
    // The kind lets the quit question leave out "you can resume them later"
    // when an update session is listed (an update is never resumed).
    return { live: running.map((meta) => ({ id: meta.id, title: titleOf(meta), kind: meta.kind })) };
  }

  // Whether this manager runs the session right now (ruling R8). A session
  // stays in `live` until its recording is closed and meta.json is written,
  // so one still closing its recording counts as live and is never listed as
  // ended or deleted. The recordings routes (Task S8) hand this to the recorder.
  function isLive(id) {
    return live.has(id);
  }

  // On server start: a session still recorded as running belongs to a
  // previous run that ended without its exit handler (a hard kill or a
  // crash). It is shown as "ended (Agent OS quit)", with Resume, and its end
  // time is the last time it was known to be alive, not the time of this
  // restart. One session whose meta.json can't be rewritten is reported and
  // skipped; the others are still recovered.
  async function recoverStaleSessions() {
    await ensurePrivateDir(sessionsRoot());
    let recovered = 0;
    for (const id of await listSessionIds()) {
      try {
        if (live.has(id) || busy.has(id)) continue;
        const meta = await readMeta(id);
        if (!meta || meta.status === "exited") continue;
        meta.status = "exited";
        meta.endedAt = meta.endedAt || (await lastKnownTime(id, meta)) || iso(now());
        meta.endedBy = "quit";
        meta.exitCode = null;
        meta.signal = null;
        meta.lastUsedAt = meta.endedAt;
        await writeJson(path.join(sessionDir(id), META_FILE), meta);
        recovered += 1;
      } catch (error) {
        console.error(`Agent OS: could not mark session ${id} as ended after a restart: ${error?.message || error}`);
      }
    }
    return { recovered };
  }

  // ---- Stop and quit ------------------------------------------------------------------------------------

  function waitForExit(state, ms) {
    let timer;
    return Promise.race([
      state.exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  // The summary after a Stop, built from the state in memory when meta.json
  // can't be read back (a full disk, or a session folder removed by hand).
  async function summaryAfterStop(state) {
    try {
      return await get(state.meta.id);
    } catch {
      const view = viewOfState(state);
      return toSummary(view, [view], new Map());
    }
  }

  // The Stop sequence. It never writes into the PTY:
  // 1. the agent's own soft stop (soft-stop.js), at most 2 s for the whole step;
  // 2. the process tree, SIGTERM then SIGKILL after a 3 s grace (process-tree.js
  //    lists the descendants first, so a grandchild that called setsid dies too).
  async function runStopSequence(state) {
    const profile = state.profile || {};
    let soft = { outcome: "none", note: null };
    try {
      soft = await softStop({
        softStop: profile.softStop ?? null,
        command: profile.command,
        env: profile.env,
        cwd: profile.cwd,
        agentSessionId: state.meta.agentSessionId ?? null,
        pid: state.handle?.pid ?? null
      });
    } catch {
      soft = { outcome: "failed", note: null };
    }
    state.stopNote = soft?.note ?? null;
    if (state.status !== "exited" && state.handle?.pid) {
      try {
        await killTree(state.handle.pid, { graceMs: STOP_GRACE_MS });
      } catch {
        // killProcessTree never rejects; nothing else to do here
      }
    }
    await waitForExit(state, EXIT_WAIT_MS);
  }

  // Stop (the Stop dialog, Hold to stop all, and quit). Two Stops of the same
  // session share one sequence while it runs; when it ends, a later Stop runs
  // the sequence again, so a kill that did not take can be tried once more.
  // Answers the session's summary plus `note` (the honest OpenClaw sentence,
  // or null).
  async function stop(id, { by = "stop" } = {}) {
    assertSessionId(id);
    const state = live.get(id);
    // An ended session that is being resumed or dismissed right now (the busy
    // set) is about to change: it answers "busy" instead of an ended summary
    // that would be wrong a moment later. This also holds while the ended
    // session is still in `live` (its recording is closing).
    if ((!state || state.status === "exited") && busy.has(id)) throw sessionError(409, "session_busy", BUSY_MESSAGE);
    if (!state) return { ...(await get(id)), note: null };
    if (state.status !== "exited" && !state.stopping) {
      if (!state.endedBy) state.endedBy = by === "quit" ? "quit" : "stop";
      const sequence = runStopSequence(state).finally(() => {
        if (state.stopping === sequence) state.stopping = null;
      });
      state.stopping = sequence;
    }
    if (state.stopping) await state.stopping;
    else await waitForExit(state, EXIT_WAIT_MS);
    return { ...(await summaryAfterStop(state)), note: state.stopNote ?? null };
  }

  // Quitting Agent OS: "ended (Agent OS quit)" goes into every live session's
  // meta.json BEFORE any kill, so a hard exit in the middle still leaves an
  // honest record with Resume (a session the person is already stopping keeps
  // "stop"). Then every session (both kinds) stops at the same time. The
  // SHUTDOWN_GUARD_MS limit starts with the first meta.json write, so the
  // writes and the stops together never take longer than it. Only meta.json
  // says "exited" early: the state in memory keeps the real status, so list(),
  // resume() and dismiss() still treat the session as running until it ends.
  async function shutdownAll({ reason = "quit" } = {}) {
    const endedBy = reason === "stop" ? "stop" : "quit";
    const running = [...live.values()].filter((state) => state.status !== "exited");
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_GUARD_MS);
    });
    const work = (async () => {
      const endedAt = iso(now());
      await Promise.all(
        running.map((state) => {
          if (!state.endedBy) state.endedBy = endedBy;
          state.meta.status = "exited";
          state.meta.endedAt = endedAt;
          state.meta.endedBy = state.endedBy;
          state.meta.lastUsedAt = endedAt;
          return persist(state).catch(() => {});
        })
      );
      await Promise.allSettled(running.map((state) => stop(state.meta.id, { by: endedBy })));
    })();
    try {
      await Promise.race([work, guard]);
    } finally {
      clearTimeout(timer);
    }
    return { stopped: running.length };
  }

  return {
    create,
    createUpdateSession,
    list,
    get,
    attach,
    focus,
    write,
    resize,
    ack,
    resume,
    dismiss,
    stop,
    shutdownAll,
    quitCheck,
    isLive,
    recoverStaleSessions
  };
}

let defaultManager = null;

export function getSessionManager() {
  if (!defaultManager) {
    const manager = createSessionManager();
    // Quitting Agent OS (SIGTERM or SIGINT, the desktop shell's stdin line, or
    // its Quit) ends every session with the Stop sequence, after writing
    // "ended (Agent OS quit)" into each meta.json. The task looks the method up
    // when it runs.
    registerShutdownTask("sessions", () => manager.shutdownAll({ reason: "quit" }));
    defaultManager = manager;
  }
  return defaultManager;
}
