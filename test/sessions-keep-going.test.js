// Plan ran out, keep going (SP4, Task X10): server/runtime/sessions/keep-going.js and its three routes.
//
// The typed summary (ruling R24); what keeping going would do and cost, from continue.js's own options with a
// local stand-in for openrouter.ai's model prices; Claude Code's stop-then-resume on the OpenRouter brain (K15,
// R26); Codex's new session with the summary typed into it later; Cursor's hand-over; and the routes. A stub
// session manager stands in for the real one (test/sessions-manager.test.js tests the manager's half), so no
// terminal and no process starts. Temp HOME and AGENT_OS_HOME, the key in its private file (AGENT_OS_KEYSTORE=file;
// under node --test the Keychain is never touched anyway), and no real network: AGENT_OS_SETUP_MIRROR points
// openrouter.ai at the stand-in below. Never a real agent.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { brainError } from "../server/runtime/builders/brain-launch.js";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { forgetOpenRouterKey, storeOpenRouterKey } from "../server/runtime/secrets/keystore.js";
import { sessionError } from "../server/runtime/sessions/errors.js";
import { TYPED_MAX_BYTES } from "../server/runtime/sessions/handoff.js";
import {
  SUMMARY_MAX_LINES,
  buildTypedSummary,
  handOver,
  keepGoing,
  keepGoingInfo,
  summaryHeader
} from "../server/runtime/sessions/keep-going.js";
import { BUSY_MESSAGE, LOOK_ONLY_MESSAGE } from "../server/runtime/sessions/manager.js";
import { matchScreenLimit } from "../server/runtime/sessions/mirror-signals.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";

const HELD_ID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
const NEW_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const OPEN_ID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const CLAUDE_CONVERSATION = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
const KEY = "sk-or-v1-KEEPGOINGTEST-not-real-4321";
const DEFAULT_CLAUDE_MODEL = "~anthropic/claude-sonnet-latest";
const CLAUDE_MODEL = "anthropic/claude-sonnet-4.6";
const CODEX_MODEL = "openai/gpt-5.6-codex";
// Dollars per token, as openrouter.ai lists them (3 and 1.25 dollars per million input tokens).
const CATALOG = {
  [DEFAULT_CLAUDE_MODEL]: { prompt: "0.000003", completion: "0.000015" },
  [CLAUDE_MODEL]: { prompt: "0.000003", completion: "0.000015" },
  [CODEX_MODEL]: { prompt: "0.00000125", completion: "0.00001" }
};
const BRAINS = {
  claude: { mode: "plan", model: null },
  codex: { mode: "openrouter", model: CODEX_MODEL },
  cursor: { mode: "plan", model: null },
  onLimit: "ask",
  perRunBudgetUsd: null
};
// continue.js's own sentences (existing; this task only reuses them).
const KEY_SENTENCE = 'Save your OpenRouter key first ("Remember my OpenRouter key").';
const FORK_NOTE = "Claude reads the whole conversation again without the cache. This is what that first read costs; the new work costs extra.";
const FORK_WARNING = "Continuing re-reads the whole conversation at full price, with no cache discount.";
const SUMMARY_NOTE = "This is what reading the summary costs; the new work costs extra.";
const CODEX_WARNING = "Codex starts a new session with a summary; it can't pick up the old one on another provider.";
// This task's sentences (Notes 3).
const NOT_HELD = "Keep going is offered only when the plan ran out.";
const NOT_ON_PLAN = "This session isn't using your plan, so there's no plan limit to get past.";
const INVALID_TARGET = "Agent OS can hand this only to Claude Code or Codex.";
const NOT_CURSOR = "Only a Cursor session is handed over this way.";
const CURSOR_ENDED = "This Cursor session has ended, so there is no screen to hand over.";
const KEYS = ["agentId", "approach", "available", "reason", "model", "estimateUsd", "estimateTokens", "estimateNote", "warnings", "needsKey"];

const tick = () => new Promise((resolve) => setImmediate(resolve));

let mirror = null;
let home = "";
let agentOsHome = "";
let FOLDER = "";
let OTHER = "";
const savedEnv = {};

