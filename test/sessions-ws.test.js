// The sessions WebSocket (SP3, Task S9): /api/sessions/:id/attach.
//
//   1. In process: checkUpgradeRequest and parseClientFrame, the pure checks,
//      case by case.
//   2. Child process: the real server with Task W1's fake agents, driven with
//      the `ws` client the way a browser or a hostile page would: every
//      Security 1 case, then the frame protocol end to end (writer and
//      viewers, resize, seq and ack, back-pressure, limits, terminal queries,
//      alerts and state, reattach), with the server half of Review Focus
//      items 2 (one input frame over 64 KB) and 3 (two windows, one slow).
//   3. The dev wiring: the Vite proxy carries upgrades, and only `npm run dev`
//      sets the dev flag.
// Temp HOME and AGENT_OS_HOME only; W1's six fake agents are written into the
// temp home, and the server's SHELL is W1's stand-in login shell. Never a real
// agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { cookieNameFor, sessionToken } from "../server/runtime/local-session.js";
import { PAUSED_DROP_MS, PAUSE_LAG_BYTES, createSessionManager } from "../server/runtime/sessions/manager.js";
import {
  CLOSE_CODES,
  MAX_CLIENT_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  allowedOrigins,
  attachSessionsUpgrade,
  checkUpgradeRequest,
  parseClientFrame
} from "../server/runtime/sessions/ws.js";
import { FAKE_AGENT_NAMES, FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const SKIP_POSIX = isWindows ? "POSIX only: W1's fake agents and stand-in login shell are sh scripts" : false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 10000, what = "a condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(25);
  }
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The pure checks
// ---------------------------------------------------------------------------

const PORT = 8123;
const ID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
// Local mode, no dev flag, no extra hosts.
const CLEAN = {
  DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
  HERMES_AGENT_OS_PUBLIC_MODE: undefined,
  AGENT_OS_DEV_ORIGIN: undefined,
  AGENT_OS_PACKAGED: undefined,
  NODE_ENV: undefined,
  AGENT_OS_ALLOWED_HOSTS: undefined
};

// A correct upgrade request for session ID on PORT; `over` replaces parts.
function upgradeRequest(over = {}) {
  const { headers: headerOver = {}, ...rest } = over;
  const headers = {
    host: `127.0.0.1:${PORT}`,
    origin: `http://127.0.0.1:${PORT}`,
    cookie: `${cookieNameFor(PORT)}=${encodeURIComponent(sessionToken)}`,
    upgrade: "websocket",
    connection: "Upgrade",
    ...headerOver
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete headers[key];
  }
  return { method: "GET", url: `/api/sessions/${ID}/attach`, headers, ...rest };
}

const check = (over, port = PORT) => checkUpgradeRequest(upgradeRequest(over), { port });
const frame = (text) => parseClientFrame(Buffer.from(text, "utf8"), false);

