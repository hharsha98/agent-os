// How each agent starts in a session (spec "Launch profiles", "Resume per
// agent", "Session kinds"; harness rules H1-H4; planning decisions Q7-Q11):
//   - the person's own binary, from detection (H1); argv only, never a shell;
//   - only the H3 additions, checked again by assertSessionArgvSafe;
//   - the H2 environment from shell-env.js, never a run plan's env or argv
//     (Q11: Cursor's --trust and Hermes' HERMES_HOME must not leak in);
//   - the H4 fullscreen opt-in, read from the stored settings at each launch.
import crypto from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsBlockedFlag } from "../agent-flags.js";
import { getAdapter } from "../agents/index.js";
import {
  LOCAL_CONTEXT_TOKENS,
  SAFE_MODEL_ARG,
  assertSafeClaudeSettings,
  buildClaudeSettings,
  codexBrainArgs,
  keyHelper
} from "../builders/brain-launch.js";
import { hasCursorForceFlag } from "../runs/run-manager.js";
import { withSiblingNodePath } from "../safety.js";
import { managedNodeRoot } from "../setup/managed-node.js";
import { RUNTIME_VERSION, ensurePrivateDir, ensureRuntimeStore, runtimePaths } from "../store.js";
import { SESSION_ID_RE, isSessionId, sessionError } from "./errors.js";
import { checkSessionFolder } from "./folders.js";
import { readSessionSettings } from "./settings.js";
import { getLoginShellEnv, sessionEnv } from "./shell-env.js";

export const SESSION_AGENTS = Object.freeze(["claude", "codex", "cursor", "hermes", "openclaw"]);
// The short names every session message, tab and dialog uses ("Codex", not
// the adapter's "Codex CLI"), so one dialog never names an agent two ways.
export const SESSION_AGENT_LABEL = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  hermes: "Hermes",
  openclaw: "OpenClaw"
});
// Spike S5 checks whether OpenClaw's work honours the folder its TUI starts
// in. Until then (the safe default) no folder is offered or claimed: the TUI
// starts in the person's HOME and the panel says "Set by OpenClaw".
export const OPENCLAW_FOLDER_HONOURED = false;

// The setup kind (plan-brains spec §1, Safety 2): a sign-in command that needs a
// real terminal. Each action names one agent and its one fixed argv; nothing
// from a request reaches it (the route names the action, this table the argv).
// The only action is OpenClaw's official "Sign in with ChatGPT". Every lookup
// goes through ownValue (Object.hasOwn), so prototype names are never actions.
export const OPENCLAW_SIGNIN_ACTION = "openclaw-chatgpt-signin";
export const SETUP_ACTIONS = Object.freeze({
  "openclaw-chatgpt-signin": Object.freeze({
    agentId: "openclaw",
    args: Object.freeze(["models", "auth", "login", "--provider", "openai", "--method", "siwc"])
  })
});

// A crypto.randomUUID() value: Agent OS's session ids and Claude's --session-id.
const UUID = SESSION_ID_RE;
const OPENCLAW_KEY = /^agentos-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The names detection looks for, in its order (cursor.js tries agent first).
const BINARY_NAMES = { claude: ["claude"], codex: ["codex"], cursor: ["agent", "cursor-agent"], hermes: ["hermes"], openclaw: ["openclaw"] };
// Codex's own notifications as OSC 9, so the mirror sees them (spec table).
const CODEX_TUI_OPTIONS = [
  "-c", "tui.notification_method=osc9",
  "-c", 'tui.notifications=["agent-turn-complete","approval-requested"]',
  "-c", "tui.notification_condition=always"
];

// Every per-agent lookup goes through this (ruling R6): a plain `map[id]`
// would take "constructor", "__proto__" or "toString" from Object.prototype.
function ownValue(map, key) {
  return typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined;
}

function hasBrainKeys(brain) {
  return brain?.mode === "openrouter" || brain?.mode === "local";
}

async function findOnPath(names, pathValue) {
  const dirs = String(pathValue || "").split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
  for (const name of names) {
    const candidates = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
    for (const dir of dirs) {
      for (const candidate of candidates) {
        const file = path.join(dir, candidate);
        try {
          if (!(await fs.stat(file)).isFile()) continue;
          if (process.platform !== "win32") await fs.access(file, fsConstants.X_OK);
          return file;
        } catch {
          // not here; keep looking
        }
      }
    }
  }
  return "";
}

