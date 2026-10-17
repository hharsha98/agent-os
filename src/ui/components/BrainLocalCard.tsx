// The Local (Ollama) half of the "AI brain" choice: private, runs on this
// computer. It shows the models already installed with a plain verdict for
// each (an agent needs a model that can call tools, and a model under 7B
// parameters failed every tool call in a real test), an HONEST memory figure
// for each (what it needs once it has the 64K "working memory" agents need,
// next to this computer's memory), and suggests one model to download only
// when it genuinely fits. Agent OS sets up the 64K itself, by adding a
// settings-only copy of the chosen model to Ollama (no extra download).
// Downloads ask first, showing the size, then show real progress.
import { useEffect, useState } from "react";
import BrainAgentChecks from "./BrainAgentChecks";
import StatusMark from "./StatusMark";
import { useInterval } from "./useInterval";
import type { BrainAgentId, LocalBrainSummary, LocalFit, LocalModel, SetupJob } from "../../setupApi";
import { cancelSetupJob, friendlyError, getOllamaModels, getSetupJob, startOllamaDownload } from "../../setupApi";
import type { BrainAgentLine } from "../brainShared";
import { formatBytes, formatContext, formatGb, giveItTo, variantNameFor } from "../brainShared";

type Download = { phase: "idle" } | { phase: "confirming" } | { phase: "running"; job: SetupJob } | { phase: "failed"; message: string };

export function verdictMark(id: LocalModel["verdict"]["id"]) {
  if (id === "good") return "ok" as const;
  if (id === "no_tools") return "error" as const;
  return "warn" as const;
}

export function fitMark(fit: LocalFit) {
  if (fit === "comfortable") return "ok" as const;
  if (fit === "tight") return "warn" as const;
  if (fit === "too_big") return "error" as const;
  return "unknown" as const;
}

export const FIT_PHRASE: Record<LocalFit, string> = {
  comfortable: "fits this computer",
  tight: "tight for this computer",
  too_big: "too big for this computer",
  unknown: "fit unknown"
};

// "needs ~14.3 GB · tight for this computer (24 GB)"
export function memoryLine(model: LocalModel, computerGb: number) {
  const { memoryAt64kGb, fit } = model.memory;
  if (memoryAt64kGb === null) return "Memory needed at 64K: unknown (Ollama didn't report this model's settings)";
  const computer = computerGb > 0 ? ` (${computerGb} GB)` : "";
  return `needs ~${memoryAt64kGb} GB · ${FIT_PHRASE[fit]}${computer}`;
}

