// Part 1 of 3 (SP4 sweep B): this file used to hold all 149 tests of the runtime modules. Alone it took 40 s, and
// with twenty copies of it running at once 99 to 137 s of the 180 s limit a test file has, so its later tests
// moved to test/runtime-voice-gateway.test.js (voice control, the provider modules, Hermes and the Gateway) and
// test/runtime-cli-workflows.test.js (the Hermes task controls, module CLI sessions, workflows, the builder,
// connections and Docker). `node --test` runs the three side by side. The tests are unchanged, and each file
// has the same set-up below (a temp HOME and a PATH of system folders only, so no real agent is ever found).
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

test("module registry exposes every dashboard module with sanitized fields", async () => {
  await withTempRuntime(async () => {
    const modules = await getModules();
    const ids = modules.map((module) => module.id);
    for (const id of [
      "claude",
      "openclaw",
      "openclaude",
      "hermes",
      "gemini",
      "codex",
      "voice-control",
      "opencode",
      "provider-router",
      "scheduler",
      "memory",
      "skill-registry",
      "firecrawl-builder",
      "elizaos-runtime",
      "provider-anthropic",
      "provider-openai",
      "provider-gemini",
      "provider-openrouter",
      "provider-ollama",
      "provider-minimax",
      "provider-firecrawl",
      "provider-convex",
      "provider-clerk",
      "goals",
      "notebook",
      "kanban",
      "usage-credits",
      "seo",
      "video"
    ]) {
      assert.ok(ids.includes(id), `missing module ${id}`);
    }
    assert.equal(ids.includes("kernel"), false);
    assert.equal(ids.includes("seo"), true);
    assert.equal(ids.includes("video"), true);
    assert.equal(isParkedSelfModule("seo"), false);
    assert.equal(isParkedSelfModule("video"), false);
    assert.equal(isParkedSelfModule("goals"), false);
    assert.equal(isParkedSelfModule("kanban"), false);
    const parked = await getModules({ includeParked: true, includeInternal: true });
    assert.ok(parked.find((module) => module.id === "kernel"));
    assert.ok(parked.find((module) => module.id === "seo"));
    assert.ok(parked.find((module) => module.id === "video"));
	    for (const module of modules) {
	      assert.ok(module.publicSummary);
	      assert.equal(Object.hasOwn(module, "path"), false);
	      assert.equal(Object.hasOwn(module, "env"), false);
	      assert.ok(["connected", "ready_to_configure", "missing_dependency", "error", "disabled"].includes(module.status));
	    }
	    const codex = modules.find((module) => module.id === "codex");
	    const openclaude = modules.find((module) => module.id === "openclaude");
	    const hermes = modules.find((module) => module.id === "hermes");
	    const voice = modules.find((module) => module.id === "voice-control");
	    const gateway = modules.find((module) => module.id === "gateway");
	    const openai = modules.find((module) => module.id === "provider-openai");
	    const ollama = modules.find((module) => module.id === "provider-ollama");
	    const router = modules.find((module) => module.id === "provider-router");
	    const minimax = modules.find((module) => module.id === "minimax");
	    assert.equal(openclaude?.status, "missing_dependency");
	    assert.equal(ollama?.installCommand, "brew install ollama");
	    assert.ok(ollama?.actions.includes("install"));
	    assert.ok(openclaude?.actions.includes("run"));
	    assert.ok(openclaude?.actions.includes("sessions"));
	    assert.equal(minimax?.status, "ready_to_configure");
	    assert.ok(minimax?.actions.includes("run"));
	    assert.ok(minimax?.actions.includes("sessions"));
	    assert.ok(codex?.taskProfiles?.some((profile) => profile.id === "code-review"));
	    assert.ok(codex?.actions.includes("configure"));
	    assert.equal(voice?.type, "desktop_voice");
	    assert.ok(voice?.actions.includes("configure"));
	    assert.ok(voice?.actions.includes("run"));
	    assert.ok(voice?.taskProfiles?.some((profile) => profile.id === "open-chrome"));
	    assert.ok(gateway?.actions.includes("configure"));
	    assert.ok(gateway?.configKeys.includes("HERMES_CLI_PATH"));
	    assert.ok(hermes?.capabilities.includes("kanban-task-control"));
	    assert.ok(hermes?.actions.includes("configure"));
	    if (hermes?.profileCount) {
	      assert.ok(hermes.actions.includes("task-control"));
	      assert.ok(hermes.actions.includes("sessions"));
	    } else {
	      assert.ok(hermes.actions.includes("install"));
	      assert.equal(hermes.actions.includes("task-control"), false);
	    }
	    assert.ok(hermes?.taskProfiles?.some((profile) => profile.id === "dispatch-kanban-task" && profile.action === "task"));
	    assert.ok(hermes?.taskProfiles?.some((profile) => profile.id === "dispatch-goal-task" && profile.input?.goal === true));
	    assert.ok(hermes?.taskProfiles?.some((profile) => profile.id === "restart-gateway" && profile.action === "restart_gateway"));
	    assert.ok(openai?.taskProfiles?.some((profile) => profile.id === "model-routing-check"));
	    assert.ok(router?.taskProfiles?.some((profile) => profile.id === "model-routing-check"));
	    for (const id of ["claude", "openclaw", "gemini", "codex", "opencode"]) {
	      const agent = modules.find((module) => module.id === id);
	      assert.ok(agent?.actions.includes("configure"), `${id} must expose local dashboard configuration`);
	      assert.ok(agent?.actions.includes("run"), `${id} must expose dashboard runs`);
	      assert.ok(agent?.actions.includes("sessions"), `${id} must expose dashboard sessions`);
	    }
	    for (const module of [codex, hermes, openai, router]) {
	      assert.equal(JSON.stringify(module.taskProfiles).includes(os.homedir()), false);
	      assert.equal(JSON.stringify(module.taskProfiles).includes("API_KEY"), false);
	    }
	    for (const id of ["provider-openai", "provider-ollama", "provider-openrouter", "provider-anthropic", "provider-gemini", "provider-minimax"]) {
	      const provider = modules.find((module) => module.id === id);
	      assert.ok(provider, `missing provider nav module ${id}`);
	      assert.equal(provider.category, "provider");
	      assert.ok(provider.actions.includes("run"), `${id} must open a runnable provider control room`);
	      assert.ok(provider.actions.includes("sessions"), `${id} must expose provider sessions`);
	    }
	  });
	});

test("voice control runs through dashboard proof loop in dry-run mode", async () => {
  await withTempRuntime(async () => {
    const result = await runModule("voice-control", { message: "Hermes open Chrome" });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "dry_run");
    assert.equal(result.voice.plan.intent, "open_app");
    assert.equal(result.voice.actions[0].dryRun, true);
    assert.equal(result.proof.moduleId, "voice-control");
    assert.equal(result.proof.handoff.status, "planned");
    const handoff = result.handoff || result.proof.handoff;
    assert.ok(handoff.memoryId);
    assert.ok(handoff.kanbanCardId);

    const runs = await getModuleRuns("voice-control");
    assert.equal(runs.runs[0].runId, result.proof.runId);
    assert.equal(runs.runs[0].proof.handoff.memoryId, handoff.memoryId);
    const logs = await getModuleLogs("voice-control");
    assert.ok(logs.logs.some((entry) => entry.message === "Voice command planned"));
    assert.ok(logs.logs.some((entry) => entry.message === "Agent run handoff recorded"));
  });
});

test("kernel report exposes Agent OS subsystems with sanitized evidence", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const kernel = await getKernelStatus();
      assert.equal(kernel.id, "hermes-kernel");
      assert.ok(kernel.components.find((item) => item.id === "runtime-core"));
      assert.ok(kernel.components.find((item) => item.id === "module-registry"));
      assert.ok(kernel.components.find((item) => item.id === "scheduler"));
      assert.ok(kernel.components.find((item) => item.id === "memory"));
      assert.ok(kernel.components.find((item) => item.id === "memory")?.capabilities.includes("qdrant-remote-vector-index"));
      assert.ok(kernel.components.find((item) => item.id === "skill-registry"));
      assert.ok(kernel.components.find((item) => item.id === "provider-router"));
      assert.ok(kernel.components.find((item) => item.id === "workflow-engine"));
      assert.ok(kernel.components.find((item) => item.id === "kanban-handoffs"));
      assert.equal(Boolean(kernel.components.find((item) => item.id === "seo-automation")), false);
      assert.equal(Boolean(kernel.components.find((item) => item.id === "video-worker")), false);
      assert.equal(kernel.components.find((item) => item.id === "workflow-engine")?.status, "implemented");
      assert.equal(kernel.components.find((item) => item.id === "provider-router")?.status, "config_required");
      assert.ok(kernel.components.find((item) => item.id === "provider-router")?.capabilities.includes("ollama-model-inventory"));
      assert.ok(kernel.components.find((item) => item.id === "provider-router")?.evidence.includes("GET /api/setup/providers/ollama/models"));
      assert.ok(kernel.components.find((item) => item.id === "workflow-engine")?.capabilities.includes("parallel-fanout"));
      assert.ok(kernel.components.find((item) => item.id === "workflow-engine")?.capabilities.includes("parallel-replay"));
      assert.ok(kernel.components.find((item) => item.id === "workflow-engine")?.capabilities.includes("visual-replay"));
      assert.ok(kernel.components.find((item) => item.id === "workflow-engine")?.capabilities.includes("builder-replay-overlay"));
      assert.ok(kernel.components.find((item) => item.id === "workflow-engine")?.capabilities.includes("kanban-task-cards"));
      assert.ok(kernel.components.find((item) => item.id === "scheduler")?.capabilities.includes("kanban-approval-cards"));
      assert.equal(kernel.components.find((item) => item.id === "scheduler")?.capabilities.includes("seo-audit-action"), false);
      assert.ok(kernel.components.find((item) => item.id === "kanban-handoffs")?.capabilities.includes("workflow-approval-cards"));
      assert.ok(kernel.components.find((item) => item.id === "firecrawl-builder-adapter")?.capabilities.includes("replay-overlay"));
      assert.ok(kernel.components.find((item) => item.id === "firecrawl-builder-adapter")?.evidence.includes("GET /api/builder/replay-overlay"));
      assert.ok(kernel.components.find((item) => item.id === "usage-ledger")?.capabilities.includes("billing-import-preview"));
      assert.ok(kernel.components.find((item) => item.id === "usage-ledger")?.evidence.includes("POST /api/usage/import"));
      assert.ok(kernel.components.find((item) => item.id === "security-export")?.capabilities.includes("docker-smoke"));
      assert.ok(kernel.components.find((item) => item.id === "security-export")?.evidence.includes("npm run smoke:docker"));
      assert.ok(kernel.components.find((item) => item.id === "skill-registry")?.capabilities.includes("marketplace-feeds"));
      assert.ok(kernel.components.find((item) => item.id === "skill-registry")?.capabilities.includes("publisher-trust"));
      assert.ok(kernel.components.find((item) => item.id === "skill-registry")?.capabilities.includes("publisher-reputation"));
      assert.ok(kernel.components.find((item) => item.id === "skill-registry")?.capabilities.includes("publisher-allowlist"));
      assert.ok(kernel.components.find((item) => item.id === "skill-registry")?.capabilities.includes("signed-dependencies"));
      assert.ok(kernel.components.find((item) => item.id === "skill-registry")?.capabilities.includes("update-channels"));
      assert.ok(kernel.invariants.find((item) => item.id === "dry-run-first"));
      assert.equal(kernel.readiness.id, "agent-os-readiness");
      assert.ok(kernel.readiness.requirements.find((item) => item.id === "provider-router"));
      assert.equal(JSON.stringify(kernel).includes(os.homedir()), false);
      assert.equal(JSON.stringify(kernel).includes("OPENROUTER_API_KEY=configured"), false);
    });
  });
});

test("Agent OS readiness blocks real OS claim until a model provider is configured", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const readiness = await getAgentOsReadiness();
      assert.equal(readiness.id, "agent-os-readiness");
      assert.equal(readiness.status, "blocked");
      assert.equal(readiness.summary.connectedProviders, 0);
      assert.ok(readiness.score < 100);
      assert.equal(readiness.primaryBlocker?.id, "provider-router");
      assert.ok(readiness.requirements.find((item) => item.id === "provider-router" && item.status === "blocked"));
      assert.equal(JSON.stringify(readiness).includes(os.homedir()), false);
      assert.equal(JSON.stringify(readiness).includes("OPENROUTER_API_KEY=configured"), false);
    });
  });
});

test("Agent OS readiness keeps provider-router blocked until configured provider passes health", async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "hermes-home");
    await mkdir(path.join(hermesHome, "profiles", "local"), { recursive: true });
    await writeFile(path.join(hermesHome, "profiles", "local", "config.yaml"), "name: local\n");
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_HOME: hermesHome, OLLAMA_HOST: "http://127.0.0.1:9" }, async () => {
      const readiness = await getAgentOsReadiness();
      assert.equal(readiness.status, "blocked");
      assert.equal(readiness.summary.connectedProviders, 0);
      assert.equal(readiness.summary.configuredProviders, 1);
      assert.equal(readiness.primaryBlocker?.id, "provider-router");
      const providerGate = readiness.requirements.find((item) => item.id === "provider-router");
      assert.equal(providerGate?.status, "blocked");
      assert.match(providerGate?.evidence || "", /configured but did not pass health verification/);
      assert.ok(providerGate?.missing.includes("Healthy Ollama route"));
    });
  });
});

test("Agent OS readiness keeps Ollama blocked until the selected local model is available", async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "hermes-home");
    await mkdir(path.join(hermesHome, "profiles", "local"), { recursive: true });
    await writeFile(path.join(hermesHome, "profiles", "local", "config.yaml"), "name: local\n");
    await withHttpServer((req, res) => {
      assert.equal(req.url, "/api/tags");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "mistral:latest" }] }));
    }, async (baseUrl) => {
      await withEnv({ ...PROVIDER_ENV_RESET, HERMES_HOME: hermesHome, OLLAMA_HOST: baseUrl }, async () => {
        const readiness = await getAgentOsReadiness();
        assert.equal(readiness.status, "blocked");
        assert.equal(readiness.summary.connectedProviders, 0);
        assert.equal(readiness.summary.configuredProviders, 1);
        const providerGate = readiness.requirements.find((item) => item.id === "provider-router");
        assert.equal(providerGate?.status, "blocked");
        assert.match(providerGate?.evidence || "", /model llama3.1 is not available/);
        assert.ok(providerGate?.missing.includes("Healthy Ollama route"));
      });
    });
  });
});

test("Agent OS readiness moves to dry-run-ready when provider, agent, and proof loop are connected", async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "hermes-home");
    await mkdir(path.join(hermesHome, "profiles", "local"), { recursive: true });
    await writeFile(path.join(hermesHome, "profiles", "local", "config.yaml"), "name: local\n");
    await writeFile(path.join(hermesHome, "active_profile"), "local\n");
    await withHttpServer((req, res) => {
      assert.equal(req.url, "/api/tags");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "llama3.1" }] }));
    }, async (baseUrl) => {
      await withEnv({ ...PROVIDER_ENV_RESET, HERMES_HOME: hermesHome, OLLAMA_HOST: baseUrl }, async () => {
        const readiness = await getAgentOsReadiness();
        assert.equal(readiness.status, "dry_run_ready");
        assert.equal(readiness.score, 100);
        assert.equal(readiness.summary.connectedProviders, 1);
        assert.equal(readiness.summary.configuredProviders, 1);
        assert.ok(readiness.executableTargets.providers.find((provider) => provider.id === "ollama"));
        assert.ok(readiness.executableTargets.agents.find((agent) => agent.id === "hermes"));
        assert.equal(readiness.primaryBlocker?.id, "live-execution-gate");
      });
    });
  });
});

test("scheduler runs due workflows and schedules the next interval", async () => {
  await withTempRuntime(async () => {
    const now = "2026-07-07T00:00:00.000Z";
    const job = await saveSchedulerJob({
      id: "blank-workflow-every-five",
      label: "Blank workflow every five",
      targetType: "workflow",
      targetId: "blank-open-agent-builder",
      intervalMinutes: 5,
      nextRunAt: now
    });
    assert.equal(job.id, "blank-workflow-every-five");

    const tick = await runSchedulerTick({ now });
    assert.equal(tick.due, 1);
    assert.equal(tick.runs[0].history.status, "completed");

    const state = await getSchedulerState();
    const updated = state.jobs.find((item) => item.id === job.id);
    assert.equal(updated?.runCount, 1);
    assert.equal(updated?.nextRunAt, "2026-07-07T00:05:00.000Z");
    assert.equal(state.history[0].jobId, job.id);
    assert.equal(state.history[0].status, "completed");
    assert.equal(JSON.stringify(state.history).includes(os.homedir()), false);

    const history = await getSchedulerHistory(job.id);
    assert.equal(history.history[0].status, "completed");
    assert.equal(history.history[0].scheduled, true);
  });
});

test("scheduler reports leader lock state without local paths", async () => {
  await withTempRuntime(async () => {
    const state = await getSchedulerState();
    assert.equal(state.lock.enabled, true);
    assert.equal(state.lock.mode, "leader_lock");
    assert.equal(state.lock.lockFile, "~/.hermes-agent-os/runs/scheduler/scheduler.lock.json");
    assert.equal(state.lock.ttlMs >= 1000, true);
    assert.equal(JSON.stringify(state).includes(os.homedir()), false);
  });
});

