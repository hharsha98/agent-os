// Separate copies of a person's git project (spec SP4, "Worktree offer"; ruling R25; contract choice K14). When a
// live session already uses a folder, the New session dialog offers a second checkout of the project on a new
// branch, made with `git worktree add <AGENT_OS_HOME>/worktrees/<session id> -b agentos/<agent>-<n> HEAD` (the
// folder policy, D12, allows that folder). <n> is the smallest number no local branch agentos/<agent>-<n> uses yet.
//
// Every git call goes through runGit (git.js): argv only, never a shell, with a time limit and an environment
// without Agent OS's own variables (gitEnv).
//
// Nothing the project configured runs here (ruling "K12a applied to worktrees"). `git worktree add` checks files out,
// so left alone it would run the project's smudge filters and its post-checkout hook, and a remove compares files
// through the clean filters. So every add and remove:
// - switches EVERY configured filter driver off, git-lfs's included (changes.js filterSettings with { all: true }), so a
//   large-file pointer stays a pointer and nothing downloads, and sets GIT_LFS_SKIP_SMUDGE=1 besides;
// - points core.hooksPath at an empty folder Agent OS owns (<AGENT_OS_HOME>/empty-hooks, 0700), never the project's
//   hooks; the clean-up of a failed start does the same (its git branch -d would run the reference-transaction hook);
// - never uses --force, except discardFreshWorktree's, for a copy that this same start made moments ago.
// If the filter drivers can't be listed, nothing is made.
//
// Nothing the person made is ever deleted here:
// - removeWorktree removes a copy only when `git status --porcelain` in it prints nothing, and asks git without
//   --force, so git checks again itself. The copy's branch always stays in the project.
// - The one --force is discardFreshWorktree's, for a copy this same start made moments ago and could not use (a
//   refused folder, a failed spawn), together with the branch made for it, deleted with -d (git refuses -d for a
//   branch whose commits nothing else holds).
import { realpath as realpathCallback, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ensurePrivateDir, runtimePaths } from "../store.js";
import { filterSettings } from "./changes.js";
import { isSessionId, sessionError } from "./errors.js";
import { gitEnv, gitTopLevel, runGit } from "./git.js";
import { OPENCLAW_FOLDER_HONOURED, SESSION_AGENTS } from "./profiles.js";
import { cleanAlertText } from "./signals.js";

// The letter case stored on disk (macOS, Windows), as folders.js compares folders.
const realpathNative = promisify(realpathCallback.native);

export const BRANCH_PREFIX = "agentos/";
// A big project takes a while to check out, and removing a copy deletes every file in it.
export const WORKTREE_ADD_LIMIT_MS = 120 * 1000;
export const WORKTREE_REMOVE_LIMIT_MS = 60 * 1000;
// At most this much of git's own words goes into a refusal.
export const GIT_SAID_MAX = 300;
// The empty folder core.hooksPath points at, inside AGENT_OS_HOME.
const EMPTY_HOOKS_FOLDER = "empty-hooks";

const NOT_GIT_MESSAGE = "This folder isn't a git project, so Agent OS can't make a separate copy.";
const DIRTY_MESSAGE = "The separate copy has changes that aren't committed. Commit or discard them, then try again.";
const FAILED = {
  add: { code: "worktree_failed", start: "Agent OS couldn't make the separate copy", late: "git took longer than 2 minutes" },
  remove: { code: "worktree_remove_failed", start: "Agent OS couldn't remove the separate copy", late: "git took longer than a minute" }
};

function foldCase(value) {
  return process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;
}

