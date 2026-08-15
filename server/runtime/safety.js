import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
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
      resolve({
        ok: !error,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
        aborted: error?.name === "AbortError" || error?.code === "ABORT_ERR"
      });
    });
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

function executableSearchDirs() {
  const extra = String(process.env.HERMES_AGENT_OS_EXECUTABLE_PATHS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return [
    ...extra,
    ...String(process.env.PATH || "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter(Boolean);
}

async function findExecutable(command) {
  const clean = String(command || "").trim();
  if (!clean || clean.includes("/") || clean.includes("\0")) return "";
  const seen = new Set();
  for (const dir of executableSearchDirs()) {
    const candidate = path.join(dir, clean);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep scanning common local binary directories
    }
  }
  return "";
}

export async function which(command) {
  const result = await runCommand("/usr/bin/which", [command], 3000);
  if (result.ok && result.stdout) return result.stdout.split("\n")[0];
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
