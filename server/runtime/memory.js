import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { appendModuleLog } from "./module-logs.js";
import { sanitizeObject } from "./safety.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";

const MEMORY_TYPES = new Set(["semantic", "episodic", "procedural"]);
const PRIVACY_LEVELS = new Set(["private", "shared", "exportable"]);
const VECTOR_PROVIDERS = new Set(["disabled", "local-hash", "ollama", "openai", "qdrant"]);
const EMBEDDING_PROVIDERS = new Set(["local-hash", "ollama", "openai"]);
const QDRANT_DISTANCES = new Set(["Cosine", "Dot", "Euclid", "Manhattan"]);
const SEARCH_MODES = new Set(["hybrid", "lexical", "vector"]);
const MAX_IMPORT = 500;
const DEFAULT_VECTOR_DIMENSIONS = 96;

function now() {
  return new Date().toISOString();
}

function idFor() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function memoryFile() {
  await ensureRuntimeStore();
  return path.join(runtimePaths().memory, "agent-memory", "memories.json");
}

function vectorConfigFile() {
  return path.join(runtimePaths().config, "memory.vector.json");
}

function vectorIndexFile() {
  return path.join(runtimePaths().memory, "agent-memory", "vector-index.json");
}

function cleanText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function cleanType(value) {
  const type = cleanText(value, "semantic").toLowerCase();
  return MEMORY_TYPES.has(type) ? type : "semantic";
}

function cleanPrivacy(value) {
  const privacy = cleanText(value, "private").toLowerCase();
  return PRIVACY_LEVELS.has(privacy) ? privacy : "private";
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => cleanText(tag).toLowerCase()).filter(Boolean).slice(0, 20);
}

