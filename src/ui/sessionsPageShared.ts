// The Sessions page's pure logic: the order of the tabs, which tab is selected, an ended tab's words, the side
// panel's Live meter rows, the New session button's hint, the terminal's own settings, and the words for a
// stop, resume or dismiss that went wrong. `import type` only (decision P14): test/sessions-page-logic.test.js
// loads this file straight from src/. Runs → Session recordings (recordingsShared.ts) keeps a copy of
// durationWords, checked by its test, because Node cannot follow an import written without a file extension.
import type { SessionSummary } from "../types";

type Tabbable = Pick<SessionSummary, "id" | "kind" | "status" | "dismissed">;

// Tabs keep their place: ids already shown stay in the order they were first seen, and new ones join at the end
// in the list's own order. The server sorts the list by each session's first start (meta.json createdAt, which a
// resume never changes), so a page opened fresh shows the same order too. Resume keeps the session id, so a
// resumed tab never jumps.
export function stableOrder(prev: string[], sessions: Array<Pick<SessionSummary, "id">>): string[] {
  const present = new Set(sessions.map((session) => session.id));
  const kept = prev.filter((id) => present.has(id));
  const known = new Set(kept);
  const added = sessions.filter((session) => !known.has(session.id)).map((session) => session.id);
  return [...kept, ...added];
}

// The tabs: every open agent session, and every ended one that was not dismissed (here, or in meta.json). An open
// session always shows, even if an old dismissal is still stored. Update sessions are never tabs (spec, Session kinds).
export function visibleTabs<T extends Tabbable>(sessions: T[], order: string[], hidden: ReadonlySet<string> = new Set<string>()): T[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return order
    .map((id) => byId.get(id))
    .filter((session): session is T => Boolean(session))
    .filter((session) => session.kind !== "update")
    .filter((session) => session.status !== "exited" || (!session.dismissed && !hidden.has(session.id)));
}

// The selected tab: the one asked for (?session=), else the first open one, else the first ended one, else none.
export function pickSelected(tabs: Array<Pick<SessionSummary, "id" | "status">>, wanted: string): string {
  if (wanted && tabs.some((tab) => tab.id === wanted)) return wanted;
  return (tabs.find((tab) => tab.status !== "exited") || tabs[0])?.id || "";
}

// Whether the selected terminal takes the keyboard (its autoFocus). Only when the page asked for that (`focusTerminal`)
// and, while the tab asked for is not in the list yet (a session started a moment ago; the list is read every 5 s),
// only for that very tab: until it arrives the page shows another tab, and typing must not go into that agent.
export function terminalTakesKeys({
  focusTerminal,
  wanted,
  selectedId,
  wantedListed
}: {
  focusTerminal: boolean;
  wanted: string;
  selectedId: string;
  wantedListed: boolean;
}): boolean {
  if (!focusTerminal) return false;
  if (wanted && !wantedListed) return selectedId === wanted;
  return true;
}

// An ended session's recording is gone when it is 0 bytes (the 1 GB cap, Q38, or a delete removed it: a recording
// always holds at least its header line). Runs then has no row for it.
export function recordingKept(recordingBytes: number): boolean {
  return recordingBytes > 0;
}

// Decision copy: an ended tab reads "<agent> · <folder> · Ended · open recording", and only "Ended" when its
// recording was removed (there is nothing to open).
export const ENDED_WORDS = "Ended · open recording";
export function tabLabel(title: string, status: string, recordingBytes: number): string {
  if (status !== "exited") return title;
  return `${title} · ${recordingKept(recordingBytes) ? ENDED_WORDS : "Ended"}`;
}

// The marker after a tab's title (spec, Session activity states). No SP3 session is waiting or held; SP4's alerts
// bring these two.
export function tabMarker(status: string): { kind: "waiting" | "held"; word: string } | null {
  if (status === "waiting") return { kind: "waiting", word: "Waiting for you" };
  if (status === "held") return { kind: "held", word: "Plan ran out" };
  return null;
}

