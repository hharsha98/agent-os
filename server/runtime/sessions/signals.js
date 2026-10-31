// Signals (SP4): one shape for everything that tells Agent OS what an agent
// in a session is doing, the activity-state machine that turns signals and
// terminal activity into a session's status and alert, and the one shape of
// the AGENT_OS_ALERT line and of a recording marker.
//
// Spec "SP4 Session extras" (Signals, Alerts UI, Recordings in Runs) and
// "Session activity states" (the transition table), with the orchestrator's
// rulings R19 (basic alerts), R21 (the alert line), R22 (alert state) and R23
// (a prompt marker holds no text), and the plan's choices K1, K4, K5, K7, K8
// and K20. Everything here is pure: no timers, no disk, no process; the only
// effects are a default time and the default stdout writer of printAlertLine.
// The session manager (manager.js) owns the timers, the frames and meta.json.
//
// Signals are hints (spec "Hook events are hints"): they change only what a
// session shows, its status and its alert. Nothing here answers, types or
// starts anything.

export const SIGNAL_KINDS = Object.freeze(["waiting", "turn_done", "limit", "approval", "resolved"]);
export const ALERT_KINDS = Object.freeze(["waiting", "approval", "limit"]);
export const SIGNAL_SOURCES = Object.freeze(["hook", "status", "poll", "osc", "bel", "title", "text", "openclaw"]);
// The longest alert text kept anywhere, the AGENT_OS_ALERT line included (R21).
export const ALERT_TEXT_MAX = 200;
// What a basic alert says (R19): a BEL or an OSC 9 / 99 / 777 tells Agent OS
// only that the agent wants attention, not why.
export const BASIC_ALERT_TEXT = "May need you";
// K5: a turn-done session whose turn_done never comes (an API error, Esc) is
// idle this long after its last counted output, input or new turn.
export const TURN_DONE_BACKSTOP_MS = 120 * 1000;
// K3: how often a held session compares the wall clock with its reset time.
export const HELD_CHECK_MS = 60 * 1000;
// B-M2: one session raises at most one AGENT_OS_ALERT line (a desktop notification) in this time; a token holder
// that forges one question after another gets one notification, while the in-app alert still follows each.
export const ALERT_LINE_GAP_MS = 10 * 1000;
// K20: the most markers one session keeps in meta.json (the oldest go first).
export const MARKERS_MAX = 500;
// The desktop shell looks for stdout lines that start with this (spec
// "Desktop shell changes").
export const ALERT_LINE_PREFIX = "AGENT_OS_ALERT:";

const ACTIVITY_STATUSES = Object.freeze(["starting", "live", "waiting", "idle", "held", "exited"]);
const EVENT_TYPES = new Set([
  "output",
  "counted",
  "input",
  "idle_timer",
  "signal",
  "source_seen",
  "new_turn",
  "held",
  "held_cleared",
  "exit"
]);
// The signal kinds the activity takes as a "signal" event. A limit is not one:
// limit evidence goes through the agent's limit rule, which sends "held".
const ACTIVITY_SIGNAL_KINDS = Object.freeze(["waiting", "approval", "turn_done", "resolved"]);
const MARKER_TYPES = new Set(["prompt", "permission", "files"]);
// Every C0 control character, DEL and every C1 control character.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
// Invisible characters that reorder the text around them: the bidi embeddings,
// overrides and isolates (U+202A-202E, U+2066-2069), the left-to-right and
// right-to-left marks (U+200E, U+200F) and the Arabic letter mark (U+061C). A
// command or a question could be made to read in another order than it runs
// ("Trojan Source"), so none of them stays in an alert text.
const BIDI_FORMAT_CHARACTERS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
// The longest file path a "files changed" marker keeps.
const MARKER_PATH_MAX = 4096;

function isoOrNull(value) {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function countOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// A bell or an OSC 9 / 99 / 777 from the mirror that says only "May need you": a basic alert (R19). The source
// alone is not enough: Codex's OSC 9 is classified by its text ("Approval requested: rm -rf build"), carries
// Codex's own words and has the source "osc" too, but it is a specific alert and no later bell may replace it.
function isBasicAlert({ source, text } = {}) {
  return (source === "bel" || source === "osc") && text === BASIC_ALERT_TEXT;
}

// Short, plain, one-line text: tabs and newlines become spaces, every other
// control character goes, so do the invisible reordering characters
// (BIDI_FORMAT_CHARACTERS), runs of spaces collapse, and the text is cut to
// `max` code points (a character is never split). A text that had to be cut ends in "…" and is
// `max` code points: the first `max - 1` plus the "…", like the OpenClaw approval card.
export function cleanAlertText(value, max = ALERT_TEXT_MAX) {
  const text = String(value ?? "")
    .replace(/[\t\n]/g, " ")
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_FORMAT_CHARACTERS, "")
    .replace(/ {2,}/g, " ")
    .trim();
  const limit = Number.isInteger(max) && max >= 0 ? max : ALERT_TEXT_MAX;
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return limit === 0 ? "" : `${points.slice(0, limit - 1).join("")}…`;
}

