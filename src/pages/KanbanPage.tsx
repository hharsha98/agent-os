import { KanbanSquare, Loader2, Repeat } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { addMemory, createSelfModuleItem, getSelfModule, updateSelfModuleItem } from "../api";
import { navigateTo } from "../nav";
import type { SelfModuleItem, SelfModuleState } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

const LANES = [
  { id: "todo", label: "To Do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" }
];

function laneFor(item: SelfModuleItem) {
  const value = String(item.column || item.status || "todo").toLowerCase();
  if (["done", "completed", "approved", "closed", "archived"].includes(value)) return "done";
  if (["doing", "in_progress", "progress", "running"].includes(value)) return "doing";
  return "todo";
}

export default function KanbanPage() {
  const [state, setState] = useState<SelfModuleState | null>(null);
  const [title, setTitle] = useState("");
  const [column, setColumn] = useState("todo");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setState(await getSelfModule("kanban"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Kanban.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const grouped = useMemo(() => {
    const items = state?.items || [];
    return {
      todo: items.filter((item) => laneFor(item) === "todo"),
      doing: items.filter((item) => laneFor(item) === "doing"),
      done: items.filter((item) => laneFor(item) === "done")
    };
  }, [state]);

  async function createCard() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      setState(await createSelfModuleItem("kanban", { title: title.trim(), column, notes, status: "open", priority: "normal" }));
      await addMemory({
        title: `Kanban: ${title.trim()}`,
        content: notes || `Card created in ${column}`,
        agentId: "kanban",
        type: "episodic",
        privacy: "private",
        source: "kanban",
        tags: ["loop", "kanban"]
      }).catch(() => undefined);
      setTitle("");
      setNotes("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create card.");
    } finally {
      setBusy(false);
    }
  }

  async function moveCard(item: SelfModuleItem, nextLane: string) {
    if (laneFor(item) === nextLane) return;
    setBusy(true);
    try {
      setState(await updateSelfModuleItem("kanban", item.id, {
        column: nextLane,
        status: nextLane === "done" ? "done" : "open"
      }));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not move card.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      kicker="KANBAN · LOCAL JOBS"
      title="To Do, Doing, and Done from the real board."
      hint="Cards come from the Agent OS Kanban store. Empty lanes stay empty. This page does not invent jobs."
    >
      <HonestNote>
        Create a card, then move it with the lane menu. Open Loop to fold To Do and Doing into today’s briefing. Moves stay in the local Kanban store — not GitHub.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-phase-toolbar">
        <label className="aos-field">
          <span>Card title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Review dry-run output" />
        </label>
        <label className="aos-field">
          <span>Lane</span>
          <select value={column} onChange={(event) => setColumn(event.target.value)}>
            {LANES.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
          </select>
        </label>
        <label className="aos-field">
          <span>Notes</span>
          <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional" />
        </label>
        <button className="aos-primary" onClick={() => void createCard()} disabled={busy || !title.trim()}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <KanbanSquare size={16} />} Add card
        </button>
        <button className="aos-secondary" onClick={() => navigateTo("loop")}>
          <Repeat size={16} /> Open Loop
        </button>
      </div>
      <div className="aos-kanban-board">
        {LANES.map((lane) => (
          <section key={lane.id}>
            <header>
              <h3>{lane.label}</h3>
              <span>{grouped[lane.id as keyof typeof grouped].length}</span>
            </header>
            {grouped[lane.id as keyof typeof grouped].length === 0 ? (
              <div className="aos-empty small">
                <p>No cards in {lane.label}. That is the real state, not a placeholder job.</p>
              </div>
            ) : (
              grouped[lane.id as keyof typeof grouped].map((item) => (
                <article key={item.id} className="aos-kanban-card">
                  <strong>{item.title}</strong>
                  <p>{item.notes || "No notes"}</p>
                  <small>{item.priority || "normal"} · {item.status || "open"}</small>
                  <label className="aos-field">
                    <span>Move to</span>
                    <select
                      value={laneFor(item)}
                      disabled={busy}
                      onChange={(event) => void moveCard(item, event.target.value)}
                    >
                      {LANES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                  </label>
                </article>
              ))
            )}
          </section>
        ))}
      </div>
    </PageFrame>
  );
}
