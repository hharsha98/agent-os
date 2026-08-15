import path from "node:path";
import { appendModuleLog } from "./module-logs.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";
import { sanitizeObject } from "./safety.js";

function secretsPath() {
  return path.join(runtimePaths().config, "connections.local.json");
}

export const CONNECTION_TEMPLATES = [
  {
    id: "claude",
    label: "Claude Code",
    fields: ["CLAUDE_CODE_PATH", "CLAUDE_CLI_ARGS", "CLAUDE_WORKSPACE", "CLAUDE_TIMEOUT_MS", "ANTHROPIC_API_KEY"],
    notes: "Claude Code can be detected by PATH. CLI args may use {{message}}. Workspace and timeout policy stay local; secrets are never returned."
  },
  {
    id: "codex",
    label: "Codex",
    fields: ["CODEX_CLI_PATH", "CODEX_CLI_ARGS", "CODEX_WORKSPACE", "CODEX_TIMEOUT_MS", "OPENAI_API_KEY"],
    notes: "Codex can be detected by PATH or configured with a local CLI path. CLI args may use {{message}}."
  },
  {
    id: "voice-control",
    label: "Hermes Voice Control",
    fields: ["OPENAI_API_KEY", "HERMES_VOICE_MODEL", "HERMES_VOICE_USE_CODEX_GPT", "HERMES_VOICE_OPENAI_URL", "HERMES_VOICE_ALLOW_SHELL", "HERMES_VOICE_CODEX_TIMEOUT_MS"],
    notes: "Configure the optional Codex GPT planner and local safety gates for spoken desktop commands. Shell commands still require trusted execution."
  },
  {
    id: "gemini",
    label: "Gemini",
    fields: ["GEMINI_CLI_PATH", "GEMINI_API_KEY"],
    notes: "Gemini connects through a local CLI or user-provided Gemini API key."
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    fields: ["OPENCLAW_CLI_PATH", "OPENCLAW_CLI_ARGS", "OPENCLAW_WORKSPACE", "OPENCLAW_TIMEOUT_MS", "OPENCLAW_HOME"],
    notes: "OpenClaw connects through a local CLI and optional workspace path. CLI args may use {{message}}."
  },
  {
    id: "openclaude",
    label: "OpenClaude",
    fields: ["OPENCLAUDE_CLI_PATH", "OPENCLAUDE_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST"],
    notes: "OpenClaude is configurable when a real local compatible CLI/provider is available. Hermes does not bundle the reserved npm placeholder package."
  },
  {
    id: "opencode",
    label: "OpenCode",
    fields: ["OPENCODE_CLI_PATH", "OPENCODE_CLI_ARGS", "OPENCODE_WORKSPACE", "OPENCODE_TIMEOUT_MS"],
    notes: "OpenCode connects through a local CLI. CLI args may use {{message}}."
  },
  {
    id: "firecrawl-builder",
    label: "Firecrawl Agent Builder",
    fields: [
      "NEXT_PUBLIC_CONVEX_URL",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "CLERK_JWT_ISSUER_DOMAIN",
      "FIRECRAWL_API_KEY",
      "HERMES_FIRECRAWL_SCRAPE_URL",
      "HERMES_FIRECRAWL_SEARCH_URL",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "ARCADE_API_KEY"
    ],
    notes: "The real upstream builder needs Convex + Clerk to render and Firecrawl/LLM keys to execute workflows. Values stay local."
  },
  {
    id: "provider-router",
    label: "Provider Router",
    fields: ["OPENROUTER_API_KEY", "OLLAMA_HOST", "MINIMAX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
    notes: "Configure one or more local/user-owned providers directly from the router card. Individual provider cards can still override their own keys and endpoints."
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    fields: ["HERMES_HOME", "HERMES_CLI_PATH", "HERMES_KANBAN_BOARD"],
    notes: "Connect an existing local Hermes install. HERMES_CLI_PATH is optional when `hermes` is already on PATH; dashboard task dispatch writes to Hermes Kanban."
  },
  {
    id: "gateway",
    label: "Hermes Gateway",
    fields: ["HERMES_HOME", "HERMES_CLI_PATH", "HERMES_KANBAN_BOARD", "HERMES_TELEGRAM_API_BASE"],
    notes: "Direct gateway control-room config. Uses the same local Hermes profile store and optional Telegram API base override for channel smoke tests."
  },
  {
    id: "provider-anthropic",
    label: "Anthropic",
    fields: ["ANTHROPIC_API_KEY"],
    notes: "User-owned Anthropic key for Claude models and Claude Code workflows."
  },
  {
    id: "provider-openai",
    label: "Codex API",
    fields: ["OPENAI_API_KEY", "AGENT_OS_CODEX_MODEL", "AGENT_OS_CODEX_REASONING_EFFORT", "AGENT_OS_OPENAI_BASE_URL", "AGENT_OS_CODEX_TIMEOUT_MS"],
    notes: "Server-side OpenAI API connection powering Agent OS prompting, workflow generation, edits, and Codex previews. The default model is gpt-5.3-codex."
  },
  {
    id: "provider-gemini",
    label: "Gemini API",
    fields: ["GEMINI_API_KEY"],
    notes: "User-owned Gemini API key."
  },
  {
    id: "provider-openrouter",
    label: "OpenRouter",
    fields: ["OPENROUTER_API_KEY", "OPENROUTER_MANAGEMENT_KEY"],
    notes: "User-owned OpenRouter key for open-provider routing. OPENROUTER_MANAGEMENT_KEY is optional and only used for account credit reconciliation."
  },
  {
    id: "provider-ollama",
    label: "Ollama",
    fields: ["OLLAMA_HOST"],
    notes: "Local Ollama endpoint, for example http://127.0.0.1:11434."
  },
  {
    id: "minimax",
    label: "MiniMax M3",
    fields: ["MINIMAX_API_KEY"],
    notes: "Direct MiniMax M3 card configuration. Uses the same user-owned MiniMax key and health route as provider-minimax."
  },
  {
    id: "provider-minimax",
    label: "MiniMax",
    fields: ["MINIMAX_API_KEY"],
    notes: "User-owned MiniMax API key."
  },
  {
    id: "provider-firecrawl",
    label: "Firecrawl",
    fields: ["FIRECRAWL_API_KEY", "HERMES_FIRECRAWL_SCRAPE_URL", "HERMES_FIRECRAWL_SEARCH_URL"],
    notes: "User-owned Firecrawl API key for web/data tools. Endpoint overrides are optional for private gateways or tests."
  },
  {
    id: "provider-convex",
    label: "Convex",
    fields: ["NEXT_PUBLIC_CONVEX_URL"],
    notes: "Convex URL required by upstream Open Agent Builder workflow storage."
  },
  {
    id: "provider-clerk",
    label: "Clerk",
    fields: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "CLERK_JWT_ISSUER_DOMAIN"],
    notes: "Clerk auth values required by upstream Open Agent Builder."
  }
];

export async function getStoredConnectionConfig() {
  await ensureRuntimeStore();
  return readJson(secretsPath(), {});
}

export async function getConnections() {
  const stored = await getStoredConnectionConfig();
  return {
    templates: CONNECTION_TEMPLATES.map((template) => ({
      ...template,
      configuredFields: Object.keys(stored[template.id] || {})
    }))
  };
}

export async function configureConnection(id, fields = {}) {
  await ensureRuntimeStore();
  const current = await getStoredConnectionConfig();
  current[id] = {
    ...(current[id] || {}),
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value != null && String(value).trim() !== "")
    )
  };
  await writeJson(secretsPath(), current);
  await appendModuleLog(id, {
    message: "Connection configuration saved",
    details: {
      configuredFields: Object.keys(current[id] || {})
    }
  });
  return {
    ok: true,
    id,
    configuredFields: Object.keys(current[id] || {}),
    details: sanitizeObject(current[id] || {})
  };
}

export function getConfiguredValue(stored, id, key) {
  return process.env[key] || stored?.[id]?.[key] || null;
}
