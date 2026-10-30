// Part 3 of 3 of what used to be one file, test/runtime.test.js (SP4 sweep B: the one file took 40 s on its own
// and more than the 180 s limit of one test file on a machine under heavy load, so it is now three files that
// `node --test` runs side by side; nothing in the tests changed, and the set-up below is the same in each):
// the Hermes task controls, the module runs and CLI sessions, the OS audit, the Codex API, the workflows, the
// builder, the connections and the Docker artifacts.
// Part 1 is test/runtime.test.js, part 2 is test/runtime-voice-gateway.test.js.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { assertAdminRequest, isAdminRequest, sessionStatus } from "../server/runtime/auth.js";
import { generateAgentWorkflow, normalizeWorkflow } from "../server/runtime/agent-os-builder.js";
import { configureApiIntegration, listApiIntegrations, testApiIntegration } from "../server/runtime/api-integrations.js";
import { builderReplayOverlayUrl, getBuilderReplayOverlay, injectBuilderReplayOverlay } from "../server/runtime/builder-overlay.js";
import {
  getBuilderBootstrap,
  getBuilderLogs,
  getBuilderStatus,
  prepareBuilderBootstrap,
  runBuilderSmokeTest,
  startBuilderSupervisor,
  stopBuilderSupervisor
} from "../server/runtime/builder-service.js";
import { configureConnection, getConnections } from "../server/runtime/connections.js";
import { getCodexApiStatus, runCodexApi, testCodexApi } from "../server/runtime/codex-api.js";
import { getExecutionGateStatus, isExecutionEnabled, setExecutionGateStatus } from "../server/runtime/execution-gate.js";
import { auditExportDirectory } from "../server/runtime/exporter.js";
import { prepareInstall } from "../server/runtime/installers.js";
import { getAgentOsReadiness, getKernelStatus } from "../server/runtime/kernel.js";
import {
  addMemory,
  configureMemoryVector,
  exportMemory,
  getMemoryState,
  importMemory,
  rebuildMemoryVectorIndex,
  searchMemory,
  updateMemory
} from "../server/runtime/memory.js";
import { getAgentRuns, getModuleLogs, getModuleRuns, getModuleSession, getModuleSessions, getModules, getOsAudit, getOsStatus, messageModuleSession, runModule, startModuleSession, stopModuleSession, testModule } from "../server/runtime/modules.js";
import { checkProviderHealth, getRouterHealth, getRouterStatus, runRouter } from "../server/runtime/router.js";
import {
  configureProviderSetup,
  getOllamaDoctor,
  getProviderModelInventory,
  getProviderSetupState,
  prepareProviderModel,
  testProviderSetup
} from "../server/runtime/provider-setup.js";
import {
  approveSchedulerJob,
  getSchedulerHistory,
  getSchedulerState,
  pauseSchedulerJob,
  rejectSchedulerJob,
  resumeSchedulerJob,
  runSchedulerTick,
  saveSchedulerJob
} from "../server/runtime/scheduler.js";
import { cancelVideoRun, createSelfModuleItem, getSelfModuleState, getVideoRun, getVideoWorkerStatus, isParkedSelfModule, queueVideoJob, resolveVideoRunOutput, runGoalLoop, runSeoAudit, runSeoDiscovery, runSeoRankSnapshot, runVideoJob } from "../server/runtime/self-modules.js";
import {
  configureSkill,
  fetchSkillMarketplaceFeed,
  getSampleSkillManifests,
  getSkill,
  getSkillMarketplace,
  getSkillPublishers,
  getSkillLogs,
  getSkillRegistry,
  importMarketplaceSkill,
  importSkillBundle,
  installSkill,
  prepareSkillDependencies,
  saveSkillMarketplaceFeed,
  signSkillManifest,
  setSkillPublisherAllowed,
  setSkillPublisherBlocked,
  setSkillEnabled,
  testSkill,
  trustSkillPublisher,
  updateSkill,
  updateSkillPublisherPolicy,
  updateSkillPublisherReputation,
  untrustSkillPublisher,
  uninstallSkill
} from "../server/runtime/skills.js";
import { getSetupState, saveSetupState, startFirstSetupWorkflow } from "../server/runtime/setup.js";
import {
  configureUsageBudget,
  getUsageReconciliation,
  getUsageState,
  importUsageBilling,
  previewUsageBillingImport,
  recordUsageEvent,
  runUsageReconciliation
} from "../server/runtime/usage.js";
import { getDesktopContext, getVoiceControlStatus, runVoiceCommand } from "../server/runtime/voice-control.js";
import { deleteWorkflow, getWorkflow, getWorkflowRunEvents, getWorkflowRunReplay, listWorkflows, resumeWorkflowRun, runWorkflow, saveWorkflow } from "../server/runtime/workflows.js";

// Never touch the developer's REAL agents. Agent detection looks on PATH and in
// fallback folders under the user's home (~/.agent-os/node/bin/openclaw,
// ~/.local/bin/hermes...), so for this whole file HOME/USERPROFILE point at an
// empty temp folder and PATH holds only system folders (not node's own folder,
// which can hold real agents). Tests that need an agent build their own fake
// CLI and add its folder to PATH. Everything is restored when the file ends.
const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "agent-os-runtime-home-"));
const savedEnv = {};
for (const [key, value] of Object.entries({
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  HERMES_HOME: undefined,
  ...(process.platform === "win32" ? {} : { PATH: "/usr/bin:/bin" })
})) {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
if (process.platform !== "win32" && os.homedir() !== isolatedHome) {
  throw new Error("test isolation failed: os.homedir() is not the temp home");
}
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
});

async function withTempRuntime(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-agent-os-test-"));
  const previous = process.env.HERMES_AGENT_OS_HOME;
  process.env.HERMES_AGENT_OS_HOME = dir;
  try {
    await fn(dir);
  } finally {
    if (previous == null) delete process.env.HERMES_AGENT_OS_HOME;
    else process.env.HERMES_AGENT_OS_HOME = previous;
    // Retries: a run's last writes (the video queue's caption files) can land while the
    // folder is being removed, which gave ENOTEMPTY on a CI runner once.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function withEnv(updates, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// setting a *_CLI_PATH field now requires the execution gate
// on and confirm:true. Scope the gate to just the configure call so tests
// that expect dry-run afterward are unaffected.
async function configureCliPath(id, fields) {
  return withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, () => configureConnection(id, fields, { confirm: true }));
}

function withHttpServer(handler, fn) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      try {
        const result = await fn(`http://127.0.0.1:${address.port}`);
        server.close((error) => error ? reject(error) : resolve(result));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createSignedSkillBundle(manifest, keyPair = null) {
  const pair = keyPair || crypto.generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  return {
    kind: "hermes.skill.bundle",
    schemaVersion: 1,
    manifest,
    signature: {
      algorithm: "ed25519",
      publicKey,
      value: signSkillManifest(manifest, privateKey)
    }
  };
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
  return filePath;
}

async function waitFor(fn, { timeout = 3000, interval = 25 } = {}) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeout) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return lastValue;
}

