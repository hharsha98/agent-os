// Claude Code, per session (spec SP4 "Signals" and "Hook events are hints",
// harness rules H1, H3 and H5; rulings R1, R2, R3, R6, R7, R8; contract
// choice K9). Two things live here:
//   - the per-session settings file's observe-only HTTP hooks. Each one posts
//     to the literal hook URL of this run (Claude fills no variable into a
//     URL, and the port changes at every launch, R7) with the header
//     "Authorization: Bearer $AGENT_OS_HOOK_TOKEN", which Claude fills in
//     because allowedEnvVars names the variable. The token itself is never
//     written into the file, and no failure option is set (R6): Claude's own
//     default lets the action go ahead when Agent OS is down (H5);
//   - where Claude keeps a folder's transcripts, for the re-link rule (R1):
//     one fs.stat of one file name, never an open or a read.
// Task X2b adds the statusLine half (the person's settings layers, the
// hooks-off checks and the wrapper), at the end of the file.
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSessionHookUrl } from "../builders/brain-launch.js";
import { resetsAtFrom } from "../builders/limits.js";
import { helperCommandLine } from "../secrets/keystore.js";
import { ensurePrivateDir } from "../store.js";
import { isSessionId } from "./errors.js";
import { cleanAlertText } from "./signals.js";

// R8: every event hook gives up after 3 s, so a stalled Agent OS delays a
// prompt or a dialog by at most that much (H5).
export const HOOK_TIMEOUT_S = 3;

function hookEntry(event, matcher, timeout) {
  return Object.freeze({ event, matcher, timeout });
}

// The hooks Agent OS asks Claude to call, in the file's order. A matcher is
// Claude's exact-name list ("a|b"), or null for none. SessionEnd has no
// timeout (K9): Claude's own 1.5 s budget for it applies (R8).
export const CLAUDE_HOOK_EVENTS = Object.freeze([
  hookEntry("PermissionRequest", null, HOOK_TIMEOUT_S),
  hookEntry("Elicitation", null, HOOK_TIMEOUT_S),
  hookEntry("Notification", "permission_prompt|elicitation_dialog|elicitation_url_dialog|quota_auto_resume_fired", HOOK_TIMEOUT_S),
  hookEntry("Stop", null, HOOK_TIMEOUT_S),
  hookEntry("StopFailure", null, HOOK_TIMEOUT_S),
  hookEntry("UserPromptSubmit", null, HOOK_TIMEOUT_S),
  hookEntry("PostToolUse", "Edit|Write", HOOK_TIMEOUT_S),
  hookEntry("SessionEnd", "clear|resume", null)
]);

export function claudeHookUrl(port, sessionId) {
  return `http://127.0.0.1:${port}/hooks/sessions/${sessionId}`;
}

// The object for <AGENT_OS_HOME>/sessions/<id>/claude-settings.json, keys in
// this order: hooks, then statusLine (Task X2b), then a brain's apiKeyHelper
// and env (from buildClaudeSettings, as in SP3), each copied. The caller runs
// assertSafeClaudeSettings on it before it is written. A URL that is not this
// server's hook address is a caller's bug. `withHooks: false` leaves the hooks
// out (R9: the person's settings already keep Agent OS's hooks from working, and
// a hook that is answered 401 shows "hook error" in their transcript).
export function buildSessionClaudeSettings({ hookUrl, statusLine = null, brainSettings = null, withHooks = true } = {}) {
  // http://127.0.0.1:<port>/hooks/sessions/<Agent OS session id>, nothing more
  // (the same shape assertSafeClaudeSettings allows, M6, without /status).
  if (!isSessionHookUrl(hookUrl, { allowStatus: false })) {
    throw new TypeError("buildSessionClaudeSettings needs this session's hook URL (http://127.0.0.1:<port>/hooks/sessions/<id>)");
  }
  const hooks = {};
  for (const { event, matcher, timeout } of CLAUDE_HOOK_EVENTS) {
    const handler = { type: "http", url: hookUrl };
    if (timeout !== null) handler.timeout = timeout;
    handler.headers = { Authorization: "Bearer $AGENT_OS_HOOK_TOKEN" };
    handler.allowedEnvVars = ["AGENT_OS_HOOK_TOKEN"];
    hooks[event] = [matcher === null ? { hooks: [handler] } : { matcher, hooks: [handler] }];
  }
  const settings = withHooks ? { hooks } : {};
  if (statusLine) settings.statusLine = { ...statusLine };
  if (brainSettings && typeof brainSettings === "object") {
    if (brainSettings.apiKeyHelper !== undefined) settings.apiKeyHelper = brainSettings.apiKeyHelper;
    if (brainSettings.env !== undefined) settings.env = { ...brainSettings.env };
  }
  return settings;
}

// The person's Claude folder (H1): CLAUDE_CONFIG_DIR from the session's own
// environment when it is an absolute path, else ~/.claude. Agent OS never
// sets the variable; it only reads what the person has.
export function claudeConfigDir({ env, home = os.homedir() } = {}) {
  const own = env && typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR : "";
  return own && path.isAbsolute(own) ? own : path.join(home, ".claude");
}

