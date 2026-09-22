import { Loader2, MessageSquare, Repeat, Save, Send, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addMemory, getExecutionGateStatus, getLocalAgents, getMemoryContext, getProductStatus, previewCodexMessage, runDemoTimeline, sendAgentMessage, sendDemoChat } from "../api";
import { DEMO_BADGE } from "../demo";
import { type ChatAgentId, chatStorageKey } from "../chatHistory";
import { chatLabel, cursorChatNotice, type LocalAgentRecord } from "../localAgents";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus, MemoryContext } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  agentId: ChatAgentId;
  text: string;
  badge: string;
  steps?: Array<{ id: string; agentId: string; title: string; detail: string; status: string }>;
};

const AGENTS: Array<{ id: ChatAgentId; label: string; moduleId: string | null; hint: string; example: string }> = [
  { id: "cursor", label: "Cursor", moduleId: null, hint: "CLI can be installed without chat routing.", example: "What would Cursor do with a failing test? (This will not call the CLI.)" },
  { id: "claude", label: "Claude Code", moduleId: "claude", hint: "Uses the existing dry-run module API.", example: "Plan a dry-run for: add a README section on local v1." },
  { id: "codex", label: "Codex", moduleId: "codex", hint: "Uses Codex API preview when a key is saved; otherwise dry-run.", example: "Preview a three-step workflow for a morning briefing." },
  { id: "hermes", label: "Hermes", moduleId: "hermes", hint: "Uses the existing dry-run module API.", example: "Draft a local research plan that does not call tools yet." }
];

function sendHint(
  agent: typeof AGENTS[number],
  local: LocalAgentRecord | undefined,
  gateOff: boolean,
  agentsReady: boolean,
  agentsError = ""
) {
  if (agent.id === "cursor") {
    if (!agentsReady) return "Checking whether the Cursor CLI is on PATH. Nothing is marked connected yet.";
    if (agentsError && !local) return "Agent status failed to load. Send will not invent an install state.";
    return local?.cli?.found || local?.available
      ? "Send returns an honest notice. Cursor chat is not wired."
      : "Send returns an honest not-installed notice. Nothing is marked connected.";
  }
  if (!agentsReady) return "Checking local agent status before sending.";
  if (agentsError && !local) return "Agent status failed to load. Send will not invent an install state.";
  if (agent.id === "codex" && local?.chat?.mode === "preview") {
    return "Send calls the local Codex API preview. That is not a live tool-using run.";
  }
  if (local?.chat?.mode === "unavailable" || local?.status === "not_installed") {
    return "Send still dry-runs the module API, which will report the missing CLI instead of faking a reply.";
  }
  return gateOff
    ? "Send asks for a dry-run plan. Live execution stays off."
    : "The execution gate is on, but this composer still sends dryRun: true.";
}

