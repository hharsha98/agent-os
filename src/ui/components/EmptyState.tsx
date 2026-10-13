import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

// A designed "nothing here yet": a dashed outline, an icon, a title, a line of
// help and, if there is something to do, one button. It is not a heading, so
// it never changes the page's heading outline.
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}

export default function EmptyState({ icon: Icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="os-empty">
      <Icon className="os-empty__icon" size={22} aria-hidden="true" />
      <div className="os-empty__text">
        <p className="os-empty__title">{title}</p>
        {body ? <div className="os-empty__body">{body}</div> : null}
      </div>
      {action ? <div className="os-empty__action">{action}</div> : null}
    </div>
  );
}
