// One shared read of GET /api/sessions for the whole shell (planning decision Q30): the menu's sessions
// count, Home and the Sessions page all read this one list, so they never disagree for longer than a poll.
// It asks every 5 s (paused while the window is hidden, useInterval, and read again at once when it comes
// back), one read at a time with the newest answer winning (latestRead.ts), and every read has a time limit
// (sessionsApi.ts). After a good read, a failed one keeps the last good list marked stale (homeShared.ts
// Source), so a page can show it under a warn note instead of wiping it. Where sessions do not exist (the
// public demo, the public mode), the server answers 404 not_available and `available` turns false, so a page
// says so instead of "Can't reach Agent OS".
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../api";
import { listSessions, sessionProblem } from "../sessionsApi";
import type { SessionListResponse } from "../types";
import { useInterval } from "./components/useInterval";
import { failedLoad, loaded } from "./homeShared";
import type { Source } from "./homeShared";
import { createLatestRead } from "./latestRead";
import { runningSessionCount } from "./sessionsShared";

export const SESSIONS_POLL_MS = 5000;
const NOT_AVAILABLE = "Sessions are not available here.";

export interface SessionsList {
  source: Source<SessionListResponse>;
  // false where sessions do not exist (the server answered 404 not_available, or the public demo).
  available: boolean;
  // Read again now (after Start, Stop, Resume or Dismiss). The same function on every render; a read still
  // waiting no longer counts.
  refresh: () => void;
}

const OFF: SessionsList = { source: { state: "error", message: NOT_AVAILABLE }, available: false, refresh: () => undefined };

const SessionsListContext = createContext<SessionsList>(OFF);

export function useSessionsList(): SessionsList {
  return useContext(SessionsListContext);
}

// How many agent sessions are running, for the menu. null while that is not known: still loading, or the
// last read failed (a stale number is never shown).
export function useLiveSessionCount(): number | null {
  const { source } = useSessionsList();
  if (source.state !== "ok" || source.stale) return null;
  return runningSessionCount(source.data.sessions);
}

function isNotAvailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.message === "not_available";
}

export function SessionsListProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [source, setSource] = useState<Source<SessionListResponse>>({ state: "loading" });
  const [available, setAvailable] = useState(true);
  const [reads] = useState(createLatestRead);

  const load = useCallback(
    (fresh: boolean) => {
      if (!enabled) return;
      if (fresh) reads.cancel();
      void reads.run(
        () => listSessions(),
        (outcome) => {
          if (outcome.ok) {
            setAvailable(true);
            setSource(loaded(outcome.value));
            return;
          }
          if (isNotAvailable(outcome.error)) {
            setAvailable(false);
            setSource({ state: "error", message: NOT_AVAILABLE });
            return;
          }
          setSource((prev) => failedLoad(prev, sessionProblem(outcome.error)));
        }
      );
    },
    [enabled, reads]
  );

  useEffect(() => {
    load(true);
    // A read still waiting when the shell goes away must not update it.
    return () => reads.cancel();
  }, [load, reads]);
  useInterval(() => load(false), enabled ? SESSIONS_POLL_MS : null);
  // Polling pauses while the window is hidden (useInterval), so what the menu shows may be hours old when it
  // comes back (the desktop window hides on close): read again at once, not at the next poll.
  useEffect(() => {
    if (!enabled) return undefined;
    function onVisibility() {
      if (!document.hidden) load(true);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, load]);

  const refresh = useCallback(() => load(true), [load]);
  const value = useMemo<SessionsList>(() => (enabled ? { source, available, refresh } : OFF), [enabled, source, available, refresh]);
  return createElement(SessionsListContext.Provider, { value }, children);
}
