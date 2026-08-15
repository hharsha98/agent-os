import { FolderOpen, Loader2, RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getWorkspaceFileDetail, getWorkspaceListing } from "../api";
import type { WorkspaceFile, WorkspaceListing } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 104857.6) / 10} MB`;
}

export default function WorkspacePage() {
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => listing?.files.find((file) => file.id === selectedId) || null,
    [listing, selectedId]
  );

  async function refresh() {
    setBusy(true);
    try {
      const data = await getWorkspaceListing({ query, kind: kind === "all" ? "" : kind });
      setListing(data);
      setError("");
      if (selectedId && !data.files.some((file) => file.id === selectedId)) {
        setSelectedId(data.files[0]?.id || null);
        setPreviewText("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workspace listing failed.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function openFile(file: WorkspaceFile) {
    setSelectedId(file.id);
    setPreviewText("");
    if (file.kind === "html" || file.kind === "text") {
      try {
        const detail = await getWorkspaceFileDetail(file.id);
        setPreviewText(detail.previewText || "");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not preview this file.");
      }
    }
  }

  const rawUrl = selected ? `/api/workspace/raw?id=${encodeURIComponent(selected.id)}` : "";

  return (
    <PageFrame
      kicker="WORKSPACE · LOCAL ASSETS"
      title="Generated files stay in a sandbox you can preview."
      hint="This page only lists ~/.hermes-agent-os/workspace and exports. It will not browse the rest of your Mac."
      actions={
        <button className="aos-secondary" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <RefreshCcw size={16} />} Refresh
        </button>
      }
    >
      <HonestNote>
        Empty is honest. When an agent later saves HTML, images, audio, or video here, it will show up in this list.
      </HonestNote>
      <div className="aos-phase-toolbar">
        <label className="aos-field">
          <span>Search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by file name" onKeyDown={(event) => event.key === "Enter" && void refresh()} />
        </label>
        <label className="aos-field">
          <span>Type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All kinds</option>
            <option value="html">HTML</option>
            <option value="image">Images</option>
            <option value="audio">Audio</option>
            <option value="video">Video</option>
            <option value="pdf">PDF</option>
            <option value="text">Text</option>
          </select>
        </label>
        <button className="aos-primary" onClick={() => void refresh()} disabled={busy}>Filter</button>
      </div>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-workspace-layout">
        <aside className="aos-workspace-list">
          {listing?.empty ? (
            <div className="aos-empty">
              <FolderOpen size={22} />
              <strong>No generated files yet</strong>
              <p>Save assets into the Agent OS workspace folder and they will appear here.</p>
            </div>
          ) : (
            (listing?.files || []).map((file) => (
              <button key={file.id} className={file.id === selectedId ? "active" : ""} onClick={() => void openFile(file)}>
                <strong>{file.name}</strong>
                <span>{file.kind} · {formatSize(file.size)} · {file.root}</span>
              </button>
            ))
          )}
        </aside>
        <section className="aos-workspace-preview">
          {!selected ? (
            <div className="aos-empty">
              <strong>Select a file to preview</strong>
              <p>HTML opens in a sandboxed frame. Images, audio, video, and PDFs use the browser’s built-in players.</p>
            </div>
          ) : (
            <>
              <header>
                <div>
                  <span>{selected.publicPath}</span>
                  <h3>{selected.name}</h3>
                </div>
                <small>{selected.kind} · {formatSize(selected.size)}</small>
              </header>
              {selected.kind === "image" ? <img src={rawUrl} alt={selected.name} /> : null}
              {selected.kind === "audio" ? <audio controls src={rawUrl} /> : null}
              {selected.kind === "video" ? <video controls src={rawUrl} /> : null}
              {selected.kind === "pdf" ? <iframe title={selected.name} src={rawUrl} /> : null}
              {selected.kind === "html" ? <iframe title={selected.name} src={rawUrl} sandbox="" /> : null}
              {selected.kind === "text" ? <pre>{previewText || "Loading text preview…"}</pre> : null}
              {selected.kind === "other" ? <p className="aos-honest-note">This file type has no inline preview. It stays in the sandbox and is not downloaded automatically.</p> : null}
            </>
          )}
        </section>
      </div>
    </PageFrame>
  );
}
