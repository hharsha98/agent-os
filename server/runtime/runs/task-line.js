// The first line of a run's task, saved on the run (meta.task.line) so the Runs
// board can say what the run is for. Only the first line, at most 140 characters,
// and the home folder is written as "~" like every other path the app shows.
import { redactText } from "../safety.js";

const MAX = 140;

export function taskLine(prompt) {
  const first =
    String(prompt ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
  const safe = redactText(first);
  return safe.length > MAX ? `${safe.slice(0, MAX - 1).trimEnd()}…` : safe;
}

// A copy of the run plan with meta.task.line set. Nothing else about the plan changes.
export function withTaskLine(plan, prompt) {
  const line = taskLine(prompt);
  if (!line || !plan || typeof plan !== "object") return plan;
  return { ...plan, meta: { ...(plan.meta || {}), task: { ...(plan.meta?.task || {}), line } } };
}
