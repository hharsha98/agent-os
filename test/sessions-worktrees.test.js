// The worktree offer (SP4, Task X9): separate copies of a person's git project, made with
// `git worktree add <AGENT_OS_HOME>/worktrees/<id> -b agentos/<agent>-<n>` (spec "Worktree offer", ruling R25,
// contract choice K14), the routes the New session dialog and the session panel call, and the words they show.
// Real git runs only inside temp repos under a temp HOME, with no global or system git settings. Nothing here starts
// an agent or a session: the manager's half is in test/sessions-manager.test.js, and the probe
// .superpowers/ui-audit/probes/worktree.mjs drives the page.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { sessionError } from "../server/runtime/sessions/errors.js";
import { runGit } from "../server/runtime/sessions/git.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import {
  BRANCH_PREFIX,
  branchName,
  copyAllowed,
  copyPlan,
  createWorktree,
  discardFreshWorktree,
  nextBranch,
  removeWorktree,
  worktreeIdOf,
  worktreePath
} from "../server/runtime/sessions/worktrees.js";
import * as dialog from "../src/ui/newSession.ts";
import * as page from "../src/ui/sessionsPageShared.ts";

const isWindows = process.platform === "win32";
const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const GIT_ONLY = { skip: isWindows ? "POSIX paths and modes" : HAS_GIT ? false : "git is not installed here" };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DIRTY = "The separate copy has changes that aren't committed. Commit or discard them, then try again.";
const NOT_GIT = "This folder isn't a git project, so Agent OS can't make a separate copy.";
const IGNORED = "Files that git ignores in the copy, such as installed packages, are deleted with it.";
const NO_REASON = "Agent OS couldn't make the separate copy, and git gave no reason.";
const MODE_KEYS = {
  DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
  HERMES_AGENT_OS_PUBLIC_MODE: undefined
};

async function withEnvVars(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// git with a temp HOME and no system settings, so the owner's own git setup never takes part.
function gitTestEnv(home) {
  return { PATH: SYSTEM_PATH_DIRS.join(path.delimiter), HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
}

function commit(git, cwd, message) {
  git(cwd, "-c", "user.name=Agent OS test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message);
}

// A temp HOME with Agent OS's folder inside it (as it is by default), a git project with one commit
// (projects/my-app, with README.md and src/app.js) and a plain folder (projects/notes).
async function withRepo(fn) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-worktrees-")));
  const agentOsHome = path.join(home, ".agent-os-data");
  const repo = path.join(home, "projects", "my-app");
  const plain = path.join(home, "projects", "notes");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(plain, { recursive: true });
  const env = gitTestEnv(home);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "README.md"), "hello\n");
  await writeFile(path.join(repo, "src", "app.js"), "console.log('hi');\n");
  git(repo, "add", ".");
  commit(git, repo, "first");
  try {
    return await withEnvVars({ HOME: home, USERPROFILE: home, AGENT_OS_HOME: agentOsHome, HERMES_AGENT_OS_HOME: undefined }, () =>
      fn({ home, agentOsHome, repo, plain, env, git })
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// runGit, recording every argv it is asked for (without the base arguments runGit adds itself) and the options it got.
function spyRun(calls) {
  return (folder, args, options) => {
    calls.push({ folder, args: [...args], options });
    return runGit(folder, args, options);
  };
}

// An argv without the `-c name=value` settings the copy code puts in front of the git command (hooks off, filters off).
function bare(args) {
  const rest = [...args];
  while (rest[0] === "-c") rest.splice(0, 2);
  return rest;
}

// ---- worktrees.js --------------------------------------------------------------------------------------------

test("worktrees.js: one branch scheme, agentos/<agent>-<n>, and OpenClaw never gets a copy while it picks its own folder", () => {
  assert.equal(BRANCH_PREFIX, "agentos/");
  assert.equal(branchName("codex", 1), "agentos/codex-1");
  assert.equal(branchName("claude", 12), "agentos/claude-12");
  for (const id of ["claude", "codex", "cursor", "hermes"]) assert.equal(copyAllowed(id), true, id);
  assert.equal(copyAllowed("openclaw"), false, "S5 did not confirm that OpenClaw honours a folder");
  assert.equal(copyAllowed("bash"), false);
  assert.throws(() => branchName("bash", 1), TypeError);
  assert.throws(() => branchName("codex", 0), TypeError);
  assert.throws(() => branchName("codex", 1.5), TypeError);
  assert.equal(path.basename(worktreePath(SESSION_A)), SESSION_A);
  assert.equal(path.basename(path.dirname(worktreePath(SESSION_A))), "worktrees");
});

test("nextBranch: the smallest number no local agentos/<agent>-<n> branch uses, per agent; null outside a git project", GIT_ONLY, async () => {
  await withRepo(async ({ repo, plain, env, git }) => {
    assert.equal(await nextBranch(repo, "claude", { env }), "agentos/claude-1");
    for (const name of ["agentos/claude-1", "agentos/claude-3", "agentos/claude-01", "agentos/claude-x", "agentos/codex-1", "claude-2"]) {
      git(repo, "branch", name);
    }
    assert.equal(await nextBranch(repo, "claude", { env }), "agentos/claude-2", "the gap at 2 comes first; 01 and x are other names");
    assert.equal(await nextBranch(repo, "codex", { env }), "agentos/codex-2");
    assert.equal(await nextBranch(repo, "cursor", { env }), "agentos/cursor-1");
    assert.equal(await nextBranch(path.join(repo, "src"), "claude", { env }), "agentos/claude-2", "a folder inside the project counts the project's branches");
    assert.equal(await nextBranch(plain, "claude", { env }), null);
    assert.deepEqual(await copyPlan(repo, "hermes", { env }), { git: true, branch: "agentos/hermes-1" });
    assert.deepEqual(await copyPlan(repo, "openclaw", { env }), { git: true, branch: null }, "a git project, but no copy for OpenClaw");
    assert.deepEqual(await copyPlan(plain, "codex", { env }), { git: false, branch: null });
  });
});

test("createWorktree: <AGENT_OS_HOME>/worktrees/<id> (0700) from HEAD on the next branch, and the project keeps its branch and files", GIT_ONLY, async () => {
  await withRepo(async ({ agentOsHome, repo, env, git }) => {
    const head = git(repo, "rev-parse", "HEAD").trim();
    const made = await createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_A, env });
    const dir = path.join(agentOsHome, "worktrees", SESSION_A);
    assert.deepEqual(made, { path: dir, folder: dir, branch: "agentos/claude-1", copyOf: repo });
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), head, "the copy branches from HEAD");
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(), "agentos/claude-1");
    assert.equal(await readFile(path.join(dir, "README.md"), "utf8"), "hello\n");
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(agentOsHome, "worktrees"))).mode & 0o777, 0o700);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main", "the project stays on its branch");
    assert.equal(git(repo, "status", "--porcelain"), "", "and its files are untouched");

    // A folder inside the project: the session runs in the same place inside the copy.
    const sub = await createWorktree({ folder: path.join(repo, "src"), agentId: "claude", sessionId: SESSION_B, env });
    assert.equal(sub.branch, "agentos/claude-2");
    assert.equal(sub.path, path.join(agentOsHome, "worktrees", SESSION_B));
    assert.equal(sub.folder, path.join(agentOsHome, "worktrees", SESSION_B, "src"));
    assert.equal(sub.copyOf, path.join(repo, "src"));
    assert.ok(existsSync(path.join(sub.folder, "app.js")));

    // A folder git tracks nothing in is made, empty, inside the copy.
    await mkdir(path.join(repo, "drafts"));
    const drafts = await createWorktree({ folder: path.join(repo, "drafts"), agentId: "codex", sessionId: SESSION_C, env });
    assert.equal(drafts.branch, "agentos/codex-1");
    assert.equal(drafts.folder, path.join(agentOsHome, "worktrees", SESSION_C, "drafts"));
    assert.equal((await stat(drafts.folder)).isDirectory(), true);
  });
});