// How Claude names a folder under <Claude folder>/projects/: every character
// that is not a letter or a digit becomes "-", so /Users/you/my-app/.claude/x
// is stored as -Users-you-my-app--claude-x.
export function encodeClaudeProjectPath(folder) {
  return String(folder).replace(/[^A-Za-z0-9]/g, "-");
}

// R1: true only when <Claude folder>/projects/<encoded folder>/<uuid>.jsonl is
// a file. One stat, never an open or a read; false for anything else,
// including an id that is not a lower-case version 4 UUID (the rule Resume
// uses, M3; so no path can be built from any other string) and a folder that
// is not absolute.
export async function transcriptExists({ uuid, folder, env, home = os.homedir() } = {}) {
  if (!isSessionId(uuid)) return false;
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return false;
  const file = path.join(claudeConfigDir({ env, home }), "projects", encodeClaudeProjectPath(folder), `${uuid}.jsonl`);
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

// ---- SP4 Task X2b: the person's Claude settings (read only), the statusLine wrapper, the Live meter ----

// Claude Code's managed settings file per platform (settings docs, "Settings files"). Managed
// settings win over Agent OS's --settings file, as Claude itself applies them (R10).
export const MANAGED_SETTINGS_PATHS = Object.freeze({
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json"
});
// The only keys Agent OS reads from a Claude settings file (H1 reads); every other key is dropped
// as soon as the file is parsed and is never logged or kept.
export const SETTINGS_READ_KEYS = Object.freeze(["statusLine", "disableAllHooks", "allowManagedHooksOnly", "allowedHttpHookUrls", "httpHookAllowedEnvVars"]);
// Next to this file in the source tree, and next to the server bundle in the desktop app
// (scripts/build-server-bundle.mjs copies it there), as PRINT_KEY_SCRIPT in keystore.js.
export const STATUSLINE_WRAPPER_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "statusline-wrapper.mjs");

const LAYER_ORDER = Object.freeze(["managed", "local", "project", "user"]);
// The person's statusLine keys that change how Claude lays the line out, with their JSON type.
const STATUSLINE_DISPLAY_KEYS = Object.freeze([
  ["padding", "number"],
  ["refreshInterval", "number"],
  ["hideVimModeIndicator", "boolean"]
]);
const HOOK_TOKEN_ENV = "AGENT_OS_HOOK_TOKEN";
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_NAME_MAX = 80;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// One settings file, keeping only SETTINGS_READ_KEYS (own properties). null when the file is
// missing, unreadable, not JSON or not an object. Never logs what it read.
async function readSettingsLayer(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const picked = {};
  for (const key of SETTINGS_READ_KEYS) {
    if (Object.hasOwn(parsed, key)) picked[key] = parsed[key];
  }
  return picked;
}

// The person's Claude settings, at session start (R9, R10): managed, local project, project and
// user (CLAUDE_CONFIG_DIR honoured, H1). Never ~/.claude.json, never any other file.
export async function readClaudeSettingsLayers({ folder, env, home = os.homedir(), platform = process.platform, managedPath } = {}) {
  const managedFile = managedPath ?? (Object.hasOwn(MANAGED_SETTINGS_PATHS, platform) ? MANAGED_SETTINGS_PATHS[platform] : null);
  const projectDir = typeof folder === "string" && path.isAbsolute(folder) ? path.join(folder, ".claude") : null;
  const [managed, local, project, user] = await Promise.all([
    managedFile ? readSettingsLayer(managedFile) : null,
    projectDir ? readSettingsLayer(path.join(projectDir, "settings.local.json")) : null,
    projectDir ? readSettingsLayer(path.join(projectDir, "settings.json")) : null,
    readSettingsLayer(path.join(claudeConfigDir({ env: env ?? {}, home }), "settings.json"))
  ]);
  return { managed, local, project, user };
}

// The person's own statusLine (R10): the first command status line in Claude's order, with the
// display keys that have their JSON type. A wrong type is left out because Claude could refuse
// Agent OS's whole settings file over it, and the hooks with it.
export function findUserStatusLine(layers) {
  for (const from of LAYER_ORDER) {
    const statusLine = layers?.[from]?.statusLine;
    if (!isPlainObject(statusLine) || statusLine.type !== "command") continue;
    if (typeof statusLine.command !== "string" || !statusLine.command.trim()) continue;
    const found = { command: statusLine.command };
    for (const [key, type] of STATUSLINE_DISPLAY_KEYS) {
      const value = statusLine[key];
      if (typeof value === type && (type !== "number" || Number.isFinite(value))) found[key] = value;
    }
    found.from = from;
    return found;
  }
  return null;
}

// A list key as Claude merges it: every file's array joined (strings only); null when no file has one.
function mergedList(layers, key) {
  let defined = false;
  const values = [];
  for (const from of LAYER_ORDER) {
    const list = layers?.[from]?.[key];
    if (!Array.isArray(list)) continue;
    defined = true;
    for (const value of list) if (typeof value === "string") values.push(value);
  }
  return defined ? values : null;
}

