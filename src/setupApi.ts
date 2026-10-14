// API helpers and types for the Setup Assistant and Safety screens. Every
// fetch goes through the shared request() from ./api so 401 session_required
// still fires "agentos:locked" the same way the rest of the app does.
// Nothing here ever stores an API key past the moment it's POSTed (see
// SetupBrainPanel.tsx): this module only shapes requests/responses.
import { request } from "./api";
import type { AgentDetected, AgentServiceStatus } from "./types";

// Server error codes -> plain English. request() throws Error(<server error
// text or code>), so a non-expert never sees "openclaw_risk_not_accepted".
const FRIENDLY_ERRORS: Record<string, string> = {
  openclaw_risk_not_accepted: "Please tick the box that says you understand OpenClaw can act on this computer.",
  job_already_running: "Another setup job is already running. Wait for it to finish, then try again.",
  no_valid_steps: "The plan changed since you opened this page. Go back to Plan and try again.",
  key_required_for_retry: "For your safety Agent OS already forgot your key. Enter it again to retry.",
  invalid_mode: "Pick OpenRouter or a local model first.",
  invalid_model: "Choose a model first.",
  no_targets: "Tick at least one agent first.",
  key_required: "Connect OpenRouter (or paste a key) first.",
  key_unavailable: "That OpenRouter connection was already used or has expired. Connect OpenRouter again.",
  connection_not_ready: "Connect OpenRouter first, then try again.",
  too_many_flows: "Too many sign-ins are already waiting. Cancel one, or wait a few minutes.",
  server_port_unknown: "Agent OS is still starting. Try again in a moment.",
  not_available_here: "Connecting OpenRouter only works in the desktop app on your own computer.",
  local_model_too_big: "That model needs more memory than this computer has to spare. Tick \"Use it anyway\" to try it, or pick another model.",
  invalid_variant_name: "Agent OS can't make its 64K working-memory copy of that model (its name has characters it can't use). Pick another model, or use OpenRouter.",
  invalid_model_id: "That doesn't look like an OpenRouter model ID. It looks like author/model-name, for example anthropic/claude-sonnet-4.6.",
  model_not_found: "OpenRouter doesn't know that model. Check the ID on the model's page.",
  model_too_small_for_hermes: "That model's working memory is too small for Hermes, which needs at least 64K. Pick a bigger model, or give it to OpenClaw.",
  invalid_preset: "A preset name uses only lowercase letters, numbers and dashes, for example my-agent-brain.",
  preset_not_found: "OpenRouter has no preset with that name. Check the name at openrouter.ai/settings/presets.",
  agent_not_installed: "That agent isn't installed on this computer.",
  openrouter_unreachable: "Couldn't reach OpenRouter. Check your internet connection and try again.",
  invalid_flow_id: "That OpenRouter connection isn't valid. Connect OpenRouter again.",
  invalid_catalog_query: "Those search settings aren't valid. Change them and try again.",
  signin_in_progress: "A sign-in is already open for that agent. Finish it in your browser, or cancel it first.",
  signin_not_available_here: "Signing in only works in the desktop app on your own computer."
};

export function friendlyError(error: unknown, fallback = "Something went wrong. Please try again.") {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  return FRIENDLY_ERRORS[message] || message;
}

// A job id is not a secret, so it may live in sessionStorage. That lets a
// reload (or a trip to Home and back) re-attach to a job that is still
// running on the server instead of showing an empty Install step.
const JOB_STORAGE_KEY = { install: "agentos.setup.installJob", configure: "agentos.setup.configureJob" } as const;

export function rememberJobId(kind: "install" | "configure", id: string | null) {
  try {
    if (id) sessionStorage.setItem(JOB_STORAGE_KEY[kind], id);
    else sessionStorage.removeItem(JOB_STORAGE_KEY[kind]);
  } catch {
    // Storage can be blocked; the page just won't re-attach after a reload.
  }
}

