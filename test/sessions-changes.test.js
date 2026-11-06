// The changes panel, server side (SP4, Task X7): the argv-only git runner
// (git.js), git status --porcelain=v2 and git diff --numstat read into a list
// of changed files (changes.js), the read-only diff of one file, the "files
// changed" recording markers, the session manager's poll (at the start, every
// 3 s while a session runs, soon after Claude's PostToolUse(Edit|Write) hook,
// one read at a time) and the two routes. Real git runs only inside temp
// repositories under a temp HOME, with GIT_CONFIG_NOSYSTEM=1, so neither the
// system's nor the person's git settings are read. The manager tests inject
// fakes for the terminal, so no agent and no terminal program ever starts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { requireLocalMode } from "../server/runtime/local-session.js";
import {
  CHANGES_MAX_FILES,
  CHANGES_POLL_MS,
  CHANGES_REFRESH_DEBOUNCE_MS,
  CHANGE_MISSING_MESSAGE,
  DIFF_MAX_BYTES,
  ENDED_READ_REUSE_MS,
  FILES_MARKER_GAP_MS,
  FILES_MARKER_MAX,
  GIT_UNAVAILABLE_LIMIT,
  addPendingMarker,
  filesMarker,
  filterOverrides,
  newPendingMarker,
  parseFilterConfig,
  parseGitVersion,
  parseNumstat,
  parsePorcelainV2,
  pendingToMarker,
  readChanges,
  readDiff
} from "../server/runtime/sessions/changes.js";
import { sessionError } from "../server/runtime/sessions/errors.js";
import { GIT_BASE_ARGS, GIT_LIMIT_MS, emptyHooksFolder, gitEnv, gitTopLevel, runGit } from "../server/runtime/sessions/git.js";
import { mapHookEvent } from "../server/runtime/sessions/hooks.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { FAKE_LOGIN_SHELL } from "./helpers/fake-agents.js";

