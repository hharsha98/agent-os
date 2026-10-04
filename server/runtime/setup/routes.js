// HTTP surface for the Setup Assistant: read-only check/plan/receipt, plus
// the only path that starts an install job. No route here ever accepts a
// URL, command, args, path, or script body -- a job only ever takes step
// ids from a plan this server just computed itself.
import express from "express";
import { authRequired } from "../auth.js";
import { isDemoPublic } from "../demo-public.js";
import { getServerPort } from "../server-info.js";
import { systemCheck } from "./system-check.js";
import { buildSetupPlan } from "./plan.js";
import {
  cancelSetupJob,
  getSetupJob,
  retrySetupJob,
  startConfigureJob,
  startModelJob,
  startOllamaPull,
  startSetupJob
} from "./jobs.js";
import { readReceipt } from "./receipt.js";
import { brainOptions, currentBrain, listFreeOpenRouterModels, localBrainSummary, verifyOpenRouterKey } from "./brain.js";
import {
  OPENROUTER_BROWSE_URL,
  OPENROUTER_NEW_PRESET_URL,
  OPENROUTER_PRESETS_URL,
  checkPreset,
  listCatalog,
  lookupModel,
  modelPageUrl,
  parseCatalogQuery,
  parseModelId,
  parsePresetSlug,
  presetModelId,
  readAgentModel
} from "./models.js";
import {
  FLOW_ID_PATTERN,
  cancel as cancelOpenRouterFlow,
  getStatus as getOpenRouterFlowStatus,
  openSystemBrowser,
  peekKey,
  startFlow
} from "./openrouter-oauth.js";

const JOB_ID_PATTERN = /^[a-z0-9_-]{6,64}$/;

function validateJobId(req, res, next) {
  if (!JOB_ID_PATTERN.test(String(req.params.id || ""))) {
    res.status(400).json({ ok: false, error: "invalid job id" });
    return;
  }
  next();
}

// Errors whose `message` is a fixed sentence written in this codebase (it may
// include the model name and memory figures, never request secrets), so it is
// safe and useful to show to the person.
const MESSAGE_CODES = new Set([
  "too_many_flows",
  "local_model_too_big",
  "invalid_variant_name",
  "invalid_model_id",
  "invalid_preset",
  "invalid_catalog_query",
  "invalid_flow_id",
  "model_not_found",
  "preset_not_found",
  "model_too_small_for_hermes",
  "agent_not_installed",
  "openrouter_unreachable",
  "connection_not_ready"
]);

function apiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const MODEL_ID_HELP =
  "That doesn't look like an OpenRouter model ID. It looks like author/model-name, for example anthropic/claude-sonnet-4.6.";
const UNREACHABLE = "Couldn't reach OpenRouter. Check your internet connection and try again.";
const AGENT_LABEL = { hermes: "Hermes", openclaw: "OpenClaw" };

// A sign-in id given in a request: undefined when there is none, an error
// when it isn't the shape of one.
function flowIdFrom(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !FLOW_ID_PATTERN.test(value)) {
    throw apiError("invalid_flow_id", "That OpenRouter connection isn't valid. Connect OpenRouter again.");
  }
  return value;
}

function mapJobError(error, res, next) {
  const mapped = {
    openclaw_risk_not_accepted: 400,
    no_valid_steps: 400,
    job_already_running: 409,
    invalid_mode: 400,
    invalid_model: 400,
    no_targets: 400,
    key_required: 400,
    key_unavailable: 409,
    too_many_flows: 429,
    local_model_too_big: 400,
    invalid_variant_name: 400,
    server_port_unknown: 503,
    key_required_for_retry: 409,
    invalid_model_id: 400,
    invalid_preset: 400,
    invalid_catalog_query: 400,
    invalid_flow_id: 400,
    invalid_agent: 400,
    model_not_found: 404,
    preset_not_found: 404,
    model_too_small_for_hermes: 400,
    agent_not_installed: 409,
    openrouter_unreachable: 502,
    connection_not_ready: 409
  }[error?.code];
  if (mapped) {
    // Never spread the source error here: it may carry no extra fields, but
    // this keeps a future error.body from ever leaking request data (e.g.
    // an apiKey) back to the client. `message` is a fixed sentence written in
    // this codebase, never request data.
    res.status(mapped).json({ error: error.code, ...(MESSAGE_CODES.has(error.code) ? { message: error.message } : {}) });
    return;
  }
  next(error);
}

