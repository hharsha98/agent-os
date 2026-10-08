// Turns "the person wants Claude Code on OpenRouter / on a local model" into a
// brain the adapters can launch, or refuses with a plain sentence. This is the
// part that talks to the outside (the key store, Ollama); the adapters
// themselves (agents/claude.js, codex.js) only build command lines.
//
// A resolved brain is
//   { mode: "plan", model }                                     (Cursor may carry a model)
//   { mode: "openrouter", model }
//   { mode: "local", model, local: { provider: "ollama", baseUrl, model } }
// where local.model is the name the agent is told to use: for Claude Code the
// 64K settings-only copy ("agentos-<model>:64k", so Ollama really serves a 64K
// window); for Codex the downloaded model itself.
//
// Every refusal is a brainError whose `code` and `message` are fixed sentences
// written here (safe to show). builderErrorResponse() turns one into the HTTP
// status and body the routes send.
import { openRouterKeyHelper } from "../secrets/keystore.js";
import {
  LOCAL_MODEL_TABLE,
  ensureLocalVariant,
  fetchWithTimeout,
  listLocalModels,
  localVariantName,
  ollamaBaseUrl
} from "../setup/brain.js";
import { MISSING_KEY_MESSAGE, brainError } from "./brain-launch.js";
import { BUILDER_AGENT_IDS, loadBrains, validateAgentBrain } from "./brains.js";

// The oldest Ollama that speaks what each agent needs (Claude Code: the
// Anthropic API, 0.14; Codex: the Responses API, 0.13.4).
export const OLLAMA_MIN_VERSION = { claude: "0.14.0", codex: "0.13.4" };
const OLLAMA_VERSION_TIMEOUT_MS = 3 * 1000;

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(have, need) {
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" };

// Is Ollama running, and new enough? A server that doesn't report its version
// is let through (the model check that follows still has to pass).
async function requireOllama(agentId) {
  let response;
  try {
    response = await fetchWithTimeout(`${ollamaBaseUrl()}/api/version`, { timeoutMs: OLLAMA_VERSION_TIMEOUT_MS });
  } catch {
    throw brainError("ollama_unavailable", "Ollama isn't running. Open the Ollama app, then try again.");
  }
  if (!response.ok) return;
  const body = await response.json().catch(() => null);
  const have = parseVersion(body?.version);
  const need = OLLAMA_MIN_VERSION[agentId];
  if (have && !versionAtLeast(have, parseVersion(need))) {
    throw brainError(
      "ollama_too_old",
      `${AGENT_LABEL[agentId]} needs Ollama ${need} or newer, and this one is ${have.join(".")}. Update Ollama, then try again.`
    );
  }
}

// `requested` is { mode, model } (the saved setting or a per-run choice).
// prepare:false (a preview) never changes Ollama: it names the 64K copy without making it.
export async function resolveBuilderBrain(agentId, requested, { prepare = true } = {}) {
  const brain = validateAgentBrain(agentId, requested);
  if (brain.mode === "plan") return brain;

  if (brain.mode === "openrouter") {
    // Without a saved key the run would have no credential of its own, so it
    // does not start (see assertSafeClaudeSettings for why that matters).
    if (!(await openRouterKeyHelper())) throw brainError("openrouter_key_missing", MISSING_KEY_MESSAGE);
    return brain;
  }

  await requireOllama(agentId);
  // `--oss` and `ollama launch` would quietly download gigabytes for a model
  // that isn't there, so the model must already be installed.
  const installed = (await listLocalModels({}, { refresh: true })).find((model) => model.name === brain.model);
  if (!installed) {
    const row = LOCAL_MODEL_TABLE.find((entry) => entry.model === brain.model);
    throw brainError(
      "local_model_missing",
      `${brain.model} isn't downloaded yet. Download it first${row ? ` (${row.downloadGb} GB)` : ""}, then try again.`,
      { model: brain.model, ...(row ? { downloadGb: row.downloadGb } : {}) }
    );
  }
  if (!installed.verdict.selectable) {
    throw brainError("local_model_no_tools", `${brain.model} can't use tools, so a coding agent can't work with it. Pick another model.`);
  }
  const localName =
    agentId === "claude" ? (prepare ? (await ensureLocalVariant(brain.model)).name : localVariantName(brain.model)) : brain.model;
  if (!localName) {
    throw brainError("invalid_variant_name", `Can't make a 64K copy of "${brain.model.slice(0, 60)}". Pick another model, or use OpenRouter.`);
  }
  return { ...brain, local: { provider: "ollama", baseUrl: ollamaBaseUrl(), model: localName } };
}

// What the agents route calls for a run of `agentId`: the saved brain, or the
// person's one-run choice (`override`, a { mode, model }). Null means "leave the
// agent alone" (a plan with nothing to change), so nothing is added to the run.
export async function resolveBrainForRun(agentId, override, { prepare = true } = {}) {
  if (!BUILDER_AGENT_IDS.includes(agentId)) return null;
  const requested = override === undefined || override === null ? (await loadBrains())[agentId] : override;
  const brain = await resolveBuilderBrain(agentId, requested, { prepare });
  return brain.mode === "plan" && !brain.model ? null : brain;
}

// ---- refusals as HTTP answers ----------------------------------------------------------------------

const STATUS = {
  invalid_brain: 400,
  invalid_model_id: 400,
  invalid_model: 400,
  invalid_on_limit: 400,
  invalid_budget: 400,
  budget_required: 400,
  brain_not_supported: 400,
  brain_not_supported_by_cli: 409,
  local_model_no_tools: 400,
  invalid_variant_name: 400,
  invalid_resume: 400,
  openrouter_key_missing: 409,
  base_url_without_credential: 409,
  local_model_missing: 409,
  ollama_unavailable: 409,
  ollama_too_old: 409,
  local_prepare_failed: 502,
  // continuing a run (builders/continue.js)
  run_not_found: 404,
  not_continuable: 409,
  continue_in_progress: 409,
  invalid_continue_target: 400,
  agent_not_installed: 409,
  folder_outside_sandbox: 403,
  execution_gate_off: 403,
  // what the run manager says when a run can't start
  too_many_runs: 429,
  blocked_flag: 400
};

// { status, body } for an error this module family throws, or null for anything
// else (let the normal error handler deal with it). The body is
// { error: code, message, ...extra } -- only sentences and numbers we wrote.
export function builderErrorResponse(error) {
  const status = STATUS[error?.code];
  if (!status) return null;
  const extra = error.extra && typeof error.extra === "object" ? error.extra : {};
  return { status, body: { error: error.code, message: error.message, ...extra } };
}
