import path from "node:path";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { appendModuleLog } from "./module-logs.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";
import { redactValue, sanitizeObject } from "./safety.js";
import { assertUsageBudget, estimateUsage, recordUsageEvent } from "./usage.js";
import { isExecutionEnabled } from "./execution-gate.js";

const PROVIDERS = [
  {
    id: "ollama",
    label: "Ollama",
    connectionIds: ["provider-ollama", "provider-router", "openclaude"],
    required: ["OLLAMA_HOST"],
    defaultModel: "llama3.1",
    endpoint: "local Ollama host",
    healthEndpoint: "local Ollama /api/tags"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    connectionIds: ["provider-openrouter", "provider-router", "openclaude"],
    required: ["OPENROUTER_API_KEY"],
    defaultModel: "openrouter/auto",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    healthEndpoint: "https://openrouter.ai/api/v1/models"
  },
  {
    id: "minimax",
    label: "MiniMax",
    connectionIds: ["provider-minimax", "provider-router", "minimax"],
    required: ["MINIMAX_API_KEY"],
    defaultModel: "MiniMax-M3",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    healthEndpoint: "https://api.minimax.io/v1/models"
  },
  {
    id: "openai",
    label: "OpenAI",
    connectionIds: ["provider-openai", "provider-router", "codex", "firecrawl-builder"],
    required: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o-mini",
    endpoint: "https://api.openai.com/v1/chat/completions",
    healthEndpoint: "https://api.openai.com/v1/models"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    connectionIds: ["provider-anthropic", "provider-router", "claude", "firecrawl-builder"],
    required: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-3-5-sonnet-latest",
    endpoint: "https://api.anthropic.com/v1/messages",
    healthEndpoint: "https://api.anthropic.com/v1/models"
  },
  {
    id: "gemini",
    label: "Gemini",
    connectionIds: ["provider-gemini", "provider-router", "gemini"],
    required: ["GEMINI_API_KEY"],
    defaultModel: "gemini-1.5-flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    healthEndpoint: "https://generativelanguage.googleapis.com/v1beta/models"
  }
];

const DEFAULT_FALLBACK = ["ollama", "openrouter", "minimax", "openai", "anthropic", "gemini"];

function now() {
  return new Date().toISOString();
}

function routerConfigPath() {
  return path.join(runtimePaths().config, "provider-router.json");
}

function cleanProviderId(id) {
  return String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function valueFor(stored, provider, key) {
  for (const id of provider.connectionIds) {
    const value = getConfiguredValue(stored, id, key);
    if (value) return value;
  }
  return null;
}

function providerState(stored, provider, config) {
  const missing = provider.required.filter((key) => !valueFor(stored, provider, key));
  return {
    id: provider.id,
    label: provider.label,
    status: missing.length ? "ready_to_configure" : "connected",
    configured: missing.length === 0,
    missing,
    model: config.models?.[provider.id] || process.env[`HERMES_${provider.id.toUpperCase()}_MODEL`] || provider.defaultModel,
    endpoint: provider.endpoint,
    healthEndpoint: provider.healthEndpoint,
    publicSummary: missing.length
      ? `Configure ${missing.join(", ")} to enable ${provider.label}.`
      : `${provider.label} is available for router dispatch.`
  };
}

async function readRouterConfig() {
  await ensureRuntimeStore();
  const stored = await readJson(routerConfigPath(), {});
  const fallbackOrder = Array.isArray(stored.fallbackOrder)
    ? stored.fallbackOrder.map(cleanProviderId).filter((id) => PROVIDERS.some((provider) => provider.id === id))
    : DEFAULT_FALLBACK;
  return {
    fallbackOrder: fallbackOrder.length ? fallbackOrder : DEFAULT_FALLBACK,
    models: stored.models && typeof stored.models === "object" ? stored.models : {},
    updatedAt: stored.updatedAt || null
  };
}

export async function configureRouter(input = {}) {
  const current = await readRouterConfig();
  const fallbackOrder = Array.isArray(input.fallbackOrder)
    ? input.fallbackOrder.map(cleanProviderId).filter((id) => PROVIDERS.some((provider) => provider.id === id))
    : current.fallbackOrder;
  const models = {
    ...current.models,
    ...(input.models && typeof input.models === "object" ? input.models : {})
  };
  const next = {
    fallbackOrder: fallbackOrder.length ? fallbackOrder : current.fallbackOrder,
    models: Object.fromEntries(
      Object.entries(models)
        .map(([key, value]) => [cleanProviderId(key), String(value || "").trim()])
        .filter(([key, value]) => key && value)
    ),
    updatedAt: now()
  };
  await writeJson(routerConfigPath(), next);
  return getRouterStatus();
}

export async function getRouterStatus() {
  const [stored, config, executionGate] = await Promise.all([getStoredConnectionConfig(), readRouterConfig(), isExecutionEnabled()]);
  const providers = PROVIDERS.map((provider) => providerState(stored, provider, config));
  const connected = providers.filter((provider) => provider.status === "connected");
  const nextProvider = config.fallbackOrder.map((id) => connected.find((provider) => provider.id === id)).find(Boolean) || null;
  return {
    id: "provider-router",
    label: "Provider Router",
    status: nextProvider ? "connected" : "ready_to_configure",
    configured: Boolean(nextProvider),
    fallbackOrder: config.fallbackOrder,
    providers,
    nextProvider,
    updatedAt: config.updatedAt,
    dryRunDefault: !executionGate
  };
}

function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === cleanProviderId(id)) || null;
}

