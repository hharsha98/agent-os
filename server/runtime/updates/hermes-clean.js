// The Hermes clean check (SP5, spec "Hermes", rulings R35 and R36). Agent OS
// offers to update Hermes only when its git checkout is an unchanged official
// copy: on an official release or main, with no commit of its own, no changed
// file, and the default update channel. The check is read-only. It never runs
// `git fetch` (or pull, ls-remote, remote update), it compares with the refs
// as they are on disk, and every git call goes through SP4's runGit (hooks
// off, no optional locks, no network transport, the person's GIT_* variables
// dropped), so nothing in the checkout is written.
//
// Every finding is collected, not only the first, as a reason code (the order
// below is the order of the sentences a person reads, see the spec):
//   no_checkout             the folder, or a git project in it, can't be found or read
//   no_official_remote      no remote fetches from the official repository
//   refs_unreadable         the official remote has no refs on disk (the commit count is skipped)
//   not_on_release_or_main  HEAD is not on an official release or main
//   local_commits           a commit that the official remote's refs don't contain
//   dirty_tree              a changed or untracked file, or a submodule (never opened)
//   custom_channel          Hermes follows a different update channel
// A git call that fails (or is cut by the time limit) is never "clean": it
// reports the reason of what it was asked.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAdapter } from "../agents/index.js";
import { resolveHermesHome } from "../agents/hermes.js";
import { runCommand } from "../safety.js";
import { expandHome } from "../store.js";
import { filterSettings } from "../sessions/changes.js";
import { gitTopLevel, runGit } from "../sessions/git.js";

/**
 * @typedef {"no_checkout"|"no_official_remote"|"refs_unreadable"|"not_on_release_or_main"|"local_commits"|"dirty_tree"|"custom_channel"} HermesReason
 * @typedef {Object} HermesCleanResult
 * @property {boolean} clean - true only when there is no reason at all
 * @property {string|null} checkout - Hermes's git checkout, null when it can't be found or read
 * @property {HermesReason[]} reasons - one entry per finding, in the order of the sentences
 */

// Hermes keeps its git checkout in this folder of its home.
const CHECKOUT_FOLDER = "hermes-agent";
// Where Hermes records a non-default update channel (R36).
const CHANNEL_KEY = "update.installs";
// The release tags (R35): `v` and a digit, as in v0.22.5.
const RELEASE_TAGS = "v[0-9]*";
// A cold `git status` of a big checkout can take longer than runGit's usual 5 s,
// and a call that is cut means "not clean", so the limit is generous.
const GIT_LIMIT_MS = 20 * 1000;
const CONFIG_LIMIT_MS = 10 * 1000;
// The most text the list of the index's files may be. A longer list can't be
// read to the end, so the tree counts as changed.
const INDEX_LIST_CHARS = 8 * 1024 * 1024;

// The official repository (the source URL in setup/recipes.js is the reference),
// in the three forms git accepts for GitHub, letter case ignored, with an
// optional `.git` and an optional trailing slash. An https URL may carry
// credentials (`https://user:token@github.com/...`); they are not part of the
// comparison. The host must be exactly github.com after them, so
// `https://github.com@evil.example/...` is not official. The credentials may
// hold only the characters a URL allows there (letters, digits, `-._~`, `%`
// escapes and `!$&'()*+,;=:`): a `#`, `?`, `/` or `\` ends the host early
// (`https://evil.example#@github.com/...` is evil.example), so it never counts
// as part of a user name. ssh needs the user `git`, the only one GitHub accepts.
const OFFICIAL_URL =
  /^(?:https:\/\/(?:[A-Za-z0-9._~%!$&'()*+,;=:-]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)nousresearch\/hermes-agent(?:\.git)?\/?$/i;

export function isOfficialHermesUrl(url) {
  return typeof url === "string" && OFFICIAL_URL.test(url);
}

// The non-empty lines of some output, trimmed.
const textLines = (text) =>
  String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

// --- reading the checkout --------------------------------------------------------------------------------

// The checkout is <hermes home>/hermes-agent: the home the caller names, else
// the one chats and safety reads use (HERMES_HOME from the server's own
// environment, else the stored connection value), else ~/.hermes. It must hold
// a `.git` (a folder, or the file of a linked copy). Null when it does not.
async function findCheckout(home) {
  try {
    const hermesHome = home ? expandHome(home) : await resolveHermesHome();
    const checkout = path.join(hermesHome || path.join(os.homedir(), ".hermes"), CHECKOUT_FOLDER);
    await fs.stat(path.join(checkout, ".git"));
    return { checkout, hermesHome: hermesHome || null };
  } catch {
    return null;
  }
}

async function sameFolder(a, b) {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b));
  } catch {
    return false;
  }
}

