import { Loader2, MessageSquare, RefreshCcw, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { getLocalAgents, getModule, testIntegration } from "../api";
import { statusTone, type LocalAgentRecord } from "../localAgents";
import { navigateTo } from "../nav";
import type { RuntimeModule } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function HermesPage() {
  const [agent, setAgent] = useState<LocalAgentRecord | null>(null);
  const [module, setModule] = useState<RuntimeModule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState("");

  async function refresh() {
    setBusy(true);
    try {
      const [agents, hermes] = await Promise.all([
        getLocalAgents(),
        getModule("hermes").catch(() => null)
      ]);
      setAgent(agents.find((item) => item.id === "hermes") || null);
      setModule(hermes);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Hermes status.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function probeStatus() {
    setBusy(true);
    try {
      const result = await testIntegration("hermes");
      setProbe(result.message || (result.ok ? "Hermes probe returned ok." : "Hermes probe reported a gap."));
      await refresh();
    } catch (caught) {
      setProbe(caught instanceof Error ? caught.message : "Hermes probe failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      kicker="HERMES · LOCAL RUNTIME"
      title="Detect the real Hermes install. Do not fake a connected gateway."
      hint="This page is a status desk for the local Hermes Agent runtime. Unified Chat can still dry-run a plan without a profile. Live gateway / Kanban dispatch stays gated."
      actions={
        <>
          <button className="aos-secondary" onClick={() => void refresh()} disabled={busy}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <RefreshCcw size={16} />} Refresh
          </button>
          <button className="aos-secondary" onClick={() => void probeStatus()} disabled={busy}>
            <Sparkles size={16} /> Probe status
          </button>
        </>
      }
    >
      <HonestNote>
        Missing HERMES_HOME or the hermes CLI stays missing. This is not the Workflow studio Codex preview, and it does not enable shell control.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-product-banner" role="status">
        <ShieldCheck size={18} />
        <div>
          <strong>{agent?.name || "Hermes Agent"}</strong>
          <p>{agent?.summary || module?.publicSummary || "Checking local Hermes readiness…"}</p>
        </div>
        <em className={`aos-layer-pill ${statusTone(agent?.status || "not_installed")}`}>
          {agent?.chat?.label || module?.status || "Checking"}
        </em>
      </div>
      <div className="aos-status-grid">
        <article>
          <span>CLI</span>
          <strong>{agent?.cli?.found ? agent.cli.command : "Not on PATH"}</strong>
          <small>{agent?.cli?.version || "Optional until you install Hermes yourself."}</small>
        </article>
        <article>
          <span>Dashboard chat</span>
          <strong>{agent?.chat?.label || "Dry run when available"}</strong>
          <small>Unified Chat returns a plan. Live Kanban dispatch needs a profile + execution gate.</small>
        </article>
        <article>
          <span>Live execution</span>
          <strong>{agent?.liveExecution?.label || "Off"}</strong>
          <small>{agent?.liveExecution?.detail || "HERMES_AGENT_OS_ENABLE_EXEC stays 0 by default."}</small>
        </article>
      </div>
      {probe ? <p className="aos-honest-note">{probe}</p> : null}
      <div className="aos-mission-footer aos-v1-cta">
        <button className="aos-primary" onClick={() => navigateTo("chat")}>
          <MessageSquare size={16} /> Open Unified Chat (dry-run)
        </button>
        <button className="aos-secondary" onClick={() => navigateTo("machine")}>Machine Control checklist</button>
      </div>
    </PageFrame>
  );
}
