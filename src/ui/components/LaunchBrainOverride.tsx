// "Brain for this run" in the Launch panel: an optional, one-run choice of Plan,
// OpenRouter or Local for Claude Code and Codex (Cursor: its model). It starts on
// the saved setting; changing it affects only the run being launched and saves
// nothing. The parent gets the override to send (null = use the saved setting) and
// a plain sentence when the choice isn't finished yet (for example no model picked).
import { useEffect, useMemo, useState } from "react";
import ModelPicker from "./ModelPicker";
import StatusMark from "./StatusMark";
import type { RunBrain } from "../../api";
import type { AgentBrain, BrainMode, BuilderBrains, BuilderId } from "../../buildersApi";
import { getOllamaModels } from "../../setupApi";
import type { LocalModel } from "../../setupApi";
import { formatGb, variantNameFor } from "../brainShared";
import { oneRunApplier } from "../builderApply";
import { CURSOR_MODEL_LABEL, MODE_LABEL, brainText, recommendFor, sameBrain, usableForCoding } from "../builderShared";
import type { ModelTarget } from "../modelPickerShared";
import "../builders.css";

const MODES: BrainMode[] = ["plan", "openrouter", "local"];

export interface BrainOverrideState {
  // What to send as options.brain; null = leave it to the saved setting.
  override: RunBrain | null;
  // Why the launch can't go ahead yet (empty when it can).
  problem: string;
}

export default function LaunchBrainOverride({
  agentId,
  label,
  brains,
  onChange
}: {
  agentId: BuilderId;
  label: string;
  brains: BuilderBrains | null;
  onChange: (state: BrainOverrideState) => void;
}) {
  const saved: AgentBrain | null = brains ? brains[agentId] : null;
  const modes = brains?.modes[agentId];
  const [mode, setMode] = useState<BrainMode>("plan");
  const [model, setModel] = useState("");
  const [picker, setPicker] = useState(false);
  const [local, setLocal] = useState<LocalModel[] | null>(null);
  const [localError, setLocalError] = useState("");

  // Start from the saved setting: when it first loads, and when another agent is shown.
  const savedMode = saved?.mode;
  const savedModel = saved?.model ?? "";
  useEffect(() => {
    if (!savedMode) return;
    setMode(savedMode);
    setModel(savedModel);
  }, [agentId, savedMode, savedModel]);

  useEffect(() => {
    if (mode !== "local" || local !== null) return;
    let cancelled = false;
    getOllamaModels(false)
      .then((summary) => {
        if (cancelled) return;
        setLocal(summary.available ? summary.models : []);
        setLocalError(summary.available ? "" : summary.reason || "Ollama is not available on this computer.");
      })
      .catch(() => {
        if (!cancelled) {
          setLocal([]);
          setLocalError("Couldn't check your local models.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, local]);

  const choice: AgentBrain = { mode, model: mode === "plan" && agentId !== "cursor" ? null : model || null };
  const isSaved = sameBrain(choice, saved);
  const problem =
    mode === "openrouter" && !model
      ? `Choose the OpenRouter model ${label} should use for this run.`
      : mode === "local" && !model
        ? "Choose a local model for this run."
        : "";

  // Report upward whenever the choice changes.
  const overrideKey = `${isSaved}|${choice.mode}|${choice.model}|${problem}`;
  useEffect(() => {
    onChange({ override: isSaved || !saved ? null : { mode: choice.mode, model: choice.model }, problem: saved ? problem : "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideKey, Boolean(saved)]);

  const targets: ModelTarget[] = useMemo(() => [{ id: "run", label: "This run only" }], []);
  const apply = useMemo(
    () =>
      oneRunApplier(label, (id) => {
        setModel(id);
        setPicker(false);
      }),
    [label]
  );
  const recommend = useMemo(() => (agentId === "cursor" ? undefined : recommendFor(agentId)), [agentId]);

  if (!saved) return null;

  function pickMode(next: BrainMode) {
    if (next === mode) return;
    setMode(next);
    // Back on the saved mode, its saved model comes back; any other mode starts empty.
    setModel(next === saved?.mode ? savedModel : "");
  }

  const cursorChoices = [
    { id: "", label: "Cursor's default" },
    ...(modes?.models?.length ? modes.models : [{ id: "composer-2.5", label: "Composer 2.5" }, { id: "auto", label: "Auto" }])
  ];
  const usableLocal = (local ?? []).filter((m) => m.verdict.selectable && (agentId !== "claude" || variantNameFor(m.name) !== null));

  return (
    <fieldset className="os-bb-override">
      <legend className="os-field__label">Brain for this run</legend>
      <div className="os-bb-override__row">
        {agentId === "cursor" ? (
          <label className="os-bb-override__select">
            <span className="os-bb-hidden">Cursor model for this run</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {cursorChoices.map((c) => (
                <option key={c.id || "default"} value={c.id}>
                  Your Cursor plan · {c.id ? CURSOR_MODEL_LABEL[c.id] || c.label : c.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="os-bb-seg os-bb-seg--small" role="group" aria-label="Brain for this run">
            {MODES.map((m) => {
              const available = modes ? modes[m].available : true;
              return (
                <button
                  key={m}
                  type="button"
                  className={`os-bb-seg__btn${mode === m ? " os-bb-seg__btn--on" : ""}`}
                  aria-pressed={mode === m}
                  disabled={!available}
                  title={!available ? modes?.[m].reason : undefined}
                  onClick={() => pickMode(m)}
                >
                  {MODE_LABEL[m]}
                </button>
              );
            })}
          </div>
        )}
        <span className="os-bb-override__caption">
          {isSaved ? (
            <>Your saved setting: {brainText(agentId, saved)}</>
          ) : (
            <>
              <StatusMark kind="warn" label="just this run" /> Just for this run, not saved
            </>
          )}
        </span>
      </div>

      {mode === "openrouter" && agentId !== "cursor" ? (
        <div className="os-bb-override__row">
          <span className="os-bb-override__model os-mono">{model || "no model chosen"}</span>
          <button type="button" className="os-btn os-btn--secondary" onClick={() => setPicker(true)} aria-haspopup="dialog">
            {model ? "Change model" : "Choose model"}
          </button>
        </div>
      ) : null}

      {mode === "local" && agentId !== "cursor" ? (
        <div className="os-bb-override__row">
          {local === null ? (
            <span className="os-mp-hint">Looking for your local models…</span>
          ) : usableLocal.length ? (
            <label className="os-bb-override__select">
              <span className="os-bb-hidden">Local model for this run</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">Choose a local model…</option>
                {usableLocal.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                    {formatGb(m.sizeBytes) ? ` · ${formatGb(m.sizeBytes)}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="os-mp-hint">
              <StatusMark kind="unknown" label="none" /> {localError || "No usable local models are installed in Ollama yet."}
            </span>
          )}
        </div>
      ) : null}

      {problem ? (
        <p className="os-mp-hint os-mp-hint--warn">
          <StatusMark kind="warn" label="note" /> {problem}
        </p>
      ) : null}

      {picker ? (
        <ModelPicker
          title={`Choose a model for this ${label} run`}
          targets={targets}
          initialTargets={["run"]}
          apply={apply}
          recommend={recommend}
          filter={usableForCoding}
          applyLabel={() => "Use for this run"}
          onClose={() => setPicker(false)}
        />
      ) : null}
    </fieldset>
  );
}
