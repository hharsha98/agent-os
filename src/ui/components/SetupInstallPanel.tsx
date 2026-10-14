// The live-progress body shared by Install ("Update coding agents", "Set up
// Hermes + OpenClaw") and AI brain's Apply. Both start a SetupJob and this renders
// it the same way: a segmented meter over the job's real steps (never a timer
// bar), true elapsed time for the running step, a collapsible log that follows the
// newest line, and the failure, cancel and retry messages. It draws no panel of its
// own: the Setup step panel (or the Brain card) around it is the box.
import { useEffect, useId, useRef, useState } from "react";
import { Activity, ChevronDown, ChevronUp, Circle, CircleAlert, CircleCheck, Terminal } from "lucide-react";
import Banner from "./Banner";
import RelativeTime from "./RelativeTime";
import SetupCommand from "./SetupCommand";
import SetupModal from "./SetupModal";
import SetupStatus, { type SetupTone } from "./SetupStatus";
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

type ShownStatus = "succeeded" | "failed" | "running" | "pending";

const SPOKEN: Record<ShownStatus, string> = { succeeded: "Done. ", failed: "Failed. ", running: "Running. ", pending: "Waiting. " };

function StepIcon({ status }: { status: ShownStatus }) {
  if (status === "succeeded") return <CircleCheck className="os-setup-job__icon os-setup-job__icon--ok" size={17} aria-hidden="true" />;
  if (status === "failed") return <CircleAlert className="os-setup-job__icon os-setup-job__icon--bad" size={17} aria-hidden="true" />;
  if (status === "running") return <Activity className="os-setup-job__icon os-setup-job__icon--live" size={17} aria-hidden="true" />;
  return <Circle className="os-setup-job__icon os-setup-job__icon--wait" size={17} aria-hidden="true" />;
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
  title?: string;
  job: SetupJob;
  stepLabels: Record<string, string>;
  commandPreviews?: Record<string, string | null | undefined>;
  onCancel: () => void;
  onRetry: () => void;
  retryLabel?: string;
  busy?: boolean;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [followLog, setFollowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const logId = useId();
  const firstSeenRunning = useRef<Record<string, number>>({});

  // Cancelling kills the running installer, so the server marks that step
  // "failed" (or leaves it "running"). That is the person's own cancel, not a
  // failure: show the step as not finished, and never as running once the job
  // itself has stopped.
  const stepStatus = (step: SetupJobStep): ShownStatus => {
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
    runningIndex > 0 ? lastLogTime(job.steps[runningIndex - 1]) || job.startedAt : runningStep ? job.startedAt : null;

  const entries = job.steps.flatMap((step) => (step.log || []).map((line) => ({ tag: stepLabels[step.id] || step.id, line })));

  // Follow the newest line, also when the log is opened again after being hidden.
  useEffect(() => {
    if (followLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [entries.length, followLog, logCollapsed]);

  const failedStep = job.status === "failed" ? job.steps.find((s) => s.status === "failed") : undefined;
  const failedPreview = failedStep ? commandPreviews?.[failedStep.id] : null;

  function onLogScroll() {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowLog(atBottom);
  }

  const done = job.steps.filter((s) => s.status === "succeeded").length;
  const tone: SetupTone = job.status === "succeeded" ? "ok" : job.status === "failed" ? "error" : job.status === "cancelled" ? "warn" : "live";
  const word = job.status === "running" ? "In progress" : job.status === "succeeded" ? "Done" : job.status === "failed" ? "Failed" : "Cancelled";

  return (
    <div className="os-setup-job">
      {title ? <h3 className="os-setup-job__title">{title}</h3> : null}
      <div className="os-setup-job__top">
        <SetupStatus tone={tone}>{word}</SetupStatus>
        <span className="os-setup-job__count">
          <span className="os-mono">{done}</span> of <span className="os-mono">{job.steps.length}</span> steps completed
        </span>
      </div>

      {/* One segment per real step the server reported; filled only once that
          step has actually succeeded. The running step is outlined. */}
      <div className="os-setup-job__meter" role="img" aria-label={`${done} of ${job.steps.length} steps completed`}>
        {job.steps.map((step) => (
          <span key={step.id} className={`os-setup-job__seg os-setup-job__seg--${stepStatus(step)}`} />
        ))}
      </div>

      <ul className="os-setup-job__steps">
        {job.steps.map((step) => {
          const status = stepStatus(step);
          const stages = status === "running" ? finishedStages(step) : 0;
          return (
            <li key={step.id} className={status === "pending" ? "is-wait" : undefined}>
              <StepIcon status={status} />
              <span>
                <span className="os-visually-hidden">{SPOKEN[status]}</span>
                {stepLabels[step.id] || step.id}
              </span>
              {status === "running" ? (
                <span className="os-setup-job__elapsed">
                  Running · <RelativeTime since={runningSince || firstSeenRunning.current[step.id]} live /> elapsed
                  {stages ? ` · ${stages} installer ${stages === 1 ? "stage" : "stages"} done` : ""}
                </span>
              ) : status === "pending" ? (
                <span className="os-setup-job__elapsed">{job.status === "running" ? "Waiting" : "Not run"}</span>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>

      {failedStep ? (
        <>
          <Banner
            tone="danger"
            title="This step failed"
            actions={
              <button type="button" className="os-btn os-btn--primary" onClick={onRetry} disabled={busy}>
                {retryLabel}
              </button>
            }
          >
            {failedStep.error || "Setup step failed."}
          </Banner>
          {failedPreview ? (
            <div className="os-setup-job__manual">
              <p>Or run it yourself in your own terminal:</p>
              <SetupCommand command={failedPreview} label="Copy the command to run it yourself" />
            </div>
          ) : null}
        </>
      ) : null}

      {job.status === "cancelled" ? (
        <Banner
          tone="info"
          title="Setup was cancelled"
          actions={
            <button type="button" className="os-btn os-btn--primary" onClick={onRetry} disabled={busy}>
              {retryLabel}
            </button>
          }
        >
          Anything already finished stays as it is.
        </Banner>
      ) : null}

      <div className="os-setup-job__logbar">
        <button
          type="button"
          className="os-btn os-btn--ghost os-setup-job__logtoggle"
          onClick={() => setLogCollapsed((v) => !v)}
          aria-expanded={!logCollapsed}
          aria-controls={logId}
        >
          {logCollapsed ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
          {logCollapsed ? "Show log" : "Hide log"}
        </button>
        {job.status === "running" ? (
          <button type="button" className="os-btn os-btn--danger" onClick={() => setConfirmingCancel(true)}>
            Cancel
          </button>
        ) : null}
      </div>

      {!logCollapsed ? (
        <>
          <div className="os-setup-log">
            <div id={logId} className="os-mono os-setup-log__lines" ref={logRef} onScroll={onLogScroll} tabIndex={0} role="log" aria-label="Setup log">
              {entries.length ? (
                entries.map((entry, i) => (
                  <div key={i} className="os-setup-log__line">
                    <span className="os-setup-log__tag">[{entry.tag}]</span> {entry.line}
                  </div>
                ))
              ) : (
                <div className="os-setup-log__line">{job.status === "running" ? "Waiting for output…" : "No output was recorded."}</div>
              )}
            </div>
            {!followLog ? (
              <button
                type="button"
                className="os-btn os-btn--secondary os-setup-log__jump"
                onClick={() => {
                  setFollowLog(true);
                  if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
                }}
              >
                Jump to latest
              </button>
            ) : null}
          </div>
          <p className="os-setup-job__caption">
            <Terminal size={15} aria-hidden="true" />
            <span>Agent OS's own setup log, one line per thing it did.</span>
          </p>
        </>
      ) : null}

      {confirmingCancel ? (
        <SetupModal
          title="Cancel setup?"
          confirmLabel="Cancel setup"
          confirmTone="danger"
          cancelLabel="Keep going"
          onConfirm={() => {
            setConfirmingCancel(false);
            onCancel();
          }}
          onClose={() => setConfirmingCancel(false)}
        >
          <p>This stops the current step. Anything already installed stays installed.</p>
        </SetupModal>
      ) : null}
    </div>
  );
}