test("checkUpgradeRequest: a correct attach passes and names the session", async () => {
  await withEnv(CLEAN, async () => {
    assert.deepEqual(check(), { ok: true, sessionId: ID });
    assert.deepEqual(check({ headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` } }), {
      ok: true,
      sessionId: ID
    });
    assert.deepEqual(check({ headers: { host: `[::1]:${PORT}` } }), { ok: true, sessionId: ID });
    const among = `theme=dark; ${cookieNameFor(PORT)}=${encodeURIComponent(sessionToken)}; other=1`;
    assert.deepEqual(check({ headers: { cookie: among } }), { ok: true, sessionId: ID });
  });
});

test("checkUpgradeRequest: anything but a GET websocket upgrade is refused", async () => {
  await withEnv(CLEAN, async () => {
    assert.deepEqual(check({ method: "POST" }), { ok: false, reason: "method" });
    assert.deepEqual(check({ headers: { upgrade: "h2c" } }), { ok: false, reason: "upgrade" });
    assert.deepEqual(check({ headers: { upgrade: undefined } }), { ok: false, reason: "upgrade" });
  });
});

test("checkUpgradeRequest: outside local mode every upgrade is refused", async () => {
  for (const vars of [
    { DEMO_PUBLIC: "1" },
    { HERMES_AGENT_OS_DEMO_PUBLIC: "true" },
    { HERMES_AGENT_OS_REQUIRE_AUTH: "1" },
    { HERMES_AGENT_OS_PUBLIC_MODE: "1" }
  ]) {
    await withEnv({ ...CLEAN, ...vars }, async () => {
      assert.deepEqual(check(), { ok: false, reason: "mode" }, JSON.stringify(vars));
    });
  }
});

test("checkUpgradeRequest: the path is checked lower-cased and exactly, with no query string", async () => {
  await withEnv(CLEAN, async () => {
    for (const url of [
      `/API/sessions/${ID}/attach`,
      `/api/Sessions/${ID}/attach`,
      `/api/sessions/${ID}/ATTACH`,
      `/api/sessions/${ID.toUpperCase()}/attach`,
      `/api/sessions/${ID}/attach/`,
      `/api/sessions/${ID}/attach?token=abc`,
      `/api/sessions/${ID}/attach?`,
      `/api/sessions/${ID}/attach#x`,
      `//api/sessions/${ID}/attach`,
      `/api/sessions/${ID}/attach/more`,
      `/api/sessions/../${ID}/attach`,
      `/api/sessions/%33f2c9a7e-1b4d-4c8e-9f00-0123456789ab/attach`,
      "/api/sessions/not-a-uuid/attach",
      "/api/sessions/3f2c9a7e-1b4d-1c8e-9f00-0123456789ab/attach",
      "/api/runs",
      "/"
    ]) {
      assert.deepEqual(check({ url }), { ok: false, reason: "path" }, url);
    }
  });
});

test("checkUpgradeRequest: Host must be allowed and carry the port this server is bound to", async () => {
  await withEnv(CLEAN, async () => {
    for (const host of [
      undefined,
      `evil.example:${PORT}`,
      "127.0.0.1",
      "localhost",
      `127.0.0.1:${PORT + 1}`,
      `127.0.0.1:0${PORT}`,
      "::1"
    ]) {
      assert.deepEqual(check({ headers: { host } }), { ok: false, reason: "host" }, String(host));
    }
    assert.deepEqual(check({}, 0), { ok: false, reason: "host" }, "not listening yet");
  });
  // An extra allowed host passes the Host check, but the Origin list stays
  // the two loopback names.
  await withEnv({ ...CLEAN, AGENT_OS_ALLOWED_HOSTS: "agentos.test" }, async () => {
    assert.deepEqual(
      check({ headers: { host: `agentos.test:${PORT}`, origin: `http://agentos.test:${PORT}` } }),
      { ok: false, reason: "origin" }
    );
  });
});

test("checkUpgradeRequest: Origin is required and must match exactly", async () => {
  await withEnv(CLEAN, async () => {
    for (const origin of [
      undefined,
      `http://127.0.0.1:${PORT + 1}`,
      `http://localhost:${PORT + 1}`,
      "https://evil.example",
      `http://127.0.0.1:${PORT}/`,
      "null",
      `http://[::1]:${PORT}`,
      `https://127.0.0.1:${PORT}`,
      `HTTP://127.0.0.1:${PORT}`,
      `http://127.0.0.1.evil.example:${PORT}`
    ]) {
      assert.deepEqual(check({ headers: { origin } }), { ok: false, reason: "origin" }, String(origin));
    }
  });
});

test("checkUpgradeRequest: the Vite dev origin needs AGENT_OS_DEV_ORIGIN=1 and never works in a production or packaged run", async () => {
  const dev = ["http://127.0.0.1:5173", "http://localhost:5173"];
  await withEnv(CLEAN, async () => {
    for (const origin of dev) assert.deepEqual(check({ headers: { origin } }), { ok: false, reason: "origin" }, origin);
  });
  await withEnv({ ...CLEAN, AGENT_OS_DEV_ORIGIN: "1" }, async () => {
    for (const origin of dev) assert.deepEqual(check({ headers: { origin } }), { ok: true, sessionId: ID }, origin);
  });
  for (const vars of [
    { AGENT_OS_DEV_ORIGIN: "true" },
    { AGENT_OS_DEV_ORIGIN: "1", AGENT_OS_PACKAGED: "1" },
    { AGENT_OS_DEV_ORIGIN: "1", NODE_ENV: "production" }
  ]) {
    await withEnv({ ...CLEAN, ...vars }, async () => {
      for (const origin of dev) {
        assert.deepEqual(check({ headers: { origin } }), { ok: false, reason: "origin" }, `${JSON.stringify(vars)} ${origin}`);
      }
    });
  }
  assert.deepEqual(allowedOrigins(PORT, {}), [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  assert.deepEqual(allowedOrigins(PORT, { AGENT_OS_DEV_ORIGIN: "1" }), [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    ...dev
  ]);
});

test("checkUpgradeRequest: the session cookie for this port is required and compared exactly, in constant time", async (t) => {
  await withEnv(CLEAN, async () => {
    const name = cookieNameFor(PORT);
    for (const [label, headers] of [
      ["no cookie", { cookie: undefined }],
      ["a wrong value", { cookie: `${name}=not-the-token` }],
      ["another port's cookie", { cookie: `${cookieNameFor(PORT + 1)}=${encodeURIComponent(sessionToken)}` }],
      ["one character more", { cookie: `${name}=${encodeURIComponent(sessionToken)}x` }],
      ["not valid percent-encoding", { cookie: `${name}=%E0%A4%A` }],
      ["the token in a header instead", { cookie: undefined, "x-agent-os-token": sessionToken }]
    ]) {
      assert.deepEqual(check({ headers }), { ok: false, reason: "cookie" }, label);
    }

    // Security 1: the comparison is crypto.timingSafeEqual (ws.js imports the
    // same `crypto` object), never `===`. The spy calls through to the real
    // function and is removed when this test ends.
    const spy = t.mock.method(crypto, "timingSafeEqual");
    assert.deepEqual(check(), { ok: true, sessionId: ID });
    assert.equal(spy.mock.callCount(), 1, "the cookie is compared with crypto.timingSafeEqual");
    // The token with its last character changed: same length, wrong value.
    const sameLength = sessionToken.slice(0, -1) + (sessionToken.endsWith("0") ? "1" : "0");
    assert.equal(Buffer.byteLength(sameLength), Buffer.byteLength(sessionToken));
    assert.deepEqual(check({ headers: { cookie: `${name}=${encodeURIComponent(sameLength)}` } }), {
      ok: false,
      reason: "cookie"
    });
    assert.equal(spy.mock.callCount(), 2, "a same-length wrong token is compared the same way");
  });
});

test("checkUpgradeRequest: a session cookie sent twice is read like the REST gate reads it, the last one winning", async () => {
  await withEnv(CLEAN, async () => {
    const name = cookieNameFor(PORT);
    const real = `${name}=${encodeURIComponent(sessionToken)}`;
    // Another local page can set a cookie of the same name (cookies do not
    // keep ports apart, and a longer path is sent first). The REST gate takes
    // the last value, so the terminal must too: with the first-wins rule the
    // terminal was refused while every REST call worked.
    assert.deepEqual(check({ headers: { cookie: `${name}=stray; ${real}` } }), { ok: true, sessionId: ID }, "stray first");
    assert.deepEqual(
      check({ headers: { cookie: `${name}=stray; theme=dark; ${real}; other=1` } }),
      { ok: true, sessionId: ID },
      "stray first, other cookies around"
    );
    assert.deepEqual(check({ headers: { cookie: `${real}; ${name}=stray` } }), { ok: false, reason: "cookie" }, "stray last");
    assert.deepEqual(check({ headers: { cookie: `${real}; ${name}=` } }), { ok: false, reason: "cookie" }, "empty last");
  });
});

test("parseClientFrame: the four client frames, in bounds, and nothing else", () => {
  assert.equal(MAX_PAYLOAD_BYTES, 1024 * 1024);
  assert.equal(MAX_CLIENT_FRAME_BYTES, 64 * 1024);
  assert.deepEqual(CLOSE_CODES, { too_far_behind: 4000, session_ended: 4001, attach_failed: 4004 });

  assert.deepEqual(frame('{"t":"focus"}'), { t: "focus" });
  assert.deepEqual(frame('{"t":"in","d":"ls\\r"}'), { t: "in", d: "ls\r" });
  assert.deepEqual(frame('{"t":"resize","cols":120,"rows":32}'), { t: "resize", cols: 120, rows: 32 });
  assert.deepEqual(frame('{"t":"resize","cols":2,"rows":1}'), { t: "resize", cols: 2, rows: 1 });
  assert.deepEqual(frame('{"t":"resize","cols":500,"rows":200}'), { t: "resize", cols: 500, rows: 200 });
  assert.deepEqual(frame('{"t":"ack","seq":4096}'), { t: "ack", seq: 4096 });
  assert.deepEqual(frame('{"t":"ack","seq":0}'), { t: "ack", seq: 0 });

  for (const text of [
    '{"t":"resize","cols":1,"rows":24}',
    '{"t":"resize","cols":501,"rows":24}',
    '{"t":"resize","cols":80,"rows":0}',
    '{"t":"resize","cols":80,"rows":201}',
    '{"t":"resize","cols":80.5,"rows":24}',
    '{"t":"resize","cols":"80","rows":"24"}',
    '{"t":"ack","seq":-1}',
    '{"t":"ack","seq":1.5}',
    '{"t":"ack","seq":"10"}',
    '{"t":"in","d":""}',
    '{"t":"in","d":5}',
    '{"t":"in"}',
    '{"t":"snapshot","data":""}',
    '{"t":"nope"}',
    "[]",
    "null",
    '"focus"',
    "not json"
  ]) {
    assert.equal(frame(text), null, text);
  }
  assert.equal(parseClientFrame(Buffer.from('{"t":"focus"}'), true), null, "binary frames are ignored");

  // The 64 KB limit is on the whole frame as sent, in bytes (R12).
  const prefix = '{"t":"in","d":"';
  const suffix = '"}';
  const fits = `${prefix}${"a".repeat(MAX_CLIENT_FRAME_BYTES - prefix.length - suffix.length)}${suffix}`;
  assert.equal(Buffer.byteLength(fits), MAX_CLIENT_FRAME_BYTES);
  assert.equal(frame(fits)?.t, "in");
  const tooBig = `${prefix}${"a".repeat(MAX_CLIENT_FRAME_BYTES - prefix.length - suffix.length + 1)}${suffix}`;
  assert.equal(frame(tooBig), null);
  // Bytes, not characters: 33,000 "é" are fewer than 64 K characters but
  // more than 64 KB.
  const accents = JSON.stringify({ t: "in", d: "é".repeat(33000) });
  assert.ok(accents.length < MAX_CLIENT_FRAME_BYTES && Buffer.byteLength(accents) > MAX_CLIENT_FRAME_BYTES);
  assert.equal(frame(accents), null);
});

// ---------------------------------------------------------------------------
// 2. The real server, driven with the ws client
// ---------------------------------------------------------------------------

const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const TOKEN = "test-token-123";

// A temp HOME (its realpath) with a "project" folder and, on POSIX, Task W1's
// six fake agents in <home>/fake-bin (all six names, R16, so detection never
// finds a real agent in a fixed folder first). The tests start the fake
// `claude`: it answers the detection probes and `agents --json` at once; as a
// session it prints FAKE_ARGV and a prompt, echoes what is typed, and runs
// the typed commands these tests use: flood, ask, ask after, alt, paste,
// bell, osc9 ("you said: <line>" for anything else). It lives under
// os.tmpdir() and test/, which the no-real-agents watcher allows.
async function makeHome(prefix) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  await mkdir(path.join(home, "project"), { recursive: true });
  if (!isWindows) await makeFakeAgentBin(path.join(home, "fake-bin"), { names: FAKE_AGENT_NAMES });
  return home;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Never passed on to the server unless a test sets one on purpose.
// AGENT_OS_PORT would win over PORT (Task S8 reads it first).
const CLEARED_KEYS = [
  "AGENT_OS_PORT",
  // The desktop app sets it, and the login shell would give sessions that PATH
  // in place of the fake folder + system folders this file passes.
  "AGENT_OS_LAUNCH_PATH",
  "HERMES_HOME",
  "HERMES_AGENT_OS_HOME",
  // Detection searches it before PATH (R16).
  "HERMES_AGENT_OS_EXECUTABLE_PATHS",
  "DEMO_PUBLIC",
  "HERMES_AGENT_OS_DEMO_PUBLIC",
  "HERMES_AGENT_OS_PUBLIC_MODE",
  "HERMES_AGENT_OS_REQUIRE_AUTH",
  "HERMES_AGENT_OS_ADMIN_TOKEN",
  "HERMES_AGENT_OS_ENABLE_EXEC",
  "AGENT_OS_LIVE_CHAT",
  "AGENT_OS_DEV_ORIGIN",
  "AGENT_OS_PACKAGED",
  "AGENT_OS_STDIN_SHUTDOWN",
  "AGENT_OS_ALLOWED_HOSTS",
  "FAKE_AGENT_MODE",
  "NODE_ENV",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT"
];

function serverEnv(home, port, extra = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    HOME: home,
    USERPROFILE: home,
    AGENT_OS_HOME: path.join(home, ".hermes-agent-os"),
    AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
    AGENT_OS_TOKEN: TOKEN,
    HERMES_AGENT_OS_SCHEDULER: "0",
    // The login shell sessions read their environment from: W1's stand-in
    // (R15), which keeps the PATH below. Never the developer's own shell
    // setup, and never a real login sh either: on macOS it runs path_helper,
    // which puts /usr/local/bin and /opt/homebrew/bin (where real agents live)
    // on the sessions' PATH.
    SHELL: FAKE_LOGIN_SHELL,
    // The fake folder first, then system folders only (R16; not Node's own
    // folder, which can hold real agents).
    ...(isWindows ? {} : { PATH: [path.join(home, "fake-bin"), ...SYSTEM_PATH_DIRS].join(path.delimiter) })
  };
  for (const key of CLEARED_KEYS) {
    if (!(key in extra)) delete env[key];
  }
  return { ...env, ...extra };
}

async function startServer(home, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: serverEnv(home, port, extra),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = { text: "" };
  child.stdout.on("data", (chunk) => {
    logs.text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs.text += chunk;
  });
  const deadline = Date.now() + 20000;
  while (!/AGENT_OS_READY:\d+/.test(logs.text)) {
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode}):\n${logs.text.slice(-2000)}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server did not start:\n${logs.text.slice(-2000)}`);
    }
    await delay(25);
  }
  return { child, port, logs };
}

// SIGTERM, then up to 10 s (the server's own hard exit is 8 s), then SIGKILL.
async function stopServer(server) {
  const { child } = server;
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function api(port, method, url, body) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

async function gateOn(port) {
  const gate = await api(port, "POST", "/api/admin/execution-gate", { enabled: true, confirm: true });
  assert.equal(gate.status, 200, gate.text);
}

async function createSession(port, home) {
  const created = await api(port, "POST", "/api/sessions", { agentId: "claude", folder: path.join(home, "project") });
  assert.equal(created.status, 201, created.text);
  return created.json.id;
}

async function stopSession(port, id) {
  await api(port, "POST", `/api/sessions/${id}/stop`, {}).catch(() => {});
}

const ownOrigin = (port) => `http://127.0.0.1:${port}`;
const attachPath = (id) => `/api/sessions/${id}/attach`;
const cookieFor = (port) => `${cookieNameFor(port)}=${encodeURIComponent(TOKEN)}`;

// Everything one socket received, for the assertions below.
function trackClient(ws) {
  const client = {
    ws,
    frames: [],
    outText: "",
    outBytes: 0,
    lastSeq: 0,
    autoAck: false,
    closed: null,
    closedAt: null,
    lastFrameAt: Date.now(),
    send(value) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
    },
    ack() {
      client.send({ t: "ack", seq: client.lastSeq });
    },
    // The snapshot's screen plus every output since, as one text.
    screen() {
      const snapshot = client.frames.find((item) => item.t === "snapshot");
      return `${snapshot ? snapshot.data : ""}${client.outText}`;
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  };
  ws.on("message", (data) => {
    let value;
    try {
      value = JSON.parse(String(data));
    } catch {
      return;
    }
    client.frames.push(value);
    client.lastFrameAt = Date.now();
    if (value.t === "out") {
      client.outText += value.d;
      client.outBytes += Buffer.byteLength(value.d, "utf8");
      client.lastSeq = value.seq;
      if (client.autoAck) client.ack();
    }
  });
  ws.on("close", (code, reason) => {
    client.closed = { code, reason: String(reason) };
    client.closedAt = Date.now();
  });
  ws.on("error", () => {});
  return client;
}

// One upgrade attempt: { opened: true, client } or { opened: false, error }.
function tryUpgrade(port, urlPath, { origin, cookie, host, headers = {} } = {}) {
  return new Promise((resolve) => {
    const sent = { ...headers };
    if (cookie !== undefined) sent.Cookie = cookie;
    if (host !== undefined) sent.Host = host;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, {
      headers: sent,
      ...(origin === undefined ? {} : { origin }),
      handshakeTimeout: 5000
    });
    const client = trackClient(ws);
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    ws.once("open", () => finish({ opened: true, client }));
    ws.once("error", (error) => finish({ opened: false, error: String(error?.message || error) }));
    ws.once("close", () => finish({ opened: false, error: "closed before opening" }));
  });
}

function expectRefused(result, label) {
  if (result.opened) result.client.close();
  assert.equal(result.opened, false, `${label}: the upgrade should be refused`);
  assert.match(result.error, /Unexpected server response: 403/, `${label}: ${result.error}`);
}

// A window that is attached: its snapshot and its first state have arrived.
async function openClient(port, id, { origin = ownOrigin(port) } = {}) {
  const result = await tryUpgrade(port, attachPath(id), { origin, cookie: cookieFor(port) });
  assert.equal(result.opened, true, `the attach should open: ${result.error}`);
  const { client } = result;
  await waitFor(() => client.frames.some((item) => item.t === "state"), 5000, "the snapshot and state frames");
  assert.equal(client.frames[0].t, "snapshot", "the snapshot is always the first frame");
  return client;
}

async function waitForScreen(client, pattern, timeoutMs = 10000) {
  await waitFor(() => pattern.test(client.screen()), timeoutMs, `${pattern} on the screen`);
}

// Resolves once no listed socket has received a frame for quietMs.
async function waitQuiet(clients, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = Math.max(...clients.map((client) => client.lastFrameAt));
    if (Date.now() - last >= quietMs) return;
    if (Date.now() > deadline) throw new Error(`output never went quiet within ${timeoutMs} ms`);
    await delay(50);
  }
}

