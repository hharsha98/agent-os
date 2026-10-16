// Home's pure logic (src/ui/homeShared.ts): what lights the Orbit, each agent's
// status line, the lede, recent activity and today's spend. Node strips the
// TypeScript types itself (decision P14), so the .ts file is imported directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as home from "../src/ui/homeShared.ts";

// 3 pm LOCAL time, so "today" means the same day in every time zone.
const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const run = (over) => ({
  id: over.id || "run_1", agentId: "claude", kind: "agent", title: "Claude Code (stream-json transport)",
  status: "succeeded", createdAt: iso(60_000), startedAt: iso(60_000), endedAt: iso(30_000),
  exitCode: 0, signal: null, pid: null, cwd: "", commandPreview: "", truncated: false, usage: {}, error: null, ...over
});
const agent = (id, installed = true) => ({ id, label: id, homepage: "", docsUrl: "", license: "", detected: { installed, path: "", version: installed ? "1.0.0" : "", features: {} } });

test("only agent work lights the Orbit; service and setup jobs never do", () => {
  const runs = [
    run({ id: "a", agentId: "claude", status: "running", startedAt: iso(5000), endedAt: null }),
    run({ id: "b", agentId: "hermes", kind: "service", status: "running", endedAt: null }),
    run({ id: "c", agentId: "openclaw", kind: "install", status: "queued", endedAt: null }),
    run({ id: "d", agentId: "openclaw", kind: "team-turn", status: "running", endedAt: null }),
    run({ id: "e", agentId: "codex", status: "succeeded" })
  ];
  assert.deepEqual(home.orbitStates(runs), { claude: "live", openclaw: "live" });
  assert.equal(home.isAgentWork(run({ kind: "pull" })), false);
  assert.equal(home.isAgentWork(run({ kind: "something-new" })), true, "an unknown kind counts as agent work");
});

test("the Orbit's label and note say what is lit, in words", () => {
  assert.equal(home.orbitLabel({}, true), "Agent OS at the centre with five agents around it. No agent is working right now.");
  assert.equal(home.orbitLabel({ claude: "live", openclaw: "live" }, true), "Agent OS at the centre with five agents around it. Working now: OpenClaw, Claude Code.");
  // Fix round 1: while the runs list is unknown, the label claims nothing about what is running.
  assert.equal(home.orbitLabel({}, false), "Agent OS at the centre with five agents around it. What each agent is doing is not known right now.");
  // Fix round 1: no "Amber means it needs you." until SP4 can show amber; both branches read the same.
  assert.equal(home.orbitNote({}), "A line lights only while that agent works.");
  assert.equal(home.orbitNote({ claude: "live" }), "A line lights only while that agent works.");
});

test("each agent's status line: loading, offline, not installed, live, held, ready", () => {
  const live = run({ status: "running", startedAt: iso(125_000), endedAt: null, task: { line: "Fix the login page" } });
  const held = run({ status: "stopped", limit: { kind: "usage_limit", message: "5-hour limit" } });
  assert.deepEqual(home.agentLine({ agents: "loading", runs: "ok", now: NOW }), { state: "loading", where: "" });
  assert.deepEqual(home.agentLine({ agents: "error", runs: "ok", now: NOW }), { state: "unknown", where: "Can't reach Agent OS" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: agent("codex", false), now: NOW }), { state: "unknown", label: "Not installed", where: "Install it from Setup" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: undefined, now: NOW }), { state: "unknown", label: "Not installed", where: "Install it from Setup" });
  // Fix round 1: the elapsed time comes first, so a long task is what gets cut.
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: agent("claude"), live, now: NOW }), { state: "live", where: "2 m · Fix the login page" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: agent("claude"), last: held, now: NOW }), { state: "held", where: "Plan limit reached" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: agent("claude"), last: run({}), now: NOW }), { state: "ready", where: "Nothing running" });
});

