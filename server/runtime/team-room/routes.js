// HTTP surface for the Team Room. Like the agents router, nothing here takes
// a command, a path or a binary from the request: the body only carries a
// task (plain text), numbers for limits, and button presses (stop, continue,
// approve, reject, undo). Every id in a URL is checked against a strict
// pattern before it gets anywhere near the file system.
import express from "express";
import { isExecutionEnabled } from "../execution-gate.js";
import { applyFileProposal, undoAction } from "./actions.js";
import { getModerator } from "./moderator.js";
import {
  ACTION_ID_PATTERN,
  PROPOSAL_ID_PATTERN,
  appendEvent,
  isValidRoomId,
  listRooms,
  readDecision,
  readEvents,
  readNotebook,
  readRoom,
  roomError,
  scrubPaths,
  subscribeRoom,
  updateDecision
} from "./room-store.js";

const MAX_TASK_CHARS = 4000;
const PING_INTERVAL_MS = 15000;

function notFound(res, error = "room_not_found") {
  res.status(404).json({ ok: false, error });
}

// A room id that does not match the pattern never touches the disk.
function validateRoomId(req, res, next) {
  if (!isValidRoomId(String(req.params.id || ""))) {
    notFound(res);
    return;
  }
  next();
}

function sendError(error, res, _next) {
  if (error?.status && error.body) {
    res.status(error.status).json(error.body);
    return;
  }
  if (error?.status) {
    res.status(error.status).json({ ok: false, error: scrubPaths(error.message) });
    return;
  }
  // An unexpected error (often a file-system one) may name a real folder.
  // Answer it here with the home folder hidden, instead of leaving it to a
  // generic handler.
  res.status(500).json({ ok: false, error: "internal_error", message: scrubPaths(error?.message || "Something went wrong.") });
}

