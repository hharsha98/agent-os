// Hand-off (SP4, Task X8): the write rules, the cleaned body between the paste markers, the choice of target, the
// Copy fallback, the send route, and the Hand-off section's rules (src/ui/handoffShared.ts).
//
// Five parts:
//   1. handoff.js on its own: pure functions, then sendTo and deliverTyped against a stub manager;
//   2. the real session manager with injected fakes (no process starts): typeInto, readyForTyping,
//      whenReadyForTyping, setHandoff and the summary's `handoff`;
//   3. one real PTY test with the TUI fake standing in for Codex: what the agent really receives;
//   4. POST /api/sessions/:id/send on a real port with a stub manager;
//   5. the Hand-off section's rules.
// The spec's done-when for this task: "hand-off tests: no `\r`, no ESC inside the body, no write while the target
// is waiting or before ?2004". No real agent ever starts.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { sessionError } from "../server/runtime/sessions/errors.js";
import {
  HANDOFF_WAIT_MS,
  INVALID_TARGET_MESSAGE,
  PASTE_END,
  PASTE_START,
  TYPED_MAX_BYTES,
  buildReviewNote,
  cleanTypedText,
  deliverTyped,
  findHandoffTarget,
  pasteBody,
  sendTo
} from "../server/runtime/sessions/handoff.js";
import { mapHookEvent } from "../server/runtime/sessions/hooks.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import * as ui from "../src/ui/handoffShared.ts";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const isWindows = process.platform === "win32";
const SKIP_POSIX = { skip: isWindows ? "the fake agents are POSIX shell shims" : false };
// Node's own folder is left out on purpose: it can hold real agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const T0 = Date.parse("2026-10-29T09:00:00.000Z");
const ESC = "\x1b";
const FROM_ID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
const CODEX_ID = "9d1e8b6a-2c3f-4a5b-8c7d-abcdefabcdef";
const OLD_CODEX_ID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const CLAUDE_ID = "7e6d5c4b-3a29-4f18-a7b6-c5d4e3f2a1b0";
const NEW_ID = "5b0e7c3d-8a9f-4e21-b3c4-d5e6f7a8b9c0";
// A second session in the same folder as FROM_ID (another window, or another Claude Code tab).
const OTHER_FROM_ID = "c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f";
const CLAUDE_UUID = "0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
const FOLDER = "/Users/you/projects/my-app";
const SHORT_NOTE = "Please review the latest changes Claude Code made in this folder.";
const LIMIT_MESSAGE = "Agent OS runs at most 8 sessions at once. Stop one, then try again.";
// Everything a careless or hostile text could hold: CR and CRLF, a fake end-of-paste marker followed by a CR (Enter),
// an OSC title ended by BEL, a C1 CSI, DEL, a tab and NUL; and text that must stay (a minus sign and an emoji).
const NASTY = `Line one\r\nline two\rthree${ESC}[201~\r${ESC}]0;title\x07\x9b2J\x7f\tend\x00 − 🙂`;
const NASTY_CLEAN = "Line one\nline twothree[201~]0;title2Jend − 🙂";
const MODE_KEYS = {
  DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
  HERMES_AGENT_OS_PUBLIC_MODE: undefined
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for condition");
}

// Gives other work (what sendTo leaves running) turns until `predicate` holds.
async function until(predicate, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("the condition never held");
}

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

// A temp HOME (with two project folders and an empty fake-bin folder) and a separate temp AGENT_OS_HOME, both
// canonical paths, and a clean environment: SHELL is the stand-in login shell, PATH the fake bin plus the system
// folders only. Restored after.
async function withSessionEnv(fn) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-handoff-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-handoff-data-")));
  const project = path.join(home, "projects", "demo");
  const other = path.join(home, "projects", "other");
  const bin = path.join(home, "fake-bin");
  await mkdir(project, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(bin, { recursive: true });
  const vars = {
    HOME: home,
    USERPROFILE: home,
    AGENT_OS_HOME: agentOsHome,
    AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
    HERMES_AGENT_OS_HOME: undefined,
    HERMES_HOME: undefined,
    HERMES_AGENT_OS_ENABLE_EXEC: undefined,
    SHELL: FAKE_LOGIN_SHELL,
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter)
  };
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    assert.equal(os.homedir(), home, "tests must never see the real home folder");
    return await fn({ home, agentOsHome, project, other, bin });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
  }
}

// ---- 1. handoff.js on its own ---------------------------------------------------------------------------

test("cleanTypedText: every C0 control but newline, ESC, DEL and every C1 control go; CR and CRLF lose the CR; other text stays", () => {
  assert.equal(cleanTypedText(NASTY), NASTY_CLEAN);
  let controls = "";
  for (let code = 0; code <= 0x1f; code += 1) controls += String.fromCharCode(code);
  controls += "\x7f";
  for (let code = 0x80; code <= 0x9f; code += 1) controls += String.fromCharCode(code);
  assert.equal(cleanTypedText(`a${controls}b`), "a\nb", "only the newline is left of all 65 controls");
  assert.equal(cleanTypedText("one\r\ntwo\rthree\n"), "one\ntwothree\n");
  assert.equal(cleanTypedText(null), "");
  assert.equal(cleanTypedText(undefined), "");
  assert.equal(cleanTypedText(42), "42");
  assert.equal(cleanTypedText("é ü ß 中文 − 🙂"), "é ü ß 中文 − 🙂");
});

test("cleanTypedText: cut to 32 KB of UTF-8 without splitting a character, after the controls are gone", () => {
  assert.equal(TYPED_MAX_BYTES, 32 * 1024);
  assert.equal(Buffer.byteLength(cleanTypedText("a".repeat(TYPED_MAX_BYTES + 10)), "utf8"), TYPED_MAX_BYTES);
  // One byte short of the limit, then a four-byte emoji that would not fit: it is left out whole.
  assert.equal(cleanTypedText(`${"a".repeat(TYPED_MAX_BYTES - 1)}🙂tail`), "a".repeat(TYPED_MAX_BYTES - 1));
  const exact = `${"a".repeat(TYPED_MAX_BYTES - 4)}🙂`;
  assert.equal(cleanTypedText(exact), exact, "exactly 32 KB stays as it is");
  assert.equal(cleanTypedText(`${"\r".repeat(100)}${"b".repeat(TYPED_MAX_BYTES)}`).length, TYPED_MAX_BYTES, "removed controls use none of the budget");
});

test("pasteBody: the cleaned text between the paste markers, no carriage return anywhere, ESC only in the two markers, nothing after the end marker (never Enter)", () => {
  assert.equal(PASTE_START, `${ESC}[200~`);
  assert.equal(PASTE_END, `${ESC}[201~`);
  const body = pasteBody(NASTY);
  assert.equal(body, `${PASTE_START}${NASTY_CLEAN}${PASTE_END}`);
  assert.ok(!body.includes("\r"), "no carriage return");
  assert.ok(body.endsWith(PASTE_END), "the end marker is the last thing written");
  assert.ok(!body.slice(PASTE_START.length, -PASTE_END.length).includes(ESC), "no ESC inside the body: a typed end marker can't end the paste early");
  assert.equal(body.split(ESC).length - 1, 2, "exactly two ESC in all: the markers");
});

