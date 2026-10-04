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

async function fetchWithTimeout(url, { timeoutMs, headers, method, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers, method, body });
  } finally {
    clearTimeout(timer);
  }
}

// Which free model to pre-select. The list handed in is already filtered to
// models that cost nothing, support tools and have 64K+ of context, and is
// sorted by context size. Our rule is "the biggest model by the parameter
// count in its name, ties (and models whose name shows no size) by context
// length". Why: the one hard lesson we have is that a 3B local model failed
// every tool call, and bigger models call tools much more reliably than
// smaller ones. Context length alone is a poor guide (some tiny models
// advertise a huge window). The name is only a hint, so the person can always
// change it in the dropdown. Returns a model id, or null for an empty list.
export function pickRecommendedFreeModel(models) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return null;
  const sizeBillions = (model) => {
    // "llama-3.3-70b-instruct:free" -> 70; "qwen3-coder-480b-a35b:free" -> 480
    // (the first number is the total size; "a35b" is only the active part).
    const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(`${model.id} ${model.name || ""}`.replace(/[-_/:]/g, " "));
    return match ? Number(match[1]) : 0;
  };
  let best = list[0];
  for (const model of list) {
    const sizeDiff = sizeBillions(model) - sizeBillions(best);
    if (sizeDiff > 0 || (sizeDiff === 0 && Number(model.contextLength) > Number(best.contextLength))) best = model;
  }
  return best.id;
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
    const value = { models, recommended: pickRecommendedFreeModel(models) };
    modelsCache = { at: now, value };
    return value;
  } catch (error) {
    return { models: [], error: error?.message || "Could not reach OpenRouter to list models." };
  }
}

// Test-only: forces the next listFreeOpenRouterModels() to refetch.
export function clearBrainCacheForTest() {
  modelsCache = null;
  localListCache = null;
}

