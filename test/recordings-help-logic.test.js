// Runs → Session recordings (src/ui/recordingsShared.ts) and the Help page's words (src/ui/helpShared.ts): the
// recordings answer checked, what each row offers, the lengths, and what closing the window does on a Mac, on
// Windows and Linux and in a browser tab, with no promise of what arrives later. Node strips the types itself
// (decision P14); neither file imports anything at run time. Row titles are Task U1's sessionTitle (tested in
// test/sessions-shared.test.js). The pages themselves are checked by the sp3-pages probe of the UI audit.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as help from "../src/ui/helpShared.ts";
import * as rec from "../src/ui/recordingsShared.ts";
import * as page from "../src/ui/sessionsPageShared.ts";

const NOW = Date.parse("2026-10-14T15:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const row = (over = {}) => ({
  sessionId: "s1", kind: "agent", agentId: "claude", agentLabel: "Claude Code", folder: "/Users/you/projects/my-app",
  folderName: "my-app", folderShown: true, startedAt: iso(760_000), endedAt: iso(60_000), bytes: 1200, live: false, ...over
});
const session = (over = {}) => ({ id: "s1", status: "exited", resume: { available: true, reason: null, fallback: false }, ...over });

test("the recordings answer is checked: a list, newest first, odd entries made safe or dropped", () => {
  assert.equal(rec.readRecordings(null), null);
  assert.equal(rec.readRecordings({ nope: true }), null);
  assert.equal(rec.readRecordings("junk"), null);
  const body = rec.readRecordings({
    recordings: [
      { sessionId: "a", agentId: "claude", agentLabel: "Claude Code", folder: "/Users/you/my-app", folderName: "my-app", startedAt: iso(600_000), endedAt: iso(60_000), bytes: 1200, live: false },
      { sessionId: "b", kind: "update", agentId: "hermes", agentLabel: "Hermes", folder: "/Users/you/.hermes/hermes-agent", folderName: "hermes-agent", startedAt: iso(30_000), endedAt: null, bytes: 10, live: true },
      { agentId: "codex" },
      "junk"
    ],
    removedByCap: 2
  });
  assert.deepEqual(body.rows.map((r) => [r.sessionId, r.kind, r.live]), [["b", "update", true], ["a", "agent", false]]);
  assert.equal(body.rows[1].folderShown, true, "an answer without folderShown shows the folder");
  assert.equal(body.removedByCap, 2);
  assert.deepEqual(rec.readRecordings([]), { rows: [], removedByCap: 0 }, "a bare list is accepted too");
});

test("what a row offers: open a live session, resume an ended one or say why not, nothing for an update", () => {
  assert.deepEqual(rec.rowAction(row({ live: true }), undefined, "ok"), { kind: "open" });
  assert.deepEqual(rec.rowAction(row({ live: true }), session({ status: "exited" }), "ok"), { kind: "resume", available: true, reason: "" }, "the sessions list is newer: it ended");
  assert.deepEqual(rec.rowAction(row(), session({ status: "live" }), "ok"), { kind: "open" }, "it was resumed since");
  assert.deepEqual(rec.rowAction(row(), session(), "ok"), { kind: "resume", available: true, reason: "" });
  const why = "Another Codex session is open in this folder. Stop it first.";
  assert.deepEqual(rec.rowAction(row(), session({ resume: { available: false, reason: why, fallback: true } }), "ok"), { kind: "resume", available: false, reason: why });
  assert.deepEqual(rec.rowAction(row(), session({ resume: { available: false, reason: null, fallback: false } }), "ok"), { kind: "resume", available: false, reason: "This session can't be resumed." });
  assert.deepEqual(rec.rowAction(row(), undefined, "loading"), { kind: "resume", available: false, reason: "…" });
  assert.deepEqual(rec.rowAction(row(), undefined, "error"), { kind: "resume", available: false, reason: "Agent OS can't check this conversation right now." });
  assert.deepEqual(rec.rowAction(row(), undefined, "ok"), { kind: "resume", available: false, reason: "This session can't be resumed." });
  assert.deepEqual(rec.rowAction(row({ kind: "update", live: true }), undefined, "ok"), { kind: "none" });
  assert.deepEqual(rec.rowAction(row({ kind: "update" }), undefined, "ok"), { kind: "none" });
});

test("lengths: so far for a live one, — when the end is unknown, the same words as the Sessions panel", () => {
  assert.deepEqual(rec.recordingLength(row(), NOW), { value: "11 m 40 s", soFar: false });
  assert.deepEqual(rec.recordingLength(row({ live: true, endedAt: null }), NOW), { value: "12 m 40 s", soFar: true });
  assert.deepEqual(rec.recordingLength(row({ endedAt: null }), NOW), { value: "—", soFar: false });
  for (const ms of [5_000, 61_000, 3_725_000, -1_000]) {
    assert.equal(rec.durationWords(iso(ms), NOW), page.durationWords(iso(ms), NOW), `the copy of durationWords agrees at ${ms} ms`);
  }
});

