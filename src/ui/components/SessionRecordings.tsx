// Runs → Session recordings: every recorded session, newest first (GET /api/recordings), joined with the shared
// sessions list for Resume. Every row offers "Replay" (Task U11), which shows that recording's replay here in place of
// the list (?replay=<session id>, ReplayPlayer.tsx). A live row also offers "Open live session"; an ended one "Resume
// conversation" (or says why it can't). An update recording ("<agent> update") is never resumed, so it offers Replay
// only. "Open recording" on an ended Sessions tab lands here with that row highlighted (?highlight=<session id>; the
// row also says aria-current), and the row takes keyboard focus once; leaving a replay marks its row the same way. A
// resumed session is one recording: Recorded is when it first started and Length covers all its parts
// (recordingsShared.ts). Resume asks first: from a row with SP3's words (resumeConfirmCopy), from the replay header
// with the prototype's "Resume this conversation?" (replayResumeCopy, spec SP4). A Resume the server refuses as
// impossible (session_live, not_resumable) shuts the dialog's Resume button and keeps the server's own sentence.
// Delete recording (replay header only, off while the session runs) asks first too, and a refusal another try can't
// change (recording_live, recording_missing, unknown_session) shuts its button the same way. listRecordings,
// resumeSession and deleteRecording carry their own time limits (sessionsApi.ts, SESSION_LIMITS_MS). Where sessions do
// not run (the public demo, a shared server) the route answers 404 not_available: the tab says so once and stops
// asking, instead of "isn't responding".
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleDot, History, Play, SquareTerminal } from "lucide-react";
import { ApiError } from "../../api";
import { navigateTo } from "../../nav";
import { deleteRecording, listRecordings, resumeSession, sessionGotNoAnswer } from "../../sessionsApi";
import type { SessionSummary } from "../../types";
import { collapseHomePath } from "../agentsShared";
import { askToFocusNextSession, createdSessionId } from "../newSession";
import { CAP_NOTE, EMPTY_BODY, EMPTY_TITLE, isRecording, readRecordings, recordedAt, recordingLength, recordingPlace, rowAction } from "../recordingsShared";
import type { RecordingRow, RecordingsBody } from "../recordingsShared";
import { RECORDING_GONE, deleteConfirmCopy, deleteProblem, isFinalDeleteRefusal, replayResumeCopy } from "../replayShared";
import { isImpossibleResume, resumeConfirmCopy, sessionTitle } from "../sessionsShared";
import { actionProblem, isLookOnlyRefusal } from "../sessionsPageShared";
import { useSessionsList } from "../useSessionsList";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";
import EmptyState from "./EmptyState";
import ReplayPlayer from "./ReplayPlayer";
import { TimeAgo } from "./RelativeTime";
import StatusWord from "./StatusWord";
import { tabDomId } from "./Tabs";
import { useInterval } from "./useInterval";
import VisibleText from "./VisibleText";

export type RecordingsState =
  | { state: "loading" }
  | { state: "ok"; data: RecordingsBody; stale: boolean }
  | { state: "error" }
  | { state: "unavailable" };

// The answer outside local mode (requireLocalMode, Task S8): sessions and their recordings do not exist here.
function notAvailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.message === "not_available";
}

// The list, read while the tab is open: every 5 s and one read at a time. After a good read, a failed one keeps the
// rows under a warning (SP2 lessons). A not_available answer is final: nothing is asked again.
export function useRecordings(active: boolean): { value: RecordingsState; reload: () => void } {
  const [value, setValue] = useState<RecordingsState>({ state: "loading" });
  const alive = useRef(true);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const body = readRecordings(await listRecordings());
      if (!body) throw new Error("not a list");
      if (alive.current) setValue({ state: "ok", data: body, stale: false });
    } catch (error) {
      if (!alive.current) return;
      if (notAvailable(error)) setValue({ state: "unavailable" });
      else setValue((prev) => (prev.state === "ok" ? { ...prev, stale: true } : { state: "error" }));
    } finally {
      busy.current = false;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const asking = active && value.state !== "unavailable";
  useEffect(() => {
    if (asking) void load();
  }, [asking, load]);
  useInterval(() => void load(), asking ? 5000 : null);
  return { value, reload: () => void load() };
}

function whereWords(row: RecordingRow): string {
  return recordingPlace(row, collapseHomePath);
}

