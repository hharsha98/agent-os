// Agents: a rail of the five agents grouped Operators and Builders, and the detail of whichever one
// is selected (?agent=<id>, defaulting to the first installed one). Runs are started from Runs
// (New run), not here. Every request has a time limit, so the page says so when Agent OS does not
// answer and comes back by itself; it keeps the last good answer under a note meanwhile.
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { listAgents, listRuns } from "../api";
import { navigateTo, queryParam } from "../nav";
import type { AgentSummary, RunMeta } from "../types";
import { AGENTS_ORDER } from "../ui/agentsShared";
import { liveCounts, pickAgentId } from "../ui/agentsPageShared";
import AgentBay from "../ui/components/AgentBay";
import AgentRail from "../ui/components/AgentRail";
import Banner from "../ui/components/Banner";
import PageHeader from "../ui/components/PageHeader";
import { useBuilderBrains } from "../ui/components/useBuilderBrains";
import { useInterval } from "../ui/components/useInterval";
import { HOME_RUNS_LIMIT, openSessionByAgent, withTimeout } from "../ui/homeShared";
import { useSessionsList } from "../ui/useSessionsList";
import "../ui/agents.css";

const AGENTS_WATCHDOG_MS = 15000;
// /api/agents waits on the agents' own help checks (the server gives each one up to 8 s, after a 5 s
// version check), so the page waits longer than the server does. The same limits as Home.
const AGENTS_TIMEOUT_MS = 15000;
const RUNS_TIMEOUT_MS = 8000;
const BRAINS_TIMEOUT_MS = 8000;

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [agentsTimedOut, setAgentsTimedOut] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  const [selectedId, setSelectedId] = useState(() => queryParam("agent") || "");
  // Which brain Claude Code, Codex and Cursor use (shown in the rail and the bay).
  const { brains, failed: brainsFailed, reload: reloadBrains } = useBuilderBrains(BRAINS_TIMEOUT_MS);
  const alive = useRef(true);
  const agentsNewest = useRef(0);
  const agentsBusy = useRef(false);
  const runsBusy = useRef(false);

  // The newest request wins, and nothing lands after the page is gone.
  async function loadAgents(refresh = false) {
    if (agentsBusy.current && !refresh) return;
    const mine = ++agentsNewest.current;
    agentsBusy.current = true;
    try {
      const { agents: list } = await withTimeout(listAgents(refresh), AGENTS_TIMEOUT_MS);
      if (!Array.isArray(list)) throw new Error("not a list");
      if (!alive.current || mine !== agentsNewest.current) return;
      setAgents(list);
      setAgentsFailed(false);
    } catch {
      if (!alive.current || mine !== agentsNewest.current) return;
      setAgentsFailed(true);
    } finally {
      if (mine === agentsNewest.current) agentsBusy.current = false;
    }
  }

  async function loadRuns() {
    if (runsBusy.current) return;
    runsBusy.current = true;
    try {
      const { runs: list } = await withTimeout(listRuns({ limit: HOME_RUNS_LIMIT }), RUNS_TIMEOUT_MS);
      if (!Array.isArray(list)) throw new Error("not a list");
      if (!alive.current) return;
      setRuns(list);
      setRunsFailed(false);
    } catch {
      // Runs here only drive the rail's "Live" words. The last good list stays, under the same note
      // as a failed agents list, and a failure never blocks the rest of the page.
      if (alive.current) setRunsFailed(true);
    } finally {
      runsBusy.current = false;
    }
  }

  useEffect(() => {
    alive.current = true;
    void loadAgents();
    void loadRuns();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Every 30 s, but every 5 s while Agent OS can't be reached (also while only a stale list is
  // shown), so the page comes back by itself.
  useInterval(() => void loadAgents(), agentsFailed ? 5000 : 30000);
  useInterval(() => {
    void loadRuns();
    if (brainsFailed) void reloadBrains();
  }, 5000);

  // Same watchdog pattern as Home: never stay dim/"Checking…" forever.
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

  const effectiveId = pickAgentId(selectedId, agents, AGENTS_ORDER);
  const liveCountByAgent = useMemo(() => liveCounts(runs), [runs]);

  function selectAgent(id: string) {
    setSelectedId(id);
    navigateTo("agents", { agent: id });
  }

  function retryAll() {
    setLoadAttempt((n) => n + 1);
    void loadAgents(true);
    void loadRuns();
    if (brainsFailed) void reloadBrains();
  }

  const selectedAgent = agents ? agents.find((a) => a.id === effectiveId) : undefined;
  // The shared sessions list (decision Q30): the selected agent's newest open session, for "Open session". Until that
  // list has been read (still loading, or the first read failed) the bay offers neither session button: either one could
  // be the wrong one (sessionsKnown).
  const sessionsList = useSessionsList();
  const openByAgent = openSessionByAgent(sessionsList.source.state === "ok" ? sessionsList.source.data.sessions : []);

  return (
    <section className="os-agents" aria-labelledby="os-agents-title">
      <PageHeader
        titleId="os-agents-title"
        title="Agents"
        lede="Which version each agent runs, which brain it uses, and what keeps it inside the lines."
        actions={
          <button type="button" className="os-btn os-btn--secondary" onClick={retryAll}>
            <RefreshCw size={16} aria-hidden="true" /> Check again
          </button>
        }
      />
      {(agentsFailed || runsFailed) && agents !== null ? (
        <Banner tone="warn" title="Can't reach Agent OS">
          Showing what was last known. This page tries again every few seconds.
        </Banner>
      ) : null}
      <div className="os-agents__body">
        <AgentRail
          agents={agents}
          resolved={agents !== null}
          timedOut={agentsTimedOut && agents === null}
          failed={agentsFailed}
          liveCountByAgent={liveCountByAgent}
          brains={brains}
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
          brains={brains}
          brainsFailed={brainsFailed}
          onBrainsChanged={reloadBrains}
          session={openByAgent[effectiveId] ?? null}
          sessionsAvailable={sessionsList.available}
          sessionsKnown={sessionsList.source.state === "ok"}
        />
      </div>
    </section>
  );
}
