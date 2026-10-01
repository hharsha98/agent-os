import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getAgentService, listAgents, listRuns, useRunStream } from "../api";
import { navigateTo } from "../nav";
import type { AgentServiceStatus, AgentSummary, RunMeta } from "../types";
import ActivityTrace, { emptyBuckets } from "../ui/components/ActivityTrace";
import FlightLog from "../ui/components/FlightLog";
import Panel from "../ui/components/Panel";
import Readout from "../ui/components/Readout";
import { TimeAgo } from "../ui/components/RelativeTime";
import SegmentMeter, { type MeterSegmentState } from "../ui/components/SegmentMeter";
import StatusMark, { type StatusKind } from "../ui/components/StatusMark";
import { useCountUp } from "../ui/components/useCountUp";
import { useInterval } from "../ui/components/useInterval";
import { AGENT_MONOGRAM, firstLine } from "../ui/fleetShared";
import "../ui/fleet.css";

// Fixed order, per the design brief's "mixing desk" layout.
const FLEET_ORDER = ["hermes", "openclaw", "claude", "codex", "cursor"];
const FLEET_LABEL: Record<string, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor"
};
const AGENT_ROLE: Record<string, string> = {
  hermes: "Autonomous general agent",
  openclaw: "Always-on assistant",
  claude: "Coding agent",
  codex: "Coding agent",
  cursor: "Coding agent"
};
const SERVICE_AGENTS = ["hermes", "openclaw"];
const SERVICE_AGENT_SET = new Set(SERVICE_AGENTS);
const AGENTS_WATCHDOG_MS = 15000;
const COUNT_UP_MS = 600; // --os-dur-deliberate

function platformLabel() {
  const platform = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";
  if (/mac/i.test(platform)) return "THIS MAC";
  if (/win/i.test(platform)) return "THIS PC";
  if (/linux/i.test(platform)) return "THIS LINUX MACHINE";
  return "THIS COMPUTER";
}

function parsePid(text: string | undefined) {
  const match = String(text || "").match(/\bPID[:\s]+(\d+)/i);
  return match ? match[1] : null;
}

