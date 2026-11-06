// One shared read of GET /api/updates for the whole shell (SP5): the sidebar's update dot and the Agents page's Version
// block read this one answer, so "Check for updates" on the page moves the dot too. The server answers from what its checks
// last found (they run at start and every 24 hours), so a read is cheap: it asks every minute (paused while the window
// is hidden, useInterval), one read at a time with the newest answer winning (latestRead.ts). A read that fails keeps
// the last good answer on screen. Where updates do not exist (the public demo, a shared server answering 404), or the
// checks are off (a plain `npm start`, a test: the list is then empty), `data` has no rows and nothing is shown.
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getUpdates, refreshUpdates } from "../updatesApi";
import type { UpdatesResponse } from "../updatesApi";
import { useInterval } from "./components/useInterval";
import { createLatestRead } from "./latestRead";

export const UPDATES_POLL_MS = 60000;

export interface UpdatesValue {
  // null until the first read answers, and wherever updates do not exist.
  data: UpdatesResponse | null;
  // A "Check for updates" is waiting for its answer.
  checking: boolean;
  // Read the saved answer again now (after an update ended). The same function on every render.
  reload: () => void;
  // Check all five agents again ("Check for updates"): resolves when the answer is on screen, rejects when it could not be had.
  recheck: () => Promise<void>;
}

const OFF: UpdatesValue = { data: null, checking: false, reload: () => undefined, recheck: () => Promise.resolve() };

const UpdatesContext = createContext<UpdatesValue>(OFF);

export function useUpdates(): UpdatesValue {
  return useContext(UpdatesContext);
}

export function UpdatesProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [data, setData] = useState<UpdatesResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [reads] = useState(createLatestRead);
  const rechecking = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    // A "Check for updates" is on its way with a fresher answer: a read now could only land over it.
    if (!enabled || rechecking.current) return;
    void reads.run(
      () => getUpdates(),
      (outcome) => {
        if (outcome.ok && alive.current) setData(outcome.value);
      }
    );
  }, [enabled, reads]);

  useEffect(() => {
    load();
    // A read still waiting when the shell goes away must not update it.
    return () => reads.cancel();
  }, [load, reads]);
  useInterval(load, enabled ? UPDATES_POLL_MS : null);

  const recheck = useCallback(async () => {
    if (!enabled || rechecking.current) return;
    rechecking.current = true;
    setChecking(true);
    // Whatever read is in flight is older than this check.
    reads.cancel();
    try {
      const answer = await refreshUpdates();
      if (alive.current) setData(answer);
    } finally {
      rechecking.current = false;
      if (alive.current) setChecking(false);
    }
  }, [enabled, reads]);

  const value = useMemo<UpdatesValue>(() => (enabled ? { data, checking, reload: load, recheck } : OFF), [enabled, data, checking, load, recheck]);
  return createElement(UpdatesContext.Provider, { value }, children);
}
