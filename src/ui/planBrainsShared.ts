// Plan brains (spec docs/superpowers/specs/2026-10-15-plan-brains-design.md; Task B2): the words and the pure rules
// of OpenClaw's "Your plan" card (BrainPlanCard.tsx), its ChatGPT sign-in terminal (PlanSignInTerminal.tsx) and
// Hermes's "Choose in Hermes" (ChooseInHermes.tsx). Every sentence here is the spec's, word for word (the one name
// that is not, TYPED_MODEL_CHOICE_LABEL, is only read aloud, never drawn). The ones the
// server says too (the Claude Code readiness sentences, the two OpenClaw version sentences, the ChatGPT readiness
// sentences and the typed-name refusal), and the typed-name rule itself, are checked against the server's own
// constants by test/plan-brains-ui-logic.test.js. Only `import type` here, so that test loads this file straight
// from src/ (Node strips the types itself, decision P14).
import type { OpenclawPlan, OpenclawPlansInfo, PlanModelList, TerminalLaunch } from "../setupApi";
import type { SessionSummary } from "../types";

// ---- words ---------------------------------------------------------------------------------------------------

// OpenClaw's own security notice, shown once on the card above its one risk tick (spec section 2). The tick's
// words are Setup's (OPENCLAW_RISK_LABEL in agentModelChange.ts).
export const OPENCLAW_SECURITY_NOTICE =
  "This bot can read files and run actions if tools are enabled. A bad prompt can trick it into doing unsafe things.";

export const PLAN_LABEL: Record<OpenclawPlan, string> = { claude: "Claude plan", chatgpt: "ChatGPT plan" };

// Which provider each plan's models belong to; the server adds "anthropic/" or "openai/" itself (spec section 5).
export const PLAN_PROVIDER: Record<OpenclawPlan, string> = { claude: "anthropic", chatgpt: "openai" };

// Under the Brain card's model line, only while OpenClaw's own answer says it is on that plan (spec section 5).
export const PLAN_NOTE: Record<OpenclawPlan, string> = {
  claude:
    "Shares your Claude plan limits with Claude Code. Anthropic allows this for personal use today, but has changed these rules several times this year.",
  chatgpt: "Shares your ChatGPT plan limits with Codex."
};

// What the Claude plan section says when it offers no model list (spec section 2). Not signed in shows the
// "Sign in to Claude Code" control instead of a sentence.
export const CLAUDE_PLAN_WORDS = {
  not_installed: "Install Claude Code first.",
  api_billing: "Claude Code uses an API key or a cloud account, not your Claude plan, so OpenClaw would bill that instead.",
  unknown_method: "Agent OS couldn't tell how Claude Code is signed in. Update Claude Code, then check again."
} as const;

// The ChatGPT plan section's sentences (spec section 3).
export const CHATGPT_PLAN_WORDS = {
  too_old: "Update OpenClaw first: its ChatGPT sign-in needs version 2026.9.7 or newer.",
  version_unknown: "Agent OS couldn't read OpenClaw's version.",
  no_sharing: "Signed in, but plan use isn't allowed yet. Sign in again and allow token sharing.",
  expiring: "Your ChatGPT sign-in expires soon. Sign in again.",
  not_ready: "OpenClaw can't use your ChatGPT plan yet. Sign in again, and allow token sharing when ChatGPT asks."
} as const;

export const FALLBACK_LIST_NOTE = "Agent OS couldn't read your account's model list, so this list may be out of date.";
export const NOT_ON_PLAN_NOTE = "Not available on your plan in this OpenClaw yet";
export const TYPED_MODEL_LABEL = "Type a model name";
// The fallback row's radio is named apart from its text field (which keeps the spec's "Type a model name"): the
// two controls are never announced with the same name. Only read aloud, never drawn.
export const TYPED_MODEL_CHOICE_LABEL = "Use the model name you type";
export const INVALID_PLAN_MODEL = "That doesn't look like a model name.";

// The two quiet lines next to "Choose in Hermes", shown before anything opens (spec section 4), in this order.
export const HERMES_PICKER_LINES = [
  "If you pick Anthropic without a Claude API key, Hermes uses your Claude Code sign-in (or its own Claude sign-in). Anthropic doesn't allow apps like Hermes to use Claude sign-ins this way: it's charged as usage credits, not your plan, it doesn't work on Pro, and it can sign Claude Code out. A Claude API key is fine.",
  "Hermes's 'ChatGPT or Codex Subscription' reuses Codex's own sign-in, which OpenAI hasn't documented for other apps. Hermes's official Sign in with ChatGPT isn't released yet."
] as const;