const isWindows = process.platform === "win32";
// The system folders only: Node's own folder and Homebrew's can hold real agents.
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
const T0 = Date.parse("2026-10-29T09:00:00.000Z");
const AT0 = "2026-10-29T09:00:00.000Z";
const CLAUDE_UUID = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
const KNOWN_ID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
const OTHER_ID = "9d1e8b6a-2c3f-4a5b-8c7d-abcdefabcdef";
const CHANGE_MISSING = "That file isn't in this session's changes anymore.";
const UNKNOWN_SESSION = { error: "unknown_session", message: "That session doesn't exist anymore." };
const NOT_READ = { git: null, files: [], total: 0, at: null };
const NOT_TRACKED = { git: false, files: [], total: 0, at: null };
const GIT_CUT = Object.freeze({ code: null, stdout: "", stderr: "", timedOut: true, ok: false });
const GIT_NEVER_STARTED = Object.freeze({ code: null, stdout: "", stderr: "", timedOut: false, ok: false });
const LOCAL_MODE = {
  DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
  HERMES_AGENT_OS_PUBLIC_MODE: undefined
};
const FALLBACK_AGENTS = new Set(["hermes", "codex", "cursor"]);
const FAKE_MODES = {
  altScreen: false,
  bracketedPaste: false,
  mouseTracking: false,
  mouseEncoding: "default",
  focusReporting: false,
  cursorKeysApp: false,
  kittyFlags: 0
};
const HAS_GIT =
  !isWindows &&
  (() => {
    try {
      execFileSync("git", ["--version"], { env: { PATH: SYSTEM_PATH }, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
const SKIP_GIT = { skip: HAS_GIT ? false : "needs git in /usr/bin or /bin (macOS or Linux)" };

// ---- helpers ------------------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for condition");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// What runGit answers, for the injected runners.
function gitOk(stdout) {
  return { code: 0, stdout, stderr: "", timedOut: false, ok: true };
}

function untrackedList(count) {
  return Array.from({ length: count }, (_, i) => `? file-${String(i).padStart(4, "0")}.txt\0`).join("");
}

// Real git for the temp repositories: the system's git, no system or personal
// git settings, and a fixed name for commits.
function gitTestEnv(home) {
  return { PATH: SYSTEM_PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
}

function git(dir, home, ...args) {
  return execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Agent OS test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args
    ],
    { env: gitTestEnv(home), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

async function withEnvVars(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

// A temp AGENT_OS_HOME for one test (restored and removed when the test ends): every git call points
// core.hooksPath at <AGENT_OS_HOME>/empty-hooks (git.js), which a test must never make in the real data folder.
async function useTempAgentOsHome(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-changes-data-")));
  const saved = { AGENT_OS_HOME: process.env.AGENT_OS_HOME, HERMES_AGENT_OS_HOME: process.env.HERMES_AGENT_OS_HOME };
  process.env.AGENT_OS_HOME = dir;
  delete process.env.HERMES_AGENT_OS_HOME;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// A temp folder (canonical path) with a HOME inside it, removed after. AGENT_OS_HOME is a folder inside it too:
// every git call points core.hooksPath at <AGENT_OS_HOME>/empty-hooks (git.js), so a test never makes that
// folder in the real data folder.
async function withTempDirs(fn) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-changes-")));
  const home = path.join(base, "home");
  const agentOsHome = path.join(base, "agent-os-data");
  await mkdir(home);
  try {
    return await withEnvVars({ AGENT_OS_HOME: agentOsHome, HERMES_AGENT_OS_HOME: undefined }, () => fn({ base, home, agentOsHome }));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// A temp HOME with one project folder and a separate temp AGENT_OS_HOME (both
// canonical paths), local mode, W1's stand-in login shell and the system
// folders on PATH. Restored and removed after.
async function withSessionEnv(fn) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-changes-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-changes-data-")));
  const project = path.join(home, "projects", "demo");
  await mkdir(project, { recursive: true });
  try {
    return await withEnvVars(
      {
        ...LOCAL_MODE,
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
        HERMES_AGENT_OS_HOME: undefined,
        HERMES_HOME: undefined,
        HERMES_AGENT_OS_ENABLE_EXEC: undefined,
        SHELL: FAKE_LOGIN_SHELL,
        PATH: SYSTEM_PATH
      },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        return fn({ home, agentOsHome, project });
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
  }
}

// ---- injected fakes (the pattern of test/sessions-manager.test.js) --------------------------------

function fakePty(pid, options) {
  const dataListeners = new Set();
  const exitListeners = new Set();
  return {
    pid,
    opts: options,
    write() {},
    resize() {},
    kill() {},
    pause() {},
    resume() {},
    onData(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    exit(exitCode = 0, signal) {
      for (const cb of [...exitListeners]) cb({ exitCode, signal });
    }
  };
}

// The mirror's frozen API after Task X1b, with nothing on screen.
function fakeMirror(options) {
  return {
    opts: options,
    write() {},
    resize() {},
    async snapshot() {
      return { data: "", cols: options.cols, rows: options.rows, modes: { ...FAKE_MODES } };
    },
    setWriterAttached() {},
    onCountedOutput() {
      return () => {};
    },
    modes() {
      return { ...FAKE_MODES };
    },
    onModeChange() {
      return () => {};
    },
    screenText() {
      return "";
    },
    dispose() {}
  };
}

function fakeRecorder() {
  return { output() {}, marker() {}, resize() {}, async close() {} };
}

// What buildSessionProfile answers, without a login shell or a file. `env` is
// the session's own environment, which the manager hands to git.
function fakeProfile(input, env) {
  const { agentId, folder, kind, resume, sessionId, hook = null } = input;
  const claude = kind === "agent" && agentId === "claude";
  return {
    command: `/fake/bin/${agentId}`,
    args: kind === "update" ? ["update"] : [],
    cwd: folder || os.homedir(),
    env: { ...env },
    agentSessionId: claude ? resume?.agentSessionId || CLAUDE_UUID : null,
    settingsFile: null,
    softStop: null,
    resumeMode: kind === "update" ? null : FALLBACK_AGENTS.has(agentId) ? "fallback" : "id",
    folderShown: !(kind === "agent" && agentId === "openclaw"),
    notes: [],
    claude:
      claude && hook
        ? {
            hookUrl: `http://127.0.0.1:${hook.port}/hooks/sessions/${sessionId}`,
            hooksOff: { alerts: null, meter: null },
            statusLineFrom: null
          }
        : null
  };
}

async function fakeCheckFolder(input) {
  const home = await realpath(os.homedir());
  let real;
  try {
    real = await realpath(String(input || ""));
  } catch {
    return { ok: false, code: "missing", message: "That folder doesn't exist." };
  }
  if (!real.startsWith(home + path.sep)) {
    return { ok: false, code: "outside_home", message: "Pick a folder inside your home folder." };
  }
  return { ok: true, path: real, name: path.basename(real) };
}

function fakeWorld({ profileEnv = { TERM: "xterm-256color", PATH: SYSTEM_PATH }, ...over } = {}) {
  const world = { clock: T0, ptys: [], nextPid: 52000 };
  world.manager = createSessionManager({
    now: () => world.clock,
    spawn: async (options) => {
      const pty = fakePty(world.nextPid, options);
      world.nextPid += 1;
      world.ptys.push(pty);
      return pty;
    },
    buildProfile: async (input) => fakeProfile(input, profileEnv),
    recorderFactory: () => fakeRecorder(),
    mirrorFactory: (options) => fakeMirror(options),
    isExecutionAllowed: async () => true,
    checkFolder: fakeCheckFolder,
    ptyCheck: async () => ({ ok: true, reason: null }),
    detect: async (agentId) => ({ installed: true, path: `/fake/bin/${agentId}` }),
    resolveBrain: async () => null,
    readSettings: async () => ({ claudeFullscreen: false }),
    enforceCap: async () => ({ deleted: [] }),
    killTree: async () => {},
    getPort: () => 43123,
    newHookToken: () => "test-hook-token",
    transcriptExists: async () => false,
    loginEnv: async () => ({ PATH: SYSTEM_PATH }),
    ...over
  });
  return world;
}

async function endAll(world) {
  for (const pty of world.ptys) pty.exit(0);
  await waitFor(async () => (await world.manager.list({ includeUpdate: true, liveOnly: true })).length === 0);
  await sleep(50); // the last meta.json writes
}

// The sessions router on a real port, mounted the way server/index.js mounts it.
async function withRouter(manager, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url) => {
    const started = Date.now();
    const response = await fetch(`${base}${url}`);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, json, ms: Date.now() - started };
  };
  try {
    return await fn(get);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---- the git runner -----------------------------------------------------------------------------

test("runGit: argv only (git -C <folder>, then the fixed options that keep git from locking the index or running a file monitor), Agent OS's own variables removed, git's error text kept short, ok by exit code, and never the server's environment", async (t) => {
  await useTempAgentOsHome(t);
  const calls = [];
  const fakeCli = (answer) => async (command, args, options) => {
    calls.push({ command, args, options });
    return answer;
  };
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/you",
    LANG: "en_US.UTF-8",
    EDITOR: "vim",
    LC_ALL: "en_US.UTF-8",
    AGENT_OS_TOKEN: "server-secret",
    AGENT_OS_HOOK_TOKEN: "hook-secret",
    AGENT_OS_SESSION_ID: KNOWN_ID,
    HERMES_AGENT_OS_ADMIN_TOKEN: "admin-secret",
    // The person's own values are replaced, never kept (N1).
    GIT_ALLOW_PROTOCOL: "https:ssh:ext",
    GIT_NO_LAZY_FETCH: "0"
  };
  assert.deepEqual(GIT_BASE_ARGS, [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "diff.autoRefreshIndex=false"
  ]);
  assert.equal(Object.isFrozen(GIT_BASE_ARGS), true);

  const result = await runGit("/repo/sub", ["status", "--porcelain=v2"], {
    env,
    run: fakeCli({ ok: true, code: 0, aborted: false, stdout: "out", stderr: "warn" })
  });
  assert.deepEqual(result, { code: 0, stdout: "out", stderr: "warn", timedOut: false, ok: true });
  assert.equal(calls[0].command, "git");
  // Hooks off for every call: the repository's own hooks folder is replaced by an empty one Agent OS owns (K12a).
  assert.deepEqual(calls[0].args, [
    "-C",
    "/repo/sub",
    ...GIT_BASE_ARGS,
    "-c",
    `core.hooksPath=${path.join(process.env.AGENT_OS_HOME, "empty-hooks")}`,
    "status",
    "--porcelain=v2"
  ]);
  const expectedEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/you",
    LANG: "en_US.UTF-8",
    EDITOR: "vim",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    // git never fetches a missing object and is allowed no transport at all (N1).
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "none"
  };
  assert.deepEqual(calls[0].options.env, expectedEnv);
  assert.deepEqual(gitEnv(env), expectedEnv);
  assert.equal(env.AGENT_OS_TOKEN, "server-secret", "the session's environment itself is not changed");
  assert.ok(calls[0].options.signal instanceof AbortSignal, "every run has a time limit");
  assert.equal(calls[0].options.captureStderr, true, "git's error text is kept for a message that quotes it");

  // No environment at all: only git's three, never the server's own.
  await withEnvVars({ AGENT_OS_TOKEN: "must-not-leak" }, async () => {
    await runGit("/repo", ["status"], { run: fakeCli({ ok: true, code: 0, aborted: false, stdout: "" }) });
  });
  assert.deepEqual(calls[1].options.env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "none",
    LC_ALL: "C"
  });

  // okCodes decides ok; an answer without stderr reads as ""; a long error text is cut to 4096 characters.
  assert.deepEqual(
    await runGit("/repo", ["diff", "--no-index"], { env, okCodes: [0, 1], run: fakeCli({ ok: false, code: 1, aborted: false, stdout: "d" }) }),
    { code: 1, stdout: "d", stderr: "", timedOut: false, ok: true }
  );
  assert.deepEqual(
    await runGit("/repo", ["status"], {
      env,
      run: fakeCli({ ok: false, code: 128, aborted: false, stdout: "", stderr: "fatal: not a git repository" })
    }),
    { code: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false, ok: false }
  );
  const long = await runGit("/repo", ["worktree", "list"], { env, run: fakeCli({ ok: false, code: 128, aborted: false, stdout: "", stderr: "x".repeat(5000) }) });
  assert.equal(long.stderr.length, 4096);
  // A runner that throws is an answer too.
  assert.deepEqual(
    await runGit("/repo", ["status"], {
      env,
      run: async () => {
        throw new Error("spawn EAGAIN");
      }
    }),
    { code: null, stdout: "", stderr: "", timedOut: false, ok: false }
  );
});

test("Review Focus 4 (a big or slow git folder), part 1: every git run is cut at 5 s and answers timedOut with what it had", async (t) => {
  await useTempAgentOsHome(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(GIT_LIMIT_MS, 5000);
  let aborted = false;
  let started = false;
  // Stands in for a git status that would take 8 s.
  const slowCli = (_command, _args, options) =>
    new Promise((resolve) => {
      started = true;
      const timer = setTimeout(() => resolve({ ok: true, code: 0, aborted: false, stdout: "late", stderr: "" }), 8000);
      options.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          clearTimeout(timer);
          resolve({ ok: false, code: null, aborted: true, stdout: "partial", stderr: "" });
        },
        { once: true }
      );
    });
  let answer = null;
  const running = runGit("/repo", ["status"], { env: {}, run: slowCli }).then((value) => {
    answer = value;
  });
  // runGit checks the empty hooks folder (real file reads) before it starts git.
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(GIT_LIMIT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answer, null, "still running at 4.999 s");
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  await running;
  assert.equal(aborted, true, "the run was told to stop (runCli then kills its process tree)");
  assert.deepEqual(answer, { code: null, stdout: "partial", stderr: "", timedOut: true, ok: false });
});

// ---- reading git's answers -----------------------------------------------------------------------

test("parsePorcelainV2: changed, added, deleted, renamed, conflicted and untracked entries, paths with spaces, header and ignored lines skipped", () => {
  const text = [
    "# branch.oid 0b038f6110db7d3ba7e5944405e3d1b736e80c41",
    "# branch.head main",
    "1 .M N... 100644 100644 100644 4cb29ea 4cb29ea src/app.js",
    "1 A. N... 000000 100644 100644 0000000 7898192 new file.txt",
    "1 .D N... 100644 100644 000000 4cb29ea 4cb29ea gone.txt",
    "1 MD N... 100644 100644 000000 4cb29ea 7898192 half gone.txt",
    "1 AD N... 000000 100644 000000 0000000 7898192 added then deleted.txt",
    "1 .T N... 100644 100644 120000 4cb29ea 4cb29ea link.txt",
    "2 RM N... 100644 100644 100644 de98044 de98044 R100 docs/new name.md",
    "docs/old name.md",
    "2 C. N... 100644 100644 100644 de98044 de98044 C75 copy.txt",
    "orig.txt",
    "u UU N... 100644 100644 100644 100644 4cb29ea 7898192 de98044 both.txt",
    "? notes/todo list.txt",
    "! ignored.log",
    ""
  ].join("\0");
  assert.deepEqual(parsePorcelainV2(text), [
    { path: "src/app.js", status: "modified" },
    { path: "new file.txt", status: "added" },
    { path: "gone.txt", status: "deleted" },
    { path: "half gone.txt", status: "deleted" },
    { path: "added then deleted.txt", status: "other" },
    { path: "link.txt", status: "modified" },
    { path: "docs/new name.md", status: "renamed", oldPath: "docs/old name.md" },
    { path: "copy.txt", status: "added", oldPath: "orig.txt" },
    { path: "both.txt", status: "conflicted" },
    { path: "notes/todo list.txt", status: "untracked" }
  ]);
  assert.deepEqual(parsePorcelainV2(""), []);
  assert.deepEqual(parsePorcelainV2("1 .M short\0garbage\0"), [], "a line without all its fields is not a change");
});

test("parseNumstat: line counts by path, '-' for a binary file, the rename form (counts, then the old and the new path), and a tab inside a name", () => {
  const text = ["3\t1\tsrc/app.js", "-\t-\timage.png", "0\t0\t", "docs/old name.md", "docs/new name.md", "12\t0\tdir with space/a\tb.txt", ""].join("\0");
  assert.deepEqual(
    [...parseNumstat(text)],
    [
      ["src/app.js", { added: 3, removed: 1 }],
      ["image.png", { added: null, removed: null }],
      ["docs/new name.md", { added: 0, removed: 0 }],
      ["dir with space/a\tb.txt", { added: 12, removed: 0 }]
    ]
  );
  assert.equal(parseNumstat("").size, 0);
});

test("filesMarker: never for the first read, only files whose counts changed (staging or a file leaving the list is not a change), at most 20 with `more` counting the rest", () => {
  const at1 = AT0;
  const at2 = "2026-10-29T09:00:03.000Z";
  const file = (name, added, removed, status = "modified") => ({ path: name, status, added, removed });
  const previous = { git: true, files: [file("a.txt", 1, 0), file("b.txt", 2, 2), file("gone.txt", 5, 0)], total: 3, at: at1 };
  assert.equal(FILES_MARKER_MAX, 20);
  assert.equal(filesMarker(null, previous), null);
  assert.equal(filesMarker(NOT_READ, previous), null, "the first read after a start is the baseline");
  assert.equal(filesMarker({ git: false, files: [], total: 0, at: at1 }, previous), null, "a folder that just became a git project starts a new baseline");
  assert.equal(filesMarker(previous, { ...previous, at: at2 }), null, "nothing changed");
  assert.equal(filesMarker(previous, { git: false, files: [], total: 0, at: at2 }), null);
  assert.equal(
    filesMarker(previous, { git: true, files: [file("a.txt", 1, 0, "added"), file("b.txt", 2, 2)], total: 2, at: at2 }),
    null,
    "staging with the same counts, and a file that left the list, are not changes"
  );
  const next = { git: true, files: [file("a.txt", 3, 0), file("b.txt", 2, 2), file("c.txt", null, null, "untracked")], total: 3, at: at2 };
  assert.deepEqual(filesMarker(previous, next), {
    at: at2,
    type: "files",
    files: [
      { path: "a.txt", added: 3, removed: 0 },
      { path: "c.txt", added: null, removed: null }
    ],
    more: 0
  });
  const many = { git: true, files: Array.from({ length: 25 }, (_, i) => file(`f${String(i).padStart(2, "0")}.txt`, i + 1, 0)), total: 25, at: at2 };
  const marker = filesMarker(previous, many);
  assert.equal(marker.files.length, FILES_MARKER_MAX);
  assert.equal(marker.files[0].path, "f00.txt");
  assert.equal(marker.more, 5);
});

test("readChanges with real git: the whole repository from any folder in it, paths from its top level, line counts for edits, renames, untracked text and binary files, and a file named HEAD", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "repo");
    const plain = path.join(base, "plain");
    await mkdir(path.join(repo, "app", "src"), { recursive: true });
    await mkdir(plain);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, "README.md"), "one\ntwo\nthree\n");
    await writeFile(path.join(repo, "keep.txt"), "a\nb\nc\nd\n");
    await writeFile(path.join(repo, "app", "src", "main.js"), "let x = 1;\n");
    git(repo, home, "add", "-A");
    git(repo, home, "commit", "-qm", "start");
    await writeFile(path.join(repo, "README.md"), "one\nTWO\nthree\nfour\n");
    git(repo, home, "mv", "keep.txt", "kept.txt");
    await writeFile(path.join(repo, "HEAD"), "not a revision\n");
    await writeFile(path.join(repo, "app", "notes with space.txt"), "x\ny");
    await writeFile(path.join(repo, "app", "logo.bin"), Buffer.from([0, 1, 2, 3]));
    const env = gitTestEnv(home);

    assert.deepEqual(await readChanges(plain, { env, now: () => T0 }), { git: false, files: [], total: 0, at: AT0 });
    assert.equal(await gitTopLevel(plain, { env }), null);
    assert.equal(await gitTopLevel(path.join(repo, "app", "src"), { env }), repo);

    const fromSubfolder = await readChanges(path.join(repo, "app", "src"), { env, now: () => T0 });
    assert.deepEqual(fromSubfolder, {
      git: true,
      files: [
        { path: "README.md", status: "modified", added: 2, removed: 1 },
        { path: "kept.txt", status: "renamed", added: 0, removed: 0, oldPath: "keep.txt" },
        { path: "HEAD", status: "untracked", added: 1, removed: 0 },
        { path: "app/logo.bin", status: "untracked", added: null, removed: null },
        { path: "app/notes with space.txt", status: "untracked", added: 2, removed: 0 }
      ],
      total: 5,
      at: AT0
    });
    assert.deepEqual(await readChanges(repo, { env, now: () => T0 }), fromSubfolder, "the session's folder or its repository's top: the same answer");
  });
});

test("readChanges with real git in a repository with no commit yet: a staged file counts against nothing plus its later edits, and its diff shows the whole file", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "fresh");
    await mkdir(repo);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, "first.txt"), "a\nb\n");
    git(repo, home, "add", "first.txt");
    await writeFile(path.join(repo, "first.txt"), "a\nb\nc\n");
    await writeFile(path.join(repo, "loose.txt"), "z\n");
    const env = gitTestEnv(home);
    assert.deepEqual(await readChanges(repo, { env, now: () => T0 }), {
      git: true,
      files: [
        { path: "first.txt", status: "added", added: 3, removed: 0 },
        { path: "loose.txt", status: "untracked", added: 1, removed: 0 }
      ],
      total: 2,
      at: AT0
    });
    const whole = await readDiff(repo, { path: "first.txt", status: "added" }, { env });
    assert.match(whole.diff, /^\+a$/m);
    assert.match(whole.diff, /^\+c$/m);
    assert.equal(whole.cut, false);
  });
});

