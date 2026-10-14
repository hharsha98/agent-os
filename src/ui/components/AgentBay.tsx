// The Agents page's detail for the selected agent: its head (name, maker and role), a Version block,
// then sections laid out "title on the left, content on the right": Brain, Safeguards, Background
// service and Its own dashboard (Hermes and OpenClaw only) and Configuration. It fetches the one
// agent's detail (config + safety + service) itself, independent of the rail's list-level fetch.
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { getAgentDetail } from "../../api";
import { navigateTo } from "../../nav";
import type { BuilderBrains } from "../../buildersApi";
import type { AgentDetail, AgentSummary } from "../../types";
import Banner from "./Banner";
import StatusWord from "./StatusWord";
import { AGENT_LABEL, AGENT_MAKER, AGENT_ROLE, SERVICE_AGENT_SET, SETUP_CAN_INSTALL_AGENT_SET, SETUP_INSTALLED_AGENT_SET, friendlyError } from "../agentsShared";
import { installState } from "../agentsPageShared";
import { isBuilderId } from "../builderShared";
import { AGENT_DETAIL_LIMIT_MS, withTimeout } from "../homeShared";
import { useInterval } from "./useInterval";
import AgentBrainCard from "./AgentBrainCard";
import BuilderBrainCard from "./BuilderBrainCard";
import OpenAddress from "./OpenAddress";
import PlanLimitSettings from "./PlanLimitSettings";
import AgentServicePanel from "./AgentServicePanel";
import AgentSafetyPanel from "./AgentSafetyPanel";

const DETAIL_POLL_MS = 20000;
// While the detail is failing the page tries again sooner, so it comes back by itself soon after
// Agent OS does (the rest of the page polls every 5 s while failing).
const DETAIL_RETRY_MS = 5000;
// The detail waits on the agent's own checks: the version check (5 s) and then the agent's own doctor
// (Hermes and OpenClaw give it up to 30 s on the server). The page waits longer than the server does
// (AGENT_DETAIL_LIMIT_MS, homeShared.ts): a slow check must not look like "can't load".
const DETAIL_TIMEOUT_MS = AGENT_DETAIL_LIMIT_MS;

