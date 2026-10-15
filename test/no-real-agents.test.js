// The no-real-agents watcher that `npm test` runs around the whole suite
// (spec SP3; planning decisions Q1, Q1a, Q1b). The pure functions are tested
// with made-up `ps` rows. The planted-process tests start a shell script
// named "claude" that only sleeps, from a temp folder the test declares "not
// a fake folder". No real agent is ever started.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_NAMES,
  REAL_AGENT_PATHS,
  defaultAllowedRoots,
  findViolations,
  isAllowedBinary,
  parsePsRows,
  readPsRows,
  startWatcher
} from "./helpers/no-real-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const POSIX_ONLY = { skip: isWindows ? "the watcher is not available on Windows (no ps)" : false };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Made-up rows: the runner is pid 100; "/fake-root-agent-os/bin" plays the
// fake folder; "/home/agent-os-test-user/..." plays a real install.
const RUNNER = 100;
const FAKE_ROOT = "/fake-root-agent-os/bin";
const REAL_HOME = "/home/agent-os-test-user";
const runnerRows = [
  { pid: RUNNER, ppid: 1, command: "node scripts/run-tests.mjs" },
  { pid: 101, ppid: RUNNER, command: "node --test --test-timeout=180000 /repo/test/a.test.js /repo/test/b.test.js" },
  { pid: 102, ppid: 101, command: "node --test-timeout=180000 /repo/test/b.test.js" }
];

function check(rows, options = {}) {
  return findViolations(rows, {
    baseline: new Map(),
    rootPid: RUNNER,
    seenDescendants: new Map(),
    allowedRoots: [FAKE_ROOT],
    ...options
  });
}

