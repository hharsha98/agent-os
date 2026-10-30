// Local API security, tested black-box: spawns the real server and drives it
// with fetch/http.request the way a browser or a hostile page would.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCliArgs } from "../server/runtime/modules.js";
import { FAKE_LOGIN_SHELL } from "./helpers/fake-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-token-123";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function spawnServer(env) {
  return spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function collectLogs(child) {
  const ref = { text: "" };
  child.stdout.on("data", (chunk) => {
    ref.text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    ref.text += chunk;
  });
  return ref;
}

async function waitForHealth(base, child, logsRef) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logsRef.text.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy at ${base}:\n${logsRef.text.slice(-2000)}`);
}

async function killChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// fetch() forbids setting the Host header, so a forged-Host test needs raw http.
function requestWithHost(targetPort, hostHeader, urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        path: urlPath,
        method: "GET",
        headers: { Host: hostHeader, ...extraHeaders }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function baseEnv(home, port, extra = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    AGENT_OS_HOME: home,
    // Agent detection looks on PATH and under the user's home (~/.local/bin/hermes,
    // ~/.agent-os/node/bin/openclaw...). An empty temp HOME and a system-only PATH
    // (not node's own folder, which can hold real agents) keep the developer's
    // REAL agents out of reach of the spawned server.
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === "win32" ? {} : { PATH: "/usr/bin:/bin" }),
    // The server reads the login shell's environment for sessions (SP3): W1's
    // stand-in login shell (ruling R15), never the developer's own shell setup.
    SHELL: FAKE_LOGIN_SHELL,
    HERMES_AGENT_OS_SCHEDULER: "0"
  };
  // Clear these unless the caller explicitly set one via `extra` (e.g. the
  // demo-mode test needs DEMO_PUBLIC=1 to actually reach the child).
  for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT"]) {
    if (!(key in extra)) delete env[key];
  }
  return { ...env, ...extra };
}

async function setGate(base, enabled, confirm = false) {
  return fetch(`${base}/api/admin/execution-gate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: JSON.stringify({ enabled, ...(confirm ? { confirm: true } : {}) })
  });
}

let homeDir;
let port;
let base;
let child;
let logs;

before(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-security-test-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawnServer(baseEnv(homeDir, port, { AGENT_OS_TOKEN: TOKEN }));
  logs = collectLogs(child);
  await waitForHealth(base, child, logs);
});

after(async () => {
  await killChild(child);
  await rm(homeDir, { recursive: true, force: true });
});

test("1. GET /api/health needs no token", async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
});

test("2. GET /api/local-agents without a token is 401 session_required", async () => {
  const response = await fetch(`${base}/api/local-agents`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "session_required");
});

test("3. the same request with the x-agent-os-token header is not 401", async () => {
  const response = await fetch(`${base}/api/local-agents`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.notEqual(response.status, 401);
});

test("4. session claim rejects a wrong token and accepts the right one", async () => {
  const wrong = await fetch(`${base}/api/session/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "not-the-token" })
  });
  assert.equal(wrong.status, 401);

  const right = await fetch(`${base}/api/session/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN })
  });
  assert.equal(right.status, 200);
  const setCookie = right.headers.get("set-cookie") || "";
  assert.match(setCookie, new RegExp(`agent_os_session_${port}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const cookieValue = setCookie.split(";")[0];
  const authed = await fetch(`${base}/api/local-agents`, {
    headers: { cookie: cookieValue }
  });
  assert.notEqual(authed.status, 401);
});

test("5. a forged Host header is rejected even with a valid token", async () => {
  const response = await requestWithHost(port, "evil.example", "/api/local-agents", {
    "x-agent-os-token": TOKEN
  });
  assert.equal(response.status, 403);
  assert.equal(response.json?.error, "host_not_allowed");
});

test("6. a forged Origin header is rejected on a state-changing request", async () => {
  const response = await fetch(`${base}/api/admin/execution-gate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-os-token": TOKEN,
      Origin: "https://evil.example"
    },
    body: JSON.stringify({ enabled: true, confirm: true })
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "origin_not_allowed");
});

