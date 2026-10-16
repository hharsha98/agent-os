// The model half of the Setup Assistant: OpenRouter's catalog (for the
// "Change model" picker), looking up one model by its id, checking that an
// OpenRouter preset exists, and reading which model Hermes or OpenClaw uses
// right now. Nothing here changes an agent -- jobs.js does that -- and no key
// is ever returned: a key (when there is one) only goes to openrouter.ai in
// an Authorization header, through the same test mirror as everything else.
import { runCommand } from "../safety.js";
import { HERMES_MIN_CONTEXT, fetchWithTimeout } from "./brain.js";
import { applyMirror } from "./recipes.js";
import { PLAN_READ_TIMEOUT_MS, chatgptSignIn, openclawProviderLabel, parseAuthRows, planOfPrimary } from "./openclaw-plan-rules.js";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const ACCOUNT_CATALOG_URL = "https://openrouter.ai/api/v1/models/user";
const MODEL_URL = "https://openrouter.ai/api/v1/model";
const PRESET_URL = "https://openrouter.ai/api/v1/presets";
const PAGE_BASE = "https://openrouter.ai";

// Pages the person can be sent to (always opened with openSystemBrowser, which
// only ever accepts openrouter.ai addresses).
export const OPENROUTER_BROWSE_URL = `${PAGE_BASE}/models?supported_parameters=tools`;
export const OPENROUTER_PRESETS_URL = `${PAGE_BASE}/settings/presets`;
export const OPENROUTER_NEW_PRESET_URL = `${PAGE_BASE}/settings/presets/new`;

const CATALOG_TIMEOUT_MS = 10 * 1000;
const CATALOG_TTL_MS = 2 * 60 * 1000; // OpenRouter itself says max-age=120
const MAX_CACHED_CATALOGS = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10000;
const MAX_QUERY_LENGTH = 100;
const NEW_MODEL_DAYS = 30;
const MAX_DESCRIPTION = 300;
const CONFIG_GET_TIMEOUT_MS = 10 * 1000;

// What /models?sort= accepts (the documented values we offer).
export const CATALOG_SORTS = [
  "agentic-high-to-low",
  "newest",
  "pricing-low-to-high",
  "context-high-to-low",
  "most-popular",
  "throughput-high-to-low",
  "latency-low-to-high",
  "intelligence-high-to-low",
  "coding-high-to-low"
];

// A model id as it goes into a command line: only these characters, and it
// can never start with "-" (so it can't be read as a flag).
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@~][A-Za-z0-9._:/@~-]{0,119}$/;
// The name of a preset made on openrouter.ai/settings/presets.
export const PRESET_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const OPENCLAW_MODEL_PATH = "agents.defaults.model.primary";

// "author/model" (what OpenRouter calls a model id). Returns the cleaned id, or
// null when it is not one: wrong characters, no author, or a "." / ".." part
// (the id is also put into an address, where those would change the path).
export function parseModelId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!MODEL_ID_PATTERN.test(id)) return null;
  const parts = id.split("/");
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === "..")) return null;
  return id;
}

export function parsePresetSlug(value) {
  if (typeof value !== "string") return null;
  const slug = value.trim();
  return PRESET_SLUG_PATTERN.test(slug) ? slug : null;
}

// The ref an agent is given for a preset: "@preset/<slug>" (OpenRouter's form).
export function presetModelId(slug) {
  return `@preset/${slug}`;
}

// The page for one model: its id without a ":free" suffix.
export function modelPageUrl(id) {
  return `${PAGE_BASE}/${String(id).replace(/:free$/, "")}`;
}

// ---- mapping one catalog entry ---------------------------------------------------------

