// "Connect OpenRouter" (OAuth PKCE): the flow rules, the one-time start
// address and cookie, the callback route, the session gate around them, the
// browser opener, and the HTTP routes. Everything talks to a fake OpenRouter
// on 127.0.0.1 (the AGENT_OS_SETUP_MIRROR mirror), never the real one, and no
// real browser is ever opened. The end-to-end round trip with the fake agents
// and the "key leaks nowhere" grep lives in setup-brain.test.js.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import express from "express";
import http from "node:http";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { hostAllowlistMiddleware, localSessionGate, sessionToken } from "../server/runtime/local-session.js";
import { setServerPort } from "../server/runtime/server-info.js";
import { clearBrainCacheForTest } from "../server/runtime/setup/brain.js";
import {
  cancel,
  consumeStart,
  createOpenRouterCallbackHandler,
  createOpenRouterStartHandler,
  getStatus,
  handleCallback,
  hasWaitingFlowForState,
  inspectFlowForTest,
  openSystemBrowser,
  renderCallbackPage,
  resetForTest,
  setBrowserOpenerForTest,
  setClockForTest,
  startFlow,
  takeKey
} from "../server/runtime/setup/openrouter-oauth.js";
import { applyMirror, mirrorOrigin } from "../server/runtime/setup/recipes.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";

const KEY = "sk-or-v1-OAUTHTEST-valid-key-0000";
const KEY_TIP = "openrouter.ai/settings/keys";

// ---- the fake OpenRouter ---------------------------------------------------

let fake = null;
let fakePort = 0;
const codes = new Map(); // code -> { challenge, used }
const hits = { exchange: 0, key: 0 };
let behavior = "ok"; // exchange: ok | bad | expired | nokey | slow
let keyBehavior = "ok"; // the key check: ok | 401 | 403 | 500 | drop

function sha256Base64url(text) {
  return crypto.createHash("sha256").update(text).digest("base64url");
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
}

before(async () => {
  fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake.local");
    if (url.pathname === "/openrouter.ai/auth") {
      const callback = url.searchParams.get("callback_url");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (!callback || !state || !challenge || url.searchParams.get("code_challenge_method") !== "S256") {
        res.writeHead(400);
        res.end("bad auth request");
        return;
      }
      const code = crypto.randomBytes(12).toString("hex");
      codes.set(code, { challenge, used: false });
      res.writeHead(302, { Location: `${callback}?code=${code}&state=${state}` });
      res.end();
      return;
    }
    if (url.pathname === "/openrouter.ai/api/v1/auth/keys" && req.method === "POST") {
      hits.exchange += 1;
      const body = JSON.parse((await readBody(req)) || "{}");
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (behavior === "slow") await new Promise((resolve) => setTimeout(resolve, 150));
      if (behavior === "expired") return send(403, { error: { message: "Authorization code expired" } });
      if (behavior === "bad") return send(403, { error: { message: "Invalid code or code_verifier" } });
      if (behavior === "nokey") return send(200, {});
      if (body.code_challenge_method !== "S256") return send(400, { error: { message: "Invalid code_challenge_method" } });
      const record = codes.get(body.code);
      if (!record || record.used || sha256Base64url(String(body.code_verifier)) !== record.challenge) {
        return send(403, { error: { message: "Invalid code or code_verifier" } });
      }
      record.used = true;
      return send(200, { key: KEY });
    }
    if (url.pathname === "/openrouter.ai/api/v1/key") {
      hits.key += 1;
      if (keyBehavior === "drop") {
        req.socket.destroy();
        return;
      }
      if (keyBehavior !== "ok") {
        res.writeHead(Number(keyBehavior), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      const ok = req.headers.authorization === `Bearer ${KEY}`;
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { data: { label: "Agent OS", limit: null, is_free_tier: true } } : { error: "bad key" }));
      return;
    }
    if (url.pathname === "/openrouter.ai/api/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "free/big-70b", name: "Big 70B", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], context_length: 131072 }
          ]
        })
      );
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakePort = fake.address().port;
});

after(async () => {
  await new Promise((resolve) => fake.close(resolve));
});

