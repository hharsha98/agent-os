// Cursor's "Hand to Claude Code or Codex" (spec "SP4 Session extras", Plan ran out, keep going): Cursor sends no limit
// signal, so this is a button in its Hand-off section, there at any time while the session runs. After the confirm,
// the server types a summary of Cursor's last screen into an open Claude Code or Codex session in this folder that can
// take typed text, or into a new one there (hand-off write rules; never sent). The answer opens that session's tab, or
// shows the text to copy with the reason (X8's Copy fallback). A "copy" answer with no reason of its own means the
// agent missed its moment, so this file fills in X8's sentence for the chosen agent (handoffCopyReason).
import { useEffect, useRef, useState } from "react";
import { navigateTo } from "../../nav";
import { handOver, sessionProblem } from "../../sessionsApi";
import type { SessionSummary } from "../../types";
import { handoffCopyReason } from "../handoffShared";
import {
  HAND_OVER_BODY,
  HAND_OVER_CONFIRM,
  HAND_OVER_LABEL,
  HAND_OVER_TARGETS,
  HAND_OVER_TITLE,
  canHandOver,
  handOverOutcome
} from "../keepGoingShared";
import type { HandOverOutcome, HandOverTarget } from "../keepGoingShared";
import { askToFocusNextSession } from "../newSession";
import { useSessionsList } from "../useSessionsList";
import AgentConfirmModal from "./AgentConfirmModal";
import HandoffCopyFallback from "./HandoffCopyFallback";

// The chosen agent's short name ("Claude Code" or "Codex"), for X8's Copy fallback sentence.
function targetLabel(to: HandOverTarget): string {
  return HAND_OVER_TARGETS.find((target) => target.id === to)?.label ?? to;
}

export default function HandOverButton({ session }: { session: SessionSummary }) {
  const { refresh } = useSessionsList();
  const [asking, setAsking] = useState(false);
  const [to, setTo] = useState<HandOverTarget>("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copy, setCopy] = useState<HandOverOutcome["copy"]>(null);
  const alive = useRef(true);
  // True once a session was opened: the dialog then leaves the focus to that session's terminal.
  const opened = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A dialog or Copy text belongs to one running Cursor session: another session, or this one ending (then resumed
  // later), starts clean (fix round 1, M4), so nothing pops up by itself after a Resume.
  const handable = canHandOver(session);
  useEffect(() => {
    setAsking(false);
    setError("");
    setCopy(null);
  }, [session.id, handable]);

  if (!handable) return null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const outcome = handOverOutcome(await handOver(session.id, to));
      if (!alive.current) return;
      opened.current = outcome.open !== null;
      setAsking(false);
      setCopy(outcome.copy ? { text: outcome.copy.text, reason: outcome.copy.reason ?? handoffCopyReason(targetLabel(to)) } : null);
      if (outcome.open) {
        askToFocusNextSession();
        navigateTo("sessions", { session: outcome.open });
      }
      refresh();
    } catch (err) {
      if (alive.current) setError(sessionProblem(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="os-handover">
      <button
        type="button"
        className="os-btn os-btn--secondary os-handover__open"
        onClick={() => {
          opened.current = false;
          setError("");
          setCopy(null);
          setAsking(true);
        }}
      >
        {HAND_OVER_LABEL}
      </button>
      {copy ? <HandoffCopyFallback text={copy.text} reason={copy.reason} /> : null}
      {asking ? (
        <AgentConfirmModal
          title={HAND_OVER_TITLE}
          confirmLabel={HAND_OVER_CONFIRM}
          busy={busy}
          onConfirm={() => void confirm()}
          onClose={() => {
            if (!busy) setAsking(false);
          }}
          giveFocusBack={() => !opened.current}
        >
          <p>{HAND_OVER_BODY}</p>
          <fieldset className="os-handover__choices" aria-label={HAND_OVER_LABEL}>
            {HAND_OVER_TARGETS.map((target) => (
              <label key={target.id} className="os-handover__choice">
                <input
                  type="radio"
                  name={`os-handover-${session.id}`}
                  value={target.id}
                  checked={to === target.id}
                  onChange={() => setTo(target.id)}
                />
                {target.label}
              </label>
            ))}
          </fieldset>
          {error ? (
            <p className="os-sess__error" role="alert">
              {error}
            </p>
          ) : null}
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