const PROVIDER_ENV_RESET = {
  OPENROUTER_API_KEY: null,
  OLLAMA_HOST: null,
  MINIMAX_API_KEY: null,
  OPENAI_API_KEY: null,
  OPENAI_BASE_URL: null,
  OMNIROUTE_BASE_URL: null,
  OMNIROUTE_API_KEY: null,
  OMNIROUTE_MODEL: null,
  AGENT_OS_LIVE_CHAT: null,
  OPENAI_ADMIN_KEY: null,
  ANTHROPIC_API_KEY: null,
  GEMINI_API_KEY: null,
  HERMES_OPENROUTER_HEALTH_URL: null,
  HERMES_OPENROUTER_KEY_URL: null,
  HERMES_OPENROUTER_CREDITS_URL: null,
  HERMES_OPENAI_COSTS_URL: null,
  HERMES_OPENAI_HEALTH_URL: null,
  AGENT_OS_CODEX_MODEL: null,
  AGENT_OS_CODEX_REASONING_EFFORT: null,
  AGENT_OS_OPENAI_BASE_URL: null,
  AGENT_OS_CODEX_TIMEOUT_MS: null,
  HERMES_VOICE_OPENAI_URL: null,
  HERMES_VOICE_USE_CODEX_GPT: null,
  HERMES_VOICE_MODEL: null,
  HERMES_MINIMAX_HEALTH_URL: null,
  HERMES_ANTHROPIC_HEALTH_URL: null,
  HERMES_GEMINI_HEALTH_URL: null,
  HERMES_FIRECRAWL_SCRAPE_URL: null,
  HERMES_FIRECRAWL_SEARCH_URL: null
};

const VIDEO_STT_ENV_RESET = {
  GROQ_API_KEY: null,
  OPENAI_API_KEY: null,
  HERMES_VIDEO_STT_PROVIDER: null,
  HERMES_GROQ_STT_URL: null,
  HERMES_OPENAI_STT_URL: null,
  HERMES_VIDEO_GROQ_STT_MODEL: null,
  HERMES_VIDEO_OPENAI_STT_MODEL: null,
  HERMES_VIDEO_STT_TIMEOUT_MS: null,
  HERMES_VIDEO_CLOUD_STT_MAX_MB: null,
  HERMES_VIDEO_STT_LANGUAGE: null
};

const isWindows = process.platform === "win32";

test(
  "Hermes task controls are dry-run-first and execute real Kanban commands when enabled",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "hermes-home");
    const profileRoot = path.join(hermesHome, "profiles", "agentalpha");
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, "gateway_state.json"), JSON.stringify({
      gateway_state: "running",
      active_agents: 0,
      platforms: {},
      updated_at: "2026-07-07T00:00:00.000Z"
    }));
    const cli = path.join(dir, "hermes");
    await writeFile(cli, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$HERMES_HOME/control-args.txt\"",
      "cat <<'JSON'",
      "{\"ok\":true,\"status\":\"updated\"}",
      "JSON"
    ].join("\n"));
    await chmod(cli, 0o755);

    await configureCliPath("hermes", { HERMES_HOME: hermesHome, HERMES_CLI_PATH: cli, HERMES_KANBAN_BOARD: "agent-os" });

    const prepared = await runModule("hermes", {
      action: "task_block",
      taskId: "t-123",
      reason: "Needs operator review"
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, "dry_run");
    assert.equal(prepared.control.executed, false);
    assert.equal(prepared.control.taskId, "t-123");
    assert.match(prepared.control.command, /hermes kanban --board agent-os block t-123 --kind needs_input <reason>/);
    assert.equal(prepared.proof.replay.available, true);
    assert.deepEqual(prepared.proof.replay.input, {
      action: "task_block",
      taskId: "t-123",
      dryRun: true
    });
    await assert.rejects(readFile(path.join(hermesHome, "control-args.txt"), "utf8"));

    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
      const executed = await runModule("hermes", {
        action: "task_block",
        taskId: "t-123",
        reason: "Needs operator review",
        dryRun: false
      });
      assert.equal(executed.ok, true);
      assert.equal(executed.mode, "executed");
      assert.equal(executed.control.executed, true);
      assert.equal(executed.execution.adapterId, "hermes-kanban-control");
      const args = await readFile(path.join(hermesHome, "control-args.txt"), "utf8");
      assert.match(args, /kanban --board agent-os block t-123 --kind needs_input Needs operator review/);
      assert.equal(JSON.stringify(executed).includes(hermesHome), false);
      assert.equal(JSON.stringify(executed).includes(cli), false);
    });
  });
});

test(
  "module run uses structured configured CLI adapter when explicitly enabled",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const script = path.join(dir, "codex");
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    const fakeKey = `${"sk"}-testbadbadbadbadbadbadbad`;
    // buildCliArgs now runs the args through withMessageTerminator,
    // which inserts a "--" immediately before an arg that is exactly the raw
    // message, so the message lands at $2 (after "--") and "token-placeholder" at $3.
    await writeFile(script, "#!/bin/sh\necho configured-codex-path:$2\necho cwd:$(pwd)\necho token:$3\n");
    await chmod(script, 0o755);
    await configureCliPath("codex", {
      CODEX_CLI_PATH: script,
      CODEX_WORKSPACE: workspace,
      CODEX_CLI_ARGS: "{{message}} token-placeholder",
      CODEX_TIMEOUT_MS: "30000"
    });
    const previous = process.env.HERMES_AGENT_OS_ENABLE_EXEC;
    process.env.HERMES_AGENT_OS_ENABLE_EXEC = "1";
    try {
      const result = await runModule("codex", { message: `hello ${os.homedir()} ${fakeKey}`, dryRun: false });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "executed");
      assert.match(result.reply, /configured-codex-path:hello/);
      assert.equal(JSON.stringify(result).includes(os.homedir()), false);
      assert.equal(JSON.stringify(result).includes(fakeKey), false);
      assert.equal(JSON.stringify(result).includes(workspace), false);
      assert.equal(result.execution.adapterId, "codex-cli");
      assert.equal(result.execution.command, "codex");
      assert.equal(result.execution.argsCount, 3);
      assert.equal(result.execution.workspace.configured, true);
      assert.equal(result.execution.workspace.used, true);
      assert.equal(result.execution.timeoutMs, 30000);
      assert.equal(result.proof.mode, "executed");
      assert.equal(result.proof.runId, result.execution.runId);
      assert.equal(result.proof.dryRun, false);
      assert.ok(result.proof.evidence.some((item) => item.includes("adapter: codex-cli")));

      const logs = await getModuleLogs("codex");
      assert.ok(logs.logs.some((entry) => entry.message === "Module command executed"));
      assert.equal(JSON.stringify(logs).includes(os.homedir()), false);
      assert.equal(JSON.stringify(logs).includes(fakeKey), false);
      assert.equal(JSON.stringify(logs).includes(workspace), false);
    } finally {
      if (previous == null) delete process.env.HERMES_AGENT_OS_ENABLE_EXEC;
      else process.env.HERMES_AGENT_OS_ENABLE_EXEC = previous;
    }
  });
});

