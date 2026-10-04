// Setup Assistant "brain": model provider choice, free OpenRouter models, a
// key check, and the configure job (safe defaults, always-on services,
// health check). Everything here runs against a temp HOME, a temp
// AGENT_OS_HOME, a 127.0.0.1 mirror standing in for openrouter.ai and Ollama,
// and fake hermes/openclaw CLIs -- nothing here may touch the real
// ~/.hermes, ~/.openclaw, or ~/.agent-os. Anything that spawns a fake CLI (a
// real shebang script) is POSIX-only, matching test/setup.test.js.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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
  listLocalModels,
  verifyOpenRouterKey
} from "../server/runtime/setup/brain.js";
import {
  getSetupJob,
  hermesKeyStrategy,
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
  // Without --api-key the real Hermes "prompts securely"; with no terminal
  // that is one line on stdin. A marker file makes this fake refuse that, to
  // exercise the fall-back to --api-key.
  if (!args.includes("--api-key")) {
    if (existsSync(path.join(home, ".fake-hermes-no-stdin-prompt"))) {
      process.stderr.write("error: --api-key is required when there is no terminal\\n");
      process.exit(2);
    }
    let stdinKey = "";
    try { stdinKey = readFileSync(0, "utf8").trim(); } catch {}
    if (!stdinKey) { process.stderr.write("No API key provided.\\n"); process.exit(1); }
    try {
      appendFileSync(path.join(home, ".fake-hermes-record.jsonl"), JSON.stringify({ argv: ["__stdin__"], stdinKey }) + "\\n");
    } catch {}
  }
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
const oauthCodes = {}; // one-time sign-in codes handed out by the fake /auth page

// ---- the mirror doubles as a fake Ollama (AGENT_OS_OLLAMA_URL points here) ----
const GIB = 1024 ** 3;
// Tiny working-memory numbers (4 layers, 2 KV heads, head size 64 = 2,048 bytes
// per token) so a model's size can be chosen to land at an exact SHARE of this
// computer's memory, whatever machine the tests run on.
const SMALL_KV_BYTES = 2 * 4 * 2 * (64 + 64);
function smallKvInfo(contextLength = 131072) {
  return {
    "general.architecture": "tiny",
    "tiny.block_count": 4,
    "tiny.attention.head_count": 8,
    "tiny.attention.head_count_kv": 2,
    "tiny.attention.key_length": 64,
    "tiny.attention.value_length": 64,
    "tiny.context_length": contextLength
  };
}
function sizeForShare(share) {
  return Math.round(os.totalmem() * share - SMALL_KV_BYTES * 65536 - 0.5 * GIB);
}
let ollamaModels = {};
let ollamaVariants = {}; // name -> { from, num_ctx }
let ollamaCreateCalls = []; // every POST /api/create body, exactly as received

function resetOllamaFake() {
  ollamaVariants = {};
  ollamaCreateCalls = [];
  const toolModel = (size, parameterSize = "8.0B") => ({
    size,
    details: { parameter_size: parameterSize },
    capabilities: ["completion", "tools"],
    model_info: smallKvInfo()
  });
  ollamaModels = {
    "llama3:8b": toolModel(4_700_000_000), // fits any computer comfortably
    "tight:7b": toolModel(sizeForShare(0.7), "7.0B"), // 70% of this computer's memory: tight
    "huge:70b": toolModel(sizeForShare(1.5), "70B"), // 150%: too big
    "Mixed-Case:7b": toolModel(4_000_000_000, "7.0B") // a name that can't become a copy name
  };
}
resetOllamaFake();

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function resetMirrorHits() {
  mirrorHits = {};
  resetOllamaFake();
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
    // The OpenRouter one-click sign-in: /auth sends the browser back to the
    // callback with a code; /auth/keys trades that code for a key, but only
    // for the verifier whose sha256 is the challenge, and only once.
    if (req.url.startsWith("/openrouter.ai/auth?")) {
      const params = new URL(req.url, "http://mirror.local").searchParams;
      const code = `code${Object.keys(oauthCodes).length}${Date.now().toString(36)}`;
      oauthCodes[code] = { challenge: params.get("code_challenge"), used: false };
      res.writeHead(302, { Location: `${params.get("callback_url")}?code=${code}&state=${params.get("state")}` });
      res.end();
      return;
    }
    if (req.url === "/openrouter.ai/api/v1/auth/keys" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const record = oauthCodes[body.code];
      const proof = crypto.createHash("sha256").update(String(body.code_verifier)).digest("base64url");
      const good = record && !record.used && body.code_challenge_method === "S256" && proof === record.challenge;
      if (good) record.used = true;
      res.writeHead(good ? 200 : 403, { "Content-Type": "application/json" });
      res.end(JSON.stringify(good ? { key: VALID_KEY } : { error: { message: "Invalid code or code_verifier" } }));
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const base = Object.entries(ollamaModels).map(([name, m]) => ({ name, model: name, size: m.size }));
      const copies = Object.entries(ollamaVariants).map(([name, v]) => ({ name, model: name, size: ollamaModels[v.from]?.size ?? 0 }));
      res.end(JSON.stringify({ models: [...base, ...copies] }));
      return;
    }
    if (req.url === "/api/show" && req.method === "POST") {
      const { model } = await readJsonBody(req);
      const copy = ollamaVariants[model];
      const info = copy ? ollamaModels[copy.from] : ollamaModels[model];
      if (!info) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "model not found" }));
        return;
      }
      const { size: _size, ...rest } = info;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(copy ? { ...rest, parameters: `num_ctx                        ${copy.num_ctx}` } : rest));
      return;
    }
    // Ollama's "Create a Model" (docs/api.md): { model, from, parameters, stream:false }.
    // Makes a settings-only copy that shares the original's weights.
    if (req.url === "/api/create" && req.method === "POST") {
      const body = await readJsonBody(req);
      ollamaCreateCalls.push(body);
      if (!ollamaModels[body.from]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `model '${body.from}' not found` }));
        return;
      }
      ollamaVariants[body.model] = { from: body.from, num_ctx: body.parameters?.num_ctx ?? null };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success" }));
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

