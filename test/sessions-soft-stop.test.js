// The soft stop (SP3, Task S7): step 1 of the Stop sequence. Pure logic with
// an injected CLI runner, plus runCli with a plain Node child (never an agent).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import test from "node:test";
import {
  OPENCLAW_STOP_NOTE,
  SOFT_STOP_LIMIT_MS,
  findBackgroundAgent,
  runCli,
  runSoftStop
} from "../server/runtime/sessions/soft-stop.js";

const isWindows = process.platform === "win32";
const SKIP_POSIX = { skip: isWindows ? "process groups are POSIX-only" : false };
const CLAUDE_UUID = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

test("Claude: asks `claude agents --json` with the session's own environment and folder, then `claude stop <id>` only for this session's background entry", async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env, cwd: options.cwd, signal: options.signal });
    if (args[0] === "agents") {
      return {
        ok: true,
        code: 0,
        aborted: false,
        stdout: JSON.stringify([
          { id: "bg-other", kind: "background", sessionId: "11111111-2222-4333-8444-555555555555" },
          { id: "fg-1", kind: "interactive", sessionId: CLAUDE_UUID },
          { id: "bg-7", kind: "background", sessionId: CLAUDE_UUID }
        ])
      };
    }
    return { ok: true, code: 0, aborted: false, stdout: "" };
  };
  const env = { PATH: "/usr/bin:/bin", HOME: "/Users/someone" };
  const result = await runSoftStop({
    softStop: "claude-bg",
    command: "/fake/bin/claude",
    env,
    cwd: "/Users/someone/projects/demo",
    agentSessionId: CLAUDE_UUID,
    pid: 4242,
    run
  });
  assert.deepEqual(result, { outcome: "stopped-background", note: null });
  assert.deepEqual(calls.map((call) => call.args), [["agents", "--json"], ["stop", "bg-7"]]);
  for (const call of calls) {
    assert.equal(call.command, "/fake/bin/claude");
    assert.equal(call.env, env, "the session's environment, never the server's");
    assert.equal(call.cwd, "/Users/someone/projects/demo");
    assert.ok(call.signal instanceof AbortSignal, "every call can be cut off");
  }

  // Not a background session: nothing more is run.
  calls.length = 0;
  const quiet = async (command, args, options) => {
    calls.push({ args, options });
    return { ok: true, code: 0, aborted: false, stdout: "[]" };
  };
  assert.deepEqual(
    await runSoftStop({ softStop: "claude-bg", command: "/fake/bin/claude", env, cwd: "/", agentSessionId: CLAUDE_UUID, pid: 4242, run: quiet }),
    { outcome: "none", note: null }
  );
  assert.deepEqual(calls.map((call) => call.args), [["agents", "--json"]]);
});

test("Claude: only a background entry of this session counts, by session id or pid, and an id that reads like an option is never passed on", () => {
  assert.equal(findBackgroundAgent("not json", { agentSessionId: CLAUDE_UUID }), null);
  assert.equal(findBackgroundAgent("[]", { agentSessionId: CLAUDE_UUID }), null);
  assert.equal(
    findBackgroundAgent(JSON.stringify({ agents: [{ id: "bg-1", type: "background", pid: 4242 }] }), { agentSessionId: null, pid: 4242 }),
    "bg-1"
  );
  assert.equal(
    findBackgroundAgent(JSON.stringify({ sessions: [{ session_id: CLAUDE_UUID, kind: "Background" }] }), { agentSessionId: CLAUDE_UUID }),
    CLAUDE_UUID
  );
  assert.equal(
    findBackgroundAgent(JSON.stringify([{ id: "bg-2", kind: "background", pid: 99 }]), { agentSessionId: CLAUDE_UUID, pid: 4242 }),
    null,
    "another session's work is never stopped"
  );
  assert.equal(
    findBackgroundAgent(JSON.stringify([{ id: "--help", kind: "background", sessionId: CLAUDE_UUID }]), { agentSessionId: CLAUDE_UUID }),
    CLAUDE_UUID,
    "the safe id is used instead"
  );
  assert.equal(findBackgroundAgent(JSON.stringify([{ id: "--help", kind: "background", pid: 4242 }]), { pid: 4242 }), null);
});

test("the whole soft stop has a hard 2 s limit: when it runs out, the CLI call it started is told to stop and Stop moves on", async () => {
  assert.equal(SOFT_STOP_LIMIT_MS, 2000);
  let aborted = false;
  const hanging = (command, args, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve({ ok: false, code: null, aborted: true, stdout: "" });
        },
        { once: true }
      );
    });
  const started = Date.now();
  const result = await runSoftStop({
    softStop: "claude-bg",
    command: "/fake/bin/claude",
    env: {},
    cwd: "/",
    agentSessionId: CLAUDE_UUID,
    pid: 1,
    run: hanging,
    limitMs: 150
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { outcome: "timeout", note: null });
  assert.equal(aborted, true);
  assert.ok(elapsed >= 100 && elapsed < 1500, `${elapsed} ms`);

  // A call that ignores the signal cannot hold the step either.
  const deaf = () => new Promise(() => {});
  const again = Date.now();
  assert.deepEqual(
    await runSoftStop({ softStop: "claude-bg", command: "/fake/bin/claude", env: {}, cwd: "/", agentSessionId: CLAUDE_UUID, pid: 1, run: deaf, limitMs: 150 }),
    { outcome: "timeout", note: null }
  );
  assert.ok(Date.now() - again < 1500);
});

