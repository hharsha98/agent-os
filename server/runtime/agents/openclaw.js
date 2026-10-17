// Adapter for the OpenClaw CLI. OpenClaw is not installed on the dev
// machine, so this is built from the published docs and exercised only
// against fake CLIs in test/agents.test.js; see the deliverable report for
// exactly which flags are assumed.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../safety.js";
import {
  cachedFeatures,
  openclawFallbackPaths,
  resolveBinary,
  runHelp,
  runVersion,
  splitVersion,
  withDetectCache
} from "./detect.js";

const DOCTOR_TIMEOUT_MS = 30 * 1000;
const EXEC_MODE_TIMEOUT_MS = 10 * 1000;
const GATEWAY_STATUS_TIMEOUT_MS = 10 * 1000;
const GATEWAY_ACTION_TIMEOUT_MS = 30 * 1000;
const SAFETY_ACTION_TIMEOUT_MS = 15 * 1000;

// The Gateway transport (`openclaw agent ...`, used while the OpenClaw
// service runs) is read from `openclaw agent --help`; the older stdin transport
// (`openclaw agent exec`) from `openclaw agent exec --help`.
export function gatewayFeaturesFromHelp(text) {
  const raw = String(text ?? "");
  return {
    sessionId: /--session-id\b/.test(raw),
    messageFileGateway: /--message-file\b/.test(raw),
    jsonGateway: /--json\b/.test(raw),
    modelOverride: /--model\b/.test(raw)
  };
}

async function detectFeatures(binPath) {
  const [execHelp, agentHelp] = await Promise.all([
    runHelp(binPath, ["agent", "exec", "--help"], 8000),
    runHelp(binPath, ["agent", "--help"], 8000)
  ]);
  const text = execHelp.text;
  const features = {
    agentExec: execHelp.ok,
    messageFile: /--message-file\b/.test(text),
    cwd: /--cwd\b/.test(text),
    json: /--json\b/.test(text),
    ...gatewayFeaturesFromHelp(agentHelp.text)
  };
  if (!execHelp.text.trim() && !agentHelp.text.trim()) features.helpFailed = true;
  return features;
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
      const versionText = await runVersion(binPath);
      const { version, versionFull } = splitVersion(versionText);
      const features = await cachedFeatures(`openclaw:${binPath}:${version}`, () => detectFeatures(binPath));
      return { installed: true, path: binPath, version, versionFull, features };
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
  },
  restart(detected) {
    return {
      agentId: "openclaw",
      kind: "service",
      title: "OpenClaw gateway restart",
      command: detected.path,
      args: ["gateway", "restart"],
      cwd: os.tmpdir(),
      timeoutMs: GATEWAY_ACTION_TIMEOUT_MS
    };
  }
};

const DEFAULT_SESSION_ID = "agentos-runs";
// Session ids and model ids are passed as ONE argv item (never through a
// shell), but are still limited to a plain alphabet, and a model may not start
// with "-" so it can never be read as a flag.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const OPENCLAW_MODEL_PATTERN = /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$/;
// A reply is JSON in one document; keep a generous but bounded amount of it.
const MAX_COLLECTED_BYTES = 4 * 1024 * 1024;

