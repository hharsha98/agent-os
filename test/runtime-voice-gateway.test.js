// Part 2 of 3 of what used to be one file, test/runtime.test.js (SP4 sweep B: the one file took 40 s on its own
// and more than the 180 s limit of one test file on a machine under heavy load, so it is now three files that
// `node --test` runs side by side; nothing in the tests changed, and the set-up below is the same in each):
// voice control, the provider modules, Hermes and the Gateway control room, up to the Hermes task controls.
// Part 1 is test/runtime.test.js, part 3 is test/runtime-cli-workflows.test.js.
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

test("voice control plans wake-word desktop commands in dry-run mode", async () => {
  await withTempRuntime(async () => {
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: null, HERMES_VOICE_ALLOW_SHELL: null }, async () => {
      const status = await getVoiceControlStatus();
      assert.equal(status.id, "voice-control");
      assert.ok(status.capabilities.includes("open-apps"));

      const result = await runVoiceCommand({ transcript: "Hermes, open Chrome" });
      assert.equal(result.mode, "dry_run");
      assert.equal(result.plan.wakeWordDetected, true);
      assert.equal(result.plan.intent, "open_app");
      assert.equal(result.plan.actions[0]?.type, "open_app");
      assert.equal(result.plan.actions[0]?.app, "Chrome");
      assert.equal(result.actions[0]?.dryRun, true);
      assert.equal(result.proof.moduleId, "voice-control");
      assert.equal(JSON.stringify(result).includes(os.homedir()), false);
    });
  });
});

test("voice control can use Codex GPT planning while staying in dry-run mode", async () => {
  await withTempRuntime(async () => {
    let authHeader = "";
    let requestedModel = "";
    await withHttpServer(async (req, res) => {
      authHeader = req.headers.authorization || "";
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requestedModel = JSON.parse(raw || "{}").model;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "open_app",
              summary: "Open Calculator.",
              confidence: 0.94,
              actions: [
                { type: "open_app", app: "Calculator" },
                { type: "press_key", key: "enter" }
              ],
              warnings: []
            })
          }
        }]
      }));
    }, async (baseUrl) => {
      await withEnv({
        ...PROVIDER_ENV_RESET,
        HERMES_AGENT_OS_ENABLE_EXEC: null,
        HERMES_VOICE_ALLOW_SHELL: null,
        HERMES_VOICE_MODEL: "gpt-5-mini",
        HERMES_VOICE_OPENAI_URL: `${baseUrl}/chat/completions`
      }, async () => {
        await configureConnection("provider-openai", { OPENAI_API_KEY: "placeholder-openai-key" });

        const result = await runVoiceCommand({ transcript: "Hermes, please open the calculator", useModel: true });

        assert.equal(result.mode, "dry_run");
        assert.equal(result.plan.source, "codex-gpt");
        assert.equal(result.plan.intent, "open_app");
        assert.equal(result.plan.actions[0]?.app, "Calculator");
        assert.equal(result.plan.actions[1]?.type, "press_key");
        assert.equal(result.plan.actions[1]?.stroke, "enter");
        assert.equal(Object.hasOwn(result.plan.actions[1] || {}, "key"), false);
        assert.equal(result.actions[0]?.dryRun, true);
        assert.equal(authHeader, "Bearer placeholder-openai-key");
        assert.equal(requestedModel, "gpt-5-mini");
        assert.equal(JSON.stringify(result).includes("placeholder-openai-key"), false);
        assert.equal(JSON.stringify(result).includes("\"key\":\"configured\""), false);
      });
    });
  });
});

test("voice control dashboard config enables planner model and shell gate", async () => {
  await withTempRuntime(async () => {
    let authHeader = "";
    let requestedModel = "";
    await withHttpServer(async (req, res) => {
      authHeader = req.headers.authorization || "";
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requestedModel = JSON.parse(raw || "{}").model;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "screenshot",
              summary: "Capture screen.",
              confidence: 0.9,
              actions: [{ type: "screenshot" }],
              warnings: []
            })
          }
        }]
      }));
    }, async (baseUrl) => {
      await withEnv({
        ...PROVIDER_ENV_RESET,
        HERMES_AGENT_OS_ENABLE_EXEC: null,
        // HERMES_VOICE_ALLOW_SHELL is env-only: set it
        // directly here rather than through configureConnection.
        HERMES_VOICE_ALLOW_SHELL: "1",
        HERMES_VOICE_MODEL: null,
        HERMES_VOICE_OPENAI_URL: null,
        HERMES_VOICE_USE_CODEX_GPT: null
      }, async () => {
        const connections = await getConnections();
        const template = connections.templates.find((item) => item.id === "voice-control");
        assert.ok(template);
        assert.ok(template.fields.includes("OPENAI_API_KEY"));
        assert.ok(!template.fields.includes("HERMES_VOICE_ALLOW_SHELL"));

        await configureConnection("voice-control", {
          OPENAI_API_KEY: "placeholder-voice-openai-key",
          HERMES_VOICE_MODEL: "gpt-voice-local",
          HERMES_VOICE_OPENAI_URL: `${baseUrl}/chat/completions`
        });

        const status = await getVoiceControlStatus();
        assert.equal(status.tools.codexGptPlanner, true);
        assert.equal(status.tools.shellGate, true);
        assert.equal(status.tools.model, "gpt-voice-local");

        const result = await runVoiceCommand({ transcript: "Hermes, take screenshot", useModel: true });
        assert.equal(result.mode, "dry_run");
        assert.equal(result.plan.source, "codex-gpt");
        assert.equal(result.plan.intent, "screenshot");
        assert.equal(authHeader, "Bearer placeholder-voice-openai-key");
        assert.equal(requestedModel, "gpt-voice-local");
        assert.equal(JSON.stringify(result).includes("placeholder-voice-openai-key"), false);
      });
    });
  });
});

