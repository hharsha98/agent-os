import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { writeWorkspaceFile } from "../../api";
import type { WorkspaceFile, WorkspaceListedFile } from "../../types";
import { withTimeout } from "../homeShared";
import { NOTE_EXTS, noteFileName, saveOutcomeKnown, saveProblemText, type NoteExt } from "../workspaceShared";
import Banner from "./Banner";

interface Props {
  // null until the list has loaded: the form needs it to notice a name that is already taken.
  files: WorkspaceListedFile[] | null;
  loadState: "loading" | "ready" | "error";
  // null until the status request has answered: then the form claims nothing about the public demo.
  demoPublic: boolean | null;
  // The page keeps this form mounted for as long as it is open, and hides it while a
  // file is open, so a draft survives a look at another file. Hidden means not on screen.
  hidden: boolean;
  // Each press of the page's "New note" button adds one to this number. Focus moves to
  // the Name field when the number changes, never merely because the form appeared.
  focusToken: number;
  // The form's heading, so the page can send keyboard focus there.
  headingRef?: RefObject<HTMLHeadingElement>;
  onSaved: (file: WorkspaceFile, fileName: string) => void;
  // Called when a save got no clear answer (a server error, or none at all), so
  // the note may or may not have been written. The page reloads the list, so
  // the person can see, and a second try notices a name that is now taken.
  onUnsure?: () => void;
}

// A save that does not answer in time stops waiting and says it does not know.
const SAVE_TIMEOUT_MS = 20000;

const todayIso = () => new Date().toISOString().slice(0, 10);

// Notes always go into notes/ (as this page has always done). The file name is
// cleaned here exactly as the server will clean it, so "Saved as" is the truth
// and a name that is already taken is noticed before anything is overwritten.
export default function WorkspaceNoteForm({ files, loadState, demoPublic, hidden, focusToken, headingRef, onSaved, onUnsure }: Props) {
  const [name, setName] = useState("");
  const [ext, setExt] = useState<NoteExt>("md");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // `known` is true only when the server refused the note before writing anything.
  const [problem, setProblem] = useState<{ text: string; known: boolean } | null>(null);
  const [askReplace, setAskReplace] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  // Only a change in the number is a request; a form that is shown again keeps focus where it is.
  const seenToken = useRef(focusToken);
  useEffect(() => {
    if (focusToken === seenToken.current) return;
    seenToken.current = focusToken;
    nameRef.current?.focus();
  }, [focusToken]);

  const fileName = noteFileName(name, ext, todayIso());
  const target = `notes/${fileName}`;
  const taken = Boolean(files?.some((file) => file.id.toLowerCase() === `workspace/${target}`.toLowerCase()));
  const canSave = loadState === "ready" && body.trim().length > 0 && !busy;

  // A different name or type is a different question: ask again.
  useEffect(() => setAskReplace(false), [fileName]);

  // When the question appears, focus goes to the safe answer, so a second Enter
  // can never replace a file by accident.
  useEffect(() => {
    if (askReplace) keepRef.current?.focus();
  }, [askReplace]);

  async function save() {
    // The fields are read-only while this runs, but the form clears only what was sent.
    const sent = { name, body };
    setBusy(true);
    setProblem(null);
    try {
      const saved = await withTimeout(writeWorkspaceFile({ folder: "notes", name: fileName, content: sent.body }), SAVE_TIMEOUT_MS);
      setName((now) => (now === sent.name ? "" : now));
      setBody((now) => (now === sent.body ? "" : now));
      setAskReplace(false);
      onSaved(saved.file, fileName);
    } catch (error) {
      // The text stays in the form. When the server never said no, the note may
      // be in the workspace anyway, so the page looks at the list again.
      const known = saveOutcomeKnown(error);
      setProblem({ text: saveProblemText(error), known });
      setAskReplace(false);
      if (!known) onUnsure?.();
    } finally {
      setBusy(false);
    }
  }

  // Save never replaces a file by itself. When the name is taken it only asks;
  // the "Replace file" button in the question is the one way to go ahead.
  function submit() {
    if (!canSave) return;
    if (taken) {
      setAskReplace(true);
      return;
    }
    void save();
  }

  function clear() {
    if (busy) return;
    setName("");
    setBody("");
    setProblem(null);
    setAskReplace(false);
    nameRef.current?.focus();
  }

  const hint =
    loadState === "loading"
      ? "Saving is available once the file list has loaded."
      : loadState === "error"
        ? "Saving is available once Agent OS can be reached."
        : "Only .md, .txt and .html files can be saved here.";

  return (
    <div hidden={hidden}>
      <h2 className="os-ws__h2" ref={headingRef} tabIndex={-1}>
        New note
      </h2>
      <p className="os-ws__lede2">
        Write something down. It is saved in <code className="os-mono">notes/</code> inside the workspace.
      </p>
      <form
        className="os-ws__form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="os-ws__name-row">
          <label className="os-field">
            <span className="os-field__label">Name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
              placeholder={demoPublic === true ? "visitor-note" : `note-${todayIso()}`}
              readOnly={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="os-field">
            <span className="os-field__label">Type</span>
            <select
              value={ext}
              onChange={(event) => {
                if (busy) return;
                setExt(event.target.value as NoteExt);
                setProblem(null);
              }}
            >
              {NOTE_EXTS.map((option) => (
                <option key={option} value={option}>
                  .{option}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="os-ws__saveas">
          Saved as <span className="os-mono">{target}</span>
        </p>
        <label className="os-field">
          <span className="os-field__label">Note</span>
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setProblem(null);
            }}
            rows={7}
            readOnly={busy}
            placeholder="Start typing. Markdown works in .md files."
          />
        </label>
        {askReplace ? (
          <Banner
            tone="warn"
            title={`${target} already exists`}
            actions={
              <>
                <button type="button" className="os-btn os-btn--danger" onClick={() => void save()} disabled={busy}>
                  Replace file
                </button>
                <button ref={keepRef} type="button" className="os-btn os-btn--ghost" onClick={() => nameRef.current?.focus()}>
                  Choose another name
                </button>
              </>
            }
          >
            Saving replaces what is in it.
          </Banner>
        ) : null}
        {problem ? (
          <Banner tone="danger" title={problem.known ? "The note was not saved" : "The note may not have been saved"}>
            {problem.text}
          </Banner>
        ) : null}
        <div className="os-ws__form-actions">
          <button type="submit" className="os-btn os-btn--primary" disabled={!canSave}>
            <Check size={16} aria-hidden="true" />
            {busy ? "Saving…" : "Save note"}
          </button>
          <button type="button" className="os-btn os-btn--ghost" onClick={clear} disabled={busy}>
            Clear
          </button>
          <p className="os-ws__hint">{hint}</p>
        </div>
      </form>
    </div>
  );
}