// H1: the path detection found. Q8: when detection found nothing, one more
// look over the login shell's PATH (it can hold folders the server's lacks).
async function findAgentCommand(agentId, detected, loginEnv) {
  if (detected?.installed && typeof detected.path === "string" && path.isAbsolute(detected.path)) return detected.path;
  const found = await findOnPath(ownValue(BINARY_NAMES, agentId) || [], loginEnv.PATH ?? loginEnv.Path);
  if (found) return found;
  throw sessionError(
    409,
    "agent_not_installed",
    `${ownValue(SESSION_AGENT_LABEL, agentId)} isn't installed, or Agent OS can't find it. Install it in Setup, then try again.`
  );
}

// Q7: a CLI inside Agent OS's managed Node folder runs on the Node beside it.
function insideManagedNode(command) {
  const fold = (value) => (process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value);
  return fold(path.resolve(command)).startsWith(fold(path.resolve(managedNodeRoot())) + path.sep);
}

// Spec "Launch profiles", Claude Code: <AGENT_OS_HOME>/sessions/<id>/claude-settings.json
// (0600, in a 0700 folder) with only the brain keys, without
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (Q9). It holds the key's read command, never the key.
// Two steps, so that a command line assertSessionArgvSafe refuses leaves
// nothing on disk: prepare builds the settings and works out where the file
// goes (no disk access); write runs once the argv has been accepted.
async function prepareSessionClaudeSettings(sessionId, brain) {
  const settings = buildClaudeSettings(brain, brain.mode === "openrouter" ? await keyHelper() : null, { forSession: true });
  assertSafeClaudeSettings(settings);
  return { settings, file: path.join(runtimePaths().sessions, sessionId, "claude-settings.json") };
}

