// One turn of the conversation. Agent text is untrusted: it is only ever
// rendered as plain React text inside a pre-wrap block, never as HTML.
import { useState } from "react";
import { navigateTo } from "../../nav";
import { runStatusMark } from "../fleetShared";
import { statusLabel } from "../runsShared";
import { agentLabel, tagLabel, usd, type TurnView } from "../teamRoomShared";
import RunConsole from "./RunConsole";
import StatusMark from "./StatusMark";

const COLLAPSE_CHARS = 600;
const COLLAPSE_LINES = 10;

// Long text collapses behind "Show all" so one chatty turn can't bury the rest.
export function ClampText({ text, className = "" }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE_CHARS || text.split("\n").length > COLLAPSE_LINES;
  return (
    <div className={className}>
      <div className={`os-team__text${long && !open ? " os-team__text--clamped" : ""}`}>{text}</div>
      {long ? (
        <button type="button" className="os-team__link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

export default function TeamRoomTurn({ turn, live }: { turn: TurnView; live: boolean }) {
  const ended = turn.ended;
  const status = ended?.status || (live ? "running" : "");
  const parsedTag = tagLabel(ended?.parsed);
  const noTag = parsedTag === "no tag";
  const costKnown = typeof ended?.costUsd === "number";

  return (
    <article
      className={`os-team__turn os-team__turn--${turn.agentId}${live ? " os-team__turn--live" : ""}`}
      aria-label={`Turn ${turn.turn}, ${agentLabel(turn.agentId)}`}
      style={{ order: turn.turn }}
    >
      <header className="os-team__turn-head">
        <span className="os-team__turn-agent">{agentLabel(turn.agentId)}</span>
        <span className="os-mono os-team__turn-num">turn {turn.turn}</span>
        <span className="os-team__turn-status">
          <StatusMark
            kind={status ? runStatusMark(status) : "unknown"}
            label={status ? statusLabel(status) : "No result recorded"}
          />
          {status ? statusLabel(status) : "No result"}
        </span>
        <span
          className="os-mono os-team__turn-cost"
          title={costKnown ? undefined : ended ? "this turn didn't report a cost" : "cost is known when the turn ends"}
        >
          {usd(ended?.costUsd)}
        </span>
      </header>

      {ended ? (
        <>
          {ended.text ? (
            <ClampText text={ended.text} />
          ) : (
            <p className="os-team__muted">This turn produced no text.</p>
          )}
          <div className="os-team__turn-foot">
            <span className={`os-chip os-team__tag${noTag ? " os-team__tag--none" : ""}`}>{parsedTag}</span>
            <a
              className="os-team__link"
              href={`?page=runs&run=${encodeURIComponent(turn.runId)}`}
              onClick={(event) => {
                event.preventDefault();
                navigateTo("runs", { run: turn.runId });
              }}
            >
              Open this run
            </a>
          </div>
          {ended.parsed?.problem ? <p className="os-team__protocol">{ended.parsed.problem}</p> : null}
          {turn.protocolNotes.map((note, index) => (
            <p key={index} className="os-team__protocol">
              {note}
            </p>
          ))}
        </>
      ) : live ? (
        <div className="os-team__turn-live">
          <RunConsole runId={turn.runId} compact />
        </div>
      ) : (
        <p className="os-team__muted">This turn never reported back (the room stopped first).</p>
      )}
    </article>
  );
}
