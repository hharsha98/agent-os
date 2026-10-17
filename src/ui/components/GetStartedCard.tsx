// The "Get started" checklist on Home. Four steps (install, brain, sign in, first
// task), each judged by the server from what is really on this computer, never
// ticked by hand; a fifth (Agent Computer) is shown greyed out. One primary
// button at a time: the first step still to do. When every step is done or
// skipped it turns into a calm summary of what is set up.
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { OnboardingStep, OnboardingStepId } from "../../onboardingApi";
import { getSetupPlan } from "../../setupApi";
import type { SetupPlan } from "../../setupApi";
import { formatSize } from "../setupGroupShared";
import {
  STEP_BUTTON,
  STEP_NOTE,
  STEP_TITLE,
  agentNames,
  exampleAgentId,
  firstRunText,
  openStep
} from "../onboardingShared";
import SegmentMeter from "./SegmentMeter";
import type { MeterSegmentState } from "./SegmentMeter";
import StatusMark from "./StatusMark";
import { useOnboarding } from "./useOnboarding";

// The one line before the install step, from the real plan: how much it downloads
// (only what was measured) and whether a password is asked for.
function installNote(plan: SetupPlan): string {
  const work = plan.steps.filter((step) => step.action === "install" || step.action === "prereq-node");
  if (!work.length) return "";
  const sized = work.filter((step) => typeof step.approxMb === "number");
  const mb = sized.reduce((sum, step) => sum + (step.approxMb || 0), 0);
  let text = sized.length
    ? `Installing downloads ${sized.length === work.length ? "about" : "at least"} ${formatSize(mb)}.`
    : "Installing downloads files. Their size isn't known.";
  if (work.some((step) => step.passwordMoments?.length) || plan.manualSteps.length) {
    text += " You may be asked for a password or to allow developer tools.";
  }
  return text;
}