test(
  "module CLI dry-runs expose sanitized execution plans",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const script = path.join(dir, "codex");
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(script, "#!/bin/sh\necho should-not-run\n");
    await chmod(script, 0o755);
    await configureCliPath("codex", {
      CODEX_CLI_PATH: script,
      CODEX_WORKSPACE: workspace,
      CODEX_CLI_ARGS: "--ask {{message}}",
      CODEX_TIMEOUT_MS: "25000"
    });

    const privatePrompt = `plan this without leaking ${os.homedir()}`;
    const result = await runModule("codex", { message: privatePrompt });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "dry_run");
    assert.equal(result.plannedExecution.command, "codex");
    // withMessageTerminator inserts a "--" right before the
    // message arg, adding one extra arg to the plan preview.
    assert.equal(result.plannedExecution.commandPreview, "codex <arg:1> <arg:2> <arg:3>");
    assert.equal(result.plannedExecution.argsCount, 3);
    assert.equal(result.plannedExecution.workspace.configured, true);
    assert.equal(result.plannedExecution.workspace.used, true);
    assert.match(result.plannedExecution.workspacePolicy, /configured workspace policy/);
    assert.equal(JSON.stringify(result).includes(privatePrompt), false);
    assert.equal(JSON.stringify(result).includes(script), false);
    assert.equal(JSON.stringify(result).includes(workspace), false);

    const logs = await getModuleLogs("codex");
    assert.equal(JSON.stringify(logs).includes(privatePrompt), false);
    assert.equal(JSON.stringify(logs).includes(script), false);
    assert.ok(logs.logs.some((entry) => entry.details?.plannedExecution?.commandPreview === "codex <arg:1> <arg:2> <arg:3>"));
  });
});

test(
  "module CLI sessions are dry-run-first and persisted without local paths",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const script = path.join(dir, "codex");
    await writeFile(script, "#!/bin/sh\necho should-not-start\n");
    await chmod(script, 0o755);
    await configureCliPath("codex", { CODEX_CLI_PATH: script, CODEX_CLI_ARGS: "{{message}}" });
    delete process.env.HERMES_AGENT_OS_ENABLE_EXEC;

    const modules = await getModules();
    assert.ok(modules.find((module) => module.id === "codex")?.actions.includes("sessions"));

    const prepared = await startModuleSession("codex", { message: `hello ${os.homedir()}` });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, "dry_run");
    assert.equal(prepared.session.status, "prepared");
    assert.equal(prepared.session.pid, null);
    assert.equal(prepared.session.dryRun, true);
    // withMessageTerminator inserts a "--" right before the
    // bare message arg, adding one extra arg to the plan preview.
    assert.equal(prepared.session.commandPreview, "codex <arg:1> <arg:2>");
    assert.equal(JSON.stringify(prepared).includes(os.homedir()), false);
    assert.equal(JSON.stringify(prepared).includes(script), false);

    const sessions = await getModuleSessions("codex");
    assert.equal(sessions.sessions[0].sessionId, prepared.session.sessionId);
    assert.equal(sessions.sessions[0].status, "prepared");
    assert.equal(sessions.sessions[0].commandPreview, "codex <arg:1> <arg:2>");
    const logs = await getModuleLogs("codex");
    assert.ok(logs.logs.some((entry) => entry.message === "Module session start prepared"));
    assert.equal(JSON.stringify(logs).includes(script), false);
  });
});

test(
  "module CLI sessions start stop and expose sanitized output tails",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const script = path.join(dir, "codex");
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(script, [
      "#!/bin/sh",
      "echo session-start:$1",
      "echo session-secret:$2 >&2",
      "sleep 5",
      "echo session-end"
    ].join("\n"));
    await chmod(script, 0o755);
    const fakeKey = `${"sk"}-sessionbadbadbadbadbad`;
    await configureCliPath("codex", {
      CODEX_CLI_PATH: script,
      CODEX_WORKSPACE: workspace,
      CODEX_CLI_ARGS: "{{message}} {{prompt}}"
    });

    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
      const started = await startModuleSession("codex", {
        message: `hello ${os.homedir()}`,
        prompt: fakeKey,
        dryRun: false,
        timeoutMs: 10000
      });
      assert.equal(started.ok, true);
      assert.equal(started.mode, "executed");
      assert.equal(started.session.status, "running");
      assert.equal(started.session.dryRun, false);
      assert.ok(started.session.pid);
      assert.equal(JSON.stringify(started).includes(script), false);
      assert.equal(JSON.stringify(started).includes(workspace), false);

      const running = await waitFor(async () => {
        const current = await getModuleSession("codex", started.session.sessionId);
        return current.session.stdoutTail.includes("session-start") && current.session.stderrTail.includes("session-secret")
          ? current
          : null;
      }, { timeout: 2500 });
      assert.equal(JSON.stringify(running).includes(os.homedir()), false);
      assert.equal(JSON.stringify(running).includes(fakeKey), false);
      assert.equal(JSON.stringify(running).includes(script), false);
      assert.equal(JSON.stringify(running).includes(workspace), false);

      const stopped = await stopModuleSession("codex", started.session.sessionId);
      assert.ok(["stopping", "stopped"].includes(stopped.session.status));
      const final = await waitFor(async () => {
        const current = await getModuleSession("codex", started.session.sessionId);
        return ["stopped", "completed", "error"].includes(current.session.status) ? current : null;
      }, { timeout: 3000 });
      assert.equal(final.session.status, "stopped");
      assert.equal(final.session.stopRequested, true);
      assert.equal(JSON.stringify(final).includes(os.homedir()), false);
      assert.equal(JSON.stringify(final).includes(fakeKey), false);
      const logs = await getModuleLogs("codex");
      assert.ok(logs.logs.some((entry) => entry.message === "Module session started"));
      assert.ok(logs.logs.some((entry) => entry.message === "Module session stop requested"));
    });
  });
});

test(
  "module CLI adapter blocks workspace overrides outside configured policy",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const script = path.join(dir, "codex");
    const workspace = path.join(dir, "workspace");
    const outside = path.join(dir, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(script, "#!/bin/sh\necho should-not-run\n");
    await chmod(script, 0o755);
    await configureCliPath("codex", { CODEX_CLI_PATH: script, CODEX_WORKSPACE: workspace });

    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
      const result = await runModule("codex", { message: "hello", workspace: outside, dryRun: false });
      assert.equal(result.ok, false);
      assert.equal(result.mode, "policy_violation");
      assert.match(result.reply, /outside the configured workspace policy/);
      assert.equal(JSON.stringify(result).includes(outside), false);
    });
  });
});

test("OS audit lists module fixes without leaking local paths", async () => {
  await withTempRuntime(async () => {
    const audit = await getOsAudit();
    assert.equal(audit.summary.total > 0, true);
    assert.ok(audit.items.find((item) => item.id === "firecrawl-builder"));
    assert.ok(audit.items.every((item) => ["ok", "setup", "action_required"].includes(item.severity)));
    const builderFix = audit.items.find((item) => item.id === "firecrawl-builder")?.fix || "";
    assert.match(builderFix, /NEXT_PUBLIC_CONVEX_URL/);
    assert.doesNotMatch(builderFix, /ANTHROPIC_API_KEY/);
    assert.equal(JSON.stringify(audit).includes(os.homedir()), false);
  });
});

