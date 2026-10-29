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
// hooks-off checks and the wrapper).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSessionHookUrl } from "../builders/brain-launch.js";
import { isSessionId } from "./errors.js";

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
// server's hook address is a caller's bug.
export function buildSessionClaudeSettings({ hookUrl, statusLine = null, brainSettings = null } = {}) {
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
  const settings = { hooks };
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
