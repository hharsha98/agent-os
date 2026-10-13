// Home's pure logic: what lights the Orbit, each agent's status line, the lede,
// the recent activity rows and today's spend. `import type` only (decision P14):
// the logic test loads this file straight from src/ and Node strips the types.
import type { AgentModelInfo } from "../setupApi";
import type { AgentSummary, RunMeta } from "../types";
import type { StatusState } from "./components/StatusWord";

export const HOME_AGENTS = [
  { id: "hermes", name: "Hermes Agent", maker: "Nous Research", role: "operator" },
  { id: "openclaw", name: "OpenClaw", maker: "Open source", role: "operator" },
  { id: "claude", name: "Claude Code", maker: "Anthropic", role: "builder" },
  { id: "codex", name: "Codex CLI", maker: "OpenAI", role: "builder" },
  { id: "cursor", name: "Cursor Agent", maker: "Cursor", role: "builder" }
] as const;
export type HomeAgentId = (typeof HOME_AGENTS)[number]["id"];
export type OrbitStates = Partial<Record<HomeAgentId, "live" | "waiting">>;

// A value the page loads: still loading, loaded, or Agent OS could not be reached.
// `stale` marks the last good data when a later refresh failed (it is shown, but
// Home says it can't reach Agent OS, so nobody mistakes it for live).
export type Source<T> = { state: "loading" } | { state: "ok"; data: T; stale?: boolean } | { state: "error"; message: string };

export function loaded<T>(data: T): Source<T> {
  return { state: "ok", data };
}

// A refresh failed. After a good load the last good data is kept (honest, stale
// data beats wiping the page); before one it is an error.
export function failedLoad<T>(prev: Source<T>, message: string): Source<T> {
  return prev.state === "ok" ? { ...prev, stale: true } : { state: "error", message };
}

export function isUnreachable(source: Source<unknown>): boolean {
  return source.state === "error" || (source.state === "ok" && Boolean(source.stale));
}

// How often Home refreshes the agents list: every 30 s, but every 5 s while Home
// can't reach Agent OS, so the page recovers quickly. "Can't reach" includes stale
// data (a refresh failed after a good load), not only a first load that failed.
export function agentsPollMs(agents: Source<unknown>): number {
  return isUnreachable(agents) ? 5000 : 30000;
}

// How many of the newest runs Home reads. One list feeds the Orbit, the status
// lines, Recent activity and Spend today, so it is generous: a busy day of Setup
// jobs, gateway restarts and Team Room turns must not push a long agent run out.
// ("Hold to stop all" reads up to 1000 (stopAll.ts MAX_RUNS) for its own job.)
export const HOME_RUNS_LIMIT = 200;

// True when the list came back full: runs older than its oldest may exist.
export function listIsFull(runs: RunMeta[]): boolean {
  return runs.length >= HOME_RUNS_LIMIT;
}

// Hermes and OpenClaw's model lookup: it answered, or it failed or timed out.
export type ModelLookup = { state: "ok"; info: AgentModelInfo } | { state: "failed" };

export type OperatorBrain =
  | { kind: "loading" }
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "set"; label: string; model: string | null };

// What the Brain cell of an operator says. "Not set" is only for a lookup that
// worked and found neither a provider nor a model; a failed lookup is unknown.
export function operatorBrain(lookup: ModelLookup | undefined): OperatorBrain {
  if (!lookup) return { kind: "loading" };
  if (lookup.state === "failed") return { kind: "unknown" };
  const { providerLabel, model } = lookup.info;
  if (!providerLabel && !model) return { kind: "none" };
  return { kind: "set", label: providerLabel || "Model", model: model || null };
}

const ACTIVE = new Set(["queued", "running"]);
// Agent OS's own jobs: the same list "Hold to stop all" skips (ruling R14).
const NOT_AGENT_WORK = new Set(["service", "install", "configure", "signin", "pull"]);
const NAME: Record<string, string> = Object.fromEntries(HOME_AGENTS.map((a) => [a.id, a.name]));
const isHomeAgent = (id: string | null): id is HomeAgentId => Boolean(id && id in NAME);

export function isAgentWork(run: Pick<RunMeta, "kind">): boolean {
  return !NOT_AGENT_WORK.has(run.kind);
}

// The newest live agent run per agent (the list comes newest first).
export function liveRunsByAgent(runs: RunMeta[]): Partial<Record<HomeAgentId, RunMeta>> {
  const out: Partial<Record<HomeAgentId, RunMeta>> = {};
  for (const run of runs) {
    if (isHomeAgent(run.agentId) && isAgentWork(run) && ACTIVE.has(run.status) && !out[run.agentId]) out[run.agentId] = run;
  }
  return out;
}

// The newest agent run per agent, live or not.
export function lastRunsByAgent(runs: RunMeta[]): Partial<Record<HomeAgentId, RunMeta>> {
  const out: Partial<Record<HomeAgentId, RunMeta>> = {};
  for (const run of runs) {
    if (isHomeAgent(run.agentId) && isAgentWork(run) && !out[run.agentId]) out[run.agentId] = run;
  }
  return out;
}

