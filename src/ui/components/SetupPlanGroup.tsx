// One group on the Plan step ("Always-on agents" or "Coding agents"): a heading
// with a one-line description, the group's own action button (it sits in the
// heading, so it is on screen without scrolling), an optional status line, and a
// table with one row per agent. The rows are SetupPlanRow children.
import type { CSSProperties, ReactNode } from "react";

const COLUMNS = "minmax(132px, 176px) 172px minmax(0, 1fr)";

export default function SetupPlanGroup({
  id,
  title,
  sub,
  description,
  actionLabel,
  onAction,
  actionDisabled = false,
  hint,
  note,
  children
}: {
  id: string;
  title: string;
  // The agents in the group, e.g. "Hermes · OpenClaw".
  sub: string;
  description: string;
  // No label means nothing to do for this group, so no button.
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  // A short line under the button, e.g. why it is disabled.
  hint?: string;
  // One status line under the heading (sizes, "nothing to install").
  note?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `os-setup-group-${id}`;
  return (
    <section className="os-setup-group" aria-labelledby={headingId}>
      <header className="os-setup-group__head">
        <div className="os-setup-group__titles">
          <h3 id={headingId}>{title}</h3>
          <span className="os-setup-group__sub">{sub}</span>
          <p>{description}</p>
        </div>
        {actionLabel ? (
          <div className="os-setup-group__action">
            <button type="button" className="os-btn os-btn--primary" onClick={onAction} disabled={actionDisabled}>
              {actionLabel}
            </button>
            {hint ? <span className="os-setup-group__hint">{hint}</span> : null}
          </div>
        ) : null}
      </header>
      {note ? (
        <p className="os-setup-group__note" role="status">
          {note}
        </p>
      ) : null}
      <div className="os-table os-setup-table" role="table" aria-label={`${title}: your choices`} style={{ "--os-table-cols": COLUMNS } as CSSProperties}>
        <div className="os-table__head" role="row">
          {["Agent", "Your choice", "What happens"].map((heading) => (
            <span key={heading} className="os-table__cell os-micro" role="columnheader">
              {heading}
            </span>
          ))}
        </div>
        {children}
      </div>
    </section>
  );
}
