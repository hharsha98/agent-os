// The Setup Assistant: a 5-step "pre-flight" stepper (Check -> Plan ->
// Install -> AI brain -> Ready) for a non-expert setting up Hermes/OpenClaw.
// One decision per screen; nothing installs or configures without an
// explicit confirm. All data comes from server/runtime/setup/* via
// ../setupApi -- see that file for the exact response shapes.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { listAgents } from "../api";
import { navigateTo } from "../nav";
import type { AgentSummary } from "../types";
import Panel from "../ui/components/Panel";
import SetupBrainPanel, { type BrainAgentLine, type BrainPanelStatus } from "../ui/components/SetupBrainPanel";
import SetupCheckList from "../ui/components/SetupCheckList";
import SetupInstallPanel from "../ui/components/SetupInstallPanel";
import SetupModal from "../ui/components/SetupModal";
import SetupPlanCard, { type PlanSelection } from "../ui/components/SetupPlanCard";
import SetupReadyPanel from "../ui/components/SetupReadyPanel";
import SetupStepper, { type SetupStepDef, type SetupStepState } from "../ui/components/SetupStepper";
import { useInterval } from "../ui/components/useInterval";
import type { BrainOptionsResponse, SetupJob, SetupPlan, SystemCheck } from "../setupApi";
import {
  cancelSetupJob,
  friendlyError,
  getBrainOptions,
  getSetupCheck,
  getSetupJob,
  getSetupPlan,
  recallJobId,
  rememberJobId,
  retrySetupJob,
  startInstallJob
} from "../setupApi";
import { BRAIN_AGENT_LABEL } from "../ui/brainShared";
import "../ui/setup.css";

const STEP_LABELS = ["Check", "Plan", "Install", "AI brain", "Ready"];
const AGENT_LABEL: Record<string, string> = { hermes: "Hermes Agent", openclaw: "OpenClaw" };
const AGENT_IDS = ["hermes", "openclaw"] as const;

// What each agent should do by default: never an update, never a reinstall.
function defaultSelections(plan: SetupPlan) {
  const defaults: Record<string, PlanSelection> = {};
  for (const agentId of AGENT_IDS) {
    const steps = plan.steps.filter((s) => s.agentId === agentId);
    if (steps.some((s) => s.action === "skip-unsupported")) defaults[agentId] = "unsupported";
    else if (steps.some((s) => s.action === "keep")) defaults[agentId] = "keep";
    else defaults[agentId] = "install";
  }
  return defaults;
}

function installStepLabel(agentId: string | null, action: string) {
  const name = (agentId && AGENT_LABEL[agentId]) || "the agent";
  if (action === "install") return `Install ${name}`;
  if (action === "update") return `Update ${name}`;
  if (action === "prereq-node") return `Set up a Node 24 runtime for ${name}`;
  if (action === "keep") return `Keep ${name} as it is`;
  return `Skip ${name} (not supported here)`;
}

function brainReady(check: SystemCheck | null, brain: BrainOptionsResponse | null) {
  const hermesOk = !check?.agents?.hermes.detected.installed || Boolean(brain?.current.hermes.configured);
  const openclawOk = !check?.agents?.openclaw.detected.installed || Boolean(brain?.current.openclaw.configured);
  return hermesOk && openclawOk;
}