export default function AgentBay({
  agentId,
  agent,
  agentsResolved,
  agentsFailed,
  onRetryAgents,
  brains = null,
  brainsFailed = false,
  onBrainsChanged
}: {
  agentId: string;
  agent: AgentSummary | undefined;
  agentsResolved: boolean;
  agentsFailed: boolean;
  onRetryAgents: () => void;
  // Claude Code, Codex and Cursor: the saved brains (see useBuilderBrains).
  brains?: BuilderBrains | null;
  brainsFailed?: boolean;
  onBrainsChanged?: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const alive = useRef(true);
  // The number of the newest request: an older answer (another agent's, or one that was overtaken)
  // is dropped, so it can never show under the wrong name.
  const newest = useRef(0);
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownId = useRef(agentId);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadDetail = useCallback(async () => {
    const mine = ++newest.current;
    inFlight.current = true;
    try {
      const next = await withTimeout(getAgentDetail(agentId), DETAIL_TIMEOUT_MS);
      if (!next || typeof next !== "object" || !next.config) throw new Error("");
      if (!alive.current || mine !== newest.current) return;
      setDetail(next);
      setDetailError("");
    } catch (error) {
      if (!alive.current || mine !== newest.current) return;
      // The last good detail stays on screen under the note.
      setDetailError(friendlyError(error));
    } finally {
      if (mine === newest.current) inFlight.current = false;
    }
  }, [agentId]);

  useEffect(() => {
    setDetail(null);
    setDetailError("");
    void loadDetail();
  }, [agentId, loadDetail]);
  // One check at a time: a slow answer must not pile up behind the next tick. Quicker while the
  // last check failed, so a note about a server that is back again does not linger.
  useInterval(() => {
    if (!inFlight.current) void loadDetail();
  }, detailError ? DETAIL_RETRY_MS : DETAIL_POLL_MS);

  // Picking another agent swaps the whole detail. If that took the focused control away (focus fell
  // back to the page), it goes to the new agent's name. Focus that is on the rail stays there.
  useEffect(() => {
    if (shownId.current === agentId) return;
    shownId.current = agentId;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus({ preventScroll: true });
  }, [agentId]);

  if (!agentsResolved) {
    return (
      <section className="os-agent-bay" aria-label="Agent details">
        {agentsFailed ? (
          <Banner
            tone="warn"
            title="Can't reach Agent OS"
            actions={
              <button type="button" className="os-btn os-btn--secondary" onClick={onRetryAgents}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            }
          >
            The agents' details appear when it answers. This page also tries again every few seconds.
          </Banner>
        ) : (
          <p className="os-agent-bay__loading"><StatusWord state="loading" /></p>
        )}
      </section>
    );
  }

  const label = agent?.label || AGENT_LABEL[agentId];
  const found = installState(agent);
  const installed = found === "installed";
  const versionFull = detail?.detected.versionFull;
  const builderId = isBuilderId(agentId) ? agentId : null;
  const operator = SERVICE_AGENT_SET.has(agentId);
  const dashboard =
    agentId === "hermes"
      ? { title: "Hermes dashboard", about: "Hermes's own page for its memory and settings, on this Mac only.", url: "http://127.0.0.1:9119", button: "Open dashboard" }
      : agentId === "openclaw"
        ? { title: "OpenClaw Control UI", about: "OpenClaw's own control page, served by its Gateway, on this Mac only.", url: "http://127.0.0.1:18789", button: "Open Control UI" }
        : null;

  return (
    <section className="os-agent-bay" aria-labelledby="os-agent-name">
      <header className="os-agent-head">
        <div>
          <h2 id="os-agent-name" ref={headingRef} tabIndex={-1}>{label}</h2>
          <p className="os-agent-head__who">{AGENT_MAKER[agentId] || "—"} · {operator ? "Operator" : "Builder"}</p>
          <p className="os-agent-head__about">{AGENT_ROLE[agentId]}</p>
        </div>
        {/* "Open session" / "New session" arrive with Sessions in SP3. */}
      </header>

      {detailError ? (
        <Banner
          tone="warn"
          title="Couldn't load this agent's details"
          actions={
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void loadDetail()}>
              <RefreshCw size={14} aria-hidden="true" /> Retry
            </button>
          }
        >
          {detailError}
          {detail ? " Showing what was last known." : ""}
        </Banner>
      ) : null}

      <section className="os-agent-version" aria-labelledby="os-agent-version-title">
        <h3 id="os-agent-version-title">Version</h3>
        {installed ? (
          <>
            <p className="os-agent-version__line">
              Installed <span className="os-agent-version__num os-mono" title={agent?.detected.version || undefined}>{agent?.detected.version || "—"}</span>
            </p>
            {versionFull ? (
              <details className="os-agent-version__details">
                <summary>Details</summary>
                <pre className="os-mono">{versionFull}</pre>
              </details>
            ) : null}
          </>
        ) : found === "missing" ? (
          <div className="os-agent-version__missing">
            <StatusWord state="idle" label="Not installed" />
            <p>{label} isn&apos;t installed on this Mac.</p>
            {SETUP_CAN_INSTALL_AGENT_SET.has(agentId) ? (
              <button type="button" className="os-btn os-btn--primary" onClick={() => navigateTo("setup", { step: "plan" })}>
                Open Setup
              </button>
            ) : agent?.homepage ? (
              <OpenAddress className="os-btn os-btn--secondary" href={agent.homepage} copyLabel="Copy the install page address">
                How to install it <ExternalLink size={14} aria-hidden="true" />
              </OpenAddress>
            ) : null}
          </div>
        ) : (
          <div className="os-agent-version__missing">
            <StatusWord state="unknown" />
            <p>Agent OS can&apos;t tell if {label} is installed.</p>
          </div>
        )}
        <p className="os-agent-version__links">
          {agent?.homepage ? <OpenAddress href={agent.homepage} copyLabel="Copy the homepage address">Homepage</OpenAddress> : null}
          {agent?.docsUrl ? <OpenAddress href={agent.docsUrl} copyLabel="Copy the docs address">Docs</OpenAddress> : null}
        </p>
      </section>

      {installed ? (
        // Keyed by agent: each panel keeps its own state (a running restart, a Fix console, an error
        // line), and that state must never carry over to the next agent that is picked.
        <div className="os-agt-secs" key={agentId}>
          {agentId === "hermes" || agentId === "openclaw" ? <AgentBrainCard agentId={agentId} label={label} /> : null}
          {builderId ? (
            <>
              <BuilderBrainCard agentId={builderId} label={label} brains={brains} failed={brainsFailed} onChanged={() => onBrainsChanged?.()} />
              <PlanLimitSettings brains={brains} onChanged={() => onBrainsChanged?.()} />
            </>
          ) : null}

          <AgentSafetyPanel
            agentId={agentId}
            safety={detail?.safety ?? null}
            notes={detail?.config.notes ?? []}
            onFixed={() => void loadDetail()}
            failed={!detail && Boolean(detailError)}
          />

          {operator ? (
            <AgentServicePanel
              agentId={agentId}
              label={label}
              service={detail?.service ?? null}
              checked={Boolean(detail)}
              failed={!detail && Boolean(detailError)}
              onRefresh={() => void loadDetail()}
            />
          ) : null}

          {dashboard ? (
            <section className="os-panel os-agent-dash" aria-labelledby="os-agent-dash-title">
              <h3 id="os-agent-dash-title">Its own dashboard</h3>
              <div className="os-agent-dash__line">
                <div>
                  <b>{dashboard.title}</b>
                  <p>{dashboard.about} This is its default address, and it opens only while it is running.</p>
                  <span className="os-mono os-agent-dash__addr">{dashboard.url.replace("http://", "")}</span>
                </div>
                <OpenAddress
                  className="os-btn os-btn--secondary"
                  href={dashboard.url}
                  copyLabel="Copy the dashboard address"
                  buttonClassName="os-btn os-btn--secondary"
                  showAddress={false}
                >
                  {dashboard.button} <ExternalLink size={14} aria-hidden="true" />
                </OpenAddress>
              </div>
            </section>
          ) : null}

          <section className="os-panel os-config" aria-labelledby="os-config-title">
            <h3 id="os-config-title" className="os-config__title">Configuration</h3>
            {!detail ? (
              <p><StatusWord state={detailError ? "unknown" : "loading"} /></p>
            ) : (
              <>
                <p className="os-config__summary">
                  <StatusWord state={detail.config.ok ? "ready" : "waiting"} label={detail.config.ok ? "Configured" : "Needs attention"} />
                  <span>{detail.config.summary}</span>
                </p>
                {detail.config.problems.map((problem, index) => (
                  <p key={index} className="os-config__problem">{problem}</p>
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
        </div>
      ) : null}
    </section>
  );
}
