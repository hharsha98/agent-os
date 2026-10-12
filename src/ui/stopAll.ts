import { listRuns, stopRun } from "../api";

// What "Hold to stop all" stops (design spec D11): every run that is queued or
// running. From SP3 it also stops every session, inside this same function.
// It never touches the Hermes background service or the OpenClaw Gateway.
const ACTIVE = new Set(["queued", "running"]);

export interface StopAllResult {
  found: number;
  stopped: number;
  failed: number;
  unreachable: boolean;
}

export async function stopEverything(): Promise<StopAllResult> {
  let runs;
  try {
    ({ runs } = await listRuns({ limit: 100 }));
  } catch {
    return { found: 0, stopped: 0, failed: 0, unreachable: true };
  }
  const live = runs.filter((run) => ACTIVE.has(run.status));
  const results = await Promise.allSettled(live.map((run) => stopRun(run.id)));
  const failed = results.filter((result) => result.status === "rejected").length;
  return { found: live.length, stopped: live.length - failed, failed, unreachable: false };
}

export function stopAllMessage(result: StopAllResult): { message: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (result.unreachable) {
    return { message: "Couldn't reach Agent OS, so nothing was stopped. Try again, or stop each run on Runs.", tone: "danger" };
  }
  if (result.found === 0) return { message: "Nothing was running, so there was nothing to stop.", tone: "neutral" };
  const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
  if (result.failed === 0) return { message: `Stopped ${runs(result.stopped)}.`, tone: "ok" };
  return { message: `Stopped ${result.stopped} of ${runs(result.found)}. ${result.failed} could not be stopped: check Runs.`, tone: "warn" };
}
