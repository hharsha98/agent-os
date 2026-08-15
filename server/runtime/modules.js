import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getBuilderStatus } from "./builder-service.js";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { getElizaStatus } from "./eliza.js";
import { getInstallRecipe } from "./installers.js";
import { addMemory } from "./memory.js";
import { getMemoryOverview } from "./memory.js";
import { appendModuleLog, readModuleLogs, readModuleRuns } from "./module-logs.js";
import { checkProviderHealth, getRouterStatus, runRouter } from "./router.js";
import { commandVersion, publicEnvConfigured, redactText, runCommand, sanitizeObject, which } from "./safety.js";
import { getSchedulerOverview } from "./scheduler.js";
import { getLocalSelfModuleStatus, getVideoWorkerStatus, isLocalSelfModule, runGoalLoop, runSeoAudit, runSeoDiscovery, runSeoRankSnapshot, runVideoJob, upsertKanbanCard } from "./self-modules.js";
import { getSkillRegistryOverview } from "./skills.js";
import { ensureRuntimeStore, expandHome, publicRuntimePath, readJson, runtimePaths, RUNTIME_VERSION, writeJson } from "./store.js";
import { getUsageState } from "./usage.js";
import { getVoiceControlStatus, runVoiceCommand } from "./voice-control.js";
import { isExecutionEnabled } from "./execution-gate.js";

const CLI_MODULES = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    category: "agent",
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_PATH", "CLAUDE_CLI_ARGS", "CLAUDE_WORKSPACE", "CLAUDE_TIMEOUT_MS"],
    pathKeys: ["CLAUDE_CODE_PATH", "CLAUDE_CLI_PATH"],
    capabilities: ["chat", "code", "tools", "mcp"],
    installHint: "Install Claude Code from Anthropic, or configure CLAUDE_CODE_PATH.",
    docsUrl: "https://docs.anthropic.com/claude-code"
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "openclaw",
    category: "agent",
    envKeys: ["OPENCLAW_CLI_PATH", "OPENCLAW_HOME", "OPENCLAW_CLI_ARGS", "OPENCLAW_WORKSPACE", "OPENCLAW_TIMEOUT_MS"],
    pathKeys: ["OPENCLAW_CLI_PATH"],
    capabilities: ["automation", "browser", "tools"],
    installHint: "Install `openclaw@latest`, run `openclaw onboard --install-daemon`, or configure OPENCLAW_CLI_PATH.",
    docsUrl: "https://github.com/openclaw/openclaw#install-recommended"
  },
  {
    id: "openclaude",
    label: "OpenClaude",
    command: "openclaude",
    category: "agent",
    envKeys: ["OPENCLAUDE_CLI_PATH", "OPENCLAUDE_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST"],
    pathKeys: ["OPENCLAUDE_CLI_PATH"],
    capabilities: ["chat", "routing", "local-models"],
    installHint: "No trusted OpenClaude package is bundled. Configure OPENCLAUDE_CLI_PATH for a real local OpenClaude-compatible CLI, or route Claude-style work through OpenRouter/Ollama.",
    docsUrl: "https://www.npmjs.com/package/openclaude"
  },
  {
    id: "gemini",
    label: "Gemini",
    command: "gemini",
    category: "agent",
    envKeys: ["GEMINI_API_KEY", "GEMINI_CLI_PATH"],
    pathKeys: ["GEMINI_CLI_PATH"],
    capabilities: ["chat", "code", "vision"],
    installHint: "Install Gemini CLI, or configure GEMINI_CLI_PATH and GEMINI_API_KEY.",
    docsUrl: "https://github.com/google-gemini/gemini-cli"
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    category: "agent",
    envKeys: ["OPENAI_API_KEY", "CODEX_CLI_PATH", "CODEX_CLI_ARGS", "CODEX_WORKSPACE", "CODEX_TIMEOUT_MS"],
    pathKeys: ["CODEX_CLI_PATH"],
    capabilities: ["code", "workspace", "review"],
    installHint: "Install Codex CLI, or configure CODEX_CLI_PATH and OPENAI_API_KEY.",
    docsUrl: "https://developers.openai.com/codex"
  },
  {
    id: "voice-control",
    label: "Hermes Voice Control",
    command: "osascript",
    category: "agent",
    envKeys: ["OPENAI_API_KEY", "CODEX_GPT_MODEL", "HERMES_VOICE_MODEL", "HERMES_AGENT_OS_ENABLE_EXEC", "HERMES_VOICE_ALLOW_SHELL"],
    pathKeys: [],
    capabilities: ["voice", "desktop-control", "codex-gpt", "browser", "files", "click", "type", "workflow-handoff"],
    installHint: "Grant microphone permission to the browser and Accessibility/Screen Recording permission to the terminal runtime for full desktop control.",
    docsUrl: ""
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    category: "agent",
    envKeys: ["OPENCODE_CLI_PATH", "OPENCODE_CLI_ARGS", "OPENCODE_WORKSPACE", "OPENCODE_TIMEOUT_MS"],
    pathKeys: ["OPENCODE_CLI_PATH"],
    capabilities: ["code", "workspace"],
    installHint: "Install OpenCode locally, or configure OPENCODE_CLI_PATH.",
    docsUrl: "https://opencode.ai"
  }
];

const INTERNAL_MODULES = [
  {
    id: "goals",
    label: "Goals",
    category: "self",
    capabilities: ["goals", "plans", "progress", "goal-loop", "provider-router", "kanban-handoff"],
    publicSummary: "Local goals with provider-router-backed planning loops, run history, and progress tracking."
  },
  {
    id: "seo",
    label: "SEO",
    category: "self",
    capabilities: ["keyword-research", "content-briefs", "site-audits", "firecrawl-scrape", "firecrawl-search", "competitor-discovery", "rank-tracking", "provider-router-analysis"],
    publicSummary: "SEO briefs with Firecrawl-backed page audits, search-result competitor discovery, rank snapshots, Provider Router recommendations, and run history."
  },
  {
    id: "video",
    label: "Video",
    category: "self",
    capabilities: ["captioning", "scripts", "render-plans", "ffprobe-inspection", "worker-runs", "caption-handoff", "render-handoff", "cloud-stt", "groq-stt", "openai-stt", "whisper-transcription", "ffmpeg-render", "caption-render", "queue", "progress-polling", "ffmpeg-progress-parsing", "whisper-progress-parsing", "cancel-run", "safe-output-download"],
    publicSummary: "Video workflow module with local media inspection, queued/gated Groq/OpenAI/local Whisper SRT transcription, ffmpeg rendering, command-derived progress parsing, cancellation, safe downloads, scripts, and run history."
  },
  {
    id: "notebook",
    label: "Notebook",
    category: "self",
    capabilities: ["notes", "memory", "run-journal"],
    publicSummary: "Local notebook and run journal backed by the Agent OS store."
  },
  {
    id: "kanban",
    label: "Kanban",
    category: "self",
    capabilities: ["tasks", "queues", "handoffs", "workflow-task-cards", "approval-cards", "scheduler-approval-cards"],
    publicSummary: "Local Kanban queues for agent work, workflow task cards, scheduler gates, and human approvals."
  },
  {
    id: "usage-credits",
    label: "Usage Credits",
    category: "self",
    capabilities: ["usage", "quotas", "spend-estimates", "billing-reconciliation"],
    publicSummary: "Tracks local usage budgets, provider credit estimates, and supported billing reconciliation."
  }
];

const PARKED_MODULE_IDS = new Set(["seo", "video"]);
const INTERNAL_ONLY_MODULE_IDS = new Set(["kernel"]);
const ACTIVE_MODULE_SESSIONS = new Map();
const MAX_SESSION_OUTPUT_CHARS = 12000;

const PROVIDER_MODULES = [
  {
    id: "provider-anthropic",
    label: "Anthropic",
    envKeys: ["ANTHROPIC_API_KEY"],
    configuredFrom: ["provider-anthropic", "provider-router", "claude", "firecrawl-builder"],
    capabilities: ["llm", "claude", "agent-routing"],
    publicSummary: "Connect a user-owned Anthropic key for Claude models and Claude Code workflows.",
    docsUrl: "https://docs.anthropic.com"
  },
  {
    id: "provider-openai",
    label: "OpenAI",
    envKeys: ["OPENAI_API_KEY"],
    configuredFrom: ["provider-openai", "provider-router", "codex", "firecrawl-builder"],
    capabilities: ["llm", "codex", "agent-routing"],
    publicSummary: "Connect a user-owned OpenAI key for Codex and OpenAI model routing.",
    docsUrl: "https://platform.openai.com/docs"
  },
  {
    id: "provider-gemini",
    label: "Gemini API",
    envKeys: ["GEMINI_API_KEY"],
    configuredFrom: ["provider-gemini", "provider-router", "gemini"],
    capabilities: ["llm", "vision", "agent-routing"],
    publicSummary: "Connect a user-owned Gemini API key for Gemini model routing.",
    docsUrl: "https://github.com/google-gemini/gemini-cli"
  },
  {
    id: "provider-openrouter",
    label: "OpenRouter",
    envKeys: ["OPENROUTER_API_KEY"],
    configuredFrom: ["provider-openrouter", "provider-router", "openclaude"],
    capabilities: ["llm", "routing", "open-models"],
    publicSummary: "Connect a user-owned OpenRouter key for Claude-style/open-provider routing.",
    docsUrl: "https://openrouter.ai/docs"
  },
  {
    id: "provider-ollama",
    label: "Ollama",
    envKeys: ["OLLAMA_HOST"],
    configuredFrom: ["provider-ollama", "provider-router", "openclaude"],
    capabilities: ["local-models", "routing"],
    publicSummary: "Connect a local Ollama host for local model routing.",
    docsUrl: "https://ollama.com"
  },
  {
    id: "provider-minimax",
    label: "MiniMax",
    envKeys: ["MINIMAX_API_KEY"],
    configuredFrom: ["provider-minimax", "provider-router", "minimax"],
    capabilities: ["llm", "routing"],
    publicSummary: "Connect a user-owned MiniMax API key.",
    docsUrl: "https://www.minimax.io"
  },
  {
    id: "provider-firecrawl",
    label: "Firecrawl",
    envKeys: ["FIRECRAWL_API_KEY"],
    configuredFrom: ["provider-firecrawl", "firecrawl-builder"],
    capabilities: ["web-data", "scrape", "mcp"],
    publicSummary: "Connect Firecrawl for web/data execution in Open Agent Builder.",
    docsUrl: "https://docs.firecrawl.dev"
  },
  {
    id: "provider-convex",
    label: "Convex",
    envKeys: ["NEXT_PUBLIC_CONVEX_URL"],
    configuredFrom: ["provider-convex", "firecrawl-builder"],
    capabilities: ["database", "workflow-storage"],
    publicSummary: "Connect Convex so the upstream Open Agent Builder can persist workflows.",
    docsUrl: "https://docs.convex.dev"
  },
  {
    id: "provider-clerk",
    label: "Clerk",
    envKeys: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "CLERK_JWT_ISSUER_DOMAIN"],
    configuredFrom: ["provider-clerk", "firecrawl-builder"],
    capabilities: ["auth", "builder-login"],
    publicSummary: "Connect Clerk authentication required by the upstream Open Agent Builder.",
    docsUrl: "https://clerk.com/docs"
  }
];

function now() {
  return new Date().toISOString();
}

function standardModule(input) {
  const configured = Boolean(input.configured);
  const status = input.status || (configured ? "connected" : "ready_to_configure");
  return {
    id: input.id,
    label: input.label,
    category: input.category,
    type: input.type || input.category,
    status,
    capabilities: input.capabilities || [],
    configured,
    missing: input.missing || [],
    lastChecked: now(),
    actions: input.actions || ["configure", "test", "run", "logs"],
    publicSummary: input.publicSummary || input.connection || "",
    connection: input.connection || input.publicSummary || "",
    version: input.version || null,
	    profile: input.profile || null,
	    profileCount: input.profileCount,
	    onlineProfiles: input.onlineProfiles,
	    activeProfile: input.activeProfile || null,
	    profiles: Array.isArray(input.profiles) ? sanitizeObject(input.profiles) : [],
	    stats: input.stats || {},
    source: input.source || "agent-os-runtime",
    configKeys: input.configKeys || [],
    installHint: input.installHint || "",
    installCommand: input.installCommand || "",
    installMode: input.installMode || "",
    docsUrl: input.docsUrl || "",
    taskProfiles: Array.isArray(input.taskProfiles) ? sanitizeObject(input.taskProfiles) : []
  };
}

function commonAgentTaskProfiles(label = "Agent") {
  return [
    {
      id: "health-check",
      label: "Health check",
      description: "Ask this agent to verify its runtime, model, tools, and next setup gap.",
      prompt: `Run a concise ${label} health check. Report configured runtime, available tools, missing setup, and one next action.`
    },
    {
      id: "debug-failure",
      label: "Debug failure",
      description: "Use this when a local command, workflow, provider call, or integration fails.",
      prompt: `Debug the current ${label} failure. Identify likely cause, evidence to collect, safest fix, and verification command.`
    },
    {
      id: "implementation-plan",
      label: "Implementation plan",
      description: "Create a short implementation plan before editing or running a bigger workflow.",
      prompt: `Create a practical ${label} implementation plan with concrete steps, files or systems to inspect, risks, and verification gates.`
    }
  ];
}

function voiceControlTaskProfiles() {
  return [
    {
      id: "open-chrome",
      label: "Open Chrome",
      description: "A minimal desktop-control smoke test.",
      prompt: "Hermes, open Chrome"
    },
    {
      id: "search-web",
      label: "Search web",
      description: "Open a browser search from natural speech.",
      prompt: "Hermes, search web for latest AI automation tools"
    },
    {
      id: "find-file",
      label: "Find file",
      description: "Search local files from a voice command.",
      prompt: "Hermes, find file called report"
    },
    {
      id: "run-workflow",
      label: "Run workflow",
      description: "Start a local Agent OS workflow from speech.",
      prompt: "Hermes, run workflow blank open agent builder"
    },
    {
      id: "page-search",
      label: "Find on page",
      description: "Search inside the active browser page or document.",
      prompt: "Hermes, find on page pricing"
    },
    {
      id: "screenshot",
      label: "Screenshot",
      description: "Capture the current screen into the Agent OS export folder.",
      prompt: "Hermes, take a screenshot"
    }
  ];
}

function codeAgentTaskProfiles(label = "Code Agent") {
  return [
    ...commonAgentTaskProfiles(label),
    {
      id: "code-review",
      label: "Code review",
      description: "Review the current workspace for bugs, regressions, and missing tests.",
      prompt: `Review the current workspace as ${label}. Prioritize bugs, regressions, security risks, and missing tests. Return file-level findings first.`
    },
    {
      id: "implement-change",
      label: "Implement change",
      description: "Use this for a scoped local code change with verification.",
      prompt: `Implement the requested scoped change with ${label}. Inspect the repo first, keep edits minimal, run focused verification, and summarize changed files.`
    }
  ];
}

function providerTaskProfiles(label = "Provider") {
  return [
    ...commonAgentTaskProfiles(label),
    {
      id: "model-routing-check",
      label: "Model routing check",
      description: "Verify model choice, routing, budget risk, and execution gate state.",
      prompt: `Check ${label} routing readiness. Report selected model, configured status, budget or usage risk, dry-run state, and the next safe live-test step.`
    }
  ];
}

function hermesAgentTaskProfiles() {
  return [
    {
      id: "dispatch-kanban-task",
      label: "Dispatch task",
      description: "Create a real Hermes Kanban task for the selected local profile.",
      action: "task",
      prompt: "Research the current Agent OS request, execute the next safe local step, and report proof."
    },
    {
      id: "dispatch-goal-task",
      label: "Dispatch goal",
      description: "Create a Hermes goal-mode task so a local profile can continue the work loop.",
      action: "task",
      input: { goal: true },
      prompt: "Continue the current Agent OS goal. Preserve scope, make concrete progress, and report verification."
    },
    {
      id: "restart-gateway",
      label: "Restart gateway",
      description: "Prepare or execute a launchd restart for the selected Hermes profile gateway.",
      action: "restart_gateway",
      prompt: "Restart the selected Hermes gateway."
    }
  ];
}

