// Adapter for the Claude Code CLI. Facts are detected from --help/--version
// (see detect.js) rather than hard-coded, because Claude Code releases
// frequently. Confirmed live against Claude Code 2.1.281's --help; see the
// deliverable report for any place the real CLI differed from the docs.
import {
  brainError,
  brainNotices,
  buildClaudeSettings,
  keyHelper,
  normalizeBrain,
  normalizeBudget,
  normalizeResume,
  runRecord,
  writeClaudeSettingsFile
} from "../builders/brain-launch.js";
import { CLAUDE_LIMIT_TEXT, limitEvent, resetsAtFrom } from "../builders/limits.js";
import { runCommand } from "../safety.js";
import {
  cachedFeatures,
  claudeFallbackPaths,
  resolveBinary,
  runHelp,
  runVersion,
  splitVersion,
  withDetectCache
} from "./detect.js";

const AUTH_STATUS_TIMEOUT_MS = 10 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

// The choices list trails --permission-mode in the help text, e.g.
// `(choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")`,
// possibly wrapped across lines by the terminal formatter.
function parsePermissionModes(text) {
  const match = text.match(/--permission-mode[\s\S]{0,400}?\(choices:\s*([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

async function detectFeatures(binPath) {
  const { text } = await runHelp(binPath, ["--help"], 5000);
  return {
    print: /(^|[\s,])(-p|--print)\b/.test(text),
    streamJson: /stream-json/i.test(text),
    verbose: /--verbose\b/.test(text),
    permissionMode: /--permission-mode\b/.test(text),
    addDir: /--add-dir\b/.test(text),
    // Only needed for a run on OpenRouter/Local, or one continued after a limit.
    settings: /--settings\b/.test(text),
    model: /--model\b/.test(text),
    resume: /--resume\b/.test(text) && /--fork-session\b/.test(text),
    maxBudgetUsd: /--max-budget-usd\b/.test(text),
    permissionModes: parsePermissionModes(text),
    // "auth" only shows up as a top-level command when `claude auth status`
    // (a read-only check) actually exists.
    authStatus: /\bauth\b[^\n]*authentication/i.test(text)
  };
}

async function detect({ refresh = false } = {}) {
  return withDetectCache("claude", refresh, async () => {
    try {
      const binPath = await resolveBinary("claude", claudeFallbackPaths());
      if (!binPath) {
        return {
          installed: false,
          path: "",
          version: "",
          features: {},
          error: "claude was not found on PATH."
        };
      }
      const versionText = await runVersion(binPath);
      const { version, versionFull } = splitVersion(versionText);
      const features = await cachedFeatures(`claude:${binPath}:${version}`, () => detectFeatures(binPath));
      return { installed: true, path: binPath, version, versionFull, features };
    } catch (error) {
      return { installed: false, path: "", version: "", features: {}, error: error?.message || "Claude Code detection failed." };
    }
  });
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function configStatus(detected) {
  if (!detected?.installed) {
    return { ok: false, summary: "Claude Code is not installed.", problems: [], fixHint: "Install Claude Code, then refresh." };
  }
  if (!detected.features?.authStatus) {
    return { ok: true, summary: "Claude Code found; sign-in is checked on first run.", problems: [] };
  }
  // Never reads ~/.claude files: this only asks the CLI for its own status.
  const result = await runCommand(detected.path, ["auth", "status"], AUTH_STATUS_TIMEOUT_MS);
  const parsed = parseJsonLoose(result.stdout);
  const text = `${result.stdout}\n${result.stderr}`;
  const loggedIn = parsed && typeof parsed.loggedIn === "boolean"
    ? parsed.loggedIn
    : /logged in|signed in/i.test(text) && !/not logged in|not signed in/i.test(text);
  if (loggedIn) {
    return { ok: true, summary: "Signed in to Claude Code.", problems: [] };
  }
  return {
    ok: false,
    summary: "Claude Code is not signed in.",
    problems: [],
    fixHint: "Run 'claude auth login', then refresh."
  };
}

async function safetyStatus(detected) {
  const modes = detected?.features?.permissionModes || [];
  const mode = modes.includes("dontAsk") ? "dontAsk" : "default";
  return {
    permissive: false,
    summary: `Runs in print mode with ${mode}; Agent OS never passes --dangerously-skip-permissions.`,
    actions: []
  };
}

// cwd is always the private run folder (see routes.js's makeRunDir); the
// actual project directory is granted through --add-dir instead, so a run
// never depends on (or pollutes) whatever the server process's cwd is.
async function buildRun({ prompt, cwd, detected, runDir, options = {} }) {
  const features = detected?.features || {};
  const streamJson = Boolean(features.streamJson && features.verbose);
  const args = ["-p", "--output-format", streamJson ? "stream-json" : "text"];
  if (streamJson) args.push("--verbose");

  const modes = features.permissionModes || [];
  let mode = modes.includes("dontAsk") ? "dontAsk" : null;
  if (options.allowEdits === true && modes.includes("acceptEdits")) mode = "acceptEdits";
  if (mode && features.permissionMode) args.push("--permission-mode", mode);

  if (features.addDir) args.push("--add-dir", cwd);

  // Which brain pays for the run. `plan` (the default) adds nothing to the
  // items above, so the command line is exactly what it always was.
  // options.brain comes from trusted server code (see builders/resolve.js);
  // options.resume ({ sessionId, fork }) continues an earlier conversation and
  // options.maxBudgetUsd caps what one run may spend (both set by builders/continue.js).
  const brain = normalizeBrain(options.brain, "claude");
  const resume = normalizeResume(options.resume);
  const budget = brain.mode === "plan" ? null : normalizeBudget(options.maxBudgetUsd);
  if (brain.mode !== "plan" && !(features.settings && features.model)) {
    throw brainError("brain_not_supported_by_cli", "This version of Claude Code can't be pointed at another model. Update Claude Code, then try again.");
  }
  if (resume && !features.resume) {
    throw brainError("brain_not_supported_by_cli", "This version of Claude Code can't continue an earlier conversation. Update Claude Code, then try again.");
  }
  const notices = brain.mode === "plan" ? [] : brainNotices("claude", brain);
  let settingsFile = null;
  if (brain.mode !== "plan") {
    // Throws (and writes nothing) when an OpenRouter run has no saved key, or
    // when the settings would name another address without a credential.
    const settings = buildClaudeSettings(brain, brain.mode === "openrouter" ? await keyHelper() : null);
    settingsFile = await writeClaudeSettingsFile(runDir, settings);
    args.push("--settings", settingsFile.file, "--model", brain.mode === "local" ? brain.local.model : brain.model);
    if (budget && features.maxBudgetUsd) {
      args.push("--max-budget-usd", String(budget));
    } else if (budget) {
      notices.push("This version of Claude Code can't enforce a spending limit, so only the estimate keeps this run in budget.");
    }
  }
  if (resume) {
    args.push("--resume", resume.sessionId);
    if (resume.fork) args.push("--fork-session");
  }

  const transport = streamJson ? "stream-json" : "text";
  const where = brain.mode === "openrouter" ? ", OpenRouter" : brain.mode === "local" ? ", local model" : "";
  const parserState = {}; // one per run, so a limit is reported once
  return {
    agentId: "claude",
    kind: "agent",
    title: `Claude Code (${transport} transport${where})`,
    command: detected.path,
    args,
    cwd: runDir,
    stdin: prompt,
    timeoutMs: RUN_TIMEOUT_MS,
    ...runRecord({ prompt, cwd, brain, options }),
    ...(notices.length ? { notices } : {}),
    // The settings file holds no key, but it is still removed as soon as the run ends.
    ...(settingsFile ? { onExit: () => settingsFile.remove() } : {}),
    parseLine: (line, stream) => parseLine(line, stream, parserState)
  };
}

function toolPreview(part) {
  const name = String(part?.name || "tool");
  let argsPreview = "";
  if (part?.input !== undefined) {
    try {
      argsPreview = JSON.stringify(part.input).slice(0, 160);
    } catch {
      argsPreview = "";
    }
  }
  return argsPreview ? `${name} ${argsPreview}` : name;
}

// Compacts a hook/rate-limit event into one short line: the hook's own name
// when it has one, else the first couple of small fields the event carries.
function setupSummary(evt) {
  if (evt.hook_name) return String(evt.hook_name);
  const rest = Object.fromEntries(
    Object.entries(evt).filter(([key, value]) => key !== "type" && key !== "subtype" && typeof value !== "object")
  );
  const keys = Object.keys(rest);
  if (!keys.length) return "";
  return keys.slice(0, 2).map((key) => `${key}=${rest[key]}`).join(" ").slice(0, 120);
}

function setupEvent(evt, subtype) {
  const summary = setupSummary(evt);
  return { type: "setup", text: summary ? `${subtype}: ${summary}` : subtype };
}

// Tool results (and some content blocks) can be a plain string or an array
// of {type:"text", text} blocks; this normalizes either shape to plain text.
function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : String(block?.text ?? "")))
      .join("");
  }
  if (content && typeof content === "object") return String(content.text ?? "");
  return "";
}

// Stream-json event shapes follow the Claude Code headless docs
// (https://code.claude.com/docs/en/headless): system/init once at start,
// assistant/user messages carry Anthropic Messages-API-style content
// blocks, and a single terminal "result" event carries totals.
// `ctx` is per-run memory (see buildRun): whether a limit was already reported,
// and how big the conversation was at the last answer. Called without one (as
// the tests do), every line is judged on its own.
function parseLine(line, _stream, ctx = {}) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;
  switch (evt.type) {
    case "system": {
      if (evt.subtype === "init") {
        const init = { type: "system", text: `session started (model ${evt.model || "unknown"})` };
        // Kept on the run: the session id lets a later run continue this
        // conversation; apiKeySource ("apiKeyHelper" on OpenRouter, "none" on
        // a plan sign-in) shows which credential this run really used.
        if (typeof evt.session_id === "string" && evt.session_id) init.sessionId = evt.session_id.slice(0, 80);
        if (typeof evt.apiKeySource === "string" && evt.apiKeySource) init.apiKeySource = evt.apiKeySource.slice(0, 40);
        return [init];
      }
      if (["hook_started", "hook_response", "commands_changed"].includes(evt.subtype)) {
        return [setupEvent(evt, evt.subtype)];
      }
      return null;
    }
    case "rate_limit_event": {
      const info = evt.rate_limit_info && typeof evt.rate_limit_info === "object" ? evt.rate_limit_info : {};
      // "rejected" is the real stop. "allowed_warning" only means "near your
      // limit" and is not a stop.
      if (info.status === "rejected") {
        if (ctx.limitSeen) return null;
        ctx.limitSeen = true;
        return [limitEvent("claude", { kind: info.rateLimitType, resetsAt: resetsAtFrom(info.resetsAt) })];
      }
      if (info.status === "allowed_warning") {
        return [{ type: "setup", text: "rate_limit_event: near your limit", warning: "near_limit" }];
      }
      return [setupEvent(evt, "rate_limit_event")];
    }
    case "assistant": {
      const parts = evt.message?.content;
      if (!Array.isArray(parts)) return null;
      // How much the model read for this answer (new + cached input). The last
      // one is the size of the whole conversation, which is what continuing it
      // somewhere else has to read again. A sub-agent's answers are its own chat.
      const used = evt.message?.usage;
      if (used && typeof used === "object" && !evt.parent_tool_use_id) {
        const total = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
          .map((key) => (Number.isFinite(used[key]) ? used[key] : 0))
          .reduce((a, b) => a + b, 0);
        if (total > 0) ctx.lastInputTokens = total;
      }
      const events = [];
      for (const part of parts) {
        if (part?.type === "text") events.push({ type: "text", text: String(part.text ?? "") });
        else if (part?.type === "tool_use") events.push({ type: "tool", text: toolPreview(part) });
      }
      return events.length ? events : null;
    }
    case "user": {
      const parts = evt.message?.content;
      if (!Array.isArray(parts)) return null;
      const events = [];
      for (const part of parts) {
        if (part?.type === "tool_result") events.push({ type: "tool_result", text: blockText(part.content).slice(0, 500) });
      }
      return events.length ? events : null;
    }
    case "result": {
      const events = [
        {
          type: "result",
          text: String(evt.result ?? ""),
          data: { is_error: Boolean(evt.is_error), num_turns: evt.num_turns ?? null }
        }
      ];
      // The exit code can be 0 even when the plan ran out, so the words decide.
      if (evt.is_error === true && CLAUDE_LIMIT_TEXT.test(String(evt.result ?? "")) && !ctx.limitSeen) {
        ctx.limitSeen = true;
        events.push(limitEvent("claude"));
      }
      const costUsd = evt.total_cost_usd;
      const usage = evt.usage || {};
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;
      if (typeof costUsd === "number" || typeof inputTokens === "number" || typeof outputTokens === "number") {
        const usageEvent = { type: "usage", costUsd, inputTokens, outputTokens };
        if (ctx.lastInputTokens) usageEvent.lastInputTokens = ctx.lastInputTokens;
        events.push(usageEvent);
      }
      return events;
    }
    default:
      return null;
  }
}

function safetyAction() {
  return null; // Claude Code has no configurable safety action yet.
}

export default {
  id: "claude",
  label: "Claude Code",
  homepage: "https://claude.com/claude-code",
  docsUrl: "https://code.claude.com/docs/en/headless",
  license: "Proprietary",
  detect,
  configStatus,
  safetyStatus,
  buildRun,
  parseLine,
  safetyAction
};