test("brainOptions(): ALWAYS OpenRouter (even with a good local model on a big computer); Ollama not installed -> unavailable", async () => {
  clearBrainCacheForTest();
  const low = await brainOptions({ ramGb: 8, freeDiskGb: 50, ollama: { found: false } });
  assert.equal(low.recommendation, "openrouter");
  const lowOllama = low.options.find((o) => o.id === "ollama");
  assert.equal(lowOllama.available, false);
  assert.match(lowOllama.reason, /isn't installed/);

  await withEnv({ AGENT_OS_OLLAMA_URL: `http://127.0.0.1:${mirrorPort}` }, async () => {
    resetOllamaFake();
    clearBrainCacheForTest();
    const high = await brainOptions({ ramGb: 32, freeDiskGb: 50, ollama: { found: true } });
    assert.equal(high.recommendation, "openrouter", "Local is offered, never chosen for the person");
    assert.equal(high.options.find((o) => o.id === "ollama").available, true);
    // The sentence about Local names a model that really is in the list, with the list's own number.
    const list = await listLocalModels({ ramGb: 32 });
    const named = list.find((m) => m.verdict.id === "good" && m.memory.fit === "comfortable");
    assert.ok(named, "the fake has a model that fits a 32 GB computer");
    assert.ok(high.reason.startsWith("We recommend OpenRouter for both agents: strong models, no big download, free to start."));
    assert.ok(high.reason.includes(`You could also run ${named.name} locally; it fits this computer (about ${named.memory.memoryAt64kGb} GB).`));
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

      // The fakes really did receive the key (proves the pipe works), and we
      // can say HOW: Hermes through its private prompt (standard input), so
      // it is on no command line; OpenClaw only offers an argument (known
      // limitation, see jobs.js). Neither got it through the environment.
      const hermesLines = await recordLines(path.join(homeDir, ".fake-hermes-record.jsonl"));
      assert.ok(hermesLines.some((e) => e.stdinKey === VALID_KEY));
      assert.ok(!hermesLines.some((e) => e.argv.includes(VALID_KEY)), "Hermes was given the key on its command line");
      assert.ok(hermesLines.every((e) => !e.OPENROUTER_API_KEY));
      const openclawLines = await recordLines(path.join(homeDir, ".fake-openclaw-record.jsonl"));
      assert.ok(openclawLines.some((e) => e.argv.includes(VALID_KEY)));
      assert.ok(openclawLines.every((e) => !e.OPENROUTER_API_KEY));
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
// 6b. One-click OpenRouter: the whole trip, against the REAL server process
// =====================================================================

test(
  "Connect OpenRouter end to end: sign-in -> callback (no cookie) -> configure with {flowId} -> hello check; the key leaks nowhere",
  posixSkip,
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-oauth-home-"));
    const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-oauth-runtime-"));
    await installFakeHermesShim(homeDir);
    await installFakeOpenclawShim(homeDir);
    resetMirrorHits();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const TOKEN = "test-oauth-token-123";
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      HOME: homeDir,
      USERPROFILE: homeDir,
      AGENT_OS_HOME: agentOsHome,
      AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}`,
      AGENT_OS_TOKEN: TOKEN,
      AGENT_OS_NO_BROWSER: "1", // never open a real browser from a test
      HERMES_AGENT_OS_SCHEDULER: "0",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
    };
    for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT", "AGENT_OS_OAUTH_CALLBACK_HOST"]) {
      delete env[key];
    }
    const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const logs = collectLogs(child);
    const authedJson = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };
    const responseBodies = [];
    const call = async (url, init = {}) => {
      const response = await fetch(`${base}${url}`, { ...init, headers: { ...authedJson, ...(init.headers || {}) } });
      const text = await response.text();
      responseBodies.push(text);
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };

    try {
      await waitForHealth(base, child, logs);

      // 1. Connect: the server opens nothing here (no browser in tests) and
      //    hands back the sign-in address to follow ourselves.
      const connect = await call("/api/setup/openrouter/connect", { method: "POST", body: JSON.stringify({ confirm: true }) });
      assert.equal(connect.status, 200);
      assert.equal(connect.body.status, "waiting");
      assert.equal(connect.body.opened, false);
      const { flowId, authUrl } = connect.body;
      assert.match(authUrl, new RegExp(`^http://localhost:${port}/oauth/openrouter/start/[a-f0-9]{64}$`), "a one-time LOCAL start address on the REAL port");

      // 2. The browser (no session, no token) opens the start address and gets
      //    its own cookie, is sent on to OpenRouter, and comes back WITH that cookie.
      const start = await fetch(authUrl.replace("//localhost:", "//127.0.0.1:"), { redirect: "manual" });
      assert.equal(start.status, 302);
      const cookiePair = start.headers.get("set-cookie").split(";")[0];
      const openRouterUrl = start.headers.get("location");
      assert.equal(new URL(openRouterUrl).searchParams.get("callback_url"), `http://localhost:${port}/oauth/openrouter/callback`, "the REAL port, not 0 and not 8090");
      const redirect = await fetch(openRouterUrl, { redirect: "manual" });
      assert.equal(redirect.status, 302);
      const location = redirect.headers.get("location");
      const callback = await fetch(location.replace("//localhost:", "//127.0.0.1:"), { headers: { cookie: cookiePair } });
      assert.equal(callback.status, 200);
      const page = await callback.text();
      responseBodies.push(page);
      assert.match(page, /Connected to OpenRouter\./);

      const status = await call(`/api/setup/openrouter/connect/${flowId}`);
      assert.equal(status.body.status, "connected");

      // The callback host rules and the gate, against the real server.
      const badHost = await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/oauth/openrouter/callback?code=a&state=b", headers: { Host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(badHost, 403);
      assert.equal((await fetch(`${base}/oauth/elsewhere`)).status, 401);
      // Changing the letter case of a protected path can't skip the session
      // (against the REAL server: case-sensitive routing plus a gate that
      // compares lower-cased paths).
      for (const [method, requestPath] of [
        ["POST", "/API/setup/configure"],
        ["GET", "/Api/Setup/check"],
        ["GET", "/API/runs"],
        ["GET", "/OAUTH/openrouter/callback"]
      ]) {
        const res = await fetch(`${base}${requestPath}`, {
          method,
          headers: method === "POST" ? { "Content-Type": "application/json" } : {},
          body: method === "POST" ? JSON.stringify({ confirm: true }) : undefined
        });
        assert.equal(res.status, 401, `${method} ${requestPath} must need the session`);
      }
      // The real lower-case callback still works for the browser (no params = the cancelled page).
      assert.equal((await fetch(`${base}/oauth/openrouter/callback`)).status, 200);

      // 3. The recommended model is one of the free models.
      const models = await call("/api/setup/openrouter/models");
      assert.equal(models.body.recommended, "free/200k");

      // 4. Give it to both agents, with the sign-in as the key source.
      const configure = await call("/api/setup/configure", {
        method: "POST",
        body: JSON.stringify({
          confirm: true,
          acceptOpenClawRisk: true,
          keySource: { flowId },
          targets: { hermes: { mode: "openrouter", model: "free/128k" }, openclaw: { mode: "openrouter", model: "free/64k" } }
        })
      });
      assert.equal(configure.status, 200);
      assert.equal(configure.body.kind, "configure");
      assert.equal(configure.body.targets.openclaw.model, "free/64k");
      let job = configure.body;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && job.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 400));
        job = (await call(`/api/setup/jobs/${job.id}`)).body;
      }
      assert.equal(job.status, "succeeded");
      assert.equal(job.health.hermes.promptOk, true);
      assert.equal(job.health.openclaw.promptOk, true);

      // 5. How each fake agent received the key.
      const hermesLines = await recordLines(path.join(homeDir, ".fake-hermes-record.jsonl"));
      assert.ok(hermesLines.some((e) => e.stdinKey === VALID_KEY), "Hermes should get the key on its private prompt");
      assert.ok(hermesLines.every((e) => !e.argv.includes(VALID_KEY) && !e.OPENROUTER_API_KEY));
      const openclawLines = await recordLines(path.join(homeDir, ".fake-openclaw-record.jsonl"));
      assert.ok(openclawLines.some((e) => e.argv.includes(VALID_KEY)), "OpenClaw only offers --openrouter-api-key (known limitation)");

      // 6. The key is gone from the sign-in: a second configure can't reuse it.
      const again = await call("/api/setup/configure", {
        method: "POST",
        body: JSON.stringify({
          confirm: true,
          acceptOpenClawRisk: true,
          keySource: { flowId },
          targets: { hermes: { mode: "openrouter", model: "free/128k" } }
        })
      });
      assert.equal(again.status, 409);
      assert.equal(again.body.error, "key_unavailable");

      // 7. Collect every place the key could have gone: each run's metadata,
      //    event log and live stream, then grep the lot.
      for (const step of job.steps) {
        for (const runId of step.runIds) {
          await call(`/api/runs/${runId}`);
          await call(`/api/runs/${runId}/events`);
          const stream = await fetch(`${base}/api/runs/${runId}/stream`, { headers: { "x-agent-os-token": TOKEN } });
          responseBodies.push(await stream.text());
        }
      }
      for (const file of await walkFiles(agentOsHome)) {
        const content = await readFile(file, "utf8").catch(() => "");
        assert.ok(!content.includes(VALID_KEY), `key leaked into ${file}`);
      }
      for (const body of responseBodies) assert.ok(!body.includes(VALID_KEY), "key leaked into an API response, page or event stream");
      assert.ok(!logs.text.includes(VALID_KEY), "key leaked into server stdout/stderr");
      assert.ok(responseBodies.length > 10, "the leak check should have looked at many responses");
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

// =====================================================================
// 13. How the key reaches Hermes, and per-agent targets
// =====================================================================

test("configure job: Hermes falls back to --api-key when its private prompt is refused, and the log says so", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await writeFile(path.join(home, ".fake-hermes-no-stdin-prompt"), "1");
    const job = await startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k" });
    const finished = await waitForJob(job.id);
    assert.equal(finished.status, "succeeded");
    const lines = await recordLines(path.join(home, ".fake-hermes-record.jsonl"));
    const withFlag = lines.filter((e) => e.argv[0] === "auth" && e.argv[1] === "add" && e.argv.includes("--api-key"));
    assert.equal(withFlag.length, 1);
    assert.equal(withFlag[0].argv[withFlag[0].argv.indexOf("--api-key") + 1], VALID_KEY);
    const brainStep = finished.steps.find((s) => s.id === "hermes-brain");
    assert.ok(brainStep.log.some((l) => /did not take the key from its private prompt/.test(l)));
    // The persisted job file and its step logs never contain the key.
    assert.ok(!JSON.stringify(finished).includes(VALID_KEY));
  });
});

