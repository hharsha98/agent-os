import crypto from "node:crypto";
import path from "node:path";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { appendModuleLog } from "./module-logs.js";
import { forbiddenExportPatterns, sanitizeObject } from "./safety.js";
import { createSelfModuleItem, getSelfModuleState } from "./self-modules.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";

const DEFAULT_WARNING_THRESHOLD = 0.8;
const PRICE_PER_1K_TOKENS = {
  ollama: 0,
  openrouter: 0.002,
  minimax: 0.001,
  openai: 0.00015,
  anthropic: 0.003,
  gemini: 0.000075,
  manual: 0
};

const BILLING_IMPORT_PROVIDERS = ["anthropic", "gemini", "minimax", "firecrawl", "openai", "openrouter", "ollama", "manual"];
const BILLING_IMPORT_CURRENCIES = new Set(["", "usd", "credits"]);
const BILLING_IMPORT_MAX_ROWS = 500;
const BILLING_IMPORT_MAX_CHARS = 250000;

const RECONCILIATION_PROVIDERS = [
  {
    id: "openrouter-key",
    provider: "openrouter",
    label: "OpenRouter key usage",
    kind: "provider_usage",
    required: ["OPENROUTER_API_KEY"],
    connectionIds: ["provider-openrouter", "openclaude"],
    endpointEnv: "HERMES_OPENROUTER_KEY_URL",
    defaultEndpoint: "https://openrouter.ai/api/v1/key",
    docs: "https://openrouter.ai/docs/api/reference/limits",
    basis: "current UTC month key spend"
  },
  {
    id: "openrouter-credits",
    provider: "openrouter",
    label: "OpenRouter account credits",
    kind: "provider_credits",
    required: ["OPENROUTER_MANAGEMENT_KEY"],
    connectionIds: ["provider-openrouter"],
    endpointEnv: "HERMES_OPENROUTER_CREDITS_URL",
    defaultEndpoint: "https://openrouter.ai/api/v1/credits",
    docs: "https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits",
    basis: "all-time account credit usage"
  },
  {
    id: "openai-costs",
    provider: "openai",
    label: "OpenAI organization costs",
    kind: "provider_costs",
    required: ["OPENAI_ADMIN_KEY"],
    connectionIds: ["provider-openai", "codex"],
    endpointEnv: "HERMES_OPENAI_COSTS_URL",
    defaultEndpoint: "https://api.openai.com/v1/organization/costs",
    docs: "https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs/",
    basis: "current UTC month organization costs"
  },
  {
    id: "anthropic-manual",
    provider: "anthropic",
    label: "Anthropic billing reconciliation",
    kind: "invoice_import",
    unsupported: true,
    basis: "provider invoice export",
    publicSummary: "No supported Anthropic billing API is wired; use Billing import for CSV/JSON invoice exports."
  },
  {
    id: "gemini-manual",
    provider: "gemini",
    label: "Gemini billing reconciliation",
    kind: "invoice_import",
    unsupported: true,
    basis: "provider invoice export",
    publicSummary: "No supported Gemini billing API is wired; use Billing import for CSV/JSON invoice exports."
  },
  {
    id: "minimax-manual",
    provider: "minimax",
    label: "MiniMax billing reconciliation",
    kind: "invoice_import",
    unsupported: true,
    basis: "provider invoice export",
    publicSummary: "No supported MiniMax billing API is wired; use Billing import for CSV/JSON invoice exports."
  },
  {
    id: "ollama-local",
    provider: "ollama",
    label: "Ollama local reconciliation",
    kind: "local_free",
    unsupported: true,
    basis: "local model runtime",
    publicSummary: "Ollama has no provider invoice; local router calls remain zero-cost unless you import manual infrastructure cost."
  }
];

function now() {
  return new Date().toISOString();
}

function usageConfigPath() {
  return path.join(runtimePaths().config, "usage-credits.json");
}

