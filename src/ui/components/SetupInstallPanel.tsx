// The live-progress screen shared by Install ("Set up everything") and AI
// brain's Apply -- both start a SetupJob and this renders it the same way:
// a segmented meter over the job's real steps (never a timer-driven bar),
// true elapsed time for the running step, a collapsible auto-scrolling log,
// and the failure/cancel/retry affordances.
import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import Panel from "./Panel";
import RelativeTime from "./RelativeTime";
import StatusMark from "./StatusMark";
import SetupModal from "./SetupModal";
import type { SetupJob, SetupJobStep } from "../../setupApi";

// Job log lines look like "2026-10-01T08:43:51.764Z message". Pull the time
// back out so elapsed time survives a reload instead of restarting at 0.
const LOG_TIME = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s/;

function lastLogTime(step: SetupJobStep | undefined) {
  const lines = step?.log || [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = LOG_TIME.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

// Hermes installs report real stages ("stage config: succeeded"); count the
// ones the server has actually logged as finished.
function finishedStages(step: SetupJobStep) {
  return (step.log || []).filter((line) => /\bstage \S+: succeeded/.test(line)).length;
}

export default function SetupInstallPanel({
  title,
  job,
  stepLabels,
  commandPreviews,
  onCancel,
  onRetry,
  retryLabel = "Retry",
  busy
}: {
  title: string;
  job: SetupJob;
  stepLabels: Record<string, string>;
  commandPreviews?: Record<string, string | null | undefined>;
  onCancel: () => void;
  onRetry: () => void;
  retryLabel?: string;
  busy?: boolean;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [copied, setCopied] = useState(false);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [followLog, setFollowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const firstSeenRunning = useRef<Record<string, number>>({});

  // Cancelling kills the running installer, so the server marks that step
  // "failed" (or leaves it "running"). That is the person's own cancel, not a
  // failure: show the step as not finished, and never as running once the job
  // itself has stopped.
  const stepStatus = (step: SetupJobStep) => {
    if (job.status === "cancelled" && (step.status === "running" || step.status === "failed")) return "pending";
    return step.status === "running" && job.status !== "running" ? "pending" : step.status;
  };

  const runningIndex = job.steps.findIndex((s) => stepStatus(s) === "running");
  const runningStep = runningIndex >= 0 ? job.steps[runningIndex] : undefined;
  if (runningStep && !firstSeenRunning.current[runningStep.id]) {
    firstSeenRunning.current[runningStep.id] = Date.now();
  }
  // A step starts when the one before it stopped talking; the first step
  // starts with the job. Both come from the server, so they survive a reload.
  const runningSince =
    runningIndex > 0
      ? lastLogTime(job.steps[runningIndex - 1]) || job.startedAt
      : runningStep
        ? job.startedAt
        : null;

  const allLog = job.steps.flatMap((step) => (step.log || []).map((line) => `[${stepLabels[step.id] || step.id}] ${line}`));

  useEffect(() => {
    if (followLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [allLog.length, followLog]);

  const failedStep = job.status === "failed" ? job.steps.find((s) => s.status === "failed") : undefined;

  function onLogScroll() {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowLog(atBottom);
  }

  async function copyCommand() {
    const preview = failedStep ? commandPreviews?.[failedStep.id] : null;
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied; the command is still visible in the plan.
    }
  }

  const done = job.steps.filter((s) => s.status === "succeeded").length;

  return (
    <Panel className="os-setup-install">
      <header className="os-setup-install__head">
        <h2>{title}</h2>
        <span className="os-setup-install__status">
          <StatusMark
            kind={job.status === "succeeded" ? "ok" : job.status === "failed" ? "error" : job.status === "cancelled" ? "warn" : "live"}
            pulse={job.status === "running"}
          />
          {job.status === "running" ? "In progress" : job.status === "succeeded" ? "Done" : job.status === "failed" ? "Failed" : "Cancelled"}
        </span>
      </header>

      {/* One segment per real step the server reported; filled only once that
          step has actually succeeded. The running step is outlined. */}
      <div className="os-setup-install__meter" role="img" aria-label={`${done} of ${job.steps.length} steps completed`}>
        {job.steps.map((step) => (
          <span key={step.id} className={`os-setup-install__seg os-setup-install__seg--${stepStatus(step)}`} />
        ))}
      </div>
      <p className="os-setup-install__count">
        {done} of {job.steps.length} steps completed
      </p>

      <ul className="os-setup-install__steps">
        {job.steps.map((step) => {
          const status = stepStatus(step);
          const stages = status === "running" ? finishedStages(step) : 0;
          return (
            <li key={step.id} className="os-setup-install__step">
              <StatusMark
                kind={status === "succeeded" ? "ok" : status === "failed" ? "error" : status === "running" ? "live" : "unknown"}
                pulse={status === "running"}
              />
              <span className="os-setup-install__step-label">{stepLabels[step.id] || step.id}</span>
              {status === "running" ? (
                <span className="os-setup-install__step-elapsed">
                  Running · <RelativeTime since={runningSince || firstSeenRunning.current[step.id]} live /> elapsed
                  {stages ? ` · ${stages} installer ${stages === 1 ? "stage" : "stages"} done` : ""}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {failedStep ? (
        <div className="os-setup-install__failure" role="alert">
          <p>{failedStep.error || "Setup step failed."}</p>
          <div className="os-setup-install__failure-actions">
            <button type="button" className="os-btn os-btn--primary" onClick={onRetry} disabled={busy}>
              {retryLabel}
            </button>
            {commandPreviews?.[failedStep.id] ? (
              <button type="button" className="os-btn os-btn--secondary" onClick={copyCommand}>
                <Copy size={14} /> {copied ? "Copied" : "Copy the command to run it yourself"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {job.status === "cancelled" ? (
        <div className="os-setup-install__failure" role="status">
          <p>Setup was cancelled. Anything already finished stays as it is.</p>
          <div className="os-setup-install__failure-actions">
            <button type="button" className="os-btn os-btn--primary" onClick={onRetry} disabled={busy}>
              {retryLabel}
            </button>
          </div>
        </div>
      ) : null}

      <div className="os-setup-install__log">
        <button
          type="button"
          className="os-btn os-btn--ghost os-setup-install__log-toggle"
          onClick={() => setLogCollapsed((v) => !v)}
          aria-expanded={!logCollapsed}
        >
          {logCollapsed ? "Show log" : "Hide log"}
        </button>
        {!logCollapsed ? (
          <div className="os-setup-install__log-body">
            <div className="os-mono os-setup-install__log-lines" ref={logRef} onScroll={onLogScroll} tabIndex={0} role="log" aria-label="Setup log">
              {allLog.length ? allLog.map((line, i) => <div key={i}>{line}</div>) : <div>Waiting for output…</div>}
            </div>
            {!followLog ? (
              <button
                type="button"
                className="os-btn os-btn--secondary os-setup-install__jump"
                onClick={() => {
                  setFollowLog(true);
                  if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
                }}
              >
                Jump to latest
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {job.status === "running" ? (
        <button type="button" className="os-btn os-btn--danger os-setup-install__cancel" onClick={() => setConfirmingCancel(true)}>
          Cancel
        </button>
      ) : null}

      {confirmingCancel ? (
        <SetupModal
          title="Cancel setup?"
          confirmLabel="Cancel setup"
          onConfirm={() => {
            setConfirmingCancel(false);
            onCancel();
          }}
          onClose={() => setConfirmingCancel(false)}
        >
          <p>This stops the current step. Anything already installed stays installed.</p>
        </SetupModal>
      ) : null}
    </Panel>
  );
}
