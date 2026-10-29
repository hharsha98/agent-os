// "Did this run stop because the person's PLAN ran out?" -- the words and the
// event shape the three coding-agent adapters (claude.js, codex.js, cursor.js)
// share. A limit is never read from the exit code alone: Claude Code has been
// seen to exit 0 after hitting its limit, so each agent's own output decides.
//
// A parser that spots a limit emits ONE run event:
//   { type: "limit", agentId, kind, message, resetsAt? }
//     kind      a short word: "usage_limit", or the agent's own name for which
//               limit it was (Claude: "five_hour", "seven_day", ...)
//     message   one fixed plain-English sentence (never copied from the agent)
//     resetsAt  ISO-8601 time the limit resets, when the agent says so
// The run manager copies the first one onto the run as `meta.limit`
// ({ kind, message, resetsAt? }), so a screen can show a banner without
// reading the whole transcript. The raw sentence the agent printed is still in
// the run's normal output.

// Claude Code: a `result` event with is_error:true whose text says one of these.
export const CLAUDE_LIMIT_TEXT = /usage limit|hit your limit|rate limit reached/i;

// Codex and Cursor print "You've hit your usage limit" (the apostrophe is the
// curly U+2019 in real output; a plain one is accepted too).
export const USAGE_LIMIT_TEXT = /You[’']ve hit your usage limit/i;

// One fixed sentence per agent. Since SP4 it is also the alert text of a held
// session (Task X1b).
export const LIMIT_MESSAGE = {
  claude: "Claude Code's plan limit was reached.",
  codex: "Codex's plan limit was reached.",
  cursor: "Cursor's plan limit was reached."
};

// Claude gives the reset time as seconds since 1970. A value that is clearly in
// milliseconds is accepted too. Anything else gives undefined.
export function resetsAtFrom(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function limitEvent(agentId, { kind, resetsAt } = {}) {
  const event = {
    type: "limit",
    agentId,
    kind: typeof kind === "string" && /^[a-z0-9_]{1,40}$/i.test(kind) ? kind : "usage_limit",
    message: LIMIT_MESSAGE[agentId] || "The plan limit was reached."
  };
  if (typeof resetsAt === "string" && resetsAt) event.resetsAt = resetsAt;
  return event;
}
