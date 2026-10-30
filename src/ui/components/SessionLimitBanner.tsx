// The banner on a held session (spec "SP4 Session extras", Plan ran out, keep going; the prototype's limitBanner() in
// sessions.html): "<agent>'s plan limit was reached. Resets <time>." with "Keep going on OpenRouter" and "Wait for
// reset". Claude Code and Codex only: Cursor, Hermes and OpenClaw are never held. What keeping going would do and cost
// comes from the server (GET /api/sessions/:id/keep-going, continue.js's own options). Keep going first opens the
// confirm dialog (KeepGoingDialog), and only its button asks the server to act. Wait for reset changes only this page:
// the session stays Held, nothing is saved or scheduled, and Agent OS sends nothing (Claude Code's own auto-resume, if
// the person turned it on, still happens inside Claude Code). Drawn inside each pane (renderPane in SessionsPage.tsx),
// for that pane's session.
//
// Fix round 1 (review of Task X10):
// - I1: Keep going on Claude Code is a Stop, then a Resume. The stop makes the session "exited", so it is no longer
//   held while the request is still running. The dialog therefore stays while the request runs, and a Resume that
//   fails after the stop shows the server's own sentence in a banner (focused, kept until the session runs again), so
//   the person sees why the conversation ended and can press Resume as usual.
// - M5: a Codex keep going opens a new pay-per-use session; for that hold the banner then shows that session instead
//   of the button (the server also opens only one per hold).
// - M7: focus never falls to the page: Wait for reset moves it to Show my choices, and a banner that leaves while the
//   keys are on the page gives them to the pane's terminal or the panel's title.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { navigateTo } from "../../nav";
import { getKeepGoing, keepGoing, sessionProblem } from "../../sessionsApi";
import type { KeepGoingInfo, SessionSummary } from "../../types";
import { formatResetTime } from "../builderShared";
import {
  BRAIN_LINK_LABEL,
  KEEP_GOING_LABEL,
  OPTIONS_FAILED,
  OPTIONS_LOADING,
  SHOW_CHOICES_LABEL,
  SHOW_NEW_SESSION_LABEL,
  TRY_AGAIN_LABEL,
  WAIT_FOR_RESET_LABEL,
  keepGoingStaysOnScreen,
  keptGoingTarget,
  limitBannerCopy,
  needsBrainLink,
  openedFor,
  openedSessionLine,
  rememberOpened,
  sessionWaitingText,
  showsLimitBanner,
  waitKey
} from "../keepGoingShared";
import { askToFocusNextSession } from "../newSession";
import { useSessionsList } from "../useSessionsList";
import Banner from "./Banner";
import KeepGoingDialog from "./KeepGoingDialog";
import StatusMark from "./StatusMark";

// Where the keys go when the banner leaves while they are on the page: the pane's terminal, else the panel's title.
function focusPaneOrTitle(pane: HTMLElement | null) {
  const terminal = pane?.querySelector<HTMLElement>("textarea.xterm-helper-textarea");
  if (terminal) terminal.focus({ preventScroll: true });
  else document.querySelector<HTMLElement>('aside[aria-label="Session details"] h2')?.focus({ preventScroll: true });
}

