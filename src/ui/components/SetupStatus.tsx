// An icon plus a word for one result on the Setup page: "Found", "Installed",
// "Signed in". Never colour alone. The word is always in full ink; only the icon
// carries the tone. "info" and "unknown" are neutral grey, because cobalt is only
// for the live state (work in progress), the main button and the focus ring.
import type { ReactNode } from "react";
import { Activity, Circle, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

export type SetupTone = "ok" | "info" | "warn" | "error" | "unknown" | "live";

const ICONS = {
  ok: CircleCheck,
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert,
  unknown: Circle,
  live: Activity
} as const;

export default function SetupStatus({ tone, children }: { tone: SetupTone; children: ReactNode }) {
  const Icon = ICONS[tone];
  return (
    <span className={`os-setup-status os-setup-status--${tone}`}>
      <Icon size={16} aria-hidden="true" />
      <span className="os-setup-status__word">{children}</span>
    </span>
  );
}
