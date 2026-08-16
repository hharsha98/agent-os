import { Loader2, MessageSquare, Repeat, Save, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addMemory, getMemoryContext, previewCodexMessage, sendAgentMessage } from "../api";
import { type ChatAgentId, chatStorageKey } from "../chatHistory";
import { navigateTo } from "../nav";
import type { MemoryContext } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

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
  { id: "codex", label: "Codex", moduleId: "codex", hint: "Uses Codex API preview when a key is saved; otherwise dry-run." },
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
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [briefing, setBriefing] = useState<MemoryContext["briefing"]>(null);
  const [vaultHits, setVaultHits] = useState(0);
  const skipSave = useRef(true);
  const agent = AGENTS.find((item) => item.id === agentId) || AGENTS[1];
  const local = useMemo(
    () => localAgents.find((item) => item.id === agentId),
    [localAgents, agentId]
  );

  useEffect(() => {
    skipSave.current = true;
    try {
      const raw = localStorage.getItem(chatStorageKey(agentId));
      setMessages(raw ? JSON.parse(raw) as ChatMessage[] : []);
    } catch {
      setMessages([]);
    }
  }, [agentId]);

  useEffect(() => {
    void getMemoryContext({ limit: 6 })
      .then((data) => {
        setBriefing(data.briefing);
        setVaultHits(data.count);
      })
      .catch(() => {
        setBriefing(null);
        setVaultHits(0);
      });
  }, []);

  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    localStorage.setItem(chatStorageKey(agentId), JSON.stringify(messages));
  }, [agentId, messages]);

  async function persistAssistant(message: ChatMessage, label: string, userText = "") {
    if (message.badge === "Error") return;
    const asked = userText.trim();
    const content = asked ? `You: ${asked}\n\n${message.text}` : message.text;
    try {
      await addMemory({
        title: `${label} loop ${new Date().toISOString().slice(0, 10)}`,
        content,
        agentId: message.agentId,
        type: "episodic",
        privacy: "private",
        source: "chat-loop",
        tags: ["loop", message.agentId]
      });
      setNotice("Saved into local Memory automatically. Loop can pick this up without an extra click.");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Reply shown, but Memory save failed.");
    }
  }

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
      const assistant: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        agentId,
        text: local?.available
          ? "Cursor Agent is installed on this Mac, but dashboard chat routing is not wired yet. This is not a fake success. A later phase can add a safe Cursor module after you approve it."
          : "Cursor Agent CLI was not found. Install is not part of this page, and this is not marked connected.",
        badge: badgeFor(agent, local)
      };
      setMessages((current) => [...current, assistant]);
      void persistAssistant(assistant, agent.label, text);
      return;
    }

    setBusy(true);
    try {
      const vault = await getMemoryContext({ query: text, limit: 6 }).catch(() => null);
      if (vault) {
        setBriefing(vault.briefing);
        setVaultHits(vault.count);
      }
      const payload = vault?.promptBlock ? `${vault.promptBlock}\n\nUser:\n${text}` : text;
      let reply = "";
      let mode = "dry_run";
      if (agent.id === "codex") {
        try {
          const preview = await previewCodexMessage(payload);
          reply = preview.reply || "";
          mode = preview.mode || "executed";
        } catch {
          const result = await sendAgentMessage(agent.moduleId || agent.id, payload, { dryRun: true });
          reply = result.reply || "";
          mode = result.mode || "dry_run";
        }
      } else {
        const result = await sendAgentMessage(agent.moduleId || agent.id, payload, { dryRun: true });
        reply = result.reply || "";
        mode = result.mode || "dry_run";
      }
      const used = vault?.count ? ` Read ${vault.count} memory note${vault.count === 1 ? "" : "s"} before answering.` : "";
      const replyText = reply || "No reply text was returned.";
      const assistant: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        agentId,
        text: `${replyText}${used}`,
        badge: badgeFor(agent, local, mode)
      };
      setMessages((current) => [...current, assistant]);
      await persistAssistant({ ...assistant, text: replyText }, agent.label, text);
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
    const lastIndex = messages.map((message) => message.id).lastIndexOf(last.id);
    const lastUser = messages.slice(0, lastIndex >= 0 ? lastIndex : messages.length).reverse().find((message) => message.role === "user");
    setSaving(true);
    try {
      await persistAssistant(last, agent.label, lastUser?.text || "");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageFrame
      kicker="UNIFIED CHAT · VAULT + LOOP"
      title="One box. Four local agents. Memory is read first."
      hint="Claude and Hermes still dry-run the module API. Codex uses the API preview when a key is saved. Every send reads local Memory first, including yesterday’s Loop briefing."
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
      <HonestNote>{agent.hint} {local?.summary || ""} Replies auto-save to Memory. The button below is only a manual retry.</HonestNote>
      {briefing ? (
        <div className="aos-panel" style={{ marginBottom: 16 }}>
          <div className="aos-panel-head">
            <div>
              <span>YESTERDAY’S BRIEFING</span>
              <h2>{briefing.title}</h2>
            </div>
          </div>
          <p>{briefing.excerpt}</p>
          <small>{vaultHits} memory note{vaultHits === 1 ? "" : "s"} ready for the next send.</small>
        </div>
      ) : (
        <p className="aos-honest-note">No Loop briefing yet. Save one on Loop so tomorrow’s chat starts from yesterday’s notes.</p>
      )}
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
            {saving ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save last reply again
          </button>
          <button className="aos-secondary" onClick={() => navigateTo("loop")}>
            <Repeat size={16} /> Open Loop
          </button>
        </div>
        {notice ? <p className="aos-honest-note">{notice}</p> : null}
      </div>
    </PageFrame>
  );
}
