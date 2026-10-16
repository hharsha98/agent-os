// A small, accessible confirm modal shared by every side-effectful action on
// the Agents and Runs screens (launch, service start/stop/restart, a safety
// fix, stopping a run): Escape closes it, Tab stays trapped inside, and
// focus returns to whatever opened it. Deliberately not shared with the
// Setup screen's own modal (a separate worker owns that file).
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

// What Tab can really reach inside the dialog: not disabled, not taken out of the tab order and drawn on screen.
// FOCUSABLE alone also matches a button with tabindex -1 (the New session dialog's agent buttons keep tabindex -1
// on every one but the picked one, a "roving tabindex"), and counting that one as the first or last control let
// Shift+Tab leave the dialog for the page behind it.
function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.getClientRects().length > 0
  );
}

export default function AgentConfirmModal({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  confirmDisabled = false,
  busy = false,
  danger = false,
  wide = false,
  closeOnBackdrop = true,
  cancelLabel = "Cancel",
  giveFocusBack = () => true
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  confirmDisabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  wide?: boolean;
  // false for a dialog that holds something the person typed: a press on the dimmed page then does nothing
  // (Escape and Cancel still ask the dialog to close).
  closeOnBackdrop?: boolean;
  // The words on the button that closes without acting ("Keep running", "Keep it running").
  cancelLabel?: string;
  // Asked as the dialog goes away: false leaves the focus where it fell (the New session dialog, once a session
  // started, must not give the keys back to the terminal that was open before it).
  giveFocusBack?: () => boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Its own title id, so two of these dialogs open at once (the update banner's quit question and the
  // shell's) each point at their own title.
  const titleId = useId();
  // The press must start AND end on the dimmed page to count as a click outside, so a drag that
  // began inside the dialog (selecting text) and let go outside never closes it.
  const pressedOnBackdrop = useRef(false);
  const previouslyFocused = useRef<Element | null>(null);
  const giveBack = useRef(giveFocusBack);
  giveBack.current = giveFocusBack;

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const first = dialogRef.current ? tabbable(dialogRef.current)[0] : undefined;
    first?.focus();
    return () => {
      if (giveBack.current()) (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Every open dialog listens here; only the topmost one (the last in the page) answers, so a question drawn
        // over another dialog closes alone.
        const dialogs = document.querySelectorAll('[aria-modal="true"]');
        if (dialogs[dialogs.length - 1] !== dialogRef.current) return;
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = tabbable(dialogRef.current);
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
    <div
      className="os-modal__backdrop"
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const outside = pressedOnBackdrop.current && e.target === e.currentTarget;
        pressedOnBackdrop.current = false;
        if (closeOnBackdrop && outside) onClose();
      }}
    >
      <div className={`os-modal${wide ? " os-modal--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <h2 id={titleId} className="os-modal__title">
          {title}
        </h2>
        <div className="os-modal__body">{children}</div>
        <div className="os-modal__actions">
          <button type="button" className="os-btn os-btn--ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`os-btn ${danger ? "os-btn--danger" : "os-btn--primary"}`}
            onClick={onConfirm}
            disabled={confirmDisabled || busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
