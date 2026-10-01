// The flight recorder's left list: every run, newest first, with real
// filter counts (never fabricated) and the live accent-pulse mark driven
// only by the run actually being "running".
import type { RunMeta } from "../../types";
import { AGENT_MONOGRAM, costLabel, durationLabel, firstLine, runStatusMark } from "../fleetShared";
import RelativeTime, { TimeAgo } from "./RelativeTime";
import StatusMark from "./StatusMark";

export type RunFilter = "all" | "live" | "failed" | "stopped";

const FILTER_LABEL: Record<RunFilter, string> = { all: "All", live: "Live", failed: "Failed", stopped: "Stopped" };

function matchesFilter(run: RunMeta, filter: RunFilter) {
  if (filter === "all") return true;
  if (filter === "live") return run.status === "running" || run.status === "queued";
  if (filter === "failed") return run.status === "failed" || run.status === "timed_out";
  if (filter === "stopped") return run.status === "stopped" || run.status === "interrupted";
  return true;
}

export default function RunList({
  runs,
  selectedId,
  filter,
  onFilterChange,
  onSelect
}: {
  runs: RunMeta[] | null;
  selectedId: string | null;
  filter: RunFilter;
  onFilterChange: (filter: RunFilter) => void;
  onSelect: (id: string) => void;
}) {
  const counts: Record<RunFilter, number> = { all: 0, live: 0, failed: 0, stopped: 0 };
  if (runs) {
    for (const run of runs) {
      (Object.keys(counts) as RunFilter[]).forEach((key) => {
        if (matchesFilter(run, key)) counts[key] += 1;
      });
    }
  }
  const filtered = runs ? runs.filter((run) => matchesFilter(run, filter)) : null;

  return (
    <div className="os-run-list">
      <div className="os-run-list__filters" role="tablist" aria-label="Filter runs">
        {(Object.keys(FILTER_LABEL) as RunFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={`os-run-list__filter${filter === key ? " os-run-list__filter--active" : ""}`}
            onClick={() => onFilterChange(key)}
          >
            {FILTER_LABEL[key]}
            <span className="os-mono">{runs ? counts[key] : "…"}</span>
          </button>
        ))}
      </div>

      {filtered === null ? (
        <div className="os-run-list__rail">
          {[0, 1, 2].map((i) => (
            <div key={i} className="os-skeleton" style={{ height: 56, marginBottom: 8 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="os-run-list__empty">No runs match this filter yet.</p>
      ) : (
        <ul className="os-run-list__rail">
          {filtered.map((run) => {
            const selected = run.id === selectedId;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  className={`os-run-list__item${selected ? " os-run-list__item--selected" : ""}`}
                  onClick={() => onSelect(run.id)}
                  aria-current={selected ? "true" : undefined}
                >
                  <span className="os-run-list__accent" aria-hidden="true" />
                  <span className="os-mono os-run-list__monogram">{AGENT_MONOGRAM[run.agentId || ""] || "—"}</span>
                  <span className="os-run-list__body">
                    <span className="os-run-list__row">
                      {/* No per-event pulse here: the list never sees events, only the open console does. */}
                      <StatusMark kind={runStatusMark(run.status)} />
                      <span className="os-run-list__title">{run.title || firstLine(run.commandPreview, 46) || "Run"}</span>
                    </span>
                    <span className="os-run-list__row os-run-list__row--meta">
                      <TimeAgo since={run.createdAt} />
                      <span className="os-mono">
                        {run.status === "running" && run.startedAt ? <RelativeTime since={run.startedAt} live /> : durationLabel(run)}
                      </span>
                      <span className="os-mono">{costLabel(run.usage)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
