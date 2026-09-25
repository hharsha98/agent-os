// HTTP surface for the Setup Assistant: read-only check/plan/receipt, plus
// the only path that starts an install job. No route here ever accepts a
// URL, command, args, path, or script body -- a job only ever takes step
// ids from a plan this server just computed itself.
import express from "express";
import { systemCheck } from "./system-check.js";
import { buildSetupPlan } from "./plan.js";
import { cancelSetupJob, getSetupJob, retrySetupJob, startConfigureJob, startSetupJob } from "./jobs.js";
import { readReceipt } from "./receipt.js";
import { brainOptions, currentBrain, listFreeOpenRouterModels, listOllamaTags, verifyOpenRouterKey } from "./brain.js";

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
    job_already_running: 409,
    invalid_mode: 400,
    key_required_for_retry: 409
  }[error?.code];
  if (mapped) {
    // Never spread the source error here: it may carry no extra fields, but
    // this keeps a future error.body from ever leaking request data (e.g.
    // an apiKey) back to the client.
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

  // ---- brain: model provider, safe defaults, always-on services --------

  router.get("/brain", async (_req, res, next) => {
    try {
      const check = await systemCheck({});
      const [options, current] = await Promise.all([brainOptions(check), currentBrain(check)]);
      res.json({
        options: options.options,
        recommendation: options.recommendation,
        reason: options.reason,
        current,
        defaults: {
          hermes: current.hermes.configured ? "keep" : "configure",
          openclaw: current.openclaw.configured ? "keep" : "configure"
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/openrouter/models", async (_req, res, next) => {
    try {
      res.json(await listFreeOpenRouterModels());
    } catch (error) {
      next(error);
    }
  });

  router.post("/openrouter/verify", async (req, res, next) => {
    try {
      // Only ever forwards the key to OpenRouter itself and returns
      // ok/label/limit -- the key is never echoed back in the response.
      res.json(await verifyOpenRouterKey(req.body?.apiKey));
    } catch (error) {
      next(error);
    }
  });

  router.post("/configure", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const mode = req.body?.mode;
      if (mode !== "openrouter" && mode !== "ollama") {
        res.status(400).json({ ok: false, error: 'mode must be "openrouter" or "ollama"' });
        return;
      }
      const model = typeof req.body?.model === "string" ? req.body.model : "";

      if (mode === "ollama") {
        const check = await systemCheck({});
        const options = await brainOptions(check);
        const ollamaOption = options.options.find((o) => o.id === "ollama");
        if (!ollamaOption?.available) {
          res.status(400).json({ ok: false, error: "Ollama is not available on this computer" });
          return;
        }
        const tags = await listOllamaTags();
        if (!tags.includes(model)) {
          res.status(400).json({ ok: false, error: "model must already be pulled in Ollama" });
          return;
        }
      } else {
        const apiKey = req.body?.apiKey;
        if (typeof apiKey !== "string" || !apiKey.trim()) {
          res.status(400).json({ ok: false, error: "apiKey is required for OpenRouter" });
          return;
        }
        const { models } = await listFreeOpenRouterModels();
        if (!models.some((m) => m.id === model)) {
          res.status(400).json({ ok: false, error: "model must be one of the current free OpenRouter models" });
          return;
        }
      }

      const job = await startConfigureJob({
        mode,
        model,
        apiKey: mode === "openrouter" ? req.body?.apiKey : undefined,
        reconfigure: req.body?.reconfigure && typeof req.body.reconfigure === "object" ? req.body.reconfigure : {},
        acceptOpenClawRisk: req.body?.acceptOpenClawRisk === true
      });
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
