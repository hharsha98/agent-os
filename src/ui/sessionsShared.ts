// Sessions (SP3): the words and small rules shared by the Sessions page, Home, Runs, the menu and the quit
// question, plus the pure half of the terminal's WebSocket protocol (frame sizes, acks, reading a frame).
// `import type` only (decision P14): test/sessions-shared.test.js loads this file straight from src/ and
// Node strips the types.
import type {
  MouseEncodingMode,
  MouseTrackingMode,
  QuitCheckItem,
  SessionModes,
  SessionServerFrame,
  SessionStatus,
  SessionSummary
} from "../types";
import type { StatusState } from "./components/StatusWord";

// ---------------------------------------------------------------------------
// Titles, status words and the side panel's line
// ---------------------------------------------------------------------------

// What every tab, dialog and recording calls a session: "Claude Code · my-app". OpenClaw picks its own
// folder until spike S5, so its sessions read "OpenClaw · Set by OpenClaw". An update session is
// "<agent> update" (spec, Session kinds). "—" stands in for a folder name that is not known, and the agent's
// name falls back to its id, then to "Agent" (the same rule as Stop all's sessionStopTitle, which a test keeps equal).
export function sessionTitle(s: Pick<SessionSummary, "kind" | "agentId" | "agentLabel" | "folderName" | "folderShown">): string {
  const agent = s.agentLabel || s.agentId || "Agent";
  // A setup session (plan brains §1) is OpenClaw's ChatGPT sign-in in a brain card: "OpenClaw · ChatGPT sign-in".
  if (s.kind === "setup") return `${agent} · ChatGPT sign-in`;
  if (s.kind === "update") return `${agent} update`;
  if (s.folderShown === false) return `${agent} · Set by OpenClaw`;
  return `${agent} · ${s.folderName || "—"}`;
}

// The kit's status words (planning decision Q18): "Starting" and "Ended" are new labels on existing
// states, not new colours. An unknown status from the server shows "—".
const STATE_WORDS: Record<SessionStatus, { state: StatusState; label: string }> = {
  starting: { state: "idle", label: "Starting" },
  live: { state: "live", label: "Live" },
  waiting: { state: "waiting", label: "Waiting for you" },
  idle: { state: "idle", label: "Idle" },
  held: { state: "held", label: "Held" },
  exited: { state: "stopped", label: "Ended" }
};

function knownStatus(status: unknown): status is SessionStatus {
  return typeof status === "string" && Object.prototype.hasOwnProperty.call(STATE_WORDS, status);
}

export function sessionStateWord(s: Pick<SessionSummary, "status">): { state: StatusState; label: string } {
  return knownStatus(s.status) ? STATE_WORDS[s.status] : { state: "unknown", label: "" };
}

// A session whose program is still running: every status but "exited" (an unknown status is not counted).
export function isSessionRunning(s: Pick<SessionSummary, "status">): boolean {
  return knownStatus(s.status) && s.status !== "exited";
}

// THE rule for an open session in the UI: an AGENT session whose program is still running. An update session is never
// counted (spec, Session kinds), nor is a setup session (OpenClaw's ChatGPT sign-in terminal), nor a status this
// version does not know. The menu's count, Home (its lede, rows, Recent activity) and Agents' Open session button all
// use this one function, so they never disagree.
export function isOpenAgentSession(s: Pick<SessionSummary, "kind" | "status">): boolean {
  return s.kind === "agent" && isSessionRunning(s);
}

// The menu's count: open agent sessions only.
export function runningSessionCount(sessions: ReadonlyArray<Pick<SessionSummary, "kind" | "status">>): number {
  return sessions.filter(isOpenAgentSession).length;
}

// "under 1 m", "26 m", "1 h 05 m" (the same words as Home's elapsedLabel); "—" when not known.
export function sessionDuration(fromIso: string | null | undefined, now: number): string {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from) || now < from) return "—";
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return "under 1 m";
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

// `nothingToResume` is optional here: a summary from a server that doesn't send it counts as false.
type EndFields = Pick<SessionSummary, "exitCode" | "signal" | "endedBy"> & { nothingToResume?: boolean };

