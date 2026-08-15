import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { redactText, sanitizeObject } from "./safety.js";

export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const ALLOWED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const ALLOWED_API_MODES = new Set(["responses", "chat"]);

function cleanBaseUrl(value) {
  const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error("The Codex API base URL must be a valid http or https URL.");
    error.status = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    const error = new Error("The Codex API base URL must use http or https and cannot contain credentials.");
    error.status = 400;
    throw error;
  }
  return raw;
}

function numberBetween(value, fallback, min, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function resolveConfig() {
  const stored = await getStoredConnectionConfig();
  const key =
    process.env.OPENAI_API_KEY ||
    getConfiguredValue(stored, "provider-openai", "OPENAI_API_KEY") ||
    getConfiguredValue(stored, "codex", "OPENAI_API_KEY") ||
    null;
  const model = String(
    process.env.AGENT_OS_CODEX_MODEL ||
    getConfiguredValue(stored, "provider-openai", "AGENT_OS_CODEX_MODEL") ||
    DEFAULT_CODEX_MODEL
  ).trim() || DEFAULT_CODEX_MODEL;
  const baseUrl = cleanBaseUrl(
    process.env.AGENT_OS_OPENAI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    getConfiguredValue(stored, "provider-openai", "AGENT_OS_OPENAI_BASE_URL") ||
    DEFAULT_OPENAI_BASE_URL
  );
  const requestedEffort = String(
    process.env.AGENT_OS_CODEX_REASONING_EFFORT ||
    getConfiguredValue(stored, "provider-openai", "AGENT_OS_CODEX_REASONING_EFFORT") ||
    "medium"
  ).toLowerCase();
  const reasoningEffort = ALLOWED_REASONING_EFFORTS.has(requestedEffort) ? requestedEffort : "medium";
  const timeoutMs = numberBetween(
    process.env.AGENT_OS_CODEX_TIMEOUT_MS || getConfiguredValue(stored, "provider-openai", "AGENT_OS_CODEX_TIMEOUT_MS"),
    90000,
    5000,
    300000
  );
  const requestedApiMode = String(
    process.env.AGENT_OS_OPENAI_COMPAT_MODE ||
    getConfiguredValue(stored, "provider-openai", "AGENT_OS_OPENAI_COMPAT_MODE") ||
    "responses"
  ).toLowerCase();
  const apiMode = ALLOWED_API_MODES.has(requestedApiMode) ? requestedApiMode : "responses";
  return { key, model, baseUrl, reasoningEffort, timeoutMs, apiMode };
}

function configurationError() {
  const error = new Error("Connect an OpenAI API key on the AI APIs page before using Codex API features.");
  error.status = 412;
  error.code = "CODEX_API_NOT_CONFIGURED";
  return error;
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const parts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "refusal" && content.refusal) {
        const error = new Error(`Codex refused the request: ${String(content.refusal).slice(0, 500)}`);
        error.status = 422;
        throw error;
      }
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function extractChatText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  return "";
}

function parseStructuredText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("Structured chat response was not valid JSON.");
  }
}

function upstreamError(status, payload, requestId) {
  const upstreamMessage = payload?.error?.message || payload?.message || `OpenAI API returned HTTP ${status}.`;
  const error = new Error(redactText(String(upstreamMessage)).slice(0, 800));
  error.status = status === 401 || status === 403 ? 401 : status === 429 ? 429 : 502;
  error.code = payload?.error?.code || "CODEX_API_ERROR";
  error.details = sanitizeObject({ upstreamStatus: status, requestId, type: payload?.error?.type || null });
  return error;
}

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || null;
    if (!response.ok) throw upstreamError(response.status, payload, requestId);
    return { payload, requestId, latencyMs: Date.now() - started };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Codex API timed out after ${timeoutMs} ms.`);
      timeoutError.status = 504;
      timeoutError.code = "CODEX_API_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCodexApiStatus() {
  const config = await resolveConfig();
  const presentationMode = process.env.AGENT_OS_PRESENTATION_MODE === "1";
  return {
    ok: true,
    provider: "openai",
    label: "Codex API",
    configured: Boolean(config.key),
    presentationMode,
    status: config.key ? "configured" : "ready_to_configure",
    model: config.model,
    baseUrl: config.baseUrl,
    apiMode: config.apiMode,
    reasoningEffort: config.reasoningEffort,
    timeoutMs: config.timeoutMs,
    keySource: process.env.OPENAI_API_KEY ? "environment" : config.key ? "local_server_store" : "missing",
    publicSummary: config.key
      ? `Codex API is configured with ${config.model}. Test the connection before the first paid run.`
      : "Add a user-owned OpenAI API key to power prompting, workflow generation, edits, and previews."
  };
}

export async function testCodexApi() {
  const config = await resolveConfig();
  if (!config.key) throw configurationError();
  if (config.apiMode === "chat") {
    const result = await requestJson(`${config.baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.key}` }
    }, Math.min(config.timeoutMs, 30000));
    const models = Array.isArray(result.payload?.data)
      ? result.payload.data.map((model) => model?.id || model?.name).filter(Boolean)
      : [];
    const selectedAvailable = config.model === "auto" || models.includes(config.model);
    if (!selectedAvailable) {
      const error = new Error(`OpenAI-compatible endpoint responded, but model ${config.model} was not listed.`);
      error.status = 412;
      error.code = "CODEX_MODEL_NOT_LISTED";
      throw error;
    }
    return {
      ok: true,
      status: "connected",
      provider: "openai-compatible",
      model: config.model,
      ownedBy: null,
      requestId: result.requestId,
      latencyMs: result.latencyMs,
      modelCount: models.length,
      message: `OpenAI-compatible chat endpoint connected with ${config.model}.`
    };
  }
  const modelUrl = `${config.baseUrl}/models/${encodeURIComponent(config.model)}`;
  const result = await requestJson(modelUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.key}` }
  }, Math.min(config.timeoutMs, 30000));
  return {
    ok: true,
    status: "connected",
    provider: "openai",
    model: result.payload?.id || config.model,
    ownedBy: result.payload?.owned_by || null,
    requestId: result.requestId,
    latencyMs: result.latencyMs,
    message: `Codex API connected with ${result.payload?.id || config.model}.`
  };
}

