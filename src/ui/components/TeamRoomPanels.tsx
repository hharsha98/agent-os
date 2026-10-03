// The three side panels of a room: the agents' notebook, their proposals
// (where you approve or reject), and the files Agent OS saved (where you
// can Undo). All agent text is rendered as plain text, never as HTML.
import { useState } from "react";
import { decideProposal, undoTeamAction } from "../../api";
import type { TeamAction, TeamProposal } from "../../types";
import { agentLabel, proposalMark, proposalWord } from "../teamRoomShared";
import AgentConfirmModal from "./AgentConfirmModal";
import { TimeAgo } from "./RelativeTime";
import StatusMark from "./StatusMark";
import TeamRoomProblem, { problemFromError, type TeamProblem } from "./TeamRoomProblem";
import { ClampText } from "./TeamRoomTurn";

export function NotebookPanel({ notebook }: { notebook: string }) {
  return (
    <section className="os-panel os-team__side" aria-labelledby="os-team-notebook">
      <h2 id="os-team-notebook" className="os-team__h2">
        Notebook
      </h2>
      {notebook.trim() ? (
        // notebook.md is markdown written by the server ("**Hermes Agent** (turn 1, ...)").
        // It is shown as plain text on purpose (agents wrote it), so drop the bold markers.
        <ClampText text={notebook.replace(/\*\*(.+?)\*\*/g, "$1")} className="os-team__notebook" />
      ) : (
        <p className="os-team__muted">Nothing written yet. Agents add notes with NOTE: lines.</p>
      )}
    </section>
  );
}

type Pending = { proposal: TeamProposal; decision: "approve" | "reject" };

export function ProposalsPanel({
  roomId,
  proposals,
  onChanged
}: {
  roomId: string;
  proposals: TeamProposal[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<TeamProblem | null>(null);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setProblem(null);
    try {
      await decideProposal(roomId, pending.proposal.id, pending.decision);
      setPending(null);
      onChanged();
    } catch (error) {
      setPending(null);
      setProblem(problemFromError(error));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="os-panel os-team__side" aria-labelledby="os-team-proposals" id="os-team-proposals-panel">
      <h2 id="os-team-proposals" className="os-team__h2">
        Proposals
      </h2>
      {problem ? <TeamRoomProblem problem={problem} /> : null}
      {proposals.length === 0 ? (
        <p className="os-team__muted">No proposals yet. Agents make them with PROPOSE: lines.</p>
      ) : (
        <ul className="os-team__cards">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="os-team__card">
              <div className="os-team__card-head">
                <span className="os-mono os-team__pid">{proposal.id}</span>
                <span className="os-team__card-by">{agentLabel(proposal.by)}</span>
                <span className="os-chip">{proposal.kind === "file" ? "file" : "decision"}</span>
                <span className="os-team__turn-status">
                  <StatusMark kind={proposalMark(proposal.status)} label={proposalWord(proposal)} />
                  {proposalWord(proposal)}
                </span>
              </div>
              <p className="os-team__card-summary">{proposal.summary}</p>
              {proposal.kind === "file" && proposal.file ? (
                <details className="os-team__file">
                  <summary>
                    View{" "}
                    <span className="os-mono">{proposal.file.name}</span>
                  </summary>
                  <pre>{proposal.file.content}</pre>
                </details>
              ) : null}
              {proposal.statusReason && !proposal.userDecision ? <p className="os-team__muted">{proposal.statusReason}</p> : null}
              {proposal.disputeReason ? <p className="os-team__muted">Disagreement: {proposal.disputeReason}</p> : null}
              {proposal.status === "needs_approval" ? (
                <div className="os-team__card-actions">
                  <div className="os-team__buttons">
                    <button
                      type="button"
                      className="os-btn os-btn--primary"
                      onClick={() => setPending({ proposal, decision: "approve" })}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="os-btn os-btn--secondary"
                      onClick={() => setPending({ proposal, decision: "reject" })}
                    >
                      Reject
                    </button>
                  </div>
                  <p className="os-team__honest">
                    {proposal.kind === "file"
                      ? "Approving saves this file in the sandbox folder. You can Undo it."
                      : "Approving records your decision. It does not run anything."}
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <AgentConfirmModal
          title={`${pending.decision === "approve" ? "Approve" : "Reject"} ${pending.proposal.id}?`}
          confirmLabel={pending.decision === "approve" ? "Approve" : "Reject"}
          danger={pending.decision === "reject"}
          busy={busy}
          onConfirm={() => void confirm()}
          onClose={() => (busy ? null : setPending(null))}
        >
          <p>{pending.proposal.summary}</p>
          <p>
            {pending.decision === "reject"
              ? "This records that you turned it down. Nothing is deleted."
              : pending.proposal.kind === "file"
                ? "This saves the file in the sandbox folder. You can Undo it afterwards."
                : "This records your decision. It does not run anything."}
          </p>
        </AgentConfirmModal>
      ) : null}
    </section>
  );
}

export function ActionsPanel({
  roomId,
  actions,
  onChanged
}: {
  roomId: string;
  actions: TeamAction[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<TeamAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<TeamProblem | null>(null);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setProblem(null);
    try {
      await undoTeamAction(roomId, pending.id);
      setPending(null);
      onChanged();
    } catch (error) {
      setPending(null);
      setProblem(problemFromError(error));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="os-panel os-team__side" aria-labelledby="os-team-actions">
      <h2 id="os-team-actions" className="os-team__h2">
        Files saved
      </h2>
      {problem ? <TeamRoomProblem problem={problem} /> : null}
      {actions.length === 0 ? (
        <p className="os-team__muted">Nothing saved. A file is only saved when both agents agree on it.</p>
      ) : (
        <ul className="os-team__cards">
          {actions.map((action) => (
            <li key={action.id} className="os-team__card">
              <div className="os-team__card-head">
                <span className="os-mono os-team__pid">{action.id}</span>
                <span className="os-chip">
                  {action.failed ? "refused" : action.created ? "created" : action.updated ? "updated" : "saved"}
                </span>
                <span className="os-team__muted os-team__card-time" title={new Date(action.at).toLocaleString()}>
                  <TimeAgo since={action.at} />
                </span>
              </div>
              <p className="os-mono os-team__path">{action.path}</p>
              {action.failed ? (
                <>
                  <span className="os-team__turn-status">
                    <StatusMark kind="error" label="Refused" />
                    Refused, nothing was saved
                  </span>
                  <p className="os-team__muted">{action.failReason || "No reason was recorded."}</p>
                </>
              ) : action.undone ? (
                <span className="os-team__turn-status">
                  <StatusMark kind="unknown" label="Undone" />
                  Undone
                </span>
              ) : (
                <button type="button" className="os-btn os-btn--secondary" onClick={() => setPending(action)}>
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <AgentConfirmModal
          title="Undo this file?"
          confirmLabel="Undo"
          danger
          busy={busy}
          onConfirm={() => void confirm()}
          onClose={() => (busy ? null : setPending(null))}
        >
          <p className="os-mono">{pending.path}</p>
          <p>
            {pending.created
              ? "This removes the file the room created."
              : "This puts back the saved copy of the file from before the room changed it."}
          </p>
        </AgentConfirmModal>
      ) : null}
    </section>
  );
}
