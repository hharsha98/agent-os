// One turn of the conversation, drawn as a row of the timeline. Agent text is
// untrusted: it is only ever rendered as plain React text inside a pre-wrap
// block, never as HTML.
import { useState } from "react";
import { Activity } from "lucide-react";
import { navigateTo } from "../../nav";
import {
  agentLabel,
  agentMaker,
  clockTime,
  hasTag,
  tagLabel,
  turnCostLabel,
  turnMissingText,
  turnStatusView,
  type TurnPhase,
  type TurnView
} from "../teamRoomShared";
import RunConsole from "./RunConsole";
import StatusWord from "./StatusWord";

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

export default function TeamRoomTurn({
  turn,
  phase,
  roomRunning,
  turnsAllowed
}: {
  turn: TurnView;
  phase: TurnPhase;
  roomRunning: boolean;
  turnsAllowed: number;
}) {
  const ended = turn.ended;
  const live = phase === "live";
  // In progress either way: the room names this run (live), or it is the latest turn of a running room (working).
  const inProgress = phase === "live" || phase === "working";
  const status = turnStatusView(ended?.status);
  const failed = status?.state === "failed";
  const model = typeof ended?.model === "string" && ended.model ? ended.model : null;
  const costKnown = typeof ended?.costUsd === "number";
  const tools = ended?.toolSummary || null;
  const tagged = hasTag(ended?.parsed);
  const maker = agentMaker(turn.agentId);

  return (
    <li className={`os-team__item${inProgress ? " is-live" : ""}${failed ? " is-failed" : ""}`}>
      <span className="os-team__node os-mono" aria-hidden="true">
        {turn.turn}
      </span>
      <div className="os-team__item-body">
        <div className="os-team__item-head">
          <b className="os-team__who-name">{agentLabel(turn.agentId)}</b>
          {maker ? <span className="os-team__maker">{maker}</span> : null}
          {status ? <StatusWord state={status.state} label={status.label} /> : null}
          {phase === "working" ? <StatusWord state="live" label="Working…" /> : null}
          {ended ? (
            <time className="os-team__time os-mono" dateTime={ended.t} title="When this turn ended">
              {clockTime(ended.t)}
            </time>
          ) : null}
        </div>

        {ended ? (
          <>
            {ended.text ? <ClampText text={ended.text} className="os-team__msg" /> : <p className="os-team__muted">This turn produced no text.</p>}
            <div className="os-team__foot">
              <span className={`os-chip os-team__tag${tagged ? "" : " os-team__tag--none"}`}>{tagLabel(ended.parsed)}</span>
              {model ? (
                <span className="os-mono os-team__small" title="The model that answered this turn">
                  {model}
                </span>
              ) : null}
              <span
                className="os-mono os-team__small"
                title={costKnown ? undefined : "This turn didn't report a cost"}
              >
                {turnCostLabel(ended.costUsd, model)}
              </span>
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
            {tools && tools.calls > 0 ? (
              <p className="os-team__muted">
                {tools.failures > 0
                  ? `Tried ${tools.calls} tool call${tools.calls === 1 ? "" : "s"}; ${tools.failures} failed.`
                  : `Used ${tools.calls} tool call${tools.calls === 1 ? "" : "s"}.`}
              </p>
            ) : null}
            {ended.parsed?.problem ? <p className="os-team__protocol">{ended.parsed.problem}</p> : null}
            {turn.protocolNotes.map((note, index) => (
              <p key={index} className="os-team__protocol">
                {note}
              </p>
            ))}
          </>
        ) : inProgress ? (
          <>
            <p className="os-team__typing">
              <Activity size={16} aria-hidden="true" />
              <span>
                <b>{agentLabel(turn.agentId)}</b> is writing turn {turn.turn} of {turnsAllowed}.
              </span>
            </p>
            {live ? (
              <div className="os-team__turn-live">
                <RunConsole runId={turn.runId} compact />
              </div>
            ) : null}
          </>
        ) : (
          <p className="os-team__muted">{turnMissingText(roomRunning)}</p>
        )}
      </div>
    </li>
  );
}
