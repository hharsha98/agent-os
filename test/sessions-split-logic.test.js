// Split view on the Sessions page (spec SP4, Split; Task U6): src/ui/splitShared.ts (the panes, the divider, the
// per-window state, the button's words) and the ⌘\ key in src/ui/sessionsShared.ts. Node strips the TypeScript
// types itself (decision P14), so the .ts files are imported directly; both keep only `import type` imports. No
// server, no browser: the page itself is checked by the split probe of the UI audit
// (.superpowers/ui-audit/probes/split.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as pageShared from "../src/ui/sessionsPageShared.ts";
import * as ss from "../src/ui/sessionsShared.ts";
import * as split from "../src/ui/splitShared.ts";

const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
// A tab as split view reads it (the page's tabs are whole SessionSummary objects; these two fields are enough).
const s = (id, status = "live") => ({ id, status });
const key = (over) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
const MAC = { isMac: true, desktop: true };
const MAC_BROWSER = { isMac: true, desktop: false };
const PC = { isMac: false, desktop: true };
const PC_BROWSER = { isMac: false, desktop: false };
const OFF = { on: false, panes: null, focus: 0, ratio: 0.5 };

test("SPLIT_KEY and clampSplit: the left pane keeps 28 % to 72 % of the width, the middle to start", () => {
  assert.equal(split.SPLIT_KEY, "agentos.sessions.split.v1");
  assert.equal(split.clampSplit(0.5), 0.5);
  assert.equal(split.clampSplit(0.1), 0.28);
  assert.equal(split.clampSplit(0.95), 0.72);
  assert.equal(split.clampSplit(0.30000000000000004), 0.3, "rounded, so the arrow keys never pile up tiny errors");
  assert.equal(split.clampSplit(Number.NaN), 0.5);
  assert.equal(split.clampSplit(Infinity), 0.5);
  assert.equal(split.clampSplit("0.4"), 0.5, "not a number (a broken stored value): the middle");
  assert.deepEqual(split.SPLIT_OFF, OFF);
});

test("secondPaneChoices and canSplit: every other tab, open ones first; split view needs two tabs", () => {
  const tabs = [s("a"), s("e", "exited"), s("b", "idle"), s("c", "waiting")];
  assert.deepEqual(split.secondPaneChoices(tabs, "a").map((t) => t.id), ["b", "c", "e"]);
  assert.deepEqual(split.secondPaneChoices(tabs, "b").map((t) => t.id), ["a", "c", "e"]);
  assert.deepEqual(split.secondPaneChoices([s("a")], "a"), []);
  assert.equal(split.canSplit([s("a")]), false);
  assert.equal(split.canSplit([]), false);
  assert.equal(split.canSplit([s("a"), s("e", "exited")]), true, "an ended tab can sit in a pane");
});

test("toggleSplit: on puts the selected tab left and the next open tab right; off keeps the width; one tab does nothing", () => {
  const tabs = [s("a"), s("e", "exited"), s("b")];
  const on = split.toggleSplit({ ...OFF, ratio: 0.4 }, tabs, "e");
  assert.deepEqual(on, { on: true, panes: ["e", "a"], focus: 0, ratio: 0.4 }, "the selected tab stays where the keyboard is: the left, focused pane");
  assert.deepEqual(split.toggleSplit(on, tabs, "e"), { on: false, panes: null, focus: 0, ratio: 0.4 }, "off keeps the width for next time");
  const alone = { ...OFF };
  assert.equal(split.toggleSplit(alone, [s("a")], "a"), alone, "one tab: the very same state");
  assert.equal(split.toggleSplit(alone, tabs, "missing"), alone, "no selected tab: the very same state");
});

test("alignSplit: picking the other pane's tab moves the focus only, never the same session in both panes", () => {
  const tabs = [s("a"), s("b"), s("c")];
  const state = { on: true, panes: ["a", "b"], focus: 0, ratio: 0.5 };
  assert.deepEqual(split.alignSplit(state, tabs, "b"), { on: true, panes: ["a", "b"], focus: 1, ratio: 0.5 });
  assert.deepEqual(split.alignSplit({ ...state, focus: 1 }, tabs, "a"), { on: true, panes: ["a", "b"], focus: 0, ratio: 0.5 });
  // Every way through: whatever is picked, the picked tab is the focused pane and the panes never hold one session twice.
  let current = state;
  for (const pick of ["b", "c", "a", "c", "b", "b", "a", "c"]) {
    current = split.alignSplit(current, tabs, pick);
    assert.equal(current.on, true);
    assert.notEqual(current.panes[0], current.panes[1], `after picking ${pick}`);
    assert.equal(current.panes[current.focus], pick, `the picked tab is the focused pane (${pick})`);
  }
});