test("while the runs list is unknown, no agent is said to be idle (fix round 1)", () => {
  const installed = agent("claude");
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "loading", summary: installed, now: NOW }), { state: "loading", where: "" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "error", summary: installed, now: NOW }), { state: "unknown", where: "Can't tell if it's working" });
  for (const runs of ["loading", "error"]) {
    const line = home.agentLine({ agents: "ok", runs, summary: installed, now: NOW });
    assert.doesNotMatch(line.where, /Nothing running/);
    assert.notEqual(line.state, "ready");
  }
  // An agent that is not installed is known not to be installed, whatever the runs say.
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "error", summary: agent("codex", false), now: NOW }), { state: "unknown", label: "Not installed", where: "Install it from Setup" });
});

test("the live status line never starts or ends with a separator, and the elapsed time stays in view (fix round 1)", () => {
  const base = { agents: "ok", runs: "ok", summary: agent("claude"), now: NOW };
  const live = (over) => run({ status: "running", startedAt: iso(125_000), endedAt: null, ...over });
  // no task text and no title: just the elapsed time
  assert.equal(home.agentLine({ ...base, live: live({ title: "", task: { line: "" } }) }).where, "2 m");
  assert.equal(home.agentLine({ ...base, live: live({ title: "   ", task: { line: "  " } }) }).where, "2 m");
  // no usable start time: just the task
  assert.equal(home.agentLine({ ...base, live: live({ startedAt: null, createdAt: "not a date", task: { line: "Fix the login page" } }) }).where, "Fix the login page");
  // neither: nothing to say
  assert.equal(home.agentLine({ ...base, live: live({ startedAt: null, createdAt: "not a date", title: "", task: { line: "" } }) }).where, "");
  // a long task: the elapsed time is first, so cutting the end never hides it
  const long = home.agentLine({ ...base, live: live({ task: { line: "x".repeat(300) } }) }).where;
  assert.ok(long.startsWith("2 m · "), long);
  for (const text of [long, home.agentLine({ ...base, live: live({ title: "", task: { line: "" } }) }).where]) {
    assert.doesNotMatch(text, /^\s*·|·\s*$/);
  }
});

test("the lede is one honest sentence about right now", () => {
  const five = ["hermes", "openclaw", "claude", "codex", "cursor"].map((id) => agent(id));
  const some = five.map((a, i) => (i < 3 ? a : agent(a.id, false)));
  const none = five.map((a) => agent(a.id, false));
  const lede = (agents, states, runsKnown = true) => home.homeLede({ agents, states, runsKnown });
  assert.equal(lede({ state: "loading" }, {}), "Checking your agents…");
  assert.equal(lede({ state: "error", message: "x" }, {}), "Can't reach Agent OS right now. This page tries again every few seconds.");
  assert.equal(lede({ state: "ok", data: five }, {}), "All five are installed. Nothing is running right now.");
  assert.equal(lede({ state: "ok", data: some }, {}), "3 of 5 agents are installed. Nothing is running right now.");
  assert.equal(lede({ state: "ok", data: none }, {}), "No agents are installed yet. Setup installs them.");
  assert.equal(lede({ state: "ok", data: five }, { claude: "live" }), "Claude Code is working.");
  assert.equal(lede({ state: "ok", data: five }, { claude: "live", hermes: "live" }), "Hermes Agent and Claude Code are working.");
});

test("the lede claims nothing about running work while the runs list is unknown (fix round 1)", () => {
  const five = ["hermes", "openclaw", "claude", "codex", "cursor"].map((id) => agent(id));
  const some = five.map((a, i) => (i < 3 ? a : agent(a.id, false)));
  const none = five.map((a) => agent(a.id, false));
  const lede = (data) => home.homeLede({ agents: { state: "ok", data }, states: {}, runsKnown: false });
  assert.equal(lede(five), "All five are installed.");
  assert.equal(lede(some), "3 of 5 agents are installed.");
  assert.equal(lede(none), "No agents are installed yet. Setup installs them.");
  for (const data of [five, some, none]) {
    assert.doesNotMatch(lede(data), /running|working|ready/i);
  }
  // the agents' own states still win: loading and offline read the same either way
  assert.equal(home.homeLede({ agents: { state: "loading" }, states: {}, runsKnown: false }), "Checking your agents…");
});

