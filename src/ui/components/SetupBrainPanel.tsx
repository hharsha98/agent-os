// The "AI brain" step, used by Setup and by each agent's Brain card: pick a
// brain for Hermes and OpenClaw. Two cards side by side (stacked on narrow
// screens): OpenRouter (free to start, one-click connect) and Local (Ollama).
// Each agent can take a different brain; by default both take the same one.
//
// This panel owns the whole trip: choose -> press "Give it to ..." -> the
// configure job runs (progress shown) -> a result per agent from its tiny
// "say hello" check, with a plain fix line when one fails.
//
// No API key is ever held here for the one-click path -- only a flow id. The
// "use an existing key" path keeps the pasted key in the OpenRouter card's
// state until it is sent once.
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import BrainLocalCard from "./BrainLocalCard";
import BrainModelActions from "./BrainModelActions";
import BrainOpenRouterCard, { type OpenRouterGive } from "./BrainOpenRouterCard";
import SetupInstallPanel from "./SetupInstallPanel";
import StatusMark from "./StatusMark";
import { useAgentModels } from "./useAgentModels";
import { useInterval } from "./useInterval";
import type { BrainAgentId, BrainOptionsResponse, BrainTarget, SetupJob } from "../../setupApi";
import { cancelSetupJob, friendlyError, getSetupJob, postConfigure, recallJobId, rememberJobId } from "../../setupApi";
import { CONFIGURE_STEP_LABEL, type BrainAgentLine } from "../brainShared";
import "../brain.css";

export type { BrainAgentLine } from "../brainShared";

type Kind = "openrouter" | "local";
export type BrainPanelStatus = "idle" | "running" | "failed" | "succeeded";

