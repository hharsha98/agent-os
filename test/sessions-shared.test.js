// Sessions (SP3) client logic (src/ui/sessionsShared.ts): titles, status words, the side panel's line,
// the Stop and Resume words, which keys belong to Agent OS, the quit question, and the pure half of the
// terminal's WebSocket protocol. Node strips the TypeScript types itself (decision P14), so the .ts files
// are imported directly. Nothing here talks to a server or starts anything.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as ss from "../src/ui/sessionsShared.ts";
import * as stopAll from "../src/ui/stopAllShared.ts";

// 3 pm local time, so durations read the same in every time zone.
const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const session = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", kind: "agent", agentId: "claude", agentLabel: "Claude Code",
  folder: "/Users/you/my-app", folderName: "my-app", folderShown: true, branch: null, status: "live",
  stateSince: iso(1000), startedAt: iso(60_000), endedAt: null, exitCode: null, signal: null, endedBy: null,
  dismissed: false, brain: null, resume: { available: true, reason: null, fallback: false }, nothingToResume: false,
  alerts: "basic", recordingBytes: 0, ...over
});
const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const key = (over) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
const MAC = { isMac: true, desktop: true };
const MAC_BROWSER = { isMac: true, desktop: false };
const PC = { isMac: false, desktop: true };
const PC_BROWSER = { isMac: false, desktop: false };

test("a session's title is '<agent> · <folder>'; OpenClaw's folder reads 'Set by OpenClaw'; an update is '<agent> update'", () => {
  assert.equal(ss.sessionTitle(session()), "Claude Code · my-app");
  assert.equal(ss.sessionTitle(session({ agentId: "openclaw", agentLabel: "OpenClaw", folderShown: false, folderName: "you" })), "OpenClaw · Set by OpenClaw");
  assert.equal(ss.sessionTitle(session({ kind: "update", agentId: "hermes", agentLabel: "Hermes" })), "Hermes update");
  assert.equal(ss.sessionTitle(session({ folderName: "" })), "Claude Code · —", "an unknown folder name reads —");
  // The same fallback as Stop all (sessionStopTitle): the label, else the agent's id, else "Agent".
  assert.equal(ss.sessionTitle(session({ agentLabel: "" })), "claude · my-app", "no label: the agent's id");
  assert.equal(ss.sessionTitle(session({ agentLabel: "", agentId: "" })), "Agent · my-app", "no label and no id: Agent");
  assert.equal(ss.sessionTitle(session({ kind: "update", agentLabel: "", agentId: "hermes" })), "hermes update");
  assert.equal(ss.sessionTitle(session({ agentLabel: "", agentId: "openclaw", folderShown: false })), "openclaw · Set by OpenClaw");
  // A setup session (plan brains): OpenClaw's ChatGPT sign-in in a brain card, never a folder.
  assert.equal(
    ss.sessionTitle(session({ kind: "setup", agentId: "openclaw", agentLabel: "OpenClaw", folderShown: false, folderName: "you" })),
    "OpenClaw · ChatGPT sign-in"
  );
  assert.equal(ss.sessionTitle(session({ kind: "setup", agentId: "openclaw", agentLabel: "" })), "openclaw · ChatGPT sign-in");
});

test("Stop all names a session with the same words as the Sessions page (S10's sessionStopTitle)", () => {
  // stopAllShared.ts cannot import this file (Node follows no extensionless import, P14), so this test keeps
  // the two copies of the rule equal.
  for (const s of [
    session(),
    session({ folderName: "" }),
    session({ agentId: "openclaw", agentLabel: "OpenClaw", folderShown: false, folderName: "you" }),
    session({ kind: "update", agentId: "hermes", agentLabel: "Hermes" }),
    // No label: both copies fall back to the agent's id, then to "Agent".
    session({ agentLabel: "" }),
    session({ agentLabel: "", agentId: "" }),
    session({ kind: "update", agentId: "hermes", agentLabel: "" }),
    session({ agentLabel: "", agentId: "openclaw", folderShown: false }),
    // A setup session (OpenClaw's ChatGPT sign-in, plan brains): the same title in both copies.
    session({ kind: "setup", agentId: "openclaw", agentLabel: "OpenClaw", folderShown: false, folderName: "you" }),
    session({ kind: "setup", agentId: "openclaw", agentLabel: "" })
  ]) {
    assert.equal(stopAll.sessionStopTitle(s), ss.sessionTitle(s), `${s.kind} "${s.agentLabel}" ${s.agentId} ${s.folderShown} "${s.folderName}"`);
  }
});

