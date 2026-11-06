// SP5 Task V3: the one update service (server/runtime/updates/update-service.js,
// routes.js), its place in Setup (setup/plan.js, jobs.js, routes.js) and the
// Hermes update session. Fake agent CLIs on a temp PATH stand in for the
// agents (a small shim per agent that records `update` calls and can "install"
// a new version; the TUI fake of test/fakes/tui-agent.mjs for the sessions),
// and a local http server stands in for the npm registry and the Setup hosts,
// so no real agent and no real network is ever touched. The shims are POSIX
// shell scripts, so the tests that start them skip on Windows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { getAdapter } from "../server/runtime/agents/index.js";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { spawnPty } from "../server/runtime/sessions/pty-host.js";
import { resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { getSetupJob, resetSetupJobsForTest } from "../server/runtime/setup/jobs.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";
import { clearSystemCheckCache } from "../server/runtime/setup/system-check.js";
import { isAgentUpdating } from "../server/runtime/updates/activity.js";
import { createUpdateChecks, getUpdateChecks, hermesCleanForUpdate, resetUpdateChecksForTest } from "../server/runtime/updates/checks.js";
import { createUpdatesRouter } from "../server/runtime/updates/routes.js";
import { HERMES_UP_TO_DATE_MESSAGE, startAgentUpdate, updateAgentsOf, withUpdateGuard } from "../server/runtime/updates/update-service.js";
import { FAKE_AGENT_SCRIPT, FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { setFakeKnob } from "./helpers/fake-knobs.js";
import { NO_GIT_OPTIONS } from "./helpers/no-git.js";
import { withoutH1Env } from "./helpers/plan-brains-safety.js";

const POSIX_ONLY = {
  skip: process.platform === "win32" ? "the fake agents are #!/bin/sh shims (POSIX-only), like every fake CLI in this suite" : false
};
// Fakes first, then only the operating system's own folders: the developer's normal PATH holds the REAL agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const CLAUDE_TAGS = "/-/package/@anthropic-ai/claude-code/dist-tags";
const CODEX_TAGS = "/-/package/@openai/codex/dist-tags";
const tags = (latest) => ({ json: { latest, next: `${latest}-next` } });

const UPDATE_RUNNING_CLAUDE = "Claude Code is already updating.";
const UPDATE_RUNNING_HERMES = "Hermes is already updating.";
const HERMES_NOT_CLEAN = "Hermes's folder changed since the last check, so Agent OS didn't update it.";

// What each shim agent's --version prints before and after its update "installs" the next version.
const VERSION = { claude: "2.1.309 (Claude Code)", codex: "codex-cli 0.154.0", openclaw: "OpenClaw 2026.10.4 (abcdef0)" };
const NEXT_VERSION = { claude: "2.2.0 (Claude Code)", codex: "codex-cli 0.160.0", openclaw: "OpenClaw 2026.10.9 (abcdef1)" };
const DRY_RUN = JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.4", restart: false, downgradeRisk: false });

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

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

async function waitForJob(jobId) {
  return waitFor(async () => {
    const job = await getSetupJob(jobId);
    return job && job.status !== "running" ? job : null;
  });
}

// A stand-in for the npm registry and for the Setup hosts, on 127.0.0.1. A path with no route answers 404.
async function startRegistry(routes) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(route.json));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

const shQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// A fake installed agent that can be updated:
//   --version      prints $HOME/.fake-version-<name>
//   update ...     records "<name> <its argv>" in $HOME/.fake-calls.log; with --dry-run it prints
//                  $HOME/.fake-dry-run-<name> (OpenClaw's check) and stops. Otherwise it records its PATH, waits
//                  while $HOME/.fake-hold-<name> exists, "installs" $HOME/.fake-next-<name> (the version file
//                  becomes its text) when that exists, and exits 1 when $HOME/.fake-fail-<name> exists
//   anything else  is the terminal program of test/fakes/tui-agent.mjs (so a session can run it)
function updatableShim(name) {
  return [
    "#!/bin/sh",
    `name=${name}`,
    'case "$1" in',
    '  --version) cat "$HOME/.fake-version-$name"; exit 0 ;;',
    "  update)",
    '    printf "%s %s\\n" "$name" "$*" >> "$HOME/.fake-calls.log"',
    '    case "$*" in *--dry-run*) cat "$HOME/.fake-dry-run-$name" 2>/dev/null; exit 0 ;; esac',
    '    printf "%s\\n" "$PATH" > "$HOME/.fake-update-path-$name"',
    '    while [ -f "$HOME/.fake-hold-$name" ]; do sleep 0.05; done',
    '    [ -f "$HOME/.fake-next-$name" ] && cp "$HOME/.fake-next-$name" "$HOME/.fake-version-$name"',
    '    if [ -f "$HOME/.fake-fail-$name" ]; then echo "$name update failed: simulated"; exit 1; fi',
    '    echo "$name updated"; exit 0 ;;',
    "esac",
    `FAKE_AGENT_NAME=${name}`,
    "FAKE_AGENT_MODE=tui",
    "export FAKE_AGENT_NAME FAKE_AGENT_MODE",
    `exec ${shQuote(process.execPath)} ${shQuote(FAKE_AGENT_SCRIPT)} "$@"`,
    ""
  ].join("\n");
}

async function writeShim(file, name) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, updatableShim(name));
  await chmod(file, 0o755);
}