test("createWorktree: a folder that isn't a git project is not_git, a project without a commit is worktree_failed with git's words, and nothing is left", GIT_ONLY, async () => {
  await withRepo(async ({ home, agentOsHome, plain, env, git }) => {
    await assert.rejects(createWorktree({ folder: plain, agentId: "codex", sessionId: SESSION_A, env }), {
      status: 409,
      code: "not_git",
      message: NOT_GIT
    });
    assert.equal(existsSync(path.join(agentOsHome, "worktrees", SESSION_A)), false);

    const empty = path.join(home, "projects", "empty");
    await mkdir(empty, { recursive: true });
    git(empty, "init", "-q", "-b", "main");
    await assert.rejects(createWorktree({ folder: empty, agentId: "codex", sessionId: SESSION_B, env }), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "worktree_failed");
      assert.match(error.message, /^Agent OS couldn't make the separate copy\. Git said: (?:fatal|error): .*HEAD/);
      return true;
    });
    assert.equal(existsSync(path.join(agentOsHome, "worktrees", SESSION_B)), false, "no copy is left");
    assert.equal(git(empty, "for-each-ref", "refs/heads/"), "", "and no branch");

    await assert.rejects(createWorktree({ folder: plain, agentId: "codex", sessionId: "not-a-session-id", env }), TypeError);
  });
});

test("removeWorktree: refuses while git status shows anything, then removes the copy without --force and keeps its branch and its commits", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    const made = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env });
    const calls = [];
    const run = spyRun(calls);

    await writeFile(path.join(made.path, "draft.txt"), "not yet\n");
    await assert.rejects(removeWorktree({ path: made.path, copyOf: repo, env, run }), { status: 409, code: "worktree_dirty", message: DIRTY });
    assert.ok(existsSync(path.join(made.path, "draft.txt")), "a new file is never deleted");
    await rm(path.join(made.path, "draft.txt"));

    await writeFile(path.join(made.path, "README.md"), "changed\n");
    await assert.rejects(removeWorktree({ path: made.path, copyOf: repo, env, run }), { status: 409, code: "worktree_dirty" });
    assert.equal(await readFile(path.join(made.path, "README.md"), "utf8"), "changed\n", "a change that isn't committed stays");

    git(made.path, "add", "README.md");
    commit(git, made.path, "work in the copy");
    const work = git(made.path, "rev-parse", "HEAD").trim();
    assert.equal(await removeWorktree({ path: made.path, copyOf: repo, env, run }), undefined);
    assert.equal(existsSync(made.path), false, "the copy's folder is gone");
    assert.equal(git(repo, "rev-parse", "agentos/codex-1").trim(), work, "the branch stays, with the work committed in the copy");
    assert.ok(!git(repo, "worktree", "list", "--porcelain").includes(SESSION_A), "git no longer lists the copy");

    for (const call of calls) assert.ok(!call.args.includes("--force"), `never --force: git ${call.args.join(" ")}`);
    assert.ok(calls.some((call) => bare(call.args).join(" ") === `worktree remove ${made.path}`), "git removes the copy itself");
    assert.ok(!calls.some((call) => bare(call.args)[0] === "branch"), "the branch is never touched");
  });
});

test("removeWorktree: a copy whose folder was deleted by hand is only forgotten by git; with the project gone too there is nothing to do", GIT_ONLY, async () => {
  await withRepo(async ({ home, repo, env, git }) => {
    const made = await createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_A, env });
    await rm(made.path, { recursive: true, force: true });
    await removeWorktree({ path: made.path, copyOf: repo, env });
    assert.ok(!git(repo, "worktree", "list", "--porcelain").includes(SESSION_A), "git forgot the copy");
    assert.match(git(repo, "rev-parse", "--verify", "-q", "refs/heads/agentos/claude-1").trim(), /^[0-9a-f]{40,64}$/, "the branch stays");
    await removeWorktree({ path: made.path, copyOf: path.join(home, "projects", "gone"), env });
  });
});

test("discardFreshWorktree: removes a copy the same start just made and its branch (-d, never -D), and never throws", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    const made = await createWorktree({ folder: repo, agentId: "cursor", sessionId: SESSION_A, env });
    const calls = [];
    await discardFreshWorktree({ path: made.path, copyOf: repo, branch: made.branch, env, run: spyRun(calls) });
    assert.equal(existsSync(made.path), false);
    assert.equal(git(repo, "for-each-ref", "refs/heads/agentos/"), "", "the fresh branch is gone");
    assert.deepEqual(
      calls.map((call) => bare(call.args)),
      // No `git worktree prune` (M14): only Agent OS's own record is looked for (one rev-parse finds the project's git folder).
      [["worktree", "remove", "--force", made.path], ["rev-parse", "--git-common-dir"], ["branch", "-d", "agentos/cursor-1"]]
    );

    // A branch whose commits nothing else holds is never deleted: git -d refuses it.
    const again = await createWorktree({ folder: repo, agentId: "cursor", sessionId: SESSION_B, env });
    assert.equal(again.branch, "agentos/cursor-1");
    await writeFile(path.join(again.path, "x.txt"), "x\n");
    git(again.path, "add", "x.txt");
    commit(git, again.path, "kept");
    await discardFreshWorktree({ path: again.path, copyOf: repo, branch: again.branch, env });
    assert.match(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/agentos/"), /refs\/heads\/agentos\/cursor-1/);

    // Never throws, even when git can't run at all.
    await discardFreshWorktree({ path: worktreePath(SESSION_C), copyOf: repo, branch: "agentos/cursor-9", env: { PATH: "/nonexistent" } });
  });
});

test("worktreeIdOf: the session whose copy holds a folder, or null", GIT_ONLY, async () => {
  await withRepo(async ({ agentOsHome, repo }) => {
    await mkdir(path.join(agentOsHome, "worktrees", SESSION_A, "src"), { recursive: true });
    await mkdir(path.join(agentOsHome, "worktrees", "app-copy"), { recursive: true });
    assert.equal(await worktreeIdOf(path.join(agentOsHome, "worktrees", SESSION_A)), SESSION_A);
    assert.equal(await worktreeIdOf(path.join(agentOsHome, "worktrees", SESSION_A, "src")), SESSION_A);
    assert.equal(await worktreeIdOf(path.join(agentOsHome, "worktrees")), null);
    assert.equal(await worktreeIdOf(path.join(agentOsHome, "worktrees", "app-copy")), null, "only a session id names a copy");
    assert.equal(await worktreeIdOf(repo), null);
    assert.equal(await worktreeIdOf("relative/path"), null);
    assert.equal(await worktreeIdOf(null), null);
  });
});

test("git's refusals reach the person in plain words: its own fatal line, the 2 minutes and 1 minute forms, and the no-reason form", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    // A runner that answers the git commands starting with `match` as given, and runs the rest for real.
    const answering = (match, answer, seen = []) => (folder, args, options) => {
      seen.push(bare(args));
      if (!bare(args).join(" ").startsWith(match)) return runGit(folder, args, options);
      return Promise.resolve({ code: 128, stdout: "", stderr: "", timedOut: false, ok: false, ...answer });
    };
    const addFails = (answer, seen) => createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_A, env, run: answering("worktree add", answer, seen) });

    await assert.rejects(addFails({ stderr: "Preparing worktree\nfatal: a branch named 'x' already exists\nhint: more\n" }), {
      status: 409,
      code: "worktree_failed",
      message: "Agent OS couldn't make the separate copy. Git said: fatal: a branch named 'x' already exists"
    });
    await assert.rejects(addFails({ stderr: "Preparing worktree\nsomething odd\n" }), {
      message: "Agent OS couldn't make the separate copy. Git said: something odd"
    });
    await assert.rejects(addFails({ stderr: "" }), { message: NO_REASON });
    await assert.rejects(addFails({ stderr: `fatal: ${"x".repeat(500)}` }), (error) => {
      assert.ok(error.message.length <= "Agent OS couldn't make the separate copy. Git said: ".length + 300, "git's words are cut at 300 characters");
      return true;
    });
    // Cut off at 2 minutes after git made its branch (at HEAD, as git does): the fresh branch is deleted too (-d).
    const seen = [];
    const cutOff = answering("worktree add", { timedOut: true, code: null }, seen);
    const cutOffAfterItsBranch = (folder, args, options) => {
      if (bare(args).join(" ").startsWith("worktree add")) git(repo, "branch", "agentos/claude-1");
      return cutOff(folder, args, options);
    };
    await assert.rejects(createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_A, env, run: cutOffAfterItsBranch }), {
      code: "worktree_failed",
      message: "Agent OS couldn't make the separate copy: git took longer than 2 minutes."
    });
    assert.ok(seen.some((argv) => argv[0] === "branch" && argv[1] === "-d" && argv[2] === "agentos/claude-1"), "the branch a cut-off add made is removed");
    assert.equal(git(repo, "for-each-ref", "refs/heads/agentos/"), "", "and it is gone");
    const other = [];
    await assert.rejects(addFails({ stderr: "fatal: no" }, other));
    assert.ok(!other.some((argv) => argv[0] === "branch"), "a refused add that left no branch of that name deletes none (real git: see the leftover-branch tests)");

    const made = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_C, env });
    const removeFails = (answer) => removeWorktree({ path: made.path, copyOf: repo, env, run: answering("worktree remove", answer) });
    await assert.rejects(removeFails({ stderr: "fatal: 'x' contains modified or untracked files, use --force to delete it\n" }), {
      status: 409,
      code: "worktree_remove_failed",
      message: "Agent OS couldn't remove the separate copy. Git said: fatal: 'x' contains modified or untracked files, use --force to delete it"
    });
    await assert.rejects(removeFails({ timedOut: true, code: null }), {
      code: "worktree_remove_failed",
      message: "Agent OS couldn't remove the separate copy: git took longer than a minute."
    });
    await assert.rejects(removeFails({ stderr: "" }), {
      code: "worktree_remove_failed",
      message: "Agent OS couldn't remove the separate copy, and git gave no reason."
    });
    assert.ok(existsSync(made.path), "a refused removal deletes nothing");
    await removeWorktree({ path: made.path, copyOf: repo, env });
    assert.equal(existsSync(made.path), false);
  });
});

