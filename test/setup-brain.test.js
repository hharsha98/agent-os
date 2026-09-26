// Setup Assistant "brain": model provider choice, free OpenRouter models, a
// key check, and the configure job (safe defaults, always-on services,
// health check). Everything here runs against a temp HOME, a temp
// AGENT_OS_HOME, a 127.0.0.1 mirror standing in for openrouter.ai and Ollama,
// and fake hermes/openclaw CLIs -- nothing here may touch the real
// ~/.hermes, ~/.openclaw, or ~/.agent-os. Anything that spawns a fake CLI (a
// real shebang script) is POSIX-only, matching test/setup.test.js.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import express from "express";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import {
  brainOptions,
  clearBrainCacheForTest,
  currentBrain,
  listFreeOpenRouterModels,
  verifyOpenRouterKey
} from "../server/runtime/setup/brain.js";
import {
  getSetupJob,
  resetSetupJobsForTest,
  retrySetupJob,
  startConfigureJob
} from "../server/runtime/setup/jobs.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";
import { clearSystemCheckCache, systemCheck } from "../server/runtime/setup/system-check.js";

const isWindows = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posixSkip = { skip: isWindows ? "spawns shebang fake CLIs via a local mirror (POSIX-only)" : false };

const VALID_KEY = "sk-or-v1-TESTKEY-valid-0000";

// A CLI that records every invocation (argv + the OPENROUTER_API_KEY it saw
// in its env) to a record file under its own temp HOME -- never under
// AGENT_OS_HOME, so the case-6 leak grep of AGENT_OS_HOME stays meaningful.
const FAKE_HERMES_CLI_SOURCE = `
import { existsSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
function print(t) { process.stdout.write(t + "\\n"); }
try {
  appendFileSync(
    path.join(home, ".fake-hermes-record.jsonl"),
    JSON.stringify({ argv: args, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || null }) + "\\n"
  );
} catch {}

const configuredMarker = path.join(home, ".fake-hermes-configured");
const doctorFailMarker = path.join(home, ".fake-hermes-doctor-fail");
const gatewayRunningMarker = path.join(home, ".fake-hermes-gateway-running");

if (args.includes("--version")) { print("hermes 0.99.0-test"); process.exit(0); }

if (args[0] === "auth" && args[1] === "add" && args.includes("--help")) {
  print("usage: hermes auth add [-h] [--type {oauth,api-key,api_key}] [--api-key API_KEY] provider");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "add") {
  writeFileSync(configuredMarker, "1");
  print("added");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set" && args.includes("--help")) {
  print("usage: hermes config set [-h] [--force] [key] [value]");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") {
  if (args[2] === "model.provider" || args[2] === "OPENROUTER_API_KEY") writeFileSync(configuredMarker, "1");
  print("ok");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get") {
  if (args[2] === "approvals.mode") { print("on"); process.exit(0); }
  print("");
  process.exit(0);
}
if (args[0] === "chat" && args.includes("--help")) {
  print("Usage: hermes chat\\n  --query-file PATH\\n  --oneshot\\n  -Q, --quiet");
  process.exit(0);
}
if (args[0] === "chat") {
  if (existsSync(path.join(home, ".fake-hermes-chat-fail"))) {
    process.stderr.write("simulated chat failure\\n");
    process.exit(2);
  }
  const idx = args.indexOf("--query-file");
  let text = "ready";
  if (idx !== -1 && args[idx + 1]) {
    try { text = readFileSync(args[idx + 1], "utf8"); } catch {}
  }
  print(text);
  process.exit(0);
}
if (args[0] === "doctor") {
  if (existsSync(doctorFailMarker)) { print("Problems found."); process.exit(1); }
  if (existsSync(configuredMarker)) { print("Everything looks good."); process.exit(0); }
  print("No model provider configured.");
  process.exit(1);
}
if (args[0] === "gateway" && args.includes("--help")) {
  print("usage: hermes gateway [-h] {run,start,stop,status,install,uninstall}");
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "status") {
  if (existsSync(gatewayRunningMarker)) { print("Gateway is supervised by launchd (PID 123)"); process.exit(0); }
  print("gateway is not running");
  process.exit(0);
}
if (args[0] === "gateway" && (args[1] === "install" || args[1] === "start")) {
  writeFileSync(gatewayRunningMarker, "1");
  print("ok");
  process.exit(0);
}
print("fake-hermes: " + JSON.stringify(args));
process.exit(0);
`;