// The world a test runs in: a temp HOME (canonical path), a temp AGENT_OS_HOME and managed-node root, fake agents
// (claude and openclaw on PATH, codex on PATH or under the managed Node folder, the TUI fake as hermes), a local
// registry for the version checks and the Setup probes, and an environment with none of the H1 variables.
//   w.calls()              the lines the shims recorded ("claude update")
//   w.hold(name) / w.release(name)   keep an update running / let it go
//   w.install(name)        the next update "installs" the next version
//   w.fail(name)           the next update exits 1
//   w.manager()            a real session manager (real profiles and PTYs; spawns are recorded in w.spawned)
async function withWorld({ codexAt = "path", checks = true } = {}, fn) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-updates-service-")));
  const home = path.join(dir, "home");
  const agentOsHome = path.join(dir, "agent-os");
  const managedRoot = path.join(home, ".agent-os");
  const bin = path.join(home, "fake-bin");
  const project = path.join(home, "projects", "demo");
  const checkout = path.join(home, ".hermes", "hermes-agent");
  for (const folder of [agentOsHome, bin, project, checkout]) await mkdir(folder, { recursive: true });
  const registry = await startRegistry({ [CLAUDE_TAGS]: tags("2.2.0"), [CODEX_TAGS]: tags("0.160.0") });
  const managedBin = path.join(managedRoot, "node", "bin");

  await makeFakeAgentBin(bin, { names: ["hermes"], mode: "updater" });
  await writeShim(path.join(bin, "claude"), "claude");
  await writeShim(path.join(bin, "openclaw"), "openclaw");
  await writeShim(codexAt === "managed" ? path.join(managedBin, "codex") : path.join(bin, "codex"), "codex");
  for (const name of Object.keys(VERSION)) await writeFile(path.join(home, `.fake-version-${name}`), VERSION[name]);
  await writeFile(path.join(home, ".fake-dry-run-openclaw"), DRY_RUN);

  const spawned = []; // { options, pid, exited } for every terminal the managers started
  const managers = [];
  const note = (name, text = "") => writeFile(path.join(home, `.fake-${name}`), text);
  const unnote = (name) => rm(path.join(home, `.fake-${name}`), { force: true });
  const world = {
    dir,
    home,
    agentOsHome,
    managedRoot,
    managedBin,
    bin,
    project,
    checkout,
    spawned,
    calls: async () => {
      try {
        return (await readFile(path.join(home, ".fake-calls.log"), "utf8")).split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    updateCalls: async () => (await world.calls()).filter((line) => !line.includes("--dry-run")),
    updatePath: async (name) => (await readFile(path.join(home, `.fake-update-path-${name}`), "utf8")).trim(),
    hold: (name) => note(`hold-${name}`),
    release: (name) => unnote(`hold-${name}`),
    install: (name) => writeFile(path.join(home, `.fake-next-${name}`), NEXT_VERSION[name]),
    fail: (name) => note(`fail-${name}`),
    // A real git project at `at` (default w.checkout) that the Hermes clean check calls clean: on main, the official URL as its
    // remote, a release tag on HEAD, nothing changed. (The remote is never fetched: nothing here reaches a network.)
    async makeHermesCheckout(at = checkout) {
      const env = {
        PATH: SYSTEM_PATH_DIRS.join(path.delimiter),
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        // No network from this git: only local folders and file:// (the remote recorded below is the official GitHub URL).
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "protocol.allow",
        GIT_CONFIG_VALUE_0: "never",
        GIT_CONFIG_KEY_1: "protocol.file.allow",
        GIT_CONFIG_VALUE_1: "always",
        LANG: "C",
        GIT_AUTHOR_NAME: "Agent OS test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Agent OS test",
        GIT_COMMITTER_EMAIL: "test@example.invalid"
      };
      await mkdir(at, { recursive: true });
      const git = (...args) => execFileSync("git", ["-C", at, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      git("init", "-q", "-b", "main");
      await writeFile(path.join(at, "app.py"), "print('hermes')\n");
      git("add", "app.py");
      git("commit", "-q", "-m", "release");
      git("tag", "-a", "v0.22.5", "-m", "Hermes 0.22.5");
      git("remote", "add", "origin", "https://github.com/NousResearch/hermes-agent");
    },
    manager() {
      const manager = createSessionManager({
        ...NO_GIT_OPTIONS,
        isExecutionAllowed: async () => true,
        resolveBrain: async () => null,
        spawn: async (options) => {
          const handle = await spawnPty(options);
          const record = { options, pid: handle.pid, exited: false };
          handle.onExit(() => {
            record.exited = true;
          });
          spawned.push(record);
          return handle;
        }
      });
      managers.push(manager);
      return manager;
    }
  };

  const vars = withoutH1Env({
    HOME: home,
    USERPROFILE: home,
    AGENT_OS_HOME: agentOsHome,
    AGENT_OS_MANAGED_ROOT: managedRoot,
    AGENT_OS_TEST_NPM_REGISTRY: registry.url,
    AGENT_OS_SETUP_MIRROR: registry.url,
    // The version checks run only where they are switched on; these tests say which, and run them against fakes.
    AGENT_OS_UPDATE_CHECKS: checks ? "1" : "0",
    AGENT_OS_PACKAGED: undefined,
    AGENT_OS_DEV_ORIGIN: undefined,
    SHELL: FAKE_LOGIN_SHELL,
    PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
    HERMES_HOME: undefined,
    HERMES_AGENT_OS_HOME: undefined,
    HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
    ZDOTDIR: undefined,
    ENV: undefined,
    BASH_ENV: undefined,
    AGENT_OS_LAUNCH_PATH: undefined,
    DEMO_PUBLIC: undefined,
    HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
    HERMES_AGENT_OS_PUBLIC_MODE: undefined,
    HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
    FAKE_AGENT_LOG: undefined,
    FAKE_AGENT_MODE: undefined,
    FAKE_AGENT_VERSION: undefined
  });
  try {
    return await withEnv(vars, async () => {
      assert.equal(os.homedir(), home, "tests must never see the real home folder");
      clearDetectCaches();
      clearSystemCheckCache();
      resetSetupJobsForTest();
      resetLoginShellEnvForTests();
      try {
        return await fn(world);
      } finally {
        // Nothing may stay behind: release any held updater, stop the sessions, and end any terminal still running.
        for (const name of Object.keys(VERSION)) await world.release(name);
        for (const manager of managers) await manager.shutdownAll({ reason: "quit" }).catch(() => {});
        for (const record of spawned) {
          if (record.exited) continue;
          try {
            process.kill(record.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        // The end of a Hermes update is noticed by a poll, and its answer is shared across this file: the next test
        // must not start while this one's update still counts as running.
        await waitFor(() => !isAgentUpdating("hermes"));
        resetSetupJobsForTest();
        resetLoginShellEnvForTests();
        clearDetectCaches();
        clearSystemCheckCache();
      }
    });
  } finally {
    await registry.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const pick = ({ installed, latest, state }) => ({ installed, latest, state });
const statusOf = (checks, agentId) => checks.list().find((status) => status.agentId === agentId);

// A window on a session, the way the browser's terminal is one: what is on its screen, and typing into it.
async function openWindow(manager, id) {
  const frames = [];
  const { snapshot } = await manager.attach(id, { id: "w", send: (frame) => frames.push(frame), close() {} });
  assert.equal(manager.focus(id, "w"), true);
  return {
    screen: () => `${snapshot.data}${frames.filter((frame) => frame.t === "out").map((frame) => frame.d).join("")}`,
    type: (text) => manager.write(id, "w", text)
  };
}

// The checks a Hermes test hands the service: statuses that never change, and a clean answer it controls. Hermes's own row
// is "available" unless a test says otherwise (`state.hermesRow`): a Hermes that is up to date is refused an update (R48),
// and these tests are about updating it.
function hermesChecks(w, answer, counts = { checks: [], clean: 0 }, hermesRow = "available") {
  const state = { answer, hermesRow };
  const checks = createUpdateChecks({
    check: async (id) => {
      counts.checks.push(id);
      return { agentId: id, installed: "1.0.0", latest: "1.0.0", state: id === "hermes" ? state.hermesRow : "up-to-date", checkedAt: "2026-10-31T00:00:00.000Z" };
    },
    cleanCheck: async () => {
      counts.clean += 1;
      return state.answer(w);
    }
  });
  return { checks, counts, state };
}

const cleanAnswer = (w) => ({ clean: true, checkout: w.checkout, reasons: [] });

// ---- Step ids ----------------------------------------------------------------------------------------

test("updateAgentsOf(): the agents whose update runs as a job; Hermes never does, and other ids are ignored", () => {
  assert.deepEqual(updateAgentsOf(["claude-update", "hermes-update", "codex-keep", "openclaw-update", "x-update", "claude-update"]), [
    "claude",
    "openclaw"
  ]);
  assert.deepEqual(updateAgentsOf([]), []);
  assert.deepEqual(updateAgentsOf(undefined), []);
});

// ---- Updates that run as Setup jobs ------------------------------------------------------------------

test("an update for claude is one job with exactly the step claude-update; the fake records `claude update`, and afterwards list() shows the new installed version", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const checks = getUpdateChecks();
    await checks.refresh("claude");
    assert.deepEqual(pick(statusOf(checks, "claude")), { installed: "2.1.309", latest: "2.2.0", state: "available" });
    // The version is read once and kept for a while; the update must not leave the old one in that memory.
    assert.match((await getAdapter("claude").detect()).version, /^2\.1\.309\b/);

    await w.install("claude");
    const started = await startAgentUpdate("claude", { manager: w.manager() });
    assert.equal(started.kind, "job");
    assert.match(started.jobId, /^job_/);
    const job = await waitForJob(started.jobId);

    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.steps.map((step) => [step.id, step.agentId, step.action]), [["claude-update", "claude", "update"]]);
    assert.deepEqual(await w.updateCalls(), ["claude update"]);
    // The job has ended, and so has the check it asked for: nothing to wait for.
    assert.deepEqual(pick(statusOf(checks, "claude")), { installed: "2.2.0", latest: "2.2.0", state: "up-to-date" });
    assert.match((await getAdapter("claude").detect()).version, /^2\.2\.0\b/, "the detection memory was cleared");
  });
});

test("openclaw's step runs `update --json`; no call that Agent OS makes carries --yes", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const checks = getUpdateChecks();
    await checks.refresh("openclaw");
    await w.install("openclaw");
    const started = await startAgentUpdate("openclaw", { manager: w.manager() });
    const job = await waitForJob(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.steps.map((step) => step.id), ["openclaw-update"]);
    assert.deepEqual(await w.updateCalls(), ["openclaw update --json"]);
    for (const line of await w.calls()) assert.ok(!line.includes("--yes"), `no updater question is answered for the person: ${line}`);
    assert.equal(statusOf(checks, "openclaw").installed, "2026.10.9", "the new version is read right after the update");
  });
});

test("codex under Agent OS's own Node runs its updater with that Node's bin folder first on PATH; a codex anywhere else gets no such change", POSIX_ONLY, async () => {
  await withWorld({ codexAt: "managed" }, async (w) => {
    assert.equal((await getAdapter("codex").detect()).path, path.join(w.managedBin, "codex"), "codex is found under the managed Node");
    const started = await startAgentUpdate("codex", { manager: w.manager() });
    assert.equal((await waitForJob(started.jobId)).status, "succeeded");
    assert.deepEqual(await w.updateCalls(), ["codex update"]);
    const pathValue = (await w.updatePath("codex")).split(path.delimiter);
    assert.equal(pathValue[0], w.managedBin, "the bundled Node's bin folder is first");
    assert.equal(pathValue.filter((part) => part === w.managedBin).length, 1);
    assert.ok(SYSTEM_PATH_DIRS.every((part) => pathValue.includes(part)), "the rest of PATH is kept");
  });
  await withWorld({ codexAt: "path" }, async (w) => {
    const started = await startAgentUpdate("codex", { manager: w.manager() });
    assert.equal((await waitForJob(started.jobId)).status, "succeeded");
    const pathValue = (await w.updatePath("codex")).split(path.delimiter);
    assert.ok(!pathValue.includes(w.managedBin), "a codex outside the managed Node keeps the usual PATH");
  });
});

test("a failed updater fails the job with its own words, and the version memory is still cleared and checked again", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const checks = getUpdateChecks();
    await checks.refresh("claude");
    const before = statusOf(checks, "claude");
    assert.match((await getAdapter("claude").detect()).version, /^2\.1\.309\b/);
    // The updater installs the new version and then still fails (a half-finished update).
    await w.install("claude");
    await w.fail("claude");
    await new Promise((resolve) => setTimeout(resolve, 5)); // a later clock reading than `before`'s

    const started = await startAgentUpdate("claude", { manager: w.manager() });
    const job = await waitForJob(started.jobId);
    assert.equal(job.status, "failed");
    assert.match(job.steps[0].error, /claude update failed: simulated/);
    const after = statusOf(checks, "claude");
    assert.ok(after.checkedAt > before.checkedAt, "the agent was checked again after the failure");
    assert.equal(after.installed, "2.2.0");
    assert.match((await getAdapter("claude").detect()).version, /^2\.2\.0\b/);
  });
});