export default function ChatPage({ localAgents }: { localAgents: LocalAgentRecord[] }) {
  const [agentId, setAgentId] = useState<ChatAgentId>("claude");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [briefing, setBriefing] = useState<MemoryContext["briefing"]>(null);
  const [vaultHits, setVaultHits] = useState(0);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [probedAgents, setProbedAgents] = useState<LocalAgentRecord[]>(localAgents);
  const [agentsReady, setAgentsReady] = useState(localAgents.length > 0);
  const [agentsError, setAgentsError] = useState("");
  const [demoPublic, setDemoPublic] = useState(false);
  const [demoReady, setDemoReady] = useState(false);
  const skipSave = useRef(true);
  const agent = AGENTS.find((item) => item.id === agentId) || AGENTS[1];
  const agents = probedAgents.length ? probedAgents : localAgents;
  const local = useMemo(
    () => agents.find((item) => item.id === agentId),
    [agents, agentId]
  );
  const gateOff = gate?.enabled !== true;

  useEffect(() => {
    if (localAgents.length) {
      setProbedAgents(localAgents);
      setAgentsReady(true);
    }
  }, [localAgents]);

  useEffect(() => {
    let cancelled = false;
    void getLocalAgents()
      .then((next) => {
        if (cancelled) return;
        setProbedAgents(next);
        setAgentsReady(true);
        setAgentsError("");
      })
      .catch((caught) => {
        if (cancelled) return;
        setAgentsError(caught instanceof Error ? caught.message : "Could not load agent status.");
        setAgentsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    void getExecutionGateStatus()
      .then(setGate)
      .catch(() => setGate(null));
    void getProductStatus()
      .then((product) => {
        setDemoPublic(Boolean(product.demoPublic));
        setDemoReady(true);
      })
      .catch(() => setDemoReady(true));
  }, []);

  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    localStorage.setItem(chatStorageKey(agentId), JSON.stringify(messages));
  }, [agentId, messages]);

  async function persistAssistant(message: ChatMessage, label: string, userText = "") {
    if (message.badge === "Error" || message.badge === "Checking") return;
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
      setNotice(demoPublic
        ? "Saved into the demo server's Memory. This is a shared sandbox, not your Claude account."
        : "Saved into local Memory. Loop can read this later. This is on this machine, not a cloud inbox.");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Reply shown, but Memory save failed.");
    }
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? draft).trim();
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

    if (demoPublic) {
      setBusy(true);
      try {
        const result = await sendDemoChat(agent.id, text);
        const assistant: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          agentId,
          text: result.reply || "No demo plan was returned.",
          badge: "Demo"
        };
        setMessages((current) => [...current, assistant]);
        await persistAssistant(assistant, agent.label, text);
      } catch (caught) {
        setMessages((current) => [
          ...current,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            agentId,
            text: caught instanceof Error ? caught.message : "The demo plan failed.",
            badge: "Error"
          }
        ]);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (agent.id === "cursor") {
      const cursorNotice = cursorChatNotice(local, { loaded: agentsReady, error: agentsError });
      const assistant: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        agentId,
        text: cursorNotice.text,
        badge: cursorNotice.badge
      };
      setMessages((current) => [...current, assistant]);
      if (cursorNotice.persist) void persistAssistant(assistant, agent.label, text);
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
        badge: mode === "dry_run" ? "Dry run" : mode === "executed" ? (agent.id === "codex" ? "API preview" : "Real reply") : chatLabel(local)
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

  async function runTimeline() {
    const text = draft.trim() || agent.example;
    if (busy || !demoPublic) return;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      agentId,
      text,
      badge: "You"
    };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setBusy(true);
    setNotice("");
    try {
      const result = await runDemoTimeline(text);
      const assistant: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        agentId,
        text: result.steps?.length
          ? `${result.badge}\n\nSimulated fleet timeline for: ${result.focus}\nYour real Claude is not connected.\n\n${result.steps.map((step, index) => `${index + 1}. ${step.title} — ${step.detail}`).join("\n")}\n\nSaved ${result.workspaceFile?.relativePath || "a sandbox note"}.`
          : "The simulated timeline returned no steps.",
        badge: "Demo timeline",
        steps: result.steps
      };
      setMessages((current) => [...current, assistant]);
      await persistAssistant(assistant, "Demo fleet", text);
      setNotice(result.workspaceFile?.relativePath
        ? `Timeline written to ${result.workspaceFile.relativePath}. Open Workspace to read it. Host shell was not used.`
        : "Timeline finished. Host shell was not used.");
    } catch (caught) {
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          agentId,
          text: caught instanceof Error ? caught.message : "The simulated timeline failed.",
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
      kicker={demoPublic ? "UNIFIED CHAT · PUBLIC DEMO" : "UNIFIED CHAT · DRY-RUN"}
      title={demoPublic ? "One box. A simulated fleet. Plans, then a timeline." : "One box. Four local agents. Plans, not silent shell."}
      hint={demoPublic
        ? `${DEMO_BADGE}. Demo plans and the multi-agent timeline are simulated. Your real Claude, Cursor, Codex, and Hermes are not connected.`
        : "Claude and Hermes dry-run the module API. Codex uses the API preview when a key is saved. Cursor tells the truth if chat is not wired. History stays in this browser."}
    >
      <div className="aos-product-banner" role="status">
        <ShieldCheck size={18} />
        <div>
          <strong>{demoPublic ? DEMO_BADGE : gateOff ? "Dry-run is on" : "Execution gate is on"}</strong>
          <p>{demoPublic
            ? "Send a demo plan, or run the simulated timeline. The timeline writes a note in the shared sandbox and does not start a shell."
            : `${sendHint(agent, local, gateOff, agentsReady, agentsError)} Replies can save to local Memory. This is not a cloud inbox.`}</p>
        </div>
      </div>
      <div className="aos-chat-agents">
        {AGENTS.map((item) => {
          const status = agents.find((localAgent) => localAgent.id === item.id);
          return (
            <button key={item.id} className={agentId === item.id ? "active" : ""} onClick={() => setAgentId(item.id)}>
              <strong>{item.label}</strong>
              <span>{chatLabel(status)}</span>
            </button>
          );
        })}
      </div>
      <HonestNote>{demoPublic ? `${local?.summary || "Simulated demo agent."} The buttons below do not start a host CLI.` : `${agent.hint} ${local?.summary || ""} The Send button below does not enable live tools.`}</HonestNote>
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
        <p className="aos-honest-note">No Loop briefing yet. Save one on Loop so later chat can start from those notes.</p>
      )}
      <div className="aos-chat-log">
        {messages.length === 0 ? (
          <div className="aos-empty small">
            <MessageSquare size={20} />
            <strong>No messages for {agent.label} yet</strong>
            <p>{demoPublic ? "History stays in this browser. Try the example, then run the simulated timeline." : "History is stored in this browser per agent. Try the example, or type your own dry-run prompt."}</p>
            <button className="aos-secondary" disabled={busy || !demoReady} onClick={() => void send(agent.example)}>{agent.example}</button>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`aos-chat-bubble role-${message.role}`}>
              <span>{message.badge}</span>
              <p>{message.text}</p>
              {message.steps?.length ? (
                <ol className="aos-demo-steps">
                  {message.steps.map((step) => (
                    <li key={step.id}>
                      <strong>{step.title}</strong>
                      <small>{step.agentId} · {step.status}</small>
                    </li>
                  ))}
                </ol>
              ) : null}
            </article>
          ))
        )}
      </div>
      <div className="aos-chat-compose">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={demoPublic ? `Demo prompt for ${agent.label}…` : `Dry-run message for ${agent.label}…`}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="aos-chat-actions">
          <button className="aos-primary" onClick={() => void send()} disabled={busy || !demoReady || !draft.trim()}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <Send size={16} />} {demoPublic ? "Send demo plan" : "Send dry-run"}
          </button>
          {demoPublic ? (
            <button className="aos-secondary" onClick={() => void runTimeline()} disabled={busy || !demoReady}>
              {busy ? <Loader2 className="aos-spin" size={16} /> : <Repeat size={16} />} Run simulated timeline
            </button>
          ) : null}
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