export function recallJobId(kind: "install" | "configure") {
  try {
    return sessionStorage.getItem(JOB_STORAGE_KEY[kind]);
  } catch {
    return null;
  }
}

// ---- system check (GET /api/setup/check) --------------------------------

export interface ToolProbe {
  found: boolean;
  path: string;
  version: string;
}

export interface NodeProbe extends ToolProbe {
  nodeOkForOpenClaw: boolean;
  nodeOkForCodex?: boolean;
}

export interface DockerProbe extends ToolProbe {
  running: boolean;
}

export interface NetworkProbe {
  host: string;
  ok: boolean;
  ms: number;
}

export interface AgentCheckEntry {
  detected: AgentDetected;
  service: AgentServiceStatus | null;
}

export interface SystemCheck {
  at: string;
  os: string;
  arch: string;
  osVersion?: string;
  isIntelMac?: boolean;
  ramGb?: number;
  freeDiskGb?: number | null;
  tools?: {
    git: ToolProbe;
    node: NodeProbe;
    python3: ToolProbe;
    uv: ToolProbe;
    docker: DockerProbe;
    brew?: ToolProbe | null;
    xcodeCltInstalled?: boolean | null;
  };
  linuxDistro?: { id: string; idLike: string; versionId: string } | null;
  agents?: {
    hermes: AgentCheckEntry;
    openclaw: AgentCheckEntry;
    claude?: AgentCheckEntry;
    codex?: AgentCheckEntry;
    cursor?: AgentCheckEntry;
  };
  ollama?: ToolProbe;
  network?: NetworkProbe[];
  error?: string;
}

export function getSetupCheck(refresh = false) {
  return request<SystemCheck>(`/api/setup/check${refresh ? "?refresh=1" : ""}`);
}

// ---- plan (GET /api/setup/plan) ------------------------------------------

export type PlanAction = "keep" | "update" | "install" | "prereq-node" | "skip-unsupported";

// "operators" = Hermes and OpenClaw; "coding" = Claude Code, Codex and Cursor.
export type PlanGroup = "operators" | "coding";

export interface SetupPlanStep {
  id: string;
  agentId: string;
  action: PlanAction;
  title: string;
  description: string;
  changes: string[];
  passwordMoments: string[];
  default: boolean;
  sourceUrl: string;
  commandPreview: string | null;
  group?: PlanGroup;
  label?: string;
  license?: string;
  termsUrl?: string | null;
  // "About" figures for an install: disk space in MB and a low-high range in
  // minutes. null when nobody measured them (Hermes, OpenClaw).
  approxMb?: number | null;
  approxMinutes?: [number, number] | null;
  // One plain line about what an install changes (the full list is `changes`).
  summary?: string | null;
  // On a "keep" step: the version that is already there.
  installedVersion?: string;
}

export interface SetupPlan {
  steps: SetupPlanStep[];
  warnings: string[];
  manualSteps: { agentId: string; reason: string; command: string }[];
  blocked: { agentId: string; reason: string }[];
}

export function getSetupPlan(group: PlanGroup | "all" = "operators") {
  return request<SetupPlan>(`/api/setup/plan${group === "operators" ? "" : `?group=${group}`}`);
}

// ---- jobs (install + configure share the same shape) ----------------------

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface SetupJobStep {
  id: string;
  agentId: string | null;
  action: string;
  status: "pending" | "running" | "succeeded" | "failed";
  runIds: string[];
  error: string | null;
  log: string[];
  warnings?: string[];
}

export interface HealthEntry {
  doctorOk: boolean;
  promptOk: boolean;
  replyPreview: string;
  error?: string;
  // A short plain-English next step when the "say hello" check failed.
  hint?: string;
}

export type BrainMode = "openrouter" | "ollama";
export interface BrainTarget {
  mode: BrainMode;
  model: string;
}
export type BrainAgentId = "hermes" | "openclaw";