function numericImportance(value) {
  const number = Number(value ?? 0.5);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function cleanVectorProvider(value) {
  const provider = cleanText(value, "local-hash").toLowerCase();
  return VECTOR_PROVIDERS.has(provider) ? provider : "local-hash";
}

function cleanEmbeddingProvider(value) {
  const provider = cleanText(value, "local-hash").toLowerCase();
  return EMBEDDING_PROVIDERS.has(provider) ? provider : "local-hash";
}

function cleanSearchMode(value) {
  const mode = cleanText(value, "hybrid").toLowerCase();
  return SEARCH_MODES.has(mode) ? mode : "hybrid";
}

function defaultModelFor(provider) {
  if (provider === "ollama") return "nomic-embed-text";
  if (provider === "openai") return "text-embedding-3-small";
  return "local-hash-v1";
}

function numericDimensions(value) {
  const number = Number(value ?? DEFAULT_VECTOR_DIMENSIONS);
  if (!Number.isFinite(number)) return DEFAULT_VECTOR_DIMENSIONS;
  return Math.min(384, Math.max(16, Math.floor(number)));
}

function cleanEndpoint(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname === "/" ? "" : pathname}`;
  } catch {
    return "";
  }
}

function cleanCollection(value) {
  return cleanText(value, "hermes_memory").replace(/[^a-z0-9_.-]/gi, "-").slice(0, 96) || "hermes_memory";
}

function cleanDistance(value) {
  const distance = cleanText(value, "Cosine").toLowerCase();
  const normalized = Array.from(QDRANT_DISTANCES).find((item) => item.toLowerCase() === distance);
  return normalized || "Cosine";
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function redactText(value) {
  const home = os.homedir();
  return String(value || "")
    .replaceAll(home, "~")
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*\s*=\s*)[^\s#]+/gim, "$1configured")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-...")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "gh_...")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza...");
}

function redactMemory(memory) {
  return {
    ...memory,
    title: redactText(memory.title),
    content: redactText(memory.content),
    source: redactText(memory.source),
    metadata: sanitizeObject(memory.metadata || {})
  };
}

function defaultVectorConfig() {
  return {
    enabled: true,
    provider: "local-hash",
    embeddingProvider: "local-hash",
    model: "local-hash-v1",
    dimensions: DEFAULT_VECTOR_DIMENSIONS,
    autoIndex: true,
    endpoint: "",
    collection: "hermes_memory",
    apiKey: "",
    distance: "Cosine",
    updatedAt: null
  };
}

async function readVectorConfig() {
  await ensureRuntimeStore();
  const stored = await readJson(vectorConfigFile(), {});
  const provider = cleanVectorProvider(stored?.provider);
  const embeddingProvider = provider === "qdrant"
    ? cleanEmbeddingProvider(stored?.embeddingProvider)
    : provider === "disabled"
      ? "local-hash"
      : cleanEmbeddingProvider(provider);
  return {
    ...defaultVectorConfig(),
    enabled: stored?.enabled == null ? provider !== "disabled" : Boolean(stored.enabled),
    provider,
    embeddingProvider,
    model: cleanText(stored?.model, defaultModelFor(embeddingProvider)),
    dimensions: embeddingProvider === "local-hash" ? numericDimensions(stored?.dimensions) : Number(stored?.dimensions || 0) || DEFAULT_VECTOR_DIMENSIONS,
    autoIndex: stored?.autoIndex == null ? provider === "local-hash" : Boolean(stored.autoIndex),
    endpoint: cleanEndpoint(stored?.endpoint),
    collection: cleanCollection(stored?.collection),
    apiKey: cleanText(stored?.apiKey),
    distance: cleanDistance(stored?.distance),
    updatedAt: stored?.updatedAt || null
  };
}

function missingForEmbeddingProvider(provider, stored) {
  if (provider === "ollama") {
    return getConfiguredValue(stored, "provider-ollama", "OLLAMA_HOST") ? [] : ["OLLAMA_HOST"];
  }
  if (provider === "openai") {
    return getConfiguredValue(stored, "provider-openai", "OPENAI_API_KEY") ? [] : ["OPENAI_API_KEY"];
  }
  return [];
}

function providerMissing(config, stored) {
  if (!config.enabled || config.provider === "disabled" || config.provider === "local-hash") return [];
  if (config.provider === "qdrant") {
    return [
      ...(!config.endpoint ? ["QDRANT_ENDPOINT"] : []),
      ...(!config.collection ? ["QDRANT_COLLECTION"] : []),
      ...missingForEmbeddingProvider(config.embeddingProvider, stored)
    ];
  }
  return missingForEmbeddingProvider(config.provider, stored);
}

async function readVectorIndex() {
  const data = await readJson(vectorIndexFile(), {});
  return {
    schemaVersion: 1,
    provider: data?.provider || null,
    model: data?.model || null,
    dimensions: Number(data?.dimensions || 0),
    entries: data?.entries && typeof data.entries === "object" ? data.entries : {},
    updatedAt: data?.updatedAt || null
  };
}

async function writeVectorIndex(index) {
  const next = {
    schemaVersion: 1,
    provider: index.provider,
    model: index.model,
    dimensions: index.dimensions,
    entries: index.entries || {},
    updatedAt: now()
  };
  await writeJson(vectorIndexFile(), next);
  return next;
}

async function vectorStatus(memoryState = null) {
  const [config, stored, index] = await Promise.all([readVectorConfig(), getStoredConnectionConfig(), readVectorIndex()]);
  const missing = providerMissing(config, stored);
  const activeCount = memoryState?.summary?.active ?? 0;
  const vectorCount = Object.keys(index.entries || {}).length;
  return {
    enabled: Boolean(config.enabled),
    provider: config.provider,
    embedding: {
      provider: config.embeddingProvider,
      model: config.model,
      dimensions: config.dimensions
    },
    model: config.model,
    dimensions: config.dimensions,
    autoIndex: config.autoIndex,
    remote: config.provider === "qdrant" ? {
      type: "qdrant",
      endpoint: config.endpoint || null,
      collection: config.collection || null,
      distance: config.distance,
      hasApiKey: Boolean(config.apiKey)
    } : null,
    status: !config.enabled || config.provider === "disabled"
      ? "disabled"
      : missing.length
        ? "ready_to_configure"
        : "connected",
    configured: config.enabled && !missing.length && config.provider !== "disabled",
    missing,
    index: {
      memoryCount: activeCount,
      vectorCount,
      stale: Boolean(config.enabled && activeCount !== vectorCount),
      updatedAt: index.updatedAt
    },
    updatedAt: config.updatedAt
  };
}

function buildMemory(payload = {}, existing = null) {
  const timestamp = now();
  const content = cleanText(payload.content ?? payload.body, existing?.content || "");
  const title = cleanText(payload.title, existing?.title || content.slice(0, 80) || "Untitled memory");
  const agentId = cleanText(payload.agentId, existing?.agentId || "global").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const namespace = cleanText(payload.namespace, existing?.namespace || "default").replace(/[^a-z0-9_.-]/gi, "-").toLowerCase();
  return {
    id: existing?.id || cleanText(payload.id, idFor()).replace(/[^a-z0-9_-]/gi, "-").toLowerCase(),
    type: cleanType(payload.type ?? existing?.type),
    agentId,
    namespace,
    title,
    content,
    tags: cleanTags(payload.tags ?? existing?.tags),
    privacy: cleanPrivacy(payload.privacy ?? existing?.privacy),
    importance: numericImportance(payload.importance ?? existing?.importance),
    source: cleanText(payload.source, existing?.source || "manual"),
    metadata: sanitizeObject(payload.metadata || existing?.metadata || {}),
    archived: Boolean(payload.archived ?? existing?.archived ?? false),
    accessCount: Number(existing?.accessCount || 0),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    lastAccessedAt: existing?.lastAccessedAt || null
  };
}

function summarize(memories = []) {
  const active = memories.filter((memory) => !memory.archived);
  const summary = {
    total: memories.length,
    active: active.length,
    archived: memories.length - active.length,
    exportable: memories.filter((memory) => memory.privacy === "exportable" && !memory.archived).length,
    byType: {},
    byAgent: {},
    byPrivacy: {}
  };
  for (const memory of memories) {
    summary.byType[memory.type] = (summary.byType[memory.type] || 0) + 1;
    summary.byAgent[memory.agentId] = (summary.byAgent[memory.agentId] || 0) + 1;
    summary.byPrivacy[memory.privacy] = (summary.byPrivacy[memory.privacy] || 0) + 1;
  }
  return summary;
}

async function normalizeState(data) {
  const memories = Array.isArray(data?.memories)
    ? data.memories.map((memory) => buildMemory(memory, memory))
    : [];
  const state = {
    id: "memory",
    schemaVersion: 2,
    memories,
    summary: summarize(memories),
    updatedAt: data?.updatedAt || null
  };
  return {
    ...state,
    vector: await vectorStatus(state)
  };
}

async function readState() {
  const file = await memoryFile();
  return normalizeState(await readJson(file, { schemaVersion: 2, memories: [], updatedAt: null }));
}

async function writeState(state) {
  const file = await memoryFile();
  const next = {
    schemaVersion: 2,
    memories: state.memories,
    updatedAt: now()
  };
  await writeJson(file, next);
  return normalizeState(next);
}

export async function getMemoryState() {
  return readState();
}

export async function getMemoryOverview() {
  const state = await getMemoryState();
  return {
    ...state.summary,
    vector: state.vector,
    updatedAt: state.updatedAt
  };
}

export async function configureMemoryVector(input = {}) {
  await ensureRuntimeStore();
  const current = await readVectorConfig();
  const provider = cleanVectorProvider(input.provider ?? current.provider);
  const embeddingProvider = provider === "qdrant"
    ? cleanEmbeddingProvider(input.embeddingProvider ?? current.embeddingProvider)
    : provider === "disabled"
      ? "local-hash"
      : cleanEmbeddingProvider(provider);
  const endpoint = provider === "qdrant" ? cleanEndpoint(input.endpoint ?? current.endpoint) : "";
  const apiKey = provider === "qdrant"
    ? input.clearApiKey
      ? ""
      : input.apiKey
        ? cleanText(input.apiKey)
        : current.apiKey || ""
    : "";
  const next = {
    enabled: input.enabled == null ? provider !== "disabled" && current.enabled : Boolean(input.enabled),
    provider,
    embeddingProvider,
    model: cleanText(input.model, defaultModelFor(embeddingProvider)),
    dimensions: embeddingProvider === "local-hash" ? numericDimensions(input.dimensions ?? current.dimensions) : Number(input.dimensions || current.dimensions || DEFAULT_VECTOR_DIMENSIONS),
    autoIndex: input.autoIndex == null ? provider === "local-hash" : Boolean(input.autoIndex),
    endpoint,
    collection: provider === "qdrant" ? cleanCollection(input.collection ?? current.collection) : "hermes_memory",
    apiKey,
    distance: provider === "qdrant" ? cleanDistance(input.distance ?? current.distance) : "Cosine",
    updatedAt: now()
  };
  await writeJson(vectorConfigFile(), next);
  if (input.clearIndex !== false) {
    await writeVectorIndex({
      provider: next.provider,
      model: next.model,
      dimensions: next.dimensions,
      entries: {}
    });
  }
  await appendModuleLog("memory", {
    message: "Memory vector configuration saved",
    details: {
      provider: next.provider,
      embeddingProvider: next.embeddingProvider,
      model: next.model,
      dimensions: next.dimensions,
      autoIndex: next.autoIndex,
      remote: next.provider === "qdrant" ? {
        type: "qdrant",
        endpoint: next.endpoint,
        collection: next.collection,
        distance: next.distance,
        hasApiKey: Boolean(next.apiKey)
      } : null
    }
  });
  return getMemoryState();
}

export async function addMemory(payload = {}) {
  const state = await readState();
  const memory = buildMemory(payload);
  const next = await writeState({ memories: [memory, ...state.memories] });
  await appendModuleLog("memory", {
    message: "Memory saved",
    details: {
      memoryId: memory.id,
      type: memory.type,
      agentId: memory.agentId,
      privacy: memory.privacy
    }
  });
  return { memory, state: next };
}

export async function updateMemory(id, patch = {}) {
  const state = await readState();
  const index = state.memories.findIndex((memory) => memory.id === id);
  if (index === -1) {
    const error = new Error(`Memory not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const updated = buildMemory({ ...state.memories[index], ...patch }, state.memories[index]);
  const memories = [...state.memories];
  memories[index] = updated;
  const next = await writeState({ memories });
  await appendModuleLog("memory", {
    message: "Memory updated",
    details: {
      memoryId: updated.id,
      privacy: updated.privacy,
      archived: updated.archived
    }
  });
  return { memory: updated, state: next };
}

