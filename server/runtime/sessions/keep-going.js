// "Plan ran out, keep going" for sessions (spec "SP4 Session extras", Plan
// ran out, keep going; rulings R24 and R26; contract choice K15). It is shown
// only for a held session (a limit confirmed under "Limit rule per agent"),
// and nothing here runs before the person pressed the button and confirmed
// in the page.
//
//   Claude Code  stop the held session, then `claude --resume <uuid>` on the
//                OpenRouter brain in the same tab: the same conversation, on
//                an Anthropic model only (continue.js's rule). The key reaches
//                Claude only through the existing apiKeyHelper settings (the
//                Keychain helper), never its environment or command line.
//   Codex        a NEW Codex session on the OpenRouter brain in the same
//                folder (codexBrainArgs, through the profile), with a summary
//                of the held session's last screen typed into it under the
//                hand-off write rules and never sent. The held session stays
//                open; the person stops it.
//   Cursor       no limit signal, so no banner: "Hand to Claude Code or
//                Codex" types the same kind of summary into an open session of
//                that agent in the folder that can take typed text, or into a
//                new one there.
//
// The options and their estimates are continue.js's own. No route takes a
// brain or a model from the page: the model comes from those options (the
// saved OpenRouter model, else Claude's default), and only this file passes
// `brainOverride` to the manager (R26). Nothing here writes into a terminal:
// typed text goes through handoff.js (deliverTyped, then manager.typeInto).
import { loadBrains } from "../builders/brains.js";
import { claudeOpenRouterOption, codexOpenRouterOption } from "../builders/continue.js";
import { resolveBrainForRun } from "../builders/resolve.js";
import { isExecutionEnabled } from "../execution-gate.js";
import { openRouterKeyHelper } from "../secrets/keystore.js";
import { sessionError } from "./errors.js";
import { INVALID_TARGET_MESSAGE, cleanTypedText, deliverTyped, handTyped } from "./handoff.js";
import { BUSY_MESSAGE, LOOK_ONLY_MESSAGE } from "./manager.js";
import { CLAUDE_SCREEN_LIMIT, CODEX_SCREEN_LIMIT } from "./mirror-signals.js";

export const SUMMARY_MAX_LINES = 60;
export const SUMMARY_LINE_MAX = 500;
export const NOT_HELD_MESSAGE = "Keep going is offered only when the plan ran out.";
export const NOT_ON_PLAN_MESSAGE = "This session isn't using your plan, so there's no plan limit to get past.";
export const HAND_OVER_NOT_AVAILABLE_MESSAGE = "Only a Cursor session is handed over this way.";
export const HAND_OVER_ENDED_MESSAGE = "This Cursor session has ended, so there is no screen to hand over.";
// NEW SENTENCE (Q32): nothing on the screen to put in a summary (fix round 1, M6). 409 empty_screen.
export const EMPTY_SCREEN_MESSAGE = "There is nothing on this screen to summarize yet.";
// profiles.js's own words for a Claude Code session with no conversation id.
const NO_CONVERSATION_MESSAGE = "This Claude Code conversation can't be resumed.";
// continue.js's own words, for an option that is unavailable without saying why.
const UNAVAILABLE_MESSAGE = "That way of continuing isn't available.";
const KEEP_GOING_AGENTS = new Set(["claude", "codex"]);

// What keep going asks outside the session manager. Tests pass their own.
export const KEEP_GOING_DEFAULTS = Object.freeze({
  loadBrains,
  keyHelper: openRouterKeyHelper,
  claudeOption: claudeOpenRouterOption,
  codexOption: codexOpenRouterOption,
  isExecutionAllowed: isExecutionEnabled,
  resolveBrain: (agentId, override) => resolveBrainForRun(agentId, override, { prepare: true }),
  deliverTyped
});

// Sessions being kept going or handed over right now, so a double press or a
// second window never stops and resumes twice or opens two sessions.
const changing = new Set();

function withDefaults(deps) {
  return { ...KEEP_GOING_DEFAULTS, ...(deps && typeof deps === "object" ? deps : {}) };
}

function isBlank(line) {
  return line.trim() === "";
}

// The words the page would show for a failed request: a sessionError's own message (the route answers it as it is). Anything
// else is an internal error the route answers with a fixed sentence and logs, so nothing is kept for it.
function sessionSentence(error) {
  return Number.isInteger(error?.status) && typeof error?.code === "string" && typeof error?.message === "string" ? error.message : null;
}

// ---- the typed summary (R24) ------------------------------------------------------------------------

export function summaryHeader(agentLabel, folder) {
  return `Picking up from ${agentLabel}. Folder: ${folder}. Its last screen:`;
}

// The header, then the last SUMMARY_MAX_LINES lines of the screen without the
// blank rows around them, each cut to SUMMARY_LINE_MAX characters, through the
// hand-off clean-up (no control character but "\n", at most 32 KB). A line
// with a plan limit sentence is left out: typed into the new session's input
// it would sit on that screen, and X1b's screen rules would make the fresh
// session look held.
export function buildTypedSummary({ agentLabel, folder, screenText }) {
  return cleanTypedText([summaryHeader(agentLabel, folder), ...summaryBody(screenText)].join("\n"));
}