// Written to a temporary name in the same private folder (0600) and renamed
// into place, so Claude never reads a half-written file, and an older file
// (even one with looser permissions) is replaced by a 0600 one.
async function writeSessionClaudeSettings({ settings, file }) {
  await ensureRuntimeStore();
  const dir = await ensurePrivateDir(path.dirname(file));
  const temp = path.join(dir, `.claude-settings.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await fs.chmod(temp, 0o600);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

// The launch profile for one session start or resume:
// { command, args, cwd, env, agentSessionId, settingsFile, softStop, resumeMode, folderShown, notes }.
// `resume` is null for a fresh start, or { agentSessionId } (from meta.json)
// to continue an ended agent session. `kind: "update"` is `hermes update`.
// `kind: "setup"` runs the `setupAction` entry of SETUP_ACTIONS in HOME.
export async function buildSessionProfile({
  agentId,
  folder,
  sessionId,
  kind = "agent",
  resume = null,
  settings,
  detected,
  brain = null,
  agentOsVersion = RUNTIME_VERSION,
  setupAction = null
} = {}) {
  if (!SESSION_AGENTS.includes(agentId)) throw sessionError(400, "unknown_agent", "Agent OS can't start a session for that agent.");
  if (!isSessionId(sessionId)) throw sessionError(404, "unknown_session", "That session doesn't exist anymore.");
  if (kind !== "agent" && kind !== "update" && kind !== "setup") throw sessionError(400, "unknown_kind", "Agent OS can't start that kind of session.");
  if (kind === "update" && agentId !== "hermes") throw sessionError(400, "update_not_available", "Only Hermes is updated in a session.");
  // A setup session runs exactly one action of SETUP_ACTIONS, for that action's own agent.
  const setup = kind === "setup" ? ownValue(SETUP_ACTIONS, setupAction) : undefined;
  if (kind === "setup" && (!setup || setup.agentId !== agentId)) {
    throw sessionError(400, "unknown_kind", "Agent OS can't start that kind of session.");
  }
  const label = ownValue(SESSION_AGENT_LABEL, agentId);

  const shell = await getLoginShellEnv();
  const command = await findAgentCommand(agentId, detected === undefined ? await getAdapter(agentId).detect() : detected, shell.env);

  let cwd = os.homedir();
  let folderShown = true;
  if (kind === "setup") {
    // The one other exception to the folder policy (plan-brains spec §1): the
    // sign-in works on the agent's own settings, not on a project folder, so it
    // runs in HOME (which the policy refuses) and no folder is shown.
    folderShown = false;
  } else if (kind === "agent" && agentId === "openclaw" && !OPENCLAW_FOLDER_HONOURED) {
    folderShown = false;
  } else {
    const check = await checkSessionFolder(folder);
    if (!check.ok) throw sessionError(400, "folder_refused", check.message, { code: check.code });
    cwd = check.path;
  }

  const current = settings ?? (await readSessionSettings());
  let env = sessionEnv(shell.env, { sessionId, agentOsVersion, claudeFullscreen: current?.claudeFullscreen === true, agentId });
  if (insideManagedNode(command)) env = withSiblingNodePath(command, env);
  // What a shell sets after `cd <folder>`; the login shell's own PWD was dropped.
  env.PWD = cwd;

  // Only a { agentSessionId } object resumes: false, 0, "" or an array start fresh.
  const resuming = kind === "agent" && typeof resume === "object" && resume !== null && !Array.isArray(resume);
  let args;
  let agentSessionId = null;
  let settingsFile = null;
  let pendingSettings = null;
  let softStop = null;
  let resumeMode = null;
  if (kind === "setup") {
    // Exactly the action's argv, as a fresh array. No soft stop (a sign-in has no
    // last step to finish), no resume and no agent session id.
    args = [...setup.args];
  } else if (kind === "update") {
    // Session kinds: exactly `hermes update`, no --yes and no H3 additions.
    args = ["update"];
  } else if (agentId === "claude") {
    if (resuming) {
      if (!isSessionId(resume.agentSessionId)) {
        throw sessionError(409, "not_resumable", `This ${label} conversation can't be resumed.`);
      }
      agentSessionId = resume.agentSessionId;
      args = ["--resume", agentSessionId];
    } else {
      agentSessionId = crypto.randomUUID(); // Q39: a second uuid, separate from the session id
      args = ["--session-id", agentSessionId];
    }
    // H3: --settings only when the file has something to carry (SP3: an OpenRouter or Local brain).
    if (hasBrainKeys(brain)) {
      pendingSettings = await prepareSessionClaudeSettings(sessionId, brain);
      settingsFile = pendingSettings.file;
      args.push("--settings", settingsFile);
    }
    softStop = "claude-bg";
    resumeMode = "id";
  } else if (agentId === "codex") {
    // forSession (Q9b): without Codex's own environment scrub, so its shell tool sees the person's environment as in Terminal (H2).
    const brainArgs = hasBrainKeys(brain) ? codexBrainArgs(brain, brain.mode === "openrouter" ? await keyHelper() : null, { forSession: true }) : [];
    // Fallback resume (until spike S3 confirms an id source): the latest conversation, in the same folder (cwd).
    args = resuming ? ["resume", "--last", ...CODEX_TUI_OPTIONS, ...brainArgs] : ["-C", cwd, ...CODEX_TUI_OPTIONS, ...brainArgs];
    resumeMode = "fallback";
  } else if (agentId === "cursor") {
    // No model option (H3): the person picks models inside Cursor, as in Terminal.
    args = resuming ? ["--resume", "--workspace", cwd] : ["--workspace", cwd];
    resumeMode = "fallback";
  } else if (agentId === "hermes") {
    // The person's configured interface (H4): never a forced --tui.
    args = resuming ? ["--resume", "latest", "--in", cwd] : ["--in", cwd];
    resumeMode = "fallback";
  } else {
    // Resume is the same start command: the key names the conversation.
    agentSessionId = `agentos-${sessionId}`;
    args = ["tui", "--session", agentSessionId];
    softStop = "openclaw-abort";
    resumeMode = "id";
  }
  assertSessionArgvSafe(agentId, args, { kind, setupAction });
  if (pendingSettings) await writeSessionClaudeSettings(pendingSettings);
  return {
    command,
    args,
    cwd,
    env,
    agentSessionId,
    settingsFile,
    softStop,
    resumeMode,
    folderShown,
    notes: shell.notice ? [shell.notice] : []
  };
}

// ---- the H3 check ----------------------------------------------------------------------------

