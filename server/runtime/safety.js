import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/
];

export function runCommand(command, args = [], timeout = 5000, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout, cwd: options.cwd || undefined, env: options.env || undefined, signal: options.signal || undefined }, (error, stdout, stderr) => {
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
      env: options.env || undefined,
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
function candidateNames(command) {
  if (process.platform !== "win32" || /\.[A-Za-z0-9]+$/.test(command)) return [command];
  const pathext = String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [command, ...pathext.map((ext) => `${command}${ext}`)];
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

export function redactText(value, extraPatterns = []) {
  let text = String(value ?? "");
  text = text.replaceAll(os.homedir(), "~");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, "configured");
  }
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
