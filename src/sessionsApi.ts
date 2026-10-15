// Sessions (SP3): every request the shell and the pages make about sessions, each one with a time limit
// (withTimeout, planning decision Q31), and the WebSocket client for one session's terminal (spec,
// WebSocket protocol). The pure rules (frame sizes, acks, reading a frame) live in
// src/ui/sessionsShared.ts, where test/sessions-shared.test.js checks them.
import { ApiError, request } from "./api";
import type {
  QuitCheckResponse,
  RecordingListResponse,
  SessionClientFrame,
  SessionFolderList,
  SessionListResponse,
  SessionSettings,
  SessionSnapshot,
  SessionStateFrame,
  SessionSummary,
  StopSessionResult
} from "./types";
import { withTimeout } from "./ui/homeShared";
import {
  ATTACH_FAILED_CODE,
  chunkInput,
  createAckCounter,
  parseServerFrame,
  RESIZE_DEBOUNCE_MS,
  sessionCloseAdvice,
  SNAPSHOT_WAIT_MS,
  validSize
} from "./ui/sessionsShared";
import type { SessionCloseAdvice } from "./ui/sessionsShared";

// How long each request may take before the page says Agent OS did not answer.
export const SESSION_LIMITS_MS = {
  list: 8000,
  // The server waits for the login-shell environment (up to 10 s, H2) before it starts the agent.
  create: 30000,
  // The soft stop (2 s) and the kill grace (3 s), with room to spare.
  stop: 15000,
  resume: 30000,
  dismiss: 10000,
  settings: 10000,
  folders: 10000,
  quitCheck: 8000,
  recordings: 10000,
  signedIn: 5000
} as const;

const TIMEOUT_WORDS = "Agent OS did not answer in time.";
const UNREADABLE = "Agent OS gave an answer that could not be read.";

const sessionPath = (sessionId: string, tail = "") => `/api/sessions/${encodeURIComponent(sessionId)}${tail}`;
const postJson = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export async function listSessions(): Promise<SessionListResponse> {
  const body = await withTimeout(request<SessionListResponse>("/api/sessions"), SESSION_LIMITS_MS.list);
  if (!body || !Array.isArray(body.sessions)) throw new Error(UNREADABLE);
  return body;
}

// `folder` is null for OpenClaw, which picks its own folder until spike S5. The server checks the folder
// (planning decision Q14) and answers 400 folder_refused with a sentence when it is not allowed.
export function createSession({ agentId, folder }: { agentId: string; folder: string | null }): Promise<SessionSummary> {
  return withTimeout(request<SessionSummary>("/api/sessions", postJson({ agentId, folder })), SESSION_LIMITS_MS.create);
}

export function stopSession(sessionId: string): Promise<StopSessionResult> {
  return withTimeout(request<StopSessionResult>(sessionPath(sessionId, "/stop"), postJson()), SESSION_LIMITS_MS.stop);
}

export function resumeSession(sessionId: string): Promise<SessionSummary> {
  return withTimeout(request<SessionSummary>(sessionPath(sessionId, "/resume"), postJson()), SESSION_LIMITS_MS.resume);
}

export function dismissSession(sessionId: string): Promise<SessionSummary> {
  return withTimeout(request<SessionSummary>(sessionPath(sessionId, "/dismiss"), postJson()), SESSION_LIMITS_MS.dismiss);
}

export function getSessionSettings(): Promise<SessionSettings> {
  return withTimeout(request<SessionSettings>("/api/sessions/settings"), SESSION_LIMITS_MS.settings);
}

export function putSessionSettings(patch: Partial<SessionSettings>): Promise<SessionSettings> {
  return withTimeout(
    request<SessionSettings>("/api/sessions/settings", { method: "PUT", body: JSON.stringify(patch) }),
    SESSION_LIMITS_MS.settings
  );
}

export function listSessionFolders(): Promise<SessionFolderList> {
  return withTimeout(request<SessionFolderList>("/api/sessions/folders"), SESSION_LIMITS_MS.folders);
}

// Every live session of both kinds, with its title, for the quit question (planning decision Q27).
export function quitCheck(): Promise<QuitCheckResponse> {
  return withTimeout(request<QuitCheckResponse>("/api/sessions/quit-check", postJson()), SESSION_LIMITS_MS.quitCheck);
}

// The quit check for the two places that ask before ending sessions (the desktop quit and the update banner).
// Where sessions do not exist (a server outside local mode answers 404 not_available) nothing can be running,
// so that answer is "none". Every other failure stays a failure, and the caller says it could not check.
export async function quitCheckOrNone(): Promise<QuitCheckResponse> {
  try {
    return await quitCheck();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.message === "not_available") return { live: [] };
    throw error;
  }
}

