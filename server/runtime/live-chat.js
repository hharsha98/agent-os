import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BLOCKED_AGENT_FLAGS } from "./agent-flags.js";
import { isDemoPublic } from "./demo-public.js";
import { isExecutionEnabled } from "./execution-gate.js";
import { isLiveChatEnabled } from "./live-flags.js";
import { completeViaOmniRoute, publicOmniRouteStatus, resolveOmniRouteConfig } from "./omniroute.js";
import { redactText, runCommand, which } from "./safety.js";
import { ensureRuntimeStore, expandHome, runtimePaths } from "./store.js";
import { writeWorkspaceText } from "./workspace.js";

export const LIVE_SEATS = ["cursor", "claude", "codex", "hermes", "openclaw"];

// Live-chat children are short-lived (a single CLI call), so they don't need
// process-tree.js's spawnTracked. Shutdown still needs to find and kill any
// still running when the process quits.
export const activeLiveChatChildren = new Set();

const SEAT_SYSTEM = {
  cursor: "You are the Cursor seat in Agent OS. Answer as a coding agent. This turn is text from OmniRoute. You are not driving the Cursor CLI or editing files.",
  claude: "You are the Claude Code seat in Agent OS. Answer as a coding agent. This turn is text from OmniRoute. You are not driving the Claude CLI or editing files.",
  codex: "You are the Codex seat in Agent OS. Answer as a coding agent. This turn is text from OmniRoute. You are not driving the Codex CLI.",
  hermes: "You are the Hermes seat in Agent OS. Answer helpfully. This turn is text from OmniRoute. You do not have Hermes tools, profile memory, or gateway control in this turn.",
  openclaw: "You are the OpenClaw seat in Agent OS. Answer helpfully. This turn is text from OmniRoute. You do not have OpenClaw gateway tools in this turn."
};

function clampTimeout(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function cleanHttpBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return raw.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function splitArgs(value) {
  const input = String(value || "").trim();
  if (!input) return [];
  const args = [];
  let current = "";
  let quote = "";
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
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

const CHILD_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
const SECRET_ENV_KEYS = [
  "OMNIROUTE_API_KEY",
  "OPENCLAW_GATEWAY_TOKEN",
  "HERMES_AGENT_OS_ADMIN_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "CLERK_SECRET_KEY",
  "FIRECRAWL_API_KEY"
];

function childEnv(env, extra = {}) {
  const next = {};
  for (const key of CHILD_ENV_KEYS) {
    if (env[key]) next[key] = env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value != null && value !== "") next[key] = String(value);
  }
  return next;
}

function scrubSecrets(text, env = {}) {
  let out = String(text || "");
  for (const key of SECRET_ENV_KEYS) {
    const value = String(env[key] || "");
    if (value.length >= 4) out = out.replaceAll(value, "configured");
  }
  return out;
}

export function withMessageTerminator(args, message) {
  const next = args.map((arg) => arg.replaceAll("{{message}}", message));
  let index = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i] === message) {
      index = i;
      break;
    }
  }
  if (index === -1 || next[index - 1] === "--") return next;
  next.splice(index, 0, "--");
  return next;
}

function publicHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function resultShape(agentId, fields, env = {}) {
  return {
    ok: Boolean(fields.ok),
    mode: fields.mode,
    transport: fields.transport || "none",
    native: Boolean(fields.native),
    agentId,
    reply: scrubSecrets(String(fields.reply || ""), env),
    model: fields.model || null
  };
}

function dryPlan(agentId, message) {
  const focus = message.length > 180 ? `${message.slice(0, 180)}…` : message;
  return resultShape(agentId, {
    ok: true,
    mode: "dry_run",
    transport: "dry_run",
    native: false,
    reply: [
      `## Dry-run plan · ${agentId}`,
      "",
      `Goal: ${focus}`,
      "",
      "Proposed steps (not executed):",
      "1. Keep this turn as a plan.",
      "2. Uncheck dry-run, or set AGENT_OS_LIVE_CHAT=1, to call OmniRoute or a native agent.",
      "3. Native CLIs still need HERMES_AGENT_OS_ENABLE_EXEC=1 and the binary on PATH.",
      "",
      "Live tools stay off until the request sets dryRun:false."
    ].join("\n")
  });
}

async function probeBinary(env, names, whichImpl) {
  for (const name of names) {
    if (!name) continue;
    const found = await whichImpl(name);
    if (found) return found;
  }
  return "";
}

