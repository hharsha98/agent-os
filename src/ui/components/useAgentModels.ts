import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentModelInfo, BrainAgentId } from "../../setupApi";
import { getAgentModel } from "../../setupApi";
import type { BrainAgentLine } from "../brainShared";
import { MODEL_READ_LIMIT_MS, withTimeout } from "../homeShared";

// Which model each installed agent uses right now, read from the agents
// themselves. An agent that can't be read is `null` (unknown, never guessed);
// one not asked about yet is simply missing. `reload` reads them again, for
// when a model was just changed.
export function useAgentModels(agents: BrainAgentLine[]) {
  const [models, setModels] = useState<Partial<Record<BrainAgentId, AgentModelInfo | null>>>({});
  const [loading, setLoading] = useState(true);
  const ids = agents.filter((agent) => agent.installed).map((agent) => agent.id);
  const idsKey = ids.join(",");
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = (generation.current += 1);
    const wanted = idsKey ? (idsKey.split(",") as BrainAgentId[]) : [];
    setLoading(true);
    const entries = await Promise.all(
      // An agent that does not answer in time, or could not be asked (`known: false`), is unknown (null): never "no model".
      wanted.map(async (id) => {
        const info = await withTimeout(getAgentModel(id), MODEL_READ_LIMIT_MS).catch(() => null);
        return [id, info && info.known !== false ? info : null] as const;
      })
    );
    // A newer read started meanwhile (or the screen is gone): drop this one.
    if (mine !== generation.current) return;
    setModels(Object.fromEntries(entries) as Partial<Record<BrainAgentId, AgentModelInfo | null>>);
    setLoading(false);
  }, [idsKey]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return { models, loading, reload };
}
