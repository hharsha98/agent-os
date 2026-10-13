// Pure logic of the Runs board: which bay a run sits in, the word and colour of its state, the
// task it shows, and the note under a landed strip. No React and no imports except types, so
// `node --test` can load it (test/runs-board.test.js).
import type { RunMeta } from "../types";

export type BayId = "active" | "held" | "landed";
// A subset of the kit's StatusWord states.
export type RunState = "live" | "idle" | "held" | "failed" | "stopped" | "ready" | "unknown";
// The colour of the strip's tab. The word and icon always say the same thing, so colour is never alone.
export type EdgeKind = "live" | "held" | "failed" | "finished" | "stopped" | "idle";

const ACTIVE = new Set(["queued", "running"]);

export function bayOf(run: Pick<RunMeta, "status" | "limit" | "continuedBy">): BayId {
  if (ACTIVE.has(run.status)) return "active";
  // Stopped at the plan's limit and nothing carried it on yet: the person still has a choice to make.
  if (run.limit && !run.continuedBy) return "held";
  return "landed";
}

export function splitBays(runs: RunMeta[]): Record<BayId, RunMeta[]> {
  const bays: Record<BayId, RunMeta[]> = { active: [], held: [], landed: [] };
  for (const run of runs) bays[bayOf(run)].push(run);
  return bays;
}

export function stateOf(run: Pick<RunMeta, "status" | "limit" | "continuedBy">): { state: RunState; label: string; edge: EdgeKind } {
  if (run.status === "queued") return { state: "idle", label: "Queued", edge: "idle" };
  if (run.status === "running") return { state: "live", label: "Working", edge: "live" };
  if (run.limit && run.continuedBy) return { state: "idle", label: "Carried on", edge: "idle" };
  if (run.limit) return { state: "held", label: "Held", edge: "held" };
  switch (run.status) {
    case "succeeded":
      return { state: "ready", label: "Finished", edge: "finished" };
    case "failed":
      return { state: "failed", label: "Failed", edge: "failed" };
    case "timed_out":
      return { state: "failed", label: "Timed out", edge: "failed" };
    case "stopped":
      return { state: "stopped", label: "Stopped", edge: "stopped" };
    case "interrupted":
      return { state: "stopped", label: "Interrupted", edge: "stopped" };
    default:
      // No custom label: the kit's StatusWord then shows its own dash and says "Status unknown" aloud.
      return { state: "unknown", label: "", edge: "idle" };
  }
}

// What the Task column says: the first line of the task the server saved (meta.task.line), else the
// adapter's title (older runs), else the first line of the command, else "Run".
export function taskText(run: Pick<RunMeta, "title" | "commandPreview" | "task">): string {
  const line = typeof run.task?.line === "string" ? run.task.line.trim() : "";
  if (line) return line;
  const title = String(run.title || "").trim();
  if (title) return title;
  const command = String(run.commandPreview || "").split(/\r?\n/)[0].trim();
  return command ? (command.length > 80 ? `${command.slice(0, 79)}…` : command) : "Run";
}

// The quiet sentence under a landed strip that did not finish well. `took` is the duration text
// ("9s", or "—" when unknown). Empty for a run that finished or was stopped on purpose.
export function landedNote(run: Pick<RunMeta, "status" | "limit" | "continuedBy">, took: string): string {
  if (run.limit && run.continuedBy) return "Plan limit reached. This task was carried on in another run.";
  const after = took && took !== "—" ? ` after ${took}` : "";
  if (run.status === "failed") return `The agent stopped with an error${after}. Open it to see what happened.`;
  if (run.status === "timed_out") return `The agent ran out of time${after} and was ended. Open it to see how far it got.`;
  if (run.status === "interrupted") return "This run was cut short before it finished. Open it to see how far it got.";
  return "";
}