test("configure job: per-agent targets touch only the ticked agent and may use different brains", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await installFakeOpenclawShim(home);

    // Only Hermes ticked: OpenClaw is not configured, not tightened, not tested.
    const onlyHermes = await startConfigureJob({
      targets: { hermes: { mode: "openrouter", model: "free/128k" } },
      apiKey: VALID_KEY
    });
    const first = await waitForJob(onlyHermes.id);
    assert.equal(first.status, "succeeded");
    assert.deepEqual(first.scope, ["hermes"]);
    assert.equal(first.steps.find((s) => s.id === "openclaw-brain").action, "keep");
    assert.equal(first.steps.find((s) => s.id === "openclaw-safe-defaults").action, "skip-not-selected");
    assert.deepEqual(Object.keys(first.health), ["hermes"]);
    const openclawQuiet = await recordLines(path.join(home, ".fake-openclaw-record.jsonl"));
    const touched = openclawQuiet.some(
      (e) => ["onboard", "agent"].includes(e.argv[0]) && !e.argv.includes("--help") ||
        (e.argv[0] === "config" && e.argv[1] === "set") ||
        (e.argv[0] === "models" && e.argv[1] === "set")
    );
    assert.equal(touched, false, "an unticked OpenClaw was touched");

    // Different brains IN ONE JOB: Hermes local (its 64K copy), OpenClaw
    // OpenRouter. The key is only used for the agent that needs it.
    await withEnv({ AGENT_OS_OLLAMA_URL: `http://127.0.0.1:${mirrorPort}` }, async () => {
      resetSetupJobsForTest();
      const hermesLinesBefore = (await recordLines(path.join(home, ".fake-hermes-record.jsonl"))).length;
      const mixed = await startConfigureJob({
        targets: { hermes: { mode: "ollama", model: "llama3:8b" }, openclaw: { mode: "openrouter", model: "free/64k" } },
        apiKey: VALID_KEY,
        acceptOpenClawRisk: true
      });
      const second = await waitForJob(mixed.id);
      assert.equal(second.status, "succeeded");
      assert.equal(second.mode, "mixed");
      const hermesLines = (await recordLines(path.join(home, ".fake-hermes-record.jsonl"))).slice(hermesLinesBefore);
      const setProvider = hermesLines.filter((e) => e.argv[0] === "config" && e.argv[1] === "set" && e.argv[2] === "model.provider");
      assert.equal(setProvider.at(-1).argv[3], "custom");
      assert.ok(!JSON.stringify(hermesLines).includes(VALID_KEY), "the key reached the agent that doesn't use OpenRouter");
      const openclawLines = await recordLines(path.join(home, ".fake-openclaw-record.jsonl"));
      assert.ok(openclawLines.some((e) => e.argv[0] === "onboard" && e.argv.includes("openrouter-api-key")));
      assert.ok(!openclawLines.some((e) => e.argv[0] === "models" && e.argv[2]?.startsWith("ollama/")), "OpenClaw is on OpenRouter, not Local");
      const receipt = (await readFile(path.join(process.env.AGENT_OS_HOME, "setup", "receipt.json"), "utf8").catch(() => "")) || "";
      assert.ok(!receipt.includes(VALID_KEY));
    });
  });
});

