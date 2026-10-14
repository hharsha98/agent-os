// One agent's row on the Plan step. Everything on it comes off the plan the
// server computed (GET /api/setup/plan): what is installed, what an install or an
// update would do, the licence and the source links. Nothing is invented here, so
// an installed agent with no update step (Hermes today, Task B1) simply cannot be
// updated, and the row says so.
import type { ReactNode } from "react";
import { ExternalLink, Lock } from "lucide-react";
import OpenAddress from "./OpenAddress";
import SetupSegmented from "./SetupSegmented";
import SetupStatus from "./SetupStatus";
import { formatMinutes, formatSize, totalsOf, type PlanSelection } from "../setupGroupShared";
import type { SetupPlanStep } from "../../setupApi";

export interface OpenClawConsent {
  accepted: boolean;
  onToggle: (next: boolean) => void;
}

function Links({ license, sourceUrl, termsUrl }: { license?: string; sourceUrl?: string; termsUrl?: string | null }) {
  if (!license && !sourceUrl && !termsUrl) return null;
  return (
    <span className="os-setup-links">
      {license ? <span>Licence: {license}</span> : null}
      {termsUrl ? (
        <OpenAddress href={termsUrl} copyLabel="Copy the terms address">
          Terms <ExternalLink size={12} aria-hidden="true" />
        </OpenAddress>
      ) : null}
      {sourceUrl ? (
        <OpenAddress href={sourceUrl} copyLabel="Copy the official source address">
          Official source <ExternalLink size={12} aria-hidden="true" />
        </OpenAddress>
      ) : null}
    </span>
  );
}

export default function SetupPlanRow({
  label,
  license,
  keepStep,
  updateStep,
  installSteps,
  unsupportedStep,
  selection,
  onSelect,
  disabled = false,
  canSkip,
  consent,
  hasBlockedReason = false
}: {
  label: string;
  license?: string;
  keepStep?: SetupPlanStep;
  updateStep?: SetupPlanStep;
  installSteps: SetupPlanStep[];
  unsupportedStep?: SetupPlanStep;
  selection: PlanSelection;
  onSelect: (next: PlanSelection) => void;
  disabled?: boolean;
  // Coding agents can be switched to Skip. An always-on agent that is not
  // installed is simply installed (leave the group with "Skip installing, continue").
  canSkip: boolean;
  // Only on the OpenClaw row.
  consent?: OpenClawConsent;
  // The plan names a reason for this agent (plan.blocked). The page draws it above the groups, so the row may point there.
  hasBlockedReason?: boolean;
}) {
  const installStep = installSteps.find((s) => s.action === "install");
  const nodeStep = installSteps.find((s) => s.action === "prereq-node");
  // The step that carries the agent's own links (the Node step points at nodejs.org).
  const linkStep = unsupportedStep || keepStep || installStep || nodeStep;
  const passwordMoments = installSteps.flatMap((s) => s.passwordMoments || []);

  let control: ReactNode;
  let sub: ReactNode;
  let what: ReactNode;
  const installing = !keepStep && !unsupportedStep && installSteps.length > 0 && selection === "install";

  if (unsupportedStep) {
    control = <SetupStatus tone="unknown">Not supported here</SetupStatus>;
    sub = "—";
    what = (
      <>
        {unsupportedStep.description} Nothing will be installed for {label}.
      </>
    );
  } else if (keepStep) {
    const chosen = selection === "update" ? "update" : "keep";
    control = (
      <SetupSegmented
        label={`${label}: keep or update`}
        value={chosen}
        options={[
          { value: "keep", label: "Keep" },
          { value: "update", label: "Update", disabled: !updateStep }
        ]}
        onChange={(next) => onSelect(next === "update" ? "update" : "keep")}
        disabled={disabled}
      />
    );
    sub = <span className="os-mono">{keepStep.installedVersion || "—"}</span>;
    if (!updateStep) {
      what = (
        <span className="os-setup-lock">
          <Lock size={15} aria-hidden="true" />
          Agent OS does not update this agent yet. It stays as it is.
        </span>
      );
    } else if (chosen === "update") {
      what = `Runs ${label}'s own updater. It replaces the agent's program files. Your settings stay.`;
    } else {
      what = "Stays as it is.";
    }
  } else if (installSteps.length === 0) {
    // Not installed and the plan has no step for it (for example its install site cannot be reached).
    control = <SetupStatus tone="warn">Can't install now</SetupStatus>;
    sub = "Not installed";
    // Only point at a reason that is on screen: plan.blocked is what the page draws above the groups.
    what = hasBlockedReason
      ? "Setup can't install this one right now. The reason is shown above the groups."
      : "Setup has no install step for this one right now.";
  } else {
    const own = totalsOf(installSteps);
    control = canSkip ? (
      <SetupSegmented
        label={`${label}: install or skip`}
        value={selection === "install" ? "install" : "skip"}
        options={[
          { value: "install", label: "Install" },
          { value: "skip", label: "Skip" }
        ]}
        onChange={(next) => onSelect(next === "install" ? "install" : "skip")}
        disabled={disabled}
      />
    ) : (
      <span className="os-setup-fixed">Will be installed</span>
    );
    sub = (
      <>
        Not installed
        {own.complete ? (
          <span className="os-mono">
            {" "}
            · ~{formatSize(own.mb)} · {formatMinutes(own.minutes)}
          </span>
        ) : null}
      </>
    );
    what =
      selection === "skip" ? (
        `Skipped. Nothing will be installed for ${label}.`
      ) : (
        <>
          {installStep?.summary || installStep?.description}
          {nodeStep ? (
            <span className="os-setup-needs">
              <b>Needs Node first.</b> {nodeStep.description}
            </span>
          ) : null}
        </>
      );
  }

  const showNote = installing && passwordMoments.length > 0;
  const showConsent = installing && Boolean(consent);

  return (
    <div className="os-table__row os-setup-row" role="row">
      <div className="os-table__cell" role="rowheader">
        <span className="os-setup-table__name">{label}</span>
        <span className="os-setup-table__sub">{sub}</span>
      </div>
      <div className="os-table__cell" role="cell">
        {control}
      </div>
      <div className="os-table__cell os-setup-table__detail" role="cell">
        <div>{what}</div>
        <Links license={license || linkStep?.license} sourceUrl={linkStep?.sourceUrl} termsUrl={linkStep?.termsUrl} />
      </div>
      {showNote || showConsent ? (
        <div className="os-setup-row__extra" role="cell">
          {showNote ? (
            <div className="os-setup-row__note" role="note">
              <Lock size={15} aria-hidden="true" />
              <div>
                {passwordMoments.map((moment, i) => (
                  <p key={i}>{moment}</p>
                ))}
              </div>
            </div>
          ) : null}
          {showConsent && consent ? (
            <label className="os-setup-row__consent">
              <input type="checkbox" checked={consent.accepted} disabled={disabled} onChange={(e) => consent.onToggle(e.target.checked)} />
              <span>I understand OpenClaw can act on this computer. Agent OS will switch it to ask before running commands.</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
