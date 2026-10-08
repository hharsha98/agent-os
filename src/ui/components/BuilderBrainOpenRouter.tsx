// The OpenRouter half of a coding agent's Brain card (Claude Code and Codex): the
// model it uses now ("Change model" opens the same searchable picker used for
// Hermes and OpenClaw, set up with that agent as the only target and its own
// "Recommended" / "Experimental" tags), and the saved OpenRouter key. Nothing here
// touches the agent's own sign-in or config files.
import { useEffect, useMemo, useState } from "react";
import ModelPicker from "./ModelPicker";
import OpenRouterConnectInline from "./OpenRouterConnectInline";
import RememberKeyTick from "./RememberKeyTick";
import StatusMark from "./StatusMark";
import { useOpenRouterKey } from "./useBuilderBrains";
import type { AgentBrain, BuilderId } from "../../buildersApi";
import { saveBuilderBrains } from "../../buildersApi";
import { cancelOpenRouterConnect } from "../../setupApi";
import { builderApplier } from "../builderApply";
import { CLAUDE_LATEST_ALIAS, explain, isRecommendedModel, recommendFor, usableForCoding } from "../builderShared";
import type { ModelTarget } from "../modelPickerShared";
import "../builders.css";

export default function BuilderBrainOpenRouter({
  agentId,
  label,
  saved,
  note,
  onChanged
}: {
  agentId: Exclude<BuilderId, "cursor">;
  label: string;
  saved: AgentBrain;
  note?: string;
  onChanged: () => void;
}) {
  const { status: key } = useOpenRouterKey();
  const [flowId, setFlowId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const inUse = saved.mode === "openrouter" ? saved.model : null;
  const recommended = isRecommendedModel(agentId, inUse);
  const makerWord = agentId === "codex" ? "OpenAI" : "Claude";

  // Once the key is saved the sign-in that produced it has done its job: let the server forget it.
  useEffect(() => {
    if (key?.stored && flowId) {
      void cancelOpenRouterConnect(flowId).catch(() => undefined);
      setFlowId(null);
    }
  }, [key?.stored, flowId]);

  const targets: ModelTarget[] = useMemo(
    () => [{ id: agentId, label, current: inUse ? `OpenRouter · ${inUse}` : undefined }],
    [agentId, label, inUse]
  );
  const apply = useMemo(() => builderApplier(agentId, label), [agentId, label]);
  const recommend = useMemo(() => recommendFor(agentId), [agentId]);

  async function useLatestSonnet() {
    setBusy(true);
    setError("");
    try {
      await saveBuilderBrains({ claude: { mode: "openrouter", model: CLAUDE_LATEST_ALIAS } });
      onChanged();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="os-bb-panel">
      <p className="os-bb-line">
        <StatusMark kind={inUse ? "ok" : "warn"} label={inUse ? "model chosen" : "no model yet"} />
        {inUse ? (
          <span>
            Model <strong className="os-mono">{inUse}</strong>{" "}
            <span className={`os-mp-badge os-mp-badge--${recommended ? "ok" : "warn"}`}>{recommended ? "Recommended" : "Experimental"}</span>
          </span>
        ) : (
          <span>
            <strong>No model chosen yet.</strong> Pick one, and {label} will use it for runs you start here.
          </span>
        )}
      </p>
      <p className="os-mp-hint">
        {note || `Pay per use from your OpenRouter credit. ${makerWord} models work best; other models are experimental.`}
      </p>

      <div className="os-mp-actions">
        <button type="button" className="os-btn os-btn--primary" onClick={() => setPicker(true)} aria-haspopup="dialog" disabled={busy}>
          {inUse ? "Change model" : "Choose a model"}
        </button>
        {agentId === "claude" && inUse !== CLAUDE_LATEST_ALIAS ? (
          <button type="button" className="os-btn os-btn--secondary" onClick={() => void useLatestSonnet()} disabled={busy} title={CLAUDE_LATEST_ALIAS}>
            Use the newest Claude Sonnet
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}

      <div className="os-bb-key">
        <span className="os-micro">OpenRouter key</span>
        {key === null ? (
          <p className="os-mp-hint">Checking…</p>
        ) : key.stored ? (
          <RememberKeyTick flowId={null} />
        ) : (
          <>
            <p className="os-mp-hint">
              {label} needs your OpenRouter key to run on OpenRouter. Agent OS uses only this key for that, never your {label} sign-in.
            </p>
            <OpenRouterConnectInline flowId={flowId} onFlowChange={setFlowId} rememberTick />
          </>
        )}
        {inUse && key !== null && !key.stored ? (
          <p className="os-mp-hint os-mp-hint--warn">
            <StatusMark kind="warn" label="note" /> No key is saved yet, so {label} won&apos;t start on OpenRouter until you do.
          </p>
        ) : null}
      </div>

      {picker ? (
        <ModelPicker
          title={`Choose a model for ${label}`}
          targets={targets}
          initialTargets={[agentId]}
          apply={apply}
          recommend={recommend}
          filter={usableForCoding}
          applyLabel={() => `Use for ${label}`}
          onClose={() => setPicker(false)}
          onApplied={onChanged}
        />
      ) : null}
    </div>
  );
}
