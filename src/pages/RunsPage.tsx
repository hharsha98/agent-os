// Runs screen ("the flight recorder"): a master-detail list of every run
// and a live "run console" for whichever one is selected (?run=<id>,
// defaulting to the newest). See specs/W7c-agents-runs.md.
import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { listRuns } from "../api";
import { navigateTo, queryParam } from "../nav";
import type { RunMeta } from "../types";
import RunConsole from "../ui/components/RunConsole";
import RunList, { type RunFilter } from "../ui/components/RunList";
import { useInterval } from "../ui/components/useInterval";
import "../ui/runs.css";

export default function RunsPage() {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  const [selectedId, setSelectedId] = useState(() => queryParam("run") || "");
  const [filter, setFilter] = useState<RunFilter>("all");
  // Below 1100px the list and the console are two screens, not two panes;
  // a run selected via the URL (e.g. right after Launch) should land the
  // user on the console immediately, not on the list they'd have to leave.
  const [mobileDetail, setMobileDetail] = useState(() => Boolean(queryParam("run")));

  async function loadRuns() {
    try {
      const { runs: list } = await listRuns({ limit: 100 });
      setRuns(list);
      setRunsFailed(false);
    } catch {
      setRunsFailed(true);
    }
  }

  useEffect(() => {
    void loadRuns();
  }, []);
  useInterval(() => void loadRuns(), 5000);

  useEffect(() => {
    function sync() {
      setSelectedId(queryParam("run") || "");
    }
    window.addEventListener("aos-navigate", sync);
    return () => window.removeEventListener("aos-navigate", sync);
  }, []);

  const effectiveId = selectedId || (runs && runs[0] ? runs[0].id : "");

  function selectRun(id: string) {
    setSelectedId(id);
    navigateTo("runs", { run: id });
    setMobileDetail(true);
  }

  if (runsFailed && !runs) {
    return (
      <div className="os-runs aos-phase-page">
        <div className="os-fleet__banner">
          <AlertTriangle size={16} />
          <span>Agent OS isn&apos;t responding.</span>
          <button type="button" className="os-btn os-btn--secondary" onClick={() => void loadRuns()}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (runs && runs.length === 0) {
    return (
      <div className="os-runs aos-phase-page">
        <header className="os-runs__header">
          <span className="os-micro">AGENT OS · FLIGHT RECORDER</span>
          <h1>Runs</h1>
        </header>
        <div className="os-panel os-runs__empty">
          <p>No runs yet. Launch an agent and its flight gets recorded here.</p>
          <button type="button" className="os-btn os-btn--primary" onClick={() => navigateTo("agents")}>
            Go to Agents
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`os-runs aos-phase-page${mobileDetail ? " os-runs--detail" : ""}`}>
      <header className="os-runs__header">
        <span className="os-micro">AGENT OS · FLIGHT RECORDER</span>
        <h1>Runs</h1>
      </header>
      <div className="os-runs__body">
        <div className="os-runs__list-pane">
          <RunList runs={runs} selectedId={effectiveId || null} filter={filter} onFilterChange={setFilter} onSelect={selectRun} />
        </div>
        <div className="os-runs__detail-pane">
          <button type="button" className="os-btn os-btn--ghost os-runs__back" onClick={() => setMobileDetail(false)}>
            ← Back to list
          </button>
          {effectiveId ? <RunConsole runId={effectiveId} onEnded={() => void loadRuns()} /> : <p className="os-run-list__empty">Select a run.</p>}
        </div>
      </div>
    </div>
  );
}
