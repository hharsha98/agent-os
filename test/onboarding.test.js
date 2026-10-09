// The "Get started" checklist (GET/PUT /api/onboarding): every step is judged
// from real state -- what is installed, whether a brain is set, whether a coding
// agent says it is signed in, whether a task has run -- and only the person's
// skip/hide choices are stored. Every test uses a temp HOME/USERPROFILE/
// AGENT_OS_HOME, a PATH of only the system folders, and fake CLIs placed in the
// fake home's ~/.local/bin; nothing here may start a real Hermes, OpenClaw,
// Claude Code, Codex or Cursor. The fakes are shebang scripts, so these tests
// are POSIX-only, matching test/setup-builders.test.js.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { saveBrains } from "../server/runtime/builders/brains.js";
import {
  SKIPPABLE_STEP_IDS,
  buildSteps,
  countSteps,
  getOnboarding,
  loadOnboardingState,
  resetOnboardingForTest,
  saveOnboardingState
} from "../server/runtime/onboarding.js";
import { getRunManager } from "../server/runtime/runs/run-manager.js";
import { resetSignInForTest } from "../server/runtime/setup/signin.js";

const isWindows = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posixSkip = { skip: isWindows ? "spawns shebang fake CLIs (POSIX-only)" : false };

// ---- fake CLIs -----------------------------------------------------------------
// One script plays every agent (its first argument says which). It writes each
// call to $HOME/.fake-agent-calls.log so a test can prove that only --version,
// --help, doctor and the status commands ever ran: no login, no exec, no chat.

const FAKE_CLI_SOURCE = `
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";

const [kind, ...args] = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
const flag = (name) => existsSync(path.join(home, name));
const out = (t) => process.stdout.write(t + "\\n");
const err = (t) => process.stderr.write(t + "\\n");
try { appendFileSync(path.join(home, ".fake-agent-calls.log"), kind + " " + args.join(" ") + "\\n"); } catch {}

const VERSION = { hermes: "Hermes Agent v9.9.9-test", claude: "2.1.900 (Claude Code)", codex: "codex-cli 0.200.0", cursor: "2026.10.99-test" };
if (args[0] === "--version") { out(VERSION[kind]); process.exit(0); }
if (args.includes("--help")) { out("Usage: " + kind); process.exit(0); }

if (kind === "hermes" && args[0] === "doctor") {
  if (flag(".fake-hermes-configured")) { out("All good."); process.exit(0); }
  err("No model provider configured."); process.exit(1);
}

const signedIn = () => flag(".fake-signed-in-" + kind);
const isStatus = (kind === "claude" && args[0] === "auth" && args[1] === "status") || (kind === "codex" && args[0] === "login" && args[1] === "status") || (kind === "cursor" && args[0] === "status");
if (isStatus) {
  if (flag(".fake-status-broken")) { err("boom"); process.exit(2); }
  if (kind === "claude") {
    if (signedIn()) { out(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com" })); process.exit(0); }
    out(JSON.stringify({ loggedIn: false, authMethod: "none" })); process.exit(1);
  }
  if (kind === "codex") {
    if (signedIn()) { out("Logged in using ChatGPT"); process.exit(0); }
    err("Not logged in"); process.exit(1);
  }
  out(signedIn() ? "Logged in as someone@example.com" : "Not logged in");
  process.exit(0);
}
out("fake-" + kind + ": " + JSON.stringify(args));
`;

let sourceDir = null;
let fakeJsPath = "";

before(async () => {
  if (isWindows) return;
  sourceDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-onboarding-src-"));
  fakeJsPath = path.join(sourceDir, "fake-cli.mjs");
  await writeFile(fakeJsPath, FAKE_CLI_SOURCE);
});

