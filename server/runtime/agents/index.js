// Registry of agent adapters.
import hermes from "./hermes.js";
import openclaw from "./openclaw.js";
import claude from "./claude.js";
import codex from "./codex.js";
import cursor from "./cursor.js";

export const ADAPTERS = { hermes, openclaw, claude, codex, cursor };

export function getAdapter(id) {
  return ADAPTERS[id] || null;
}
