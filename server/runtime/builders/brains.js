// Which "brain" each coding agent (Claude Code, Codex, Cursor) uses, and what to
// do when a plan runs out. Saved in <AGENT_OS_HOME>/config/builder-brains.json:
//
//   {
//     "claude": { "mode": "plan" | "openrouter" | "local", "model": null | "<id>" },
//     "codex":  { "mode": "plan" | "openrouter" | "local", "model": null | "<id>" },
//     "cursor": { "mode": "plan", "model": null | "composer-2.5" | "auto" },
//     "onLimit": "ask" | "auto",
//     "perRunBudgetUsd": null | <number of dollars>
//   }
//
//   plan        the person's own subscription (the default; nothing changes)
//   openrouter  pay per use through OpenRouter. model = an OpenRouter model id.
//   local       a model downloaded into Ollama on this computer. model = its name.
//   Cursor      only ever "plan": its command-line agent can only run models from
//               the person's Cursor plan. Its model is Cursor's own per-run choice.
//   onLimit     "ask" shows a banner when a plan runs out; "auto" may continue on
//               OpenRouter by itself, but only with a perRunBudgetUsd.
//
// A `model` is only kept for openrouter / local (and Cursor's two choices); in
// plan mode it is stored as null.
import { readJson, runtimePaths, writeJson } from "../store.js";
import { OLLAMA_MODEL_NAME_PATTERN } from "../setup/brain.js";
import { parseModelId } from "../setup/models.js";
import { BRAIN_MODES, CURSOR_MODELS, CURSOR_ONLY_PLAN, SAFE_MODEL_ARG, brainError } from "./brain-launch.js";

export const BUILDER_AGENT_IDS = ["claude", "codex", "cursor"];
export const ON_LIMIT_CHOICES = ["ask", "auto"];
const CONFIG_FILE = "builder-brains.json";
const MAX_BUDGET_USD = 1000;

const MODEL_ID_HELP =
  "That doesn't look like an OpenRouter model ID. It looks like author/model-name, for example anthropic/claude-sonnet-4.6.";

export function defaultBrains() {
  return {
    claude: { mode: "plan", model: null },
    codex: { mode: "plan", model: null },
    cursor: { mode: "plan", model: null },
    onLimit: "ask",
    perRunBudgetUsd: null
  };
}

// One agent's { mode, model }, checked. Used for the saved settings AND for a
// brain picked for a single run. Throws a brainError with a plain sentence.
export function validateAgentBrain(agentId, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw brainError("invalid_brain", `${agentId}: a brain is { mode, model }.`);
  }
  if (!BRAIN_MODES.includes(raw.mode)) {
    throw brainError("invalid_brain", 'The brain has to be "plan", "openrouter" or "local".');
  }
  if (agentId === "cursor") {
    if (raw.mode !== "plan") throw brainError("brain_not_supported", CURSOR_ONLY_PLAN);
    const model = raw.model ?? null;
    if (model !== null && !CURSOR_MODELS.includes(model)) {
      throw brainError("invalid_model", `Cursor's model can be ${CURSOR_MODELS.join(" or ")}, or left empty.`);
    }
    return { mode: "plan", model };
  }
  if (raw.mode === "plan") return { mode: "plan", model: null };
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (raw.mode === "openrouter") {
    const id = parseModelId(model);
    if (!id) throw brainError("invalid_model_id", MODEL_ID_HELP);
    return { mode: "openrouter", model: id };
  }
  // Ollama's own name pattern allows a leading "-", which a command line would read as a flag.
  if (!OLLAMA_MODEL_NAME_PATTERN.test(model) || !SAFE_MODEL_ARG.test(model)) {
    throw brainError("invalid_model", "That doesn't look like a local (Ollama) model name, for example qwen3:14b.");
  }
  return { mode: "local", model };
}

// `patch` laid over `current` (an agent that is present is replaced as a whole;
// one that is absent is kept), checked. Returns the full new settings.
export function mergeBrains(current, patch) {
  const next = { ...current };
  const given = patch && typeof patch === "object" ? patch : {};
  for (const agentId of BUILDER_AGENT_IDS) {
    if (given[agentId] !== undefined) next[agentId] = validateAgentBrain(agentId, given[agentId]);
  }
  if (given.onLimit !== undefined) {
    if (!ON_LIMIT_CHOICES.includes(given.onLimit)) {
      throw brainError("invalid_on_limit", 'When a plan runs out, choose "ask" or "auto".');
    }
    next.onLimit = given.onLimit;
  }
  if (given.perRunBudgetUsd !== undefined) {
    const budget = given.perRunBudgetUsd;
    if (budget === null) {
      next.perRunBudgetUsd = null;
    } else if (typeof budget === "number" && Number.isFinite(budget) && budget > 0 && budget <= MAX_BUDGET_USD) {
      next.perRunBudgetUsd = Math.round(budget * 100) / 100;
    } else {
      throw brainError("invalid_budget", `The spending limit per run is an amount in dollars, more than 0 and at most ${MAX_BUDGET_USD}.`);
    }
  }
  if (next.onLimit === "auto" && next.perRunBudgetUsd === null) {
    throw brainError("budget_required", "Continuing automatically needs a spending limit per run. Set one first.");
  }
  return next;
}

function configPath() {
  return `${runtimePaths().config}/${CONFIG_FILE}`;
}

// The saved settings (defaults for anything missing). A file that doesn't pass
// the checks is ignored rather than breaking every run.
export async function loadBrains() {
  const defaults = defaultBrains();
  const stored = await readJson(configPath(), null);
  if (!stored) return defaults;
  try {
    return mergeBrains(defaults, stored);
  } catch {
    return defaults;
  }
}

export async function saveBrains(patch) {
  const next = mergeBrains(await loadBrains(), patch);
  await writeJson(configPath(), next);
  return next;
}
