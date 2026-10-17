// "Remember my OpenRouter key for coding agents": the one place Agent OS keeps
// that key on purpose, so Claude Code and Codex can run on OpenRouter (see
// server/runtime/builders/). In plain words:
//
//   * On a Mac the key goes into the macOS Keychain (service
//     "agent-os-openrouter", account "agent-os"), written through
//     `/usr/bin/security -i` so the key is typed on the command's STANDARD INPUT
//     and never appears in a command line (anyone can read those with `ps`).
//   * Everywhere else (Linux, Windows, a Mac whose Keychain can't be used, and
//     every test) the key goes into a private file: <AGENT_OS_HOME>/config/
//     secrets/openrouter.key, mode 0600, inside a 0700 folder.
//   * Exactly one copy exists: saving in one place removes the other.
//
// The coding agents never get the key in their command line or environment.
// They are handed a small "read helper" command instead (Claude Code's
// apiKeyHelper, Codex's provider `auth` command) that prints the key when the
// agent asks for it. This module builds that helper; it never returns the key.
//
// `AGENT_OS_KEYSTORE=file` forces the file backend. Under `node --test` the real
// Keychain is never touched unless a test injects its own fake `security`.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { osRoot, runtimePaths } from "../store.js";

export const KEYCHAIN_SERVICE = "agent-os-openrouter";
export const KEYCHAIN_ACCOUNT = "agent-os";
const KEYCHAIN_LABEL = "Agent OS OpenRouter";
const DEFAULT_SECURITY_PATH = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 10 * 1000;

// What an OpenRouter key looks like (sk-or-v1-<hex>). Checked BEFORE the key
// goes anywhere near the `security` command so it can't carry a second command.
export const OPENROUTER_KEY_PATTERN = /^sk-or-[A-Za-z0-9-]{10,200}$/;

// Sits next to this file in the source tree, and next to the server bundle in
// the desktop app (scripts/build-server-bundle.mjs copies it there).
const PRINT_KEY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "print-key.mjs");

// ---- test hooks ------------------------------------------------------------------------

let securityPath = DEFAULT_SECURITY_PATH;
let testPlatform = null;
let securityInjected = false;

// Tests only: pretend to be another platform and/or use a fake `security`.
export function setKeystoreForTest({ platform, securityPath: fake } = {}) {
  testPlatform = platform || null;
  securityInjected = Boolean(fake);
  securityPath = fake || DEFAULT_SECURITY_PATH;
}

function keystoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isValidOpenRouterKey(key) {
  return typeof key === "string" && OPENROUTER_KEY_PATTERN.test(key);
}

function keychainEnabled() {
  if (process.env.AGENT_OS_KEYSTORE === "file") return false;
  // `node --test` marks every test process (and the servers they start). A test
  // must never write to the developer's real Keychain by accident.
  if (process.env.NODE_TEST_CONTEXT && !securityInjected) return false;
  return (testPlatform || process.platform) === "darwin";
}

// Where a NEW key would be saved.
function preferredBackend() {
  return keychainEnabled() ? "keychain" : "file";
}

// ---- macOS Keychain, through `security` ----------------------------------------------------

// Runs `security`. `input` goes to its standard input. Never throws; the output
// is returned for the caller to read, and is never put into an error message.
function runSecurity(args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(securityPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve({ ok: false, code: "spawn_failed", stdout: "" });
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: "timeout", stdout: "" });
    }, SECURITY_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.once("error", () => finish({ ok: false, code: "spawn_failed", stdout: "" }));
    child.once("close", (code) => finish({ ok: code === 0, code, stdout: stdout.trim() }));
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

const FIND_ARGS = ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE];

async function keychainRead() {
  const result = await runSecurity([...FIND_ARGS, "-w"]);
  return result.ok && isValidOpenRouterKey(result.stdout) ? result.stdout : null;
}

