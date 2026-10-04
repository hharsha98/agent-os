// Signing in to the three coding agents (Claude Code, Codex, Cursor). Each has
// its own login command that opens the browser; this module runs that command
// as a visible run and asks the agent ITSELF whether it is signed in.
//
// Two promises, both tested:
//  * It never opens an agent's credential files (~/.claude, ~/.codex,
//    ~/.cursor, auth.json). "Signed in?" is the agent's own status command.
//  * It never returns, logs or stores a token. What leaves this module is one
//    of three words, a fixed sentence, and the last few lines of the login
//    command's own output with anything long and opaque hidden.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTERS } from "../agents/index.js";
import { childEnv } from "../live-chat.js";
import { getRunManager } from "../runs/run-manager.js";
import { redactText, runCommand } from "../safety.js";
import { runtimePaths } from "../store.js";

export const SIGNIN_AGENT_IDS = ["claude", "codex", "cursor"];

// A login waits for a person to finish in a browser, so it gets longer than
// any install step; Cancel stops it sooner.
const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10 * 1000;
const SHOWN_LINES = 12;
const MAX_LINE_CHARS = 300;
const TERMINAL_FILE_MAX_AGE_MS = 60 * 60 * 1000;

// Verified against each CLI's own --help and the vendor's docs on 2026-10-04:
//   claude  `claude auth login` / `claude auth status` (JSON; exit 0 when signed in)
//   codex   `codex login` / `codex login status` (exit 0 when signed in)
//   cursor  `agent login` / `agent status` (prints "Not logged in" when signed out)
// `hosts` are the only places a sign-in link printed by the command may point
// at; anything else is never offered as a link.
const SIGNIN = {
  claude: {
    label: "Claude Code",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    hosts: ["claude.ai", "claude.com", "anthropic.com"],
    cost:
      "Needs a paid Claude plan (Pro, Max, Team or Enterprise) or an Anthropic API key. The free Claude.ai plan doesn't include Claude Code."
  },
  codex: {
    label: "Codex",
    loginArgs: ["login"],
    statusArgs: ["login", "status"],
    hosts: ["openai.com", "chatgpt.com"],
    cost: "Sign in with ChatGPT (what you get depends on your ChatGPT plan) or use an OpenAI API key (you pay per use)."
  },
  cursor: {
    label: "Cursor CLI",
    loginArgs: ["login"],
    statusArgs: ["status"],
    hosts: ["cursor.com", "cursor.sh"],
    cost: "Needs a Cursor account. What it can do depends on your Cursor plan."
  }
};

function signInError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function definition(agentId) {
  const def = SIGNIN[agentId];
  if (!def) throw signInError("invalid_agent", "Sign-in is only available for Claude Code, Codex and Cursor.");
  return def;
}

// The latest sign-in run per agent that THIS process started, and the agents
// whose run is being created right now (so a double click can't start two).
const latestRun = new Map(); // agentId -> run id
const starting = new Set();

// ---- is it signed in? -----------------------------------------------------------

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const signedIn = (note) => ({ status: "signed_in", note });
const notSignedIn = (label) => ({ status: "not_signed_in", note: `Not signed in to ${label} yet.` });
const unknown = (note) => ({ status: "unknown", note });

// `claude auth status` prints JSON whose `authMethod` says how; only these
// fixed sentences are shown, never the account name or e-mail next to it.
const CLAUDE_METHOD_NOTE = {
  "claude.ai": "Signed in with your Claude account.",
  oauth_token: "Signed in with a long-lived Claude sign-in token.",
  api_key: "Using an Anthropic API key.",
  api_key_helper: "Using an Anthropic API key.",
  third_party: "Using Claude through Amazon Bedrock, Google Cloud or Microsoft Foundry."
};