// checkService defaults to the real gateway status check; adapter unit tests
// pass a stub here so buildRun stays testable without a real binary/PATH,
// including on Windows where the fake CLIs' shebangs cannot run directly.
//
// options (set by trusted server code, never an HTTP request):
//   sessionId  which OpenClaw conversation to use (the Team Room gives each
//              room its own, so it never touches your main one)
//   model      a model override for this run, e.g. "ollama/phi4"
async function buildRun({ prompt, cwd, detected, runDir, options = {}, checkService = service.status }) {
  const features = detected?.features || {};
  const status = await checkService(detected);

  if (status?.running && features.messageFileGateway) {
    // The prompt goes into a file, never argv, so it never shows in `ps`.
    // agent exec refuses to run while a gateway owns the state dir, so the
    // gateway's own `agent` command is used, on its own session.
    const messageFile = path.join(runDir, "message.txt");
    await fs.writeFile(messageFile, String(prompt ?? ""), { mode: 0o600 });
    const notices = [];
    const args = ["agent"];
    if (features.sessionId) {
      const wanted = typeof options.sessionId === "string" ? options.sessionId : "";
      args.push("--session-id", SESSION_ID_PATTERN.test(wanted) ? wanted : DEFAULT_SESSION_ID);
    } else {
      notices.push("This OpenClaw version can't use a separate conversation, so this turn shares your main OpenClaw session.");
    }
    args.push("--message-file", messageFile);
    if (features.jsonGateway) args.push("--json");
    if (typeof options.model === "string" && options.model) {
      if (features.modelOverride && OPENCLAW_MODEL_PATTERN.test(options.model)) args.push("--model", options.model);
      else notices.push("This OpenClaw version can't switch models for one run, so it used its own model setting.");
    }
    const plan = {
      agentId: "openclaw",
      kind: "agent",
      title: "OpenClaw agent (gateway transport)",
      command: detected.path,
      args,
      cwd: runDir,
      redact: [messageFile],
      timeoutMs: 30 * 60 * 1000,
      ...(notices.length ? { notices } : {}),
      async onExit() {
        await fs.rm(messageFile, { force: true }).catch(() => {});
      }
    };
    if (features.jsonGateway) Object.assign(plan, wholeDocumentParser());
    return plan;
  }

  if (!status?.running && features.agentExec && features.messageFile) {
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
      // --json prints one envelope; parseLine turns it into a result + usage.
      parseLine,
      timeoutMs: 30 * 60 * 1000
    };
  }

  if (!status?.running && features.agentExec) {
    return {
      agentId: "openclaw",
      kind: "agent",
      title: "OpenClaw agent exec (argv transport)",
      command: detected.path,
      args: ["agent", "exec", "--json", "--", prompt],
      cwd: runDir,
      parseLine,
      timeoutMs: 30 * 60 * 1000
    };
  }

  // Old versions only: the prompt has to go on the command line, and the run
  // shares the user's main OpenClaw session.
  return {
    agentId: "openclaw",
    kind: "agent",
    title: status?.running ? "OpenClaw agent -m (gateway transport)" : "OpenClaw agent -m (legacy transport)",
    command: detected.path,
    args: ["agent", "-m", prompt],
    cwd: runDir,
    notices: [
      "This OpenClaw version can't read the prompt from a file, so it is passed on the command line and the run shares your main OpenClaw session."
    ],
    timeoutMs: 30 * 60 * 1000
  };
}

// ---------------------------------------------------------------------------
// Gateway output: ONE pretty-printed JSON document over many lines
// ---------------------------------------------------------------------------

// Returns { parseLine, onOutputEnd } sharing one buffer: parseLine collects
// stdout (and drops each line from the log), onOutputEnd parses the whole
// document once the run's output has ended. stderr (the ExperimentalWarning
// and "Retrying with ..." noise) is left alone and stays ordinary stderr lines.
function wholeDocumentParser() {
  const lines = [];
  let bytes = 0;
  let overflow = false;
  return {
    parseLine(line, stream) {
      if (stream !== "stdout") return null;
      if (overflow) return false;
      bytes += line.length + 1;
      if (bytes > MAX_COLLECTED_BYTES) {
        overflow = true;
        return false;
      }
      lines.push(line);
      return false;
    },
    onOutputEnd() {
      const collected = lines.splice(0);
      if (!collected.length && !overflow) return null;
      const doc = overflow ? null : parseDocument(collected);
      if (!doc) {
        // Not the JSON we expected: keep what was printed, as plain lines, so
        // nothing is lost (the Team Room reads these as the reply).
        const kept = collected.filter((line) => line.trim()).slice(-200);
        const events = kept.map((line) => ({ type: "line", text: line }));
        if (overflow) events.push({ type: "system", text: "OpenClaw printed more output than Agent OS keeps, so the reply was not read." });
        return events;
      }
      return eventsFromDocument(doc);
    }
  };
}

// Whole text first; failing that, from the first line that opens an object
// (a CLI may print a warning line before the JSON).
function parseDocument(collected) {
  const whole = parseJsonLoose(collected.join("\n"));
  if (whole && typeof whole === "object") return whole;
  const start = collected.findIndex((line) => line.trimStart().startsWith("{"));
  if (start > 0) {
    const tail = parseJsonLoose(collected.slice(start).join("\n"));
    if (tail && typeof tail === "object") return tail;
  }
  return null;
}

