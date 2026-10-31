// SP5 Task V2: the Hermes clean check (server/runtime/updates/hermes-clean.js; spec "SP5 Agent updates" ->
// "Hermes", rulings R35 and R36). Agent OS may offer to update Hermes only when its git checkout is an unchanged
// official copy, and the check that decides it must be read-only. Every repository here is made by the test with
// plain git inside a temp folder: the "official" remote is a local bare repository whose recorded URL is then
// set to the official one (`remote.<name>.url`), so no network is ever touched. The channel read (`hermes config
// get update.installs`) is injected, except in the last tests, which put a tiny stand-in `hermes` on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { runGit } from "../server/runtime/sessions/git.js";
import { hermesCleanCheck, isOfficialHermesUrl } from "../server/runtime/updates/hermes-clean.js";

const isWindows = process.platform === "win32";
const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const GIT_ONLY = { skip: isWindows ? "POSIX paths and shims" : HAS_GIT ? false : "git is not installed here" };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const OFFICIAL = "https://github.com/NousResearch/hermes-agent";
const FORK = "https://github.com/someone/hermes-agent";

// What `hermes config get update.installs` prints when nothing is recorded, and a recorded channel.
const CHANNEL_UNSET = { ok: true, stdout: "Config key not set: update.installs", stderr: "" };
const CHANNEL_SET = { ok: true, stdout: '{"/home/me/hermes-agent": {"channel": "main"}}', stderr: "" };
const channelUnset = async () => CHANNEL_UNSET;
const channelSet = async () => CHANNEL_SET;

// ---- the isOfficialHermesUrl rows (pure) ----------------------------------------------------------------------

test("isOfficialHermesUrl: https, scp-style and ssh:// forms, any letter case, optional .git and trailing slash", () => {
  const official = [
    "https://github.com/NousResearch/hermes-agent",
    "https://github.com/NousResearch/hermes-agent.git",
    "https://github.com/NousResearch/hermes-agent/",
    "https://github.com/NousResearch/hermes-agent.git/",
    "HTTPS://GITHUB.COM/nousresearch/HERMES-AGENT",
    "git@github.com:NousResearch/hermes-agent",
    "git@github.com:NousResearch/hermes-agent.git",
    "GIT@GitHub.com:nousresearch/Hermes-Agent.GIT",
    "ssh://git@github.com/NousResearch/hermes-agent",
    "ssh://git@github.com/NousResearch/hermes-agent.git",
    "ssh://git@github.com/NousResearch/hermes-agent/"
  ];
  for (const url of official) assert.equal(isOfficialHermesUrl(url), true, url);
});

test("isOfficialHermesUrl: credentials in the URL are dropped before the comparison", () => {
  assert.equal(isOfficialHermesUrl("https://user:tok@github.com/NousResearch/hermes-agent.git"), true);
  assert.equal(isOfficialHermesUrl("https://tok@github.com/NousResearch/hermes-agent"), true);
  assert.equal(isOfficialHermesUrl("https://x-access-token:ghp_abc123@github.com/nousresearch/hermes-agent/"), true);
});

test("isOfficialHermesUrl: the user part of the URL can't end the host early (#, ? and \\ before an @github.com)", () => {
  // The premise: under the URL rules (here Node's URL) the host of each of these is evil.example, not github.com.
  for (const sign of ["#", "?", "\\"]) {
    const url = `https://evil.example${sign}@github.com/NousResearch/hermes-agent`;
    assert.equal(new URL(url).hostname, "evil.example", url);
    assert.equal(isOfficialHermesUrl(url), false, url);
  }
  // Credentials made only of legal characters (including percent-encoded ones) are still dropped.
  assert.equal(new URL("https://a%40b:t%3Ak@github.com/NousResearch/hermes-agent").hostname, "github.com");
  assert.equal(isOfficialHermesUrl("https://a%40b:t%3Ak@github.com/NousResearch/hermes-agent"), true);
  assert.equal(isOfficialHermesUrl("https://me.name_1~x!$&'()*+,;=:pw@github.com/NousResearch/hermes-agent.git"), true);
});

