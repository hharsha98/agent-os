// The "Brain" card on a Hermes / OpenClaw page: what brain and model it has
// right now, "Change model" (the picker) and "Choose on OpenRouter" (paste a
// model ID, or use a preset), and "Change brain", which opens the same
// two-card panel used in Setup with only this agent ticked. OpenClaw's card
// also holds "Your plan" (BrainPlanCard: Claude plan and ChatGPT plan), and
// Hermes's card "Choose in Hermes" (ChooseInHermes: Hermes's own picker).
//
// Honesty: Agent OS never reads an agent's own config files. The model shown
// is what the agent itself reports (its own `config get`); when that can't be
// read, the card falls back to its own status and the setup receipt (what Agent
// OS last gave it).
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import Banner from "./Banner";
import BrainModelActions from "./BrainModelActions";
import BrainPlanCard, { type BrainPlanCardHandle } from "./BrainPlanCard";
import ChooseInHermes from "./ChooseInHermes";
import SetupBrainPanel from "./SetupBrainPanel";
import { TimeAgo } from "./RelativeTime";
import StatusMark from "./StatusMark";
import { useAgentModels } from "./useAgentModels";
import type { BrainAgentId, BrainOptionsResponse, ReceiptEntry } from "../../setupApi";
import { friendlyError, getBrainOptions, getReceipt } from "../../setupApi";
import { BRAIN_AGENT_IDS, BRAIN_AGENT_LABEL, brainMark, receiptFitsModel, type BrainAgentLine } from "../brainShared";
import { BRAIN_READ_LIMIT_MS, withTimeout } from "../homeShared";
import { PLAN_NOTE } from "../planBrainsShared";
import { gotNoAnswer, noAnswerWords } from "../setupGroupShared";
import { useSessionsList } from "../useSessionsList";

// The receipt's provider, in words. The two plan modes are OpenClaw's plan brains (spec 2026-10-15 section 5).
const PROVIDER_NAME: Record<string, string> = {
  openrouter: "OpenRouter",
  ollama: "Local (Ollama)",
  "claude-plan": "Claude plan",
  "chatgpt-plan": "ChatGPT plan"
};