export interface SetupJob {
  id: string;
  kind: "install" | "configure" | "pull" | "model";
  status: JobStatus;
  steps: SetupJobStep[];
  currentStepIndex?: number;
  startedAt: string;
  endedAt: string | null;
  mode?: BrainMode | "mixed";
  model?: string | null;
  // configure jobs: what each agent was given (null = left alone), and which
  // agents the job was allowed to touch.
  targets?: Record<BrainAgentId, BrainTarget | null>;
  scope?: BrainAgentId[];
  health?: Record<string, HealthEntry>;
  acceptOpenClawRisk?: boolean;
  // pull (download) jobs: the model and REAL byte counts from Ollama.
  pull?: { status: string; completed: number; total: number };
  // configure jobs with a Local brain: the model -> the 64K copy Agent OS
  // added to Ollama (it shares the model's weights, no extra download).
  localVariants?: Record<string, string>;
  acceptLocalFit?: boolean;
  // model jobs (changing one agent's model, or pointing it at a preset): the
  // agent, the OpenRouter preset name when it was one, and what it used before.
  agentId?: BrainAgentId;
  preset?: string | null;
  previous?: { provider: string | null; model: string | null } | null;
}

export function startInstallJob(payload: { steps: string[]; acceptOpenClawRisk?: boolean }) {
  return request<SetupJob>("/api/setup/jobs", {
    method: "POST",
    body: JSON.stringify({ ...payload, confirm: true })
  });
}

export function getSetupJob(id: string) {
  return request<SetupJob>(`/api/setup/jobs/${encodeURIComponent(id)}`);
}

