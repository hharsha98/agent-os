// The hangar's right-hand detail bay for the selected agent: identity
// header, Launch (the hero), Background service (hermes/openclaw only),
// Safety and Configuration. Fetches the one agent's detail (config + safety
// + service) itself, independent of the rail's list-level agents fetch.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getAgentDetail } from "../../api";
import { navigateTo } from "../../nav";
import type { AgentDetail, AgentSummary, ExecutionGateStatus, RunMeta } from "../../types";
import { AGENT_LABEL, AGENT_MONOGRAM, AGENT_ROLE, SERVICE_AGENT_SET, SETUP_INSTALLED_AGENT_SET, agentStatusWord, friendlyError } from "../agentsShared";
import { useInterval } from "./useInterval";
import StatusMark from "./StatusMark";
import AgentLaunchPanel from "./AgentLaunchPanel";
import AgentServicePanel from "./AgentServicePanel";
import AgentSafetyPanel from "./AgentSafetyPanel";

const DETAIL_POLL_MS = 20000;

export default function AgentBay({
  agentId,
  agent,
  agentsResolved,
  agentsFailed,
  onRetryAgents,
  liveCount,
  gate,
  gateFailed,
  onReloadGate,
  onRecheckAgents,
  onRunLaunched
}: {
  agentId: string;
  agent: AgentSummary | undefined;
  agentsResolved: boolean;
  agentsFailed: boolean;
  onRetryAgents: () => void;
  liveCount: number;
  gate: ExecutionGateStatus | null;
  gateFailed: boolean;
  onReloadGate: () => Promise<void>;
  onRecheckAgents: () => Promise<void>;
  onRunLaunched: (run: RunMeta) => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [detailError, setDetailError] = useState("");

  const loadDetail = useCallback(async () => {
    try {
      const next = await getAgentDetail(agentId);
      setDetail(next);
      setDetailError("");
    } catch (error) {
      setDetailError(friendlyError(error));
    }
  }, [agentId]);

  useEffect(() => {
    setDetail(null);
    setDetailError("");
    void loadDetail();
  }, [agentId, loadDetail]);
  useInterval(() => void loadDetail(), DETAIL_POLL_MS);

  if (!agentsResolved) {
    return (
      <div className="os-agent-bay">
        {agentsFailed ? (
          <div className="os-fleet__banner os-agent-bay__banner" role="alert">
            <AlertTriangle size={16} />
            <span>Couldn&apos;t reach Agent OS to list agents.</span>
            <button type="button" className="os-btn os-btn--secondary" onClick={onRetryAgents}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        ) : (
          <div className="os-panel os-agent-bay__loading">…</div>
        )}
      </div>
    );
  }

  const label = agent?.label || AGENT_LABEL[agentId];
  const installed = agent?.detected.installed ?? false;
  const { mark, word } = agentStatusWord(installed, true, false, false, liveCount);
  const versionFull = detail?.detected.versionFull;

  return (
    <div className="os-agent-bay">
      <header className="os-agent-bay__identity">
        <span className="os-agent-bay__mono os-mono">{AGENT_MONOGRAM[agentId]}</span>
        <div className="os-agent-bay__identity-text">
          <h2>{label}</h2>
          <p className="os-agent-bay__role">{AGENT_ROLE[agentId]}</p>
          <p className="os-agent-bay__status">
            <StatusMark kind={mark} label={word} /> {word}
            {installed ? <span className="os-mono os-agent-bay__version">{agent?.detected.version || "—"}</span> : null}
          </p>
          {installed && versionFull ? (
            <details className="os-agent-bay__details">
              <summary>Details</summary>
              <pre className="os-mono">{versionFull}</pre>
            </details>
          ) : null}
          <div className="os-agent-bay__links">
            {agent?.homepage ? (
              <a href={agent.homepage} target="_blank" rel="noreferrer">
                Homepage
              </a>
            ) : null}
            {agent?.docsUrl ? (
              <a href={agent.docsUrl} target="_blank" rel="noreferrer">
                Docs
              </a>
            ) : null}
          </div>
        </div>
      </header>

      {detailError ? (
        <div className="os-fleet__banner os-agent-bay__banner">
          <AlertTriangle size={16} />
          <span>{detailError}</span>
          <button type="button" className="os-btn os-btn--secondary" onClick={() => void loadDetail()}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : null}

      <AgentLaunchPanel
        agentId={agentId}
        label={label}
        installed={installed}
        homepage={agent?.homepage || ""}
        gate={gate}
        gateFailed={gateFailed}
        onReloadGate={onReloadGate}
        onRecheck={onRecheckAgents}
        onLaunched={onRunLaunched}
      />

      {installed && SERVICE_AGENT_SET.has(agentId) ? (
        <AgentServicePanel
          agentId={agentId}
          label={label}
          service={detail?.service ?? null}
          checked={Boolean(detail)}
          onRefresh={() => void loadDetail()}
        />
      ) : null}

      {/* A not-installed agent has no safety or config facts worth showing; the Launch
          panel already says so, and a green mark there would read as "fine". */}
      {installed ? (
        <>
          <AgentSafetyPanel
            agentId={agentId}
            safety={detail?.safety ?? null}
            notes={detail?.config.notes ?? []}
            onFixed={() => void loadDetail()}
          />

          <section className="os-panel os-config">
            <h2 className="os-config__title">Configuration</h2>
            {!detail ? (
              <p>…</p>
            ) : (
              <>
                <p className="os-config__summary">
                  <StatusMark kind={detail.config.ok ? "ok" : "warn"} />
                  {detail.config.ok ? "Configured" : "Needs attention"} · {detail.config.summary}
                </p>
                {detail.config.problems.map((problem, index) => (
                  <p key={index} className="os-config__problem">
                    <StatusMark kind="warn" /> {problem}
                  </p>
                ))}
                {detail.config.fixHint ? <p className="os-config__hint">{detail.config.fixHint}</p> : null}
                {!detail.config.ok && SETUP_INSTALLED_AGENT_SET.has(agentId) ? (
                  <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("setup")}>
                    Open Setup
                  </button>
                ) : null}
              </>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