test("recent activity shows agent work only, newest first, at most max rows", () => {
  const runs = [run({ id: "1" }), run({ id: "2", kind: "service" }), run({ id: "3" }), run({ id: "4", kind: "configure" }), run({ id: "5" })];
  assert.deepEqual(home.activityRuns(runs, 2).map((r) => r.id), ["1", "3"]);
});

// A newest-first list of `n` runs, one second apart, the oldest `oldestMsAgo` ago.
const listOf = (n, oldestMsAgo, over = () => ({})) =>
  Array.from({ length: n }, (_, i) => {
    const ago = oldestMsAgo - ((oldestMsAgo - 60_000) * (n - 1 - i)) / Math.max(1, n - 1);
    return run({ id: `r${i}`, createdAt: iso(ago), startedAt: iso(ago), ...over(i) });
  });

test("Home asks for the 200 newest runs, and knows when the list came back full (fix round 1)", () => {
  assert.equal(home.HOME_RUNS_LIMIT, 200);
  assert.equal(home.listIsFull(listOf(200, 3_600_000)), true);
  assert.equal(home.listIsFull(listOf(199, 3_600_000)), false);
  assert.equal(home.listIsFull([]), false);
});

test("'No runs yet' is only said when the list is not full (fix round 1)", () => {
  assert.equal(home.noRunsYet([]), true);
  assert.equal(home.noRunsYet([run({ kind: "service" })]), true, "only Agent OS's own jobs so far: still no agent runs");
  assert.equal(home.noRunsYet([run({})]), false);
  // 200 jobs, none of them agent work: older agent runs may exist beyond the list
  const full = listOf(200, 3_600_000, () => ({ kind: "service" }));
  assert.equal(home.activityRuns(full, 8).length, 0);
  assert.equal(home.noRunsYet(full), false);
});

test("spend today adds known costs from today only, and says — when nothing is known", () => {
  assert.equal(home.spendToday([run({ usage: {} })], NOW), "—");
  const today = run({ startedAt: iso(3_600_000), usage: { costUsd: 0.25 } });
  const alsoToday = run({ startedAt: iso(60_000), usage: { costUsd: 0.17 } });
  const yesterday = run({ startedAt: iso(30 * 3_600_000), usage: { costUsd: 9 } });
  assert.equal(home.spendToday([today, alsoToday, yesterday], NOW), "$0.42");
});

test("spend today gets a + when the list is full and even its oldest run is from today (fix round 1)", () => {
  const cost = (i) => (i === 0 ? { usage: { costUsd: 0.25 } } : {});
  // full, and the oldest run is 2 hours old: more of today's runs may be beyond the list
  assert.equal(home.spendToday(listOf(200, 2 * 3_600_000, cost), NOW), "$0.25+");
  // full, but the oldest run is from yesterday: everything from today is in the list
  assert.equal(home.spendToday(listOf(200, 30 * 3_600_000, cost), NOW), "$0.25");
  // not full: nothing is missing
  assert.equal(home.spendToday(listOf(199, 2 * 3_600_000, cost), NOW), "$0.25");
  // full and from today, but no cost is known: still —, never "—+"
  assert.equal(home.spendToday(listOf(200, 2 * 3_600_000), NOW), "—");
});

test("elapsed time reads like the prototype", () => {
  assert.equal(home.elapsedLabel(iso(20_000), NOW), "under 1 m");
  assert.equal(home.elapsedLabel(iso(12 * 60_000 + 40_000), NOW), "12 m");
  assert.equal(home.elapsedLabel(iso(65 * 60_000), NOW), "1 h 05 m");
  assert.equal(home.elapsedLabel(null, NOW), "—");
});