test("alignSplit: a tab in neither pane takes the focused pane's place (a click, ⌘1-9, a link, a new session)", () => {
  const tabs = [s("a"), s("b"), s("c")];
  assert.deepEqual(split.alignSplit({ on: true, panes: ["a", "b"], focus: 1, ratio: 0.6 }, tabs, "c"), { on: true, panes: ["a", "c"], focus: 1, ratio: 0.6 });
  assert.deepEqual(split.alignSplit({ on: true, panes: ["a", "b"], focus: 0, ratio: 0.6 }, tabs, "c"), { on: true, panes: ["c", "b"], focus: 0, ratio: 0.6 });
});

test("alignSplit: a pane whose session left the tabs gets the next one; with one tab left split view ends", () => {
  const state = { on: true, panes: ["a", "b"], focus: 0, ratio: 0.4 };
  // b was dismissed: the open c takes its place before the ended e.
  assert.deepEqual(split.alignSplit(state, [s("a"), s("e", "exited"), s("c")], "a"), { on: true, panes: ["a", "c"], focus: 0, ratio: 0.4 });
  // a (the focused pane) was dismissed and the page picked b: b is the focused pane now, and a's place goes to c.
  assert.deepEqual(split.alignSplit(state, [s("b"), s("c")], "b"), { on: true, panes: ["c", "b"], focus: 1, ratio: 0.4 });
  // Only an ended tab is left next to a: it is still a session, so it takes the place.
  assert.deepEqual(split.alignSplit(state, [s("a"), s("e", "exited")], "a"), { on: true, panes: ["a", "e"], focus: 0, ratio: 0.4 });
  assert.deepEqual(split.alignSplit(state, [s("a")], "a"), { on: false, panes: null, focus: 0, ratio: 0.4 }, "one tab: split view ends");
  assert.deepEqual(split.alignSplit(state, [], ""), { on: false, panes: null, focus: 0, ratio: 0.4 }, "no tabs");
  const off = { on: false, panes: null, focus: 0, ratio: 0.4 };
  assert.equal(split.alignSplit(off, [s("a"), s("b")], "a"), off, "off stays off, the very same state");
});

test("alignSplit returns the very same object when nothing changes, and again after its own answer", () => {
  const tabs = [s("a"), s("b"), s("c")];
  const state = { on: true, panes: ["a", "b"], focus: 1, ratio: 0.5 };
  assert.equal(split.alignSplit(state, tabs, "b"), state);
  for (const pick of ["a", "b", "c"]) {
    const once = split.alignSplit(state, tabs, pick);
    assert.equal(split.alignSplit(once, tabs, pick), once, `stable after picking ${pick}`);
  }
  const broken = { on: true, panes: null, focus: 0, ratio: 0.5 };
  const fixed = split.alignSplit(broken, tabs, "a");
  assert.deepEqual(fixed, OFF);
  assert.equal(split.alignSplit(fixed, tabs, "a"), fixed);
});

test("split view is kept per window: parse and serialize, and anything broken reads as off", () => {
  const on = { on: true, panes: ["a", "b"], focus: 1, ratio: 0.4 };
  assert.equal(split.serializeSplitState(on), '{"v":1,"on":true,"panes":["a","b"],"focus":1,"ratio":0.4}');
  assert.deepEqual(split.parseSplitState(split.serializeSplitState(on)), on);
  const offWide = { on: false, panes: null, focus: 0, ratio: 0.66 };
  assert.deepEqual(split.parseSplitState(split.serializeSplitState(offWide)), offWide, "off keeps its width");
  for (const raw of [null, "", "{", "null", "[]", '"on"', '{"v":2,"on":true,"panes":["a","b"]}', '{"on":true,"panes":["a","b"]}']) {
    assert.deepEqual(split.parseSplitState(raw), OFF, String(raw));
  }
  assert.deepEqual(split.parseSplitState('{"v":1,"on":true,"panes":["a","a"],"focus":0,"ratio":0.5}'), OFF, "the same session twice is never restored");
  assert.deepEqual(split.parseSplitState('{"v":1,"on":true,"panes":["a"],"focus":0,"ratio":0.5}'), OFF);
  assert.deepEqual(split.parseSplitState('{"v":1,"on":true,"panes":["a",""],"focus":0,"ratio":0.5}'), OFF);
  assert.deepEqual(split.parseSplitState('{"v":1,"on":true,"panes":["a","b"],"focus":7,"ratio":3}'), { on: true, panes: ["a", "b"], focus: 0, ratio: 0.72 });
});