test("scheduler skips due jobs when another live leader lock is held", async () => {
  await withTempRuntime(async (dir) => {
    await saveSchedulerJob({
      id: "locked-workflow",
      label: "Locked workflow",
      targetType: "workflow",
      targetId: "blank-open-agent-builder",
      intervalMinutes: 5,
      nextRunAt: "2026-07-07T00:00:00.000Z"
    });
    const lockFile = path.join(dir, "runs", "scheduler", "scheduler.lock.json");
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, JSON.stringify({
      schemaVersion: 1,
      ownerId: "other-process",
      pid: 999999,
      acquiredAt: "2026-07-07T00:00:00.000Z",
      heartbeatAt: "2026-07-07T00:00:00.000Z",
      expiresAt: "2026-07-07T00:02:00.000Z",
      reason: "test"
    }));

    const tick = await runSchedulerTick({ now: "2026-07-07T00:00:30.000Z" });
    assert.equal(tick.skipped, true);
    assert.equal(tick.reason, "leader_lock_held");
    assert.equal(tick.due, 0);
    assert.equal(tick.runs.length, 0);
    assert.equal(tick.lock.heldByAnotherProcess, true);

    const state = await getSchedulerState();
    const job = state.jobs.find((item) => item.id === "locked-workflow");
    assert.equal(job?.runCount, 0);
    assert.equal(JSON.stringify(tick).includes(dir), false);
  });
});

test("scheduler recovers stale leader locks before running due jobs", async () => {
  await withTempRuntime(async (dir) => {
    await saveSchedulerJob({
      id: "stale-lock-workflow",
      label: "Stale lock workflow",
      targetType: "workflow",
      targetId: "blank-open-agent-builder",
      intervalMinutes: 5,
      nextRunAt: "2026-07-07T00:00:00.000Z"
    });
    const lockFile = path.join(dir, "runs", "scheduler", "scheduler.lock.json");
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, JSON.stringify({
      schemaVersion: 1,
      ownerId: "dead-process",
      pid: 999999,
      acquiredAt: "2026-07-06T23:00:00.000Z",
      heartbeatAt: "2026-07-06T23:00:00.000Z",
      expiresAt: "2026-07-06T23:02:00.000Z",
      reason: "test"
    }));

    const tick = await runSchedulerTick({ now: "2026-07-07T00:00:00.000Z" });
    assert.equal(tick.skipped, false);
    assert.equal(tick.due, 1);
    assert.equal(tick.runs[0].history.status, "completed");
    assert.equal(tick.lock.heldByThisProcess, true);

    const state = await getSchedulerState();
    const job = state.jobs.find((item) => item.id === "stale-lock-workflow");
    assert.equal(job?.runCount, 1);
    assert.equal(state.lock.held, false);
  });
});

test("scheduler retries non-completed workflow runs with retry delay", async () => {
  await withTempRuntime(async () => {
    await saveWorkflow({
      id: "scheduler-needs-config",
      name: "Needs config",
      draft: true,
      nodes: [
        { id: "agent", type: "agent", label: "Missing OpenClaude", moduleId: "openclaude" }
      ],
      edges: []
    });
    const job = await saveSchedulerJob({
      id: "retry-needs-config",
      label: "Retry needs config",
      targetType: "workflow",
      targetId: "scheduler-needs-config",
      intervalMinutes: 10,
      retryDelaySeconds: 30,
      maxRetries: 2,
      retryFailed: true,
      nextRunAt: "2026-07-07T00:00:00.000Z"
    });

    const tick = await runSchedulerTick({ now: "2026-07-07T00:00:00.000Z" });
    assert.equal(tick.due, 1);
    assert.equal(tick.runs[0].history.status, "ready_to_configure");

    const state = await getSchedulerState();
    const updated = state.jobs.find((item) => item.id === job.id);
    assert.equal(updated?.pendingRetry, true);
    assert.equal(updated?.currentRetryCount, 1);
    assert.equal(updated?.failureCount, 1);
    assert.equal(updated?.nextRunAt, "2026-07-07T00:00:30.000Z");
  });
});

test("scheduler pause and resume controls due execution", async () => {
  await withTempRuntime(async () => {
    const job = await saveSchedulerJob({
      id: "pausable-workflow",
      label: "Pausable workflow",
      targetType: "workflow",
      targetId: "blank-open-agent-builder",
      intervalMinutes: 5,
      nextRunAt: "2026-07-07T00:00:00.000Z"
    });
    await pauseSchedulerJob(job.id);
    let tick = await runSchedulerTick({ now: "2026-07-07T00:00:00.000Z" });
    assert.equal(tick.due, 0);

    await resumeSchedulerJob(job.id);
    tick = await runSchedulerTick({ now: "2026-07-07T00:00:00.000Z" });
    assert.equal(tick.due, 1);
    assert.equal(tick.runs[0].history.status, "completed");
  });
});

test("scheduler public targets include SEO and Video self-module jobs", async () => {
  await withTempRuntime(async () => {
    const state = await getSchedulerState();
    const targetIds = state.targets.selfModules.map((item) => item.id);
    assert.deepEqual(targetIds, ["goals", "notebook", "seo", "video", "kanban", "usage-credits"]);
    assert.equal(targetIds.includes("seo"), true);
    assert.equal(targetIds.includes("video"), true);
  });
});

test("scheduler allows SEO and Video self-module jobs", async () => {
  await withTempRuntime(async () => {
    const seoJob = await saveSchedulerJob({
      id: "seo-task",
      label: "SEO task",
      targetType: "self_module",
      targetId: "seo",
      action: "create_item",
      intervalMinutes: 60,
      nextRunAt: "2026-07-07T00:00:00.000Z"
    });
    assert.equal(seoJob.targetId, "seo");
    const videoJob = await saveSchedulerJob({
      id: "video-task",
      label: "Video task",
      targetType: "self_module",
      targetId: "video",
      action: "create_item",
      intervalMinutes: 60,
      nextRunAt: "2026-07-07T00:00:00.000Z"
    });
    assert.equal(videoJob.targetId, "video");
  });
});

test("scheduler approval gate pauses scheduled goal loops until approved", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      const goals = await createSelfModuleItem("goals", {
        title: "Scheduled goal loop",
        notes: "Only run after admin approval."
      });
      const goal = goals.items[0];
      const job = await saveSchedulerJob({
        id: "approved-goal-loop",
        label: "Approved goal loop",
        targetType: "self_module",
        targetId: "goals",
        action: "goal_loop",
        requiresApproval: true,
        intervalMinutes: 30,
        payload: {
          goalId: goal.id,
          provider: "openrouter",
          context: "Pick the next implementation step."
        },
        nextRunAt: "2026-07-07T00:00:00.000Z"
      });

      let tick = await runSchedulerTick({ now: "2026-07-07T00:00:00.000Z" });
      assert.equal(tick.due, 1);
      assert.equal(tick.runs[0].history.status, "waiting_approval");
      assert.equal(tick.runs[0].history.approvalGate, "pending");
      assert.equal(tick.runs[0].job.pendingApproval, true);
      let kanban = await getSelfModuleState("kanban");
      let approvalCard = kanban.items.find((item) => item.schedulerJobId === job.id);
      assert.equal(approvalCard?.sourceType, "scheduler_approval");
      assert.equal(approvalCard?.approvalStatus, "pending");
      assert.equal(approvalCard?.column, "review");

      let state = await getSchedulerState();
      let updated = state.jobs.find((item) => item.id === job.id);
      assert.equal(state.summary.pendingApproval, 1);
      assert.equal(updated?.approvalStatus, "pending");
      assert.equal(updated?.runCount, 0);

      tick = await runSchedulerTick({ now: "2026-07-07T00:01:00.000Z" });
      assert.equal(tick.due, 0);

      const rejected = await rejectSchedulerJob(job.id, { now: "2026-07-07T00:02:00.000Z", note: "Need review." });
      assert.equal(rejected.approvalStatus, "rejected");
      assert.equal(rejected.pendingApproval, false);
      kanban = await getSelfModuleState("kanban");
      approvalCard = kanban.items.find((item) => item.schedulerJobId === job.id);
      assert.equal(approvalCard?.approvalStatus, "rejected");
      assert.equal(approvalCard?.column, "blocked");

      tick = await runSchedulerTick({ now: "2026-07-07T00:02:00.000Z" });
      assert.equal(tick.due, 0);

      await approveSchedulerJob(job.id, { now: "2026-07-07T00:33:00.000Z", note: "Approved for dry-run loop." });
      tick = await runSchedulerTick({ now: "2026-07-07T00:33:00.000Z" });
      assert.equal(tick.due, 1);
      assert.equal(tick.runs[0].history.status, "completed");

      state = await getSchedulerState();
      updated = state.jobs.find((item) => item.id === job.id);
      assert.equal(updated?.pendingApproval, false);
      assert.equal(updated?.runCount, 1);
      assert.equal(updated?.approvalStatus, null);
      kanban = await getSelfModuleState("kanban");
      approvalCard = kanban.items.find((item) => item.schedulerJobId === job.id);
      assert.equal(approvalCard?.approvalStatus, "approved");
      assert.equal(approvalCard?.column, "done");

      const goalState = await getSelfModuleState("goals");
      const scheduledGoal = goalState.items.find((item) => item.id === goal.id);
      assert.equal(scheduledGoal?.loopCount, 1);
      assert.equal(scheduledGoal?.status, "in_progress");

      const usage = await getUsageState();
      assert.equal(usage.items[0].operation, "goal_loop");
      assert.equal(usage.items[0].source, "goals");
      assert.equal(JSON.stringify(state).includes("placeholder-openrouter-key"), false);
    });
  });
});

test("scheduler allows SEO create_item jobs and still rejects unsupported seo_audit actions", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      await configureConnection("provider-firecrawl", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
      const seo = await createSelfModuleItem("seo", {
        title: "Scheduled SEO audit",
        url: "https://example.com",
        keyword: "agent os"
      });
      const brief = seo.items[0];
      assert.ok(brief.id);
      const job = await saveSchedulerJob({
        id: "scheduled-seo-item",
        label: "Scheduled SEO brief",
        targetType: "self_module",
        targetId: "seo",
        action: "create_item",
        intervalMinutes: 60,
        payload: {
          title: "Scheduled SEO audit",
          url: "https://example.com",
          keyword: "agent os"
        },
        nextRunAt: "2026-07-07T00:00:00.000Z"
      });
      assert.equal(job.targetId, "seo");
      await assert.rejects(
        () => saveSchedulerJob({
          id: "scheduled-seo-audit",
          label: "Scheduled SEO audit",
          targetType: "self_module",
          targetId: "seo",
          action: "seo_audit",
          intervalMinutes: 60,
          payload: {
            briefId: brief.id,
            provider: "openrouter",
            context: "Find missing on-page improvements."
          },
          nextRunAt: "2026-07-07T00:00:00.000Z"
        }),
        /Unsupported scheduler action/
      );
    });
  });
});

test("provider router dispatches through configured user-owned providers in dry-run mode", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      const status = await getRouterStatus();
      assert.equal(status.status, "connected");
      assert.equal(status.providers.find((provider) => provider.id === "openrouter")?.status, "connected");
      assert.equal(status.nextProvider?.id, "openrouter");

      const result = await runRouter({ provider: "openrouter", prompt: "Say hello" });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.provider, "openrouter");
      assert.equal(result.plannedRequest.provider, "openrouter");
      assert.equal(result.plannedRequest.method, "POST");
      assert.equal(result.plannedRequest.accessMode, "provider key required");
      assert.equal(result.plannedRequest.executionGate, "disabled");
      assert.equal(result.plannedRequest.promptLength, 9);
      assert.match(result.plannedRequest.nextStep, /safe provider call plan/i);
      assert.equal(result.usage.total.calls, 1);
      assert.equal(JSON.stringify(result).includes("placeholder-openrouter-key"), false);
      assert.equal(JSON.stringify(result).includes("Say hello"), false);

      const usage = await getUsageState();
      assert.equal(usage.items.length, 1);
      assert.equal(usage.items[0].provider, "openrouter");
      assert.equal(usage.items[0].status, "dry_run");
      assert.equal(JSON.stringify(usage).includes("placeholder-openrouter-key"), false);

	      const modules = await getModules();
	      const routerModule = modules.find((module) => module.id === "provider-router");
	      assert.equal(routerModule?.status, "connected");
	      assert.equal(routerModule?.stats.configuredProvider, "openrouter");
	      assert.equal(routerModule?.stats.healthyProvider, "openrouter");
	    });
  });
});

test("provider router card can configure routing providers directly", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/models");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
      }, async (baseUrl) => {
        const connections = await getConnections();
        const routerTemplate = connections.templates.find((template) => template.id === "provider-router");
        assert.ok(routerTemplate);
        assert.ok(routerTemplate.fields.includes("OPENAI_API_KEY"));

        await configureConnection("provider-router", { OPENAI_API_KEY: "placeholder-router-openai-key" });
        await withEnv({ HERMES_OPENAI_HEALTH_URL: `${baseUrl}/models` }, async () => {
          const status = await getRouterStatus();
          assert.equal(status.status, "connected");
          assert.equal(status.nextProvider?.id, "openai");

          const modules = await getModules();
          const router = modules.find((module) => module.id === "provider-router");
          const openai = modules.find((module) => module.id === "provider-openai");
          assert.equal(router?.status, "connected");
          assert.equal(router?.stats.configuredProvider, "openai");
          assert.equal(openai?.status, "connected");
          assert.equal(openai?.stats.requiredConfigPresent, true);
          assert.equal(openai?.missing.includes("OPENAI_API_KEY"), false);
          assert.equal(JSON.stringify(modules).includes("placeholder-router-openai-key"), false);
        });
      });
    });
  });
});

test("provider router returns sanitized setup call plans when provider is missing", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const prompt = "private provider setup prompt";
      const result = await runRouter({ provider: "openai", prompt });
      assert.equal(result.ok, false);
      assert.equal(result.mode, "ready_to_configure");
      assert.equal(result.provider, "openai");
      assert.equal(result.model, "gpt-4o-mini");
      assert.equal(result.plannedRequest.provider, "openai");
      assert.equal(result.plannedRequest.method, "POST");
      assert.equal(result.plannedRequest.accessMode, "provider key required");
      assert.equal(result.plannedRequest.executionGate, "disabled");
      assert.ok(result.plannedRequest.missing.includes("OPENAI_API_KEY"));
      assert.match(result.plannedRequest.nextStep, /Configure the missing provider fields/);
      assert.equal(JSON.stringify(result).includes(prompt), false);
      assert.equal(JSON.stringify(result).includes("sk-"), false);

      const logs = await getModuleLogs("provider-router");
      assert.equal(JSON.stringify(logs).includes(prompt), false);
      assert.ok(logs.logs.some((entry) => entry.details?.plannedRequest?.provider === "openai"));
    });
  });
});

test("provider health reports setup state without network calls when providers are missing config", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const health = await getRouterHealth();
      assert.equal(health.summary.total, 7);
      assert.equal(health.summary.setup, 7);
      assert.equal(health.checks.find((check) => check.id === "omniroute")?.status, "ready_to_configure");
      assert.equal(health.summary.healthy, 0);
      assert.ok(health.checks.find((check) => check.id === "openrouter")?.missing.includes("OPENROUTER_API_KEY"));
      assert.equal(JSON.stringify(health).includes(os.homedir()), false);
    });
  });
});

test("provider health probes local Ollama tags endpoint", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/api/tags");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ models: [{ name: "llama3.1" }] }));
      }, async (baseUrl) => {
        await configureConnection("provider-ollama", { OLLAMA_HOST: baseUrl });
        const health = await getRouterHealth({ provider: "ollama" });
	        assert.equal(health.summary.healthy, 1);
	        assert.equal(health.checks[0].status, "healthy");
	        assert.equal(health.checks[0].modelCount, 1);
	        assert.equal(health.checks[0].selectedModel, "llama3.1");
	        assert.equal(health.checks[0].selectedModelAvailable, true);
	        assert.match(health.checks[0].endpoint, /\/api\/tags$/);
	      });
	    });
	  });
	});

test("provider health reports setup state when Ollama is reachable but selected model is missing", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/api/tags");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ models: [{ name: "mistral:latest" }] }));
      }, async (baseUrl) => {
        await configureConnection("provider-ollama", { OLLAMA_HOST: baseUrl });
        const health = await getRouterHealth({ provider: "ollama" });
        assert.equal(health.summary.healthy, 0);
        assert.equal(health.summary.setup, 1);
        assert.equal(health.checks[0].ok, false);
        assert.equal(health.checks[0].status, "ready_to_configure");
        assert.equal(health.checks[0].selectedModel, "llama3.1");
        assert.equal(health.checks[0].selectedModelAvailable, false);
        assert.ok(health.checks[0].missing.includes("llama3.1"));
        assert.match(health.checks[0].message, /model llama3.1 is not available/);
      });
    });
  });
});