test("withTimeout rejects a request that hangs, so no spinner runs forever", async () => {
  await assert.rejects(home.withTimeout(new Promise(() => {}), 20), /did not answer/);
  assert.equal(await home.withTimeout(Promise.resolve(7), 20), 7);
});

test("a failed refresh keeps the last good data, marked stale; with nothing loaded it is an error (fix round 1)", () => {
  const good = home.loaded([1, 2]);
  assert.deepEqual(good, { state: "ok", data: [1, 2] });
  assert.deepEqual(home.failedLoad(good, "x"), { state: "ok", data: [1, 2], stale: true });
  assert.deepEqual(home.failedLoad(home.failedLoad(good, "x"), "y"), { state: "ok", data: [1, 2], stale: true }, "stays stale");
  assert.deepEqual(home.loaded([3]), { state: "ok", data: [3] }, "a good load clears stale");
  assert.deepEqual(home.failedLoad({ state: "loading" }, "x"), { state: "error", message: "x" });
  assert.deepEqual(home.failedLoad({ state: "error", message: "old" }, "new"), { state: "error", message: "new" });
});

test("Home says it can't reach Agent OS for an error and for stale data, and for nothing else (fix round 1)", () => {
  assert.equal(home.isUnreachable({ state: "loading" }), false);
  assert.equal(home.isUnreachable({ state: "ok", data: [] }), false);
  assert.equal(home.isUnreachable({ state: "ok", data: [], stale: true }), true);
  assert.equal(home.isUnreachable({ state: "error", message: "x" }), true);
});

test("the agents list is retried every 5 s whenever Home can't reach Agent OS, even after a good load (fix round 2)", () => {
  assert.equal(home.agentsPollMs({ state: "loading" }), 30000);
  assert.equal(home.agentsPollMs(home.loaded([])), 30000);
  assert.equal(home.agentsPollMs({ state: "error", message: "x" }), 5000, "never loaded: fast retry");
  // The bug this pins: a failed refresh after a good load leaves state "ok" (stale),
  // so a test on state === "error" alone kept the slow 30 s poll and the banner stayed up.
  const stale = home.failedLoad(home.loaded([1]), "x");
  assert.equal(stale.state, "ok");
  assert.equal(home.agentsPollMs(stale), 5000, "stale data still retries fast");
  assert.equal(home.agentsPollMs(home.loaded([1])), 30000, "a good load goes back to the slow poll");
});

test("an operator's brain: loading, failed, a model without a provider, and truly not set (fix round 1)", () => {
  const info = (over) => ({ agentId: "hermes", installed: true, provider: null, providerLabel: null, model: null, isPreset: false, presetSlug: null, ...over });
  assert.deepEqual(home.operatorBrain(undefined), { kind: "loading" });
  // the lookup failed or timed out: not the same as "not set"
  assert.deepEqual(home.operatorBrain({ state: "failed" }), { kind: "unknown" });
  // a model with no provider label still reads as set (Hermes with only model.default)
  assert.deepEqual(home.operatorBrain({ state: "ok", info: info({ model: "vendor/model-x" }) }), { kind: "set", label: "Model", model: "vendor/model-x" });
  assert.deepEqual(home.operatorBrain({ state: "ok", info: info({ provider: "openrouter", providerLabel: "OpenRouter", model: "vendor/model-x" }) }), { kind: "set", label: "OpenRouter", model: "vendor/model-x" });
  assert.deepEqual(home.operatorBrain({ state: "ok", info: info({ provider: "openrouter", providerLabel: "OpenRouter" }) }), { kind: "set", label: "OpenRouter", model: null });
  // the lookup worked and found neither a provider nor a model
  assert.deepEqual(home.operatorBrain({ state: "ok", info: info({}) }), { kind: "none" });
});

// ---- Final review fixes ------------------------------------------------------

