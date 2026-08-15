import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { appendModuleLog } from "./module-logs.js";
import { redactValue, sanitizeObject } from "./safety.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");
const builderRoot = path.join(root, "vendor", "open-agent-builder");
const builderPort = Number(process.env.HERMES_BUILDER_PORT || 3100);
const builderUrl = process.env.HERMES_ORIGINAL_BUILDER_URL || `http://127.0.0.1:${builderPort}`;
const REQUIRED_BUILDER_ENV = [
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_JWT_ISSUER_DOMAIN"
];
const FIRECRAWL_KEYS = ["FIRECRAWL_API_KEY"];
const LLM_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY"];
const BUILDER_CONFIG_IDS = ["firecrawl-builder", "provider-convex", "provider-clerk", "provider-firecrawl", "provider-openai", "provider-anthropic", "provider-gemini"];
const MAX_LOGS = 200;
const BOOTSTRAP_COMMANDS = [
  {
    id: "install-builder-dependencies",
    label: "Install upstream builder dependencies",
    command: "npm run builder:install",
    mode: "manual",
    target: "vendor/open-agent-builder"
  },
  {
    id: "create-convex-project",
    label: "Create or link Convex project",
    command: "cd vendor/open-agent-builder && npx convex dev",
    mode: "external_account",
    target: "provider-convex"
  },
  {
    id: "configure-convex",
    label: "Save Convex URL in Hermes",
    command: "POST /api/connections/provider-convex/configure",
    mode: "local_config",
    target: "provider-convex",
    fields: ["NEXT_PUBLIC_CONVEX_URL"]
  },
  {
    id: "create-clerk-app",
    label: "Create Clerk application and JWT template",
    command: "Open Clerk dashboard, create an application, then copy publishable key, secret key, and issuer domain.",
    mode: "external_account",
    target: "provider-clerk"
  },
  {
    id: "configure-clerk",
    label: "Save Clerk keys in Hermes",
    command: "POST /api/connections/provider-clerk/configure",
    mode: "local_config",
    target: "provider-clerk",
    fields: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "CLERK_JWT_ISSUER_DOMAIN"]
  },
  {
    id: "configure-firecrawl",
    label: "Save Firecrawl execution key",
    command: "POST /api/connections/provider-firecrawl/configure",
    mode: "local_config",
    target: "provider-firecrawl",
    fields: FIRECRAWL_KEYS
  },
  {
    id: "configure-llm",
    label: "Save one LLM provider key",
    command: "POST /api/connections/provider-openai/configure or POST /api/connections/provider-anthropic/configure",
    mode: "local_config",
    target: "provider-router",
    fields: LLM_KEYS
  },
  {
    id: "start-supervisor",
    label: "Start the supervised upstream builder",
    command: "POST /api/builder/start",
    mode: "local_action",
    target: "firecrawl-builder"
  },
  {
    id: "run-smoke-test",
    label: "Run Hermes builder smoke test",
    command: "POST /api/builder/smoke-test",
    mode: "local_action",
    target: "firecrawl-builder"
  }
];

let builderProcess = null;
let supervisorState = {
  state: "stopped",
  pid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  signal: null,
  lastError: null
};
const supervisorLogs = [];