export default function SetupBrainPanel({
  brain,
  agents,
  onChanged,
  onStatus,
  onContinue,
  continueLabel = "Continue",
  initialAgents,
  showModelActions = true
}: {
  brain: BrainOptionsResponse;
  agents: BrainAgentLine[];
  // A brain was really set: the parent should re-read what the server knows.
  onChanged: () => void;
  onStatus?: (status: BrainPanelStatus) => void;
  onContinue?: () => void;
  continueLabel?: string;
  // Only these agents start ticked (the Agents page opens this for one agent).
  initialAgents?: BrainAgentId[];
  // "Change model" / "Choose on OpenRouter" buttons; off where the parent already shows them.
  showModelActions?: boolean;
}) {
  // "Choose for me" is ALWAYS OpenRouter: a local model with the 64K working
  // memory agents need is a stretch even for a 24 GB computer. Local is always
  // on offer (each agent can use either), but never ticked for the person.
  const recommendedKind: Kind = "openrouter";

  const [assignment, setAssignment] = useState<Record<BrainAgentId, Kind | null>>(() => {
    const start: Record<BrainAgentId, Kind | null> = { hermes: null, openclaw: null };
    for (const agent of agents) {
      if (!agent.installed) continue;
      const wanted = initialAgents ? initialAgents.includes(agent.id) : brain.defaults[agent.id] === "configure";
      if (wanted) start[agent.id] = recommendedKind;
    }
    return start;
  });
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [pickedNote, setPickedNote] = useState("");
  const [busy, setBusy] = useState<Kind | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Kind, string>>>({});
  const [resetToken, setResetToken] = useState(0);
  const [job, setJob] = useState<SetupJob | null>(null);
  const [actionError, setActionError] = useState("");
  // What each agent uses now, from the agents themselves (shown next to each name below).
  const { models, reload: reloadModels } = useAgentModels(agents);

  // A configure job that is still running on the server survives a reload or
  // a trip to another page: pick it up again instead of starting over.
  useEffect(() => {
    const id = recallJobId("configure");
    if (!id) return;
    let cancelled = false;
    getSetupJob(id)
      .then((found) => {
        if (cancelled) return;
        if (found.status === "running") setJob(found);
        else rememberJobId("configure", null);
      })
      .catch(() => rememberJobId("configure", null));
    return () => {
      cancelled = true;
    };
  }, []);

  useInterval(
    async () => {
      if (!job) return;
      try {
        setJob(await getSetupJob(job.id));
      } catch {
        // transient poll failure; the next tick tries again
      }
    },
    job && job.status === "running" ? 1000 : null
  );

  const status: BrainPanelStatus = !job ? "idle" : job.status === "running" ? "running" : job.status === "succeeded" ? "succeeded" : "failed";
  useEffect(() => {
    onStatus?.(status);
    if (status === "succeeded") {
      onChanged();
      void reloadModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function assignedTo(kind: Kind) {
    return new Set<BrainAgentId>((Object.keys(assignment) as BrainAgentId[]).filter((id) => assignment[id] === kind));
  }

  function toggle(kind: Kind, id: BrainAgentId, checked: boolean) {
    setPickedNote("");
    setAssignment((current) => ({ ...current, [id]: checked ? kind : current[id] === kind ? null : current[id] }));
  }

  function chooseForMe() {
    const needing = agents.filter((a) => a.installed && !a.configured);
    const chosen = needing.length ? needing : agents.filter((a) => a.installed);
    setAssignment((current) => {
      const next = { ...current };
      for (const a of agents) next[a.id] = chosen.some((c) => c.id === a.id) ? recommendedKind : current[a.id];
      return next;
    });
    setPickedNote(
      chosen.length >= 2
        ? "Picked for you: OpenRouter for both agents. You can move either agent to Local."
        : `Picked for you: OpenRouter for ${chosen.map((a) => a.label).join(" and ") || "your agents"}. You can move it to Local.`
    );
  }

  async function give(kind: Kind, payload: OpenRouterGive | { model: string; acceptLocalFit?: boolean }) {
    const targets: Partial<Record<BrainAgentId, BrainTarget>> = {};
    for (const agent of agents) {
      if (agent.installed && assignment[agent.id] === kind) {
        targets[agent.id] = { mode: kind === "openrouter" ? "openrouter" : "ollama", model: payload.model };
      }
    }
    setBusy(kind);
    setErrors({});
    setActionError("");
    try {
      const started = await postConfigure({
        targets,
        keySource: "keySource" in payload ? payload.keySource : undefined,
        apiKey: "apiKey" in payload ? payload.apiKey : undefined,
        acceptOpenClawRisk: Boolean(targets.openclaw) && riskAccepted,
        acceptLocalFit: "acceptLocalFit" in payload && payload.acceptLocalFit === true ? true : undefined
      });
      rememberJobId("configure", started.id);
      setJob(started);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setErrors({ [kind]: `Couldn't apply that: ${friendlyError(error)}` });
      // A used-up or refused connection can't be reused: start the card over.
      if (code === "key_unavailable" || code === "connection_not_ready") setResetToken((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  async function cancelJob() {
    if (!job) return;
    try {
      setJob(await cancelSetupJob(job.id));
    } catch (error) {
      setActionError(friendlyError(error));
    }
  }

  // Back to the two cards. The key is long gone from the server, so a new
  // try means connecting (or pasting) again.
  function backToChoices() {
    rememberJobId("configure", null);
    setJob(null);
    setResetToken((n) => n + 1);
    setErrors({});
    setRiskAccepted(false);
  }

  if (job && job.status === "running") {
    return (
      <div className="os-brain">
        <SetupInstallPanel
          title="Giving your agents a brain"
          job={job}
          stepLabels={CONFIGURE_STEP_LABEL}
          onCancel={() => void cancelJob()}
          onRetry={backToChoices}
          retryLabel="Back to AI brain"
        />
        {actionError ? (
          <p className="os-brain-card__error" role="alert">
            <StatusMark kind="error" /> {actionError}
          </p>
        ) : null}
      </div>
    );
  }

  if (job) {
    return (
      <div className="os-brain">
        <BrainResult job={job} agents={agents} onBack={backToChoices} onContinue={onContinue} continueLabel={continueLabel} />
      </div>
    );
  }

  return (
    <div className="os-brain">
      <div className="os-brain-intro">
        <p>{brain.reason}</p>
        <button type="button" className="os-btn os-btn--secondary" onClick={chooseForMe}>
          Choose for me
        </button>
      </div>
      <p className="os-brain-note" role="status">
        {pickedNote}
      </p>
      {/* The two ways to pick one specific model: in this app, or on OpenRouter's website. */}
      {showModelActions ? (
        <BrainModelActions
          agents={agents}
          models={models}
          initialAgents={initialAgents}
          onChanged={() => {
            onChanged();
            void reloadModels();
          }}
        />
      ) : null}
      {/* Where each agent will get its brain, in one line, built from the ticks below. */}
      <p className="os-brain-summary" aria-label="Where each agent's brain comes from">
        {agents
          .filter((a) => a.installed)
          .map((a, index) => (
            <span key={a.id} className="os-brain-summary__item">
              {index > 0 ? <span className="os-brain-summary__sep"> · </span> : null}
              <strong>{a.label}</strong> →{" "}
              {assignment[a.id] === "openrouter" ? (
                "OpenRouter"
              ) : assignment[a.id] === "local" ? (
                "Local"
              ) : a.configured ? (
                <>
                  keeps <span className="os-mono">{models[a.id]?.model || "its model"}</span>
                </>
              ) : (
                "no brain yet"
              )}
            </span>
          ))}
      </p>

      <div className="os-brain-cards">
        <BrainOpenRouterCard
          agents={agents}
          assigned={assignedTo("openrouter")}
          onToggleAgent={(id, checked) => toggle("openrouter", id, checked)}
          riskAccepted={riskAccepted}
          onRiskChange={setRiskAccepted}
          busy={busy === "openrouter"}
          recommended
          onGive={(payload) => void give("openrouter", payload)}
          error={errors.openrouter}
          resetToken={resetToken}
        />
        <BrainLocalCard
          agents={agents}
          assigned={assignedTo("local")}
          onToggleAgent={(id, checked) => toggle("local", id, checked)}
          riskAccepted={riskAccepted}
          onRiskChange={setRiskAccepted}
          busy={busy === "local"}
          preferredModel={brain.localModel}
          onGive={(payload) => void give("local", payload)}
          error={errors.local}
        />
      </div>
    </div>
  );
}

// ---- the result: one honest line per agent ---------------------------------------

function BrainResult({
  job,
  agents,
  onBack,
  onContinue,
  continueLabel
}: {
  job: SetupJob;
  agents: BrainAgentLine[];
  onBack: () => void;
  onContinue?: () => void;
  continueLabel: string;
}) {
  const scope = (job.scope && job.scope.length ? job.scope : (["hermes", "openclaw"] as BrainAgentId[])).filter((id) =>
    agents.some((a) => a.id === id && a.installed)
  );
  const failedStep = job.steps.find((s) => s.status === "failed");
  const allHello = scope.length > 0 && scope.every((id) => job.health?.[id]?.promptOk);
  const finishedOk = job.status === "succeeded";
  const log = job.steps.flatMap((step) => (step.log || []).map((line) => `[${CONFIGURE_STEP_LABEL[step.id] || step.id}] ${line}`));

  const heading =
    job.status === "cancelled"
      ? "Cancelled. Anything already finished stays as it is."
      : !finishedOk
        ? "That didn't finish."
        : allHello
          ? "All set. Each agent answered."
          : "Set up, but not every agent answered.";

  return (
    <section className="os-panel os-brain-result" aria-labelledby="os-brain-result-title">
      <header className="os-brain-result__head">
        <StatusMark kind={finishedOk && allHello ? "ok" : job.status === "cancelled" ? "warn" : finishedOk ? "warn" : "error"} />
        <h3 id="os-brain-result-title">{heading}</h3>
      </header>

      {job.status === "failed" && failedStep ? (
        <p className="os-brain-card__error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" /> {failedStep.error || "A setup step failed."}
        </p>
      ) : null}

      <ul className="os-brain-result__agents">
        {scope.map((id) => {
          const label = agents.find((a) => a.id === id)?.label || id;
          const target = job.targets?.[id];
          const entry = job.health?.[id];
          return (
            <li key={id} className="os-brain-result__agent">
              <StatusMark
                kind={entry ? (entry.promptOk ? "ok" : "error") : "unknown"}
                label={entry ? (entry.promptOk ? "said hello" : "did not answer") : "not checked"}
              />
              <div>
                <p className="os-brain-result__line">
                  <strong>{label}</strong>
                  {target ? (
                    <span className="os-brain-result__brain">
                      {" "}
                      · {target.mode === "openrouter" ? "OpenRouter" : "Local"} · <span className="os-mono">{target.model}</span>
                    </span>
                  ) : null}
                </p>
                {target?.mode === "ollama" && job.localVariants?.[target.model] ? (
                  <p className="os-brain-result__verdict">
                    Uses its 64K copy <span className="os-mono">{job.localVariants[target.model]}</span> (no extra download).
                  </p>
                ) : null}
                <p className="os-brain-result__verdict">
                  {entry ? (entry.promptOk ? "Said hello ✓" : "Didn't answer ✗") : finishedOk ? "Not checked." : "Not finished."}
                </p>
                {entry && !entry.promptOk ? <p className="os-brain-result__fix">{entry.hint || "Open its run on the Runs page for details."}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>

      {job.steps
        .flatMap((step) => step.warnings || [])
        .map((warning, index) => (
          <p key={index} className="os-brain-card__hint os-brain-result__warning">
            <StatusMark kind="warn" label="note" /> {warning}
          </p>
        ))}

      {!finishedOk && job.targets && Object.values(job.targets).some((t) => t?.mode === "openrouter") ? (
        <p className="os-brain-card__hint">
          For your safety Agent OS forgets the OpenRouter connection when a job ends. To try again, connect OpenRouter again.
        </p>
      ) : null}

      {log.length ? (
        <details className="os-brain-result__log">
          <summary>Show the log</summary>
          <div className="os-mono os-brain-result__log-lines" role="log" aria-label="Setup log" tabIndex={0}>
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="os-brain-result__actions">
        {finishedOk && onContinue ? (
          <button type="button" className="os-btn os-btn--primary" onClick={onContinue}>
            {continueLabel}
          </button>
        ) : null}
        <button type="button" className={`os-btn ${finishedOk && onContinue ? "os-btn--secondary" : "os-btn--primary"}`} onClick={onBack}>
          {finishedOk ? "Change a brain" : "Back to AI brain"}
        </button>
      </div>
    </section>
  );
}
