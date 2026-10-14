import { listRuns, listTeamRooms, stopRun, stopTeamRoom } from "../api";
import { isAgentWork } from "./agentWork";
import { lookForStoppable, stopEverythingWith, stopWhatWasFound, withEndedRooms } from "./stopAllShared";

// What "Hold to stop all" stops (design spec D11, ruling R14): every AGENT run
// that is queued or running, including Team Room turns, and every Team Room that is
// running (a room between two turns has no active run, so it would otherwise start
// its next turn). From SP3 it also stops every session, inside this same function.
// It never touches the Hermes background service or the OpenClaw Gateway, and
// it never interrupts Agent OS's own setup jobs: stopping a gateway restart can
// leave the gateway down, and stopping an install can leave a half-installed tool.
//
// The logic and the words are in stopAllShared.ts (no imports but types, so the logic
// tests can load it). This file hands it the real requests and the agent-work rule.
//
// Which kinds are Agent OS's own jobs (and so are not stopped) lives in agentWork.ts.
// Any other kind, including "agent", "team-turn", a missing kind and a kind we have
// not heard of, IS stopped: an emergency stop errs toward stopping agent work.
export { MAX_RUNS, stopAllMessage, thingsWord } from "./stopAllShared";
export type { StopAllResult, StopLook } from "./stopAllShared";

// A room that ended on its own between the look and the stop (the server answers room_not_running)
// is not a failure, and was not stopped by us either: withEndedRooms (stopAllShared.ts) counts it apart.
export const realStopAllDeps = withEndedRooms({
  listRuns: (limit) => listRuns({ limit }),
  stopRun: (id) => stopRun(id),
  listRooms: () => listTeamRooms(),
  stopRoom: (id) => stopTeamRoom(id),
  isAgentWork
});

export function stopEverything() {
  return stopEverythingWith(realStopAllDeps);
}

// The palette's "Stop all runs" looks first, shows what it would stop, and stops only on a yes.
export const lookForWhatToStop = () => lookForStoppable(realStopAllDeps);
export const stopWhatWasLookedAt = (look: Parameters<typeof stopWhatWasFound>[1]) => stopWhatWasFound(realStopAllDeps, look);
