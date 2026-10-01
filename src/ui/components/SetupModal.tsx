// A small, accessible confirm modal shared by the Setup Assistant's
// confirmation moments (install, apply brain config). Escape closes it, Tab
// stays trapped inside, and focus returns to whatever opened it.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function SetupModal({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  confirmDisabled = false,
  busy = false,
  error = ""
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  confirmDisabled?: boolean;
  busy?: boolean;
  // A server refusal shown inside the dialog, so the person can read it
  // and fix it without the dialog vanishing first.
  error?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute("disabled")
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="os-setup-modal__backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="os-setup-modal" role="dialog" aria-modal="true" aria-labelledby="os-setup-modal-title" ref={dialogRef}>
        <h2 id="os-setup-modal-title" className="os-setup-modal__title">
          {title}
        </h2>
        <div className="os-setup-modal__body">{children}</div>
        {error ? (
          <p className="os-setup-modal__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="os-setup-modal__actions">
          <button type="button" className="os-btn os-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="os-btn os-btn--primary" onClick={onConfirm} disabled={confirmDisabled || busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
