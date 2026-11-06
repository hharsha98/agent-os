// The folder policy for sessions (spec D12, SP3 "Folder policy"): any real
// folder inside the person's HOME; never HOME itself; never Agent OS's own
// folders (AGENT_OS_HOME, except its worktrees/, and the managed Node folder,
// planning decision Q12). Sessions never use the runs sandbox (resolveRunCwd);
// runs stay sandboxed as today. Inside the folder the agent asks its own
// permissions, exactly as in Terminal.
import { constants as fsConstants, realpath as realpathCallback, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { managedNodeRoot } from "../setup/managed-node.js";
import { readJson, runtimePaths } from "../store.js";

// fs.realpath.native gives the letter case stored on disk on macOS and Windows
// (the plain JavaScript fs.realpath keeps whatever case was typed).
const realpathNative = promisify(realpathCallback.native);

const MESSAGES = {
  not_absolute: "Type the full path, starting with / (or a drive letter on Windows).",
  missing: "That folder doesn't exist.",
  unreadable: "Agent OS can't open that folder.",
  not_a_directory: "That is a file, not a folder.",
  is_home: "Your home folder itself can't be used. Pick a folder inside it.",
  outside_home: "Pick a folder inside your home folder.",
  inside_agent_os: "Agent OS's own folder can't be used."
};

function refuse(code, message = MESSAGES[code]) {
  return { ok: false, code, message };
}

// macOS and Windows volumes usually ignore letter case, so every comparison
// there does too (the 0.3.2 security fix was exactly such a case bypass).
function foldCase(value, platform) {
  return platform === "darwin" || platform === "win32" ? value.toLowerCase() : value;
}

function isSameOrInside(child, parent, platform) {
  const c = foldCase(child, platform);
  const p = foldCase(parent, platform);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// The real path of a folder the input is compared with, or the path as given
// when it does not exist (nothing real can be inside a missing folder).
async function canonical(dir) {
  try {
    return await realpathNative(dir);
  } catch {
    return path.resolve(dir);
  }
}

// { ok: true, path, name } or { ok: false, code, message }. `path` is the
// real path (symlinks resolved, on-disk letter case), so a symlink can't
// escape: the resolved path is what must pass.
export async function checkSessionFolder(
  input,
  { home = os.homedir(), agentOsHome = runtimePaths().root, managedRoot = managedNodeRoot(), platform = process.platform } = {}
) {
  const typed = typeof input === "string" ? input.trim() : "";
  if (!typed || typed.includes("\0") || !path.isAbsolute(typed)) return refuse("not_absolute");
  let real;
  try {
    real = await realpathNative(typed);
  } catch (error) {
    const gone = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    return gone ? refuse("missing") : refuse("missing", MESSAGES.unreadable);
  }
  let info;
  try {
    info = await fs.stat(real);
  } catch {
    return refuse("missing");
  }
  if (!info.isDirectory()) return refuse("not_a_directory");
  // A folder that exists but the account can't enter or list (mode 000, or
  // another account's): the session could not start in it, so it is refused now
  // with the same code as a folder that can't be found, but its own message.
  try {
    await fs.access(real, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return refuse("missing", MESSAGES.unreadable);
  }

  const [homeReal, agentOsReal, managedReal] = await Promise.all([canonical(home), canonical(agentOsHome), canonical(managedRoot)]);
  if (foldCase(real, platform) === foldCase(homeReal, platform)) return refuse("is_home");
  const worktreesReal = path.join(agentOsReal, "worktrees");
  const inWorktrees = isSameOrInside(real, worktreesReal, platform);
  if (isSameOrInside(real, agentOsReal, platform) && !inWorktrees) return refuse("inside_agent_os");
  // <AGENT_OS_HOME>/worktrees stays allowed (D12) even when AGENT_OS_HOME is the managed Node folder or sits inside it
  // (AGENT_OS_HOME=~/.agent-os, the managed folder's default place). A managed folder placed inside worktrees/ itself
  // stays refused.
  if (isSameOrInside(real, managedReal, platform) && !(inWorktrees && !isSameOrInside(managedReal, worktreesReal, platform))) {
    return refuse("inside_agent_os");
  }
  if (!isSameOrInside(real, homeReal, platform)) return refuse("outside_home");
  return { ok: true, path: real, name: path.basename(real) };
}

// The latest of the row's times. Task S6 writes lastUsedAt (the latest start,
// resume or end); startedAt and endedAt still count, so a meta.json without
// lastUsedAt sorts by them.
function lastUsedMs(meta) {
  const times = [meta.lastUsedAt, meta.startedAt, meta.endedAt]
    .filter((value) => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// The folders of earlier sessions, newest first, each checked again (a folder
// that was deleted or moved, or no longer passes the policy, is left out). Update
// sessions (the agent's own checkout) and sessions whose folder Agent OS did
// not choose (OpenClaw, folderShown false) are not offered.
export async function recentSessionFolders({ limit = 8 } = {}) {
  const dir = runtimePaths().sessions;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => readJson(path.join(dir, entry.name, "meta.json"), null))
  );
  const candidates = [];
  for (const meta of metas) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    if (meta.kind === "update" || meta.folderShown === false) continue;
    // A session in a separate copy gives back the project it copied (ruling R25, K14).
    const folder = typeof meta.copyOf === "string" && meta.copyOf ? meta.copyOf : meta.folder;
    if (typeof folder !== "string" || !folder) continue;
    const at = lastUsedMs(meta);
    if (at !== null) candidates.push({ folder, at });
  }
  candidates.sort((a, b) => b.at - a.at);
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  const out = [];
  const seenTyped = new Set();
  const seenReal = new Set();
  // Recent folders never list a separate copy (R25): one typed by hand, or one whose project is unknown.
  const worktreesReal = path.join(await canonical(runtimePaths().root), "worktrees");
  for (const { folder, at } of candidates) {
    if (out.length >= max) break;
    if (seenTyped.has(folder)) continue;
    seenTyped.add(folder);
    const check = await checkSessionFolder(folder);
    if (!check.ok || seenReal.has(check.path) || isSameOrInside(check.path, worktreesReal, process.platform)) continue;
    seenReal.add(check.path);
    out.push({ path: check.path, name: check.name, lastUsedAt: new Date(at).toISOString() });
  }
  return out;
}
