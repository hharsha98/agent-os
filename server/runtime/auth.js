import { isOwnOrigin, timingSafeEqualStrings } from "./local-session.js";

const COOKIE_NAME = "hermes_admin_token";

function parseCookies(header = "") {
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

export function authRequired() {
  return process.env.HERMES_AGENT_OS_REQUIRE_AUTH === "1" || process.env.HERMES_AGENT_OS_PUBLIC_MODE === "1";
}

export function adminTokenConfigured() {
  return Boolean(process.env.HERMES_AGENT_OS_ADMIN_TOKEN);
}

// The token is never read from the address (?adminToken=): addresses end up in proxy logs and browser history.
function readAdminToken(req) {
  const bearer = String(req.get?.("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const given = req.get?.("x-hermes-admin-token") || bearer || req.body?.adminToken || "";
  if (given) return { token: given, viaCookie: false };
  return { token: parseCookies(req.get?.("cookie") || "")[COOKIE_NAME] || "", viaCookie: true };
}

export function providedAdminToken(req) {
  return readAdminToken(req).token;
}

export function isAdminRequest(req) {
  const expected = process.env.HERMES_AGENT_OS_ADMIN_TOKEN;
  if (!expected) return !authRequired();
  const { token, viaCookie } = readAdminToken(req);
  if (!timingSafeEqualStrings(token, expected)) return false;
  // The cookie is sent along with a form post from a page on another local port (same site, different port), so a
  // request that proves itself only by the cookie and names another page as its Origin is refused. A request with
  // no Origin (curl, scripts) and every read are unchanged.
  if (viaCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get?.("origin");
    if (origin && !isOwnOrigin(origin, req.get?.("host"))) return false;
  }
  return true;
}

export function assertAdminRequest(req) {
  if (isAdminRequest(req)) return;
  const error = new Error(
    adminTokenConfigured()
      ? "Admin token required."
      : "Set HERMES_AGENT_OS_ADMIN_TOKEN before enabling public/admin-protected mode."
  );
  error.status = 403;
  throw error;
}

export function requireAdminWhenPublic(req, _res, next) {
  try {
    if (!authRequired()) {
      next();
      return;
    }
    assertAdminRequest(req);
    next();
  } catch (error) {
    next(error);
  }
}

export function sessionStatus(req) {
  return {
    required: authRequired(),
    adminTokenConfigured: adminTokenConfigured(),
    authenticated: isAdminRequest(req),
    mode: process.env.HERMES_AGENT_OS_PUBLIC_MODE === "1" ? "public" : "local"
  };
}

export function setAdminCookie(res, token) {
  const secure = process.env.HERMES_AGENT_OS_COOKIE_SECURE === "1";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`
  );
}

export function clearAdminCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
