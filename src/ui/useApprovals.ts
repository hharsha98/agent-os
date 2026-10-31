// OpenClaw's pending approvals (Task X3's GET /api/sessions/approvals) for the Safety page and an open OpenClaw session's
// panel: read every 3 s while `active` (paused while the window is hidden, useInterval), one read at a time with the
// newest answer winning (latestRead.ts), each with a time limit (sessionsApi.ts). After a good read a failed one keeps
// the last list marked stale. When `active` turns true again the source starts over as loading, so a panel never shows the
// cards of an earlier moment while the first read is on its way. Where sessions do not run (404 not_available) nothing can be pending, so the answer is an
// empty list, which is true. The server itself asks OpenClaw every 3 s, so a card shows at most about 6 s after OpenClaw
// asks.
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { listApprovals, sessionProblem } from "../sessionsApi";
import type { ApprovalListResponse } from "../types";
import { useInterval } from "./components/useInterval";
import { failedLoad, loaded } from "./homeShared";
import type { Source } from "./homeShared";
import { createLatestRead } from "./latestRead";

export const APPROVALS_POLL_MS = 3000;
const NONE: ApprovalListResponse = { approvals: [], error: null };

export interface ApprovalsRead {
  source: Source<ApprovalListResponse>;
  // Read again now (after an answer was sent). The same function on every render while `active` stays the same.
  refresh: () => void;
}

export function useApprovals(active: boolean): ApprovalsRead {
  const [source, setSource] = useState<Source<ApprovalListResponse>>({ state: "loading" });
  const [reads] = useState(createLatestRead);
  const load = useCallback(
    (fresh: boolean) => {
      if (!active) return;
      if (fresh) reads.cancel();
      void reads.run(
        () => listApprovals(),
        (outcome) => {
          if (outcome.ok) {
            setSource(loaded(outcome.value));
            return;
          }
          if (outcome.error instanceof ApiError && outcome.error.status === 404 && outcome.error.message === "not_available") {
            setSource(loaded(NONE));
            return;
          }
          setSource((prev) => failedLoad(prev, sessionProblem(outcome.error)));
        }
      );
    },
    [active, reads]
  );
  useEffect(() => {
    // Becoming active (a panel opened on an OpenClaw session): whatever was read before is out of date.
    if (active) setSource((prev) => (prev.state === "loading" ? prev : { state: "loading" }));
    load(true);
    // A read still waiting when the page goes away must not update it.
    return () => reads.cancel();
  }, [active, load, reads]);
  useInterval(() => load(false), active ? APPROVALS_POLL_MS : null);
  const refresh = useCallback(() => load(true), [load]);
  return { source, refresh };
}
