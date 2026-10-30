// The Sessions page's pure logic (src/ui/sessionsPageShared.ts) and the New session dialog's
// (src/ui/newSession.ts): tab order and selection, the ended tab's words, the Live meter rows, the
// New session button's hint, the terminal's own settings, and the words for a start, stop, resume or
// dismiss that went wrong. (Titles, status words, the Stop and Resume words and the app shortcuts are
// Task U1's, tested in test/sessions-shared.test.js.) Node strips the TypeScript types itself (decision P14), so the .ts files are imported
// directly; both files keep only `import type` imports. No server, no browser: the page itself is
// checked by the Sessions probe of the UI audit (.superpowers/ui-audit/probes/sessions.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as dialog from "../src/ui/newSession.ts";
import * as page from "../src/ui/sessionsPageShared.ts";

const NOW = Date.parse("2026-10-14T15:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const session = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", kind: "agent", agentId: "claude", agentLabel: "Claude Code",
  folder: "/Users/you/projects/my-app", folderName: "my-app", folderShown: true, branch: null,
  status: "live", stateSince: iso(700_000), startedAt: iso(760_000), endedAt: null, exitCode: null, signal: null, endedBy: null,
  dismissed: false, brain: { kind: "plan", label: "Plan" }, resume: { available: false, reason: null, fallback: false },
  alerts: "basic", recordingBytes: 0, ...over
});
// What src/api.ts throws for a refusal: name "ApiError", message = the code, detail = the server's sentence.
const apiError = (code, detail = "") => Object.assign(new Error(code), { name: "ApiError", detail, status: 400 });
const LOOK_ONLY = "Safety is on Look only, so no session can start. Allow running agents in Safety, then try again.";

test("tabs keep their place: known ids stay in order, new ones join at the end in the list's order", () => {
  // The server lists sessions by their first start (meta.json createdAt), which a resume never changes.
  const a = session({ id: "a", startedAt: iso(30_000) });
  const b = session({ id: "b", startedAt: iso(60_000) });
  const c = session({ id: "c", startedAt: iso(10_000) });
  assert.deepEqual(page.stableOrder([], [a, b]), ["a", "b"], "a page opened fresh shows the list's order, not the latest start");
  assert.deepEqual(page.stableOrder(["b", "a"], [a, b, c]), ["b", "a", "c"]);
  // Resume keeps the session id: a resumed tab keeps its place even with a newer start time.
  assert.deepEqual(page.stableOrder(["b", "a", "c"], [a, session({ id: "b", startedAt: iso(1000) }), c]), ["b", "a", "c"]);
  assert.deepEqual(page.stableOrder(["b", "a", "c"], [a, c]), ["a", "c"]);
});

test("tabs: open sessions and ended ones not dismissed; an open session always shows; update sessions never", () => {
  const live = session({ id: "live" });
  const ended = session({ id: "ended", status: "exited", endedAt: iso(5000) });
  const gone = session({ id: "gone", status: "exited", dismissed: true });
  const back = session({ id: "back", status: "starting", dismissed: true });
  const upd = session({ id: "upd", kind: "update" });
  const order = ["live", "ended", "gone", "back", "upd"];
  assert.deepEqual(page.visibleTabs([live, ended, gone, back, upd], order).map((s) => s.id), ["live", "ended", "back"]);
  assert.deepEqual(page.visibleTabs([live, ended], ["live", "ended"], new Set(["ended"])).map((s) => s.id), ["live"], "dismissed here, before the list says so");
});

test("the selected tab: the one asked for, else the first open one, else the first", () => {
  const tabs = [session({ id: "e1", status: "exited" }), session({ id: "l1" }), session({ id: "l2", status: "idle" })];
  assert.equal(page.pickSelected(tabs, "l2"), "l2");
  assert.equal(page.pickSelected(tabs, "missing"), "l1");
  assert.equal(page.pickSelected(tabs, ""), "l1");
  assert.equal(page.pickSelected([session({ id: "e1", status: "exited" })], ""), "e1");
  assert.equal(page.pickSelected([], "x"), "");
});

