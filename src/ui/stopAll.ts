import { listRuns, listTeamRooms, request, stopRun, stopTeamRoom } from "../api";
import { isAgentWork } from "./agentWork";
import type { StoppableSession } from "./stopAllShared";
import { lookForStoppable, stopEverythingWith, stopWhatWasFound, withEndedRooms, withSessionAnswers } from "./stopAllShared";

// What "Hold to stop all" stops (design spec D11, SP2 ruling R14, SP3 ruling R22 and planning decision
// Q16): every session that has not ended, of both kinds (an agent's own terminal, and an agent's updater
// running as an `update` session), every AGENT run that is queued or running, including Team Room turns,
// and every Team Room that is running (a room between two turns has no active run, so it would otherwise
// start its next turn). A session is stopped with the same Stop as the Sessions page's Stop session,
// without its question: the hold is the emergency stop.
// It never touches the Hermes background service or the OpenClaw Gateway (it never calls their service
// controls), and it never interrupts Agent OS's own setup jobs: stopping a gateway restart can leave the
// gateway down, and stopping an install can leave a half-installed tool.
//
// The logic and the words are in stopAllShared.ts (no imports but types, so the logic
// tests can load it). This file hands it the real requests and the agent-work rule.
//
// Which kinds are Agent OS's own jobs (and so are not stopped) lives in agentWork.ts.
// Any other kind, including "agent", "team-turn", a missing kind and a kind we have
// not heard of, IS stopped: an emergency stop errs toward stopping agent work.
export { MAX_RUNS, sessionStopTitle, stopAllMessage, thingsWord } from "./stopAllShared";
export type { StopAllResult, StopLook } from "./stopAllShared";

// A room that ended on its own between the look and the stop (the server answers room_not_running)
// is not a failure, and was not stopped by us either: withEndedRooms (stopAllShared.ts) counts it apart.
// withSessionAnswers does the same for a session, and reads "sessions are not available here" (Agent OS
// not running on this computer) as "no session is running".
export const realStopAllDeps = withSessionAnswers(
  withEndedRooms({
    listRuns: (limit) => listRuns({ limit }),
    stopRun: (id) => stopRun(id),
    listRooms: () => listTeamRooms(),
    stopRoom: (id) => stopTeamRoom(id),
    // Both kinds of session: kind=all (planning decision Q24). live=1: only the ones running now, so the
    // server reads no ended session and detects no agent for Resume, and a slow agent CLI cannot make this
    // list time out (then no session would be stopped).
    listSessions: () => request<{ sessions: StoppableSession[] }>("/api/sessions?kind=all&live=1"),
    stopSession: (id) => request<unknown>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }),
    isAgentWork
  })
);

export function stopEverything() {
  return stopEverythingWith(realStopAllDeps);
}

// The palette's "Stop all agent work" looks first, shows what it would stop, and stops only on a yes, and
// only what it showed: unlike the hold it does not look for sessions again (stopAllShared.ts, stopWhatWasFound).
export const lookForWhatToStop = () => lookForStoppable(realStopAllDeps);
export const stopWhatWasLookedAt = (look: Parameters<typeof stopWhatWasFound>[1]) => stopWhatWasFound(realStopAllDeps, look);
