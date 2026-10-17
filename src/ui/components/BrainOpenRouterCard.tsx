// The OpenRouter half of the "AI brain" choice: one button, "Connect
// OpenRouter", opens the person's normal browser on OpenRouter's own sign-in
// page; when they come back this card says "OpenRouter connected ✓", offers a
// pre-selected free model, and hands the connection (a flow id, never a key)
// to the parent when they press "Give it to ...". A pasted key is still
// possible through the small "Use an existing key instead" link.
//
// The honest limits of the free tier are written on the card BEFORE they
// connect, because "free" with a 50-requests-a-day ceiling is exactly what a
// beginner would not guess.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import BrainAgentChecks from "./BrainAgentChecks";
import RelativeTime from "./RelativeTime";
import RememberKeyTick from "./RememberKeyTick";
import StatusMark from "./StatusMark";
import { useInterval } from "./useInterval";
import OpenAddress from "./OpenAddress";
import type { BrainAgentId, OpenRouterConnectState, OpenRouterModel } from "../../setupApi";
import {
  cancelOpenRouterConnect,
  friendlyError,
  getOpenRouterConnect,
  getOpenRouterModels,
  startOpenRouterConnect,
  verifyOpenRouterKey
} from "../../setupApi";
import type { BrainAgentLine } from "../brainShared";
import { formatContext, giveItTo } from "../brainShared";

const POLL_MS = 1500;
// OpenRouter's one-time codes expire after 10 minutes, so waiting longer
// than that can never succeed.
const WAIT_LIMIT_MS = 10 * 60 * 1000;

type Phase = "idle" | "starting" | "waiting" | "connected" | "failed" | "expired" | "cancelled" | "timeout";

export interface OpenRouterGive {
  model: string;
  keySource?: { flowId: string };
  apiKey?: string;
}