const FAKE_OPENCLAW_CLI_SOURCE = `
import { existsSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
function print(t) { process.stdout.write(t + "\\n"); }
try {
  appendFileSync(
    path.join(home, ".fake-openclaw-record.jsonl"),
    JSON.stringify({ argv: args, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || null }) + "\\n"
  );
} catch {}

const openclawDir = path.join(home, ".openclaw");
const configFile = path.join(openclawDir, "openclaw.json");
const execModeFile = path.join(home, ".fake-openclaw-exec-mode");
const runningMarker = path.join(home, ".fake-openclaw-gateway-running");

if (args.includes("--version")) { print("openclaw 9.9.9-test"); process.exit(0); }

if (args[0] === "onboard" && args.includes("--help")) {
  print(
    "Usage: openclaw onboard [--non-interactive] [--accept-risk] [--auth-choice CHOICE]\\n" +
    "  --openrouter-api-key KEY --custom-base-url URL\\n" +
    "  --skip-health --skip-channels --skip-skills --skip-ui --install-daemon --skip-daemon"
  );
  process.exit(0);
}
if (args[0] === "onboard") {
  if (existsSync(path.join(home, ".fake-openclaw-onboard-fail"))) {
    process.stderr.write("simulated onboard failure\\n");
    process.exit(1);
  }
  if (!args.includes("--non-interactive") || !args.includes("--accept-risk") || !args.includes("--auth-choice")) {
    process.stderr.write("missing required flags\\n");
    process.exit(1);
  }
  mkdirSync(openclawDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify({ onboarded: true }));
  if (args.includes("--install-daemon")) writeFileSync(runningMarker, "1");
  print(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "models" && args[1] === "set") { print("ok"); process.exit(0); }

if (args[0] === "agent" && args[1] === "exec" && args.includes("--help")) {
  print("Usage\\n --message-file PATH\\n --cwd DIR\\n --json");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "exec") {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch {}
  if (existsSync(path.join(home, ".fake-openclaw-agent-fail"))) {
    process.stderr.write("simulated agent failure\\n");
    process.exit(2);
  }
  print(JSON.stringify({ ok: true, final: "ready: " + input.slice(0, 20) }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "-m") {
  if (existsSync(path.join(home, ".fake-openclaw-agent-fail"))) {
    process.stderr.write("simulated agent failure\\n");
    process.exit(2);
  }
  print(JSON.stringify({ ok: true, final: "ready" }));
  process.exit(0);
}
if (args[0] === "doctor") {
  const ok = existsSync(configFile);
  print(JSON.stringify({ ok, findings: ok ? [] : [{ message: "not onboarded" }] }));
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get") {
  if (args[2] === "tools.exec.mode") {
    let value = "full";
    try { value = readFileSync(execModeFile, "utf8").trim(); } catch {}
    print(value);
    process.exit(0);
  }
  print("");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") {
  if (args[2] === "tools.exec.mode") writeFileSync(execModeFile, args[3]);
  print("ok");
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "status") {
  print(JSON.stringify({ running: existsSync(runningMarker) }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "start") {
  writeFileSync(runningMarker, "1");
  print("ok");
  process.exit(0);
}
print("fake-openclaw: " + JSON.stringify(args));
process.exit(0);
`;

