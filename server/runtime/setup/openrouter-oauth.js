// "Connect OpenRouter" in one click: the OAuth PKCE flow from
// https://openrouter.ai/docs/guides/overview/auth/oauth, run entirely by this
// server. In plain words:
//
//   1. startFlow() makes a one-time secret (the "code verifier"), a state, and
//      a one-time local address, http://localhost:<port>/oauth/openrouter/
//      start/<nonce>. THAT address (not OpenRouter's) is what is handed to the
//      person's normal browser, so the state and the code challenge never
//      show up in the process list.
//   2. The start address hands the browser a cookie that only that browser
//      has, then sends it on to OpenRouter's sign-in page.
//   3. OpenRouter sends the browser back to http://localhost:<port>/oauth/
//      openrouter/callback?code=...&state=... when they press Authorize.
//   4. handleCallback() requires BOTH the state and that cookie (so a link
//      someone else started can't be forced on this person's browser), trades
//      the code for an API key on the server, and keeps it in memory only.
//   5. The Setup configure job takes the key once (takeKey) and hands it to
//      the agents. After that the key is gone from here.
//
// The key is never logged, never written to disk by Agent OS, and never
// returned by any API, event, or page this module produces. Errors shown to
// the person are fixed sentences, never copies of what OpenRouter sent back.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getServerPort } from "../server-info.js";
import { verifyOpenRouterKey } from "./brain.js";
import { applyMirror, mirrorOrigin } from "./recipes.js";

