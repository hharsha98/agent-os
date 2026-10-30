// Signals from the mirror (spec SP4 "Signals" and "Limit rule per agent";
// rulings R12-R15, R17 and R19; contract K2).
//
// mirror.js reports what a session's terminal sends, raw: "bel", or
// "<osc id>;<payload>" for OSC 9, 99 and 777, and window titles. This module
// says what each one means for each agent, finds the Claude Code and Codex
// limit texts on screen, and holds the two limit rules. Pure functions and one
// small rule object: no timers, no terminal and no process. The session
// manager (manager.js) wires them up and owns every timer.
//
// The limit texts are the only screen reading in Agent OS (spec SP4); the one
// line here that tests screen text is labelled.
import { BASIC_ALERT_TEXT, cleanAlertText, genericMirrorSignal } from "./signals.js";

// Codex's OSC 9 carries display text, not its type name (codex-rs
// tui/src/chatwidget/notifications.rs, 0.154.0): a text with one of these
// starts asks the person something; any other text ends a turn (the answer's
// first words, or "Agent turn complete").
export const CODEX_WAITING_PREFIXES = Object.freeze([
  "Approval requested: ",
  "Approval requested by ",
  "Codex wants to edit ",
  "Plan mode prompt: "
]);

// R13, as replaced by ruling R13a. Claude Code 2.1.292 says "You've hit your
// limit · resets <time>" (the generic line, which the owner's five-hour limit
// printed: see test/builder-brains.test.js), "You've hit your
// session|weekly|Opus|Sonnet limit · resets <time>" (2.1.312: "5-hour limit"),
// "You're out of usage credits · resets <time>", and its auto-wait line is
// "Usage limit reached · limit resets <time>". The warning "You've used 85% of
// your session limit" is not a limit.
export const CLAUDE_SCREEN_LIMIT = /You[’']ve hit your (?:.+ )?limit|You[’']re out of usage credits|Usage limit reached/;
// R15: Codex 0.154.0's limit texts (codex-rs/protocol/src/error.rs, and the TUI's own two).
export const CODEX_SCREEN_LIMIT =
  /You[’']ve hit your usage limit|You hit your spend cap|Your workspace is out of credits|You[’']re out of credits|Usage limit reached/;
// The texts above on a line of their own are not yet a limit: Codex prints its errors as a row that starts with
// "■", while a search result, a diff or a file view that only quotes the sentence (rg, git diff, a log) puts
// something else in front of it. Only the "■" row counts as Codex's own limit message (E1 A-I2). R15's "not every
// message starts the same way" is kept by allowing words between the mark and the sentence. CODEX_SCREEN_LIMIT
// stays the plain text, for a screen read that only has to leave such sentences out (keep-going.js).
export const CODEX_ERROR_LIMIT =
  /^\s*■\s.*?(?:You[’']ve hit your usage limit|You hit your spend cap|Your workspace is out of credits|You[’']re out of credits|Usage limit reached)/;

export const LIMIT_CONFIRM_WINDOW_MS = 120000; // K2: a first signal counts this long
export const CODEX_LIMIT_CONFIRM_MS = 5000; // R15: the text must still be on screen this much later
export const LIMIT_SCAN_MS = 1000; // K2: the screen is read at most this often after output

