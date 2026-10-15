// The environment every session starts with (spec H2): the person's own
// login-shell environment, the one Terminal gives them, minus Agent OS's own
// variables and the "you are inside another agent" markers, plus the few
// terminal variables every session sets.
//
// How the login-shell environment is read (VS Code's pattern): the login shell
// runs Node with a one-line script that prints process.env as JSON between two
// random markers. Only the text between the markers is used, so whatever the
// person's startup files print (banners, warnings) cannot confuse it, and the
// output is never parsed as `env` text (values may hold newlines or "=").
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RUNTIME_VERSION } from "../store.js";

export const LOGIN_SHELL_TIMEOUT_MS = 10000;
// Variables that make an agent think it runs inside another agent's session.
// Spikes S3 and S6 add the Codex and Cursor ones; until then only Claude
// Code's two are removed (removing less is the safe default, spec H2).
export const NESTED_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
export const FALLBACK_NOTICE = "Agent OS could not read your login shell's settings, so sessions use a basic environment.";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// How often a finished shell's process group is looked at again while a job
// left in it is still running (see whenShellEnded).
const GROUP_RECHECK_MS = 1000;
// Set while the login shell runs, so a person's startup file can tell (like
// VS Code's VSCODE_RESOLVING_ENVIRONMENT). It starts with AGENT_OS_, so it
// never reaches a session.
const RESOLVING_FLAG = "AGENT_OS_RESOLVING_ENVIRONMENT";
// Bookkeeping of the short-lived resolver shell (its folder, the last command
// it ran), not the person's settings (decision Q7a). profiles.js sets a
// session's own PWD. Nothing else is taken out of the login shell's answer.
const RESOLVER_ONLY = new Set(["PWD", "OLDPWD", "_", RESOLVING_FLAG]);

// Names whose values Agent OS itself put into the server's environment: the
// keys loadLocalEnv added from Agent OS's own env file (its `applied` list,
// decision Q11a). They are not the person's environment (H1, H2), so the
// login shell never receives them and the fallback and Windows environments
// leave them out. A value the person's own startup files set under the same
// name is theirs and is kept. server/index.js registers the names once at
// start, right after loadLocalEnv, before the login shell is read. (The
// desktop shell passes the port as AGENT_OS_PORT, an Agent OS name, which is
// removed like every AGENT_OS_ variable.)
const excluded = new Set();

export function excludeFromSessionEnv(keys) {
  for (const key of keys || []) if (typeof key === "string") excluded.add(key);
}

export function resetExcludedForTests() {
  excluded.clear();
}

// Windows variable names ignore letter case, so there the check does too.
function isExcluded(key, platform) {
  if (excluded.has(key)) return true;
  if (platform !== "win32") return false;
  const name = key.toUpperCase();
  for (const item of excluded) if (item.toUpperCase() === name) return true;
  return false;
}

function isAgentOsVariable(key, platform) {
  const name = platform === "win32" ? key.toUpperCase() : key;
  return name.startsWith("AGENT_OS_") || name.startsWith("HERMES_AGENT_OS_");
}

// Agent OS started by an npm script (`npm start`, `npm run dev`, `npm run
// desktop:dev`): npm adds its own npm_* variables (always in lower case),
// INIT_CWD, NODE and COLOR, fills in EDITOR when the person has none (the
// value of VISUAL, else vi, or notepad.exe on Windows), and puts
// node_modules/.bin of the project folder and of each folder above it, and
// its own node-gyp-bin, in front of PATH. They describe how Agent OS was
// started, not the person's environment (H2, the reasoning of decision Q11a),
// so they are left out like the excluded names. An EDITOR the person has
// passes through npm unchanged and is kept; in the login shell the person's
// startup files set their own values again anyway.
const NPM_ADDED = new Set(["INIT_CWD", "NODE", "COLOR"]);

function startedByNpm() {
  return typeof process.env.npm_lifecycle_event === "string" && process.env.npm_lifecycle_event !== "";
}

function isNpmAdded(key, value, platform) {
  // Outside Windows npm's own names are lower case, so a person's own
  // NPM_CONFIG_PREFIX is kept; Windows names ignore letter case.
  if (key.startsWith("npm_") || (platform === "win32" && key.toLowerCase().startsWith("npm_"))) return true;
  const name = platform === "win32" ? key.toUpperCase() : key;
  if (NPM_ADDED.has(name)) return true;
  if (name !== "EDITOR") return false;
  // npm's fill-in for a person with no EDITOR is VISUAL when it is set, else vi
  // (notepad.exe on Windows). Only that exact value is npm's: a person's own
  // EDITOR=vi next to a VISUAL of something else is theirs and is kept.
  const visual = process.env.VISUAL;
  const npmFillIn = visual ? visual : platform === "win32" ? `${process.env.SYSTEMROOT}\\notepad.exe` : "vi";
  return value === npmFillIn;
}