function recipeFields(id) {
  const recipe = getInstallRecipe(id);
  return recipe
    ? {
        installCommand: recipe.command || "",
        installMode: recipe.manager,
        docsUrl: recipe.docsUrl || ""
      }
    : {};
}

function cliDefinition(id) {
  return CLI_MODULES.find((definition) => definition.id === id) || null;
}

function cliPrefix(definition) {
  if (definition.id === "claude") return "CLAUDE";
  return definition.id.toUpperCase().replaceAll("-", "_");
}

function numericTimeout(value) {
  const number = Number(value || 15000);
  if (!Number.isFinite(number)) return 15000;
  return Math.min(3600000, Math.max(1000, Math.floor(number)));
}

function truncate(value, max = 4000) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...<truncated>` : text;
}

function splitArgsTemplate(value) {
  const input = String(value || "").trim();
  if (!input) return [];
  const args = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

async function resolveWorkspace(definition, stored, input = {}) {
  const prefix = cliPrefix(definition);
  const configured = getConfiguredValue(stored, definition.id, `${prefix}_WORKSPACE`);
  const requested = input.workspace || input.cwd || "";
  if (requested && !configured) {
    return {
      ok: false,
      reason: `${prefix}_WORKSPACE must be configured before a run can request a workspace override.`,
      cwd: "",
      configured: false
    };
  }
  if (!configured) return { ok: true, cwd: "", configured: false };
  const allowed = path.resolve(expandHome(configured));
  try {
    const stat = await fs.stat(allowed);
    if (!stat.isDirectory()) {
      return { ok: false, reason: `${prefix}_WORKSPACE is not a directory.`, cwd: "", configured: true };
    }
  } catch {
    return { ok: false, reason: `${prefix}_WORKSPACE does not exist.`, cwd: "", configured: true };
  }
  if (!requested) return { ok: true, cwd: allowed, configured: true };
  const resolved = path.resolve(expandHome(requested));
  const relative = path.relative(allowed, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "Requested workspace is outside the configured workspace policy.", cwd: "", configured: true };
  }
  return { ok: true, cwd: resolved, configured: true };
}

function buildCliArgs(definition, stored, input = {}) {
  const prefix = cliPrefix(definition);
  const message = String(input.message || input.prompt || "").slice(0, 4000);
  const template = String(input.argsTemplate || getConfiguredValue(stored, definition.id, `${prefix}_CLI_ARGS`) || "").trim();
  if (!template) {
    const configuredCodexPath = definition.id === "codex"
      ? getConfiguredValue(stored, definition.id, "CODEX_CLI_PATH")
      : null;
    if (definition.id === "codex" && !configuredCodexPath && message) {
      return [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        message
      ];
    }
    if (definition.id === "openclaw" && message) {
      return ["agent", "--message", message, "--thinking", "high"];
    }
    return message ? [message] : [];
  }
  const args = splitArgsTemplate(template).map((arg) => arg
    .replaceAll("{{message}}", message)
    .replaceAll("{{prompt}}", message));
  if (!args.some((arg) => arg.includes(message)) && message) args.push(message);
  return args;
}

async function buildCliInvocation(definition, stored, input, commandPath, resolved) {
  const prefix = cliPrefix(definition);
  const workspace = await resolveWorkspace(definition, stored, input);
  if (!workspace.ok) return { ok: false, mode: "policy_violation", reason: workspace.reason };
  const args = buildCliArgs(definition, stored, input);
  const timeoutMs = numericTimeout(input.timeoutMs || getConfiguredValue(stored, definition.id, `${prefix}_TIMEOUT_MS`));
  return {
    ok: true,
    mode: "execute",
    runId: `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    adapterId: `${definition.id}-cli`,
    moduleId: definition.id,
    commandPath,
    command: definition.command,
    configuredPath: Boolean(resolved?.configuredPath),
    workspace,
    args,
    timeoutMs,
    messageLength: String(input.message || input.prompt || "").length
  };
}

function publicInvocation(invocation) {
  const commandPreview = [
    invocation.command,
    ...invocation.args.map((_, index) => `<arg:${index + 1}>`)
  ].join(" ");
  return {
    runId: invocation.runId,
    adapterId: invocation.adapterId,
    moduleId: invocation.moduleId,
    command: invocation.command,
    commandPreview,
    configuredPath: invocation.configuredPath,
    argsCount: invocation.args.length,
    promptChars: invocation.messageLength,
    timeoutMs: invocation.timeoutMs,
    workspace: {
      configured: Boolean(invocation.workspace?.configured),
      used: Boolean(invocation.workspace?.cwd)
    },
    workspacePolicy: invocation.workspace?.configured
      ? invocation.workspace?.cwd
        ? "configured workspace policy active; requested cwd accepted"
        : "configured workspace policy active"
      : "no workspace policy configured"
  };
}

function sanitizeCliOutput(value, invocation) {
  return truncate(redactText(value, [invocation.commandPath, invocation.workspace?.cwd]), 8000);
}

function moduleRunId(prefix = "run") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeModuleId(id) {
  return String(id || "unknown").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

async function moduleSessionPath(id) {
  await ensureRuntimeStore();
  const dir = path.join(runtimePaths().runs, "module-sessions");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${safeModuleId(id)}.json`);
}

async function readModuleSessionState(id) {
  const file = await moduleSessionPath(id);
  const current = await readJson(file, { id, sessions: [] });
  return {
    id,
    sessions: Array.isArray(current.sessions) ? current.sessions : []
  };
}

async function writeModuleSessionState(id, state) {
  const file = await moduleSessionPath(id);
  const sessions = (Array.isArray(state.sessions) ? state.sessions : []).slice(0, 30);
  await writeJson(file, { id, sessions });
  return { id, sessions };
}

function publicSession(session) {
  return sanitizeObject({
    sessionId: session.sessionId,
    moduleId: session.moduleId,
    moduleLabel: session.moduleLabel,
    status: session.status,
    mode: session.mode,
    dryRun: Boolean(session.dryRun),
    execEnabled: Boolean(session.execEnabled),
    explicitExecution: Boolean(session.explicitExecution),
    command: session.command,
    commandPreview: session.commandPreview || "",
    adapterId: session.adapterId,
    argsCount: Number(session.argsCount || 0),
    promptChars: Number(session.promptChars || 0),
    timeoutMs: Number(session.timeoutMs || 0),
    pid: session.pid || null,
    workspace: session.workspace || { configured: false, used: false },
    startedAt: session.startedAt || null,
    updatedAt: session.updatedAt || null,
    completedAt: session.completedAt || null,
    exitCode: session.exitCode ?? null,
    signal: session.signal || null,
    stopRequested: Boolean(session.stopRequested),
    provider: session.provider || null,
    profile: session.profile || null,
    model: session.model || null,
    messageCount: Number(session.messageCount ?? (Array.isArray(session.messages) ? session.messages.length : 0)),
    lastMessageAt: session.lastMessageAt || null,
    stdoutTail: session.stdoutTail || "",
    stderrTail: session.stderrTail || "",
    outputTruncated: Boolean(session.outputTruncated),
    nextStep: session.nextStep || "",
    evidence: Array.isArray(session.evidence) ? session.evidence : []
  });
}

async function updateModuleSessionRecord(id, sessionId, updater) {
  const current = await readModuleSessionState(id);
  let found = false;
  const sessions = current.sessions.map((session) => {
    if (session.sessionId !== sessionId) return session;
    found = true;
    return {
      ...session,
      ...updater(session),
      updatedAt: now()
    };
  });
  if (!found) {
    const error = new Error("module session not found");
    error.status = 404;
    throw error;
  }
  const state = await writeModuleSessionState(id, { id, sessions });
  return state.sessions.find((session) => session.sessionId === sessionId) || null;
}

function appendSessionOutput(current, chunk) {
  const next = `${current || ""}${chunk || ""}`;
  return next.length > MAX_SESSION_OUTPUT_CHARS
    ? next.slice(-MAX_SESSION_OUTPUT_CHARS)
    : next;
}

function sanitizeSessionChunk(value, invocation) {
  return redactText(value, [invocation.commandPath, invocation.workspace?.cwd]);
}

function providerSessionProvider(id, input = {}) {
  if (id === "provider-router") return input.provider || "";
  if (id === "minimax") return "minimax";
  return routerProviderForModuleId(id);
}

function isProviderSessionModule(id, module) {
  return Boolean(
    module &&
    ["provider", "routing", "model_router"].includes(String(module.type || "")) &&
    (id === "provider-router" || id === "minimax" || routerProviderForModuleId(id))
  );
}

function providerSessionPrompt(session, input = {}) {
  const prompt = String(input.message || input.prompt || "").trim();
  if (!prompt) {
    const error = new Error("message or prompt is required");
    error.status = 400;
    throw error;
  }
  const history = (Array.isArray(session.messages) ? session.messages : [])
    .slice(-8)
    .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${String(item.content || "").slice(0, 2000)}`)
    .join("\n");
  return {
    prompt,
    routedPrompt: history ? `${history}\nUser: ${prompt}` : prompt
  };
}

async function startProviderModuleSession(id, module, input = {}) {
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false || input.execute === true;
  const sessionId = moduleRunId("sess");
  const forcedProvider = providerSessionProvider(id, input);
  const startedAt = now();
  const rawSession = {
    sessionId,
    moduleId: id,
    moduleLabel: module.label,
    status: "open",
    mode: "dry_run",
    dryRun: true,
    execEnabled,
    explicitExecution,
    command: "provider-router",
    adapterId: `${id}-conversation`,
    argsCount: 0,
    promptChars: 0,
    timeoutMs: 0,
    pid: null,
    workspace: { configured: false, used: false },
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    exitCode: null,
    signal: null,
    stopRequested: false,
    provider: forcedProvider || null,
    model: null,
    messageCount: 0,
    lastMessageAt: null,
    messages: [],
    stdoutTail: "",
    stderrTail: "",
    outputTruncated: false,
    nextStep: "Provider conversation is open. Send messages from the dashboard; real provider calls still require the execution gate.",
    evidence: [
      `module status: ${module.status}`,
      `provider: ${forcedProvider || "router fallback"}`,
      `execution gate: ${execEnabled ? "enabled" : "disabled"}`
    ]
  };
  const state = await readModuleSessionState(id);
  await writeModuleSessionState(id, { id, sessions: [rawSession, ...state.sessions] });
  const session = publicSession(rawSession);
  await appendModuleLog(id, {
    message: "Provider conversation session opened",
    details: { session }
  });
  if (String(input.message || input.prompt || "").trim()) {
    return messageModuleSession(id, sessionId, input);
  }
  return {
    ok: true,
    mode: "open",
    reply: `${module.label} provider conversation opened.`,
    session
  };
}

async function startHermesModuleSession(id, module, input = {}) {
  const stored = await getStoredConnectionConfig();
  const inventory = await hermesInventory(stored, input);
  const requestedProfile = String(input.profile || input.profileId || inventory.activeProfile || "").replace(/[^a-z0-9_-]/gi, "");
  const profile = requestedProfile
    ? inventory.profiles.find((item) => item.id === requestedProfile) || null
    : inventory.profiles.find((item) => item.gateway.state === "running") || inventory.profiles[0] || null;
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false || input.execute === true;
  const sessionId = moduleRunId("sess");
  const startedAt = now();
  const rawSession = {
    sessionId,
    moduleId: id,
    moduleLabel: module.label,
    status: profile ? "open" : "ready_to_configure",
    mode: "profile_control",
    dryRun: true,
    execEnabled,
    explicitExecution,
    command: "hermes-control",
    adapterId: "hermes-profile-session",
    argsCount: 0,
    promptChars: 0,
    timeoutMs: 0,
    pid: null,
    workspace: { configured: false, used: false },
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    exitCode: null,
    signal: null,
    stopRequested: false,
    provider: null,
    profile: profile?.id || requestedProfile || null,
    model: null,
    messageCount: 0,
    lastMessageAt: null,
    messages: [],
    stdoutTail: "",
    stderrTail: "",
    outputTruncated: false,
    nextStep: profile
      ? "Hermes profile session is open. Send a message to create a Hermes task, or use profile controls for status and gateway actions."
      : "No Hermes profile was found. Configure HERMES_HOME or create a local Hermes profile.",
    evidence: [
      `profiles: ${inventory.profileCount}`,
      `running gateways: ${inventory.runningProfiles}`,
      `selected profile: ${profile?.id || requestedProfile || "none"}`,
      `execution gate: ${execEnabled ? "enabled" : "disabled"}`
    ]
  };
  const state = await readModuleSessionState(id);
  await writeModuleSessionState(id, { id, sessions: [rawSession, ...state.sessions] });
  const session = publicSession(rawSession);
  await appendModuleLog(id, {
    level: profile ? "info" : "warn",
    message: profile ? "Hermes profile session opened" : "Hermes profile session needs setup",
    details: { session }
  });
  if (profile && String(input.message || input.prompt || "").trim()) {
    return messageModuleSession(id, sessionId, input);
  }
  return {
    ok: Boolean(profile),
    mode: profile ? "open" : "ready_to_configure",
    reply: profile
      ? `Hermes profile session opened for ${profile.id}.`
      : "No Hermes profile is available to open a session.",
    session
  };
}

async function messageHermesModuleSession(id, module, sessionId, input = {}) {
  const state = await readModuleSessionState(id);
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    const error = new Error("module session not found");
    error.status = 404;
    throw error;
  }
  const prompt = String(input.message || input.prompt || "").trim();
  if (!prompt) {
    const error = new Error("message or prompt is required");
    error.status = 400;
    throw error;
  }
  const action = String(input.action || input.operation || input.tool || "task");
  const profile = String(input.profile || input.profileId || session.profile || "").replace(/[^a-z0-9_-]/gi, "");
  const result = await runHermesControl(module, {
    ...input,
    action,
    profile,
    message: prompt,
    prompt,
    sourceSessionId: sessionId
  });
  const timestamp = now();
  const assistantText = result.reply || "";
  const execEnabled = await isExecutionEnabled();
  const updated = await updateModuleSessionRecord(id, sessionId, (current) => {
    const messages = [
      ...(Array.isArray(current.messages) ? current.messages : []),
      { role: "user", content: prompt, at: timestamp, chars: prompt.length },
      { role: "assistant", content: assistantText, at: timestamp, chars: assistantText.length, mode: result.mode }
    ].slice(-40);
    return {
      status: "open",
      mode: result.mode || "profile_control",
      dryRun: result.proof?.dryRun ?? result.mode !== "executed",
      execEnabled,
      explicitExecution: input.dryRun === false,
      profile: result.control?.selectedProfile || profile || current.profile || null,
      promptChars: prompt.length,
      messageCount: messages.length,
      lastMessageAt: timestamp,
      messages,
      stdoutTail: appendSessionOutput(current.stdoutTail, `\n[${timestamp}] ${assistantText}`),
      stderrTail: result.ok ? current.stderrTail || "" : appendSessionOutput(current.stderrTail, `\n[${timestamp}] ${assistantText}`),
      nextStep: result.ok
        ? "Hermes session message handled. Inspect run proof, Memory, Kanban handoff, or refresh task status."
        : "Hermes session message was blocked. Configure the Hermes CLI/profile or execution gate, then retry.",
      evidence: [
        `profile: ${result.control?.selectedProfile || profile || "none"}`,
        `action: ${result.control?.action || action}`,
        result.control?.taskId ? `task: ${result.control.taskId}` : "task: not created",
        `mode: ${result.mode || "profile_control"}`
      ]
    };
  });
  const publicUpdated = publicSession(updated);
  await appendModuleLog(id, {
    level: result.ok ? "info" : "warn",
    message: result.ok ? "Hermes session message handled" : "Hermes session message blocked",
    details: {
      session: publicUpdated,
      action,
      mode: result.mode,
      control: result.control || null
    }
  });
  return {
    ok: result.ok,
    mode: result.mode,
    reply: result.reply,
    hermes: result.hermes,
    control: result.control,
    hermesTask: result.hermesTask,
    execution: result.execution,
    proof: result.proof,
    handoff: result.handoff || null,
    session: publicUpdated
  };
}

