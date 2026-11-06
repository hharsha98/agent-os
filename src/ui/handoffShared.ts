// The Hand-off section's rules (spec "SP4 Session extras", Hand-off; Task X8): which Send button a session offers,
// the caption, what a session's own panel says about text handed to it, and what the panel does with the answer to a
// Send. Only type imports, so test/sessions-handoff.test.js loads this file straight from src/.
import type { HandoffResult, SessionSummary } from "../types";

export const HANDOFF_TITLE = "Hand-off";
// The spec's caption, word for word.
export const HANDOFF_CAPTION = "Typed for you, not sent";
// sessionsApi.ts's words for an answer it can't read.
const UNREADABLE = "Agent OS gave an answer that could not be read.";

export interface SendTarget {
  to: "claude" | "codex";
  label: string;
  // The target agent's short name, for the Copy fallback's reason.
  agentLabel: string;
}

// A Claude Code session sends to Codex for review, a Codex session sends to Claude Code; no other session has a Send
// button (Cursor's "Hand to Claude Code or Codex" is Task X10's).
export function sendTargets(session: Pick<SessionSummary, "kind" | "agentId">): SendTarget[] {
  if (session.kind !== "agent") return [];
  if (session.agentId === "claude") return [{ to: "codex", label: "Send to Codex for review", agentLabel: "Codex" }];
  if (session.agentId === "codex") return [{ to: "claude", label: "Send to Claude Code", agentLabel: "Claude Code" }];
  return [];
}

// The Copy fallback's sentence, built here and nowhere else (Task X10's hand-over button imports it too). A server
// "copy" answer brings either a refusal's own sentence or `reason: null`, and the page fills this one in.
export function handoffCopyReason(agentLabel: string): string {
  return `${agentLabel} wasn't ready for typed text in time, so here is the text to copy.`;
}

export type HandoffStatus = { kind: "pending" } | { kind: "typed"; text: string } | { kind: "copy"; text: string; reason: string } | null;

// What a session's own panel says about text handed to it: "…" while Agent OS waits for the agent, the caption and the
// typed text once it is in the agent's input line, or the text to copy when the agent never got ready. An ended session
// shows only the text to copy (a new session that ended before it was ready: the text is not lost). Nothing for
// anything the server did not send.
export function handoffStatus(session: Pick<SessionSummary, "status" | "agentLabel"> & { handoff?: SessionSummary["handoff"] }): HandoffStatus {
  const handoff = session.handoff;
  if (!handoff || typeof handoff !== "object") return null;
  const ended = session.status === "exited";
  if (handoff.state === "pending") return ended ? null : { kind: "pending" };
  const text = typeof handoff.text === "string" ? handoff.text : "";
  if (!text) return null;
  if (handoff.state === "typed") return ended ? null : { kind: "typed", text };
  if (handoff.state === "copy") return { kind: "copy", text, reason: handoffCopyReason(session.agentLabel) };
  return null;
}

export type SendOutcome = { open: string } | { copy: { text: string; reason: string } } | { problem: string };

// "typed" and "opening" open the session the text went to; "copy" shows the text with the server's reason (or the
// Copy fallback's own sentence when it sent none). Anything else is an answer the page can't read.
export function sendOutcome(answer: unknown, target: SendTarget): SendOutcome {
  const result = answer && typeof answer === "object" ? (answer as Partial<HandoffResult>) : null;
  if (result && (result.result === "typed" || result.result === "opening") && typeof result.targetId === "string" && result.targetId) {
    return { open: result.targetId };
  }
  if (result && result.result === "copy" && typeof result.text === "string" && result.text) {
    const reason = typeof result.reason === "string" && result.reason ? result.reason : handoffCopyReason(target.agentLabel);
    return { copy: { text: result.text, reason } };
  }
  return { problem: UNREADABLE };
}