test("provider health probes OpenRouter model endpoint without leaking API keys", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      let authHeader = "";
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/models");
        authHeader = String(req.headers.authorization || "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "openrouter/auto" }] }));
      }, async (baseUrl) => {
        await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
        await withEnv({ HERMES_OPENROUTER_HEALTH_URL: `${baseUrl}/models` }, async () => {
          const check = await checkProviderHealth("openrouter");
          assert.equal(check.status, "healthy");
          assert.equal(check.httpStatus, 200);
          assert.equal(check.modelCount, 1);
          assert.equal(authHeader, "Bearer placeholder-openrouter-key");
          assert.equal(JSON.stringify(check).includes("placeholder-openrouter-key"), false);
          const logs = await getModuleLogs("provider-router");
          assert.equal(JSON.stringify(logs).includes("placeholder-openrouter-key"), false);
          assert.ok(logs.logs.some((entry) => entry.message === "Provider health checked"));
        });
      });
    });
  });
});

test("provider-router module reports connected only after selected provider health passes", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/models");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "openrouter/auto" }] }));
      }, async (baseUrl) => {
        await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
        await withEnv({ HERMES_OPENROUTER_HEALTH_URL: `${baseUrl}/models` }, async () => {
          const modules = await getModules();
          const router = modules.find((module) => module.id === "provider-router");
          assert.equal(router?.status, "connected");
          assert.equal(router?.configured, true);
          assert.equal(router?.stats.healthyProvider, "openrouter");
          assert.equal(router?.stats.healthStatus, "healthy");
          assert.equal(JSON.stringify(router).includes("placeholder-openrouter-key"), false);
        });
      });
    });
  });
});

test("provider-router module stays setup-gated when selected provider health fails", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/api/tags");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ models: [{ name: "mistral:latest" }] }));
      }, async (baseUrl) => {
        await configureConnection("provider-ollama", { OLLAMA_HOST: baseUrl });
        const modules = await getModules();
        const router = modules.find((module) => module.id === "provider-router");
        assert.equal(router?.status, "ready_to_configure");
        assert.equal(router?.configured, false);
        assert.equal(router?.stats.configuredProvider, "ollama");
        assert.equal(router?.stats.healthyProvider, null);
        assert.equal(router?.stats.healthStatus, "ready_to_configure");
        assert.ok(router?.missing.includes("Healthy Ollama route"));
      });
    });
  });
});

test("direct provider card reports connected only after provider health passes", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/models");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "gpt-4.1-mini" }] }));
      }, async (baseUrl) => {
        await configureConnection("provider-openai", { OPENAI_API_KEY: "placeholder-openai-key" });
        await withEnv({ HERMES_OPENAI_HEALTH_URL: `${baseUrl}/models` }, async () => {
          const modules = await getModules();
          const openai = modules.find((module) => module.id === "provider-openai");
          assert.equal(openai?.status, "connected");
          assert.equal(openai?.configured, true);
          assert.equal(openai?.stats.requiredConfigPresent, true);
          assert.equal(openai?.stats.healthStatus, "healthy");
          assert.equal(openai?.stats.modelCount, 1);
          assert.equal(JSON.stringify(openai).includes("placeholder-openai-key"), false);
        });
      });
    });
  });
});

test("direct provider card stays setup-gated when configured provider health fails", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/api/tags");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ models: [{ name: "mistral:latest" }] }));
      }, async (baseUrl) => {
        await configureConnection("provider-ollama", { OLLAMA_HOST: baseUrl });
        const modules = await getModules();
        const ollama = modules.find((module) => module.id === "provider-ollama");
        assert.equal(ollama?.status, "ready_to_configure");
        assert.equal(ollama?.configured, false);
        assert.equal(ollama?.stats.requiredConfigPresent, true);
        assert.equal(ollama?.stats.healthStatus, "ready_to_configure");
        assert.equal(ollama?.stats.selectedModel, "llama3.1");
        assert.equal(ollama?.stats.selectedModelAvailable, false);
        assert.ok(ollama?.missing.includes("Healthy Ollama route"));
      });
    });
  });
});

test("usage credits record manual usage and warn against configured budgets", async () => {
  await withTempRuntime(async () => {
    await configureUsageBudget({ dailyLimit: 0.01, monthlyLimit: 0.02, warningThreshold: 0.5 });
    await recordUsageEvent({
      provider: "manual",
      operation: "manual",
      units: 500,
      estimatedCost: 0.006,
      status: "recorded"
    });

    const usage = await getUsageState();
    assert.equal(usage.summary.total.calls, 1);
    assert.equal(usage.summary.total.units, 500);
    assert.equal(usage.summary.total.estimatedCost, 0.006);
    assert.equal(usage.summary.daily.warning, true);
    assert.equal(usage.summary.monthly.warning, false);
  });
});

test("usage budget blocks real router execution before provider network calls", async () => {
  await withTempRuntime(async () => {
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      await configureUsageBudget({ dailyLimit: 0.000001, monthlyLimit: 0.000001 });
      await assert.rejects(
        () => runRouter({ provider: "openrouter", prompt: "x".repeat(4000), dryRun: false }),
        /usage credit limit/
      );
      const usage = await getUsageState();
      assert.equal(usage.items.length, 0);
    });
  });
});

test("usage billing import previews imports and deduplicates provider invoice exports", async () => {
  await withTempRuntime(async () => {
    await configureUsageBudget({ dailyLimit: 0.000001, monthlyLimit: 0.000001 });
    const csv = [
      "date,provider,model,units,cost,currency,invoice_id,line_id,description",
      "2026-07-01,anthropic,claude-3-5-sonnet,1200,0.42,usd,inv_1,line_1,Claude invoice",
      "2026-07-02,gemini,gemini-1.5-flash,800,0.08,usd,inv_2,line_2,Gemini invoice",
      "2026-07-03,minimax,MiniMax-M3,0,0,usd,inv_3,line_3,Invalid empty row"
    ].join("\n");

    const preview = await previewUsageBillingImport({
      provider: "anthropic",
      sourceName: "July invoice",
      text: csv
    });
    assert.equal(preview.summary.rows, 3);
    assert.equal(preview.summary.valid, 2);
    assert.equal(preview.summary.invalid, 1);
    assert.equal(preview.summary.totalEstimatedCost, 0.5);
    assert.equal(preview.records[0].requestId, "billing-import:anthropic:line_1");
    assert.equal(JSON.stringify(preview).includes(os.homedir()), false);

    const imported = await importUsageBilling({
      provider: "anthropic",
      sourceName: "July invoice",
      text: csv
    });
    assert.equal(imported.imported.length, 2);
    assert.equal(imported.skipped.length, 1);
    assert.equal(imported.usage.summary.total.calls, 2);
    assert.equal(imported.usage.summary.total.estimatedCost, 0.5);
    assert.equal(imported.usage.items[0].mode, "imported");
    assert.equal(imported.usage.items[0].source, "billing-import");
    assert.ok(imported.usage.items.find((item) => item.requestId === "billing-import:anthropic:line_1"));
    assert.ok(imported.usage.items.every((item) => item.createdAt.startsWith("2026-07-0")));

    const duplicatePreview = await previewUsageBillingImport({
      provider: "anthropic",
      sourceName: "July invoice",
      text: csv
    });
    assert.equal(duplicatePreview.summary.duplicates, 2);
    assert.equal(duplicatePreview.summary.valid, 0);
  });
});

test("usage billing import rejects secrets local paths and unsupported currencies", async () => {
  await withTempRuntime(async () => {
    await assert.rejects(
      () => previewUsageBillingImport({
        provider: "anthropic",
        text: `date,provider,units,cost,currency,notes\n2026-07-01,anthropic,10,0.01,usd,${os.homedir()}/secret`
      }),
      /Billing import rejected/
    );

    const preview = await previewUsageBillingImport({
      provider: "anthropic",
      text: "date,provider,units,cost,currency\n2026-07-01,anthropic,10,0.01,eur"
    });
    assert.equal(preview.summary.valid, 0);
    assert.equal(preview.records[0].errors.includes("unsupported currency eur"), true);
  });
});

test("usage reconciliation reports missing and unsupported provider billing states honestly", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const state = await getUsageReconciliation();
      const openrouter = state.providers.find((provider) => provider.id === "openrouter-key");
      const ollama = state.providers.find((provider) => provider.id === "ollama-local");
      assert.equal(openrouter?.status, "ready_to_configure");
      assert.ok(openrouter?.missing.includes("OPENROUTER_API_KEY"));
      assert.equal(ollama?.status, "unsupported");

      const run = await runUsageReconciliation({ provider: "ollama-local" });
      assert.equal(run.results[0].status, "unsupported");
      assert.equal(run.results[0].comparison?.providerReported, null);
      assert.equal(JSON.stringify(run).includes(os.homedir()), false);
    });
  });
});

test("usage reconciliation imports OpenRouter key usage without leaking API keys", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      let authHeader = "";
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/key");
        authHeader = String(req.headers.authorization || "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          data: {
            label: "Hermes test key",
            limit: 20,
            limit_remaining: 18.5,
            usage: 4.2,
            usage_daily: 0.5,
            usage_weekly: 1.1,
            usage_monthly: 1.5,
            byok_usage_monthly: 0,
            is_free_tier: false
          }
        }));
      }, async (baseUrl) => {
        await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
        await recordUsageEvent({
          provider: "openrouter",
          operation: "manual",
          units: 100,
          estimatedCost: 0.1,
          status: "recorded"
        });
        await withEnv({ HERMES_OPENROUTER_KEY_URL: `${baseUrl}/key` }, async () => {
          const run = await runUsageReconciliation({ provider: "openrouter-key" });
          assert.equal(authHeader, "Bearer placeholder-openrouter-key");
          assert.equal(run.results[0].status, "connected");
          assert.equal(run.results[0].actual?.usageMonthly, 1.5);
          assert.equal(run.results[0].comparison?.localEstimate, 0.1);
          assert.equal(run.results[0].comparison?.providerReported, 1.5);
          assert.equal(JSON.stringify(run).includes("placeholder-openrouter-key"), false);

          const state = await getUsageState();
          assert.equal(state.reconciliation.summary.connected, 1);
          assert.equal(state.reconciliation.providers.find((provider) => provider.id === "openrouter-key")?.status, "connected");
        });
      });
    });
  });
});

test("usage reconciliation imports OpenRouter account credits with management key", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      let authHeader = "";
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/credits");
        authHeader = String(req.headers.authorization || "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          data: {
            total_credits: 100.5,
            total_usage: 25.75
          }
        }));
      }, async (baseUrl) => {
        await configureConnection("provider-openrouter", { OPENROUTER_MANAGEMENT_KEY: "placeholder-management-key" });
        await withEnv({ HERMES_OPENROUTER_CREDITS_URL: `${baseUrl}/credits` }, async () => {
          const run = await runUsageReconciliation({ provider: "openrouter-credits" });
          assert.equal(authHeader, "Bearer placeholder-management-key");
          assert.equal(run.results[0].status, "connected");
          assert.equal(run.results[0].actual?.totalCredits, 100.5);
          assert.equal(run.results[0].actual?.totalUsage, 25.75);
          assert.equal(run.results[0].actual?.remaining, 74.75);
          assert.equal(JSON.stringify(run).includes("placeholder-management-key"), false);
        });
      });
    });
  });
});

test("usage reconciliation imports OpenAI organization costs with admin key", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      let authHeader = "";
      await withHttpServer((req, res) => {
        assert.equal(req.url.startsWith("/costs?"), true);
        assert.equal(new URL(`http://local${req.url}`).searchParams.has("start_time"), true);
        authHeader = String(req.headers.authorization || "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          object: "page",
          data: [
            {
              object: "bucket",
              start_time: 1730419200,
              end_time: 1730505600,
              results: [
                { object: "organization.costs.result", amount: { value: 0.06, currency: "usd" } },
                { object: "organization.costs.result", amount: { value: 0.04, currency: "usd" } }
              ]
            }
          ],
          has_more: false,
          next_page: null
        }));
      }, async (baseUrl) => {
        await configureConnection("provider-openai", { OPENAI_ADMIN_KEY: "placeholder-openai-admin-key" });
        await recordUsageEvent({
          provider: "openai",
          operation: "manual",
          units: 100,
          estimatedCost: 0.12,
          status: "recorded"
        });
        await withEnv({ HERMES_OPENAI_COSTS_URL: `${baseUrl}/costs` }, async () => {
          const run = await runUsageReconciliation({ provider: "openai-costs" });
          assert.equal(authHeader, "Bearer placeholder-openai-admin-key");
          assert.equal(run.results[0].status, "connected");
          assert.equal(run.results[0].actual?.totalCost, 0.1);
          assert.equal(run.results[0].comparison?.localEstimate, 0.12);
          assert.equal(run.results[0].comparison?.providerReported, 0.1);
          assert.equal(run.results[0].comparison?.delta, -0.02);
          assert.equal(JSON.stringify(run).includes("placeholder-openai-admin-key"), false);
        });
      });
    });
  });
});

test("setup wizard state can save install mode and start the blank workflow", async () => {
  await withTempRuntime(async () => {
    const initial = await getSetupState();
    assert.ok(initial.steps.find((step) => step.id === "runtime"));
    assert.equal(initial.mode, "local");

    const saved = await saveSetupState({ mode: "docker", preferredProvider: "openrouter" });
    assert.equal(saved.mode, "docker");
    assert.equal(saved.preferredProvider, "openrouter");

    const started = await startFirstSetupWorkflow();
    assert.ok(started.run.id.startsWith("run-"));
    assert.equal(started.setup.firstWorkflowRunId, started.run.id);
  });
});

test("guided provider setup lists providers and saves allowed fields without leaking values", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const initial = await getProviderSetupState();
      assert.equal(initial.summary.total, 9);
      assert.ok(initial.guides.find((guide) => guide.id === "ollama"));
      assert.ok(initial.guides.find((guide) => guide.id === "openrouter")?.missing.includes("OPENROUTER_API_KEY"));

      const saved = await configureProviderSetup("openrouter", {
        fields: {
          OPENROUTER_API_KEY: "placeholder-openrouter-key",
          OPENROUTER_MANAGEMENT_KEY: "placeholder-management-key",
          UNSUPPORTED_FIELD: "must-not-save"
        },
        model: "openrouter/auto"
      });
      assert.equal(saved.ok, true);
      assert.equal(saved.guide.configured, true);
      assert.ok(saved.guide.configuredFields.includes("OPENROUTER_API_KEY"));
      assert.equal(JSON.stringify(saved).includes("placeholder-openrouter-key"), false);
      assert.equal(JSON.stringify(saved).includes("must-not-save"), false);

      const router = await getRouterStatus();
      assert.equal(router.providers.find((provider) => provider.id === "openrouter")?.model, "openrouter/auto");
    });
  });
});

test("guided provider setup tests router providers through safe health checks", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      let authHeader = "";
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/models");
        authHeader = String(req.headers.authorization || "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "openrouter/auto" }] }));
      }, async (baseUrl) => {
        await configureProviderSetup("openrouter", {
          fields: { OPENROUTER_API_KEY: "placeholder-openrouter-key" }
        });
        await withEnv({ HERMES_OPENROUTER_HEALTH_URL: `${baseUrl}/models` }, async () => {
          const result = await testProviderSetup("openrouter");
          assert.equal(result.ok, true);
          assert.equal(authHeader, "Bearer placeholder-openrouter-key");
          assert.equal(JSON.stringify(result).includes("placeholder-openrouter-key"), false);
        });
      });
    });
  });
});

test("guided provider setup lists Ollama local model inventory", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const missing = await getProviderModelInventory("ollama");
      assert.equal(missing.status, "ready_to_configure");
      assert.ok(missing.missing.includes("OLLAMA_HOST"));

      await withHttpServer((req, res) => {
        assert.equal(req.url, "/api/tags");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          models: [
            {
              name: "llama3.1:latest",
              model: "llama3.1:latest",
              modified_at: "2026-07-01T00:00:00.000Z",
              size: 4_294_967_296,
              digest: "abcdef1234567890",
              details: {
                family: "llama",
                families: ["llama"],
                parameter_size: "8B",
                quantization_level: "Q4_K_M",
                format: "gguf"
              }
            },
            {
              name: "nomic-embed-text:latest",
              model: "nomic-embed-text:latest",
              modified_at: "2026-07-02T00:00:00.000Z",
              size: 536_870_912,
              digest: "123456abcdef7890",
              details: {
                family: "nomic",
                families: ["nomic"],
                parameter_size: "137M",
                quantization_level: "F16",
                format: "gguf"
              }
            }
          ]
        }));
      }, async (baseUrl) => {
        await configureProviderSetup("ollama", {
          fields: { OLLAMA_HOST: baseUrl },
          model: "llama3.1:latest"
        });
        const inventory = await getProviderModelInventory("ollama");
        assert.equal(inventory.status, "connected");
        assert.equal(inventory.modelCount, 2);
        assert.equal(inventory.totalSizeGb, 4.5);
        assert.equal(inventory.selectedModelAvailable, true);
        assert.equal(inventory.models[0].sizeLabel, "4 GB");
        assert.equal(inventory.models[0].digest, "abcdef123456...");
        assert.equal(inventory.models[0].details.parameterSize, "8B");
        assert.equal(JSON.stringify(inventory).includes(os.homedir()), false);
      });

      const openAiMissing = await getProviderModelInventory("openai");
      assert.equal(openAiMissing.status, "ready_to_configure");
      assert.ok(openAiMissing.missing.includes("OPENAI_API_KEY"));
    });
  });
});