function safeReplayForRun(id, input = {}) {
  const action = String(input.action || input.operation || input.tool || (input.message || input.prompt ? "message" : "status"))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  const hasPrompt = Boolean(String(input.message || input.prompt || "").trim());
  const profile = String(input.profile || input.profileId || "").replace(/[^a-z0-9_-]/gi, "");

  if (hasPrompt || action === "message") {
    return {
      available: false,
      reason: "Original prompt text is private and is not stored for one-click replay.",
      input: null
    };
  }

  if (id === "hermes") {
    const taskId = cleanHermesTaskId(input);
    const taskControl = hermesTaskControlAction(action);
    if (["task_status", "task-status", "show_task", "show-task", "status_task", "status-task"].includes(action) && taskId) {
      return {
        available: true,
        reason: "Read-only Hermes task status can be refreshed from run history.",
        input: {
          action: "task_status",
          taskId,
          ...(profile ? { profile } : {}),
          recordHandoff: false
        }
      };
    }
    if (taskControl && taskId) {
      return {
        available: true,
        reason: `${taskControl.label} can be prepared again from run history.`,
        input: {
          action,
          taskId,
          ...(profile ? { profile } : {}),
          dryRun: true
        }
      };
    }
    if (["restart_gateway", "restart-gateway", "kickstart", "restart"].includes(action)) {
      return {
        available: true,
        reason: "Hermes gateway restart can be prepared again as a dry-run.",
        input: {
          action: "restart_gateway",
          ...(profile ? { profile } : {}),
          dryRun: true
        }
      };
    }
    if (!action || action === "status") {
      return {
        available: true,
        reason: "Hermes runtime status can be inspected again.",
        input: {
          action: "status",
          ...(profile ? { profile } : {})
        }
      };
    }
  }

  if (id === "gateway") {
    if (["restart_gateway", "restart-gateway", "kickstart", "restart"].includes(action)) {
      return {
        available: true,
        reason: "Gateway restart can be prepared again as a dry-run.",
        input: {
          action: "restart_gateway",
          ...(profile ? { profile } : {}),
          dryRun: true
        }
      };
    }
    if (["telegram", "telegram_test", "telegram-test", "test_telegram", "test-telegram", "telegram_getme", "telegram-getme", "getme", "get_me", "get-me"].includes(action)) {
      return {
        available: true,
        reason: "Telegram smoke test can be prepared again as a dry-run.",
        input: {
          action: "test_telegram",
          ...(profile ? { profile } : {}),
          dryRun: true
        }
      };
    }
    if (["channel", "channels", "channel_status", "channel-status", "platform", "platform_status", "platform-status"].includes(action)) {
      const platform = String(input.platform || input.channel || "").replace(/[^a-z0-9_-]/gi, "");
      return {
        available: true,
        reason: "Gateway channel state can be inspected again.",
        input: {
          action: "channel_status",
          ...(profile ? { profile } : {}),
          ...(platform ? { platform } : {})
        }
      };
    }
    if (!action || action === "status") {
      return {
        available: true,
        reason: "Gateway status can be inspected again.",
        input: {
          action: "status",
          ...(profile ? { profile } : {})
        }
      };
    }
  }

  return {
    available: false,
    reason: "This run needs fresh input from the control room before it can run again.",
    input: null
  };
}

function moduleRunProof(id, module, input = {}, extra = {}) {
  const requestedAt = now();
  const prompt = String(input.message || input.prompt || "");
  return {
    runId: extra.runId || moduleRunId(id),
    moduleId: id,
    moduleLabel: redactText(module?.label || id),
    moduleType: redactText(module?.type || module?.category || "module"),
    status: redactText(module?.status || "unknown"),
    mode: redactText(extra.mode || "dry_run"),
    requestedAt,
    dryRun: extra.dryRun !== false,
    execEnabled: extra.execEnabled ?? process.env.HERMES_AGENT_OS_ENABLE_EXEC === "1",
    explicitExecution: input.dryRun === false,
    promptChars: prompt.length,
    action: redactText(input.action || input.operation || input.tool || "message"),
    nextStep: redactText(extra.nextStep || ""),
    evidence: Array.isArray(extra.evidence) ? extra.evidence.map((item) => redactText(item)) : [],
    replay: safeReplayForRun(id, input),
    handoff: extra.handoff || null
  };
}

function shouldRecordAgentHandoff(id, module, input = {}) {
  if (input.recordHandoff === false) return false;
  if (input.workflowId || input.schedulerJobId) return false;
  if (id === "kanban" || id === "memory") return false;
  return ["agent", "provider", "runtime"].includes(module?.category) || ["cli", "provider", "routing", "local_runtime", "gateway", "model_router"].includes(module?.type);
}

function summarizeRunForMemory(module, proof, reply = "", execution = null) {
  const output = reply ? ` Reply: ${String(reply).slice(0, 800)}` : "";
  const executed = execution ? ` Adapter ${execution.adapterId}; exit ${execution.exitCode ?? "none"}; duration ${execution.durationMs}ms.` : "";
  return redactText(`${module.label} run ${proof.mode}. Status ${proof.status}. Prompt ${proof.promptChars} chars.${executed}${output}`);
}

async function recordAgentRunHandoff(id, module, input, proof, reply = "", execution = null) {
  if (!shouldRecordAgentHandoff(id, module, input)) return { proof };
  const finalStatus = proof.mode === "executed"
    ? execution?.exitCode === 0 || execution?.exitCode === "0" ? "completed" : "needs_review"
    : ["dry_run", "local_app", "status"].includes(proof.mode)
      ? "planned"
      : "blocked";
  const memoryResult = await addMemory({
    type: "episodic",
    agentId: id,
    namespace: "agent-runs",
    title: `${module.label} ${proof.mode} run`,
    content: summarizeRunForMemory(module, proof, reply, execution),
    tags: ["agent-run", module.category, module.type, proof.mode].filter(Boolean),
    privacy: "private",
    importance: proof.mode === "executed" ? 0.75 : 0.55,
    source: "module-run",
    metadata: {
      runId: proof.runId,
      moduleId: id,
      mode: proof.mode,
      status: proof.status,
      dryRun: proof.dryRun,
      execEnabled: proof.execEnabled,
      explicitExecution: proof.explicitExecution,
      promptChars: proof.promptChars,
      action: proof.action
    }
  });
  const kanban = await upsertKanbanCard({
    title: `${module.label}: ${proof.mode} ${proof.action}`,
    column: finalStatus === "completed" ? "done" : "todo",
    status: finalStatus,
    priority: finalStatus === "blocked" ? "high" : "normal",
    notes: `${proof.nextStep || "Review run proof and logs."}\nMemory: ${memoryResult.memory.id}`,
    sourceType: "agent_run",
    sourceId: `agent_run:${id}:${proof.runId}`,
    runId: proof.runId,
    linkedModule: id,
    linkedItemId: memoryResult.memory.id
  }, {
    sourceType: "agent_run",
    sourceId: `agent_run:${id}:${proof.runId}`
  });
  const handoff = {
    memoryId: memoryResult.memory.id,
    kanbanCardId: kanban.card.id,
    status: finalStatus
  };
  const nextProof = {
    ...proof,
    handoff,
    evidence: [
      ...proof.evidence,
      `memory: ${memoryResult.memory.id}`,
      `kanban: ${kanban.card.id}`
    ]
  };
  await appendModuleLog(id, {
    message: "Agent run handoff recorded",
    details: {
      runId: proof.runId,
      memoryId: memoryResult.memory.id,
      kanbanCardId: kanban.card.id,
      status: finalStatus,
      proof: nextProof
    }
  });
  return { proof: nextProof, handoff };
}

async function runProviderBackedModule(id, module, input = {}, forcedProvider = "") {
  const execEnabled = await isExecutionEnabled();
  const router = await runRouter({
    ...input,
    provider: forcedProvider || input.provider,
    source: id,
    operation: input.operation || input.action || "provider_module_run"
  });
  const providerLabel = forcedProvider ? routerProviderLabel(forcedProvider) : "Provider Router";
  const reply = !router.ok && forcedProvider
    ? `${providerLabel} is not configured for provider dispatch. Configure the required key or local endpoint, then run again.`
    : router.message || "Provider router returned no message.";
  const proof = moduleRunProof(id, module, input, {
    mode: router.mode || "router",
    execEnabled,
    dryRun: router.mode !== "executed",
    nextStep: router.ok
      ? router.mode === "executed"
        ? "Review provider output, usage, memory, and Kanban handoff."
        : "Configure execution gate and send dryRun:false to execute this provider call."
      : forcedProvider
        ? `Configure ${providerLabel} before running prompts through it.`
        : "Configure at least one provider before running prompts through the router.",
    evidence: [
      `provider: ${router.provider || forcedProvider || "none"}`,
      `model: ${router.model || "not selected"}`,
      router.usage ? `usage calls: ${router.usage.total?.calls ?? "recorded"}` : "usage: not recorded"
    ]
  });
  const handoff = await recordAgentRunHandoff(id, module, input, proof, reply);
  await appendModuleLog(id, {
    level: router.ok ? "info" : "warn",
    message: router.ok ? "Provider module run routed" : "Provider module run blocked",
    details: {
      provider: router.provider || forcedProvider,
      model: router.model || "",
      mode: router.mode,
      status: router.status || null,
      proof: handoff.proof
    }
  });
  return {
    ok: router.ok,
    mode: router.mode,
    reply,
    module,
    provider: router.provider || forcedProvider,
    model: router.model || null,
    router,
    proof: handoff.proof,
    handoff: handoff.handoff || null
  };
}