// ---- the security ruling: nothing the project configured runs while a copy is made or removed ----------------------
// `git worktree add` checks files out, so a smudge filter or a post-checkout hook the project's own settings name
// could run a program. Every add, remove and clean-up switches every configured filter driver off (git-lfs's
// included), sets GIT_LFS_SKIP_SMUDGE=1, and points core.hooksPath at an empty folder that Agent OS owns.

const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12\n";
const HOOKS = ["post-checkout", "reference-transaction", "post-index-change"];

// A project whose own settings would run programs if git were left alone: a hook for each step a checkout takes, a
// smudge and a clean filter of its own, and the standard git-lfs filter with a stand-in git-lfs first on PATH. Every
// program writes a file into `marks`, so a test sees whether it ran. Returns the git environment, a git that sees the
// stand-in, and `marks`.
async function plantRunners({ home, repo }) {
  const marks = path.join(home, "marks");
  const bin = path.join(home, "fake-bin");
  await mkdir(marks, { recursive: true });
  await mkdir(bin, { recursive: true });
  const toolEnv = { ...gitTestEnv(home), PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter) };
  const tool = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: toolEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // Committed before any filter is configured, so nothing runs here. `sneaky` and `sneaky2` are defined only through
  // conditional includes (safety review C1): the first applies only while the branch is agentos/**, the second only in a
  // linked worktree's git folder, so neither is visible from the project itself, only from inside the new copy.
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil\n*.bin filter=lfs\n*.log filter=sneaky\n*.dat filter=sneaky2\n");
  await writeFile(path.join(repo, "note.txt"), "plain text\n");
  await writeFile(path.join(repo, "big.bin"), POINTER);
  await writeFile(path.join(repo, "a.log"), "plain log\n");
  await writeFile(path.join(repo, "b.dat"), "plain data\n");
  tool(repo, "add", ".");
  commit(tool, repo, "attributes, a text file and a large-file pointer");

  const program = async (file, body) => {
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
  };
  const mark = (name) => `echo ran >> '${path.join(marks, name)}'`;
  await program(path.join(home, "evil-smudge.sh"), `${mark("smudge")}\ntr a-z A-Z`);
  await program(path.join(home, "evil-clean.sh"), `${mark("clean")}\ncat`);
  await program(path.join(bin, "git-lfs"), `${mark("lfs")}\ncat > /dev/null\necho downloaded file`);
  for (const name of HOOKS) await program(path.join(repo, ".git", "hooks", name), mark(name));
  tool(repo, "config", "filter.evil.smudge", `sh ${path.join(home, "evil-smudge.sh")} %f`);
  tool(repo, "config", "filter.evil.clean", `sh ${path.join(home, "evil-clean.sh")} %f`);
  // Exactly what `git lfs install` writes for clean and smudge: the values a trusting rule would leave alone.
  tool(repo, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  tool(repo, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  await program(path.join(home, "sneaky-smudge.sh"), `${mark("sneaky")}\ntr a-z A-Z`);
  await program(path.join(home, "sneaky2-smudge.sh"), `${mark("sneaky2")}\ntr a-z A-Z`);
  await writeFile(path.join(home, "onbranch.inc"), `[filter "sneaky"]\n\tsmudge = sh ${path.join(home, "sneaky-smudge.sh")} %f\n`);
  await writeFile(path.join(home, "gitdir.inc"), `[filter "sneaky2"]\n\tsmudge = sh ${path.join(home, "sneaky2-smudge.sh")} %f\n`);
  tool(repo, "config", "includeIf.onbranch:agentos/**.path", path.join(home, "onbranch.inc"));
  tool(repo, "config", "includeIf.gitdir:**/.git/worktrees/**.path", path.join(home, "gitdir.inc"));
  return { toolEnv, tool, marks };
}

async function marked(marks) {
  return (await readdir(marks)).sort();
}

test("security: planted hooks and filters really run when git is left alone (the control for the tests below)", GIT_ONLY, async () => {
  await withRepo(async ({ home, repo }) => {
    const { tool, marks } = await plantRunners({ home, repo });
    const control = path.join(home, "control");
    tool(repo, "worktree", "add", control, "-b", "agentos/control-1", "HEAD");
    const ran = await marked(marks);
    for (const name of ["smudge", "lfs", "post-checkout", "reference-transaction", "sneaky", "sneaky2"]) assert.ok(ran.includes(name), `${name} ran: ${ran.join()}`);
    assert.equal(await readFile(path.join(control, "note.txt"), "utf8"), "PLAIN TEXT\n", "the smudge filter changed the file");
    assert.equal(await readFile(path.join(control, "big.bin"), "utf8"), "downloaded file\n", "the lfs stand-in 'downloaded' it");
    assert.equal(await readFile(path.join(control, "a.log"), "utf8"), "PLAIN LOG\n", "so did the filter that only the onbranch include defines");
    assert.equal(await readFile(path.join(control, "b.dat"), "utf8"), "PLAIN DATA\n", "and the one that only the gitdir include defines");
    // Seen from the project itself neither include applies: that is why the list is read inside the new copy.
    let fromProject = "";
    try {
      fromProject = tool(repo, "config", "--get-regexp", "^filter\\.sneaky").trim();
    } catch {
      fromProject = ""; // exit 1: nothing matches
    }
    assert.equal(fromProject, "", "the project's own view of its settings holds neither conditional filter");
    // A file whose time changed makes git read it through the clean filter when it looks at the status.
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(control, "note.txt"), later, later);
    tool(control, "status", "--porcelain");
    assert.ok((await marked(marks)).includes("clean"), "the clean filter ran for the status");
  });
});