export function dismissLabel(title: string): string {
  return `Dismiss ${title}`;
}
// The keyboard way to dismiss an ended tab, said as the tab's description. The x beside the tab is for the mouse
// only (it is not a tab, so it stays out of the tab list for a screen reader).
export const DISMISS_KEY_HINT = "Press Delete to dismiss";
// The keys that dismiss an ended tab: Delete, and the Mac key that is labelled "delete", which sends "Backspace".
export function isDismissKey(key: string, status: string): boolean {
  return status === "exited" && (key === "Delete" || key === "Backspace");
}

// Tabs dismissed on this page are hidden at once, before the server's answer. Once the list shows one of them not
// ended (it was resumed in another window), the local hiding is dropped and from then on the server's own
// `dismissed` flag decides, so the tab does not vanish when it ends again. The very same set comes back when
// nothing changes, so the page does not render for nothing.
export function pruneHidden(hidden: ReadonlySet<string>, sessions: ReadonlyArray<Pick<SessionSummary, "id" | "status">>): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of hidden) {
    const found = sessions.find((session) => session.id === id);
    if (found && found.status !== "exited") (next ??= new Set(hidden)).delete(id);
  }
  return next ?? hidden;
}

// A Stop or Resume question is about one session. When that session leaves the tabs (dismissed in another window,
// for instance) the question goes with it, so it cannot come back later over another session. A question whose
// request is still on its way stays: that request decides what happens next.
export function askingWhileTab<T extends { session: { id: string }; busy: boolean }>(asking: T | null, tabs: ReadonlyArray<{ id: string }>): T | null {
  if (!asking || asking.busy) return asking;
  return tabs.some((tab) => tab.id === asking.session.id) ? asking : null;
}

// The words of a failed Dismiss are about one ended tab ("press Dismiss again"). They stop being true when that
// tab is gone (the dismiss did happen) or running again (resumed elsewhere).
export function dismissErrorWhileEnded<T extends { id: string }>(problem: T | null, tabs: ReadonlyArray<{ id: string; status: string }>): T | null {
  if (!problem) return problem;
  const tab = tabs.find((item) => item.id === problem.id);
  return tab && tab.status === "exited" ? problem : null;
}

// The answer to a Stop (S7): an object whose `note` is words or null. Anything else, null for instance, is an answer
// that could not be read, and the page says so (src/sessionsApi.ts has no check of its own for it).
export function isStopAnswer(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const note = (answer as { note?: unknown }).note;
  return note === undefined || note === null || typeof note === "string";
}

// A resumed session starts a new process under the same id. Each time a session comes back from ended, its
// generation goes up, so the page attaches a fresh terminal instead of reusing the ended one. Ending does not
// change it, so the terminal that was on screen when the session ended keeps its last screen.
export type Generations = Record<string, { status: string; gen: number }>;
export function nextGenerations(prev: Generations, sessions: Array<Pick<SessionSummary, "id" | "status">>): Generations {
  const out: Generations = {};
  for (const session of sessions) {
    const before = prev[session.id];
    const gen = before ? before.gen + (before.status === "exited" && session.status !== "exited" ? 1 : 0) : 0;
    out[session.id] = { status: session.status, gen };
  }
  return out;
}
export function terminalKey(id: string, gens: Generations): string {
  return `${id}:${gens[id]?.gen ?? 0}`;
}

