import crypto from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { demoWorkspaceFiles, isDemoPublic } from "./demo-public.js";
import { ensureRuntimeStore, publicRuntimePath, readJson, runtimePaths, writeJson } from "./store.js";
import { ACTION_ID_PATTERN, isValidRoomId, readDecision } from "./team-room/room-store.js";

const ROOT_IDS = new Set(["workspace", "exports"]);
const WRITE_EXTS = new Set([".md", ".txt", ".html"]);
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function extnameOf(filePath) {
  return path.extname(filePath || "").toLowerCase();
}

export function workspaceKind(filePath) {
  const ext = extnameOf(filePath);
  if ([".html", ".htm"].includes(ext)) return "html";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
  if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  if ([".txt", ".md", ".json", ".csv", ".css", ".js", ".ts"].includes(ext)) return "text";
  return "other";
}

function mimeFor(filePath) {
  return MIME_BY_EXT[extnameOf(filePath)] || "application/octet-stream";
}

function parseFileId(id) {
  const raw = String(id || "").trim();
  if (!raw) throw httpError(400, "file id is required");
  if (raw.includes("\0") || raw.includes("\\")) throw httpError(400, "invalid file id");
  const slash = raw.indexOf("/");
  const rootId = slash === -1 ? raw : raw.slice(0, slash);
  const relativePath = slash === -1 ? "" : raw.slice(slash + 1);
  if (!ROOT_IDS.has(rootId)) throw httpError(400, "file must be inside workspace or exports");
  if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw httpError(400, "file path is not allowed");
  }
  return { rootId, relativePath };
}

async function rootDir(rootId) {
  await ensureRuntimeStore();
  const paths = runtimePaths();
  return rootId === "exports" ? paths.exports : paths.workspace;
}

async function assertInsideRoot(root, candidate) {
  const realRoot = await fs.realpath(root);
  const realCandidate = await fs.realpath(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(403, "file is outside the Agent OS sandbox");
  }
  return { realRoot, realCandidate, relative };
}

async function walkDir(rootId, dir, relativeDir, depth, files) {
  if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith(".")) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(rootId, fullPath, relativePath, depth + 1, files);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    try {
      const root = await rootDir(rootId);
      const inside = await assertInsideRoot(root, fullPath);
      const stat = await fs.stat(inside.realCandidate);
      if (!stat.isFile()) continue;
      files.push({
        id: `${rootId}/${relativePath}`,
        name: entry.name,
        relativePath,
        root: rootId,
        kind: workspaceKind(entry.name),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        publicPath: `${publicRuntimePath(rootId)}/${relativePath}`
      });
    } catch {
      // Skip broken links and anything outside the sandbox.
    }
  }
}

async function ensureDemoWorkspaceFiles() {
  const root = await rootDir("workspace");
  for (const file of demoWorkspaceFiles()) {
    const target = path.join(root, ...file.relativePath.split("/"));
    try {
      await fs.access(target);
    } catch {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, "utf8");
    }
  }
}

// ---- who saved each file ("Saved by") ------------------------------------------
//
// Every listed file carries `savedBy`: { kind, label, at?, roomId?, actionId? }
//   kind "you"        label "You"         a note from POST /api/workspace/files (kept in
//                                          config/workspace-provenance.json)
//   kind "unknown"    label "Changed outside Agent OS"
//                                          a Team Room file, or a note you saved, that was
//                                          changed after it was saved (Agent OS cannot tell
//                                          who changed it, so it does not say "You")
//   kind "agent-os"   label "Agent OS"    the one-time welcome note, and the demo files
//   kind "team-room"  label <agent name>  a Team Room saved it; roomId and actionId name the
//                                          save, read from the room's own decision.json
//   kind "unknown"    label "Team Room (can't check for later changes)"
//                                          a Team Room saved it, but the save recorded nothing to
//                                          compare the file with (a very old save), so Agent OS
//                                          can say neither that it is unchanged nor that it changed.
//                                          No roomId or actionId: Undo would refuse, so none is offered
//   kind "unknown"    label "—"           nothing on record (dropped in by hand, written by
//                                          an agent run, or the room's log is gone or damaged)
// The screen offers "Undo this save" only for kind "team-room", because only
// then are roomId and actionId present and the save is still the file's content.
const PROVENANCE_FILE = "workspace-provenance.json";
const WELCOME_MARKER = "workspace-welcome-seeded.json";
// A file's modified time and the log's clock are read a moment apart. A change
// counts as made outside Agent OS only if it is later than the last thing Agent
// OS did to the file by more than this.
const CLOCK_SLACK_MS = 2000;
const TEAM_FILE_PATH = /^team\/([^/]+)\/([^/]+)$/;
const NO_ONE = Object.freeze({ kind: "unknown", label: "—" });