function isToday(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// Shape+colour drives the card's top status light too, so one real state
// maps to one real colour everywhere it appears on the card.
function markColorVar(mark: StatusKind): string {
  if (mark === "ok") return "var(--os-ok)";
  if (mark === "warn") return "var(--os-warn)";
  if (mark === "error") return "var(--os-danger)";
  if (mark === "live") return "var(--os-accent)";
  return "var(--os-line-2)";
}

// The composed header sentence: only real counts, never a claim the data
// doesn't support yet.
function useFleetSentence(
  agents: AgentSummary[] | null,
  servicesChecked: boolean,
  gatewaysCount: number,
  runs: RunMeta[] | null
): { mark: StatusKind; text: string } {
  return useMemo(() => {
    if (agents === null) return { mark: "unknown", text: "Checking fleet status…" };
    const installed = agents.filter((a) => a.detected.installed).length;
    const total = agents.length;
    const agentsPart = `${installed} of ${total} agent${total === 1 ? "" : "s"} ready`;
    const gatewaysPart = servicesChecked
      ? `${gatewaysCount} background service${gatewaysCount === 1 ? "" : "s"} running`
      : "checking background services…";
    const liveTotal = runs ? runs.filter((r) => r.status === "running").length : null;
    const livePart = liveTotal === null ? "checking runs…" : liveTotal > 0 ? `${liveTotal} running now` : "nothing running now";
    const mark: StatusKind = installed < total ? "warn" : !servicesChecked ? "unknown" : "ok";
    return { mark, text: [agentsPart, gatewaysPart, livePart].join(" · ") };
  }, [agents, servicesChecked, gatewaysCount, runs]);
}

// Drives one card's 60-second trace from that agent's live run stream:
// each real event lands in the second it actually happened (its server
// timestamp `t`), so events replayed on connect are spread back over the
// seconds they came from rather than piled into "now". The window slides
// once a second while live (true elapsed time), and a throttled "pulse"
// tick feeds the card's status mark. No live run -> buckets stay flat.
function useAgentActivity(runId: string | null) {
  const { events } = useRunStream(runId);
  const [now, setNow] = useState(() => Date.now());
  const [pulseKey, setPulseKey] = useState(0);
  const lastPulseRef = useRef(0);
  const processedRef = useRef(0);

  useEffect(() => {
    processedRef.current = 0;
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runId]);

  const buckets = useMemo(() => {
    const next = emptyBuckets();
    if (!runId) return next;
    for (const event of events) {
      const at = Date.parse(event.t);
      if (!Number.isFinite(at)) continue;
      const age = Math.floor((now - at) / 1000);
      if (age < 0) next[next.length - 1] += 1; // clock skew: count as "now"
      else if (age < next.length) next[next.length - 1 - age] += 1;
    }
    return next;
  }, [events, now, runId]);

  useEffect(() => {
    if (!runId) return;
    const freshCount = events.length - processedRef.current;
    if (freshCount <= 0) return;
    processedRef.current = events.length;
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
  const [agentsTimedOut, setAgentsTimedOut] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
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
      SERVICE_AGENTS.map(async (id): Promise<[string, AgentServiceStatus | null]> => {
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

  // Watchdog: the fleet-comes-online fade must never stay dim forever. Resets
  // on every (re)load attempt; clears the instant the real result is in.
  useEffect(() => {
    if (agents !== null) {
      setAgentsTimedOut(false);
      return undefined;
    }
    const id = setTimeout(() => setAgentsTimedOut(true), AGENTS_WATCHDOG_MS);
    return () => clearTimeout(id);
  }, [agents, loadAttempt]);

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

  const agentsResolved = agents !== null;
  const installedDisplay = useCountUp(installedCount, COUNT_UP_MS);
  const gatewaysDisplay = useCountUp(servicesChecked ? gatewaysCount : null, COUNT_UP_MS);
  const runsTodayDisplay = useCountUp(runs ? runsToday.length : null, COUNT_UP_MS);

  const sentence = useFleetSentence(agents, servicesChecked, gatewaysCount, runs);

  const installedSegments: MeterSegmentState[] = FLEET_ORDER.map((id) =>
    agents && agents.find((a) => a.id === id)?.detected.installed ? "ok" : "unknown"
  );
  const gatewaySegments: MeterSegmentState[] = SERVICE_AGENTS.map((id) => (services[id]?.running ? "ok" : "unknown"));

  function retryAll() {
    setLoadAttempt((n) => n + 1);
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
        <div className="os-fleet__header-row">
          <h1>Fleet</h1>
          <span className="os-fleet__status-sentence">
            <StatusMark kind={sentence.mark} />
            {sentence.text}
          </span>
        </div>
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

      <div className="os-instrument">
        <div className="os-instrument__cell">
          <Readout big label="Installed" value={installedDisplay === null ? (agentsFailed ? "—" : "…") : `${installedDisplay}/5`} />
          <SegmentMeter label="Agents installed" segments={installedSegments} />
        </div>
        <div className="os-instrument__cell">
          <Readout
            big
            label="Gateways"
            value={gatewaysDisplay === null ? "…" : `${gatewaysDisplay}/2`}
            hint={servicesChecked ? undefined : "Checking…"}
          />
          <SegmentMeter label="Gateways running" segments={gatewaySegments} />
        </div>
        <div className="os-instrument__cell">
          <Readout big label="Runs today" value={runsTodayDisplay === null ? "—" : String(runsTodayDisplay)} />
        </div>
        <div className="os-instrument__cell">
          <Readout
            big
            label="Spend today"
            value={spendToday === null ? "—" : `$${spendToday.toFixed(2)}`}
            hint={spendToday === null ? "cost is reported by Claude and OpenClaw only" : undefined}
            muted={spendToday === null}
          />
        </div>
      </div>

      <div className="os-fleet__body">
        <div className="os-fleet__grid">
          {FLEET_ORDER.map((id) => {
            const agent = agents ? agents.find((a) => a.id === id) : undefined;
            return (
              <FleetCard
                key={id}
                agentId={id}
                agent={agent}
                resolved={agentsResolved}
                timedOut={agentsTimedOut && !agentsResolved}
                onRetry={retryAll}
                liveCount={liveCountByAgent[id] || 0}
                liveRun={liveRunByAgent[id]}
                lastRun={lastRunByAgent[id]}
                service={SERVICE_AGENT_SET.has(id) ? services[id] : undefined}
                serviceChecked={servicesChecked}
                failed={agentsFailed}
              />
            );
          })}
          <FlightLog runs={runs} onOpenChat={() => navigateTo("chat")} />
        </div>
      </div>
    </div>
  );
}

function FleetCard({
  agentId,
  agent,
  resolved,
  timedOut,
  onRetry,
  liveCount,
  liveRun,
  lastRun,
  service,
  serviceChecked,
  failed
}: {
  agentId: string;
  agent?: AgentSummary;
  resolved: boolean;
  timedOut: boolean;
  onRetry: () => void;
  liveCount: number;
  liveRun?: RunMeta;
  lastRun?: RunMeta;
  service?: AgentServiceStatus | null;
  serviceChecked: boolean;
  failed: boolean;
}) {
  const { buckets, pulseKey } = useAgentActivity(liveRun ? liveRun.id : null);
  const isServiceAgent = SERVICE_AGENT_SET.has(agentId);

  let mark: StatusKind = "unknown";
  let stateWord = "Checking…";
  if (!resolved) {
    mark = "unknown";
    stateWord = timedOut ? "Timed out" : "Checking…";
  } else if (failed) {
    mark = "error";
    stateWord = "Couldn't check";
  } else if (liveCount > 0) {
    mark = "live";
    stateWord = `Running ×${liveCount}`;
  } else if (agent?.detected.installed) {
    mark = "ok";
    stateWord = "Ready";
  } else {
    mark = "unknown";
    stateWord = "Not installed";
  }

  const pid = parsePid(service?.text);
  const warnings = service?.warnings || [];
  const topColorStyle = { "--os-card-c": markColorVar(mark) } as CSSProperties;

  return (
    <Panel className={`os-fleet-card ${resolved ? "os-fleet-card--resolved" : "os-fleet-card--checking"}`}>
      <div className="os-fleet-card__topline" style={topColorStyle} />
      <div className="os-fleet-card__topglow" style={topColorStyle} />

      <header className="os-fleet-card__head">
        <div className="os-fleet-card__id">
          <span className="os-fleet-card__mono-tile os-mono">{AGENT_MONOGRAM[agentId]}</span>
          <div>
            <strong>{agent?.label || FLEET_LABEL[agentId]}</strong>
            <span className="os-fleet-card__role">{AGENT_ROLE[agentId]}</span>
          </div>
        </div>
        <span className="os-fleet-card__status">
          <StatusMark
            kind={mark}
            pulse={resolved && liveCount > 0}
            key={resolved && liveCount > 0 ? pulseKey : "static"}
            label={stateWord}
          />
          {stateWord}
          {timedOut ? (
            <button className="os-btn os-btn--ghost" onClick={onRetry} aria-label={`Retry checking ${FLEET_LABEL[agentId]}`}>
              <RefreshCw size={12} /> Retry
            </button>
          ) : null}
        </span>
      </header>

      <p className="os-fleet-card__version os-mono">
        {!resolved
          ? "—"
          : agent?.detected.installed
            ? firstLine(agent.detected.version) || "—"
            : agent?.detected.error || "Not installed"}
      </p>

      {isServiceAgent ? (
        <p className="os-fleet-card__gateway">
          {!serviceChecked ? (
            <>
              <StatusMark kind="unknown" /> Checking gateway…
            </>
          ) : service?.running ? (
            <>
              <StatusMark kind={warnings.length ? "warn" : "ok"} />
              {` Gateway running${pid ? ` · pid ${pid}` : ""}`}
            </>
          ) : (
            <>
              <StatusMark kind="unknown" /> Gateway stopped
            </>
          )}
        </p>
      ) : null}
      {isServiceAgent && serviceChecked && warnings.length > 0 ? (
        <p className="os-fleet-card__warning" title={warnings.join("; ")}>
          {warnings[0]}
        </p>
      ) : null}

      <ActivityTrace buckets={buckets} live={resolved && liveCount > 0} />

      <div className="os-fleet-card__footer">
        <span className="os-micro">Last run</span>
        {resolved && lastRun ? <TimeAgo since={lastRun.createdAt} /> : <span className="os-mono">—</span>}
      </div>
    </Panel>
  );
}
