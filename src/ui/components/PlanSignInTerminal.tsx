// The ChatGPT sign-in's terminal on OpenClaw's plan card (spec 2026-10-15 section 1): the setup session the server
// started for `openclaw models auth login --provider openai --method siwc`, shown with the same browser terminal and
// WebSocket as the Sessions page (SessionTerminal, Task U2). It is a byte pipe: what the person types goes to
// OpenClaw's own command and nowhere else, and nothing here keeps it. The session ends when the sign-in finishes, or
// when Close stops it (with no question: a sign-in has nothing to lose). This panel learns of the end three ways: an
// exited state frame, the terminal's "ended" connection, and GET /api/sessions/:id every 5 s (a 404 means the
// session is gone, which is how a setup session answers once it ended). Its sentences (a link copied, typing that
// was not sent) show in one line under the terminal.
// Keyboard: the terminal keeps Tab and Shift+Tab while it is connected (Task U2's rule, tabLeavesTerminal), so the
// Close row comes before the terminal and Tab reaches Close first. Inside the terminal, Ctrl+C is the way out: it
// goes to the sign-in program as in any terminal, the program ends, and this panel closes by itself (the card then
// puts the keyboard on the ChatGPT plan heading).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import { getSession, sessionProblem, stopSession } from "../../sessionsApi";
import type { SessionStateFrame } from "../../types";
import { isDesktopApp } from "../desktop";
import { SIGNIN_POLL_MS, SIGNIN_TERMINAL_LABEL } from "../planBrainsShared";
import { parseTerminalPrefs, TERMINAL_PREFS_KEY, type TerminalPrefs } from "../sessionsPageShared";
import SessionTerminal, { type TerminalConnection } from "./SessionTerminal";
import { useInterval } from "./useInterval";

const PLATFORM = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";

// The terminal's two browser-side settings, as the Sessions page keeps them (Task U3); the defaults when this browser
// has none, or when its storage is blocked.
function readPrefs(): TerminalPrefs {
  const platform = { platform: PLATFORM, desktop: isDesktopApp() };
  try {
    return parseTerminalPrefs(window.localStorage.getItem(TERMINAL_PREFS_KEY), platform);
  } catch {
    return parseTerminalPrefs(null, platform);
  }
}

function isGone(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

export default function PlanSignInTerminal({
  sessionId,
  onEnded,
  onClose,
  autoFocus = false
}: {
  sessionId: string;
  // The session ended by itself (the sign-in finished, failed, or Ctrl+C stopped it): the card closes the panel and
  // reads the sign-in again.
  onEnded(): void;
  // Close stopped it (or it was already gone): the card closes the panel and asks once for a live sign-in.
  // `gone` is true when the stop answered 404, so the session was not live: a sign-in still before its spawn answers
  // that too (Task B1a), and the card then stops whichever sign-in it finds running (B1a carry-forward).
  onClose(gone?: boolean): void;
  // Take the keys at once: only right after the person pressed Sign in, never when a page load finds the session again.
  autoFocus?: boolean;
}) {
  const [prefs] = useState(readPrefs);
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState("");
  const [closing, setClosing] = useState(false);
  const alive = useRef(true);
  // The card is told once: either onEnded or onClose, never both.
  const told = useRef(false);
  const asking = useRef(false);
  const latest = useRef({ onEnded, onClose });
  latest.current = { onEnded, onClose };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ended || told.current) return;
    told.current = true;
    latest.current.onEnded();
  }, [ended]);

  // Is the session still there? One question at a time: a slow answer must not pile up behind the next tick.
  async function askSession() {
    if (asking.current) return;
    asking.current = true;
    try {
      const summary = await getSession(sessionId);
      if (alive.current && summary?.status === "exited") setEnded(true);
    } catch (error) {
      if (alive.current && isGone(error)) setEnded(true);
    } finally {
      asking.current = false;
    }
  }
  const latestAsk = useRef(askSession);
  latestAsk.current = askSession;
  useInterval(askSession, ended ? null : SIGNIN_POLL_MS);

  const onState = useCallback((state: SessionStateFrame) => {
    if (state.status === "exited") setEnded(true);
  }, []);
  // A sign-in that ends before any window attaches leaves no trace (its output and exit are dropped, spec section 1),
  // so the first attach is refused. When the terminal has never been open and its first try fails, the session is
  // asked at once instead of at the next 5 s tick: a 404 means the sign-in ended, and the panel closes as for any
  // end, with the card reading the plans again, instead of staying on "Reconnecting…" for a program that is gone.
  const opened = useRef(false);
  const onConnection = useCallback((connection: TerminalConnection) => {
    if (connection === "ended") setEnded(true);
    else if (connection === "open") opened.current = true;
    else if ((connection === "reconnecting" || connection === "lost") && !opened.current) void latestAsk.current();
  }, []);
  const onNotice = useCallback((text: string) => setNotice(text), []);

  async function close() {
    if (closing) return;
    setClosing(true);
    setNotice("");
    let gone = false;
    try {
      await stopSession(sessionId);
    } catch (error) {
      // A session that is already gone counts as closed: the card only ever holds the id of a session that had
      // started (from the 201 or from GET /api/setup/openclaw/signin-terminal), so a 404 here means it ended, and
      // the card asks that GET once more after every Close anyway (and stops what it finds after a 404, because a
      // sign-in still before its spawn answers 404 too). Anything else says why and keeps the panel.
      if (!isGone(error)) {
        if (alive.current) {
          setNotice(sessionProblem(error));
          setClosing(false);
        }
        return;
      }
      gone = true;
    }
    if (!alive.current || told.current) return;
    told.current = true;
    latest.current.onClose(gone);
  }

  // Close first: once the keyboard is inside the connected terminal, Tab and Shift+Tab go to the sign-in program.
  return (
    <div className="os-plan-signin">
      <div className="os-plan-card__row">
        <button type="button" className="os-btn os-btn--secondary" onClick={() => void close()} disabled={closing}>
          Close
        </button>
      </div>
      <div className="os-plan-term">
        <SessionTerminal
          sessionId={sessionId}
          label={SIGNIN_TERMINAL_LABEL}
          kittyKeyboard={prefs.kittyKeyboard}
          webgl={prefs.webgl}
          autoFocus={autoFocus}
          ended={ended}
          onState={onState}
          onConnection={onConnection}
          onNotice={onNotice}
        />
      </div>
      <p className="os-plan-term__notice" role="status">
        {notice}
      </p>
    </div>
  );
}