// The names of the remotes whose fetch URL is the official repository, or null
// when the remotes can't be listed. `git remote get-url` gives the URL git
// would really fetch from (after any `url.<base>.insteadOf` rewriting), as
// bare text: `git remote -v` adds notes to that line on a partial clone
// ("(fetch) [blob:none]"), which is how Hermes is normally installed. A remote
// whose URL can't be read is not official.
async function officialRemotes(git) {
  const listed = await git(["remote"]);
  if (!listed.ok) return null;
  const names = [...new Set(textLines(listed.stdout))];
  const urls = await Promise.all(names.map((name) => git(["remote", "get-url", "--", name])));
  return names.filter((_, index) => urls[index].ok && isOfficialHermesUrl(urls[index].stdout.trim()));
}

// --- the channel (R36) -----------------------------------------------------------------------------------

const isUnsetSentence = (line) => /^config key not set/i.test(line);
const isEmptyValue = (line) => line === "{}" || line.toLowerCase() === "null";

// Is the channel the default? Yes when `hermes config get update.installs` read
// cleanly and printed nothing, `{}`, `null` or the "Config key not set..."
// sentence. A missing key may also make Hermes exit with an error: with that
// sentence on either stream it is still "not set". Anything else (a value, a
// notice, a failed read, no answer) is not the default: fails closed.
function channelIsDefault(result) {
  if (!result || typeof result !== "object") return false;
  const out = textLines(result.stdout);
  if (!result.ok) return [...out, ...textLines(result.stderr)].some(isUnsetSentence);
  return out.every((line) => isUnsetSentence(line) || isEmptyValue(line));
}

// The default way to read a Hermes setting: the detected `hermes config get
// <key>`, asked of the same Hermes profile the checkout belongs to (HERMES_HOME
// set like the safety reads do, and left alone when there is none). Resolves
// runCommand's { ok, stdout, stderr, ... }; ok: false when Hermes is not found.
async function readHermesConfig(key, hermesHome) {
  const detected = await getAdapter("hermes").detect();
  if (!detected?.installed || !detected.path) return { ok: false, stdout: "", stderr: "" };
  const env = hermesHome ? { ...process.env, HERMES_HOME: hermesHome } : process.env;
  return runCommand(detected.path, ["config", "get", key], CONFIG_LIMIT_MS, { env });
}

// --- the check -------------------------------------------------------------------------------------------

// Is the work tree unchanged? `git status` can run programs the repository
// configures: a filter driver (clean/smudge) runs on every file whose
// timestamp changed, and a submodule is opened with its own configuration, so
// SP4's rule holds here too (git reads never run repository-configured
// programs). As the changes panel does (S1), every configured filter is
// switched off for the call, and a submodule is never opened: a work tree that
// has one (a gitlink, mode 160000, in the index) is not clean, and status is
// told to ignore submodules altogether. Any trouble reading counts as changed.
async function treeIsClean(checkout, { env, run }) {
  try {
    const staged = await run(checkout, ["ls-files", "--stage", "-z"], {
      env,
      timeoutMs: GIT_LIMIT_MS,
      maxChars: INDEX_LIST_CHARS
    });
    if (!staged.ok || staged.stdout.length >= INDEX_LIST_CHARS) return false;
    if (staged.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) return false;
    const filters = await filterSettings(checkout, env, run);
    // Changed and untracked files count; files git ignores (a venv, caches) do not.
    const status = await run(checkout, [...filters.prefix, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=all"], {
      env,
      timeoutMs: GIT_LIMIT_MS,
      config: filters.config
    });
    return status.ok && status.stdout.trim() === "";
  } catch {
    return false;
  }
}