test("the terminal takes the keyboard only for the tab asked for: while that tab is not in the list yet, no other terminal does", () => {
  const take = (over) => page.terminalTakesKeys({ focusTerminal: true, wanted: "new", selectedId: "new", wantedListed: true, ...over });
  // Nothing asked for the keyboard: no terminal takes it, whatever else is true.
  assert.equal(take({ focusTerminal: false }), false);
  assert.equal(take({ focusTerminal: false, wanted: "", selectedId: "old", wantedListed: false }), false);
  // Start session: the new tab is asked for but the 5 s poll has not brought it yet, so the page shows the first open
  // tab. That old terminal must not take the keys (typing would go into the wrong agent).
  assert.equal(take({ selectedId: "old", wantedListed: false }), false, "the new session is pending: the tab shown instead does not take the keys");
  // The tab arrived (it is selected and listed): its terminal takes them, as before.
  assert.equal(take({}), true);
  // A tab picked from the keyboard (⌘1-9): asked for and listed.
  assert.equal(take({ wanted: "old", selectedId: "old" }), true);
  // Nothing asked for in the address (a page opened with no ?session=): the shown tab is the one.
  assert.equal(take({ wanted: "", selectedId: "old", wantedListed: false }), true);
  // If the pending tab is somehow the one shown, it is the one that takes them.
  assert.equal(take({ selectedId: "new", wantedListed: false }), true);
});

test("an ended tab says so; Dismiss names the tab; the waiting and held markers (SP4) are words", () => {
  assert.equal(page.tabLabel("Claude Code · my-app", "exited", 4096), "Claude Code · my-app · Ended · open recording");
  assert.equal(page.tabLabel("Claude Code · my-app", "live", 4096), "Claude Code · my-app");
  assert.equal(page.tabLabel("Claude Code · my-app", "live", 0), "Claude Code · my-app", "an open session is never labelled ended");
  assert.equal(page.dismissLabel("Claude Code · my-app"), "Dismiss Claude Code · my-app");
  assert.equal(page.tabMarker("live"), null);
  assert.equal(page.tabMarker("exited"), null);
  assert.deepEqual(page.tabMarker("waiting"), { kind: "waiting", word: "Waiting for you" });
  assert.deepEqual(page.tabMarker("held"), { kind: "held", word: "Plan ran out" });
});

test("an ended tab whose recording was removed does not offer to open it", () => {
  // 0 bytes: the 1 GB cap or a delete took it, so Runs has no row (the panel's line says "Its recording was removed.").
  assert.equal(page.recordingKept(0), false);
  assert.equal(page.recordingKept(1), true);
  assert.equal(page.recordingKept(250_000), true);
  assert.equal(page.tabLabel("Claude Code · my-app", "exited", 0), "Claude Code · my-app · Ended");
  assert.doesNotMatch(page.tabLabel("Codex · notes", "exited", 0), /recording/);
});

test("an ended tab names its keyboard way to dismiss (the x beside it is for the mouse only)", () => {
  assert.equal(page.DISMISS_KEY_HINT, "Press Delete to dismiss");
});

test("Delete, and the Mac key labelled delete (Backspace), dismiss an ended tab; no other key and no open tab does", () => {
  assert.equal(page.isDismissKey("Delete", "exited"), true);
  assert.equal(page.isDismissKey("Backspace", "exited"), true, "the Mac delete key sends Backspace");
  for (const open of ["live", "starting", "idle", "waiting", "held"]) {
    assert.equal(page.isDismissKey("Delete", open), false, `${open}: a session ends with Stop`);
    assert.equal(page.isDismissKey("Backspace", open), false, open);
  }
  for (const other of ["Enter", " ", "ArrowRight", "Escape", "d", "x", "Home"]) {
    assert.equal(page.isDismissKey(other, "exited"), false, other);
  }
});