// How a session ended, in words (spec, the side panel's exited lines). Agent OS's own Stop and quit come
// first, because both end the program with a signal; then Claude Code's "nothing saved" (its exit code 1
// would say nothing useful), then a signal, which says more than an exit code that comes with it.
export function endedLine(s: EndFields): string {
  if (s.endedBy === "stop") return "Stopped by you.";
  if (s.endedBy === "quit") return "Ended when Agent OS quit.";
  if (s.nothingToResume === true) return "Claude Code found nothing saved for this conversation, so it couldn't be resumed.";
  if (typeof s.signal === "string" && s.signal.trim()) return `Ended by signal ${s.signal.trim()}.`;
  if (s.exitCode === 0) return "Ended normally.";
  if (typeof s.exitCode === "number" && Number.isFinite(s.exitCode)) return `Ended with exit code ${s.exitCode}.`;
  return "Ended.";
}

// "2:21 am" for a time today, "Oct 30, 2:21 am" for another day; "" when it isn't a time. The Runs page's
// formatResetTime words (src/ui/builderShared.ts), kept here as a copy because that file imports at run time and this
// one must not (test/sessions-alerts-ui-logic.test.js pins the words).
export function resetWords(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .replace(/\s?(AM|PM)$/i, (match) => ` ${match.trim().toLowerCase()}`);
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

// What the line reads besides the SP3 fields. Each SP4 field is optional here, so a summary without it reads as basic.
// (trustNeeded and hooksOff are read by panelAlertLines in alertsShared.ts, the lines under this one.)
type PanelLineFields = Pick<SessionSummary, "status" | "agentLabel" | "recordingBytes"> &
  EndFields & {
    stateSince?: string | null;
    agentId?: string;
    alerts?: SessionSummary["alerts"];
    idleBy?: SessionSummary["idleBy"];
    resetAt?: string | null;
    alert?: SessionSummary["alert"];
  };

// The side panel's one line for the state (spec, Session activity states; the prototype's info()). Live says whether
// Agent OS hears this agent's questions: "full" once a turn-done session's first signal arrived, otherwise basic.
// OpenClaw's approval question is a card in the panel. Idle entered by a turn_done signal is "Ready for the next
// message." (K21). An ended session's recording holds at least its header line, so 0 bytes means the 1 GB cap (Q38) or a
// delete removed it: then Runs has no row for it, and the line does not send the person there.
export function sessionPanelLine(s: PanelLineFields, now: number): string {
  switch (s.status) {
    case "starting":
      return `Starting ${s.agentLabel}…`;
    case "live":
      // OpenClaw's approvals are alerts of their own (cards, polled every 3 s), so it says the full line although its
      // session alerts are never "full" (it has no turn-done signal). Hermes and Cursor stay basic (R18).
      return s.alerts === "full" || s.agentId === "openclaw"
        ? "Working. Agent OS alerts you when it asks you something."
        : `Working. Alerts for ${s.agentLabel} are basic.`;
    case "waiting":
      return s.agentId === "openclaw" && s.alert?.kind === "approval"
        ? "The question is in the card below."
        : "The question is in the terminal. Agent OS never answers for you.";
    case "idle": {
      if (s.idleBy === "turn_done") return "Ready for the next message.";
      const time = sessionDuration(s.stateSince, now);
      return time === "—" ? "Idle. Nothing is running." : `Idle for ${time}. Nothing is running.`;
    }
    case "held": {
      const when = resetWords(s.resetAt, now);
      return when ? `Plan limit reached. Resets ${when}.` : "Plan limit reached.";
    }
    case "exited":
      return s.recordingBytes > 0 ? `${endedLine(s)} The recording is in Runs.` : `${endedLine(s)} Its recording was removed.`;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// The Stop dialog and the Resume confirm
// ---------------------------------------------------------------------------

type DialogFields = Pick<SessionSummary, "kind" | "agentId" | "agentLabel" | "folderName" | "folderShown">;

export interface StopDialogCopy {
  title: string;
  body: string;
  note: string | null;
  cancel: string;
  confirm: string;
}

// The Stop dialog (spec, the prototype's stopDialog()). OpenClaw adds what Stop cannot promise for it
// until spike S5.
export function stopDialogCopy(s: DialogFields): StopDialogCopy {
  return {
    title: `Stop ${sessionTitle(s)}?`,
    body: `This ends ${s.agentLabel} in this tab. The recording stays in Runs.`,
    note: s.agentId === "openclaw" ? "OpenClaw may still finish its last step after the terminal closes." : null,
    cancel: "Keep it running",
    confirm: "Stop session"
  };
}

export interface ResumeConfirmCopy {
  title: string;
  body: string;
  warning: string | null;
  blocked: string | null;
  cancel: string;
  confirm: string;
}

// Resume conversation's confirm (spec, Resume per agent; planning decision Q36). `blocked` is the written
// reason when the rules say no (the button is disabled and shows it); `warning` is a fallback resume's
// honest limit.
export function resumeConfirmCopy(s: DialogFields & Pick<SessionSummary, "resume">): ResumeConfirmCopy {
  const resume = s.resume || { available: false, reason: null, fallback: false };
  return {
    title: `Resume ${sessionTitle(s)}?`,
    body: `This starts ${s.agentLabel} again in the same tab and continues the conversation. The recording continues after a marker.`,
    warning: resume.fallback
      ? `This resumes the most recent ${s.agentLabel} conversation in this folder, which may be one you started outside Agent OS.`
      : null,
    blocked: resume.available ? null : resume.reason || "This session can't be resumed.",
    cancel: "Cancel",
    confirm: "Resume conversation"
  };
}

// A Resume the server refused because it can never work as things stand: 409 session_live (the session runs again, so
// there is nothing to resume) or 409 not_resumable (an update session, or the agent's resume rules say no). The
// dialog then disables its Resume button and keeps the server's own sentence; every other refusal (a busy double
// click, Look only, no answer) can work on another try. An Error is Agent OS's own answer when it is named
// "ApiError" (src/api.ts), the same test the other pages' refusal helpers use.
export function isImpossibleResume(error: unknown): boolean {
  return error instanceof Error && error.name === "ApiError" && (error.message === "session_live" || error.message === "not_resumable");
}

// ---------------------------------------------------------------------------
// Keys (spec, App shortcuts (precedence))
// ---------------------------------------------------------------------------

export function isMacPlatform(platform: string): boolean {
  return /mac/i.test(platform || "");
}

// The parts of a KeyboardEvent these rules read (a real KeyboardEvent fits).
export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type AppShortcut = { action: "palette" } | { action: "new-session" } | { action: "switch"; index: number } | { action: "split" };

// The letter pressed, also on a keyboard layout that types another letter in that place (for example
// Cyrillic): then the key's place (event.code) decides.
function isLetter(event: KeyLike, letter: string): boolean {
  const pressed = (event.key || "").toLowerCase();
  if (pressed === letter) return true;
  return !/^[a-z]$/.test(pressed) && event.code === `Key${letter.toUpperCase()}`;
}

// 1 to 9 on the number row: by the key's place first, because Shift changes the character (Ctrl+Shift+1 types "!").
function rowDigit(event: KeyLike): number | null {
  const byPlace = /^Digit([1-9])$/.exec(event.code || "");
  if (byPlace) return Number(byPlace[1]);
  return /^[1-9]$/.test(event.key || "") ? Number(event.key) : null;
}

// The palette key OUTSIDE a terminal: ⌘K on a Mac, Ctrl+K elsewhere, never both on one computer.
export function isPaletteKey(event: KeyLike, { isMac }: { isMac: boolean }): boolean {
  if (event.altKey || event.shiftKey) return false;
  const held = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return held && isLetter(event, "k");
}

// The backslash key, by its place first: Shift turns it into "|" (Ctrl+Shift+\ on Windows and Linux).
function isBackslash(event: KeyLike): boolean {
  return event.code === "Backslash" || event.key === "\\";
}

// The only keys a terminal leaves to Agent OS: ⌘K, ⌘T, ⌘1-9 and ⌘\ on a Mac; Ctrl+Shift+K/T/1-9/\ elsewhere.
// Everything else goes to the agent, Ctrl+K, Ctrl+R and Ctrl+\ (the terminal's quit key) included. A browser keeps
// ⌘T and ⌘1-9 (Ctrl+T, Ctrl+1-9, Ctrl+Shift+T) for itself, so in browser mode only the palette key is Agent OS's;
// split view has its Split view button there (Task U6).
export function isAppShortcut(event: KeyLike, { isMac, desktop }: { isMac: boolean; desktop: boolean }): AppShortcut | null {
  if (event.altKey) return null;
  const held = isMac ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey && !event.metaKey;
  if (!held) return null;
  if (isLetter(event, "k")) return { action: "palette" };
  if (!desktop) return null;
  if (isLetter(event, "t")) return { action: "new-session" };
  if (isBackslash(event)) return { action: "split" };
  const digit = rowDigit(event);
  return digit === null ? null : { action: "switch", index: digit - 1 };
}

// The side panel footer's hints: desktop app only, nothing in browser mode (spec, Browser mode).
export function shortcutHints({ isMac, desktop }: { isMac: boolean; desktop: boolean }): Array<{ keys: string; word: string }> {
  if (!desktop) return [];
  // The split keys are written again in splitShared.ts (splitKeys); test/sessions-split-logic.test.js keeps them equal.
  return isMac
    ? [{ keys: "⌘T", word: "new" }, { keys: "⌘1-9", word: "switch" }, { keys: "⌘\\", word: "split" }]
    : [{ keys: "Ctrl+Shift+T", word: "new" }, { keys: "Ctrl+Shift+1-9", word: "switch" }, { keys: "Ctrl+Shift+\\", word: "split" }];
}

// ---------------------------------------------------------------------------
// The quit question (desktop app; planning decision Q6)
// ---------------------------------------------------------------------------

export const QUIT_REQUESTED_EVENT = "agentos://quit-requested";
export const QUIT_SHOWN_EVENT = "agentos://quit-shown";
export const QUIT_ANSWER_EVENT = "agentos://quit-answer";
// The shell quits on its own when no window says "quit-shown" within 2 s. A local answer normally takes a
// few milliseconds; when it takes longer than this, the question shows "Checking…" first.
export const QUIT_FAST_MS = 700;
// How much longer the question waits for the list before it says it could not check.
export const QUIT_CHECK_MS = 6000;

export type QuitView = { phase: "checking" } | { phase: "asking"; live: QuitCheckItem[] } | { phase: "unknown" };

// "A", "A and B", "A, B and C", "A, B, C, D and 2 more".
export function joinNames(names: string[], max = 4): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// The quit question's words (planning decisions, "Quit question"; ruling R21). An update session is never
// resumed (spec, Session kinds), so the agent sentence, with its resume promise, covers only agent sessions,
// and a running update gets its own sentence. Its title is already "<agent> update" (S6, decision Q27).
export function quitQuestionCopy(view: QuitView): { title: string; body: string; keep: string; quit: string } {
  const base = { title: "Quit Agent OS?", keep: "Keep running", quit: "Quit" };
  if (view.phase === "checking") return { ...base, body: "Checking which sessions are still running…" };
  if (view.phase === "unknown") {
    return { ...base, body: "Agent OS couldn't check which sessions are running. Quitting ends any that are. Their recordings stay in Runs." };
  }
  const agents = view.live.filter((item) => item.kind !== "update").map((item) => item.title);
  const updates = view.live.filter((item) => item.kind === "update").map((item) => `the ${item.title}`);
  const sentences: string[] = [];
  if (agents.length === 1) {
    sentences.push(`${agents[0]} is still running. Quitting ends it. Its recording stays in Runs, and you can resume it later.`);
  } else if (agents.length > 1) {
    sentences.push(
      `These sessions are still running: ${joinNames(agents)}. Quitting ends them. Their recordings stay in Runs, and you can resume them later.`
    );
  }
  if (updates.length > 0) {
    // At most one update runs at a time (S6), so this is nearly always "the Hermes update".
    const names = joinNames(updates);
    sentences.push(
      agents.length > 0
        ? `Quitting also stops ${names}.`
        : `${names.charAt(0).toUpperCase()}${names.slice(1)} ${updates.length === 1 ? "is" : "are"} still running. Quitting stops ${updates.length === 1 ? "it" : "them"}.`
    );
  }
  return { ...base, body: sentences.join(" ") };
}

export interface QuitFlow {
  // POST /api/sessions/quit-check.
  check: () => Promise<{ live: QuitCheckItem[] }>;
  // Draw (or redraw) the question.
  show: (view: QuitView) => void;
  // Tell the shell the question is on screen ("agentos://quit-shown"). Called at most once.
  shown: () => void;
  // Answer without asking (nothing would be lost).
  answer: (quit: boolean) => void;
  // false once the person has answered, so a late check changes nothing.
  isOpen: () => boolean;
}

type Checked = { live: QuitCheckItem[] } | null;

function within<T>(promise: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(late), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

// What the window does when the shell asks to quit: quit at once when nothing runs; otherwise put the
// question on screen inside the shell's 2 s, naming the running sessions as soon as they are known.
export async function runQuitFlow(flow: QuitFlow): Promise<void> {
  const checked: Promise<Checked> = Promise.resolve()
    .then(() => flow.check())
    .then(
      (answer) => (answer && Array.isArray(answer.live) ? { live: answer.live } : null),
      () => null
    );
  const first = await within<Checked | "slow">(checked, QUIT_FAST_MS, "slow");
  if (!flow.isOpen()) return;
  if (first !== "slow") {
    if (first && first.live.length === 0) {
      flow.answer(true);
      return;
    }
    flow.show(first ? { phase: "asking", live: first.live } : { phase: "unknown" });
    flow.shown();
    return;
  }
  flow.show({ phase: "checking" });
  flow.shown();
  const later = await within<Checked>(checked, QUIT_CHECK_MS, null);
  if (!flow.isOpen()) return;
  if (later && later.live.length === 0) {
    flow.answer(true);
    return;
  }
  flow.show(later ? { phase: "asking", live: later.live } : { phase: "unknown" });
}

export interface QuitRounds {
  // The shell asked to quit. The new round's number, or null while a question is already open (a second
  // request changes nothing).
  begin: () => number | null;
  // The question is answered (by the person, or by the flow when nothing would be lost): no round is open.
  end: () => void;
  // True for the newest round while it is open, false for every older one.
  isCurrent: (round: number) => boolean;
  // The flow of one round, with every call guarded: once that round is answered, a check that arrives late
  // can neither draw nor answer, not even after a newer request has begun (a shared flag could not tell
  // the two requests apart).
  guard: (round: number, flow: Omit<QuitFlow, "isOpen">) => QuitFlow;
}

export function createQuitRounds(): QuitRounds {
  let open = false;
  let newest = 0;
  const isCurrent = (round: number) => open && round === newest;
  return {
    begin() {
      if (open) return null;
      open = true;
      newest += 1;
      return newest;
    },
    end() {
      open = false;
    },
    isCurrent,
    guard(round, flow) {
      return {
        check: () => flow.check(),
        show: (view) => {
          if (isCurrent(round)) flow.show(view);
        },
        shown: () => {
          if (isCurrent(round)) flow.shown();
        },
        answer: (quit) => {
          if (isCurrent(round)) flow.answer(quit);
        },
        isOpen: () => isCurrent(round)
      };
    }
  };
}

// What the update banner does with the answer to the quit check before "Install & restart" downloads anything
// (that restart ends every session, and the shell cannot ask first on this path): null means nothing runs, so
// install at once; otherwise the question to ask. An answer that cannot be read asks too, and says so.
export function installQuestion(check: { live?: QuitCheckItem[] | null } | null | undefined): QuitView | null {
  if (!check || !Array.isArray(check.live)) return { phase: "unknown" };
  return check.live.length > 0 ? { phase: "asking", live: check.live } : null;
}

// ---------------------------------------------------------------------------
// The terminal's WebSocket protocol, pure half (spec, WebSocket protocol)
// ---------------------------------------------------------------------------

// Acknowledge at least every 64 KB received (and processed).
export const ACK_EVERY_BYTES = 64 * 1024;
// An {t:"in"} frame over 64 KB is refused, so every frame (JSON and all) stays at or under it.
export const MAX_IN_FRAME_BYTES = 64 * 1024;
export const RESIZE_DEBOUNCE_MS = 50;
export const MIN_COLS = 2;
export const MAX_COLS = 500;
export const MIN_ROWS = 1;
export const MAX_ROWS = 200;

export function validSize(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === "number" &&
    typeof rows === "number" &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= MIN_COLS &&
    cols <= MAX_COLS &&
    rows >= MIN_ROWS &&
    rows <= MAX_ROWS
  );
}

// Bytes the text takes as UTF-8 (a lone surrogate counts 3, as TextEncoder writes U+FFFD).
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Bytes one character takes inside a JSON string, as UTF-8.
function jsonBytes(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2; // \" and \\
  if (cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return 2; // \b \t \n \f \r
  if (cp < 0x20) return 6; // \u001b and the other control characters
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // a lone surrogate is written as \udxxx
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

const IN_FRAME_OVERHEAD = utf8ByteLength(JSON.stringify({ t: "in", d: "" }));

// Splits typed or pasted text into {t:"in"} frames of at most `maxFrameBytes` each, never inside a
// character (an emoji stays whole).
export function chunkInput(data: string, maxFrameBytes = MAX_IN_FRAME_BYTES): string[] {
  if (!data) return [];
  const budget = maxFrameBytes - IN_FRAME_OVERHEAD;
  const chunks: string[] = [];
  let current = "";
  let used = 0;
  for (const ch of data) {
    const size = jsonBytes(ch.codePointAt(0) as number);
    if (used + size > budget && current) {
      chunks.push(current);
      current = "";
      used = 0;
    }
    current += ch;
    used += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Counts output that is on screen and says when to acknowledge it: once 64 KB more than the last ack.
export function createAckCounter(every = ACK_EVERY_BYTES) {
  let processed = 0;
  let acked = 0;
  return {
    // Output up to `seq` (cumulative UTF-8 bytes since the snapshot) is on screen. Returns the seq to
    // acknowledge now, or null.
    processed(seq: number): number | null {
      if (!Number.isFinite(seq) || seq <= processed) return null;
      processed = seq;
      if (processed - acked < every) return null;
      acked = processed;
      return processed;
    },
    // A fresh snapshot starts the count again at 0 (seq counts from 0 after each snapshot).
    reset() {
      processed = 0;
      acked = 0;
    }
  };
}

const MOUSE_TRACKING: readonly MouseTrackingMode[] = ["none", "x10", "vt200", "drag", "any"];
const MOUSE_ENCODING: readonly MouseEncodingMode[] = ["default", "sgr", "sgr-pixels"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

// The snapshot's modes, every value checked; anything not allowed is off.
export function readModes(raw: unknown): SessionModes {
  const m = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flags = m.kittyFlags;
  return {
    altScreen: m.altScreen === true,
    bracketedPaste: m.bracketedPaste === true,
    mouseTracking: oneOf(m.mouseTracking, MOUSE_TRACKING, "none"),
    mouseEncoding: oneOf(m.mouseEncoding, MOUSE_ENCODING, "default"),
    focusReporting: m.focusReporting === true,
    cursorKeysApp: m.cursorKeysApp === true,
    kittyFlags: typeof flags === "number" && Number.isInteger(flags) && flags >= 0 && flags <= 31 ? flags : 0
  };
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

// One server frame, or null for anything that is not a well-formed frame (it is then ignored).
export function parseServerFrame(text: string): SessionServerFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (f.t === "snapshot") {
    if (typeof f.data !== "string" || !validSize(f.cols, f.rows)) return null;
    return { t: "snapshot", data: f.data, cols: f.cols as number, rows: f.rows as number, modes: readModes(f.modes) };
  }
  if (f.t === "out") {
    if (typeof f.d !== "string" || typeof f.seq !== "number" || !Number.isFinite(f.seq) || f.seq < 0) return null;
    return { t: "out", seq: f.seq, d: f.d };
  }
  if (f.t === "state") {
    if (!knownStatus(f.status)) return null;
    const endedBy = f.endedBy === "stop" || f.endedBy === "quit" ? f.endedBy : null;
    return { t: "state", status: f.status, exitCode: numberOrNull(f.exitCode), signal: textOrNull(f.signal), endedBy, resetAt: textOrNull(f.resetAt) };
  }
  if (f.t === "alert") {
    // SP4's frame (K8): a new or changed alert, or "resolved" when it cleared. SP3's { t: "alert", raw } is not read.
    const kind = f.kind;
    if (kind !== "waiting" && kind !== "approval" && kind !== "limit" && kind !== "resolved") return null;
    return { t: "alert", kind, text: typeof f.text === "string" ? f.text : "" };
  }
  return null;
}

// What a window does after the server closed its socket. S9's CLOSE_CODES give each reason word a number
// (too_far_behind 4000, session_ended 4001, attach_failed 4004), and the close reason text is that word.
// The word decides, never the number, so a changed number cannot make a window attach to an ended session.
// 1009 is ws's own close for a message over 1 MB and carries no word of Agent OS's: the one number read.
//   "reattach": attach again for a fresh snapshot (too far behind, a dropped connection, Agent OS restarting);
//   "ended":    the session ended; keep the last screen and never attach again;
//   "wait":     this window could not attach, or sent too much; do not try again at once.
export type SessionCloseAdvice = "reattach" | "ended" | "wait";

// S9's number for the reason word "attach_failed". This window uses it when no snapshot comes within
// SNAPSHOT_WAIT_MS: it gives up as if the server had refused, so the terminal shows the same "could not attach" and waits.
export const ATTACH_FAILED_CODE = 4004;
// The upgrade succeeded but no snapshot (and no close) came: after this long the terminal stops showing "loading".
export const SNAPSHOT_WAIT_MS = 15_000;

export function sessionCloseAdvice({ code, reason }: { code: number; reason: string }): SessionCloseAdvice {
  if (reason === "session_ended") return "ended";
  if (reason === "too_far_behind") return "reattach";
  if (reason === "attach_failed" || code === 1009) return "wait";
  return "reattach";
}