// "40 s", "12 m 40 s", "1 h 05 m"; "—" when the start is not known (or lies in the future).
export function durationWords(fromIso: string | null | undefined, toMs: number): string {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(toMs) || toMs < from) return "—";
  const seconds = Math.floor((toMs - from) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

// The Brain row, in the prototype's words.
export function brainWords(brain: SessionSummary["brain"]): { main: string; dim: string } | null {
  if (!brain) return null;
  if (brain.kind === "plan") return { main: "Plan", dim: "your subscription" };
  if (brain.kind === "openrouter") return { main: "OpenRouter", dim: "pay per use" };
  if (brain.kind === "local") return { main: "Local", dim: "on this computer" };
  return null;
}

export interface MeterRow {
  id: string;
  label: string;
  // null: not known, shown as "—" (with "unknown" for screen readers).
  value: string | null;
  dim?: string;
}

// Every Live meter row from SP3 (spec, Side panel). Model, Context used, Plan used and Cost so far come from
// Claude's statusLine in SP4, so they are null today. Plan used is for a plan brain and Cost so far for an
// OpenRouter brain, as in the prototype; neither applies to a Local brain or an agent with no brain choice.
export function meterRows(s: Pick<SessionSummary, "brain" | "status" | "startedAt" | "endedAt">, now: number): MeterRow[] {
  const brain = brainWords(s.brain);
  const ended = s.status === "exited";
  const endMs = ended ? (s.endedAt ? Date.parse(s.endedAt) : NaN) : now;
  const time = durationWords(s.startedAt, endMs);
  const rows: MeterRow[] = [
    brain ? { id: "brain", label: "Brain", value: brain.main, dim: brain.dim } : { id: "brain", label: "Brain", value: null },
    { id: "model", label: "Model", value: null },
    { id: "time", label: ended ? "Ran for" : "Running for", value: time === "—" ? null : time },
    { id: "context", label: "Context used", value: null }
  ];
  if (s.brain?.kind === "plan") rows.push({ id: "plan", label: "Plan used", value: null });
  if (s.brain?.kind === "openrouter") rows.push({ id: "cost", label: "Cost so far", value: null });
  return rows;
}

// The panel's title: the folder's name, or "Set by OpenClaw" while OpenClaw picks its own folder (spec L388).
export function panelFolder(s: Pick<SessionSummary, "folderShown" | "folderName">): string {
  return s.folderShown === false ? "Set by OpenClaw" : s.folderName || "—";
}

// After Stop, OpenClaw's Gateway may still finish its step (until spike S5 brings its abort): the spec's honest note.
// Used only for an ended OpenClaw tab opened later (after a reload, or stopped from another window); right after a
// Stop from this page the panel shows the server's own note instead (panelStopNote below).
// This mirrors S7's OPENCLAW_STOP_NOTE rule (server/runtime/sessions/soft-stop.js); update both when spike S5 lands.
export const OPENCLAW_STOP_NOTE = "Stopped the terminal. OpenClaw may still be finishing its last step.";
export function stopResultNote(s: Pick<SessionSummary, "agentId" | "status" | "endedBy">): string | null {
  return s.agentId === "openclaw" && s.status === "exited" && s.endedBy === "stop" ? OPENCLAW_STOP_NOTE : null;
}

// The note under the panel's state line. Right after a Stop from this page it is the server's own answer (S7's
// `note`, passed through by S8; null when nothing is left running), kept with the terminal key of the run that was
// stopped, so it applies only while the list says that same run has ended (a resume raises the key). Any other
// time it is stopResultNote's rule.
export interface StopNote {
  key: string;
  note: string | null;
}
export function panelStopNote(
  s: Pick<SessionSummary, "agentId" | "status" | "endedBy">,
  key: string,
  stopped: StopNote | null
): string | null {
  if (stopped && stopped.key === key && s.status === "exited") return stopped.note;
  return stopResultNote(s);
}

// (Why Resume can't be pressed is resumeConfirmCopy(s).blocked, and which key is an app shortcut is isAppShortcut,
// both in sessionsShared.ts, Task U1.)

// The tab bar's New session button names its shortcut only where the page really receives it (spec: a browser
// keeps ⌘T and Ctrl+T for itself).
export function newSessionHint({ isMac, desktop }: { isMac: boolean; desktop: boolean }): string {
  if (!desktop) return "New session";
  return isMac ? "New session (⌘T)" : "New session (Ctrl+Shift+T)";
}

// Kitty keyboard and the drawing method change only this browser's terminal, so they are kept in this browser
// (spec, Browser terminal). Kitty is on by default. The drawing method's default follows decision Q45: the DOM
// on macOS and in the Linux desktop app (both draw with WebKit, where WebGL glyph corruption is reported), and
// WebGL in the Windows desktop app and in a browser tab on Windows or Linux. A terminal whose WebGL context is
// lost falls back to the DOM by itself (SessionTerminal, Task U2).
export interface TerminalPrefs {
  kittyKeyboard: boolean;
  webgl: boolean;
}
// `platform` is navigator.platform (or the user agent when that is empty); `desktop` is isDesktopApp().
export interface TerminalPlatform {
  platform: string;
  desktop: boolean;
}
export const TERMINAL_PREFS_KEY = "agentos.terminalPrefs";
export function defaultTerminalPrefs({ platform, desktop }: TerminalPlatform): TerminalPrefs {
  const mac = /mac/i.test(platform);
  const linux = /linux/i.test(platform) && !/android/i.test(platform);
  return { kittyKeyboard: true, webgl: !(mac || (linux && desktop)) };
}
export function parseTerminalPrefs(raw: string | null, platform: TerminalPlatform): TerminalPrefs {
  const base = defaultTerminalPrefs(platform);
  if (!raw) return base;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof TerminalPrefs, unknown>> | null;
    return {
      kittyKeyboard: typeof value?.kittyKeyboard === "boolean" ? value.kittyKeyboard : base.kittyKeyboard,
      webgl: typeof value?.webgl === "boolean" ? value.webgl : base.webgl
    };
  } catch {
    return base;
  }
}
export function serializeTerminalPrefs(prefs: TerminalPrefs): string {
  return JSON.stringify({ kittyKeyboard: prefs.kittyKeyboard, webgl: prefs.webgl });
}