test("a second update for the same agent is refused with 409 update_running, from Agents and from Setup, until the first ends", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    await w.hold("claude");
    const first = await startAgentUpdate("claude", { manager });
    await waitFor(async () => (await w.calls()).includes("claude update"));

    const refused = (error) => error.status === 409 && error.code === "update_running" && error.message === UPDATE_RUNNING_CLAUDE;
    await assert.rejects(startAgentUpdate("claude", { manager }), refused);

    // The Setup path takes the same guard.
    const app = express();
    app.use(express.json());
    app.use("/api/setup", createSetupRouter({ sessionManager: manager }));
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/setup/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, steps: ["claude-update"] })
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "update_running", message: UPDATE_RUNNING_CLAUDE });
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }

    // Another agent's update meets the one-job-at-a-time rule that Setup always had.
    await assert.rejects(startAgentUpdate("codex", { manager }), (error) => error.status === 409 && error.code === "job_already_running");

    assert.deepEqual(await w.updateCalls(), ["claude update"], "only the first update ever ran");
    await w.release("claude");
    assert.equal((await waitForJob(first.jobId)).status, "succeeded");

    // Ended: the next update is allowed again.
    const next = await startAgentUpdate("claude", { manager });
    assert.equal((await waitForJob(next.jobId)).status, "succeeded");
    assert.deepEqual(await w.updateCalls(), ["claude update", "claude update"]);
  });
});

test("two updates for one agent that start together: one starts, the other is refused with update_running", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    await w.hold("claude");
    const results = await Promise.allSettled([startAgentUpdate("claude", { manager }), startAgentUpdate("claude", { manager })]);
    const started = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    assert.equal(started.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason.code, "update_running");
    await w.release("claude");
    assert.equal((await waitForJob(started[0].value.jobId)).status, "succeeded");
  });
});

test("an update that finds the agent missing says so, and an update guard is released when its start fails", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    // Cursor has no fake here: it is not installed.
    await assert.rejects(
      startAgentUpdate("cursor", { manager: w.manager() }),
      (error) => error.status === 409 && error.code === "agent_not_installed" && error.message === "Cursor isn't installed on this computer."
    );
    // The refused start left no claim behind: the same agent can be tried again at once.
    await assert.rejects(startAgentUpdate("cursor", { manager: w.manager() }), (error) => error.code === "agent_not_installed");
    await assert.rejects(startAgentUpdate("gemini", { manager: w.manager() }), (error) => error.status === 404 && error.code === "unknown_agent");
  });
});

test("an update while a session of that agent is open leaves the session's process alone and its status unchanged", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const session = await manager.create({ agentId: "claude", folder: w.project });
    const record = w.spawned.at(-1);
    await waitFor(async () => (await manager.get(session.id)).status !== "starting");
    const before = await manager.get(session.id);
    assert.equal(before.kind, "agent");
    assert.equal(before.status, "live");

    await w.install("claude");
    const started = await startAgentUpdate("claude", { manager });
    assert.equal((await waitForJob(started.jobId)).status, "succeeded");

    assert.equal(record.exited, false, "the session's process was not stopped");
    assert.doesNotThrow(() => process.kill(record.pid, 0), "and it is still there");
    const after = await manager.get(session.id);
    assert.equal(after.status, before.status);
    assert.equal(after.stateSince, before.stateSince, "its state did not change");
    assert.deepEqual((await manager.list()).map((item) => item.id), [session.id]);
  });
});