test("voice control maps common computer tasks beyond app launching", { skip: isWindows ? "machine control is macOS-only; planned paths use POSIX separators" : false }, async () => {
  await withTempRuntime(async () => {
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: null, HERMES_VOICE_ALLOW_SHELL: null }, async () => {
      const folder = await runVoiceCommand({ transcript: "Hermes, open downloads folder" });
      assert.equal(folder.plan.intent, "open_folder");
      assert.equal(folder.plan.actions[0]?.type, "open_file");
      assert.equal(folder.plan.actions[0]?.path, "~/Downloads");

      const createdFolder = await runVoiceCommand({ transcript: "Hermes, create folder called Client Notes in downloads" });
      assert.equal(createdFolder.plan.intent, "create_folder");
      assert.equal(createdFolder.plan.actions[0]?.type, "create_folder");
      assert.equal(createdFolder.plan.actions[0]?.path, "~/Downloads/Client Notes");
      assert.equal(createdFolder.actions[0]?.command, "mkdir ~/Downloads/Client Notes");

      const trashSelection = await runVoiceCommand({ transcript: "Hermes, move selected files to trash" });
      assert.equal(trashSelection.plan.intent, "trash_selection");
      assert.equal(trashSelection.plan.actions[0]?.type, "trash_selection");
      assert.equal(trashSelection.actions[0]?.command, "osascript Finder delete selection");

      const unsafeFolder = await runVoiceCommand({ transcript: "Hermes, create folder called ../Secrets in downloads" });
      assert.equal(unsafeFolder.plan.intent, "unknown");
      assert.equal(unsafeFolder.actions.length, 0);

      const pageSearch = await runVoiceCommand({ transcript: "Hermes, find on page pricing" });
      assert.equal(pageSearch.plan.intent, "page_search");
      assert.equal(pageSearch.plan.actions[0]?.type, "hotkey");
      assert.equal(pageSearch.plan.actions[1]?.type, "type_text");

      const newTabSearch = await runVoiceCommand({ transcript: "Hermes, open a new tab and search local automation" });
      assert.equal(newTabSearch.plan.intent, "browser_search_new_tab");
      assert.equal(newTabSearch.plan.actions[0]?.type, "hotkey");
      assert.equal(newTabSearch.plan.actions[0]?.stroke, "t");
      assert.equal(newTabSearch.plan.actions[1]?.type, "type_text");
      assert.equal(newTabSearch.plan.actions[1]?.text, "local automation");
      assert.equal(newTabSearch.plan.actions[2]?.type, "press_key");
      assert.equal(newTabSearch.plan.actions[2]?.stroke, "enter");
      assert.equal(JSON.stringify(newTabSearch).includes("\"key\":\"configured\""), false);

      const browserBack = await runVoiceCommand({ transcript: "Hermes, go back" });
      assert.equal(browserBack.plan.intent, "hotkey");
      assert.equal(browserBack.plan.actions[0]?.stroke, "[");
      assert.deepEqual(browserBack.plan.actions[0]?.modifiers, ["command"]);

      const sequence = await runVoiceCommand({ transcript: "Hermes, open Chrome then search Hermes automation" });
      assert.equal(sequence.plan.intent, "multi_step");
      assert.equal(sequence.plan.actions[0]?.type, "open_app");
      assert.equal(sequence.plan.actions[1]?.type, "web_search");

      const minimize = await runVoiceCommand({ transcript: "Hermes, minimize this window" });
      assert.equal(minimize.plan.intent, "window_control");
      assert.equal(minimize.plan.actions[0]?.type, "window_control");
      assert.equal(minimize.plan.actions[0]?.operation, "minimize_window");
      assert.equal(minimize.actions[0]?.command, "osascript System Events window_control minimize_window");

      const fullscreen = await runVoiceCommand({ transcript: "Hermes, make this window full screen" });
      assert.equal(fullscreen.plan.intent, "window_control");
      assert.equal(fullscreen.plan.actions[0]?.operation, "toggle_full_screen");

      const showDesktop = await runVoiceCommand({ transcript: "Hermes, show desktop" });
      assert.equal(showDesktop.plan.intent, "window_control");
      assert.equal(showDesktop.plan.actions[0]?.operation, "show_desktop");

      const quitApp = await runVoiceCommand({ transcript: "Hermes, quit current app" });
      assert.equal(quitApp.plan.intent, "window_control");
      assert.equal(quitApp.plan.actions[0]?.operation, "quit_app");

      const quitChrome = await runVoiceCommand({ transcript: "Hermes, quit Chrome" });
      assert.equal(quitChrome.plan.intent, "window_control");
      assert.equal(quitChrome.plan.actions[0]?.operation, "quit_app");
      assert.equal(quitChrome.plan.actions[0]?.app, "Chrome");
      assert.equal(quitChrome.actions[0]?.command, "osascript System Events window_control quit_app Chrome");

      const hideSafari = await runVoiceCommand({ transcript: "Hermes, hide Safari" });
      assert.equal(hideSafari.plan.intent, "window_control");
      assert.equal(hideSafari.plan.actions[0]?.operation, "hide_app");
      assert.equal(hideSafari.plan.actions[0]?.app, "Safari");

      const minimizeFinder = await runVoiceCommand({ transcript: "Hermes, minimize Finder window" });
      assert.equal(minimizeFinder.plan.intent, "window_control");
      assert.equal(minimizeFinder.plan.actions[0]?.operation, "minimize_window");
      assert.equal(minimizeFinder.plan.actions[0]?.app, "Finder");

      const closeTab = await runVoiceCommand({ transcript: "Hermes, close tab" });
      assert.equal(closeTab.plan.intent, "hotkey");
      assert.equal(closeTab.plan.actions[0]?.stroke, "w");
      assert.deepEqual(closeTab.plan.actions[0]?.modifiers, ["command"]);

      const paste = await runVoiceCommand({ transcript: "Hermes, paste \"Draft the reply now\"" });
      assert.equal(paste.plan.intent, "paste_text");
      assert.equal(paste.plan.actions[0]?.type, "paste_text");

      const workflow = await runVoiceCommand({ transcript: "Hermes, run workflow blank open agent builder" });
      assert.equal(workflow.plan.intent, "run_workflow");
      assert.equal(workflow.plan.actions[0]?.workflowId, "blank-open-agent-builder");

      const context = await runVoiceCommand({ transcript: "Hermes, what do you see" });
      assert.equal(context.plan.intent, "inspect_context");
      assert.equal(context.plan.actions[0]?.type, "inspect_context");
      assert.equal(context.actions[0]?.type, "inspect_context");
    });
  });
});