test("status words: Starting and Ended are labels on the kit's existing states (Q18); an unknown status reads —", () => {
  assert.deepEqual(ss.sessionStateWord({ status: "starting" }), { state: "idle", label: "Starting" });
  assert.deepEqual(ss.sessionStateWord({ status: "live" }), { state: "live", label: "Live" });
  assert.deepEqual(ss.sessionStateWord({ status: "idle" }), { state: "idle", label: "Idle" });
  assert.deepEqual(ss.sessionStateWord({ status: "waiting" }), { state: "waiting", label: "Waiting for you" });
  assert.deepEqual(ss.sessionStateWord({ status: "held" }), { state: "held", label: "Held" });
  assert.deepEqual(ss.sessionStateWord({ status: "exited" }), { state: "stopped", label: "Ended" });
  assert.deepEqual(ss.sessionStateWord({ status: "paused" }), { state: "unknown", label: "" });
  assert.deepEqual(ss.sessionStateWord({ status: "toString" }), { state: "unknown", label: "" }, "inherited names are not statuses");
});

test("the menu counts running agent sessions only: not ended ones, not update sessions, not unknown statuses", () => {
  const sessions = [
    session({ status: "starting" }),
    session({ status: "live" }),
    session({ status: "idle" }),
    session({ status: "exited" }),
    session({ kind: "update", status: "live" }),
    session({ status: "something-new" })
  ];
  assert.equal(ss.runningSessionCount(sessions), 3);
  assert.equal(ss.runningSessionCount([]), 0);
  assert.equal(ss.isSessionRunning({ status: "held" }), true);
  assert.equal(ss.isSessionRunning({ status: "exited" }), false);
});

test("one test for an open agent session, shared by the menu and Home", () => {
  assert.equal(ss.isOpenAgentSession(session({ status: "starting" })), true);
  assert.equal(ss.isOpenAgentSession(session({ status: "idle" })), true);
  assert.equal(ss.isOpenAgentSession(session({ status: "exited" })), false);
  assert.equal(ss.isOpenAgentSession(session({ kind: "update", status: "live" })), false);
  assert.equal(ss.isOpenAgentSession(session({ kind: "setup", status: "live" })), false, "a sign-in terminal is not an agent session");
  assert.equal(ss.isOpenAgentSession(session({ status: "something-new" })), false, "an unknown status is not counted");
});

// Minor sweep, Group B item 7: the server refuses a Resume it knows can never work right now with 409 session_live
// (it runs again) or 409 not_resumable (an update session, or the agent's resume rules say no). Pressing Resume again
// cannot change that answer; every other refusal (a busy double click, Look only, a time-out) can.
test("a Resume refused as impossible is told apart from one that may work on another try", () => {
  const refused = (code, detail = "words") => Object.assign(new Error(code), { name: "ApiError", detail, status: 409 });
  assert.equal(ss.isImpossibleResume(refused("session_live")), true);
  assert.equal(ss.isImpossibleResume(refused("not_resumable")), true);
  for (const code of ["session_busy", "execution_gate_off", "unknown_session", "pty_unavailable", "start_failed"]) {
    assert.equal(ss.isImpossibleResume(refused(code)), false, code);
  }
  assert.equal(ss.isImpossibleResume(new Error("session_live")), false, "an error that is not Agent OS's own answer");
  assert.equal(ss.isImpossibleResume(new SyntaxError("not json")), false);
  assert.equal(ss.isImpossibleResume(null), false);
  assert.equal(ss.isImpossibleResume("session_live"), false);
});

test("the side panel's line for each state, SP3 versions (spec, Session activity states)", () => {
  assert.equal(ss.sessionPanelLine(session({ status: "starting" }), NOW), "Starting Claude Code…");
  assert.equal(ss.sessionPanelLine(session({ status: "live" }), NOW), "Working.");
  assert.equal(ss.sessionPanelLine(session({ status: "idle", stateSince: iso(26 * 60_000) }), NOW), "Idle for 26 m. Nothing is running.");
  assert.equal(ss.sessionPanelLine(session({ status: "idle", stateSince: iso(20_000) }), NOW), "Idle for under 1 m. Nothing is running.");
  assert.equal(ss.sessionPanelLine(session({ status: "idle", stateSince: iso(65 * 60_000) }), NOW), "Idle for 1 h 05 m. Nothing is running.");
  assert.equal(ss.sessionPanelLine(session({ status: "idle", stateSince: undefined }), NOW), "Idle. Nothing is running.", "no time is made up when it is not known");
  assert.equal(ss.sessionPanelLine(session({ status: "idle", stateSince: "not a time" }), NOW), "Idle. Nothing is running.");
  assert.equal(ss.sessionPanelLine(session({ status: "waiting" }), NOW), "The question is in the terminal. Agent OS never answers for you.");
  assert.equal(ss.sessionPanelLine(session({ status: "held" }), NOW), "Plan limit reached.");
  assert.equal(ss.sessionPanelLine(session({ status: "something-new" }), NOW), "");
});

