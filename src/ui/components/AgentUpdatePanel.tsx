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
// When the update ends the saved answer is read again (the server checks the agent itself; the page starts no check of its
// own) and the page asks for the installed version again. A running update
// is found again after picking another agent and coming back, a reload, another tab or another device: a job by the id
// kept in sessionStorage (updatesApi.ts), Hermes's session by asking the server for its live `update` session, so a
// question Hermes asks always has its terminal to be answered in. That ask is also made after a 409 update_running.
// After a click the keys go to the new console (the job's log, or Hermes's terminal), not to the page behind it.
//
// An update never stops an open session, so a session of this agent that runs on another version than the installed one gets a
// banner here (RestartBanner): "Restart session to use v<installed>", where <installed> is the version detected now (the Installed
// line's own; the saved check is up to a day old and only the fallback). Its button asks first (AgentConfirmModal), then the server
// stops the session and resumes it in the same tab (restartSession); the confirm carries Resume's fallback warning for an agent
// that resumes "the most recent conversation in this folder", and the button is off while this agent's update runs (the server
// refuses a restart then too). Both versions are compared by their first dotted number, and
// a session whose version is not known gets no banner. A restart that did not work keeps its sentence: inside the banner while
// the session still runs, on its own once the session has ended (the Sessions page shows the same sentence on the ended session).
//
// Hermes is updated only from an unchanged official copy: when it is not, there is no Update button, and the reasons and
// the four steps for a changed copy take its place. Before the server has checked Hermes's folder there is no Update
// either, and the page says so instead of drawing a changed copy.
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import { restartSession, sessionProblem } from "../../sessionsApi";
import { getSetupJob, retrySetupJob } from "../../setupApi";
import type { SetupJob } from "../../setupApi";
import type { SessionSummary } from "../../types";
import { findLiveUpdateSession, recallUpdateRun, rememberUpdateRun, startUpdate } from "../../updatesApi";
import type { UpdateRun } from "../../updatesApi";
import { AGENT_LABEL, friendlyError } from "../agentsShared";
import { openSessions, withTimeout } from "../homeShared";
import { resumeConfirmCopy, sessionTitle } from "../sessionsShared";
import {
  AFTER_SESSION_MS,
  CURSOR_UNKNOWN_LINE,
  GATEWAY_LINE,
  HERMES_BLOCKED_LINE,
  HERMES_GUIDE_STEPS,
  HERMES_GUIDE_TITLE,
  HERMES_UNCHECKED_LINE,
  RESTART_LABEL,
  RESTART_NOT_NOW,
  checkFoundAnswer,
  dryRunLine,
  hermesBlocked,
  hermesReasonLines,
  hermesUnchecked,
  hermesUpdateHeading,
  installedVersionNumber,
  isCursorUnknown,
  offersUpdate,
  openSessionsLine,
  restartDialogBody,
  restartDialogTitle,
  sessionsToRestart,
  statusOf,
  stateWord,
  updateCommand,
  updateTitle
} from "../updatesShared";
import { useSessionsList } from "../useSessionsList";
import { useUpdates } from "../useUpdates";
import AgentConfirmModal from "./AgentConfirmModal";
import AgentUpdateTerminal from "./AgentUpdateTerminal";
import Banner from "./Banner";
import { TimeAgo } from "./RelativeTime";
import RestartBanner from "./RestartBanner";
import SetupInstallPanel from "./SetupInstallPanel";
import StatusWord from "./StatusWord";
import { useInterval } from "./useInterval";

