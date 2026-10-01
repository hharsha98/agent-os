// The Setup Assistant's step rail: Check -> Plan -> Install -> AI brain ->
// Ready. Each node's shape+colour is a real state (done/current/not-reached/
// failed), never decoration -- the rail always reflects server truth, not a
// wizard's internal "page number".
export type SetupStepState = "done" | "current" | "not-reached" | "failed";

export interface SetupStepDef {
  key: string;
  label: string;
  state: SetupStepState;
}

function StepMark({ state }: { state: SetupStepState }) {
  if (state === "done") {
    return (
      <span className="os-setup-step__mark os-setup-step__mark--done" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="7" />
          <path d="M4.5 8.2 L7 10.7 L11.5 5.6" fill="none" stroke="var(--os-accent-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="os-setup-step__mark os-setup-step__mark--failed" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
        </svg>
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="os-setup-step__mark os-setup-step__mark--current" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="7" />
        </svg>
      </span>
    );
  }
  return (
    <span className="os-setup-step__mark os-setup-step__mark--not-reached" aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.4" />
      </svg>
    </span>
  );
}

export default function SetupStepper({
  steps,
  onSelect
}: {
  steps: SetupStepDef[];
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="os-setup-stepper" role="list">
      {steps.map((step, index) => {
        const clickable = step.state === "done" || step.state === "current" || step.state === "failed";
        return (
          <li key={step.key} className={`os-setup-step os-setup-step--${step.state}`}>
            <button
              type="button"
              className="os-setup-step__btn"
              onClick={() => clickable && onSelect(index)}
              disabled={!clickable}
              aria-current={step.state === "current" ? "step" : undefined}
            >
              <StepMark state={step.state} />
              <span className="os-setup-step__label">{step.label}</span>
            </button>
            {index < steps.length - 1 ? <span className="os-setup-step__rail" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