test("voice control reports desktop context shape without leaking local paths", async () => {
  await withTempRuntime(async () => {
    const context = await getDesktopContext({ includeUiElements: false, timeoutMs: 3000 });
    assert.equal(typeof context.ok, "boolean");
    assert.equal(typeof context.accessibility, "boolean");
    assert.ok(Array.isArray(context.uiLabels));
    assert.equal(JSON.stringify(context).includes(os.homedir()), false);
  });
});

test("voice control can execute a local Agent OS workflow when explicitly gated", async () => {
  await withTempRuntime(async () => {
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: "1", HERMES_VOICE_USE_CODEX_GPT: "0" }, async () => {
      const result = await runVoiceCommand(
        { transcript: "Hermes, run workflow blank open agent builder", dryRun: false, useModel: false },
        { runWorkflow }
      );
      assert.equal(result.mode, "executed");
      assert.equal(result.plan.intent, "run_workflow");
      assert.equal(result.actions[0]?.ok, true);
      assert.equal(result.actions[0]?.output?.workflowId, "blank-open-agent-builder");
      assert.equal(JSON.stringify(result).includes(os.homedir()), false);
    });
  });
});

test("voice control honors local execution gate config for workflow execution", async () => {
  await withTempRuntime(async () => {
    await withEnv({ ...PROVIDER_ENV_RESET, HERMES_AGENT_OS_ENABLE_EXEC: null, HERMES_VOICE_USE_CODEX_GPT: "0" }, async () => {
      await setExecutionGateStatus({ enabled: true, reason: "voice test" });
      const status = await getVoiceControlStatus();
      assert.equal(status.tools.executionGate, true);
      assert.equal(status.tools.executionGateSource, "local-config");
      const result = await runVoiceCommand(
        { transcript: "Hermes, run workflow blank open agent builder", dryRun: false, useModel: false },
        { runWorkflow }
      );
      assert.equal(result.mode, "executed");
      assert.equal(result.actions[0]?.ok, true);
      assert.equal(result.proof.execEnabled, true);
    });
  });
});

