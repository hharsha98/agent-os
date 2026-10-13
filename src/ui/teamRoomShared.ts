// Pure helpers for the Team Room screen: the status words, the clock (which
// stops while a room is paused for a decision, D10), what each proposal card
// says, the one plain sentence for each way a room can end, and folding the
// room's event log into one timeline. No fetching and no React here.
import type { TeamAction, TeamParsedReply, TeamProposal, TeamRoom, TeamRoomEvent } from "../types";

export const TEAM_AGENT_LABEL: Record<string, string> = {
  hermes: "Hermes Agent",
  openclaw: "OpenClaw"
};

// Who makes each agent (a small fixed map, as in the approved prototype).
export const TEAM_AGENT_MAKER: Record<string, string> = {
  hermes: "Nous Research",
  openclaw: "Open source"
};

export function agentLabel(agentId: string | undefined) {
  return (agentId && TEAM_AGENT_LABEL[agentId]) || agentId || "Agent";
}

export function agentMaker(agentId: string | undefined) {
  return (agentId && TEAM_AGENT_MAKER[agentId]) || "";
}

export function plural(count: number, one: string, many?: string) {
  return `${count} ${count === 1 ? one : many || `${one}s`}`;
}

// ---- Status ---------------------------------------------------------------

// The same states the page kit's StatusWord accepts (icon plus word).
export type RoomWordState = "live" | "ready" | "waiting" | "idle" | "held" | "failed" | "stopped" | "unknown" | "loading";

export interface RoomStatusView {
  state: RoomWordState;
  label: string;
}

// A room is paused for a decision when it waits on one proposal (D10). The
// status stays the existing "needs_you"; pausedFor says why. A stale pausedFor
// on a room that is not waiting is ignored, so an ended room never reads "Paused".
export function isPaused(room: Pick<TeamRoom, "status" | "pausedFor">): boolean {
  return room.status === "needs_you" && typeof room.pausedFor === "string" && room.pausedFor !== "";
}

export function roomStatusView(room: Pick<TeamRoom, "status" | "pausedFor">): RoomStatusView {
  if (isPaused(room)) return { state: "waiting", label: "Paused for your decision" };
  switch (room.status) {
    case "running":
      return { state: "live", label: "Talking" };
    case "needs_you":
      return { state: "waiting", label: "Needs you" };
    case "agreed":
      return { state: "ready", label: "Agreed" };
    case "cost_cap":
      return { state: "held", label: "Cost cap reached" };
    case "stopped":
      return { state: "stopped", label: "Stopped" };
    case "failed":
      return { state: "failed", label: "Failed" };
    case "interrupted":
      return { state: "stopped", label: "Interrupted" };
    default:
      return { state: "unknown", label: String(room.status || "").replace(/_/g, " ") || "—" };
  }
}

// One sentence per ending, so nobody has to guess what a status means.
export function roomEndSentence(room: TeamRoom): string | null {
  const reason = room.endReason ? ` ${room.endReason}` : "";
  switch (room.status) {
    case "agreed":
      return room.endReason || "The room finished. You approved a file and nothing is still open.";
    case "stopped":
      return "You stopped this room. Nothing else will run.";
    case "failed":
      return `This room failed.${reason || " No reason was recorded."}`;
    case "cost_cap":
      return `This room stopped because it reached your cost cap.${reason}`;
    case "interrupted":
      return "Agent OS restarted while this room was running, so the room stopped where it was.";
    case "needs_you":
      // A paused room says so in its status word and on its card.
      if (isPaused(room)) return null;
      return (
        room.endReason ||
        "The agents used all their turns (or minutes) without finishing. Continue to give them more, or leave it here."
      );
    default:
      return null;
  }
}

// The line under the page title.
export function roomLede(room: Pick<TeamRoom, "status" | "pausedFor">): string {
  if (isPaused(room)) return "The agents agreed on a file. Nothing is saved until you decide.";
  if (room.status === "running") return "Hermes Agent and OpenClaw are talking it through. You are reading along.";
  if (room.status === "needs_you") return "The room is waiting for you. Continue to give the agents more turns.";
  return "This room has ended. What was said stays on this page.";
}