test("buildReviewNote: one line per changed file with its counts, a binary file without counts, and the shorter note when no file is listed", () => {
  assert.equal(
    buildReviewNote({
      fromLabel: "Claude Code",
      files: [
        { path: "src/App.tsx", status: "modified", added: 4, removed: 1 },
        { path: "src/settings.tsx", status: "untracked", added: 61, removed: null },
        { path: "logo.png", status: "added", added: null, removed: null }
      ]
    }),
    [
      "Please review the changes Claude Code made in this folder:",
      "- src/App.tsx (+4 −1)",
      "- src/settings.tsx (+61 −0)",
      "- logo.png"
    ].join("\n")
  );
  assert.equal(buildReviewNote({ fromLabel: "Codex", files: [] }), "Please review the latest changes Codex made in this folder.");
  assert.equal(buildReviewNote({ fromLabel: "Codex" }), "Please review the latest changes Codex made in this folder.");
  assert.equal(
    buildReviewNote({ fromLabel: "Codex", files: [{ path: `odd\nname${ESC}[2J.txt`, added: 1, removed: 0 }] }),
    "Please review the changes Codex made in this folder:\n- odd?name?[2J.txt (+1 −0)",
    "a file name stays on its own line"
  );
});

test("findHandoffTarget: the newest open session of that agent in exactly the same folder; never another agent, another folder, a separate copy of it, or an ended session", () => {
  const worktree = "/Users/you/.agent-os/worktrees/0b5f1e9a-3c2d-4e8f-9a1b-2c3d4e5f6a7b";
  const sessions = [
    { id: OLD_CODEX_ID, agentId: "codex", folder: FOLDER, status: "idle" },
    { id: CLAUDE_ID, agentId: "claude", folder: FOLDER, status: "idle" },
    { id: "b", agentId: "codex", folder: "/Users/you/projects/other", status: "idle" },
    { id: "c", agentId: "codex", folder: worktree, status: "idle" },
    { id: CODEX_ID, agentId: "codex", folder: FOLDER, status: "waiting" },
    { id: "d", agentId: "codex", folder: FOLDER, status: "exited" }
  ];
  assert.equal(findHandoffTarget(sessions, { agentId: "codex", folder: FOLDER })?.id, CODEX_ID, "the newest, even while it waits: the write rules decide next");
  assert.equal(findHandoffTarget(sessions, { agentId: "codex", folder: worktree })?.id, "c");
  assert.equal(findHandoffTarget(sessions, { agentId: "codex", folder: `${FOLDER}/src` }), null, "a subfolder is another folder");
  assert.equal(findHandoffTarget(sessions, { agentId: "cursor", folder: FOLDER }), null);
  assert.equal(findHandoffTarget([], { agentId: "codex", folder: FOLDER }), null);
  assert.equal(findHandoffTarget(null, { agentId: "codex", folder: FOLDER }), null);
  assert.equal(findHandoffTarget(sessions, { agentId: "codex", folder: "" }), null);
});

// A manager with just what sendTo and deliverTyped use. `ready` holds the ids that pass the write rules now;
// whenReadyForTyping answers `readyLater` (and makes the id ready when true).
// `createGate` is a promise that create() waits for (a session that is slow to start).
function handoffStub({ files = [], live = [], ready = [], createError = null, createGate = null, readyLater = true, fromAgent = "claude" } = {}) {
  const calls = [];
  const handoffs = new Map();
  const readyIds = new Set(ready);
  const sessions = live.map((session) => ({ ...session }));
  const labels = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
  const from = { id: FROM_ID, kind: "agent", agentId: fromAgent, agentLabel: labels[fromAgent], folder: FOLDER, status: "idle" };
  const manager = {
    async get(id) {
      calls.push(["get", id]);
      if (id === FROM_ID || id === OTHER_FROM_ID) return { ...from, id, handoff: null };
      const found = sessions.find((session) => session.id === id);
      if (found) return { ...found, kind: "agent", handoff: handoffs.get(id) ?? null };
      throw sessionError(404, "unknown_session", "That session doesn't exist anymore.");
    },
    async changes(id) {
      calls.push(["changes", id]);
      return { git: true, files, total: files.length, at: "2026-10-29T09:00:00.000Z" };
    },
    liveAgentSessions(agentId = null) {
      calls.push(["liveAgentSessions", agentId]);
      return sessions.filter((session) => agentId === null || session.agentId === agentId).map((session) => ({ ...session }));
    },
    readyForTyping(id) {
      return readyIds.has(id);
    },
    typeInto(id, text, options = {}) {
      calls.push(["typeInto", id, text, options.fromId ?? null]);
      if (!readyIds.has(id)) return { ok: false, reason: "no_paste_mode" };
      handoffs.set(id, { state: "typed", text, fromId: options.fromId ?? null });
      return { ok: true };
    },
    async create(input) {
      calls.push(["create", input]);
      if (createGate) await createGate;
      if (createError) throw createError;
      sessions.push({ id: NEW_ID, agentId: input.agentId, folder: input.folder, status: "starting" });
      return { id: NEW_ID, kind: "agent", agentId: input.agentId, folder: input.folder, status: "starting" };
    },
    async whenReadyForTyping(id, ms) {
      calls.push(["whenReadyForTyping", id, ms]);
      if (readyLater) readyIds.add(id);
      return readyLater;
    },
    setHandoff(id, handoff) {
      calls.push(["setHandoff", id, handoff?.state ?? null]);
      handoffs.set(id, handoff);
    }
  };
  return { manager, calls, handoffs };
}

test("sendTo: an open Codex session in the same folder that passes the write rules gets the note typed once, and nothing new starts", async () => {
  const files = [{ path: "src/App.tsx", status: "modified", added: 4, removed: 1 }];
  const { manager, calls, handoffs } = handoffStub({
    files,
    live: [{ id: CODEX_ID, agentId: "codex", folder: FOLDER, status: "idle" }],
    ready: [CODEX_ID]
  });
  const note = "Please review the changes Claude Code made in this folder:\n- src/App.tsx (+4 −1)";
  assert.deepEqual(await sendTo(manager, FROM_ID, "codex"), { result: "typed", targetId: CODEX_ID, text: note, reason: null });
  assert.deepEqual(calls.filter((call) => call[0] === "typeInto"), [["typeInto", CODEX_ID, note, FROM_ID]]);
  assert.equal(calls.some((call) => call[0] === "create"), false);
  assert.equal(handoffs.get(CODEX_ID).state, "typed");
});

test("sendTo: an open target that fails the write rules is never written to; a new Codex session opens in the folder and gets the note once it is ready (pending first)", async () => {
  const { manager, calls, handoffs } = handoffStub({ live: [{ id: CODEX_ID, agentId: "codex", folder: FOLDER, status: "waiting" }] });
  assert.deepEqual(await sendTo(manager, FROM_ID, "codex"), { result: "opening", targetId: NEW_ID, text: SHORT_NOTE, reason: null });
  assert.equal(calls.some((call) => call[0] === "typeInto" && call[1] === CODEX_ID), false, "the waiting session is never written to");
  assert.deepEqual(calls.find((call) => call[0] === "create"), ["create", { agentId: "codex", folder: FOLDER }]);
  await until(() => handoffs.get(NEW_ID)?.state === "typed");
  const order = calls.filter((call) => call[1] === NEW_ID).map((call) => (call[0] === "setHandoff" ? `setHandoff:${call[2]}` : call[0]));
  assert.deepEqual(order, ["setHandoff:pending", "whenReadyForTyping", "typeInto"]);
  assert.deepEqual(calls.find((call) => call[0] === "whenReadyForTyping"), ["whenReadyForTyping", NEW_ID, HANDOFF_WAIT_MS]);
});