test("security: making and removing a copy runs no hook and no filter of the project, git-lfs's included, and large-file pointers stay pointers", GIT_ONLY, async () => {
  await withRepo(async ({ home, agentOsHome, repo }) => {
    const { toolEnv, marks } = await plantRunners({ home, repo });
    const calls = [];
    const run = spyRun(calls);
    const made = await createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_A, env: toolEnv, run });

    assert.deepEqual(await marked(marks), [], "no hook, no filter and no git-lfs ran");
    assert.equal(await readFile(path.join(made.path, "note.txt"), "utf8"), "plain text\n", "no smudge filter changed a file");
    assert.equal(await readFile(path.join(made.path, "big.bin"), "utf8"), POINTER, "a large-file pointer stays a pointer, nothing was downloaded");
    assert.equal(await readFile(path.join(made.path, "a.log"), "utf8"), "plain log\n", "the filter only the onbranch include defines did not run (C1)");
    assert.equal(await readFile(path.join(made.path, "b.dat"), "utf8"), "plain data\n", "nor the one only the gitdir include defines (C1)");

    // Two steps (C1): the add checks nothing out, the filters are listed inside the new copy, and a reset fills it.
    const add = calls.find((call) => bare(call.args).slice(0, 2).join(" ") === "worktree add");
    assert.ok(add, "git worktree add ran");
    assert.ok(add.args.includes("--no-checkout"), "without a checkout, so no filter can run during it");
    const hooks = path.join(agentOsHome, "empty-hooks");
    assert.deepEqual(add.args.slice(0, 2), ["-c", `core.hooksPath=${hooks}`], "hooks come from an empty folder, never the project's");
    assert.deepEqual(await readdir(hooks), [], "and that folder is empty");
    assert.equal((await stat(hooks)).mode & 0o777, 0o700);
    const listed = calls.filter((call) => bare(call.args)[0] === "config" && call.folder === made.path);
    assert.equal(listed.length, 1, "the filter drivers are listed inside the new copy");
    assert.ok(calls.indexOf(listed[0]) > calls.indexOf(add), "after the copy exists");
    const reset = calls.find((call) => bare(call.args)[0] === "reset");
    assert.ok(reset && calls.indexOf(reset) > calls.indexOf(listed[0]), "the checkout (reset) comes after the list");
    assert.deepEqual(bare(reset.args), ["reset", "--hard", "--quiet", "--no-recurse-submodules"]);
    assert.equal(reset.folder, made.path);
    assert.equal(reset.options.env.GIT_LFS_SKIP_SMUDGE, "1");
    const off = new Map(reset.options.config);
    for (const name of ["evil", "lfs", "sneaky", "sneaky2"]) {
      for (const variable of ["clean", "smudge", "process"]) assert.equal(off.get(`filter.${name}.${variable}`), "", `filter.${name}.${variable} is off`);
      assert.equal(off.get(`filter.${name}.required`), "false");
    }

    // Removing: git looks at the status (a file whose time changed goes through the clean filter) and removes the copy.
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(made.path, "note.txt"), later, later);
    await removeWorktree({ path: made.path, copyOf: repo, env: toolEnv, run });
    assert.equal(existsSync(made.path), false);
    assert.deepEqual(await marked(marks), [], "removing the copy ran no hook and no filter");
    // Every call that changes anything or looks at files has the hooks off (the reads of the branch list, the top
    // folder, the version and the filter list run no hook and no filter).
    const acting = calls.filter((entry) => ["worktree", "status", "branch", "reset"].includes(bare(entry.args)[0]));
    assert.ok(acting.length >= 4, "an add, a reset, a status and a remove");
    for (const call of acting) {
      assert.deepEqual(call.args.slice(0, 2), ["-c", `core.hooksPath=${hooks}`], `hooks off: git ${call.args.join(" ")}`);
    }
    for (const call of calls) assert.ok(!call.args.includes("--force"), "never --force");

    // The clean-up of a start that failed after the copy was made: git branch -d would run the reference-transaction hook.
    const again = await createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_B, env: toolEnv, run });
    const cleanup = [];
    await discardFreshWorktree({ path: again.path, copyOf: repo, branch: again.branch, env: toolEnv, run: spyRun(cleanup) });
    assert.equal(existsSync(again.path), false);
    assert.ok(cleanup.some((call) => bare(call.args)[0] === "branch"), "the fresh branch was deleted");
    for (const call of cleanup) assert.deepEqual(call.args.slice(0, 2), ["-c", `core.hooksPath=${hooks}`], `hooks off: git ${call.args.join(" ")}`);
    assert.deepEqual(await marked(marks), [], "the clean-up ran no hook either");
  });
});

test("security: when the filter drivers can't be listed, nothing is checked out, the copy and its branch are removed again, and the person hears that git gave no reason", GIT_ONLY, async () => {
  await withRepo(async ({ home, agentOsHome, repo, git }) => {
    const { toolEnv, marks } = await plantRunners({ home, repo });
    const calls = [];
    const refusing = (folder, args, options) => {
      calls.push({ folder, args: [...args], options });
      if (bare(args)[0] === "config") return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false, ok: false });
      return runGit(folder, args, options);
    };
    await assert.rejects(createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_A, env: toolEnv, run: refusing }), {
      status: 409,
      code: "worktree_failed",
      message: NO_REASON
    });
    assert.ok(!calls.some((call) => bare(call.args)[0] === "reset"), "nothing was checked out");
    assert.equal(existsSync(path.join(agentOsHome, "worktrees", SESSION_A)), false, "the empty copy is gone");
    assert.equal(git(repo, "for-each-ref", "refs/heads/agentos/"), "", "and so is its branch");
    assert.ok(!git(repo, "worktree", "list", "--porcelain").includes(SESSION_A), "git forgot the copy");
    assert.deepEqual(await marked(marks), []);
  });
});

test("security: a git older than 2.31 gets the same protection through -c arguments, and a filter name git can't switch off that way stops the copy", GIT_ONLY, async () => {
  await withRepo(async ({ home, agentOsHome, repo }) => {
    const { toolEnv, tool, marks } = await plantRunners({ home, repo });
    const calls = [];
    const oldGit = (folder, args, options) => {
      calls.push({ folder, args: [...args], options });
      if (args.length === 1 && args[0] === "--version") {
        return Promise.resolve({ code: 0, stdout: "git version 2.30.2\n", stderr: "", timedOut: false, ok: true });
      }
      return runGit(folder, args, options);
    };
    const made = await createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_A, env: toolEnv, run: oldGit });
    assert.deepEqual(await marked(marks), [], "no hook and no filter ran on the older git either");
    assert.equal(await readFile(path.join(made.path, "big.bin"), "utf8"), POINTER);
    assert.equal(await readFile(path.join(made.path, "a.log"), "utf8"), "plain log\n", "the conditional-include filters stayed off too");
    // The filters are switched off for the reset that fills the copy.
    const reset = calls.find((call) => bare(call.args)[0] === "reset");
    assert.deepEqual(reset.options.config ?? [], [], "nothing goes through the environment");
    for (const setting of [
      "filter.evil.smudge=",
      "filter.evil.clean=",
      "filter.lfs.smudge=",
      "filter.lfs.clean=",
      "filter.lfs.required=false",
      "filter.sneaky.smudge=",
      "filter.sneaky2.smudge="
    ]) {
      assert.ok(reset.args.includes(setting), `-c ${setting}`);
    }

    tool(repo, "config", "filter.a=b.smudge", "cat");
    const before = calls.length;
    await assert.rejects(createWorktree({ folder: repo, agentId: "claude", sessionId: SESSION_B, env: toolEnv, run: oldGit }), {
      status: 409,
      code: "worktree_failed",
      message: NO_REASON
    });
    assert.ok(!calls.slice(before).some((call) => bare(call.args)[0] === "reset"), "nothing was checked out");
    assert.equal(existsSync(path.join(agentOsHome, "worktrees", SESSION_B)), false, "the empty copy is gone");
    assert.equal(tool(repo, "for-each-ref", "--format=%(refname)", "refs/heads/agentos/").trim(), "refs/heads/agentos/claude-1", "only the first copy's branch is left");
  });
});

// ---- the safety review's fixes (fix round 1) --------------------------------------------------------------------

test("C2: Remove separate copy refuses a new file even when status.showUntrackedFiles is no, and git's own check is a second look that never deletes it", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    git(repo, "config", "status.showUntrackedFiles", "no");
    const made = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env });
    const file = path.join(made.path, "agent-work.js");
    await writeFile(file, "work the agent just did\n");
    assert.equal(git(made.path, "status", "--porcelain"), "", "precondition: with that setting a plain status shows nothing");

    const calls = [];
    await assert.rejects(removeWorktree({ path: made.path, copyOf: repo, env, run: spyRun(calls) }), { status: 409, code: "worktree_dirty", message: DIRTY });
    assert.equal(await readFile(file, "utf8"), "work the agent just did\n", "the new file is still there");
    const status = calls.find((call) => bare(call.args)[0] === "status");
    assert.ok(status.args.includes("--untracked-files=normal"), "the status asks for untracked files itself");
    assert.ok(!calls.some((call) => bare(call.args).slice(0, 2).join(" ") === "worktree remove"), "git was never asked to remove it");

    // If our own status ever answered "clean", git's own check inside `worktree remove` gets the same setting and refuses.
    const blind = (folder, args, options) =>
      bare(args)[0] === "status" ? Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ok: true }) : runGit(folder, args, options);
    await assert.rejects(removeWorktree({ path: made.path, copyOf: repo, env, run: blind }), { status: 409, code: "worktree_remove_failed" });
    assert.equal(await readFile(file, "utf8"), "work the agent just did\n", "git's own check did not delete it either");

    await rm(file);
    await removeWorktree({ path: made.path, copyOf: repo, env });
    assert.equal(existsSync(made.path), false, "without the new file the copy goes");
  });
});

