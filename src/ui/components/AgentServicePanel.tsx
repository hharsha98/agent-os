// The hangar's "Background service" panel (hermes, openclaw only): real
// running/stopped + PID, warnings, and the three actions that manage the
// always-on gateway. Each action's run gets a small mini-console (RunConsole
// in compact mode) until it ends, then the panel refetches the real status
// — never optimistic, never "probably stopped by now".
import { useState } from "react";
import { postAgentService } from "../../api";
import type { AgentServiceStatus } from "../../types";
import { friendlyError } from "../agentsShared";
import AgentConfirmModal from "./AgentConfirmModal";
import RunConsole from "./RunConsole";
import StatusMark from "./StatusMark";

type Action = "start" | "stop" | "restart";
const ACTION_LABEL: Record<Action, string> = { start: "Start", stop: "Stop", restart: "Restart" };

function parsePid(text: string | undefined) {
  // Hermes prints "(PID 123)"; OpenClaw's status is JSON with a "pid" field.
  const match = String(text || "").match(/\bPID[:\s]+(\d+)/i) || String(text || "").match(/"pid"\s*:\s*(\d+)/i);
  return match ? match[1] : null;
}

export default function AgentServicePanel({
  agentId,
  label,
  service,
  checked,
  onRefresh,
  failed = false
}: {
  agentId: string;
  label: string;
  service: AgentServiceStatus | null;
  checked: boolean;
  onRefresh: () => void;
  // The detail could not be read (and nothing was read before): the state is shown as "—" (not known), not "…" (loading).
  failed?: boolean;
}) {
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  async function handleConfirm(action: Action) {
    setBusy(true);
    setError("");
    try {
      const run = await postAgentService(agentId, action);
      setActiveRunId(run.id);
      setConfirming(null);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  const pid = parsePid(service?.text);
  const warnings = service?.warnings || [];

  return (
    <section className="os-panel os-service">
      <h3 className="os-service__title">Background service</h3>
      {!checked ? (
        <p className="os-service__status">
          <StatusMark kind="unknown" label={failed ? "Not known" : undefined} /> {failed ? "—" : "…"}
        </p>
      ) : service?.running ? (
        <p className="os-service__status">
          <StatusMark kind={warnings.length ? "warn" : "ok"} />
          Running{pid ? ` · pid ${pid}` : ""}
        </p>
      ) : (
        <p className="os-service__status">
          <StatusMark kind="unknown" /> Stopped
        </p>
      )}
      {warnings.map((warning, index) => (
        <p key={index} className="os-service__warning">
          <StatusMark kind="warn" /> {warning}
        </p>
      ))}

      <div className="os-service__actions">
        {(["start", "stop", "restart"] as Action[]).map((action) => (
          <button
            key={action}
            type="button"
            className="os-btn os-btn--secondary"
            onClick={() => setConfirming(action)}
            disabled={busy || Boolean(activeRunId) || !checked}
          >
            {ACTION_LABEL[action]}
          </button>
        ))}
      </div>
      <p className="os-service__note">
        Keeps running when Agent OS is closed. Hold to stop all does not stop it: use Stop here.
        {!checked ? " Start, Stop and Restart wait until Agent OS can read the service's state." : ""}
      </p>
      {error && !confirming ? <p className="os-launch__error">{error}</p> : null}

      {activeRunId ? (
        <div className="os-service__mini">
          <RunConsole
            runId={activeRunId}
            compact
            onEnded={() => {
              setActiveRunId(null);
              onRefresh();
            }}
          />
        </div>
      ) : null}

      {confirming ? (
        <AgentConfirmModal
          title={`${ACTION_LABEL[confirming]} the background service?`}
          confirmLabel={ACTION_LABEL[confirming]}
          busy={busy}
          onConfirm={() => handleConfirm(confirming)}
          onClose={() => {
            if (busy) return;
            setConfirming(null);
            setError("");
          }}
        >
          <p>
            {label}'s background gateway will {confirming} now.
          </p>
          {error ? <p className="os-launch__error">{error}</p> : null}
        </AgentConfirmModal>
      ) : null}
    </section>
  );
}
