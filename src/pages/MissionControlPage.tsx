import { Loader2, MessageSquare, RefreshCcw, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { getExecutionGateStatus, getLocalAgentDashboard, getProductStatus } from "../api";
import { chatLabel, statusTone, type LocalAgentDashboard, type LocalAgentRecord, type ProductStatus } from "../localAgents";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

function scoreLine(dashboard: LocalAgentDashboard | null) {
  if (!dashboard) return "Checking local CLIs…";
  const { summary } = dashboard;
  return `${summary.cliFound}/${summary.total} CLIs found · ${summary.dashboardChatReady} usable in Chat · live execution ${summary.executionEnabled ? "on" : "off"}`;
}

export default function MissionControlPage() {
  const [dashboard, setDashboard] = useState<LocalAgentDashboard | null>(null);
  const [product, setProduct] = useState<ProductStatus | null>(null);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const [agents, productStatus, execution] = await Promise.all([
        getLocalAgentDashboard(),
        getProductStatus().catch(() => null),
        getExecutionGateStatus().catch(() => null)
      ]);
      setDashboard(agents);
      setProduct(productStatus);
      setGate(execution);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Mission Control.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const agents = dashboard?.agents || [];

  return (
    <PageFrame
      kicker="MISSION CONTROL · LOCAL V1"
      title="See what is actually installed. Chat stays dry-run."
      hint="This is a local dashboard you clone and run. github.io is a screenshot gallery, not this runtime. Missing CLIs stay missing."
      actions={
        <button className="aos-secondary" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <RefreshCcw size={16} />} Refresh
        </button>
      }
    >
      <div className="aos-product-banner" role="status">
        <ShieldCheck size={18} />
        <div>
          <strong>Local product · not hosted SaaS</strong>
          <p>{product?.publicSummary || "Dry-run by default. Execution, installs, and public mode stay off until you turn them on in .env."}</p>
        </div>
        <em>{scoreLine(dashboard)}</em>
      </div>
      <HonestNote>
        A CLI on PATH is not the same as dashboard chat. Cursor can be installed and still unwired. Claude and Hermes return plans. Codex can preview if a key is saved locally.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}

      <div className="aos-status-grid aos-setup-grid">
        {(product?.firstRun || [
          { id: "runtime", label: "Runtime", done: true, detail: "Dashboard API is up." },
          { id: "env", label: ".env", done: false, detail: "Optional. Copy .env.example if you need keys." },
          { id: "chat", label: "Unified Chat", done: false, detail: "Try a dry-run next." },
          { id: "exec", label: "Live execution", done: gate?.enabled !== true, detail: gate?.publicSummary || "Off by default." }
        ]).map((step) => (
          <article key={step.id}>
            <span>{step.done ? "Done" : "Next"}</span>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </article>
        ))}
      </div>

      <div className="aos-mission-grid aos-v1-agent-grid">
        {agents.length === 0 ? (
          <div className="aos-empty"><p>Agent status has not loaded yet.</p></div>
        ) : (
          agents.map((agent: LocalAgentRecord) => (
            <article key={agent.id} className={`aos-local-agent-card agent-${agent.id} ${agent.status}`}>
              <div className="aos-local-agent-top">
                <span>{agent.eyebrow}</span>
                <em className={`aos-layer-pill ${statusTone(agent.status)}`}>{chatLabel(agent)}</em>
              </div>
              <div className="aos-local-agent-main">
                <div className="aos-local-agent-icon"><Terminal size={20} /></div>
                <div>
                  <h3>{agent.name}</h3>
                  <p>{agent.summary}</p>
                </div>
              </div>
              <dl className="aos-local-agent-details">
                <div><dt>CLI</dt><dd>{agent.cli?.found ? `${agent.cli.command} · ${agent.cli.version || "found"}` : "Not on PATH"}</dd></div>
                <div><dt>Dashboard chat</dt><dd>{agent.chat?.label || chatLabel(agent)}</dd></div>
                <div><dt>Live execution</dt><dd>{agent.liveExecution?.label || "Off"}</dd></div>
              </dl>
              <p className="aos-honest-note">{agent.nextAction}</p>
            </article>
          ))
        )}
      </div>

      <div className="aos-mission-footer aos-v1-cta">
        <button className="aos-primary" onClick={() => navigateTo("chat")}>
          <MessageSquare size={16} /> Open Unified Chat (dry-run)
        </button>
        <button className="aos-secondary" onClick={() => navigateTo("workspace")}>Open Workspace sandbox</button>
        <button className="aos-secondary" onClick={() => navigateTo("machine")}>Machine Control checklist</button>
      </div>
    </PageFrame>
  );
}