test("I1: a failed add removes the branch it made itself (-d), and never a branch someone else made", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    // Real git makes the branch first, then fails to make its folder inside .git (here .git/worktrees is a file).
    await writeFile(path.join(repo, ".git", "worktrees"), "not a folder\n");
    await assert.rejects(createWorktree({ folder: repo, agentId: "hermes", sessionId: SESSION_A, env }), { status: 409, code: "worktree_failed" });
    assert.equal(git(repo, "for-each-ref", "refs/heads/agentos/"), "", "the branch the failed add made is gone");
    assert.equal(existsSync(worktreePath(SESSION_A)), false);
    await rm(path.join(repo, ".git", "worktrees"));

    // Someone makes the same branch between the check and the add: git says it already exists, and it is theirs.
    const head = git(repo, "rev-parse", "HEAD").trim();
    const rival = (folder, args, options) => {
      if (bare(args).join(" ").startsWith("worktree add")) git(repo, "branch", "agentos/hermes-1");
      return runGit(folder, args, options);
    };
    await assert.rejects(createWorktree({ folder: repo, agentId: "hermes", sessionId: SESSION_B, env, run: rival }), /already exists/);
    assert.equal(git(repo, "rev-parse", "agentos/hermes-1").trim(), head, "their branch stays");
    git(repo, "branch", "-D", "agentos/hermes-1");

    // A branch of that name on another commit than HEAD is not this start's, whatever git said.
    await writeFile(path.join(repo, "second.txt"), "2\n");
    git(repo, "add", "second.txt");
    commit(git, repo, "second");
    const older = git(repo, "rev-parse", "HEAD~1").trim();
    const elsewhere = (folder, args, options) => {
      if (!bare(args).join(" ").startsWith("worktree add")) return runGit(folder, args, options);
      git(repo, "branch", "agentos/hermes-1", "HEAD~1");
      return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: some other trouble\n", timedOut: false, ok: false });
    };
    await assert.rejects(createWorktree({ folder: repo, agentId: "hermes", sessionId: SESSION_C, env, run: elsewhere }), /some other trouble/);
    assert.equal(git(repo, "rev-parse", "agentos/hermes-1").trim(), older, "a branch on another commit stays");
  });
});

test("M2: nothing may be at the copy's place before the add, a folder git says it found there is left alone, and a link at a copy's place is never given to git", GIT_ONLY, async () => {
  await withRepo(async ({ home, agentOsHome, repo, env, git }) => {
    const dir = path.join(agentOsHome, "worktrees", SESSION_A);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "keep.txt"), "mine\n");
    const calls = [];
    await assert.rejects(createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env, run: spyRun(calls) }), {
      status: 409,
      code: "worktree_failed",
      message: NO_REASON
    });
    assert.equal(await readFile(path.join(dir, "keep.txt"), "utf8"), "mine\n", "a folder that was there is left alone");
    assert.ok(!calls.some((call) => ["worktree", "reset", "branch"].includes(bare(call.args)[0])), "git was not asked to do anything");
    assert.equal(git(repo, "for-each-ref", "refs/heads/agentos/"), "");

    // A folder that appears between the check and git's add, and that git says already exists, is not this start's.
    await rm(dir, { recursive: true });
    const cleanup = [];
    const racing = async (folder, args, options) => {
      cleanup.push(bare(args));
      if (!bare(args).join(" ").startsWith("worktree add")) return runGit(folder, args, options);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "theirs.txt"), "theirs\n");
      return { code: 128, stdout: "", stderr: `fatal: '${dir}' already exists\n`, timedOut: false, ok: false };
    };
    await assert.rejects(createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env, run: racing }), /already exists/);
    assert.equal(await readFile(path.join(dir, "theirs.txt"), "utf8"), "theirs\n", "not removed by the clean-up");
    assert.ok(!cleanup.some((argv) => argv[0] === "worktree" && argv[1] === "remove"), "git was not asked to remove it");
    await rm(dir, { recursive: true });

    // A link at a copy's place: git would act on what it points to, so removeWorktree refuses before git runs.
    const own = path.join(home, "projects", "my-own-worktree");
    git(repo, "worktree", "add", own, "-b", "my-own-branch");
    await symlink(own, dir);
    const seen = [];
    await assert.rejects(removeWorktree({ path: dir, copyOf: repo, env, run: spyRun(seen) }), { status: 409, code: "worktree_remove_failed" });
    assert.equal(seen.length, 0, "git was not run at all");
    assert.ok(existsSync(path.join(own, "README.md")), "the person's own worktree is untouched");
    assert.equal((await lstat(dir)).isSymbolicLink(), true, "and the link was not followed or removed");
  });
});

test("M3: the empty hooks folder is checked before every use: a link to someone's hooks, or a file in it, is removed and the folder made again", GIT_ONLY, async () => {
  await withRepo(async ({ home, agentOsHome, repo, env, git }) => {
    const marks = path.join(home, "marks");
    const theirHooks = path.join(home, "their-hooks");
    await mkdir(marks, { recursive: true });
    await mkdir(theirHooks, { recursive: true });
    for (const name of ["reference-transaction", "post-index-change"]) {
      await writeFile(path.join(theirHooks, name), `#!/bin/sh\necho ran >> '${path.join(marks, name)}'\n`);
      await chmod(path.join(theirHooks, name), 0o755);
    }
    const hooks = path.join(agentOsHome, "empty-hooks");
    await mkdir(agentOsHome, { recursive: true });
    await symlink(theirHooks, hooks);
    // Control: git does run hooks from a link like that.
    git(repo, "-c", `core.hooksPath=${hooks}`, "branch", "control-branch");
    assert.deepEqual(await readdir(marks), ["reference-transaction"], "the control: the hook behind the link runs");
    await rm(path.join(marks, "reference-transaction"));

    const made = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env });
    assert.deepEqual(await readdir(marks), [], "no hook ran");
    const info = await lstat(hooks);
    assert.equal(info.isSymbolicLink(), false, "the link is gone");
    assert.equal(info.isDirectory(), true);
    assert.equal(info.mode & 0o777, 0o700);
    assert.deepEqual(await readdir(hooks), []);
    assert.deepEqual((await readdir(theirHooks)).sort(), ["post-index-change", "reference-transaction"], "what the link pointed to is untouched");

    // A file put into the folder is removed before the next use.
    await writeFile(path.join(hooks, "post-checkout"), "#!/bin/sh\nexit 0\n");
    await removeWorktree({ path: made.path, copyOf: repo, env });
    assert.deepEqual(await readdir(hooks), [], "the folder is empty again");
  });
});

test("M4: a ref nested below a name blocks that name, and so does another letter case where the disk ignores case", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    git(repo, "branch", "agentos/hermes-1/x");
    assert.equal(await nextBranch(repo, "hermes", { env }), "agentos/hermes-2", "agentos/hermes-1/x makes agentos/hermes-1 impossible");
    git(repo, "branch", "agentos/Cursor-1");
    const foldsCase = process.platform === "darwin" || process.platform === "win32";
    assert.equal(await nextBranch(repo, "cursor", { env }), foldsCase ? "agentos/cursor-2" : "agentos/cursor-1");
  });
});

// ---- fix round 2 ---------------------------------------------------------------------------------------------------