test("Agent OS normalizes visual workflows to Codex API intelligence and a Hermes runtime", () => {
  const workflow = normalizeWorkflow({
    id: "Instagram Agent",
    name: "Instagram Agent",
    nodes: [
      { id: "trigger", type: "schedule", label: "Every morning" },
      { id: "research", type: "research", label: "Research trends", prompt: "Find five AI reel ideas" },
      { id: "approval", type: "approval", label: "Ask me" }
    ]
  }, "Research Instagram trends every morning and ask me to approve them.");
  assert.equal(workflow.id, "instagram-agent");
  assert.equal(workflow.engine, "codex-api");
  assert.equal(workflow.runtime, "hermes");
  assert.equal(workflow.nodes[0].type, "start");
  assert.equal(workflow.nodes.find((node) => node.id === "research")?.moduleId, "codex-api");
  assert.equal(workflow.nodes.find((node) => node.id === "research")?.dryRun, false);
  assert.equal(workflow.nodes.at(-1)?.type, "end");
  assert.equal(workflow.edges.length, workflow.nodes.length - 1);
});

test("Agent OS prompt builder uses the OpenAI Responses API and saves its workflow", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/v1/models/gpt-5.3-codex") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ id: "gpt-5.3-codex", owned_by: "openai" }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/responses") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const request = JSON.parse(raw);
          assert.equal(request.model, "gpt-5.3-codex");
          assert.equal(request.store, false);
          assert.equal(request.text.format.type, "json_schema");
          assert.equal(request.text.format.strict, true);
          const workflow = {
            name: "Competitor Reel Research",
            description: "Research three competitor reels and ask for approval.",
            runtime: "hermes",
            nodes: [
              { id: "start", type: "start", label: "Every morning", prompt: "", trigger: "schedule", condition: "", position: { x: 70, y: 240 } },
              { id: "research", type: "agent", label: "Research reels", prompt: "Research three competitor reels.", trigger: "", condition: "", position: { x: 330, y: 240 } },
              { id: "approve", type: "user_approval", label: "Approve best idea", prompt: "", trigger: "", condition: "", position: { x: 590, y: 240 } },
              { id: "finish", type: "end", label: "Finish", prompt: "", trigger: "", condition: "", position: { x: 850, y: 240 } }
            ],
            edges: [
              { id: "start-research", source: "start", target: "research", label: "" },
              { id: "research-approve", source: "research", target: "approve", label: "" },
              { id: "approve-finish", source: "approve", target: "finish", label: "" }
            ]
          };
          res.setHeader("Content-Type", "application/json");
          res.setHeader("x-request-id", "req-agent-os-test");
          res.end(JSON.stringify({ id: "resp-agent-os-test", model: "gpt-5.3-codex", output_text: JSON.stringify(workflow), usage: { input_tokens: 100, output_tokens: 200 } }));
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      }, async (baseUrl) => {
        await configureConnection("provider-openai", {
          OPENAI_API_KEY: "placeholder-openai-key",
          AGENT_OS_CODEX_MODEL: "gpt-5.3-codex",
          AGENT_OS_OPENAI_BASE_URL: `${baseUrl}/v1`
        });
        const status = await getCodexApiStatus();
        assert.equal(status.configured, true);
        const health = await testCodexApi();
        assert.equal(health.status, "connected");
        const result = await generateAgentWorkflow({
          prompt: "Research three competitor reels and ask me to approve the best idea."
        });
        assert.equal(result.ok, true);
        assert.equal(result.poweredBy, "codex-api");
        assert.equal(result.generationMode, "codex-api");
        assert.equal(result.workflow.runtime, "hermes");
        assert.ok(result.workflow.nodes.some((node) => node.type === "agent" && node.moduleId === "codex-api"));
        assert.equal(JSON.stringify(result).includes("placeholder-openai-key"), false);
        assert.ok(await getWorkflow(result.workflow.id));
        const removed = await deleteWorkflow(result.workflow.id);
        assert.equal(removed.ok, true);
        assert.equal(await getWorkflow(result.workflow.id), null);
      });
    });
  });
});

test("Agent OS native builder default is blank and runtime-ready", async () => {
  await withTempRuntime(async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const workflows = await listWorkflows();
    assert.ok(workflows.find((workflow) => workflow.id === "blank-open-agent-builder"));
    assert.equal(workflows.find((workflow) => workflow.id === "sample-lead-intake"), undefined);
    const workflow = await getWorkflow("blank-open-agent-builder");
    assert.equal(workflow.name, "Blank Agent OS Workflow");
    assert.equal(workflow.source, "agent-os-native-builder");
    assert.equal(workflow.engine, "codex-api");
    assert.equal(workflow.runtime, "hermes");
    assert.deepEqual(workflow.nodes.map((node) => node.label), ["Start"]);
    const run = await runWorkflow("blank-open-agent-builder", { trigger: "test" });
    assert.equal(run.status, "completed");
  });
});

test("Agent OS starts empty and a user workflow can be saved, reopened, run, and deleted", async () => {
  await withTempRuntime(async () => {
    const workflows = await listWorkflows();
    assert.deepEqual(workflows.map((workflow) => workflow.id), ["blank-open-agent-builder"]);
    assert.equal(workflows.some((workflow) => workflow.starter), false);

    const saved = await saveWorkflow({
      id: "my-first-workflow",
      name: "My First Workflow",
      description: "A user-created workflow from the empty builder.",
      runtime: "hermes",
      draft: true,
      nodes: [
        { id: "start", type: "start", label: "Start" },
        { id: "prepare", type: "transform", label: "Prepare data", mapping: "input -> output" },
        { id: "finish", type: "end", label: "Finish" }
      ],
      edges: [
        { id: "start-prepare", source: "start", target: "prepare" },
        { id: "prepare-finish", source: "prepare", target: "finish" }
      ]
    });
    assert.equal(saved.id, "my-first-workflow");

    const reopened = await getWorkflow("my-first-workflow");
    assert.equal(reopened.name, "My First Workflow");
    assert.deepEqual(reopened.nodes.map((node) => node.type), ["start", "transform", "end"]);

    const run = await runWorkflow("my-first-workflow", { trigger: "test", executionMode: "preview" });
    assert.equal(run.status, "completed");
    assert.equal(run.nodeRuns.length, 3);

    const afterSave = await listWorkflows();
    assert.equal(afterSave.some((workflow) => workflow.id === "my-first-workflow"), true);
    assert.equal(afterSave.find((workflow) => workflow.id === "my-first-workflow")?.runCount, 1);

    const deleted = await deleteWorkflow("my-first-workflow");
    assert.equal(deleted.ok, true);
    const afterDelete = await listWorkflows();
    assert.deepEqual(afterDelete.map((workflow) => workflow.id), ["blank-open-agent-builder"]);
  });
});

test("Codex API refuses to fake a result when no OpenAI API key is configured", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const status = await getCodexApiStatus();
      assert.equal(status.configured, false);
      assert.equal(status.timeoutMs, 90000);
      await assert.rejects(
        () => runCodexApi({ prompt: "Build a workflow" }),
        (error) => error?.status === 412 && error?.code === "CODEX_API_NOT_CONFIGURED"
      );
    });
  });
});

