import { getBuilderStatus } from "./builder-service.js";
import { getElizaStatus } from "./eliza.js";
import { getMemoryState } from "./memory.js";
import { getModules, getOsStatus } from "./modules.js";
import { checkProviderHealth, getRouterStatus } from "./router.js";
import { getSchedulerState } from "./scheduler.js";
import { getSkillRegistry } from "./skills.js";
import { getUsageState } from "./usage.js";
import { listWorkflows } from "./workflows.js";
import { getExecutionGateStatus } from "./execution-gate.js";

function now() {
  return new Date().toISOString();
}

function component(input) {
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    status: input.status,
    configured: Boolean(input.configured),
    missing: input.missing || [],
    capabilities: input.capabilities || [],
    evidence: input.evidence || [],
    metrics: input.metrics || {},
    publicSummary: input.publicSummary || "",
    nextFix: input.nextFix || ""
  };
}

function summarizeComponents(components) {
  return {
    total: components.length,
    implemented: components.filter((item) => item.status === "implemented").length,
    partial: components.filter((item) => item.status === "partial").length,
    configRequired: components.filter((item) => item.status === "config_required").length,
    actionRequired: components.filter((item) => item.status === "action_required" || item.status === "error").length
  };
}

function requirement(input) {
  return {
    id: input.id,
    label: input.label,
    status: input.status,
    required: input.required !== false,
    target: input.target || null,
    evidence: input.evidence || "",
    missing: input.missing || [],
    nextAction: input.nextAction || ""
  };
}

