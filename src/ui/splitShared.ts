// Split view on the Sessions page (spec SP4, Split; Task U6): two panes side by side, each with its own header, a
// divider to drag between them, and the side panel following the focused pane. One terminal per pane, and the same
// session is never in both panes. The selected tab (?session=) is always the focused pane, so the side panel, Stop
// and Resume need nothing new. Split view is kept per window: the page stores serializeSplitState in sessionStorage
// under SPLIT_KEY, so a reload and leaving the page keep it, and a second window starts with one terminal.
// `import type` only (decision P14): test/sessions-split-logic.test.js loads this file straight from src/, so the key
// names in splitKeys are written here again, and that test keeps them equal to shortcutHints in sessionsShared.ts.
import type { SessionSummary } from "../types";

type Pane = Pick<SessionSummary, "id" | "status">;

export const SPLIT_KEY = "agentos.sessions.split.v1";
// The left pane's share of the width: the prototype's 28 % to 72 %, the middle to start, 2 % per arrow key.
export const SPLIT_MIN = 0.28;
export const SPLIT_MAX = 0.72;
export const SPLIT_DEFAULT = 0.5;
export const SPLIT_KEY_STEP = 0.02;

// on: split view is shown. panes: the two sessions, left then right (null while off). focus: the pane whose session
// is the selected tab (the side panel follows it). ratio: the left pane's share, kept while split view is off.
export interface SplitState {
  on: boolean;
  panes: [string, string] | null;
  focus: 0 | 1;
  ratio: number;
}
export const SPLIT_OFF: SplitState = { on: false, panes: null, focus: 0, ratio: SPLIT_DEFAULT };

function splitOff(ratio: number): SplitState {
  return { on: false, panes: null, focus: 0, ratio };
}

// The left pane's share, kept between SPLIT_MIN and SPLIT_MAX and rounded to 0.001 (so the arrow keys never pile up
// tiny errors). Anything that is not a finite number, a broken stored value for example, is the middle.
export function clampSplit(ratio: number): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return SPLIT_DEFAULT;
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)) * 1000) / 1000;
}

// The sessions that can go next to `firstId`: every other tab, open ones first, then ended ones, each in tab order.
export function secondPaneChoices<T extends Pane>(sessions: readonly T[], firstId: string): T[] {
  const others = sessions.filter((session) => session.id !== firstId);
  return [...others.filter((session) => session.status !== "exited"), ...others.filter((session) => session.status === "exited")];
}

// Split view needs two tabs (an ended tab counts: it is still a session, with its last screen).
export function canSplit(tabs: readonly Pane[]): boolean {
  return tabs.length >= 2;
}

// The Split view button and ⌘\. Off → on: the selected tab on the left (the focused pane, where the keyboard already
// is) and the first of secondPaneChoices on the right. On → off: the focused pane's session stays on screen alone, and
// the width is kept for next time. With no selected tab or no second tab, the very same state comes back.
export function toggleSplit(state: SplitState, tabs: readonly Pane[], selectedId: string): SplitState {
  if (state.on) return splitOff(clampSplit(state.ratio));
  const first = tabs.find((tab) => tab.id === selectedId);
  const second = first ? secondPaneChoices(tabs, first.id)[0] : undefined;
  if (!first || !second) return state;
  return { on: true, panes: [first.id, second.id], focus: 0, ratio: clampSplit(state.ratio) };
}

// Keeps split view true to the tabs and the selected tab, after every change of either:
// - the selected tab is always the focused pane: when it is the other pane's session only the focus moves; when it is
//   in neither pane (a tab clicked, ⌘1-9, a link, a session just started) it takes the focused pane's place;
// - a pane whose session left the tabs (dismissed) gets the next of secondPaneChoices; with fewer than two tabs, or
//   no listed selected tab, split view ends;
// - the same session is never in both panes.
// The very same object comes back when nothing changes, so the page can store the answer without looping.
export function alignSplit(state: SplitState, tabs: readonly Pane[], selectedId: string): SplitState {
  if (!state.on) return state;
  const listed = new Set(tabs.map((tab) => tab.id));
  if (!state.panes || tabs.length < 2 || !listed.has(selectedId)) return splitOff(state.ratio);
  const [left, right] = state.panes;
  let focus: 0 | 1 = state.focus;
  let panes: [string, string] = [left, right];
  if (selectedId === left) focus = 0;
  else if (selectedId === right) focus = 1;
  else panes = focus === 0 ? [selectedId, right] : [left, selectedId];
  const other: 0 | 1 = focus === 0 ? 1 : 0;
  if (!listed.has(panes[other]) || panes[other] === panes[focus]) {
    const next = secondPaneChoices(tabs, panes[focus])[0];
    if (!next) return splitOff(state.ratio);
    panes = focus === 0 ? [panes[0], next.id] : [next.id, panes[1]];
  }
  if (focus === state.focus && panes[0] === left && panes[1] === right) return state;
  return { on: true, panes, focus, ratio: state.ratio };
}