test("tabs dismissed here are forgotten once the list shows them running again; after that the server's flag decides", () => {
  const ended = session({ id: "a", status: "exited" });
  const hidden = new Set(["a", "b"]);
  // Still ended (or not in the list yet): still hidden here, and the very same set comes back (no new render).
  assert.equal(page.pruneHidden(hidden, [ended, session({ id: "b", status: "exited" })]), hidden);
  assert.equal(page.pruneHidden(hidden, []), hidden);
  assert.equal(page.pruneHidden(new Set(), [session()]).size, 0);
  // Resumed in another window: no longer hidden here, whatever its status becomes next.
  const resumed = page.pruneHidden(hidden, [session({ id: "a", status: "starting" }), session({ id: "b", status: "exited" })]);
  assert.deepEqual([...resumed], ["b"]);
  assert.deepEqual([...hidden], ["a", "b"], "the set it was given is never changed");
  // It ends again with an error: not hidden here any more, so visibleTabs follows the server's dismissed flag.
  const endedAgain = [session({ id: "a", status: "exited", dismissed: false })];
  assert.deepEqual(page.visibleTabs(endedAgain, ["a"], resumed).map((s) => s.id), ["a"]);
  assert.deepEqual(page.visibleTabs([session({ id: "a", status: "exited", dismissed: true })], ["a"], resumed).map((s) => s.id), []);
});

test("a Stop or Resume question goes when its session leaves the tabs, unless its request is still on its way", () => {
  const asking = (id, busy = false) => ({ session: session({ id }), busy, error: "", toSafety: false });
  const tabs = [session({ id: "a" })];
  const here = asking("a");
  assert.equal(page.askingWhileTab(here, tabs), here, "its session is still a tab: the very same question");
  assert.equal(page.askingWhileTab(asking("gone"), tabs), null, "dismissed elsewhere: the question goes");
  assert.equal(page.askingWhileTab(asking("a"), []), null, "no tab left");
  const busy = asking("gone", true);
  assert.equal(page.askingWhileTab(busy, tabs), busy, "while its request is on its way the request decides");
  assert.equal(page.askingWhileTab(null, tabs), null);
});

test("a failed Dismiss's words go once that tab is gone or running again", () => {
  const problem = { id: "a", text: "Agent OS hasn't answered. If the tab is still here after the next update, press Dismiss again." };
  const endedTab = { id: "a", status: "exited" };
  assert.equal(page.dismissErrorWhileEnded(problem, [endedTab]), problem, "the tab is still here and ended: the words are still true");
  assert.equal(page.dismissErrorWhileEnded(problem, []), null, "the dismiss did happen: the tab is gone");
  assert.equal(page.dismissErrorWhileEnded(problem, [{ id: "b", status: "live" }]), null, "another session's tab is not this one");
  assert.equal(page.dismissErrorWhileEnded(problem, [{ id: "a", status: "starting" }]), null, "resumed elsewhere: nothing to dismiss");
  assert.equal(page.dismissErrorWhileEnded(null, [endedTab]), null);
});

test("an answer that is not what it should be is an answer that could not be read", () => {
  // A 2xx answer to a start must be a session (an id); to a Stop, an object whose note is words or null (S7).
  assert.equal(dialog.createdSessionId({ id: "11111111-1111-4111-8111-111111111111", status: "starting" }), "11111111-1111-4111-8111-111111111111");
  for (const bad of [null, undefined, "ok", 7, [], {}, { id: "" }, { id: 7 }, { id: null }]) {
    assert.equal(dialog.createdSessionId(bad), null, JSON.stringify(bad));
  }
  assert.equal(page.isStopAnswer({ ...session({ status: "exited" }), note: null }), true);
  assert.equal(page.isStopAnswer({ ...session({ status: "exited" }), note: "Words." }), true);
  assert.equal(page.isStopAnswer(session({ status: "exited" })), true, "a missing note reads as none");
  for (const bad of [null, undefined, "ok", 7, { note: 7 }, { note: {} }]) {
    assert.equal(page.isStopAnswer(bad), false, JSON.stringify(bad));
  }
});

test("a resumed session gets a fresh terminal: its generation goes up when it comes back from ended", () => {
  let gens = page.nextGenerations({}, [session({ id: "s", status: "live" })]);
  assert.equal(page.terminalKey("s", gens), "s:0");
  gens = page.nextGenerations(gens, [session({ id: "s", status: "exited" })]);
  assert.equal(page.terminalKey("s", gens), "s:0", "ending keeps the same terminal, so its last screen stays");
  gens = page.nextGenerations(gens, [session({ id: "s", status: "starting" })]);
  assert.equal(page.terminalKey("s", gens), "s:1");
  gens = page.nextGenerations(gens, [session({ id: "s", status: "live" })]);
  assert.equal(page.terminalKey("s", gens), "s:1");
  assert.equal(page.terminalKey("other", gens), "other:0");
});