function buildAgentOsReadiness({ modules, router, routerHealth, builder, scheduler, memory, workflows, executionGate = null }) {
  const byId = new Map(modules.map((item) => [item.id, item]));
  const agentModules = modules.filter((item) => item.category === "agent");
  const connectedAgents = agentModules.filter((item) => item.status === "connected");
  const configuredProviders = router.providers.filter((provider) => provider.status === "connected");
  const healthyProvider = routerHealth?.status === "healthy" ? routerHealth : null;
  const localModules = ["memory", "kanban", "scheduler", "usage-credits"].map((id) => byId.get(id)).filter(Boolean);
  const localLoopReady = localModules.every((item) => item.status === "connected");
  const workflowReady = workflows.length > 0;
  const execGateEnabled = Boolean(executionGate?.enabled);
  const providerReady = Boolean(router.nextProvider && healthyProvider);
  const agentReady = connectedAgents.length > 0;
  const required = [
    requirement({
      id: "runtime",
      label: "Runtime API",
      status: byId.get("elizaos-runtime")?.status === "connected" ? "ready" : "blocked",
      target: "elizaos-runtime",
      evidence: byId.get("elizaos-runtime")?.publicSummary || "elizaOS runtime state unavailable.",
      missing: byId.get("elizaos-runtime")?.missing || [],
      nextAction: byId.get("elizaos-runtime")?.status === "connected" ? "Runtime is loadable." : "Install or repair @elizaos/core."
    }),
    requirement({
      id: "provider-router",
      label: "Executable model route",
      status: providerReady ? "ready" : "blocked",
      target: "provider-router",
      evidence: providerReady
        ? `Router health check passed for ${router.nextProvider.label}.`
        : router.nextProvider
          ? `${router.nextProvider.label} is configured but did not pass health verification${routerHealth?.message ? `: ${routerHealth.message}` : "."}`
          : "No user-owned cloud provider or local Ollama route is configured.",
      missing: providerReady ? [] : router.nextProvider ? [`Healthy ${router.nextProvider.label} route`] : ["OpenRouter, Ollama, MiniMax, OpenAI, Anthropic, or Gemini"],
      nextAction: providerReady ? "Run a dry-run prompt, then enable live execution when trusted." : router.nextProvider ? "Run provider health check, fix the key/server/model, or choose another provider." : "Connect one provider or local Ollama endpoint."
    }),
    requirement({
      id: "agent-control",
      label: "Controllable agent",
      status: agentReady ? "ready" : "blocked",
      target: connectedAgents[0]?.id || "hermes",
      evidence: agentReady
        ? `${connectedAgents.map((item) => item.label).join(", ")} connected.`
        : "No agent card is currently connected to a real local CLI, runtime profile, or routing profile.",
      missing: agentReady ? [] : agentModules.flatMap((item) => item.missing || []).slice(0, 6),
      nextAction: agentReady ? "Open the connected agent control room and run a prompt." : "Connect Hermes or a local CLI agent."
    }),
    requirement({
      id: "local-loop",
      label: "Proof loop",
      status: localLoopReady ? "ready" : "blocked",
      target: "kanban",
      evidence: localLoopReady
        ? "Memory, Kanban, Scheduler, and Usage Credits are connected."
        : "One or more local proof-loop modules are unavailable.",
      missing: localLoopReady ? [] : localModules.filter((item) => item.status !== "connected").map((item) => item.label),
      nextAction: localLoopReady ? "Runs can write memory, handoffs, logs, schedule, and usage proof." : "Repair local self modules before claiming OS proof."
    }),
    requirement({
      id: "workflow-engine",
      label: "Workflow runner",
      status: workflowReady ? "ready" : "blocked",
      target: "workflows",
      evidence: workflowReady ? `${workflows.length} workflow${workflows.length === 1 ? "" : "s"} available.` : "No workflow definitions found.",
      missing: workflowReady ? [] : ["sample workflow"],
      nextAction: workflowReady ? "Run a workflow and inspect replay proof." : "Create or import a workflow."
    })
  ];
  const optional = [
    requirement({
      id: "live-execution-gate",
      label: "Live execution gate",
      status: execGateEnabled ? "ready" : "dry_run_only",
      required: false,
      target: "setup",
      evidence: execGateEnabled
        ? "HERMES_AGENT_OS_ENABLE_EXEC=1 is enabled for trusted live execution."
        : "Execution is intentionally dry-run-first until HERMES_AGENT_OS_ENABLE_EXEC=1 and dryRun:false are both set.",
      nextAction: execGateEnabled ? "Use live mode only on a trusted local machine." : "Keep dry-run mode for setup, or enable the server execution gate when ready."
    }),
    requirement({
      id: "firecrawl-builder",
      label: "Visual builder execution",
      status: byId.get("firecrawl-builder")?.status === "connected" ? "ready" : "optional_setup",
      required: false,
      target: "firecrawl-builder",
      evidence: byId.get("firecrawl-builder")?.status === "connected"
        ? "Firecrawl Builder has auth, storage, and Firecrawl configuration."
        : "Builder design can be present, but upstream execution still needs Convex, Clerk, Firecrawl, and LLM keys.",
      missing: byId.get("firecrawl-builder")?.missing || [],
      nextAction: byId.get("firecrawl-builder")?.status === "connected" ? "Open Agent Builder and run a workflow." : "Configure builder dependencies before claiming visual builder execution."
    })
  ];
  const blocked = required.filter((item) => item.status !== "ready");
  const status = blocked.length
    ? "blocked"
    : execGateEnabled ? "live_execution_ready" : "dry_run_ready";
  const totalRequired = required.length;
  const readyRequired = totalRequired - blocked.length;
  return {
    id: "agent-os-readiness",
    label: "Agent OS Readiness",
    status,
    generatedAt: now(),
    score: Math.round((readyRequired / totalRequired) * 100),
    summary: {
      required: totalRequired,
      readyRequired,
      blocked: blocked.length,
      connectedAgents: connectedAgents.length,
      totalAgents: agentModules.length,
      connectedProviders: healthyProvider ? 1 : 0,
      configuredProviders: configuredProviders.length,
      totalProviders: router.providers.length,
      dryRunDefault: !execGateEnabled,
      schedulerJobs: scheduler.summary?.total || 0,
      activeMemories: memory.summary?.active || 0
    },
    primaryBlocker: blocked[0] || optional.find((item) => item.status !== "ready") || null,
    requirements: required,
    optional,
    executableTargets: {
      agents: connectedAgents.map((item) => ({ id: item.id, label: item.label, status: item.status })),
      providers: healthyProvider && router.nextProvider ? [{ id: router.nextProvider.id, label: router.nextProvider.label, model: router.nextProvider.model }] : []
    },
    publicSummary: blocked.length
      ? `${blocked.length} required gate${blocked.length === 1 ? "" : "s"} must be fixed before this feels like a real Agent OS.`
      : execGateEnabled
        ? "The core Agent OS loop is ready for live execution on this trusted local machine."
        : "The core Agent OS loop is ready for dry-run proof; live execution is still gated off."
  };
}

