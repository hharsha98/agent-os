// Pending approvals (SP4): OpenClaw's approval cards (its terminal can't show its own prompts, so Agent OS does), each
// answered only after your click and a confirm (ruling R16; ApprovalCard.tsx), then one row for every other agent
// session that waits for you, which you answer in its own terminal in Sessions. Agent OS never answers for you.
//
// The words say only what is known. Safety does not read Team Rooms, and a Team Room can be paused for the person's
// decision to save a file, so this page never says "nothing is waiting for you": it says nothing from OpenClaw is
// waiting here (and only when OpenClaw could be asked), and where a decision that exists today is made.
import { useRef } from "react";
import { ArrowRight, CircleHelp, Eye, Inbox } from "lucide-react";
import { navigateTo } from "../../nav";
import { APPROVALS_STALE, terminalQuestions } from "../alertsShared";
import { useApprovals } from "../useApprovals";
import { useSessionsList } from "../useSessionsList";
import { ApprovalList } from "./ApprovalCard";
import Banner from "./Banner";
import EmptyState from "./EmptyState";
import StatusWord from "./StatusWord";

function ApprovalsEmpty() {
  return (
    <div className="os-saf-approvals">
      <EmptyState
        icon={Inbox}
        title="Nothing from OpenClaw is waiting here"
        body="When OpenClaw wants to run a command, a card with the exact command shows up here and in its session. You choose Allow once or Deny. Agent OS never answers for you. A Team Room that is waiting to save a file asks in that Team Room."
      />
      <div className="os-saf-ghost" role="group" aria-label="Example of a request card, not a real request">
        <p className="os-saf-ghost__cap"><Eye size={14} aria-hidden="true" /> What a request will look like (example, not real)</p>
        <p className="os-saf-ghost__title"><CircleHelp size={16} aria-hidden="true" /> OpenClaw wants to run</p>
        <p className="os-saf-ghost__cmd os-mono">$ npm test</p>
        <div className="os-saf-ghost__acts">
          <button type="button" className="os-btn os-btn--secondary" disabled>Allow once</button>
          <button type="button" className="os-btn os-btn--secondary" disabled>Deny</button>
        </div>
      </div>
    </div>
  );
}

export default function SafetyApprovals() {
  const approvals = useApprovals(true);
  // Where the keys go when an answer leaves no card to take them (ApprovalList's fallbackFocus).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { source } = useSessionsList();
  const asks = terminalQuestions(source.state === "ok" && !source.stale ? source.data.sessions : []);
  const read = approvals.source;
  const cards = read.state === "ok" ? read.data.approvals : [];
  const pollError = read.state === "ok" ? read.data.error : null;
  // "Nothing from OpenClaw is waiting here" only when that is known: the last read worked and OpenClaw could be asked.
  const known = read.state === "ok" && !read.stale && !pollError;
  return (
    <section className="os-saf-section" aria-labelledby="os-saf-approvals-title">
      <div className="os-saf-section__head">
        <h2 id="os-saf-approvals-title" ref={headingRef} tabIndex={-1}>
          Pending approvals
        </h2>
        <p className="os-saf-section__quiet">What agents are asking you</p>
      </div>
      {pollError ? <Banner tone="warn">{pollError}</Banner> : null}
      {read.state === "error" ? <Banner tone="warn">{read.message}</Banner> : null}
      {read.state === "ok" && read.stale ? <Banner tone="warn">{APPROVALS_STALE}</Banner> : null}
      {read.state === "loading" ? (
        <p className="os-saf-approvals__loading">
          <StatusWord state="loading" />
        </p>
      ) : (
        <ApprovalList
          cards={cards}
          showFrom
          empty={known ? <ApprovalsEmpty /> : null}
          onAnswered={approvals.refresh}
          fallbackFocus={() => headingRef.current?.focus({ preventScroll: true })}
        />
      )}
      {asks.length > 0 ? (
        <ul className="os-saf-waits" aria-label="Sessions waiting for you">
          {asks.map((item) => (
            <li key={item.id} className="os-saf-wait">
              <CircleHelp size={18} aria-hidden="true" />
              <p>
                <b>{item.title}</b> · {item.text}
                <span className="os-saf-wait__sub">It asks in its own terminal, so you answer it in Sessions. Agent OS never answers for you.</span>
              </p>
              <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("sessions", { session: item.id })}>
                Open session
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
