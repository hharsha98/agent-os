// One level plate on the Safety "arming panel": styled like a physical
// switch plate. The current level is lit (accent top light + glow) AND says
// "Active" in words with a filled mark, so the state never rests on
// brightness alone; the others stay dim. Content is real server truth
// (gate/machineControl), never a static description dressed up as live state.
import type { CSSProperties, ReactNode } from "react";
import StatusMark from "./StatusMark";

export default function SafetyPlate({
  level,
  title,
  lines,
  active,
  activeLabel = "Active",
  accent = "accent",
  disabled,
  action,
  children
}: {
  level: 0 | 1 | 2;
  title: string;
  lines: string[];
  active: boolean;
  activeLabel?: string;
  accent?: "accent" | "warn";
  disabled?: boolean;
  action?: { label: string; onClick: () => void; busy?: boolean } | null;
  children?: ReactNode;
}) {
  const style = active ? ({ "--os-plate-c": accent === "warn" ? "var(--os-warn)" : "var(--os-accent)" } as CSSProperties) : undefined;
  return (
    <section
      className={`os-panel os-safety-plate os-safety-plate--${active ? "lit" : "dim"}${accent === "warn" ? " os-safety-plate--warn" : ""}${disabled ? " os-safety-plate--disabled" : ""}`}
      style={style}
      aria-current={active ? "true" : undefined}
      aria-label={`Level ${level}: ${title}${active ? ` (${activeLabel.toLowerCase()})` : ""}`}
    >
      <div className="os-safety-plate__toplight" />
      <header className="os-safety-plate__head">
        <span className="os-micro">LEVEL {level}</span>
        <h2>{title}</h2>
        {active ? (
          <span className="os-safety-plate__tag">
            <StatusMark kind={accent === "warn" ? "warn" : "ok"} />
            {activeLabel}
          </span>
        ) : null}
      </header>
      <ul className="os-safety-plate__lines">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {children}
      {action ? (
        <button type="button" className="os-btn os-btn--secondary os-safety-plate__action" onClick={action.onClick} disabled={disabled || action.busy}>
          {action.label}
        </button>
      ) : null}
    </section>
  );
}