// The lines under the header (see buildTypedSummary).
function summaryBody(screenText) {
  const lines = String(screenText ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !CLAUDE_SCREEN_LIMIT.test(line) && !CODEX_SCREEN_LIMIT.test(line)); // SCREEN READING (spec SP4)
  while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  const tail = lines.slice(-SUMMARY_MAX_LINES);
  while (tail.length && isBlank(tail[0])) tail.shift();
  return tail.map((line) => Array.from(line).slice(0, SUMMARY_LINE_MAX).join(""));
}

// The session's screen as the typed summary, read now, and whether it has anything under the header (fix round 1,
// M6): a summary of nothing is never typed or offered.
function summaryFor(manager, summary) {
  const screen = manager.screenText(summary.id); // SCREEN READING (spec SP4)
  const text = buildTypedSummary({ agentLabel: summary.agentLabel, folder: summary.folder, screenText: screen });
  return { text, empty: cleanTypedText(summaryBody(screen).join("\n")).trim() === "" };
}

// Types `text` into a session that is still starting, once it can take typed
// text (deliverTyped records "typed" or "copy" on that session for the page).
// A failure must never reach the process.
function typeLater(use, manager, targetId, text, fromId) {
  Promise.resolve()
    .then(() => use.deliverTyped(manager, targetId, text, { fromId }))
    .catch(() => {});
}

// ---- what keeping going would do and cost -----------------------------------------------------------

// The held Claude Code or Codex agent session, or 409 not_held. An unknown id
// is get()'s own 404.
async function heldSession(manager, id) {
  const summary = await manager.get(id);
  const live = manager.liveAgentSessions(summary.agentId).find((entry) => entry.id === id) || null;
  if (summary.kind !== "agent" || !KEEP_GOING_AGENTS.has(summary.agentId) || summary.status !== "held" || !live) {
    throw sessionError(409, "not_held", NOT_HELD_MESSAGE);
  }
  return { summary, live };
}

// KeepGoingInfo (the contract's shape, exactly these keys) from a continue.js option.
function infoFrom(agentId, approach, option, reason, hasKey) {
  return {
    agentId,
    approach,
    available: reason === null,
    reason,
    model: typeof option.brain?.model === "string" ? option.brain.model : null,
    estimateUsd: typeof option.estimateUsd === "number" ? option.estimateUsd : null,
    estimateTokens: typeof option.estimateTokens === "number" ? option.estimateTokens : null,
    estimateNote: typeof option.estimateNote === "string" ? option.estimateNote : "",
    warnings: Array.isArray(option.warnings) ? option.warnings.filter((warning) => typeof warning === "string") : [],
    needsKey: !hasKey
  };
}

async function plan(manager, id, use) {
  const { summary, live } = await heldSession(manager, id);
  const [config, helper] = await Promise.all([use.loadBrains(), use.keyHelper()]);
  const hasKey = Boolean(helper);
  const onPlan = (summary.brain?.kind ?? "plan") === "plan";
  if (summary.agentId === "claude") {
    // continue.js's "fork" is a resume of the conversation by its id; a
    // session has one from its start (--session-id).
    const option = await use.claudeOption({
      run: { agentId: "claude", sessionId: live.agentSessionId, usage: { lastInputTokens: summary.meter?.contextTokens ?? null } },
      config,
      handoffTokens: null,
      hasKey
    });
    const reason = !onPlan
      ? NOT_ON_PLAN_MESSAGE
      : !option.available
        ? option.reason || UNAVAILABLE_MESSAGE
        : option.approach !== "fork"
          ? NO_CONVERSATION_MESSAGE
          : null;
    return { summary, live, info: infoFrom("claude", "resume", option, reason, hasKey) };
  }
  const option = await use.codexOption({
    run: { agentId: "codex" },
    config,
    handoffTokens: Math.ceil(summaryFor(manager, summary).text.length / 4),
    hasKey
  });
  const reason = !onPlan ? NOT_ON_PLAN_MESSAGE : !option.available ? option.reason || UNAVAILABLE_MESSAGE : null;
  return { summary, live, info: infoFrom("codex", "new", option, reason, hasKey) };
}

// Asked again right before the stop or the new session: still held, and still the same Claude Code or Codex process.
async function stillHeld(manager, id, before) {
  const { live } = await heldSession(manager, id);
  if (live.agentSessionId !== before.agentSessionId || live.pid !== before.pid) throw sessionError(409, "not_held", NOT_HELD_MESSAGE);
}

// The new Codex session each hold opened ("<session id>:<hold start>" -> its id), for the second press of that hold.
const openedByHold = new Map();
const OPENED_MEMORY = 100;