// Claude's URL patterns: `*` matches any run of characters; everything else is literal.
function urlPatternMatches(pattern, url) {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(url);
}

// The settings that keep Agent OS's hooks (alerts) or its statusLine (the Live meter) out of this
// session (R9, K10), first match per field. Agent OS only says so; it never changes them.
export function detectHooksOff(layers, { hookUrl } = {}) {
  const result = { alerts: null, meter: null };
  const set = (field, code) => {
    if (result[field] === null) result[field] = code;
  };
  if (layers?.managed?.allowManagedHooksOnly === true) {
    set("alerts", "managed_hooks_only");
    set("meter", "managed_hooks_only");
  }
  if (LAYER_ORDER.some((from) => layers?.[from]?.disableAllHooks === true)) {
    set("alerts", "all_hooks_disabled");
    set("meter", "all_hooks_disabled");
  }
  const urls = mergedList(layers, "allowedHttpHookUrls");
  if (urls && !urls.some((pattern) => urlPatternMatches(pattern, String(hookUrl ?? "")))) set("alerts", "http_hook_urls");
  const envVars = mergedList(layers, "httpHookAllowedEnvVars");
  if (envVars && !envVars.includes(HOOK_TOKEN_ENV)) set("alerts", "http_hook_env_vars");
  if (layers?.managed && layers.managed.statusLine != null) set("meter", "managed_status_line");
  return result;
}

// Written to a temp name in the same private folder (flag wx, 0600) and renamed into place, so
// Claude never runs a half-written file and an older, looser file is replaced by a 0600 one.
async function writePrivateFile(file, data) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temp, data, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await fs.chmod(temp, 0o600);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

// The wrapper and the person's command for one session (spec "Helper scripts", Security 5).
export async function writeStatusLineHelper({ dir, userStatusLine }) {
  await ensurePrivateDir(dir);
  const script = path.join(dir, "statusline.mjs");
  const config = path.join(dir, "statusline.json");
  const command = typeof userStatusLine?.command === "string" && userStatusLine.command.trim() ? userStatusLine.command : null;
  await writePrivateFile(config, `${JSON.stringify({ version: 1, command }, null, 2)}\n`);
  await writePrivateFile(script, await fs.readFile(STATUSLINE_WRAPPER_SOURCE));
  return { script, config };
}

// Claude runs statusLine.command through its shell, so each word is quoted for it, as apiKeyHelper is.
export function statusLineCommand(script, platform = process.platform) {
  return helperCommandLine({ command: process.execPath, args: [script] }, platform);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value) {
  const n = finiteNumber(value);
  return n === null ? null : Math.min(100, Math.max(0, n));
}

// One rate_limits window, or null when it is absent, has no percentage, or its reset time has
// passed (R4: Claude drops such a window itself; a stale one must neither show nor hold).
function limitWindow(value, nowMs) {
  if (!isPlainObject(value)) return null;
  const used = finiteNumber(value.used_percentage);
  if (used === null) return null;
  const resetsAt = resetsAtFrom(value.resets_at) ?? null;
  if (resetsAt !== null && Date.parse(resetsAt) <= nowMs) return null;
  return { usedPercent: Math.min(100, Math.max(0, used)), resetsAt, atLimit: used >= 100 && resetsAt !== null };
}

// Claude's statusLine JSON as the Live meter (R11: the cost is Claude's own estimate), plus the
// conversation id for the re-link rule (R1) and the limit rule's status signal (K2).
export function parseStatusLine(json, now = Date.now()) {
  const data = isPlainObject(json) ? json : {};
  const model = isPlainObject(data.model) && typeof data.model.display_name === "string" ? cleanAlertText(data.model.display_name, MODEL_NAME_MAX) || null : null;
  const context = isPlainObject(data.context_window) ? data.context_window : {};
  const usage = isPlainObject(context.current_usage) ? context.current_usage : null;
  const tokens = usage
    ? ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map((key) => finiteNumber(usage[key])).filter((n) => n !== null && n >= 0)
    : [];
  const limits = isPlainObject(data.rate_limits) ? data.rate_limits : {};
  const plan = limitWindow(limits.five_hour, now);
  const weekly = limitWindow(limits.seven_day, now);
  const spent = [plan, weekly].filter((window) => window?.atLimit);
  const cost = isPlainObject(data.cost) ? finiteNumber(data.cost.total_cost_usd) : null;
  const shown = (window) => (window ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt } : null);
  return {
    meter: {
      model,
      contextPercent: percent(context.used_percentage),
      contextTokens: tokens.length ? tokens.reduce((sum, n) => sum + n, 0) : null,
      plan: shown(plan),
      weekly: shown(weekly),
      costUsd: cost !== null && cost >= 0 ? cost : null,
      at: new Date(now).toISOString()
    },
    claudeSessionId: typeof data.session_id === "string" && ANY_UUID.test(data.session_id) ? data.session_id.toLowerCase() : null,
    atLimit: spent.length > 0,
    // Both windows spent: work can go on only after the later reset.
    resetAt: spent.map((window) => window.resetsAt).sort().at(-1) ?? null
  };
}
