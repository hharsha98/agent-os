// One group on the Plan step ("Operators" or "Coding agents"): a heading, one
// big button that acts on the whole group, and the group's own content below.
// The button sits in the heading, so it is on screen without scrolling even when
// the content under it is tall.
import type { ReactNode } from "react";

export default function SetupGroupPanel({
  kicker,
  title,
  description,
  actionLabel,
  onAction,
  actionDisabled = false,
  hint,
  children
}: {
  kicker: string;
  title: string;
  description: string;
  // No label means there is nothing to do for this group, so no button.
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  // A short line under the button, e.g. why it is disabled.
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="os-panel os-setup-group" aria-label={title}>
      <header className="os-setup-group__head">
        <div className="os-setup-group__titles">
          <span className="os-micro">{kicker}</span>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {actionLabel ? (
          <div className="os-setup-group__action">
            <button type="button" className="os-btn os-btn--primary os-setup-group__button" onClick={onAction} disabled={actionDisabled}>
              {actionLabel}
            </button>
            {hint ? <span className="os-setup__hint">{hint}</span> : null}
          </div>
        ) : null}
      </header>
      {children}
    </section>
  );
}
