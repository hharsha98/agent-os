// Host allow-list, Origin check, and the local-mode session-token gate.
// These stop a malicious website from driving the local API (DNS rebinding,
// wildcard-CORS style CSRF).
import crypto from "node:crypto";
import { authRequired, isAdminRequest } from "./auth.js";
import { isDemoPublic } from "./demo-public.js";

const DEFAULT_ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
// "/agent-builder-source" has no trailing slash so the bare proxy path is gated too.
// "/oauth/" is gated too, so the ONE address below that is let through stays
// the only one: any other /oauth/ path needs the session like /api/ does.
const GATED_PREFIXES = ["/api/", "/agent-builder-source", "/_next/", "/oauth/"];
// OpenRouter's sign-in sends the person's normal browser (which has no Agent
// OS session cookie) back to exactly this address.
const OAUTH_CALLBACK_PATH = "/oauth/openrouter/callback";
// The one-time local address the person's browser opens first ("/oauth/
// openrouter/start/<single-use nonce>"). Exactly this shape, nothing else.
const OAUTH_START_PATH = /^\/oauth\/openrouter\/start\/[a-f0-9]{64}$/;
const CLAIM_WINDOW_MS = 60000;
const CLAIM_MAX_FAILURES = 20;

// Random per-process unless the operator pins one via AGENT_OS_TOKEN. Never
// logged anywhere except the one login line printed at startup.
export const sessionToken = process.env.AGENT_OS_TOKEN?.trim() || crypto.randomBytes(24).toString("hex");

export function cookieNameFor(port) {
  return `agent_os_session_${port}`;
}

function stripBrackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function parseHostHeader(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1].toLowerCase();
  const withPort = raw.match(/^(.*):(\d+)$/);
  const hostname = withPort ? withPort[1] : raw;
  return stripBrackets(hostname).toLowerCase();
}

