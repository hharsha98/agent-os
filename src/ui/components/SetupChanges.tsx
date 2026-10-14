// "What this changes on your computer": one entry per agent that the current
// choices would install or update, listing the plan's own `changes` lines, then a
// disclosure with the exact commands. With nothing chosen it says so.
import { useId, useState } from "react";
import { ChevronDown, ChevronUp, CircleCheck, Lock } from "lucide-react";
import SetupCommand from "./SetupCommand";
import type { SetupPlanStep } from "../../setupApi";

export default function SetupChanges({ work, labels }: { work: SetupPlanStep[]; labels: Record<string, string> }) {
  const [showCommands, setShowCommands] = useState(false);
  const commandsId = useId();
  const byAgent = new Map<string, SetupPlanStep[]>();
  for (const step of work) byAgent.set(step.agentId, [...(byAgent.get(step.agentId) || []), step]);
  const withCommand = work.filter((s) => s.commandPreview);

  return (
    <section className="os-setup-changes" aria-label="What this changes on your computer">
      <h3>What this changes on your computer</h3>
      {work.length ? (
        <>
          <ul className="os-setup-changes__list">
            {Array.from(byAgent.entries()).map(([agentId, steps]) => {
              const lines = steps.flatMap((s) => (s.changes.length ? s.changes : [s.description]));
              return (
                <li key={agentId}>
                  <CircleCheck size={16} aria-hidden="true" />
                  <div>
                    <b>{labels[agentId] || agentId}</b>
                    <ul className="os-setup-changes__lines">
                      {lines.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
            <li className="os-setup-changes__keep">
              <Lock size={16} aria-hidden="true" />
              <span>Everything else stays as it is.</span>
            </li>
          </ul>
          {withCommand.length ? (
            <div className="os-setup-changes__disclosure">
              <button
                type="button"
                className="os-btn os-btn--ghost"
                onClick={() => setShowCommands((v) => !v)}
                aria-expanded={showCommands}
                aria-controls={commandsId}
              >
                {showCommands ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                Show exact commands
              </button>
              {showCommands ? (
                <div id={commandsId} className="os-setup-changes__commands">
                  <p className="os-setup-changes__caption">Agent OS runs these after you confirm, as written here.</p>
                  {withCommand.map((step) => (
                    <div key={step.id}>
                      <p className="os-micro">{labels[step.agentId] || step.agentId}</p>
                      {step.action === "prereq-node" ? (
                        <p className="os-setup-changes__plain">{step.commandPreview}</p>
                      ) : (
                        <SetupCommand command={step.commandPreview as string} />
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <ul className="os-setup-changes__list">
            <li className="os-setup-changes__keep">
              <CircleCheck size={16} aria-hidden="true" />
              <span>Nothing. What is installed stays exactly as it is.</span>
            </li>
          </ul>
          <p className="os-setup-changes__hint">You can run Setup again any time.</p>
        </>
      )}
    </section>
  );
}
