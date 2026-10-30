// Plan ran out, keep going (SP4, Task X10): the words and small rules of a held session's banner, its confirm
// dialog, Wait for reset, Cursor's "Hand to Claude Code or Codex", and the Runs page's Held wording.
// `import type` only (decision P14): test/sessions-keep-going-ui-logic.test.js loads this file straight from src/.
// The sentences are the spec's, the prototype's (sessions.html, limitBanner() and keepGoingDialog()) or existing
// ones (RunLimitBanner, continue.js); the new ones are listed in the plan's Task X10 for the owner's review (Q32).
import type { HandoffResult, KeepGoingInfo, KeepGoingResult, SessionSummary } from "../types";

export const KEEP_GOING_LABEL = "Keep going on OpenRouter";
export const WAIT_FOR_RESET_LABEL = "Wait for reset";
export const SHOW_CHOICES_LABEL = "Show my choices";
export const KEEP_GOING_TITLE = "Keep going on OpenRouter?";
export const CANCEL_LABEL = "Cancel";
export const BRAIN_LINK_LABEL = "Agents → Brain";
export const OPTIONS_LOADING = "Working out your options…";
export const OPTIONS_FAILED = "Couldn't work out the options.";
export const TRY_AGAIN_LABEL = "Try again";
export const CODEX_NEW_CONVERSATION = "This starts a new Codex conversation from a summary of the last screen.";
export const HAND_OVER_LABEL = "Hand to Claude Code or Codex";
export const HAND_OVER_TITLE = "Hand to Claude Code or Codex?";
export const HAND_OVER_CONFIRM = "Hand over";
export const HAND_OVER_BODY =
  "Agent OS types a summary of Cursor's last screen into the agent you pick, in this folder: an open session there when it can take typed text, otherwise a new one. It is typed for you, not sent.";

export type HandOverTarget = "claude" | "codex";
export const HAND_OVER_TARGETS: ReadonlyArray<{ id: HandOverTarget; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" }
];

// Only a held Claude Code or Codex agent session gets the banner: Cursor, Hermes and OpenClaw are never held (spec,
// Limit rule per agent).
export function showsLimitBanner(s: Pick<SessionSummary, "kind" | "agentId" | "status">): boolean {
  return s.kind === "agent" && s.status === "held" && (s.agentId === "claude" || s.agentId === "codex");
}

// Fix round 1 (I1): the banner goes with the hold, but not while Keep going is working or has failed. A Claude Code
// keep going is a Stop, then a Resume: the stop makes the session "exited" (so no longer held) while the request is
// still running, and a Resume that then fails must still say why. The sentence stays until the session runs again.
export function keepGoingStaysOnScreen(shown: boolean, busy: boolean, failure: string): boolean {
  return shown || busy || failure !== "";
}

// Fix round 1 (M5): a Codex keep going opens a new pay-per-use session, so a hold gets one. The page remembers the
// session a hold opened (kept while the app is open, so switching tabs does not forget it; the server also refuses a
// second one for the same hold) and shows that instead of Keep going.
const openedByHold = new Map<string, string>();
const OPENED_MEMORY = 100;
export function rememberOpened(hold: string, targetId: string): void {
  openedByHold.delete(hold);
  openedByHold.set(hold, targetId);
  while (openedByHold.size > OPENED_MEMORY) openedByHold.delete(openedByHold.keys().next().value as string);
}
export function openedFor(hold: string): string | null {
  return openedByHold.get(hold) ?? null;
}
export function forgetOpened(hold: string): void {
  openedByHold.delete(hold);
}
// Sweep A item 11 (X10 N2): the new session a hold opened counts as open until the sessions list shows it ended; then the
// hold offers Keep going again (the server accepts another press once that session has ended). A session the list does
// not hold yet counts as open, because the list is read every 5 seconds and can lag a session that was just made.
// `sessions` is null while the list is not known.
export function openedStillOpen(openedId: string | null, sessions: ReadonlyArray<Pick<SessionSummary, "id" | "status">> | null): string | null {
  if (openedId === null || sessions === null) return openedId;
  const found = sessions.find((s) => s.id === openedId);
  return found && found.status === "exited" ? null : openedId;
}

// Sweep A item 11 (X10 N1): the sentence of a Keep going that stopped a session and could not resume it. The one this page
// just got comes first; otherwise the server's, kept with the ended session (so it is still there after the person left the
// pane while the request ran, or reloaded). Only an ended session shows one. "" for none.
export function keepGoingFailureText(local: string, s: Pick<SessionSummary, "status" | "keepGoingFailure">): string {
  if (local !== "") return local;
  return s.status === "exited" && typeof s.keepGoingFailure === "string" ? s.keepGoingFailure : "";
}

// Sweep A item 11 (X10 N4): a refusal is kept on the banner only while the session is ended or still shown as held (the list
// can lag the stop by a few seconds). On a session that runs again (Claude Code's own auto-resume got there first and the
// answer was "not held"), nothing is left behind: no red banner over a healthy session.
export function keepsRefusal(status: SessionSummary["status"]): boolean {
  return status === "exited" || status === "held";
}
// NEW SENTENCES (Q32), fix round 1 (M5): what the held session's banner says once its new session is open, and the
// button that shows it.
export function openedSessionLine(agentLabel: string): string {
  return `A new ${agentLabel} session was opened on OpenRouter.`;
}
export const SHOW_NEW_SESSION_LABEL = "Show the new session";