// PATH without the folders npm put in front of it: node_modules/.bin of the
// project folder (where npm's package.json is) and of each folder above it,
// and npm's own node-gyp-bin. Every other entry keeps its place.
function withoutNpmPath(value) {
  const pkg = process.env.npm_package_json;
  const bins = new Set();
  for (let dir = typeof pkg === "string" && path.isAbsolute(pkg) ? path.dirname(pkg) : process.cwd(); ; dir = path.dirname(dir)) {
    bins.add(path.join(dir, "node_modules", ".bin"));
    if (path.dirname(dir) === dir) break;
  }
  const gyp = path.join("@npmcli", "run-script", "lib", "node-gyp-bin");
  return String(value || "")
    .split(path.delimiter)
    .filter((entry) => !bins.has(entry) && !entry.endsWith(gyp))
    .join(path.delimiter);
}

// The server's own environment (text values only) without Agent OS's own
// variables (AGENT_OS_*, HERMES_AGENT_OS_*: its session token among them),
// without the excluded names and, when an npm script started Agent OS, without
// what npm added. Every environment built from it (the login shell's input, the
// fallback, Windows) is therefore free of Agent OS's variables, whoever uses it.
function serverEnv(platform) {
  const npm = startedByNpm();
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || isAgentOsVariable(key, platform) || isExcluded(key, platform)) continue;
    if (npm && isNpmAdded(key, value, platform)) continue;
    env[key] = value;
  }
  if (npm) {
    for (const key of Object.keys(env)) {
      if (key === "PATH" || (platform === "win32" && key.toUpperCase() === "PATH")) env[key] = withoutNpmPath(env[key]);
    }
  }
  return env;
}