function usageReconciliationPath() {
  return path.join(runtimePaths().runs, "usage-reconciliation.json");
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function providerRate(provider) {
  return PRICE_PER_1K_TOKENS[String(provider || "").toLowerCase()] ?? PRICE_PER_1K_TOKENS.manual;
}

function money(value) {
  return Number(Number(value || 0).toFixed(6));
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function normalizeKey(key) {
  return String(key || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cleanProvider(value, fallback = "manual") {
  const provider = String(value || fallback || "manual").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return BILLING_IMPORT_PROVIDERS.includes(provider) ? provider : "manual";
}

function firstValue(row, keys) {
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (row[normalized] != null && String(row[normalized]).trim() !== "") return row[normalized];
  }
  return "";
}

function parseNumber(value) {
  if (value == null || value === "") return 0;
  const cleaned = String(value).trim().replace(/[$,]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseImportDate(value) {
  if (!value) return now();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function checkBillingImportSafety(text) {
  if (String(text || "").length > BILLING_IMPORT_MAX_CHARS) {
    const error = new Error(`Billing import is too large. Limit is ${BILLING_IMPORT_MAX_CHARS} characters.`);
    error.status = 413;
    throw error;
  }
  const patterns = forbiddenExportPatterns();
  const findings = patterns.filter((rule) => rule.pattern.test(String(text || ""))).map((rule) => rule.name);
  if (findings.length) {
    const error = new Error(`Billing import rejected by safety audit: ${findings.join(", ")}`);
    error.status = 400;
    error.findings = findings;
    throw error;
  }
}

function parseCsvRows(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  const input = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((item) => item.some((value) => String(value || "").trim()));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map(normalizeKey);
  return nonEmpty.slice(1).map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = values[index] ?? "";
    });
    return record;
  });
}

function parseJsonRows(text) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.records)
      ? parsed.records
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.data)
          ? parsed.data
          : [];
  return rows.map((row) => {
    const record = {};
    for (const [key, value] of Object.entries(row || {})) {
      record[normalizeKey(key)] = value;
    }
    return record;
  });
}