async function isFolder(dir) {
  if (typeof dir !== "string" || dir === "") return false;
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// "gone" (nothing there), "folder" (a real folder, not a link) or "other" (a link, a file, or anything git must not be
// pointed at). A link at a copy's place would make git act on whatever it points to.
async function kindOf(dir) {
  try {
    const info = await fs.lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink() ? "folder" : "other";
  } catch (error) {
    return error?.code === "ENOENT" ? "gone" : "other";
  }
}

async function realFolder(dir) {
  try {
    return await realpathNative(dir);
  } catch {
    return path.resolve(dir);
  }
}

// git's own words for a refusal: its first "fatal:" or "error:" line, else its last line (control characters
// removed, at most GIT_SAID_MAX characters).
function gitFailure(kind, result) {
  const words = FAILED[kind];
  const lines = String(result?.stderr || result?.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const said = cleanAlertText(lines.find((line) => /^(?:fatal|error):/i.test(line)) || lines.at(-1) || "", GIT_SAID_MAX);
  if (result?.timedOut) return sessionError(409, words.code, `${words.start}: ${words.late}.`);
  if (said) return sessionError(409, words.code, `${words.start}. Git said: ${said}`);
  return sessionError(409, words.code, `${words.start}, and git gave no reason.`);
}

// The empty folder core.hooksPath points at. Checked before every use: a real folder (not a link), owned by the
// server's own user, 0700 and empty. Anything else is removed and made again, so a hook put there (or a link to
// someone's hooks) never runs.
async function hooksFolderIsClean(dir) {
  try {
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
      if ((info.mode & 0o777) !== 0o700) return false;
    }
    return (await fs.readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

async function emptyHooksFolder() {
  const dir = path.join(runtimePaths().root, EMPTY_HOOKS_FOLDER);
  if (await hooksFolderIsClean(dir)) return dir;
  await fs.rm(dir, { recursive: true, force: true });
  await ensurePrivateDir(dir);
  if (!(await hooksFolderIsClean(dir))) throw new Error("The empty hooks folder can't be made.");
  return dir;
}

// What keeps the project's own programs from running during a call (see the header): { env, prefix, config }.
// `env` is the git environment plus GIT_LFS_SKIP_SMUDGE=1; `prefix` goes in front of the git command (hooks off, and
// the filters off too on a git older than 2.31); `config` is for runGit's `config` option (filters off through the
// environment). `filters: false` is for calls that check nothing out and compare nothing (the clean-up of a failed
// start, which uses --force and so makes git skip its own status), so only the hooks are switched off.
// Throws the worktree sessionError of `kind` when the empty folder can't be made or the filters can't be listed.
async function safeGit(folder, env, run, { kind, filters = true }) {
  const base = gitEnv({ ...(env ?? {}), GIT_LFS_SKIP_SMUDGE: "1" });
  let hooks;
  try {
    hooks = await emptyHooksFolder();
  } catch {
    throw gitFailure(kind, null);
  }
  const prefix = ["-c", `core.hooksPath=${hooks}`];
  if (!filters) return { env: base, prefix, config: [] };
  let off;
  try {
    off = await filterSettings(folder, base, run, { all: true });
  } catch {
    throw gitFailure(kind, null);
  }
  return { env: base, prefix: [...prefix, ...off.prefix], config: off.config };
}

function guarded(safe, run, folder, args, options = {}) {
  return run(folder, [...safe.prefix, ...args], { env: safe.env, config: safe.config, ...options });
}

// OpenClaw picks its own folder until spike S5 shows that it honours one (S5 was inconclusive), so it never gets a
// separate copy; every other session agent can.
export function copyAllowed(agentId) {
  return SESSION_AGENTS.includes(agentId) && (agentId !== "openclaw" || OPENCLAW_FOLDER_HONOURED);
}

// One branch scheme everywhere (spec): agentos/<agent>-<n>, <agent> being the session agent's id. A wrong agent or
// number is a caller's bug.
export function branchName(agentId, n) {
  if (!SESSION_AGENTS.includes(agentId)) throw new TypeError(`branchName needs one of: ${SESSION_AGENTS.join(", ")}`);
  if (!Number.isInteger(n) || n < 1) throw new TypeError("branchName needs a whole number of 1 or more");
  return `${BRANCH_PREFIX}${agentId}-${n}`;
}

// Where the copy made for a session lives.
export function worktreePath(sessionId) {
  return path.join(runtimePaths().worktrees, sessionId);
}

// The smallest agentos/<agent>-<n> no local branch uses yet, or null when git can't list the branches (the folder
// isn't inside a git work tree). Only plain numbers count: agentos/claude-01 is another name than agentos/claude-1.
export async function nextBranch(folder, agentId, { env, run = runGit } = {}) {
  branchName(agentId, 1);
  const listed = await run(folder, ["for-each-ref", "--format=%(refname)", `refs/heads/${BRANCH_PREFIX}`], { env: gitEnv(env ?? {}) });
  if (!listed?.ok) return null;
  // A ref nested below the name (agentos/codex-1/x) blocks the name too, and where the disk ignores letter case
  // (macOS, Windows) so does agentos/Codex-1: both count the number as taken.
  const pattern = new RegExp(`^refs/heads/${foldCase(BRANCH_PREFIX)}${agentId}-([1-9][0-9]*)(?:/.*)?$`);
  const taken = new Set();
  for (const line of String(listed.stdout || "").split("\n")) {
    const found = pattern.exec(foldCase(line.trim()));
    if (found) taken.add(Number(found[1]));
  }
  let n = 1;
  while (taken.has(n)) n += 1;
  return branchName(agentId, n);
}

// What the New session dialog needs to offer a copy of `folder` for `agentId`: whether it is a git project, and the
// branch a separate copy would get (null when that agent can't use a copy).
export async function copyPlan(folder, agentId, { env, run = runGit } = {}) {
  const top = await gitTopLevel(folder, { env: gitEnv(env ?? {}), run });
  if (!top) return { git: false, branch: null };
  return { git: true, branch: copyAllowed(agentId) ? await nextBranch(folder, agentId, { env, run }) : null };
}

// Makes the copy for `sessionId` from the folder's HEAD on the next free branch. Answers { path, folder, branch,
// copyOf }: `path` is the copy (0700), `folder` the folder the session runs in (the same place inside the copy that
// `folder` has inside the project; made empty when git tracks nothing there), `copyOf` the folder that was copied.
// Throws sessionErrors 409 not_git and 409 worktree_failed; a cut-off or refused add leaves nothing behind.
//
// Two steps (safety review C1): `git worktree add --no-checkout` makes the copy and its branch and checks nothing out, so no
// filter can run; then the filter drivers are listed INSIDE the new copy (an includeIf "onbranch:agentos/**" or "gitdir:"
// section only applies there, never in the project) and switched off, and `reset --hard` fills the copy with files, the
// same reset `git worktree add` runs by itself. Both steps together get WORKTREE_ADD_LIMIT_MS. Every failure after the
// first step goes through discardFreshWorktree, with the branch.
export async function createWorktree({ folder, agentId, sessionId, env, run = runGit }) {
  if (!isSessionId(sessionId)) throw new TypeError("createWorktree needs a session id");
  const options = { env: gitEnv(env ?? {}) };
  const top = await gitTopLevel(folder, { ...options, run });
  if (!top) throw sessionError(409, "not_git", NOT_GIT_MESSAGE);
  const branch = await nextBranch(folder, agentId, { env, run });
  if (!branch) throw gitFailure("add", null);
  await ensurePrivateDir(runtimePaths().worktrees);
  const dir = worktreePath(sessionId);
  // Nothing may be at the copy's place yet (not a folder, not a link): it is only ever made fresh, and only a folder
  // this start made is ever removed again.
  if ((await kindOf(dir)) !== "gone") throw gitFailure("add", null);
  const startedAt = Date.now();
  const timeLeft = () => Math.max(1000, WORKTREE_ADD_LIMIT_MS - (Date.now() - startedAt));
  // The commit HEAD is on now, to know afterwards whether a branch of that name is the one this start made.
  const headNow = await run(folder, ["rev-parse", "HEAD"], options);
  const headCommit = headNow?.ok ? String(headNow.stdout || "").trim() : "";
  const hooksOnly = await safeGit(folder, env, run, { kind: "add", filters: false });
  // The place is looked at again right before the add (M12): the git calls above take a moment, and a link or a folder put
  // there meanwhile (git accepts an empty folder reached through a link, and the reset would then fill what it points to)
  // must not be handed to git. What can still slip in between this look and git's own is not this start's to remove.
  if ((await kindOf(dir)) !== "gone") throw gitFailure("add", null);
  // HEAD as the start point: the copy branches from the commit the folder is on now (K14).
  const added = await guarded(hooksOnly, run, folder, ["worktree", "add", "--no-checkout", dir, "-b", branch, "HEAD"], {
    timeoutMs: timeLeft()
  });
  if (!added?.ok) {
    // git makes the branch before it looks at the folder, so a refused add can leave its branch behind (I1). It is
    // deleted (-d) only when it is certain that this start made it, and the same rule holds when Agent OS cut the add
    // off (M11): the branch now exists on the very commit HEAD was on, and git did not say that a branch of that name
    // already existed. (A cut-off add that made its branch made it at HEAD, so it still goes.)
    const said = String(added?.stderr || "");
    const folderExisted = /fatal: '[^']*' already exists/i.test(said);
    const branchExisted = /a branch named '[^']*' already exists/i.test(said);
    let ours = false;
    if (headCommit && !branchExisted) {
      const there = await run(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], options);
      ours = Boolean(there?.ok) && String(there.stdout || "").trim() === headCommit;
    }
    await discardFreshWorktree({ path: dir, copyOf: folder, branch: ours ? branch : null, env, run, folderMade: !folderExisted });
    throw gitFailure("add", added);
  }
  try {
    if (process.platform !== "win32") await fs.chmod(dir, 0o700);
    const inCopy = await safeGit(dir, env, run, { kind: "add" });
    // core.ignoreStat=false: with it true (from any config level) the reset would mark every file "assume unchanged",
    // and git would then not see the agent's edits (I2).
    const filling = { ...inCopy, prefix: [...inCopy.prefix, "-c", "core.ignoreStat=false"] };
    const filled = await guarded(filling, run, dir, ["reset", "--hard", "--quiet", "--no-recurse-submodules"], { timeoutMs: timeLeft() });
    if (!filled?.ok) throw gitFailure("add", filled);
    const [topReal, folderReal] = await Promise.all([realFolder(top), realFolder(folder)]);
    const inside = path.relative(topReal, folderReal);
    const sub = inside && inside !== ".." && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside) ? inside : "";
    const sessionFolder = sub ? path.join(dir, sub) : dir;
    if (sub) await fs.mkdir(sessionFolder, { recursive: true });
    return { path: dir, folder: sessionFolder, branch, copyOf: folder };
  } catch (error) {
    await discardFreshWorktree({ path: dir, copyOf: folder, branch, env, run });
    throw error;
  }
}

