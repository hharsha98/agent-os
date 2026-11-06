// Claude Code's hook endpoints (spec SP4 "Hook endpoints" and "Hook events are
// hints", harness rule H5; rulings R1-R8 and R27; contract choice K6).
//
//   POST /hooks/sessions/:id          one hook event (PermissionRequest, Stop, ...)
//   POST /hooks/sessions/:id/status   the statusLine JSON the wrapper forwards (Task X2b)
//
// Claude Code calls these, not a browser, so they sit outside the
// cookie-gated /api/ prefix: server/index.js mounts this router right after
// the Host allowlist, the Origin check and the security headers, and before
// the 2 MB JSON parser. In order:
//   1. outside local mode every /hooks address answers 403 (spec Security 1);
//   2. an id that is not a live Claude Code agent run with a hook answers 404;
//   3. "Authorization: Bearer <that run's own hook token>", or 401 (the
//      manager compares it timing-safe; another session's token is a bad one);
//   4. the body is read here, never by express.json: up to 256 KB it is kept,
//      past that it is thrown away as it arrives (R5);
//   5. the answer is 204 with an empty body, sent as soon as the upload has
//      ended and before any work (H5). Claude reads a 2xx with an empty body
//      as "no decision"; any other answer would print "hook error" in the
//      person's transcript, so even a dropped body gets its 204;
//   6. the event is processed on setImmediate, after the token is checked
//      again (the run may have ended and been resumed with a new token while
//      the body was arriving, M1); broken JSON is dropped.
// A refusal (401, 403, 404) reads at most 256 KB of the body, answers with
// "Connection: close" and then closes the socket, so a process without a
// token cannot keep the server reading an endless upload (M2). Only the
// good-token 204 reads to the end.
// Every answer has an empty body and "Cache-Control: no-store", and nothing
// here ever writes a log line (R27). The token sits in the agent's
// environment, so everything an event says is only a hint.
import express from "express";
import { isLocalMode } from "../local-session.js";
import { isSessionId } from "./errors.js";
import { cleanAlertText } from "./signals.js";

export const HOOK_BODY_LIMIT = 256 * 1024;
// K6: Claude sends its backup Notification about 6 s after a permission
// prompt, so it can land just after the person answered. The manager drops it
// when input reached the session this recently, or when it already waits.
export const BACKUP_WAITING_QUIET_MS = 3000;

// A tool or server name in an alert is cut to this many characters.
const NAME_MAX = 60;
// The spec's own words for a session that waits, when an event names nothing.
const WAITING_TEXT = "Waiting for you";
// R2: Claude's observe-only backup for a prompt it shows.
const BACKUP_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]);
// R3: the StopFailure errors that are also a limit hint.
const LIMIT_ERRORS = new Set(["rate_limit", "billing_error"]);

// The token after "Bearer " (any case of the word, exactly one space), or null.
export function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer (\S+)$/i.exec(header);
  return match ? match[1] : null;
}

function nameText(value, sentence) {
  const name = typeof value === "string" ? cleanAlertText(value, NAME_MAX) : "";
  return name ? sentence(name) : WAITING_TEXT;
}

function permissionText(toolName) {
  if (toolName === "AskUserQuestion") return "Has a question for you";
  if (toolName === "ExitPlanMode") return "Has a plan for you to approve";
  return nameText(toolName, (name) => `Wants to use ${name}`);
}

// One hook body → the MappedHook the manager acts on (contract table). It
// copies only the names it needs: never a prompt (R23), a tool's input or a
// written file's content.
export function mapHookEvent(body) {
  const input = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  // M3: a version 4 UUID only, the rule Resume uses (Claude's own ids come from randomUUID).
  const lowered = typeof input.session_id === "string" ? input.session_id.toLowerCase() : "";
  const claudeSessionId = isSessionId(lowered) ? lowered : null;
  const mapped = {
    event,
    claudeSessionId,
    signals: [],
    limit: null,
    newTurn: false,
    promptMarker: false,
    refreshChanges: false,
    heldCleared: false,
    relinkHint: false
  };
  switch (event) {
    case "PermissionRequest":
      mapped.signals.push({ kind: "waiting", text: permissionText(input.tool_name), backup: false });
      break;
    case "Elicitation":
      mapped.signals.push({ kind: "waiting", text: nameText(input.mcp_server_name, (name) => `${name} asks for input`), backup: false });
      break;
    case "Notification":
      if (BACKUP_NOTIFICATIONS.has(input.notification_type)) {
        const message = typeof input.message === "string" ? cleanAlertText(input.message) : "";
        mapped.signals.push({ kind: "waiting", text: message || WAITING_TEXT, backup: true });
      } else if (input.notification_type === "quota_auto_resume_fired") {
        mapped.heldCleared = true; // R4: Claude's own auto-continue started work again
      }
      break;
    case "Stop":
      mapped.signals.push({ kind: "turn_done", text: "", backup: false });
      break;
    case "StopFailure":
      // R3: every API error ends the turn (Stop never fires for one).
      mapped.signals.push({ kind: "turn_done", text: "", backup: false });
      if (LIMIT_ERRORS.has(input.error)) mapped.limit = { text: input.error };
      break;
    case "UserPromptSubmit":
      mapped.newTurn = true;
      mapped.promptMarker = true;
      break;
    case "PostToolUse":
      mapped.newTurn = true;
      mapped.refreshChanges = true;
      break;
    case "SessionEnd":
      mapped.relinkHint = input.reason === "clear" || input.reason === "resume";
      break;
    default:
      break;
  }
  return mapped;
}

