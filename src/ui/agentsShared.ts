// Small helpers shared by the Agents screen ("the hangar") and its
// components. Kept separate from fleetShared.ts (Home's helpers) so this
// worker's files never touch that one.
import { ApiError } from "../api";

// Fixed order + copy, matching FleetPage's "mixing desk" layout so the two
// screens read as one system.
export const AGENTS_ORDER = ["hermes", "openclaw", "claude", "codex", "cursor"];
export const AGENT_LABEL: Record<string, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor"
};
export const AGENT_ROLE: Record<string, string> = {
  hermes: "Autonomous general agent",
  openclaw: "Always-on assistant",
  claude: "Coding agent",
  codex: "Coding agent",
  cursor: "Coding agent"
};
// Who makes each agent (shown under its name on Agents).
export const AGENT_MAKER: Record<string, string> = {
  hermes: "Nous Research",
  openclaw: "Open source",
  claude: "Anthropic",
  codex: "OpenAI",
  cursor: "Cursor"
};
// Agents with an always-on background gateway (Fleet's "gateways" count).
export const SERVICE_AGENT_SET = new Set(["hermes", "openclaw"]);
// hermes/openclaw are installed via Agent OS Setup, not a system package
// manager, so their "not installed" state points at Setup instead of a
// homepage + "press Re-check" flow.
export const SETUP_INSTALLED_AGENT_SET = new Set(["hermes", "openclaw"]);
// Agent OS Setup can install all five agents (Hermes, OpenClaw and the three coding agents), so every
// "not installed" message points at Setup. A link to a vendor's website opens in the person's browser from the
// desktop app only for the addresses listed in desktop/src-tauri/capabilities/default.json (otherwise it shows
// the address with a Copy button), so Setup is the way forward that always works there.
export const SETUP_CAN_INSTALL_AGENT_SET = new Set(["hermes", "openclaw", "claude", "codex", "cursor"]);

// A path returned by the server (e.g. runs/preview's `cwd`) is a raw,
// uncollapsed absolute path — unlike commandPreview/versionFull, which the
// server already redacts to "~" (see safety.js redactText / detect.js
// splitVersion). The client never learns the real home directory, so this
// matches the common OS conventions instead: never print an absolute home
// path in the UI even when the server didn't collapse it for us.
const HOME_PATTERNS: Array<[RegExp, string]> = [
  [/^\/Users\/[^/]+/, "~"],
  [/^\/home\/[^/]+/, "~"],
  [/^[A-Za-z]:\\Users\\[^\\]+/, "~"]
];

export function collapseHomePath(text: string | undefined | null): string {
  const value = String(text || "");
  for (const [pattern, replacement] of HOME_PATTERNS) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }
  return value;
}

// Maps the error-code strings routes.js sends (see server/runtime/agents/
// routes.js) to a plain-English reason. Falls back to the raw code so an
// unrecognised one is still visible rather than swallowed.
const ERROR_MESSAGES: Record<string, string> = {
  execution_gate_off: "Safety is set to Look only. Agents can't run until you allow it.",
  folder_outside_sandbox: "That folder is outside the Agent OS sandbox.",
  allow_edits_not_supported: "This agent can't allow edits from Agent OS yet.",
  blocked_flag: "Refused: that would pass a blocked flag to the agent.",
  too_many_runs: "Too many runs are already active. Wait for one to finish and try again.",
  invalid_plan: "Agent OS could not build a valid run for this agent."
};

export function friendlyError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error || "");
  // fetch() rejects with the browser's own wording when the server is down.
  if (/failed to fetch|networkerror|load failed/i.test(code)) return "Couldn't reach Agent OS.";
  if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  // A refusal the server explained in a sentence (a coding agent's brain, for example).
  const detail = error instanceof ApiError ? error.detail : "";
  return detail || code || "Something went wrong.";
}