// ---- Tags, proposals, cost -------------------------------------------------

export function hasTag(parsed: TeamParsedReply | undefined): boolean {
  return !!parsed && parsed.kind !== "none";
}

export function tagLabel(parsed: TeamParsedReply | undefined): string {
  if (!parsed) return "No tag";
  switch (parsed.kind) {
    case "note":
      return "Note";
    case "propose":
      return "Proposal";
    case "propose_file":
      return "File proposal";
    case "agree":
      return parsed.proposalId ? `Agrees with ${parsed.proposalId}` : "Agrees";
    case "disagree":
      return parsed.proposalId ? `Disagrees with ${parsed.proposalId}` : "Disagrees";
    default:
      return "No tag";
  }
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

// A turn's cost: "—" when the agent reported none (unknown), "free (local)"
// for a reported $0 on a local Ollama model, otherwise dollars (so a real $0
// reads "$0.000", never "—").
export function turnCostLabel(costUsd: number | null | undefined, model?: string | null) {
  if (typeof costUsd !== "number") return "—";
  if (costUsd === 0 && typeof model === "string" && model.toLowerCase().startsWith("ollama/")) return "free (local)";
  return usd(costUsd);
}

// True until a turn has reported a cost. The server keeps costUsd null (and
// costKnownTurns 0) until then, so a reported zero is told apart from "nothing
// reported yet". The Cost meter and the cost note both read this one rule.
export function costNotReported(room: Pick<TeamRoom, "cost" | "costUsd" | "costKnownTurns">): boolean {
  const known = room.cost?.knownUsd ?? room.costUsd;
  return typeof known !== "number" || (known === 0 && room.costKnownTurns === 0);
}

// The limits panel's cost note: what was reported ("—" until a turn reports a
// cost, never $0.000), and how many turns reported nothing. Rooms saved by an
// older version only have costUsd / costUnknownTurns.
export function roomCostText(room: Pick<TeamRoom, "cost" | "costUsd" | "costKnownTurns" | "costUnknownTurns">) {
  const known = costNotReported(room) ? "—" : usd(room.cost?.knownUsd ?? room.costUsd);
  const unknown = room.cost?.unknownTurns ?? room.costUnknownTurns ?? 0;
  return `${known} known · ${unknown} turn${unknown === 1 ? "" : "s"} unknown`;
}

// The sentence for a failed request that got no answer from Agent OS at all (the
// network dropped, or it timed out). The page cannot know whether the server saw
// the request, so it never says "nothing was changed"; it says it re-checks.
// "room" = a room is open (the view reloads it), "rooms" = the start page (it
// reloads the list of rooms).
export function unreachableMessage(recheck: "room" | "rooms" = "room"): string {
  return `Agent OS did not answer, so this may not have gone through. The page re-checks ${recheck === "rooms" ? "your rooms" : "the room"}.`;
}

// Same rule the server applies to the "OpenClaw model for this room" field:
// plain letters, digits and . _ : / -, up to 100 characters, never starting
// with "-" (so it can't be read as a flag).
export const OPENCLAW_MODEL_PATTERN = /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$/;

export const COST_CAP_NOTE =
  "Hermes doesn't report cost (its model is a subscription or the version doesn't say); the cost cap only counts OpenClaw.";

// A finished turn shows nothing extra; a turn that did not finish shows a word.
export function turnStatusView(status: string | undefined): RoomStatusView | null {
  if (!status || status === "succeeded") return null;
  if (status === "failed") return { state: "failed", label: "Failed" };
  if (status === "timed_out") return { state: "failed", label: "Timed out" };
  if (status === "stopped") return { state: "stopped", label: "Stopped" };
  if (status === "interrupted") return { state: "stopped", label: "Interrupted" };
  return { state: "unknown", label: status.replace(/_/g, " ") };
}

// ---- Events and the timeline -----------------------------------------------

export interface TurnView {
  // Sequence number of the turn_started event, so the turn sorts among the Agent OS rows.
  seq: number;
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
      turns.set(event.turn, { seq: event.seq, turn: event.turn, agentId: event.agentId, runId: event.runId, ended: null, protocolNotes: [] });
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

// One row of the timeline: an agent's turn, or a short line about what Agent OS
// did or what you did ("ask" = waits for you, "undo" = an undone save,
// "more" = turns you added, "plain" = anything else).
export type TimelineItem =
  | { kind: "turn"; key: string; turn: TurnView }
  | { kind: "system"; key: string; tone: "ask" | "plain" | "undo" | "more"; who: "Agent OS" | "You"; text: string };

function proposalName(proposal: TeamProposal | undefined, fallbackId: string): string {
  if (!proposal) return fallbackId || "a proposal";
  return proposal.kind === "file" && proposal.file?.name ? proposal.file.name : proposal.id;
}

export function deriveTimeline(events: TeamRoomEvent[], proposals: TeamProposal[], actions: TeamAction[]): TimelineItem[] {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const rows: Array<{ seq: number; item: TimelineItem }> = deriveTurns(events).map((turn) => ({
    seq: turn.seq,
    item: { kind: "turn", key: `turn-${turn.turn}`, turn }
  }));
  for (const event of events) {
    const id = typeof event.proposalId === "string" ? event.proposalId : "";
    const proposal = id ? byId.get(id) : undefined;
    const name = proposalName(proposal, id);
    const isFile = proposal?.kind === "file";
    const key = `sys-${event.seq}`;
    if (event.type === "proposal_status" && event.status === "needs_approval") {
      rows.push({
        seq: event.seq,
        item: {
          kind: "system",
          key,
          tone: "ask",
          who: "Agent OS",
          text: isFile
            ? `both agents agreed on ${name}. It waits for you instead of saving by itself.`
            : `both agents agreed on ${name}. It waits for your approval.`
        }
      });
    } else if (event.type === "proposal_decided") {
      if (event.status === "refused") {
        rows.push({ seq: event.seq, item: { kind: "system", key, tone: "plain", who: "Agent OS", text: `could not save ${name}. See its card on the right.` } });
      } else if (event.decision === "approve") {
        rows.push({
          seq: event.seq,
          item: {
            kind: "system",
            key,
            tone: "plain",
            who: "You",
            text: isFile ? `approved ${name}. Agent OS saved it in the Workspace sandbox.` : `approved ${name}. Nothing was run.`
          }
        });
      } else {
        rows.push({
          seq: event.seq,
          item: {
            kind: "system",
            key,
            tone: "plain",
            who: "You",
            text: isFile ? `rejected ${name}. Nothing was saved.` : `rejected ${name}. Nothing was changed.`
          }
        });
      }
    } else if (event.type === "action_undone") {
      const path = typeof event.path === "string" && event.path ? event.path : actions.find((a) => a.id === event.actionId)?.path || "the file";
      rows.push({ seq: event.seq, item: { kind: "system", key, tone: "undo", who: "You", text: `undid the save of ${path}.` } });
    } else if (event.type === "limits_extended") {
      const extra = typeof event.extraTurns === "number" ? event.extraTurns : 0;
      rows.push({ seq: event.seq, item: { kind: "system", key, tone: "more", who: "You", text: `gave the room ${extra} more ${extra === 1 ? "turn" : "turns"}.` } });
    }
  }
  return rows.sort((a, b) => a.seq - b.seq).map((row) => row.item);
}

// ended = reported back. live = the room names this run as the current one (the
// live console is drawn). working = the room is running and this is the latest
// turn that started, but the room has not named its run yet (a short gap): it is
// in progress, not lost. never = no report came and none is on its way.
export type TurnPhase = "ended" | "live" | "working" | "never";

export function turnPhase(
  turn: Pick<TurnView, "turn" | "runId" | "ended">,
  ctx: { running: boolean; currentRunId: string | null; latestTurn: number | null }
): TurnPhase {
  if (turn.ended) return "ended";
  if (!ctx.running) return "never";
  if (ctx.currentRunId !== null && ctx.currentRunId === turn.runId) return "live";
  if (ctx.latestTurn !== null && turn.turn === ctx.latestTurn) return "working";
  return "never";
}

// The number of the latest turn that started, read from the timeline rows.
export function latestStartedTurn(items: TimelineItem[]): number | null {
  let latest: number | null = null;
  for (const item of items) {
    if (item.kind === "turn" && (latest === null || item.turn.turn > latest)) latest = item.turn.turn;
  }
  return latest;
}

// What a turn with no report says. "The room stopped first" is only true when the
// room is not running.
export function turnMissingText(roomRunning: boolean): string {
  return roomRunning ? "No report was recorded for this turn." : "This turn never reported back (the room stopped first).";
}

// ---- Clock -----------------------------------------------------------------

export function minutesLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// Time the room has used, in ms, or null when it cannot be known.
// - Paused for a decision: the stored clockUsedMs, whatever "now" is. The clock
//   is stopped, so this never ticks (and survives a restart of Agent OS).
// - Running: now minus clockStartedAt (the server moves clockStartedAt on a
//   resume so this stays true, see "Assumptions about A1 and A2").
// - Anything else: up to the end (or the last update).
export function roomElapsedMs(room: TeamRoom, nowMs: number): number | null {
  if (isPaused(room) && typeof room.clockUsedMs === "number" && Number.isFinite(room.clockUsedMs)) {
    return Math.max(0, room.clockUsedMs);
  }
  const start = new Date(room.clockStartedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const end = room.status === "running" ? nowMs : new Date(room.endedAt || room.updatedAt).getTime();
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

// A time of day for a turn ("14:03:22"), or "—" when the event has no valid time.
export function clockTime(iso: string | undefined): string {
  const ms = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---- Decision cards --------------------------------------------------------

// pending = waits for you; saved / undone / rejected / refused / recorded = decided;
// talking = still being discussed by the agents (open, agreed a moment ago, disputed).
export type DecisionCardState = "pending" | "saved" | "undone" | "rejected" | "refused" | "recorded" | "talking";

// What the page remembers about one card between reloads, keyed by room plus
// proposal. A card moves to another list when it is decided and remounts, so
// anything that must survive that lives in the room view, under this key.
export function decisionKey(roomId: string, proposalId: string): string {
  return `${roomId}:${proposalId}`;
}

export interface CardCopy {
  title: string;
  sub: string;
}

// The note on a card the room is paused on. "If it can": after the decision the
// server only carries on when the execution gate is on, no other room runs and
// both agents are ready.
export const PAUSED_CARD_NOTE =
  "The room is paused until you decide. After that it carries on with the turns it has left if it can, and the agents hear what you decided in their next turn.";

// The words on a card. Every sentence is something the page knows is true:
// - where a saved file is comes from the action (the room wrote it), never from the state alone;
// - "the agents are told in their next turn" only when `told` is set, which the
//   room view sets when this page's own decision ended the pause (the answer said
//   `resumed`, or the room was paused on this proposal at that moment). After a
//   reload the page no longer knows, so it falls back to the plain sentence.
export function decisionCardCopy(
  state: DecisionCardState,
  proposal: TeamProposal,
  action: TeamAction | undefined,
  told: boolean
): CardCopy {
  const isFile = proposal.kind === "file";
  switch (state) {
    case "pending": {
      const agreed = proposal.agreedBy ? `${agentLabel(proposal.agreedBy)} agreed.` : "Both agents agree.";
      return {
        title: isFile ? "Needs you: save this file?" : "Needs you: record this decision?",
        sub: `${agentLabel(proposal.by)} proposed it in turn ${proposal.turn}. ${agreed}`
      };
    }
    case "saved":
      return { title: "Saved to the Workspace", sub: action ? "You approved it. It is saved in the Workspace sandbox." : "You approved it." };
    case "undone":
      return {
        title: "Save undone",
        sub: action?.created ? "The file is gone from the Workspace again." : "The Workspace has the earlier copy back."
      };
    case "rejected":
      return {
        title: isFile ? "Rejected, nothing saved" : "Rejected",
        sub: `You said no. ${isFile ? "Nothing was saved." : "Nothing was changed."}${told ? " The agents are told in their next turn." : ""}`
      };
    case "refused":
      return { title: "Refused, nothing saved", sub: action?.failReason || proposal.statusReason || "No reason was recorded." };
    case "recorded":
      return { title: "Decision recorded", sub: "You approved it. Nothing was run." };
    default:
      return { title: proposal.id, sub: "" };
  }
}

// The newest action for a proposal, if the room wrote one.
export function actionForProposal(proposal: TeamProposal, actions: TeamAction[]): TeamAction | undefined {
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (actions[i].proposalId === proposal.id) return actions[i];
  }
  return undefined;
}

export function decisionCardState(proposal: TeamProposal, action: TeamAction | undefined): DecisionCardState {
  if (proposal.status === "needs_approval") return "pending";
  if (action?.failed || proposal.status === "refused") return "refused";
  if (action?.undone) return "undone";
  if (proposal.status === "applied" || (proposal.kind === "file" && action)) return "saved";
  if (proposal.status === "rejected") return "rejected";
  if (proposal.status === "approved") return "recorded";
  return "talking";
}

// Splits the proposals into the ones waiting for you (the one the room is
// paused on first), the ones already decided, and the ones still being discussed.
export function orderProposals(proposals: TeamProposal[], actions: TeamAction[], pausedFor: string | null) {
  const byTurn = (a: TeamProposal, b: TeamProposal) => a.turn - b.turn;
  const needs: TeamProposal[] = [];
  const settled: TeamProposal[] = [];
  const talking: TeamProposal[] = [];
  for (const proposal of proposals) {
    const state = decisionCardState(proposal, actionForProposal(proposal, actions));
    if (state === "pending") needs.push(proposal);
    else if (state === "talking") talking.push(proposal);
    else settled.push(proposal);
  }
  needs.sort((a, b) => (a.id === pausedFor ? -1 : b.id === pausedFor ? 1 : byTurn(a, b)));
  settled.sort(byTurn);
  talking.sort(byTurn);
  return { needs, settled, talking };
}

export function fileKindLabel(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (ext === "md") return "Markdown";
  if (ext === "txt") return "Plain text";
  if (ext === "html" || ext === "htm") return "HTML";
  return "File";
}

// The first lines of a proposed file, and how many more there are.
export function previewLines(content: string, max = 6): { lines: string[]; more: number } {
  const all = content.replace(/\r\n/g, "\n").split("\n");
  while (all.length > 1 && all[all.length - 1] === "") all.pop();
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// ---- "What Agent OS did so far" ---------------------------------------------

export interface RoomSoFar {
  messages: number;
  saved: number;
  savedPaths: string[];
  waitingFiles: number;
  waitingOther: number;
}

export function roomSoFar(turns: TurnView[], proposals: TeamProposal[], actions: TeamAction[]): RoomSoFar {
  const live = actions.filter((action) => !action.failed && !action.undone);
  const waiting = proposals.filter((proposal) => proposal.status === "needs_approval");
  const waitingFiles = waiting.filter((proposal) => proposal.kind === "file").length;
  return {
    messages: turns.filter((turn) => turn.ended).length,
    saved: live.length,
    savedPaths: live.map((action) => action.path),
    waitingFiles,
    waitingOther: waiting.length - waitingFiles
  };
}