test("isOfficialHermesUrl: nothing else matches (other repositories, other hosts, tricks, other types)", () => {
  const other = [
    "https://github.com/NousResearch/hermes-agent-fork",
    "https://github.com/NousResearch/hermes-agent/issues",
    "https://github.com/NousResearch/hermes-agent.git.bak",
    "https://github.com/NousResearch/hermes",
    "https://github.com/someone/hermes-agent",
    "https://gitlab.com/NousResearch/hermes-agent",
    "https://github.com.evil.example/NousResearch/hermes-agent",
    "https://github.com@evil.example/NousResearch/hermes-agent",
    // characters that end the host early in a URL, ahead of an "@github.com" (finding 2 of the review)
    "https://evil.example#@github.com/NousResearch/hermes-agent",
    "https://evil.example?@github.com/NousResearch/hermes-agent",
    "https://evil.example\\@github.com/NousResearch/hermes-agent",
    "https://user:pa/ss@github.com/NousResearch/hermes-agent",
    "https://us[er@github.com/NousResearch/hermes-agent",
    "https://evil.example/https://github.com/NousResearch/hermes-agent",
    "https://evil.example/?u=https://github.com/NousResearch/hermes-agent",
    "http://github.com/NousResearch/hermes-agent",
    "git://github.com/NousResearch/hermes-agent",
    "ssh://github.com/NousResearch/hermes-agent",
    "ssh://git@evil.example/NousResearch/hermes-agent",
    "git@github.com:someone/hermes-agent",
    "git@github.com:NousResearch/hermes-agent/extra",
    "git@evil.example:NousResearch/hermes-agent",
    "https://github.com/NousResearch/hermes-agent\nhttps://evil.example",
    "/home/me/hermes-agent",
    "../hermes-agent",
    "",
    "   ",
    null,
    undefined,
    42,
    {}
  ];
  for (const url of other) assert.equal(isOfficialHermesUrl(url), false, JSON.stringify(url));
});

// ---- real repositories ----------------------------------------------------------------------------------------

// git with a temp HOME and no system settings, and one fixed author and date, so the developer's own git setup
// never takes part and the commits are the same every run.
function gitTestEnv(home) {
  return {
    PATH: SYSTEM_PATH_DIRS.join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    LANG: "C",
    GIT_AUTHOR_NAME: "Agent OS test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Agent OS test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
  };
}

let world = null;
const saved = {};

// One shared set of origins, made once:
//   upstream.git  the official repository: main (c1, c2, c3) and the annotated tag v0.2.0, which sits on a commit
//                 that main does not contain (as on a real Hermes install, where the release history is reachable
//                 only through the `v*` tags). The branch that made the commit is not published.
//   fork.git      somebody's fork: the same main, plus the branch my-changes.
// Each test makes its own clones of them (installs), laid out as Hermes does: <home>/hermes-agent.
async function makeWorld() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-hermes-clean-")));
  const home = path.join(root, "home");
  await mkdir(home);
  const env = gitTestEnv(home);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = async (cwd, file, text, message) => {
    await writeFile(path.join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", message);
  };

  const seed = path.join(root, "seed");
  await mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  await commit(seed, "app.py", "one\n", "c1");
  await commit(seed, "app.py", "two\n", "c2");
  await commit(seed, "app.py", "three\n", "c3");
  git(seed, "checkout", "-q", "-b", "release-line", "main~2");
  await commit(seed, "release.txt", "0.2.0\n", "release 0.2.0");
  git(seed, "tag", "-a", "v0.2.0", "-m", "Hermes 0.2.0");
  git(seed, "checkout", "-q", "main");
  git(seed, "checkout", "-q", "-b", "my-changes", "main");
  await commit(seed, "mine.txt", "mine\n", "my change");
  git(seed, "checkout", "-q", "main");

  const upstream = path.join(root, "upstream.git");
  git(root, "init", "-q", "--bare", "-b", "main", upstream);
  git(upstream, "config", "uploadpack.allowFilter", "true"); // lets one test make a real partial clone
  git(seed, "push", "-q", upstream, "main", "refs/tags/v0.2.0");
  const fork = path.join(root, "fork.git");
  git(root, "init", "-q", "--bare", "-b", "main", fork);
  git(seed, "push", "-q", fork, "main", "my-changes");

  let counter = 0;
  function handle(hermesHome) {
    const checkout = path.join(hermesHome, "hermes-agent");
    return {
      home: hermesHome,
      checkout,
      git: (...args) => git(checkout, ...args),
      write: (file, text) => writeFile(path.join(checkout, file), text),
      commit: (file, text, message) => commit(checkout, file, text, message)
    };
  }

  // A clone of `source` as <home>/hermes-agent, whose remote `remote` then reads as `url` (the recorded URL is
  // set after the clone, so nothing here can reach the network afterwards). `partial` makes a real
  // `--filter=blob:none` clone (the kind Hermes installs are). `ref` checks out a tag (detached) or a branch.
  async function install({ source = upstream, remote = "origin", url = OFFICIAL, partial = false, ref = null } = {}) {
    counter += 1;
    const hermesHome = path.join(root, `hermes-home-${counter}`);
    const hermes = handle(hermesHome);
    await mkdir(hermesHome);
    git(root, "clone", "-q", "-o", remote, ...(partial ? ["--filter=blob:none", `file://${source}`] : [source]), hermes.checkout);
    git(hermes.checkout, "fetch", "-q", "--tags", remote);
    if (ref) git(hermes.checkout, "checkout", "-q", ...(/^v\d/.test(ref) ? ["--detach"] : []), ref);
    git(hermes.checkout, "config", `remote.${remote}.url`, url);
    return hermes;
  }

  // A checkout with one commit whose official remote is configured but was never fetched: no remote-tracking
  // branches and no release tags.
  async function neverFetched() {
    counter += 1;
    const hermes = handle(path.join(root, `hermes-home-${counter}`));
    await mkdir(hermes.checkout, { recursive: true });
    git(hermes.checkout, "init", "-q", "-b", "main");
    await commit(hermes.checkout, "app.py", "x\n", "first");
    git(hermes.checkout, "remote", "add", "origin", OFFICIAL);
    return hermes;
  }

  return { root, env, git, install, neverFetched, upstream, fork };
}

