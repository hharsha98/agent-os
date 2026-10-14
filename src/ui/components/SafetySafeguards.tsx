// "Safeguards that are always working": a kit table. The first rows are true at every level (see
// ALWAYS_ON in safetyShared.ts), then machine control, then the real per-agent checks for Hermes and
// OpenClaw, read from each agent's own GET /api/agents/:id safety detail. This screen never offers
// the fix buttons itself (the Agents page owns those), only a way there.
import type { CSSProperties } from "react";
import type { AgentDetail } from "../../setupApi";
import { agentGuardRows, ALWAYS_ON, guardRowLabel, staleWords } from "../safetyShared";
import type { GuardChecked, GuardState } from "../safetyShared";
import Banner from "./Banner";
import StatusWord from "./StatusWord";

const COLS = { "--os-table-cols": "minmax(0, 1fr) 150px 170px" } as CSSProperties;

function GuardStatus({ state }: { state: GuardState }) {
  if (state === "on") return <StatusWord state="ready" label="On" />;
  if (state === "off") return <StatusWord state="waiting" label="Off" />;
  if (state === "missing") return <StatusWord state="idle" label="Not installed" />;
  return <StatusWord state={state === "loading" ? "loading" : "unknown"} />;
}

export default function SafetySafeguards({
  hermes,
  openclaw,
  checked,
  staleAgents = [],
  machine,
  onOpenAgent
}: {
  hermes: AgentDetail | null;
  openclaw: AgentDetail | null;
  // Whether each agent's first read has finished (it may have failed).
  checked: GuardChecked;
  // The names of the agents whose later read failed, so their rows hold the last good answer.
  staleAgents?: string[];
  // `known` is false until the safety level has been read: the row then claims nothing.
  // `lost` is true while contact with Agent OS is lost: "on" is then the last known state, with no countdown.
  machine: { on: boolean; countdown: string; known?: boolean; lost?: boolean };
  onOpenAgent: (agentId: string) => void;
}) {
  const rows = agentGuardRows(hermes, openclaw, checked);
  const machineKnown = machine.known !== false;
  return (
    <section className="os-saf-section" aria-labelledby="os-saf-guards-title">
      <div className="os-saf-section__head">
        <h2 id="os-saf-guards-title">Safeguards that are always working</h2>
        <p className="os-saf-section__quiet">Each one shows its status</p>
      </div>
      {staleAgents.length > 0 ? <Banner tone="warn">{staleWords(staleAgents)}</Banner> : null}
      <div className="os-table os-saf-guards" role="table" aria-label="Safeguards" style={COLS}>
        <div className="os-table__head" role="row">
          <span className="os-table__cell" role="columnheader">Safeguard</span>
          <span className="os-table__cell" role="columnheader">Applies to</span>
          <span className="os-table__cell" role="columnheader">Status</span>
        </div>
        {ALWAYS_ON.map((row) => (
          <div key={row.title} className="os-table__row" role="row">
            <div className="os-table__cell" role="cell">
              <span className="os-table__title">{row.title}</span>
              <span className="os-table__sub">{row.detail}</span>
            </div>
            <div className="os-table__cell" role="cell">{row.who}</div>
            <div className="os-table__cell" role="cell"><StatusWord state="ready" label="Always on" /></div>
          </div>
        ))}
        <div className="os-table__row" role="row">
          <div className="os-table__cell" role="cell">
            <span className="os-table__title">Machine control</span>
            <span className="os-table__sub">
              {!machineKnown
                ? "Needs Level 2 and a typed phrase, and turns itself off after 30 minutes."
                : machine.on
                  ? "Agent OS can see the screen and use the mouse and keyboard in other apps until the timer runs out."
                  : "Agent OS cannot see the screen or use the mouse and keyboard in other apps. It needs Level 2 and a typed phrase, and turns itself off after 30 minutes."}
            </span>
          </div>
          <div className="os-table__cell" role="cell">Agent OS</div>
          <div className="os-table__cell" role="cell">
            {!machineKnown ? (
              <StatusWord state="unknown" />
            ) : machine.on ? (
              <StatusWord state="waiting" label={machine.lost ? "On when last checked" : `On, ${machine.countdown} left`} />
            ) : (
              <StatusWord state="idle" label="Off" />
            )}
          </div>
        </div>
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className="os-table__row"
            role="row"
            aria-label={guardRowLabel(row)}
            onClick={() => onOpenAgent(row.agentId)}
          >
            <span className="os-table__cell" role="cell">
              <span className="os-table__title">{row.title}</span>
              <span className="os-table__sub">{row.sub}</span>
            </span>
            <span className="os-table__cell" role="cell">{row.name}</span>
            <span className="os-table__cell" role="cell"><GuardStatus state={row.state} /></span>
          </button>
        ))}
      </div>
    </section>
  );
}
