import { BookOpen, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createSelfModuleItem, getSelfModule } from "../api";
import type { SelfModuleState } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export default function JournalPage() {
  const [state, setState] = useState<SelfModuleState | null>(null);
  const [title, setTitle] = useState(`Journal ${todayStamp()}`);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setState(await getSelfModule("notebook"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load journal.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    try {
      setState(await createSelfModuleItem("notebook", { title: title.trim(), body, tags: ["journal"] }));
      setBody("");
      setTitle(`Journal ${todayStamp()}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save journal.");
    } finally {
      setBusy(false);
    }
  }

  const entries = (state?.items || []).filter((item) => (item.tags || []).includes("journal") || /journal/i.test(item.title || ""));

  return (
    <PageFrame
      kicker="JOURNAL · DAILY CONTEXT"
      title="Write the day down. That is how the loop starts."
      hint="The public Hermes Agent OS guide puts a journal next to memory. This is a local daily log in the same notebook store. It is not Omi capturing your screen."
    >
      <HonestNote>
        Omi (wearable / screen capture) is not installed. You type the note. That still feeds Layer 7 if you also save chat replies into Memory.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-split-layout">
        <aside className="aos-side-list">
          <div className="aos-field">
            <span>Title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="aos-field">
            <span>What happened today</span>
            <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Decisions, customer notes, what to tell agents tomorrow…" />
          </div>
          <button className="aos-primary" onClick={() => void save()} disabled={busy || !title.trim() || !body.trim()}>
            {busy ? <Loader2 className="aos-spin" size={16} /> : <BookOpen size={16} />} Save journal
          </button>
        </aside>
        <section>
          {entries.length === 0 ? (
            <div className="aos-empty"><strong>No journal entries yet</strong><p>Empty is honest. The first save will show up here.</p></div>
          ) : (
            entries.map((item) => (
              <article key={item.id} className="aos-panel">
                <div className="aos-panel-head"><div><span>{item.updatedAt}</span><h2>{item.title}</h2></div></div>
                <p>{item.body || item.notes || ""}</p>
              </article>
            ))
          )}
        </section>
      </div>
    </PageFrame>
  );
}