export const HERMES_TERMINAL_WORDS = {
  opened: "Terminal opened with Hermes's model picker. Choose there, then press Refresh.",
  copy: "Run this command in your own terminal, choose a model, then press Refresh.",
  spawn_failed: "Terminal didn't open. Run this command in your own terminal, choose a model, then press Refresh."
} as const;

// The same three answers for "Add a sign-in in Hermes" (`hermes auth`). The owner's sentence for the opened case is
// verbatim; the other two follow the model picker's wording and are not in the plan-brains spec yet (they wait for the
// owner's OK, then all three go into spec section 4 and the pinned set). Kept apart from HERMES_TERMINAL_WORDS, which is
// the spec's own set word for word.
export const HERMES_AUTH_TERMINAL_WORDS = {
  opened: "Terminal opened with Hermes's sign-in helper. Add your sign-in there, then press Refresh.",
  copy: "Run this command in your own terminal, add your sign-in there, then press Refresh.",
  spawn_failed: "Terminal didn't open. Run this command in your own terminal, add your sign-in there, then press Refresh."
} as const;

// The sign-in terminal's accessible name: the setup session's own title (sessionTitle in sessionsShared.ts, Task
// B1a), so it adds no new words; the test compares the two.
export const SIGNIN_TERMINAL_LABEL = "OpenClaw · ChatGPT sign-in";

// Words the rest of the app already says (setupGroupShared.ts, AgentBrainCard.tsx, SetupBrainPanel.tsx); the test
// checks they agree.
export const UNREADABLE_WORDS = "Agent OS gave an answer that could not be read.";
export const TIMEOUT_WORDS = "Agent OS did not answer in time.";
export const NO_ANSWER_WORDS = "Agent OS did not answer.";
export const MAY_HAVE_APPLIED = "It may or may not have been applied, so check what the agent uses now before trying again.";
export const CANCEL_UNSURE = "The cancel may not have gone through.";

// ---- time limits (P26: every request has one) ----------------------------------------------------------------

// plans: the server asks Claude Code and OpenClaw several questions, so it gets the brain read's limit
// (BRAIN_READ_LIMIT_MS); models: one `models list` and one `config get` (MODEL_READ_LIMIT_MS); apply: Apply, which
// also gets the brain read's limit, because before the job exists the server detects OpenClaw again, reads the
// sign-in again (`claude auth status` or `models auth list`) and reads the model list again, all inside the job lock
// (up to about 48 s on a slow OpenClaw), and an Apply given up too early would lose the job's id; action: starting
// the sign-in, cancelling a job, reading a job and the Hermes launch; signInLookup: asking for the live setup session.
export const PLAN_LIMITS_MS = { plans: 55_000, models: 30_000, apply: 55_000, action: 20_000, signInLookup: 10_000 } as const;
// The sign-in terminal asks this often whether its session has ended (spec section 1).
export const SIGNIN_POLL_MS = 5000;
// After a 409 setup_running, the running session is asked for every second, for up to 15 s.
export const SETUP_RUNNING_WAIT_MS = 15_000;
export const SETUP_RUNNING_POLL_MS = 1000;
// On window focus the plan card reads the plans again at most this often; Hermes's card reads its model at most
// every 2 s (focus events come in bursts when windows switch).
export const PLANS_FOCUS_GAP_MS = 20_000;
export const HERMES_FOCUS_GAP_MS = 2000;

// ---- rules ---------------------------------------------------------------------------------------------------

export type ClaudePlanState = "ready" | "not_installed" | "not_signed_in" | "api_billing" | "unknown_method";
export type ChatgptPlanState = "version_unknown" | "too_old" | "signed_out" | "no_sharing" | "ready";

// Claude Code's own sign-in methods (the plan), and the ones that bill an API key or a cloud account instead
// (the server's two lists).
export const CLAUDE_PLAN_METHODS = ["claude.ai", "oauth_token"] as const;
export const CLAUDE_API_METHODS = ["api_key", "api_key_helper", "third_party"] as const;

