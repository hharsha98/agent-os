// The one update service (SP5, spec "One update service for Setup and Agents").
// Every way of updating an agent starts here, from the Agents page, and the
// Setup page's update steps take the same guard:
//
//   Claude Code, Codex, Cursor, OpenClaw   a Setup job with exactly one step,
//                                          `<agent>-update` (setup/jobs.js runs the
//                                          agent's own updater with its log visible)
//   Hermes                                 a terminal session of kind `update`
//                                          (`hermes update`, SP3 "Session kinds") that
//                                          the person can type into, and only when
//                                          the Hermes clean check says its checkout
//                                          is an unchanged official copy
//
// Only one update per agent runs at a time (409 update_running). After an
// update ends, however it ended, the detection memory is cleared and the agent
// is checked again, so the Agents page shows the version that is installed now.
// An update never stops or restarts a session or run of that agent.
import { clearDetectCaches } from "../agents/detect.js";
import { sessionError } from "../sessions/errors.js";
import { SESSION_AGENT_LABEL } from "../sessions/profiles.js";
import { agentsUpdatingInJobs, startSetupJob } from "../setup/jobs.js";
import { registerUpdateActivity, updateRunningError } from "./activity.js";
import { UPDATE_AGENT_IDS, getUpdateChecks } from "./checks.js";

// The agents whose update runs as a session instead of a job.
const SESSION_UPDATE_AGENTS = Object.freeze(["hermes"]);
// How often a running update session is looked at to see whether it has ended.
const SESSION_POLL_MS = 1000;

export const HERMES_NOT_CLEAN_MESSAGE = "Hermes's folder changed since the last check, so Agent OS didn't update it.";

const labelOf = (agentId) => SESSION_AGENT_LABEL[agentId] ?? agentId;

// (The sentence is activity.js's: Restart session refuses with the very same words.)
const updateRunning = updateRunningError;

// Throws 404 unless this is one of the five agents.
export function assertUpdateAgent(agentId) {
  if (!UPDATE_AGENT_IDS.includes(agentId)) throw sessionError(404, "unknown_agent", "Agent OS doesn't know that agent.");
}

// The agents named by the update steps among some Setup step ids (`claude-update`),
// in the order they came, once each. Hermes is left out: its update is never a
// job, and a job that names it is refused by jobs.js.
export function updateAgentsOf(stepIds) {
  const agents = [];
  for (const id of Array.isArray(stepIds) ? stepIds : []) {
    const agentId = /^([a-z]+)-update$/.exec(String(id))?.[1];
    if (agentId && UPDATE_AGENT_IDS.includes(agentId) && !SESSION_UPDATE_AGENTS.includes(agentId) && !agents.includes(agentId)) {
      agents.push(agentId);
    }
  }
  return agents;
}

// --- the guard: one update per agent ---------------------------------------------------------------------

// The agents whose update is being started right now. An agent is added before
// the first await, so two clicks that arrive together cannot both pass, and
// removed once its job or session exists. From then on the running job (the
// update step of a job that is running) or the live `update` session is what
// says "updating", and it clears itself when the job or the session ends.
const starting = new Set();
// The agents whose update session is being watched (Hermes): added when the session starts, removed once it has ended or the
// checks were stopped. With `starting` this is what activity.js answers for this module (isAgentUpdating).
const watchedSessions = new Set();
registerUpdateActivity((agentId) => starting.has(agentId) || watchedSessions.has(agentId));