test("Live meter: every row, and null (shown as —) for each one whose source arrives later", () => {
  assert.equal(page.durationWords(iso(40_000), NOW), "40 s");
  assert.equal(page.durationWords(iso(760_000), NOW), "12 m 40 s");
  assert.equal(page.durationWords(iso(65 * 60_000), NOW), "1 h 05 m");
  assert.equal(page.durationWords(null, NOW), "—");
  assert.equal(page.durationWords(iso(-5000), NOW), "—");
  assert.deepEqual(page.meterRows(session(), NOW).map((r) => [r.label, r.value, r.dim ?? null]), [
    ["Brain", "Plan", "your subscription"],
    ["Model", null, null],
    ["Running for", "12 m 40 s", null],
    ["Context used", null, null],
    ["Plan used", null, "5-hour limit"]
  ]);
  const openrouter = page.meterRows(session({ brain: { kind: "openrouter", label: "OpenRouter" } }), NOW);
  assert.deepEqual(openrouter.map((r) => r.label), ["Brain", "Model", "Running for", "Context used", "Plan used", "Cost so far"]);
  assert.equal(openrouter[0].dim, "pay per use");
  assert.equal(page.meterRows(session({ brain: { kind: "local", label: "Local" } }), NOW)[0].dim, "on this computer");
  const none = page.meterRows(session({ agentId: "hermes", brain: null }), NOW);
  assert.deepEqual(none.map((r) => [r.label, r.value]), [["Brain", null], ["Model", null], ["Running for", "12 m 40 s"], ["Context used", null]]);
  const ended = page.meterRows(session({ status: "exited", endedAt: iso(160_000) }), NOW);
  assert.deepEqual(ended[2], { id: "time", label: "Ran for", value: "10 m 00 s" });
  assert.equal(page.meterRows(session({ status: "exited", endedAt: null }), NOW)[2].value, null, "an unknown end is —, never a time that keeps growing");
});

test("the panel's folder and the OpenClaw stop note", () => {
  assert.equal(page.panelFolder(session()), "my-app");
  assert.equal(page.panelFolder(session({ agentId: "openclaw", folderShown: false, folderName: "you" })), "Set by OpenClaw");
  assert.equal(page.OPENCLAW_STOP_NOTE, "Stopped the terminal. OpenClaw may still be finishing its last step.");
  assert.equal(page.stopResultNote(session({ agentId: "openclaw", status: "exited", endedBy: "stop" })), page.OPENCLAW_STOP_NOTE);
  assert.equal(page.stopResultNote(session({ status: "exited", endedBy: "stop" })), null);
  assert.equal(page.stopResultNote(session({ agentId: "openclaw", status: "exited", endedBy: "quit" })), null);
  // Right after a Stop from this page, the server's own note wins, null included; it lasts while that ended run is on show.
  const openclawEnded = session({ agentId: "openclaw", status: "exited", endedBy: "stop" });
  assert.equal(page.panelStopNote(openclawEnded, "s:0", { key: "s:0", note: null }), null, "the server said nothing is left running");
  assert.equal(page.panelStopNote(session({ status: "exited", endedBy: "stop" }), "s:0", { key: "s:0", note: "Server words." }), "Server words.");
  assert.equal(page.panelStopNote(openclawEnded, "s:0", null), page.OPENCLAW_STOP_NOTE, "an ended tab opened later: the session's own rule");
  assert.equal(page.panelStopNote(openclawEnded, "s:1", { key: "s:0", note: null }), page.OPENCLAW_STOP_NOTE, "a note from an earlier run does not apply");
  assert.equal(page.panelStopNote(session({ agentId: "openclaw" }), "s:0", { key: "s:0", note: page.OPENCLAW_STOP_NOTE }), null, "the list does not say ended yet, or it runs again");
});

test("the New session button names its shortcut only where the page receives it", () => {
  assert.equal(page.newSessionHint({ isMac: true, desktop: true }), "New session (⌘T)");
  assert.equal(page.newSessionHint({ isMac: false, desktop: true }), "New session (Ctrl+Shift+T)");
  assert.equal(page.newSessionHint({ isMac: true, desktop: false }), "New session", "a browser keeps ⌘T for itself");
});

