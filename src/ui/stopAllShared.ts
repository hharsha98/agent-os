// The logic behind "Hold to stop all" and the palette's "Stop all runs" (design spec D11,
// ruling R14), with no imports except types, so the logic tests can load it straight
// from src/ with Node. The pieces that talk to Agent OS (listRuns, stopRun, listTeamRooms,
// stopTeamRoom) and the agent-work rule (agentWork.ts) are passed in; stopAll.ts passes
// the real ones.
//
// What it stops: every AGENT run that is queued or running, and every Team Room that is
// running (a room between two turns has no active run, so stopping runs alone would miss
// it and its next turn would start). It never touches the Hermes background service or
// the OpenClaw Gateway, and it never interrupts Agent OS's own setup jobs: stopping a
// gateway restart can leave the gateway down, and stopping an install can leave a
// half-installed tool.
import type { RunMeta, TeamRoomSummary } from "../types";

const ACTIVE = new Set(["queued", "running"]);

// A hung server must never leave a button on "Stopping…" for ever.
export const LIST_TIMEOUT_MS = 8000;
export const STOP_TIMEOUT_MS = 15000;

// The most runs the server returns for one list (the cap in listRuns in
// server/runtime/runs/run-manager.js). It lists the newest first and cannot
// filter by status, so if the list comes back full, older runs were not seen.
export const MAX_RUNS = 1000;

export type StoppableRun = Pick<RunMeta, "id" | "kind" | "status"> & { title?: string };
export type StoppableRoom = Pick<TeamRoomSummary, "id" | "status"> & { task?: string };

export interface StopAllDeps {
  listRuns: (limit: number) => Promise<{ runs: StoppableRun[] }>;
  stopRun: (id: string) => Promise<unknown>;
  listRooms: () => Promise<{ rooms: StoppableRoom[] }>;
  stopRoom: (id: string) => Promise<unknown>;
  isAgentWork: (run: { kind: string }) => boolean;
}

// What a look found. A list that could not be read leaves its part empty and its
// `...Checked` flag false: "nothing found" is only said when the list was read.
export interface StopLook {
  runs: StoppableRun[];
  rooms: StoppableRoom[];
  // Active runs left alone on purpose because they are setup or service jobs.
  skipped: number;
  // True when the run list was full, so older runs may not have been checked.
  listTruncated: boolean;
  runsChecked: boolean;
  roomsChecked: boolean;
}

export interface StopAllResult {
  // Active agent runs we tried to stop, and how each went. `timedOut` = no answer in time, so
  // the run may well have stopped, or may still be running: it is not "could not be stopped".
  found: number;
  stopped: number;
  failed: number;
  timedOut: number;
  // Running Team Rooms we tried to stop, and how each went.
  rooms: number;
  roomsStopped: number;
  roomsFailed: number;
  roomsTimedOut: number;
  skipped: number;
  runsChecked: boolean;
  roomsChecked: boolean;
  // Nothing could be read at all: nothing was stopped.
  unreachable: boolean;
  listTruncated: boolean;
}

type Outcome = "ok" | "timeout" | "error";

// Waits for a promise for at most `ms`. Never rejects: it says how it went. A timeout is not an
// error: the request may well have been carried out.
function attempt(promise: Promise<unknown>, ms: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve("ok");
      },
      () => {
        clearTimeout(timer);
        resolve("error");
      }
    );
  });
}

// The answer, or null when the request failed or did not answer in time.
async function readWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Looks at what is running. Never throws.
export async function lookForStoppable(deps: StopAllDeps): Promise<StopLook> {
  const [runsAnswer, roomsAnswer] = await Promise.all([
    readWithin(Promise.resolve().then(() => deps.listRuns(MAX_RUNS)), LIST_TIMEOUT_MS),
    readWithin(Promise.resolve().then(() => deps.listRooms()), LIST_TIMEOUT_MS)
  ]);
  // A reply that is not a list is treated like no reply: we could not check.
  const runList = runsAnswer && Array.isArray(runsAnswer.runs) ? runsAnswer.runs : null;
  const roomList = roomsAnswer && Array.isArray(roomsAnswer.rooms) ? roomsAnswer.rooms : null;
  const active = (runList || []).filter((run) => ACTIVE.has(run.status));
  const runs = active.filter((run) => deps.isAgentWork(run));
  return {
    runs,
    rooms: (roomList || []).filter((room) => room.status === "running"),
    skipped: active.length - runs.length,
    listTruncated: runList !== null && runList.length >= MAX_RUNS,
    runsChecked: runList !== null,
    roomsChecked: roomList !== null
  };
}

function tally(outcomes: Outcome[]) {
  return {
    stopped: outcomes.filter((o) => o === "ok").length,
    failed: outcomes.filter((o) => o === "error").length,
    timedOut: outcomes.filter((o) => o === "timeout").length
  };
}

