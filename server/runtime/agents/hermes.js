// Adapter for the Hermes Agent CLI. Facts are detected from --help/--version
// (see detect.js) rather than hard-coded, because Hermes ships new flags
// every few days.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfiguredValue, getStoredConnectionConfig } from "../connections.js";
import { runCommand } from "../safety.js";
import { expandHome } from "../store.js";
import {
  cachedFeatures,
  hermesFallbackPaths,
  resolveBinary,
  runHelp,
  runVersion,
  splitVersion,
  withDetectCache
} from "./detect.js";

const DOCTOR_TIMEOUT_MS = 30 * 1000;
const APPROVALS_TIMEOUT_MS = 10 * 1000;
const GATEWAY_STATUS_TIMEOUT_MS = 10 * 1000;
const GATEWAY_ACTION_TIMEOUT_MS = 30 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

// Help text is read two ways: as printed, and with every run of whitespace
// removed. argparse (and rich) wrap long lines, and a wrap can land inside
// "stream-json" or between "--format" and its choices; the squashed copy
// still matches then.
export function featuresFromHelp(text) {
  const raw = String(text ?? "");
  const squashed = raw.replace(/\s+/g, "");
  const result = {
    queryFile: /--query-file\b/.test(raw),
    oneshot: /--oneshot\b/.test(raw),
    quiet: /(^|[\s,])(-Q|--quiet)\b/.test(raw),
    inDir: /--in\b/.test(raw),
    // v0.20.6 has no --format flag at all; v0.21+ lists
    // `[--format {text,stream-json}]`.
    streamJson: /--format/.test(squashed) && /stream-json/i.test(squashed),
    // `-t TOOLSETS, --toolsets TOOLSETS`: which tool groups a run may use.
    toolsets: /--toolsets\b/.test(raw) || /(^|[\s,[])-t\s+TOOLSETS\b/i.test(raw)
  };
  if (!raw.trim()) result.helpFailed = true;
  return result;
}

async function detectFeatures(binPath) {
  const { text } = await runHelp(binPath, ["chat", "--help"], 8000);
  return featuresFromHelp(text);
}

async function detect({ refresh = false } = {}) {
  return withDetectCache("hermes", refresh, async () => {
    try {
      const binPath = await resolveBinary("hermes", hermesFallbackPaths());
      if (!binPath) {
        return {
          installed: false,
          path: "",
          version: "",
          features: {},
          error: "hermes was not found on PATH or in common install locations."
        };
      }
      const versionText = await runVersion(binPath);
      const { version, versionFull } = splitVersion(versionText);
      const features = await cachedFeatures(`hermes:${binPath}:${version}`, () => detectFeatures(binPath));
      return { installed: true, path: binPath, version, versionFull, features };
    } catch (error) {
      return { installed: false, path: "", version: "", features: {}, error: error?.message || "Hermes detection failed." };
    }
  });
}

async function configStatus(detected) {
  if (!detected?.installed) {
    return { ok: false, summary: "Hermes is not installed.", problems: [], fixHint: "Install the Hermes CLI, then refresh." };
  }
  const result = await runCommand(detected.path, ["doctor"], DOCTOR_TIMEOUT_MS);
  if (result.ok) {
    return { ok: true, summary: "Hermes doctor reports no problems.", problems: [] };
  }
  const problems = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    ok: false,
    summary: "Hermes doctor found problems.",
    problems,
    fixHint: "Run 'hermes setup' (or use Agent OS Setup) to configure a model provider."
  };
}

async function safetyStatus(detected) {
  if (!detected?.installed) {
    return { permissive: false, summary: "Hermes is not installed.", actions: [] };
  }
  // Never reads ~/.hermes/.env or auth.json: this only asks the CLI for one
  // non-secret config value.
  const result = await runCommand(detected.path, ["config", "get", "approvals.mode"], APPROVALS_TIMEOUT_MS);
  return approvalsSafety(result);
}

// The spellings of "approvals off" that Hermes can print for approvals.mode: a
// config value may be written as a YAML or JSON word, with or without quotes.
// Anything else that was read cleanly counts as on.
const APPROVALS_OFF_WORDS = new Set(["off", "false", "no"]);

// What `hermes config get approvals.mode` printed, one entry per non-empty line:
// trimmed, with one pair of surrounding single or double quotes taken off, in
// lower case. A notice (an update hint, say) can come before the value or after it.
function approvalsLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.length >= 2 && (line[0] === "'" || line[0] === '"') && line.endsWith(line[0]) ? line.slice(1, -1) : line).toLowerCase());
}

