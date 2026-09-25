// HTTP surface for the Setup Assistant: read-only check/plan/receipt, plus
// the only path that starts an install job. No route here ever accepts a
// URL, command, args, path, or script body -- a job only ever takes step
// ids from a plan this server just computed itself.
import express from "express";
import { systemCheck } from "./system-check.js";
import { buildSetupPlan } from "./plan.js";
import { cancelSetupJob, getSetupJob, retrySetupJob, startSetupJob } from "./jobs.js";
import { readReceipt } from "./receipt.js";

const JOB_ID_PATTERN = /^[a-z0-9_-]{6,64}$/;

function validateJobId(req, res, next) {
  if (!JOB_ID_PATTERN.test(String(req.params.id || ""))) {
    res.status(400).json({ ok: false, error: "invalid job id" });
    return;
  }
  next();
}

function mapJobError(error, res, next) {
  const mapped = {
    openclaw_risk_not_accepted: 400,
    no_valid_steps: 400,
    job_already_running: 409
  }[error?.code];
  if (mapped) {
    res.status(mapped).json({ error: error.code });
    return;
  }
  next(error);
}

export function createSetupRouter() {
  const router = express.Router();

  router.get("/check", async (req, res, next) => {
    try {
      res.json(await systemCheck({ refresh: req.query.refresh === "1" }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/plan", async (_req, res, next) => {
    try {
      const check = await systemCheck({});
      res.json(buildSetupPlan(check));
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const steps = Array.isArray(req.body?.steps) ? req.body.steps.map(String) : [];
      const job = await startSetupJob({ steps, acceptOpenClawRisk: req.body?.acceptOpenClawRisk === true });
      res.json(job);
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  router.get("/jobs/:id", validateJobId, async (req, res, next) => {
    try {
      const job = await getSetupJob(req.params.id);
      if (!job) {
        res.status(404).json({ ok: false, error: "job not found" });
        return;
      }
      res.json(job);
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:id/cancel", validateJobId, async (req, res, next) => {
    try {
      const job = await cancelSetupJob(req.params.id);
      if (!job) {
        res.status(404).json({ ok: false, error: "job not found" });
        return;
      }
      res.json(job);
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  router.post("/jobs/:id/retry", validateJobId, async (req, res, next) => {
    try {
      const job = await retrySetupJob(req.params.id);
      if (!job) {
        res.status(404).json({ ok: false, error: "job not found" });
        return;
      }
      res.json(job);
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  router.get("/receipt", async (_req, res, next) => {
    try {
      res.json({ receipt: await readReceipt() });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