// The real path of `p` even when it (or its last parts) no longer exists: the real path of the longest part that does,
// with the rest added back. Two such paths compare equal only when they name the same place.
async function realWithin(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(await realpathNative(head), ...rest.reverse());
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(p);
      rest.push(path.basename(head));
      head = up;
    }
  }
}

// Drops git's record of Agent OS's own copy (`<project's .git>/worktrees/<name>`) when the copy's folder is gone and
// git did not drop it itself. Never `git worktree prune` (M14): that deletes the record of EVERY worktree of the
// project whose folder is missing at that moment, the person's own included (a drive that is unplugged), together with
// its index and its refs. The record is found by reading each record's `gitdir` file, which must name exactly this
// copy's `.git` (real paths compared); the record and its file must be real (no links), and a locked record stays.
// Nothing else is touched. Never throws.
async function forgetOwnEntry({ from, dir, safe, run }) {
  try {
    const { entry } = await ownEntry({ from, dir, safe, run });
    if (entry) await fs.rm(entry, { recursive: true, force: true });
  } catch {
    // nothing is dropped that could not be checked
  }
}

// Looks for git's record of Agent OS's own copy `dir` (`<project's .git>/worktrees/<name>`), found as described above.
// Answers { entry, complete }: `entry` is the record's path, or null when there is none or it is locked; `complete` is false
// when anything could not be read on the way (git could not name its folder, the records folder or one record's `gitdir`
// file could not be read, a link where a record or its file should be), because a record that could not be looked at might
// be the copy's. Whoever is about to let the record go must refuse on `complete: false` (M16). A plain file in the records
// folder (a .DS_Store) is not a record and does not count. Never throws.
async function ownEntry({ from, dir, safe, run }) {
  let entry = null;
  let complete = true;
  try {
    const answer = await guarded(safe, run, from, ["rev-parse", "--git-common-dir"]);
    if (!answer?.ok) return { entry: null, complete: false };
    const parent = path.join(path.resolve(from, String(answer.stdout || "").trim()), "worktrees");
    const parentKind = await kindOf(parent);
    if (parentKind === "gone") return { entry: null, complete: true };
    if (parentKind !== "folder") return { entry: null, complete: false };
    const mine = foldCase(await realWithin(path.join(dir, ".git")));
    for (const name of await fs.readdir(parent)) {
      const candidate = path.join(parent, name);
      let info;
      try {
        info = await fs.lstat(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") complete = false;
        continue;
      }
      if (info.isFile()) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) {
        complete = false;
        continue;
      }
      const file = path.join(candidate, "gitdir");
      let named;
      try {
        const fileInfo = await fs.lstat(file);
        if (!fileInfo.isFile()) {
          complete = false;
          continue;
        }
        named = (await fs.readFile(file, "utf8")).trim();
      } catch (error) {
        // A record without a gitdir file is not a record git can use; any other failure is a record that was not looked at.
        if (error?.code !== "ENOENT") complete = false;
        continue;
      }
      if (!named || foldCase(await realWithin(path.resolve(candidate, named))) !== mine) continue;
      if ((await kindOf(path.join(candidate, "locked"))) !== "gone") continue;
      if (entry === null) entry = candidate;
    }
  } catch {
    return { entry: null, complete: false };
  }
  return { entry, complete };
}

