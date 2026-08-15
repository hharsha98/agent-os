import { CircleDot, Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createSelfModuleItem, getSelfModule, runGoalLoop } from "../api";
import type { GoalLoopResult, SelfModuleItem, SelfModuleState } from "../types";
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
  const codex = localAgents.find((agent) => agent.id === "codex");
  const selected = useMemo(
    () => state?.items.find((item) => item.id === selectedId) || state?.items[0] || null,
    [state, selectedId]
  );

  async function refresh(nextSelected?: string) {
    try {
      const data = await getSelfModule("goals");
      setState(data);
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
      setSelectedId(next.items[next.items.length - 1]?.id || null);
      setTitle("");
      setNotes("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create goal.");
    } finally {
      setBusy("");
    }
  }

  async function runSelected() {
    if (!selected) return;
    setBusy("loop");
    try {
      const result = await runGoalLoop(selected.id, { dryRun: true, context: notes });
      setLoop(result);
      setState(result.state);
      setSelectedId(result.goal.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Goal loop failed.");
    } finally {
      setBusy("");
    }
  }

  const history = selected?.history || [];
  const latest = loop?.run || history[0];

  return (
    <PageFrame
      kicker="GOALS · CODEX GOAL MODE SHELL"
      title="Plan a goal. Keep overnight execution off."
      hint="This uses the existing goals API in dry-run mode. It will not claim that Codex is finishing work while you sleep."
    >
      <div className="aos-status-grid">
        <article>
          <span>Standalone Codex CLI</span>
          <strong>{codex?.available ? "Found" : "Missing"}</strong>
          <small>{codex?.version || "Not reported"}</small>
        </article>
        <article>
          <span>Live overnight runs</span>
          <strong>Disabled</strong>
          <small>Execution stays gated unless you approve it later.</small>
        </article>
        <article>
          <span>Goals stored</span>
          <strong>{state?.summary.total ?? 0}</strong>
          <small>{state?.summary.goals?.active ?? 0} active</small>
        </article>
      </div>
      <HonestNote>
        If the Codex CLI is missing, you can still save goals and inspect dry-run plans. A green “connected” state is not shown unless the local check says so.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
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
              <button className="aos-primary" disabled={!selected || busy !== ""} onClick={() => void runSelected()}>
                {busy === "loop" ? <Loader2 className="aos-spin" size={16} /> : <Play size={16} />} Dry-run loop
              </button>
            </div>
            {history.length === 0 && !latest ? (
              <div className="aos-empty small"><p>Run a dry-run loop to fill this timeline. Nothing is executed on your Mac.</p></div>
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
              <div className="aos-panel-head"><div><span>FILES</span><h2>Scratch / outputs</h2></div></div>
              <p>File artifacts stay unset until a later live Goal Mode is approved. This panel is a shell, not a fake folder of finished work.</p>
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
