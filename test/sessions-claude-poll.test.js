// SP4 Task X2b: Claude Code's own list of its sessions, `claude agents --json`, as a fallback signal
// source (spec SP4 Signals, Claude Code row: "Fallback: ... `claude agents --json` polling every
// 10 s"; rulings R12 and K19). A stub manager stands in for the real one (the manager's own tests
// cover applySignal and markNewTurn), and runCli is a fake except in one test, which runs W1's fake
// claude through the real runCli. Then the server wiring. Never a real agent.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_AGENTS_CALL_LIMIT_MS,
  CLAUDE_AGENTS_POLL_MS,
  CLAUDE_AGENTS_POLL_ON,
  createClaudeAgentsPoller,
  mapClaudeAgents
} from "../server/runtime/sessions/claude-agents-poll.js";
import { makeFakeAgentBin } from "./helpers/fake-agents.js";
import { setFakeKnob } from "./helpers/fake-knobs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POSIX = { skip: process.platform === "win32" ? "W1's fake agents are POSIX shims" : false };
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
const uuid = (digit) => `${String(digit).repeat(8)}-1111-4222-8333-${String(digit).repeat(12)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 5000, what = "a condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(10);
  }
}

// What the real manager's liveAgentSessions() gives (copies), and a record of the calls the poller makes.
function stubManager(sessions = []) {
  const listeners = new Set();
  const manager = {
    sessions,
    calls: [],
    listeners,
    liveAgentSessions(agentId = null) {
      return manager.sessions.filter((session) => agentId === null || session.agentId === agentId).map((session) => structuredClone(session));
    },
    onLiveChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    changed() {
      for (const listener of [...listeners]) listener();
    },
    applySignal(id, signal) {
      manager.calls.push(["applySignal", id, { ...signal }]);
      return true;
    },
    markNewTurn(id) {
      manager.calls.push(["markNewTurn", id]);
      return true;
    }
  };
  return manager;
}

function session(id, extra = {}) {
  return {
    id,
    agentId: "claude",
    agentSessionId: null,
    folder: "/tmp/project",
    status: "live",
    alert: null,
    pid: null,
    lastInputAt: null,
    profile: {
      command: "/fake/bin/claude",
      args: ["--session-id", uuid(9)],
      cwd: "/tmp/project",
      env: {
        HOME: "/tmp/home",
        PATH: "/usr/bin:/bin",
        AGENT_OS_SESSION_ID: id,
        AGENT_OS_HOOK_URL: `http://127.0.0.1:1/hooks/sessions/${id}`,
        AGENT_OS_HOOK_TOKEN: "made-up-hook-token"
      }
    },
    ...extra
  };
}

// A stand-in for runCli: records each call; answers `answer` (or answer(callNumber)) after delayMs,
// or { aborted: true } when the call's signal aborts first.
function fakeRunCli(answer, { delayMs = 0 } = {}) {
  let active = 0;
  let maxActive = 0;
  const run = async (command, args, options = {}) => {
    const entry = { command, args, env: options.env, cwd: options.cwd, signal: options.signal, start: Date.now(), end: null };
    run.log.push(entry);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (delayMs) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
      if (options.signal?.aborted) return { ok: false, code: null, aborted: true, stdout: "" };
      const stdout = typeof answer === "function" ? answer(run.log.length) : answer;
      return { ok: true, code: 0, aborted: false, stdout };
    } finally {
      active -= 1;
      entry.end = Date.now();
    }
  };
  run.log = [];
  run.maxActive = () => maxActive;
  return run;
}