// The one signal shape (spec: {sessionId, kind, text, at}, plus K1's source
// and, for a limit, resetAt). A wrong kind, source, id or time is a caller's
// bug, never data, so it throws.
export function makeSignal({ sessionId, kind, text = "", source, at = new Date().toISOString(), resetAt = null } = {}) {
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("A signal needs the session's id.");
  if (!SIGNAL_KINDS.includes(kind)) throw new TypeError(`"${String(kind)}" is not a signal kind.`);
  if (!SIGNAL_SOURCES.includes(source)) throw new TypeError(`"${String(source)}" is not a signal source.`);
  const when = isoOrNull(at);
  if (!when) throw new TypeError("A signal's time must be an ISO 8601 date.");
  return Object.freeze({
    sessionId,
    kind,
    text: cleanAlertText(text),
    at: when,
    source,
    resetAt: kind === "limit" ? isoOrNull(resetAt) : null
  });
}

// What the mirror's raw alert means before the per-agent rules (Task X1b):
// a BEL or an OSC 9 / 99 / 777 is a basic "May need you" (R19). An OSC 9;4
// is a progress report (ConEmu's taskbar progress), never an alert.
export function genericMirrorSignal(raw) {
  if (raw === "bel") return { kind: "waiting", text: BASIC_ALERT_TEXT, source: "bel" };
  if (typeof raw !== "string") return null;
  if (/^9;4(;|$)/.test(raw)) return null;
  if (/^(9|99|777);/.test(raw)) return { kind: "waiting", text: BASIC_ALERT_TEXT, source: "osc" };
  return null;
}

export function freshActivity(status = "starting") {
  if (!ACTIVITY_STATUSES.includes(status)) throw new TypeError(`"${String(status)}" is not an activity state.`);
  return { status, turnDone: false, idleBy: null, resetAt: null, alert: null };
}

// The alert a waiting, approval or held event sets. The same alert again (same
// kind and text) keeps the time it began, so "waiting since" stays true.
function alertFrom(kind, event, previous) {
  const text = cleanAlertText(event.text);
  if (previous && previous.kind === kind && previous.text === text) return { ...previous };
  return { kind, text, at: isoOrNull(event.at) ?? new Date().toISOString(), source: event.source };
}

function signalInto(next, from, event) {
  const status = from.status;
  if (event.kind === "turn_done") {
    // Turn-done from now on only after a hook event or an OSC 9 notification (spec, "Session activity states").
    // The Claude poller's idle (source "poll") also ends the turn, but it is no first signal: a session whose
    // hooks are off must stay basic, or its panel would claim full alerts above "Alerts are off".
    if (event.source === "hook" || event.source === "osc") next.turnDone = true;
    // K4: a turn_done while waiting means the agent finished, so it no longer waits.
    if (status === "starting" || status === "live" || status === "waiting" || status === "idle") {
      next.status = "idle";
      next.idleBy = "turn_done";
      next.alert = null;
    }
    return;
  }
  if (event.kind === "resolved") {
    if (status === "waiting") {
      next.status = "live";
      next.alert = null;
    }
    return;
  }
  // waiting or approval
  if (status === "starting" || status === "live" || status === "idle" || status === "waiting") {
    // A basic alert from the mirror (a bell, an OSC 9 / 99 / 777) tells only
    // that the agent wants attention, so it never overwrites a specific one
    // (an approval's command, a hook's question): one question, one alert, one
    // notification (K7). The activity stays as it is, so no frame, no second
    // AGENT_OS_ALERT line and no second permission marker follow.
    if (status === "waiting" && from.alert && isBasicAlert(event) && !isBasicAlert(from.alert)) return;
    next.status = "waiting";
    next.alert = alertFrom(event.kind, event, from.alert);
  }
}

// What only one state may carry: idleBy belongs to idle, resetAt to held, and
// an alert to waiting (a question) or held (the limit).
function settle(next) {
  if (next.status !== "idle") next.idleBy = null;
  if (next.status !== "held") next.resetAt = null;
  if (next.status !== "waiting" && next.status !== "held") next.alert = null;
  return next;
}

