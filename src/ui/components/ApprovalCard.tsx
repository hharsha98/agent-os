// OpenClaw's approval cards (SP4, ruling R16), on the Safety page and in an open OpenClaw session's panel. A card says
// what OpenClaw asks: "OpenClaw wants to run" with the command for an exec approval, OpenClaw's own summary for the
// other kinds. Allow once and Deny each ask first in Agent OS's own dialog; only after that confirm does exactly that
// answer go to `openclaw approvals resolve <id> allow-once|deny` (Task X3's POST /api/sessions/approvals/resolve). When
// OpenClaw refuses, its own words are shown in the dialog. Nothing is ever answered for you, and a card never names a
// folder (OpenClaw's list has none). A card OpenClaw could not match to one session says "from OpenClaw" where
// `showFrom` asks for it (the session panel). An answered card reads "You allowed it once" or "You said no" until a few
// seconds after OpenClaw's list drops it (approvalView, alertsShared.ts). Keyboard: after a successful answer the keys
// go to that card (the dialog's opener, its button, is gone), see ApprovalList.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, CircleCheck, CircleHelp, CircleX, X } from "lucide-react";
import { resolveApproval, sessionGotNoAnswer, sessionProblem } from "../../sessionsApi";
import type { ApprovalCard as Card, ApprovalDecision } from "../../types";
import {
  APPROVAL_NO_ANSWER,
  FROM_OPENCLAW,
  approvalConfirm,
  approvalDoneHeading,
  approvalHeading,
  approvalView,
  pruneAnswered,
  pruneCardErrors
} from "../alertsShared";
import type { Answered } from "../alertsShared";
import AgentConfirmModal from "./AgentConfirmModal";
import { useInterval } from "./useInterval";
import "../alerts.css";

export default function ApprovalCard({
  card,
  answered,
  from,
  busy,
  error = "",
  onAnswer
}: {
  card: Card;
  answered: ApprovalDecision | null;
  from: boolean;
  busy: boolean;
  // OpenClaw's own words when it refused this card's last answer, kept on the card after the dialog closed.
  error?: string;
  onAnswer: (decision: ApprovalDecision) => void;
}) {
  const heading = answered ? approvalDoneHeading(answered) : approvalHeading(card);
  const Icon = answered === "allow-once" ? CircleCheck : answered === "deny" ? CircleX : CircleHelp;
  // tabIndex -1 and data-approval: where the keys go once this card's answer has removed its buttons (ApprovalList).
  return (
    <article className={`os-approval${answered ? " is-done" : ""}`} aria-label={heading} tabIndex={-1} data-approval={card.id}>
      <h3 className="os-approval__title">
        <Icon size={18} aria-hidden="true" />
        {/* role="status": "You allowed it once" and "You said no" are announced when the answer lands. */}
        <span role={answered ? "status" : undefined}>{heading}</span>
        {from ? <span className="os-approval__from">{FROM_OPENCLAW}</span> : null}
      </h3>
      {card.kind === "exec" ? (
        <p className="os-approval__cmd os-mono">
          <span aria-hidden="true">$ </span>
          {card.summary}
        </p>
      ) : (
        <p className="os-approval__summary">{card.summary}</p>
      )}
      {error && !answered ? <p className="os-approval__error">{error}</p> : null}
      {answered ? null : (
        <>
          <div className="os-approval__acts">
            <button type="button" className="os-btn os-btn--secondary" disabled={busy} onClick={() => onAnswer("allow-once")}>
              <Check size={16} aria-hidden="true" />
              Allow once
            </button>
            <button type="button" className="os-btn os-btn--secondary" disabled={busy} onClick={() => onAnswer("deny")}>
              <X size={16} aria-hidden="true" />
              Deny
            </button>
          </div>
          <p className="os-approval__why">Agent OS never answers for you.</p>
        </>
      )}
    </article>
  );
}

type Asking = { card: Card; decision: ApprovalDecision; busy: boolean; error: string };

// Where the keys go when the button that opened the dialog is gone: a card by its id (its answer removed the buttons), or
// the list (the card left OpenClaw's list while its dialog was open).
type FocusAfter = { id: string } | "list" | null;