before(async () => {
  if (isWindows || !HAS_GIT) return;
  world = await makeWorld();
  // runGit keeps its "no hooks" folder inside Agent OS's own home: a temp one, never the developer's.
  for (const key of ["AGENT_OS_HOME", "HERMES_AGENT_OS_HOME"]) saved[key] = process.env[key];
  process.env.AGENT_OS_HOME = path.join(world.root, "agent-os-home");
  delete process.env.HERMES_AGENT_OS_HOME;
});

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (world) await rm(world.root, { recursive: true, force: true });
});

// The check on one install, with the temp git environment and an unset channel unless a test says otherwise.
function checkOf(installed, options = {}) {
  return hermesCleanCheck({ home: installed.home, configGet: channelUnset, env: world.env, ...options });
}

const cleanAt = (hermes) => ({ clean: true, checkout: hermes.checkout, reasons: [] });
const notCleanAt = (hermes, reasons) => ({ clean: false, checkout: hermes.checkout, reasons });

function spyRun(calls) {
  return (folder, args, options) => {
    calls.push({ folder, args: [...args] });
    return runGit(folder, args, options);
  };
}

// A runGit that fails one git command (by its name) the way git fails when it cannot do it.
const failing = (name) => async (folder, args, options) =>
  args[0] === name ? { code: 128, stdout: "", stderr: "fatal: unable to read", timedOut: false, ok: false } : runGit(folder, args, options);

// ---- clean ----------------------------------------------------------------------------------------------------

test("clean: an official clone detached at a release tag (its commit is not on origin/main)", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  assert.equal(hermes.git("rev-parse", "--abbrev-ref", "HEAD").trim(), "HEAD", "detached");
  assert.equal(hermes.git("rev-list", "--count", "HEAD", "--not", "--remotes=origin").trim(), "1", "the tag's commit is outside origin/*");
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
});

test("clean: an official clone on main, equal to origin/main", GIT_ONLY, async () => {
  const hermes = await world.install();
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
});

test("clean: a branch other than main that sits exactly on origin/main", GIT_ONLY, async () => {
  const hermes = await world.install();
  hermes.git("checkout", "-q", "-b", "same-as-main");
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
});

test("clean: the official remote can have any name, and sit beside a fork", GIT_ONLY, async () => {
  const hermes = await world.install({ remote: "upstream" });
  hermes.git("remote", "add", "origin", FORK);
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
});

test("clean: a real partial clone (--filter=blob:none), which the check reads without any missing file", GIT_ONLY, async () => {
  const hermes = await world.install({ partial: true, ref: "v0.2.0" });
  assert.equal(hermes.git("config", "--get", "remote.origin.promisor").trim(), "true", "this is a promisor remote");
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
});

test("clean: files that git ignores (a venv, caches) do not count", GIT_ONLY, async () => {
  const hermes = await world.install();
  await writeFile(path.join(hermes.checkout, ".git", "info", "exclude"), "venv/\n__pycache__/\n");
  await mkdir(path.join(hermes.checkout, "venv"));
  await hermes.write("venv/pyvenv.cfg", "home = /usr/bin\n");
  await mkdir(path.join(hermes.checkout, "__pycache__"));
  await hermes.write("__pycache__/app.pyc", "x");
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
});

