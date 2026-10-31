// Sessions REST routes, the local-only guard and the server wiring (SP3, Task S8).
//
// Two halves:
//   1. In process: the real routers on a real port with a stub session manager,
//      so every route's own checks (ids, fixed paths, the settings body, how
//      refusals are answered, the recording stream, local mode) are tested
//      without a terminal.
//   2. Child process: the real server (node server/index.js) with Task W1's
//      six fake agents on PATH, for the wiring: the mounts, local mode only,
//      the folder policy through the real manager, recovery before listen, the
//      login shell never delaying start-up, one session from create to
//      delete, and a quit (the desktop's stdin line, or SIGTERM) with a live
//      session (ruling R18).
// Temp HOME and AGENT_OS_HOME only; the fakes are W1's TUI fakes
// (test/helpers/fake-agents.js), written into the temp home, and the login
// shell is W1's FAKE_LOGIN_SHELL (ruling R15), except in the tests whose
// subject is a failing or a hanging login shell. Never a real agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { before, describe, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { brainError } from "../server/runtime/builders/brain-launch.js";
import { isLocalMode, requireLocalMode } from "../server/runtime/local-session.js";
import { SESSION_ID_RE, sessionError } from "../server/runtime/sessions/errors.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { deleteRecording } from "../server/runtime/sessions/recorder.js";
import { createRecordingsRouter, createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { FALLBACK_NOTICE, NESTED_MARKERS, resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const SKIP_POSIX = isWindows ? "POSIX only: the fake agents are sh scripts" : false;
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const TOKEN = "test-token-123";
const KNOWN_ID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
const OTHER_ID = "9d1e8b6a-2c3f-4a5b-8c7d-abcdefabcdef";
const NEW_ID = "5b0e7c3d-8a9f-4e21-b3c4-d5e6f7a8b9c0";
const UNKNOWN_SESSION = { error: "unknown_session", message: "That session doesn't exist anymore." };
const INTERNAL_ERROR = { error: "internal_error", message: "Something went wrong with sessions. Try again." };
const INVALID_SETTINGS = {
  error: "invalid_settings",
  message: "Only the Claude Code fullscreen setting (on or off) can be changed here."
};
const LOOK_ONLY_MESSAGE =
  "Safety is on Look only, so no session can start. Allow running agents in Safety, then try again.";
const MODE_KEYS = {
  DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
  HERMES_AGENT_OS_PUBLIC_MODE: undefined
};
const NOT_LOCAL_MODES = [
  { DEMO_PUBLIC: "1" },
  { HERMES_AGENT_OS_DEMO_PUBLIC: "yes" },
  { HERMES_AGENT_OS_REQUIRE_AUTH: "1" },
  { HERMES_AGENT_OS_PUBLIC_MODE: "1" }
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 10000, what = "a condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(50);
  }
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

// ---------------------------------------------------------------------------
// 1. In process: the routers with a stub manager
// ---------------------------------------------------------------------------

// A temp HOME, a separate AGENT_OS_HOME inside it, local mode, and W1's
// stand-in login shell (R15). HOME is the realpath of the temp folder: on
// macOS os.tmpdir() sits behind a symlink.
async function withSessionsEnv(fn, extra = {}) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-sessions-routes-")));
  const agentOsHome = path.join(home, ".hermes-agent-os");
  await mkdir(agentOsHome, { recursive: true });
  try {
    return await withEnv(
      {
        ...MODE_KEYS,
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        HERMES_AGENT_OS_HOME: undefined,
        AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
        HERMES_HOME: undefined,
        SHELL: FAKE_LOGIN_SHELL,
        ...extra
      },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        return fn({ home, agentOsHome });
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function summary(id, extra = {}) {
  return {
    id,
    kind: "agent",
    agentId: "claude",
    agentLabel: "Claude Code",
    folder: "/Users/you/project",
    folderName: "project",
    folderShown: true,
    branch: null,
    status: "live",
    stateSince: "2026-10-14T10:00:00.000Z",
    startedAt: "2026-10-14T10:00:00.000Z",
    endedAt: null,
    exitCode: null,
    signal: null,
    endedBy: null,
    dismissed: false,
    brain: null,
    resume: { available: false, reason: null, fallback: false },
    alerts: "basic",
    recordingBytes: 0,
    ...extra
  };
}

// A manager that records every call. KNOWN_ID exists and runs; any other id is
// unknown. Tests replace single methods on `manager` when they need a refusal.
function stubManager() {
  const calls = [];
  const manager = {
    maxLive: 8,
    async list(options) {
      calls.push(["list", options]);
      return [summary(KNOWN_ID)];
    },
    async create(input) {
      calls.push(["create", input]);
      return summary(NEW_ID, { agentId: input.agentId, status: "starting" });
    },
    async get(id) {
      calls.push(["get", id]);
      if (id === KNOWN_ID) return summary(id);
      throw sessionError(404, "unknown_session", "That session doesn't exist anymore.");
    },
    async stop(id, options) {
      calls.push(["stop", id, options]);
      if (id !== KNOWN_ID) throw sessionError(404, "unknown_session", "That session doesn't exist anymore.");
      return { ...summary(id, { status: "exited", endedBy: "stop", endedAt: "2026-10-14T10:05:00.000Z" }), note: null };
    },
    async resume(id) {
      calls.push(["resume", id]);
      return summary(id, { status: "starting" });
    },
    async dismiss(id) {
      calls.push(["dismiss", id]);
      return summary(id, { dismissed: true });
    },
    async quitCheck() {
      calls.push(["quitCheck"]);
      return { live: [{ id: KNOWN_ID, title: "Claude Code · project", kind: "agent" }] };
    },
    async markers(id) {
      calls.push(["markers", id]);
      if (id === KNOWN_ID) return [{ at: "2026-10-14T10:01:00.000Z", type: "prompt" }];
      throw sessionError(404, "unknown_session", "That session doesn't exist anymore.");
    },
    // Synchronous like the real one (ruling R8). Not recorded in `calls`: the
    // recordings routes ask it, and the fixed-path test counts only quitCheck.
    isLive(id) {
      return id === KNOWN_ID;
    },
    // Like the real one (Task U11): recorder.js's own checks and removal, with this stub's isLive.
    async deleteRecording(id) {
      calls.push(["deleteRecording", id]);
      return deleteRecording(id, { isLive: (sessionId) => sessionId === KNOWN_ID });
    }
  };
  return { manager, calls };
}

// The two routers on a real port, mounted the way server/index.js mounts them.
async function withSessionsApp(manager, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
  app.use("/api/recordings", requireLocalMode, createRecordingsRouter({ manager }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: "test_handler", message: error.message }));
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
    return { status: response.status, headers: response.headers, json, text };
  };
  try {
    return await fn(api);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const EVERY_ROUTE = [
  ["GET", "/api/sessions"],
  ["POST", "/api/sessions", { agentId: "claude", folder: "/tmp" }],
  ["GET", "/api/sessions/folders"],
  ["GET", "/api/sessions/settings"],
  ["PUT", "/api/sessions/settings", { claudeFullscreen: true }],
  ["POST", "/api/sessions/quit-check", {}],
  ["GET", `/api/sessions/${KNOWN_ID}`],
  ["POST", `/api/sessions/${KNOWN_ID}/stop`, {}],
  ["POST", `/api/sessions/${KNOWN_ID}/resume`, {}],
  ["POST", `/api/sessions/${KNOWN_ID}/dismiss`, {}],
  ["GET", `/api/sessions/${KNOWN_ID}/recording`],
  ["DELETE", `/api/sessions/${KNOWN_ID}/recording`],
  ["GET", `/api/sessions/${KNOWN_ID}/markers`],
  ["GET", `/api/sessions/${KNOWN_ID}/keep-going`],
  ["POST", `/api/sessions/${KNOWN_ID}/keep-going`, {}],
  ["POST", `/api/sessions/${KNOWN_ID}/hand-over`, { to: "claude" }],
  ["GET", "/api/recordings"],
  // SP4 (E1 test gap): the pending approvals, the folder check of the New session dialog, the hand-off, the changes
  // panel and the separate copy. Each one answers as if it did not exist outside local mode (spec Security 1).
  ["GET", "/api/sessions/approvals"],
  ["POST", "/api/sessions/approvals/resolve", { id: "ap-1", decision: "allow-once" }],
  ["POST", "/api/sessions/folder-check", { folder: "/tmp", agentId: "claude" }],
  ["POST", `/api/sessions/${KNOWN_ID}/send`, { to: "codex" }],
  ["GET", `/api/sessions/${KNOWN_ID}/changes`],
  ["GET", `/api/sessions/${KNOWN_ID}/changes/diff?path=notes.md`],
  ["DELETE", `/api/sessions/${KNOWN_ID}/worktree`]
];

before(() => {
  resetLoginShellEnvForTests();
});

test("isLocalMode: false in the public demo and in the admin-token public mode, true otherwise", async () => {
  await withEnv(MODE_KEYS, async () => assert.equal(isLocalMode(), true));
  for (const vars of NOT_LOCAL_MODES) {
    await withEnv({ ...MODE_KEYS, ...vars }, async () => assert.equal(isLocalMode(), false, JSON.stringify(vars)));
  }
});

test("outside local mode every sessions and recordings address is 404 not_available, and nothing runs", async () => {
  for (const vars of NOT_LOCAL_MODES) {
    await withSessionsEnv(async ({ agentOsHome }) => {
      const { manager, calls } = stubManager();
      await withSessionsApp(manager, async (api) => {
        for (const [method, url, body] of EVERY_ROUTE) {
          const response = await api(method, url, body);
          assert.equal(response.status, 404, `${JSON.stringify(vars)} ${method} ${url}`);
          assert.deepEqual(response.json, { error: "not_available" }, `${method} ${url}`);
        }
      });
      assert.deepEqual(calls, [], "the manager is never asked");
      await assert.rejects(stat(path.join(agentOsHome, "config", "sessions.json")), "the settings were not written");
    }, vars);
  }
});

test("no route takes a brain from the page (ruling R26): POST /api/sessions and POST /:id/resume pass none on to the manager, whatever the body says", async () => {
  await withSessionsEnv(async () => {
    const { manager, calls } = stubManager();
    const resumed = [];
    manager.resume = async (...args) => {
      resumed.push(args);
      return summary(KNOWN_ID, { status: "starting" });
    };
    const brain = { mode: "openrouter", model: "openai/gpt-5.5" };
    await withSessionsApp(manager, async (api) => {
      const created = await api("POST", "/api/sessions", { agentId: "claude", folder: "/tmp", brainOverride: brain, brain });
      assert.equal(created.status, 201);
      const answer = await api("POST", `/api/sessions/${KNOWN_ID}/resume`, { brainOverride: brain, brain });
      assert.equal(answer.status, 200);
    });
    const [, input] = calls.find(([name]) => name === "create");
    assert.equal(Object.hasOwn(input, "brainOverride"), false, JSON.stringify(input));
    assert.equal(Object.hasOwn(input, "brain"), false, JSON.stringify(input));
    assert.deepEqual(resumed, [[KNOWN_ID]], "resume is asked with the id alone");
  });
});

test("an id that is not a lower-case version 4 uuid is 404 unknown_session before the manager or the disk is asked", async () => {
  const badIds = [
    "not-a-uuid",
    KNOWN_ID.toUpperCase(),
    "3f2c9a7e-1b4d-1c8e-9f00-0123456789ab", // version 1
    "3f2c9a7e-1b4d-4c8e-7f00-0123456789ab", // wrong variant
    "%2e%2e%2f%2e%2e%2fetc", // "../../etc" once decoded
    `${KNOWN_ID}0`
  ];
  for (let i = 0; i < 20; i += 1) assert.match(crypto.randomUUID(), SESSION_ID_RE);
  await withSessionsEnv(async () => {
    const { manager, calls } = stubManager();
    await withSessionsApp(manager, async (api) => {
      for (const id of badIds) {
        for (const [method, suffix] of [
          ["GET", ""],
          ["POST", "/stop"],
          ["POST", "/resume"],
          ["POST", "/dismiss"],
          ["GET", "/recording"],
          ["DELETE", "/recording"]
        ]) {
          const response = await api(method, `/api/sessions/${id}${suffix}`, method === "POST" ? {} : undefined);
          assert.equal(response.status, 404, `${method} ${id}${suffix}`);
          assert.deepEqual(response.json, UNKNOWN_SESSION, `${method} ${id}${suffix}`);
        }
      }
    });
    assert.deepEqual(calls, []);
  });
});

test("an id with broken percent-encoding is 404 unknown_session, not Express's own 400 with its message", async () => {
  await withSessionsEnv(async () => {
    const { manager, calls } = stubManager();
    await withSessionsApp(manager, async (api) => {
      for (const id of ["%E0%A4%A", "%", "%zz", "%C0%AF", `${KNOWN_ID}%`]) {
        for (const [method, suffix] of [
          ["GET", ""],
          ["POST", "/stop"],
          ["POST", "/resume"],
          ["POST", "/dismiss"],
          ["GET", "/recording"],
          ["DELETE", "/recording"]
        ]) {
          const response = await api(method, `/api/sessions/${id}${suffix}`, method === "POST" ? {} : undefined);
          assert.equal(response.status, 404, `${method} ${id}${suffix}`);
          assert.deepEqual(response.json, UNKNOWN_SESSION, `${method} ${id}${suffix}`);
          assert.equal(response.text.includes("decode"), false, "Express's own text is not shown");
        }
      }
    });
    assert.deepEqual(calls, []);
  });
});

test("fixed paths come before /:id: folders, settings and quit-check reach their own handlers", async () => {
  await withSessionsEnv(async () => {
    const { manager, calls } = stubManager();
    await withSessionsApp(manager, async (api) => {
      const folders = await api("GET", "/api/sessions/folders");
      assert.equal(folders.status, 200);
      assert.deepEqual(folders.json, { folders: [] });

      const settings = await api("GET", "/api/sessions/settings");
      assert.equal(settings.status, 200);
      assert.deepEqual(settings.json, { claudeFullscreen: false });

      const quit = await api("POST", "/api/sessions/quit-check", {});
      assert.equal(quit.status, 200);
      assert.deepEqual(quit.json, { live: [{ id: KNOWN_ID, title: "Claude Code · project", kind: "agent" }] });

      // Routing is case sensitive: "FOLDERS" is not the folders address, and
      // as an id it fails the pattern.
      const upper = await api("GET", "/api/sessions/FOLDERS");
      assert.equal(upper.status, 404);
      assert.deepEqual(upper.json, UNKNOWN_SESSION);
    });
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["quitCheck"],
      "no fixed path fell through to the :id handlers"
    );
  });
});

test("PUT /api/sessions/settings accepts only claudeFullscreen as true or false (settings.js's own 400)", async () => {
  await withSessionsEnv(async () => {
    const { manager } = stubManager();
    await withSessionsApp(manager, async (api) => {
      const on = await api("PUT", "/api/sessions/settings", { claudeFullscreen: true });
      assert.equal(on.status, 200);
      assert.deepEqual(on.json, { claudeFullscreen: true });
      assert.deepEqual((await api("GET", "/api/sessions/settings")).json, { claudeFullscreen: true });

      for (const body of [
        { claudeFullscreen: "yes" },
        { claudeFullscreen: 1 },
        {},
        { claudeFullscreen: false, extra: true },
        { kittyKeyboard: false },
        [true]
      ]) {
        const refused = await api("PUT", "/api/sessions/settings", body);
        assert.equal(refused.status, 400, JSON.stringify(body));
        assert.deepEqual(refused.json, INVALID_SETTINGS, JSON.stringify(body));
      }
      assert.deepEqual((await api("GET", "/api/sessions/settings")).json, { claudeFullscreen: true }, "unchanged");

      const off = await api("PUT", "/api/sessions/settings", { claudeFullscreen: false });
      assert.deepEqual(off.json, { claudeFullscreen: false });
    });
  });
});

test("GET /api/sessions: agent sessions unless kind=all, with the login-shell notice, the terminal module and the limit", async () => {
  resetLoginShellEnvForTests();
  // The subject here is a login shell that fails at once (/usr/bin/false,
  // never a real shell; decision Q1c allows it): the list carries the
  // fallback notice once it is known, and never waits for it.
  await withSessionsEnv(
    async () => {
      const { manager, calls } = stubManager();
      await withSessionsApp(manager, async (api) => {
        const first = await api("GET", "/api/sessions");
        assert.equal(first.status, 200);
        assert.deepEqual(first.json.sessions, [summary(KNOWN_ID)]);
        assert.equal(first.json.maxLive, 8);
        assert.deepEqual(first.json.pty, { ok: true, reason: null });
        assert.ok(first.json.environmentNotice === null || typeof first.json.environmentNotice === "string");
        assert.deepEqual(calls.at(-1), ["list", { includeUpdate: false }]);

        await api("GET", "/api/sessions?kind=all");
        assert.deepEqual(calls.at(-1), ["list", { includeUpdate: true }]);
        await api("GET", "/api/sessions?kind=update");
        assert.deepEqual(calls.at(-1), ["list", { includeUpdate: false }]);

        // live=1 asks for the sessions that are running now (the hold to stop all's list, Task S10); any other value is ignored.
        await api("GET", "/api/sessions?kind=all&live=1");
        assert.deepEqual(calls.at(-1), ["list", { includeUpdate: true, liveOnly: true }]);
        await api("GET", "/api/sessions?live=1");
        assert.deepEqual(calls.at(-1), ["list", { includeUpdate: false, liveOnly: true }]);
        for (const odd of ["live=0", "live=true", "live=", "live=yes", "live=1&live=0", "live[]=1", "Live=1"]) {
          const answered = await api("GET", `/api/sessions?kind=all&${odd}`);
          assert.equal(answered.status, 200, odd);
          assert.deepEqual(calls.at(-1), ["list", { includeUpdate: true }], odd);
        }

        if (!isWindows) {
          await waitFor(
            async () => (await api("GET", "/api/sessions")).json.environmentNotice === FALLBACK_NOTICE,
            8000,
            "the fallback notice"
          );
        }
      });
    },
    isWindows ? {} : { SHELL: "/usr/bin/false" }
  );
});

test("GET /api/sessions reports the manager's own limit, not a constant copied into the route", async () => {
  await withSessionsEnv(async () => {
    // A real manager (nothing starts: the list reads an empty sessions folder).
    const manager = createSessionManager({ maxLive: 3 });
    assert.equal(manager.maxLive, 3);
    assert.equal(createSessionManager().maxLive, 8, "the default limit");
    assert.throws(() => {
      manager.maxLive = 5;
    }, TypeError);
    assert.equal(manager.maxLive, 3, "read-only");
    await withSessionsApp(manager, async (api) => {
      const list = await api("GET", "/api/sessions");
      assert.equal(list.status, 200);
      assert.deepEqual(list.json.sessions, []);
      assert.equal(list.json.maxLive, 3);
      // The live-only list works against the real manager too, and carries the same envelope.
      const liveList = await api("GET", "/api/sessions?kind=all&live=1");
      assert.equal(liveList.status, 200);
      assert.deepEqual(liveList.json.sessions, []);
      assert.equal(liveList.json.maxLive, 3);
    });
  });
});

test("POST /api/sessions hands the agent and folder to the manager and answers its refusals with their own status", async () => {
  await withSessionsEnv(async () => {
    const { manager, calls } = stubManager();
    manager.create = async (input) => {
      calls.push(["create", input]);
      if (input.folder === "/Users/you") {
        throw sessionError(400, "folder_refused", "Your home folder itself can't be used. Pick a folder inside it.", {
          code: "is_home"
        });
      }
      if (input.agentId === "bash") {
        throw sessionError(400, "unknown_agent", "Agent OS can't start a session for that agent.");
      }
      if (input.folder === "/Users/you/needs-key") {
        throw brainError("openrouter_key_missing", "Add your OpenRouter key in Setup, then try again.");
      }
      return summary(NEW_ID, { agentId: input.agentId, status: "starting" });
    };
    await withSessionsApp(manager, async (api) => {
      const home = await api("POST", "/api/sessions", { agentId: "claude", folder: "/Users/you" });
      assert.equal(home.status, 400);
      assert.deepEqual(home.json, {
        error: "folder_refused",
        message: "Your home folder itself can't be used. Pick a folder inside it.",
        code: "is_home"
      });

      const agent = await api("POST", "/api/sessions", { agentId: "bash", folder: "/Users/you/project" });
      assert.equal(agent.status, 400);
      assert.deepEqual(agent.json, { error: "unknown_agent", message: "Agent OS can't start a session for that agent." });

      const brain = await api("POST", "/api/sessions", { agentId: "claude", folder: "/Users/you/needs-key" });
      assert.equal(brain.status, 409, "a brain error keeps the status builderErrorResponse gives it");
      assert.equal(brain.json.error, "openrouter_key_missing");

      const created = await api("POST", "/api/sessions", { agentId: "claude", folder: "/Users/you/project" });
      assert.equal(created.status, 201);
      assert.equal(created.json.id, NEW_ID);
      assert.deepEqual(calls.at(-1), ["create", { agentId: "claude", folder: "/Users/you/project" }]);

      // The page cannot choose the kind, the program, its argv, its environment
      // or its working folder: only the agent and folder reach the manager
      // (spec: an update session is never created by POST /api/sessions; the
      // agent's path comes from detection and its argv from H3).
      const extra = await api("POST", "/api/sessions", {
        agentId: "claude",
        folder: "/Users/you/project",
        kind: "update",
        command: "/bin/sh",
        args: ["-c", "id"],
        env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" },
        cwd: "/"
      });
      assert.equal(extra.status, 201);
      assert.deepEqual(
        calls.at(-1),
        ["create", { agentId: "claude", folder: "/Users/you/project" }],
        "only the agent and folder reach the manager: no kind, command, argv, env or cwd from the page"
      );

      // OpenClaw picks its own folder for now: the dialog sends null.
      const openclaw = await api("POST", "/api/sessions", { agentId: "openclaw", folder: null });
      assert.equal(openclaw.status, 201);
      assert.deepEqual(calls.at(-1), ["create", { agentId: "openclaw", folder: null }]);
    });
  });
});

test("errors: a sessionError keeps its status and code, anything else is a 500 that names no file", async () => {
  await withSessionsEnv(async () => {
    const { manager, calls } = stubManager();
    manager.dismiss = async () => {
      throw sessionError(409, "session_live", "That session is still running. Stop it first, then dismiss it.");
    };
    manager.resume = async () => {
      throw new Error(`EACCES: permission denied, open '${os.homedir()}/secret/meta.json'`);
    };
    await withSessionsApp(manager, async (api) => {
      const stopped = await api("POST", `/api/sessions/${KNOWN_ID}/stop`, {});
      assert.equal(stopped.status, 200);
      assert.equal(stopped.json.id, KNOWN_ID, "the bare summary, no wrapper object");
      assert.equal(stopped.json.status, "exited");
      assert.equal(stopped.json.note, null);
      assert.deepEqual(
        calls.find((call) => call[0] === "stop"),
        ["stop", KNOWN_ID, { by: "stop" }]
      );

      const unknown = await api("POST", `/api/sessions/${OTHER_ID}/stop`, {});
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.json, UNKNOWN_SESSION);

      const live = await api("POST", `/api/sessions/${KNOWN_ID}/dismiss`, {});
      assert.equal(live.status, 409);
      assert.deepEqual(live.json, {
        error: "session_live",
        message: "That session is still running. Stop it first, then dismiss it."
      });

      const broken = await api("POST", `/api/sessions/${KNOWN_ID}/resume`, {});
      assert.equal(broken.status, 500);
      assert.deepEqual(broken.json, { error: "internal_error", message: "Something went wrong with sessions. Try again." });
      assert.equal(broken.text.includes(os.homedir()), false, "no file path in the answer");

      const one = await api("GET", `/api/sessions/${KNOWN_ID}`);
      assert.equal(one.status, 200);
      assert.equal(one.json.id, KNOWN_ID);
      const gone = await api("GET", `/api/sessions/${OTHER_ID}`);
      assert.equal(gone.status, 404);
      assert.deepEqual(gone.json, UNKNOWN_SESSION);
    });
  });
});

// Whatever a manager throws, the answer is written and the server goes on. The
// answer is written inside handle()'s .catch, where a throw would be an
// unhandled rejection, and on Node 22 that ends the whole server.
test("errors: an odd thrown value is the fixed 500, never a crash (statuses outside 400-599, extras that are not JSON, throwing getters)", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const logged = mock.method(console, "error", () => {});
  try {
    await withSessionsEnv(async () => {
      const { manager } = stubManager();
      const circular = {};
      circular.self = circular;
      const withStatus = (status, code = "unknown_session") => () => Object.assign(new Error("boom"), { status, code });
      const withCode = (code) => () => Object.assign(new Error("boom"), { code });
      const throwingExtra = () => {
        const error = sessionError(409, "session_live", "boom");
        Object.defineProperty(error, "extra", {
          get() {
            throw new Error("the extra can't be read");
          }
        });
        return error;
      };
      const odd = [
        ["a status that is a string", withStatus("404")],
        ["a status of 99999", withStatus(99999)],
        ["a status of 600", withStatus(600)],
        ["a status of 399", withStatus(399)],
        ["a status of 200", withStatus(200)],
        ["a status that is not whole", withStatus(404.5)],
        ["a status that is NaN", withStatus(Number.NaN)],
        ["a status that is infinite", withStatus(Number.POSITIVE_INFINITY)],
        ["a status but no code", () => Object.assign(new Error("boom"), { status: 404 })],
        ["a brain-table lookup that finds an inherited name (constructor)", withCode("constructor")],
        ["a brain-table lookup that finds an inherited name (toString)", withCode("toString")],
        ["a brain-table lookup that finds an inherited name (__proto__)", withCode("__proto__")],
        ["an extra that is not JSON (a BigInt)", () => sessionError(409, "session_live", "boom", { size: 10n })],
        ["an extra that points at itself", () => sessionError(409, "session_live", "boom", { loop: circular })],
        ["an extra that throws when it is read", throwingExtra],
        ["a thrown string", () => "just text"],
        ["a thrown null", () => null],
        ["a thrown undefined", () => undefined],
        ["a thrown object with no prototype", () => Object.create(null)]
      ];
      await withSessionsApp(manager, async (api) => {
        for (const [name, make] of odd) {
          manager.dismiss = async () => {
            throw make();
          };
          const response = await api("POST", `/api/sessions/${KNOWN_ID}/dismiss`, {});
          assert.equal(response.status, 500, name);
          assert.deepEqual(response.json, INTERNAL_ERROR, name);
        }

        // The edges of the allowed range keep their own status and sentence.
        for (const status of [400, 599]) {
          manager.dismiss = async () => {
            throw sessionError(status, "edge_case", "At the edge.");
          };
          const response = await api("POST", `/api/sessions/${KNOWN_ID}/dismiss`, {});
          assert.equal(response.status, status);
          assert.deepEqual(response.json, { error: "edge_case", message: "At the edge." });
        }

        // The server is still up.
        const alive = await api("GET", `/api/sessions/${KNOWN_ID}`);
        assert.equal(alive.status, 200);
      });
      await delay(100); // a rejection nobody handled would show up by now
    });
    assert.deepEqual(rejections, [], "no unhandled rejection");
    assert.ok(logged.mock.callCount() > 0, "the odd errors were logged on the server");
  } finally {
    logged.mock.restore();
    process.off("unhandledRejection", onRejection);
  }
});

// A session folder the way Tasks S5 and S6 leave it on disk: meta.json (it
// says "exited", or "live" for a session a killed server left behind) and,
// unless `cast` is false, a one-event recording.
async function writeSessionFixture(agentOsHome, id, { cast = true, status = "exited" } = {}) {
  const dir = path.join(agentOsHome, "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      version: 1,
      id,
      kind: "agent",
      agentId: "claude",
      agentLabel: "Claude Code",
      folder: "/Users/you/project",
      folderName: "project",
      folderShown: true,
      status,
      createdAt: "2026-10-14T10:00:00.000Z",
      startedAt: "2026-10-14T10:00:00.000Z",
      endedAt: status === "exited" ? "2026-10-14T10:05:00.000Z" : null,
      exitCode: status === "exited" ? 0 : null,
      signal: null,
      endedBy: null,
      dismissed: false
    })
  );
  if (cast) {
    await writeFile(
      path.join(dir, "screen.cast"),
      `${JSON.stringify({ version: 2, width: 120, height: 32, timestamp: 1 })}\n[0.1,"o","hi"]\n`
    );
  }
  return dir;
}

