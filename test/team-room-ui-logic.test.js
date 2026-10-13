// Team Room screen logic (src/ui/teamRoomShared.ts): the status words, the clock that
// stops while a room is paused for a decision (D10), the card states and the timeline.
// Node strips the TypeScript types itself (Node >= 22.18; CI runs 24), so the .ts file is
// imported directly. It must keep only `import type` imports. No server, no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as shared from "../src/ui/teamRoomShared.ts";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const iso = (ms) => new Date(T0 + ms).toISOString();

function room(over = {}) {
  return {
    id: "r1",
    task: "Draft a launch checklist",
    status: "running",
    createdAt: iso(0),
    updatedAt: iso(170_000),
    endedAt: null,
    limits: { maxTurns: 8, maxMinutes: 10, maxCostUsd: null },
    turnsAllowed: 8,
    turnsDone: 4,
    clockStartedAt: iso(0),
    currentTurn: null,
    costUsd: null,
    costKnownTurns: 0,
    costUnknownTurns: 4,
    endReason: null,
    folder: "team/r1",
    ...over
  };
}
function proposal(over = {}) {
  return {
    id: "P1",
    by: "hermes",
    byLabel: "Hermes Agent",
    kind: "file",
    summary: "Launch checklist",
    file: { name: "drafts/launch-checklist.md", content: "# Launch\n- a\n" },
    status: "needs_approval",
    turn: 3,
    createdAt: iso(1000),
    agreedBy: "openclaw",
    ...over
  };
}
function action(over = {}) {
  return {
    id: "A1",
    proposalId: "P1",
    kind: "file_write",
    path: "team/r1/launch-checklist.md",
    created: true,
    updated: false,
    backup: null,
    at: iso(2000),
    undone: false,
    undoneAt: null,
    ...over
  };
}

test("status: a room with pausedFor reads Paused for your decision, otherwise plain needs_you wording", () => {
  const paused = shared.roomStatusView(room({ status: "needs_you", pausedFor: "P1" }));
  assert.deepEqual(paused, { state: "waiting", label: "Paused for your decision" });
  assert.deepEqual(shared.roomStatusView(room({ status: "needs_you", pausedFor: null })), { state: "waiting", label: "Needs you" });
  assert.deepEqual(shared.roomStatusView(room({ status: "needs_you" })), { state: "waiting", label: "Needs you" });
  assert.deepEqual(shared.roomStatusView(room({ status: "needs_you", pausedFor: "" })), { state: "waiting", label: "Needs you" });
  // A stale pausedFor on a room that is not waiting must never read "Paused".
  assert.equal(shared.roomStatusView(room({ status: "running", pausedFor: "P1" })).label, "Talking");
  assert.equal(shared.roomStatusView(room({ status: "stopped", pausedFor: "P1" })).label, "Stopped");
  assert.equal(shared.isPaused(room({ status: "needs_you", pausedFor: "P1" })), true);
  assert.equal(shared.isPaused(room({ status: "failed", pausedFor: "P1" })), false);
});

test("status: every other status has an icon-and-word state, and an unknown one is not hidden", () => {
  const want = {
    running: ["live", "Talking"],
    agreed: ["ready", "Agreed"],
    cost_cap: ["held", "Cost cap reached"],
    stopped: ["stopped", "Stopped"],
    failed: ["failed", "Failed"],
    interrupted: ["stopped", "Interrupted"],
    some_new_state: ["unknown", "some new state"]
  };
  for (const [status, [state, label]] of Object.entries(want)) {
    assert.deepEqual(shared.roomStatusView(room({ status })), { state, label }, status);
  }
});

test("clock: while paused it shows clockUsedMs and never runs (also after a restart)", () => {
  const paused = room({ status: "needs_you", pausedFor: "P1", clockUsedMs: 170_000, updatedAt: iso(171_000) });
  assert.equal(shared.roomElapsedMs(paused, T0 + 170_000), 170_000);
  // One minute later, one day later: the same value. The clock is stopped.
  assert.equal(shared.roomElapsedMs(paused, T0 + 230_000), 170_000);
  assert.equal(shared.roomElapsedMs(paused, T0 + 86_400_000), 170_000);
});

