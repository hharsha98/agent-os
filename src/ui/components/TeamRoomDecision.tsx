// The decision cards of a room (D10). A file the agents agree on is never saved
// by itself: it becomes "Needs you: save this file?" with Approve and Reject.
// After you decide, the same card turns into what happened: saved (with Undo),
// rejected, undone or refused. All agent text is rendered as plain text.
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle2, FileText, Undo2, XCircle } from "lucide-react";
import { decideProposal, undoTeamAction } from "../../api";
import { navigateTo } from "../../nav";
import type { TeamAction, TeamProposal, TeamRoom } from "../../types";
import {
  PAUSED_CARD_NOTE,
  actionForProposal,
  agentLabel,
  decisionCardCopy,
  decisionCardState,
  decisionKey,
  fileKindLabel,
  orderProposals,
  previewLines,
  proposalWord,
  type DecisionCardState
} from "../teamRoomShared";
import AgentConfirmModal from "./AgentConfirmModal";
import TeamRoomProblem, { problemFromError, type TeamProblem } from "./TeamRoomProblem";

// After a decision the card that held the focus is replaced by the card in its
// new state (it can even move to another list). The id of the card that should
// take the focus is kept here, outside React state, so it survives that swap.
let focusCardAfterChange: string | null = null;

// What the room view remembers about a card for as long as the room is open (key:
// room plus proposal, see decisionKey). A card that is decided moves from "Needs
// you" to "Decided" and remounts, so its own state is lost; these two survive it.
export interface DecisionMemory {
  // This page's own decision ended the pause, so the agents will be told.
  told?: boolean;
  // The calm "already decided" note after a 409, shown on the result card.
  notice?: TeamProblem;
}