// A refusal (401, 403, 404): an empty body and "Connection: close". A body up
// to HOOK_BODY_LIMIT is read to the end and thrown away before the answer, so
// a client that is still sending gets its answer, not a reset (ruling X2a #1;
// Node closes a "Connection: close" socket as soon as the answer is written).
// A bigger body is not read to the end (M2): a declared length over the limit
// is answered at once, and an upload that passes the limit while it arrives is
// answered then; either way the request is destroyed once the answer has been
// written, so a process without a token cannot keep the server reading an
// endless upload. Only the good-token 204 (receiveBody) reads to the end.
function refuse(req, res, status) {
  const send = (thenDestroy) => {
    if (res.headersSent) return;
    if (thenDestroy) res.once("finish", () => req.destroy());
    res.set("Connection", "close").status(status).end();
  };
  req.on("error", () => {});
  if (req.readableEnded) {
    send(false);
    return;
  }
  const declared = Number(req.get("content-length"));
  if (Number.isFinite(declared) && declared > HOOK_BODY_LIMIT) {
    send(true);
    return;
  }
  let drained = 0;
  req.on("data", (chunk) => {
    drained += chunk.length;
    if (drained > HOOK_BODY_LIMIT) send(true);
  });
  req.on("end", () => send(false));
  req.resume();
}

// The body of a request whose token was good. Up to HOOK_BODY_LIMIT bytes are
// kept, the 204 is written when the upload ends, and onKept(raw) runs after
// it. Past the limit nothing is kept and nothing runs, and the 204 closes the
// connection (R5).
function receiveBody(req, res, onKept) {
  const declared = Number(req.get("content-length"));
  let over = Number.isFinite(declared) && declared > HOOK_BODY_LIMIT;
  let chunks = over ? null : [];
  let size = 0;
  req.on("error", () => {
    chunks = null;
  });
  req.on("data", (chunk) => {
    if (over) return;
    size += chunk.length;
    if (size > HOOK_BODY_LIMIT) {
      over = true;
      chunks = null;
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.headersSent) return;
    if (over || !chunks) {
      res.set("Connection", "close").status(204).end();
      return;
    }
    res.status(204).end();
    const raw = Buffer.concat(chunks, size);
    chunks = null;
    onKept(raw);
  });
}

// The router server/index.js mounts at /hooks. `isLocal` is read on every
// request (tests pass their own).
export function createHooksRouter({ manager, isLocal = isLocalMode } = {}) {
  if (!manager || typeof manager.checkHookToken !== "function" || typeof manager.onHook !== "function") {
    throw new TypeError("createHooksRouter needs the session manager (checkHookToken and onHook)");
  }

  // Runs on setImmediate, after the 204 was written. Nothing in here can
  // reach Claude any more, and nothing is logged (R27). M1: the token is
  // checked again with the one the post presented. The answer was decided when
  // the headers arrived, but the run may have ended and been resumed with a
  // new token while a slow body was still coming in, and a "dead" token must
  // not reach the next run.
  function deliver(kind, id, presented, raw) {
    let verdict = "unknown_session";
    try {
      verdict = manager.checkHookToken(id, presented);
    } catch {
      verdict = "unknown_session";
    }
    if (verdict !== "ok") return;
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return;
    try {
      if (kind === "status") {
        if (typeof manager.onStatusLine === "function") manager.onStatusLine(id, body);
      } else {
        manager.onHook(id, mapHookEvent(body));
      }
    } catch {
      // a hint that can't be used is dropped
    }
  }

  function receive(req, res, kind) {
    const id = req.params.id;
    if (!isSessionId(id)) {
      refuse(req, res, 404);
      return;
    }
    const presented = bearerToken(req.get("authorization"));
    let verdict = "unknown_session";
    try {
      verdict = manager.checkHookToken(id, presented);
    } catch {
      verdict = "unknown_session";
    }
    if (verdict === "unknown_session") {
      refuse(req, res, 404);
      return;
    }
    if (verdict !== "ok") {
      refuse(req, res, 401);
      return;
    }
    receiveBody(req, res, (raw) => setImmediate(() => deliver(kind, id, presented, raw)));
  }

  const router = express.Router({ caseSensitive: true });
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!isLocal()) {
      refuse(req, res, 403);
      return;
    }
    next();
  });
  router.post("/sessions/:id", (req, res) => receive(req, res, "event"));
  router.post("/sessions/:id/status", (req, res) => receive(req, res, "status"));
  router.use((req, res) => refuse(req, res, 404));
  // Express's own errors here (an id that can't be decoded) are an unknown
  // address too, answered without a log line (R27).
  router.use((_error, req, res, _next) => refuse(req, res, 404));
  return router;
}
