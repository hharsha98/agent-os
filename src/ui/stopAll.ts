import { listRuns, stopRun } from "../api";

// What "Hold to stop all" stops (design spec D11): every run that is queued or
// running. From SP3 it also stops every session, inside this same function.
// It never touches the Hermes background service or the OpenClaw Gateway.
const ACTIVE = new Set(["queued", "running"]);

// The most runs the server returns for one list (the cap in listRuns in
// server/runtime/runs/run-manager.js). It lists the newest first and cannot
// filter by status, so if the list comes back full, older runs were not seen.
const MAX_RUNS = 1000;

export interface StopAllResult {
  found: number;
  stopped: number;
  failed: number;
  unreachable: boolean;
  // True when the list was full, so older runs may not have been checked.
  listTruncated: boolean;
}

export async function stopEverything(): Promise<StopAllResult> {
  let live: Array<{ id: string }>;
  let listTruncated: boolean;
  try {
    const { runs } = await listRuns({ limit: MAX_RUNS });
    // A reply that is not a list is treated like no reply: we could not check.
    if (!Array.isArray(runs)) throw new Error("unexpected run list");
    listTruncated = runs.length >= MAX_RUNS;
    live = runs.filter((run) => ACTIVE.has(run.status));
  } catch {
    return { found: 0, stopped: 0, failed: 0, unreachable: true, listTruncated: false };
  }
  const results = await Promise.allSettled(live.map((run) => stopRun(run.id)));
  const failed = results.filter((result) => result.status === "rejected").length;
  return { found: live.length, stopped: live.length - failed, failed, unreachable: false, listTruncated };
}

export function stopAllMessage(result: StopAllResult): { message: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (result.unreachable) {
    return { message: "Couldn't reach Agent OS, so nothing was stopped. Try again, or stop each run on Runs.", tone: "danger" };
  }
  // Said whenever the list was full: never claim "nothing was running" then.
  const notChecked = result.listTruncated ? " Older runs were not checked. Open Runs to make sure." : "";
  if (result.found === 0) {
    if (result.listTruncated) return { message: `None of the newest ${MAX_RUNS} runs were running.${notChecked}`, tone: "warn" };
    return { message: "Nothing was running, so there was nothing to stop.", tone: "neutral" };
  }
  const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
  if (result.failed === 0) return { message: `Stopped ${runs(result.stopped)}.${notChecked}`, tone: result.listTruncated ? "warn" : "ok" };
  return { message: `Stopped ${result.stopped} of ${runs(result.found)}. ${result.failed} could not be stopped: check Runs.${notChecked}`, tone: "warn" };
}
