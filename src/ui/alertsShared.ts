// Alerts (SP4, Task U5): the words and small rules around the tab markers. The top-bar badge, the Home strip, Safety's
// list of questions asked in a terminal, the message a browser tab shows, the session panel's alert lines (hooks switched
// off and why, the trust line, basic alerts), OpenClaw's approval cards and the desktop app's one-time note. Every alert
// comes from the server: each session's alert is in GET /api/sessions (ruling R22) and OpenClaw's pending approvals in
// GET /api/sessions/approvals (Task X3); nothing here decides that something waits. `import type` only, plus the
// sessionsShared.ts import below, so test/sessions-alerts-ui-logic.test.js loads this file straight from src/.
import type { ApprovalCard, ApprovalDecision, HooksOffCode, SessionSummary } from "../types";
// Node cannot follow an extensionless import when a test loads this file straight from src/; tsconfig does not allow the
// extension, so TypeScript's only complaint (TS5097) is silenced on this one line (the homeShared.ts pattern).
// @ts-expect-error TS5097
import { resetWords, sessionTitle } from "./sessionsShared.ts";

// The per-viewer key that remembers the desktop note was dismissed (K17).
export const NOTIFY_NOTE_KEY = "agentos.notifyNote.v1";
// The server's words for a basic alert (signals.js BASIC_ALERT_TEXT, ruling R19): a bell or a title sign from Hermes or
// Cursor, which may also mean the agent finished.
export const BASIC_ALERT_TEXT = "May need you";
// Spec, Session activity states: until the person trusts the folder inside Claude (Task X2a's trustNeeded).
export const TRUST_LINE = "Alerts start after you trust this folder in Claude";
// R16: a card OpenClaw could not match to one session shows in every open OpenClaw panel with these words.
export const FROM_OPENCLAW = "from OpenClaw";
// A resolve that got no answer at all may still have reached OpenClaw.
export const APPROVAL_NO_ANSWER = "Agent OS hasn't answered. OpenClaw may have your answer already: the card goes once it has.";
// How long a card you answered stays as "You allowed it once" or "You said no" after OpenClaw's list drops it.
export const ANSWER_SHOWN_MS = 6000;
// The existing words for a list that could not be refreshed (Agents and Sessions use them too).
export const APPROVALS_STALE = "Showing what was last known.";
// The Home strip shows at most this many rows; the rest are counted.
export const STRIP_MAX = 3;

type Listed = Pick<SessionSummary, "id" | "kind" | "status" | "agentId" | "agentLabel" | "folderName" | "folderShown"> & {
  alert?: SessionSummary["alert"];
  resetAt?: string | null;
};

// Signals scope: only agent sessions alert; update and setup sessions never do.
function needsYou(s: Pick<SessionSummary, "kind" | "status">, status: "waiting" | "held"): boolean {
  return s.kind === "agent" && s.status === status;
}

// K22: the badge counts agent sessions that wait for the person. A held session shows on its tab and the Home strip.
export function waitingCount(sessions: ReadonlyArray<Pick<SessionSummary, "kind" | "status">>): number {
  return sessions.filter((s) => needsYou(s, "waiting")).length;
}

export function waitingBadgeText(n: number): string {
  return Number.isInteger(n) && n > 0 ? `Waiting for you (${n})` : "";
}

export interface StripItem {
  id: string;
  kind: "waiting" | "held";
  title: string;
  text: string;
}

function askedText(s: Listed): string {
  const text = typeof s.alert?.text === "string" ? s.alert.text.trim() : "";
  return text || "Waiting for you";
}

