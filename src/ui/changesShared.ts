// The side panel's Files changed section and its read-only diff (spec "SP4 Session extras", Changes panel; Task U7):
// which sessions show the section, how often the panel asks, what the section says in each state, one row's words,
// and how a diff's lines are told apart for colour. The server reads git (server/runtime/sessions/changes.js, Task
// X7); the panel only shows its answer. `import type` only (decision P14): test/sessions-changes-ui-logic.test.js
// loads this file straight from src/.
import type { ChangedFile, ChangesResult, DiffResult, SessionSummary } from "../types";
import type { Source } from "./homeShared";

// The server reads git every 3 s while a session runs (CHANGES_POLL_MS, Task X7) and answers the route from its last
// read at once, so the panel asks at the same pace.
export const CHANGES_UI_POLL_MS = 3000;

// The spec's sentence, word for word ("not a git folder").
export const NOT_GIT_LINE = "Changes appear when this folder is a git project";
// The prototype's words for an empty list (sessions.html); owner review at E1 (Q32).
export const NO_CHANGES_LINE = "No files changed in this session.";
export const NO_CHANGES_COPY_LINE = "No files changed in this copy yet.";
// The Sessions page's own words for data kept after a failed read (its stale banner, SessionsPage.tsx).
export const STALE_LINE = "Showing what was last known.";
// The Sessions page's own words for a request that failed without a reason of its own (sessionProblem in
// sessionsApi.ts), used when the server answers but could not read git in the folder (Task X7: `git: null` that stays).
export const UNREAD_LINE = "Agent OS couldn't do that. Try again.";
// An ended session whose separate copy was removed: the folder it ran in is gone, so git can never be read there (M6).
export const COPY_REMOVED_LINE = "Its separate copy was removed, so its changes can't be shown.";
// The diff dialog's words; owner review at E1 (Q32). "Loading…" is the app's existing word (ModelPicker).
export const DIFF_LOADING = "Loading…";
export const DIFF_BINARY_LINE = "This is a binary file, so there is no text to show.";
export const DIFF_EMPTY_LINE = "There is no text difference to show for this file.";
// "256 KB" is the server's DIFF_MAX_BYTES (Task X7); the logic test keeps the two together.
export const DIFF_CUT_LINE = "This diff is long, so only its first 256 KB is shown.";

const MINUS = "−";

// Agent sessions only (update and setup sessions never reach the panel), and never while OpenClaw picks its own
// folder (the panel reads "Set by OpenClaw"): Agent OS can't say which files that session changed.
export function showsChanges(s: Pick<SessionSummary, "kind" | "folderShown">): boolean {
  return s.kind === "agent" && s.folderShown !== false;
}

// The session's own folder can be read. A session whose separate copy was removed (meta.json's worktreeRemovedAt, the
// summary's copyRemoved) has none: the panel asks the server for nothing and says so instead (M6).
type CopyRemovedField = Partial<Pick<SessionSummary, "copyRemoved">>;
export function changesWanted(s: CopyRemovedField): boolean {
  return s.copyRemoved !== true;
}

// Every 3 s while the session runs; an ended session is read once, when its section appears (and once more right
// as it ends), and never again.
export function changesPollMs(s: Pick<SessionSummary, "status"> & CopyRemovedField): number | null {
  return s.status === "exited" || !changesWanted(s) ? null : CHANGES_UI_POLL_MS;
}

// An ended session is read once. When that read failed (no answer, or `git: null`) the panel asks again at this pace
// while the session is shown, so the page's "Try again" stays true without a button of its own.
export const ENDED_RETRY_MS = 30000;

// The last read of the changes did not give a usable answer: no answer at all, git could not be read (`git: null`), or
// a good list is being kept after a failed read (the stale note).
export function changesFailed(source: Source<ChangesResult>): boolean {
  if (source.state === "error") return true;
  return source.state === "ok" && (Boolean(source.stale) || source.data.git === null);
}

// How often an ended session is asked again: only when its last read failed. A running session already asks every 3 s
// (changesPollMs), and an ended one that has an answer is never asked again.
export function changesRetryMs(s: Pick<SessionSummary, "status"> & CopyRemovedField, failed: boolean): number | null {
  return s.status === "exited" && failed && changesWanted(s) ? ENDED_RETRY_MS : null;
}