test("an ended session says how it ended, then where its recording is (or that it was removed)", () => {
  // An ended session's recording holds at least its header line, so recordingBytes is above 0 until the
  // 1 GB cap (Q38) or a delete removes it.
  const ended = (over) => ss.sessionPanelLine(session({ status: "exited", endedAt: iso(1000), recordingBytes: 10, ...over }), NOW);
  assert.equal(ended({ exitCode: 0 }), "Ended normally. The recording is in Runs.");
  assert.equal(ended({ exitCode: 3 }), "Ended with exit code 3. The recording is in Runs.");
  assert.equal(ended({ exitCode: null, signal: "SIGKILL" }), "Ended by signal SIGKILL. The recording is in Runs.");
  assert.equal(ended({ exitCode: 0, signal: "SIGHUP" }), "Ended by signal SIGHUP. The recording is in Runs.", "a signal says more than a 0 that comes with it");
  assert.equal(ended({ exitCode: null, signal: "SIGTERM", endedBy: "stop" }), "Stopped by you. The recording is in Runs.");
  assert.equal(ended({ exitCode: null, signal: "SIGTERM", endedBy: "quit" }), "Ended when Agent OS quit. The recording is in Runs.");
  assert.equal(ended({ exitCode: null, signal: null }), "Ended. The recording is in Runs.");
  assert.equal(ended({ exitCode: 0, recordingBytes: 10 }), "Ended normally. The recording is in Runs.", "a recording that is there is in Runs");
  assert.equal(
    ended({ exitCode: 0, recordingBytes: 0 }),
    "Ended normally. Its recording was removed.",
    "after the 1 GB cap or a delete, Runs no longer has it, so the line does not send you there"
  );
});

test("a Claude resume with nothing saved says so plainly; Stop and quit still win, and a missing flag means false", () => {
  const NOTHING_SAVED = "Claude Code found nothing saved for this conversation, so it couldn't be resumed.";
  assert.equal(
    ss.endedLine({ exitCode: 1, signal: null, endedBy: null, nothingToResume: true }),
    NOTHING_SAVED,
    "the exit code 1 is not shown: it would say nothing useful"
  );
  assert.equal(ss.endedLine({ exitCode: null, signal: "SIGTERM", endedBy: "stop", nothingToResume: true }), "Stopped by you.");
  assert.equal(ss.endedLine({ exitCode: null, signal: "SIGTERM", endedBy: "quit", nothingToResume: true }), "Ended when Agent OS quit.");
  // The flag is only a fact when it is exactly true: false, missing or odd values read as before.
  assert.equal(ss.endedLine({ exitCode: 1, signal: null, endedBy: null, nothingToResume: false }), "Ended with exit code 1.");
  assert.equal(ss.endedLine({ exitCode: 1, signal: null, endedBy: null }), "Ended with exit code 1.");
  assert.equal(ss.endedLine({ exitCode: 1, signal: null, endedBy: null, nothingToResume: "yes" }), "Ended with exit code 1.");
  // The tab's body and the side panel's line both use it, followed by where the recording is.
  const ended = (over) => ss.sessionPanelLine(session({ status: "exited", endedAt: iso(1000), recordingBytes: 10, ...over }), NOW);
  assert.equal(ended({ exitCode: 1, nothingToResume: true }), `${NOTHING_SAVED} The recording is in Runs.`);
  assert.equal(ended({ exitCode: 1, nothingToResume: true, recordingBytes: 0 }), `${NOTHING_SAVED} Its recording was removed.`);
  assert.equal(ended({ exitCode: 1, nothingToResume: true, endedBy: "stop" }), "Stopped by you. The recording is in Runs.");
});

test("the Stop dialog: title, body, buttons, and OpenClaw's honest extra line", () => {
  assert.deepEqual(ss.stopDialogCopy(session()), {
    title: "Stop Claude Code · my-app?",
    body: "This ends Claude Code in this tab. The recording stays in Runs.",
    note: null,
    cancel: "Keep it running",
    confirm: "Stop session"
  });
  const openclaw = ss.stopDialogCopy(session({ agentId: "openclaw", agentLabel: "OpenClaw", folderShown: false }));
  assert.equal(openclaw.title, "Stop OpenClaw · Set by OpenClaw?");
  assert.equal(openclaw.note, "OpenClaw may still finish its last step after the terminal closes.");
});

test("the Resume confirm: same tab, the fallback warning, and the written reason when it can't resume", () => {
  assert.deepEqual(ss.resumeConfirmCopy(session({ status: "exited" })), {
    title: "Resume Claude Code · my-app?",
    body: "This starts Claude Code again in the same tab and continues the conversation. The recording continues after a marker.",
    warning: null,
    blocked: null,
    cancel: "Cancel",
    confirm: "Resume conversation"
  });
  const codex = { agentId: "codex", agentLabel: "Codex", status: "exited" };
  assert.equal(
    ss.resumeConfirmCopy(session({ ...codex, resume: { available: true, reason: null, fallback: true } })).warning,
    "This resumes the most recent Codex conversation in this folder, which may be one you started outside Agent OS."
  );
  assert.equal(
    ss.resumeConfirmCopy(session({ ...codex, resume: { available: false, reason: "Another Codex session is open in this folder. Stop it first.", fallback: true } })).blocked,
    "Another Codex session is open in this folder. Stop it first."
  );
  assert.equal(ss.resumeConfirmCopy(session({ resume: { available: false, reason: null, fallback: false } })).blocked, "This session can't be resumed.");
});

