// The Agents page's pure logic: which agent is selected, the words in the rail and how many runs
// light each agent. `import type` only (decision P14): test/agents-page-logic.test.js loads this
// file straight from src/ and Node strips the types.
import type { AgentSummary, RunMeta } from "../types";
import type { StatusState } from "./components/StatusWord";

// Agent OS's own jobs, not an agent doing work (the same list Home and "Hold to stop all" skip, R14).
const NOT_AGENT_WORK = new Set(["service", "install", "configure", "signin", "pull"]);

// How many agent runs are queued or running, per agent. An unknown list claims nothing.
export function liveCounts(runs: RunMeta[] | null): Record<string, number> {
  const map: Record<string, number> = {};
  if (!runs) return map;
  for (const run of runs) {
    if ((run.status === "running" || run.status === "queued") && run.agentId && !NOT_AGENT_WORK.has(run.kind)) {
      map[run.agentId] = (map[run.agentId] || 0) + 1;
    }
  }
  return map;
}

export type InstallState = "installed" | "missing" | "unknown";

// Only the agents list can say an agent is missing. An agent it does not mention is unknown.
export function installState(agent: AgentSummary | undefined): InstallState {
  if (!agent) return "unknown";
  return agent.detected?.installed ? "installed" : "missing";
}

export interface RailInput {
  // The list has loaded at least once.
  resolved: boolean;
  // Nothing has loaded and the first load failed or timed out.
  gaveUp: boolean;
  agent: AgentSummary | undefined;
  live: number;
}

// The status word beside each agent in the rail.
export function railStatus({ resolved, gaveUp, agent, live }: RailInput): { state: StatusState; label?: string } {
  if (!resolved) return gaveUp ? { state: "unknown" } : { state: "loading" };
  const found = installState(agent);
  if (found === "unknown") return { state: "unknown" };
  if (found === "missing") return { state: "unknown", label: "Not installed" };
  return live > 0 ? { state: "live", label: live > 1 ? `Live ×${live}` : "Live" } : { state: "ready", label: "Installed" };
}

// The version in the rail: "…" while loading, "—" when it is not known.
export function railVersion({ resolved, gaveUp, agent }: Omit<RailInput, "live">): string {
  if (!resolved) return gaveUp ? "—" : "…";
  return installState(agent) === "installed" ? agent?.detected.version || "—" : "—";
}

// The agent to show: the one asked for (?agent=), else the first installed one, else the first.
// An id that is not one of the five (a mistyped address) never leaves the page without a detail.
export function pickAgentId(selected: string, agents: AgentSummary[] | null, order: readonly string[]): string {
  if (order.includes(selected)) return selected;
  const firstInstalled = agents?.find((a) => a.detected?.installed && order.includes(a.id));
  return firstInstalled?.id || order[0];
}
