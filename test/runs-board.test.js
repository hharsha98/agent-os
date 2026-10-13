// Pure logic of the Runs board and the New run dialog (src/ui/runsBoard.ts, src/ui/newRun.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bayOf, landedNote, splitBays, stateOf, taskText } from "../src/ui/runsBoard.ts";
import {
  NEW_RUN_EVENT, RISKY_STEP_HINT, folderProblem, folderSuggestions, gateBlock, levelWord, openNewRun, pickAgent, startError, taskCount, taskProblem, taskTooLong
} from "../src/ui/newRun.ts";

const run = (over = {}) => ({ id: "run_1", agentId: "claude", status: "succeeded", title: "", commandPreview: "", ...over });
const LIMIT = { kind: "five_hour", message: "Claude Code's plan limit was reached." };

test("bays: working runs are Active; a plan limit that nothing carried on is Held; the rest Landed", () => {
  assert.equal(bayOf(run({ status: "running" })), "active");
  assert.equal(bayOf(run({ status: "queued" })), "active");
  assert.equal(bayOf(run({ status: "failed" })), "landed");
  assert.equal(bayOf(run({ status: "stopped", limit: LIMIT })), "held");
  assert.equal(bayOf(run({ status: "succeeded", limit: LIMIT })), "held", "an agent that exits 0 at its limit did not finish");
  assert.equal(bayOf(run({ status: "stopped", limit: LIMIT, continuedBy: "run_2" })), "landed");
  const split = splitBays([run({ id: "a", status: "running" }), run({ id: "b", status: "failed" }), run({ id: "c", limit: LIMIT }), run({ id: "d" })]);
  assert.deepEqual([split.active, split.held, split.landed].map((list) => list.map((r) => r.id)), [["a"], ["c"], ["b", "d"]], "the API order (newest first) is kept");
});

test("state words: icon state, word and strip colour for every status", () => {
  const word = (over) => { const s = stateOf(run(over)); return `${s.state}|${s.label}|${s.edge}`; };
  assert.equal(word({ status: "running" }), "live|Working|live");
  assert.equal(word({ status: "queued" }), "idle|Queued|idle");
  assert.equal(word({ status: "succeeded" }), "ready|Finished|finished");
  assert.equal(word({ status: "failed" }), "failed|Failed|failed");
  assert.equal(word({ status: "timed_out" }), "failed|Timed out|failed");
  assert.equal(word({ status: "stopped" }), "stopped|Stopped|stopped");
  assert.equal(word({ status: "interrupted" }), "stopped|Interrupted|stopped");
  assert.equal(word({ status: "stopped", limit: LIMIT }), "held|Held|held");
  assert.equal(word({ status: "stopped", limit: LIMIT, continuedBy: "run_2" }), "idle|Carried on|idle");
  assert.equal(word({ status: "something_new" }), "unknown||idle", "no custom label: StatusWord shows its own dash and says 'Status unknown' aloud");
});

test("task text: the saved first line, else the title, else the command, else 'Run'", () => {
  assert.equal(taskText(run({ task: { line: "  Describe this project " }, title: "Claude Code (stream-json transport)" })), "Describe this project");
  assert.equal(taskText(run({ title: "Hermes gateway start" })), "Hermes gateway start");
  assert.equal(taskText(run({ commandPreview: "/usr/bin/claude -p\nsecond line" })), "/usr/bin/claude -p");
  assert.equal(taskText(run()), "Run");
});

test("landed notes: plain words, and the time only when it is known", () => {
  assert.equal(landedNote(run({ status: "failed" }), "9s"), "The agent stopped with an error after 9s. Open it to see what happened.");
  assert.equal(landedNote(run({ status: "failed" }), "—"), "The agent stopped with an error. Open it to see what happened.");
  assert.match(landedNote(run({ status: "timed_out" }), "5m 0s"), /^The agent ran out of time after 5m 0s/);
  assert.match(landedNote(run({ status: "interrupted" }), "—"), /^This run was cut short/);
  assert.equal(landedNote(run({ status: "succeeded" }), "20s"), "");
  assert.match(landedNote(run({ status: "stopped", limit: LIMIT, continuedBy: "r2" }), "—"), /carried on in another run/);
});

