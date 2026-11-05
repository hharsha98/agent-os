// A small, accessible confirm modal shared by the Setup Assistant's
// confirmation moments (install, apply brain config). Escape closes it, Tab
// stays trapped inside, and focus returns to whatever opened it.
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { CircleAlert } from "lucide-react";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function SetupModal({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  confirmDisabled = false,
  showConfirm = true,
  focusWhenOpenerGone,
  cancelLabel = "Cancel",
  confirmTone = "primary",
  busy = false,
  error = ""
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  confirmDisabled?: boolean;
  // False when there is nothing to confirm (a plan that lost its work while the dialog was open): the dialog keeps its
  // text, error and Cancel, and has no confirm button. Every other dialog leaves it on.
  showConfirm?: boolean;
  // Where focus goes when the dialog closes and the element that opened it is no longer in the document. Unset: nothing changes.
  focusWhenOpenerGone?: RefObject<HTMLElement | null>;
  // "Keep going" / "Cancel setup" style pairs read better than two Cancels.
  cancelLabel?: string;
  confirmTone?: "primary" | "danger";
  busy?: boolean;
  // A server refusal shown inside the dialog, so the person can read it
  // and fix it without the dialog vanishing first.
  error?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // When the confirm button goes (nothing left to confirm) the person who pressed it by keyboard has focus on a button that no longer
  // exists, and it falls to the page behind the dialog. If it is outside the dialog then, Cancel takes it. Every other dialog keeps its
  // confirm button, so nothing here runs for them.
  const hadConfirm = useRef(showConfirm);
  useEffect(() => {
    if (hadConfirm.current && !showConfirm && !dialogRef.current?.contains(document.activeElement)) cancelRef.current?.focus();
    hadConfirm.current = showConfirm;
  }, [showConfirm]);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      // Focus goes back to what opened the dialog. When that is no longer in the document (its button went with the work the
      // dialog was about) and the caller named a place, focus goes there instead of falling to the page body. With no such prop, or
      // with the opener still there, nothing differs from before.
      const opener = previouslyFocused.current as HTMLElement | null;
      if (focusWhenOpenerGone && !opener?.isConnected) focusWhenOpenerGone.current?.focus();
      else opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            <CircleAlert size={16} aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
        <div className="os-setup-modal__actions">
          <button type="button" className="os-btn os-btn--ghost" ref={cancelRef} onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          {showConfirm ? (
            <button type="button" className={`os-btn os-btn--${confirmTone}`} onClick={onConfirm} disabled={confirmDisabled || busy}>
              {busy ? "Working…" : confirmLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
