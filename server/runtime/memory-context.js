import { getMemoryState, searchMemory } from "./memory.js";

function excerpt(text, max = 400) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function isBriefing(item) {
  return item?.source === "loop-desk" || (item?.tags || []).includes("briefing");
}

function isVaultNote(item) {
  const tags = item?.tags || [];
  return (
    item?.source === "chat-loop"
    || item?.source === "brain-loop"
    || item?.source === "goal-loop"
    || item?.source === "notebook"
    || item?.source === "journal"
    || item?.source === "capture"
    || item?.source === "swarm"
    || tags.includes("journal")
    || tags.includes("notebook")
    || tags.includes("loop")
  );
}

function pushHit(hits, seen, item, reason) {
  if (!item?.id || seen.has(item.id)) return;
  seen.add(item.id);
  hits.push({
    id: item.id,
    title: item.title || "Untitled",
    source: item.source || "",
    reason,
    excerpt: excerpt(item.content, 400)
  });
}

export async function getMemoryContext({ query = "", limit = 6 } = {}) {
  const state = await getMemoryState();
  const active = (state.memories || []).filter((item) => !item.archived);
  const briefing = active.find(isBriefing) || null;
  const hits = [];
  const seen = new Set();
  const cap = Math.min(12, Math.max(1, Number(limit) || 6));
  const q = String(query || "").trim();

  pushHit(hits, seen, briefing, "latest-briefing");

  if (q) {
    const search = await searchMemory({ query: q, mode: "lexical", limit: Math.max(cap, 4) });
    for (const item of search.results || []) {
      pushHit(hits, seen, item, "search");
      if (hits.length >= cap) break;
    }
  }

  for (const item of active) {
    if (hits.length >= cap) break;
    if (isVaultNote(item)) pushHit(hits, seen, item, item.source || "recent");
  }

  const lines = hits.map((item, index) => `${index + 1}. [${item.reason}] ${item.title}: ${item.excerpt}`);
  const promptBlock = hits.length
    ? `Local Agent OS memory (read before answering):\n${lines.join("\n")}`
    : "";

  return {
    ok: true,
    query: q,
    count: hits.length,
    briefing: briefing
      ? {
        id: briefing.id,
        title: briefing.title,
        updatedAt: briefing.updatedAt,
        excerpt: excerpt(briefing.content, 800)
      }
      : null,
    hits,
    promptBlock
  };
}