export async function getLiveStatus(env = process.env, deps = {}) {
  const whichImpl = deps.which || which;
  const omni = publicOmniRouteStatus(await resolveOmniRouteConfig(env));
  const gatewayUrl = cleanHttpBase(env.OPENCLAW_GATEWAY_URL);
  const [hermesCli, openclawCli, claudeCli, codexCli, cursorCli] = await Promise.all([
    probeBinary(env, [env.HERMES_CLI_PATH, "hermes"], whichImpl),
    probeBinary(env, [env.OPENCLAW_CLI_PATH, "openclaw"], whichImpl),
    probeBinary(env, [env.CLAUDE_CODE_PATH, env.CLAUDE_CLI_PATH, "claude"], whichImpl),
    probeBinary(env, [env.CODEX_CLI_PATH, "codex"], whichImpl),
    probeBinary(env, [env.CURSOR_AGENT_PATH, "agent"], whichImpl)
  ]);
  const demoPublic = isDemoPublic(env);
  const liveChat = isLiveChatEnabled(env);
  return {
    ok: true,
    demoPublic,
    liveChat,
    executionEnabled: env.HERMES_AGENT_OS_ENABLE_EXEC === "1",
    omniroute: omni,
    hermes: { cli: Boolean(hermesCli), homeSet: Boolean(env.HERMES_HOME) },
    openclaw: {
      cli: Boolean(openclawCli),
      gatewayConfigured: Boolean(gatewayUrl),
      gatewayHost: publicHost(gatewayUrl),
      tokenSet: Boolean(String(env.OPENCLAW_GATEWAY_TOKEN || "").trim())
    },
    claude: { cli: Boolean(claudeCli) },
    codex: { cli: Boolean(codexCli) },
    cursor: { cli: Boolean(cursorCli) },
    badge: demoPublic
      ? "Public demo · sandboxed"
      : liveChat
        ? "Live operator · single machine"
        : "Dry-run default"
  };
}

async function runArgv(commandPath, args, timeoutMs, env, deps, extraEnv = {}) {
  const runner = deps.runCommand || runCommand;
  const result = await runner(commandPath, args, timeoutMs, {
    env: childEnv(env, extraEnv),
    cwd: os.tmpdir(),
    track: activeLiveChatChildren
  });
  const reply = scrubSecrets(
    redactText(result.stdout || result.stderr || "Command completed with no output.", [commandPath]),
    env
  );
  return {
    ok: Boolean(result.ok && String(result.stdout || "").trim()),
    native: true,
    reply,
    exitCode: result.code ?? null
  };
}