async function runChatCompletionsApi(input, config, prompt, system, maxOutputTokens) {
  const systemContent = input.schema
    ? [
        system,
        "Return only valid JSON matching this JSON Schema. Do not wrap it in markdown fences.",
        JSON.stringify(input.schema).slice(0, 20000)
      ].join("\n\n")
    : system;
  const payload = {
    model: input.model || config.model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: prompt }
    ],
    max_tokens: maxOutputTokens
  };
  const result = await requestJson(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, numberBetween(input.timeoutMs, config.timeoutMs, 5000, 300000));
  const text = extractChatText(result.payload);
  if (!text) {
    const error = new Error("OpenAI-compatible chat endpoint completed without a text result.");
    error.status = 502;
    error.code = "CODEX_EMPTY_RESPONSE";
    throw error;
  }
  let parsed = null;
  if (input.schema) {
    try {
      parsed = parseStructuredText(text);
    } catch {
      const error = new Error("OpenAI-compatible chat endpoint returned structured output that could not be parsed.");
      error.status = 502;
      error.code = "CODEX_INVALID_STRUCTURED_OUTPUT";
      throw error;
    }
  }
  return {
    ok: true,
    mode: "chat_completions_compatible",
    provider: "openai-compatible",
    model: result.payload?.model || payload.model,
    reply: text,
    parsed,
    responseId: result.payload?.id || null,
    requestId: result.requestId,
    latencyMs: result.latencyMs,
    usage: sanitizeObject(result.payload?.usage || null)
  };
}

export async function runCodexApi(input = {}) {
  const config = await resolveConfig();
  if (!config.key) throw configurationError();
  const prompt = String(input.prompt || input.message || "").trim().slice(0, 50000);
  if (!prompt) {
    const error = new Error("A prompt is required for the Codex API.");
    error.status = 400;
    throw error;
  }
  const system = String(input.system || "You are the Codex intelligence layer inside Agent OS. Return a useful, accurate result.")
    .trim()
    .slice(0, 20000);
  const maxOutputTokens = numberBetween(input.maxOutputTokens, 4000, 128, 24000);
  if (config.apiMode === "chat") {
    return runChatCompletionsApi(input, config, prompt, system, maxOutputTokens);
  }
  const payload = {
    model: input.model || config.model,
    input: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ],
    reasoning: { effort: input.reasoningEffort || config.reasoningEffort },
    max_output_tokens: maxOutputTokens,
    store: false
  };
  if (input.schema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: String(input.schemaName || "agent_os_result").replace(/[^a-z0-9_-]/gi, "_").slice(0, 64),
        schema: input.schema,
        strict: true
      }
    };
  }
  const result = await requestJson(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, numberBetween(input.timeoutMs, config.timeoutMs, 5000, 300000));
  const text = extractOutputText(result.payload);
  if (!text) {
    const error = new Error("Codex API completed without a text result.");
    error.status = 502;
    error.code = "CODEX_EMPTY_RESPONSE";
    throw error;
  }
  let parsed = null;
  if (input.schema) {
    try {
      parsed = JSON.parse(text);
    } catch {
      const error = new Error("Codex API returned structured output that could not be parsed.");
      error.status = 502;
      error.code = "CODEX_INVALID_STRUCTURED_OUTPUT";
      throw error;
    }
  }
  return {
    ok: true,
    mode: "codex_api",
    provider: "openai",
    model: result.payload?.model || payload.model,
    reply: text,
    parsed,
    responseId: result.payload?.id || null,
    requestId: result.requestId,
    latencyMs: result.latencyMs,
    usage: sanitizeObject(result.payload?.usage || null)
  };
}

export async function runCodexPreview(input = {}) {
  const runtime = ["hermes", "openclaw"].includes(input.runtime) ? input.runtime : "hermes";
  return runCodexApi({
    prompt: input.message || input.prompt,
    system: [
      "You are the Codex API intelligence layer powering Agent OS.",
      `The user is previewing a workflow intended for the ${runtime} runtime.`,
      "Complete the requested reasoning task directly. Do not claim the native runtime executed unless it actually did.",
      "Be concise, practical, and explicit about any assumptions."
    ].join(" "),
    maxOutputTokens: input.maxOutputTokens || 3000,
    timeoutMs: input.timeoutMs
  });
}