export function listRecordings(): Promise<RecordingListResponse> {
  return withTimeout(request<RecordingListResponse>("/api/recordings"), SESSION_LIMITS_MS.recordings);
}

export function deleteRecording(sessionId: string): Promise<{ ok: true }> {
  return withTimeout(request<{ ok: true }>(sessionPath(sessionId, "/recording"), { method: "DELETE" }), SESSION_LIMITS_MS.recordings);
}

// Words for a refused or failed request: the server's own sentence when it sent one (Q14, Q15, Q25),
// otherwise a plain fallback.
export function sessionProblem(error: unknown): string {
  if (error instanceof ApiError) return error.detail || "Agent OS couldn't do that. Try again.";
  if (error instanceof Error && error.message === TIMEOUT_WORDS) return TIMEOUT_WORDS;
  if (isUnreadable(error)) return UNREADABLE;
  return "Couldn't reach Agent OS.";
}

// An answer came, but it was not what it should be: not JSON (the browser's SyntaxError) or without the
// list (listSessions). Agent OS was reached, so it is not "couldn't reach".
function isUnreadable(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.message === UNREADABLE);
}

// True when a request got no answer at all (time limit or network): it may still have happened, so a page
// never says "nothing was changed" then, and reads the list again instead (Q31). An answer that could not
// be read is an answer.
export function sessionGotNoAnswer(error: unknown): boolean {
  return !(error instanceof ApiError) && !isUnreadable(error);
}

// ---------------------------------------------------------------------------
// The WebSocket client for one session's terminal
// ---------------------------------------------------------------------------

export interface SessionSocketClose {
  // 4000 too_far_behind, 4001 session_ended, 4004 attach_failed (S9's CLOSE_CODES), ws's 1009, or the
  // browser's own (1006 for a dropped connection). For logs; `advice` is what to act on.
  code: number;
  // The server's reason word: "too_far_behind", "session_ended" or "attach_failed" (empty when none came).
  reason: string;
  // false when the socket closed before its snapshot arrived (refused, or the server went away).
  hadSnapshot: boolean;
  // Decided by the reason word (sessionCloseAdvice): "reattach" (attach again for a fresh snapshot),
  // "ended" (never attach again) or "wait" (attach_failed or 1009: do not try again at once). A refused
  // upgrade (an ended or unknown session gets a bare 403) arrives as 1006 with no word, so "reattach" here
  // is only advice: the terminal (U2) attaches again only while the session list still says the session is
  // live (ruling R12).
  advice: SessionCloseAdvice;
}

export interface SessionSocketHandlers {
  // The first frame. A returned promise holds every later frame until it settles, so output never lands
  // before the restored screen.
  onSnapshot: (snapshot: SessionSnapshot) => void | Promise<void>;
  // A returned promise means "not on screen yet": the bytes count as processed (for acks) when it settles.
  onOut: (data: string) => void | Promise<void>;
  onState: (state: SessionStateFrame) => void;
  // SP3: the raw OSC 9 / 99 / 777 payload, or "bel".
  onAlert: (raw: string) => void;
  // Not called after close() from this side.
  onClose: (info: SessionSocketClose) => void;
}

export interface SessionSocket {
  // This terminal has the keys: it becomes the writer, and its size follows at once.
  focus(): void;
  // Keystrokes, paste and the terminal's own replies to terminal queries. true only when every chunk was
  // sent; false when the socket is not open (still connecting, closed, or closed from this side), so the
  // terminal can keep the text or tell the person (P26: typed text is never thrown away without a sign).
  input(data: string): boolean;
  resize(cols: number, rows: number): void;
  close(): void;
}

