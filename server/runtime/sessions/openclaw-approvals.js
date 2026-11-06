// OpenClaw approvals (spec "SP4 Session extras", the OpenClaw row of
// "Signals"; ruling R16; contract K11 and K16). While at least one OpenClaw
// session is open, Agent OS asks OpenClaw's own CLI which approvals wait at
// its Gateway: `openclaw approvals pending --json`, one call at a time, the
// next one APPROVALS_POLL_MS after the last one ended, each cut off after
// APPROVALS_CALL_LIMIT_MS. Every kind OpenClaw lists (exec, plugin,
// system-agent) becomes a card on the Safety page and in the session panel.
// The card never names a folder: OpenClaw's list has none (R16).
//
// - Matching: Agent OS starts OpenClaw as `openclaw tui --session
//   agentos-<id>`, so an approval whose sessionKey holds "agentos-<id>" of an
//   open OpenClaw session belongs to that session. Any other approval cannot
//   be told apart: it belongs to every open OpenClaw session, and its card has
//   sessionId null (the page says "from OpenClaw"; K11).
// - Signals: a session gets one approval signal when approvals it was not
//   told about appear (the text is the newest one's summary), and a resolved
//   signal once nothing is pending for it while its alert is an approval.
//   User input clears the alert as it clears every alert (Session activity
//   states); the card stays until OpenClaw stops listing the approval.
// - Answers: only the person's click reaches resolve() (POST
//   /api/sessions/approvals/resolve), and only Allow once or Deny is ever
//   sent. Nothing here answers by itself (spec Security 6).
//
// Every call is argv only through runCli, with an open OpenClaw session's own
// command, environment and folder, never the server's environment (which
// holds AGENT_OS_TOKEN), and never with a Gateway address or token of Agent
// OS's own: OpenClaw finds its Gateway as it does in Terminal. The output is
// read for the named fields and then dropped.
import { sessionError } from "./errors.js";
import { cleanAlertText, cleanCommandParts } from "./signals.js";
import { runCli as defaultRunCli } from "./soft-stop.js";

export const APPROVALS_POLL_MS = 3000;
export const APPROVALS_CALL_LIMIT_MS = 10000;
export const APPROVAL_DECISIONS = Object.freeze(["allow-once", "deny"]);
// A command is the thing a person answers for, so its card keeps up to this many characters, line breaks included
// (final review, Sa 1; it was 300). A longer one still ends in "…". OpenClaw's own error text stays short.
export const APPROVAL_SUMMARY_MAX = 4000;
const APPROVAL_ERROR_MAX = 300;

// The kinds `approvals pending` lists (OpenClaw 2026.10.4).
const APPROVAL_KINDS = new Set(["exec", "plugin", "system-agent"]);
// An id Agent OS passes back to `approvals resolve`: OpenClaw's own, never
// one that could read as an option or holds a space or a control character.
const APPROVAL_ID = /^[A-Za-z0-9_][A-Za-z0-9._:@+=\/-]{0,199}$/;
// The range of a JavaScript date: toISOString throws outside it.
const MAX_DATE_MS = 8.64e15;
// Colour and title sequences a CLI may print around its error text. An OSC
// counts only with its terminator, so an unended one can't hide the rest.
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

const POLL_FAILED = "Agent OS couldn't read OpenClaw's approvals. Check that the OpenClaw Gateway is running on Agents.";
const INVALID_DECISION = "Agent OS only sends Allow once or Deny.";
const APPROVAL_MISSING = "That approval isn't waiting anymore.";
// The sentence on a card whose command was cut, and the answer to an Allow once for it (409 approval_too_long). The page has the
// same words (alertsShared.ts); a test keeps them equal.
export const APPROVAL_TOO_LONG =
  "This command is too long to show in full, so Agent OS can't allow it. Deny it here, or answer it in OpenClaw's Control UI or Mac app.";
