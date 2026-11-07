// The page's Content-Security-Policy (review items U-M1, D-M1, S-M4): exact text in local mode, the request's own
// host in the WebSocket entries, none of them for a host that is not allowed, and only the frame rule while the
// dev launcher's flag is on (Vite's dev page needs inline scripts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { pageContentSecurityPolicy, securityHeadersMiddleware } from "../server/runtime/local-session.js";

function run(host, env = {}) {
  const saved = {};
  for (const key of ["AGENT_OS_DEV_ORIGIN", "AGENT_OS_PACKAGED", "NODE_ENV"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    const headers = {};
    const res = { setHeader: (name, value) => (headers[name.toLowerCase()] = value) };
    let called = false;
    securityHeadersMiddleware()({ get: (name) => (name.toLowerCase() === "host" ? host : undefined) }, res, () => (called = true));
    assert.equal(called, true);
    return headers;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const exact = (host) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self'${host ? ` ws://${host} wss://${host}` : ""} ipc: http://ipc.localhost`,
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join("; ");

test("local mode: the policy is sent, exact, with the request's own host for the WebSocket", () => {
  const headers = run("127.0.0.1:8090");
  assert.equal(headers["content-security-policy"], exact("127.0.0.1:8090"));
  assert.equal(headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(run("localhost:3000")["content-security-policy"], exact("localhost:3000"), "a different host and port is used as sent");
  assert.equal(run("[::1]:8090")["content-security-policy"], exact("[::1]:8090"), "an IPv6 host keeps its brackets");
});

test("a host that is not on the allow-list gets the policy without any WebSocket entry", () => {
  assert.equal(run("evil.example")["content-security-policy"], exact(""));
  assert.equal(run("evil.example:8090")["content-security-policy"], exact(""));
  assert.equal(run(undefined)["content-security-policy"], exact(""));
  assert.doesNotMatch(pageContentSecurityPolicy("evil.example:1"), /ws:|wss:/);
});

test("a host header with odd characters never reaches the header value", () => {
  assert.equal(pageContentSecurityPolicy("127.0.0.1:8090; script-src *"), exact(""));
  assert.equal(pageContentSecurityPolicy("127.0.0.1 x"), exact(""));
});

test("the dev launcher's flag keeps only the frame rule", () => {
  assert.equal(run("127.0.0.1:8090", { AGENT_OS_DEV_ORIGIN: "1" })["content-security-policy"], "frame-ancestors 'self'");
  // The flag never counts in a packaged or production run, so the full policy stays.
  assert.equal(run("127.0.0.1:8090", { AGENT_OS_DEV_ORIGIN: "1", AGENT_OS_PACKAGED: "1" })["content-security-policy"], exact("127.0.0.1:8090"));
  assert.equal(run("127.0.0.1:8090", { AGENT_OS_DEV_ORIGIN: "1", NODE_ENV: "production" })["content-security-policy"], exact("127.0.0.1:8090"));
});