test("OpenClaw makes no CLI call until spike S5 and says so honestly; other agents and update sessions have no soft stop", async () => {
  let called = 0;
  const run = async () => {
    called += 1;
    return { ok: true, code: 0, aborted: false, stdout: "" };
  };
  assert.equal(OPENCLAW_STOP_NOTE, "Stopped the terminal. OpenClaw may still be finishing its last step.");
  assert.deepEqual(await runSoftStop({ softStop: "openclaw-abort", command: "/fake/bin/openclaw", env: {}, cwd: "/", run }), {
    outcome: "terminal-only",
    note: OPENCLAW_STOP_NOTE
  });
  assert.deepEqual(await runSoftStop({ softStop: null, command: "/fake/bin/hermes", env: {}, cwd: "/", run }), {
    outcome: "none",
    note: null
  });
  assert.equal(called, 0);
});

test("runCli: the CLI gets only the environment it is handed, its output is collected, and it is killed when told to stop", SKIP_POSIX, async () => {
  const previous = process.env.AGENT_OS_TOKEN;
  process.env.AGENT_OS_TOKEN = "must-not-leak";
  try {
    const printed = await runCli(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ only: process.env.ONLY_THIS || null, token: process.env.AGENT_OS_TOKEN || null }))"],
      { env: { ONLY_THIS: "yes", PATH: "/usr/bin:/bin" }, cwd: os.tmpdir() }
    );
    assert.equal(printed.ok, true);
    assert.equal(printed.code, 0);
    assert.equal(printed.aborted, false);
    assert.deepEqual(JSON.parse(printed.stdout), { only: "yes", token: null });
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_TOKEN;
    else process.env.AGENT_OS_TOKEN = previous;
  }

  const controller = new AbortController();
  let pid = null;
  let seenGone = false;
  try {
    const running = runCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { PATH: "/usr/bin:/bin" },
      cwd: os.tmpdir(),
      signal: controller.signal,
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
      }
    });
    await waitFor(() => pid !== null);
    controller.abort();
    const result = await running;
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
    await waitFor(() => !isAlive(pid), { timeoutMs: 3000 });
    seenGone = true;
  } finally {
    // A failed abort must not leave the child running after this file ends. A
    // child already seen gone is left alone: its number may be another process's.
    if (pid !== null && !seenGone && isAlive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("runCli: maxChars stops collecting output once that much has arrived (a caller that wants a short answer)", SKIP_POSIX, async () => {
  // Two writes a moment apart, so the second arrives after the limit was reached.
  const program = "process.stdout.write('a'.repeat(100), () => setTimeout(() => process.stdout.write('b'.repeat(100)), 100))";
  const run = (options) => runCli(process.execPath, ["-e", program], { env: { PATH: "/usr/bin:/bin" }, cwd: os.tmpdir(), ...options });
  assert.equal((await run({ maxChars: 50 })).stdout, "a".repeat(100), "it stops taking more once past the limit (the chunk that crossed it stays)");
  assert.equal((await run({})).stdout, "a".repeat(100) + "b".repeat(100), "without a limit of its own it keeps what a normal answer holds");
});

// A program that prints its answer and exits while a helper it started keeps
// the output pipe open (a background child that inherited stdout).
const EXITS_WHILE_HELPER_HOLDS_OUTPUT = `
const { spawn } = require("node:child_process");
const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true });
helper.unref();
process.stdout.write(JSON.stringify({ answer: "done", helper: helper.pid }), () => process.exit(0));
`;

test("runCli answers when the program exits, even while a helper it left behind still holds its output open", SKIP_POSIX, async () => {
  let helperPid = null;
  try {
    const started = Date.now();
    const result = await runCli(process.execPath, ["-e", EXITS_WHILE_HELPER_HOLDS_OUTPUT], {
      env: { PATH: "/usr/bin:/bin" },
      cwd: os.tmpdir()
    });
    const elapsed = Date.now() - started;
    try {
      helperPid = JSON.parse(result.stdout).helper;
    } catch {
      // the assertions below say what went wrong
    }
    assert.equal(result.aborted, false);
    assert.equal(result.ok, true);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).answer, "done", "the output written before the exit is kept");
    assert.ok(elapsed < 2000, `it did not wait for the helper to let go of the output (${elapsed} ms)`);
  } finally {
    // The helper ends by itself after 8 s; stop it now. It was started here and
    // has not been seen to exit, so its pid is still its own.
    if (Number.isInteger(helperPid) && helperPid > 1 && isAlive(helperPid)) process.kill(helperPid, "SIGKILL");
  }
});

test("runCli never rejects: with no file handles left there is no output pipe, and a spawn that throws is an answer too", async () => {
  // node reports EMFILE and ENFILE with an 'error' event and a child that has no streams.
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdout = null;
  const out = await runCli("/fake/bin/claude", ["agents", "--json"], { env: {}, cwd: "/", spawn: () => child });
  assert.deepEqual(out, { ok: false, code: null, aborted: false, stdout: "" });
  assert.doesNotThrow(
    () => child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })),
    "the 'error' that follows is handled, not thrown"
  );

  const thrown = await runCli("/fake/bin/claude", ["agents", "--json"], {
    env: {},
    cwd: "/",
    spawn: () => {
      throw new Error("spawn EAGAIN");
    }
  });
  assert.deepEqual(thrown, { ok: false, code: null, aborted: false, stdout: "" });
});
