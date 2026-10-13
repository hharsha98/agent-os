import { SquareTerminal } from "lucide-react";
import { navigateTo } from "../nav";
import EmptyState from "../ui/components/EmptyState";
import PageHeader from "../ui/components/PageHeader";

// Sessions arrive in SP3: each agent's own real terminal inside Agent OS.
// Until then this page says honestly what is coming and where to go today.
export default function SessionsPage() {
  return (
    <section aria-labelledby="os-sessions-title">
      <PageHeader
        title="Sessions"
        titleId="os-sessions-title"
        lede="Work with your agents in their own real terminal, right here."
      />
      <EmptyState
        icon={SquareTerminal}
        title="Sessions are coming"
        body="Soon you will open Claude Code, Codex, Cursor, Hermes and OpenClaw on this page, each in its real terminal with your own settings, and Agent OS will tell you when one is waiting for you. Until then, your background runs are on Runs."
        action={
          <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("runs")}>
            Open Runs
          </button>
        }
      />
    </section>
  );
}
