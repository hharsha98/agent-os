import { commandVersion, redactText, runCommand, which } from "./safety.js";
import { getCodexApiStatus } from "./codex-api.js";
import { getExecutionGateStatus } from "./execution-gate.js";

const AGENT_CATALOG = [
  {
    id: "cursor",
    name: "Cursor Agent",
    eyebrow: "IDE CODING AGENT",
    binaries: ["agent"],
    model: "Cursor model picker",
    chatMode: "not_wired",
    hint: "The `agent` CLI can be on PATH without this dashboard routing chat to it."
  },
  {
    id: "claude",
    name: "Claude Code",
    eyebrow: "ANTHROPIC CODING AGENT",
    binaries: ["claude"],
    model: "Claude subscription / CLI",
    chatMode: "dry_run",
    hint: "Unified Chat calls the module API with dryRun: true unless you later enable live execution."
  },
  {
    id: "codex",
    name: "Codex",
    eyebrow: "GOAL + WORKFLOW BRAIN",
    binaries: ["codex"],
    model: "Codex API or CLI",
    chatMode: "preview",
    hint: "Chat uses the Codex API preview when an OpenAI key is saved locally. The standalone `codex` CLI is optional."
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    eyebrow: "LOCAL TOOL + MEMORY AGENT",
    binaries: ["hermes"],
    model: "Hermes profile default",
    chatMode: "dry_run",
    hint: "Unified Chat dry-runs the Hermes module API. Gateway and tool runs stay behind the execution gate."
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    eyebrow: "AUTOMATION ENGINE",
    binaries: ["openclaw"],
    model: "OpenClaw runtime",
    chatMode: "not_in_unified_chat",
    hint: "Not in Unified Chat. Workflow studio can target OpenClaw once the CLI is installed."
  }
];

function firstLine(value, fallback = "") {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || fallback;
}

function publicCommand(command) {
  return String(command || "").replace(/^.*[/\\]/, "") || "unknown";
}

export function classifyChat({ id, cliFound = false, codexApiConfigured = false } = {}) {
  if (id === "cursor") {
    return {
      mode: "not_wired",
      routed: false,
      label: cliFound ? "CLI found · chat not wired" : "Not installed",
      detail: cliFound
        ? "Cursor Agent is on PATH. This dashboard does not send Unified Chat to it."
        : "Cursor Agent CLI (`agent`) was not found. Install is optional and not started from this page."
    };
  }
  if (id === "openclaw") {
    return {
      mode: "not_in_unified_chat",
      routed: false,
      label: cliFound ? "CLI found · not in Chat" : "Not installed",
      detail: cliFound
        ? "OpenClaw is on PATH. Unified Chat does not include it; use Workflow studio after you enable execution."
        : "OpenClaw CLI was not found. Missing stays missing."
    };
  }
  if (id === "codex") {
    if (codexApiConfigured) {
      return {
        mode: "preview",
        routed: true,
        label: "API preview",
        detail: "Unified Chat can call the local Codex API preview. That is not a live tool-using agent run."
      };
    }
    if (cliFound) {
      return {
        mode: "dry_run",
        routed: true,
        label: "Dry run",
        detail: "Standalone Codex CLI is present. Unified Chat still dry-runs until a Codex API key is saved."
      };
    }
    return {
      mode: "unavailable",
      routed: false,
      label: "Not configured",
      detail: "Add an OpenAI API key on AI APIs, or install the `codex` CLI. Missing stays missing."
    };
  }
  if (!cliFound) {
    return {
      mode: "unavailable",
      routed: false,
      label: "Not installed",
      detail: `${id} CLI was not found on PATH. This dashboard will not mark it connected.`
    };
  }
  return {
    mode: "dry_run",
    routed: true,
    label: "Dry run",
    detail: "Unified Chat / module runs return a plan. Live execution stays off until you enable the gate."
  };
}

export function classifyStatus({ chat, cliFound = false, codexApiConfigured = false } = {}) {
  if (chat?.mode === "preview") return "preview";
  if (chat?.mode === "dry_run") return "dry_run";
  if ((chat?.mode === "not_wired" || chat?.mode === "not_in_unified_chat") && cliFound) return "cli_present";
  if (codexApiConfigured) return "ready_to_configure";
  if (!cliFound) return "not_installed";
  return "ready_to_configure";
}

export function buildAgentRecord(input = {}) {
  const {
    id,
    name,
    eyebrow,
    hint,
    cli = { found: false, command: id, version: null },
    chat,
    model,
    executionEnabled = false,
    extraSummary = ""
  } = input;
  const cliFound = Boolean(cli.found);
  const chatState = chat || classifyChat({ id, cliFound });
  const status = classifyStatus({ chat: chatState, cliFound, codexApiConfigured: chatState.mode === "preview" });
  const liveLabel = executionEnabled ? "Live allowed" : "Off";
  const summary = extraSummary || chatState.detail;
  return {
    id,
    name,
    eyebrow,
    status,
    available: cliFound || chatState.mode === "preview",
    version: cli.version || (cliFound ? publicCommand(cli.command) : "Not installed"),
    model: model || "Local default",
    connection: cliFound ? `${publicCommand(cli.command)} CLI` : chatState.mode === "preview" ? "Codex API (local key)" : "Not on PATH",
    summary,
    hint: hint || "",
    cli: {
      found: cliFound,
      command: publicCommand(cli.command),
      version: cli.version || null
    },
    chat: chatState,
    liveExecution: {
      allowed: Boolean(executionEnabled) && chatState.routed,
      label: chatState.routed ? liveLabel : "Not applicable",
      detail: executionEnabled
        ? "Execution gate is on. Unified Chat still prefers dry-run unless a later screen opts in."
        : "HERMES_AGENT_OS_ENABLE_EXEC stays 0 in the default local v1."
    },
    nextAction: nextActionFor({ id, cliFound, chat: chatState })
  };
}