// The Resume dialog's words: SP3's from a row, the prototype's from the replay header (spec SP4, "Recordings in Runs").
function resumeWords(session: SessionSummary, from: "row" | "replay"): { title: string; body: string[]; warning: string | null } {
  if (from === "replay") {
    return replayResumeCopy({
      agent: session.agentLabel || session.agentId || "Agent",
      folder: session.folderShown === false ? null : collapseHomePath(session.folder) || null,
      fallback: session.resume?.fallback === true
    });
  }
  const copy = resumeConfirmCopy(session);
  return { title: copy.title, body: [copy.body], warning: copy.warning };
}

export default function SessionRecordings({
  value,
  highlight,
  replay = "",
  onReload,
  onCloseReplay
}: {
  value: RecordingsState;
  highlight: string;
  // The session id whose replay is shown in place of the list ("" for the list).
  replay?: string;
  onReload: () => void;
  onCloseReplay?: () => void;
}) {
  const sessionsList = useSessionsList();
  const sessionsState: "loading" | "ok" | "error" = sessionsList.available ? sessionsList.source.state : "ok";
  const sessions: SessionSummary[] =
    sessionsList.source.state === "ok" && Array.isArray(sessionsList.source.data.sessions) ? sessionsList.source.data.sessions : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const [now, setNow] = useState(() => Date.now());
  // `blocked`: the server refused the Resume as impossible (isImpossibleResume), so pressing it again cannot work.
  const [resuming, setResuming] = useState<{ session: SessionSummary; busy: boolean; error: string; toSafety: boolean; blocked: boolean } | null>(null);
  // Where Resume was pressed (a row or the replay header): the dialog's words follow it.
  const [resumeFrom, setResumeFrom] = useState<"row" | "replay">("row");
  // Delete recording, from the replay header. `blocked`: a refusal another try cannot change (isFinalDeleteRefusal).
  const [deleting, setDeleting] = useState<{ row: RecordingRow; busy: boolean; error: string; blocked: boolean } | null>(null);
  // True once a delete worked: its dialog then leaves the keyboard alone (the Delete button goes away with the replay).
  const deleted = useRef(false);
  const alive = useRef(true);
  const highlighted = useRef("");
  const anyLive = value.state === "ok" && value.data.rows.some((row) => row.live);
  useInterval(() => setNow(Date.now()), anyLive ? 1000 : null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The row asked for comes into view and takes focus, once per request.
  useEffect(() => {
    if (!highlight || highlighted.current === highlight || value.state !== "ok") return;
    const row = document.querySelector<HTMLElement>(`[data-recording="${CSS.escape(highlight)}"]`);
    if (!row) return;
    highlighted.current = highlight;
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
  }, [highlight, value]);

  // The keyboard was on the dialog's main button when the server refused in a way another try can't change, and that
  // button is now shut: it goes to Cancel, so it neither falls to the page behind the dialog nor sits on a button that
  // does nothing.
  const blocked = resuming?.blocked === true || deleting?.blocked === true;
  useEffect(() => {
    if (blocked) document.querySelector<HTMLElement>(".os-modal__actions .os-btn--ghost")?.focus();
  }, [blocked]);

  async function confirmResume() {
    if (!resuming || resuming.busy || resuming.blocked) return;
    const { session } = resuming;
    setResuming({ session, busy: true, error: "", toSafety: false, blocked: false });
    try {
      const resumed = await resumeSession(session.id);
      if (!alive.current) return;
      // An answer that is not a session (`null`, say) is an answer that could not be read, like a body that is not
      // JSON (a SyntaxError, which sessionGotNoAnswer counts as an answer). Nothing is acted on before this check.
      if (createdSessionId(resumed) === null) throw new SyntaxError("Agent OS answered with something that is not a session.");
      sessionsList.refresh();
      // The Resume button is gone after this: the session's terminal takes the keyboard on the Sessions page.
      askToFocusNextSession();
      navigateTo("sessions", { session: session.id });
    } catch (error) {
      if (!alive.current) return;
      setResuming({
        session,
        busy: false,
        error: actionProblem(error, "resume", sessionGotNoAnswer(error)),
        toSafety: isLookOnlyRefusal(error),
        blocked: isImpossibleResume(error)
      });
      // The conversation may have started although nothing readable came back: read both lists again.
      sessionsList.refresh();
      onReload();
    }
  }

  async function confirmDelete() {
    if (!deleting || deleting.busy || deleting.blocked) return;
    const { row } = deleting;
    setDeleting({ row, busy: true, error: "", blocked: false });
    try {
      await deleteRecording(row.sessionId);
      if (!alive.current) return;
      deleted.current = true;
      setDeleting(null);
      onReload();
      // Back to the list; its tab takes the keyboard (the Delete button and the replay are gone).
      navigateTo("runs", { tab: "recordings" });
      window.requestAnimationFrame(() => document.getElementById(tabDomId("runs", "recordings"))?.focus());
    } catch (error) {
      if (!alive.current) return;
      setDeleting({ row, busy: false, error: deleteProblem(error, sessionGotNoAnswer(error)), blocked: isFinalDeleteRefusal(error) });
      // The delete may have happened although no readable answer came: read the list again.
      onReload();
    }
  }

  if (value.state === "loading") {
    return (
      <p className="os-runs-rec__status">
        <StatusWord state="loading" />
      </p>
    );
  }
  if (value.state === "unavailable") {
    // The Sessions page's own words for the same answer (Task U3).
    return (
      <EmptyState
        icon={CircleDot}
        title="Session recordings aren't available here"
        body="Sessions run only when Agent OS runs on your own computer, not in the public demo or on a shared server."
      />
    );
  }
  if (value.state === "error") {
    return (
      <Banner
        tone="danger"
        title="Agent OS isn't responding"
        actions={
          <button type="button" className="os-btn os-btn--secondary" onClick={onReload}>
            Try again
          </button>
        }
      >
        The recordings can&apos;t be listed right now. This page tries again every few seconds.
      </Banner>
    );
  }

  const { rows, removedByCap } = value.data;
  const copy = resuming ? resumeWords(resuming.session, resumeFrom) : null;
  const deleteCopy = deleting
    ? deleteConfirmCopy({ kind: deleting.row.kind, dismissed: byId.get(deleting.row.sessionId)?.dismissed === true })
    : null;
  const replayRow = replay ? rows.find((row) => row.sessionId === replay) : undefined;
  const replaySession = replayRow ? byId.get(replayRow.sessionId) : undefined;
  const replayAction = replayRow ? rowAction(replayRow, replaySession, sessionsState) : null;
  return (
    <div className="os-runs-rec__wrap">
      {value.stale ? (
        <Banner tone="warn" title="Can't reach Agent OS">
          This is the last list it got. It keeps trying, and this page updates by itself when Agent OS is back.
        </Banner>
      ) : null}
      {replay ? (
        replayRow && replayAction ? (
          <ReplayPlayer
            key={replayRow.sessionId}
            row={replayRow}
            session={replaySession}
            action={replayAction}
            live={isRecording(replayRow, replayAction)}
            onResume={() => {
              if (!replaySession) return;
              setResumeFrom("replay");
              setResuming({ session: replaySession, busy: false, error: "", toSafety: false, blocked: false });
            }}
            onOpenLive={() => navigateTo("sessions", { session: replayRow.sessionId })}
            onDelete={() => {
              deleted.current = false;
              setDeleting({ row: replayRow, busy: false, error: "", blocked: false });
            }}
          />
        ) : (
          <Banner
            tone="warn"
            actions={
              onCloseReplay ? (
                <button type="button" className="os-btn os-btn--secondary" onClick={onCloseReplay}>
                  Session recordings
                </button>
              ) : undefined
            }
          >
            {RECORDING_GONE}
          </Banner>
        )
      ) : (
        <>
          {removedByCap > 0 ? <Banner tone="info">{CAP_NOTE}</Banner> : null}
          {rows.length === 0 ? (
            <EmptyState icon={CircleDot} title={EMPTY_TITLE} body={EMPTY_BODY} />
          ) : (
            <div className="os-table os-runs-rec" role="table" aria-label="Session recordings">
              <div className="os-table__head" role="row">
                <span className="os-table__cell" role="columnheader">
                  Recording
                </span>
                <span className="os-table__cell" role="columnheader">
                  State
                </span>
                <span className="os-table__cell os-runs-rec__len" role="columnheader">
                  Length
                </span>
                <span className="os-table__cell os-runs-rec__when" role="columnheader">
                  Recorded
                </span>
                <span className="os-table__cell" role="columnheader">
                  <span className="os-visually-hidden">Actions</span>
                </span>
              </div>
              {rows.map((row) => {
                const session = byId.get(row.sessionId);
                const action = rowAction(row, session, sessionsState);
                const length = recordingLength(row, now);
                const lit = row.sessionId === highlight;
                const title = sessionTitle(row, { branch: false }); // the branch is in the words under it
                const where = whereWords(row);
                return (
                  <div
                    key={row.sessionId}
                    className={`os-table__row os-runs-rec__row${lit ? " is-highlighted" : ""}`}
                    role="row"
                    data-recording={row.sessionId}
                    aria-current={lit ? "true" : undefined}
                    tabIndex={lit ? -1 : undefined}
                  >
                    <div className="os-table__cell" role="cell">
                      <span className="os-table__title os-trunc" title={title}>
                        {title}
                      </span>
                      <span className="os-table__sub os-trunc" title={where}>
                        {where}
                      </span>
                    </div>
                    <div className="os-table__cell" role="cell">
                      {isRecording(row, action) ? <StatusWord state="live" label="Recording" /> : <StatusWord state="ready" label="Saved" />}
                    </div>
                    <div className="os-table__cell os-runs-rec__len" role="cell">
                      <span className="os-mono">{length.value}</span>
                      {length.soFar ? <span className="os-runs-rec__sofar">so far</span> : null}
                    </div>
                    <div className="os-table__cell os-runs-rec__when" role="cell">
                      {recordedAt(row) ? <TimeAgo since={recordedAt(row)} /> : "—"}
                    </div>
                    <div className="os-table__cell os-runs-rec__acts" role="cell">
                      <div className="os-runs-rec__btns">
                        <button
                          type="button"
                          className="os-btn os-btn--secondary"
                          onClick={() => navigateTo("runs", { tab: "recordings", replay: row.sessionId })}
                        >
                          <Play size={15} aria-hidden="true" />
                          Replay
                        </button>
                        {action.kind === "open" ? (
                          <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("sessions", { session: row.sessionId })}>
                            <SquareTerminal size={15} aria-hidden="true" />
                            Open live session
                          </button>
                        ) : null}
                        {action.kind === "resume" ? (
                          <button
                            type="button"
                            className="os-btn os-btn--secondary"
                            disabled={!action.available || !session}
                            aria-describedby={action.available ? undefined : `os-rec-note-${row.sessionId}`}
                            onClick={() => {
                              if (!session) return;
                              setResumeFrom("row");
                              setResuming({ session, busy: false, error: "", toSafety: false, blocked: false });
                            }}
                          >
                            <History size={15} aria-hidden="true" />
                            Resume conversation
                          </button>
                        ) : null}
                      </div>
                      {action.kind === "resume" && !action.available ? (
                        <span id={`os-rec-note-${row.sessionId}`} className="os-runs-rec__note">
                          {action.reason}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {resuming && copy ? (
        <AgentConfirmModal
          title={copy.title}
          confirmLabel="Resume conversation"
          busy={resuming.busy}
          confirmDisabled={resuming.blocked}
          onConfirm={() => void confirmResume()}
          onClose={() => {
            if (!resuming.busy) setResuming(null);
          }}
        >
          {copy.body.map((line) => (
            <p key={line}>
              <VisibleText text={line} />
            </p>
          ))}
          {copy.warning ? <Banner tone="warn">{copy.warning}</Banner> : null}
          {resuming.error ? (
            <p className="os-newrun__error" role="alert">
              {resuming.error}{" "}
              {resuming.toSafety ? (
                <button
                  type="button"
                  className="os-newrun__link"
                  onClick={() => {
                    setResuming(null);
                    navigateTo("safety");
                  }}
                >
                  Open Safety
                </button>
              ) : null}
            </p>
          ) : null}
        </AgentConfirmModal>
      ) : null}

      {deleting && deleteCopy ? (
        <AgentConfirmModal
          title={deleteCopy.title}
          confirmLabel={deleteCopy.confirm}
          danger
          busy={deleting.busy}
          confirmDisabled={deleting.blocked}
          giveFocusBack={() => !deleted.current}
          onConfirm={() => void confirmDelete()}
          onClose={() => {
            if (!deleting.busy) setDeleting(null);
          }}
        >
          {deleteCopy.body.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {deleting.error ? (
            <p className="os-newrun__error" role="alert">
              {deleting.error}
            </p>
          ) : null}
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