function defaultShell() {
  if (process.env.SHELL) return process.env.SHELL;
  try {
    return os.userInfo().shell || "";
  } catch {
    return "";
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The server's own environment (without Agent OS's variables and the excluded
// names) plus the folders agents are usually installed in, for when the login
// shell can't be read.
function fallbackResult(platform) {
  const env = serverEnv(platform);
  const parts = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", path.join(os.homedir(), ".local", "bin")]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(path.delimiter);
  return { env, source: "fallback", notice: FALLBACK_NOTICE };
}

function parseMarked(text, marker) {
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const end = text.indexOf(marker, start + marker.length);
  if (end === -1) return null;
  let value;
  try {
    value = JSON.parse(text.slice(start + marker.length, end));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const env = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && !RESOLVER_ONLY.has(key)) env[key] = item;
  }
  // A login shell always has a PATH; without one no agent could be found.
  return env.PATH ? env : null;
}

function readLoginShell(shell, timeoutMs, nodePath) {
  const first = crypto.randomBytes(8).toString("hex");
  const second = crypto.randomBytes(8).toString("hex");
  const marker = first + second;
  // The script joins the two halves, so the whole marker appears only in what
  // Node prints, never in the command text a shell might echo back.
  const script = `const m=${JSON.stringify(first)}+${JSON.stringify(second)};process.stdout.write(m+JSON.stringify(process.env)+m)`;
  const command = `${shellQuote(nodePath)} -e ${shellQuote(script)}`;
  const name = path.basename(shell);
  const args = name === "csh" || name === "tcsh" ? ["-ic", command] : ["-i", "-l", "-c", command];
  // Agent OS's own variables (its session token among them) and the names
  // Agent OS put into its own environment never reach the person's startup
  // files, so what comes back is what Terminal would give.
  const env = serverEnv(process.platform);
  // The desktop shell extends the server's PATH with folders of its own
  // (server_path_env in main.rs). The login shell gets the PATH the app itself
  // was started with, as Terminal's does (H2, Q11a), without npm's folders
  // when an npm script started the app (`npm run desktop:dev`).
  const launchPath = process.env.AGENT_OS_LAUNCH_PATH;
  if (typeof launchPath === "string" && launchPath) env.PATH = startedByNpm() ? withoutNpmPath(launchPath) : launchPath;
  env[RESOLVING_FLAG] = "1";

  return new Promise((resolve) => {
    let settled = false;
    let text = "";
    let bytes = 0;
    let child = null;
    const killGroup = () => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL"); // detached: the shell leads its own process group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    // Quitting Agent OS kills the shell's own process group. The listener stays
    // until the shell's group is gone, not until the markers arrive: a person's
    // logout file may hang, or leave a job in the group, after Node printed. It
    // must not stay longer than that either: once the group is empty its number
    // can be handed to an unrelated process, and killing -pid would hit that.
    let released = false;
    let groupTimer = null;
    const release = () => {
      released = true;
      clearTimeout(groupTimer);
      process.removeListener("exit", killGroup);
    };
    // The shell itself has ended ("exit"). Its output ("close") can stay open
    // far longer, because a helper started by a startup or logout file (a
    // daemon in a session of its own) may keep the pipe. So the listener is
    // released as soon as nobody is left in the shell's process group (ESRCH);
    // while a job is still in it, look again every second, until the group is
    // empty or "close" comes.
    const whenShellEnded = () => {
      const check = () => {
        if (released || !child?.pid) return;
        try {
          process.kill(-child.pid, 0); // signal 0 only asks whether the group exists
        } catch (error) {
          if (error?.code === "ESRCH") {
            release();
            return;
          }
        }
        groupTimer = setTimeout(check, GROUP_RECHECK_MS);
        groupTimer.unref();
      };
      check();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(null);
    }, timeoutMs);
    process.once("exit", killGroup);
    try {
      // detached: a new session with no terminal, so an interactive shell
      // never waits for one (VS Code does the same).
      child = spawn(shell, args, { cwd: os.homedir(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      release();
      finish(null);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        killGroup();
        finish(null);
        return;
      }
      text += chunk;
      // Done as soon as Node has printed; the shell's own logout files are
      // not waited for.
      const parsed = parseMarked(text, marker);
      if (parsed) finish(parsed);
    });
    child.stderr.on("data", () => {});
    child.once("exit", whenShellEnded);
    child.once("error", () => {
      if (!child.pid) release(); // it never started
      finish(null);
    });
    // "close" comes after the shell has ended and its output is closed.
    child.once("close", () => {
      release();
      finish(parseMarked(text, marker));
    });
  });
}

// { env, source: "login-shell" | "fallback" | "process", notice }. Never throws:
// anything that goes wrong (no shell, a hang past timeoutMs, no markers, a
// non-zero exit before printing) gives the fallback and its notice.
export async function resolveLoginShellEnv({
  shell = defaultShell(),
  timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
  nodePath = process.execPath,
  platform = process.platform
} = {}) {
  // Windows has no login shell: the process environment is used as it is (H2),
  // without Agent OS's own variables and the names it put there itself.
  if (platform === "win32") return { env: serverEnv(platform), source: "process", notice: null };
  if (typeof shell !== "string" || !path.isAbsolute(shell)) return fallbackResult(platform);
  const env = await readLoginShell(shell, timeoutMs, nodePath);
  return env ? { env, source: "login-shell", notice: null } : fallbackResult(platform);
}

let cached = null;

// Resolved once per server (spec H2): every caller gets the same promise.
export function getLoginShellEnv() {
  if (!cached) cached = resolveLoginShellEnv();
  return cached;
}

export function resetLoginShellEnvForTests() {
  cached = null;
}

// A session's environment from `baseEnv` (the login-shell environment), as a
// new object. Removes ONLY Agent OS's own variables (AGENT_OS_*,
// HERMES_AGENT_OS_*) and the nested-session markers; sets the terminal
// variables, the session id and, for Claude Code with the H4 opt-in on,
// CLAUDE_CODE_NO_FLICKER. Never sets HOME, USERPROFILE, CLAUDE_CONFIG_DIR,
// CODEX_HOME, XDG_CONFIG_HOME, HERMES_HOME, any OPENCLAW_* variable or
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (H1, H2): those pass through as the person
// has them. Windows variable names ignore case, so there the checks do too.
// Throws a TypeError for a sessionId that is not a non-empty string or a
// baseEnv that is not an object: both are a caller's bug.
export function sessionEnv(
  baseEnv,
  { sessionId, agentOsVersion = RUNTIME_VERSION, claudeFullscreen = false, agentId, platform = process.platform } = {}
) {
  // A caller's mistake must not become a session with an empty id or no PATH.
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("sessionEnv needs a sessionId (a non-empty string)");
  if (!baseEnv || typeof baseEnv !== "object" || Array.isArray(baseEnv)) throw new TypeError("sessionEnv needs a baseEnv (an object of environment variables)");
  const fold = (key) => (platform === "win32" ? key.toUpperCase() : key);
  const additions = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "AgentOS",
    TERM_PROGRAM_VERSION: String(agentOsVersion),
    AGENT_OS_SESSION_ID: sessionId
  };
  if (agentId === "claude" && claudeFullscreen === true) additions.CLAUDE_CODE_NO_FLICKER = "1";
  const replaced = new Set(Object.keys(additions).map(fold));
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    const name = fold(key);
    if (name.startsWith("AGENT_OS_") || name.startsWith("HERMES_AGENT_OS_")) continue;
    if (NESTED_MARKERS.includes(name)) continue;
    if (replaced.has(name)) continue;
    env[key] = value;
  }
  return Object.assign(env, additions);
}
