// Agents screen ("the hangar"): a master-detail rail of the five agents and
// a detail "bay" for whichever one is selected (?agent=<id>, defaulting to
// the first installed one). See specs/W7c-agents-runs.md.
import { useEffect, useMemo, useState } from "react";
import { getExecutionGateStatus, listAgents, listRuns } from "../api";
import { navigateTo, queryParam } from "../nav";
import type { AgentSummary, ExecutionGateStatus, RunMeta } from "../types";
import { AGENTS_ORDER } from "../ui/agentsShared";
import AgentBay from "../ui/components/AgentBay";
import AgentRail from "../ui/components/AgentRail";
import { useInterval } from "../ui/components/useInterval";
import "../ui/agents.css";

const AGENTS_WATCHDOG_MS = 15000;

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [agentsTimedOut, setAgentsTimedOut] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [gateFailed, setGateFailed] = useState(false);
  const [selectedId, setSelectedId] = useState(() => queryParam("agent") || "");

  async function loadAgents(refresh = false) {
    try {
      const { agents: list } = await listAgents(refresh);
      setAgents(list);
      setAgentsFailed(false);
    } catch {
      setAgentsFailed(true);
    }
  }

  async function loadRuns() {
    try {
      const { runs: list } = await listRuns({ limit: 50 });
      setRuns(list);
    } catch {
      // Runs here only drive the rail's "Running ×N" counts; a failure just
      // leaves those at 0 rather than blocking the whole screen.
    }
  }

  async function loadGate() {
    try {
      setGate(await getExecutionGateStatus());
      setGateFailed(false);
    } catch {
      // Keep the last known gate (if any) so a blip doesn't flip the Launch
      // panel to "unknown"; only a never-loaded gate shows the error state.
      setGateFailed(true);
    }
  }

  useEffect(() => {
    void loadAgents();
    void loadRuns();
    void loadGate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useInterval(() => void loadAgents(), 30000);
  useInterval(() => void loadRuns(), 5000);
  useInterval(() => void loadGate(), 15000);

  // Same watchdog pattern as FleetPage: never stay dim/"Checking…" forever.
  useEffect(() => {
    if (agents !== null) {
      setAgentsTimedOut(false);
      return undefined;
    }
    const id = setTimeout(() => setAgentsTimedOut(true), AGENTS_WATCHDOG_MS);
    return () => clearTimeout(id);
  }, [agents, loadAttempt]);

  useEffect(() => {
    function sync() {
      setSelectedId(queryParam("agent") || "");
    }
    window.addEventListener("aos-navigate", sync);
    return () => window.removeEventListener("aos-navigate", sync);
  }, []);

  const defaultAgentId = useMemo(() => {
    if (!agents) return AGENTS_ORDER[0];
    return agents.find((a) => a.detected.installed)?.id || AGENTS_ORDER[0];
  }, [agents]);
  const effectiveId = selectedId || defaultAgentId;

  const liveCountByAgent = useMemo(() => {
    const map: Record<string, number> = {};
    if (runs) {
      for (const run of runs) {
        if (run.status === "running" && run.agentId) map[run.agentId] = (map[run.agentId] || 0) + 1;
      }
    }
    return map;
  }, [runs]);

  function selectAgent(id: string) {
    setSelectedId(id);
    navigateTo("agents", { agent: id });
  }

  function retryAll() {
    setLoadAttempt((n) => n + 1);
    void loadAgents(true);
    void loadRuns();
    void loadGate();
  }

  const selectedAgent = agents ? agents.find((a) => a.id === effectiveId) : undefined;

  return (
    <div className="os-agents aos-phase-page">
      <header className="os-agents__header">
        <span className="os-micro">AGENT OS · HANGAR</span>
        <h1>Agents</h1>
      </header>
      <div className="os-agents__body">
        <AgentRail
          agents={agents}
          resolved={agents !== null}
          timedOut={agentsTimedOut && agents === null}
          failed={agentsFailed}
          liveCountByAgent={liveCountByAgent}
          selectedId={effectiveId}
          onSelect={selectAgent}
          onRetry={retryAll}
        />
        <AgentBay
          agentId={effectiveId}
          agent={selectedAgent}
          agentsResolved={agents !== null}
          agentsFailed={agentsFailed}
          onRetryAgents={retryAll}
          liveCount={liveCountByAgent[effectiveId] || 0}
          gate={gate}
          gateFailed={gateFailed}
          onReloadGate={loadGate}
          onRecheckAgents={() => loadAgents(true)}
          onRunLaunched={(run) => navigateTo("runs", { run: run.id })}
        />
      </div>
    </div>
  );
}
