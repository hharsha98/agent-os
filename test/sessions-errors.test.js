// Sessions, the shared errors module (ruling R4): the one home of the session
// id pattern (planning decision Q39: no file path is ever built from anything
// else), of the error every sessions module throws (profiles, settings,
// recorder, manager), and of the answer the routes send for it (decision Q14:
// a refused folder answers { error: "folder_refused", code, message }).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { SESSION_ID_RE, errorBody, isSessionId, sessionError } from "../server/runtime/sessions/errors.js";

test("session ids: only crypto.randomUUID() values pass", () => {
  for (let i = 0; i < 20; i += 1) {
    const id = crypto.randomUUID();
    assert.ok(SESSION_ID_RE.test(id), id);
    assert.equal(isSessionId(id), true, id);
  }
  const id = crypto.randomUUID();
  const refused = [
    id.toUpperCase(),
    ` ${id}`,
    `${id}\n`,
    `${id}/..`,
    "../etc/passwd",
    "",
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8", // a version 1 uuid
    "123e4567-e89b-42d3-c456-426614174000", // the wrong variant
    null,
    undefined,
    42,
    { id },
    [id]
  ];
  for (const bad of refused) assert.equal(isSessionId(bad), false, String(bad));
});

test("sessionError carries status, code, message and a copy of extra, and nothing more", () => {
  const extra = { code: "is_home" };
  const error = sessionError(400, "folder_refused", "Your home folder itself can't be used. Pick a folder inside it.", extra);
  assert.ok(error instanceof Error);
  assert.equal(error.status, 400);
  assert.equal(error.code, "folder_refused");
  assert.equal(error.message, "Your home folder itself can't be used. Pick a folder inside it.");
  assert.deepEqual(error.extra, { code: "is_home" });
  assert.notEqual(error.extra, extra, "a copy, so a later change to the caller's object can't change the answer");
  assert.equal("body" in error, false, "one shape: no .body");
  assert.equal("folderCode" in error, false, "the folder policy's code lives in extra.code");
  assert.deepEqual(sessionError(404, "unknown_session", "That session doesn't exist anymore.").extra, {});
});

test("errorBody is the answer the routes send: { error, message, ...extra }", () => {
  assert.deepEqual(errorBody(sessionError(400, "folder_refused", "Pick a folder inside your home folder.", { code: "outside_home" })), {
    error: "folder_refused",
    message: "Pick a folder inside your home folder.",
    code: "outside_home"
  });
  assert.deepEqual(errorBody(sessionError(409, "too_many_sessions", "Agent OS runs at most 8 sessions at once. Stop one, then try again.")), {
    error: "too_many_sessions",
    message: "Agent OS runs at most 8 sessions at once. Stop one, then try again."
  });
});