// ---- The Hermes update session -----------------------------------------------------------------------

test("Hermes, clean: an update session runs `hermes update` in the checkout, accepts typed input, and afterwards the agent is checked again", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks, counts } = hermesChecks(w, cleanAnswer);
    const started = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
    assert.equal(started.kind, "session");
    assert.match(started.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(counts.clean, 1, "the clean check ran once, for this click");

    // exactly `hermes update`, in the folder the clean check examined
    assert.equal(w.spawned.length, 1);
    const { options } = w.spawned[0];
    assert.equal(path.basename(options.command), "hermes");
    assert.deepEqual(options.args, ["update"]);
    assert.equal(options.cwd, w.checkout);
    const [summary] = await manager.list({ includeUpdate: true });
    assert.deepEqual([summary.id, summary.kind, summary.agentId, summary.folder], [started.sessionId, "update", "hermes", w.checkout]);
    assert.deepEqual(await manager.list(), [], "an update is not a tab");

    // Hermes's own question reaches the person, and the answer typed into the terminal reaches Hermes.
    const window = await openWindow(manager, started.sessionId);
    await waitFor(() => window.screen().includes("Update now? [y/N]"));
    assert.equal(window.type("y\r"), true);
    await waitFor(() => window.screen().includes("ANSWER y"));
    await waitFor(() => !manager.isLive(started.sessionId));
    assert.equal((await manager.get(started.sessionId)).exitCode, 0);

    // After it ended: the version memory was cleared and Hermes was checked again, with its clean answer.
    await waitFor(() => counts.checks.includes("hermes") && counts.clean === 2);
    assert.deepEqual(counts.checks, ["hermes"], "only Hermes is checked again");
  });
});

// What Setup can show of a Hermes update that ended while the person was on another step (release batch, final round): its summary says
// "exited", but the server keeps no screen for it, so a terminal that is shown again for it has nothing to attach to and nothing to replay.
test("an exited Hermes update session: its summary says so, and a new window cannot attach to it (session_ended), so its output is not shown again", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks } = hermesChecks(w, cleanAnswer);
    const started = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
    const window = await openWindow(manager, started.sessionId);
    await waitFor(() => window.screen().includes("Update now?"));
    assert.ok(window.screen().includes("Update now?"), "while it runs, a window has its screen");
    window.type("n\r");
    await waitFor(() => !manager.isLive(started.sessionId));

    const summary = await manager.get(started.sessionId);
    assert.equal(summary.status, "exited", "the page's own question (GET /api/sessions/:id) can still say it ended");
    await assert.rejects(
      manager.attach(started.sessionId, { id: "later", send() {}, close() {} }),
      (error) => error.code === "session_ended" && error.status === 409,
      "but a window opened later is refused: there is no screen left to replay"
    );
  });
});

test("Hermes, not clean: 409 hermes_not_clean, no session; the clean answer is checked again for the click, whatever the page last showed", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks, counts, state } = hermesChecks(w, cleanAnswer);
    await checks.refreshHermesClean();
    assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] }, "the page last saw a clean copy");
    assert.equal(counts.clean, 1);

    // The folder changed since: the click's own check says so.
    state.answer = () => ({ clean: false, checkout: w.checkout, reasons: ["dirty_tree"] });
    await assert.rejects(
      startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 }),
      (error) => error.status === 409 && error.code === "hermes_not_clean" && error.message === HERMES_NOT_CLEAN
    );
    assert.equal(counts.clean, 2, "the check ran again, inside the click");
    assert.deepEqual(await manager.list({ includeUpdate: true }), [], "no session");
    assert.equal(w.spawned.length, 0, "nothing was started");
    assert.deepEqual(checks.hermesClean(), { clean: false, reasons: ["dirty_tree"] }, "and the page's answer learned it");

    // A check that cannot tell is not clean either.
    state.answer = () => ({ clean: false, checkout: null, reasons: ["no_checkout"] });
    await assert.rejects(startAgentUpdate("hermes", { manager, checks }), (error) => error.code === "hermes_not_clean");
    assert.equal(w.spawned.length, 0);
  });
});

// ---- Hermes that is up to date is not updated (SP5 E2 round 1, R48 on Setup and on a stale page) ----------------------

test("Hermes, up to date: 409 hermes_up_to_date with its sentence, before the clean check and before any terminal", POSIX_ONLY, async () => {
  assert.equal(HERMES_UP_TO_DATE_MESSAGE, "Hermes is up to date.");
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks, counts } = hermesChecks(w, cleanAnswer, undefined, "up-to-date");
    await checks.refresh("hermes");
    assert.equal(checks.list().find((row) => row.agentId === "hermes").state, "up-to-date");
    assert.equal(counts.clean, 1, "the round's own clean check");

    const refused = (error) => error.status === 409 && error.code === "hermes_up_to_date" && error.message === "Hermes is up to date.";
    await assert.rejects(startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 }), refused);
    assert.equal(counts.clean, 1, "the row is looked at first: the clean check did not run for this click");
    assert.equal(w.spawned.length, 0, "no terminal was started");
    assert.deepEqual(await manager.list({ includeUpdate: true }), [], "and no session");
    // The refusal let go of the update guard: the same answer again, not update_running.
    await assert.rejects(startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 }), refused);
    assert.equal(w.spawned.length, 0);
  });
});

test("Hermes: an available row, a failed row and no row at all still start the update session", POSIX_ONLY, async () => {
  for (const row of ["available", "failed", null]) {
    await withWorld({}, async (w) => {
      const manager = w.manager();
      const { checks, counts } = hermesChecks(w, cleanAnswer, undefined, row ?? "available");
      if (row !== null) await checks.refresh("hermes"); // no row: Agent OS has not checked Hermes yet
      assert.equal(checks.list().find((item) => item.agentId === "hermes")?.state, row ?? undefined);
      const before = counts.clean;
      const started = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
      assert.equal(started.kind, "session", `row ${row}`);
      assert.equal(counts.clean, before + 1, "the click's own clean check ran");
      assert.equal(w.spawned.length, 1);
      assert.deepEqual(w.spawned[0].options.args, ["update"]);
      // Answer the question so the session ends and the test leaves nothing running.
      const window = await openWindow(manager, started.sessionId);
      await waitFor(() => window.screen().includes("Update now?"));
      window.type("n\r");
      await waitFor(() => !manager.isLive(started.sessionId));
    });
  }
});

test("Hermes: a service handed checks without list() still starts (a replacement checks object need not have one)", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const bare = { refreshHermesClean: async () => ({ clean: false, checkout: null, reasons: [] }), isStopped: () => false };
    await assert.rejects(
      startAgentUpdate("hermes", { manager, checks: bare }),
      (error) => error.code === "hermes_not_clean",
      "it got as far as the clean check: nothing threw for the missing list()"
    );
    assert.equal(w.spawned.length, 0);
  });
});

test("POST /api/updates/hermes with an up-to-date row answers 409 hermes_up_to_date and the sentence; no terminal starts", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks } = hermesChecks(w, cleanAnswer, undefined, "up-to-date");
    await checks.refresh("hermes");
    await withUpdatesApp({ manager, checks }, async ({ call }) => {
      const refused = await call("POST", "/api/updates/hermes", { confirm: true });
      assert.deepEqual(refused, { status: 409, body: { error: "hermes_up_to_date", message: "Hermes is up to date." } });
      assert.equal(w.spawned.length, 0);
    });
  });
});