const NEVER = ["--bare", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", "--accept-hooks", "--yolo", "--trust", "--no-alt-screen"];
const NEVER_WORDS = /dangerously|bypass|full-access|skip-permission/i;
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
// Exactly the -c values Agent OS adds: the notification options, then
// codexBrainArgs for a session (OpenRouter or Local). Nothing else may be
// configured: not even shell_environment_policy, which headless runs add but a
// session leaves out (Q9b).
const CODEX_CONFIG = [
  /^tui\.notification_method=osc9$/,
  /^tui\.notifications=\["agent-turn-complete","approval-requested"\]$/,
  /^tui\.notification_condition=always$/,
  /^model_provider="openrouter"$/,
  /^model_providers\.openrouter\.name="OpenRouter"$/,
  /^model_providers\.openrouter\.base_url="https:\/\/openrouter\.ai\/api\/v1"$/,
  /^model_providers\.openrouter\.wire_api="responses"$/,
  new RegExp(`^model_providers\\.openrouter\\.auth=\\{command=${QUOTED}, args=\\[(?:${QUOTED}(?:, ${QUOTED})*)?\\]\\}$`),
  new RegExp(`^model_context_window=${LOCAL_CONTEXT_TOKENS}$`)
];

function isFolderValue(value) {
  return typeof value === "string" && !value.includes("\0") && path.isAbsolute(value);
}

function isSessionSettingsFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const dir = path.dirname(value);
  return path.basename(value) === "claude-settings.json" && UUID.test(path.basename(dir)) && path.dirname(dir) === runtimePaths().sessions;
}

const SHAPES = {
  claude(args) {
    if (args.length !== 2 && args.length !== 4) return false;
    if ((args[0] !== "--session-id" && args[0] !== "--resume") || !UUID.test(args[1])) return false;
    return args.length === 2 || (args[2] === "--settings" && isSessionSettingsFile(args[3]));
  },
  codex(args) {
    let i;
    if (args[0] === "-C" && isFolderValue(args[1])) i = 2;
    else if (args[0] === "resume" && args[1] === "--last") i = 2;
    else return false;
    while (i < args.length) {
      const flag = args[i];
      const value = args[i + 1];
      if (flag === "-c" && CODEX_CONFIG.some((pattern) => pattern.test(String(value)))) i += 2;
      else if (flag === "-m" && SAFE_MODEL_ARG.test(String(value))) i += 2;
      else if (flag === "--local-provider" && value === "ollama") i += 2;
      else if (flag === "--oss") i += 1;
      else return false;
    }
    return true;
  },
  cursor(args) {
    const rest = args[0] === "--resume" ? args.slice(1) : args;
    return rest.length === 2 && rest[0] === "--workspace" && isFolderValue(rest[1]);
  },
  hermes(args) {
    if (args.length === 1) return args[0] === "update";
    const rest = args[0] === "--resume" && args[1] === "latest" ? args.slice(2) : args;
    return rest.length === 2 && rest[0] === "--in" && isFolderValue(rest[1]);
  },
  openclaw(args) {
    return args.length === 3 && args[0] === "tui" && args[1] === "--session" && OPENCLAW_KEY.test(args[2]);
  }
};

function isBlockedWord(word, agentId) {
  const name = word.split("=")[0];
  return containsBlockedFlag(word) || NEVER.includes(name) || NEVER_WORDS.test(word) || (agentId === "hermes" && name === "--tui");
}

// The setup kind's one shape: exactly the action's argv, item by item, for the
// action's own agent (undefined, so refused, for anything else).
function setupShape(agentId, setupAction) {
  const setup = ownValue(SETUP_ACTIONS, setupAction);
  if (!setup || setup.agentId !== agentId) return undefined;
  return (args) => args.length === setup.args.length && args.every((arg, index) => arg === setup.args[index]);
}

// Throws unless `args` is exactly one of the argv shapes above (spec H3: only
// additive options) and holds nothing from the blocked lists. For the setup
// kind (plan-brains Safety 2) the only shape is its action's own argv; every
// other kind keeps SHAPES, so an agent session can never run a sign-in command.
export function assertSessionArgvSafe(agentId, args, { kind = "agent", setupAction = null } = {}) {
  const shape = kind === "setup" ? setupShape(agentId, setupAction) : ownValue(SHAPES, agentId);
  const label = ownValue(SESSION_AGENT_LABEL, agentId) || "this agent";
  const refuse = () =>
    sessionError(500, "unsafe_argv", `Agent OS stopped ${label} from starting: its command line had an option Agent OS never adds.`);
  if (!shape || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw refuse();
  // Option names and a leading subcommand are checked against the blocked
  // lists. Values (folders, ids, model names, Codex -c settings) never start
  // with "-" and are checked by shape instead, so a folder named
  // "--force-demo" or "bypassPermissions" is still allowed.
  const words = args.filter((arg, index) => index === 0 || arg.startsWith("-"));
  if (words.some((word) => isBlockedWord(word, agentId))) throw refuse();
  if (agentId === "cursor" && hasCursorForceFlag({ command: "agent", args })) throw refuse();
  if (!shape(args)) throw refuse();
}
