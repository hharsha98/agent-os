// Cursor's half of the Brain card. Cursor's command-line agent can only run models
// from the person's Cursor plan, so there is no OpenRouter or Local here (the card
// disables those two and says why). What can be chosen: which Cursor model a run
// asks for (its default, Cursor's own Composer, or Auto), and what Agent OS offers
// when the Cursor plan runs out.
import { useState } from "react";
import StatusMark from "./StatusMark";
import type { AgentBrain, AgentModes } from "../../buildersApi";
import { saveBuilderBrains } from "../../buildersApi";
import { navigateTo } from "../../nav";
import { CURSOR_MODEL_LABEL, explain } from "../builderShared";
import "../builders.css";

const FALLBACK_MODELS = [
  { id: "composer-2.5", label: "Composer 2.5 (Cursor's own model)" },
  { id: "auto", label: "Auto", note: "Auto is billed at the price of the model it picks." }
];

export default function BuilderBrainCursor({
  saved,
  modes,
  onChanged
}: {
  saved: AgentBrain;
  modes: AgentModes | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const choices = [{ id: "", label: "Cursor's default", note: "Cursor picks the model from your plan." }, ...(modes?.models?.length ? modes.models : FALLBACK_MODELS)];
  const current = saved.model || "";

  async function choose(id: string) {
    setBusy(true);
    setError("");
    setDone("");
    try {
      await saveBuilderBrains({ cursor: { mode: "plan", model: id || null } });
      setDone(id ? `Cursor will ask for ${CURSOR_MODEL_LABEL[id] || id}.` : "Cursor will use its default model.");
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
        <StatusMark kind="ok" label="plan" />
        <span>
          <strong>Your Cursor plan.</strong> Pick the model a run asks for:
        </span>
      </p>
      <div className="os-bb-choices" role="radiogroup" aria-label="Cursor model">
        {choices.map((choice) => (
          <label key={choice.id || "default"} className={`os-bb-choice${current === choice.id ? " os-bb-choice--on" : ""}`}>
            <input type="radio" name="os-bb-cursor-model" checked={current === choice.id} disabled={busy} onChange={() => void choose(choice.id)} />
            <span className="os-bb-choice__body">
              <strong>{choice.label}</strong>
              {choice.note ? <span>{choice.note}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {done ? (
        <p className="os-mp-hint" role="status">
          <StatusMark kind="ok" label="saved" /> {done}
        </p>
      ) : null}
      {error ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}

      <div className="os-bb-runout">
        <span className="os-micro">When Cursor&apos;s plan runs out</span>
        <ul>
          <li>
            <strong>Use Cursor&apos;s own Composer model.</strong> It stays on your Cursor plan, so there is no OpenRouter charge.
          </li>
          <li>
            <strong>Hand the task to Claude Code or Codex.</strong> They start a new run on OpenRouter with a summary of what Cursor did. Set them up first:{" "}
            <button type="button" className="os-mp-link" onClick={() => navigateTo("agents", { agent: "claude" })}>
              Claude Code
            </button>{" "}
            ·{" "}
            <button type="button" className="os-mp-link" onClick={() => navigateTo("agents", { agent: "codex" })}>
              Codex
            </button>
          </li>
        </ul>
        <p className="os-mp-hint">Agent OS shows these as buttons on the run itself, the moment the limit is reached. It asks before it does either.</p>
      </div>
    </div>
  );
}