test("git never runs the person's helpers or takes the index lock: a file monitor, an external diff and a text converter set in the repository stay off, and the index file is not rewritten", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "repo");
    const ranLog = path.join(base, "helper-ran.log");
    const helper = path.join(base, "helper.sh");
    await mkdir(repo);
    await writeFile(helper, `#!/bin/sh\necho "$0 $*" >> '${ranLog}'\nexit 0\n`);
    await chmod(helper, 0o700);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, "notes.txt"), "one\n");
    git(repo, home, "add", "notes.txt");
    git(repo, home, "commit", "-qm", "start");
    git(repo, home, "config", "core.fsmonitor", helper);
    git(repo, home, "config", "diff.external", helper);
    git(repo, home, "config", "diff.conv.textconv", helper);
    await writeFile(path.join(repo, ".gitattributes"), "*.txt diff=conv\n");
    await writeFile(path.join(repo, "notes.txt"), "one\ntwo\n");
    const index = path.join(repo, ".git", "index");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(index, old, old);
    const indexBefore = (await stat(index)).mtimeMs;
    const env = { ...gitTestEnv(home), GIT_EXTERNAL_DIFF: helper };

    const result = await readChanges(repo, { env, now: () => T0 });
    assert.deepEqual(result.files, [
      { path: "notes.txt", status: "modified", added: 1, removed: 0 },
      { path: ".gitattributes", status: "untracked", added: 1, removed: 0 }
    ]);
    assert.match((await readDiff(repo, result.files[0], { env })).diff, /^\+two$/m);
    assert.match((await readDiff(repo, result.files[1], { env })).diff, /^\+\*\.txt diff=conv$/m);
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "no helper ran");
    assert.equal((await stat(index)).mtimeMs, indexBefore, "the index file was not rewritten");
  });
});

// A hook that writes a marker whenever git rewrites the index (post-index-change), in the repository's own
// .git/hooks and in another folder that the repository's core.hooksPath names (the way a project, or an agent,
// can set one up).
async function plantIndexHooks(repo, home, marker) {
  const script = `#!/bin/sh\necho "ran $0" >> '${marker}'\nexit 0\n`;
  const named = path.join(path.dirname(repo), "project-hooks");
  await mkdir(named, { recursive: true });
  for (const dir of [path.join(repo, ".git", "hooks"), named]) {
    await writeFile(path.join(dir, "post-index-change"), script);
    await chmod(path.join(dir, "post-index-change"), 0o755);
  }
  git(repo, home, "config", "core.hooksPath", named);
}

async function indexState(repo) {
  const file = path.join(repo, ".git", "index");
  const info = await stat(file);
  return { ino: info.ino, mtimeMs: info.mtimeMs, bytes: (await readFile(file)).toString("hex") };
}

test("C1 with real git: a tracked file that was only touched (same content, newer time) does not make the poll or a diff rewrite .git/index, take index.lock or run the repository's post-index-change hook, while plain git does (a control)", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "repo");
    const marker = path.join(base, "hook-ran.log");
    await mkdir(repo);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, "a.txt"), "same\n");
    await writeFile(path.join(repo, "b.txt"), "one\n");
    git(repo, home, "add", "-A");
    git(repo, home, "commit", "-qm", "start");
    await plantIndexHooks(repo, home, marker);
    // b.txt really changed; a.txt only got a newer time, which makes it stat-dirty but unchanged.
    await writeFile(path.join(repo, "b.txt"), "one\ntwo\n");
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(repo, "a.txt"), later, later);
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(path.join(repo, ".git", "index"), old, old);
    const before = await indexState(repo);
    const env = gitTestEnv(home);

    // The 3 s poll's read, a repeat of it, and the diff of the touched file and of the changed one.
    for (let poll = 0; poll < 2; poll += 1) {
      const result = await readChanges(repo, { env, now: () => T0 });
      assert.deepEqual(result.files, [{ path: "b.txt", status: "modified", added: 1, removed: 0 }], "the touched file is not a change");
    }
    assert.equal((await readDiff(repo, { path: "a.txt", status: "modified" }, { env })).diff, "");
    assert.match((await readDiff(repo, { path: "b.txt", status: "modified" }, { env })).diff, /^\+two$/m);

    await assert.rejects(stat(marker), { code: "ENOENT" }, "the repository's hook never ran");
    await assert.rejects(stat(path.join(repo, ".git", "index.lock")), { code: "ENOENT" }, "no index.lock is left behind");
    assert.deepEqual(await indexState(repo), before, ".git/index: the same file (inode), the same time, the same bytes");

    // Control: plain git with its own diff does refresh the index and run the hook for this very state.
    git(repo, home, "diff", "--numstat", "HEAD", "--");
    assert.match(await readFile(marker, "utf8"), /^ran /, "plain git ran the planted hook");
    assert.notEqual((await indexState(repo)).ino, before.ino, "plain git rewrote the index");
  });
});

test("C1 with real git: every call of runGit has hooks off, even one that does rewrite the index (git update-index --refresh runs post-index-change in plain git, and not through runGit)", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home, agentOsHome }) => {
    const repo = path.join(base, "repo");
    const marker = path.join(base, "hook-ran.log");
    await mkdir(repo);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, "a.txt"), "same\n");
    git(repo, home, "add", "-A");
    git(repo, home, "commit", "-qm", "start");
    await plantIndexHooks(repo, home, marker);
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(repo, "a.txt"), later, later);
    const env = gitTestEnv(home);

    const refreshed = await runGit(repo, ["update-index", "--refresh"], { env });
    assert.equal(refreshed.ok, true, refreshed.stderr);
    await assert.rejects(stat(marker), { code: "ENOENT" }, "no hook ran through runGit");
    // The folder the hooks come from is Agent OS's own, empty and private.
    const hooks = path.join(agentOsHome, "empty-hooks");
    assert.deepEqual(await readdir(hooks), []);
    if (!isWindows) assert.equal((await stat(hooks)).mode & 0o777, 0o700);

    // Control: the same call in plain git runs the hook.
    await utimes(path.join(repo, "a.txt"), new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    git(repo, home, "update-index", "--refresh");
    assert.match(await readFile(marker, "utf8"), /^ran /, "plain git ran the planted hook");
  });
});

test("C1: runGit does not start git when the empty hooks folder can't be made (it answers 'never started'), and callers that arrive together share one check of that folder", async (t) => {
  const data = await useTempAgentOsHome(t);
  const sharedChecks = await Promise.all(Array.from({ length: 12 }, () => emptyHooksFolder()));
  assert.deepEqual(new Set(sharedChecks), new Set([path.join(data, "empty-hooks")]));
  assert.deepEqual(await readdir(path.join(data, "empty-hooks")), []);

  // AGENT_OS_HOME below a plain file: the folder can't be made.
  const blocker = path.join(data, "blocker");
  await writeFile(blocker, "x");
  process.env.AGENT_OS_HOME = path.join(blocker, "data");
  let started = false;
  const answer = await runGit("/repo", ["status"], {
    env: {},
    run: async () => {
      started = true;
      return { ok: true, code: 0, aborted: false, stdout: "" };
    }
  });
  assert.equal(started, false, "git never started without its empty hooks folder");
  assert.deepEqual(answer, { code: null, stdout: "", stderr: "", timedOut: false, ok: false });
});

test("readChanges answers: 128 means not a git project, a git that never started or answered anything else is git_unavailable, a cut run is git_timeout, a failed list is git_failed, and 250 changes list 200 with the full total", async () => {
  assert.equal(CHANGES_POLL_MS, 3000);
  assert.equal(CHANGES_MAX_FILES, 200);
  assert.equal(CHANGES_REFRESH_DEBOUNCE_MS, 300);
  assert.equal(CHANGE_MISSING_MESSAGE, CHANGE_MISSING);
  const firstAnswer = (answer) => async (_folder, args) => (args[0] === "rev-parse" ? answer : gitOk(""));
  assert.deepEqual(
    await readChanges("/somewhere", {
      run: firstAnswer({ code: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false, ok: false }),
      now: () => T0
    }),
    { git: false, files: [], total: 0, at: AT0 }
  );
  const macStandIn = { code: 1, stdout: "", stderr: "xcode-select: note: No developer tools were found, requesting install.", timedOut: false, ok: false };
  for (const answer of [GIT_NEVER_STARTED, macStandIn]) {
    await assert.rejects(readChanges("/somewhere", { run: firstAnswer(answer) }), { code: "git_unavailable" });
  }
  await assert.rejects(readChanges("/somewhere", { run: firstAnswer(GIT_CUT) }), { code: "git_timeout" });

  const listAnswer = (answer) => async (_folder, args) =>
    args[0] === "rev-parse" ? gitOk("/repo\n") : args[0] === "status" ? answer : gitOk("");
  await assert.rejects(readChanges("/repo", { run: listAnswer(GIT_CUT) }), { code: "git_timeout" });
  await assert.rejects(
    readChanges("/repo", { run: listAnswer({ code: 128, stdout: "", stderr: "fatal: index file corrupt", timedOut: false, ok: false }) }),
    { code: "git_failed" }
  );

  const name = (i) => `f${String(i).padStart(3, "0")}.txt`;
  const status = Array.from({ length: 250 }, (_, i) => `1 .M N... 100644 100644 100644 4cb29ea 4cb29ea ${name(i)}\0`).join("");
  const numstat = Array.from({ length: 250 }, (_, i) => `1\t1\t${name(i)}\0`).join("");
  const seen = [];
  const env = { PATH: "/usr/bin" };
  const run = async (folder, args, options) => {
    seen.push({ folder, args, env: options?.env });
    if (args[0] === "rev-parse") return gitOk("/repo\n");
    // `git config --get-regexp` exits 1 when no filter is configured.
    if (args[0] === "config") return { code: 1, stdout: "", stderr: "", timedOut: false, ok: true };
    return gitOk(args[0] === "status" ? status : numstat);
  };
  const result = await readChanges("/repo/sub", { env, run, now: () => T0 });
  assert.equal(result.git, true);
  assert.equal(result.total, 250);
  assert.equal(result.files.length, CHANGES_MAX_FILES);
  assert.deepEqual(result.files[0], { path: "f000.txt", status: "modified", added: 1, removed: 1 });
  assert.equal(result.files[199].path, "f199.txt");
  assert.equal(result.at, AT0);
  assert.deepEqual(
    seen.map(({ folder, args }) => [folder, args]),
    [
      ["/repo/sub", ["rev-parse", "--show-toplevel"]],
      ["/repo", ["config", "--get-regexp", "-z", "^filter\\..+\\.(clean|smudge|process|required)$"]],
      ["/repo", ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"]],
      [
        "/repo",
        ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--submodule=short", "HEAD", "--"]
      ]
    ]
  );
  assert.ok(seen.every((call) => call.env === env), "every run gets the session's own environment, as given");
});

test("readDiff with real git: one file's read-only diff (modified, renamed, untracked, binary), glob characters taken literally, a long diff cut at 256 KB on a line end, and a path outside the changes refused before git runs", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "repo");
    await mkdir(repo);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, "notes.txt"), "one\n");
    await writeFile(path.join(repo, "st*r.txt"), "glob\n");
    await writeFile(path.join(repo, "star.txt"), "plain\n");
    await writeFile(path.join(repo, "old.md"), "a\nb\nc\nd\ne\n");
    await writeFile(path.join(repo, "big.txt"), "x\n");
    git(repo, home, "add", "-A");
    git(repo, home, "commit", "-qm", "start");
    await writeFile(path.join(repo, "notes.txt"), "one\ntwo\n");
    await writeFile(path.join(repo, "st*r.txt"), "glob\nchanged\n");
    await writeFile(path.join(repo, "star.txt"), "plain\nchanged\n");
    git(repo, home, "mv", "old.md", "new.md");
    await writeFile(path.join(repo, "new.md"), "a\nb\nc\nd\nE\n");
    await writeFile(path.join(repo, "big.txt"), Array.from({ length: 30000 }, (_, i) => `line ${String(i).padStart(6, "0")}\n`).join(""));
    await writeFile(path.join(repo, "todo.txt"), "first\nsecond\n");
    await writeFile(path.join(repo, "pic.bin"), Buffer.from([0x89, 0x50, 0, 0, 1, 2]));
    const env = gitTestEnv(home);

    const modified = await readDiff(repo, { path: "notes.txt", status: "modified" }, { env });
    assert.equal(modified.path, "notes.txt");
    assert.match(modified.diff, /^diff --git a\/notes\.txt b\/notes\.txt$/m);
    assert.match(modified.diff, /^\+two$/m);
    assert.equal(modified.binary, false);
    assert.equal(modified.cut, false);

    const glob = await readDiff(repo, { path: "st*r.txt", status: "modified" }, { env });
    assert.match(glob.diff, /^\+changed$/m);
    assert.doesNotMatch(glob.diff, /star\.txt/, "the * is part of the name, never a pattern");

    const renamed = await readDiff(repo, { path: "new.md", status: "renamed", oldPath: "old.md" }, { env });
    assert.match(renamed.diff, /^rename from old\.md$/m);
    assert.match(renamed.diff, /^rename to new\.md$/m);
    assert.match(renamed.diff, /^\+E$/m);

    const untracked = await readDiff(repo, { path: "todo.txt", status: "untracked" }, { env });
    assert.match(untracked.diff, /^\+first$/m);
    assert.match(untracked.diff, /^\+second$/m);

    const binary = await readDiff(repo, { path: "pic.bin", status: "untracked" }, { env });
    assert.equal(binary.binary, true);
    assert.equal(binary.cut, false);

    const big = await readDiff(repo, { path: "big.txt", status: "modified" }, { env });
    assert.equal(DIFF_MAX_BYTES, 256 * 1024);
    assert.equal(big.cut, true);
    assert.ok(Buffer.byteLength(big.diff, "utf8") <= DIFF_MAX_BYTES, "at most 256 KB");
    assert.ok(big.diff.endsWith("\n"), "cut on a line end");
    assert.match(big.diff, /^\+line 000000$/m);

    await writeFile(path.join(repo, "gone.txt"), "soon gone\n");
    await unlink(path.join(repo, "gone.txt"));
    await assert.rejects(readDiff(repo, { path: "gone.txt", status: "untracked" }, { env }), {
      status: 404,
      code: "change_missing",
      message: CHANGE_MISSING
    });

    const noGit = async () => {
      throw new Error("git must not run for this path");
    };
    for (const bad of ["", "/etc/passwd", "../outside.txt", "docs/../../outside.txt", "a\0b.txt", "C:\\Windows\\win.ini", "..\\outside.txt"]) {
      await assert.rejects(readDiff(repo, { path: bad, status: "modified" }, { env, run: noGit }), { status: 404, code: "change_missing" }, JSON.stringify(bad));
    }
    await assert.rejects(readDiff(repo, { path: "new.md", status: "renamed", oldPath: "../old.md" }, { env, run: noGit }), {
      status: 404,
      code: "change_missing"
    });
    await assert.rejects(readDiff(repo, null, { env, run: noGit }), { status: 404, code: "change_missing" });
  });
});