test("clean: a lightweight v* tag counts like an annotated one", GIT_ONLY, async () => {
  const hermes = await world.install();
  hermes.git("tag", "v0.1.9", "origin/main~1");
  hermes.git("checkout", "-q", "--detach", "v0.1.9");
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
});

// ---- the seven reasons ----------------------------------------------------------------------------------------

test("local_commits: an official clone plus one local commit", GIT_ONLY, async () => {
  const hermes = await world.install();
  await hermes.commit("local.txt", "mine\n", "local work");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["local_commits"]));
});

test("local_commits: a commit on top of a release tag is both off the release and a local commit", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  await hermes.commit("local.txt", "mine\n", "local work");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["not_on_release_or_main", "local_commits"]));
});

test("local_commits: a local commit on a branch that is not pushed anywhere", GIT_ONLY, async () => {
  const hermes = await world.install();
  hermes.git("checkout", "-q", "-b", "wip");
  await hermes.commit("local.txt", "mine\n", "local work");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["not_on_release_or_main", "local_commits"]));
});

test("no_official_remote: a custom branch pushed to a fork, with no official remote", GIT_ONLY, async () => {
  const hermes = await world.install({ source: world.fork, url: FORK, ref: "my-changes" });
  assert.equal(hermes.git("rev-parse", "--abbrev-ref", "HEAD").trim(), "my-changes");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["no_official_remote", "not_on_release_or_main"]));
});

test("no_official_remote: a clone of a fork only, on its main", GIT_ONLY, async () => {
  const hermes = await world.install({ source: world.fork, url: FORK });
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["no_official_remote"]));
});

test("no_official_remote: the commit count is not made without an official remote to compare with", GIT_ONLY, async () => {
  const hermes = await world.install({ source: world.fork, url: FORK });
  await hermes.commit("local.txt", "mine\n", "local work");
  const calls = [];
  const result = await checkOf(hermes, { run: spyRun(calls) });
  assert.deepEqual(result.reasons, ["no_official_remote"]);
  assert.equal(calls.some((call) => call.args[0] === "rev-list"), false);
});

test("no_official_remote: a URL that git rewrites (url.<base>.insteadOf) is judged by where git would fetch from", GIT_ONLY, async () => {
  const hermes = await world.install();
  hermes.git("config", `url.${FORK}.insteadOf`, OFFICIAL);
  assert.equal(hermes.git("config", "--get", "remote.origin.url").trim(), OFFICIAL, "the recorded URL still reads as official");
  assert.deepEqual((await checkOf(hermes)).reasons, ["no_official_remote"]);
});

test("dirty_tree: a modified tracked file", GIT_ONLY, async () => {
  const hermes = await world.install();
  await hermes.write("app.py", "edited\n");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["dirty_tree"]));
});

test("dirty_tree: an untracked file", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  await hermes.write("notes.txt", "my notes\n");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["dirty_tree"]));
});

test("dirty_tree: a staged change", GIT_ONLY, async () => {
  const hermes = await world.install();
  await hermes.write("app.py", "staged\n");
  hermes.git("add", "app.py");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["dirty_tree"]));
});

// ---- git must not run a program the repository configures (finding 1 of the review) ---------------------------

// A clean filter that writes a marker file each time git runs it, and passes the content through unchanged (so
// a status that did run it would still answer "unchanged"). `git status` runs it on a file whose timestamp changed.
let markerCounter = 0;
function probeMarker() {
  markerCounter += 1;
  return path.join(world.root, `filter-ran-${markerCounter}`);
}
const probeFilter = (marker) => `echo ran >> '${marker}'; cat`;
// Moves a file's timestamp so that git can't trust its saved stat data and has to read the content.
const touchLater = async (file, secondsAhead) => {
  const when = new Date(Date.now() + secondsAhead * 1000);
  await utimes(file, when, when);
};

test("a filter driver in the repository's config (with a tracked .gitattributes) is never run by the check", GIT_ONLY, async () => {
  const hermes = await world.install();
  const marker = probeMarker();
  hermes.git("config", "filter.probe.clean", probeFilter(marker));
  await hermes.commit(".gitattributes", "app.py filter=probe\n", "use the probe filter"); // a tracked .gitattributes
  const appFile = path.join(hermes.checkout, "app.py");

  // Control: plain git does run the filter here, so a missing marker below means something.
  await touchLater(appFile, 60);
  hermes.git("status", "--porcelain");
  assert.equal(existsSync(marker), true, "the probe works: plain `git status` runs the filter");
  await rm(marker, { force: true });

  await touchLater(appFile, 120);
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["local_commits"]), "the result is still computed");
  assert.equal(existsSync(marker), false, "the check did not run the filter");

  await hermes.write("app.py", "edited\n");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["local_commits", "dirty_tree"]));
  assert.equal(existsSync(marker), false, "nor on a file that really changed");
});