// Is approvals.mode off? The one place that decides it, so the Safety screen and
// the Setup warning can never disagree about a spelling. Off wins from ANY line: a
// notice printed after the value must never turn an "off" into "on". Failing open
// here would hide YOLO mode.
export function hermesApprovalsAreOff(stdout) {
  return approvalsLines(stdout).some((line) => APPROVALS_OFF_WORDS.has(line));
}

// The answer for one `hermes config get approvals.mode` result (a runCommand result).
//   - "off" (or "false" or "no", quoted or not, on any line) is permissive (YOLO mode), and is
//     never hidden, even if the command then failed.
//   - A value that was read cleanly is "on" (known: true). With no off line, the last non-empty
//     line is the value, so a notice printed before it is ignored.
//   - A read that failed, timed out, could not start or printed nothing is NOT "on": it is
//     `known: false`, so a screen shows "—" instead of claiming a safeguard it never saw.
// `permissive`, `summary` and `actions` keep their old shape for callers that ignore `known`
// (the Team Room check treats an unread setting like before; it only blocks on permissive).
export function approvalsSafety(result) {
  if (hermesApprovalsAreOff(result?.stdout)) {
    return { permissive: true, summary: "Hermes approvals are off (YOLO mode).", actions: [], known: true };
  }
  const value = approvalsLines(result?.stdout).pop() || "";
  if (!result?.ok || !value) {
    return { permissive: false, summary: "Agent OS could not read Hermes's approvals setting.", actions: [], known: false };
  }
  return { permissive: false, summary: "Hermes approvals are on.", actions: [], known: true };
}

// Hermes v0.20 prints e.g. "✓ Gateway is supervised by launchd (PID 123)"
// rather than the word "running", so a live PID or "supervised" counts too.
export function runningFromText(text) {
  const value = String(text || "");
  if (/not running|not supervised|inactive|stopped/i.test(value)) return false;
  return /running|active|loaded|supervised|\bPID \d+/i.test(value);
}

// Lines Hermes marks with a warning sign, e.g. a stale service definition,
// so the UI can surface them instead of burying them in raw text.
export function warningsFromText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("⚠"))
    .map((line) => line.replace(/^⚠\s*/, ""));
}

const service = {
  async status(detected) {
    if (!detected?.installed) return { running: false, text: "Hermes is not installed.", warnings: [] };
    const result = await runCommand(detected.path, ["gateway", "status"], GATEWAY_STATUS_TIMEOUT_MS);
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return { running: runningFromText(text), text, warnings: warningsFromText(text) };
  },
  start(detected) {
    return {
      agentId: "hermes",
      kind: "service",
      title: "Hermes gateway start",
      command: detected.path,
      args: ["gateway", "start"],
      cwd: os.tmpdir(),
      timeoutMs: GATEWAY_ACTION_TIMEOUT_MS
    };
  },
  stop(detected) {
    return {
      agentId: "hermes",
      kind: "service",
      title: "Hermes gateway stop",
      command: detected.path,
      args: ["gateway", "stop"],
      cwd: os.tmpdir(),
      timeoutMs: GATEWAY_ACTION_TIMEOUT_MS
    };
  },
  restart(detected) {
    return {
      agentId: "hermes",
      kind: "service",
      title: "Hermes gateway restart",
      command: detected.path,
      args: ["gateway", "restart"],
      cwd: os.tmpdir(),
      timeoutMs: GATEWAY_ACTION_TIMEOUT_MS
    };
  }
};

// Request input can never set HERMES_HOME: only the server's own env or its
// local connection store may. When neither is configured, the child inherits
// no HERMES_HOME and the hermes binary falls back to its own default.
async function resolveHermesHome() {
  const stored = await getStoredConnectionConfig();
  const configured =
    getConfiguredValue(stored, "gateway", "HERMES_HOME") || getConfiguredValue(stored, "hermes", "HERMES_HOME");
  return configured ? expandHome(configured) : null;
}

// The only toolset a talk-only turn gets: a planning checklist. Never
// terminal, file, code, browser or computer_use.
const TALK_ONLY_TOOLSETS = "todo";