function DecisionCard({
  room,
  proposal,
  action,
  state,
  memory,
  remember,
  onDecided,
  onChanged
}: {
  room: TeamRoom;
  proposal: TeamProposal;
  action: TeamAction | undefined;
  state: DecisionCardState;
  memory: DecisionMemory | undefined;
  remember: (proposalId: string, patch: Partial<DecisionMemory>) => void;
  onDecided: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<TeamProblem | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const file = proposal.kind === "file" ? proposal.file : undefined;
  const copy = decisionCardCopy(state, proposal, action, memory?.told === true);
  const headingId = `os-team-card-${proposal.id}`;
  const pausedHere = room.status === "needs_you" && room.pausedFor === proposal.id;
  const Icon = state === "pending" ? FileText : state === "undone" ? Undo2 : state === "rejected" || state === "refused" ? XCircle : CheckCircle2;

  // Move the focus to the card once it shows its new state, so a keyboard or
  // screen reader user hears what happened instead of losing the button.
  useEffect(() => {
    if (focusCardAfterChange === proposal.id && state !== "pending") {
      focusCardAfterChange = null;
      cardRef.current?.focus();
    }
  });

  async function decide(decision: "approve" | "reject") {
    if (busy) return;
    setBusy(decision);
    setProblem(null);
    remember(proposal.id, { notice: undefined });
    // Was the room paused on this very card when you pressed the button?
    const pausedAtClick = pausedHere;
    try {
      const result = await decideProposal(room.id, proposal.id, decision);
      // The agents are told only when this decision ended the pause.
      if (result.resumed === true || pausedAtClick) remember(proposal.id, { told: true });
      focusCardAfterChange = proposal.id;
      await onDecided();
    } catch (error) {
      const next = problemFromError(error);
      if (next.code === "not_pending") {
        // Already decided (another window, or a double click). The reload moves this
        // card to Decided and remounts it, so the note is kept in the room view, and
        // the focus goes to the result card.
        remember(proposal.id, { notice: next });
        focusCardAfterChange = proposal.id;
      } else {
        setProblem(next);
      }
      // Always reload: after a 403 the card stays pending, after a 409 it shows the result.
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    if (!action) return;
    setUndoBusy(true);
    setProblem(null);
    remember(proposal.id, { notice: undefined });
    try {
      await undoTeamAction(room.id, action.id);
      setUndoOpen(false);
      focusCardAfterChange = proposal.id;
      await onChanged();
    } catch (error) {
      setUndoOpen(false);
      setProblem(problemFromError(error));
      await onChanged();
    } finally {
      setUndoBusy(false);
    }
  }

  const shownProblem = problem ?? memory?.notice ?? null;
  const preview = file && state === "pending" ? previewLines(file.content, showAll ? Number.POSITIVE_INFINITY : 6) : null;

  return (
    <div ref={cardRef} tabIndex={-1} className="os-team__decision" data-state={state} role="group" aria-labelledby={headingId}>
      <div className="os-team__decision-head">
        <Icon size={20} aria-hidden="true" />
        <h2 id={headingId} className="os-team__h3">
          {copy.title}
        </h2>
      </div>
      {copy.sub ? <p className="os-team__sub">{copy.sub}</p> : null}
      {proposal.summary ? <p className="os-team__summary">{proposal.summary}</p> : null}

      {file ? (
        <div className="os-team__file">
          <code>{state === "saved" && action ? action.path : file.name}</code>
          <span className="os-team__tag">{fileKindLabel(file.name)}</span>
        </div>
      ) : null}

      {preview && file ? (
        <div className="os-team__prev-wrap">
          <pre
            className="os-team__prev"
            tabIndex={showAll ? 0 : undefined}
            aria-label={showAll ? `${file.name}, the whole file` : `Start of ${file.name}`}
          >
            {preview.lines.join("\n")}
          </pre>
          {preview.more > 0 || showAll ? (
            <button type="button" className="os-team__more" aria-expanded={showAll} title="Show the whole file" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show less" : `… ${preview.more} more ${preview.more === 1 ? "line" : "lines"}`}
            </button>
          ) : null}
        </div>
      ) : null}

      {state === "pending" ? (
        <>
          <p className="os-team__note">
            {file
              ? "Saved in the Workspace sandbox only, in this room's folder. Nothing is saved until you press Approve, and you can undo it afterwards."
              : "Approving records your decision. It does not run anything."}
          </p>
          {pausedHere ? <p className="os-team__note">{PAUSED_CARD_NOTE}</p> : null}
        </>
      ) : null}
      {state === "saved" && action ? (
        <p className="os-team__note">
          {action.created
            ? "Changed your mind? Undo removes the file and leaves the sandbox as it was before."
            : "Changed your mind? Undo puts back the copy that was there before."}
        </p>
      ) : null}

      {shownProblem ? <TeamRoomProblem problem={shownProblem} where="decision" /> : null}

      {state === "pending" ? (
        <div className="os-team__acts">
          <button
            type="button"
            className="os-btn os-btn--primary"
            aria-disabled={busy !== null}
            aria-busy={busy === "approve"}
            onClick={() => void decide("approve")}
          >
            <Check size={16} aria-hidden="true" />
            {busy === "approve" ? "Saving…" : file ? "Approve and save" : "Approve"}
          </button>
          <button type="button" className="os-btn os-btn--secondary" aria-disabled={busy !== null} onClick={() => void decide("reject")}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      ) : null}
      {state === "saved" && action ? (
        <div className="os-team__acts">
          <button type="button" className="os-btn os-btn--secondary" onClick={() => setUndoOpen(true)}>
            <Undo2 size={16} aria-hidden="true" />
            Undo save
          </button>
          <button type="button" className="os-btn os-btn--ghost" onClick={() => navigateTo("workspace")}>
            Open the Workspace
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {undoOpen && action ? (
        <AgentConfirmModal
          title="Undo this save?"
          confirmLabel="Undo save"
          danger
          busy={undoBusy}
          onConfirm={() => void undo()}
          onClose={() => (undoBusy ? null : setUndoOpen(false))}
        >
          <p className="os-mono os-team__modal-path">{action.path}</p>
          <p>
            {action.created
              ? "This removes the file the room created."
              : "This puts back the saved copy of the file from before the room changed it."}
          </p>
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}

interface ListProps {
  room: TeamRoom;
  proposals: TeamProposal[];
  actions: TeamAction[];
  // After Approve or Reject: reload the room (and the room may start running again).
  onDecided: () => Promise<void>;
  // After anything else: reload the room.
  onChanged: () => Promise<void>;
  // What the room view remembers about each card (see DecisionMemory), and how to add to it.
  memory: Record<string, DecisionMemory>;
  remember: (proposalId: string, patch: Partial<DecisionMemory>) => void;
}

// The cards that wait for you: the top of the side column.
export function TeamRoomNeedsYou(props: ListProps) {
  const { needs } = orderProposals(props.proposals, props.actions, props.room.pausedFor ?? null);
  if (needs.length === 0) return null;
  return (
    <div className="os-team__cards" id="os-team-decisions">
      {needs.map((proposal) => (
        <DecisionCard
          key={proposal.id}
          room={props.room}
          proposal={proposal}
          action={actionForProposal(proposal, props.actions)}
          state="pending"
          memory={props.memory[decisionKey(props.room.id, proposal.id)]}
          remember={props.remember}
          onDecided={props.onDecided}
          onChanged={props.onChanged}
        />
      ))}
    </div>
  );
}

// Everything already decided, then the proposals the agents are still discussing.
export function TeamRoomDecided(props: ListProps) {
  const { settled, talking } = orderProposals(props.proposals, props.actions, props.room.pausedFor ?? null);
  if (settled.length === 0 && talking.length === 0) return null;
  return (
    <>
      {settled.length > 0 ? (
        <section className="os-team__decided" aria-labelledby="os-team-decided-h">
          <h2 id="os-team-decided-h" className="os-team__h">
            Decided
          </h2>
          <div className="os-team__cards">
            {settled.map((proposal) => {
              const action = actionForProposal(proposal, props.actions);
              return (
                <DecisionCard
                  key={proposal.id}
                  room={props.room}
                  proposal={proposal}
                  action={action}
                  state={decisionCardState(proposal, action)}
                  memory={props.memory[decisionKey(props.room.id, proposal.id)]}
                  remember={props.remember}
                  onDecided={props.onDecided}
                  onChanged={props.onChanged}
                />
              );
            })}
          </div>
        </section>
      ) : null}
      {talking.length > 0 ? (
        <section className="os-team__decided" aria-labelledby="os-team-talking-h">
          <h2 id="os-team-talking-h" className="os-team__h">
            Still being discussed
          </h2>
          <ul className="os-team__talking">
            {talking.map((proposal) => (
              <li key={proposal.id}>
                <div className="os-team__talk-head">
                  <span className="os-mono">{proposal.id}</span>
                  <span>{agentLabel(proposal.by)}</span>
                  <span className="os-chip">{proposal.kind === "file" ? "file" : "decision"}</span>
                  <span className="os-team__muted">{proposalWord(proposal)}</span>
                </div>
                <p className="os-team__summary">{proposal.summary}</p>
                {proposal.disputeReason ? <p className="os-team__muted">Disagreement: {proposal.disputeReason}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