async function runHermesControl(module, input = {}) {
  const stored = await getStoredConnectionConfig();
  const inventory = await hermesInventory(stored, input);
  const action = String(input.action || input.operation || input.tool || "status").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const requestedProfile = String(input.profile || input.profileId || inventory.activeProfile || "").replace(/[^a-z0-9_-]/gi, "");
  const profile = requestedProfile
    ? inventory.profiles.find((item) => item.id === requestedProfile) || null
    : inventory.profiles.find((item) => item.gateway.state === "running") || inventory.profiles[0] || null;
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false;
  const restartRequested = ["restart_gateway", "restart-gateway", "kickstart", "restart"].includes(action);
  const taskStatusRequested = ["task_status", "task-status", "show_task", "show-task", "status_task", "status-task"].includes(action);
  const taskControl = hermesTaskControlAction(action);
  const taskControlRequested = Boolean(taskControl);
  const taskRequested = ["task", "dispatch", "create_task", "create-task", "kanban", "message", "send_task", "send-task"].includes(action)
    || Boolean(input.message || input.prompt || input.taskTitle || input.title);
  let mode = restartRequested || taskRequested || taskControlRequested ? "dry_run" : "status";
  let ok = inventory.configured;
  let reply = inventory.configured
    ? `Hermes has ${inventory.profileCount} profile${inventory.profileCount === 1 ? "" : "s"}, ${inventory.runningProfiles} running gateway${inventory.runningProfiles === 1 ? "" : "s"}, and ${inventory.connectedPlatforms} connected platform${inventory.connectedPlatforms === 1 ? "" : "s"}.`
    : "Hermes profiles were not found. Configure HERMES_HOME.";
  const evidence = [
    `profiles: ${inventory.profileCount}`,
    `running gateways: ${inventory.runningProfiles}`,
    `connected platforms: ${inventory.connectedPlatforms}`
  ];
  let execution = null;
  let control = {
    action,
    selectedProfile: profile?.id || null,
    launchLabel: profile?.launchLabel || null,
    command: null,
    executed: false,
    queue: null,
    taskId: null,
    taskStatus: null
  };
  let hermesTask = null;

  if (restartRequested) {
    mode = "dry_run";
    if (!profile) {
      ok = false;
      mode = "ready_to_configure";
      reply = "No Hermes profile is available to restart.";
    } else {
      control.command = `launchctl kickstart -k gui/${process.getuid?.() || "$(id -u)"}/${profile.launchLabel}`;
      evidence.push(`launchd: ${profile.launchd.loaded ? "loaded" : "not loaded"}`);
      reply = `Prepared Hermes gateway restart for ${profile.id}. Execution requires the trusted execution gate and dryRun:false.`;
      if (execEnabled && explicitExecution) {
        const target = `gui/${process.getuid?.() || os.userInfo().uid}/${profile.launchLabel}`;
        const result = await runCommand("/bin/launchctl", ["kickstart", "-k", target], 10000);
        ok = result.ok;
        mode = "executed";
        control.executed = true;
        execution = {
          adapterId: "hermes-launchd",
          exitCode: result.code ?? (result.ok ? 0 : 1),
          durationMs: null,
          stdoutBytes: String(result.stdout || "").length,
          stderrBytes: String(result.stderr || "").length
        };
        reply = result.ok
          ? `Hermes gateway restart requested for ${profile.id}.`
          : `Hermes gateway restart failed for ${profile.id}: ${redactText(result.stderr || result.stdout || "launchctl failed")}`;
        evidence.push(`launchctl exit: ${result.code ?? "unknown"}`);
      }
    }
  } else if (taskStatusRequested) {
    mode = "status";
    const cli = await hermesCliFrom(stored);
    const taskId = cleanHermesTaskId(input);
    const board = cleanHermesBoard(stored, input);
    control.command = publicHermesTaskStatusCommand({ board, taskId });
    control.queue = board || "default";
    control.taskId = taskId || null;
    evidence.push(`queue: ${control.queue}`);
    evidence.push(`cli: ${cli.commandPath ? "available" : cli.configuredPath ? "configured path missing" : "missing"}`);

    if (!taskId) {
      ok = false;
      mode = "ready_to_configure";
      reply = "Provide a Hermes task id to refresh task status.";
    } else if (!cli.commandPath) {
      ok = false;
      mode = "ready_to_configure";
      reply = cli.configuredPath
        ? "Configured HERMES_CLI_PATH was not found. Update the Hermes connection settings."
        : "Hermes CLI was not found on PATH. Configure HERMES_CLI_PATH to refresh task status.";
    } else {
      const args = [
        "kanban",
        ...(board ? ["--board", board] : []),
        "show",
        taskId,
        "--json"
      ];
      const result = await runCommand(cli.commandPath, args, numericTimeout(input.timeoutMs || 15000), {
        env: {
          ...process.env,
          HERMES_HOME: hermesHomeFrom(stored, input)
        }
      });
      hermesTask = result.ok ? publicHermesTaskStatus(result.stdout) : null;
      ok = result.ok && Boolean(hermesTask?.id);
      control.executed = true;
      control.taskStatus = hermesTask?.status || null;
      reply = ok
        ? `Hermes task ${hermesTask.id} is ${hermesTask.status || "unknown"}.`
        : `Hermes task status refresh failed: ${redactText(result.stderr || result.stdout || "hermes kanban show failed", [cli.commandPath])}`;
      evidence.push(`hermes kanban show exit: ${result.code ?? "unknown"}`);
      if (hermesTask?.id) evidence.push(`task: ${hermesTask.id}`);
      if (hermesTask?.status) evidence.push(`task status: ${hermesTask.status}`);
      if (hermesTask?.runCount != null) evidence.push(`runs: ${hermesTask.runCount}`);
    }
  } else if (taskControlRequested) {
    mode = taskControl.readOnly ? "status" : "dry_run";
    const cli = await hermesCliFrom(stored);
    const taskId = cleanHermesTaskId(input);
    const board = cleanHermesBoard(stored, input);
    const reason = cleanHermesTaskReason(input);
    const targetProfile = String(input.profile || input.profileId || profile?.id || "").replace(/[^a-z0-9_-]/gi, "");
    const command = hermesTaskControlCommand({ control: taskControl, board, taskId, profile: targetProfile, reason });
    control.command = publicHermesTaskControlCommand({ control: taskControl, board, taskId, profile: targetProfile });
    control.queue = board || "default";
    control.taskId = taskId || null;
    control.taskStatus = taskControl.status || null;
    evidence.push(`queue: ${control.queue}`);
    evidence.push(`task control: ${taskControl.label}`);
    evidence.push(`cli: ${cli.commandPath ? "available" : cli.configuredPath ? "configured path missing" : "missing"}`);

    if (!taskId) {
      ok = false;
      mode = "ready_to_configure";
      reply = `Provide a Hermes task id to ${taskControl.label.toLowerCase()}.`;
    } else if (taskControl.needsProfile && !targetProfile) {
      ok = false;
      mode = "ready_to_configure";
      reply = "Select a Hermes profile before reassigning the task.";
    } else if (!cli.commandPath) {
      ok = false;
      mode = "ready_to_configure";
      reply = cli.configuredPath
        ? "Configured HERMES_CLI_PATH was not found. Update the Hermes connection settings."
        : `Hermes CLI was not found on PATH. Configure HERMES_CLI_PATH to ${taskControl.label.toLowerCase()}.`;
    } else if (taskControl.readOnly || (execEnabled && explicitExecution)) {
      const result = await runCommand(cli.commandPath, command.args, numericTimeout(input.timeoutMs || 20000), {
        env: {
          ...process.env,
          HERMES_HOME: hermesHomeFrom(stored, input)
        }
      });
      ok = result.ok;
      mode = taskControl.readOnly ? "status" : "executed";
      control.executed = true;
      execution = {
        adapterId: "hermes-kanban-control",
        exitCode: result.code ?? (result.ok ? 0 : 1),
        durationMs: null,
        stdoutBytes: String(result.stdout || "").length,
        stderrBytes: String(result.stderr || "").length
      };
      const output = redactText(result.stderr || result.stdout || "", [cli.commandPath]);
      reply = result.ok
        ? `${taskControl.label} requested for Hermes task ${taskId}.`
        : `${taskControl.label} failed for Hermes task ${taskId}: ${output || "hermes kanban command failed"}`;
      evidence.push(`hermes kanban ${taskControl.command} exit: ${result.code ?? "unknown"}`);
    } else {
      reply = `Prepared ${taskControl.label.toLowerCase()} for Hermes task ${taskId}. Execution requires the trusted execution gate and dryRun:false.`;
    }
  } else if (taskRequested) {
    mode = "dry_run";
    const cli = await hermesCliFrom(stored);
    const title = cleanHermesTaskTitle(input);
    const body = cleanHermesTaskBody(input);
    const board = cleanHermesBoard(stored, input);
    const goalMode = input.goal === true || input.goalMode === true;
    const targetProfile = profile?.id || requestedProfile;
    control.command = publicHermesTaskCommand({ board, profile: targetProfile, goalMode });
    control.queue = board || "default";
    evidence.push(`queue: ${control.queue}`);
    evidence.push(`cli: ${cli.commandPath ? "available" : cli.configuredPath ? "configured path missing" : "missing"}`);

    if (!targetProfile) {
      ok = false;
      mode = "ready_to_configure";
      reply = "No Hermes profile is available to receive the task. Create or select a Hermes profile first.";
    } else if (!cli.commandPath) {
      ok = false;
      mode = "ready_to_configure";
      reply = cli.configuredPath
        ? "Configured HERMES_CLI_PATH was not found. Update the Hermes connection settings."
        : "Hermes CLI was not found on PATH. Configure HERMES_CLI_PATH to enable real task dispatch.";
    } else {
      reply = `Prepared Hermes Kanban task for ${targetProfile}. Execution requires the trusted execution gate and dryRun:false.`;
      if (execEnabled && explicitExecution) {
        const args = [
          "kanban",
          ...(board ? ["--board", board] : []),
          "create",
          title,
          "--body",
          body,
          "--assignee",
          targetProfile,
          ...(goalMode ? ["--goal"] : []),
          "--json"
        ];
        const result = await runCommand(cli.commandPath, args, numericTimeout(input.timeoutMs || 30000), {
          env: {
            ...process.env,
            HERMES_HOME: hermesHomeFrom(stored, input)
          }
        });
        const task = parseHermesTaskResult(result.stdout);
        ok = result.ok && Boolean(task?.id);
        mode = "executed";
        control.executed = true;
        control.taskId = task?.id || null;
        control.taskStatus = task?.status || null;
        execution = {
          adapterId: "hermes-kanban",
          exitCode: result.code ?? (result.ok ? 0 : 1),
          durationMs: null,
          stdoutBytes: String(result.stdout || "").length,
          stderrBytes: String(result.stderr || "").length
        };
        reply = ok
          ? `Created Hermes Kanban task ${task.id} for ${task.assignee || targetProfile}.`
          : `Hermes task dispatch failed: ${redactText(result.stderr || result.stdout || "hermes kanban create failed", [cli.commandPath])}`;
        evidence.push(`hermes kanban exit: ${result.code ?? "unknown"}`);
        if (task?.id) evidence.push(`task: ${task.id}`);
        if (task?.status) evidence.push(`task status: ${task.status}`);
      }
    }
  }

  const proof = moduleRunProof("hermes", module, input, {
    mode,
    execEnabled,
    dryRun: taskControl?.readOnly ? false : !((restartRequested || taskRequested || taskControlRequested) && execEnabled && explicitExecution),
    nextStep: restartRequested
      ? execEnabled && explicitExecution
        ? "Refresh Hermes status after launchd updates gateway_state.json."
        : "Enable execution gate and send dryRun:false to restart this gateway from the dashboard."
      : taskControlRequested
        ? taskControl.readOnly
          ? "Use task status refresh or open Hermes Kanban for full task details."
          : execEnabled && explicitExecution
            ? "Refresh task status to confirm Hermes accepted the task control command."
            : "Enable execution gate and send dryRun:false to apply this Hermes task control."
      : taskRequested
        ? execEnabled && explicitExecution
          ? "Open Hermes Kanban or wait for the gateway dispatcher to pick up the ready task."
          : "Enable execution gate and send dryRun:false to create the task inside Hermes Kanban."
        : taskStatusRequested
          ? "Refresh again to follow Hermes task state, or open Hermes Kanban for full logs."
        : "Use action restart_gateway with a profile id to prepare a gateway restart, or send a message to create a Hermes Kanban task.",
    evidence
  });
  const handoff = await recordAgentRunHandoff("hermes", module, {
    ...input,
    recordHandoff: taskStatusRequested || taskControl?.readOnly ? false : input.recordHandoff
  }, proof, reply, execution);
  await appendModuleLog("hermes", {
    level: ok ? "info" : "warn",
    message: restartRequested
      ? "Hermes gateway control requested"
      : taskStatusRequested
        ? "Hermes Kanban task status refreshed"
        : taskControlRequested
        ? "Hermes Kanban task control requested"
        : taskRequested
        ? "Hermes Kanban task dispatch requested"
        : "Hermes runtime status inspected",
    details: {
      action,
      selectedProfile: control.selectedProfile,
      mode,
      profileCount: inventory.profileCount,
      runningProfiles: inventory.runningProfiles,
      connectedPlatforms: inventory.connectedPlatforms,
      control,
      proof: handoff.proof
    }
  });
  return {
    ok,
    mode,
    reply,
    module,
    hermes: inventory,
    control,
    hermesTask,
    execution,
    proof: handoff.proof,
    handoff: handoff.handoff || null
  };
}

async function resolveCliCommand(definition, stored) {
  const configuredPath = (definition.pathKeys || [`${definition.id.toUpperCase().replaceAll("-", "_")}_CLI_PATH`])
    .map((key) => getConfiguredValue(stored, definition.id, key))
    .find(Boolean);
  if (configuredPath) {
    const expanded = expandHome(configuredPath);
    try {
      await fs.access(expanded);
      return { commandPath: expanded, configuredPath: true, configuredPathMissing: false };
    } catch {
      return { commandPath: "", configuredPath: true, configuredPathMissing: true };
    }
  }
  return { commandPath: await which(definition.command), configuredPath: false, configuredPathMissing: false };
}

async function cliModule(definition, stored) {
  if (definition.id === "voice-control") {
    const voice = await getVoiceControlStatus();
    return standardModule({
      id: definition.id,
      label: definition.label,
      category: definition.category,
      type: "desktop_voice",
      status: voice.status,
      configured: voice.configured,
      missing: voice.missing,
      capabilities: voice.capabilities,
      configKeys: definition.envKeys,
      installHint: definition.installHint,
      docsUrl: definition.docsUrl,
      version: voice.model,
      publicSummary: voice.publicSummary,
      actions: ["configure", "test", "run", "logs"],
      stats: {
        tools: voice.tools,
        wakeWords: voice.wakeWords,
        model: voice.model
      },
      taskProfiles: voiceControlTaskProfiles()
    });
  }
  const resolved = await resolveCliCommand(definition, stored);
  const commandPath = resolved.commandPath;
  const version = redactText(await commandVersion(commandPath), [commandPath]);
  const hasProviderConfig = definition.envKeys.some((key) => Boolean(getConfiguredValue(stored, definition.id, key)));
  const connected = Boolean(commandPath);
  return standardModule({
    id: definition.id,
    label: definition.label,
    category: definition.category,
    type: "cli",
    status: connected ? "connected" : "missing_dependency",
    configured: connected || hasProviderConfig,
    missing: connected ? [] : [resolved.configuredPathMissing ? "configured CLI path not found" : definition.command],
    capabilities: definition.capabilities,
    configKeys: definition.envKeys,
    installHint: definition.installHint,
    docsUrl: definition.docsUrl,
    version,
    publicSummary: connected
      ? `${definition.label} CLI is installed and callable by the local runtime.`
      : `${definition.label} is ready; install ${definition.command} or configure a local path.`,
    actions: connected
      ? ["configure", "test", "run", "sessions", "logs"]
      : ["install", "configure", "test", "run", "sessions", "logs", "docs"],
    taskProfiles: codeAgentTaskProfiles(definition.label),
    ...recipeFields(definition.id)
  });
}

async function readJsonIfExists(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function hermesHomeFrom(stored = {}, input = {}) {
  return expandHome(
    input.hermesHome ||
    getConfiguredValue(stored, "gateway", "HERMES_HOME") ||
    getConfiguredValue(stored, "hermes", "HERMES_HOME") ||
    process.env.HERMES_HOME
  ) || path.join(os.homedir(), ".hermes");
}

async function hermesCliFrom(stored = {}) {
  const configured = getConfiguredValue(stored, "gateway", "HERMES_CLI_PATH") ||
    getConfiguredValue(stored, "hermes", "HERMES_CLI_PATH");
  if (configured) {
    const expanded = expandHome(configured);
    try {
      await fs.access(expanded);
      return { commandPath: expanded, command: "hermes", configuredPath: true, missing: false };
    } catch {
      return { commandPath: "", command: "hermes", configuredPath: true, missing: true };
    }
  }
  const commandPath = await which("hermes");
  return { commandPath, command: "hermes", configuredPath: false, missing: !commandPath };
}

function hermesLaunchLabel(profile) {
  const clean = String(profile || "").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  return clean ? `ai.hermes.gateway-${clean}` : "";
}

function cleanHermesTaskTitle(input = {}) {
  const explicit = String(input.title || input.taskTitle || "").trim();
  const message = String(input.message || input.prompt || input.body || "").trim();
  const raw = explicit || message || "Dashboard task";
  const singleLine = raw.replace(/\s+/g, " ").slice(0, 96).trim();
  return singleLine || "Dashboard task";
}

function cleanHermesTaskBody(input = {}) {
  const raw = String(input.body || input.message || input.prompt || "").trim();
  return raw || "Task created from Hermes Agent OS dashboard.";
}

function cleanHermesBoard(stored = {}, input = {}) {
  const raw = String(input.board || getConfiguredValue(stored, "gateway", "HERMES_KANBAN_BOARD") || getConfiguredValue(stored, "hermes", "HERMES_KANBAN_BOARD") || "").trim();
  return raw.replace(/[^a-z0-9_.-]/gi, "").slice(0, 80);
}

function publicHermesTaskCommand({ board, profile, goalMode }) {
  return [
    "hermes",
    "kanban",
    ...(board ? ["--board", board] : []),
    "create",
    "<title>",
    "--body",
    "<message>",
    ...(profile ? ["--assignee", profile] : []),
    ...(goalMode ? ["--goal"] : []),
    "--json"
  ].join(" ");
}

function cleanHermesTaskId(input = {}) {
  return String(input.taskId || input.taskID || input.id || "").trim().replace(/[^a-z0-9_.:-]/gi, "").slice(0, 120);
}

function publicHermesTaskStatusCommand({ board, taskId }) {
  return [
    "hermes",
    "kanban",
    ...(board ? ["--board", board] : []),
    "show",
    taskId || "<task_id>",
    "--json"
  ].join(" ");
}

function cleanHermesTaskReason(input = {}) {
  const raw = String(input.reason || input.summary || input.result || input.comment || "Dashboard control").trim();
  return raw.replace(/\s+/g, " ").slice(0, 240) || "Dashboard control";
}

function hermesTaskControlAction(action = "") {
  const normalized = String(action || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const controls = {
    task_reclaim: { command: "reclaim", label: "Stop active claim", status: "reclaimed" },
    "task-reclaim": { command: "reclaim", label: "Stop active claim", status: "reclaimed" },
    reclaim_task: { command: "reclaim", label: "Stop active claim", status: "reclaimed" },
    "reclaim-task": { command: "reclaim", label: "Stop active claim", status: "reclaimed" },
    stop_task: { command: "reclaim", label: "Stop active claim", status: "reclaimed" },
    "stop-task": { command: "reclaim", label: "Stop active claim", status: "reclaimed" },
    task_block: { command: "block", label: "Block task", status: "blocked" },
    "task-block": { command: "block", label: "Block task", status: "blocked" },
    block_task: { command: "block", label: "Block task", status: "blocked" },
    "block-task": { command: "block", label: "Block task", status: "blocked" },
    task_unblock: { command: "unblock", label: "Unblock task", status: "ready" },
    "task-unblock": { command: "unblock", label: "Unblock task", status: "ready" },
    unblock_task: { command: "unblock", label: "Unblock task", status: "ready" },
    "unblock-task": { command: "unblock", label: "Unblock task", status: "ready" },
    task_promote: { command: "promote", label: "Promote task", status: "ready" },
    "task-promote": { command: "promote", label: "Promote task", status: "ready" },
    promote_task: { command: "promote", label: "Promote task", status: "ready" },
    "promote-task": { command: "promote", label: "Promote task", status: "ready" },
    task_complete: { command: "complete", label: "Complete task", status: "done" },
    "task-complete": { command: "complete", label: "Complete task", status: "done" },
    complete_task: { command: "complete", label: "Complete task", status: "done" },
    "complete-task": { command: "complete", label: "Complete task", status: "done" },
    task_archive: { command: "archive", label: "Archive task", status: "archived" },
    "task-archive": { command: "archive", label: "Archive task", status: "archived" },
    archive_task: { command: "archive", label: "Archive task", status: "archived" },
    "archive-task": { command: "archive", label: "Archive task", status: "archived" },
    task_reassign: { command: "reassign", label: "Reassign task", status: "assigned", needsProfile: true },
    "task-reassign": { command: "reassign", label: "Reassign task", status: "assigned", needsProfile: true },
    reassign_task: { command: "reassign", label: "Reassign task", status: "assigned", needsProfile: true },
    "reassign-task": { command: "reassign", label: "Reassign task", status: "assigned", needsProfile: true },
    task_runs: { command: "runs", label: "Task runs", status: "runs", readOnly: true },
    "task-runs": { command: "runs", label: "Task runs", status: "runs", readOnly: true },
    runs_task: { command: "runs", label: "Task runs", status: "runs", readOnly: true },
    "runs-task": { command: "runs", label: "Task runs", status: "runs", readOnly: true }
  };
  const control = controls[normalized];
  return control ? { readOnly: false, needsProfile: false, ...control } : null;
}

function hermesTaskControlCommand({ control, board, taskId, profile, reason }) {
  const prefix = ["kanban", ...(board ? ["--board", board] : [])];
  if (control.command === "reassign") return { args: [...prefix, "reassign", taskId, profile, "--reclaim", "--reason", reason] };
  if (control.command === "reclaim") return { args: [...prefix, "reclaim", taskId, "--reason", reason] };
  if (control.command === "block") return { args: [...prefix, "block", taskId, "--kind", "needs_input", reason] };
  if (control.command === "unblock") return { args: [...prefix, "unblock", taskId, "--reason", reason] };
  if (control.command === "promote") return { args: [...prefix, "promote", taskId, reason, "--json"] };
  if (control.command === "complete") return { args: [...prefix, "complete", taskId, "--result", reason, "--summary", reason] };
  if (control.command === "archive") return { args: [...prefix, "archive", taskId] };
  if (control.command === "runs") return { args: [...prefix, "runs", taskId, "--json"] };
  return { args: [...prefix, control.command, taskId] };
}

function publicHermesTaskControlCommand({ control, board, taskId, profile }) {
  const command = hermesTaskControlCommand({
    control,
    board,
    taskId: taskId || "<task_id>",
    profile: profile || "<profile>",
    reason: "<reason>"
  });
  return ["hermes", ...command.args].join(" ");
}

function parseHermesTaskResult(stdout = "") {
  try {
    const payload = JSON.parse(stdout);
    return {
      id: payload.id || null,
      status: payload.status || null,
      assignee: payload.assignee || null,
      title: payload.title || null
    };
  } catch {
    return null;
  }
}

function publicHermesTaskStatus(stdout = "") {
  try {
    const payload = JSON.parse(stdout);
    const task = payload?.task && typeof payload.task === "object" ? payload.task : {};
    const runs = Array.isArray(payload?.runs) ? payload.runs : [];
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const latestRun = runs.length ? runs[runs.length - 1] : null;
    return sanitizeObject({
      id: task.id || null,
      title: task.title || null,
      status: task.status || null,
      assignee: task.assignee || null,
      priority: task.priority ?? null,
      createdAt: task.created_at || task.createdAt || null,
      startedAt: task.started_at || task.startedAt || null,
      completedAt: task.completed_at || task.completedAt || null,
      latestSummaryPresent: Boolean(payload?.latest_summary),
      runCount: runs.length,
      eventCount: events.length,
      latestRun: latestRun ? {
        id: latestRun.id || null,
        profile: latestRun.profile || null,
        status: latestRun.status || null,
        outcome: latestRun.outcome || null,
        startedAt: latestRun.started_at || null,
        endedAt: latestRun.ended_at || null
      } : null
    });
  } catch {
    return null;
  }
}

function publicGatewayState(state = {}) {
  const platforms = state && typeof state.platforms === "object" ? state.platforms : {};
  return {
    state: state?.gateway_state || state?.state || state?.status || "unknown",
    activeAgents: Number(state?.active_agents || 0),
    updatedAt: state?.updated_at || state?.updatedAt || state?.timestamp || null,
    platforms: Object.fromEntries(
      Object.entries(platforms).map(([id, value]) => [
        id,
        {
          state: value?.state || "unknown",
          updatedAt: value?.updated_at || value?.updatedAt || null,
          error: value?.error_message ? "present" : null
        }
      ])
    )
  };
}

function parseEnvText(text = "") {
  const output = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) output[key] = value;
  }
  return output;
}

