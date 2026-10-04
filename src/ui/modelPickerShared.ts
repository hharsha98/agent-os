// Shared shapes and small helpers for the model picker. The picker itself
// (ModelPicker.tsx) knows nothing about Hermes or OpenClaw: what it applies a
// model TO is a list of "targets", and how it applies is a function it is
// given. Hermes and OpenClaw are one such use (agentModelChange.ts); the
// coding agents can be another.
import type { CatalogModel } from "../setupApi";
import { formatContext } from "./brainShared";

// Something a model can be given to.
export interface ModelTarget {
  id: string;
  label: string;
  // Can't be ticked at all (for example "not installed"); `reason` says why.
  disabled?: boolean;
  reason?: string;
  // A plain reason this target can't take THIS model, or null when it can
  // (for example "Hermes needs at least 64K"). Checked for the chosen model.
  blockedFor?: (model: CatalogModel) => string | null;
  // What it uses now, shown next to its tick box.
  current?: string;
  // The target needs OpenRouter connected first (it is not on OpenRouter yet,
  // so it needs the key too); `connectNote` says why in one sentence.
  needsConnection?: boolean;
  connectNote?: string;
  // A tick the person must make before applying WITH a connection.
  ackLabel?: string;
  // A line always shown with this target's result.
  resultNote?: string;
}

// What is being applied: a catalog model, or an OpenRouter preset by name.
export interface ApplySubject {
  // "Big Agent" / "your OpenRouter preset my-agent-brain"
  title: string;
  model?: CatalogModel;
  presetSlug?: string;
  // Shown above the Apply button, always.
  info?: string;
  // Shown in a confirm step before anything happens. Empty = no confirm step.
  notes: string[];
}

// Real progress of one target's job (counts come from the server).
export interface ApplyUpdate {
  targetId: string;
  stepsDone: number;
  stepsTotal: number;
  stepLabel: string;
  startedAt: string;
}

// What happened to one target. ok: true = worked and said hello, false = did
// not work, null = stopped by the person.
export interface ModelApplyResult {
  targetId: string;
  ok: boolean | null;
  headline: string;
  detail?: string;
  warnings?: string[];
  // true when the target's setting really was changed (so the screen should re-read it).
  changed?: boolean;
}

export type ApplyFn = (args: {
  subject: ApplySubject;
  targetIds: string[];
  flowId: string | null;
  ack: boolean;
  signal: AbortSignal;
  onUpdate: (update: ApplyUpdate) => void;
}) => Promise<ModelApplyResult[]>;

export type ModelBadge = "recommended" | "experimental";

export const DEFAULT_BADGE_LABELS: Record<ModelBadge, string> = { recommended: "Recommended", experimental: "Experimental" };

// What the confirm step says about money. Free models need no confirm at all.
export function costNote(model: CatalogModel) {
  const label = model.pricing.label;
  if (label.startsWith("Price varies")) {
    return "This model's price varies: it is a router that picks a model for each request. It uses your OpenRouter credit.";
  }
  if (label.startsWith("Price not listed")) return "OpenRouter doesn't list a price for this model. It may use your OpenRouter credit.";
  return `Paid models use your OpenRouter credit. This one costs ${label}.`;
}

// "2026-12-01" -> "Dec 1, 2026"; anything else is shown as it came.
export function formatRetireDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// 131072 -> "128K", 1000000 -> "1M", 2000000 -> "2M" (formatContext counts in thousands only).
export function formatTokens(tokens: number) {
  if (tokens < 1_000_000) return formatContext(tokens);
  const millions = Math.round((tokens / 1_000_000) * 10) / 10;
  return `${millions}M`;
}

// What the person may paste from OpenRouter's website: an id, or the model's
// whole page address. Returns the id part (the server checks it for real).
export function modelIdFromPaste(text: string) {
  let value = text.trim();
  const page = /^https?:\/\/(?:www\.)?openrouter\.ai\/([^?#\s]+)/i.exec(value);
  if (page) value = page[1].replace(/\/+$/, "");
  return value;
}
