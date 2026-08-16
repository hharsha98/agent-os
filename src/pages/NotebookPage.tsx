import { Loader2, NotebookTabs, Repeat } from "lucide-react";
import { useEffect, useState } from "react";
import { addMemory, createSelfModuleItem, getSelfModule } from "../api";
import { navigateTo } from "../nav";
import type { SelfModuleState } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function NotebookPage() {
  const [state, setState] = useState<SelfModuleState | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setState(await getSelfModule("notebook"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load notebook.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createNote() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      setState(await createSelfModuleItem("notebook", { title: title.trim(), body }));
      await addMemory({
        title: title.trim(),
        content: body,
        agentId: "notebook",
        type: "semantic",
        privacy: "private",
        source: "notebook",
        tags: ["notebook", "loop"]
      }).catch(() => undefined);
      setTitle("");
      setBody("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      kicker="NOTEBOOK · LOCAL NOTES"
      title="Simple notes now. NotebookLM-style audio later."
      hint="This is the local notebook store. It is not Google NotebookLM. Audio overviews, infographics, and mind maps are not configured."
    >
      <HonestNote>Future NotebookLM integration would land here. Until then, missing stays missing. Open Loop to include these notes in today’s briefing.</HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <div className="aos-field">
            <span>Title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Research note" />
          </div>
          <div className="aos-field">
            <span>Body</span>
            <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="What did you learn?" />
          </div>
          <button className="aos-primary" onClick={() => void createNote()} disabled={busy || !title.trim()}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <NotebookTabs size={16} />} Save note
          </button>
          <button className="aos-secondary" onClick={() => navigateTo("loop")}>
            <Repeat size={16} /> Open Loop
          </button>
        </aside>
        <section>
          {(state?.items || []).filter((item) => !(item.tags || []).includes("journal") && !/journal/i.test(item.title || "")).length === 0 ? (
            <div className="aos-empty">
              <NotebookTabs size={22} />
              <strong>No notebook items yet</strong>
              <p>Audio overviews and mind maps are future work. Local notes will list here when you add them.</p>
            </div>
          ) : (
            <div className="aos-note-list">
              {(state?.items || []).filter((item) => !(item.tags || []).includes("journal") && !/journal/i.test(item.title || "")).map((item) => (
                <article key={item.id} className="aos-panel">
                  <div className="aos-panel-head"><div><span>{item.updatedAt}</span><h2>{item.title}</h2></div></div>
                  <p>{item.body || item.notes || "No body"}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </PageFrame>
  );
}