// "Wait for reset" holds for this hold only: a new hold (another stateSince) shows the choices again.
export function waitKey(s: Pick<SessionSummary, "id" | "stateSince">): string {
  return `${s.id}:${s.stateSince ?? ""}`;
}

export interface LimitBannerCopy {
  title: string;
  resets: string | null;
  sub: string;
}

// `resetText` is the reset time already in words ("2:21 am", "Oct 30, 2:21 am"; formatResetTime), or "".
export function limitBannerCopy(s: Pick<SessionSummary, "agentId" | "agentLabel">, resetText: string): LimitBannerCopy {
  return {
    title: `${s.agentLabel}'s plan limit was reached.`,
    resets: resetText ? `Resets ${resetText}.` : null,
    // Only Claude Code keeps the same conversation; Codex's keep going is a new one (its dialog says so).
    sub: s.agentId === "claude" ? "Continues the same conversation. OpenRouter is pay-per-use." : "OpenRouter is pay-per-use."
  };
}

export function sessionWaitingText(resetText: string): string {
  return `Waiting for your plan to reset${resetText ? ` (about ${resetText})` : ""}. The session stays Held and Agent OS sends nothing.`;
}

// The Runs page's Held run after Wait for reset (spec: Runs stay Held with "press Keep going after the reset").
export function runWaitingText(resetText: string): string {
  return `Waiting for your plan to reset${resetText ? ` (about ${resetText})` : ""}. This run stays Held and nothing carries on by itself: press Keep going after the reset.`;
}

// The Agents → Brain link goes with a reason the person fixes there: no key, no Codex model, or a Claude model on
// OpenRouter that isn't Anthropic's (continue.js's rule).
export function needsBrainLink(info: Pick<KeepGoingInfo, "agentId" | "available" | "needsKey" | "model">): boolean {
  if (info.available) return false;
  if (info.needsKey || info.model === null) return true;
  return info.agentId === "claude" && !/^~?anthropic\//.test(info.model);
}

export function estimateSentence(info: Pick<KeepGoingInfo, "estimateUsd">): string {
  return typeof info.estimateUsd === "number" && Number.isFinite(info.estimateUsd)
    ? `About $${info.estimateUsd.toFixed(2)} just to get started.`
    : "Agent OS couldn't estimate the cost.";
}

export interface KeepGoingPoint {
  key: "same" | "typed" | "pay" | "call";
  label: string;
  text: string;
}

export interface KeepGoingDialogCopy {
  title: string;
  lede: string;
  points: KeepGoingPoint[];
  model: string | null;
  note: string;
  warnings: string[];
  stays: string | null;
  confirm: string;
  cancel: string;
}

// The prototype's keepGoingDialog(): the spec's title, points and buttons. Its cost sentence ("The cost shows as —
// until OpenRouter reports it.") is not used: the Live meter shows Claude's own estimate from the start (ruling
// R11), so continue.js's estimate is shown instead.
export function keepGoingDialogCopy(info: KeepGoingInfo, agentLabel: string): KeepGoingDialogCopy {
  const pay: KeepGoingPoint = { key: "pay", label: "Pay per use.", text: `OpenRouter charges for each message. ${estimateSentence(info)}` };
  const call: KeepGoingPoint = { key: "call", label: "Your call.", text: "Nothing is switched until you press the button below." };
  const shared = { title: KEEP_GOING_TITLE, model: info.model, note: info.estimateNote, warnings: [...info.warnings], confirm: KEEP_GOING_LABEL, cancel: CANCEL_LABEL };
  if (info.approach === "new") {
    return {
      ...shared,
      lede: CODEX_NEW_CONVERSATION,
      points: [{ key: "typed", label: "Typed for you, not sent.", text: "You read the summary in the new session and press Enter yourself." }, pay, call],
      stays: `This held ${agentLabel} session stays open. Stop it when you no longer need it.`
    };
  }
  return {
    ...shared,
    lede: `${agentLabel} carries on with this same conversation, using your OpenRouter brain instead of your plan.`,
    points: [{ key: "same", label: "Same conversation.", text: `${agentLabel} keeps what it has read and written so far.` }, pay, call],
    stays: null
  };
}

// The tab to open after Keep going: Claude Code's own (resumed in place) or Codex's new session.
export function keptGoingTarget(answer: Pick<KeepGoingResult, "targetId"> | null | undefined, sessionId: string): string {
  return answer && typeof answer.targetId === "string" && answer.targetId ? answer.targetId : sessionId;
}

// Cursor has no limit signal, so its hand-over is a button there at any time while the session runs (spec).
export function canHandOver(s: Pick<SessionSummary, "kind" | "agentId" | "status">): boolean {
  return s.kind === "agent" && s.agentId === "cursor" && s.status !== "exited";
}

export interface HandOverOutcome {
  open: string | null;
  copy: { text: string; reason: string | null } | null;
}

// What the page does with the server's answer: open the target's tab ("typed", "opening"), or show the text to copy.
export function handOverOutcome(answer: Partial<HandoffResult> | null | undefined): HandOverOutcome {
  if (!answer || typeof answer !== "object") return { open: null, copy: null };
  if ((answer.result === "typed" || answer.result === "opening") && typeof answer.targetId === "string" && answer.targetId) {
    return { open: answer.targetId, copy: null };
  }
  if (answer.result === "copy" && typeof answer.text === "string") {
    return { open: null, copy: { text: answer.text, reason: typeof answer.reason === "string" ? answer.reason : null } };
  }
  return { open: null, copy: null };
}
