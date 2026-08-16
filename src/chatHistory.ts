export const CHAT_AGENT_IDS = ["cursor", "claude", "codex", "hermes"] as const;

export type ChatAgentId = (typeof CHAT_AGENT_IDS)[number];

export type StoredChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  agentId: ChatAgentId;
  text: string;
  badge: string;
};

export type ChatSnippet = {
  id: string;
  agentId: ChatAgentId;
  badge: string;
  text: string;
  userText?: string;
  at: number;
};

export function chatStorageKey(id: ChatAgentId) {
  return `aos-chat-${id}`;
}

function stampFromId(id: string) {
  const value = Number(String(id).split("-").pop());
  return Number.isFinite(value) ? value : 0;
}

export function loadRecentChatSnippets(limit = 8): ChatSnippet[] {
  if (typeof localStorage === "undefined") return [];
  const snippets: ChatSnippet[] = [];
  for (const agentId of CHAT_AGENT_IDS) {
    try {
      const raw = localStorage.getItem(chatStorageKey(agentId));
      const messages = raw ? JSON.parse(raw) as StoredChatMessage[] : [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role !== "assistant" || message.badge === "Error") continue;
        const previous = messages[index - 1];
        snippets.push({
          id: message.id,
          agentId,
          badge: message.badge,
          text: String(message.text || "").slice(0, 500),
          userText: previous?.role === "user" ? String(previous.text || "").slice(0, 220) : undefined,
          at: stampFromId(message.id)
        });
      }
    } catch {
      // Ignore broken browser history for one agent.
    }
  }
  return snippets.sort((left, right) => right.at - left.at).slice(0, limit);
}
