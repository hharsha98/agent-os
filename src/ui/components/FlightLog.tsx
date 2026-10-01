import type { RunMeta } from "../../types";
import { AGENT_MONOGRAM, costLabel, durationLabel, firstLine, runStatusMark } from "../fleetShared";
import Panel from "./Panel";
import RelativeTime, { TimeAgo } from "./RelativeTime";
import StatusMark from "./StatusMark";

// The right rail on Home: the most recent real runs as a vertical timeline,
// replacing the old flat "Recent runs" list. `runs === null` is "still
// loading" (skeleton); `[]` is a genuinely empty history (elegant empty
// state, never a fabricated example run).
export default function FlightLog({ runs, onOpenChat }: { runs: RunMeta[] | null; onOpenChat: () => void }) {
  const items = runs ? runs.slice(0, 8) : null;

  return (
    <Panel className="os-flightlog">
      <h2 className="os-flightlog__title">Flight log</h2>
      {items === null ? (
        <div className="os-flightlog__rail">
          {[0, 1, 2].map((i) => (
            <div key={i} className="os-skeleton" style={{ height: 44, marginBottom: 12 }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="os-flightlog__rail">
          <div className="os-flightlog__node">
            <span className="os-flightlog__mark">
              <StatusMark kind="unknown" />
            </span>
            <div className="os-flightlog__body">
              <p className="os-flightlog__empty">No runs yet. When an agent runs, each step lands here.</p>
              <button className="os-btn os-btn--secondary" onClick={onOpenChat}>
                Open Chat
              </button>
            </div>
          </div>
        </div>
      ) : (
        <ul className="os-flightlog__rail">
          {items.map((run) => (
            <li key={run.id} className="os-flightlog__node">
              <span className="os-flightlog__mark">
                <StatusMark kind={runStatusMark(run.status)} />
              </span>
              <div className="os-flightlog__body">
                <div className="os-flightlog__row">
                  <span className="os-mono os-flightlog__monogram">{AGENT_MONOGRAM[run.agentId || ""] || "—"}</span>
                  <span className="os-flightlog__run-title">{run.title || firstLine(run.commandPreview, 42) || "Run"}</span>
                </div>
                <div className="os-flightlog__row os-flightlog__row--meta">
                  <TimeAgo since={run.createdAt} />
                  <span className="os-mono">
                    {run.status === "running" && run.startedAt ? <RelativeTime since={run.startedAt} live /> : durationLabel(run)}
                  </span>
                  <span className="os-mono">{costLabel(run.usage)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