test("AI API guide exposes all ten upstream projects and health-tests saved gateways", async () => {
  await withTempRuntime(async () => {
    const expected = [
      "omniroute",
      "cliproxyapi",
      "free-llm-gateway",
      "gpt4free",
      "new-api",
      "pollinations",
      "ollama",
      "localai",
      "llama-cpp",
      "awesome-free-llm-apis"
    ];
    const initial = await listApiIntegrations();
    assert.deepEqual(initial.integrations.map((item) => item.id), expected);
    assert.equal(initial.integrations.find((item) => item.id === "awesome-free-llm-apis")?.connectable, false);
    assert.equal(initial.integrations.every((item) => item.repoUrl.startsWith("https://github.com/")), true);

    await withHttpServer((req, res) => {
      assert.equal(req.url, "/v1/models");
      assert.equal(req.headers.authorization, "Bearer placeholder-gateway-key");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "auto" }, { id: "free-model" }] }));
    }, async (baseUrl) => {
      const configured = await configureApiIntegration("omniroute", {
        BASE_URL: `${baseUrl}/v1`,
        MODEL: "auto",
        API_KEY: "placeholder-gateway-key"
      });
      assert.equal(configured.ok, true);
      assert.equal(JSON.stringify(configured).includes("placeholder-gateway-key"), false);
      const tested = await testApiIntegration("omniroute");
      assert.equal(tested.status, "connected");
      assert.deepEqual(tested.models, ["auto", "free-model"]);
      const updated = await listApiIntegrations();
      const omniRoute = updated.integrations.find((item) => item.id === "omniroute");
      assert.equal(omniRoute?.configured, true);
      assert.equal(omniRoute?.hasApiKey, true);
      assert.equal(JSON.stringify(updated).includes("placeholder-gateway-key"), false);
    });

    await assert.rejects(
      () => testApiIntegration("awesome-free-llm-apis"),
      (error) => error?.status === 400
    );
  });
});

test("workflow agent nodes route through the provider router and record usage", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      await saveWorkflow({
        id: "router-workflow",
        name: "Router workflow",
        draft: true,
        nodes: [
          { id: "start", type: "start", label: "Start" },
          {
            id: "router-agent",
            type: "agent",
            label: "Router Agent",
            moduleId: "provider-router",
            provider: "openrouter",
            prompt: "Summarize workflow status"
          }
        ],
        edges: []
      });

      const run = await runWorkflow("router-workflow", { trigger: "test" });
      assert.equal(run.status, "completed");
      const routerNode = run.nodeRuns.find((node) => node.nodeId === "router-agent");
      assert.equal(routerNode?.status, "completed");
      assert.equal(routerNode?.output.provider, "openrouter");

      const usage = await getUsageState();
      assert.equal(usage.items.length, 1);
      assert.equal(usage.items[0].provider, "openrouter");
      assert.equal(JSON.stringify(run).includes("placeholder-openrouter-key"), false);
    });
  });
});

test(
  "workflow agent nodes retry failed CLI executions",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const script = path.join(dir, "codex");
    await writeFile(script, "#!/bin/sh\nexit 2\n");
    await chmod(script, 0o755);
    await configureCliPath("codex", { CODEX_CLI_PATH: script });

    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
      await saveWorkflow({
        id: "retry-workflow",
        name: "Retry workflow",
        draft: true,
        nodes: [
          {
            id: "codex",
            type: "agent",
            label: "Failing Codex",
            moduleId: "codex",
            prompt: "Try this",
            maxRetries: 2
          }
        ],
        edges: []
      });

      const run = await runWorkflow("retry-workflow", { dryRun: false });
      assert.equal(run.status, "failed");
      const attempts = run.nodeRuns.filter((node) => node.nodeId === "codex");
      assert.equal(attempts.length, 3);
      assert.deepEqual(attempts.map((node) => node.attempt), [1, 2, 3]);
      assert.equal(attempts[1].retry, true);
      assert.equal(attempts[2].status, "failed");
    });
  });
});

test(
  "native OpenClaw workflows execute the official one-shot CLI shape behind the trusted gate",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const cli = path.join(dir, "openclaw");
    await writeExecutable(cli, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    await configureCliPath("openclaw", { OPENCLAW_CLI_PATH: cli });
    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: null }, async () => {
      await setExecutionGateStatus({ enabled: true, reason: "native OpenClaw workflow test" });
      await saveWorkflow({
        id: "native-openclaw-workflow",
        name: "Native OpenClaw workflow",
        runtime: "openclaw",
        nodes: [
          { id: "start", type: "start", label: "Start" },
          { id: "agent", type: "agent", label: "OpenClaw agent", moduleId: "codex-api", prompt: "Prepare the launch checklist" },
          { id: "end", type: "end", label: "Finish" }
        ],
        edges: []
      });
      const run = await runWorkflow("native-openclaw-workflow", { executionMode: "native" });
      assert.equal(run.status, "completed");
      const agent = run.nodeRuns.find((node) => node.nodeId === "agent");
      assert.equal(agent?.output.runtime, "openclaw");
      assert.equal(agent?.output.executionMode, "native");
      assert.match(agent?.output.reply || "", /agent\n--message\nPrepare the launch checklist\n--thinking\nhigh/);
    });
  });
});

test("workflow user approval nodes pause and resume", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "approval-workflow",
      name: "Approval workflow",
      draft: true,
      nodes: [
        { id: "start", type: "start", label: "Start" },
        { id: "approval", type: "user_approval", label: "Human approval" },
        { id: "after", type: "transform", label: "After approval" }
      ],
      edges: []
    });

    const paused = await runWorkflow("approval-workflow", { trigger: "test" });
    assert.equal(paused.status, "waiting_for_approval");
    assert.equal(paused.nodeRuns.some((node) => node.nodeId === "after"), false);
    const waitingNode = paused.nodeRuns.find((node) => node.nodeId === "approval");
    assert.ok(waitingNode?.output.kanbanCardId);

    let kanban = await getSelfModuleState("kanban");
    let approvalCard = kanban.items.find((item) => item.workflowId === "approval-workflow" && item.runId === paused.id && item.nodeId === "approval");
    assert.equal(approvalCard?.sourceType, "workflow_approval");
    assert.equal(approvalCard?.approvalStatus, "pending");
    assert.equal(approvalCard?.column, "review");

    const resumed = await resumeWorkflowRun("approval-workflow", paused.id, {});
    assert.equal(resumed.status, "completed");
    assert.ok(resumed.nodeRuns.find((node) => node.nodeId === "approval" && node.status === "completed"));
    assert.ok(resumed.nodeRuns.find((node) => node.nodeId === "after" && node.status === "completed"));
    kanban = await getSelfModuleState("kanban");
    approvalCard = kanban.items.find((item) => item.workflowId === "approval-workflow" && item.runId === paused.id && item.nodeId === "approval");
    assert.equal(approvalCard?.approvalStatus, "approved");
    assert.equal(approvalCard?.column, "done");
  });
});