export function cancelSetupJob(id: string) {
  return request<SetupJob>(`/api/setup/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function retrySetupJob(id: string) {
  return request<SetupJob>(`/api/setup/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

// ---- sign in to Claude Code, Codex and Cursor (/api/setup/signin/:agentId) ----------
// The server runs each agent's own login command (it opens the browser) and asks
// the agent itself whether it is signed in. No token ever reaches this page.

export type SignInAgentId = "claude" | "codex" | "cursor";
export type SignInStatus = "signed_in" | "not_signed_in" | "unknown";

export interface SignInRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "stopped" | "timed_out" | "interrupted";
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  // The last few lines the login command printed (long opaque strings hidden).
  lines: string[];
  // A link on the agent's own site, only while the login is open.
  url: string | null;
  needsTerminal: boolean;
  // Plain English for a login that did not finish; null otherwise.
  reason: string | null;
}

export interface SignInInfo {
  agentId: SignInAgentId;
  label: string;
  cost: string;
  installed?: boolean;
  // Absent when the page asked for the run only (status=0).
  status?: SignInStatus;
  note?: string;
  checkedAt?: string;
  run: SignInRun | null;
  // true on macOS, where the server can open Terminal for the person.
  terminalOpener: boolean;
}

export function getSignIn(agentId: SignInAgentId, options: { runOnly?: boolean } = {}) {
  return request<SignInInfo>(`/api/setup/signin/${encodeURIComponent(agentId)}${options.runOnly ? "?status=0" : ""}`);
}

export function startSignInRun(agentId: SignInAgentId) {
  return request<{ run: SignInRun }>(`/api/setup/signin/${encodeURIComponent(agentId)}`, {
    method: "POST",
    body: JSON.stringify({ confirm: true })
  });
}

export function cancelSignInRun(agentId: SignInAgentId) {
  return request<{ run: SignInRun | null }>(`/api/setup/signin/${encodeURIComponent(agentId)}`, { method: "DELETE" });
}

// `opened:false, reason:"copy"` comes with the command, to show and copy.
export function openSignInTerminal(agentId: SignInAgentId) {
  return request<{ opened: boolean; command: string; reason?: string }>(
    `/api/setup/signin/${encodeURIComponent(agentId)}/terminal`,
    { method: "POST", body: JSON.stringify({ confirm: true }) }
  );
}

// ---- brain (GET /api/setup/brain, models, verify, configure) --------------

export interface BrainOption {
  id: "openrouter" | "ollama";
  available: boolean;
  reason?: string;
}

export interface BrainAgentStatus {
  installed?: boolean;
  configured: boolean;
  source: string;
  summary: string;
}

export interface BrainOptionsResponse {
  options: BrainOption[];
  recommendation: "openrouter" | "ollama";
  reason: string;
  localModel?: string | null;
  current: { hermes: BrainAgentStatus; openclaw: BrainAgentStatus };
  defaults: { hermes: "keep" | "configure"; openclaw: "keep" | "configure" };
}

export function getBrainOptions(refresh = false) {
  return request<BrainOptionsResponse>(`/api/setup/brain${refresh ? "?refresh=1" : ""}`);
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number;
}

export interface OpenRouterModelsResponse {
  models: OpenRouterModel[];
  // The id the server suggests pre-selecting (see pickRecommendedFreeModel).
  recommended?: string | null;
  error?: string;
}

export function getOpenRouterModels() {
  return request<OpenRouterModelsResponse>("/api/setup/openrouter/models");
}

export interface VerifyKeyResult {
  ok: boolean;
  error?: string;
  label?: string;
  limit?: number;
  isFreeTier?: boolean;
}

// ---- one-click OpenRouter sign-in (OAuth) -----------------------------------
// The server opens the person's normal browser and keeps the key in memory.
// The screen only ever sees a flow id and a status -- never the key.

export interface OpenRouterConnectStart {
  flowId: string;
  authUrl: string;
  status: "waiting";
  // false when the server couldn't open a browser; the screen then shows the
  // "Open the sign-in page" link prominently.
  opened: boolean;
}

export type OpenRouterConnectStatus = "waiting" | "connected" | "failed" | "expired" | "cancelled";

export interface OpenRouterConnectState {
  status: OpenRouterConnectStatus;
  error?: string;
  info?: { label?: string; isFreeTier?: boolean; limit?: number };
}

export function startOpenRouterConnect() {
  return request<OpenRouterConnectStart>("/api/setup/openrouter/connect", {
    method: "POST",
    body: JSON.stringify({ confirm: true })
  });
}

export function getOpenRouterConnect(flowId: string) {
  return request<OpenRouterConnectState>(`/api/setup/openrouter/connect/${encodeURIComponent(flowId)}`);
}

export function cancelOpenRouterConnect(flowId: string) {
  return request<OpenRouterConnectState>(`/api/setup/openrouter/connect/${encodeURIComponent(flowId)}`, {
    method: "DELETE"
  });
}

// ---- local models (Ollama) ----------------------------------------------------

export type LocalVerdictId = "good" | "too_small" | "no_tools" | "unknown";

export type LocalFit = "comfortable" | "tight" | "too_big" | "unknown";

// What the model needs at 64K of working memory, worked out by the server from
// the model's own numbers (weights + KV cache + a little overhead).
export interface LocalMemory {
  memoryAt64kGb: number | null;
  fit: LocalFit;
  // What the model was trained for; `stretched` = 64K is past that.
  nativeContext: number | null;
  stretched: boolean;
}

export interface LocalModel {
  name: string;
  sizeBytes: number | null;
  parameterSize: string;
  contextLength: number | null;
  verdict: { id: LocalVerdictId; label: string; selectable: boolean };
  memory: LocalMemory;
}

export interface LocalDownloadAdvice {
  minMemoryGb: number;
  model: string;
  downloadGb: number;
  nativeContext: number;
  memoryAt64kGb: number;
  installed: boolean;
}

export interface LocalBrainSummary {
  available: boolean;
  reason: string;
  memoryGb: number;
  models: LocalModel[];
  download: LocalDownloadAdvice | null;
  downloadAdvice: string;
}

export function getOllamaModels(refresh = false) {
  return request<LocalBrainSummary>(`/api/setup/ollama/models${refresh ? "?refresh=1" : ""}`);
}

// A download is large, so the server requires confirm:true; the screen only
// sends it after the person has seen the size and pressed Download.
export function startOllamaDownload(model: string) {
  return request<SetupJob>("/api/setup/ollama/pull", {
    method: "POST",
    body: JSON.stringify({ model, confirm: true })
  });
}

// The key is sent once, in this one request body, and never again -- see
// SetupBrainPanel.tsx, which clears its own state right after this resolves.
export function verifyOpenRouterKey(apiKey: string) {
  return request<VerifyKeyResult>("/api/setup/openrouter/verify", {
    method: "POST",
    body: JSON.stringify({ apiKey })
  });
}

// `targets` gives each ticked agent its own brain (an agent left out is not
// touched). The key comes from `keySource` (a connected sign-in, used once by
// the server) or `apiKey` (the "use an existing key" path, sent once).
export function postConfigure(payload: {
  targets: Partial<Record<BrainAgentId, BrainTarget>>;
  keySource?: { flowId: string };
  apiKey?: string;
  acceptOpenClawRisk?: boolean;
  // Only true when the person ticked "Use it anyway" for a local model that is
  // too big for this computer. The server works out the fit itself anyway.
  acceptLocalFit?: boolean;
}) {
  return request<SetupJob>("/api/setup/configure", {
    method: "POST",
    body: JSON.stringify({ ...payload, confirm: true })
  });
}

// ---- the model catalog and changing one agent's model --------------------------

// One OpenRouter model as the picker shows it. The server works out the price
// sentence (`pricing.label`) and whether Hermes can use it, so the screen
// never has to guess.
export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  maxCompletionTokens: number | null;
  created: number | null;
  isNew: boolean;
  inputModalities: string[];
  // The day OpenRouter retires it (YYYY-MM-DD), when it has announced one.
  expiresAt: string | null;
  pricing: { promptPerM: number | null; completionPerM: number | null; label: string };
  free: boolean;
  rateLimitedFree: boolean;
  hermesOk: boolean;
  pageUrl: string;
}