const MODELS_FIXTURE = [
  { id: "paid/model", name: "Paid Model", pricing: { prompt: "0.000002", completion: "0.000002" }, supported_parameters: ["tools"], context_length: 128000 },
  { id: "free/no-tools", name: "No Tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: [], context_length: 128000 },
  { id: "free/32k", name: "Too Small", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], context_length: 32000 },
  { id: "free/64k", name: "Sixty Four K", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], context_length: 64000 },
  { id: "free/128k", name: "One Twenty Eight K", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], context_length: 128000 },
  { id: "free/200k", name: "Two Hundred K", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], context_length: 200000 }
];

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

let mirrorServer = null;
let mirrorPort = 0;
let mirrorHits = {};

function resetMirrorHits() {
  mirrorHits = {};
}

before(async () => {
  mirrorServer = http.createServer(async (req, res) => {
    mirrorHits[req.url] = (mirrorHits[req.url] || 0) + 1;
    if (req.url === "/openrouter.ai/api/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: MODELS_FIXTURE }));
      return;
    }
    if (req.url === "/openrouter.ai/api/v1/key") {
      const auth = req.headers.authorization || "";
      if (auth === `Bearer ${VALID_KEY}`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { label: "test-key", limit: 100 } }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid key" }));
      }
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3:8b", model: "llama3:8b" }] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => mirrorServer.listen(0, "127.0.0.1", resolve));
  mirrorPort = mirrorServer.address().port;
});

after(async () => {
  if (mirrorServer) await new Promise((resolve) => mirrorServer.close(resolve));
});

async function withTempSetupEnv(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-brain-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-brain-runtime-"));
  resetMirrorHits();
  try {
    await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}`,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HERMES_HOME: undefined
      },
      async () => {
        clearSystemCheckCache();
        clearDetectCaches();
        clearBrainCacheForTest();
        resetSetupJobsForTest();
        await fn({ home, agentOsHome });
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
  }
}

async function installFakeHermesShim(home) {
  const jsDir = path.join(home, ".fake-cli");
  await mkdir(jsDir, { recursive: true });
  const jsPath = path.join(jsDir, "hermes.mjs");
  await writeFile(jsPath, FAKE_HERMES_CLI_SOURCE);
  const binDir = path.join(home, ".local", "bin");
  await mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, "hermes");
  await writeFile(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`);
  await chmod(shimPath, 0o755);
}

async function installFakeOpenclawShim(home) {
  const jsDir = path.join(home, ".fake-cli");
  await mkdir(jsDir, { recursive: true });
  const jsPath = path.join(jsDir, "openclaw.mjs");
  await writeFile(jsPath, FAKE_OPENCLAW_CLI_SOURCE);
  const binDir = path.join(home, ".npm-global", "bin");
  await mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, "openclaw");
  await writeFile(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`);
  await chmod(shimPath, 0o755);
}

async function waitForJob(jobId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getSetupJob(jobId);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`configure job ${jobId} did not finish within ${timeoutMs}ms`);
}

async function recordLines(filePath) {
  const text = await readFile(filePath, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function withRouterApp(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/setup", createSetupRouter());
  app.use((error, _req, res, _next) => {
    res.status(error?.status || 500).json({ ok: false, error: error?.message || "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// =====================================================================
// 1. listFreeOpenRouterModels()
// =====================================================================

test("listFreeOpenRouterModels(): excludes paid/no-tools/low-context models; sorts by context desc", async () => {
  await withEnv({ AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}` }, async () => {
    clearBrainCacheForTest();
    const { models, error } = await listFreeOpenRouterModels({ refresh: true });
    assert.equal(error, undefined);
    const ids = models.map((m) => m.id);
    assert.ok(!ids.includes("paid/model"));
    assert.ok(!ids.includes("free/no-tools"));
    assert.ok(!ids.includes("free/32k"));
    assert.ok(ids.includes("free/64k"));
    assert.ok(ids.includes("free/128k"));
    assert.ok(ids.includes("free/200k"));
    for (let i = 1; i < models.length; i += 1) {
      assert.ok(models[i - 1].contextLength >= models[i].contextLength);
    }
  });
});