export default function BrainLocalCard({
  agents,
  assigned,
  onToggleAgent,
  riskAccepted,
  onRiskChange,
  busy,
  preferredModel,
  onGive,
  error
}: {
  agents: BrainAgentLine[];
  assigned: Set<BrainAgentId>;
  onToggleAgent: (id: BrainAgentId, checked: boolean) => void;
  riskAccepted: boolean;
  onRiskChange: (value: boolean) => void;
  busy: boolean;
  // The installed good model that fits comfortably, if any (pre-selects a
  // radio in this card; it never moves an agent onto Local).
  preferredModel?: string | null;
  onGive: (give: { model: string; acceptLocalFit?: boolean }) => void;
  error?: string;
}) {
  const [summary, setSummary] = useState<LocalBrainSummary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState("");
  const [useAnyway, setUseAnyway] = useState(false);
  const [download, setDownload] = useState<Download>({ phase: "idle" });

  async function load(refresh = false, pickAfter?: string) {
    setChecking(true);
    setLoadError("");
    try {
      const next = await getOllamaModels(refresh);
      setSummary(next);
      const usable = (m: LocalModel) => m.verdict.selectable && variantNameFor(m.name) !== null;
      setSelected((current) => {
        if (pickAfter && next.models.some((m) => m.name === pickAfter && usable(m))) return pickAfter;
        if (current && next.models.some((m) => m.name === current && usable(m))) return current;
        const wanted = preferredModel && next.models.find((m) => m.name === preferredModel && usable(m));
        return (wanted || next.models.find((m) => m.verdict.id === "good" && m.memory.fit !== "too_big" && usable(m)))?.name || "";
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
  }, []);

  // A different model needs its own "use it anyway".
  useEffect(() => {
    setUseAnyway(false);
  }, [selected]);

  // While a download runs, read its real byte counts every second.
  const runningJob = download.phase === "running" ? download.job : null;
  useInterval(
    async () => {
      if (!runningJob) return;
      try {
        const job = await getSetupJob(runningJob.id);
        if (job.status === "running") {
          setDownload({ phase: "running", job });
        } else if (job.status === "succeeded") {
          setDownload({ phase: "idle" });
          void load(true, job.model || undefined);
        } else if (job.status === "cancelled") {
          setDownload({ phase: "idle" });
        } else {
          setDownload({ phase: "failed", message: job.steps[0]?.error || "The download failed." });
        }
      } catch {
        // a blip; the next tick tries again
      }
    },
    runningJob ? 1000 : null
  );

  async function startDownload(model: string) {
    try {
      const job = await startOllamaDownload(model);
      setDownload({ phase: "running", job });
    } catch (err) {
      setDownload({ phase: "failed", message: friendlyError(err, "Couldn't start the download.") });
    }
  }

  async function stopDownload() {
    if (!runningJob) return;
    try {
      await cancelSetupJob(runningJob.id);
    } catch {
      // the next poll shows the true state either way
    }
    setDownload({ phase: "idle" });
  }

  const models = summary?.models ?? [];
  const computerGb = summary?.memoryGb ?? 0;
  const chosen = models.find((m) => m.name === selected);
  const chosenFit = chosen?.memory.fit;
  const variant = chosen ? variantNameFor(chosen.name) : null;
  const labels = agents.filter((a) => a.installed && assigned.has(a.id)).map((a) => a.label);
  const openclawTicked = assigned.has("openclaw") && Boolean(agents.find((a) => a.id === "openclaw")?.installed);
  const needsAnyway = chosenFit === "too_big";
  const canGive =
    Boolean(chosen?.verdict.selectable) &&
    Boolean(variant) &&
    labels.length > 0 &&
    (!openclawTicked || riskAccepted) &&
    (!needsAnyway || useAnyway) &&
    !busy &&
    download.phase !== "running";
  const advice = summary?.download;

  const pull = runningJob?.pull;
  const pct = pull && pull.total > 0 ? Math.min(100, Math.floor((pull.completed / pull.total) * 100)) : null;

  return (
    <section className="os-panel os-brain-card" aria-labelledby="os-brain-local-title">
      <header className="os-brain-card__head">
        <h3 id="os-brain-local-title">Local (Ollama)</h3>
        <span className="os-brain-card__badges">
          <span className="os-chip">Private</span>
        </span>
      </header>

      <ul className="os-brain-card__facts">
        <li>Runs on this computer, so your messages never leave it. Free once downloaded.</li>
        <li>Agents need 64K of working memory. Agent OS sets that up for the model you pick (no extra download).</li>
      </ul>

      {error ? (
        <p className="os-brain-card__error" role="alert">
          <StatusMark kind="error" /> {error}
        </p>
      ) : null}

      {loadError ? (
        <p className="os-brain-card__error" role="alert">
          <StatusMark kind="error" /> {loadError}{" "}
          <button type="button" className="os-brain-link" onClick={() => void load(true)}>
            Try again
          </button>
        </p>
      ) : null}

      {!summary && !loadError ? <p className="os-brain-card__hint">Looking for Ollama on this computer…</p> : null}

      {summary && !summary.available ? (
        <div className="os-brain-card__connect">
          <p className="os-brain-card__hint">
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
        <div className="os-brain-card__give">
          {models.length ? (
            <ul className="os-brain-models" aria-label="Models installed in Ollama">
              {models.map((m) => {
                const nameOk = variantNameFor(m.name) !== null;
                const selectable = m.verdict.selectable && nameOk;
                return (
                  <li key={m.name}>
                    <label className={`os-brain-model${selectable ? "" : " os-brain-model--off"}`}>
                      <input
                        type="radio"
                        name="os-brain-local-model"
                        checked={selected === m.name}
                        disabled={!selectable}
                        onChange={() => setSelected(m.name)}
                      />
                      <span className="os-brain-model__main">
                        <strong className="os-mono">{m.name}</strong>
                        {formatGb(m.sizeBytes) ? <span className="os-brain-model__size">{formatGb(m.sizeBytes)}</span> : null}
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
                      {m.verdict.selectable && !nameOk ? (
                        <span className="os-brain-model__verdict os-brain-model__note">
                          Agent OS can&apos;t make its 64K copy of a model with this name, so it can&apos;t be used here.
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="os-brain-card__hint">
              <StatusMark kind="unknown" label="none" /> No models are installed in Ollama yet.
            </p>
          )}

          {chosen?.verdict.id === "too_small" ? (
            <p className="os-brain-warning" role="note">
              This model is small. Agents often call tools wrongly with it, so answers may be wrong. A bigger model, or OpenRouter, works better.
            </p>
          ) : null}
          {chosenFit === "tight" ? (
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
                <input type="checkbox" checked={useAnyway} onChange={(e) => setUseAnyway(e.target.checked)} />
                <span>Use it anyway; it may be very slow or fail</span>
              </label>
            </div>
          ) : null}
          {chosen && variant ? (
            <p className="os-brain-card__hint">
              Agent OS adds a settings copy named <span className="os-mono">{variant}</span> to Ollama (no extra download). Remove it any time with{" "}
              <span className="os-mono">ollama rm {variant}</span>.
            </p>
          ) : null}

          <div className="os-brain-download">
            {advice ? (
              advice.installed ? (
                <p className="os-brain-card__hint">
                  <StatusMark kind="ok" /> Suggested for this computer ({computerGb} GB memory): <strong className="os-mono">{advice.model}</strong>, and it&apos;s
                  already installed.
                </p>
              ) : download.phase === "idle" || download.phase === "failed" ? (
                <>
                  <p className="os-brain-card__hint">
                    Suggested for this computer ({computerGb} GB memory): <strong className="os-mono">{advice.model}</strong>, a {advice.downloadGb} GB download that
                    needs about {advice.memoryAt64kGb} GB to run at 64K.
                  </p>
                  {download.phase === "failed" ? (
                    <p className="os-brain-card__error" role="alert">
                      <StatusMark kind="error" /> {download.message}
                    </p>
                  ) : null}
                  <div>
                    <button type="button" className="os-btn os-btn--secondary" onClick={() => setDownload({ phase: "confirming" })} disabled={busy}>
                      Download {advice.model}…
                    </button>
                  </div>
                </>
              ) : download.phase === "confirming" ? (
                <div className="os-brain-confirm" role="group" aria-label="Confirm download">
                  <p>
                    This downloads <strong>{advice.downloadGb} GB</strong> through Ollama and uses that much disk space. It can take a while. Download{" "}
                    <span className="os-mono">{advice.model}</span>?
                  </p>
                  <div className="os-brain-card__row">
                    <button type="button" className="os-btn os-btn--primary" onClick={() => void startDownload(advice.model)}>
                      Download {advice.downloadGb} GB
                    </button>
                    <button type="button" className="os-btn os-btn--ghost" onClick={() => setDownload({ phase: "idle" })}>
                      Not now
                    </button>
                  </div>
                </div>
              ) : (
                <div className="os-brain-progress" role="status">
                  <p className="os-brain-card__hint">
                    Downloading <span className="os-mono">{runningJob?.model}</span>…{" "}
                    {pull && pull.total > 0 ? `${formatBytes(pull.completed)} of ${formatBytes(pull.total)} (${pct}%)` : "starting"}
                  </p>
                  <div className="os-brain-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="Download progress">
                    <span className="os-brain-bar__fill" style={{ width: `${pct ?? 0}%` }} />
                  </div>
                  <div>
                    <button type="button" className="os-btn os-btn--ghost" onClick={() => void stopDownload()}>
                      Cancel download
                    </button>
                  </div>
                </div>
              )
            ) : summary.downloadAdvice ? (
              <p className="os-brain-card__hint">
                <StatusMark kind="unknown" label="no local download" /> {summary.downloadAdvice}
              </p>
            ) : null}
          </div>

          <BrainAgentChecks agents={agents} assigned={assigned} onToggle={onToggleAgent} disabled={busy} name="local" />
          {openclawTicked ? (
            <label className="os-brain-risk">
              <input type="checkbox" checked={riskAccepted} onChange={(e) => onRiskChange(e.target.checked)} />
              <span>I understand OpenClaw can act on this computer. Agent OS will switch it to ask before running commands.</span>
            </label>
          ) : null}
          <button
            type="button"
            className="os-btn os-btn--primary os-brain-card__cta"
            onClick={() => chosen && onGive({ model: chosen.name, ...(needsAnyway ? { acceptLocalFit: true } : {}) })}
            disabled={!canGive}
          >
            {busy ? "Starting…" : giveItTo(labels)}
          </button>
        </div>
      ) : null}
    </section>
  );
}