export async function verifyOpenRouterKey(apiKey) {
  const key = typeof apiKey === "string" ? apiKey : "";
  // Malformed keys are rejected before any network call -- the mirror in
  // tests sees no hit for these.
  if (!key.trim() || key.length > MAX_KEY_LENGTH) {
    return { ok: false, rejected: true, error: "That doesn't look like a valid OpenRouter API key." };
  }
  try {
    const response = await fetchWithTimeout(applyMirror(KEY_URL), {
      timeoutMs: KEY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!response.ok) {
      // Only 401/403 is a definite "this key is no good". Anything else (a
      // 5xx, a rate limit) says nothing about the key.
      const rejected = response.status === 401 || response.status === 403;
      return rejected
        ? { ok: false, rejected: true, error: "OpenRouter rejected that key." }
        : { ok: false, rejected: false, error: `OpenRouter couldn't check that key right now (HTTP ${response.status}).` };
    }
    const body = await response.json().catch(() => null);
    const data = body?.data || {};
    const result = { ok: true };
    if (typeof data.label === "string") result.label = data.label;
    if (typeof data.limit === "number") result.limit = data.limit;
    // OpenRouter says whether this account has ever bought credits; free
    // accounts get 50 free-model requests a day instead of 1,000.
    if (typeof data.is_free_tier === "boolean") result.isFreeTier = data.is_free_tier;
    return result;
  } catch {
    return { ok: false, rejected: false, error: "Could not reach OpenRouter to verify the key." };
  }
}

// Overridable so tests never have to bind (or fight over) the real Ollama
// port -- same idea as recipes.js's AGENT_OS_SETUP_MIRROR for the installer
// hosts. Unset in production; always http://127.0.0.1:11434 there.
// Only loopback overrides are honoured, like the installer mirror.
export function ollamaBaseUrl() {
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

// The installed models, with their size on disk in bytes.
async function ollamaTagEntries() {
  try {
    const response = await fetchWithTimeout(`${ollamaBaseUrl()}/api/tags`, { timeoutMs: OLLAMA_TIMEOUT_MS });
    if (!response.ok) return [];
    const body = await response.json();
    const models = Array.isArray(body?.models) ? body.models : [];
    return models
      .map((m) => ({ name: m?.name || m?.model || "", sizeBytes: typeof m?.size === "number" ? m.size : null }))
      .filter((m) => m.name);
  } catch {
    return [];
  }
}

// The list of model tags already pulled into a locally running Ollama, used
// to validate a POST /configure request for mode:"ollama".
export async function listOllamaTags() {
  return (await ollamaTagEntries()).map((m) => m.name);
}

// ---- local models (Ollama): what is installed, what to download ------------

// Agents need 64K tokens of "working memory" (context). Ollama's own default
// is far smaller (4K below 24 GiB of video memory, 32K up to 48 GiB), and
// Hermes talks to Ollama's OpenAI-style /v1 endpoint, which cannot ask for a
// bigger window per request. So Agent OS makes a settings-only copy of the
// chosen model with `num_ctx 65536` baked in (see ensureLocalVariant), and
// every number below is worked out AT that size.
export const LOCAL_CONTEXT_TOKENS = 65536;
// Memory counts in GiB here, because that is what a computer's "24 GB" of
// RAM really is (and what check.ramGb holds). Download sizes stay in the
// decimal GB that ollama.com and `ollama list` quote.
const GIB = 1024 ** 3;
// Besides the weights and the working-memory store (KV cache), Ollama needs
// scratch space for the model's compute buffers.
const LOCAL_OVERHEAD_BYTES = 0.5 * GIB;
// How much of the computer's memory a local model may take. The operating
// system, the browser and the agents themselves need the rest, and a model
// that fills the machine makes everything swap and crawl. Up to 60% is
// "comfortable"; up to 80% is "tight" (works, but expect slowness when other
// apps are open); beyond that it is "too_big".
export const FIT_COMFORTABLE_MAX = 0.6;
export const FIT_TIGHT_MAX = 0.8;

// The download SUGGESTIONS, best first. A row is only suggested when its
// memory need at 64K is at most 60% of this computer's memory, so every row
// here was checked on 2026-10-03 against two sources:
//   size, native context, "tools" tag: ollama.com/library/<name>/tags
//   KV numbers (layers, KV heads, head dim): the model's config.json on
//     Hugging Face (see the repo named per row)
// kvBytesPerToken = 2 (f16) x layers x kvHeads x (headDim + headDim).
// memoryAt64kGb  = (downloadGb x 1e9 + kvBytesPerToken x 65536 + 0.5 GiB) / GiB.
// Rows that could not be verified are left out on purpose (qwen3:8b/14b have
// only a 40K native window; mistral-small3.2 and qwen3-coder need as much
// memory as the rows above them without being better for agent work).
export const LOCAL_MODEL_TABLE = [
  {
    // ollama: 19GB, 256K context, tools. HF Qwen/Qwen3-30B-A3B-Instruct-2507:
    // 48 layers, 4 KV heads, head dim 128.
    model: "qwen3:30b",
    downloadGb: 19,
    nativeContext: 262144,
    kvBytesPerToken: 98304,
    memoryAt64kGb: 24.2
  },
  {
    // ollama: 14GB, 128K context, tools. HF openai/gpt-oss-20b: 24 layers,
    // 8 KV heads, head dim 64 (half the layers use a sliding window, so the
    // real figure is lower: "up to").
    model: "gpt-oss:20b",
    downloadGb: 14,
    nativeContext: 131072,
    kvBytesPerToken: 49152,
    memoryAt64kGb: 16.5
  },
  {
    // ollama: 4.9GB, 128K context, tools. HF meta-llama/Llama-3.1-8B-Instruct
    // (config read from the NousResearch mirror, the original is gated):
    // 32 layers, 8 KV heads, head dim 128.
    model: "llama3.1:8b",
    downloadGb: 4.9,
    nativeContext: 131072,
    kvBytesPerToken: 131072,
    memoryAt64kGb: 13.1
  }
];
// Below this many billions of parameters a model failed every tool call in a
// real test (llama3.2:3b), so we say so out loud instead of letting it
// quietly give wrong answers.
export const MIN_AGENT_MODEL_BILLIONS = 7;
// What an Ollama model name may look like. Used for the download route.
export const OLLAMA_MODEL_NAME_PATTERN = /^[a-z0-9._:-]{1,80}$/;
const OLLAMA_SHOW_TIMEOUT_MS = 3 * 1000;
const MAX_LOCAL_MODELS = 40;

// The best table row this much memory (in GiB) can run comfortably, or null.
export function recommendedLocalModel(memoryGb) {
  const memory = Number(memoryGb) || 0;
  for (const row of LOCAL_MODEL_TABLE) {
    if (row.memoryAt64kGb <= memory * FIT_COMFORTABLE_MAX) return { ...row, minMemoryGb: Math.ceil(row.memoryAt64kGb / FIT_COMFORTABLE_MAX) };
  }
  return null;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// How many bytes the working-memory store (KV cache) takes per token, f16:
//   2 bytes x (layers x KV heads) x (key length + value length)
// read from the numbers Ollama's /api/show puts in `model_info`, named
// "<architecture>.block_count" and so on. Returns null when a number is
// missing (then the caller says "unknown" instead of guessing).
//   - Without key_length / value_length the head size is
//     embedding_length / head_count, for both.
//   - head_count_kv can be a list with one entry per layer (some
//     architectures); then the entries are added up instead of multiplying
//     by the layer count.
//   - Models with sliding-window attention need less than this, so the result
//     is an upper bound ("up to").
export function kvBytesPerToken(modelInfo) {
  const info = modelInfo && typeof modelInfo === "object" ? modelInfo : {};
  let arch = typeof info["general.architecture"] === "string" ? info["general.architecture"] : "";
  if (!arch) {
    const key = Object.keys(info).find((k) => k.endsWith(".block_count"));
    arch = key ? key.slice(0, -".block_count".length) : "";
  }
  if (!arch) return null;
  const get = (suffix) => info[`${arch}.${suffix}`];

  const layers = positiveNumber(get("block_count"));
  if (!layers) return null;

  let keyLength = positiveNumber(get("attention.key_length"));
  let valueLength = positiveNumber(get("attention.value_length"));
  if (!keyLength || !valueLength) {
    const embedding = positiveNumber(get("embedding_length"));
    const heads = positiveNumber(get("attention.head_count"));
    if (!embedding || !heads) return null;
    keyLength = embedding / heads;
    valueLength = embedding / heads;
  }

  const kvHeads = get("attention.head_count_kv");
  let kvTotal = null; // KV heads added up over every layer
  if (Array.isArray(kvHeads)) {
    const numbers = kvHeads.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
    if (numbers.length && numbers.length === kvHeads.length) kvTotal = numbers.reduce((a, b) => a + b, 0);
  } else if (positiveNumber(kvHeads)) {
    kvTotal = layers * kvHeads;
  }
  if (!kvTotal) return null;
  return 2 * kvTotal * (keyLength + valueLength);
}

// What the model's own training context was ("<arch>.context_length").
function nativeContextOf(modelInfo) {
  const info = modelInfo && typeof modelInfo === "object" ? modelInfo : {};
  const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
  return key ? positiveNumber(info[key]) : null;
}

// How much memory a model needs at 64K of working memory, and whether that
// fits this computer:  weights + KV cache at 65,536 tokens + 0.5 GiB.
//   fit: comfortable (<= 60% of memory) | tight (<= 80%) | too_big | unknown
// `stretched` means 64K is past what the model was trained for ("trained for
// 40K; past that, answers get worse").
export function estimateLocalMemory({ sizeBytes, modelInfo, ramGb } = {}) {
  const nativeContext = nativeContextOf(modelInfo);
  const stretched = nativeContext !== null && nativeContext < LOCAL_CONTEXT_TOKENS;
  const perToken = kvBytesPerToken(modelInfo);
  const weights = positiveNumber(sizeBytes);
  const result = { memoryAt64kGb: null, fit: "unknown", nativeContext, stretched, kvBytesPerToken: perToken };
  if (!perToken || !weights) return result;
  const needBytes = weights + perToken * LOCAL_CONTEXT_TOKENS + LOCAL_OVERHEAD_BYTES;
  result.memoryAt64kGb = Math.round((needBytes / GIB) * 10) / 10;
  const ramBytes = (positiveNumber(ramGb) || 0) * GIB;
  if (!ramBytes) return result;
  const share = needBytes / ramBytes;
  result.fit = share <= FIT_COMFORTABLE_MAX ? "comfortable" : share <= FIT_TIGHT_MAX ? "tight" : "too_big";
  return result;
}

// Ollama reports "8.2B", "970M", "671B". Returns billions, or null.
export function parseParameterSize(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMBT])\s*$/i.exec(String(text ?? ""));
  if (!match) return null;
  const value = Number(match[1]);
  switch (match[2].toUpperCase()) {
    case "T":
      return value * 1000;
    case "B":
      return value;
    case "M":
      return value / 1000;
    default:
      return value / 1e6;
  }
}

// One plain-English verdict per installed model. `selectable` is false only
// when the model can't call tools at all (an agent can't work without that).
export function localModelVerdict(info) {
  const capabilities = Array.isArray(info?.capabilities) ? info.capabilities : null;
  if (capabilities && !capabilities.includes("tools")) {
    return { id: "no_tools", label: "No tool support", selectable: false };
  }
  if (!capabilities) {
    return { id: "unknown", label: "Couldn't check tool support (try updating Ollama)", selectable: true };
  }
  const billions = typeof info?.parameterBillions === "number" ? info.parameterBillions : null;
  if (billions === null) {
    return { id: "unknown", label: "Supports tools, but its size couldn't be read", selectable: true };
  }
  if (billions < MIN_AGENT_MODEL_BILLIONS) {
    return {
      id: "too_small",
      label: `Too small for agent work (under ${MIN_AGENT_MODEL_BILLIONS}B), answers may be wrong`,
      selectable: true
    };
  }
  return { id: "good", label: "Good for agent work", selectable: true };
}

// What `POST /api/show` knows about one installed model. Null when Ollama
// can't answer (not running, unknown model).
export async function ollamaModelInfo(name) {
  const model = String(name ?? "");
  if (!model || model.length > 200) return null;
  try {
    const response = await fetchWithTimeout(`${ollamaBaseUrl()}/api/show`, {
      timeoutMs: OLLAMA_SHOW_TIMEOUT_MS,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model })
    });
    if (!response.ok) return null;
    const body = await response.json();
    const details = body?.details || {};
    const modelInfo = body?.model_info && typeof body.model_info === "object" ? body.model_info : {};
    // Older Ollama versions send no "capabilities" list at all; keep that as
    // null ("couldn't check") rather than guessing "no tools".
    const capabilities = Array.isArray(body?.capabilities) ? body.capabilities.map(String) : null;
    const parameterSize = typeof details.parameter_size === "string" ? details.parameter_size : "";
    let parameterBillions = parseParameterSize(parameterSize);
    if (parameterBillions === null && typeof modelInfo["general.parameter_count"] === "number") {
      parameterBillions = modelInfo["general.parameter_count"] / 1e9;
    }
    const contextLength = nativeContextOf(modelInfo);
    // The settings text, e.g. "num_ctx   65536": used to tell whether a copy
    // we made earlier already has the 64K window.
    const numCtxMatch = /^\s*num_ctx\s+(\d+)\s*$/m.exec(typeof body?.parameters === "string" ? body.parameters : "");
    const numCtx = numCtxMatch ? Number(numCtxMatch[1]) : null;
    return { name: model, capabilities, parameterSize, parameterBillions, contextLength, modelInfo, numCtx };
  } catch {
    return null;
  }
}