export default function SetupPage() {
  const [check, setCheck] = useState<SystemCheck | null>(null);
  const [checkError, setCheckError] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [planError, setPlanError] = useState(false);
  const [brain, setBrain] = useState<BrainOptionsResponse | null>(null);
  const [agentsMeta, setAgentsMeta] = useState<AgentSummary[] | null>(null);

  const [stepIndex, setStepIndex] = useState(0);
  const initializedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusOnStepChange = useRef(false);
  const [actionError, setActionError] = useState("");

  const [selections, setSelections] = useState<Record<string, PlanSelection>>({});
  const [openClawRiskAccepted, setOpenClawRiskAccepted] = useState(false);
  const [showInstallConfirm, setShowInstallConfirm] = useState(false);
  const [installConfirmError, setInstallConfirmError] = useState("");
  const [installJob, setInstallJob] = useState<SetupJob | null>(null);
  const [installBusy, setInstallBusy] = useState(false);

  // What the AI brain panel is doing (it runs its own configure job and
  // result screen); only used to colour the step rail.
  const [brainStatus, setBrainStatus] = useState<BrainPanelStatus>("idle");

  // A job that is still running (or just failed) on the server survives a
  // reload or a trip to another page: re-attach to it instead of showing an
  // empty Install step. Returns the step to land on, or null. (A running
  // configure job is picked up again by the AI brain panel itself.)
  async function restoreJobs(): Promise<number | null> {
    const configureId = recallJobId("configure");
    if (configureId) {
      const job = await getSetupJob(configureId).catch(() => null);
      if (job && job.status === "running") return 3;
      rememberJobId("configure", null);
    }
    const installId = recallJobId("install");
    if (installId) {
      const job = await getSetupJob(installId).catch(() => null);
      if (job && (job.status === "running" || job.status === "failed")) {
        setInstallJob(job);
        return 2;
      }
      rememberJobId("install", null);
    }
    return null;
  }

  async function loadAll(refresh = false) {
    setCheckError(false);
    setPlanError(false);
    let checkRes: SystemCheck;
    try {
      checkRes = await getSetupCheck(refresh);
      setCheck(checkRes);
    } catch {
      setCheckError(true);
      return;
    }
    try {
      const [planRes, brainRes, agentsRes] = await Promise.all([
        getSetupPlan(),
        getBrainOptions(refresh),
        listAgents().catch(() => null)
      ]);
      setPlan(planRes);
      setBrain(brainRes);
      setAgentsMeta(agentsRes ? agentsRes.agents : null);
      setSelections(defaultSelections(planRes));

      if (!initializedRef.current) {
        initializedRef.current = true;
        const restored = await restoreJobs();
        if (restored !== null) {
          setStepIndex(restored);
          return;
        }
        const anyInstalled = AGENT_IDS.some((id) => checkRes.agents?.[id]?.detected.installed);
        const needsAction = planRes.steps.some((s) => s.action === "install" || s.action === "prereq-node");
        // A brand-new computer starts at Check; a half-set-up one at Plan;
        // everything installed lands on AI brain, or Ready once configured.
        if (!anyInstalled) setStepIndex(0);
        else if (needsAction) setStepIndex(1);
        else setStepIndex(brainReady(checkRes, brainRes) ? 4 : 3);
      }
    } catch {
      setPlanError(true);
    }
  }

  // After a job finishes, what the page knew before (installed? configured?)
  // is stale; re-read it from the server so the next step is truthful.
  async function refreshServerState(includePlan: boolean) {
    try {
      const [checkRes, brainRes, planRes] = await Promise.all([
        getSetupCheck(true),
        getBrainOptions(true),
        includePlan ? getSetupPlan() : Promise.resolve(null)
      ]);
      setCheck(checkRes);
      setBrain(brainRes);
      if (planRes) {
        setPlan(planRes);
        setSelections(defaultSelections(planRes));
      }
    } catch {
      // The Ready step re-checks on its own; nothing to show here.
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installStatus = installJob?.status;
  useEffect(() => {
    if (installStatus === "succeeded") void refreshServerState(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installStatus]);

  // Moving to a new step unmounts the button that was just pressed, which
  // would drop keyboard focus on <body>; put it on the new step's content.
  useEffect(() => {
    if (!focusOnStepChange.current) return;
    focusOnStepChange.current = false;
    contentRef.current?.focus({ preventScroll: true });
  }, [stepIndex]);

  // Every step change a person causes goes through here; the first landing
  // (derived from the server) does not, so the page doesn't grab focus on load.
  function goToStep(index: number) {
    focusOnStepChange.current = true;
    setStepIndex(index);
  }

  // ---- job polling ----------------------------------------------------------
  useInterval(
    async () => {
      if (!installJob) return;
      try {
        setInstallJob(await getSetupJob(installJob.id));
      } catch {
        // transient poll failure; next tick tries again
      }
    },
    installJob && installJob.status === "running" ? 1000 : null
  );

  function stepState(index: number): SetupStepState {
    if (index === 2 && installJob?.status === "failed") return "failed";
    if (index === 3 && brainStatus === "failed") return "failed";
    if (index < stepIndex) return "done";
    if (index === stepIndex) return "current";
    return "not-reached";
  }

  const steps: SetupStepDef[] = STEP_LABELS.map((label, i) => ({ key: label, label, state: stepState(i) }));

  function agentMeta(agentId: string) {
    return agentsMeta?.find((a) => a.id === agentId);
  }

  function stepsFor(agentId: string) {
    const all = plan?.steps.filter((s) => s.agentId === agentId) || [];
    return {
      keepStep: all.find((s) => s.action === "keep"),
      updateStep: all.find((s) => s.action === "update"),
      installSteps: all.filter((s) => s.action === "install" || s.action === "prereq-node"),
      unsupportedStep: all.find((s) => s.action === "skip-unsupported")
    };
  }

  function selectedStepIds(): string[] {
    if (!plan) return [];
    const ids: string[] = [];
    for (const agentId of AGENT_IDS) {
      const sel = selections[agentId];
      const { keepStep, updateStep, installSteps, unsupportedStep } = stepsFor(agentId);
      if (sel === "keep" && keepStep) ids.push(keepStep.id);
      else if (sel === "update" && updateStep) ids.push(updateStep.id);
      else if (sel === "install") ids.push(...installSteps.map((s) => s.id));
      else if (sel === "unsupported" && unsupportedStep) ids.push(unsupportedStep.id);
    }
    return ids;
  }

  const needsOpenClawConsentInstall = selections.openclaw === "install";
  const jobNeeded = selectedStepIds().some((id) => {
    const s = plan?.steps.find((p) => p.id === id);
    return s && (s.action === "install" || s.action === "update" || s.action === "prereq-node");
  });
  const planBlocked = jobNeeded && needsOpenClawConsentInstall && !openClawRiskAccepted;

  function onPlanPrimary() {
    if (!jobNeeded) {
      goToStep(brainReady(check, brain) ? 4 : 3);
      return;
    }
    setInstallConfirmError("");
    setShowInstallConfirm(true);
  }

  async function confirmInstall() {
    setInstallBusy(true);
    setInstallConfirmError("");
    try {
      const job = await startInstallJob({
        steps: selectedStepIds(),
        acceptOpenClawRisk: needsOpenClawConsentInstall && openClawRiskAccepted
      });
      rememberJobId("install", job.id);
      setInstallJob(job);
      setShowInstallConfirm(false);
      goToStep(2);
    } catch (error) {
      // Keep the dialog open so the reason is readable next to the button.
      setInstallConfirmError(friendlyError(error));
    } finally {
      setInstallBusy(false);
    }
  }

  async function onCancelInstall() {
    if (!installJob) return;
    try {
      setInstallJob(await cancelSetupJob(installJob.id));
    } catch (error) {
      setActionError(friendlyError(error));
    }
  }

  async function onRetryInstall() {
    if (!installJob) return;
    setInstallBusy(true);
    setActionError("");
    try {
      setInstallJob(await retrySetupJob(installJob.id));
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setInstallBusy(false);
    }
  }

  const brainAgents: BrainAgentLine[] = AGENT_IDS.map((id) => ({
    id,
    label: BRAIN_AGENT_LABEL[id],
    installed: Boolean(check?.agents?.[id]?.detected.installed),
    configured: Boolean(brain?.current[id].configured)
  }));

  // Labels come from the job's own steps (agent + action), so they stay
  // readable after a reload even though the plan has changed since.
  const planStepLabels: Record<string, string> = Object.fromEntries([
    ...(plan?.steps || []).map((s) => [s.id, s.title] as const),
    ...(installJob?.steps || []).map((s) => [s.id, installStepLabel(s.agentId, s.action)] as const)
  ]);
  const planCommandPreviews: Record<string, string | null> = Object.fromEntries(
    (plan?.steps || []).map((s) => [s.id, s.commandPreview])
  );

  async function onRecheck() {
    setRechecking(true);
    try {
      await loadAll(true);
    } finally {
      setRechecking(false);
    }
  }

  return (
    <div className={`os-setup aos-phase-page${stepIndex === 3 ? " os-setup--wide" : ""}`}>
      <header className="os-setup__header">
        <span className="os-micro">AGENT OS · SETUP ASSISTANT</span>
        <h1>Setup</h1>
      </header>

      <SetupStepper steps={steps} onSelect={goToStep} />

      {actionError ? (
        <div className="os-setup__alert" role="alert">
          <AlertTriangle size={16} />
          <span>{actionError}</span>
          <button type="button" className="os-btn os-btn--ghost" onClick={() => setActionError("")} aria-label="Dismiss this message">
            <X size={14} />
          </button>
        </div>
      ) : null}

      <div className="os-setup__content" ref={contentRef} tabIndex={-1}>
        {stepIndex === 0 ? (
          <Panel className="os-setup__panel">
            <div className="os-setup__step-head">
              <h2>Check your computer</h2>
              <p>We look at what is already installed. Nothing on your computer is changed.</p>
            </div>
            {checkError ? (
              <div className="os-fleet__banner">
                <AlertTriangle size={16} />
                <span>Couldn't check this computer.</span>
                <button className="os-btn os-btn--secondary" onClick={() => void loadAll()}>
                  <RefreshCw size={14} /> Retry
                </button>
              </div>
            ) : !check ? (
              <p className="os-setup__loading">Checking your computer…</p>
            ) : (
              <>
                <SetupCheckList check={check} />
                <div className="os-setup__actions">
                  <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(1)}>
                    Continue
                  </button>
                  <button type="button" className="os-btn os-btn--secondary" onClick={() => void onRecheck()} disabled={rechecking}>
                    <RefreshCw size={14} /> {rechecking ? "Checking…" : "Run the check again"}
                  </button>
                </div>
              </>
            )}
          </Panel>
        ) : null}

        {stepIndex === 1 ? (
          <div className="os-setup__panel">
            <div className="os-setup__step-head">
              <h2>Here's the plan</h2>
              <p>Choose what to do for each agent. Nothing happens until you press the button at the bottom.</p>
            </div>
            {planError || !plan ? (
              <div className="os-fleet__banner">
                <AlertTriangle size={16} />
                <span>{planError ? "Couldn't load the setup plan." : "Loading the setup plan…"}</span>
                {planError ? (
                  <button className="os-btn os-btn--secondary" onClick={() => void loadAll()}>
                    <RefreshCw size={14} /> Retry
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                <div className="os-setup-plan__cards">
                  {AGENT_IDS.map((agentId) => {
                    const { keepStep, updateStep, installSteps, unsupportedStep } = stepsFor(agentId);
                    return (
                      <SetupPlanCard
                        key={agentId}
                        label={agentMeta(agentId)?.label || AGENT_LABEL[agentId]}
                        license={agentMeta(agentId)?.license}
                        keepStep={keepStep}
                        updateStep={updateStep}
                        installSteps={installSteps}
                        unsupportedStep={unsupportedStep}
                        selection={selections[agentId] || "keep"}
                        onSelect={(next) => setSelections((prev) => ({ ...prev, [agentId]: next }))}
                        disabled={installBusy}
                        openClawRiskAccepted={agentId === "openclaw" ? openClawRiskAccepted : undefined}
                        onToggleOpenClawRisk={agentId === "openclaw" && needsOpenClawConsentInstall ? setOpenClawRiskAccepted : undefined}
                      />
                    );
                  })}
                </div>
                {plan.blocked.length ? (
                  <div className="os-setup__alert" role="alert">
                    <AlertTriangle size={16} />
                    <span>{plan.blocked.map((b) => `${AGENT_LABEL[b.agentId] || b.agentId}: ${b.reason}`).join(" ")}</span>
                  </div>
                ) : null}
                {plan.manualSteps.length ? (
                  <div className="os-setup-plan-card__password-callout" role="note">
                    {plan.manualSteps.map((m, i) => (
                      <p key={i}>
                        {m.reason} Run this in a terminal first: <span className="os-mono">{m.command}</span>
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="os-setup__actions">
                  <button type="button" className="os-btn os-btn--primary" onClick={onPlanPrimary} disabled={planBlocked}>
                    {jobNeeded ? "Set up everything" : "Continue"}
                  </button>
                  {planBlocked ? <span className="os-setup__hint">Tick the OpenClaw box above to continue.</span> : null}
                </div>
              </>
            )}
          </div>
        ) : null}

        {stepIndex === 2 ? (
          <div className="os-setup__panel">
            {installJob ? (
              <>
                <SetupInstallPanel
                  title="Installing your agents"
                  job={installJob}
                  stepLabels={planStepLabels}
                  commandPreviews={planCommandPreviews}
                  onCancel={onCancelInstall}
                  onRetry={onRetryInstall}
                  busy={installBusy}
                />
                {installJob.status === "succeeded" ? (
                  <div className="os-setup__actions">
                    <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(3)}>
                      Continue
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <Panel className="os-setup__panel">
                <div className="os-setup__step-head">
                  <h2>Nothing to install</h2>
                  <p>No install is running right now. If your agents were already on this computer, you can move on.</p>
                </div>
                <div className="os-setup__actions">
                  <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(3)}>
                    Continue
                  </button>
                </div>
              </Panel>
            )}
          </div>
        ) : null}

        {stepIndex === 3 ? (
          <div className="os-setup__panel">
            {brain ? (
              <>
                <div className="os-setup__step-head">
                  <h2>Choose your AI brain</h2>
                  <p>Agents need a language model to think with. Pick where it comes from. Each agent can use a different one.</p>
                </div>
                <SetupBrainPanel
                  brain={brain}
                  agents={brainAgents}
                  onChanged={() => void refreshServerState(false)}
                  onStatus={setBrainStatus}
                  onContinue={() => goToStep(4)}
                />
              </>
            ) : (
              <p className="os-setup__loading">Loading model provider options…</p>
            )}
          </div>
        ) : null}

        {stepIndex === 4 ? (
          <SetupReadyPanel
            onGoHome={() => navigateTo("fleet")}
            onOpenSafety={() => navigateTo("safety")}
            onGoToStep={goToStep}
            onOpenAgent={(agentId) => navigateTo("agents", { agent: agentId })}
          />
        ) : null}
      </div>

      {showInstallConfirm ? (
        <SetupModal
          title="Set up everything?"
          confirmLabel="Set up everything"
          onConfirm={confirmInstall}
          onClose={() => setShowInstallConfirm(false)}
          busy={installBusy}
          error={installConfirmError}
        >
          <p>This will run:</p>
          <ul>
            {selectedStepIds().map((id) => (
              <li key={id}>{planStepLabels[id] || id}</li>
            ))}
          </ul>
        </SetupModal>
      ) : null}

    </div>
  );
}
