import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getAgentService, listAgents, listRuns, useRunStream } from "../api";
import type { AgentServiceStatus, AgentSummary, RunMeta } from "../types";
import ActivityTrace, { emptyBuckets } from "../ui/components/ActivityTrace";
import Panel from "../ui/components/Panel";
import Readout from "../ui/components/Readout";
import RelativeTime, { agoLabel } from "../ui/components/RelativeTime";
import StatusMark, { type StatusKind } from "../ui/components/StatusMark";
import { useInterval } from "../ui/components/useInterval";
import "../ui/fleet.css";

// Fixed order, per the design brief's "mixing desk" layout.
const FLEET_ORDER = ["hermes", "openclaw", "claude", "codex", "cursor"];
const AGENT_ROLE: Record<string, string> = {
  hermes: "Autonomous general agent",
  openclaw: "Always-on assistant",
  claude: "Coding agent",
  codex: "Coding agent",
  cursor: "Coding agent"
};
const SERVICE_AGENTS = new Set(["hermes", "openclaw"]);

function platformLabel() {
  const platform = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";
  if (/mac/i.test(platform)) return "THIS MAC";
  if (/win/i.test(platform)) return "THIS PC";
  if (/linux/i.test(platform)) return "THIS LINUX MACHINE";
  return "THIS COMPUTER";
}

function firstLine(text: string | undefined, max = 40) {
  const line = String(text || "").split(/\r?\n/)[0].trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function parsePid(text: string | undefined) {
  const match = String(text || "").match(/\bPID[:\s]+(\d+)/i);
  return match ? match[1] : null;
}

function runStatusMark(status: string): StatusKind {
  if (status === "running" || status === "queued") return "live";
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "timed_out") return "error";
  if (status === "stopped" || status === "interrupted") return "warn";
  return "unknown";
}

function costLabel(usage?: { costUsd?: number }) {
  return typeof usage?.costUsd === "number" ? `$${usage.costUsd.toFixed(2)}` : "—";
}

