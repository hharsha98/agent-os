import { Activity, CircleCheck, CircleDashed, CircleHelp, CirclePause, CircleStop, CircleX } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// One status vocabulary for every page: an icon and a word, colour only on the
// icon (never colour alone). `label` replaces the word, for example
// <StatusWord state="ready" label="Finished" />. "unknown" shows "—" and
// "loading" shows "…" (no icon); screen readers hear "Status unknown" and
// "Loading".
export type StatusState = "live" | "ready" | "waiting" | "idle" | "held" | "failed" | "stopped" | "unknown" | "loading";

const STATUS: Record<StatusState, { icon: LucideIcon | null; word: string; spoken?: string }> = {
  live: { icon: Activity, word: "Live" },
  ready: { icon: CircleCheck, word: "Ready" },
  waiting: { icon: CircleHelp, word: "Waiting for you" },
  idle: { icon: CircleDashed, word: "Idle" },
  held: { icon: CirclePause, word: "Held" },
  failed: { icon: CircleX, word: "Failed" },
  stopped: { icon: CircleStop, word: "Stopped" },
  unknown: { icon: null, word: "—", spoken: "Status unknown" },
  loading: { icon: null, word: "…", spoken: "Loading" }
};

export interface StatusWordProps {
  state: StatusState;
  label?: string;
}

export default function StatusWord({ state, label }: StatusWordProps) {
  const { icon: Icon, word, spoken } = STATUS[state];
  const custom = typeof label === "string" && label.trim() !== "";
  return (
    <span className={`os-statusword os-statusword--${state}`}>
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      {Icon || custom ? (
        <span>{custom ? label : word}</span>
      ) : (
        <>
          <span aria-hidden="true">{word}</span>
          <span className="os-visually-hidden">{spoken}</span>
        </>
      )}
    </span>
  );
}
