// What the three coding-agent adapters (claude.js, codex.js, cursor.js) need to
// start a run on a "brain" other than the person's own plan. A brain is
//   { mode: "plan" | "openrouter" | "local", model, local? }
// `plan` (or no brain at all) means "run the agent exactly as before": the
// adapters leave their command line byte-for-byte untouched. The other two
// are built here:
//
//   Claude Code  a private settings FILE in the run folder, passed with
//                --settings (it outranks the person's own settings, which an
//                environment variable would not). Deleted when the run ends.
//   Codex        extra `-c key=value` items on its command line.
//
// The OpenRouter key is NEVER written into either: the agent is given a read
// helper (see secrets/keystore.js) that prints it when asked.
//
// This file must stay a leaf (it may import only the keystore): setup/brain.js
// imports the agent adapters, so importing it from here would make a loop. The
// checks that need the network or Ollama (is the key saved? is the local model
// downloaded?) live in resolve.js, which the HTTP routes call BEFORE the
// adapter; the adapters re-check everything cheap again, as defence in depth.
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { helperCommandLine, openRouterKeyHelper } from "../secrets/keystore.js";

export const BRAIN_MODES = ["plan", "openrouter", "local"];
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_CODEX_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
// Same number as LOCAL_CONTEXT_TOKENS in setup/brain.js (a test keeps them equal).
export const LOCAL_CONTEXT_TOKENS = 65536;
// What Cursor's command line accepts as a per-run model here. "auto" bills at
// the price of whichever model it picks.
export const CURSOR_MODELS = ["composer-2.5", "auto"];

// A model name as it goes into a command line: only these characters, and never
// a leading "-" (so it can't be read as a flag). Same set as MODEL_ID_PATTERN
// in setup/models.js (a test keeps them equal); Ollama names fit it too.
export const SAFE_MODEL_ARG = /^[A-Za-z0-9._:/@~][A-Za-z0-9._:/@~-]{0,119}$/;
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const RUN_ID_PATTERN = /^[a-z0-9_-]{6,64}$/;
const MAX_BUDGET_USD = 1000;

export const MISSING_KEY_MESSAGE =
  "Agent OS doesn't have your OpenRouter key saved yet, so it won't start this on OpenRouter (that could send your own sign-in to the wrong place). Save your key first with \"Remember my OpenRouter key\".";
export const CURSOR_ONLY_PLAN =
  "Cursor's command-line agent can only use models from your Cursor plan, so OpenRouter and Local aren't available for it.";

export function brainError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, { extra });
  return error;
}

// ---- reading options.brain --------------------------------------------------------------------

// Turns whatever the caller passed as `options.brain` into the one shape the
// rest of this file uses, or throws. `agentId` is "claude" | "codex" | "cursor".
export function normalizeBrain(raw, agentId) {
  if (raw === undefined || raw === null) return { mode: "plan", model: null };
  if (typeof raw !== "object" || Array.isArray(raw) || !BRAIN_MODES.includes(raw.mode)) {
    throw brainError("invalid_brain", 'A brain is { mode: "plan" | "openrouter" | "local", model }.');
  }
  if (agentId === "cursor") {
    if (raw.mode !== "plan") throw brainError("brain_not_supported", CURSOR_ONLY_PLAN);
    const model = raw.model ?? null;
    if (model !== null && !CURSOR_MODELS.includes(model)) {
      throw brainError("invalid_model", `Cursor can use ${CURSOR_MODELS.join(" or ")} here, or its default.`);
    }
    return { mode: "plan", model };
  }
  if (raw.mode === "plan") return { mode: "plan", model: null };

  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!SAFE_MODEL_ARG.test(model)) {
    throw brainError("invalid_model", "That model name can't be used. Pick one from the list.");
  }
  const brain = { mode: raw.mode, model };
  if (raw.mode === "local") {
    const local = raw.local && typeof raw.local === "object" ? raw.local : {};
    const baseUrl = local.baseUrl === undefined ? DEFAULT_OLLAMA_URL : local.baseUrl;
    const localModel = local.model === undefined ? model : local.model;
    // Local never means "some other computer": that would hand it a stand-in password.
    if (typeof baseUrl !== "string" || !LOOPBACK_URL.test(baseUrl) || !SAFE_MODEL_ARG.test(String(localModel))) {
      throw brainError("invalid_brain", "The local model has to be served from this computer.");
    }
    brain.local = { provider: "ollama", baseUrl, model: localModel };
  }
  return brain;
}

