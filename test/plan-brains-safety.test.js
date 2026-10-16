// Plan brains, Safety 1, 3 and 4 across every flow of the feature (spec
// docs/superpowers/specs/2026-10-15-plan-brains-design.md, "Safety"):
//   1. Agent OS opens no agent file (the file-access spy; the one exception is
//      brain.js's existence check of ~/.openclaw/openclaw.json);
//   3. only the fixed commands run: no setup-token, paste-token, --token,
//      --method oauth, --device-code, permission bypass or --probe in any
//      fake's argv log (W1's fake logs its programs as "start" records and,
//      under the name openclaw, its quick answers as "probe" records, so the
//      commands detection runs count too), --accept-risk only on a ticked
//      onboard, and none of those words in the new server modules;
//   4. HOME reaches every fake unchanged and none of the H1 variables does
//      (every "start" and "probe" record).
// Task B1a adds the ChatGPT sign-in session (its start and its stop); Tasks
// B1b and B1c add their flows here and their modules to NEW_SERVER_MODULES.
// Temp HOME and AGENT_OS_HOME (real paths), W1's fakes and stand-in login
// shell; never a real agent.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { OPENCLAW_SIGNIN_ACTION, SETUP_ACTIONS } from "../server/runtime/sessions/profiles.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { setFakeKnob } from "./helpers/fake-knobs.js";
import {
  FORBIDDEN_ARGV,
  FORBIDDEN_PATH,
  H1_ENV_NAMES,
  agentFileAccess,
  allowedAgentFile,
  argvProblems,
  sourceProblems,
  spyOnFileAccess,
  withoutH1Env
} from "./helpers/plan-brains-safety.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const POSIX_ONLY = { skip: isWindows ? "the fake agents and the stand-in login shell are POSIX shell scripts" : false };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SIGNIN_ARGS = ["models", "auth", "login", "--provider", "openai", "--method", "siwc"];
const SIGNIN_PATH = "/api/setup/openclaw/signin-terminal";
// The server modules this feature adds. Tasks B1b and B1c add theirs here.
const NEW_SERVER_MODULES = ["server/runtime/setup/openclaw-version.js"];

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
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

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