const AUTH_URL = "https://openrouter.ai/auth";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK_PATH = "/oauth/openrouter/callback";
const START_PATH = "/oauth/openrouter/start";
const START_PATH_PATTERN = /^\/oauth\/openrouter\/start\/[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{64}$/;
const KEY_LABEL = "Agent OS";

// OpenRouter's authorization codes expire after 10 minutes, so a flow does too.
const FLOW_TTL_MS = 10 * 60 * 1000;
// A connected flow keeps its key in memory this long waiting for "configure".
const KEY_TTL_MS = 15 * 60 * 1000;
// Finished flows stay readable this long (so the screen can show the result),
// then they are forgotten.
const FINISHED_KEEP_MS = 15 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15 * 1000;
const MAX_WAITING_FLOWS = 3;
const CALLBACK_WINDOW_MS = 60 * 1000;
const CALLBACK_MAX_PER_WINDOW = 20;
const SWEEP_EVERY_MS = 30 * 1000;
const MAX_CODE_LENGTH = 2048;
const MAX_STATE_LENGTH = 256;

export const FLOW_ID_PATTERN = /^[a-f0-9]{32}$/;

// A sign-in that stops part-way can leave an unused key behind on the
// person's OpenRouter account, so every "it didn't finish" message says where
// to delete it.
const KEY_TIP = ' If you see an unused "Agent OS" key at openrouter.ai/settings/keys, you can delete it.';

const MESSAGE = {
  expired: `That sign-in took longer than 10 minutes and expired. Press Connect OpenRouter to start again.${KEY_TIP}`,
  keyExpired: `The connection was not used within 15 minutes and was forgotten for your safety. Press Connect OpenRouter again.${KEY_TIP}`,
  denied: `OpenRouter didn't accept this sign-in. Press Connect OpenRouter to try again.${KEY_TIP}`,
  unreachable: `Couldn't reach OpenRouter to finish connecting. Check your internet connection and try again.${KEY_TIP}`,
  noKey: `OpenRouter answered, but without a key. Press Connect OpenRouter to try again.${KEY_TIP}`,
  badKey: `OpenRouter gave Agent OS a key, but it didn't pass a check. Press Connect OpenRouter to try again.${KEY_TIP}`,
  generic: `OpenRouter couldn't finish the connection. Try again in a minute.${KEY_TIP}`,
  cancelled: `You stopped the sign-in. Nothing was connected.${KEY_TIP}`
};

// ---- clock (swappable in tests so "10 minutes later" doesn't take 10 minutes)
let clock = () => Date.now();
export function setClockForTest(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}

// ---- flows (memory only) ----------------------------------------------------
// flowId -> { id, status, verifier, state, expiresAt, keyExpiresAt, key, error, info, endedAt }
// status: waiting | exchanging | connected | failed | expired | cancelled
const flows = new Map();
let sweeper = null;

function flowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isOpen(flow) {
  return flow.status === "waiting" || flow.status === "exchanging";
}

function finish(flow, status, error) {
  flow.status = status;
  flow.error = error || "";
  flow.endedAt = clock();
  flow.verifier = null; // no longer needed once the flow is over
  if (status !== "connected") flow.key = null;
}

function sweep() {
  const t = clock();
  for (const [id, flow] of flows) {
    if (flow.status === "waiting" && t >= flow.expiresAt) finish(flow, "expired", MESSAGE.expired);
    else if (flow.status === "connected" && flow.key && t >= flow.keyExpiresAt) finish(flow, "expired", MESSAGE.keyExpired);
    if (!isOpen(flow) && flow.endedAt && t - flow.endedAt > FINISHED_KEEP_MS) flows.delete(id);
  }
  if (!flows.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  sweeper.unref?.(); // never keeps the process alive
}

function base64url(buffer) {
  return buffer.toString("base64url");
}

// The sign-in page calls us back here. OpenRouter documents that localhost
// works on any port. Whether it also accepts 127.0.0.1 is not documented, so
// the host can be switched with AGENT_OS_OAUTH_CALLBACK_HOST (only these two
// values are honoured).
function callbackHost() {
  const override = String(process.env.AGENT_OS_OAUTH_CALLBACK_HOST || "").trim().toLowerCase();
  return override === "127.0.0.1" ? "127.0.0.1" : "localhost";
}

export function startFlow({ port } = {}) {
  sweep();
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw flowError("server_port_unknown", "Agent OS doesn't know its own port yet. Try again in a moment.");
  }
  const waiting = [...flows.values()].filter(isOpen).length;
  if (waiting >= MAX_WAITING_FLOWS) {
    throw flowError(
      "too_many_flows",
      "Too many sign-ins are already waiting. Finish or cancel one of them, or wait a few minutes."
    );
  }

  const id = crypto.randomBytes(16).toString("hex");
  const verifier = base64url(crypto.randomBytes(32));
  const state = crypto.randomBytes(32).toString("hex");
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const callbackUrl = `http://${callbackHost()}:${portNumber}${CALLBACK_PATH}`;

  const query = [
    `callback_url=${encodeURIComponent(callbackUrl)}`,
    `code_challenge=${challenge}`,
    "code_challenge_method=S256",
    `state=${state}`,
    `key_label=${encodeURIComponent(KEY_LABEL)}`
  ].join("&");
  // In tests the mirror turns this into a http://127.0.0.1 address; in real
  // use it is unchanged (the mirror is ignored unless explicitly set).
  const openRouterUrl = applyMirror(`${AUTH_URL}?${query}`);

  // What the person's browser is actually given: a one-time address on THIS
  // server. It sets the browser's own cookie, then redirects to OpenRouter.
  // Handing out the OpenRouter address itself would put the state and the
  // code challenge on a command line, and would let anyone else's sign-in
  // link be started in this person's browser.
  const startNonce = crypto.randomBytes(32).toString("hex");
  const authUrl = `http://${callbackHost()}:${portNumber}${START_PATH}/${startNonce}`;

  flows.set(id, {
    id,
    status: "waiting",
    verifier,
    state,
    startNonce,
    startUsed: false,
    cookieSecret: crypto.randomBytes(32).toString("hex"),
    openRouterUrl,
    expiresAt: clock() + FLOW_TTL_MS,
    keyExpiresAt: 0,
    key: null,
    error: "",
    info: null,
    endedAt: 0
  });
  ensureSweeper();
  return { flowId: id, authUrl };
}

// The browser's own cookie for one sign-in. Cookies are shared between ports
// on the same host, so the name includes this server's port.
function flowCookieName() {
  return `agent_os_openrouter_${getServerPort() || 0}`;
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

// Single-use: the first browser to open the start address gets the cookie and
// is sent to OpenRouter; a second visit (or a made-up address) gets a plain page.
export function consumeStart(nonce) {
  sweep();
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) return { status: 400, kind: "invalid" };
  let flow = null;
  for (const candidate of flows.values()) {
    if (stateMatches(candidate.startNonce, nonce)) flow = candidate;
  }
  if (!flow) return { status: 400, kind: "invalid" };
  if (flow.startUsed) return { status: 400, kind: "startUsed" };
  if (flow.status === "expired") return { status: 410, kind: "expired" };
  if (flow.status !== "waiting") return { status: 400, kind: "invalid" };
  if (clock() >= flow.expiresAt) {
    finish(flow, "expired", MESSAGE.expired);
    return { status: 410, kind: "expired" };
  }
  flow.startUsed = true;
  return { status: 302, location: flow.openRouterUrl, cookie: flow.cookieSecret };
}

// Express handler for GET /oauth/openrouter/start/:nonce.
export function createOpenRouterStartHandler() {
  return (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const result = consumeStart(req.params?.nonce);
    if (result.status === 302) {
      // HttpOnly: page scripts can't read it. SameSite=Lax: the browser still
      // sends it when OpenRouter sends the person back with a normal link.
      res.setHeader(
        "Set-Cookie",
        `${flowCookieName()}=${result.cookie}; HttpOnly; SameSite=Lax; Path=/oauth/openrouter; Max-Age=${Math.floor(FLOW_TTL_MS / 1000)}`
      );
      res.redirect(302, result.location);
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    );
    res.status(result.status).type("html").send(renderCallbackPage(result.kind));
  };
}

// Is there a sign-in WAITING for exactly this state? (Used so the rate limit
// only ever applies to requests that are not a real return trip.)
export function hasWaitingFlowForState(state) {
  sweep();
  if (typeof state !== "string" || !state || state.length > MAX_STATE_LENGTH) return false;
  let found = false;
  for (const flow of flows.values()) {
    if (stateMatches(flow.state, state) && flow.status === "waiting") found = true;
  }
  return found;
}

// What the screen is allowed to know. NEVER includes the key.
export function getStatus(flowId) {
  sweep();
  const flow = flows.get(String(flowId));
  if (!flow) return null;
  const result = { status: isOpen(flow) ? "waiting" : flow.status };
  if (flow.error) result.error = flow.error;
  if (flow.info) result.info = { ...flow.info };
  return result;
}

// Internal: used by the configure job only. Gives the key out exactly once.
export function takeKey(flowId) {
  sweep();
  const flow = flows.get(String(flowId));
  if (!flow || flow.status !== "connected" || !flow.key) return null;
  const key = flow.key;
  flow.key = null;
  return key;
}

export function cancel(flowId) {
  sweep();
  const flow = flows.get(String(flowId));
  if (!flow) return null;
  if (isOpen(flow) || (flow.status === "connected" && flow.key)) finish(flow, "cancelled", MESSAGE.cancelled);
  return getStatus(flowId);
}

// ---- the callback -----------------------------------------------------------

const PAGE_TEXT = {
  connected: ["Connected to OpenRouter.", "You can close this tab and go back to Agent OS."],
  cancelled: [
    "Sign-in cancelled.",
    `Nothing was connected. You can close this tab and go back to Agent OS to try again.${KEY_TIP}`
  ],
  invalid: [
    "This sign-in link can't be used.",
    "It was already used, or it didn't start in Agent OS. Close this tab, then press Connect OpenRouter in Agent OS."
  ],
  startUsed: [
    "This sign-in link was already opened.",
    "Each sign-in link works once. Close this tab and, if you still need to sign in, press Connect OpenRouter in Agent OS again."
  ],
  expired: [
    "This sign-in expired.",
    `OpenRouter sign-ins are only valid for 10 minutes. Close this tab and press Connect OpenRouter in Agent OS to start again.${KEY_TIP}`
  ],
  failed: ["Couldn't finish connecting.", `Go back to Agent OS to see what happened, then try again.${KEY_TIP}`],
  busy: ["Too many tries.", "Wait a minute, then press Connect OpenRouter in Agent OS again."]
};

// A tiny self-contained page. It only ever shows the fixed sentences above:
// no key, code or state is ever put in it. The script removes ?code=&state=
// from the address bar and history of the person's browser.
export function renderCallbackPage(kind) {
  const [title, message] = PAGE_TEXT[kind] || PAGE_TEXT.failed;
  const mark = kind === "connected" ? "&#10003;" : "&#9632;";
  const color = kind === "connected" ? "#3DDC97" : "#F5B84B";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Agent OS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070B;color:#E9EEF5;font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:2rem}h1{margin:0 0 .5rem;font-size:1.4rem}p{margin:0;color:#A7B2C2}
.m{display:block;margin-bottom:.75rem;font-size:1.6rem;color:${color}}</style></head>
<body><main><span class="m" aria-hidden="true">${mark}</span><h1>${title}</h1><p>${message}</p></main>
<script>try{history.replaceState(null,"",location.pathname)}catch(e){}</script></body></html>`;
}

function respond(httpStatus, kind) {
  return { httpStatus, outcome: kind, html: renderCallbackPage(kind) };
}

function stateMatches(expected, given) {
  const a = Buffer.from(String(expected), "utf8");
  const b = Buffer.from(String(given), "utf8");
  if (a.length !== b.length) return false; // timingSafeEqual needs equal lengths
  return crypto.timingSafeEqual(a, b);
}

function findFlowByState(state) {
  let found = null;
  // Look at every flow (no early exit) so timing doesn't reveal how many exist.
  for (const flow of flows.values()) {
    if (stateMatches(flow.state, state)) found = flow;
  }
  return found;
}

function explainExchangeFailure(status, bodyText) {
  if (status === 403 && /expired/i.test(bodyText)) return MESSAGE.expired;
  if (status === 403) return MESSAGE.denied;
  return MESSAGE.generic;
}

// Trades the one-time code for a key. Resolves to { key } or { error }.
async function exchangeCode(flow, code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const response = await fetch(applyMirror(EXCHANGE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: flow.verifier, code_challenge_method: "S256" }),
      signal: controller.signal
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) return { error: explainExchangeFailure(response.status, text) };
    let key = "";
    try {
      key = String(JSON.parse(text)?.key || "");
    } catch {
      key = "";
    }
    return key ? { key } : { error: MESSAGE.noKey };
  } catch {
    return { error: MESSAGE.unreachable };
  } finally {
    clearTimeout(timer);
  }
}

// `cookie` is the secret from the browser's own cookie (see consumeStart).
export async function handleCallback({ code, state, cookie } = {}) {
  sweep();
  const malformed =
    (code !== undefined && typeof code !== "string") ||
    (state !== undefined && typeof state !== "string") ||
    (cookie !== undefined && typeof cookie !== "string") ||
    String(code || "").length > MAX_CODE_LENGTH ||
    String(state || "").length > MAX_STATE_LENGTH;
  if (malformed) return respond(400, "invalid");

  const givenCode = code || "";
  const givenState = state || "";

  // The person pressed "Deny": OpenRouter sends them back with no code and,
  // as documented, no state. With no state we can't tell WHICH sign-in that
  // was, and anyone can open this address, so it must never change a flow:
  // we only show the "cancelled" page. The sign-in then ends by the screen's
  // own Cancel button or by its 10-minute expiry.
  if (!givenCode && !givenState) return respond(200, "cancelled");
  // A code without a state can't be proven to belong to us.
  if (!givenState) return respond(400, "invalid");

  const flow = findFlowByState(givenState);
  if (!flow) return respond(400, "invalid");
  // The state alone is not enough: this browser must also hold the cookie the
  // start address gave it. Otherwise a sign-in link someone else began could
  // be completed in this person's browser (a "login CSRF"). Left untouched,
  // the real sign-in carries on waiting.
  if (!flow.cookieSecret || !cookie || !stateMatches(flow.cookieSecret, cookie)) return respond(400, "invalid");
  if (flow.status === "expired") return respond(410, "expired");
  if (flow.status !== "waiting") return respond(400, "invalid"); // single use
  if (clock() >= flow.expiresAt) {
    finish(flow, "expired", MESSAGE.expired);
    return respond(410, "expired");
  }
  if (!givenCode) {
    finish(flow, "cancelled", MESSAGE.cancelled);
    return respond(200, "cancelled");
  }

  // From here on this state can never be used again, even while we wait.
  flow.status = "exchanging";
  const exchanged = await exchangeCode(flow, givenCode);
  // The person pressed Cancel while we were talking to OpenRouter: drop the key.
  if (flow.status !== "exchanging") return respond(200, "cancelled");
  if (exchanged.error) {
    finish(flow, "failed", exchanged.error);
    return respond(502, "failed");
  }
  const verified = await verifyOpenRouterKey(exchanged.key);
  if (flow.status !== "exchanging") return respond(200, "cancelled");
  // Only a definite "no" (HTTP 401/403) throws a fresh key away. A network
  // blip or a server error on the check says nothing about the key, so the
  // connection stands, just without the extra account details.
  if (!verified.ok && verified.rejected) {
    finish(flow, "failed", MESSAGE.badKey);
    return respond(502, "failed");
  }
  flow.status = "connected";
  flow.key = exchanged.key;
  flow.keyExpiresAt = clock() + KEY_TTL_MS;
  flow.endedAt = clock(); // when the finished-flow clean-up clock starts
  flow.verifier = null;
  flow.info = {};
  if (typeof verified.label === "string") flow.info.label = verified.label;
  if (typeof verified.isFreeTier === "boolean") flow.info.isFreeTier = verified.isFreeTier;
  if (typeof verified.limit === "number") flow.info.limit = verified.limit;
  return respond(200, "connected");
}

// Express handler for GET /oauth/openrouter/callback. It deliberately needs
// no session cookie (the system browser has none); the host/origin checks in
// server/index.js still apply, and the state is the real proof.
export function createOpenRouterCallbackHandler() {
  const hits = [];
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    );
    res.type("html");
    const state = req.query?.state;
    // The limit (20 a minute) only applies to requests that are NOT the return
    // trip of a sign-in that is really waiting. Otherwise someone hitting this
    // address in a loop could make the person's own, real callback fail with
    // "too many tries". Looked up first, limited second.
    if (!hasWaitingFlowForState(state)) {
      const t = clock();
      while (hits.length && t - hits[0] > CALLBACK_WINDOW_MS) hits.shift();
      if (hits.length >= CALLBACK_MAX_PER_WINDOW) {
        res.status(429).send(renderCallbackPage("busy"));
        return;
      }
      hits.push(t);
    }
    try {
      const result = await handleCallback({
        code: req.query?.code,
        state,
        cookie: readCookie(req.headers?.cookie, flowCookieName())
      });
      res.status(result.httpStatus).send(result.html);
    } catch {
      res.status(500).send(renderCallbackPage("failed"));
    }
  };
}

// ---- opening the person's normal browser -----------------------------------

function allowedBrowserUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  // No spaces or control characters: the address is handed over as ONE
  // argument, and anything odd-looking is not an address we built.
  if (String(raw).length > 4096 || /[\s\u0000-\u001f\u007f]/.test(String(raw)) || url.username || url.password) return false;
  if (url.protocol === "https:" && url.hostname === "openrouter.ai") return true;
  // The one-time start address of THIS server's own sign-in (what the person's
  // browser is normally given): exactly this shape and this server's port.
  const ownPort = getServerPort();
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    ownPort > 0 &&
    url.port === String(ownPort) &&
    START_PATH_PATTERN.test(url.pathname) &&
    !url.search &&
    !url.hash
  ) {
    return true;
  }
  // Tests only: the validated loopback mirror that applyMirror() honours.
  const origin = mirrorOrigin();
  return Boolean(origin) && url.origin === origin;
}

function browserCommand(url, platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

let injectedOpener = null;
// Tests: replace the real opener (so no real browser ever opens).
export function setBrowserOpenerForTest(fn) {
  injectedOpener = typeof fn === "function" ? fn : null;
}

// Opens `url` in the system browser. The command and its arguments are passed
// as a list and never through a shell, so a URL can't be turned into a
// command. Only OpenRouter's own address and this server's one-time sign-in
// start address are allowed. Resolves
// { opened: true } or { opened: false, reason } -- it never throws.
export function openSystemBrowser(url, { spawnFn = spawn, platform = process.platform } = {}) {
  if (!allowedBrowserUrl(url)) return Promise.resolve({ opened: false, reason: "blocked_url" });
  if (injectedOpener) return Promise.resolve(injectedOpener(url));
  // Lets a server started by a test (or a headless machine) skip the browser.
  if (process.env.AGENT_OS_NO_BROWSER === "1") return Promise.resolve({ opened: false, reason: "disabled" });
  const { command, args } = browserCommand(String(url), platform);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: "ignore", detached: true, windowsHide: true, shell: false });
    } catch {
      resolve({ opened: false, reason: "spawn_failed" });
      return;
    }
    child.once("error", () => resolve({ opened: false, reason: "spawn_failed" }));
    child.once("spawn", () => {
      child.unref?.();
      resolve({ opened: true });
    });
  });
}

// ---- tests only ---------------------------------------------------------------

export function resetForTest() {
  flows.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  clock = () => Date.now();
  injectedOpener = null;
}

// Lets a test look inside a flow to prove the key is really gone. Never
// exposed over HTTP.
export function inspectFlowForTest(flowId) {
  const flow = flows.get(String(flowId));
  return flow ? { ...flow } : null;
}