test("C3: Remove separate copy never runs a filter that a repository inside the copy configures, a moved submodule commit is still refused, and git's own check never gets to delete it", GIT_ONLY, async () => {
  await withRepo(async ({ home, repo, env, git }) => {
    const marks = path.join(home, "marks");
    await mkdir(marks, { recursive: true });
    const program = path.join(home, "nested-filter.sh");
    await writeFile(program, `#!/bin/sh\necho ran >> '${path.join(marks, "nested")}'\ncat\n`);
    await chmod(program, 0o755);
    // A library, and a project that records its commit as a submodule (a gitlink) at vendor/lib.
    const lib = path.join(home, "projects", "lib");
    await mkdir(lib, { recursive: true });
    git(lib, "init", "-q", "-b", "main");
    await writeFile(path.join(lib, "lib.txt"), "lib\n");
    git(lib, "add", "lib.txt");
    commit(git, lib, "lib");
    const libCommit = git(lib, "rev-parse", "HEAD").trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${libCommit},vendor/lib`);
    commit(git, repo, "add the submodule");
    const made = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env });
    const nested = path.join(made.path, "vendor", "lib");
    assert.deepEqual(await readdir(nested), [], "the submodule folder is empty in the copy");

    // The agent, writing only inside its own copy, makes that folder a repository of its own with a filter.
    const poison = async (folder) => {
      git(folder, "config", "filter.e.clean", `sh ${program}`);
      git(folder, "config", "filter.e.smudge", `sh ${program}`);
      await mkdir(path.join(folder, ".git", "info"), { recursive: true });
      await writeFile(path.join(folder, ".git", "info", "attributes"), "* filter=e\n");
      const later = new Date(Date.now() + 5000);
      for (const file of await readdir(folder)) if (file !== ".git") await utimes(path.join(folder, file), later, later);
    };
    git(nested, "init", "-q", "-b", "main");
    await writeFile(path.join(nested, "x.txt"), "x\n");
    git(nested, "add", "x.txt");
    commit(git, nested, "the agent's own repository");
    await poison(nested);
    // Control: a plain status in the copy goes into that repository and runs its filter.
    git(made.path, "status", "--porcelain");
    assert.deepEqual(await readdir(marks), ["nested"], "the control: plain git status ran the nested repository's filter");
    await rm(path.join(marks, "nested"));

    // A moved submodule commit (the nested repository is not at the recorded commit) is still refused, and nothing ran.
    await utimes(path.join(nested, "x.txt"), new Date(), new Date());
    await poison(nested);
    await assert.rejects(removeWorktree({ path: made.path, copyOf: repo, env }), { status: 409, code: "worktree_dirty", message: DIRTY });
    assert.deepEqual(await readdir(marks), [], "no filter of the nested repository ran");
    assert.ok(existsSync(path.join(nested, "x.txt")), "the copy is kept");

    // The nested repository at the recorded commit looks clean to us; git's own check then refuses a copy that holds a
    // populated submodule, and still nothing ran and nothing was removed.
    await rm(nested, { recursive: true, force: true });
    await mkdir(nested, { recursive: true });
    git(path.join(made.path, "vendor"), "clone", "-q", lib, "lib");
    await poison(nested);
    await assert.rejects(removeWorktree({ path: made.path, copyOf: repo, env }), { status: 409, code: "worktree_remove_failed" });
    assert.deepEqual(await readdir(marks), [], "git's own check ran no filter of the nested repository either");
    assert.ok(existsSync(path.join(nested, "lib.txt")), "and the copy is kept");
  });
});

test("I2: with core.ignoreStat on, or a file marked assume-unchanged or skip-worktree, Remove refuses and the edit stays", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    const edited = "an edit the agent made\n";

    // core.ignoreStat=true in the project's own config: the reset must not mark the files assume-unchanged.
    git(repo, "config", "core.ignoreStat", "true");
    const one = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env });
    assert.ok(!git(one.path, "ls-files", "-v").split("\n").some((line) => /^[a-z]/.test(line)), "the reset marked no file assume-unchanged");
    await writeFile(path.join(one.path, "README.md"), edited);
    await assert.rejects(removeWorktree({ path: one.path, copyOf: repo, env }), { status: 409, code: "worktree_dirty", message: DIRTY });
    assert.equal(await readFile(path.join(one.path, "README.md"), "utf8"), edited, "core.ignoreStat: the edit stays");
    git(repo, "config", "--unset", "core.ignoreStat");

    // A file marked assume-unchanged in the copy: a plain status can't see the edit, Remove refuses.
    const two = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_B, env });
    git(two.path, "update-index", "--assume-unchanged", "README.md");
    await writeFile(path.join(two.path, "README.md"), edited);
    assert.equal(git(two.path, "status", "--porcelain"), "", "precondition: a plain status shows nothing");
    await assert.rejects(removeWorktree({ path: two.path, copyOf: repo, env }), { status: 409, code: "worktree_dirty", message: DIRTY });
    assert.equal(await readFile(path.join(two.path, "README.md"), "utf8"), edited, "assume-unchanged: the edit stays");

    // The same for skip-worktree; a skip-worktree file that is not on disk has nothing to lose.
    const three = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_C, env });
    git(three.path, "update-index", "--skip-worktree", "README.md");
    await writeFile(path.join(three.path, "README.md"), edited);
    assert.equal(git(three.path, "status", "--porcelain"), "", "precondition: a plain status shows nothing");
    await assert.rejects(removeWorktree({ path: three.path, copyOf: repo, env }), { status: 409, code: "worktree_dirty", message: DIRTY });
    assert.equal(await readFile(path.join(three.path, "README.md"), "utf8"), edited, "skip-worktree: the edit stays");
    await rm(path.join(three.path, "README.md"));
    await removeWorktree({ path: three.path, copyOf: repo, env });
    assert.equal(existsSync(three.path), false, "a skip-worktree file that is not there does not keep the copy");
  });
});

test("M11: a cut-off add deletes a branch only when it is Agent OS's own fresh one, never one someone made on another commit", GIT_ONLY, async () => {
  await withRepo(async ({ repo, env, git }) => {
    await writeFile(path.join(repo, "second.txt"), "2\n");
    git(repo, "add", "second.txt");
    commit(git, repo, "second");
    const older = git(repo, "rev-parse", "HEAD~1").trim();
    // Someone makes the same branch on an older commit just before the add, and the add is cut off at 2 minutes.
    const cutOff = (folder, args, options) => {
      if (!bare(args).join(" ").startsWith("worktree add")) return runGit(folder, args, options);
      git(repo, "branch", "agentos/hermes-1", "HEAD~1");
      return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: true, ok: false });
    };
    await assert.rejects(createWorktree({ folder: repo, agentId: "hermes", sessionId: SESSION_A, env, run: cutOff }), {
      code: "worktree_failed",
      message: "Agent OS couldn't make the separate copy: git took longer than 2 minutes."
    });
    assert.equal(git(repo, "rev-parse", "agentos/hermes-1").trim(), older, "their branch stays");
  });
});

// ---- fix round 3 ---------------------------------------------------------------------------------------------------

test("I3: Remove refuses a copy holding commits that are on no branch or tag (a detached commit, an amend in a stopped rebase, a ref only in refs/worktree), and the commits stay reachable", GIT_ONLY, async () => {
  await withRepo(async ({ home, repo, env, git }) => {
    const refused = async (copy) => {
      await assert.rejects(removeWorktree({ path: copy.path, copyOf: repo, env }), { status: 409, code: "worktree_dirty", message: DIRTY });
      assert.ok(existsSync(copy.path), "the copy is kept");
    };

    // 1. A commit made on a detached HEAD.
    const one = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env });
    git(one.path, "checkout", "-q", "--detach");
    await writeFile(path.join(one.path, "detached.txt"), "d\n");
    git(one.path, "add", "detached.txt");
    commit(git, one.path, "a detached commit");
    const detached = git(one.path, "rev-parse", "HEAD").trim();
    assert.equal(git(one.path, "for-each-ref", "--contains", detached).trim(), "", "precondition: no branch or tag holds it");
    await refused(one);
    assert.equal(git(one.path, "cat-file", "-t", detached).trim(), "commit", "the commit is still there");
    assert.equal(git(one.path, "rev-parse", "HEAD").trim(), detached, "and HEAD is still on it");
    // Once it is on a branch, the copy goes and the commit stays on that branch.
    git(one.path, "branch", "keep-detached");
    await removeWorktree({ path: one.path, copyOf: repo, env });
    assert.equal(existsSync(one.path), false);
    assert.equal(git(repo, "rev-parse", "keep-detached").trim(), detached, "the commit is on its branch in the project");

    // 2. An amend inside a rebase stopped at `edit`, with a clean tree.
    const two = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_B, env });
    for (const name of ["one", "two"]) {
      await writeFile(path.join(two.path, `${name}.txt`), `${name}\n`);
      git(two.path, "add", `${name}.txt`);
      commit(git, two.path, `commit ${name}`);
    }
    const toEdit = path.join(home, "to-edit.sh");
    await writeFile(toEdit, `#!/bin/sh\nsed -e '1s/^pick/edit/' "$1" > "$1.new" && mv "$1.new" "$1"\n`);
    await chmod(toEdit, 0o755);
    const ident = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    try {
      execFileSync("git", ["-C", two.path, "rebase", "-q", "-i", "HEAD~2"], {
        env: { ...env, ...ident, GIT_SEQUENCE_EDITOR: toEdit, GIT_EDITOR: "true" },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      // git stops at the commit marked edit; whatever its exit code, the rebase is now stopped there
    }
    git(two.path, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--amend", "-m", "amended");
    assert.equal(git(two.path, "status", "--porcelain"), "", "precondition: the tree is clean");
    const amended = git(two.path, "rev-parse", "HEAD").trim();
    assert.equal(git(two.path, "for-each-ref", "--contains", amended).trim(), "", "precondition: the amended commit is on no branch");
    await refused(two);
    assert.equal(git(two.path, "cat-file", "-t", amended).trim(), "commit", "the amended commit is still there");

    // 3. A commit held only by a ref of the copy's own (refs/worktree/*), with HEAD back on the branch.
    const three = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_C, env });
    git(three.path, "checkout", "-q", "--detach");
    await writeFile(path.join(three.path, "kept.txt"), "k\n");
    git(three.path, "add", "kept.txt");
    commit(git, three.path, "kept only by a ref of this copy");
    const held = git(three.path, "rev-parse", "HEAD").trim();
    git(three.path, "update-ref", "refs/worktree/keep", held);
    git(three.path, "checkout", "-q", three.branch);
    assert.equal(git(three.path, "status", "--porcelain"), "", "precondition: the tree is clean");
    await refused(three);
    assert.equal(git(three.path, "rev-parse", "refs/worktree/keep").trim(), held, "the ref and its commit are still there");
  });
});

test("M14: Agent OS never prunes the project's worktrees: another worktree whose folder is missing keeps its record, after a failed start and after a removal", GIT_ONLY, async () => {
  await withRepo(async ({ home, agentOsHome, repo, env, git }) => {
    // The person's own worktree on a drive that is unplugged: registered with git, its folder away.
    const theirs = path.join(home, "projects", "on-the-usb-drive");
    git(repo, "worktree", "add", theirs, "-b", "their-branch");
    await rename(theirs, `${theirs}-unplugged`);
    const theirRecord = path.join(repo, ".git", "worktrees", "on-the-usb-drive");
    assert.ok(existsSync(theirRecord), "precondition: their record is there");
    const recordOf = (id) => path.join(repo, ".git", "worktrees", id);
    const calls = [];
    const noPrune = () => assert.ok(!calls.some((argv) => argv.includes("prune")), "git worktree prune never ran");
    // git that cannot drop a record itself (a failed `worktree remove`), so only Agent OS's own clean-up can.
    const stubborn = (folder, args, options) => {
      calls.push(bare(args));
      if (bare(args)[0] === "worktree" && bare(args)[1] === "remove") {
        return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: simulated", timedOut: false, ok: false });
      }
      return runGit(folder, args, options);
    };

    // 1. A start that fails after the copy was made (the reset fails): its copy, record and branch go; theirs stays.
    const failingReset = (folder, args, options) =>
      bare(args)[0] === "reset"
        ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: simulated reset", timedOut: false, ok: false })
        : stubborn(folder, args, options);
    await assert.rejects(createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env, run: failingReset }), /simulated reset/);
    assert.equal(existsSync(path.join(agentOsHome, "worktrees", SESSION_A)), false, "the copy's folder is gone");
    assert.equal(existsSync(recordOf(SESSION_A)), false, "Agent OS's own record is gone");
    assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/agentos/"), "", "and its branch");
    assert.ok(existsSync(theirRecord), "their record stays");
    noPrune();

    // 2. Remove for a copy whose folder AND record are both gone: nothing of it is left to drop, and theirs stays.
    const gone = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_B, env });
    await rm(gone.path, { recursive: true });
    await rm(recordOf(SESSION_B), { recursive: true });
    await removeWorktree({ path: gone.path, copyOf: repo, env, run: stubborn });
    assert.ok(existsSync(theirRecord), "their record stays");
    noPrune();

    // 3. Remove for a copy whose folder is gone but whose record is there and that git can't drop: only that record goes.
    const left = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_C, env });
    await rm(left.path, { recursive: true });
    assert.ok(existsSync(recordOf(SESSION_C)), "precondition: git still has its record");
    await removeWorktree({ path: left.path, copyOf: repo, env, run: stubborn });
    assert.equal(existsSync(recordOf(SESSION_C)), false, "Agent OS's own record is dropped");
    assert.ok(existsSync(theirRecord), "their record stays");
    noPrune();

    // 4. A record that names another place is never taken for the copy's.
    const other = path.join(repo, ".git", "worktrees", "somebody-else");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "gitdir"), `${path.join(home, "projects", "elsewhere", ".git")}\n`);
    const fourth = await createWorktree({ folder: repo, agentId: "codex", sessionId: SESSION_A, env });
    await rm(fourth.path, { recursive: true });
    await removeWorktree({ path: fourth.path, copyOf: repo, env, run: stubborn });
    assert.ok(existsSync(other) && existsSync(theirRecord), "records of other places stay");
    assert.equal(existsSync(recordOf(SESSION_A)), false);
  });
});