function rememberOpened(hold, targetId) {
  openedByHold.delete(hold);
  openedByHold.set(hold, targetId);
  while (openedByHold.size > OPENED_MEMORY) openedByHold.delete(openedByHold.keys().next().value);
}

// The session this hold opened earlier, when it is still running; forgotten otherwise.
async function openedSession(manager, hold) {
  const targetId = openedByHold.get(hold);
  if (!targetId) return null;
  const found = await manager.get(targetId).catch(() => null);
  if (found && found.status !== "exited") return targetId;
  openedByHold.delete(hold);
  return null;
}

// GET /api/sessions/:id/keep-going. Asking stops, starts and types nothing.
export async function keepGoingInfo(manager, id, deps) {
  return (await plan(manager, id, withDefaults(deps))).info;
}

// POST /api/sessions/:id/keep-going, after the person confirmed.
export async function keepGoing(manager, id, deps) {
  const use = withDefaults(deps);
  if (changing.has(id)) throw sessionError(409, "session_busy", BUSY_MESSAGE);
  changing.add(id);
  try {
    const { summary, live, info } = await plan(manager, id, use);
    if (!info.available) throw sessionError(409, "keep_going_unavailable", info.reason);
    const brainOverride = { mode: "openrouter", model: info.model };
    if (info.agentId === "claude") {
      // Everything that can refuse is asked BEFORE the stop, so a refusal
      // never leaves the person's conversation stopped.
      if (!(await use.isExecutionAllowed())) throw sessionError(409, "execution_gate_off", LOOK_ONLY_MESSAGE);
      await use.resolveBrain("claude", brainOverride);
      // The price lookup and the brain check took time: if the plan came back and Claude Code carried on (or another
      // window stopped it) in the meantime, nothing is stopped (fix round 1, M1).
      await stillHeld(manager, id, live);
      manager.setKeepGoingFailure?.(id, null);
      await manager.stop(id, { by: "stop" });
      try {
        await manager.resume(id, { brainOverride });
      } catch (error) {
        // The conversation is stopped now and could not be resumed: its own sentence stays with the ended session
        // (memory only), so the person still reads why when they were not looking at this session as it failed (I1).
        manager.setKeepGoingFailure?.(id, sessionSentence(error));
        throw error;
      }
      return { result: "resumed", targetId: id };
    }
    // Codex: the held session is left as it is (K15). create() asks Look only itself. A hold that already opened its
    // new session opens no second one (fix round 1, M5: each one is pay per use): the answer points to the first.
    const hold = `${id}:${summary.stateSince ?? ""}`;
    const earlier = await openedSession(manager, hold);
    if (earlier) return { result: "opening", targetId: earlier };
    const { text, empty } = summaryFor(manager, summary);
    if (empty) throw sessionError(409, "empty_screen", EMPTY_SCREEN_MESSAGE);
    await stillHeld(manager, id, live);
    const created = await manager.create({ agentId: "codex", folder: summary.folder, brainOverride });
    rememberOpened(hold, created.id);
    typeLater(use, manager, created.id, text, id);
    return { result: "opening", targetId: created.id };
  } finally {
    changing.delete(id);
  }
}

// ---- Cursor's hand-over -----------------------------------------------------------------------------

// POST /api/sessions/:id/hand-over, after the person confirmed. An open
// session of that agent in the same folder that can take typed text right now
// gets the summary at once; otherwise (none, or one that fails the write
// rules) a new session opens there on that agent's saved brain, and the
// summary is typed once it can take it. All of that is handoff.js's own
// handTyped, so the hand-over and Send share their guards. `_deps` is kept so
// the route can pass the same deps to all three calls; nothing here asks any.
export async function handOver(manager, id, to, _deps) {
  const summary = await manager.get(id);
  if (summary.kind !== "agent" || summary.agentId !== "cursor") {
    throw sessionError(400, "hand_over_not_available", HAND_OVER_NOT_AVAILABLE_MESSAGE);
  }
  if (to !== "claude" && to !== "codex") throw sessionError(400, "invalid_target", INVALID_TARGET_MESSAGE);
  if (summary.status === "exited") throw sessionError(409, "not_live", HAND_OVER_ENDED_MESSAGE);
  if (changing.has(id)) throw sessionError(409, "session_busy", BUSY_MESSAGE);
  changing.add(id);
  try {
    const { text, empty } = summaryFor(manager, summary);
    if (empty) throw sessionError(409, "empty_screen", EMPTY_SCREEN_MESSAGE);
    // X8's own delivery (handoff.js handTyped), so the hand-over has the same guards as Send: an open target of that
    // agent in this folder that can take typed text gets the summary unless it still holds this very one; a target
    // waiting for its text gets nothing more; otherwise one new session starts at a time per agent and folder on that
    // agent's saved brain (no override), and a start that is refused answers "copy" with the refusal's sentence.
    return await handTyped(manager, { fromId: id, to, folder: summary.folder, text });
  } finally {
    changing.delete(id);
  }
}