// ---- the manager's poll and the routes -----------------------------------------------------------

test("Review Focus 4 (a big or slow git folder), part 2: one read at a time per session, the list stops at 200 files with the full total, a cut read keeps the last result, and GET /api/sessions/:id/changes answers at once", async () => {
  await withSessionEnv(async ({ project }) => {
    const statusRuns = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const slowGit = async (_folder, args) => {
      if (args[0] === "rev-parse") return gitOk(`${project}\n`);
      if (args[0] !== "status") return gitOk("");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Stands in for a git status that takes 8 s in a huge folder: it ends
        // only when the test says so.
        return await new Promise((resolve) => statusRuns.push({ release: resolve }));
      } finally {
        inFlight -= 1;
      }
    };
    const world = fakeWorld({ runGit: slowGit, changesPollMs: 5 });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    await withRouter(world.manager, async (get) => {
      await waitFor(() => statusRuns.length === 1);
      await sleep(80); // 16 poll intervals
      assert.equal(statusRuns.length, 1, "no second read starts while the first one runs");
      const early = await get(`/api/sessions/${id}/changes`);
      assert.equal(early.status, 200);
      assert.deepEqual(early.json, NOT_READ, "nothing read yet");
      assert.ok(early.ms < 1000, `answered at once (${early.ms} ms)`);

      statusRuns[0].release(gitOk(untrackedList(1000)));
      await waitFor(() => statusRuns.length === 2);
      const during = await get(`/api/sessions/${id}/changes`);
      assert.ok(during.ms < 1000, `answered at once while git runs (${during.ms} ms)`);
      assert.equal(during.json.git, true);
      assert.equal(during.json.total, 1000);
      assert.equal(during.json.files.length, CHANGES_MAX_FILES);
      assert.deepEqual(during.json.files[0], { path: "file-0000.txt", status: "untracked", added: null, removed: null });
      assert.equal(during.json.files[199].path, "file-0199.txt");

      // The second read is cut at its limit: the panel keeps the first result and the poll goes on.
      statusRuns[1].release(GIT_CUT);
      await waitFor(() => statusRuns.length === 3);
      assert.deepEqual((await get(`/api/sessions/${id}/changes`)).json, during.json);
      assert.equal(maxInFlight, 1, "never two git status runs at once");

      world.ptys[0].exit(0);
      await waitFor(async () => (await world.manager.get(id)).status === "exited");
      statusRuns[2].release(gitOk(""));
      await sleep(80);
      assert.equal(statusRuns.length, 3, "no read after the session ended");
    });
  });
});

test("Claude's PostToolUse(Edit|Write) hook reads the changes soon: a burst of edits makes one read, edits during a read make one more right after it, and other hooks read nothing", async () => {
  await withSessionEnv(async ({ project }) => {
    let statusCalls = 0;
    let hold = null;
    const countingGit = async (_folder, args) => {
      if (args[0] === "rev-parse") return gitOk(`${project}\n`);
      if (args[0] === "status") {
        statusCalls += 1;
        if (hold) await hold.promise;
      }
      return gitOk("");
    };
    const world = fakeWorld({ runGit: countingGit, changesPollMs: 60000 }); // no timed poll during this test
    const { id } = await world.manager.create({ agentId: "claude", folder: project });
    await waitFor(() => statusCalls === 1); // the baseline read at the start
    const edit = mapHookEvent({
      hook_event_name: "PostToolUse",
      session_id: CLAUDE_UUID,
      tool_name: "Edit",
      tool_input: { file_path: path.join(project, "a.txt") }
    });
    assert.equal(edit.refreshChanges, true);
    world.manager.onHook(id, edit);
    world.manager.onHook(id, edit);
    world.manager.onHook(id, edit);
    await sleep(CHANGES_REFRESH_DEBOUNCE_MS + 250);
    assert.equal(statusCalls, 2, "three quick edits, one read");

    hold = deferred();
    world.manager.onHook(id, edit);
    await waitFor(() => statusCalls === 3); // that read now runs, and waits
    world.manager.onHook(id, edit);
    world.manager.onHook(id, edit);
    const release = hold;
    hold = null;
    release.resolve();
    await waitFor(() => statusCalls === 4);
    await sleep(CHANGES_REFRESH_DEBOUNCE_MS + 250);
    assert.equal(statusCalls, 4, "edits during a read make exactly one more read, right after it");

    world.manager.onHook(id, mapHookEvent({ hook_event_name: "Stop", session_id: CLAUDE_UUID }));
    world.manager.onHook(id, mapHookEvent({ hook_event_name: "UserPromptSubmit", session_id: CLAUDE_UUID, prompt: "hi" }));
    await sleep(CHANGES_REFRESH_DEBOUNCE_MS + 250);
    assert.equal(statusCalls, 4, "only PostToolUse asks for a read");
    await endAll(world);
  });
});

