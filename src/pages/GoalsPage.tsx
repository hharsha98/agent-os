import { CircleDot, Loader2, Pause, Play, Repeat } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  addMemory,
  createSelfModuleItem,
  getExecutionGateStatus,
  getMemoryContext,
  getSchedulerState,
  getSelfModule,
  pauseSchedulerJob,
  resumeSchedulerJob,
  runGoalLoop,
  saveSchedulerJob,
  updateExecutionGate,
  updateSelfModuleItem
} from "../api";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus, GoalLoopResult, SchedulerJob, SelfModuleItem, SelfModuleState } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

type LocalAgent = {
  id: string;
  available: boolean;
  version?: string;
  status: string;
};

export default function GoalsPage({ localAgents }: { localAgents: LocalAgent[] }) {
  const [state, setState] = useState<SelfModuleState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loop, setLoop] = useState<GoalLoopResult | null>(null);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [jobs, setJobs] = useState<SchedulerJob[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(480);
  const [notice, setNotice] = useState("");
  const codex = localAgents.find((agent) => agent.id === "codex");
  const selected = useMemo(
    () => state?.items.find((item) => item.id === selectedId) || state?.items[0] || null,
    [state, selectedId]
  );
  const overnight = jobs.find((job) => job.targetId === "goals" && job.action === "goal_loop" && String(job.payload?.goalId || "") === String(selected?.id || ""));

  async function refresh(nextSelected?: string) {
    try {
      const [data, execution, scheduler] = await Promise.all([
        getSelfModule("goals"),
        getExecutionGateStatus().catch(() => null),
        getSchedulerState().catch(() => null)
      ]);
      setState(data);
      setGate(execution);
      setJobs(scheduler?.jobs || []);
      setSelectedId(nextSelected || selectedId || data.items[0]?.id || null);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load goals.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createGoal() {
    if (!title.trim()) return;
    setBusy("create");
    try {
      const next = await createSelfModuleItem("goals", { title: title.trim(), notes, status: "open" });
      setState(next);
      setSelectedId(next.items[0]?.id || null);
      setTitle("");
      setNotes("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create goal.");
    } finally {
      setBusy("");
    }
  }

  async function runSelected(live: boolean) {
    if (!selected) return;
    if (live && !gate?.enabled) {
      setError("Enable live execution first. Dry-run stays available.");
      return;
    }
    setBusy(live ? "live" : "loop");
    try {
      const vault = await getMemoryContext({ query: selected.title, limit: 6 }).catch(() => null);
      const context = [selected.notes || notes, vault?.promptBlock].filter(Boolean).join("\n\n");
      const result = await runGoalLoop(selected.id, { dryRun: !live, context });
      setLoop(result);
      setState(result.state);
      setSelectedId(result.goal.id);
      await addMemory({
        title: `Goal loop ${selected.title}`,
        content: `${result.run?.summary || (live ? "Live loop complete" : "Dry-run complete")}\nNext: ${result.run?.nextAction || selected.nextAction || "n/a"}`,
        agentId: "goals",
        type: "episodic",
        privacy: "private",
        source: "goal-loop",
        tags: ["loop", "goals"]
      }).catch(() => undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Goal loop failed.");
    } finally {
      setBusy("");
    }
  }

  async function setGoalStatus(status: string) {
    if (!selected) return;
    setBusy("status");
    try {
      const next = await updateSelfModuleItem("goals", selected.id, { status });
      setState(next);
      setSelectedId(selected.id);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update goal.");
    } finally {
      setBusy("");
    }
  }

  async function toggleGate(enabled: boolean) {
    setBusy("gate");
    try {
      const next = await updateExecutionGate({
        enabled,
        reason: "Overnight Goal Mode from dashboard"
      });
      setGate(next);
      setNotice(enabled
        ? "Live execution is on from local config. This is not writing ENABLE_EXEC into .env."
        : "Live execution is off again.");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the execution gate.");
    } finally {
      setBusy("");
    }
  }

  async function scheduleOvernight() {
    if (!selected) return;
    setBusy("schedule");
    try {
      const job = await saveSchedulerJob({
        id: overnight?.id || `overnight-${selected.id}`,
        label: `Overnight ${selected.title}`,
        targetType: "self_module",
        targetId: "goals",
        action: "goal_loop",
        intervalMinutes,
        requiresApproval: true,
        payload: {
          goalId: selected.id,
          dryRun: false,
          context: selected.notes || ""
        }
      });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setNotice("Scheduled. The first tick waits for a Kanban approve. Later ticks can run live if the gate stays on.");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not schedule overnight.");
    } finally {
      setBusy("");
    }
  }

  async function pauseOvernight() {
    if (!overnight) return;
    setBusy("pause");
    try {
      const job = await pauseSchedulerJob(overnight.id);
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not pause the job.");
    } finally {
      setBusy("");
    }
  }

  async function resumeOvernight() {
    if (!overnight) return;
    setBusy("resume");
    try {
      const job = await resumeSchedulerJob(overnight.id);
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resume the job.");
    } finally {
      setBusy("");
    }
  }

  const history = selected?.history || [];
  const latest = loop?.run || history[0];
  const liveOn = Boolean(gate?.enabled);

  return (
    <PageFrame
      kicker="GOALS · CODEX GOAL MODE SHELL"
      title="Plan a goal. Live overnight is opt-in."
      hint="Dry-run stays the default. Live uses the Provider Router and your keys. Codex CLI overnight typing happens only if that provider is actually configured."
    >
      <div className="aos-status-grid">
        <article>
          <span>Standalone Codex CLI</span>
          <strong>{codex?.available ? "Found" : "Missing"}</strong>
          <small>{codex?.version || "Not reported"}</small>
        </article>
        <article>
          <span>Live overnight runs</span>
          <strong>{liveOn ? "Enabled" : "Disabled"}</strong>
          <small>{gate?.source || "local-config gate"} · {gate?.reason || "You click Enable once"}</small>
        </article>
        <article>
          <span>Goals stored</span>
          <strong>{state?.summary.total ?? 0}</strong>
          <small>{state?.summary.goals?.active ?? 0} active</small>
        </article>
      </div>
      <HonestNote>
        Live overnight is a scheduled Provider Router planning loop, not Codex owning your desktop. The first scheduled tick pauses for Kanban approve. This page does not auto-enable the gate.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      {notice ? <p className="aos-honest-note">{notice}</p> : null}
      <div className="aos-phase-toolbar">
        <button className="aos-secondary" disabled={busy !== "" || liveOn} onClick={() => void toggleGate(true)}>
          {busy === "gate" ? <Loader2 className="aos-spin" size={16} /> : null} Enable live execution
        </button>
        <button className="aos-secondary" disabled={busy !== "" || !liveOn} onClick={() => void toggleGate(false)}>
          Disable
        </button>
        <label className="aos-field">
          <span>Overnight interval (minutes)</span>
          <input type="number" min={30} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value) || 480)} />
        </label>
        <button className="aos-secondary" disabled={!selected || busy !== ""} onClick={() => void scheduleOvernight()}>
          {busy === "schedule" ? <Loader2 className="aos-spin" size={16} /> : null} Schedule overnight
        </button>
        {overnight?.paused ? (
          <button className="aos-secondary" disabled={busy !== ""} onClick={() => void resumeOvernight()}>Resume</button>
        ) : overnight ? (
          <button className="aos-secondary" disabled={busy !== ""} onClick={() => void pauseOvernight()}><Pause size={16} /> Pause</button>
        ) : null}
        <button className="aos-secondary" onClick={() => navigateTo("kanban")}>Approve on Kanban</button>
      </div>
      {overnight ? <p className="aos-honest-note">Job {overnight.id}: {overnight.paused ? "paused" : overnight.pendingApproval ? "waiting Kanban approve" : overnight.approvalStatus || "scheduled"} · next {overnight.nextRunAt}</p> : null}
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <div className="aos-field">
            <span>New goal</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
          </div>
          <div className="aos-field">
            <span>Notes</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional context" />
          </div>
          <button className="aos-secondary" onClick={() => void createGoal()} disabled={busy !== "" || !title.trim()}>
            {busy === "create" ? <Loader2 className="aos-spin" size={16} /> : <CircleDot size={16} />} Save goal
          </button>
          {(state?.items || []).length === 0 ? (
            <div className="aos-empty small"><strong>No goals yet</strong><p>Add one to see the timeline shell.</p></div>
          ) : (
            state?.items.map((item: SelfModuleItem) => (
              <button key={item.id} className={item.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                <strong>{item.title}</strong>
                <span>{item.status || "open"} · {item.loopCount || 0} loops</span>
              </button>
            ))
          )}
        </aside>
        <section className="aos-goal-panels">
          <div className="aos-panel">
            <div className="aos-panel-head"><div><span>TIMELINE</span><h2>{selected?.title || "No goal selected"}</h2></div>
              <button className="aos-primary" disabled={!selected || busy !== ""} onClick={() => void runSelected(false)}>
                {busy === "loop" ? <Loader2 className="aos-spin" size={16} /> : <Play size={16} />} Dry-run loop
              </button>
              <button className="aos-secondary" disabled={!selected || busy !== "" || !liveOn} onClick={() => void runSelected(true)}>
                {busy === "live" ? <Loader2 className="aos-spin" size={16} /> : null} Run live loop
              </button>
              <button className="aos-secondary" disabled={!selected || busy !== ""} onClick={() => void setGoalStatus(selected?.status === "done" ? "open" : "done")}>
                {busy === "status" ? <Loader2 className="aos-spin" size={16} /> : null}
                {selected?.status === "done" ? "Reopen goal" : "Mark done"}
              </button>
              <button className="aos-secondary" onClick={() => navigateTo("loop")}>
                <Repeat size={16} /> Open Loop
              </button>
            </div>
            {history.length === 0 && !latest ? (
              <div className="aos-empty small"><p>Run a dry-run loop to fill this timeline. Live execution stays off until you enable the gate.</p></div>
            ) : (
              <ol className="aos-timeline">
                {(loop ? [loop.run, ...history.filter((item) => item.id !== loop.run.id)] : history).slice(0, 8).map((run) => (
                  <li key={run.id}>
                    <strong>{run.status} · {run.mode}</strong>
                    <p>{run.summary}</p>
                    <small>{run.startedAt}</small>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="aos-goal-grid">
            <article className="aos-panel">
              <div className="aos-panel-head"><div><span>COMMANDS</span><h2>Next action</h2></div></div>
              <p>{latest?.nextAction || selected?.nextAction || "No command plan yet."}</p>
              <pre>{(latest?.plan || selected?.plan || []).join("\n") || "Plan appears after a dry-run."}</pre>
            </article>
            <article className="aos-panel">
              <div className="aos-panel-head"><div><span>NOTES</span><h2>Selected goal</h2></div></div>
              <p>{selected?.notes || "No notes on this goal. Dry-run uses these notes, not the new-goal form."}</p>
            </article>
            <article className="aos-panel">
              <div className="aos-panel-head"><div><span>MESSAGES</span><h2>Loop notes</h2></div></div>
              <p>{latest?.summary || selected?.notes || "No messages yet."}</p>
              {(latest?.risks || []).length ? <ul>{latest.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : null}
            </article>
          </div>
        </section>
      </div>
    </PageFrame>
  );
}
