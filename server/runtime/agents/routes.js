// HTTP surface for agent adapters: read-only status, a dry preview, and the
// only paths that ever start a run/service action — all of them gated by
// the execution gate + confirm:true. Nothing here accepts a command, args,
// or a binary path from the request body; only a known adapter id picks
// which fixed adapter builds the plan.
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { builderErrorResponse, resolveBrainForRun } from "../builders/resolve.js";
import { watchForLimit } from "../builders/continue.js";
import { isExecutionEnabled } from "../execution-gate.js";
import { buildCommandPreview, getRunManager } from "../runs/run-manager.js";
import { withTaskLine } from "../runs/task-line.js";
import { runtimePaths } from "../store.js";
import { getAdapter, ADAPTERS } from "./index.js";

const MAX_PROMPT_LENGTH = 20000;

function sandboxError() {
  const error = new Error("folder must resolve inside the Agent OS sandbox");
  error.code = "folder_outside_sandbox";
  return error;
}

// v1 folder policy: the run's cwd is always inside the workspace sandbox.
// Defaults to <sandbox>/runs-work/<agentId>; an explicit folder must resolve
// (via realpath, so a symlink can't escape either) inside the same sandbox.
export async function resolveRunCwd(agentId, folder) {
  const paths = runtimePaths();
  await fs.mkdir(paths.workspace, { recursive: true });
  const sandboxRoot = await fs.realpath(paths.workspace);

  const requested = folder == null || folder === "" ? null : String(folder);
  if (requested == null) {
    const defaultDir = path.join(sandboxRoot, "runs-work", agentId);
    await fs.mkdir(defaultDir, { recursive: true });
    return fs.realpath(defaultDir);
  }

  // path.resolve(base, absolute) ignores base entirely, so an absolute
  // "folder" (e.g. "/tmp") must be rejected before it ever reaches resolve().
  if (requested.includes("\0") || path.isAbsolute(requested)) throw sandboxError();
  const candidate = path.resolve(sandboxRoot, requested);
  const relative = path.relative(sandboxRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw sandboxError();

  await fs.mkdir(candidate, { recursive: true });
  const real = await fs.realpath(candidate);
  const realRelative = path.relative(sandboxRoot, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw sandboxError();
  return real;
}

// A private scratch folder per run attempt, outside the workspace sandbox
// (mirrors how live-chat.js keeps its query files under runs/live-queries),
// for adapter-owned temp files such as Hermes's query.txt.
export async function makeRunDir(agentId) {
  const dir = path.join(
    runtimePaths().runs,
    "agent-adapters",
    agentId,
    `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function validatePrompt(body) {
  const prompt = String(body?.prompt ?? "");
  if (!prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) return null;
  return prompt;
}

// Only a boolean allowEdits is ever read; any other key in body.options
// (or a non-boolean allowEdits) is silently ignored rather than forwarded.
// (options.brain, a brain picked for this one run, is read separately by
// resolveBrain() below and only ever reaches an adapter after it is resolved.)
function validateOptions(body) {
  const raw = body?.options;
  const options = {};
  if (raw && typeof raw === "object" && typeof raw.allowEdits === "boolean") {
    options.allowEdits = raw.allowEdits;
  }
  return options;
}

// The brain for a run of Claude Code, Codex or Cursor: the saved setting
// (/api/builders/brains), or the one-run choice in body.options.brain
// ({ mode: "plan" | "openrouter" | "local", model }). Adds it to `options` only
// when it changes something; "plan" adds nothing, so a plan run is exactly what
// it always was. Answers false (after sending the 4xx) when the brain is refused.
async function resolveBrain(adapterId, body, options, res, { prepare }) {
  try {
    const brain = await resolveBrainForRun(adapterId, body?.options?.brain, { prepare });
    if (brain) options.brain = brain;
    return true;
  } catch (error) {
    if (sendBuilderError(error, res)) return false;
    throw error;
  }
}

// Brain refusals (no saved OpenRouter key, a model that isn't downloaded,
// Cursor with OpenRouter...) are plain 4xx answers: { error, message }.
function sendBuilderError(error, res) {
  const mapped = builderErrorResponse(error);
  if (!mapped) return false;
  res.status(mapped.status).json(mapped.body);
  return true;
}

// What the "continue after a plan limit" code needs from this file.
export function continueDeps(manager = getRunManager()) {
  return { manager, resolveRunCwd, makeRunDir };
}

const BUILDER_IDS = new Set(["claude", "codex", "cursor"]);

function requireAdapter(req, res, next) {
  const adapter = getAdapter(req.params.id);
  if (!adapter) {
    res.status(404).json({ ok: false, error: "unknown agent id" });
    return;
  }
  req.adapter = adapter;
  next();
}

// Safety actions are quick config-set commands (a handful of seconds at
// most; see each adapter's SAFETY_ACTION_TIMEOUT_MS), so it's fine for the
// request to wait for one to finish before deciding whether a gateway
// restart follow-up is needed. If it somehow takes longer, we give up
// waiting and use whatever state the run is in.
function waitForRunTerminal(id, timeoutMs) {
  const limit = Math.max(1000, Number(timeoutMs) || 0) + 2000;
  return getRunManager().waitForRun(id, { timeoutMs: limit });
}

function mapStartRunError(error, res, next) {
  if (error?.code === "too_many_runs") {
    res.status(429).json({ error: "too_many_runs" });
    return;
  }
  if (error?.code === "blocked_flag") {
    res.status(400).json({ error: "blocked_flag" });
    return;
  }
  next(error);
}

export function createAgentsRouter() {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const refresh = req.query.refresh === "1";
      const agents = await Promise.all(
        Object.values(ADAPTERS).map(async (adapter) => ({
          id: adapter.id,
          label: adapter.label,
          homepage: adapter.homepage,
          docsUrl: adapter.docsUrl,
          license: adapter.license,
          detected: await adapter.detect({ refresh })
        }))
      );
      res.json({ agents });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", requireAdapter, async (req, res, next) => {
    try {
      const adapter = req.adapter;
      const detected = await adapter.detect();
      const [config, safety, service] = await Promise.all([
        adapter.configStatus(detected),
        adapter.safetyStatus(detected),
        adapter.service ? adapter.service.status(detected) : Promise.resolve(null)
      ]);
      res.json({ detected, config, safety, service });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/runs/preview", requireAdapter, async (req, res, next) => {
    try {
      const adapter = req.adapter;
      const prompt = validatePrompt(req.body);
      if (!prompt) {
        res.status(400).json({ ok: false, error: "prompt must be a non-empty string of at most 20000 characters" });
        return;
      }
      let cwd;
      try {
        cwd = await resolveRunCwd(adapter.id, req.body?.folder);
      } catch (error) {
        if (error.code === "folder_outside_sandbox") {
          res.status(403).json({ error: "folder_outside_sandbox" });
          return;
        }
        throw error;
      }
      const detected = await adapter.detect();
      const options = validateOptions(req.body);
      // A preview changes nothing, so a local model's 64K copy is named, not made.
      if (!(await resolveBrain(adapter.id, req.body, options, res, { prepare: false }))) return;
      const runDir = await makeRunDir(adapter.id);
      let plan;
      try {
        plan = await adapter.buildRun({ prompt, cwd, detected, runDir, options });
      } catch (error) {
        if (error?.code === "allow_edits_not_supported") {
          res.status(400).json({ error: error.code, message: error.message });
          return;
        }
        if (sendBuilderError(error, res)) return;
        throw error;
      } finally {
        // Preview spawns nothing; drop whatever buildRun wrote (e.g. Hermes's
        // query file, a Claude settings file) instead of leaving it behind for no run.
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
      res.json({
        commandPreview: buildCommandPreview(plan),
        cwd,
        transport: plan.title || "",
        // Which brain this run would use ({ mode, model }; plan when nothing is changed).
        brain: plan.meta?.brain || null,
        gate: { enabled: await isExecutionEnabled() }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/runs", requireAdapter, async (req, res, next) => {
    try {
      const adapter = req.adapter;
      if (!(await isExecutionEnabled())) {
        res.status(403).json({ error: "execution_gate_off" });
        return;
      }
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const prompt = validatePrompt(req.body);
      if (!prompt) {
        res.status(400).json({ ok: false, error: "prompt must be a non-empty string of at most 20000 characters" });
        return;
      }
      let cwd;
      try {
        cwd = await resolveRunCwd(adapter.id, req.body?.folder);
      } catch (error) {
        if (error.code === "folder_outside_sandbox") {
          res.status(403).json({ error: "folder_outside_sandbox" });
          return;
        }
        throw error;
      }
      const detected = await adapter.detect();
      const options = validateOptions(req.body);
      if (!(await resolveBrain(adapter.id, req.body, options, res, { prepare: true }))) return;
      const runDir = await makeRunDir(adapter.id);
      let plan;
      try {
        plan = await adapter.buildRun({ prompt, cwd, detected, runDir, options });
      } catch (error) {
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
        if (error?.code === "allow_edits_not_supported") {
          res.status(400).json({ error: error.code, message: error.message });
          return;
        }
        if (sendBuilderError(error, res)) return;
        throw error;
      }
      try {
        const run = await getRunManager().startRun(withTaskLine(plan, prompt));
        // A Claude Code / Codex / Cursor run that ends at a plan limit may be
        // continued by itself, if the person set "continue automatically".
        if (BUILDER_IDS.has(adapter.id)) watchForLimit(run.id, continueDeps());
        res.json(run);
      } catch (error) {
        // Nothing started, so drop the private folder (and any settings file in it).
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
        mapStartRunError(error, res, next);
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/service", requireAdapter, async (req, res, next) => {
    try {
      const adapter = req.adapter;
      if (!adapter.service) {
        res.status(404).json({ ok: false, error: "agent has no service" });
        return;
      }
      const detected = await adapter.detect();
      res.json(await adapter.service.status(detected));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/service/:action", requireAdapter, async (req, res, next) => {
    try {
      const adapter = req.adapter;
      const action = req.params.action;
      if (!adapter.service || !["start", "stop", "restart"].includes(action)) {
        res.status(404).json({ ok: false, error: "unknown service action" });
        return;
      }
      // Stopping only reduces what runs, the same reasoning as "Hold to stop all",
      // so Stop works at Look only too. Start and Restart stay behind the gate.
      if (action !== "stop" && !(await isExecutionEnabled())) {
        res.status(403).json({ error: "execution_gate_off" });
        return;
      }
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const detected = await adapter.detect();
      const plan = adapter.service[action](detected);
      try {
        const run = await getRunManager().startRun(plan);
        res.json(run);
      } catch (error) {
        mapStartRunError(error, res, next);
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/safety/:actionId", requireAdapter, async (req, res, next) => {
    try {
      const adapter = req.adapter;
      if (typeof adapter.safetyAction !== "function") {
        res.status(404).json({ ok: false, error: "unknown safety action" });
        return;
      }
      if (!(await isExecutionEnabled())) {
        res.status(403).json({ error: "execution_gate_off" });
        return;
      }
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const detected = await adapter.detect();
      // A fix or choice runs only while the agent's panel offers it right now: a
      // stricter setting (say OpenClaw's "deny") must never be moved to a looser
      // one just because the adapter knows the id.
      const offered = await adapter.safetyStatus(detected);
      const isOffered = [...(offered?.actions ?? []), ...(offered?.choices ?? [])].some(
        (item) => item.id === req.params.actionId
      );
      if (!isOffered) {
        res.status(409).json({ ok: false, error: "This change isn't offered right now. Refresh the page." });
        return;
      }
      const plan = await adapter.safetyAction(req.params.actionId, detected);
      if (!plan) {
        res.status(404).json({ ok: false, error: "unknown safety action" });
        return;
      }
      let run;
      try {
        run = await getRunManager().startRun(plan);
      } catch (error) {
        mapStartRunError(error, res, next);
        return;
      }
      const finished = await waitForRunTerminal(run.id, plan.timeoutMs);
      let followUp = null;
      let followUpNote = null;
      if (plan.restartsGateway && finished?.status === "succeeded" && adapter.service) {
        const serviceStatus = await adapter.service.status(detected);
        if (serviceStatus?.running) {
          try {
            followUp = await getRunManager().startRun(adapter.service.restart(detected));
            followUpNote = "Restarting the gateway so this takes effect…";
          } catch {
            followUp = null; // best-effort: the safety change itself already succeeded
          }
        }
      }
      // A second step the plan names (Hermes's "ask-risky": the rule first, then the mode).
      // It starts only when the first run succeeded, and never together with a restart.
      if (plan.then && !followUp && finished?.status === "succeeded") {
        try {
          followUp = await getRunManager().startRun(plan.then);
          followUpNote = plan.then.note ?? null;
        } catch {
          followUp = null; // best-effort, like the restart: the first change already succeeded
        }
      }
      res.json({ run: finished || run, followUp, followUpNote });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