test("a filter driver set in the person's own git config is never run by the check", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  const marker = probeMarker();
  const personalConfig = path.join(world.env.HOME, ".gitconfig");
  // (quoted: in a config file an unquoted ";" starts a comment)
  await writeFile(personalConfig, `[filter "probe"]\n\tclean = "${probeFilter(marker)}"\n`);
  try {
    await writeFile(path.join(hermes.checkout, ".git", "info", "attributes"), "app.py filter=probe\n");
    await touchLater(path.join(hermes.checkout, "app.py"), 60);
    assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(personalConfig, { force: true });
  }
});

test("a submodule makes the tree not clean, and nothing in its own config ever runs", GIT_ONLY, async () => {
  const hermes = await world.install();
  hermes.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", world.upstream, "sub");
  hermes.git("commit", "-q", "-m", "add a submodule");
  const subFolder = path.join(hermes.checkout, "sub");
  const sub = (...args) => world.git(subFolder, ...args);
  const marker = probeMarker();
  sub("config", "filter.probe.clean", probeFilter(marker)); // only the submodule's own config holds it
  await writeFile(path.join(sub("rev-parse", "--absolute-git-dir").trim(), "info", "attributes"), "app.py filter=probe\n");

  // Control: plain git looks inside the submodule and runs its filter.
  await touchLater(path.join(subFolder, "app.py"), 60);
  hermes.git("status", "--porcelain");
  assert.equal(existsSync(marker), true, "the probe works: plain `git status` runs the submodule's filter");
  await rm(marker, { force: true });

  await touchLater(path.join(subFolder, "app.py"), 120);
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["local_commits", "dirty_tree"]), "the submodule alone makes it dirty_tree");
  assert.equal(existsSync(marker), false, "the check did not enter the submodule");
});

test("a list of the index's files that was cut at its limit can't be read to the end: not clean", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  const tooLong = async (folder, args, options) =>
    args[0] === "ls-files"
      ? { code: 0, stdout: "100644 0000000000000000000000000000000000000000 0\tfile\0".repeat(200_000), stderr: "", timedOut: false, ok: true }
      : runGit(folder, args, options);
  assert.deepEqual(await checkOf(hermes, { run: tooLong }), notCleanAt(hermes, ["dirty_tree"]));
});

test("custom_channel: what `hermes config get update.installs` prints decides it (R36), and the key asked for is update.installs", GIT_ONLY, async () => {
  const hermes = await world.install();
  const asked = [];
  const channel = (output) => async (key) => {
    asked.push(key);
    return output;
  };
  const defaults = [
    { ok: true, stdout: "", stderr: "" },
    { ok: true, stdout: "  \n", stderr: "" },
    { ok: true, stdout: "{}", stderr: "" },
    { ok: true, stdout: "null\n", stderr: "" },
    { ok: true, stdout: "NULL", stderr: "" },
    CHANNEL_UNSET,
    { ok: true, stdout: "Config key not set.", stderr: "" },
    // a missing key may also exit non-zero, with the sentence on either stream
    { ok: false, code: 1, stdout: "Config key not set: update.installs", stderr: "" },
    { ok: false, code: 1, stdout: "", stderr: "Config key not set: update.installs" }
  ];
  for (const output of defaults) {
    assert.deepEqual((await checkOf(hermes, { configGet: channel(output) })).reasons, [], JSON.stringify(output));
  }
  const custom = [
    CHANNEL_SET,
    { ok: true, stdout: "main", stderr: "" },
    { ok: true, stdout: "{'a': 1}", stderr: "" },
    { ok: true, stdout: "Update hint: a newer Hermes exists\n{}", stderr: "" },
    { ok: false, code: 1, stdout: "", stderr: "" }, // a failed read is not "the default"
    { ok: false, code: 1, stdout: "", stderr: "Traceback (most recent call last)" },
    { ok: false, code: 1, stdout: "{}", stderr: "" }, // a failed read does not count even when it printed {}
    null,
    undefined
  ];
  for (const output of custom) {
    assert.deepEqual((await checkOf(hermes, { configGet: channel(output) })).reasons, ["custom_channel"], JSON.stringify(output));
  }
  const rejects = await checkOf(hermes, { configGet: () => Promise.reject(new Error("no hermes")) });
  assert.deepEqual(rejects.reasons, ["custom_channel"]);
  const throws = await checkOf(hermes, {
    configGet: () => {
      throw new Error("no hermes");
    }
  });
  assert.deepEqual(throws.reasons, ["custom_channel"]);
  assert.ok(asked.length > 0 && asked.every((key) => key === "update.installs"), asked.join());
});

