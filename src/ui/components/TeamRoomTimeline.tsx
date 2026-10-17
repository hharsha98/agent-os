// The conversation of a room, in turn order, with a short line wherever Agent OS
// or you did something (an agreement that waits for you, an approval, an undo).
import { FileText, ListPlus, MessagesSquare, ShieldCheck, Undo2 } from "lucide-react";
import { latestStartedTurn, turnPhase, type TimelineItem } from "../teamRoomShared";
import EmptyState from "./EmptyState";
import TeamRoomTurn from "./TeamRoomTurn";

const SYSTEM_ICON = { ask: FileText, plain: ShieldCheck, undo: Undo2, more: ListPlus } as const;

export default function TeamRoomTimeline({
  items,
  running,
  currentRunId,
  turnsAllowed
}: {
  items: TimelineItem[];
  running: boolean;
  currentRunId: string | null;
  turnsAllowed: number;
}) {
  if (items.length === 0) {
    return running ? (
      <EmptyState icon={MessagesSquare} title="Waiting for the first turn…" body="Hermes Agent speaks first. Its message will appear here." />
    ) : (
      <EmptyState icon={MessagesSquare} title="No turns were recorded" body="This room ended before any agent answered." />
    );
  }
  const latestTurn = latestStartedTurn(items);
  return (
    <ol className="os-team__timeline" aria-label="Messages in turn order">
      {items.map((item) => {
        if (item.kind === "turn") {
          return (
            <TeamRoomTurn
              key={item.key}
              turn={item.turn}
              turnsAllowed={turnsAllowed}
              roomRunning={running}
              phase={turnPhase(item.turn, { running, currentRunId, latestTurn })}
            />
          );
        }
        const Icon = SYSTEM_ICON[item.tone];
        return (
          <li key={item.key} className={`os-team__item os-team__item--system is-${item.tone}`}>
            <span className="os-team__node" aria-hidden="true">
              <Icon size={16} />
            </span>
            <p className="os-team__sys">
              <b>{item.who}:</b> {item.text}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
