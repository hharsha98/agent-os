// Small shared facts for the Setup Assistant's two groups, so the Plan screen,
// the confirm dialog and the progress screen all say the same thing.
import type { SetupPlanStep } from "../setupApi";

export const OPERATOR_IDS = ["hermes", "openclaw"] as const;
export const CODING_IDS = ["claude", "codex", "cursor"] as const;

export const AGENT_NAMES: Record<string, string> = {
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor CLI"
};

export function formatSize(mb: number) {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.max(10, Math.round(mb / 10) * 10)} MB`;
}

export function formatMinutes(range: [number, number]) {
  const [low, high] = range;
  return low === high ? `${low} min` : `${low}–${high} min`;
}

// Adds up the "about" figures of the steps that would run. `complete` is false
// when a step had no figure, so the screen never shows a partial sum as a total.
export function totalsOf(steps: SetupPlanStep[]) {
  let mb = 0;
  let low = 0;
  let high = 0;
  let complete = steps.length > 0;
  for (const step of steps) {
    if (typeof step.approxMb !== "number" || !step.approxMinutes) {
      complete = false;
      continue;
    }
    mb += step.approxMb;
    low += step.approxMinutes[0];
    high += step.approxMinutes[1];
  }
  return { mb, minutes: [low, high] as [number, number], complete };
}
