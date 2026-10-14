// The Setup Assistant: six steps (Check, Plan, Install, AI brain, Sign in, Ready)
// for a non-expert setting up Hermes and OpenClaw (the always-on agents) and
// Claude Code, Codex and Cursor (the coding agents). A step rail on the left, one
// panel on the right, a footer that stays in view. One decision per screen;
// nothing installs or configures without an explicit confirm. All data comes
// from server/runtime/setup/* through ../setupApi (see that file for the exact
// response shapes). The jobs, the polling and the confirm dialogs are the same as
// before; only what is drawn is new, and what the page does not know it does not
// say: an unknown value is "—", a request that got no answer is never "nothing
// was changed", and the last good data stays on screen under a warning.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, PackageCheck, RefreshCw, X } from "lucide-react";
import { listAgents } from "../api";
import { navigateTo, queryParam } from "../nav";
import type { AgentSummary } from "../types";
import Banner from "../ui/components/Banner";
import EmptyState from "../ui/components/EmptyState";
import PageHeader from "../ui/components/PageHeader";
import SetupBrainPanel, { type BrainAgentLine, type BrainPanelStatus } from "../ui/components/SetupBrainPanel";
import SetupChanges from "../ui/components/SetupChanges";
import SetupCheckList from "../ui/components/SetupCheckList";
import SetupCommand from "../ui/components/SetupCommand";
import SetupFooter from "../ui/components/SetupFooter";
import SetupInstallPanel from "../ui/components/SetupInstallPanel";
import SetupModal from "../ui/components/SetupModal";
import SetupPlanGroup from "../ui/components/SetupPlanGroup";
import SetupPlanRow from "../ui/components/SetupPlanRow";
import SetupReadyPanel from "../ui/components/SetupReadyPanel";
import SetupSignInPanel from "../ui/components/SetupSignInPanel";
import SetupStatus from "../ui/components/SetupStatus";
import SetupStepper, { type SetupStepDef } from "../ui/components/SetupStepper";
import { useInterval } from "../ui/components/useInterval";
import { withTimeout } from "../ui/homeShared";
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
import {
  AGENT_NAMES,
  ALL_AGENT_IDS,
  CODING_IDS,
  OPERATOR_IDS,
  STEP,
  agentFact,
  brainFooterNote,
  checkFooterNote,
  defaultSelections,
  formatMinutes,
  formatSize,
  gotNoAnswer,
  groupAction,
  mergeSelections,
  needsOpenClawConsent,
  railStep,
  readProblem,
  reaskNote,
  totalsOf,
  type GroupId,
  type PlanSelection
} from "../ui/setupGroupShared";
import "../ui/setup.css";

// `line` is what the rail says under the name until there is something to report;
// `lede` is the one sentence under the panel's title.
const STEPS = [
  {
    key: "check",
    label: "Check",
    line: "Look at this computer",
    lede: "Agent OS reads what is on this computer. It changes nothing in this step."
  },
  {
    key: "plan",
    label: "Plan",
    line: "Keep, update or install each agent",
    lede: "Choose what to do for each agent. Nothing runs until you press a group's button and confirm. Keeping an agent as it is is always safe."
  },
  {
    key: "install",
    label: "Install",
    line: "Do it, with a visible log",
    lede: "Agent OS carries out the plan one step at a time and shows every line it runs."
  },
  {
    key: "brain",
    label: "AI brain",
    line: "Models for always-on agents",
    lede: "Hermes and OpenClaw need a brain: the language model that does their thinking. Each one can use a different brain."
  },
  {
    key: "signin",
    label: "Sign in",
    line: "Sign in to the coding agents",
    lede: "Sign in to each coding agent with its own login. Agent OS never sees your password."
  },
  {
    key: "ready",
    label: "Ready",
    line: "See what is in place",
    lede: "A last look at what is in place on this computer."
  }
] as const;
const AGENT_IDS = OPERATOR_IDS;
const CODING_COLUMNS = "minmax(132px, 176px) 176px minmax(0, 1fr)";

// Every request that could hang has a time limit. The check and the agents list ask
// each agent's own command, which can take about 13 s on a cold or hung one, so they
// get more room than the rest.
const CHECK_TIMEOUT_MS = 25000;
const READ_TIMEOUT_MS = 20000;
const ACTION_TIMEOUT_MS = 20000;
const POLL_TIMEOUT_MS = 10000;

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

