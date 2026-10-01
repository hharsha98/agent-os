// The hangar's Safety panel: the adapter's one-line safety finding plus a
// "Fix" button per available safety action (e.g. OpenClaw's exec-ask,
// no-browser-cookies). A fix's response may carry a gateway-restart
// follow-up run, which gets its own mini-console right after the first one.
import { useState } from "react";
import { Info } from "lucide-react";
import { postAgentSafetyAction } from "../../api";
import type { AgentSafetyAction, AgentSafetyStatus } from "../../types";
import { friendlyError } from "../agentsShared";
import AgentConfirmModal from "./AgentConfirmModal";
import RunConsole from "./RunConsole";
import StatusMark from "./StatusMark";

export default function AgentSafetyPanel({
  agentId,
  safety,
  notes,
  onFixed
}: {
  agentId: string;
  safety: AgentSafetyStatus | null;
  // Calm advisories from the adapter (e.g. OpenClaw's loopback gateway):
  // informational, so they get no warning mark.
  notes: string[];
  onFixed: () => void;
}) {
  const [confirming, setConfirming] = useState<AgentSafetyAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [followUpId, setFollowUpId] = useState<string | null>(null);

  if (!safety) {
    return (
      <section className="os-panel os-agent-safety">
        <h2 className="os-agent-safety__title">Safety</h2>
        <p>…</p>
      </section>
    );
  }

  async function handleConfirm(action: AgentSafetyAction) {
    setBusy(true);
    setError("");
    try {
      const result = await postAgentSafetyAction(agentId, action.id);
      setRunId(result.run.id);
      if (result.followUp) setFollowUpId(result.followUp.id);
      setConfirming(null);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="os-panel os-agent-safety">
      <h2 className="os-agent-safety__title">Safety</h2>
      <p className="os-agent-safety__finding">
        <StatusMark kind={safety.permissive ? "warn" : "ok"} />
        {safety.summary}
      </p>

      {notes.map((note, index) => (
        <p key={index} className="os-agent-safety__note">
          <Info size={14} aria-hidden="true" />
          <span>{note}</span>
        </p>
      ))}

      {safety.actions.map((action) => (
        <div key={action.id} className="os-agent-safety__action">
          <div className="os-agent-safety__action-text">
            <strong>{action.label}</strong>
            {action.description ? <span>{action.description}</span> : null}
          </div>
          <button
            type="button"
            className="os-btn os-btn--secondary"
            onClick={() => setConfirming(action)}
            disabled={busy || Boolean(runId)}
          >
            Fix
          </button>
        </div>
      ))}
      {error && !confirming ? <p className="os-launch__error">{error}</p> : null}

      {runId ? (
        <div className="os-service__mini">
          <RunConsole
            runId={runId}
            compact
            onEnded={() => {
              if (!followUpId) {
                setRunId(null);
                onFixed();
              }
            }}
          />
        </div>
      ) : null}
      {followUpId ? (
        <>
          <p className="os-agent-safety__restart-note">Restarting the gateway so this takes effect…</p>
          <div className="os-service__mini">
            <RunConsole
              runId={followUpId}
              compact
              onEnded={() => {
                setRunId(null);
                setFollowUpId(null);
                onFixed();
              }}
            />
          </div>
        </>
      ) : null}

      {confirming ? (
        <AgentConfirmModal
          title={confirming.label}
          confirmLabel="Fix it"
          busy={busy}
          onConfirm={() => handleConfirm(confirming)}
          onClose={() => {
            if (busy) return;
            setConfirming(null);
            setError("");
          }}
        >
          <p>{confirming.description || confirming.label}</p>
          {error ? <p className="os-launch__error">{error}</p> : null}
        </AgentConfirmModal>
      ) : null}
    </section>
  );
}
