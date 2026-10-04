// The "Brain" card on a Hermes / OpenClaw page: what brain and model it has
// right now, "Change model" (the picker) and "Choose on OpenRouter" (paste a
// model ID, or use a preset), and "Change brain", which opens the same
// two-card panel used in Setup with only this agent ticked.
//
// Honesty: Agent OS never reads an agent's own config files. The model shown
// is what the agent itself reports (its own `config get`); when that can't be
// read, the card falls back to its own status and the setup receipt (what Agent
// OS last gave it).
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import BrainModelActions from "./BrainModelActions";
import SetupBrainPanel from "./SetupBrainPanel";
import { TimeAgo } from "./RelativeTime";
import StatusMark from "./StatusMark";
import { useAgentModels } from "./useAgentModels";
import type { BrainAgentId, BrainOptionsResponse, ReceiptEntry } from "../../setupApi";
import { getBrainOptions, getReceipt } from "../../setupApi";
import { BRAIN_AGENT_IDS, BRAIN_AGENT_LABEL, type BrainAgentLine } from "../brainShared";

const PROVIDER_NAME: Record<string, string> = { openrouter: "OpenRouter", ollama: "Local (Ollama)" };

export default function AgentBrainCard({ agentId, label }: { agentId: BrainAgentId; label: string }) {
  const [brain, setBrain] = useState<BrainOptionsResponse | null>(null);
  const [receipt, setReceipt] = useState<ReceiptEntry | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [options, receipts] = await Promise.all([
        getBrainOptions(true),
        getReceipt().catch(() => ({ receipt: [] as ReceiptEntry[] }))
      ]);
      setBrain(options);
      const mine = receipts.receipt
        .filter((entry) => entry.agentId === agentId && entry.action === "configure" && entry.provider)
        .sort((a, b) => b.at.localeCompare(a.at));
      setReceipt(mine[0] || null);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [agentId]);

  useEffect(() => {
    setBrain(null);
    setReceipt(null);
    setOpen(false);
    void load();
  }, [agentId, load]);

  const current = brain?.current[agentId];
  const lines: BrainAgentLine[] = brain
    ? BRAIN_AGENT_IDS.map((id) => ({
        id,
        label: BRAIN_AGENT_LABEL[id],
        installed: brain.current[id].installed !== false,
        configured: brain.current[id].configured
      }))
    : [];

  // What the agent itself says it uses (both agents, because the picker can give a model to either).
  const { models, reload: reloadModels } = useAgentModels(lines);
  const live = models[agentId];
  function onModelChanged() {
    void load();
    void reloadModels();
  }

  return (
    <>
      <section className="os-panel os-agent-brain" aria-labelledby={`os-agent-brain-${agentId}`}>
        <h2 id={`os-agent-brain-${agentId}`} className="os-agent-brain__title">
          Brain
        </h2>

        {failed ? (
          <div className="os-fleet__banner">
            <AlertTriangle size={16} />
            <span>Couldn&apos;t read {label}&apos;s brain.</span>
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void load()}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        ) : !current ? (
          <p className="os-agent-brain__sub">Checking…</p>
        ) : (
          <>
            <p className="os-agent-brain__line">
              <StatusMark kind={current.configured ? "ok" : "warn"} label={current.configured ? "has a model" : "needs a model"} />
              <span>
                {live?.model ? (
                  live.isPreset ? (
                    <>
                      <strong>OpenRouter preset</strong> · <span className="os-mono">{live.presetSlug}</span>
                    </>
                  ) : (
                    <>
                      <strong>{live.providerLabel || "Model"}</strong> · <span className="os-mono">{live.model}</span>
                    </>
                  )
                ) : current.configured ? (
                  receipt ? (
                    <>
                      <strong>{PROVIDER_NAME[receipt.provider] || receipt.provider}</strong> · <span className="os-mono">{receipt.model}</span>
                    </>
                  ) : (
                    <strong>Has a model</strong>
                  )
                ) : (
                  <strong>No model yet</strong>
                )}
              </span>
            </p>
            <p className="os-agent-brain__sub">
              {live?.isPreset ? (
                <>Following your OpenRouter preset {live.presetSlug}: change it on openrouter.ai and {label} follows. </>
              ) : null}
              {current.configured ? (
                receipt ? (
                  <>
                    Last set by Agent OS <TimeAgo since={receipt.at} />.
                  </>
                ) : live?.model ? (
                  "Read from the agent itself; it was set up outside Agent OS."
                ) : (
                  `It was set up outside Agent OS, so we can't tell you which model it is. ${current.summary}`
                )
              ) : live?.model ? (
                current.summary
              ) : (
                `${current.summary} Press Change model, or Change brain, to give ${label} one.`
              )}
            </p>
            <BrainModelActions
              agents={lines}
              models={models}
              initialAgents={[agentId]}
              onChanged={onModelChanged}
              extraActions={
                <button type="button" className="os-btn os-btn--secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                  {open ? "Close" : "Change brain"}
                </button>
              }
            />
          </>
        )}
      </section>

      {open && brain ? (
        <SetupBrainPanel
          brain={brain}
          agents={lines}
          initialAgents={[agentId]}
          showModelActions={false}
          onChanged={onModelChanged}
          onContinue={() => setOpen(false)}
          continueLabel="Done"
        />
      ) : null}
    </>
  );
}