// A file changed after Agent OS (or the person, through Agent OS) saved it.
// Agent OS cannot tell who changed it, so it names no one and offers no Undo.
function changedOutside(file) {
  return { kind: "unknown", label: "Changed outside Agent OS", at: file.updatedAt };
}

// A Team Room save with nothing recorded to compare the file with, so Agent OS cannot
// say whether the file changed since. That is not "Changed outside Agent OS": it may
// not have changed at all. It names the Team Room (the save is on record) and says what
// it cannot check. No roomId or actionId, so no Undo (Undo itself would refuse).
const CANNOT_CHECK_LABEL = "Team Room (can't check for later changes)";
function savedButUnchecked(save) {
  return { kind: "unknown", label: CANNOT_CHECK_LABEL, at: save.action.at };
}

// A short fingerprint of a file's text. The same one team-room/actions.js uses
// for Undo (that file imports this one, so it cannot be imported back).
function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function provenancePath() {
  return path.join(runtimePaths().config, PROVENANCE_FILE);
}

function millis(iso) {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

// The person's own notes: { "workspace/loop/x.md": { kind: "you", at } }. A
// missing, empty or damaged file reads as "no notes on record".
async function readUserRecords() {
  const data = await readJson(provenancePath(), null);
  const files = data && typeof data === "object" ? data.files : null;
  return files && typeof files === "object" && !Array.isArray(files) ? files : {};
}

// Changes are queued one after another so two quick saves cannot lose a record.
// `change(files)` returns true when it changed something worth writing.
let provenanceQueue = Promise.resolve();
function updateUserRecords(change) {
  const job = provenanceQueue.then(async () => {
    const files = await readUserRecords();
    if (change(files)) await writeJson(provenancePath(), { version: 1, files });
  });
  provenanceQueue = job.catch(() => {});
  return job;
}

function recordUserWrite(fileId) {
  return updateUserRecords((files) => {
    files[fileId] = { kind: "you", at: new Date().toISOString() };
    return true;
  });
}

// Anything but the person's own save makes the content someone else's.
function forgetUserWrite(fileId) {
  return updateUserRecords((files) => {
    if (!Object.hasOwn(files, fileId)) return false;
    delete files[fileId];
    return true;
  });
}

// A save worth naming: a real, finished file_write for a file inside this
// room's own folder. Mirrors what Undo itself insists on (actions.js).
function isUsableSave(action, short) {
  if (!action || typeof action !== "object" || action.kind !== "file_write" || action.failed) return false;
  if (typeof action.id !== "string" || !ACTION_ID_PATTERN.test(action.id)) return false;
  const match = typeof action.path === "string" ? TEAM_FILE_PATH.exec(action.path) : null;
  return Boolean(match) && match[1] === short;
}

// Each listed Team Room file's saves, from its room's actions log
// (teams/<room>/decision.json). Only rooms that have a file in the listing are
// read, and a room whose log is gone or damaged just has no saves.
async function readTeamSaves(files) {
  const shorts = new Set();
  for (const file of files) {
    const match = file.root === "workspace" ? TEAM_FILE_PATH.exec(file.relativePath) : null;
    if (match) shorts.add(match[1]);
  }
  const byPath = new Map();
  for (const short of shorts) {
    const roomId = `room-${short}`;
    if (!isValidRoomId(roomId)) continue;
    let decision;
    try {
      decision = await readDecision(roomId);
    } catch {
      continue;
    }
    for (const action of decision.actions) {
      if (!isUsableSave(action, short)) continue;
      const proposal = decision.proposals.find((item) => item && item.id === action.proposalId) || null;
      const saves = byPath.get(action.path) || [];
      saves.push({ roomId, action, proposal });
      byPath.set(action.path, saves);
    }
  }
  return byPath;
}

// The save whose content the file holds now: the latest one that was not
// undone. `lastTouch` is the last moment Agent OS itself changed the file (a
// save, or an Undo that put an older copy back).
function currentTeamSave(saves) {
  const live = saves.filter((save) => !save.action.undone).sort((a, b) => millis(a.action.at) - millis(b.action.at));
  const current = live[live.length - 1];
  if (!current) return null;
  const lastTouch = Math.max(...saves.map((save) => Math.max(millis(save.action.at), save.action.undone ? millis(save.action.undoneAt) : 0)));
  return { ...current, lastTouch };
}

// Does the file still hold what this Team Room save wrote? The modified time
// cannot say: an Undo that puts a person's edit back, or a copy that keeps its
// old date, leaves a time that looks like Agent OS's own. So this uses the rule
// Undo itself uses (actions.js): the fingerprint recorded with the save, or for
// older saves the proposal's own text. Three answers:
//   "same"      the file holds the saved text
//   "different" it does not: a comparison was made and it failed. A file that
//               cannot be read as plain text (a link, too big, unreadable) is
//               not what the room wrote either.
//   "unchecked" nothing was recorded to compare with. Undo refuses then (it
//               never runs blind), and nothing can be said about the file.
async function checkSavedText(file, save, workspaceRoot) {
  const expected =
    save.action.contentSha256 || (typeof save.proposal?.file?.content === "string" ? sha256(save.proposal.file.content) : null);
  if (!expected) return "unchecked";
  if (file.size > MAX_TEXT_PREVIEW_BYTES) return "different";
  try {
    const current = await readFileNoFollow(path.join(workspaceRoot, ...file.relativePath.split("/")));
    return current === null || sha256(current) === expected ? "same" : "different";
  } catch {
    return "different";
  }
}

// Plain, short text, whatever the log holds.
function agentNameOf(save) {
  const raw = save.proposal?.byLabel || save.proposal?.by;
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) : "";
  return name || "An agent";
}

