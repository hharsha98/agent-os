// Adapter for the Cursor Agent CLI (binary `agent`, older installs use
// `cursor-agent`). Facts are detected from --help/--version rather than
// hard-coded, because Cursor Agent releases frequently. Confirmed live
// against Cursor Agent 2026.09.23's --help; see the deliverable report for
// any place the real CLI differed from the docs.
import { runCommand } from "../safety.js";
import { cachedFeatures, resolveBinary, runHelp, runVersion, withDetectCache } from "./detect.js";

const STATUS_TIMEOUT_MS = 10 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

function allowEditsNotSupportedError() {
  const error = new Error("Cursor only proposes changes in Agent OS; open Cursor to apply them.");
  error.code = "allow_edits_not_supported";
  return error;
}

async function detectFeatures(binPath) {
  const { text } = await runHelp(binPath, ["--help"], 5000);
  return {
    print: /(^|[\s,])(-p|--print)\b/.test(text),
    streamJson: /stream-json/i.test(text),
    workspace: /--workspace\b/.test(text),
    trust: /--trust\b/.test(text),
    // The real CLI's --help never documents stdin support for the prompt
    // argument (only `agent -p "text"` examples), so this stays false unless
    // a future --help explicitly says otherwise.
    stdinPrompt: /prompt.{0,40}stdin|stdin.{0,40}prompt/i.test(text),
    // "status|whoami" is listed as a top-level command when the read-only
    // auth-status check exists.
    statusCommand: /\bstatus\|whoami\b/.test(text) || /\bstatus\b[^\n]*authentication status/i.test(text)
  };
}

async function detect({ refresh = false } = {}) {
  return withDetectCache("cursor", refresh, async () => {
    try {
      const binPath = (await resolveBinary("agent", [])) || (await resolveBinary("cursor-agent", []));
      if (!binPath) {
        return {
          installed: false,
          path: "",
          version: "",
          features: {},
          error: "agent (Cursor Agent) was not found on PATH."
        };
      }
      const version = await runVersion(binPath);
      const features = await cachedFeatures(`cursor:${binPath}:${version}`, () => detectFeatures(binPath));
      return { installed: true, path: binPath, version, features };
    } catch (error) {
      return { installed: false, path: "", version: "", features: {}, error: error?.message || "Cursor Agent detection failed." };
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
    return { ok: false, summary: "Cursor Agent is not installed.", problems: [], fixHint: "Install the Cursor Agent CLI, then refresh." };
  }
  if (!detected.features?.statusCommand) {
    return { ok: false, summary: "Cursor Agent login status is unknown.", problems: [], fixHint: "run `agent login`" };
  }
  // Never reads ~/.cursor files: this only asks the CLI for its own status.
  const result = await runCommand(detected.path, ["status", "--format", "json"], STATUS_TIMEOUT_MS);
  const parsed = parseJsonLoose(result.stdout);
  const authenticated = parsed
    ? Boolean(parsed.isAuthenticated ?? parsed.status === "authenticated")
    : /authenticated/i.test(result.stdout) && !/not authenticated/i.test(result.stdout);
  if (authenticated) {
    return { ok: true, summary: "Signed in to Cursor.", problems: [] };
  }
  return { ok: false, summary: "Cursor Agent is not signed in.", problems: [], fixHint: "run `agent login`" };
}

async function safetyStatus() {
  return {
    permissive: false,
    summary: "Proposes changes only; Agent OS never passes --force or --yolo.",
    actions: []
  };
}

// cwd is always the private run folder (see routes.js's makeRunDir);
// --workspace points Cursor's own workspace at the actual project directory.
async function buildRun({ prompt, cwd, detected, runDir, options = {} }) {
  if (options.allowEdits === true) throw allowEditsNotSupportedError();

  const features = detected?.features || {};
  const args = [];
  if (features.print) args.push("-p");
  if (features.streamJson) args.push("--output-format", "stream-json");
  if (features.workspace) args.push("--workspace", cwd);
  // --trust is acceptable here only because cwd is always inside the Agent
  // OS sandbox folder (routes.js's resolveRunCwd enforces this before
  // buildRun ever runs), never an arbitrary path a request could pick.
  if (features.trust) args.push("--trust");

  let stdin;
  if (features.stdinPrompt) {
    stdin = prompt;
  } else {
    args.push("--", prompt);
  }

  return {
    agentId: "cursor",
    kind: "agent",
    title: `Cursor Agent (${features.streamJson ? "stream-json" : "text"} transport)`,
    command: detected.path,
    args,
    cwd: runDir,
    stdin,
    timeoutMs: RUN_TIMEOUT_MS,
    parseLine
  };
}

// Tool-call events carry the tool under one key of tool_call, e.g.
// {"readToolCall": {...}} or {"writeToolCall": {...}}; other tools may use
// {"function": {"name": ..., "arguments": ...}} per the docs.
function toolCallPreview(evt) {
  const toolCall = evt?.tool_call || {};
  const key = Object.keys(toolCall)[0];
  if (!key) return "tool";
  const inner = toolCall[key] || {};
  if (key === "function") {
    return String(inner.name || "tool");
  }
  const name = key.replace(/ToolCall$/, "");
  let argsPreview = "";
  if (inner.args !== undefined) {
    try {
      argsPreview = JSON.stringify(inner.args).slice(0, 160);
    } catch {
      argsPreview = "";
    }
  }
  return argsPreview ? `${name} ${argsPreview}` : name;
}

// Event shapes follow https://cursor.com/docs/cli/reference/output-format:
// system/init once at start, assistant messages carry full text per
// segment, tool_call started/completed, and a terminal result event.
function parseLine(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return [{ type: "line", text: line }];
  switch (evt.type) {
    case "system": {
      if (evt.subtype !== "init") return [{ type: "line", text: line }];
      return [{ type: "system", text: `session started (model ${evt.model || "unknown"})` }];
    }
    case "assistant": {
      const parts = evt.message?.content;
      if (!Array.isArray(parts)) return [{ type: "line", text: line }];
      const events = parts
        .filter((part) => part?.type === "text")
        .map((part) => ({ type: "text", text: String(part.text ?? "") }));
      return events.length ? events : [{ type: "line", text: line }];
    }
    case "tool_call": {
      if (evt.subtype === "started") return [{ type: "tool", text: toolCallPreview(evt) }];
      if (evt.subtype === "completed") return [{ type: "tool_result", text: toolCallPreview(evt).slice(0, 500) }];
      return [{ type: "line", text: line }];
    }
    case "result":
      return [{ type: "result", text: String(evt.result ?? ""), data: { is_error: Boolean(evt.is_error) } }];
    default:
      return [{ type: "line", text: line }];
  }
}

function safetyAction() {
  return null; // Cursor Agent has no configurable safety action yet.
}

export default {
  id: "cursor",
  label: "Cursor Agent",
  homepage: "https://cursor.com",
  docsUrl: "https://cursor.com/docs/cli/headless",
  license: "Proprietary",
  detect,
  configStatus,
  safetyStatus,
  buildRun,
  parseLine,
  safetyAction
};
