// "Agent safeguards": a compact read-only list built from each agent's real
// GET /api/agents/:id safety detail. This screen never offers the fix
// buttons itself -- the Agents page owns those -- only a link there.
import StatusMark from "./StatusMark";
import type { AgentDetail } from "../../setupApi";

function hasAction(detail: AgentDetail | null | undefined, actionId: string) {
  return Boolean(detail?.safety.actions?.some((a) => a.id === actionId));
}

export default function SafetySafeguards({
  hermes,
  openclaw,
  checked,
  onOpenAgent
}: {
  hermes: AgentDetail | null;
  openclaw: AgentDetail | null;
  checked: boolean;
  onOpenAgent: (agentId: string) => void;
}) {
  const rows: { key: string; agentId: string; ok: boolean | null; label: string }[] = [];
  const unknownSuffix = checked ? "couldn't be read right now" : "checking…";

  if (hermes) {
    const approvalsOn = !hermes.safety.permissive;
    rows.push({
      key: "hermes-approvals",
      agentId: "hermes",
      ok: approvalsOn,
      label: `Hermes approvals required before running commands: ${approvalsOn ? "on" : "off"}`
    });
  } else {
    rows.push({ key: "hermes-approvals", agentId: "hermes", ok: null, label: `Hermes approvals: ${unknownSuffix}` });
  }

  if (openclaw) {
    const asksBeforeRunning = !hasAction(openclaw, "exec-ask");
    const cookieImportOn = hasAction(openclaw, "no-browser-cookies");
    rows.push({
      key: "openclaw-exec",
      agentId: "openclaw",
      ok: asksBeforeRunning,
      label: `OpenClaw asks before running commands: ${asksBeforeRunning ? "on" : "off"}`
    });
    rows.push({
      key: "openclaw-cookies",
      agentId: "openclaw",
      ok: !cookieImportOn,
      label: `OpenClaw browser cookie import: ${cookieImportOn ? "on" : "off"}`
    });
  } else {
    rows.push({ key: "openclaw-exec", agentId: "openclaw", ok: null, label: `OpenClaw safeguards: ${unknownSuffix}` });
  }

  return (
    <div className="os-panel os-safety-guards">
      <header>
        <span className="os-micro">AGENT SAFEGUARDS</span>
      </header>
      <ul>
        {rows.map((row) => (
          <li key={row.key} className="os-safety-guards__row">
            <StatusMark kind={row.ok === null ? "unknown" : row.ok ? "ok" : "warn"} />
            <span>{row.label}</span>
            <button type="button" className="os-btn os-btn--ghost" onClick={() => onOpenAgent(row.agentId)}>
              Change on the Agents page
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
