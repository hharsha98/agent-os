import { execFile, spawn } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, openSync, readSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  // Other common key shapes. Each needs its prefix and a long run of key characters, so ordinary words and names such
  // as npm_config_cache, hf_home or xai-grok stay as they are.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgsk_[A-Za-z0-9]{20,}/,
  /\bxai-[A-Za-z0-9]{20,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/
];
// Global ("g") copies so redactText replaces every match, not only the first.
// Kept separate on purpose: a "g" regex remembers where its last match ended
// (lastIndex), so test() on one can answer differently on each call, and
// redactValue runs test() on the shared list above.
const SECRET_VALUE_PATTERNS_GLOBAL = SECRET_VALUE_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
);

function startsWithNodeShebang(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(128);
    const bytes = readSync(fd, buffer, 0, 128, 0);
    const firstLine = buffer.subarray(0, bytes).toString("utf8").split("\n")[0];
    return firstLine.startsWith("#!") && /\bnode\b/.test(firstLine);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A Node CLI installed into its own Node (e.g. OpenClaw under
// ~/.agent-os/node/bin) starts with "#!/usr/bin/env node" and must run on
// the Node next to it, not an older system Node earlier on PATH. Only
// applies to POSIX node-shebang scripts; npm's Windows .cmd shims already
// prefer the node.exe beside them.
export function withSiblingNodePath(command, env = process.env) {
  if (process.platform === "win32" || !command || !path.isAbsolute(command)) return env;
  const dir = path.dirname(command);
  if (path.basename(command) === "node" || !existsSync(path.join(dir, "node"))) return env;
  if (!startsWithNodeShebang(command)) return env;
  const parts = String(env.PATH || "").split(path.delimiter).filter((part) => part && part !== dir);
  return { ...env, PATH: [dir, ...parts].join(path.delimiter) };
}

// The server's own environment minus its secrets, for the agent programs it starts only to read from (version checks,
// config reads, voice tasks): a plugin one of them loads could otherwise read the admin or launch token and use the
// whole API. Drops AGENT_OS_TOKEN, HERMES_AGENT_OS_ADMIN_TOKEN and any AGENT_OS_* or HERMES_AGENT_OS_* name with TOKEN,
// SECRET, KEY or PASSWORD in it. Every other name (the AGENT_OS_TEST_* knobs, PATH, HOME) stays.
export function envWithoutServerSecrets(env = process.env) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(HERMES_)?AGENT_OS_/i.test(name) && /TOKEN|SECRET|KEY|PASSWORD/i.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

export function runCommand(command, args = [], timeout = 5000, options = {}) {
  return new Promise((resolve) => {
    const env = withSiblingNodePath(command, options.env || envWithoutServerSecrets());
    // An npm .cmd shim on Windows starts as the program it points at (no shell); anything else is as it was.
    const launch = programLaunch(command, args, { env });
    const child = execFile(launch.command, launch.args, { timeout, cwd: options.cwd || undefined, env, signal: options.signal || undefined }, (error, stdout, stderr) => {
      options.track?.delete(child);
      resolve({
        ok: !error,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
        aborted: error?.name === "AbortError" || error?.code === "ABORT_ERR"
      });
    });
    // Callers (e.g. live-chat.js) can pass a Set here so shutdown can find
    // and kill any child still running when the process quits.
    options.track?.add(child);
    // Non-interactive CLIs such as `codex exec` wait forever when the inherited
    // stdin pipe stays open, even when the prompt is already an argument.
    child.stdin?.end();
  });
}

export function runStreamingCommand(command, args = [], timeout = 5000, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let errorCode = null;
    let errorMessage = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-200000);
    const finish = (result = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", abort);
      resolve({
        ok: !errorMessage && !timedOut && !aborted && (result.code ?? 0) === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim() || errorMessage,
        code: errorCode ?? result.code ?? (errorMessage ? 1 : 0),
        signal: result.signal ?? null,
        aborted: aborted || result.aborted || false,
        timedOut
      });
    };
    const child = spawn(command, args, {
      cwd: options.cwd || undefined,
      // Same rule as runCommand: without its own environment the program gets the server's minus its secrets.
      env: options.env || envWithoutServerSecrets(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref?.();
    }, timeout);
    options.signal?.addEventListener?.("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout = append(stdout, text);
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr = append(stderr, text);
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      errorCode = error?.code || 1;
      errorMessage = error?.message || "command failed";
      finish({ code: errorCode, signal: error?.signal || null, aborted: error?.name === "AbortError" || error?.code === "ABORT_ERR" });
    });
    child.on("close", (code, signal) => finish({ code, signal }));
    if (options.signal?.aborted) abort();
  });
}

// Highest installed nvm Node version's bin dir, if nvm is used. Sorted as
// semver (major.minor.patch), not as text, so v9 doesn't outrank v10.
async function highestNvmBinDir() {
  const nvmRoot = path.join(os.homedir(), ".nvm", "versions", "node");
  let entries;
  try {
    entries = await readdir(nvmRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (!versions.length) return null;
  versions.sort((a, b) => {
    const partsA = a.replace(/^v/, "").split(".").map(Number);
    const partsB = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff) return diff;
    }
    return 0;
  });
  return path.join(nvmRoot, versions[versions.length - 1], "bin");
}