const VERDICT_ORDER = { good: 0, unknown: 1, too_small: 2, no_tools: 3 };

// The settings-only copies Agent OS makes (see ensureLocalVariant) are an
// internal detail: the person picks the base model, so copies are not listed.
const VARIANT_NAME = /^agentos-.+:64k$/;

// ONE cached answer to "what is installed and how big is it": the model list
// on screen and the sentence that explains it (brainOptions) both come from
// here, so they can never disagree. It lives for about 10 seconds; a
// `refresh` (the Re-check button, a finished download) skips it.
const LOCAL_LIST_TTL_MS = 10 * 1000;
let localListCache = null; // { key, at, promise }

async function loadInstalledModels() {
  const entries = (await ollamaTagEntries()).filter((e) => !VARIANT_NAME.test(e.name)).slice(0, MAX_LOCAL_MODELS);
  const rows = await Promise.all(
    entries.map(async (entry) => {
      const info = await ollamaModelInfo(entry.name);
      const capabilities = info?.capabilities;
      if (capabilities && capabilities.includes("embedding") && !capabilities.includes("completion")) return null;
      return { entry, info };
    })
  );
  return rows.filter(Boolean);
}

export function clearLocalModelsCache() {
  localListCache = null;
}

// Every installed chat model with its verdict and its memory estimate, best
// first. Embedding-only models are left out: they are not something you can
// give an agent. `check.ramGb` decides the fit; the model facts are cached.
export async function listLocalModels(check, { refresh = false } = {}) {
  const key = ollamaBaseUrl();
  const now = Date.now();
  if (refresh || !localListCache || localListCache.key !== key || now - localListCache.at > LOCAL_LIST_TTL_MS) {
    localListCache = { key, at: now, promise: loadInstalledModels() };
  }
  const loaded = await localListCache.promise;
  const ramGb = Number(check?.ramGb) || 0;
  return loaded
    .map(({ entry, info }) => ({
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      parameterSize: info?.parameterSize || "",
      contextLength: info?.contextLength ?? null,
      verdict: localModelVerdict(info || {}),
      memory: estimateLocalMemory({ sizeBytes: entry.sizeBytes, modelInfo: info?.modelInfo, ramGb })
    }))
    .sort((a, b) => VERDICT_ORDER[a.verdict.id] - VERDICT_ORDER[b.verdict.id] || a.name.localeCompare(b.name));
}