// How many "not read yet" answers in a row a running session may give before the section stops saying "…" (about
// twelve seconds): git is then failing or slow in that folder (Task X7 keeps the last result and tries again).
export const UNREAD_AFTER_READS = 4;

// Whether `git: null` answers (the server could not read git) have gone on long enough to say so. An ended session is
// read once, so its first such answer is the last; a running one is asked again every 3 s and keeps trying.
export function changesUnread(ended: boolean, notReadInARow: number): boolean {
  return ended ? notReadInARow >= 1 : notReadInARow >= UNREAD_AFTER_READS;
}

export interface ChangesView {
  // After "Files changed": the number of changed files, "…" while it is not known yet, "—" when git could not be read,
  // null when not a git project.
  count: string | null;
  // The one line shown instead of rows: why the first read failed, not a git project, or nothing changed.
  line: string | null;
  // At most 200 rows (the server's cap).
  files: ChangedFile[];
  // "Showing 200 of 1234 files." when the server left files out; owner review at E1 (Q32).
  more: string | null;
  // A read failed after a good one: the last good list stays, under STALE_LINE.
  stale: boolean;
}

export function changesView(
  source: Source<ChangesResult>,
  { copy, unread = false, removed = false }: { copy: boolean; unread?: boolean; removed?: boolean }
): ChangesView {
  // Nothing was asked and whatever was read before is about a folder that is gone: the count is unknown and the line says why.
  if (removed) return { count: "—", line: COPY_REMOVED_LINE, files: [], more: null, stale: false };
  const waiting: ChangesView = { count: "…", line: null, files: [], more: null, stale: false };
  if (source.state === "loading") return waiting;
  // No good read yet: the reason, in the words sessionProblem gave it. The panel keeps asking.
  if (source.state === "error") return { ...waiting, line: source.message };
  const stale = Boolean(source.stale);
  const { git, files } = source.data;
  if (git === null) return unread ? { count: "—", line: UNREAD_LINE, files: [], more: null, stale } : { ...waiting, stale };
  if (git === false) return { count: null, line: NOT_GIT_LINE, files: [], more: null, stale };
  // A server that leaves `total` out, or sends less than the list holds: the list's own length.
  const total = Number.isInteger(source.data.total) && source.data.total > files.length ? source.data.total : files.length;
  if (total === 0) return { count: "0", line: copy ? NO_CHANGES_COPY_LINE : NO_CHANGES_LINE, files: [], more: null, stale };
  const more = total > files.length ? `Showing ${files.length} of ${total} files.` : null;
  return { count: String(total), line: null, files, more, stale };
}

// "src/ui/app.ts" → the folder part "src/ui/" (drawn dimmer) and the name "app.ts".
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}

