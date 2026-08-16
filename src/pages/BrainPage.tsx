import { Cpu, Loader2, Repeat, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { addMemory, getMemoryContext, getRouterStatus, runProviderRouter } from "../api";
import { navigateTo } from "../nav";
import type { ProviderRouterStatus, RouterRunResult } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function BrainPage() {
  const [status, setStatus] = useState<ProviderRouterStatus | null>(null);
  const [prompt, setPrompt] = useState("Summarize what Agent OS should do today in three bullets.");
  const [result, setResult] = useState<RouterRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
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
      const vault = await getMemoryContext({ query: prompt, limit: 6 }).catch(() => null);
      const routedPrompt = vault?.promptBlock ? `${vault.promptBlock}\n\nUser prompt:\n${prompt}` : prompt;
      const next = await runProviderRouter({ prompt: routedPrompt, dryRun: true });
      setResult(next);
      setNotice(vault?.count ? `Read ${vault.count} memory note${vault.count === 1 ? "" : "s"} before routing.` : "");
      setError("");
      await addMemory({
        title: `Brain route ${new Date().toISOString().slice(0, 10)}`,
        content: `Prompt: ${prompt}\nMode: ${next.mode}\nProvider: ${next.provider || "n/a"}\nModel: ${next.model || "n/a"}\n\n${next.message}`,
        agentId: "brain",
        type: "episodic",
        privacy: "private",
        source: "brain-loop",
        tags: ["loop", "brain"]
      }).catch(() => undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dry-run route failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveToMemory() {
    if (!result || saving) return;
    setSaving(true);
    try {
      await addMemory({
        title: `Brain route ${new Date().toISOString().slice(0, 10)}`,
        content: `Prompt: ${prompt}\nMode: ${result.mode}\nProvider: ${result.provider || "n/a"}\nModel: ${result.model || "n/a"}\n\n${result.message}`,
        agentId: "brain",
        type: "episodic",
        privacy: "private",
        source: "brain-loop",
        tags: ["loop", "brain"]
      });
      setNotice("Saved into local Memory. Loop can pick this up. This was still a dry-run.");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the route plan.");
    } finally {
      setSaving(false);
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
          <button className="aos-secondary" onClick={() => void saveToMemory()} disabled={!result || saving}>
            {saving ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save plan to Memory
          </button>
          <button className="aos-secondary" onClick={() => navigateTo("loop")}>
            <Repeat size={16} /> Open Loop
          </button>
          {notice ? <p className="aos-honest-note">{notice}</p> : null}
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
