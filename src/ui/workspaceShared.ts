// Pure logic for the Workspace page: what kind a file is, how the list is
// filtered and grouped, how "Saved by" reads, when Undo may be offered, how a
// note name is cleaned, and plain-words messages for errors. No React in here,
// so every rule can be checked on its own (.superpowers/ui-audit/probes/workspace-logic.mjs).
import { ApiError, TeamRoomError } from "../api";
import type { WorkspaceFile, WorkspaceListedFile, WorkspaceListing, WorkspaceSavedBy } from "../types";

// ---------- what a file is ----------

export type TypeKey = "md" | "txt" | "html" | "image" | "audio" | "video" | "pdf" | "other";
export type TypeFilter = "all" | TypeKey;

// `chip` is the filter button's word, `label` the full name in the preview
// header, `tag` the small box on a list row.
export const TYPE_INFO: Record<TypeKey, { label: string; chip: string; tag: string }> = {
  md: { label: "Markdown", chip: "Markdown", tag: "MD" },
  txt: { label: "Text", chip: "Text", tag: "TXT" },
  html: { label: "HTML", chip: "HTML", tag: "HTML" },
  image: { label: "Image", chip: "Images", tag: "IMG" },
  audio: { label: "Audio", chip: "Audio", tag: "AUDIO" },
  video: { label: "Video", chip: "Video", tag: "VIDEO" },
  pdf: { label: "PDF", chip: "PDF", tag: "PDF" },
  other: { label: "Other", chip: "Other", tag: "FILE" }
};

// Three chips are always drawn. The others appear only when a file of that type exists.
export const ALWAYS_CHIPS: TypeKey[] = ["md", "txt", "html"];
export const OPTIONAL_CHIPS: TypeKey[] = ["image", "audio", "video", "pdf", "other"];

// The server stops listing at 500 files (MAX_FILES in server/runtime/workspace.js)
// and returns the text of a file only up to 256 KB (MAX_TEXT_PREVIEW_BYTES).
export const LIST_LIMIT = 500;
export const PREVIEW_MAX_BYTES = 256 * 1024;
// A preview that has to fetch the whole file first (image, audio, video, PDF, the locked HTML view) stops here (R33).
export const PREVIEW_FETCH_MAX_BYTES = 200 * 1024 * 1024;

type NameAndKind = Pick<WorkspaceFile, "name" | "kind">;
type WhereItLives = Pick<WorkspaceFile, "root" | "relativePath">;

// The server says "text" for .md, .txt, .json, .csv and so on. The page tells
// Markdown apart by its extension so it can draw it.
export function typeOf(file: NameAndKind): TypeKey {
  switch (file.kind) {
    case "text":
      return file.name.toLowerCase().endsWith(".md") ? "md" : "txt";
    case "html":
      return "html";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "pdf":
      return "pdf";
    default:
      return "other";
  }
}