export async function getAgentOsReadiness() {
  const [modules, router, builder, scheduler, memory, workflows, executionGate] = await Promise.all([
    getModules(),
    getRouterStatus(),
    getBuilderStatus(),
    getSchedulerState(),
    getMemoryState(),
    listWorkflows(),
    getExecutionGateStatus()
  ]);
  const routerHealth = router.nextProvider ? await checkProviderHealth(router.nextProvider.id) : null;
  return buildAgentOsReadiness({ modules, router, routerHealth, builder, scheduler, memory, workflows, executionGate });
}

export async function getKernelStatus() {
  const [osStatus, modules, eliza, builder, router, scheduler, memory, skills, usage, workflows, executionGate] = await Promise.all([
    getOsStatus(),
    getModules(),
    getElizaStatus(),
    getBuilderStatus(),
    getRouterStatus(),
    getSchedulerState(),
    getMemoryState(),
    getSkillRegistry(),
    getUsageState(),
    listWorkflows(),
    getExecutionGateStatus()
  ]);
  const routerHealth = router.nextProvider ? await checkProviderHealth(router.nextProvider.id) : null;
  const readiness = buildAgentOsReadiness({ modules, router, routerHealth, builder, scheduler, memory, workflows, executionGate });
  const routerHealthy = routerHealth?.status === "healthy";
  const moduleCategories = modules.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});
  const connectedModules = modules.filter((item) => item.status === "connected").length;
  const setupModules = modules.filter((item) => item.status === "ready_to_configure").length;
  const actionModules = modules.filter((item) => ["missing_dependency", "error"].includes(item.status)).length;
  const goalsModule = modules.find((item) => item.id === "goals");
  const kanbanModule = modules.find((item) => item.id === "kanban");
  const components = [
    component({
      id: "runtime-core",
      label: "Runtime Core",
      kind: "kernel",
      status: eliza.ok ? "implemented" : "error",
      configured: eliza.ok,
      missing: eliza.missingExports,
      capabilities: ["agent-runtime", "services", "plugins", "model-routing"],
      evidence: ["server/runtime/eliza.js", "GET /api/os/foundation", "@elizaos/core"],
      metrics: { version: eliza.version, exports: eliza.exports.length },
      publicSummary: eliza.ok
        ? `elizaOS core ${eliza.version} is installed and loadable.`
        : "elizaOS core is not loadable.",
      nextFix: eliza.ok ? "Expose deeper eliza service/plugin mapping." : "Install or repair @elizaos/core."
    }),
    component({
      id: "module-registry",
      label: "Module Registry",
      kind: "kernel",
      status: "implemented",
      configured: true,
      capabilities: ["module-discovery", "status", "configure", "test", "run", "logs"],
      evidence: ["server/runtime/modules.js", "GET /api/modules", "GET /api/os/audit"],
      metrics: {
        total: modules.length,
        connected: connectedModules,
        setup: setupModules,
        actionRequired: actionModules,
        categories: moduleCategories
      },
      publicSummary: `${modules.length} modules are registered with sanitized status, actions, and evidence.`,
      nextFix: "Add a full audit report export endpoint."
    }),
    component({
      id: "goals-loop",
      label: "Goals Loop",
      kind: "self-module",
      status: goalsModule?.status === "connected" ? "implemented" : "partial",
      configured: goalsModule?.status === "connected",
      missing: goalsModule?.missing || [],
      capabilities: ["local-goals", "provider-router-planning", "dry-run-default", "next-action", "run-history", "usage-hooks", "scheduler-action", "approval-gate", "redacted-state"],
      evidence: ["server/runtime/self-modules.js", "POST /api/self/goals/:goalId/loop", "server/runtime/scheduler.js", "server/runtime/router.js", "test/runtime.test.js"],
      metrics: {
        status: goalsModule?.status || "unknown",
        configured: Boolean(goalsModule?.configured)
      },
      publicSummary: "Goals can run dry-run-first Provider Router planning loops manually or from scheduler jobs with approval gates, next action, run history, usage tracking, and redacted API state.",
      nextFix: "Optionally decompose goal loop plans into multiple Kanban task cards."
    }),
    component({
      id: "kanban-handoffs",
      label: "Kanban Handoffs",
      kind: "self-module",
      status: kanbanModule?.status === "connected" ? "implemented" : "partial",
      configured: kanbanModule?.status === "connected",
      missing: kanbanModule?.missing || [],
      capabilities: ["local-cards", "workflow-task-cards", "workflow-approval-cards", "scheduler-approval-cards", "source-links", "redacted-state"],
      evidence: ["server/runtime/self-modules.js", "server/runtime/workflows.js", "server/runtime/scheduler.js", "POST /api/self/kanban", "test/runtime.test.js"],
      metrics: {
        status: kanbanModule?.status || "unknown",
        configured: Boolean(kanbanModule?.configured),
        stats: kanbanModule?.stats || {}
      },
      publicSummary: "Kanban stores local cards and now receives source-linked task and approval cards from workflow nodes and scheduler gates.",
      nextFix: "Add drag/drop board controls and optional external issue sync."
    }),
    component({
	      id: "provider-router",
	      label: "Provider Router",
	      kind: "model-router",
	      status: routerHealthy ? "implemented" : "config_required",
	      configured: routerHealthy,
	      missing: routerHealthy ? [] : router.nextProvider ? [`Healthy ${router.nextProvider.label} route`] : ["OpenRouter or Ollama or MiniMax or OpenAI or Anthropic or Gemini provider"],
	      capabilities: ["fallback-order", "dry-run-dispatch", "health-checks", "usage-hooks", "guided-provider-setup", "ollama-model-inventory"],
	      evidence: ["server/runtime/router.js", "server/runtime/provider-setup.js", "GET /api/setup/providers", "GET /api/setup/providers/ollama/models", "GET /api/router", "GET /api/router/status", "GET /api/router/health"],
	      metrics: {
	        providers: router.providers.length,
	        configuredProviders: router.providers.filter((provider) => provider.configured).length,
	        healthyProviders: routerHealthy ? 1 : 0,
	        dryRunDefault: router.dryRunDefault
	      },
	      publicSummary: routerHealthy
	        ? `Router health check passed for ${router.nextProvider?.label || "configured provider"}.`
	        : router.nextProvider
	          ? `${router.nextProvider.label} is configured, but provider health is not verified.`
	        : "Router is wired, but needs at least one user-owned/local provider.",
	      nextFix: routerHealthy ? "Run a dry-run prompt, then enable live execution only on a trusted machine." : router.nextProvider ? "Fix the selected provider health check or choose another provider." : "Configure one provider or local Ollama host."
	    }),
    component({
      id: "workflow-engine",
      label: "Workflow Engine",
      kind: "orchestration",
      status: "implemented",
      configured: true,
      capabilities: ["graph-traversal", "branch-routing", "parallel-fanout", "parallel-replay", "visual-replay", "builder-replay-overlay", "loop-guards", "agent-nodes", "mcp-tool-nodes", "kanban-task-cards", "retry", "human-approval", "kanban-approval-cards", "run-events"],
      evidence: ["server/runtime/workflows.js", "GET /api/workflows", "POST /api/workflows/:id/run", "GET /api/workflows/:id/runs/:runId/events", "GET /api/workflows/:id/runs/:runId/replay"],
      metrics: {
        workflows: workflows.length,
        starterWorkflow: workflows.find((workflow) => workflow.id === "blank-open-agent-builder") ? "present" : "missing"
      },
      publicSummary: "Workflow graphs execute through edges with branch routing, parallel fan-out, loop guards, retry, approval resume, Kanban task/approval cards, replay events, visual replay maps, and upstream builder replay overlays.",
      nextFix: "Add Playwright visual overlay smoke after authenticated builder boot."
    }),
    component({
      id: "scheduler",
      label: "Scheduler",
      kind: "background-jobs",
      status: scheduler.enabled ? "implemented" : "disabled",
      configured: scheduler.enabled,
      missing: scheduler.enabled ? [] : ["HERMES_AGENT_OS_SCHEDULER"],
      capabilities: ["interval-jobs", "workflow-runs", "self-module-tasks", "goal-loop-action", "approval-gates", "kanban-approval-cards", "retry", "pause-resume", "history", "leader-lock", "stale-lock-recovery"],
      evidence: ["server/runtime/scheduler.js", "GET /api/scheduler", "POST /api/scheduler/tick"],
      metrics: {
        ...scheduler.summary,
        lockEnabled: scheduler.lock?.enabled,
        lockMode: scheduler.lock?.mode,
        lockHeld: scheduler.lock?.held,
        lockTtlMs: scheduler.lock?.ttlMs
      },
      publicSummary: scheduler.enabled
        ? `Scheduler is active with ${scheduler.summary.total} jobs, ${scheduler.summary.pendingApproval || 0} pending approval, and ${scheduler.lock?.enabled ? "a leader lock" : "lock disabled"}.`
        : "Scheduler is disabled by environment config.",
      nextFix: "Add distributed queue/worker mode if deployments outgrow one local scheduler leader."
    }),
    component({
      id: "memory",
      label: "Memory",
      kind: "state",
      status: "implemented",
      configured: true,
      capabilities: ["semantic", "episodic", "procedural", "privacy", "import-export", "lexical-search", "vector-search", "hybrid-ranking", "optional-embedding-providers", "qdrant-remote-vector-index"],
      evidence: ["server/runtime/memory.js", "GET /api/memory", "GET /api/memory/search", "POST /api/memory/vector/config", "POST /api/memory/vector/rebuild"],
      metrics: {
        ...memory.summary,
        vector: memory.vector
      },
      publicSummary: `${memory.summary.active} active memories are stored; vector memory is ${memory.vector?.status || "unknown"} via ${memory.vector?.provider || "unknown"}.`,
      nextFix: "Add more remote vector backends beyond Qdrant only if package users need them."
    }),
    component({
      id: "skill-registry",
      label: "Skill Registry",
      kind: "extensions",
      status: "implemented",
      configured: true,
      capabilities: ["catalog", "signed-bundle-import", "marketplace-feeds", "publisher-trust", "publisher-reputation", "publisher-allowlist", "publisher-blocklist", "signed-dependencies", "update-channels", "marketplace-updates", "ed25519-verification", "permissions", "install", "enable-disable", "required-keys", "tests", "logs"],
      evidence: ["server/runtime/skills.js", "GET /api/skills", "GET /api/skills/marketplace", "GET /api/skills/publishers", "POST /api/skills/marketplace/feeds/:id/fetch", "POST /api/skills/import", "POST /api/skills/:id/update", "POST /api/skills/:id/test"],
      metrics: skills.summary,
      publicSummary: `${skills.summary.total} skills are available; ${skills.summary.marketplaceItems || 0} marketplace skill${skills.summary.marketplaceItems === 1 ? "" : "s"} cached; ${skills.summary.trustedPublishers || 0} publisher${skills.summary.trustedPublishers === 1 ? "" : "s"} trusted; ${skills.summary.marketplaceUpdateItems || 0} marketplace update${skills.summary.marketplaceUpdateItems === 1 ? "" : "s"} available; allowlist mode is ${skills.summary.allowlistEnforced ? "enforced" : "discovery"}.`,
      nextFix: "Add skill dependency auto-install suggestions and curated release notes."
    }),
    component({
      id: "usage-ledger",
      label: "Usage Ledger",
      kind: "accounting",
      status: "implemented",
      configured: true,
      capabilities: ["usage-records", "cost-estimates", "daily-limits", "monthly-limits", "budget-blocking", "provider-billing-reconciliation", "billing-import-preview", "billing-import-dedupe"],
      evidence: ["server/runtime/usage.js", "GET /api/usage", "GET /api/usage/reconciliation", "POST /api/usage/reconciliation/run", "POST /api/usage/budget", "POST /api/usage/import/preview", "POST /api/usage/import"],
      metrics: {
        ...usage.summary.total,
        reconciliation: usage.reconciliation?.summary
      },
      publicSummary: `${usage.summary.total.calls} provider usage call${usage.summary.total.calls === 1 ? "" : "s"} recorded; CSV/JSON billing imports are available for providers without supported billing APIs.`,
      nextFix: "Add provider-specific live billing APIs where supported."
    }),
    component({
      id: "firecrawl-builder-adapter",
      label: "Firecrawl Builder Adapter",
      kind: "builder",
      status: builder.sourcePresent && builder.dependenciesInstalled ? "implemented" : "config_required",
      configured: Boolean(builder.readyToBoot || builder.live),
      missing: builder.missingConfig || builder.requiredConfig || [],
      capabilities: ["upstream-source", "proxy", "theme-override", "workflow-design", "process-supervisor", "boot-logs", "config-diagnostics", "replay-overlay"],
      evidence: ["vendor/open-agent-builder", "GET /api/builder/status", "POST /api/builder/start", "GET /api/builder/logs", "GET /api/builder/replay-overlay", builder.upstream],
      metrics: {
        sourcePresent: builder.sourcePresent,
        dependenciesInstalled: builder.dependenciesInstalled,
        live: builder.live,
        supervisor: builder.supervisor?.state || "stopped",
        firecrawlConfigured: builder.diagnostics?.firecrawlConfigured,
        llmConfigured: builder.diagnostics?.llmConfigured
      },
      publicSummary: builder.live
        ? "The upstream Firecrawl Open Agent Builder is running behind the Hermes proxy with optional Hermes run replay overlays."
        : "Upstream builder source is present with Hermes supervisor, boot logs, config diagnostics, and replay overlay injection.",
      nextFix: "Add optional Convex/Clerk account automation only where provider APIs allow safe local auth."
    }),
    component({
      id: "security-export",
      label: "Security & Export",
      kind: "safety",
      status: "implemented",
      configured: true,
      capabilities: ["public-mode-guard", "admin-token", "secret-redaction", "clean-export-audit", "docker-smoke"],
      evidence: ["server/runtime/auth.js", "server/runtime/exporter.js", "scripts/docker-smoke.js", "POST /api/admin/export/prepare", "npm run smoke:docker"],
      metrics: {
        dryRunDefault: executionGate.dryRunDefault,
        executionGate: executionGate.source,
        installDefault: process.env.HERMES_AGENT_OS_ENABLE_INSTALL !== "1",
        publicMode: process.env.HERMES_AGENT_OS_PUBLIC_MODE === "1"
      },
      publicSummary: "Admin writes are guarded in public mode, execution is dry-run by default, exports are audited, and Docker boot can be smoke-tested.",
      nextFix: "Add full multi-user admin login and session expiry UI."
    })
  ];
  const summary = summarizeComponents(components);
  return {
    id: "hermes-kernel",
    label: "Hermes Kernel",
    status: summary.actionRequired ? "action_required" : summary.configRequired ? "config_required" : summary.partial ? "partial" : "implemented",
    generatedAt: now(),
    summary,
    runtime: {
      service: osStatus.service,
      version: osStatus.version,
      mode: osStatus.mode,
      host: osStatus.host,
      publicUrl: osStatus.publicUrl,
      githubRepo: osStatus.githubRepo,
      store: osStatus.store
    },
    invariants: [
      {
        id: "honest-status",
        label: "Honest statuses",
        status: "implemented",
        evidence: "Modules return connected, ready_to_configure, missing_dependency, error, or disabled from current checks."
      },
      {
        id: "redacted-secrets",
        label: "Secret redaction",
        status: "implemented",
        evidence: "Connection templates and logs return configured field names, never raw values."
      },
      {
        id: "local-path-redaction",
        label: "Local path redaction",
        status: "implemented",
        evidence: "Runtime paths are exposed as public store aliases, not absolute home paths."
      },
      {
        id: "dry-run-first",
        label: "Dry-run first",
        status: executionGate.enabled ? "config_required" : "implemented",
        evidence: "Provider and CLI execution stay dry-run unless the trusted execution gate is enabled and the request sends dryRun:false."
      }
    ],
    readiness,
    components
  };
}
