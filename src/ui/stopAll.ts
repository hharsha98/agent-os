import { listRuns, stopRun } from "../api";

// What "Hold to stop all" stops (design spec D11, ruling R14): every AGENT run
// that is queued or running, including Team Room turns. From SP3 it also stops
// every session, inside this same function.
// It never touches the Hermes background service or the OpenClaw Gateway, and
// it never interrupts Agent OS's own setup jobs: stopping a gateway restart can
// leave the gateway down, and stopping an install can leave a half-installed tool.
const ACTIVE = new Set(["queued", "running"]);

// Run kinds (meta.kind on the server) that are Agent OS's own jobs, not agent
// work: "service" (gateway start, stop, restart), "install", "configure" and
// "pull" (setup jobs) and "signin". Any other kind, including "agent",
// "team-turn", a missing kind and a kind we have not heard of, IS stopped: an
// emergency stop errs toward stopping agent work.
const NOT_AGENT_WORK = new Set(["service", "install", "configure", "signin", "pull"]);

// The most runs the server returns for one list (the cap in listRuns in
// server/runtime/runs/run-manager.js). It lists the newest first and cannot
// filter by status, so if the list comes back full, older runs were not seen.
export const MAX_RUNS = 1000;

export interface StopAllResult {
  // Active agent runs we tried to stop.
  found: number;
  stopped: number;
  failed: number;
  // Active runs left running on purpose because they are setup or service jobs.
  skipped: number;
  unreachable: boolean;
  // True when the list was full, so older runs may not have been checked.
  listTruncated: boolean;
}

export async function stopEverything(): Promise<StopAllResult> {
  let live: Array<{ id: string }>;
  let skipped: number;
  let listTruncated: boolean;
  try {
    const { runs } = await listRuns({ limit: MAX_RUNS });
    // A reply that is not a list is treated like no reply: we could not check.
    if (!Array.isArray(runs)) throw new Error("unexpected run list");
    listTruncated = runs.length >= MAX_RUNS;
    const active = runs.filter((run) => ACTIVE.has(run.status));
    live = active.filter((run) => !NOT_AGENT_WORK.has(run.kind));
    skipped = active.length - live.length;
  } catch {
    return { found: 0, stopped: 0, failed: 0, skipped: 0, unreachable: true, listTruncated: false };
  }
  const results = await Promise.allSettled(live.map((run) => stopRun(run.id)));
  const failed = results.filter((result) => result.status === "rejected").length;
  return { found: live.length, stopped: live.length - failed, failed, skipped, unreachable: false, listTruncated };
}

export function stopAllMessage(result: StopAllResult): { message: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (result.unreachable) {
    return { message: "Couldn't reach Agent OS, so nothing was stopped. Try again, or stop each run on Runs.", tone: "danger" };
  }
  // Said whenever the list was full: never claim "nothing was running" then.
  const notChecked = result.listTruncated ? " Older runs were not checked." : "";
  // Said whenever setup or service jobs were left running, so the person knows why.
  const left =
    result.skipped === 0
      ? ""
      : result.skipped === 1
        ? " 1 setup or service job was left running. It is not agent work; manage it in Setup or Agents."
        : ` ${result.skipped} setup or service jobs were left running. They are not agent work; manage them in Setup or Agents.`;
  if (result.found === 0) {
    if (result.listTruncated) {
      const head = result.skipped > 0 ? `No agent work was running in the newest ${MAX_RUNS} runs.` : `None of the newest ${MAX_RUNS} runs were running.`;
      return { message: `${head}${left}${notChecked}`, tone: "warn" };
    }
    const head = result.skipped > 0 ? "No agent work was running, so there was nothing to stop." : "Nothing was running, so there was nothing to stop.";
    return { message: `${head}${left}`, tone: "neutral" };
  }
  const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
  if (result.failed === 0) return { message: `Stopped ${runs(result.stopped)}.${left}${notChecked}`, tone: result.listTruncated ? "warn" : "ok" };
  return { message: `Stopped ${result.stopped} of ${runs(result.found)}. ${result.failed} could not be stopped: check Runs.${left}${notChecked}`, tone: "warn" };
}