test("with real git: the first read is the baseline, an edit adds one files changed marker (in meta.json too), diff answers only files in the changes, and an ended session is read once, with the login environment", SKIP_GIT, async () => {
  await withSessionEnv(async ({ home, agentOsHome, project }) => {
    git(project, home, "init", "-q");
    await writeFile(path.join(project, "notes.txt"), "one\n");
    await writeFile(path.join(project, "other.txt"), "same\n");
    git(project, home, "add", "-A");
    git(project, home, "commit", "-qm", "start");
    const envs = [];
    const countingGit = (folder, args, options) => {
      envs.push(options?.env);
      return runGit(folder, args, options);
    };
    const world = fakeWorld({
      runGit: countingGit,
      changesPollMs: 50,
      profileEnv: { ...gitTestEnv(home), FAKE_PROFILE_MARK: "session" },
      loginEnv: async () => ({ ...gitTestEnv(home), FAKE_LOGIN_MARK: "login" })
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    const first = await waitFor(async () => {
      const result = await world.manager.changes(id);
      return result.git === true ? result : null;
    });
    assert.deepEqual(first.files, []);
    assert.equal(first.total, 0);

    await writeFile(path.join(project, "notes.txt"), "one\ntwo\nthree\n");
    const second = await waitFor(async () => {
      const result = await world.manager.changes(id);
      return result.files.length === 1 ? result : null;
    });
    assert.deepEqual(second.files, [{ path: "notes.txt", status: "modified", added: 2, removed: 0 }]);
    const fileMarkers = async () => (await world.manager.markers(id)).filter((marker) => marker.type === "files");
    const [marker] = await waitFor(async () => {
      const found = await fileMarkers();
      return found.length ? found : null;
    });
    assert.deepEqual(marker.files, [{ path: "notes.txt", added: 2, removed: 0 }]);
    assert.equal(marker.more, 0);
    assert.equal(typeof marker.at, "string");
    await sleep(250); // about five more reads, nothing new
    assert.equal((await fileMarkers()).length, 1, "the baseline and unchanged reads add no marker");
    const onDisk = await waitFor(async () => {
      const meta = JSON.parse(await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8"));
      const found = (meta.markers || []).filter((entry) => entry.type === "files");
      return found.length ? found : null;
    });
    assert.deepEqual(onDisk[0].files, marker.files);

    const shown = await world.manager.diff(id, "notes.txt");
    assert.equal(shown.path, "notes.txt");
    assert.equal(shown.binary, false);
    assert.equal(shown.cut, false);
    assert.match(shown.diff, /^\+two$/m);
    for (const wanted of ["other.txt", "../outside.txt", "", 42, undefined]) {
      await assert.rejects(world.manager.diff(id, wanted), { status: 404, code: "change_missing", message: CHANGE_MISSING }, String(wanted));
    }
    await assert.rejects(world.manager.changes(OTHER_ID), { status: 404, code: "unknown_session" });
    await assert.rejects(world.manager.diff("not-a-session", "notes.txt"), { status: 404, code: "unknown_session" });
    assert.ok(envs.length > 0 && envs.every((env) => env?.FAKE_PROFILE_MARK === "session"), "a live session's git runs get its own environment");

    world.ptys[0].exit(0);
    await waitFor(async () => (await world.manager.get(id)).status === "exited");
    await sleep(100); // a read that was running finishes
    const runsAtEnd = envs.length;
    await sleep(250);
    assert.equal(envs.length, runsAtEnd, "no git run after the session ended");
    const ended = await world.manager.changes(id);
    assert.deepEqual(ended.files, second.files, "an ended session is read once, fresh");
    const endedRuns = envs.slice(runsAtEnd);
    assert.ok(endedRuns.length > 0 && endedRuns.every((env) => env?.FAKE_LOGIN_MARK === "login"), "with the login-shell environment, never the server's own");
  });
});

test("a session without a folder of its own is never read: OpenClaw (its folder is set by OpenClaw) and an update session answer git false, and git never runs", async () => {
  await withSessionEnv(async ({ project }) => {
    let calls = 0;
    const world = fakeWorld({
      runGit: async () => {
        calls += 1;
        return gitOk("");
      },
      changesPollMs: 5
    });
    const claw = await world.manager.create({ agentId: "openclaw" });
    const update = await world.manager.createUpdateSession({ agentId: "hermes", folder: project });
    await sleep(60);
    assert.equal(calls, 0);
    assert.deepEqual(await world.manager.changes(claw.id), NOT_TRACKED);
    assert.deepEqual(await world.manager.changes(update.id), NOT_TRACKED);
    await endAll(world);
  });
});

test("git that cannot start (not installed, or macOS asking to install its developer tools) is tried three times in a row, then given up for the session: the answer is git false and nothing more runs", async () => {
  await withSessionEnv(async ({ project }) => {
    let calls = 0;
    const world = fakeWorld({
      runGit: async () => {
        calls += 1;
        return GIT_NEVER_STARTED;
      },
      changesPollMs: 5
    });
    const { id } = await world.manager.create({ agentId: "hermes", folder: project });
    await waitFor(() => calls === GIT_UNAVAILABLE_LIMIT);
    await sleep(60);
    assert.equal(GIT_UNAVAILABLE_LIMIT, 3);
    assert.equal(calls, 3, "asked three times, never again");
    assert.deepEqual(await world.manager.changes(id), { git: false, files: [], total: 0, at: AT0 });
    await endAll(world);
  });
});

test("the two routes: the manager's answers as they are, with no-store; diff takes one path from the query; a bad id or a path outside the changes is 404; outside local mode neither exists", async () => {
  await withEnvVars(LOCAL_MODE, async () => {
    const calls = [];
    const result = { git: true, files: [{ path: "a b.txt", status: "modified", added: 1, removed: 0 }], total: 1, at: AT0 };
    const shown = { path: "a b.txt", diff: "diff --git a/a b.txt b/a b.txt\n", binary: false, cut: false };
    const manager = {
      maxLive: 8,
      isLive: () => true,
      async changes(id) {
        calls.push(["changes", id]);
        if (id !== KNOWN_ID) throw sessionError(404, "unknown_session", "That session doesn't exist anymore.");
        return result;
      },
      async diff(id, file) {
        calls.push(["diff", id, file]);
        if (file !== "a b.txt") throw sessionError(404, "change_missing", CHANGE_MISSING);
        return shown;
      }
    };
    await withRouter(manager, async (get) => {
      const listed = await get(`/api/sessions/${KNOWN_ID}/changes`);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.json, result);
      assert.equal(listed.headers.get("cache-control"), "no-store");

      const one = await get(`/api/sessions/${KNOWN_ID}/changes/diff?path=${encodeURIComponent("a b.txt")}`);
      assert.equal(one.status, 200);
      assert.deepEqual(one.json, shown);
      assert.equal(one.headers.get("cache-control"), "no-store");

      for (const query of ["?path=..%2F..%2Fetc%2Fpasswd", "?path=a&path=b", "", "?path[x]=1"]) {
        const refused = await get(`/api/sessions/${KNOWN_ID}/changes/diff${query}`);
        assert.equal(refused.status, 404, query);
        assert.deepEqual(refused.json, { error: "change_missing", message: CHANGE_MISSING }, query);
      }
      assert.deepEqual(
        calls.filter(([name]) => name === "diff").map(([, , file]) => file),
        ["a b.txt", "../../etc/passwd", "", "", ""],
        "a repeated or nested path reaches the manager as empty"
      );

      assert.deepEqual((await get(`/api/sessions/${OTHER_ID}/changes`)).json, UNKNOWN_SESSION);
      const before = calls.length;
      for (const url of ["/api/sessions/not-a-uuid/changes", `/api/sessions/${KNOWN_ID.toUpperCase()}/changes/diff?path=a`]) {
        const bad = await get(url);
        assert.equal(bad.status, 404, url);
        assert.deepEqual(bad.json, UNKNOWN_SESSION, url);
      }
      assert.equal(calls.length, before, "a malformed id never reaches the manager");

      await withEnvVars({ DEMO_PUBLIC: "1" }, async () => {
        for (const url of [`/api/sessions/${KNOWN_ID}/changes`, `/api/sessions/${KNOWN_ID}/changes/diff?path=a%20b.txt`]) {
          const hidden = await get(url);
          assert.equal(hidden.status, 404, url);
          assert.deepEqual(hidden.json, { error: "not_available" });
        }
      });
      assert.equal(calls.length, before, "outside local mode the manager is never asked");
    });
  });
});

// ---- fix round 1: filters, environment, 128, gaps, sharing, markers ------------------------------

// A scripted git: rev-parse answers the project folder, `config` has no filters,
// status lists one modified file with its numstat. `over` replaces any of them.
// The git subcommand of a call: the arguments after any leading `-c name=value`
// pairs (the form used for a git older than 2.31).
function subcommandOf(args) {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index];
}

const NEW_GIT_VERSION = "git version 2.39.5 (Apple Git-154)\n";

// `--version` answers a git that reads settings from the environment (2.31+)
// unless a test says otherwise.
function scriptedGit(project, over = {}) {
  const none = { code: 1, stdout: "", stderr: "", timedOut: false, ok: true };
  return async (folder, args, options) => {
    const name = subcommandOf(args);
    const handler = over[name];
    if (handler) {
      const answered = await handler(folder, args, options);
      if (answered !== undefined) return answered;
    }
    if (name === "rev-parse") return gitOk(`${project}\n`);
    if (name === "--version") return gitOk(NEW_GIT_VERSION);
    if (name === "config") return none;
    if (name === "status") return gitOk("1 .M N... 100644 100644 100644 4cb29ea 4cb29ea kept.txt\0");
    if (name === "diff") return gitOk("2\t1\tkept.txt\0");
    return gitOk("");
  };
}

const EDIT_HOOK = () =>
  mapHookEvent({ hook_event_name: "PostToolUse", session_id: CLAUDE_UUID, tool_name: "Edit", tool_input: { file_path: "/x/a.txt" } });

test("S2: gitEnv also drops what would send git to another repository or make it run something of the person's (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_EXTERNAL_DIFF, GIT_PAGER, GIT_ASKPASS, settings given in the environment), keeps harmless variables, and adds a call's own settings last", async (t) => {
  await useTempAgentOsHome(t);
  const dropped = {
    GIT_DIR: "/elsewhere/.git",
    GIT_WORK_TREE: "/elsewhere",
    GIT_INDEX_FILE: "/elsewhere/index",
    GIT_OBJECT_DIRECTORY: "/elsewhere/objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/other/objects",
    GIT_COMMON_DIR: "/elsewhere/common",
    GIT_NAMESPACE: "ns",
    GIT_PREFIX: "sub/",
    GIT_EXTERNAL_DIFF: "/bin/evil-diff",
    GIT_PAGER: "evil-pager",
    GIT_CONFIG_PARAMETERS: "'core.pager=evil'",
    GIT_CONFIG: "/dev/null", // the old one-file form: it would blind the filter list (N3)
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.pager",
    GIT_CONFIG_VALUE_0: "evil",
    GIT_CONFIG_KEY_1: "filter.x.clean",
    GIT_CONFIG_VALUE_1: "evil",
    GIT_ASKPASS: "/bin/askpass"
  };
  const kept = { PATH: "/usr/bin:/bin", HOME: "/Users/you", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Someone" };
  const own = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "none", LC_ALL: "C" };
  assert.deepEqual(gitEnv({ ...kept, ...dropped }), { ...kept, ...own });
  // The call's own settings come after the person's were removed: numbered from 0,
  // a name with "=" and an empty value as given, anything that is not a [key, value] pair ignored.
  assert.deepEqual(
    gitEnv({ ...kept, ...dropped }, [["filter.a=b.clean", ""], ["filter.a=b.required", "false"], "junk", ["x", 1]]),
    {
      ...kept,
      ...own,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "filter.a=b.clean",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "filter.a=b.required",
      GIT_CONFIG_VALUE_1: "false"
    }
  );
  // runGit hands them to the call, with the session's variables cleaned the same way.
  const seen = [];
  await runGit("/repo", ["status"], {
    env: dropped,
    config: [["a.b", "c"]],
    run: async (_command, _args, options) => {
      seen.push(options);
      return { ok: true, code: 0, aborted: false, stdout: "" };
    }
  });
  assert.deepEqual(seen[0].env, { ...own, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" });
});

// A repository with a clean filter and a process filter planted in its
// configuration after the first commit (the way a prompt-injected agent would
// do it), three changed files, and a control: plain git runs both helpers
// here. The log of helper runs is empty when this returns.
async function plantedFilterRepo(base, home) {
  const repo = path.join(base, "repo");
  const ranLog = path.join(base, "filter-ran.log");
  const cleanHelper = path.join(base, "clean.sh");
  const processHelper = path.join(base, "process.sh");
  await mkdir(repo);
  await writeFile(cleanHelper, `#!/bin/sh\necho "clean" >> '${ranLog}'\ncat\n`);
  await writeFile(processHelper, `#!/bin/sh\necho "process" >> '${ranLog}'\nexit 1\n`);
  await chmod(cleanHelper, 0o700);
  await chmod(processHelper, 0o700);
  git(repo, home, "init", "-q");
  await writeFile(path.join(repo, ".gitattributes"), "*.dat filter=evilclean\n*.proc filter=evilproc\n");
  await writeFile(path.join(repo, "a.dat"), "one\n");
  await writeFile(path.join(repo, "b.proc"), "one\n");
  git(repo, home, "add", "-A");
  git(repo, home, "commit", "-qm", "start");
  // After the commit: plant the drivers in the repository's configuration, then edit tracked files.
  git(repo, home, "config", "filter.evilclean.clean", cleanHelper);
  git(repo, home, "config", "filter.evilclean.smudge", cleanHelper);
  git(repo, home, "config", "filter.evilclean.required", "true");
  git(repo, home, "config", "filter.evilproc.process", processHelper);
  await writeFile(path.join(repo, "a.dat"), "one\ntwo\n");
  await writeFile(path.join(repo, "b.proc"), "one\ntwo\nthree\n");
  await writeFile(path.join(repo, "new.dat"), "fresh\n");

  // The control: plain git does run both helpers here (numstat is what needs the file's content).
  try {
    git(repo, home, "diff", "--numstat", "HEAD", "--");
  } catch {
    // a failing process filter may make git say so; only the log matters
  }
  const control = await readFile(ranLog, "utf8");
  assert.match(control, /^clean$/m, "control: plain git runs the clean filter");
  assert.match(control, /^process$/m, "control: plain git runs the process filter");
  await unlink(ranLog);
  return { repo, ranLog, env: gitTestEnv(home) };
}

test("S1 with real git: a clean filter and a process filter set in the repository's configuration never run during a poll, a numstat or a diff (a control shows plain git does run them), and the files still show as changed", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const { repo, ranLog, env } = await plantedFilterRepo(base, home);
    // The real runGit is used, and this git (2.31 or newer) takes the settings from the environment.
    const seen = [];
    const run = async (folder, args, options) => {
      seen.push({ args, options });
      return runGit(folder, args, options);
    };
    const result = await readChanges(repo, { env, now: () => T0, run });
    const statusCall = seen.find((call) => subcommandOf(call.args) === "status");
    assert.equal(statusCall.args[0], "status", "the environment form: no -c pairs");
    assert.equal(statusCall.options.config.length, 8, "two drivers, four settings each");
    assert.deepEqual(result.files, [
      { path: "a.dat", status: "modified", added: 1, removed: 0 },
      { path: "b.proc", status: "modified", added: 2, removed: 0 },
      { path: "new.dat", status: "untracked", added: 1, removed: 0 }
    ]);
    const shown = [];
    for (const file of result.files) shown.push(await readDiff(repo, file, { env }));
    assert.match(shown[0].diff, /^\+two$/m);
    assert.match(shown[1].diff, /^\+three$/m);
    assert.match(shown[2].diff, /^\+fresh$/m);
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "no filter ran during the poll, the numstat or the diffs");
  });
});

test("S1 with real git: a filter whose name holds an = sign and a dot is switched off too (the settings go through the environment, not -c name=value)", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "repo");
    const ranLog = path.join(base, "filter-ran.log");
    const helper = path.join(base, "clean.sh");
    await mkdir(repo);
    await writeFile(helper, `#!/bin/sh\necho "clean" >> '${ranLog}'\ncat\n`);
    await chmod(helper, 0o700);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, ".gitattributes"), "*.dat filter=ev=il.v2\n");
    await writeFile(path.join(repo, "a.dat"), "one\n");
    git(repo, home, "add", "-A");
    git(repo, home, "commit", "-qm", "start");
    git(repo, home, "config", "filter.ev=il.v2.clean", helper);
    git(repo, home, "config", "filter.ev=il.v2.required", "true");
    await writeFile(path.join(repo, "a.dat"), "one\ntwo\n");
    const env = gitTestEnv(home);

    try {
      git(repo, home, "diff", "--numstat", "HEAD", "--");
    } catch {
      // only the log matters
    }
    assert.match(await readFile(ranLog, "utf8"), /^clean$/m, "control: plain git runs this filter");
    await unlink(ranLog);

    const result = await readChanges(repo, { env, now: () => T0 });
    assert.deepEqual(result.files, [{ path: "a.dat", status: "modified", added: 1, removed: 0 }]);
    assert.match((await readDiff(repo, result.files[0], { env })).diff, /^\+two$/m);
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "the filter with = in its name did not run");
  });
});