test("sendTo: with no Codex session open, one starts; when it never gets ready, the text ends as copy and nothing is written", async () => {
  const { manager, calls, handoffs } = handoffStub({ readyLater: false });
  const result = await sendTo(manager, FROM_ID, "codex");
  assert.equal(result.result, "opening");
  assert.equal(result.targetId, NEW_ID);
  await until(() => handoffs.get(NEW_ID)?.state === "copy");
  assert.equal(calls.some((call) => call[0] === "typeInto"), false);
  assert.equal(handoffs.get(NEW_ID).text, SHORT_NOTE);
});

test("sendTo: when the new session can't start, the answer is copy with that refusal's own sentence; any other failure is thrown", async () => {
  const refusal = sessionError(409, "too_many_sessions", LIMIT_MESSAGE);
  const { manager, calls } = handoffStub({ createError: refusal });
  assert.deepEqual(await sendTo(manager, FROM_ID, "codex"), { result: "copy", targetId: null, text: SHORT_NOTE, reason: LIMIT_MESSAGE });
  assert.equal(calls.some((call) => call[0] === "typeInto" || call[0] === "setHandoff"), false);
  const broken = handoffStub({ createError: new TypeError("boom") });
  await assert.rejects(sendTo(broken.manager, FROM_ID, "codex"), TypeError);
});

test("sendTo: only Claude Code to Codex and Codex to Claude Code; anything else is 400 invalid_target before a file is listed or anything is written", async () => {
  // Exported once for Task X10's keep-going.js, so the sentence is never written twice.
  assert.equal(INVALID_TARGET_MESSAGE, "Agent OS can hand this only to Claude Code or Codex.");
  const pairs = [["claude", "claude"], ["claude", "hermes"], ["claude", undefined], ["claude", ""], ["codex", "codex"], ["cursor", "claude"], ["cursor", "codex"]];
  for (const [fromAgent, to] of pairs) {
    const { manager, calls } = handoffStub({ fromAgent });
    await assert.rejects(
      sendTo(manager, FROM_ID, to),
      (error) => error.status === 400 && error.code === "invalid_target" && error.message === "Agent OS can hand this only to Claude Code or Codex.",
      `${fromAgent} to ${to}`
    );
    assert.equal(calls.some((call) => ["changes", "typeInto", "create", "setHandoff"].includes(call[0])), false, `${fromAgent} to ${to}`);
  }
  const reverse = handoffStub({ fromAgent: "codex", live: [{ id: CLAUDE_ID, agentId: "claude", folder: FOLDER, status: "idle" }], ready: [CLAUDE_ID] });
  assert.deepEqual(await sendTo(reverse.manager, FROM_ID, "claude"), {
    result: "typed",
    targetId: CLAUDE_ID,
    text: "Please review the latest changes Codex made in this folder.",
    reason: null
  });
  const unknown = handoffStub();
  await assert.rejects(sendTo(unknown.manager, NEW_ID, "codex"), (error) => error.status === 404 && error.code === "unknown_session");
});

test("sendTo: a second Send while the new session still waits for its text answers opening for that same session, types nothing more and starts nothing", async () => {
  const { manager, calls, handoffs } = handoffStub({ live: [{ id: CODEX_ID, agentId: "codex", folder: FOLDER, status: "starting" }] });
  handoffs.set(CODEX_ID, { state: "pending", text: SHORT_NOTE, fromId: FROM_ID });
  assert.deepEqual(await sendTo(manager, FROM_ID, "codex"), { result: "opening", targetId: CODEX_ID, text: SHORT_NOTE, reason: null });
  assert.equal(calls.some((call) => ["typeInto", "create", "setHandoff"].includes(call[0])), false);
});

test("deliverTyped: pending first, then typed once the target is ready; copy when it never is, or when the write rules refuse at the last moment; the text is cleaned", async () => {
  {
    const { manager, calls, handoffs } = handoffStub({ live: [{ id: CODEX_ID, agentId: "codex", folder: FOLDER, status: "starting" }] });
    assert.equal(await deliverTyped(manager, CODEX_ID, NASTY, { fromId: FROM_ID, waitMs: 1234 }), "typed");
    assert.deepEqual(calls.find((call) => call[0] === "setHandoff"), ["setHandoff", CODEX_ID, "pending"]);
    assert.deepEqual(calls.find((call) => call[0] === "whenReadyForTyping"), ["whenReadyForTyping", CODEX_ID, 1234]);
    assert.deepEqual(calls.find((call) => call[0] === "typeInto"), ["typeInto", CODEX_ID, NASTY_CLEAN, FROM_ID]);
    assert.equal(handoffs.get(CODEX_ID).state, "typed");
  }
  {
    const { manager, handoffs } = handoffStub({ readyLater: false });
    assert.equal(await deliverTyped(manager, CODEX_ID, "hello"), "copy");
    assert.deepEqual(handoffs.get(CODEX_ID), { state: "copy", text: "hello", fromId: null });
  }
  {
    const { manager, calls, handoffs } = handoffStub();
    manager.typeInto = (id) => {
      calls.push(["typeInto", id]);
      return { ok: false, reason: "waiting" };
    };
    assert.equal(await deliverTyped(manager, CODEX_ID, "hello"), "copy");
    assert.equal(calls.filter((call) => call[0] === "typeInto").length, 1, "never a second try");
    assert.equal(handoffs.get(CODEX_ID).state, "copy");
  }
});

// ---- 2. the real manager with injected fakes ---------------------------------------------------------------

const BASE_MODES = Object.freeze({
  altScreen: false,
  bracketedPaste: false,
  mouseTracking: "none",
  mouseEncoding: "default",
  focusReporting: false,
  cursorKeysApp: false,
  kittyFlags: 0
});

function fakePty(pid, options) {
  const dataListeners = new Set();
  const exitListeners = new Set();
  const pty = {
    pid,
    opts: options,
    writes: [],
    write(data) {
      pty.writes.push(data);
    },
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
    emit(data) {
      for (const cb of [...dataListeners]) cb(data);
    },
    exit(exitCode = 0) {
      for (const cb of [...exitListeners]) cb({ exitCode, signal: undefined });
    }
  };
  return pty;
}

// Task X1b's mirror API, faked. setModes() stands for the agent printing DECSET or DECRST; each change reaches the
// onModeChange listeners, and modeListeners counts the ones still subscribed.
function fakeMirror(options) {
  const counted = new Set();
  const modeListeners = new Set();
  let modes = { ...BASE_MODES };
  const mirror = {
    opts: options,
    written: [],
    write(chunk) {
      mirror.written.push(chunk);
    },
    resize() {},
    async snapshot() {
      return { data: mirror.written.join(""), cols: options.cols, rows: options.rows, modes: { ...modes } };
    },
    setWriterAttached() {},
    onCountedOutput(cb) {
      counted.add(cb);
      return () => counted.delete(cb);
    },
    modes() {
      return { ...modes };
    },
    onModeChange(cb) {
      modeListeners.add(cb);
      return () => modeListeners.delete(cb);
    },
    screenText() {
      return "";
    },
    dispose() {},
    setModes(patch) {
      modes = { ...modes, ...patch };
      for (const cb of [...modeListeners]) cb({ ...modes });
    },
    get modeListeners() {
      return modeListeners.size;
    }
  };
  return mirror;
}

function fakeRecorder() {
  return { output() {}, marker() {}, resize() {}, async close() {} };
}

