// Errors and ids shared by the sessions modules (profiles, settings, recorder,
// manager, routes, WebSocket). The only home of all four (ruling R4).

// A crypto.randomUUID() value (planning decision Q39). Every route and the
// WebSocket check an id with it before any file path is built.
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

// status = the HTTP status; code = the answer's `error` word; extra = more
// answer fields (folder_refused: { code }, the folder policy's code).
export function sessionError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.extra = extra && typeof extra === "object" ? { ...extra } : {};
  return error;
}

// The JSON answer for a sessionError: { error, message, ...extra }.
export function errorBody(err) {
  return { error: err.code, message: err.message, ...err.extra };
}
