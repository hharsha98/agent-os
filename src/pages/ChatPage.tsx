import { Loader2, MessageSquare, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { sendAgentMessage } from "../api";
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const agent = AGENTS.find((item) => item.id === agentId) || AGENTS[1];
  const local = useMemo(
    () => localAgents.find((item) => item.id === agentId),
    [localAgents, agentId]
  );

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

  return (
    <PageFrame
      kicker="UNIFIED CHAT · DRY RUN"
      title="One box. Four local agents. Honest labels."
      hint="Claude, Codex, and Hermes send dry-run module calls. Cursor tells the truth if chat routing is missing. This page will not turn on live tool execution."
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
            <strong>No messages this session</strong>
            <p>History stays in this browser tab only. It is not a fake connected inbox.</p>
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
        <button className="aos-primary" onClick={() => void send()} disabled={busy || !draft.trim()}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <Send size={16} />} Send
        </button>
      </div>
    </PageFrame>
  );
}