test("custom_channel: a channel set on an otherwise clean checkout fails the check on its own", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  assert.deepEqual(await checkOf(hermes, { configGet: channelSet }), notCleanAt(hermes, ["custom_channel"]));
});

test("not_on_release_or_main: detached at a commit that is on origin but neither a v* tag nor origin/main", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  hermes.git("checkout", "-q", "--detach", "origin/main~1");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["not_on_release_or_main"]));
});

test("not_on_release_or_main: a tag that is not a release tag does not count", GIT_ONLY, async () => {
  const hermes = await world.install();
  hermes.git("tag", "-a", "nightly-1", "-m", "not a release", "origin/main~1");
  hermes.git("checkout", "-q", "--detach", "nightly-1");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["not_on_release_or_main"]));
});

test("not_on_release_or_main: a branch standing on a release tag is not 'detached exactly at a tag'", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  hermes.git("checkout", "-q", "-b", "on-the-tag");
  assert.deepEqual(await checkOf(hermes), notCleanAt(hermes, ["not_on_release_or_main"]));
});

test("no_checkout: no home folder, no checkout folder, no .git, a .git that git cannot read, or one inside another repository", GIT_ONLY, async () => {
  const expected = { clean: false, checkout: null, reasons: ["no_checkout"] };
  const check = (home) => hermesCleanCheck({ home, configGet: channelUnset, env: world.env });
  const empty = path.join(world.root, "no-hermes-here");
  await mkdir(empty);
  assert.deepEqual(await check(empty), expected);
  assert.deepEqual(await check(path.join(world.root, "does-not-exist")), expected);
  const plain = path.join(world.root, "plain-home");
  await mkdir(path.join(plain, "hermes-agent"), { recursive: true });
  assert.deepEqual(await check(plain), expected);
  const broken = path.join(world.root, "broken-home");
  await mkdir(path.join(broken, "hermes-agent", ".git"), { recursive: true });
  assert.deepEqual(await check(broken), expected);
  // An unreadable .git inside a folder that is itself in a git project must not make git read that outer project.
  const outer = path.join(world.root, "outer");
  await mkdir(path.join(outer, "hermes-home", "hermes-agent", ".git"), { recursive: true });
  world.git(outer, "init", "-q", "-b", "main");
  assert.deepEqual(await check(path.join(outer, "hermes-home")), expected);
});

test("no_checkout: nothing else is read once there is no checkout (the channel is not asked)", GIT_ONLY, async () => {
  let asked = 0;
  const result = await hermesCleanCheck({
    home: path.join(world.root, "nothing"),
    configGet: async () => {
      asked += 1;
      return CHANNEL_SET;
    },
    env: world.env
  });
  assert.deepEqual(result.reasons, ["no_checkout"]);
  assert.equal(asked, 0);
});

test("refs_unreadable: the official remote is configured but was never fetched; the commit count is skipped", GIT_ONLY, async () => {
  const hermes = await world.neverFetched();
  const calls = [];
  const result = await checkOf(hermes, { run: spyRun(calls) });
  assert.deepEqual(result, notCleanAt(hermes, ["refs_unreadable"]));
  assert.equal(calls.some((call) => call.args[0] === "rev-list"), false, "no commit count against refs that are not there");
});

test("refs: release tags count as the official remote's refs even with no remote-tracking branches (R35)", GIT_ONLY, async () => {
  const hermes = await world.neverFetched();
  hermes.git("tag", "-a", "v0.1.0", "-m", "release");
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes), "the tag is the only official ref, and it holds HEAD");
  await hermes.commit("local.txt", "mine\n", "local work");
  assert.deepEqual((await checkOf(hermes)).reasons, ["local_commits"], "a commit past the tag is a local commit");
  // a tag that is not a release tag does not make the refs readable
  const other = await world.neverFetched();
  other.git("tag", "-a", "nightly", "-m", "not a release");
  assert.deepEqual((await checkOf(other)).reasons, ["refs_unreadable"]);
});

