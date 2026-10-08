// The banner on a coding agent's run that stopped because its PLAN ran out:
// "Claude Code's plan limit was reached (resets 6:50 pm)", with the ways to carry
// on that Agent OS worked out for this very run (GET /api/runs/:id/continue-options):
//   Claude Code / Codex   Continue on OpenRouter (~$0.42)
//   Cursor                Switch to Composer (its own model) · Hand to Claude Code · Hand to Codex
//   everyone              Wait for reset
// Every price is an estimate of what it costs to START (reading the old
// conversation or the summary); the work after that costs extra, and the
// confirm step says so. Nothing is started, or spent, until the person presses
// the button and confirms.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import AgentConfirmModal from "./AgentConfirmModal";
import StatusMark from "./StatusMark";
import type { ContinueOption, ContinueOptions } from "../../buildersApi";
import { continueRun, getContinueOptions } from "../../buildersApi";
import { navigateTo } from "../../nav";
import type { RunMeta } from "../../types";
import { AGENT_LABEL } from "../agentsShared";
import { explain, formatResetTime, isBuilderId, usd } from "../builderShared";
import "../builders.css";

// "Continue on OpenRouter (~$0.42)" / "Switch to Composer" / "Hand to Claude Code (~$0.01)"
function buttonLabel(run: RunMeta, option: ContinueOption) {
  let text: string;
  if (option.id === "cursor-composer") text = "Switch to Composer";
  else if (option.agentId === run.agentId) text = "Continue on OpenRouter";
  else text = `Hand to ${AGENT_LABEL[option.agentId]}`;
  return typeof option.estimateUsd === "number" ? `${text} (~${usd(option.estimateUsd)})` : text;
}

function confirmLabel(run: RunMeta, option: ContinueOption) {
  if (option.id === "cursor-composer") return "Switch to Composer";
  return option.agentId === run.agentId ? "Continue" : "Hand over";
}

function whatHappens(run: RunMeta, option: ContinueOption) {
  const who = AGENT_LABEL[option.agentId];
  const from = AGENT_LABEL[run.agentId || ""] || "The earlier run";
  const model = option.brain.model ? ` (${option.brain.model})` : "";
  if (option.id === "cursor-composer") {
    return `Cursor starts a new chat on its own Composer model with a short summary of what ${from} did. It stays on your Cursor plan.`;
  }
  if (option.approach === "fork") return `${who} carries on this same conversation, but on OpenRouter${model}, paid per use from your OpenRouter credit.`;
  return `${who} starts a new run on OpenRouter${model}, paid per use from your OpenRouter credit, with a short summary of what ${from} did.`;
}