test("safety block: Look only, gate off, or nothing in the way", () => {
  assert.equal(gateBlock(null), null);
  assert.equal(gateBlock({ enabled: true, level: 1 }), null);
  assert.equal(gateBlock({ enabled: true, level: 2 }), null);
  assert.equal(gateBlock({ enabled: false, level: 0 }).kind, "look-only");
  assert.equal(gateBlock({ enabled: true, level: 0 }).kind, "look-only", "level 0 wins even if an older server says enabled");
  assert.equal(gateBlock({ enabled: false }).kind, "gate-off");
  assert.match(gateBlock({ enabled: false, level: 0 }).text, /Look only.*Safety/);
  assert.match(gateBlock({ enabled: false }).text, /switched off.*Safety/);
  assert.equal(levelWord({ enabled: true, level: 1 }), "Level 1 · Run agents");
  assert.equal(levelWord({ enabled: false }), "Level 0 · Look only");
  assert.equal(levelWord(null), "");
});

test("task and folder checks give plain reasons", () => {
  assert.equal(taskProblem("   "), "Write what the agent should do first.");
  assert.equal(taskProblem("Describe this project"), "");
  assert.match(taskProblem("x".repeat(20001)), /too long.*20,000/);
  assert.equal(folderProblem(""), "");
  assert.equal(folderProblem("notes/today"), "");
  for (const bad of ["/tmp", "~/work", "C:\\Users\\me", "\\\\server\\share"]) assert.match(folderProblem(bad), /inside the Workspace/, bad);
  for (const bad of ["..", "../x", "a/../b"]) assert.match(folderProblem(bad), /go up/, bad);
});

test("task length: the count shows only near the limit, and too long is its own check", () => {
  assert.equal(taskCount("x".repeat(100)), "");
  assert.equal(taskCount("x".repeat(17999)), "");
  assert.equal(taskCount("x".repeat(18000)), "18,000 of 20,000 characters");
  assert.equal(taskCount("x".repeat(20050)), "20,050 of 20,000 characters");
  assert.equal(taskCount("   "), "");
  assert.equal(taskTooLong("x".repeat(20000)), false);
  assert.equal(taskTooLong("x".repeat(20001)), true);
  assert.equal(taskTooLong(` ${"x".repeat(20000)} `), false, "spaces around the task are not counted");
  assert.match(taskProblem("x".repeat(20050)), /too long.*20,000/, "the reason is reachable now that the field no longer cuts the text");
});

test("agent choice: the asked-for one, else the first installed, else the first", () => {
  const agents = [{ id: "hermes", detected: { installed: false } }, { id: "claude", detected: { installed: true } }, { id: "codex", detected: { installed: true } }];
  const order = ["hermes", "openclaw", "claude", "codex", "cursor"];
  assert.equal(pickAgent(agents, order, "codex"), "codex");
  assert.equal(pickAgent(agents, order, "nope"), "claude");
  assert.equal(pickAgent(agents, order, "foo"), "claude", "an unknown id in a link falls back to the first installed agent");
  assert.equal(pickAgent(agents, order, ""), "claude", "an empty id means no preference");
  assert.equal(pickAgent(agents, order), "claude");
  assert.equal(pickAgent(null, order), "hermes");
  assert.equal(pickAgent([], order), "hermes");
});

test("folder suggestions: real Workspace folders, two levels deep, sorted", () => {
  const files = [
    { root: "workspace", relativePath: "welcome.md" },
    { root: "workspace", relativePath: "runs-work/claude/a.txt" },
    { root: "workspace", relativePath: "runs-work/claude/deep/b.txt" },
    { root: "workspace", relativePath: "notes\\today.md" },
    { root: "exports", relativePath: "export-folder/x.md" }
  ];
  assert.deepEqual(folderSuggestions(files), ["notes", "runs-work", "runs-work/claude"]);
  assert.deepEqual(folderSuggestions([]), []);
});

test("start errors: known codes get words and a fix; unknown codes are left to the caller", () => {
  assert.equal(startError("execution_gate_off").fix, "safety");
  assert.match(startError("execution_gate_off").text, /Look only/);
  assert.equal(startError("folder_outside_sandbox").fix, "folder");
  assert.match(startError("too_many_runs").text, /Wait for one to finish/);
  assert.equal(startError("something_else"), null);
});

test("openNewRun: sends one event carrying the request; the hint is the spec's words", () => {
  globalThis.window = new EventTarget();
  const seen = [];
  window.addEventListener(NEW_RUN_EVENT, (event) => seen.push(event.detail));
  openNewRun();
  openNewRun({ agentId: "claude", prompt: "Look around" });
  assert.deepEqual(seen, [{}, { agentId: "claude", prompt: "Look around" }]);
  assert.equal(RISKY_STEP_HINT, "Anything this safety level does not allow is refused, not run.");
  assert.doesNotMatch(RISKY_STEP_HINT, /Held/, "the server's only Held is a plan limit (D-C3-5)");
});
