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
  withDetectCache
} from "./detect.js";

const DOCTOR_TIMEOUT_MS = 30 * 1000;
const APPROVALS_TIMEOUT_MS = 10 * 1000;
const GATEWAY_STATUS_TIMEOUT_MS = 10 * 1000;
const GATEWAY_ACTION_TIMEOUT_MS = 30 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

async function detectFeatures(binPath) {
  const { text } = await runHelp(binPath, ["chat", "--help"], 5000);
  return {
    queryFile: /--query-file\b/.test(text),
    oneshot: /--oneshot\b/.test(text),
    quiet: /(^|[\s,])(-Q|--quiet)\b/.test(text),
    inDir: /--in\b/.test(text),
    // v0.20.6 has no --format flag at all; v0.21+ adds --format stream-json.
    streamJson: /stream-json/i.test(text)
  };
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
      const version = await runVersion(binPath);
      const features = await cachedFeatures(`hermes:${binPath}:${version}`, () => detectFeatures(binPath));
      return { installed: true, path: binPath, version, features };
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
  const value = String(result.stdout || "").trim().toLowerCase();
  if (value === "off") {
    return { permissive: true, summary: "Hermes approvals are off (YOLO mode).", actions: [] };
  }
  return { permissive: false, summary: "Hermes approvals are on.", actions: [] };
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

async function buildRun({ prompt, cwd, detected, runDir }) {
  const queryFile = path.join(runDir, "query.txt");
  // The prompt goes to a file, never argv, so it never shows up in `ps` and
  // there is no flag-injection surface from prompt text.
  await fs.writeFile(queryFile, String(prompt ?? ""), { mode: 0o600 });

  const features = detected?.features || {};
  const args = ["chat", "--oneshot", "-Q", "--query-file", queryFile];
  if (features.inDir) args.push("--in", cwd);
  if (features.streamJson) args.push("--format", "stream-json");

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
    case "text":
      return [{ type: "text", text: String(evt.text ?? "") }];
    case "tool_use":
      return [{ type: "tool", text: toolPreview(evt) }];
    case "tool_result":
      return [{ type: "tool_result", text: String(evt.output ?? evt.text ?? "").slice(0, 500) }];
    case "result": {
      const exitCode = evt.exit_code ?? evt.exitCode ?? null;
      const events = [{ type: "result", data: { exit_code: exitCode } }];
      const costUsd = evt.cost_usd ?? evt.total_cost_usd ?? evt.costUsd;
      const usage = evt.usage || {};
      const inputTokens = usage.input_tokens ?? usage.inputTokens;
      const outputTokens = usage.output_tokens ?? usage.outputTokens;
      if (typeof costUsd === "number" || typeof inputTokens === "number" || typeof outputTokens === "number") {
        events.push({ type: "usage", costUsd, inputTokens, outputTokens });
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
