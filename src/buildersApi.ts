// API helpers and types for the coding agents' "brain" (Claude Code, Codex and
// Cursor: their own plan, OpenRouter, or a local model), the saved OpenRouter
// key they use, and "continue after the plan ran out". The shapes are written
// at the top of server/runtime/builders/routes.js, secrets/routes.js and
// runs/routes.js. The OpenRouter key is never returned by any of these routes:
// this file only ever sees whether one is saved, where, and its last 4 characters.
import { request } from "./api";
import type { RunMeta } from "./types";

export type BuilderId = "claude" | "codex" | "cursor";
export type BrainMode = "plan" | "openrouter" | "local";

export interface AgentBrain {
  mode: BrainMode;
  model: string | null;
}

export interface ModeInfo {
  available: boolean;
  // Why a mode can't be used (shown on its disabled segment).
  reason?: string;
  note?: string;
}

export interface CursorModelChoice {
  id: string;
  label: string;
  note?: string;
}

export interface AgentModes {
  plan: ModeInfo;
  openrouter: ModeInfo;
  local: ModeInfo;
  // Cursor only: the models it can be asked for per run.
  models?: CursorModelChoice[];
}

export type OnLimit = "ask" | "auto";

export interface BuilderBrains {
  claude: AgentBrain;
  codex: AgentBrain;
  cursor: AgentBrain;
  onLimit: OnLimit;
  perRunBudgetUsd: number | null;
  modes: Record<BuilderId, AgentModes>;
}

// A change: an agent that is present is replaced as a whole; anything left out keeps its value.
export interface BuilderBrainsPatch {
  claude?: AgentBrain;
  codex?: AgentBrain;
  cursor?: AgentBrain;
  onLimit?: OnLimit;
  perRunBudgetUsd?: number | null;
}

// Other screens that show a brain re-read it when this fires.
export const BRAINS_CHANGED_EVENT = "aos-brains-changed";

export function getBuilderBrains() {
  return request<BuilderBrains>("/api/builders/brains");
}

export async function saveBuilderBrains(patch: BuilderBrainsPatch) {
  const saved = await request<BuilderBrains>("/api/builders/brains", {
    method: "PUT",
    body: JSON.stringify({ ...patch, confirm: true })
  });
  window.dispatchEvent(new Event(BRAINS_CHANGED_EVENT));
  return saved;
}

// ---- the remembered OpenRouter key ---------------------------------------------------------------

export interface OpenRouterKeyStatus {
  stored: boolean;
  // Where the key is (or would go): the macOS Keychain, or a private file.
  backend: "keychain" | "file";
  last4: string | null;
}

export const KEY_CHANGED_EVENT = "aos-openrouter-key-changed";

export function getOpenRouterKeyStatus() {
  return request<OpenRouterKeyStatus>("/api/secrets/openrouter");
}

// Saves the key of a CONNECTED "Connect OpenRouter" sign-in (an id, never the key).
export async function rememberOpenRouterKey(flowId: string) {
  const status = await request<OpenRouterKeyStatus>("/api/secrets/openrouter", {
    method: "POST",
    body: JSON.stringify({ confirm: true, flowId })
  });
  window.dispatchEvent(new Event(KEY_CHANGED_EVENT));
  return status;
}

export async function forgetOpenRouterKey() {
  const status = await request<OpenRouterKeyStatus>("/api/secrets/openrouter", { method: "DELETE" });
  window.dispatchEvent(new Event(KEY_CHANGED_EVENT));
  return status;
}

// ---- carrying on after a plan limit --------------------------------------------------------------

export interface ContinueOption {
  id: string;
  agentId: BuilderId;
  label: string;
  brain: { mode: BrainMode; model: string | null };
  // "fork" carries on the same conversation; "handoff" starts a new run with a summary.
  approach: "fork" | "handoff";
  available: boolean;
  reason?: string;
  // Dollars to START carrying on (reading the old conversation or the summary), or null.
  estimateUsd: number | null;
  estimateTokens: number | null;
  estimateNote: string;
  warnings: string[];
}

export interface ContinueOptions {
  runId: string;
  agentId: string;
  limit: { kind: string; message: string; resetsAt?: string } | null;
  continuedBy: string | null;
  onLimit: OnLimit;
  perRunBudgetUsd: number | null;
  canContinue: boolean;
  unavailableReason?: string;
  auto: { eligible: boolean; optionId: string | null; reason?: string };
  options: ContinueOption[];
}

export function getContinueOptions(runId: string) {
  return request<ContinueOptions>(`/api/runs/${encodeURIComponent(runId)}/continue-options`);
}

export function continueRun(runId: string, target: { agentId: BuilderId; brain: { mode: BrainMode; model?: string | null } }) {
  return request<RunMeta>(`/api/runs/${encodeURIComponent(runId)}/continue`, {
    method: "POST",
    body: JSON.stringify({ confirm: true, target })
  });
}