function matchesFilter(memory, filters = {}) {
  if (!filters.includeArchived && memory.archived) return false;
  if (filters.type && memory.type !== filters.type) return false;
  if (filters.agentId && memory.agentId !== filters.agentId) return false;
  if (filters.namespace && memory.namespace !== filters.namespace) return false;
  if (filters.privacy && memory.privacy !== filters.privacy) return false;
  return true;
}

function memoryEmbeddingText(memory) {
  return [
    memory.title,
    memory.content,
    (memory.tags || []).join(" "),
    memory.type,
    memory.agentId,
    memory.namespace
  ].filter(Boolean).join(" ");
}

function hashNumber(value) {
  const hash = crypto.createHash("sha256").update(String(value)).digest();
  return hash.readUInt32BE(0);
}

function localHashEmbedding(text, dimensions = DEFAULT_VECTOR_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  const tokens = tokenize(text);
  const grams = [];
  const compact = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  for (const token of tokens) {
    grams.push(token);
    if (token.length > 4) {
      for (let i = 0; i <= token.length - 3; i += 1) grams.push(token.slice(i, i + 3));
    }
  }
  for (let i = 0; i <= compact.length - 4; i += 1) {
    const gram = compact.slice(i, i + 4).trim();
    if (gram.length >= 3) grams.push(gram);
  }
  for (const gram of grams) {
    const hash = hashNumber(gram);
    const index = hash % dimensions;
    const sign = hash & 1 ? 1 : -1;
    vector[index] += sign / Math.max(1, Math.sqrt(grams.length));
  }
  return normalizeVector(vector);
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (Number(value) * Number(value)), 0));
  if (!magnitude) return vector.map(() => 0);
  return vector.map((value) => Number((Number(value) / magnitude).toFixed(8)));
}

