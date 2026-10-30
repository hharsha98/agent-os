import { Copy, FolderOpen, Lock, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getWorkspaceFileDetail, undoTeamAction } from "../../api";
import { useApiBlobUrl, useApiText } from "../../apiBlob";
import type { WorkspaceListedFile, WorkspaceListing } from "../../types";
import { canRevealInFinder, revealInFinder } from "../desktop";
import { withTimeout } from "../homeShared";
import MiniMarkdown from "../miniMarkdown";
import {
  PREVIEW_FETCH_MAX_BYTES,
  PREVIEW_MAX_BYTES,
  TYPE_INFO,
  absolutePathOf,
  copyPathOf,
  displayPath,
  formatSize,
  previewProblem,
  savedByView,
  typeOf,
  undoDoneText,
  undoProblemText,
  undoTarget,
  whenTitle,
  type Notice,
  type SavedByView
} from "../workspaceShared";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";
import { agoLabel } from "./RelativeTime";

// "Saved by" in words. Nobody on record reads "—" (and "Unknown" for a screen reader).
export function SavedByWords({ view }: { view: SavedByView }) {
  if (view.unknown) {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="os-visually-hidden">Unknown</span>
      </>
    );
  }
  return (
    <>
      {view.who}
      {view.detail ? ` (${view.detail})` : ""}
    </>
  );
}

type Detail =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; text: string }
  | { state: "error"; problem: string; gone: boolean };

// A request that does not answer in time stops waiting, so the pane never
// loads for ever (the preview) or sits on a closed question (Undo).
const DETAIL_TIMEOUT_MS = 15000;
const UNDO_TIMEOUT_MS = 20000;

interface Props {
  file: WorkspaceListedFile;
  roots: WorkspaceListing["roots"];
  // Asks the page for a fresh list. `false` means "do not tell the person the file went missing".
  onRefresh: (announceMissing?: boolean) => Promise<WorkspaceListing | null>;
  onNotice: (notice: Notice | null) => void;
  // True when the person just opened this file (a click, or a note they saved): the
  // file's name takes keyboard focus once, so the next Tab goes into the pane and not
  // back into the list. A file opened by a link or the address does not take focus.
  autoFocus?: boolean;
  onFocused?: () => void;
}

