// Small shared bits for the "AI brain" screens (Setup and each agent's Brain
// card): which agents there are, how sizes are written, and the one sentence
// on the main button.
import type { BrainAgentId } from "../setupApi";

export interface BrainAgentLine {
  id: BrainAgentId;
  label: string;
  installed: boolean;
  configured: boolean;
}

export const BRAIN_AGENT_IDS: BrainAgentId[] = ["hermes", "openclaw"];

export const BRAIN_AGENT_LABEL: Record<BrainAgentId, string> = { hermes: "Hermes", openclaw: "OpenClaw" };

// The configure job's steps, in words (the job reports ids).
export const CONFIGURE_STEP_LABEL: Record<string, string> = {
  "hermes-brain": "Give Hermes its brain",
  "openclaw-brain": "Give OpenClaw its brain",
  "openclaw-safe-defaults": "OpenClaw safe defaults",
  "hermes-safe-defaults": "Hermes safe defaults check",
  services: "Start background services",
  health: "Say hello to each agent"
};

// The 64K working-memory copy Agent OS adds to Ollama for a local model:
// "qwen3:14b" -> "agentos-qwen3-14b:64k". Same rule as the server; null when
// the result wouldn't be a name Agent OS accepts (for example one with capital
// letters), in which case the server refuses that model.
export function variantNameFor(model: string) {
  const name = `agentos-${model.replace(/[:/]/g, "-")}:64k`;
  return /^[a-z0-9._:-]{1,80}$/.test(name) ? name : null;
}

// 5_200_000_000 -> "5.2 GB". Ollama and ollama.com count in decimal GB (1 GB
// = a billion bytes), so the sizes on screen match the ones they quote.
export function formatGb(bytes: number | null | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  const gb = bytes / 1e9;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

// Same decimal units for download progress: "430 MB" or "3.5 GB".
export function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// "Hermes" / "Hermes and OpenClaw" -> "Give it to Hermes and OpenClaw".
export function giveItTo(labels: string[]) {
  if (!labels.length) return "Give it to an agent";
  return `Give it to ${labels.join(" and ")}`;
}

// 131072 -> "128K" (models quote powers of 1024), 64000 -> "64K" (Hermes's
// own minimum is a round 64,000).
export function formatContext(tokens: number) {
  if (tokens < 1000) return String(tokens);
  return tokens % 1024 === 0 ? `${tokens / 1024}K` : `${Math.round(tokens / 1000)}K`;
}