// Exported for tests. Field paths follow a real OpenClaw 2026.9.6 run:
//   status, result.payloads[].text, result.meta.finalAssistantVisibleText,
//   result.meta.agentMeta.{provider,model,usage,costUsd}, result.meta.toolSummary
export function eventsFromDocument(doc) {
  const result = doc?.result && typeof doc.result === "object" ? doc.result : {};
  const meta = result.meta && typeof result.meta === "object" ? result.meta : {};
  const agentMeta = meta.agentMeta && typeof meta.agentMeta === "object" ? meta.agentMeta : {};
  const events = [];

  const model = [agentMeta.provider, agentMeta.model].filter((part) => typeof part === "string" && part).join("/");
  if (model) events.push({ type: "system", text: `Model: ${model}`, model });

  const tools = meta.toolSummary;
  if (tools && typeof tools === "object" && Number(tools.calls) > 0) {
    const calls = Number(tools.calls);
    const failures = Number(tools.failures) || 0;
    const plural = calls === 1 ? "" : "s";
    events.push({
      type: "system",
      text: failures > 0 ? `OpenClaw tried ${calls} tool call${plural}; ${failures} failed.` : `OpenClaw used ${calls} tool call${plural}.`,
      data: { toolCalls: calls, toolFailures: failures }
    });
  }

  const status = typeof doc?.status === "string" ? doc.status : "";
  if (status && status !== "ok") {
    const summary = typeof doc.summary === "string" && doc.summary ? ` (${doc.summary})` : "";
    events.push({ type: "error", text: `OpenClaw reported status "${status}"${summary}.` });
  }

  const payloadTexts = Array.isArray(result.payloads)
    ? result.payloads.map((payload) => (typeof payload?.text === "string" ? payload.text.trim() : "")).filter(Boolean)
    : [];
  const text = payloadTexts.length
    ? payloadTexts.join("\n\n")
    : typeof meta.finalAssistantVisibleText === "string"
      ? meta.finalAssistantVisibleText.trim()
      : "";
  events.push({ type: "result", text, data: { ok: status === "ok", status: status || null } });

  // A cost of 0 is a real "free", so only a missing number means unknown.
  const costUsd =
    typeof agentMeta.costUsd === "number"
      ? agentMeta.costUsd
      : typeof agentMeta.usage?.cost?.total === "number"
        ? agentMeta.usage.cost.total
        : undefined;
  const usage = agentMeta.usage && typeof agentMeta.usage === "object" ? agentMeta.usage : {};
  const inputTokens = usage.input ?? usage.inputTokens;
  const outputTokens = usage.output ?? usage.outputTokens;
  if (typeof costUsd === "number" || typeof inputTokens === "number" || typeof outputTokens === "number") {
    const usageEvent = { type: "usage" };
    if (typeof costUsd === "number") usageEvent.costUsd = costUsd;
    if (typeof inputTokens === "number") usageEvent.inputTokens = inputTokens;
    if (typeof outputTokens === "number") usageEvent.outputTokens = outputTokens;
    events.push(usageEvent);
  }
  return events;
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

// no-browser-cookies needs a gateway restart to take effect (the real CLI
// prints "Restart the gateway to apply"); exec-ask applies without one (the
// real CLI prints "will apply without restarting the gateway").
const SAFETY_ACTIONS = {
  "exec-ask": { setting: ["tools.exec.mode", "ask"], restartsGateway: false },
  "no-browser-cookies": { setting: ["browser.allowSystemProfileImport", "false"], restartsGateway: true }
};

function safetyAction(actionId, detected) {
  const action = SAFETY_ACTIONS[actionId];
  if (!action) return null;
  const { setting, restartsGateway } = action;
  return {
    agentId: "openclaw",
    kind: "service",
    title: `OpenClaw config set ${setting[0]} ${setting[1]}`,
    command: detected.path,
    args: ["config", "set", ...setting],
    cwd: os.tmpdir(),
    timeoutMs: SAFETY_ACTION_TIMEOUT_MS,
    restartsGateway
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