test(
  "Ollama bootstrap doctor reports install, host, server, and model readiness",
  { skip: isWindows ? "spawns a shebang fake ollama CLI (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const missing = await getOllamaDoctor();
      assert.equal(missing.provider, "ollama");
      assert.ok(["missing_dependency", "ready_to_configure"].includes(missing.status));
      assert.ok(missing.checks.find((check) => check.id === "ollama-cli"));
      assert.ok(missing.checks.find((check) => check.id === "ollama-server"));
      assert.equal(JSON.stringify(missing).includes(os.homedir()), false);

      const bin = path.join(dir, "bin");
      const cli = path.join(bin, "ollama");
      await mkdir(bin, { recursive: true });
      await writeFile(cli, "#!/bin/sh\necho ollama-test\n");
      await chmod(cli, 0o755);
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/api/tags");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          models: [
            {
              name: "llama3.1",
              model: "llama3.1",
              size: 1000,
              details: { family: "llama", families: ["llama"], parameter_size: "8B", quantization_level: "Q4", format: "gguf" }
            }
          ]
        }));
      }, async (baseUrl) => {
        await configureProviderSetup("ollama", {
          fields: { OLLAMA_HOST: baseUrl },
          model: "llama3.1"
        });
        await withEnv({ HERMES_AGENT_OS_EXECUTABLE_PATHS: bin }, async () => {
          const ready = await getOllamaDoctor();
          assert.equal(ready.status, "connected");
          assert.equal(ready.installed, true);
          assert.equal(ready.hostConfigured, true);
          assert.equal(ready.serverReachable, true);
          assert.equal(ready.selectedModelAvailable, true);
          assert.equal(ready.modelCount, 1);
          assert.equal(JSON.stringify(ready).includes(cli), false);
          assert.equal(JSON.stringify(ready).includes(os.homedir()), false);
        });
      });
    });
  });
});

test("guided provider setup lists OpenAI model inventory without leaking API keys", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      let authHeader = "";
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/models");
        authHeader = String(req.headers.authorization || "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          data: [
            { id: "gpt-4o-mini", owned_by: "system", created_at: "2026-07-01T00:00:00.000Z" },
            { id: "gpt-4.1-mini", owned_by: "system" }
          ]
        }));
      }, async (baseUrl) => {
        await configureProviderSetup("openai", {
          fields: { OPENAI_API_KEY: "placeholder-openai-key" },
          model: "gpt-4o-mini"
        });
        await withEnv({ HERMES_OPENAI_HEALTH_URL: `${baseUrl}/models` }, async () => {
          const inventory = await getProviderModelInventory("openai");
          assert.equal(inventory.status, "connected");
          assert.equal(inventory.provider, "openai");
          assert.equal(inventory.modelCount, 2);
          assert.equal(inventory.models[0].name, "gpt-4o-mini");
          assert.equal(inventory.models[0].sizeLabel, "cloud");
          assert.equal(inventory.selectedModelAvailable, true);
          assert.equal(authHeader, "Bearer placeholder-openai-key");
          assert.equal(JSON.stringify(inventory).includes("placeholder-openai-key"), false);
          assert.equal(JSON.stringify(inventory).includes(os.homedir()), false);
        });
      });
    });
  });
});

test("guided provider setup lists cloud model inventories for every routed provider", async () => {
  const cases = [
    {
      id: "openrouter",
      keyField: "OPENROUTER_API_KEY",
      keyValue: "placeholder-openrouter-key",
      overrideField: "HERMES_OPENROUTER_HEALTH_URL",
      selectedModel: "openrouter/auto",
      responseBody: { data: [{ id: "openrouter/auto" }, { id: "anthropic/claude-3.5-sonnet" }] },
      assertRequest(req) {
        assert.equal(req.url, "/models");
        assert.equal(String(req.headers.authorization || ""), `Bearer ${this.keyValue}`);
      }
    },
    {
      id: "minimax",
      keyField: "MINIMAX_API_KEY",
      keyValue: "placeholder-minimax-key",
      overrideField: "HERMES_MINIMAX_HEALTH_URL",
      selectedModel: "MiniMax-M3",
      responseBody: { data: [{ id: "MiniMax-M3" }, { id: "MiniMax-Text-01" }] },
      assertRequest(req) {
        assert.equal(req.url, "/models");
        assert.equal(String(req.headers.authorization || ""), `Bearer ${this.keyValue}`);
      }
    },
    {
      id: "anthropic",
      keyField: "ANTHROPIC_API_KEY",
      keyValue: "placeholder-anthropic-key",
      overrideField: "HERMES_ANTHROPIC_HEALTH_URL",
      selectedModel: "claude-3-5-sonnet-latest",
      responseBody: { data: [{ id: "claude-3-5-sonnet-latest" }, { id: "claude-3-haiku-20240307" }] },
      assertRequest(req) {
        assert.equal(req.url, "/models");
        assert.equal(String(req.headers["x-api-key"] || ""), this.keyValue);
        assert.equal(String(req.headers["anthropic-version"] || ""), "2023-06-01");
      }
    },
    {
      id: "gemini",
      keyField: "GEMINI_API_KEY",
      keyValue: "placeholder-gemini-key",
      overrideField: "HERMES_GEMINI_HEALTH_URL",
      selectedModel: "gemini-1.5-flash",
      responseBody: { models: [{ name: "models/gemini-1.5-flash", displayName: "Gemini 1.5 Flash" }, { name: "models/gemini-1.5-pro" }] },
      assertRequest(req) {
        const url = new URL(req.url, "http://127.0.0.1");
        assert.equal(url.pathname, "/models");
        assert.equal(url.searchParams.get("key"), this.keyValue);
      }
    }
  ];

  for (const item of cases) {
    await withTempRuntime(async () => {
      await withEnv(PROVIDER_ENV_RESET, async () => {
        await withHttpServer((req, res) => {
          item.assertRequest(req);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(item.responseBody));
        }, async (baseUrl) => {
          await configureProviderSetup(item.id, {
            fields: { [item.keyField]: item.keyValue },
            model: item.selectedModel
          });
          await withEnv({ [item.overrideField]: `${baseUrl}/models` }, async () => {
            const inventory = await getProviderModelInventory(item.id);
            assert.equal(inventory.status, "connected");
            assert.equal(inventory.provider, item.id);
            assert.equal(inventory.modelCount, 2);
            assert.equal(inventory.selectedModelAvailable, true);
            assert.equal(inventory.models[0].sizeLabel, "cloud");
            assert.equal(JSON.stringify(inventory).includes(item.keyValue), false);
            assert.equal(JSON.stringify(inventory).includes(os.homedir()), false);
          });
        });
      });
    });
  }
});

test("guided provider setup prepares Ollama model pull without executing by default", async () => {
  await withTempRuntime(async () => {
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_INSTALL: null }, async () => {
      const result = await prepareProviderModel("ollama", { model: "llama3.1" });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.command, "ollama pull llama3.1");
      await assert.rejects(
        () => prepareProviderModel("ollama", { model: "bad model; rm -rf /" }),
        /unsupported characters/
      );
      await assert.rejects(
        () => prepareProviderModel("openrouter", { model: "openrouter/auto" }),
        /only available for Ollama/
      );
    });
  });
});

test("public-mode admin guard requires the configured token", async () => {
  await withEnv(
    {
      HERMES_AGENT_OS_PUBLIC_MODE: "1",
      HERMES_AGENT_OS_REQUIRE_AUTH: null,
      HERMES_AGENT_OS_ADMIN_TOKEN: "test-admin-token"
    },
    async () => {
      const okReq = {
        get(name) {
          return name.toLowerCase() === "x-hermes-admin-token" ? "test-admin-token" : "";
        },
        body: {},
        query: {}
      };
      const badReq = {
        get() {
          return "";
        },
        body: {},
        query: {}
      };
      assert.equal(isAdminRequest(okReq), true);
      assert.equal(sessionStatus(okReq).authenticated, true);
      assert.equal(isAdminRequest(badReq), false);
      assert.throws(() => assertAdminRequest(badReq), /Admin token required/);
    }
  );
});

test("execution gate defaults to dry-run and can be enabled from local config", async () => {
  await withTempRuntime(async () => {
    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: null }, async () => {
      const initial = await getExecutionGateStatus();
      assert.equal(initial.enabled, false);
      assert.equal(initial.source, "disabled");
      assert.equal(initial.dryRunDefault, true);
      assert.equal(await isExecutionEnabled(), false);

      const enabled = await setExecutionGateStatus({ enabled: true, reason: "test local enable" });
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.source, "local-config");
      assert.equal(enabled.reason, "test local enable");
      assert.equal(await isExecutionEnabled(), true);

      const disabled = await setExecutionGateStatus({ enabled: false, reason: "test local disable" });
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.source, "disabled");
      assert.equal(await isExecutionEnabled(), false);
      assert.equal(JSON.stringify(disabled).includes(os.homedir()), false);
    });
  });
});

test("execution gate local config is honored by module dry-run proof", async () => {
  await withTempRuntime(async () => {
    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: null }, async () => {
      await setExecutionGateStatus({ enabled: true, reason: "test proof gate" });
      const result = await runModule("codex", { message: "prepare a dashboard task" });
      assert.equal(result.mode, "dry_run");
      assert.equal(result.proof.execEnabled, true);
      assert.equal(result.proof.explicitExecution, false);
      assert.ok(result.proof.evidence.some((item) => item === "execution gate: enabled"));
    });
  });
});

test("installer recipes are dry-run by default and expose real commands", async () => {
  const claude = await prepareInstall("claude");
  assert.equal(claude.ok, true);
  assert.equal(claude.mode, "dry_run");
  assert.equal(claude.recipe.command, "npm install -g @anthropic-ai/claude-code");

  const ollama = await prepareInstall("provider-ollama");
  assert.equal(ollama.ok, true);
  assert.equal(ollama.mode, "dry_run");
  assert.equal(ollama.recipe.command, "brew install ollama");
  assert.match(ollama.message, /brew install ollama/);

  const openclaude = await prepareInstall("openclaude");
  assert.equal(openclaude.ok, true);
  assert.equal(openclaude.mode, "manual");
  assert.equal(openclaude.recipe.command, "");

  const openclaw = await prepareInstall("openclaw");
  assert.equal(openclaw.mode, "dry_run");
  assert.equal(openclaw.recipe.command, "npm install -g openclaw@latest");
  assert.match(openclaw.recipe.docsUrl, /github\.com\/openclaw\/openclaw/);

  const hermes = await prepareInstall("hermes");
  assert.equal(hermes.mode, "dry_run");
  assert.match(hermes.recipe.command, /hermes-agent\.nousresearch\.com\/install\.sh/);
  assert.match(hermes.recipe.docsUrl, /NousResearch\/hermes-agent/);
});

test("provider modules expose LLM connection fields without fake connected status", async () => {
  await withTempRuntime(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const modules = await getModules();
    for (const id of ["provider-anthropic", "provider-openai", "provider-gemini", "provider-openrouter"]) {
      const module = modules.find((item) => item.id === id);
      assert.equal(module?.status, "ready_to_configure", `${id} should wait for user config`);
      assert.ok(module?.configKeys.length);
    }
  });
});

test("MiniMax M3 follows provider-minimax configuration", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "test invalid key" }));
      }, async (baseUrl) => {
        await configureConnection("provider-minimax", {
          MINIMAX_API_KEY: "placeholder-minimax-key",
          HERMES_MINIMAX_HEALTH_URL: baseUrl
        });
        const modules = await getModules();
        const provider = modules.find((module) => module.id === "provider-minimax");
        const direct = modules.find((module) => module.id === "minimax");
        assert.equal(provider?.status, "ready_to_configure");
        assert.equal(direct?.status, "ready_to_configure");
        assert.ok(provider?.missing.includes("Healthy MiniMax route"));
        assert.equal(provider?.stats.requiredConfigPresent, true);
        assert.equal(direct?.stats.requiredConfigPresent, true);
      });
    });
  });
});

test(
  "CLI modules discover local executables outside the server PATH",
  { skip: isWindows ? "uses a chmod-based shebang fake CLI and a POSIX PATH string (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const bin = path.join(dir, "bin");
    const cli = path.join(bin, "codex");
    await mkdir(bin, { recursive: true });
    await writeFile(cli, "#!/bin/sh\necho codex-test-version\n");
    await chmod(cli, 0o755);
    await withEnv({ PATH: "/usr/bin:/bin", HERMES_AGENT_OS_EXECUTABLE_PATHS: bin }, async () => {
      const modules = await getModules();
      const codex = modules.find((module) => module.id === "codex");
      assert.equal(codex?.status, "connected");
      assert.equal(codex?.configured, true);
      assert.equal(codex?.missing.length, 0);
      assert.match(codex?.version || "", /codex-test-version/);
      assert.equal(JSON.stringify(codex).includes(cli), false);
      assert.equal(JSON.stringify(codex).includes(os.homedir()), false);
    });
  });
});

test("Firecrawl builder requires Convex, Clerk, and Firecrawl keys", async () => {
  await withTempRuntime(async () => {
    await configureConnection("firecrawl-builder", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
    let modules = await getModules();
    let builder = modules.find((module) => module.id === "firecrawl-builder");
    assert.equal(builder?.status, "ready_to_configure");
    assert.ok(builder?.missing.includes("NEXT_PUBLIC_CONVEX_URL"));
    assert.ok(builder?.missing.includes("CLERK_SECRET_KEY"));

    await configureConnection("provider-convex", { NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud" });
    await configureConnection("provider-clerk", {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
      CLERK_SECRET_KEY: "placeholder-clerk-secret",
      CLERK_JWT_ISSUER_DOMAIN: "https://example.clerk.accounts.dev"
    });
    modules = await getModules();
    builder = modules.find((module) => module.id === "firecrawl-builder");
    assert.equal(builder?.status, "connected");
    assert.deepEqual(builder?.missing, []);
  });
});

test("elizaOS core is a real loadable runtime foundation", async () => {
  await withTempRuntime(async () => {
    const status = await getOsStatus();
    assert.match(status.runtimeFoundation, /elizaOS core/);
    assert.equal(status.elizaOS.ok, true);
    assert.equal(status.elizaOS.packageName, "@elizaos/core");
    assert.ok(status.elizaOS.exports.includes("AgentRuntime"));
  });
});

test("local self modules are backed by the Agent OS store", async () => {
  await withTempRuntime(async () => {
    const modules = await getModules({ includeParked: true });
    for (const id of ["goals", "seo", "video", "notebook", "kanban", "usage-credits"]) {
      const module = modules.find((item) => item.id === id);
      assert.equal(module?.status, "connected", `${id} should be a real local app`);
      assert.equal(module?.configured, true);
      assert.deepEqual(module?.missing, []);
    }

    let goals = await getSelfModuleState("goals");
    assert.equal(goals.items.length, 0);
    goals = await createSelfModuleItem("goals", { title: "Ship real modules", notes: "Local store test" });
    assert.equal(goals.items.length, 1);
    assert.equal(goals.summary.byStatus.open, 1);

    const notebook = await createSelfModuleItem("notebook", { title: "Runtime note", body: "Private local note" });
    assert.equal(notebook.items[0].body, "Private local note");

    const seo = await createSelfModuleItem("seo", {
      title: "Homepage audit",
      url: "https://example.com",
      keyword: "agent os"
    });
    assert.equal(seo.items[0].keyword, "agent os");
    assert.equal(seo.summary.byStatus.planned, 1);

    const video = await createSelfModuleItem("video", {
      title: "Caption short",
      sourcePath: "/tmp/source.mp4",
      workflow: "native captions"
    });
    assert.equal(video.items[0].workflow, "native captions");
    assert.equal(video.summary.byStatus.queued, 1);

    const kanban = await createSelfModuleItem("kanban", { title: "Wire UI", column: "doing", priority: "high" });
    assert.equal(kanban.summary.byColumn.doing, 1);
    assert.equal(kanban.items[0].priority, "high");

    const usage = await createSelfModuleItem("usage-credits", {
      title: "OpenAI run",
      provider: "openai",
      units: 1200,
      estimatedCost: 0.012
    });
    assert.equal(usage.summary.usage.units, 1200);
    assert.equal(usage.summary.usage.estimatedCost, 0.012);
  });
});

test(
  "video worker inspects local media and prepares redacted handoff plans",
  { skip: isWindows ? "spawns shebang fake ffprobe/ffmpeg/whisper CLIs (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const toolsDir = path.join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });
    const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1080,"height":1920,"avg_frame_rate":"30000/1001"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"12.345","format_name":"mov,mp4,m4a,3gp,3g2,mj2","size":"123456","bit_rate":"800000"}}
JSON
`);
    const ffmpeg = await writeExecutable(path.join(toolsDir, "ffmpeg"), "#!/bin/sh\necho ffmpeg test 1.0\n");
    const whisper = await writeExecutable(path.join(toolsDir, "whisper"), "#!/bin/sh\necho whisper test help\n");
    const source = path.join(dir, "source.mp4");
    await writeFile(source, "fake media fixture");

    await withEnv({
      ...VIDEO_STT_ENV_RESET,
      HERMES_FFPROBE_PATH: ffprobe,
      HERMES_FFMPEG_PATH: ffmpeg,
      HERMES_WHISPER_PATH: whisper,
      HERMES_AGENT_OS_ENABLE_EXEC: null
    }, async () => {
      const worker = await getVideoWorkerStatus();
      assert.equal(worker.status, "connected");
      assert.equal(worker.tools.ffprobe.available, true);
      assert.equal(JSON.stringify(worker).includes(toolsDir), false);

      const video = await createSelfModuleItem("video", {
        title: "Caption fixture",
        sourcePath: source,
        workflow: "captioning"
      });
      const result = await runVideoJob(video.items[0].id, { dryRun: true });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.run.status, "planned");
      assert.equal(result.run.probe?.durationSeconds, 12.345);
      assert.equal(result.run.probe?.hasAudio, true);
      assert.equal(result.run.captionPlan.status, "ready");
      assert.equal(result.run.renderPlan.status, "ready");
      assert.equal(result.run.renderPlan.preset, "copy");
      assert.ok(result.run.renderPlan.availablePresets.some((preset) => preset.id === "vertical_1080x1920"));
      assert.equal(result.state.items[0].workerRunCount, 1);
      assert.equal(result.state.items[0].durationSeconds, 12.345);
      assert.equal(JSON.stringify(result).includes(dir), false);
      assert.equal(JSON.stringify(result).includes(source), false);
    });
  });
});

test(
  "video worker execution gate writes a handoff manifest without exposing local paths",
  { skip: isWindows ? "spawns shebang fake ffprobe/ffmpeg/whisper CLIs (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const toolsDir = path.join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });
    const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360,"avg_frame_rate":"24/1"}],"format":{"duration":"3.5","format_name":"mp4","size":"1000","bit_rate":"2000"}}
JSON
`);
    const ffmpeg = await writeExecutable(path.join(toolsDir, "ffmpeg"), "#!/bin/sh\necho ffmpeg test 1.0\n");
    const source = path.join(dir, "silent.mp4");
    await writeFile(source, "fake silent media fixture");

    await withEnv({
      ...VIDEO_STT_ENV_RESET,
      HERMES_FFPROBE_PATH: ffprobe,
      HERMES_FFMPEG_PATH: ffmpeg,
      HERMES_WHISPER_PATH: null,
      HERMES_AGENT_OS_ENABLE_EXEC: "1"
    }, async () => {
      const video = await createSelfModuleItem("video", {
        title: "Render handoff fixture",
        sourcePath: source,
        workflow: "render handoff"
      });
      const result = await runVideoJob(video.items[0].id, { dryRun: false });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "executed");
      assert.equal(result.run.status, "completed");
      assert.equal(result.run.output.manifest, `~/.hermes-agent-os/runs/video/${result.run.id}/handoff.json`);
      assert.equal(result.run.captionPlan.status, "ready_to_configure");
      assert.ok(result.run.captionPlan.missing.includes("audio_stream"));
      assert.equal(result.state.items[0].status, "completed");
      assert.equal(result.state.summary.video.completed, 1);
      assert.equal(JSON.stringify(result).includes(dir), false);
      assert.equal(JSON.stringify(result).includes(source), false);
    });
  });
});

