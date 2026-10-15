// The sessions WebSocket: /api/sessions/:id/attach (spec SP3, "WebSocket
// protocol", and Security 1).
//
// Express middleware never runs for an upgrade request, so this endpoint has
// its own check, run on every upgrade before anything else. The REST gate's
// helpers are deliberately not reused: originCheckMiddleware lets GET and a
// missing Origin through and compares only the hostname (any local port would
// pass), and the REST gate also accepts the x-agent-os-token header. Here:
//   - local mode only (never the public demo or the admin-token public mode);
//   - the path, checked lower-cased, must be exactly /api/sessions/<id>/attach,
//     with no query string (planning decision Q40);
//   - Host must be an allowed host AND carry the port this server is bound to;
//   - Origin is required and must be exactly http://127.0.0.1:<port> or
//     http://localhost:<port>; the Vite dev page (port 5173) only when
//     AGENT_OS_DEV_ORIGIN=1, and never in a production or packaged run;
//   - the session cookie agent_os_session_<port>, compared in constant time;
//   - the session must exist and still run (Q40: an unknown id and an ended
//     session are refused like every other failure; an ended one has no live
//     screen, and its recording is in Runs).
// Any failure: write 403 and destroy the socket. Nothing from the request is
// ever logged.
//
// After the upgrade each socket is one attachment. The session manager owns
// the rules (which attachment is the writer, seq and ack, pausing the
// terminal, closing an attachment that falls 4 MB behind or still lags once
// the terminal has been paused for 10 s) and sends every frame itself, the
// snapshot first. This file checks and translates frames.
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import {
  cookieNameFor,
  isAllowedHost,
  isLocalMode,
  parseCookieHeader,
  parseHostHeader,
  sessionToken
} from "../local-session.js";
import { isSessionId } from "./errors.js";

// ws closes a socket that sends a bigger message (close code 1009).
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
// A client frame bigger than this, counted over the whole raw frame in bytes
// (in practice an `in` paste), is refused: dropped before it reaches the
// terminal, and the socket stays open. The page splits big pastes.
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;
// The close code for each reason a window is closed with (4000-4999 are free
// for applications). The close reason text is the same word, and clients
// decide by the word, never by the number.
export const CLOSE_CODES = { too_far_behind: 4000, session_ended: 4001, attach_failed: 4004 };

const DEV_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const ATTACH_PATH = /^\/api\/sessions\/([^/]+)\/attach$/;
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

function devOriginAllowed(env) {
  return env.AGENT_OS_DEV_ORIGIN === "1" && env.NODE_ENV !== "production" && env.AGENT_OS_PACKAGED !== "1";
}

// The exact Origin values an attach may carry, for the port this server is
// bound to.
export function allowedOrigins(port, env = process.env) {
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return devOriginAllowed(env) ? [...own, ...DEV_ORIGINS] : own;
}

// The port written in a Host header ("127.0.0.1:8090", "[::1]:8090"), as text.
function hostHeaderPort(value) {
  const match = /:(\d{1,5})$/.exec(String(value || "").trim());
  return match ? match[1] : "";
}

// One cookie's value, or "" when it is missing or not valid percent-encoding.
// It is read by the REST gate's own parser, so both doors agree on a header
// that carries the same name twice (another local page can set one with a
// different path): the LAST one wins. (That parser throws on bad
// percent-encoding; a throw here would stop the server, since no Express error
// handler runs for an upgrade.)
function cookieValue(header, name) {
  try {
    return parseCookieHeader(header)[name] || "";
  } catch {
    return "";
  }
}