async function readHermesProfileEnv(hermesHome, profileId) {
  const cleanProfile = String(profileId || "").replace(/[^a-z0-9_-]/gi, "");
  if (!cleanProfile) return {};
  try {
    return parseEnvText(await fs.readFile(path.join(hermesHome, "profiles", cleanProfile, ".env"), "utf8"));
  } catch {
    return {};
  }
}

function gatewayPlatformSummary(profile) {
  const platforms = profile?.gateway?.platforms && typeof profile.gateway.platforms === "object"
    ? profile.gateway.platforms
    : {};
  return Object.entries(platforms).map(([id, value]) => ({
    id,
    state: value?.state || "unknown",
    updatedAt: value?.updatedAt || null,
    error: value?.error || null
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function gatewayTelegramToken(profileEnv = {}) {
  return profileEnv.TELEGRAM_BOT_TOKEN || profileEnv.HERMES_TELEGRAM_BOT_TOKEN || profileEnv.TELEGRAM_TOKEN || "";
}

function gatewayTelegramApiBase(stored = {}) {
  return String(getConfiguredValue(stored, "gateway", "HERMES_TELEGRAM_API_BASE") || process.env.HERMES_TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      text: data ? "" : text.slice(0, 500)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runGatewayControl(module, input = {}) {
  const stored = await getStoredConnectionConfig();
  const inventory = await hermesInventory(stored, input);
  const hermesHome = hermesHomeFrom(stored, input);
  const action = String(input.action || input.operation || input.tool || "status").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false;
  const restartRequested = ["restart_gateway", "restart-gateway", "kickstart", "restart"].includes(action);
  const telegramRequested = ["telegram", "telegram_test", "telegram-test", "test_telegram", "test-telegram", "telegram_getme", "telegram-getme", "getme", "get_me", "get-me"].includes(action);
  const channelRequested = ["channel", "channels", "channel_status", "channel-status", "platform", "platform_status", "platform-status"].includes(action);
  const requestedPlatform = telegramRequested ? "telegram" : String(input.platform || input.channel || "").replace(/[^a-z0-9_-]/gi, "");
  const explicitProfile = String(input.profile || input.profileId || "").replace(/[^a-z0-9_-]/gi, "");
  const fallbackProfile = String(inventory.activeProfile || "").replace(/[^a-z0-9_-]/gi, "");
  let profile = explicitProfile
    ? inventory.profiles.find((item) => item.id === explicitProfile) || null
    : null;
  if (!profile && requestedPlatform) {
    profile = inventory.profiles.find((item) => Boolean(item.gateway?.platforms?.[requestedPlatform])) || null;
  }
  if (!profile && fallbackProfile) {
    profile = inventory.profiles.find((item) => item.id === fallbackProfile) || null;
  }
  if (!profile) {
    profile = inventory.profiles.find((item) => item.gateway.state === "running") || inventory.profiles[0] || null;
  }
  const profileEnv = profile ? await readHermesProfileEnv(hermesHome, profile.id) : {};
  const telegramToken = gatewayTelegramToken(profileEnv);
  const platforms = gatewayPlatformSummary(profile);
  let mode = restartRequested || telegramRequested ? "dry_run" : "status";
  let ok = inventory.configured;
  let reply = inventory.configured
    ? `Gateway sees ${inventory.profileCount} Hermes profile${inventory.profileCount === 1 ? "" : "s"}, ${inventory.runningProfiles} running gateway${inventory.runningProfiles === 1 ? "" : "s"}, and ${inventory.connectedPlatforms} connected platform${inventory.connectedPlatforms === 1 ? "" : "s"}.`
    : "No Hermes gateway profiles were found. Configure HERMES_HOME first.";
  let execution = null;
  const control = {
    action,
    selectedProfile: profile?.id || null,
    launchLabel: profile?.launchLabel || null,
    platform: requestedPlatform || null,
    command: null,
    endpoint: null,
    executed: false,
    tokenConfigured: telegramRequested ? Boolean(telegramToken) : undefined
  };
  const gateway = {
    configured: inventory.configured,
    profileCount: inventory.profileCount,
    runningProfiles: inventory.runningProfiles,
    connectedPlatforms: inventory.connectedPlatforms,
    activeProfile: inventory.activeProfile || null,
    selectedProfile: profile ? {
      id: profile.id,
      gateway: profile.gateway,
      launchLabel: profile.launchLabel,
      launchd: profile.launchd,
      channels: profile.channels,
      hasConfig: profile.hasConfig,
      hasEnv: profile.hasEnv,
      platforms
    } : null
  };
  const evidence = [
    `profiles: ${inventory.profileCount}`,
    `running gateways: ${inventory.runningProfiles}`,
    `connected platforms: ${inventory.connectedPlatforms}`
  ];

  if (restartRequested) {
    if (!profile) {
      ok = false;
      mode = "ready_to_configure";
      reply = "No Hermes profile is available to restart.";
    } else {
      control.command = `launchctl kickstart -k gui/${process.getuid?.() || "$(id -u)"}/${profile.launchLabel}`;
      evidence.push(`launchd: ${profile.launchd.loaded ? "loaded" : "not loaded"}`);
      reply = `Prepared Hermes gateway restart for ${profile.id}. Execution requires the trusted execution gate and dryRun:false.`;
      if (execEnabled && explicitExecution) {
        const target = `gui/${process.getuid?.() || os.userInfo().uid}/${profile.launchLabel}`;
        const result = await runCommand("/bin/launchctl", ["kickstart", "-k", target], 10000);
        ok = result.ok;
        mode = "executed";
        control.executed = true;
        execution = {
          adapterId: "hermes-gateway-launchd",
          exitCode: result.code ?? (result.ok ? 0 : 1),
          durationMs: null,
          stdoutBytes: String(result.stdout || "").length,
          stderrBytes: String(result.stderr || "").length
        };
        reply = result.ok
          ? `Gateway restart requested for ${profile.id}.`
          : `Gateway restart failed for ${profile.id}: ${redactText(result.stderr || result.stdout || "launchctl failed")}`;
        evidence.push(`launchctl exit: ${result.code ?? "unknown"}`);
      }
    }
  } else if (telegramRequested) {
    control.endpoint = `${gatewayTelegramApiBase(stored)}/bot<token>/getMe`;
    evidence.push(`telegram token: ${telegramToken ? "configured" : "missing"}`);
    evidence.push(`execution gate: ${execEnabled ? "enabled" : "disabled"}`);
    if (!profile) {
      ok = false;
      mode = "ready_to_configure";
      reply = "Select or create a Hermes profile before testing Telegram.";
    } else if (!telegramToken) {
      ok = false;
      mode = "ready_to_configure";
      reply = `Telegram is not configured for ${profile.id}. Add TELEGRAM_BOT_TOKEN to that profile environment.`;
    } else if (!execEnabled || !explicitExecution) {
      ok = true;
      mode = "dry_run";
      reply = `Prepared Telegram getMe smoke test for ${profile.id}. Execution requires the trusted execution gate and dryRun:false.`;
    } else {
      const endpoint = `${gatewayTelegramApiBase(stored)}/bot${telegramToken}/getMe`;
      const result = await fetchJsonWithTimeout(endpoint, { method: "GET" }, numericTimeout(input.timeoutMs || 10000));
      ok = Boolean(result.ok && result.data?.ok);
      mode = "executed";
      control.executed = true;
      execution = {
        adapterId: "hermes-gateway-telegram",
        exitCode: ok ? 0 : 1,
        durationMs: null,
        stdoutBytes: JSON.stringify(result.data || {}).length,
        stderrBytes: result.ok ? 0 : String(result.text || "").length
      };
      gateway.telegram = sanitizeObject({
        ok,
        httpStatus: result.status,
        botId: result.data?.result?.id || null,
        username: result.data?.result?.username || null,
        firstName: result.data?.result?.first_name || null,
        canJoinGroups: result.data?.result?.can_join_groups ?? null,
        canReadAllGroupMessages: result.data?.result?.can_read_all_group_messages ?? null,
        supportsInlineQueries: result.data?.result?.supports_inline_queries ?? null
      });
      reply = ok
        ? `Telegram getMe succeeded for ${profile.id}${gateway.telegram.username ? ` as @${gateway.telegram.username}` : ""}.`
        : `Telegram getMe failed for ${profile.id} with HTTP ${result.status || "unknown"}.`;
      evidence.push(`telegram getMe: ${ok ? "ok" : "failed"}`);
    }
  } else if (channelRequested) {
    const requestedPlatform = control.platform;
    if (requestedPlatform) {
      const match = platforms.find((item) => item.id === requestedPlatform) || null;
      gateway.channel = match;
      ok = Boolean(profile && match);
      mode = ok ? "status" : "ready_to_configure";
      reply = ok
        ? `${requestedPlatform} is ${match.state} for ${profile.id}.`
        : `${requestedPlatform} is not present in the selected Hermes gateway profile.`;
      evidence.push(`platform: ${requestedPlatform}`);
      evidence.push(`platform state: ${match?.state || "missing"}`);
    } else {
      mode = "status";
      reply = profile
        ? `${profile.id} exposes ${platforms.length} gateway platform${platforms.length === 1 ? "" : "s"} and ${profile.channels} channel record${profile.channels === 1 ? "" : "s"}.`
        : reply;
      evidence.push(`selected profile platforms: ${platforms.length}`);
    }
  }

  const proof = moduleRunProof("gateway", module, input, {
    mode,
    execEnabled,
    dryRun: !((restartRequested || telegramRequested) && execEnabled && explicitExecution),
    nextStep: restartRequested
      ? execEnabled && explicitExecution
        ? "Refresh gateway status after launchd updates gateway_state.json."
        : "Enable execution gate and send dryRun:false to restart the local gateway."
      : telegramRequested
        ? execEnabled && explicitExecution
          ? "Use the Telegram channel state in Hermes Gateway to confirm message delivery."
          : "Enable execution gate and send dryRun:false to run a real Telegram getMe smoke test."
        : "Use action channel_status with a platform, test_telegram, or restart_gateway for deeper control.",
    evidence
  });
  const handoff = await recordAgentRunHandoff("gateway", module, input, proof, reply, execution);
  await appendModuleLog("gateway", {
    level: ok ? "info" : "warn",
    message: telegramRequested
      ? "Gateway Telegram smoke test requested"
      : restartRequested
      ? "Gateway restart requested"
      : channelRequested
      ? "Gateway channel status inspected"
      : "Gateway status inspected",
    details: {
      action,
      selectedProfile: control.selectedProfile,
      mode,
      profileCount: inventory.profileCount,
      runningProfiles: inventory.runningProfiles,
      connectedPlatforms: inventory.connectedPlatforms,
      control,
      proof: handoff.proof
    }
  });

  return sanitizeObject({
    ok,
    mode,
    reply,
    module,
    gateway,
    control,
    execution,
    proof: handoff.proof,
    handoff: handoff.handoff || null
  });
}

async function launchctlMap() {
  const result = await runCommand("/bin/launchctl", ["list"], 5000);
  if (!result.ok && !result.stdout) return {};
  const map = {};
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const label = parts[2] || "";
    if (!label.startsWith("ai.hermes.gateway-")) continue;
    map[label] = {
      pid: parts[0] && parts[0] !== "-" ? Number(parts[0]) || null : null,
      status: parts[1] == null ? null : Number(parts[1]),
      loaded: true
    };
  }
  return map;
}

async function hermesInventory(stored = {}, input = {}) {
  const hermesHome = hermesHomeFrom(stored, input);
  const profilesRoot = path.join(hermesHome, "profiles");
  let entries = [];
  try {
    entries = await fs.readdir(profilesRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const launchd = await launchctlMap();
  const profiles = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const id = entry.name;
    const root = path.join(profilesRoot, id);
    const gateway = publicGatewayState(await readJsonIfExists(path.join(root, "gateway_state.json"), {}));
    const channelDirectory = await readJsonIfExists(path.join(root, "channel_directory.json"), {});
    const channels = Array.isArray(channelDirectory?.channels)
      ? channelDirectory.channels.length
      : channelDirectory && typeof channelDirectory === "object"
        ? Object.keys(channelDirectory).length
        : 0;
    const label = hermesLaunchLabel(id);
    profiles.push({
      id,
      gateway,
      launchLabel: label,
      launchd: launchd[label] || { pid: null, status: null, loaded: false },
      channels,
      hasConfig: await fs.access(path.join(root, "config.yaml")).then(() => true).catch(() => false),
      hasEnv: await fs.access(path.join(root, ".env")).then(() => true).catch(() => false)
    });
  }
  const runningProfiles = profiles.filter((profile) => profile.gateway.state === "running" || profile.launchd.pid).length;
  const connectedPlatforms = profiles.reduce((count, profile) =>
    count + Object.values(profile.gateway.platforms || {}).filter((platform) => platform.state === "connected").length, 0);
  const activeProfile = await fs.readFile(path.join(hermesHome, "active_profile"), "utf8").then((value) => value.trim()).catch(() => "");
  return {
    configured: profiles.length > 0,
    profileCount: profiles.length,
    runningProfiles,
    connectedPlatforms,
    activeProfile,
    profiles: profiles.sort((a, b) => a.id.localeCompare(b.id)),
    checkedAt: now()
  };
}

function publicHermesProfileOption(profile) {
  const platforms = profile?.gateway?.platforms && typeof profile.gateway.platforms === "object"
    ? profile.gateway.platforms
    : {};
  return {
    id: profile.id,
    gatewayState: profile.gateway?.state || "unknown",
    activeAgents: profile.gateway?.activeAgents ?? null,
    connectedPlatforms: Object.values(platforms).filter((platform) => platform?.state === "connected").length,
    platformCount: Object.keys(platforms).length,
    channels: profile.channels,
    launchdLoaded: Boolean(profile.launchd?.loaded),
    launchdPid: profile.launchd?.pid || null,
    hasConfig: Boolean(profile.hasConfig),
    hasEnv: Boolean(profile.hasEnv)
  };
}

async function hermesModule(stored = {}) {
  const inventory = await hermesInventory(stored);
  const profileCount = inventory.profileCount;
  return standardModule({
    id: "hermes",
    label: "Hermes Agent",
    category: "agent",
    type: "local_runtime",
    status: profileCount ? "connected" : "ready_to_configure",
    configured: profileCount > 0,
    missing: profileCount ? [] : ["HERMES_HOME"],
    capabilities: ["memory", "skills", "gateway", "channels", "profiles", "launchd-control", "desktop-runtime", "kanban-task-dispatch", "kanban-task-status", "kanban-task-control", "goal-task-dispatch"],
    configKeys: ["HERMES_HOME", "HERMES_CLI_PATH", "HERMES_KANBAN_BOARD"],
    installHint: "Install or point Hermes Agent at a local HERMES_HOME profile directory.",
    profileCount,
    onlineProfiles: inventory.runningProfiles,
	    stats: {
	      profileCount,
	      runningProfiles: inventory.runningProfiles,
	      connectedPlatforms: inventory.connectedPlatforms,
	      activeProfile: inventory.activeProfile || null
	    },
	    activeProfile: inventory.activeProfile || null,
	    profiles: inventory.profiles.map(publicHermesProfileOption),
	    publicSummary: profileCount
      ? `${profileCount} local Hermes profile${profileCount === 1 ? "" : "s"} detected; ${inventory.runningProfiles} gateway${inventory.runningProfiles === 1 ? "" : "s"} running.`
      : "Set HERMES_HOME or install Hermes Agent to connect local runtime state.",
    actions: profileCount ? ["configure", "test", "run", "sessions", "logs", "restart-gateway", "task-control"] : ["install", "configure", "docs"],
    taskProfiles: hermesAgentTaskProfiles(),
    ...recipeFields("hermes")
  });
}

async function gatewayModule(hermes) {
  const connected = hermes.status === "connected";
  return standardModule({
    id: "gateway",
    label: "Hermes Gateway",
    category: "runtime",
    type: "gateway",
    status: connected ? "connected" : "ready_to_configure",
    configured: connected,
    missing: connected ? [] : ["Hermes profiles"],
    capabilities: ["telegram", "browser", "webhooks", "channels", "profile-status", "launchd-control", "channel-smoke-tests"],
    publicSummary: connected
      ? "Gateway can inspect configured local channels, prepare restarts, and run gated channel smoke tests without returning private channel data."
      : "Gateway is ready; connect Hermes profiles and channels locally.",
    actions: connected ? ["configure", "test", "run", "logs", "channel-status", "test-telegram", "restart-gateway"] : ["install", "configure", "docs"],
    configKeys: ["HERMES_HOME", "HERMES_CLI_PATH", "HERMES_KANBAN_BOARD", "HERMES_TELEGRAM_API_BASE"]
  });
}

async function elizaRuntimeModule() {
  const status = await getElizaStatus();
  return standardModule({
    id: "elizaos-runtime",
    label: "elizaOS Runtime",
    category: "runtime",
    type: "agent_os_core",
    status: status.ok ? "connected" : "error",
    configured: status.ok,
    missing: status.missingExports,
    capabilities: ["agents", "plugins", "memory", "model-routing", "services"],
    version: status.version,
    publicSummary: status.ok
      ? `Real ${status.packageName} ${status.version} is installed and loadable.`
      : "elizaOS core is not loadable; install @elizaos/core.",
    actions: ["test", "logs"],
    source: status.source,
    stats: {
      runtimeClass: status.runtimeClass,
      exports: status.exports
    },
    installHint: "Installed through npm dependency @elizaos/core. This is the Agent OS runtime foundation Hermes wraps."
  });
}

async function kernelModule() {
  const status = await getElizaStatus();
  return standardModule({
    id: "kernel",
    label: "Hermes Kernel",
    category: "runtime",
    type: "os_kernel",
    status: status.ok ? "connected" : "error",
    configured: status.ok,
    missing: status.missingExports,
    capabilities: ["runtime-core", "module-registry", "scheduler", "memory", "skills", "model-router", "workflow-engine", "safety"],
    publicSummary: status.ok
      ? "Kernel coordinates the runtime core, module bus, scheduler, memory, skill registry, provider router, workflows, and export safety."
      : "Kernel cannot verify the elizaOS runtime foundation.",
    actions: ["open", "test", "logs"],
    source: "agent-os-runtime",
    stats: {
      runtimeClass: status.runtimeClass,
      elizaVersion: status.version
    },
    installHint: "Open the Kernel workspace to verify each Agent OS subsystem from one sanitized report."
  });
}

async function minimaxModule(stored) {
  const requiredConfigPresent = ["minimax", "provider-minimax"].some((id) =>
    Boolean(getConfiguredValue(stored, id, "MINIMAX_API_KEY"))
  );
  const health = requiredConfigPresent ? await checkProviderHealth("minimax") : null;
  const connected = health?.status === "healthy";
  return standardModule({
    id: "minimax",
    label: "MiniMax M3",
    category: "provider",
    type: "provider",
    status: connected ? "connected" : "ready_to_configure",
    configured: connected,
    missing: connected ? [] : requiredConfigPresent ? ["Healthy MiniMax route"] : ["MINIMAX_API_KEY"],
    capabilities: ["chat", "routing"],
    configKeys: ["MINIMAX_API_KEY"],
    installHint: "Add a user-owned MiniMax API key to enable MiniMax routing.",
    publicSummary: connected
      ? "MiniMax provider is healthy and ready for routing."
      : requiredConfigPresent
        ? "MiniMax is configured, but health is not verified."
      : "Add MINIMAX_API_KEY to enable MiniMax routing.",
    actions: ["configure", "test", "run", "sessions", "logs"],
    stats: {
      requiredConfigPresent,
      healthStatus: health?.status || null,
      healthMessage: health?.message || null,
      modelCount: health?.summary?.modelCount ?? null,
      selectedModel: health?.summary?.selectedModel || null,
      selectedModelAvailable: health?.summary?.selectedModelAvailable ?? null
    },
    taskProfiles: providerTaskProfiles("MiniMax M3")
  });
}

function providerConfigured(stored, definition) {
  return definition.envKeys.every((key) =>
    publicEnvConfigured(key) ||
    definition.configuredFrom.some((id) => Boolean(stored?.[id]?.[key]))
  );
}

async function providerModule(definition, stored) {
  const requiredConfigPresent = providerConfigured(stored, definition);
  const missing = definition.envKeys.filter((key) =>
    !publicEnvConfigured(key) &&
    !definition.configuredFrom.some((id) => Boolean(stored?.[id]?.[key]))
  );
  const runnable = definition.capabilities.some((capability) => ["llm", "routing", "local-models"].includes(capability));
  const routerProvider = routerProviderForModuleId(definition.id);
  const health = runnable && requiredConfigPresent && routerProvider
    ? await checkProviderHealth(routerProvider)
    : null;
  const healthy = health?.status === "healthy";
  const connected = runnable ? healthy : requiredConfigPresent;
  const setupMissing = connected
    ? []
    : requiredConfigPresent && runnable
      ? [`Healthy ${definition.label} route`]
      : missing;
  const recipe = recipeFields(definition.id);
  return standardModule({
    id: definition.id,
    label: definition.label,
    category: "provider",
    type: "provider",
    status: connected ? "connected" : "ready_to_configure",
    configured: connected,
    missing: setupMissing,
    capabilities: definition.capabilities,
    configKeys: definition.envKeys,
    publicSummary: connected
      ? `${definition.label} provider is healthy and ready for routing.`
      : requiredConfigPresent && runnable
        ? `${definition.label} is configured, but health is not verified.`
        : definition.publicSummary,
    actions: [
      ...(recipe.installCommand ? ["install"] : []),
      ...(runnable ? ["configure", "test", "run", "sessions", "logs"] : ["configure", "test", "logs"])
    ],
    docsUrl: definition.docsUrl,
    installHint: definition.id === "provider-ollama"
      ? "Install Ollama locally, run `ollama serve`, then save OLLAMA_HOST for local model routing."
      : "No install required in Hermes. Add your own provider key or local endpoint.",
    stats: {
      requiredConfigPresent,
      healthStatus: health?.status || null,
      healthMessage: health?.message || null,
      modelCount: health?.modelCount ?? null,
      selectedModel: health?.selectedModel || null,
      selectedModelAvailable: health?.selectedModelAvailable ?? null
    },
    taskProfiles: runnable ? providerTaskProfiles(definition.label) : [],
    ...recipe
  });
}

function routerProviderForModuleId(id) {
  const map = {
    "provider-openai": "openai",
    "provider-anthropic": "anthropic",
    "provider-gemini": "gemini",
    "provider-openrouter": "openrouter",
    "provider-ollama": "ollama",
    "provider-minimax": "minimax",
    minimax: "minimax"
  };
  return map[id] || "";
}

function routerProviderLabel(id) {
  const labels = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    minimax: "MiniMax"
  };
  return labels[id] || "Provider Router";
}

async function providerRouterModule() {
  const status = await getRouterStatus();
  const health = status.nextProvider ? await checkProviderHealth(status.nextProvider.id) : null;
  const healthy = health?.status === "healthy";
  const configured = Boolean(status.nextProvider);
  return standardModule({
    id: "provider-router",
    label: "Provider Router",
    category: "runtime",
    type: "model_router",
    status: healthy ? "connected" : "ready_to_configure",
    configured: healthy,
    missing: healthy ? [] : configured ? [`Healthy ${status.nextProvider.label} route`] : ["OpenRouter or Ollama or MiniMax or OpenAI or Anthropic or Gemini provider"],
    capabilities: ["model-routing", "fallbacks", "dry-run-dispatch", "cost-hooks"],
    configKeys: ["OPENROUTER_API_KEY", "OLLAMA_HOST", "MINIMAX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
    actions: ["configure", "test", "run", "sessions", "logs"],
    publicSummary: healthy
      ? `Routes through healthy ${status.nextProvider.label} first, with configured fallback order.`
      : configured
        ? `${status.nextProvider.label} is configured but health is not verified.`
        : "Configure at least one user-owned/local provider before router dispatch.",
    stats: {
      fallbackOrder: status.fallbackOrder,
	      providers: status.providers.map((provider) => ({
	        id: provider.id,
	        status: provider.status,
	        model: provider.model
	      })),
	      configuredProvider: status.nextProvider?.id || null,
	      healthyProvider: healthy ? status.nextProvider?.id || null : null,
	      healthStatus: health?.status || null,
	      healthMessage: health?.message || null,
	      dryRunDefault: status.dryRunDefault
	    },
    installHint: "Connect Ollama, OpenRouter, MiniMax, OpenAI, Anthropic, or Gemini. Execution stays dry-run unless explicitly enabled.",
    taskProfiles: providerTaskProfiles("Provider Router")
  });
}

async function schedulerModule() {
  const scheduler = await getSchedulerOverview();
  return standardModule({
    id: "scheduler",
    label: "Scheduler",
    category: "runtime",
    type: "job_scheduler",
    status: scheduler.status,
    configured: scheduler.enabled,
    missing: scheduler.enabled ? [] : ["HERMES_AGENT_OS_SCHEDULER"],
    capabilities: ["cron", "workflow-runs", "self-module-tasks", "goal-loop-action", "approval-gates", "kanban-approval-cards", "retry", "pause-resume", "history"],
    actions: ["configure", "run", "logs"],
    publicSummary: scheduler.enabled
      ? `Scheduler is active with ${scheduler.summary.total} jobs, ${scheduler.summary.due} due, and ${scheduler.summary.pendingApproval || 0} pending approval.`
      : "Scheduler is disabled by HERMES_AGENT_OS_SCHEDULER=0.",
    stats: scheduler.summary,
    installHint: "Create jobs in the Scheduler workspace. Jobs can run workflows, create local module tasks, and place approval gates in Kanban."
  });
}

async function memoryModule() {
  const overview = await getMemoryOverview();
  return standardModule({
    id: "memory",
    label: "Memory",
    category: "runtime",
    type: "agent_memory",
    status: "connected",
    configured: true,
    missing: [],
    capabilities: ["semantic-memory", "episodic-memory", "procedural-memory", "search", "privacy", "import-export"],
    actions: ["open", "create", "search", "export", "logs"],
    publicSummary: `Local agent memory is active with ${overview.active} active memories across ${Object.keys(overview.byAgent || {}).length} agent scope${Object.keys(overview.byAgent || {}).length === 1 ? "" : "s"}.`,
    stats: overview,
    installHint: "No external database required. Hermes stores local memory under ~/.hermes-agent-os/memory and exports only redacted non-private memories by default."
  });
}

async function skillRegistryModule() {
  const summary = await getSkillRegistryOverview();
  return standardModule({
    id: "skill-registry",
    label: "Skill Registry",
    category: "runtime",
    type: "skill_registry",
    status: "connected",
    configured: true,
    missing: [],
    capabilities: ["skills", "install", "enable-disable", "required-keys", "signed-dependencies", "marketplace-updates", "publisher-policy", "tests", "logs", "sample-skills"],
    actions: ["open", "install", "configure", "update", "test", "logs"],
    publicSummary: `Skill Registry is active with ${summary.installed} installed skill${summary.installed === 1 ? "" : "s"}, ${summary.enabled} enabled, and ${summary.marketplaceUpdateItems || 0} marketplace update${summary.marketplaceUpdateItems === 1 ? "" : "s"}.`,
    stats: summary,
    installHint: "Install export-safe sample skills, configure their required user-owned keys, and enable only the skills this OS should expose."
  });
}

async function firecrawlBuilderModule(stored) {
  const builder = await getBuilderStatus();
  const configuredFrom = ["firecrawl-builder", "provider-convex", "provider-clerk", "provider-firecrawl"];
  const requiredKeys = [
    "NEXT_PUBLIC_CONVEX_URL",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_ISSUER_DOMAIN",
    "FIRECRAWL_API_KEY"
  ];
  const missing = requiredKeys.filter((key) =>
    !publicEnvConfigured(key) &&
    !configuredFrom.some((id) => Boolean(stored?.[id]?.[key]))
  );
  const configured = missing.length === 0;
  const supervisorState = builder.supervisor?.state || "stopped";
  return standardModule({
    id: "firecrawl-builder",
    label: "Firecrawl Agent Builder",
    category: "builder",
    type: "workflow_builder",
    status: configured ? "connected" : "ready_to_configure",
    configured,
    missing,
    capabilities: ["visual-workflows", "agent-nodes", "mcp-tools", "human-approval", "firecrawl", "process-supervisor", "boot-logs"],
    configKeys: ["NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "CLERK_JWT_ISSUER_DOMAIN", "FIRECRAWL_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "ARCADE_API_KEY"],
    actions: ["configure", "test", "run", "logs", "start", "stop"],
    stats: {
      sourcePresent: builder.sourcePresent,
      dependenciesInstalled: builder.dependenciesInstalled,
      live: builder.live,
      supervisor: builder.supervisor,
      firecrawlConfigured: builder.diagnostics?.firecrawlConfigured,
      llmConfigured: builder.diagnostics?.llmConfigured
    },
    installHint: "Run npm run builder:install or use the supervisor after configuring Convex/Clerk. Add Firecrawl and LLM keys for execution.",
    publicSummary: configured
      ? `Builder auth, storage, and Firecrawl execution are configured; supervisor is ${supervisorState}.`
      : "Design workflows after the upstream builder is configured; add Convex, Clerk, and Firecrawl keys before claiming builder execution."
  });
}

async function internalModule(definition) {
  if (isLocalSelfModule(definition.id)) {
    const local = await getLocalSelfModuleStatus(definition.id);
    const usageState = definition.id === "usage-credits" ? await getUsageState() : null;
    const videoWorker = definition.id === "video" ? await getVideoWorkerStatus() : null;
    return standardModule({
      ...definition,
      type: "local_app",
      status: "connected",
      configured: true,
      missing: [],
      actions: ["open", "create", "run", "logs"],
      stats: usageState ? { ...local.summary, budget: usageState.summary } : videoWorker ? { ...local.summary, worker: videoWorker } : local.summary,
      publicSummary: `${definition.publicSummary} ${local.itemCount} local item${local.itemCount === 1 ? "" : "s"} stored.`,
      installHint: definition.id === "video"
        ? "Install ffprobe/ffmpeg and optionally Whisper, or configure HERMES_FFPROBE_PATH, HERMES_FFMPEG_PATH, and HERMES_WHISPER_PATH."
        : "No external install required. This module stores user-owned data in the local Hermes Agent OS store."
    });
  }

  return standardModule({
    ...definition,
    type: "local_app",
    status: "ready_to_configure",
    configured: false,
    missing: ["module implementation"],
    actions: ["configure", "docs", "logs"],
    installHint: `${definition.label} is registered in the Agent OS module catalog. Implementation/configuration is still required before it can run real work.`
  });
}

export async function getModules({ includeParked = false, includeInternal = false } = {}) {
  await ensureRuntimeStore();
  const stored = await getStoredConnectionConfig();
  const cliModules = await Promise.all(CLI_MODULES.map((definition) => cliModule(definition, stored)));
  const hermes = await hermesModule(stored);
  const gateway = await gatewayModule(hermes);
  const eliza = await elizaRuntimeModule();
  const kernel = await kernelModule();
  const minimax = await minimaxModule(stored);
  const providerRouter = await providerRouterModule();
  const scheduler = await schedulerModule();
  const memory = await memoryModule();
  const skillRegistry = await skillRegistryModule();
  const firecrawlBuilder = await firecrawlBuilderModule(stored);
  const internalModules = await Promise.all(INTERNAL_MODULES.map(internalModule));
  const providerModules = await Promise.all(PROVIDER_MODULES.map((definition) => providerModule(definition, stored)));
  const modules = [
    cliModules.find((module) => module.id === "claude"),
    cliModules.find((module) => module.id === "openclaw"),
    cliModules.find((module) => module.id === "openclaude"),
    hermes,
    cliModules.find((module) => module.id === "gemini"),
    cliModules.find((module) => module.id === "codex"),
    cliModules.find((module) => module.id === "voice-control"),
    cliModules.find((module) => module.id === "opencode"),
    minimax,
    gateway,
    eliza,
    kernel,
    providerRouter,
    scheduler,
    memory,
    skillRegistry,
    firecrawlBuilder,
    ...providerModules,
    ...internalModules
  ].filter(Boolean);
  return modules.filter((module) => {
    if (!includeParked && PARKED_MODULE_IDS.has(module.id)) return false;
    if (!includeInternal && INTERNAL_ONLY_MODULE_IDS.has(module.id)) return false;
    return true;
  });
}

export async function getModule(id) {
  return (await getModules({ includeParked: true, includeInternal: true })).find((module) => module.id === id) || null;
}

export async function getOsStatus() {
  const modules = await getModules();
  const eliza = await getElizaStatus();
  const paths = runtimePaths();
  return {
    ok: true,
    service: "agent-os-runtime",
    version: RUNTIME_VERSION,
    mode: process.env.NODE_ENV || "development",
    runtimeFoundation: eliza.ok
      ? `elizaOS core ${eliza.version} loaded`
      : "elizaOS core not loaded",
    builderFoundation: "firecrawl-open-agent-builder-compatible workflow model",
    generatedAt: now(),
    host: os.hostname(),
    store: {
      root: publicRuntimePath(""),
      config: publicRuntimePath("config"),
      workflows: publicRuntimePath("workflows"),
      runs: publicRuntimePath("runs"),
      logs: publicRuntimePath("logs"),
      memory: publicRuntimePath("memory"),
      exports: publicRuntimePath("exports")
    },
    publicUrl: process.env.HERMES_AGENT_HUB_PUBLIC_URL || null,
    githubRepo: process.env.HERMES_AGENT_HUB_GITHUB_REPO || null,
    moduleCount: modules.length,
    connectedCount: modules.filter((module) => module.status === "connected").length,
    pathsReady: sanitizeObject(paths),
    elizaOS: eliza
  };
}

export async function getOsAudit() {
  const modules = await getModules();
  const items = modules.map((module) => {
    const connected = module.status === "connected";
    const severity = connected ? "ok" : module.status === "missing_dependency" || module.status === "error" ? "action_required" : "setup";
    const fix = connected
      ? "No action required."
      : module.installCommand
        ? `Install or configure ${module.label}. Suggested command: ${module.installCommand || "manual install"}.`
        : module.missing?.length
          ? `Configure ${module.missing.join(", ")}.`
          : module.configKeys?.length
            ? `Configure ${module.configKeys.join(", ")}.`
          : module.installHint || "Open this module and complete setup.";
    return {
      id: module.id,
      label: module.label,
      category: module.category,
      type: module.type,
      status: module.status,
      configured: module.configured,
      missing: module.missing,
      severity,
      fix,
      docsUrl: module.docsUrl || "",
      actions: module.actions
    };
  });
  return {
    generatedAt: now(),
    summary: {
      total: items.length,
      ok: items.filter((item) => item.severity === "ok").length,
      setup: items.filter((item) => item.severity === "setup").length,
      actionRequired: items.filter((item) => item.severity === "action_required").length
    },
    items
  };
}

export async function testModule(id) {
  const module = await getModule(id);
  if (!module) {
    return { ok: false, id, message: `No module registered for ${id}.`, details: null };
  }
  await appendModuleLog(id, {
    level: module.status === "connected" ? "info" : "warn",
    message: "Module health checked",
    details: {
      status: module.status,
      configured: module.configured,
      missing: module.missing
    }
  });
  return {
    ok: module.status === "connected",
    id,
    message: module.publicSummary,
    checkedAt: now(),
    details: module
  };
}

export async function runModule(id, input = {}) {
  const module = await getModule(id);
  if (!module) {
    return { ok: false, mode: "not_found", reply: `No module registered for ${id}.` };
  }
  const execEnabled = await isExecutionEnabled();
  if (id === "provider-router") {
    return runProviderBackedModule(id, module, input, input.provider || "");
  }
  if (id === "hermes") {
    return runHermesControl(module, input);
  }
  if (id === "gateway") {
    return runGatewayControl(module, input);
  }
  if (id === "voice-control") {
    const { runWorkflow } = await import("./workflows.js");
    const result = await runVoiceCommand(input, {
      runWorkflow,
      runModule: async (moduleId, payload) => {
        if (moduleId === "voice-control") {
          return { ok: false, mode: "blocked", reply: "Voice Control cannot recursively call itself." };
        }
        return runModule(moduleId, payload);
      }
    });
    const handoff = await recordAgentRunHandoff("voice-control", module, input, result.proof, result.reply, null);
    return {
      ok: result.ok,
      mode: result.mode,
      reply: result.reply,
      module,
      voice: {
        runId: result.runId,
        transcript: result.transcript,
        command: result.command,
        plan: result.plan,
        actions: result.actions,
        tools: result.tools
      },
      proof: handoff.proof,
      handoff: handoff.handoff || null
    };
  }
  const forcedProvider = routerProviderForModuleId(id);
  if (forcedProvider) {
    return runProviderBackedModule(id, module, input, forcedProvider);
  }
  if (id === "goals" && input.goalId) {
    return runGoalLoop(input.goalId, input);
  }
  if (id === "seo" && input.briefId) {
    const action = String(input.action || input.operation || input.tool || "audit").toLowerCase();
    if (["discover", "discovery", "competitor_discovery", "competitors"].includes(action)) {
      return runSeoDiscovery(input.briefId, input);
    }
    if (["rank", "rank_snapshot", "rank-tracking", "rank_tracking"].includes(action)) {
      return runSeoRankSnapshot(input.briefId, input);
    }
    return runSeoAudit(input.briefId, input);
  }
  if (id === "video" && (input.jobId || input.videoJobId || input.itemId)) {
    return runVideoJob(input.jobId || input.videoJobId || input.itemId, input);
  }
  const kanbanCreateRequested = id === "kanban" && (
    input.workflowId ||
    input.schedulerJobId ||
    input.title ||
    ["create_card", "create_task", "task", "card"].includes(String(input.tool || "").toLowerCase())
  );
  if (kanbanCreateRequested) {
    const node = input.node && typeof input.node === "object" ? input.node : {};
    const title = input.title || node.title || node.label || input.message || input.prompt || "Workflow Kanban task";
    const sourceType = input.sourceType || (input.workflowId ? "workflow_task" : "manual");
    const sourceId = input.sourceId || [sourceType, input.workflowId, input.runId, input.nodeId || node.id].filter(Boolean).join(":");
    const result = await upsertKanbanCard({
      title,
      column: input.column || node.column || "todo",
      status: input.status || node.status || "open",
      notes: input.notes || node.notes || input.message || input.prompt || "",
      priority: input.priority || node.priority || "",
      assignee: input.assignee || node.assignee || "",
      dueAt: input.dueAt || node.dueAt || null,
      sourceType,
      sourceId,
      workflowId: input.workflowId || "",
      runId: input.runId || "",
      nodeId: input.nodeId || node.id || "",
      linkedModule: input.linkedModule || node.linkedModule || "",
      linkedItemId: input.linkedItemId || node.linkedItemId || ""
    });
    return {
      ok: true,
      mode: "local_app",
      reply: `Kanban card ${result.created ? "created" : "updated"}.`,
      card: result.card,
      state: result.state
    };
  }
  if (module.type === "local_app") {
    const proof = moduleRunProof(id, module, input, {
      mode: "local_app",
      execEnabled,
      dryRun: true,
      nextStep: "Open this control room to create, inspect, or run local records.",
      evidence: ["local Agent OS store", `GET /api/modules/${id}/logs`]
    });
    const handoff = await recordAgentRunHandoff(id, module, input, proof, `${module.label} is backed by the local Agent OS store.`);
    await appendModuleLog(id, {
      message: "Local module run requested",
      details: {
        mode: "local_app",
        status: module.status,
        inputKeys: Object.keys(input || {}),
        proof: handoff.proof
      }
    });
    return {
      ok: module.status === "connected",
      mode: "local_app",
      reply: `${module.label} is backed by the local Agent OS store. Open the control room to create and review records.`,
      module,
      proof: handoff.proof,
      handoff: handoff.handoff || null
    };
  }
  const explicitExecution = input.dryRun === false;
  if (module.type !== "cli" || !execEnabled || !explicitExecution) {
    let plannedExecution = null;
    const evidence = [
      `module status: ${module.status}`,
      `execution gate: ${execEnabled ? "enabled" : "disabled"}`,
      `explicit run request: ${explicitExecution ? "yes" : "no"}`
    ];
    if (module.type === "cli") {
      const stored = await getStoredConnectionConfig();
      const definition = cliDefinition(id);
      const resolved = definition ? await resolveCliCommand(definition, stored) : null;
      if (definition && resolved?.commandPath) {
        const invocation = await buildCliInvocation(definition, stored, input, resolved.commandPath, resolved);
        if (invocation.ok) {
          plannedExecution = publicInvocation(invocation);
          evidence.push(`command preview: ${plannedExecution.commandPreview}`);
          evidence.push(`workspace policy: ${plannedExecution.workspacePolicy}`);
          evidence.push(`timeout: ${plannedExecution.timeoutMs}ms`);
        } else {
          evidence.push(`command blocked: ${invocation.reason}`);
        }
      } else {
        evidence.push("CLI path resolution failed");
      }
    }
    const proof = moduleRunProof(id, module, input, {
      mode: "dry_run",
      execEnabled,
      dryRun: true,
      nextStep: module.type === "cli"
        ? "Enable the trusted execution gate and send dryRun:false from a trusted local machine."
        : "Use the module-specific control room or provider router for execution.",
      evidence
    });
    const handoff = await recordAgentRunHandoff(id, module, input, proof, `${module.label} is ${module.status}.`);
    await appendModuleLog(id, {
      message: "Module dry run requested",
      details: {
        mode: "dry_run",
        status: module.status,
        execEnabled,
        explicitExecution,
        plannedExecution,
        proof: handoff.proof
      }
    });
    return {
      ok: true,
      mode: "dry_run",
      reply: `${module.label} is ${module.status}. Execution requires the trusted execution gate and dryRun:false on a trusted local machine.`,
      module,
      plannedExecution,
      proof: handoff.proof,
      handoff: handoff.handoff || null
    };
  }
  const stored = await getStoredConnectionConfig();
  const definition = cliDefinition(id);
  const resolved = definition ? await resolveCliCommand(definition, stored) : { commandPath: await which(id === "claude" ? "claude" : id) };
  const commandPath = resolved.commandPath;
  if (!commandPath) {
    const proof = moduleRunProof(id, module, input, {
      mode: "missing_dependency",
      execEnabled,
      dryRun: false,
      nextStep: `Install ${module.label} CLI or configure its CLI path.`,
      evidence: ["CLI path resolution failed"]
    });
    const handoff = await recordAgentRunHandoff(id, module, input, proof, `${module.label} CLI is not installed or not on PATH.`);
    await appendModuleLog(id, {
      level: "error",
      message: "Module execution failed: missing CLI",
      details: { command: id === "claude" ? "claude" : id, proof: handoff.proof }
    });
    return {
      ok: false,
      mode: "missing_dependency",
      reply: `${module.label} CLI is not installed or not on PATH.`,
      module,
      proof: handoff.proof,
      handoff: handoff.handoff || null
    };
  }
  const invocation = await buildCliInvocation(definition || { id, command: id, label: module.label }, stored, input, commandPath, resolved);
  if (!invocation.ok) {
    const proof = moduleRunProof(id, module, input, {
      mode: invocation.mode,
      execEnabled,
      dryRun: false,
      nextStep: "Configure an allowed workspace path before executing this agent.",
      evidence: [invocation.reason]
    });
    const handoff = await recordAgentRunHandoff(id, module, input, proof, invocation.reason);
    await appendModuleLog(id, {
      level: "warn",
      message: "Module execution blocked by workspace policy",
      details: {
        mode: invocation.mode,
        reason: invocation.reason,
        proof: handoff.proof
      }
    });
    return {
      ok: false,
      mode: invocation.mode,
      reply: invocation.reason,
      module,
      proof: handoff.proof,
      handoff: handoff.handoff || null
    };
  }
  const startedAt = now();
  const started = Date.now();
  const result = await runCommand(commandPath, invocation.args, invocation.timeoutMs, { cwd: invocation.workspace.cwd || undefined });
  const completedAt = now();
  const stdout = sanitizeCliOutput(result.stdout, invocation);
  const stderr = sanitizeCliOutput(result.stderr, invocation);
  const execution = {
    ...publicInvocation(invocation),
    startedAt,
    completedAt,
    durationMs: Date.now() - started,
    exitCode: result.code,
    signal: result.signal,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(result.stdout || ""),
    stderrBytes: Buffer.byteLength(result.stderr || ""),
    outputTruncated: stdout !== redactText(result.stdout || "", [invocation.commandPath, invocation.workspace?.cwd]) ||
      stderr !== redactText(result.stderr || "", [invocation.commandPath, invocation.workspace?.cwd])
  };
  await appendModuleLog(id, {
    level: result.ok ? "info" : "error",
    message: result.ok ? "Module command executed" : "Module command failed",
    details: {
      mode: "executed",
      execution,
      code: result.code,
      signal: result.signal,
      inputLength: invocation.messageLength
    }
  });
  const proof = moduleRunProof(id, module, input, {
    runId: invocation.runId,
    mode: "executed",
    execEnabled,
    dryRun: false,
    nextStep: result.ok ? "Review stdout/stderr and continue from the latest module log." : "Review stderr and module logs before retrying.",
    evidence: [
      `adapter: ${execution.adapterId}`,
      `exit code: ${execution.exitCode ?? "none"}`,
      `duration: ${execution.durationMs}ms`
    ]
  });
  const handoff = await recordAgentRunHandoff(id, module, input, proof, stdout || stderr || "Command completed with no output.", execution);
  return {
    ok: result.ok,
    mode: "executed",
    reply: stdout || stderr || "Command completed with no output.",
    module,
    execution,
    proof: handoff.proof,
    handoff: handoff.handoff || null
  };
}

export async function getModuleLogs(id) {
  await ensureRuntimeStore();
  return readModuleLogs(id);
}

export async function getModuleRuns(id) {
  await ensureRuntimeStore();
  return readModuleRuns(id);
}

export async function getAgentRuns({ limit = 30 } = {}) {
  await ensureRuntimeStore();
  const modules = await getModules();
  const runsByModule = await Promise.all(
    modules.map(async (module) => {
      const history = await readModuleRuns(module.id, { limit });
      return history.runs.map((run) => sanitizeObject({
        ...run,
        moduleCategory: module.category,
        moduleType: module.type,
        moduleStatus: module.status,
        moduleConfigured: module.configured
      }));
    })
  );
  const runs = runsByModule
    .flat()
    .sort((a, b) => String(b.loggedAt || b.requestedAt || "").localeCompare(String(a.loggedAt || a.requestedAt || "")))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)));
  return sanitizeObject({
    id: "agent-runs",
    generatedAt: now(),
    summary: {
      total: runs.length,
      executed: runs.filter((run) => run.mode === "executed").length,
      dryRun: runs.filter((run) => run.dryRun).length,
      blocked: runs.filter((run) => run.handoff?.status === "blocked" || run.mode === "ready_to_configure" || run.mode === "missing_dependency").length,
      withMemory: runs.filter((run) => Boolean(run.handoff?.memoryId)).length,
      withKanban: runs.filter((run) => Boolean(run.handoff?.kanbanCardId)).length,
      replayable: runs.filter((run) => Boolean(run.replay?.available)).length
    },
    runs
  });
}

export async function getModuleSessions(id) {
  await ensureRuntimeStore();
  const state = await readModuleSessionState(id);
  return {
    id,
    sessions: state.sessions.map(publicSession)
  };
}

export async function getModuleSession(id, sessionId) {
  const state = await getModuleSessions(id);
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    const error = new Error("module session not found");
    error.status = 404;
    throw error;
  }
  return {
    id,
    session
  };
}

export async function startModuleSession(id, input = {}) {
  const module = await getModule(id);
  if (!module) {
    return { ok: false, mode: "not_found", reply: `No module registered for ${id}.` };
  }
  if (isProviderSessionModule(id, module)) {
    return startProviderModuleSession(id, module, input);
  }
  if (id === "hermes") {
    return startHermesModuleSession(id, module, input);
  }
  const definition = cliDefinition(id);
  if (!definition || module.type !== "cli") {
    return {
      ok: false,
      mode: "unsupported",
      reply: `${module.label} does not expose a local CLI session supervisor yet.`,
      session: null
    };
  }

  const execEnabled = await isExecutionEnabled();
  const explicitExecution = input.dryRun === false || input.execute === true;
  const stored = await getStoredConnectionConfig();
  const resolved = await resolveCliCommand(definition, stored);
  const commandPath = resolved.commandPath;
  const timeoutInput = input.timeoutMs || getConfiguredValue(stored, definition.id, `${cliPrefix(definition)}_SESSION_TIMEOUT_MS`) || 300000;
  const invocation = commandPath
    ? await buildCliInvocation(definition, stored, { ...input, timeoutMs: timeoutInput }, commandPath, resolved)
    : null;
  const sessionId = moduleRunId("sess");
  const baseSession = {
    sessionId,
    moduleId: id,
    moduleLabel: module.label,
    status: "prepared",
    mode: "dry_run",
    dryRun: true,
    execEnabled,
    explicitExecution,
    command: definition.command,
    commandPreview: invocation?.ok ? publicInvocation(invocation).commandPreview : `${definition.command} <unresolved>`,
    adapterId: `${definition.id}-session`,
    argsCount: invocation?.ok ? invocation.args.length : 0,
    promptChars: String(input.message || input.prompt || "").length,
    timeoutMs: invocation?.ok ? invocation.timeoutMs : numericTimeout(timeoutInput),
    pid: null,
    workspace: invocation?.ok
      ? {
          configured: Boolean(invocation.workspace?.configured),
          used: Boolean(invocation.workspace?.cwd)
        }
      : { configured: false, used: false },
    startedAt: now(),
    updatedAt: now(),
    completedAt: null,
    exitCode: null,
    signal: null,
    stopRequested: false,
    stdoutTail: "",
    stderrTail: "",
    outputTruncated: false,
    nextStep: "Enable the trusted execution gate and send dryRun:false to start a real local CLI session.",
    evidence: [
      `module status: ${module.status}`,
      `execution gate: ${execEnabled ? "enabled" : "disabled"}`,
      `explicit session request: ${explicitExecution ? "yes" : "no"}`,
      `command preview: ${invocation?.ok ? publicInvocation(invocation).commandPreview : `${definition.command} <unresolved>`}`
    ]
  };

  if (!execEnabled || !explicitExecution) {
    const state = await readModuleSessionState(id);
    const session = publicSession(baseSession);
    await writeModuleSessionState(id, { id, sessions: [session, ...state.sessions] });
    await appendModuleLog(id, {
      message: "Module session start prepared",
      details: {
        mode: "dry_run",
        session
      }
    });
    return {
      ok: true,
      mode: "dry_run",
      reply: `${module.label} session prepared. Real start requires the trusted execution gate and dryRun:false.`,
      session
    };
  }

  if (!commandPath) {
    const session = publicSession({
      ...baseSession,
      status: "missing_dependency",
      mode: "missing_dependency",
      dryRun: false,
      nextStep: `Install ${module.label} CLI or configure its CLI path.`,
      evidence: ["CLI path resolution failed"]
    });
    const state = await readModuleSessionState(id);
    await writeModuleSessionState(id, { id, sessions: [session, ...state.sessions] });
    await appendModuleLog(id, {
      level: "error",
      message: "Module session start failed: missing CLI",
      details: { session }
    });
    return {
      ok: false,
      mode: "missing_dependency",
      reply: `${module.label} CLI is not installed or not on PATH.`,
      session
    };
  }

  if (!invocation?.ok) {
    const session = publicSession({
      ...baseSession,
      status: "blocked",
      mode: invocation?.mode || "policy_violation",
      dryRun: false,
      nextStep: "Configure an allowed workspace path before starting this agent session.",
      evidence: [invocation?.reason || "Session invocation failed."]
    });
    const state = await readModuleSessionState(id);
    await writeModuleSessionState(id, { id, sessions: [session, ...state.sessions] });
    await appendModuleLog(id, {
      level: "warn",
      message: "Module session start blocked",
      details: { session }
    });
    return {
      ok: false,
      mode: session.mode,
      reply: session.evidence[0],
      session
    };
  }

  const child = spawn(commandPath, invocation.args, {
    cwd: invocation.workspace.cwd || undefined,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const startedAt = now();
  const runningSession = publicSession({
    ...baseSession,
    status: "running",
    mode: "executed",
    dryRun: false,
    pid: child.pid || null,
    startedAt,
    updatedAt: startedAt,
    nextStep: "Session is running. Stop it from the dashboard or inspect stdout/stderr tails.",
    evidence: [
      `adapter: ${definition.id}-session`,
      `args: ${invocation.args.length}`,
      `timeout: ${invocation.timeoutMs}ms`
    ]
  });
  const state = await readModuleSessionState(id);
  await writeModuleSessionState(id, { id, sessions: [runningSession, ...state.sessions] });
  ACTIVE_MODULE_SESSIONS.set(`${id}:${sessionId}`, { child, commandPath, cwd: invocation.workspace.cwd || "", timeout: null });

  const timeout = setTimeout(() => {
    if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 1000).unref?.();
  }, invocation.timeoutMs);
  timeout.unref?.();
  ACTIVE_MODULE_SESSIONS.get(`${id}:${sessionId}`).timeout = timeout;

  child.stdout?.on("data", (chunk) => {
    const text = sanitizeSessionChunk(String(chunk), invocation);
    void updateModuleSessionRecord(id, sessionId, (session) => ({
      stdoutTail: appendSessionOutput(session.stdoutTail, text),
      outputTruncated: Boolean(session.outputTruncated || `${session.stdoutTail || ""}${text}`.length > MAX_SESSION_OUTPUT_CHARS)
    })).catch(() => {});
  });
  child.stderr?.on("data", (chunk) => {
    const text = sanitizeSessionChunk(String(chunk), invocation);
    void updateModuleSessionRecord(id, sessionId, (session) => ({
      stderrTail: appendSessionOutput(session.stderrTail, text),
      outputTruncated: Boolean(session.outputTruncated || `${session.stderrTail || ""}${text}`.length > MAX_SESSION_OUTPUT_CHARS)
    })).catch(() => {});
  });
  child.on("error", (error) => {
    void updateModuleSessionRecord(id, sessionId, (session) => ({
      status: "error",
      completedAt: now(),
      stderrTail: appendSessionOutput(session.stderrTail, redactText(error?.message || "session failed", [commandPath, invocation.workspace?.cwd])),
      nextStep: "Review stderr and connection settings before starting another session."
    })).catch(() => {});
  });
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    ACTIVE_MODULE_SESSIONS.delete(`${id}:${sessionId}`);
    void updateModuleSessionRecord(id, sessionId, (session) => ({
      status: session.stopRequested ? "stopped" : code === 0 ? "completed" : "error",
      completedAt: now(),
      exitCode: code,
      signal,
      nextStep: session.stopRequested
        ? "Session was stopped from the dashboard."
        : code === 0
          ? "Session completed. Inspect the output tail and recent logs."
          : "Session exited with an error. Inspect stderr and retry after fixing setup."
    })).catch(() => {});
  });

  await appendModuleLog(id, {
    message: "Module session started",
    details: {
      session: runningSession
    }
  });
  return {
    ok: true,
    mode: "executed",
    reply: `${module.label} session started.`,
    session: runningSession
  };
}

export async function stopModuleSession(id, sessionId) {
  const state = await readModuleSessionState(id);
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    const error = new Error("module session not found");
    error.status = 404;
    throw error;
  }
  const active = ACTIVE_MODULE_SESSIONS.get(`${id}:${sessionId}`);
  if (active?.child && !active.child.killed) {
    await updateModuleSessionRecord(id, sessionId, () => ({
      status: "stopping",
      stopRequested: true,
      nextStep: "Stop requested. Waiting for the local CLI process to exit."
    }));
    active.child.kill("SIGTERM");
    await appendModuleLog(id, {
      message: "Module session stop requested",
      details: { sessionId }
    });
    return getModuleSession(id, sessionId);
  }
  const stopped = await updateModuleSessionRecord(id, sessionId, (current) => ({
    status: ["running", "stopping"].includes(current.status) ? "stopped" : current.status,
    stopRequested: true,
    completedAt: current.completedAt || now(),
    nextStep: "No live process was attached to this session."
  }));
  return {
    id,
    session: publicSession(stopped)
  };
}