test("S1: every configured filter driver is switched off in the environment of each git call of a read and of a diff, except an lfs driver that holds exactly git-lfs's standard values", async () => {
  const record = (key, value) => (value === null ? `${key}\0` : `${key}\n${value}\0`);
  const lfsStandard = [
    record("filter.lfs.clean", "git-lfs clean -- %f"),
    record("filter.lfs.smudge", "git-lfs smudge -- %f"),
    record("filter.lfs.process", "git-lfs filter-process"),
    record("filter.lfs.required", "true")
  ].join("");
  const evil = [
    record("filter.evil.clean", "/tmp/evil.sh"),
    record("filter.ev=il.v2.process", "/tmp/p.sh"),
    record("filter.ev=il.v2.required", "true")
  ].join("");
  const off = (name) => [
    [`filter.${name}.clean`, ""],
    [`filter.${name}.smudge`, ""],
    [`filter.${name}.process`, ""],
    [`filter.${name}.required`, "false"]
  ];
  const listing = (text) => ({
    config: async () => (text === "" ? { code: 1, stdout: "", stderr: "", timedOut: false, ok: true } : gitOk(text))
  });
  // Runs one read and returns the options of every call, by subcommand.
  const optionsOf = async (text) => {
    const seen = [];
    const base = scriptedGit("/repo", listing(text));
    const run = async (folder, args, options) => {
      seen.push({ args, options });
      return base(folder, args, options);
    };
    await readChanges("/repo", { run, now: () => T0 });
    return { seen, call: (name) => seen.find(({ args }) => subcommandOf(args) === name) };
  };
  const statusConfig = async (text) => (await optionsOf(text)).call("status").options.config;

  // The list is asked for with git's own read-only command; the probe and the list carry no settings.
  // The version is read because there is something to switch off (this git reads settings from the environment).
  const standardAndEvil = await optionsOf(lfsStandard + evil);
  assert.deepEqual(
    standardAndEvil.seen.map(({ args }) => args[0]),
    ["rev-parse", "config", "--version", "status", "diff"]
  );
  assert.deepEqual(standardAndEvil.call("config").args, ["config", "--get-regexp", "-z", "^filter\\..+\\.(clean|smudge|process|required)$"]);
  assert.deepEqual(standardAndEvil.call("config").options.okCodes, [0, 1], "exit 1 means no filter is configured");
  assert.equal(standardAndEvil.call("rev-parse").options.config, undefined);
  assert.equal(standardAndEvil.call("config").options.config, undefined);
  // Standard lfs stays; the others are switched off, whatever their names hold.
  const expected = [...off("evil"), ...off("ev=il.v2")];
  assert.deepEqual(standardAndEvil.call("status").options.config, expected, "status");
  assert.deepEqual(standardAndEvil.call("diff").options.config, expected, "numstat");
  assert.equal(subcommandOf(standardAndEvil.call("status").args), standardAndEvil.call("status").args[0], "no -c pairs in front of the subcommand");

  // Any other lfs value (even one extra command) switches lfs off like the rest.
  const changedClean = [record("filter.lfs.clean", "git-lfs clean -- %f; touch /tmp/x"), ...lfsStandard.split("\0").slice(1, 4).map((entry) => `${entry}\0`)].join("");
  assert.deepEqual(await statusConfig(changedClean), off("lfs"));
  assert.deepEqual(await statusConfig(lfsStandard + record("filter.lfs.clean", "evil.sh")), off("lfs"), "a second value too");
  const noValue = lfsStandard.replace(record("filter.lfs.required", "true"), record("filter.lfs.required", null));
  assert.deepEqual(await statusConfig(noValue), off("lfs"), "a key without a value is not 'true'");
  assert.deepEqual(await statusConfig(lfsStandard.replace("required\ntrue", "required\nyes")), off("lfs"));
  // Only the exact name "lfs" is trusted.
  assert.deepEqual(await statusConfig(lfsStandard.replaceAll("filter.lfs.", "filter.LFS.")), off("LFS"));
  // No filter at all: nothing is added, and git's version is not even asked for.
  const noFilters = await optionsOf("");
  assert.deepEqual(noFilters.call("status").options.config, []);
  assert.deepEqual(noFilters.call("status").args.slice(0, 1), ["status"]);
  assert.equal(noFilters.call("--version"), undefined);
  // Standard lfs alone: nothing to switch off either.
  assert.equal((await optionsOf(lfsStandard)).call("--version"), undefined);

  // A diff is switched off the same way (tracked and untracked).
  const diffSeen = [];
  const base = scriptedGit("/repo", { ...listing(evil), "--literal-pathspecs": async () => gitOk("diff text\n") });
  await readDiff("/repo", { path: "kept.txt", status: "modified" }, {
    run: async (folder, args, options) => {
      diffSeen.push({ args, options });
      return base(folder, args, options);
    }
  });
  const trackedDiff = diffSeen.find(({ args }) => args.includes("diff"));
  assert.deepEqual(trackedDiff.options.config, [...off("evil"), ...off("ev=il.v2")]);
  assert.ok(trackedDiff.args.includes("--ignore-submodules=dirty"));

  // The parser: the variable is what follows the last dot; unrelated keys are ignored.
  const parsed = parseFilterConfig(record("filter.a.b.clean", "x") + record("filter.a.b.required", null) + record("core.pager", "y"));
  assert.deepEqual([...parsed], [["a.b", { clean: ["x"], smudge: [], process: [], required: [null] }]]);
  assert.deepEqual(filterOverrides(record("filter.a.b.clean", "x")), off("a.b"));

  // More drivers than can be switched off through the environment, or a list that does not load: nothing runs.
  const many = Array.from({ length: 201 }, (_, i) => record(`filter.d${i}.clean`, "x")).join("");
  const calls = [];
  const noRun = async (folder, args, options) => {
    calls.push(args[0]);
    return scriptedGit("/repo", listing(many))(folder, args, options);
  };
  await assert.rejects(readChanges("/repo", { run: noRun }), { code: "git_failed" });
  assert.deepEqual(calls, ["rev-parse", "config"], "no status after a list that cannot be switched off");
  await assert.rejects(
    readChanges("/repo", { run: scriptedGit("/repo", { config: async () => ({ code: 128, stdout: "", stderr: "fatal: bad config line", timedOut: false, ok: false }) }) }),
    { code: "git_failed" }
  );
  await assert.rejects(readChanges("/repo", { run: scriptedGit("/repo", { config: async () => GIT_CUT }) }), { code: "git_timeout" });
  // A diff that cannot list the filters shows nothing.
  await assert.rejects(
    readDiff("/repo", { path: "kept.txt", status: "modified" }, { run: scriptedGit("/repo", { config: async () => GIT_CUT }) }),
    { status: 404, code: "change_missing" }
  );
});

// ---- S1b: an older git ---------------------------------------------------------------------------

const OLD_LISTING = "filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.smudge\ngit-lfs smudge -- %f\0filter.lfs.process\ngit-lfs filter-process\0filter.lfs.required\ntrue\0filter.evil.clean\n/tmp/evil.sh\0";
const OLD_PAIRS = ["-c", "filter.evil.clean=", "-c", "filter.evil.smudge=", "-c", "filter.evil.process=", "-c", "filter.evil.required=false"];

// A runner that records every call, answering from scriptedGit.
function recordingGit(base) {
  const seen = [];
  const run = async (folder, args, options) => {
    seen.push({ args, options, name: subcommandOf(args) });
    return base(folder, args, options);
  };
  return { run, seen, names: () => seen.map((call) => call.name), call: (name) => seen.find((entry) => entry.name === name) };
}

test("S1b: git's version comes from `git --version` (once per runner, and only when a filter has to be switched off); 2.31 and newer take the settings from the environment, anything older or unreadable takes -c pairs", async () => {
  assert.deepEqual(parseGitVersion("git version 2.39.5 (Apple Git-154)\n"), { major: 2, minor: 39 });
  assert.deepEqual(parseGitVersion("git version 2.30.2"), { major: 2, minor: 30 });
  assert.deepEqual(parseGitVersion("git version 2.45.1.windows.1"), { major: 2, minor: 45 });
  assert.deepEqual(parseGitVersion("git version 3.0.0"), { major: 3, minor: 0 });
  assert.equal(parseGitVersion(""), null);
  assert.equal(parseGitVersion(undefined), null);
  assert.equal(parseGitVersion("xcode-select: note: No developer tools were found, requesting install."), null);

  const evil = "filter.evil.clean\n/tmp/evil.sh\0";
  // Which form the status call used: "env" (settings in options.config), "argv" (-c pairs), or "none".
  const formFor = async (versionAnswer) => {
    const git = recordingGit(scriptedGit("/repo", { config: async () => gitOk(evil), "--version": async () => versionAnswer }));
    await readChanges("/repo", { run: git.run });
    const status = git.call("status");
    if (status.args[0] === "-c") return "argv";
    return status.options.config.length > 0 ? "env" : "none";
  };
  for (const [text, form] of [
    ["git version 2.31.0\n", "env"],
    ["git version 2.39.5 (Apple Git-154)\n", "env"],
    ["git version 2.100.0\n", "env"],
    ["git version 3.0.0\n", "env"],
    ["git version 2.30.9\n", "argv"],
    ["git version 2.4.0\n", "argv"], // numbers, not text: 4 is less than 31
    ["git version 1.9.1\n", "argv"]
  ]) {
    assert.equal(await formFor(gitOk(text)), form, text);
  }
  // A version that cannot be read (cut, never started, odd text, a non-zero exit) counts as older.
  for (const answer of [GIT_CUT, GIT_NEVER_STARTED, gitOk("no version here\n"), { code: 127, stdout: "", stderr: "", timedOut: false, ok: false }]) {
    assert.equal(await formFor(answer), "argv", JSON.stringify(answer));
  }

  // Read once per runner when it could be read; asked again by the next read when it could not.
  const counts = async (answer) => {
    const git = recordingGit(scriptedGit("/repo", { config: async () => gitOk(evil), "--version": async () => answer }));
    await readChanges("/repo", { run: git.run });
    await readChanges("/repo", { run: git.run });
    return git.names().filter((name) => name === "--version").length;
  };
  assert.equal(await counts(gitOk("git version 2.30.2\n")), 1);
  assert.equal(await counts(gitOk("git version 2.39.5\n")), 1);
  assert.equal(await counts(GIT_NEVER_STARTED), 2);
});