function cosine(a = [], b = []) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < length; i += 1) {
    dot += Number(a[i] || 0) * Number(b[i] || 0);
    aMag += Number(a[i] || 0) ** 2;
    bMag += Number(b[i] || 0) ** 2;
  }
  if (!aMag || !bMag) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

function memoryFingerprint(memory, config) {
  return crypto.createHash("sha256").update(JSON.stringify({
    id: memory.id,
    updatedAt: memory.updatedAt,
    title: memory.title,
    content: memory.content,
    tags: memory.tags,
    provider: config.provider,
    embeddingProvider: config.embeddingProvider,
    model: config.model,
    dimensions: config.dimensions,
    endpoint: config.provider === "qdrant" ? config.endpoint : null,
    collection: config.provider === "qdrant" ? config.collection : null,
    distance: config.provider === "qdrant" ? config.distance : null
  })).digest("hex");
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || data.error || `Embedding provider HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function embeddingConfigFor(config) {
  if (config.provider !== "qdrant") return config;
  return {
    ...config,
    provider: config.embeddingProvider || "local-hash",
    model: config.model || defaultModelFor(config.embeddingProvider || "local-hash"),
    dimensions: config.dimensions || DEFAULT_VECTOR_DIMENSIONS
  };
}

async function embedText(text, config, stored) {
  if (!config.enabled || config.provider === "disabled") return null;
  if (config.provider === "local-hash") {
    return {
      embedding: localHashEmbedding(text, config.dimensions),
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions
    };
  }
  if (config.provider === "ollama") {
    const host = String(getConfiguredValue(stored, "provider-ollama", "OLLAMA_HOST") || "").replace(/\/$/, "");
    const data = await fetchJson(`${host}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model || "nomic-embed-text", prompt: text })
    });
    const embedding = Array.isArray(data.embedding) ? data.embedding : Array.isArray(data.embeddings?.[0]) ? data.embeddings[0] : [];
    return {
      embedding: normalizeVector(embedding.map(Number)),
      provider: config.provider,
      model: config.model,
      dimensions: embedding.length
    };
  }
  if (config.provider === "openai") {
    const apiKey = getConfiguredValue(stored, "provider-openai", "OPENAI_API_KEY");
    const data = await fetchJson("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: config.model || "text-embedding-3-small", input: text })
    });
    const embedding = Array.isArray(data.data?.[0]?.embedding) ? data.data[0].embedding : [];
    return {
      embedding: normalizeVector(embedding.map(Number)),
      provider: config.provider,
      model: config.model,
      dimensions: embedding.length
    };
  }
  return null;
}