test("startConfigureJob(): no agent ticked, a missing key, and a dead connection are refused with plain codes", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await assert.rejects(() => startConfigureJob({ targets: {} , apiKey: VALID_KEY }), (e) => e.code === "no_targets");
    await assert.rejects(
      () => startConfigureJob({ targets: { hermes: { mode: "cloud", model: "x" } }, apiKey: VALID_KEY }),
      (e) => e.code === "invalid_mode"
    );
    await assert.rejects(
      () => startConfigureJob({ targets: { hermes: { mode: "openrouter", model: "free/128k" } } }),
      (e) => e.code === "key_required"
    );
    await assert.rejects(
      () =>
        startConfigureJob({
          targets: { hermes: { mode: "openrouter", model: "free/128k" } },
          keySource: { flowId: "0".repeat(32) }
        }),
      (e) => e.code === "key_unavailable"
    );
    await assert.rejects(
      () => startConfigureJob({ targets: { hermes: { mode: "openrouter", model: "" } }, apiKey: VALID_KEY }),
      (e) => e.code === "invalid_model"
    );
  });
});

// =====================================================================
// 14. Local brains: the 64K copy, the fit check, both agents free to choose
// =====================================================================

// The commands that CHANGE an agent or run it, as opposed to the read-only
// probes every system check makes (--version, doctor, --help, gateway status,
// config get).
function mutating(lines) {
  return lines.filter((e) => {
    const [a, b] = e.argv;
    if (e.argv.includes("--help")) return false;
    if (a === "config" && b === "set") return true;
    if (a === "auth" && b === "add") return true;
    if (["onboard", "models", "agent", "chat"].includes(a)) return true;
    if (a === "gateway" && ["start", "stop", "install", "restart"].includes(b)) return true;
    return false;
  });
}

