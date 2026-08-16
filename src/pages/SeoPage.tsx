import { Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createSelfModuleItem,
  getExecutionGateStatus,
  getModule,
  getSelfModule,
  runSeoAudit,
  runSeoDiscovery,
  runSeoRankSnapshot
} from "../api";
import type { ExecutionGateStatus, RuntimeModule, SelfModuleItem, SelfModuleState } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function SeoPage() {
  const [state, setState] = useState<SelfModuleState | null>(null);
  const [firecrawl, setFirecrawl] = useState<RuntimeModule | null>(null);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const selected = useMemo(
    () => state?.items.find((item) => item.id === selectedId) || state?.items[0] || null,
    [state, selectedId]
  );
  const dryRun = !gate?.enabled;
  const firecrawlReady = Boolean(firecrawl?.configured);

  async function refresh(nextSelected?: string) {
    try {
      const [seo, module, execution] = await Promise.all([
        getSelfModule("seo"),
        getModule("provider-firecrawl").catch(() => null),
        getExecutionGateStatus().catch(() => null)
      ]);
      setState(seo);
      setFirecrawl(module);
      setGate(execution);
      setSelectedId(nextSelected || selectedId || seo.items[0]?.id || null);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load SEO.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createBrief() {
    if (!title.trim()) return;
    setBusy("create");
    try {
      const next = await createSelfModuleItem("seo", { title: title.trim(), url, keyword });
      setState(next);
      setSelectedId(next.items[0]?.id || null);
      setTitle("");
      setUrl("");
      setKeyword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save brief.");
    } finally {
      setBusy("");
    }
  }

  async function runAction(kind: "audit" | "discover" | "rank") {
    if (!selected) return;
    setBusy(kind);
    try {
      const payload = { dryRun, keyword };
      const result = kind === "audit"
        ? await runSeoAudit(selected.id, payload)
        : kind === "discover"
          ? await runSeoDiscovery(selected.id, payload)
          : await runSeoRankSnapshot(selected.id, payload);
      setState(result.state);
      setSelectedId(result.brief.id);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "SEO action failed.");
    } finally {
      setBusy("");
    }
  }

  const latestAudit = selected?.seoHistory?.[0];
  const latestDiscovery = selected?.discoveryHistory?.[0];
  const latestRank = selected?.rankHistory?.[0];

  return (
    <PageFrame
      kicker="SEO · PRODUCTION LAYER"
      title="Local SEO desk. Firecrawl stays honest."
      hint="This uses the existing SEO APIs. Dry-run is the default until you enable the execution gate. Missing Firecrawl is Not configured — never Connected."
    >
      <div className="aos-status-grid">
        <article>
          <span>Firecrawl</span>
          <strong>{firecrawlReady ? "Key saved" : "Not configured"}</strong>
          <small>{firecrawl?.publicSummary || "No Firecrawl key on this Mac."}</small>
        </article>
        <article>
          <span>Run mode</span>
          <strong>{dryRun ? "Dry-run" : "Live"}</strong>
          <small>{gate?.publicSummary || "Execution gate status did not load."}</small>
        </article>
        <article>
          <span>Briefs</span>
          <strong>{state?.summary.total ?? 0}</strong>
          <small>{selected?.keyword || "Pick a brief"}</small>
        </article>
      </div>
      <HonestNote>
        This is a local equivalent of the video’s SEO desk, not Keyword Tools as a product. Live scrape/search spends Firecrawl and model credits only when the execution gate is on.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <div className="aos-field">
            <span>Title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Homepage audit" />
          </div>
          <div className="aos-field">
            <span>URL</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" />
          </div>
          <div className="aos-field">
            <span>Keyword</span>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="agent os" />
          </div>
          <button className="aos-secondary" onClick={() => void createBrief()} disabled={busy !== "" || !title.trim()}>
            {busy === "create" ? <Loader2 className="aos-spin" size={16} /> : <Search size={16} />} Save brief
          </button>
          {(state?.items || []).length === 0 ? (
            <div className="aos-empty small"><strong>No briefs yet</strong><p>Save a URL and keyword first.</p></div>
          ) : (
            state?.items.map((item: SelfModuleItem) => (
              <button key={item.id} className={item.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                <strong>{item.title}</strong>
                <span>{item.keyword || "no keyword"} · {item.status || "planned"}</span>
              </button>
            ))
          )}
        </aside>
        <section className="aos-studio-grid">
          <article className="aos-panel">
            <div className="aos-panel-head">
              <div><span>AUDIT</span><h2>{latestAudit?.status || "Ready"}</h2></div>
              <button className="aos-primary" disabled={!selected || busy !== ""} onClick={() => void runAction("audit")}>
                {busy === "audit" ? <Loader2 className="aos-spin" size={16} /> : null} {dryRun ? "Dry-run audit" : "Live audit"}
              </button>
            </div>
            <p>{latestAudit?.summary || "Audit uses Firecrawl scrape plus the provider router. Missing keys stay Not configured."}</p>
            {(latestAudit?.recommendations || []).length ? <ul>{(latestAudit?.recommendations || []).slice(0, 6).map((item) => <li key={item}>{item}</li>)}</ul> : null}
          </article>
          <article className="aos-panel">
            <div className="aos-panel-head">
              <div><span>DISCOVER</span><h2>{latestDiscovery?.status || "Ready"}</h2></div>
              <button className="aos-secondary" disabled={!selected || busy !== ""} onClick={() => void runAction("discover")}>
                {busy === "discover" ? <Loader2 className="aos-spin" size={16} /> : null} Discover
              </button>
            </div>
            <p>{latestDiscovery?.message || selected?.searchStatus || "Keyword discovery needs a Firecrawl search key. Without it this stays Not configured."}</p>
          </article>
          <article className="aos-panel">
            <div className="aos-panel-head">
              <div><span>RANK</span><h2>{latestRank?.status || "Ready"}</h2></div>
              <button className="aos-secondary" disabled={!selected || busy !== ""} onClick={() => void runAction("rank")}>
                {busy === "rank" ? <Loader2 className="aos-spin" size={16} /> : null} Rank snapshot
              </button>
            </div>
            <p>{latestRank?.message || "Rank snapshots are a search snapshot, not a live Google rank tracker product."}</p>
          </article>
        </section>
      </div>
    </PageFrame>
  );
}