test("clock: running counts from clockStartedAt (the server rewinds it on resume); ended rooms stop at the end", () => {
  assert.equal(shared.roomElapsedMs(room({ status: "running" }), T0 + 61_000), 61_000);
  // A resumed room: clockUsedMs is old news, the running clock follows clockStartedAt.
  assert.equal(shared.roomElapsedMs(room({ status: "running", clockUsedMs: 170_000 }), T0 + 200_000), 200_000);
  assert.equal(shared.roomElapsedMs(room({ status: "stopped", endedAt: iso(90_000) }), T0 + 999_000), 90_000);
  // needs_you at a limit (not paused): ends at updatedAt, and clockUsedMs is ignored.
  assert.equal(shared.roomElapsedMs(room({ status: "needs_you", pausedFor: null, clockUsedMs: 5_000 }), T0 + 999_000), 170_000);
  assert.equal(shared.roomElapsedMs(room({ clockStartedAt: "not a date" }), T0), null);
});

test("clock: minutesLabel", () => {
  assert.equal(shared.minutesLabel(170_000), "2m 50s");
  assert.equal(shared.minutesLabel(9_000), "9s");
  assert.equal(shared.minutesLabel(-5), "0s");
});

test("end sentence: paused says nothing extra, agreed has a D10 fallback, a limit keeps its text", () => {
  assert.equal(shared.roomEndSentence(room({ status: "needs_you", pausedFor: "P1" })), null);
  assert.match(shared.roomEndSentence(room({ status: "agreed", endReason: null })), /approved a file/);
  assert.match(shared.roomEndSentence(room({ status: "needs_you", pausedFor: null })), /Continue to give them more/);
  assert.equal(shared.roomEndSentence(room({ status: "running" })), null);
});

test("lede: one sentence per state", () => {
  assert.match(shared.roomLede(room({ status: "running" })), /reading along/);
  assert.match(shared.roomLede(room({ status: "needs_you", pausedFor: "P1" })), /Nothing is saved until you decide/);
  assert.match(shared.roomLede(room({ status: "stopped" })), /has ended/);
});

test("card state: where each proposal belongs", () => {
  const f = (p, a) => shared.decisionCardState(p, a);
  assert.equal(f(proposal(), undefined), "pending");
  assert.equal(f(proposal({ status: "applied", actionId: "A1" }), action()), "saved");
  assert.equal(f(proposal({ status: "applied", actionId: "A1" }), action({ undone: true })), "undone");
  assert.equal(f(proposal({ status: "refused" }), action({ failed: true, failReason: "a link is in the way" })), "refused");
  assert.equal(f(proposal({ status: "rejected", userDecision: "reject" }), undefined), "rejected");
  assert.equal(f(proposal({ kind: "decision", file: undefined, status: "approved" }), undefined), "recorded");
  assert.equal(f(proposal({ status: "open" }), undefined), "talking");
  assert.equal(f(proposal({ status: "disputed" }), undefined), "talking");
  assert.equal(f(proposal({ status: "agreed" }), undefined), "talking");
});

test("card order: the proposal the room is paused on comes first among the ones waiting for you", () => {
  const list = [
    proposal({ id: "P1", turn: 1, status: "open" }),
    proposal({ id: "P2", turn: 2, status: "needs_approval", kind: "decision", file: undefined }),
    proposal({ id: "P3", turn: 3, status: "needs_approval" }),
    proposal({ id: "P4", turn: 4, status: "rejected" }),
    proposal({ id: "P5", turn: 5, status: "applied", actionId: "A1" })
  ];
  const ordered = shared.orderProposals(list, [action({ proposalId: "P5" })], "P3");
  assert.deepEqual(ordered.needs.map((p) => p.id), ["P3", "P2"]);
  assert.deepEqual(ordered.settled.map((p) => p.id), ["P4", "P5"]);
  assert.deepEqual(ordered.talking.map((p) => p.id), ["P1"]);
  assert.deepEqual(shared.orderProposals(list, [], null).needs.map((p) => p.id), ["P2", "P3"]);
});