function parseBillingRows(input = {}) {
  if (Array.isArray(input.records)) {
    checkBillingImportSafety(JSON.stringify(input.records));
    return input.records.map((row) => {
      const record = {};
      for (const [key, value] of Object.entries(row || {})) {
        record[normalizeKey(key)] = value;
      }
      return record;
    });
  }
  const text = String(input.text || "");
  checkBillingImportSafety(text);
  if (!text.trim()) return [];
  const format = String(input.format || "auto").toLowerCase();
  if (format === "json" || (format === "auto" && /^[\s\n\r]*[\[{]/.test(text))) {
    try {
      return parseJsonRows(text);
    } catch {
      const error = new Error("Billing import JSON could not be parsed.");
      error.status = 400;
      throw error;
    }
  }
  return parseCsvRows(text);
}

function normalizeBillingRow(row, input = {}, index = 0, existingRequestIds = new Set()) {
  const provider = cleanProvider(firstValue(row, ["provider", "vendor", "service"]) || input.provider);
  const currency = String(firstValue(row, ["currency", "currency_code"]) || input.currency || "usd").trim().toLowerCase();
  const invoiceDate = parseImportDate(firstValue(row, ["date", "usage_date", "invoice_date", "period_start", "created_at", "timestamp"]));
  const inputTokens = parseNumber(firstValue(row, ["input_tokens", "prompt_tokens"]));
  const outputTokens = parseNumber(firstValue(row, ["output_tokens", "completion_tokens"]));
  const totalTokens = parseNumber(firstValue(row, ["units", "tokens", "total_tokens", "quantity", "usage_units", "usage"]));
  const units = totalTokens || inputTokens + outputTokens;
  const cost = money(parseNumber(firstValue(row, ["cost", "amount", "total", "total_cost", "estimated_cost", "spend", "subtotal", "value"])));
  const model = String(firstValue(row, ["model", "model_name", "sku"]) || "").trim();
  const operation = String(firstValue(row, ["operation", "type", "line_item", "description", "product"]) || "billing_import").trim();
  const invoiceId = String(firstValue(row, ["invoice_id", "invoice", "statement_id"]) || "").trim();
  const explicitSourceId = String(firstValue(row, ["source_id", "id", "line_id", "usage_id", "transaction_id"]) || "").trim();
  const notes = String(firstValue(row, ["notes", "memo", "description"]) || "").trim();
  const sourceBasis = [
    provider,
    invoiceDate || "",
    invoiceId,
    explicitSourceId,
    model,
    operation,
    units,
    cost,
    notes
  ].join("|");
  const sourceId = explicitSourceId || stableHash(sourceBasis);
  const requestId = `billing-import:${provider}:${sourceId}`;
  const errors = [];
  if (!invoiceDate) errors.push("invalid date");
  if (!BILLING_IMPORT_CURRENCIES.has(currency)) errors.push(`unsupported currency ${currency}`);
  if (!units && !cost) errors.push("missing units or cost");
  if (cost < 0 || units < 0) errors.push("negative units or cost");
  if (existingRequestIds.has(requestId)) errors.push("duplicate");
  return {
    rowNumber: index + 1,
    provider,
    model,
    operation,
    createdAt: invoiceDate || now(),
    units,
    inputTokens,
    outputTokens,
    estimatedCost: cost || estimateUsage({ provider, units }).estimatedCost,
    currency,
    invoiceId,
    sourceId,
    requestId,
    notes,
    duplicate: existingRequestIds.has(requestId),
    valid: errors.length === 0,
    errors
  };
}

async function buildBillingImport(input = {}) {
  checkBillingImportSafety(String(input.sourceName || ""));
  const ledger = await getSelfModuleState("usage-credits");
  const existingRequestIds = new Set(ledger.items.map((item) => item.requestId).filter(Boolean));
  const rows = parseBillingRows(input);
  if (rows.length > BILLING_IMPORT_MAX_ROWS) {
    const error = new Error(`Billing import has too many rows. Limit is ${BILLING_IMPORT_MAX_ROWS}.`);
    error.status = 413;
    throw error;
  }
  const records = rows.map((row, index) => normalizeBillingRow(row, input, index, existingRequestIds));
  const validRecords = records.filter((record) => record.valid);
  const duplicateRecords = records.filter((record) => record.duplicate);
  const totalCost = validRecords.reduce((sum, record) => sum + Number(record.estimatedCost || 0), 0);
  const totalUnits = validRecords.reduce((sum, record) => sum + Number(record.units || 0), 0);
  return {
    id: "usage-billing-import",
    sourceName: String(input.sourceName || "pasted billing export").slice(0, 120),
    mode: input.commit ? "import" : "preview",
    acceptedProviders: BILLING_IMPORT_PROVIDERS,
    summary: {
      rows: records.length,
      valid: validRecords.length,
      invalid: records.length - validRecords.length,
      duplicates: duplicateRecords.length,
      totalUnits,
      totalEstimatedCost: money(totalCost)
    },
    records
  };
}

function cleanLimit(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 7);
}

function monthStartUnix(date = new Date()) {
  const current = new Date(date);
  return Math.floor(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1) / 1000);
}

function providerBucket(target, provider) {
  target[provider] = target[provider] || { units: 0, estimatedCost: 0, calls: 0 };
  return target[provider];
}

async function readUsageConfig() {
  await ensureRuntimeStore();
  const config = await readJson(usageConfigPath(), {});
  return {
    dailyLimit: cleanLimit(config.dailyLimit),
    monthlyLimit: cleanLimit(config.monthlyLimit),
    warningThreshold: Math.min(1, Math.max(0.1, Number(config.warningThreshold || DEFAULT_WARNING_THRESHOLD))),
    updatedAt: config.updatedAt || null
  };
}

