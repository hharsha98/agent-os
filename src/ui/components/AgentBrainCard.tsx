// The "Brain" card on a Hermes / OpenClaw page: what brain and model it has
// right now, "Change model" (the picker) and "Choose on OpenRouter" (paste a
// model ID, or use a preset), and "Change brain", which opens the same
// two-card panel used in Setup with only this agent ticked.
//
// Honesty: Agent OS never reads an agent's own config files. The model shown
// is what the agent itself reports (its own `config get`); when that can't be
// read, the card falls back to its own status and the setup receipt (what Agent
// OS last gave it).
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import Banner from "./Banner";
import BrainModelActions from "./BrainModelActions";
import SetupBrainPanel from "./SetupBrainPanel";
import { TimeAgo } from "./RelativeTime";
import StatusMark from "./StatusMark";
import { useAgentModels } from "./useAgentModels";
import type { BrainAgentId, BrainOptionsResponse, ReceiptEntry } from "../../setupApi";
import { friendlyError, getBrainOptions, getReceipt } from "../../setupApi";
import { BRAIN_AGENT_IDS, BRAIN_AGENT_LABEL, type BrainAgentLine } from "../brainShared";
import { withTimeout } from "../homeShared";
import { gotNoAnswer, noAnswerWords } from "../setupGroupShared";

const PROVIDER_NAME: Record<string, string> = { openrouter: "OpenRouter", ollama: "Local (Ollama)" };

// Every request this card makes has a time limit, so a server that never answers cannot leave it on
// "Checking…" for ever (the same limit as the Setup brain panel).
const REQUEST_TIMEOUT_MS = 20000;
const UNREADABLE = "Agent OS gave an answer that could not be read.";

// A refusal Agent OS sent keeps its plain-English reason. A request that got no answer says so in
// plain words, never the browser's raw "Failed to fetch" / "Load failed".
function whyFailed(error: unknown) {
  if (error instanceof Error && error.message === UNREADABLE) return UNREADABLE;
  return gotNoAnswer(error) ? noAnswerWords(error) : friendlyError(error);
}

export default function AgentBrainCard({ agentId, label }: { agentId: BrainAgentId; label: string }) {
  const [brain, setBrain] = useState<BrainOptionsResponse | null>(null);
  const [receipt, setReceipt] = useState<ReceiptEntry | null>(null);
  // Why the last read failed, in plain words; null while it has not failed.
  const [failed, setFailed] = useState<string | null>(null);
  // The receipt could not be read, so "set up outside Agent OS" cannot be said: it is not known.
  const [receiptUnknown, setReceiptUnknown] = useState(false);
  const [open, setOpen] = useState(false);
  // False once the card is gone, and the newest read is the only one allowed to answer: a late
  // answer must not update a screen that is not there, or one showing another agent.
  const alive = useRef(true);
  const newest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = (newest.current += 1);
    try {
      const [options, receipts] = await Promise.all([
        withTimeout(getBrainOptions(true), REQUEST_TIMEOUT_MS),
        withTimeout(getReceipt(), REQUEST_TIMEOUT_MS).catch(() => null)
      ]);
      if (!alive.current || mine !== newest.current) return;
      // Both agents' lines are read below, so an answer without them is not an answer.
      if (!options?.current?.hermes || !options?.current?.openclaw) throw new Error(UNREADABLE);
      setBrain(options);
      const list = receipts && Array.isArray(receipts.receipt) ? receipts.receipt : null;
      setReceiptUnknown(list === null);
      const mineEntries = (list || [])
        .filter((entry) => entry.agentId === agentId && entry.action === "configure" && entry.provider)
        .sort((a, b) => b.at.localeCompare(a.at));
      setReceipt(mineEntries[0] || null);
      setFailed(null);
    } catch (error) {
      if (!alive.current || mine !== newest.current) return;
      setFailed(whyFailed(error));
    }
  }, [agentId]);

  useEffect(() => {
    setBrain(null);
    setReceipt(null);
    setReceiptUnknown(false);
    setFailed(null);
    setOpen(false);
    void load();
  }, [agentId, load]);

  function retry() {
    setBrain(null);
    setFailed(null);
    void load();
  }

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
  // Three different things hide behind `live`, and only the first one may say "No model yet":
  //   an object  = the lookup answered (its model may be empty),
  //   null       = the lookup failed or ran out of time,
  //   undefined  = not answered yet (or never asked: an agent the status says is not installed).
  // The status answer (`configured`) comes from the agent's health check, not from the model lookup, so a
  // failed health check plus a failed or unfinished lookup is "unknown", never "no model".
  const lookupAnswered = Boolean(live);
  const lookupPending = live === undefined && current?.installed !== false;
  const unknownMark = lookupPending ? "…" : "—";
  function onModelChanged() {
    void load();
    void reloadModels();
  }

  return (
    <>
      <section className="os-panel os-agent-brain" aria-labelledby={`os-agent-brain-${agentId}`}>
        <h3 id={`os-agent-brain-${agentId}`} className="os-agent-brain__title">
          Brain
        </h3>

        {failed !== null ? (
          <Banner
            tone="warn"
            actions={
              <button type="button" className="os-btn os-btn--secondary" onClick={retry}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            }
          >
            Couldn&apos;t read {label}&apos;s brain. {failed}
          </Banner>
        ) : !current ? (
          <p className="os-agent-brain__sub">Checking…</p>
        ) : (
          <>
            <p className="os-agent-brain__line">
              <StatusMark
                kind={current.configured ? "ok" : "warn"}
                label={current.configured ? "has a model" : lookupAnswered ? "needs a model" : "model not known"}
              />
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
                    // The agent says it has a model, but neither it nor Agent OS's record names one: unknown
                    // ("…" while the lookup is still running, "—" once it has failed).
                    <>
                      <strong>Has a model</strong> · <span className="os-mono">{unknownMark}</span>
                    </>
                  )
                ) : lookupAnswered ? (
                  <strong>No model yet</strong>
                ) : (
                  // The status says "not configured", but the lookup that names the model failed or is still
                  // running: the model is unknown, which is not the same as having none.
                  <>
                    <strong>Model</strong> · <span className="os-mono">{unknownMark}</span>
                  </>
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
                ) : receiptUnknown ? (
                  live?.model ? (
                    "Read from the agent itself. Agent OS could not read its record of what it last set."
                  ) : lookupPending ? (
                    // Still asking the agent: no verdict on which model yet.
                    current.summary
                  ) : (
                    `Agent OS could not read its record of what it last set, so we can't tell you which model it is. ${current.summary}`
                  )
                ) : live?.model ? (
                  "Read from the agent itself; it was set up outside Agent OS."
                ) : lookupPending ? (
                  current.summary
                ) : (
                  `It was set up outside Agent OS, so we can't tell you which model it is. ${current.summary}`
                )
              ) : live?.model || !lookupAnswered ? (
                // Either the agent names a model, or the lookup did not answer (failed, unfinished, or never
                // asked): only the status summary, never "give it one".
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