after(async () => {
  if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
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

// Full isolation for every test: temp HOME, AGENT_OS_HOME and managed-Node root,
// and a PATH of only the system folders -- never the developer's own, where
// real agents live.
async function withTempEnv(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-onboarding-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-onboarding-runtime-"));
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-os-onboarding-managed-"));
  try {
    await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_MANAGED_ROOT: managedRoot,
        PATH: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
        HERMES_HOME: undefined
      },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        clearDetectCaches();
        resetOnboardingForTest();
        resetSignInForTest();
        try {
          await fn({ home, agentOsHome });
        } finally {
          await getRunManager().stopAll();
        }
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
    await rm(managedRoot, { recursive: true, force: true });
  }
}

async function installFake(home, kind) {
  const names = kind === "cursor" ? ["agent"] : [kind];
  const binDir = path.join(home, ".local", "bin");
  await mkdir(binDir, { recursive: true });
  for (const name of names) {
    await writeFile(path.join(binDir, name), `#!/bin/sh\nexec "${process.execPath}" "${fakeJsPath}" ${kind} "$@"\n`);
    await chmod(path.join(binDir, name), 0o755);
  }
}

const mark = (home, name) => writeFile(path.join(home, name), "1");
const statusOf = (result) => Object.fromEntries(result.steps.map((s) => [s.id, s.status]));

async function readCalls(home) {
  try {
    return (await readFile(path.join(home, ".fake-agent-calls.log"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// A finished run of the given kind, started the way an adapter does it but
// running a harmless `node -e` instead of any real agent. A cost is reported
// the way a real agent does: as a usage event on one of its output lines.
async function recordRun(agentId, { kind = "agent", costUsd = null } = {}) {
  const manager = getRunManager();
  const run = await manager.startRun({
    agentId,
    kind,
    title: "Example task",
    command: process.execPath,
    args: ["-e", "console.log('done')"],
    cwd: os.tmpdir(),
    parseLine: () => (costUsd === null ? null : [{ type: "usage", costUsd }])
  });
  return manager.waitForRun(run.id, { timeoutMs: 20000 });
}

// ---- the pure pieces -----------------------------------------------------------

test("buildSteps()/countSteps(): done beats skipped, step 5 is unavailable and never counted", () => {
  const facts = { installedOperators: [], installedCoding: ["claude"], brains: [], signedIn: [], signInNotes: {}, runCount: 0 };
  const steps = buildSteps(facts, { skipped: ["install", "brain"], hidden: false });
  assert.deepEqual(
    steps.map((s) => [s.id, s.status]),
    [["install", "skipped"], ["brain", "skipped"], ["signin", "todo"], ["first-run", "todo"], ["agent-computer", "unavailable"]]
  );
  assert.match(steps[0].detail, /Claude Code installed\. Still needed: Hermes or OpenClaw\./);
  assert.deepEqual(countSteps(steps), { done: 0, skipped: 2, todo: 2, total: 4 });

  const done = buildSteps({ ...facts, installedOperators: ["hermes"], brains: ["hermes"] }, { skipped: ["install", "brain"], hidden: false });
  assert.deepEqual([done[0].status, done[1].status], ["done", "done"], "work done after a skip shows as done");
  assert.ok(SKIPPABLE_STEP_IDS.every((id) => id !== "agent-computer"));
});

// ---- real state ----------------------------------------------------------------

test("getOnboarding(): a bare computer is four todo steps and one that is not available yet", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    const result = await getOnboarding({ refresh: true });
    assert.deepEqual(statusOf(result), { install: "todo", brain: "todo", signin: "todo", "first-run": "todo", "agent-computer": "unavailable" });
    assert.deepEqual(result.counts, { done: 0, skipped: 0, todo: 4, total: 4 });
    assert.equal(result.complete, false);
    assert.equal(result.hidden, false);
    assert.deepEqual(result.facts, { installed: [], brains: [], signedIn: [], firstRun: null });
    assert.match(result.steps[0].detail, /Nothing installed yet/);
    assert.match(result.steps[3].detail, /No task has run yet/);
    assert.equal(result.steps[4].detail, "Coming in v0.5.");
    assert.deepEqual(await readCalls(home), [], "nothing was spawned on a computer with no agents");
  });
});

test("getOnboarding(): installed is not set up -- brain, sign-in and first task stay todo, with honest sentences", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFake(home, "hermes");
    await installFake(home, "claude");
    const result = await getOnboarding({ refresh: true });
    assert.deepEqual(statusOf(result), { install: "done", brain: "todo", signin: "todo", "first-run": "todo", "agent-computer": "unavailable" });
    assert.deepEqual(result.counts, { done: 1, skipped: 0, todo: 3, total: 4 });
    assert.deepEqual(result.facts.installed, ["hermes", "claude"]);
    assert.match(result.steps[0].detail, /Hermes and Claude Code installed\./);
    assert.match(result.steps[1].detail, /need a model to think with/);
    assert.equal(result.steps[2].detail, "Claude Code is not signed in yet.");
  });
});

