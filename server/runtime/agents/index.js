// Registry of agent adapters. Adding claude/codex/cursor later is just
// another entry here plus its own adapter module.
import hermes from "./hermes.js";
import openclaw from "./openclaw.js";

export const ADAPTERS = { hermes, openclaw };

export function getAdapter(id) {
  return ADAPTERS[id] || null;
}
