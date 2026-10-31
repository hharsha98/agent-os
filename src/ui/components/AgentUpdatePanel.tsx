// The update part of the Agents page's Version block (SP5): Latest, the state word ("Up to date", "Update available",
// "Couldn't check"), when it was checked, "Update" and "Check for updates", and what an update shows while it runs. The
// versions come from the shell's one shared read of GET /api/updates (useUpdates), so the sidebar's dot and this block
// never disagree. With no row for this agent (the checks are off, or have not run yet) it draws nothing: the Installed
// line above it is all there is.
//
// Update asks first (AgentConfirmModal): the agent's own updater and its command, the open sessions of that agent (they keep
// running on their old version, an update never stops one), and for OpenClaw the dry run and its Gateway. After the
// confirm:
//   Claude Code, Codex, Cursor, OpenClaw  a Setup job with one step; its console is the one Setup shows (SetupInstallPanel,
//                                         a log that follows the newest line), read every 1.5 s until the job ends
//   Hermes                                its `update` session's terminal, in place of a log (AgentUpdateTerminal), so the
//                                         person can answer a question Hermes asks
// The job's console has no Cancel (the Setup page's has): stopping an agent's own updater half way is not guaranteed to
// leave it as it was (an npm global update, or OpenClaw, which restarts its Gateway). Retry stays.
// When the update ends the saved answer is read again and the page asks for the installed version again. A running update
// is found again after picking another agent and coming back, a reload, another tab or another device: a job by the id
// kept in sessionStorage (updatesApi.ts), Hermes's session by asking the server for its live `update` session, so a
// question Hermes asks always has its terminal to be answered in. That ask is also made after a 409 update_running.
// After a click the keys go to the new console (the job's log, or Hermes's terminal), not to the page behind it.
//
// Hermes is updated only from an unchanged official copy: when it is not, there is no Update button, and the reasons and
// the four steps for a changed copy take its place. Before the server has checked Hermes's folder there is no Update
// either, and the page says so instead of drawing a changed copy.
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import { getSetupJob, retrySetupJob } from "../../setupApi";
import type { SetupJob } from "../../setupApi";
import { findLiveUpdateSession, recallUpdateRun, rememberUpdateRun, startUpdate } from "../../updatesApi";
import type { UpdateRun } from "../../updatesApi";
import { AGENT_LABEL, friendlyError } from "../agentsShared";
import { openSessions, withTimeout } from "../homeShared";
import { sessionTitle } from "../sessionsShared";
import {
  CURSOR_UNKNOWN_LINE,
  GATEWAY_LINE,
  HERMES_BLOCKED_LINE,
  HERMES_GUIDE_STEPS,
  HERMES_GUIDE_TITLE,
  HERMES_UNCHECKED_LINE,
  HERMES_UPDATE_HEADING,
  checkFoundAnswer,
  dryRunLine,
  hermesBlocked,
  hermesReasonLines,
  hermesUnchecked,
  isCursorUnknown,
  offersUpdate,
  openSessionsLine,
  statusOf,
  stateWord,
  updateCommand,
  updateTitle,
  versionNumber
} from "../updatesShared";
import { useSessionsList } from "../useSessionsList";
import { useUpdates } from "../useUpdates";
import AgentConfirmModal from "./AgentConfirmModal";
import AgentUpdateTerminal from "./AgentUpdateTerminal";
import { TimeAgo } from "./RelativeTime";
import SetupInstallPanel from "./SetupInstallPanel";
import StatusWord from "./StatusWord";
import { useInterval } from "./useInterval";

// How often a running update job is read, and how long one read or action may take.
const JOB_POLL_MS = 1500;
const JOB_READ_LIMIT_MS = 10000;
const JOB_ACTION_LIMIT_MS = 20000;
// After a Hermes update session ends, the server forgets what it detected and checks Hermes again (it looks at the session
// once a second). The page waits a little longer than that before it asks, so it does not get the old answer.
const AFTER_SESSION_MS = 2500;