// Every request this card makes has a time limit, so a server that never answers cannot leave it on
// "Checking…" for ever. The brain read re-runs the whole system check and then each agent's own doctor
// (up to 30 s on the server), so its limit is above that; a shorter one would fail every time, Retry included.
const RECEIPT_TIMEOUT_MS = 20000;
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
  // The brain read, which also brings the receipt, is on its way. It is the slow one (the system check, then each
  // agent's own doctor), so after a change made through Agent OS the model answer lands first and sits beside the
  // receipt of the model before: "set up outside Agent OS" cannot be said until this read has settled.
  const [receiptReading, setReceiptReading] = useState(false);
  const [open, setOpen] = useState(false);
  // What the last good brain answer said about this agent: installed or not. A failed read and Retry keep it, so the
  // plan card and Choose in Hermes (shown after the states below) are never unmounted by one; a new agent starts over.
  const [installedSeen, setInstalledSeen] = useState(false);
  // False once the card is gone, and the newest read is the only one allowed to answer: a late
  // answer must not update a screen that is not there, or one showing another agent.
  const alive = useRef(true);
  const newest = useRef(0);
  // The card's heading stays on screen through every state, so focus can rest there when the button that had it goes.
  const titleRef = useRef<HTMLHeadingElement>(null);
  // "Your plan" on OpenClaw's card: Change model brings its list into view while OpenClaw is on a plan.
  const planCard = useRef<BrainPlanCardHandle>(null);
  // The plan routes and Hermes's Terminal launch exist only where Agent OS runs in local mode, as sessions do.
  const { available: localMode } = useSessionsList();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = (newest.current += 1);
    setReceiptReading(true);
    try {
      const [options, receipts] = await Promise.all([
        withTimeout(getBrainOptions(true), BRAIN_READ_LIMIT_MS),
        withTimeout(getReceipt(), RECEIPT_TIMEOUT_MS).catch(() => null)
      ]);
      if (!alive.current || mine !== newest.current) return;
      // Both agents' lines are read below, so an answer without them is not an answer.
      if (!options?.current?.hermes || !options?.current?.openclaw) throw new Error(UNREADABLE);
      setBrain(options);
      setInstalledSeen(options.current[agentId].installed !== false);
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
    } finally {
      // Only the newest read settles it: an older one that ends later must not clear it while the newer one is running.
      if (alive.current && mine === newest.current) setReceiptReading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setBrain(null);
    setReceipt(null);
    setReceiptUnknown(false);
    setFailed(null);
    setOpen(false);
    setInstalledSeen(false);
    void load();
  }, [agentId, load]);

  function retry() {
    setBrain(null);
    setFailed(null);
    // Retry sits in the banner, which is replaced while the card reads again. Without this, keyboard focus would
    // fall to the page body; the card's heading stays, so a keyboard user keeps their place here.
    titleRef.current?.focus();
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
  const { models, loading: modelsLoading, reload: reloadModels } = useAgentModels(lines);
  const live = models[agentId];
  // The plan OpenClaw is on, from its own answer (spec section 5); never for Hermes.
  const livePlan = agentId === "openclaw" ? live?.plan ?? null : null;
  // Three different things hide behind `live`, and only the first one may say "No model yet":
  //   an object  = the lookup answered (its model may be empty),
  //   null       = the lookup failed or ran out of time,
  //   undefined  = not answered yet (or never asked: an agent the status says is not installed).
  // The status answer (`configured`) comes from the agent's health check, not from the model lookup, so a
  // failed health check plus a failed or unfinished lookup is "unknown", never "no model".
  // A lookup is also pending while an earlier answer is being read again (after a model change): the old
  // answer, a failed one included, is not the current one, so the slot shows "…", never "—".
  const lookupAnswered = Boolean(live);
  const lookupPending = current?.installed !== false && (live === undefined || modelsLoading);
  const unknownMark = lookupPending ? "…" : "—";
  function onModelChanged() {
    void load();
    void reloadModels();
  }
  // The agent's own model answer comes back sooner than the health check (after "Choose in Hermes" the model is read
  // again on window focus, the health check is not), so a model it names settles the status mark and the lines under
  // it. `configured` below is that settled answer, never the health check alone.
  const mark = brainMark(Boolean(current?.configured), live);
  const configured = mark.kind === "ok";
  // "Last set by Agent OS" only beside the model Agent OS set; a model chosen in Hermes itself is "set up outside".
  const setByAgentOs = receipt && receiptFitsModel(receipt, live?.model) ? receipt : null;

  return (
    <>
      <section className="os-panel os-agent-brain" aria-labelledby={`os-agent-brain-${agentId}`}>
        <h3 id={`os-agent-brain-${agentId}`} className="os-agent-brain__title" ref={titleRef} tabIndex={-1}>
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
              <StatusMark kind={mark.kind} label={mark.label} />
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
            {livePlan ? <p className="os-agent-brain__sub os-plan-note">{PLAN_NOTE[livePlan]}</p> : null}
            <p className="os-agent-brain__sub">
              {live?.isPreset ? (
                <>Following your OpenRouter preset {live.presetSlug}: change it on openrouter.ai and {label} follows. </>
              ) : null}
              {configured ? (
                setByAgentOs ? (
                  <>
                    Last set by Agent OS <TimeAgo since={setByAgentOs.at} />.
                  </>
                ) : receiptReading ? (
                  // The receipt is being read again, so whether Agent OS set this model is not known yet: no verdict.
                  // The health check's own summary stands, but only when it agrees there is a model (a stale "needs a
                  // model" must not sit beside a model that was just set).
                  current.configured ? current.summary : null
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
              ) : !lookupAnswered ? (
                // The lookup did not answer (failed, unfinished, or never asked): only the status summary, never
                // "give it one". An agent that names a model is `configured` above.
                current.summary
              ) : (
                `${current.summary} Press Change model, or Change brain, to give ${label} one.`
              )}
            </p>
            {/* While OpenClaw is on a plan, Change model opens that plan's list in "Your plan", not the OpenRouter picker. */}
            <BrainModelActions
              agents={lines}
              models={models}
              initialAgents={[agentId]}
              onChanged={onModelChanged}
              onChangeModel={livePlan ? () => planCard.current?.showModels(livePlan) : undefined}
              extraActions={
                <button type="button" className="os-btn os-btn--secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                  {open ? "Close" : "Change brain"}
                </button>
              }
            />
          </>
        )}

        {/* After the states above, not inside them: a failed brain read or Retry must never unmount these (a typed
            model name, a job's result or an open sign-in would be thrown away, P26). Both show once a good answer
            has said the agent is installed, and only in local mode, where their routes exist. */}
        {agentId === "openclaw" && localMode && installedSeen ? (
          <BrainPlanCard ref={planCard} where="agents" currentPlan={livePlan} onChanged={onModelChanged} />
        ) : null}
        {/* Hermes: Refresh reads the whole card again (the brain and the models, so the status follows the new model);
            window focus, which comes in bursts, reads only the models, never the slow brain read. */}
        {agentId === "hermes" && localMode && installedSeen ? (
          <ChooseInHermes onRefresh={onModelChanged} onWindowFocus={() => void reloadModels()} />
        ) : null}
      </section>

      {open && brain ? (
        <SetupBrainPanel
          brain={brain}
          agents={lines}
          initialAgents={[agentId]}
          showModelActions={false}
          showPlanCard={false}
          onChanged={onModelChanged}
          onContinue={() => setOpen(false)}
          continueLabel="Done"
        />
      ) : null}
    </>
  );
}