export function createSetupRouter() {
  // caseSensitive: "/check" and "/CHECK" are different addresses.
  const router = express.Router({ caseSensitive: true });

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

  router.get("/brain", async (req, res, next) => {
    try {
      const refresh = req.query.refresh === "1";
      const check = await systemCheck({ refresh });
      const [options, current] = await Promise.all([brainOptions(check, { refresh }), currentBrain(check)]);
      res.json({
        options: options.options,
        recommendation: options.recommendation,
        reason: options.reason,
        // The installed local model "Choose for me" would use, if any.
        localModel: options.localModel,
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

  // With no search settings this is the short list of free models the Setup
  // cards use. With any of them (tools, free, sort, q, offset, limit, flowId)
  // it is a page of OpenRouter's whole catalog for the "Change model" picker.
  // `flowId` is a connected sign-in: its key (kept in memory, never returned)
  // narrows the list to the models this account may use.
  const CATALOG_PARAMS = ["tools", "free", "sort", "q", "offset", "limit", "flowId"];

  router.get("/openrouter/models", async (req, res, next) => {
    try {
      if (!CATALOG_PARAMS.some((name) => req.query[name] !== undefined)) {
        res.json(await listFreeOpenRouterModels());
        return;
      }
      const parsed = parseCatalogQuery(req.query);
      if (parsed.error) throw apiError("invalid_catalog_query", parsed.error);
      const flowId = flowIdFrom(req.query.flowId);
      res.json(await listCatalog({ ...parsed.value, key: (flowId && peekKey(flowId)) || "" }));
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  // One model by its id (what the person pastes from OpenRouter's website).
  router.get("/openrouter/models/lookup", async (req, res, next) => {
    try {
      const id = parseModelId(req.query.id);
      if (!id) throw apiError("invalid_model_id", MODEL_ID_HELP);
      const found = await lookupModel(id);
      if (found.notFound) throw apiError("model_not_found", "OpenRouter doesn't know that model. Check the ID on the model's page.");
      if (found.unreachable) throw apiError("openrouter_unreachable", UNREACHABLE);
      res.json({ ok: true, model: found.model });
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  // Opens an OpenRouter page in the person's normal browser (argv, never a
  // shell; only addresses built here, which openSystemBrowser allows). Opening a
  // browser only means something on the person's own computer; elsewhere the
  // address is handed back so the screen can show it as a link.
  async function openOpenRouterPage(res, url) {
    if (isDemoPublic() || authRequired()) {
      res.json({ opened: false, reason: "not_local", url });
      return;
    }
    const opened = await openSystemBrowser(url).catch(() => ({ opened: false, reason: "spawn_failed" }));
    res.json({ opened: Boolean(opened?.opened), url, ...(opened?.opened ? {} : { reason: opened?.reason || "spawn_failed" }) });
  }

  router.post("/openrouter/models/open", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      // No id: OpenRouter's model list (tools only). With one: that model's page.
      let url = OPENROUTER_BROWSE_URL;
      if (req.body?.id !== undefined) {
        const id = parseModelId(req.body.id);
        if (!id) throw apiError("invalid_model_id", MODEL_ID_HELP);
        url = modelPageUrl(id);
      }
      await openOpenRouterPage(res, url);
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  router.post("/openrouter/presets/open", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      await openOpenRouterPage(res, req.body?.new === true ? OPENROUTER_NEW_PRESET_URL : OPENROUTER_PRESETS_URL);
    } catch (error) {
      mapJobError(error, res, next);
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

  // ---- connect OpenRouter in one click (OAuth) -----------------------------
  // The flow state lives in memory in openrouter-oauth.js. Nothing below ever
  // returns the key: only a flow id, the sign-in address, and a status.

  const NOT_LOCAL = { ok: false, error: "not_available_here", message: "Connecting OpenRouter only works in the desktop app on your own computer." };

  router.post("/openrouter/connect", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      // The sign-in comes back to http://localhost:<port>, which only means
      // something when the app runs on the same computer as the browser.
      if (isDemoPublic() || authRequired()) {
        res.status(400).json(NOT_LOCAL);
        return;
      }
      const { flowId, authUrl } = startFlow({ port: getServerPort() });
      const opened = await openSystemBrowser(authUrl).catch(() => ({ opened: false }));
      res.json({ flowId, authUrl, status: "waiting", opened: Boolean(opened?.opened) });
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  function validateFlowId(req, res, next) {
    if (!FLOW_ID_PATTERN.test(String(req.params.flowId || ""))) {
      res.status(400).json({ ok: false, error: "invalid flow id" });
      return;
    }
    next();
  }

  router.get("/openrouter/connect/:flowId", validateFlowId, (req, res) => {
    const status = getOpenRouterFlowStatus(req.params.flowId);
    if (!status) {
      res.status(404).json({ ok: false, error: "flow not found" });
      return;
    }
    res.json(status);
  });

  router.delete("/openrouter/connect/:flowId", validateFlowId, (req, res) => {
    const status = cancelOpenRouterFlow(req.params.flowId);
    if (!status) {
      res.status(404).json({ ok: false, error: "flow not found" });
      return;
    }
    res.json(status);
  });

  // ---- local models (Ollama) ---------------------------------------------

  router.get("/ollama/models", async (req, res, next) => {
    try {
      const refresh = req.query.refresh === "1";
      res.json(await localBrainSummary(await systemCheck({ refresh }), { refresh }));
    } catch (error) {
      next(error);
    }
  });

  // A download is big, so it needs an explicit confirm:true (the screen shows
  // the size and asks first). The model name is checked inside startOllamaPull.
  router.post("/ollama/pull", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      res.json(await startOllamaPull({ model: req.body?.model }));
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  // ---- configure -----------------------------------------------------------

  const AGENT_IDS = ["hermes", "openclaw"];
  const MAX_MODEL_NAME = 200;

  // Reads both request shapes into { targets: {hermes?, openclaw?}, explicit }.
  // Returns { error } with a plain message when the body is wrong.
  function parseConfigureBody(body) {
    const modeError = 'mode must be "openrouter" or "ollama"';
    if (body?.targets !== undefined) {
      const raw = body.targets;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "targets must be an object" };
      const targets = {};
      for (const agentId of AGENT_IDS) {
        const entry = raw[agentId];
        if (entry === undefined || entry === null) continue;
        if (typeof entry !== "object" || (entry.mode !== "openrouter" && entry.mode !== "ollama")) return { error: modeError };
        const model = typeof entry.model === "string" ? entry.model.trim() : "";
        if (!model || model.length > MAX_MODEL_NAME) return { error: "model is required" };
        targets[agentId] = { mode: entry.mode, model };
      }
      if (!Object.keys(targets).length) return { error: "pick at least one agent" };
      return { targets, explicit: true };
    }
    const mode = body?.mode;
    if (mode !== "openrouter" && mode !== "ollama") return { error: modeError };
    const model = typeof body?.model === "string" ? body.model : "";
    return { targets: { hermes: { mode, model }, openclaw: { mode, model } }, explicit: false };
  }

  router.post("/configure", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const parsed = parseConfigureBody(req.body);
      if (parsed.error) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const targetList = Object.values(parsed.targets);

      if (targetList.some((t) => t.mode === "ollama")) {
        const summary = await localBrainSummary(await systemCheck({}));
        if (!summary.available) {
          res.status(400).json({ ok: false, error: "Ollama is not available on this computer" });
          return;
        }
        for (const target of targetList.filter((t) => t.mode === "ollama")) {
          const installed = summary.models.find((m) => m.name === target.model);
          if (!installed) {
            res.status(400).json({ ok: false, error: "model must already be pulled in Ollama" });
            return;
          }
          if (!installed.verdict.selectable) {
            res.status(400).json({ ok: false, error: "that model has no tool support, so an agent can't use it" });
            return;
          }
        }
      }

      let apiKey;
      let keySource;
      if (targetList.some((t) => t.mode === "openrouter")) {
        const pasted = req.body?.apiKey;
        if (typeof pasted === "string" && pasted.trim()) {
          apiKey = pasted;
        } else {
          const flowId = req.body?.keySource?.flowId;
          if (flowId === undefined) {
            res.status(400).json({ ok: false, error: "apiKey is required for OpenRouter" });
            return;
          }
          if (typeof flowId !== "string" || !FLOW_ID_PATTERN.test(flowId)) {
            res.status(400).json({ ok: false, error: "invalid flow id" });
            return;
          }
          if (getOpenRouterFlowStatus(flowId)?.status !== "connected") {
            res.status(409).json({ ok: false, error: "connection_not_ready", message: "Connect OpenRouter first, then try again." });
            return;
          }
          keySource = { flowId };
        }
        const { models } = await listFreeOpenRouterModels();
        for (const target of targetList.filter((t) => t.mode === "openrouter")) {
          if (!models.some((m) => m.id === target.model)) {
            res.status(400).json({ ok: false, error: "model must be one of the current free OpenRouter models" });
            return;
          }
        }
      }

      const job = await startConfigureJob({
        ...(parsed.explicit
          ? { targets: parsed.targets }
          : { mode: parsed.targets.hermes.mode, model: parsed.targets.hermes.model }),
        apiKey,
        keySource,
        reconfigure: req.body?.reconfigure && typeof req.body.reconfigure === "object" ? req.body.reconfigure : {},
        acceptOpenClawRisk: req.body?.acceptOpenClawRisk === true,
        // Only an explicit `true` lets a model that is too big for this
        // computer through; the server works out the fit itself.
        acceptLocalFit: req.body?.acceptLocalFit === true
      });
      res.json(job);
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  // ---- change one agent's model, or point it at an OpenRouter preset -----------------

  function validateAgentId(req, res, next) {
    if (!AGENT_IDS.includes(req.params.agentId)) {
      res.status(404).json({ ok: false, error: "unknown agent" });
      return;
    }
    next();
  }

  // Which model Hermes / OpenClaw uses right now (read through the agent's own
  // `config get`, never from its files).
  router.get("/agents/:agentId/model", validateAgentId, async (req, res, next) => {
    try {
      const check = await systemCheck({ refresh: req.query.refresh === "1" });
      res.json(await readAgentModel(req.params.agentId, check.agents?.[req.params.agentId]?.detected));
    } catch (error) {
      next(error);
    }
  });

  // Starts the job that gives one agent `ref` (a model id, or "@preset/<name>").
  // An agent already on OpenRouter has its key, so only its model setting
  // changes. One that is not (Local, or no brain yet) needs the key too, so it
  // needs a connected sign-in, and then goes through the full brain job.
  async function startAgentChange(agentId, ref, { presetSlug = null, body }) {
    const check = await systemCheck({});
    const detected = check.agents?.[agentId]?.detected;
    if (!detected?.installed) throw apiError("agent_not_installed", `${AGENT_LABEL[agentId]} isn't installed on this computer.`);
    const current = await readAgentModel(agentId, detected);
    if (current.provider === "openrouter") {
      return startModelJob({ agentId, model: ref, presetSlug, previous: { provider: current.provider, model: current.model } });
    }
    const flowId = flowIdFrom(body?.keySource?.flowId);
    if (!flowId || getOpenRouterFlowStatus(flowId)?.status !== "connected") {
      throw apiError("connection_not_ready", "Connect OpenRouter first, then try again.");
    }
    return startConfigureJob({
      targets: { [agentId]: { mode: "openrouter", model: ref } },
      keySource: { flowId },
      acceptOpenClawRisk: body?.acceptOpenClawRisk === true
    });
  }

  router.post("/agents/:agentId/model", validateAgentId, async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const model = parseModelId(req.body?.model);
      if (!model) throw apiError("invalid_model_id", MODEL_ID_HELP);
      // Ask OpenRouter first: a model that doesn't exist, or (for Hermes) is too
      // small, stops here with a plain reason instead of failing half way.
      const found = await lookupModel(model);
      if (found.notFound) throw apiError("model_not_found", "OpenRouter doesn't know that model. Check the ID on the model's page.");
      if (found.unreachable) throw apiError("openrouter_unreachable", UNREACHABLE);
      if (req.params.agentId === "hermes" && !found.model.hermesOk) {
        throw apiError(
          "model_too_small_for_hermes",
          "That model's working memory is too small for Hermes, which needs at least 64K. Pick a bigger model, or give it to OpenClaw."
        );
      }
      res.json(await startAgentChange(req.params.agentId, model, { body: req.body }));
    } catch (error) {
      mapJobError(error, res, next);
    }
  });

  // A preset is a model setup made on openrouter.ai and used by name
  // ("@preset/<name>"). Whether each agent accepts one is not proven, so the
  // job's hello test is what says yes.
  router.post("/agents/:agentId/preset", validateAgentId, async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const slug = parsePresetSlug(req.body?.slug);
      if (!slug) {
        throw apiError("invalid_preset", "A preset name uses only lowercase letters, numbers and dashes, for example my-agent-brain.");
      }
      // With a connected sign-in, ask OpenRouter whether the preset exists (the
      // key is used for that one question and never returned). Without one,
      // or if OpenRouter can't answer, the hello test decides.
      const flowId = flowIdFrom(req.body?.keySource?.flowId);
      const key = flowId ? peekKey(flowId) : null;
      if (key && (await checkPreset(slug, key)).exists === false) {
        throw apiError(
          "preset_not_found",
          "OpenRouter has no preset with that name. Check the name at openrouter.ai/settings/presets."
        );
      }
      res.json(await startAgentChange(req.params.agentId, presetModelId(slug), { presetSlug: slug, body: req.body }));
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