test("provider module runs route through the requested provider with OS handoff proof", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openai", { OPENAI_API_KEY: "placeholder-openai-key" });
      const result = await runModule("provider-openai", { message: "say hello through OpenAI" });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.provider, "openai");
      assert.equal(result.router.provider, "openai");
      assert.equal(result.proof.mode, "dry_run");
      assert.equal(result.proof.handoff.status, "planned");
      assert.ok(result.proof.evidence.some((item) => item.includes("provider: openai")));
      assert.equal(JSON.stringify(result).includes("placeholder-openai-key"), false);

      const usage = await getUsageState();
      assert.equal(usage.summary.total.calls, 1);
      const memory = await getMemoryState();
      assert.ok(memory.memories.some((item) => item.id === result.proof.handoff.memoryId && item.agentId === "provider-openai"));
      const kanban = await getSelfModuleState("kanban");
      assert.ok(kanban.items.some((item) => item.id === result.proof.handoff.kanbanCardId && item.linkedModule === "provider-openai"));
    });
  });
});

test("Agent Runner aggregates sanitized proof across modules", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openai", { OPENAI_API_KEY: "placeholder-openai-key" });
      const cliRun = await runModule("claude", { message: `secret prompt ${os.homedir()}` });
      const providerRun = await runModule("provider-openai", { message: "private provider prompt" });
      const agentRuns = await getAgentRuns({ limit: 10 });
      assert.equal(agentRuns.id, "agent-runs");
      assert.equal(agentRuns.summary.total, 2);
      assert.equal(agentRuns.summary.withMemory, 2);
      assert.equal(agentRuns.summary.withKanban, 2);
      assert.ok(agentRuns.runs.find((run) => run.runId === cliRun.proof.runId && run.moduleId === "claude"));
      assert.ok(agentRuns.runs.find((run) => run.runId === providerRun.proof.runId && run.moduleId === "provider-openai"));
      assert.equal(JSON.stringify(agentRuns).includes("secret prompt"), false);
      assert.equal(JSON.stringify(agentRuns).includes("private provider prompt"), false);
      assert.equal(JSON.stringify(agentRuns).includes("placeholder-openai-key"), false);
      assert.equal(JSON.stringify(agentRuns).includes(os.homedir()), false);
    });
  });
});

test("provider module runs do not fall back to another provider when its provider is missing", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      await configureConnection("provider-openrouter", { OPENROUTER_API_KEY: "placeholder-openrouter-key" });
      const result = await runModule("provider-openai", { message: "must not fall back" });
      assert.equal(result.ok, false);
      assert.equal(result.mode, "ready_to_configure");
      assert.match(result.reply, /OpenAI is not configured/);
      assert.equal(result.provider, "openai");
      assert.equal(result.router.provider, "openai");
      assert.notEqual(result.router.provider, "openrouter");
      assert.equal(result.proof.handoff.status, "blocked");
      assert.ok(result.proof.evidence.some((item) => item.includes("provider: openai")));
      assert.equal(JSON.stringify(result).includes("placeholder-openrouter-key"), false);
    });
  });
});

test("unconfigured MiniMax routing exposes control-room sessions with setup blockers", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const modules = await getModules();
      const minimax = modules.find((module) => module.id === "minimax");
      assert.equal(minimax?.status, "ready_to_configure");
      assert.ok(minimax?.actions.includes("run"));
      assert.ok(minimax?.actions.includes("sessions"));

      const minimaxBlocked = await startModuleSession("minimax", {
        message: "prove minimax route",
        provider: "minimax"
      });
      assert.equal(minimaxBlocked.ok, false);
      assert.equal(minimaxBlocked.mode, "ready_to_configure");
      assert.equal(minimaxBlocked.session.status, "ready_to_configure");
      assert.equal(minimaxBlocked.session.provider, "minimax");
      assert.equal(JSON.stringify(minimaxBlocked).includes("prove minimax route"), false);
    });
  });
});

