// The "Brain" card on a coding agent's page (Claude Code, Codex, Cursor): one
// segmented control, Plan · OpenRouter · Local.
//   Plan        the person's own subscription. Needs nothing, so picking it saves
//               at once (it is the free, safe choice).
//   OpenRouter  pay per use. Opens the model picker and the key row; nothing is
//               saved until a model is chosen.
//   Local       a model already downloaded in Ollama; saved when "Use ..." is pressed.
// Cursor's command-line agent can only use models from its own plan, so its
// OpenRouter and Local segments are disabled and the card says why.
// The agent's own sign-in and config files are never changed by any of this.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import Banner from "./Banner";
import BuilderBrainBadge from "./BuilderBrainBadge";
import BuilderBrainCursor from "./BuilderBrainCursor";
import BuilderBrainLocal from "./BuilderBrainLocal";
import BuilderBrainOpenRouter from "./BuilderBrainOpenRouter";
import StatusMark from "./StatusMark";
import type { BrainMode, BuilderBrains, BuilderId } from "../../buildersApi";
import { saveBuilderBrains } from "../../buildersApi";
import { MODE_LABEL, PLAN_OF, explain } from "../builderShared";
import "../builders.css";

const MODES: BrainMode[] = ["plan", "openrouter", "local"];

export default function BuilderBrainCard({
  agentId,
  label,
  brains,
  failed,
  onChanged
}: {
  agentId: BuilderId;
  label: string;
  brains: BuilderBrains | null;
  failed: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [view, setView] = useState<BrainMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    setView(null);
    setError("");
    setNote("");
  }, [agentId]);

  if (!brains) {
    return (
      <section className="os-panel os-bb-card" aria-labelledby={`os-bb-title-${agentId}`}>
        <h3 id={`os-bb-title-${agentId}`} className="os-bb-card__title">
          Brain
        </h3>
        {failed ? (
          <Banner
            tone="warn"
            actions={
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void onChanged()}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            }
          >
            Couldn&apos;t read {label}&apos;s brain settings.
          </Banner>
        ) : (
          <p className="os-mp-hint">Checking…</p>
        )}
      </section>
    );
  }

  const saved = brains[agentId];
  const modes = brains.modes[agentId];
  const effective: BrainMode = view ?? saved.mode;
  const reasons = Array.from(new Set(MODES.filter((mode) => modes?.[mode] && !modes[mode].available).map((mode) => modes[mode].reason || ""))).filter(
    Boolean
  );

  async function pick(mode: BrainMode) {
    setError("");
    setNote("");
    setView(mode);
    if (mode !== "plan" || saved.mode === "plan") return;
    // Back to the plan: nothing to set up, nothing to pay for, so it is saved at once.
    setBusy(true);
    try {
      await saveBuilderBrains({ [agentId]: { mode: "plan", model: null } });
      setNote(`${label} now uses ${PLAN_OF[agentId]}.`);
      await onChanged();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="os-panel os-bb-card" aria-labelledby={`os-bb-title-${agentId}`}>
      <header className="os-bb-card__head">
        <h3 id={`os-bb-title-${agentId}`} className="os-bb-card__title">
          Brain
        </h3>
        <span className="os-bb-card__now">
          <span className="os-micro">In use</span>
          <BuilderBrainBadge agentId={agentId} brain={saved} />
        </span>
      </header>
      <p className="os-bb-card__lead">
        What {label} thinks with when you start a run here. Your own {label} sign-in and settings are never changed.
      </p>

      <div className="os-bb-seg" role="group" aria-label={`${label} brain`}>
        {MODES.map((mode) => {
          const available = modes ? modes[mode].available : true;
          const inUse = saved.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              className={`os-bb-seg__btn${effective === mode ? " os-bb-seg__btn--on" : ""}`}
              aria-pressed={effective === mode}
              disabled={!available || busy}
              title={!available ? modes?.[mode].reason : undefined}
              onClick={() => void pick(mode)}
            >
              {inUse ? <span className="os-bb-seg__dot" aria-hidden="true" /> : null}
              {MODE_LABEL[mode]}
              {inUse ? <span className="os-bb-hidden"> (in use)</span> : null}
            </button>
          );
        })}
      </div>
      {reasons.map((reason) => (
        <p key={reason} className="os-bb-reason">
          <StatusMark kind="unknown" label="not available" /> {reason}
        </p>
      ))}

      {note ? (
        <p className="os-mp-hint" role="status">
          <StatusMark kind="ok" label="saved" /> {note}
        </p>
      ) : null}
      {error ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}

      {agentId === "cursor" ? (
        <BuilderBrainCursor saved={saved} modes={modes} onChanged={() => void onChanged()} />
      ) : effective === "plan" ? (
        <div className="os-bb-panel">
          <p className="os-bb-line">
            <StatusMark kind="ok" label="plan" />
            <span>
              <strong>{PLAN_OF[agentId].replace(/^your/, "Your")}.</strong> {label} works the way it always did here: it signs in with your own account
              and uses what your plan includes. When the plan runs out you can carry on with a pay-per-use model (see “When a plan runs out”).
            </span>
          </p>
        </div>
      ) : effective === "openrouter" ? (
        <BuilderBrainOpenRouter
          agentId={agentId}
          label={label}
          saved={saved}
          note={modes?.openrouter.note}
          onChanged={() => void onChanged()}
        />
      ) : (
        <BuilderBrainLocal agentId={agentId} label={label} saved={saved} note={modes?.local.note} onChanged={() => void onChanged()} />
      )}
    </section>
  );
}