function isToday(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// Drives one card's 60-second trace from that agent's live run stream:
// counts real events into the current second's bucket, scrolls the window
// once a second while live, and reports a throttled "pulse" tick for the
// card's status mark. No live run -> buckets stay flat and untouched.
function useAgentActivity(runId: string | null) {
  const { events } = useRunStream(runId);
  const [buckets, setBuckets] = useState<number[]>(emptyBuckets);
  const [pulseKey, setPulseKey] = useState(0);
  const lastPulseRef = useRef(0);
  const processedRef = useRef(0);

  useEffect(() => {
    setBuckets(emptyBuckets());
    processedRef.current = 0;
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    const id = setInterval(() => {
      setBuckets((prev) => [...prev.slice(1), 0]);
    }, 1000);
    return () => clearInterval(id);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    const freshCount = events.length - processedRef.current;
    if (freshCount <= 0) return;
    processedRef.current = events.length;
    setBuckets((prev) => {
      const next = prev.slice();
      next[next.length - 1] += freshCount;
      return next;
    });
    const now = Date.now();
    if (now - lastPulseRef.current >= 250) {
      lastPulseRef.current = now;
      setPulseKey((k) => k + 1);
    }
  }, [events, runId]);

  return { buckets, pulseKey };
}

export default function FleetPage() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  const [services, setServices] = useState<Record<string, AgentServiceStatus | null>>({});
  const [servicesChecked, setServicesChecked] = useState(false);

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
      setRunsFailed(false);
    } catch {
      setRunsFailed(true);
    }
  }

  async function loadServices() {
    const entries = await Promise.all(
      [...SERVICE_AGENTS].map(async (id): Promise<[string, AgentServiceStatus | null]> => {
        try {
          return [id, await getAgentService(id)];
        } catch {
          return [id, null];
        }
      })
    );
    setServices(Object.fromEntries(entries));
    setServicesChecked(true);
  }

  useEffect(() => {
    void loadAgents();
    void loadRuns();
    void loadServices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useInterval(() => void loadAgents(), 30000);
  useInterval(() => void loadRuns(), 5000);
  useInterval(() => void loadServices(), 20000);

  const runsToday = useMemo(() => (runs ? runs.filter((r) => isToday(r.createdAt)) : []), [runs]);
  const spendToday = useMemo(() => {
    const reporting = runsToday.filter((r) => typeof r.usage?.costUsd === "number");
    if (reporting.length === 0) return null;
    return reporting.reduce((sum, r) => sum + (r.usage.costUsd || 0), 0);
  }, [runsToday]);

  const installedCount = agents ? agents.filter((a) => a.detected.installed).length : null;
  const gatewaysCount = Object.values(services).filter((s) => s?.running).length;

  const liveCountByAgent = useMemo(() => {
    const map: Record<string, number> = {};
    if (runs) {
      for (const run of runs) {
        if (run.status !== "running" || !run.agentId) continue;
        map[run.agentId] = (map[run.agentId] || 0) + 1;
      }
    }
    return map;
  }, [runs]);

  const liveRunByAgent = useMemo(() => {
    const map: Record<string, RunMeta> = {};
    if (runs) {
      for (const run of runs) {
        if (run.status === "running" && run.agentId && !map[run.agentId]) map[run.agentId] = run;
      }
    }
    return map;
  }, [runs]);

  const lastRunByAgent = useMemo(() => {
    const map: Record<string, RunMeta> = {};
    if (runs) {
      for (const run of runs) {
        if (run.agentId && !map[run.agentId]) map[run.agentId] = run;
      }
    }
    return map;
  }, [runs]);

  const recentRuns = runs ? runs.slice(0, 5) : null;

  function retryAll() {
    void loadAgents(true);
    void loadRuns();
    void loadServices();
  }

  if (agentsFailed && runsFailed) {
    return (
      <div className="os-fleet aos-phase-page">
        <div className="os-fleet__banner">
          <AlertTriangle size={16} />
          <span>Agent OS isn&apos;t responding.</span>
          <button className="os-btn os-btn--secondary" onClick={retryAll}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="os-fleet aos-phase-page">
      <header className="os-fleet__header">
        <span className="os-micro">AGENT OS · {platformLabel()}</span>
        <h1>Your agent fleet</h1>
        <p>Real state for every agent on this machine — nothing here is simulated for the view.</p>
      </header>

      {agentsFailed || runsFailed ? (
        <div className="os-fleet__banner">
          <AlertTriangle size={16} />
          <span>Agent OS isn&apos;t responding.</span>
          <button className="os-btn os-btn--secondary" onClick={retryAll}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : null}

      <div className="os-fleet__readouts">
        <Readout label="Installed" value={agents ? `${installedCount}/5` : "—"} muted={!agents} />
        <Readout
          label="Gateways running"
          value={servicesChecked ? `${gatewaysCount}/2` : "—"}
          hint={servicesChecked ? undefined : "Not checked yet"}
          muted={!servicesChecked}
        />
        <Readout label="Runs today" value={runs ? String(runsToday.length) : "—"} muted={!runs} />
        <Readout
          label="Spend today"
          value={spendToday === null ? "—" : `$${spendToday.toFixed(2)}`}
          hint={spendToday === null ? "cost is reported by Claude and OpenClaw only" : undefined}
          muted={spendToday === null}
        />
      </div>

      <div className="os-fleet__grid">
        {agents === null
          ? FLEET_ORDER.map((id) => <FleetCardSkeleton key={id} />)
          : FLEET_ORDER.map((id) => {
              const agent = agents.find((a) => a.id === id);
              if (!agent) return null;
              return (
                <FleetCard
                  key={id}
                  agent={agent}
                  liveCount={liveCountByAgent[id] || 0}
                  liveRun={liveRunByAgent[id]}
                  lastRun={lastRunByAgent[id]}
                  service={SERVICE_AGENTS.has(id) ? services[id] : undefined}
                  serviceChecked={servicesChecked}
                  failed={agentsFailed}
                />
              );
            })}
      </div>

      <Panel className="os-fleet__recent">
        <h2 className="os-fleet__recent-title">Recent runs</h2>
        {recentRuns === null ? (
          <div className="os-skeleton os-fleet__recent-skeleton" />
        ) : recentRuns.length === 0 ? (
          <p className="os-fleet__empty">No runs yet. Runs you start from Agents will appear here.</p>
        ) : (
          <ul className="os-fleet__runlist">
            {recentRuns.map((run) => (
              <li key={run.id}>
                <StatusMark kind={runStatusMark(run.status)} />
                <span className="os-fleet__run-agent">{run.agentId || "—"}</span>
                <span className="os-fleet__run-title">{run.title || firstLine(run.commandPreview, 60) || "Run"}</span>
                <span className="os-mono">
                  {run.status === "running" && run.startedAt ? (
                    <RelativeTime since={run.startedAt} live />
                  ) : (
                    durationLabel(run)
                  )}
                </span>
                <span className="os-mono">{costLabel(run.usage)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function durationLabel(run: RunMeta) {
  if (!run.startedAt || !run.endedAt) return "—";
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function FleetCardSkeleton() {
  return (
    <Panel className="os-fleet-card">
      <div className="os-skeleton" style={{ height: 20, width: "60%", marginBottom: 12 }} />
      <div className="os-skeleton" style={{ height: 14, width: "80%", marginBottom: 16 }} />
      <div className="os-skeleton" style={{ height: 40, marginBottom: 12 }} />
      <div className="os-skeleton" style={{ height: 14, width: "50%" }} />
    </Panel>
  );
}

function FleetCard({
  agent,
  liveCount,
  liveRun,
  lastRun,
  service,
  serviceChecked,
  failed
}: {
  agent: AgentSummary;
  liveCount: number;
  liveRun?: RunMeta;
  lastRun?: RunMeta;
  service?: AgentServiceStatus | null;
  serviceChecked: boolean;
  failed: boolean;
}) {
  const { buckets, pulseKey } = useAgentActivity(liveRun ? liveRun.id : null);
  const isServiceAgent = SERVICE_AGENTS.has(agent.id);

  let mark: StatusKind = "unknown";
  let stateWord = "Not installed";
  if (failed) {
    mark = "error";
    stateWord = "Couldn't check";
  } else if (liveCount > 0) {
    mark = "live";
    stateWord = `Running ×${liveCount}`;
  } else if (agent.detected.installed) {
    mark = "ok";
    stateWord = "Ready";
  }

  const pid = parsePid(service?.text);
  const warnings = service?.warnings || [];

  return (
    <Panel className="os-fleet-card">
      <header className="os-fleet-card__head">
        <div>
          <strong>{agent.label}</strong>
          <span className="os-fleet-card__role">{AGENT_ROLE[agent.id]}</span>
        </div>
        <span className="os-fleet-card__status">
          <StatusMark kind={mark} pulse={liveCount > 0} key={liveCount > 0 ? pulseKey : "static"} label={stateWord} />
          {stateWord}
        </span>
      </header>

      <p className="os-fleet-card__version os-mono">
        {agent.detected.installed
          ? firstLine(agent.detected.version) || "—"
          : agent.detected.error || "Not installed"}
      </p>

      {isServiceAgent ? (
        <p className="os-fleet-card__gateway">
          {!serviceChecked ? (
            "Checking gateway…"
          ) : service?.running ? (
            <>
              <StatusMark kind={warnings.length ? "warn" : "ok"} label={warnings.length ? warnings.join("; ") : undefined} />
              {` Gateway running${pid ? ` · pid ${pid}` : ""}`}
            </>
          ) : (
            <>
              <StatusMark kind="unknown" /> Gateway stopped
            </>
          )}
        </p>
      ) : null}

      <ActivityTrace buckets={buckets} live={liveCount > 0} />

      <p className="os-fleet-card__last">
        {lastRun ? (
          <>
            Last run: {agoLabel(lastRun.createdAt)} · {lastRun.status} · {costLabel(lastRun.usage)}
          </>
        ) : (
          "No runs yet"
        )}
      </p>
    </Panel>
  );
}