test("provider modules expose dry-run conversation sessions without leaking prompts or keys", async () => {
  await withTempRuntime(async () => {
    await withEnv(PROVIDER_ENV_RESET, async () => {
      const key = "placeholder-openai-key";
      await configureConnection("provider-openai", { OPENAI_API_KEY: key });
      const modules = await getModules();
      const openai = modules.find((module) => module.id === "provider-openai");
      assert.ok(openai?.actions.includes("sessions"));

      const firstPrompt = `first private prompt ${os.homedir()}`;
      const opened = await startModuleSession("provider-openai", { message: firstPrompt });
      assert.equal(opened.ok, true);
      assert.equal(opened.mode, "dry_run");
      assert.equal(opened.session.status, "open");
      assert.equal(opened.session.provider, "openai");
      assert.equal(opened.session.messageCount, 2);
      assert.equal(opened.session.dryRun, true);
      assert.equal(JSON.stringify(opened).includes(key), false);
      assert.equal(JSON.stringify(opened).includes(firstPrompt), false);
      assert.equal(JSON.stringify(opened).includes(os.homedir()), false);

      const secondPrompt = "second private follow up";
      const second = await messageModuleSession("provider-openai", opened.session.sessionId, { message: secondPrompt });
      assert.equal(second.ok, true);
      assert.equal(second.mode, "dry_run");
      assert.equal(second.session.messageCount, 4);
      assert.equal(second.session.provider, "openai");
      assert.equal(second.session.model, "gpt-4o-mini");
      assert.equal(JSON.stringify(second).includes(secondPrompt), false);
      assert.equal(JSON.stringify(second).includes(firstPrompt), false);
      assert.equal(JSON.stringify(second).includes(key), false);

      const sessions = await getModuleSessions("provider-openai");
      assert.equal(sessions.sessions[0].sessionId, opened.session.sessionId);
      assert.equal(sessions.sessions[0].messageCount, 4);
      assert.equal(JSON.stringify(sessions).includes(firstPrompt), false);
      assert.equal(JSON.stringify(sessions).includes(secondPrompt), false);
      assert.equal(JSON.stringify(sessions).includes(key), false);

      const usage = await getUsageState();
      assert.equal(usage.summary.total.calls, 2);
      const logs = await getModuleLogs("provider-openai");
      assert.ok(logs.logs.some((entry) => entry.message === "Provider conversation session opened"));
      assert.ok(logs.logs.some((entry) => entry.message === "Provider session message routed"));
      assert.equal(JSON.stringify(logs).includes(key), false);
    });
  });
});

test("Hermes module inspects local profile gateway state without leaking paths", async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "hermes-home");
    const profileRoot = path.join(hermesHome, "profiles", "agentalpha");
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(hermesHome, "active_profile"), "agentalpha\n");
    await writeFile(path.join(profileRoot, "config.yaml"), "gateway:\n  enabled: true\n");
    await writeFile(path.join(profileRoot, ".env"), "TELEGRAM_BOT_TOKEN=secret\n");
    await writeFile(path.join(profileRoot, "channel_directory.json"), JSON.stringify({ telegram: { enabled: true } }));
    await writeFile(path.join(profileRoot, "gateway_state.json"), JSON.stringify({
      gateway_state: "running",
      active_agents: 0,
      platforms: { telegram: { state: "connected", updated_at: "2026-07-07T00:00:00.000Z" } },
      updated_at: "2026-07-07T00:00:00.000Z"
    }));

    await withEnv({ HERMES_HOME: hermesHome }, async () => {
      const modules = await getModules();
      const hermes = modules.find((item) => item.id === "hermes");
      assert.equal(hermes.status, "connected");
	      assert.equal(hermes.profileCount, 1);
	      assert.equal(hermes.onlineProfiles, 1);
	      assert.equal(hermes.stats.connectedPlatforms, 1);
	      assert.equal(hermes.activeProfile, "agentalpha");
	      assert.equal(hermes.profiles[0].id, "agentalpha");
	      assert.equal(hermes.profiles[0].gatewayState, "running");
	      assert.equal(hermes.profiles[0].connectedPlatforms, 1);
	      assert.equal(hermes.profiles[0].hasEnv, true);
	      assert.equal(JSON.stringify(hermes.profiles).includes(hermesHome), false);
	      assert.equal(JSON.stringify(hermes.profiles).includes("secret"), false);

	      const result = await runModule("hermes", { action: "status" });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "status");
      assert.equal(result.hermes.profileCount, 1);
      assert.equal(result.hermes.profiles[0].gateway.platforms.telegram.state, "connected");
      assert.equal(result.proof.handoff.status, "planned");
      assert.equal(result.proof.replay.available, true);
      assert.deepEqual(result.proof.replay.input, { action: "status" });
      const runs = await getModuleRuns("hermes");
      assert.equal(runs.runs[0].runId, result.proof.runId);
      assert.equal(runs.runs[0].replay.available, true);
      assert.deepEqual(runs.runs[0].replay.input, { action: "status" });
      assert.equal(JSON.stringify(result).includes(hermesHome), false);
      assert.equal(JSON.stringify(result).includes("secret"), false);
    });
  });
});

test("Hermes gateway restart is dry-run gated and returns launchd control proof", async () => {
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

    await withEnv({ HERMES_HOME: hermesHome }, async () => {
      const result = await runModule("hermes", { action: "restart_gateway", profile: "agentalpha" });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "dry_run");
      assert.equal(result.control.selectedProfile, "agentalpha");
      assert.equal(result.control.launchLabel, "ai.hermes.gateway-agentalpha");
      assert.equal(result.control.executed, false);
      assert.match(result.control.command, /launchctl kickstart -k/);
      assert.equal(result.proof.handoff.status, "planned");
      assert.equal(JSON.stringify(result).includes(hermesHome), false);
    });
  });
});

