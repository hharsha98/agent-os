// The "brain" half of the Setup Assistant: which model provider to use,
// free OpenRouter models that fit Hermes's needs, a private key check, and
// each agent's current configured/not-configured status. Nothing here ever
// writes an API key to disk -- verifyOpenRouterKey() only ever forwards it
// to OpenRouter's own key-check endpoint and returns a yes/no.
import os from "node:os";
import path from "node:path";
import { ADAPTERS } from "../agents/index.js";
import { fileExists } from "../store.js";
import { applyMirror } from "./recipes.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const MODELS_TIMEOUT_MS = 10 * 1000;
const KEY_TIMEOUT_MS = 10 * 1000;
const OLLAMA_TIMEOUT_MS = 2 * 1000;
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_MODELS = 30;
const MAX_KEY_LENGTH = 200;
// Hermes's own documented minimum: local models need 64K+ context.
export const HERMES_MIN_CONTEXT = 64000;

let modelsCache = null; // { at, value }

async function fetchWithTimeout(url, { timeoutMs, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

export async function listFreeOpenRouterModels({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && modelsCache && now - modelsCache.at < MODELS_CACHE_TTL_MS) {
    return modelsCache.value;
  }
  try {
    const response = await fetchWithTimeout(applyMirror(MODELS_URL), { timeoutMs: MODELS_TIMEOUT_MS });
    if (!response.ok) throw new Error(`OpenRouter models request failed (HTTP ${response.status}).`);
    const body = await response.json();
    const list = Array.isArray(body?.data) ? body.data : [];
    const free = list.filter(
      (m) =>
        m?.pricing?.prompt === "0" &&
        m?.pricing?.completion === "0" &&
        Array.isArray(m?.supported_parameters) &&
        m.supported_parameters.includes("tools") &&
        Number(m?.context_length) >= HERMES_MIN_CONTEXT
    );
    free.sort((a, b) => Number(b.context_length) - Number(a.context_length));
    const models = free.slice(0, MAX_MODELS).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      contextLength: Number(m.context_length)
    }));
    const value = { models };
    modelsCache = { at: now, value };
    return value;
  } catch (error) {
    return { models: [], error: error?.message || "Could not reach OpenRouter to list models." };
  }
}

// Test-only: forces the next listFreeOpenRouterModels() to refetch.
export function clearBrainCacheForTest() {
  modelsCache = null;
}

export async function verifyOpenRouterKey(apiKey) {
  const key = typeof apiKey === "string" ? apiKey : "";
  // Malformed keys are rejected before any network call -- the mirror in
  // tests sees no hit for these.
  if (!key.trim() || key.length > MAX_KEY_LENGTH) {
    return { ok: false, error: "That doesn't look like a valid OpenRouter API key." };
  }
  try {
    const response = await fetchWithTimeout(applyMirror(KEY_URL), {
      timeoutMs: KEY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!response.ok) {
      return { ok: false, error: "OpenRouter rejected that key." };
    }
    const body = await response.json().catch(() => null);
    const data = body?.data || {};
    const result = { ok: true };
    if (typeof data.label === "string") result.label = data.label;
    if (typeof data.limit === "number") result.limit = data.limit;
    return result;
  } catch {
    return { ok: false, error: "Could not reach OpenRouter to verify the key." };
  }
}

// Overridable so tests never have to bind (or fight over) the real Ollama
// port -- same idea as recipes.js's AGENT_OS_SETUP_MIRROR for the installer
// hosts. Unset in production; always http://127.0.0.1:11434 there.
// Only loopback overrides are honoured, like the installer mirror.
function ollamaBaseUrl() {
  const override = String(process.env.AGENT_OS_OLLAMA_URL || "").trim();
  if (override && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(override)) return override;
  return "http://127.0.0.1:11434";
}

async function ollamaReachable() {
  try {
    const response = await fetchWithTimeout(`${ollamaBaseUrl()}/api/tags`, { timeoutMs: OLLAMA_TIMEOUT_MS });
    return response.ok;
  } catch {
    return false;
  }
}

// The list of model tags already pulled into a locally running Ollama, used
// to validate a POST /configure request for mode:"ollama".
export async function listOllamaTags() {
  try {
    const response = await fetchWithTimeout(`${ollamaBaseUrl()}/api/tags`, { timeoutMs: OLLAMA_TIMEOUT_MS });
    if (!response.ok) return [];
    const body = await response.json();
    const models = Array.isArray(body?.models) ? body.models : [];
    return models.map((m) => m?.name || m?.model).filter(Boolean);
  } catch {
    return [];
  }
}

async function ollamaOption(check) {
  const installed = Boolean(check?.ollama?.found);
  const reachable = installed ? await ollamaReachable() : false;
  if (!installed || !reachable) {
    return {
      id: "ollama",
      available: false,
      reason: "Local models are coming in the next update of the Setup Assistant."
    };
  }
  return { id: "ollama", available: true };
}

export async function brainOptions(check) {
  const openrouter = { id: "openrouter", available: true };
  const ollama = await ollamaOption(check);
  const ramGb = Number(check?.ramGb) || 0;
  const freeDiskGb = Number(check?.freeDiskGb) || 0;
  const recommendOllama = ollama.available && ramGb >= 16 && freeDiskGb >= 10;
  const recommendation = recommendOllama ? "ollama" : "openrouter";
  const reason = recommendOllama
    ? "Your computer has enough memory and disk space to run a local model privately and for free, so we recommend that; OpenRouter's free models are usually higher quality but send your messages to a cloud provider."
    : "We recommend OpenRouter: it gives you strong, free models with no large download, while local models either aren't available yet on this computer or need more RAM/disk than it has.";
  return { recommendation, reason, options: [openrouter, ollama] };
}

async function agentBrainStatus(agentId, detected) {
  const adapter = ADAPTERS[agentId];
  if (!detected?.installed) {
    return { configured: false, source: "doctor", summary: `${adapter.label} is not installed.` };
  }
  const status = await adapter.configStatus(detected);
  if (agentId === "openclaw") {
    const jsonExists = await fileExists(path.join(os.homedir(), ".openclaw", "openclaw.json"));
    return { configured: Boolean(status.ok && jsonExists), source: "status", summary: status.summary };
  }
  return { configured: Boolean(status.ok), source: "doctor", summary: status.summary };
}

// Never reads either agent's config contents -- only doctor/status output
// (already non-secret) and, for OpenClaw, whether its config file exists.
export async function currentBrain(check) {
  const [hermes, openclaw] = await Promise.all([
    agentBrainStatus("hermes", check?.agents?.hermes?.detected),
    agentBrainStatus("openclaw", check?.agents?.openclaw?.detected)
  ]);
  return { hermes, openclaw };
}
