// Pure helpers for the Team Room screen: status words and marks, the one
// plain-English sentence for each way a room can end, and folding the
// room's event log into one card per turn. No fetching here.
import type { TeamParsedReply, TeamProposal, TeamRoom, TeamRoomEvent, TeamRoomStatus } from "../types";
import type { StatusKind } from "./components/StatusMark";

export const TEAM_AGENT_LABEL: Record<string, string> = {
  hermes: "Hermes Agent",
  openclaw: "OpenClaw"
};

export function agentLabel(agentId: string | undefined) {
  return (agentId && TEAM_AGENT_LABEL[agentId]) || agentId || "Agent";
}

export function roomStatusMark(status: TeamRoomStatus): StatusKind {
  if (status === "running") return "live";
  if (status === "agreed") return "ok";
  if (status === "failed") return "error";
  if (status === "needs_you" || status === "stopped" || status === "cost_cap" || status === "interrupted") return "warn";
  return "unknown";
}

const STATUS_WORD: Record<string, string> = {
  running: "Running",
  needs_you: "Needs you",
  agreed: "Agreed",
  cost_cap: "Cost cap reached",
  stopped: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted"
};

export function roomStatusWord(status: TeamRoomStatus) {
  return STATUS_WORD[status] || status.replace(/_/g, " ");
}

// One sentence per ending, so nobody has to guess what a status means.
export function roomEndSentence(room: TeamRoom): string | null {
  const reason = room.endReason ? ` ${room.endReason}` : "";
  switch (room.status) {
    case "agreed":
      return room.endReason || "Both agents agreed.";
    case "stopped":
      return "You stopped this room. Nothing else will run.";
    case "failed":
      return `This room failed.${reason || " No reason was recorded."}`;
    case "cost_cap":
      return `This room stopped because it reached your cost cap.${reason}`;
    case "interrupted":
      return "Agent OS restarted while this room was running, so the room stopped where it was.";
    case "needs_you":
      return (
        room.endReason ||
        "The agents used all their turns (or minutes) without finishing. Continue to give them more, or leave it here."
      );
    default:
      return null;
  }
}

export function tagLabel(parsed: TeamParsedReply | undefined): string {
  if (!parsed) return "no tag";
  switch (parsed.kind) {
    case "note":
      return "NOTE";
    case "propose":
      return "PROPOSE";
    case "propose_file":
      return "PROPOSE FILE";
    case "agree":
      return `AGREE ${parsed.proposalId || ""}`.trim();
    case "disagree":
      return `DISAGREE ${parsed.proposalId || ""}`.trim();
    default:
      return "no tag";
  }
}

export function proposalMark(status: string): StatusKind {
  if (status === "agreed" || status === "approved" || status === "applied") return "ok";
  if (status === "disputed" || status === "needs_approval") return "warn";
  if (status === "rejected" || status === "refused") return "error";
  return "unknown";
}

const PROPOSAL_WORD: Record<string, string> = {
  open: "Open",
  agreed: "Agreed",
  disputed: "Disputed",
  needs_approval: "Needs approval",
  approved: "Approved",
  rejected: "Rejected",
  applied: "Saved",
  refused: "Refused"
};

export function proposalWord(proposal: TeamProposal) {
  return PROPOSAL_WORD[proposal.status] || proposal.status.replace(/_/g, " ");
}

export function usd(value: number | null | undefined) {
  return typeof value === "number" ? `$${value.toFixed(value < 0.1 ? 3 : 2)}` : "—";
}

export interface TurnView {
  turn: number;
  agentId: "hermes" | "openclaw";
  runId: string;
  ended: TeamRoomEvent | null;
  protocolNotes: string[];
}

// Merges the saved history with whatever the live stream has delivered so far
// (the stream replays history first, so most events arrive twice) and returns
// the events in order, one per sequence number.
export function mergeEvents(...lists: TeamRoomEvent[][]): TeamRoomEvent[] {
  const bySeq = new Map<number, TeamRoomEvent>();
  for (const list of lists) for (const event of list) bySeq.set(event.seq, event);
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

export function deriveTurns(events: TeamRoomEvent[]): TurnView[] {
  const turns = new Map<number, TurnView>();
  for (const event of events) {
    if (typeof event.turn !== "number") continue;
    if (event.type === "turn_started" && event.agentId && event.runId) {
      turns.set(event.turn, { turn: event.turn, agentId: event.agentId, runId: event.runId, ended: null, protocolNotes: [] });
    } else if (event.type === "turn_ended") {
      const existing = turns.get(event.turn);
      if (existing) existing.ended = event;
    } else if (event.type === "protocol_note") {
      const existing = turns.get(event.turn);
      const message = typeof event.message === "string" ? event.message : "";
      if (existing && message) existing.protocolNotes.push(message);
    }
  }
  return Array.from(turns.values()).sort((a, b) => a.turn - b.turn);
}

export function clockEnd(room: TeamRoom, nowMs: number) {
  if (room.status === "running") return nowMs;
  const end = new Date(room.endedAt || room.updatedAt).getTime();
  return Number.isFinite(end) ? end : nowMs;
}

export function minutesLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