test("Gateway module exposes real profile and channel controls without leaking local data", async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "hermes-home");
    const profileRoot = path.join(hermesHome, "profiles", "agentalpha");
    const inactiveProfileRoot = path.join(hermesHome, "profiles", "email");
    await mkdir(profileRoot, { recursive: true });
    await mkdir(inactiveProfileRoot, { recursive: true });
    await writeFile(path.join(hermesHome, "active_profile"), "email\n");
    await writeFile(path.join(profileRoot, "config.yaml"), "gateway:\n  enabled: true\n");
    await writeFile(path.join(profileRoot, ".env"), "TELEGRAM_BOT_TOKEN=123456:privateTelegramToken\n");
    await writeFile(path.join(profileRoot, "channel_directory.json"), JSON.stringify({
      channels: [{ id: "telegram-primary", platform: "telegram" }]
    }));
    await writeFile(path.join(profileRoot, "gateway_state.json"), JSON.stringify({
      gateway_state: "running",
      active_agents: 2,
      platforms: {
        telegram: { state: "connected", updated_at: "2026-07-07T00:00:00.000Z" },
        browser: { state: "ready", updated_at: "2026-07-07T00:00:00.000Z" }
      },
      updated_at: "2026-07-07T00:00:00.000Z"
    }));
    await writeFile(path.join(inactiveProfileRoot, "gateway_state.json"), JSON.stringify({
      gateway_state: "running",
      active_agents: 1,
      platforms: { browser: { state: "connected", updated_at: "2026-07-07T00:00:00.000Z" } },
      updated_at: "2026-07-07T00:00:00.000Z"
    }));

    await withEnv({ HERMES_HOME: hermesHome }, async () => {
      const modules = await getModules();
      const gateway = modules.find((item) => item.id === "gateway");
      assert.equal(gateway.status, "connected");
      assert.ok(gateway.actions.includes("channel-status"));
      assert.ok(gateway.actions.includes("test-telegram"));
      assert.ok(gateway.actions.includes("restart-gateway"));

      const result = await runModule("gateway", { action: "channel_status", profile: "agentalpha", platform: "telegram" });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "status");
      assert.equal(result.gateway.profileCount, 2);
      assert.equal(result.gateway.selectedProfile.gateway.state, "running");
      assert.equal(result.gateway.selectedProfile.channels, 1);
      assert.equal(result.gateway.channel.id, "telegram");
      assert.equal(result.gateway.channel.state, "connected");
      assert.equal(result.control.selectedProfile, "agentalpha");
      assert.equal(result.proof.replay.available, true);
      assert.equal(JSON.stringify(result).includes(hermesHome), false);
      assert.equal(JSON.stringify(result).includes("privateTelegramToken"), false);
      assert.equal(JSON.stringify(result).includes("123456:"), false);

      const autoSelected = await runModule("gateway", { action: "channel_status", platform: "telegram" });
      assert.equal(autoSelected.ok, true);
      assert.equal(autoSelected.gateway.selectedProfile.id, "agentalpha");
      assert.equal(autoSelected.gateway.channel.state, "connected");
      assert.equal(JSON.stringify(autoSelected).includes(hermesHome), false);
    });
  });
});

test("Gateway control room config connects Hermes profiles without Hermes env", async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "gateway-config-home");
    const profileRoot = path.join(hermesHome, "profiles", "agentbeta");
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, "gateway_state.json"), JSON.stringify({
      gateway_state: "running",
      platforms: { telegram: { state: "connected" } }
    }));
    await writeFile(path.join(profileRoot, "channel_directory.json"), JSON.stringify({
      channels: [{ id: "telegram-beta", platform: "telegram" }]
    }));

    await withEnv({ HERMES_HOME: null }, async () => {
      const connections = await getConnections();
      const template = connections.templates.find((item) => item.id === "gateway");
      assert.ok(template);
      assert.ok(template.fields.includes("HERMES_HOME"));
      assert.ok(template.fields.includes("HERMES_TELEGRAM_API_BASE"));

      await configureConnection("gateway", { HERMES_HOME: hermesHome });
      const modules = await getModules();
      const gateway = modules.find((item) => item.id === "gateway");
      assert.equal(gateway.status, "connected");
      assert.equal(gateway.configured, true);

      const result = await runModule("gateway", { action: "channel_status", profile: "agentbeta", platform: "telegram" });
      assert.equal(result.ok, true);
      assert.equal(result.gateway.selectedProfile.id, "agentbeta");
      assert.equal(result.gateway.channel.id, "telegram");
      assert.equal(JSON.stringify(result).includes(hermesHome), false);
    });
  });
});