// Codex wraps its long limit sentence itself, so the reset time can sit on
// the next lines.
const RESET_LOOKAHEAD_LINES = 2;
// <time> as the agents print it: "3:45pm", "3:45 PM", "11pm", "Mon 12:00am",
// "Oct 30th, 2026 3:45 PM".
const RESET_TIME = String.raw`((?:[A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?, \d{4} )?(?:[A-Za-z]{3,9} )?\d{1,2}(?::\d{2})? ?[AaPp][Mm])\b`;
// "resets <time>" and "limit resets <time>" (Claude Code); " Try again at
// <time>." and " or try again at <time>." (Codex).
const RESET_PATTERNS = Object.freeze([
  new RegExp(String.raw`\bresets (?:at )?${RESET_TIME}`),
  new RegExp(String.raw`\b[Tt]ry again at ${RESET_TIME}`)
]);
const RESET_FORM =
  /^(?:([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) |([A-Za-z]{3})[A-Za-z]* )?(\d{1,2})(?::(\d{2}))? ?([AaPp])[Mm]$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Hermes's Ink TUI starts its window title with this while it asks (R17).
const TITLE_WAITING_MARK = "⚠";

function isoOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

// What a raw mirror alert means for this agent, or null:
//   { kind: "waiting" | "turn_done", text, source: "bel" | "osc", sourceSeen }
// sourceSeen is true only for Codex's OSC 9, which makes its session a
// turn-done session (spec "Session activity states").
export function classifyMirrorAlert(agentId, raw) {
  if (typeof raw !== "string") return null;
  // BEL and OSC 9/99/777 are basic alerts; OSC 9;4 progress and anything else are nothing.
  const basic = genericMirrorSignal(raw);
  if (!basic) return null;
  if (agentId === "codex" && raw.startsWith("9;")) {
    const payload = raw.slice(2);
    const waiting = CODEX_WAITING_PREFIXES.some((prefix) => payload.startsWith(prefix));
    return { kind: waiting ? "waiting" : "turn_done", text: cleanAlertText(payload), source: "osc", sourceSeen: true };
  }
  // Every other notification: the agent may need the person, and Agent OS
  // can't tell more (R12, R19).
  return { kind: basic.kind, text: basic.text, source: basic.source, sourceSeen: false };
}

// Hermes's title: "⚠" at its start means it asks; the marker gone resolves a
// wait the title started. Other agents' titles mean nothing.
export function classifyTitle(agentId, title, { waitingFromTitle = false } = {}) {
  if (agentId !== "hermes" || typeof title !== "string") return null;
  if (title.trimStart().startsWith(TITLE_WAITING_MARK)) return { kind: "waiting", text: BASIC_ALERT_TEXT, source: "title" };
  if (waitingFromTitle === true) return { kind: "resolved", text: "", source: "title" };
  return null;
}

// The newest (lowest) limit line on a Claude Code or Codex screen, cleaned,
// with the text of its reset time when that line or the two below it give one,
// and how many lines of the screen are limit lines (count): a second identical
// line printed under the first is a new limit text, though the first one is
// still on screen (fix round 1, M3).
export function matchScreenLimit(agentId, screenText) {
  const pattern = agentId === "claude" ? CLAUDE_SCREEN_LIMIT : agentId === "codex" ? CODEX_ERROR_LIMIT : null;
  if (!pattern || typeof screenText !== "string" || !screenText) return null;
  const lines = screenText.split("\n");
  let newest = null;
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!pattern.test(lines[index])) continue; // SCREEN READING (spec SP4)
    count += 1;
    if (newest) continue;
    const around = lines.slice(index, index + 1 + RESET_LOOKAHEAD_LINES).join(" ").replace(/\s+/g, " ");
    newest = { line: cleanAlertText(lines[index]), resetText: resetTextFrom(around) };
  }
  return newest ? { ...newest, count } : null;
}