function now() {
  return new Date().toISOString();
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackage() {
  const packagePath = path.join(builderRoot, "package.json");
  const raw = await fs.readFile(packagePath, "utf8");
  return JSON.parse(raw);
}

function sanitizeLogLine(value) {
  return redactValue(
    "builderLog",
    String(value || "")
      .replaceAll(root, ".")
      .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*\s*=\s*)[^\s#]+/gim, "$1configured")
  );
}

function addSupervisorLog(level, message, details = {}) {
  const entry = {
    id: `builder-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now(),
    level,
    message: sanitizeLogLine(message),
    details: sanitizeObject(details)
  };
  supervisorLogs.unshift(entry);
  supervisorLogs.splice(MAX_LOGS);
  return entry;
}

function builderConfiguredValue(stored, key) {
  for (const id of BUILDER_CONFIG_IDS) {
    const value = getConfiguredValue(stored, id, key);
    if (value) return value;
  }
  return process.env[key] || null;
}

function configDiagnostics(stored) {
  const required = REQUIRED_BUILDER_ENV.map((key) => ({
    key,
    configured: Boolean(builderConfiguredValue(stored, key)),
    requiredFor: key.startsWith("CLERK") || key.includes("CLERK") ? "Clerk auth" : "Convex workflow storage"
  }));
  const optionalExecution = [
    ...FIRECRAWL_KEYS.map((key) => ({
      key,
      configured: Boolean(builderConfiguredValue(stored, key)),
      requiredFor: "Firecrawl web/data execution"
    })),
    ...LLM_KEYS.map((key) => ({
      key,
      configured: Boolean(builderConfiguredValue(stored, key)),
      requiredFor: "LLM workflow execution"
    }))
  ];
  return {
    required,
    optionalExecution,
    missingRequired: required.filter((item) => !item.configured).map((item) => item.key),
    firecrawlConfigured: FIRECRAWL_KEYS.some((key) => builderConfiguredValue(stored, key)),
    llmConfigured: LLM_KEYS.some((key) => builderConfiguredValue(stored, key))
  };
}

function bootstrapStep(id, label, status, required, action, details = {}) {
  return {
    id,
    label,
    status,
    required,
    action,
    ...sanitizeObject(details)
  };
}

function envExample() {
  return [
    ...REQUIRED_BUILDER_ENV.map((key) => ({
      key,
      required: true,
      secret: key.includes("SECRET") || key.includes("KEY") && !key.startsWith("NEXT_PUBLIC"),
      source: key.startsWith("CLERK") || key.includes("CLERK") ? "provider-clerk" : "provider-convex",
      value: ""
    })),
    ...FIRECRAWL_KEYS.map((key) => ({
      key,
      required: false,
      secret: true,
      source: "provider-firecrawl",
      value: ""
    })),
    ...LLM_KEYS.map((key) => ({
      key,
      required: false,
      secret: true,
      source: key.startsWith("ANTHROPIC")
        ? "provider-anthropic"
        : key.startsWith("GEMINI")
          ? "provider-gemini"
          : "provider-openai",
      value: ""
    }))
  ];
}

function redactedCommands() {
  return BOOTSTRAP_COMMANDS.map((command) => sanitizeObject(command));
}

async function isLive() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${builderUrl}/?view=builder`, {
      method: "HEAD",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function getBuilderUrl() {
  return builderUrl;
}

function supervisorSnapshot() {
  if (builderProcess && builderProcess.exitCode == null && !builderProcess.killed) {
    supervisorState = {
      ...supervisorState,
      state: supervisorState.state === "stopping" ? "stopping" : "running",
      pid: builderProcess.pid || supervisorState.pid
    };
  }
  return {
    ...supervisorState,
    managed: true,
    logCount: supervisorLogs.length
  };
}

export async function getBuilderStatus() {
  const stored = await getStoredConnectionConfig();
  const [sourcePresent, dependenciesInstalled, upstreamFilePresent, live] = await Promise.all([
    exists(path.join(builderRoot, "package.json")),
    exists(path.join(builderRoot, "node_modules", "next", "package.json")),
    exists(path.join(builderRoot, "UPSTREAM.md")),
    isLive()
  ]);

  let packageName = "open-agent-builder";
  let packageVersion = null;
  if (sourcePresent) {
    const manifest = await readPackage();
    packageName = manifest.name || packageName;
    packageVersion = manifest.version || null;
  }
  const diagnostics = configDiagnostics(stored);
  const missingConfig = diagnostics.missingRequired;
  const readyToBoot = sourcePresent && dependenciesInstalled && missingConfig.length === 0;
  const supervisor = supervisorSnapshot();
  const status = !sourcePresent
    ? "missing_source"
    : !dependenciesInstalled
      ? "needs_install"
      : missingConfig.length
        ? "ready_to_configure"
        : live
          ? "running"
          : supervisor.state === "running"
            ? "starting"
            : supervisor.state === "stopping"
              ? "stopping"
              : "stopped";

  return {
    id: "firecrawl-open-agent-builder",
    label: "Open Agent Builder",
    source: "vendor/open-agent-builder",
    upstream: "https://github.com/firecrawl/open-agent-builder",
    upstreamCommit: "be856e57f8126e90915c898f473dc94fbaefc945",
    packageName,
    packageVersion,
    url: builderUrl,
    proxiedUrl: "/agent-builder-source/?view=builder",
    sourcePresent,
    dependenciesInstalled,
    upstreamFilePresent,
    live,
    requiredConfig: REQUIRED_BUILDER_ENV,
    missingConfig,
    diagnostics,
    readyToBoot,
    status,
    supervisor,
    installCommand: "npm run builder:install",
    startCommand: "npm run builder:start",
    stopCommand: "POST /api/builder/stop",
    theme: "Hermes purple CSS override only",
    resetPolicy: "upstream source plus isolated purple theme; no Hermes demo workflow modifications"
  };
}

export async function getBuilderBootstrap() {
  const status = await getBuilderStatus();
  const requiredMissing = status.diagnostics.required.filter((item) => !item.configured).map((item) => item.key);
  const executionMissing = status.diagnostics.optionalExecution.filter((item) => !item.configured).map((item) => item.key);
  const steps = [
    bootstrapStep(
      "source",
      "Vendored upstream source",
      status.sourcePresent ? "done" : "blocked",
      true,
      status.sourcePresent ? "Source package detected." : "Restore vendor/open-agent-builder from the package."
    ),
    bootstrapStep(
      "dependencies",
      "Builder dependencies",
      status.dependenciesInstalled ? "done" : "action_required",
      true,
      status.dependenciesInstalled ? "Next.js dependency is installed." : "Run npm run builder:install.",
      { commandId: "install-builder-dependencies" }
    ),
    bootstrapStep(
      "convex",
      "Convex workflow storage",
      status.diagnostics.required.find((item) => item.key === "NEXT_PUBLIC_CONVEX_URL")?.configured ? "done" : "action_required",
      true,
      "Create or connect a Convex project, then save NEXT_PUBLIC_CONVEX_URL.",
      { connectionId: "provider-convex", keys: ["NEXT_PUBLIC_CONVEX_URL"] }
    ),
    bootstrapStep(
      "clerk",
      "Clerk builder auth",
      REQUIRED_BUILDER_ENV.filter((key) => key.includes("CLERK")).every((key) => !requiredMissing.includes(key)) ? "done" : "action_required",
      true,
      "Create or connect a Clerk app, then save publishable key, secret key, and issuer domain.",
      { connectionId: "provider-clerk", keys: REQUIRED_BUILDER_ENV.filter((key) => key.includes("CLERK")) }
    ),
    bootstrapStep(
      "firecrawl",
      "Firecrawl execution",
      status.diagnostics.firecrawlConfigured ? "done" : "optional",
      false,
      "Add FIRECRAWL_API_KEY when workflows need web/data execution.",
      { connectionId: "provider-firecrawl", keys: FIRECRAWL_KEYS }
    ),
    bootstrapStep(
      "llm",
      "LLM execution provider",
      status.diagnostics.llmConfigured ? "done" : "optional",
      false,
      "Add at least one user-owned LLM key for executable agent nodes.",
      { connectionId: "provider-router", keys: LLM_KEYS }
    ),
    bootstrapStep(
      "supervisor",
      "Builder supervisor",
      status.live ? "done" : status.readyToBoot ? "ready" : "blocked",
      true,
      status.live ? "Builder responded through the Hermes proxy." : "Start the supervised upstream builder after required config is present.",
      { commandId: "start-supervisor" }
    ),
    bootstrapStep(
      "smoke-test",
      "Credentialed smoke test",
      status.live && status.diagnostics.firecrawlConfigured && status.diagnostics.llmConfigured
        ? "done"
        : status.readyToBoot
          ? "ready"
          : "blocked",
      true,
      "Run the smoke test to prove source, dependencies, Convex, Clerk, proxy, and execution-key readiness.",
      { commandId: "run-smoke-test" }
    )
  ];

  return {
    id: "firecrawl-builder-bootstrap",
    generatedAt: now(),
    status: status.status,
    readyToBoot: status.readyToBoot,
    live: status.live,
    executionReady: status.readyToBoot && status.diagnostics.firecrawlConfigured && status.diagnostics.llmConfigured,
    source: {
      path: "vendor/open-agent-builder",
      upstream: status.upstream,
      commit: status.upstreamCommit,
      packageName: status.packageName,
      packageVersion: status.packageVersion
    },
    requiredMissing,
    executionMissing,
    steps,
    commands: redactedCommands(),
    envExample: envExample(),
    nextAction: steps.find((step) => step.required && !["done", "ready"].includes(step.status))?.action
      || (status.live ? "Builder is live. Run executable workflow tests after adding Firecrawl and LLM keys." : "Start the supervised upstream builder.")
  };
}

export async function prepareBuilderBootstrap(input = {}) {
  const bootstrap = await getBuilderBootstrap();
  const executeRequested = Boolean(input.execute);
  const installRequested = Boolean(input.installDependencies);
  const executeEnabled = process.env.HERMES_AGENT_OS_ENABLE_INSTALL === "1";
  const mode = executeRequested && installRequested && executeEnabled ? "manual_guarded" : "dry_run";
  const message = mode === "dry_run"
    ? "Builder bootstrap prepared as a dry run. Run the listed commands or save the listed provider fields with user-owned credentials."
    : "Automatic dependency installation is intentionally guarded; run npm run builder:install from the project root for this package.";

  addSupervisorLog("info", "Builder bootstrap prepared.", {
    mode,
    requiredMissing: bootstrap.requiredMissing,
    executionReady: bootstrap.executionReady
  });
  await appendModuleLog("firecrawl-builder", {
    message: "Builder bootstrap prepared",
    details: {
      mode,
      requiredMissing: bootstrap.requiredMissing,
      executionReady: bootstrap.executionReady
    }
  });
  return {
    ok: true,
    id: "firecrawl-builder-bootstrap-prepare",
    generatedAt: now(),
    mode,
    message,
    executed: false,
    commands: bootstrap.commands,
    nextSteps: bootstrap.steps.filter((step) => step.status !== "done").slice(0, 4),
    bootstrap
  };
}

export async function runBuilderSmokeTest(input = {}) {
  const status = await getBuilderStatus();
  const checks = [
    {
      id: "source",
      label: "Upstream source package",
      required: true,
      status: status.sourcePresent ? "passed" : "failed",
      detail: status.sourcePresent ? "vendor/open-agent-builder package.json found." : "vendor/open-agent-builder package.json is missing."
    },
    {
      id: "upstream-marker",
      label: "Upstream marker",
      required: false,
      status: status.upstreamFilePresent ? "passed" : "warning",
      detail: status.upstreamFilePresent ? "UPSTREAM.md marker found." : "UPSTREAM.md marker is missing."
    },
    {
      id: "dependencies",
      label: "Builder dependencies",
      required: true,
      status: status.dependenciesInstalled ? "passed" : "failed",
      detail: status.dependenciesInstalled ? "Next.js dependency found." : "Run npm run builder:install."
    },
    {
      id: "convex",
      label: "Convex URL",
      required: true,
      status: status.missingConfig.includes("NEXT_PUBLIC_CONVEX_URL") ? "failed" : "passed",
      detail: status.missingConfig.includes("NEXT_PUBLIC_CONVEX_URL") ? "NEXT_PUBLIC_CONVEX_URL is missing." : "Convex URL is configured."
    },
    {
      id: "clerk",
      label: "Clerk auth",
      required: true,
      status: REQUIRED_BUILDER_ENV.filter((key) => key.includes("CLERK")).some((key) => status.missingConfig.includes(key)) ? "failed" : "passed",
      detail: "Clerk publishable key, secret key, and issuer domain are required for builder auth."
    },
    {
      id: "firecrawl",
      label: "Firecrawl execution key",
      required: false,
      status: status.diagnostics.firecrawlConfigured ? "passed" : "warning",
      detail: status.diagnostics.firecrawlConfigured ? "Firecrawl key is configured." : "Design mode works, but Firecrawl execution needs FIRECRAWL_API_KEY."
    },
    {
      id: "llm",
      label: "LLM execution key",
      required: false,
      status: status.diagnostics.llmConfigured ? "passed" : "warning",
      detail: status.diagnostics.llmConfigured ? "At least one LLM key is configured." : "Agent execution needs at least one user-owned LLM key."
    },
    {
      id: "proxy",
      label: "Hermes proxy",
      required: false,
      status: status.live ? "passed" : status.readyToBoot ? "warning" : "skipped",
      detail: status.live ? "Builder responded through the configured URL." : "Builder is not live yet."
    }
  ];
  const failedRequired = checks.filter((check) => check.required && check.status === "failed");
  const resultStatus = failedRequired.length
    ? "setup_required"
    : status.live
      ? "live"
      : "ready_to_start";
  const result = {
    ok: failedRequired.length === 0,
    id: "firecrawl-builder-smoke-test",
    generatedAt: now(),
    status: resultStatus,
    live: status.live,
    readyToBoot: status.readyToBoot,
    executionReady: status.readyToBoot && status.diagnostics.firecrawlConfigured && status.diagnostics.llmConfigured,
    checkedUrl: status.proxiedUrl,
    checks,
    missingRequired: failedRequired.map((check) => check.id),
    requestedStart: Boolean(input.startIfReady),
    message: failedRequired.length
      ? "Builder smoke test needs more setup before the upstream app can boot."
      : status.live
        ? "Builder smoke test passed and the upstream app is live."
        : "Builder smoke test passed for configuration; start the supervisor to verify the live proxy."
  };
  addSupervisorLog(result.ok ? "info" : "warn", "Builder smoke test completed.", {
    status: result.status,
    missingRequired: result.missingRequired,
    executionReady: result.executionReady
  });
  await appendModuleLog("firecrawl-builder", {
    message: "Builder smoke test completed",
    details: {
      status: result.status,
      missingRequired: result.missingRequired,
      executionReady: result.executionReady
    }
  });
  return result;
}

function supervisorCommand() {
  const command = process.env.HERMES_BUILDER_SUPERVISOR_COMMAND || process.execPath;
  const args = process.env.HERMES_BUILDER_SUPERVISOR_ARGS
    ? process.env.HERMES_BUILDER_SUPERVISOR_ARGS.split(" ").filter(Boolean)
    : [path.join(root, "scripts", "start-builder.js")];
  return { command, args };
}

export async function startBuilderSupervisor() {
  const status = await getBuilderStatus();
  if (builderProcess && builderProcess.exitCode == null && !builderProcess.killed) {
    addSupervisorLog("info", "Builder supervisor already running.", { pid: builderProcess.pid });
    return getBuilderStatus();
  }
  if (!status.readyToBoot) {
    addSupervisorLog("warn", "Builder supervisor start blocked by missing setup.", {
      status: status.status,
      missingConfig: status.missingConfig,
      sourcePresent: status.sourcePresent,
      dependenciesInstalled: status.dependenciesInstalled
    });
    const error = new Error("Builder is not ready to boot.");
    error.status = 400;
    error.details = {
      missingConfig: status.missingConfig,
      sourcePresent: status.sourcePresent,
      dependenciesInstalled: status.dependenciesInstalled
    };
    throw error;
  }
  const { command, args } = supervisorCommand();
  supervisorState = {
    state: "starting",
    pid: null,
    startedAt: now(),
    stoppedAt: null,
    exitCode: null,
    signal: null,
    lastError: null
  };
  addSupervisorLog("info", "Builder supervisor starting.", {
    command: path.basename(command),
    args: args.map((item) => path.basename(item)),
    port: builderPort
  });
  builderProcess = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  supervisorState = {
    ...supervisorState,
    state: "running",
    pid: builderProcess.pid || null
  };
  builderProcess.stdout?.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      addSupervisorLog("info", line);
    }
  });
  builderProcess.stderr?.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      addSupervisorLog("warn", line);
    }
  });
  builderProcess.on("error", (error) => {
    supervisorState = {
      ...supervisorState,
      state: "error",
      lastError: error.message,
      stoppedAt: now()
    };
    addSupervisorLog("error", "Builder supervisor process error.", { error: error.message });
  });
  builderProcess.on("exit", (code, signal) => {
    supervisorState = {
      ...supervisorState,
      state: "stopped",
      pid: null,
      stoppedAt: now(),
      exitCode: code,
      signal: signal || null
    };
    addSupervisorLog(code === 0 || signal ? "info" : "warn", "Builder supervisor stopped.", { code, signal });
    builderProcess = null;
  });
  await appendModuleLog("firecrawl-builder", {
    message: "Builder supervisor started",
    details: { pid: supervisorState.pid, port: builderPort }
  });
  return getBuilderStatus();
}

export async function stopBuilderSupervisor() {
  if (!builderProcess || builderProcess.exitCode != null || builderProcess.killed) {
    supervisorState = {
      ...supervisorState,
      state: "stopped",
      pid: null,
      stoppedAt: supervisorState.stoppedAt || now()
    };
    addSupervisorLog("info", "Builder supervisor stop requested, but no managed process is running.");
    return getBuilderStatus();
  }
  supervisorState = {
    ...supervisorState,
    state: "stopping"
  };
  addSupervisorLog("info", "Builder supervisor stopping.", { pid: builderProcess.pid });
  builderProcess.kill("SIGTERM");
  await appendModuleLog("firecrawl-builder", {
    message: "Builder supervisor stop requested",
    details: { pid: builderProcess.pid }
  });
  return getBuilderStatus();
}

export async function getBuilderLogs({ limit = 80 } = {}) {
  return {
    id: "firecrawl-builder-logs",
    logs: supervisorLogs.slice(0, Math.max(1, Math.min(200, Number(limit) || 80))),
    supervisor: supervisorSnapshot()
  };
}