// The setup router without index.js's requireAdminWhenPublic (its new routes
// carry requireLocalMode themselves), and the sessions router behind
// requireLocalMode, as server/index.js mounts it. This file runs only in local
// mode, where requireAdminWhenPublic lets every request through;
// test/setup-session-kind.test.js mounts it and checks the other modes.
async function withApp(manager, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/setup", createSetupRouter({ sessionManager: manager }));
  app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: "unexpected", message: String(error?.message || error) }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  try {
    return await fn({ call });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

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

test("the Safety helpers: argvProblems and sourceProblems name every forbidden word, allow the sign-in and keep --accept-risk to a ticked onboard; withoutH1Env clears every H1 variable", () => {
  assert.deepEqual(
    [...FORBIDDEN_ARGV],
    ["setup-token", "paste-token", "--token", "--method oauth", "--device-code", "--dangerously-skip-permissions", "--yolo", "--probe"]
  );
  assert.deepEqual(
    argvProblems([SIGNIN_ARGS, ["models", "set", "openai/gpt-6-sol"], ["config", "set", "tools.exec.mode", "ask"], ["models", "status", "--check", "--plain"]]),
    []
  );
  const forbidden = [
    ["models", "auth", "setup-token", "--provider", "anthropic"],
    ["models", "auth", "paste-token", "--provider", "anthropic"],
    ["models", "auth", "login", "--token", "abc"],
    ["models", "auth", "login", "--token=abc"],
    ["models", "auth", "login", "--provider", "openai", "--method", "oauth"],
    ["models", "auth", "login", "--provider", "openai", "--method=oauth"],
    ["models", "auth", "login", "--provider", "openai", "--device-code"],
    ["--dangerously-skip-permissions"],
    ["chat", "--yolo"],
    ["models", "status", "--check", "--plain", "--probe"]
  ];
  for (const argv of forbidden) assert.equal(argvProblems([argv]).length, 1, argv.join(" "));
  const onboard = ["onboard", "--non-interactive", "--accept-risk", "--auth-choice", "anthropic-cli"];
  assert.deepEqual(argvProblems([onboard], { riskTicked: true }), [], "on onboard, with the tick");
  assert.deepEqual(argvProblems([onboard]), [`--accept-risk without the risk tick in: ${onboard.join(" ")}`]);
  assert.deepEqual(argvProblems([["models", "set", "openai/x", "--accept-risk"]], { riskTicked: true }), [
    "--accept-risk outside onboard in: models set openai/x --accept-risk"
  ]);
  assert.deepEqual(argvProblems(["models auth login"]), ['not an argv list: "models auth login"'], "a line that is not a list is a problem, never passed silently");

  assert.deepEqual(sourceProblems('const args = ["models", "auth", "login", "--provider", "openai", "--method", "siwc"];'), []);
  assert.deepEqual(sourceProblems("// never setup-token or --yolo\n/* nor --device-code */\nconst ok = 1;"), [], "comments are not code");
  for (const [code, word] of [
    ['run(["models", "auth", "setup-token"]);', "setup-token"],
    ["run(['models', 'auth', 'paste-token']);", "paste-token"],
    ['run(["login", "--token", key]);', "--token"],
    ['run(["login", "--method", "oauth"]);', "--method oauth"],
    ["run(['login', '--method=oauth']);", "--method oauth"],
    ['run(["login", "--device-code"]);', "--device-code"],
    ['run(["--dangerously-skip-permissions"]);', "--dangerously-skip-permissions"],
    ['run(["chat", "--yolo"]);', "--yolo"],
    ['run(["models", "status", "--probe"]);', "--probe"]
  ]) {
    assert.deepEqual(sourceProblems(code), [word], code);
  }

  assert.deepEqual(
    [...H1_ENV_NAMES],
    ["XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_PROFILE", "OPENCLAW_CONFIG_PATH", "OPENCLAW_HOME", "OPENCLAW_AGENT_DIR"]
  );
  const vars = withoutH1Env({ HOME: "/tmp/someone" });
  assert.equal(vars.HOME, "/tmp/someone", "HOME is kept: a test checks it reaches the fakes unchanged");
  for (const name of H1_ENV_NAMES) {
    assert.ok(Object.hasOwn(vars, name), name);
    assert.equal(vars[name], undefined, name);
  }
  assert.equal(allowedAgentFile("/tmp/someone"), path.join("/tmp/someone", ".openclaw", "openclaw.json"));
  assert.ok(FORBIDDEN_PATH.test(allowedAgentFile("/tmp/someone")), "the spy flags it too, so tests leave out exactly this one path");

  // Agent OS's own files are never agent files, even when this checkout sits under a .claude folder (a Claude Code
  // worktree does); an agent file, a checkout .env and the allowed path are judged as they are.
  const own = [path.join(root, "node_modules", "iconv-lite", "index.js"), `file://${path.join(root, "node_modules", "node-pty", "lib", "index.js")}`];
  assert.deepEqual(agentFileAccess(own), []);
  const allowed = allowedAgentFile("/tmp/someone");
  const agentFiles = [path.join(root, ".env"), "/tmp/someone/.claude/settings.json", "/tmp/someone/.codex/auth.json"];
  assert.deepEqual(agentFileAccess([...own, ...agentFiles, allowed], { allowed: [allowed] }), agentFiles);
  assert.deepEqual(agentFileAccess([allowed]), [allowed], "without the allowance it is flagged");
});

test("Safety 3: the setup action table holds only the ChatGPT sign-in, and the new server modules hold none of the forbidden words", async () => {
  assert.deepEqual(Object.keys(SETUP_ACTIONS), [OPENCLAW_SIGNIN_ACTION]);
  assert.deepEqual([...SETUP_ACTIONS[OPENCLAW_SIGNIN_ACTION].args], SIGNIN_ARGS);
  assert.deepEqual(argvProblems(Object.values(SETUP_ACTIONS).map((action) => [...action.args])), []);
  for (const file of NEW_SERVER_MODULES) {
    assert.deepEqual(sourceProblems(await readFile(path.join(root, file), "utf8")), [], file);
  }
});

test("Safety 1, 3 and 4: OpenClaw's ChatGPT sign-in, started and stopped through Agent OS, opens no agent file, runs only fixed commands (the sign-in and detection's three) and sets none of the H1 variables for any of them", POSIX_ONLY, async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-plan-safety-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-plan-safety-data-")));
  const bin = path.join(home, "fake-bin");
  const log = path.join(home, "fake-agent.log");
  try {
    await makeFakeAgentBin(bin);
    await setFakeKnob(home, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.7");
    await withEnv(
      withoutH1Env({
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        HERMES_AGENT_OS_HOME: undefined,
        AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
        SHELL: FAKE_LOGIN_SHELL,
        PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
        ZDOTDIR: undefined,
        ENV: undefined,
        BASH_ENV: undefined,
        AGENT_OS_LAUNCH_PATH: undefined,
        npm_lifecycle_event: undefined,
        HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
        DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_PUBLIC_MODE: undefined,
        HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
        FAKE_AGENT_LOG: log,
        FAKE_AGENT_MODE: undefined,
        FAKE_AGENT_VERSION: undefined
      }),
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        clearDetectCaches();
        resetLoginShellEnvForTests();
        const running = new Set();
        const manager = createSessionManager({ spawn: async (options) => track(running, await spawnPty(options)) });
        const seen = [];
        try {
          await withApp(manager, async ({ call }) => {
            let id = null;
            const restore = spyOnFileAccess(seen);
            try {
              const started = await call("POST", SIGNIN_PATH, { confirm: true });
              assert.equal(started.status, 201, JSON.stringify(started.body));
              id = started.body.session.id;
              await waitFor(async () => (await readFakeLog(log)).some((entry) => entry.event === "start" && entry.name === "openclaw"));
              assert.equal((await call("GET", SIGNIN_PATH)).body.session?.id, id);
              // Close in the card: the sessions Stop, with no window attached.
              const stopped = await call("POST", `/api/sessions/${id}/stop`, {});
              assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
              assert.equal(stopped.body.status, "exited");
              assert.equal(stopped.body.endedBy, "stop");
              assert.equal(stopped.body.note, null);
            } finally {
              restore();
            }
            await waitFor(() => !manager.isLive(id));
          });
        } finally {
          await manager.shutdownAll({ reason: "quit" });
          killLeftovers(running);
          resetLoginShellEnvForTests();
          clearDetectCaches();
        }

        // Safety 1: the spy saw real file access (a control), and no agent file but the one allowed.
        assert.ok(seen.some((file) => file.startsWith(bin)), "the spy saw OpenClaw being looked up in the fake bin");
        assert.deepEqual(agentFileAccess(seen, { allowed: [allowedAgentFile(home)] }), []);

        // Safety 3: the one program that started ran exactly the sign-in argv, and the only quick commands
        // were the fresh detection's three (W1's fake logs each quick answer of `openclaw` as a "probe").
        // The detection caches were cleared above, so the feature cache missed and both --help commands ran.
        const entries = await readFakeLog(log);
        const starts = entries.filter((entry) => entry.event === "start");
        const probes = entries.filter((entry) => entry.event === "probe");
        assert.deepEqual(starts.map((entry) => [entry.name, entry.argv]), [["openclaw", SIGNIN_ARGS]]);
        assert.deepEqual(
          probes.map((entry) => [entry.name, ...entry.argv].join(" ")).sort(),
          ["openclaw --version", "openclaw agent --help", "openclaw agent exec --help"],
          "detection's fixed commands (server/runtime/agents/openclaw.js), each once"
        );
        assert.deepEqual(argvProblems([...starts, ...probes].map((entry) => entry.argv)), []);
        assert.ok(
          entries.some((entry) => entry.event === "sigterm" && entry.pid === starts[0].pid),
          "Stop ended it with SIGTERM, with no OpenClaw command of its own"
        );
        assert.deepEqual(entries.filter((entry) => entry.event === "gateway"), [], "no Gateway or service command");

        // Safety 4: HOME as it is, and none of the H1 variables, for the sign-in and every detection command.
        for (const record of [...starts, ...probes]) {
          const what = `${record.event}: ${record.argv.join(" ")}`;
          assert.equal(record.env.HOME, home, what);
          assert.equal(record.env.USERPROFILE, home, what);
          for (const name of H1_ENV_NAMES) assert.equal(record.env[name], undefined, `${name} never reaches ${what}`);
          assert.deepEqual(record.openclawKeys, [], `no OPENCLAW_* variable reaches ${what}`);
        }
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(agentOsHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ===========================================================================
// Task B1b: plan status, both model lists and both Applies (Safety 1, 3 and 4).
// An ES module may import anywhere at its top level; every name this block
// brings in or declares starts with "plan", so it never meets a name of the
// part above (B1b's Step 0 checks that). node:test comes in as a namespace, so
// the file keeps exactly one line that imports test by name from node:test
// (Task B1c's Step 0 counts such lines). The one name of the part above used
// here is NEW_SERVER_MODULES: B1b's modules join B1a's source scan (its Safety
// 3 test).
// ===========================================================================
import planAssert from "node:assert/strict";
import planPath from "node:path";
import * as planNodeTest from "node:test";
import * as planSafety from "./helpers/plan-brains-safety.js";
import {
  agentEnvLog as planAgentEnvLog,
  openclawRecord as planOpenclawRecord,
  siwcRow as planSiwcRow,
  waitForPlanJob as planWaitForJob,
  withPlanEnv as planWithEnv
} from "./helpers/openclaw-plan-env.js";

const planTest = planNodeTest.test;
const planPosixSkip = { skip: process.platform === "win32" ? "the fake agents are POSIX shell shims" : false };
const planModules = ["server/runtime/setup/openclaw-plan-rules.js", "server/runtime/setup/openclaw-plans.js"];

// B1a's Safety 3 test runs the source scan over every module in this list.
NEW_SERVER_MODULES.push(...planModules);

// One run of every B1b flow, shared by the three checks below: plan status,
// both model lists, a Claude plan Apply without the risk tick (refused) and one
// with it, the model answer, a ChatGPT plan Apply stopped at readiness (the
// earlier model put back) and one that succeeds, and plan status again (its
// readiness read). The file-access spy is on for all of it.
let planFlowsRun = null;
function planFlows() {
  planFlowsRun ??= planRunFlows();
  return planFlowsRun;
}

async function planRunFlows() {
  let result = null;
  await planWithEnv(
    async ({ call, home, knob }) => {
      const seen = [];
      const restore = planSafety.spyOnFileAccess(seen);
      try {
        planAssert.equal((await call("GET", "/api/setup/openclaw/plans")).status, 200);
        planAssert.equal((await call("GET", "/api/setup/openclaw/plan-models?plan=claude")).status, 200);
        planAssert.equal((await call("GET", "/api/setup/openclaw/plan-models?plan=chatgpt")).status, 200);
        const planApply = (plan, model, acceptOpenClawRisk) =>
          call("POST", "/api/setup/openclaw/plan", { plan, model, confirm: true, acceptOpenClawRisk });
        planAssert.equal((await planApply("claude", "claude-opus-5-5", false)).status, 400, "no risk tick: refused, nothing runs");
        const claude = await planApply("claude", "claude-opus-5-5", true);
        planAssert.equal((await planWaitForJob(claude.body.id)).status, "succeeded");
        planAssert.equal((await call("GET", "/api/setup/agents/openclaw/model")).body.plan, "claude");
        await knob("FAKE_OPENCLAW_STATUS_EXIT", "1");
        const stopped = await planApply("chatgpt", "gpt-6.1-sol", true);
        planAssert.equal((await planWaitForJob(stopped.body.id)).status, "failed");
        await knob("FAKE_OPENCLAW_STATUS_EXIT", "0");
        const chatgpt = await planApply("chatgpt", "gpt-6.1-sol", true);
        planAssert.equal((await planWaitForJob(chatgpt.body.id)).status, "succeeded");
        planAssert.equal((await call("GET", "/api/setup/openclaw/plans")).body.chatgpt.readiness, "ready");
      } finally {
        restore();
      }
      result = { home, seen, openclaw: await planOpenclawRecord(home), agents: await planAgentEnvLog(home) };
    },
    { state: { primary: "openrouter/vendor/old", authRows: [planSiwcRow()] } }
  );
  return result;
}

planTest("B1b, Safety 1: plan status, both model lists and both Applies never open an agent's files", planPosixSkip, async () => {
  const { home, seen } = await planFlows();
  planAssert.ok(seen.some((file) => file.includes(planPath.join(home, ".npm-global", "bin"))), "the spy saw OpenClaw being looked up");
  planAssert.ok(seen.length > 20, `expected many recorded calls, got ${seen.length}`);
  const allowed = planSafety.allowedAgentFile(home);
  planAssert.deepEqual(planSafety.agentFileAccess(seen, { allowed: [allowed] }), []);
});

planTest("B1b, Safety 3: every command of these flows is allowed, --accept-risk only on onboard with the tick, and B1a's source scan covers the new modules", planPosixSkip, async () => {
  const { openclaw, agents } = await planFlows();
  const argvLists = [...openclaw.map((line) => line.argv), ...agents.map((line) => line.args)];
  planAssert.deepEqual(planSafety.argvProblems(argvLists, { riskTicked: true }), []);
  const withRisk = openclaw.filter((line) => line.argv.includes("--accept-risk"));
  planAssert.deepEqual(withRisk.map((line) => line.argv[0]), ["onboard"], "one onboard, from the one ticked Claude plan Apply");
  planAssert.ok(
    openclaw.filter((line) => line.argv[0] === "models" && line.argv[1] === "status").every((line) => line.argv.join(" ") === "models status --check --plain"),
    "models status only ever as --check --plain"
  );
  // The scan itself is B1a's Safety 3 test; this only proves the push above reached it.
  for (const file of planModules) planAssert.ok(NEW_SERVER_MODULES.includes(file), `${file} is in B1a's source scan`);
});

planTest("B1b, Safety 4: no command of these flows gets another HOME or any agent config variable", planPosixSkip, async () => {
  const { home, openclaw, agents } = await planFlows();
  planAssert.ok(openclaw.length > 10 && agents.length > 0, "both fakes logged their environment");
  for (const line of [...openclaw, ...agents]) {
    const what = JSON.stringify(line.argv ?? line.args);
    planAssert.equal(line.home, home, what);
    planAssert.deepEqual(line.setVars, [], what);
  }
});

// ---------------------------------------------------------------------------
// Task B1c: "Choose in Hermes" opens Hermes's own model picker (`hermes model`)
// in its own Terminal.app window (spec §4). Its share of the Safety items:
//   1. the file-access spy over the launch sees no agent file at all, not even
//      OpenClaw's openclaw.json (the one touch allowed elsewhere);
//   3. the launch's argv (the one `open` call and the words in its .command
//      file) holds no forbidden flag, nothing ran `hermes model` inside Agent
//      OS, and the source scan finds nothing in hermes-model-terminal.js (a
//      new module: the push below puts it on NEW_SERVER_MODULES, so B1a's
//      Safety 3 test scans it) or in signin.js, where its Terminal helper
//      lives (an existing module, so not on that list; the test scans it);
//   4. the launch passes no environment of its own and changes none. For the
//      Hermes launch, the only program Agent OS starts is `open`; its
//      environment is the spawn options (no env, so the inherited one, with
//      HOME the temp home and no H1 name set), and the detection fakes answer
//      --version and --help without an env log. The spawn function below logs
//      that inherited environment at the moment of the spawn.
// Safety 2's Hermes part (the exact `open` argv, the file's content, no
// session) is in test/hermes-model-terminal.test.js. Two names come from the
// part above: `test`, and NEW_SERVER_MODULES (B1a's list of the feature's new
// server modules). This block declares no name of its own at the top level;
// everything else is imported inside the test, so no name here can clash with
// the imports above.
// ---------------------------------------------------------------------------

// B1a's Safety 3 test runs the source scan over every module in this list.
NEW_SERVER_MODULES.push("server/runtime/setup/hermes-model-terminal.js");

test(
  "Safety 1, 3 and 4 (B1c): Choose in Hermes opens the picker without an agent file, a forbidden flag or an environment of its own",
  { skip: process.platform === "win32" ? "POSIX only: the fake agents are sh scripts" : false },
  async () => {
    const { default: assert } = await import("node:assert/strict");
    const { EventEmitter } = await import("node:events");
    const { mkdir, mkdtemp, readFile, realpath, rm } = await import("node:fs/promises");
    const { default: os } = await import("node:os");
    const { default: path } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { clearDetectCaches } = await import("../server/runtime/agents/detect.js");
    const { HERMES_MODEL_ARGS, openHermesModelTerminal } = await import("../server/runtime/setup/hermes-model-terminal.js");
    const { FAKE_LOGIN_SHELL, makeFakeAgentBin } = await import("./helpers/fake-agents.js");
    const { H1_ENV_NAMES, agentFileAccess, argvProblems, sourceProblems, spyOnFileAccess } = await import(
      "./helpers/plan-brains-safety.js"
    );

    const setupDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "runtime", "setup");
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-b1c-safety-")));
    const home = path.join(base, "home");
    const agentOsHome = path.join(base, "agent-os");
    const fakeBin = path.join(base, "fake-bin");
    const agentLog = path.join(base, "fake-agents.jsonl");
    const vars = {
      HOME: home,
      USERPROFILE: home,
      AGENT_OS_HOME: agentOsHome,
      HERMES_AGENT_OS_HOME: undefined,
      HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
      PATH: [fakeBin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
      SHELL: FAKE_LOGIN_SHELL,
      FAKE_AGENT_LOG: agentLog
    };
    // Safety 4 checks start without the H1 variables (HOME is the temp one).
    for (const name of H1_ENV_NAMES) if (name !== "HOME" && name !== "USERPROFILE") vars[name] = undefined;
    const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    const setEnv = (values) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    setEnv(vars);
    try {
      await mkdir(home, { recursive: true });
      await mkdir(agentOsHome, { recursive: true });
      await makeFakeAgentBin(fakeBin);
      clearDetectCaches();
      const hermes = path.join(fakeBin, "hermes");
      const h1Before = Object.fromEntries(H1_ENV_NAMES.map((name) => [name, process.env[name]]));
      const calls = [];
      const spawnFn = (command, args, options) => {
        // Safety 4's environment log: what `open` would inherit, read at the moment of the spawn.
        const inherited = {
          HOME: process.env.HOME,
          h1Set: H1_ENV_NAMES.filter((name) => process.env[name] !== undefined)
        };
        calls.push({ command, args, options, inherited });
        const child = new EventEmitter();
        child.unref = () => {};
        setImmediate(() => child.emit("spawn"));
        return child;
      };

      // Safety 1: the spy runs over the whole launch, Hermes's detection included.
      const seen = [];
      const restore = spyOnFileAccess(seen);
      let result;
      try {
        result = await openHermesModelTerminal({ platform: "darwin", spawnFn });
      } finally {
        restore();
      }
      assert.deepEqual(result, { opened: true, command: `${hermes} model` });
      assert.ok(seen.includes(hermes), "the spy saw Hermes being looked up (a control)");
      assert.ok(
        seen.some((p) => p.startsWith(path.join(agentOsHome, "setup", "terminal"))),
        "the spy saw the .command file being written (a control)"
      );
      // agentFileAccess, not FORBIDDEN_PATH on its own: this checkout can sit under a `.claude` folder.
      assert.deepEqual(agentFileAccess(seen, { allowed: [] }), [], "no agent file, not even ~/.openclaw/openclaw.json");

      // Safety 3: the launch's argv and the words in its file; nothing started `hermes model`; the code.
      assert.equal(calls.length, 1);
      const fileText = await readFile(calls[0].args[2], "utf8");
      assert.equal(fileText, `${hermes} model\n`);
      const fileWords = fileText.trim().split(" ");
      assert.deepEqual(fileWords, [hermes, ...HERMES_MODEL_ARGS]);
      assert.deepEqual(argvProblems([[calls[0].command, ...calls[0].args], fileWords]), []);
      const logText = await readFile(agentLog, "utf8").catch(() => "");
      const started = logText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === "start");
      assert.deepEqual(started, [], "nothing ran `hermes model` inside Agent OS");
      // The new module's scan is B1a's Safety 3 test; this only proves the push above reached its list.
      assert.ok(
        NEW_SERVER_MODULES.includes("server/runtime/setup/hermes-model-terminal.js"),
        "hermes-model-terminal.js is in B1a's source scan"
      );
      // signin.js is an existing module, so it is not on that list; its Terminal helper is scanned here.
      assert.deepEqual(sourceProblems(await readFile(path.join(setupDir, "signin.js"), "utf8")), [], "signin.js");

      // Safety 4: `open` gets no env and no folder of its own (Terminal.app's own
      // shell decides), so it inherits this process's environment: HOME the temp
      // home and no H1 name set. And the launch changed none of them.
      assert.deepEqual(calls[0].options, { stdio: "ignore", detached: true, shell: false });
      assert.deepEqual(calls[0].inherited, { HOME: home, h1Set: [] }, "HOME unchanged and no H1 name set");
      assert.deepEqual(Object.fromEntries(H1_ENV_NAMES.map((name) => [name, process.env[name]])), h1Before);
      assert.equal(process.env.HOME, home);
    } finally {
      setEnv(previous);
      clearDetectCaches();
      await rm(base, { recursive: true, force: true });
    }
  }
);
