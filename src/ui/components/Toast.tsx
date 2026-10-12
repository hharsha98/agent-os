import { useEffect, useRef } from "react";
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
  // The parent may pass a new onClose on every render. Keeping the latest one in
  // a ref lets the 8 second timer depend on the message only, so a re-render
  // (for example the status poll) never restarts it.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => onCloseRef.current(), 8000);
    return () => window.clearTimeout(timer);
  }, [message]);
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
