import { Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { getMemoryState, searchMemory } from "../api";
import type { MemoryRecord, MemorySearchResult, MemoryState } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function MemoryPage() {
  const [state, setState] = useState<MemoryState | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<MemorySearchResult | null>(null);
  const [opened, setOpened] = useState<MemoryRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void getMemoryState()
      .then((data) => {
        setState(data);
        setError("");
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load memory."));
  }, []);

  async function runSearch() {
    setBusy(true);
    try {
      setSearch(await searchMemory({ query, limit: 12 }));
      setOpened(null);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  const titles = state?.memories.slice(0, 20) || [];

  return (
    <PageFrame
      kicker="MEMORY / VAULT · LOCAL"
      title="Counts and search first. Content only when you open it."
      hint="This is local Agent OS memory. Obsidian is not connected. Private contents are not dumped on first view."
    >
      <HonestNote>Vault here means the Agent OS memory store, not an Obsidian vault sync.</HonestNote>
      <div className="aos-status-grid">
        <article>
          <span>Memories</span>
          <strong>{state?.summary.total ?? 0}</strong>
          <small>{state?.summary.active ?? 0} active</small>
        </article>
        <article>
          <span>Vector provider</span>
          <strong>{state?.vector.provider || "unknown"}</strong>
          <small>{state?.vector.status || "not loaded"}</small>
        </article>
        <article>
          <span>Last updated</span>
          <strong>{state?.updatedAt ? state.updatedAt.slice(0, 10) : "Never"}</strong>
          <small>Obsidian: not connected</small>
        </article>
      </div>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-phase-toolbar">
        <label className="aos-field">
          <span>Search memory</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tone, customer, project…" onKeyDown={(event) => event.key === "Enter" && void runSearch()} />
        </label>
        <button className="aos-primary" onClick={() => void runSearch()} disabled={busy}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <Search size={16} />} Search
        </button>
      </div>
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <strong className="aos-list-label">Titles only</strong>
          {titles.length === 0 ? (
            <div className="aos-empty small"><p>No memories stored yet.</p></div>
          ) : (
            titles.map((item) => (
              <button key={item.id} className={opened?.id === item.id ? "active" : ""} onClick={() => setOpened(item)}>
                <strong>{item.title}</strong>
                <span>{item.type} · {item.privacy} · {item.agentId}</span>
              </button>
            ))
          )}
        </aside>
        <section className="aos-panel">
          <div className="aos-panel-head"><div><span>OPENED ITEM</span><h2>{opened?.title || search?.results[0]?.title || "Nothing opened"}</h2></div></div>
          {opened || search?.results.length ? (
            <div className="aos-memory-content">
              {(opened ? [opened] : search?.results || []).slice(0, opened ? 1 : 8).map((item) => (
                <article key={item.id}>
                  <strong>{item.title}</strong>
                  <small>{item.type} · {item.privacy} · {item.updatedAt}</small>
                  <p>{item.content}</p>
                </article>
              ))}
            </div>
          ) : (
            <div className="aos-empty small"><p>Search or click a title to reveal content. The default view stays counts-only.</p></div>
          )}
        </section>
      </div>
    </PageFrame>
  );
}