function healthUrlOverride(stored, provider) {
  const key = `HERMES_${provider.id.toUpperCase()}_HEALTH_URL`;
  return valueFor(stored, provider, key) || process.env[key] || null;
}

function providerHealthRequest(provider, state, stored) {
  const override = healthUrlOverride(stored, provider);
  if (provider.id === "ollama") {
    const host = String(override || valueFor(stored, provider, "OLLAMA_HOST") || "").replace(/\/$/, "");
    return {
      url: `${host}/api/tags`,
      publicEndpoint: `${host}/api/tags`,
      options: { method: "GET" }
    };
  }

  if (provider.id === "gemini") {
    const apiKey = valueFor(stored, provider, "GEMINI_API_KEY");
    const base = override || provider.healthEndpoint;
    return {
      url: `${base}?key=${encodeURIComponent(apiKey)}`,
      publicEndpoint: base,
      options: { method: "GET" }
    };
  }

  if (provider.id === "anthropic") {
    return {
      url: override || provider.healthEndpoint,
      publicEndpoint: override || provider.healthEndpoint,
      options: {
        method: "GET",
        headers: {
          "x-api-key": valueFor(stored, provider, "ANTHROPIC_API_KEY"),
          "anthropic-version": "2023-06-01"
        }
      }
    };
  }

  return {
    url: override || provider.healthEndpoint,
    publicEndpoint: override || provider.healthEndpoint,
    options: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${valueFor(stored, provider, provider.required[0])}`
      }
    }
  };
}

function ollamaModelMatches(actual, selected) {
  const left = String(actual || "").trim();
  const right = String(selected || "").trim();
  if (!left || !right) return false;
  return left === right || left === `${right}:latest` || `${left}:latest` === right;
}

function summarizeHealthBody(providerId, body, selectedModel = "") {
  if (!body || typeof body !== "object") return {};
  if (providerId === "ollama") {
    const models = Array.isArray(body.models) ? body.models : [];
    return {
      modelCount: models.length,
      selectedModel: selectedModel || null,
      selectedModelAvailable: models.some((item) =>
        ollamaModelMatches(item.name, selectedModel) ||
        ollamaModelMatches(item.model, selectedModel)
      )
    };
  }
  const data = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
  return {
    modelCount: data ? data.length : undefined
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      body,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: {},
      latencyMs: Date.now() - started,
      error: error?.name === "AbortError" ? "health check timed out" : error?.message || "health check failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkProviderHealth(providerId) {
  const [stored, config] = await Promise.all([getStoredConnectionConfig(), readRouterConfig()]);
  const provider = providerById(providerId);
  if (!provider) {
    const error = new Error(`Provider not found: ${providerId}`);
    error.status = 404;
    throw error;
  }
  const state = providerState(stored, provider, config);
  const checkedAt = now();
  if (!state.configured) {
    return {
      id: provider.id,
      label: provider.label,
      ok: false,
      status: "ready_to_configure",
      configured: false,
      missing: state.missing,
      checkedAt,
      latencyMs: 0,
      httpStatus: null,
      endpoint: state.healthEndpoint,
      message: `Configure ${state.missing.join(", ")} before checking ${provider.label}.`
    };
  }

  const request = providerHealthRequest(provider, state, stored);
  const result = await fetchWithTimeout(request.url, request.options);
  const summary = summarizeHealthBody(provider.id, result.body, state.model);
  const modelMissing = provider.id === "ollama" && result.ok && !summary.selectedModelAvailable;
  const status = result.ok && !modelMissing ? "healthy" : modelMissing ? "ready_to_configure" : "error";
  const message = result.ok
    ? modelMissing
      ? `Ollama is reachable, but model ${state.model} is not available locally.`
      : `${provider.label} health check succeeded.`
    : `${provider.label} health check failed${result.status ? ` with HTTP ${result.status}` : ""}.`;
  await appendModuleLog("provider-router", {
    level: status === "healthy" ? "info" : "warn",
    message: "Provider health checked",
    details: {
      provider: provider.id,
      status,
      httpStatus: result.status,
      latencyMs: result.latencyMs,
      endpoint: request.publicEndpoint,
      ...summary,
      error: result.error
    }
  });
  return {
    id: provider.id,
    label: provider.label,
    ok: status === "healthy",
    status,
    configured: true,
    missing: modelMissing ? [state.model] : [],
    checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
    endpoint: request.publicEndpoint,
    message,
    ...summary
  };
}

export async function getRouterHealth({ provider } = {}) {
  const status = await getRouterStatus();
  const selectedIds = provider
    ? [cleanProviderId(provider)]
    : status.providers.map((item) => item.id);
  const checks = [];
  for (const id of selectedIds) {
    checks.push(await checkProviderHealth(id));
  }
  return {
    id: "provider-router-health",
    checkedAt: now(),
    summary: {
      total: checks.length,
      healthy: checks.filter((item) => item.status === "healthy").length,
      setup: checks.filter((item) => item.status === "ready_to_configure").length,
      error: checks.filter((item) => item.status === "error").length
    },
    checks
  };
}

function selectProvider(status, requestedProvider) {
  if (requestedProvider) {
    const requested = status.providers.find((provider) => provider.id === cleanProviderId(requestedProvider));
    return requested?.status === "connected" ? requested : null;
  }
  return status.nextProvider;
}

function messagePayload(input = {}) {
  const prompt = String(input.prompt || input.message || "").trim();
  if (!prompt) {
    const error = new Error("prompt or message is required");
    error.status = 400;
    throw error;
  }
  return prompt.slice(0, 12000);
}

function providerCallPlan({ selected = null, prompt = "", operation = "router", source = "provider-router", execEnabled = false, dryRun = true, plannedUsage = null, missing = [] } = {}) {
  const providerId = selected?.id || "none";
  const providerLabel = selected?.label || providerId;
  return sanitizeObject({
    provider: providerId,
    label: providerLabel,
    model: selected?.model || null,
    method: selected ? "POST" : null,
    endpoint: selected?.endpoint || null,
    accessMode: selected && selected.id !== "ollama" ? "provider key required" : selected ? "local endpoint" : "not configured",
    promptLength: String(prompt || "").length,
    estimatedTokens: plannedUsage?.units ?? null,
    estimatedCost: plannedUsage?.estimatedCost ?? null,
    operation,
    source,
    dryRun,
    executionGate: execEnabled ? "enabled" : "disabled",
    missing,
    nextStep: missing.length
      ? "Configure the missing provider fields before this call can execute."
      : selected
      ? execEnabled && !dryRun
        ? "Provider call is allowed to execute."
        : "This is a safe provider call plan. Enable execution and send dryRun:false to run it."
      : "Configure the missing provider fields before this call can execute."
  });
}

async function runOpenAiCompatible(provider, state, prompt, stored) {
  const apiKey = valueFor(stored, provider, provider.required[0]);
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: state.model,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    text: data.choices?.[0]?.message?.content || data.error?.message || JSON.stringify(data).slice(0, 2000)
  };
}

async function runOllama(provider, state, prompt, stored) {
  const host = String(valueFor(stored, provider, "OLLAMA_HOST") || "").replace(/\/$/, "");
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: state.model,
      stream: false,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    text: data.message?.content || data.error || JSON.stringify(data).slice(0, 2000)
  };
}

async function runAnthropic(provider, state, prompt, stored) {
  const apiKey = valueFor(stored, provider, "ANTHROPIC_API_KEY");
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: state.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    text: data.content?.[0]?.text || data.error?.message || JSON.stringify(data).slice(0, 2000)
  };
}

async function runGemini(provider, state, prompt, stored) {
  const apiKey = valueFor(stored, provider, "GEMINI_API_KEY");
  const response = await fetch(`${provider.endpoint}/${encodeURIComponent(state.model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || data.error?.message || JSON.stringify(data).slice(0, 2000)
  };
}

export async function runRouter(input = {}) {
  const prompt = messagePayload(input);
  const status = await getRouterStatus();
  const selected = selectProvider(status, input.provider);
  const operation = String(input.operation || "router").trim().slice(0, 80) || "router";
  const source = String(input.source || "provider-router").trim().slice(0, 80) || "provider-router";
  const execEnabled = await isExecutionEnabled();
  if (!selected) {
    const requestedId = cleanProviderId(input.provider);
    const requested = requestedId
      ? status.providers.find((provider) => provider.id === requestedId) || null
      : status.fallbackOrder.map((id) => status.providers.find((provider) => provider.id === id)).find(Boolean) || null;
    const plannedRequest = providerCallPlan({
      selected: requested,
      prompt,
      operation,
      source,
      execEnabled,
      dryRun: true,
      missing: requested?.missing || ["configured provider"]
    });
    await appendModuleLog("provider-router", {
      level: "warn",
      message: "Router dispatch blocked: no configured provider",
      details: { requestedProvider: requestedId, operation, source, promptLength: prompt.length, plannedRequest }
    });
    return {
      ok: false,
      mode: "ready_to_configure",
      message: "No configured provider is available for router dispatch.",
      provider: requested?.id || requestedId || null,
      model: requested?.model || null,
      plannedRequest,
      status
    };
  }

  const plannedUsage = estimateUsage({
    provider: selected.id,
    model: selected.model,
    inputText: prompt
  });
  const plannedRequest = providerCallPlan({
    selected,
    prompt,
    operation,
    source,
    execEnabled,
    dryRun: !execEnabled || input.dryRun !== false,
    plannedUsage
  });
  if (!execEnabled || input.dryRun !== false) {
    const usageRecord = await recordUsageEvent({
      provider: selected.id,
      model: selected.model,
      operation,
      inputText: prompt,
      mode: "dry_run",
      status: "dry_run",
      source,
      requestId: input.requestId,
      notes: "Provider router dry-run dispatch."
    });
    await appendModuleLog("provider-router", {
      message: "Router dry run requested",
      details: {
        provider: selected.id,
        model: selected.model,
        operation,
        source,
        promptLength: prompt.length,
        usageItemId: usageRecord.item.id,
        execEnabled,
        plannedRequest
      }
    });
    return {
      ok: true,
      mode: "dry_run",
      provider: selected.id,
      model: selected.model,
      message: `${selected.label} would receive this prompt. Enable the trusted execution gate and pass dryRun=false on a trusted machine to execute.`,
      plannedRequest,
      usage: usageRecord.usage.summary
    };
  }

  await assertUsageBudget({ estimatedCost: plannedUsage.estimatedCost, mode: "executed" });
  const stored = await getStoredConnectionConfig();
  const provider = providerById(selected.id);
  let result;
  if (provider.id === "ollama") result = await runOllama(provider, selected, prompt, stored);
  else if (provider.id === "anthropic") result = await runAnthropic(provider, selected, prompt, stored);
  else if (provider.id === "gemini") result = await runGemini(provider, selected, prompt, stored);
  else result = await runOpenAiCompatible(provider, selected, prompt, stored);

  await appendModuleLog("provider-router", {
    level: result.ok ? "info" : "error",
    message: result.ok ? "Router provider call completed" : "Router provider call failed",
    details: {
      provider: selected.id,
      model: selected.model,
      status: result.status,
      promptLength: prompt.length,
      plannedRequest
    }
  });
  const usageRecord = await recordUsageEvent({
      provider: selected.id,
      model: selected.model,
      operation,
      inputText: prompt,
      outputText: result.text,
      mode: "executed",
      status: result.ok ? "completed" : "error",
      source,
      requestId: input.requestId,
      notes: `HTTP status ${result.status || "unknown"}`
    });

  return {
    ok: result.ok,
    mode: "executed",
    provider: selected.id,
    model: selected.model,
    message: result.text,
    status: result.status,
    plannedRequest,
    usage: usageRecord.usage.summary
  };
}

export function publicProviderConfigValue(key, value) {
  return redactValue(key, value);
}