// The cards in a list, the confirm, and the answers given here. `empty` is drawn when there is no card (Safety's empty
// state); `onAnswered` reads OpenClaw's list again after an answer went through; `fallbackFocus` gets the keys when no
// card is left to take them (the panel's title, or Safety's heading). The dialog gives focus back to the button that
// opened it; when that button is gone, the keys go to the card (its answer is read out there), else to the list, else to
// `fallbackFocus`. A refusal from OpenClaw stays on its card after the dialog closes, until the card is answered or leaves.
export function ApprovalList({
  cards,
  showFrom,
  empty = null,
  onAnswered,
  fallbackFocus
}: {
  cards: Card[];
  showFrom: boolean;
  empty?: ReactNode;
  onAnswered?: () => void;
  fallbackFocus?: () => void;
}) {
  const [answered, setAnswered] = useState<Record<string, Answered>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<Asking | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<FocusAfter>(null);
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A one-second clock only while an answered card waits to leave. Each tick also forgets an answer OpenClaw no longer
  // lists and that showed long enough, so the clock stops once nothing waits.
  useInterval(
    () => {
      const t = Date.now();
      setNow(t);
      setAnswered((prev) => pruneAnswered(prev, cards, t));
    },
    Object.keys(answered).length > 0 ? 1000 : null
  );
  // A refusal kept for a card goes when the card leaves OpenClaw's list.
  useEffect(() => {
    setErrors((prev) => pruneCardErrors(prev, cards));
  }, [cards, errors]);
  // A question about a card OpenClaw no longer lists (answered elsewhere, or it expired) goes with it, unless its answer
  // is on its way or the dialog shows OpenClaw's error, which the person should be able to read.
  useEffect(() => {
    if (asking && !asking.busy && !asking.error && !cards.some((card) => card.id === asking.card.id)) {
      focusAfter.current = "list";
      setAsking(null);
    }
  }, [cards, asking]);
  // After the dialog closed with its opener gone: the keys go to the card that was answered, else to the list, else to
  // whatever `fallbackFocus` names. (The dialog's own unmount ran first and left the focus alone: giveFocusBack below.)
  useEffect(() => {
    const target = focusAfter.current;
    if (!target || asking) return;
    focusAfter.current = null;
    const list = listRef.current;
    if (typeof target === "object" && list) {
      const node = Array.from(list.querySelectorAll<HTMLElement>("[data-approval]")).find((el) => el.dataset.approval === target.id);
      if (node) {
        node.focus();
        return;
      }
    }
    if (list) list.focus();
    else fallback.current?.();
  }, [answered, asking, cards]);
  const items = approvalView(cards, answered, now);

  async function send() {
    if (!asking || asking.busy) return;
    const { card, decision } = asking;
    setAsking({ card, decision, busy: true, error: "" });
    try {
      await resolveApproval(card.id, decision);
      if (!alive.current) return;
      const at = Date.now();
      setAnswered((prev) => ({ ...prev, [card.id]: { decision, at, card } }));
      setErrors((prev) => {
        if (!(card.id in prev)) return prev;
        const { [card.id]: _gone, ...rest } = prev;
        return rest;
      });
      setNow(at);
      focusAfter.current = { id: card.id };
      setAsking(null);
      onAnswered?.();
    } catch (error) {
      if (!alive.current) return;
      // No answer at all is not a refusal: OpenClaw may have the answer already (Q31).
      const words = sessionGotNoAnswer(error) ? APPROVAL_NO_ANSWER : sessionProblem(error);
      setAsking((current) => (current && current.card.id === card.id ? { ...current, busy: false, error: words } : current));
    }
  }

  // Closing without answering (Cancel, Escape, the dimmed page). Words from OpenClaw or Agent OS that the dialog was
  // showing stay on the card. When the card has left the list the opener is gone too, so the keys go to the list.
  function closeAsking() {
    if (!asking || asking.busy) return;
    const { card, error } = asking;
    if (error) setErrors((prev) => ({ ...prev, [card.id]: error }));
    if (!cards.some((c) => c.id === card.id)) focusAfter.current = "list";
    setAsking(null);
  }

  const copy = asking ? approvalConfirm(asking.card, asking.decision) : null;
  if (items.length === 0 && !asking) return <>{empty}</>;
  return (
    <>
      {items.length > 0 ? (
        <ul className="os-approvals" aria-label="OpenClaw approvals" ref={listRef} tabIndex={-1}>
          {items.map((item) => (
            <li key={item.card.id}>
              <ApprovalCard
                card={item.card}
                answered={item.answered}
                from={showFrom && item.card.sessionId === null}
                busy={asking?.busy === true && asking.card.id === item.card.id}
                error={errors[item.card.id] ?? ""}
                onAnswer={(decision) => setAsking({ card: item.card, decision, busy: false, error: "" })}
              />
            </li>
          ))}
        </ul>
      ) : (
        empty
      )}
      {asking && copy ? (
        <AgentConfirmModal
          title={copy.title}
          confirmLabel={copy.confirm}
          busy={asking.busy}
          onConfirm={() => void send()}
          onClose={closeAsking}
          giveFocusBack={() => focusAfter.current === null}
        >
          <p className="os-approval__confirm">{copy.body}</p>
          {asking.error ? (
            <p className="os-approval__error" role="alert">
              {asking.error}
            </p>
          ) : null}
        </AgentConfirmModal>
      ) : null}
    </>
  );
}