function resetTextFrom(text) {
  for (const pattern of RESET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

// A reset time as the agents print it, read in this computer's time zone
// (where the agent printed it), as an ISO string; null when it can't be read.
export function parseResetText(resetText, now = Date.now()) {
  if (typeof resetText !== "string") return null;
  const match = RESET_FORM.exec(resetText.trim().replace(/\s+/g, " "));
  if (!match) return null;
  const [, monthName, dayText, yearText, weekdayName, hourText, minuteText = "0", half] = match;
  const hour12 = Number(hourText);
  const minute = Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (half.toLowerCase() === "p" ? 12 : 0);
  const base = new Date(now);
  if (Number.isNaN(base.getTime())) return null;
  let date;
  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return null;
    date = new Date(Number(yearText), month, Number(dayText), hour, minute, 0, 0);
    if (date.getMonth() !== month) return null; // Feb 30th and the like
  } else if (weekdayName) {
    const weekday = WEEKDAYS.indexOf(weekdayName.toLowerCase());
    if (weekday < 0) return null;
    date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
    let ahead = (weekday - date.getDay() + 7) % 7;
    if (ahead === 0 && date.getTime() <= base.getTime()) ahead = 7;
    date.setDate(date.getDate() + ahead);
  } else {
    // A clock time already past today means tomorrow.
    date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
    if (date.getTime() <= base.getTime()) date.setDate(date.getDate() + 1);
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Claude Code's limit rule (spec "Limit rule per agent", K2): a limit signal
// (the StopFailure hook with rate_limit or billing_error, or the limit text
// appearing on screen) is confirmed by a second, different signal: the other
// first signal within LIMIT_CONFIRM_WINDOW_MS, or the status line at 100 %.
// The status line is a level (what it last said), not a moment. Below 100 %
// it ends a hold it confirmed (R4); it never ends a hold the hook and the text
// confirmed alone, because an Opus or Sonnet limit leaves the plan windows
// under 100 %.
//   add(evidence) → { held, resetAt, cleared }
//     held     the rule holds after this evidence
//     resetAt  while held: the status line's reset time, else the text's, else null
//     cleared  this status report ended the hold
//   reset()    a hold that ended elsewhere used up its first signals; the
//              status level stays
export function createClaudeLimitRule({ now = Date.now } = {}) {
  let hookAt = null;
  let textAt = null;
  let textResetAt = null;
  let statusAtLimit = false;
  let statusResetAt = null;
  let holding = false;
  let holdUsedStatus = false;

  const recent = (at, t) => at !== null && t >= at && t - at <= LIMIT_CONFIRM_WINDOW_MS;
  // The status level is "at the limit" only until the reset time the status
  // line itself reported: once that has passed the window is open again, so an
  // old report can never hold a session (fix round 1, M4). A level without a
  // reset time stays until the status line says otherwise.
  const statusLevel = (t) => statusAtLimit && !(statusResetAt !== null && t >= Date.parse(statusResetAt));
  const answer = (cleared = false) => ({
    held: holding,
    resetAt: holding ? (statusLevel(now()) && statusResetAt) || textResetAt || null : null,
    cleared
  });

  function reset() {
    hookAt = null;
    textAt = null;
    textResetAt = null;
    holding = false;
    holdUsedStatus = false;
  }

  function add(evidence) {
    const t = now();
    const source = evidence && typeof evidence === "object" ? evidence.source : null;
    if (source === "hook") {
      hookAt = t;
    } else if (source === "text") {
      textAt = t;
      textResetAt = isoOrNull(evidence.resetAt);
    } else if (source === "status") {
      statusAtLimit = evidence.atLimit === true;
      statusResetAt = statusAtLimit ? isoOrNull(evidence.resetAt) : null;
      if (!statusAtLimit) {
        if (!holding || !holdUsedStatus) return answer();
        reset();
        return answer(true);
      }
    } else {
      return answer();
    }
    const hook = recent(hookAt, t);
    const text = recent(textAt, t);
    const status = statusLevel(t);
    if (!holding && ((hook && text) || (status && (hook || text)))) holding = true;
    // Once the status line reports the limit during a hold, its clearing ends that hold.
    if (holding && status) holdUsedStatus = true;
    return answer();
  }

  return Object.freeze({ add, reset });
}

// Codex's limit rule (R15): it has no hook and no status line, so its limit
// text is the only signal, confirmed only when that text is still on screen
// CODEX_LIMIT_CONFIRM_MS later, the process is alive and no output was counted
// since. (A failed Codex turn sends no OSC 9, so the spec's other observation
// can't happen.)
export function codexLimitConfirmed({ stillOnScreen, alive, countedSince } = {}) {
  return stillOnScreen === true && alive === true && countedSince !== true;
}