test("Hermes: an update session that finished leaves the row up to date, and the next click is refused", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks, state } = hermesChecks(w, cleanAnswer);
    const started = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
    // The update works: Hermes is checked again afterwards and now reads up to date.
    state.hermesRow = "up-to-date";
    const window = await openWindow(manager, started.sessionId);
    await waitFor(() => window.screen().includes("Update now?"));
    window.type("y\r");
    await waitFor(() => !manager.isLive(started.sessionId));
    await waitFor(() => checks.list().find((row) => row.agentId === "hermes")?.state === "up-to-date");
    await assert.rejects(startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 }), (error) => error.code === "hermes_up_to_date");
    assert.equal(w.spawned.length, 1, "one session only");
  });
});

test("Hermes: a second update is refused with update_running while the session lives, also when two start together; ended, it can start again", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks } = hermesChecks(w, cleanAnswer);
    const refused = (error) => error.status === 409 && error.code === "update_running" && error.message === UPDATE_RUNNING_HERMES;

    const results = await Promise.allSettled([
      startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 }),
      startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 })
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const losers = results.filter((result) => result.status === "rejected");
    assert.equal(losers.length, 1);
    assert.ok(refused(losers[0].reason), `refused with the update_running sentence: ${losers[0].reason?.message}`);
    const sessionId = results.find((result) => result.status === "fulfilled").value.sessionId;
    assert.equal(w.spawned.length, 1, "one terminal only");

    // While it lives (no one is starting any more), the session itself is what refuses.
    await assert.rejects(startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 }), refused);
    assert.equal(w.spawned.length, 1);

    // A different agent's update is not in its way.
    await w.install("claude");
    const claude = await startAgentUpdate("claude", { manager, checks });
    assert.equal(claude.kind, "job");
    assert.equal((await waitForJob(claude.jobId)).status, "succeeded");

    // Answering "n" ends the fake with exit 1; the update is over, and a new one may start.
    const window = await openWindow(manager, sessionId);
    await waitFor(() => window.screen().includes("Update now?"));
    window.type("n\r");
    await waitFor(() => !manager.isLive(sessionId));
    await waitFor(async () => {
      try {
        const again = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
        const second = await openWindow(manager, again.sessionId);
        await waitFor(() => second.screen().includes("Update now?"));
        second.type("n\r");
        await waitFor(() => !manager.isLive(again.sessionId));
        return true;
      } catch (error) {
        if (error.code === "update_running") return false; // the end is still being noticed
        throw error;
      }
    });
    assert.equal(w.spawned.length, 2);
  });
});

// ---- who is updating right now, and the checks around an update (SP5 E1: M1, M2, L35) ---------------------------------

test("isAgentUpdating(): true for an agent from the click on its update until it ends (a job or Hermes's session), and for no other agent", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    assert.equal(isAgentUpdating("claude"), false);
    assert.equal(isAgentUpdating("hermes"), false);

    await w.hold("claude");
    const job = await startAgentUpdate("claude", { manager });
    assert.equal(isAgentUpdating("claude"), true, "the job's update step is pending or running");
    assert.equal(isAgentUpdating("codex"), false);
    assert.equal(isAgentUpdating("hermes"), false);
    await w.release("claude");
    await waitForJob(job.jobId);
    assert.equal(isAgentUpdating("claude"), false, "and not any more once the job has ended");

    const { checks } = hermesChecks(w, cleanAnswer);
    const started = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
    assert.equal(isAgentUpdating("hermes"), true, "the update session is live");
    assert.equal(isAgentUpdating("claude"), false);
    const window = await openWindow(manager, started.sessionId);
    await waitFor(() => window.screen().includes("Update now?"));
    window.type("n\r");
    await waitFor(() => !manager.isLive(started.sessionId));
    await waitFor(() => !isAgentUpdating("hermes"));
  });
});