test("the palette key outside a terminal: ⌘K on a Mac, Ctrl+K elsewhere, never both", () => {
  assert.equal(ss.isPaletteKey(key({ key: "k", code: "KeyK", metaKey: true }), { isMac: true }), true);
  assert.equal(ss.isPaletteKey(key({ key: "k", code: "KeyK", ctrlKey: true }), { isMac: true }), false, "Ctrl+K on a Mac is not the palette");
  assert.equal(ss.isPaletteKey(key({ key: "k", code: "KeyK", ctrlKey: true }), { isMac: false }), true);
  assert.equal(ss.isPaletteKey(key({ key: "k", code: "KeyK", metaKey: true }), { isMac: false }), false, "the Windows key is not the palette");
  assert.equal(ss.isPaletteKey(key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), { isMac: false }), false);
  assert.equal(ss.isPaletteKey(key({ key: "k", code: "KeyK", metaKey: true, altKey: true }), { isMac: true }), false);
  assert.equal(ss.isPaletteKey(key({ key: "л", code: "KeyK", metaKey: true }), { isMac: true }), true, "a Cyrillic layout still finds ⌘K by the key's place");
  assert.equal(ss.isMacPlatform("MacIntel"), true);
  assert.equal(ss.isMacPlatform("Win32"), false);
  assert.equal(ss.isMacPlatform("Linux x86_64"), false);
});

test("inside a terminal only ⌘K/⌘T/⌘1-9 (Mac) or Ctrl+Shift+K/T/1-9 (elsewhere) are Agent OS's; Ctrl+K and Ctrl+R reach the agent", () => {
  assert.deepEqual(ss.isAppShortcut(key({ key: "k", code: "KeyK", metaKey: true }), MAC), { action: "palette" });
  assert.deepEqual(ss.isAppShortcut(key({ key: "t", code: "KeyT", metaKey: true }), MAC), { action: "new-session" });
  assert.deepEqual(ss.isAppShortcut(key({ key: "3", code: "Digit3", metaKey: true }), MAC), { action: "switch", index: 2 });
  assert.deepEqual(ss.isAppShortcut(key({ key: "9", code: "Digit9", metaKey: true }), MAC), { action: "switch", index: 8 });
  assert.equal(ss.isAppShortcut(key({ key: "0", code: "Digit0", metaKey: true }), MAC), null);
  assert.equal(ss.isAppShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), MAC), null, "Ctrl+K reaches the agent");
  assert.equal(ss.isAppShortcut(key({ key: "r", code: "KeyR", ctrlKey: true }), MAC), null, "Ctrl+R reaches the agent");
  assert.equal(ss.isAppShortcut(key({ key: "\\", code: "Backslash", metaKey: true }), MAC), null, "⌘\\ (split) arrives with SP4");
  assert.equal(ss.isAppShortcut(key({ key: "T", code: "KeyT", metaKey: true, shiftKey: true }), MAC), null);
  assert.equal(ss.isAppShortcut(key({ key: "c", code: "KeyC", metaKey: true }), MAC), null, "⌘C stays copy");
  assert.deepEqual(ss.isAppShortcut(key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), PC), { action: "palette" });
  assert.deepEqual(ss.isAppShortcut(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), PC), { action: "new-session" });
  assert.deepEqual(ss.isAppShortcut(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), PC), { action: "switch", index: 0 }, "Shift turns 1 into ! but the key's place is still 1");
  assert.equal(ss.isAppShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), PC), null, "Ctrl+K reaches the agent");
  assert.equal(ss.isAppShortcut(key({ key: "t", code: "KeyT", ctrlKey: true }), PC), null);
  assert.equal(ss.isAppShortcut(key({ key: "r", code: "KeyR", ctrlKey: true }), PC), null);
  assert.equal(ss.isAppShortcut(key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true, altKey: true }), PC), null);
});

test("in browser mode only the palette key is taken, and the panel footer shows no shortcut hints", () => {
  assert.deepEqual(ss.isAppShortcut(key({ key: "k", code: "KeyK", metaKey: true }), MAC_BROWSER), { action: "palette" });
  assert.equal(ss.isAppShortcut(key({ key: "t", code: "KeyT", metaKey: true }), MAC_BROWSER), null, "the browser keeps ⌘T");
  assert.equal(ss.isAppShortcut(key({ key: "1", code: "Digit1", metaKey: true }), MAC_BROWSER), null, "the browser keeps ⌘1-9");
  assert.deepEqual(ss.isAppShortcut(key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), PC_BROWSER), { action: "palette" });
  assert.equal(ss.isAppShortcut(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), PC_BROWSER), null);
  assert.deepEqual(ss.shortcutHints(MAC), [{ keys: "⌘T", word: "new" }, { keys: "⌘1-9", word: "switch" }]);
  assert.deepEqual(ss.shortcutHints(PC), [{ keys: "Ctrl+Shift+T", word: "new" }, { keys: "Ctrl+Shift+1-9", word: "switch" }]);
  assert.deepEqual(ss.shortcutHints(MAC_BROWSER), []);
  assert.deepEqual(ss.shortcutHints(PC_BROWSER), []);
});

