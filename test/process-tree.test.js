// Process trees (spec SP3, process-tree.js changes; planning decision Q3):
// pids that node-pty starts are tracked with trackPid()/untrackPid(), the
// descendant walk finds every level below a pid, and killProcessTree()
// stops a whole tree, including a grandchild that left the process group
// with setsid. On Linux without `ps` (the Docker image), the walk reads /proc.
// The terminal test uses the fake agent from W1, never a real one.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  descendantsFromPsOutput,
  killAllTracked,
  killAllTrackedSync,
  killProcessTree,
  listDescendants,
  listTrackedPids,
  parseProcStat,
  taskkillArgs,
  trackPid,
  untrackPid
} from "../server/runtime/process-tree.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const POSIX_ONLY = { skip: isWindows ? "process groups and setsid are POSIX-only" : false };
// The only folders besides the fakes' own that a fake agent's PATH holds (R16).
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The pids this file started and has not yet seen end. The owner's own claude
// processes always run on this Mac, and a pid that is known to be gone may
// already belong to one of them, so a pid leaves this list the moment the test
// sees it end (its exit event, or isAlive() false), and the cleanup in each
// `finally` force-kills only what is still on it. `group: true` marks a process
// group leader (a detached child, or a setsid process): only then is its group
// signalled too, so a negative id is never sent for anything else.
const running = new Map();

function started(pid, { group = false } = {}) {
  if (Number.isInteger(pid) && pid > 1) running.set(pid, { group });
  return pid;
}

function ended(pid) {
  running.delete(pid);
}

