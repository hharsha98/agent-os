import { useEffect } from "react";
import { CheckCircle2, CircleAlert, Info, X, XCircle } from "lucide-react";

// A short result message at the bottom of the window. Announced politely to
// screen readers, closes itself after 8 seconds, or with its close button.
const ICONS = { ok: CheckCircle2, warn: CircleAlert, danger: XCircle, neutral: Info } as const;

interface ToastProps {
  message: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  onClose: () => void;
}

export default function Toast({ message, tone, onClose }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 8000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  const Icon = ICONS[tone];
  return (
    <div className={`os-toast os-toast--${tone}`} role="status" aria-live="polite">
      <Icon size={16} aria-hidden="true" />
      <span className="os-toast__text">{message}</span>
      <button type="button" className="os-toast__close" aria-label="Close message" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