export async function messageModuleSession(id, sessionId, input = {}) {
  const module = await getModule(id);
  if (!module) {
    return { ok: false, mode: "not_found", reply: `No module registered for ${id}.`, session: null };
  }
  if (id === "hermes") {
    return messageHermesModuleSession(id, module, sessionId, input);
  }
  if (!isProviderSessionModule(id, module)) {
    return {
      ok: false,
      mode: "unsupported",
      reply: `${module.label} sessions do not support routed messages yet.`,
      session: null
    };
  }
  const state = await readModuleSessionState(id);
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    const error = new Error("module session not found");
    error.status = 404;
    throw error;
  }
  const { prompt, routedPrompt } = providerSessionPrompt(session, input);
  const forcedProvider = providerSessionProvider(id, input) || session.provider || "";
  const result = await runProviderBackedModule(id, module, {
    ...input,
    message: routedPrompt,
    prompt: routedPrompt,
    operation: "provider_session_message",
    sourceSessionId: sessionId
  }, forcedProvider);
  const timestamp = now();
  const assistantText = result.reply || result.router?.message || "";
  const execEnabled = await isExecutionEnabled();
  const updated = await updateModuleSessionRecord(id, sessionId, (current) => {
    const messages = [
      ...(Array.isArray(current.messages) ? current.messages : []),
      { role: "user", content: prompt, at: timestamp, chars: prompt.length },
      { role: "assistant", content: assistantText, at: timestamp, chars: assistantText.length, mode: result.mode }
    ].slice(-40);
    return {
      status: result.ok ? "open" : result.mode || "blocked",
      mode: result.mode || "router",
      dryRun: result.mode !== "executed",
      execEnabled,
      explicitExecution: input.dryRun === false,
      provider: result.provider || forcedProvider || current.provider || null,
      model: result.model || current.model || null,
      promptChars: prompt.length,
      messageCount: messages.length,
      lastMessageAt: timestamp,
      messages,
      stdoutTail: appendSessionOutput(current.stdoutTail, `\n[${timestamp}] ${assistantText}`),
      stderrTail: result.ok ? current.stderrTail || "" : appendSessionOutput(current.stderrTail, `\n[${timestamp}] ${assistantText}`),
      nextStep: result.ok
        ? "Provider session message routed. Continue the conversation or inspect Usage Credits and run proof."
        : "Provider session message was blocked or failed. Configure the provider, model, budget, or execution gate.",
      evidence: [
        `provider: ${result.provider || forcedProvider || "none"}`,
        `model: ${result.model || "not selected"}`,
        `mode: ${result.mode || "router"}`
      ]
    };
  });
  const publicUpdated = publicSession(updated);
  await appendModuleLog(id, {
    level: result.ok ? "info" : "warn",
    message: result.ok ? "Provider session message routed" : "Provider session message blocked",
    details: {
      session: publicUpdated,
      provider: publicUpdated.provider,
      model: publicUpdated.model,
      mode: result.mode
    }
  });
  return {
    ok: result.ok,
    mode: result.mode,
    reply: result.reply,
    router: result.router,
    proof: result.proof,
    handoff: result.handoff || null,
    session: publicUpdated
  };
}

export function modulesToLegacySnapshot(status, modules) {
  const integrations = modules.map((module) => ({
    ...module,
    connection: module.publicSummary,
    type: module.type || module.category
  }));
  return {
    generatedAt: status.generatedAt,
    host: status.host,
    mode: status.mode,
    publicUrl: status.publicUrl,
    githubRepo: status.githubRepo,
    integrations,
    directories: [
      { label: "config", path: publicRuntimePath("config"), exists: true },
      { label: "workflows", path: publicRuntimePath("workflows"), exists: true },
      { label: "runs", path: publicRuntimePath("runs"), exists: true }
    ],
    flow: ["Firecrawl Builder", "Module Registry", "Model Routing", "Workflows", "Local Store", "Export Audit"]
  };
}
