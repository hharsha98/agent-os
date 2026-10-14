import { CircleHelp, Eye, Inbox } from "lucide-react";
import EmptyState from "./EmptyState";

// Pending approvals. Nothing can ask here until SP4 brings OpenClaw's approval cards and the coding
// agents' waiting rows; until then this is the designed empty state (decision D-D2-5).
//
// The words say only what is known. Safety does not read Team Rooms, and a Team Room can be
// paused for the person's decision to save a file, so this page never says "nothing is waiting for
// you": it says no requests arrive HERE yet, and where a decision that exists today is made.
export default function SafetyApprovals() {
  return (
    <section className="os-saf-section" aria-labelledby="os-saf-approvals-title">
      <div className="os-saf-section__head">
        <h2 id="os-saf-approvals-title">Pending approvals</h2>
        <p className="os-saf-section__quiet">What agents are asking you</p>
      </div>
      <div className="os-saf-approvals">
        <EmptyState
          icon={Inbox}
          title="No approval requests arrive here yet"
          body="When agents can ask to run a command here, a card with the exact command will appear in this list. You choose Allow once or Deny. Agent OS never answers for you. A Team Room that is waiting to save a file asks in that Team Room."
        />
        <div className="os-saf-ghost" role="group" aria-label="Example of a request card, not a real request">
          <p className="os-saf-ghost__cap"><Eye size={14} aria-hidden="true" /> What a request will look like (example, not real)</p>
          <p className="os-saf-ghost__title"><CircleHelp size={16} aria-hidden="true" /> OpenClaw wants to run a command in my-app</p>
          <p className="os-saf-ghost__cmd os-mono">$ npm test</p>
          <div className="os-saf-ghost__acts">
            <button type="button" className="os-btn os-btn--secondary" disabled>Allow once</button>
            <button type="button" className="os-btn os-btn--secondary" disabled>Deny</button>
          </div>
        </div>
      </div>
    </section>
  );
}