test("the quit question's words (ruling R21): one session or many, an update named apart, checking, failed check", () => {
  assert.equal(ss.joinNames([]), "");
  assert.equal(ss.joinNames(["A"]), "A");
  assert.equal(ss.joinNames(["A", "B"]), "A and B");
  assert.equal(ss.joinNames(["A", "B", "C"]), "A, B and C");
  assert.equal(ss.joinNames(["A", "B", "C", "D", "E", "F"]), "A, B, C, D and 2 more");
  // The quit check sends each item's kind (decision Q27); an agent session unless the test says otherwise.
  // An update session's title is "<agent> update" (S6).
  const item = (title, kind = "agent") => ({ id: title, title, kind });
  const CLAUDE_ITEM = item("Claude Code · my-app");
  const CODEX_ITEM = item("Codex · api");
  const UPDATE_ITEM = item("Hermes update", "update");
  const body = (...live) => ss.quitQuestionCopy({ phase: "asking", live }).body;
  assert.deepEqual(ss.quitQuestionCopy({ phase: "asking", live: [CLAUDE_ITEM, CODEX_ITEM] }), {
    title: "Quit Agent OS?",
    body: "These sessions are still running: Claude Code · my-app and Codex · api. Quitting ends them. Their recordings stay in Runs, and you can resume them later.",
    keep: "Keep running",
    quit: "Quit"
  });
  assert.equal(
    body(CLAUDE_ITEM),
    "Claude Code · my-app is still running. Quitting ends it. Its recording stays in Runs, and you can resume it later."
  );
  assert.equal(
    body(CLAUDE_ITEM, UPDATE_ITEM),
    "Claude Code · my-app is still running. Quitting ends it. Its recording stays in Runs, and you can resume it later. Quitting also stops the Hermes update.",
    "an update is never resumed: it gets its own sentence, and the resume promise covers only the agent session"
  );
  assert.equal(
    body(UPDATE_ITEM, CLAUDE_ITEM, CODEX_ITEM),
    "These sessions are still running: Claude Code · my-app and Codex · api. Quitting ends them. Their recordings stay in Runs, and you can resume them later. Quitting also stops the Hermes update.",
    "the update is never counted among the sessions that can be resumed, wherever it is in the list"
  );
  assert.equal(body(UPDATE_ITEM), "The Hermes update is still running. Quitting stops it.", "only an update running");
  assert.equal(ss.quitQuestionCopy({ phase: "checking" }).body, "Checking which sessions are still running…");
  assert.equal(
    ss.quitQuestionCopy({ phase: "unknown" }).body,
    "Agent OS couldn't check which sessions are running. Quitting ends any that are. Their recordings stay in Runs."
  );
  for (const view of [
    { phase: "checking" },
    { phase: "unknown" },
    { phase: "asking", live: [item("A")] },
    { phase: "asking", live: [item("A"), item("B"), UPDATE_ITEM] },
    { phase: "asking", live: [UPDATE_ITEM] }
  ]) {
    assert.doesNotMatch(Object.values(ss.quitQuestionCopy(view)).join(" "), /—/, "no em dash in visible text");
  }
});

// Time limits of 700 ms and 6 s become 7 ms and 60 ms: the same code path, no real waiting.
async function withFastClock(fn) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, typeof ms === "number" ? ms / 100 : ms, ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
function quitFlow(check) {
  const calls = [];
  let open = true;
  return {
    calls,
    flow: {
      check,
      show: (view) => calls.push(["show", view.phase, view.phase === "asking" ? view.live.map((x) => x.title).join("|") : ""]),
      shown: () => calls.push(["shown"]),
      answer: (quit) => {
        open = false;
        calls.push(["answer", quit]);
      },
      isOpen: () => open
    }
  };
}
const CLAUDE = { id: "a", title: "Claude Code · my-app", kind: "agent" };