test("an agent that could not be asked (known: false) is an unknown brain, never 'Not set'", () => {
  const info = (over) => ({ agentId: "hermes", installed: true, provider: null, providerLabel: null, model: null, isPreset: false, presetSlug: null, ...over });
  // The server's answer when every `config get` failed: all-empty, but flagged unreadable.
  assert.deepEqual(home.operatorBrain({ state: "ok", info: info({ known: false }) }), { kind: "unknown" });
  // A readable answer (no `known` field) that is really empty is still "none".
  assert.deepEqual(home.operatorBrain({ state: "ok", info: info({}) }), { kind: "none" });
  assert.deepEqual(home.operatorBrain({ state: "ok", info: info({ known: true }) }), { kind: "none" });
});

test("the read limits sit above what the server itself may take, so Retry can succeed on a slow computer", () => {
  // Server worst cases (server/runtime/setup, agents): the brain read re-checks the system (about 15 s) and then runs each
  // agent's doctor (30 s); the agent detail runs the version check (5 s) and the doctor (30 s); the model read makes up to
  // two rounds of 10 s `config get` calls.
  assert.ok(home.BRAIN_READ_LIMIT_MS >= 15_000 + 30_000 + 5_000, "brain read");
  assert.ok(home.AGENT_DETAIL_LIMIT_MS >= 5_000 + 30_000 + 3_000, "agent detail");
  assert.ok(home.MODEL_READ_LIMIT_MS >= 2 * 10_000 + 5_000, "model read");
});

// SP3 (Task U4): sessions count on Home too. The shared sessions list holds agent sessions; an update session
// (Agent OS updating an agent) is never shown on Home.
const sess = (over = {}) => ({
  id: over.id || "11111111-1111-4111-8111-111111111111", kind: "agent", agentId: "claude", agentLabel: "Claude Code",
  folder: "/Users/you/projects/my-app", folderName: "my-app", folderShown: true, branch: null, status: "live",
  stateSince: iso(60_000), startedAt: iso(60_000), endedAt: null, exitCode: null, signal: null, endedBy: null, dismissed: false,
  brain: null, resume: { available: false, reason: null, fallback: false }, alerts: "basic", recordingBytes: 0, ...over
});

test("sessions: only a live session lights its agent's line; starting, idle and ended stay dim", () => {
  const sessions = [
    sess({ id: "a", agentId: "codex", status: "live" }),
    sess({ id: "b", agentId: "hermes", status: "idle" }),
    sess({ id: "c", agentId: "cursor", status: "starting" }),
    sess({ id: "d", agentId: "openclaw", status: "exited" }),
    sess({ id: "e", agentId: "claude", kind: "update", status: "live" })
  ];
  assert.deepEqual(home.orbitStates([], sessions), { codex: "live" });
  assert.deepEqual(home.orbitStates([run({ status: "running", endedAt: null })], sessions), { claude: "live", codex: "live" });
  assert.deepEqual(home.orbitStates([run({ status: "running", endedAt: null })]), { claude: "live" }, "runs alone still work");
});

test("sessions: the open ones are counted, and each agent's newest one is found", () => {
  const sessions = [
    sess({ id: "old", agentId: "claude", startedAt: iso(600_000) }),
    sess({ id: "new", agentId: "claude", status: "idle", startedAt: iso(60_000) }),
    sess({ id: "end", agentId: "codex", status: "exited" }),
    sess({ id: "upd", agentId: "hermes", kind: "update" })
  ];
  assert.deepEqual(home.openSessions(sessions).map((s) => s.id), ["old", "new"]);
  assert.equal(home.openSessionByAgent(sessions).claude.id, "new");
  assert.equal(home.openSessionByAgent(sessions).codex, undefined);
  assert.equal(home.openSessionByAgent(sessions).hermes, undefined);
});