test("mapClaudeAgents matches live Claude Code sessions by session id or pid, skips background and unknown entries, and reads malformed output as nothing", () => {
  const sessions = [
    session("s1", { agentSessionId: uuid(1), pid: 101 }),
    session("s2", { agentSessionId: uuid(2), pid: 102 }),
    session("s3", { agentSessionId: uuid(3), pid: 103 })
  ];
  const text = JSON.stringify([
    { kind: "interactive", sessionId: uuid(1).toUpperCase(), pid: 999, status: "waiting", waitingFor: "permission prompt", cwd: "/x", startedAt: 1 },
    { kind: "interactive", sessionId: uuid(7), pid: 102, status: "busy", cwd: "/x", startedAt: 1 },
    { kind: "background", id: "bg-1", sessionId: uuid(3), pid: 103, status: "busy", state: "working" },
    { kind: "interactive", sessionId: uuid(8), pid: 555, status: "idle" },
    { kind: "interactive", sessionId: uuid(3), status: "thinking" }
  ]);
  assert.deepEqual(mapClaudeAgents(text, sessions), [
    { id: "s1", status: "waiting", waitingFor: "permission prompt" },
    { id: "s2", status: "busy", waitingFor: null }
  ]);
  for (const bad of ["", "not json", "{}", "null", JSON.stringify({ sessions: "x" })]) assert.deepEqual(mapClaudeAgents(bad, sessions), [], bad);
  assert.deepEqual(mapClaudeAgents(JSON.stringify({ sessions: [{ sessionId: uuid(1), status: "idle" }] }), sessions), [{ id: "s1", status: "idle", waitingFor: null }]);
  const [waiting] = mapClaudeAgents(JSON.stringify([{ sessionId: uuid(1), status: "waiting", waitingFor: `input\x1b]0;x\x07 ${"y".repeat(100)}` }]), sessions);
  assert.ok([...waiting.waitingFor].length <= 60);
  assert.doesNotMatch(waiting.waitingFor, /[\x00-\x1f\x7f]/);
  // A session with no conversation id and no pid never matches an entry by accident.
  assert.deepEqual(mapClaudeAgents(JSON.stringify([{ status: "busy" }, { sessionId: null, pid: null, status: "busy" }]), [session("s4")]), []);
});

test("poller: no call while no Claude Code session is live; one call at a time, the next one an interval after the last ended; no call once the last one ends", async () => {
  const manager = stubManager([]);
  const run = fakeRunCli("[]", { delayMs: 60 });
  const poller = createClaudeAgentsPoller({ manager, runCli: run, intervalMs: 40, enabled: true });
  try {
    await delay(200);
    assert.equal(run.log.length, 0, "no Claude Code session: no call");
    manager.sessions.push({ ...session("c1"), agentId: "codex" });
    manager.changed();
    await delay(200);
    assert.equal(run.log.length, 0, "another agent's session does not count");
    const addedAt = Date.now();
    manager.sessions.push(session("s1"));
    manager.changed();
    await waitFor(() => run.log.length >= 3 && run.log[2].end !== null, 3000, "three calls");
    assert.ok(run.log[0].start - addedAt >= 35, "the first call waits one interval");
    assert.equal(run.maxActive(), 1, "never two calls at once");
    for (let i = 1; i < run.log.length; i += 1) {
      if (run.log[i - 1].end === null) continue;
      const gap = run.log[i].start - run.log[i - 1].end;
      assert.ok(gap >= 35, `call ${i + 1} started ${gap} ms after the last one ended`);
    }
    manager.sessions.splice(0);
    manager.changed();
    await waitFor(() => run.log.every((entry) => entry.end !== null), 2000, "the last call to end");
    const count = run.log.length;
    await delay(250);
    assert.equal(run.log.length, count, "no call once no Claude Code session is live");
  } finally {
    poller.stop();
  }
});

test("poller: argv is exactly agents --json with a live session's command and folder, and its environment without Agent OS's own variables", async () => {
  const manager = stubManager([session("s1"), session("s2", { profile: { command: "/other/claude", args: [], cwd: "/other", env: {} } })]);
  const run = fakeRunCli("[]");
  const poller = createClaudeAgentsPoller({ manager, runCli: run, intervalMs: 20, enabled: true });
  try {
    await waitFor(() => run.log.length >= 1, 2000, "a call");
  } finally {
    poller.stop();
  }
  const [call] = run.log;
  assert.equal(call.command, "/fake/bin/claude");
  assert.deepEqual(call.args, ["agents", "--json"]);
  assert.equal(call.cwd, "/tmp/project");
  assert.deepEqual(call.env, { HOME: "/tmp/home", PATH: "/usr/bin:/bin" }, "the session's own environment, without the hook address, token or session id");
  assert.ok(call.signal instanceof AbortSignal, "every call can be cut");
  assert.equal(CLAUDE_AGENTS_POLL_MS, 10000);
  assert.equal(CLAUDE_AGENTS_CALL_LIMIT_MS, 5000);
  assert.equal(typeof CLAUDE_AGENTS_POLL_ON, "boolean", "spike S1 may switch it off; every test here passes enabled: true");
});