// options.resume: { sessionId, fork } -- Claude only; null when absent.
export function normalizeResume(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.sessionId !== "string" || !SESSION_ID_PATTERN.test(raw.sessionId)) {
    throw brainError("invalid_resume", "That earlier session can't be continued.");
  }
  return { sessionId: raw.sessionId, fork: raw.fork !== false };
}

// options.maxBudgetUsd: a hard spending cap for one run, or null.
export function normalizeBudget(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_BUDGET_USD ? Math.round(n * 100) / 100 : null;
}

// What every run records about itself (the run manager copies `meta` onto the
// run and keeps `taskPrompt` in a private file, so a limit can be continued):
//   meta.brain {mode, model}  meta.task {cwd, allowEdits}  meta.continuedFrom
// For a continued run the saved task is the ORIGINAL one, not the hand-over text.
export function runRecord({ prompt, cwd, brain, options = {} }) {
  const meta = {
    brain: { mode: brain.mode, model: brain.model ?? null },
    task: { cwd, allowEdits: options.allowEdits === true }
  };
  if (typeof options.continuedFrom === "string" && RUN_ID_PATTERN.test(options.continuedFrom)) {
    meta.continuedFrom = options.continuedFrom;
  }
  const original = typeof options.originalPrompt === "string" && options.originalPrompt.trim() ? options.originalPrompt : prompt;
  return { meta, taskPrompt: original };
}

// Plain-English heads-ups shown as the first lines of the run.
export function brainNotices(agentId, brain) {
  const notices = [];
  const label = agentId === "claude" ? "Claude Code" : agentId === "codex" ? "Codex" : "Cursor";
  if (brain.mode === "openrouter") {
    notices.push(`${label} is running on OpenRouter (${brain.model}). You pay OpenRouter per use; your ${label} plan isn't used for this run.`);
    if (agentId === "claude" && !/^~?anthropic\//.test(brain.model)) {
      notices.push("Experimental: only Claude models work reliably with Claude Code on OpenRouter.");
    }
    if (agentId === "codex" && !/^~?openai\//.test(brain.model)) {
      notices.push("Experimental: OpenAI models work best with Codex on OpenRouter; other models may fail on some tools.");
    }
  } else if (brain.mode === "local") {
    notices.push(`${label} is running on a local model (${brain.model}) on this computer. Experimental: local models use tools less reliably.`);
  } else if (agentId === "cursor" && brain.model === "auto") {
    notices.push("Cursor's Auto is billed at the price of the model it picks.");
  }
  return notices;
}

// ---- Claude Code: the settings file ----------------------------------------------------------------

// `scrub` is false only for an interactive session (spec H2): there the
// person's MCP servers and Bash tool keep their credentials, as in Terminal.
function claudeEnv(baseUrl, authToken, model, { scrub = true } = {}) {
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_API_KEY: "",
    // Empty values switch off anything in the person's own settings that would
    // send this run to Amazon, Google or Microsoft instead.
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    // Claude Code uses its "small" model for titles and quick checks; with one
    // model chosen, that model does them too.
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model
  };
  if (scrub) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  return env;
}