// The line under the Coding agents heading: what the ticked work would download.
function codingNote(selected: SetupPlanStep[]): ReactNode {
  const downloads = selected.filter((s) => s.action === "install" || s.action === "prereq-node");
  const updates = selected.filter((s) => s.action === "update");
  const totals = totalsOf(downloads);
  if (downloads.length) {
    return totals.complete ? (
      <>
        <strong>
          About {formatSize(totals.mb)} to download and store · roughly {formatMinutes(totals.minutes)}
        </strong>
        <span> (depends on your internet connection){updates.length ? "; updates are extra" : ""}</span>
      </>
    ) : (
      <strong>Download sizes vary.</strong>
    );
  }
  if (updates.length) return <strong>Updates only. Their size varies.</strong>;
  return <strong>Nothing chosen, so nothing will change.</strong>;
}

function RetryButton({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className="os-btn os-btn--secondary" onClick={onClick} disabled={busy}>
      <RefreshCw size={14} aria-hidden="true" /> {busy ? "Checking…" : "Retry"}
    </button>
  );
}

// The AI brain step has nothing to choose for the coding agents; the table says so
// and shows whether each one is installed (from the check). An agent the check did
// not report is "—", never "Not installed".
function CodingNoChoice({ check }: { check: SystemCheck | null }) {
  return (
    <div className="os-setup-coding">
      <div
        className="os-table os-setup-table"
        role="table"
        aria-label="Coding agents: no choice needed"
        style={{ "--os-table-cols": CODING_COLUMNS } as CSSProperties}
      >
        <div className="os-visually-hidden" role="row">
          {["Coding agent", "Found", "What to choose"].map((heading) => (
            <span key={heading} role="columnheader">
              {heading}
            </span>
          ))}
        </div>
        <div className="os-table__group os-setup-table__group" role="presentation">
          <b>Coding agents</b>
          <span>No choice needed</span>
        </div>
        {CODING_IDS.map((id) => {
          const entry = check?.agents?.[id];
          const installed = Boolean(entry?.detected.installed);
          return (
            <div key={id} className="os-table__row" role="row">
              <div className="os-table__cell os-setup-table__name" role="rowheader">
                {AGENT_NAMES[id]}
              </div>
              <div className="os-table__cell" role="cell">
                {entry ? (
                  <SetupStatus tone={installed ? "ok" : "unknown"}>{installed ? "Installed" : "Not installed"}</SetupStatus>
                ) : (
                  <SetupStatus tone="unknown">—</SetupStatus>
                )}
              </div>
              <div className="os-table__cell os-setup-table__detail" role="cell">
                Uses its own sign-in. Nothing to choose here.
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function SetupPage() {
  const [check, setCheck] = useState<SystemCheck | null>(null);
  // "" = the last read worked. Otherwise the sentence for why it did not; any earlier
  // data stays on screen under a warning.
  const [checkError, setCheckError] = useState("");
  const [rechecking, setRechecking] = useState(false);
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [brain, setBrain] = useState<BrainOptionsResponse | null>(null);
  const [brainError, setBrainError] = useState("");
  const [agentsMeta, setAgentsMeta] = useState<AgentSummary[] | null>(null);
  // After a job, the page re-reads the computer; if that got no answer, what is on screen may be old.
  const [stale, setStale] = useState(false);

  const [stepIndex, setStepIndex] = useState(0);
  const initializedRef = useRef(false);
  // True once the person has moved to a step themselves: the first-load landing then leaves them where they are.
  const movedRef = useRef(false);
  const alive = useRef(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusOnStepChange = useRef(false);
  const [actionError, setActionError] = useState("");

  const [selections, setSelections] = useState<Record<string, PlanSelection>>({});
  const [openClawRiskAccepted, setOpenClawRiskAccepted] = useState(false);
  // Which group's button was pressed; the confirm dialog is about that group only.
  const [confirmGroup, setConfirmGroup] = useState<GroupId | null>(null);
  const [installConfirmError, setInstallConfirmError] = useState("");
  const [installJob, setInstallJob] = useState<SetupJob | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  // The last poll of the running job got no answer, so the progress shown may be old.
  const [pollFailed, setPollFailed] = useState(false);
  const pollBusy = useRef(false);
  // Asking about an earlier install got no answer: it is not known whether one is running.
  const [jobUnknown, setJobUnknown] = useState(false);

  // What the AI brain panel is doing (it runs its own configure job and
  // result screen); used for the rail and for the footer's buttons.
  const [brainStatus, setBrainStatus] = useState<BrainPanelStatus>("idle");
  // What the Sign in and Ready steps last reported, so the rail can say "2 of 3 signed in"
  // and show Ready as done only when nothing is left to fix. null = not known yet.
  const [signIn, setSignIn] = useState<{ signedIn: number; installed: number; unchecked: number } | null>(null);
  const [readyProblems, setReadyProblems] = useState<number | null>(null);
  // Steps the person left with a Skip button. The rail says "Skipped" for one the page never saw data for.
  const [skipped, setSkipped] = useState<number[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Asks the server about a remembered job. A job the server does not know (or one
  // that has finished) is forgotten; a question that got no answer is NOT a reason to
  // forget it, so a reload can still find it later.
  async function lookupJob(id: string): Promise<SetupJob | null | "unknown"> {
    try {
      return await withTimeout(getSetupJob(id), READ_TIMEOUT_MS);
    } catch (error) {
      return gotNoAnswer(error) ? "unknown" : null;
    }
  }

  // A job that is still running (or just failed) on the server survives a
  // reload or a trip to another page: re-attach to it instead of showing an
  // empty Install step. Returns the step to land on, or null. (A running
  // configure job is picked up again by the AI brain panel itself.)
  async function restoreJobs(): Promise<number | null> {
    const configureId = recallJobId("configure");
    if (configureId) {
      const job = await lookupJob(configureId);
      if (job !== "unknown") {
        if (job && job.status === "running") return STEP.brain;
        rememberJobId("configure", null);
      }
    }
    const installId = recallJobId("install");
    if (installId) {
      const job = await lookupJob(installId);
      if (job === "unknown") {
        if (alive.current) setJobUnknown(true);
      } else if (job && (job.status === "running" || job.status === "failed")) {
        if (alive.current) setInstallJob(job);
        return STEP.install;
      } else {
        rememberJobId("install", null);
      }
    }
    return null;
  }

  async function loadAll(refresh = false) {
    let checkRes: SystemCheck;
    try {
      checkRes = await withTimeout(getSetupCheck(refresh), CHECK_TIMEOUT_MS);
    } catch (error) {
      if (alive.current) setCheckError(readProblem(error, "what is installed"));
      return;
    }
    if (!alive.current) return;
    setCheck(checkRes);
    setCheckError("");
    setStale(false);

    // The plan, the brain options and the agents list are read together but judged apart:
    // one that fails must not hide the others.
    const [planRes, brainRes, agentsRes] = await Promise.allSettled([
      withTimeout(getSetupPlan("all"), READ_TIMEOUT_MS),
      withTimeout(getBrainOptions(refresh), READ_TIMEOUT_MS),
      withTimeout(listAgents(), READ_TIMEOUT_MS)
    ]);
    if (!alive.current) return;
    if (planRes.status === "fulfilled") {
      setPlan(planRes.value);
      setPlanError("");
      setSelections((prev) => mergeSelections(prev, planRes.value));
    } else {
      setPlanError(readProblem(planRes.reason, "the setup plan"));
    }
    if (brainRes.status === "fulfilled") {
      setBrain(brainRes.value);
      setBrainError("");
    } else {
      setBrainError(readProblem(brainRes.reason, "the AI brain options"));
    }
    if (agentsRes.status === "fulfilled") setAgentsMeta(agentsRes.value.agents);

    if (planRes.status !== "fulfilled" || brainRes.status !== "fulfilled" || initializedRef.current) return;
    initializedRef.current = true;
    const restored = await restoreJobs();
    if (!alive.current) return;
    if (restored !== null) {
      setStepIndex(restored);
      return;
    }
    // The person already chose a step while this was loading: do not move them.
    if (movedRef.current) return;
    // A step named in the address (the Get started checklist uses this) wins
    // over the one worked out from what is installed.
    const asked = stepFromUrl();
    if (asked !== null) {
      setStepIndex(asked);
      return;
    }
    const anyInstalled = ALL_AGENT_IDS.some((id) => checkRes.agents?.[id]?.detected.installed);
    const needsAction = planRes.value.steps.some((s) => s.action === "install" || s.action === "prereq-node");
    // A brand-new computer starts at Check; a half-set-up one at Plan;
    // everything installed lands on AI brain, or Ready once configured.
    if (!anyInstalled) setStepIndex(STEP.check);
    else if (needsAction) setStepIndex(STEP.plan);
    else setStepIndex(brainReady(checkRes, brainRes.value) ? STEP.ready : STEP.brain);
  }

  // After a job finishes, what the page knew before (installed? configured?)
  // is stale; re-read it from the server so the next step is truthful. If the
  // re-read gets no answer the old data stays, with a note saying so.
  async function refreshServerState(includePlan: boolean) {
    try {
      const [checkRes, brainRes, planRes] = await Promise.all([
        withTimeout(getSetupCheck(true), CHECK_TIMEOUT_MS),
        withTimeout(getBrainOptions(true), READ_TIMEOUT_MS),
        includePlan ? withTimeout(getSetupPlan("all"), READ_TIMEOUT_MS) : Promise.resolve(null)
      ]);
      if (!alive.current) return;
      // Each message is about the data it came with: new data from a good answer ends it.
      setCheck(checkRes);
      setCheckError("");
      setBrain(brainRes);
      setBrainError("");
      if (planRes) {
        setPlan(planRes);
        setPlanError("");
        // The plan changed under the choices (an agent was just installed or updated): start from the defaults.
        setSelections(defaultSelections(planRes));
      }
      setStale(false);
    } catch {
      if (alive.current) setStale(true);
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
        movedRef.current = true;
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
  // would drop keyboard focus on <body>; put it on the new step's title.
  useEffect(() => {
    if (!focusOnStepChange.current) return;
    focusOnStepChange.current = false;
    titleRef.current?.focus();
  }, [stepIndex]);

  // The Ready step's count is only true while Ready is on screen.
  useEffect(() => {
    if (stepIndex !== STEP.ready) setReadyProblems(null);
  }, [stepIndex]);

  function markSkipped(index: number, yes: boolean) {
    setSkipped((prev) => (yes ? (prev.includes(index) ? prev : [...prev, index]) : prev.filter((i) => i !== index)));
  }

  // Every step change a person causes goes through here; the first landing
  // (derived from the server) does not, so the page doesn't grab focus on load.
  function goToStep(index: number) {
    focusOnStepChange.current = true;
    movedRef.current = true;
    // A message about the step they just left would be about the wrong screen.
    setActionError("");
    setStepIndex(index);
  }

  // ---- where "Continue" and "Back" lead ----------------------------------------
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
  // Back skips the same steps Continue skips: Install only if a job exists, AI brain only
  // if Hermes or OpenClaw is installed, Sign in only if a coding agent is.
  function appliesTo(index: number) {
    if (index === STEP.install) return Boolean(installJob);
    if (index === STEP.brain) return groupInstalled(OPERATOR_IDS);
    if (index === STEP.signin) return groupInstalled(CODING_IDS);
    return true;
  }
  function previousStep(index: number) {
    for (let i = index - 1; i > 0; i -= 1) if (appliesTo(i)) return i;
    return STEP.check;
  }

  // ---- job polling ----------------------------------------------------------
  // One poll at a time (a slow answer must not pile up behind the next tick). When a
  // poll gets no answer the last good progress stays on screen and a note says so;
  // the next good answer clears it.
  useInterval(
    async () => {
      if (!installJob || pollBusy.current) return;
      pollBusy.current = true;
      try {
        const next = await withTimeout(getSetupJob(installJob.id), POLL_TIMEOUT_MS);
        if (!alive.current) return;
        setInstallJob(next);
        setPollFailed(false);
      } catch {
        if (alive.current) setPollFailed(true);
      } finally {
        pollBusy.current = false;
      }
    },
    installJob && installJob.status === "running" ? 1000 : null
  );

  function agentMeta(agentId: string) {
    return agentsMeta?.find((a) => a.id === agentId);
  }

  function stepsFor(agentId: string) {
    const all = plan?.steps.filter((s) => s.agentId === agentId) || [];
    return {
      keepStep: all.find((s) => s.action === "keep"),
      // Hermes has none (Task B1): an installed agent may have a keep step and nothing else.
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
      // "skip" (a coding agent switched to Skip) adds nothing.
    }
    return picked;
  }

  const idsOf = (group: GroupId) => (group === "operators" ? OPERATOR_IDS : CODING_IDS);
  const workIn = (group: GroupId) =>
    selectedSteps(idsOf(group)).filter((s) => s.action === "install" || s.action === "update" || s.action === "prereq-node");

  const operatorWorkSteps = workIn("operators");
  const codingWorkSteps = workIn("coding");
  const operatorWork = operatorWorkSteps.length > 0;
  const anyWork = operatorWork || codingWorkSteps.length > 0;
  // The consent box is drawn only when OpenClaw would really be installed, so the need for it comes from
  // the steps that would run (not from the row's choice, which has no box when its installer is unreachable).
  const needsConsent = needsOpenClawConsent(operatorWorkSteps);
  const operatorsBlocked = needsConsent && !openClawRiskAccepted;

  async function confirmInstall() {
    if (!confirmGroup) return;
    setInstallBusy(true);
    setInstallConfirmError("");
    try {
      const job = await withTimeout(
        startInstallJob({
          steps: selectedSteps(idsOf(confirmGroup)).map((s) => s.id),
          acceptOpenClawRisk: confirmGroup === "operators" && needsConsent && openClawRiskAccepted
        }),
        ACTION_TIMEOUT_MS
      );
      // The server has started the job whether or not this page is still on screen, so its id is
      // always remembered (a sessionStorage write, nothing to unmount). Only the screen updates wait.
      rememberJobId("install", job.id);
      if (!alive.current) return;
      setInstallJob(job);
      setPollFailed(false);
      setJobUnknown(false);
      setConfirmGroup(null);
      goToStep(STEP.install);
    } catch (error) {
      if (!alive.current) return;
      // Keep the dialog open so the reason is readable next to the button.
      setInstallConfirmError(
        gotNoAnswer(error)
          ? "Agent OS did not answer, so the install may or may not have started. Close this, open the Check step and press Check again to see what is installed. If it did start, pressing the button again is refused while it runs."
          : friendlyError(error)
      );
    } finally {
      if (alive.current) setInstallBusy(false);
    }
  }

  // After a cancel or retry that got no answer, ask once more how the job stands, so the
  // page learns the truth if the server did act. The "may not have gone through" message
  // was written before the answer; once the answer is in, it is replaced by what happened.
  async function recheckJob(id: string, kind: "cancel" | "retry") {
    try {
      const next = await withTimeout(getSetupJob(id), POLL_TIMEOUT_MS);
      if (!alive.current) return;
      setInstallJob(next);
      setActionError(reaskNote(kind, next.status));
    } catch {
      // Still no answer: the message on screen says so.
    }
  }

  async function onCancelInstall() {
    if (!installJob) return;
    const id = installJob.id;
    try {
      const next = await withTimeout(cancelSetupJob(id), ACTION_TIMEOUT_MS);
      if (alive.current) setInstallJob(next);
    } catch (error) {
      if (!alive.current) return;
      if (gotNoAnswer(error)) {
        setActionError("Agent OS did not answer, so the cancel may not have gone through. The install may still be running. This page checks again.");
        void recheckJob(id, "cancel");
      } else {
        setActionError(friendlyError(error));
      }
    }
  }

  async function onRetryInstall() {
    if (!installJob) return;
    const id = installJob.id;
    setInstallBusy(true);
    setActionError("");
    try {
      const next = await withTimeout(retrySetupJob(id), ACTION_TIMEOUT_MS);
      if (alive.current) {
        setInstallJob(next);
        setPollFailed(false);
      }
    } catch (error) {
      if (!alive.current) return;
      if (gotNoAnswer(error)) {
        setActionError("Agent OS did not answer, so the retry may not have started. This page checks again.");
        void recheckJob(id, "retry");
      } else {
        setActionError(friendlyError(error));
      }
    } finally {
      if (alive.current) setInstallBusy(false);
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

  // One re-read at a time: the Retry buttons and Check again all come through here.
  async function onRecheck() {
    if (rechecking) return;
    setRechecking(true);
    try {
      await loadAll(true);
    } finally {
      if (alive.current) setRechecking(false);
    }
  }

  // ---- the rail: state and a one-line summary per step, from what the page knows ----
  // The decisions are in railStep (setupGroupShared.ts, tested in test/setup-page-logic.test.js): a step
  // the page never saw data for reads "Skipped" or "Not checked", never a green Done.
  const steps: SetupStepDef[] = STEPS.map((s, i) => {
    const { state, summary } = railStep(i, {
      stepIndex,
      check,
      planLoaded: Boolean(plan),
      installJob,
      jobUnknown,
      brainLoaded: Boolean(brain),
      brainStatus,
      operators: OPERATOR_IDS.map((id) => ({
        fact: agentFact(check?.agents?.[id]?.detected),
        configured: Boolean(brain?.current[id].configured)
      })),
      coding: {
        installed: groupInstalled(CODING_IDS),
        unknown: CODING_IDS.some((id) => agentFact(check?.agents?.[id]?.detected) === "unknown")
      },
      signIn,
      readyProblems,
      skipped
    });
    return { key: s.key, label: s.label, line: s.line, summary, state, current: i === stepIndex };
  });

  const confirmSteps = confirmGroup ? selectedSteps(idsOf(confirmGroup)) : [];
  const confirmTotals = totalsOf(confirmSteps.filter((s) => s.action === "install" || s.action === "prereq-node"));
  const confirmAction = confirmGroup ? groupAction(confirmGroup, workIn(confirmGroup)) || "" : "";

  const operatorsLabel = groupAction("operators", operatorWorkSteps);
  const codingLabel = groupAction("coding", codingWorkSteps);
  const current = STEPS[stepIndex];

  // ---- one block per step: the content, then the footer ------------------------
  const checkStep = (
    <>
      <div className="os-setup-panel__content">
        {checkError ? (
          check ? (
            <Banner tone="warn" title="Couldn't check this computer" actions={<RetryButton onClick={() => void onRecheck()} busy={rechecking} />}>
              {checkError} What you see is from the last check, so it may be out of date.
            </Banner>
          ) : (
            <Banner tone="danger" title="Couldn't check this computer" actions={<RetryButton onClick={() => void onRecheck()} busy={rechecking} />}>
              {checkError} Try again.
            </Banner>
          )
        ) : null}
        {check ? (
          <SetupCheckList check={check} />
        ) : !checkError ? (
          <p className="os-setup-loading" role="status">
            Checking this computer…
          </p>
        ) : null}
      </div>
      <SetupFooter
        note={checkFooterNote({
          checkError: Boolean(checkError),
          hasCheck: Boolean(check),
          jobUnknown,
          installSteps: installJob ? installJob.steps.length : null,
          brainJob: brainStatus !== "idle"
        })}
      >
        <button
          type="button"
          className="os-btn os-btn--secondary"
          onClick={() => void onRecheck()}
          disabled={rechecking || (!check && !checkError)}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {rechecking ? "Checking…" : "Check again"}
        </button>
        <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(STEP.plan)} disabled={!check || Boolean(checkError)}>
          Continue
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </SetupFooter>
    </>
  );

  // The plan could not be read and there is none to show: nothing can be installed from here, but the
  // person is not stuck on this step. "Skip installing, continue" does not need the plan.
  const planFailed = !plan && Boolean(planError);
  const planStep = (
    <>
      <div className="os-setup-panel__content">
        {planError ? (
          plan ? (
            <Banner tone="warn" title="Couldn't refresh the setup plan" actions={<RetryButton onClick={() => void onRecheck()} busy={rechecking} />}>
              {planError} The plan below is the last one Agent OS read, so it may be out of date.
            </Banner>
          ) : (
            <Banner tone="danger" title="Couldn't load the setup plan" actions={<RetryButton onClick={() => void onRecheck()} busy={rechecking} />}>
              {planError} Try again.
            </Banner>
          )
        ) : null}
        {!plan && !planError ? (
          <p className="os-setup-loading" role="status">
            Loading the setup plan…
          </p>
        ) : null}
        {plan ? (
          <>
            {plan.blocked.length ? (
              <Banner tone="warn" title="Setup can't do everything here">
                {plan.blocked.map((b) => `${AGENT_NAMES[b.agentId] || b.agentId}: ${b.reason}`).join(" ")}
              </Banner>
            ) : null}
            {plan.manualSteps.length ? (
              <Banner tone="warn" title="Do this in a terminal first">
                <div className="os-setup-manual">
                  {plan.manualSteps.map((m, i) => (
                    <div key={i}>
                      <p>{m.reason}</p>
                      <SetupCommand command={m.command} />
                    </div>
                  ))}
                </div>
              </Banner>
            ) : null}

            <SetupPlanGroup
              id="operators"
              title="Always-on agents"
              sub="Hermes · OpenClaw"
              description="Assistants that keep working in the background, even when you are away."
              actionLabel={operatorsLabel}
              onAction={() => {
                setInstallConfirmError("");
                setConfirmGroup("operators");
              }}
              actionDisabled={operatorsBlocked || installBusy}
              hint={operatorsBlocked ? "Tick the OpenClaw box in its row first." : undefined}
              note={!operatorWork ? "Nothing to install here. What is already installed is kept as it is." : undefined}
            >
              {AGENT_IDS.map((agentId) => (
                <SetupPlanRow
                  key={agentId}
                  label={agentMeta(agentId)?.label || AGENT_NAMES[agentId]}
                  license={agentMeta(agentId)?.license}
                  {...stepsFor(agentId)}
                  selection={selections[agentId] || "keep"}
                  onSelect={(next) => setSelections((prev) => ({ ...prev, [agentId]: next }))}
                  disabled={installBusy}
                  canSkip={false}
                  consent={
                    agentId === "openclaw"
                      ? { accepted: openClawRiskAccepted, onToggle: setOpenClawRiskAccepted }
                      : undefined
                  }
                />
              ))}
            </SetupPlanGroup>

            <SetupPlanGroup
              id="coding"
              title="Coding agents"
              sub="Claude Code · Codex · Cursor"
              description="Programming helpers you talk to. Each one signs in with its own account in a later step. Anything already installed is kept as it is."
              actionLabel={codingLabel}
              onAction={() => {
                setInstallConfirmError("");
                setConfirmGroup("coding");
              }}
              actionDisabled={installBusy}
              note={codingNote(selectedSteps(CODING_IDS))}
            >
              {CODING_IDS.map((agentId) => (
                <SetupPlanRow
                  key={agentId}
                  label={AGENT_NAMES[agentId]}
                  {...stepsFor(agentId)}
                  selection={selections[agentId] || "keep"}
                  onSelect={(next) => setSelections((prev) => ({ ...prev, [agentId]: next }))}
                  disabled={installBusy}
                  canSkip
                />
              ))}
            </SetupPlanGroup>

            <SetupChanges work={[...operatorWorkSteps, ...codingWorkSteps]} labels={AGENT_NAMES} />
          </>
        ) : null}
      </div>
      <SetupFooter
        onBack={() => goToStep(STEP.check)}
        note={
          planFailed
            ? "The plan did not load, so nothing can be installed from here. You can skip installing and carry on."
            : anyWork
              ? "Nothing runs until you press a group's button and confirm."
              : "Nothing will change. Continue to the next step."
        }
      >
        <button
          type="button"
          className={`os-btn ${anyWork || planFailed ? "os-btn--secondary" : "os-btn--primary"}`}
          onClick={() => {
            markSkipped(STEP.plan, anyWork || planFailed);
            goToStep(afterPlan());
          }}
          disabled={!plan && !planFailed}
        >
          {anyWork || planFailed ? "Skip installing, continue" : "Continue"}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </SetupFooter>
    </>
  );

  const installNote = !installJob
    ? jobUnknown
      ? "It is not known whether anything is running."
      : "Nothing is running."
    : installJob.status === "running"
      ? "Continue unlocks when the install finishes."
      : installJob.status === "succeeded"
        ? "Install finished."
        : installJob.status === "failed"
          ? "A step failed. Retry it above, or go back to the plan."
          : "Setup was cancelled. Retry it above, or go back to the plan.";
  const installStep = installJob ? (
    <>
      <div className="os-setup-panel__content">
        {pollFailed && installJob.status === "running" ? (
          <Banner tone="warn" title="Agent OS did not answer just now">
            The progress below is the last update this page received, so it may be out of date. The page keeps trying.
          </Banner>
        ) : null}
        <SetupInstallPanel
          job={installJob}
          stepLabels={planStepLabels}
          commandPreviews={planCommandPreviews}
          onCancel={onCancelInstall}
          onRetry={onRetryInstall}
          busy={installBusy}
        />
      </div>
      <SetupFooter onBack={() => goToStep(previousStep(STEP.install))} backDisabled={installJob.status === "running"} note={installNote}>
        <button
          type="button"
          className="os-btn os-btn--primary"
          onClick={() => goToStep(afterInstall())}
          disabled={installJob.status !== "succeeded"}
        >
          Continue
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </SetupFooter>
    </>
  ) : (
    <>
      <div className="os-setup-panel__content">
        {jobUnknown ? (
          <EmptyState
            icon={PackageCheck}
            title="Can't tell if an install is running"
            body="Agent OS did not answer when asked about your last install. Go to the Check step and press Check again."
            action={
              <button type="button" className="os-btn os-btn--secondary" onClick={() => goToStep(STEP.check)}>
                Go to Check
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={PackageCheck}
            title="Nothing to install"
            body="No install is running right now. If your agents were already on this computer, you can move on."
            action={
              <button type="button" className="os-btn os-btn--secondary" onClick={() => goToStep(STEP.plan)}>
                Go to Plan
              </button>
            }
          />
        )}
      </div>
      <SetupFooter onBack={() => goToStep(previousStep(STEP.install))} note={installNote}>
        <button type="button" className="os-btn os-btn--primary" onClick={() => goToStep(afterInstall())}>
          Continue
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </SetupFooter>
    </>
  );

  const brainOk = brainReady(check, brain);
  const brainNeeded = brainAgents.some((a) => a.installed);
  const brainRunning = brainStatus === "running";
  // What the footer says about Hermes and OpenClaw comes from the check's facts: an agent the check did not
  // report is "could not tell", never "not installed".
  const brainNote = brainFooterNote({
    running: brainRunning,
    hasBrain: Boolean(brain),
    brainError: Boolean(brainError),
    operators: OPERATOR_IDS.map((id) => agentFact(check?.agents?.[id]?.detected)),
    brainOk
  });
  const brainStep = (
    <>
      <div className="os-setup-panel__content">
        {brainError && brain ? (
          <Banner tone="warn" title="Couldn't refresh the AI brain options" actions={<RetryButton onClick={() => void onRecheck()} busy={rechecking} />}>
            {brainError} What you see is the last set Agent OS read, so it may be out of date.
          </Banner>
        ) : null}
        {brain ? (
          <>
            <SetupBrainPanel
              brain={brain}
              agents={brainAgents}
              onChanged={() => void refreshServerState(false)}
              onStatus={setBrainStatus}
              onContinue={() => {
                markSkipped(STEP.brain, false);
                goToStep(afterBrain());
              }}
            />
            <CodingNoChoice check={check} />
          </>
        ) : brainError ? (
          <Banner tone="danger" title="Couldn't load the AI brain options" actions={<RetryButton onClick={() => void onRecheck()} busy={rechecking} />}>
            {brainError} Try again.
          </Banner>
        ) : (
          <p className="os-setup-loading" role="status">
            Loading model provider options…
          </p>
        )}
      </div>
      <SetupFooter onBack={() => goToStep(previousStep(STEP.brain))} backDisabled={brainRunning} note={brainNote}>
        <button
          type="button"
          className={`os-btn ${brainOk || !brainNeeded ? "os-btn--primary" : "os-btn--secondary"}`}
          onClick={() => {
            markSkipped(STEP.brain, !(brainOk || !brainNeeded));
            goToStep(afterBrain());
          }}
          // While the options are loading there is nothing to skip yet; once they failed, skipping is the way on.
          disabled={brainRunning || (!brain && !brainError)}
        >
          {brainOk || !brainNeeded ? "Continue" : "Skip for now"}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </SetupFooter>
    </>
  );

  return (
    <div className="os-setup">
      <PageHeader
        title="Setup"
        titleId="os-setup-title"
        lede="Agent OS checks this computer, shows every change, and asks first. Run it again any time."
      />

      {actionError ? (
        <Banner
          tone="danger"
          actions={
            <button type="button" className="os-btn os-btn--ghost" onClick={() => setActionError("")} aria-label="Dismiss this message">
              <X size={14} aria-hidden="true" />
            </button>
          }
        >
          {actionError}
        </Banner>
      ) : null}

      {stale ? (
        <Banner tone="warn" title="Couldn't re-read this computer" actions={<RetryButton onClick={() => void onRecheck()} busy={rechecking} />}>
          After the last step Agent OS did not answer, so what you see may be out of date.
        </Banner>
      ) : null}

      <div className="os-setup__wrap">
        <SetupStepper steps={steps} onSelect={goToStep} />

        <section className="os-setup-panel" aria-labelledby="os-setup-step-title">
          <header className="os-setup-panel__head">
            <div className="os-setup-panel__top">
              <h2 id="os-setup-step-title" className="os-setup-panel__title" ref={titleRef} tabIndex={-1}>
                {current.label}
              </h2>
              <span className="os-setup-panel__count os-mono">
                Step {stepIndex + 1} of {STEPS.length}
              </span>
            </div>
            <p className="os-setup-panel__lede">{current.lede}</p>
          </header>

          {stepIndex === STEP.check ? checkStep : null}
          {stepIndex === STEP.plan ? planStep : null}
          {stepIndex === STEP.install ? installStep : null}
          {stepIndex === STEP.brain ? brainStep : null}
          {stepIndex === STEP.signin ? (
            <SetupSignInPanel
              onContinue={() => goToStep(STEP.ready)}
              onGoToPlan={() => goToStep(STEP.plan)}
              onBack={() => goToStep(previousStep(STEP.signin))}
              onSummary={setSignIn}
            />
          ) : null}
          {stepIndex === STEP.ready ? (
            <SetupReadyPanel
              onGoHome={() => navigateTo("fleet")}
              onOpenSafety={() => navigateTo("safety")}
              onGoToStep={goToStep}
              onOpenAgent={(agentId) => navigateTo("agents", { agent: agentId })}
              onProblems={setReadyProblems}
            />
          ) : null}
        </section>
      </div>

      {confirmGroup ? (
        <SetupModal
          title={`${confirmAction}?`}
          confirmLabel={confirmAction}
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
