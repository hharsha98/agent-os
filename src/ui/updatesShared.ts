// Agent updates (SP5), the rules and words the Agents page's Version block, its Update dialog and the sidebar's update
// dot share. Pure: nothing here reads the page or talks to a server, so test/updates-ui-shared.test.js loads it
// straight from src/ (Node strips the types). It keeps only `import type` imports. Every sentence below is one the
// owner reviewed (SP5 "Sentences").
import type { AgentUpdateStatus, UpdatesResponse } from "../updatesApi";

// ---- what each agent's own updater runs -----------------------------------------------------------------------------

// The command the update runs, for the dialog's "Runs <agent>'s own updater: <command>." These are the programs and
// arguments server/runtime/setup/recipes.js runs (`updateArgs`; Cursor's program is `agent`), and Hermes's is the
// update session's `hermes update`. test/updates-ui-shared.test.js keeps them in step with the recipes.
const UPDATE_COMMAND: Record<string, string> = {
  claude: "claude update",
  codex: "codex update",
  cursor: "agent update",
  openclaw: "openclaw update --json",
  hermes: "hermes update"
};

export function updateCommand(agentId: string): string {
  return UPDATE_COMMAND[agentId] ?? `${agentId} update`;
}

// ---- reading the answer -----------------------------------------------------------------------------------------

// This agent's row, or undefined: the checks have not run yet (they are off in a plain `npm start`), or not for this agent.
export function statusOf(data: UpdatesResponse | null | undefined, agentId: string): AgentUpdateStatus | undefined {
  return data?.agents.find((row) => row.agentId === agentId);
}

// The sidebar's dot: some agent has a newer version. Hermes counts even when Agent OS will not update its changed copy
// (the agent does have an update; the Agents page says why Agent OS leaves it).
export function anyUpdateAvailable(data: UpdatesResponse | null | undefined): boolean {
  return Boolean(data?.agents.some((row) => row.state === "available"));
}

// Where the dot leads: the first agent with an update, in the order the Agents page lists them (`order`).
export function firstAvailableAgent(data: UpdatesResponse | null | undefined, order: readonly string[]): string | null {
  const available = new Set((data?.agents ?? []).filter((row) => row.state === "available").map((row) => row.agentId));
  return order.find((id) => available.has(id)) ?? null;
}

// Cursor is the one agent Agent OS cannot ask for its latest version ("unknown"); its own updater looks when it runs.
export function isCursorUnknown(agentId: string, status: AgentUpdateStatus | undefined): boolean {
  return agentId === "cursor" && status?.state === "unknown";
}

// Hermes is updated only from an unchanged official copy (server: hermes_not_clean). With a newer version out and the copy
// changed, no Update is offered: the reasons and the guide take its place.
export function hermesBlocked(agentId: string, status: AgentUpdateStatus | undefined, hermes: UpdatesResponse["hermes"] | undefined): boolean {
  return agentId === "hermes" && status?.state === "available" && hermes?.clean !== true;
}

// The Update button: a newer version is out (Hermes also needs its copy unchanged), or Cursor, whose updater checks itself.
export function offersUpdate(agentId: string, status: AgentUpdateStatus | undefined, hermes: UpdatesResponse["hermes"] | undefined): boolean {
  if (!status) return false;
  if (isCursorUnknown(agentId, status)) return true;
  return status.state === "available" && !hermesBlocked(agentId, status, hermes);
}

// ---- the Version block's words ---------------------------------------------------------------------------------

export type UpdateWordTone = "ready" | "waiting" | "unknown";

// The state word: "Up to date", "Update available" or "Couldn't check". Cursor's "unknown" has a sentence of its own
// instead, and an agent that is not installed has none.
export function stateWord(agentId: string, status: AgentUpdateStatus | undefined): { tone: UpdateWordTone; label: string } | null {
  if (!status) return null;
  if (status.state === "up-to-date") return { tone: "ready", label: "Up to date" };
  if (status.state === "available") return { tone: "waiting", label: "Update available" };
  if (status.state === "failed" || (status.state === "unknown" && !isCursorUnknown(agentId, status))) return { tone: "unknown", label: "Couldn't check" };
  return null;
}

export const CURSOR_UNKNOWN_LINE = "Agent OS can't check Cursor's latest version. Its updater checks when you press Update.";

// "Latest" and "Checked" are said only for a check that found an answer; a failed or impossible one has nothing to show.
export function checkFoundAnswer(status: AgentUpdateStatus | undefined): boolean {
  return status?.state === "up-to-date" || status?.state === "available";
}

// ---- the Update dialog ------------------------------------------------------------------------------------------

// The first run of numbers joined by dots: "2.1.309" in "2.1.309 (Claude Code)", "0.22.5" in "Hermes Agent v0.22.5". The same
// reading the server makes of an agent's version (updates/versions.js), for an agent whose check gives no number of its own
// (Hermes). null when there is none.
export function versionNumber(text: string | null | undefined): string | null {
  return /\d+(?:\.\d+)+/.exec(String(text ?? ""))?.[0] ?? null;
}

export const updateTitle = (label: string) => `Update ${label}?`;
export const openSessionsLine = (oldVersion: string) => `Open sessions keep running on v${oldVersion} until you restart them.`;
export const dryRunLine = (current: string, target: string) => `Dry run: ${current} → ${target}.`;
export const GATEWAY_LINE = "Its Gateway restarts.";

