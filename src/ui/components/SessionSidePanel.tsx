// The right-hand side of the Sessions page for the selected session (the prototype's panel, in its SP3 form): the
// folder and agent, the state in words and its one line, the Live meter (every row; "—" where the source arrives
// later, with the hint "— means unknown"), and the footer with Recorded, Stop session and the keyboard hints (desktop
// app only). An ended session shows Resume conversation (or why it can't) and Open recording instead of Stop. The
// panel keeps its own one-second clock for "Running for", so the page (and its terminal) is not re-rendered for it.
// `note` is the Stop result note the page picks (panelStopNote: the server's own answer right after a Stop here,
// otherwise the session's own rule), shown under the state line.
import { useState } from "react";
import type { RefObject } from "react";
import { CircleDot, Folder, GitBranch, History, OctagonX } from "lucide-react";
import type { SessionSummary } from "../../types";
import { collapseHomePath } from "../agentsShared";
import { resumeConfirmCopy, sessionPanelLine, sessionStateWord } from "../sessionsShared";
import { meterRows, panelFolder } from "../sessionsPageShared";
import StatusWord from "./StatusWord";
import { useInterval } from "./useInterval";

export default function SessionSidePanel({
  session,
  note,
  hints,
  headingRef,
  onStop,
  onResume,
  onOpenRecording
}: {
  session: SessionSummary;
  note: string | null;
  hints: Array<{ keys: string; word: string }>;
  headingRef: RefObject<HTMLHeadingElement>;
  onStop: () => void;
  onResume: () => void;
  onOpenRecording: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const ended = session.status === "exited";
  useInterval(() => setNow(Date.now()), ended ? null : 1000);
  const word = sessionStateWord(session);
  const rows = meterRows(session, now);
  // Why Resume can't be pressed: the server's reason (decision Q36), as the Resume confirm words it (Task U1).
  const blocked = ended ? resumeConfirmCopy(session).blocked : null;
  const where = panelFolder(session);
  return (
    <aside className="os-sess-panel" aria-label="Session details">
      <div className="os-sess-panel__scroll">
        <header className="os-sess-panel__head">
          <div className="os-sess-panel__folder">
            <Folder size={20} aria-hidden="true" />
            <h2 ref={headingRef} tabIndex={-1} className="os-trunc" title={session.folderShown === false ? where : collapseHomePath(session.folder)}>
              {where}
            </h2>
            <span className="os-sess-panel__agent">{session.agentLabel}</span>
          </div>
          {session.branch ? (
            <p className="os-sess-panel__branch">
              <GitBranch size={16} aria-hidden="true" />
              <code className="os-mono os-trunc" title={session.branch}>
                {session.branch}
              </code>
            </p>
          ) : null}
          <p className="os-sess-panel__stat">
            <StatusWord state={word.state} label={word.label} />
          </p>
          <p className="os-sess-panel__line">{sessionPanelLine(session, now)}</p>
          {note ? (
            <p className="os-sess-panel__note" role="status">
              {note}
            </p>
          ) : null}
          {ended ? (
            <div className="os-sess-panel__ended">
              <button
                type="button"
                className="os-btn os-btn--primary"
                onClick={onResume}
                disabled={blocked !== null}
                aria-describedby={blocked ? "os-sess-resume-why" : undefined}
              >
                <History size={16} aria-hidden="true" />
                Resume conversation
              </button>
              <button type="button" className="os-btn os-btn--secondary" onClick={onOpenRecording}>
                <CircleDot size={16} aria-hidden="true" />
                Open recording
              </button>
              {blocked ? (
                <p id="os-sess-resume-why" className="os-sess-panel__why">
                  {blocked}
                </p>
              ) : null}
            </div>
          ) : null}
        </header>
        <section className="os-sess-panel__sec" aria-label="Live meter">
          <div className="os-sess-panel__rh">
            Live meter<span className="os-sess-panel__hint">— means unknown</span>
          </div>
          <dl className="os-sess-kv">
            {rows.map((row) => (
              <div key={row.id} className="os-sess-kv__row">
                <dt>{row.label}</dt>
                <dd>
                  {row.value === null ? (
                    <>
                      <span className="os-mono os-sess-kv__dash" aria-hidden="true">
                        —
                      </span>
                      <span className="os-visually-hidden">unknown</span>
                    </>
                  ) : (
                    <>
                      {row.id === "time" ? <span className="os-mono">{row.value}</span> : row.value}
                      {row.dim ? <span className="os-sess-kv__dim"> · {row.dim}</span> : null}
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <footer className="os-sess-panel__foot">
        <div className="os-sess-panel__rec">
          <span className="os-sess-panel__recorded">
            <CircleDot size={15} aria-hidden="true" />
            Recorded
          </span>
          {!ended ? (
            <button type="button" className="os-btn os-btn--danger os-sess-panel__stop" onClick={onStop}>
              <OctagonX size={16} aria-hidden="true" />
              Stop session
            </button>
          ) : null}
        </div>
        {hints.length ? (
          <div className="os-sess-keys" role="group" aria-label="Keyboard shortcuts">
            {hints.map((hint) => (
              <span key={hint.keys}>
                <kbd className="os-kbd">{hint.keys}</kbd>
                {hint.word}
              </span>
            ))}
          </div>
        ) : null}
      </footer>
    </aside>
  );
}
