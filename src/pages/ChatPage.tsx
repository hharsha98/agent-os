import { Loader2, MessageSquare, Save, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addMemory, sendAgentMessage } from "../api";
import { HonestNote, PageFrame } from "./PageFrame";

type ChatAgentId = "cursor" | "claude" | "codex" | "hermes";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  agentId: ChatAgentId;
  text: string;
  badge: string;
};

type LocalAgent = {
  id: string;
  name: string;
  status: string;
  available: boolean;
  version?: string;
  summary?: string;
};

const AGENTS: Array<{ id: ChatAgentId; label: string; moduleId: string | null; hint: string }> = [
  { id: "cursor", label: "Cursor", moduleId: null, hint: "CLI can be installed without chat routing." },
  { id: "claude", label: "Claude Code", moduleId: "claude", hint: "Uses the existing dry-run module API." },
  { id: "codex", label: "Codex", moduleId: "codex", hint: "Uses the existing dry-run module API." },
  { id: "hermes", label: "Hermes", moduleId: "hermes", hint: "Uses the existing dry-run module API." }
];

function storageKey(id: ChatAgentId) {
  return `aos-chat-${id}`;
}

function badgeFor(agent: typeof AGENTS[number], local: LocalAgent | undefined, mode?: string) {
  if (agent.id === "cursor") {
    return local?.available ? "Ready on PATH · chat not wired" : "Not installed";
  }
  if (mode === "dry_run") return "Dry run";
  if (mode === "executed") return "Real reply";
  if (local?.status === "missing_dependency" || local?.available === false) return "Not installed";
  return local?.status === "connected" ? "Ready" : "Checking";
}

export default function ChatPage({ localAgents }: { localAgents: LocalAgent[] }) {
  const [agentId, setAgentId] = useState<ChatAgentId>("claude");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const skipSave = useRef(true);
  const agent = AGENTS.find((item) => item.id === agentId) || AGENTS[1];
  const local = useMemo(
    () => localAgents.find((item) => item.id === agentId),
    [localAgents, agentId]
  );

  useEffect(() => {
    skipSave.current = true;
    try {
      const raw = localStorage.getItem(storageKey(agentId));
      setMessages(raw ? JSON.parse(raw) as ChatMessage[] : []);
    } catch {
      setMessages([]);
    }
  }, [agentId]);

  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    localStorage.setItem(storageKey(agentId), JSON.stringify(messages));
  }, [agentId, messages]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      agentId,
      text,
      badge: "You"
    };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setNotice("");

    if (agent.id === "cursor") {
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          agentId,
          text: local?.available
            ? "Cursor Agent is installed on this Mac, but dashboard chat routing is not wired yet. This is not a fake success. A later phase can add a safe Cursor module after you approve it."
            : "Cursor Agent CLI was not found. Install is not part of this page, and this is not marked connected.",
          badge: badgeFor(agent, local)
        }
      ]);
      return;
    }

    setBusy(true);
    try {
      const result = await sendAgentMessage(agent.moduleId || agent.id, text, { dryRun: true });
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          agentId,
          text: result.reply || "No reply text was returned.",
          badge: badgeFor(agent, local, result.mode)
        }
      ]);
    } catch (caught) {
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          agentId,
          text: caught instanceof Error ? caught.message : "The agent call failed.",
          badge: "Error"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function saveLoop() {
    const last = [...messages].reverse().find((message) => message.role === "assistant");
    if (!last || saving) return;
    setSaving(true);
    try {
      await addMemory({
        title: `${agent.label} loop ${new Date().toISOString().slice(0, 10)}`,
        content: last.text,
        agentId,
        type: "episodic",
        privacy: "private",
        source: "chat-loop",
        tags: ["loop", agentId]
      });
      setNotice("Saved into local Memory. That is Layer 7 on this Mac — not Obsidian.");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not save to memory.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageFrame
      kicker="UNIFIED CHAT · DRY RUN + LOOP"
      title="One box. Four local agents. Honest labels."
      hint="Claude, Codex, and Hermes send dry-run module calls. History now survives a reload in this browser. Saving a reply writes Layer 7 into local memory — not an Obsidian vault."
    >
      <div className="aos-chat-agents">
        {AGENTS.map((item) => {
          const status = localAgents.find((localAgent) => localAgent.id === item.id);
          return (
            <button key={item.id} className={agentId === item.id ? "active" : ""} onClick={() => setAgentId(item.id)}>
              <strong>{item.label}</strong>
              <span>{badgeFor(item, status)}</span>
            </button>
          );
        })}
      </div>
      <HonestNote>{agent.hint} {local?.summary || ""}</HonestNote>
      <div className="aos-chat-log">
        {messages.length === 0 ? (
          <div className="aos-empty small">
            <MessageSquare size={20} />
            <strong>No messages for {agent.label} yet</strong>
            <p>History is stored in this browser per agent. It is not a fake cloud inbox.</p>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`aos-chat-bubble role-${message.role}`}>
              <span>{message.badge}</span>
              <p>{message.text}</p>
            </article>
          ))
        )}
      </div>
      <div className="aos-chat-compose">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Message ${agent.label}…`}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="aos-chat-actions">
          <button className="aos-primary" onClick={() => void send()} disabled={busy || !draft.trim()}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <Send size={16} />} Send
          </button>
          <button className="aos-secondary" onClick={() => void saveLoop()} disabled={saving || messages.every((message) => message.role !== "assistant")}>
            {saving ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save last reply to Memory
          </button>
        </div>
        {notice ? <p className="aos-honest-note">{notice}</p> : null}
      </div>
    </PageFrame>
  );
}