test("timeline: turns and Agent OS rows in event order, and agreement never says it saved", () => {
  const events = [
    { seq: 1, t: iso(1000), type: "turn_started", turn: 1, agentId: "hermes", runId: "run-1" },
    { seq: 2, t: iso(14_000), type: "turn_ended", turn: 1, agentId: "hermes", runId: "run-1", status: "succeeded", text: "Hello" },
    { seq: 3, t: iso(15_000), type: "turn_started", turn: 2, agentId: "openclaw", runId: "run-2" },
    { seq: 4, t: iso(40_000), type: "turn_ended", turn: 2, agentId: "openclaw", runId: "run-2", status: "succeeded", text: "I agree" },
    { seq: 5, t: iso(40_100), type: "proposal_status", proposalId: "P1", status: "needs_approval", reason: "Both agents agree. Waiting for your approval." },
    { seq: 6, t: iso(60_000), type: "proposal_decided", proposalId: "P1", decision: "approve", status: "applied" },
    { seq: 7, t: iso(70_000), type: "action_undone", actionId: "A1", proposalId: "P1", path: "team/r1/launch-checklist.md" },
    { seq: 8, t: iso(80_000), type: "limits_extended", extraTurns: 4, turnsAllowed: 12 }
  ];
  const items = shared.deriveTimeline(events, [proposal({ status: "applied" })], [action()]);
  assert.deepEqual(items.map((i) => i.kind), ["turn", "turn", "system", "system", "system", "system"]);
  assert.equal(items[0].turn.turn, 1);
  assert.equal(items[1].turn.agentId, "openclaw");
  const [, , ask, approved, undone, more] = items;
  assert.equal(ask.tone, "ask");
  assert.equal(ask.who, "Agent OS");
  assert.match(ask.text, /both agents agreed on drafts\/launch-checklist\.md/);
  assert.match(ask.text, /waits for you instead of saving by itself/);
  assert.equal(approved.who, "You");
  assert.match(approved.text, /approved drafts\/launch-checklist\.md/);
  assert.match(undone.text, /undid the save of team\/r1\/launch-checklist\.md/);
  assert.equal(undone.tone, "undo");
  assert.match(more.text, /gave the room 4 more turns/);
});

test("timeline: a rejection and a refused write read honestly; unknown ids do not crash", () => {
  const events = [
    { seq: 1, t: iso(0), type: "proposal_decided", proposalId: "P1", decision: "reject", status: "rejected" },
    { seq: 2, t: iso(1), type: "proposal_decided", proposalId: "P2", decision: "approve", status: "refused" },
    { seq: 3, t: iso(2), type: "proposal_status", proposalId: "P9", status: "needs_approval" },
    { seq: 4, t: iso(3), type: "limits_extended", extraTurns: 1, turnsAllowed: 9 }
  ];
  const items = shared.deriveTimeline(events, [proposal({ status: "rejected" }), proposal({ id: "P2", status: "refused" })], []);
  assert.match(items[0].text, /rejected drafts\/launch-checklist\.md\. Nothing was saved/);
  assert.equal(items[1].who, "Agent OS");
  assert.match(items[1].text, /could not save/);
  assert.match(items[2].text, /P9/);
  assert.match(items[3].text, /gave the room 1 more turn\./);
});

test("so far: messages passed, files saved now, and what waits", () => {
  const events = [
    { seq: 1, t: iso(0), type: "turn_started", turn: 1, agentId: "hermes", runId: "a" },
    { seq: 2, t: iso(1), type: "turn_ended", turn: 1, agentId: "hermes", runId: "a", status: "succeeded", text: "x" },
    { seq: 3, t: iso(2), type: "turn_started", turn: 2, agentId: "openclaw", runId: "b" }
  ];
  const turns = shared.deriveTurns(events);
  const so = shared.roomSoFar(
    turns,
    [proposal(), proposal({ id: "P2", kind: "decision", file: undefined })],
    [action(), action({ id: "A2", undone: true }), action({ id: "A3", failed: true })]
  );
  assert.equal(so.messages, 1);
  assert.equal(so.saved, 1);
  assert.deepEqual(so.savedPaths, ["team/r1/launch-checklist.md"]);
  assert.equal(so.waitingFiles, 1);
  assert.equal(so.waitingOther, 1);
});