// Removes a copy this same start made moments ago and could not use, and the branch made for it. Never throws: a
// start that failed must report its own reason. Hooks stay off (git branch -d runs the reference-transaction hook);
// no filter can run, because nothing is checked out and --force makes git skip its own status. `folderMade: false`
// (git said the folder was there before this start) leaves the folder and git's record of it alone: only the branch is
// looked at.
export async function discardFreshWorktree({ path: dir, copyOf, branch = null, env, run = runGit, folderMade = true }) {
  try {
    let safe = null;
    try {
      safe = await safeGit(copyOf, env, run, { kind: "remove", filters: false });
    } catch {
      // Without the empty hooks folder git is not called at all; the folder below is still removed.
    }
    if (folderMade) {
      if (safe) await guarded(safe, run, copyOf, ["worktree", "remove", "--force", dir], { timeoutMs: WORKTREE_REMOVE_LIMIT_MS });
      // Only ever a folder Agent OS made: <AGENT_OS_HOME>/worktrees/<session id>.
      if (path.dirname(dir) === runtimePaths().worktrees && isSessionId(path.basename(dir))) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      if (safe) await forgetOwnEntry({ from: copyOf, dir, safe, run });
    }
    if (safe && branch) await guarded(safe, run, copyOf, ["branch", "-d", branch]);
  } catch {
    // never throws
  }
}