test("refs_unreadable: other findings (dirty tree, channel) are still collected", GIT_ONLY, async () => {
  const hermes = await world.neverFetched();
  await hermes.write("app.py", "changed\n");
  assert.deepEqual(await checkOf(hermes, { configGet: channelSet }), notCleanAt(hermes, ["refs_unreadable", "dirty_tree", "custom_channel"]));
});

// ---- all findings, failures, and what the check never does -----------------------------------------------------

test("every finding is collected, in the order of the sentences", GIT_ONLY, async () => {
  const fork = await world.install({ source: world.fork, url: FORK, ref: "my-changes" });
  await fork.write("app.py", "edited\n");
  assert.deepEqual(
    (await checkOf(fork, { configGet: channelSet })).reasons,
    ["no_official_remote", "not_on_release_or_main", "dirty_tree", "custom_channel"]
  );
  const official = await world.install();
  await official.commit("local.txt", "mine\n", "local work");
  await official.write("app.py", "edited\n");
  assert.deepEqual((await checkOf(official, { configGet: channelSet })).reasons, ["local_commits", "dirty_tree", "custom_channel"]);
});

test("a git call that fails means not clean, with the reason of that call", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  const rows = [
    ["rev-parse", { clean: false, checkout: null, reasons: ["no_checkout"] }],
    ["remote", { clean: false, checkout: null, reasons: ["no_checkout"] }],
    ["for-each-ref", notCleanAt(hermes, ["refs_unreadable"])],
    ["symbolic-ref", notCleanAt(hermes, ["not_on_release_or_main"])],
    ["rev-list", notCleanAt(hermes, ["local_commits"])],
    ["status", notCleanAt(hermes, ["dirty_tree"])],
    // the two reads that come before the status: a failed one fails closed too
    ["ls-files", notCleanAt(hermes, ["dirty_tree"])],
    ["config", notCleanAt(hermes, ["dirty_tree"])]
  ];
  for (const [command, expected] of rows) {
    assert.deepEqual(await checkOf(hermes, { run: failing(command) }), expected, command);
  }
  const timedOut = async (folder, args, options) =>
    args[0] === "status" ? { code: null, stdout: "", stderr: "", timedOut: true, ok: false } : runGit(folder, args, options);
  assert.deepEqual(await checkOf(hermes, { run: timedOut }), notCleanAt(hermes, ["dirty_tree"]));
});

test("never fetches: only read-only git commands run, none of them fetch, pull, ls-remote or remote update", GIT_ONLY, async () => {
  const calls = [];
  const installs = [await world.install({ ref: "v0.2.0" }), await world.install(), await world.install({ source: world.fork, url: FORK })];
  await installs[1].commit("local.txt", "mine\n", "local work");
  await installs[2].write("notes.txt", "untracked\n");
  for (const hermes of installs) await checkOf(hermes, { run: spyRun(calls) });
  assert.ok(calls.length >= 9, `expected a run of git calls, saw ${calls.length}`);
  const allowed = new Set(["remote", "for-each-ref", "symbolic-ref", "rev-parse", "tag", "rev-list", "status", "ls-files", "config"]);
  for (const { args } of calls) {
    assert.ok(allowed.has(args[0]), `unexpected git command: ${args.join(" ")}`);
    assert.notEqual(args[0], "fetch");
    assert.notEqual(args[0], "pull");
    assert.notEqual(args[0], "ls-remote");
    assert.notEqual(args[0] === "remote" && args[1], "update");
    assert.notEqual(args[0] === "remote" && args[1], "add");
    // `git config` only reads (the filter list), and status never looks inside a submodule
    if (args[0] === "config") assert.equal(args[1], "--get-regexp", args.join(" "));
    if (args[0] === "status") assert.ok(args.includes("--ignore-submodules=all"), args.join(" "));
  }
  assert.ok(
    calls.every((call) => installs.some((hermes) => call.folder === hermes.checkout)),
    "every call is made inside the checkout"
  );
});

test("never writes: not a file under .git changes (not even when the index is stale), and no FETCH_HEAD appears", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(hermes.checkout, "app.py"), later, later); // makes the index's stat data stale
  const gitDir = path.join(hermes.checkout, ".git");
  const snapshot = async () => {
    const entries = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const info = await stat(full);
          entries.push(`${path.relative(gitDir, full)} ${info.size} ${info.mtimeMs}`);
        }
      }
    };
    await walk(gitDir);
    return entries.sort();
  };
  await rm(path.join(gitDir, "FETCH_HEAD"), { force: true }); // left by the setup's own fetch
  const filesBefore = await snapshot();
  assert.deepEqual(await checkOf(hermes), cleanAt(hermes));
  assert.deepEqual(await snapshot(), filesBefore);
  assert.equal(existsSync(path.join(gitDir, "FETCH_HEAD")), false);
});