const saved = {};
function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  setEnv({
    AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${fakePort}`,
    AGENT_OS_OAUTH_CALLBACK_HOST: undefined,
    HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
    HERMES_AGENT_OS_PUBLIC_MODE: undefined,
    DEMO_PUBLIC: undefined,
    HERMES_AGENT_OS_DEMO_PUBLIC: undefined
  });
  resetForTest();
  clearBrainCacheForTest();
  setServerPort(0);
  codes.clear();
  hits.exchange = 0;
  hits.key = 0;
  behavior = "ok";
  keyBehavior = "ok";
});

afterEach(() => {
  resetForTest();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---- helpers -----------------------------------------------------------------

// A small app shaped like server/index.js: host allow-list, the REAL session
// gate (so every exemption is exercised), the setup router, and the start and
// callback routes. `caseSensitive: false` is Express's old default, used to
// prove the GATE itself is not fooled by letter case (not just the routing).
async function withApp(fn, { caseSensitive = true } = {}) {
  const app = express();
  app.set("case sensitive routing", caseSensitive);
  app.use(hostAllowlistMiddleware());
  app.use(express.json());
  let boundPort = 0;
  app.use(localSessionGate(() => boundPort));
  app.get("/oauth/openrouter/callback", createOpenRouterCallbackHandler());
  app.get("/oauth/openrouter/start/:nonce", createOpenRouterStartHandler());
  app.use("/api/setup", createSetupRouter());
  app.use("/api/runs", (_req, res) => res.json({ runs: [] }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  boundPort = server.address().port;
  setServerPort(boundPort);
  try {
    await fn({ base: `http://127.0.0.1:${boundPort}`, port: boundPort });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const authedHeaders = { "Content-Type": "application/json", "x-agent-os-token": sessionToken };

const toLoopback = (url) => url.replace("//localhost:", "//127.0.0.1:");
const nonceOf = (startUrl) => new URL(startUrl).pathname.split("/").pop();

// What the person's browser does with the start address: opens it (gets a
// cookie and a redirect to OpenRouter), follows OpenRouter's redirect back to
// the callback address, and loads it WITH the cookie. No session cookie, no
// token header: it is not the app window.
async function browserFollows(startUrl) {
  const start = await fetch(toLoopback(startUrl), { redirect: "manual" });
  assert.equal(start.status, 302, "the start address redirects");
  const setCookie = start.headers.get("set-cookie");
  const cookiePair = String(setCookie).split(";")[0];
  const toOpenRouter = await fetch(start.headers.get("location"), { redirect: "manual" });
  assert.equal(toOpenRouter.status, 302);
  const location = toOpenRouter.headers.get("location");
  return { start, setCookie, cookiePair, location, response: await fetch(toLoopback(location), { headers: { cookie: cookiePair } }) };
}

// Does what the browser + OpenRouter do, but hands back the pieces for a
// direct handleCallback() call: the code and state OpenRouter would return,
// and the cookie secret the start address would have set.
async function authorize(startUrl) {
  const result = consumeStart(nonceOf(startUrl));
  assert.equal(result.status, 302);
  const location = (await fetch(result.location, { redirect: "manual" })).headers.get("location");
  const params = new URL(location).searchParams;
  return { code: params.get("code"), state: params.get("state"), cookie: result.cookie };
}

function callbackUrl(base, params) {
  return `${base}/oauth/openrouter/callback?${new URLSearchParams(params).toString()}`;
}

function fakeChild(event) {
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => (event === "error" ? child.emit("error", new Error("ENOENT")) : child.emit("spawn")));
  return child;
}

// ---- 1. the sign-in addresses -----------------------------------------------------

test("startFlow(): the browser gets a one-time LOCAL start address; the OpenRouter address stays server-side", () => {
  const { flowId, authUrl } = startFlow({ port: 51234 });
  assert.match(flowId, /^[a-f0-9]{32}$/);
  assert.match(authUrl, /^http:\/\/localhost:51234\/oauth\/openrouter\/start\/[a-f0-9]{64}$/);

  const flow = inspectFlowForTest(flowId);
  const url = new URL(flow.openRouterUrl);
  assert.equal(url.pathname, "/openrouter.ai/auth"); // through the mirror in tests
  assert.equal(url.searchParams.get("callback_url"), "http://localhost:51234/oauth/openrouter/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(url.searchParams.get("state"), /^[a-f0-9]{64}$/);
  assert.equal(url.searchParams.get("key_label"), "Agent OS");
  assert.ok(flow.openRouterUrl.includes("key_label=Agent%20OS"), "label must be percent-encoded as in the docs");

  // What goes on a command line (ps) carries none of the sign-in's secrets.
  for (const secret of [flow.state, url.searchParams.get("code_challenge"), flow.cookieSecret, flow.verifier]) {
    assert.ok(!authUrl.includes(secret), "the start address leaked a secret");
  }
  assert.deepEqual(getStatus(flowId), { status: "waiting" });
});

test("startFlow(): the callback host can be switched to 127.0.0.1 for the spike, nothing else", () => {
  setEnv({ AGENT_OS_OAUTH_CALLBACK_HOST: "127.0.0.1" });
  const first = startFlow({ port: 4000 });
  assert.match(first.authUrl, /^http:\/\/127\.0\.0\.1:4000\/oauth\/openrouter\/start\//);
  assert.equal(new URL(inspectFlowForTest(first.flowId).openRouterUrl).searchParams.get("callback_url"), "http://127.0.0.1:4000/oauth/openrouter/callback");
  resetForTest();
  setEnv({ AGENT_OS_OAUTH_CALLBACK_HOST: "evil.example" });
  const second = startFlow({ port: 4000 });
  assert.match(second.authUrl, /^http:\/\/localhost:4000\//);
  assert.throws(() => startFlow({ port: 0 }), (e) => e.code === "server_port_unknown");
});

// ---- 2. the happy path, the key only in memory ----------------------------------------

test("round trip through the routes: connect -> start address (cookie) -> OpenRouter -> callback -> connected; the key never leaves memory", async () => {
  const opened = [];
  setBrowserOpenerForTest((url) => {
    opened.push(url);
    return { opened: true };
  });
  await withApp(async ({ base }) => {
    const bodies = [];
    const connect = await fetch(`${base}/api/setup/openrouter/connect`, { method: "POST", headers: authedHeaders, body: JSON.stringify({ confirm: true }) });
    assert.equal(connect.status, 200);
    const connectText = await connect.text();
    bodies.push(connectText);
    const started = JSON.parse(connectText);
    assert.equal(started.status, "waiting");
    assert.equal(started.opened, true);
    assert.match(started.authUrl, /^http:\/\/localhost:\d+\/oauth\/openrouter\/start\/[a-f0-9]{64}$/);
    // The command that opens the browser is handed ONLY the local address.
    assert.deepEqual(opened, [started.authUrl]);
    const flow = inspectFlowForTest(started.flowId);
    for (const secret of [flow.state, flow.cookieSecret, new URL(flow.openRouterUrl).searchParams.get("code_challenge")]) {
      assert.ok(!opened[0].includes(secret));
    }

    const refused = await fetch(`${base}/api/setup/openrouter/connect`, { method: "POST", headers: authedHeaders, body: "{}" });
    assert.equal(refused.status, 400, "connect without confirm:true");
    assert.deepEqual(await (await fetch(`${base}/api/setup/openrouter/connect/${started.flowId}`, { headers: authedHeaders })).json(), { status: "waiting" });

    const { start, setCookie, response, location } = await browserFollows(started.authUrl);
    // The cookie: only this browser has it, scripts can't read it, and it is
    // limited to the sign-in paths.
    assert.match(setCookie, /^agent_os_openrouter_\d+=[a-f0-9]{64}; /);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/oauth\/openrouter(;|$)/);
    assert.equal(start.headers.get("location"), flow.openRouterUrl);
    assert.equal(start.headers.get("cache-control"), "no-store");

    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Connected to OpenRouter\./);
    assert.match(page, /close this tab and go back to Agent OS/);
    const callbackParams = new URL(location).searchParams;
    for (const secret of [KEY, callbackParams.get("code"), callbackParams.get("state"), flow.cookieSecret]) {
      assert.ok(!page.includes(secret), "the callback page echoed a secret");
    }
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(hits.exchange, 1);

    const statusText = await (await fetch(`${base}/api/setup/openrouter/connect/${started.flowId}`, { headers: authedHeaders })).text();
    bodies.push(statusText);
    const status = JSON.parse(statusText);
    assert.equal(status.status, "connected");
    assert.deepEqual(status.info, { label: "Agent OS", isFreeTier: true });
    for (const body of bodies) assert.ok(!body.includes(KEY), "an API response carried the key");

    assert.equal(takeKey(started.flowId), KEY);
    assert.equal(takeKey(started.flowId), null);
    assert.equal(inspectFlowForTest(started.flowId).key, null);
    assert.equal(inspectFlowForTest(started.flowId).verifier, null);
  });
});

// ---- 3. the one-time start address --------------------------------------------------------

test("start address: works exactly once; made-up, short, used and expired addresses get a plain page and no cookie", async () => {
  let now = 1_000_000;
  setClockForTest(() => now);
  await withApp(async ({ base }) => {
    const one = startFlow({ port: Number(new URL(base).port) });
    const startUrl = toLoopback(one.authUrl);

    const first = await fetch(startUrl, { redirect: "manual" });
    assert.equal(first.status, 302);
    assert.ok(first.headers.get("set-cookie"));
    assert.equal(inspectFlowForTest(one.flowId).startUsed, true);

    const again = await fetch(startUrl, { redirect: "manual" });
    assert.equal(again.status, 400);
    assert.equal(again.headers.get("set-cookie"), null);
    assert.match(await again.text(), /already opened/);

    const madeUp = await fetch(`${base}/oauth/openrouter/start/${"a".repeat(64)}`, { redirect: "manual" });
    assert.equal(madeUp.status, 400);
    assert.equal(madeUp.headers.get("set-cookie"), null);
    assert.match(await madeUp.text(), /can't be used/);

    const two = startFlow({ port: Number(new URL(base).port) });
    now += 10 * 60 * 1000 + 1000;
    const late = await fetch(toLoopback(two.authUrl), { redirect: "manual" });
    assert.equal(late.status, 410);
    assert.equal(late.headers.get("set-cookie"), null);
    assert.equal(getStatus(two.flowId).status, "expired");
  });
});

// ---- 4. the callback: state AND cookie ------------------------------------------------------

test("callback: wrong state -> 400 and the waiting flow is untouched; reuse -> 400; a code without a state -> 400", async () => {
  const { flowId, authUrl } = startFlow({ port: 4001 });
  const { code, state, cookie } = await authorize(authUrl);

  assert.equal((await handleCallback({ code, state: "f".repeat(64), cookie })).httpStatus, 400);
  assert.equal((await handleCallback({ code, state: "abc", cookie })).httpStatus, 400);
  assert.equal((await handleCallback({ code, cookie })).httpStatus, 400);
  assert.equal((await handleCallback({ code: ["a"], state, cookie })).httpStatus, 400);
  assert.equal(getStatus(flowId).status, "waiting");
  assert.equal(hits.exchange, 0);

  assert.equal((await handleCallback({ code, state, cookie })).httpStatus, 200);
  assert.equal((await handleCallback({ code, state, cookie })).httpStatus, 400, "single use");
  assert.equal(hits.exchange, 1, "the second callback must not reach OpenRouter");
  assert.equal(getStatus(flowId).status, "connected");
});

test("login-CSRF: the right state without THIS browser's cookie can't complete a sign-in (and doesn't spoil it)", async () => {
  const a = startFlow({ port: 4020 });
  const b = startFlow({ port: 4020 });
  const forA = await authorize(a.authUrl);
  const forB = await authorize(b.authUrl);

  // Someone else's link opened in the victim's browser: state is real, but the
  // browser has no cookie, a wrong one, or the cookie of ANOTHER sign-in.
  for (const cookie of [undefined, "", "0".repeat(64), "x", forB.cookie]) {
    const result = await handleCallback({ code: forA.code, state: forA.state, cookie });
    assert.equal(result.httpStatus, 400, `cookie ${String(cookie).slice(0, 8)}`);
  }
  assert.equal(hits.exchange, 0, "OpenRouter was never asked to trade the code");
  assert.equal(getStatus(a.flowId).status, "waiting", "the real sign-in carries on");
  assert.equal(getStatus(b.flowId).status, "waiting");

  // The genuine return trip (state + its own cookie) still works.
  assert.equal((await handleCallback(forA)).httpStatus, 200);
  assert.equal(getStatus(a.flowId).status, "connected");
});

test("callback: two callbacks at the same moment -> exactly one exchange", async () => {
  behavior = "slow";
  const { authUrl } = startFlow({ port: 4002 });
  const params = await authorize(authUrl);
  const results = await Promise.all([handleCallback(params), handleCallback(params)]);
  assert.deepEqual(results.map((r) => r.httpStatus).sort(), [200, 400]);
  assert.equal(hits.exchange, 1);
});

test("callback: an expired flow -> 410 and status 'expired'; a connected key is forgotten after 15 minutes", async () => {
  let now = 1_000_000;
  setClockForTest(() => now);
  const one = startFlow({ port: 4003 });
  const first = await authorize(one.authUrl);
  now += 10 * 60 * 1000 + 1000; // just past OpenRouter's 10-minute code lifetime
  const late = await handleCallback(first);
  assert.equal(late.httpStatus, 410);
  assert.match(late.html, /expired/);
  assert.equal(getStatus(one.flowId).status, "expired");
  assert.match(getStatus(one.flowId).error, /10 minutes/);
  assert.equal(hits.exchange, 0);

  const two = startFlow({ port: 4003 });
  assert.equal((await handleCallback(await authorize(two.authUrl))).httpStatus, 200);
  assert.equal(getStatus(two.flowId).status, "connected");
  now += 15 * 60 * 1000 + 1000;
  assert.equal(getStatus(two.flowId).status, "expired");
  assert.equal(takeKey(two.flowId), null);
  assert.equal(inspectFlowForTest(two.flowId).key, null);
});

test("callback: OpenRouter refusing the exchange -> 'failed' with a plain sentence that echoes nothing and says where to delete a stray key", async () => {
  for (const [mode, pattern] of [
    ["bad", /didn't accept this sign-in/],
    ["expired", /10 minutes/],
    ["nokey", /without a key/]
  ]) {
    resetForTest();
    behavior = mode;
    const { flowId, authUrl } = startFlow({ port: 4004 });
    const result = await handleCallback(await authorize(authUrl));
    assert.equal(result.httpStatus, 502, mode);
    const status = getStatus(flowId);
    assert.equal(status.status, "failed", mode);
    assert.match(status.error, pattern, mode);
    assert.ok(status.error.includes(KEY_TIP), "the message says where to delete an unused key");
    assert.ok(!/403|code_verifier|Invalid/.test(status.error + result.html), "the message copied OpenRouter's wording");
    assert.equal(inspectFlowForTest(flowId).key, null);
  }
});

test("callback: OpenRouter unreachable -> 'failed' (not a hang or a crash)", async () => {
  const { flowId, authUrl } = startFlow({ port: 4005 });
  const params = await authorize(authUrl);
  setEnv({ AGENT_OS_SETUP_MIRROR: "http://127.0.0.1:1" });
  const result = await handleCallback(params);
  assert.equal(result.httpStatus, 502);
  assert.match(getStatus(flowId).error, /Couldn't reach OpenRouter/);
});

// ---- 5. a fresh key is only thrown away on a definite "no" ---------------------------------------

test("key check after the exchange: a network blip or a 500 keeps the connection (no extra info); only 401/403 rejects", async () => {
  for (const [mode, expectStatus] of [
    ["ok", "connected"],
    ["500", "connected"],
    ["drop", "connected"],
    ["401", "failed"],
    ["403", "failed"]
  ]) {
    resetForTest();
    keyBehavior = mode;
    const { flowId, authUrl } = startFlow({ port: 4030 });
    const result = await handleCallback(await authorize(authUrl));
    const status = getStatus(flowId);
    assert.equal(status.status, expectStatus, mode);
    if (expectStatus === "connected") {
      assert.equal(result.httpStatus, 200, mode);
      assert.equal(takeKey(flowId), KEY, `${mode}: the key is still available`);
      if (mode === "ok") assert.deepEqual(status.info, { label: "Agent OS", isFreeTier: true });
      else assert.deepEqual(status.info, {}, `${mode}: no account details, but still connected`);
    } else {
      assert.equal(result.httpStatus, 502, mode);
      assert.match(status.error, /didn't pass a check/);
      assert.ok(status.error.includes(KEY_TIP));
      assert.equal(takeKey(flowId), null);
    }
  }
});

// ---- 6. cancelling ---------------------------------------------------------------------------------

test("callback with no state never changes any sign-in; only a matching state (with its cookie) cancels that one", async () => {
  const older = startFlow({ port: 4006 });
  const newer = startFlow({ port: 4006 });
  const forNewer = await authorize(newer.authUrl);

  // "Deny" comes back with nothing (as documented), and anyone can open this
  // address: it shows the cancelled page and touches nothing.
  const bare = await handleCallback({});
  assert.equal(bare.httpStatus, 200);
  assert.match(bare.html, /Sign-in cancelled/);
  assert.equal(getStatus(older.flowId).status, "waiting");
  assert.equal(getStatus(newer.flowId).status, "waiting");
  assert.equal(hits.exchange, 0);

  // A state without a code, from the browser that holds the cookie, is that
  // person cancelling THAT sign-in.
  const withState = await handleCallback({ state: forNewer.state, cookie: forNewer.cookie });
  assert.equal(withState.httpStatus, 200);
  assert.equal(getStatus(newer.flowId).status, "cancelled");
  assert.ok(getStatus(newer.flowId).error.includes(KEY_TIP));
  assert.equal(getStatus(older.flowId).status, "waiting");

  // The same state without the cookie can't cancel anything.
  const noCookie = await handleCallback({ state: inspectFlowForTest(older.flowId).state });
  assert.equal(noCookie.httpStatus, 400);
  assert.equal(getStatus(older.flowId).status, "waiting");
});

test("cancel(): stops a waiting flow, and cancelling mid-exchange drops the key", async () => {
  const waiting = startFlow({ port: 4007 });
  assert.equal(cancel(waiting.flowId).status, "cancelled");
  assert.equal(cancel("0".repeat(32)), null);

  behavior = "slow";
  const mid = startFlow({ port: 4007 });
  const params = await authorize(mid.authUrl);
  const pending = handleCallback(params);
  await new Promise((resolve) => setTimeout(resolve, 30));
  cancel(mid.flowId);
  await pending;
  assert.equal(getStatus(mid.flowId).status, "cancelled");
  assert.equal(inspectFlowForTest(mid.flowId).key, null);
});

// ---- 7. the HTTP routes and the session gate ------------------------------------------------------

test("routes: a 4th waiting sign-in -> 429 with a plain message; cancelling one frees a place", async () => {
  setBrowserOpenerForTest(() => ({ opened: true }));
  await withApp(async ({ base }) => {
    const connect = () =>
      fetch(`${base}/api/setup/openrouter/connect`, { method: "POST", headers: authedHeaders, body: JSON.stringify({ confirm: true }) });
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await connect();
      assert.equal(res.status, 200);
      ids.push((await res.json()).flowId);
    }
    const fourth = await connect();
    assert.equal(fourth.status, 429);
    const body = await fourth.json();
    assert.equal(body.error, "too_many_flows");
    assert.match(body.message, /Too many sign-ins/);

    const del = await fetch(`${base}/api/setup/openrouter/connect/${ids[0]}`, { method: "DELETE", headers: authedHeaders });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).status, "cancelled");
    assert.equal((await connect()).status, 200);

    assert.equal((await fetch(`${base}/api/setup/openrouter/connect/not-a-flow`, { headers: authedHeaders })).status, 400);
    assert.equal((await fetch(`${base}/api/setup/openrouter/connect/${"a".repeat(32)}`, { headers: authedHeaders })).status, 404);
  });
});

test("gate: the setup API still needs the session; the callback and the start address (exact shapes only) do not", async () => {
  await withApp(async ({ base }) => {
    const noSession = await fetch(`${base}/api/setup/openrouter/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(noSession.status, 401);
    assert.equal((await fetch(`${base}/api/setup/openrouter/connect/${"a".repeat(32)}`)).status, 401);

    // No cookie, no token: the callback reaches its handler (a 400 "can't be used", not a 401).
    const cookieless = await fetch(callbackUrl(base, { code: "x", state: "y" }));
    assert.equal(cookieless.status, 400);
    assert.match(await cookieless.text(), /can't be used/);
    // The start address with a made-up nonce also reaches ITS handler.
    assert.equal((await fetch(`${base}/oauth/openrouter/start/${"b".repeat(64)}`)).status, 400);

    // Exactly these paths and methods: everything else under /oauth/ is gated.
    assert.equal((await fetch(`${base}/oauth/openrouter/callback`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/oauth/other/callback`)).status, 401);
    assert.equal((await fetch(`${base}/oauth/openrouter/start/${"b".repeat(63)}`)).status, 401, "nonce too short");
    assert.equal((await fetch(`${base}/oauth/openrouter/start/${"B".repeat(64)}`)).status, 401, "capital letters in the nonce");
    assert.equal((await fetch(`${base}/oauth/openrouter/start/${"b".repeat(64)}/extra`)).status, 401);
    assert.equal((await fetch(`${base}/oauth/openrouter/start/${"b".repeat(64)}`, { method: "POST" })).status, 401);
  });
});

for (const caseSensitive of [true, false]) {
  test(`gate: changing the letter case of a protected path can't skip the session (case-sensitive routing ${caseSensitive ? "on" : "off, Express's old default"})`, async () => {
    await withApp(
      async ({ base }) => {
        const post = (path) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
        assert.equal((await post("/API/setup/configure")).status, 401);
        assert.equal((await post("/Api/Setup/configure")).status, 401);
        assert.equal((await fetch(`${base}/Api/Setup/check`)).status, 401);
        assert.equal((await fetch(`${base}/API/setup/check`)).status, 401);
        assert.equal((await fetch(`${base}/API/runs`)).status, 401);
        assert.equal((await fetch(`${base}/oauth/openrouter/CALLBACK?code=x&state=y`)).status, 401);
        // A different case of the real callback path is not the callback exemption.
        assert.equal((await fetch(`${base}/OAUTH/openrouter/callback?code=x&state=y`)).status, 401);
        assert.equal((await fetch(`${base}/OAuth/openrouter/start/${"b".repeat(64)}`)).status, 401);
        // The real, lower-case callback still works without a session.
        assert.equal((await fetch(callbackUrl(base, { code: "x", state: "y" }))).status, 400);
        // And with the session, the lower-case API works as before.
        assert.equal((await fetch(`${base}/api/runs`, { headers: authedHeaders })).status, 200);
      },
      { caseSensitive }
    );
  });
}

function statusWithHost(port, host, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathAndQuery, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

test("routes: a bad Host header is refused on the callback and the start address (the host allow-list still applies)", async () => {
  await withApp(async ({ port }) => {
    assert.equal(await statusWithHost(port, "evil.example", "/oauth/openrouter/callback?code=a&state=b"), 403);
    assert.equal(await statusWithHost(port, "evil.example", `/oauth/openrouter/start/${"c".repeat(64)}`), 403);
    // The legitimate hosts reach them (no params = the "cancelled" page).
    assert.equal(await statusWithHost(port, `localhost:${port}`, "/oauth/openrouter/callback"), 200);
    assert.equal(await statusWithHost(port, `127.0.0.1:${port}`, "/oauth/openrouter/callback"), 200);
  });
});

test("callback rate limit: 20 a minute for requests that are NOT a real return trip; a real callback is never refused", async () => {
  let now = 5_000_000;
  setClockForTest(() => now);
  await withApp(async ({ base, port }) => {
    const { flowId, authUrl } = startFlow({ port });
    const real = await authorize(authUrl);
    assert.equal(hasWaitingFlowForState(real.state), true);
    assert.equal(hasWaitingFlowForState("nope"), false);

    for (let i = 0; i < 20; i += 1) {
      assert.equal((await fetch(callbackUrl(base, { code: "x", state: "y" }))).status, 400);
    }
    assert.equal((await fetch(callbackUrl(base, { code: "x", state: "y" }))).status, 429);
    // Junk that happens to be hammering the address can't make the real
    // return trip fail: its state is looked up first and it skips the limit.
    const genuine = await fetch(callbackUrl(base, { code: real.code, state: real.state }), {
      headers: { cookie: `agent_os_openrouter_${port}=${real.cookie}` }
    });
    assert.equal(genuine.status, 200);
    assert.equal(getStatus(flowId).status, "connected");

    // After a minute the limit resets for everyone else too.
    now += 61 * 1000;
    assert.equal((await fetch(callbackUrl(base, { code: "x", state: "y" }))).status, 400);
  });
});

test("routes: configure with a sign-in needs a valid, connected flow id; connect is refused outside local mode", async () => {
  setBrowserOpenerForTest(() => ({ opened: true }));
  await withApp(async ({ base }) => {
    const configure = (keySource) =>
      fetch(`${base}/api/setup/configure`, {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({ confirm: true, targets: { hermes: { mode: "openrouter", model: "free/big-70b" } }, keySource })
      });
    assert.equal((await configure({ flowId: "../etc" })).status, 400);
    assert.equal((await configure(undefined)).status, 400, "no key of any kind");
    const { flowId } = startFlow({ port: 4010 });
    const waiting = await configure({ flowId });
    assert.equal(waiting.status, 409);
    assert.equal((await waiting.json()).error, "connection_not_ready");

    setEnv({ HERMES_AGENT_OS_PUBLIC_MODE: "1" });
    const publicMode = await fetch(`${base}/api/setup/openrouter/connect`, { method: "POST", headers: authedHeaders, body: JSON.stringify({ confirm: true }) });
    assert.equal(publicMode.status, 400);
    assert.equal((await publicMode.json()).error, "not_available_here");
  });
});

// ---- 8. the mirror and the browser opener --------------------------------------------------------------

test("mirrorOrigin()/applyMirror(): only a plain http://127.0.0.1:<port> is honoured (no credentials, no path)", () => {
  const original = "https://openrouter.ai/api/v1/models";
  for (const good of ["http://127.0.0.1:4321", "http://127.0.0.1:4321/", "http://127.0.0.1:8080"]) {
    setEnv({ AGENT_OS_SETUP_MIRROR: good });
    assert.equal(mirrorOrigin(), new URL(good).origin, good);
    assert.equal(applyMirror(original), `${new URL(good).origin}/openrouter.ai/api/v1/models`, good);
  }
  const bad = [
    "http://127.0.0.1:1@evil.example", // a prefix test would accept this; it really points at evil.example
    "http://user:pw@127.0.0.1:1234",
    "http://127.0.0.1:1234/some/path",
    "http://127.0.0.1:1234?x=1",
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://evil.example:1234",
    "http://127.0.0.2:1234",
    "127.0.0.1:1234",
    "not a url",
    "http://127.0.0.1:1234\\@evil.example"
  ];
  for (const value of bad) {
    setEnv({ AGENT_OS_SETUP_MIRROR: value });
    assert.equal(mirrorOrigin(), null, value);
    assert.equal(applyMirror(original), original, `${value}: must fall back to the real address`);
  }
  setEnv({ AGENT_OS_SETUP_MIRROR: undefined });
  assert.equal(mirrorOrigin(), null);
  assert.equal(applyMirror(original), original);
});

test("openSystemBrowser(): runs the OS opener with a plain argument list (no shell) and only for OpenRouter or this server's own start address", async () => {
  setEnv({ AGENT_OS_SETUP_MIRROR: undefined });
  setServerPort(43210);
  const nonce = "d".repeat(64);
  const own = `http://localhost:43210/oauth/openrouter/start/${nonce}`;
  const openrouter = "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A1%2Fx&state=a%26b";
  for (const url of [own, openrouter]) {
    for (const [platform, command, args] of [
      ["darwin", "open", [url]],
      ["linux", "xdg-open", [url]],
      ["win32", "rundll32", ["url.dll,FileProtocolHandler", url]]
    ]) {
      const calls = [];
      const spawnFn = (cmd, argv, options) => {
        calls.push({ cmd, argv, options });
        return fakeChild("spawn");
      };
      assert.deepEqual(await openSystemBrowser(url, { spawnFn, platform }), { opened: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, command);
      assert.deepEqual(calls[0].argv, args, "the URL must be ONE argument, untouched");
      assert.equal(calls[0].options.shell, false);
      assert.equal(calls[0].options.stdio, "ignore");
    }
  }

  const refused = [
    "http://openrouter.ai/auth",
    "https://openrouter.ai.evil.example/auth",
    "https://evil.example/https://openrouter.ai/",
    "https://openrouter.ai@evil.example/",
    "https://user:pw@openrouter.ai/auth",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "-a Calculator",
    "https://openrouter.ai/auth; rm -rf ~",
    "https://openrouter.ai/auth\n--evil",
    // Local, but not exactly this server's start address:
    `http://localhost:43211/oauth/openrouter/start/${nonce}`, // another port
    `http://localhost:43210/oauth/openrouter/start/${"d".repeat(63)}`,
    `http://localhost:43210/oauth/openrouter/start/${nonce}?x=1`,
    "http://localhost:43210/oauth/openrouter/callback",
    "http://localhost:43210/api/setup/check",
    `http://evil.example:43210/oauth/openrouter/start/${nonce}`,
    `https://localhost:43210/oauth/openrouter/start/${nonce}`,
    `http://user:pw@localhost:43210/oauth/openrouter/start/${nonce}`,
    "",
    undefined
  ];
  for (const bad of refused) {
    let spawned = false;
    const spawnFn = () => {
      spawned = true;
      return fakeChild("spawn");
    };
    assert.deepEqual(await openSystemBrowser(bad, { spawnFn, platform: "darwin" }), { opened: false, reason: "blocked_url" }, String(bad));
    assert.equal(spawned, false, `spawned for ${bad}`);
  }

  // Until the server knows its port, not even a local start address is allowed.
  setServerPort(0);
  assert.deepEqual(await openSystemBrowser(own, { spawnFn: () => fakeChild("spawn"), platform: "linux" }), { opened: false, reason: "blocked_url" });
  setServerPort(43210);

  // The test mirror is allowed only when it is a valid one (see mirrorOrigin).
  setEnv({ AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${fakePort}` });
  let mirrorCall = null;
  const spawnOk = (cmd, argv) => {
    mirrorCall = { cmd, argv };
    return fakeChild("spawn");
  };
  assert.deepEqual(await openSystemBrowser(`http://127.0.0.1:${fakePort}/openrouter.ai/auth?x=1`, { spawnFn: spawnOk, platform: "linux" }), { opened: true });
  assert.equal(mirrorCall.cmd, "xdg-open");
  assert.deepEqual(await openSystemBrowser("http://127.0.0.1:9/openrouter.ai/auth", { spawnFn: spawnOk, platform: "linux" }), { opened: false, reason: "blocked_url" });
  // A mirror value that only LOOKS like loopback must not let its real host through.
  setEnv({ AGENT_OS_SETUP_MIRROR: "http://127.0.0.1:1@evil.example" });
  assert.deepEqual(await openSystemBrowser("http://evil.example/", { spawnFn: spawnOk, platform: "linux" }), { opened: false, reason: "blocked_url" });
  assert.deepEqual(await openSystemBrowser("http://127.0.0.1:1@evil.example/x", { spawnFn: spawnOk, platform: "linux" }), { opened: false, reason: "blocked_url" });

  // A missing opener (a headless machine) is a result, never an exception.
  setEnv({ AGENT_OS_SETUP_MIRROR: undefined });
  assert.deepEqual(await openSystemBrowser(openrouter, { spawnFn: () => fakeChild("error"), platform: "linux" }), { opened: false, reason: "spawn_failed" });
  const throwing = () => {
    throw new Error("boom");
  };
  assert.deepEqual(await openSystemBrowser(openrouter, { spawnFn: throwing, platform: "linux" }), { opened: false, reason: "spawn_failed" });
});

test("renderCallbackPage(): fixed text only, with a script that strips the query from the address bar", () => {
  const page = renderCallbackPage("connected");
  assert.match(page, /Connected to OpenRouter\./);
  assert.match(page, /history\.replaceState/);
  assert.ok(!/<script[^>]*src=/i.test(page), "no external scripts");
  assert.match(renderCallbackPage("invalid"), /can't be used/);
  assert.match(renderCallbackPage("startUsed"), /already opened/);
  assert.match(renderCallbackPage("something-unknown"), /Couldn't finish connecting/);
  for (const kind of ["cancelled", "expired", "failed"]) assert.ok(renderCallbackPage(kind).includes(KEY_TIP), `${kind} page says where to delete a stray key`);
});
