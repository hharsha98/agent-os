import { Bot, Loader2, MessageSquare, RefreshCcw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { getLocalAgents, getModule, getProductStatus, sendLiveChat } from "../api";
import { liveTurnLabel, statusTone, type LocalAgentRecord } from "../localAgents";
import { navigateTo } from "../nav";
import type { RuntimeModule } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function OpenClawPage() {
  const [agent, setAgent] = useState<LocalAgentRecord | null>(null);
  const [module, setModule] = useState<RuntimeModule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState("");
  const [transport, setTransport] = useState("");
  const [demoPublic, setDemoPublic] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const [agents, openclaw, product] = await Promise.all([
        getLocalAgents(),
        getModule("openclaw").catch(() => null),
        getProductStatus().catch(() => null)
      ]);
      setAgent(agents.find((item) => item.id === "openclaw") || null);
      setModule(openclaw);
      setDemoPublic(Boolean(product?.demoPublic));
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
      title="OpenClaw gateway first, CLI when the execution gate is on."
      hint="Send calls OPENCLAW_GATEWAY_URL /chat/completions when that URL is set. If the gateway is missing, a live CLI run needs HERMES_AGENT_OS_ENABLE_EXEC=1. OmniRoute is the labeled fallback."
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
          <strong>In Unified Chat</strong>
          <small>The OpenClaw seat uses the gateway, then the CLI, then OmniRoute.</small>
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
      <div className="aos-panel">
        <div className="aos-panel-head">
          <div>
            <span>OPENCLAW MESSAGE</span>
            <h2>Send to OpenClaw</h2>
          </div>
        </div>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={demoPublic ? "Gallery mode does not call OpenClaw" : "Ask the OpenClaw gateway"} />
        {demoPublic ? <p className="aos-honest-note">Public gallery does not call the OpenClaw gateway.</p> : null}
        <div className="aos-chat-actions">
          <button
            className="aos-primary"
            disabled={busy || !draft.trim() || demoPublic}
            onClick={() => {
              setBusy(true);
              void sendLiveChat({ agentId: "openclaw", message: draft.trim(), dryRun: false })
                .then((result) => {
                  setReply(result.reply || "No reply.");
                  setTransport(liveTurnLabel(result));
                })
                .catch((caught) => setReply(caught instanceof Error ? caught.message : "OpenClaw send failed."))
                .finally(() => setBusy(false));
            }}
          >
            Send live
          </button>
          <button
            className="aos-secondary"
            disabled={busy || !draft.trim() || demoPublic}
            onClick={() => {
              setBusy(true);
              void sendLiveChat({ agentId: "openclaw", message: draft.trim(), dryRun: true })
                .then((result) => {
                  setReply(result.reply || "No plan.");
                  setTransport(liveTurnLabel(result));
                })
                .catch((caught) => setReply(caught instanceof Error ? caught.message : "Dry-run failed."))
                .finally(() => setBusy(false));
            }}
          >
            Dry-run plan
          </button>
        </div>
        {transport ? <p className="aos-honest-note">Transport: {transport}</p> : null}
        {reply ? <p>{reply}</p> : null}
      </div>
      <div className="aos-mission-footer aos-v1-cta">
        <button className="aos-primary" onClick={() => navigateTo("mission")}>Back to Mission Control</button>
        <button className="aos-secondary" onClick={() => navigateTo("chat", { agent: "openclaw" })}>
          <MessageSquare size={16} /> Open Unified Chat
        </button>
      </div>
    </PageFrame>
  );
}