test("nextLiveShown: an ended session keeps its last screen while a pane shows it", () => {
  const empty = new Set();
  const one = split.nextLiveShown(empty, [{ key: "a:0", status: "live" }]);
  assert.deepEqual([...one], ["a:0"]);
  assert.equal(split.nextLiveShown(one, [{ key: "a:0", status: "exited" }]), one, "it ended on screen: kept, the very same set");
  const both = split.nextLiveShown(one, [{ key: "a:0", status: "exited" }, { key: "b:0", status: "idle" }]);
  assert.deepEqual([...both].sort(), ["a:0", "b:0"], "split view on: the ended pane keeps its screen");
  assert.deepEqual([...split.nextLiveShown(both, [{ key: "b:0", status: "idle" }])], ["b:0"], "it left the screen: gone");
  assert.deepEqual([...split.nextLiveShown(empty, [{ key: "e:0", status: "exited" }])], [], "a pane opened on an ended session shows the ended view");
});

test("the divider: the pointer and the keys give the left pane's share, inside 28 % to 72 %", () => {
  assert.equal(split.ratioFromPointer(400, 100, 1000), 0.3);
  assert.equal(split.ratioFromPointer(110, 100, 1000), 0.28);
  assert.equal(split.ratioFromPointer(1090, 100, 1000), 0.72);
  assert.equal(split.ratioFromPointer(400, 100, 0), null, "a box with no width (hidden)");
  assert.equal(split.dividerKeyRatio("ArrowRight", 0.5), 0.52);
  assert.equal(split.dividerKeyRatio("ArrowLeft", 0.5), 0.48);
  assert.equal(split.dividerKeyRatio("ArrowLeft", 0.29), 0.28);
  assert.equal(split.dividerKeyRatio("ArrowRight", 0.71), 0.72);
  assert.equal(split.dividerKeyRatio("Home", 0.66), 0.5);
  assert.equal(split.dividerKeyRatio("Enter", 0.66), null);
  assert.equal(split.withRatio({ ...OFF }, 0.9).ratio, 0.72);
  const state = { on: true, panes: ["a", "b"], focus: 0, ratio: 0.4 };
  assert.equal(split.withRatio(state, 0.4), state, "the same width: the very same state");
  assert.equal(split.SPLIT_DIVIDER_LABEL, "Resize the two terminals");
});

test("⌘\\ (Ctrl+Shift+\\ elsewhere) toggles split view in the desktop app; Ctrl+\\ and browser mode leave the key alone", () => {
  assert.deepEqual(ss.isAppShortcut(key({ key: "\\", code: "Backslash", metaKey: true }), MAC), { action: "split" });
  assert.deepEqual(ss.isAppShortcut(key({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true }), PC), { action: "split" }, "Shift turns \\ into | but the key's place is still Backslash");
  assert.equal(ss.isAppShortcut(key({ key: "\\", code: "Backslash", ctrlKey: true }), PC), null, "Ctrl+\\ is the terminal's quit key: it reaches the agent");
  assert.equal(ss.isAppShortcut(key({ key: "\\", code: "Backslash", ctrlKey: true }), MAC), null);
  assert.equal(ss.isAppShortcut(key({ key: "|", code: "Backslash", metaKey: true, shiftKey: true }), MAC), null, "⌘⇧\\ is not Agent OS's");
  assert.equal(ss.isAppShortcut(key({ key: "\\", code: "Backslash", metaKey: true, altKey: true }), MAC), null);
  assert.equal(ss.isAppShortcut(key({ key: "\\", code: "Backslash", metaKey: true }), MAC_BROWSER), null, "browser mode: the Split view button instead");
  assert.equal(ss.isAppShortcut(key({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true }), PC_BROWSER), null);
});