async function savedByFor(file, { userRecords, teamSaves, welcomeFile, demoPaths, workspaceRoot }) {
  if (file.root !== "workspace") return NO_ONE;
  const saves = teamSaves.get(file.relativePath);
  const team = saves ? currentTeamSave(saves) : null;
  if (team) {
    // Changed after Agent OS last touched it, or no longer the saved text:
    // someone edited it outside. Undo would throw that edit away (it refuses),
    // so no room and no action are given.
    if (millis(file.updatedAt) > team.lastTouch + CLOCK_SLACK_MS) return changedOutside(file);
    const text = await checkSavedText(file, team, workspaceRoot);
    if (text === "different") return changedOutside(file);
    // Nothing to compare with: do not claim a change that may not have happened.
    if (text === "unchecked") return savedButUnchecked(team);
    return { kind: "team-room", label: agentNameOf(team), at: team.action.at, roomId: team.roomId, actionId: team.action.id };
  }
  const record = userRecords[file.id];
  if (record && record.kind === "you" && typeof record.at === "string" && Number.isFinite(Date.parse(record.at))) {
    // The record's time is taken just after the person's save was written, so
    // a file modified later than that is no longer the person's note.
    if (millis(file.updatedAt) > millis(record.at) + CLOCK_SLACK_MS) return changedOutside(file);
    return { kind: "you", label: "You", at: record.at };
  }
  if (file.relativePath === welcomeFile || demoPaths.has(file.relativePath)) return { kind: "agent-os", label: "Agent OS" };
  return NO_ONE;
}

async function attachSavedBy(files, { demoOn }) {
  const [userRecords, teamSaves, marker, workspaceRoot] = await Promise.all([
    readUserRecords(),
    readTeamSaves(files),
    readJson(path.join(runtimePaths().config, WELCOME_MARKER), null),
    rootDir("workspace")
  ]);
  const welcomeFile = typeof marker?.file === "string" ? marker.file : "";
  const demoPaths = new Set(demoOn ? demoWorkspaceFiles().map((item) => item.relativePath) : []);
  await Promise.all(
    files.map(async (file) => {
      file.savedBy = { ...(await savedByFor(file, { userRecords, teamSaves, welcomeFile, demoPaths, workspaceRoot })) };
    })
  );
}