test("GET /api/sessions/:id/markers answers { markers } from the manager; an unknown session keeps the manager's 404, and a bad id never reaches it", async () => {
  await withSessionsEnv(async () => {
    const { manager, calls } = stubManager();
    await withSessionsApp(manager, async (api) => {
      const known = await api("GET", `/api/sessions/${KNOWN_ID}/markers`);
      assert.equal(known.status, 200, known.text);
      assert.deepEqual(known.json, { markers: [{ at: "2026-10-14T10:01:00.000Z", type: "prompt" }] });

      const unknown = await api("GET", `/api/sessions/${NEW_ID}/markers`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.json, UNKNOWN_SESSION);

      const bad = await api("GET", "/api/sessions/not-a-uuid/markers");
      assert.equal(bad.status, 404);
      assert.deepEqual(bad.json, UNKNOWN_SESSION);
    });
    assert.deepEqual(calls, [
      ["markers", KNOWN_ID],
      ["markers", NEW_ID]
    ]);
  });
});

test("GET /api/sessions/:id/recording streams the recorder's lines: the older segment, then the newer one without its header", async () => {
  await withSessionsEnv(async ({ agentOsHome }) => {
    const dir = path.join(agentOsHome, "sessions", KNOWN_ID);
    await mkdir(dir, { recursive: true });
    const olderHeader = JSON.stringify({ version: 2, width: 120, height: 32, timestamp: 1 });
    const newerHeader = JSON.stringify({ version: 2, width: 120, height: 32, timestamp: 2 });
    await writeFile(path.join(dir, "screen.cast"), `${newerHeader}\n[0.5,"o","new"]\n`);
    const noRecordingId = crypto.randomUUID();
    await writeSessionFixture(agentOsHome, noRecordingId, { cast: false });
    const { manager } = stubManager();
    await withSessionsApp(manager, async (api) => {
      const onlyCurrent = await api("GET", `/api/sessions/${KNOWN_ID}/recording`);
      assert.equal(onlyCurrent.status, 200);
      assert.match(onlyCurrent.headers.get("content-type") || "", /^application\/x-asciicast/);
      assert.equal(onlyCurrent.text, `${newerHeader}\n[0.5,"o","new"]\n`);

      await writeFile(path.join(dir, "screen.prev.cast"), `${olderHeader}\n[0.1,"o","old"]\n`);
      const both = await api("GET", `/api/sessions/${KNOWN_ID}/recording`);
      assert.equal(both.status, 200);
      assert.equal(both.text, `${olderHeader}\n[0.1,"o","old"]\n[0.5,"o","new"]\n`);

      const missingFolder = await api("GET", `/api/sessions/${OTHER_ID}/recording`);
      assert.equal(missingFolder.status, 404);
      assert.deepEqual(missingFolder.json, UNKNOWN_SESSION);

      const noFiles = await api("GET", `/api/sessions/${noRecordingId}/recording`);
      assert.equal(noFiles.status, 404);
      assert.deepEqual(noFiles.json, { error: "recording_missing", message: "That recording doesn't exist anymore." });
    });
  });
});