function askedAt(s: Listed): number {
  const time = s.alert?.at ? Date.parse(s.alert.at) : NaN;
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

// The Home strip: every agent session that waits for you, the one that has waited longest first, then every one whose
// plan ran out, with its reset time when known (spec, Alerts UI and Session activity states).
export function homeStripItems(sessions: ReadonlyArray<Listed>, now: number = Date.now()): StripItem[] {
  const waiting = sessions
    .filter((s) => needsYou(s, "waiting"))
    .map((s, index) => ({ s, index }))
    .sort((a, b) => askedAt(a.s) - askedAt(b.s) || a.index - b.index)
    .map(({ s }): StripItem => ({ id: s.id, kind: "waiting", title: sessionTitle(s), text: askedText(s) }));
  const held = sessions
    .filter((s) => needsYou(s, "held"))
    .map((s): StripItem => {
      const when = resetWords(s.resetAt, now);
      return { id: s.id, kind: "held", title: sessionTitle(s), text: when ? `Plan ran out. Resets ${when}.` : "Plan ran out." };
    });
  return [...waiting, ...held];
}

export function stripMore(n: number): string {
  return Number.isInteger(n) && n > 0 ? `${n} more in Sessions.` : "";
}

// Safety's rows for questions asked inside an agent's own terminal: every waiting session except an OpenClaw session
// whose question is a card on that page (its alert is an approval).
export function terminalQuestions(sessions: ReadonlyArray<Listed>): StripItem[] {
  const asCard = new Set(sessions.filter((s) => s.agentId === "openclaw" && s.alert?.kind === "approval").map((s) => s.id));
  return homeStripItems(sessions).filter((item) => item.kind === "waiting" && !asCard.has(item.id));
}

const HOOKS_OFF: Record<HooksOffCode, string> = {
  all_hooks_disabled: "Alerts and the Live meter are off for this session: your Claude settings turn off all hooks.",
  managed_hooks_only: "Alerts and the Live meter are off for this session: your organization's Claude settings allow only its own hooks.",
  http_hook_urls: "Alerts are off for this session: your Claude settings allow hooks to reach only the addresses they list.",
  http_hook_env_vars: "Alerts are off for this session: your Claude settings don't let hooks use Agent OS's token.",
  managed_status_line: "The Live meter is off for this session: your organization's Claude settings set the status line."
};

// R9: why alerts or the Live meter are off in this session; "" for anything that is not a code this version knows.
export function hooksOffLine(code: unknown): string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(HOOKS_OFF, code) ? HOOKS_OFF[code as HooksOffCode] : "";
}

type PanelAlertFields = Pick<SessionSummary, "kind" | "status" | "agentId" | "agentLabel"> & {
  trustNeeded?: boolean;
  hooksOff?: SessionSummary["hooksOff"] | null;
};

// The lines under the panel's state line, in this order: why alerts are off (R9), why the Live meter is off when that
// is a different reason, the trust line (live or idle, and only when hooks are not switched off: trusting the folder
// would then bring nothing), and for Hermes and Cursor that their alerts are basic (R18) whenever the state line does
// not already say so.
export function panelAlertLines(s: PanelAlertFields): string[] {
  if (s.kind !== "agent" || s.status === "exited") return [];
  const off = s.hooksOff ?? { alerts: null, meter: null };
  const lines: string[] = [];
  const alertsOff = hooksOffLine(off.alerts);
  const meterOff = off.meter !== off.alerts ? hooksOffLine(off.meter) : "";
  if (alertsOff) lines.push(alertsOff);
  if (meterOff) lines.push(meterOff);
  // `off.alerts` rather than its sentence: a code from a newer server has no words here but alerts are off all the same.
  if (!off.alerts && s.trustNeeded === true && (s.status === "live" || s.status === "idle")) lines.push(TRUST_LINE);
  if ((s.agentId === "hermes" || s.agentId === "cursor") && s.status !== "live" && s.status !== "starting") {
    lines.push(`Alerts for ${s.agentLabel} are basic.`);
  }
  return lines;
}

// The browser tab's message (spec, Alerts UI: "In browser mode, an in-app toast only"): one for each change between two
// reads of the list into waiting or held. The first read is not news, and new words for an alert that was already
// there are not either. Several at once give one message.
export function alertToast(prev: ReadonlyArray<Listed> | null, next: ReadonlyArray<Listed>): string | null {
  if (!prev) return null;
  const before = new Map(prev.map((s) => [s.id, s.status]));
  const fresh = next.filter((s) => (needsYou(s, "waiting") || needsYou(s, "held")) && before.get(s.id) !== s.status);
  if (fresh.length === 0) return null;
  if (fresh.length > 1) return `${fresh.length} sessions need you.`;
  const s = fresh[0];
  const title = sessionTitle(s);
  if (s.status === "held") return `Plan ran out for ${title}.`;
  const text = typeof s.alert?.text === "string" ? s.alert.text.trim() : "";
  if (text === BASIC_ALERT_TEXT) return `${title} may need you.`;
  if (!text || text === "Waiting for you") return `${title} is waiting for you.`;
  return `${title} is waiting for you. ${/[.!?…]$/.test(text) ? text : `${text}.`}`;
}