// ---- Hermes: not an unchanged official copy ----------------------------------------------------------------------

export const HERMES_BLOCKED_LINE = "Agent OS updates Hermes only from an unchanged official copy.";

// "Not clean" with no reason at all is what the server sends before its first check of Hermes's folder has ended, and when
// that check could not run (checks.js hermesClean). It is not a changed copy, so the page does not draw the reasons and
// the guide for one: it says the folder has not been checked. (A new sentence, owner review at E1.) Still no Update.
export const HERMES_UNCHECKED_LINE = "Agent OS hasn't checked Hermes's folder yet.";

export function hermesUnchecked(agentId: string, status: AgentUpdateStatus | undefined, hermes: UpdatesResponse["hermes"] | undefined): boolean {
  return hermesBlocked(agentId, status, hermes) && (hermes?.reasons?.length ?? 0) === 0;
}

// One line per finding, in this order (the order of the reviewed sentences, which is the order the server lists them in).
const HERMES_REASON_LINES: Record<string, string> = {
  no_checkout: "Agent OS can't find Hermes's folder.",
  no_official_remote: "Its folder doesn't come from the official Hermes repository.",
  refs_unreadable: "Agent OS can't read the official repository's references in its folder.",
  not_on_release_or_main: "It isn't on an official release or main.",
  local_commits: "It has commits that aren't in the official repository.",
  dirty_tree: "It has changes that aren't saved in a commit.",
  custom_channel: "It follows a different update channel.",
  folder_refused: "Hermes's folder is outside the places Agent OS may work."
};

// The sentences for the codes the server sent. A code this page does not know is left out rather than shown as a code.
export function hermesReasonLines(reasons: readonly string[] | undefined): string[] {
  const sent = new Set(reasons ?? []);
  return Object.keys(HERMES_REASON_LINES)
    .filter((code) => sent.has(code))
    .map((code) => HERMES_REASON_LINES[code]);
}

export const HERMES_GUIDE_TITLE = "To update a changed copy safely:";
// Each step is a sentence and the command it ends with, which the page draws as code. The step reads as `${text} ${command}`.
export const HERMES_GUIDE_STEPS: ReadonlyArray<{ text: string; command: string }> = [
  { text: "Keep your changes on your own branch:", command: "git switch -c my-hermes" },
  { text: "Follow main:", command: "hermes update --set-channel main" },
  { text: "Keep your branch in place when updating:", command: "hermes config set updates.parked_branch_strategy update_in_place" },
  { text: "Update:", command: "hermes update" }
];

export const HERMES_UPDATE_HEADING = "Hermes update. Type into it if Hermes asks you something.";

// After a Hermes update session ends, the server forgets what it detected and checks Hermes again (it looks at the session
// once a second). A page waits a little longer than that before it asks, so it does not get the old answer. The Agents page
// and Setup both do.
export const AFTER_SESSION_MS = 2500;

// ---- Restart session ---------------------------------------------------------------------------------------------

// An update never stops an open session: it keeps running on the version it started on. The Version block says so with a
// banner per session, and Restart session (stop, then resume, in the same tab) is the person's own click after a confirm.
// A session needs the banner when its run's version and the installed one can both be read and differ. They are compared
// by their first dotted number, the same reading as `versionNumber` above, so "2.1.309 (Claude Code)" and "2.1.309" are the
// same version. Anything unreadable on either side gives no banner: it is never built on a guess. Pass this agent's open
// sessions; `installed` is the installed version (a number, or the agent's whole line).
export function sessionsToRestart<S extends { agentVersion?: string | null }>(sessions: readonly S[], installed: string | null | undefined): S[] {
  const now = versionNumber(installed);
  if (!now) return [];
  return sessions.filter((session) => {
    const then = versionNumber(session.agentVersion);
    return then !== null && then !== now;
  });
}

// The installed version's number for the restart banner, its confirm and the Update dialog's open-sessions line: the freshly
// detected one (the Installed line's own), and the saved check's only when that cannot be read. The saved check runs every 24
// hours, so it goes stale when the agent's own auto-updater, brew or npm changes the version outside Agent OS, and a banner
// built on it would say "use v<old>" for a session that started after the change.
export function installedVersionNumber(detected: string | null | undefined, saved: string | null | undefined): string | null {
  return versionNumber(detected) ?? versionNumber(saved);
}

export const restartTitle = (newVersion: string) => `Restart session to use v${newVersion}`;
export const RESTART_LABEL = "Restart session";
export const RESTART_NOT_NOW = "Not now";
// A session whose folder is not shown (OpenClaw picks its own) has no place to name: "Restart {agent}?" (a new sentence).
export const restartDialogTitle = (agent: string, folder: string | null) => (folder ? `Restart ${agent} in ${folder}?` : `Restart ${agent}?`);
export const restartDialogBody = (newVersion: string) => `The session closes and starts again on v${newVersion}.`;
// The resume rule's own sentence (the session's `restart.reason`) follows the first one, when there is one.
export const restartUnavailableLine = (reason: string | null | undefined) =>
  `This session can't be resumed, so restarting would lose it.${reason ? ` ${reason}` : ""}`;

// ---- the sidebar's dot ------------------------------------------------------------------------------------------

export const UPDATE_DOT_TIP = "An agent has an update";