// "0.000003" (dollars per token) -> 3 (dollars per million tokens). null for
// anything that isn't a plain price: OpenRouter's routers report "-1".
function perMillion(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

function money(n) {
  return n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

// The one sentence about price shown on screen, so the screen never has to
// guess. A free model is "Free (rate-limited)" only when its id says ":free";
// a model that costs nothing without that suffix is just "Free".
export function priceLabel(pricing, id) {
  const p = pricing && typeof pricing === "object" ? pricing : {};
  const prompt = perMillion(p.prompt);
  const completion = perMillion(p.completion);
  const varies = Number(p.prompt) < 0 || Number(p.completion) < 0;
  if (varies) return "Price varies (router)";
  if (prompt === 0 && completion === 0) return /:free$/.test(String(id)) ? "Free (rate-limited)" : "Free";
  if (prompt === null || completion === null) return "Price not listed";
  return `${money(prompt)} per 1M in · ${money(completion)} out`;
}

// One /models entry -> what the picker needs, or null when it has no usable id
// (an id the apply route would refuse is never offered).
export function mapCatalogModel(raw, now = Date.now()) {
  const id = parseModelId(raw?.id);
  if (!id) return null;
  const prompt = perMillion(raw?.pricing?.prompt);
  const completion = perMillion(raw?.pricing?.completion);
  const contextLength = Number(raw?.context_length) > 0 ? Number(raw.context_length) : 0;
  const maxOut = Number(raw?.top_provider?.max_completion_tokens);
  const created = Number(raw?.created) > 0 ? Number(raw.created) : null;
  const description = String(raw?.description || "").replace(/\s+/g, " ").trim();
  const free = prompt === 0 && completion === 0;
  return {
    id,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    contextLength,
    maxCompletionTokens: Number.isFinite(maxOut) && maxOut > 0 ? maxOut : null,
    created,
    isNew: created !== null && now / 1000 - created >= -86400 && now / 1000 - created < NEW_MODEL_DAYS * 86400,
    inputModalities: Array.isArray(raw?.architecture?.input_modalities) ? raw.architecture.input_modalities.map(String) : [],
    expiresAt: typeof raw?.expiration_date === "string" && raw.expiration_date ? raw.expiration_date : null,
    pricing: { promptPerM: prompt, completionPerM: completion, label: priceLabel(raw?.pricing, id) },
    free,
    rateLimitedFree: free && /:free$/.test(id),
    // Hermes refuses models that have less than 64K of working memory.
    hermesOk: contextLength >= HERMES_MIN_CONTEXT,
    pageUrl: modelPageUrl(id)
  };
}

function supportsTools(raw) {
  return Array.isArray(raw?.supported_parameters) && raw.supported_parameters.includes("tools");
}

// ---- the catalog -----------------------------------------------------------------------

// url -> { at, models } (already mapped; free/paging are applied per request)
const catalogCache = new Map();

// Test-only: forgets the cached catalogs.
export function clearCatalogCacheForTest() {
  catalogCache.clear();
}

async function fetchPublicCatalog({ tools, sort, q }) {
  const params = [];
  if (tools) params.push("supported_parameters=tools");
  if (sort) params.push(`sort=${sort}`);
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  const url = applyMirror(`${CATALOG_URL}${params.length ? `?${params.join("&")}` : ""}`);
  const cached = catalogCache.get(url);
  const now = Date.now();
  if (cached && now - cached.at < CATALOG_TTL_MS) return cached.models;
  const response = await fetchWithTimeout(url, { timeoutMs: CATALOG_TIMEOUT_MS });
  if (!response.ok) throw new Error(`OpenRouter models request failed (HTTP ${response.status}).`);
  const body = await response.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  // The public list was already asked for tools; the check is repeated here so
  // a model that doesn't list "tools" is never offered to an agent.
  const models = list
    .filter((raw) => !tools || supportsTools(raw))
    .map((raw) => mapCatalogModel(raw, now))
    .filter(Boolean);
  catalogCache.set(url, { at: now, models });
  while (catalogCache.size > MAX_CACHED_CATALOGS) catalogCache.delete(catalogCache.keys().next().value);
  return models;
}

// The ids this account may use (it respects the person's privacy and
// guardrail settings). { ids } on success, { rejected: true } when OpenRouter
// says the key is no good, null for any other failure.
async function fetchAccountModelIds(key, tools) {
  try {
    const response = await fetchWithTimeout(applyMirror(ACCOUNT_CATALOG_URL), {
      timeoutMs: CATALOG_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${key}` }
    });
    if (response.status === 401 || response.status === 403) return { rejected: true };
    if (!response.ok) return null;
    const body = await response.json();
    const list = Array.isArray(body?.data) ? body.data : [];
    return { ids: new Set(list.filter((raw) => !tools || supportsTools(raw)).map((raw) => String(raw?.id))) };
  } catch {
    return null;
  }
}

// Reads and checks the query string of GET /openrouter/models. { value } or
// { error } (a plain sentence, for the 400).
export function parseCatalogQuery(query = {}) {
  const text = (name) => (query[name] === undefined ? undefined : typeof query[name] === "string" ? query[name] : null);
  const tools = text("tools");
  const free = text("free");
  const sort = text("sort");
  const q = text("q");
  const offset = text("offset");
  const limit = text("limit");
  if ([tools, free, sort, q, offset, limit].includes(null)) return { error: "Each search setting may be given only once." };
  if (tools !== undefined && tools !== "1" && tools !== "0") return { error: "tools must be 1 or 0." };
  if (free !== undefined && free !== "only" && free !== "all") return { error: "free must be only or all." };
  if (sort !== undefined && sort !== "" && !CATALOG_SORTS.includes(sort)) return { error: "That sort order isn't one OpenRouter offers." };
  const search = (q || "").trim();
  if (search.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(search)) {
    return { error: `The search text can be at most ${MAX_QUERY_LENGTH} characters, with no control characters.` };
  }
  const number = (raw, fallback, min, max) => {
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d{1,6}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= min && n <= max ? n : null;
  };
  const offsetNumber = number(offset, 0, 0, MAX_OFFSET);
  const limitNumber = number(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (offsetNumber === null || limitNumber === null) return { error: `offset must be 0 to ${MAX_OFFSET} and limit 1 to ${MAX_LIMIT}.` };
  return {
    value: { tools: tools !== "0", free: free || "all", sort: sort || "", q: search, offset: offsetNumber, limit: limitNumber }
  };
}

// One page of OpenRouter's models. Order and search come from OpenRouter
// (cached for 2 minutes). With a connected key, only the models THIS account
// may use are kept; a refused key falls back to the public list.
export async function listCatalog({ tools = true, free = "all", sort = "", q = "", offset = 0, limit = DEFAULT_LIMIT, key = "" } = {}) {
  const page = { offset, limit };
  let models;
  try {
    models = await fetchPublicCatalog({ tools, sort, q });
  } catch (error) {
    return {
      models: [],
      total: 0,
      ...page,
      hasMore: false,
      source: "public",
      error: error?.message?.startsWith("OpenRouter models request failed")
        ? "OpenRouter couldn't list its models right now. Try again in a minute."
        : "Couldn't reach OpenRouter to list its models. Check your internet connection and try again."
    };
  }
  let source = "public";
  let keyRejected = false;
  if (key) {
    const account = await fetchAccountModelIds(key, tools);
    if (account?.ids) {
      models = models.filter((model) => account.ids.has(model.id));
      source = "account";
    } else if (account?.rejected) {
      keyRejected = true;
    }
  }
  if (free === "only") models = models.filter((model) => model.free);
  return {
    models: models.slice(offset, offset + limit),
    total: models.length,
    ...page,
    hasMore: offset + limit < models.length,
    source,
    ...(keyRejected ? { keyRejected: true } : {})
  };
}

// ---- one model, by id ------------------------------------------------------------------

// OpenRouter's own answer for ONE model id (GET /api/v1/model/{author}/{slug},
// which also understands ":free"). { model } | { notFound: true } |
// { unreachable: true }. The id must already have passed parseModelId().
export async function lookupModel(id) {
  const clean = parseModelId(id);
  if (!clean) return { notFound: true };
  let response;
  try {
    response = await fetchWithTimeout(applyMirror(`${MODEL_URL}/${clean}`), { timeoutMs: CATALOG_TIMEOUT_MS });
  } catch {
    return { unreachable: true };
  }
  if (response.status === 404) return { notFound: true };
  if (!response.ok) return { unreachable: true };
  const body = await response.json().catch(() => null);
  const data = body?.data && typeof body.data === "object" ? body.data : body;
  if (!data || typeof data !== "object") return { unreachable: true };
  // The id the person asked for is the one that is applied (so a ":free"
  // choice stays a ":free" choice).
  const model = mapCatalogModel({ ...data, id: clean });
  return model ? { model } : { unreachable: true };
}

// Does this preset exist on the person's OpenRouter account?
// { exists: true } | { exists: false } (404) | { skipped: true } when
// OpenRouter couldn't answer (the hello test decides, then).
export async function checkPreset(slug, key) {
  try {
    const response = await fetchWithTimeout(applyMirror(`${PRESET_URL}/${slug}`), {
      timeoutMs: CATALOG_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${key}` }
    });
    if (response.status === 404) return { exists: false };
    if (response.ok) return { exists: true };
    return { skipped: true };
  } catch {
    return { skipped: true };
  }
}

// ---- which model does an agent use now? -------------------------------------------------

// What `config get` printed -> the value, or null. Accepts a JSON string
// ("x/y"), a bare word, a banner line before the value, and the "not set"
// sentences. Anything that doesn't look like a model id or provider is dropped
// (it is shown on screen, so it never carries odd text).
export function parseConfigText(stdout) {
  const value = configTextValue(stdout);
  if (isUnsetValue(value)) return null;
  return /^[A-Za-z0-9._:/@~ -]{1,200}$/.test(value) ? value : null;
}

// True only when `config get` printed nothing or one of the "not set" answers.
// A value parseConfigText drops for its characters (a "+", an accented letter)
// is set, not unset: the ChatGPT plan job must not count it as "no model".
export function configTextIsUnset(stdout) {
  return isUnsetValue(configTextValue(stdout));
}

function isUnsetValue(value) {
  return !value || /^(null|undefined|unset|none)$/i.test(value) || /not set|no value|unset/i.test(value);
}

// The last line `config get` printed, without colour codes, JSON or quotes.
function configTextValue(stdout) {
  const lines = String(stdout ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let value = lines.length ? lines[lines.length - 1] : "";
  try {
    const parsed = JSON.parse(value);
    value = typeof parsed === "string" ? parsed : parsed === null ? "" : value;
  } catch {
    value = value.replace(/^["']|["']$/g, "");
  }
  return value.trim();
}

const PROVIDER_LABEL = { openrouter: "OpenRouter", ollama: "Local (Ollama)" };
// The settings-only 64K copy Agent OS makes for a local model (see brain.js).
const LOCAL_COPY = /^agentos-.+:64k$/;

function describeModel(agentId, provider, model) {
  const isLocalCopy = Boolean(model && LOCAL_COPY.test(model));
  // Hermes talks to Ollama as a "custom" provider; only a model Agent OS made
  // itself is called Local, because "custom" could be anything.
  const providerLabel =
    provider === "custom" && isLocalCopy ? PROVIDER_LABEL.ollama : PROVIDER_LABEL[provider] || (provider ? provider : null);
  const presetSlug = model && model.startsWith("@preset/") ? model.slice("@preset/".length) : null;
  return { agentId, installed: true, provider: provider || null, providerLabel, model: model || null, isPreset: Boolean(presetSlug), presetSlug };
}

// ---- OpenClaw's plan reads (spec 2026-10-15, sections 2 and 5) ------------------------------------
// The two reads that tell which plan OpenClaw's model runs on, kept here, in one
// place, for readAgentModel below, the plan status and model lists
// (openclaw-plans.js, which re-exports them) and the plan jobs (jobs.js). They go
// through OpenClaw's own commands, never its files.

// `config get agents.defaults.models --json`: the per-model settings, where the
// claude-cli runtime pins live. Answers { value, confirmed }: `value` is a plain
// object or null; `confirmed: false` means the read failed or came back garbled
// (it says nothing about pins), while a command that ran and printed nothing
// says "no per-model settings" (value null, confirmed).
export async function readOpenclawModelsConfigState(detected) {
  if (!detected?.installed) return { value: null, confirmed: false };
  const result = await runCommand(detected.path, ["config", "get", "agents.defaults.models", "--json"], CONFIG_GET_TIMEOUT_MS);
  if (!result.ok) return { value: null, confirmed: false };
  const value = parseJsonOutput(result.stdout);
  const readable = value !== null && typeof value === "object" && !Array.isArray(value);
  return { value: readable ? value : null, confirmed: readable || result.stdout === "" };
}

// The per-model settings as a plain object, or null (not installed, failed, nothing printed, or not an object).
export async function readOpenclawModelsConfig(detected) {
  return (await readOpenclawModelsConfigState(detected)).value;
}

// Signed in with ChatGPT? Only each saved sign-in's method and token sharing
// are kept; the command's output goes no further than this function.
// `signedIn: null` means the list could not be read.
export async function readChatgptAuth(detected) {
  if (!detected?.installed) return { signedIn: null, sharing: null };
  const result = await runCommand(detected.path, ["models", "auth", "list", "--provider", "openai", "--json"], PLAN_READ_TIMEOUT_MS);
  return chatgptSignIn(result.ok ? parseAuthRows(parseJsonOutput(result.stdout)) : null);
}

// Which plan OpenClaw's model runs on (spec 2026-10-15, section 5), checked the
// way OpenClaw itself decides, through its own commands (never its files): an
// anthropic/ model pinned to the claude-cli runtime is the Claude plan, an
// openai/ model with a Sign in with ChatGPT profile is the ChatGPT plan. Only
// each sign-in's method is kept from `models auth list`; its output is never
// logged or returned.
// `reads` holds the two possible confirming reads, already started (readAgentModel
// starts both beside the primary read); only the one this primary needs is waited for.
// Answers { plan, confirmed }. `confirmed: false` means the read that would have
// confirmed a plan failed (or came back garbled), so the label must not claim
// how the model is billed (openclawProviderLabel).
async function openclawPlanOf(primary, reads) {
  if (typeof primary !== "string" || primary.includes("@")) return { plan: null, confirmed: true };
  if (primary.startsWith("anthropic/")) {
    const settings = await reads.settings;
    return { plan: planOfPrimary(primary, settings.value, false), confirmed: settings.confirmed };
  }
  if (primary.startsWith("openai/")) {
    const auth = await reads.signIn;
    return { plan: planOfPrimary(primary, null, auth.signedIn), confirmed: auth.signedIn !== null };
  }
  return { plan: null, confirmed: true };
}

// Hermes and OpenClaw's current model, read through their own `config get`
// (never from their config files). `detected` is the agent's detection result.
// OpenClaw's answer also says which plan it runs on (`plan`), and labels an
// anthropic/ or openai/ model by it; Hermes's answer keeps its shape.
export async function readAgentModel(agentId, detected) {
  if (!detected?.installed) {
    const missing = { agentId, installed: false, provider: null, providerLabel: null, model: null, isPreset: false, presetSlug: null };
    return agentId === "openclaw" ? { ...missing, plan: null } : missing;
  }
  // `ok` says the command ran and answered. A command that failed or timed out has NOT said the value
  // is empty, so it must never read as "no model set" (see `known` below).
  const get = async (args) => {
    const result = await runCommand(detected.path, args, CONFIG_GET_TIMEOUT_MS);
    return result.ok ? { ok: true, value: parseConfigText(result.stdout) } : { ok: false, value: null };
  };
  // `known: false` is added only when the model could not be read (every `config get` for it failed):
  // the answer is then "we do not know", which is not the same as "nothing is set". A readable answer
  // keeps its old shape (no `known` field).
  const withKnown = (info, known) => (known ? info : { ...info, known: false });
  if (agentId === "hermes") {
    // --json prints a plain JSON value; an older Hermes without it prints the bare value.
    const read = async (key) => {
      const first = await get(["config", "get", key, "--json"]);
      if (first.value !== null) return first;
      const second = await get(["config", "get", key]);
      return { ok: first.ok || second.ok, value: second.value };
    };
    const [provider, model] = await Promise.all([read("model.provider"), read("model.default")]);
    return withKnown(describeModel("hermes", provider.value, model.value), model.ok);
  }
  // OpenClaw keeps one "provider/model" reference. Which confirming read is needed
  // depends on that reference, but neither read depends on its value, so both start
  // now, beside the primary read, and only the one that is needed is waited for (the
  // plan status does the same). An unneeded one finishes quietly on its own.
  const reads = { settings: readOpenclawModelsConfigState(detected), signIn: readChatgptAuth(detected) };
  for (const pending of Object.values(reads)) pending.catch(() => {});
  const read = await get(["config", "get", OPENCLAW_MODEL_PATH]);
  const primary = read.value;
  const slash = primary ? primary.indexOf("/") : -1;
  const info = slash > 0 ? describeModel("openclaw", primary.slice(0, slash), primary.slice(slash + 1)) : describeModel("openclaw", null, primary);
  const { plan, confirmed } = await openclawPlanOf(primary, reads);
  return withKnown({ ...info, providerLabel: openclawProviderLabel(info.provider, plan, confirmed) ?? info.providerLabel, plan }, read.ok);
}

// ---- command builders and plain-English helpers (used by jobs.js) -------------------------

// The two commands that give Hermes an OpenRouter model. The id has no
// "openrouter/" prefix (OpenRouter's own routers, like openrouter/auto, already
// carry theirs inside the id).
export function hermesModelCommands(model) {
  return [
    ["config", "set", "model.provider", "openrouter"],
    ["config", "set", "model.default", model]
  ];
}

// OpenClaw names a model "<provider>/<model>".
export function openclawModelRef(model) {
  return `openrouter/${model}`;
}

// A CLI's error text, made short and calm enough for the screen: colour codes
// and OpenClaw's banner line removed, one line, at most `max` characters.
export function cleanCliText(text, max = 240) {
  return (
    String(text ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^OpenClaw \d/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, max)
      .trim()
  );
}

// What `config get` printed for a whole section: JSON, possibly after a banner
// line. null when it isn't JSON (so nothing is guessed from it).
export function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => /^\s*[{[]/.test(line));
    if (start <= 0) return null;
    try {
      return JSON.parse(lines.slice(start).join("\n"));
    } catch {
      return null;
    }
  }
}

function plainName(value) {
  const text = typeof value === "string" ? value : value && typeof value === "object" ? String(value.primary ?? "") : "";
  return /^[A-Za-z0-9._:/@~ -]{1,120}$/.test(text) ? text : "";
}

// Anything in OpenClaw's config that would keep it from using the model we
// just set as its default: an agent with its own `model`, or an allow-list
// that doesn't include it. `entries` / `allow` are what `config get` printed
// for agents.entries and modelPolicy.allow (already parsed). Returns plain
// sentences, never the config itself.
export function openclawOverrideWarnings(entries, allow, ref) {
  const warnings = [];
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const [name, entry] of Object.entries(entries).slice(0, 20)) {
      const own = plainName(entry?.model);
      if (!entry?.model || !/^[A-Za-z0-9._-]{1,60}$/.test(name)) continue;
      warnings.push(`OpenClaw's agent "${name}" has its own model${own ? ` (${own})` : ""}, so it keeps using that instead of the new default.`);
    }
  }
  const allowed = Array.isArray(allow) ? allow.filter((item) => typeof item === "string") : [];
  if (allowed.length && !allowed.includes(ref)) {
    warnings.push(`OpenClaw only allows certain models (modelPolicy.allow) and ${ref} is not on that list, so it may refuse it.`);
  }
  return warnings;
}
