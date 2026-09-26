// Host allow-list, Origin check, and the local-mode session-token gate.
// These stop a malicious website from driving the local API (DNS rebinding,
// wildcard-CORS style CSRF).
import crypto from "node:crypto";
import { authRequired, isAdminRequest } from "./auth.js";
import { isDemoPublic } from "./demo-public.js";

const DEFAULT_ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
// "/agent-builder-source" has no trailing slash so the bare proxy path is gated too.
const GATED_PREFIXES = ["/api/", "/agent-builder-source", "/_next/"];
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

function parseCookieHeader(header = "") {
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

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function providedSessionToken(req, cookieName) {
  const cookies = parseCookieHeader(req.get("cookie") || "");
  return cookies[cookieName] || req.get("x-agent-os-token") || "";
}

function isLocalMode() {
  return !isDemoPublic() && !authRequired();
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
    const isGatedPath = GATED_PREFIXES.some((prefix) => req.path.startsWith(prefix));
    if (!isGatedPath) {
      next();
      return;
    }
    if (req.method === "GET" && (req.path === "/api/health" || req.path === "/api/session")) {
      next();
      return;
    }
    if (req.method === "POST" && req.path === "/api/session/claim") {
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