// A fresh server in a fresh temp home, prepared by `setup({ home, server })`
// (what it returns is merged into the result). If starting or a setup step
// throws, the server is stopped and the home removed before the error goes on:
// a before() hook that throws never runs after(), so nothing else would.
async function startPrepared(prefix, setup, extra = {}) {
  const home = await makeHome(prefix);
  let server = null;
  try {
    server = await startServer(home, extra);
    const more = await setup({ home, server });
    return { home, server, port: server.port, ...more };
  } catch (error) {
    if (server) await stopServer(server);
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

// A manager that only answers what the endpoint may ask. `get` and `list` read
// every meta.json and run agent detection, which a refused attach must not
// cause, so they are counted (and get() fails). `liveIds` are the sessions
// isLive says yes to; an accepted attach keeps the attachment, so a test can
// close it from the manager's side the way the real manager does.
function stubManager(liveIds = []) {
  const live = new Set(liveIds);
  const stub = {
    calls: { isLive: [], attach: [], detach: 0, get: 0, list: 0 },
    attachments: [],
    isLive(id) {
      stub.calls.isLive.push(id);
      return live.has(id);
    },
    async get() {
      stub.calls.get += 1;
      throw new Error("the attach endpoint must not call get()");
    },
    async list() {
      stub.calls.list += 1;
      return [];
    },
    async attach(id, attachment) {
      stub.calls.attach.push(id);
      stub.attachments.push(attachment);
      attachment.send({ t: "snapshot", data: "", cols: 80, rows: 24, modes: {} });
      attachment.send({ t: "state", status: "live" });
      return {
        snapshot: {},
        detach() {
          stub.calls.detach += 1;
        }
      };
    },
    focus() {},
    write() {},
    resize() {},
    ack() {}
  };
  return stub;
}

// The real upgrade listener (attachSessionsUpgrade) on a plain http server in
// this process, with the manager the test gives it. `good` is a request that
// is right in every Security 1 respect for this server (this process's own
// session token); the caller picks the environment with withEnv.
async function withEndpoint(manager, fn) {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  attachSessionsUpgrade(server, { getPort: () => server.address().port, manager });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const good = { origin: ownOrigin(port), cookie: `${cookieNameFor(port)}=${encodeURIComponent(sessionToken)}` };
  try {
    return await fn({ port, good });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a server started in the public demo answers an upgrade with 403 (the real process)", async () => {
  // This proves the wiring in a demo process (the listener is installed, the
  // server stays up). It does NOT prove the mode check: the id is unknown, so
  // it would be refused anyway. The next test proves the mode check.
  const home = await makeHome("agent-os-ws-demo-");
  const server = await startServer(home, { DEMO_PUBLIC: "1" });
  try {
    expectRefused(
      await tryUpgrade(server.port, attachPath(crypto.randomUUID()), {
        origin: ownOrigin(server.port),
        cookie: cookieFor(server.port)
      }),
      "demo mode"
    );
  } finally {
    await stopServer(server);
    await rm(home, { recursive: true, force: true });
  }
});

test("outside local mode an upgrade is refused even when it is right in every other way and the session is live", async () => {
  const id = crypto.randomUUID();
  const manager = stubManager([id]);
  await withEndpoint(manager, async ({ port, good }) => {
    // The control: this exact request, in local mode, opens. So the 403s below
    // can only come from the mode check; take isLocalMode() out of ws.js and
    // these fail with an open socket.
    await withEnv(CLEAN, async () => {
      const control = await tryUpgrade(port, attachPath(id), good);
      assert.equal(control.opened, true, `local mode should accept it: ${control.error}`);
      control.client.close();
      await waitFor(() => manager.calls.detach === 1, 5000, "the control window to detach");
    });
    const attachesBefore = manager.calls.attach.length;
    const askedBefore = manager.calls.isLive.length;
    for (const vars of [
      { DEMO_PUBLIC: "1" },
      { HERMES_AGENT_OS_DEMO_PUBLIC: "true" },
      { HERMES_AGENT_OS_REQUIRE_AUTH: "1" },
      { HERMES_AGENT_OS_PUBLIC_MODE: "1" }
    ]) {
      await withEnv({ ...CLEAN, ...vars }, async () => {
        expectRefused(await tryUpgrade(port, attachPath(id), good), JSON.stringify(vars));
      });
    }
    assert.equal(manager.calls.attach.length, attachesBefore, "no refused request reached the manager");
    assert.equal(manager.calls.isLive.length, askedBefore, "the mode is checked before the session is looked up");
  });
});

test("an attach to an ended or unknown session is refused from the live map: no disk scan, no agent detection", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-ws-light-")));
  const ended = crypto.randomUUID();
  const detections = [];
  try {
    await withEnv({ ...CLEAN, AGENT_OS_HOME: home }, async () => {
      // An ended session on disk, of the kind get() answers by probing the
      // agent's version (detection).
      const dir = path.join(home, "sessions", ended);
      await mkdir(dir, { recursive: true });
      const at = "2026-10-14T09:00:00.000Z";
      await writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify({
          version: 1,
          id: ended,
          kind: "agent",
          agentId: "claude",
          agentLabel: "Claude",
          folder: home,
          folderName: path.basename(home),
          folderShown: true,
          branch: null,
          status: "exited",
          createdAt: at,
          startedAt: at,
          endedAt: at,
          exitCode: 0,
          signal: null,
          endedBy: "stop",
          dismissed: false,
          brain: null,
          agentSessionId: null,
          resumeMode: null,
          resumes: 0,
          lastUsedAt: at
        })
      );
      const manager = createSessionManager({
        detect: async (agentId) => {
          detections.push(agentId);
          return { installed: true, path: "/fake/bin/claude" };
        }
      });
      // The control: get() on this ended session does run detection, so the
      // spy listens and the fixture is the right kind.
      assert.equal((await manager.get(ended)).status, "exited");
      assert.deepEqual(detections, ["claude"], "control: get() of an ended session runs detection");
      detections.length = 0;

      await withEndpoint(manager, async ({ port, good }) => {
        expectRefused(await tryUpgrade(port, attachPath(ended), good), "an ended session");
        expectRefused(await tryUpgrade(port, attachPath(crypto.randomUUID()), good), "an unknown session");
        expectRefused(await tryUpgrade(port, attachPath(ended), good), "an ended session, again");
      });
      assert.deepEqual(detections, [], "refused attaches ran no detection");
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a close reason the endpoint does not know closes the window with attach_failed (4004), never too_far_behind", async () => {
  const id = crypto.randomUUID();
  const manager = stubManager([id]);
  await withEnv(CLEAN, async () => {
    await withEndpoint(manager, async ({ port, good }) => {
      for (const [reason, code, word] of [
        ["too_far_behind", 4000, "too_far_behind"],
        ["session_ended", 4001, "session_ended"],
        ["attach_failed", 4004, "attach_failed"],
        // None of these is a reason this file knows: the page must not be
        // told to reattach at once for any of them.
        ["stopped", 4004, "attach_failed"],
        ["", 4004, "attach_failed"],
        [undefined, 4004, "attach_failed"],
        [4000, 4004, "attach_failed"],
        ["toString", 4004, "attach_failed"],
        ["__proto__", 4004, "attach_failed"]
      ]) {
        const attached = manager.attachments.length;
        const result = await tryUpgrade(port, attachPath(id), good);
        assert.equal(result.opened, true, `${String(reason)}: ${result.error}`);
        await waitFor(() => manager.attachments.length === attached + 1, 5000, "the window to attach");
        manager.attachments[attached].close(reason);
        const { client } = result;
        await waitFor(() => client.closed, 5000, `the close for ${String(reason)}`);
        assert.deepEqual(client.closed, { code, reason: word }, `a manager close reason of ${String(reason)}`);
        assert.equal(CLOSE_CODES[word], code);
      }
    });
  });
});

test("setup: a step that throws after the server started stops that server and removes its home", { skip: SKIP_POSIX }, async () => {
  let started = null;
  await assert.rejects(
    startPrepared("agent-os-ws-setup-", async ({ home, server }) => {
      started = { home, child: server.child };
      throw new Error("a setup step failed");
    }),
    /a setup step failed/
  );
  assert.ok(started, "the setup step ran, so the server had started");
  assert.ok(started.child.exitCode != null || started.child.signalCode != null, "the server it started was stopped");
  await assert.rejects(access(started.home), "the temp home was removed");
});

describe("the attach endpoint on a real server", { skip: SKIP_POSIX }, () => {
  let main = null;

  before(async () => {
    // If a step after the start throws, startPrepared stops the server before
    // the error goes on (a failed before() hook never runs after()).
    main = await startPrepared("agent-os-ws-", async ({ home, server }) => {
      await gateOn(server.port);
      return { securityId: await createSession(server.port, home) };
    });
  });

  after(async () => {
    if (!main) return;
    await stopSession(main.port, main.securityId);
    await stopServer(main.server);
    await rm(main.home, { recursive: true, force: true });
  });

  // A fresh session for one test; every window it opened is closed and the
  // session is stopped afterwards.
  async function withSession(fn) {
    const id = await createSession(main.port, main.home);
    const clients = [];
    const open = async () => {
      const client = await openClient(main.port, id);
      clients.push(client);
      return client;
    };
    try {
      await fn({ id, open });
    } finally {
      for (const client of clients) client.close();
      await stopSession(main.port, id);
    }
  }

  // -- Security 1 -----------------------------------------------------------

  test("a correct upgrade opens: the manager's snapshot comes first, then the state", async () => {
    const client = await openClient(main.port, main.securityId);
    try {
      const [snapshot, state] = client.frames;
      assert.equal(snapshot.t, "snapshot");
      assert.equal(typeof snapshot.data, "string");
      assert.ok(Number.isInteger(snapshot.cols) && Number.isInteger(snapshot.rows));
      assert.deepEqual(Object.keys(snapshot.modes).sort(), [
        "altScreen",
        "bracketedPaste",
        "cursorKeysApp",
        "focusReporting",
        "kittyFlags",
        "mouseEncoding",
        "mouseTracking"
      ]);
      assert.equal(state.t, "state");
      assert.ok(["starting", "live", "idle"].includes(state.status), state.status);
    } finally {
      client.close();
    }
    // The cookie the real login hands out works the same way.
    const claim = await fetch(`http://127.0.0.1:${main.port}/api/session/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN })
    });
    const cookie = (claim.headers.get("set-cookie") || "").split(";")[0];
    const viaClaim = await tryUpgrade(main.port, attachPath(main.securityId), { origin: ownOrigin(main.port), cookie });
    assert.equal(viaClaim.opened, true, viaClaim.error);
    viaClaim.client.close();
  });

  test("Origin: missing, foreign, another local port, a trailing slash, and the Vite dev page without the flag are refused", async () => {
    for (const [label, origin] of [
      ["no Origin", undefined],
      ["a foreign Origin", "https://evil.example"],
      ["127.0.0.1 on another port", `http://127.0.0.1:${main.port + 1}`],
      ["localhost on another port", `http://localhost:${main.port + 1}`],
      ["a trailing slash", `http://127.0.0.1:${main.port}/`],
      ["the Vite dev page without AGENT_OS_DEV_ORIGIN=1", "http://127.0.0.1:5173"]
    ]) {
      expectRefused(
        await tryUpgrade(main.port, attachPath(main.securityId), { origin, cookie: cookieFor(main.port) }),
        label
      );
    }
  });

  test("the path is checked lower-cased and may not carry a query string", async () => {
    const id = main.securityId;
    for (const urlPath of [
      `/API/sessions/${id}/attach`,
      `/api/Sessions/${id}/attach`,
      `/api/sessions/${id}/ATTACH`,
      `/api/sessions/${id.toUpperCase()}/attach`,
      `/api/sessions/${id}/attach/`,
      `/api/sessions/${id}/attach?token=${TOKEN}`
    ]) {
      expectRefused(
        await tryUpgrade(main.port, urlPath, { origin: ownOrigin(main.port), cookie: cookieFor(main.port) }),
        urlPath
      );
    }
  });

  test("the session cookie is required and must match", async () => {
    const origin = ownOrigin(main.port);
    for (const [label, options] of [
      ["no cookie", { origin }],
      ["a wrong cookie", { origin, cookie: `${cookieNameFor(main.port)}=not-the-token` }],
      ["the token under another port's cookie", { origin, cookie: `${cookieNameFor(main.port + 1)}=${encodeURIComponent(TOKEN)}` }],
      ["the token in the x-agent-os-token header instead", { origin, headers: { "x-agent-os-token": TOKEN } }],
      ["a cookie that is not valid percent-encoding", { origin, cookie: `${cookieNameFor(main.port)}=%E0%A4%A` }]
    ]) {
      expectRefused(await tryUpgrade(main.port, attachPath(main.securityId), options), label);
    }
    // The server is still up after the broken cookie.
    const fine = await openClient(main.port, main.securityId);
    fine.close();
  });

  test("a session cookie sent twice is read like the REST gate reads it: the last one wins, for REST and the terminal alike", async () => {
    const name = cookieNameFor(main.port);
    const real = `${name}=${encodeURIComponent(TOKEN)}`;
    const stray = `${name}=not-the-token`;
    const origin = ownOrigin(main.port);
    const restStatus = async (cookie) =>
      (await fetch(`http://127.0.0.1:${main.port}/api/sessions`, { headers: { Cookie: cookie } })).status;
    // A stray cookie of the same name sent first (another local page set it):
    // the REST gate accepts the header, and so must the terminal.
    assert.equal(await restStatus(`${stray}; ${real}`), 200, "REST takes the last value");
    const first = await tryUpgrade(main.port, attachPath(main.securityId), { origin, cookie: `${stray}; ${real}` });
    assert.equal(first.opened, true, `the terminal takes the last value too: ${first.error}`);
    first.client.close();
    // The stray one last: both refuse.
    assert.equal(await restStatus(`${real}; ${stray}`), 401, "REST takes the last value, the stray one");
    expectRefused(
      await tryUpgrade(main.port, attachPath(main.securityId), { origin, cookie: `${real}; ${stray}` }),
      "a stray cookie last"
    );
  });

  test("an unknown, malformed or ended session is refused like any other failure", async () => {
    const good = { origin: ownOrigin(main.port), cookie: cookieFor(main.port) };
    expectRefused(await tryUpgrade(main.port, attachPath(crypto.randomUUID()), good), "an unknown session id");
    expectRefused(await tryUpgrade(main.port, "/api/sessions/not-a-session/attach", good), "a malformed id");
    const ended = await createSession(main.port, main.home);
    await stopSession(main.port, ended);
    await waitFor(
      async () => (await api(main.port, "GET", `/api/sessions/${ended}`)).json?.status === "exited",
      15000,
      "the stopped session to end"
    );
    expectRefused(await tryUpgrade(main.port, attachPath(ended), good), "an ended session");
  });

  test("Host must be allowed and carry this server's port", async () => {
    const good = { origin: ownOrigin(main.port), cookie: cookieFor(main.port) };
    for (const [label, host] of [
      ["a forged Host", `evil.example:${main.port}`],
      ["a Host without a port", "127.0.0.1"],
      ["a Host with another port", `127.0.0.1:${main.port + 1}`]
    ]) {
      expectRefused(await tryUpgrade(main.port, attachPath(main.securityId), { ...good, host }), label);
    }
    const viaLocalhost = await tryUpgrade(main.port, attachPath(main.securityId), {
      host: `localhost:${main.port}`,
      origin: `http://localhost:${main.port}`,
      cookie: cookieFor(main.port)
    });
    assert.equal(viaLocalhost.opened, true, viaLocalhost.error);
    viaLocalhost.client.close();
  });

  test("any other upgrade address gets 403 and is never left hanging", async () => {
    for (const urlPath of ["/api/runs", "/", "/api/sessions"]) {
      expectRefused(
        await tryUpgrade(main.port, urlPath, { origin: ownOrigin(main.port), cookie: cookieFor(main.port) }),
        urlPath
      );
    }
  });

  // -- The frame protocol ---------------------------------------------------

  test("Review Focus 3, two windows: writer by focus, the viewer's keys are dropped, and the last focus wins", async () => {
    await withSession(async ({ open }) => {
      const a = await open();
      const b = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "in", d: "typed-before-focus\r" }); // nobody is the writer yet
      await delay(400);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "from-a\r" });
      await waitForScreen(b, /you said: from-a/);
      b.send({ t: "in", d: "viewer-b\r" }); // b is a viewer
      await delay(400);
      b.send({ t: "focus" });
      b.send({ t: "in", d: "from-b\r" });
      await waitForScreen(a, /you said: from-b/);
      a.send({ t: "in", d: "viewer-a\r" }); // a is a viewer now
      await delay(400);
      b.send({ t: "in", d: "marker\r" });
      await waitForScreen(a, /you said: marker/);
      for (const client of [a, b]) {
        assert.doesNotMatch(client.outText, /typed-before-focus/);
        assert.doesNotMatch(client.outText, /viewer-b/);
        assert.doesNotMatch(client.outText, /viewer-a/);
      }
    });
  });

  test("Review Focus 3, two windows: only the writer's resize reaches the terminal, and out-of-range sizes are ignored", async () => {
    await withSession(async ({ open }) => {
      const writer = await open();
      const viewer = await open();
      await waitForScreen(writer, /FAKE_ARGV/);
      // A new window's snapshot carries the terminal's size right now.
      const sizeNow = async () => {
        const probe = await open();
        const { cols, rows } = probe.frames[0];
        probe.close();
        return `${cols}x${rows}`;
      };
      const start = await sizeNow();
      writer.send({ t: "focus" });
      viewer.send({ t: "resize", cols: 77, rows: 22 });
      await delay(300);
      assert.equal(await sizeNow(), start, "a viewer's resize changes nothing");

      writer.send({ t: "resize", cols: 91, rows: 27 });
      await waitFor(async () => (await sizeNow()) === "91x27", 5000, "the writer's resize");

      for (const bad of [
        { cols: 1, rows: 27 },
        { cols: 501, rows: 27 },
        { cols: 91, rows: 0 },
        { cols: 91, rows: 201 },
        { cols: 90.5, rows: 27 },
        { cols: "80", rows: "24" }
      ]) {
        writer.send({ t: "resize", ...bad });
      }
      await delay(300);
      assert.equal(await sizeNow(), "91x27", "out-of-range sizes are ignored");
    });
  });

  test("seq is the running UTF-8 byte count of out frames, from 0 after each window's snapshot", async () => {
    await withSession(async ({ open }) => {
      const a = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "café ✓\r" });
      await waitForScreen(a, /you said: café ✓/);
      a.send({ t: "in", d: "flood 20\r" });
      await waitForScreen(a, /FLOOD DONE 20/, 15000);
      const counted = (client) => {
        let total = 0;
        for (const item of client.frames.filter((value) => value.t === "out")) {
          total += Buffer.byteLength(item.d, "utf8");
          assert.equal(item.seq, total, "seq is the running UTF-8 byte count");
        }
        return total;
      };
      assert.ok(counted(a) >= 20 * 1024);
      assert.ok(
        a.frames.some((item) => item.t === "out" && Buffer.byteLength(item.d, "utf8") > item.d.length),
        "multi-byte text counts bytes, not characters"
      );
      const b = await open();
      a.send({ t: "in", d: "after\r" });
      await waitForScreen(b, /you said: after/);
      assert.ok(counted(b) > 0, "a later window counts from 0 after its own snapshot");
    });
  });

  test("Review Focus 3, back-pressure: the terminal pauses only when every window lags, resumes when one catches up, and a window 4 MB behind is closed and reattaches with a fresh screen", async () => {
    await withSession(async ({ open }) => {
      const a = await open();
      const b = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "flood 2930\r" }); // about 3 MB
      await waitFor(() => a.outBytes > 100000, 15000, "the flood to start");
      await waitQuiet([a, b], 1500, 30000);
      assert.ok(a.outBytes >= PAUSE_LAG_BYTES, `paused too early: ${a.outBytes} bytes`);
      assert.ok(a.outBytes < 2930 * 1024, `never paused: ${a.outBytes} bytes`);
      assert.doesNotMatch(a.outText, /FLOOD DONE/);

      // One window catching up is enough to resume (long before the 10 s
      // paused limit).
      b.autoAck = true;
      b.ack();
      await waitForScreen(b, /FLOOD DONE 2930/, 60000);
      assert.equal(a.closed, null, "about 3 MB behind is under the 4 MB limit, so it stays open");

      // More than 4 MB behind: closed with a reason; the window that keeps up stays.
      a.send({ t: "in", d: "flood 1954\r" }); // about 2 MB more
      await waitFor(() => a.closed !== null, 60000, "the lagging window to be closed");
      assert.deepEqual(a.closed, { code: CLOSE_CODES.too_far_behind, reason: "too_far_behind" });
      await waitForScreen(b, /FLOOD DONE 1954/, 60000);
      assert.equal(b.closed, null);

      // The closed window's client attaches again and gets a fresh screen.
      const again = await open();
      assert.match(again.frames[0].data, /FLOOD DONE 1954/, "the new snapshot shows the latest screen");
    });
  });

  test("Review Focus 3, back-pressure: windows that never ack are closed once the terminal has been paused for 10 s, and the terminal runs on", async () => {
    await withSession(async ({ id, open }) => {
      const a = await open();
      const b = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "flood 2930\r" }); // about 3 MB: never 4 MB behind
      await waitFor(() => a.outBytes > 100000, 15000, "the flood to start");
      await waitQuiet([a, b], 1500, 30000);
      assert.ok(a.outBytes < 2930 * 1024, "paused while every window lags");
      assert.equal(a.closed, null);
      assert.equal(b.closed, null);
      const pausedBy = Math.max(a.lastFrameAt, b.lastFrameAt);

      // Neither window ever acks (a hidden window, an asleep second screen).
      await waitFor(() => a.closed !== null && b.closed !== null, PAUSED_DROP_MS + 15000, "both lagging windows to be closed");
      for (const client of [a, b]) {
        assert.deepEqual(client.closed, { code: CLOSE_CODES.too_far_behind, reason: "too_far_behind" });
        assert.ok(
          client.closedAt - pausedBy >= PAUSED_DROP_MS - 2000,
          `closed ${client.closedAt - pausedBy} ms after the pause, before the 10 s limit`
        );
      }

      // The agent is never left blocked on its own output: the flood finishes.
      await waitFor(
        async () => {
          const viewer = await openClient(main.port, id);
          const done = /FLOOD DONE 2930/.test(viewer.frames[0].data);
          viewer.close();
          if (!done) await delay(500);
          return done;
        },
        60000,
        "the flood to finish after the lagging windows were closed"
      );
    });
  });

  test("Review Focus 3, back-pressure: with no window left the terminal never pauses, and a closed window leaves the count at once", async () => {
    await withSession(async ({ id, open }) => {
      const a = await open();
      const b = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "flood 2930\r" });
      await waitFor(() => a.outBytes > 100000, 15000, "the flood to start");
      await waitQuiet([a, b], 1500, 30000);
      assert.ok(a.outBytes < 2930 * 1024, "paused while every window lags");
      a.close();
      b.close();
      // With no window left the terminal must run on: short-lived viewers look
      // at the screen until the flood is done.
      await waitFor(
        async () => {
          const viewer = await openClient(main.port, id);
          const done = /FLOOD DONE 2930/.test(viewer.frames[0].data);
          viewer.close();
          if (!done) await delay(500);
          return done;
        },
        60000,
        "the flood to finish with no window attached"
      );
    });
  });

  test("Review Focus 2, limits: one input frame over 64 KB (in bytes) is refused on the server, a message over 1 MB closes the socket, junk frames are ignored", async () => {
    await withSession(async ({ open }) => {
      const a = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "y".repeat(70000) }); // a frame of about 70 KB
      a.send({ t: "in", d: "é".repeat(33000) }); // 33,000 characters, about 66 KB
      a.send({ t: "in", d: "after-big\r" });
      await waitForScreen(a, /you said: after-big/);
      assert.doesNotMatch(a.outText, /y{50}/, "the frame over 64 KB never reached the terminal");
      assert.doesNotMatch(a.outText, /é{50}/, "64 KB counts bytes, not characters");
      assert.equal(a.closed, null, "a refused frame leaves the socket open");

      a.send({ t: "in", d: `${"z".repeat(4000)}\r` });
      await waitFor(() => /you said: z{4000}/.test(a.outText), 15000, "a 4 KB line to come back");

      a.ws.send("not json");
      a.ws.send(Buffer.from([1, 2, 3]));
      a.send({ t: "nope" });
      a.send({ t: "ack", seq: -5 });
      a.send({ t: "in", d: "still-open\r" });
      await waitForScreen(a, /you said: still-open/);
      assert.equal(a.closed, null);

      const big = await open();
      big.ws.send("x".repeat(MAX_PAYLOAD_BYTES + 1024));
      await waitFor(() => big.closed !== null, 10000, "the oversized message to close the socket");
      assert.equal(big.closed.code, 1009);
    });
  });

  test("terminal queries: while a writer is attached only the writer answers, never the server's mirror", async () => {
    await withSession(async ({ open }) => {
      const a = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "ask\r" });
      await waitFor(
        () => a.outText.includes("\u001b[c") && a.outText.includes("\u001b[6n"),
        5000,
        "the fake's DA1 and DSR queries"
      );
      await delay(1500);
      assert.doesNotMatch(a.outText, /REPLY/, "nobody answered for the silent writer");
      a.send({ t: "in", d: "\u001b[?62;22c" }); // the writer's own terminal answers DA1
      await waitForScreen(a, /REPLY "\\u001b\[\?62;22c"/, 5000);
      assert.equal((a.outText.match(/REPLY/g) || []).length, 1, "exactly the writer's one reply");
    });
  });

  test("terminal queries: with no writer attached, the server's mirror answers DA1", async () => {
    await withSession(async ({ id, open }) => {
      const a = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "ask after 4000\r" });
      await waitForScreen(a, /ask after 4000/); // the echo: the line, with its Enter, reached the fake
      a.close(); // no writer when the query comes
      const reply = await waitFor(
        async () => {
          const viewer = await openClient(main.port, id);
          const match = /REPLY "(\\u001b\[\?[0-9;]*c)"/.exec(viewer.frames[0].data);
          viewer.close();
          if (!match) await delay(500);
          return match;
        },
        15000,
        "the fake to print the mirror's DA1 reply"
      );
      assert.ok(reply, "the mirror answered DA1 while no window was the writer");
    });
  });

  test("alerts and state: BEL and OSC 9 arrive raw, and Stop sends exited with endedBy stop, then closes with session_ended", async () => {
    await withSession(async ({ id, open }) => {
      const a = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "bell\r" });
      await waitFor(() => a.frames.some((item) => item.t === "alert" && item.raw === "bel"), 5000, "the BEL alert");
      a.send({ t: "in", d: "osc9 hello-alert\r" });
      await waitFor(
        () => a.frames.some((item) => item.t === "alert" && item.raw === "9;hello-alert"),
        5000,
        "the OSC 9 alert"
      );
      const stopped = await api(main.port, "POST", `/api/sessions/${id}/stop`, {});
      assert.equal(stopped.status, 200, stopped.text);
      const ended = await waitFor(
        () => a.frames.find((item) => item.t === "state" && item.status === "exited"),
        15000,
        "the exited state"
      );
      assert.equal(ended.endedBy, "stop");
      await waitFor(() => a.closed !== null, 5000, "the socket to close");
      assert.deepEqual(a.closed, { code: 4001, reason: "session_ended" });
    });
  });

  test("reattach restores the screen and the modes", async () => {
    await withSession(async ({ open }) => {
      const a = await open();
      await waitForScreen(a, /FAKE_ARGV/);
      a.send({ t: "focus" });
      a.send({ t: "in", d: "alt on\r" });
      a.send({ t: "in", d: "paste on\r" });
      a.send({ t: "in", d: "marker-in-alt\r" });
      await waitForScreen(a, /you said: marker-in-alt/);
      a.close();
      const b = await open();
      const [snapshot] = b.frames;
      assert.equal(snapshot.modes.altScreen, true);
      assert.equal(snapshot.modes.bracketedPaste, true);
      assert.match(snapshot.data, /you said: marker-in-alt/);
    });
  });
});