test("Gateway Telegram smoke test is execution-gated and returns sanitized proof", async () => {
  await withTempRuntime(async (dir) => {
    const hermesHome = path.join(dir, "hermes-home");
    const profileRoot = path.join(hermesHome, "profiles", "agentalpha");
    const token = "123456:privateTelegramToken";
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, ".env"), `TELEGRAM_BOT_TOKEN=${token}\n`);
    await writeFile(path.join(profileRoot, "gateway_state.json"), JSON.stringify({
      gateway_state: "running",
      platforms: { telegram: { state: "connected" } }
    }));

    let requestedUrl = "";
    await withHttpServer((req, res) => {
      requestedUrl = req.url || "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        result: {
          id: 777,
          username: "HermesTestBot",
          first_name: "Hermes",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false
        }
      }));
    }, async (baseUrl) => {
      await withEnv({ HERMES_HOME: hermesHome, HERMES_TELEGRAM_API_BASE: baseUrl }, async () => {
        const prepared = await runModule("gateway", { action: "test_telegram", profile: "agentalpha" });
        assert.equal(prepared.ok, true);
        assert.equal(prepared.mode, "dry_run");
        assert.equal(prepared.control.tokenConfigured, true);
        assert.equal(prepared.control.endpoint, `${baseUrl}/bot<token>/getMe`);
        assert.equal(requestedUrl, "");
        assert.equal(JSON.stringify(prepared).includes(token), false);
        assert.equal(JSON.stringify(prepared).includes(hermesHome), false);

        await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
          const executed = await runModule("gateway", {
            action: "test_telegram",
            profile: "agentalpha",
            dryRun: false
          });
          assert.equal(executed.ok, true);
          assert.equal(executed.mode, "executed");
          assert.equal(executed.gateway.telegram.username, "HermesTestBot");
          assert.equal(executed.gateway.telegram.botId, 777);
          assert.equal(executed.control.executed, true);
          assert.match(requestedUrl, /^\/bot123456:privateTelegramToken\/getMe$/);
          assert.equal(JSON.stringify(executed).includes(token), false);
          assert.equal(JSON.stringify(executed).includes(hermesHome), false);
        });
      });
    });
  });
});

test(
  "Hermes task dispatch prepares a real Kanban create command without leaking paths",
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
    await writeFile(cli, "#!/bin/sh\necho should-not-run\n");
    await chmod(cli, 0o755);

    await configureCliPath("hermes", { HERMES_HOME: hermesHome, HERMES_CLI_PATH: cli, HERMES_KANBAN_BOARD: "agent-os" });
    const result = await runModule("hermes", {
      action: "task",
      profile: "agentalpha",
      message: "Research the local runtime and report what is missing."
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "dry_run");
    assert.equal(result.control.selectedProfile, "agentalpha");
    assert.equal(result.control.queue, "agent-os");
    assert.equal(result.control.executed, false);
    assert.match(result.control.command, /hermes kanban --board agent-os create <title> --body <message>/);
    assert.equal(result.proof.handoff.status, "planned");
    assert.equal(JSON.stringify(result).includes(hermesHome), false);
    assert.equal(JSON.stringify(result).includes(cli), false);
  });
});

test(
  "Hermes profile sessions dispatch messages through Hermes control without leaking prompts",
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
    await writeFile(cli, "#!/bin/sh\necho should-not-run\n");
    await chmod(cli, 0o755);

    await configureCliPath("hermes", { HERMES_HOME: hermesHome, HERMES_CLI_PATH: cli, HERMES_KANBAN_BOARD: "agent-os" });
    const privatePrompt = `private Hermes session request ${os.homedir()}`;
    const opened = await startModuleSession("hermes", { profile: "agentalpha" });
    assert.equal(opened.ok, true);
    assert.equal(opened.mode, "open");
    assert.equal(opened.session.moduleId, "hermes");
    assert.equal(opened.session.profile, "agentalpha");
    assert.equal(opened.session.status, "open");

    const routed = await messageModuleSession("hermes", opened.session.sessionId, {
      message: privatePrompt,
      profile: "agentalpha"
    });
    assert.equal(routed.ok, true);
    assert.equal(routed.mode, "dry_run");
    assert.equal(routed.control.selectedProfile, "agentalpha");
    assert.equal(routed.session.profile, "agentalpha");
    assert.equal(routed.session.messageCount, 2);
    assert.match(routed.session.stdoutTail, /Prepared Hermes Kanban task/);
    assert.equal(JSON.stringify(routed).includes(privatePrompt), false);
    assert.equal(JSON.stringify(routed).includes(hermesHome), false);
    assert.equal(JSON.stringify(routed).includes(cli), false);

    const sessions = await getModuleSessions("hermes");
    assert.equal(sessions.sessions[0].sessionId, opened.session.sessionId);
    assert.equal(sessions.sessions[0].profile, "agentalpha");
    assert.equal(sessions.sessions[0].messageCount, 2);
    assert.equal(JSON.stringify(sessions).includes(privatePrompt), false);

    const logs = await getModuleLogs("hermes");
    assert.ok(logs.logs.some((entry) => entry.message === "Hermes profile session opened"));
    assert.ok(logs.logs.some((entry) => entry.message === "Hermes session message handled"));
    assert.equal(JSON.stringify(logs).includes(privatePrompt), false);
    assert.equal(JSON.stringify(logs).includes(hermesHome), false);
  });
});

