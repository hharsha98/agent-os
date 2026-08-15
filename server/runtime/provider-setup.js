import { execFile } from "node:child_process";
import { configureConnection, getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { appendModuleLog } from "./module-logs.js";
import { testModule } from "./modules.js";
import { checkProviderHealth, configureRouter, getRouterStatus } from "./router.js";
import { sanitizeObject, which } from "./safety.js";

const PROVIDER_GUIDES = [
  {
    id: "ollama",
    label: "Ollama",
    category: "local",
    connectionId: "provider-ollama",
    moduleId: "provider-ollama",
    routerProvider: "ollama",
    docsUrl: "https://ollama.com",
    modelDefault: "llama3.1",
    fields: [
      { key: "OLLAMA_HOST", label: "Ollama host", required: true, secret: false, placeholder: "http://127.0.0.1:11434", help: "Local Ollama HTTP endpoint." }
    ],
    helper: {
      id: "ollama-pull",
      label: "Prepare Ollama model",
      modelField: "HERMES_OLLAMA_MODEL"
    },
    publicSummary: "Local model routing through a user-owned Ollama process."
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    category: "cloud",
    connectionId: "provider-openrouter",
    moduleId: "provider-openrouter",
    routerProvider: "openrouter",
    docsUrl: "https://openrouter.ai/docs",
    modelDefault: "openrouter/auto",
    fields: [
      { key: "OPENROUTER_API_KEY", label: "API key", required: true, secret: true, placeholder: "sk-or-...", help: "Required for routing." },
      { key: "OPENROUTER_MANAGEMENT_KEY", label: "Management key", required: false, secret: true, placeholder: "optional", help: "Optional, only used for account credit reconciliation." }
    ],
    publicSummary: "Open model routing with user-owned OpenRouter credentials."
  },
  {
    id: "minimax",
    label: "MiniMax",
    category: "cloud",
    connectionId: "provider-minimax",
    moduleId: "provider-minimax",
    routerProvider: "minimax",
    docsUrl: "https://www.minimax.io",
    modelDefault: "MiniMax-M3",
    fields: [
      { key: "MINIMAX_API_KEY", label: "API key", required: true, secret: true, placeholder: "user-owned key", help: "Required for MiniMax routing." }
    ],
    publicSummary: "MiniMax M3 routing with a user-owned MiniMax key."
  },
  {
    id: "openai",
    label: "OpenAI",
    category: "cloud",
    connectionId: "provider-openai",
    moduleId: "provider-openai",
    routerProvider: "openai",
    docsUrl: "https://platform.openai.com/docs",
    modelDefault: "gpt-4o-mini",
    fields: [
      { key: "OPENAI_API_KEY", label: "API key", required: true, secret: true, placeholder: "sk-...", help: "Required for OpenAI model routing." },
      { key: "OPENAI_ADMIN_KEY", label: "Admin key", required: false, secret: true, placeholder: "optional", help: "Optional, only used for organization cost reconciliation." }
    ],
    publicSummary: "OpenAI model routing and optional organization cost reconciliation."
  },
  {
    id: "anthropic",
    label: "Anthropic",
    category: "cloud",
    connectionId: "provider-anthropic",
    moduleId: "provider-anthropic",
    routerProvider: "anthropic",
    docsUrl: "https://docs.anthropic.com",
    modelDefault: "claude-3-5-sonnet-latest",
    fields: [
      { key: "ANTHROPIC_API_KEY", label: "API key", required: true, secret: true, placeholder: "sk-ant-...", help: "Required for Anthropic Claude routing." }
    ],
    publicSummary: "Claude model routing with a user-owned Anthropic key."
  },
  {
    id: "gemini",
    label: "Gemini",
    category: "cloud",
    connectionId: "provider-gemini",
    moduleId: "provider-gemini",
    routerProvider: "gemini",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    modelDefault: "gemini-1.5-flash",
    fields: [
      { key: "GEMINI_API_KEY", label: "API key", required: true, secret: true, placeholder: "AIza...", help: "Required for Gemini API routing." }
    ],
    publicSummary: "Gemini API routing with a user-owned Google AI key."
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    category: "builder",
    connectionId: "provider-firecrawl",
    moduleId: "provider-firecrawl",
    docsUrl: "https://docs.firecrawl.dev",
    fields: [
      { key: "FIRECRAWL_API_KEY", label: "API key", required: true, secret: true, placeholder: "fc-...", help: "Required for web/data execution in workflows." },
      { key: "HERMES_FIRECRAWL_SCRAPE_URL", label: "Scrape endpoint", required: false, secret: false, placeholder: "https://api.firecrawl.dev/v2/scrape", help: "Optional Firecrawl-compatible scrape endpoint override." },
      { key: "HERMES_FIRECRAWL_SEARCH_URL", label: "Search endpoint", required: false, secret: false, placeholder: "https://api.firecrawl.dev/v2/search", help: "Optional Firecrawl-compatible search endpoint override." }
    ],
    publicSummary: "Firecrawl web/data execution for Open Agent Builder workflows, SEO audits, competitor discovery, and rank snapshots."
  },
  {
    id: "convex",
    label: "Convex",
    category: "builder",
    connectionId: "provider-convex",
    moduleId: "provider-convex",
    docsUrl: "https://docs.convex.dev",
    fields: [
      { key: "NEXT_PUBLIC_CONVEX_URL", label: "Convex URL", required: true, secret: false, placeholder: "https://...convex.cloud", help: "Required by the upstream builder for workflow storage." }
    ],
    publicSummary: "Convex project URL for upstream Open Agent Builder storage."
  },
  {
    id: "clerk",
    label: "Clerk",
    category: "builder",
    connectionId: "provider-clerk",
    moduleId: "provider-clerk",
    docsUrl: "https://clerk.com/docs",
    fields: [
      { key: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", label: "Publishable key", required: true, secret: false, placeholder: "pk_...", help: "Required by the upstream builder UI." },
      { key: "CLERK_SECRET_KEY", label: "Secret key", required: true, secret: true, placeholder: "sk_...", help: "Required by the upstream builder backend." },
      { key: "CLERK_JWT_ISSUER_DOMAIN", label: "JWT issuer domain", required: true, secret: false, placeholder: "https://...", help: "Required for builder auth token validation." }
    ],
    publicSummary: "Clerk authentication configuration for the upstream Open Agent Builder."
  }
];

function now() {
  return new Date().toISOString();
}

function guideById(id) {
  return PROVIDER_GUIDES.find((guide) => guide.id === String(id || "").toLowerCase()) || null;
}

function configuredField(stored, guide, key) {
  return Boolean(getConfiguredValue(stored, guide.connectionId, key));
}

function publicGuide(guide, stored) {
  const configuredFields = guide.fields
    .filter((field) => configuredField(stored, guide, field.key))
    .map((field) => field.key);
  const missing = guide.fields
    .filter((field) => field.required && !configuredField(stored, guide, field.key))
    .map((field) => field.key);
  return {
    id: guide.id,
    label: guide.label,
    category: guide.category,
    connectionId: guide.connectionId,
    moduleId: guide.moduleId,
    routerProvider: guide.routerProvider || null,
    docsUrl: guide.docsUrl,
    modelDefault: process.env[`HERMES_${String(guide.routerProvider || guide.id).toUpperCase()}_MODEL`] || guide.modelDefault || null,
    fields: guide.fields,
    configuredFields,
    missing,
    configured: missing.length === 0,
    status: missing.length ? "ready_to_configure" : "configured",
    helper: guide.helper || null,
    publicSummary: guide.publicSummary
  };
}

function allowedFields(guide, fields = {}) {
  const allowed = new Set(guide.fields.map((field) => field.key));
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key, value]) => allowed.has(key) && value != null && String(value).trim() !== "")
      .map(([key, value]) => [key, String(value).trim()])
  );
}