// More than this many characters of `git ls-files -v` and the list may be cut: the check can't be trusted, so it refuses.
const LS_FILES_MAX_CHARS = 16 * 1024 * 1024;

// `git ls-files -v -z` prints "<tag> <path>" records. A lowercase tag means assume-unchanged (and S, skip-worktree, with
// the file on disk, means git is told to ignore the file there): either hides an edit from every check.
async function hidesEdits(dir, listing) {
  for (const record of listing.split("\0")) {
    if (record.length < 3) continue;
    const tag = record[0];
    if (tag !== tag.toUpperCase()) return true;
    if (tag === "S" && (await kindOf(path.join(dir, record.slice(2)))) !== "gone") return true;
  }
  return false;
}

// Refuses (409 worktree_dirty) when a commit is reachable from a copy's own HEAD, refs/worktree/*, refs/bisect/* or
// refs/rewritten/* and from no branch and no tag (I3). Read only. `gitDir` is git's record of a copy whose folder is gone
// (M16): the check then runs against the record, from the project. Two things that have nothing to do with lost work must
// not make a copy impossible to remove (M15): a file named HEAD in the copy (the trailing `--` tells git that every word
// before it is a revision), and a HEAD that names no commit yet (`git checkout --orphan`), where only the other refs can
// hold one. Any other failure of git still refuses.
async function refuseLostCommits({ strict, run, folder, gitDir = null }) {
  const place = gitDir ? [`--git-dir=${gitDir}`] : [];
  const head = await guarded(strict, run, folder, [...place, "rev-parse", "--verify", "--quiet", "HEAD"], { okCodes: [0, 1] });
  if (!head?.ok) throw gitFailure("remove", head);
  const lost = await guarded(strict, run, folder, [
    ...place,
    "rev-list",
    "-n",
    "1",
    ...(head.code === 0 ? ["HEAD"] : []),
    "--glob=refs/worktree/*",
    "--glob=refs/bisect/*",
    "--glob=refs/rewritten/*",
    "--not",
    "--branches",
    "--tags",
    "--"
  ]);
  if (!lost?.ok) throw gitFailure("remove", lost);
  if (String(lost.stdout || "").trim() !== "") throw sessionError(409, "worktree_dirty", DIRTY_MESSAGE);
}