function extraAllowedHosts() {
  return String(process.env.AGENT_OS_ALLOWED_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedHost(hostname) {
  if (!hostname) return false;
  if (DEFAULT_ALLOWED_HOSTS.has(hostname)) return true;
  return extraAllowedHosts().includes(hostname);
}

export function hostAllowlistMiddleware() {
  return (req, res, next) => {
    const hostname = parseHostHeader(req.get("host"));
    if (!isAllowedHost(hostname)) {
      res.status(403).json({ error: "host_not_allowed" });
      return;
    }
    next();
  };
}

// The Vite page of `npm run dev`. Its requests reach the server through Vite's proxy, which rewrites the Host
// header but not the Origin, so these two are this server's own pages only while the dev launcher set the flag
// (never in a production or packaged run). The sessions WebSocket (sessions/ws.js) trusts the same two.
export const DEV_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

export function devOriginAllowed(env = process.env) {
  return env.AGENT_OS_DEV_ORIGIN === "1" && env.NODE_ENV !== "production" && env.AGENT_OS_PACKAGED !== "1";
}

// Whether `origin` is this server's own page: scheme and host AND PORT exactly as the request's Host header
// says (so a page on 127.0.0.1:3000 is not the page on 127.0.0.1:8090), or the dev page above.
function isOwnOrigin(origin, hostHeader) {
  const wanted = String(origin).trim().toLowerCase();
  const host = String(hostHeader || "").trim().toLowerCase();
  if (host && (wanted === `http://${host}` || wanted === `https://${host}`)) return true;
  return devOriginAllowed() && DEV_ORIGINS.includes(wanted);
}

export function originCheckMiddleware() {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.get("origin");
    if (!origin) {
      next();
      return;
    }
    let hostname = "";
    try {
      hostname = stripBrackets(new URL(origin).hostname.toLowerCase());
    } catch {
      hostname = "";
    }
    if (!isAllowedHost(hostname)) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    // Local mode (browser mode on 127.0.0.1): the session cookie is SameSite=Strict, which counts 127.0.0.1:3000
    // and 127.0.0.1:8090 as one site, so a page on any other local port would send it along with a form post or a
    // no-cors fetch. A request that names an Origin must name this server's own. A request with none (Claude's
    // hook calls, curl with the token header) is unchanged: it still needs the cookie or the token.
    if (isLocalMode() && !isOwnOrigin(origin, req.get("host"))) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    next();
  };
}

export function securityHeadersMiddleware() {
  return (_req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  };
}

// Exported so the sessions WebSocket (sessions/ws.js) reads the cookie by the
// very same rule as this gate: the LAST cookie with a name wins.
export function parseCookieHeader(header = "") {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

// Also the hook token check (sessions/manager.js, SP4).
export function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function providedSessionToken(req, cookieName) {
  const cookies = parseCookieHeader(req.get("cookie") || "");
  return cookies[cookieName] || req.get("x-agent-os-token") || "";
}

// Local mode: neither the public demo (DEMO_PUBLIC=1) nor the admin-token
// public mode (HERMES_AGENT_OS_REQUIRE_AUTH=1 or HERMES_AGENT_OS_PUBLIC_MODE=1).
// Sessions (real agent terminals) exist only here.
export function isLocalMode() {
  return !isDemoPublic() && !authRequired();
}

// Every sessions and recordings address answers as if it did not exist
// outside local mode (spec Security 1). The sessions WebSocket makes the same
// check itself (server/runtime/sessions/ws.js), because Express middleware
// never runs for an upgrade request.
export function requireLocalMode(_req, res, next) {
  if (!isLocalMode()) {
    res.status(404).json({ error: "not_available" });
    return;
  }
  next();
}

// `port` may be a number or a () => number getter. With PORT=0 the real port
// is only known after listen(), so index.js passes a getter and this reads
// it fresh on every request instead of baking in the port at startup.
function resolvePort(port) {
  return typeof port === "function" ? port() : port;
}

export function localSessionGate(port) {
  return (req, res, next) => {
    const cookieName = cookieNameFor(resolvePort(port));
    if (!isLocalMode()) {
      next();
      return;
    }
    // Express matches routes without caring about letter case ("/API/runs"
    // reaches the same handler as "/api/runs"), so "is this path protected?"
    // is asked of the LOWER-CASED path: comparing the raw path would let anyone
    // skip the session by changing a letter's case.
    const lowerPath = String(req.path).toLowerCase();
    const isGatedPath = GATED_PREFIXES.some((prefix) => lowerPath.startsWith(prefix));
    if (!isGatedPath) {
      next();
      return;
    }
    // The few session-free addresses must be written EXACTLY as they really
    // are (lower case): "/OAUTH/openrouter/callback" is a different address
    // and stays behind the session.
    const exactPath = String(req.path);
    if (req.method === "GET" && (exactPath === "/api/health" || exactPath === "/api/session")) {
      next();
      return;
    }
    if (req.method === "POST" && exactPath === "/api/session/claim") {
      next();
      return;
    }
    if (req.method === "GET" && (exactPath === OAUTH_CALLBACK_PATH || OAUTH_START_PATH.test(exactPath))) {
      next();
      return;
    }
    const provided = providedSessionToken(req, cookieName);
    if (provided && timingSafeEqualStrings(provided, sessionToken)) {
      next();
      return;
    }
    res.status(401).json({
      error: "session_required",
      message: "Open the Agent OS login link printed in the terminal (or restart the app)."
    });
  };
}

// Single-user localhost app: keyed on remote address, reset every minute.
const claimAttempts = new Map();

function claimRateLimited(key) {
  const entry = claimAttempts.get(key);
  if (!entry || Date.now() - entry.windowStart > CLAIM_WINDOW_MS) return false;
  return entry.count >= CLAIM_MAX_FAILURES;
}

function recordClaimFailure(key) {
  const now = Date.now();
  const entry = claimAttempts.get(key);
  if (!entry || now - entry.windowStart > CLAIM_WINDOW_MS) {
    claimAttempts.set(key, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

export function claimSessionHandler(port) {
  return (req, res) => {
    const cookieName = cookieNameFor(resolvePort(port));
    const key = req.ip || req.socket?.remoteAddress || "local";
    if (claimRateLimited(key)) {
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }
    const token = String(req.body?.token || "");
    if (!token || !timingSafeEqualStrings(token, sessionToken)) {
      recordClaimFailure(key);
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    const secure = process.env.HERMES_AGENT_OS_COOKIE_SECURE === "1";
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`
    );
    res.json({ ok: true });
  };
}

export function localSessionStatusHandler(port) {
  return (req, res) => {
    const cookieName = cookieNameFor(resolvePort(port));
    if (isDemoPublic()) {
      res.json({ mode: "demo", authenticated: true });
      return;
    }
    if (authRequired()) {
      res.json({ mode: "public", authenticated: isAdminRequest(req) });
      return;
    }
    const provided = providedSessionToken(req, cookieName);
    const authenticated = Boolean(provided) && timingSafeEqualStrings(provided, sessionToken);
    res.json({ mode: "local", authenticated });
  };
}

function isLoopbackLike(host) {
  return /^127\./.test(String(host || ""));
}

// Printed once at startup, in local mode only. The only place the raw token
// is ever written to stdout.
export function loginLine(port, bindHost) {
  const host = isLoopbackLike(bindHost) ? bindHost : "localhost";
  return `Agent OS is running. Open: http://${host}:${port}/?launch=${sessionToken}`;
}