// Runs `fn` with a fake `ollama` on PATH (so Setup sees Ollama as installed)
// and AGENT_OS_OLLAMA_URL pointing at the fake Ollama in the mirror.
async function withFakeOllama(home, fn) {
  const binDir = path.join(home, "fake-bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "ollama"), `#!/bin/sh\necho "ollama version 0.0.0-test"\n`);
  await chmod(path.join(binDir, "ollama"), 0o755);
  await withEnv(
    { AGENT_OS_OLLAMA_URL: `http://127.0.0.1:${mirrorPort}`, PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter) },
    async () => {
      clearSystemCheckCache();
      clearDetectCaches();
      clearBrainCacheForTest();
      await fn();
    }
  );
}

const lastSet = (lines, key) => lines.filter((e) => e.argv[0] === "config" && e.argv[1] === "set" && e.argv[2] === key).at(-1)?.argv[3];

test("configure job (Local): the 64K copy is made once for both agents; Hermes and OpenClaw are pointed at it; the receipt names it; a second job reuses it", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await installFakeOpenclawShim(home);
    await withFakeOllama(home, async () => {
      const job = await startConfigureJob({ mode: "ollama", model: "llama3:8b", acceptOpenClawRisk: true });
      const finished = await waitForJob(job.id);
      assert.equal(finished.status, "succeeded");

      // ONE create call, with exactly the documented body, even though two agents use the model.
      assert.deepEqual(ollamaCreateCalls, [
        { model: "agentos-llama3-8b:64k", from: "llama3:8b", parameters: { num_ctx: 65536 }, stream: false }
      ]);
      assert.equal(finished.steps[0].id, "local-prepare", "the copy is made before any agent is configured");
      const prepare = finished.steps[0];
      assert.equal(prepare.status, "succeeded");
      assert.ok(prepare.log.some((l) => /Prepare llama3:8b with 64K working memory/.test(l)));
      assert.ok(prepare.log.some((l) => /Created agentos-llama3-8b:64k, a settings copy of llama3:8b \(no extra download\)/.test(l)));
      assert.deepEqual(finished.localVariants, { "llama3:8b": "agentos-llama3-8b:64k" });

      // Hermes: the copy as its model, and 65536 as its context.
      const hermes = await recordLines(path.join(home, ".fake-hermes-record.jsonl"));
      assert.equal(lastSet(hermes, "model.provider"), "custom");
      assert.equal(lastSet(hermes, "model.base_url"), `http://localhost:${mirrorPort}/v1`);
      assert.equal(lastSet(hermes, "model.default"), "agentos-llama3-8b:64k");
      assert.equal(lastSet(hermes, "model.context_length"), "65536");
      assert.ok(!hermes.some((e) => e.argv.includes("llama3:8b") && e.argv[2] === "model.default"), "Hermes must not be given the plain model");

      // OpenClaw: native Ollama address for onboarding, the copy as its model.
      const openclaw = await recordLines(path.join(home, ".fake-openclaw-record.jsonl"));
      const onboard = openclaw.find((e) => e.argv[0] === "onboard" && !e.argv.includes("--help"));
      assert.equal(onboard.argv[onboard.argv.indexOf("--auth-choice") + 1], "ollama");
      assert.equal(onboard.argv[onboard.argv.indexOf("--custom-base-url") + 1], `http://127.0.0.1:${mirrorPort}`);
      const modelsSet = openclaw.find((e) => e.argv[0] === "models" && e.argv[1] === "set");
      assert.equal(modelsSet.argv[2], "ollama/agentos-llama3-8b:64k");

      // The receipt and its change list name the copy and how to remove it.
      const receipt = JSON.parse(await readFile(path.join(process.env.AGENT_OS_HOME, "setup", "receipt.json"), "utf8"));
      const removal = "Added a settings copy named agentos-llama3-8b:64k to Ollama (no extra download). Remove it any time with `ollama rm agentos-llama3-8b:64k`.";
      for (const agentId of ["hermes", "openclaw"]) {
        const entry = receipt.find((r) => r.agentId === agentId && r.action === "configure");
        assert.equal(entry.provider, "ollama");
        assert.equal(entry.model, "llama3:8b");
        assert.ok(entry.changes.includes(removal), `${agentId}'s receipt names the copy`);
      }

      // A second job for the same model reuses the copy: no second create call.
      const again = await startConfigureJob({ targets: { hermes: { mode: "ollama", model: "llama3:8b" } } });
      const second = await waitForJob(again.id);
      assert.equal(second.status, "succeeded");
      assert.equal(ollamaCreateCalls.length, 1, "an existing 64K copy is reused");
      assert.ok(second.steps[0].log.some((l) => /already has 64K working memory; reused it/.test(l)));
    });
  });
});