// screen.cast as a folder (with a file in it, so its size is not 0) opens like a
// file and then fails to read with EISDIR: a read error in the recording
// stream that no test fake is needed for.
async function breakCast(dir) {
  await mkdir(path.join(dir, "screen.cast"), { recursive: true });
  await writeFile(path.join(dir, "screen.cast", "inside"), "x");
}

test("GET /api/sessions/:id/recording: a read that fails before the first line is normal JSON, not an asciicast", { skip: SKIP_POSIX }, async () => {
  await withSessionsEnv(async ({ agentOsHome }) => {
    const dir = await writeSessionFixture(agentOsHome, KNOWN_ID, { cast: false });
    await breakCast(dir);
    const { manager } = stubManager();
    const logged = mock.method(console, "error", () => {});
    try {
      await withSessionsApp(manager, async (api) => {
        const failed = await api("GET", `/api/sessions/${KNOWN_ID}/recording`);
        assert.equal(failed.status, 500);
        assert.deepEqual(failed.json, INTERNAL_ERROR);
        assert.match(failed.headers.get("content-type") || "", /^application\/json/);
        assert.equal(failed.headers.get("cache-control"), null, "no asciicast headers were set");
      });
    } finally {
      logged.mock.restore();
    }
  });
});

test("GET /api/sessions/:id/recording: a read that fails halfway is logged in one line and the connection is closed", { skip: SKIP_POSIX }, async () => {
  await withSessionsEnv(async ({ agentOsHome }) => {
    const dir = await writeSessionFixture(agentOsHome, KNOWN_ID, { cast: false });
    // The older segment reads fine (its lines are sent), then the newer one fails.
    await writeFile(
      path.join(dir, "screen.prev.cast"),
      `${JSON.stringify({ version: 2, width: 120, height: 32, timestamp: 1 })}\n[0.1,"o","old"]\n`
    );
    await breakCast(dir);
    const { manager } = stubManager();
    const logged = mock.method(console, "error", () => {});
    try {
      await withSessionsApp(manager, async (api) => {
        await assert.rejects(api("GET", `/api/sessions/${KNOWN_ID}/recording`), "the stream was cut off");
        // Still up for the next request.
        assert.equal((await api("GET", `/api/sessions/${KNOWN_ID}`)).status, 200);
      });
      const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
      const line = lines.find((text) => text.includes("EISDIR"));
      assert.ok(line, `the failure was logged: ${JSON.stringify(lines)}`);
      assert.match(line, /^Agent OS sessions: an answer failed after it had started/);
      assert.equal(line.includes("\n"), false, "one line");
    } finally {
      logged.mock.restore();
    }
  });
});