function summarizeLedger(items, config, at = new Date()) {
  const today = dayKey(at);
  const month = monthKey(at);
  const byProvider = {};
  const dailyByProvider = {};
  const monthlyByProvider = {};
  let dailyCost = 0;
  let monthlyCost = 0;
  let totalCost = 0;
  let dailyUnits = 0;
  let monthlyUnits = 0;
  let totalUnits = 0;

  for (const item of items) {
    const cost = Number(item.estimatedCost || 0);
    const units = Number(item.units || 0);
    const createdAt = String(item.createdAt || "");
    totalCost += cost;
    totalUnits += units;
    const provider = item.provider || "manual";
    const providerTotals = providerBucket(byProvider, provider);
    providerTotals.units += units;
    providerTotals.estimatedCost += cost;
    providerTotals.calls += 1;
    if (createdAt.startsWith(today)) {
      dailyCost += cost;
      dailyUnits += units;
      const dailyTotals = providerBucket(dailyByProvider, provider);
      dailyTotals.units += units;
      dailyTotals.estimatedCost += cost;
      dailyTotals.calls += 1;
    }
    if (createdAt.startsWith(month)) {
      monthlyCost += cost;
      monthlyUnits += units;
      const monthlyTotals = providerBucket(monthlyByProvider, provider);
      monthlyTotals.units += units;
      monthlyTotals.estimatedCost += cost;
      monthlyTotals.calls += 1;
    }
  }

  for (const group of [byProvider, dailyByProvider, monthlyByProvider]) {
    for (const value of Object.values(group)) {
      value.estimatedCost = money(value.estimatedCost);
    }
  }

  const dailyLimit = config.dailyLimit;
  const monthlyLimit = config.monthlyLimit;
  return {
    total: {
      units: totalUnits,
      estimatedCost: money(totalCost),
      calls: items.length
    },
    daily: {
      key: today,
      units: dailyUnits,
      estimatedCost: money(dailyCost),
      limit: dailyLimit,
      remaining: dailyLimit ? money(dailyLimit - dailyCost) : null,
      warning: Boolean(dailyLimit && dailyCost >= dailyLimit * config.warningThreshold),
      overLimit: Boolean(dailyLimit && dailyCost > dailyLimit)
    },
    monthly: {
      key: month,
      units: monthlyUnits,
      estimatedCost: money(monthlyCost),
      limit: monthlyLimit,
      remaining: monthlyLimit ? money(monthlyLimit - monthlyCost) : null,
      warning: Boolean(monthlyLimit && monthlyCost >= monthlyLimit * config.warningThreshold),
      overLimit: Boolean(monthlyLimit && monthlyCost > monthlyLimit)
    },
    byProvider,
    dailyByProvider,
    monthlyByProvider
  };
}

async function readReconciliationHistory() {
  await ensureRuntimeStore();
  const stored = await readJson(usageReconciliationPath(), {});
  return {
    history: Array.isArray(stored.history) ? stored.history.slice(0, 50) : [],
    updatedAt: stored.updatedAt || null
  };
}

async function writeReconciliationHistory(history) {
  const next = {
    history: history.slice(0, 50),
    updatedAt: now()
  };
  await writeJson(usageReconciliationPath(), next);
  return next;
}

function configuredValue(stored, provider, key) {
  for (const id of provider.connectionIds || []) {
    const value = getConfiguredValue(stored, id, key);
    if (value) return value;
  }
  return process.env[key] || null;
}

function reconciliationEndpoint(provider) {
  return process.env[provider.endpointEnv] || provider.defaultEndpoint;
}

function latestForProvider(history, id) {
  return history.find((item) => item.providerId === id) || null;
}

function localCostFor(summary, provider, period) {
  if (period === "monthly") return Number(summary.monthlyByProvider?.[provider]?.estimatedCost || 0);
  if (period === "daily") return Number(summary.dailyByProvider?.[provider]?.estimatedCost || 0);
  return Number(summary.byProvider?.[provider]?.estimatedCost || 0);
}

