import { Blocks, FolderOpen, Loader2, Repeat, Save } from "lucide-react";
import { useEffect, useState } from "react";
import {
  addMemory,
  getExecutionGateStatus,
  getMemoryState,
  getSelfModule,
  getWorkspaceListing,
  writeWorkspaceFile
} from "../api";
import { type ChatSnippet, loadRecentChatSnippets } from "../chatHistory";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus, MemoryRecord, SelfModuleItem, WorkspaceFile, WorkspaceFileDetail } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function briefingStamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function isJournal(item: SelfModuleItem) {
  return (item.tags || []).includes("journal") || /journal/i.test(item.title || "");
}

function isOpenGoal(item: SelfModuleItem) {
  const status = String(item.status || "open").toLowerCase();
  return !["done", "completed", "cancelled", "canceled"].includes(status);
}

function isChatMemory(item: MemoryRecord) {
  return item.source === "chat-loop" || ((item.tags || []).includes("loop") && item.source !== "loop-desk");
}

function kanbanLane(item: SelfModuleItem) {
  const value = String(item.column || item.status || "todo").toLowerCase();
  if (["done", "completed", "approved", "closed", "archived"].includes(value)) return "done";
  if (["doing", "in_progress", "progress", "running"].includes(value)) return "doing";
  return "todo";
}

function buildBriefing(input: {
  journal: SelfModuleItem[];
  notes: SelfModuleItem[];
  goals: SelfModuleItem[];
  kanban: SelfModuleItem[];
  chats: ChatSnippet[];
  memories: MemoryRecord[];
  workspaceCount: number;
  execEnabled: boolean;
}) {
  const date = todayStamp();
  const journal = input.journal.slice(0, 5).map((item) => {
    const body = String(item.body || item.notes || "").trim() || "(no body)";
    return `### ${item.title}\n${body}`;
  });
  const notes = input.notes.slice(0, 5).map((item) => {
    const body = String(item.body || item.notes || "").trim() || "(no body)";
    return `### ${item.title}\n${body}`;
  });
  const goals = input.goals.slice(0, 8).map((item) => {
    const next = String(item.nextAction || "").trim();
    return next
      ? `- ${item.title} (${item.status || "open"}) — ${next}`
      : `- ${item.title} (${item.status || "open"})`;
  });
  const kanban = input.kanban
    .filter((item) => kanbanLane(item) !== "done")
    .slice(0, 8)
    .map((item) => {
      const extra = String(item.notes || "").trim();
      return extra
        ? `- ${item.title} [${kanbanLane(item)}] — ${extra}`
        : `- ${item.title} [${kanbanLane(item)}]`;
    });
  const chats = input.chats.slice(0, 8).map((item) => {
    const asked = item.userText ? `You: ${item.userText}\n` : "";
    return `### ${item.agentId} · ${item.badge}\n${asked}${item.text}`;
  });
  const memories = input.memories.slice(0, 8).map((item) => {
    const first = String(item.content || "").split("\n").find((line) => line.trim()) || "";
    return first ? `- ${item.title}: ${first.slice(0, 120)}` : `- ${item.title}`;
  });
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
    "## Notebook",
    notes.length ? notes.join("\n\n") : "_No notebook notes yet._",
    "",
    "## Open goals",
    goals.length ? goals.join("\n") : "_No open goals._",
    "",
    "## Kanban (To Do / Doing)",
    kanban.length ? kanban.join("\n") : "_No open Kanban cards._",
    "",
    "## Recent chat",
    chats.length ? chats.join("\n\n") : "_No chat replies in this browser yet._",
    "",
    "## Loop memories",
    memories.length ? memories.join("\n") : "_No chat-loop memories stored yet._",
    ""
  ].join("\n");
}