test("the quit flow: nothing running quits at once; running sessions are named; a slow answer shows Checking… first", async () => {
  await withFastClock(async () => {
    let q = quitFlow(async () => ({ live: [] }));
    await ss.runQuitFlow(q.flow);
    assert.deepEqual(q.calls, [["answer", true]], "nothing would be lost: quit without a question");

    q = quitFlow(async () => ({ live: [CLAUDE] }));
    await ss.runQuitFlow(q.flow);
    assert.deepEqual(q.calls, [["show", "asking", "Claude Code · my-app"], ["shown"]]);

    q = quitFlow(async () => {
      throw new Error("Agent OS did not answer in time.");
    });
    await ss.runQuitFlow(q.flow);
    assert.deepEqual(q.calls, [["show", "unknown", ""], ["shown"]], "a failed check still asks, and says it could not check");

    q = quitFlow(() => {
      throw new Error("thrown before any promise");
    });
    await ss.runQuitFlow(q.flow);
    assert.deepEqual(q.calls, [["show", "unknown", ""], ["shown"]]);

    q = quitFlow(() => after(2000, { live: [CLAUDE] }));
    await ss.runQuitFlow(q.flow);
    assert.deepEqual(q.calls, [["show", "checking", ""], ["shown"], ["show", "asking", "Claude Code · my-app"]], "slow: on screen first, names later");

    q = quitFlow(() => after(2000, { live: [] }));
    await ss.runQuitFlow(q.flow);
    assert.deepEqual(q.calls, [["show", "checking", ""], ["shown"], ["answer", true]]);

    q = quitFlow(() => new Promise(() => {}));
    await ss.runQuitFlow(q.flow);
    assert.deepEqual(q.calls, [["show", "checking", ""], ["shown"], ["show", "unknown", ""]], "no answer at all: say so");

    q = quitFlow(() => after(2000, { live: [CLAUDE] }));
    const done = ss.runQuitFlow(q.flow);
    await after(1000);
    q.flow.answer(false); // the person pressed Keep running while it was checking
    await done;
    assert.deepEqual(q.calls, [["show", "checking", ""], ["shown"], ["answer", false]], "a late answer changes nothing after the person chose");
  });
  assert.ok(ss.QUIT_FAST_MS < 2000, "the question is on screen well inside the shell's 2 s");
});

// Waits (real time, short) until the condition holds, so a test never depends on a fixed pause.
async function until(condition, ms = 1000) {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
}
const later = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("each quit request is its own round: a late result from an answered flow cannot draw or answer the next question", async () => {
  await withFastClock(async () => {
    const rounds = ss.createQuitRounds();
    const calls = [];
    // What the desktop hook does: one flow per request, answering closes the round.
    const flowFor = (name, check) => ({
      check,
      show: (view) => calls.push([name, "show", view.phase, view.phase === "asking" ? view.live.map((x) => x.title).join("|") : ""]),
      shown: () => calls.push([name, "shown"]),
      answer: (quit) => {
        rounds.end();
        calls.push([name, "answer", quit]);
      }
    });

    const a = rounds.begin();
    assert.equal(a, 1);
    assert.equal(rounds.begin(), null, "a second request while a question is open changes nothing");
    const checkA = later();
    const doneA = ss.runQuitFlow(rounds.guard(a, flowFor("A", () => checkA.promise)));
    await until(() => calls.length === 2);
    assert.deepEqual(calls, [["A", "show", "checking", ""], ["A", "shown"]], "A is slow, so it shows Checking…");

    // The person presses Keep running; then asks to quit again (round 2) while A's check is still out.
    rounds.end();
    calls.push(["person", "keep running"]);
    const b = rounds.begin();
    assert.equal(b, 2);
    const checkB = later();
    const doneB = ss.runQuitFlow(rounds.guard(b, flowFor("B", () => checkB.promise)));
    await until(() => calls.length === 5);
    assert.deepEqual(calls.slice(2), [["person", "keep running"], ["B", "show", "checking", ""], ["B", "shown"]]);

    // A's check now arrives: nothing is running. Without a round of its own this quit the app under B's question.
    checkA.resolve({ live: [] });
    await doneA;
    assert.equal(calls.length, 5, "A's late result does nothing: no answer, no drawing");
    assert.equal(rounds.isCurrent(a), false);
    assert.equal(rounds.isCurrent(b), true, "B's question is still the open one");

    checkB.resolve({ live: [CLAUDE] });
    await doneB;
    assert.deepEqual(calls[5], ["B", "show", "asking", "Claude Code · my-app"], "B still gets its own result");
    assert.equal(calls.length, 6);

    // An answer ends the round; a flow that was still waiting stays silent, and a new request may begin.
    const checkC = later();
    rounds.end();
    const c = rounds.begin();
    const doneC = ss.runQuitFlow(rounds.guard(c, flowFor("C", () => checkC.promise)));
    await until(() => calls.length === 8);
    rounds.end();
    checkC.resolve({ live: [] });
    await doneC;
    assert.equal(calls.length, 8, "C was answered by the person: its late result does nothing");
    assert.equal(rounds.begin(), 4, "rounds count on, so an old flow never matches a new round");
  });
});

test("the update banner's decision after the quit check: nothing running installs at once; sessions ask; no readable answer says so", () => {
  const item = { id: "a", title: "Claude Code · my-app", kind: "agent" };
  assert.equal(ss.installQuestion({ live: [] }), null, "nothing would be lost: install at once");
  assert.deepEqual(ss.installQuestion({ live: [item] }), { phase: "asking", live: [item] });
  for (const unreadable of [null, undefined, {}, { live: null }, { live: "x" }, "nope"]) {
    assert.deepEqual(ss.installQuestion(unreadable), { phase: "unknown" }, `${JSON.stringify(unreadable)} cannot be read: ask and say so`);
  }
  // The question it asks is the quit question: the same words as quitting.
  assert.equal(ss.quitQuestionCopy(ss.installQuestion({ live: [item] })).title, "Quit Agent OS?");
});