// What buildSessionProfile answers, without a login shell or a file. A Claude agent session given a hook (Task X2a)
// gets the `claude` part, with the hooks-off codes a test asks for (Task X2b).
function fakeProfile(input, { hooksOff = { alerts: null, meter: null } } = {}) {
  const claude =
    input.kind === "agent" && input.agentId === "claude" && input.hook
      ? { hookUrl: `http://127.0.0.1:${input.hook.port}/hooks/sessions/${input.sessionId}`, hooksOff, statusLineFrom: null }
      : null;
  return {
    command: `/fake/bin/${input.agentId}`,
    args: input.kind === "update" ? ["update"] : [],
    cwd: input.folder || os.homedir(),
    env: { TERM: "xterm-256color" },
    agentSessionId: input.agentId === "claude" ? CLAUDE_UUID : null,
    settingsFile: null,
    softStop: null,
    resumeMode: input.kind === "update" ? null : input.agentId === "claude" ? "id" : "fallback",
    folderShown: true,
    notes: [],
    claude
  };
}

// The folder policy's answers for the folders these tests use.
async function fakeCheckFolder(input) {
  const home = await realpath(os.homedir());
  let real;
  try {
    real = await realpath(String(input || ""));
  } catch {
    return { ok: false, code: "missing", message: "That folder doesn't exist." };
  }
  if (!real.startsWith(home + path.sep)) return { ok: false, code: "outside_home", message: "Pick a folder inside your home folder." };
  return { ok: true, path: real, name: path.basename(real) };
}

// Git as Task X7 runs it, answering "not a git project", so the changes poll never starts a real git.
async function notGit() {
  return { code: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false, ok: false };
}

function handoffWorld({ port = null, hooksOff } = {}) {
  const world = { clock: T0, ptys: [], mirrors: [], nextPid: 52000 };
  world.manager = createSessionManager({
    now: () => world.clock,
    spawn: async (options) => {
      const pty = fakePty(world.nextPid, options);
      world.nextPid += 1;
      world.ptys.push(pty);
      return pty;
    },
    buildProfile: async (input) => fakeProfile(input, { hooksOff }),
    recorderFactory: () => fakeRecorder(),
    mirrorFactory: (options) => {
      const mirror = fakeMirror(options);
      world.mirrors.push(mirror);
      return mirror;
    },
    isExecutionAllowed: async () => true,
    checkFolder: fakeCheckFolder,
    ptyCheck: async () => ({ ok: true, reason: null }),
    detect: async (agentId) => ({ installed: true, path: `/fake/bin/${agentId}` }),
    resolveBrain: async () => null,
    readSettings: async () => ({ claudeFullscreen: false }),
    enforceCap: async () => ({ deleted: [] }),
    killTree: async () => {},
    getPort: () => port,
    runGit: notGit
  });
  return world;
}

// One world per test, inside the temp environment; every fake process is ended and every meta.json written
// before the temp folders go, even when the test failed half way.
async function withWorld(options, fn) {
  await withSessionEnv(async (env) => {
    const world = handoffWorld(options);
    try {
      await fn(world, env);
    } finally {
      for (const pty of world.ptys) pty.exit(0);
      await waitFor(async () => (await world.manager.list({ includeUpdate: true })).every((session) => session.status === "exited")).catch(() => {});
    }
  });
}

// A started session that printed its first output (so it is live), with bracketed paste on unless asked otherwise.
async function liveSession(world, agentId, folder, { paste = true } = {}) {
  const summary = await world.manager.create({ agentId, folder });
  const pty = world.ptys.at(-1);
  const mirror = world.mirrors.at(-1);
  pty.emit("> ");
  if (paste) mirror.setModes({ bracketedPaste: true });
  return { id: summary.id, pty, mirror };
}

test("the manager offers the four hand-off methods, and handoff.js has the contract's limits", () => {
  const manager = createSessionManager();
  for (const name of ["typeInto", "readyForTyping", "whenReadyForTyping", "setHandoff"]) {
    assert.equal(typeof manager[name], "function", name);
  }
  assert.equal(HANDOFF_WAIT_MS, 60 * 1000);
  assert.equal(TYPED_MAX_BYTES, 32 * 1024);
});

test("typeInto: nothing is written before the mirror shows ?2004; then exactly one write, the paste markers around the cleaned text and nothing after; refused again once ?2004 is off", async () => {
  await withWorld({}, async (world, { project }) => {
    const m = world.manager;
    const { id, pty, mirror } = await liveSession(world, "codex", project, { paste: false });
    assert.equal(m.readyForTyping(id), false);
    assert.deepEqual(m.typeInto(id, "too early"), { ok: false, reason: "no_paste_mode" });
    assert.deepEqual(pty.writes, [], "nothing written before ?2004");

    mirror.setModes({ bracketedPaste: true });
    assert.equal(m.readyForTyping(id), true);
    assert.deepEqual(m.typeInto(id, NASTY, { fromId: FROM_ID }), { ok: true });
    assert.deepEqual(pty.writes, [`${PASTE_START}${NASTY_CLEAN}${PASTE_END}`]);
    assert.ok(!pty.writes[0].includes("\r"), "no carriage return, so no Enter");
    assert.ok(!pty.writes[0].slice(PASTE_START.length, -PASTE_END.length).includes(ESC), "no ESC inside the body");

    mirror.setModes({ bracketedPaste: false });
    assert.deepEqual(m.typeInto(id, "too late"), { ok: false, reason: "no_paste_mode" });
    assert.equal(pty.writes.length, 1, "still only the one write");
  });
});

test("typeInto: nothing is written while the target waits or is in an approval, even with ?2004 on; it can be typed into again once that resolves", async () => {
  await withWorld({}, async (world, { project }) => {
    const m = world.manager;
    const { id, pty } = await liveSession(world, "codex", project);
    assert.equal(m.applySignal(id, { kind: "waiting", text: "Approval requested: run the tests", source: "osc" }), true);
    assert.equal((await m.get(id)).status, "waiting");
    assert.equal(m.readyForTyping(id), false);
    assert.deepEqual(m.typeInto(id, "hello"), { ok: false, reason: "waiting" });

    assert.equal(m.applySignal(id, { kind: "resolved", source: "osc" }), true);
    assert.equal(m.applySignal(id, { kind: "approval", text: "Run npm test?", source: "openclaw" }), true);
    assert.deepEqual(m.typeInto(id, "hello"), { ok: false, reason: "waiting" }, "in an approval");
    assert.deepEqual(pty.writes, [], "nothing was written");

    assert.equal(m.applySignal(id, { kind: "resolved", source: "openclaw" }), true);
    assert.equal(m.readyForTyping(id), true);
    assert.deepEqual(m.typeInto(id, "hello"), { ok: true });
    assert.deepEqual(pty.writes, [`${PASTE_START}hello${PASTE_END}`]);
  });
});

test("typeInto: an idle or a held target is typed into, and the write is not user input: idle stays idle (turn done) and held stays held", async () => {
  await withWorld({}, async (world, { project, other }) => {
    const m = world.manager;
    const a = await liveSession(world, "codex", project);
    assert.equal(m.applySignal(a.id, { kind: "turn_done", source: "osc" }), true);
    let summary = await m.get(a.id);
    assert.equal(summary.status, "idle");
    assert.equal(summary.idleBy, "turn_done");
    const stateSince = summary.stateSince;
    assert.equal(m.liveAgentSessions("codex")[0].lastInputAt, 0, "precondition: no user input yet");
    world.clock = T0 + 5000;
    assert.deepEqual(m.typeInto(a.id, "review please"), { ok: true });
    summary = await m.get(a.id);
    assert.equal(summary.status, "idle", "a hand-off write never wakes the session");
    assert.equal(summary.idleBy, "turn_done");
    assert.equal(summary.stateSince, stateSince, "the state did not change, so its time did not either");
    assert.equal(m.liveAgentSessions("codex")[0].lastInputAt, 0, "the write is not user input: lastInputAt stays 0");

    const b = await liveSession(world, "claude", other);
    assert.equal(m.setHeld(b.id, { text: "Claude Code's plan limit was reached.", source: "text" }), true);
    assert.equal((await m.get(b.id)).status, "held");
    assert.deepEqual(m.typeInto(b.id, "for later"), { ok: true });
    assert.equal((await m.get(b.id)).status, "held");
  });
});

