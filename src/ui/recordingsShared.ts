// Runs → Session recordings: the pure logic. The rows come from GET /api/recordings, checked here (an answer that is
// not a list is no answer), and are joined with the shared sessions list for Resume. No imports at all, so
// test/recordings-help-logic.test.js loads it straight from src/. durationWords is a copy of the one in
// sessionsPageShared.ts (Node cannot follow an import written without a file extension); that test checks they agree.
// A row's title is Task U1's sessionTitle (sessionsShared.ts), used by the component.

export interface RecordingRow {
  sessionId: string;
  kind: "agent" | "update";
  agentId: string;
  agentLabel: string;
  folder: string;
  folderName: string;
  folderShown: boolean;
  // A session that ran in a separate copy (R25): the project it copied and the copy's branch (null for every other
  // session). `folder` is then the copy's own folder, which is not where the person works.
  copyOf: string | null;
  branch: string | null;
  // The LATEST start: a resume resets it. It still orders the list (newest first).
  startedAt: string;
  // When the recording itself began: a resumed session's first start. Recorded shows it and Length runs from it. An
  // answer without it (an older server) falls back to startedAt.
  firstStartedAt: string;
  endedAt: string | null;
  bytes: number | null;
  live: boolean;
}
export interface RecordingsBody {
  rows: RecordingRow[];
  // How many ended recordings were deleted to stay under 1 GB since Agent OS started (decision Q38; the route's
  // `removedByCap`).
  removedByCap: number;
}

// Decided words (decision Q38 and the Session recordings copy, Q32, owner). The recording holds output only, but an
// agent echoes what you type, so typed text that appears on screen (a pasted secret too) is in the recording. The SP3
// note about a later replay is gone: Task U11 built the replay (replayShared.ts).
export const CAP_NOTE = "Older recordings were removed to stay under 1 GB.";
export const EMPTY_TITLE = "No recordings yet";
export const EMPTY_BODY = "Every session is recorded here: what its terminal showed, including anything you typed that appeared on screen.";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const startMs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

// The answer of GET /api/recordings, checked: `{ recordings: [...], removedByCap }`, or a bare list. A row with no
// session id is dropped; a missing kind is an agent session; a missing folderShown shows the folder. Newest first.
export function readRecordings(answer: unknown): RecordingsBody | null {
  const body = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : null;
  const list = Array.isArray(answer) ? answer : body && Array.isArray(body.recordings) ? (body.recordings as unknown[]) : null;
  if (!list) return null;
  const rows: RecordingRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const sessionId = text(r.sessionId);
    if (!sessionId) continue;
    const startedAt = text(r.startedAt);
    rows.push({
      sessionId,
      kind: r.kind === "update" ? "update" : "agent",
      agentId: text(r.agentId),
      agentLabel: text(r.agentLabel) || text(r.agentId) || "—",
      folder: text(r.folder),
      folderName: text(r.folderName),
      folderShown: r.folderShown !== false,
      copyOf: text(r.copyOf) || null,
      branch: text(r.branch) || null,
      startedAt,
      firstStartedAt: text(r.firstStartedAt) || startedAt,
      endedAt: text(r.endedAt) || null,
      bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) ? r.bytes : null,
      live: r.live === true
    });
  }
  rows.sort((a, b) => startMs(b.startedAt) - startMs(a.startedAt));
  const removed = body ? count(body.removedByCap) : 0;
  return { rows, removedByCap: removed };
}

// The folder a row names: the project for a session that ran in a separate copy (the copy's own folder is inside
// Agent OS's data folder and may be removed), else the session's folder. A raw path: the page shortens the home folder.
export function recordingFolder(row: Pick<RecordingRow, "folder" | "copyOf">): string {
  return row.copyOf || row.folder;
}

// The words under a row's title: where the session ran. `collapse` shortens the home folder (collapseHomePath in
// agentsShared.ts, which this file cannot import). A separate copy reads as the project and the copy's branch (R25).
export function recordingPlace(row: Pick<RecordingRow, "kind" | "folder" | "folderShown" | "copyOf" | "branch">, collapse: (path: string) => string): string {
  if (row.kind === "update") return "Agent update";
  if (!row.folderShown) return "Folder set by OpenClaw";
  const folder = collapse(recordingFolder(row)) || "—";
  return row.copyOf && row.branch ? `${folder} · ${row.branch}` : folder;
}

// The branch the replay header shows: the sessions list's word when the session is in it, else the row's own.
export function recordingBranch(row: Pick<RecordingRow, "branch">, sessionBranch: string | null | undefined): string | null {
  return sessionBranch || row.branch || null;
}

export type RowAction = { kind: "open" } | { kind: "resume"; available: boolean; reason: string } | { kind: "none" };
type SessionView = { status: string; resume?: { available: boolean; reason: string | null } | null };

// What a row offers. An update recording offers nothing (it is never resumed, spec Session kinds). The sessions list
// is the newer word on whether a session runs (the recording's own flag can be a poll behind): an open session opens;
// an ended one resumes, or says why it can't (the server's reason, decision Q36, worded as Task U1's Resume confirm
// does). "…" while the list is loading.
export function rowAction(row: Pick<RecordingRow, "kind" | "live">, session: SessionView | undefined, sessionsState: "loading" | "ok" | "error"): RowAction {
  if (row.kind === "update") return { kind: "none" };
  const live = session ? session.status !== "exited" : row.live;
  if (live) return { kind: "open" };
  if (!session) {
    if (sessionsState === "loading") return { kind: "resume", available: false, reason: "…" };
    if (sessionsState === "error") return { kind: "resume", available: false, reason: "Agent OS can't check this conversation right now." };
    return { kind: "resume", available: false, reason: "This session can't be resumed." };
  }
  if (session.resume?.available) return { kind: "resume", available: true, reason: "" };
  return { kind: "resume", available: false, reason: session.resume?.reason || "This session can't be resumed." };
}

// Whether a row is still being written (the State cell says Recording, else Saved). An agent row follows its action
// (the sessions list is the newer word, see rowAction); an update row offers no action, so its own `live` flag decides.
export function isRecording(row: Pick<RecordingRow, "kind" | "live">, action: RowAction): boolean {
  return row.kind === "update" ? row.live : action.kind === "open";
}

// "40 s", "12 m 40 s", "1 h 05 m"; "—" when the start is not known (or lies in the future). A copy of
// sessionsPageShared.ts's durationWords, checked by test/recordings-help-logic.test.js.
export function durationWords(fromIso: string | null | undefined, toMs: number): string {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(toMs) || toMs < from) return "—";
  const seconds = Math.floor((toMs - from) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

// How long a recording runs: "so far" while it is live; "—" when an ended one has no end time. It runs from the
// recording's first start to the end of its last part, so a resumed session's Length covers all its parts (on the
// recording's own clock, which keeps counting while the session was ended). A row without firstStartedAt measures
// from startedAt.
export function recordingLength(
  row: Pick<RecordingRow, "startedAt" | "endedAt" | "live"> & { firstStartedAt?: string },
  now: number
): { value: string; soFar: boolean } {
  const from = recordedAt(row);
  if (row.live) return { value: durationWords(from, now), soFar: true };
  const end = row.endedAt ? Date.parse(row.endedAt) : NaN;
  return { value: Number.isFinite(end) ? durationWords(from, end) : "—", soFar: false };
}

// The time the Recorded column shows: when the recording first started.
export function recordedAt(row: Pick<RecordingRow, "startedAt"> & { firstStartedAt?: string }): string {
  return row.firstStartedAt || row.startedAt;
}