function compareCosts(summary, provider, actualCost, period = "all_time") {
  const localEstimate = localCostFor(summary, provider, period === "month" || period === "monthly" ? "monthly" : period);
  const actual = money(actualCost);
  const delta = money(actual - localEstimate);
  return {
    provider,
    period,
    localEstimate: money(localEstimate),
    providerReported: actual,
    delta,
    driftPercent: localEstimate ? Number(((delta / localEstimate) * 100).toFixed(2)) : actual ? 100 : 0
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
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
      error: error?.name === "AbortError" ? "billing reconciliation timed out" : error?.message || "billing reconciliation failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

function reconciliationProviderState(provider, stored, history, summary) {
  const latest = latestForProvider(history, provider.id);
  if (provider.unsupported) {
    return {
      id: provider.id,
      provider: provider.provider,
      label: provider.label,
      kind: provider.kind,
      status: "unsupported",
      configured: false,
      missing: [],
      basis: provider.basis,
      docs: provider.docs || null,
      latest: latest || null,
      comparison: latest?.comparison || {
        provider: provider.provider,
        period: "manual",
        localEstimate: localCostFor(summary, provider.provider, "all_time"),
        providerReported: null,
        delta: null,
        driftPercent: null
      },
      publicSummary: provider.publicSummary
    };
  }

  const missing = provider.required.filter((key) => !configuredValue(stored, provider, key));
  const status = missing.length ? "ready_to_configure" : latest?.status === "error" ? "error" : latest?.status === "connected" ? "connected" : "not_checked";
  return {
    id: provider.id,
    provider: provider.provider,
    label: provider.label,
    kind: provider.kind,
    status,
    configured: missing.length === 0,
    missing,
    basis: provider.basis,
    docs: provider.docs,
    endpoint: provider.defaultEndpoint,
    latest: latest || null,
    comparison: latest?.comparison || null,
    lastChecked: latest?.checkedAt || null,
    publicSummary: missing.length
      ? `Configure ${missing.join(", ")} to reconcile ${provider.label}.`
      : latest
        ? `${provider.label} last checked ${latest.checkedAt}.`
        : `${provider.label} is ready to reconcile.`
  };
}

async function runOpenRouterKey(provider, stored, summary) {
  const apiKey = configuredValue(stored, provider, "OPENROUTER_API_KEY");
  const response = await fetchJsonWithTimeout(reconciliationEndpoint(provider), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  if (!response.ok) {
    return {
      status: "error",
      error: response.error || `OpenRouter key usage returned HTTP ${response.status}`,
      httpStatus: response.status,
      latencyMs: response.latencyMs
    };
  }
  const data = response.body?.data || {};
  const usageMonthly = money(data.usage_monthly);
  return {
    status: "connected",
    httpStatus: response.status,
    latencyMs: response.latencyMs,
    actual: {
      currency: "credits",
      usage: money(data.usage),
      usageDaily: money(data.usage_daily),
      usageWeekly: money(data.usage_weekly),
      usageMonthly,
      limit: data.limit == null ? null : money(data.limit),
      limitRemaining: data.limit_remaining == null ? null : money(data.limit_remaining),
      byokUsageMonthly: money(data.byok_usage_monthly),
      isFreeTier: Boolean(data.is_free_tier)
    },
    comparison: compareCosts(summary, "openrouter", usageMonthly, "monthly")
  };
}

async function runOpenRouterCredits(provider, stored, summary) {
  const apiKey = configuredValue(stored, provider, "OPENROUTER_MANAGEMENT_KEY");
  const response = await fetchJsonWithTimeout(reconciliationEndpoint(provider), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  if (!response.ok) {
    return {
      status: "error",
      error: response.error || `OpenRouter credits returned HTTP ${response.status}`,
      httpStatus: response.status,
      latencyMs: response.latencyMs
    };
  }
  const data = response.body?.data || {};
  const totalCredits = money(data.total_credits);
  const totalUsage = money(data.total_usage);
  return {
    status: "connected",
    httpStatus: response.status,
    latencyMs: response.latencyMs,
    actual: {
      currency: "credits",
      totalCredits,
      totalUsage,
      remaining: money(totalCredits - totalUsage)
    },
    comparison: compareCosts(summary, "openrouter", totalUsage, "all_time")
  };
}

async function runOpenAiCosts(provider, stored, summary) {
  const apiKey = configuredValue(stored, provider, "OPENAI_ADMIN_KEY");
  const base = reconciliationEndpoint(provider);
  const url = new URL(base);
  if (!url.searchParams.has("start_time")) url.searchParams.set("start_time", String(monthStartUnix()));
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "31");
  const response = await fetchJsonWithTimeout(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });
  if (!response.ok) {
    return {
      status: "error",
      error: response.error || `OpenAI organization costs returned HTTP ${response.status}`,
      httpStatus: response.status,
      latencyMs: response.latencyMs
    };
  }
  const buckets = Array.isArray(response.body?.data) ? response.body.data : [];
  const results = buckets.flatMap((bucket) => Array.isArray(bucket.results) ? bucket.results : []);
  const total = money(results.reduce((sum, item) => sum + Number(item?.amount?.value || 0), 0));
  const currencies = [...new Set(results.map((item) => item?.amount?.currency).filter(Boolean))];
  return {
    status: "connected",
    httpStatus: response.status,
    latencyMs: response.latencyMs,
    actual: {
      currency: currencies.length === 1 ? currencies[0] : currencies.length ? "mixed" : "usd",
      totalCost: total,
      buckets: buckets.length,
      lineItems: results.length,
      hasMore: Boolean(response.body?.has_more)
    },
    comparison: compareCosts(summary, "openai", total, "monthly")
  };
}

async function runReconciliationProvider(provider, stored, summary) {
  const checkedAt = now();
  if (provider.unsupported) {
    return {
      providerId: provider.id,
      provider: provider.provider,
      label: provider.label,
      status: "unsupported",
      checkedAt,
      basis: provider.basis,
      publicSummary: provider.publicSummary,
      comparison: {
        provider: provider.provider,
        period: "manual",
        localEstimate: localCostFor(summary, provider.provider, "all_time"),
        providerReported: null,
        delta: null,
        driftPercent: null
      }
    };
  }

  const missing = provider.required.filter((key) => !configuredValue(stored, provider, key));
  if (missing.length) {
    return {
      providerId: provider.id,
      provider: provider.provider,
      label: provider.label,
      status: "ready_to_configure",
      checkedAt,
      missing,
      basis: provider.basis,
      publicSummary: `Configure ${missing.join(", ")} to reconcile ${provider.label}.`
    };
  }

  const result = provider.id === "openrouter-key"
    ? await runOpenRouterKey(provider, stored, summary)
    : provider.id === "openrouter-credits"
      ? await runOpenRouterCredits(provider, stored, summary)
      : await runOpenAiCosts(provider, stored, summary);

  return {
    providerId: provider.id,
    provider: provider.provider,
    label: provider.label,
    checkedAt,
    basis: provider.basis,
    docs: provider.docs,
    ...result,
    publicSummary: result.status === "connected"
      ? `${provider.label} reconciled against ${provider.basis}.`
      : result.error || `${provider.label} reconciliation did not complete.`
  };
}

export function estimateUsage({ provider = "manual", inputText = "", outputText = "", inputTokens, outputTokens } = {}) {
  const inTokens = Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : estimateTokens(inputText);
  const outTokens = Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : outputText ? estimateTokens(outputText) : 0;
  const explicitUnits = Number(arguments[0]?.units);
  const units = Number.isFinite(explicitUnits) && explicitUnits > 0 ? explicitUnits : inTokens + outTokens;
  const explicitCost = Number(arguments[0]?.estimatedCost);
  return {
    provider: String(provider || "manual").toLowerCase(),
    inputTokens: inTokens,
    outputTokens: outTokens,
    units,
    estimatedCost: Number.isFinite(explicitCost) && explicitCost >= 0
      ? money(explicitCost)
      : money((units / 1000) * providerRate(provider))
  };
}

export async function getUsageState() {
  const [config, ledger] = await Promise.all([readUsageConfig(), getSelfModuleState("usage-credits")]);
  const summary = summarizeLedger(ledger.items, config);
  const reconciliation = await getUsageReconciliation({ summary });
  return {
    id: "usage-credits",
    config,
    summary,
    reconciliation,
    items: ledger.items,
    updatedAt: ledger.updatedAt
  };
}

export async function configureUsageBudget(input = {}) {
  await ensureRuntimeStore();
  const current = await readUsageConfig();
  const next = {
    dailyLimit: cleanLimit(input.dailyLimit ?? current.dailyLimit),
    monthlyLimit: cleanLimit(input.monthlyLimit ?? current.monthlyLimit),
    warningThreshold: Math.min(1, Math.max(0.1, Number(input.warningThreshold ?? current.warningThreshold))),
    updatedAt: now()
  };
  await writeJson(usageConfigPath(), next);
  await appendModuleLog("usage-credits", {
    message: "Usage budget configured",
    details: sanitizeObject(next)
  });
  return getUsageState();
}

export async function assertUsageBudget({ estimatedCost = 0, mode = "executed" } = {}) {
  if (["dry_run", "planned", "manual", "imported"].includes(mode)) return { ok: true };
  const state = await getUsageState();
  const dailyProjected = state.summary.daily.estimatedCost + Number(estimatedCost || 0);
  const monthlyProjected = state.summary.monthly.estimatedCost + Number(estimatedCost || 0);
  if (state.config.dailyLimit && dailyProjected > state.config.dailyLimit) {
    const error = new Error("Daily usage credit limit would be exceeded.");
    error.status = 402;
    error.details = { dailyProjected: money(dailyProjected), dailyLimit: state.config.dailyLimit };
    throw error;
  }
  if (state.config.monthlyLimit && monthlyProjected > state.config.monthlyLimit) {
    const error = new Error("Monthly usage credit limit would be exceeded.");
    error.status = 402;
    error.details = { monthlyProjected: money(monthlyProjected), monthlyLimit: state.config.monthlyLimit };
    throw error;
  }
  return { ok: true };
}

export async function recordUsageEvent(input = {}) {
  const estimate = estimateUsage(input);
  const mode = input.mode || (input.dryRun ? "dry_run" : "executed");
  const status = input.status || mode;
  await assertUsageBudget({ estimatedCost: estimate.estimatedCost, mode });
  const state = await createSelfModuleItem("usage-credits", {
    title: input.title || `${input.operation || "router"} ${estimate.provider} ${status}`,
    provider: estimate.provider,
    model: input.model,
    operation: input.operation || "router",
    units: estimate.units,
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    estimatedCost: estimate.estimatedCost,
    status,
    mode,
    dryRun: mode === "dry_run",
    source: input.source || "agent-os-runtime",
    requestId: input.requestId,
    notes: input.notes,
    createdAt: input.createdAt
  });
  await appendModuleLog("usage-credits", {
    message: "Usage event recorded",
    details: {
      provider: estimate.provider,
      operation: input.operation || "router",
      status,
      units: estimate.units,
      estimatedCost: estimate.estimatedCost
    }
  });
  const usage = await getUsageState();
  return {
    item: state.items[0],
    usage
  };
}

export async function previewUsageBillingImport(input = {}) {
  return buildBillingImport({ ...input, commit: false });
}

export async function importUsageBilling(input = {}) {
  const preview = await buildBillingImport({ ...input, commit: true });
  const importId = `usage_import_${Date.now().toString(36)}_${stableHash(JSON.stringify(preview.summary))}`;
  const imported = [];
  const skipped = [];
  for (const record of preview.records) {
    if (!record.valid) {
      skipped.push(record);
      continue;
    }
    const result = await recordUsageEvent({
      provider: record.provider,
      model: record.model,
      operation: "billing_import",
      units: record.units,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      estimatedCost: record.estimatedCost,
      status: "imported",
      mode: "imported",
      source: "billing-import",
      requestId: record.requestId,
      sourceId: record.sourceId,
      importId,
      invoiceId: record.invoiceId,
      currency: record.currency,
      createdAt: record.createdAt,
      importedAt: now(),
      title: `Imported ${record.provider} billing`,
      notes: [
        preview.sourceName,
        record.operation,
        record.notes
      ].filter(Boolean).join(" / ")
    });
    imported.push(result.item);
  }

  await appendModuleLog("usage-credits", {
    message: "Billing import completed",
    details: sanitizeObject({
      importId,
      sourceName: preview.sourceName,
      imported: imported.length,
      skipped: skipped.length,
      totalEstimatedCost: preview.summary.totalEstimatedCost
    })
  });

  return {
    ok: true,
    importId,
    preview: {
      ...preview,
      mode: "import"
    },
    imported,
    skipped,
    usage: await getUsageState()
  };
}

export async function getUsageReconciliation({ summary } = {}) {
  const [stored, config, ledger, reconciliation] = await Promise.all([
    getStoredConnectionConfig(),
    readUsageConfig(),
    getSelfModuleState("usage-credits"),
    readReconciliationHistory()
  ]);
  const usageSummary = summary || summarizeLedger(ledger.items, config);
  const providers = RECONCILIATION_PROVIDERS.map((provider) => reconciliationProviderState(provider, stored, reconciliation.history, usageSummary));
  return {
    id: "usage-reconciliation",
    providers,
    history: reconciliation.history,
    updatedAt: reconciliation.updatedAt,
    summary: {
      total: providers.length,
      connected: providers.filter((provider) => provider.status === "connected").length,
      readyToConfigure: providers.filter((provider) => provider.status === "ready_to_configure").length,
      notChecked: providers.filter((provider) => provider.status === "not_checked").length,
      unsupported: providers.filter((provider) => provider.status === "unsupported").length,
      errors: providers.filter((provider) => provider.status === "error").length
    }
  };
}

export async function runUsageReconciliation(input = {}) {
  const selected = String(input.provider || input.providerId || "all").trim();
  const selectedProviders = selected && selected !== "all"
    ? RECONCILIATION_PROVIDERS.filter((provider) => provider.id === selected || provider.provider === selected)
    : RECONCILIATION_PROVIDERS;
  if (!selectedProviders.length) {
    const error = new Error(`Usage reconciliation provider not found: ${selected}`);
    error.status = 404;
    throw error;
  }

  const [stored, config, ledger, existing] = await Promise.all([
    getStoredConnectionConfig(),
    readUsageConfig(),
    getSelfModuleState("usage-credits"),
    readReconciliationHistory()
  ]);
  const usageSummary = summarizeLedger(ledger.items, config);
  const results = [];
  for (const provider of selectedProviders) {
    results.push(await runReconciliationProvider(provider, stored, usageSummary));
  }

  const resultIds = new Set(results.map((item) => item.providerId));
  const merged = [
    ...results,
    ...existing.history.filter((item) => !resultIds.has(item.providerId))
  ];
  const written = await writeReconciliationHistory(merged);
  await appendModuleLog("usage-credits", {
    message: "Provider billing reconciliation completed",
    details: sanitizeObject({
      provider: selected,
      results: results.map((item) => ({
        providerId: item.providerId,
        status: item.status,
        comparison: item.comparison
      }))
    })
  });

  return {
    ok: true,
    checkedAt: written.updatedAt,
    results,
    reconciliation: await getUsageReconciliation({ summary: usageSummary })
  };
}