// K17: the desktop app explains its notifications once on the Sessions page (the page itself never asks for or sends
// one, R20; macOS asks by itself on the first notification the shell shows).
export function notifyNote({ desktop, isMac, dismissed }: { desktop: boolean; isMac: boolean; dismissed: boolean }): string | null {
  if (!desktop || dismissed) return null;
  const first = "Agent OS shows a notification when a session needs you and its window is hidden.";
  return isMac ? `${first} macOS asks once whether to allow it.` : first;
}

// R16, K11: a session's panel shows its own cards and every card OpenClaw could not match to one session.
export function approvalsForSession(cards: ReadonlyArray<ApprovalCard>, sessionId: string): ApprovalCard[] {
  return cards.filter((card) => card.sessionId === sessionId || card.sessionId === null);
}

export function approvalHeading(card: Pick<ApprovalCard, "kind">): string {
  return card.kind === "exec" ? "OpenClaw wants to run" : "OpenClaw asks for approval";
}

export interface ApprovalConfirm {
  title: string;
  body: string;
  confirm: string;
}

// The confirm before an answer is sent. A command is shown exactly as OpenClaw gave it; another kind's summary loses a
// trailing full stop so the sentence reads once.
export function approvalConfirm(card: Pick<ApprovalCard, "kind" | "summary">, decision: ApprovalDecision): ApprovalConfirm {
  if (decision === "deny") return { title: "Deny this?", body: "OpenClaw is told no.", confirm: "Deny" };
  const summary = String(card.summary ?? "").trim();
  if (card.kind === "exec") {
    return { title: "Allow this once?", body: `OpenClaw runs ${summary || "it"} this one time. It asks again next time.`, confirm: "Allow once" };
  }
  const what = summary.replace(/[.\s]+$/, "") || "it";
  return { title: "Allow this once?", body: `OpenClaw goes ahead with this one time: ${what}. It asks again next time.`, confirm: "Allow once" };
}

export function approvalDoneHeading(decision: ApprovalDecision): string {
  return decision === "allow-once" ? "You allowed it once" : "You said no";
}

export interface Answered {
  decision: ApprovalDecision;
  at: number;
  card: ApprovalCard;
}

export interface ApprovalItem {
  card: ApprovalCard;
  answered: ApprovalDecision | null;
}

// Forget an answer once OpenClaw no longer lists its card and it showed for ANSWER_SHOWN_MS (the same rule approvalView
// hides it by), so the one-second clock that waits for it can stop. The same object comes back when nothing is dropped.
export function pruneAnswered(answered: Readonly<Record<string, Answered>>, cards: ReadonlyArray<ApprovalCard>, now: number): Record<string, Answered> {
  const listed = new Set(cards.map((card) => card.id));
  const kept = Object.entries(answered).filter(([id, done]) => listed.has(id) || now - done.at < ANSWER_SHOWN_MS);
  return kept.length === Object.keys(answered).length ? (answered as Record<string, Answered>) : Object.fromEntries(kept);
}

// OpenClaw's refusal kept for a card (shown on it after its dialog closed) goes when the card leaves the list. The same
// object comes back when nothing is dropped.
export function pruneCardErrors(errors: Readonly<Record<string, string>>, cards: ReadonlyArray<ApprovalCard>): Record<string, string> {
  const listed = new Set(cards.map((card) => card.id));
  const kept = Object.entries(errors).filter(([id]) => listed.has(id));
  return kept.length === Object.keys(errors).length ? (errors as Record<string, string>) : Object.fromEntries(kept);
}

// What the cards show: OpenClaw's list, a card answered here marked with its answer, and an answered card OpenClaw
// already dropped kept for ANSWER_SHOWN_MS after the answer, so it does not vanish the moment you press.
export function approvalView(cards: ReadonlyArray<ApprovalCard>, answered: Readonly<Record<string, Answered>>, now: number): ApprovalItem[] {
  const items: ApprovalItem[] = cards.map((card) => ({ card, answered: answered[card.id]?.decision ?? null }));
  const listed = new Set(cards.map((card) => card.id));
  for (const [id, done] of Object.entries(answered)) {
    if (!listed.has(id) && now - done.at < ANSWER_SHOWN_MS) items.push({ card: done.card, answered: done.decision });
  }
  return items;
}