test("typeInto: a Claude Code session whose folder trust Agent OS has not seen yet counts as waiting (its trust question takes no typed text); the first hook event lifts that", async () => {
  await withWorld({ port: 43210 }, async (world, { project }) => {
    const m = world.manager;
    const { id, pty } = await liveSession(world, "claude", project);
    assert.equal((await m.get(id)).trustNeeded, true, "precondition (Task X2a): trust not seen yet");
    assert.deepEqual(m.typeInto(id, "hello"), { ok: false, reason: "waiting" });
    m.onHook(id, mapHookEvent({ hook_event_name: "Stop", session_id: CLAUDE_UUID }));
    await waitFor(async () => (await m.get(id)).trustNeeded === false);
    assert.deepEqual(m.typeInto(id, "hello"), { ok: true });
    assert.deepEqual(pty.writes, [`${PASTE_START}hello${PASTE_END}`]);
  });
});

test("typeInto: when the person's Claude settings switch the Live meter off, trust can't be seen, so only the spec's two rules apply", async () => {
  await withWorld({ port: 43210, hooksOff: { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" } }, async (world, { project }) => {
    const m = world.manager;
    const { id } = await liveSession(world, "claude", project);
    assert.equal((await m.get(id)).hooksOff.meter, "all_hooks_disabled", "precondition (Task X2b)");
    assert.deepEqual(m.typeInto(id, "hello"), { ok: true });
  });
});

test("typeInto: an unknown id, an ended session and an update session are not_live, and empty text is a caller's bug; nothing is written", async () => {
  await withWorld({}, async (world, { home, project, other }) => {
    const m = world.manager;
    assert.deepEqual(m.typeInto(NEW_ID, "x"), { ok: false, reason: "not_live" });
    assert.equal(m.readyForTyping("not-an-id"), false);

    const ended = await liveSession(world, "codex", project);
    ended.pty.exit(0);
    await waitFor(async () => (await m.get(ended.id)).status === "exited");
    assert.deepEqual(m.typeInto(ended.id, "x"), { ok: false, reason: "not_live" });

    const hermesFolder = path.join(home, "hermes-agent");
    await mkdir(hermesFolder, { recursive: true });
    const update = await m.createUpdateSession({ agentId: "hermes", folder: hermesFolder });
    const updatePty = world.ptys.at(-1);
    updatePty.emit("Update now? [y/N] ");
    world.mirrors.at(-1).setModes({ bracketedPaste: true });
    assert.deepEqual(m.typeInto(update.id, "y"), { ok: false, reason: "not_live" }, "only agent sessions take typed text");

    const ready = await liveSession(world, "codex", other);
    assert.throws(() => m.typeInto(ready.id, `\r${ESC}\x07`), TypeError);
    for (const pty of world.ptys) assert.deepEqual(pty.writes, []);
  });
});

test("whenReadyForTyping: true as soon as ?2004 shows, true once a waiting target resolves, false at the time limit, false at once when the session ends or is unknown; no mode listener is left behind", async () => {
  await withWorld({}, async (world, { project, other }) => {
    const m = world.manager;
    const a = await liveSession(world, "codex", project, { paste: false });
    const startedAt = Date.now();
    const soon = m.whenReadyForTyping(a.id, 5000);
    setTimeout(() => a.mirror.setModes({ bracketedPaste: true }), 50);
    assert.equal(await soon, true);
    assert.ok(Date.now() - startedAt < 1000, "seen when the mode changes, long before the time limit");
    assert.equal(a.mirror.modeListeners, 0);

    assert.equal(m.applySignal(a.id, { kind: "waiting", text: "Approval requested: x", source: "osc" }), true);
    const afterWaiting = m.whenReadyForTyping(a.id, 5000);
    setTimeout(() => m.applySignal(a.id, { kind: "resolved", source: "osc" }), 50);
    assert.equal(await afterWaiting, true);

    const b = await liveSession(world, "codex", other, { paste: false });
    const t0 = Date.now();
    assert.equal(await m.whenReadyForTyping(b.id, 300), false);
    assert.ok(Date.now() - t0 >= 280, "it waited for the limit");
    assert.equal(b.mirror.modeListeners, 0);

    const gone = m.whenReadyForTyping(b.id, 5000);
    setTimeout(() => b.pty.exit(0), 50);
    const t1 = Date.now();
    assert.equal(await gone, false);
    assert.ok(Date.now() - t1 < 1500, "an ended session ends the wait");
    assert.equal(await m.whenReadyForTyping(NEW_ID, 5000), false, "an unknown id answers false at once");
  });
});

test("handoff in the summary: pending and copy from setHandoff, typed from typeInto with its fromId; a typed one goes at the person's next input; memory only, never in meta.json, null once ended", async () => {
  await withWorld({}, async (world, { agentOsHome, project }) => {
    const m = world.manager;
    const { id, pty } = await liveSession(world, "codex", project);
    assert.equal((await m.get(id)).handoff, null);

    m.setHandoff(id, { state: "pending", text: "note\r\nwith CR", fromId: FROM_ID });
    assert.deepEqual((await m.get(id)).handoff, { state: "pending", text: "note\nwith CR", fromId: FROM_ID, at: new Date(T0).toISOString() });
    m.setHandoff(id, { state: "copy", text: "note", fromId: FROM_ID });
    assert.equal((await m.get(id)).handoff.state, "copy");
    m.setHandoff(id, null);
    assert.equal((await m.get(id)).handoff, null);
    assert.throws(() => m.setHandoff(id, { state: "odd", text: "x" }), TypeError);

    await m.attach(id, { id: "w", send() {}, close() {} });
    assert.equal(m.focus(id, "w"), true);
    world.clock = T0 + 1000;
    assert.equal(m.write(id, "w", "x"), true);
    world.clock = T0 + 2000;
    assert.deepEqual(m.typeInto(id, "please review", { fromId: FROM_ID }), { ok: true });
    assert.deepEqual(
      (await m.get(id)).handoff,
      { state: "typed", text: "please review", fromId: FROM_ID, at: new Date(T0 + 2000).toISOString() },
      "input before the typing does not clear it"
    );
    assert.equal(m.liveAgentSessions("codex")[0].lastInputAt, T0 + 1000, "the typing left lastInputAt at the person's own last input");
    world.clock = T0 + 3000;
    assert.equal(m.write(id, "w", "\r"), true);
    assert.equal((await m.get(id)).handoff, null, "the person's next input clears a typed one");

    m.setHandoff(id, { state: "copy", text: "secret-ish note", fromId: FROM_ID });
    world.clock = T0 + 4000;
    assert.equal(m.write(id, "w", "y"), true);
    assert.equal((await m.get(id)).handoff.state, "copy", "a copy stays until it is replaced or the session ends");
    assert.deepEqual(m.typeInto(id, "x", { fromId: "not-a-session-id" }), { ok: true });
    assert.equal((await m.get(id)).handoff.fromId, null, "a fromId that is not a session id is dropped");

    pty.exit(0);
    const meta = await waitFor(async () => {
      const raw = await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8").catch(() => "");
      return raw.includes('"exited"') ? raw : null;
    });
    // The quoted key: the temp folder in meta.json is named agent-os-handoff-home-…, so the bare word is always there.
    assert.ok(!meta.includes('"handoff"'), "no handoff key in meta.json");
    assert.ok(!meta.includes("please review") && !meta.includes("secret-ish"), "no hand-off text on disk");
    assert.equal((await m.get(id)).handoff, null, "an ended session has no hand-off");
  });
});

test("keepGoingFailure in the summary (sweep A item 11, X10 N1): the sentence of a Keep going that could not resume shows on the ended session only, until it runs again or is dismissed; memory only, never in meta.json", async () => {
  await withWorld({}, async (world, { agentOsHome, project }) => {
    const m = world.manager;
    const { id, pty } = await liveSession(world, "claude", project);
    const SENTENCE = "That session is still running, so there is nothing to resume.";
    assert.equal((await m.get(id)).keepGoingFailure, null);
    m.setKeepGoingFailure(id, SENTENCE);
    assert.equal((await m.get(id)).keepGoingFailure, null, "a running session shows none");

    pty.exit(0);
    await waitFor(async () => (await m.get(id)).status === "exited");
    assert.equal((await m.get(id)).keepGoingFailure, SENTENCE, "once it has ended the sentence shows");
    assert.equal((await m.list({ includeUpdate: true })).find((session) => session.id === id).keepGoingFailure, SENTENCE, "and in the list");
    m.setKeepGoingFailure(id, "A\u0007B\ncd");
    assert.equal((await m.get(id)).keepGoingFailure, "AB cd", "plain one-line text");
    m.setKeepGoingFailure(id, "x".repeat(500));
    const cut = (await m.get(id)).keepGoingFailure;
    assert.equal(Array.from(cut).length, 300);
    assert.ok(cut.endsWith("…"));
    m.setKeepGoingFailure(id, null);
    assert.equal((await m.get(id)).keepGoingFailure, null, "null clears it");
    m.setKeepGoingFailure(id, "   ");
    assert.equal((await m.get(id)).keepGoingFailure, null, "blank text keeps nothing");
    assert.doesNotThrow(() => m.setKeepGoingFailure("not-a-session-id", SENTENCE));

    // Never on disk.
    m.setKeepGoingFailure(id, SENTENCE);
    const meta = await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8");
    assert.ok(!meta.includes("keepGoingFailure") && !meta.includes("nothing to resume"), "no trace in meta.json");

    // It goes when the session runs again.
    await m.resume(id);
    assert.equal((await m.get(id)).keepGoingFailure, null, "a resumed session starts clean");
    world.ptys.at(-1).exit(0);
    await waitFor(async () => (await m.get(id)).status === "exited");
    assert.equal((await m.get(id)).keepGoingFailure, null, "and it does not come back when that run ends");

    // Or when it is dismissed.
    m.setKeepGoingFailure(id, SENTENCE);
    assert.equal((await m.get(id)).keepGoingFailure, SENTENCE);
    await m.dismiss(id);
    assert.equal((await m.get(id)).keepGoingFailure, null, "a dismissed session keeps nothing");
  });
});

// ---- 3. real PTY: what a fake agent really receives ---------------------------------------------------------

function ptyEnv(home, bin, log) {
  return {
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    SHELL: FAKE_LOGIN_SHELL,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    FAKE_AGENT_LOG: log
  };
}

// `running` holds the pids this test started and has not seen exit; only those are ever signalled.
function track(running, handle) {
  running.add(handle.pid);
  handle.onExit(() => {
    running.delete(handle.pid);
  });
  return handle;
}

function killLeftovers(running) {
  for (const pid of [...running]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    running.delete(pid);
  }
}

async function readLog(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

test("real PTY: a fake Codex gets the hand-off as one bracketed paste, only after it turned ?2004 on, with no carriage return and no ESC in the text and no Enter after it", SKIP_POSIX, async () => {
  await withSessionEnv(async ({ home, agentOsHome, project, bin }) => {
    const running = new Set();
    const log = path.join(home, "fake-agent.log");
    let id = null;
    try {
      await makeFakeAgentBin(bin); // all six names, mode tui
      const manager = createSessionManager({
        isExecutionAllowed: async () => true,
        detect: async () => ({ installed: true, path: path.join(bin, "codex") }),
        resolveBrain: async () => null,
        getPort: () => null,
        runGit: notGit,
        buildProfile: async (input) => ({
          command: path.join(bin, "codex"),
          args: [],
          cwd: input.folder,
          env: ptyEnv(home, bin, log),
          agentSessionId: null,
          settingsFile: null,
          softStop: null,
          resumeMode: "fallback",
          folderShown: true,
          notes: [],
          claude: null
        }),
        spawn: async (options) => track(running, await spawnPty(options))
      });
      id = (await manager.create({ agentId: "codex", folder: project })).id;
      const frames = [];
      await manager.attach(id, { id: "w", send: (frame) => frames.push(frame), close() {} });
      assert.equal(manager.focus(id, "w"), true);
      const screen = () => frames.filter((frame) => frame.t === "out").map((frame) => frame.d).join("");
      await waitFor(() => screen().includes("> "));

      assert.deepEqual(manager.typeInto(id, "too early"), { ok: false, reason: "no_paste_mode" });
      assert.equal(manager.write(id, "w", "paste on\r"), true);
      await waitFor(() => manager.readyForTyping(id));
      assert.deepEqual(manager.typeInto(id, NASTY, { fromId: FROM_ID }), { ok: true });

      const pastes = await waitFor(async () => {
        const found = (await readLog(log)).filter((event) => event.event === "paste");
        return found.length ? found : null;
      });
      assert.equal(pastes.length, 1, "one paste");
      assert.equal(pastes[0].text, NASTY_CLEAN);
      assert.ok(!pastes[0].text.includes("\r"), "no carriage return reached the agent");
      assert.ok(!pastes[0].text.includes(ESC), "no ESC inside the pasted text");
      await sleep(400);
      const events = await readLog(log);
      const at = events.findIndex((event) => event.event === "paste");
      assert.deepEqual(events.slice(at + 1).filter((event) => event.event === "line" || event.event === "key"), [], "nothing after the paste: no Enter, no stray key");
      assert.ok(!events.some((event) => JSON.stringify(event).includes("too early")), "the refused text never reached the agent");

      assert.equal(manager.write(id, "w", "paste off\r"), true);
      await waitFor(() => !manager.readyForTyping(id));
      assert.deepEqual(manager.typeInto(id, "too late"), { ok: false, reason: "no_paste_mode" });
      assert.equal(manager.write(id, "w", "exit 0\r"), true);
      await waitFor(async () => (await manager.get(id)).status === "exited");
    } finally {
      killLeftovers(running);
      if (id) {
        await waitFor(async () => (await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8").catch(() => "")).includes('"exited"')).catch(
          () => {}
        );
      }
    }
  });
});

// ---- 4. POST /api/sessions/:id/send ------------------------------------------------------------------------

async function withRoute(manager, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
    return await fn(post);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("POST /api/sessions/:id/send: the HandoffResult, 400 invalid_target for a wrong target, 404 for a bad id, and 404 not_available outside local mode", async () => {
  await withEnv(MODE_KEYS, async () => {
    const { manager, calls } = handoffStub({ live: [{ id: CODEX_ID, agentId: "codex", folder: FOLDER, status: "idle" }], ready: [CODEX_ID] });
    await withRoute(manager, async (post) => {
      const sent = await post(`/api/sessions/${FROM_ID}/send`, { to: "codex" });
      assert.equal(sent.status, 200);
      assert.deepEqual(sent.json, { result: "typed", targetId: CODEX_ID, text: SHORT_NOTE, reason: null });
      const wrong = await post(`/api/sessions/${FROM_ID}/send`, { to: "hermes" });
      assert.equal(wrong.status, 400);
      assert.deepEqual(wrong.json, { error: "invalid_target", message: "Agent OS can hand this only to Claude Code or Codex." });
      assert.equal((await post(`/api/sessions/${FROM_ID}/send`, [])).status, 400, "a body that is not an object names no target");
      const badId = await post("/api/sessions/not-a-uuid/send", { to: "codex" });
      assert.equal(badId.status, 404);
      assert.equal(badId.json.error, "unknown_session");
    });
    assert.equal(calls.filter((call) => call[0] === "typeInto").length, 1, "only the good request typed");
  });
  await withEnv({ ...MODE_KEYS, DEMO_PUBLIC: "1" }, async () => {
    const { manager, calls } = handoffStub();
    await withRoute(manager, async (post) => {
      const refused = await post(`/api/sessions/${FROM_ID}/send`, { to: "codex" });
      assert.equal(refused.status, 404);
      assert.deepEqual(refused.json, { error: "not_available" });
    });
    assert.deepEqual(calls, [], "the manager is never asked");
  });
});

// ---- 5. the Hand-off section's rules (src/ui/handoffShared.ts) ----------------------------------------------

test("Hand-off section: a Send button only in a Claude Code session (to Codex) and in a Codex session (to Claude Code), with the spec's words and caption", () => {
  assert.equal(ui.HANDOFF_TITLE, "Hand-off");
  assert.equal(ui.HANDOFF_CAPTION, "Typed for you, not sent");
  assert.deepEqual(ui.sendTargets({ kind: "agent", agentId: "claude" }), [{ to: "codex", label: "Send to Codex for review", agentLabel: "Codex" }]);
  assert.deepEqual(ui.sendTargets({ kind: "agent", agentId: "codex" }), [{ to: "claude", label: "Send to Claude Code", agentLabel: "Claude Code" }]);
  for (const agentId of ["cursor", "hermes", "openclaw"]) assert.deepEqual(ui.sendTargets({ kind: "agent", agentId }), [], agentId);
  assert.deepEqual(ui.sendTargets({ kind: "update", agentId: "claude" }), []);
  assert.deepEqual(ui.sendTargets({ kind: "setup", agentId: "codex" }), []);
});

test("Hand-off section: the typed text arrives in a live region that is in the page from the start, so a screen reader reads it once and the caption is not repeated (sweep A item 9)", async () => {
  const section = await readFile(new URL("../src/ui/components/HandoffSection.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/ui/sessions.css", import.meta.url), "utf8");
  // One status region, always rendered (not only while the state is "typed"), holding the typed box and nothing else of its own.
  assert.match(section, /<div className="os-handoff__typed" role="status">\s*\{status\?\.kind === "typed" \? \(/, "the region is always there; the typed box is what gets added to it");
  assert.equal([...section.matchAll(/\{HANDOFF_CAPTION\}/g)].length, 2, "the caption words are written in two places: under Send, and (a session with no Send) above its typed text");
  assert.doesNotMatch(section, /className="os-handoff__status" role="status">\s*\{HANDOFF_CAPTION\}/, "and the caption is no longer a status of its own, so it is not announced twice");
  assert.match(css, /\.os-handoff__cap ~ \.os-handoff__typed > \.os-handoff__box/, "the box keeps its space under the caption");
});

test("Hand-off section: what a session's own panel says about text handed to it", () => {
  const session = (handoff, status = "idle") => ({ status, agentLabel: "Codex", handoff });
  assert.equal(ui.handoffStatus(session(null)), null);
  assert.equal(ui.handoffStatus({ status: "idle", agentLabel: "Codex" }), null, "a server without the field");
  assert.deepEqual(ui.handoffStatus(session({ state: "pending", text: "t", fromId: null, at: "x" })), { kind: "pending" });
  assert.deepEqual(ui.handoffStatus(session({ state: "typed", text: "t", fromId: null, at: "x" })), { kind: "typed", text: "t" });
  assert.deepEqual(ui.handoffStatus(session({ state: "copy", text: "t", fromId: null, at: "x" })), {
    kind: "copy",
    text: "t",
    reason: "Codex wasn't ready for typed text in time, so here is the text to copy."
  });
  // An ended session keeps only a copy (a new session that ended before it was ready: the text is not lost).
  assert.deepEqual(ui.handoffStatus(session({ state: "copy", text: "t", fromId: null, at: "x" }, "exited")), {
    kind: "copy",
    text: "t",
    reason: "Codex wasn't ready for typed text in time, so here is the text to copy."
  });
  assert.equal(ui.handoffStatus(session({ state: "typed", text: "t", fromId: null, at: "x" }, "exited")), null);
  assert.equal(ui.handoffStatus(session({ state: "pending", text: "t", fromId: null, at: "x" }, "exited")), null);
  assert.equal(ui.handoffStatus(session({ state: "copy", text: "", fromId: null, at: "x" })), null);
  assert.equal(ui.handoffStatus(session({ state: "odd", text: "t" })), null);
  assert.equal(ui.handoffCopyReason("Claude Code"), "Claude Code wasn't ready for typed text in time, so here is the text to copy.");
});

test("Hand-off section: the answer to a Send opens the session the text went to, or shows the text to copy with the server's reason; anything else is an unreadable answer", () => {
  const codex = { to: "codex", label: "Send to Codex for review", agentLabel: "Codex" };
  assert.deepEqual(ui.sendOutcome({ result: "typed", targetId: CODEX_ID, text: "t", reason: null }, codex), { open: CODEX_ID });
  assert.deepEqual(ui.sendOutcome({ result: "opening", targetId: NEW_ID, text: "t", reason: null }, codex), { open: NEW_ID });
  assert.deepEqual(ui.sendOutcome({ result: "copy", targetId: null, text: "t", reason: LIMIT_MESSAGE }, codex), { copy: { text: "t", reason: LIMIT_MESSAGE } });
  assert.deepEqual(ui.sendOutcome({ result: "copy", targetId: null, text: "t", reason: null }, codex), {
    copy: { text: "t", reason: "Codex wasn't ready for typed text in time, so here is the text to copy." }
  });
  for (const junk of [null, "x", {}, { result: "typed" }, { result: "copy", text: "" }, { result: "odd", targetId: CODEX_ID }]) {
    assert.deepEqual(ui.sendOutcome(junk, codex), { problem: "Agent OS gave an answer that could not be read." }, JSON.stringify(junk));
  }
});

// ---- 6. hidden characters in file names (orchestrator's ruling on X8) --------------------------------------
// A file name can carry characters that reorder or hide text: the direction marks and isolates (U+202A-202E,
// U+2066-2069), zero-width and direction marks (U+200B-200F), the Arabic letter mark (U+061C) and the byte-order
// mark (U+FEFF). The note is typed into another agent's input line, so they are removed with the controls.

test("cleanTypedText: reordering and zero-width characters are removed with the controls, so a file name in the note can't be shown out of order or hide text", () => {
  const ranges = [
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0x200b, 0x200f],
    [0x061c, 0x061c],
    [0xfeff, 0xfeff]
  ];
  let hidden = "";
  for (const [from, to] of ranges) {
    for (let code = from; code <= to; code += 1) {
      hidden += String.fromCharCode(code);
      assert.equal(cleanTypedText(`x${String.fromCharCode(code)}y`), "xy", `U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  assert.equal(cleanTypedText(`a${hidden}b`), "ab", "all 24 of them, in one text");
  // The neighbours just outside each range are ordinary characters and stay.
  assert.equal(
    cleanTypedText("\u2029\u202f\u2065\u206a\u200a\u2010\u061b\u061d\ufeff\ufefe"),
    "\u2029\u202f\u2065\u206a\u200a\u2010\u061b\u061d\ufefe"
  );
  assert.equal(pasteBody("\u202Eok\u200B"), `${PASTE_START}ok${PASTE_END}`);
  // The same sanitiser covers the note: sendTo cleans what buildReviewNote builds, name and counts included.
  const note = cleanTypedText(
    buildReviewNote({
      fromLabel: "Codex",
      files: [
        { path: "src/\u202Egnp.exe", added: 2, removed: 1 },
        { path: "a\u200Bb\u2066c.txt", added: null, removed: null }
      ]
    })
  );
  assert.equal(note, "Please review the changes Codex made in this folder:\n- src/gnp.exe (+2 −1)\n- abc.txt");
  assert.ok(!/[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(note), "none left");
});

// ---- 7. fix round 1 (review of Task X8) ---------------------------------------------------------------------

test("sendTo: a second Send while the target still holds the same unsent note types nothing again and answers typed; another note, or a target the person typed in since, is typed as usual", async () => {
  const files = [{ path: "src/App.tsx", status: "modified", added: 4, removed: 1 }];
  const { manager, calls, handoffs } = handoffStub({
    files,
    live: [{ id: CODEX_ID, agentId: "codex", folder: FOLDER, status: "idle" }],
    ready: [CODEX_ID]
  });
  const typedCount = () => calls.filter((call) => call[0] === "typeInto").length;
  const first = await sendTo(manager, FROM_ID, "codex");
  assert.equal(first.result, "typed");
  assert.equal(typedCount(), 1);
  assert.deepEqual(await sendTo(manager, FROM_ID, "codex"), first, "the same answer, the same note");
  assert.equal(typedCount(), 1, "nothing was written the second time: no double note in the input line");
  files.push({ path: "src/Other.tsx", status: "modified", added: 1, removed: 0 });
  assert.equal((await sendTo(manager, FROM_ID, "codex")).result, "typed");
  assert.equal(typedCount(), 2, "a different note (a new file) is typed");
  handoffs.delete(CODEX_ID); // the summary's `handoff` is null again once the person typed in that session
  assert.equal((await sendTo(manager, FROM_ID, "codex")).result, "typed");
  assert.equal(typedCount(), 3, "after the person's own input the same note is typed again");
});

test("sendTo with the real manager: the second Send writes nothing more into the PTY; after the person's own input it types again", async () => {
  await withWorld({}, async (world, { project }) => {
    const m = world.manager;
    const source = await liveSession(world, "claude", project);
    const target = await liveSession(world, "codex", project);
    const first = await sendTo(m, source.id, "codex");
    assert.deepEqual(first, { result: "typed", targetId: target.id, text: SHORT_NOTE, reason: null });
    assert.deepEqual(target.pty.writes, [`${PASTE_START}${SHORT_NOTE}${PASTE_END}`]);
    assert.deepEqual(await sendTo(m, source.id, "codex"), first);
    assert.equal(target.pty.writes.length, 1, "no duplicate in the target's input line");
    assert.equal((await m.get(target.id)).handoff.state, "typed", "the target's panel still says it is typed");

    await m.attach(target.id, { id: "w", send() {}, close() {} });
    assert.equal(m.focus(target.id, "w"), true);
    world.clock = T0 + 1000;
    assert.equal(m.write(target.id, "w", "x"), true);
    assert.equal((await sendTo(m, source.id, "codex")).result, "typed");
    const pastes = target.pty.writes.filter((write) => write.startsWith(PASTE_START));
    assert.equal(pastes.length, 2, "the person typed since (their own key is the other write), so the note goes in again");
    assert.equal(target.pty.writes.length, 3);
  });
});

test("sendTo: Sends from the same session or from two sessions in one folder while the new session is still starting open one session, and every answer names it", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { manager, calls, handoffs } = handoffStub({ createGate: gate });
  const sends = [sendTo(manager, FROM_ID, "codex"), sendTo(manager, FROM_ID, "codex"), sendTo(manager, OTHER_FROM_ID, "codex")];
  await sleep(40);
  assert.equal(calls.filter((call) => call[0] === "create").length, 1, "one session is being started, not three");
  release();
  const answers = await Promise.all(sends);
  for (const answer of answers) assert.deepEqual(answer, { result: "opening", targetId: NEW_ID, text: SHORT_NOTE, reason: null });
  await until(() => handoffs.get(NEW_ID)?.state === "typed");
  assert.equal(calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(calls.filter((call) => call[0] === "typeInto").length, 1, "the note is typed once");
  assert.equal(calls.filter((call) => call[0] === "setHandoff" && call[2] === "pending").length, 1);
});

test("sendTo: when the start that other Sends wait for is refused they all answer copy with that sentence, and a later Send tries again", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const refusal = sessionError(409, "too_many_sessions", LIMIT_MESSAGE);
  const { manager, calls } = handoffStub({ createGate: gate, createError: refusal });
  const sends = [sendTo(manager, FROM_ID, "codex"), sendTo(manager, OTHER_FROM_ID, "codex")];
  await sleep(40);
  release();
  for (const answer of await Promise.all(sends)) assert.deepEqual(answer, { result: "copy", targetId: null, text: SHORT_NOTE, reason: LIMIT_MESSAGE });
  assert.equal(calls.filter((call) => call[0] === "create").length, 1);
  await sendTo(manager, FROM_ID, "codex");
  assert.equal(calls.filter((call) => call[0] === "create").length, 2, "the finished start is not remembered: the next Send starts again");
});

test("a new target that ends before it is ready ends in copy on its own summary, with the text; nothing is written; it is kept when the session leaves memory; typed and pending are not", async () => {
  await withWorld({}, async (world, { agentOsHome, project }) => {
    const m = world.manager;
    const source = await liveSession(world, "claude", project);
    const answer = await sendTo(m, source.id, "codex");
    assert.equal(answer.result, "opening");
    const targetPty = world.ptys.at(-1);
    assert.equal((await m.get(answer.targetId)).handoff?.state, "pending");
    targetPty.exit(1);
    const ended = await waitFor(async () => {
      const summary = await m.get(answer.targetId);
      return summary.status === "exited" && summary.handoff?.state === "copy" ? summary : null;
    });
    assert.equal(ended.handoff.text, SHORT_NOTE, "the text is not lost");
    assert.equal(ended.handoff.fromId, source.id);
    assert.deepEqual(targetPty.writes, [], "nothing was written to an agent that never got ready");
    // The session leaves memory once its meta.json is written; the copy is still there (memory only, bounded).
    await waitFor(async () => (await readFile(path.join(agentOsHome, "sessions", answer.targetId, "meta.json"), "utf8").catch(() => "")).includes('"exited"'));
    await sleep(150);
    const later = await m.get(answer.targetId);
    assert.equal(later.status, "exited");
    assert.deepEqual(later.handoff, ended.handoff);
    const meta = await readFile(path.join(agentOsHome, "sessions", answer.targetId, "meta.json"), "utf8");
    assert.ok(!meta.includes('"handoff"') && !meta.includes(SHORT_NOTE), "still never on disk");
    // Dismissing the session releases the kept text from memory.
    await m.dismiss(answer.targetId);
    assert.equal((await m.get(answer.targetId)).handoff, null, "a dismissed session keeps no hand-off text");

    // A typed hand-off does not outlive its session.
    const typed = await liveSession(world, "codex", project);
    assert.deepEqual(m.typeInto(typed.id, "x"), { ok: true });
    typed.pty.exit(0);
    await waitFor(async () => (await m.get(typed.id)).status === "exited");
    assert.equal((await m.get(typed.id)).handoff, null);
  });
});