const APPROVAL_BUSY = "Agent OS is already sending your answer to this approval.";
const RESOLVE_NO_REASON = "OpenClaw didn't take that answer and gave no reason.";
const RESOLVE_TIMED_OUT = "OpenClaw didn't answer in time, so Agent OS can't tell whether your answer arrived.";

// The list in `openclaw approvals pending --json`, or null when the output is
// not that JSON. A CLI may print a log line before it, so a parse that fails
// is tried once more from the first line that starts with "{".
function approvalEntries(text) {
  const raw = String(text ?? "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.search(/^\{/m);
    if (start > 0) {
      try {
        parsed = JSON.parse(raw.slice(start));
      } catch {
        parsed = null;
      }
    }
  }
  return parsed && typeof parsed === "object" && Array.isArray(parsed.approvals) ? parsed.approvals : null;
}

function isoFromMs(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? new Date(value).toISOString() : null;
}

function withoutTerminalSequences(value) {
  return String(value ?? "").replace(TERMINAL_SEQUENCE, "");
}

// A card's summary: OpenClaw's own words, and NOTHING of them deleted (re-review R1). The summary is the command as it runs,
// and a removed escape sequence can take real command text with it (`echo a ESC ]0; rm -rf ~/project; BEL` shows only
// `echo a`, and the shell runs all of it), so it does not go through withoutTerminalSequences. cleanCommandText shows each
// control or invisible character as a visible token (`\u{1B}`) and keeps the line breaks as real line breaks (a second
// line must read as a second line, Sa 1). It is cut after that, and a cut summary ends in "…" (3999 characters and the
// sign), so a card never looks complete when it is not: the end of a long command is the part a person must be able to
// see before they click Allow once.
// Returns { text, cut }: `cut` is true when the full cleaned text was longer than the limit (L1 of the last re-review).
function summaryOf(value) {
  return cleanCommandParts(value, APPROVAL_SUMMARY_MAX);
}

// Cards in OpenClaw's own words, newest first. An entry without a usable id,
// a known kind or numeric times, an expired one and a second entry with the
// same id are left out. sessionKey is kept for matching only.
function cardsFrom(entries, now) {
  const ids = new Set();
  const cards = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { id, kind, createdAtMs, expiresAtMs } = entry;
    if (typeof id !== "string" || !APPROVAL_ID.test(id) || ids.has(id) || !APPROVAL_KINDS.has(kind)) continue;
    const createdAt = isoFromMs(createdAtMs);
    const expiresAt = isoFromMs(expiresAtMs);
    if (!createdAt || !expiresAt || expiresAtMs <= now) continue;
    ids.add(id);
    const { text: summary, cut } = summaryOf(typeof entry.summary === "string" ? entry.summary : "");
    cards.push({
      id,
      kind,
      summary,
      createdAt,
      expiresAt,
      // Only on a card that was cut: one that fits has no such field, so it is exactly what it was.
      ...(cut ? { cut: true } : {}),
      sessionId: null,
      sessionKey: typeof entry.sessionKey === "string" ? entry.sessionKey : null
    });
  }
  return cards.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function parsePendingApprovals(text, now = Date.now()) {
  return cardsFrom(approvalEntries(text) ?? [], now);
}

export function matchApprovalSession(sessionKey, openSessions) {
  if (typeof sessionKey !== "string" || !sessionKey) return null;
  const key = sessionKey.toLowerCase();
  for (const session of Array.isArray(openSessions) ? openSessions : []) {
    if (typeof session?.id === "string" && session.id && key.includes(`agentos-${session.id}`)) return session.id;
  }
  return null;
}

// The card as the page gets it (ApprovalCard): matched against the sessions
// open now, without the sessionKey.
function publicCard(card, sessions) {
  return {
    id: card.id,
    kind: card.kind,
    summary: card.summary,
    createdAt: card.createdAt,
    expiresAt: card.expiresAt,
    ...(card.cut ? { cut: true } : {}),
    sessionId: matchApprovalSession(card.sessionKey, sessions)
  };
}