test("the quit check says an agent is updating while a Setup job runs its update step, and no session is needed for that (final fix, Se I1)", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const app = express();
    app.use(express.json());
    app.use("/api/sessions", createSessionsRouter({ manager }));
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const quitCheck = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/quit-check`, { method: "POST" })).json();
    try {
      assert.deepEqual(await quitCheck(), { live: [], updating: false }, "nothing runs");

      await w.hold("claude");
      const job = await startAgentUpdate("claude", { manager });
      assert.deepEqual(await quitCheck(), { live: [], updating: true }, "an update step runs and no session is open: quitting must ask");
      await w.release("claude");
      await waitForJob(job.jobId);
      assert.deepEqual(await quitCheck(), { live: [], updating: false }, "and not once the job has ended");
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("a round of the server's checks leaves out the agent whose update is running, keeps its row, and checks it again once the update has ended", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const checks = getUpdateChecks();
    await checks.refresh();
    const claudeBefore = statusOf(checks, "claude");
    const codexBefore = statusOf(checks, "codex");

    await w.hold("claude");
    await w.install("claude");
    const started = await startAgentUpdate("claude", { manager: w.manager() });
    await waitFor(async () => (await w.calls()).includes("claude update"));
    await new Promise((resolve) => setTimeout(resolve, 5)); // a later clock reading than the rows above
    await checks.refresh();
    assert.deepEqual(statusOf(checks, "claude"), claudeBefore, "the saved row is kept while its update runs");
    assert.ok(statusOf(checks, "codex").checkedAt > codexBefore.checkedAt, "the other agents are checked as usual");

    await w.release("claude");
    assert.equal((await waitForJob(started.jobId)).status, "succeeded");
    assert.deepEqual(pick(statusOf(checks, "claude")), { installed: "2.2.0", latest: "2.2.0", state: "up-to-date" }, "the update's own check was not skipped");
  });
});

test("the check after a Hermes update session is the update's own (afterChange), and it is not asked once the checks have been stopped", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const refreshes = [];
    let stopped = false;
    // Records every refresh whatever it was told: only the update service's own rules can keep it from asking.
    const checks = {
      isStopped: () => stopped,
      refreshHermesClean: async () => cleanAnswer(w),
      refresh: async (...args) => {
        refreshes.push(args);
        return [];
      }
    };
    const end = async (sessionId) => {
      const window = await openWindow(manager, sessionId);
      await waitFor(() => window.screen().includes("Update now?"));
      window.type("n\r");
      await waitFor(() => !manager.isLive(sessionId));
    };

    // Not stopped: the agent is checked again, as a check an update asked for.
    const first = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
    await end(first.sessionId);
    await waitFor(() => refreshes.length === 1);
    assert.deepEqual(refreshes, [["hermes", { afterChange: true }]]);
    await waitFor(() => !isAgentUpdating("hermes"));

    // Stopped (the server is quitting) while the session still runs: when it ends nothing is checked, and the poll gives up.
    const second = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
    stopped = true;
    await end(second.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 300)); // many polls
    assert.equal(refreshes.length, 1, "no check after the checks were stopped");
    assert.equal(isAgentUpdating("hermes"), false, "and the update is not counted as running for ever");
  });
});

test("withUpdateGuard(): the claim is released when the start works, throws or ends; a second claim in the meantime is refused", async () => {
  const manager = { list: async () => [] };
  let inside = null;
  const result = await withUpdateGuard(["claude", "openclaw"], { manager }, async () => {
    inside = await withUpdateGuard(["openclaw"], { manager }, async () => "never").catch((error) => error.code);
    return "started";
  });
  assert.equal(result, "started");
  assert.equal(inside, "update_running");
  assert.equal(await withUpdateGuard(["openclaw"], { manager }, async () => "free again"), "free again");
  await assert.rejects(
    withUpdateGuard(["claude"], { manager }, async () => {
      throw new Error("start failed");
    }),
    /start failed/
  );
  assert.equal(await withUpdateGuard(["claude"], { manager }, async () => "free after a failure"), "free after a failure");
});

// ---- Where the checks may run (fix round 1) ----------------------------------------------------------

// Every address a fetch was asked for while fn ran, answered by the real fetch (the world's servers are on 127.0.0.1).
async function watchingFetch(fn) {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, ...rest) => {
    seen.push(String(input?.url ?? input));
    return realFetch(input, ...rest);
  };
  try {
    return { seen, result: await fn(seen) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("with the checks off, an update flow asks no registry and nothing outside this computer; with them on, the same flow asks the registry", POSIX_ONLY, async () => {
  await withWorld({ checks: false }, async (w) => {
    const checks = getUpdateChecks();
    const before = JSON.stringify(checks.list());
    const outsideLoopback = (url) => new URL(url).hostname !== "127.0.0.1";
    const askedRegistry = (url) => /\/-\/package\//.test(url) || /registry\.npmjs\.org/.test(url);

    // Off: the registry is a dead loopback address (the wall npm test sets) and the flow still ends well.
    const off = await watchingFetch(async () =>
      withEnv({ AGENT_OS_TEST_NPM_REGISTRY: "http://127.0.0.1:9" }, async () => {
        await w.install("claude");
        const started = await startAgentUpdate("claude", { manager: w.manager() });
        return waitForJob(started.jobId);
      })
    );
    assert.equal(off.result.status, "succeeded");
    assert.deepEqual(await w.updateCalls(), ["claude update"]);
    assert.deepEqual(off.seen.filter(outsideLoopback), [], "nothing outside this computer was asked for");
    assert.deepEqual(off.seen.filter(askedRegistry), [], "no version lookup: the registry was not asked");
    assert.ok(!off.seen.some((url) => url.includes(":9")), "not even the dead address");
    assert.equal(JSON.stringify(checks.list()), before, "and the list of versions is as it was");

    // On (the same world, the same flow): the update is followed by a lookup, so the watch above can see one.
    const on = await watchingFetch(async () =>
      withEnv({ AGENT_OS_UPDATE_CHECKS: "1" }, async () => {
        const started = await startAgentUpdate("claude", { manager: w.manager() });
        return waitForJob(started.jobId);
      })
    );
    assert.equal(on.result.status, "succeeded");
    assert.ok(on.seen.some((url) => url.endsWith(CLAUDE_TAGS)), `the dist-tags were asked for: ${JSON.stringify(on.seen)}`);
    assert.deepEqual(on.seen.filter(outsideLoopback), []);
  });
});

test("with the checks off, the post-update refresh runs no agent either: the CLI is asked for its version by the job's own re-detection only", POSIX_ONLY, async () => {
  await withWorld({ checks: false }, async (w) => {
    let checkCalls = 0;
    const checks = createUpdateChecks({
      check: async (id) => {
        checkCalls += 1;
        return { agentId: id, installed: "1.0.0", latest: "1.0.0", state: "up-to-date", checkedAt: "2026-10-31T00:00:00.000Z" };
      }
    });
    await checks.refresh();
    await checks.refresh("claude");
    assert.equal(checkCalls, 0);
    assert.deepEqual(checks.list(), []);
    assert.deepEqual(await w.calls(), [], "no agent was run");
  });
});

// ---- What is offered, and where the update runs (fix round 1) ----------------------------------------

test("a clean copy outside the places Agent OS may work is not offered: folder_refused in the cache and GET /api/updates, no hermes-update in the plan, and the click refuses", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const outside = path.join(w.dir, "elsewhere", "hermes-agent");
    await mkdir(outside, { recursive: true });
    let checkout = outside;
    const checks = createUpdateChecks({
      // Hermes has an update, so it is the folder policy that decides here (a Hermes row that is up to date is refused: R48).
      check: async (id) => ({ agentId: id, installed: "1.0.0", latest: "1.0.0", state: id === "hermes" ? "available" : "up-to-date", checkedAt: "2026-10-31T00:00:00.000Z" }),
      cleanCheck: () => hermesCleanForUpdate({ check: async () => ({ clean: true, checkout, reasons: [] }) })
    });
    const manager = w.manager();
    await withUpdatesApp({ manager, checks, setup: true }, async ({ call }) => {
      await checks.refresh("hermes");
      assert.deepEqual((await call("GET", "/api/updates")).body.hermes, { clean: false, reasons: ["folder_refused"] });
      const hermesSteps = async () => (await call("GET", "/api/setup/plan")).body.steps.filter((step) => step.agentId === "hermes");
      assert.deepEqual((await hermesSteps()).map((step) => step.action), ["keep"], "no hermes-update");

      const refused = await call("POST", "/api/updates/hermes", { confirm: true });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, "hermes_not_clean");
      assert.equal(w.spawned.length, 0, "no terminal was started");

      // The same copy in a folder the policy allows is offered.
      checkout = w.checkout;
      await checks.refresh("hermes");
      assert.deepEqual((await call("GET", "/api/updates")).body.hermes, { clean: true, reasons: [] });
      assert.deepEqual((await hermesSteps()).map((step) => step.action), ["keep", "update"]);
    });
  });
});

test("the update session runs in the install directory the detected Hermes prints, found by the real clean check; HERMES_HOME names another folder and is not used for it", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    await w.makeHermesCheckout();
    // What `hermes --version` prints on a git install (Hermes 0.22.5): these two lines after the first.
    await setFakeKnob(w.home, "FAKE_HERMES_VERSION", `Hermes Agent v0.22.5\nInstall directory: ${w.checkout}\nInstall method: git`);
    const profile = path.join(w.home, "profile");
    await mkdir(profile, { recursive: true }); // a Hermes profile with no hermes-agent folder in it
    await withEnv({ HERMES_HOME: profile }, async () => {
      clearDetectCaches();
      const checks = createUpdateChecks({
        // Hermes has an update (a Hermes row that is up to date is refused: R48), so the click goes on to the real clean check.
        check: async (id) => ({ agentId: id, installed: "1.0.0", latest: "1.0.0", state: id === "hermes" ? "available" : "up-to-date", checkedAt: "2026-10-31T00:00:00.000Z" }),
        cleanCheck: () => hermesCleanForUpdate()
      });
      const manager = w.manager();
      await checks.refresh("hermes");
      assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] }, "the real check calls the install directory clean");

      const started = await startAgentUpdate("hermes", { manager, checks, sessionPollMs: 20 });
      assert.equal(started.kind, "session");
      assert.equal(w.spawned.length, 1);
      assert.deepEqual(w.spawned[0].options.args, ["update"]);
      assert.equal(w.spawned[0].options.cwd, w.checkout, "the session's folder is the install directory");
      const [summary] = await manager.list({ includeUpdate: true });
      assert.equal(summary.folder, w.checkout);

      const window = await openWindow(manager, started.sessionId);
      await waitFor(() => window.screen().includes("Update now?"));
      window.type("n\r");
      await waitFor(() => !manager.isLive(started.sessionId));
    });

    // Without the Install directory line, nothing is examined at all: no update is offered.
    await setFakeKnob(w.home, "FAKE_HERMES_VERSION", "Hermes Agent v0.22.5");
    clearDetectCaches();
    const bare = createUpdateChecks({ check: async (id) => ({ agentId: id }), cleanCheck: () => hermesCleanForUpdate() });
    await assert.rejects(startAgentUpdate("hermes", { manager: w.manager(), checks: bare }), (error) => error.code === "hermes_not_clean");
    assert.equal(w.spawned.length, 1, "no second terminal");
  });
});

// The production wiring itself: the service the server uses, getUpdateChecks(), and the clean check it is built
// with. Every other Hermes test builds its own service, so none of them would notice the folder policy being
// taken out of that wiring.
test("the server's own service (getUpdateChecks) applies the folder policy: the same clean copy is folder_refused outside the home folder and clean inside it", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    resetUpdateChecksForTest();
    try {
      const outside = path.join(w.dir, "elsewhere", "hermes-agent");
      await w.makeHermesCheckout(outside);
      await w.makeHermesCheckout(); // the same kind of copy at w.checkout, inside the home folder
      const printInstall = async (directory) => {
        await setFakeKnob(w.home, "FAKE_HERMES_VERSION", `Hermes Agent v0.22.5\nInstall directory: ${directory}\nInstall method: git`);
        clearDetectCaches();
      };
      // Hermes has an update (its own check says so), so it is the folder policy that decides here, not "up to date" (R48).
      await setFakeKnob(w.home, "FAKE_HERMES_UPDATE_CHECK", "⚕ Update available: 3 commits behind origin/main.");

      // Outside the places Agent OS may work: not offered, with the reason, through the real wiring.
      await printInstall(outside);
      const checks = getUpdateChecks();
      await checks.refresh("hermes");
      assert.deepEqual(checks.hermesClean(), { clean: false, reasons: ["folder_refused"] });
      // And the click, which asks the same service, is refused without a terminal.
      await assert.rejects(startAgentUpdate("hermes", { manager: w.manager(), sessionPollMs: 20 }), (error) => error.code === "hermes_not_clean");
      assert.equal(w.spawned.length, 0);

      // The control: the same service, the copy inside the home folder, is clean. So the first answer was the folder.
      await printInstall(w.checkout);
      await checks.refresh("hermes");
      assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] });
    } finally {
      resetUpdateChecksForTest();
    }
  });
});

// ---- The HTTP surface --------------------------------------------------------------------------------

async function withUpdatesApp({ manager, checks, setup = false }, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/updates", requireLocalMode, createUpdatesRouter({ manager, checks, sessionPollMs: 20 }));
  if (setup) app.use("/api/setup", createSetupRouter({ sessionManager: manager, updateChecks: checks }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try {
    return await fn({ call });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const statusRow = (agentId, state, extra = {}) => ({
  agentId,
  installed: "1.0.0",
  latest: "1.1.0",
  state,
  checkedAt: "2026-10-31T00:00:00.000Z",
  ...extra
});

test("GET /api/updates and POST /api/updates/refresh answer { agents, hermes }; the page never runs the git checks", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    let cleanCalls = 0;
    let cleanAnswerNow = { clean: false, checkout: null, reasons: ["dirty_tree"] };
    const checks = createUpdateChecks({
      check: async (id) => statusRow(id, id === "claude" ? "available" : "up-to-date"),
      cleanCheck: async () => {
        cleanCalls += 1;
        return cleanAnswerNow;
      }
    });
    await withUpdatesApp({ manager: w.manager(), checks }, async ({ call }) => {
      // Before the first check: nothing is known, and Hermes is not clean with nothing to say.
      assert.deepEqual(await call("GET", "/api/updates"), { status: 200, body: { agents: [], hermes: { clean: false, reasons: [] } } });
      assert.equal(cleanCalls, 0);

      const refreshed = await call("POST", "/api/updates/refresh");
      assert.equal(refreshed.status, 200);
      assert.deepEqual(refreshed.body.agents.map((row) => [row.agentId, row.state]), [
        ["claude", "available"],
        ["codex", "up-to-date"],
        ["cursor", "up-to-date"],
        ["openclaw", "up-to-date"],
        ["hermes", "up-to-date"]
      ]);
      assert.deepEqual(refreshed.body.hermes, { clean: false, reasons: ["dirty_tree"] });
      assert.equal(cleanCalls, 1);

      // A page request reads the cache: the same answer, no new check, however often it asks.
      cleanAnswerNow = { clean: true, checkout: w.checkout, reasons: [] };
      for (let i = 0; i < 3; i += 1) {
        const read = await call("GET", "/api/updates");
        assert.deepEqual(read.body, refreshed.body);
      }
      assert.equal(cleanCalls, 1);
      assert.deepEqual((await call("POST", "/api/updates/refresh")).body.hermes, { clean: true, reasons: [] });
      assert.equal(cleanCalls, 2);
    });
  });
});

test("POST /api/updates/:agentId needs confirm, answers 404 for an unknown agent, and starts the update", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const manager = w.manager();
    const { checks, state } = hermesChecks(w, cleanAnswer);
    await withUpdatesApp({ manager, checks }, async ({ call }) => {
      const noConfirm = await call("POST", "/api/updates/claude", {});
      assert.equal(noConfirm.status, 400);
      assert.deepEqual(noConfirm.body, { ok: false, error: "confirm must be true" });
      assert.equal((await call("POST", "/api/updates/claude", { confirm: "yes" })).status, 400, "only a real true counts");
      assert.deepEqual(await w.calls(), [], "nothing ran");

      const unknown = await call("POST", "/api/updates/gemini", { confirm: true });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error, "unknown_agent");
      assert.equal((await call("POST", "/api/updates/refresh-all", { confirm: true })).status, 404);

      await w.install("claude");
      const job = await call("POST", "/api/updates/claude", { confirm: true });
      assert.equal(job.status, 200);
      assert.deepEqual(Object.keys(job.body), ["kind", "jobId"]);
      assert.equal(job.body.kind, "job");
      assert.equal((await waitForJob(job.body.jobId)).status, "succeeded");

      state.answer = () => ({ clean: false, checkout: w.checkout, reasons: ["local_commits"] });
      const notClean = await call("POST", "/api/updates/hermes", { confirm: true });
      assert.deepEqual(notClean, { status: 409, body: { error: "hermes_not_clean", message: HERMES_NOT_CLEAN } });

      state.answer = cleanAnswer;
      const session = await call("POST", "/api/updates/hermes", { confirm: true });
      assert.equal(session.status, 200);
      assert.deepEqual(Object.keys(session.body), ["kind", "sessionId"]);
      assert.equal(session.body.kind, "session");
      const again = await call("POST", "/api/updates/hermes", { confirm: true });
      assert.deepEqual(again, { status: 409, body: { error: "update_running", message: UPDATE_RUNNING_HERMES } });
    });
  });
});

test("the updates routes answer like every sessions address outside local mode: not available", async () => {
  await withEnv({ DEMO_PUBLIC: "1" }, async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/updates",
      requireLocalMode,
      createUpdatesRouter({ manager: { list: async () => [] }, checks: createUpdateChecks({ check: async (id) => statusRow(id, "up-to-date") }) })
    );
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/updates`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_available" });
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---- Setup reads the cached Hermes answer ------------------------------------------------------------

test("GET /api/setup/plan offers the Hermes update only from the cached clean answer (as a session), and never runs the clean check itself", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const { checks, counts, state } = hermesChecks(w, cleanAnswer);
    await withUpdatesApp({ manager: w.manager(), checks, setup: true }, async ({ call }) => {
      const hermesSteps = async () => (await call("GET", "/api/setup/plan")).body.steps.filter((step) => step.agentId === "hermes");

      // Before the first check has ended: Hermes is kept, never updated (fails closed).
      assert.deepEqual((await hermesSteps()).map((step) => step.action), ["keep"]);
      assert.equal(counts.clean, 0);

      await checks.refreshHermesClean();
      const clean = await hermesSteps();
      assert.deepEqual(clean.map((step) => step.action), ["keep", "update"]);
      assert.equal(clean[1].id, "hermes-update");
      assert.equal(clean[1].runsIn, "session");
      assert.equal(counts.clean, 1, "reading the plan twice did not run the clean check");

      state.answer = () => ({ clean: false, checkout: w.checkout, reasons: ["dirty_tree"] });
      await checks.refresh("hermes");
      assert.deepEqual((await hermesSteps()).map((step) => step.action), ["keep"], "a copy that changed is no longer offered");
      const coding = await call("GET", "/api/setup/plan?group=coding");
      assert.ok(coding.body.steps.some((step) => step.id === "claude-update" && step.runsIn === undefined), "the others stay jobs");
      assert.equal(counts.clean, 2);

      // A Hermes update is never a job, whatever the cache says.
      const refused = await call("POST", "/api/setup/jobs", { confirm: true, steps: ["hermes-update"] });
      assert.deepEqual(refused, { status: 400, body: { error: "no_valid_steps" } });
      assert.equal(counts.clean, 2, "starting jobs does not run it either");
    });
  });
});