function StepRow({
  index,
  step,
  current,
  note,
  exampleReady,
  onOpen,
  onSkip,
  onUnskip
}: {
  index: number;
  step: OnboardingStep;
  current: boolean;
  note: string;
  exampleReady: boolean;
  onOpen: () => void;
  onSkip: () => void;
  onUnskip: () => void;
}) {
  const title = STEP_TITLE[step.id];
  const unavailable = step.status === "unavailable";
  const mark = step.status === "done" ? "ok" : "unknown";
  const stateWord = step.status === "done" ? "Done" : step.status === "skipped" ? "Skipped" : unavailable ? "Not available yet" : "To do";
  const blocked = step.id === "first-run" && !exampleReady;

  return (
    <li className={`os-gs-step os-gs-step--${step.status}${current ? " is-current" : ""}`}>
      <span className="os-gs-step__mark">
        <StatusMark kind={mark} label={stateWord} />
      </span>
      <div className="os-gs-step__text">
        <p className="os-gs-step__title">
          <strong>
            {index + 1}. {title}
          </strong>
          {unavailable ? <span className="os-chip os-chip--experimental">Coming in v0.5</span> : null}
          {step.status === "skipped" ? <span className="os-gs-step__state os-micro">Skipped</span> : null}
          {step.status === "done" ? <span className="os-gs-step__state os-micro">Done</span> : null}
        </p>
        {!unavailable ? <p className="os-gs-step__detail">{step.detail}</p> : null}
        {step.status === "todo" && note ? <p className="os-gs-step__note">{note}</p> : null}
        {blocked && step.status === "todo" ? <p className="os-gs-step__note">Install an agent first, then try an example.</p> : null}
      </div>
      <div className="os-gs-step__actions">
        {step.status === "todo" ? (
          <>
            <button
              type="button"
              className={`os-btn ${current ? "os-btn--primary os-gs__primary" : "os-btn--secondary"}`}
              onClick={onOpen}
              disabled={blocked}
            >
              {STEP_BUTTON[step.id]}
            </button>
            <button type="button" className="os-btn os-btn--ghost" onClick={onSkip} aria-label={`Skip: ${title}`}>
              Skip
            </button>
          </>
        ) : null}
        {step.status === "skipped" ? (
          <button type="button" className="os-btn os-btn--ghost" onClick={onUnskip} aria-label={`Undo skip: ${title}`}>
            Undo skip
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default function GetStartedCard() {
  const { enabled, data, saveError, recheck, skip, unskip, setHidden } = useOnboarding();
  const [rechecking, setRechecking] = useState(false);
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  // The finish animation is for a real event only: the checklist going from
  // "still to do" to "done" while this card is on screen.
  const wasIncompleteRef = useRef(false);
  const [fresh, setFresh] = useState(false);
  // Once only one step is left, the card shrinks to a one-line strip so the agents and their brains below it stay on
  // screen. "Show all steps" opens the full list again, and it stays open for as long as this page is.
  const [showAllSteps, setShowAllSteps] = useState(false);

  const installTodo = data?.steps.find((step) => step.id === "install")?.status === "todo";
  useEffect(() => {
    if (!installTodo) return undefined;
    let cancelled = false;
    getSetupPlan("all")
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [installTodo]);

  useEffect(() => {
    if (!data) return;
    if (!data.complete) wasIncompleteRef.current = true;
    else if (wasIncompleteRef.current) {
      wasIncompleteRef.current = false;
      setFresh(true);
    }
  }, [data]);

  if (!enabled || !data || data.hidden) return null;

  async function onRecheck() {
    setRechecking(true);
    try {
      await recheck();
    } finally {
      setRechecking(false);
    }
  }

  const { counts, steps, facts } = data;
  const segments: MeterSegmentState[] = steps.filter((step) => step.status !== "unavailable").map((step) => (step.status === "done" ? "ok" : "unknown"));
  const countText = `${counts.done} of ${counts.total} done${counts.skipped ? ` · ${counts.skipped} skipped` : ""}`;

  if (data.complete) {
    const status = (id: OnboardingStepId) => steps.find((step) => step.id === id)?.status;
    const value = (id: OnboardingStepId, text: string) => (status(id) === "done" ? text || "—" : status(id) === "skipped" ? "Skipped" : "—");
    return (
      <section id="os-get-started" className={`os-panel os-gs os-gs--done${fresh ? " is-fresh" : ""}`} aria-labelledby="os-gs-title" tabIndex={-1}>
        <div className="os-gs__topline" aria-hidden="true" />
        <header className="os-gs__head">
          <div>
            <span className="os-micro">Get started</span>
            <h2 id="os-gs-title">You&apos;re set up</h2>
            <p className="os-gs__count os-mono">{countText}</p>
          </div>
          <button type="button" className="os-btn os-btn--ghost" onClick={() => void onRecheck()} disabled={rechecking}>
            <RefreshCw size={14} /> {rechecking ? "Checking…" : "Re-check"}
          </button>
        </header>
        <dl className="os-gs__summary">
          <div>
            <dt className="os-micro">Agents</dt>
            <dd title={agentNames(facts.installed)}>{value("install", agentNames(facts.installed))}</dd>
          </div>
          <div>
            <dt className="os-micro">Brains</dt>
            <dd title={agentNames(facts.brains)}>{value("brain", agentNames(facts.brains))}</dd>
          </div>
          <div>
            <dt className="os-micro">Signed in</dt>
            <dd title={agentNames(facts.signedIn)}>{value("signin", agentNames(facts.signedIn))}</dd>
          </div>
          <div>
            <dt className="os-micro">First run</dt>
            <dd className="os-mono" title={firstRunText(facts.firstRun)}>
              {value("first-run", firstRunText(facts.firstRun))}
            </dd>
          </div>
        </dl>
        {saveError ? (
          <p className="os-gs__error" role="alert">
            {saveError}
          </p>
        ) : null}
        <div className="os-gs__actions">
          <button type="button" className="os-btn os-btn--primary os-gs__finish-action" onClick={() => void setHidden(true)}>
            Hide checklist
          </button>
        </div>
      </section>
    );
  }

  const currentId = steps.find((step) => step.status === "todo")?.id;
  const exampleReady = exampleAgentId(facts) !== null;
  const noteFor = (id: OnboardingStepId) => (id === "install" ? (plan ? installNote(plan) : "") : STEP_NOTE[id] || "");

  // Three of four done and one still to do: a strip, not the whole card.
  const lastStep = steps.find((step) => step.id === currentId);
  const strip = !showAllSteps && counts.todo === 1 && counts.done >= 3 && lastStep !== undefined && currentId !== undefined;
  if (strip && lastStep && currentId) {
    const blockedFirstRun = currentId === "first-run" && !exampleReady;
    return (
      <section id="os-get-started" className="os-panel os-gs os-gs--strip" aria-labelledby="os-gs-title" tabIndex={-1}>
        <div className="os-gs__topline" aria-hidden="true" />
        <div className="os-gs__strip">
          <div className="os-gs__strip-text">
            <span className="os-micro">Get started</span>
            <h2 id="os-gs-title">One step left: {STEP_TITLE[currentId]}</h2>
            <p className="os-gs__strip-detail">
              <span className="os-gs__count os-mono">{countText}</span>
              <span>{blockedFirstRun ? "Install an agent first, then try an example." : lastStep.detail}</span>
            </p>
          </div>
          <div className="os-gs__head-actions">
            <button type="button" className="os-btn os-btn--primary os-gs__primary" onClick={() => openStep(currentId, facts)} disabled={blockedFirstRun}>
              {STEP_BUTTON[currentId]}
            </button>
            <button type="button" className="os-btn os-btn--ghost" onClick={() => setShowAllSteps(true)}>
              Show all steps
            </button>
            <button type="button" className="os-btn os-btn--ghost" onClick={() => void setHidden(true)}>
              Hide for now
            </button>
          </div>
        </div>
        {saveError ? (
          <p className="os-gs__error" role="alert">
            {saveError}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section id="os-get-started" className="os-panel os-gs" aria-labelledby="os-gs-title" tabIndex={-1}>
      <div className="os-gs__topline" aria-hidden="true" />
      <header className="os-gs__head">
        <div>
          <span className="os-micro">Get started</span>
          <h2 id="os-gs-title">Set up your agents</h2>
          <div className="os-gs__progress">
            <SegmentMeter label={countText} segments={segments} />
            <span className="os-gs__count os-mono">{countText}</span>
          </div>
        </div>
        <div className="os-gs__head-actions">
          <button type="button" className="os-btn os-btn--ghost" onClick={() => void onRecheck()} disabled={rechecking}>
            <RefreshCw size={14} /> {rechecking ? "Checking…" : "Re-check"}
          </button>
          <button type="button" className="os-btn os-btn--ghost" onClick={() => void setHidden(true)}>
            Hide for now
          </button>
        </div>
      </header>
      {saveError ? (
        <p className="os-gs__error" role="alert">
          {saveError}
        </p>
      ) : null}
      <ol className="os-gs__steps">
        {steps.map((step, index) => (
          <StepRow
            key={step.id}
            index={index}
            step={step}
            current={step.id === currentId}
            note={noteFor(step.id)}
            exampleReady={exampleReady}
            onOpen={() => openStep(step.id, facts)}
            onSkip={() => void skip(step.id)}
            onUnskip={() => void unskip(step.id)}
          />
        ))}
      </ol>
    </section>
  );
}
