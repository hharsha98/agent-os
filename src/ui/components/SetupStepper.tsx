// The Setup Assistant's step rail: Check, Plan, Install, AI brain, Sign in, Ready.
// Each step is a mark, a name and one line. A finished step says what it found
// ("Done · 5 agents found") and can be reopened; steps not reached yet are plain
// text. The mark is a shape as well as a colour (ring, dot, check, dashed ring,
// alert) and each step says its state to a screen reader, so the rail always
// reflects what the server knows, never a wizard's page number.
import { Circle, CircleAlert, CircleCheck, CircleDashed } from "lucide-react";

// "partial" = the step was passed with part of its job left ("Not finished · 1 of 2
// have a brain"), or without the page ever seeing its data ("Skipped", "Not checked").
// It is neither a failure nor a finished step, so it has its own mark.
export type SetupStepState = "done" | "current" | "not-reached" | "failed" | "partial";

export interface SetupStepDef {
  key: string;
  label: string;
  // The one line shown until there is something to report: what the step is for.
  line: string;
  // Shown instead of `line` when the step has something to report ("Done · 5 agents found").
  summary?: string;
  state: SetupStepState;
  // True for the step on screen (it can also be "done", e.g. a finished Ready).
  current: boolean;
}

const SPOKEN: Record<SetupStepState, string> = {
  done: "Done. ",
  current: "Current step. ",
  "not-reached": "Not reached yet. ",
  failed: "Needs attention. ",
  partial: "Not finished. "
};

function Mark({ state }: { state: SetupStepState }) {
  if (state === "done") {
    return <CircleCheck className="os-setup-step__mark os-setup-step__mark--done" size={22} aria-hidden="true" />;
  }
  if (state === "failed") {
    return <CircleAlert className="os-setup-step__mark os-setup-step__mark--failed" size={22} aria-hidden="true" />;
  }
  if (state === "partial") {
    return <CircleDashed className="os-setup-step__mark os-setup-step__mark--partial" size={22} aria-hidden="true" />;
  }
  if (state === "current") {
    return (
      <svg
        className="os-setup-step__mark os-setup-step__mark--current"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return <Circle className="os-setup-step__mark os-setup-step__mark--todo" size={22} aria-hidden="true" />;
}

export default function SetupStepper({ steps, onSelect }: { steps: SetupStepDef[]; onSelect: (index: number) => void }) {
  return (
    // role="list" is spoken out: WebKit (the macOS shell's VoiceOver) drops the list meaning of an
    // <ol> once list-style is none, and this rail is one.
    <ol className="os-setup-rail" role="list" aria-label="Setup steps">
      {steps.map((step, index) => {
        // Only a step that was passed (finished, failed or left half done) and is not the one on screen can be reopened.
        const reopen = (step.state === "done" || step.state === "failed" || step.state === "partial") && !step.current;
        const body = (
          <>
            <Mark state={step.state} />
            <span className="os-setup-step__text">
              <span className="os-visually-hidden">{SPOKEN[step.state]}</span>
              <b className="os-setup-step__name">{step.label}</b>
              <span className="os-setup-step__line">{step.summary || step.line}</span>
            </span>
          </>
        );
        return (
          <li key={step.key} className={`os-setup-step os-setup-step--${step.state}${step.current ? " is-current" : ""}`}>
            {reopen ? (
              <button type="button" className="os-setup-step__body" onClick={() => onSelect(index)}>
                {body}
              </button>
            ) : (
              <div className="os-setup-step__body" aria-current={step.current ? "step" : undefined}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