test("the decided words: the replay note, the cap note, the empty state", () => {
  assert.equal(rec.REPLAY_LATER, "Replay arrives in a later update");
  assert.equal(rec.CAP_NOTE, "Older recordings were removed to stay under 1 GB.");
  assert.equal(rec.EMPTY_TITLE, "No recordings yet");
  assert.equal(rec.EMPTY_BODY, "Every session is recorded here: what its terminal showed, including anything you typed that appeared on screen.");
});

test("help: closing the window says what it really does on a Mac, on Windows and Linux, and in a browser tab", () => {
  const mac = help.lifeSection({ desktop: true, isMac: true });
  assert.equal(mac.title, "Close the window, and nothing stops");
  assert.deepEqual(mac.steps.map((s) => s.title), ["Close the window", "Reopen", "Quit Agent OS", "Resume later"]);
  assert.equal(
    mac.steps[2].body,
    "With ⌘Q or the Quit menu item, Agent OS asks first while sessions run. If you go ahead, it ends them.",
    "only ⌘Q and the Quit item can ask: the Dock's Quit, the app switcher's Quit and logging out cannot (decision Q5b, ruling R19)"
  );
  assert.equal(mac.timeline, true);
  const pc = help.lifeSection({ desktop: true, isMac: false });
  assert.equal(pc.steps[0].title, "Close the window");
  assert.equal(pc.steps[0].body, "Agent OS asks first, then quits and ends your sessions.");
  assert.equal(pc.timeline, false, "the timeline shows a closed window while sessions run, which is not true there");
  assert.doesNotMatch(pc.title, /nothing stops/i);
  assert.ok(!pc.steps.some((s) => /keep running/i.test(s.body)), "no step says sessions keep running after the window closes");
  assert.doesNotMatch(pc.engineNote, /close the window/i);
  const tab = help.lifeSection({ desktop: false, isMac: true });
  assert.equal(tab.steps[0].title, "Close this tab");
  assert.ok(!tab.steps.some((s) => /asks first/.test(s.body)), "a browser tab has no quit question");
});

test("help: every sentence is true today; nothing promises alerts, the Home strip, the badge, notifications or hand-offs", () => {
  const sections = [true, false].flatMap((desktop) => [true, false].map((isMac) => help.lifeSection({ desktop, isMac })));
  const all = [
    help.HELP_TITLE, help.HELP_LEDE, help.ROUTE_TITLE, help.ROUTE_QUIET,
    ...help.ROUTE_WORDS.map((parts) => parts.map((part) => part.text).join("")),
    ...help.PROMISES.flatMap((p) => [p.title, p.body]),
    ...help.GLOSSARY.flatMap((g) => [g.term, g.text]),
    ...sections.flatMap((s) => [s.title, s.quiet, s.engineNote, ...s.steps.flatMap((x) => [x.title, x.body])])
  ].join("\n");
  for (const later of [/tab marker/i, /home strip/i, /badge/i, /notification/i, /hand-off/i, /\balert/i, /send to codex/i, /review guide/i, /watches for/i, /\bhook\b/i, /this Mac/]) {
    assert.doesNotMatch(all, later);
  }
  assert.doesNotMatch(all, /—/, "no em dash in the help words");
  assert.equal(help.HELP_TITLE, "How a session works");
  const stopPromise = help.PROMISES.find((p) => p.id === "stop");
  assert.equal(stopPromise.title, "Stop ends the agent and what runs under it");
  // Ruling R24, verbatim: Stop promises the agent's program and the commands it started in its terminal, and names
  // the two honest limits (a /bg task Agent OS can't find, S7; OpenClaw's last step). R22: the palette's new name.
  // D11: the Hermes background service and the OpenClaw Gateway keep running.
  assert.equal(
    stopPromise.body,
    "Stop on a session, Hold to stop all, or Stop all agent work ends the agent's program and the commands it started in its terminal. A Claude Code background task moved with /bg may keep running if Agent OS can't find it, and OpenClaw may still finish its last step after the terminal closes. The Hermes background service and the OpenClaw Gateway keep running: each has its own Stop on Agents."
  );
  assert.doesNotMatch(
    `${stopPromise.title}\n${stopPromise.body}`,
    /everything it started|every command or helper it launched|Stop all runs/,
    "a Stop never promises more than the agent's own terminal, and the palette item has its SP3 name"
  );
});

// Fix round 1: an update recording that is still being written reads Recording, not Saved. The State cell cannot
// follow rowAction for it (an update row offers nothing), so its own live flag decides.
test("the State word: an update recording being written is Recording, an ended one Saved; agent rows follow their action", () => {
  const state = (over, session, sessionsState = "ok") => {
    const r = row(over);
    return rec.isRecording(r, rec.rowAction(r, session, sessionsState));
  };
  assert.equal(state({ kind: "update", live: true, endedAt: null }, undefined), true, "an update still being written");
  assert.equal(state({ kind: "update", live: false }, undefined), false, "an update that has ended");
  assert.equal(state({ live: true, endedAt: null }, undefined), true, "an agent session that runs");
  assert.equal(state({ live: true }, session({ status: "exited" })), false, "the sessions list is newer: it ended");
  assert.equal(state({}, session({ status: "live" })), true, "it was resumed since");
  assert.equal(state({}, session()), false, "an ended agent session is Saved");
  assert.equal(state({}, undefined, "loading"), false);
});