// The right-hand pane for one file: who saved it, Copy path, Show in Finder
// (desktop only), Undo this save (Team Room saves only), and the preview. The
// page gives it key={file.id}, so everything here starts fresh for each file.
export default function WorkspacePreview({ file, roots, onRefresh, onNotice, autoFocus = false, onFocused }: Props) {
  const type = typeOf(file);
  const saved = savedByView(file.savedBy);
  const target = undoTarget(file.savedBy);
  const absolute = absolutePathOf(file, roots);
  const canReveal = canRevealInFinder() && Boolean(absolute);
  const needsText = file.kind === "text" || file.kind === "html";
  // The server sends the text of a file only up to 256 KB. Asking for more would
  // come back empty and read as "This file is empty", which would be untrue.
  const tooBig = needsText && file.size > PREVIEW_MAX_BYTES;
  const canToggle = type === "md" || type === "html";
  const rawUrl = `/api/workspace/raw?id=${encodeURIComponent(file.id)}`;

  const [mode, setMode] = useState<"view" | "source">("view");
  const [detail, setDetail] = useState<Detail>({ state: "idle" });
  const [retry, setRetry] = useState(0);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const source = canToggle && mode === "source";
  // An <img>, <audio>, <video> or <iframe> cannot send the page key header, so the file is fetched with it and shown
  // from an address the page makes (R32). Which kind of address depends on the file's type: see apiBlob.ts (R33).
  const lockedHtml = type === "html" && !source;
  const showsFile = type === "image" || type === "audio" || type === "video" || type === "pdf" || lockedHtml;
  // A file this big is not fetched whole just to be previewed (R33).
  const tooBigToFetch = showsFile && file.size > PREVIEW_FETCH_MAX_BYTES;
  const fileSrc = useApiBlobUrl(showsFile && !lockedHtml && !tooBigToFetch ? rawUrl : null).src;
  // The locked HTML view draws the file's text inside a sandboxed frame; the file never gets an address.
  const htmlText = useApiText(lockedHtml && !tooBigToFetch ? rawUrl : null);

  useEffect(() => {
    if (!autoFocus) return;
    // The page has already scrolled the pane into view (below the fixed top bar); focus must not scroll again.
    headingRef.current?.focus({ preventScroll: true });
    onFocused?.();
    // Once, when the pane opens for this file. The page gives it key={file.id}.
  }, []);

  // A finished Undo can take its own button away (the file is back to an old copy, so
  // it has no Undo any more). If that leaves focus on the page itself, it goes to the file's name.
  useEffect(() => {
    if (!undone || target) return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [undone, target]);

  useEffect(() => {
    if (!needsText || tooBig) {
      setDetail({ state: "idle" });
      return undefined;
    }
    let live = true;
    setDetail({ state: "loading" });
    withTimeout(getWorkspaceFileDetail(file.id), DETAIL_TIMEOUT_MS).then(
      (result) => {
        if (live) setDetail({ state: "ready", text: result.previewText || "" });
      },
      (error) => {
        if (!live) return;
        const problem = previewProblem(error);
        setDetail({ state: "error", problem: problem.text, gone: problem.gone });
      }
    );
    return () => {
      live = false;
    };
  }, [file.id, file.updatedAt, needsText, tooBig, retry]);

  async function copyPath() {
    const text = copyPathOf(file, roots);
    try {
      await navigator.clipboard.writeText(text);
      onNotice({ tone: "ok", text: "Copied the path." });
    } catch {
      onNotice({ tone: "warn", text: `Could not copy. The path is ${text}` });
    }
  }

  async function reveal() {
    if (!absolute) return;
    try {
      await revealInFinder(absolute);
    } catch {
      onNotice({ tone: "warn", text: `Finder could not be opened. The file is at ${absolute}` });
    }
  }

  async function undo() {
    if (!target) return;
    setUndoBusy(true);
    try {
      const result = await withTimeout(undoTeamAction(target.roomId, target.actionId), UNDO_TIMEOUT_MS);
      setUndoOpen(false);
      const next = await onRefresh(false);
      const still = next ? next.files.some((item) => item.id === file.id) : null;
      setUndone(true);
      // What happened comes from the server's own record of the save (`created`, `updated`),
      // not from guessing it out of the reloaded list.
      onNotice({ tone: "ok", text: undoDoneText(result?.action, displayPath(file), still) });
    } catch (error) {
      setUndoOpen(false);
      // Look at the list again first, then say what happened: a failed reload
      // sets its own note, and the Undo answer is the one that matters here.
      await onRefresh(false);
      onNotice({ tone: "danger", text: undoProblemText(error) });
    } finally {
      setUndoBusy(false);
    }
  }

  function body() {
    if (tooBigToFetch) {
      return <p className="os-ws__plain">This file is larger than 200 MB, so Agent OS does not preview it here.</p>;
    }
    if (type === "image") return <img className="os-ws__media" src={fileSrc} alt={file.name} />;
    if (type === "audio") return <audio className="os-ws__media" controls src={fileSrc} />;
    if (type === "video") return <video className="os-ws__media" controls src={fileSrc} />;
    if (type === "pdf") return <iframe className="os-ws__frame os-ws__frame--tall" title={`PDF: ${file.name}`} src={fileSrc} />;
    if (type === "other") {
      return <p className="os-ws__plain">This file type has no inline preview. It stays in the workspace, and Agent OS does not open or download it.</p>;
    }
    if (lockedHtml) {
      return (
        <>
          <p className="os-ws__lock" role="note">
            <Lock size={17} aria-hidden="true" />
            <span>
              <b>Locked preview.</b> This HTML is drawn inside a sandbox. Scripts and forms are switched off in this preview.
            </span>
          </p>
          <iframe className="os-ws__frame" sandbox="" title={`Locked preview of ${displayPath(file)}`} srcDoc={htmlText.text ?? ""} />
        </>
      );
    }
    if (tooBig) {
      return <p className="os-ws__plain">This file is larger than 256 KB, so Agent OS does not show its text here.</p>;
    }
    if (detail.state === "loading" || detail.state === "idle") {
      return (
        <p className="os-ws__plain" role="status">
          Loading preview…
        </p>
      );
    }
    if (detail.state === "error") {
      return (
        <Banner
          tone="danger"
          title="This file could not be opened"
          actions={
            detail.gone ? (
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void onRefresh(true)}>
                Refresh the list
              </button>
            ) : (
              <button type="button" className="os-btn os-btn--secondary" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </button>
            )
          }
        >
          {detail.problem}
        </Banner>
      );
    }
    if (!detail.text.trim()) return <p className="os-ws__plain">This file is empty.</p>;
    if (type === "md" && !source) {
      return (
        <div className="os-ws__page">
          <MiniMarkdown source={detail.text} />
        </div>
      );
    }
    return (
      <div className="os-ws__page os-ws__page--src">
        <pre>{detail.text}</pre>
      </div>
    );
  }

  return (
    <div>
      <h2 className="os-ws__title os-mono" ref={headingRef} tabIndex={-1}>
        {displayPath(file)}
      </h2>
      <div className="os-ws__meta">
        <span className="os-ws__tag">{TYPE_INFO[type].label}</span>
        <span className="os-mono">{formatSize(file.size)}</span>
        <span className="os-ws__vbar" aria-hidden="true" />
        <span>
          Saved by{" "}
          <b>
            <SavedByWords view={saved} />
          </b>
        </span>
        <span className="os-ws__vbar" aria-hidden="true" />
        <span title={whenTitle(file.updatedAt) || undefined}>{agoLabel(file.updatedAt)}</span>
      </div>
      <div className="os-ws__tools">
        {canToggle ? (
          <div className="os-ws__seg" role="group" aria-label="View">
            <button type="button" aria-pressed={!source} onClick={() => setMode("view")}>
              {type === "html" ? "Locked preview" : "Preview"}
            </button>
            <button type="button" aria-pressed={source} onClick={() => setMode("source")}>
              Source
            </button>
          </div>
        ) : null}
        <div className="os-ws__tool-buttons">
          <button type="button" className="os-btn os-btn--secondary" onClick={() => void copyPath()}>
            <Copy size={15} aria-hidden="true" />
            Copy path
          </button>
          {canReveal ? (
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void reveal()}>
              <FolderOpen size={15} aria-hidden="true" />
              Show in Finder
            </button>
          ) : null}
          {target ? (
            <button type="button" className="os-btn os-btn--secondary" onClick={() => setUndoOpen(true)} aria-haspopup="dialog">
              <Undo2 size={15} aria-hidden="true" />
              Undo this save
            </button>
          ) : null}
        </div>
      </div>
      {body()}
      {undoOpen && target ? (
        <AgentConfirmModal
          title="Undo this save?"
          confirmLabel="Undo save"
          danger
          busy={undoBusy}
          onConfirm={() => void undo()}
          onClose={() => {
            if (!undoBusy) setUndoOpen(false);
          }}
        >
          <p className="os-mono os-ws__modal-path">{displayPath(file)}</p>
          <p>
            The Team Room{saved.detail ? ` (${saved.detail})` : ""} saved this file. Undo puts it back as it was before that save. If the Team Room created
            the file, Undo removes it.
          </p>
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