test("small helpers: tags are sentence case, file kinds, previews, clock time, plurals", () => {
  assert.equal(shared.tagLabel({ kind: "note" }), "Note");
  assert.equal(shared.tagLabel({ kind: "propose_file" }), "File proposal");
  assert.equal(shared.tagLabel({ kind: "agree", proposalId: "P1" }), "Agrees with P1");
  assert.equal(shared.tagLabel({ kind: "disagree", proposalId: "P2" }), "Disagrees with P2");
  assert.equal(shared.hasTag({ kind: "none" }), false);
  assert.equal(shared.hasTag(undefined), false);
  for (const kind of ["note", "propose", "propose_file", "agree", "disagree", "none"]) {
    assert.doesNotMatch(shared.tagLabel({ kind }), /^[A-Z ]{4,}$/, `${kind} must not be typed in capitals`);
  }
  assert.equal(shared.fileKindLabel("a/b.md"), "Markdown");
  assert.equal(shared.fileKindLabel("notes.TXT"), "Plain text");
  assert.equal(shared.fileKindLabel("page.html"), "HTML");
  assert.equal(shared.fileKindLabel("x.bin"), "File");
  assert.deepEqual(shared.previewLines("a\nb\nc\nd\n", 2), { lines: ["a", "b"], more: 2 });
  assert.deepEqual(shared.previewLines("a\r\nb", 6), { lines: ["a", "b"], more: 0 });
  assert.equal(shared.clockTime("not a date"), "—");
  assert.equal(shared.clockTime(undefined), "—");
  assert.match(shared.clockTime("2026-10-12T10:00:00.000Z"), /\d/);
  assert.equal(shared.plural(1, "turn"), "1 turn");
  assert.equal(shared.plural(0, "turn"), "0 turns");
  assert.equal(shared.plural(2, "file", "files"), "2 files");
});

test("turn status: a finished turn shows nothing, a bad one shows a word", () => {
  assert.equal(shared.turnStatusView("succeeded"), null);
  assert.equal(shared.turnStatusView(undefined), null);
  assert.deepEqual(shared.turnStatusView("failed"), { state: "failed", label: "Failed" });
  assert.deepEqual(shared.turnStatusView("timed_out"), { state: "failed", label: "Timed out" });
  assert.deepEqual(shared.turnStatusView("stopped"), { state: "stopped", label: "Stopped" });
});

// ---- Fix round 1 ----------------------------------------------------------------------

test("card copy: the page only promises what it knows (agents told, where the file is)", () => {
  const copy = (state, p, a, told) => shared.decisionCardCopy(state, p, a, told);
  const rejected = proposal({ status: "rejected", userDecision: "reject" });
  // Always true: no promise about the agents unless this page's own decision ended the pause.
  assert.equal(copy("rejected", rejected, undefined, false).sub, "You said no. Nothing was saved.");
  assert.equal(copy("rejected", rejected, undefined, true).sub, "You said no. Nothing was saved. The agents are told in their next turn.");
  const decisionCard = proposal({ kind: "decision", file: undefined, status: "rejected" });
  assert.equal(copy("rejected", decisionCard, undefined, false).sub, "You said no. Nothing was changed.");
  assert.equal(copy("rejected", rejected, undefined, false).title, "Rejected, nothing saved");
  // The room running or not does not change what the card says: the function does not even take the room.
  assert.equal(shared.decisionCardCopy.length, 4);
  // Approve: where the file is comes only from the action.
  const saved = proposal({ status: "applied", actionId: "A1" });
  assert.equal(copy("saved", saved, undefined, false).sub, "You approved it.");
  assert.match(copy("saved", saved, action(), false).sub, /saved in the Workspace sandbox/);
  assert.doesNotMatch(copy("saved", saved, undefined, false).sub, /sandbox/);
  assert.doesNotMatch(copy("saved", saved, action(), false).sub, /told/);
  // The other states keep their words.
  assert.equal(copy("recorded", proposal({ kind: "decision", file: undefined, status: "approved" }), undefined, false).sub, "You approved it. Nothing was run.");
  assert.match(copy("undone", saved, action({ undone: true }), false).sub, /gone from the Workspace again/);
  assert.match(copy("undone", saved, action({ undone: true, created: false }), false).sub, /earlier copy back/);
  assert.match(copy("pending", proposal(), undefined, false).sub, /Hermes Agent proposed it in turn 3\. OpenClaw agreed\./);
  assert.equal(copy("refused", proposal({ status: "refused" }), action({ failed: true, failReason: "a link is in the way" }), false).sub, "a link is in the way");
  // The note on a card the room is paused on never says it will certainly carry on.
  assert.match(shared.PAUSED_CARD_NOTE, /if it can/);
  assert.match(shared.PAUSED_CARD_NOTE, /in their next turn/);
});

