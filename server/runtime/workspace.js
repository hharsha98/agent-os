import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureRuntimeStore, publicRuntimePath, runtimePaths } from "./store.js";

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

export async function listWorkspaceFiles(input = {}) {
  await ensureRuntimeStore();
  const query = String(input.query || "").trim().toLowerCase();
  const kind = String(input.kind || "").trim().toLowerCase();
  const files = [];
  await walkDir("workspace", await rootDir("workspace"), "", 0, files);
  await walkDir("exports", await rootDir("exports"), "", 0, files);
  const filtered = files.filter((file) => {
    if (kind && kind !== "all" && file.kind !== kind) return false;
    if (!query) return true;
    return `${file.name} ${file.relativePath} ${file.publicPath}`.toLowerCase().includes(query);
  });
  const roots = [
    { id: "workspace", label: "Workspace", publicPath: publicRuntimePath("workspace"), fileCount: filtered.filter((file) => file.root === "workspace").length },
    { id: "exports", label: "Exports", publicPath: publicRuntimePath("exports"), fileCount: filtered.filter((file) => file.root === "exports").length }
  ];
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    roots,
    files: filtered,
    empty: files.length === 0,
    summary: {
      total: files.length,
      shown: filtered.length
    }
  };
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

function sanitizeWriteRelativePath(input = {}) {
  const requested = String(input.relativePath || "").trim().replace(/\\/g, "/");
  const folder = String(input.folder || "loop").trim();
  const name = String(input.name || "").trim();
  const raw = requested || [folder, name].filter(Boolean).join("/");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.length > 2) {
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

export async function writeWorkspaceText(input = {}) {
  const content = String(input.content ?? "");
  if (!content.trim()) throw httpError(400, "file content is required");
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_PREVIEW_BYTES) {
    throw httpError(413, "workspace file is too large");
  }
  const relativePath = sanitizeWriteRelativePath(input);
  const root = await rootDir("workspace");
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(403, "file is outside the Agent OS sandbox");
  }
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, content, "utf8");
  return getWorkspaceFile(`workspace/${relativePath}`);
}

export function streamWorkspaceFile(file, res) {
  res.setHeader("Content-Type", file.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=30");
  res.setHeader("Content-Disposition", `inline; filename="${file.name.replace(/"/g, "")}"`);
  createReadStream(file.absolutePath).pipe(res);
}