test("GET /api/setup/plan leaves out the Hermes update when the saved Hermes row says up to date (R48), from the cache and with a mark; any other row keeps it", POSIX_ONLY, async () => {
  await withWorld({}, async (w) => {
    const { checks, counts, state } = hermesChecks(w, cleanAnswer);
    await withUpdatesApp({ manager: w.manager(), checks, setup: true }, async ({ call }) => {
      const hermesSteps = async () => (await call("GET", "/api/setup/plan")).body.steps.filter((step) => step.agentId === "hermes");
      const actions = async () => (await hermesSteps()).map((step) => step.action);

      // No row at all (Hermes not checked yet) with a clean answer from the page's own click: the step stays, as before.
      await checks.refreshHermesClean();
      assert.equal(checks.list().length, 0);
      assert.deepEqual(await actions(), ["keep", "update"], "no row: a check that has not answered blocks nothing");

      // An available row and a failed row keep the step.
      for (const row of ["available", "failed"]) {
        state.hermesRow = row;
        await checks.refresh("hermes");
        assert.deepEqual(await actions(), ["keep", "update"], `a ${row} row`);
        assert.equal((await hermesSteps())[0].noUpdate, undefined);
      }

      // Up to date: no update step, and the keep step says why (so the page does not call a clean copy "changed").
      state.hermesRow = "up-to-date";
      await checks.refresh("hermes");
      assert.deepEqual(await actions(), ["keep"]);
      assert.equal((await hermesSteps())[0].noUpdate, "up-to-date");

      // Not clean and up to date: no step, no mark (the changed copy is the reason, and the Agents page lists it).
      state.answer = () => ({ clean: false, checkout: w.checkout, reasons: ["dirty_tree"] });
      await checks.refresh("hermes");
      assert.deepEqual(await actions(), ["keep"]);
      assert.equal("noUpdate" in (await hermesSteps())[0], false);

      // Reading the plan ran no check of any kind: the request reads the cached list.
      const checksBefore = counts.checks.length;
      const cleanBefore = counts.clean;
      await call("GET", "/api/setup/plan");
      await call("GET", "/api/setup/plan?group=all");
      assert.equal(counts.checks.length, checksBefore);
      assert.equal(counts.clean, cleanBefore);
    });
  });
});