test(
  "Hermes task dispatch can execute through configured CLI when server gate is enabled",
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
      "printf '%s\\n' \"$*\" > \"$HERMES_HOME/last-args.txt\"",
      "cat <<'JSON'",
      "{\"id\":\"t-123\",\"title\":\"Dashboard task\",\"assignee\":\"agentalpha\",\"status\":\"ready\"}",
      "JSON"
    ].join("\n"));
    await chmod(cli, 0o755);

    await configureCliPath("hermes", { HERMES_HOME: hermesHome, HERMES_CLI_PATH: cli });
    await withEnv({ HERMES_AGENT_OS_ENABLE_EXEC: "1" }, async () => {
      const result = await runModule("hermes", {
        action: "dispatch",
        profile: "agentalpha",
        message: "Create the first real dashboard-driven Hermes task.",
        dryRun: false,
        goal: true
      });
      assert.equal(result.ok, true);
      assert.equal(result.mode, "executed");
      assert.equal(result.control.executed, true);
      assert.equal(result.control.taskId, "t-123");
      assert.equal(result.control.taskStatus, "ready");
      assert.equal(result.proof.handoff.status, "completed");
      const args = await readFile(path.join(hermesHome, "last-args.txt"), "utf8");
      assert.match(args, /kanban create/);
      assert.equal(args.includes("--initial-status ready"), false);
      assert.match(args, /--goal/);
      assert.equal(JSON.stringify(result).includes(hermesHome), false);
      assert.equal(JSON.stringify(result).includes(cli), false);
    });
  });
});

test(
  "Hermes task status refresh reads Kanban task state without recording handoff spam",
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
      "printf '%s\\n' \"$*\" > \"$HERMES_HOME/status-args.txt\"",
      "cat <<'JSON'",
      JSON.stringify({
        task: {
          id: "t-123",
          title: "Follow up from dashboard",
          status: "running",
          assignee: "agentalpha",
          priority: 2,
          workspace_path: hermesHome
        },
        latest_summary: "private worker output should not be returned",
        events: [{ kind: "claimed", payload: { secret: "placeholder-secret-value" }, created_at: 1 }],
        runs: [{
          id: 7,
          profile: "agentalpha",
          status: "running",
          outcome: null,
          summary: "private run summary",
          error: null,
          started_at: 1,
          ended_at: null
        }]
      }),
      "JSON"
    ].join("\n"));
    await chmod(cli, 0o755);

    await configureCliPath("hermes", { HERMES_HOME: hermesHome, HERMES_CLI_PATH: cli, HERMES_KANBAN_BOARD: "agent-os" });
    const result = await runModule("hermes", {
      action: "task_status",
      taskId: "t-123",
      recordHandoff: false
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "status");
    assert.equal(result.control.queue, "agent-os");
    assert.equal(result.control.taskId, "t-123");
    assert.equal(result.control.taskStatus, "running");
    assert.equal(result.hermesTask.id, "t-123");
    assert.equal(result.hermesTask.status, "running");
    assert.equal(result.hermesTask.latestSummaryPresent, true);
    assert.equal(result.hermesTask.runCount, 1);
    assert.equal(result.hermesTask.eventCount, 1);
    assert.equal(result.proof.handoff, null);
    assert.equal(result.proof.replay.available, true);
    assert.deepEqual(result.proof.replay.input, {
      action: "task_status",
      taskId: "t-123",
      recordHandoff: false
    });
    const runs = await getModuleRuns("hermes");
    assert.equal(runs.runs[0].runId, result.proof.runId);
    assert.equal(runs.runs[0].replay.available, true);
    assert.deepEqual(runs.runs[0].replay.input, {
      action: "task_status",
      taskId: "t-123",
      recordHandoff: false
    });
    assert.equal(JSON.stringify(result).includes(hermesHome), false);
    assert.equal(JSON.stringify(result).includes(cli), false);
    assert.equal(JSON.stringify(result).includes("private worker output"), false);
    assert.equal(JSON.stringify(result).includes("placeholder-secret-value"), false);
    const args = await readFile(path.join(hermesHome, "status-args.txt"), "utf8");
    assert.match(args, /kanban --board agent-os show t-123 --json/);
  });
});