function cleanModel(value, fallback) {
  const model = String(value || fallback || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    const error = new Error("Model name contains unsupported characters.");
    error.status = 400;
    throw error;
  }
  return model;
}

function runOllamaPull(model) {
  return new Promise((resolve) => {
    execFile("ollama", ["pull", model], { timeout: 600000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
        code: error?.code ?? 0,
        signal: error?.signal ?? null
      });
    });
  });
}

function configuredValue(stored, guide, key) {
  return getConfiguredValue(stored, guide.connectionId, key) || process.env[key] || "";
}

function modelSize(size) {
  const bytes = Number(size || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return { bytes: 0, gb: 0, label: "unknown" };
  const gb = Number((bytes / 1024 / 1024 / 1024).toFixed(2));
  return {
    bytes,
    gb,
    label: gb >= 1 ? `${gb} GB` : `${Number((bytes / 1024 / 1024).toFixed(1))} MB`
  };
}

function normalizeOllamaModels(body) {
  const models = Array.isArray(body?.models) ? body.models : [];
  return models.map((model) => {
    const size = modelSize(model.size);
    return {
      name: String(model.name || model.model || "").trim(),
      model: String(model.model || model.name || "").trim(),
      modifiedAt: model.modified_at || model.modifiedAt || null,
      digest: model.digest ? `${String(model.digest).slice(0, 12)}...` : null,
      sizeBytes: size.bytes,
      sizeGb: size.gb,
      sizeLabel: size.label,
      details: sanitizeObject({
        family: model.details?.family || null,
        families: Array.isArray(model.details?.families) ? model.details.families : [],
        parameterSize: model.details?.parameter_size || null,
        quantizationLevel: model.details?.quantization_level || null,
        format: model.details?.format || null
      })
    };
  }).filter((model) => model.name);
}

function providerHealthOverride(stored, providerId) {
  const key = `HERMES_${String(providerId || "").toUpperCase()}_HEALTH_URL`;
  for (const guide of PROVIDER_GUIDES) {
    if (guide.routerProvider !== providerId) continue;
    const configured = getConfiguredValue(stored, guide.connectionId, key);
    if (configured) return configured;
  }
  return process.env[key] || "";
}

function providerModelEndpoint(providerId, stored, guide) {
  const override = providerHealthOverride(stored, providerId);
  if (providerId === "openai") return override || "https://api.openai.com/v1/models";
  if (providerId === "openrouter") return override || "https://openrouter.ai/api/v1/models";
  if (providerId === "minimax") return override || "https://api.minimax.io/v1/models";
  if (providerId === "anthropic") return override || "https://api.anthropic.com/v1/models";
  if (providerId === "gemini") return override || "https://generativelanguage.googleapis.com/v1beta/models";
  return guide.docsUrl || "";
}

function providerModelRequest(providerId, endpoint, stored, guide) {
  if (providerId === "gemini") {
    const apiKey = configuredValue(stored, guide, "GEMINI_API_KEY");
    return {
      url: `${endpoint}${endpoint.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`,
      publicEndpoint: endpoint,
      options: { method: "GET" }
    };
  }
  if (providerId === "anthropic") {
    return {
      url: endpoint,
      publicEndpoint: endpoint,
      options: {
        method: "GET",
        headers: {
          "x-api-key": configuredValue(stored, guide, "ANTHROPIC_API_KEY"),
          "anthropic-version": "2023-06-01"
        }
      }
    };
  }
  const key = guide.fields.find((field) => field.required && field.secret)?.key;
  return {
    url: endpoint,
    publicEndpoint: endpoint,
    options: {
      method: "GET",
      headers: key ? { Authorization: `Bearer ${configuredValue(stored, guide, key)}` } : {}
    }
  };
}

function normalizeCloudModels(providerId, body) {
  const source = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : [];
  return source.map((model) => {
    const rawName = String(model.id || model.name || model.model || "").trim();
    const name = providerId === "gemini" ? rawName.replace(/^models\//, "") : rawName;
    const displayName = String(model.display_name || model.displayName || model.name || name).replace(/^models\//, "");
    return {
      name,
      model: name,
      displayName,
      modifiedAt: model.created_at || model.createdAt || model.updated_at || model.modified_at || null,
      digest: null,
      sizeBytes: 0,
      sizeGb: 0,
      sizeLabel: "cloud",
      details: sanitizeObject({
        ownedBy: model.owned_by || model.ownedBy || null,
        family: model.details?.family || model.family || null,
        families: Array.isArray(model.details?.families) ? model.details.families : [],
        parameterSize: model.details?.parameter_size || model.parameterSize || null,
        quantizationLevel: null,
        format: providerId
      })
    };
  }).filter((model) => model.name);
}

async function fetchProviderModels(providerId, stored, guide) {
  const endpoint = providerModelEndpoint(providerId, stored, guide);
  const request = providerModelRequest(providerId, endpoint, stored, guide);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const started = Date.now();
  try {
    const response = await fetch(request.url, { ...request.options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      body,
      endpoint: request.publicEndpoint,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: {},
      endpoint: request.publicEndpoint,
      latencyMs: Date.now() - started,
      error: error?.name === "AbortError" ? `${guide.label} model inventory timed out` : error?.message || `${guide.label} model inventory failed`
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOllamaTags(host) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const started = Date.now();
  try {
    const url = `${String(host || "").replace(/\/$/, "")}/api/tags`;
    const response = await fetch(url, { method: "GET", signal: controller.signal });
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
      error: error?.name === "AbortError" ? "Ollama model inventory timed out" : error?.message || "Ollama model inventory failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getProviderSetupState() {
  const stored = await getStoredConnectionConfig();
  const guides = PROVIDER_GUIDES.map((guide) => publicGuide(guide, stored));
  return {
    id: "provider-setup",
    generatedAt: now(),
    summary: {
      total: guides.length,
      configured: guides.filter((guide) => guide.configured).length,
      readyToConfigure: guides.filter((guide) => !guide.configured).length,
      local: guides.filter((guide) => guide.category === "local").length,
      cloud: guides.filter((guide) => guide.category === "cloud").length,
      builder: guides.filter((guide) => guide.category === "builder").length
    },
    guides
  };
}

export async function configureProviderSetup(id, input = {}) {
  const guide = guideById(id);
  if (!guide) {
    const error = new Error(`Provider setup guide not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const fields = allowedFields(guide, input.fields || {});
  if (Object.keys(fields).length) {
    await configureConnection(guide.connectionId, fields);
  }
  if (guide.routerProvider && input.model) {
    const model = cleanModel(input.model, guide.modelDefault);
    await configureRouter({ models: { [guide.routerProvider]: model } });
  }
  await appendModuleLog(guide.moduleId, {
    message: "Guided provider setup saved",
    details: sanitizeObject({
      guide: guide.id,
      configuredFields: Object.keys(fields),
      modelConfigured: Boolean(input.model)
    })
  });
  return {
    ok: true,
    guide: (await getProviderSetupState()).guides.find((item) => item.id === guide.id)
  };
}

export async function testProviderSetup(id) {
  const guide = guideById(id);
  if (!guide) {
    const error = new Error(`Provider setup guide not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const result = guide.routerProvider
    ? await checkProviderHealth(guide.routerProvider)
    : await testModule(guide.moduleId);
  await appendModuleLog(guide.moduleId, {
    level: result.ok ? "info" : "warn",
    message: "Guided provider setup tested",
    details: sanitizeObject({
      guide: guide.id,
      status: result.status || result.details?.status,
      missing: result.missing || result.details?.missing || []
    })
  });
  return {
    ok: Boolean(result.ok),
    id: guide.id,
    checkedAt: now(),
    result
  };
}

export async function prepareProviderModel(id, input = {}) {
  const guide = guideById(id);
  if (!guide || guide.id !== "ollama") {
    const error = new Error("Model pull helper is only available for Ollama.");
    error.status = guide ? 400 : 404;
    throw error;
  }
  const model = cleanModel(input.model, process.env.HERMES_OLLAMA_MODEL || guide.modelDefault);
  const command = `ollama pull ${model}`;
  const execute = Boolean(input.execute);
  const allowInstall = process.env.HERMES_AGENT_OS_ENABLE_INSTALL === "1";
  const response = {
    ok: true,
    id: guide.id,
    mode: execute && allowInstall ? "executed" : "dry_run",
    model,
    command,
    message: execute && allowInstall
      ? `Running ${command}.`
      : `Prepared model pull command. Run locally: ${command}`
  };
  if (!execute || !allowInstall) {
    await appendModuleLog(guide.moduleId, {
      message: "Ollama model pull prepared",
      details: { model, mode: "dry_run" }
    });
    return response;
  }
  const result = await runOllamaPull(model);
  await appendModuleLog(guide.moduleId, {
    level: result.ok ? "info" : "error",
    message: "Ollama model pull executed",
    details: sanitizeObject({ model, result })
  });
  return {
    ...response,
    ok: result.ok,
    result,
    message: result.ok ? `Ollama model ${model} is available.` : `Ollama model pull failed for ${model}.`
  };
}

export async function getOllamaDoctor() {
  const guide = guideById("ollama");
  const stored = await getStoredConnectionConfig();
  const configuredHost = configuredValue(stored, guide, "OLLAMA_HOST");
  const host = configuredHost || "http://127.0.0.1:11434";
  const model = process.env.HERMES_OLLAMA_MODEL || guide.modelDefault;
  const commandPath = await which("ollama");
  const response = await fetchOllamaTags(host);
  const models = response.ok ? normalizeOllamaModels(response.body) : [];
  const selectedModelAvailable = models.some((item) => item.name === model || item.model === model);
  const installed = Boolean(commandPath);
  const hostConfigured = Boolean(configuredHost);
  const serverReachable = Boolean(response.ok);
  const status = serverReachable && hostConfigured
    ? "connected"
    : installed || serverReachable ? "ready_to_configure" : "missing_dependency";
  const checks = [
    {
      id: "ollama-cli",
      label: "Ollama CLI",
      status: installed ? "connected" : "missing_dependency",
      detail: installed ? "Ollama executable was found in the local runtime search path." : "Ollama executable was not found."
    },
    {
      id: "ollama-host",
      label: "OLLAMA_HOST",
      status: hostConfigured ? "connected" : "ready_to_configure",
      detail: hostConfigured ? "OLLAMA_HOST is saved for Provider Router." : "Save OLLAMA_HOST before claiming router readiness."
    },
    {
      id: "ollama-server",
      label: "Ollama server",
      status: serverReachable ? "connected" : "ready_to_configure",
      detail: serverReachable ? `Ollama /api/tags responded in ${response.latencyMs}ms.` : response.error || "Ollama server is not reachable."
    },
    {
      id: "ollama-model",
      label: "Selected model",
      status: selectedModelAvailable ? "connected" : "ready_to_configure",
      detail: selectedModelAvailable ? `${model} is available locally.` : `${model} was not found in the local model inventory.`
    }
  ];
  const nextAction = !installed
    ? "Install Ollama, then run ollama serve."
    : !serverReachable
      ? "Start Ollama with `ollama serve`, then load models again."
      : !hostConfigured
        ? `Save OLLAMA_HOST=${host} in Provider Router.`
        : !selectedModelAvailable
          ? `Run ollama pull ${model}.`
          : "Ollama is ready for Provider Router dry-run dispatch.";
  const commands = [
    "Install Ollama from https://ollama.com/download",
    "ollama serve",
    `ollama pull ${model}`,
    `Set OLLAMA_HOST=${host}`
  ];
  const doctor = {
    id: "ollama-doctor",
    provider: "ollama",
    status,
    generatedAt: now(),
    installed,
    hostConfigured,
    serverReachable,
    host: sanitizeObject({ host }).host,
    model,
    modelCount: models.length,
    selectedModelAvailable,
    latencyMs: response.latencyMs,
    httpStatus: response.status,
    checks,
    commands,
    nextAction,
    publicSummary: serverReachable
      ? `Ollama is reachable with ${models.length} local model${models.length === 1 ? "" : "s"}.`
      : "Ollama is not reachable from the local Agent OS runtime."
  };
  await appendModuleLog(guide.moduleId, {
    level: status === "connected" ? "info" : "warn",
    message: "Ollama bootstrap doctor checked",
    details: {
      status,
      installed,
      hostConfigured,
      serverReachable,
      modelCount: models.length,
      selectedModelAvailable
    }
  });
  return doctor;
}

export async function getProviderModelInventory(id) {
  const guide = guideById(id);
  if (!guide || !guide.routerProvider) {
    const error = new Error(`Model inventory is not available for ${id}.`);
    error.status = guide ? 400 : 404;
    throw error;
  }
  const [stored, router] = await Promise.all([getStoredConnectionConfig(), getRouterStatus()]);
  const providerId = guide.routerProvider;
  const routerProvider = router.providers.find((provider) => provider.id === providerId);
  const modelDefault = routerProvider?.model || process.env[`HERMES_${providerId.toUpperCase()}_MODEL`] || guide.modelDefault;
  const missing = guide.fields
    .filter((field) => field.required && !configuredValue(stored, guide, field.key))
    .map((field) => field.key);

  if (missing.length) {
    return {
      id: `${providerId}-model-inventory`,
      provider: providerId,
      status: "ready_to_configure",
      configured: false,
      missing,
      generatedAt: now(),
      host: null,
      endpoint: providerId === "ollama" ? null : providerModelEndpoint(providerId, stored, guide),
      modelDefault,
      selectedModelAvailable: false,
      modelCount: 0,
      totalSizeBytes: 0,
      totalSizeGb: 0,
      models: [],
      publicSummary: `Configure ${missing.join(", ")} before reading ${guide.label} model inventory.`
    };
  }

  if (guide.id !== "ollama") {
    const response = await fetchProviderModels(providerId, stored, guide);
    if (!response.ok) {
      return {
        id: `${providerId}-model-inventory`,
        provider: providerId,
        status: "error",
        configured: true,
        missing: [],
        generatedAt: now(),
        host: null,
        endpoint: response.endpoint,
        modelDefault,
        selectedModelAvailable: false,
        modelCount: 0,
        totalSizeBytes: 0,
        totalSizeGb: 0,
        models: [],
        latencyMs: response.latencyMs,
        httpStatus: response.status,
        error: response.error || `${guide.label} model inventory returned HTTP ${response.status}`,
        publicSummary: `${guide.label} is configured, but model inventory could not be loaded.`
      };
    }
    const models = normalizeCloudModels(providerId, response.body);
    const selectedModelAvailable = models.some((model) => model.name === modelDefault || model.model === modelDefault);
    const inventory = {
      id: `${providerId}-model-inventory`,
      provider: providerId,
      status: "connected",
      configured: true,
      missing: [],
      generatedAt: now(),
      host: null,
      endpoint: response.endpoint,
      modelDefault,
      selectedModelAvailable,
      modelCount: models.length,
      totalSizeBytes: 0,
      totalSizeGb: 0,
      models,
      latencyMs: response.latencyMs,
      httpStatus: response.status,
      publicSummary: models.length
        ? `${models.length} ${guide.label} model${models.length === 1 ? "" : "s"} available.`
        : `${guide.label} is reachable, but no models were returned.`
    };
    await appendModuleLog(guide.moduleId, {
      message: `${guide.label} model inventory loaded`,
      details: {
        provider: providerId,
        modelCount: inventory.modelCount,
        selectedModelAvailable
      }
    });
    return inventory;
  }

  const host = configuredValue(stored, guide, "OLLAMA_HOST");
  if (!host) {
    return {
      id: "ollama-model-inventory",
      provider: "ollama",
      status: "ready_to_configure",
      configured: false,
      missing: ["OLLAMA_HOST"],
      generatedAt: now(),
      host: null,
      modelDefault,
      selectedModelAvailable: false,
      modelCount: 0,
      totalSizeBytes: 0,
      totalSizeGb: 0,
      models: [],
      publicSummary: "Configure OLLAMA_HOST before reading local model inventory."
    };
  }

  const response = await fetchOllamaTags(host);
  if (!response.ok) {
    return {
      id: "ollama-model-inventory",
      provider: "ollama",
      status: "error",
      configured: true,
      missing: [],
      generatedAt: now(),
      host: sanitizeObject({ host }).host,
      modelDefault,
      selectedModelAvailable: false,
      modelCount: 0,
      totalSizeBytes: 0,
      totalSizeGb: 0,
      models: [],
      latencyMs: response.latencyMs,
      httpStatus: response.status,
      error: response.error || `Ollama /api/tags returned HTTP ${response.status}`,
      publicSummary: "Ollama host is configured, but model inventory could not be loaded."
    };
  }

  const models = normalizeOllamaModels(response.body);
  const totalSizeBytes = models.reduce((sum, model) => sum + Number(model.sizeBytes || 0), 0);
  const selectedModelAvailable = models.some((model) => model.name === modelDefault || model.model === modelDefault);
  const inventory = {
    id: "ollama-model-inventory",
    provider: "ollama",
    status: "connected",
    configured: true,
    missing: [],
    generatedAt: now(),
    host: sanitizeObject({ host }).host,
    modelDefault,
    selectedModelAvailable,
    modelCount: models.length,
    totalSizeBytes,
    totalSizeGb: Number((totalSizeBytes / 1024 / 1024 / 1024).toFixed(2)),
    models,
    latencyMs: response.latencyMs,
    httpStatus: response.status,
    publicSummary: models.length
      ? `${models.length} local Ollama model${models.length === 1 ? "" : "s"} available.`
      : "Ollama is reachable, but no local models are installed yet."
  };
  await appendModuleLog(guide.moduleId, {
    message: "Ollama model inventory loaded",
    details: {
      modelCount: inventory.modelCount,
      totalSizeGb: inventory.totalSizeGb,
      selectedModelAvailable
    }
  });
  return inventory;
}
