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
  invalid_mode: "Pick OpenRouter or a local model first."
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
  agents?: { hermes: AgentCheckEntry; openclaw: AgentCheckEntry };
  ollama?: ToolProbe;
  network?: NetworkProbe[];
  error?: string;
}

export function getSetupCheck(refresh = false) {
  return request<SystemCheck>(`/api/setup/check${refresh ? "?refresh=1" : ""}`);
}

// ---- plan (GET /api/setup/plan) ------------------------------------------

export type PlanAction = "keep" | "update" | "install" | "prereq-node" | "skip-unsupported";

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
}

export interface SetupPlan {
  steps: SetupPlanStep[];
  warnings: string[];
  manualSteps: { agentId: string; reason: string; command: string }[];
  blocked: { agentId: string; reason: string }[];
}

export function getSetupPlan() {
  return request<SetupPlan>("/api/setup/plan");
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
}

export interface SetupJob {
  id: string;
  kind: "install" | "configure";
  status: JobStatus;
  steps: SetupJobStep[];
  currentStepIndex?: number;
  startedAt: string;
  endedAt: string | null;
  mode?: "openrouter" | "ollama";
  model?: string | null;
  health?: Record<string, HealthEntry>;
  acceptOpenClawRisk?: boolean;
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

// ---- brain (GET /api/setup/brain, models, verify, configure) --------------

export interface BrainOption {
  id: "openrouter" | "ollama";
  available: boolean;
  reason?: string;
}

export interface BrainAgentStatus {
  configured: boolean;
  source: string;
  summary: string;
}

export interface BrainOptionsResponse {
  options: BrainOption[];
  recommendation: "openrouter" | "ollama";
  reason: string;
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

export function getOpenRouterModels() {
  return request<{ models: OpenRouterModel[]; error?: string }>("/api/setup/openrouter/models");
}

export interface VerifyKeyResult {
  ok: boolean;
  error?: string;
  label?: string;
  limit?: number;
}

// The key is sent once, in this one request body, and never again -- see
// SetupBrainPanel.tsx, which clears its own state right after this resolves.
export function verifyOpenRouterKey(apiKey: string) {
  return request<VerifyKeyResult>("/api/setup/openrouter/verify", {
    method: "POST",
    body: JSON.stringify({ apiKey })
  });
}

export function postConfigure(payload: {
  mode: "openrouter" | "ollama";
  model: string;
  apiKey?: string;
  acceptOpenClawRisk?: boolean;
}) {
  return request<SetupJob>("/api/setup/configure", {
    method: "POST",
    body: JSON.stringify({ ...payload, confirm: true })
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
