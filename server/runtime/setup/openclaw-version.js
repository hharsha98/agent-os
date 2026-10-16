// The version gate for OpenClaw's ChatGPT sign-in (plan-brains spec §3, §7).
// OpenAI's "Sign in with ChatGPT" needs OpenClaw 2026.9.7 or newer. The numbers
// come from OpenClaw's own version line, which detection reads (the first line
// of `openclaw --version`); nothing here runs a command or reads a file.
// Callers pass ADAPTERS.openclaw.detect({ refresh: true }), never a cached
// detection, so an update installed a moment ago counts.
import { parseVersion, versionAtLeast } from "../builders/resolve.js";

export const OPENCLAW_SIGNIN_MIN_VERSION = "2026.9.7";
export const OPENCLAW_TOO_OLD_MESSAGE = "Update OpenClaw first: its ChatGPT sign-in needs version 2026.9.7 or newer.";
export const OPENCLAW_VERSION_UNKNOWN_MESSAGE = "Agent OS couldn't read OpenClaw's version.";

const NEED = parseVersion(OPENCLAW_SIGNIN_MIN_VERSION);

// { have, need, newEnough }. `have` is the three numbers of the detected line
// ("OpenClaw 2026.9.6 (eb377ac)" gives "2026.9.6"). `have` and `newEnough` are
// null when OpenClaw is not installed or its line holds no version.
export function openclawVersionInfo(detected) {
  const parsed = detected?.installed === true ? parseVersion(detected.version) : null;
  if (!parsed) return { have: null, need: OPENCLAW_SIGNIN_MIN_VERSION, newEnough: null };
  return { have: parsed.join("."), need: OPENCLAW_SIGNIN_MIN_VERSION, newEnough: versionAtLeast(parsed, NEED) };
}
