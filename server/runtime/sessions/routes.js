// HTTP surface for sessions (SP3): each agent's own terminal, running in a
// folder the person picked. Like the agents and Team Room routers, nothing
// here takes a command, an argument or a binary path from the request: the
// body carries an agent id and a folder, and the manager checks both (the
// fixed agent list and the folder policy, D12) before anything starts. Every
// :id is checked with isSessionId (SESSION_ID_RE) before anything reads the
// disk or asks the manager (planning decision Q39). server/index.js mounts
// both routers behind requireLocalMode: outside local mode none of these
// addresses exist.
import express from "express";
import { builderErrorResponse } from "../builders/resolve.js";
import { errorBody, isSessionId } from "./errors.js";
import { recentSessionFolders } from "./folders.js";
import { getSessionManager } from "./manager.js";
import { ptyAvailable } from "./pty-host.js";
import { deleteRecording, listRecordings, openRecording, recordingsRemovedByCap } from "./recorder.js";
import { readSessionSettings, writeSessionSettings } from "./settings.js";
import { getLoginShellEnv } from "./shell-env.js";

const UNKNOWN_SESSION = { error: "unknown_session", message: "That session doesn't exist anymore." };
const INTERNAL_ERROR = { error: "internal_error", message: "Something went wrong with sessions. Try again." };

// Express 4 does not catch a rejected promise from a handler, so every handler
// goes through this.
function handle(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error) => sendError(error, res));
  };
}

// A status is only used for an answer when it is a whole number from 400 to
// 599, whatever the thrown thing claims.
function isErrorStatus(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599;
}

// A sessionError (errors.js) carries its own HTTP status and code.
function isSessionError(error) {
  return isErrorStatus(error?.status) && typeof error?.code === "string";
}

// Ruling R4: a sessionError is answered with its own status and
// errorBody(err), { error, message, ...extra } (a refused folder carries the
// policy's `code`, decision Q14). A brain error from the Brain settings has
// no status of its own and gets the one the builders routes give it. null for
// anything else.
function answerFor(error) {
  if (isSessionError(error)) return { status: error.status, body: errorBody(error) };
  const brain = builderErrorResponse(error);
  if (brain && isErrorStatus(brain.status)) return brain;
  return null;
}

// Logging, and one line of an error, must never be the thing that throws.
function logQuietly(...args) {
  try {
    console.error(...args);
  } catch {
    // nothing more to do
  }
}

function oneLine(error) {
  try {
    const text = typeof error?.message === "string" ? error.message : String(error);
    return text.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "an error that can't be read";
  }
}

// Answers an error, and never throws itself: it runs inside handle()'s
// .catch, where a throw would be an unhandled rejection, which ends the whole
// server on Node 22. Anything unexpected (a status that is not 400 to 599, an
// `extra` that is not JSON, a getter that throws) gets the fixed 500, which
// never echoes a message that could name a file; when even that cannot be
// written, the connection is closed. A response that has already started
// cannot carry a new status, so it is logged and closed.
function sendError(error, res) {
  try {
    if (res.headersSent) {
      logQuietly(`Agent OS sessions: an answer failed after it had started, so the connection was closed: ${oneLine(error)}`);
      res.destroy();
      return;
    }
    let answer = null;
    try {
      answer = answerFor(error);
    } catch {
      answer = null;
    }
    if (!answer) {
      logQuietly(error);
      res.status(500).json(INTERNAL_ERROR);
      return;
    }
    try {
      res.status(answer.status).json(answer.body);
    } catch {
      logQuietly(error);
      res.status(500).json(INTERNAL_ERROR);
    }
  } catch {
    try {
      res.destroy();
    } catch {
      // the connection is already gone
    }
  }
}

// Which sessions run right now: the manager's own live view (ruling R8), in
// which a session still closing its recording counts as live (meta.json can
// already say "exited" by then, and during a quit). When the manager cannot
// say, the recorder falls back to meta.json.
function liveCheck(manager) {
  return typeof manager.isLive === "function" ? (id) => manager.isLive(id) : undefined;
}

function drainedOrClosed(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

// Planning decision Q26, as the recorder streams it: one header line, the
// older segment's events, then the newer segment's events. openRecording
// throws its 404 before anything is sent. The asciicast headers are set only
// when the first line is about to be written (or the stream ends with none),
// so a read that fails before that is answered as normal JSON. A client that
// goes away stops the read.
async function streamRecording(id, res) {
  const { lines } = await openRecording(id);
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.status(200);
    res.setHeader("Content-Type", "application/x-asciicast");
    res.setHeader("Cache-Control", "no-store");
  };
  for await (const line of lines) {
    start();
    if (res.destroyed) break;
    if (!res.write(line)) await drainedOrClosed(res);
  }
  start();
  res.end();
}