test("terminal settings kept in this browser: kitty on; DOM drawing on WebKit (macOS, Linux app), WebGL elsewhere; junk is ignored", () => {
  assert.equal(page.TERMINAL_PREFS_KEY, "agentos.terminalPrefs");
  const mac = { platform: "MacIntel", desktop: false };
  const macApp = { platform: "MacIntel", desktop: true };
  const linuxApp = { platform: "Linux x86_64", desktop: true };
  const linuxTab = { platform: "Linux x86_64", desktop: false };
  const windowsApp = { platform: "Win32", desktop: true };
  const windowsTab = { platform: "Win32", desktop: false };
  // Decision Q45: DOM on macOS and in the Linux desktop app (both WebKit), WebGL in the Windows app and in a
  // browser tab on Windows or Linux.
  assert.deepEqual(page.defaultTerminalPrefs(mac), { kittyKeyboard: true, webgl: false });
  assert.deepEqual(page.defaultTerminalPrefs(macApp), { kittyKeyboard: true, webgl: false });
  assert.deepEqual(page.defaultTerminalPrefs(linuxApp), { kittyKeyboard: true, webgl: false });
  assert.deepEqual(page.defaultTerminalPrefs(linuxTab), { kittyKeyboard: true, webgl: true });
  assert.deepEqual(page.defaultTerminalPrefs(windowsApp), { kittyKeyboard: true, webgl: true });
  assert.deepEqual(page.defaultTerminalPrefs(windowsTab), { kittyKeyboard: true, webgl: true });
  assert.deepEqual(page.defaultTerminalPrefs({ platform: "", desktop: false }), { kittyKeyboard: true, webgl: true }, "an unknown computer gets WebGL, with the terminal's own DOM fallback");
  assert.deepEqual(page.parseTerminalPrefs(null, macApp), { kittyKeyboard: true, webgl: false });
  assert.deepEqual(page.parseTerminalPrefs(null, windowsApp), { kittyKeyboard: true, webgl: true });
  assert.deepEqual(page.parseTerminalPrefs("{not json", linuxApp), { kittyKeyboard: true, webgl: false });
  assert.deepEqual(page.parseTerminalPrefs('{"kittyKeyboard":false,"webgl":"yes"}', mac), { kittyKeyboard: false, webgl: false });
  const saved = page.serializeTerminalPrefs({ kittyKeyboard: false, webgl: true });
  assert.deepEqual(page.parseTerminalPrefs(saved, mac), { kittyKeyboard: false, webgl: true }, "a choice the person made wins over the default");
});