// How the session in the address (?session=) stands against the list:
// - "none": no session is asked for;
// - "tab": it is one of the tabs;
// - "pending": the list does not know it yet (a session started a moment ago; the list is read every 5 s), so the page
//   shows another tab meanwhile and split view waits instead of moving the focus there and back;
// - "gone": the list knows it but it is not a tab (dismissed here or in another window, or not an agent session):
//   settled, so split view realigns to the tab shown now, and the address is pointed there too.
// A dismissed tab is still in `sessions`, which is why it is never "pending".
export type WantedStanding = "none" | "tab" | "pending" | "gone";
export function wantedStanding(wanted: string, tabs: readonly Pane[], sessions: readonly Pane[]): WantedStanding {
  if (!wanted) return "none";
  if (tabs.some((tab) => tab.id === wanted)) return "tab";
  return sessions.some((session) => session.id === wanted) ? "gone" : "pending";
}

// While the tab asked for is pending, split view keeps the pair it had on screen: the focused pane's session stands in
// as the selected tab (the side panel shows it), as long as both panes' sessions are listed. Otherwise the page's own
// choice (`fallbackId`) stays.
export function holdSelected(state: SplitState, tabs: readonly Pane[], fallbackId: string): string {
  if (!state.on || !state.panes) return fallbackId;
  const listed = state.panes.every((id) => tabs.some((tab) => tab.id === id));
  return listed ? state.panes[state.focus] : fallbackId;
}

// A new width from the divider; the very same state when it does not change.
export function withRatio(state: SplitState, ratio: number): SplitState {
  const next = clampSplit(ratio);
  return next === state.ratio ? state : { ...state, ratio: next };
}

// What this window kept (sessionStorage). Anything broken, of another version, or holding one session twice is off,
// with the middle width unless a good width was kept.
export function parseSplitState(raw: string | null): SplitState {
  if (!raw) return splitOff(SPLIT_DEFAULT);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return splitOff(SPLIT_DEFAULT);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return splitOff(SPLIT_DEFAULT);
  const stored = value as { v?: unknown; on?: unknown; panes?: unknown; focus?: unknown; ratio?: unknown };
  if (stored.v !== 1) return splitOff(SPLIT_DEFAULT);
  const ratio = clampSplit(typeof stored.ratio === "number" ? stored.ratio : SPLIT_DEFAULT);
  const ids: unknown[] = Array.isArray(stored.panes) ? stored.panes : [];
  const [a, b] = ids;
  const panes: [string, string] | null =
    ids.length === 2 && typeof a === "string" && typeof b === "string" && a !== "" && b !== "" && a !== b ? [a, b] : null;
  if (stored.on !== true || !panes) return splitOff(ratio);
  return { on: true, panes, focus: stored.focus === 1 ? 1 : 0, ratio };
}

export function serializeSplitState(state: SplitState): string {
  return JSON.stringify({ v: 1, on: state.on, panes: state.on ? state.panes : null, focus: state.focus, ratio: clampSplit(state.ratio) });
}

// The terminals that stay on screen after their session ended (SP3: a session that ends while it is on screen keeps
// its last screen until it leaves the screen). `shown` is what the panes show now: an open session's terminal key is
// added, a key no pane shows any more is dropped, and an ended one stays only if it was there already. The very same
// set comes back when nothing changes.
export function nextLiveShown(prev: ReadonlySet<string>, shown: ReadonlyArray<{ key: string; status: string }>): ReadonlySet<string> {
  const next = new Set<string>();
  for (const pane of shown) if (pane.status !== "exited" || prev.has(pane.key)) next.add(pane.key);
  if (next.size === prev.size && [...next].every((key) => prev.has(key))) return prev;
  return next;
}

// The divider: where the pointer is, as the left pane's share of the panes' box (null for a box with no room), and
// the keys (ArrowLeft and ArrowRight move it 2 %, Home puts it back in the middle; any other key is not the divider's).
// The divider's own width (SPLIT_GAP_PX, the grip and its margins in sessions.css) belongs to neither pane: the two
// panes share the box minus the gap, and the grip's centre is half a gap inside the first pane's edge, so with `gap`
// given the grip stays under the pointer and 28 % is exactly 28 % of the panes. Without it, the plain share.
export const SPLIT_GAP_PX = 20;
export function ratioFromPointer(clientX: number, left: number, width: number, gap = 0): number | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(gap) || !(width - gap > 0)) return null;
  return clampSplit((clientX - left - gap / 2) / (width - gap));
}
export function dividerKeyRatio(key: string, ratio: number): number | null {
  if (key === "ArrowLeft") return clampSplit(ratio - SPLIT_KEY_STEP);
  if (key === "ArrowRight") return clampSplit(ratio + SPLIT_KEY_STEP);
  if (key === "Home") return SPLIT_DEFAULT;
  return null;
}

// The words (Task U6; the owner reviews them at E1): the button's name and tooltip, the divider's name, and a pane
// header's name. The key is named only where the page receives it (the desktop app), like the New session button.
export const SPLIT_LABEL = "Split view";
export const SPLIT_NEEDS_TWO = "Split view needs two sessions.";
export const SPLIT_DIVIDER_LABEL = "Resize the two terminals";
const SPLIT_HINT = "Show two sessions side by side";
export function splitKeys(isMac: boolean): string {
  return isMac ? "⌘\\" : "Ctrl+Shift+\\";
}
export function splitButtonHint({ isMac, desktop, possible }: { isMac: boolean; desktop: boolean; possible: boolean }): string {
  if (!possible) return SPLIT_NEEDS_TWO;
  return desktop ? `${SPLIT_HINT} (${splitKeys(isMac)})` : SPLIT_HINT;
}
export function paneHeadLabel(title: string): string {
  return `${title}, show its details`;
}