test("getOnboarding(): every step turns done from real state, and only read-only commands ever ran", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFake(home, "hermes");
    await installFake(home, "claude");
    await installFake(home, "cursor");
    await mark(home, ".fake-hermes-configured");
    await mark(home, ".fake-signed-in-claude");
    await recordRun("claude", { costUsd: 0.25 });

    const result = await getOnboarding({ refresh: true });
    assert.deepEqual(statusOf(result), { install: "done", brain: "done", signin: "done", "first-run": "done", "agent-computer": "unavailable" });
    assert.deepEqual(result.counts, { done: 4, skipped: 0, todo: 0, total: 4 });
    assert.equal(result.complete, true);
    assert.deepEqual(result.facts.brains, ["hermes"]);
    assert.deepEqual(result.facts.signedIn, ["claude"], "the first signed-in agent is enough; the rest are not asked");
    assert.equal(result.facts.firstRun.agentId, "claude");
    assert.equal(result.facts.firstRun.costUsd, 0.25);
    assert.equal(typeof result.facts.firstRun.durationMs, "number");
    assert.equal(result.steps[2].detail, "Claude Code is signed in.");
    assert.equal(result.steps[3].detail, "1 task run so far.");

    const wire = JSON.stringify(result);
    assert.ok(!wire.includes("someone@example.com"), "no account detail on the wire");
    const calls = await readCalls(home);
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.match(call, /^(hermes|claude|cursor) (--version|.*--help|doctor|auth status|status)$/, `only read-only commands may run: ${call}`);
    }
    assert.ok(!calls.some((call) => /^cursor (status|auth)/.test(call)), "cursor's status was not asked once claude was signed in");
  });
});

test("getOnboarding(): a first task that reported no cost says null, not zero", posixSkip, async () => {
  await withTempEnv(async () => {
    await recordRun("codex");
    const result = await getOnboarding({ refresh: true });
    assert.equal(statusOf(result)["first-run"], "done");
    assert.equal(result.facts.firstRun.costUsd, null);
  });
});

test("getOnboarding(): sign-in runs, install jobs and service runs are not a first task", posixSkip, async () => {
  await withTempEnv(async () => {
    for (const kind of ["signin", "install", "configure", "service"]) await recordRun("claude", { kind });
    const result = await getOnboarding({ refresh: true });
    assert.equal(statusOf(result)["first-run"], "todo");
    assert.equal(result.facts.firstRun, null);
  });
});

test("getOnboarding(): a saved OpenRouter or local brain for Claude Code or Codex counts; the plan default does not", posixSkip, async () => {
  await withTempEnv(async () => {
    assert.equal(statusOf(await getOnboarding({ refresh: true })).brain, "todo", "the default plan brain is not a choice the person made");
    await saveBrains({ codex: { mode: "openrouter", model: "anthropic/claude-sonnet-4.6" } });
    const result = await getOnboarding({ refresh: true });
    assert.equal(statusOf(result).brain, "done");
    assert.deepEqual(result.facts.brains, ["codex"]);
    assert.equal(result.steps[1].detail, "Codex has a brain set up.");
  });
});

test("getOnboarding(): a sign-in check that cannot answer is not 'signed in', and says so", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFake(home, "claude");
    await mark(home, ".fake-status-broken");
    const result = await getOnboarding({ refresh: true });
    assert.equal(statusOf(result).signin, "todo");
    assert.equal(result.steps[2].detail, "Couldn't tell whether Claude Code is signed in.");
  });
});

test("getOnboarding(): the checks are remembered for a minute; refresh looks again", posixSkip, async () => {
  await withTempEnv(async ({ home }) => {
    await installFake(home, "claude");
    const statusCalls = async () => (await readCalls(home)).filter((c) => c === "claude auth status").length;
    await getOnboarding({ refresh: true });
    await getOnboarding();
    await getOnboarding();
    assert.equal(await statusCalls(), 1, "two more calls inside the minute asked nothing");

    await mark(home, ".fake-signed-in-claude");
    assert.equal(statusOf(await getOnboarding()).signin, "todo", "still the remembered answer");
    assert.equal(statusOf(await getOnboarding({ refresh: true })).signin, "done");
    assert.equal(await statusCalls(), 2);
  });
});

// ---- the person's choices ------------------------------------------------------