test("WebSocket input is split into frames of at most 64 KB, never inside a character", () => {
  const frameBytes = (d) => Buffer.byteLength(JSON.stringify({ t: "in", d }));
  assert.deepEqual(ss.chunkInput(""), []);
  assert.deepEqual(ss.chunkInput("hi\r"), ["hi\r"]);
  assert.equal(ss.chunkInput("x".repeat(200_000)).length, 4, "frames are filled, not cut early");
  for (const text of ["x".repeat(200_000), "\u001b[A".repeat(30_000), "é🙂中".repeat(20_000), '"\\'.repeat(40_000)]) {
    const chunks = ss.chunkInput(text);
    assert.equal(chunks.join(""), text, "nothing is lost or reordered");
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(frameBytes(chunk) <= ss.MAX_IN_FRAME_BYTES, `a frame of ${frameBytes(chunk)} bytes`);
      assert.doesNotMatch(chunk, /[\ud800-\udbff]$/, "a chunk never ends half way through an emoji");
    }
  }
  assert.equal(ss.utf8ByteLength("aé🙂中"), 1 + 2 + 4 + 3);
  assert.equal(ss.MAX_IN_FRAME_BYTES, 65_536);
});

test("sizes outside 2-500 columns and 1-200 rows are never sent", () => {
  assert.equal(ss.validSize(2, 1), true);
  assert.equal(ss.validSize(500, 200), true);
  assert.equal(ss.validSize(120, 32), true);
  for (const [cols, rows] of [[1, 24], [501, 24], [80, 0], [80, 201], [80.5, 24], [80, Number.NaN], ["80", 24], [null, 24]]) {
    assert.equal(ss.validSize(cols, rows), false, `${cols} × ${rows}`);
  }
  assert.equal(ss.RESIZE_DEBOUNCE_MS, 50);
});

test("acks: one once 64 KB are on screen, carrying the seq reached; a new snapshot starts again at 0", () => {
  const acks = ss.createAckCounter();
  assert.equal(acks.processed(10_000), null);
  assert.equal(acks.processed(65_535), null);
  assert.equal(acks.processed(65_536), 65_536);
  assert.equal(acks.processed(70_000), null);
  assert.equal(acks.processed(60_000), null, "an older seq changes nothing");
  assert.equal(acks.processed(131_072), 131_072);
  acks.reset();
  assert.equal(acks.processed(65_536), 65_536, "after a new snapshot the count starts at 0 again");
  assert.equal(ss.ACK_EVERY_BYTES, 65_536);
});

test("server frames are read defensively", () => {
  const modes = { altScreen: true, bracketedPaste: true, mouseTracking: "any", mouseEncoding: "sgr", focusReporting: true, cursorKeysApp: true, kittyFlags: 1 };
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "snapshot", data: "x", cols: 80, rows: 24, modes })), { t: "snapshot", data: "x", cols: 80, rows: 24, modes });
  const off = { altScreen: false, bracketedPaste: false, mouseTracking: "none", mouseEncoding: "default", focusReporting: false, cursorKeysApp: false, kittyFlags: 0 };
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "snapshot", data: "", cols: 80, rows: 24 })).modes, off, "missing modes are all off");
  assert.deepEqual(ss.readModes({ altScreen: "yes", mouseTracking: "weird", mouseEncoding: "utf8", kittyFlags: 99 }), off, "values that are not allowed are off");
  assert.equal(ss.readModes({ mouseEncoding: "sgr-pixels" }).mouseEncoding, "sgr-pixels");
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "snapshot", data: "x", cols: 1, rows: 24 })), null);
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "snapshot", cols: 80, rows: 24 })), null);
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "out", seq: 12, d: "hi" })), { t: "out", seq: 12, d: "hi" });
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "out", seq: -1, d: "hi" })), null);
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "out", seq: "12", d: "hi" })), null);
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "out", seq: 12 })), null);
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "state", status: "exited", exitCode: 3, signal: null, endedBy: "stop" })), {
    t: "state", status: "exited", exitCode: 3, signal: null, endedBy: "stop", resetAt: null
  });
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "state", status: "live" })), {
    t: "state", status: "live", exitCode: null, signal: null, endedBy: null, resetAt: null
  }, "the manager's first state frame carries only the status");
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "state", status: "live", endedBy: "other" })).endedBy, null);
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "state", status: "nope" })), null);
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "alert", raw: "bel" })), { t: "alert", raw: "bel" });
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "alert" })), null);
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "hello" })), null);
  assert.equal(ss.parseServerFrame("[]"), null);
  assert.equal(ss.parseServerFrame("not json"), null);
});

