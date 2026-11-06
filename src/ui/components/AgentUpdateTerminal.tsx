// The Hermes update's terminal on the Agents page (SP5): the `update` session the server started for `hermes update`,
// shown with the same browser terminal and WebSocket as the Sessions page (SessionTerminal), like the ChatGPT sign-in's
// (PlanSignInTerminal). It is a byte pipe: what the person types goes to Hermes's own updater and nowhere else.
// Unlike the sign-in there is no Close: stopping `hermes update` half way could leave Hermes broken, so the session
// ends only when the updater does (or when the person presses Ctrl+C in it, as in any terminal).
// This panel learns of the end three ways: an exited state frame, the terminal's "ended" connection, and
// GET /api/sessions/:id every 5 s (a 404 means the session is gone). When it ends the terminal stays on screen with its
// last output, so the person can read how the update went, and the panel is told once.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import { getSession } from "../../sessionsApi";
import type { SessionStateFrame } from "../../types";
import { isDesktopApp } from "../desktop";
import { SIGNIN_POLL_MS, asksSessionAtOnce, signInSessionEnded } from "../planBrainsShared";
import { parseTerminalPrefs, TERMINAL_PREFS_KEY, type TerminalPrefs } from "../sessionsPageShared";
import SessionTerminal, { type TerminalConnection } from "./SessionTerminal";
import { useInterval } from "./useInterval";

const PLATFORM = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";

// The terminal's two browser-side settings, as the Sessions page keeps them; the defaults when this browser has none,
// or when its storage is blocked.
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

export default function AgentUpdateTerminal({
  sessionId,
  label,
  autoFocus = false,
  onEnded
}: {
  sessionId: string;
  // The terminal's accessible name.
  label: string;
  // Take the keys at once: only right after the person pressed Update, never when the page finds the session again.
  autoFocus?: boolean;
  // The update session ended, however it ended. Told once. `connected` says whether this terminal ever reached "open" (it had the
  // session's screen) before it learned of the end. A terminal that did keeps its last screen. One that did not (it was shown for a
  // session that had already ended, which the server no longer has a screen for) has nothing to show: the page can drop the run.
  onEnded(connected: boolean): void;
}) {
  const [prefs] = useState(readPrefs);
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState("");
  // The terminal takes the keys once, when it first connects; a later reconnect must not take them again.
  const [takeKeys, setTakeKeys] = useState(autoFocus);
  const alive = useRef(true);
  const told = useRef(false);
  const asking = useRef(false);
  const opened = useRef(false);
  const latest = useRef({ onEnded });
  latest.current = { onEnded };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ended || told.current) return;
    told.current = true;
    latest.current.onEnded(opened.current);
  }, [ended]);

  // Is the session still there? One question at a time: a slow answer must not pile up behind the next tick.
  async function askSession() {
    if (asking.current) return;
    asking.current = true;
    try {
      const summary = await getSession(sessionId);
      if (alive.current && signInSessionEnded(summary, false)) setEnded(true);
    } catch (error) {
      if (alive.current && signInSessionEnded(null, isGone(error))) setEnded(true);
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
  // A session that is gone before the terminal ever connected is refused at the first attach: ask at once instead of
  // waiting for the next tick, so the panel does not stay on "Reconnecting…" for an update that has finished.
  const onConnection = useCallback((connection: TerminalConnection) => {
    if (connection === "ended") setEnded(true);
    else if (connection === "open") {
      opened.current = true;
      // Connected again: what the line said about the time it was not (typed text that was not sent) is out of date.
      setNotice("");
      setTakeKeys(false);
    } else if (asksSessionAtOnce(connection, opened.current)) void latestAsk.current();
  }, []);
  const onNotice = useCallback((text: string) => setNotice(text), []);

  return (
    <div className="os-agent-update__terminal">
      <div className="os-agent-update__term">
        <SessionTerminal
          sessionId={sessionId}
          label={label}
          kittyKeyboard={prefs.kittyKeyboard}
          webgl={prefs.webgl}
          autoFocus={takeKeys}
          ended={ended}
          onState={onState}
          onConnection={onConnection}
          onNotice={onNotice}
        />
      </div>
      <p className="os-agent-update__notice" role="status">
        {notice}
      </p>
    </div>
  );
}