// The server's rule (claudePlanReadiness in server/runtime/setup/openclaw-plan-rules.js), in the same order.
export function claudePlanState(claude: OpenclawPlansInfo["claude"]): ClaudePlanState {
  if (!claude.installed) return "not_installed";
  if (claude.status === "not_signed_in") return "not_signed_in";
  if (claude.method !== null && (CLAUDE_API_METHODS as readonly string[]).includes(claude.method)) return "api_billing";
  // Not signed in with one of Claude Code's own methods (an older Claude Code that can't say how, or a method this
  // version doesn't know) is "couldn't tell", exactly as the committed server rule (Task B1b) has it.
  if (claude.status !== "signed_in" || claude.method === null || !(CLAUDE_PLAN_METHODS as readonly string[]).includes(claude.method)) {
    return "unknown_method";
  }
  return "ready";
}

// The version comes first: an OpenClaw too old for the sign-in (or whose version can't be read) offers no Sign in at
// all, which is what the server's sign-in route says too. A sign-in Agent OS could not read counts as signed out.
export function chatgptPlanState(plans: OpenclawPlansInfo): ChatgptPlanState {
  if (plans.version.newEnough === null) return "version_unknown";
  if (plans.version.newEnough === false) return "too_old";
  if (plans.chatgpt.signedIn !== true) return "signed_out";
  if (plans.chatgpt.sharing === false) return "no_sharing";
  return "ready";
}

// A typed model name, checked as the server checks it: the plan's own provider prefix may be typed, and what is left
// must match TYPED_MODEL_RE (spec section 5). null when it is fine.
export const TYPED_MODEL_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
export function typedModelProblem(text: string, plan: OpenclawPlan): string | null {
  const trimmed = text.trim();
  const prefix = `${PLAN_PROVIDER[plan]}/`;
  const rest = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  return TYPED_MODEL_RE.test(rest) ? null : INVALID_PLAN_MODEL;
}

// What the person picked in one plan's list: a listed model, the "Type a model name" row (only on the fallback
// list), or nothing yet.
export type PlanSelection = { kind: "listed"; id: string } | { kind: "typed" } | null;

// The model Apply would send (null keeps Apply off), and the sentence for a typed name in the wrong shape. A typed
// name is sent trimmed and as typed; the server strips the plan's prefix itself.
export function planApplyModel(
  list: PlanModelList | null,
  selection: PlanSelection,
  typed: string,
  plan: OpenclawPlan
): { model: string | null; problem: string | null } {
  if (!list || !selection) return { model: null, problem: null };
  if (selection.kind === "listed") {
    const row = list.models.find((entry) => entry.id === selection.id);
    return { model: row && row.available ? row.id : null, problem: null };
  }
  if (list.source !== "fallback") return { model: null, problem: null };
  const text = typed.trim();
  if (!text) return { model: null, problem: null };
  const problem = typedModelProblem(text, plan);
  return problem ? { model: null, problem } : { model: text, problem: null };
}

// The sentence after "Choose in Hermes", from the launch answer (spec section 4).
export function hermesLaunchWords(launch: TerminalLaunch): string {
  if (launch.opened) return HERMES_TERMINAL_WORDS.opened;
  return launch.reason === "spawn_failed" ? HERMES_TERMINAL_WORDS.spawn_failed : HERMES_TERMINAL_WORDS.copy;
}

// The sentence after "Add a sign-in in Hermes", from its launch answer.
export function hermesAuthLaunchWords(launch: TerminalLaunch): string {
  if (launch.opened) return HERMES_AUTH_TERMINAL_WORDS.opened;
  return launch.reason === "spawn_failed" ? HERMES_AUTH_TERMINAL_WORDS.spawn_failed : HERMES_AUTH_TERMINAL_WORDS.copy;
}

// What stays on Hermes's card after the request of button `which` failed. The other button's earlier "run this command
// yourself" answer goes (else its command would be the only one on screen under this button's error); an answer that did
// open a window says nothing wrong and stays, and so does this button's own.
export function launchAfterFailure<T extends { which: string; answer: { opened: boolean } }>(previous: T | null, which: string): T | null {
  return previous && previous.which !== which && !previous.answer.opened ? null : previous;
}

