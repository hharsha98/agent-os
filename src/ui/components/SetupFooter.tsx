// The footer every Setup step ends with. It is the last child of the step panel
// and sticks to the bottom of the window while the step scrolls. The note is a
// polite status line, so "Install finished." is announced when it changes.
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

export default function SetupFooter({
  onBack,
  backDisabled = false,
  note,
  children
}: {
  onBack?: () => void;
  backDisabled?: boolean;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <footer className="os-setup-foot">
      {onBack ? (
        <button type="button" className="os-btn os-btn--ghost os-setup-foot__back" onClick={onBack} disabled={backDisabled}>
          <ChevronLeft size={16} aria-hidden="true" />
          Back
        </button>
      ) : null}
      <span className="os-setup-foot__note" role="status">
        {note}
      </span>
      <div className="os-setup-foot__actions">{children}</div>
    </footer>
  );
}