test("skip and hide: validated, stored as the only file written, and shown in the steps", posixSkip, async () => {
  await withTempEnv(async ({ agentOsHome }) => {
    assert.deepEqual(await loadOnboardingState(), { skipped: [], hidden: false });

    await assert.rejects(() => saveOnboardingState({ skipped: ["nope"] }), { code: "invalid_skipped" });
    await assert.rejects(() => saveOnboardingState({ skipped: ["agent-computer"] }), { code: "invalid_skipped" });
    await assert.rejects(() => saveOnboardingState({ skipped: "brain" }), { code: "invalid_skipped" });
    await assert.rejects(() => saveOnboardingState({ hidden: "yes" }), { code: "invalid_hidden" });
    assert.deepEqual(await loadOnboardingState(), { skipped: [], hidden: false }, "a refused change stores nothing");

    await saveOnboardingState({ skipped: ["brain", "brain", "signin"], hidden: true });
    assert.deepEqual(await loadOnboardingState(), { skipped: ["brain", "signin"], hidden: true });
    const stored = JSON.parse(await readFile(path.join(agentOsHome, "config", "onboarding.json"), "utf8"));
    assert.deepEqual(stored, { skipped: ["brain", "signin"], hidden: true });

    // A change to one thing keeps the other.
    await saveOnboardingState({ hidden: false });
    assert.deepEqual(await loadOnboardingState(), { skipped: ["brain", "signin"], hidden: false });

    const result = await getOnboarding({ refresh: true });
    assert.deepEqual(statusOf(result), { install: "todo", brain: "skipped", signin: "skipped", "first-run": "todo", "agent-computer": "unavailable" });
    assert.deepEqual(result.counts, { done: 0, skipped: 2, todo: 2, total: 4 });
    assert.equal(result.complete, false);

    await saveOnboardingState({ skipped: SKIPPABLE_STEP_IDS });
    assert.equal((await getOnboarding()).complete, true, "everything done or skipped is the calm finish");
  });
});

test("a hand-edited or broken onboarding.json cannot break the checklist", posixSkip, async () => {
  await withTempEnv(async ({ agentOsHome }) => {
    await mkdir(path.join(agentOsHome, "config"), { recursive: true });
    const file = path.join(agentOsHome, "config", "onboarding.json");
    await writeFile(file, JSON.stringify({ skipped: ["brain", "../../etc", 7], hidden: "true" }));
    assert.deepEqual(await loadOnboardingState(), { skipped: ["brain"], hidden: false });
    await writeFile(file, "{ not json");
    assert.deepEqual(await loadOnboardingState(), { skipped: [], hidden: false });
  });
});

// ---- over HTTP -----------------------------------------------------------------

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function killChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test("HTTP: the checklist is behind the session gate, PUT needs confirm and valid ids, and the choices survive", posixSkip, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-onboarding-http-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-onboarding-http-runtime-"));
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-os-onboarding-http-managed-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const TOKEN = "test-onboarding-token-123";
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    HOME: homeDir,
    USERPROFILE: homeDir,
    AGENT_OS_HOME: agentOsHome,
    AGENT_OS_MANAGED_ROOT: managedRoot,
    AGENT_OS_TOKEN: TOKEN,
    AGENT_OS_NO_BROWSER: "1",
    HERMES_AGENT_OS_SCHEDULER: "0",
    PATH: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter)
  };
  for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_REQUIRE_AUTH", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT"]) {
    delete env[key];
  }
  await installFake(homeDir, "claude");

  const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  const headers = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };
  const get = (url) => fetch(`${base}${url}`, { headers });
  const put = (body) => fetch(`${base}/api/onboarding`, { method: "PUT", headers, body: JSON.stringify(body) });

  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      if (child.exitCode != null) throw new Error(`server exited early:\n${logs.slice(-2000)}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // still booting
      }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.equal((await fetch(`${base}/api/onboarding`)).status, 401, "no session, no checklist");

    const first = await (await get("/api/onboarding?refresh=1")).json();
    assert.deepEqual(statusOf(first), { install: "todo", brain: "todo", signin: "todo", "first-run": "todo", "agent-computer": "unavailable" });
    assert.equal(first.hidden, false);
    assert.equal(first.steps[2].detail, "Claude Code is not signed in yet.");
    assert.deepEqual(first.facts.installed, ["claude"]);

    assert.equal((await put({ hidden: true })).status, 400, "confirm must be true");
    assert.equal((await put({ confirm: true, skipped: ["agent-computer"] })).status, 400);
    assert.equal((await put({ confirm: true, skipped: "brain" })).status, 400);
    assert.equal((await put({ confirm: true, hidden: "yes" })).status, 400);
    assert.equal((await (await get("/api/onboarding")).json()).hidden, false, "refused changes stored nothing");

    const saved = await put({ confirm: true, skipped: ["brain"], hidden: true });
    assert.equal(saved.status, 200);
    const after = await saved.json();
    assert.equal(after.hidden, true);
    assert.equal(statusOf(after).brain, "skipped");
    assert.deepEqual(after.counts, { done: 0, skipped: 1, todo: 3, total: 4 });

    const again = await (await get("/api/onboarding")).json();
    assert.deepEqual([again.hidden, statusOf(again).brain], [true, "skipped"], "the choices are stored on the server");
    const wire = JSON.stringify([first, after, again]);
    assert.ok(!wire.includes(homeDir), "no file paths of this computer on the wire");
  } finally {
    await killChild(child);
    await rm(homeDir, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
    await rm(managedRoot, { recursive: true, force: true });
  }
});