function qdrantHeaders(config) {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { "api-key": config.apiKey } : {})
  };
}

function qdrantUrl(config, suffix = "") {
  const collection = encodeURIComponent(config.collection || "hermes_memory");
  return `${String(config.endpoint || "").replace(/\/$/, "")}/collections/${collection}${suffix}`;
}

function qdrantPointId(memoryId) {
  const hex = crypto.createHash("sha256").update(String(memoryId)).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function ensureQdrantCollection(config, dimensions) {
  try {
    await fetchJson(qdrantUrl(config), {
      method: "GET",
      headers: qdrantHeaders(config)
    });
    return { created: false };
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  await fetchJson(qdrantUrl(config), {
    method: "PUT",
    headers: qdrantHeaders(config),
    body: JSON.stringify({
      vectors: {
        size: dimensions,
        distance: config.distance || "Cosine"
      }
    })
  });
  return { created: true };
}

async function rebuildQdrantVectorIndex({ state, config, stored, current, force }) {
  const entries = {};
  const points = [];
  let indexed = 0;
  let reused = 0;
  let dimensions = config.dimensions;

  for (const memory of state.memories.filter((item) => !item.archived)) {
    const fingerprint = memoryFingerprint(memory, config);
    const existing = current.entries?.[memory.id];
    if (!force && existing?.fingerprint === fingerprint && existing?.pointId) {
      entries[memory.id] = existing;
      reused += 1;
      indexed += 1;
      dimensions = Number(existing.dimensions || dimensions);
      continue;
    }
    const embedded = await embedText(memoryEmbeddingText(memory), embeddingConfigFor(config), stored);
    if (!embedded?.embedding?.length) continue;
    const pointId = qdrantPointId(memory.id);
    dimensions = embedded.dimensions;
    entries[memory.id] = {
      memoryId: memory.id,
      pointId,
      fingerprint,
      provider: "qdrant",
      embeddingProvider: embedded.provider,
      model: embedded.model,
      dimensions: embedded.dimensions,
      collection: config.collection,
      indexedAt: now()
    };
    points.push({
      id: pointId,
      vector: embedded.embedding,
      payload: {
        memoryId: memory.id,
        title: redactText(memory.title),
        type: memory.type,
        agentId: memory.agentId,
        namespace: memory.namespace,
        privacy: memory.privacy,
        updatedAt: memory.updatedAt,
        fingerprint
      }
    });
    indexed += 1;
  }

  if (points.length) {
    await ensureQdrantCollection(config, dimensions);
    await fetchJson(qdrantUrl(config, "/points?wait=true"), {
      method: "PUT",
      headers: qdrantHeaders(config),
      body: JSON.stringify({ points })
    });
  }

  const index = await writeVectorIndex({
    provider: config.provider,
    model: config.model,
    dimensions,
    entries
  });
  await appendModuleLog("memory", {
    message: "Remote memory vector index synced",
    details: {
      provider: "qdrant",
      collection: config.collection,
      embeddingProvider: config.embeddingProvider,
      model: config.model,
      indexed,
      reused,
      vectorCount: Object.keys(index.entries || {}).length
    }
  });
  return {
    ok: true,
    status: "connected",
    indexed,
    reused,
    vector: await vectorStatus(state)
  };
}

export async function rebuildMemoryVectorIndex({ force = false } = {}) {
  const state = await readState();
  const config = await readVectorConfig();
  const stored = await getStoredConnectionConfig();
  const status = await vectorStatus(state);
  if (!status.configured) {
    return {
      ok: false,
      status: status.status,
      message: status.status === "disabled" ? "Memory vector index is disabled." : `Configure ${status.missing.join(", ")} before rebuilding vector memory.`,
      vector: status
    };
  }

  const current = await readVectorIndex();
  if (config.provider === "qdrant") {
    return rebuildQdrantVectorIndex({ state, config, stored, current, force });
  }
  const entries = {};
  let indexed = 0;
  let reused = 0;
  for (const memory of state.memories.filter((item) => !item.archived)) {
    const fingerprint = memoryFingerprint(memory, config);
    const existing = current.entries?.[memory.id];
    if (!force && existing?.fingerprint === fingerprint && Array.isArray(existing.embedding)) {
      entries[memory.id] = existing;
      reused += 1;
      indexed += 1;
      continue;
    }
    const embedded = await embedText(memoryEmbeddingText(memory), embeddingConfigFor(config), stored);
    if (!embedded?.embedding?.length) continue;
    entries[memory.id] = {
      memoryId: memory.id,
      fingerprint,
      provider: embedded.provider,
      model: embedded.model,
      dimensions: embedded.dimensions,
      embedding: embedded.embedding,
      indexedAt: now()
    };
    indexed += 1;
  }
  const index = await writeVectorIndex({
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    entries
  });
  await appendModuleLog("memory", {
    message: "Memory vector index rebuilt",
    details: {
      provider: config.provider,
      model: config.model,
      indexed,
      reused,
      vectorCount: Object.keys(index.entries || {}).length
    }
  });
  return {
    ok: true,
    status: "connected",
    indexed,
    reused,
    vector: await vectorStatus(state)
  };
}

async function searchQdrantVectorScores(config, embedding, limit, index) {
  const byPointId = new Map(Object.values(index.entries || {}).map((entry) => [entry.pointId, entry.memoryId]));
  const data = await fetchJson(qdrantUrl(config, "/points/search"), {
    method: "POST",
    headers: qdrantHeaders(config),
    body: JSON.stringify({
      vector: embedding,
      limit,
      with_payload: true
    })
  });
  const hits = Array.isArray(data.result) ? data.result : Array.isArray(data.points) ? data.points : [];
  return new Map(hits.map((hit) => {
    const memoryId = hit?.payload?.memoryId || byPointId.get(hit?.id);
    return memoryId ? [memoryId, Number(hit.score || 0)] : null;
  }).filter(Boolean));
}

function scoreMemory(memory, queryTokens) {
  if (!queryTokens.length) return { score: Number(memory.importance || 0.5), matched: true };
  const titleTokens = new Set(tokenize(memory.title));
  const contentTokens = new Set(tokenize(memory.content));
  const tagTokens = new Set(memory.tags || []);
  let lexical = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) lexical += 4;
    if (tagTokens.has(token)) lexical += 3;
    if (contentTokens.has(token)) lexical += 1;
    for (const contentToken of contentTokens) {
      if (contentToken.includes(token) || token.includes(contentToken)) {
        lexical += 0.25;
        break;
      }
    }
  }
  const recency = memory.lastAccessedAt
    ? Math.max(0, 1 - ((Date.now() - new Date(memory.lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24 * 30)))
    : 0;
  return {
    score: lexical + Number(memory.importance || 0.5) + recency + Math.min(Number(memory.accessCount || 0) / 20, 1),
    matched: lexical > 0
  };
}

export async function searchMemory(filters = {}) {
  const state = await readState();
  const query = cleanText(filters.query ?? filters.q);
  const queryTokens = tokenize(query);
  const limit = Math.min(50, Math.max(1, Number(filters.limit || 10)));
  const mode = cleanSearchMode(filters.mode);
  const typedFilters = {
    ...filters,
    type: filters.type ? cleanType(filters.type) : "",
    privacy: filters.privacy ? cleanPrivacy(filters.privacy) : "",
    agentId: filters.agentId ? cleanText(filters.agentId).replace(/[^a-z0-9_-]/gi, "-").toLowerCase() : "",
    namespace: filters.namespace ? cleanText(filters.namespace).replace(/[^a-z0-9_.-]/gi, "-").toLowerCase() : ""
  };
  let vectorInfo = state.vector;
  let vectorScores = new Map();
  if (query && mode !== "lexical") {
    const rebuilt = await rebuildMemoryVectorIndex();
    vectorInfo = rebuilt.vector || vectorInfo;
    if (rebuilt.ok) {
      const config = await readVectorConfig();
      const stored = await getStoredConnectionConfig();
      const queryEmbedding = await embedText(query, embeddingConfigFor(config), stored);
      const index = await readVectorIndex();
      if (queryEmbedding?.embedding?.length) {
        if (config.provider === "qdrant") {
          vectorScores = await searchQdrantVectorScores(config, queryEmbedding.embedding, Math.max(limit * 3, 20), index);
        } else {
          vectorScores = new Map(Object.entries(index.entries || {}).map(([id, entry]) => [
            id,
            cosine(queryEmbedding.embedding, entry.embedding)
          ]));
        }
      }
    }
  }

  const ranked = state.memories
    .filter((memory) => matchesFilter(memory, typedFilters))
    .map((memory) => {
      const lexical = scoreMemory(memory, queryTokens);
      const vectorScore = vectorScores.get(memory.id) || 0;
      const score = mode === "vector"
        ? vectorScore + (Number(memory.importance || 0.5) * 0.05)
        : lexical.score + (vectorScore > 0 ? vectorScore * 6 : 0);
      return { memory, score, lexicalScore: lexical.score, vectorScore, matched: lexical.matched || (mode !== "lexical" && vectorScore > 0.05) };
    })
    .filter((item) => item.matched)
    .sort((a, b) => b.score - a.score || String(b.memory.updatedAt).localeCompare(String(a.memory.updatedAt)))
    .slice(0, limit);

  if (ranked.length) {
    const timestamp = now();
    const returnedIds = new Set(ranked.map((item) => item.memory.id));
    const memories = state.memories.map((memory) => returnedIds.has(memory.id)
      ? { ...memory, accessCount: Number(memory.accessCount || 0) + 1, lastAccessedAt: timestamp }
      : memory);
    await writeState({ memories });
  }

  return {
    query,
    mode,
    vector: vectorInfo,
    filters: {
      type: typedFilters.type || null,
      agentId: typedFilters.agentId || null,
      namespace: typedFilters.namespace || null,
      privacy: typedFilters.privacy || null,
      includeArchived: Boolean(filters.includeArchived)
    },
    count: ranked.length,
    results: ranked.map((item) => ({
      ...redactMemory(item.memory),
      score: Number(item.score.toFixed(4)),
      lexicalScore: Number(item.lexicalScore.toFixed(4)),
      vectorScore: Number(item.vectorScore.toFixed(4))
    }))
  };
}

export async function exportMemory({ includePrivate = false, includeArchived = false } = {}) {
  const state = await readState();
  const memories = state.memories
    .filter((memory) => includeArchived || !memory.archived)
    .filter((memory) => includePrivate || memory.privacy !== "private")
    .map(redactMemory);
  return {
    schemaVersion: 1,
    exportedAt: now(),
    includePrivate: Boolean(includePrivate),
    includeArchived: Boolean(includeArchived),
    summary: summarize(memories),
    memories
  };
}

export async function importMemory(payload = {}) {
  const incoming = Array.isArray(payload.memories) ? payload.memories.slice(0, MAX_IMPORT) : [];
  const state = await readState();
  const imported = incoming
    .map((memory) => buildMemory({ ...memory, id: undefined, source: memory.source || "import" }))
    .filter((memory) => memory.content || memory.title);
  const next = await writeState({ memories: [...imported, ...state.memories] });
  await appendModuleLog("memory", {
    message: "Memory imported",
    details: {
      imported: imported.length,
      skipped: incoming.length - imported.length
    }
  });
  return {
    imported: imported.length,
    skipped: incoming.length - imported.length,
    state: next
  };
}
