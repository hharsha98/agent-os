// The rows inside the "Coding agents" group: one per agent with a checkbox,
// what state it is in right now, one plain line on what installing it changes,
// and its size and time. Above them: the total for whatever is ticked and the
// "already installed is kept" promise. Every figure comes off the plan the
// server computed (GET /api/setup/plan?group=coding); nothing is invented here.
import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import StatusMark from "./StatusMark";
import type { PlanSelection } from "./SetupPlanCard";
import type { SetupPlanStep } from "../../setupApi";
import { formatMinutes, formatSize, totalsOf } from "../setupGroupShared";

export interface CodingRow {
  agentId: string;
  label: string;
  keepStep?: SetupPlanStep;
  updateStep?: SetupPlanStep;
  installSteps: SetupPlanStep[];
}

function RowDetails({ row, installed }: { row: CodingRow; installed: boolean }) {
  const [open, setOpen] = useState(false);
  const installStep = row.installSteps.find((s) => s.action === "install");
  const step = installStep || row.keepStep;
  const changes = row.installSteps.flatMap((s) => s.changes || []);
  const commands = row.installSteps.map((s) => s.commandPreview).filter(Boolean) as string[];
  return (
    <div className="os-setup-agent__details">
      <button type="button" className="os-btn os-btn--ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : undefined }} /> Details
      </button>
      {open ? (
        <div className="os-setup-agent__more">
          {!installed && changes.length ? (
            <>
              <span className="os-micro">What this changes on your computer</span>
              <ul>
                {changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          ) : null}
          {!installed && commands.length ? <pre className="os-mono os-setup-plan-card__commands">{commands.join("\n")}</pre> : null}
          <p className="os-setup-agent__links">
            {step?.license ? <span>Licence: {step.license}</span> : null}
            {step?.termsUrl ? (
              <a href={step.termsUrl} target="_blank" rel="noreferrer">
                Terms <ExternalLink size={12} />
              </a>
            ) : null}
            {step?.sourceUrl ? (
              <a href={step.sourceUrl} target="_blank" rel="noreferrer">
                Official source <ExternalLink size={12} />
              </a>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function SetupCodingRows({
  rows,
  selections,
  onSelect,
  disabled,
  selectedSteps
}: {
  rows: CodingRow[];
  selections: Record<string, PlanSelection>;
  onSelect: (agentId: string, next: PlanSelection) => void;
  disabled?: boolean;
  // The steps that would run for what is ticked, to add up size and time.
  selectedSteps: SetupPlanStep[];
}) {
  const downloads = selectedSteps.filter((s) => s.action === "install" || s.action === "prereq-node");
  const updates = selectedSteps.filter((s) => s.action === "update");
  const totals = totalsOf(downloads);

  return (
    <>
      <p className="os-setup-group__total" role="status">
        {downloads.length ? (
          <>
            <strong>
              About {formatSize(totals.mb)} to download and store · roughly {formatMinutes(totals.minutes)}
            </strong>
            <span> (depends on your internet connection){updates.length ? "; updates are extra" : ""}</span>
          </>
        ) : updates.length ? (
          <strong>Updates only. Their size varies.</strong>
        ) : (
          <strong>Nothing ticked, so nothing will change.</strong>
        )}
      </p>
      <p className="os-setup-group__keep">
        Anything already installed is <strong>kept as it is</strong>. Agent OS never installs over it; tick “Update” on a row
        if you want the newest version.
      </p>

      <ul className="os-setup-agents">
        {rows.map((row) => {
          const installed = Boolean(row.keepStep);
          const selection = selections[row.agentId];
          const checked = installed ? selection === "update" : selection === "install";
          const nodeStep = row.installSteps.find((s) => s.action === "prereq-node");
          const installStep = row.installSteps.find((s) => s.action === "install");
          const own = totalsOf(row.installSteps);
          return (
            <li key={row.agentId} className={`os-setup-agent${checked ? " os-setup-agent--on" : ""}`}>
              <div className="os-setup-agent__main">
                <label className="os-setup-agent__check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (installed && !row.updateStep)}
                    onChange={(e) =>
                      onSelect(row.agentId, installed ? (e.target.checked ? "update" : "keep") : e.target.checked ? "install" : "skip")
                    }
                  />
                  <span>
                    {installed ? "Update " : "Install "}
                    <strong>{row.label}</strong>
                  </span>
                </label>
                {!installed && own.complete ? (
                  <span className="os-setup-agent__size os-mono">
                    ~{formatSize(own.mb)} · {formatMinutes(own.minutes)}
                  </span>
                ) : null}
              </div>
              <p className="os-setup-agent__state">
                <StatusMark kind={installed ? "ok" : "unknown"} />
                {installed
                  ? `Installed${row.keepStep?.installedVersion ? ` ${row.keepStep.installedVersion}` : ""} · ${
                      selection === "update" ? "will be updated" : "kept as it is"
                    }`
                  : nodeStep
                    ? "Not installed · downloads Node 24 first, then installs"
                    : "Not installed"}
              </p>
              {!installed && installStep?.summary ? <p className="os-setup-agent__line">{installStep.summary}</p> : null}
              <RowDetails row={row} installed={installed} />
            </li>
          );
        })}
      </ul>
    </>
  );
}