// ---- the 64K copy ------------------------------------------------------------------

function variantError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// "qwen3:14b" -> "agentos-qwen3-14b:64k". Null when the result would not be
// a name Agent OS accepts (OLLAMA_MODEL_NAME_PATTERN), e.g. one with capitals.
export function localVariantName(base) {
  const name = `agentos-${String(base ?? "").replace(/[:/]/g, "-")}:64k`;
  return OLLAMA_MODEL_NAME_PATTERN.test(name) ? name : null;
}

const OLLAMA_CREATE_TIMEOUT_MS = 60 * 1000;

async function ollamaPost(pathname, body, timeoutMs) {
  return fetchWithTimeout(`${ollamaBaseUrl()}${pathname}`, {
    timeoutMs,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// Makes (or reuses) the settings-only copy of `base` that has a 64K window,
// using Ollama's POST /api/create with `from` and `parameters`
// (github.com/ollama/ollama docs/api.md, "Create a Model"): no download, the
// copy shares the base's weights. Reuses a copy that already reports
// num_ctx 65536. Resolves { name, created }; throws a plain-English Error
// (with a .code) on any problem.
export async function ensureLocalVariant(base) {
  const name = localVariantName(base);
  if (!name) {
    throw variantError(
      `Can't make a 64K copy of "${String(base).slice(0, 60)}": its name has characters Agent OS can't use for the copy. Pick another model, or use OpenRouter.`,
      "invalid_variant_name"
    );
  }
  const existing = await ollamaModelInfo(name);
  if (existing?.numCtx === LOCAL_CONTEXT_TOKENS) return { name, created: false };

  let response;
  try {
    response = await ollamaPost("/api/create", { model: name, from: base, parameters: { num_ctx: LOCAL_CONTEXT_TOKENS }, stream: false }, OLLAMA_CREATE_TIMEOUT_MS);
  } catch {
    throw variantError("Couldn't reach Ollama to prepare the model. Open the Ollama app and try again.", "local_prepare_failed");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = "";
    try {
      detail = String(JSON.parse(text)?.error || "");
    } catch {
      detail = "";
    }
    throw variantError(
      `Ollama couldn't prepare ${base} with 64K working memory${detail ? ` (${detail.slice(0, 160)})` : ` (HTTP ${response.status})`}.`,
      "local_prepare_failed"
    );
  }
  const made = await ollamaModelInfo(name);
  if (made?.numCtx !== LOCAL_CONTEXT_TOKENS) {
    throw variantError(
      `Ollama made a copy of ${base} but did not keep the 64K setting, so Agent OS stopped. Update Ollama, or use OpenRouter.`,
      "local_prepare_failed"
    );
  }
  clearLocalModelsCache();
  return { name, created: true };
}

function pullError(message, code = "pull_failed") {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Downloads one model with POST /api/pull and reports REAL progress: Ollama
// streams one JSON object per line, and each layer carries its own
// completed/total byte counts, which we add up. Throws on any error; an
// aborted `signal` rethrows the AbortError so the caller can mark "cancelled".
export async function streamOllamaPull(model, { signal, onProgress } = {}) {
  if (!OLLAMA_MODEL_NAME_PATTERN.test(String(model ?? ""))) {
    throw pullError("That doesn't look like a valid Ollama model name.", "invalid_model");
  }
  let response;
  try {
    response = await fetch(`${ollamaBaseUrl()}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw pullError("Couldn't reach Ollama. Open the Ollama app and try again.");
  }
  if (!response.ok || !response.body) {
    throw pullError(`Ollama refused the download (HTTP ${response.status}).`);
  }

  const layers = new Map(); // digest -> { total, completed }
  let finished = false;
  const handle = (evt) => {
    if (evt?.error) throw pullError(`Ollama said: ${String(evt.error).slice(0, 200)}`);
    if (typeof evt?.digest === "string" && typeof evt?.total === "number") {
      layers.set(evt.digest, { total: evt.total, completed: Number(evt.completed) || 0 });
    }
    if (evt?.status === "success") finished = true;
    let total = 0;
    let completed = 0;
    for (const layer of layers.values()) {
      total += layer.total;
      completed += Math.min(layer.completed, layer.total);
    }
    onProgress?.({ status: String(evt?.status || ""), completed, total });
  };

  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        let evt = null;
        try {
          evt = JSON.parse(line);
        } catch {
          // a partial or non-JSON line: skip it
        }
        if (evt) handle(evt);
      }
      newline = pending.indexOf("\n");
    }
  }
  if (pending.trim()) {
    try {
      handle(JSON.parse(pending));
    } catch (error) {
      if (error?.code === "pull_failed") throw error;
    }
  }
  if (!finished) throw pullError("The download stopped before it finished. Try again; it picks up where it left off.");
}

async function ollamaOption(check) {
  const installed = Boolean(check?.ollama?.found);
  const reachable = installed ? await ollamaReachable() : false;
  // Setup doesn't install Ollama itself yet, so say exactly what the user can
  // do, rather than implying local models aren't supported at all.
  if (!installed) {
    return {
      id: "ollama",
      available: false,
      reason: "Ollama isn't installed on this computer. Install it from ollama.com, download a model, then press Re-check."
    };
  }
  if (!reachable) {
    return {
      id: "ollama",
      available: false,
      reason: "Ollama is installed but not running. Open the Ollama app, then press Re-check."
    };
  }
  return { id: "ollama", available: true };
}

function roundGb(value) {
  return Math.round(Number(value) * 10) / 10;
}

// "Choose for me" is ALWAYS OpenRouter for both agents (a local model with
// 64K of working memory is a stretch even for a 24 GB computer); Local stays
// on offer and is never pre-selected. The explanation is built from the very
// same cached model list the Local card shows, so the sentence can never
// claim something the list contradicts.
export async function brainOptions(check, { refresh = false } = {}) {
  const openrouter = { id: "openrouter", available: true };
  const ollama = await ollamaOption(check);
  const models = ollama.available ? await listLocalModels(check, { refresh }) : [];
  const ramGb = Number(check?.ramGb) || 0;
  const good = models.filter((m) => m.verdict.id === "good");
  const comfortable = good.find((m) => m.memory.fit === "comfortable") || null;

  let localSentence;
  if (comfortable) {
    localSentence = `You could also run ${comfortable.name} locally; it fits this computer (about ${roundGb(comfortable.memory.memoryAt64kGb)} GB).`;
  } else {
    const needs = good.map((m) => m.memory.memoryAt64kGb).filter((n) => typeof n === "number");
    const memoryText = ramGb > 0 ? ` this computer has ${roundGb(ramGb)} GB.` : "";
    localSentence = needs.length
      ? `Running locally needs about ${roundGb(Math.min(...needs))} GB of memory for the 64K working memory agents need;${memoryText}`
      : `Running locally needs a model you have downloaded and enough memory for the 64K working memory agents need;${memoryText}`;
  }
  const reason = `We recommend OpenRouter for both agents: strong models, no big download, free to start. ${localSentence.replace(/;$/, ".")}`;
  return {
    recommendation: "openrouter",
    reason,
    // The installed model the sentence is about, when it fits comfortably.
    localModel: comfortable ? comfortable.name : null,
    options: [openrouter, ollama]
  };
}

// Everything the "Local" card needs in one call: is Ollama usable, which
// installed models are good for agent work and how much memory each needs at
// 64K, and what (if anything) honestly fits to download on this computer.
export async function localBrainSummary(check, { refresh = false } = {}) {
  const option = await ollamaOption(check);
  const memoryGb = Number(check?.ramGb) || 0;
  const models = option.available ? await listLocalModels(check, { refresh }) : [];
  const row = recommendedLocalModel(memoryGb);
  const smallest = LOCAL_MODEL_TABLE[LOCAL_MODEL_TABLE.length - 1];
  return {
    available: option.available,
    reason: option.reason || "",
    memoryGb: roundGb(memoryGb),
    models,
    download: row ? { ...row, installed: models.some((m) => m.name === row.model) } : null,
    downloadAdvice: row
      ? ""
      : `This computer has ${roundGb(memoryGb)} GB of memory, too little to run a local agent model with the 64K working memory agents need (the smallest we would suggest, ${smallest.model}, needs about ${smallest.memoryAt64kGb} GB). Use OpenRouter instead.`
  };
}

async function agentBrainStatus(agentId, detected) {
  const adapter = ADAPTERS[agentId];
  if (!detected?.installed) {
    return { installed: false, configured: false, source: "doctor", summary: `${adapter.label} is not installed.` };
  }
  const status = await adapter.configStatus(detected);
  if (agentId === "openclaw") {
    const jsonExists = await fileExists(path.join(os.homedir(), ".openclaw", "openclaw.json"));
    return { installed: true, configured: Boolean(status.ok && jsonExists), source: "status", summary: status.summary };
  }
  return { installed: true, configured: Boolean(status.ok), source: "doctor", summary: status.summary };
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
