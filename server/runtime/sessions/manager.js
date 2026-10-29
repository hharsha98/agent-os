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
// - The screen is read only for the Claude Code and Codex limit texts (spec
//   SP4, Task X1b), at most once per LIMIT_SCAN_MS after output.
// - An agent session starts or resumes only when Safety allows running agents
//   (decision Q15). The update and setup kinds are not gated.
// - At most `maxLive` live agent sessions. Update and setup sessions are not
//   counted; at most one update session and one setup session run at a time.
// - Signals (SP4, signals.js) change only what a session shows: its status
//   and its alert. Nothing here answers for the person, and update and setup
//   sessions never alert.
// - A setup session (plan-brains spec §1: OpenClaw's ChatGPT sign-in) lives in
//   memory only: no session folder, no meta.json, no recording. Its input goes
//   to the PTY unscanned, and its mirror is disposed the moment it ends.
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getAdapter } from "../agents/index.js";
import { BUILDER_AGENT_IDS } from "../builders/brains.js";
import { LIMIT_MESSAGE } from "../builders/limits.js";
import { resolveBrainForRun } from "../builders/resolve.js";
import { isExecutionEnabled } from "../execution-gate.js";
import { timingSafeEqualStrings } from "../local-session.js";
import { killProcessTree } from "../process-tree.js";
import { getServerPort } from "../server-info.js";
import { registerShutdownTask } from "../shutdown.js";
import { RUNTIME_VERSION, ensurePrivateDir, readJson, runtimePaths, writeJson as writeJsonFile } from "../store.js";
import { CLAUDE_HOOK_EVENTS, parseStatusLine, transcriptExists as defaultTranscriptExists } from "./claude-session.js";
import { isSessionId, sessionError } from "./errors.js";
import { checkSessionFolder } from "./folders.js";
import { BACKUP_WAITING_QUIET_MS } from "./hooks.js";
import { COUNTED_CHECK_MS, createMirror, isUserInput } from "./mirror.js";
import {
  CODEX_LIMIT_CONFIRM_MS,
  LIMIT_SCAN_MS,
  classifyMirrorAlert,
  classifyTitle,
  codexLimitConfirmed,
  createClaudeLimitRule,
  matchScreenLimit,
  parseResetText
} from "./mirror-signals.js";
import { OPENCLAW_FOLDER_HONOURED, SESSION_AGENTS, SESSION_AGENT_LABEL, SETUP_ACTIONS, buildSessionProfile } from "./profiles.js";
import { ptyAvailable, spawnPty } from "./pty-host.js";
import { CAST_FILE, createRecorder, enforceRecordingCap } from "./recorder.js";
import { readSessionSettings } from "./settings.js";
import {
  HELD_CHECK_MS,
  MARKERS_MAX,
  SIGNAL_SOURCES,
  TURN_DONE_BACKSTOP_MS,
  activityAfter,
  freshActivity,
  makeMarker,
  makeSignal,
  printAlertLine
} from "./signals.js";
import { runSoftStop } from "./soft-stop.js";

// Each shared name has one home: errors.js (the id pattern and the error
// shape) and profiles.js (the agents' short names). Re-exported here so
// routes.js, ws.js and the tests may import them from the manager.
export { SESSION_ID_RE, isSessionId, sessionError } from "./errors.js";
export { SESSION_AGENT_LABEL } from "./profiles.js";

// The basic activity rule (spec "Session activity states"): 20 s without
// counted output makes a live session idle, until the session is turn-done;
// then signals.js's TURN_DONE_BACKSTOP_MS applies instead (K5).
export const IDLE_AFTER_MS = 20 * 1000;
// Flow control (spec "WebSocket protocol", Back-pressure).
export const PAUSE_LAG_BYTES = 512 * 1024;
export const CLOSE_LAG_BYTES = 4 * 1024 * 1024;
// A PTY paused this long closes the windows that still lag (updateFlow()).
export const PAUSED_DROP_MS = 10 * 1000;
// A window's attach waits this long at most for the mirror's snapshot. One
// that never comes must not keep the window's place (and the output queued
// for it) for good, nor keep the PTY from pausing for slow windows.
export const ATTACH_SNAPSHOT_MS = 10 * 1000;
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
const UNKNOWN_KIND_MESSAGE = "Agent OS can't start that kind of session.";
const QUITTING_MESSAGE = "Agent OS is quitting, so no new session can start.";
// The answer to a second sign-in start (plan-brains contract, 409 setup_running).
const SETUP_RUNNING_MESSAGE = "A ChatGPT sign-in is already open in Agent OS.";
// A Claude Code session in which nothing was ever sent saves no conversation (and
// Claude deletes old transcripts itself): `claude --resume <uuid>` then prints "No conversation found with session ID: <uuid>"
// and exits 1 at once. Without this, the tab would offer Resume again, forever
// (spike S7, 2026-10-16). Only the last 4 KB of text is kept to look for it, and
// only the first 16 KB of the resumed run is watched: Claude prints the line right
// at startup, so a real conversation that quotes that text much later (a chat about
// this very message, a file that contains it) must never cost the person Resume.
const NO_CONVERSATION_PREFIX = "No conversation found with session ID: ";
const NO_CONVERSATION_TAIL_CHARS = 4096;
const NO_CONVERSATION_WATCH_CHARS = 16384;
// Also true when Claude itself deleted an old transcript (its cleanupPeriodDays).
const NOTHING_TO_RESUME_MESSAGE =
  "Claude Code has nothing saved for this conversation, so there is nothing to resume. Start a new session in this folder.";
// Colour codes, cursor moves and window-title strings, which can sit between
// the words of a line the agent prints: CSI, OSC (ended by BEL or ESC \),
// charset picks and the two-byte escapes.
const TERMINAL_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-~]|\x1b[@-Z\\-_=>]/g;
// A setup session never records (plan-brains spec §1, Safety 5). This stands in
// for its recorder, so the output, resize and exit paths need no special case
// and nothing is ever written to disk for it.
const NO_RECORDER = Object.freeze({
  output() {},
  marker() {},
  resize() {},
  close: async () => {}
});
// How long a process that started but could not be saved gets to end on its own
// before it is killed (the same grace as Stop).
const FAILED_START_GRACE_MS = 3000;
const SIGNAL_NAMES = signalNameTable();
// The signal kinds applySignal takes. A limit is never one: limit evidence
// goes through the agent's limit rule (Task X1b), which calls setHeld.
const APPLIED_SIGNAL_KINDS = Object.freeze(["waiting", "turn_done", "approval", "resolved"]);
// The events that start a live session's idle time again.
const REARM_EVENTS = new Set(["counted", "input", "new_turn"]);
// A held session's reset timer is set only for a reset time closer than this;
// the wall-clock check covers one further away (setTimeout's own limit is
// about 24.8 days).
const HELD_TIMER_MAX_MS = 24 * 24 * 60 * 60 * 1000;

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