test("recordings: the manager, not meta.json, says which session is live; delete refuses a live one", async () => {
  await withSessionsEnv(async ({ agentOsHome }) => {
    // Both say "exited" on disk; the stub manager's isLive still says KNOWN_ID runs.
    const liveDir = await writeSessionFixture(agentOsHome, KNOWN_ID);
    const endedId = crypto.randomUUID();
    const endedDir = await writeSessionFixture(agentOsHome, endedId);
    const { manager, calls } = stubManager();
    await withSessionsApp(manager, async (api) => {
      const list = await api("GET", "/api/recordings");
      assert.equal(list.status, 200);
      const byId = Object.fromEntries(list.json.recordings.map((item) => [item.sessionId, item]));
      assert.equal(byId[KNOWN_ID].live, true, "live because the manager runs it");
      assert.equal(byId[endedId].live, false);
      assert.equal(typeof list.json.removedByCap, "number");
      assert.ok(list.json.removedByCap >= 0);

      const refused = await api("DELETE", `/api/sessions/${KNOWN_ID}/recording`);
      assert.equal(refused.status, 409);
      assert.equal(refused.json.error, "recording_live");
      await stat(path.join(liveDir, "screen.cast")); // still there

      const deleted = await api("DELETE", `/api/sessions/${endedId}/recording`);
      assert.equal(deleted.status, 200);
      assert.deepEqual(deleted.json, { ok: true });
      await assert.rejects(stat(path.join(endedDir, "screen.cast")), "the recording is gone");
      await stat(path.join(endedDir, "meta.json")); // the session stays, with Resume

      const again = await api("DELETE", `/api/sessions/${endedId}/recording`);
      assert.equal(again.status, 404);
      assert.equal(again.json.error, "recording_missing");

      const unknown = await api("DELETE", `/api/sessions/${OTHER_ID}/recording`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.json, UNKNOWN_SESSION);

      // Task U11: every delete goes through the manager (which also removes the recording's moments).
      assert.deepEqual(
        calls.filter(([name]) => name === "deleteRecording").map(([, sessionId]) => sessionId),
        [KNOWN_ID, endedId, endedId, OTHER_ID]
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Child process: the real server with Task W1's six fake agents
// ---------------------------------------------------------------------------

// A temp HOME (its realpath) with a "project" folder and, on POSIX, W1's six
// fake agents in <home>/fake-bin (all six names, ruling R16). The fakes answer
// the detection probes (--version, --help, auth status) and `claude agents
// --json` at once, and otherwise run a small terminal program that prints
// FAKE_ARGV and a prompt. They live under os.tmpdir(), which the
// no-real-agents watcher allows.
async function makeHome(prefix) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  await mkdir(path.join(home, "project"), { recursive: true });
  if (!isWindows) await makeFakeAgentBin(path.join(home, "fake-bin"));
  return home;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Never passed on to the server unless a test sets one on purpose.
// AGENT_OS_PORT is the desktop shell's port name, which the server reads
// before PORT.
const CLEARED_KEYS = [
  "HERMES_HOME",
  "HERMES_AGENT_OS_HOME",
  // Detection searches it before PATH, so it could find a real agent (R16).
  "HERMES_AGENT_OS_EXECUTABLE_PATHS",
  "DEMO_PUBLIC",
  "HERMES_AGENT_OS_DEMO_PUBLIC",
  "HERMES_AGENT_OS_PUBLIC_MODE",
  "HERMES_AGENT_OS_REQUIRE_AUTH",
  "HERMES_AGENT_OS_ADMIN_TOKEN",
  "HERMES_AGENT_OS_ENABLE_EXEC",
  "AGENT_OS_LIVE_CHAT",
  "AGENT_OS_DEV_ORIGIN",
  "AGENT_OS_PACKAGED",
  "AGENT_OS_PORT",
  "AGENT_OS_STDIN_SHUTDOWN",
  "NODE_ENV",
  // The markers a host agent (Claude Code, Cursor) sets for its children: a
  // developer running these tests inside one must not make the test server
  // look nested (F-S7a).
  ...NESTED_MARKERS
];

function serverEnv(home, port, extra = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    HOME: home,
    USERPROFILE: home,
    AGENT_OS_HOME: path.join(home, ".hermes-agent-os"),
    AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
    AGENT_OS_TOKEN: TOKEN,
    HERMES_AGENT_OS_SCHEDULER: "0",
    // The login shell sessions read their environment from: W1's stand-in
    // (ruling R15), which keeps the PATH below. Never the developer's own
    // shell setup, and never a real login sh either: on macOS it runs
    // path_helper, which puts /usr/local/bin and /opt/homebrew/bin (where real
    // agents live) on the sessions' PATH.
    SHELL: FAKE_LOGIN_SHELL,
    // The six fakes first, then system folders only (ruling R16; not Node's
    // own folder, which can hold real agents).
    ...(isWindows ? {} : { PATH: [path.join(home, "fake-bin"), ...SYSTEM_PATH_DIRS].join(path.delimiter) })
  };
  for (const key of CLEARED_KEYS) {
    if (!(key in extra)) delete env[key];
  }
  return { ...env, ...extra };
}

// `stdin: "pipe"` keeps the server's stdin open, the way the desktop shell
// starts it (Q4); the stdin quit test writes the shutdown line into it.
async function startServer(home, extra = {}, { stdin = "ignore" } = {}) {
  const port = await freePort();
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: serverEnv(home, port, extra),
    stdio: [stdin, "pipe", "pipe"]
  });
  // A write into a server that has just exited must not crash the test run.
  child.stdin?.on("error", () => {});
  const logs = { text: "" };
  child.stdout.on("data", (chunk) => {
    logs.text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs.text += chunk;
  });
  const deadline = Date.now() + 20000;
  while (!/AGENT_OS_READY:\d+/.test(logs.text)) {
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode}):\n${logs.text.slice(-2000)}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server did not start:\n${logs.text.slice(-2000)}`);
    }
    await delay(25);
  }
  return { child, port, logs, readyAfterMs: Date.now() - startedAt };
}

// SIGTERM, then up to 10 s (the server's own hard exit is 8 s), then SIGKILL.
async function stopServer(server) {
  const { child } = server;
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function api(port, method, url, body) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

// Resolves { code, signal } when the child exits, or null after ms.
function exitWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// `running` holds the pids a test learned about and has not seen exit. A pid
// leaves it the moment it is seen gone, because the operating system may give
// that number to another process afterwards (the owner's Mac always runs
// real agents of its own), and clean-up must never signal such a process.
// watchPid drops a pid within 20 ms of its exit; gone drops it as soon as a
// wait has seen it gone. A pid that is still there when the wait runs out
// stays, to be cleaned up.
function watchPid(running, pid) {
  running.add(pid);
  (async () => {
    while (running.has(pid) && isAlive(pid)) await delay(20);
    running.delete(pid);
  })();
}

async function gone(running, pid, timeoutMs, what) {
  await waitFor(() => !isAlive(pid), timeoutMs, what);
  running.delete(pid);
}

// A pid read from the fake's log joins `running` only while the server that
// started it is still running. Once that server is gone it has reaped the
// process, and the number may already belong to another process (the owner's
// Mac always runs real agents of its own). So a pid learned that late is never
// tracked, and never signalled, even if something with that number is alive.
function learnPid(running, server, pid) {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  watchPid(running, pid);
  return true;
}

// Reads the fake's log until it holds an entry for `event`, or the server is
// gone. The entry's pid is learned (learnPid) the moment it is seen.
async function learnLoggedPid(running, server, fakeLog, event) {
  while (server.child.exitCode === null && server.child.signalCode === null) {
    const entry = (await readFakeLog(fakeLog)).find((item) => item.event === event);
    if (entry) return { entry, learned: learnPid(running, server, entry.pid) };
    await delay(25);
  }
  return { entry: null, learned: false };
}

// Clean-up for a test that failed half way: it signals only the pids still in
// `running`.
function killLeftovers(running, kill = (pid, signal) => process.kill(pid, signal)) {
  for (const pid of [...running]) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    running.delete(pid);
  }
}

test("test clean-up signals only the pids a test learned and has not seen exit, never a number the system may have given to another process", async () => {
  const running = new Set();

  // A process that ends by itself leaves the set as soon as its exit is seen.
  const short = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  watchPid(running, short.pid);
  assert.equal(running.has(short.pid), true);
  await waitFor(() => !running.has(short.pid), 5000, "the short-lived pid to leave the set");

  // A pid that a wait has seen gone leaves it at once.
  const waited = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  running.add(waited.pid);
  await gone(running, waited.pid, 5000, "the short-lived process to be gone");
  assert.equal(running.has(waited.pid), false);

  // A pid that is still there when the wait runs out stays.
  running.add(process.pid);
  await assert.rejects(gone(running, process.pid, 100, "this test process to be gone"), /timed out/);
  assert.equal(running.has(process.pid), true);
  running.delete(process.pid); // this test process is never signalled

  running.add(910001);
  const signalled = [];
  killLeftovers(running, (pid, signal) => signalled.push([pid, signal]));
  assert.deepEqual(signalled, [[910001, "SIGKILL"]]);
  assert.equal(running.size, 0);
  killLeftovers(running, () => assert.fail("nothing is left to signal"));
});

test("a pid read from a log joins the clean-up set only while the server that started it is running, so a number the system gave to another process after the server was gone is never signalled", async () => {
  const running = new Set();
  // This test's own process stands in for "a number that is alive but is not
  // the process the server started". It is never signalled: every kill here is
  // an injected one that only records.
  const stranger = process.pid;
  const signalled = [];
  const record = (pid, signal) => signalled.push([pid, signal]);
  try {
    // The server that started the process is gone (it exited, or a signal
    // ended it): the pid is not learned, even though something with that
    // number is alive.
    for (const child of [
      { exitCode: 0, signalCode: null },
      { exitCode: null, signalCode: "SIGKILL" }
    ]) {
      assert.equal(learnPid(running, { child }, stranger), false);
      assert.equal(running.size, 0);
    }
    killLeftovers(running, record);
    assert.deepEqual(signalled, [], "a pid learned after the server was gone is not signalled");

    // The server is still running: the pid is learned, and a process that is
    // still there when the clean-up runs is signalled.
    assert.equal(learnPid(running, { child: { exitCode: null, signalCode: null } }, stranger), true);
    assert.equal(running.has(stranger), true);
    killLeftovers(running, record);
    assert.deepEqual(signalled, [[stranger, "SIGKILL"]]);
  } finally {
    running.clear(); // ends the watcher; nothing real was signalled
  }

  // learnLoggedPid, on a log that has the entry and a server that is running.
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-sessions-learn-"));
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const fakeLog = path.join(dir, "fake.log");
    await writeFile(fakeLog, `${JSON.stringify({ event: "agents", pid: sleeper.pid })}\n`);
    const learnedSet = new Set();
    const seen = await learnLoggedPid(learnedSet, { child: sleeper }, fakeLog, "agents");
    assert.equal(seen.entry.pid, sleeper.pid);
    assert.equal(seen.learned, true);
    assert.equal(learnedSet.has(sleeper.pid), true);
    learnedSet.clear();

    // The server is already gone: nothing is learned from the log any more.
    const goneSet = new Set();
    const late = await learnLoggedPid(goneSet, { child: { exitCode: 0, signalCode: null } }, fakeLog, "agents");
    assert.deepEqual(late, { entry: null, learned: false });
    assert.equal(goneSet.size, 0);
  } finally {
    sleeper.kill("SIGKILL"); // our own child, through its handle
    await exitWithin(sleeper, 5000);
    await rm(dir, { recursive: true, force: true });
  }
});

// W1's fake writes one JSON object per line into FAKE_AGENT_LOG.
async function readFakeLog(file) {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // a line still being written; the next read has it
    }
  }
  return entries;
}

test("wiring: sessions mount behind requireLocalMode, recovery and the cap run before listen, the login shell after READY in local mode, .env keys and PORT stay out of sessions", async () => {
  const source = await readFile(path.join(root, "server", "index.js"), "utf8");
  const at = (needle) => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `server/index.js should contain: ${needle}`);
    return index;
  };
  const sessionsMount = at(
    'app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager: sessionManager, approvals: openclawApprovals }));'
  );
  const recordingsMount = at(
    'app.use("/api/recordings", requireLocalMode, createRecordingsRouter({ manager: sessionManager }));'
  );
  const pageFallback = at("app.use(express.static(dist));");
  const recovery = at("await sessionManager.recoverStaleSessions();");
  const cap = at("await enforceRecordingCap();");
  const listen = at("const server = app.listen(");
  const ready = at("console.log(`AGENT_OS_READY:${port}`);");
  const loginShell = at("if (isLocalMode()) getLoginShellEnv().catch(");
  assert.ok(sessionsMount < pageFallback && recordingsMount < pageFallback, "mounted before the page fallback");
  assert.ok(recovery < listen && cap < listen, "recovery and the cap run before the server listens");
  assert.match(
    source,
    /if \(isLocalMode\(\)\) \{\s*try \{\s*await sessionManager\.recoverStaleSessions\(\);[\s\S]*?await enforceRecordingCap\(\);[\s\S]*?\n\}\n\nconst server = app\.listen\(/,
    "recovery and the start-up cap sit inside `if (isLocalMode())`: sessions do not exist in the public demo or public mode"
  );
  assert.ok(loginShell > ready, "the login shell starts only after READY");
  assert.ok(
    at("excludeFromSessionEnv(envFile.applied)") > at("loadLocalEnv("),
    "the keys the local .env file added are kept out of sessions right after it is loaded"
  );
  assert.match(
    source,
    /process\.env\.AGENT_OS_PORT \?\? process\.env\.PORT/,
    "the port comes from AGENT_OS_PORT first (the desktop shell), then PORT"
  );
});

test("the real server: the public demo and public mode answer 404 not_available on sessions addresses", async () => {
  for (const extra of [
    { DEMO_PUBLIC: "1" },
    { HERMES_AGENT_OS_REQUIRE_AUTH: "1", HERMES_AGENT_OS_ADMIN_TOKEN: "admin-test" }
  ]) {
    const home = await makeHome("agent-os-sessions-modes-");
    const server = await startServer(home, extra);
    try {
      for (const [method, url, body] of [
        ["GET", "/api/sessions"],
        ["POST", "/api/sessions", { agentId: "claude", folder: path.join(home, "project") }],
        ["GET", "/api/sessions/folders"],
        ["POST", "/api/sessions/quit-check", {}],
        ["GET", `/api/sessions/${KNOWN_ID}/recording`],
        ["GET", "/api/recordings"]
      ]) {
        const response = await api(server.port, method, url, body);
        assert.equal(response.status, 404, `${JSON.stringify(extra)} ${method} ${url}`);
        assert.deepEqual(response.json, { error: "not_available" }, `${method} ${url}`);
      }
    } finally {
      await stopServer(server);
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("the real server: the public demo and public mode neither recover sessions nor touch recordings; local mode does", async () => {
  const home = await makeHome("agent-os-sessions-staleguard-");
  const id = crypto.randomUUID();
  const dir = await writeSessionFixture(path.join(home, ".hermes-agent-os"), id, { status: "live" });
  const metaFile = path.join(dir, "meta.json");
  const before = await readFile(metaFile, "utf8");
  try {
    for (const extra of [
      { DEMO_PUBLIC: "1" },
      { HERMES_AGENT_OS_REQUIRE_AUTH: "1", HERMES_AGENT_OS_ADMIN_TOKEN: "admin-test" }
    ]) {
      const server = await startServer(home, extra);
      try {
        assert.equal(await readFile(metaFile, "utf8"), before, `${JSON.stringify(extra)}: meta.json was not rewritten`);
        await stat(path.join(dir, "screen.cast")); // nor was the recording touched
      } finally {
        await stopServer(server);
      }
    }
    // The control: the same folder in local mode is recovered before the first request.
    const local = await startServer(home);
    try {
      const answer = await api(local.port, "GET", `/api/sessions/${id}`);
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.status, "exited");
      assert.equal(answer.json.endedBy, "quit");
      assert.notEqual(await readFile(metaFile, "utf8"), before, "local mode rewrote meta.json");
    } finally {
      await stopServer(local);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the real server: an empty or blank AGENT_OS_PORT counts as not set, so PORT applies", async () => {
  for (const blank of ["", "   "]) {
    const home = await makeHome("agent-os-sessions-blankport-");
    let server = null;
    try {
      server = await startServer(home, { AGENT_OS_PORT: blank });
      assert.match(
        server.logs.text,
        new RegExp(`AGENT_OS_READY:${server.port}\\b`),
        `AGENT_OS_PORT=${JSON.stringify(blank)}: the server should listen on PORT (${server.port})`
      );
      assert.equal((await api(server.port, "GET", "/api/sessions/folders")).status, 200);
    } finally {
      if (server) await stopServer(server);
      await rm(home, { recursive: true, force: true });
    }
  }
});

describe("the real server with the fake agents", { skip: SKIP_POSIX }, () => {
  test("one session from create to delete through the mounted routes", async () => {
    const home = await makeHome("agent-os-sessions-flow-");
    const server = await startServer(home);
    const project = path.join(home, "project");
    let id = null;
    try {
      const noToken = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
      assert.equal(noToken.status, 401, "the local session gate still covers /api/sessions");

      // Through the whole stack (gate, host checks, the app's error handler):
      // an id with broken percent-encoding is just an unknown session.
      const brokenId = await api(server.port, "GET", "/api/sessions/%E0%A4%A");
      assert.equal(brokenId.status, 404, brokenId.text);
      assert.deepEqual(brokenId.json, UNKNOWN_SESSION);

      const empty = await api(server.port, "GET", "/api/sessions");
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.json.sessions, []);
      assert.deepEqual(empty.json.pty, { ok: true, reason: null });
      assert.equal(empty.json.maxLive, 8);
      assert.ok(empty.json.environmentNotice === null || typeof empty.json.environmentNotice === "string");

      const lookOnly = await api(server.port, "POST", "/api/sessions", { agentId: "claude", folder: project });
      assert.equal(lookOnly.status, 409);
      assert.equal(lookOnly.json.error, "execution_gate_off");
      assert.equal(lookOnly.json.message, LOOK_ONLY_MESSAGE);

      const gate = await api(server.port, "POST", "/api/admin/execution-gate", { enabled: true, confirm: true });
      assert.equal(gate.status, 200);

      // Q14: the folder policy's refusals, through the real manager.
      for (const [folder, code] of [
        [home, "is_home"],
        ["projects/app", "not_absolute"],
        [path.join(home, "missing"), "missing"],
        [path.join(home, ".hermes-agent-os"), "inside_agent_os"]
      ]) {
        const refused = await api(server.port, "POST", "/api/sessions", { agentId: "claude", folder });
        assert.equal(refused.status, 400, `${folder}: ${refused.text}`);
        assert.equal(refused.json.error, "folder_refused");
        assert.equal(refused.json.code, code, folder);
        assert.equal(typeof refused.json.message, "string");
      }
      const notAnAgent = await api(server.port, "POST", "/api/sessions", { agentId: "bash", folder: project });
      assert.equal(notAnAgent.status, 400);
      assert.equal(notAnAgent.json.error, "unknown_agent");
      assert.deepEqual((await api(server.port, "GET", "/api/sessions")).json.sessions, [], "nothing was started");

      const created = await api(server.port, "POST", "/api/sessions", { agentId: "claude", folder: project });
      assert.equal(created.status, 201, created.text);
      id = created.json.id;
      assert.match(id, SESSION_ID_RE);
      assert.equal(created.json.kind, "agent");
      assert.equal(created.json.agentId, "claude");
      assert.equal(created.json.folder, project);
      assert.ok(["starting", "live"].includes(created.json.status), created.json.status);
      // The fake's first output makes it live; by then its recording has its header.
      await waitFor(
        async () => (await api(server.port, "GET", `/api/sessions/${id}`)).json?.status === "live",
        15000,
        "the session to go live"
      );

      const listed = await api(server.port, "GET", "/api/sessions");
      assert.ok(listed.json.sessions.some((session) => session.id === id));

      const quit = await api(server.port, "POST", "/api/sessions/quit-check", {});
      assert.equal(quit.status, 200);
      assert.deepEqual(
        quit.json.live.find((session) => session.id === id),
        { id, title: "Claude Code · project", kind: "agent" }
      );

      const dismissLive = await api(server.port, "POST", `/api/sessions/${id}/dismiss`, {});
      assert.equal(dismissLive.status, 409);
      assert.equal(dismissLive.json.error, "session_live");

      const recording = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/recording`, {
        headers: { "x-agent-os-token": TOKEN }
      });
      assert.equal(recording.status, 200);
      assert.match(recording.headers.get("content-type") || "", /^application\/x-asciicast/);
      assert.equal(JSON.parse((await recording.text()).split("\n")[0]).version, 2);

      const deleteLive = await api(server.port, "DELETE", `/api/sessions/${id}/recording`);
      assert.equal(deleteLive.status, 409);
      assert.equal(deleteLive.json.error, "recording_live");

      const recordings = await api(server.port, "GET", "/api/recordings");
      assert.equal(recordings.status, 200);
      assert.ok(recordings.json.recordings.some((item) => item.sessionId === id && item.live === true));
      assert.equal(typeof recordings.json.removedByCap, "number");

      const stopped = await api(server.port, "POST", `/api/sessions/${id}/stop`, {});
      assert.equal(stopped.status, 200, stopped.text);
      assert.equal(stopped.json.id, id, "the bare summary, no wrapper object");
      assert.equal(stopped.json.note, null, "only OpenClaw's Stop carries a note");
      const ended = await waitFor(
        async () => {
          const response = await api(server.port, "GET", `/api/sessions/${id}`);
          return response.json?.status === "exited" ? response.json : null;
        },
        15000,
        "the session to end"
      );
      assert.equal(ended.endedBy, "stop");

      const folders = await api(server.port, "GET", "/api/sessions/folders");
      assert.ok(folders.json.folders.some((folder) => folder.path === project && folder.name === "project"));

      const dismissed = await api(server.port, "POST", `/api/sessions/${id}/dismiss`, {});
      assert.equal(dismissed.status, 200, dismissed.text);
      assert.equal(dismissed.json.dismissed, true);

      const deleted = await api(server.port, "DELETE", `/api/sessions/${id}/recording`);
      assert.equal(deleted.status, 200, deleted.text);
      assert.deepEqual(deleted.json, { ok: true });
      assert.equal((await api(server.port, "GET", `/api/sessions/${id}/recording`)).status, 404);
      id = null;
    } finally {
      if (id) await api(server.port, "POST", `/api/sessions/${id}/stop`, {}).catch(() => {});
      await stopServer(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  test("recovery runs before listen: a session left live by a killed server reads ended (Agent OS quit) on the first request", async () => {
    const home = await makeHome("agent-os-sessions-recover-");
    let first = null;
    let second = null;
    try {
      first = await startServer(home);
      assert.equal((await api(first.port, "POST", "/api/admin/execution-gate", { enabled: true, confirm: true })).status, 200);
      const created = await api(first.port, "POST", "/api/sessions", {
        agentId: "claude",
        folder: path.join(home, "project")
      });
      assert.equal(created.status, 201, created.text);
      const id = created.json.id;
      await waitFor(
        async () => (await api(first.port, "GET", `/api/sessions/${id}`)).json?.status === "live",
        15000,
        "the session to go live"
      );

      // The hard way: nothing gets to write "ended" into meta.json. The fake
      // leaves on its own when its terminal closes (SIGHUP's default action).
      first.child.kill("SIGKILL");
      if (first.child.exitCode == null && first.child.signalCode == null) {
        await new Promise((resolve) => first.child.once("exit", resolve));
      }

      second = await startServer(home);
      const firstAnswer = await api(second.port, "GET", `/api/sessions/${id}`);
      assert.equal(firstAnswer.status, 200, firstAnswer.text);
      assert.equal(firstAnswer.json.status, "exited");
      assert.equal(firstAnswer.json.endedBy, "quit");
    } finally {
      if (second) await stopServer(second);
      if (first) await stopServer(first);
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a login shell that hangs never delays start-up, and the list does not wait for it", async () => {
    const home = await makeHome("agent-os-sessions-slowshell-");
    // The subject here is a hanging login shell (decision Q1c allows this
    // test its own): it sleeps past the 10 s limit and ends by itself after
    // 15 s in any case.
    const slowShell = path.join(home, "slow-shell");
    await writeFile(slowShell, "#!/bin/sh\nexec sleep 15\n");
    await chmod(slowShell, 0o755);
    const server = await startServer(home, { SHELL: slowShell });
    try {
      assert.ok(server.readyAfterMs < 9000, `READY took ${server.readyAfterMs} ms`);
      const startedAt = Date.now();
      const list = await api(server.port, "GET", "/api/sessions");
      assert.ok(Date.now() - startedAt < 3000, "the list answered without waiting for the login shell");
      assert.equal(list.status, 200);
      assert.equal(list.json.environmentNotice, null);
    } finally {
      await stopServer(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when the login shell fails, the list carries the plain notice", async () => {
    const home = await makeHome("agent-os-sessions-badshell-");
    // The subject here is a failing login shell (decision Q1c allows this
    // test its own): /usr/bin/false exits at once and prints nothing.
    const server = await startServer(home, { SHELL: "/usr/bin/false" });
    try {
      await waitFor(
        async () => (await api(server.port, "GET", "/api/sessions")).json?.environmentNotice === FALLBACK_NOTICE,
        10000,
        "the fallback notice"
      );
    } finally {
      await stopServer(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  // F-S7a, end to end through the real server: Agent OS started from inside
  // Claude Code's terminal (the test plants the host's variables in the
  // server's environment). The agent in the session must see none of them, not
  // the host's messaging token and socket and not its other CLAUDE_ settings:
  // only a startup file of the person could set one, and the stand-in login
  // shell reads none. The fake lists the names (never the values) it was given.
  test("a server started inside Claude Code: its sessions get none of the host's variables", async () => {
    const home = await makeHome("agent-os-sessions-nested-");
    const fakeLog = path.join(home, "fake.log");
    const server = await startServer(home, {
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/made/up.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "made-up-host-token",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      FAKE_AGENT_LOG: fakeLog
    });
    let id = null;
    try {
      assert.equal((await api(server.port, "POST", "/api/admin/execution-gate", { enabled: true, confirm: true })).status, 200);
      const created = await api(server.port, "POST", "/api/sessions", { agentId: "claude", folder: path.join(home, "project") });
      assert.equal(created.status, 201, created.text);
      id = created.json.id;
      const started = await waitFor(
        async () => (await readFakeLog(fakeLog)).find((entry) => entry.event === "start"),
        15000,
        "the fake's start entry"
      );
      // Claude Code's names and every host-only name, not CURSOR_*: this server
      // is nested in Claude Code, not Cursor, so a CURSOR_ name of the
      // developer's own terminal (CURSOR_RIPGREP_PATH) is kept on purpose.
      const leaked = started.hostKeys.filter((key) => key.startsWith("CLAUDE") || NESTED_MARKERS.includes(key));
      assert.deepEqual(leaked, [], "no variable of the host agent reached the session");
      assert.equal(started.env.CLAUDECODE, undefined);
      assert.equal(started.env.TERM_PROGRAM, "AgentOS", "the session's own variables are there");
    } finally {
      if (id) await api(server.port, "POST", `/api/sessions/${id}/stop`, {}).catch(() => {});
      await stopServer(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  // The SP3 "done when" quit item, end to end through the real server (ruling
  // R18): a live session, then a quit, once through the desktop shell's stdin
  // line (with AGENT_OS_STDIN_SHUTDOWN=1 and a piped stdin, the way Task D1
  // starts the server) and once through SIGTERM. When SIGTERM reaches the
  // agent, the fake copies its session's meta.json into its log, which proves
  // "ended (Agent OS quit)" was written before any signal. `claude agents
  // --json` (the soft stop) never answers in mode agents-hang, and the server
  // must still be gone within its 8 s hard exit.
  for (const [how, extra, stdin, quit] of [
    [
      "the desktop's stdin line",
      { AGENT_OS_STDIN_SHUTDOWN: "1" },
      "pipe",
      (child) => child.stdin.write("AGENT_OS_SHUTDOWN\n")
    ],
    ["SIGTERM", {}, "ignore", (child) => child.kill("SIGTERM")]
  ]) {
    test(`quit with a live session (${how}): meta.json says quit before the agent gets a signal, and the server exits within 8 s`, async () => {
      const home = await makeHome("agent-os-sessions-quit-");
      const agentOsHome = path.join(home, ".hermes-agent-os");
      const fakeLog = path.join(home, "fake.log");
      const server = await startServer(
        home,
        {
          ...extra,
          FAKE_AGENT_MODE: "agents-hang",
          FAKE_AGENT_LOG: fakeLog,
          // The fake fills in its own AGENT_OS_SESSION_ID (the id is only
          // known after the session is created).
          FAKE_AGENT_SNAPSHOT_ON_TERM: path.join(agentOsHome, "sessions", "{AGENT_OS_SESSION_ID}", "meta.json")
        },
        { stdin }
      );
      const running = new Set();
      try {
        assert.equal((await api(server.port, "POST", "/api/admin/execution-gate", { enabled: true, confirm: true })).status, 200);
        const created = await api(server.port, "POST", "/api/sessions", {
          agentId: "claude",
          folder: path.join(home, "project")
        });
        assert.equal(created.status, 201, created.text);
        const id = created.json.id;
        await waitFor(
          async () => (await api(server.port, "GET", `/api/sessions/${id}`)).json?.status === "live",
          15000,
          "the session to go live"
        );
        const started = await waitFor(
          async () => (await readFakeLog(fakeLog)).find((entry) => entry.event === "start"),
          5000,
          "the fake's start entry"
        );
        const agentPid = started.pid;
        assert.equal(
          learnPid(running, server, agentPid),
          true,
          "the agent's pid is learned while the server that started it is running"
        );
        assert.ok(isAlive(agentPid), "the agent runs before the quit");

        const quitAt = Date.now();
        const exited = exitWithin(server.child, 8000);
        // The soft stop's `claude agents --json` starts while the server is
        // still shutting down (it waits up to 2 s for it), so its pid is
        // learned now, while the server that started it is still running.
        const askedWatch = learnLoggedPid(running, server, fakeLog, "agents");
        quit(server.child);
        const exit = await exited;
        assert.ok(exit, `the server did not exit within 8 s:\n${server.logs.text.slice(-2000)}`);
        assert.equal(exit.code, 0, server.logs.text.slice(-2000));
        assert.ok(Date.now() - quitAt < 8000, `the quit took ${Date.now() - quitAt} ms`);

        const entries = await readFakeLog(fakeLog);
        const term = entries.find((entry) => entry.event === "sigterm" && entry.pid === agentPid);
        assert.ok(term, `the agent got SIGTERM; the fake's log: ${JSON.stringify(entries)}`);
        assert.equal(term.snapshotError, undefined, "meta.json was readable when SIGTERM arrived");
        const snapshot = JSON.parse(term.snapshot);
        assert.equal(snapshot.id, id);
        assert.equal(snapshot.status, "exited", "meta.json said ended before the agent got any signal");
        assert.equal(snapshot.endedBy, "quit");

        const onDisk = JSON.parse(await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8"));
        assert.equal(onDisk.status, "exited");
        assert.equal(onDisk.endedBy, "quit");

        await gone(running, agentPid, 3000, "the agent's process to be gone");
        // The soft stop's `claude agents --json` never answered; its 2 s limit
        // ended it. Its pid was learned during the shutdown (askedWatch), never
        // from the log afterwards: with the server gone, that number could
        // belong to any process, and clean-up must never signal it.
        const asked = await askedWatch;
        assert.ok(asked.entry, "the soft stop asked claude agents --json");
        assert.equal(asked.learned, true, "its pid was learned while the server that started it was still running");
        await gone(running, asked.entry.pid, 3000, "the hung claude agents call to be gone");
      } finally {
        killLeftovers(running);
        await stopServer(server);
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
