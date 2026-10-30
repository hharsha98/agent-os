// The side panel's Files changed section (spec "SP4 Session extras", Changes panel, and the side panel table's "Files
// changed | files with +/−"; Task U7). The server reads git in the session's folder (Task X7); this section shows its
// answer: one row per file with its + and − line counts, a click on a row opens that file's read-only diff
// (DiffDialog), and a folder that is not a git project gets the spec's one line. It asks every 3 s while the session
// runs (paused while the window is hidden, useInterval) and once when the session has ended, one read at a time with
// the newest answer winning (latestRead.ts), each read with a time limit (sessionsApi.ts). After a good read, a failed
// one keeps the list under the page's own stale words (SP2 lessons). The panel gives it key={session.id}, so another
// session never shows this one's list, even for a moment.
import { useCallback, useEffect, useRef, useState } from "react";
import { File as FileIcon } from "lucide-react";
import { getChanges, sessionProblem } from "../../sessionsApi";
import type { ChangedFile, ChangesResult, SessionSummary } from "../../types";
import {
  changesFailed,
  changesPollMs,
  changesRetryMs,
  changesUnread,
  changesView,
  fileCounts,
  fileRowLabel,
  fileRowTitle,
  showsChanges,
  splitPath,
  STALE_LINE,
  UNREAD_LINE
} from "../changesShared";
import { failedLoad, loaded } from "../homeShared";
import type { Source } from "../homeShared";
import { createLatestRead } from "../latestRead";
import DiffDialog from "./DiffDialog";
import { useInterval } from "./useInterval";
import VisibleText from "./VisibleText";

export default function SessionChanges({ session }: { session: SessionSummary }) {
  if (!showsChanges(session)) return null;
  return <ChangesList session={session} />;
}

function ChangesList({ session }: { session: SessionSummary }) {
  const ended = session.status === "exited";
  const [source, setSource] = useState<Source<ChangesResult>>({ state: "loading" });
  // How many answers in a row said "git not read" (`git: null`): the server could not read git in the folder (it keeps
  // trying while the session runs). Past a few, the section says so instead of "…" for ever.
  const [notRead, setNotRead] = useState(0);
  const [reads] = useState(createLatestRead);
  // The file whose diff is open, or null.
  const [open, setOpen] = useState<ChangedFile | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const load = useCallback(
    (fresh: boolean) => {
      if (fresh) reads.cancel();
      void reads.run(
        () => getChanges(session.id),
        (outcome) => {
          if (!outcome.ok) {
            setSource((prev) => failedLoad(prev, sessionProblem(outcome.error)));
            return;
          }
          const unread = outcome.value.git === null;
          setNotRead((n) => (unread ? n + 1 : 0));
          // "Not read" after a good list (an ended session's one fresh read was cut) keeps the good list, under the
          // stale words, instead of wiping it.
          setSource((prev) => (unread && prev.state === "ok" && prev.data.git !== null ? failedLoad(prev, UNREAD_LINE) : loaded(outcome.value)));
        }
      );
    },
    [reads, session.id]
  );
  // A fresh read when the section appears, and again when the session ends (the list as the agent left it). A read
  // still waiting when the section goes away (another tab, a closed page) no longer counts.
  useEffect(() => {
    load(true);
    return () => reads.cancel();
  }, [load, reads, ended]);
  useInterval(() => load(false), changesPollMs(session));
  // An ended session is read once; when that read failed (no answer, or git could not be read) the page says "Try
  // again", so it is asked again every 30 s while it is shown, and at once when the window is shown again. A session
  // that has an answer is never asked again.
  const failed = changesFailed(source);
  useInterval(() => load(false), changesRetryMs(session, failed));
  useEffect(() => {
    if (!ended || !failed) return;
    const onVisible = () => {
      if (!document.hidden) load(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [ended, failed, load]);
  // The dialog gives the focus back to the row that opened it. That row is found by the path remembered when it was
  // clicked, not by asking the page what had the focus: a click does not focus a button in Safari's engine (the desktop
  // app's WebView), so there the dialog's own "give it back" has nothing to give back to. If the row left the list
  // meanwhile (the file left the changes), the first row that is left gets the focus.
  const openerPath = useRef<string | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
    (rows.find((el) => el.dataset.path === openerPath.current) ?? rows[0])?.focus();
  }, [open]);
  // Stable, so the open dialog is not asked to re-render and re-subscribe its keys at every poll.
  const closeDialog = useCallback(() => setOpen(null), []);
  const readAgain = useCallback(() => load(true), [load]);
  const view = changesView(source, { copy: Boolean(session.copyOf), unread: changesUnread(ended, notRead) });
  return (
    <section className="os-sess-panel__sec" aria-label="Files changed">
      <div className="os-sess-panel__rh">
        Files changed
        {view.count === null ? null : (
          <span className="os-sess-panel__hint os-mono">
            {view.count === "…" || view.count === "—" ? (
              <>
                <span aria-hidden="true">{view.count}</span>
                <span className="os-visually-hidden">{view.count === "…" ? "loading" : "unknown"}</span>
              </>
            ) : (
              view.count
            )}
          </span>
        )}
      </div>
      {view.stale ? (
        <p className="os-sess-panel__note" role="status">
          {STALE_LINE}
        </p>
      ) : null}
      {view.line ? <p className="os-sess-changes__line">{view.line}</p> : null}
      {view.files.length ? (
        <ul className="os-sess-changes" role="list" ref={listRef}>
          {view.files.map((file) => (
            <li key={file.path}>
              <FileRow
                file={file}
                onOpen={() => {
                  openerPath.current = file.path;
                  setOpen(file);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {view.more ? <p className="os-sess-changes__more">{view.more}</p> : null}
      {open ? <DiffDialog sessionId={session.id} file={open} onClose={closeDialog} onGone={readAgain} /> : null}
    </section>
  );
}

// One changed file: its icon, the path (the folder part dimmer; a long path ends in "…" and the tooltip has it all)
// and the + and − counts ("—" when git can't count, a binary file). The row's name says the counts in words.
function FileRow({ file, onOpen }: { file: ChangedFile; onOpen: () => void }) {
  const { dir, name } = splitPath(file.path);
  const counts = fileCounts(file);
  return (
    <button type="button" className="os-sess-file" onClick={onOpen} aria-haspopup="dialog" aria-label={fileRowLabel(file)} title={fileRowTitle(file)} data-path={file.path}>
      <FileIcon size={15} aria-hidden="true" />
      <span className="os-sess-file__path">
        {dir ? (
          <span className="os-sess-file__dir">
            <VisibleText text={dir} />
          </span>
        ) : null}
        <VisibleText text={name} />
      </span>
      <span className="os-sess-file__counts">
        {counts === null ? <span className="os-sess-file__zero">—</span> : null}
        {counts?.add ? <span className="os-sess-file__add">{counts.add}</span> : null}
        {counts?.del ? <span className={counts.delZero ? "os-sess-file__zero" : "os-sess-file__del"}>{counts.del}</span> : null}
      </span>
    </button>
  );
}