function forceKill(pid) {
  const entry = running.get(pid);
  if (!entry) return;
  running.delete(pid);
  for (const target of entry.group ? [-pid, pid] : [pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

// Asserts that pid has ended, and remembers that it has.
function assertGone(pid, message) {
  assert.equal(isAlive(pid), false, message);
  ended(pid);
}

// killAllTracked() and killAllTrackedSync() signal EVERY pid this process has
// registered, not only the ones the calling test registered. If an earlier test
// left a registration behind (pid 1 after the shared guard regressed, or a pid
// whose exit subscription broke and that the system has since reused), the
// sweep would signal a process this file never started, and the owner's own
// claude processes always run on this Mac. So a test that sweeps calls this
// first, with the pids it tracked itself: when the registry holds anything
// else, the assertion throws, the test fails, and the sweep never runs. It only
// reads the registry; it signals nothing.
function assertOnlyOwnTracked(owned) {
  const strays = listTrackedPids().filter((pid) => !owned.includes(pid));
  assert.deepEqual(
    strays,
    [],
    `refusing to sweep: pids ${JSON.stringify(strays)} are still tracked, but this test did not track them`
  );
}

function pgidOf(pid) {
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
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

// The three pids a child script printed ("TREE leader same own"): the leader and
// the setsid grandchild lead their own groups, the other grandchild does not.
function treePids(match) {
  const [leader, same, own] = match.slice(1).map(Number);
  started(leader, { group: true });
  started(same);
  started(own, { group: true });
  return [leader, same, own];
}

// A leader (its own process group, like every tracked child and every PTY)
// that starts two grandchildren: one ordinary child in its group, and one
// with detached: true, which makes libuv call setsid() so it leaves the
// group. Each grandchild prints READY once it is set up (its SIGTERM handler
// installed, when GRANDCHILD_IGNORES_TERM=1), and the leader prints both pids
// only after both READY lines arrived, so no test has to guess how long a
// busy machine needs.
const LEADER_SOURCE = [
  "const { spawn } = require('node:child_process');",
  "const ignoresTerm = process.env.GRANDCHILD_IGNORES_TERM === '1';",
  "const body = (ignoresTerm ? \"process.on('SIGTERM', () => {}); \" : '') + \"setInterval(() => {}, 1000); console.log('READY');\";",
  "const same = spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'pipe', 'ignore'] });",
  "const own = spawn(process.execPath, ['-e', body], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });",
  "let ready = 0;",
  "for (const grandchild of [same, own]) {",
  "  grandchild.stdout.once('data', () => {",
  "    ready += 1;",
  "    if (ready === 2) console.log('PIDS ' + same.pid + ' ' + own.pid);",
  "  });",
  "}",
  "setInterval(() => {}, 1000);"
].join("\n");

async function startLeader(extraEnv = {}) {
  const leader = spawn(process.execPath, ["-e", LEADER_SOURCE], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ...extraEnv }
  });
  let buffer = "";
  leader.stdout.on("data", (chunk) => {
    buffer += chunk;
  });
  started(leader.pid, { group: true });
  leader.once("exit", () => ended(leader.pid));
  try {
    const match = await waitUntil(() => buffer.match(/PIDS (\d+) (\d+)/), "the leader's grandchild pids");
    return { leader, sameGroup: started(Number(match[1])), ownSession: started(Number(match[2]), { group: true }) };
  } catch (error) {
    forceKill(leader.pid);
    throw error;
  }
}

test("descendantsFromPsOutput walks every level below a pid and nothing else", () => {
  const text = ["    1     0", "   10     1", "   11    10", "   12    11", "   13    10", "   20     1", "   21    20", "garbage", ""].join(
    "\n"
  );
  assert.deepEqual(
    descendantsFromPsOutput(text, 10).sort((a, b) => a - b),
    [11, 12, 13]
  );
  assert.deepEqual(descendantsFromPsOutput(text, 12), []);
  assert.deepEqual(descendantsFromPsOutput("", 10), []);
});

test("parseProcStat reads the pid and ppid even when the command name holds spaces and ')'", () => {
  assert.deepEqual(parseProcStat("4242 (node) S 17 4242 4242 0 -1 4194560 120 0 0 0\n"), { pid: 4242, ppid: 17 });
  // The name "my tool) R 5 (x": counting from the first ")" would read ppid 5.
  assert.deepEqual(parseProcStat("77 (my tool) R 5 (x) S 1 77 77 0 -1"), { pid: 77, ppid: 1 });
  assert.deepEqual(parseProcStat("78 (a) b) S 9 78 78"), { pid: 78, ppid: 9 });
  for (const bad of ["", "garbage", "12 (sh)", "12 sh S 1", "x (sh) S 1", "12 (sh) S", null, undefined]) {
    assert.equal(parseProcStat(bad), null, JSON.stringify(bad));
  }
});

// Pure checks: nothing here signals anything. Pid 1 and -1 would reach every
// process the owner has, and this process's own pid would stop the server.
const NEVER_A_TARGET = [1, -1, 0, 1.5, Number.NaN, undefined, null, "123", process.pid];

test("trackPid ignores anything that is not a real pid, pid 1 and this process included", () => {
  const before = listTrackedPids();
  try {
    for (const bad of NEVER_A_TARGET) trackPid(bad);
    assert.deepEqual(listTrackedPids(), before);
  } finally {
    // If the guard ever regresses, this test fails; it must not also leave pid 1
    // registered for the sweeps further down. untrackPid() takes any key, NaN included.
    for (const bad of NEVER_A_TARGET) untrackPid(bad);
  }
});

test("the refusal test above leaves nothing registered for a later sweep", () => {
  assert.deepEqual(listTrackedPids(), []);
});

test("the sweep guard refuses a registration the test did not make, and signals nothing", POSIX_ONLY, () => {
  // A sleeper this test started stands in for a stray registration.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  started(sleeper.pid, { group: true });
  sleeper.once("exit", () => ended(sleeper.pid));
  try {
    assertOnlyOwnTracked([]); // nothing registered yet
    trackPid(sleeper.pid);
    assert.throws(
      () => assertOnlyOwnTracked([]),
      (error) => error.message.includes("refusing to sweep") && error.message.includes(String(sleeper.pid))
    );
    assert.doesNotThrow(() => assertOnlyOwnTracked([sleeper.pid]));
    assert.equal(isAlive(sleeper.pid), true, "the guard only reads the registry");
  } finally {
    untrackPid(sleeper.pid);
    forceKill(sleeper.pid);
  }
});

test("killProcessTree and listDescendants refuse pid 1, negative, zero, fractional, NaN, undefined and this process", async () => {
  // process.kill is replaced by a recorder for the length of this test, so even
  // a regression could not signal anything: it would only show up as a call.
  const realKill = process.kill;
  const calls = [];
  process.kill = (...args) => {
    calls.push(args);
    return true;
  };
  try {
    for (const bad of NEVER_A_TARGET) {
      assert.deepEqual(await listDescendants(bad), [], `listDescendants(${String(bad)}) walked a tree`);
      await killProcessTree(bad, { graceMs: 50 });
    }
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(calls, [], "a refused pid must not be signalled, not even with signal 0");
});

test("taskkillArgs builds one Windows command line for every pid (the exit sweep runs one taskkill)", () => {
  assert.deepEqual(taskkillArgs([4242, 4343]), ["/T", "/F", "/PID", "4242", "/PID", "4343"]);
  assert.deepEqual(taskkillArgs([7]), ["/T", "/F", "/PID", "7"]);
});

test("listDescendants finds both grandchildren, including the one that called setsid", POSIX_ONLY, async () => {
  const { leader, sameGroup, ownSession } = await startLeader();
  try {
    assert.notEqual(pgidOf(ownSession), pgidOf(leader.pid), "the setsid grandchild left the leader's process group");
    assert.equal(pgidOf(sameGroup), pgidOf(leader.pid));
    const found = await listDescendants(leader.pid);
    assert.ok(found.includes(sameGroup));
    assert.ok(found.includes(ownSession));
    assert.equal(found.includes(leader.pid), false);
  } finally {
    forceKill(ownSession);
    forceKill(sameGroup);
    forceKill(leader.pid);
  }
});

test("killProcessTree stops a grandchild that moved into its own session (setsid)", POSIX_ONLY, async () => {
  const { leader, sameGroup, ownSession } = await startLeader();
  try {
    await killProcessTree(leader.pid, { graceMs: 1500 });
    assertGone(sameGroup);
    assertGone(ownSession, "a signal to the process group alone would miss this one");
    await waitUntil(() => leader.exitCode !== null || leader.signalCode !== null, "the leader's exit");
  } finally {
    forceKill(ownSession);
    forceKill(sameGroup);
    forceKill(leader.pid);
  }
});

test("killProcessTree sends SIGKILL after the grace period to a setsid grandchild that ignores SIGTERM", POSIX_ONLY, async () => {
  const { leader, sameGroup, ownSession } = await startLeader({ GRANDCHILD_IGNORES_TERM: "1" });
  try {
    // startLeader() returned only after both grandchildren printed READY, so
    // both already ignore SIGTERM: only SIGKILL can stop them.
    assert.equal(isAlive(sameGroup), true);
    assert.equal(isAlive(ownSession), true);
    const begun = Date.now();
    await killProcessTree(leader.pid, { graceMs: 500 });
    assert.ok(Date.now() - begun >= 450, "it waited for the grace period before SIGKILL");
    assertGone(sameGroup);
    assertGone(ownSession);
  } finally {
    forceKill(ownSession);
    forceKill(sameGroup);
    forceKill(leader.pid);
  }
});

test("killAllTracked stops a tracked pid and its whole tree, then forgets every pid", POSIX_ONLY, async () => {
  const { leader, sameGroup, ownSession } = await startLeader();
  // A second pid, tracked with no exit subscription: only killAllTracked() itself
  // can make it forget the pid (the leader's own exit subscription untracks it first).
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  started(sleeper.pid, { group: true });
  sleeper.once("exit", () => ended(sleeper.pid));
  try {
    trackPid(leader.pid, (listener) => leader.once("exit", listener));
    trackPid(sleeper.pid);
    assert.ok(listTrackedPids().includes(leader.pid));
    assert.ok(listTrackedPids().includes(sleeper.pid));
    assertOnlyOwnTracked([leader.pid, sleeper.pid]);
    await killAllTracked({ graceMs: 1000 });
    assertGone(sameGroup);
    assertGone(ownSession);
    assertGone(sleeper.pid, "a tracked pid is stopped too");
    assert.equal(listTrackedPids().includes(leader.pid), false);
    assert.equal(listTrackedPids().includes(sleeper.pid), false, "killAllTracked forgets pids that have no exit subscription");
  } finally {
    untrackPid(leader.pid);
    untrackPid(sleeper.pid);
    forceKill(ownSession);
    forceKill(sameGroup);
    forceKill(leader.pid);
    forceKill(sleeper.pid);
  }
});

test("untrackPid takes a pid out of the shutdown sweep", POSIX_ONLY, async () => {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  started(sleeper.pid, { group: true });
  sleeper.once("exit", () => ended(sleeper.pid));
  try {
    trackPid(sleeper.pid);
    untrackPid(sleeper.pid);
    assertOnlyOwnTracked([sleeper.pid]);
    await killAllTracked({ graceMs: 200 });
    assert.equal(isAlive(sleeper.pid), true);
  } finally {
    forceKill(sleeper.pid);
  }
});

test("a pid tracked with an exit subscription untracks itself when the process ends", POSIX_ONLY, async () => {
  const brief = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], { stdio: "ignore" });
  trackPid(brief.pid, (listener) => brief.once("exit", listener));
  assert.ok(listTrackedPids().includes(brief.pid));
  await new Promise((resolve) => brief.once("exit", resolve));
  assert.equal(listTrackedPids().includes(brief.pid), false);
});

test("killAllTrackedSync (the last-resort exit sweep) also reaches a setsid grandchild", POSIX_ONLY, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-tree-sync-"));
  const script = path.join(dir, "sweep.mjs");
  const processTree = pathToFileURL(path.join(root, "server", "runtime", "process-tree.js")).href;
  const source = [
    'import { spawn } from "node:child_process";',
    `import { killAllTrackedSync, trackPid } from ${JSON.stringify(processTree)};`,
    `const leader = spawn(process.execPath, ["-e", ${JSON.stringify(LEADER_SOURCE)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });`,
    'trackPid(leader.pid, (listener) => leader.once("exit", listener));',
    'let buffer = "";',
    "let swept = false;",
    'leader.stdout.on("data", (chunk) => {',
    "  buffer += chunk;",
    "  const match = buffer.match(/PIDS (\\d+) (\\d+)/);",
    "  if (!match || swept) return;",
    "  swept = true;",
    '  console.log("TREE " + leader.pid + " " + match[1] + " " + match[2]);',
    "  setTimeout(() => { killAllTrackedSync(); process.exit(0); }, 300);",
    "});"
  ].join("\n");
  await writeFile(script, source);
  let pids = [];
  try {
    const output = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 15000 });
    pids = treePids(output.match(/TREE (\d+) (\d+) (\d+)/));
    await waitUntil(() => pids.every((pid) => !isAlive(pid)), "the whole tree to be gone", 3000);
    pids.forEach(ended);
  } finally {
    for (const pid of pids) forceKill(pid);
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "killAllTrackedSync also stops a setsid grandchild that a killProcessTree call found, after its leader exited and was untracked",
  POSIX_ONLY,
  async () => {
    // The sessions task is cut off at 7 s and killAllTracked() is still waiting out
    // its grace when the 8 s hard exit runs the sweep: the agent has exited (so it
    // is no longer tracked), but its setsid grandchild ignores SIGTERM and lives.
    const { leader, sameGroup, ownSession } = await startLeader({ GRANDCHILD_IGNORES_TERM: "1" });
    let inFlight = null;
    try {
      // The leader is never tracked here: the only thing that knows the
      // grandchildren is the call that already listed and signalled them.
      inFlight = killProcessTree(leader.pid, { graceMs: 10000 });
      await waitUntil(() => leader.exitCode !== null || leader.signalCode !== null, "the leader's exit");
      assert.equal(isAlive(ownSession), true, "the grandchild ignores SIGTERM, so it outlived its leader");
      // This test tracks no pid, so the sweep may find none: a stray registration
      // from an earlier test would be SIGKILLed along with the grandchildren.
      assertOnlyOwnTracked([]);
      killAllTrackedSync();
      await waitUntil(() => !isAlive(ownSession) && !isAlive(sameGroup), "the sweep to stop both grandchildren", 3000);
      ended(ownSession);
      ended(sameGroup);
      await inFlight; // everything is gone, so the call finishes by itself, well before its grace
      inFlight = null;
    } finally {
      forceKill(ownSession);
      forceKill(sameGroup);
      forceKill(leader.pid);
      if (inFlight) await inFlight;
    }
  }
);

