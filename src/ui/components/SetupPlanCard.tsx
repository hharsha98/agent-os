// One agent's plan card for the "Plan" step: what will happen (keep /
// update / install / not supported), the official source + licence, what it
// changes on this computer, password/system-dialog moments, and (for
// OpenClaw) the required risk checkbox. Every fact here comes straight off
// a GET /api/setup/plan step -- nothing is invented client-side. The plan
// carries no download size or time estimate, so none is shown (the only
// timing is the plan's own "about 5 minutes" in a system-dialog notice).
import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import StatusMark from "./StatusMark";
import type { SetupPlanStep } from "../../setupApi";

export type PlanSelection = "keep" | "update" | "install" | "unsupported";

export default function SetupPlanCard({
  label,
  license,
  keepStep,
  updateStep,
  installSteps,
  unsupportedStep,
  selection,
  onSelect,
  disabled,
  openClawRiskLabel,
  openClawRiskAccepted,
  onToggleOpenClawRisk
}: {
  label: string;
  license?: string;
  keepStep?: SetupPlanStep;
  updateStep?: SetupPlanStep;
  installSteps?: SetupPlanStep[];
  unsupportedStep?: SetupPlanStep;
  selection: PlanSelection;
  onSelect: (next: PlanSelection) => void;
  disabled?: boolean;
  openClawRiskLabel?: string;
  openClawRiskAccepted?: boolean;
  onToggleOpenClawRisk?: (next: boolean) => void;
}) {
  const [showCommands, setShowCommands] = useState(false);

  if (unsupportedStep) {
    return (
      <div className="os-panel os-setup-plan-card">
        <header className="os-setup-plan-card__head">
          <strong>{label}</strong>
          <span className="os-setup-plan-card__state">
            <StatusMark kind="unknown" />
            Not supported here
          </span>
        </header>
        <p className="os-setup-plan-card__desc">{unsupportedStep.description}</p>
        <p className="os-setup-plan-card__desc">Nothing will be installed for {label}.</p>
        {unsupportedStep.sourceUrl ? (
          <a className="os-setup-plan-card__source" href={unsupportedStep.sourceUrl} target="_blank" rel="noreferrer">
            Official source <ExternalLink size={12} />
          </a>
        ) : null}
      </div>
    );
  }

  const allInstallSteps = installSteps || [];
  const installStep = allInstallSteps.find((s) => s.action === "install");
  const nodeStep = allInstallSteps.find((s) => s.action === "prereq-node");
  // The plan's own official source for whatever this card is about to do.
  const primaryStep = selection === "update" ? updateStep : selection === "install" ? installStep || nodeStep : keepStep;
  const passwordMoments = allInstallSteps.flatMap((s) => s.passwordMoments || []);
  const changes = selection === "install" ? allInstallSteps.flatMap((s) => s.changes || []) : primaryStep?.changes || [];
  const commandPreviews = (
    selection === "install"
      ? allInstallSteps.map((s) => s.commandPreview)
      : selection === "update"
        ? [updateStep?.commandPreview]
        : []
  ).filter(Boolean) as string[];
  const sourceUrl = primaryStep?.sourceUrl || keepStep?.sourceUrl || installStep?.sourceUrl;
  const isInstalled = Boolean(keepStep);

  return (
    <div className="os-panel os-setup-plan-card">
      <header className="os-setup-plan-card__head">
        <strong>{label}</strong>
        {sourceUrl ? (
          <a className="os-setup-plan-card__source" href={sourceUrl} target="_blank" rel="noreferrer">
            Official source <ExternalLink size={12} />
          </a>
        ) : null}
      </header>
      <p className="os-setup-plan-card__state">
        <StatusMark kind={isInstalled ? "ok" : "unknown"} />
        {isInstalled
          ? selection === "update"
            ? "Already installed · will be updated"
            : "Already installed · will be kept as is"
          : nodeStep
            ? "Not installed · needs Node first, then the install"
            : "Not installed · will be installed"}
      </p>
      {license ? <p className="os-setup-plan-card__meta">Licence: {license}</p> : null}

      {keepStep ? (
        <div className="os-setup-plan-card__choices" role="radiogroup" aria-label={`${label} action`}>
          <label className="os-setup-plan-card__choice">
            <input
              type="radio"
              name={`${label}-action`}
              checked={selection === "keep"}
              disabled={disabled}
              onChange={() => onSelect("keep")}
            />
            Keep it (recommended)
          </label>
          {updateStep ? (
            <label className="os-setup-plan-card__choice">
              <input
                type="radio"
                name={`${label}-action`}
                checked={selection === "update"}
                disabled={disabled}
                onChange={() => onSelect("update")}
              />
              Update
            </label>
          ) : null}
        </div>
      ) : null}

      {selection === "update" ? (
        <p className="os-setup-plan-card__warning" role="status">
          Updating replaces the agent's program files. Your settings stay.
        </p>
      ) : null}

      {!keepStep && installStep ? <p className="os-setup-plan-card__desc">{installStep.description}</p> : null}
      {!keepStep && nodeStep ? (
        <p className="os-setup-plan-card__desc">
          <strong>Needs Node first.</strong> {nodeStep.description}
        </p>
      ) : null}

      {changes.length ? (
        <div className="os-setup-plan-card__changes">
          <span className="os-micro">What this changes on your computer</span>
          <ul>
            {changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {commandPreviews.length ? (
        <div className="os-setup-plan-card__disclosure">
          <button type="button" className="os-btn os-btn--ghost" onClick={() => setShowCommands((v) => !v)} aria-expanded={showCommands}>
            <ChevronDown size={14} style={{ transform: showCommands ? "rotate(180deg)" : undefined }} /> Show exact commands
          </button>
          {showCommands ? <pre className="os-mono os-setup-plan-card__commands">{commandPreviews.join("\n")}</pre> : null}
        </div>
      ) : null}

      {selection === "install" && passwordMoments.length ? (
        <div className="os-setup-plan-card__password-callout" role="note">
          {passwordMoments.map((m, i) => (
            <p key={i}>{m}</p>
          ))}
        </div>
      ) : null}

      {selection === "install" && onToggleOpenClawRisk ? (
        <label className="os-setup-plan-card__risk">
          <input
            type="checkbox"
            checked={Boolean(openClawRiskAccepted)}
            disabled={disabled}
            onChange={(e) => onToggleOpenClawRisk(e.target.checked)}
          />
          {openClawRiskLabel ||
            "I understand OpenClaw can act on this computer. Agent OS will switch it to ask before running commands."}
        </label>
      ) : null}
    </div>
  );
}