// Same host as the page; no query string and no token in the address (the session cookie goes with the
// upgrade; Security 1, planning decision Q40).
export function sessionSocketUrl(sessionId: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${sessionPath(sessionId, "/attach")}`;
}

// A socket that closes before its snapshot may mean the person is signed out: check, the way useRunStream does.
async function checkStillSignedIn(): Promise<void> {
  try {
    const session = await withTimeout(request<{ authenticated?: boolean }>("/api/session"), SESSION_LIMITS_MS.signedIn);
    if (session && session.authenticated === false) window.dispatchEvent(new CustomEvent("agentos:locked"));
  } catch {
    // A network hiccup here is not a sign-out.
  }
}

export function openSessionSocket(sessionId: string, handlers: SessionSocketHandlers): SessionSocket {
  const ws = new WebSocket(sessionSocketUrl(sessionId));
  const acks = createAckCounter();
  let closedHere = false;
  let hadSnapshot = false;
  // Settles once the snapshot is on screen; every later frame waits for it, in arrival order.
  let ready: Promise<void> = Promise.resolve();
  let size: { cols: number; rows: number } | null = null;
  let sent: { cols: number; rows: number } | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let focusWhenOpen = false;
  // The upgrade can succeed and then nothing arrives: after SNAPSHOT_WAIT_MS this window gives up.
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (frame: SessionClientFrame): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  };
  const cancelResize = () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = null;
  };
  const cancelSnapshotWait = () => {
    if (snapshotTimer !== null) clearTimeout(snapshotTimer);
    snapshotTimer = null;
  };
  const sendSize = () => {
    cancelResize();
    if (size && send({ t: "resize", cols: size.cols, rows: size.rows })) sent = { ...size };
  };
  // {t:"focus"} makes this window the writer; its size follows right after it (spec).
  const takeKeys = () => {
    send({ t: "focus" });
    sendSize();
  };

  // No snapshot in time: close the socket and say what a refused attach says (S9's attach_failed), using the
  // existing close word, so the terminal shows "could not attach" and waits instead of loading forever.
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (hadSnapshot || closedHere) return;
    closedHere = true;
    cancelResize();
    try {
      ws.close(1000, "closed");
    } catch {
      // Already closed.
    }
    try {
      handlers.onClose({ code: ATTACH_FAILED_CODE, reason: "attach_failed", hadSnapshot: false, advice: "wait" });
    } catch {
      // The page's handler failed; nothing more to do here.
    }
  }, SNAPSHOT_WAIT_MS);

  ws.onopen = () => {
    if (focusWhenOpen) {
      focusWhenOpen = false;
      takeKeys();
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    if (closedHere || typeof event.data !== "string") return;
    const frame = parseServerFrame(event.data);
    if (!frame) return;
    if (frame.t === "snapshot") {
      // One snapshot per socket; a fresh one comes with a new socket.
      if (hadSnapshot) return;
      hadSnapshot = true;
      cancelSnapshotWait();
      acks.reset();
      const snapshot: SessionSnapshot = { data: frame.data, cols: frame.cols, rows: frame.rows, modes: frame.modes };
      ready = Promise.resolve()
        .then(() => handlers.onSnapshot(snapshot))
        .then(
          () => undefined,
          () => undefined
        );
      return;
    }
    // The snapshot always comes first; anything earlier has no screen to land on.
    if (!hadSnapshot) return;
    if (frame.t === "out") {
      const seq = frame.seq;
      const data = frame.d;
      void ready
        .then(() => (closedHere ? undefined : handlers.onOut(data)))
        .then(() => {
          const ack = acks.processed(seq);
          if (ack !== null) send({ t: "ack", seq: ack });
        })
        .catch(() => undefined);
      return;
    }
    if (frame.t === "state") {
      const state: SessionStateFrame = { status: frame.status, exitCode: frame.exitCode, signal: frame.signal, endedBy: frame.endedBy, resetAt: frame.resetAt };
      void ready
        .then(() => {
          if (!closedHere) handlers.onState(state);
        })
        .catch(() => undefined);
      return;
    }
    const raw = frame.raw;
    void ready
      .then(() => {
        if (!closedHere) handlers.onAlert(raw);
      })
      .catch(() => undefined);
  };

  ws.onclose = (event: CloseEvent) => {
    cancelResize();
    cancelSnapshotWait();
    if (closedHere) return;
    if (!hadSnapshot) void checkStillSignedIn();
    const reason = event.reason || "";
    const info: SessionSocketClose = { code: event.code, reason, hadSnapshot, advice: sessionCloseAdvice({ code: event.code, reason }) };
    // Like every other frame, after the restored screen: a session that ends while the snapshot is still
    // being drawn delivers its last output and state first. Still once, and never after close() from this side.
    void ready
      .then(() => {
        if (!closedHere) handlers.onClose(info);
      })
      .catch(() => undefined);
  };

  return {
    focus() {
      if (ws.readyState === WebSocket.OPEN) takeKeys();
      else if (ws.readyState === WebSocket.CONNECTING) focusWhenOpen = true;
    },
    input(data: string): boolean {
      for (const d of chunkInput(data)) {
        if (!send({ t: "in", d })) return false;
      }
      return true;
    },
    resize(cols: number, rows: number) {
      if (!validSize(cols, rows)) return;
      size = { cols, rows };
      cancelResize();
      if (sent && sent.cols === cols && sent.rows === rows) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        sendSize();
      }, RESIZE_DEBOUNCE_MS);
    },
    close() {
      closedHere = true;
      cancelResize();
      cancelSnapshotWait();
      try {
        ws.close(1000, "closed");
      } catch {
        // Already closed.
      }
    }
  };
}
