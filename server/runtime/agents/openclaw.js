// Adapter for the OpenClaw CLI. OpenClaw is not installed on the dev
// machine, so this is built from the published docs and exercised only
// against fake CLIs in test/agents.test.js; see the deliverable report for
// exactly which flags are assumed.
import os from "node:os";
import { runCommand } from "../safety.js";
import {
  cachedFeatures,
  openclawFallbackPaths,
  resolveBinary,
  runHelp,
  runVersion,
  withDetectCache
} from "./detect.js";

const DOCTOR_TIMEOUT_MS = 30 * 1000;
const EXEC_MODE_TIMEOUT_MS = 10 * 1000;
const GATEWAY_STATUS_TIMEOUT_MS = 10 * 1000;
const GATEWAY_ACTION_TIMEOUT_MS = 30 * 1000;
const SAFETY_ACTION_TIMEOUT_MS = 15 * 1000;

async function detectFeatures(binPath) {
  const { ok, text } = await runHelp(binPath, ["agent", "exec", "--help"], 5000);
  return {
    agentExec: ok,
    messageFile: /--message-file\b/.test(text),
    cwd: /--cwd\b/.test(text),
    json: /--json\b/.test(text)
  };
}

async function detect({ refresh = false } = {}) {
  return withDetectCache("openclaw", refresh, async () => {
    try {
      const binPath = await resolveBinary("openclaw", openclawFallbackPaths());
      if (!binPath) {
        return {
          installed: false,
          path: "",
          version: "",
          features: {},
          error: "openclaw was not found on PATH or in common install locations."
        };
      }
      const version = await runVersion(binPath);
      const features = await cachedFeatures(`openclaw:${binPath}:${version}`, () => detectFeatures(binPath));
      return { installed: true, path: binPath, version, features };
    } catch (error) {
      return { installed: false, path: "", version: "", features: {}, error: error?.message || "OpenClaw detection failed." };
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
    return { ok: false, summary: "OpenClaw is not installed.", problems: [], fixHint: "Install the OpenClaw CLI, then refresh." };
  }
  const doctor = await runCommand(detected.path, ["doctor", "--json"], DOCTOR_TIMEOUT_MS);
  // openclaw doctor --json always exits 0; the ok field is the real signal.
  const doctorJson = parseJsonLoose(doctor.stdout);
  if (doctorJson && typeof doctorJson.ok === "boolean") {
    const problems = Array.isArray(doctorJson.findings)
      ? doctorJson.findings.map((finding) => String(finding?.message || "")).filter(Boolean).slice(0, 5)
      : [];
    return {
      ok: doctorJson.ok,
      summary: doctorJson.ok ? "OpenClaw doctor reports no problems." : "OpenClaw doctor found problems.",
      problems
    };
  }
  const status = await runCommand(detected.path, ["status", "--json"], DOCTOR_TIMEOUT_MS);
  const statusJson = parseJsonLoose(status.stdout);
  if (statusJson) {
    const ok = Boolean(statusJson.ok);
    return {
      ok,
      summary: ok ? "OpenClaw status looks ok." : "OpenClaw status reports a problem.",
      problems: ok ? [] : [String(statusJson.error || statusJson.message || "OpenClaw status reported a problem.")]
    };
  }
  return { ok: false, summary: "Could not read OpenClaw status.", problems: [] };
}

async function safetyStatus(detected) {
  if (!detected?.installed) {
    return { permissive: false, summary: "OpenClaw is not installed.", actions: [] };
  }
  const result = await runCommand(detected.path, ["config", "get", "tools.exec.mode"], EXEC_MODE_TIMEOUT_MS);
  const value = String(result.stdout || "").trim().toLowerCase();
  // A missing value defaults to "full" upstream, which is the permissive one.
  if (!value || value === "full") {
    return {
      permissive: true,
      summary: "OpenClaw can run commands without asking (tools.exec.mode = full).",
      actions: [
        {
          id: "exec-ask",
          label: "Make OpenClaw ask before running commands",
          description: "Sets tools.exec.mode to ask, so OpenClaw prompts before running shell commands."
        }
      ]
    };
  }
  return { permissive: false, summary: `OpenClaw tools.exec.mode is "${value}".`, actions: [] };
}

function runningFromText(text) {
  const value = String(text || "");
  if (/not running|inactive|stopped/i.test(value)) return false;
  return /running|active|loaded/i.test(value);
}

const service = {
  async status(detected) {
    if (!detected?.installed) return { running: false, text: "OpenClaw is not installed." };
    const result = await runCommand(detected.path, ["gateway", "status", "--json"], GATEWAY_STATUS_TIMEOUT_MS);
    const parsed = parseJsonLoose(result.stdout);
    if (parsed && typeof parsed.running === "boolean") {
      return { running: parsed.running, text: result.stdout || result.stderr || "" };
    }
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return { running: runningFromText(text), text };
  },
  start(detected) {
    return {
      agentId: "openclaw",
      kind: "service",
      title: "OpenClaw gateway start",
      command: detected.path,
      args: ["gateway", "start"],
      cwd: os.tmpdir(),
      timeoutMs: GATEWAY_ACTION_TIMEOUT_MS
    };
  },
  stop(detected) {
    return {
      agentId: "openclaw",
      kind: "service",
      title: "OpenClaw gateway stop",
      command: detected.path,
      args: ["gateway", "stop"],
      cwd: os.tmpdir(),
      timeoutMs: GATEWAY_ACTION_TIMEOUT_MS
    };
  }
};

// checkService defaults to the real gateway status check; adapter unit tests
// pass a stub here so buildRun stays testable without a real binary/PATH,
// including on Windows where the fake CLIs' shebangs cannot run directly.
async function buildRun({ prompt, cwd, detected, runDir, checkService = service.status }) {
  const features = detected?.features || {};
  const status = await checkService(detected);

  if (status?.running) {
    // agent exec refuses to run while a gateway owns the state dir.
    return {
      agentId: "openclaw",
      kind: "agent",
      title: "OpenClaw agent -m (gateway transport)",
      command: detected.path,
      args: ["agent", "-m", prompt],
      cwd: runDir,
      timeoutMs: 30 * 60 * 1000
    };
  }

  if (features.agentExec && features.messageFile) {
    const args = ["agent", "exec", "--message-file", "-", "--json"];
    if (features.cwd) args.push("--cwd", cwd);
    return {
      agentId: "openclaw",
      kind: "agent",
      title: "OpenClaw agent exec (stdin transport)",
      command: detected.path,
      args,
      cwd: runDir,
      stdin: prompt,
      timeoutMs: 30 * 60 * 1000
    };
  }

  if (features.agentExec) {
    return {
      agentId: "openclaw",
      kind: "agent",
      title: "OpenClaw agent exec (argv transport)",
      command: detected.path,
      args: ["agent", "exec", "--json", "--", prompt],
      cwd: runDir,
      timeoutMs: 30 * 60 * 1000
    };
  }

  return {
    agentId: "openclaw",
    kind: "agent",
    title: "OpenClaw agent -m (legacy transport)",
    command: detected.path,
    args: ["agent", "-m", prompt],
    cwd: runDir,
    timeoutMs: 30 * 60 * 1000
  };
}

// The envelope has ok/final/usage/costUsd/sessionId fields per the docs.
// Usage is reported as flat costUsd/inputTokens/outputTokens, matching the
// run manager's accumulateUsage() contract (server/runtime/runs/run-manager.js),
// so a run's totals actually add up.
function parseLine(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object" || (evt.ok === undefined && evt.final === undefined)) {
    return null;
  }
  const events = [
    { type: "result", text: String(evt.final ?? ""), data: { ok: Boolean(evt.ok), status: evt.status ?? null } }
  ];
  const usage = evt.usage || {};
  const costUsd = typeof evt.costUsd === "number" ? evt.costUsd : usage.costUsd;
  const inputTokens = usage.inputTokens ?? usage.input_tokens;
  const outputTokens = usage.outputTokens ?? usage.output_tokens;
  if (typeof costUsd === "number" || typeof inputTokens === "number" || typeof outputTokens === "number") {
    events.push({ type: "usage", costUsd, inputTokens, outputTokens });
  }
  return events;
}

function safetyAction(actionId, detected) {
  if (actionId !== "exec-ask") return null;
  return {
    agentId: "openclaw",
    kind: "service",
    title: "OpenClaw config set tools.exec.mode ask",
    command: detected.path,
    args: ["config", "set", "tools.exec.mode", "ask"],
    cwd: os.tmpdir(),
    timeoutMs: SAFETY_ACTION_TIMEOUT_MS
  };
}

export default {
  id: "openclaw",
  label: "OpenClaw",
  homepage: "https://openclaw.dev",
  docsUrl: "https://openclaw.dev/docs",
  license: "unknown",
  detect,
  configStatus,
  safetyStatus,
  buildRun,
  parseLine,
  service,
  safetyAction
};