// Claims the update of these agents: throws 409 update_running when one of
// them is being started, is in a running job, or (Hermes) has a live update
// session. Resolves release(), which gives the claim back (once).
async function claimAgentUpdates(agentIds, { manager }) {
  const wanted = [...new Set(agentIds)];
  const inJobs = agentsUpdatingInJobs();
  for (const agentId of wanted) {
    if (starting.has(agentId) || inJobs.has(agentId)) throw updateRunning(agentId);
  }
  for (const agentId of wanted) starting.add(agentId);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const agentId of wanted) starting.delete(agentId);
  };
  try {
    const sessionAgents = wanted.filter((agentId) => SESSION_UPDATE_AGENTS.includes(agentId));
    if (sessionAgents.length) {
      const live = await manager.list({ includeUpdate: true, liveOnly: true });
      for (const agentId of sessionAgents) {
        if (live.some((session) => session.kind === "update" && session.agentId === agentId)) throw updateRunning(agentId);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

// Runs start() while these agents' updates are claimed. The Setup route uses it
// for the update steps of a job it is about to start; startAgentUpdate for its own.
export async function withUpdateGuard(agentIds, { manager }, start) {
  const release = await claimAgentUpdates(agentIds, { manager });
  try {
    return await start();
  } finally {
    release();
  }
}

// --- after an update ---------------------------------------------------------------------------------------

// Forget what was detected, check the agent again (for Hermes this also asks
// the clean check again). Asked as the update's own check (afterChange): it starts
// afresh even beside a check that began before the update ended. Does nothing once
// the checks were stopped (the server is quitting). Never throws.
async function afterUpdate(agentId, checks) {
  try {
    if (checks.isStopped?.()) return;
    clearDetectCaches();
    await checks.refresh(agentId, { afterChange: true });
  } catch {
    // a check that cannot run leaves the page as it was
  }
}

// The manager tells nobody when an update session ends, so look at it now and
// then, until it has. The timer never keeps the server running. When the checks
// were stopped (the server is quitting) the poll ends at its next look and checks
// nothing.
function watchUpdateSession(manager, sessionId, { agentId, checks, pollMs }) {
  watchedSessions.add(agentId);
  const timer = setInterval(() => {
    if (checks.isStopped?.()) {
      clearInterval(timer);
      watchedSessions.delete(agentId);
      return;
    }
    let live = true;
    try {
      live = manager.isLive(sessionId);
    } catch {
      live = false;
    }
    if (live) return;
    clearInterval(timer);
    watchedSessions.delete(agentId);
    void afterUpdate(agentId, checks);
  }, pollMs);
  timer.unref?.();
}

// --- starting an update ------------------------------------------------------------------------------------

async function startJobUpdate(agentId) {
  try {
    const job = await startSetupJob({ steps: [`${agentId}-update`] });
    return { kind: "job", jobId: job.id };
  } catch (error) {
    // Setup offers an update step only for an agent it found installed.
    if (error?.code === "no_valid_steps") {
      throw sessionError(409, "agent_not_installed", `${labelOf(agentId)} isn't installed on this computer.`);
    }
    if (error?.code === "job_already_running") throw sessionError(409, "job_already_running", error.message);
    throw error;
  }
}

async function startHermesUpdate(manager, { checks, pollMs }) {
  // The click's own check is the one that counts: what the page last showed may be a day old.
  const fresh = await checks.refreshHermesClean();
  if (!fresh.clean || !fresh.checkout) throw sessionError(409, "hermes_not_clean", HERMES_NOT_CLEAN_MESSAGE);
  let session;
  try {
    session = await manager.createUpdateSession({ agentId: "hermes", folder: fresh.checkout });
  } catch (error) {
    // The manager allows one update session at a time and says so in its own words.
    if (error?.code === "update_running") throw updateRunning("hermes");
    throw error;
  }
  watchUpdateSession(manager, session.id, { agentId: "hermes", checks, pollMs });
  return { kind: "session", sessionId: session.id };
}

/**
 * Starts the update of one agent.
 * @returns {Promise<{ kind: "job", jobId: string } | { kind: "session", sessionId: string }>}
 * Throws a sessionError: 404 unknown_agent; 409 update_running (this agent is already updating),
 * hermes_not_clean, agent_not_installed, job_already_running (Setup runs one job at a time).
 *   manager        the session manager (Hermes updates run as one of its sessions)
 *   checks         the version checks (default: the server's own); the Hermes clean answer is asked of it
 *   sessionPollMs  how often a running update session is looked at (tests shorten it)
 */
export async function startAgentUpdate(agentId, { manager, checks = getUpdateChecks(), sessionPollMs = SESSION_POLL_MS } = {}) {
  assertUpdateAgent(agentId);
  return withUpdateGuard([agentId], { manager }, () =>
    SESSION_UPDATE_AGENTS.includes(agentId) ? startHermesUpdate(manager, { checks, pollMs: sessionPollMs }) : startJobUpdate(agentId)
  );
}