test("7. no Access-Control-Allow-Origin header is ever sent", async () => {
  const health = await fetch(`${base}/api/health`, {
    headers: { Origin: "https://evil.example" }
  });
  assert.equal(health.headers.get("access-control-allow-origin"), null);

  const preflight = await fetch(`${base}/api/local-agents`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "GET"
    }
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
});

test("8. the full attack chain from a hostile page is rejected end to end", async () => {
  const attackHeaders = { "Content-Type": "application/json", Origin: "https://evil.example" };

  const step1 = await fetch(`${base}/api/admin/execution-gate`, {
    method: "POST",
    headers: attackHeaders,
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(step1.status, 403);

  const step2 = await fetch(`${base}/api/connections/claude/configure`, {
    method: "POST",
    headers: attackHeaders,
    body: JSON.stringify({ fields: { CLAUDE_CODE_PATH: "/bin/sh" } })
  });
  assert.equal(step2.status, 403);

  const step3 = await fetch(`${base}/api/modules/claude/run`, {
    method: "POST",
    headers: attackHeaders,
    body: JSON.stringify({ dryRun: false, argsTemplate: "-c 'echo pwned'" })
  });
  assert.equal(step3.status, 403);

  const gate = await fetch(`${base}/api/execution-gate`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.equal(gate.status, 200);
  const gateBody = await gate.json();
  assert.equal(gateBody.enabled, false);
});

test("9. CLAUDE_CODE_PATH=/bin/sh is rejected by the basename allow-list even with the gate on and confirm:true", async () => {
  const gateOn = await setGate(base, true, true);
  assert.equal(gateOn.status, 200);
  assert.equal((await gateOn.json()).enabled, true);

  const configure = await fetch(`${base}/api/connections/claude/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: JSON.stringify({ fields: { CLAUDE_CODE_PATH: "/bin/sh" }, confirm: true })
  });
  // On POSIX /bin/sh exists and the basename check refuses it (403); on
  // Windows it does not exist, so the path check refuses it first (400).
  // Either way it must never be accepted.
  assert.equal(configure.status, process.platform === "win32" ? 400 : 403);

  await setGate(base, false); // leave the gate off for later tests
});

test("10. argsTemplate in the request body is ignored, in the API and in buildCliArgs directly", async () => {
  await setGate(base, true, true);

  const response = await fetch(`${base}/api/modules/claude/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: JSON.stringify({
      dryRun: true,
      argsTemplate: "--dangerously-skip-permissions {{message}}",
      message: "hello"
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /dangerously-skip-permissions/);
  assert.doesNotMatch(serialized, /argsTemplate/i);

  await setGate(base, false);

  // Direct unit check: buildCliArgs never reads input.argsTemplate, only the
  // stored/env CLAUDE_CLI_ARGS setting.
  const args = buildCliArgs({ id: "claude", command: "claude" }, {}, {
    message: "hi",
    argsTemplate: "--dangerously-skip-permissions {{message}}"
  });
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("hi"));
});

test("11. a blocked flag in CLAUDE_CLI_ARGS is rejected with 400", async () => {
  const response = await fetch(`${base}/api/connections/claude/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: JSON.stringify({
      fields: { CLAUDE_CLI_ARGS: "-p --dangerously-skip-permissions {{message}}" }
    })
  });
  assert.equal(response.status, 400);
});

test("12. GET /api/voice/context requires machine control (level 2), not just the execution gate", async () => {
  const response = await fetch(`${base}/api/voice/context`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "machine_control_off");
});

test("13. workspace raw responses carry a sandboxed CSP for html files", async () => {
  const write = await fetch(`${base}/api/workspace/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: JSON.stringify({
      folder: "notes",
      name: "sandbox-check.html",
      content: "<html><body>hi</body></html>"
    })
  });
  assert.equal(write.status, 201);
  const written = await write.json();
  const fileId = written.file.id;

  const raw = await fetch(`${base}/api/workspace/raw?id=${encodeURIComponent(fileId)}`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get("content-security-policy") || "", /sandbox/);
});

test("13b. a note saved through POST /api/workspace/files is listed as saved by You", async () => {
  const write = await fetch(`${base}/api/workspace/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: JSON.stringify({ folder: "notes", name: "saved-by-you-check.md", content: "# mine" })
  });
  assert.equal(write.status, 201);
  const list = await fetch(`${base}/api/workspace?query=saved-by-you-check`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].savedBy.kind, "you");
  assert.equal(body.files[0].savedBy.label, "You");
});

test("14. startup stdout prints the login link with the pinned token", () => {
  assert.match(logs.text, new RegExp(`Open: http://127\\.0\\.0\\.1:${port}/\\?launch=${TOKEN}`));
});

test("15. demo mode stays anonymous but still enforces the Host allow-list", async () => {
  const demoHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-security-demo-"));
  const demoPort = await freePort();
  const demoBase = `http://127.0.0.1:${demoPort}`;
  const demoChild = spawnServer(baseEnv(demoHome, demoPort, { DEMO_PUBLIC: "1" }));
  const demoLogs = collectLogs(demoChild);
  try {
    await waitForHealth(demoBase, demoChild, demoLogs);

    const noToken = await fetch(`${demoBase}/api/local-agents`);
    assert.notEqual(noToken.status, 401);

    const forgedHost = await requestWithHost(demoPort, "evil.example", "/api/local-agents");
    assert.equal(forgedHost.status, 403);
    assert.equal(forgedHost.json?.error, "host_not_allowed");
  } finally {
    await killChild(demoChild);
    await rm(demoHome, { recursive: true, force: true });
  }
});

test("16. changing the letter case of a protected path does not skip the session", async () => {
  // Express answers "/API/..." with the same handler as "/api/...", so the gate
  // has to treat both the same. Every one of these must be stopped at the gate
  // (401 session_required) and must never reach a real handler.
  const attempts = [
    ["GET", "/API/health"],
    ["GET", "/Api/Health"],
    ["GET", "/API/session"],
    ["POST", "/API/session/claim"],
    ["POST", "/Api/Session/Claim"],
    ["GET", "/API/local-agents"],
    ["GET", "/Api/Agents"],
    ["POST", "/API/runs"],
    ["POST", "/Api/Agents/hermes/message"],
    ["GET", "/_NEXT/x"],
    ["GET", "/Agent-Builder-Source"]
  ];
  for (const [method, urlPath] of attempts) {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      // Even the CORRECT token in the body must not turn "/API/session/claim"
      // into a working login: only the exact lower-case address is the login.
      ...(method === "POST" ? { body: JSON.stringify({ token: TOKEN }) } : {})
    });
    assert.equal(response.status, 401, `${method} ${urlPath} should be 401, got ${response.status}`);
    const body = await response.json();
    assert.equal(body.error, "session_required", `${method} ${urlPath} should stop at the gate`);
    assert.equal(response.headers.get("set-cookie"), null, `${method} ${urlPath} must not hand out a session`);
  }
});

test("17. the lower-case session-free addresses still work without a session", async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const session = await fetch(`${base}/api/session`);
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, false);

  const claim = await fetch(`${base}/api/session/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN })
  });
  assert.equal(claim.status, 200);
});

test("18. a protected lower-case route with a valid session still works, and the upper-case twin is not a route", async () => {
  const withSession = await fetch(`${base}/api/local-agents`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.equal(withSession.status, 200);
  assert.match(withSession.headers.get("content-type") || "", /application\/json/);

  const withSessionAgents = await fetch(`${base}/api/agents`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.notEqual(withSessionAgents.status, 401);
  assert.notEqual(withSessionAgents.status, 404);

  // Case-sensitive routing: even WITH a valid session, "/API/local-agents" is a
  // different address from "/api/local-agents" and the API handler never answers it.
  // (Once dist/ exists, the single-page-app fallback may answer 200 with HTML, so
  // only "200 with the API's JSON" counts as the handler having run.)
  const upper = await fetch(`${base}/API/local-agents`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  const upperIsApiJson = upper.status === 200 && (upper.headers.get("content-type") || "").includes("application/json");
  assert.equal(upperIsApiJson, false);
});

test("19. unreadable JSON never echoes the request text in the reply or the log", async () => {
  // A cut-off body (a pasted key with the closing brace missing) makes
  // express.json() fail. The failure carries the raw request text, and the
  // error handler used to spread it into the reply and print it in the log.
  const response = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: '{"apiKey":"sk-or-v1-NOTAREALKEY0123456789abcdef"'
  });
  assert.equal(response.status, 400);
  const replyText = await response.text();
  const reply = JSON.parse(replyText);
  assert.deepEqual(Object.keys(reply).sort(), ["error", "ok"]);
  assert.equal(replyText.includes("NOTAREALKEY"), false);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(logs.text.includes("NOTAREALKEY"), false);
});

// The routes a page on another local port could reach with the session cookie of a browser-mode server: every state-changing
// session route (SP3 stop/resume/dismiss, SP4 keep-going, hand-over, send, approvals, worktree, recording).
const SESSION_ID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
const STATE_CHANGING_SESSION_ROUTES = [
  ["POST", `/api/sessions/${SESSION_ID}/stop`],
  ["POST", `/api/sessions/${SESSION_ID}/resume`],
  ["POST", `/api/sessions/${SESSION_ID}/dismiss`],
  ["POST", `/api/sessions/${SESSION_ID}/keep-going`],
  ["POST", `/api/sessions/${SESSION_ID}/hand-over`],
  ["POST", `/api/sessions/${SESSION_ID}/send`],
  ["POST", "/api/sessions/approvals/resolve"],
  ["DELETE", `/api/sessions/${SESSION_ID}/worktree`],
  ["DELETE", `/api/sessions/${SESSION_ID}/recording`]
];

test("20. B-C2: a page on another local port gets the session cookie sent but is refused on every state-changing session route; the server's own origin and a request with no Origin still work, and reads are unchanged", async () => {
  const claim = await fetch(`${base}/api/session/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN })
  });
  const cookie = (claim.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, new RegExp(`^agent_os_session_${port}=`));
  const otherPort = port === 65535 ? port - 1 : port + 1;
  const hostile = [`http://127.0.0.1:${otherPort}`, `http://localhost:${otherPort}`, `ftp://127.0.0.1:${port}`, "null"];
  const send = (method, route, origin) =>
    fetch(`${base}${route}`, {
      method,
      headers: { cookie, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: method === "POST" ? JSON.stringify({}) : undefined
    });

  for (const [method, route] of STATE_CHANGING_SESSION_ROUTES) {
    for (const origin of hostile) {
      const refused = await send(method, route, origin);
      assert.equal(refused.status, 403, `${method} ${route} from ${origin}`);
      assert.equal((await refused.json()).error, "origin_not_allowed", `${method} ${route} from ${origin}`);
    }
    // Its own page (the desktop app's window and the browser tab both send exactly this), and no Origin at all.
    for (const origin of [`http://127.0.0.1:${port}`, undefined]) {
      const answered = await send(method, route, origin);
      assert.notEqual(answered.status, 403, `${method} ${route} with ${origin ?? "no Origin"}: not refused for its Origin`);
      assert.notEqual(answered.status, 401, `${method} ${route} with ${origin ?? "no Origin"}: the cookie is accepted`);
    }
  }

  // Reads do not change: a GET from another port is answered as before (the page cannot read it, the browser stops that).
  const read = await fetch(`${base}/api/sessions`, { headers: { cookie, Origin: `http://127.0.0.1:${otherPort}` } });
  assert.equal(read.status, 200);
});

