// The Setup Assistant: a 6-step "pre-flight" stepper (Check -> Plan -> Install
// -> AI brain -> Sign in -> Ready) for a non-expert setting up Hermes/OpenClaw
// (the "operators") and Claude Code/Codex/Cursor (the "coding agents"). One
// decision per screen; nothing installs or configures without an explicit
// confirm. All data comes from server/runtime/setup/* via ../setupApi -- see
// that file for the exact response shapes.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { listAgents } from "../api";
import { navigateTo, queryParam } from "../nav";
import type { AgentSummary } from "../types";
import Panel from "../ui/components/Panel";
import SetupBrainPanel, { type BrainAgentLine, type BrainPanelStatus } from "../ui/components/SetupBrainPanel";
import SetupCheckList from "../ui/components/SetupCheckList";
import SetupCodingRows from "../ui/components/SetupCodingRows";
import SetupGroupPanel from "../ui/components/SetupGroupPanel";
import SetupInstallPanel from "../ui/components/SetupInstallPanel";
import SetupModal from "../ui/components/SetupModal";
import SetupPlanCard, { type PlanSelection } from "../ui/components/SetupPlanCard";
import SetupReadyPanel from "../ui/components/SetupReadyPanel";
import SetupSignInPanel from "../ui/components/SetupSignInPanel";
import SetupStepper, { type SetupStepDef, type SetupStepState } from "../ui/components/SetupStepper";
import { useInterval } from "../ui/components/useInterval";
import type { BrainOptionsResponse, SetupJob, SetupPlan, SetupPlanStep, SystemCheck } from "../setupApi";
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
import { AGENT_NAMES, CODING_IDS, OPERATOR_IDS, formatMinutes, formatSize, totalsOf } from "../ui/setupGroupShared";
import "../ui/setup.css";

const STEP_LABELS = ["Check", "Plan", "Install", "AI brain", "Sign in", "Ready"];
const STEP = { check: 0, plan: 1, install: 2, brain: 3, signin: 4, ready: 5 } as const;
const AGENT_IDS = OPERATOR_IDS;
const ALL_AGENT_IDS = [...OPERATOR_IDS, ...CODING_IDS];

type GroupId = "operators" | "coding";

// What each agent should do by default: never an update, never a reinstall.
function defaultSelections(plan: SetupPlan) {
  const defaults: Record<string, PlanSelection> = {};
  for (const agentId of ALL_AGENT_IDS) {
    const steps = plan.steps.filter((s) => s.agentId === agentId);
    if (steps.some((s) => s.action === "skip-unsupported")) defaults[agentId] = "unsupported";
    else if (steps.some((s) => s.action === "keep")) defaults[agentId] = "keep";
    else defaults[agentId] = "install";
  }
  return defaults;
}

function installStepLabel(agentId: string | null, action: string) {
  const name = (agentId && AGENT_NAMES[agentId]) || "the agent";
  if (action === "install") return `Install ${name}`;
  if (action === "update") return `Update ${name}`;
  if (action === "prereq-node") return `Set up a Node 24 runtime for ${name}`;
  if (action === "keep") return `Keep ${name} as it is`;
  return `Skip ${name} (not supported here)`;
}

