// The right-hand side of the Sessions page for the selected session (the prototype's panel): the folder and agent, the
// state in words and its one line, the alert lines under it (hooks switched off and why, the trust line, basic alerts;
// panelAlertLines in alertsShared.ts), OpenClaw's approval cards for an open OpenClaw session (its own, and every card
// OpenClaw could not match to one session, marked "from OpenClaw", ruling R16), the Live meter (every row; Model,
// Context used, Plan used and Cost so far from Claude Code's status line, Task X2b; "—" where nothing is known, with the
// hint "— means unknown") and the footer with Recorded, Stop session and the keyboard hints (desktop app only). An ended
// session shows Resume conversation (or why it can't) and Open recording instead of Stop. The panel keeps its own
// one-second clock for "Running for", so the page (and its terminal) is not re-rendered for it. `note` is the Stop result
// note the page picks (panelStopNote: the server's own answer right after a Stop here, otherwise the session's own rule),
// shown under the state line.
import { useState } from "react";
import type { RefObject } from "react";
import { CircleDot, Folder, GitBranch, History, Info, OctagonX } from "lucide-react";
import type { SessionSummary } from "../../types";
import { collapseHomePath } from "../agentsShared";
import { APPROVALS_STALE, approvalsForSession, panelAlertLines } from "../alertsShared";
import { resumeConfirmCopy, sessionPanelLine, sessionStateWord } from "../sessionsShared";
import { meterRowLabel, meterRows, panelFolder, recordingKept } from "../sessionsPageShared";
import { useApprovals } from "../useApprovals";
import { ApprovalList } from "./ApprovalCard";
import Meter from "./Meter";
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
  const alertLines = panelAlertLines(session);
  // OpenClaw's cards are read only while this panel shows an open OpenClaw session (useApprovals asks every 3 s).
  const clawOpen = session.kind === "agent" && session.agentId === "openclaw" && !ended;
  const approvals = useApprovals(clawOpen);
  const listed = clawOpen && approvals.source.state === "ok" ? approvals.source.data : null;
  const cards = listed ? approvalsForSession(listed.approvals, session.id) : [];
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
          {alertLines.map((line) => (
            <p key={line} className="os-sess-panel__alert">
              <Info size={15} aria-hidden="true" />
              <span>{line}</span>
            </p>
          ))}
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
              {/* A removed recording (0 bytes) has no row in Runs; the line above already says so. */}
              {recordingKept(session.recordingBytes) ? (
                <button type="button" className="os-btn os-btn--secondary" onClick={onOpenRecording}>
                  <CircleDot size={16} aria-hidden="true" />
                  Open recording
                </button>
              ) : null}
              {blocked ? (
                <p id="os-sess-resume-why" className="os-sess-panel__why">
                  {blocked}
                </p>
              ) : null}
            </div>
          ) : null}
        </header>
        {clawOpen ? (
          // Hidden by CSS while empty (no card, no error).
          <div className="os-sess-panel__asks">
            <ApprovalList cards={cards} showFrom onAnswered={approvals.refresh} fallbackFocus={() => headingRef.current?.focus({ preventScroll: true })} />
            {listed?.error ? <p className="os-sess-panel__why">{listed.error}</p> : null}
            {/* A read that failed or timed out says so (the server's own sentence for OpenClaw is `listed.error` above), and a list that
                could not be refreshed says it is old: its cards keep their buttons, so the person must know. */}
            {approvals.source.state === "error" ? <p className="os-sess-panel__why">{approvals.source.message}</p> : null}
            {approvals.source.state === "ok" && approvals.source.stale ? <p className="os-sess-panel__why">{APPROVALS_STALE}</p> : null}
          </div>
        ) : null}
        <section className="os-sess-panel__sec" aria-label="Live meter">
          <div className="os-sess-panel__rh">
            Live meter<span className="os-sess-panel__hint">— means unknown</span>
          </div>
          {rows.map((row) =>
            row.gauge ? (
              <div key={row.id} className="os-sess-panel__gauge">
                <Meter label={row.dim ? `${row.label} · ${row.dim}` : row.label} value={row.gauge.percent / 100} tone={row.gauge.tone} detail={row.gauge.detail} />
              </div>
            ) : (
              <dl key={row.id} className="os-sess-kv">
                <div className="os-sess-kv__row">
                  <dt>{meterRowLabel(row)}</dt>
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
              </dl>
            )
          )}
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