test("killAllTrackedSync starts no ps when nothing is tracked, and runs /bin/ps on macOS when something is", POSIX_ONLY, async () => {
  // A child script counts the commands the module starts (child_process is
  // wrapped before the module is loaded) and tracks one sleeper it started.
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-tree-spy-"));
  const script = path.join(dir, "spy.mjs");
  const processTree = pathToFileURL(path.join(root, "server", "runtime", "process-tree.js")).href;
  const source = [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const seen = [];",
    "const { spawnSync, execFile, spawn } = childProcess;",
    'childProcess.spawnSync = (command, ...rest) => { seen.push("spawnSync " + command); return spawnSync(command, ...rest); };',
    'childProcess.execFile = (command, ...rest) => { seen.push("execFile " + command); return execFile(command, ...rest); };',
    "syncBuiltinESMExports();",
    `const { killAllTrackedSync, listDescendants, trackPid } = await import(${JSON.stringify(processTree)});`,
    "killAllTrackedSync();",
    'console.log("IDLE " + JSON.stringify(seen));',
    "seen.length = 0;",
    'const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    'console.log("SLEEPER " + sleeper.pid);',
    "trackPid(sleeper.pid);",
    "await listDescendants(sleeper.pid);",
    "killAllTrackedSync();",
    'console.log("BUSY " + JSON.stringify(seen));'
  ].join("\n");
  await writeFile(script, source);
  let sleeper = null;
  try {
    const output = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 15000 });
    sleeper = started(Number(output.match(/SLEEPER (\d+)/)[1]), { group: true });
    assert.equal(output.match(/IDLE (.*)/)[1], "[]", "nothing tracked: the sweep must return before it runs ps");
    const busy = JSON.parse(output.match(/BUSY (.*)/)[1]);
    const ps = process.platform === "darwin" ? "/bin/ps" : "ps";
    assert.ok(busy.includes(`execFile ${ps}`), `the walk runs ${ps}: ${busy}`);
    assert.ok(busy.includes(`spawnSync ${ps}`), `the exit sweep runs ${ps}: ${busy}`);
    await waitUntil(() => !isAlive(sleeper), "the tracked sleeper to be stopped by the sweep", 3000);
    ended(sleeper);
  } finally {
    forceKill(sleeper);
    await rm(dir, { recursive: true, force: true });
  }
});

