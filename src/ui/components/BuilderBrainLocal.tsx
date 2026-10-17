// The Local half of a coding agent's Brain card (Claude Code and Codex): the
// models already installed in Ollama, each with the same plain verdict and honest
// memory figure as the Setup screen (BrainLocalCard), and one button to use the
// chosen one. Nothing is downloaded here: a coding agent only runs a model that
// is already on this computer (Setup's Local card downloads one, and asks first).
import { useEffect, useState } from "react";
import { FIT_PHRASE, fitMark, memoryLine, verdictMark } from "./BrainLocalCard";
import StatusMark from "./StatusMark";
import type { AgentBrain, BuilderId } from "../../buildersApi";
import { saveBuilderBrains } from "../../buildersApi";
import type { LocalBrainSummary, LocalModel } from "../../setupApi";
import { getOllamaModels } from "../../setupApi";
import { navigateTo } from "../../nav";
import { formatContext, formatGb, variantNameFor } from "../brainShared";
import { explain } from "../builderShared";
import "../brain.css";
import "../builders.css";

// The oldest Ollama that speaks what each agent needs (same numbers as the server's check).
const OLLAMA_MIN: Record<"claude" | "codex", string> = { claude: "0.14", codex: "0.13.4" };

export default function BuilderBrainLocal({
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
  const [summary, setSummary] = useState<LocalBrainSummary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState("");
  const [useAnyway, setUseAnyway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const inUse = saved.mode === "local" ? saved.model : null;
  // Claude Code is given a 64K settings copy of the model, so its name has to allow one.
  const usable = (model: LocalModel) => model.verdict.selectable && (agentId !== "claude" || variantNameFor(model.name) !== null);

  async function load(refresh: boolean) {
    setChecking(true);
    setLoadError("");
    try {
      const next = await getOllamaModels(refresh);
      setSummary(next);
      setSelected((current) => {
        if (current && next.models.some((m) => m.name === current && usable(m))) return current;
        if (inUse && next.models.some((m) => m.name === inUse && usable(m))) return inUse;
        return next.models.find((m) => m.verdict.id === "good" && m.memory.fit !== "too_big" && usable(m))?.name || "";
      });
    } catch {
      setLoadError("Couldn't check your local models.");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    setUseAnyway(false);
  }, [selected]);

  const models = summary?.models ?? [];
  const computerGb = summary?.memoryGb ?? 0;
  const chosen = models.find((m) => m.name === selected);
  const needsAnyway = chosen?.memory.fit === "too_big";
  const canUse = Boolean(chosen) && usable(chosen as LocalModel) && (!needsAnyway || useAnyway) && !busy && inUse !== selected;

  async function apply() {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      await saveBuilderBrains({ [agentId]: { mode: "local", model: chosen.name } });
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
        <StatusMark kind={inUse ? "ok" : "unknown"} label={inUse ? "model chosen" : "no model yet"} />
        {inUse ? (
          <span>
            Local model <strong className="os-mono">{inUse}</strong>
          </span>
        ) : (
          <span>
            <strong>No local model chosen yet.</strong>
          </span>
        )}
      </p>
      <ul className="os-bb-facts">
        <li>Runs on this computer, so your task never leaves it. Free once downloaded.</li>
        <li>
          <span className="os-bb-exp">Experimental:</span> {note?.replace(/^Experimental:\s*/i, "") || "local models use tools less reliably."} Needs Ollama{" "}
          {OLLAMA_MIN[agentId]} or newer.
        </li>
      </ul>

      {loadError ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {loadError}{" "}
          <button type="button" className="os-brain-link" onClick={() => void load(true)}>
            Try again
          </button>
        </p>
      ) : null}
      {!summary && !loadError ? <p className="os-mp-hint">Looking for Ollama on this computer…</p> : null}

      {summary && !summary.available ? (
        <div className="os-bb-stack">
          <p className="os-mp-hint">
            <StatusMark kind="unknown" label="not available" /> {summary.reason || "Ollama is not available on this computer."}
          </p>
          <div>
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void load(true)} disabled={checking}>
              {checking ? "Checking…" : "Re-check"}
            </button>
          </div>
        </div>
      ) : null}

      {summary?.available ? (
        <>
          {models.length ? (
            <ul className="os-brain-models" aria-label="Models installed in Ollama">
              {models.map((m) => {
                const ok = usable(m);
                return (
                  <li key={m.name}>
                    <label className={`os-brain-model${ok ? "" : " os-brain-model--off"}`}>
                      <input
                        type="radio"
                        name={`os-bb-local-${agentId}`}
                        checked={selected === m.name}
                        disabled={!ok}
                        onChange={() => setSelected(m.name)}
                      />
                      <span className="os-brain-model__main">
                        <strong className="os-mono">{m.name}</strong>
                        {formatGb(m.sizeBytes) ? <span className="os-brain-model__size">{formatGb(m.sizeBytes)}</span> : null}
                        {inUse === m.name ? <span className="os-mp-badge os-mp-badge--ok">In use</span> : null}
                      </span>
                      <span className="os-brain-model__verdict">
                        <StatusMark kind={verdictMark(m.verdict.id)} label={m.verdict.label} /> {m.verdict.label}
                      </span>
                      {m.verdict.selectable ? (
                        <span className="os-brain-model__verdict os-brain-model__memory">
                          <StatusMark kind={fitMark(m.memory.fit)} label={FIT_PHRASE[m.memory.fit]} /> {memoryLine(m, computerGb)}
                        </span>
                      ) : null}
                      {m.verdict.selectable && m.memory.stretched && m.memory.nativeContext ? (
                        <span className="os-brain-model__verdict os-brain-model__note">
                          Trained for {formatContext(m.memory.nativeContext)}; past that, answers get worse.
                        </span>
                      ) : null}
                      {m.verdict.selectable && !ok ? (
                        <span className="os-brain-model__verdict os-brain-model__note">
                          Agent OS can&apos;t make its 64K copy of a model with this name, so Claude Code can&apos;t use it.
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="os-mp-hint">
              <StatusMark kind="unknown" label="none" /> No models are installed in Ollama yet.
            </p>
          )}

          {!models.length || !models.some(usable) ? (
            <div className="os-bb-stack">
              <p className="os-mp-hint">
                {label} only runs a model that is already downloaded, so it never starts a surprise download. Download one first in Setup (it asks first
                and shows the size).
              </p>
              <div>
                <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("setup")}>
                  Open Setup
                </button>
              </div>
            </div>
          ) : null}

          {chosen?.verdict.id === "too_small" ? (
            <p className="os-brain-warning" role="note">
              This model is small. {label} often calls tools wrongly with it, so answers may be wrong. A bigger model, or OpenRouter, works better.
            </p>
          ) : null}
          {chosen?.memory.fit === "tight" ? (
            <p className="os-brain-warning" role="note">
              A tight fit: it should run, but expect it to be slow when other apps are open.
            </p>
          ) : null}
          {needsAnyway && chosen ? (
            <div className="os-brain-warning" role="alert">
              <p>
                {chosen.name} needs about {chosen.memory.memoryAt64kGb} GB at 64K and this computer has {computerGb} GB, so it may be very slow or fail.
              </p>
              <label className="os-brain-risk">
                <input type="checkbox" checked={useAnyway} onChange={(event) => setUseAnyway(event.target.checked)} />
                <span>Use it anyway; it may be very slow or fail</span>
              </label>
            </div>
          ) : null}
          {chosen && agentId === "claude" && variantNameFor(chosen.name) ? (
            <p className="os-mp-hint">
              Claude Code gets a settings copy named <span className="os-mono">{variantNameFor(chosen.name)}</span> in Ollama (no extra download) so it
              really has 64K of working memory.
            </p>
          ) : null}

          <div className="os-mp-actions">
            <button type="button" className="os-btn os-btn--primary" onClick={() => void apply()} disabled={!canUse}>
              {busy ? "Saving…" : inUse && inUse === selected ? "In use" : chosen ? `Use ${chosen.name} for ${label}` : `Use a local model for ${label}`}
            </button>
            <button type="button" className="os-btn os-btn--ghost" onClick={() => void load(true)} disabled={checking}>
              {checking ? "Checking…" : "Re-check"}
            </button>
          </div>
        </>
      ) : null}
      {error ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}
    </div>
  );
}