test("card memory: the key is the room plus the proposal, so one room never leaks into another", () => {
  assert.equal(shared.decisionKey("r1", "P1"), "r1:P1");
  assert.notEqual(shared.decisionKey("r1", "P1"), shared.decisionKey("r2", "P1"));
  assert.notEqual(shared.decisionKey("r1", "P1"), shared.decisionKey("r1", "P2"));
});

test("turn phase: a started turn of a running room is in progress, not 'never reported back'", () => {
  const started = { turn: 5, runId: "run-5", ended: null };
  const ended = { turn: 4, runId: "run-4", ended: { seq: 8 } };
  const ctx = (over = {}) => ({ running: true, currentRunId: null, latestTurn: 5, ...over });
  // The room says which run is current: live (with the console).
  assert.equal(shared.turnPhase(started, ctx({ currentRunId: "run-5" })), "live");
  // The room does not say yet (a gap between the event and the room file): still in progress.
  assert.equal(shared.turnPhase(started, ctx()), "working");
  assert.equal(shared.turnPhase(ended, ctx()), "ended");
  // Not the latest turn and no report: not in progress.
  assert.equal(shared.turnPhase({ turn: 3, runId: "run-3", ended: null }, ctx()), "never");
  // The room is not running: the turn never reported back, whichever turn it is.
  assert.equal(shared.turnPhase(started, ctx({ running: false })), "never");
  assert.equal(shared.turnPhase(started, ctx({ running: false, currentRunId: "run-5" })), "never");
  // The sentence for each case.
  assert.equal(shared.turnMissingText(false), "This turn never reported back (the room stopped first).");
  assert.doesNotMatch(shared.turnMissingText(true), /never reported back/);
});

test("latest started turn: read from the timeline rows", () => {
  const turnRow = (n) => ({ kind: "turn", key: `turn-${n}`, turn: { turn: n, runId: `run-${n}`, ended: null } });
  const sys = { kind: "system", key: "sys-1", tone: "plain", who: "You", text: "x" };
  assert.equal(shared.latestStartedTurn([turnRow(1), sys, turnRow(3), turnRow(2)]), 3);
  assert.equal(shared.latestStartedTurn([sys]), null);
  assert.equal(shared.latestStartedTurn([]), null);
});

test("cost: the note says an em dash until a turn reports a cost; a real zero reads $0.000", () => {
  // Nothing reported yet (the server keeps costUsd null and costKnownTurns 0).
  const none = room({ costUsd: null, costKnownTurns: 0, costUnknownTurns: 4, cost: { knownUsd: 0, unknownTurns: 4 } });
  assert.equal(shared.costNotReported(none), true);
  assert.equal(shared.roomCostText(none), "— known · 4 turns unknown");
  // Older rooms without the cost object.
  assert.equal(shared.costNotReported(room({ costUsd: null, costKnownTurns: 0 })), true);
  assert.equal(shared.roomCostText(room({ costUsd: null, costKnownTurns: 0, costUnknownTurns: 1 })), "— known · 1 turn unknown");
  // A turn reported exactly zero: that is a fact, not an unknown.
  const zero = room({ costUsd: 0, costKnownTurns: 2, costUnknownTurns: 2, cost: { knownUsd: 0, unknownTurns: 2 } });
  assert.equal(shared.costNotReported(zero), false);
  assert.equal(shared.roomCostText(zero), "$0.000 known · 2 turns unknown");
  // A real amount.
  const some = room({ costUsd: 0.0123, costKnownTurns: 1, costUnknownTurns: 0, cost: { knownUsd: 0.0123, unknownTurns: 0 } });
  assert.equal(shared.costNotReported(some), false);
  assert.equal(shared.roomCostText(some), "$0.012 known · 0 turns unknown");
});

test("unreachable: Agent OS did not answer, so the page never claims nothing changed", () => {
  const room_ = shared.unreachableMessage("room");
  assert.equal(room_, "Agent OS did not answer, so this may not have gone through. The page re-checks the room.");
  assert.equal(shared.unreachableMessage(), room_);
  assert.equal(shared.unreachableMessage("rooms"), "Agent OS did not answer, so this may not have gone through. The page re-checks your rooms.");
  assert.doesNotMatch(room_, /Nothing was changed/);
});
