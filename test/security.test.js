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
  assert.equal(configure.status, 403);

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

test("12. GET /api/voice/context requires the execution gate to be on", async () => {
  const response = await fetch(`${base}/api/voice/context`, {
    headers: { "x-agent-os-token": TOKEN }
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "execution_gate_off");
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