async function waitUntil(probe, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// A stand-in "claude": a shell script that only sleeps. Started directly, ps
// shows it as "/bin/sh <dir>/claude ...", so its second word is named claude.
async function plantFakeClaude(dir) {
  const script = path.join(dir, "claude");
  await writeFile(script, "#!/bin/sh\n/bin/sleep 30\nexit 0\n");
  await chmod(script, 0o755);
  return script;
}

function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

test("parsePsRows reads pid, parent pid and the whole command, and skips anything else", () => {
  const text = [
    "  101   100 node --test-timeout=180000 /repo/test/a.test.js",
    "    7     1 /bin/sh /tmp/x/claude --session-id abc def",
    "not a row",
    "",
    "    9     1"
  ].join("\n");
  assert.deepEqual(parsePsRows(text), [
    { pid: 101, ppid: 100, command: "node --test-timeout=180000 /repo/test/a.test.js" },
    { pid: 7, ppid: 1, command: "/bin/sh /tmp/x/claude --session-id abc def" },
    { pid: 9, ppid: 1, command: "" }
  ]);
});

test("the watched names and the fake folders are the ones planning decision Q1a lists", () => {
  assert.deepEqual([...AGENT_NAMES], ["claude", "codex", "agent", "cursor-agent", "hermes", "openclaw"]);
  assert.deepEqual(defaultAllowedRoots(), [
    os.tmpdir(),
    path.join(root, "test"),
    path.join(root, ".superpowers", "ui-audit", "fake-bin")
  ]);
});

test("findViolations flags a real agent the tests started, by its first or second word, and nothing else", POSIX_ONLY, () => {
  const rows = [
    ...runnerRows,
    { pid: 103, ppid: 102, command: `/bin/sh ${FAKE_ROOT}/claude --session-id x` },
    { pid: 104, ppid: 102, command: `${REAL_HOME}/.local/bin/claude --version` },
    { pid: 105, ppid: 102, command: `/usr/bin/python3 ${REAL_HOME}/.hermes/hermes-agent/venv/bin/hermes chat` },
    { pid: 106, ppid: 102, command: "cursor-agent --workspace /x" },
    { pid: 107, ppid: 102, command: "/bin/sleep 30" },
    { pid: 108, ppid: 102, command: "/usr/bin/ssh-agent -s" },
    { pid: 200, ppid: 1, command: `${REAL_HOME}/.local/bin/claude --input-format stream-json` }
  ];
  const found = check(rows)
    .map((v) => [v.pid, v.name, v.binary, v.testFile])
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(found, [
    [104, "claude", `${REAL_HOME}/.local/bin/claude`, "/repo/test/b.test.js"],
    [105, "hermes", `${REAL_HOME}/.hermes/hermes-agent/venv/bin/hermes`, "/repo/test/b.test.js"],
    [106, "cursor-agent", "cursor-agent", "/repo/test/b.test.js"]
  ]);
});

test("a process already running when the watcher started is not flagged, unless its pid now runs something else", POSIX_ONLY, () => {
  const rows = [
    ...runnerRows,
    { pid: 104, ppid: 102, command: `${REAL_HOME}/.local/bin/claude --version` },
    { pid: 105, ppid: 102, command: `${REAL_HOME}/.local/bin/codex exec` }
  ];
  const baseline = new Map([
    [104, `${REAL_HOME}/.local/bin/claude --version`],
    [105, "/usr/bin/some-older-process"]
  ]);
  assert.deepEqual(check(rows, { baseline }).map((v) => v.pid), [105]);
  assert.deepEqual(check(rows, { baseline: new Set([104, 105]) }).map((v) => v.pid), []);
});

test("a descendant is remembered after its parent exits, but a reused pid is not", POSIX_ONLY, () => {
  const seenDescendants = new Map();
  const first = [
    ...runnerRows,
    { pid: 300, ppid: 102, command: `/bin/sh ${FAKE_ROOT}/codex` },
    { pid: 301, ppid: 300, command: `${REAL_HOME}/.local/bin/codex resume --last` },
    { pid: 400, ppid: 102, command: "node -e setInterval" }
  ];
  assert.deepEqual(check(first, { seenDescendants }).map((v) => v.pid), [301]);

  // The parent is gone and 301 was handed to pid 1; pid 400 exited and the
  // system reused its number for the owner's own claude.
  const second = [
    ...runnerRows,
    { pid: 301, ppid: 1, command: `${REAL_HOME}/.local/bin/codex resume --last` },
    { pid: 400, ppid: 1, command: `${REAL_HOME}/.local/bin/claude --input-format stream-json` }
  ];
  const again = check(second, { seenDescendants });
  assert.deepEqual(again.map((v) => [v.pid, v.testFile]), [[301, "/repo/test/b.test.js"]]);
});

test("a process that replaces itself (exec) under a watched parent is still checked", POSIX_ONLY, () => {
  const seenDescendants = new Map();
  check([...runnerRows, { pid: 500, ppid: 102, command: `/bin/sh ${FAKE_ROOT}/claude` }], { seenDescendants });
  const after = check([...runnerRows, { pid: 500, ppid: 102, command: `${REAL_HOME}/.local/bin/claude` }], {
    seenDescendants
  });
  assert.deepEqual(after.map((v) => v.pid), [500]);
});

test("the names list can be changed", POSIX_ONLY, () => {
  const rows = [
    ...runnerRows,
    { pid: 600, ppid: 102, command: `${REAL_HOME}/bin/gemini` },
    { pid: 601, ppid: 102, command: `${REAL_HOME}/.local/bin/claude` }
  ];
  assert.deepEqual(check(rows, { names: ["gemini"] }).map((v) => v.pid), [600]);
});

test("a real agent's own install folder counts even inside a fake folder, also behind a link", POSIX_ONLY, async () => {
  assert.ok(REAL_AGENT_PATHS.every((rule) => AGENT_NAMES.includes(rule.name)), "every install path names a watched agent");

  // An npx cache under a temp HOME: the temp folder is a fake folder, but this
  // is Claude Code's own package. The same command outside the run is not flagged.
  const npx = "/var/folders/x/T/h/.npm/_npx/1/node_modules/@anthropic-ai/claude-code/cli.js";
  const rows = [
    ...runnerRows,
    { pid: 700, ppid: 102, command: `node ${npx}` },
    { pid: 701, ppid: 1, command: `node ${npx}` },
    { pid: 702, ppid: 102, command: `node ${path.join(root, "test", "fakes", "tui-agent.mjs")}` }
  ];
  assert.deepEqual(
    check(rows, { allowedRoots: [FAKE_ROOT, "/var/folders/x/T"] }).map((v) => [v.pid, v.name, v.binary, v.testFile]),
    [[700, "claude", npx, "/repo/test/b.test.js"]]
  );

  // A Setup-style install runs through a link (~/.local/bin/claude -> the
  // versions folder), and ps shows only the link's path.
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-watch-installs-"));
  try {
    const versions = path.join(dir, "h", ".local", "share", "claude", "versions");
    const bin = path.join(dir, "h", ".local", "bin");
    await mkdir(versions, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(versions, "2.0.0"), "#!/bin/sh\n");
    await symlink(path.join(versions, "2.0.0"), path.join(bin, "claude"));
    const linked = [...runnerRows, { pid: 703, ppid: 102, command: `${path.join(bin, "claude")} --version` }];
    assert.deepEqual(
      check(linked, { allowedRoots: [dir] }).map((v) => [v.pid, v.name, v.binary]),
      [[703, "claude", path.join(bin, "claude")]]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isAllowedBinary judges where the file really is, through symlinks", POSIX_ONLY, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-watch-paths-"));
  const fakes = path.join(dir, "fakes");
  const elsewhere = path.join(dir, "elsewhere");
  try {
    await mkdir(fakes);
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "real-claude"), "#!/bin/sh\n");
    await writeFile(path.join(fakes, "fake-claude"), "#!/bin/sh\n");
    await symlink(path.join(elsewhere, "real-claude"), path.join(fakes, "claude"));
    await symlink(path.join(fakes, "fake-claude"), path.join(elsewhere, "claude"));

    assert.equal(isAllowedBinary(path.join(fakes, "claude"), [fakes]), false, "a link in a fake folder to a real file");
    assert.equal(isAllowedBinary(path.join(elsewhere, "claude"), [fakes]), true, "a link elsewhere to a fake file");
    assert.equal(isAllowedBinary(path.join(fakes, "gone", "claude"), [fakes]), true, "a path that no longer exists, as written");
    assert.equal(isAllowedBinary(path.join(elsewhere, "gone", "claude"), [fakes]), false);
    assert.equal(isAllowedBinary("claude", [fakes]), false, "a bare name can never be proved to be a fake");
    assert.equal(isAllowedBinary(path.join(fakes, "fake-claude"), [os.tmpdir()]), true, "the temp folder under either of its names");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a planted claude outside the fake folders shows up in a real ps snapshot; inside them it does not", POSIX_ONLY, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-watch-plant-"));
  let planted = null;
  try {
    const script = await plantFakeClaude(dir);
    const before = await readPsRows();
    assert.ok(before, "ps must run");
    const baseline = new Map(before.map((row) => [row.pid, row.command]));
    planted = spawn(script, ["--version"], { detached: true, stdio: "ignore" });
    const rows = await waitUntil(async () => {
      const snapshot = await readPsRows();
      return snapshot?.some((row) => row.pid === planted.pid && row.command.includes(script)) ? snapshot : null;
    }, "the planted claude in ps");

    const notAllowed = findViolations(rows, {
      baseline,
      rootPid: process.pid,
      seenDescendants: new Map(),
      allowedRoots: [path.join(root, "test")]
    }).filter((v) => v.pid === planted.pid);
    assert.equal(notAllowed.length, 1);
    assert.equal(notAllowed[0].name, "claude");
    assert.equal(notAllowed[0].binary, script);

    const allowed = findViolations(rows, { baseline, rootPid: process.pid, seenDescendants: new Map() });
    assert.equal(allowed.some((v) => v.pid === planted.pid), false, "the temp folder is a fake folder by default");
  } finally {
    killGroup(planted);
    await rm(dir, { recursive: true, force: true });
  }
});

