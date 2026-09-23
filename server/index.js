import express from "express";
import cors from "cors";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAdminRequest, clearAdminCookie, requireAdminWhenPublic, sessionStatus, setAdminCookie } from "./runtime/auth.js";
import {
  getBuilderReplayOverlay,
  injectBuilderReplayOverlay
} from "./runtime/builder-overlay.js";
import {
  getBuilderBootstrap,
  getBuilderLogs,
  getBuilderStatus,
  getBuilderUrl,
  prepareBuilderBootstrap,
  runBuilderSmokeTest,
  startBuilderSupervisor,
  stopBuilderSupervisor
} from "./runtime/builder-service.js";
import { configureConnection, getConnections } from "./runtime/connections.js";
import { assertAdminToken, prepareExport } from "./runtime/exporter.js";
import { listInstallRecipes, prepareInstall } from "./runtime/installers.js";
import {
  addMemory,
  configureMemoryVector,
  exportMemory,
  getMemoryState,
  importMemory,
  rebuildMemoryVectorIndex,
  searchMemory,
  updateMemory
} from "./runtime/memory.js";
import { getMemoryContext } from "./runtime/memory-context.js";
import {
  getElizaStatus
} from "./runtime/eliza.js";
import { loadLocalEnv } from "./runtime/env.js";
import { getExecutionGateStatus, setExecutionGateStatus } from "./runtime/execution-gate.js";
import { getLocalAgentDashboardStatus } from "./runtime/local-agents.js";
import { DEMO_BADGE, isDemoPublic } from "./runtime/demo-public.js";
import { isLiveChatEnabled } from "./runtime/live-flags.js";
import { dispatchLiveChat, getLiveStatus, runLiveMission } from "./runtime/live-chat.js";
import {
  getPublicDemoBuilder,
  publicDemoStatus,
  runPublicDemoBuilder,
  runPublicDemoChat,
  runPublicDemoMachine,
  runPublicDemoTimeline,
  savePublicDemoBuilder
} from "./runtime/demo-actions.js";
import { generateAgentWorkflow, refineAgentWorkflow } from "./runtime/agent-os-builder.js";
import { getCodexApiStatus, runCodexPreview, testCodexApi } from "./runtime/codex-api.js";
import { configureApiIntegration, listApiIntegrations, testApiIntegration } from "./runtime/api-integrations.js";
import { getAgentOsReadiness, getKernelStatus } from "./runtime/kernel.js";
import { exportVaultMarkdown } from "./runtime/vault-export.js";
import { getWorkspaceFile, listWorkspaceFiles, resolveWorkspaceFile, streamWorkspaceFile, writeWorkspaceText } from "./runtime/workspace.js";
import {
  cancelVideoRun,
  createSelfModuleItem,
  getSelfModuleState,
  getVideoRun,
  getVideoWorkerStatus,
  isLocalSelfModule,
  isParkedSelfModule,
  queueVideoJob,
  resolveVideoRunOutput,
  runGoalLoop,
  runSeoAudit,
  runSeoDiscovery,
  runSeoRankSnapshot,
  runVideoJob,
} from "./runtime/self-modules.js";
import { updateSelfModuleItem } from "./runtime/self-item-update.js";
import {
  configureSkill,
  fetchSkillMarketplaceFeed,
  getSkill,
  getSkillLogs,
  getSkillMarketplace,
  getSkillPublishers,
  getSkillRegistry,
  importMarketplaceSkill,
  importSkillBundle,
  installSkill,
  prepareSkillDependencies,
  saveSkillMarketplaceFeed,
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
} from "./runtime/skills.js";
import {
  getModule,
  getModuleLogs,
  getModuleRuns,
  getAgentRuns,
  getModuleSession,
  getModuleSessions,
  getModules,
  getOsAudit,
  getOsStatus,
  messageModuleSession,
  modulesToLegacySnapshot,
  runModule,
  startModuleSession,
  stopModuleSession,
  testModule
} from "./runtime/modules.js";
import {
  configureRouter,
  getRouterHealth,
  getRouterStatus,
  runRouter
} from "./runtime/router.js";
import {
  approveSchedulerJob,
  getSchedulerHistory,
  getSchedulerJob,
  getSchedulerState,
  pauseSchedulerJob,
  rejectSchedulerJob,
  resumeSchedulerJob,
  runSchedulerJob,
  runSchedulerTick,
  saveSchedulerJob,
  startSchedulerLoop,
  updateSchedulerJob
} from "./runtime/scheduler.js";
import {
  getSetupState,
  saveSetupState,
  startFirstSetupWorkflow
} from "./runtime/setup.js";
import {
  configureProviderSetup,
  getOllamaDoctor,
  getProviderModelInventory,
  getProviderSetupState,
  prepareProviderModel,
  testProviderSetup
} from "./runtime/provider-setup.js";
import {
  configureUsageBudget,
  getUsageReconciliation,
  getUsageState,
  importUsageBilling,
  previewUsageBillingImport,
  recordUsageEvent,
  runUsageReconciliation
} from "./runtime/usage.js";
import {
  getWorkflow,
  deleteWorkflow,
  getWorkflowRun,
  getWorkflowRunEvents,
  getWorkflowRunReplay,
  listWorkflows,
  resumeWorkflowRun,
  runWorkflow,
  saveWorkflow
} from "./runtime/workflows.js";
import { getDesktopContext, getVoiceControlStatus, runVoiceCommand } from "./runtime/voice-control.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const envFile = loadLocalEnv({ root });
const app = express();
const parsedPort = Number(process.env.PORT || 8090);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8090;
function bindAddress() {
  const raw = String(process.env.HOST || "0.0.0.0").trim();
  return /^[A-Za-z0-9_.:%-]+$/.test(raw) ? raw : "0.0.0.0";
}
const bindHost = bindAddress();
const originalBuilderUrl = getBuilderUrl();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/admin/session", (req, res) => {
  res.json(sessionStatus(req));
});

