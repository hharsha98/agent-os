// The changes panel's read-only diff (spec "SP4 Session extras", Changes panel: "click a file for a read-only diff";
// Task U7). It shows one file's `git diff` as the server read it (Task X7): added lines green, removed lines red, and
// every line keeps its own + or - so the colour is never the only sign. Nothing here can change a file: the diff is
// text in a box (focusable, so the keyboard can scroll it) and Close is the only button. It is AgentConfirmModal
// without a confirm button: Escape, Close or a click outside shuts it, Tab stays inside, and the focus goes back to
// the file's row. The diff is read once, when the dialog opens; it does not follow later edits. A hidden character in a
// name or a line (a right-to-left override, an escape code) is drawn as a visible token, so what is shown is what is
// there (VisibleText). The diff is parsed once per answer and its rows are not rebuilt when the panel's list refreshes
// behind the open dialog every 3 s.
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { changeMissing, getDiff, sessionProblem } from "../../sessionsApi";
import type { ChangedFile, DiffResult } from "../../types";
import { DIFF_LOADING, diffView, splitPath } from "../changesShared";
import type { DiffLine } from "../changesShared";
import AgentConfirmModal from "./AgentConfirmModal";
import VisibleText from "./VisibleText";

type DiffState = { state: "loading" } | { state: "ok"; result: DiffResult } | { state: "error"; message: string };

// The diff's lines. A memo: the panel behind the dialog re-renders on every poll, and a diff can hold thousands of lines.
const DiffLines = memo(function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} className={`os-diff__line os-diff__line--${line.kind}`}>
          <VisibleText text={line.text} />
        </span>
      ))}
    </>
  );
});

export default function DiffDialog({
  sessionId,
  file,
  onClose,
  onGone
}: {
  sessionId: string;
  file: ChangedFile;
  onClose: () => void;
  // The file left the session's changes after the list was read (404 change_missing): the panel reads the list again.
  onGone: () => void;
}) {
  const [value, setValue] = useState<DiffState>({ state: "loading" });
  const pathId = useId();
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    // The dialog can close before the answer comes: then nothing is updated.
    let alive = true;
    getDiff(sessionId, file.path).then(
      (result) => {
        if (alive) setValue({ state: "ok", result });
      },
      (error: unknown) => {
        if (!alive) return;
        setValue({ state: "error", message: sessionProblem(error) });
        if (changeMissing(error)) gone.current();
      }
    );
    return () => {
      alive = false;
    };
  }, [sessionId, file.path]);
  const view = useMemo(() => (value.state === "ok" ? diffView(value.result) : null), [value]);
  const name = splitPath(file.path).name || file.path;
  const title = <VisibleText text={name} />;
  return (
    <AgentConfirmModal title={title} onClose={onClose} cancelLabel="Close">
      <div className="os-diff-view">
        <p id={pathId} className="os-diff-view__path os-mono">
          <VisibleText text={file.path} />
        </p>
        {value.state === "loading" ? (
          <p className="os-diff-view__state" role="status">
            {DIFF_LOADING}
          </p>
        ) : null}
        {value.state === "error" ? (
          <p className="os-diff-view__state" role="alert">
            {value.message}
          </p>
        ) : null}
        {view?.notes.map((note) => (
          <p key={note} className="os-diff-view__note">
            {note}
          </p>
        ))}
        {view && view.lines.length ? (
          <pre role="region" className="os-diff" tabIndex={0} aria-labelledby={pathId}>
            <DiffLines lines={view.lines} />
          </pre>
        ) : null}
      </div>
    </AgentConfirmModal>
  );
}