// A line lights only while that agent works. "waiting" (amber) arrives with SP4.
export function orbitStates(runs: RunMeta[]): OrbitStates {
  const out: OrbitStates = {};
  for (const id of Object.keys(liveRunsByAgent(runs)) as HomeAgentId[]) out[id] = "live";
  return out;
}

function namesOf(states: OrbitStates): string[] {
  return HOME_AGENTS.filter((a) => states[a.id]).map((a) => a.name);
}

// `runsKnown` is false until the runs list has loaded once: then nothing is claimed.
export function orbitLabel(states: OrbitStates, runsKnown: boolean): string {
  const lit = namesOf(states);
  const what = !runsKnown
    ? "What each agent is doing is not known right now."
    : lit.length
      ? `Working now: ${lit.join(", ")}.`
      : "No agent is working right now.";
  return `Agent OS at the centre with five agents around it. ${what}`;
}

// SP4 brings the sentence "Amber means it needs you." back, once a line can be amber.
export function orbitNote(_states: OrbitStates): string {
  return "A line lights only while that agent works.";
}

export function elapsedLabel(fromIso: string | null | undefined, now: number): string {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from) || now < from) return "—";
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return "under 1 m";
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

export interface AgentLine {
  state: StatusState;
  label?: string;
  where: string;
}

export function agentLine(input: {
  agents: "loading" | "ok" | "error";
  // The runs list: until it has loaded, Home can't say what an agent is doing.
  runs: "loading" | "ok" | "error";
  summary?: AgentSummary;
  live?: RunMeta;
  last?: RunMeta;
  now: number;
}): AgentLine {
  if (input.agents === "loading") return { state: "loading", where: "" };
  if (input.agents === "error") return { state: "unknown", where: "Can't reach Agent OS" };
  if (!input.summary?.detected.installed) return { state: "unknown", label: "Not installed", where: "Install it from Setup" };
  if (input.runs === "loading") return { state: "loading", where: "" };
  if (input.runs === "error") return { state: "unknown", where: "Can't tell if it's working" };
  if (input.live) {
    // The elapsed time comes first, so a long task is what the cell cuts off, and
    // the line never starts or ends with a bare separator.
    const task = [input.live.task?.line, input.live.title].map((text) => (text || "").trim()).find(Boolean) ?? "";
    const elapsed = elapsedLabel(input.live.startedAt || input.live.createdAt, input.now);
    return { state: "live", where: [elapsed === "—" ? "" : elapsed, task].filter(Boolean).join(" · ") };
  }
  const last = input.last;
  if (last && last.limit && !last.continuedBy && !ACTIVE.has(last.status)) return { state: "held", where: "Plan limit reached" };
  return { state: "ready", where: "Nothing running" };
}

function joinNames(list: string[]): string {
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// `runsKnown` is false until the runs list has loaded once. Then the lede says only
// what it knows (how many agents are installed), never "nothing is running".
export function homeLede(input: { agents: Source<AgentSummary[]>; states: OrbitStates; runsKnown: boolean }): string {
  if (input.agents.state === "loading") return "Checking your agents…";
  if (input.agents.state === "error") return "Can't reach Agent OS right now. This page tries again every few seconds.";
  const lit = namesOf(input.states);
  if (lit.length) return `${joinNames(lit)} ${lit.length === 1 ? "is" : "are"} working.`;
  const installed = input.agents.data.filter((a) => isHomeAgent(a.id) && a.detected.installed).length;
  if (installed === 0) return "No agents are installed yet. Setup installs them.";
  const count = installed === 5 ? "All five are installed." : `${installed} of 5 agents are installed.`;
  return input.runsKnown ? `${count} Nothing is running right now.` : count;
}

export function activityRuns(runs: RunMeta[], max: number): RunMeta[] {
  return runs.filter(isAgentWork).slice(0, max);
}

// "No runs yet" is true only when the list shows no agent run AND the list is not
// full (a full list may hide older agent runs behind a pile of Setup jobs).
export function noRunsYet(runs: RunMeta[]): boolean {
  return activityRuns(runs, 1).length === 0 && !listIsFull(runs);
}

// Known costs of runs that started today (this computer's day). "—" when none is
// known: only Claude Code and OpenClaw report a cost. A "+" follows the total when
// the list came back full and even its oldest run is from today: more of today's
// runs may lie beyond it.
export function spendToday(runs: RunMeta[], now: number): string {
  const day = new Date(now).toDateString();
  let total = 0;
  let known = false;
  for (const run of runs) {
    const started = run.startedAt ? new Date(run.startedAt) : null;
    if (!started || started.toDateString() !== day || typeof run.usage?.costUsd !== "number") continue;
    total += run.usage.costUsd;
    known = true;
  }
  if (!known) return "—";
  const oldest = Math.min(...runs.map((run) => Date.parse(run.createdAt)).filter(Number.isFinite));
  const more = listIsFull(runs) && Number.isFinite(oldest) && new Date(oldest).toDateString() === day;
  return `$${total.toFixed(2)}${more ? "+" : ""}`;
}

// A request that does not answer in time fails, so the page shows "offline"
// instead of loading for ever (Review Focus 5).
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Agent OS did not answer in time.")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
