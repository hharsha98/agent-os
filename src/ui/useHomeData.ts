// Loads what Home shows and keeps it fresh. Runs every 5 s. Agents every 30 s,
// but every 5 s while Agent OS can't be reached, so the page recovers quickly.
// Every request has a time limit, so nothing loads for ever (Review Focus 5).
// After a good load, a failed refresh keeps the last good data (marked stale) and
// Home says it can't reach Agent OS; it never wipes what it already knows.
import { useCallback, useEffect, useMemo, useState } from "react";
import { listAgents, listRuns } from "../api";
import type { BuilderBrains } from "../buildersApi";
import { getAgentModel } from "../setupApi";
import type { AgentSummary, RunMeta, SessionSummary } from "../types";
import { friendlyError } from "./agentsShared";
import { useBuilderBrains } from "./components/useBuilderBrains";
import { useInterval } from "./components/useInterval";
import {
  agentsPollMs,
  failedLoad,
  HOME_RUNS_LIMIT,
  loaded,
  MODEL_READ_LIMIT_MS,
  sessionsSource,
  withTimeout,
  type ModelLookup,
  type Source
} from "./homeShared";
import { useSessionsList } from "./useSessionsList";

const RUNS_TIMEOUT_MS = 8000;
// /api/agents (and the model lookups) wait on the agents' own help checks. The
// server gives each of those up to 8 s, plus a 5 s version check, so the page
// waits longer than the server does: a slow check must not look like "offline".
const AGENTS_TIMEOUT_MS = 15000;
const BRAINS_TIMEOUT_MS = 8000;

export interface HomeData {
  agents: Source<AgentSummary[]>;
  runs: Source<RunMeta[]>;
  // Hermes and OpenClaw brains: key missing = still loading, "failed" = the lookup
  // failed or timed out (not the same as "not set").
  models: Partial<Record<"hermes" | "openclaw", ModelLookup>>;
  // The coding agents' brains: null until read. `brainsFailed` is true while the
  // last read failed or timed out; Home retries it on its poll.
  brains: BuilderBrains | null;
  brainsFailed: boolean;
  // The shared sessions list (useSessionsList, decision Q30): open and ended agent sessions.
  sessions: Source<SessionSummary[]>;
  // false where sessions do not run (the public demo, a shared server): Home then offers no New session.
  sessionsAvailable: boolean;
  now: number;
}

export function useHomeData(): HomeData {
  const [agents, setAgents] = useState<Source<AgentSummary[]>>({ state: "loading" });
  const [runs, setRuns] = useState<Source<RunMeta[]>>({ state: "loading" });
  const [models, setModels] = useState<HomeData["models"]>({});
  const [now, setNow] = useState(() => Date.now());
  const { brains, failed: brainsFailed, reload: reloadBrains } = useBuilderBrains(BRAINS_TIMEOUT_MS);

  const loadAgents = useCallback(async () => {
    try {
      const { agents: list } = await withTimeout(listAgents(), AGENTS_TIMEOUT_MS);
      setAgents(loaded(list));
      const operators = list.filter((a) => (a.id === "hermes" || a.id === "openclaw") && a.detected.installed);
      // Each answer lands as soon as it arrives. A failed lookup never replaces an
      // answer already known.
      await Promise.all(
        operators.map(async (a) => {
          const id = a.id as "hermes" | "openclaw";
          let lookup: ModelLookup;
          try {
            const info = await withTimeout(getAgentModel(id), MODEL_READ_LIMIT_MS);
            // An agent that could not be asked is a failed lookup, not an empty answer.
            lookup = info.known === false ? { state: "failed" } : { state: "ok", info };
          } catch {
            lookup = { state: "failed" };
          }
          setModels((prev) => (lookup.state === "failed" && prev[id]?.state === "ok" ? prev : { ...prev, [id]: lookup }));
        })
      );
    } catch (error) {
      setAgents((prev) => failedLoad(prev, friendlyError(error)));
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const { runs: list } = await withTimeout(listRuns({ limit: HOME_RUNS_LIMIT }), RUNS_TIMEOUT_MS);
      setRuns(loaded(list));
    } catch (error) {
      setRuns((prev) => failedLoad(prev, friendlyError(error)));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void loadAgents();
    void loadRuns();
  }, [loadAgents, loadRuns]);
  useInterval(() => {
    void loadRuns();
    if (brainsFailed) void reloadBrains();
  }, 5000);
  useInterval(() => void loadAgents(), agentsPollMs(agents));

  const sessionsList = useSessionsList();
  const sessions = useMemo(() => sessionsSource(sessionsList.source, sessionsList.available), [sessionsList.source, sessionsList.available]);

  return { agents, runs, models, brains, brainsFailed, sessions, sessionsAvailable: sessionsList.available, now };
}