// =====================================================================
// 2. verifyOpenRouterKey()
// =====================================================================

test("verifyOpenRouterKey(): valid -> ok; invalid -> ok:false; malformed -> rejected without a request", async () => {
  await withEnv({ AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}` }, async () => {
    resetMirrorHits();
    const valid = await verifyOpenRouterKey(VALID_KEY);
    assert.equal(valid.ok, true);
    assert.equal(valid.label, "test-key");

    const invalid = await verifyOpenRouterKey("sk-or-v1-definitely-wrong");
    assert.equal(invalid.ok, false);

    const hitsBefore = mirrorHits["/openrouter.ai/api/v1/key"] || 0;
    assert.equal((await verifyOpenRouterKey("")).ok, false);
    assert.equal((await verifyOpenRouterKey("   ")).ok, false);
    assert.equal((await verifyOpenRouterKey("x".repeat(201))).ok, false);
    assert.equal(mirrorHits["/openrouter.ai/api/v1/key"] || 0, hitsBefore);
  });
});

// =====================================================================
// 3. brainOptions()
// =====================================================================

test("brainOptions(): 8GB -> openrouter; 32GB+Ollama available -> ollama; Ollama not installed -> unavailable", async () => {
  const low = await brainOptions({ ramGb: 8, freeDiskGb: 50, ollama: { found: false } });
  assert.equal(low.recommendation, "openrouter");
  const lowOllama = low.options.find((o) => o.id === "ollama");
  assert.equal(lowOllama.available, false);
  assert.match(lowOllama.reason, /next update/);

  await withEnv({ AGENT_OS_OLLAMA_URL: `http://127.0.0.1:${mirrorPort}` }, async () => {
    const high = await brainOptions({ ramGb: 32, freeDiskGb: 50, ollama: { found: true } });
    assert.equal(high.recommendation, "ollama");
    assert.equal(high.options.find((o) => o.id === "ollama").available, true);
  });
});

// =====================================================================
// 4. Defaults protect working agents
// =====================================================================

test(
  "currentBrain()/startConfigureJob(): a working hermes defaults to 'keep' and is left untouched",
  posixSkip,
  async () => {
    await withTempSetupEnv(async ({ home }) => {
      await installFakeHermesShim(home);
      await writeFile(path.join(home, ".fake-hermes-configured"), "1");

      const check = await systemCheck({ refresh: true });
      const brain = await currentBrain(check);
      assert.equal(brain.hermes.configured, true);
      assert.equal(brain.openclaw.configured, false);

      const job = await startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k" });
      const finished = await waitForJob(job.id);
      assert.equal(finished.status, "succeeded");
      assert.equal(finished.steps.find((s) => s.id === "hermes-brain").action, "keep");

      const lines = await recordLines(path.join(home, ".fake-hermes-record.jsonl"));
      const touchedConfig = lines.some(
        (e) => (e.argv[0] === "config" && e.argv[1] === "set") || (e.argv[0] === "auth" && e.argv[1] === "add" && !e.argv.includes("--help"))
      );
      assert.equal(touchedConfig, false);
    });
  }
);

// =====================================================================
// 5/6. Configure happy path + the key never leaks
// =====================================================================

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

async function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