function nextActionFor({ id, cliFound, chat }) {
  if (id === "cursor") {
    return cliFound ? "Use Cursor in the IDE. Do not expect Unified Chat to drive it." : "Optional: install the Cursor Agent CLI (`agent`).";
  }
  if (id === "openclaw") {
    return cliFound ? "Use Workflow studio if you want OpenClaw graphs. Chat does not route to it." : "Optional: install the OpenClaw CLI, then refresh Mission Control.";
  }
  if (id === "codex") {
    if (chat.mode === "preview") return "Open Unified Chat and send a preview message. Watch the API preview badge.";
    return "Save an OpenAI API key on AI APIs, or install the `codex` CLI.";
  }
  if (!cliFound) return `Optional: install the ${id} CLI, then refresh Mission Control.`;
  return "Open Unified Chat and send a dry-run. Live tools stay gated.";
}

export function summarizeAgents(agents, executionGate, gateway) {
  const list = agents || [];
  const cliFound = list.filter((agent) => agent.cli?.found).length;
  const chatDryRun = list.filter((agent) => agent.chat?.mode === "dry_run").length;
  const chatPreview = list.filter((agent) => agent.chat?.mode === "preview").length;
  const notWired = list.filter((agent) => agent.chat?.mode === "not_wired").length;
  const notInstalled = list.filter((agent) => agent.status === "not_installed").length;
  const connectedLegacy = list.filter((agent) => agent.status === "connected").length;
  return {
    total: list.length,
    cliFound,
    chatDryRun,
    chatPreview,
    notWired,
    notInstalled,
    dashboardChatReady: chatDryRun + chatPreview,
    connected: connectedLegacy,
    executionEnabled: Boolean(executionGate?.enabled),
    dryRunDefault: executionGate?.dryRunDefault !== false,
    gateway
  };
}

export async function probeCli(binaries = []) {
  for (const name of binaries) {
    const located = await which(name);
    if (!located) continue;
    const rawVersion = await commandVersion(located);
    return {
      found: true,
      command: name,
      version: firstLine(redactText(rawVersion || ""), name)
    };
  }
  return { found: false, command: binaries[0] || "unknown", version: null };
}

async function probeHermesModel(cliFound) {
  if (!cliFound) return null;
  const provider = await runCommand("hermes", ["config", "get", "model.provider"], 4000);
  const model = await runCommand("hermes", ["config", "get", "model.default"], 4000);
  const value = [firstLine(provider.stdout), firstLine(model.stdout)].filter(Boolean).join("/");
  return value ? redactText(value) : null;
}

async function probeGateway() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch("http://127.0.0.1:3001/api/ping", { signal: controller.signal });
    clearTimeout(timeout);
    return {
      ok: response.ok,
      url: "http://127.0.0.1:3001",
      optional: true,
      summary: response.ok
        ? "Optional local OpenAI-compatible gateway is reachable on port 3001."
        : `Optional gateway on port 3001 returned HTTP ${response.status}.`
    };
  } catch {
    return {
      ok: false,
      url: "http://127.0.0.1:3001",
      optional: true,
      summary: "Optional local gateway on port 3001 is not running. Agent OS does not require it."
    };
  }
}

export async function getLocalAgentDashboardStatus({
  probe = probeCli,
  codexApi,
  executionGate,
  gateway
} = {}) {
  const [cursor, claude, hermes, codexCli, openclaw, resolvedCodex, resolvedGate, resolvedGateway] = await Promise.all([
    probe(["agent"]),
    probe(["claude"]),
    probe(["hermes"]),
    probe(["codex"]),
    probe(["openclaw"]),
    Promise.resolve(codexApi || getCodexApiStatus().catch(() => ({ configured: false, model: null, publicSummary: "Codex API status unavailable." }))),
    Promise.resolve(executionGate || getExecutionGateStatus()),
    Promise.resolve(gateway || probeGateway())
  ]);

  const liveProbes = probe === probeCli;
  const hermesModel = liveProbes ? await probeHermesModel(hermes.found) : null;
  const executionEnabled = Boolean(resolvedGate?.enabled);
  const catalogCli = {
    cursor,
    claude,
    hermes,
    codex: codexCli,
    openclaw
  };

  const agents = AGENT_CATALOG.map((item) => {
    const cli = catalogCli[item.id] || { found: false, command: item.binaries[0], version: null };
    const chat = classifyChat({
      id: item.id,
      cliFound: cli.found,
      codexApiConfigured: Boolean(resolvedCodex?.configured)
    });
    const model = item.id === "codex"
      ? resolvedCodex?.model || item.model
      : item.id === "hermes"
        ? hermesModel || item.model
        : item.model;
    return buildAgentRecord({
      id: item.id,
      name: item.name,
      eyebrow: item.eyebrow,
      hint: item.hint,
      cli,
      chat,
      model,
      executionEnabled
    });
  });

  return {
    ok: true,
    hosted: false,
    edition: "local-v1",
    generatedAt: new Date().toISOString(),
    executionGate: {
      enabled: executionEnabled,
      source: resolvedGate?.source || "disabled",
      dryRunDefault: resolvedGate?.dryRunDefault !== false,
      publicSummary: resolvedGate?.publicSummary || "Trusted live execution is disabled."
    },
    summary: summarizeAgents(agents, resolvedGate, resolvedGateway),
    agents
  };
}

export { AGENT_CATALOG };