test("a stop, resume or dismiss with no answer never claims nothing happened; a refusal uses the server's words", () => {
  // The page passes sessionGotNoAnswer(error) (src/sessionsApi.ts, which owns the rule for what counts as an answer
  // that could not be read) as the third argument; this file keeps only the words. true (also the default) = no
  // answer at all, false = an answer came but could not be read.
  assert.match(page.actionProblem(new Error("Agent OS did not answer in time."), "stop", true), /may have stopped/);
  assert.match(page.actionProblem(new TypeError("Failed to fetch"), "resume", true), /may have started again/);
  assert.match(page.actionProblem(new Error("x"), "dismiss", true), /press Dismiss again/);
  assert.equal(page.actionProblem(new Error("x"), "stop"), page.actionProblem(new Error("x"), "stop", true), "no flag means no answer");
  // Ruling (ledger, Task U3): an answer that came but could not be read (the browser's SyntaxError for a body that is
  // not JSON, or sessionsApi.ts's UNREADABLE error) is not "no answer": Agent OS did answer, so the words say so, then
  // carry the same second sentence as the no-answer words of that action.
  const READ_FIRST = "Agent OS answered, but the answer couldn't be read.";
  const NONE_FIRST = "Agent OS hasn't answered.";
  assert.equal(page.actionProblem(new SyntaxError("Unexpected token < in JSON"), "stop", false), `${READ_FIRST} The session may have stopped: its tab says Ended once it has.`);
  assert.equal(page.actionProblem(new Error("x"), "stop", false), `${READ_FIRST} The session may have stopped: its tab says Ended once it has.`);
  assert.equal(page.actionProblem(new Error("x"), "resume", false), `${READ_FIRST} The session may have started again: its tab shows it once it has.`);
  assert.equal(page.actionProblem(new SyntaxError("x"), "dismiss", false), `${READ_FIRST} If the tab is still here after the next update, press Dismiss again.`);
  assert.equal(page.actionProblem(new Error("x"), "stop", true), `${NONE_FIRST} The session may have stopped: its tab says Ended once it has.`);
  assert.doesNotMatch(page.actionProblem(new Error("x"), "stop", false), /hasn't answered/, "an answer came, so it never says Agent OS hasn't answered");
  assert.doesNotMatch(page.actionProblem(new Error("x"), "stop", true), /couldn't be read/, "no answer came, so it never says one could not be read");
  // Stop, Resume and Dismiss may answer 409 session_busy; the server's own sentence is what shows (S7, S8). A refusal
  // is Agent OS's own answer, so the flag changes nothing for it.
  const BUSY = "This session is already being changed. Try again in a moment.";
  for (const action of ["stop", "resume", "dismiss"]) {
    for (const flag of [true, false]) assert.equal(page.actionProblem(apiError("session_busy", BUSY), action, flag), BUSY, `${action} ${flag}`);
  }
  assert.equal(page.actionProblem(apiError("execution_gate_off", LOOK_ONLY), "resume"), LOOK_ONLY);
  assert.equal(page.actionProblem(apiError("unknown_session"), "stop"), "That session doesn't exist anymore.");
  assert.equal(page.actionProblem(apiError("session_live"), "dismiss"), "Agent OS couldn't dismiss the tab.");
  assert.equal(page.isLookOnlyRefusal(apiError("execution_gate_off", LOOK_ONLY)), true);
  assert.equal(page.isLookOnlyRefusal(apiError("not_resumable")), false);
  assert.equal(page.isLookOnlyRefusal(new Error("execution_gate_off")), false, "only Agent OS's own answer counts");
});

test("New session: the agent it starts on, Look only, OpenClaw's folder, the typed folder check", () => {
  const agent = (id, installed = true) => ({ id, detected: { installed } });
  assert.deepEqual(dialog.SESSION_AGENT_ORDER, ["claude", "codex", "cursor", "hermes", "openclaw"]);
  assert.equal(dialog.pickSessionAgent(null, "hermes"), "hermes");
  assert.equal(dialog.pickSessionAgent(null, "nope"), "claude");
  assert.equal(dialog.pickSessionAgent([agent("claude", false), agent("codex", false), agent("cursor")]), "cursor");
  assert.equal(dialog.isLookOnly(null), null);
  assert.equal(dialog.isLookOnly({ enabled: true, level: 1 }), false);
  assert.equal(dialog.isLookOnly({ enabled: true, level: 0 }), true);
  assert.equal(dialog.isLookOnly({ enabled: false, level: 1 }), true);
  assert.equal(dialog.isLookOnly({ enabled: false }), true);
  assert.equal(dialog.LOOK_ONLY_NOTE, LOOK_ONLY);
  assert.equal(dialog.needsFolder("openclaw"), false);
  assert.equal(dialog.needsFolder("claude"), true);
  assert.equal(dialog.OPENCLAW_FOLDER_NOTE, "OpenClaw picks its own folder for now.");
  assert.equal(dialog.FOLDER_EXAMPLE, "For example /Users/you/projects/my-app");
  assert.equal(dialog.typedFolderProblem(""), "");
  assert.equal(dialog.typedFolderProblem("/Users/you/projects/my-app"), "");
  assert.equal(dialog.typedFolderProblem("C:\\Users\\you\\my-app"), "");
  for (const bad of ["projects/my-app", "~/projects/my-app", "my-app"]) {
    assert.equal(dialog.typedFolderProblem(bad), "Type the full path, starting with / (or a drive letter on Windows).", bad);
  }
});

test("New session: the most sessions at once, and the words for a start that went wrong", () => {
  assert.equal(dialog.liveSessionCount([session(), session({ status: "idle" }), session({ status: "exited" }), session({ kind: "update" })]), 2);
  assert.equal(dialog.maxLiveNote(8), "Agent OS runs at most 8 sessions at once. Stop one, then try again.");
  const home = "Your home folder itself can't be used. Pick a folder inside it.";
  assert.deepEqual(dialog.startProblem(apiError("folder_refused", home)), { text: home, field: "folder" });
  assert.deepEqual(dialog.startProblem(apiError("execution_gate_off", "the server's words")), { text: LOOK_ONLY, fix: "safety" });
  const missing = "Codex isn't installed, or Agent OS can't find it. Install it in Setup, then try again.";
  assert.deepEqual(dialog.startProblem(apiError("agent_not_installed", missing)), { text: missing, fix: "setup" });
  const limit = "Agent OS runs at most 8 sessions at once. Stop one, then try again.";
  assert.deepEqual(dialog.startProblem(apiError("too_many_sessions", limit)), { text: limit });
  assert.deepEqual(dialog.startProblem(apiError("weird_new_code")), { text: "Agent OS couldn't start the session." });
  // The dialog passes sessionGotNoAnswer(error) (src/sessionsApi.ts) as the second argument; this file keeps only the
  // words. true (also the default) = no answer at all, false = an answer came but could not be read.
  const lost = dialog.startProblem(new Error("Agent OS did not answer in time."), true);
  assert.equal(lost.fix, "sessions");
  assert.match(lost.text, /may have started/);
  assert.doesNotMatch(lost.text, /nothing/i, "no answer is not a refusal");
  assert.deepEqual(dialog.startProblem(new Error("Agent OS did not answer in time.")), lost, "no flag means no answer");
  // Ruling (ledger, Task U3): an answer that came but could not be read is not "no answer" either. The session may
  // still have started, so the words send the person to the tabs, as the no-answer words do.
  const READ_FIRST = "Agent OS answered, but the answer couldn't be read.";
  const LOOK = "The session may have started: look at the tabs on the Sessions page before you press Start session again.";
  for (const unreadable of [new SyntaxError("Unexpected token < in JSON"), new Error("anything: the flag decides, not the error")]) {
    assert.deepEqual(dialog.startProblem(unreadable, false), { text: `${READ_FIRST} ${LOOK}`, fix: "sessions" });
  }
  assert.equal(dialog.START_NO_ANSWER, `Agent OS hasn't answered. ${LOOK}`);
  assert.equal(dialog.START_UNREADABLE, `${READ_FIRST} ${LOOK}`);
  // A refusal is Agent OS's own answer: the flag changes nothing for it.
  assert.deepEqual(dialog.startProblem(apiError("folder_refused", home), false), { text: home, field: "folder" });
  assert.deepEqual(dialog.startProblem(apiError("execution_gate_off"), true), { text: LOOK_ONLY, fix: "safety" });
});

test("New session: a typed folder survives closing the dialog; the next session's terminal takes the keyboard once", () => {
  assert.equal(dialog.NEW_SESSION_EVENT, "aos-new-session");
  assert.equal(dialog.peekSessionDraft(), null);
  dialog.rememberSessionDraft({ agentId: "codex", folder: "/Users/you/notes" });
  assert.deepEqual(dialog.peekSessionDraft(), { agentId: "codex", folder: "/Users/you/notes" });
  dialog.rememberSessionDraft(null);
  assert.equal(dialog.peekSessionDraft(), null);
  assert.equal(dialog.takeFocusNextSession(), false);
  dialog.askToFocusNextSession();
  assert.equal(dialog.takeFocusNextSession(), true);
  assert.equal(dialog.takeFocusNextSession(), false, "one time only");
});

test("Shell: the New session dialog sits right after New run and under the quit question in the markup", () => {
  // Every dialog draws the same full-window backdrop (.os-modal__backdrop, position: fixed, z-index 100, with no
  // other rule raising one of them), so the one written LATER in the Shell is drawn on top. The quit question is
  // the more urgent prompt (the desktop app is waiting for its answer and quits on its own after 2 s), so it
  // must come last: a New session dialog left open must never hide it. (Task U3 fix round 1; brief Step 14.6.)
  const shell = readFileSync(new URL("../src/ui/Shell.tsx", import.meta.url), "utf8");
  const at = (needle) => {
    const first = shell.indexOf(needle);
    assert.ok(first >= 0, `${needle} is in the Shell`);
    assert.equal(shell.indexOf(needle, first + 1), -1, `${needle} is mounted once`);
    return first;
  };
  const newRun = at("<NewRunDialog ");
  const newSession = at("<NewSessionDialog ");
  const quit = at("<QuitQuestion ");
  assert.ok(newRun < newSession, "New session comes after New run (directly after its line)");
  assert.ok(newSession < quit, "the quit question comes after New session, so it is drawn on top of it");
  assert.equal(shell.slice(newRun, newSession).split("\n").length, 2, "nothing sits between the New run line and the New session line");
  const agentsCss = readFileSync(new URL("../src/ui/agents.css", import.meta.url), "utf8");
  const backdrop = agentsCss.match(/\.os-modal__backdrop\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(backdrop, /position:\s*fixed/);
  assert.match(backdrop, /z-index:\s*100\b/);
  const sessionsCss = readFileSync(new URL("../src/ui/sessions.css", import.meta.url), "utf8");
  assert.doesNotMatch(sessionsCss, /os-modal__backdrop/, "sessions.css does not raise or lower a dialog's backdrop");
});

test("the final-fix pieces are wired where the probes look: Escape on the topmost dialog, focus after a start, Backspace, Open recording, the CSS", () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const modal = read("src/ui/components/AgentConfirmModal.tsx");
  assert.ok(modal.includes("dialogs[dialogs.length - 1] !== dialogRef.current"), "only the last aria-modal dialog answers Escape");
  assert.ok(modal.includes("event.stopImmediatePropagation();"), "and it stops the others from hearing it");
  assert.ok(modal.includes("if (giveBack.current())"), "closing hands the focus back only when the dialog says so");
  const newSession = read("src/ui/components/NewSessionDialog.tsx");
  assert.ok(newSession.includes("started.current = true;") && newSession.includes("giveFocusBack={() => !started.current}"), "a started session keeps the focus off the old terminal");
  assert.ok(read("src/pages/SessionsPage.tsx").includes("autoFocus={terminalTakesKeys({ focusTerminal, wanted, selectedId, wantedListed })}"), "the page asks terminalTakesKeys");
  assert.ok(read("src/ui/components/SessionTabs.tsx").includes("isDismissKey(event.key, tabs[index].status)"), "the tab strip asks isDismissKey");
  assert.ok(read("src/ui/components/SessionSidePanel.tsx").includes("recordingKept(session.recordingBytes) ? ("), "Open recording only while the recording exists");
  // Change brain scrolls its panel into view when its top is not on screen; the panel stops below the top bar.
  const brainCard = read("src/ui/components/AgentBrainCard.tsx");
  assert.ok(brainCard.includes("node.scrollIntoView({ block: \"start\""), "Change brain scrolls its panel into view");
  assert.ok(brainCard.includes("node.getBoundingClientRect().top < window.innerHeight - 120) return;"), "but not when the panel's top is already on screen");
  assert.match(read("src/ui/agents.css"), /\.os-agt-secs > \.os-brain \{[^}]*scroll-margin-top: calc\(var\(--os-bar-h, 48px\) \+ var\(--os-sp-4\)\)/);
  // Setup's plan card takes the whole row of the card grid; the Agents page's card is not in that grid.
  assert.match(read("src/ui/brain.css"), /\.os-brain-cards > \.os-plan-card \{\s*grid-column: 1 \/ -1;/);
  // An ended tab's whole title fits (a folder name of about 16 characters plus "· Ended · open recording").
  const cap = /button\.os-sess-tab__btn \{[^}]*max-width: (\d+)px/.exec(read("src/ui/sessions.css"));
  assert.ok(cap && Number(cap[1]) >= 460, `the tab's cap is ${cap?.[1]}px`);
  // Dialog paragraphs use the app's body line height without outweighing a paragraph's own.
  for (const file of ["src/ui/agents.css", "src/ui/runs.css"]) {
    assert.match(read(file), /:where\(\.os-modal__body\) p \{\s*line-height: var\(--os-lh-body\);/, file);
  }
});