test(
  "POST /configure over HTTP: happy path (both agents), safe defaults, services, health -- and the key leaks nowhere",
  posixSkip,
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-brain-http-home-"));
    const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-brain-http-runtime-"));
    await installFakeHermesShim(homeDir);
    await installFakeOpenclawShim(homeDir);
    resetMirrorHits();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const TOKEN = "test-brain-token-123";
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      HOME: homeDir,
      USERPROFILE: homeDir,
      AGENT_OS_HOME: agentOsHome,
      AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}`,
      AGENT_OS_TOKEN: TOKEN,
      HERMES_AGENT_OS_SCHEDULER: "0",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
    };
    for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT"]) {
      delete env[key];
    }
    const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const logs = collectLogs(child);
    const authed = { "x-agent-os-token": TOKEN };
    const authedJson = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };
    const responseBodies = [];
    const captureJson = async (response) => {
      const text = await response.text();
      responseBodies.push(text);
      return JSON.parse(text);
    };

    try {
      await waitForHealth(base, child, logs);

      const brainRes = await fetch(`${base}/api/setup/brain`, { headers: authed });
      assert.equal(brainRes.status, 200);
      const brainBody = await captureJson(brainRes);
      assert.equal(brainBody.defaults.hermes, "configure");
      assert.equal(brainBody.defaults.openclaw, "configure");

      const modelsRes = await fetch(`${base}/api/setup/openrouter/models`, { headers: authed });
      const modelsBody = await captureJson(modelsRes);
      assert.ok(modelsBody.models.some((m) => m.id === "free/128k"));

      const verifyRes = await fetch(`${base}/api/setup/openrouter/verify`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ apiKey: VALID_KEY })
      });
      const verifyBody = await captureJson(verifyRes);
      assert.equal(verifyBody.ok, true);

      const configureRes = await fetch(`${base}/api/setup/configure`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({
          mode: "openrouter",
          apiKey: VALID_KEY,
          model: "free/128k",
          acceptOpenClawRisk: true,
          confirm: true
        })
      });
      assert.equal(configureRes.status, 200);
      const jobBody = await captureJson(configureRes);
      assert.equal(jobBody.kind, "configure");

      const deadline = Date.now() + 90000;
      let finalJob = jobBody;
      while (Date.now() < deadline && finalJob.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const pollRes = await fetch(`${base}/api/setup/jobs/${jobBody.id}`, { headers: authed });
        finalJob = await captureJson(pollRes);
      }
      assert.equal(finalJob.status, "succeeded");
      assert.equal(finalJob.steps.find((s) => s.id === "hermes-brain").status, "succeeded");
      assert.equal(finalJob.steps.find((s) => s.id === "openclaw-brain").status, "succeeded");
      assert.equal(finalJob.health.hermes.promptOk, true);
      assert.equal(finalJob.health.openclaw.promptOk, true);

      const receiptRes = await fetch(`${base}/api/setup/receipt`, { headers: authed });
      const receiptBody = await captureJson(receiptRes);
      assert.equal(receiptBody.receipt.length, 2);
      assert.ok(receiptBody.receipt.every((entry) => entry.provider === "openrouter" && entry.model === "free/128k"));

      // The fakes really did receive the key (proves the pipe works)...
      const hermesLines = await recordLines(path.join(homeDir, ".fake-hermes-record.jsonl"));
      assert.ok(hermesLines.some((e) => e.argv.includes(VALID_KEY)));
      const openclawLines = await recordLines(path.join(homeDir, ".fake-openclaw-record.jsonl"));
      assert.ok(openclawLines.some((e) => e.argv.includes(VALID_KEY)));
      const execModeLine = openclawLines.find((e) => e.argv[0] === "config" && e.argv[1] === "set" && e.argv[2] === "tools.exec.mode");
      assert.equal(execModeLine.argv[3], "ask");

      // ...but the key appears NOWHERE else: not under AGENT_OS_HOME, not in
      // any captured API response body, not in the server's stdout/stderr.
      const runtimeFiles = await walkFiles(agentOsHome);
      for (const file of runtimeFiles) {
        const content = await readFile(file, "utf8").catch(() => "");
        assert.ok(!content.includes(VALID_KEY), `key leaked into ${file}`);
      }
      for (const body of responseBodies) {
        assert.ok(!body.includes(VALID_KEY), "key leaked into an API response body");
      }
      assert.ok(!logs.text.includes(VALID_KEY), "key leaked into server stdout/stderr");
    } finally {
      await killChild(child);
      await rm(homeDir, { recursive: true, force: true });
      await rm(agentOsHome, { recursive: true, force: true });
    }
  }
);

// =====================================================================
// 7. Safe defaults never loosen
// =====================================================================

test("configure job: tools.exec.mode already 'deny' is never loosened back to 'ask'", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeOpenclawShim(home);
    await writeFile(path.join(home, ".fake-openclaw-exec-mode"), "deny");
    const job = await startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k", acceptOpenClawRisk: true });
    const finished = await waitForJob(job.id);
    assert.equal(finished.status, "succeeded");
    const lines = await recordLines(path.join(home, ".fake-openclaw-record.jsonl"));
    const setExecMode = lines.some((e) => e.argv[0] === "config" && e.argv[1] === "set" && e.argv[2] === "tools.exec.mode");
    assert.equal(setExecMode, false);
  });
});

// =====================================================================
// 8. Running gateways are not restarted
// =====================================================================

test("configure job: an already-running gateway is left alone (no start/stop/install)", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await writeFile(path.join(home, ".fake-hermes-configured"), "1");
    await writeFile(path.join(home, ".fake-hermes-gateway-running"), "1");
    const job = await startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k" });
    const finished = await waitForJob(job.id);
    assert.equal(finished.status, "succeeded");
    const lines = await recordLines(path.join(home, ".fake-hermes-record.jsonl"));
    const touchedGateway = lines.some((e) => e.argv[0] === "gateway" && ["start", "stop", "install"].includes(e.argv[1]));
    assert.equal(touchedGateway, false);
  });
});

// =====================================================================
// 9. OpenClaw consent
// =====================================================================

test("startConfigureJob(): openclaw set to configure without acceptOpenClawRisk is rejected", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeOpenclawShim(home);
    await assert.rejects(
      () => startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k" }),
      (error) => error.code === "openclaw_risk_not_accepted"
    );
  });
});

// =====================================================================
// 10. Route validation: bad model / unavailable Ollama
// =====================================================================

test("POST /configure: a model outside the free list -> 400; mode:ollama unavailable -> 400", posixSkip, async () => {
  await withTempSetupEnv(async () => {
    await withEnv({ AGENT_OS_OLLAMA_URL: "http://127.0.0.1:1" }, async () => {
      await withRouterApp(async (base) => {
        const badModelRes = await fetch(`${base}/api/setup/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "openrouter", apiKey: VALID_KEY, model: "not-a-real-model", acceptOpenClawRisk: true, confirm: true })
        });
        assert.equal(badModelRes.status, 400);

        const ollamaRes = await fetch(`${base}/api/setup/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "ollama", model: "llama3:8b", confirm: true })
        });
        assert.equal(ollamaRes.status, 400);
      });
    });
  });
});

// =====================================================================
// 11. A failing health prompt doesn't fail the job
// =====================================================================

test("configure job: a failing test prompt reports promptOk:false without failing the job", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await writeFile(path.join(home, ".fake-hermes-configured"), "1");
    await writeFile(path.join(home, ".fake-hermes-chat-fail"), "1");
    const job = await startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k" });
    const finished = await waitForJob(job.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.health.hermes.promptOk, false);
    assert.ok(finished.health.hermes.error);
  });
});

// =====================================================================
// 12. Retry of a configure job
// =====================================================================

test("retrySetupJob(): a failed configure job can't be retried once its key is gone from memory", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeOpenclawShim(home);
    await writeFile(path.join(home, ".fake-openclaw-onboard-fail"), "1");
    const job = await startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k", acceptOpenClawRisk: true });
    const finished = await waitForJob(job.id);
    assert.equal(finished.status, "failed");
    await assert.rejects(() => retrySetupJob(job.id), (error) => error.code === "key_required_for_retry");
  });
});
