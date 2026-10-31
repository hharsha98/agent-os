import { promises as fs } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";

export const RUNTIME_VERSION = "0.4.0";
const runtimeContext = new AsyncLocalStorage();

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function osRoot() {
  const scopedHome = runtimeContext.getStore()?.home;
  // Keep the legacy directory as the compatibility default for existing users,
  // while accepting the product-neutral variable for new Agent OS installs.
  return expandHome(scopedHome || process.env.AGENT_OS_HOME || process.env.HERMES_AGENT_OS_HOME) || path.join(os.homedir(), ".hermes-agent-os");
}

export function withRuntimeHome(home, fn) {
  return runtimeContext.run({ home }, fn);
}

export function runtimePaths() {
  const root = osRoot();
  return {
    root,
    config: path.join(root, "config"),
    workflows: path.join(root, "workflows"),
    runs: path.join(root, "runs"),
    logs: path.join(root, "logs"),
    memory: path.join(root, "memory"),
    exports: path.join(root, "exports"),
    workspace: path.join(root, "workspace"),
    // Sessions (spec SP3): one folder per session id (meta.json, recording,
    // settings file). Worktrees: separate copies of a person's project (SP4).
    sessions: path.join(root, "sessions"),
    worktrees: path.join(root, "worktrees")
  };
}

// Folders below the root that hold private data (session recordings,
// settings files, copies of a person's projects): only the person's own
// account may open them (spec Security 5). The root is made private too, in
// ensureForgivingPrivateDir below.
const PRIVATE_DIRS = new Set(["sessions", "worktrees"]);

// mkdir -p with mode 0700, then a chmod, because mkdir's mode only applies to
// folders it creates and an older folder may have been made with 0755.
// Windows has no such modes, so there it only makes the folder.
export async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
  return dir;
}

// Folders already warned about, so each warning shows once, not on every call.
const warnedFolders = new Set();

// The root, sessions/ and worktrees/ are made private the same forgiving way:
// a folder another account owns can't be chmodded (EPERM, or EACCES on the way
// to it). ensureRuntimeStore() is shared by every store-backed feature (runs,
// workflows, config writes), so throwing here would make all of them fail, and
// stop the whole app, because of a folder only sessions care about. Only that
// folder's mode is given up, with a warning once per folder; the files written
// inside are still created 0600. Any other error still throws.
async function ensureForgivingPrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return dir;
  try {
    await fs.chmod(dir, 0o700);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    if (!warnedFolders.has(dir)) {
      warnedFolders.add(dir);
      console.warn("Agent OS could not make its folder private (0700): " + dir);
    }
  }
  return dir;
}

export async function ensureRuntimeStore() {
  const paths = runtimePaths();
  // The root first, so making a subfolder never creates it with the default mode.
  await ensureForgivingPrivateDir(paths.root);
  await Promise.all(
    Object.entries(paths)
      .filter(([name]) => name !== "root")
      .map(([name, dir]) => (PRIVATE_DIRS.has(name) ? ensureForgivingPrivateDir(dir) : fs.mkdir(dir, { recursive: true })))
  );
  return paths;
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    await renameOver(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return data;
}

// Windows refuses to rename over a file that another process has open for a moment (a reader, an antivirus scan, the
// search indexer) with EPERM, EACCES or EBUSY. So there the rename is tried again for about a second before the write
// fails; elsewhere a rename over an open file just works, and those codes mean a real permission problem.
// The real setTimeout is kept from load time, so a test that mocks the timers cannot stall a write.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 10;
const realSetTimeout = globalThis.setTimeout;

async function renameOver(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (process.platform !== "win32" || !RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_RETRIES) throw error;
      await new Promise((resolve) => realSetTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function publicRuntimePath(dirName) {
  return `~/.hermes-agent-os/${dirName}`;
}