test("the ⌘\\ hint and the Split view button's words: the same keys as the panel footer", () => {
  assert.deepEqual(ss.shortcutHints(MAC), [{ keys: "⌘T", word: "new" }, { keys: "⌘1-9", word: "switch" }, { keys: "⌘\\", word: "split" }]);
  assert.deepEqual(ss.shortcutHints(PC).at(-1), { keys: "Ctrl+Shift+\\", word: "split" });
  assert.equal(split.splitKeys(true), ss.shortcutHints(MAC).at(-1).keys, "splitShared keeps a copy of the keys; this keeps them equal");
  assert.equal(split.splitKeys(false), ss.shortcutHints(PC).at(-1).keys);
  assert.deepEqual(ss.shortcutHints(MAC_BROWSER), [], "browser mode: no hints at all");
  assert.equal(split.SPLIT_LABEL, "Split view");
  assert.equal(split.splitButtonHint({ isMac: true, desktop: true, possible: true }), "Show two sessions side by side (⌘\\)");
  assert.equal(split.splitButtonHint({ isMac: false, desktop: true, possible: true }), "Show two sessions side by side (Ctrl+Shift+\\)");
  assert.equal(split.splitButtonHint({ isMac: true, desktop: false, possible: true }), "Show two sessions side by side", "a browser tab names no key");
  assert.equal(split.splitButtonHint({ isMac: true, desktop: true, possible: false }), "Split view needs two sessions.");
  assert.equal(split.paneHeadLabel("Codex · beta"), "Codex · beta, show its details");
});

test("the page wires split view: per-window storage, the ⌘\\ key, one terminal per pane, the panel on the focused pane", () => {
  const page = source("pages/SessionsPage.tsx");
  assert.ok(page.includes("window.sessionStorage.getItem(SPLIT_KEY)"), "split view is read from this window's sessionStorage");
  assert.ok(page.includes("window.sessionStorage.setItem(SPLIT_KEY, serializeSplitState(state))"), "and kept there");
  assert.doesNotMatch(page, /localStorage[^\n]*SPLIT_KEY/, "never shared between windows through localStorage");
  assert.ok(page.includes('if (shortcut.action === "split") {'), "the window key handler toggles split view");
  assert.ok(page.includes("alignSplit(split, tabs, selectedId)"), "the panes follow the tabs and the selected tab");
  assert.ok(page.includes("data-session={session.id}"), "each pane names its session");
  assert.equal((page.match(/<SessionTerminal\b/g) || []).length, 1, "one SessionTerminal element, rendered once per pane");
  assert.ok(page.includes("session={selected}"), "the side panel shows the selected tab, which is the focused pane");
  assert.ok(source("ui/components/SessionTabs.tsx").includes('" is-in-split"'), "the other pane's tab is marked");
  assert.doesNotMatch(source("ui/splitShared.ts"), /^import (?!type )/m, "splitShared.ts keeps only `import type` imports");
});

// ---- Fix round 1 (review I-1, I-2, I-3, M-1, M-3, M-6) ------------------------------------------------------------

test("wantedStanding: the address's session is a tab, pending (the list has not shown it yet), or gone (listed, put away)", () => {
  const tabs = [s("a"), s("c")];
  const sessions = [s("a"), s("b", "exited"), s("c")]; // b was dismissed: still in the list, no longer a tab
  assert.equal(split.wantedStanding("", tabs, sessions), "none");
  assert.equal(split.wantedStanding("a", tabs, sessions), "tab");
  assert.equal(split.wantedStanding("b", tabs, sessions), "gone", "a dismissed tab is settled, not pending");
  assert.equal(split.wantedStanding("fresh", tabs, sessions), "pending", "a session started a moment ago");
});