test("a GIT_DIR in the environment does not send the check to another repository", GIT_ONLY, async () => {
  const hermes = await world.install({ ref: "v0.2.0" });
  // A GIT_DIR from the person's shell would send git to another repository whatever `-C` says; runGit drops it.
  const env = { ...world.env, GIT_DIR: path.join(world.root, "upstream.git") };
  assert.deepEqual(await hermesCleanCheck({ home: hermes.home, configGet: channelUnset, env }), cleanAt(hermes));
});

// ---- the real configGet and the home --------------------------------------------------------------------------

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A stand-in `hermes` first on PATH (in a temp folder, so the no-real-agents watcher allows it). `--version` and
// the other detection questions get a plain answer; `config get <key>` prints the contents of
// $HERMES_HOME/installs.txt (or the "Config key not set" sentence) and notes the arguments and HERMES_HOME it got.
async function withShimHermes(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-hermes-shim-"));
  try {
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const shim = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "Hermes Agent v0.22.5"; exit 0; fi',
      'if [ "$1" = "config" ] && [ "$2" = "get" ]; then',
      '  echo "$* | $HERMES_HOME" >> "$HERMES_HOME/shim-calls.txt"',
      '  if [ -f "$HERMES_HOME/installs.txt" ]; then cat "$HERMES_HOME/installs.txt"; exit 0; fi',
      '  echo "Config key not set: $3"; exit 0',
      "fi",
      'echo "usage: hermes"',
      ""
    ].join("\n");
    await writeFile(path.join(bin, "hermes"), shim);
    await chmod(path.join(bin, "hermes"), 0o755);
    return await withEnv(
      {
        PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
        HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
        HERMES_HOME: undefined
      },
      async () => {
        clearDetectCaches();
        try {
          return await fn();
        } finally {
          clearDetectCaches();
        }
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the default configGet runs the detected `hermes config get update.installs` with HERMES_HOME set to the home it checks", GIT_ONLY, async () => {
  await withShimHermes(async () => {
    const unset = await world.install({ ref: "v0.2.0" });
    assert.deepEqual(await hermesCleanCheck({ home: unset.home, env: world.env }), cleanAt(unset));
    assert.equal((await readFile(path.join(unset.home, "shim-calls.txt"), "utf8")).trim(), `config get update.installs | ${unset.home}`);

    const custom = await world.install({ ref: "v0.2.0" });
    await writeFile(path.join(custom.home, "installs.txt"), '{"/somewhere": {"channel": "main"}}\n');
    assert.deepEqual(await hermesCleanCheck({ home: custom.home, env: world.env }), notCleanAt(custom, ["custom_channel"]));
  });
});

test("the home: an explicit home wins, then HERMES_HOME, then <home folder>/.hermes", GIT_ONLY, async () => {
  await withShimHermes(async () => {
    const fromEnv = await world.install({ ref: "v0.2.0" });
    const explicit = await world.install({ ref: "v0.2.0" });
    await withEnv({ HERMES_HOME: fromEnv.home }, async () => {
      // The explicit home wins over HERMES_HOME.
      assert.deepEqual(await hermesCleanCheck({ home: explicit.home, configGet: channelUnset, env: world.env }), cleanAt(explicit));
      // With no explicit home, HERMES_HOME (the server's own environment, as resolveHermesHome reads it) is
      // used, and the default channel read goes to that same home.
      assert.deepEqual(await hermesCleanCheck({ env: world.env }), cleanAt(fromEnv));
      assert.match(await readFile(path.join(fromEnv.home, "shim-calls.txt"), "utf8"), /config get update\.installs \| /);
    });
    // With neither, the default is ~/.hermes (here under a temp HOME).
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-home-"));
    try {
      await withEnv({ HOME: fakeHome, USERPROFILE: fakeHome, HERMES_HOME: undefined }, async () => {
        assert.deepEqual(await hermesCleanCheck({ configGet: channelUnset, env: world.env }), { clean: false, checkout: null, reasons: ["no_checkout"] });
        const checkout = path.join(fakeHome, ".hermes", "hermes-agent");
        await mkdir(path.dirname(checkout));
        world.git(world.root, "clone", "-q", world.upstream, checkout);
        world.git(checkout, "config", "remote.origin.url", OFFICIAL);
        assert.deepEqual(await hermesCleanCheck({ configGet: channelUnset, env: world.env }), { clean: true, checkout, reasons: [] });
      });
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