test("poller (K19): waiting raises \"Waiting for you\", busy shows a new turn or ends the poller's own waiting, idle ends a live turn", async () => {
  const hookAlert = { kind: "waiting", text: "Wants to use Bash", at: "2026-10-29T12:00:00.000Z", source: "hook" };
  const pollAlert = { kind: "waiting", text: "Waiting for you", at: "2026-10-29T12:00:00.000Z", source: "poll" };
  const limitAlert = { kind: "limit", text: "Claude Code's plan limit was reached.", at: "2026-10-29T12:00:00.000Z", source: "status" };
  const cases = [
    ["w1", "live", null, "waiting"],
    ["w2", "waiting", hookAlert, "waiting"],
    ["w3", "held", limitAlert, "waiting"],
    ["b1", "idle", null, "busy"],
    ["b2", "waiting", pollAlert, "busy"],
    ["b3", "waiting", hookAlert, "busy"],
    ["i1", "live", null, "idle"],
    ["i2", "idle", null, "idle"],
    ["i3", "waiting", pollAlert, "idle"]
  ];
  const manager = stubManager(cases.map(([id, status, alert], index) => session(id, { agentSessionId: uuid(index + 1), status, alert })));
  const text = JSON.stringify(cases.map(([, , , status], index) => ({ kind: "interactive", sessionId: uuid(index + 1), status, waitingFor: status === "waiting" ? "permission prompt" : undefined })));
  const run = fakeRunCli((call) => (call === 1 ? text : "[]"));
  const poller = createClaudeAgentsPoller({ manager, runCli: run, intervalMs: 20, enabled: true });
  try {
    await waitFor(() => manager.calls.length >= 6, 2000, "the first answer's signals");
  } finally {
    poller.stop();
  }
  assert.deepEqual(manager.calls, [
    ["applySignal", "w1", { kind: "waiting", text: "Waiting for you", source: "poll" }],
    ["markNewTurn", "b1"],
    ["applySignal", "b2", { kind: "resolved", source: "poll" }],
    ["markNewTurn", "b3"],
    ["applySignal", "i1", { kind: "turn_done", source: "poll" }],
    ["applySignal", "i3", { kind: "turn_done", source: "poll" }]
  ]);
});

test("poller: a waiting or idle answer is dropped for a session the person typed into just before or during the call (the K6 rule for backups)", async () => {
  const now = Date.now();
  const manager = stubManager([
    session("q1", { agentSessionId: uuid(1), lastInputAt: now - 1000 }),
    session("q2", { agentSessionId: uuid(2), lastInputAt: now - 60000 }),
    session("q3", { agentSessionId: uuid(3), lastInputAt: null }),
    // Idle answers: a turn the person started while the call ran is not ended by an answer that is older than it.
    session("q4", { agentSessionId: uuid(4), lastInputAt: now - 1000 }),
    session("q5", { agentSessionId: uuid(5), lastInputAt: null }),
    session("q6", { agentSessionId: uuid(6), lastInputAt: now - 60000 })
  ]);
  const answers = { 1: "waiting", 2: "waiting", 3: "waiting", 4: "idle", 5: "idle", 6: "idle" };
  const text = JSON.stringify(Object.entries(answers).map(([digit, status]) => ({ kind: "interactive", sessionId: uuid(digit), status })));
  const run = fakeRunCli((call) => {
    if (call !== 1) return "[]";
    for (const id of ["q3", "q5"]) manager.sessions.find((candidate) => candidate.id === id).lastInputAt = Date.now(); // typed while the call ran
    return text;
  });
  const poller = createClaudeAgentsPoller({ manager, runCli: run, intervalMs: 20, enabled: true });
  try {
    await waitFor(() => run.log.length >= 2, 2000, "the first answer to be applied");
  } finally {
    poller.stop();
  }
  assert.deepEqual(manager.calls, [
    ["applySignal", "q2", { kind: "waiting", text: "Waiting for you", source: "poll" }],
    ["applySignal", "q6", { kind: "turn_done", source: "poll" }]
  ]);
});

