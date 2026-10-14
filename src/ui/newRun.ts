// Pure logic of the New run dialog: how any page asks for it, the checks that give a plain reason
// before anything is sent, and the words for what the server may answer. No React; only types are
// imported, so `node --test` can load it (test/runs-board.test.js).
import type { ExecutionGateStatus } from "../types";

export const NEW_RUN_EVENT = "aos-new-run";
export interface NewRunRequest {
  agentId?: string;
  prompt?: string;
}

// The Shell listens for this and shows the one New run dialog, so the page button and the ⌘K action are the same thing.
export function openNewRun(request: NewRunRequest = {}) {
  window.dispatchEvent(new CustomEvent<NewRunRequest>(NEW_RUN_EVENT, { detail: request }));
}

// The words under the safety level. Copy must be true (D-C3-5): the server's only kind of Held is a
// plan limit, and a step the safety level does not allow is refused, so that run ends Failed or Stopped
// in Landed. The spec's first wording ("ends the run as Held") said otherwise, so this one replaces it.
export const RISKY_STEP_HINT = "Anything this safety level does not allow is refused, not run.";
export const TASK_MAX = 20000;
// The character count under the Task field shows from here (90% of TASK_MAX), so a normal task has no number to read.
export const TASK_COUNT_FROM = 18000;

// After Start run, the dialog closes and the run's console opens. The button that was pressed is gone by
// then, so keyboard focus would fall to the page. The dialog asks (askToFocusNextRun) and the Runs page
// takes the request (takeFocusNextRun) and puts focus on the console's title. A one-shot flag, because
// the Runs page may not be mounted yet when the dialog starts the run from another page.
let focusNextRun = false;
export function askToFocusNextRun() {
  focusNextRun = true;
}
export function takeFocusNextRun(): boolean {
  const asked = focusNextRun;
  focusNextRun = false;
  return asked;
}

// A task the person typed and then left without starting (they went to Safety or Setup to fix what
// blocked the run). It is kept here, in memory for as long as the app stays open, and put back the next
// time New run opens. Starting the run, or choosing Discard, clears it.
let draftTask = "";
export function rememberDraft(task: string) {
  draftTask = task;
}
export function peekDraft(): string {
  return draftTask;
}

// The Agent field's note for the three coding agents (decision D-C3-4: the dialog never asks for edit
// permission). Each is started without permission to change files: Codex with a read-only sandbox,
// Claude Code in a mode that refuses anything not pre-approved, Cursor Agent in a mode that only
// proposes changes. An empty string for Hermes and OpenClaw, which the note does not describe.
export function noEditsNote(agentId: string): string {
  return agentId === "claude" || agentId === "codex" || agentId === "cursor"
    ? "Agent OS doesn't give this run permission to change files. It can read them and report back."
    : "";
}

type Gate = Pick<ExecutionGateStatus, "enabled" | "level"> | null;

// The same words as the top bar: "Level 1 · Run agents". Empty while the safety level is not known.
export function levelWord(gate: Gate): string {
  if (!gate) return "";
  const level = typeof gate.level === "number" ? gate.level : gate.enabled ? 1 : 0;
  return level === 0 ? "Level 0 · Look only" : level === 1 ? "Level 1 · Run agents" : "Level 2 · Machine control";
}

// Why a run cannot start because of safety, or null when nothing is in the way. Both reasons point at Safety.
export function gateBlock(gate: Gate): { kind: "look-only" | "gate-off"; text: string } | null {
  if (!gate) return null;
  if (gate.level === 0) {
    return { kind: "look-only", text: "Safety is set to Look only, so agents can't run yet. Raise it to Run agents on the Safety page." };
  }
  if (!gate.enabled) {
    return { kind: "gate-off", text: "Running agents is switched off (the execution gate is off). Turn it on in Safety." };
  }
  return null;
}

// The task field never cuts a pasted task short. A task over TASK_MAX is explained and never sent.
export function taskTooLong(task: string): boolean {
  return task.trim().length > TASK_MAX;
}

export function taskProblem(task: string): string {
  const text = task.trim();
  if (!text) return "Write what the agent should do first.";
  if (taskTooLong(text)) return `That task is too long. The limit is ${TASK_MAX.toLocaleString("en-US")} characters.`;
  return "";
}

// "18,400 of 20,000 characters" once the task is near the limit or over it, else "" (show nothing).
export function taskCount(task: string): string {
  const length = task.trim().length;
  if (length < TASK_COUNT_FROM) return "";
  return `${length.toLocaleString("en-US")} of ${TASK_MAX.toLocaleString("en-US")} characters`;
}

// The folder is a name INSIDE the Workspace; the server checks this again and refuses anything outside.
export function folderProblem(folder: string): string {
  const text = folder.trim();
  if (!text) return "";
  if (text.includes("\0") || /^([\\/]|~|[A-Za-z]:)/.test(text)) {
    return "Type a folder name inside the Workspace, such as notes/today. A full path to somewhere else is not allowed.";
  }
  if (text.split(/[\\/]+/).includes("..")) return 'A folder can\'t go up and out of the Workspace. Remove the ".." parts.';
  return "";
}

// The agent the dialog starts on: the one asked for, else the first installed one in `order`, else the first.
export function pickAgent(agents: Array<{ id: string; detected: { installed: boolean } }> | null, order: string[], wanted?: string): string {
  if (wanted && order.includes(wanted)) return wanted;
  const installed = agents ? order.find((id) => agents.some((agent) => agent.id === id && agent.detected.installed)) : undefined;
  return installed || order[0];
}

// Real folders inside the Workspace (first two levels), for the Folder field's suggestions.
export function folderSuggestions(files: Array<{ root: string; relativePath: string }>): string[] {
  const found = new Set<string>();
  for (const file of files) {
    if (file.root !== "workspace") continue;
    const parts = file.relativePath.split(/[\\/]+/).filter(Boolean);
    for (let depth = 1; depth < parts.length && depth <= 2; depth += 1) found.add(parts.slice(0, depth).join("/"));
  }
  return [...found].sort().slice(0, 30);
}

// Words for the answers the start route can give. null means "not one I know": the caller falls back
// to friendlyError(). `fix` says which button helps.
export function startError(code: string): { text: string; fix?: "safety" | "folder" | "runs" } | null {
  if (code === "execution_gate_off") return { text: "Safety is set to Look only. Agents can't run until you allow it.", fix: "safety" };
  if (code === "folder_outside_sandbox") return { text: "That folder is outside the Workspace. Type a folder name inside it, or leave the folder empty.", fix: "folder" };
  if (code === "too_many_runs") return { text: "Too many runs are already working. Wait for one to finish, then press Start run again." };
  return null;
}

// The start request got no answer in time (or the connection dropped). The run may well have started, so the
// words never say "nothing was started"; they send the person to Runs to look.
export const START_NO_ANSWER = "Agent OS hasn't answered. The run may have started: check Runs before you press Start run again.";

// The words while the dialog is still asking Agent OS about the agents and the safety level.
export const CHECKING_WORDS = "Checking your agents and safety level…";
