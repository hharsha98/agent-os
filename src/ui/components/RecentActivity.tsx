import type { CSSProperties, MouseEvent } from "react";
import { Activity } from "lucide-react";
import { navigateTo } from "../../nav";
import { AGENT_LABEL } from "../agentsShared";
import { costLabel, durationLabel } from "../fleetShared";
import { activityRuns, noRunsYet, spendToday } from "../homeShared";
import { stateOf, taskText } from "../runsBoard";
import type { HomeData } from "../useHomeData";
import EmptyState from "./EmptyState";
import { TimeAgo } from "./RelativeTime";
import StatusWord from "./StatusWord";

const COLS = { "--os-table-cols": "150px minmax(0, 1fr) 124px 80px 60px 84px" } as CSSProperties;

export default function RecentActivity({ data }: { data: HomeData }) {
  const runs = data.runs.state === "ok" ? data.runs.data : null;
  const rows = runs ? activityRuns(runs, 8) : [];
  const go = (event: MouseEvent, page: string, extra: Record<string, string> = {}) => {
    event.preventDefault();
    navigateTo(page, extra);
  };
  return (
    <section className="os-home-activity" aria-labelledby="os-home-activity-title">
      <div className="os-home-activity__head">
        <h2 id="os-home-activity-title">Recent activity</h2>
        <p className="os-home-activity__quiet">
          Spend today <span className="os-mono">{runs ? spendToday(runs, data.now) : "—"}</span> (only Claude Code and OpenClaw report cost)
          <span className="os-home-activity__bar" aria-hidden="true" />
          <a href="?page=runs" onClick={(e) => go(e, "runs")}>All runs</a>
        </p>
      </div>
      {data.runs.state === "loading" ? (
        <p className="os-home-activity__status"><StatusWord state="loading" /></p>
      ) : data.runs.state === "error" ? (
        <p className="os-home-activity__status"><StatusWord state="unknown" label="Can't reach Agent OS" /></p>
      ) : rows.length === 0 && runs ? (
        // "No runs yet" only when the list is not full: a full list may hide older agent runs.
        <EmptyState
          icon={Activity}
          title={noRunsYet(runs) ? "No runs yet" : `No agent runs among the latest ${runs.length}`}
          body={
            noRunsYet(runs)
              ? "When an agent runs a task, it shows up here with its result, time and cost."
              : "The newest jobs are Agent OS's own set-up and service jobs. Open Runs to look further back."
          }
          action={<button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("runs")}>Open Runs</button>}
        />
      ) : (
        <div className="os-table os-home-runs" role="table" aria-label="Recent runs" style={COLS}>
          <div className="os-table__head" role="row">
            <span className="os-table__cell" role="columnheader">Result</span>
            <span className="os-table__cell" role="columnheader">Task</span>
            <span className="os-table__cell" role="columnheader">Agent</span>
            <span className="os-table__cell os-table__cell--end" role="columnheader">Time</span>
            <span className="os-table__cell os-table__cell--end" role="columnheader">Cost</span>
            <span className="os-table__cell os-table__cell--end" role="columnheader">Started</span>
          </div>
          {rows.map((run) => {
            const word = stateOf(run);
            const task = taskText(run);
            const agent = run.agentId ? (AGENT_LABEL as Record<string, string>)[run.agentId] : undefined;
            return (
              <a key={run.id} className="os-table__row" role="row" href={`?page=runs&run=${run.id}`} onClick={(e) => go(e, "runs", { run: run.id })}>
                <div className="os-table__cell" role="cell"><StatusWord state={word.state} label={word.label} /></div>
                <div className="os-table__cell" role="cell">
                  <span className="os-table__title os-trunc" title={task}>{task}</span>
                  {run.limit && !run.continuedBy ? <span className="os-table__sub">Plan limit reached</span> : null}
                </div>
                <div className="os-table__cell" role="cell">{agent || "—"}</div>
                <div className="os-table__cell os-table__cell--end os-mono" role="cell">{durationLabel(run)}</div>
                <div className="os-table__cell os-table__cell--end os-mono" role="cell">{costLabel(run.usage)}</div>
                <div className="os-table__cell os-table__cell--end os-mono" role="cell">{run.startedAt ? <TimeAgo since={run.startedAt} /> : "—"}</div>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
