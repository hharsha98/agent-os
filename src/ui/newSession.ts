// Pure logic of the New session dialog: how any page asks for it, the checks that give a plain reason before
// anything is sent, and the words for what the server may answer. No React and only `import type` (decision
// P14), so `node --test` loads it straight from src/ (test/sessions-page-logic.test.js).
import type { ExecutionGateStatus } from "../types";

export const NEW_SESSION_EVENT = "aos-new-session";
export interface NewSessionRequest {
  agentId?: string;
}

// The Shell listens for this and shows the one New session dialog, so the Sessions page's button and ⌘T, Home,
// Agents and the palette all open the same thing.
export function openNewSession(request: NewSessionRequest = {}) {
  window.dispatchEvent(new CustomEvent<NewSessionRequest>(NEW_SESSION_EVENT, { detail: request }));
}

// The dialog's agent order (the prototype's): the three coding agents, then Hermes and OpenClaw.
export const SESSION_AGENT_ORDER = ["claude", "codex", "cursor", "hermes", "openclaw"];

// The agent the dialog starts on: the one asked for, else the first installed one, else Claude Code.
export function pickSessionAgent(agents: Array<{ id: string; detected: { installed: boolean } }> | null, wanted?: string): string {
  if (wanted && SESSION_AGENT_ORDER.includes(wanted)) return wanted;
  const installed = agents ? SESSION_AGENT_ORDER.find((id) => agents.some((agent) => agent.id === id && agent.detected.installed)) : undefined;
  return installed || SESSION_AGENT_ORDER[0];
}

// Decision Q15, verbatim.
export const LOOK_ONLY_NOTE = "Safety is on Look only, so no session can start. Allow running agents in Safety, then try again.";

// true at Look only (the server's level 0 is "the gate is off"), false when a session may start, null while not known.
export function isLookOnly(gate: Pick<ExecutionGateStatus, "enabled" | "level"> | null): boolean | null {
  if (!gate) return null;
  if (gate.enabled === false) return true;
  return typeof gate.level === "number" ? gate.level === 0 : false;
}

// OpenClaw starts in your home folder until spike S5 checks that it honours a chosen folder (spec, Launch
// profiles), so the dialog offers no folder for it and says so.
export const OPENCLAW_FOLDER_NOTE = "OpenClaw picks its own folder for now.";
export function needsFolder(agentId: string): boolean {
  return agentId !== "openclaw";
}

export const FOLDER_FORMAT_PROBLEM = "Type the full path, starting with / (or a drive letter on Windows).";
export const FOLDER_EXAMPLE = "For example /Users/you/projects/my-app";

// A folder typed in a browser tab (a browser picker cannot give a full path). Empty: nothing to say yet.
// Everything else (inside your home folder, not Agent OS's own folder, a real folder) is the server's check.
export function typedFolderProblem(text: string): string {
  const value = text.trim();
  if (!value) return "";
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return "";
  return FOLDER_FORMAT_PROBLEM;
}

// Open agent sessions count toward the most at once; ended ones and update sessions do not (spec, Session kinds).
export function liveSessionCount(sessions: Array<{ status: string; kind?: string }>): number {
  return sessions.filter((session) => session.kind !== "update" && session.status !== "exited").length;
}
// Decision Q25's words, with the server's own number.
export function maxLiveNote(maxLive: number): string {
  return `Agent OS runs at most ${maxLive} sessions at once. Stop one, then try again.`;
}

// The start got no answer in time (or the connection dropped). The session may well have started, so the words
// never say "nothing started"; they send the person to the tabs to look.
const START_LOOK = "The session may have started: look at the tabs on the Sessions page before you press Start session again.";
export const START_NO_ANSWER = `Agent OS hasn't answered. ${START_LOOK}`;
// An answer came but could not be read (ruling, Task U3): it is not "no answer", so the words say Agent OS did
// answer, then carry the same second sentence.
export const START_UNREADABLE = `Agent OS answered, but the answer couldn't be read. ${START_LOOK}`;

export interface StartProblem {
  text: string;
  // "folder": the words belong under the Folder field (the server's folder policy refused it).
  field?: "folder";
  // Which way out the dialog offers next to the words.
  fix?: "safety" | "setup" | "sessions";
}

// The words for a start that failed. An error that is not Agent OS's own answer (src/api.ts throws an Error named
// "ApiError" for those) is no answer at all, unless an answer did come and could not be read (START_UNREADABLE).
// `gotNoAnswer` is what src/sessionsApi.ts's sessionGotNoAnswer(error) says, and the dialog passes it: that file
// owns the rule for which failures are an answer that could not be read, and this one (which keeps only
// `import type`, so Node can load it) keeps only the words. true (the default) is no answer at all; false is an
// answer that could not be read. Either way the session may have started, so the words send the person to the tabs.
export function startProblem(error: unknown, gotNoAnswer = true): StartProblem {
  if (!(error instanceof Error) || error.name !== "ApiError") {
    return { text: gotNoAnswer ? START_NO_ANSWER : START_UNREADABLE, fix: "sessions" };
  }
  const code = error.message;
  const detail = String((error as Error & { detail?: unknown }).detail || "").trim();
  if (code === "folder_refused") return { text: detail || "Agent OS can't use that folder. Pick another one.", field: "folder" };
  if (code === "execution_gate_off") return { text: LOOK_ONLY_NOTE, fix: "safety" };
  if (code === "agent_not_installed") return { text: detail || "That agent isn't installed, or Agent OS can't find it. Install it in Setup, then try again.", fix: "setup" };
  if (code === "not_available") return { text: "Sessions are not available in this mode of Agent OS." };
  return { text: detail || "Agent OS couldn't start the session." };
}

// The id in the server's answer to a start, or null when the answer is not a session (a 2xx answer of `null`, say).
// The dialog treats null as an answer that could not be read, like a body that is not JSON, and acts on nothing.
export function createdSessionId(answer: unknown): string | null {
  const id = typeof answer === "object" && answer !== null ? (answer as { id?: unknown }).id : undefined;
  return typeof id === "string" && id !== "" ? id : null;
}

// What the person picked and typed, kept in memory while the app stays open: closing the dialog, or going to
// Safety or Setup to fix what blocked it, never loses a typed folder (SP2 lesson). A start clears it.
let draft: { agentId: string; folder: string } | null = null;
export function rememberSessionDraft(next: { agentId: string; folder: string } | null) {
  draft = next;
}
export function peekSessionDraft(): { agentId: string; folder: string } | null {
  return draft;
}

// After Start session (or Resume conversation in Runs) the button that was pressed is gone, so the new session's
// terminal takes the keyboard. A one-shot flag, because the Sessions page may not be mounted yet.
let focusNextSession = false;
export function askToFocusNextSession() {
  focusNextSession = true;
}
export function takeFocusNextSession(): boolean {
  const asked = focusNextSession;
  focusNextSession = false;
  return asked;
}
