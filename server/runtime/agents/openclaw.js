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

// Doctor findings that are not real problems on a single-user desktop.
// Seen on a real OpenClaw 2026.9.6 install.
const ADVISORY_FINDINGS = [
  {
    pattern: /bound to loopback/i,
    explain: "(This is the safer setting: only this computer can reach the gateway. Agent OS leaves it as is.)"
  },
  {
    pattern: /plaintext secret-bearing config/i,
    explain: "(OpenClaw keeps some settings, such as its gateway token, in plain text in ~/.openclaw/openclaw.json.)"
  },
  {
    pattern: /allowSystemProfileImport/i,
    explain: "(See Safety: Agent OS can turn this off.)"
  }
];

async function configStatus(detected) {
  if (!detected?.installed) {
    return { ok: false, summary: "OpenClaw is not installed.", problems: [], fixHint: "Install the OpenClaw CLI, then refresh." };
  }
  const doctor = await runCommand(detected.path, ["doctor", "--json"], DOCTOR_TIMEOUT_MS);
  // openclaw doctor --json always exits 0; the ok field is the real signal.
  const doctorJson = parseJsonLoose(doctor.stdout);
  if (doctorJson && typeof doctorJson.ok === "boolean") {
    const findings = Array.isArray(doctorJson.findings)
      ? doctorJson.findings.map((finding) => String(finding?.message || "")).filter(Boolean)
      : [];
    const problems = [];
    const notes = [];
    for (const message of findings) {
      const advisory = ADVISORY_FINDINGS.find((rule) => rule.pattern.test(message));
      if (advisory) notes.push(`${message} ${advisory.explain}`);
      else problems.push(message);
    }
    // Doctor also flags things that are fine (or deliberately safer) for a
    // single-user desktop, so "ok" only means no real problems remain.
    const ok = doctorJson.ok || problems.length === 0;
    return {
      ok,
      summary: ok ? "OpenClaw is set up." : "OpenClaw doctor found problems.",
      problems: problems.slice(0, 5),
      notes: notes.slice(0, 5)
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
  const [execResult, cookieResult] = await Promise.all([
    runCommand(detected.path, ["config", "get", "tools.exec.mode"], EXEC_MODE_TIMEOUT_MS),
    runCommand(detected.path, ["config", "get", "browser.allowSystemProfileImport"], EXEC_MODE_TIMEOUT_MS)
  ]);
  const actions = [];
  const summaries = [];
  const execValue = configValue(execResult.stdout);
  // A missing value defaults to "full" upstream, which is the permissive one.
  if (!execValue || execValue === "full") {
    summaries.push("OpenClaw can run commands without asking (tools.exec.mode = full).");
    actions.push({
      id: "exec-ask",
      label: "Make OpenClaw ask before running commands",
      description: "Sets tools.exec.mode to ask, so OpenClaw prompts before running shell commands."
    });
  } else {
    summaries.push(`OpenClaw tools.exec.mode is "${execValue}".`);
  }
  // Unset means the upstream default, which allows importing cookies from
  // the user's system browser profile.
  const cookieValue = configValue(cookieResult.stdout);
  if (cookieValue !== "false") {
    summaries.push("OpenClaw may import cookies (logged-in sessions) from your system browser profile.");
    actions.push({
      id: "no-browser-cookies",
      label: "Stop OpenClaw importing browser cookies",
      description: "Sets browser.allowSystemProfileImport to false, so OpenClaw cannot copy logins from your browser."
    });
  }
  return { permissive: actions.length > 0, summary: summaries.join(" "), actions };
}

// `config get` prints a sentence instead of a value when the path is unset.
function configValue(stdout) {
  const value = String(stdout || "").trim().split("\n").pop().trim().toLowerCase();
  return /unset|not set|no value/.test(value) ? "" : value;
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

const SAFETY_ACTIONS = {
  "exec-ask": ["tools.exec.mode", "ask"],
  "no-browser-cookies": ["browser.allowSystemProfileImport", "false"]
};

function safetyAction(actionId, detected) {
  const setting = SAFETY_ACTIONS[actionId];
  if (!setting) return null;
  return {
    agentId: "openclaw",
    kind: "service",
    title: `OpenClaw config set ${setting[0]} ${setting[1]}`,
    command: detected.path,
    args: ["config", "set", ...setting],
    cwd: os.tmpdir(),
    timeoutMs: SAFETY_ACTION_TIMEOUT_MS
  };
}

export default {
  id: "openclaw",
  label: "OpenClaw",
  homepage: "https://openclaw.ai",
  docsUrl: "https://docs.openclaw.ai",
  license: "MIT",
  detect,
  configStatus,
  safetyStatus,
  buildRun,
  parseLine,
  service,
  safetyAction
};
