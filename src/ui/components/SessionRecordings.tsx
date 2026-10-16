// Runs → Session recordings: every recorded session, newest first (GET /api/recordings), joined with the shared
// sessions list for Resume. A live one offers "Open live session". An ended one offers "Resume conversation" (or says
// why it can't) and the note "Replay arrives in a later update" (the player is SP4). An update recording ("<agent>
// update") offers nothing: it is never resumed. "Open recording" on an ended Sessions tab lands here with that row
// highlighted (?highlight=<session id>), and the row takes keyboard focus once. listRecordings and resumeSession carry
// their own time limits (sessionsApi.ts, SESSION_LIMITS_MS). Where sessions do not run (the public demo, a shared
// server) the route answers 404 not_available: the tab says so once and stops asking, instead of "isn't responding".
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleDot, History, SquareTerminal } from "lucide-react";
import { ApiError } from "../../api";
import { navigateTo } from "../../nav";
import { listRecordings, resumeSession, sessionGotNoAnswer } from "../../sessionsApi";
import type { SessionSummary } from "../../types";
import { collapseHomePath } from "../agentsShared";
import { askToFocusNextSession, createdSessionId } from "../newSession";
import { CAP_NOTE, EMPTY_BODY, EMPTY_TITLE, REPLAY_LATER, isRecording, readRecordings, recordingLength, rowAction } from "../recordingsShared";
import type { RecordingRow, RecordingsBody } from "../recordingsShared";
import { resumeConfirmCopy, sessionTitle } from "../sessionsShared";
import { actionProblem, isLookOnlyRefusal } from "../sessionsPageShared";
import { useSessionsList } from "../useSessionsList";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";
import EmptyState from "./EmptyState";
import { TimeAgo } from "./RelativeTime";
import StatusWord from "./StatusWord";
import { useInterval } from "./useInterval";

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
  if (row.kind === "update") return "Agent update";
  if (!row.folderShown) return "Folder set by OpenClaw";
  return collapseHomePath(row.folder) || "—";
}

export default function SessionRecordings({ value, highlight, onReload }: { value: RecordingsState; highlight: string; onReload: () => void }) {
  const sessionsList = useSessionsList();
  const sessionsState: "loading" | "ok" | "error" = sessionsList.available ? sessionsList.source.state : "ok";
  const sessions: SessionSummary[] =
    sessionsList.source.state === "ok" && Array.isArray(sessionsList.source.data.sessions) ? sessionsList.source.data.sessions : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const [now, setNow] = useState(() => Date.now());
  const [resuming, setResuming] = useState<{ session: SessionSummary; busy: boolean; error: string; toSafety: boolean } | null>(null);
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

  async function confirmResume() {
    if (!resuming || resuming.busy) return;
    const { session } = resuming;
    setResuming({ session, busy: true, error: "", toSafety: false });
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
      setResuming({ session, busy: false, error: actionProblem(error, "resume", sessionGotNoAnswer(error)), toSafety: isLookOnlyRefusal(error) });
      // The conversation may have started although nothing readable came back: read both lists again.
      sessionsList.refresh();
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
  const copy = resuming ? resumeConfirmCopy(resuming.session) : null;
  return (
    <div className="os-runs-rec__wrap">
      {value.stale ? (
        <Banner tone="warn" title="Can't reach Agent OS">
          This is the last list it got. It keeps trying, and this page updates by itself when Agent OS is back.
        </Banner>
      ) : null}
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
            const title = sessionTitle(row);
            const where = whereWords(row);
            return (
              <div
                key={row.sessionId}
                className={`os-table__row os-runs-rec__row${lit ? " is-highlighted" : ""}`}
                role="row"
                data-recording={row.sessionId}
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
                  {row.startedAt ? <TimeAgo since={row.startedAt} /> : "—"}
                </div>
                <div className="os-table__cell os-runs-rec__acts" role="cell">
                  {action.kind === "open" ? (
                    <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("sessions", { session: row.sessionId })}>
                      <SquareTerminal size={15} aria-hidden="true" />
                      Open live session
                    </button>
                  ) : null}
                  {action.kind === "resume" ? (
                    <>
                      <button
                        type="button"
                        className="os-btn os-btn--secondary"
                        disabled={!action.available || !session}
                        aria-describedby={`os-rec-note-${row.sessionId}`}
                        onClick={() => {
                          if (session) setResuming({ session, busy: false, error: "", toSafety: false });
                        }}
                      >
                        <History size={15} aria-hidden="true" />
                        Resume conversation
                      </button>
                      <span id={`os-rec-note-${row.sessionId}`} className="os-runs-rec__note">
                        {action.available ? REPLAY_LATER : `${action.reason} ${REPLAY_LATER}.`}
                      </span>
                    </>
                  ) : null}
                  {action.kind === "none" && !row.live ? <span className="os-runs-rec__note">{REPLAY_LATER}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {resuming && copy ? (
        <AgentConfirmModal
          title={copy.title}
          confirmLabel="Resume conversation"
          busy={resuming.busy}
          onConfirm={() => void confirmResume()}
          onClose={() => {
            if (!resuming.busy) setResuming(null);
          }}
        >
          <p>{copy.body}</p>
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
    </div>
  );
}