test("mixed brains in two jobs: Hermes on Local, then OpenClaw on OpenRouter; the second job never touches Hermes", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await installFakeOpenclawShim(home);
    await withFakeOllama(home, async () => {
      const hermesFile = path.join(home, ".fake-hermes-record.jsonl");
      const openclawFile = path.join(home, ".fake-openclaw-record.jsonl");

      // Job 1: only Hermes, on Local.
      const first = await waitForJob((await startConfigureJob({ targets: { hermes: { mode: "ollama", model: "llama3:8b" } } })).id);
      assert.equal(first.status, "succeeded");
      assert.deepEqual(first.scope, ["hermes"]);
      assert.equal(lastSet(await recordLines(hermesFile), "model.default"), "agentos-llama3-8b:64k");
      assert.equal(mutating(await recordLines(openclawFile)).length, 0, "OpenClaw was not touched by job 1");
      const hermesAfterFirst = mutating(await recordLines(hermesFile)).length;
      assert.ok(hermesAfterFirst > 0);

      // Job 2: only OpenClaw, on OpenRouter.
      resetSetupJobsForTest();
      const second = await waitForJob(
        (await startConfigureJob({ targets: { openclaw: { mode: "openrouter", model: "free/64k" } }, apiKey: VALID_KEY, acceptOpenClawRisk: true })).id
      );
      assert.equal(second.status, "succeeded");
      assert.deepEqual(second.scope, ["openclaw"]);
      assert.equal(second.steps.find((s) => s.id === "local-prepare"), undefined, "no Local model in job 2, so no copy step");
      const hermesAfterSecond = await recordLines(hermesFile);
      assert.equal(mutating(hermesAfterSecond).length, hermesAfterFirst, "job 2 recorded no Hermes command that changes or runs it");
      assert.ok(!JSON.stringify(hermesAfterSecond).includes(VALID_KEY));
      const openclaw = await recordLines(openclawFile);
      assert.ok(openclaw.some((e) => e.argv[0] === "onboard" && e.argv.includes("openrouter-api-key") && e.argv.includes(VALID_KEY)));
      assert.ok(openclaw.some((e) => e.argv[0] === "models" && e.argv[1] === "set" && e.argv[2] === "openrouter/free/64k"));
      assert.equal(ollamaCreateCalls.length, 1, "job 2 asked Ollama for nothing");

      const receipt = JSON.parse(await readFile(path.join(process.env.AGENT_OS_HOME, "setup", "receipt.json"), "utf8"));
      assert.equal(receipt.find((r) => r.agentId === "hermes" && r.action === "configure").provider, "ollama");
      assert.equal(receipt.find((r) => r.agentId === "openclaw" && r.action === "configure").provider, "openrouter");
    });
  });
});