test("workflow Kanban tool nodes create source-linked task cards", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "kanban-tool-workflow",
      name: "Kanban tool workflow",
      draft: true,
      nodes: [
        {
          id: "kanban-task",
          type: "mcp_tool",
          label: "Create Kanban Task",
          moduleId: "kanban",
          tool: "create_card",
          title: "Review generated plan",
          column: "review",
          priority: "high",
          notes: "Generated by workflow tool node."
        }
      ],
      edges: []
    });

    const run = await runWorkflow("kanban-tool-workflow", { trigger: "test" });
    assert.equal(run.status, "completed");
    const node = run.nodeRuns.find((item) => item.nodeId === "kanban-task");
    assert.equal(node?.status, "completed");
    assert.equal(node?.output.moduleId, "kanban");

    const kanban = await getSelfModuleState("kanban");
    assert.equal(kanban.items.length, 1);
    assert.equal(kanban.items[0].title, "Review generated plan");
    assert.equal(kanban.items[0].sourceType, "workflow_task");
    assert.equal(kanban.items[0].workflowId, "kanban-tool-workflow");
    assert.equal(kanban.items[0].runId, run.id);
    assert.equal(kanban.items[0].nodeId, "kanban-task");
    assert.equal(kanban.summary.kanban.workflowCards, 1);
  });
});

test("workflow MCP tool nodes route through the OS module registry", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "tool-workflow",
      name: "Tool workflow",
      draft: true,
      nodes: [
        {
          id: "goal-tool",
          type: "mcp_tool",
          label: "Goal Tool",
          moduleId: "goals",
          tool: "create_goal"
        }
      ],
      edges: []
    });

    const run = await runWorkflow("tool-workflow", { trigger: "test" });
    assert.equal(run.status, "completed");
    const node = run.nodeRuns.find((item) => item.nodeId === "goal-tool");
    assert.equal(node?.status, "completed");
    assert.equal(node?.output.moduleId, "goals");

    const logs = await getModuleLogs("workflows");
    assert.ok(logs.logs.some((entry) => entry.message === "Workflow run created"));
  });
});

test("workflow graph edges route branches and record replayable events", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "branch-graph",
      name: "Branch graph",
      draft: true,
      nodes: [
        { id: "start", type: "start", label: "Start" },
        { id: "lead-check", type: "if_else", label: "Lead Check" },
        { id: "hot-path", type: "transform", label: "Hot Path" },
        { id: "cold-path", type: "transform", label: "Cold Path" },
        { id: "end", type: "end", label: "End" }
      ],
      edges: [
        { id: "start-check", source: "start", target: "lead-check" },
        { id: "hot-edge", source: "lead-check", target: "hot-path", label: "Hot" },
        { id: "cold-edge", source: "lead-check", target: "cold-path", label: "Not hot" },
        { id: "hot-end", source: "hot-path", target: "end" },
        { id: "cold-end", source: "cold-path", target: "end" }
      ]
    });

    const run = await runWorkflow("branch-graph", { branches: { "lead-check": "Hot" } });
    assert.equal(run.status, "completed");
    assert.equal(run.graph.mode, "edge_traversal");
    assert.ok(run.nodeRuns.find((node) => node.nodeId === "hot-path"));
    assert.equal(run.nodeRuns.find((node) => node.nodeId === "cold-path"), undefined);
    assert.ok(run.traversedEdges.find((edge) => edge.id === "hot-edge"));
    assert.ok(run.events.some((event) => event.type === "edge_traversed"));

    const replay = await getWorkflowRunEvents("branch-graph", run.id);
    assert.equal(replay.eventCount, run.events.length);
    assert.ok(replay.events.some((event) => event.type === "run_completed"));
    assert.equal(JSON.stringify(replay).includes(os.homedir()), false);
  });
});

test("workflow graph fans out non-routing nodes into replayable parallel branches", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "parallel-graph",
      name: "Parallel graph",
      draft: true,
      nodes: [
        { id: "start", type: "start", label: "Start" },
        { id: "seo", type: "transform", label: "SEO branch" },
        { id: "video", type: "transform", label: "Video branch" },
        { id: "seo-end", type: "end", label: "SEO end" },
        { id: "video-end", type: "end", label: "Video end" }
      ],
      edges: [
        { id: "start-seo", source: "start", target: "seo" },
        { id: "start-video", source: "start", target: "video" },
        { id: "seo-end-edge", source: "seo", target: "seo-end" },
        { id: "video-end-edge", source: "video", target: "video-end" }
      ]
    });

    const run = await runWorkflow("parallel-graph", {});
    assert.equal(run.status, "completed");
    assert.equal(run.graph.mode, "parallel_edge_traversal");
    assert.equal(run.graph.parallelGroups.length, 1);
    assert.equal(run.graph.parallelGroups[0].edgeIds.length, 2);
    assert.ok(run.nodeRuns.find((node) => node.nodeId === "seo" && node.branchId));
    assert.ok(run.nodeRuns.find((node) => node.nodeId === "video" && node.branchId));
    assert.notEqual(
      run.nodeRuns.find((node) => node.nodeId === "seo")?.branchId,
      run.nodeRuns.find((node) => node.nodeId === "video")?.branchId
    );
    assert.ok(run.traversedEdges.find((edge) => edge.id === "start-seo" && edge.parallelGroupId));
    assert.ok(run.traversedEdges.find((edge) => edge.id === "start-video" && edge.parallelGroupId));
    assert.ok(run.events.some((event) => event.type === "parallel_group_started"));
    assert.ok(run.events.some((event) => event.type === "parallel_group_completed"));

    const replay = await getWorkflowRunEvents("parallel-graph", run.id);
    assert.ok(replay.events.some((event) => event.parallelGroupId === run.graph.parallelGroups[0].id));
    assert.equal(JSON.stringify(replay).includes(os.homedir()), false);
  });
});

test("workflow replay API maps saved graph nodes and edges to run status", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "visual-replay-graph",
      name: "Visual Replay Graph",
      draft: true,
      nodes: [
        { id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } },
        { id: "research", type: "transform", label: "Research", position: { x: 260, y: 0 } },
        { id: "write", type: "transform", label: "Write", position: { x: 520, y: 0 } },
        { id: "end", type: "end", label: "End", position: { x: 780, y: 0 } }
      ],
      edges: [
        { id: "start-research", source: "start", target: "research" },
        { id: "research-write", source: "research", target: "write" },
        { id: "write-end", source: "write", target: "end" }
      ]
    });

    const run = await runWorkflow("visual-replay-graph", {});
    const replay = await getWorkflowRunReplay("visual-replay-graph", run.id);
    assert.equal(replay.status, "completed");
    assert.equal(replay.summary.nodes, 4);
    assert.equal(replay.summary.completedNodes, 4);
    assert.equal(replay.summary.traversedEdges, 3);
    assert.equal(replay.nodes.find((node) => node.id === "research")?.status, "completed");
    assert.equal(replay.nodes.find((node) => node.id === "research")?.position.x, 260);
    assert.equal(replay.edges.find((edge) => edge.id === "research-write")?.status, "traversed");
    assert.equal(JSON.stringify(replay).includes(os.homedir()), false);

    const overlay = await getBuilderReplayOverlay("visual-replay-graph", run.id);
    assert.equal(overlay.id, "builder-replay-overlay");
    assert.equal(overlay.overlayMode, "dom-anchor-with-coordinate-fallback");
    assert.equal(overlay.summary.traversedEdges, 3);
    assert.ok(overlay.selectors.includes(".react-flow__node"));
    assert.equal(JSON.stringify(overlay).includes(os.homedir()), false);

    const overlayUrl = builderReplayOverlayUrl({ workflowId: "visual-replay-graph", runId: run.id });
    assert.match(overlayUrl, /hermesReplay=1/);
    assert.match(overlayUrl, /hermesWorkflowId=visual-replay-graph/);
    assert.match(overlayUrl, new RegExp(`hermesRunId=${run.id}`));

    const injected = injectBuilderReplayOverlay("<html><body><main>builder</main></body></html>");
    assert.match(injected, /hermes-replay-overlay-bootstrap/);
    assert.ok(injected.includes("/api/builder/replay-overlay"));
    assert.match(injected, /react-flow__node/);
  });
});

