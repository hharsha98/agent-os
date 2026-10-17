// The notice on a coding agent's run that stopped because its PLAN ran out:
// "Claude Code's plan limit was reached (resets 6:50 pm)", with the ways to carry
// on that Agent OS worked out for this very run (GET /api/runs/:id/continue-options):
//   Claude Code / Codex   Keep going on OpenRouter (~$0.42)
//   Cursor                Keep going with Composer (its own model) · Hand to Claude Code · Hand to Codex
//   everyone              Wait for reset
// In a run's console it is a warning Banner; on a Held strip of the Runs board
// (`compact`) it is a tight block with the first choice, "More choices" and Wait for reset.
// Every price is an estimate of what it costs to START (reading the old
// conversation or the summary); the work after that costs extra, and the
// confirm step says so. Nothing is started, or spent, until the person presses
// the button and confirms. "Wait for reset" only changes this page: nothing is
// saved or scheduled, so nothing carries on by itself.
import { useCallback, useEffect, useState } from "react";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";
import StatusMark from "./StatusMark";
import type { ContinueOption, ContinueOptions } from "../../buildersApi";
import { continueRun, getContinueOptions } from "../../buildersApi";
import { navigateTo } from "../../nav";
import type { RunMeta } from "../../types";
import { AGENT_LABEL } from "../agentsShared";
import { explain, formatResetTime, isBuilderId, usd } from "../builderShared";
import "../builders.css";

// "Keep going on OpenRouter (~$0.42)" / "Keep going with Composer" / "Hand to Claude Code (~$0.01)"
function buttonLabel(run: RunMeta, option: ContinueOption) {
  let text: string;
  if (option.id === "cursor-composer") text = "Keep going with Composer";
  else if (option.agentId === run.agentId) text = "Keep going on OpenRouter";
  else text = `Hand to ${AGENT_LABEL[option.agentId]}`;
  return typeof option.estimateUsd === "number" ? `${text} (~${usd(option.estimateUsd)})` : text;
}

function confirmLabel(run: RunMeta, option: ContinueOption) {
  return option.id === "cursor-composer" || option.agentId === run.agentId ? "Keep going" : "Hand over";
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

export default function RunLimitBanner({ run, compact = false }: { run: RunMeta; compact?: boolean }) {
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
  const shown = compact ? usable.slice(0, 1) : usable;
  const carriedOn = Boolean(run.continuedBy);
  const idle = !carriedOn && !waiting;
  // The promise of a carry-on is only made while one can be picked. Still loading (or the lookup failed):
  // the usual sentence. Loaded and nothing available: the one honest way left.
  const advice =
    info !== null && usable.length === 0
      ? "Wait for your plan to reset, then open this run again to see your choices."
      : "You can carry on now with a pay-per-use model, or wait for your plan.";
  const waitingText = `Waiting for your plan to reset${reset ? ` (about ${reset})` : ""}. This run stays Held and nothing carries on by itself. After the reset, open this run again to see your choices.`;

  const choices = idle ? (
    <>
      {shown.map((option, index) => (
        <button
          key={option.id}
          type="button"
          className={`os-btn ${index === 0 && !compact ? "os-btn--primary" : "os-btn--secondary"}`}
          title={option.label}
          onClick={() => {
            setError("");
            setAsking(option);
          }}
        >
          {buttonLabel(run, option)}
        </button>
      ))}
      {compact && usable.length > 1 ? (
        <button type="button" className="os-btn os-btn--ghost" onClick={() => navigateTo("runs", { run: run.id })}>
          More choices
        </button>
      ) : null}
      <button type="button" className="os-btn os-btn--ghost" onClick={() => setWaiting(true)}>
        Wait for reset
      </button>
    </>
  ) : waiting && !carriedOn ? (
    // This only goes back to the list of choices; it does not carry the run on, so it does not say "Keep going".
    <button type="button" className="os-btn os-btn--secondary" onClick={() => setWaiting(false)}>
      Show my choices
    </button>
  ) : null;

  const messages = (
    <>
      {idle && info === null && !failed ? <p className="os-mp-hint">Working out your options…</p> : null}
      {failed ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> Couldn&apos;t work out the options.{" "}
          <button type="button" className="os-mp-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}
      {idle && info && !info.canContinue && !blocked.length ? (
        <p className="os-mp-hint">
          <StatusMark kind="unknown" label="note" /> {info.unavailableReason || "This run can't be continued."}
        </p>
      ) : null}
      {!compact && idle && info && info.onLimit === "auto" && !info.auto.eligible && info.auto.reason && info.canContinue ? (
        <p className="os-mp-hint">
          <StatusMark kind="unknown" label="note" /> Automatic continuing is on, but Agent OS is asking first: {info.auto.reason}
        </p>
      ) : null}
      {idle && blocked.length > 0 && (!compact || usable.length === 0) ? (
        <ul className="os-runs-limit__blocked">
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
  );

  const modal = asking ? (
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
  ) : null;

  // The strip on the Board: the sentence, the choices, and any reason in one tight block.
  if (compact) {
    return (
      <div className="os-runs-held">
        <p className="os-runs-held__text" role={waiting ? "status" : undefined}>
          {waiting ? waitingText : `${sentence} ${advice}`}
        </p>
        <div className="os-runs-held__actions">{choices}</div>
        <div className="os-runs-held__messages">{messages}</div>
        {modal}
      </div>
    );
  }

  // The console: a warning banner over the transcript.
  return (
    <>
      <Banner tone="warn" title={sentence} actions={choices}>
        {carriedOn ? (
          <>
            This task was carried on in another run.{" "}
            <button type="button" className="os-mp-link" onClick={() => navigateTo("runs", { run: run.continuedBy || "" })}>
              Open it
            </button>
          </>
        ) : waiting ? (
          waitingText
        ) : (
          `Everything it did so far is saved in this run. ${advice}`
        )}
        {messages}
      </Banner>
      {modal}
    </>
  );
}