// What each agent's status output means. `result` is runCommand's answer
// ({ ok, code, signal, stdout, stderr }); the output itself is never passed on.
export function interpretStatus(agentId, result) {
  const label = definition(agentId).label;
  // The command did not run to completion (missing, timed out, killed).
  if (result.signal || typeof result.code === "string") {
    return unknown(`Couldn't check whether ${label} is signed in. Try again in a moment.`);
  }
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;

  if (agentId === "claude") {
    const parsed = parseJson(result.stdout);
    if (parsed && typeof parsed.loggedIn === "boolean") {
      return parsed.loggedIn ? signedIn(CLAUDE_METHOD_NOTE[parsed.authMethod] || "Signed in.") : notSignedIn(label);
    }
    // The docs: exit 0 when signed in, 1 when not. But an older Claude Code
    // without `auth status` also exits 1, so a bare 1 is only believed with words.
    if (result.ok) return signedIn("Signed in.");
    if (/not (logged|signed) in|logged out/i.test(text)) return notSignedIn(label);
    return unknown("This version of Claude Code can't report its sign-in. Sign in, then open Claude Code once to check.");
  }

  if (agentId === "codex") {
    // "Not logged in" contains "logged in", so the negative is checked first.
    if (/not (logged|signed) in|logged out|no credentials/i.test(text)) return notSignedIn(label);
    if (result.ok) {
      if (/chatgpt/i.test(text)) return signedIn("Signed in with ChatGPT.");
      if (/api key/i.test(text)) return signedIn("Using an OpenAI API key.");
      return signedIn("Signed in.");
    }
    return unknown("Couldn't tell whether Codex is signed in. Sign in, then open Codex once to check.");
  }

  // Cursor: the exit code is not documented, the words are.
  if (/not (logged|signed) in|not authenticated|unauthenticated|logged out|(log|sign) in first/i.test(text)) {
    return notSignedIn(label);
  }
  if (result.ok && /\b(logged|signed) in\b|(^|[^a-z])authenticated\b/i.test(text)) return signedIn("Signed in to Cursor.");
  return unknown("Couldn't tell whether Cursor is signed in. Sign in, then open Cursor's agent once to check.");
}

// Asks the agent itself (never its files). One of signed_in | not_signed_in |
// unknown, plus a plain note. Reused by the AI brain step for these agents.
export async function signInStatus(agentId) {
  const def = definition(agentId);
  const detected = await ADAPTERS[agentId].detect({ refresh: true });
  const base = { agentId, label: def.label, cost: def.cost, installed: Boolean(detected.installed) };
  if (!detected.installed) {
    return { ...base, status: "unknown", note: `${def.label} isn't installed yet. Install it first, then sign in.` };
  }
  // The same limited environment Agent OS gives the agents it runs, so the
  // answer matches what a run started from here would see.
  const result = await runCommand(detected.path, def.statusArgs, STATUS_TIMEOUT_MS, { env: childEnv(process.env) });
  return { ...base, ...interpretStatus(agentId, result), checkedAt: new Date().toISOString() };
}

// ---- the login run ----------------------------------------------------------------

// Where a browser opens from. Agent OS gives the agents it runs a minimal
// environment, which on Linux leaves out the variables a browser needs.
function browserEnv() {
  const env = {};
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "BROWSER"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// Starts the agent's own login command as a visible run. The command opens the
// person's browser itself; this only runs it, and Cancel (below) stops it.
export async function startSignIn(agentId) {
  const def = definition(agentId);
  // Claimed before the first await, so two clicks that arrive together can't both start one.
  if (starting.has(agentId)) {
    throw signInError("signin_in_progress", `A ${def.label} sign-in is already starting.`);
  }
  starting.add(agentId);
  try {
    return await startSignInLocked(agentId, def);
  } finally {
    starting.delete(agentId);
  }
}

async function startSignInLocked(agentId, def) {
  const manager = getRunManager();
  const previous = latestRun.get(agentId) ? await manager.getRun(latestRun.get(agentId)) : null;
  if (previous && ["queued", "running"].includes(previous.status)) {
    throw signInError("signin_in_progress", `A ${def.label} sign-in is already open. Finish it in your browser, or cancel it.`);
  }
  const detected = await ADAPTERS[agentId].detect({ refresh: true });
  if (!detected.installed) throw signInError("agent_not_installed", `${def.label} isn't installed on this computer yet.`);

  const run = await manager.startRun({
    agentId,
    kind: "signin",
    title: `${def.label} sign-in`,
    command: detected.path,
    args: def.loginArgs,
    cwd: os.tmpdir(),
    env: browserEnv(),
    timeoutMs: SIGNIN_TIMEOUT_MS
  });
  latestRun.set(agentId, run.id);
  return summarizeRun(run, []);
}

export async function cancelSignIn(agentId) {
  definition(agentId);
  const id = latestRun.get(agentId);
  if (!id) return null;
  await getRunManager().stopRun(id);
  return latestRunSummary(agentId);
}

// ---- reading the login run back ---------------------------------------------------

// A command that is only usable in a real terminal says so in words like these.
const NEEDS_TERMINAL =
  /not a (tty|terminal)|requires? an? (interactive )?(terminal|tty)|stdin is not a tty|raw mode is not supported|must be run (in|from) (a )?terminal|interactive terminal|no tty|isatty/i;

// A link the command printed, only when it points at the agent's own site.
function findSignInUrl(text, hosts) {
  for (const match of text.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) {
    const raw = match[0].replace(/[.,;:]+$/, "");
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return raw;
    } catch {
      // not a link; keep looking
    }
  }
  return null;
}