// The spec's transition table ("Session activity states"), with K4 (a
// turn_done while waiting is idle) and K5 (the manager's backstop timer sends
// idle_timer for a turn-done session too). Returns a new Activity and never
// changes the one it is given.
//   output        the first output of any kind (starting -> live)
//   counted       counted output: wakes starting, and idle only for a basic session
//   input         user input (never a hand-off write): live, alert cleared
//   idle_timer    20 s (basic) or the backstop (turn-done) without activity
//   signal        waiting | approval | turn_done | resolved
//   source_seen   the first signal of a turn_done source: turn-done from now on
//   new_turn      a hook that shows a new turn: idle -> live (never clears waiting)
//   held          a limit the agent's limit rule confirmed
//   held_cleared  the reset time passed, or the status shows the window cleared (R4)
//   exit          the process ended
export function activityAfter(activity, event) {
  const type = event?.type;
  if (!EVENT_TYPES.has(type)) throw new TypeError(`"${String(type)}" is not an activity event.`);
  if (type === "signal" && !ACTIVITY_SIGNAL_KINDS.includes(event.kind)) {
    throw new TypeError(
      event.kind === "limit"
        ? "A limit goes through the agent's limit rule, which sends a held event; it is never a signal event."
        : `"${String(event.kind)}" is not a signal kind the activity takes.`
    );
  }
  if ((type === "signal" || type === "held") && !SIGNAL_SOURCES.includes(event.source)) {
    throw new TypeError(`"${String(event.source)}" is not a signal source.`);
  }
  const from = activity ?? freshActivity();
  const next = {
    status: from.status,
    turnDone: from.turnDone === true,
    idleBy: from.idleBy ?? null,
    resetAt: from.resetAt ?? null,
    alert: from.alert ? { ...from.alert } : null
  };
  if (from.status === "exited") return next;
  const was = (...statuses) => statuses.includes(from.status);
  switch (type) {
    case "output":
      if (was("starting")) next.status = "live";
      break;
    case "counted":
      // Output alone never takes a turn-done session out of idle (spec).
      if (was("starting") || (was("idle") && !from.turnDone)) next.status = "live";
      break;
    case "input":
      next.status = "live";
      next.alert = null;
      break;
    case "idle_timer":
      if (was("live")) {
        next.status = "idle";
        next.idleBy = "timer";
      }
      break;
    case "signal":
      signalInto(next, from, event);
      break;
    case "source_seen":
      next.turnDone = true;
      break;
    case "new_turn":
      if (was("starting", "idle")) next.status = "live";
      break;
    case "held":
      next.status = "held";
      // A repeat hold that carries no reset time keeps the one already known
      // (a status post at 100 % without resets_at must not erase "Resets <time>"
      // or its timers).
      next.resetAt = isoOrNull(event.resetAt) ?? (from.status === "held" ? from.resetAt ?? null : null);
      next.alert = alertFrom("limit", event, from.alert);
      break;
    case "held_cleared":
      if (was("held")) next.status = "idle";
      break;
    case "exit":
      next.status = "exited";
      break;
  }
  return settle(next);
}

// The line the desktop shell reads (spec "Desktop shell changes", R21): the
// prefix and one JSON object with exactly these keys in this order. JSON keeps
// it on one line; the text is cleaned and cut to ALERT_TEXT_MAX code points.
export function alertLine({ sessionId, agent, kind, text } = {}) {
  return `${ALERT_LINE_PREFIX}${JSON.stringify({
    sessionId: String(sessionId ?? ""),
    agent: String(agent ?? ""),
    kind: String(kind ?? ""),
    text: cleanAlertText(text)
  })}`;
}

// The default writer. A stream never throws for an I/O error: a closed pipe
// (the desktop shell crashed or quit first) shows up later as an 'error' event
// on process.stdout, and an event nobody listens to ends the process. So the
// first line adds a listener that ignores it.
let stdoutGuarded = false;
function writeStdout(line) {
  if (!stdoutGuarded) {
    stdoutGuarded = true;
    process.stdout.on("error", () => {}); // a gone shell must never crash the server
  }
  process.stdout.write(line);
}

// Prints the line for an alert the person should see (K7: waiting, approval,
// limit). Anything else prints nothing. A closed stdout never throws here, and
// never crashes the server either (writeStdout).
export function printAlertLine(payload, write = writeStdout) {
  try {
    if (!payload || !ALERT_KINDS.includes(payload.kind)) return;
    write(`${alertLine(payload)}\n`);
  } catch {
    // stdout is gone (the shell quit first): an alert line is never worth a crash
  }
}

// A recording marker for meta.json (spec "Recordings in Runs"), or null for an
// unknown type. A prompt marker is label only: a prompt's text is never kept
// (R23, spec Security 5).
export function makeMarker(input) {
  if (!input || typeof input !== "object" || !MARKER_TYPES.has(input.type)) return null;
  const at = isoOrNull(input.at) ?? new Date().toISOString();
  if (input.type === "prompt") return { at, type: "prompt" };
  if (input.type === "permission") return { at, type: "permission", text: cleanAlertText(input.text) };
  const files = [];
  for (const file of Array.isArray(input.files) ? input.files : []) {
    if (!file || typeof file.path !== "string") continue;
    const filePath = file.path.replace(CONTROL_CHARACTERS, "").slice(0, MARKER_PATH_MAX);
    if (filePath) files.push({ path: filePath, added: countOrNull(file.added), removed: countOrNull(file.removed) });
  }
  return { at, type: "files", files, more: countOrNull(input.more) ?? 0 };
}
