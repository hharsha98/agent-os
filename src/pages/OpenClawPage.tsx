import { Bot, Loader2, MessageSquare, RefreshCcw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { getLocalAgents, getModule } from "../api";
import { statusTone, type LocalAgentRecord } from "../localAgents";
import { navigateTo } from "../nav";
import type { RuntimeModule } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function OpenClawPage() {
  const [agent, setAgent] = useState<LocalAgentRecord | null>(null);
  const [module, setModule] = useState<RuntimeModule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const [agents, openclaw] = await Promise.all([
        getLocalAgents(),
        getModule("openclaw").catch(() => null)
      ]);
      setAgent(agents.find((item) => item.id === "openclaw") || null);
      setModule(openclaw);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load OpenClaw status.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <PageFrame
      kicker="OPENCLAW · OPTIONAL CLI"
      title="Detected if installed. Never counted as Unified Chat ready."
      hint="OpenClaw is an optional local CLI. Local v1 shows honest install state only. It is not routed through Unified Chat and install recipes stay dry-run unless you enable installs."
      actions={
        <button className="aos-secondary" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <RefreshCcw size={16} />} Refresh
        </button>
      }
    >
      <HonestNote>
        This page does not run install commands. If you want OpenClaw later, install it yourself, then refresh Mission Control.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-product-banner" role="status">
        <ShieldCheck size={18} />
        <div>
          <strong>{agent?.name || "OpenClaw"}</strong>
          <p>{agent?.summary || module?.publicSummary || "Checking whether openclaw is on PATH…"}</p>
        </div>
        <em className={`aos-layer-pill ${statusTone(agent?.status || "not_installed")}`}>
          {agent?.chat?.label || module?.status || "Checking"}
        </em>
      </div>
      <div className="aos-status-grid">
        <article>
          <span>CLI</span>
          <strong>{agent?.simulated ? "Demo · simulated" : agent?.cli?.found ? agent.cli.command : "Not on PATH"}</strong>
          <small>{agent?.simulated ? "Your real OpenClaw CLI is not connected." : agent?.cli?.version || module?.installHint || "Optional dependency."}</small>
        </article>
        <article>
          <span>Unified Chat</span>
          <strong>Not in composer</strong>
          <small>OpenClaw is detected for Mission Control honesty, not as a fourth chat target.</small>
        </article>
        <article>
          <span>Install gate</span>
          <strong>Off by default</strong>
          <small>HERMES_AGENT_OS_ENABLE_INSTALL stays 0 unless you trust a recipe.</small>
        </article>
      </div>
      <div className="aos-panel aos-disabled-action">
        <Bot size={18} />
        <div>
          <strong>Install OpenClaw</strong>
          <p>Disabled here. Use the vendor docs on your machine if you want it. The dashboard will not silently npm-install packages.</p>
        </div>
        <button className="aos-primary" disabled>Install disabled</button>
      </div>
      <div className="aos-mission-footer aos-v1-cta">
        <button className="aos-primary" onClick={() => navigateTo("mission")}>Back to Mission Control</button>
        <button className="aos-secondary" onClick={() => navigateTo("chat")}>
          <MessageSquare size={16} /> Open Unified Chat
        </button>
      </div>
    </PageFrame>
  );
}