// How often a running update job is read, and how long one read or action may take.
const JOB_POLL_MS = 1500;
const JOB_READ_LIMIT_MS = 10000;
const JOB_ACTION_LIMIT_MS = 20000;
// How long after a restart the keys are looked after (see restartEndedAt): the sessions list is read again at once, and
// answers well inside this.
const RESTART_FOCUS_MS = 4000;

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
  // The installed version the page detected (the Installed line), for the restart banners when the checks have none.
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
  // This agent's open sessions, from the shared sessions list (an update session is not one of them).
  const knownSessions = sessionsList.source.state === "ok" ? sessionsList.source.data.sessions : [];
  const openHere = openSessions(knownSessions).filter((session) => session.agentId === agentId);
  // The version a restart would start them on (the banners and the restart confirm): the one detected now (the Installed
  // line's own), and only when that cannot be read the saved check's (it is up to a day old). null when neither can be read,
  // and then no session gets a banner. (The Update dialog names no version, R50.)
  const installedNumber = installedVersionNumber(installedVersion, status?.installed);
  const behind = installedNumber ? sessionsToRestart(openHere, installedNumber) : [];
  const behindKey = behind.map((session) => session.id).join(",");
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [checkError, setCheckError] = useState("");
  // The update this panel shows: `fresh` is true right after the person pressed Update (the terminal then takes the keys),
  // `ended` once it finished (its console stays, so the result can be read).
  const [run, setRun] = useState<{ run: UpdateRun; fresh: boolean; ended: boolean } | null>(null);
  // Restart session: the confirm that is open (the session, and the version it would start again on), whether its request
  // runs, and the sentence of each restart that did not work, by session id.
  const [restartAsk, setRestartAsk] = useState<{ session: SessionSummary; newVersion: string } | null>(null);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartFailures, setRestartFailures] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  // When the last restart ended (ms): the button that was pressed can be gone a moment later (the banner left, or became the
  // ended session's sentence), and the keys then go to this block, not to the page behind it.
  const restartEndedAt = useRef(0);
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

  // A restart's sentence belongs to a session that still has its banner (running, on an older version) or that has ended. Once
  // the session runs on the installed version again, was dismissed, or is gone from the list, the sentence is old news and goes.
  // A stale list proves nothing, so this waits for a good one.
  useEffect(() => {
    if (sessionsList.source.state !== "ok" || sessionsList.source.stale) return;
    const listed = sessionsList.source.data.sessions;
    const behindIds = behindKey.split(",");
    setRestartFailures((current) => {
      const ids = Object.keys(current);
      const kept = ids.filter((id) => {
        const session = listed.find((candidate) => candidate.id === id);
        return Boolean(session) && !session?.dismissed && (session?.status === "exited" || behindIds.includes(id));
      });
      return kept.length === ids.length ? current : Object.fromEntries(kept.map((id) => [id, current[id]]));
    });
  }, [sessionsList.source, behindKey]);

  // Just after a restart, if the keys fell to the page (the button that was pressed is gone), they go to this block.
  useEffect(() => {
    if (restartAsk || Date.now() - restartEndedAt.current > RESTART_FOCUS_MS) return;
    const active = document.activeElement;
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true });
  }, [restartAsk, behindKey, restartFailures]);

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
      // The server checks the agent again by itself when an update ends (a job's last step, or the session poll), so this
      // only reads what it found (GET /api/updates). A check of our own (POST /api/updates/refresh) would run the agent's CLI
      // beside the server's.
      latest.current.updates.reload();
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

  // A banner's button: the confirm opens for that session.
  function askRestart(session: SessionSummary) {
    if (installedNumber) setRestartAsk({ session, newVersion: installedNumber });
  }

  // The confirm's button: the server stops the session and resumes it. Either way the sessions list is read again at once: the
  // banner goes (the session runs on the installed version now), or the session ended and its sentence stays. This session's old
  // sentence goes before the new answer.
  async function restart() {
    if (!restartAsk || restartBusy) return;
    const id = restartAsk.session.id;
    setRestartBusy(true);
    setRestartFailures((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      await restartSession(id);
    } catch (error) {
      if (alive.current) setRestartFailures((current) => ({ ...current, [id]: sessionProblem(error) }));
    } finally {
      sessionsList.refresh();
      restartEndedAt.current = Date.now();
      if (alive.current) {
        setRestartBusy(false);
        setRestartAsk(null);
      }
    }
  }

  // A restart that stopped the session and could not resume it leaves it ended: its sentence stays here, on its own, since the
  // banner (and its button) is only for a session that runs.
  const endedFailures = Object.entries(restartFailures).flatMap(([id, text]) => {
    const session = knownSessions.find((candidate) => candidate.id === id);
    return session && session.status === "exited" && !session.dismissed ? [{ session, text }] : [];
  });

  // Nothing to say: no row yet, or an agent the checks found not installed (and no update running, no session to restart, no
  // restart's confirm open: it goes on while the session it is about is stopped and resumed, whatever the list shows meanwhile).
  if (!run && (!status || status.state === "not-installed") && !behind.length && !endedFailures.length && !restartAsk) return null;

  const word = stateWord(agentId, status);
  const found = checkFoundAnswer(status);
  const blocked = hermesBlocked(agentId, status, hermes);
  const unchecked = hermesUnchecked(agentId, status, hermes);
  const reasonLines = hermesReasonLines(hermes?.reasons);
  const running = Boolean(run && !run.ended);
  const checkable = Boolean(status) && status?.state !== "not-installed";
  // Restart session uses Resume's rules (spec, Resume per agent), so its confirm carries Resume's own warning for an agent that
  // can only resume "the most recent conversation in this folder" (Codex, Hermes, Cursor without a chat id): the sentence
  // comes from Resume's confirm (resumeConfirmCopy), and is null for an agent that resumes by id.
  const restartWarning = restartAsk ? resumeConfirmCopy(restartAsk.session).warning : null;

  return (
    // `rootRef` is where the keys go when a restart took their button away: a group named by the Version heading (AgentBay's
    // section title), so a screen reader says where it is.
    <div className="os-agent-update" ref={rootRef} tabIndex={-1} role="group" aria-labelledby="os-agent-version-title">
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
            // The server skips the check of an agent while its update runs, so a click would do nothing: off while this panel's update runs.
            <button type="button" className="os-btn os-btn--secondary" disabled={updates.checking || running} onClick={() => void checkAgain()}>
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

      {behind.length || endedFailures.length ? (
        <div className="os-agent-update__restarts">
          {behind.map((session) => (
            <RestartBanner
              key={session.id}
              session={session}
              newVersion={installedNumber ?? ""}
              failure={restartFailures[session.id] ?? ""}
              busy={restartBusy || running}
              onRestart={() => askRestart(session)}
            />
          ))}
          {endedFailures.map(({ session, text }) => (
            <Banner key={session.id} tone="danger" title={sessionTitle(session)}>
              {text}
            </Banner>
          ))}
        </div>
      ) : null}

      {run?.run.kind === "job" ? (
        <UpdateJobConsole key={run.run.id} jobId={run.run.id} agentId={agentId} label={name} autoFocus={run.fresh} onSettled={() => finish(false)} />
      ) : run?.run.kind === "session" ? (
        <div className="os-agent-update__session">
          <h4 className="os-agent-update__run-title">{hermesUpdateHeading(run.ended)}</h4>
          <AgentUpdateTerminal key={run.run.id} sessionId={run.run.id} label={hermesUpdateHeading(run.ended)} autoFocus={run.fresh} onEnded={() => finish(true)} />
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
            {openHere.length ? (
              <>
                <p>{openSessionsLine(agentId)}</p>
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

      {restartAsk ? (
        <AgentConfirmModal
          title={restartDialogTitle(name, restartAsk.session.folderShown === false ? null : restartAsk.session.folderName || null)}
          confirmLabel={RESTART_LABEL}
          cancelLabel={RESTART_NOT_NOW}
          busy={restartBusy}
          onConfirm={() => void restart()}
          onClose={() => {
            if (!restartBusy) setRestartAsk(null);
          }}
        >
          <p>{restartDialogBody(restartAsk.newVersion)}</p>
          {restartWarning ? <Banner tone="warn">{restartWarning}</Banner> : null}
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