export type CatalogSort = "agentic-high-to-low" | "newest" | "pricing-low-to-high" | "context-high-to-low";

export interface CatalogResponse {
  models: CatalogModel[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  // "account" = narrowed to what the connected OpenRouter account may use.
  source: "public" | "account";
  keyRejected?: boolean;
  error?: string;
}

// `flowId` is a connected OpenRouter sign-in (an id, never the key): the
// server then narrows the list to the models that account may use.
export function getModelCatalog(params: { free: "only" | "all"; sort: CatalogSort; q: string; offset: number; limit?: number; flowId?: string | null }) {
  const query = new URLSearchParams({
    tools: "1",
    free: params.free,
    sort: params.sort,
    offset: String(params.offset),
    limit: String(params.limit ?? 50)
  });
  if (params.q.trim()) query.set("q", params.q.trim());
  if (params.flowId) query.set("flowId", params.flowId);
  return request<CatalogResponse>(`/api/setup/openrouter/models?${query.toString()}`);
}

// One model by its id (what the person copies from OpenRouter's website).
export function lookupOpenRouterModel(id: string) {
  return request<{ ok: true; model: CatalogModel }>(`/api/setup/openrouter/models/lookup?id=${encodeURIComponent(id)}`);
}

// Which model an agent uses right now, read from the agent itself.
export interface AgentModelInfo {
  agentId: BrainAgentId;
  installed: boolean;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  isPreset: boolean;
  presetSlug: string | null;
}

export function getAgentModel(agentId: BrainAgentId) {
  return request<AgentModelInfo>(`/api/setup/agents/${encodeURIComponent(agentId)}/model`);
}

// The server decides what a change needs: an agent already on OpenRouter only
// changes its model; one on Local (or with no brain) also needs a connected
// sign-in (`keySource`) and, for OpenClaw, `acceptOpenClawRisk`.
interface AgentChangeExtras {
  keySource?: { flowId: string };
  acceptOpenClawRisk?: boolean;
}

export function applyAgentModel(agentId: BrainAgentId, payload: { model: string } & AgentChangeExtras) {
  return request<SetupJob>(`/api/setup/agents/${encodeURIComponent(agentId)}/model`, {
    method: "POST",
    body: JSON.stringify({ ...payload, confirm: true })
  });
}

export function applyAgentPreset(agentId: BrainAgentId, payload: { slug: string } & AgentChangeExtras) {
  return request<SetupJob>(`/api/setup/agents/${encodeURIComponent(agentId)}/preset`, {
    method: "POST",
    body: JSON.stringify({ ...payload, confirm: true })
  });
}

// Opens an OpenRouter page in the person's own browser (the server does it,
// and only for OpenRouter's addresses). `opened:false` comes with the address,
// so the screen can show it as a link instead.
export interface OpenPageResult {
  opened: boolean;
  url: string;
  reason?: string;
}

// No id: OpenRouter's model list. With one: that model's page.
export function openOpenRouterModels(id?: string) {
  return request<OpenPageResult>("/api/setup/openrouter/models/open", {
    method: "POST",
    body: JSON.stringify({ confirm: true, ...(id ? { id } : {}) })
  });
}

export function openOpenRouterPresets(createNew = false) {
  return request<OpenPageResult>("/api/setup/openrouter/presets/open", {
    method: "POST",
    body: JSON.stringify({ confirm: true, ...(createNew ? { new: true } : {}) })
  });
}

// A tiny model name/size heuristic per the design brief: never a hard
// rule, just a plain-English nudge before the user commits to a small model.
export function isLikelySmallModel(name: string, sizeBytes?: number) {
  if (/(:1b|:2b|:3b|0\.5b)/i.test(name)) return true;
  if (typeof sizeBytes === "number" && sizeBytes > 0 && sizeBytes < 4 * 1024 ** 3) return true;
  return false;
}

// ---- receipt (GET /api/setup/receipt) --------------------------------------

export interface ReceiptEntry {
  at: string;
  agentId: string;
  action: string;
  version: string;
  sourceUrl: string;
  installerSha256: string;
  provider: string;
  model: string;
  changes: string[];
  uninstall: string[];
}

export function getReceipt() {
  return request<{ receipt: ReceiptEntry[] }>("/api/setup/receipt");
}

// ---- machine control (GET/POST /api/admin/machine-control) -----------------
// getExecutionGateStatus/updateExecutionGate already live in ./api; only the
// machine-control endpoints are new here.

export interface MachineControlStatus {
  armed: boolean;
  expiresAt: string | null;
  supported: boolean;
  remainingMs: number;
}

export function getMachineControlStatus() {
  return request<MachineControlStatus>("/api/admin/machine-control");
}

export function setMachineControlStatus(payload: { enable: boolean; phrase?: string; confirm?: boolean }) {
  return request<MachineControlStatus>("/api/admin/machine-control", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// ---- agent safety detail (GET /api/agents/:id) ------------------------------

export interface AgentSafetyAction {
  id: string;
  label: string;
  description: string;
}

export interface AgentSafetyStatus {
  permissive: boolean;
  summary: string;
  actions: AgentSafetyAction[];
  // false when Agent OS could not read the setting (the read failed, timed out or printed
  // nothing): `permissive` is then not a finding and screens show "—". Absent from older servers.
  known?: boolean;
}

export interface AgentDetail {
  detected: AgentDetected;
  config: { ok: boolean; summary: string; problems: string[]; fixHint?: string };
  safety: AgentSafetyStatus;
  service: AgentServiceStatus | null;
}

export function getAgentDetail(id: string) {
  return request<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`);
}