async function executableSearchDirs() {
  const extra = String(process.env.HERMES_AGENT_OS_EXECUTABLE_PATHS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const home = os.homedir();
  const dirs = [
    ...extra,
    ...String(process.env.PATH || "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".agent-os", "node", "bin")
  ];
  const nvmBin = await highestNvmBinDir();
  if (nvmBin) dirs.push(nvmBin);
  if (process.platform === "win32") {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, "hermes", "bin"));
      dirs.push(path.join(process.env.LOCALAPPDATA, "hermes"));
    }
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  }
  return dirs.filter(Boolean);
}

// On Windows a bare command name (no extension) can resolve to any of
// PATHEXT's suffixes; POSIX has no such notion, so this is a no-op there.
// The PATHEXT names come first and the bare name last (final review, Se I2): npm puts `codex` (a shell script that
// Windows cannot start), `codex.cmd` and `codex.ps1` side by side, and the bare one used to win because it came first.
export function candidateNames(command, platform = process.platform, pathextText = process.env.PATHEXT) {
  if (platform !== "win32" || /\.[A-Za-z0-9]+$/.test(command)) return [command];
  const pathext = String(pathextText || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [...pathext.map((ext) => `${command}${ext}`), command];
}

// ---- npm's Windows shims (final review, Se I2) ------------------------------------------------------------------------
//
// An agent installed with npm on Windows is a `.cmd` file: npm's cmd-shim writes a few lines of batch code that start
// `node.exe` on the package's script. Node refuses to start a .cmd without a shell (spawn EINVAL, since 2024), and
// this project starts programs with no shell on purpose: a folder name or a prompt could become an argument. So the
// shim is read (never run), the program it points at is found, and that program is started directly, with the original
// arguments. Anything that does not look exactly like what cmd-shim writes is left alone, and then fails as it always did.

// What cmd-shim 7 (npm 10) writes first, in every shim.
const SHIM_HEAD = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0"];
// ...then, for a program that runs on node (a "#!/usr/bin/env node" first line), this choice of node.exe:
const SHIM_NODE_CHOICE = [
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  ""
];
// The launch line of a node program: the shebang's own flags (plain words only), then the script relative to the shim.
const SHIM_NODE_LAUNCH = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"((?:\s+[A-Za-z0-9_.=-]+)*)\s+"%dp0%\\([^"%:\r\n]+)"\s+%\*$/;
// The launch line of a native program (no "#!" line): the program relative to the shim.
const SHIM_NATIVE_LAUNCH = /^"%dp0%\\([^"%:\r\n]+)"\s+%\*$/;

/**
 * What an npm .cmd shim starts, read from the shim's text alone (pure; it runs nothing and reads no file).
 * @returns {{ kind: "node", target: string, flags: string[] } | { kind: "exe", target: string } | null}
 *   `target` is the Windows path relative to the shim's folder; null when the text is not exactly a cmd-shim.
 */
export function parseNpmCmdShim(text) {
  if (typeof text !== "string") return null;
  const lines = text
    .replace(/^\ufeff/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < SHIM_HEAD.length + 1 || SHIM_HEAD.some((line, index) => lines[index] !== line)) return null;
  const rest = lines.slice(SHIM_HEAD.length);
  if (rest.length === 1) {
    const native = SHIM_NATIVE_LAUNCH.exec(rest[0]);
    return native && /\.exe$/i.test(native[1]) ? { kind: "exe", target: native[1] } : null;
  }
  if (rest.length !== SHIM_NODE_CHOICE.length + 1 || SHIM_NODE_CHOICE.some((line, index) => rest[index] !== line)) return null;
  const node = SHIM_NODE_LAUNCH.exec(rest[rest.length - 1]);
  if (!node || !/\.(?:js|cjs|mjs)$/i.test(node[2])) return null;
  return { kind: "node", target: node[2], flags: node[1].split(/\s+/).filter(Boolean) };
}

/**
 * The command and arguments that start the program an npm .cmd shim points at, or null when the text is not a shim
 * Agent OS knows (pure, so any computer can test it). A node script runs with the node.exe beside the shim when there
 * is one (the shim itself prefers it), else the node on the search path, else the node that runs Agent OS.
 * @param {string} file the shim's absolute Windows path
 * @param {string} text the shim's text
 * @param {string[]} args the arguments the caller meant to give the program
 */
export function npmShimLaunch(file, text, args = [], { nodeBeside = false, nodeOnPath = null, execPath = process.execPath } = {}) {
  const parsed = parseNpmCmdShim(text);
  if (!parsed) return null;
  const dir = path.win32.dirname(file);
  const target = path.win32.resolve(dir, parsed.target);
  if (parsed.kind === "exe") return { command: target, args: [...args] };
  const node = nodeBeside ? path.win32.join(dir, "node.exe") : nodeOnPath || execPath;
  return { command: node, args: [...parsed.flags, target, ...args] };
}

// The first node.exe on a search path (the variable is "Path" on Windows).
function nodeOnSearchPath(env, exists) {
  const key = Object.keys(env || {}).find((name) => name.toLowerCase() === "path");
  for (const entry of String(key ? env[key] : "").split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const candidate = path.win32.join(dir, "node.exe");
    if (exists(candidate)) return candidate;
  }
  return null;
}

// A shim is a few hundred bytes; a bigger .cmd is something else.
const SHIM_READ_BYTES = 16 * 1024;
function readShimText(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(SHIM_READ_BYTES);
    const bytes = readSync(fd, buffer, 0, SHIM_READ_BYTES, 0);
    return bytes < SHIM_READ_BYTES ? buffer.subarray(0, bytes).toString("utf8") : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Where a found program really starts: the command and arguments to hand to execFile, spawn or a terminal. Only on
 * Windows, only for an absolute `.cmd` or `.bat` path, and only for an npm shim; everything else comes back as it came.
 * Reads the shim, never runs it. The options are for tests.
 */
export function programLaunch(
  command,
  args = [],
  { env = process.env, platform = process.platform, readText = readShimText, exists = existsSync, execPath = process.execPath } = {}
) {
  const unchanged = { command, args };
  if (platform !== "win32" || typeof command !== "string" || !/\.(?:cmd|bat)$/i.test(command) || !path.win32.isAbsolute(command)) return unchanged;
  try {
    const nodeBeside = exists(path.win32.join(path.win32.dirname(command), "node.exe"));
    const launch = npmShimLaunch(command, readText(command), args, { nodeBeside, nodeOnPath: nodeBeside ? null : nodeOnSearchPath(env, exists), execPath });
    return launch ?? unchanged;
  } catch {
    return unchanged;
  }
}

async function isExecutableCandidate(candidate) {
  try {
    // Windows has no notion of an execute bit; existence is enough there.
    await access(candidate, process.platform === "win32" ? undefined : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command) {
  const clean = String(command || "").trim();
  if (!clean || clean.includes("\0")) return "";
  if (clean.includes("/") || (process.platform === "win32" && clean.includes("\\"))) return "";
  const seen = new Set();
  for (const dir of await executableSearchDirs()) {
    for (const name of candidateNames(clean)) {
      const candidate = path.join(dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (await isExecutableCandidate(candidate)) return candidate;
    }
  }
  return "";
}

export async function which(command) {
  return findExecutable(command);
}

export async function commandVersion(commandPath, args = ["--version"]) {
  if (!commandPath) return null;
  const result = await runCommand(commandPath, args, 5000);
  return result.stdout || result.stderr || null;
}

export function redactValue(key, value) {
  if (value == null || value === "") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = redactText(value);
  if (SECRET_KEY_PATTERN.test(String(key))) return "configured";
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text))) return "configured";
  return text;
}

// Only the key-shaped text becomes "configured"; paths are left as they are (a run's output keeps its full paths).
export function redactSecretShapes(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_VALUE_PATTERNS_GLOBAL) {
    text = text.replaceAll(pattern, "configured");
  }
  return text;
}

export function redactText(value, extraPatterns = []) {
  let text = String(value ?? "");
  text = text.replaceAll(os.homedir(), "~");
  text = redactSecretShapes(text);
  for (const item of extraPatterns) {
    const raw = String(item || "");
    if (!raw) continue;
    text = text.replaceAll(raw, raw.startsWith(os.homedir()) ? raw.replace(os.homedir(), "~") : "<local-path>");
  }
  return text;
}

export function sanitizeObject(input) {
  if (Array.isArray(input)) return input.map((item) => sanitizeObject(item));
  if (!input || typeof input !== "object") return input;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object") {
      output[key] = sanitizeObject(value);
    } else {
      output[key] = redactValue(key, value);
    }
  }
  return output;
}

export function publicEnvConfigured(...keys) {
  return keys.some((key) => Boolean(process.env[key]));
}

export function forbiddenExportPatterns() {
  const home = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    { name: "local home path", pattern: new RegExp(home) },
    { name: "repo runtime data", pattern: /(^|[/\\])\.data([/\\]|$)/ },
    { name: "Hermes profile path", pattern: /\.hermes[/\\]profiles/ },
    { name: "token-like secret", pattern: /^[A-Z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*[ \t]*=[ \t]*(?!(your[-_a-z0-9]*|example[-_a-z0-9]*|placeholder[-_a-z0-9]*|[a-z0-9_-]+[._-]\.\.\.|sk-\.\.\.|sk-ant-\.\.\.|\.\.\.)($|[\s#]))[^"'\s#][^\s#]+/im },
    { name: "OpenAI style key", pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
    { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
    { name: "local profile name", pattern: /\bagent(?:1|2|3|4|5|6|7|8|9|10|11|12|13)\b/ }
  ];
}