export default function BrainOpenRouterCard({
  agents,
  assigned,
  onToggleAgent,
  riskAccepted,
  onRiskChange,
  busy,
  recommended,
  onGive,
  error,
  resetToken
}: {
  agents: BrainAgentLine[];
  assigned: Set<BrainAgentId>;
  onToggleAgent: (id: BrainAgentId, checked: boolean) => void;
  riskAccepted: boolean;
  onRiskChange: (value: boolean) => void;
  busy: boolean;
  recommended: boolean;
  onGive: (give: OpenRouterGive) => void;
  error?: string;
  // Bumped by the parent when a connection was used up or refused, so this
  // card goes back to "Connect OpenRouter" instead of showing a dead tick.
  resetToken: number;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [opened, setOpened] = useState(true);
  const [startedAt, setStartedAt] = useState(0);
  const [info, setInfo] = useState<OpenRouterConnectState["info"]>(undefined);
  const [flowId, setFlowId] = useState<string | null>(null);

  const [useKey, setUseKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [keyMessage, setKeyMessage] = useState("");

  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [recommendedId, setRecommendedId] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [model, setModel] = useState("");

  // The flow id lives in a ref too, so a slow poll answer from an OLD sign-in
  // can never overwrite the state of a newer one.
  const flowRef = useRef<string | null>(null);
  const startedRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  useEffect(() => {
    let cancelled = false;
    setModelsError("");
    getOpenRouterModels()
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        setRecommendedId(res.recommended || null);
        setModel((current) => current || res.recommended || res.models[0]?.id || "");
        if (res.error) setModelsError(res.error);
        else if (!res.models.length) setModelsError("OpenRouter has no free models that fit right now.");
      })
      .catch(() => {
        if (!cancelled) setModelsError("Could not load OpenRouter's model list.");
      });
    return () => {
      cancelled = true;
    };
  }, [modelsAttempt]);

  // Leaving the screen while a sign-in is still waiting frees its slot.
  useEffect(() => {
    return () => {
      if (flowRef.current && phaseRef.current === "waiting") {
        void cancelOpenRouterConnect(flowRef.current).catch(() => {});
      }
    };
  }, []);

  // Coming back from the browser, bring the card (and its main button) into
  // view: on a short window the "Give it to ..." button sits below the fold.
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (phase !== "connected") return;
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }, [phase]);

  useEffect(() => {
    if (resetToken === 0) return;
    flowRef.current = null;
    setPhase("idle");
    setInfo(undefined);
    setApiKey("");
    setKeyStatus("idle");
  }, [resetToken]);

  async function connect() {
    setPhase("starting");
    setMessage("");
    setUseKey(false);
    try {
      const started = await startOpenRouterConnect();
      flowRef.current = started.flowId;
      setFlowId(started.flowId);
      setAuthUrl(started.authUrl);
      setOpened(started.opened);
      startedRef.current = Date.now();
      setStartedAt(startedRef.current);
      setPhase("waiting");
    } catch (err) {
      flowRef.current = null;
      setPhase("failed");
      setMessage(friendlyError(err, "Couldn't start the sign-in. Please try again."));
    }
  }

  function applyStatus(state: OpenRouterConnectState) {
    if (state.status === "waiting") return;
    if (state.status === "connected") {
      setInfo(state.info);
      setPhase("connected");
      return;
    }
    flowRef.current = null;
    setMessage(state.error || "");
    setPhase(state.status);
  }

  useInterval(
    async () => {
      const id = flowRef.current;
      if (!id) return;
      if (Date.now() - startedRef.current > WAIT_LIMIT_MS) {
        flowRef.current = null;
        setPhase("timeout");
        void cancelOpenRouterConnect(id).catch(() => {});
        return;
      }
      try {
        const state = await getOpenRouterConnect(id);
        if (flowRef.current === id) applyStatus(state);
      } catch (err) {
        // The server forgot the sign-in (or restarted): it is over.
        if (flowRef.current === id && err instanceof Error && /not found/i.test(err.message)) {
          flowRef.current = null;
          setMessage("");
          setPhase("expired");
        }
        // Any other error is a blip; the next tick tries again.
      }
    },
    phase === "waiting" ? POLL_MS : null
  );

  const [copied, setCopied] = useState(false);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied; the visible link above still works.
    }
  }

  async function stopWaiting() {
    const id = flowRef.current;
    flowRef.current = null;
    setPhase("cancelled");
    setMessage("");
    if (id) await cancelOpenRouterConnect(id).catch(() => {});
  }

  async function checkKey() {
    if (!apiKey.trim() || keyStatus === "checking") return;
    setKeyStatus("checking");
    setKeyMessage("");
    try {
      const result = await verifyOpenRouterKey(apiKey);
      if (result.ok) {
        setKeyStatus("ok");
        setKeyMessage(result.label ? `Key looks good (${result.label}).` : "Key looks good.");
        setInfo(typeof result.isFreeTier === "boolean" ? { isFreeTier: result.isFreeTier } : undefined);
      } else {
        setKeyStatus("error");
        setKeyMessage(result.error || "That key didn't check out.");
      }
    } catch {
      setKeyStatus("error");
      setKeyMessage("Could not reach OpenRouter to verify the key.");
    }
  }

  const chosenModel = models.find((m) => m.id === model);
  const ready = useKey ? keyStatus === "ok" : phase === "connected";
  const labels = agents.filter((a) => a.installed && assigned.has(a.id)).map((a) => a.label);
  const openclawTicked = assigned.has("openclaw") && Boolean(agents.find((a) => a.id === "openclaw")?.installed);
  const canGive = ready && Boolean(model) && labels.length > 0 && (!openclawTicked || riskAccepted) && !busy;

  function give() {
    if (!canGive) return;
    if (useKey) onGive({ model, apiKey });
    else if (flowId) onGive({ model, keySource: { flowId } });
  }

  const problem = phase === "failed" || phase === "expired" || phase === "cancelled" || phase === "timeout";
  const problemText =
    phase === "timeout"
      ? "Timed out after 10 minutes without an answer from OpenRouter. Try again."
      : phase === "cancelled"
        ? message || "You stopped the sign-in. Nothing was connected."
        : phase === "expired"
          ? message || "That sign-in expired. Try again."
          : message || "The sign-in didn't finish. Try again.";

  return (
    <section className="os-panel os-brain-card" aria-labelledby="os-brain-or-title" ref={cardRef}>
      <header className="os-brain-card__head">
        <h3 id="os-brain-or-title">OpenRouter</h3>
        <span className="os-brain-card__badges">
          {recommended ? <span className="os-chip">Recommended</span> : null}
          <span className="os-chip">Free to start</span>
        </span>
      </header>

      <ul className="os-brain-card__facts">
        <li>No credit card. Free models: 50 requests a day, enough to try things.</li>
        <li>One agent task can use 10+ requests. For daily use add $10 once (raises it to 1,000 a day), or use Local.</li>
        <li className="os-brain-card__caution">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>Some free models&apos; providers may store prompts, so don&apos;t use secrets with them.</span>
        </li>
      </ul>

      {error ? (
        <p className="os-brain-card__error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}

      {!useKey && (phase === "idle" || phase === "starting" || problem) ? (
        <div className="os-brain-card__connect">
          {problem ? (
            phase === "cancelled" ? (
              // The person's own choice, not a fault: neutral wording and colour.
              <p className="os-brain-card__hint" role="status">
                <StatusMark kind="unknown" /> {problemText}
              </p>
            ) : (
              <p className="os-brain-card__error" role="alert">
                <StatusMark kind="error" /> {problemText}
              </p>
            )
          ) : null}
          <button type="button" className="os-btn os-btn--primary os-brain-card__cta" onClick={() => void connect()} disabled={phase === "starting" || busy}>
            {phase === "starting" ? "Opening your browser…" : problem ? "Try again: Connect OpenRouter" : "Connect OpenRouter"}
          </button>
          <button type="button" className="os-brain-link" onClick={() => setUseKey(true)}>
            Use an existing key instead
          </button>
        </div>
      ) : null}

      {!useKey && phase === "waiting" ? (
        <div className="os-brain-card__connect">
          <p className="os-brain-card__waiting" role="status">
            <StatusMark kind="live" />
            <span>
              Waiting for you to press Authorize in your browser · <RelativeTime since={startedAt} live /> elapsed
            </span>
          </p>
          <p className="os-brain-card__hint">
            {opened ? "Your browser should have opened OpenRouter's sign-in page." : "We couldn't open your browser by ourselves."}{" "}
            <OpenAddress href={authUrl} copyLabel="Copy the sign-in page address">
              Didn&apos;t open? Open the sign-in page <ExternalLink size={12} aria-hidden="true" />
            </OpenAddress>
          </p>
          <div className="os-brain-card__row">
            <button type="button" className="os-btn os-btn--ghost" onClick={() => void stopWaiting()}>
              Cancel
            </button>
            {/* Some app windows don't open links themselves; copying always works. */}
            <button type="button" className="os-brain-link" onClick={() => void copyLink()}>
              {copied ? "Link copied" : "Copy the sign-in link"}
            </button>
          </div>
        </div>
      ) : null}

      {useKey ? (
        <div className="os-brain-card__connect">
          <label className="os-field">
            <span className="os-field__label">Your OpenRouter API key (from openrouter.ai/keys)</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setKeyStatus("idle");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void checkKey();
                }
              }}
            />
          </label>
          <div className="os-brain-card__row">
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void checkKey()} disabled={!apiKey.trim() || keyStatus === "checking"}>
              {keyStatus === "checking" ? "Checking…" : "Check key"}
            </button>
            {keyStatus !== "idle" ? (
              <span className="os-brain-card__status" role="status">
                <StatusMark kind={keyStatus === "ok" ? "ok" : keyStatus === "checking" ? "unknown" : "error"} />
                {keyStatus === "checking" ? "Checking…" : keyMessage}
              </span>
            ) : null}
            <button type="button" className="os-brain-link" onClick={() => setUseKey(false)}>
              Connect with the button instead
            </button>
          </div>
        </div>
      ) : null}

      {/* Each agent picks its own brain, so the ticks are always visible, even
          before OpenRouter is connected (the button below the ticks needs it). */}
      {!ready ? <BrainAgentChecks agents={agents} assigned={assigned} onToggle={onToggleAgent} disabled={busy} name="or" /> : null}

      {ready ? (
        <div className="os-brain-card__give">
          {!useKey ? (
            <p className="os-brain-card__ok" role="status">
              <StatusMark kind="ok" label="connected" /> OpenRouter connected ✓
            </p>
          ) : null}
          {/* Opt-in (off by default): keep this key for Claude Code and Codex too. */}
          {!useKey && flowId ? <RememberKeyTick flowId={flowId} /> : null}
          {info?.isFreeTier === true ? <p className="os-brain-card__hint">Free account: 50 free-model requests a day.</p> : null}
          {info?.isFreeTier === false ? <p className="os-brain-card__hint">You&apos;ve added credit: up to 1,000 free-model requests a day.</p> : null}

          {modelsError ? (
            <p className="os-brain-card__error">
              <StatusMark kind="error" /> {modelsError}{" "}
              <button type="button" className="os-brain-link" onClick={() => setModelsAttempt((n) => n + 1)}>
                Try again
              </button>
            </p>
          ) : null}
          <label className="os-field">
            <span className="os-field__label">Free model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
              {!models.length ? <option value="">{modelsError ? "No models available" : "Loading models…"}</option> : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.id === recommendedId ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </label>
          {chosenModel ? (
            <p className="os-brain-card__hint">
              {formatContext(chosenModel.contextLength)} context window.
              {chosenModel.id === recommendedId ? " Our pick: the biggest free model that can use tools." : ""}
            </p>
          ) : null}

          <BrainAgentChecks agents={agents} assigned={assigned} onToggle={onToggleAgent} disabled={busy} name="or" />
          {openclawTicked ? (
            <label className="os-brain-risk">
              <input type="checkbox" checked={riskAccepted} onChange={(e) => onRiskChange(e.target.checked)} />
              <span>I understand OpenClaw can act on this computer. Agent OS will switch it to ask before running commands.</span>
            </label>
          ) : null}
          <button type="button" className="os-btn os-btn--primary os-brain-card__cta" onClick={give} disabled={!canGive}>
            {busy ? "Starting…" : giveItTo(labels)}
          </button>
        </div>
      ) : null}
    </section>
  );
}