test("Local fit: too big needs acceptLocalFit (400 local_model_too_big with GB numbers, no command runs); accepted it proceeds; tight only warns", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await installFakeOpenclawShim(home);
    await withFakeOllama(home, async () => {
      const hermesFile = path.join(home, ".fake-hermes-record.jsonl");
      const openclawFile = path.join(home, ".fake-openclaw-record.jsonl");
      await withRouterApp(async (base) => {
        const post = (body) =>
          fetch(`${base}/api/setup/configure`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, ...body }) });
        const targets = { hermes: { mode: "ollama", model: "huge:70b" } };

        // The server works the fit out itself; the client can't talk its way past it.
        for (const extra of [{}, { acceptLocalFit: false }, { acceptLocalFit: "yes" }, { acceptLocalFit: 1 }]) {
          const refused = await post({ targets, ...extra });
          assert.equal(refused.status, 400, JSON.stringify(extra));
          const body = await refused.json();
          assert.equal(body.error, "local_model_too_big");
          assert.match(body.message, /huge:70b needs about [\d.]+ GB of memory for the 64K working memory agents need, and this computer has [\d.]+ GB/);
          assert.match(body.message, /Use it anyway/);
        }
        assert.equal(ollamaCreateCalls.length, 0, "no copy was made");
        assert.equal(mutating(await recordLines(hermesFile)).length, 0, "no Hermes command ran");
        assert.equal(mutating(await recordLines(openclawFile)).length, 0, "no OpenClaw command ran");

        // Accepted: it proceeds, with a warning on the step.
        const accepted = await post({ targets, acceptLocalFit: true });
        assert.equal(accepted.status, 200);
        const job = await waitForJob((await accepted.json()).id);
        assert.equal(job.status, "succeeded");
        assert.equal(ollamaCreateCalls.length, 1);
        assert.equal(job.acceptLocalFit, true);
        assert.ok(job.steps[0].warnings.some((w) => /huge:70b needs about [\d.]+ GB .* You chose to use it anyway; it may be very slow or fail/.test(w)));
        assert.equal(lastSet(await recordLines(hermesFile), "model.default"), "agentos-huge-70b:64k");
      });

      // Tight is allowed without accepting, and says so on the step.
      resetSetupJobsForTest();
      const tight = await waitForJob((await startConfigureJob({ targets: { hermes: { mode: "ollama", model: "tight:7b" } } })).id);
      assert.equal(tight.status, "succeeded");
      assert.equal(tight.acceptLocalFit, false);
      assert.ok(tight.steps[0].warnings.some((w) => /tight:7b is a tight fit: it needs about [\d.]+ GB of memory at 64K and this computer has [\d.]+ GB\. Expect it to be slow/.test(w)));
    });
  });
});