test("M6: the page waits a little longer than the server's own worst case for a folder check, a copy start and a removal", async () => {
  const source = await readFile(new URL("../src/sessionsApi.ts", import.meta.url), "utf8");
  for (const [key, value] of [["folderCheck", 22000], ["createCopy", 240000], ["removeWorktree", 90000]]) {
    assert.match(source, new RegExp(`\\b${key}: ${value}\\b`), `${key} is ${value} ms`);
  }
});

// ---- routes ----------------------------------------------------------------------------------------------------

async function withApp(manager, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
  try {
    return await fn(api);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const CHECK = { path: "/Users/you/projects/my-app", name: "my-app", git: true, branch: "agentos/codex-1", inUse: [] };

function routeManager() {
  const calls = [];
  const manager = {
    maxLive: 8,
    async folderCheck(input) {
      calls.push(["folderCheck", input]);
      return CHECK;
    },
    async create(input) {
      calls.push(["create", input]);
      return { id: SESSION_B, agentId: input.agentId };
    },
    async removeWorktree(id) {
      calls.push(["removeWorktree", id]);
      if (id === SESSION_C) throw sessionError(409, "worktree_dirty", DIRTY);
      return { removed: true };
    }
  };
  return { manager, calls };
}

test("routes: POST /api/sessions/folder-check, a separate copy only for copy: true, and DELETE /api/sessions/:id/worktree", async () => {
  const { manager, calls } = routeManager();
  await withEnvVars(MODE_KEYS, () =>
    withApp(manager, async (api) => {
      const checked = await api("POST", "/api/sessions/folder-check", { folder: CHECK.path, agentId: "codex", command: "/bin/sh" });
      assert.equal(checked.status, 200);
      assert.deepEqual(checked.json, CHECK);
      assert.deepEqual(calls.at(-1), ["folderCheck", { folder: CHECK.path, agentId: "codex" }], "only the folder and the agent reach the manager");

      const copy = await api("POST", "/api/sessions", { agentId: "codex", folder: CHECK.path, copy: true });
      assert.equal(copy.status, 201);
      assert.deepEqual(calls.at(-1), ["create", { agentId: "codex", folder: CHECK.path, copy: true }]);
      for (const value of ["true", 1, "yes", null, false]) {
        await api("POST", "/api/sessions", { agentId: "codex", folder: CHECK.path, copy: value });
        assert.deepEqual(calls.at(-1), ["create", { agentId: "codex", folder: CHECK.path }], `copy: ${JSON.stringify(value)} is not a yes`);
      }

      const removed = await api("DELETE", `/api/sessions/${SESSION_A}/worktree`);
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.json, { removed: true });
      assert.deepEqual(calls.at(-1), ["removeWorktree", SESSION_A]);
      const dirty = await api("DELETE", `/api/sessions/${SESSION_C}/worktree`);
      assert.equal(dirty.status, 409);
      assert.deepEqual(dirty.json, { error: "worktree_dirty", message: DIRTY });

      const before = calls.length;
      const bad = await api("DELETE", "/api/sessions/not-a-session/worktree");
      assert.equal(bad.status, 404);
      assert.equal(bad.json.error, "unknown_session");
      assert.equal(calls.length, before, "a bad id never reaches the manager");
    })
  );
});

test("routes: outside local mode the folder check and the copy removal don't exist, and nothing runs", async () => {
  const { manager, calls } = routeManager();
  await withEnvVars({ ...MODE_KEYS, DEMO_PUBLIC: "1" }, () =>
    withApp(manager, async (api) => {
      const checked = await api("POST", "/api/sessions/folder-check", { folder: CHECK.path, agentId: "codex" });
      assert.deepEqual({ status: checked.status, json: checked.json }, { status: 404, json: { error: "not_available" } });
      const copy = await api("POST", "/api/sessions", { agentId: "codex", folder: CHECK.path, copy: true });
      assert.deepEqual({ status: copy.status, json: copy.json }, { status: 404, json: { error: "not_available" } });
      const removed = await api("DELETE", `/api/sessions/${SESSION_A}/worktree`);
      assert.deepEqual({ status: removed.status, json: removed.json }, { status: 404, json: { error: "not_available" } });
    })
  );
  assert.deepEqual(calls, []);
});

// ---- the dialog's and the panel's words (src/ui, `import type` only) ---------------------------------------------

const check = (over = {}) => ({
  path: "/Users/you/projects/my-app",
  name: "my-app",
  git: true,
  branch: "agentos/codex-1",
  inUse: [{ id: SESSION_A, agentLabel: "Claude Code", title: "Claude Code · my-app" }],
  ...over
});
const inUse = (...labels) => labels.map((agentLabel, index) => ({ id: `id-${index}`, agentLabel, title: `${agentLabel} · my-app` }));

test("dialog logic: the offer shows only when a live session uses the folder, with the spec's branch words and the prototype's notes", () => {
  assert.equal(dialog.worktreeOffer(null, "codex"), null);
  assert.equal(dialog.worktreeOffer(check({ inUse: [] }), "codex"), null, "nobody uses the folder: no offer");
  assert.equal(dialog.worktreeOffer(check(), "openclaw"), null, "OpenClaw picks its own folder");
  assert.deepEqual(dialog.worktreeOffer(check(), "codex"), {
    title: "Claude Code already has a session in my-app",
    copyLabel: "Separate copy (new branch agentos/codex-1)",
    copyNote: "Agent OS makes a second checkout of my-app (a git worktree) on a new branch. Your files stay untouched until you merge it.",
    notGitNote: null
  });
  assert.equal(
    dialog.worktreeOffer(check({ inUse: inUse("Claude Code", "Codex", "Claude Code") }), "cursor").title,
    "Claude Code and Codex already have sessions in my-app",
    "each agent named once"
  );
  assert.equal(
    dialog.worktreeOffer(check({ inUse: inUse("Claude Code", "Codex", "Hermes") }), "cursor").title,
    "Claude Code, Codex and Hermes already have sessions in my-app"
  );
  assert.equal(dialog.worktreeOffer(check({ inUse: inUse("Codex", "Codex") }), "claude").title, "Codex already has a session in my-app");
  assert.deepEqual(dialog.worktreeOffer(check({ git: false, branch: null }), "codex"), {
    title: "Claude Code already has a session in my-app",
    copyLabel: null,
    copyNote: null,
    notGitNote: NOT_GIT
  });
  assert.deepEqual(
    dialog.worktreeOffer(check({ branch: null }), "codex"),
    { title: "Claude Code already has a session in my-app", copyLabel: null, copyNote: null, notGitNote: null },
    "git couldn't name a branch: no copy, and nothing untrue"
  );
  assert.equal(dialog.SAME_FOLDER_LABEL, "Same folder");
  assert.equal(dialog.RECOMMENDED, "Recommended");
  assert.equal(dialog.OVERWRITE_NOTE, "Two agents editing the same files can overwrite each other.");
  assert.equal(dialog.SAME_FOLDER_NOTE, "Both agents see and change the same files right now. Fine for reading and review.");
  assert.equal(dialog.NOT_GIT_NOTE, NOT_GIT);
});

test("panel logic: the copy line names the project, Remove separate copy only for an ended session in a copy, and its confirm words", () => {
  const s = (over = {}) => ({ status: "exited", copyOf: "/Users/you/projects/my-app", folderName: "my-app", branch: "agentos/codex-1", ...over });
  assert.equal(page.copyLine(s({ copyOf: null })), null);
  assert.equal(page.copyLine(s()), "Separate copy of my-app (a git worktree)");
  assert.equal(page.canRemoveCopy(s()), true);
  for (const status of ["starting", "live", "waiting", "idle", "held"]) assert.equal(page.canRemoveCopy(s({ status })), false, status);
  assert.equal(page.canRemoveCopy(s({ copyOf: null })), false, "no copy, or the server says it was removed");
  assert.equal(page.REMOVE_COPY_LABEL, "Remove separate copy");
  assert.equal(page.IGNORED_FILES_NOTE, IGNORED);
  assert.deepEqual(page.removeCopyConfirm(s()), {
    title: "Remove the separate copy of my-app?",
    lines: ["Its branch agentos/codex-1 stays in the project.", IGNORED]
  });
  assert.deepEqual(page.removeCopyConfirm(s({ branch: null })), { title: "Remove the separate copy of my-app?", lines: [IGNORED] });
});

test("dialog logic (fix round 1b): Start never makes a separate copy the person did not see offered", () => {
  const shown = (over = {}) => ({ key: "codex\n/Users/you/projects/my-app", result: check(over) });
  // The offer was on screen: the pick counts.
  assert.deepEqual(dialog.quickStartChoice(shown(), null, "codex", "copy"), { action: "start", copy: true }, "Separate copy picked");
  assert.deepEqual(dialog.quickStartChoice(shown(), null, "codex", "same"), { action: "start", copy: false }, "Same folder picked");
  assert.deepEqual(dialog.quickStartChoice(shown({ git: false, branch: null }), null, "codex", "copy"), { action: "start", copy: false }, "no copy to pick: not a git project");
  assert.deepEqual(dialog.quickStartChoice(shown({ inUse: [] }), null, "codex", "copy"), { action: "start", copy: false }, "nobody shares the folder");
  assert.deepEqual(dialog.quickStartChoice({ key: "k", result: null }, null, "codex", "copy"), { action: "start", copy: false }, "a check that failed offered nothing");
  assert.deepEqual(dialog.quickStartChoice(shown(), null, "openclaw", "copy"), { action: "start", copy: false }, "OpenClaw never gets a copy");

  // The check was still running when Start was pressed: a shared folder starts nothing, the offer is shown.
  assert.deepEqual(dialog.quickStartChoice(null, check(), "codex", "copy"), { action: "show-offer" }, "a shared git folder");
  assert.deepEqual(dialog.quickStartChoice(null, check(), "codex", "same"), { action: "show-offer" }, "the pick before the offer showed does not skip it");
  assert.deepEqual(dialog.quickStartChoice(null, check({ git: false, branch: null }), "codex", "copy"), { action: "show-offer" }, "a shared folder that isn't a git project says so first");
  assert.deepEqual(dialog.quickStartChoice(null, check({ branch: null }), "codex", "copy"), { action: "show-offer" }, "a shared folder git could not name a branch for");
  // Nobody shares the folder, or the check failed: it starts at once, in the folder, never as a copy.
  assert.deepEqual(dialog.quickStartChoice(null, check({ inUse: [] }), "codex", "copy"), { action: "start", copy: false });
  assert.deepEqual(dialog.quickStartChoice(null, null, "codex", "copy"), { action: "start", copy: false });
  assert.deepEqual(dialog.quickStartChoice(null, check(), "openclaw", "copy"), { action: "start", copy: false });
});
