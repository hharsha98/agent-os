// The "Limits" panel of a room: turns, time and cost as three meters, plus the
// two honest notes. While the room is paused for a decision the Time meter
// shows the time stored when it paused and does not tick (D10).
import type { TeamProposal, TeamRoom } from "../../types";
import { costNotReported, minutesLabel, pauseState, roomCostText, roomElapsedMs, usd } from "../teamRoomShared";
import Meter from "./Meter";

export default function TeamRoomLimits({ room, proposals, nowMs }: { room: TeamRoom; proposals?: TeamProposal[]; nowMs: number }) {
  // The note only fits while a card really waits for you; after your decision the
  // clock is still stopped, but nothing waits for you any more.
  const paused = pauseState(room, proposals) === "waiting";
  const elapsedMs = roomElapsedMs(room, nowMs);
  const maxMinutes = room.limits.maxMinutes;
  const timeValue = elapsedMs === null ? null : Math.min(1, elapsedMs / (maxMinutes * 60_000));
  const timeDetail = `${elapsedMs === null ? "—" : minutesLabel(elapsedMs)} of ${maxMinutes}m`;

  const cap = room.limits.maxCostUsd;
  const hasCap = typeof cap === "number";
  const known = room.cost?.knownUsd ?? room.costUsd;
  const noCostYet = costNotReported(room);
  // Until a turn reports a cost the amount is unknown, so the meter and the note
  // under it show "—", never "0%" or "$0.000" (the data map in the brief, and the
  // "copy must be true" rule). The same rule feeds both (costNotReported).
  const costValue = hasCap && !noCostYet && typeof known === "number" ? Math.min(1, known / (cap as number)) : null;
  // Unknown cost: the meter's own "—" is the one dash; the line under it names the cap.
  const costDetail = noCostYet ? (hasCap ? `Cap: $${cap}` : "No cap") : hasCap ? `${usd(known)} of $${cap}` : `${usd(known)} · no cap`;

  const turnsValue = Math.min(1, room.turnsDone / Math.max(room.turnsAllowed, 1));
  return (
    <section className="os-team__limits" aria-labelledby="os-team-limits-h" data-elapsed-ms={elapsedMs === null ? "" : Math.round(elapsedMs)}>
      <h2 id="os-team-limits-h" className="os-team__h">
        Limits
      </h2>
      <div className="os-team__meters">
        <Meter label="Turns" value={turnsValue} detail={`${room.turnsDone} of ${room.turnsAllowed}`} />
        <Meter label="Time" value={timeValue} detail={timeDetail} tone={timeValue !== null && timeValue >= 0.85 ? "warn" : "accent"} />
        <Meter
          label={noCostYet ? "Cost (not reported yet)" : "Cost"}
          value={costValue}
          detail={costDetail}
          tone={costValue !== null && costValue >= 1 ? "danger" : costValue !== null && costValue >= 0.8 ? "warn" : "accent"}
        />
      </div>
      <p
        className="os-team__foot-note os-mono"
        title="Known cost is what the agents reported. A turn that reported none is counted as unknown, never as $0."
      >
        {roomCostText(room)}
      </p>
      {room.costWarning ? <p className="os-team__foot-note">{room.costWarning}</p> : null}
      {paused ? (
        <p className="os-team__foot-note">Paused: the time limit does not run while the room waits for you.</p>
      ) : null}
    </section>
  );
}
