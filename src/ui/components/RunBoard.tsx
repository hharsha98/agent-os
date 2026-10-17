// The Runs board: three bays (Active, Held, Landed) of strips, one strip per real run. A strip is a
// card with a coloured tab on its left, drawn as a shape in runs.css (never a thick coloured border),
// the state as an icon plus a word, and one button. A Held strip also carries the choices for carrying on.
import { Activity, CircleCheck, CircleDashed, CirclePause, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RunMeta } from "../../types";
import { AGENT_LABEL } from "../agentsShared";
import { costLabel, durationLabel } from "../fleetShared";
import { landedNote, splitBays, stateOf, taskText } from "../runsBoard";
import type { BayId } from "../runsBoard";
import EmptyState from "./EmptyState";
import RelativeTime, { TimeAgo } from "./RelativeTime";
import RunLimitBanner from "./RunLimitBanner";
import StatusWord from "./StatusWord";

const BAYS: Array<{ id: BayId; name: string; icon: LucideIcon; blurb: string; none: string }> = [
  { id: "active", name: "Active", icon: Activity, blurb: "Working right now.", none: "" },
  { id: "held", name: "Held", icon: CirclePause, blurb: "Paused by a limit. Nothing is lost.", none: "Nothing is held by a limit." },
  { id: "landed", name: "Landed", icon: CircleCheck, blurb: "Finished, failed or stopped, newest first.", none: "Nothing has landed yet. Finished runs are listed here." }
];

function Strip({ run, bay, onOpen }: { run: RunMeta; bay: BayId; onOpen: (id: string) => void }) {
  const word = stateOf(run);
  const task = taskText(run);
  const took = durationLabel(run);
  const note = bay === "landed" ? landedNote(run, took) : "";
  const action = bay === "active" ? "Watch" : word.state === "ready" ? "Open result" : "Open";
  return (
    <li className="os-runs-strip" data-edge={word.edge}>
      <span className="os-runs-strip__agent">{AGENT_LABEL[run.agentId || ""] || "—"}</span>
      <span className="os-runs-strip__task">
        <button type="button" className="os-runs-strip__open" title={task} onClick={() => onOpen(run.id)}>
          <span className="os-trunc">{task}</span>
        </button>
      </span>
      <span className="os-runs-strip__state">
        <StatusWord state={word.state} label={word.label} />
      </span>
      <span className="os-runs-strip__num">
        <span className="os-visually-hidden">Time </span>
        {bay === "active" && run.startedAt ? <RelativeTime since={run.startedAt} live /> : <span className="os-mono">{took}</span>}
      </span>
      <span className="os-runs-strip__num">
        <span className="os-visually-hidden">Cost </span>
        <span className="os-mono">{costLabel(run.usage)}</span>
      </span>
      <span className="os-runs-strip__num os-runs-strip__num--soft">
        <span className="os-visually-hidden">Started </span>
        <TimeAgo since={run.createdAt} />
      </span>
      <span className="os-runs-strip__act">
        <button type="button" className="os-btn os-btn--secondary" aria-label={`${action}: ${task}`} onClick={() => onOpen(run.id)}>
          {action}
        </button>
      </span>
      {bay === "held" ? (
        <div className="os-runs-strip__more">
          <RunLimitBanner run={run} compact />
        </div>
      ) : note ? (
        <div className="os-runs-strip__more">
          <p>{note}</p>
          {run.continuedBy ? (
            <button type="button" className="os-runs-link" onClick={() => onOpen(run.continuedBy || "")}>
              Open it
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function RunBoard({ runs, onOpen, onNew }: { runs: RunMeta[] | null; onOpen: (id: string) => void; onNew: () => void }) {
  const bays = runs ? splitBays(runs) : null;
  return (
    <div className="os-runs-board">
      <div className="os-runs-cols" aria-hidden="true">
        <span>Agent</span>
        <span>Task</span>
        <span>State</span>
        <span className="os-runs-cols__end">Time</span>
        <span className="os-runs-cols__end">Cost</span>
        <span className="os-runs-cols__end">Started</span>
        <span />
      </div>
      {BAYS.map(({ id, name, icon: Icon, blurb, none }) => {
        const list = bays ? bays[id] : null;
        return (
          <section key={id} className="os-runs-bay" aria-labelledby={`os-runs-bay-${id}`}>
            <div className="os-runs-bay__head">
              <h2 id={`os-runs-bay-${id}`} className="os-runs-bay__name">
                <Icon size={18} aria-hidden="true" />
                {name}
              </h2>
              <span className="os-runs-bay__n">
                <span className="os-mono">{list ? list.length : "…"}</span> {list && list.length === 1 ? "run" : "runs"}
              </span>
              <p className="os-runs-bay__blurb">{blurb}</p>
            </div>
            <div className="os-runs-bay__body">
              {list === null ? (
                <div className="os-skeleton os-runs-skeleton" aria-hidden="true" />
              ) : list.length > 0 ? (
                <ul className="os-runs-strips" role="list">
                  {list.map((run) => (
                    <Strip key={run.id} run={run} bay={id} onOpen={onOpen} />
                  ))}
                </ul>
              ) : id === "active" ? (
                <EmptyState
                  icon={CircleDashed}
                  title="No runs in the air"
                  body="A run appears here while an agent works on it, then moves to Landed."
                  action={
                    <button type="button" className="os-btn os-btn--primary" onClick={onNew}>
                      <Plus size={17} aria-hidden="true" />
                      New run
                    </button>
                  }
                />
              ) : (
                <p className="os-runs-bay__none">{none}</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