// Removes a session's copy (Remove separate copy). Refuses (409 worktree_dirty) while `git status --porcelain` in
// the copy prints anything: a change that isn't committed, or a new file git doesn't ignore. git runs from the
// project while it is still there, else from the copy itself. A copy whose folder was already deleted is only
// forgotten (by git, else by dropping Agent OS's own record, never by pruning the project's other worktrees); when the
// project is gone too, nothing is left to remove. The branch always stays (K14). Files git
// ignores in the copy (installed packages, build output) go with it, which the confirm says.
export async function removeWorktree({ path: dir, copyOf, env, run = runGit }) {
  // A link or a file at the copy's place is never handed to git (git would act on what the link points to), and the
  // folder must be the real one inside <AGENT_OS_HOME>/worktrees (M2).
  const kind = await kindOf(dir);
  if (kind === "other") throw gitFailure("remove", null);
  const copyThere = kind === "folder";
  if (copyThere) {
    const expected = path.join(await realFolder(runtimePaths().worktrees), path.basename(dir));
    if (foldCase(await realFolder(dir)) !== foldCase(expected)) throw gitFailure("remove", null);
  }
  const from = (await isFolder(copyOf)) ? copyOf : copyThere ? dir : null;
  if (!from) return;
  // The status looks at the copy's files (clean filters), and git's own check inside `worktree remove` does too.
  const safe = await safeGit(copyThere ? dir : from, env, run, { kind: "remove" });
  // Every look at the copy's files gets the same two settings, so no config level can hide an edit: new files always
  // show (C2), and git never trusts a file's stat data blindly (I2). git's own check inside `worktree remove` (never
  // --force) runs with them too, as a second look.
  const strict = { ...safe, prefix: [...safe.prefix, "-c", "status.showUntrackedFiles=normal", "-c", "core.ignoreStat=false"] };
  if (copyThere) {
    // --untracked-files=normal beats status.showUntrackedFiles from any config level (C2): with "no" a new file the
    // agent made would not show, and the copy would be removed with it. --ignore-submodules=dirty keeps git from going
    // into a folder the agent made into a repository of its own, where that repository's own filter would run (C3); a
    // submodule whose commit moved still shows, and git's own check refuses every copy that holds a populated one.
    const status = await guarded(strict, run, dir, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"]);
    if (!status?.ok) throw gitFailure("remove", status);
    if (String(status.stdout || "").trim() !== "") throw sessionError(409, "worktree_dirty", DIRTY_MESSAGE);
    // A file marked assume-unchanged or skip-worktree is not looked at by status or by git's own check, so an edit to it
    // would go with the copy (I2): any such entry (a lowercase tag, or S for a file that is there) refuses the removal.
    const listed = await guarded(strict, run, dir, ["ls-files", "-v", "-z"], { maxChars: LS_FILES_MAX_CHARS });
    if (!listed?.ok || String(listed.stdout || "").length >= LS_FILES_MAX_CHARS) throw gitFailure("remove", listed);
    if (await hidesEdits(dir, String(listed.stdout || ""))) throw sessionError(409, "worktree_dirty", DIRTY_MESSAGE);
    // `git worktree remove` deletes the copy's own git data: its HEAD and its reflog, refs/worktree/*, refs/bisect/* and
    // any rebase state. A commit that only they hold (a detached HEAD, an amend inside a stopped rebase, a ref kept in
    // refs/worktree) would be lost for good, so a commit that is reachable from them and from no branch and no tag
    // refuses the removal (I3). Read only; the agent's work on a branch of the project is safe on that branch.
    await refuseLostCommits({ strict, run, folder: dir });
  } else {
    // The folder is already gone (deleted by hand), but git's record of the copy, with the copy's own HEAD and refs, is
    // about to go: git drops it itself, or Agent OS does. The same check runs against that record, so a commit that only
    // the record holds is not lost with it (M16).
    // If git's records can't all be read, the copy's own might be among those not looked at, and git drops it without a
    // check: refuse and keep everything (M16, fix round 1), with the same plain refusal as any other git failure.
    const { entry: record, complete } = await ownEntry({ from, dir, safe, run });
    if (!complete) throw gitFailure("remove", null);
    if (record) await refuseLostCommits({ strict, run, folder: from, gitDir: record });
  }
  const removed = await guarded(strict, run, from, ["worktree", "remove", dir], { timeoutMs: WORKTREE_REMOVE_LIMIT_MS });
  if (removed?.ok) return;
  if ((await kindOf(dir)) === "gone") {
    // git did not drop its record of a folder that is gone: drop Agent OS's own record, and only that (M14).
    await forgetOwnEntry({ from, dir, safe, run });
    return;
  }
  throw gitFailure("remove", removed);
}

// The session whose copy holds `folder` (a real path), or null when the folder isn't inside
// <AGENT_OS_HOME>/worktrees/<session id>.
export async function worktreeIdOf(folder) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return null;
  const root = await realFolder(runtimePaths().worktrees);
  const inside = path.relative(foldCase(root), foldCase(folder));
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;
  const first = inside.split(path.sep)[0];
  return isSessionId(first) ? first : null;
}
