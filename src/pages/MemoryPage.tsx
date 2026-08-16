import { FolderOpen, Loader2, Repeat, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { exportMemory, exportWorkspaceVault, getMemoryState, searchMemory } from "../api";
import { navigateTo, queryParam } from "../nav";
import type { MemoryRecord, MemorySearchResult, MemoryState } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

type MemoryFilter = "all" | "loop" | "briefing";

function filterFromUrl(): MemoryFilter {
  const value = queryParam("filter");
  if (value === "loop" || value === "briefing") return value;
  return "all";
}

function matchesFilter(item: MemoryRecord, filter: MemoryFilter) {
  if (filter === "all") return true;
  if (filter === "briefing") return item.source === "loop-desk" || (item.tags || []).includes("briefing");
  return item.source === "chat-loop" || ((item.tags || []).includes("loop") && item.source !== "loop-desk");
}

export default function MemoryPage() {
  const [state, setState] = useState<MemoryState | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MemoryFilter>(filterFromUrl);
  const [search, setSearch] = useState<MemorySearchResult | null>(null);
  const [opened, setOpened] = useState<MemoryRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function syncFilter() {
      setFilter(filterFromUrl());
    }
    window.addEventListener("aos-navigate", syncFilter);
    window.addEventListener("popstate", syncFilter);
    return () => {
      window.removeEventListener("aos-navigate", syncFilter);
      window.removeEventListener("popstate", syncFilter);
    };
  }, []);

  useEffect(() => {
    void getMemoryState()
      .then((data) => {
        setState(data);
        setError("");
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load memory."));
  }, []);

  function applyFilter(next: MemoryFilter) {
    setFilter(next);
    setOpened(null);
    navigateTo("memory", next === "all" ? {} : { filter: next });
  }

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

  async function downloadExport() {
    setBusy(true);
    try {
      const data = await exportMemory({ includePrivate: true });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `agent-os-memory-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function writeVault() {
    setBusy(true);
    try {
      const data = await exportWorkspaceVault();
      setError("");
      navigateTo("workspace", { folder: "vault" });
      setOpened(null);
      void data;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Vault markdown export failed.");
    } finally {
      setBusy(false);
    }
  }

  const titles = useMemo(
    () => (state?.memories || []).filter((item) => matchesFilter(item, filter)).slice(0, 20),
    [state, filter]
  );
  const loopCount = (state?.memories || []).filter((item) => matchesFilter(item, "loop")).length;
  const briefingCount = (state?.memories || []).filter((item) => matchesFilter(item, "briefing")).length;

  return (
    <PageFrame
      kicker="MEMORY / VAULT · LOCAL"
      title="Counts and search first. Content only when you open it."
      hint="This is the local Agent OS vault. Chat, Brain, and Goals read it before answering. Loop briefings land here. Obsidian is an optional extra, not required."
    >
      <HonestNote>Vault here means the Agent OS memory store on this Mac. Chat/Brain/Goals read it before answering. Obsidian sync is optional and not wired.</HonestNote>
      <div className="aos-status-grid">
        <article>
          <span>Memories</span>
          <strong>{state?.summary.total ?? 0}</strong>
          <small>{state?.summary.active ?? 0} active</small>
        </article>
        <article>
          <span>Loop notes</span>
          <strong>{loopCount}</strong>
          <small>From Chat auto-save</small>
        </article>
        <article>
          <span>Briefings</span>
          <strong>{briefingCount}</strong>
          <small>From the Loop desk</small>
        </article>
        <article>
          <span>Vector provider</span>
          <strong>{state?.vector.provider || "unknown"}</strong>
          <small>{state?.vector.status || "not loaded"} · Obsidian: not connected</small>
        </article>
      </div>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-phase-toolbar">
        <label className="aos-field">
          <span>Search memory</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tone, customer, project…" onKeyDown={(event) => event.key === "Enter" && void runSearch()} />
        </label>
        <button className={filter === "all" ? "aos-primary" : "aos-secondary"} onClick={() => applyFilter("all")}>All</button>
        <button className={filter === "loop" ? "aos-primary" : "aos-secondary"} onClick={() => applyFilter("loop")}>Loop</button>
        <button className={filter === "briefing" ? "aos-primary" : "aos-secondary"} onClick={() => applyFilter("briefing")}>Briefings</button>
        <button className="aos-secondary" onClick={() => navigateTo("loop")}>
          <Repeat size={16} /> Open Loop
        </button>
        <button className="aos-primary" onClick={() => void runSearch()} disabled={busy}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <Search size={16} />} Search
        </button>
        <button className="aos-secondary" onClick={() => void downloadExport()} disabled={busy}>
          Export JSON
        </button>
        <button className="aos-secondary" onClick={() => void writeVault()} disabled={busy}>
          <FolderOpen size={16} /> Write vault markdown
        </button>
      </div>
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <strong className="aos-list-label">Titles only</strong>
          {titles.length === 0 ? (
            <div className="aos-empty small"><p>{filter === "all" ? "No memories stored yet." : "Nothing in this filter yet. Send a Chat reply or save a Loop briefing."}</p></div>
          ) : (
            titles.map((item) => (
              <button key={item.id} className={opened?.id === item.id ? "active" : ""} onClick={() => setOpened(item)}>
                <strong>{item.title}</strong>
                <span>{item.source || item.type} · {item.privacy} · {item.agentId}</span>
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
                  <small>{item.type} · {item.privacy} · {item.source || "manual"} · {item.updatedAt}</small>
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