before(async () => {
  mirror = http.createServer((req, res) => {
    const url = new URL(req.url, "http://mirror.local");
    const prefix = "/openrouter.ai/api/v1/model/";
    const id = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : "";
    const found = CATALOG[id];
    res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(found ? { data: { id, name: id, context_length: 200000, pricing: found } } : { error: { message: "No such model" } }));
  });
  await new Promise((resolve) => mirror.listen(0, "127.0.0.1", resolve));
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-keep-going-home-")));
  agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-keep-going-data-")));
  FOLDER = path.join(home, "projects", "my-app");
  OTHER = path.join(home, "projects", "other");
  await mkdir(FOLDER, { recursive: true });
  await mkdir(OTHER, { recursive: true });
  const vars = {
    HOME: home,
    USERPROFILE: home,
    AGENT_OS_HOME: agentOsHome,
    HERMES_AGENT_OS_HOME: undefined,
    AGENT_OS_KEYSTORE: "file",
    AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirror.address().port}`,
    DEMO_PUBLIC: undefined,
    HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
    HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
    HERMES_AGENT_OS_PUBLIC_MODE: undefined
  };
  for (const [name, value] of Object.entries(vars)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  mirror?.closeAllConnections?.();
  await new Promise((resolve) => mirror.close(resolve));
  await rm(home, { recursive: true, force: true });
  await rm(agentOsHome, { recursive: true, force: true });
});

// A session summary as the manager answers it (keep-going.js reads only some of these keys).
function summary(over = {}) {
  return {
    id: HELD_ID,
    kind: "agent",
    agentId: "claude",
    agentLabel: "Claude Code",
    folder: FOLDER,
    folderName: "my-app",
    folderShown: true,
    status: "held",
    stateSince: "2026-10-29T10:00:00.000Z",
    brain: { kind: "plan", label: "Plan" },
    resetAt: "2026-10-29T13:45:00.000Z",
    alert: { kind: "limit", text: "Claude Code's plan limit was reached.", at: "2026-10-29T10:00:00.000Z" },
    meter: {
      model: "Opus",
      contextPercent: 70,
      contextTokens: 140000,
      plan: { usedPercent: 100, resetsAt: "2026-10-29T13:45:00.000Z" },
      weekly: null,
      costUsd: 3.5,
      at: "2026-10-29T10:00:00.000Z"
    },
    ...over
  };
}

const LABELS = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

// The manager methods keep-going.js uses, recorded in order. A summary whose status is not "exited" is running
// (liveAgentSessions lists it). `ready` holds the ids readyForTyping answers true for.
function stubManager(sessions = [summary()], { screen = "", ready = [], conversation = CLAUDE_CONVERSATION, createError = null, createGate = null } = {}) {
  const byId = new Map(sessions.map((s) => [s.id, { ...s }]));
  const calls = [];
  return {
    calls,
    async get(id) {
      calls.push(["get", id]);
      const found = byId.get(id);
      if (!found) throw sessionError(404, "unknown_session", "That session doesn't exist anymore.");
      return { ...found };
    },
    liveAgentSessions(agentId = null) {
      return [...byId.values()]
        .filter((s) => s.kind === "agent" && s.status !== "exited" && (agentId === null || s.agentId === agentId))
        .map((s) => ({
          id: s.id,
          agentId: s.agentId,
          agentSessionId: s.agentId === "claude" ? conversation : null,
          folder: s.folder,
          status: s.status,
          alert: s.alert ?? null,
          pid: 4242,
          profile: { command: `/fake/bin/${s.agentId}`, args: [], cwd: s.folder, env: {} }
        }));
    },
    screenText(id) {
      calls.push(["screenText", id]);
      return screen;
    },
    async stop(id, options) {
      calls.push(["stop", id, options]);
      byId.get(id).status = "exited";
      return { ...byId.get(id), note: null };
    },
    async resume(id, options) {
      calls.push(["resume", id, options]);
      byId.get(id).status = "starting";
      return { ...byId.get(id) };
    },
    async create(input) {
      calls.push(["create", input]);
      if (createGate) await createGate;
      if (createError) throw createError;
      const made = summary({
        id: NEW_ID,
        agentId: input.agentId,
        agentLabel: LABELS[input.agentId],
        folder: input.folder,
        status: "starting",
        resetAt: null,
        alert: null,
        meter: null
      });
      byId.set(NEW_ID, made);
      // A session that was just made takes typed text at once (its terminal is ready).
      ready.push(NEW_ID);
      return { ...made };
    },
    readyForTyping(id) {
      calls.push(["readyForTyping", id]);
      return ready.includes(id);
    },
    // handoff.js's own delivery (handTyped, deliverTyped) asks these.
    typeInto(id, text, options) {
      calls.push(["typeInto", id, text, options]);
      if (!ready.includes(id)) return { ok: false, reason: "no_paste_mode" };
      byId.get(id).handoff = { state: "typed", text, fromId: options?.fromId ?? null };
      return { ok: true };
    },
    setHandoff(id, handoff) {
      calls.push(["setHandoff", id, handoff.state]);
      const found = byId.get(id);
      if (found) found.handoff = handoff;
    },
    async whenReadyForTyping(id, waitMs) {
      calls.push(["whenReadyForTyping", id, waitMs]);
      return ready.includes(id);
    },
    // A session that ended on its own (not through stop(), which the tests count).
    end(id) {
      byId.get(id).status = "exited";
    }
  };
}

const named = (manager, ...names) => manager.calls.filter(([name]) => names.includes(name));

// What keep-going.js asks outside the manager. loadBrains, the key helper, the gate, resolveBrain and the typing are
// fakes; the two options are continue.js's real ones (with the price stand-in), so every estimate is continue.js's own.
function fakeDeps(over = {}) {
  const seen = [];
  return {
    seen,
    loadBrains: async () => ({ ...BRAINS }),
    keyHelper: async () => ({ backend: "file", command: process.execPath, args: ["print-key.mjs"] }),
    isExecutionAllowed: async () => true,
    resolveBrain: async (agentId, override) => {
      seen.push(["resolveBrain", agentId, override]);
      return override;
    },
    deliverTyped: async (_manager, targetId, text, options) => {
      seen.push(["deliverTyped", targetId, text, options]);
      return "typed";
    },
    ...over
  };
}

const cursorSession = (over = {}) =>
  summary({ agentId: "cursor", agentLabel: "Cursor", status: "live", resetAt: null, alert: null, meter: null, ...over });

// The real sessions router on a real port, mounted the way server/index.js mounts it, with fake keep-going deps.
async function withKeepGoingApp(manager, deps, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager, keepGoingDeps: deps }));
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

// ---- the typed summary (R24) ----------------------------------------------------------------------------

test("summaryHeader: the fixed one-line header of every typed summary (R24)", () => {
  assert.equal(summaryHeader("Codex", "/Users/you/projects/my-app"), "Picking up from Codex. Folder: /Users/you/projects/my-app. Its last screen:");
  assert.equal(SUMMARY_MAX_LINES, 60);
});

test("buildTypedSummary: the header, then the last 60 lines of the screen without the blank rows around them, each at most 500 characters, through the hand-off clean-up", () => {
  const rows = ["", "", "   ", ...Array.from({ length: 80 }, (_, i) => `line ${i + 1}`), "", "", "", ""];
  const text = buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: rows.join("\n") });
  const lines = text.split("\n");
  assert.equal(lines[0], summaryHeader("Codex", FOLDER));
  assert.deepEqual(lines.slice(1), Array.from({ length: 60 }, (_, i) => `line ${i + 21}`));

  // Blank rows inside the screen stay (they were on it); the ones around it go.
  assert.equal(
    buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: "\n\nfirst\n\nsecond\n\n" }),
    `${summaryHeader("Codex", FOLDER)}\nfirst\n\nsecond`
  );
  // A long row is cut to 500 characters, counted as code points, so an emoji is never split.
  const long = buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: "😀".repeat(600) });
  assert.equal(Array.from(long.split("\n")[1]).length, 500);
  // Control characters never reach the target: no ESC, no BEL, no carriage return (cleanTypedText).
  const dirty = buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: "red \x1b[31mtext\x07\r\nnext" });
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(dirty), false, JSON.stringify(dirty));
  assert.ok(dirty.endsWith("\nred [31mtext\nnext"), JSON.stringify(dirty));
  // Nothing on the screen: the header alone.
  assert.equal(buildTypedSummary({ agentLabel: "Cursor", folder: FOLDER, screenText: "" }), summaryHeader("Cursor", FOLDER));
});

test("buildTypedSummary: a line with a plan limit sentence is left out, so typing the summary can never make the new session look held (X1b's screen rules)", () => {
  const screen = [
    "› fix the failing test",
    "■ You’ve hit your usage limit. Try again at 3:45 PM.",
    "You've hit your session limit · resets 3:45pm",
    "Usage limit reached",
    "• Ran npm test"
  ].join("\n");
  const text = buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: screen });
  assert.deepEqual(text.split("\n").slice(1), ["› fix the failing test", "• Ran npm test"]);
  assert.equal(matchScreenLimit("codex", text), null);
  assert.equal(matchScreenLimit("claude", text), null);
});

test("buildTypedSummary: never more than the hand-off's 32 KB, and never a carriage return or ESC", () => {
  const screen = Array.from({ length: 60 }, () => "é".repeat(500)).join("\n");
  const text = buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: screen });
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(bytes <= TYPED_MAX_BYTES, String(bytes));
  assert.ok(bytes > TYPED_MAX_BYTES - 4, `cut at the limit, not far before it (${bytes})`);
  assert.equal(/[\r\x1b]/.test(text), false);
});

// ---- what keeping going would do and cost ---------------------------------------------------------------

test("keepGoingInfo, Claude Code: resume on OpenRouter with continue.js's own option: Claude's default model (or the saved OpenRouter one), the estimate from the Live meter's context tokens, its note and its warning", async () => {
  const manager = stubManager();
  const info = await keepGoingInfo(manager, HELD_ID, fakeDeps());
  assert.deepEqual(Object.keys(info).sort(), [...KEYS].sort());
  assert.deepEqual(info, {
    agentId: "claude",
    approach: "resume",
    available: true,
    reason: null,
    model: DEFAULT_CLAUDE_MODEL,
    estimateUsd: 0.42,
    estimateTokens: 140000,
    estimateNote: FORK_NOTE,
    warnings: [FORK_WARNING],
    needsKey: false
  });
  assert.ok(manager.calls.every(([name]) => name === "get"), "asking stops, starts and types nothing");

  const saved = await keepGoingInfo(stubManager(), HELD_ID, fakeDeps({ loadBrains: async () => ({ ...BRAINS, claude: { mode: "openrouter", model: CLAUDE_MODEL } }) }));
  assert.deepEqual([saved.available, saved.model, saved.estimateUsd], [true, CLAUDE_MODEL, 0.42]);

  // Without a Live meter reading there is no estimate; keeping going is still offered.
  const noMeter = await keepGoingInfo(stubManager([summary({ meter: null })]), HELD_ID, fakeDeps());
  assert.deepEqual([noMeter.available, noMeter.estimateUsd, noMeter.estimateTokens], [true, null, null]);
});

test("keepGoingInfo, Claude Code: an OpenRouter model that isn't Anthropic's can't carry the conversation; no saved key asks for one (needsKey); a session not on the plan has no limit to get past; no conversation id can't resume", async () => {
  const notAnthropic = await keepGoingInfo(stubManager(), HELD_ID, fakeDeps({ loadBrains: async () => ({ ...BRAINS, claude: { mode: "openrouter", model: "openai/gpt-5.5" } }) }));
  assert.deepEqual(
    [notAnthropic.available, notAnthropic.reason, notAnthropic.needsKey, notAnthropic.model],
    [false, "Continuing a Claude conversation only works with Claude models. Pick an Anthropic model for Claude Code on OpenRouter.", false, "openai/gpt-5.5"]
  );
  const noKey = await keepGoingInfo(stubManager(), HELD_ID, fakeDeps({ keyHelper: async () => null }));
  assert.deepEqual([noKey.available, noKey.reason, noKey.needsKey], [false, KEY_SENTENCE, true]);
  const onOpenRouter = await keepGoingInfo(stubManager([summary({ brain: { kind: "openrouter", label: "OpenRouter" } })]), HELD_ID, fakeDeps());
  assert.deepEqual([onOpenRouter.available, onOpenRouter.reason], [false, NOT_ON_PLAN]);
  const noConversation = await keepGoingInfo(stubManager([summary()], { conversation: null }), HELD_ID, fakeDeps());
  assert.deepEqual(
    [noConversation.available, noConversation.reason, noConversation.approach],
    [false, "This Claude Code conversation can't be resumed.", "resume"]
  );
});

test("keepGoingInfo, Codex: a new session from the typed summary; the estimate reads the summary (its length / 4); without an OpenRouter model for Codex it says where to choose one", async () => {
  const screen = "› fix the failing test\n• Ran npm test\n  3 passing, 1 failing";
  const held = summary({ agentId: "codex", agentLabel: "Codex", meter: null, alert: { kind: "limit", text: "Codex's plan limit was reached.", at: "2026-10-29T10:00:00.000Z" } });
  const manager = stubManager([held], { screen });
  const info = await keepGoingInfo(manager, HELD_ID, fakeDeps());
  const typed = buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: screen });
  assert.deepEqual(info, {
    agentId: "codex",
    approach: "new",
    available: true,
    reason: null,
    model: CODEX_MODEL,
    estimateUsd: 0.01,
    estimateTokens: Math.ceil(typed.length / 4),
    estimateNote: SUMMARY_NOTE,
    warnings: [CODEX_WARNING],
    needsKey: false
  });
  assert.deepEqual(named(manager, "screenText"), [["screenText", HELD_ID]]);
  assert.deepEqual(named(manager, "create", "stop", "resume"), []);

  const noModel = await keepGoingInfo(stubManager([held], { screen }), HELD_ID, fakeDeps({ loadBrains: async () => ({ ...BRAINS, codex: { mode: "plan", model: null } }) }));
  assert.deepEqual(
    [noModel.available, noModel.reason, noModel.model, noModel.needsKey],
    [false, "Choose an OpenRouter model for Codex first (Agents, then Codex, then Brain).", null, false]
  );
});

test("keepGoingInfo and keepGoing answer only for a held Claude Code or Codex agent session: every other session is 409 not_held and nothing runs; an unknown session is 404", async () => {
  const others = [
    summary({ status: "live" }),
    summary({ status: "idle" }),
    summary({ status: "waiting" }),
    summary({ status: "starting" }),
    summary({ status: "exited" }),
    summary({ agentId: "cursor", agentLabel: "Cursor" }),
    summary({ agentId: "hermes", agentLabel: "Hermes", brain: null }),
    summary({ agentId: "openclaw", agentLabel: "OpenClaw", brain: null }),
    summary({ kind: "update", agentId: "hermes", agentLabel: "Hermes", brain: null })
  ];
  for (const other of others) {
    const manager = stubManager([other]);
    for (const call of [() => keepGoingInfo(manager, HELD_ID, fakeDeps()), () => keepGoing(manager, HELD_ID, fakeDeps())]) {
      await assert.rejects(
        call(),
        (error) => error.status === 409 && error.code === "not_held" && error.message === NOT_HELD,
        `${other.kind} ${other.agentId} ${other.status}`
      );
    }
    assert.deepEqual(named(manager, "stop", "resume", "create", "screenText"), [], `${other.agentId} ${other.status}`);
  }
  await assert.rejects(keepGoingInfo(stubManager([]), HELD_ID, fakeDeps()), (error) => error.status === 404 && error.code === "unknown_session");
});

// ---- keeping going --------------------------------------------------------------------------------------

test("keepGoing, Claude Code: Look only or a brain resolveBrain refuses stops nothing; otherwise Agent OS stops the session, then resumes it on the OpenRouter brain in the same tab (K15, R26)", async () => {
  const lookOnly = stubManager();
  await assert.rejects(
    keepGoing(lookOnly, HELD_ID, fakeDeps({ isExecutionAllowed: async () => false })),
    (error) => error.status === 409 && error.code === "execution_gate_off" && error.message === LOOK_ONLY_MESSAGE
  );
  assert.deepEqual(named(lookOnly, "stop", "resume"), []);

  const refused = stubManager();
  const refusing = fakeDeps({
    resolveBrain: async () => {
      throw brainError("openrouter_key_missing", "Agent OS doesn't have your OpenRouter key saved yet.");
    }
  });
  await assert.rejects(keepGoing(refused, HELD_ID, refusing), (error) => error.code === "openrouter_key_missing");
  assert.deepEqual(named(refused, "stop", "resume"), [], "a refusal never leaves the conversation stopped");

  const manager = stubManager();
  const deps = fakeDeps();
  assert.deepEqual(await keepGoing(manager, HELD_ID, deps), { result: "resumed", targetId: HELD_ID });
  const brain = { mode: "openrouter", model: DEFAULT_CLAUDE_MODEL };
  assert.deepEqual(deps.seen, [["resolveBrain", "claude", brain]]);
  assert.deepEqual(named(manager, "stop", "resume", "create"), [
    ["stop", HELD_ID, { by: "stop" }],
    ["resume", HELD_ID, { brainOverride: brain }]
  ]);
});

test("keepGoing: an option that isn't available answers 409 keep_going_unavailable with continue.js's own reason and changes nothing; a second press while one runs answers 409 session_busy", async () => {
  const noKey = stubManager();
  await assert.rejects(
    keepGoing(noKey, HELD_ID, fakeDeps({ keyHelper: async () => null })),
    (error) => error.status === 409 && error.code === "keep_going_unavailable" && error.message === KEY_SENTENCE
  );
  assert.deepEqual(named(noKey, "stop", "resume", "create"), []);

  const manager = stubManager();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const realStop = manager.stop;
  manager.stop = async (...args) => {
    await gate;
    return realStop(...args);
  };
  const first = keepGoing(manager, HELD_ID, fakeDeps());
  await assert.rejects(
    keepGoing(manager, HELD_ID, fakeDeps()),
    (error) => error.status === 409 && error.code === "session_busy" && error.message === BUSY_MESSAGE
  );
  release();
  assert.deepEqual(await first, { result: "resumed", targetId: HELD_ID });
  assert.equal(named(manager, "resume").length, 1, "one resume only");
  // Once it has ended the guard is gone; the session is no longer held, so the answer is not_held.
  await assert.rejects(keepGoing(manager, HELD_ID, fakeDeps()), (error) => error.code === "not_held");
});

test("keepGoing re-checks right before it acts (fix round 1, M1): a session that is no longer held, or is another process now, is not stopped and no new session opens", async () => {
  const changedAfterPlan = (manager, change) => {
    const realGet = manager.get;
    const realLive = manager.liveAgentSessions;
    let gets = 0;
    manager.get = async (id) => {
      gets += 1;
      const answer = await realGet(id);
      return gets > 1 && change === "status" ? { ...answer, status: "live" } : answer;
    };
    manager.liveAgentSessions = (agentId) => {
      const list = realLive(agentId);
      return gets > 1 && change === "process" ? list.map((entry) => ({ ...entry, pid: 9999 })) : list;
    };
    return manager;
  };
  for (const change of ["status", "process"]) {
    const claude = changedAfterPlan(stubManager(), change);
    await assert.rejects(
      keepGoing(claude, HELD_ID, fakeDeps()),
      (error) => error.status === 409 && error.code === "not_held" && error.message === NOT_HELD,
      change
    );
    assert.deepEqual(named(claude, "stop", "resume"), [], `Claude Code, ${change}: nothing stopped`);

    const codex = changedAfterPlan(stubManager([summary({ agentId: "codex", agentLabel: "Codex" })], { screen: "› fix the failing test" }), change);
    await assert.rejects(keepGoing(codex, HELD_ID, fakeDeps()), (error) => error.code === "not_held", change);
    assert.deepEqual(named(codex, "create"), [], `Codex, ${change}: nothing opened`);
  }
});

test("keepGoing, Codex: a hold opens one new session only (fix round 1, M5: each one is pay per use); a second confirmed press points to the first and opens and types nothing; once that session has ended, a press opens a new one", async () => {
  const screen = "› fix the failing test\n• Ran npm test";
  const held = summary({ agentId: "codex", agentLabel: "Codex", stateSince: "2026-10-29T11:11:11.000Z" });
  const manager = stubManager([held], { screen });
  const deps = fakeDeps();
  assert.deepEqual(await keepGoing(manager, HELD_ID, deps), { result: "opening", targetId: NEW_ID });
  await tick();
  assert.deepEqual(await keepGoing(manager, HELD_ID, deps), { result: "opening", targetId: NEW_ID });
  await tick();
  assert.equal(named(manager, "create").length, 1, "one new session for this hold");
  assert.equal(deps.seen.filter(([name]) => name === "deliverTyped").length, 1, "the summary was typed once");
  assert.deepEqual(named(manager, "stop", "resume"), []);

  manager.end(NEW_ID);
  assert.deepEqual(await keepGoing(manager, HELD_ID, deps), { result: "opening", targetId: NEW_ID });
  assert.equal(named(manager, "create").length, 2, "the first one ended, so this press opens another");
  await tick();
});

test("an empty screen is never summarized (fix round 1, M6): Codex keep going and Cursor's hand-over answer 409 empty_screen with one sentence, and open and type nothing", async () => {
  const sentence = "There is nothing on this screen to summarize yet.";
  for (const screen of ["", "\n   \n", "■ You’ve hit your usage limit. Try again at 3:45 PM.\n\n"]) {
    const codex = stubManager([summary({ agentId: "codex", agentLabel: "Codex" })], { screen });
    const deps = fakeDeps();
    await assert.rejects(
      keepGoing(codex, HELD_ID, deps),
      (error) => error.status === 409 && error.code === "empty_screen" && error.message === sentence,
      JSON.stringify(screen)
    );
    assert.deepEqual(named(codex, "create", "stop", "resume"), []);
    assert.deepEqual(deps.seen, []);

    const cursor = stubManager([cursorSession()], { screen, ready: [OPEN_ID] });
    await assert.rejects(
      handOver(cursor, HELD_ID, "claude", fakeDeps()),
      (error) => error.status === 409 && error.code === "empty_screen" && error.message === sentence,
      JSON.stringify(screen)
    );
    assert.deepEqual(named(cursor, "create", "typeInto", "setHandoff"), []);
  }
});

test("keepGoing, Claude Code: a resume that fails after the stop answers with its own status and sentence, stops and resumes once each, retries nothing, and the ended session can be resumed again afterwards (fix round 1, I1 and M9)", async () => {
  const manager = stubManager();
  const realResume = manager.resume;
  const refusal = sessionError(409, "session_live", "That session is still running, so there is nothing to resume.");
  manager.resume = async (id, options) => {
    manager.calls.push(["resume", id, options]);
    throw refusal;
  };
  const brain = { mode: "openrouter", model: DEFAULT_CLAUDE_MODEL };
  await assert.rejects(
    keepGoing(manager, HELD_ID, fakeDeps()),
    (error) => error === refusal && error.status === 409 && error.code === "session_live"
  );
  assert.deepEqual(named(manager, "stop", "resume"), [
    ["stop", HELD_ID, { by: "stop" }],
    ["resume", HELD_ID, { brainOverride: brain }]
  ]);
  assert.equal((await manager.get(HELD_ID)).status, "exited", "the conversation ended");
  // Not held any more: another press is the not-held sentence, and nothing is retried by itself.
  await assert.rejects(keepGoing(manager, HELD_ID, fakeDeps()), (error) => error.code === "not_held");
  assert.equal(named(manager, "stop").length, 1);
  // A plain Resume (the page's own button) still works: no override, so the saved brain.
  manager.resume = realResume;
  await manager.resume(HELD_ID);
  assert.deepEqual(named(manager, "resume").at(-1), ["resume", HELD_ID, undefined]);
  assert.equal((await manager.get(HELD_ID)).status, "starting");
});

test("keepGoing, Codex: the held session stays open; a new Codex session opens on the OpenRouter brain in the same folder, and the summary of the held screen is typed into it later under the hand-off rules (deliverTyped), never sent", async () => {
  const screen = "› fix the failing test\n• Ran npm test";
  const held = summary({ agentId: "codex", agentLabel: "Codex" });
  const manager = stubManager([held], { screen });
  const deps = fakeDeps();
  assert.deepEqual(await keepGoing(manager, HELD_ID, deps), { result: "opening", targetId: NEW_ID });
  assert.deepEqual(named(manager, "stop", "resume", "create"), [
    ["create", { agentId: "codex", folder: FOLDER, brainOverride: { mode: "openrouter", model: CODEX_MODEL } }]
  ]);
  await tick();
  assert.deepEqual(deps.seen, [
    ["deliverTyped", NEW_ID, buildTypedSummary({ agentLabel: "Codex", folder: FOLDER, screenText: screen }), { fromId: HELD_ID }]
  ]);

  // A typing that fails later never breaks anything (no unhandled rejection).
  const failing = stubManager([held], { screen });
  const broken = fakeDeps({
    deliverTyped: async () => {
      throw new Error("the new session went away");
    }
  });
  assert.equal((await keepGoing(failing, HELD_ID, broken)).result, "opening");
  await tick();
});

// ---- Cursor's hand-over ---------------------------------------------------------------------------------

test("handOver: only a Cursor agent session (400 hand_over_not_available), only to Claude Code or Codex (400 invalid_target), only while it runs (409 not_live); an unknown session is 404; nothing opens or types", async () => {
  for (const other of [summary(), summary({ agentId: "codex", agentLabel: "Codex", status: "live" }), summary({ kind: "update", agentId: "hermes", agentLabel: "Hermes", status: "live" })]) {
    const manager = stubManager([other]);
    await assert.rejects(
      handOver(manager, HELD_ID, "claude", fakeDeps()),
      (error) => error.status === 400 && error.code === "hand_over_not_available" && error.message === NOT_CURSOR
    );
    assert.deepEqual(named(manager, "create", "readyForTyping", "screenText"), []);
  }
  for (const to of ["cursor", "hermes", "openclaw", "", undefined, null, ["claude"], { toString: () => "claude" }]) {
    const manager = stubManager([cursorSession()]);
    await assert.rejects(
      handOver(manager, HELD_ID, to, fakeDeps()),
      (error) => error.status === 400 && error.code === "invalid_target" && error.message === INVALID_TARGET,
      JSON.stringify(to)
    );
    assert.deepEqual(named(manager, "create", "readyForTyping", "screenText"), []);
  }
  const ended = stubManager([cursorSession({ status: "exited" })]);
  await assert.rejects(
    handOver(ended, HELD_ID, "codex", fakeDeps()),
    (error) => error.status === 409 && error.code === "not_live" && error.message === CURSOR_ENDED
  );
  await assert.rejects(handOver(stubManager([]), HELD_ID, "codex", fakeDeps()), (error) => error.status === 404 && error.code === "unknown_session");
});

test("handOver uses X8's own delivery (handTyped): an open session of that agent in the same folder that can take typed text gets the summary (typed) unless it still holds this very one; one that can't, or one in another folder, is not used and a new session opens there on its saved brain (opening) and is typed once ready; a start that is refused answers copy with the refusal's sentence; two sessions in one folder open one new session", async () => {
  const screen = "Cursor: You've used all your included requests\n> refactor the parser";
  const text = buildTypedSummary({ agentLabel: "Cursor", folder: FOLDER, screenText: screen });
  const openClaude = summary({ id: OPEN_ID, status: "idle", resetAt: null, alert: null });

  const ready = stubManager([cursorSession(), openClaude], { screen, ready: [OPEN_ID] });
  assert.deepEqual(await handOver(ready, HELD_ID, "claude", fakeDeps()), { result: "typed", targetId: OPEN_ID, text, reason: null });
  assert.deepEqual(named(ready, "typeInto"), [["typeInto", OPEN_ID, text, { fromId: HELD_ID }]]);
  assert.deepEqual(named(ready, "create"), []);
  // The summary is still sitting unsent in that session's input: a second press types nothing more (X8's guard).
  assert.deepEqual(await handOver(ready, HELD_ID, "claude", fakeDeps()), { result: "typed", targetId: OPEN_ID, text, reason: null });
  assert.equal(named(ready, "typeInto").length, 1, "typed once");

  const notReady = stubManager([cursorSession(), openClaude], { screen, ready: [] });
  assert.deepEqual(await handOver(notReady, HELD_ID, "claude", fakeDeps()), { result: "opening", targetId: NEW_ID, text, reason: null });
  assert.deepEqual(named(notReady, "create"), [["create", { agentId: "claude", folder: FOLDER }]], "its own saved brain: no override");
  await tick();
  assert.deepEqual(named(notReady, "typeInto"), [["typeInto", NEW_ID, text, { fromId: HELD_ID }]], "typed into the new session once it is ready");

  const elsewhere = stubManager(
    [cursorSession(), summary({ id: OPEN_ID, agentId: "codex", agentLabel: "Codex", status: "live", folder: OTHER, resetAt: null, alert: null })],
    { screen, ready: [OPEN_ID] }
  );
  assert.equal((await handOver(elsewhere, HELD_ID, "codex", fakeDeps())).result, "opening");
  assert.deepEqual(named(elsewhere, "create"), [["create", { agentId: "codex", folder: FOLDER }]]);
  assert.deepEqual(named(elsewhere, "typeInto").map(([, id]) => id), [NEW_ID], "never the session in the other folder");

  // A refused start keeps the person's text: copy, with the refusal's own sentence.
  const refusal = sessionError(409, "session_limit", "Agent OS is already running as many sessions as it can.");
  const refused = stubManager([cursorSession()], { screen, createError: refusal });
  assert.deepEqual(await handOver(refused, HELD_ID, "claude", fakeDeps()), { result: "copy", targetId: null, text, reason: refusal.message });

  // Two Cursor sessions in one folder pressed together: one start for that agent and folder, one answer for both.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const SECOND_ID = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
  const both = stubManager([cursorSession(), cursorSession({ id: SECOND_ID })], { screen, createGate: gate });
  const first = handOver(both, HELD_ID, "claude", fakeDeps());
  const second = handOver(both, SECOND_ID, "claude", fakeDeps());
  await tick();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.result, b.result, a.targetId, b.targetId], ["opening", "opening", NEW_ID, NEW_ID]);
  assert.equal(named(both, "create").length, 1, "one new session");
});

// ---- the routes -----------------------------------------------------------------------------------------

test("routes: GET and POST /api/sessions/:id/keep-going and POST /:id/hand-over answer as the contract says; the body never picks the brain or the model (R26); an id that is not a session id is 404 before anything runs", async () => {
  const manager = stubManager();
  await withKeepGoingApp(manager, fakeDeps(), async (api) => {
    const info = await api("GET", `/api/sessions/${HELD_ID}/keep-going`);
    assert.equal(info.status, 200);
    assert.deepEqual([info.json.agentId, info.json.approach, info.json.available, info.json.estimateUsd], ["claude", "resume", true, 0.42]);

    const kept = await api("POST", `/api/sessions/${HELD_ID}/keep-going`, {
      brainOverride: { mode: "openrouter", model: "openai/gpt-5.5" },
      model: "openai/gpt-5.5",
      agentId: "codex"
    });
    assert.equal(kept.status, 200);
    assert.deepEqual(kept.json, { result: "resumed", targetId: HELD_ID });
    assert.deepEqual(named(manager, "resume"), [["resume", HELD_ID, { brainOverride: { mode: "openrouter", model: DEFAULT_CLAUDE_MODEL } }]]);

    const again = await api("GET", `/api/sessions/${HELD_ID}/keep-going`);
    assert.equal(again.status, 409);
    assert.deepEqual(again.json, { error: "not_held", message: NOT_HELD });

    for (const url of ["/api/sessions/not-a-uuid/keep-going", "/api/sessions/NOT/hand-over"]) {
      const method = url.endsWith("hand-over") ? "POST" : "GET";
      const answer = await api(method, url, method === "POST" ? { to: "claude" } : undefined);
      assert.equal(answer.status, 404, url);
      assert.equal(answer.json?.error, "unknown_session", url);
    }
  });

  const cursorManager = stubManager([cursorSession()], { screen: "> hello", ready: [] });
  await withKeepGoingApp(cursorManager, fakeDeps(), async (api) => {
    const bad = await api("POST", `/api/sessions/${HELD_ID}/hand-over`, { to: "hermes" });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: "invalid_target", message: INVALID_TARGET });
    const list = await api("POST", `/api/sessions/${HELD_ID}/hand-over`, ["codex"]);
    assert.equal(list.status, 400);
    assert.equal(list.json.error, "invalid_target");
    const good = await api("POST", `/api/sessions/${HELD_ID}/hand-over`, { to: "codex", folder: "/etc", agentId: "claude", brainOverride: { mode: "openrouter", model: "x/y" } });
    assert.equal(good.status, 200);
    assert.deepEqual(good.json, {
      result: "opening",
      targetId: NEW_ID,
      text: buildTypedSummary({ agentLabel: "Cursor", folder: FOLDER, screenText: "> hello" }),
      reason: null
    });
    assert.deepEqual(named(cursorManager, "create"), [["create", { agentId: "codex", folder: FOLDER }]], "only `to` is read from the body");
  });
});

test("keepGoingInfo with no deps uses the real ones: the saved brains, the OpenRouter key in its private file (never the Keychain in tests) and continue.js's price lookup", async () => {
  const manager = stubManager();
  const without = await keepGoingInfo(manager, HELD_ID);
  assert.deepEqual([without.available, without.reason, without.needsKey, without.model], [false, KEY_SENTENCE, true, DEFAULT_CLAUDE_MODEL]);
  await storeOpenRouterKey(KEY);
  try {
    const withKey = await keepGoingInfo(manager, HELD_ID);
    assert.deepEqual([withKey.available, withKey.needsKey, withKey.estimateUsd, withKey.estimateTokens], [true, false, 0.42, 140000]);
  } finally {
    await forgetOpenRouterKey();
  }
});
