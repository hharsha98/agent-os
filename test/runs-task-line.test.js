// The first line of a run's task, recorded on the run so the Runs board can show it.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { taskLine, withTaskLine } from "../server/runtime/runs/task-line.js";

test("taskLine: the first non-empty line, spaces tidied", () => {
  assert.equal(taskLine("Describe this project\nthen list the files"), "Describe this project");
  assert.equal(taskLine("\n\n  Add   a settings\tpage  \nmore"), "Add a settings page");
  assert.equal(taskLine("   \n  "), "");
  assert.equal(taskLine(undefined), "");
});

test("taskLine: long lines end in an ellipsis at 140 characters", () => {
  const line = taskLine("x".repeat(500));
  assert.equal(line.length, 140);
  assert.ok(line.endsWith("…"));
  assert.equal(taskLine("y".repeat(140)), "y".repeat(140));
});

test("taskLine: the home folder never reaches the saved line", () => {
  assert.equal(taskLine(`Read ${os.homedir()}/notes.md`), "Read ~/notes.md");
});

test("withTaskLine: adds task.line and keeps every other part of the plan", () => {
  const onExit = () => {};
  const plan = { agentId: "claude", args: ["-p"], onExit, meta: { brain: { mode: "plan", model: null }, task: { cwd: "/w", allowEdits: false } } };
  const next = withTaskLine(plan, "Describe this project");
  assert.deepEqual(next.meta.task, { cwd: "/w", allowEdits: false, line: "Describe this project" });
  assert.deepEqual(next.meta.brain, { mode: "plan", model: null });
  assert.equal(next.onExit, onExit);
  assert.equal(plan.meta.task.line, undefined, "the original plan is not changed");
});

test("withTaskLine: a plan with no meta (Hermes, OpenClaw) gets one; an empty task changes nothing", () => {
  assert.deepEqual(withTaskLine({ agentId: "hermes", args: [] }, "Summarise my notes").meta, { task: { line: "Summarise my notes" } });
  const plan = { agentId: "hermes", args: [] };
  assert.equal(withTaskLine(plan, "   "), plan);
});