test(
  "video worker executes whisper transcription and ffmpeg caption render behind the run gate",
  { skip: isWindows ? "spawns shebang fake ffprobe/ffmpeg/whisper CLIs (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const toolsDir = path.join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });
    const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":720,"height":1280,"avg_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"9.25","format_name":"mp4","size":"2000","bit_rate":"5000"}}
JSON
`);
    const whisper = await writeExecutable(path.join(toolsDir, "whisper"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "whisper test help"
  exit 0
fi
outdir="."
src="$1"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output_dir" ]; then
    shift
    outdir="$1"
  fi
  shift
done
base=$(basename "$src" .mp4)
printf "1\\n00:00:00,000 --> 00:00:01,000\\nHello Hermes\\n" > "$outdir/$base.srt"
echo "progress=25%" >&2
echo "progress=100%" >&2
echo "wrote subtitles for $src into $outdir"
`);
    const ffmpeg = await writeExecutable(path.join(toolsDir, "ffmpeg"), `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffmpeg test 1.0"
  exit 0
fi
if [ -n "$FFMPEG_ARGS_FILE" ]; then
  printf '%s\\n' "$@" > "$FFMPEG_ARGS_FILE"
fi
last=""
for arg in "$@"; do
  last="$arg"
done
echo "frame=1 fps=0.0 q=-1.0 size=0kB time=00:00:04.625 bitrate=0.0kbits/s speed=1x" >&2
printf "fake mp4" > "$last"
echo "rendered $last"
`);
    const source = path.join(dir, "source.mp4");
    const ffmpegArgsFile = path.join(dir, "ffmpeg-args.txt");
    await writeFile(source, "fake media fixture");

    await withEnv({
      ...VIDEO_STT_ENV_RESET,
      HERMES_FFPROBE_PATH: ffprobe,
      HERMES_FFMPEG_PATH: ffmpeg,
      HERMES_WHISPER_PATH: whisper,
      HERMES_AGENT_OS_ENABLE_EXEC: "1",
      FFMPEG_ARGS_FILE: ffmpegArgsFile
    }, async () => {
      const video = await createSelfModuleItem("video", {
        title: "Caption render fixture",
        sourcePath: source,
        workflow: "caption render",
        outputName: "captioned.mp4"
      });
      const result = await runVideoJob(video.items[0].id, { dryRun: false, operation: "caption_render", renderPreset: "square_1080" });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "executed");
      assert.equal(result.run.status, "completed");
      assert.equal(result.run.operation, "caption_render");
      assert.equal(result.run.commands.length, 2);
      assert.equal(result.run.commands[0].name, "whisper");
      assert.equal(result.run.commands[1].name, "ffmpeg");
      assert.equal(result.run.commands[1].preset, "square_1080");
      assert.equal(result.run.renderPlan.preset, "square_1080");
      assert.ok(result.run.commands[0].progressSamples?.some((sample) => sample.source === "progress" && sample.percent === 25));
      assert.ok(result.run.commands[1].progressSamples?.some((sample) => sample.source === "ffmpeg-time" && sample.percent > 40));
      assert.ok(result.run.progressDetails.samples.some((sample) => sample.command === "ffmpeg"));
      assert.ok(result.run.output.captions?.endsWith("/source.srt"));
      assert.ok(result.run.output.renderedVideo?.endsWith("/captioned.mp4"));
      assert.equal(result.state.items[0].captionOutput, result.run.output.captions);
      assert.equal(result.state.items[0].renderedOutput, result.run.output.renderedVideo);
      const ffmpegArgs = await readFile(ffmpegArgsFile, "utf8");
      assert.match(ffmpegArgs, /scale=1080:1080/);
      assert.match(ffmpegArgs, /subtitles=/);
      assert.match(ffmpegArgs, /libx264/);
      assert.equal(result.state.summary.video.completed, 1);
      assert.equal(JSON.stringify(result).includes(dir), false);
      assert.equal(JSON.stringify(result).includes(source), false);
    });
  });
});

test(
  "video worker transcribes through configured Groq cloud STT before local Whisper",
  { skip: isWindows ? "spawns a shebang fake ffprobe CLI (POSIX-only)" : false },
  async () => {
  await withHttpServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Bearer groq-test-secret");
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      assert.ok(body.includes("whisper-large-v3-turbo"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        text: "Cloud Hermes",
        segments: [{ start: 0, end: 1.5, text: "Cloud Hermes" }]
      }));
    });
  }, async (baseUrl) => {
    await withTempRuntime(async (dir) => {
      const toolsDir = path.join(dir, "tools");
      await mkdir(toolsDir, { recursive: true });
      const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":720,"height":1280,"avg_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"3.0","format_name":"mp4","size":"2000","bit_rate":"5000"}}
JSON
`);
      const source = path.join(dir, "cloud.mp4");
      await writeFile(source, "fake media fixture");

      await withEnv({
        ...VIDEO_STT_ENV_RESET,
        HERMES_FFPROBE_PATH: ffprobe,
        HERMES_FFMPEG_PATH: null,
        HERMES_WHISPER_PATH: null,
        HERMES_AGENT_OS_ENABLE_EXEC: "1",
        GROQ_API_KEY: "groq-test-secret",
        HERMES_GROQ_STT_URL: `${baseUrl}/audio/transcriptions`
      }, async () => {
        const worker = await getVideoWorkerStatus();
        assert.equal(worker.stt.defaultProvider, "groq");
        assert.equal(worker.stt.providers.find((provider) => provider.id === "groq").status, "connected");
        assert.equal(JSON.stringify(worker).includes("groq-test-secret"), false);

        const video = await createSelfModuleItem("video", {
          title: "Cloud STT fixture",
          sourcePath: source,
          workflow: "transcribe"
        });
        const result = await runVideoJob(video.items[0].id, { dryRun: false, operation: "transcribe" });
        assert.equal(result.ok, true);
        assert.equal(result.run.status, "completed");
        assert.equal(result.run.captionPlan.resolvedProvider, "groq");
        assert.equal(result.run.captionPlan.fallbackOrder[0], "groq");
        assert.equal(result.run.commands.length, 1);
        assert.equal(result.run.commands[0].name, "groq-stt");
        assert.equal(result.run.commands[0].model, "whisper-large-v3-turbo");
        assert.ok(result.run.output.captions.endsWith("/cloud.srt"));
        const srt = await resolveVideoRunOutput(result.run.id, "cloud.srt");
        assert.match(await readFile(srt.filePath, "utf8"), /Cloud Hermes/);
        const usage = await getSelfModuleState("usage-credits");
        assert.equal(usage.items[0].provider, "groq");
        assert.equal(usage.items[0].operation, "video_stt");
        assert.equal(JSON.stringify(result).includes("groq-test-secret"), false);
        assert.equal(JSON.stringify(result).includes(dir), false);
      });
    });
  });
});

test(
  "video worker falls back from failed cloud STT to local Whisper",
  { skip: isWindows ? "spawns shebang fake ffprobe/whisper CLIs (POSIX-only)" : false },
  async () => {
  await withHttpServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer groq-fallback-secret");
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "temporary provider error" } }));
    });
  }, async (baseUrl) => {
    await withTempRuntime(async (dir) => {
      const toolsDir = path.join(dir, "tools");
      await mkdir(toolsDir, { recursive: true });
      const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":720,"height":1280,"avg_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"4.0","format_name":"mp4","size":"2000","bit_rate":"5000"}}
JSON
`);
      const whisper = await writeExecutable(path.join(toolsDir, "whisper"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "whisper test help"
  exit 0
fi
outdir="."
src="$1"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output_dir" ]; then
    shift
    outdir="$1"
  fi
  shift
done
base=$(basename "$src" .mp4)
printf "1\\n00:00:00,000 --> 00:00:01,000\\nFallback Hermes\\n" > "$outdir/$base.srt"
echo "fallback subtitles"
`);
      const source = path.join(dir, "fallback.mp4");
      await writeFile(source, "fake media fixture");

      await withEnv({
        ...VIDEO_STT_ENV_RESET,
        HERMES_FFPROBE_PATH: ffprobe,
        HERMES_FFMPEG_PATH: null,
        HERMES_WHISPER_PATH: whisper,
        HERMES_AGENT_OS_ENABLE_EXEC: "1",
        GROQ_API_KEY: "groq-fallback-secret",
        HERMES_GROQ_STT_URL: `${baseUrl}/audio/transcriptions`
      }, async () => {
        const video = await createSelfModuleItem("video", {
          title: "Fallback STT fixture",
          sourcePath: source,
          workflow: "transcribe"
        });
        const result = await runVideoJob(video.items[0].id, { dryRun: false, operation: "transcribe" });
        assert.equal(result.ok, true);
        assert.equal(result.run.status, "completed");
        assert.deepEqual(result.run.captionPlan.fallbackOrder, ["groq", "whisper"]);
        assert.equal(result.run.commands[0].name, "groq-stt");
        assert.equal(result.run.commands[0].status, "error");
        assert.equal(result.run.commands[1].name, "whisper");
        assert.equal(result.run.commands[1].status, "completed");
        const srt = await resolveVideoRunOutput(result.run.id, "fallback.srt");
        assert.match(await readFile(srt.filePath, "utf8"), /Fallback Hermes/);
        assert.equal(JSON.stringify(result).includes("groq-fallback-secret"), false);
        assert.equal(JSON.stringify(result).includes(dir), false);
      });
    });
  });
});

test(
  "video queue runs caption render and resolves safe downloadable outputs",
  { skip: isWindows ? "spawns shebang fake ffprobe/ffmpeg/whisper CLIs (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const toolsDir = path.join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });
    const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":720,"height":1280,"avg_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"5.5","format_name":"mp4","size":"2000","bit_rate":"5000"}}
JSON
`);
    const whisper = await writeExecutable(path.join(toolsDir, "whisper"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "whisper test help"
  exit 0
fi
outdir="."
src="$1"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output_dir" ]; then
    shift
    outdir="$1"
  fi
  shift
done
base=$(basename "$src" .mp4)
printf "1\\n00:00:00,000 --> 00:00:01,000\\nQueued Hermes\\n" > "$outdir/$base.srt"
echo "queued subtitles"
`);
    const ffmpeg = await writeExecutable(path.join(toolsDir, "ffmpeg"), `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffmpeg test 1.0"
  exit 0
fi
last=""
for arg in "$@"; do
  last="$arg"
done
printf "queued mp4" > "$last"
echo "queued render"
`);
    const source = path.join(dir, "queued.mp4");
    await writeFile(source, "fake media fixture");

    await withEnv({
      ...VIDEO_STT_ENV_RESET,
      HERMES_FFPROBE_PATH: ffprobe,
      HERMES_FFMPEG_PATH: ffmpeg,
      HERMES_WHISPER_PATH: whisper,
      HERMES_AGENT_OS_ENABLE_EXEC: "1"
    }, async () => {
      const video = await createSelfModuleItem("video", {
        title: "Queued caption render",
        sourcePath: source,
        workflow: "caption render",
        outputName: "queued-captioned.mp4"
      });
      const queued = await queueVideoJob(video.items[0].id, { dryRun: false, operation: "caption_render" });
      assert.equal(queued.queued, true);
      assert.equal(queued.run.status, "queued");
      const done = await waitFor(async () => {
        const status = await getVideoRun(queued.run.id).catch((error) => {
          if (error?.status === 404) return null;
          throw error;
        });
        return status?.run.status === "completed" ? status : null;
      });
      assert.equal(done.run.status, "completed");
      assert.equal(done.run.progress, 100);
      assert.ok(done.run.output.captions.endsWith("/queued.srt"));
      assert.ok(done.run.output.renderedVideo.endsWith("/queued-captioned.mp4"));
      const srt = await resolveVideoRunOutput(done.run.id, "queued.srt");
      const mp4 = await resolveVideoRunOutput(done.run.id, "queued-captioned.mp4");
      assert.equal(srt.contentType, "application/x-subrip");
      assert.equal(mp4.contentType, "video/mp4");
      assert.equal(await readFile(srt.filePath, "utf8"), "1\n00:00:00,000 --> 00:00:01,000\nQueued Hermes\n");
      assert.equal(JSON.stringify(done).includes(dir), false);
      assert.equal(JSON.stringify(done).includes(source), false);
    });
  });
});

test(
  "video queue exposes command-derived progress while ffmpeg is running",
  { skip: isWindows ? "spawns shebang fake ffprobe/ffmpeg CLIs (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const toolsDir = path.join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });
    const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720,"avg_frame_rate":"30/1"}],"format":{"duration":"4.0","format_name":"mp4","size":"2000","bit_rate":"5000"}}
JSON
`);
    const ffmpeg = await writeExecutable(path.join(toolsDir, "ffmpeg"), `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffmpeg test 1.0"
  exit 0
fi
last=""
for arg in "$@"; do
  last="$arg"
done
echo "frame=1 fps=0.0 q=-1.0 size=0kB time=00:00:01.00 bitrate=0.0kbits/s speed=1x" >&2
sleep 0.5
echo "frame=2 fps=0.0 q=-1.0 size=0kB time=00:00:03.00 bitrate=0.0kbits/s speed=1x" >&2
printf "slow mp4" > "$last"
`);
    const source = path.join(dir, "slow.mp4");
    await writeFile(source, "fake media fixture");

    await withEnv({
      ...VIDEO_STT_ENV_RESET,
      HERMES_FFPROBE_PATH: ffprobe,
      HERMES_FFMPEG_PATH: ffmpeg,
      HERMES_WHISPER_PATH: null,
      HERMES_AGENT_OS_ENABLE_EXEC: "1"
    }, async () => {
      const video = await createSelfModuleItem("video", {
        title: "Slow render progress",
        sourcePath: source,
        workflow: "render",
        outputName: "slow-render.mp4"
      });
      const queued = await queueVideoJob(video.items[0].id, { dryRun: false, operation: "render" });
      const running = await waitFor(async () => {
        const status = await getVideoRun(queued.run.id).catch((error) => {
          if (error?.status === 404) return null;
          throw error;
        });
        return status?.run.status === "running" && (status.run.progress || 0) > 20 && status.run.progressDetails?.samples?.length ? status : null;
      }, { timeout: 2500 });
      assert.equal(running.run.progressDetails.currentCommand, "ffmpeg");
      assert.ok(running.run.progressDetails.samples.some((sample) => sample.source === "ffmpeg-time"));
      assert.ok(running.run.progress > 20);

      const done = await waitFor(async () => {
        const status = await getVideoRun(queued.run.id).catch((error) => {
          if (error?.status === 404) return null;
          throw error;
        });
        return status?.run.status === "completed" ? status : null;
      }, { timeout: 3000 });
      assert.equal(done.run.status, "completed");
      assert.equal(done.run.progress, 100);
      assert.ok(done.run.commands[0].progressSamples.some((sample) => sample.source === "ffmpeg-time"));
      assert.equal(JSON.stringify(done).includes(dir), false);
      assert.equal(JSON.stringify(done).includes(source), false);
    });
  });
});