test("21. B-C2: the exact-origin rule is local mode only, compares scheme, host and port with the request's own Host, and lets the Vite page in only when the dev launcher set the flag", async () => {
  const { originCheckMiddleware } = await import("../server/runtime/local-session.js");
  const middleware = originCheckMiddleware();
  const answer = (method, host, origin) => {
    const headers = { host, ...(origin === undefined ? {} : { origin }) };
    const result = { status: null, body: null, passed: false };
    middleware(
      { method, get: (name) => headers[String(name).toLowerCase()] },
      {
        status(code) {
          result.status = code;
          return this;
        },
        json(body) {
          result.body = body;
        }
      },
      () => {
        result.passed = true;
      }
    );
    return result;
  };
  const keys = ["HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_REQUIRE_AUTH", "DEMO_PUBLIC", "HERMES_AGENT_OS_DEMO_PUBLIC", "AGENT_OS_DEV_ORIGIN", "AGENT_OS_PACKAGED", "NODE_ENV"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const reset = () => {
    for (const key of keys) delete process.env[key];
  };
  try {
    reset();
    // Local mode.
    assert.equal(answer("POST", "127.0.0.1:8090", "http://127.0.0.1:8090").passed, true, "its own page");
    assert.equal(answer("POST", "localhost:8090", "http://localhost:8090").passed, true, "its own page by the other name");
    assert.equal(answer("POST", "127.0.0.1:8090", "HTTP://127.0.0.1:8090").passed, true, "letter case does not matter");
    assert.equal(answer("POST", "[::1]:8090", "http://[::1]:8090").passed, true, "an IPv6 host");
    assert.equal(answer("POST", "127.0.0.1:8090", "https://127.0.0.1:8090").passed, true, "the same host and port behind a TLS proxy");
    assert.equal(answer("POST", "127.0.0.1:8090", undefined).passed, true, "no Origin: unchanged (it still needs the cookie or the token)");
    assert.equal(answer("GET", "127.0.0.1:8090", "http://127.0.0.1:3000").passed, true, "reads are unchanged");
    for (const origin of [
      "http://127.0.0.1:3000",
      "http://127.0.0.1",
      "http://localhost:8090",
      "http://127.0.0.1:8090.evil.example",
      "http://127.0.0.1:8090/",
      "null",
      "http://127.0.0.1:5173"
    ]) {
      const refused = answer("POST", "127.0.0.1:8090", origin);
      assert.equal(refused.passed, false, origin);
      assert.deepEqual([refused.status, refused.body], [403, { error: "origin_not_allowed" }], origin);
    }
    assert.equal(answer("DELETE", "127.0.0.1:8090", "http://127.0.0.1:3000").status, 403, "DELETE too");
    // The Vite page of `npm run dev`: only with the launcher's flag, and never in a production or packaged run.
    process.env.AGENT_OS_DEV_ORIGIN = "1";
    assert.equal(answer("POST", "127.0.0.1:8090", "http://127.0.0.1:5173").passed, true);
    assert.equal(answer("POST", "127.0.0.1:8090", "http://localhost:5173").passed, true);
    assert.equal(answer("POST", "127.0.0.1:8090", "http://127.0.0.1:5174").status, 403);
    process.env.AGENT_OS_PACKAGED = "1";
    assert.equal(answer("POST", "127.0.0.1:8090", "http://127.0.0.1:5173").status, 403, "packaged: no dev page");
    reset();
    // A host that is not allowed is refused whatever the mode; a foreign Origin too.
    assert.equal(answer("POST", "127.0.0.1:8090", "https://evil.example").status, 403);
    // Public and demo modes are unchanged (the host name alone, as before): their own gates decide.
    process.env.HERMES_AGENT_OS_PUBLIC_MODE = "1";
    assert.equal(answer("POST", "127.0.0.1:8090", "http://127.0.0.1:3000").passed, true, "public mode: unchanged");
    delete process.env.HERMES_AGENT_OS_PUBLIC_MODE;
    process.env.DEMO_PUBLIC = "1";
    assert.equal(answer("POST", "127.0.0.1:8090", "http://127.0.0.1:3000").passed, true, "demo mode: unchanged");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
