// The confirm step before a held session keeps going on OpenRouter (spec "SP4 Session extras", Plan ran out, keep
// going; the prototype's keepGoingDialog() in sessions.html): title "Keep going on OpenRouter?", the points "Same
// conversation" (Codex: "Typed for you, not sent", because its keep going is a new conversation), "Pay per use" and
// "Your call", then Cancel and Keep going on OpenRouter. The cost is continue.js's own estimate of what starting
// costs. Nothing starts, and nothing is spent, until the button is pressed.
import { CircleCheck, Gauge, MessageSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { KeepGoingInfo } from "../../types";
import { keepGoingDialogCopy } from "../keepGoingShared";
import type { KeepGoingPoint } from "../keepGoingShared";
import AgentConfirmModal from "./AgentConfirmModal";

const POINT_ICONS: Record<KeepGoingPoint["key"], LucideIcon> = {
  same: MessageSquare,
  typed: MessageSquare,
  pay: Gauge,
  call: CircleCheck
};

export default function KeepGoingDialog({
  info,
  agentLabel,
  busy,
  error,
  onConfirm,
  onClose,
  giveFocusBack
}: {
  info: KeepGoingInfo;
  agentLabel: string;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
  giveFocusBack: () => boolean;
}) {
  const copy = keepGoingDialogCopy(info, agentLabel);
  return (
    <AgentConfirmModal
      title={copy.title}
      confirmLabel={copy.confirm}
      cancelLabel={copy.cancel}
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
      giveFocusBack={giveFocusBack}
    >
      {/* The body scrolls inside the dialog when the window is short (1280 by 720, split view), so Cancel and the main
          button stay on screen (fix round 1, M8). */}
      <div className="os-keepgoing__scroll">
        <p>{copy.lede}</p>
        <ul className="os-keepgoing__points">
          {copy.points.map((point) => {
            const Icon = POINT_ICONS[point.key];
            return (
              <li key={point.key}>
                <Icon size={18} aria-hidden="true" />
                <span>
                  <strong>{point.label}</strong> {point.text}
                </span>
              </li>
            );
          })}
        </ul>
        {copy.model ? (
          <p className="os-keepgoing__model">
            Model <code className="os-mono">{copy.model}</code>
          </p>
        ) : null}
        {copy.note ? <p className="os-keepgoing__note">{copy.note}</p> : null}
        {copy.warnings.length ? (
          <ul className="os-keepgoing__warnings">
            {copy.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {copy.stays ? <p>{copy.stays}</p> : null}
        {error ? (
          <p className="os-sess__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AgentConfirmModal>
  );
}