// HEAD is on the official release or main (R35) when it is the local branch
// `main`, or detached exactly at a `v*` tag, or the same commit as an official
// remote's main. `mainTips` holds the commits of `refs/remotes/<official>/main`.
async function headIsOnReleaseOrMain(git, mainTips) {
  const branch = await git(["symbolic-ref", "-q", "HEAD"], [0, 1]);
  if (!branch.ok) return false;
  if (branch.code === 0) {
    if (branch.stdout.trim() === "refs/heads/main") return true;
  } else {
    // Exit 1: HEAD is detached, not on a branch.
    const tags = await git(["tag", "--list", "--points-at", "HEAD", RELEASE_TAGS]);
    if (tags.ok && tags.stdout.trim() !== "") return true;
  }
  if (mainTips.size === 0) return false;
  const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  return head.ok && mainTips.has(head.stdout.trim());
}

/**
 * Is Hermes's git checkout an unchanged official copy? Read-only.
 *   home       Hermes's home folder (the checkout is <home>/hermes-agent); by default
 *              the one chats use, else ~/.hermes
 *   configGet  (key) -> { ok, stdout, stderr }, how a Hermes setting is read; by default
 *              the detected `hermes config get <key>` (tests inject their own)
 *   run, env   runGit and the environment of its git calls (injectable for tests);
 *              runGit drops the person's GIT_* variables and Agent OS's own
 * Never throws.
 * @returns {Promise<HermesCleanResult>}
 */
export async function hermesCleanCheck({ home, configGet, run = runGit, env = process.env } = {}) {
  const noCheckout = { clean: false, checkout: null, reasons: ["no_checkout"] };
  const found = await findCheckout(home);
  if (!found) return noCheckout;
  const { checkout, hermesHome } = found;
  const git = (args, okCodes) => run(checkout, args, { env, okCodes, timeoutMs: GIT_LIMIT_MS });

  // `git -C` goes up to a parent folder when the .git here is not a real git
  // directory, so the project git answers for must be this very folder.
  const top = await gitTopLevel(checkout, { env, run });
  if (!top || !(await sameFolder(top, checkout))) return noCheckout;
  const official = await officialRemotes(git);
  if (!official) return noCheckout;

  const reasons = [];
  if (official.length === 0) reasons.push("no_official_remote");

  // The official remote's refs: its remote-tracking branches plus the release tags.
  let refsReadable = false;
  const mainTips = new Set();
  if (official.length > 0) {
    const listed = await git([
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      ...official.map((name) => `refs/remotes/${name}`),
      `refs/tags/${RELEASE_TAGS}`
    ]);
    const refs = listed.ok ? textLines(listed.stdout) : [];
    refsReadable = refs.length > 0;
    if (!refsReadable) reasons.push("refs_unreadable");
    for (const line of refs) {
      const [id, name] = line.split(" ");
      if (official.some((remote) => name === `refs/remotes/${remote}/main`)) mainTips.add(id);
    }
  }

  if (!(await headIsOnReleaseOrMain(git, mainTips))) reasons.push("not_on_release_or_main");

  // No commit outside the official remote's refs and the release tags (R35).
  // Without refs to compare with there is nothing to count.
  if (official.length > 0 && refsReadable) {
    const counted = await git([
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      ...official.map((name) => `--remotes=${name}`),
      `--tags=${RELEASE_TAGS}`
    ]);
    if (!counted.ok || Number.parseInt(counted.stdout.trim(), 10) !== 0) reasons.push("local_commits");
  }

  if (!(await treeIsClean(checkout, { env, run }))) reasons.push("dirty_tree");

  const read = configGet ?? ((key) => readHermesConfig(key, hermesHome));
  let channel = null;
  try {
    channel = await read(CHANNEL_KEY);
  } catch {
    // an unreadable channel is not the default
  }
  if (!channelIsDefault(channel)) reasons.push("custom_channel");

  return { clean: reasons.length === 0, checkout, reasons };
}
