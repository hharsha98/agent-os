// HTTP surface for agent updates (SP5). Like the sessions and Setup routers,
// nothing here takes a command, an argument or a path from the request: the
// address names an agent (one of the five, checked against a fixed list) and
// the update service decides what runs. server/index.js mounts the router
// behind requireLocalMode: outside local mode none of these addresses exist.
//
//   GET  /api/updates          { agents: AgentUpdateStatus[], hermes: { clean, reasons } }, read from
//                              what the checks last found; no check, no git, no CLI runs for a page request
//   POST /api/updates/refresh  checks all five agents (and Hermes's folder) again, then the same answer; an agent whose
//                              update is running keeps its saved row, and one whose check is running shares that check
//   POST /api/updates/:agentId { confirm: true } starts that agent's update:
//                              { kind: "job", jobId } or { kind: "session", sessionId }
import express from "express";
import { errorBody } from "../sessions/errors.js";
import { getSessionManager } from "../sessions/manager.js";
import { getUpdateChecks } from "./checks.js";
import { assertUpdateAgent, startAgentUpdate } from "./update-service.js";

const INTERNAL_ERROR = { error: "internal_error", message: "Something went wrong with updates. Try again." };

// Express 4 does not catch a rejected promise from a handler, so every handler goes through this.
function handle(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error) => sendError(error, res));
  };
}

// A sessionError (errors.js) carries its own HTTP status and code; anything else is a plain 500 that
// never echoes its message.
function sendError(error, res) {
  if (res.headersSent) return;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 && typeof error?.code === "string") {
    res.status(error.status).json(errorBody(error));
    return;
  }
  console.error(error);
  res.status(500).json(INTERNAL_ERROR);
}

// `manager`, `checks` and `sessionPollMs` are for tests. The server uses the one shared session manager
// (the same one the sessions routes and the WebSocket use) and the one shared set of checks.
export function createUpdatesRouter({ manager = null, checks = null, sessionPollMs } = {}) {
  // caseSensitive: "/refresh" and "/REFRESH" are different addresses.
  const router = express.Router({ caseSensitive: true });
  const theChecks = () => checks ?? getUpdateChecks();
  const overview = () => ({ agents: theChecks().list(), hermes: theChecks().hermesClean() });

  router.get(
    "/",
    handle((_req, res) => {
      res.json(overview());
    })
  );

  router.post(
    "/refresh",
    handle(async (_req, res) => {
      await theChecks().refresh();
      res.json(overview());
    })
  );

  router.post(
    "/:agentId",
    handle(async (req, res) => {
      assertUpdateAgent(req.params.agentId);
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const started = await startAgentUpdate(req.params.agentId, {
        manager: manager ?? getSessionManager(),
        checks: theChecks(),
        ...(sessionPollMs === undefined ? {} : { sessionPollMs })
      });
      res.json(started);
    })
  );

  return router;
}