export function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 104857.6) / 10} MB`;
}

export function filesWord(count: number): string {
  return count === 1 ? "file" : "files";
}

// ---------- folders ----------

// A file's group is its first folder ("notes"), "" for a file at the top of the
// workspace, and "exports/" (a name no real folder can have) for the Exports root.
export function groupKeyOf(file: WhereItLives): string {
  if (file.root === "exports") return "exports/";
  const slash = file.relativePath.indexOf("/");
  return slash === -1 ? "" : file.relativePath.slice(0, slash);
}

export function groupLabel(key: string): string {
  if (key === "") return "Top level";
  return key.endsWith("/") ? key : `${key}/`;
}

// The file's name inside its group: "notes/a/b.md" is "a/b.md" in the notes group.
export function nameInGroup(file: WhereItLives): string {
  if (file.root === "exports") return file.relativePath;
  const slash = file.relativePath.indexOf("/");
  return slash === -1 ? file.relativePath : file.relativePath.slice(slash + 1);
}

// The path shown to the person, relative to the workspace ("notes/plan.md").
export function displayPath(file: WhereItLives): string {
  return file.root === "exports" ? `exports/${file.relativePath}` : file.relativePath;
}

// The ?folder= link other pages use (Loop, Swarm, Studio, Memory). Anything
// that is not a plain folder name means "every folder".
export function folderFromQuery(raw: string): string {
  if (raw === "all") return "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : "";
}

// The same rule the old page used: the folder is the first part of the path
// inside a root, or a folder further down (for example exports/<run>/...).
export function inFolder(file: Pick<WorkspaceFile, "id" | "relativePath">, folder: string): boolean {
  const wanted = folder.toLowerCase();
  if (!wanted) return true;
  return file.relativePath.toLowerCase().startsWith(`${wanted}/`) || file.id.toLowerCase().includes(`/${wanted}/`);
}

// ---------- filters, counts, groups ----------

export interface FileFilters {
  type: TypeFilter;
  query: string;
  onlyAgents: boolean;
  folder: string;
}

export function countByType(files: WorkspaceListedFile[]): Record<TypeFilter, number> {
  const counts: Record<TypeFilter, number> = { all: files.length, md: 0, txt: 0, html: 0, image: 0, audio: 0, video: 0, pdf: 0, other: 0 };
  for (const file of files) counts[typeOf(file)] += 1;
  return counts;
}

export function filterFiles(files: WorkspaceListedFile[], filters: FileFilters): WorkspaceListedFile[] {
  const query = filters.query.trim().toLowerCase();
  return files.filter((file) => {
    if (filters.type !== "all" && typeOf(file) !== filters.type) return false;
    if (filters.onlyAgents && file.savedBy?.kind !== "team-room") return false;
    if (filters.folder && !inFolder(file, filters.folder)) return false;
    if (query && !displayPath(file).toLowerCase().includes(query)) return false;
    return true;
  });
}

export interface FileGroup {
  key: string;
  label: string;
  files: WorkspaceListedFile[];
}

// Top-level files first, then folders A to Z, then Exports. Newest file first inside a group.
export function groupFiles(files: WorkspaceListedFile[]): FileGroup[] {
  const byKey = new Map<string, WorkspaceListedFile[]>();
  for (const file of files) {
    const key = groupKeyOf(file);
    const list = byKey.get(key);
    if (list) list.push(file);
    else byKey.set(key, [file]);
  }
  const rank = (key: string) => (key === "" ? 0 : key === "exports/" ? 2 : 1);
  return Array.from(byKey.entries())
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      label: groupLabel(key),
      files: [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.relativePath.localeCompare(b.relativePath))
    }));
}

// ---------- who saved it ----------

export interface SavedByView {
  // The short word for a list row: "You", "Agent OS", "Team Room" or "—".
  who: string;
  // The agent's name for a Team Room save ("Hermes"), otherwise "".
  detail: string;
  // True when nobody is on record. The page shows "—" and tells a screen reader "Unknown".
  unknown: boolean;
  byAgent: boolean;
  // One plain phrase for the preview line and for tests: "Team Room (Hermes)".
  text: string;
}

export function savedByView(savedBy: WorkspaceSavedBy | null | undefined): SavedByView {
  const label = typeof savedBy?.label === "string" ? savedBy.label.trim().slice(0, 60) : "";
  switch (savedBy?.kind) {
    case "you":
      return { who: "You", detail: "", unknown: false, byAgent: false, text: "You" };
    case "agent-os":
      return { who: "Agent OS", detail: "", unknown: false, byAgent: false, text: "Agent OS" };
    case "team-room": {
      const detail = label && label !== "—" ? label : "";
      return { who: "Team Room", detail, unknown: false, byAgent: true, text: detail ? `Team Room (${detail})` : "Team Room" };
    }
    case "unknown":
      // The server may name what it knows without knowing who (decision P10):
      // "Changed outside Agent OS". A bare "—" or an empty label stays unknown.
      if (label && label !== "—") return { who: label, detail: "", unknown: false, byAgent: false, text: label };
      return { who: "—", detail: "", unknown: true, byAgent: false, text: "—" };
    default:
      return { who: "—", detail: "", unknown: true, byAgent: false, text: "—" };
  }
}

const ROOM_ID_PATTERN = /^room-\d{8}-\d{6}-[0-9a-f]{4}$/;
const ACTION_ID_PATTERN = /^A\d{1,4}$/;

// Review Focus 3: "Undo this save" is offered only when the server named a Team
// Room save with both ids, and both ids look exactly like real ones. A file
// whose history is gone, or that changed after the agent's save, arrives as kind
// "unknown", so this returns null and the page draws no Undo button.
export function undoTarget(savedBy: WorkspaceSavedBy | null | undefined): { roomId: string; actionId: string } | null {
  if (!savedBy || savedBy.kind !== "team-room") return null;
  const { roomId, actionId } = savedBy;
  if (typeof roomId !== "string" || typeof actionId !== "string") return null;
  return ROOM_ID_PATTERN.test(roomId) && ACTION_ID_PATTERN.test(actionId) ? { roomId, actionId } : null;
}

// ---------- the page header, and what the pane shows ----------

// What the pane on the right is showing. One function decides it, so the page
// and the pane's accessible name always agree.
export type PaneMode = "preview" | "opening" | "blocked" | "form";

export function paneMode(opts: { fileFound: boolean; wantsFile: boolean; loadState: "loading" | "ready" | "error" }): PaneMode {
  if (opts.fileFound) return "preview";
  if (opts.wantsFile && opts.loadState === "loading") return "opening";
  if (opts.wantsFile && opts.loadState === "error") return "blocked";
  return "form";
}

export const PANE_LABEL: Record<PaneMode, string> = {
  preview: "File preview",
  opening: "Opening the file",
  blocked: "File could not be opened",
  form: "New note"
};

// The line under the page title. `demoPublic` is null until the status request
// has answered (or while it keeps failing); then the words claim nothing that is
// true in only one mode: no "private folder" and no "shared with every visitor".
// The approval sentence is about Team Room proposals only, because other writers
// (live chat, demo actions) save without a Team Room approval (decision P8).
const TEAM_ROOM_RULE = "A file an agent proposes in a Team Room waits for your approval first.";

export function workspaceLede(demoPublic: boolean | null): string {
  if (demoPublic === true) return "A shared workspace on the public demo server. Sample notes are already here.";
  if (demoPublic === false) return `A private folder for your notes and the files saved here. ${TEAM_ROOM_RULE}`;
  return `The notes and files saved in this workspace. ${TEAM_ROOM_RULE}`;
}

// Said under "No files yet". It names the form, not a side of the screen: the
// columns stack at 900 px and below, so "on the right" is not always true.
export const NO_FILES_BODY = "Write a note in the New note form, or approve a file in a Team Room. Saved files appear here.";

// ---------- notes ----------

export const NOTE_EXTS = ["md", "txt", "html"] as const;
export type NoteExt = (typeof NOTE_EXTS)[number];

// The file name the server will really write. It applies the same cleaning as
// sanitizeWriteRelativePath (server/runtime/workspace.js): any character that is
// not a letter, digit, dot, dash or underscore becomes a dash and runs of dashes
// shrink to one. It also trims dashes and dots off both ends, so "Ideas!" is not
// saved as "Ideas-.md". The server cleans an already clean name the same way, so
// the name shown in "Saved as" is the name that is written. An empty name
// becomes note-<date>. `todayIso` is a date such as "2026-10-12".
export function noteFileName(rawName: string, ext: NoteExt, todayIso: string): string {
  let base = rawName.trim().replace(/\.(md|txt|html)$/i, "");
  base = base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[.-]+/, "").slice(0, 80).replace(/[.-]+$/, "");
  if (!base) base = `note-${todayIso}`;
  return `${base}.${ext}`;
}

// ---------- paths ----------

// Joins a folder and a "a/b.md" path with the folder's own separator.
export function joinNative(root: string, relative: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
  return `${base}${sep}${relative.split("/").filter(Boolean).join(sep)}`;
}

type Roots = WorkspaceListing["roots"];

// The real path of a file on this machine, or null when the server did not say
// (the public demo). Only Show in Finder needs it.
export function absolutePathOf(file: WhereItLives, roots: Roots): string | null {
  const root = roots.find((item) => item.id === file.root);
  return root?.absolutePath ? joinNative(root.absolutePath, file.relativePath) : null;
}

// What Copy path puts on the clipboard: the real path when known, else the display path.
export function copyPathOf(file: WhereItLives & Pick<WorkspaceFile, "publicPath">, roots: Roots): string {
  return absolutePathOf(file, roots) || file.publicPath;
}

// The workspace folder as the page shows it ("~/.hermes-agent-os/workspace") and,
// when the server says so, as the real path on this machine (for Show in Finder).
export function sandboxPaths(roots: Roots): { display: string; absolute: string | null } {
  const root = roots.find((item) => item.id === "workspace");
  return { display: root?.publicPath || "", absolute: root?.absolutePath || null };
}

// ---------- messages in plain words ----------

export interface Notice {
  tone: "ok" | "warn" | "danger";
  text: string;
}

// A fetch that never got an answer throws a plain TypeError (the network
// dropped), and a request that took too long throws the plain Error from
// withTimeout. Neither is one of our two error classes. The page cannot know
// whether the server saw such a request, so its words never say "nothing was
// changed" or "nothing was saved" for it.
function unreachable(error: unknown): boolean {
  return !(error instanceof ApiError) && !(error instanceof TeamRoomError);
}

// withTimeout (homeShared.ts) rejects with a plain Error whose words are
// "Agent OS did not answer in time." That is a different fact from a dropped
// connection: the server may be busy, and it may even have done the work.
export function timedOut(error: unknown): boolean {
  return error instanceof Error && !(error instanceof ApiError) && !(error instanceof TeamRoomError) && /did not answer in time/i.test(error.message);
}

// The list answered 200 but without a `files` array. That is not an empty
// workspace; it is an answer the page cannot use, so it is an error.
export class UnreadableListing extends Error {
  constructor() {
    super("The file list had no files array.");
    this.name = "UnreadableListing";
  }
}

export function isListing(data: unknown): data is WorkspaceListing {
  return typeof data === "object" && data !== null && Array.isArray((data as { files?: unknown }).files);
}

export interface ListProblem {
  // The headline when there is no list at all.
  title: string;
  body: string;
  // The warning above a list that is still on screen but could not be refreshed.
  stale: string;
  // The words when a file was asked for and there is no list to find it in.
  file: string;
}

function listProblemFor(cause: string, hint: string): ListProblem {
  return {
    title: cause,
    body: `The file list could not load. ${hint}`,
    stale: `Could not refresh the list. ${cause}, so the files shown may be out of date.`,
    file: `${cause}. ${hint}`
  };
}

// Why the file list did not load, said as exactly as the page can know it: the
// server answered with an error (5xx), refused (4xx), sent something unreadable,
// took too long, or could not be reached at all.
export function listProblem(error: unknown): ListProblem {
  if (error instanceof ApiError) {
    return error.status >= 500
      ? listProblemFor("Agent OS had a problem reading the folder", "Try again in a moment.")
      : listProblemFor("Agent OS could not list the files", "Try again.");
  }
  if (error instanceof UnreadableListing || error instanceof SyntaxError) {
    return listProblemFor("Agent OS sent a list this page could not read", "Try again in a moment.");
  }
  if (timedOut(error)) return listProblemFor("Agent OS did not answer in time", "Try again.");
  return listProblemFor("Agent OS can't be reached", "Check that Agent OS is still running, then try again.");
}

// What the Undo answer said, in words that are true. `action` is the server's
// own record of the save it undid (the Undo route's reply): `created` means the
// Team Room made the file, `updated` that it changed one that was there. `still`
// is whether the reloaded list still has the file, or null when it could not reload.
export function undoDoneText(action: { created?: unknown; updated?: unknown } | null | undefined, name: string, still: boolean | null): string {
  if (still === null) return `Undone. The list could not refresh, so press Refresh to see ${name}.`;
  if (action?.created === true && still === false) return `Undone. The Team Room had created ${name}, so it was removed.`;
  if (action?.created === false && action.updated === true && still === true) return `Undone. ${name} is back to how it was before the Team Room saved it.`;
  return "Undone.";
}

// The server's own sentence for a refusal, when it sent one. Without a
// "message" the client falls back to the bare code ("backup_missing"), and a
// bare code is never shown to a person, so that reads as no sentence.
function serverSentence(error: TeamRoomError): string {
  const text = typeof error.message === "string" ? error.message.trim() : "";
  return text && text !== error.code ? text : "";
}

function endWithStop(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function undoProblemText(error: unknown): string {
  if (error instanceof TeamRoomError) {
    switch (error.code) {
      case "room_not_found":
      case "action_not_found":
        return "The Team Room record for this save is gone, so Agent OS cannot undo it from here. The file is unchanged.";
      case "already_undone":
        return "That save was already undone.";
      case "nothing_to_undo":
        return "That save was refused when it was made, so there is nothing to undo.";
      case "cannot_undo":
        return "That kind of save cannot be undone.";
      case "path_mismatch":
        return "The Team Room record does not match this file, so Undo refused. Nothing was changed.";
      // The two refusals the server words itself (Task A4) show its sentence
      // as it is. "backup_missing" is refused before anything is written, so
      // "the file is unchanged" is true after it.
      case "changed_since_save":
        return serverSentence(error) || "The file changed after the agent saved it, so Undo would throw that change away. Nothing was changed.";
      case "backup_missing": {
        const sentence = serverSentence(error);
        return sentence
          ? `${endWithStop(sentence)} The file is unchanged.`
          : "The copy of the file from before this save is missing, so Agent OS cannot undo it. The file is unchanged.";
      }
      case "link_refused":
        return serverSentence(error) || "A link in the way was refused, so Undo did nothing. Nothing was changed.";
      default:
        // A server error says nothing about what was or was not changed.
        if (error.status >= 500) return "Something went wrong inside Agent OS. Press Refresh to see how the file is now.";
        return serverSentence(error) || "Undo did not work. Nothing was changed.";
    }
  }
  if (unreachable(error)) {
    return "Agent OS did not answer, so it is not known whether the save was undone. Press Refresh to check.";
  }
  return "Undo did not work. Press Refresh to see how the file is now.";
}

// True when the server refused the note before it wrote anything (a 4xx), so
// "not saved" is a fact. A server error (5xx) or no answer at all leaves it
// unknown whether the note was written.
export function saveOutcomeKnown(error: unknown): boolean {
  return error instanceof ApiError && error.status < 500;
}

export function saveProblemText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.detail) return error.detail;
    if (error.status === 413) return "That note is too big. A note can hold up to 256 KB of text.";
    if (error.status === 403) return "That place is outside the workspace, so nothing was saved.";
    if (error.status === 400) return "Agent OS could not save a note with that name or text. Change the name and try again.";
    if (error.status >= 500) return "Agent OS hit a problem while saving. Press Refresh to see whether it was saved.";
    return "Agent OS could not save the note. Nothing was saved.";
  }
  if (unreachable(error)) {
    return "Agent OS did not answer, so it is not known whether the note was saved. Press Refresh to check the list.";
  }
  return "Agent OS hit a problem while saving. Press Refresh to see whether it was saved.";
}

// A date for a hover title. A value that cannot be read gives "", never "Invalid Date".
export function whenTitle(iso: string | undefined | null): string {
  if (!iso) return "";
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? "" : when.toLocaleString();
}

// `gone` means the file left the workspace since the list loaded. The server
// answers 500 with an ENOENT text for a missing file (it does not map it to 404),
// so both are read as "gone". The raw text is never shown.
export function previewProblem(error: unknown): { text: string; gone: boolean } {
  if (error instanceof ApiError && (error.status === 404 || /ENOENT/.test(error.message))) {
    return { text: "This file is no longer in the workspace.", gone: true };
  }
  if (timedOut(error)) return { text: "Agent OS did not answer in time.", gone: false };
  if (unreachable(error)) return { text: "Agent OS can't be reached, so this file could not be opened.", gone: false };
  return { text: "Agent OS could not open this file.", gone: false };
}
