// A safety claim about a different profile (final review, Sa Important 2).
//
// The Agents panels read and change ONE profile: Hermes's from Agent OS's saved connection (resolveHermesHome), OpenClaw's
// from the server's own environment. A session starts with the login shell's environment (H1), so a person whose shell
// startup file exports HERMES_HOME (or an OpenClaw state or profile variable), and who opens Agent OS from the Dock,
// has sessions in a profile the panel never looked at. "Ask before flagged deletes" on the panel then says nothing
// about the profile a session runs in. This module notices the split from the cached login-shell read, so the panel
// can say so and the Safety page can stop claiming a safeguard it never saw.
//
// It never waits: the shell is read when the server starts (server/index.js), and a page request only looks at that
// answer if it has finished (peekLoginShellEnv). If the shell could not be read, or has not been read yet, it makes no
// claim either way.
import { realpath as fsRealpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { peekLoginShellEnv } from "../sessions/shell-env.js";
import { resolveHermesHome } from "./hermes.js";

export const HERMES_PROFILE_NOTE = "Sessions use another Hermes profile, and this panel doesn't show its settings.";
export const OPENCLAW_PROFILE_NOTE = "Sessions use another OpenClaw profile, and this panel doesn't show its settings.";

// The variables that decide which OpenClaw profile (state folder, config file) a command works in.
export const OPENCLAW_PROFILE_VARIABLES = Object.freeze(["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_CONFIG_DIR", "OPENCLAW_HOME"]);

// A path as a comparable string: ~ expanded, resolved, no trailing slash. Null for unset or empty.
function resolvedPath(value, home) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  const expanded = text === "~" ? home : /^~[\\/]/.test(text) ? path.join(home, text.slice(2)) : text;
  const resolved = path.resolve(expanded);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// A plain name (OPENCLAW_PROFILE): trimmed, null when unset or empty.
function plainName(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * What the sessions use against what the panel reads, as one comparison per setting: { kind: "path" | "name", shell, panel },
 * each side already as comparable text (null for a name that is unset). null when it cannot tell: no shell answer yet, the
 * fallback environment (the shell could not be read), no environment in the answer, or an agent with no profile.
 */
export function profileComparisons(agentId, { shell, panelHermesHome, serverEnv, home }) {
  if (!shell || shell.source === "fallback" || !shell.env || typeof shell.env !== "object") return null;
  const sessionEnv = shell.env;
  if (agentId === "hermes") {
    // Unset is the default folder, so naming that folder is not another profile.
    const defaultHome = path.resolve(path.join(home, ".hermes"));
    const normal = (value) => resolvedPath(value, home) ?? (process.platform === "win32" ? defaultHome.toLowerCase() : defaultHome);
    return [{ kind: "path", shell: normal(sessionEnv.HERMES_HOME), panel: normal(panelHermesHome) }];
  }
  if (agentId === "openclaw") {
    const env = serverEnv && typeof serverEnv === "object" ? serverEnv : {};
    return OPENCLAW_PROFILE_VARIABLES.map((name) =>
      name === "OPENCLAW_PROFILE"
        ? { kind: "name", shell: plainName(sessionEnv[name]), panel: plainName(env[name]) }
        : { kind: "path", shell: resolvedPath(sessionEnv[name], home), panel: resolvedPath(env[name], home) }
    );
  }
  return null;
}

/**
 * Do sessions use another profile than the panel shows, going by the text of the paths? False when it cannot tell (see
 * profileComparisons). withProfileSplit adds the real-path look on top of this.
 * @param {string} agentId
 * @param {{ shell: { env?: Record<string, string>, source?: string } | null | undefined, panelHermesHome: string | null, serverEnv: Record<string, string | undefined>, home: string }} facts
 */
export function sessionsUseAnotherProfile(agentId, facts) {
  return (profileComparisons(agentId, facts) ?? []).some((comparison) => comparison.shell !== comparison.panel);
}

const NOTES = { hermes: HERMES_PROFILE_NOTE, openclaw: OPENCLAW_PROFILE_NOTE };

// The real path of one folder name: a link is followed, and a name that does not exist (or cannot be looked up) stays as its text.
async function realOrText(text, realpath) {
  try {
    const real = await realpath(text);
    return process.platform === "win32" ? String(real).toLowerCase() : String(real);
  } catch {
    return text;
  }
}

/**
 * A safety answer with the profile note and `otherProfile: true` added when sessions use another profile; the same
 * object, untouched, in every other case (and when anything here throws). Two names for one folder (a link, a letter-case
 * difference) are one profile: when the text of a path differs, the real paths are compared before a split is claimed
 * (F1 of the re-review). That is the only place the file system is touched, and only for the paths whose text differs (at
 * most two lookups for Hermes), because this runs in a page request. The dependencies are for tests.
 */
export async function withProfileSplit(
  agentId,
  safety,
  { peekShell = peekLoginShellEnv, resolveHermesHome: hermesHome = resolveHermesHome, serverEnv = process.env, home = os.homedir(), realpath = fsRealpath } = {}
) {
  if (!safety || typeof safety !== "object" || !NOTES[agentId]) return safety;
  try {
    const shell = peekShell();
    const panelHermesHome = agentId === "hermes" && shell ? await hermesHome() : null;
    const differing = (profileComparisons(agentId, { shell, panelHermesHome, serverEnv, home }) ?? []).filter((comparison) => comparison.shell !== comparison.panel);
    if (differing.length === 0) return safety;
    const real = new Map();
    for (const comparison of differing) {
      if (comparison.kind !== "path") continue;
      for (const text of [comparison.shell, comparison.panel]) if (text !== null && !real.has(text)) real.set(text, await realOrText(text, realpath));
    }
    const asReal = (comparison, side) => (comparison.kind === "path" && comparison[side] !== null ? real.get(comparison[side]) : comparison[side]);
    if (!differing.some((comparison) => asReal(comparison, "shell") !== asReal(comparison, "panel"))) return safety;
    return { ...safety, otherProfile: true, notes: [...(Array.isArray(safety.notes) ? safety.notes : []), NOTES[agentId]] };
  } catch {
    return safety;
  }
}
