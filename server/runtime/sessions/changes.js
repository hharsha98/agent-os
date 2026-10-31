// The changes panel (SP4): what changed in a session's repository, read with
// `git status --porcelain=v2` and `git diff --numstat`, and the read-only diff
// of one file. Nothing here writes: no git command that changes a repository
// (add, reset, checkout, stash, commit, ...) is ever run, and every git call
// goes through git.js (argv only, a 5 s limit, no index lock, no file monitor)
// with --no-ext-diff and --no-textconv on every diff, so git never runs a
// helper the person configured. Changes cover the whole repository and paths
// are relative to its top folder (K12). Untracked text files up to 512 KB are
// read here only to count their lines; their text is never kept.
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { sessionError } from "./errors.js";
import { gitTopLevel, runGit } from "./git.js";

export const CHANGES_POLL_MS = 3000;
export const CHANGES_MAX_FILES = 200;
export const DIFF_MAX_BYTES = 256 * 1024;
export const FILES_MARKER_MAX = 20;
export const CHANGES_REFRESH_DEBOUNCE_MS = 300;
export const CHANGE_MISSING_MESSAGE = "That file isn't in this session's changes anymore.";
// At most one "files changed" marker per session in this time (Q6): what
// changes in between is merged into the next marker.
export const FILES_MARKER_GAP_MS = 30000;
// An ended session's read is shared by requests that arrive while it runs and
// reused for this long (Q4).
export const ENDED_READ_REUSE_MS = 2000;
// The poll gives up on a session only after this many failed starts of git in
// a row (Q5); one failed spawn on a loaded Mac is not "git can't run here".
export const GIT_UNAVAILABLE_LIMIT = 3;

// An untracked file is counted only up to this size, and one read counts at
// most UNTRACKED_COUNT_BUDGET_BYTES in all, so a folder full of new files
// costs a bounded amount every 3 s; the rest show "—".
const UNTRACKED_COUNT_MAX_BYTES = 512 * 1024;
const UNTRACKED_COUNT_BUDGET_BYTES = 4 * 1024 * 1024;
// git calls a file binary when its first 8000 bytes hold a NUL; so does this.
const BINARY_PROBE_BYTES = 8000;
// The most text one status or numstat answer keeps (many thousands of paths).
const LIST_OUTPUT_CHARS = 8 * 1024 * 1024;
const TOP_LEVEL_ARGS = Object.freeze(["rev-parse", "--show-toplevel"]);
// --branch adds "# branch.oid (initial)" for a repository with no commit yet.
// --ignore-submodules=dirty: git never enters a submodule's working tree (it
// would read that submodule's own configuration, filters included).
const STATUS_ARGS = Object.freeze([
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--untracked-files=all",
  "--ignore-submodules=dirty"
]);
// --submodule=short: a submodule row is shown as the two commits it moved
// between (N2). A repository setting `diff.submodule=diff` would otherwise make
// git start a diff inside the submodule, which uses the submodule's own
// diff.external and textconv; the command line beats that setting.
const NUMSTAT_ARGS = Object.freeze([
  "diff",
  "--numstat",
  "-z",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=dirty",
  "--submodule=short"
]);
const DIFF_FLAGS = Object.freeze(["--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--submodule=short"]);
// The configured filter drivers (S1). `git config` only reads files: it runs
// nothing. Exit 1 means there are none.
const FILTER_LIST_ARGS = Object.freeze(["config", "--get-regexp", "-z", "^filter\\..+\\.(clean|smudge|process|required)$"]);
const FILTER_KEY = /^filter\.([\s\S]+)\.(clean|smudge|process|required)$/;
const FILTER_VARIABLES = Object.freeze(["clean", "smudge", "process", "required"]);
// What `git lfs install` writes. The "lfs" driver is left alone only when it
// holds exactly these values.
const LFS_STANDARD = Object.freeze({
  clean: "git-lfs clean -- %f",
  smudge: "git-lfs smudge -- %f",
  process: "git-lfs filter-process",
  required: "true"
});
// More drivers than this cannot all be switched off through the environment,
// so the read does not run at all.
const FILTER_DRIVERS_MAX = 200;
// git reads settings from GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n
// from this version on; an older git needs `-c name=value` pairs instead.
const CONFIG_ENV_MIN = Object.freeze([2, 31]);
const VERSION_ARGS = Object.freeze(["--version"]);
const GIT_VERSION = /git version (\d+)\.(\d+)/;
// Git's own words when the folder is simply not a repository (LC_ALL=C).
const NOT_A_REPOSITORY = /not a git repository/i;
const INITIAL_HEAD = /(?:^|\0)# branch\.oid \(initial\)\0/;
const COUNTS = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;
const BINARY_DIFF = /^(?:Binary files .* differ|GIT binary patch)$/m;
// Never follow a link, and never wait on a pipe someone left in the folder.
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