// Stops what the look found. Rooms first: stopping a room sets its "stop" flag as well as
// stopping its current turn, so no next turn starts when that turn ends.
export async function stopWhatWasFound(deps: StopAllDeps, look: StopLook): Promise<StopAllResult> {
  const roomOutcomes = await Promise.all(
    look.rooms.map((room) => attempt(Promise.resolve().then(() => deps.stopRoom(room.id)), STOP_TIMEOUT_MS))
  );
  const runOutcomes = await Promise.all(
    look.runs.map((run) => attempt(Promise.resolve().then(() => deps.stopRun(run.id)), STOP_TIMEOUT_MS))
  );
  const runs = tally(runOutcomes);
  const rooms = tally(roomOutcomes);
  return {
    found: look.runs.length,
    stopped: runs.stopped,
    failed: runs.failed,
    timedOut: runs.timedOut,
    rooms: look.rooms.length,
    roomsStopped: rooms.stopped,
    roomsFailed: rooms.failed,
    roomsTimedOut: rooms.timedOut,
    skipped: look.skipped,
    runsChecked: look.runsChecked,
    roomsChecked: look.roomsChecked,
    unreachable: !look.runsChecked && !look.roomsChecked,
    listTruncated: look.listTruncated
  };
}

export async function stopEverythingWith(deps: StopAllDeps): Promise<StopAllResult> {
  return stopWhatWasFound(deps, await lookForStoppable(deps));
}

// ---- the words ----------------------------------------------------------------

const runWord = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
const roomWord = (n: number) => `${n} Team Room${n === 1 ? "" : "s"}`;

// Where to look afterwards: the Runs page for runs, the Team Room page for rooms.
function checkWhere(runs: number, rooms: number): string {
  if (runs > 0 && rooms > 0) return "check Runs and Team Room";
  return rooms > 0 ? "check Team Room" : "check Runs";
}

// "2 runs", "1 Team Room", "2 runs and 1 Team Room".
export function thingsWord(runs: number, rooms: number): string {
  if (runs > 0 && rooms > 0) return `${runWord(runs)} and ${roomWord(rooms)}`;
  return rooms > 0 ? roomWord(rooms) : runWord(runs);
}

export function stopAllMessage(result: StopAllResult): { message: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (result.unreachable) {
    return { message: "Couldn't reach Agent OS, so nothing was stopped. Try again, or stop each run on Runs.", tone: "danger" };
  }
  // Said whenever the list was full: never claim "nothing was running" then.
  const notChecked = result.listTruncated ? " Older runs were not checked." : "";
  // Said whenever one of the two lists could not be read: what it holds was not stopped.
  const unread = !result.runsChecked
    ? " Couldn't read the list of runs, so no run was stopped. Check Runs."
    : !result.roomsChecked
      ? " Couldn't read the list of Team Rooms, so a room that is between two turns may still carry on. Check Team Room."
      : "";
  // Said whenever setup or service jobs were left running, so the person knows why.
  const left =
    result.skipped === 0
      ? ""
      : result.skipped === 1
        ? " 1 setup or service job was left running. It is not agent work; manage it in Setup or Agents."
        : ` ${result.skipped} setup or service jobs were left running. They are not agent work; manage them in Setup or Agents.`;
  const total = result.found + result.rooms;
  if (total === 0) {
    if (unread) {
      // One list could not be read, so "nothing was running" cannot be said; the list that was read had nothing to stop.
      const head = result.runsChecked ? "No agent run was running." : "";
      return { message: `${head}${unread}${left}`.trim(), tone: "warn" };
    }
    if (result.listTruncated) {
      const head = result.skipped > 0 ? `No agent work was running in the newest ${MAX_RUNS} runs.` : `None of the newest ${MAX_RUNS} runs were running.`;
      return { message: `${head}${left}${notChecked}`, tone: "warn" };
    }
    const head = result.skipped > 0 ? "No agent work was running, so there was nothing to stop." : "Nothing was running, so there was nothing to stop.";
    return { message: `${head}${left}`, tone: "neutral" };
  }
  const stoppedAny = result.stopped + result.roomsStopped > 0;
  const failedAny = result.failed + result.roomsFailed > 0;
  const timedOutAny = result.timedOut + result.roomsTimedOut > 0;
  const parts = [stoppedAny ? `Stopped ${thingsWord(result.stopped, result.roomsStopped)}.` : "Nothing was confirmed stopped."];
  if (failedAny) {
    parts.push(`${thingsWord(result.failed, result.roomsFailed)} could not be stopped: ${checkWhere(result.failed, result.roomsFailed)}.`);
  }
  if (timedOutAny) {
    // No answer is not "could not be stopped": the stop may have gone through.
    const n = result.timedOut + result.roomsTimedOut;
    parts.push(
      `Agent OS did not answer in time about ${thingsWord(result.timedOut, result.roomsTimedOut)}, so ${n === 1 ? "it" : "they"} may still be running: ${checkWhere(result.timedOut, result.roomsTimedOut)}.`
    );
  }
  const clean = !failedAny && !timedOutAny;
  return {
    message: `${parts.join(" ")}${unread}${left}${notChecked}`,
    tone: clean && !result.listTruncated && !unread ? "ok" : "warn"
  };
}