// Long opaque strings (what a token looks like) are hidden in shown lines.
function hideSecrets(line) {
  return redactText(line)
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[hidden]")
    .slice(0, MAX_LINE_CHARS);
}

function failureReason(def, run, lines, needsTerminal) {
  if (run.status === "stopped") return "The sign-in was cancelled.";
  if (run.status === "timed_out") {
    return `The ${def.label} sign-in took longer than 10 minutes, so it was stopped. Try again, or sign in from a terminal window.`;
  }
  if (run.status === "interrupted") return "The sign-in was interrupted when Agent OS restarted. Try again.";
  if (needsTerminal) return `Signing in to ${def.label} needs a terminal window. Use the button below to open one.`;
  const last = lines[lines.length - 1];
  return `The ${def.label} sign-in stopped before it finished.${last ? ` It said: ${last.slice(0, 160)}` : ""}`;
}

function summarizeRun(run, rawLines) {
  const def = SIGNIN[run.agentId];
  const lines = rawLines.map(hideSecrets);
  const needsTerminal = run.status === "failed" && NEEDS_TERMINAL.test(rawLines.join("\n"));
  const active = ["queued", "running"].includes(run.status);
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    lines: lines.slice(-SHOWN_LINES),
    // The page to open if the browser didn't open by itself.
    url: active ? findSignInUrl(rawLines.join("\n"), def.hosts) : null,
    needsTerminal,
    reason: run.status === "succeeded" || active ? null : failureReason(def, run, lines, needsTerminal)
  };
}

export async function latestRunSummary(agentId) {
  definition(agentId);
  const id = latestRun.get(agentId);
  if (!id) return null;
  const manager = getRunManager();
  const run = await manager.getRun(id);
  if (!run) return null;
  const events = await manager.readEvents(id, 0);
  const rawLines = events
    .filter((event) => event.type === "line" && typeof event.text === "string" && event.text.trim())
    .map((event) => event.text.trim());
  return summarizeRun(run, rawLines);
}

// Status plus the latest login run: what the sign-in card shows. While a login
// is open the card only needs the run, so it can leave the (slower) status
// check out with checkStatus:false and ask again once the run has ended.
export async function signInOverview(agentId, { checkStatus = true } = {}) {
  const def = definition(agentId);
  const [status, run] = await Promise.all([
    checkStatus ? signInStatus(agentId) : { agentId, label: def.label, cost: def.cost },
    latestRunSummary(agentId)
  ]);
  return { ...status, run, terminalOpener: process.platform === "darwin" };
}

// ---- the terminal fallback --------------------------------------------------------

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function windowsQuote(value) {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

// The one fixed command line: the agent's own program and its login words,
// nothing from a request.
export function loginCommandLine(binPath, loginArgs, platform = process.platform) {
  const quote = platform === "win32" ? windowsQuote : shellQuote;
  return [binPath, ...loginArgs].map(quote).join(" ");
}

async function sweepOldTerminalFiles(dir) {
  const now = Date.now();
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith(".command")) continue;
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > TERMINAL_FILE_MAX_AGE_MS) await fs.rm(file, { force: true }).catch(() => {});
  }
}

// macOS: opens Terminal.app on a tiny .command file holding ONLY the login
// command, so the person can sign in where a real terminal is available.
// Elsewhere there is no one way to open a terminal, so the command is handed
// back to be copied. `command` is always returned, for either path.
export async function openSignInInTerminal(agentId, { platform = process.platform, spawnFn = spawn } = {}) {
  const def = definition(agentId);
  const detected = await ADAPTERS[agentId].detect({ refresh: true });
  if (!detected.installed) throw signInError("agent_not_installed", `${def.label} isn't installed on this computer yet.`);
  const command = loginCommandLine(detected.path, def.loginArgs, platform);
  if (platform !== "darwin") return { opened: false, reason: "copy", command };

  const dir = path.join(runtimePaths().root, "setup", "terminal");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await sweepOldTerminalFiles(dir);
  const file = path.join(dir, `${agentId}-login-${crypto.randomBytes(4).toString("hex")}.command`);
  await fs.writeFile(file, `${command}\n`, { mode: 0o700 });

  const opened = await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn("open", ["-a", "Terminal", file], { stdio: "ignore", detached: true, shell: false });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref?.();
      resolve(true);
    });
  });
  return opened ? { opened: true, command } : { opened: false, reason: "spawn_failed", command };
}

// ---- tests only ---------------------------------------------------------------------

export function resetSignInForTest() {
  latestRun.clear();
  starting.clear();
}