export function createTeamRoomsRouter({ moderator = getModerator() } = {}) {
  const router = express.Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ rooms: await listRooms() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      if (!(await isExecutionEnabled())) {
        res.status(403).json({
          ok: false,
          error: "execution_gate_off",
          message: "Turn on the execution gate before starting a Team Room."
        });
        return;
      }
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
      if (!task || task.length > MAX_TASK_CHARS) {
        res.status(400).json({ ok: false, error: `task must be 1 to ${MAX_TASK_CHARS} characters` });
        return;
      }
      // Both agents installed and both safeguards on is checked inside
      // startRoom (409 agent_missing / safeguards_off) before any room exists.
      const { room } = await moderator.startRoom({ task, limits: req.body?.limits });
      res.json(room);
    } catch (error) {
      sendError(error, res, next);
    }
  });

  router.get("/:id", validateRoomId, async (req, res, next) => {
    try {
      const room = await readRoom(req.params.id);
      if (!room) {
        notFound(res);
        return;
      }
      const [decision, notebook, events] = await Promise.all([
        readDecision(room.id),
        readNotebook(room.id),
        readEvents(room.id)
      ]);
      res.json({ room, proposals: decision.proposals, actions: decision.actions, notebook, events });
    } catch (error) {
      next(error);
    }
  });

  // Live events as server-sent events, shaped like GET /api/runs/:id/stream:
  // `id:` is the event's seq, `event:` its type, `data:` the JSON. The stream
  // closes with an `end` event when the room is no longer running (a room
  // waiting for you has ended for now; reconnect after you continue it).
  router.get("/:id/stream", validateRoomId, async (req, res, next) => {
    try {
      const room = await readRoom(req.params.id);
      if (!room) {
        notFound(res);
        return;
      }
      const roomId = room.id;

      const lastEventId = Number(req.get("last-event-id"));
      const fromQuery = Number(req.query.from);
      const from = Number.isFinite(lastEventId) ? lastEventId + 1 : Number.isFinite(fromQuery) ? fromQuery : 0;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });

      let finished = false;
      let replayed = false;
      let lastSeq = from - 1;
      const held = [];
      let ping = null;

      function cleanup() {
        if (ping) clearInterval(ping);
        unsubscribe();
      }
      function finish(status) {
        if (finished) return;
        finished = true;
        res.write("event: end\n");
        res.write(`data: ${JSON.stringify({ status })}\n\n`);
        cleanup();
        res.end();
      }
      function send(event) {
        if (typeof event.seq === "number") {
          if (event.seq <= lastSeq) return;
          lastSeq = event.seq;
        }
        res.write(`id: ${event.seq}\n`);
        res.write(`event: ${event.type || "message"}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      // `live` is false while replaying history: an old "needs_you" in the
      // past must not close a stream whose room has since been continued.
      function handle(event, live) {
        if (finished) return;
        send(event);
        if (live && event.type === "status" && event.status !== "running") finish(event.status);
      }

      // Subscribe before replaying, and hold live events until the replay is
      // written, so nothing that happens during the disk read is lost.
      const unsubscribe = subscribeRoom(roomId, (event) => {
        if (!replayed) {
          held.push(event);
          return;
        }
        handle(event, true);
      });
      res.on("close", () => {
        finished = true;
        cleanup();
      });

      for (const event of await readEvents(roomId, from)) handle(event, false);
      replayed = true;
      for (const event of held.splice(0)) handle(event, true);
      if (finished) return;

      const current = await readRoom(roomId);
      // The client may have disconnected while we awaited the read above; a
      // timer created now would never be cleared.
      if (finished) return;
      if (!current || current.status !== "running") {
        finish(current?.status || "unknown");
        return;
      }
      ping = setInterval(() => {
        res.write(": ping\n\n");
      }, PING_INTERVAL_MS);
      ping.unref?.();
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/stop", validateRoomId, async (req, res, next) => {
    try {
      res.json(await moderator.stopRoom(req.params.id));
    } catch (error) {
      sendError(error, res, next);
    }
  });

  router.post("/:id/continue", validateRoomId, async (req, res, next) => {
    try {
      if (!(await isExecutionEnabled())) {
        res.status(403).json({
          ok: false,
          error: "execution_gate_off",
          message: "Turn on the execution gate before continuing a Team Room."
        });
        return;
      }
      const { room } = await moderator.continueRoom(req.params.id, req.body?.extraTurns);
      res.json(room);
    } catch (error) {
      sendError(error, res, next);
    }
  });

  // Approve or reject a decision card. Approving does NOTHING else in this
  // version: no command is run (the UI can offer to start a normal run). The
  // one exception is a file proposal that was waiting only because the
  // execution gate was off: approving it saves the file, if the gate is on now.
  router.post("/:id/proposals/:pid", validateRoomId, async (req, res, next) => {
    try {
      const roomId = req.params.id;
      if (!PROPOSAL_ID_PATTERN.test(String(req.params.pid))) {
        notFound(res, "proposal_not_found");
        return;
      }
      const choice = req.body?.decision;
      if (choice !== "approve" && choice !== "reject") {
        res.status(400).json({ ok: false, error: "decision must be approve or reject" });
        return;
      }
      if (!(await readRoom(roomId))) {
        notFound(res);
        return;
      }
      const proposalId = req.params.pid;
      const before = (await readDecision(roomId)).proposals.find((p) => p.id === proposalId);
      if (!before) {
        notFound(res, "proposal_not_found");
        return;
      }
      if (before.status !== "needs_approval") {
        throw roomError(409, "not_pending", `That proposal is ${before.status}, so it is not waiting for your decision.`);
      }

      let action = null;
      if (choice === "approve" && before.kind === "file") {
        action = await applyFileProposal(roomId, proposalId);
      }
      const proposal = await updateDecision(roomId, (decision) => {
        const found = decision.proposals.find((p) => p.id === proposalId);
        if (!found) throw roomError(404, "proposal_not_found", "Proposal not found.");
        if (!action) {
          if (found.status !== "needs_approval") {
            throw roomError(409, "not_pending", `That proposal is ${found.status}, so it is not waiting for your decision.`);
          }
          found.status = choice === "approve" ? "approved" : "rejected";
        }
        found.userDecision = choice;
        found.decidedAt = new Date().toISOString();
        return { ...found };
      });
      await appendEvent(roomId, { type: "proposal_decided", proposalId, decision: choice, status: proposal.status });
      res.json({ proposal, action });
    } catch (error) {
      sendError(error, res, next);
    }
  });

  router.post("/:id/actions/:aid/undo", validateRoomId, async (req, res, next) => {
    try {
      if (!ACTION_ID_PATTERN.test(String(req.params.aid))) {
        notFound(res, "action_not_found");
        return;
      }
      if (!(await readRoom(req.params.id))) {
        notFound(res);
        return;
      }
      res.json({ action: await undoAction(req.params.id, req.params.aid) });
    } catch (error) {
      sendError(error, res, next);
    }
  });

  return router;
}