// The hard rule: a custom ANTHROPIC_BASE_URL on its own would make Claude Code
// send the person's saved claude.ai sign-in to that address. So a base URL is
// only ever written next to a credential of its own: a key helper (OpenRouter),
// or a stand-in token for an address on this computer (Local).
export function assertSafeClaudeSettings(settings) {
  const env = settings && typeof settings.env === "object" && settings.env ? settings.env : {};
  const baseUrl = String(env.ANTHROPIC_BASE_URL || "");
  if (!baseUrl) return;
  const hasHelper = typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim() !== "";
  const hasToken = typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.trim() !== "";
  if (hasHelper || (hasToken && LOOPBACK_URL.test(baseUrl))) return;
  throw brainError(
    "base_url_without_credential",
    "Agent OS stopped this run: it would have pointed Claude Code at another address without a key of its own, which could send your Claude sign-in there."
  );
}

// The settings for one run on `brain`. `helper` is the key's read helper
// (openRouterKeyHelper()); without it an OpenRouter run is refused.
// `forSession: true` (an interactive session, planning decision Q9) leaves out
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB; headless runs keep it.
export function buildClaudeSettings(brain, helper, { forSession = false } = {}) {
  const scrub = !forSession;
  let settings;
  if (brain.mode === "openrouter") {
    if (!helper) throw brainError("openrouter_key_missing", MISSING_KEY_MESSAGE);
    settings = {
      apiKeyHelper: helperCommandLine(helper),
      env: claudeEnv(OPENROUTER_ANTHROPIC_BASE_URL, "", brain.model, { scrub })
    };
  } else {
    // "ollama" is a stand-in the local server ignores; it only has to be there
    // so Claude Code doesn't send the claude.ai sign-in.
    settings = { env: claudeEnv(brain.local.baseUrl, "ollama", brain.local.model, { scrub }) };
  }
  assertSafeClaudeSettings(settings);
  return settings;
}

// Writes the settings into the run folder (mode 0600) and returns { file, remove }.
export async function writeClaudeSettingsFile(runDir, settings) {
  assertSafeClaudeSettings(settings);
  const file = path.join(runDir, `claude-settings-${crypto.randomBytes(6).toString("hex")}.json`);
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { file, remove: () => fs.rm(file, { force: true }) };
}

// ---- Codex: extra command-line items -------------------------------------------------------------

// A TOML text value. JSON's string escapes are also valid TOML escapes.
const toml = (value) => JSON.stringify(String(value));

// Each `-c` and each `key=value` is its own command-line item (no shell involved).
// `forSession: true` (an interactive session, planning decision Q9b) leaves out
// Codex's own environment scrub (shell_environment_policy.ignore_default_excludes=false),
// so Codex's shell tool sees the person's own variables as in Terminal (H2);
// headless runs keep it. The key still comes through the auth command, never
// the environment, so nothing of Agent OS's is exposed either way.
export function codexBrainArgs(brain, helper, { forSession = false } = {}) {
  if (brain.mode === "openrouter") {
    if (!helper) throw brainError("openrouter_key_missing", MISSING_KEY_MESSAGE);
    return [
      "-c", `model_provider=${toml("openrouter")}`,
      "-c", `model_providers.openrouter.name=${toml("OpenRouter")}`,
      "-c", `model_providers.openrouter.base_url=${toml(OPENROUTER_CODEX_BASE_URL)}`,
      "-c", `model_providers.openrouter.wire_api=${toml("responses")}`,
      // The auth-command form. Never combined with env_key (that is the
      // variable form, which would put the key in the environment).
      "-c", `model_providers.openrouter.auth={command=${toml(helper.command)}, args=[${helper.args.map(toml).join(", ")}]}`,
      ...(forSession ? [] : ["-c", "shell_environment_policy.ignore_default_excludes=false"]),
      "-m", brain.model
    ];
  }
  return [
    "--oss",
    "--local-provider", "ollama",
    "-m", brain.local.model,
    "-c", `model_context_window=${LOCAL_CONTEXT_TOKENS}`
  ];
}

// The key's read helper, or null (a thin pass-through so the adapters import one place).
export async function keyHelper() {
  return openRouterKeyHelper();
}