async function buildRun({ prompt, cwd, detected, runDir, options = {} }) {
  const queryFile = path.join(runDir, "query.txt");
  // The prompt goes to a file, never argv, so it never shows up in `ps` and
  // there is no flag-injection surface from prompt text.
  await fs.writeFile(queryFile, String(prompt ?? ""), { mode: 0o600 });

  const features = detected?.features || {};
  const args = ["chat", "--oneshot", "-Q", "--query-file", queryFile];
  if (features.inDir) args.push("--in", cwd);
  if (features.streamJson) args.push("--format", "stream-json");

  // talkOnly (set by trusted server code, such as the Team Room, never by an
  // HTTP request): the run may only talk. Hermes's default toolsets include a
  // terminal, files and code, so we name the one harmless toolset instead.
  const notices = [];
  if (options.talkOnly) {
    if (features.toolsets) args.push("-t", TALK_ONLY_TOOLSETS);
    else notices.push("This Hermes version can't limit its tools for this turn.");
  }

  const home = await resolveHermesHome();
  const streamJson = Boolean(features.streamJson);

  return {
    agentId: "hermes",
    kind: "agent",
    title: `Hermes chat (${streamJson ? "stream-json" : "plain"} transport)`,
    command: detected.path,
    args,
    cwd: runDir,
    env: home ? { HERMES_HOME: home } : {},
    redact: [home, queryFile].filter(Boolean),
    timeoutMs: RUN_TIMEOUT_MS,
    ...(notices.length ? { notices } : {}),
    parseLine: (line, stream) => parseLine(line, stream, { streamJson }),
    async onExit() {
      await fs.rm(queryFile, { force: true }).catch(() => {});
    }
  };
}

function toolPreview(evt) {
  const name = String(evt?.name || evt?.tool || "tool");
  let argsPreview = "";
  if (evt?.input !== undefined) {
    try {
      argsPreview = JSON.stringify(evt.input).slice(0, 160);
    } catch {
      argsPreview = "";
    }
  }
  return argsPreview ? `${name} ${argsPreview}` : name;
}

// ctx.streamJson tells us which wire format this run used; buildRun's
// closure supplies it, and tests pass it directly.
function parseLine(line, _stream, ctx = {}) {
  if (!ctx.streamJson) {
    return [{ type: "text", text: line }];
  }
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return null; // falls back to the run manager's default {type:"line"}
  }
  if (!evt || typeof evt !== "object") return null;
  switch (evt.type) {
    case "system": {
      // {"type":"system","subtype":"init","model":"...","session_id":"..."}
      const model = typeof evt.model === "string" && evt.model.trim() ? evt.model.trim() : "";
      return [{ type: "system", text: model ? `Model: ${model}` : "Hermes session started.", ...(model ? { model } : {}) }];
    }
    case "text":
      return [{ type: "text", text: String(evt.text ?? "") }];
    case "tool_use":
      return [{ type: "tool", text: toolPreview(evt) }];
    case "tool_result":
      return [{ type: "tool_result", text: String(evt.output ?? evt.text ?? "").slice(0, 500) }];
    case "result": {
      const exitCode = evt.exit_code ?? evt.exitCode ?? null;
      const data = { exit_code: exitCode };
      if (typeof evt.session_id === "string" && evt.session_id) data.session_id = evt.session_id;
      const result = { type: "result", data };
      if (typeof evt.text === "string") result.text = evt.text;
      const events = [result];
      // No cost in the line means the cost is UNKNOWN (a subscription model
      // reports none), so costUsd is left out rather than set to 0.
      const costUsd = evt.cost_usd ?? evt.total_cost_usd ?? evt.costUsd;
      const usage = evt.usage || {};
      const tokens = evt.tokens || {};
      const inputTokens = usage.input_tokens ?? usage.inputTokens ?? tokens.input;
      const outputTokens = usage.output_tokens ?? usage.outputTokens ?? tokens.output;
      const hasCost = typeof costUsd === "number";
      if (hasCost || typeof inputTokens === "number" || typeof outputTokens === "number") {
        const usageEvent = { type: "usage" };
        if (hasCost) usageEvent.costUsd = costUsd;
        if (typeof inputTokens === "number") usageEvent.inputTokens = inputTokens;
        if (typeof outputTokens === "number") usageEvent.outputTokens = outputTokens;
        events.push(usageEvent);
      }
      return events;
    }
    default:
      return null;
  }
}

function safetyAction() {
  return null; // Hermes has no configurable safety action yet.
}

export default {
  id: "hermes",
  label: "Hermes Agent",
  homepage: "https://hermes-agent.nousresearch.com",
  docsUrl: "https://hermes-agent.nousresearch.com/docs",
  license: "MIT",
  detect,
  configStatus,
  safetyStatus,
  buildRun,
  parseLine,
  service,
  safetyAction
};
