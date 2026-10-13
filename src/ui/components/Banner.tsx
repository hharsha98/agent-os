import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, XCircle } from "lucide-react";

// A notice with an icon, a short title, some words and, if needed, buttons.
// The tone picks the icon and the wash. The tone is never the only signal:
// the icon shape and the words say it too. Info and ok are polite messages
// (role="status"); warn and danger interrupt (role="alert").
export type BannerTone = "info" | "ok" | "warn" | "danger";

const ICONS = { info: Info, ok: CheckCircle2, warn: CircleAlert, danger: XCircle } as const;

export interface BannerProps {
  tone: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}

export default function Banner({ tone, title, children, actions }: BannerProps) {
  const Icon = ICONS[tone];
  const role = tone === "warn" || tone === "danger" ? "alert" : "status";
  return (
    <div className={`os-banner os-banner--${tone}`} role={role}>
      <Icon className="os-banner__icon" size={20} aria-hidden="true" />
      <div className="os-banner__text">
        {title ? <p className="os-banner__title">{title}</p> : null}
        {children ? <div className={`os-banner__body${title ? "" : " os-banner__body--plain"}`}>{children}</div> : null}
      </div>
      {actions ? <div className="os-banner__actions">{actions}</div> : null}
    </div>
  );
}
