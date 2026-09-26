// Read-only + stream + stop HTTP surface for runs. There is deliberately no
// POST route that starts a run: only server-side adapters call
// manager.startRun(plan) directly with a plan built from fixed recipes.
import express from "express";
import { getRunManager } from "./run-manager.js";

const RUN_ID_PATTERN = /^[a-z0-9_-]{6,64}$/;
const PING_INTERVAL_MS = 15000;

function validateRunId(req, res, next) {
  if (!RUN_ID_PATTERN.test(String(req.params.id || ""))) {
    res.status(400).json({ ok: false, error: "invalid run id" });
    return;
  }
  next();
}

export function createRunsRouter(manager = getRunManager()) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const runs = await manager.listRuns({
        limit: req.query.limit,
        agentId: req.query.agentId,
        kind: req.query.kind
      });
      res.json({ runs });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", validateRunId, async (req, res, next) => {
    try {
      const run = await manager.getRun(req.params.id);
      if (!run) {
        res.status(404).json({ ok: false, error: "run not found" });
        return;
      }
      res.json(run);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/events", validateRunId, async (req, res, next) => {
    try {
      const run = await manager.getRun(req.params.id);
      if (!run) {
        res.status(404).json({ ok: false, error: "run not found" });
        return;
      }
      const events = await manager.readEvents(req.params.id, Number(req.query.from) || 0);
      res.json({ events });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/stream", validateRunId, async (req, res, next) => {
    try {
      const run = await manager.getRun(req.params.id);
      if (!run) {
        res.status(404).json({ ok: false, error: "run not found" });
        return;
      }

      const lastEventId = Number(req.get("last-event-id"));
      const fromQuery = Number(req.query.from);
      const from = Number.isFinite(lastEventId)
        ? lastEventId + 1
        : Number.isFinite(fromQuery)
          ? fromQuery
          : 0;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });

      const send = (event) => {
        res.write(`id: ${event.seq}\n`);
        res.write(`event: ${event.type || "message"}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const sendEnd = (status) => {
        res.write("event: end\n");
        res.write(`data: ${JSON.stringify({ status })}\n\n`);
      };

      // Subscribe before replaying, and hold live events until the replay is
      // written. Otherwise a run that ends while we read the log from disk
      // broadcasts "end" before anyone is listening, and the stream hangs.
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
        sendEnd(status);
        cleanup();
        res.end();
      }

      function handle(event) {
        if (finished) return;
        if (event.type === "end") {
          finish(event.status);
          return;
        }
        if (typeof event.seq === "number" && event.seq <= lastSeq) return;
        if (typeof event.seq === "number") lastSeq = event.seq;
        send(event);
      }

      const unsubscribe = manager.subscribe(req.params.id, (event) => {
        if (!replayed) {
          held.push(event);
          return;
        }
        handle(event);
      });
      req.on("close", cleanup);

      const replay = await manager.readEvents(req.params.id, from);
      for (const event of replay) handle(event);
      replayed = true;
      for (const event of held.splice(0)) handle(event);
      if (finished) return;

      const current = await manager.getRun(req.params.id);
      if (!current || (current.status !== "queued" && current.status !== "running")) {
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

  router.post("/:id/stop", validateRunId, async (req, res, next) => {
    try {
      const run = await manager.stopRun(req.params.id);
      if (!run) {
        res.status(404).json({ ok: false, error: "run not found" });
        return;
      }
      res.json(run);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
