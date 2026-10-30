// Hand-off (spec "SP4 Session extras", Hand-off; Task X8): Agent OS types a short note into a session of the other
// agent and never presses Enter. "Send to Codex for review" in a Claude Code session and "Send to Claude Code" in a
// Codex session hand the list of files this session changed to a session of the other agent in the same folder (or
// the same separate copy). Task X10 reuses cleanTypedText and deliverTyped for the typed summaries of Codex keep
// going and Cursor's hand-over.
//
// Write rules (spec, Hand-off; the manager enforces them in typeInto, the only place that writes the text):
// - only when the target's mirror shows DECSET ?2004 (bracketed paste) on, and the target is not waiting or in an
//   approval;
// - an open target that fails either rule is not used: a new session of that agent opens instead, and the text is
//   written once it shows ?2004; if that never happens within HANDOFF_WAIT_MS, the text is shown with a Copy button;
// - the body has every C0 and C1 control character, ESC and DEL removed except "\n", is cut to 32 KB, is wrapped in
//   the paste markers, and is never followed by Enter;
// - a hand-off write is never user input (spec, Session activity states).
// The text lives in memory only (the target's `handoff`), never in meta.json, a log or a recording.
import { builderErrorResponse } from "../builders/resolve.js";
import { sessionError } from "./errors.js";

export const TYPED_MAX_BYTES = 32 * 1024;
export const HANDOFF_WAIT_MS = 60 * 1000;
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

// Every C0 control except "\n" (0x0A), DEL, and every C1 control. ESC (0x1B) is a C0 control, so it goes too. A file
// name in the note can also carry characters that reorder or hide text, so these go with the controls (orchestrator's
// ruling on X8): the arabic letter mark (U+061C), the zero-width and direction marks (U+200B-200F), the embedding,
// override and isolate marks (U+202A-202E, U+2066-2069) and the byte-order mark (U+FEFF).
const TYPED_CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
// The controls with "\n" too, so a file name stays on its one line of the note.
const LINE_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
// Claude Code sends to Codex, and Codex to Claude Code (spec: "a session of the other agent").
const OTHER_AGENT = Object.freeze({ claude: "codex", codex: "claude" });
// Exported because Task X10's keep-going.js answers a wrong target with the same sentence.
export const INVALID_TARGET_MESSAGE = "Agent OS can hand this only to Claude Code or Codex.";

// The longest start of `text` that fits in `maxBytes` of UTF-8, never splitting a character.
function cutUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

// The body rule: controls go first, then the cut, so removed controls use none of the 32 KB.
export function cleanTypedText(text) {
  return cutUtf8(String(text ?? "").replace(TYPED_CONTROLS, ""), TYPED_MAX_BYTES);
}

// What typeInto writes: the cleaned text between the paste markers, and nothing after the end marker (no Enter).
export function pasteBody(text) {
  return `${PASTE_START}${cleanTypedText(text)}${PASTE_END}`;
}

function lineCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function fileLine(file) {
  const name = file.path.replace(LINE_CONTROLS, "?");
  if (file.added == null && file.removed == null) return `- ${name}`;
  return `- ${name} (+${lineCount(file.added)} −${lineCount(file.removed)})`;
}

// The note: one line per changed file (Task X7's list, at most 200), or the shorter note when none is listed.
export function buildReviewNote({ fromLabel, files = [] } = {}) {
  const agent = String(fromLabel ?? "");
  const listed = Array.isArray(files) ? files.filter((file) => file && typeof file.path === "string" && file.path !== "") : [];
  if (!listed.length) return `Please review the latest changes ${agent} made in this folder.`;
  return [`Please review the changes ${agent} made in this folder:`, ...listed.map(fileLine)].join("\n");
}

// K13: a session of `agentId` in exactly this real folder (a separate copy is its own folder, so a worktree session
// matches only that worktree). The list is in the order the sessions started, so the last match is the newest.
export function findHandoffTarget(sessions, { agentId, folder } = {}) {
  if (!Array.isArray(sessions) || typeof folder !== "string" || folder === "") return null;
  let newest = null;
  for (const session of sessions) {
    if (!session || session.agentId !== agentId || session.status === "exited" || session.folder !== folder) continue;
    newest = session;
  }
  return newest;
}

// A refusal with a sentence of its own (a sessionError, or a brain error the routes would answer with its own
// status): its message becomes the reason under the Copy button. null for anything else, which is thrown.
function refusalMessage(error) {
  const sentence = typeof error?.message === "string" && error.message ? error.message : null;
  if (!sentence) return null;
  if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 && typeof error.code === "string") return sentence;
  return builderErrorResponse(error) ? sentence : null;
}