test("S1b: with a git older than 2.31 the filters are switched off by -c pairs in front of the subcommand of status, numstat and every diff, nothing goes into the environment, and an lfs driver with the standard values is still left alone", async () => {
  const git = recordingGit(
    scriptedGit("/repo", {
      config: async () => gitOk(OLD_LISTING),
      "--version": async () => gitOk("git version 2.30.2\n"),
      "--literal-pathspecs": async () => gitOk("diff text\n")
    })
  );
  await readChanges("/repo", { run: git.run });
  assert.deepEqual(git.names(), ["rev-parse", "config", "--version", "status", "diff"]);
  assert.deepEqual(git.call("--version").args, ["--version"]);
  assert.deepEqual(git.call("status").args, [...OLD_PAIRS, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"]);
  assert.deepEqual(git.call("diff").args, [
    ...OLD_PAIRS,
    "diff",
    "--numstat",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=dirty",
    "--submodule=short",
    "HEAD",
    "--"
  ]);
  assert.deepEqual(git.call("status").options.config, [], "nothing in the environment");
  assert.deepEqual(git.call("diff").options.config, []);
  for (const name of ["rev-parse", "config", "--version"]) assert.deepEqual(git.call(name).args.includes("-c"), false, name);
  assert.ok(!git.seen.some((entry) => entry.args.some((arg) => String(arg).includes("filter.lfs"))), "the standard lfs driver is left alone");

  // A diff of a tracked and of an untracked file.
  const diffs = recordingGit(
    scriptedGit("/repo", {
      config: async () => gitOk(OLD_LISTING),
      "--version": async () => gitOk("git version 2.30.2\n"),
      "--literal-pathspecs": async () => gitOk("diff text\n")
    })
  );
  await readDiff("/repo", { path: "kept.txt", status: "modified" }, { run: diffs.run });
  await readDiff("/repo", { path: "kept.txt", status: "untracked" }, { run: diffs.run });
  const tracked = diffs.call("--literal-pathspecs");
  assert.deepEqual(tracked.args.slice(0, 9), [...OLD_PAIRS, "--literal-pathspecs"]);
  assert.deepEqual(tracked.options.config, []);
  const untracked = diffs.seen.find((entry) => entry.args.includes("--no-index"));
  assert.deepEqual(untracked.args.slice(0, 9), [...OLD_PAIRS, "diff"]);
  assert.deepEqual(untracked.options.config, []);
});

test("S1b: with a git older than 2.31 a driver whose name holds an = sign cannot be switched off with -c, so that read is skipped (git_failed, the last result stays) and no status, numstat or diff call is made", async () => {
  const listing = "filter.ev=il.clean\n/tmp/evil.sh\0filter.fine.clean\n/tmp/ok.sh\0";
  const old = async () => gitOk("git version 2.30.2\n");
  const read = recordingGit(scriptedGit("/repo", { config: async () => gitOk(listing), "--version": old }));
  await assert.rejects(readChanges("/repo", { run: read.run }), { code: "git_failed" });
  assert.deepEqual(read.names(), ["rev-parse", "config", "--version"], "nothing ran after the version was seen");
  // A diff shows nothing then.
  const diff = recordingGit(scriptedGit("/repo", { config: async () => gitOk(listing), "--version": old }));
  await assert.rejects(readDiff("/repo", { path: "kept.txt", status: "modified" }, { run: diff.run }), { status: 404, code: "change_missing" });
  assert.deepEqual(diff.names(), ["rev-parse", "config", "--version"]);
  // The same listing is fine for a git that reads the environment.
  const fine = await readChanges("/repo", { run: scriptedGit("/repo", { config: async () => gitOk(listing) }) });
  assert.equal(fine.git, true);

  // In the manager the poll goes on trying, never runs status, and keeps the (empty) last answer.
  await withSessionEnv(async ({ project }) => {
    let lists = 0;
    let statuses = 0;
    const world = fakeWorld({
      runGit: scriptedGit(project, {
        config: async () => {
          lists += 1;
          return gitOk(listing);
        },
        "--version": old,
        status: async () => {
          statuses += 1;
          return undefined;
        }
      }),
      changesPollMs: 5
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    await waitFor(() => lists >= 4);
    assert.equal(statuses, 0, "git status never ran with that filter active");
    assert.deepEqual(await world.manager.changes(id), NOT_READ);
    await endAll(world);
  });
});

test("S1b with real git: when the version is reported as older, the same planted clean and process filters are still switched off, now by -c pairs", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const { repo, ranLog, env } = await plantedFilterRepo(base, home);
    const git = recordingGit(async (folder, args, options) =>
      subcommandOf(args) === "--version" ? gitOk("git version 2.30.0\n") : runGit(folder, args, options)
    );
    const result = await readChanges(repo, { env, now: () => T0, run: git.run });
    assert.deepEqual(result.files, [
      { path: "a.dat", status: "modified", added: 1, removed: 0 },
      { path: "b.proc", status: "modified", added: 2, removed: 0 },
      { path: "new.dat", status: "untracked", added: 1, removed: 0 }
    ]);
    const status = git.call("status");
    assert.equal(status.args[0], "-c", "the -c form was used");
    assert.deepEqual(status.options.config, []);
    for (const file of result.files) assert.match((await readDiff(repo, file, { env, run: git.run })).diff, /^\+/m, file.path);
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "no filter ran, with the older form either");
  });
});

// ---- fix round 2: lazy fetch (N1), submodule diffs (N2), the version per PATH (N4) ----------------

// Makes a repository look like a partial clone: it names a "promisor" remote
// whose ssh command is `helper`, so a git that needs an object it does not have
// runs that helper to fetch it.
function plantPartialClone(repo, home, helper) {
  git(repo, home, "config", "core.repositoryformatversion", "1");
  git(repo, home, "config", "extensions.partialClone", "origin");
  git(repo, home, "config", "remote.origin.promisor", "true");
  git(repo, home, "config", "remote.origin.url", "ssh://example.invalid/x.git");
  git(repo, home, "config", "core.sshCommand", helper);
}

// Deletes the committed (loose) blob of a tracked file.
async function deleteCommittedBlob(repo, home, file) {
  const oid = git(repo, home, "rev-parse", `HEAD:${file}`).trim();
  await rm(path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)), { force: true });
}

test("N1 with real git: a repository that names a promisor remote (with an ssh command helper) and lacks an object makes the read fail cleanly and fast, and git never fetches: the helper does not run during a poll or a diff (a control shows plain git does run it)", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "repo");
    const ranLog = path.join(base, "fetch-ran.log");
    const helper = path.join(base, "ssh.sh");
    await mkdir(repo);
    await writeFile(helper, `#!/bin/sh\necho "ssh" >> '${ranLog}'\nexit 1\n`);
    await chmod(helper, 0o700);
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, "a.txt"), "one\n");
    git(repo, home, "add", "a.txt");
    git(repo, home, "commit", "-qm", "start");
    plantPartialClone(repo, home, helper);
    await deleteCommittedBlob(repo, home, "a.txt");
    await writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
    const env = gitTestEnv(home);

    // The control: plain git goes to fetch the missing blob, which runs the helper.
    try {
      git(repo, home, "diff", "--numstat", "HEAD", "--");
    } catch {
      // the fetch fails and so does the command; only the log matters
    }
    assert.match(await readFile(ranLog, "utf8"), /^ssh$/m, "control: plain git runs the helper to fetch the object");
    await unlink(ranLog);

    const started = Date.now();
    await assert.rejects(readChanges(repo, { env, now: () => T0 }), { code: "git_failed" });
    await assert.rejects(readDiff(repo, { path: "a.txt", status: "modified" }, { env }), { status: 404, code: "change_missing" });
    assert.ok(Date.now() - started < GIT_LIMIT_MS, "the read failed at once; it did not wait for a fetch");
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "the helper did not run");
    // Even a person's own settings that allow a transport do not open one.
    await assert.rejects(readChanges(repo, { env: { ...env, GIT_ALLOW_PROTOCOL: "ssh:ext:file:https" }, now: () => T0 }), { code: "git_failed" });
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "the helper did not run with a transport allowed in the person's environment");
  });
});