// A line count git gave, or null (git can't count a binary file's lines; a count that is not a whole number is not
// one either).
function lineCount(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

export interface FileCounts {
  // "+12", or null when git gave no added count.
  add: string | null;
  // "−3" with a real minus sign (U+2212), or null when git gave no removed count.
  del: string | null;
  // "−0" is drawn faint, as in the prototype.
  delZero: boolean;
}

// The row's + and − counts. null when git gave neither (a binary file): the row shows "—", the panel's word for
// unknown. A count git didn't give is left out, never shown as 0.
export function fileCounts(file: Pick<ChangedFile, "added" | "removed">): FileCounts | null {
  const added = lineCount(file.added);
  const removed = lineCount(file.removed);
  if (added === null && removed === null) return null;
  return { add: added === null ? null : `+${added}`, del: removed === null ? null : `${MINUS}${removed}`, delZero: removed === 0 };
}

export interface TextPiece {
  // A run of ordinary text, or (hidden) the visible token that stands for one hidden character.
  text: string;
  hidden: boolean;
  // For a token: what it stands for, in words ("hidden character U+202E"). null for ordinary text.
  label: string | null;
}

// Characters that change how text is drawn or that draw as nothing: the left-to-right and right-to-left marks,
// embeddings, overrides and isolates (a file named "report" + U+202E + "fdp.exe" is drawn "reportexe.pdf"; a diff line
// can hide what it holds, the "Trojan Source" trick), the Arabic letter mark, the zero width characters and the byte
// order mark, the line and paragraph separators (U+2028 and U+2029, which some tools break a line at), and every control
// character except tab (NUL, ESC, DEL, the C1 range, a lone carriage return, a newline inside a name). Tab stays: a
// diff keeps its indentation.
const HIDDEN_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// A path or a diff line split into ordinary runs and visible tokens: `<U+202E>` for a reordering or format character,
// `\x1B` for a control character. The page draws a token dimly, so what a name or a line really holds can be read
// (the diff dialog exists so a person can check what an agent wrote). Text only: nothing here is ever HTML.
export function visiblePieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let from = 0;
  for (const match of text.matchAll(HIDDEN_CHARS)) {
    const at = match.index ?? 0;
    if (at > from) pieces.push({ text: text.slice(from, at), hidden: false, label: null });
    const code = match[0].charCodeAt(0);
    if (code < 0xa0) {
      const hex = code.toString(16).toUpperCase().padStart(2, "0");
      pieces.push({ text: `\\x${hex}`, hidden: true, label: `control character 0x${hex}` });
    } else {
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      pieces.push({ text: `<U+${hex}>`, hidden: true, label: `hidden character U+${hex}` });
    }
    from = at + 1;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), hidden: false, label: null });
  return pieces;
}

// The same, as one plain string (for a tooltip or an accessible name, which cannot hold styled pieces).
export function visibleText(text: string): string {
  return visiblePieces(text)
    .map((piece) => piece.text)
    .join("");
}

// The row's accessible name (screen readers read words, not "+12 −3"); owner review at E1 (Q32). The path is in its
// visible form, so a hidden character is named instead of being read as nothing.
export function fileRowLabel(file: Pick<ChangedFile, "path" | "added" | "removed">): string {
  const added = lineCount(file.added);
  const removed = lineCount(file.removed);
  const path = visibleText(file.path);
  if (added === null && removed === null) return `${path}, line counts unknown`;
  const parts: string[] = [];
  if (added !== null) parts.push(`${added} added`);
  if (removed !== null) parts.push(`${removed} removed`);
  return `${path}, ${parts.join(", ")}`;
}

// The row's tooltip: the full path (in its visible form), since a long one ends in "…" on the row. A renamed file shows
// where it came from.
export function fileRowTitle(file: Pick<ChangedFile, "path" | "oldPath">): string {
  return file.oldPath ? `${visibleText(file.oldPath)} → ${visibleText(file.path)}` : visibleText(file.path);
}

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

export interface DiffLine {
  text: string;
  kind: DiffLineKind;
}

// One `git diff` split into lines, each with its kind for colour. Lines before a file's first "@@" are its header
// (meta), even one that starts with "---" or "+++"; inside a hunk the first character decides, so a removed line
// whose text starts with "--" stays a removed line. "diff --git" starts the next file's header. A line's Windows
// "\r" is not shown, and the final newline adds no empty line.
export function diffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  const raw = diff.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  let inHunk = false;
  return raw.map((line): DiffLine => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      return { text, kind: "meta" };
    }
    if (text.startsWith("@@")) {
      inHunk = true;
      return { text, kind: "hunk" };
    }
    if (!inHunk || text.startsWith("\\")) return { text, kind: "meta" };
    if (text.startsWith("+")) return { text, kind: "add" };
    if (text.startsWith("-")) return { text, kind: "del" };
    return { text, kind: "context" };
  });
}

// What the dialog shows for an answer: the lines, and the notes above them (binary, nothing to show, cut).
export function diffView(result: Pick<DiffResult, "diff" | "binary" | "cut">): { lines: DiffLine[]; notes: string[] } {
  if (result.binary) return { lines: [], notes: [DIFF_BINARY_LINE] };
  const lines = diffLines(result.diff);
  const notes: string[] = [];
  if (lines.length === 0) notes.push(DIFF_EMPTY_LINE);
  if (result.cut) notes.push(DIFF_CUT_LINE);
  return { lines, notes };
}