describe("the Vite dev origin on real servers", { skip: SKIP_POSIX }, () => {
  async function withDevServer(extra, fn) {
    const home = await makeHome("agent-os-ws-dev-");
    const server = await startServer(home, extra);
    let id = null;
    try {
      await gateOn(server.port);
      id = await createSession(server.port, home);
      await fn(server.port, id);
    } finally {
      if (id) await stopSession(server.port, id);
      await stopServer(server);
      await rm(home, { recursive: true, force: true });
    }
  }

  test("with AGENT_OS_DEV_ORIGIN=1 the Vite dev page attaches", async () => {
    await withDevServer({ AGENT_OS_DEV_ORIGIN: "1" }, async (port, id) => {
      for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173", ownOrigin(port)]) {
        const result = await tryUpgrade(port, attachPath(id), { origin, cookie: cookieFor(port) });
        assert.equal(result.opened, true, `${origin}: ${result.error}`);
        result.client.close();
      }
    });
  });

  test("AGENT_OS_DEV_ORIGIN=1 is ignored in a packaged run", async () => {
    await withDevServer({ AGENT_OS_DEV_ORIGIN: "1", AGENT_OS_PACKAGED: "1" }, async (port, id) => {
      expectRefused(
        await tryUpgrade(port, attachPath(id), { origin: "http://127.0.0.1:5173", cookie: cookieFor(port) }),
        "the Vite dev page in a packaged run"
      );
      const own = await tryUpgrade(port, attachPath(id), { origin: ownOrigin(port), cookie: cookieFor(port) });
      assert.equal(own.opened, true, own.error);
      own.client.close();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The dev wiring
// ---------------------------------------------------------------------------

test("dev wiring: the Vite proxy carries upgrades and keeps the API's Host; only npm run dev sets the dev flag", async () => {
  const vite = await readFile(path.join(root, "vite.config.ts"), "utf8");
  assert.match(
    vite,
    /"\/api":\s*\{\s*target:\s*`http:\/\/127\.0\.0\.1:\$\{apiPort\}`,\s*changeOrigin:\s*true,\s*ws:\s*true\s*\}/,
    "the /api proxy needs the object form with changeOrigin and ws"
  );

  // ws.js trusts exactly the dev origins on :5173, so Vite must fail loudly on
  // a taken port instead of quietly serving on 5174.
  assert.match(vite, /port:\s*5173,[\s\S]*?strictPort:\s*true,[\s\S]*?proxy:/, "Vite must not move off port 5173");

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.dev, 'concurrently "node --watch scripts/dev-server.mjs" "vite --host 127.0.0.1"');
  assert.equal(pkg.scripts.start, "node server/index.js", "npm start never sets the dev flag");

  const launcher = await readFile(path.join(root, "scripts", "dev-server.mjs"), "utf8");
  assert.match(launcher, /^process\.env\.AGENT_OS_DEV_ORIGIN = "1";$/m);
  assert.match(launcher, /^await import\("\.\.\/server\/index\.js"\);$/m);

  const index = await readFile(path.join(root, "server", "index.js"), "utf8");
  assert.doesNotMatch(index, /AGENT_OS_DEV_ORIGIN/, "the server itself never sets the dev flag");
  assert.match(index, /attachSessionsUpgrade\(server, \{ getPort: \(\) => port, manager: sessionManager \}\);/);

  const shell = await readFile(path.join(root, "desktop", "src-tauri", "src", "main.rs"), "utf8");
  assert.doesNotMatch(shell, /AGENT_OS_DEV_ORIGIN/, "the desktop app never sets the dev flag");
});

test("test environment: AGENT_OS_LAUNCH_PATH never reaches a test server, and the test runner drops it too", async () => {
  // The login shell gives sessions AGENT_OS_LAUNCH_PATH as their PATH in place
  // of the fake folder + system folders a test passes.
  await withEnv({ AGENT_OS_LAUNCH_PATH: "/opt/real-agents/bin:/usr/bin" }, async () => {
    const env = serverEnv("/tmp/home", 8123);
    assert.equal(Object.hasOwn(env, "AGENT_OS_LAUNCH_PATH"), false, "serverEnv drops it");
    assert.equal(Object.hasOwn(serverEnv("/tmp/home", 8123, { AGENT_OS_LAUNCH_PATH: "/x" }), "AGENT_OS_LAUNCH_PATH"), true, "unless a test sets one");
  });
  const runner = await readFile(path.join(root, "scripts", "run-tests.mjs"), "utf8");
  const dropped = /for \(const key of \[([\s\S]*?)\]\) \{\s*delete testEnv\[key\];/.exec(runner);
  assert.ok(dropped, "scripts/run-tests.mjs still deletes a list of keys from the test environment");
  assert.match(dropped[1], /"AGENT_OS_LAUNCH_PATH"/, "the runner deletes AGENT_OS_LAUNCH_PATH");
});