test("N1 with real git: in a running session a missing object keeps the panel's last answer on every poll, and the helper never runs", SKIP_GIT, async () => {
  await withSessionEnv(async ({ home, project }) => {
    const ranLog = path.join(home, "fetch-ran.log");
    const helper = path.join(home, "ssh.sh");
    await writeFile(helper, `#!/bin/sh\necho "ssh" >> '${ranLog}'\nexit 1\n`);
    await chmod(helper, 0o700);
    git(project, home, "init", "-q");
    await writeFile(path.join(project, "a.txt"), "one\n");
    git(project, home, "add", "a.txt");
    git(project, home, "commit", "-qm", "start");
    plantPartialClone(project, home, helper);
    await writeFile(path.join(project, "a.txt"), "one\ntwo\n");
    let numstats = 0;
    const world = fakeWorld({
      runGit: (folder, args, options) => {
        if (subcommandOf(args) === "diff") numstats += 1;
        return runGit(folder, args, options);
      },
      changesPollMs: 40,
      profileEnv: gitTestEnv(home)
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    const good = await waitFor(async () => {
      const result = await world.manager.changes(id);
      return result.files.length === 1 ? result : null;
    });
    assert.deepEqual(good.files, [{ path: "a.txt", status: "modified", added: 1, removed: 0 }]);

    // The object goes missing while the session runs. Plain git would now run the helper (control).
    await deleteCommittedBlob(project, home, "a.txt");
    try {
      git(project, home, "diff", "--numstat", "HEAD", "--");
    } catch {
      // only the log matters
    }
    assert.match(await readFile(ranLog, "utf8"), /^ssh$/m, "control: plain git runs the helper");
    await unlink(ranLog);

    const before = numstats;
    await waitFor(() => numstats >= before + 4);
    assert.deepEqual(await world.manager.changes(id), good, "the failed reads keep the last answer");
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "the helper did not run on any poll");
    await endAll(world);
  });
});

test("N2 with real git: a submodule row is shown as the two commits it moved between, so a diff.submodule=diff setting cannot start a diff inside the submodule (its own diff.external helper does not run; a control shows plain git does run it)", SKIP_GIT, async () => {
  await withTempDirs(async ({ base, home }) => {
    const repo = path.join(base, "super");
    const sub = path.join(repo, "sub");
    const ranLog = path.join(base, "diff-ran.log");
    const helper = path.join(base, "diff.sh");
    await mkdir(sub, { recursive: true });
    await writeFile(helper, `#!/bin/sh\necho "diff" >> '${ranLog}'\nexit 0\n`);
    await chmod(helper, 0o700);
    git(sub, home, "init", "-q");
    await writeFile(path.join(sub, "f.txt"), "a\n");
    git(sub, home, "add", "f.txt");
    git(sub, home, "commit", "-qm", "c1");
    git(repo, home, "init", "-q");
    await writeFile(path.join(repo, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
    git(repo, home, "add", ".gitmodules", "sub");
    git(repo, home, "commit", "-qm", "start");
    // The repository asks for the long form of submodule diffs, and the submodule
    // (which moves on by one commit) has a diff helper of its own.
    git(repo, home, "config", "diff.submodule", "diff");
    git(sub, home, "config", "diff.external", helper);
    await writeFile(path.join(sub, "f.txt"), "a\nb\n");
    git(sub, home, "add", "f.txt");
    git(sub, home, "commit", "-qm", "c2");
    const env = gitTestEnv(home);

    try {
      git(repo, home, "diff", "HEAD", "--", "sub");
    } catch {
      // only the log matters
    }
    assert.match(await readFile(ranLog, "utf8"), /^diff$/m, "control: plain git runs the submodule's helper");
    await unlink(ranLog);

    const result = await readChanges(repo, { env, now: () => T0 });
    assert.deepEqual(result.files, [{ path: "sub", status: "modified", added: 1, removed: 1 }]);
    const shown = await readDiff(repo, result.files[0], { env });
    assert.match(shown.diff, /^\+Subproject commit [0-9a-f]{40}$/m, "the short form: the commit it moved to");
    assert.doesNotMatch(shown.diff, /^Submodule /m, "not the long form");
    await assert.rejects(stat(ranLog), { code: "ENOENT" }, "the submodule's helper did not run");
  });
});

test("N4: git's version is remembered per PATH value, so two sessions whose PATH reaches different gits each get the right form", async () => {
  const versionOf = { "/new/bin": "git version 2.39.5\n", "/old/bin": "git version 2.30.2\n" };
  const git = recordingGit(
    scriptedGit("/repo", {
      config: async () => gitOk("filter.evil.clean\n/tmp/evil.sh\0"),
      "--version": async (_folder, _args, options) => gitOk(versionOf[options.env.PATH])
    })
  );
  const formFor = async (pathValue) => {
    await readChanges("/repo", { run: git.run, env: { PATH: pathValue } });
    const status = git.seen.filter((entry) => entry.name === "status").at(-1);
    return status.args[0] === "-c" ? "argv" : "env";
  };
  assert.equal(await formFor("/new/bin"), "env");
  assert.equal(await formFor("/old/bin"), "argv", "the second git is older: the first answer is not used for it");
  assert.equal(await formFor("/new/bin"), "env");
  assert.equal(await formFor("/old/bin"), "argv");
  assert.equal(git.names().filter((name) => name === "--version").length, 2, "one look per PATH value, not per read");
});

test("S3: exit 128 from rev-parse means 'not a git project' only when git says so; any other fatal text is a failed read (git_failed) that keeps the last result", async () => {
  const fatal = (stderr) => async (_folder, args) =>
    args[0] === "rev-parse" ? { code: 128, stdout: "", stderr, timedOut: false, ok: false } : gitOk("");
  assert.deepEqual(
    await readChanges("/x", { run: fatal("fatal: not a git repository (or any of the parent directories): .git\n"), now: () => T0 }),
    { git: false, files: [], total: 0, at: AT0 }
  );
  for (const stderr of [
    "fatal: detected dubious ownership in repository at '/x'\nTo add an exception for this directory, call:\n",
    "fatal: bad config line 3 in file .git/config",
    "fatal: cannot change to '/gone': No such file or directory",
    ""
  ]) {
    await assert.rejects(readChanges("/x", { run: fatal(stderr) }), { code: "git_failed" }, JSON.stringify(stderr));
  }

  // In the manager the panel keeps its last answer while git refuses to open the repository.
  await withSessionEnv(async ({ project }) => {
    let refuse = false;
    let revParse = 0;
    const world = fakeWorld({
      runGit: scriptedGit(project, {
        "rev-parse": async () => {
          revParse += 1;
          return refuse
            ? { code: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository at '/x'", timedOut: false, ok: false }
            : undefined;
        }
      }),
      changesPollMs: 5
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    const good = await waitFor(async () => {
      const result = await world.manager.changes(id);
      return result.git === true ? result : null;
    });
    assert.deepEqual(good.files, [{ path: "kept.txt", status: "modified", added: 2, removed: 1 }]);
    refuse = true;
    const atRefusal = revParse;
    await waitFor(() => revParse >= atRefusal + 3);
    assert.deepEqual(await world.manager.changes(id), good, "a repository git refuses to open is not turned into 'not a git project'");
    await endAll(world);
  });
});

test("Q1: edits that come during a read ask for one more read, but it starts no sooner than the debounce time after the first ended", async () => {
  await withSessionEnv(async ({ project }) => {
    let statusCalls = 0;
    let hold = null;
    const startedAt = [];
    const world = fakeWorld({
      runGit: scriptedGit(project, {
        status: async () => {
          statusCalls += 1;
          startedAt.push(Date.now());
          if (hold) await hold.promise;
          return undefined;
        }
      }),
      changesPollMs: 60000
    });
    const { id } = await world.manager.create({ agentId: "claude", folder: project });
    await waitFor(() => statusCalls === 1);
    hold = deferred();
    world.manager.onHook(id, EDIT_HOOK());
    await waitFor(() => statusCalls === 2); // that read runs, and waits
    world.manager.onHook(id, EDIT_HOOK()); // an edit while it runs
    const release = hold;
    hold = null;
    const releasedAt = Date.now();
    release.resolve();
    await waitFor(() => statusCalls === 3);
    const gap = startedAt[2] - releasedAt;
    assert.ok(gap >= CHANGES_REFRESH_DEBOUNCE_MS - 40, `the next read started ${gap} ms after the one that ended; it must wait about 300 ms`);
    await endAll(world);
  });
});

test("Q2: a hook that arrives before the session's first save finished starts no poll, and a session whose first save failed is never read", async () => {
  await withSessionEnv(async ({ project }) => {
    let gitCalls = 0;
    const gate = deferred();
    const world = fakeWorld({
      runGit: async (_folder, args) => {
        gitCalls += 1;
        return args[0] === "rev-parse" ? gitOk(`${project}\n`) : gitOk("");
      },
      changesPollMs: 20,
      // The first meta.json write waits, then fails: the start is abandoned.
      writeJson: async () => {
        await gate.promise;
        throw new Error("disk full");
      }
    });
    const starting = world.manager.create({ agentId: "claude", folder: project });
    const failure = assert.rejects(starting, { status: 500, code: "start_failed" });
    const [pending] = await waitFor(() => {
      const sessions = world.manager.liveAgentSessions("claude");
      return sessions.length ? sessions : null;
    });
    world.manager.onHook(pending.id, EDIT_HOOK()); // the first save is still waiting
    await sleep(CHANGES_REFRESH_DEBOUNCE_MS + 150);
    assert.equal(gitCalls, 0, "no read before the session was saved");
    gate.resolve();
    await failure;
    await sleep(120);
    assert.equal(gitCalls, 0, "a session that was never saved is never read");
  });
});

test("Q3: a read for a stopped poll stops between its git calls: nothing runs after the stop is seen", async () => {
  for (const stopAfter of [1, 2, 3, 4]) {
    const calls = [];
    const base = scriptedGit("/repo", { status: async () => gitOk("? new.txt\0") });
    const run = async (folder, args, options) => {
      calls.push(args[0]);
      return base(folder, args, options);
    };
    await assert.rejects(readChanges("/repo", { run, isStopped: () => calls.length >= stopAfter }), { code: "git_stopped" }, `stopped after ${stopAfter}`);
    assert.equal(calls.length, stopAfter, `no git call after the stop (${calls.join(", ")})`);
  }
  const all = [];
  const base = scriptedGit("/repo");
  const complete = await readChanges("/repo", {
    run: async (folder, args, options) => {
      all.push(args[0]);
      return base(folder, args, options);
    },
    isStopped: () => false
  });
  assert.equal(complete.git, true);
  assert.deepEqual(all, ["rev-parse", "config", "status", "diff"]);
});

test("Q3: shutdownAll stops every session's poll first, so no git run starts while the sessions are being stopped", async () => {
  await withSessionEnv(async ({ project }) => {
    let revParse = 0;
    const world = fakeWorld({
      runGit: scriptedGit(project, {
        "rev-parse": async () => {
          revParse += 1;
          return undefined;
        }
      }),
      changesPollMs: 10
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    await waitFor(() => revParse >= 3); // the poll runs
    // The fake process keeps running until the test ends it: the window in which the real one is being stopped.
    const stopping = world.manager.shutdownAll({ reason: "stop" });
    const atStop = revParse;
    await sleep(120);
    assert.equal(revParse, atStop, "not one git run started after shutdownAll began");
    world.ptys[0].exit(0);
    await stopping;
    await waitFor(async () => (await world.manager.get(id)).status === "exited");
  });
});

test("Q4: requests for an ended session share one read while it runs and reuse its answer for 2 s, and a login environment that can't be read is not a server error", async () => {
  assert.equal(ENDED_READ_REUSE_MS, 2000);
  await withSessionEnv(async ({ project }) => {
    let revParse = 0;
    let gate = null;
    const world = fakeWorld({
      runGit: scriptedGit(project, {
        "rev-parse": async () => {
          revParse += 1;
          if (gate) await gate.promise;
          return undefined;
        }
      }),
      changesPollMs: 3_600_000
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    await waitFor(() => revParse === 1); // the live baseline read
    world.ptys[0].exit(0);
    await waitFor(async () => (await world.manager.get(id)).status === "exited");
    const base = revParse;

    gate = deferred();
    const answers = Promise.all([1, 2, 3, 4, 5].map(() => world.manager.changes(id)));
    const shown = world.manager.diff(id, "kept.txt"); // its read is the same one
    await waitFor(() => revParse === base + 1);
    await sleep(60);
    assert.equal(revParse, base + 1, "six requests, one read in flight");
    gate.resolve();
    const results = await answers;
    for (const result of results) {
      assert.deepEqual(result, { git: true, files: [{ path: "kept.txt", status: "modified", added: 2, removed: 1 }], total: 1, at: AT0 });
    }
    assert.equal((await shown).path, "kept.txt");
    assert.equal(revParse, base + 2, "one shared read, plus the diff's own look for the top folder");
    results[0].files.length = 0;
    assert.equal((await world.manager.changes(id)).files.length, 1, "each caller gets its own copy");
    assert.equal(revParse, base + 2, "an answer less than 2 s old is reused");

    await sleep(ENDED_READ_REUSE_MS + 150);
    await world.manager.changes(id);
    assert.equal(revParse, base + 3, "after 2 s the next request reads again");
  });

  await withSessionEnv(async ({ project }) => {
    const world = fakeWorld({
      runGit: scriptedGit(project),
      changesPollMs: 3_600_000,
      loginEnv: async () => {
        throw new Error("the login shell could not be read");
      }
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    world.ptys[0].exit(0);
    await waitFor(async () => (await world.manager.get(id)).status === "exited");
    assert.deepEqual(await world.manager.changes(id), NOT_READ);
    await assert.rejects(world.manager.diff(id, "kept.txt"), { status: 404, code: "change_missing" });
  });
});

test("Q5: one failed start of git keeps the last answer and the poll goes on; only three in a row give up, and a good read in between starts the count again", async () => {
  await withSessionEnv(async ({ project }) => {
    const script = ["ok", "never", "never", "ok", "never", "never", "never"]; // the answers to rev-parse, in order
    let revParse = 0;
    const world = fakeWorld({
      runGit: scriptedGit(project, {
        "rev-parse": async () => {
          const step = script[revParse] ?? "never";
          revParse += 1;
          return step === "ok" ? undefined : GIT_NEVER_STARTED;
        }
      }),
      changesPollMs: 5
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    const good = await waitFor(async () => {
      const result = await world.manager.changes(id);
      return result.git === true ? result : null;
    });
    await waitFor(() => revParse >= 3); // two failed starts happened
    assert.deepEqual(await world.manager.changes(id), good, "two failed starts keep the last answer");
    await waitFor(() => revParse === 7);
    await sleep(80);
    assert.equal(revParse, 7, "three failed starts in a row (after a good read) give up; nothing more runs");
    assert.deepEqual(await world.manager.changes(id), { git: false, files: [], total: 0, at: AT0 });
    await endAll(world);
  });
});

test("Q6: merged markers keep the newest counts of each path in the order the paths first appeared, list at most 20 and count the rest in more, and one marker passes through unchanged", () => {
  assert.equal(FILES_MARKER_GAP_MS, 30000);
  const marker = (at, files, more = 0) => ({
    at,
    type: "files",
    files: files.map(([filePath, added, removed]) => ({ path: filePath, added, removed })),
    more
  });
  assert.equal(pendingToMarker(newPendingMarker()), null);
  const single = marker("t1", [["a", 1, 0], ["b", null, null]], 3);
  assert.deepEqual(pendingToMarker(addPendingMarker(newPendingMarker(), single)), single);
  const pending = newPendingMarker();
  addPendingMarker(pending, marker("t1", [["a", 1, 0], ["b", 2, 2]]));
  addPendingMarker(pending, marker("t2", [["b", 5, 2], ["c", 3, 0]], 2));
  assert.deepEqual(pendingToMarker(pending), marker("t2", [["a", 1, 0], ["b", 5, 2], ["c", 3, 0]], 2));
  const big = newPendingMarker();
  for (let round = 0; round < 3; round += 1) {
    addPendingMarker(big, marker(`t${round}`, Array.from({ length: 20 }, (_, i) => [`f${round}-${i}`, 1, 0])));
  }
  const merged = pendingToMarker(big);
  assert.equal(merged.files.length, FILES_MARKER_MAX);
  assert.equal(merged.files[0].path, "f0-0");
  assert.equal(merged.more, 40);
  assert.equal(merged.at, "t2");
});

test("Q6: a session records at most one files changed marker per gap, what changes in between is merged into the next one, and the session's end records the rest, so nothing is lost", async () => {
  await withSessionEnv(async ({ project }) => {
    let reads = 0;
    // Each read lists one more new file than the one before: every read is a change.
    const world = fakeWorld({
      runGit: scriptedGit(project, {
        status: async () => {
          reads += 1;
          return gitOk(Array.from({ length: reads }, (_, i) => `? new-${String(i).padStart(2, "0")}.txt\0`).join(""));
        }
      }),
      changesPollMs: 25,
      changesMarkerGapMs: 400
    });
    const { id } = await world.manager.create({ agentId: "codex", folder: project });
    await waitFor(() => reads >= 40, { timeoutMs: 30000 });
    const readsAtEnd = reads;
    await endAll(world);
    const markers = (await world.manager.markers(id)).filter((entry) => entry.type === "files");
    assert.ok(markers.length >= 2, `the waiting changes were recorded later (${markers.length} markers)`);
    assert.ok(markers.length <= 8, `at most one marker per 400 ms gap, not one per read (${markers.length} markers for ${reads} reads)`);
    for (const entry of markers) {
      assert.ok(entry.files.length <= FILES_MARKER_MAX);
      assert.equal(typeof entry.more, "number");
    }
    const listed = new Set(markers.flatMap((entry) => entry.files.map((file) => file.path)));
    const counted = markers.reduce((sum, entry) => sum + entry.files.length + entry.more, 0);
    assert.ok(listed.has("new-01.txt"), "the first change has its marker");
    // Read k lists k files, so it adds one new file. A read that was running when the session ended records nothing.
    assert.ok(counted >= readsAtEnd - 4, `every new file is in a marker or counted in more (${counted} for ${readsAtEnd} reads)`);
  });
});
