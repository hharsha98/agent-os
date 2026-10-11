import { SquareTerminal } from "lucide-react";
import { navigateTo } from "../nav";

// Sessions arrive in SP3: each agent's own real terminal inside Agent OS.
// Until then this page says honestly what is coming and where to go today.
export default function SessionsPage() {
  return (
    <section className="aos-phase-page os-sessions-soon" aria-labelledby="os-sessions-title">
      <h1 id="os-sessions-title">Sessions</h1>
      <p className="os-sessions-soon__lead">Work with your agents in their own real terminal, right here.</p>
      <div className="os-sessions-soon__body">
        <SquareTerminal size={20} aria-hidden="true" />
        <div>
          <p>
            Soon you will open Claude Code, Codex, Cursor, Hermes and OpenClaw on this page, each in its real terminal with your own
            settings, and Agent OS will tell you when one is waiting for you.
          </p>
          <p>Until then, you can start a background run from Runs.</p>
          <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("runs")}>
            Open Runs
          </button>
        </div>
      </div>
    </section>
  );
}