// An update job's console: the Setup job read until it ends, drawn the way Setup draws it, but without Setup's Cancel
// (no onCancel is passed, so none is drawn). Retry is the job's own. `autoFocus`: right after the person pressed Update, the
// keys go to the log once it is on screen (the Update button behind it is off, so they would fall to the page).
function UpdateJobConsole({
  jobId,
  agentId,
  label,
  autoFocus,
  onSettled
}: {
  jobId: string;
  agentId: string;
  label: string;
  autoFocus: boolean;
  onSettled: () => void;
}) {
  const [job, setJob] = useState<SetupJob | null>(null);
  const [problem, setProblem] = useState("");
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const alive = useRef(true);
  const reading = useRef(false);
  // The console is shown for a job that was running, so the first answer that says otherwise is its end. Told once, and
  // again if a Retry sets the job running and it ends again.
  const running = useRef(true);
  const latest = useRef({ onSettled });
  latest.current = { onSettled };
  const stepId = `${agentId}-update`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function settle() {
    if (!running.current) return;
    running.current = false;
    latest.current.onSettled();
  }

  function take(next: SetupJob) {
    setJob(next);
    setProblem("");
    if (next.status === "running") running.current = true;
    else settle();
  }

  // One read at a time: a slow answer must not pile up behind the next tick.
  async function read() {
    if (reading.current) return;
    reading.current = true;
    try {
      const next = await withTimeout(getSetupJob(jobId), JOB_READ_LIMIT_MS);
      if (alive.current) take(next);
    } catch (error) {
      if (!alive.current) return;
      // A job the server no longer knows is over; any other failure is tried again at the next tick.
      if (error instanceof ApiError && error.status === 404) {
        setGone(true);
        settle();
      }
      setProblem(friendlyError(error));
    } finally {
      reading.current = false;
    }
  }
  const latestRead = useRef(read);
  latestRead.current = read;
  useEffect(() => {
    void latestRead.current();
  }, [jobId]);
  useInterval(read, gone || (job && job.status !== "running") ? null : JOB_POLL_MS);
  // The log region comes with the first answer; the keys go to it once.
  useEffect(() => {
    if (!autoFocus || !job || focused.current) return;
    const log = rootRef.current?.querySelector<HTMLElement>('[role="log"]');
    if (!log) return;
    focused.current = true;
    log.focus();
  }, [autoFocus, job]);

  async function act(call: () => Promise<SetupJob>) {
    setBusy(true);
    try {
      const next = await withTimeout(call(), JOB_ACTION_LIMIT_MS);
      if (alive.current) take(next);
    } catch (error) {
      if (alive.current) setProblem(friendlyError(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="os-agent-update__job" ref={rootRef}>
      {job ? (
        <SetupInstallPanel
          job={job}
          stepLabels={{ [stepId]: `Update ${label}` }}
          commandPreviews={{ [stepId]: updateCommand(agentId) }}
          onRetry={() => void act(() => retrySetupJob(jobId))}
          busy={busy}
        />
      ) : null}
      {problem ? (
        <p className="os-launch__error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export default function AgentUpdatePanel({
  agentId,
  label,
  installedVersion,
  onChanged
}: {
  agentId: string;
  label: string;
  // The installed version the page detected (the Installed line), for the dialog when the checks have none.
  installedVersion: string | null;
  // An update ended: the page asks for the installed version again.
  onChanged: () => void;
}) {
  const updates = useUpdates();
  const sessionsList = useSessionsList();
  // The short name ("Hermes", "Cursor"): the one the server's own sentences use ("Hermes is already updating."), not the
  // long one in the page's heading ("Hermes Agent").
  const name = AGENT_LABEL[agentId] ?? label;
  const status = statusOf(updates.data, agentId);
  const hermes = updates.data?.hermes;
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [checkError, setCheckError] = useState("");
  // The update this panel shows: `fresh` is true right after the person pressed Update (the terminal then takes the keys),
  // `ended` once it finished (its console stays, so the result can be read).
  const [run, setRun] = useState<{ run: UpdateRun; fresh: boolean; ended: boolean } | null>(null);
  const alive = useRef(true);
  const afterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once an update started from the dialog: closing the dialog then does not give the keys back to the Update button
  // (it is off by then), the console takes them.
  const consoleTakesKeys = useRef(false);
  const latest = useRef({ updates, onChanged });
  latest.current = { updates, onChanged };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (afterTimer.current) clearTimeout(afterTimer.current);
    };
  }, []);

  // The shell reads the saved answer once a minute, so what is shown may be a little old (an update in Setup may have ended
  // since): read it again as this agent's block appears. It is the server's memory, no check runs for it.
  useEffect(() => {
    latest.current.updates.reload();
  }, []);

  // Coming back to an agent whose update is running (another agent picked and this one again, a reload, another tab or
  // another device): show its console again.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (agentId === "hermes") {
        // Hermes's update is a session, and the server is the one that knows it is live, whoever started it.
        try {
          const sessionId = await findLiveUpdateSession(agentId);
          if (!cancelled && sessionId) setRun((current) => current ?? { run: { kind: "session", id: sessionId }, fresh: false, ended: false });
        } catch {
          // Agent OS not answering, or sessions not available here: nothing to show.
        }
        return;
      }
      const saved = recallUpdateRun(agentId);
      if (saved?.kind !== "job") return;
      let stillRunning: boolean;
      try {
        stillRunning = (await withTimeout(getSetupJob(saved.id), JOB_READ_LIMIT_MS)).status === "running";
      } catch (error) {
        // Gone (404) means over. Anything else (Agent OS not answering) keeps the memory for the next visit.
        if (!(error instanceof ApiError && error.status === 404)) return;
        stillRunning = false;
      }
      if (cancelled) return;
      if (stillRunning) {
        setRun({ run: saved, fresh: false, ended: false });
      } else {
        rememberUpdateRun(agentId, null);
        latest.current.updates.reload();
        latest.current.onChanged();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // The update ended, however it ended: forget it, read the new answer, ask for the installed version again.
  function finish(afterSession: boolean) {
    rememberUpdateRun(agentId, null);
    setRun((current) => (current ? { ...current, ended: true } : current));
    function refresh() {
      if (!alive.current) return;
      if (afterSession) void latest.current.updates.recheck().catch(() => undefined);
      else latest.current.updates.reload();
      latest.current.onChanged();
    }
    if (afterSession) afterTimer.current = setTimeout(refresh, AFTER_SESSION_MS);
    else refresh();
  }

  async function confirm() {
    setStarting(true);
    setStartError("");
    try {
      const started = await startUpdate(agentId);
      if (started.kind === "job") rememberUpdateRun(agentId, started);
      if (!alive.current) return;
      // The dialog goes and the Update button behind it turns off: the keys go to the new console, not back to that button.
      consoleTakesKeys.current = true;
      setRun({ run: started, fresh: true, ended: false });
      setConfirming(false);
    } catch (error) {
      if (!alive.current) return;
      // Hermes is already updating (409 update_running): its session is live, started by another window, or by this one
      // before the page lost its answer. Show its terminal instead of only saying so.
      if (agentId === "hermes" && error instanceof ApiError && error.message === "update_running") {
        const sessionId = await findLiveUpdateSession(agentId).catch(() => null);
        if (!alive.current) return;
        if (sessionId) {
          consoleTakesKeys.current = true;
          setRun((current) => (current && !current.ended ? current : { run: { kind: "session", id: sessionId }, fresh: true, ended: false }));
          setConfirming(false);
          setStartError("");
          return;
        }
      }
      setStartError(friendlyError(error));
      // What the server decided may differ from what the page showed (Hermes's folder changed since the last check).
      updates.reload();
    } finally {
      if (alive.current) setStarting(false);
    }
  }

  async function checkAgain() {
    setCheckError("");
    try {
      await updates.recheck();
    } catch (error) {
      if (alive.current) setCheckError(friendlyError(error));
    }
  }

  // Nothing to say: no row yet, or an agent the checks found not installed (and no update running).
  if (!run && (!status || status.state === "not-installed")) return null;

  const word = stateWord(agentId, status);
  const found = checkFoundAnswer(status);
  const blocked = hermesBlocked(agentId, status, hermes);
  const unchecked = hermesUnchecked(agentId, status, hermes);
  const reasonLines = hermesReasonLines(hermes?.reasons);
  const running = Boolean(run && !run.ended);
  const checkable = Boolean(status) && status?.state !== "not-installed";
  // The dialog's open sessions: this agent's, from the shared sessions list (an update session is not one of them).
  const knownSessions = sessionsList.source.state === "ok" ? sessionsList.source.data.sessions : [];
  const openHere = openSessions(knownSessions).filter((session) => session.agentId === agentId);
  const oldVersion = status?.installed || versionNumber(installedVersion) || "";

  return (
    <div className="os-agent-update">
      {found && status?.latest ? (
        <p className="os-agent-version__line">
          Latest <span className="os-agent-version__num os-mono">{status.latest}</span>
        </p>
      ) : null}
      {word ? (
        <p className="os-agent-update__status">
          <StatusWord state={word.tone} label={word.label} />
          {found && status ? (
            <span className="os-agent-update__checked">
              Checked <TimeAgo since={status.checkedAt} />.
            </span>
          ) : null}
        </p>
      ) : isCursorUnknown(agentId, status) ? (
        <p className="os-agent-update__note">{CURSOR_UNKNOWN_LINE}</p>
      ) : null}

      {unchecked ? (
        <p className="os-agent-update__note">{HERMES_UNCHECKED_LINE}</p>
      ) : blocked ? (
        <div className="os-agent-update__blocked">
          <p className="os-agent-update__note">{HERMES_BLOCKED_LINE}</p>
          {reasonLines.length ? (
            <ul className="os-agent-update__reasons">
              {reasonLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <h4 id="os-agent-update-guide" className="os-agent-update__guide-title">
            {HERMES_GUIDE_TITLE}
          </h4>
          <ol className="os-agent-update__guide" aria-labelledby="os-agent-update-guide">
            {HERMES_GUIDE_STEPS.map((step) => (
              <li key={step.command}>
                {step.text} <code className="os-mono">{step.command}</code>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {offersUpdate(agentId, status, hermes) || checkable ? (
        <div className="os-agent-update__actions">
          {offersUpdate(agentId, status, hermes) ? (
            <button
              type="button"
              className="os-btn os-btn--primary"
              disabled={running || starting}
              onClick={() => {
                setStartError("");
                consoleTakesKeys.current = false;
                setConfirming(true);
              }}
            >
              Update
            </button>
          ) : null}
          {checkable ? (
            <button type="button" className="os-btn os-btn--secondary" disabled={updates.checking} onClick={() => void checkAgain()}>
              Check for updates
            </button>
          ) : null}
        </div>
      ) : null}
      {checkError ? (
        <p className="os-launch__error" role="alert">
          {checkError}
        </p>
      ) : null}

      {run?.run.kind === "job" ? (
        <UpdateJobConsole key={run.run.id} jobId={run.run.id} agentId={agentId} label={name} autoFocus={run.fresh} onSettled={() => finish(false)} />
      ) : run?.run.kind === "session" ? (
        <div className="os-agent-update__session">
          <h4 className="os-agent-update__run-title">{HERMES_UPDATE_HEADING}</h4>
          <AgentUpdateTerminal key={run.run.id} sessionId={run.run.id} label={HERMES_UPDATE_HEADING} autoFocus={run.fresh} onEnded={() => finish(true)} />
        </div>
      ) : null}

      {confirming ? (
        <AgentConfirmModal
          title={updateTitle(name)}
          confirmLabel="Update"
          busy={starting}
          giveFocusBack={() => !consoleTakesKeys.current}
          onConfirm={() => void confirm()}
          onClose={() => {
            if (starting) return;
            setConfirming(false);
            setStartError("");
          }}
        >
          <div className="os-agent-update__dialog">
            <p>
              Runs {name}&apos;s own updater: <code className="os-mono">{updateCommand(agentId)}</code>.
            </p>
            {openHere.length && oldVersion ? (
              <>
                <p>{openSessionsLine(oldVersion)}</p>
                <ul className="os-agent-update__sessions">
                  {openHere.map((session) => (
                    <li key={session.id}>{sessionTitle(session, { branch: false })}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {agentId === "openclaw" && status?.installed && status.latest ? <p>{dryRunLine(status.installed, status.latest)}</p> : null}
            {agentId === "openclaw" && status?.restartsGateway ? <p>{GATEWAY_LINE}</p> : null}
            {startError ? (
              <p className="os-launch__error" role="alert">
                {startError}
              </p>
            ) : null}
          </div>
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
