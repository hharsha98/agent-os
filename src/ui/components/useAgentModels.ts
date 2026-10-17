import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentModelInfo, BrainAgentId } from "../../setupApi";
import { getAgentModel } from "../../setupApi";
import { mergeModelReads, type BrainAgentLine } from "../brainShared";
import { MODEL_READ_LIMIT_MS, withTimeout } from "../homeShared";

// Which model each installed agent uses right now, read from the agents
// themselves. An agent that can't be read is `null` (unknown, never guessed);
// one not asked about yet is simply missing. `reload` reads them again, for
// when a model was just changed; `reload("hermes")` reads that one agent only
// (Hermes's card on window focus), and leaves the other's answer, and any read
// of it still on its way, alone.
export function useAgentModels(agents: BrainAgentLine[]) {
  const [models, setModels] = useState<Partial<Record<BrainAgentId, AgentModelInfo | null>>>({});
  const [loading, setLoading] = useState(true);
  const ids = agents.filter((agent) => agent.installed).map((agent) => agent.id);
  const idsKey = ids.join(",");
  // The newest read of each agent: an older answer for the same agent is dropped. `running` counts reads still on their way.
  const newest = useRef<Partial<Record<BrainAgentId, number>>>({});
  const running = useRef(0);

  const reload = useCallback(
    async (only?: BrainAgentId) => {
      const asked = (idsKey ? (idsKey.split(",") as BrainAgentId[]) : []).filter((id) => only === undefined || id === only);
      const marks = asked.map((id) => (newest.current[id] = (newest.current[id] ?? 0) + 1));
      running.current += 1;
      setLoading(true);
      const entries = await Promise.all(
        // An agent that does not answer in time, or could not be asked (`known: false`), is unknown (null): never "no model".
        asked.map(async (id) => {
          const info = await withTimeout(getAgentModel(id), MODEL_READ_LIMIT_MS).catch(() => null);
          return [id, info && info.known !== false ? info : null] as const;
        })
      );
      running.current -= 1;
      // A newer read of the same agent started meanwhile (or the screen is gone): drop this answer.
      const answers = entries.filter(([id], index) => newest.current[id] === marks[index]);
      setModels((previous) => mergeModelReads(previous, answers, asked, only === undefined));
      if (running.current === 0) setLoading(false);
    },
    [idsKey]
  );

  useEffect(() => {
    void reload();
    return () => {
      // The screen is gone, or the agents changed: no answer still on its way counts.
      for (const id of Object.keys(newest.current) as BrainAgentId[]) newest.current[id] = (newest.current[id] ?? 0) + 1;
    };
  }, [reload]);

  return { models, loading, reload };
}