// The sentence the server wrote for a refusal (ApiError.detail), or null. Told apart by name, like gotNoAnswer, so
// this file needs no runtime import.
export function serverSentence(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "ApiError") return null;
  const detail = (error as Error & { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim() ? detail : null;
}

// Words for a failed plan request: the server's own sentence first (so invalid_model_id never gets friendlyError's
// OpenRouter sentence), then an answer that could not be read, then no answer at all, then `friendly` (the caller
// passes friendlyError) for a refusal that carried no sentence.
export function planProblem(error: unknown, friendly: (error: unknown) => string): string {
  const sentence = serverSentence(error);
  if (sentence) return sentence;
  if (error instanceof SyntaxError || (error instanceof Error && error.message === UNREADABLE_WORDS)) return UNREADABLE_WORDS;
  if (!(error instanceof Error && error.name === "ApiError")) {
    return error instanceof Error && error.message === TIMEOUT_WORDS ? TIMEOUT_WORDS : NO_ANSWER_WORDS;
  }
  return friendly(error);
}

// ---- what the card does next (the pure parts of BrainPlanCard and PlanSignInTerminal) ---------------------------

// A Sign in that was refused with 409 setup_running (a sign-in is already starting or open, maybe in another window),
// or that got no answer at all (it timed out: the server may have started it all the same), looks for the running
// sign-in for up to SETUP_RUNNING_WAIT_MS, asked every SETUP_RUNNING_POLL_MS, and attaches to it if one appears.
// Any other refusal carries its own sentence and there is nothing to find: null. Told apart by name, like
// gotNoAnswer, so this file needs no runtime import.
export function signInLookupWait(error: unknown): number | null {
  if (!(error instanceof Error && error.name === "ApiError")) return SETUP_RUNNING_WAIT_MS;
  return error.message === "setup_running" ? SETUP_RUNNING_WAIT_MS : null;
}

type SeenSession = Pick<SessionSummary, "id" | "status"> | null | undefined;

// After Close, the card has closed the panel and read the plans, and asks GET /api/setup/openclaw/signin-terminal for
// the live sign-in. What it does with the answer (Task B1a carry-forward):
//   the session just closed          never shown again (its stop may still be finishing); when Close's stop answered
//                                    404 (`gone`), a sign-in still before its spawn answers that too, so it is stopped;
//   a different session              another window's sign-in: left running and shown here, never stopped;
//   nothing live, or an ended one    nothing to do.
export function signInAfterClose(closedId: string, gone: boolean, found: SeenSession): { stop: string | null; show: string | null } {
  if (!found || typeof found.id !== "string" || !found.id || found.status === "exited") return { stop: null, show: null };
  if (found.id === closedId) return { stop: gone ? found.id : null, show: null };
  return { stop: null, show: found.id };
}

// A terminal that has never been open and fails its first try asks its session at once, instead of waiting for the next
// 5 s tick: a sign-in that ends before any window attaches leaves no trace, so the first attach is refused.
export function asksSessionAtOnce(connection: string, everOpened: boolean): boolean {
  return !everOpened && (connection === "reconnecting" || connection === "lost");
}

// The session's answer says the sign-in is over: it is exited, or the question got a 404 (`gone`), which is how a
// setup session answers once it ended.
export function signInSessionEnded(summary: { status?: string } | null | undefined, gone: boolean): boolean {
  return gone || summary?.status === "exited";
}

// An answer about the plan job (the poll's, or Cancel's). Once a job reached a final state on this card, no later
// answer about it counts, so the card handles the job's end once: "ignore", "running" (show it), "final" (show it, once).
export function takeJobAnswer(finalJobId: string | null, next: { id: string; status: string }): "ignore" | "running" | "final" {
  if (next.id === finalJobId) return "ignore";
  return next.status === "running" ? "running" : "final";
}

// A ChatGPT plan job that stopped at its sign-in check: the failed result then offers "Sign in again" right there,
// instead of making the person go back first. It is that one failure and nothing else: another plan, another failed
// step, a job that is still running, was cancelled or succeeded, or no job at all, offers nothing. The failed step is
// the first one, the same one BrainResult shows the error of. The step's id alone is not enough: Agent OS quitting
// during that same step fails it too, with a sentence that says to apply the plan again, so the step's own sentence
// must be the "can't use your ChatGPT plan yet, sign in again" one (the server's CHATGPT_NOT_READY).
export function offersSignInAgain(
  job: { plan?: string; status?: string; steps?: ReadonlyArray<{ id: string; status: string; error?: string | null }> } | null | undefined
): boolean {
  if (!job || job.plan !== "chatgpt" || job.status !== "failed" || !Array.isArray(job.steps)) return false;
  const failed = job.steps.find((step) => step.status === "failed");
  return failed?.id === "openclaw-plan-readiness" && failed.error === CHATGPT_PLAN_WORDS.not_ready;
}