test("workflow graph while loops respect iteration and max-step guards", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "loop-graph",
      name: "Loop graph",
      draft: true,
      nodes: [
        { id: "start", type: "start", label: "Start" },
        { id: "while", type: "while_loop", label: "While", maxIterations: 2 },
        { id: "body", type: "transform", label: "Loop body" },
        { id: "end", type: "end", label: "End" }
      ],
      edges: [
        { id: "start-while", source: "start", target: "while" },
        { id: "while-body", source: "while", target: "body", label: "loop" },
        { id: "body-while", source: "body", target: "while" },
        { id: "while-end", source: "while", target: "end", label: "done" }
      ]
    });

    const run = await runWorkflow("loop-graph", {});
    assert.equal(run.status, "completed");
    assert.equal(run.nodeRuns.filter((node) => node.nodeId === "body").length, 2);
    assert.equal(run.nodeRuns.filter((node) => node.nodeId === "while").length, 3);
    assert.ok(run.traversedEdges.find((edge) => edge.id === "while-end"));

    await saveWorkflow({
      id: "guarded-loop",
      name: "Guarded loop",
      draft: true,
      maxSteps: 3,
      nodes: [
        { id: "while", type: "while_loop", label: "While", maxIterations: 20 }
      ],
      edges: [
        { id: "self-loop", source: "while", target: "while", label: "loop" }
      ]
    });
    const guarded = await runWorkflow("guarded-loop", {});
    assert.equal(guarded.status, "failed");
    assert.ok(guarded.events.some((event) => event.type === "loop_guard_triggered"));
  });
});

test("builder status points at vendored upstream source without local secrets", async () => {
  const status = await getBuilderStatus();
  assert.equal(status.source, "vendor/open-agent-builder");
  assert.equal(status.upstream, "https://github.com/firecrawl/open-agent-builder");
  assert.equal(status.upstreamFilePresent, true);
  assert.ok(status.supervisor);
  assert.ok(Array.isArray(status.diagnostics.required));
  assert.equal(JSON.stringify(status).includes(os.homedir()), false);
});

test("builder bootstrap prepares dry-run setup without leaking local data", async () => {
  await withTempRuntime(async () => {
    await withEnv(
      {
        HERMES_AGENT_OS_ENABLE_INSTALL: null,
        NEXT_PUBLIC_CONVEX_URL: null,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: null,
        CLERK_SECRET_KEY: null,
        CLERK_JWT_ISSUER_DOMAIN: null,
        FIRECRAWL_API_KEY: null,
        OPENAI_API_KEY: null,
        ANTHROPIC_API_KEY: null,
        GEMINI_API_KEY: null,
        GROQ_API_KEY: null
      },
      async () => {
        const bootstrap = await getBuilderBootstrap();
        assert.equal(bootstrap.id, "firecrawl-builder-bootstrap");
        assert.ok(bootstrap.steps.find((step) => step.id === "convex"));
        assert.ok(bootstrap.steps.find((step) => step.id === "clerk"));
        assert.ok(bootstrap.commands.find((command) => command.id === "create-convex-project"));
        assert.ok(bootstrap.requiredMissing.includes("NEXT_PUBLIC_CONVEX_URL"));
        assert.equal(JSON.stringify(bootstrap).includes(os.homedir()), false);

        const prepared = await prepareBuilderBootstrap({ execute: true, installDependencies: true });
        assert.equal(prepared.ok, true);
        assert.equal(prepared.mode, "dry_run");
        assert.equal(prepared.executed, false);
        assert.ok(prepared.nextSteps.length);
        assert.equal(JSON.stringify(prepared).includes(os.homedir()), false);
      }
    );
  });
});