test(
  "video queue can cancel a pending run before command execution",
  { skip: isWindows ? "spawns shebang fake ffprobe/whisper/ffmpeg CLIs (POSIX-only)" : false },
  async () => {
  await withTempRuntime(async (dir) => {
    const toolsDir = path.join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });
    const ffprobe = await writeExecutable(path.join(toolsDir, "ffprobe"), `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360,"avg_frame_rate":"24/1"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"3.5","format_name":"mp4","size":"1000","bit_rate":"2000"}}
JSON
`);
    const whisper = await writeExecutable(path.join(toolsDir, "whisper"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "whisper test help"
  exit 0
fi
sleep 1
outdir="."
src="$1"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output_dir" ]; then
    shift
    outdir="$1"
  fi
  shift
done
base=$(basename "$src" .mp4)
printf "1\\n00:00:00,000 --> 00:00:01,000\\nSlow Hermes\\n" > "$outdir/$base.srt"
`);
    const ffmpeg = await writeExecutable(path.join(toolsDir, "ffmpeg"), `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffmpeg test 1.0"
  exit 0
fi
last=""
for arg in "$@"; do
  last="$arg"
done
printf "queued mp4" > "$last"
`);
    const sourceA = path.join(dir, "first.mp4");
    const sourceB = path.join(dir, "second.mp4");
    await writeFile(sourceA, "fake media fixture");
    await writeFile(sourceB, "fake media fixture");

    await withEnv({
      ...VIDEO_STT_ENV_RESET,
      HERMES_FFPROBE_PATH: ffprobe,
      HERMES_FFMPEG_PATH: ffmpeg,
      HERMES_WHISPER_PATH: whisper,
      HERMES_AGENT_OS_ENABLE_EXEC: "1"
    }, async () => {
      const first = await createSelfModuleItem("video", {
        title: "First queued render",
        sourcePath: sourceA,
        workflow: "caption render",
        outputName: "first.mp4"
      });
      const second = await createSelfModuleItem("video", {
        title: "Second queued render",
        sourcePath: sourceB,
        workflow: "caption render",
        outputName: "second.mp4"
      });
      const firstQueued = await queueVideoJob(first.items[0].id, { dryRun: false, operation: "caption_render" });
      const secondQueued = await queueVideoJob(second.items[0].id, { dryRun: false, operation: "caption_render" });
      const canceled = await cancelVideoRun(secondQueued.run.id);
      assert.ok(["canceled", "cancel_requested"].includes(canceled.run.status));
      const finalSecond = await waitFor(async () => {
        const status = await getVideoRun(secondQueued.run.id);
        return ["canceled", "completed", "error"].includes(status.run.status) ? status : null;
      }, { timeout: 8000 });
      assert.ok(finalSecond, "queued video run never reached a terminal status");
      assert.equal(finalSecond.run.status, "canceled");
      const finalFirst = await waitFor(async () => {
        const status = await getVideoRun(firstQueued.run.id);
        return status.run.status === "completed" ? status : null;
      }, { timeout: 8000 });
      assert.ok(finalFirst, "first queued video run did not complete");
      assert.equal(finalFirst.run.status, "completed");
      assert.equal(JSON.stringify(finalSecond).includes(dir), false);
    });
  });
});

test("goals run provider-router backed planning loops with dry-run safety", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      const goals = await createSelfModuleItem("goals", {
        title: "Ship autonomous goal loop",
        notes: `Avoid leaking ${os.homedir()} or local secrets.`
      });
      const goal = goals.items[0];
      const result = await runGoalLoop(goal.id, {
        provider: "openrouter",
        context: "Create the next safe implementation step."
      });

      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.run.status, "planned");
      assert.equal(result.run.provider, "openrouter");
      assert.equal(result.state.items[0].loopCount, 1);
      assert.equal(result.state.items[0].status, "in_progress");
      assert.ok(result.state.items[0].nextAction);
      assert.ok(result.state.summary.goals.loopRuns >= 1);

      const usage = await getUsageState();
      assert.equal(usage.items[0].operation, "goal_loop");
      assert.equal(usage.items[0].source, "goals");
      assert.equal(usage.items[0].provider, "openrouter");
      assert.equal(JSON.stringify(result).includes("placeholder-openrouter-key"), false);
      assert.equal(JSON.stringify(result).includes(os.homedir()), false);

      const logs = await getModuleLogs("goals");
      assert.ok(logs.logs.some((entry) => entry.message === "Goal loop run planned"));
      assert.equal(JSON.stringify(logs).includes("placeholder-openrouter-key"), false);
    });
  });
});

test("goals report ready_to_configure when no provider router backend is configured", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const goals = await createSelfModuleItem("goals", { title: "Needs a provider", notes: "No keys yet" });
      const result = await runGoalLoop(goals.items[0].id);

      assert.equal(result.ok, false);
      assert.equal(result.mode, "ready_to_configure");
      assert.equal(result.run.status, "ready_to_configure");
      assert.equal(result.state.items[0].loopCount, 1);
      assert.match(result.state.items[0].nextAction || "", /Configure/);
    });
  });
});

test("seo audits route through Firecrawl planning and Provider Router dry-run", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      await configureConnection("provider-firecrawl", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
      const seo = await createSelfModuleItem("seo", {
        title: "Homepage audit",
        url: "https://example.com",
        keyword: "agent os",
        notes: `Do not leak ${os.homedir()}`
      });
      const brief = seo.items[0];
      const result = await runSeoAudit(brief.id, {
        provider: "openrouter",
        context: "Find missing on-page improvements."
      });

      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.run.status, "planned");
      assert.equal(result.run.scrape.status, "planned");
      assert.equal(result.run.provider, "openrouter");
      assert.equal(result.state.items[0].auditCount, 1);
      assert.equal(result.state.items[0].status, "audited");
      assert.ok(result.state.items[0].recommendations?.length);
      assert.ok(result.state.summary.seo.auditRuns >= 1);

      const usage = await getUsageState();
      assert.equal(usage.items[0].operation, "seo_audit");
      assert.equal(usage.items[0].source, "seo");
      assert.equal(usage.items[0].provider, "openrouter");
      assert.equal(JSON.stringify(result).includes("placeholder-openrouter-key"), false);
      assert.equal(JSON.stringify(result).includes("placeholder-firecrawl-key"), false);
      assert.equal(JSON.stringify(result).includes(os.homedir()), false);

      const logs = await getModuleLogs("seo");
      assert.ok(logs.logs.some((entry) => entry.message === "SEO audit run recorded"));
      assert.equal(JSON.stringify(logs).includes("placeholder-firecrawl-key"), false);
    });
  });
});

test("seo audit reports setup state when Firecrawl and router providers are missing", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const seo = await createSelfModuleItem("seo", {
        title: "Needs SEO config",
        url: "https://example.com",
        keyword: "agent os"
      });
      const result = await runSeoAudit(seo.items[0].id, { dryRun: false });

      assert.equal(result.ok, false);
      assert.equal(result.run.status, "ready_to_configure");
      assert.equal(result.run.scrape.status, "ready_to_configure");
      assert.ok(result.run.scrape.missing.includes("FIRECRAWL_API_KEY"));
      assert.match(result.run.recommendations.join(" "), /Configure/);
    });
  });
});

test("seo audit executes Firecrawl scrape only with explicit execution gate", async () => {
  await withTempRuntime(async () => {
    let authHeader = "";
    let receivedUrl = "";
    await withHttpServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/scrape") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      authHeader = req.headers.authorization || "";
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        receivedUrl = JSON.parse(body).url;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          success: true,
          data: {
            markdown: "# Example page\\nHermes Agent OS local-first SEO automation page.",
            metadata: {
              title: "Example page",
              description: "Hermes SEO test",
              statusCode: 200,
              sourceURL: receivedUrl
            }
          }
        }));
      });
    }, async (baseUrl) => {
      await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: "1", HERMES_FIRECRAWL_SCRAPE_URL: `${baseUrl}/scrape` }, async () => {
        await configureConnection("provider-firecrawl", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
        const seo = await createSelfModuleItem("seo", {
          title: "Live scrape",
          url: "https://example.com/path",
          keyword: "agent os"
        });
        const result = await runSeoAudit(seo.items[0].id, { dryRun: false });

        assert.equal(authHeader, "Bearer placeholder-firecrawl-key");
        assert.equal(receivedUrl, "https://example.com/path");
        assert.equal(result.run.scrape.status, "completed");
        assert.ok((result.run.scrape.page?.markdownChars || 0) > 20);
        assert.equal(result.run.status, "ready_to_configure");
        assert.equal(JSON.stringify(result).includes("placeholder-firecrawl-key"), false);
        assert.equal(JSON.stringify(result).includes(os.homedir()), false);
      });
    });
  });
});

test("seo competitor discovery plans Firecrawl search and stores sanitized history", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-firecrawl", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
      const seo = await createSelfModuleItem("seo", {
        title: "Competitor scan",
        url: "https://example.com",
        keyword: "agent os",
        notes: `private ${os.homedir()}`
      });
      const result = await runSeoDiscovery(seo.items[0].id, { limit: 5 });

      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.run.status, "planned");
      assert.equal(result.run.plannedRequest.excludeDomains.includes("example.com"), true);
      assert.equal(result.state.items[0].discoveryCount, 1);
      assert.equal(result.state.items[0].status, "researched");
      assert.equal(JSON.stringify(result).includes("placeholder-firecrawl-key"), false);
      assert.equal(JSON.stringify(result).includes(os.homedir()), false);

      const logs = await getModuleLogs("seo");
      assert.ok(logs.logs.some((entry) => entry.message === "SEO competitor discovery recorded"));
    });
  });
});

test("seo competitor discovery and rank snapshot execute through Firecrawl search gate", async () => {
  await withTempRuntime(async () => {
    const requests = [];
    let authHeader = "";
    await withHttpServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/search") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      authHeader = req.headers.authorization || "";
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          success: true,
          data: {
            web: [
              { title: "Competitor A", description: "Agent OS competitor", url: "https://competitor.example/a" },
              { title: "Hermes Target", description: "Hermes Agent OS", url: "https://example.com/" },
              { title: "Competitor B", description: "Builder competitor", url: "https://builder.example/b" }
            ]
          },
          id: "search_123",
          creditsUsed: 2
        }));
      });
    }, async (baseUrl) => {
      await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: "1", HERMES_FIRECRAWL_SEARCH_URL: `${baseUrl}/search` }, async () => {
        await configureConnection("provider-firecrawl", { FIRECRAWL_API_KEY: "placeholder-firecrawl-key" });
        const seo = await createSelfModuleItem("seo", {
          title: "Live search",
          url: "https://example.com",
          keyword: "agent os"
        });

        const discovery = await runSeoDiscovery(seo.items[0].id, { dryRun: false, limit: 3 });
        assert.equal(authHeader, "Bearer placeholder-firecrawl-key");
        assert.equal(discovery.run.status, "completed");
        assert.equal(discovery.run.competitors.length, 2);
        assert.equal(discovery.state.items[0].competitors.length, 2);
        assert.equal(requests[0].excludeDomains.includes("example.com"), true);

        const rank = await runSeoRankSnapshot(discovery.state.items[0].id, { dryRun: false, limit: 3 });
        assert.equal(rank.run.status, "completed");
        assert.equal(rank.run.snapshot.targetPosition, 2);
        assert.equal(rank.state.items[0].rankCount, 1);
        assert.equal(rank.state.items[0].rankSnapshots[0].targetPosition, 2);
        assert.equal(requests[1].excludeDomains, undefined);

        const usage = await getUsageState();
        assert.ok(usage.items.some((item) => item.operation === "seo_competitor_discovery" && item.provider === "firecrawl"));
        assert.ok(usage.items.some((item) => item.operation === "seo_rank_snapshot" && item.provider === "firecrawl"));
        assert.equal(JSON.stringify(rank).includes("placeholder-firecrawl-key"), false);
        assert.equal(JSON.stringify(rank).includes(os.homedir()), false);
      });
    });
  });
});

test("seo rank snapshot reports setup state when Firecrawl search is missing", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const seo = await createSelfModuleItem("seo", {
        title: "Needs search config",
        url: "https://example.com",
        keyword: "agent os"
      });
      const result = await runSeoRankSnapshot(seo.items[0].id, { dryRun: false });

      assert.equal(result.ok, false);
      assert.equal(result.run.status, "ready_to_configure");
      assert.ok(result.run.missing.includes("FIRECRAWL_API_KEY"));
      assert.equal(result.state.items[0].rankCount, 1);
      assert.equal(result.state.items[0].rankSnapshots[0].status, "ready_to_configure");
    });
  });
});

test("memory module stores typed per-agent memories and retrieves by filtered search", async () => {
  await withTempRuntime(async () => {
    await addMemory({
      type: "semantic",
      agentId: "claude",
      namespace: "setup",
      title: "Ollama routing preference",
      content: "Use Ollama for local Claude Code-style routing when the user wants free local runs.",
      tags: ["ollama", "routing"],
      privacy: "shared",
      importance: 0.9
    });
    await addMemory({
      type: "episodic",
      agentId: "codex",
      namespace: "runs",
      title: "Workflow retry fixed",
      content: "Workflow execution retry and human approval resume were verified in tests.",
      tags: ["workflow"],
      privacy: "exportable",
      importance: 0.7
    });

    let state = await getMemoryState();
    assert.equal(state.summary.total, 2);
    assert.equal(state.summary.byType.semantic, 1);
    assert.equal(state.summary.byAgent.claude, 1);

    const result = await searchMemory({ query: "ollama routing", type: "semantic", agentId: "claude" });
    assert.equal(result.count, 1);
    assert.equal(result.results[0].title, "Ollama routing preference");

    state = await getMemoryState();
    const remembered = state.memories.find((memory) => memory.title === "Ollama routing preference");
    assert.equal(remembered?.accessCount, 1);
    assert.ok(remembered?.lastAccessedAt);
  });
});

test("memory vector search indexes local memories and returns vector scores", async () => {
  await withTempRuntime(async () => {
    await addMemory({
      type: "semantic",
      agentId: "hermes",
      namespace: "providers",
      title: "Ollama local model routing",
      content: "Route Claude-style coding work through local Ollama models when users want private no-cloud runs.",
      tags: ["ollama", "local-models"],
      privacy: "shared",
      importance: 0.9
    });
    await addMemory({
      type: "semantic",
      agentId: "hermes",
      namespace: "billing",
      title: "Usage credit limit",
      content: "Block provider calls when daily or monthly usage budgets would be exceeded.",
      tags: ["usage", "budget"],
      privacy: "shared",
      importance: 0.5
    });

    let state = await getMemoryState();
    assert.equal(state.vector.provider, "local-hash");
    assert.equal(state.vector.status, "connected");

    const rebuilt = await rebuildMemoryVectorIndex({ force: true });
    assert.equal(rebuilt.ok, true);
    assert.equal(rebuilt.indexed, 2);

    const result = await searchMemory({ query: "private local model route", mode: "vector", limit: 2 });
    assert.equal(result.mode, "vector");
    assert.equal(result.vector.provider, "local-hash");
    assert.equal(result.vector.index.vectorCount, 2);
    assert.equal(result.results[0].title, "Ollama local model routing");
    assert.ok(Number(result.results[0].vectorScore) > 0);
    assert.equal(JSON.stringify(result).includes(os.homedir()), false);

    state = await getMemoryState();
    assert.equal(state.vector.index.vectorCount, 2);
    assert.equal(state.vector.index.stale, false);
  });
});

test("memory vector provider config reports missing provider dependencies honestly", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const state = await configureMemoryVector({
        provider: "openai",
        model: "text-embedding-3-small",
        enabled: true,
        clearIndex: true
      });
      assert.equal(state.vector.status, "ready_to_configure");
      assert.equal(state.vector.configured, false);
      assert.ok(state.vector.missing.includes("OPENAI_API_KEY"));

      const rebuilt = await rebuildMemoryVectorIndex();
      assert.equal(rebuilt.ok, false);
      assert.equal(rebuilt.status, "ready_to_configure");
      assert.equal(JSON.stringify(rebuilt).includes("OPENAI_API_KEY=configured"), false);
    });
  });
});

test("memory vector index can use configured Ollama embeddings", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await withHttpServer((req, res) => {
        assert.equal(req.url, "/api/embeddings");
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const payload = JSON.parse(body);
          assert.equal(payload.model, "nomic-embed-text");
          const text = String(payload.prompt || "").toLowerCase();
          const embedding = text.includes("ollama") || text.includes("local") ? [1, 0, 0, 0] : [0, 1, 0, 0];
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ embedding }));
        });
      }, async (baseUrl) => {
        await configureConnection("provider-ollama", { OLLAMA_HOST: baseUrl });
        await configureMemoryVector({ provider: "ollama", model: "nomic-embed-text", enabled: true });
        await addMemory({
          title: "Ollama embeddings",
          content: "Use local Ollama embedding vectors for private semantic memory.",
          privacy: "shared"
        });
        await addMemory({
          title: "Budget controls",
          content: "Track credits and usage budgets for provider calls.",
          privacy: "shared"
        });

        const rebuilt = await rebuildMemoryVectorIndex({ force: true });
        assert.equal(rebuilt.ok, true);
        assert.equal(rebuilt.vector.provider, "ollama");
        assert.equal(rebuilt.vector.index.vectorCount, 2);

        const search = await searchMemory({ query: "local ollama vector", mode: "vector", limit: 2 });
        assert.equal(search.results[0].title, "Ollama embeddings");
        assert.equal(search.vector.provider, "ollama");
      });
    });
  });
});

test("memory vector index can sync and search a Qdrant remote collection", async () => {
  await withTempRuntime(async () => {
    const collection = "hermes_memory_test";
    let routedMemoryId = "";
    let budgetMemoryId = "";
    let sawApiKey = false;
    let createdCollection = false;
    let upsertedPoints = [];

    await withHttpServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      sawApiKey = sawApiKey || req.headers["api-key"] === "qdrant-secret";
      if (req.method === "GET" && url.pathname === `/collections/${collection}`) {
        res.statusCode = createdCollection ? 200 : 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(createdCollection ? { result: { status: "green" } } : { status: { error: "not found" } }));
        return;
      }
      if (req.method === "PUT" && url.pathname === `/collections/${collection}`) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          assert.equal(payload.vectors.distance, "Cosine");
          createdCollection = true;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ result: true }));
        });
        return;
      }
      if (req.method === "PUT" && url.pathname === `/collections/${collection}/points`) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          upsertedPoints = payload.points || [];
          assert.equal(upsertedPoints.length, 2);
          assert.ok(upsertedPoints.every((point) => point.payload.memoryId));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ result: { operation_id: 1, status: "completed" } }));
        });
        return;
      }
      if (req.method === "POST" && url.pathname === `/collections/${collection}/points/search`) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          result: [
            { id: upsertedPoints.find((point) => point.payload.memoryId === routedMemoryId)?.id, score: 0.97, payload: { memoryId: routedMemoryId } },
            { id: upsertedPoints.find((point) => point.payload.memoryId === budgetMemoryId)?.id, score: 0.11, payload: { memoryId: budgetMemoryId } }
          ]
        }));
        return;
      }
      res.statusCode = 500;
      res.end(`unexpected ${req.method} ${url.pathname}`);
    }, async (baseUrl) => {
      const configured = await configureMemoryVector({
        provider: "qdrant",
        embeddingProvider: "local-hash",
        model: "local-hash-v1",
        dimensions: 32,
        endpoint: baseUrl,
        collection,
        apiKey: "qdrant-secret",
        enabled: true
      });
      assert.equal(configured.vector.status, "connected");
      assert.equal(configured.vector.provider, "qdrant");
      assert.equal(configured.vector.remote.collection, collection);
      assert.equal(configured.vector.remote.hasApiKey, true);
      assert.equal(JSON.stringify(configured).includes("qdrant-secret"), false);

      const routed = await addMemory({
        title: "Remote vector routing",
        content: "Store Hermes agent memory in a remote Qdrant vector collection.",
        privacy: "shared"
      });
      routedMemoryId = routed.memory.id;
      const budget = await addMemory({
        title: "Budget ledger",
        content: "Usage credits track provider spend and invoice imports.",
        privacy: "shared"
      });
      budgetMemoryId = budget.memory.id;

      const rebuilt = await rebuildMemoryVectorIndex({ force: true });
      assert.equal(rebuilt.ok, true);
      assert.equal(rebuilt.vector.provider, "qdrant");
      assert.equal(rebuilt.vector.index.vectorCount, 2);
      assert.equal(createdCollection, true);
      assert.equal(sawApiKey, true);

      const search = await searchMemory({ query: "remote qdrant memory", mode: "vector", limit: 2 });
      assert.equal(search.vector.provider, "qdrant");
      assert.equal(search.results[0].title, "Remote vector routing");
      assert.ok(Number(search.results[0].vectorScore) > 0.9);
      assert.equal(JSON.stringify(search).includes("qdrant-secret"), false);
    });
  });
});

test("memory export excludes private records and redacts secrets and local paths", async () => {
  await withTempRuntime(async () => {
    await addMemory({
      type: "semantic",
      agentId: "global",
      title: "Private local path",
      content: `This private memory has ${os.homedir()} and must not export.`,
      privacy: "private"
    });
    await addMemory({
      type: "procedural",
      agentId: "hermes",
      title: "Safe setup playbook",
      content: `Run setup from ${os.homedir()}/Desktop with OPENAI_API_KEY=${"sk"}-testbadbadbadbadbadbadbad.`,
      privacy: "exportable",
      tags: ["setup"]
    });

    const exported = await exportMemory();
    assert.equal(exported.memories.length, 1);
    const text = JSON.stringify(exported);
    assert.equal(text.includes("Private local path"), false);
    assert.equal(text.includes(os.homedir()), false);
    assert.equal(text.includes(`${"sk"}-testbadbadbadbadbadbadbad`), false);
    assert.match(text, /OPENAI_API_KEY=configured/);
  });
});

test("memory import and privacy updates are persisted", async () => {
  await withTempRuntime(async () => {
    const imported = await importMemory({
      memories: [
        {
          type: "procedural",
          agentId: "seo",
          namespace: "playbooks",
          title: "SEO crawl playbook",
          content: "Use Firecrawl first, then summarize crawl findings into a brief.",
          privacy: "shared",
          tags: ["seo", "firecrawl"]
        }
      ]
    });
    assert.equal(imported.imported, 1);

    const memory = imported.state.memories[0];
    const updated = await updateMemory(memory.id, { privacy: "exportable", archived: true });
    assert.equal(updated.memory.privacy, "exportable");
    assert.equal(updated.memory.archived, true);

    const search = await searchMemory({ query: "Firecrawl", includeArchived: true });
    assert.equal(search.count, 1);
    assert.equal(search.results[0].archived, true);
  });
});

test("skill registry installs configures tests disables and enables skills with logs", async () => {
  await withTempRuntime(async () => {
    let registry = await getSkillRegistry();
    assert.ok(registry.skills.find((skill) => skill.id === "seo-research-agent"));
    assert.equal(registry.summary.installed, 0);

    let skill = await installSkill("seo-research-agent");
    assert.equal(skill.installed, true);
    assert.equal(skill.enabled, true);
    assert.equal(skill.status, "ready_to_configure");
    assert.ok(skill.missing.includes("FIRECRAWL_API_KEY"));
    assert.ok(skill.missing.some((item) => item.includes("OPENROUTER_API_KEY")));

    let testResult = await testSkill("seo-research-agent");
    assert.equal(testResult.ok, false);
    assert.equal(testResult.status, "ready_to_configure");

    skill = await configureSkill("seo-research-agent", {
      FIRECRAWL_API_KEY: "placeholder-firecrawl-key",
      OPENROUTER_API_KEY: "placeholder-openrouter-key"
    });
    assert.equal(skill.status, "enabled");
    assert.deepEqual(skill.missing, []);
    assert.equal(JSON.stringify(skill).includes("placeholder-firecrawl-key"), false);

    testResult = await testSkill("seo-research-agent");
    assert.equal(testResult.ok, true);
    assert.equal(testResult.status, "enabled");

    skill = await setSkillEnabled("seo-research-agent", false);
    assert.equal(skill.status, "disabled");
    testResult = await testSkill("seo-research-agent");
    assert.equal(testResult.ok, false);
    assert.equal(testResult.status, "disabled");

    skill = await setSkillEnabled("seo-research-agent", true);
    assert.equal(skill.status, "enabled");

    const logs = await getSkillLogs("seo-research-agent");
    assert.ok(logs.logs.some((entry) => entry.message === "Skill installed"));
    assert.ok(logs.logs.some((entry) => entry.message === "Skill configuration saved"));
    assert.ok(logs.logs.some((entry) => entry.message === "Skill disabled"));
    assert.equal(JSON.stringify(logs).includes("placeholder-openrouter-key"), false);

    registry = await getSkillRegistry();
    assert.equal(registry.summary.installed, 1);
    assert.equal(registry.summary.enabled, 1);
  });
});

test("skill registry exposes export-safe sample manifests without local config", () => {
  const samples = getSampleSkillManifests();
  assert.ok(samples.length >= 3);
  assert.ok(samples.every((skill) => skill.id && skill.version && Array.isArray(skill.capabilities)));
  const text = JSON.stringify(samples);
  assert.equal(text.includes("placeholder-"), false);
  assert.equal(text.includes("configuredFields"), false);
});

test("skill registry imports signed external bundles and exposes update state", async () => {
  await withTempRuntime(async () => {
    const manifest = {
      id: "external-lead-router",
      label: "External Lead Router",
      version: "1.0.0",
      category: "lead",
      description: "Route inbound leads through configured Hermes providers.",
      requiredKeys: ["OPENROUTER_API_KEY"],
      requiredAnyKeys: [["FIRECRAWL_API_KEY", "OLLAMA_HOST"]],
      optionalKeys: ["HERMES_OPENROUTER_MODEL"],
      capabilities: ["lead-routing", "qualification"],
      permissions: ["model", "workflow", "memory", "network"],
      samplePrompt: "Qualify this lead and choose the next workflow.",
      exportSafe: true
    };
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const imported = await importSkillBundle(createSignedSkillBundle(manifest, keyPair));
    assert.equal(imported.verification.ok, true);
    assert.equal(imported.skill.id, "external-lead-router");
    assert.equal(imported.skill.source, "external");
    assert.equal(imported.skill.signatureVerified, true);
    assert.ok(imported.skill.publisherFingerprint);
    assert.deepEqual(imported.skill.permissions, ["model", "workflow", "memory", "network"]);

    let skill = await installSkill("external-lead-router");
    assert.equal(skill.installed, true);
    assert.equal(skill.status, "ready_to_configure");
    assert.equal(skill.missing.includes("OPENROUTER_API_KEY"), true);

    skill = await configureSkill("external-lead-router", {
      OPENROUTER_API_KEY: "placeholder-openrouter-key",
      FIRECRAWL_API_KEY: "placeholder-firecrawl-key"
    });
    assert.equal(skill.status, "enabled");
    assert.equal(JSON.stringify(skill).includes("placeholder-openrouter-key"), false);

    const updatedBundle = createSignedSkillBundle({ ...manifest, version: "1.1.0" }, keyPair);
    const updated = await importSkillBundle(updatedBundle);
    assert.equal(updated.skill.latestVersion, "1.1.0");
    assert.equal(updated.skill.updateAvailable, true);

    const registry = await getSkillRegistry();
    assert.equal(registry.summary.external, 1);
    assert.equal(registry.summary.signed, 1);
    assert.equal(registry.summary.updates, 1);
    assert.equal(JSON.stringify(registry).includes(os.homedir()), false);

    const logs = await getSkillLogs("external-lead-router");
    assert.ok(logs.logs.some((entry) => entry.message === "External skill bundle imported"));
    assert.ok(logs.logs.some((entry) => entry.message === "External skill bundle updated"));
    assert.equal(JSON.stringify(logs).includes("placeholder-firecrawl-key"), false);
  });
});

test("skill registry enforces signed manifest dependencies before install and enable", async () => {
  await withTempRuntime(async () => {
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const baseManifest = {
      id: "external-base-provider",
      label: "External Base Provider",
      version: "1.0.0",
      category: "provider",
      description: "Base dependency skill for downstream external skills.",
      capabilities: ["base-provider"],
      permissions: ["model"],
      exportSafe: true
    };
    const childManifest = {
      id: "external-dependent-agent",
      label: "External Dependent Agent",
      version: "1.0.0",
      updateChannel: "stable",
      category: "agents",
      description: "Depends on the base provider skill.",
      dependencies: [{ id: "external-base-provider", version: "1.0.0", reason: "Routes provider calls." }],
      capabilities: ["agent-routing"],
      permissions: ["model", "workflow"],
      exportSafe: true
    };

    await importSkillBundle(createSignedSkillBundle(childManifest, keyPair));
    await assert.rejects(
      () => installSkill("external-dependent-agent"),
      /missing required dependencies/i
    );

    let child = await installSkill("external-dependent-agent", { allowMissingDependencies: true });
    assert.equal(child.installed, true);
    assert.equal(child.enabled, false);
    assert.equal(child.dependencyReady, false);
    assert.equal(child.dependencyStatus[0].status, "missing");
    assert.equal(child.dependencySuggestions[0].action, "import_signed_bundle");
    assert.equal(child.dependencySuggestions[0].autoInstallable, false);

    await assert.rejects(
      () => setSkillEnabled("external-dependent-agent", true),
      /missing required dependencies/i
    );

    await importSkillBundle(createSignedSkillBundle(baseManifest, keyPair));
    child = await getSkill("external-dependent-agent");
    assert.equal(child.dependencySuggestions[0].action, "install_skill");
    assert.equal(child.dependencySuggestions[0].command, "POST /api/skills/external-base-provider/install");

    const prepared = await prepareSkillDependencies("external-dependent-agent");
    assert.equal(prepared.mode, "dry_run");
    assert.equal(prepared.executed, false);
    assert.equal(prepared.suggestions[0].action, "install_skill");
    assert.equal(JSON.stringify(prepared).includes(os.homedir()), false);

    const base = await installSkill("external-base-provider");
    assert.equal(base.status, "enabled");

    child = await setSkillEnabled("external-dependent-agent", true);
    assert.equal(child.status, "enabled");
    assert.equal(child.dependencyReady, true);
    assert.equal(child.dependencyStatus[0].status, "satisfied");

    const registry = await getSkillRegistry();
    assert.equal(registry.summary.dependencyBlocked, 0);
    assert.equal(JSON.stringify(registry).includes(os.homedir()), false);
  });
});

test("skill registry updates installed skills from trusted marketplace update channels", async () => {
  await withTempRuntime(async () => {
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const manifest = {
      id: "marketplace-update-agent",
      label: "Marketplace Update Agent",
      version: "1.0.0",
      updateChannel: "stable",
      category: "agents",
      description: "A signed marketplace skill with update channel metadata.",
      capabilities: ["agent-routing"],
      permissions: ["model"],
      releaseNotes: [
        {
          version: "1.0.0",
          title: "Initial marketplace release",
          items: ["Adds signed marketplace install support."]
        }
      ],
      exportSafe: true
    };
    let bundle = createSignedSkillBundle(manifest, keyPair);

    await withHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "hermes.skill.feed", schemaVersion: 1, skills: [bundle] }));
    }, async (baseUrl) => {
      await saveSkillMarketplaceFeed({ id: "update-feed", label: "Update Feed", url: `${baseUrl}/skills.json` });
      let fetched = await fetchSkillMarketplaceFeed("update-feed");
      const fingerprint = fetched.imported[0].publisherFingerprint;

      await trustSkillPublisher(fingerprint, { label: "Update Publisher" });
      await importMarketplaceSkill("update-feed", "marketplace-update-agent");
      let skill = await installSkill("marketplace-update-agent");
      assert.equal(skill.version, "1.0.0");
      assert.equal(skill.updateChannel, "stable");
      assert.equal(skill.updateAvailable, false);
      assert.equal(skill.releaseNotes[0].title, "Initial marketplace release");

      bundle = createSignedSkillBundle({
        ...manifest,
        version: "1.2.0",
        releaseNotes: [
          {
            version: "1.2.0",
            title: "Router compatibility update",
            channel: "stable",
            items: ["Adds dependency-aware setup hints.", "Keeps marketplace release notes export-safe."]
          }
        ]
      }, keyPair);
      fetched = await fetchSkillMarketplaceFeed("update-feed");
      assert.equal(fetched.imported[0].updateAvailable, true);
      assert.equal(fetched.imported[0].installedVersion, "1.0.0");
      assert.equal(fetched.imported[0].updateChannel, "stable");
      assert.equal(fetched.imported[0].releaseNotes[0].title, "Router compatibility update");

      let registry = await getSkillRegistry();
      skill = registry.skills.find((entry) => entry.id === "marketplace-update-agent");
      assert.equal(skill?.updateAvailable, true);
      assert.equal(skill?.latestVersion, "1.2.0");
      assert.equal(skill?.availableUpdate?.feedId, "update-feed");
      assert.equal(skill?.availableUpdate?.releaseNotes[0].items[0], "Adds dependency-aware setup hints.");

      const updated = await updateSkill("marketplace-update-agent");
      assert.equal(updated.skill.version, "1.2.0");
      assert.equal(updated.skill.updateAvailable, false);
      assert.equal(updated.skill.releaseNotes[0].version, "1.2.0");
      assert.equal(updated.marketplace.summary.updateItems, 0);

      registry = await getSkillRegistry();
      skill = registry.skills.find((entry) => entry.id === "marketplace-update-agent");
      assert.equal(skill?.version, "1.2.0");
      assert.equal(skill?.updateAvailable, false);

      const logs = await getSkillLogs("marketplace-update-agent");
      assert.ok(logs.logs.some((entry) => entry.message === "Marketplace skill updated"));
    });
  });
});

test("skill marketplace fetches signed remote feed and redacts feed URLs", async () => {
  await withTempRuntime(async () => {
    const manifest = {
      id: "marketplace-seo-scout",
      label: "Marketplace SEO Scout",
      version: "1.0.0",
      category: "seo",
      description: "Research pages through configured model and crawl providers.",
      requiredKeys: ["FIRECRAWL_API_KEY"],
      requiredAnyKeys: [["OPENROUTER_API_KEY", "OLLAMA_HOST"]],
      capabilities: ["seo", "crawl"],
      permissions: ["model", "network"],
      exportSafe: true
    };
    const bundle = createSignedSkillBundle(manifest);

    await withHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        kind: "hermes.skill.feed",
        schemaVersion: 1,
        skills: [{ bundle }]
      }));
    }, async (baseUrl) => {
      const saved = await saveSkillMarketplaceFeed({
        id: "community",
        label: "Community Skills",
        url: `${baseUrl}/feed?token=secret-feed-token`
      });
      assert.equal(saved.feeds[0].url.includes("secret-feed-token"), false);
      assert.equal(saved.feeds[0].url.includes("redacted"), true);

      const fetched = await fetchSkillMarketplaceFeed("community");
      assert.equal(fetched.ok, true);
      assert.equal(fetched.imported.length, 1);
      assert.equal(fetched.rejected.length, 0);
      assert.equal(fetched.imported[0].skillId, "marketplace-seo-scout");
      assert.equal(fetched.imported[0].publisherTrusted, false);
      assert.equal(JSON.stringify(fetched).includes("secret-feed-token"), false);

      const marketplace = await getSkillMarketplace();
      assert.equal(marketplace.summary.feeds, 1);
      assert.equal(marketplace.summary.items, 1);
      assert.equal(marketplace.summary.untrustedItems, 1);

      const registry = await getSkillRegistry();
      assert.equal(registry.summary.marketplaceFeeds, 1);
      assert.equal(registry.summary.marketplaceItems, 1);
      assert.equal(registry.summary.marketplaceTrustedItems, 0);
    });
  });
});

test("skill marketplace requires trusted publisher before import", async () => {
  await withTempRuntime(async () => {
    const manifest = {
      id: "marketplace-memory-reviewer",
      label: "Marketplace Memory Reviewer",
      version: "1.0.0",
      category: "memory",
      description: "Review run notes and propose export-safe memory entries.",
      capabilities: ["memory-review"],
      permissions: ["memory"],
      exportSafe: true
    };
    const bundle = createSignedSkillBundle(manifest);

    await withHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "hermes.skill.feed", schemaVersion: 1, skills: [bundle] }));
    }, async (baseUrl) => {
      await saveSkillMarketplaceFeed({ id: "trusted-feed", label: "Trusted Feed", url: `${baseUrl}/skills.json` });
      const fetched = await fetchSkillMarketplaceFeed("trusted-feed");
      const item = fetched.imported[0];
      assert.ok(item.publisherFingerprint);

      await assert.rejects(
        () => importMarketplaceSkill("trusted-feed", "marketplace-memory-reviewer"),
        /not trusted/i
      );

      let marketplace = await trustSkillPublisher(item.publisherFingerprint, { label: "Test Publisher" });
      assert.equal(marketplace.summary.trustedPublishers, 1);
      assert.equal(marketplace.items[0].publisherTrusted, true);

      marketplace = await untrustSkillPublisher(item.publisherFingerprint);
      assert.equal(marketplace.summary.trustedPublishers, 0);
      assert.equal(marketplace.items[0].publisherTrusted, false);

      const imported = await importMarketplaceSkill("trusted-feed", "marketplace-memory-reviewer", { trustPublisher: true });
      assert.equal(imported.skill.id, "marketplace-memory-reviewer");
      assert.equal(imported.skill.publisherTrusted, true);
      assert.equal(imported.marketplace.summary.trustedPublishers, 1);

      const registry = await getSkillRegistry();
      const skill = registry.skills.find((entry) => entry.id === "marketplace-memory-reviewer");
      assert.equal(skill?.source, "external");
      assert.equal(skill?.publisherTrusted, true);
      assert.equal(registry.summary.external, 1);
      assert.equal(registry.summary.signed, 1);
      assert.equal(registry.summary.trustedPublishers, 1);
      assert.equal(registry.summary.untrustedExternal, 0);
    });
  });
});

test("skill marketplace imports allowlisted publishers with reputation metadata", async () => {
  await withTempRuntime(async () => {
    const manifest = {
      id: "marketplace-verified-agent",
      label: "Marketplace Verified Agent",
      version: "1.0.0",
      category: "agents",
      description: "A signed test skill from a reviewed marketplace publisher.",
      capabilities: ["agent-routing"],
      permissions: ["model", "workflow"],
      exportSafe: true
    };
    const bundle = createSignedSkillBundle(manifest);

    await withHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "hermes.skill.feed", schemaVersion: 1, skills: [bundle] }));
    }, async (baseUrl) => {
      await saveSkillMarketplaceFeed({ id: "verified-feed", label: "Verified Feed", url: `${baseUrl}/skills.json` });
      const fetched = await fetchSkillMarketplaceFeed("verified-feed");
      const fingerprint = fetched.imported[0].publisherFingerprint;

      let publishers = await updateSkillPublisherReputation(fingerprint, {
        label: "Verified Publisher",
        website: "https://publisher.example",
        score: 92,
        tier: "verified",
        notes: "Reviewed signed feed."
      });
      assert.equal(publishers.publishers[0].reputation.score, 92);
      assert.equal(publishers.publishers[0].reputation.tier, "verified");
      assert.equal(JSON.stringify(publishers).includes(os.homedir()), false);

      publishers = await setSkillPublisherAllowed(fingerprint, true, { label: "Verified Publisher" });
      assert.equal(publishers.summary.allowed, 1);

      const marketplace = await updateSkillPublisherPolicy({ enforceAllowlist: true });
      assert.equal(marketplace.policy.enforceAllowlist, true);
      assert.equal(marketplace.items[0].publisherImportAllowed, true);
      assert.equal(marketplace.items[0].publisherReputation.score, 92);

      await trustSkillPublisher(fingerprint, { label: "Verified Publisher" });
      const imported = await importMarketplaceSkill("verified-feed", "marketplace-verified-agent");
      assert.equal(imported.skill.id, "marketplace-verified-agent");
      assert.equal(imported.skill.publisherAllowed, true);
      assert.equal(imported.skill.publisherImportAllowed, true);

      const registry = await getSkillRegistry();
      assert.equal(registry.summary.allowlistEnforced, true);
      assert.equal(registry.summary.allowedPublishers, 1);
      assert.equal(registry.summary.blockedPublishers, 0);

      const publisherState = await getSkillPublishers();
      assert.equal(publisherState.summary.known, 1);
      assert.equal(publisherState.summary.importAllowed, 1);
    });
  });
});

test("skill marketplace blocks imports when publisher policy rejects them", async () => {
  await withTempRuntime(async () => {
    const manifest = {
      id: "marketplace-policy-rejected",
      label: "Marketplace Policy Rejected",
      version: "1.0.0",
      category: "agents",
      description: "A signed skill used to verify marketplace policy rejection.",
      capabilities: ["agent-routing"],
      permissions: ["model"],
      exportSafe: true
    };
    const bundle = createSignedSkillBundle(manifest);

    await withHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "hermes.skill.feed", schemaVersion: 1, skills: [bundle] }));
    }, async (baseUrl) => {
      await saveSkillMarketplaceFeed({ id: "policy-feed", label: "Policy Feed", url: `${baseUrl}/skills.json` });
      const fetched = await fetchSkillMarketplaceFeed("policy-feed");
      const fingerprint = fetched.imported[0].publisherFingerprint;

      await trustSkillPublisher(fingerprint, { label: "Policy Publisher" });
      let marketplace = await updateSkillPublisherPolicy({ enforceAllowlist: true });
      assert.equal(marketplace.items[0].publisherImportAllowed, false);

      await assert.rejects(
        () => importMarketplaceSkill("policy-feed", "marketplace-policy-rejected", { trustPublisher: true }),
        /allowed publisher list/i
      );

      await setSkillPublisherAllowed(fingerprint, true, { label: "Policy Publisher" });
      await setSkillPublisherBlocked(fingerprint, true, { reason: "Manual security review failed." });
      marketplace = await getSkillMarketplace();
      assert.equal(marketplace.items[0].publisherAllowed, true);
      assert.equal(marketplace.items[0].publisherBlocked, true);
      assert.equal(marketplace.items[0].publisherImportAllowed, false);

      await assert.rejects(
        () => importMarketplaceSkill("policy-feed", "marketplace-policy-rejected"),
        /blocked by policy/i
      );

      const publishers = await getSkillPublishers();
      assert.equal(publishers.summary.allowed, 1);
      assert.equal(publishers.summary.blocked, 1);
      assert.equal(publishers.summary.importAllowed, 0);
    });
  });
});

test("skill marketplace rejects tampered feed bundles", async () => {
  await withTempRuntime(async () => {
    const manifest = {
      id: "marketplace-safe-code",
      label: "Marketplace Safe Code",
      version: "1.0.0",
      category: "code",
      description: "Draft local code plans without execution.",
      capabilities: ["code-review"],
      permissions: ["model"]
    };
    const bundle = createSignedSkillBundle(manifest);
    const tampered = {
      ...bundle,
      manifest: {
        ...manifest,
        label: "Tampered Safe Code"
      }
    };

    await withHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "hermes.skill.feed", schemaVersion: 1, skills: [tampered] }));
    }, async (baseUrl) => {
      await saveSkillMarketplaceFeed({ id: "tampered-feed", label: "Tampered Feed", url: `${baseUrl}/skills.json` });
      const fetched = await fetchSkillMarketplaceFeed("tampered-feed");
      assert.equal(fetched.imported.length, 0);
      assert.equal(fetched.rejected.length, 1);
      assert.match(fetched.rejected[0].reason, /signature verification failed/i);

      const marketplace = await getSkillMarketplace();
      assert.equal(marketplace.summary.items, 0);
      assert.equal(marketplace.feeds[0].lastStatus, "partial");

      const registry = await getSkillRegistry();
      assert.equal(registry.summary.external, 0);
      assert.equal(registry.summary.marketplaceItems, 0);
    });
  });
});

test("skill registry rejects tampered bundles and publisher fingerprint mismatch", async () => {
  await withTempRuntime(async () => {
    const manifest = {
      id: "external-safe-memory",
      label: "External Safe Memory",
      version: "1.0.0",
      category: "memory",
      description: "Curate memory records from workflow outcomes.",
      capabilities: ["memory-curation"],
      permissions: ["memory"]
    };
    const bundle = createSignedSkillBundle(manifest);
    await assert.rejects(
      () => importSkillBundle({ ...bundle, manifest: { ...manifest, label: "Tampered Memory" } }),
      /signature verification failed/i
    );

    await importSkillBundle(bundle);
    const rotated = createSignedSkillBundle({ ...manifest, version: "1.0.1" });
    await assert.rejects(
      () => importSkillBundle(rotated),
      /Publisher fingerprint mismatch/i
    );

    let registry = await getSkillRegistry();
    assert.equal(registry.summary.external, 1);
    await uninstallSkill("external-safe-memory", { removeBundle: true });
    registry = await getSkillRegistry();
    assert.equal(registry.summary.external, 0);
  });
});

test("module logs are real local events, not placeholder text", async () => {
  await withTempRuntime(async () => {
    await testModule("goals");
    const run = await runModule("goals", { trigger: "test" });
    assert.equal(run.mode, "local_app");
    await createSelfModuleItem("goals", { title: "Logged goal" });

    const logs = await getModuleLogs("goals");
    assert.ok(logs.logs.length >= 3);
    assert.ok(logs.logs.some((entry) => entry.message === "Module health checked"));
    assert.ok(logs.logs.some((entry) => entry.message === "Local module run requested"));
    assert.equal(JSON.stringify(logs).includes("Module logs are stored locally"), false);

    await configureConnection("provider-openai", { OPENAI_API_KEY: "placeholder-secret-value" });
    const providerLogs = await getModuleLogs("provider-openai");
    assert.ok(providerLogs.logs.some((entry) => entry.message === "Connection configuration saved"));
    assert.equal(JSON.stringify(providerLogs).includes("placeholder-secret-value"), false);
  });
});

test("OpenClaude does not claim connected status without a real local CLI", async () => {
  await withTempRuntime(async () => {
    const modules = await getModules();
    assert.equal(modules.find((module) => module.id === "openclaude")?.status, "missing_dependency");
  });
});

test("OS status uses public runtime paths and no local home path", async () => {
  await withTempRuntime(async () => {
    const status = await getOsStatus();
    assert.equal(status.service, "agent-os-runtime");
    assert.equal(status.store.config, "~/.hermes-agent-os/config");
    assert.equal(JSON.stringify(status).includes(os.homedir()), false);
  });
});

test("module run endpoint dry-runs by default", async () => {
  await withTempRuntime(async () => {
    delete process.env.HERMES_AGENT_OS_ENABLE_EXEC;
    const result = await runModule("claude", { message: "hello" });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "dry_run");
    assert.equal(result.proof.mode, "dry_run");
    assert.equal(result.proof.moduleId, "claude");
    assert.equal(result.proof.dryRun, true);
    assert.equal(result.proof.promptChars, 5);
    assert.ok(result.proof.runId.startsWith("claude_"));
    assert.match(result.reply, /Dry-run plan · Claude Code/);
    assert.match(result.reply, /5-character task/);
    assert.match(result.reply, /dryRun:false/);
    assert.equal(result.reply.includes("hello"), false);

    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
      const stillDry = await runModule("claude", { message: "hello" });
      assert.equal(stillDry.mode, "dry_run");
      assert.match(stillDry.reply, /dryRun:false/);
      assert.equal(stillDry.proof.execEnabled, true);
      assert.equal(stillDry.proof.explicitExecution, false);
    });
  });
});

test("direct agent runs record memory and Kanban handoff proof", async () => {
  await withTempRuntime(async () => {
    const result = await runModule("claude", { message: "create a desktop control proof" });
    assert.equal(result.mode, "dry_run");
    assert.ok(result.proof.handoff.memoryId.startsWith("mem_"));
    assert.ok(result.proof.handoff.kanbanCardId);
    assert.equal(result.proof.handoff.status, "planned");
    assert.ok(result.proof.evidence.some((item) => item.startsWith("memory: mem_")));
    assert.ok(result.proof.evidence.some((item) => item.startsWith("kanban: ")));

    const memory = await getMemoryState();
    assert.ok(memory.memories.some((item) => item.id === result.proof.handoff.memoryId && item.agentId === "claude" && item.namespace === "agent-runs"));

    const kanban = await getSelfModuleState("kanban");
    assert.ok(kanban.items.some((item) => item.id === result.proof.handoff.kanbanCardId && item.sourceType === "agent_run" && item.linkedModule === "claude"));

    const logs = await getModuleLogs("claude");
    assert.ok(logs.logs.some((entry) => entry.message === "Agent run handoff recorded"));
    const runs = await getModuleRuns("claude");
    assert.equal(runs.runs[0].runId, result.proof.runId);
    assert.equal(runs.runs[0].mode, "dry_run");
    assert.equal(runs.runs[0].action, "message");
    assert.equal(runs.runs[0].handoff.memoryId, result.proof.handoff.memoryId);
    assert.equal(runs.runs[0].handoff.kanbanCardId, result.proof.handoff.kanbanCardId);
    assert.ok(runs.runs[0].evidence.some((item) => item.startsWith("memory: mem_")));
    assert.equal(runs.runs[0].replay.available, false);
    assert.equal(runs.runs[0].replay.input, null);
    assert.match(runs.runs[0].replay.reason, /prompt text is private/);
    assert.equal(JSON.stringify(runs).includes("create a desktop control proof"), false);
    assert.equal(JSON.stringify(runs).includes(os.homedir()), false);
    assert.equal(JSON.stringify(result).includes(os.homedir()), false);
  });
});

test("workflow-internal module runs do not create dashboard handoff cards", async () => {
  await withTempRuntime(async () => {
    const result = await runModule("claude", {
      message: "workflow node",
      workflowId: "internal-workflow",
      runId: "internal-run",
      nodeId: "agent-node"
    });
    assert.equal(result.mode, "dry_run");
    assert.equal(result.proof.handoff, null);

    const memory = await getMemoryState();
    assert.equal(memory.memories.length, 0);
    const kanban = await getSelfModuleState("kanban");
    assert.equal(kanban.items.length, 0);
  });
});

test("voice control registers as a desktop voice module", async () => {
  await withTempRuntime(async () => {
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: null, HERMES_VOICE_ALLOW_SHELL: null }, async () => {
      const modules = await getModules();
      const voice = modules.find((module) => module.id === "voice-control");
      assert.equal(voice?.type, "desktop_voice");
      assert.ok(voice?.capabilities.includes("desktop-control"));
      assert.ok(voice?.taskProfiles?.some((profile) => profile.id === "open-chrome"));
      assert.equal(JSON.stringify(voice).includes(os.homedir()), false);
    });
  });
});