test("each agent's line with a session: live, starting, idle; an unknown sessions list never says Nothing running", () => {
  const a = agent("claude");
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: a, session: sess(), now: NOW }), { state: "live", where: "Session in my-app" });
  // Ruling R26: Starting is the idle icon with the word "Starting" (it never claims "working").
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: a, session: sess({ status: "starting" }), now: NOW }), { state: "idle", label: "Starting", where: "Session in my-app" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: a, session: sess({ status: "idle" }), now: NOW }), { state: "idle", where: "Session in my-app" });
  assert.deepEqual(
    home.agentLine({ agents: "ok", runs: "ok", summary: agent("openclaw"), session: sess({ agentId: "openclaw", folderShown: false }), now: NOW }),
    { state: "live", where: "Session open" }
  );
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", sessions: "loading", summary: a, now: NOW }), { state: "loading", where: "" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", sessions: "error", summary: a, now: NOW }), { state: "unknown", where: "Can't tell if it's working" });
  const live = run({ status: "running", startedAt: iso(125_000), endedAt: null, task: { line: "Fix the login page" } });
  assert.equal(home.agentLine({ agents: "ok", runs: "ok", summary: a, live, session: sess(), now: NOW }).where, "2 m · Fix the login page", "a live run comes first");
});

test("Home's view of the shared sessions list: the sessions as a Source; where sessions don't run, there are none", () => {
  const body = { sessions: [sess()], environmentNotice: null, pty: { ok: true, reason: null }, maxLive: 8 };
  assert.deepEqual(home.sessionsSource({ state: "ok", data: body }, true), { state: "ok", data: [sess()] });
  assert.deepEqual(home.sessionsSource({ state: "ok", data: body, stale: true }, true), { state: "ok", data: [sess()], stale: true });
  assert.deepEqual(home.sessionsSource({ state: "loading" }, true), { state: "loading" });
  assert.deepEqual(home.sessionsSource({ state: "error", message: "x" }, true), { state: "error", message: "x" });
  assert.deepEqual(home.sessionsSource({ state: "error", message: "x" }, false), { state: "ok", data: [] }, "not available: none, which is true");
});

// SP3 (Task U4, fix round 1): an idle or starting session lights no line, but it is open. The lede must not say
// "Nothing is running right now." next to the menu's "1 running" and the agent row's "Session in ...".
test("the lede never says Nothing is running while an agent session is open (starting, idle or live)", () => {
  const five = ["hermes", "openclaw", "claude", "codex", "cursor"].map((id) => agent(id));
  const lede = (sessions, workKnown = true) =>
    home.homeLede({
      agents: { state: "ok", data: five },
      states: home.orbitStates([], sessions),
      runsKnown: home.nothingRunningKnown(workKnown, sessions)
    });
  for (const status of ["starting", "idle"]) {
    const sessions = [sess({ status })];
    assert.deepEqual(home.orbitStates([], sessions), {}, `a ${status} session lights no line`);
    assert.equal(home.nothingRunningKnown(true, sessions), false, `a ${status} session is open, so quiet is not known`);
    assert.equal(lede(sessions), "All five are installed.", `${status}: only the install count, no new sentence`);
    assert.doesNotMatch(lede(sessions), /Nothing is running/);
  }
  assert.equal(lede([sess({ status: "live" })]), "Claude Code is working.", "a live session still names who is working");
  assert.doesNotMatch(lede([sess({ id: "a", status: "idle" }), sess({ id: "b", agentId: "codex", status: "starting" })]), /Nothing is running/);
  // What the lede said before this fix: the work was known and nothing lit, so it claimed quiet.
  assert.equal(
    home.homeLede({ agents: { state: "ok", data: five }, states: home.orbitStates([], [sess({ status: "idle" })]), runsKnown: true }),
    "All five are installed. Nothing is running right now."
  );
  // Nothing open still says it: no session, only ended sessions, only an update session.
  const quiet = "All five are installed. Nothing is running right now.";
  assert.equal(lede([]), quiet);
  assert.equal(lede([sess({ status: "exited" })]), quiet, "an ended session is not open");
  assert.equal(lede([sess({ kind: "update", status: "live" })]), quiet, "an update session never counts on Home");
  // And nothing is claimed until both lists have loaded.
  assert.equal(home.nothingRunningKnown(false, []), false);
  assert.equal(lede([], false), "All five are installed.");
});