// The Docker image has no `ps`. A server whose PATH holds only an empty folder
// cannot run `ps` either, so both the async walk and the exit sweep must fall
// back to /proc and still find (and stop) the setsid grandchild.
// On macOS the same script proves the other half of the rule: /bin/ps is run by
// its full path, so a PATH without /bin (one a launcher built) still finds the
// setsid grandchild.
test(
  "with no ps on PATH, Linux reads /proc and macOS runs /bin/ps, in the walk and in the exit sweep",
  { skip: ["linux", "darwin"].includes(process.platform) ? false : "only Linux (/proc) and macOS (/bin/ps) have a fallback" },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-tree-proc-"));
    const emptyBin = path.join(dir, "empty-bin");
    await mkdir(emptyBin);
    const script = path.join(dir, "no-ps.mjs");
    const processTree = pathToFileURL(path.join(root, "server", "runtime", "process-tree.js")).href;
    const source = [
      'import { spawn } from "node:child_process";',
      `import { killAllTrackedSync, listDescendants, trackPid } from ${JSON.stringify(processTree)};`,
      `const leader = spawn(process.execPath, ["-e", ${JSON.stringify(LEADER_SOURCE)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });`,
      'trackPid(leader.pid, (listener) => leader.once("exit", listener));',
      'let buffer = "";',
      "let started = false;",
      'leader.stdout.on("data", async (chunk) => {',
      "  buffer += chunk;",
      "  const match = buffer.match(/PIDS (\\d+) (\\d+)/);",
      "  if (!match || started) return;",
      "  started = true;",
      '  console.log("TREE " + leader.pid + " " + match[1] + " " + match[2]);',
      "  const found = await listDescendants(leader.pid);",
      '  console.log("FOUND " + found.join(" ") + " END");',
      "  killAllTrackedSync();",
      "  process.exit(0);",
      "});"
    ].join("\n");
    await writeFile(script, source);
    let pids = [];
    try {
      const output = execFileSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, PATH: emptyBin }
      });
      pids = treePids(output.match(/TREE (\d+) (\d+) (\d+)/));
      const found = output.match(/FOUND ([\d ]*) END/)[1].split(" ").filter(Boolean).map(Number);
      assert.ok(found.includes(pids[1]), `the grandchild in the leader's group was not found: ${output}`);
      assert.ok(found.includes(pids[2]), `the setsid grandchild was not found: ${output}`);
      assert.equal(found.includes(pids[0]), false);
      await waitUntil(() => pids.every((pid) => !isAlive(pid)), "the whole tree to be gone", 3000);
      pids.forEach(ended);
    } finally {
      for (const pid of pids) forceKill(pid);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "killProcessTree stops a fake agent in a real terminal and the grandchild it moved into its own session",
  POSIX_ONLY,
  async () => {
    const pty = require("node-pty");
    // Real path: on macOS os.tmpdir() sits behind a symlink (Global Constraints).
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-tree-pty-")));
    // All six fake agents, first on PATH (R16); the claude shim is the one started.
    const bin = await makeFakeAgentBin(path.join(dir, "bin"), { mode: "setsid-grandchild" });
    const pidFile = path.join(dir, "grandchild.pid");
    const term = pty.spawn(bin.paths.claude, ["--session-id", "11111111-2222-4333-8444-555555555555"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: dir,
      env: {
        PATH: [bin.dir, ...SYSTEM_PATH_DIRS].join(path.delimiter),
        HOME: dir,
        // Only recorded by the fake, never run; still W1's stand-in, never a real shell (R15).
        SHELL: FAKE_LOGIN_SHELL,
        TERM: "xterm-256color",
        FAKE_AGENT_PIDFILE: pidFile
      }
    });
    let exitInfo = null;
    term.onExit((info) => {
      exitInfo = info;
    });
    trackPid(term.pid, (listener) => term.onExit(() => listener()));
    let grandchild = null;
    try {
      grandchild = await waitUntil(() => {
        if (!existsSync(pidFile)) return null;
        const pid = Number(readFileSync(pidFile, "utf8"));
        return pid > 0 ? pid : null;
      }, "the fake agent's grandchild pid file");
      started(grandchild, { group: true });
      assert.notEqual(pgidOf(grandchild), pgidOf(term.pid), "the grandchild left the terminal's process group");
      assert.ok((await listDescendants(term.pid)).includes(grandchild));

      await killProcessTree(term.pid, { graceMs: 3000 });
      await waitUntil(() => exitInfo, "node-pty's exit event");
      assertGone(grandchild);
      assert.equal(listTrackedPids().includes(term.pid), false, "the exit event untracked the pid");
    } finally {
      forceKill(grandchild);
      // term.kill() signals the pid node-pty started, so only while it has not exited.
      if (!exitInfo) {
        try {
          term.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      untrackPid(term.pid);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test("listDescendants returns nothing on Windows, where taskkill /T walks the tree", { skip: isWindows ? false : "Windows only" }, async () => {
  assert.deepEqual(await listDescendants(process.pid), []);
});