function sameSecret(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function refused(reason) {
  return { ok: false, reason };
}

// Security 1 as a pure check of the upgrade request (no I/O).
export function checkUpgradeRequest(req, { port }) {
  const headers = req?.headers || {};
  if (req?.method !== "GET") return refused("method");
  if (String(headers.upgrade || "").toLowerCase() !== "websocket") return refused("upgrade");
  if (!isLocalMode()) return refused("mode");

  const url = String(req.url || "");
  if (url.includes("?") || url.includes("#")) return refused("path");
  const lower = url.toLowerCase();
  const match = ATTACH_PATH.exec(lower);
  if (!match || lower !== url || !isSessionId(match[1])) return refused("path");

  const boundPort = Number(port);
  if (!Number.isInteger(boundPort) || boundPort <= 0) return refused("host");
  if (!isAllowedHost(parseHostHeader(headers.host)) || hostHeaderPort(headers.host) !== String(boundPort)) {
    return refused("host");
  }

  if (typeof headers.origin !== "string" || !allowedOrigins(boundPort).includes(headers.origin)) {
    return refused("origin");
  }

  if (!sameSecret(cookieValue(headers.cookie, cookieNameFor(boundPort)), sessionToken)) return refused("cookie");

  return { ok: true, sessionId: match[1] };
}

// A client frame, checked: the four frame types with their bounds, or null.
// Viewer input and a viewer's resize are dropped by the manager, not here.
export function parseClientFrame(data, isBinary) {
  if (isBinary) return null;
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buffer.length > MAX_CLIENT_FRAME_BYTES) return null;
  let frame;
  try {
    frame = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  if (frame.t === "focus") return { t: "focus" };
  if (frame.t === "in") return typeof frame.d === "string" && frame.d.length > 0 ? { t: "in", d: frame.d } : null;
  if (frame.t === "resize") {
    const { cols, rows } = frame;
    const fits = Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 500 && rows >= 1 && rows <= 200;
    return fits ? { t: "resize", cols, rows } : null;
  }
  if (frame.t === "ack") return Number.isSafeInteger(frame.seq) && frame.seq >= 0 ? { t: "ack", seq: frame.seq } : null;
  return null;
}

// Writes 403 and destroys the socket (spec Security 1). The timer covers a
// client that never reads the answer.
function refuse(socket) {
  if (socket.destroyed) return;
  socket.once("finish", () => socket.destroy());
  socket.end(FORBIDDEN);
  setTimeout(() => socket.destroy(), 1000).unref?.();
}

// Q40: an unknown session is refused like every other failure, and so is an
// ended one (it has no live screen to attach to; its recording is in Runs).
// Only the manager's live map is asked (isLive: no disk scan, no agent
// detection, which runs a version probe), so a page that keeps retrying an
// ended session costs almost nothing. Whatever is not live is ended or
// unknown, and both get the same 403. (A session that has just exited but is
// still closing its recording counts as live here; the manager then closes
// the new window with session_ended.)
function liveSession(manager, id) {
  try {
    return manager.isLive(id) === true;
  } catch {
    return false;
  }
}

function safely(fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") result.then(undefined, () => {});
  } catch {
    // the session ended or the frame was not allowed: nothing to tell this socket
  }
}

function dispatch(manager, sessionId, attachmentId, frame) {
  safely(() => {
    if (frame.t === "focus") return manager.focus(sessionId, attachmentId);
    if (frame.t === "in") return manager.write(sessionId, attachmentId, frame.d);
    if (frame.t === "resize") return manager.resize(sessionId, attachmentId, frame.cols, frame.rows);
    return manager.ack(sessionId, attachmentId, frame.seq);
  });
}

// A reason this file does not know is an attach_failed (4004), never
// too_far_behind: that word tells the page to reattach at once, so a reason
// added to the manager later would send a window into a reattach loop.
function closeWord(reason) {
  return typeof reason === "string" && Object.hasOwn(CLOSE_CODES, reason) ? reason : "attach_failed";
}

function serveAttachment(ws, sessionId, manager) {
  const attachmentId = crypto.randomUUID();
  let detach = null;
  let closed = false;

  // What the manager holds for this socket. The manager sends the snapshot,
  // then the state, then output and alerts, in that order.
  const attachment = {
    id: attachmentId,
    send(frame) {
      if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    close(reason) {
      if (closed) return;
      const word = closeWord(reason);
      ws.close(CLOSE_CODES[word], word);
    }
  };

  // A protocol error (for example a message over maxPayload) is followed by
  // "close"; without a listener it would be thrown and stop the server.
  ws.on("error", () => {});
  ws.on("close", () => {
    closed = true;
    const done = detach;
    detach = null;
    if (done) safely(done);
  });

  const ready = Promise.resolve()
    .then(() => manager.attach(sessionId, attachment))
    .then((attached) => {
      if (closed) {
        safely(() => attached.detach());
        return false;
      }
      detach = () => attached.detach();
      return true;
    })
    .catch((error) => {
      if (!closed) {
        const word = error?.code === "session_ended" ? "session_ended" : "attach_failed";
        ws.close(CLOSE_CODES[word], word);
      }
      return false;
    });

  // Frames wait until the window is attached, and keep their order.
  ws.on("message", (data, isBinary) => {
    const frame = parseClientFrame(data, isBinary);
    if (!frame) return;
    ready.then((ok) => {
      if (ok && !closed) dispatch(manager, sessionId, attachmentId, frame);
    });
  });
}

// Installs the upgrade listener on the HTTP server. With a listener present,
// Node hands EVERY upgrade request to it, so anything that is not a correct
// attach is refused here too.
export function attachSessionsUpgrade(server, { getPort, manager }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    let verdict;
    try {
      verdict = checkUpgradeRequest(req, { port: getPort() });
    } catch {
      verdict = refused("error");
    }
    if (!verdict.ok) {
      refuse(socket);
      return;
    }
    if (!liveSession(manager, verdict.sessionId)) {
      refuse(socket);
      return;
    }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => serveAttachment(ws, verdict.sessionId, manager));
    } catch {
      refuse(socket);
    }
  });
}
