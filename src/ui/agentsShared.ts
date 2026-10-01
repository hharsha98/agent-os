// Small helpers shared by the Agents screen ("the hangar") and its
// components. Kept separate from fleetShared.ts (Home's helpers) so this
// worker's files never touch that one.

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
export const AGENT_MONOGRAM: Record<string, string> = {
  hermes: "H",
  openclaw: "OC",
  claude: "CC",
  codex: "CX",
  cursor: "CU"
};
// Agents with an always-on background gateway (Fleet's "gateways" count).
export const SERVICE_AGENT_SET = new Set(["hermes", "openclaw"]);
// Only these adapters' buildRun() reads options.allowEdits at all (see
// claude.js / codex.js); cursor.js throws allow_edits_not_supported (400)
// and hermes/openclaw ignore it, so the toggle would lie there.
export const ALLOW_EDITS_AGENT_SET = new Set(["claude", "codex"]);
// hermes/openclaw are installed via Agent OS Setup, not a system package
// manager, so their "not installed" state points at Setup instead of a
// homepage + "press Re-check" flow.
export const SETUP_INSTALLED_AGENT_SET = new Set(["hermes", "openclaw"]);

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
  return ERROR_MESSAGES[code] || code || "Something went wrong.";
}

// The rail's per-agent status mark + word: the same shape+colour states as
// FleetPage's cards (see FleetPage.tsx's FleetCard), reused here so a given
// agent reads the same way on both screens.
export function agentStatusWord(
  installed: boolean | undefined,
  resolved: boolean,
  timedOut: boolean,
  failed: boolean,
  liveCount: number
): { mark: "unknown" | "ok" | "error" | "live"; word: string } {
  // A failed fetch leaves `resolved` false too, so check it first or the rail
  // would say "Checking…" forever instead of the real error.
  if (failed && !resolved) return { mark: "error", word: "Couldn't check" };
  if (!resolved) return { mark: "unknown", word: timedOut ? "Timed out" : "Checking…" };
  if (failed) return { mark: "error", word: "Couldn't check" };
  if (liveCount > 0) return { mark: "live", word: `Running ×${liveCount}` };
  if (installed) return { mark: "ok", word: "Ready" };
  return { mark: "unknown", word: "Not installed" };
}