export async function listWorkspaceFiles(input = {}) {
  await ensureRuntimeStore();
  await ensureWelcomeWorkspaceSeed();
  const demoOn = input.demoPublic === true || (input.demoPublic !== false && isDemoPublic());
  if (demoOn) await ensureDemoWorkspaceFiles();
  const query = String(input.query || "").trim().toLowerCase();
  const kind = String(input.kind || "").trim().toLowerCase();
  const files = [];
  await walkDir("workspace", await rootDir("workspace"), "", 0, files);
  await walkDir("exports", await rootDir("exports"), "", 0, files);
  await attachSavedBy(files, { demoOn });
  const filtered = files.filter((file) => {
    if (kind && kind !== "all" && file.kind !== kind) return false;
    if (!query) return true;
    return `${file.name} ${file.relativePath} ${file.publicPath}`.toLowerCase().includes(query);
  });
  // The real folder of each root, so the desktop app can show it in Finder.
  // publicPath above is display text only. A shared public demo server never
  // tells a visitor where its files live, so there it is null.
  const realFolders = runtimePaths();
  const roots = [
    { id: "workspace", label: "Workspace", publicPath: publicRuntimePath("workspace"), absolutePath: demoOn ? null : realFolders.workspace, fileCount: filtered.filter((file) => file.root === "workspace").length },
    { id: "exports", label: "Exports", publicPath: publicRuntimePath("exports"), absolutePath: demoOn ? null : realFolders.exports, fileCount: filtered.filter((file) => file.root === "exports").length }
  ];
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    roots,
    files: filtered,
    empty: files.length === 0,
    summary: {
      total: files.length,
      shown: filtered.length,
      // Counted over every file, not only the ones the filters show.
      savedByAgents: files.filter((file) => file.savedBy.kind === "team-room").length
    }
  };
}

const WELCOME_NOTE = `# Welcome to the Agent OS workspace

This folder is the **sandbox** for local v1.

- Path (public): \`~/.hermes-agent-os/workspace\`
- Loop briefings land in \`loop/\`
- Memory vault exports land in \`vault/\`
- You can write \`.md\`, \`.txt\`, or \`.html\` from the dashboard

This file was seeded once so a hiring-manager demo is not an empty list. Delete it anytime — Agent OS will not recreate it after the seed marker is set.
`;

async function ensureWelcomeWorkspaceSeed() {
  const paths = runtimePaths();
  const marker = path.join(paths.config, "workspace-welcome-seeded.json");
  try {
    await fs.access(marker);
    return;
  } catch {
    // Seed once per runtime home.
  }
  const target = path.join(paths.workspace, "inbox", "welcome.md");
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.access(target);
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, WELCOME_NOTE, "utf8");
  }
  await writeJson(marker, { seededAt: new Date().toISOString(), file: "inbox/welcome.md" });
}

export async function resolveWorkspaceFile(id) {
  const { rootId, relativePath } = parseFileId(id);
  const root = await rootDir(rootId);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const inside = await assertInsideRoot(root, candidate);
  const stat = await fs.stat(inside.realCandidate);
  if (!stat.isFile()) throw httpError(404, "workspace file not found");
  return {
    id: `${rootId}/${relativePath}`,
    name: path.basename(relativePath),
    relativePath,
    root: rootId,
    kind: workspaceKind(relativePath),
    mime: mimeFor(relativePath),
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    publicPath: `${publicRuntimePath(rootId)}/${relativePath}`,
    absolutePath: inside.realCandidate
  };
}

export async function getWorkspaceFile(id) {
  const file = await resolveWorkspaceFile(id);
  const canPreviewText = ["html", "text"].includes(file.kind) && file.size <= MAX_TEXT_PREVIEW_BYTES;
  let previewText = "";
  if (canPreviewText) {
    previewText = await fs.readFile(file.absolutePath, "utf8");
  }
  return {
    ok: true,
    file: {
      id: file.id,
      name: file.name,
      relativePath: file.relativePath,
      root: file.root,
      kind: file.kind,
      mime: file.mime,
      size: file.size,
      updatedAt: file.updatedAt,
      publicPath: file.publicPath
    },
    previewText,
    rawUrl: `/api/workspace/raw?id=${encodeURIComponent(file.id)}`
  };
}

// maxParts is 2 (one folder plus the file name) for everyone. Only trusted
// server code may pass a bigger number (the Team Room writes
// team/<room>/<file>); it is never read from a request body.
function sanitizeWriteRelativePath(input = {}, maxParts = 2) {
  const requested = String(input.relativePath || "").trim().replace(/\\/g, "/");
  const folder = String(input.folder || "loop").trim();
  const name = String(input.name || "").trim();
  const raw = requested || [folder, name].filter(Boolean).join("/");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.length > maxParts) {
    throw httpError(400, "workspace writes allow a file name and at most one folder");
  }
  const cleaned = parts.map((part) => {
    if (part === "." || part === "..") throw httpError(400, "file path is not allowed");
    const safe = part.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^\.+/, "").replace(/\.+$/, "");
    if (!safe) throw httpError(400, "file path is not allowed");
    return safe;
  });
  const fileName = cleaned[cleaned.length - 1];
  const ext = extnameOf(fileName);
  if (!WRITE_EXTS.has(ext)) {
    throw httpError(400, "only .md, .txt, or .html files can be written to the workspace sandbox");
  }
  return cleaned.join("/");
}