// The new-session half of the write rules: the target shows "pending" at once, then "typed" (typeInto records it)
// or "copy" when it never got ready within `waitMs`, or the rules refused at the last moment.
export async function deliverTyped(manager, targetId, text, { fromId = null, waitMs = HANDOFF_WAIT_MS } = {}) {
  const clean = cleanTypedText(text);
  manager.setHandoff(targetId, { state: "pending", text: clean, fromId });
  let ready = false;
  try {
    ready = await manager.whenReadyForTyping(targetId, waitMs);
  } catch {
    ready = false;
  }
  if (ready && manager.typeInto(targetId, clean, { fromId }).ok) return "typed";
  manager.setHandoff(targetId, { state: "copy", text: clean, fromId });
  return "copy";
}

// POST /api/sessions/:id/send. "typed": an open target passed the rules and was written. "opening": a new session
// started and is typed into once ready (its own `handoff` shows the end state). "copy": the new session could not
// start, and `reason` is that refusal's own sentence.
export async function sendTo(manager, fromId, to) {
  if (to !== "claude" && to !== "codex") throw sessionError(400, "invalid_target", INVALID_TARGET_MESSAGE);
  const from = await manager.get(fromId);
  if (from.kind !== "agent" || OTHER_AGENT[from.agentId] !== to) throw sessionError(400, "invalid_target", INVALID_TARGET_MESSAGE);
  let files = [];
  try {
    const changes = await manager.changes(fromId);
    if (changes?.git === true && Array.isArray(changes.files)) files = changes.files;
  } catch {
    // The note without a list is still true ("the latest changes").
    files = [];
  }
  const text = cleanTypedText(buildReviewNote({ fromLabel: from.agentLabel, files }));
  const target = findHandoffTarget(manager.liveAgentSessions(to), { agentId: to, folder: from.folder });
  if (target) {
    // A session already waiting for its text (a Send a moment ago, maybe from another window) gets nothing more.
    const current = await manager.get(target.id).catch(() => null);
    if (current?.handoff?.state === "pending") {
      return { result: "opening", targetId: target.id, text: current.handoff.text, reason: null };
    }
    // The target still holds this very note, unsent: the person has typed nothing in that session since (its summary's
    // `handoff` is null again after any input of theirs). Typing it again would put a second copy right after the
    // first in the input line, so nothing is written, and the answer is the same as the first time.
    if (current?.handoff?.state === "typed" && current.handoff.text === text) {
      return { result: "typed", targetId: target.id, text, reason: null };
    }
    if (manager.readyForTyping(target.id) && manager.typeInto(target.id, text, { fromId }).ok) {
      return { result: "typed", targetId: target.id, text, reason: null };
    }
  }
  // One start at a time for each agent and folder: a second Send (another click, another window, another session in
  // the same folder) that comes while the first new session is still starting waits for that start and gets its answer,
  // so two Sends never open two sessions. The entry goes as soon as the start has answered: from then on the new
  // session is in the live list, and its own `handoff` (pending, then typed or copy) tells later Sends what to do.
  const starts = startsOf(manager);
  const key = `${to}:${from.folder}`;
  const running = starts.get(key);
  if (running) return { ...(await running) };
  const start = startAndDeliver(manager, { to, folder: from.folder, text, fromId });
  starts.set(key, start);
  try {
    return { ...(await start) };
  } finally {
    if (starts.get(key) === start) starts.delete(key);
  }
}

// The starts in flight, for each manager: "<agent>:<folder>" -> the promise of the answer.
const startsByManager = new WeakMap();

function startsOf(manager) {
  let starts = startsByManager.get(manager);
  if (!starts) {
    starts = new Map();
    startsByManager.set(manager, starts);
  }
  return starts;
}

// Opens a session of `to` in `folder` and hands the text to it once it is ready. The answer is "opening", or "copy"
// with the refusal's own sentence when the session can't start; any other failure is thrown.
async function startAndDeliver(manager, { to, folder, text, fromId }) {
  let opened;
  try {
    opened = await manager.create({ agentId: to, folder });
  } catch (error) {
    const reason = refusalMessage(error);
    if (reason === null) throw error;
    return { result: "copy", targetId: null, text, reason };
  }
  // Runs on after the answer; deliverTyped never throws (it ends in "typed" or "copy"). It sets the new session's
  // `handoff` to pending before it first waits, so that is in place when this start is finished.
  deliverTyped(manager, opened.id, text, { fromId }).catch(() => {});
  return { result: "opening", targetId: opened.id, text, reason: null };
}
