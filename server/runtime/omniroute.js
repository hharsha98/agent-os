import { getStoredConnectionConfig } from "./connections.js";
import { redactText } from "./safety.js";

function cleanBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
  return raw;
}

export async function resolveOmniRouteConfig(env = process.env) {
  const stored = await getStoredConnectionConfig().catch(() => ({}));
  const profile = stored?.["ai-source-omniroute"] || {};
  const baseUrl = cleanBaseUrl(env.OMNIROUTE_BASE_URL || profile.BASE_URL || "");
  const apiKey = String(env.OMNIROUTE_API_KEY || profile.API_KEY || "").trim();
  const model = String(env.OMNIROUTE_MODEL || profile.MODEL || "auto").trim() || "auto";
  return {
    baseUrl,
    apiKey,
    model,
    configured: Boolean(baseUrl && apiKey)
  };
}

export function publicOmniRouteStatus(config = {}) {
  let host = "";
  try {
    host = config.baseUrl ? new URL(config.baseUrl).host : "";
  } catch {
    host = "";
  }
  return {
    configured: Boolean(config.configured),
    host,
    model: config.model || "auto",
    baseUrlSet: Boolean(config.baseUrl),
    apiKeySet: Boolean(config.apiKey)
  };
}

export async function completeViaOmniRoute({
  messages,
  model,
  timeoutMs = 90000,
  fetchImpl = fetch
} = {}, env = process.env) {
  const config = await resolveOmniRouteConfig(env);
  if (!config.configured) {
    const error = new Error("OmniRoute is not configured. Set OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY.");
    error.code = "OMNIROUTE_NOT_CONFIGURED";
    error.status = 412;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: model || config.model,
        messages
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `OmniRoute HTTP ${response.status}`;
      const error = new Error(redactText(String(message)).slice(0, 600));
      error.status = 502;
      throw error;
    }
    const content = data?.choices?.[0]?.message?.content;
    return {
      ok: true,
      text: typeof content === "string" ? content.trim() : "",
      model: data?.model || model || config.model,
      status: response.status
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`OmniRoute chat timed out after ${timeoutMs} ms.`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