export default function SessionLimitBanner({ session }: { session: SessionSummary }) {
  const shown = showsLimitBanner(session);
  const hold = waitKey(session);
  const { refresh } = useSessionsList();
  const [info, setInfo] = useState<KeepGoingInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [waitingFor, setWaitingFor] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The sentence of a Keep going that failed, kept after the session left "held" (I1).
  const [failure, setFailure] = useState("");
  // The new session this hold already opened (M5).
  const [openedId, setOpenedId] = useState<string | null>(() => openedFor(waitKey(session)));
  const alive = useRef(true);
  const reads = useRef(0);
  // True once Keep going was done: the dialog then does not hand the focus back to a button that is going away.
  const actedOn = useRef(false);
  // True while the Keep going request runs: the hold's reset must not wipe the dialog or its outcome (I1).
  const acting = useRef(false);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const wasShown = useRef(shown);
  const rootRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const waitRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const nextFocus = useRef<"show" | "choices" | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One read per hold. An answer for an earlier session or hold that arrives late is dropped.
  const load = useCallback(async () => {
    const read = ++reads.current;
    setFailed(false);
    try {
      const next = await getKeepGoing(session.id);
      if (alive.current && read === reads.current) setInfo(next);
    } catch {
      if (alive.current && read === reads.current) setFailed(true);
    }
  }, [session.id]);

  useEffect(() => {
    // The stop of a Keep going changes the hold while its request still runs: that request's dialog stays (I1).
    if (acting.current) return;
    setInfo(null);
    setFailed(false);
    setAsking(false);
    setError("");
    setOpenedId(openedFor(hold));
    if (shown) void load();
    else reads.current += 1;
  }, [hold, shown, load]);

  // A failed Keep going explains why the conversation ended until the session runs again, or is another session.
  useEffect(() => {
    setFailure("");
  }, [session.id]);
  useEffect(() => {
    if (session.status !== "exited" && !acting.current) setFailure("");
  }, [session.status]);

  // The pane this banner sits in, for the focus fallback below (the root is gone once the banner leaves).
  useEffect(() => {
    if (rootRef.current) paneRef.current = rootRef.current.closest<HTMLElement>("section[data-session]");
  });

  // The banner left (the plan came back, another window stopped it) while the keys were on the page (M7).
  useEffect(() => {
    const was = wasShown.current;
    wasShown.current = shown;
    if (!was || shown) return;
    const active = document.activeElement;
    if (!active || active === document.body) focusPaneOrTitle(paneRef.current);
  }, [shown]);

  // The failure banner takes the keys when it appears, so they never fall to the page (M7).
  useEffect(() => {
    if (!failure || shown) return;
    const active = document.activeElement;
    if (!active || active === document.body || rootRef.current?.contains(active) || active.closest('[role="dialog"]')) {
      failureRef.current?.focus({ preventScroll: true });
    }
  }, [failure, shown]);

  // Wait for reset takes its own button away: the keys go to the button that took its place (M7).
  useEffect(() => {
    const want = nextFocus.current;
    nextFocus.current = null;
    if (want === "show") showRef.current?.focus();
    else if (want === "choices") (keepRef.current ?? waitRef.current)?.focus();
  }, [waitingFor]);

  if (!keepGoingStaysOnScreen(shown, busy, failure)) return null;

  async function confirm() {
    if (busy || acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    setFailure("");
    try {
      const answer = await keepGoing(session.id);
      if (!alive.current) return;
      actedOn.current = true;
      setAsking(false);
      const target = keptGoingTarget(answer, session.id);
      // Codex: the new session is open for this hold, and the button gives way to it (M5).
      if (answer.result === "opening" && target !== session.id) {
        rememberOpened(hold, target);
        setOpenedId(target);
      }
      // Claude Code resumes in this same tab; Codex's new session opens in its own. Either way its terminal takes the keys.
      askToFocusNextSession();
      navigateTo("sessions", { session: target });
      refresh();
    } catch (err) {
      if (!alive.current) return;
      const message = sessionProblem(err);
      setError(message);
      setFailure(message);
      // Already past "held" (the stop happened, the resume then failed): the banner below says why. Otherwise the
      // dialog keeps the sentence, and the options are read again.
      if (!shownNow.current) setAsking(false);
      else void load();
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const reset = formatResetTime(session.resetAt);
  const copy = limitBannerCopy(session, reset);
  const waiting = waitingFor === hold;
  const actions = waiting ? (
    <button
      ref={showRef}
      type="button"
      className="os-btn os-btn--secondary"
      onClick={() => {
        nextFocus.current = "choices";
        setWaitingFor("");
      }}
    >
      {SHOW_CHOICES_LABEL}
    </button>
  ) : (
    <>
      {openedId !== null ? (
        <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("sessions", { session: openedId })}>
          <ArrowLeftRight size={16} aria-hidden="true" />
          {SHOW_NEW_SESSION_LABEL}
        </button>
      ) : info?.available ? (
        <button
          ref={keepRef}
          type="button"
          className="os-btn os-btn--secondary"
          onClick={() => {
            actedOn.current = false;
            setError("");
            setAsking(true);
          }}
        >
          <ArrowLeftRight size={16} aria-hidden="true" />
          {KEEP_GOING_LABEL}
        </button>
      ) : null}
      <button
        ref={waitRef}
        type="button"
        className="os-btn os-btn--ghost"
        onClick={() => {
          nextFocus.current = "show";
          setAsking(false);
          setWaitingFor(hold);
        }}
      >
        {WAIT_FOR_RESET_LABEL}
      </button>
    </>
  );

  return (
    <div className="os-sess-limit" ref={rootRef}>
      {shown ? (
        <Banner tone="warn" title={copy.title} actions={actions}>
          {waiting ? (
            <p className="os-sess-limit__line">{sessionWaitingText(reset)}</p>
          ) : (
            <>
              {copy.resets ? <p className="os-sess-limit__line">{copy.resets}</p> : null}
              <p className="os-sess-limit__sub">{copy.sub}</p>
              {openedId !== null ? <p className="os-sess-limit__note">{openedSessionLine(session.agentLabel)}</p> : null}
              {openedId === null && info === null && !failed ? <p className="os-sess-limit__note">{OPTIONS_LOADING}</p> : null}
              {openedId === null && failed ? (
                <p className="os-sess-limit__note" role="alert">
                  <StatusMark kind="error" /> {OPTIONS_FAILED}{" "}
                  <button type="button" className="os-sess-limit__link" onClick={() => void load()}>
                    {TRY_AGAIN_LABEL}
                  </button>
                </p>
              ) : null}
              {openedId === null && info && !info.available ? (
                <p className="os-sess-limit__note">
                  <StatusMark kind="unknown" label="note" /> {info.reason}
                  {needsBrainLink(info) ? (
                    <>
                      {" "}
                      <button type="button" className="os-sess-limit__link" onClick={() => navigateTo("agents", { agent: info.agentId })}>
                        {BRAIN_LINK_LABEL}
                      </button>
                    </>
                  ) : null}
                </p>
              ) : null}
            </>
          )}
        </Banner>
      ) : null}
      {failure && !shown ? (
        <div className="os-sess-limit__failure" ref={failureRef} tabIndex={-1}>
          <Banner tone="danger">{failure}</Banner>
        </div>
      ) : null}
      {asking && info?.available && (shown || busy) ? (
        <KeepGoingDialog
          info={info}
          agentLabel={session.agentLabel}
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onClose={() => {
            if (!busy) setAsking(false);
          }}
          giveFocusBack={() => !actedOn.current && shownNow.current}
        />
      ) : null}
    </div>
  );
}
