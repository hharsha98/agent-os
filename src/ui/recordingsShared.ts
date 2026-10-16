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
  startedAt: string;
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
// agent echoes what you type, so typed text that appears on screen (a pasted secret too) is in the recording.
export const REPLAY_LATER = "Replay arrives in a later update";
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
    rows.push({
      sessionId,
      kind: r.kind === "update" ? "update" : "agent",
      agentId: text(r.agentId),
      agentLabel: text(r.agentLabel) || text(r.agentId) || "—",
      folder: text(r.folder),
      folderName: text(r.folderName),
      folderShown: r.folderShown !== false,
      startedAt: text(r.startedAt),
      endedAt: text(r.endedAt) || null,
      bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) ? r.bytes : null,
      live: r.live === true
    });
  }
  rows.sort((a, b) => startMs(b.startedAt) - startMs(a.startedAt));
  const removed = body ? count(body.removedByCap) : 0;
  return { rows, removedByCap: removed };
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

// How long a recording runs: "so far" while it is live; "—" when an ended one has no end time.
export function recordingLength(row: Pick<RecordingRow, "startedAt" | "endedAt" | "live">, now: number): { value: string; soFar: boolean } {
  if (row.live) return { value: durationWords(row.startedAt, now), soFar: true };
  const end = row.endedAt ? Date.parse(row.endedAt) : NaN;
  return { value: Number.isFinite(end) ? durationWords(row.startedAt, end) : "—", soFar: false };
}