test("poller: a slow call is cut at its limit; stop() ends the call in flight and nothing runs after; enabled: false never starts", async () => {
  const cutManager = stubManager([session("s1")]);
  const cutRun = fakeRunCli("[]", { delayMs: 60000 });
  const cutPoller = createClaudeAgentsPoller({ manager: cutManager, runCli: cutRun, intervalMs: 20, limitMs: 80, enabled: true });
  try {
    await waitFor(() => cutRun.log.length >= 1 && cutRun.log[0].end !== null, 3000, "the first call to be cut");
    assert.equal(cutRun.log[0].signal.aborted, true);
    const took = cutRun.log[0].end - cutRun.log[0].start;
    assert.ok(took >= 70 && took < 1000, `cut after ${took} ms`);
    await waitFor(() => cutRun.log.length >= 2, 3000, "the next call after the cut one");
  } finally {
    cutPoller.stop();
  }

  const slowManager = stubManager([session("s1")]);
  const slowRun = fakeRunCli("[]", { delayMs: 60000 });
  const slowPoller = createClaudeAgentsPoller({ manager: slowManager, runCli: slowRun, intervalMs: 20, limitMs: 60000, enabled: true });
  await waitFor(() => slowRun.log.length === 1, 2000, "a call in flight");
  slowPoller.stop();
  await waitFor(() => slowRun.log[0].end !== null, 2000, "the call in flight to end");
  assert.equal(slowRun.log[0].signal.aborted, true, "stop() ends the call in flight");
  await delay(150);
  assert.equal(slowRun.log.length, 1, "nothing runs after stop()");
  assert.equal(slowManager.listeners.size, 0, "stop() unsubscribes");

  const offManager = stubManager([session("s1")]);
  const offRun = fakeRunCli("[]");
  const offPoller = createClaudeAgentsPoller({ manager: offManager, runCli: offRun, intervalMs: 10, enabled: false });
  await delay(100);
  assert.equal(offRun.log.length, 0);
  assert.equal(offManager.listeners.size, 0, "a poller switched off (spike S1) never listens");
  offPoller.stop();
});

test("poller with the real runCli and W1's fake claude: the FAKE_CLAUDE_AGENTS_JSON knob is read, the argv is agents --json, and the answer becomes a signal", POSIX, async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-claude-poll-")));
  try {
    const home = path.join(base, "home");
    await mkdir(home, { recursive: true });
    const { paths } = await makeFakeAgentBin(path.join(base, "bin"), { names: ["claude"] });
    const log = path.join(base, "fake.log");
    await setFakeKnob(home, "FAKE_CLAUDE_AGENTS_JSON", JSON.stringify([
      { kind: "interactive", sessionId: uuid(1), pid: 4242, status: "waiting", waitingFor: "permission prompt", cwd: base, startedAt: Date.now() }
    ]));
    const manager = stubManager([
      session("s1", {
        agentSessionId: uuid(1),
        profile: { command: paths.claude, args: [], cwd: base, env: { HOME: home, PATH: SYSTEM_PATH, FAKE_AGENT_LOG: log, AGENT_OS_HOOK_TOKEN: "made-up-hook-token" } }
      })
    ]);
    const poller = createClaudeAgentsPoller({ manager, intervalMs: 20, enabled: true });
    try {
      await waitFor(() => manager.calls.length >= 1, 10000, "a signal from the fake's answer");
    } finally {
      poller.stop();
    }
    assert.deepEqual(manager.calls[0], ["applySignal", "s1", { kind: "waiting", text: "Waiting for you", source: "poll" }]);
    const entries = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.event === "agents");
    assert.ok(entries.length >= 1);
    for (const entry of entries) assert.deepEqual(entry.args, ["agents", "--json"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("server wiring: index.js starts one poller with the session manager and stops it at shutdown; the bundle carries the statusLine wrapper", async () => {
  const index = await readFile(path.join(root, "server", "index.js"), "utf8");
  assert.match(index, /import \{ createClaudeAgentsPoller \} from "\.\/runtime\/sessions\/claude-agents-poll\.js";/);
  assert.match(index, /import \{ installShutdownHandlers, registerShutdownTask \} from "\.\/runtime\/shutdown\.js";/);
  assert.match(index, /const claudeAgentsPoller = createClaudeAgentsPoller\(\{ manager: sessionManager \}\);/);
  assert.match(index, /registerShutdownTask\("claude-agents-poll", \(\) => claudeAgentsPoller\.stop\(\)\);/);
  assert.equal(index.match(/createClaudeAgentsPoller\(/g).length, 1, "one poller for every Claude Code session");
  const bundle = await readFile(path.join(root, "scripts", "build-server-bundle.mjs"), "utf8");
  assert.match(bundle, /await cp\(path\.join\(root, "server", "runtime", "sessions", "statusline-wrapper\.mjs"\), path\.join\(outDir, "statusline-wrapper\.mjs"\)\);/);
});