test("startWatcher reports a planted claude once, stops it with SIGTERM, and counts its checks", POSIX_ONLY, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-watch-live-"));
  const reported = [];
  let planted = null;
  const watcher = await startWatcher({
    rootPid: process.pid,
    intervalMs: 100,
    allowedRoots: [path.join(root, "test")],
    onViolation: (violation) => reported.push(violation)
  });
  try {
    const script = await plantFakeClaude(dir);
    planted = spawn(script, [], { detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => planted.once("exit", (code, signal) => resolve(signal)));
    await waitUntil(() => reported.find((v) => v.pid === planted.pid), "the watcher to report the planted claude");
    assert.equal(await exited, "SIGTERM");
    const result = await watcher.stop();
    assert.ok(result.checks >= 1);
    assert.equal(result.violations.filter((v) => v.pid === planted.pid).length, 1, "reported once");
    assert.equal(reported.filter((v) => v.pid === planted.pid).length, 1);
  } finally {
    await watcher.stop();
    killGroup(planted);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Fix round 1 ------------------------------------------------------------
// (1) a ps run that fails must never pass for a clean check, (2) a rootPid that
// is not the test runner must never make the owner's own processes "ours",
// (3) the runner must let its last line reach a pipe.

// A stand-in for readPsRows(): call number N (1 = the baseline) gets
// answer(N), made-up rows or null. Always used with `kill: false`, because the
// made-up pids could belong to real processes.
function scriptedRows(answer) {
  const reader = async () => answer((reader.calls += 1));
  reader.calls = 0;
  return reader;
}

const WATCHED = { rootPid: RUNNER, intervalMs: 20, kill: false, allowedRoots: [FAKE_ROOT] };

test("startWatcher counts the polls where ps could not run, and a good final sweep still proves the run", POSIX_ONLY, async () => {
  // call 1 = baseline, calls 2 and 3 = the first two polls (ps fails), then fine
  const readRows = scriptedRows((n) => (n === 2 || n === 3 ? null : runnerRows));
  const watcher = await startWatcher({ ...WATCHED, readRows });
  await waitUntil(() => readRows.calls >= 5, "five reads of ps");
  const result = await watcher.stop();
  assert.equal(result.failedChecks, 2);
  assert.equal(result.finalCheckOk, true);
  assert.ok(result.checks >= 3, "polls 4 and 5 and the final sweep worked");
  assert.deepEqual(result.violations, []);
});

test("stop() tries the final sweep three times, then reports that it never worked", POSIX_ONLY, async () => {
  let broken = false;
  const readRows = scriptedRows(() => (broken ? null : runnerRows));
  const watcher = await startWatcher({ ...WATCHED, readRows });
  await waitUntil(() => readRows.calls >= 3, "two good polls");
  const before = readRows.calls;
  broken = true;
  const result = await watcher.stop();
  assert.equal(readRows.calls - before, 3, "three tries, then it gives up");
  assert.equal(result.finalCheckOk, false);
  assert.equal(result.failedChecks, 3);
  assert.ok(result.checks >= 1, "the earlier polls were fine");
  assert.deepEqual(await watcher.stop(), result, "a second stop() gives the same answer");
  assert.equal(readRows.calls - before, 3, "and reads ps no more");
});

test("a final sweep that fails once or twice is retried and then counts", POSIX_ONLY, async () => {
  let failures = 0;
  const readRows = scriptedRows(() => (failures > 0 ? ((failures -= 1), null) : runnerRows));
  const watcher = await startWatcher({ ...WATCHED, readRows });
  await waitUntil(() => readRows.calls >= 3, "two good polls");
  failures = 2;
  const result = await watcher.stop();
  assert.equal(result.finalCheckOk, true);
  assert.equal(result.failedChecks, 2);
});

test("startWatcher does not start when the first ps read fails", POSIX_ONLY, async () => {
  await assert.rejects(() => startWatcher({ ...WATCHED, readRows: scriptedRows(() => null) }), /could not run ps/);
});

test("findViolations flags nothing for a rootPid that is not a test runner (pid 1 would make every process a descendant)", () => {
  const ownersClaude = { pid: 900, ppid: 1, command: `${REAL_HOME}/.local/bin/claude --input-format stream-json` };
  const underParent = { pid: 901, ppid: process.ppid, command: `${REAL_HOME}/.local/bin/claude --version` };
  const rows = [...runnerRows, ownersClaude, underParent, { pid: 902, ppid: 102, command: `${REAL_HOME}/.local/bin/codex exec` }];
  if (!isWindows) assert.deepEqual(check(rows).map((v) => v.pid), [902], "a proper rootPid still works");
  for (const rootPid of [1, 0, -5, 1.5, Number.NaN, null, undefined, "100", process.ppid]) {
    const seenDescendants = new Map();
    assert.deepEqual(check(rows, { rootPid, seenDescendants }), [], `rootPid ${String(rootPid)}`);
    assert.equal(seenDescendants.size, 0, `rootPid ${String(rootPid)} remembers nothing`);
  }
});

test("startWatcher refuses a rootPid that is not a test runner, before it reads ps or signals anything", async () => {
  for (const rootPid of [1, 0, -5, 1.5, Number.NaN, null, "100", process.ppid]) {
    const readRows = scriptedRows(() => runnerRows);
    await assert.rejects(
      () => startWatcher({ rootPid, kill: false, readRows }),
      /^Error: startWatcher needs the pid of the test runner it watches$/,
      `rootPid ${String(rootPid)}`
    );
    assert.equal(readRows.calls, 0, `rootPid ${String(rootPid)} read nothing`);
  }
});

test("a rootPid left out means this process itself: not nothing, and not everything", POSIX_ONLY, async () => {
  const mine = { pid: 777, ppid: process.pid, command: `${REAL_HOME}/.local/bin/claude --version` };
  const owners = { pid: 778, ppid: 1, command: `${REAL_HOME}/.local/bin/claude --input-format stream-json` };
  const readRows = scriptedRows((n) => (n === 1 ? [] : [{ pid: process.pid, ppid: process.ppid, command: "node" }, mine, owners]));
  const watcher = await startWatcher({ rootPid: undefined, kill: false, allowedRoots: [FAKE_ROOT], readRows });
  const result = await watcher.stop();
  assert.deepEqual(result.violations.map((v) => v.pid), [777]);
});

// Runs the real scripts/run-tests.mjs on one probe file. A stand-in `ps` comes
// first on PATH: it fails while `<dir>/ps-broken` exists and is the real /bin/ps
// otherwise. A --require hook records any process.exit() call the runner makes.
// NODE_TEST_CONTEXT is removed so this inner `node --test` is a run of its own.
async function runRunner(probeSource) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-runner-"));
  try {
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const broken = path.join(dir, "ps-broken");
    await writeFile(path.join(bin, "ps"), `#!/bin/sh\n[ -e '${broken}' ] && exit 1\nexec /bin/ps "$@"\n`);
    await chmod(path.join(bin, "ps"), 0o755);
    const probe = path.join(dir, "probe.mjs");
    await writeFile(probe, probeSource(broken));
    const exitLog = path.join(dir, "exit-calls.log");
    const hook = path.join(dir, "trace-exit.cjs");
    await writeFile(
      hook,
      [
        'if (/run-tests\\.mjs$/.test(process.argv[1] || "")) {',
        "  const realExit = process.exit;",
        "  process.exit = function (...args) {",
        '    require("node:fs").appendFileSync(process.env.EXIT_LOG, `process.exit(${args[0]})\\n`);',
        "    return realExit.apply(this, args);",
        "  };",
        "}"
      ].join("\n")
    );
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require=${hook}`,
      EXIT_LOG: exitLog
    };
    delete env.NODE_TEST_CONTEXT;
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(root, "scripts", "run-tests.mjs"), probe],
        { env, cwd: root, timeout: 60000 },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr) })
      );
    });
    return { ...result, exitCalls: await readFile(exitLog, "utf8").catch(() => "") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sleepAndBreakPs = (broken, { thenFix }) =>
  [
    'import { unlinkSync, writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(broken)}, "");`,
    "await new Promise((resolve) => setTimeout(resolve, 700));",
    thenFix ? `unlinkSync(${JSON.stringify(broken)});` : "",
    "await new Promise((resolve) => setTimeout(resolve, 100));"
  ].join("\n");

test("the runner does not call a run clean when ps stopped working: it says so and exits 1", POSIX_ONLY, async () => {
  const run = await runRunner((broken) => sleepAndBreakPs(broken, { thenFix: false }));
  assert.equal(run.code, 1);
  assert.match(run.stderr, /^no-real-agents watcher: could not check for real agents \(ps failed\), so this run is not proven clean\.$/m);
  assert.doesNotMatch(run.stdout + run.stderr, /no real agent started/);
  assert.match(run.stdout, /^# fail 0$/m, "the probe itself passed; only the proof failed");
});

test("the runner reports the polls that could not run ps, still passes when the final sweep worked, and ends without process.exit()", POSIX_ONLY, async () => {
  const run = await runRunner((broken) => sleepAndBreakPs(broken, { thenFix: true }));
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^no-real-agents watcher: no real agent started \(\d+ checks, [1-9]\d* could not run ps\)$/m);
  assert.equal(run.exitCalls, "", "the runner set process.exitCode and let the process end by itself");
});

test("a clean run prints the plain summary line, with no ps failures to mention", POSIX_ONLY, async () => {
  const run = await runRunner(() => "await new Promise((resolve) => setTimeout(resolve, 300));\n");
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^no-real-agents watcher: no real agent started \(\d+ checks\)$/m);
  assert.equal(run.exitCalls, "");
});

test("startWatcher refuses to start on Windows", { skip: isWindows ? false : "Windows only" }, async () => {
  await assert.rejects(() => startWatcher(), /not available on Windows/);
});