test("after the server closes a socket, the reason word decides (S9: 4000 too_far_behind, 4001 session_ended, 4004 attach_failed), not the number", () => {
  assert.equal(ss.sessionCloseAdvice({ code: 4000, reason: "too_far_behind" }), "reattach", "too far behind: attach again for a fresh snapshot");
  assert.equal(ss.sessionCloseAdvice({ code: 4001, reason: "session_ended" }), "ended", "the session ended: never attach again");
  assert.equal(ss.sessionCloseAdvice({ code: 4004, reason: "attach_failed" }), "wait", "this window could not attach: not again at once");
  assert.equal(ss.sessionCloseAdvice({ code: 1009, reason: "" }), "wait", "a message over 1 MB (ws's own close): not again at once");
  assert.equal(ss.sessionCloseAdvice({ code: 4001, reason: "too_far_behind" }), "reattach", "the word decides, not the number");
  assert.equal(ss.sessionCloseAdvice({ code: 4000, reason: "session_ended" }), "ended", "the word decides, not the number");
  assert.equal(ss.sessionCloseAdvice({ code: 1006, reason: "" }), "reattach", "a dropped connection attaches again");
  assert.equal(ss.sessionCloseAdvice({ code: 1001, reason: "" }), "reattach", "Agent OS going away (a restart) attaches again");
});

test("wiring: every sessions request has a time limit, the Shell skips keys typed in a terminal, the new query keys are kept, and the update banner asks first", () => {
  const api = source("sessionsApi.ts");
  const requests = api.match(/request</g)?.length ?? 0;
  const limited = api.match(/withTimeout\(\s*request</g)?.length ?? 0;
  assert.ok(requests >= 12 && requests === limited, `${limited} of ${requests} requests have a time limit`);
  assert.match(api, /"\/attach"/, "the socket goes to /api/sessions/:id/attach");
  assert.doesNotMatch(api, /attach\?|[?&](token|key|cookie)=/i, "no query string and no token in the socket address");
  const shell = source("ui/Shell.tsx");
  assert.match(shell, /closest\("\.xterm"\)/, "the palette key is skipped inside a terminal");
  assert.match(shell, /isPaletteKey\(/);
  assert.doesNotMatch(shell, /event\.metaKey \|\| event\.ctrlKey/, "not both keys on every computer any more");
  assert.match(shell, /<SessionsListProvider/);
  assert.match(shell, /PALETTE_EVENT/);
  const list = source("ui/useSessionsList.ts");
  assert.match(list, /createLatestRead/);
  assert.match(list, /reads\.cancel\(\)/);
  assert.match(list, /useInterval\(/);
  assert.match(list, /"not_available"/, "a 404 not_available answer means sessions do not exist here");
  assert.match(list, /addEventListener\("visibilitychange"/, "the list is read again at once when the window comes back");
  assert.match(list, /document\.hidden/);
  assert.match(list, /removeEventListener\("visibilitychange"/, "and the listener goes when the shell does");
  const nav = source("nav.ts");
  for (const k of ["session", "tab", "highlight"]) assert.match(nav, new RegExp(`"${k}"`), `navigateTo keeps ?${k}=`);
  const banner = source("ui/components/UpdateBanner.tsx");
  assert.match(banner, /await quitCheckOrNone\(\)/, "Install & restart asks which sessions run before anything is installed");
  assert.match(banner, /installQuestion\(/, "and decides from the answer with the shared rule");
  assert.match(banner, /<QuitQuestion/, "and asks with the quit question");
  assert.match(banner, /aria-disabled=/, "the button stays focusable while it checks, so focus comes back to it");
  assert.doesNotMatch(banner, /(?<![-\w])disabled=/, "no disabled attribute on the banner's button");
  assert.match(banner, /phaseBefore/, "Keep running restores the phase from before the question (a failed install stays failed)");
  const quit = source("ui/components/QuitQuestion.tsx");
  assert.match(quit, /quitCheckOrNone\(\)/, "the desktop quit flow treats 'sessions do not exist here' as 'none running'");
  assert.match(quit, /createQuitRounds/, "each quit request is its own round");
  assert.match(quit, /rounds\.guard\(/);
  const modal = source("ui/components/AgentConfirmModal.tsx");
  assert.match(modal, /useId\(\)/, "two dialogs open at once get their own title ids");
  assert.doesNotMatch(modal, /"os-modal-title"/);
});

test("wiring: the top bar's Hold to stop all drops its word in a narrow window and keeps its name", () => {
  const css = readFileSync(new URL("../src/ui/shell.css", import.meta.url), "utf8");
  const narrow = css.slice(css.indexOf("@media (max-width: 520px)"));
  assert.match(narrow.slice(0, narrow.indexOf("@media (prefers-reduced-motion")), /\.os-holdstop__label\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/, "clipped, not removed: the button keeps its accessible name");
  assert.doesNotMatch(
    narrow.slice(0, narrow.indexOf("@media (prefers-reduced-motion")),
    /\.os-holdstop__label\s*\{[^}]*display:\s*none/,
    "display: none would take the name away"
  );
});