export default function RunLimitBanner({ run }: { run: RunMeta }) {
  const [info, setInfo] = useState<ContinueOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [asking, setAsking] = useState<ContinueOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setInfo(await getContinueOptions(run.id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [run.id]);

  useEffect(() => {
    setInfo(null);
    setFailed(false);
    setWaiting(false);
    setAsking(null);
    setError("");
    void load();
  }, [run.id, run.continuedBy, load]);

  const label = AGENT_LABEL[run.agentId || ""] || "This agent";
  const reset = formatResetTime(run.limit?.resetsAt);
  const sentence = `${(run.limit?.message || `${label}'s plan limit was reached.`).replace(/\.$/, "")}${reset ? ` (resets ${reset})` : ""}.`;

  async function confirm() {
    if (!asking || !isBuilderId(asking.agentId)) return;
    setBusy(true);
    setError("");
    try {
      const started = await continueRun(run.id, { agentId: asking.agentId, brain: asking.brain });
      setAsking(null);
      navigateTo("runs", { run: started.id });
    } catch (err) {
      setError(explain(err));
      void load();
    } finally {
      setBusy(false);
    }
  }

  const options = info?.options ?? [];
  const usable = options.filter((option) => option.available);
  const blocked = options.filter((option) => !option.available);

  return (
    <section className="os-bb-banner" role="region" aria-label="Plan limit reached">
      <div className="os-bb-banner__head">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <p className="os-bb-banner__title">{sentence}</p>
          {run.continuedBy ? (
            <p className="os-bb-banner__sub">
              This task was carried on in another run.{" "}
              <button type="button" className="os-mp-link" onClick={() => navigateTo("runs", { run: run.continuedBy || "" })}>
                Open it
              </button>
            </p>
          ) : waiting ? (
            <p className="os-bb-banner__sub" role="status">
              {reset ? `Your plan should be back around ${reset}.` : "Your plan will be back when its limit resets."} Start the task again then, or press
              “Show choices” to carry on now.
            </p>
          ) : (
            <p className="os-bb-banner__sub">Everything it did so far is saved in this run. You can carry on now with a pay-per-use model, or wait for your plan.</p>
          )}
        </div>
      </div>

      {!run.continuedBy && !waiting ? (
        <>
          {info === null && !failed ? <p className="os-mp-hint">Working out your options…</p> : null}
          {failed ? (
            <p className="os-mp-error" role="alert">
              <StatusMark kind="error" /> Couldn&apos;t work out the options.{" "}
              <button type="button" className="os-mp-link" onClick={() => void load()}>
                Try again
              </button>
            </p>
          ) : null}
          {info && !info.canContinue ? (
            <p className="os-mp-hint">
              <StatusMark kind="unknown" label="note" /> {info.unavailableReason || "This run can't be continued."}
            </p>
          ) : null}
          {info && info.onLimit === "auto" && !info.auto.eligible && info.auto.reason && info.canContinue ? (
            <p className="os-mp-hint">
              <StatusMark kind="unknown" label="note" /> Automatic continuing is on, but Agent OS is asking first: {info.auto.reason}
            </p>
          ) : null}

          <div className="os-bb-banner__actions">
            {usable.map((option, index) => (
              <button
                key={option.id}
                type="button"
                className={`os-btn ${index === 0 ? "os-btn--primary" : "os-btn--secondary"}`}
                onClick={() => {
                  setError("");
                  setAsking(option);
                }}
                title={option.label}
              >
                {buttonLabel(run, option)}
              </button>
            ))}
            <button type="button" className="os-btn os-btn--ghost" onClick={() => setWaiting(true)}>
              Wait for reset
            </button>
          </div>

          {blocked.length ? (
            <ul className="os-bb-banner__blocked">
              {blocked.map((option) => (
                <li key={option.id}>
                  <StatusMark kind="unknown" label="not available" />
                  <span>
                    <strong>{option.label}:</strong> {option.reason}{" "}
                    <button type="button" className="os-mp-link" onClick={() => navigateTo("agents", { agent: option.agentId })}>
                      Set up {AGENT_LABEL[option.agentId]}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {waiting && !run.continuedBy ? (
        <div className="os-bb-banner__actions">
          <button type="button" className="os-btn os-btn--secondary" onClick={() => setWaiting(false)}>
            Show choices
          </button>
        </div>
      ) : null}

      {asking ? (
        <AgentConfirmModal
          title={`${buttonLabel(run, asking).replace(/ \(~.*\)$/, "")}?`}
          confirmLabel={confirmLabel(run, asking)}
          busy={busy}
          onConfirm={() => void confirm()}
          onClose={() => (busy ? null : setAsking(null))}
        >
          <p>{whatHappens(run, asking)}</p>
          {typeof asking.estimateUsd === "number" ? (
            <p>
              <strong>About {usd(asking.estimateUsd)} just to get started.</strong> {asking.estimateNote}
            </p>
          ) : (
            <p>
              <strong>Agent OS couldn&apos;t estimate the cost.</strong> {asking.estimateNote}
            </p>
          )}
          {asking.warnings.length ? (
            <ul className="os-bb-modal-list">
              {asking.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <p>Nothing starts, and nothing is spent, until you press “{confirmLabel(run, asking)}”.</p>
          {error ? <p className="os-launch__error">{error}</p> : null}
        </AgentConfirmModal>
      ) : null}
    </section>
  );
}
