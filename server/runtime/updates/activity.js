// Which agents are being updated right now (SP5 E1). Two modules each know a part of the answer:
//
//   update-service.js   an update that is being started, and Hermes's update session while it is watched
//   setup/jobs.js       a Setup job whose update step has not finished
//
// The ones that need the whole answer (the version checks skip an agent while it updates; the session manager refuses a
// Restart session while it does) cannot import those two without a loop: both of them import checks.js. So each registers a
// small question here when its module loads, and whoever needs the answer asks isAgentUpdating(). A module that was never
// loaded has registered nothing, and then it has nothing running either.
import { sessionError } from "../sessions/errors.js";
import { SESSION_AGENT_LABEL } from "../sessions/profiles.js";

const sources = new Set();

/** @param {(agentId: string) => boolean} source true when that agent's update is running, as far as the caller knows */
export function registerUpdateActivity(source) {
  sources.add(source);
}

/** True when any registered source says this agent's update is running. A source that throws says no. */
export function isAgentUpdating(agentId) {
  for (const source of sources) {
    try {
      if (source(agentId) === true) return true;
    } catch {
      // a source that cannot answer says nothing
    }
  }
  return false;
}

/** The 409 update_running every refusal of "this agent is updating" uses, from the update service and from Restart session. */
export function updateRunningError(agentId) {
  return sessionError(409, "update_running", `${SESSION_AGENT_LABEL[agentId] ?? agentId} is already updating.`);
}