test("I-1: dismissing the focused pane's ended session gives its place to the next tab, and split view stays true", () => {
  const state = { on: true, panes: ["a", "b"], focus: 1, ratio: 0.4 };
  const tabs = [s("a"), s("c")]; // b was dismissed with its x: the tab bar hides it at once
  const sessions = [s("a"), s("b", "exited"), s("c")];
  const standing = split.wantedStanding("b", tabs, sessions); // the address still names b
  assert.equal(standing, "gone");
  const selectedId = pageShared.pickSelected(tabs, "b");
  assert.equal(selectedId, "a", "the page falls back to the first open tab");
  const aligned = standing === "pending" ? state : split.alignSplit(state, tabs, selectedId);
  assert.deepEqual(aligned, { on: true, panes: ["a", "c"], focus: 0, ratio: 0.4 }, "the pane whose session left gets the next tab");
  // Split view off, then another tab picked: it stays off (the old bug brought it back by itself).
  const off = split.toggleSplit(aligned, tabs, selectedId);
  assert.equal(off.on, false);
  assert.equal(split.alignSplit(off, tabs, "c"), off);
  // No other tab to take the place: split view ends cleanly.
  assert.deepEqual(split.alignSplit(state, [s("a")], "a"), { on: false, panes: null, focus: 0, ratio: 0.4 });
  // A session not listed yet (a start a moment ago) is the only case that waits.
  assert.equal(split.wantedStanding("fresh", tabs, sessions), "pending");
});

test("M-1 holdSelected: while the tab asked for is pending, the stored pair stays and its focused pane stands in", () => {
  const tabs = [s("x"), s("a"), s("b")];
  const state = { on: true, panes: ["a", "b"], focus: 1, ratio: 0.5 };
  assert.equal(split.holdSelected(state, tabs, "x"), "b");
  assert.equal(split.holdSelected({ ...state, focus: 0 }, tabs, "x"), "a");
  assert.equal(split.holdSelected({ ...state, on: false, panes: null }, tabs, "x"), "x", "split view off: the page's own choice");
  assert.equal(split.holdSelected(state, [s("x"), s("a")], "x"), "x", "a pane's session is not listed: the page's own choice");
});

test("M-3 the divider's own width is not part of either pane: the grip stays under the pointer, the minimum is exact", () => {
  assert.equal(split.SPLIT_GAP_PX, 20, "16 px grip + 2 x 2 px margin (sessions.css)");
  // A 1000 px box at x = 100: the panes share 980 px, and the grip's centre is 10 px inside the first pane's edge.
  assert.equal(split.ratioFromPointer(404, 100, 1000, 20), 0.3);
  assert.equal(split.ratioFromPointer(110 + 0.5 * 980, 100, 1000, 20), 0.5);
  assert.equal(split.ratioFromPointer(105, 100, 1000, 20), 0.28);
  assert.equal(split.ratioFromPointer(1095, 100, 1000, 20), 0.72);
  assert.equal(split.ratioFromPointer(400, 100, 20, 20), null, "no room for two panes");
  assert.equal(split.ratioFromPointer(400, 100, 1000), 0.3, "without a gap it is the plain share (as before)");
});

test("the fix round is wired: a pane sizes itself, the divider is first for Tab, a pane is entered by keyboard, writes wait for the drag end", () => {
  const page = source("pages/SessionsPage.tsx");
  assert.ok(page.includes("sizesItself={splitOn}"), "the page sets sizesItself in split view only");
  assert.ok(page.includes("wantedStanding(wanted, tabs, sessions)"), "only a tab the list has not shown yet holds split view back");
  assert.ok(page.includes("splitOn && slot === 0"), "the divider is the first child of the panes, so Tab reaches it before any terminal");
  assert.ok(page.includes("onEnter={() => enterPane(session.id)}"), "Enter or Space on a pane header gives the keyboard to that pane's terminal");
  assert.ok(page.includes("onEnterSelected={splitOn ? enterPane : undefined}"), "and so does Enter or Space on the selected tab, in split view");
  assert.ok(page.includes("if (!dragging) writeSplit(split)"), "split view is stored when a drag ends, not on every pointer move");
  const terminal = source("ui/components/SessionTerminal.tsx");
  assert.ok(terminal.includes("sizesItself?: boolean"), "the terminal has the sizesItself prop");
  assert.match(terminal, /latest\.current\.sizesItself !== true \|\| !document\.hasFocus\(\)\) return;\s*takeKeys\(\);/, "and takes the writer role (not the keyboard focus) only while the window has the focus");
  const css = source("ui/sessions.css");
  assert.match(css, /\.os-sess-split__divider\s*\{[^}]*\n\s*order:\s*2;/, "the divider is placed between the panes with CSS order");
  const divider = source("ui/components/SplitDivider.tsx");
  assert.match(divider, /try \{[^}]*setPointerCapture/, "setPointerCapture is guarded");
  assert.ok(divider.includes("onDragChange"), "the page hears when a drag starts and ends");
});