function cliText(value) {
  return cleanAlertText(withoutTerminalSequences(value), APPROVAL_ERROR_MAX);
}

// The words of a refused answer (409 approval_failed): OpenClaw's own error
// text from stderr, else stdout; a call cut off at the limit, or one with no
// words, gets its own sentence.
function resolveFailure(result) {
  if (result?.aborted) return RESOLVE_TIMED_OUT;
  const text = cliText(result?.stderr) || cliText(result?.stdout);
  return text ? `OpenClaw didn't take that answer: ${text}` : RESOLVE_NO_REASON;
}

export function createOpenclawApprovals({
  manager,
  runCli = defaultRunCli,
  intervalMs = APPROVALS_POLL_MS,
  limitMs = APPROVALS_CALL_LIMIT_MS,
  now = Date.now
} = {}) {
  let latest = []; // the last good poll's cards, with their sessionKey
  let error = null; // POLL_FAILED after a poll that failed, until the next good one
  let timer = null;
  let inFlight = null; // the poll running now: { controller, done }
  let pollAgain = false; // a resolve asked for a poll as soon as the running one ends
  let stopped = false;
  // Session id -> the ids of the approvals that session was already told about.
  const told = new Map();
  // Approval ids with a resolve running (K16).
  const resolving = new Set();

  function openSessions() {
    let sessions = [];
    try {
      sessions = manager?.liveAgentSessions?.("openclaw");
    } catch {
      sessions = [];
    }
    return Array.isArray(sessions)
      ? sessions.filter((session) => typeof session?.id === "string" && session.id && session.status !== "exited")
      : [];
  }

  function currentCards(sessions) {
    const at = now();
    return latest.filter((card) => Date.parse(card.expiresAt) > at).map((card) => publicCard(card, sessions));
  }

  function forget() {
    clearTimeout(timer);
    timer = null;
    pollAgain = false;
    latest = [];
    error = null;
    told.clear();
  }

  function schedule(delayMs) {
    if (stopped || timer || inFlight) return;
    if (openSessions().length === 0) {
      forget();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      poll().catch(() => {});
    }, delayMs);
    timer.unref?.();
  }

  function pollSoon() {
    if (stopped) return;
    if (inFlight) {
      pollAgain = true;
      return;
    }
    clearTimeout(timer);
    timer = null;
    schedule(0);
  }

  // One CLI call through the session's own command, environment and folder,
  // cut off after limitMs. Never rejects: null when the runner threw.
  async function callOpenclaw(session, args, controller, extra = {}) {
    const { command, env, cwd } = session.profile ?? {};
    const limit = setTimeout(() => controller.abort(), limitMs);
    // Kept referenced: at most limitMs, and it is what ends a call that never answers (as X8's whenReadyForTyping).
    try {
      return await runCli(command, args, { env, cwd, signal: controller.signal, ...extra });
    } catch {
      return null;
    } finally {
      clearTimeout(limit);
    }
  }

  function apply(id, signal) {
    try {
      return manager.applySignal(id, signal) === true;
    } catch {
      return false;
    }
  }

  // After a good poll: an approval signal for each session that has
  // approvals it was not told about (the newest one's summary), and a
  // resolved signal for a session whose alert is an approval while nothing
  // is pending for it any more.
  function signalSessions(sessions) {
    const cards = currentCards(sessions);
    const open = new Set(sessions.map((session) => session.id));
    for (const id of [...told.keys()]) if (!open.has(id)) told.delete(id);
    for (const session of sessions) {
      const mine = cards.filter((card) => card.sessionId === session.id || card.sessionId === null);
      const pendingIds = new Set(mine.map((card) => card.id));
      const known = new Set([...(told.get(session.id) ?? [])].filter((approvalId) => pendingIds.has(approvalId)));
      const fresh = mine.filter((card) => !known.has(card.id));
      if (fresh.length > 0) {
        if (apply(session.id, { kind: "approval", text: fresh[0].summary, source: "openclaw" })) {
          for (const card of fresh) known.add(card.id);
        }
      } else if (mine.length === 0 && session.alert?.kind === "approval") {
        apply(session.id, { kind: "resolved", text: "", source: "openclaw" });
      } else if (
        mine.length > 0 &&
        session.alert?.kind === "approval" &&
        !mine.some((card) => cleanAlertText(card.summary) === session.alert.text)
      ) {
        // The newest approval left while an older one is still pending: the
        // alert still names the one that is gone. The same kind again changes
        // only its text (an alert frame; no new marker, no notification: K7).
        // The text is compared as the manager keeps it, cleaned to
        // ALERT_TEXT_MAX, so a long summary does not look different each poll.
        apply(session.id, { kind: "approval", text: mine[0].summary, source: "openclaw" });
      }
      if (known.size > 0) told.set(session.id, known);
      else told.delete(session.id);
    }
  }

  async function poll() {
    const sessions = openSessions();
    if (stopped || sessions.length === 0) {
      forget();
      return;
    }
    const controller = new AbortController();
    let finished = () => {};
    inFlight = { controller, done: new Promise((resolve) => (finished = resolve)) };
    const result = await callOpenclaw(sessions[0], ["approvals", "pending", "--json"], controller);
    inFlight = null;
    finished();
    if (stopped) return;
    try {
      const stillOpen = openSessions();
      if (stillOpen.length === 0) {
        forget();
        return;
      }
      const entries = result?.ok ? approvalEntries(result.stdout) : null;
      if (entries) {
        latest = cardsFrom(entries, now());
        error = null;
        signalSessions(stillOpen);
      } else {
        error = POLL_FAILED;
      }
    } catch {
      error = POLL_FAILED;
    }
    const soon = pollAgain;
    pollAgain = false;
    schedule(soon ? 0 : intervalMs);
  }

  function snapshot() {
    const sessions = openSessions();
    if (sessions.length === 0) return { approvals: [], error: null };
    return { approvals: currentCards(sessions), error };
  }

  async function resolve(id, decision) {
    if (!APPROVAL_DECISIONS.includes(decision)) throw sessionError(400, "invalid_decision", INVALID_DECISION);
    const sessions = openSessions();
    const card = typeof id === "string" ? currentCards(sessions).find((entry) => entry.id === id) : undefined;
    if (!card || sessions.length === 0) throw sessionError(404, "approval_missing", APPROVAL_MISSING);
    // A command cut at the limit is never allowed from Agent OS: the part that made it risky can be the part that is not shown
    // (L1). The card is at hand here, so this is checked before anything reaches OpenClaw. Deny stays.
    if (decision === "allow-once" && card.cut) throw sessionError(409, "approval_too_long", APPROVAL_TOO_LONG);
    if (resolving.has(id)) throw sessionError(409, "approval_busy", APPROVAL_BUSY);
    resolving.add(id);
    const session = sessions.find((entry) => entry.id === card.sessionId) ?? sessions[0];
    let result = null;
    try {
      result = await callOpenclaw(session, ["approvals", "resolve", id, decision], new AbortController(), { captureStderr: true });
    } finally {
      resolving.delete(id);
      pollSoon();
    }
    if (result?.ok) {
      // Off the list at once: until the re-poll answers, a second click (a
      // double click, another window) would send the same answer again.
      latest = latest.filter((card) => card.id !== id);
      return { message: null };
    }
    throw sessionError(409, "approval_failed", resolveFailure(result));
  }

  function stop() {
    stopped = true;
    unsubscribe?.();
    const running = inFlight;
    running?.controller.abort();
    forget();
    return running ? running.done : Promise.resolve();
  }

  // Polling starts when the first OpenClaw session opens and ends with the
  // last one (schedule() keeps a timer or a running poll as it is).
  function sync() {
    if (!stopped) schedule(0);
  }

  const unsubscribe = typeof manager?.onLiveChange === "function" ? manager.onLiveChange(sync) : null;
  sync();
  return Object.freeze({ snapshot, resolve, stop });
}