// The SP4 summary fields that only memory knows (R22). An ended session sends
// the defaults: its alert, meter and hand-off ended with its process.
function memoryFields(view) {
  const memory = view.status === "exited" ? null : view.memory ?? null;
  const activity = memory?.activity ?? null;
  const alert = activity?.alert ?? null;
  return {
    alerts: activity?.turnDone === true ? "full" : "basic",
    alert: alert ? { kind: alert.kind, text: alert.text, at: alert.at } : null,
    idleBy: activity?.idleBy ?? null,
    resetAt: activity?.status === "held" ? activity.resetAt ?? null : null,
    trustNeeded: memory?.trustNeeded === true,
    hooksOff: { alerts: memory?.hooksOff?.alerts ?? null, meter: memory?.hooksOff?.meter ?? null },
    meter: memory?.meter ?? null,
    handoff: memory?.handoff ?? null
  };
}

// Markers read back from meta.json: only well-formed ones with a real time,
// the newest MARKERS_MAX.
function storedMarkers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)))
    .map((entry) => makeMarker(entry))
    .filter(Boolean)
    .slice(-MARKERS_MAX);
}

function logListenerError(error) {
  try {
    console.error(`Agent OS: a live-sessions listener failed: ${error?.message || error}`);
  } catch {
    // logging must never be the thing that throws
  }
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

// A new hook token for one Claude Code run (spec Security 4): 32 random bytes,
// 43 base64url characters. Never the main session token, never on disk.
function defaultHookToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// The events the per-session settings file registers. A post naming any other
// event can only be forged (the token sits in the agent's environment), so
// onHook ignores it entirely.
const HOOK_EVENT_NAMES = new Set(CLAUDE_HOOK_EVENTS.map((entry) => entry.event));

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
  softStop = runSoftStop,
  attachSnapshotMs = ATTACH_SNAPSHOT_MS,
  // SP4: prints the AGENT_OS_ALERT line when an alert starts. getSessionManager
  // passes printAlertLine only when the desktop shell started this server.
  onAlertLine = null,
  // SP4 (K3): how often a held session compares the clock with its reset time.
  heldCheckMs = HELD_CHECK_MS,
  // Signals from the mirror (Task X1b): how long Codex's limit text must stay
  // on screen, and how often the screen is read after output. Tests shorten both.
  codexConfirmMs = CODEX_LIMIT_CONFIRM_MS,
  limitScanMs = LIMIT_SCAN_MS,
  // SP4 (Task X2a): the server's real port (0 until listen), this run's hook
  // token, and the re-link rule's transcript check. The tests inject them.
  getPort = getServerPort,
  newHookToken = defaultHookToken,
  transcriptExists = defaultTranscriptExists,
  // Tests only (Task X2b): where Claude's managed settings are read, handed to
  // buildProfile; unset, the profile reads the platform's real path.
  managedSettingsPath = undefined
} = {}) {
  // id -> state, while the session's process runs. Disk is the truth for
  // every ended session.
  const live = new Map();
  // ids being resumed or dismissed right now, so two requests never race: a
  // second request for one of them is answered "session_busy".
  const busy = new Set();
  // Set when a quit begins (shutdownAll): from then on nothing new starts, so a
  // session cannot appear after the stop list was taken.
  let closing = false;
  // Slots held by starts that have not finished yet.
  let reservedAgents = 0;
  let reservedUpdate = false;
  // The setup session being started right now, as { id, action }. Its id is
  // made before anything else, so a second start can be told which session to
  // attach to even while the first is still starting. It is never counted in
  // reservedAgents, so a sign-in never takes one of the `maxLive` places.
  let reservedSetup = null;
  // The same starts, by agent and folder (set once the folder is known), so the
  // fallback-resume rule also sees a New session that is still starting there.
  const openStarts = new Set();
  // onLiveChange listeners: told after an agent session starts or ends.
  const liveListeners = new Set();

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

  // The setup session starting or running now, as { id, action }, or null.
  function runningSetup() {
    if (reservedSetup) return reservedSetup;
    for (const state of live.values()) {
      if (state.meta.kind === "setup" && state.status !== "exited") return { id: state.meta.id, action: state.setupAction };
    }
    return null;
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
      // The run's hook token (spec Security 4): memory only, never in meta.json, a log or a recording.
      hookToken: null,
      // Set only for a resume of a Claude Code conversation (watchForNothingToResume).
      noConversation: null,
      // SP4 activity (signals.js). activity.status always equals `status`:
      // dispatch() changes both, and the two exit paths set both.
      activity: freshActivity(),
      heldTimer: null,
      heldCheck: null,
      lastInputAt: 0,
      lastCountedAt: 0,
      // Memory only, never in meta.json or a recording; later SP4 tasks fill
      // them (trust and hooks off: X2a and X2b; the meter: X2b; the hand-off:
      // X8). The summary sends their defaults until then.
      trustNeeded: false,
      hooksOff: { alerts: null, meter: null },
      meter: null,
      handoff: null,
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
    if (state.status === "held" && state.activity.resetAt) frame.resetAt = state.activity.resetAt;
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

  // ---- activity and alerts (SP4; the transition table is activityAfter in signals.js) ----------------

  function clearIdle(state) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  // A live session becomes idle after this long without counted output, user
  // input or a new turn: IDLE_AFTER_MS for a basic session, and
  // TURN_DONE_BACKSTOP_MS for a turn-done one, whose turn_done can fail to come
  // after an API error or Esc (K5).
  function armIdle(state) {
    clearIdle(state);
    const wait = state.activity.turnDone ? TURN_DONE_BACKSTOP_MS : IDLE_AFTER_MS;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      dispatch(state, { type: "idle_timer" });
    }, wait);
    state.idleTimer.unref?.();
  }

  function clearHeldTimers(state) {
    clearTimeout(state.heldTimer);
    clearInterval(state.heldCheck);
    state.heldTimer = null;
    state.heldCheck = null;
  }

  // A held session with a known reset time (K3): a timer at the reset time,
  // and a wall-clock check every heldCheckMs, because Node's timers stop while
  // a Mac sleeps; the first check after the lid opens sees that the clock has
  // passed the reset time (Review Focus 3). Either one leaves held only once
  // now() has reached the reset time; a timer that fires a little early by the
  // wall clock is caught by the next check.
  function armHeldTimers(state) {
    clearHeldTimers(state);
    const resetMs = Date.parse(state.activity.resetAt ?? "");
    if (!Number.isFinite(resetMs)) return;
    const check = () => {
      if (state.status === "held" && now() >= resetMs) dispatch(state, { type: "held_cleared" });
    };
    const wait = Math.max(0, resetMs - now());
    if (wait < HELD_TIMER_MAX_MS) {
      state.heldTimer = setTimeout(check, wait);
      state.heldTimer.unref?.();
    }
    state.heldCheck = setInterval(check, heldCheckMs);
    state.heldCheck.unref?.();
  }

  // The one place an activity event changes a session. It keeps `status` and
  // `activity.status` equal, sends the state frame (with resetAt while held)
  // and the alert frames, and keeps the idle and held timers in step. An ended
  // session takes no event.
  function dispatch(state, event) {
    if (state.status === "exited") return false;
    const before = state.activity;
    const after = activityAfter(before, event);
    state.activity = after;
    if (after.status !== before.status) setStatus(state, after.status);
    else if (after.status === "held" && after.resetAt !== before.resetAt) broadcast(state, stateFrame(state));
    alertChanged(state, before.alert, after.alert);
    if (after.status !== "live") clearIdle(state);
    else if (before.status !== "live" || before.turnDone !== after.turnDone || REARM_EVENTS.has(event.type)) armIdle(state);
    if (after.status !== "held") clearHeldTimers(state);
    else if (before.status !== "held" || after.resetAt !== before.resetAt) armHeldTimers(state);
    return true;
  }

  // K7, K8: a frame for every change of the alert, queued like every alert
  // frame for windows still waiting for their snapshot. When an alert starts or
  // changes kind, also a "permission asked" marker (waiting and approval) and
  // the AGENT_OS_ALERT line (onAlertLine). New text of the same kind and a
  // cleared alert print nothing.
  function alertChanged(state, before, after) {
    if (!after) {
      if (before) broadcast(state, { t: "alert", kind: "resolved", text: "" }, { queue: true });
      return;
    }
    const sameKind = before?.kind === after.kind;
    if (sameKind && before.text === after.text) return;
    broadcast(state, { t: "alert", kind: after.kind, text: after.text }, { queue: true });
    if (sameKind) return;
    if (after.kind === "waiting" || after.kind === "approval") {
      addMarkerTo(state, { type: "permission", text: after.text }).catch(() => {});
    }
    if (typeof onAlertLine === "function") {
      try {
        onAlertLine({ sessionId: state.meta.id, agent: state.meta.agentLabel, kind: after.kind, text: after.text });
      } catch {
        // a notification must never stop the session
      }
    }
  }

  // Adds a recording marker to the session's meta.json (spec "Recordings in
  // Runs"), keeping the newest MARKERS_MAX (K20). Agent sessions only.
  async function addMarkerTo(state, input) {
    if (state.meta.kind !== "agent" || !input || typeof input !== "object") return false;
    const marker = makeMarker({ ...input, at: input.at ?? iso(now()) });
    if (!marker) return false;
    const kept = Array.isArray(state.meta.markers) ? state.meta.markers : [];
    state.meta.markers = [...kept, marker].slice(-MARKERS_MAX);
    await persist(state);
    return true;
  }

  // Tells every onLiveChange listener that an agent session started or ended
  // (the SP4 pollers start and stop on it). A listener's error is logged and
  // never reaches the session.
  function notifyLiveChange() {
    for (const listener of [...liveListeners]) {
      try {
        const result = listener();
        if (result && typeof result.then === "function") result.then(undefined, logListenerError);
      } catch (error) {
        logListenerError(error);
      }
    }
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

  // Starts watching the output of a RESUME of a Claude Code conversation for the
  // line Claude prints when it saved nothing. Any other session is not watched.
  function watchForNothingToResume(state) {
    const agentSessionId = state.meta.agentSessionId;
    if (state.meta.kind !== "agent" || state.meta.agentId !== "claude" || typeof agentSessionId !== "string" || !agentSessionId) return;
    state.noConversation = { line: `${NO_CONVERSATION_PREFIX}${agentSessionId}`, tail: "", scanned: 0, seen: false };
  }

  // The raw tail is kept (not each chunk cleaned on its own) so an escape code
  // split between two chunks can't hide the line. The search runs on the tail plus
  // the new chunk BEFORE the tail is cut back, so a line followed by a lot of other
  // output in the same chunk is still found. Only that tail is ever kept, and after
  // NO_CONVERSATION_WATCH_CHARS of output the watch is dropped for good; a chunk
  // that crosses that mark is searched only up to it.
  function scanForNoConversation(state, chunk) {
    const watch = state.noConversation;
    const combined = watch.tail + chunk.slice(0, NO_CONVERSATION_WATCH_CHARS - watch.scanned);
    if (combined.replace(TERMINAL_ESCAPES, "").includes(watch.line)) {
      watch.seen = true;
      watch.tail = "";
      return;
    }
    watch.scanned += chunk.length;
    if (watch.scanned >= NO_CONVERSATION_WATCH_CHARS) {
      state.noConversation = null;
      return;
    }
    watch.tail = combined.slice(-NO_CONVERSATION_TAIL_CHARS);
  }

  // ---- signals from the mirror (Task X1b) ---------------------------------------------------------
  //
  // Spec SP4 "Signals" and "Limit rule per agent"; rulings R12-R15, R17, R19.
  // The mirror reports BELs, OSC 9/99/777 notifications and window titles raw;
  // mirror-signals.js says what they mean for each agent; these functions hand
  // the result to the activity state (applySignal, markSourceSeen, setHeld,
  // clearHeld). Update and setup sessions never alert.

  function onMirrorAlert(state, raw) {
    if (state.meta.kind !== "agent") return;
    const signal = classifyMirrorAlert(state.meta.agentId, raw);
    if (!signal) return;
    // Codex's first classified OSC 9 makes it a turn-done session.
    if (signal.sourceSeen) markSourceSeen(state.meta.id);
    applySignal(state.meta.id, { kind: signal.kind, text: signal.text, source: signal.source });
  }

  function onMirrorTitle(state, title) {
    if (state.meta.kind !== "agent") return;
    const signal = classifyTitle(state.meta.agentId, title, { waitingFromTitle: state.titleWaiting === true });
    if (!signal) return;
    if (signal.kind === "waiting") {
      // Hermes sends the same title twice (OSC 1 and OSC 2) and again on each
      // refresh: only the change to "⚠" is a new question, so a person who
      // already typed is not asked again by a repeated title.
      if (state.titleWaiting) return;
      state.titleWaiting = true;
    } else {
      state.titleWaiting = false;
    }
    applySignal(state.meta.id, { kind: signal.kind, text: signal.text, source: signal.source });
  }

  // Claude Code and Codex agent sessions have a limit rule. Cursor, Hermes and
  // OpenClaw have no limit signal, so they are never held (spec).
  function limitWatchFor(meta) {
    if (meta.kind !== "agent" || (meta.agentId !== "claude" && meta.agentId !== "codex")) return null;
    return {
      agentId: meta.agentId,
      rule: meta.agentId === "claude" ? createClaudeLimitRule({ now }) : null,
      holding: false, // this rule put the session in held
      lastCount: 0, // how many limit lines the last screen read found
      scanTimer: null,
      moreOutput: false, // output arrived while the next read was already armed
      confirmTimer: null,
      seenAt: 0, // Codex: when a screen read saw its text appear
      resetAt: null // Codex: the reset time its text gave
    };
  }

  function stopLimitWatch(state) {
    const watch = state.limitWatch;
    if (!watch) return;
    clearTimeout(watch.scanTimer);
    clearTimeout(watch.confirmTimer);
    watch.scanTimer = null;
    watch.confirmTimer = null;
  }

  // At most one screen read per limitScanMs after output (K2). The first output
  // arms a read limitScanMs later, by which time the mirror has read that
  // output. Output that arrives after the read was armed may not have been read
  // by the mirror yet when the read runs (xterm.js reads a write a tick later),
  // so it arms one more read, limitScanMs after that one: the last output of a
  // burst is always followed by a read at least limitScanMs later (M1).
  function scheduleLimitScan(state) {
    const watch = state.limitWatch;
    if (state.exitSeen) return;
    if (watch.scanTimer) {
      watch.moreOutput = true;
      return;
    }
    armLimitScan(state);
  }

  function armLimitScan(state) {
    const watch = state.limitWatch;
    watch.moreOutput = false;
    watch.scanTimer = setTimeout(() => {
      watch.scanTimer = null;
      const outputSinceArmed = watch.moreOutput;
      scanForLimitText(state);
      if (outputSinceArmed && !state.exitSeen) armLimitScan(state);
    }, limitScanMs);
    watch.scanTimer.unref?.();
  }

  // A limit text counts once, when it appears: more limit lines on screen now
  // than at the previous read (K2), so a line that stays on screen is one
  // signal and a second identical line printed under it is a new one (M3).
  function scanForLimitText(state) {
    const watch = state.limitWatch;
    if (!watch || state.exitSeen) return;
    const match = readLimitLine(state, watch.agentId);
    const count = match ? match.count : 0;
    const appeared = count > watch.lastCount;
    watch.lastCount = count;
    if (!appeared) return;
    noteLimit(state.meta.id, { source: "text", text: match.line, resetAt: parseResetText(match.resetText, now()) });
  }

  // A reset time already behind us leaves nothing to wait for: a session is
  // never held on one, so no "plan ran out" flashes up and no notification is
  // raised for a limit that is already over (M4).
  function resetHasPassed(resetAt) {
    return typeof resetAt === "string" && Date.parse(resetAt) <= now();
  }

  function readLimitLine(state, agentId) {
    try {
      return matchScreenLimit(agentId, state.mirror.screenText()); // SCREEN READING (spec SP4)
    } catch {
      return null;
    }
  }

  // Limit evidence for a Claude Code or Codex agent session (spec "Limit rule
  // per agent"): { source: "hook" | "text" | "status", ... }. It holds a
  // session only through that agent's rule, never on one signal. True when
  // the evidence was taken; false for an unknown, ended or non-agent session,
  // an agent with no limit rule, or a source that agent's rule does not use.
  function noteLimit(id, evidence) {
    const state = live.get(id);
    const watch = state?.limitWatch;
    if (!watch || state.exitSeen || !evidence || typeof evidence !== "object") return false;
    if (watch.holding && state.activity.status !== "held") {
      // The hold ended some other way (input, the reset time, Claude's own
      // auto-resume): its evidence is used up, so a status line that still says
      // 100 % cannot hold the session again on its own.
      watch.holding = false;
      watch.rule?.reset();
    }
    return watch.agentId === "claude" ? noteClaudeLimit(state, watch, evidence) : noteCodexLimit(state, watch, evidence);
  }

  // Claude Code: a limit hook or the limit text, confirmed by the other one or
  // by the status line at 100 % (K2); below 100 % the status line ends a hold
  // it confirmed (R4).
  function noteClaudeLimit(state, watch, evidence) {
    if (!["hook", "text", "status"].includes(evidence.source)) return false;
    const result = watch.rule.add(evidence);
    if (result.cleared) {
      watch.holding = false;
      if (state.activity.status === "held") clearHeld(state.meta.id);
      return true;
    }
    // A repeat hold keeps the reset time already known (the reducer's rule), so
    // only a hold that starts, or brings a different reset time, is passed on.
    const alreadyHeld = state.activity.status === "held";
    if (!result.held) return true;
    if (resetHasPassed(result.resetAt)) {
      // Its reset time is already past (M4): never hold, and use up the
      // evidence so it cannot hold the session later.
      if (!alreadyHeld) watch.rule.reset();
      return true;
    }
    if (!alreadyHeld || (result.resetAt !== null && state.activity.resetAt !== result.resetAt)) {
      watch.holding = true;
      setHeld(state.meta.id, { resetAt: result.resetAt, text: LIMIT_MESSAGE.claude, source: evidence.source });
    }
    return true;
  }

  // Codex: no hook and no status line, so its limit text is the only signal,
  // confirmed only by the same text still on screen codexConfirmMs later, the
  // process alive and no counted output since (R15).
  function noteCodexLimit(state, watch, evidence) {
    if (evidence.source !== "text") return false;
    clearTimeout(watch.confirmTimer);
    watch.seenAt = now();
    watch.resetAt = typeof evidence.resetAt === "string" ? evidence.resetAt : null;
    watch.confirmTimer = setTimeout(() => confirmCodexLimit(state), codexConfirmMs);
    watch.confirmTimer.unref?.();
    return true;
  }

  function confirmCodexLimit(state) {
    const watch = state.limitWatch;
    watch.confirmTimer = null;
    const alive = !state.exitSeen;
    const stillOnScreen = alive && readLimitLine(state, "codex") !== null;
    // The text's own output is counted a little after the mirror read it, and
    // the mirror read it before the screen read that saw it. The mirror's
    // counted check runs at most every COUNTED_CHECK_MS, so a tail of the same
    // frame can be counted up to two checks later (M2).
    const countedSince = Number(state.lastCountedAt) > watch.seenAt + 2 * COUNTED_CHECK_MS;
    if (!codexLimitConfirmed({ stillOnScreen, alive, countedSince })) return;
    if (resetHasPassed(watch.resetAt)) return; // M4: its reset time is already past
    watch.holding = true;
    setHeld(state.meta.id, { resetAt: watch.resetAt, text: LIMIT_MESSAGE.codex, source: "text" });
  }

  function onOutput(state, data) {
    const chunk = typeof data === "string" ? data : String(data ?? "");
    if (!chunk) return;
    if (state.noConversation && !state.noConversation.seen) scanForNoConversation(state, chunk);
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
    // The Claude Code and Codex limit texts are looked for on screen (Task X1b).
    if (state.limitWatch) scheduleLimitScan(state);
    if (state.status === "starting") dispatch(state, { type: "output" });
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
    // The hook token dies with the run (spec Security 4).
    state.hookToken = null;
    state.trustNeeded = false;
    clearIdle(state);
    clearHeldTimers(state);
    clearPausedDrop(state);
    stopLimitWatch(state);
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
    // Claude printed "No conversation found ..." for this resume and then failed
    // by itself: no Stop, no quit, no signal. A Stop or a quit is the person's
    // doing, and a zero exit is a normal end, so neither says "nothing saved".
    state.meta.nothingToResume =
      state.noConversation?.seen === true &&
      !state.meta.endedBy &&
      Number.isInteger(state.meta.exitCode) &&
      state.meta.exitCode !== 0;
    state.noConversation = null;
    state.meta.lastUsedAt = endedAt;
    // A session that ends while it waits or is held tells its windows the alert
    // is gone, just before the exited state, so a page that clears an alert on
    // a resolved frame clears this one too.
    const hadAlert = state.activity.alert !== null;
    state.status = "exited";
    state.activity = activityAfter(state.activity, { type: "exit" });
    state.stateSince = endedAt;
    if (state.meta.kind === "agent") notifyLiveChange();
    const frame = stateFrame(state);
    for (const attachment of [...state.attachments.values()]) {
      if (!attachment.pending) {
        if (hadAlert) safeSend(attachment, { t: "alert", kind: "resolved", text: "" });
        safeSend(attachment, frame);
      }
      dropAttachment(state, attachment.id, "session_ended");
    }
    try {
      state.mirror.dispose();
    } catch {
      // already disposed
    }
    if (state.meta.kind === "setup") {
      // A setup session keeps nothing (plan-brains spec §1, Safety 5): no
      // recording to close, no meta.json to write and no recording cap to run.
      // It leaves `live` in the same step as its exit, so GET /api/sessions/:id
      // answers 404 and the WebSocket refuses a new window at once.
      live.delete(state.meta.id);
      state.resolveExited();
      return;
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
    // SP4 (R9): what the person's Claude settings keep out of this session, found with the profile.
    if (profile.claude?.hooksOff) {
      state.hooksOff = { alerts: profile.claude.hooksOff.alerts ?? null, meter: profile.claude.hooksOff.meter ?? null };
    }
    // Signals from the mirror (Task X1b), fresh for every start and resume.
    state.titleWaiting = false;
    state.limitWatch = limitWatchFor(state.meta);
    state.mirror = mirrorFactory({
      cols: state.cols,
      rows: state.rows,
      now,
      // Security 6: the mirror answers standard terminal queries only while no
      // window is the writer (mirror.js decides); its reply goes to the agent.
      onQueryReply: (reply) => {
        if (state.handle && state.status !== "exited") state.handle.write(reply);
      },
      // Spec SP4 "Signals": a BEL or an OSC 9, 99 or 777 from any agent, Codex's
      // OSC 9 read by its text (R14, R19), and Hermes's window title (R17).
      onAlert: (raw) => onMirrorAlert(state, raw),
      onTitle: (title) => onMirrorTitle(state, title)
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
    // From here to the end of this function nothing awaits. A setup session
    // never records (plan-brains spec §1): its recorder factory is never called.
    state.recorder =
      state.meta.kind === "setup" ? NO_RECORDER : recorderFactory({ dir: state.dir, cols: state.cols, rows: state.rows, append, now });
    live.set(state.meta.id, state);
    releaseSlot();
    state.offs.push(state.handle.onData((data) => onOutput(state, data)));
    state.offs.push(
      state.handle.onExit((event) => {
        onProcessExit(state, event);
      })
    );
    // Counted output goes to the activity, which decides whether it wakes the
    // session; the redraw right after a resize is not counted at all.
    state.offs.push(
      state.mirror.onCountedOutput(() => {
        if (now() < state.ignoreCountedUntil) return;
        state.lastCountedAt = now();
        dispatch(state, { type: "counted" });
      })
    );
    if (state.meta.kind === "agent") notifyLiveChange();
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
    const hadAlert = state.activity.alert !== null;
    state.status = "exited";
    state.hookToken = null;
    state.trustNeeded = false;
    state.activity = activityAfter(state.activity, { type: "exit" });
    clearIdle(state);
    clearHeldTimers(state);
    clearPausedDrop(state);
    stopLimitWatch(state);
    if (state.meta.kind === "agent") notifyLiveChange();
    for (const off of state.offs.splice(0)) {
      try {
        off();
      } catch {
        // already unsubscribed
      }
    }
    for (const attachment of [...state.attachments.values()]) {
      // Same as onProcessExit: the alert is gone before the window is dropped.
      if (hadAlert && !attachment.pending) safeSend(attachment, { t: "alert", kind: "resolved", text: "" });
      dropAttachment(state, attachment.id, "session_ended");
    }
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
    return {
      ...state.meta,
      status: state.status,
      stateSince: state.stateSince,
      // What only memory knows (SP4); it is never written to meta.json.
      memory: {
        activity: state.activity,
        trustNeeded: state.trustNeeded,
        hooksOff: state.hooksOff,
        meter: state.meter,
        handoff: state.handoff
      }
    };
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
    // Claude Code saved nothing: a Resume would fail the same way every time.
    if (view.nothingToResume === true) return { available: false, reason: NOTHING_TO_RESUME_MESSAGE, fallback };
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
    const extras = memoryFields(view);
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
      nothingToResume: view.nothingToResume === true,
      alerts: extras.alerts,
      alert: extras.alert,
      idleBy: extras.idleBy,
      resetAt: extras.resetAt,
      trustNeeded: extras.trustNeeded,
      hooksOff: extras.hooksOff,
      meter: extras.meter,
      copyOf: typeof view.copyOf === "string" && view.copyOf ? view.copyOf : null,
      handoff: extras.handoff,
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

  // `liveOnly` lists only the sessions running now, straight from memory: no ended session's meta.json is
  // read and no agent is detected for Resume (summaries() detects only for ended sessions). It is the list
  // the hold to stop all uses, which must not wait on a slow agent CLI or a big sessions folder.
  async function list({ includeUpdate = false, liveOnly = false } = {}) {
    if (liveOnly) {
      const running = [...live.values()].filter((state) => state.status !== "exited").map(viewOfState);
      const wantedNow = running.filter((view) => includeUpdate || view.kind === "agent").sort(byCreated);
      return summaries(running, wantedNow);
    }
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

  function assertNotClosing() {
    if (closing) throw sessionError(409, "agent_os_quitting", QUITTING_MESSAGE);
  }

  async function startNew({ kind, agentId, folder }) {
    assertNotClosing();
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
      const hook = hookFor(kind, agentId);
      const profile = await buildProfile({
        agentId,
        folder: where.folder,
        sessionId: id,
        kind,
        resume: null,
        settings,
        detected,
        brain,
        agentOsVersion: RUNTIME_VERSION,
        hook,
        ...(managedSettingsPath === undefined ? {} : { managedSettingsPath })
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
        nothingToResume: false,
        agentSessionId: profile.agentSessionId ?? null,
        resumeMode: kind === "agent" ? profile.resumeMode ?? null : null,
        resumes: 0,
        lastUsedAt: at
      };
      const state = newState(dir, meta);
      armHook(state, hook);
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

  // Throws 409 setup_running (with the sessionId and setupAction of the one
  // that is in the way) while a setup session is starting or running. The
  // sign-in route asks this before it reads OpenClaw's version, so a second
  // press is refused at once; createSetupSession asks it again at the moment
  // it takes the place.
  function assertNoSetupRunning() {
    const running = runningSetup();
    if (running) {
      throw sessionError(409, "setup_running", SETUP_RUNNING_MESSAGE, { sessionId: running.id, setupAction: running.action });
    }
  }

  // The setup kind (plan-brains spec §1): OpenClaw's ChatGPT sign-in, which
  // needs a real terminal. Made only by POST /api/setup/openclaw/signin-terminal
  // (server/runtime/setup/routes.js), never by POST /api/sessions. `action`
  // names one entry of SETUP_ACTIONS (profiles.js), which holds the only argv.
  // Not gated by Safety, not counted toward maxLive, one at a time. No folder
  // policy (it runs in HOME), no brain, no session folder, no meta.json and no
  // recording: state.dir is null, so nothing can be written for it by mistake.
  // Answers its SessionSummary, built from memory.
  async function createSetupSession({ action, detected } = {}) {
    assertNotClosing();
    const setup = typeof action === "string" && Object.hasOwn(SETUP_ACTIONS, action) ? SETUP_ACTIONS[action] : null;
    if (!setup) throw sessionError(400, "unknown_kind", UNKNOWN_KIND_MESSAGE);
    // The id first, so a second start is always told which session to attach to.
    const id = crypto.randomUUID();
    assertNoSetupRunning();
    reservedSetup = { id, action };
    const releaseSlot = () => {
      if (reservedSetup?.id === id) reservedSetup = null;
    };
    try {
      await requirePty();
      const agentId = setup.agentId;
      const found = detected === undefined ? await detect(agentId) : detected;
      const profile = await buildProfile({
        agentId,
        folder: null,
        sessionId: id,
        kind: "setup",
        setupAction: action,
        settings: { claudeFullscreen: false },
        detected: found
      });
      const at = iso(now());
      const state = newState(null, {
        version: META_VERSION,
        id,
        kind: "setup",
        agentId,
        agentLabel: SESSION_AGENT_LABEL[agentId],
        folder: profile.cwd,
        folderName: path.basename(profile.cwd),
        folderShown: false,
        branch: null,
        status: "starting",
        createdAt: at,
        startedAt: at,
        endedAt: null,
        exitCode: null,
        signal: null,
        endedBy: null,
        dismissed: false,
        brain: null,
        agentSessionId: null,
        resumeMode: null,
        resumes: 0,
        lastUsedAt: at
      });
      state.setupAction = action;
      // startProcess puts the session into `live` and frees the reservation in one step.
      await startProcess(state, profile, { append: false, releaseSlot });
      const view = viewOfState(state);
      return toSummary(view, [view], new Map());
    } finally {
      releaseSlot();
    }
  }

  // The live setup session's SessionSummary, or null (none, or one still
  // before its spawn). GET /api/setup/openclaw/signin-terminal answers it, so a
  // card that was closed or reloaded finds the sign-in again.
  async function liveSetupSession() {
    for (const state of live.values()) {
      if (state.meta.kind === "setup" && state.status !== "exited") {
        const view = viewOfState(state);
        return toSummary(view, [view], new Map());
      }
    }
    return null;
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
    assertNotClosing();
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
        const hook = hookFor("agent", meta.agentId);
        const profile = await buildProfile({
          agentId: meta.agentId,
          folder: where.folder,
          sessionId: id,
          kind: "agent",
          resume: { agentSessionId: meta.agentSessionId ?? null },
          settings,
          detected,
          brain,
          agentOsVersion: RUNTIME_VERSION,
          hook,
          ...(managedSettingsPath === undefined ? {} : { managedSettingsPath })
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
          // A new run starts clean; this one sets it again only if it too finds nothing saved.
          nothingToResume: false,
          agentSessionId: profile.agentSessionId ?? meta.agentSessionId ?? null,
          resumeMode: profile.resumeMode ?? meta.resumeMode ?? null,
          resumes: (Number(meta.resumes) || 0) + 1,
          lastUsedAt: at
        });
        armHook(state, hook);
        watchForNothingToResume(state);
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
    let timer = null;
    try {
      snapshot = await Promise.race([
        state.mirror.snapshot(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(sessionError(504, "attach_failed", "This session's screen did not arrive in time."));
          }, attachSnapshotMs);
          timer.unref?.();
        })
      ]);
    } catch (error) {
      removeAttachment(state, entry.id);
      throw error;
    } finally {
      clearTimeout(timer);
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
    // A setup session's input is a byte pipe (plan-brains spec §1): it may hold a
    // sign-in code, so it is never scanned; its activity comes from output only.
    // User input clears waiting and held (spec "Session activity states").
    if (found.state.meta.kind !== "setup" && isUserInput(data)) {
      found.state.lastInputAt = now();
      dispatch(found.state, { type: "input" });
    }
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

  // ---- signals, alerts and markers: the SP4 entry points ----------------------------------------------
  // The mirror (onMirrorAlert), the hooks endpoint and the pollers call these;
  // no route passes page input to them. Each takes only a running agent
  // session and answers false for any other (SP4 signals scope). A call that
  // can never be right (a limit, an unknown kind or source) is a TypeError.

  // The running agent session with this id, or null.
  function liveAgent(id) {
    if (!isSessionId(id)) return null;
    const state = live.get(id);
    return state && state.status !== "exited" && state.meta.kind === "agent" ? state : null;
  }

  function assertSource(source) {
    if (!SIGNAL_SOURCES.includes(source)) throw new TypeError(`"${String(source)}" is not a signal source.`);
  }

  // A waiting, turn_done, approval or resolved signal.
  function applySignal(id, { kind, text = "", source, resetAt = null } = {}) {
    if (!APPLIED_SIGNAL_KINDS.includes(kind)) {
      throw new TypeError(
        kind === "limit"
          ? "A limit goes through the agent's limit rule, which calls setHeld; it is never applied as a signal."
          : `"${String(kind)}" is not a signal kind applySignal takes.`
      );
    }
    assertSource(source);
    const state = liveAgent(id);
    if (!state) return false;
    const signal = makeSignal({ sessionId: id, kind, text, source, at: iso(now()), resetAt });
    dispatch(state, { type: "signal", kind: signal.kind, text: signal.text, source: signal.source, at: signal.at });
    return true;
  }

  // The session has a turn_done source and its first signal arrived (Claude's
  // first hook event, Codex's first classified OSC 9): turn-done from now on.
  function markSourceSeen(id) {
    const state = liveAgent(id);
    if (!state) return false;
    dispatch(state, { type: "source_seen" });
    return true;
  }

  // A hook that shows a new turn (UserPromptSubmit, PostToolUse(Edit|Write),
  // the poller's busy): idle becomes live; waiting stays waiting.
  function markNewTurn(id) {
    const state = liveAgent(id);
    if (!state) return false;
    dispatch(state, { type: "new_turn" });
    return true;
  }

  // A limit the agent's limit rule confirmed: held, with the reset time when known.
  function setHeld(id, { resetAt = null, text = "", source } = {}) {
    assertSource(source);
    const state = liveAgent(id);
    if (!state) return false;
    const signal = makeSignal({ sessionId: id, kind: "limit", text, source, at: iso(now()), resetAt });
    dispatch(state, { type: "held", resetAt: signal.resetAt, text: signal.text, source: signal.source, at: signal.at });
    return true;
  }

  // The hold ended before its reset time (R4: the status shows the window
  // cleared, or Claude's own auto-resume fired). The reset time passing is
  // armHeldTimers' job.
  function clearHeld(id) {
    const state = liveAgent(id);
    if (!state) return false;
    dispatch(state, { type: "held_cleared" });
    return true;
  }

  async function addMarker(id, marker) {
    const state = liveAgent(id);
    if (!state) return false;
    try {
      return await addMarkerTo(state, marker);
    } catch {
      return false; // meta.json could not be written; the marker goes with the next write
    }
  }

  // A session's markers: from memory while it runs (and while its recording
  // closes), from meta.json after it ended.
  async function markers(id) {
    assertSessionId(id);
    const state = live.get(id);
    if (state) return storedMarkers(state.meta.markers);
    const meta = await readMeta(id);
    if (!meta) throw unknownSession();
    return storedMarkers(meta.markers);
  }

  // Copies of the running agent sessions, in start order (a resume moves a
  // session to the end), for the pollers and the hand-off.
  function liveAgentSessions(agentId = null) {
    const found = [];
    for (const state of live.values()) {
      if (state.status === "exited" || state.meta.kind !== "agent") continue;
      if (agentId !== null && state.meta.agentId !== agentId) continue;
      const profile = state.profile || {};
      // M5: the hook variables (every name starting with HOOK_PREFIX) belong
      // to the Claude session's own environment only (H2). A helper process
      // built from this copy (the `claude agents` poller, git, a hand-off)
      // must never receive them. Dropped by prefix, so that this file never
      // names them (E1's guard on which files do).
      const HOOK_PREFIX = "AGENT_OS_HOOK_";
      const env = Object.fromEntries(Object.entries(profile.env || {}).filter(([key]) => !key.startsWith(HOOK_PREFIX)));
      found.push({
        id: state.meta.id,
        agentId: state.meta.agentId,
        agentSessionId: state.meta.agentSessionId ?? null,
        folder: state.meta.folder,
        status: state.status,
        alert: state.activity.alert ? { ...state.activity.alert } : null,
        pid: state.handle?.pid ?? null,
        lastInputAt: state.lastInputAt, // 0 before any user input (X2b's poller reads 0 as "no input")
        profile: {
          command: profile.command,
          args: Array.isArray(profile.args) ? [...profile.args] : [],
          cwd: profile.cwd,
          env
        }
      });
    }
    return found;
  }

  function onLiveChange(listener) {
    if (typeof listener !== "function") throw new TypeError("onLiveChange() needs a function.");
    liveListeners.add(listener);
    return () => {
      liveListeners.delete(listener);
    };
  }

  // ---- quit check and recovery ------------------------------------------------------------------------

  async function quitCheck() {
    // A setup session is never in the quit question (plan-brains spec §1); quitting still stops it.
    const running = [...live.values()]
      .filter((state) => state.status !== "exited" && state.meta.kind !== "setup")
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
    // Only a quit closes the manager for good; a stop of everything leaves new sessions allowed.
    if (reason !== "stop") closing = true;
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
          // A setup session keeps nothing on disk (plan-brains spec §1): there is
          // no meta.json to write. It is still stopped below, inside the guard.
          if (state.meta.kind === "setup") return Promise.resolve();
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

  // ---- Claude Code's hooks (SP4, Task X2a) -----------------------------------------------------------

  // The hook a new run gets (H2, R7): Claude Code agent sessions only, and
  // only once the server knows its real port (0 before listen and in tests
  // that start no server). Every other start stays exactly as in SP3.
  function hookFor(kind, agentId) {
    if (kind !== "agent" || agentId !== "claude") return null;
    const port = getPort();
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { port, token: newHookToken() };
  }

  // The token lives in this run's memory only (never meta.json). Until the
  // first hook event (or, from Task X2b, the first status post) arrives,
  // Claude may still be waiting for the person to trust the folder: the panel
  // says "Alerts start after you trust this folder in Claude".
  function armHook(state, hook) {
    state.hookToken = hook ? hook.token : null;
    state.trustNeeded = Boolean(hook);
  }

  // "ok"; "unknown_session" for anything that is not a running Claude Code
  // agent run with a hook (liveAgent: running, agent kind); "bad_token" for a
  // missing or wrong token, another session's included. Timing-safe (spec
  // "Hook endpoints").
  function checkHookToken(id, presented) {
    const state = liveAgent(id);
    if (!state || state.meta.agentId !== "claude" || typeof state.hookToken !== "string" || state.hookToken === "") {
      return "unknown_session";
    }
    if (typeof presented !== "string" || presented === "") return "bad_token";
    return timingSafeEqualStrings(presented, state.hookToken) ? "ok" : "bad_token";
  }

  function msSinceInput(state) {
    return Number.isFinite(state.lastInputAt) ? now() - state.lastInputAt : Infinity;
  }

  // R1: Claude's own session id moves to a new UUID after /clear or /resume
  // inside Claude. Agent OS follows it only to a UUID whose transcript file
  // exists in this session's own Claude project folder (one stat, never a
  // read), so a forged event can at worst re-link to another conversation of
  // the same folder. Used for hook events here and, from Task X2b, for the
  // statusLine JSON. Never throws.
  async function relinkClaudeSession(state, uuid) {
    if (typeof uuid !== "string" || uuid === state.meta.agentSessionId) return false;
    let found = false;
    try {
      found = await transcriptExists({ uuid, folder: state.meta.folder, env: state.profile?.env ?? {} });
    } catch {
      found = false;
    }
    // The run may have ended, or another event re-linked it, while the stat ran.
    if (!found || live.get(state.meta.id) !== state || state.status === "exited" || uuid === state.meta.agentSessionId) return false;
    state.meta.agentSessionId = uuid;
    try {
      await persist(state);
    } catch {
      // meta.json is written again when the run ends
    }
    return true;
  }

  // One Claude Code hook event, already mapped by hooks.js (mapHookEvent). It
  // runs only after hooks.js checked this run's token and Claude got its 204
  // (H5), so nothing here can slow Claude down; and everything it does is a
  // hint (spec "Hook events are hints"): a waiting alert, a finished turn, a
  // new turn, a label-only Prompt moment (R23), a limit hint that never holds
  // on its own, the auto-continue that clears held (R4), and the re-link (R1).
  function onHook(id, mapped) {
    const state = liveAgent(id);
    if (!state || state.meta.agentId !== "claude") return;
    if (!mapped || typeof mapped !== "object" || !HOOK_EVENT_NAMES.has(mapped.event)) return;
    markSourceSeen(id);
    state.trustNeeded = false;
    if (mapped.claudeSessionId) relinkClaudeSession(state, mapped.claudeSessionId).catch(() => {});
    for (const signal of Array.isArray(mapped.signals) ? mapped.signals : []) {
      // K6: Claude's backup Notification comes about 6 s after its prompt, so it
      // can land just after the person answered; and not again while it waits.
      if (signal.backup && (state.status === "waiting" || msSinceInput(state) < BACKUP_WAITING_QUIET_MS)) continue;
      applySignal(id, { kind: signal.kind, text: signal.text, source: "hook" });
    }
    if (mapped.limit) noteLimit(id, { source: "hook", text: mapped.limit.text });
    if (mapped.newTurn) markNewTurn(id);
    if (mapped.promptMarker) addMarker(id, { type: "prompt" }).catch(() => {});
    if (mapped.heldCleared) clearHeld(id);
  }

  // POST /hooks/sessions/:id/status (SP4, H6): the statusLine wrapper's copy of Claude's status
  // JSON. It fills the Live meter (R11), is the Claude limit rule's status signal (a level, K2;
  // R4 clears a hold it confirmed), shows the folder is trusted (Claude runs a status line only
  // after its trust dialog, so the trust line ends), and may re-link the conversation (R1). It
  // never marks a hook source as seen: the status line also runs when the person's settings keep
  // Agent OS's hooks out (allowedHttpHookUrls), and a session that waits for a Stop hook that never
  // comes would say "Working." for far too long.
  function onStatusLine(id, json) {
    const state = liveAgent(id);
    if (!state || state.meta.agentId !== "claude") return;
    const status = parseStatusLine(json, now());
    state.meter = status.meter;
    state.trustNeeded = false;
    if (status.claudeSessionId) relinkClaudeSession(state, status.claudeSessionId).catch(() => {});
    noteLimit(id, { source: "status", atLimit: status.atLimit, resetAt: status.resetAt });
  }

  return {
    create,
    createUpdateSession,
    createSetupSession,
    assertNoSetupRunning,
    liveSetupSession,
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
    recoverStaleSessions,
    checkHookToken,
    onHook,
    onStatusLine,
    noteLimit,
    applySignal,
    markSourceSeen,
    markNewTurn,
    setHeld,
    clearHeld,
    addMarker,
    markers,
    liveAgentSessions,
    onLiveChange,
    // The limit this manager was created with (the sessions list reports it).
    get maxLive() {
      return maxLive;
    }
  };
}

let defaultManager = null;

export function getSessionManager() {
  if (!defaultManager) {
    // Only the desktop shell reads AGENT_OS_ALERT lines (spec "Desktop shell
    // changes"), so a server started any other way prints none.
    const manager = createSessionManager({ onAlertLine: process.env.AGENT_OS_PACKAGED === "1" ? printAlertLine : null });
    // Quitting Agent OS (SIGTERM or SIGINT, the desktop shell's stdin line, or
    // its Quit) ends every session with the Stop sequence, after writing
    // "ended (Agent OS quit)" into each meta.json. The task looks the method up
    // when it runs.
    registerShutdownTask("sessions", () => manager.shutdownAll({ reason: "quit" }));
    defaultManager = manager;
  }
  return defaultManager;
}