// A step asked for in the address (?step=brain), e.g. from the Get started
// checklist; anything that is not one of the six names is ignored.
function stepFromUrl(): number | null {
  const name = queryParam("step");
  return Object.prototype.hasOwnProperty.call(STEP, name) ? STEP[name as keyof typeof STEP] : null;
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
  // Which group's button was pressed; the confirm dialog is about that group only.
  const [confirmGroup, setConfirmGroup] = useState<GroupId | null>(null);
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
      if (job && job.status === "running") return STEP.brain;
      rememberJobId("configure", null);
    }
    const installId = recallJobId("install");
    if (installId) {
      const job = await getSetupJob(installId).catch(() => null);
      if (job && (job.status === "running" || job.status === "failed")) {
        setInstallJob(job);
        return STEP.install;
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
        getSetupPlan("all"),
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
        // A step named in the address (the Get started checklist uses this) wins
        // over the one worked out from what is installed.
        const asked = stepFromUrl();
        if (asked !== null) {
          setStepIndex(asked);
          return;
        }
        const anyInstalled = ALL_AGENT_IDS.some((id) => checkRes.agents?.[id]?.detected.installed);
        const needsAction = planRes.steps.some((s) => s.action === "install" || s.action === "prereq-node");
        // A brand-new computer starts at Check; a half-set-up one at Plan;
        // everything installed lands on AI brain, or Ready once configured.
        if (!anyInstalled) setStepIndex(STEP.check);
        else if (needsAction) setStepIndex(STEP.plan);
        else setStepIndex(brainReady(checkRes, brainRes) ? STEP.ready : STEP.brain);
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
        includePlan ? getSetupPlan("all") : Promise.resolve(null)
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

  // Already on Setup and a link (the checklist, the ⌘K palette) names another
  // step: go there instead of staying put.
  useEffect(() => {
    function onNavigate() {
      const asked = stepFromUrl();
      if (asked !== null && initializedRef.current) {
        focusOnStepChange.current = true;
        setStepIndex(asked);
      }
    }
    window.addEventListener("aos-navigate", onNavigate);
    return () => window.removeEventListener("aos-navigate", onNavigate);
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

  // ---- where "Continue" leads --------------------------------------------------
  // Hermes/OpenClaw need an AI brain; the coding agents only need a sign-in. A
  // step is skipped when nothing in it applies, so a person who installed only
  // coding agents is never shown a brain screen about agents they don't have.
  // An agent the install job just finished counts even if the re-check is still
  // on its way.
  function groupInstalled(ids: readonly string[]) {
    const jobDid = Boolean(
      installJob?.steps.some((s) => s.agentId && ids.includes(s.agentId) && s.action !== "prereq-node" && s.status === "succeeded")
    );
    return jobDid || ids.some((id) => check?.agents?.[id as keyof NonNullable<SystemCheck["agents"]>]?.detected.installed);
  }
  const afterBrain = () => (groupInstalled(CODING_IDS) ? STEP.signin : STEP.ready);
  const afterInstall = () => (groupInstalled(OPERATOR_IDS) ? STEP.brain : afterBrain());
  const afterPlan = () => (groupInstalled(OPERATOR_IDS) && !brainReady(check, brain) ? STEP.brain : afterBrain());

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
    if (index === STEP.install && installJob?.status === "failed") return "failed";
    if (index === STEP.brain && brainStatus === "failed") return "failed";
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

  // The steps a group's current choices would run, in plan order.
  function selectedSteps(ids: readonly string[]): SetupPlanStep[] {
    if (!plan) return [];
    const picked: SetupPlanStep[] = [];
    for (const agentId of ids) {
      const sel = selections[agentId];
      const { keepStep, updateStep, installSteps, unsupportedStep } = stepsFor(agentId);
      if (sel === "keep" && keepStep) picked.push(keepStep);
      else if (sel === "update" && updateStep) picked.push(updateStep);
      else if (sel === "install") picked.push(...installSteps);
      else if (sel === "unsupported" && unsupportedStep) picked.push(unsupportedStep);
      // "skip" (an un-ticked coding agent) adds nothing.
    }
    return picked;
  }

  const idsOf = (group: GroupId) => (group === "operators" ? OPERATOR_IDS : CODING_IDS);
  const workIn = (group: GroupId) =>
    selectedSteps(idsOf(group)).filter((s) => s.action === "install" || s.action === "update" || s.action === "prereq-node");

  const needsOpenClawConsentInstall = selections.openclaw === "install";
  const operatorWork = workIn("operators").length > 0;
  const codingWork = workIn("coding");
  const operatorsBlocked = operatorWork && needsOpenClawConsentInstall && !openClawRiskAccepted;

  async function confirmInstall() {
    if (!confirmGroup) return;
    setInstallBusy(true);
    setInstallConfirmError("");
    try {
      const job = await startInstallJob({
        steps: selectedSteps(idsOf(confirmGroup)).map((s) => s.id),
        acceptOpenClawRisk: confirmGroup === "operators" && needsOpenClawConsentInstall && openClawRiskAccepted
      });
      rememberJobId("install", job.id);
      setInstallJob(job);
      setConfirmGroup(null);
      goToStep(STEP.install);
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

  const confirmSteps = confirmGroup ? selectedSteps(idsOf(confirmGroup)) : [];
  const confirmTotals = totalsOf(confirmSteps.filter((s) => s.action === "install" || s.action === "prereq-node"));
  const wide = stepIndex === STEP.brain || stepIndex === STEP.plan;

  return (
    <div className={`os-setup aos-phase-page${wide ? " os-setup--wide" : ""}`}>
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
        {stepIndex === STEP.check ? (
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
                  <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(STEP.plan)}>
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

        {stepIndex === STEP.plan ? (
          <div className="os-setup__panel">
            <div className="os-setup__step-head">
              <h2>Here's the plan</h2>
              <p>Two groups. Choose what to do in each, then press its button. Nothing happens until you do.</p>
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
                <div className="os-setup-groups">
                  <SetupGroupPanel
                    kicker="Operators"
                    title="Hermes · OpenClaw"
                    description="Assistants that keep working in the background, even when you are away."
                    actionLabel={operatorWork ? "Set up Hermes + OpenClaw" : undefined}
                    onAction={() => {
                      setInstallConfirmError("");
                      setConfirmGroup("operators");
                    }}
                    actionDisabled={operatorsBlocked || installBusy}
                    hint={operatorsBlocked ? "Tick the OpenClaw box below first." : undefined}
                  >
                    {!operatorWork ? (
                      <p className="os-setup__hint">Nothing to install here. What is already installed is kept as it is.</p>
                    ) : null}
                    <div className="os-setup-plan__cards">
                      {AGENT_IDS.map((agentId) => {
                        const { keepStep, updateStep, installSteps, unsupportedStep } = stepsFor(agentId);
                        return (
                          <SetupPlanCard
                            key={agentId}
                            label={agentMeta(agentId)?.label || AGENT_NAMES[agentId]}
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
                  </SetupGroupPanel>

                  <SetupGroupPanel
                    kicker="Coding agents"
                    title="Claude Code · Codex · Cursor"
                    description="Programming helpers you talk to. Each one signs in with its own account in a later step."
                    actionLabel={codingWork.length ? "Install coding agents" : undefined}
                    onAction={() => {
                      setInstallConfirmError("");
                      setConfirmGroup("coding");
                    }}
                    actionDisabled={installBusy}
                  >
                    <SetupCodingRows
                      rows={CODING_IDS.map((agentId) => ({
                        agentId,
                        label: AGENT_NAMES[agentId],
                        ...stepsFor(agentId)
                      }))}
                      selections={selections}
                      onSelect={(agentId, next) => setSelections((prev) => ({ ...prev, [agentId]: next }))}
                      disabled={installBusy}
                      selectedSteps={selectedSteps(CODING_IDS)}
                    />
                  </SetupGroupPanel>
                </div>

                {plan.blocked.length ? (
                  <div className="os-setup__alert" role="alert">
                    <AlertTriangle size={16} />
                    <span>{plan.blocked.map((b) => `${AGENT_NAMES[b.agentId] || b.agentId}: ${b.reason}`).join(" ")}</span>
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
                  <button
                    type="button"
                    className={`os-btn ${operatorWork || codingWork.length ? "os-btn--secondary" : "os-btn--primary"}`}
                    onClick={() => goToStep(afterPlan())}
                  >
                    {operatorWork || codingWork.length ? "Skip installing, continue" : "Continue"}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {stepIndex === STEP.install ? (
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
                    <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(afterInstall())}>
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
                  <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(afterInstall())}>
                    Continue
                  </button>
                </div>
              </Panel>
            )}
          </div>
        ) : null}

        {stepIndex === STEP.brain ? (
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
                  onContinue={() => goToStep(afterBrain())}
                />
              </>
            ) : (
              <p className="os-setup__loading">Loading model provider options…</p>
            )}
          </div>
        ) : null}

        {stepIndex === STEP.signin ? (
          <SetupSignInPanel onContinue={() => goToStep(STEP.ready)} onGoToPlan={() => goToStep(STEP.plan)} />
        ) : null}

        {stepIndex === STEP.ready ? (
          <SetupReadyPanel
            onGoHome={() => navigateTo("fleet")}
            onOpenSafety={() => navigateTo("safety")}
            onGoToStep={goToStep}
            onOpenAgent={(agentId) => navigateTo("agents", { agent: agentId })}
          />
        ) : null}
      </div>

      {confirmGroup ? (
        <SetupModal
          title={confirmGroup === "coding" ? "Install coding agents?" : "Set up Hermes + OpenClaw?"}
          confirmLabel={confirmGroup === "coding" ? "Install coding agents" : "Set up Hermes + OpenClaw"}
          onConfirm={confirmInstall}
          onClose={() => setConfirmGroup(null)}
          busy={installBusy}
          error={installConfirmError}
        >
          <p>This will run:</p>
          <ul>
            {confirmSteps.map((s) => (
              <li key={s.id}>{planStepLabels[s.id] || s.id}</li>
            ))}
          </ul>
          {confirmGroup === "coding" && confirmTotals.complete ? (
            <p>
              About {formatSize(confirmTotals.mb)} to download and store, roughly {formatMinutes(confirmTotals.minutes)}. Anything
              already installed is kept as it is.
            </p>
          ) : null}
        </SetupModal>
      ) : null}
    </div>
  );
}
