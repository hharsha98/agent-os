import { Loader2, Repeat, Save } from "lucide-react";
import { useEffect, useState } from "react";
import {
  addMemory,
  getExecutionGateStatus,
  getMemoryState,
  getSelfModule,
  getWorkspaceListing,
  writeWorkspaceFile
} from "../api";
import type { ExecutionGateStatus, MemoryRecord, SelfModuleItem, WorkspaceFileDetail } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function isJournal(item: SelfModuleItem) {
  return (item.tags || []).includes("journal") || /journal/i.test(item.title || "");
}

function isOpenGoal(item: SelfModuleItem) {
  const status = String(item.status || "open").toLowerCase();
  return !["done", "completed", "cancelled", "canceled"].includes(status);
}

function buildBriefing(input: {
  journal: SelfModuleItem[];
  goals: SelfModuleItem[];
  memories: MemoryRecord[];
  workspaceCount: number;
  execEnabled: boolean;
}) {
  const date = todayStamp();
  const journal = input.journal.slice(0, 5).map((item) => {
    const body = String(item.body || item.notes || "").trim() || "(no body)";
    return `### ${item.title}\n${body}`;
  });
  const goals = input.goals.slice(0, 8).map((item) => `- ${item.title} (${item.status || "open"})`);
  const memories = input.memories.slice(0, 8).map((item) => `- ${item.title}`);
  return [
    `# Agent OS loop ${date}`,
    "",
    "This briefing was written on this Mac. Overnight Goal Mode stayed off. This is not an Obsidian vault.",
    "",
    `Execution gate: ${input.execEnabled ? "ON" : "OFF"}`,
    `Workspace files before save: ${input.workspaceCount}`,
    "",
    "## Journal",
    journal.length ? journal.join("\n\n") : "_No journal entries yet._",
    "",
    "## Open goals",
    goals.length ? goals.join("\n") : "_No open goals._",
    "",
    "## Loop memories",
    memories.length ? memories.join("\n") : "_No loop memories yet. Save a chat reply to Memory first._",
    ""
  ].join("\n");
}

export default function LoopPage() {
  const [journal, setJournal] = useState<SelfModuleItem[]>([]);
  const [goals, setGoals] = useState<SelfModuleItem[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [saved, setSaved] = useState<WorkspaceFileDetail | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [notebook, goalState, memory, listing, exec] = await Promise.all([
        getSelfModule("notebook").catch(() => null),
        getSelfModule("goals").catch(() => null),
        getMemoryState().catch(() => null),
        getWorkspaceListing().catch(() => null),
        getExecutionGateStatus().catch(() => null)
      ]);
      setJournal((notebook?.items || []).filter(isJournal));
      setGoals((goalState?.items || []).filter(isOpenGoal));
      setMemories((memory?.memories || []).filter((item) => (item.tags || []).includes("loop")).slice(0, 8));
      setWorkspaceCount(listing?.summary.total ?? 0);
      setGate(exec);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the loop desk.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveBriefing() {
    setBusy(true);
    try {
      const content = buildBriefing({
        journal,
        goals,
        memories,
        workspaceCount,
        execEnabled: Boolean(gate?.enabled)
      });
      const file = await writeWorkspaceFile({
        folder: "loop",
        name: `${todayStamp()}.md`,
        content
      });
      setSaved(file);
      await addMemory({
        title: `Loop briefing ${todayStamp()}`,
        content,
        agentId: "loop",
        type: "episodic",
        privacy: "private",
        source: "loop-desk",
        tags: ["loop", "briefing"]
      });
      setNotice(`Saved ${file.file.id} into the workspace sandbox and into local Memory.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the briefing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      kicker="LOOP · LAYER 7"
      title="Start the morning from yesterday’s notes."
      hint="The YouTube video’s last layer is the loop: write work back to one home so tomorrow is smarter. This page gathers journal, goals, and chat-loop memories, then can save one markdown file into the workspace sandbox."
    >
      <HonestNote>
        Overnight Goal Mode is still off. This does not click your Mac or spend API money. It only writes a text file inside ~/.hermes-agent-os/workspace/loop.
      </HonestNote>
      <div className="aos-status-grid">
        <article>
          <span>Journal notes</span>
          <strong>{journal.length}</strong>
          <small>Typed by you, not Omi</small>
        </article>
        <article>
          <span>Open goals</span>
          <strong>{goals.length}</strong>
          <small>Planner only — no overnight run</small>
        </article>
        <article>
          <span>Loop memories</span>
          <strong>{memories.length}</strong>
          <small>From Chat → Save to Memory</small>
        </article>
        <article>
          <span>Execution gate</span>
          <strong>{gate?.enabled ? "On" : "Off"}</strong>
          <small>{gate?.publicSummary || "Not loaded"}</small>
        </article>
      </div>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <strong className="aos-list-label">What we will write</strong>
          {journal[0] ? <article className="aos-panel"><strong>{journal[0].title}</strong><p>{(journal[0].body || journal[0].notes || "").slice(0, 240) || "Empty body"}</p></article> : <div className="aos-empty small"><p>No journal yet. Add one on Journal if you want it in the briefing.</p></div>}
          {goals.slice(0, 4).map((item) => (
            <article key={item.id} className="aos-panel">
              <strong>{item.title}</strong>
              <span>{item.status || "open"}</span>
            </article>
          ))}
          <button className="aos-primary" onClick={() => void saveBriefing()} disabled={busy}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save briefing to Workspace
          </button>
          {notice ? <p className="aos-honest-note">{notice}</p> : null}
        </aside>
        <section className="aos-panel">
          <div className="aos-panel-head">
            <div>
              <span>PREVIEW</span>
              <h2>{saved ? saved.file.name : `${todayStamp()}.md`}</h2>
            </div>
            <Repeat size={16} />
          </div>
          <pre className="aos-memory-content">
            {saved?.previewText
              || buildBriefing({
                journal,
                goals,
                memories,
                workspaceCount,
                execEnabled: Boolean(gate?.enabled)
              })}
          </pre>
        </section>
      </div>
    </PageFrame>
  );
}