test("builder smoke test reports credential readiness without exposing secrets", async () => {
  await withTempRuntime(async () => {
    await withEnv(
      {
        NEXT_PUBLIC_CONVEX_URL: null,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: null,
        CLERK_SECRET_KEY: null,
        CLERK_JWT_ISSUER_DOMAIN: null,
        FIRECRAWL_API_KEY: null,
        OPENAI_API_KEY: null,
        ANTHROPIC_API_KEY: null,
        GEMINI_API_KEY: null,
        GROQ_API_KEY: null
      },
      async () => {
        let smoke = await runBuilderSmokeTest();
        assert.equal(smoke.status, "setup_required");
        assert.equal(typeof smoke.ok, "boolean");
        assert.equal(typeof smoke.readyToBoot, "boolean");
        assert.equal(smoke.checks.find((check) => check.id === "convex")?.status, "failed");
        assert.equal(smoke.checks.find((check) => check.id === "clerk")?.status, "failed");

        await configureConnection("provider-convex", { NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud" });
        await configureConnection("provider-clerk", {
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
          CLERK_SECRET_KEY: "placeholder-clerk-secret",
          CLERK_JWT_ISSUER_DOMAIN: "https://example.clerk.accounts.dev"
        });
        await configureConnection("provider-firecrawl", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
        await configureConnection("provider-openai", { OPENAI_API_KEY: "placeholder-openai-key" });

        smoke = await runBuilderSmokeTest();
        assert.equal(smoke.checks.find((check) => check.id === "convex")?.status, "passed");
        assert.equal(smoke.checks.find((check) => check.id === "clerk")?.status, "passed");
        assert.equal(smoke.checks.find((check) => check.id === "firecrawl")?.status, "passed");
        assert.equal(smoke.checks.find((check) => check.id === "llm")?.status, "passed");
        assert.equal(JSON.stringify(smoke).includes("placeholder-clerk-secret"), false);
        assert.equal(JSON.stringify(smoke).includes(os.homedir()), false);
      }
    );
  });
});

test("builder supervisor blocks unsafe starts and reports provider-card diagnostics", async () => {
  await withTempRuntime(async () => {
    await assert.rejects(() => startBuilderSupervisor(), /Builder is not ready to boot/);
    let logs = await getBuilderLogs();
    assert.ok(logs.logs.some((entry) => entry.message.includes("start blocked")));

    await configureConnection("provider-convex", { NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud" });
    await configureConnection("provider-clerk", {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
      CLERK_SECRET_KEY: "placeholder-clerk-secret",
      CLERK_JWT_ISSUER_DOMAIN: "https://example.clerk.accounts.dev"
    });
    await configureConnection("provider-firecrawl", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
    const status = await getBuilderStatus();
    if (!status.dependenciesInstalled) {
      assert.equal(status.readyToBoot, false);
      assert.equal(status.status, "needs_install");
    } else {
      assert.equal(status.readyToBoot, true);
      assert.equal(status.diagnostics.missingRequired.length, 0);
    }
    assert.equal(status.diagnostics.firecrawlConfigured, true);
    assert.equal(JSON.stringify(status).includes("placeholder-clerk-secret"), false);

    logs = await getBuilderLogs();
    assert.equal(JSON.stringify(logs).includes(os.homedir()), false);
  });
});

test("builder supervisor can start stop and sanitize managed process logs", async (t) => {
  await withTempRuntime(async (dir) => {
    const baseline = await getBuilderStatus();
    if (!baseline.dependenciesInstalled) {
      t.skip("Open Agent Builder dependencies are not installed in this checkout.");
      return;
    }
    const script = path.join(dir, "builder-supervisor-test.js");
    const fakeKey = `${"sk"}-testbadbadbadbadbadbadbad`;
    await writeFile(
      script,
      `console.log('builder test ready OPENAI_API_KEY=${fakeKey}'); setInterval(() => {}, 1000);\n`
    );
    await configureConnection("provider-convex", { NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud" });
    await configureConnection("provider-clerk", {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
      CLERK_SECRET_KEY: "placeholder-clerk-secret",
      CLERK_JWT_ISSUER_DOMAIN: "https://example.clerk.accounts.dev"
    });
    await withEnv(
      {
        HERMES_BUILDER_SUPERVISOR_COMMAND: process.execPath,
        HERMES_BUILDER_SUPERVISOR_ARGS: script
      },
      async () => {
        const started = await startBuilderSupervisor();
        assert.ok(["starting", "running"].includes(started.supervisor.state));
        assert.ok(started.supervisor.pid);
        await new Promise((resolve) => setTimeout(resolve, 150));

        const logs = await getBuilderLogs();
        assert.ok(logs.logs.some((entry) => entry.message.includes("builder test ready")));
        assert.equal(JSON.stringify(logs).includes(fakeKey), false);
        assert.equal(JSON.stringify(logs).includes(os.homedir()), false);

        const stopped = await stopBuilderSupervisor();
        assert.ok(["stopping", "stopped"].includes(stopped.supervisor.state));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const afterStop = await getBuilderStatus();
        assert.equal(afterStop.supervisor.state, "stopped");
      }
    );
  });
});

test("connections return templates without secret values", async () => {
  await withTempRuntime(async () => {
    const connections = await getConnections();
    assert.ok(connections.templates.find((template) => template.id === "firecrawl-builder"));
    assert.ok(connections.templates.find((template) => template.id === "provider-anthropic"));
    assert.ok(connections.templates.find((template) => template.id === "provider-clerk"));
    assert.equal(JSON.stringify(connections).includes("sk-"), false);
  });
});

test(
  "connection saves are reflected by the module registry for dashboard control rooms",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const cli = path.join(dir, "codex");
    await writeExecutable(cli, "#!/bin/sh\necho codex-dashboard-config\n");
    await configureCliPath("codex", { CODEX_CLI_PATH: cli });
    const modules = await getModules();
    const codex = modules.find((module) => module.id === "codex");
    assert.equal(codex?.status, "connected");
    assert.equal(codex?.configured, true);
    assert.equal(JSON.stringify(codex).includes(cli), false);
    assert.equal(JSON.stringify(codex).includes(os.homedir()), false);
  });
});

test("MiniMax visible card has its own dashboard connection template", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const connections = await getConnections();
      const template = connections.templates.find((item) => item.id === "minimax");
      assert.ok(template);
      assert.ok(template.fields.includes("MINIMAX_API_KEY"));

      await withHttpServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "test invalid key" }));
      }, async (baseUrl) => {
        await configureConnection("minimax", {
          MINIMAX_API_KEY: "placeholder-minimax-key",
          HERMES_MINIMAX_HEALTH_URL: baseUrl
        });
        const modules = await getModules();
        const direct = modules.find((module) => module.id === "minimax");
        assert.equal(direct?.status, "ready_to_configure");
        assert.equal(direct?.stats.requiredConfigPresent, true);
        assert.equal(JSON.stringify(direct).includes("placeholder-minimax-key"), false);
      });
    });
  });
});

test("export audit catches secrets and local paths", async () => {
  await withTempRuntime(async (dir) => {
    const file = path.join(dir, "bad.txt");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(file, `OPENAI_API_KEY=${"sk"}-testbadbadbadbad\n${os.homedir()}\n`)
    );
    const audit = await auditExportDirectory(dir);
    assert.equal(audit.ok, false);
    assert.ok(audit.findings.length >= 2);

    const goodDir = path.join(dir, "ordinary-workflow-ids");
    await mkdir(goodDir, { recursive: true });
    await writeFile(path.join(goodDir, "workflow.json"), JSON.stringify({
      edges: ["edge-risk-review-risk-gate", "edge-incident-task-incident-end"]
    }));
    const goodAudit = await auditExportDirectory(goodDir);
    assert.equal(goodAudit.ok, true);
  });
});

test("Docker deployment artifacts are present and use persistent runtime storage", async () => {
  const root = process.cwd();
  await access(path.join(root, "Dockerfile"));
  await access(path.join(root, "docker-compose.yml"));
  await access(path.join(root, ".dockerignore"));
  await access(path.join(root, "scripts", "docker-smoke.js"));
  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
  const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");
  const dockerignore = await readFile(path.join(root, ".dockerignore"), "utf8");
  const smoke = await readFile(path.join(root, "scripts", "docker-smoke.js"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.match(dockerfile, /EXPOSE 8090/);
  assert.match(compose, /(?:8090|\$\{PORT:-8090\}):8090/);
  assert.match(smoke, /PORT=8090/);
  assert.doesNotMatch(dockerfile, /EXPOSE 4173/);
  assert.doesNotMatch(compose, /4173/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(compose, /hermes-agent-os-data/);
  assert.match(compose, /HERMES_AGENT_OS_PUBLIC_MODE/);
  assert.match(dockerignore, /\*\*\/node_modules/);
  assert.match(dockerignore, /\*\*\/\.next/);
  assert.equal(pkg.scripts["smoke:docker"], "node scripts/docker-smoke.js");
  assert.match(smoke, /HERMES_DOCKER_SMOKE_TIMEOUT_MS \|\| 600000/);
  assert.match(smoke, /const buildArgs = \["build", "-t", image\]/);
  assert.match(smoke, /await run\("docker", buildArgs/);
  assert.match(smoke, /type=volume,source=\$\{volume\},target=\/data\/hermes-agent-os/);
  assert.match(smoke, /\/api\/health/);
  assert.match(smoke, /\/api\/os\/kernel/);
  assert.match(smoke, /\/api\/modules/);
  assert.match(smoke, /HERMES_AGENT_OS_ENABLE_EXEC=0/);
  assert.match(smoke, /HERMES_DOCKER_SMOKE_REQUIRED/);
});