// What may have happened although nothing (or nothing readable) came back; the first sentence says which.
const MAY_HAVE_HAPPENED = {
  stop: "The session may have stopped: its tab says Ended once it has.",
  resume: "The session may have started again: its tab shows it once it has.",
  dismiss: "If the tab is still here after the next update, press Dismiss again."
};
const NO_ANSWER_FIRST = "Agent OS hasn't answered.";
// An answer came but could not be read (ruling, Task U3): not "no answer", but the change may still have happened.
const UNREADABLE_FIRST = "Agent OS answered, but the answer couldn't be read.";
const REFUSED = {
  stop: "Agent OS couldn't stop the session.",
  resume: "Agent OS couldn't resume the conversation.",
  dismiss: "Agent OS couldn't dismiss the tab."
};

// The words for a Stop, Resume or Dismiss that failed. No answer is not a refusal: the change may have happened,
// so the words say so (the page reads the list again). `gotNoAnswer` is what src/sessionsApi.ts's
// sessionGotNoAnswer(error) says, and the page passes it: that file owns the rule for which failures are an answer
// that could not be read, and this one (which keeps only `import type`, so Node can load it) keeps only the words.
// true (the default) is no answer at all; false is an answer that could not be read (ruling, Task U3): the words
// say Agent OS did answer, then the same "may have" sentence. A refusal (Agent OS's own answer, an ApiError) uses
// the server's own sentence whatever the flag says (decisions Q15, Q25, Q36 and Q37 give each one; a 409
// session_busy brings its own, "This session is already being changed. Try again in a moment.").
export function actionProblem(error: unknown, action: "stop" | "resume" | "dismiss", gotNoAnswer = true): string {
  if (!(error instanceof Error) || error.name !== "ApiError") {
    return `${gotNoAnswer ? NO_ANSWER_FIRST : UNREADABLE_FIRST} ${MAY_HAVE_HAPPENED[action]}`;
  }
  const detail = String((error as Error & { detail?: unknown }).detail || "").trim();
  if (detail) return detail;
  if (error.message === "unknown_session") return "That session doesn't exist anymore.";
  return REFUSED[action];
}

// A Resume refused because Safety is on Look only: the dialog then offers the way to Safety (Review Focus 5).
export function isLookOnlyRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === "ApiError" && error.message === "execution_gate_off";
}