app.post("/api/admin/login", (req, res, next) => {
  try {
    assertAdminRequest(req);
    setAdminCookie(res, req.body?.adminToken || req.get("x-hermes-admin-token") || req.query?.adminToken || "");
    res.json({ ok: true, session: sessionStatus(req) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/logout", (_req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

app.get("/api/execution-gate", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getExecutionGateStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/execution-gate", async (req, res, next) => {
  try {
    assertAdminRequest(req);
    res.json(await setExecutionGateStatus(req.body || {}, { updatedBy: "dashboard-admin" }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", async (_req, res, next) => {
  try {
    const status = await getOsStatus();
    const demoPublic = isDemoPublic();
    res.json({
      ok: status.ok,
      service: status.service,
      version: status.version,
      mode: status.mode,
      timestamp: status.generatedAt,
      bind: bindHost,
      port,
      demoPublic,
      liveChat: isLiveChatEnabled(),
      badge: demoPublic ? DEMO_BADGE : isLiveChatEnabled() ? "Live operator · single machine" : null
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/os/status", async (_req, res, next) => {
  try {
    res.json(await getOsStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/os/foundation", async (_req, res, next) => {
  try {
    res.json({
      elizaOS: await getElizaStatus(),
      builder: await getBuilderStatus()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/os/kernel", async (_req, res, next) => {
  try {
    res.json(await getKernelStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/os/readiness", async (_req, res, next) => {
  try {
    res.json(await getAgentOsReadiness());
  } catch (error) {
    next(error);
  }
});

app.get("/api/os/audit", async (_req, res, next) => {
  try {
    res.json(await getOsAudit());
  } catch (error) {
    next(error);
  }
});

app.get("/api/voice/status", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getVoiceControlStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/voice/context", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getDesktopContext({
      includeUiElements: req.query?.ui !== "0" && req.query?.ui !== "false"
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice/command", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runVoiceCommand(req.body || {}, { runWorkflow, runModule }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/setup", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getSetupState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await saveSetupState(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup/start-first-workflow", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await startFirstSetupWorkflow());
  } catch (error) {
    next(error);
  }
});

app.get("/api/setup/providers", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getProviderSetupState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup/providers/:id/configure", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await configureProviderSetup(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup/providers/:id/test", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await testProviderSetup(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/setup/providers/ollama/doctor", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getOllamaDoctor());
  } catch (error) {
    next(error);
  }
});

app.get("/api/setup/providers/:id/models", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getProviderModelInventory(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup/providers/:id/pull-model", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await prepareProviderModel(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/router/status", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getRouterStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/router", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getRouterStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/router/configure", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await configureRouter(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/router/run", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runRouter(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/router/health", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getRouterHealth({ provider: req.query?.provider }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/usage", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getUsageState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/usage/budget", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await configureUsageBudget(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/usage/record", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await recordUsageEvent({ ...(req.body || {}), operation: req.body?.operation || "manual" }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/usage/import/preview", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await previewUsageBillingImport(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/usage/import", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await importUsageBilling(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/usage/reconciliation", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getUsageReconciliation());
  } catch (error) {
    next(error);
  }
});

app.post("/api/usage/reconciliation/run", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runUsageReconciliation(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scheduler", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getSchedulerState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scheduler/jobs", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await saveSchedulerJob(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scheduler/jobs/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const job = await getSchedulerJob(req.params.id);
    if (!job) {
      res.status(404).json({ ok: false, error: "scheduler job not found" });
      return;
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.put("/api/scheduler/jobs/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await updateSchedulerJob(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scheduler/jobs/:id/pause", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await pauseSchedulerJob(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scheduler/jobs/:id/resume", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await resumeSchedulerJob(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scheduler/jobs/:id/approve", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await approveSchedulerJob(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scheduler/jobs/:id/reject", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await rejectSchedulerJob(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scheduler/jobs/:id/run", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runSchedulerJob(req.params.id, { manual: true, payload: req.body || {} }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scheduler/jobs/:id/history", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getSchedulerHistory(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scheduler/tick", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runSchedulerTick(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/memory", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getMemoryState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/memory/items", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await addMemory(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/memory/items/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await updateMemory(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/memory/search", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await searchMemory(req.query || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/memory/context", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getMemoryContext(req.query || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/memory/vector/config", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await configureMemoryVector(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/memory/vector/rebuild", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await rebuildMemoryVectorIndex(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/memory/import", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await importMemory(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/memory/export", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await exportMemory(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getSkillRegistry());
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/import", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await importSkillBundle(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills/marketplace", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getSkillMarketplace());
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/marketplace/feeds", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await saveSkillMarketplaceFeed(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/marketplace/feeds/:id/fetch", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await fetchSkillMarketplaceFeed(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/marketplace/feeds/:feedId/import/:skillId", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await importMarketplaceSkill(req.params.feedId, req.params.skillId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills/publishers", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getSkillPublishers());
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/publishers/policy", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await updateSkillPublisherPolicy(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/publishers/:fingerprint/reputation", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await updateSkillPublisherReputation(req.params.fingerprint, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/publishers/:fingerprint/allow", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await setSkillPublisherAllowed(req.params.fingerprint, true, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/publishers/:fingerprint/allow/remove", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await setSkillPublisherAllowed(req.params.fingerprint, false));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/publishers/:fingerprint/block", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await setSkillPublisherBlocked(req.params.fingerprint, true, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/publishers/:fingerprint/block/remove", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await setSkillPublisherBlocked(req.params.fingerprint, false));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/trust/:fingerprint", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await trustSkillPublisher(req.params.fingerprint, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/trust/:fingerprint/remove", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await untrustSkillPublisher(req.params.fingerprint));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const skill = await getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ ok: false, error: "skill not found" });
      return;
    }
    res.json(skill);
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/install", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await installSkill(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/dependencies/prepare", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await prepareSkillDependencies(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/configure", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await configureSkill(req.params.id, req.body?.fields || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/update", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await updateSkill(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/enable", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await setSkillEnabled(req.params.id, true));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/disable", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await setSkillEnabled(req.params.id, false));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/uninstall", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await uninstallSkill(req.params.id, { removeBundle: Boolean(req.body?.removeBundle) }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skills/:id/test", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await testSkill(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills/:id/logs", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getSkillLogs(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules", async (_req, res, next) => {
  try {
    res.json({ modules: await getModules() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id", async (req, res, next) => {
  try {
    const module = await getModule(req.params.id);
    if (!module) {
      res.status(404).json({ ok: false, error: "module not found" });
      return;
    }
    res.json(module);
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/test", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await testModule(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/run", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runModule(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/logs", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getModuleLogs(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/runs", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getModuleRuns(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-runs", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getAgentRuns({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/sessions", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getModuleSessions(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/sessions", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await startModuleSession(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/sessions/:sessionId", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getModuleSession(req.params.id, req.params.sessionId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/sessions/:sessionId/stop", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await stopModuleSession(req.params.id, req.params.sessionId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/sessions/:sessionId/messages", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await messageModuleSession(req.params.id, req.params.sessionId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/installers", (_req, res) => {
  res.json({ installers: listInstallRecipes() });
});

app.post("/api/modules/:id/install", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await prepareInstall(req.params.id, { execute: Boolean(req.body?.execute) }));
  } catch (error) {
    next(error);
  }
});

function rejectParkedSelfModule(res, id) {
  res.status(404).json({
    ok: false,
    error: `${id} is parked for this release.`
  });
}

app.get("/api/self/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    if (isParkedSelfModule(req.params.id)) {
      rejectParkedSelfModule(res, req.params.id);
      return;
    }
    if (!isLocalSelfModule(req.params.id)) {
      res.status(404).json({ ok: false, error: "self module not found" });
      return;
    }
    res.json(await getSelfModuleState(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/self/:id/items", requireAdminWhenPublic, async (req, res, next) => {
  try {
    if (isParkedSelfModule(req.params.id)) {
      rejectParkedSelfModule(res, req.params.id);
      return;
    }
    if (!isLocalSelfModule(req.params.id)) {
      res.status(404).json({ ok: false, error: "self module not found" });
      return;
    }
    res.status(201).json(await createSelfModuleItem(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/self/:id/items/:itemId", requireAdminWhenPublic, async (req, res, next) => {
  try {
    if (isParkedSelfModule(req.params.id)) {
      rejectParkedSelfModule(res, req.params.id);
      return;
    }
    if (!isLocalSelfModule(req.params.id)) {
      res.status(404).json({ ok: false, error: "self module not found" });
      return;
    }
    res.json(await updateSelfModuleItem(req.params.id, req.params.itemId, req.body || {}));
  } catch (error) {
    if (error && error.statusCode === 404) {
      res.status(404).json({ ok: false, error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/self/goals/:goalId/loop", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runGoalLoop(req.params.goalId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/self/seo/:briefId/audit", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runSeoAudit(req.params.briefId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/self/seo/:briefId/discover", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runSeoDiscovery(req.params.briefId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/self/seo/:briefId/rank", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runSeoRankSnapshot(req.params.briefId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/self/video/worker", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getVideoWorkerStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/self/video/:jobId/run", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runVideoJob(req.params.jobId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/self/video/:jobId/queue", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await queueVideoJob(req.params.jobId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/self/video/runs/:runId", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getVideoRun(req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/self/video/runs/:runId/cancel", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await cancelVideoRun(req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/self/video/runs/:runId/download/:fileName", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const file = await resolveVideoRunOutput(req.params.runId, req.params.fileName);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${String(file.downloadName || "download").replace(/"/g, "")}"`);
    createReadStream(file.filePath).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/connections", async (_req, res, next) => {
  try {
    res.json(await getConnections());
  } catch (error) {
    next(error);
  }
});

app.post("/api/connections/:id/configure", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await configureConnection(req.params.id, req.body?.fields || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/connections/:id/test", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await testModule(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/local-agents", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getLocalAgentDashboardStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/product/status", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    const agents = await getLocalAgentDashboardStatus();
    const memory = await getMemoryState().catch(() => null);
    const chatTried = Boolean(
      memory?.memories?.some((item) =>
        item?.namespace === "agent-runs" ||
        (Array.isArray(item?.tags) && item.tags.includes("agent-run"))
      )
    );
    const demoPublic = isDemoPublic();
    const live = demoPublic ? null : await getLiveStatus();
    res.json({
      ok: true,
      hosted: false,
      edition: demoPublic ? "public-demo" : "local-v1",
      demoPublic,
      liveChat: Boolean(live?.liveChat),
      badge: demoPublic ? DEMO_BADGE : live?.badge || null,
      name: "Agent OS",
      publicSummary: demoPublic
        ? `${DEMO_BADGE}. Simulated agents only. Your Claude, Cursor, Codex, and Hermes are not connected.`
        : live?.liveChat
          ? "Live operator mode on this machine. Chat and missions call OmniRoute, Hermes, or OpenClaw when those backends are configured. Dry-run stays available."
          : "Local-first dashboard. Dry-run by default. Not a hosted multi-tenant app.",
      port,
      bind: bindHost,
      env: {
        loaded: Boolean(envFile.loaded),
        publicMode: process.env.HERMES_AGENT_OS_PUBLIC_MODE === "1",
        requireAuth: process.env.HERMES_AGENT_OS_REQUIRE_AUTH === "1",
        demoPublic
      },
      executionGate: agents.executionGate,
      agents: agents.summary,
      firstRun: demoPublic
        ? [
            { id: "runtime", label: "Public demo is up", done: true, detail: `Listening on ${bindHost}:${port}. ${DEMO_BADGE}.` },
            { id: "fleet", label: "Demo fleet online", done: true, detail: "Simulated agents are labeled Demo. Your real Claude is not connected." },
            { id: "chat", label: "Run a simulated timeline", done: chatTried, detail: "Unified Chat returns a multi-step plan and can write a sandbox note." },
            { id: "exec", label: "Host shell stays locked", done: !agents.executionGate.enabled, detail: agents.executionGate.publicSummary }
          ]
        : [
        { id: "runtime", label: "Runtime is up", done: true, detail: `Listening on port ${port}.` },
        { id: "env", label: "Optional .env loaded", done: Boolean(envFile.loaded), detail: envFile.loaded ? "Local .env values applied without overriding the process environment." : "Copy .env.example to .env only if you need keys. The app runs without it." },
        {
          id: "chat",
          label: live?.liveChat ? "Send a live chat turn" : "Try Unified Chat in dry-run",
          done: chatTried,
          detail: chatTried
            ? "At least one agent handoff is in local Memory."
            : live?.liveChat
              ? "Hermes and OpenClaw call the live lane. Leave the dry-run toggle on when you only want a plan."
              : "Claude and Hermes return dry-run plans until AGENT_OS_LIVE_CHAT=1."
        },
        {
          id: "exec",
          label: live?.liveChat ? "Live lane" : "Keep live execution off",
          done: live?.liveChat ? true : !agents.executionGate.enabled,
          detail: live?.liveChat
            ? "AGENT_OS_LIVE_CHAT is on. Native CLIs still need HERMES_AGENT_OS_ENABLE_EXEC=1."
            : agents.executionGate.publicSummary
        }
      ]
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspace", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await listWorkspaceFiles({
      query: req.query?.query,
      kind: req.query?.kind
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspace/file", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getWorkspaceFile(String(req.query?.id || "")));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspace/raw", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const file = await resolveWorkspaceFile(String(req.query?.id || ""));
    streamWorkspaceFile(file, res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspace/files", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await writeWorkspaceText(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspace/vault/export", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await exportVaultMarkdown());
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-os/codex/status", async (_req, res, next) => {
  try {
    res.json(await getCodexApiStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-os/codex/test", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await testCodexApi());
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-os/codex/preview", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runCodexPreview(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-os/api-integrations", async (_req, res, next) => {
  try {
    res.json(await listApiIntegrations());
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-os/api-integrations/:id/configure", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await configureApiIntegration(req.params.id, req.body?.fields || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-os/api-integrations/:id/test", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await testApiIntegration(req.params.id, req.body?.fields || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json({ workflows: await listWorkflows() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await saveWorkflow(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-os/workflows/generate", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.status(201).json(await generateAgentWorkflow(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-os/workflows/refine", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await refineAgentWorkflow(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const workflow = await getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ ok: false, error: "workflow not found" });
      return;
    }
    res.json(workflow);
  } catch (error) {
    next(error);
  }
});

app.put("/api/workflows/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await saveWorkflow({ ...(req.body || {}), id: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workflows/:id", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await deleteWorkflow(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/:id/run", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runWorkflow(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows/:id/runs/:runId", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const run = await getWorkflowRun(req.params.id, req.params.runId);
    if (!run) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows/:id/runs/:runId/events", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const events = await getWorkflowRunEvents(req.params.id, req.params.runId);
    if (!events) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    if (String(req.get("accept") || "").includes("text/event-stream")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      for (const event of events.events) {
        res.write(`event: ${event.type || "workflow_event"}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write("event: run_status\n");
      res.write(`data: ${JSON.stringify({ workflowId: events.workflowId, runId: events.runId, status: events.status, eventCount: events.eventCount })}\n\n`);
      res.end();
      return;
    }
    res.json(events);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows/:id/runs/:runId/replay", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const replay = await getWorkflowRunReplay(req.params.id, req.params.runId);
    if (!replay) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json(replay);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/:id/runs/:runId/resume", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await resumeWorkflowRun(req.params.id, req.params.runId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/export/prepare", async (req, res, next) => {
  try {
    assertAdminToken(req);
    res.json(await prepareExport({ sourceRoot: root, requestedBy: "api" }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/builder/status", async (_req, res, next) => {
  try {
    res.json(await getBuilderStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/builder/bootstrap", async (_req, res, next) => {
  try {
    res.json(await getBuilderBootstrap());
  } catch (error) {
    next(error);
  }
});

app.post("/api/builder/bootstrap/prepare", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await prepareBuilderBootstrap(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/builder/smoke-test", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runBuilderSmokeTest(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/builder/start", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await startBuilderSupervisor());
  } catch (error) {
    next(error);
  }
});

app.post("/api/builder/stop", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await stopBuilderSupervisor());
  } catch (error) {
    next(error);
  }
});

app.get("/api/builder/logs", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getBuilderLogs({ limit: req.query?.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/builder/replay-overlay", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await getBuilderReplayOverlay(req.query.workflowId, req.query.runId));
  } catch (error) {
    next(error);
  }
});

async function proxyOriginalBuilder(req, res, next) {
  try {
    const incomingPath = req.originalUrl.startsWith("/agent-builder-source")
      ? req.originalUrl.replace(/^\/agent-builder-source\/?/, "/")
      : req.originalUrl;
    const target = new URL(incomingPath || "/", originalBuilderUrl);
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        accept: req.get("accept") || "*/*",
        "accept-language": req.get("accept-language") || "en-US,en;q=0.9",
        "user-agent": req.get("user-agent") || "HermesAgentOSProxy/1.0"
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      duplex: ["GET", "HEAD"].includes(req.method) ? undefined : "half"
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) return;
      res.setHeader(key, value);
    });

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      let html = await upstream.text();
      html = html
        .replaceAll('href="/_next/', 'href="/_next/')
        .replaceAll('src="/_next/', 'src="/_next/')
        .replaceAll(originalBuilderUrl, "")
        .replaceAll("http://127.0.0.1:3000", "")
        .replaceAll("http://127.0.0.1:3100", "")
        .replaceAll("http://localhost:3000", "");
      html = injectBuilderReplayOverlay(html);
      res.send(html);
      return;
    }

    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    next(error);
  }
}

app.all("/agent-builder-source", proxyOriginalBuilder);
app.all("/agent-builder-source/*", proxyOriginalBuilder);
app.all("/_next/*", proxyOriginalBuilder);

// Compatibility aliases for the previous dashboard build.
app.get("/api/integrations", async (_req, res, next) => {
  try {
    const [status, modules] = await Promise.all([getOsStatus(), getModules()]);
    res.json(modulesToLegacySnapshot(status, modules));
  } catch (error) {
    next(error);
  }
});

app.get("/api/connections/templates", async (_req, res, next) => {
  try {
    res.json(await getConnections());
  } catch (error) {
    next(error);
  }
});

app.post("/api/integrations/:id/test", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await testModule(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:id/message", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) {
      res.status(400).json({ ok: false, error: "message is required" });
      return;
    }
    res.json(await runModule(req.params.id, { message }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/live/status", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getLiveStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/live/chat", requireAdminWhenPublic, async (req, res, next) => {
  try {
    const result = await dispatchLiveChat(req.body || {});
    res.status(result.mode === "invalid" ? 400 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/live/mission", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runLiveMission(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/demo/status", requireAdminWhenPublic, (_req, res) => {
  res.json(publicDemoStatus(isDemoPublic()));
});

app.post("/api/demo/chat", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runPublicDemoChat(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/timeline", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runPublicDemoTimeline(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/machine/preview", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runPublicDemoMachine(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/demo/builder", requireAdminWhenPublic, async (_req, res, next) => {
  try {
    res.json(await getPublicDemoBuilder());
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/builder", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await savePublicDemoBuilder(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/builder/run", requireAdminWhenPublic, async (req, res, next) => {
  try {
    res.json(await runPublicDemoBuilder(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.use(express.static(dist));

app.get("*", (_req, res) => {
  res.sendFile(path.join(dist, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error?.status || 500).json({
    ...(error?.body || {}),
    ok: false,
    error: error?.message || "Internal server error",
    audit: error?.audit
  });
});

app.listen(port, bindHost, () => {
  const demoPublic = isDemoPublic();
  console.log(
    demoPublic
      ? `Agent OS public demo · sandboxed http://${bindHost}:${port}`
      : `Agent OS (local v1, dry-run default) http://${bindHost}:${port}`
  );
  startSchedulerLoop();
});
