// Small helpers shared by FleetPage and its Flight log panel — kept in one
// place so both read a run's status/cost/duration the same way.
import type { RunMeta } from "../types";
import type { StatusKind } from "./components/StatusMark";

export const AGENT_MONOGRAM: Record<string, string> = {
  hermes: "H",
  openclaw: "OC",
  claude: "CC",
  codex: "CX",
  cursor: "CU"
};

export function firstLine(text: string | undefined, max = 40) {
  const line = String(text || "").split(/\r?\n/)[0].trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function runStatusMark(status: string): StatusKind {
  if (status === "running" || status === "queued") return "live";
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "timed_out") return "error";
  if (status === "stopped" || status === "interrupted") return "warn";
  return "unknown";
}

export function costLabel(usage?: { costUsd?: number }) {
  return typeof usage?.costUsd === "number" ? `$${usage.costUsd.toFixed(2)}` : "—";
}

export function durationLabel(run: RunMeta) {
  if (!run.startedAt || !run.endedAt) return "—";
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