export default function LoopPage() {
  const [journal, setJournal] = useState<SelfModuleItem[]>([]);
  const [notes, setNotes] = useState<SelfModuleItem[]>([]);
  const [goals, setGoals] = useState<SelfModuleItem[]>([]);
  const [kanban, setKanban] = useState<SelfModuleItem[]>([]);
  const [chats, setChats] = useState<ChatSnippet[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [loopFiles, setLoopFiles] = useState<WorkspaceFile[]>([]);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [saved, setSaved] = useState<WorkspaceFileDetail | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [notebook, goalState, kanbanState, memory, listing, exec] = await Promise.all([
        getSelfModule("notebook").catch(() => null),
        getSelfModule("goals").catch(() => null),
        getSelfModule("kanban").catch(() => null),
        getMemoryState().catch(() => null),
        getWorkspaceListing().catch(() => null),
        getExecutionGateStatus().catch(() => null)
      ]);
      const notebookItems = notebook?.items || [];
      setJournal(notebookItems.filter(isJournal));
      setNotes(notebookItems.filter((item) => !isJournal(item)));
      setGoals((goalState?.items || []).filter(isOpenGoal));
      setKanban(kanbanState?.items || []);
      setChats(loadRecentChatSnippets(8));
      setMemories((memory?.memories || []).filter(isChatMemory).slice(0, 8));
      setWorkspaceCount(listing?.summary.total ?? 0);
      setLoopFiles((listing?.files || []).filter((file) => file.relativePath.startsWith("loop/") || file.id.includes("/loop/")).slice(0, 6));
      setGate(exec);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the loop desk.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const preview = {
    journal,
    notes,
    goals,
    kanban,
    chats,
    memories,
    workspaceCount,
    execEnabled: Boolean(gate?.enabled)
  };

  async function saveBriefing() {
    setBusy(true);
    try {
      const content = buildBriefing(preview);
      const file = await writeWorkspaceFile({
        folder: "loop",
        name: `${briefingStamp()}.md`,
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
      hint="This page now reads Chat, Journal, Notebook, Goals, and Kanban automatically. Saving writes a timestamped markdown file. Chat will load the latest briefing the next time you open it."
    >
      <HonestNote>
        Overnight Goal Mode is still off. Chat replies in this browser are included even if Memory is empty. This does not click your Mac or spend API money.
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
          <span>Chat in this browser</span>
          <strong>{chats.length}</strong>
          <small>Read from local Chat history</small>
        </article>
        <article>
          <span>Open Kanban</span>
          <strong>{kanban.filter((item) => kanbanLane(item) !== "done").length}</strong>
          <small>To Do and Doing only</small>
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
          {notes[0] ? <article className="aos-panel"><strong>{notes[0].title}</strong><span>Notebook</span><p>{(notes[0].body || notes[0].notes || "").slice(0, 240) || "Empty body"}</p></article> : null}
          {chats[0] ? (
            <article className="aos-panel">
              <strong>{chats[0].agentId}</strong>
              <span>{chats[0].badge}</span>
              <p>{chats[0].userText ? `You: ${chats[0].userText}` : chats[0].text}</p>
            </article>
          ) : (
            <div className="aos-empty small"><p>No Chat replies yet. Send one on Chat, then come back here.</p></div>
          )}
          {goals.slice(0, 4).map((item) => (
            <article key={item.id} className="aos-panel">
              <strong>{item.title}</strong>
              <span>{item.status || "open"}</span>
            </article>
          ))}
          {kanban.filter((item) => kanbanLane(item) !== "done").slice(0, 4).map((item) => (
            <article key={item.id} className="aos-panel">
              <strong>{item.title}</strong>
              <span>Kanban · {kanbanLane(item)}</span>
            </article>
          ))}
          <button className="aos-primary" onClick={() => void saveBriefing()} disabled={busy}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save briefing to Workspace
          </button>
          {saved ? (
            <button
              className="aos-secondary"
              onClick={() => navigateTo("workspace", { file: saved.file.id, folder: "loop" })}
            >
              <FolderOpen size={16} /> Open in Workspace
            </button>
          ) : null}
          <button className="aos-secondary" onClick={() => navigateTo("memory", { filter: "loop" })}>
            <Blocks size={16} /> Inspect Loop notes
          </button>
          <button className="aos-secondary" onClick={() => navigateTo("memory", { filter: "briefing" })}>
            <Blocks size={16} /> Inspect briefings
          </button>
          {loopFiles.length ? (
            <>
              <strong className="aos-list-label">Saved briefings</strong>
              {loopFiles.map((file) => (
                <button
                  key={file.id}
                  className="aos-secondary"
                  onClick={() => navigateTo("workspace", { file: file.id, folder: "loop" })}
                >
                  <FolderOpen size={16} /> {file.name}
                </button>
              ))}
            </>
          ) : null}
          {notice ? <p className="aos-honest-note">{notice}</p> : null}
        </aside>
        <section className="aos-panel">
          <div className="aos-panel-head">
            <div>
              <span>PREVIEW</span>
              <h2>{saved ? saved.file.name : `${briefingStamp()}.md`}</h2>
            </div>
            <Repeat size={16} />
          </div>
          <pre className="aos-memory-content">
            {saved?.previewText || buildBriefing(preview)}
          </pre>
        </section>
      </div>
    </PageFrame>
  );
}