function iso(ms) {
  return new Date(ms).toISOString();
}

// An internal answer for the manager (never an HTTP answer): git_unavailable
// (git can't run here), git_timeout (a call hit its limit), git_failed.
function readError(code) {
  return Object.assign(new Error(`Agent OS could not read the changes from git (${code}).`), { code });
}

function changeMissing() {
  return sessionError(404, "change_missing", CHANGE_MISSING_MESSAGE);
}

// A path as git prints it, relative to the repository's top folder. Anything
// else (empty, absolute, a drive letter, a ".." part, a NUL) is never a change.
function safeRepoPath(value) {
  if (typeof value !== "string" || value === "" || value.length > 4096 || value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

function insideTop(top, file) {
  const root = path.resolve(top);
  const full = path.resolve(root, file);
  return full.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// The path after the first `count` space-separated fields of a status record.
// A path may hold spaces; with -z it is never quoted. "" when a field is missing.
function pathAfter(record, count) {
  let index = -1;
  for (let field = 0; field < count; field += 1) {
    index = record.indexOf(" ", index + 1);
    if (index === -1) return "";
  }
  return record.slice(index + 1);
}

// A "1" record's XY: the index status, then the worktree status ("." = unchanged).
function ordinaryStatus(xy) {
  if (xy.includes("D")) return xy[0] === "A" ? "other" : "deleted";
  if (xy[0] === "A") return "added";
  if (/[MT]/.test(xy)) return "modified";
  return "other";
}

export function parsePorcelainV2(text) {
  const records = String(text ?? "").split("\0");
  const files = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const kind = record.slice(0, 2);
    if (kind === "? ") {
      if (record.length > 2) files.push({ path: record.slice(2), status: "untracked" });
    } else if (kind === "1 ") {
      const file = pathAfter(record, 8);
      if (file) files.push({ path: file, status: ordinaryStatus(record.slice(2, 4)) });
    } else if (kind === "2 ") {
      // A rename or a copy: its original path is the next record.
      const file = pathAfter(record, 9);
      const oldPath = records[i + 1] ?? "";
      i += 1;
      if (file && oldPath) {
        files.push({ path: file, status: record.split(" ")[8].startsWith("C") ? "added" : "renamed", oldPath });
      }
    } else if (kind === "u ") {
      const file = pathAfter(record, 10);
      if (file) files.push({ path: file, status: "conflicted" });
    }
    // "# " headers and "! " ignored files are not changes.
  }
  return files;
}

export function parseNumstat(text) {
  const counts = new Map();
  const records = String(text ?? "").split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const match = COUNTS.exec(records[i]);
    if (!match) continue;
    let file = match[3];
    if (file === "") {
      // A rename: "<added>\t<removed>\t", then the old path, then the new one.
      file = records[i + 2] ?? "";
      i += 2;
    }
    if (!file) continue;
    counts.set(file, {
      added: match[1] === "-" ? null : Number(match[1]),
      removed: match[2] === "-" ? null : Number(match[2])
    });
  }
  return counts;
}

function addCounts(a, b) {
  if (!a) return b ? { added: b.added, removed: b.removed } : { added: null, removed: null };
  if (!b) return { added: a.added, removed: a.removed };
  return {
    added: a.added === null || b.added === null ? null : a.added + b.added,
    removed: a.removed === null || b.removed === null ? null : a.removed + b.removed
  };
}

function mergeCounts(first, second) {
  const merged = new Map(first);
  for (const [file, count] of second) merged.set(file, addCounts(merged.get(file), count));
  return merged;
}

// A renamed file whose rename git's diff did not pair itself also gets its old
// path's counts (shown as removed lines), so the row still shows the change.
function withCounts(file, counts) {
  const own = counts.get(file.path);
  const old = file.oldPath === undefined ? undefined : counts.get(file.oldPath);
  const { added, removed } = addCounts(own, old);
  const entry = { path: file.path, status: file.status, added, removed };
  if (file.oldPath !== undefined) entry.oldPath = file.oldPath;
  return entry;
}

// The output of `git config --get-regexp -z` for filter.<name>.<variable>:
// "key\nvalue\0" records (a key without a value has no "\n"). Returns
// Map<name, { clean, smudge, process, required }> with every configured value
// of each variable in a list (null for a key that has no value). A name may
// hold dots and "=" signs: the variable is what follows the last dot.
export function parseFilterConfig(text) {
  const drivers = new Map();
  for (const record of String(text ?? "").split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? null : record.slice(newline + 1);
    const match = FILTER_KEY.exec(key);
    if (!match) continue;
    const [, name, variable] = match;
    if (!drivers.has(name)) drivers.set(name, { clean: [], smudge: [], process: [], required: [] });
    drivers.get(name)[variable].push(value);
  }
  return drivers;
}

function isStandardLfs(driver) {
  return FILTER_VARIABLES.every((variable) => driver[variable].every((value) => value === LFS_STANDARD[variable]));
}

// The git settings that switch every configured filter driver off for one read
// (S1): no clean, smudge or process command, and `required=false` (git stops
// with an error when a required filter has no command). A git filter is a
// program the repository's own configuration names, so a file a session
// changed could otherwise make this server run it every few seconds. The
// driver named "lfs" is left alone only while it holds exactly git-lfs's
// standard values; any other value there is switched off like the rest.
// `all: true` (Task X9, separate copies: a checkout runs smudge filters) leaves
// no driver alone, git-lfs's included, so large-file pointers stay pointers.
// Returns [key, value] pairs for runGit's `config` option.
export function filterOverrides(text, { all = false } = {}) {
  const drivers = parseFilterConfig(text);
  if (drivers.size > FILTER_DRIVERS_MAX) throw readError("git_failed");
  const config = [];
  for (const [name, driver] of drivers) {
    if (!all && name === "lfs" && isStandardLfs(driver)) continue;
    config.push(
      [`filter.${name}.clean`, ""],
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"]
    );
  }
  return config;
}

// Lists the filter drivers configured for this repository, then returns the
// settings that switch them off. A filter someone adds between this call and
// the status call that follows is not caught (accepted).
async function filterConfig(top, env, run, options) {
  const result = await run(top, [...FILTER_LIST_ARGS], { env, okCodes: [0, 1], maxChars: LIST_OUTPUT_CHARS });
  if (!result.ok) throw readError(result.timedOut ? "git_timeout" : "git_failed");
  // A list cut at LIST_OUTPUT_CHARS may miss drivers: switch off nothing less than all of them.
  if (result.stdout.length >= LIST_OUTPUT_CHARS) throw readError("git_failed");
  return filterOverrides(result.stdout, options);
}

// "git version 2.39.5 (Apple Git-154)" -> { major: 2, minor: 39 }; null when
// the text holds no version.
export function parseGitVersion(text) {
  const match = GIT_VERSION.exec(String(text ?? ""));
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

function readsConfigFromEnv(version) {
  const [major, minor] = CONFIG_ENV_MIN;
  return version.major > major || (version.major === major && version.minor >= minor);
}

// Whether this git reads settings from GIT_CONFIG_COUNT and its KEY/VALUE
// variables (2.31 and newer). `git` is found through the session's PATH, and
// two sessions may reach different gits, so the version is read once per PATH
// value (N4) and only when some filter has to be switched off. The outer
// WeakMap only keeps one runner's answers apart from another's (the real
// runGit is one function; an injected test runner has its own). A version that
// cannot be read is not remembered and counts as "older": the argv form below
// works on any git.
const configEnvKnown = new WeakMap();
function pathOf(env) {
  return String(env?.PATH ?? env?.Path ?? "");
}
async function gitReadsConfigFromEnv(top, env, run) {
  const key = pathOf(env);
  let byPath = configEnvKnown.get(run);
  if (byPath?.has(key)) return byPath.get(key);
  const result = await run(top, [...VERSION_ARGS], { env });
  const version = result?.ok ? parseGitVersion(result.stdout) : null;
  if (!version) return false;
  const answer = readsConfigFromEnv(version);
  if (!byPath) {
    byPath = new Map();
    configEnvKnown.set(run, byPath);
  }
  byPath.set(key, answer);
  return answer;
}

// How the settings that switch the filters off reach git (S1):
// { config, prefix }. `config` is for runGit's `config` option (the
// environment form, git 2.31 and newer); `prefix` goes in front of the git
// subcommand (`-c filter.<name>.clean=` and so on, for an older git, so the
// protection never silently stops). `-c name=value` cuts the name at the first
// "=", so a driver whose name holds one cannot be switched off that way: the
// read does not run (git_failed, the last result stays) rather than run git
// with that filter active.
// Exported for Task X9 (separate copies), which passes `{ all: true }` so that
// git-lfs's driver is switched off too; it throws the same internal errors.
export async function filterSettings(top, env, run, options = {}) {
  const overrides = await filterConfig(top, env, run, options);
  if (overrides.length === 0) return { config: [], prefix: [] };
  if (await gitReadsConfigFromEnv(top, env, run)) return { config: overrides, prefix: [] };
  if (overrides.some(([key]) => key.includes("="))) throw readError("git_failed");
  return { config: [], prefix: overrides.flatMap(([key, value]) => ["-c", `${key}=${value}`]) };
}

async function numstat(top, tail, env, run, filters) {
  const result = await run(top, [...filters.prefix, ...NUMSTAT_ARGS, ...tail], {
    env,
    maxChars: LIST_OUTPUT_CHARS,
    config: filters.config
  });
  if (!result.ok) throw readError(result.timedOut ? "git_timeout" : "git_failed");
  return parseNumstat(result.stdout);
}

function lineCount(data) {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let index = data.indexOf(0x0a); index !== -1; index = data.indexOf(0x0a, index + 1)) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

// Untracked files have no numstat: a text file's line count is its `added`.
// `stopIfAsked` throws when the session's poll was stopped (Q3).
async function countUntracked(top, files, stopIfAsked) {
  let budget = UNTRACKED_COUNT_BUDGET_BYTES;
  for (const file of files) {
    stopIfAsked();
    if (file.status !== "untracked" || !safeRepoPath(file.path) || !insideTop(top, file.path)) continue;
    let handle = null;
    try {
      handle = await fs.open(path.join(top, file.path), OPEN_FLAGS);
      const info = await handle.stat();
      if (!info.isFile() || info.size > UNTRACKED_COUNT_MAX_BYTES || info.size > budget) continue;
      budget -= info.size;
      const data = await handle.readFile();
      if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
      file.added = lineCount(data);
      file.removed = 0;
    } catch {
      // gone, a link or unreadable: no count ("—")
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

// `isStopped()` is asked between the git calls: a read for a poll that was
// stopped (the session ended, or Agent OS is quitting) stops there with the
// internal error `git_stopped` instead of running the rest (Q3).
export async function readChanges(folder, { env, run = runGit, now = Date.now, isStopped = () => false } = {}) {
  const stopIfAsked = () => {
    if (isStopped()) throw readError("git_stopped");
  };
  const probe = await run(folder, [...TOP_LEVEL_ARGS], { env });
  stopIfAsked();
  if (!probe.ok) {
    if (probe.timedOut) throw readError("git_timeout");
    if (probe.code === 128) {
      // 128 is git's own "fatal". Only "not a git repository" means this folder
      // is no project; anything else (a repository git refuses to open because
      // of its owner, a damaged one) is a failed read that keeps the last
      // result, so the panel never says "not a git project" for a real one (S3).
      if (NOT_A_REPOSITORY.test(String(probe.stderr ?? ""))) return { git: false, files: [], total: 0, at: iso(now()) };
      throw readError("git_failed");
    }
    // It never started (code null), or something else answered in git's place
    // (macOS asking to install its developer tools).
    throw readError("git_unavailable");
  }
  const top = probe.stdout.replace(/\r?\n$/, "");
  if (!top) throw readError("git_failed");
  const filters = await filterSettings(top, env, run);
  stopIfAsked();
  const status = await run(top, [...filters.prefix, ...STATUS_ARGS], {
    env,
    maxChars: LIST_OUTPUT_CHARS,
    config: filters.config
  });
  stopIfAsked();
  if (!status.ok) throw readError(status.timedOut ? "git_timeout" : "git_failed");
  // A list cut at LIST_OUTPUT_CHARS loses its last, partial record.
  const text =
    status.stdout.length >= LIST_OUTPUT_CHARS ? status.stdout.slice(0, status.stdout.lastIndexOf("\0") + 1) : status.stdout;
  const all = parsePorcelainV2(text);
  // No commit yet: what is staged against nothing, plus the worktree against the index.
  const counts = INITIAL_HEAD.test(text)
    ? mergeCounts(await numstat(top, ["--cached", "--"], env, run, filters), await numstat(top, ["--"], env, run, filters))
    : await numstat(top, ["HEAD", "--"], env, run, filters);
  stopIfAsked();
  const files = all.slice(0, CHANGES_MAX_FILES).map((file) => withCounts(file, counts));
  await countUntracked(top, files, stopIfAsked);
  return { git: true, files, total: all.length, at: iso(now()) };
}

function countKey(file) {
  return `${file.added}:${file.removed}`;
}

// Only the counts decide (K12): staging a file with the same counts, or a file
// that left the list (committed or put back), is not a change. Never for the
// first read after a start, or the first read of a folder that just became a
// git project.
export function filesMarker(previous, next) {
  if (previous?.git !== true || next?.git !== true) return null;
  const before = new Map(previous.files.map((file) => [file.path, countKey(file)]));
  const changed = next.files.filter((file) => before.get(file.path) !== countKey(file));
  if (changed.length === 0) return null;
  return {
    at: next.at,
    type: "files",
    files: changed.slice(0, FILES_MARKER_MAX).map((file) => ({ path: file.path, added: file.added, removed: file.removed })),
    more: Math.max(0, changed.length - FILES_MARKER_MAX)
  };
}

// "Files changed" moments waiting for their turn (Q6). The manager records at
// most one marker per FILES_MARKER_GAP_MS, so the markers `filesMarker` finds
// in between are merged here: the newest counts of each path in the order the
// paths first appeared, at most FILES_MARKER_MAX listed and `more` counting
// the rest. A single marker passes through unchanged.
const PENDING_FILES_MAX = CHANGES_MAX_FILES;

export function newPendingMarker() {
  return { at: null, files: new Map(), more: 0 };
}

export function addPendingMarker(pending, marker) {
  pending.at = marker.at;
  for (const file of marker.files) {
    if (pending.files.has(file.path) || pending.files.size < PENDING_FILES_MAX) {
      pending.files.set(file.path, { added: file.added, removed: file.removed });
    } else {
      pending.more += 1;
    }
  }
  pending.more += marker.more;
  return pending;
}

// The merged marker, or null when nothing is waiting.
export function pendingToMarker(pending) {
  if (pending.files.size === 0) return null;
  const listed = [...pending.files].slice(0, FILES_MARKER_MAX).map(([filePath, counts]) => ({
    path: filePath,
    added: counts.added,
    removed: counts.removed
  }));
  return { at: pending.at, type: "files", files: listed, more: pending.files.size - listed.length + pending.more };
}

function diffResult(file, text, timedOut) {
  const bytes = Buffer.from(typeof text === "string" ? text : "", "utf8");
  const over = bytes.length > DIFF_MAX_BYTES;
  let diff = bytes.toString("utf8");
  if (over || timedOut) {
    // Cut on a line end, so the last line shown is whole.
    const head = over ? bytes.subarray(0, DIFF_MAX_BYTES) : bytes;
    const end = head.lastIndexOf(0x0a);
    diff = head.subarray(0, end >= 0 ? end + 1 : head.length).toString("utf8");
  }
  return { path: file, diff, binary: BINARY_DIFF.test(diff), cut: over || timedOut };
}

async function untrackedDiff(top, wanted, env, run, filters) {
  const result = await run(top, [...filters.prefix, "diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", wanted], {
    env,
    okCodes: [0, 1],
    maxChars: DIFF_MAX_BYTES + 1,
    config: filters.config
  });
  // Exit 1 with nothing printed: git could not read the file (it is gone).
  return result.ok && result.stdout === "" ? { ...result, ok: false } : result;
}

// `file` is a ChangedFile from the session's current changes; its path is
// checked again here before git runs.
export async function readDiff(folder, file, { env, run = runGit } = {}) {
  const wanted = typeof file?.path === "string" ? file.path : "";
  const oldPath = typeof file?.oldPath === "string" ? file.oldPath : null;
  if (!safeRepoPath(wanted) || (oldPath !== null && !safeRepoPath(oldPath))) throw changeMissing();
  const top = await gitTopLevel(folder, { env, run });
  if (!top || !insideTop(top, wanted) || (oldPath !== null && !insideTop(top, oldPath))) throw changeMissing();
  // Filters are switched off for a diff as for a read (S1). If they cannot be
  // listed, nothing is diffed.
  let filters;
  try {
    filters = await filterSettings(top, env, run);
  } catch {
    throw changeMissing();
  }
  let result;
  if (file.status === "untracked") {
    result = await untrackedDiff(top, wanted, env, run, filters);
  } else {
    const paths = file.status === "renamed" && oldPath !== null ? [oldPath, wanted] : [wanted];
    // --literal-pathspecs: a name such as "st*r.txt" is that file, never a pattern.
    result = await run(top, [...filters.prefix, "--literal-pathspecs", "diff", ...DIFF_FLAGS, "-M", "HEAD", "--", ...paths], {
      env,
      maxChars: DIFF_MAX_BYTES + 1,
      config: filters.config
    });
    // A repository with no commit yet has no HEAD: a staged new file is shown whole.
    if (!result.ok && !result.timedOut && file.status === "added") {
      result = await untrackedDiff(top, wanted, env, run, filters);
    }
  }
  if (!result.ok && !result.timedOut) throw changeMissing();
  return diffResult(wanted, result.stdout, result.timedOut);
}