// Express decodes a path parameter before router.param runs. An id with
// broken percent-encoding ("%E0%A4%A") fails there with Express's own 400,
// whose message quotes the id. It is no session id, so it gets the same
// answer as every other one.
function isDecodeFailure(error) {
  return error instanceof URIError || (typeof error?.message === "string" && error.message.startsWith("Failed to decode param"));
}

function unknownSessionOnBadEncoding(error, _req, res, next) {
  if (!isDecodeFailure(error) || res.headersSent) {
    next(error);
    return;
  }
  res.status(404).json(UNKNOWN_SESSION);
}

export function createSessionsRouter({ manager = getSessionManager() } = {}) {
  // Case sensitive like the app ("/api/sessions/FOLDERS" is not the folders
  // address; as an id it fails SESSION_ID_RE).
  const router = express.Router({ caseSensitive: true });

  // The login-shell environment is read in the background (it can take up to
  // 10 s; planning decision Q23). The list never waits for it: it reports the
  // notice once it is known, and null until then.
  let environmentNotice = null;
  function followLoginShellEnv() {
    Promise.resolve()
      .then(() => getLoginShellEnv())
      .then((result) => {
        environmentNotice = typeof result?.notice === "string" ? result.notice : null;
      })
      .catch(() => {});
  }

  router.param("id", (_req, res, next, id) => {
    if (!isSessionId(id)) {
      res.status(404).json(UNKNOWN_SESSION);
      return;
    }
    next();
  });

  router.get(
    "/",
    handle(async (req, res) => {
      followLoginShellEnv();
      const includeUpdate = req.query.kind === "all";
      const [sessions, pty] = await Promise.all([manager.list({ includeUpdate }), ptyAvailable()]);
      const ptyOk = pty?.ok === true;
      res.json({
        sessions,
        environmentNotice,
        pty: { ok: ptyOk, reason: ptyOk ? null : (pty?.reason ?? null) },
        maxLive: manager.maxLive
      });
    })
  );

  // Agent sessions only: the update kind is started by the update service
  // through the manager, never over HTTP. The manager checks the agent, Look
  // only, the terminal module and the folder (a typed one in the browser, a
  // picked one in the desktop app), in that order; its folder refusal
  // carries the policy's code (Q14).
  router.post(
    "/",
    handle(async (req, res) => {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const session = await manager.create({ agentId: body.agentId, folder: body.folder });
      res.status(201).json(session);
    })
  );

  // Fixed paths first, so none of them is ever taken for an :id.
  router.get(
    "/folders",
    handle(async (_req, res) => {
      res.json({ folders: await recentSessionFolders() });
    })
  );

  router.get(
    "/settings",
    handle(async (_req, res) => {
      res.json(await readSessionSettings());
    })
  );

  // settings.js accepts only { claudeFullscreen: true | false }; anything
  // else is its 400 invalid_settings, and nothing is written.
  router.put(
    "/settings",
    handle(async (req, res) => {
      res.json(await writeSessionSettings(req.body));
    })
  );

  router.post(
    "/quit-check",
    handle(async (_req, res) => {
      res.json(await manager.quitCheck());
    })
  );

  router.get(
    "/:id",
    handle(async (req, res) => {
      res.json(await manager.get(req.params.id));
    })
  );

  // The Stop sequence's answer as it is (Task S7): the summary plus `note`
  // (OpenClaw's honest note, or null), with no wrapper. Stopping a session
  // that has already ended answers its unchanged summary.
  router.post(
    "/:id/stop",
    handle(async (req, res) => {
      res.json(await manager.stop(req.params.id, { by: "stop" }));
    })
  );

  router.post(
    "/:id/resume",
    handle(async (req, res) => {
      res.json(await manager.resume(req.params.id));
    })
  );

  router.post(
    "/:id/dismiss",
    handle(async (req, res) => {
      res.json(await manager.dismiss(req.params.id));
    })
  );

  router.get(
    "/:id/recording",
    handle(async (req, res) => {
      await streamRecording(req.params.id, res);
    })
  );

  router.delete(
    "/:id/recording",
    handle(async (req, res) => {
      res.json(await deleteRecording(req.params.id, { isLive: liveCheck(manager) }));
    })
  );

  // After every route: an error held while matching reaches it last.
  router.use(unknownSessionOnBadEncoding);

  return router;
}

// Session recordings (Runs, "Session recordings" tab). The list is read from
// disk by recorder.js, so it also holds sessions from earlier runs of the
// server; which ones are live comes from the manager. `removedByCap` counts
// the recordings the 1 GB cap deleted since this server started (planning
// decision Q38).
export function createRecordingsRouter({ manager = getSessionManager() } = {}) {
  const router = express.Router({ caseSensitive: true });
  router.get(
    "/",
    handle(async (_req, res) => {
      const recordings = await listRecordings({ isLive: liveCheck(manager) });
      res.json({ recordings, removedByCap: recordingsRemovedByCap() });
    })
  );
  router.use(unknownSessionOnBadEncoding);
  return router;
}