async function runHermesCli(message, env, deps) {
  const whichImpl = deps.which || which;
  const commandPath = await probeBinary(env, [env.HERMES_CLI_PATH, "hermes"], whichImpl);
  if (!commandPath) return null;
  await ensureRuntimeStore();
  const dir = path.join(runtimePaths().runs, "live-queries");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `hermes-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await fs.writeFile(file, message, { mode: 0o600 });
  try {
    const args = ["chat", "--oneshot", "-Q", "--query-file", file];
    const toolsets = String(env.HERMES_CHAT_TOOLSETS || "").trim();
    if (toolsets) args.push("--toolsets", toolsets.slice(0, 200));
    const home = expandHome(env.HERMES_HOME || "~/.hermes");
    const timeoutMs = clampTimeout(env.HERMES_CHAT_TIMEOUT_MS, 120000, 5000, 600000);
    const ran = await runArgv(commandPath, args, timeoutMs, env, deps, { HERMES_HOME: home });
    return { ...ran, transport: "hermes-cli", reply: redactText(ran.reply, [home, file]) };
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

async function runTemplateCli(agentId, message, env, deps) {
  const whichImpl = deps.which || which;
  const specs = {
    claude: {
      names: [env.CLAUDE_CODE_PATH, env.CLAUDE_CLI_PATH, "claude"],
      args: withMessageTerminator(["--output-format", "text", "-p", message], message),
      timeout: clampTimeout(env.CLAUDE_TIMEOUT_MS, 120000, 5000, 600000),
      transport: "claude-cli"
    },
    codex: {
      names: [env.CODEX_CLI_PATH, "codex"],
      args: withMessageTerminator(["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", message], message),
      timeout: clampTimeout(env.CODEX_TIMEOUT_MS, 120000, 5000, 600000),
      transport: "codex-cli"
    },
    cursor: {
      names: [env.CURSOR_AGENT_PATH, "agent"],
      args: withMessageTerminator(
        env.CURSOR_CLI_ARGS
          // Defence in depth: configure-time checks already reject blocked
          // flags, but filter again here in case a value predates that check.
          ? splitArgs(env.CURSOR_CLI_ARGS).filter((arg) => !BLOCKED_AGENT_FLAGS.some((flag) => arg.includes(flag)))
          : ["-p", "{{message}}"],
        message
      ),
      timeout: clampTimeout(env.CURSOR_TIMEOUT_MS, 120000, 5000, 600000),
      transport: "cursor-cli"
    },
    openclaw: {
      names: [env.OPENCLAW_CLI_PATH, "openclaw"],
      args: ["agent", `--message=${message}`, "--thinking", "high"],
      timeout: clampTimeout(env.OPENCLAW_TIMEOUT_MS, 120000, 5000, 600000),
      transport: "openclaw-cli"
    }
  };
  const spec = specs[agentId];
  if (!spec) return null;
  const commandPath = await probeBinary(env, spec.names, whichImpl);
  if (!commandPath) return null;
  const ran = await runArgv(commandPath, spec.args, spec.timeout, env, deps);
  return { ...ran, transport: spec.transport };
}

async function runOpenClawGateway(message, env, deps) {
  const base = cleanHttpBase(env.OPENCLAW_GATEWAY_URL);
  if (!String(env.OPENCLAW_GATEWAY_URL || "").trim()) return null;
  if (!base) {
    return {
      ok: false,
      transport: "openclaw-gateway",
      native: true,
      fallThrough: false,
      reply: "OPENCLAW_GATEWAY_URL must be an http(s) URL without embedded credentials."
    };
  }
  const token = String(env.OPENCLAW_GATEWAY_TOKEN || "").trim();
  const model = String(env.OPENCLAW_GATEWAY_MODEL || "openclaw/default").trim() || "openclaw/default";
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const fetchImpl = deps.fetchImpl || fetch;
  const timeoutMs = clampTimeout(env.OPENCLAW_GATEWAY_TIMEOUT_MS, 120000, 5000, 600000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        user: "agent-os",
        messages: [{ role: "user", content: message }]
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content;
    if (!response.ok) {
      return {
        ok: false,
        transport: "openclaw-gateway",
        native: true,
        fallThrough: response.status === 404 || response.status === 405,
        reply: redactText(String(data?.error?.message || `OpenClaw gateway HTTP ${response.status}`)).slice(0, 600)
      };
    }
    return {
      ok: true,
      transport: "openclaw-gateway",
      native: true,
      fallThrough: false,
      model,
      reply: (typeof text === "string" && text.trim()) ? text.trim() : "OpenClaw gateway returned an empty completion."
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    const code = error?.cause?.code || error?.code;
    const neverReached = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(code);
    return {
      ok: false,
      transport: "openclaw-gateway",
      native: true,
      fallThrough: !timedOut && neverReached,
      reply: timedOut ? `OpenClaw gateway timed out after ${timeoutMs} ms.` : redactText(error?.message || "OpenClaw gateway request failed.").slice(0, 600)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runOmniRouteSeat(agentId, message, env, deps) {
  try {
    const completed = await completeViaOmniRoute({
      messages: [
        { role: "system", content: SEAT_SYSTEM[agentId] || SEAT_SYSTEM.hermes },
        { role: "user", content: message }
      ],
      fetchImpl: deps.fetchImpl || fetch,
      timeoutMs: clampTimeout(env.OMNIROUTE_TIMEOUT_MS, 90000, 5000, 300000)
    }, env);
    return {
      ok: Boolean(completed.text),
      transport: "omniroute",
      native: false,
      model: completed.model,
      reply: completed.text || "OmniRoute returned an empty completion."
    };
  } catch (error) {
    if (error?.code === "OMNIROUTE_NOT_CONFIGURED") return null;
    return {
      ok: false,
      transport: "omniroute",
      native: false,
      reply: redactText(error?.message || "OmniRoute chat failed.").slice(0, 600)
    };
  }
}

async function runCodexApiSeat(message) {
  try {
    const { runCodexPreview } = await import("./codex-api.js");
    const preview = await runCodexPreview({ message });
    if (!preview?.reply) return null;
    return {
      ok: true,
      transport: "codex-api",
      native: false,
      model: preview.model || null,
      reply: preview.reply
    };
  } catch (error) {
    if (error?.code === "CODEX_API_NOT_CONFIGURED" || error?.status === 412) return null;
    return {
      ok: false,
      transport: "codex-api",
      native: false,
      reply: redactText(error?.message || "Codex API preview failed.").slice(0, 600)
    };
  }
}

function unavailable(agentId) {
  const hints = {
    hermes: "Install the hermes CLI and set HERMES_AGENT_OS_ENABLE_EXEC=1, or set OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY.",
    openclaw: "Set OPENCLAW_GATEWAY_URL (and token if the gateway requires one), install the openclaw CLI with the execution gate on, or set OmniRoute.",
    claude: "Install the claude CLI and turn on the execution gate, or set OmniRoute.",
    codex: "Install the codex CLI and turn on the execution gate, set OmniRoute, or save an OpenAI API key for the Codex preview.",
    cursor: "Install the Cursor agent CLI and turn on the execution gate, or set OmniRoute."
  };
  return resultShape(agentId, {
    ok: false,
    mode: "unavailable",
    transport: "none",
    native: false,
    reply: `No live backend is configured for ${agentId}. ${hints[agentId] || ""}`.trim()
  });
}

export async function dispatchLiveChat(input = {}, deps = {}) {
  const env = deps.env || process.env;
  const requested = String(input.agentId || input.id || "hermes").toLowerCase();
  const agentId = LIVE_SEATS.includes(requested) ? requested : "hermes";
  const message = String(input.message || input.prompt || "").trim().slice(0, 12000);
  if (!message) {
    return resultShape(agentId, {
      ok: false,
      mode: "invalid",
      reply: "message is required"
    }, env);
  }
  if (isDemoPublic(env)) {
    return resultShape(agentId, {
      ok: false,
      mode: "demo_locked",
      reply: "Public demo mode is on. Unset DEMO_PUBLIC to call OmniRoute, Hermes, or OpenClaw. Gallery replies stay on /api/demo/chat."
    }, env);
  }
  if (input.dryRun !== false) return dryPlan(agentId, message);
  if (!isLiveChatEnabled(env)) {
    return resultShape(agentId, {
      ok: false,
      mode: "blocked",
      reply: "Live chat is off. Set AGENT_OS_LIVE_CHAT=1 to call OmniRoute and the OpenClaw gateway. Native CLIs also need HERMES_AGENT_OS_ENABLE_EXEC=1. Send dryRun: true for a plan."
    }, env);
  }

  const execOn = deps.executionEnabled
    ? await deps.executionEnabled()
    : await isExecutionEnabled();

  if (agentId === "openclaw") {
    const gateway = await runOpenClawGateway(message, env, deps);
    if (gateway && (gateway.ok || !gateway.fallThrough)) {
      return resultShape(agentId, { ...gateway, mode: gateway.ok ? "executed" : "error" }, env);
    }
    if (execOn) {
      const cli = await runTemplateCli("openclaw", message, env, deps);
      if (cli) return resultShape(agentId, { ...cli, mode: cli.ok ? "executed" : "error" }, env);
    }
  } else if (execOn) {
    const cli = agentId === "hermes"
      ? await runHermesCli(message, env, deps)
      : await runTemplateCli(agentId, message, env, deps);
    if (cli) return resultShape(agentId, { ...cli, mode: cli.ok ? "executed" : "error" }, env);
  }

  const omni = await runOmniRouteSeat(agentId, message, env, deps);
  if (omni) return resultShape(agentId, { ...omni, mode: omni.ok ? "executed" : "error" }, env);

  if (agentId === "codex") {
    const preview = await runCodexApiSeat(message);
    if (preview) return resultShape(agentId, { ...preview, mode: preview.ok ? "executed" : "error" }, env);
  }

  return unavailable(agentId);
}

export async function runLiveMission(input = {}, deps = {}) {
  const env = deps.env || process.env;
  if (isDemoPublic(env)) {
    return {
      ok: false,
      mode: "demo_locked",
      reply: "Public demo mode does not run live missions. Unset DEMO_PUBLIC.",
      hermes: null,
      openclaw: null,
      workspaceFile: null
    };
  }
  const message = String(input.message || input.prompt || "Report what this Agent OS host can run, then name one next safe action.").trim().slice(0, 8000);
  const dryRun = input.dryRun === undefined ? !isLiveChatEnabled(env) : input.dryRun !== false;
  const hermes = await dispatchLiveChat({ agentId: "hermes", message, dryRun }, deps);
  const openclaw = await dispatchLiveChat({ agentId: "openclaw", message, dryRun }, deps);
  const content = [
    "# Mission",
    "",
    `Goal: ${message.length > 400 ? `${message.slice(0, 400)}…` : message}`,
    "",
    `Mode: ${dryRun ? "dry-run" : "live"}`,
    "",
    "## Hermes",
    "",
    `Transport: ${hermes.transport} · native: ${hermes.native ? "yes" : "no"} · ok: ${hermes.ok ? "yes" : "no"}`,
    "",
    hermes.reply || "(no reply)",
    "",
    "## OpenClaw",
    "",
    `Transport: ${openclaw.transport} · native: ${openclaw.native ? "yes" : "no"} · ok: ${openclaw.ok ? "yes" : "no"}`,
    "",
    openclaw.reply || "(no reply)",
    ""
  ].join("\n");
  let workspaceFile = null;
  try {
    const written = await writeWorkspaceText({ relativePath: "missions/latest.md", content });
    workspaceFile = written?.file
      ? {
          relativePath: written.file.relativePath,
          name: written.file.name
        }
      : { relativePath: "missions/latest.md", name: "latest.md" };
  } catch (error) {
    workspaceFile = { error: redactText(error?.message || "Could not write the mission note.").slice(0, 300) };
  }
  return {
    ok: Boolean(hermes.ok || openclaw.ok),
    mode: dryRun ? "dry_run" : "executed",
    dryRun,
    message,
    hermes,
    openclaw,
    workspaceFile
  };
}
