// "Stop all runs" from the ⌘K palette. Looks up what is really running first,
// says how many runs it would stop, and only then asks the existing stop route
// (POST /api/runs/:id/stop) for each of them, once the person confirms.
import { useEffect, useState } from "react";
import { listRuns, stopRun } from "../../api";
import type { RunMeta } from "../../types";
import { friendlyError } from "../agentsShared";
import AgentConfirmModal from "./AgentConfirmModal";

const ACTIVE = new Set(["queued", "running"]);
const SHOWN_TITLES = 5;

export default function StopAllRunsModal({ onClose }: { onClose: () => void }) {
  // null = still looking.
  const [live, setLive] = useState<RunMeta[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function look() {
    try {
      const { runs } = await listRuns({ limit: 100 });
      setLive(runs.filter((run) => ACTIVE.has(run.status)));
    } catch (caught) {
      setError(friendlyError(caught));
      setLive([]);
    }
  }

  useEffect(() => {
    void look();
  }, []);

  async function confirm() {
    if (!live || live.length === 0) return;
    setBusy(true);
    setError("");
    const results = await Promise.allSettled(live.map((run) => stopRun(run.id)));
    const failed = results.filter((result) => result.status === "rejected").length;
    setBusy(false);
    if (failed === 0) {
      onClose();
      return;
    }
    setError(`Couldn't stop ${failed} of ${live.length} run${live.length === 1 ? "" : "s"}. The list below is what is still running.`);
    await look();
  }

  const count = live ? live.length : 0;

  return (
    <AgentConfirmModal
      title="Stop all runs?"
      confirmLabel={count > 0 ? `Stop ${count} run${count === 1 ? "" : "s"}` : "Stop all runs"}
      confirmDisabled={live === null || count === 0}
      busy={busy}
      danger
      onConfirm={() => void confirm()}
      onClose={() => (busy ? null : onClose())}
    >
      {live === null ? <p>…</p> : null}
      {live && count === 0 && !error ? <p>Nothing is running right now.</p> : null}
      {live && count > 0 ? (
        <>
          <p>
            This stops {count} run{count === 1 ? "" : "s"} that {count === 1 ? "is" : "are"} running now. Anything an agent already did stays done.
          </p>
          <ul>
            {live.slice(0, SHOWN_TITLES).map((run) => (
              <li key={run.id}>{run.title || run.id}</li>
            ))}
            {count > SHOWN_TITLES ? <li>and {count - SHOWN_TITLES} more</li> : null}
          </ul>
        </>
      ) : null}
      {error ? <p className="os-launch__error">{error}</p> : null}
    </AgentConfirmModal>
  );
}
