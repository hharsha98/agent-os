import { Cpu, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getRouterStatus, runProviderRouter } from "../api";
import type { ProviderRouterStatus, RouterRunResult } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function BrainPage() {
  const [status, setStatus] = useState<ProviderRouterStatus | null>(null);
  const [prompt, setPrompt] = useState("Summarize what Agent OS should do today in three bullets.");
  const [result, setResult] = useState<RouterRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void getRouterStatus()
      .then((data) => {
        setStatus(data);
        setError("");
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Router status failed."));
  }, []);

  async function dryRun() {
    setBusy(true);
    try {
      setResult(await runProviderRouter({ prompt, dryRun: true }));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dry-run route failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      kicker="BRAIN · MODEL ROUTER"
      title="Pick the engine. Keep the vehicle."
      hint="The video’s Layer 3 is routing: hard jobs to a strong model, cheap jobs to a free one. This page shows your local router. It dry-runs. It does not spend money unless you later approve a live call."
    >
      <HonestNote>
        Models change. The architecture should not. If a provider is missing, it stays Missing — we do not paint it green.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-status-grid">
        <article>
          <span>Router</span>
          <strong>{status?.status || "unknown"}</strong>
          <small>{status?.configured ? "Configured" : "Not fully configured"}</small>
        </article>
        <article>
          <span>Next provider</span>
          <strong>{status?.nextProvider?.label || "None"}</strong>
          <small>{status?.nextProvider?.model || "No model selected"}</small>
        </article>
        <article>
          <span>Dry-run default</span>
          <strong>{status?.dryRunDefault ? "On" : "Off"}</strong>
          <small>This page always sends dryRun: true</small>
        </article>
      </div>
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <strong className="aos-list-label">Providers</strong>
          {(status?.providers || []).length === 0 ? (
            <div className="aos-empty small"><p>No providers reported yet.</p></div>
          ) : (
            status?.providers.map((provider) => (
              <article key={provider.id} className="aos-panel">
                <strong>{provider.label}</strong>
                <span>{provider.configured ? provider.status : "Not configured"} · {provider.model || "no model"}</span>
                <p>{provider.publicSummary}</p>
              </article>
            ))
          )}
        </aside>
        <section className="aos-panel">
          <div className="aos-panel-head"><div><span>DRY-RUN ROUTE</span><h2>See the plan, not a live spend</h2></div></div>
          <label className="aos-field">
            <span>Prompt</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <button className="aos-primary" onClick={() => void dryRun()} disabled={busy || !prompt.trim()}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <Cpu size={16} />} Dry-run route
          </button>
          {result ? (
            <div className="aos-memory-content">
              <p><strong>Mode:</strong> {result.mode} · <strong>Provider:</strong> {result.provider || "n/a"} · <strong>Model:</strong> {result.model || "n/a"}</p>
              <p>{result.message}</p>
            </div>
          ) : null}
        </section>
      </div>
    </PageFrame>
  );
}