// ---- link (symlink) safety -------------------------------------------------
// A path check by name alone ("is it under workspace/?") is fooled by a
// symlink: workspace/team/x/notes.md could be a link to ~/.zshrc, and writing
// "to" it would overwrite the real target. So we also look at what is really
// on disk, and refuse links.

function linkRefused(message) {
  const error = httpError(403, message);
  error.code = "link_refused";
  return error;
}

// Walks the folders between `root` and the file (not the file itself) and
// refuses if any EXISTING one is a link. Stops at the first folder that does
// not exist yet, since nothing below it can be a link.
export async function assertNoLinksOnPath(root, relativeParts) {
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) throw linkRefused("refused: a folder on the path is a link");
    if (!info.isDirectory()) throw linkRefused("refused: a folder on the path is not a folder");
  }
}

// Refuses when the file itself is a link (or not a plain file). A missing
// file is fine: it is about to be created.
export async function assertNotALink(file) {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw linkRefused("refused: the target is a link");
  if (!info.isFile()) throw linkRefused("refused: the target is not a regular file");
}

// O_NOFOLLOW makes the operating system itself refuse a link, closing the
// small gap between "we looked" and "we wrote". Windows has no such flag, so
// there the lstat checks above are all we have.
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

function translateLinkError(error) {
  // ELOOP is what O_NOFOLLOW reports for a link.
  if (error?.code === "ELOOP") return linkRefused("refused: the target is a link");
  return error;
}

export async function writeFileNoFollow(file, content) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NO_FOLLOW, 0o666);
    await handle.writeFile(content, "utf8");
  } catch (error) {
    throw translateLinkError(error);
  } finally {
    await handle?.close();
  }
}

// Returns the file's text, or null if it does not exist. Never follows a link.
export async function readFileNoFollow(file) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | NO_FOLLOW);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw translateLinkError(error);
  } finally {
    await handle?.close();
  }
}

// `savedBy: "you"` is passed only by the route a person's own note goes through
// (POST /api/workspace/files); it is how the file later reads "Saved by You".
// Every other caller (the Team Room, live chat, briefings) leaves it out.
export async function writeWorkspaceText(input = {}, { maxParts = 2, savedBy = null } = {}) {
  const content = String(input.content ?? "");
  if (!content.trim()) throw httpError(400, "file content is required");
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_PREVIEW_BYTES) {
    throw httpError(413, "workspace file is too large");
  }
  const relativePath = sanitizeWriteRelativePath(input, maxParts);
  const root = await rootDir("workspace");
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(403, "file is outside the Agent OS sandbox");
  }
  const parts = relativePath.split("/");
  await assertNoLinksOnPath(root, parts.slice(0, -1));
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  // The real folder must still be inside the real workspace.
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(path.dirname(candidate));
  const inside = path.relative(realRoot, realParent);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw httpError(403, "file is outside the Agent OS sandbox");
  }
  await assertNotALink(candidate);
  await writeFileNoFollow(candidate, content);
  // Best effort: the note is saved either way. Without a fresh record it reads
  // "—" or "Changed outside Agent OS" (a record older than the file is never
  // trusted), so a failure here is logged, not shown.
  const fileId = `workspace/${relativePath}`;
  await (savedBy === "you" ? recordUserWrite(fileId) : forgetUserWrite(fileId)).catch((error) => {
    console.error(`Could not update the "Saved by" record for ${fileId}: ${error?.message || error}`);
  });
  return getWorkspaceFile(fileId);
}

export function streamWorkspaceFile(file, res) {
  res.setHeader("Content-Type", file.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // No allow-* tokens: the served file gets a unique origin, so its scripts
  // (e.g. a saved .html note) can't call back into our API.
  // frame-ancestors 'self' stays in here: this CSP replaces the one every response gets (R33).
  res.setHeader("Content-Security-Policy", "sandbox; frame-ancestors 'self'");
  // Not kept in the browser's shared cache: another local port could otherwise load the file from it without the page
  // key. The page keeps its own copy (R33).
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `inline; filename="${file.name.replace(/"/g, "")}"`);
  createReadStream(file.absolutePath).pipe(res);
}
