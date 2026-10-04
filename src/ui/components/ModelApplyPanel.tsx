// The "give it to ..." half of the model picker, shared by the picker's detail
// pane, the "paste a model ID" path and the OpenRouter preset path:
//   pick the targets -> (connect OpenRouter, if a target needs it) -> a confirm
//   when there is something to confirm (a paid model) -> real progress -> one
//   honest line per target.
// It knows nothing about Hermes or OpenClaw: what the targets are, and how a
// model is applied to them, both come in as props (see modelPickerShared.ts).
import { useEffect, useRef, useState } from "react";
import OpenRouterConnectInline from "./OpenRouterConnectInline";
import RelativeTime from "./RelativeTime";
import StatusMark from "./StatusMark";
import { friendlyError } from "../../setupApi";
import type { ApplyFn, ApplySubject, ApplyUpdate, ModelApplyResult, ModelTarget } from "../modelPickerShared";
import "../modelPicker.css";

type Phase = "pick" | "confirm" | "running" | "done";

function names(labels: string[]) {
  return labels.join(" and ");
}

export default function ModelApplyPanel({
  subject,
  targets,
  initialTargets,
  apply,
  flowId,
  onFlowChange,
  applyLabel = (labels) => (labels.length ? `Apply to ${names(labels)}` : "Apply"),
  disabledReason,
  onBusyChange,
  onApplied,
  onPickAnother,
  pickAnotherLabel = "Pick another model"
}: {
  subject: ApplySubject;
  targets: ModelTarget[];
  // Ticked to start with; everything that can be ticked when not given.
  initialTargets?: string[];
  apply: ApplyFn;
  // The OpenRouter connection (a flow id), owned by the parent so it can also
  // use it for the model list.
  flowId: string | null;
  onFlowChange: (flowId: string | null) => void;
  applyLabel?: (targetLabels: string[]) => string;
  // Why Apply can't be pressed yet, when the parent knows (for example "type the preset's name first").
  disabledReason?: string;
  onBusyChange?: (busy: boolean) => void;
  // At least one target really was changed: the parent should read its state again.
  onApplied?: () => void;
  onPickAnother?: () => void;
  pickAnotherLabel?: string;
}) {
  const blockedFor = (target: ModelTarget) => (subject.model && target.blockedFor ? target.blockedFor(subject.model) : null);
  const [ticked, setTicked] = useState<string[]>(() =>
    (initialTargets ?? targets.map((t) => t.id)).filter((id) => targets.some((t) => t.id === id && !t.disabled))
  );
  const [ack, setAck] = useState(false);
  const [phase, setPhase] = useState<Phase>("pick");
  const [updates, setUpdates] = useState<Record<string, ApplyUpdate>>({});
  const [runIds, setRunIds] = useState<string[]>([]);
  const [results, setResults] = useState<ModelApplyResult[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    onBusyChange?.(phase === "running");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase === "confirm") confirmRef.current?.focus();
  }, [phase]);

  // A target that can't take THIS model is never applied to, even if it was ticked.
  const effective = ticked.filter((id) => {
    const target = targets.find((t) => t.id === id);
    return Boolean(target) && !target?.disabled && !blockedFor(target as ModelTarget);
  });
  const effectiveTargets = targets.filter((t) => effective.includes(t.id));
  const needConnection = effectiveTargets.filter((t) => t.needsConnection);
  const needAck = needConnection.filter((t) => t.ackLabel);
  const labels = effectiveTargets.map((t) => t.label);

  const waitingFor = !effective.length
    ? "Tick at least one agent."
    : needConnection.length && !flowId
      ? "Connect OpenRouter first."
      : needAck.length && !ack
        ? "Tick the box above first."
        : disabledReason || "";
  const canApply = !waitingFor;

  function toggle(id: string, checked: boolean) {
    setTicked((current) => (checked ? [...new Set([...current, id])] : current.filter((other) => other !== id)));
  }

  async function run() {
    const ids = effective;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunIds(ids);
    setUpdates({});
    setResults([]);
    setPhase("running");
    let out: ModelApplyResult[];
    try {
      out = await apply({
        subject,
        targetIds: ids,
        flowId: needConnection.length ? flowId : null,
        ack: needAck.length > 0 && ack,
        signal: controller.signal,
        onUpdate: (update) => {
          if (mountedRef.current) setUpdates((current) => ({ ...current, [update.targetId]: update }));
        }
      });
    } catch (error) {
      out = ids.map((id) => ({ targetId: id, ok: false, headline: "Something went wrong.", detail: friendlyError(error) }));
    }
    if (needConnection.length) onFlowChange(null); // the key is forgotten once a job has used it
    if (out.some((result) => result.changed)) onApplied?.();
    if (!mountedRef.current) return;
    setResults(out);
    setPhase("done");
  }

  function onPressApply() {
    if (!canApply) return;
    if (subject.notes.length) setPhase("confirm");
    else void run();
  }

  function tryAgain() {
    setTicked(results.filter((r) => r.ok !== true).map((r) => r.targetId));
    setAck(false);
    setResults([]);
    setPhase("pick");
  }

  const label = (id: string) => targets.find((t) => t.id === id)?.label || id;

  // ---- running: real counts from the server, true elapsed time ----------------------
  if (phase === "running") {
    return (
      <div className="os-mp-apply" aria-live="polite">
        <p className="os-mp-apply__title">
          Giving {subject.title} to {names(runIds.map(label))}
        </p>
        <ul className="os-mp-progress">
          {runIds.map((id) => {
            const update = updates[id];
            const finished = Boolean(update && update.stepsTotal > 0 && update.stepsDone >= update.stepsTotal);
            return (
              <li key={id} className="os-mp-progress__item">
                <StatusMark kind={finished ? "ok" : update ? "live" : "unknown"} pulse={Boolean(update) && !finished} />
                <div>
                  <p className="os-mp-progress__head">
                    <strong>{label(id)}</strong> <span>{finished ? "Finished" : update ? update.stepLabel : "Waiting its turn"}</span>
                  </p>
                  {update && update.stepsTotal > 0 ? (
                    <>
                      <div className="os-mp-meter" role="img" aria-label={`${update.stepsDone} of ${update.stepsTotal} steps done`}>
                        {Array.from({ length: update.stepsTotal }, (_, index) => (
                          <span key={index} className={`os-mp-meter__seg${index < update.stepsDone ? " os-mp-meter__seg--done" : ""}`} />
                        ))}
                      </div>
                      <p className="os-mp-hint">
                        {finished ? (
                          "All steps done"
                        ) : (
                          <>
                            Running · <RelativeTime since={update.startedAt} live /> elapsed
                          </>
                        )}{" "}
                        · {update.stepsDone} of {update.stepsTotal} steps done
                      </p>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="os-mp-row-actions">
          <button type="button" className="os-btn os-btn--ghost" onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ---- done: one honest line per target ---------------------------------------------
  if (phase === "done") {
    const allOk = results.length > 0 && results.every((r) => r.ok === true);
    const anyStopped = results.some((r) => r.ok === null);
    return (
      <div className="os-mp-apply">
        <p className="os-mp-apply__title" role="status">
          {allOk ? "All set." : anyStopped ? "Stopped." : "Not everything worked."}
        </p>
        <ul className="os-mp-results">
          {results.map((result) => {
            const target = targets.find((t) => t.id === result.targetId);
            return (
              <li key={result.targetId} className="os-mp-result">
                <StatusMark
                  kind={result.ok === true ? "ok" : result.ok === false ? "error" : "warn"}
                  label={result.ok === true ? "worked" : result.ok === false ? "did not work" : "stopped"}
                />
                <div>
                  <p className="os-mp-result__head">{result.headline}</p>
                  {result.detail ? <p className="os-mp-hint">{result.detail}</p> : null}
                  {(result.warnings || []).map((warning, index) => (
                    <p key={index} className="os-mp-hint os-mp-hint--warn">
                      <StatusMark kind="warn" label="note" /> {warning}
                    </p>
                  ))}
                  {target?.resultNote && (result.ok === true || result.changed) ? <p className="os-mp-hint">{target.resultNote}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="os-mp-row-actions">
          {results.some((r) => r.ok !== true) ? (
            <button type="button" className="os-btn os-btn--primary" onClick={tryAgain}>
              Try again
            </button>
          ) : null}
          {onPickAnother ? (
            <button
              type="button"
              className={`os-btn ${results.some((r) => r.ok !== true) ? "os-btn--secondary" : "os-btn--primary"}`}
              onClick={onPickAnother}
            >
              {pickAnotherLabel}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  // ---- confirm: only when there is something to say first (a paid model) --------------
  if (phase === "confirm") {
    return (
      <div className="os-mp-apply">
        <div className="os-mp-confirm" role="group" aria-label="Confirm">
          <p className="os-mp-confirm__title">
            Give {subject.title} to {names(labels)}?
          </p>
          {subject.notes.map((note, index) => (
            <p key={index} className="os-mp-hint os-mp-hint--strong">
              {note}
            </p>
          ))}
          <div className="os-mp-row-actions">
            <button type="button" className="os-btn os-btn--primary" onClick={() => void run()} ref={confirmRef}>
              Yes, apply
            </button>
            <button type="button" className="os-btn os-btn--ghost" onClick={() => setPhase("pick")}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- pick -------------------------------------------------------------------------
  return (
    <div className="os-mp-apply">
      <fieldset className="os-mp-targets">
        <legend className="os-micro">Give it to</legend>
        {targets.map((target) => {
          const blocked = blockedFor(target);
          const off = Boolean(target.disabled) || Boolean(blocked);
          return (
            <label key={target.id} className={`os-mp-target${off ? " os-mp-target--off" : ""}`}>
              <input
                type="checkbox"
                name={`os-mp-target-${target.id}`}
                checked={effective.includes(target.id)}
                disabled={off}
                onChange={(event) => toggle(target.id, event.target.checked)}
              />
              <span className="os-mp-target__body">
                <span className="os-mp-target__name">{target.label}</span>
                {target.disabled ? (
                  <span className="os-mp-target__note">{target.reason}</span>
                ) : blocked ? (
                  <span className="os-mp-target__note os-mp-target__note--warn">{blocked}</span>
                ) : target.current ? (
                  <span className="os-mp-target__note">uses {target.current}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>

      {needConnection.length ? (
        <div className="os-mp-connect-block">
          <p className="os-mp-connect-block__title">Connect OpenRouter first</p>
          {needConnection.map((target) => (
            <p key={target.id} className="os-mp-hint">
              {target.connectNote}
            </p>
          ))}
          <OpenRouterConnectInline flowId={flowId} onFlowChange={onFlowChange} />
          {needAck.map((target) => (
            <label key={target.id} className="os-mp-ack">
              <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
              <span>{target.ackLabel}</span>
            </label>
          ))}
        </div>
      ) : null}

      {subject.info ? <p className="os-mp-hint">{subject.info}</p> : null}
      <div className="os-mp-row-actions">
        <button type="button" className="os-btn os-btn--primary os-mp-apply__go" onClick={onPressApply} disabled={!canApply}>
          {applyLabel(labels)}
        </button>
        {!canApply ? <span className="os-mp-hint">{waitingFor}</span> : null}
      </div>
    </div>
  );
}
