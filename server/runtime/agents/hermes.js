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
const SAFETY_ACTION_TIMEOUT_MS = 15 * 1000;
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

// The one reviewer rule Agent OS writes into Hermes's `approvals.smart_policy`
// (a text of operator rules that Hermes adds to its smart-mode reviewer's
// instructions; ESCALATE means "ask the human"). It has no colon on purpose:
// it is passed to `hermes config set` as one plain argument and compared back
// against what `hermes config get` prints, so nothing in it can be read as
// YAML. Agent OS writes it only on the person's click, and never over a rule
// the person wrote themselves.
export const HERMES_DELETE_RULE =
  "Always ESCALATE any command that deletes or overwrites files, folders or data, such as rm, rmdir, unlink, find -delete, git clean, git reset --hard, and dropping, truncating or deleting databases or tables.";

const ASK_RISKY_CHOICE = {
  id: "ask-risky",
  label: "Ask only for risky commands",
  description:
    "Sets approvals.mode to smart, Hermes's own reviewer mode: it lets routine commands run and asks you about risky ones. Agent OS also adds one rule to its reviewer: always ask before deleting."
};

const ASK_BEFORE_DELETE_CHOICE = {
  id: "ask-before-delete",
  label: "Always ask before deleting",
  description: "Adds one rule to Hermes's reviewer: always ask before a command deletes files, folders or databases."
};

async function safetyStatus(detected) {
  if (!detected?.installed) {
    return { permissive: false, summary: "Hermes is not installed.", actions: [] };
  }
  // Never reads ~/.hermes/.env or auth.json: this only asks the CLI for two
  // non-secret config values, both at once. Both go to the same Hermes profile
  // the writes and chat runs use (HERMES_HOME from the server's own environment,
  // else the stored connection value), so what is read is what a click changes.
  const home = await resolveHermesHome();
  const readOptions = { env: home ? { ...process.env, HERMES_HOME: home } : process.env };
  const [result, policyResult] = await Promise.all([
    runCommand(detected.path, ["config", "get", "approvals.mode"], APPROVALS_TIMEOUT_MS, readOptions),
    runCommand(detected.path, ["config", "get", "approvals.smart_policy"], APPROVALS_TIMEOUT_MS, readOptions)
  ]);
  // `choices` are optional switches (never a finding, so `permissive` stays as
  // approvalsSafety gives it); `notes` are calm facts shown with an info mark.
  const status = { ...approvalsSafety(result), choices: [], notes: [] };
  // Off (on any line) and a setting that could not be read keep approvalsSafety's
  // answer as it is, and so does any mode word other than manual and smart.
  if (status.permissive || status.known === false) return status;
  const mode = approvalsLines(result.stdout).pop();
  if (mode !== "manual" && mode !== "smart") return status;

  status.notes.push('Hermes asks in its own terminal. Agent OS marks the session "May need you" when it does.');
  // The policy counts as read only when the read succeeded and printed at most one
  // non-empty line: none is an empty policy, one is the value. Anything else (a
  // failed or timed-out read, or two or more lines: a notice, or a policy written
  // over several lines) is "unknown" (null). Then nothing is offered, because
  // writing the rule could replace a rule of the person's own that was never seen,
  // and a notice must never make Agent OS say the person has rules of their own.
  const policyLines = policyResult.ok ? approvalsLines(policyResult.stdout) : [];
  const policy = policyResult.ok && policyLines.length <= 1 ? (policyLines[0] ?? "") : null;
  const hasRule = policy === HERMES_DELETE_RULE.toLowerCase();
  const isEmpty = policy === "";
  if (mode === "manual") {
    status.summary = "Hermes asks you about every command its checks flag (approvals.mode = manual).";
    if (isEmpty || hasRule) status.choices.push(ASK_RISKY_CHOICE);
  } else if (hasRule) {
    status.summary =
      "Hermes runs routine commands on its own and asks only for risky ones, always before deleting (approvals.mode = smart).";
  } else if (policy === null || isEmpty) {
    status.summary =
      "Hermes runs routine commands on its own; its reviewer decides which risky ones to ask about (approvals.mode = smart).";
    if (isEmpty) status.choices.push(ASK_BEFORE_DELETE_CHOICE);
  } else {
    // The person's own rules: Agent OS never overwrites them.
    status.summary =
      "Hermes runs routine commands on its own; its reviewer also follows your own rules (approvals.mode = smart).";
  }
  return status;
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

// One `hermes config set <key> <value>` run. Argv only, never a shell, so the
// rule text needs no quoting. Hermes reloads config.yaml by itself (it keys its
// cache on the file's modified time), so none of these restarts anything. A
// started run gets only a short list of environment variables, so the profile
// (HERMES_HOME) is passed on explicitly, exactly as a chat run does, and kept out
// of the command preview.
function configSetPlan(detected, home, title, key, value) {
  return {
    agentId: "hermes",
    kind: "service",
    title,
    command: detected.path,
    args: ["config", "set", key, value],
    cwd: os.tmpdir(),
    env: home ? { HERMES_HOME: home } : {},
    redact: [home].filter(Boolean),
    timeoutMs: SAFETY_ACTION_TIMEOUT_MS,
    restartsGateway: false
  };
}

// Builds the plan for an id from safetyStatus()'s `choices` (async: it looks up
// the Hermes profile, the same one safetyStatus() read).
//   ask-before-delete: writes the delete rule.
//   ask-risky: writes the rule first, then (as `then`, started only if that
//   succeeded) switches approvals.mode to smart, so Hermes is never in smart
//   mode without the rule.
async function safetyAction(actionId, detected) {
  if (actionId !== "ask-before-delete" && actionId !== "ask-risky") return null;
  const home = await resolveHermesHome();
  const writeRule = configSetPlan(
    detected,
    home,
    "Hermes config set approvals.smart_policy",
    "approvals.smart_policy",
    HERMES_DELETE_RULE
  );
  if (actionId === "ask-before-delete") return writeRule;
  return {
    ...writeRule,
    then: {
      ...configSetPlan(detected, home, "Hermes config set approvals.mode smart", "approvals.mode", "smart"),
      note: "Switching Hermes to smart mode…"
    }
  };
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
