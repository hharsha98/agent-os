// Small shared bits for the coding agents' "brain" screens (Claude Code, Codex
// and Cursor): the words for each mode, how a brain is written in one line, which
// OpenRouter models are "Recommended" for which agent, and how a reset time or a
// cost is shown. Pure functions only.
import { ApiError } from "../api";
import type { BrainMode, BuilderId } from "../buildersApi";
import type { CatalogModel } from "../setupApi";
import { friendlyError as setupFriendlyError } from "../setupApi";
import type { ModelBadge } from "./modelPickerShared";

export const BUILDER_IDS: BuilderId[] = ["claude", "codex", "cursor"];

export function isBuilderId(id: string | null | undefined): id is BuilderId {
  return id === "claude" || id === "codex" || id === "cursor";
}

export const MODE_LABEL: Record<BrainMode, string> = { plan: "Plan", openrouter: "OpenRouter", local: "Local" };

// What "Plan" means for each agent, in the person's words.
export const PLAN_OF: Record<BuilderId, string> = {
  claude: "your Claude plan",
  codex: "your ChatGPT plan",
  cursor: "your Cursor plan"
};

// Cursor's two per-run models (the server's list, with plain names for when it hasn't loaded yet).
export const CURSOR_MODEL_LABEL: Record<string, string> = { "composer-2.5": "Composer 2.5", auto: "Auto" };

// The latest Claude Sonnet, as OpenRouter's always-newest alias (no need to pick a version).
export const CLAUDE_LATEST_ALIAS = "~anthropic/claude-sonnet-latest";

// A coding agent's own instructions and tools take up a lot of the model's
// working memory, so a model with a small window can't do the job at all.
export const CODING_MIN_CONTEXT = 64_000;

// "anthropic/claude-sonnet-4.6" -> "claude-sonnet-4.6" (the whole id stays in a tooltip).
export function shortModel(model: string | null | undefined): string {
  const value = String(model || "");
  return value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
}

export interface BrainWords {
  mode: BrainMode;
  // "Plan" / "OpenRouter" / "Local"
  modeLabel: string;
  // The model's short name, when there is one to show.
  model: string | null;
  // The model as the server knows it (for a tooltip).
  fullModel: string | null;
}

export function describeBrain(agentId: BuilderId, brain: { mode: string; model: string | null } | null | undefined): BrainWords {
  const mode: BrainMode = brain?.mode === "openrouter" || brain?.mode === "local" ? brain.mode : "plan";
  const raw = brain?.model || null;
  let model: string | null = null;
  if (mode !== "plan" && raw) model = mode === "openrouter" ? shortModel(raw) : raw;
  if (mode === "plan" && agentId === "cursor" && raw) model = CURSOR_MODEL_LABEL[raw] || raw;
  return { mode, modeLabel: MODE_LABEL[mode], model, fullModel: raw };
}

// ---- the OpenRouter picker, set up for the coding agents -------------------------------------------

function makerPattern(agentId: BuilderId) {
  return agentId === "codex" ? /^~?openai\//i : /^~?anthropic\//i;
}

// Claude Code works reliably with Claude models; Codex with OpenAI models.
// Everything else is offered, but marked "Experimental".
export function recommendFor(agentId: BuilderId): (model: CatalogModel) => ModelBadge | null {
  const maker = makerPattern(agentId);
  return (model) => (maker.test(model.id) ? "recommended" : "experimental");
}

// Hides models too small to run a coding agent at all (a model whose size isn't listed stays).
export function usableForCoding(model: CatalogModel): boolean {
  return !model.contextLength || model.contextLength >= CODING_MIN_CONTEXT;
}

export function isRecommendedModel(agentId: BuilderId, id: string | null | undefined): boolean {
  return Boolean(id) && makerPattern(agentId).test(String(id));
}

// ---- times and money -----------------------------------------------------------------------------

// "6:50 pm" for a time today, "Oct 9, 3:42 pm" for another day; "" when it isn't a time.
export function formatResetTime(iso: string | undefined | null, now: Date = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .replace(/\s?(AM|PM)$/i, (match) => ` ${match.trim().toLowerCase()}`);
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

// 0.4213 -> "$0.42"
export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// "5" / "$5.5" / "" -> a dollar amount above 0 (and at most 1000), or null.
export function parseBudget(text: string): number | null {
  const n = Number(String(text).trim().replace(/^\$/, ""));
  return Number.isFinite(n) && n > 0 && n <= 1000 ? Math.round(n * 100) / 100 : null;
}

// A failed request, in a sentence a person can use: the one the server wrote
// (the brain refusals are all plain sentences), else the Setup screens' wording
// for its error code, else `fallback`.
export function explain(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error instanceof ApiError && error.detail) return error.detail;
  if (error instanceof TypeError || (error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message))) {
    return "Couldn't reach Agent OS.";
  }
  return setupFriendlyError(error, fallback);
}