test("Local: a model whose name can't become a valid copy name gives a plain error before anything runs; the lock is released", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await withFakeOllama(home, async () => {
      await assert.rejects(
        () => startConfigureJob({ targets: { hermes: { mode: "ollama", model: "Mixed-Case:7b" } } }),
        (e) => e.code === "invalid_variant_name" && /Can't make a 64K copy of "Mixed-Case:7b"/.test(e.message) && /use OpenRouter/.test(e.message)
      );
      assert.equal(ollamaCreateCalls.length, 0);
      assert.equal(mutating(await recordLines(path.join(home, ".fake-hermes-record.jsonl"))).length, 0);

      // Over HTTP it is a 400 with the same sentence.
      await withRouterApp(async (base) => {
        const res = await fetch(`${base}/api/setup/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true, targets: { hermes: { mode: "ollama", model: "Mixed-Case:7b" } } })
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error, "invalid_variant_name");
        assert.match(body.message, /Can't make a 64K copy/);
      });

      // Nothing is left holding the one-job lock: a normal job starts straight away.
      const next = await startConfigureJob({ targets: { hermes: { mode: "ollama", model: "llama3:8b" } } });
      assert.equal((await waitForJob(next.id)).status, "succeeded");
    });
  });
});

test("job lock: configure starts that arrive together give exactly one job; a start that throws releases the lock", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeHermesShim(home);
    await installFakeOpenclawShim(home);

    // setup throws (OpenClaw not accepted) -> the lock must not stay claimed.
    await assert.rejects(
      () => startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k" }),
      (e) => e.code === "openclaw_risk_not_accepted"
    );

    const request = () => startConfigureJob({ targets: { hermes: { mode: "openrouter", model: "free/128k" } }, apiKey: VALID_KEY });
    const results = await Promise.allSettled([request(), request(), request()]);
    const started = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(started.length, 1, "exactly one job may start");
    assert.equal(refused.length, 2);
    for (const r of refused) assert.equal(r.reason.code, "job_already_running");
    assert.equal((await waitForJob(started[0].value.id)).status, "succeeded");

    // The key reached the agent exactly once (one job, not three).
    const stdinKeys = (await recordLines(path.join(home, ".fake-hermes-record.jsonl"))).filter((e) => e.stdinKey === VALID_KEY);
    assert.equal(stdinKeys.length, 1);
  });
});

test("hermesKeyStrategy(): the private-prompt attempt is skipped on Windows (it would only hang); old Hermes uses config set", () => {
  const withFlag = "usage: hermes auth add [--api-key API_KEY] [--label LABEL] provider";
  assert.equal(hermesKeyStrategy({ platform: "darwin", authHelpText: withFlag }), "prompt-then-api-key");
  assert.equal(hermesKeyStrategy({ platform: "linux", authHelpText: withFlag }), "prompt-then-api-key");
  assert.equal(hermesKeyStrategy({ platform: "win32", authHelpText: withFlag }), "api-key");
  assert.equal(hermesKeyStrategy({ platform: "darwin", authHelpText: "usage: hermes auth add provider" }), "config-set");
  assert.equal(hermesKeyStrategy({ platform: "win32", authHelpText: "" }), "config-set");
});