// `security -i` takes its commands from standard input, so the key is never an
// argument of any process. Its exit code can't be trusted to say whether the
// item was saved, so the write is checked by reading it back.
async function keychainWrite(key) {
  const script = `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -l "${KEYCHAIN_LABEL}" -w ${key}\nquit\n`;
  await runSecurity(["-i"], script);
  return (await keychainRead()) === key;
}

async function keychainDelete() {
  await runSecurity(["-i"], `delete-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE}\nquit\n`);
  return (await runSecurity(FIND_ARGS)).ok === false;
}

// ---- the private file --------------------------------------------------------------------------

function secretsDir() {
  return path.join(runtimePaths().config, "secrets");
}

function keyFile() {
  return path.join(secretsDir(), "openrouter.key");
}

async function fileRead() {
  try {
    const key = (await fs.readFile(keyFile(), "utf8")).trim();
    return isValidOpenRouterKey(key) ? key : null;
  } catch {
    return null;
  }
}

async function fileWrite(key) {
  const dir = secretsDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  const temp = path.join(dir, `.openrouter.key.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, key, { mode: 0o600 });
  await fs.rename(temp, keyFile());
  await fs.chmod(keyFile(), 0o600).catch(() => {});
}

async function fileDelete() {
  await fs.rm(keyFile(), { force: true }).catch(() => {});
}

// ---- what the rest of the server uses ---------------------------------------------------------

// Where the key is right now: { backend, key } or null. Server-internal; the
// key itself never leaves this module.
async function locateKey() {
  if (keychainEnabled()) {
    const key = await keychainRead();
    if (key) return { backend: "keychain", key };
  }
  const key = await fileRead();
  return key ? { backend: "file", key } : null;
}

// What the screen may know: whether a key is saved, where, and its last 4
// characters. Never the key.
export async function openRouterKeyStatus() {
  const found = await locateKey();
  if (!found) return { stored: false, backend: preferredBackend(), last4: null };
  return { stored: true, backend: found.backend, last4: found.key.slice(-4) };
}

// Saves the key (Keychain on a Mac, else the private file) and removes any
// older copy from the other place. Throws { code: "invalid_key" } for something
// that isn't an OpenRouter key.
export async function storeOpenRouterKey(key) {
  if (!isValidOpenRouterKey(key)) {
    throw keystoreError("invalid_key", "That doesn't look like an OpenRouter key. It starts with sk-or-.");
  }
  let backend = null;
  if (keychainEnabled() && (await keychainWrite(key))) backend = "keychain";
  if (backend) {
    await fileDelete();
  } else {
    // No usable Keychain (or this is not a Mac): the private file. An older
    // Keychain copy must not outlive the new key.
    await fileWrite(key);
    if (keychainEnabled()) await keychainDelete();
    backend = "file";
  }
  return { stored: true, backend, last4: key.slice(-4) };
}

export async function forgetOpenRouterKey() {
  if (keychainEnabled()) await keychainDelete();
  await fileDelete();
  return { stored: false, backend: preferredBackend(), last4: null };
}

// The command a coding agent runs to READ the key: { backend, command, args }.
// Null when no valid key is saved. The key itself is never part of it.
export async function openRouterKeyHelper() {
  const found = await locateKey();
  if (!found) return null;
  if (found.backend === "keychain") {
    return { backend: "keychain", command: securityPath, args: [...FIND_ARGS, "-w"] };
  }
  return { backend: "file", command: process.execPath, args: [PRINT_KEY_SCRIPT, osRoot()] };
}

// ---- turning a helper into one line of text (Claude Code's apiKeyHelper) --------------------------

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function windowsQuote(value) {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

// apiKeyHelper is run by the shell, so every word is quoted for it.
export function helperCommandLine(helper, platform = process.platform) {
  const quote = platform === "win32" ? windowsQuote : shellQuote;
  return [helper.command, ...helper.args].map(quote).join(" ");
}