// ---- Wiring ------------------------------------------------------------------------------------------

test("wiring: /api/updates is mounted behind requireLocalMode next to the sessions; the checks start after listen and stop on shutdown; the test runner switches them off", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = await readFile(path.join(root, "server", "index.js"), "utf8");
  const at = (needle) => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `server/index.js should contain: ${needle}`);
    return index;
  };
  const sessionsMount = at('app.use("/api/sessions", requireLocalMode, createSessionsRouter(');
  const updatesMount = at('app.use("/api/updates", requireLocalMode, createUpdatesRouter({ manager: sessionManager }));');
  const pageFallback = at("app.use(express.static(dist));");
  const listen = at("const server = app.listen(");
  const ready = at("console.log(`AGENT_OS_READY:${port}`);");
  const start = at("getUpdateChecks().start()");
  assert.ok(sessionsMount < updatesMount && updatesMount < pageFallback, "mounted with the sessions, before the page fallback");
  assert.ok(listen < ready && ready < start, "the first check starts after the server is listening and ready");
  assert.match(source, /registerShutdownTask\("update-checks", \(\) => getUpdateChecks\(\)\.stop\(\)\)/);
  assert.match(source.slice(Math.max(0, start - 200), start + 100), /isLocalMode\(\)/, "only in local mode");

  // Whether the checks run is decided in one place (checks.js), and start() asks it.
  const checksSource = await readFile(path.join(root, "server", "runtime", "updates", "checks.js"), "utf8");
  assert.match(checksSource, /export function updateChecksEnabled\(/);
  assert.match(checksSource, /function start\(\) \{\s*if \(timer \|\| !updateChecksEnabled\(\)\) return;/, "start() asks");
  assert.match(
    checksSource,
    /async function refresh\(agentId, \{ afterChange = false \} = \{\}\) \{\s*if \(stopped \|\| !updateChecksEnabled\(\)\) return list\(\);/,
    "and so does every refresh (and a stopped service checks nothing)"
  );

  // The two launchers that turn the checks on.
  assert.match(await readFile(path.join(root, "scripts", "dev-server.mjs"), "utf8"), /process\.env\.AGENT_OS_DEV_ORIGIN = "1"/, "npm run dev");
  assert.match(await readFile(path.join(root, "desktop", "src-tauri", "src", "main.rs"), "utf8"), /\.env\("AGENT_OS_PACKAGED", "1"\)/, "the desktop app");

  // npm test: the checks are off, and the registry they would ask is a dead loopback address.
  const runner = await readFile(path.join(root, "scripts", "run-tests.mjs"), "utf8");
  assert.match(runner, /AGENT_OS_UPDATE_CHECKS\s*=\s*"0"/, "npm test starts no version check in the servers it starts");
  assert.match(runner, /AGENT_OS_TEST_NPM_REGISTRY\s*=\s*"http:\/\/127\.0\.0\.1:9"/, "and the registry it would ask goes nowhere");
});
