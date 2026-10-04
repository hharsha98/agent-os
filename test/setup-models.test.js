// "Change model" and OpenRouter presets for Hermes and OpenClaw: the model
// catalog (mapping, sorting, searching, paging, the account's own list), one
// model by id, which model an agent uses now, changing it (the exact commands
// per agent, the hello check), presets, and opening OpenRouter's pages.
// Everything runs against a temp HOME and temp AGENT_OS_HOME, a 127.0.0.1
// mirror standing in for openrouter.ai, and fake hermes/openclaw CLIs on a
// PATH that holds only the fake folder and the system folders. No real agent,
// browser or openrouter.ai is ever touched. The fake CLIs are POSIX shebang
// scripts, so the parts that run them are POSIX-only.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { clearBrainCacheForTest } from "../server/runtime/setup/brain.js";
import { resetSetupJobsForTest } from "../server/runtime/setup/jobs.js";
import {
  OPENROUTER_BROWSE_URL,
  OPENROUTER_NEW_PRESET_URL,
  OPENROUTER_PRESETS_URL,
  cleanCliText,
  clearCatalogCacheForTest,
  hermesModelCommands,
  listCatalog,
  mapCatalogModel,
  modelPageUrl,
  openclawModelRef,
  openclawOverrideWarnings,
  parseCatalogQuery,
  parseConfigText,
  parseJsonOutput,
  parseModelId,
  parsePresetSlug,
  presetModelId,
  priceLabel
} from "../server/runtime/setup/models.js";
import {
  consumeStart,
  handleCallback,
  inspectFlowForTest,
  openSystemBrowser,
  peekKey,
  resetForTest as resetOpenRouterFlows,
  setBrowserOpenerForTest,
  startFlow
} from "../server/runtime/setup/openrouter-oauth.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";
import { setServerPort } from "../server/runtime/server-info.js";
import { clearSystemCheckCache } from "../server/runtime/setup/system-check.js";

const isWindows = process.platform === "win32";
const posixSkip = { skip: isWindows ? "spawns shebang fake CLIs (POSIX-only)" : false };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const VALID_KEY = "sk-or-v1-MODELSTEST-valid-0000";

// ---- fake CLIs ---------------------------------------------------------------------------
// Both record every call (argv, and what came in on standard input) under
// their own temp HOME. Behaviour switches are marker files in that HOME.

const FAKE_HERMES_SOURCE = `
import { existsSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
const print = (t) => process.stdout.write(t + "\\n");
const exists = (name) => existsSync(path.join(home, name));
const record = (extra = {}) => {
  try { appendFileSync(path.join(home, ".fake-hermes-record.jsonl"), JSON.stringify({ argv: args, ...extra }) + "\\n"); } catch {}
};
const configFile = path.join(home, ".fake-hermes-config.json");
const readConfig = () => { try { return JSON.parse(readFileSync(configFile, "utf8")); } catch { return {}; } };

if (!(args[0] === "auth" && args[1] === "add" && !args.includes("--help"))) record();
if (args.includes("--version")) { print("hermes 0.99.0-test"); process.exit(0); }
if (args[0] === "chat" && args.includes("--help")) { print("Usage: hermes chat\\n  --query-file PATH\\n  --oneshot\\n  -Q, --quiet"); process.exit(0); }
if (args[0] === "auth" && args[1] === "add" && args.includes("--help")) {
  print("usage: hermes auth add [-h] [--type {oauth,api-key,api_key}] [--api-key API_KEY] [--label LABEL] provider");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "add") {
  let stdinKey = "";
  try { stdinKey = readFileSync(0, "utf8").trim(); } catch {}
  record({ stdinKey });
  const config = readConfig();
  config["auth.openrouter"] = "added";
  writeFileSync(configFile, JSON.stringify(config));
  print("added");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") {
  if (exists(".fake-hermes-set-fail")) { process.stderr.write("error: the value was refused\\n"); process.exit(1); }
  const config = readConfig();
  config[args[2]] = args[3];
  writeFileSync(configFile, JSON.stringify(config));
  print("ok");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get") {
  if (args[2] === "approvals.mode") { print("on"); process.exit(0); }
  const value = readConfig()[args[2]];
  if (value === undefined) { print(""); process.exit(0); }
  print(args.includes("--json") ? JSON.stringify(value) : String(value));
  process.exit(0);
}
if (args[0] === "chat") {
  if (exists(".fake-hermes-chat-fail")) { process.stderr.write("simulated chat failure\\n"); process.exit(2); }
  print("ready");
  process.exit(0);
}
if (args[0] === "doctor") { print("Everything looks good."); process.exit(0); }
if (args[0] === "gateway" && args[1] === "status") {
  print(exists(".fake-hermes-gateway-running") ? "Gateway is supervised by launchd (PID 123)" : "gateway is not running");
  process.exit(0);
}
if (args[0] === "gateway" && (args[1] === "install" || args[1] === "start")) {
  writeFileSync(path.join(home, ".fake-hermes-gateway-running"), "1");
  print("ok");
  process.exit(0);
}
print("fake-hermes: " + JSON.stringify(args));
process.exit(0);
`;

const FAKE_OPENCLAW_SOURCE = `
import { existsSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
const print = (t) => process.stdout.write(t + "\\n");
const exists = (name) => existsSync(path.join(home, name));
const readText = (name) => { try { return readFileSync(path.join(home, name), "utf8").trim(); } catch { return ""; } };
let stdinText = "";
if (args[0] === "agent" && args[1] === "exec" && !args.includes("--help")) { try { stdinText = readFileSync(0, "utf8"); } catch {} }
try { appendFileSync(path.join(home, ".fake-openclaw-record.jsonl"), JSON.stringify({ argv: args, stdin: stdinText }) + "\\n"); } catch {}
const storeFile = path.join(home, ".fake-openclaw-primary");
const reject = (why) => { process.stderr.write("Error: " + why + "\\n"); process.exit(1); };

if (args.includes("--version")) { print("openclaw 9.9.9-test"); process.exit(0); }
if (args[0] === "agent" && args[1] === "exec" && args.includes("--help")) { print("Usage\\n --message-file PATH\\n --cwd DIR\\n --json"); process.exit(0); }
if (args[0] === "agent" && args.includes("--help")) { print("Usage\\n --session-id ID\\n --message-file PATH\\n --json\\n --model MODEL"); process.exit(0); }
if (args[0] === "doctor") { print(JSON.stringify({ ok: true, findings: [] })); process.exit(0); }
if (args[0] === "gateway" && args[1] === "status") { print(JSON.stringify({ running: exists(".fake-openclaw-gateway-running") })); process.exit(0); }
if (args[0] === "config" && args[1] === "get") {
  if (args[2] === "agents.defaults.model.primary") { print(readText(".fake-openclaw-primary")); process.exit(0); }
  if (args[2] === "agents.entries") { print(readText(".fake-openclaw-entries.json")); process.exit(0); }
  if (args[2] === "modelPolicy.allow") { print(readText(".fake-openclaw-allow.json")); process.exit(0); }
  if (args[2] === "tools.exec.mode") { print("ask"); process.exit(0); }
  print("");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set" && args[2] === "agents.defaults.model.primary") {
  const ref = args[3] || "";
  if (exists(".fake-openclaw-reject-all")) reject('Unknown model "' + ref + '". Run openclaw models list to see the models you can use.');
  if (exists(".fake-openclaw-reject-presets") && ref.includes("@preset/")) reject('Unknown model "' + ref + '".');
  if (!args.includes("--dry-run")) writeFileSync(storeFile, ref);
  print(args.includes("--dry-run") ? "Dry run ok" : "ok");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") { print("ok"); process.exit(0); }
if (args[0] === "models" && args[1] === "set") {
  if (exists(".fake-openclaw-models-set-reject")) reject("that model is not allowed");
  writeFileSync(storeFile, args[2] || "");
  print("ok");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "exec") {
  if (exists(".fake-openclaw-agent-fail")) { process.stderr.write("simulated agent failure\\n"); process.exit(2); }
  print(JSON.stringify({ ok: true, final: "ready" }));
  process.exit(0);
}
if (args[0] === "agent") {
  if (exists(".fake-openclaw-agent-fail")) { process.stderr.write("simulated agent failure\\n"); process.exit(2); }
  print(JSON.stringify({ status: "ok", result: { payloads: [{ text: "ready" }], meta: {} } }));
  process.exit(0);
}
print("fake-openclaw: " + JSON.stringify(args));
process.exit(0);
`;

// ---- the fake OpenRouter -----------------------------------------------------------------

const NOW_S = Math.floor(Date.now() / 1000);
const CATALOG = [
  {
    id: "vendor/big-agent",
    name: "Big Agent",
    description: "A strong agentic model.  It   plans well.",
    context_length: 1000000,
    pricing: { prompt: "0.000003", completion: "0.000015" },
    supported_parameters: ["tools", "temperature"],
    created: NOW_S - 5 * 86400,
    architecture: { input_modalities: ["text", "image"] },
    top_provider: { max_completion_tokens: 64000 }
  },
  {
    id: "vendor/mid:free",
    name: "Mid (free)",
    context_length: 131072,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools"],
    created: NOW_S - 90 * 86400,
    top_provider: { max_completion_tokens: null }
  },
  {
    id: "vendor/small",
    name: "Small",
    context_length: 32000,
    pricing: { prompt: "0.0000001", completion: "0.0000004" },
    supported_parameters: ["tools"],
    created: NOW_S - 400 * 86400
  },
  {
    id: "openrouter/auto",
    name: "Auto Router",
    context_length: 2000000,
    pricing: { prompt: "-1", completion: "-1" },
    supported_parameters: ["tools"],
    created: NOW_S - 200 * 86400
  },
  {
    id: "openrouter/free",
    name: "Free Router",
    context_length: 200000,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools"],
    created: NOW_S - 100 * 86400
  },
  {
    id: "vendor/no-tools",
    name: "No Tools",
    context_length: 128000,
    pricing: { prompt: "0.000001", completion: "0.000001" },
    supported_parameters: ["temperature"]
  },
  {
    id: "vendor/retiring",
    name: "Retiring Soon",
    context_length: 128000,
    pricing: { prompt: "0.0000005", completion: "0.000002" },
    supported_parameters: ["tools"],
    expiration_date: "2026-12-01"
  },
  { id: "bad id with spaces", name: "Bad", context_length: 100000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }
];
// The models this account's guardrails allow (everything except big-agent;
// no-tools is in the list, to show the tools filter is applied again).
const ACCOUNT_IDS = new Set(["vendor/mid:free", "vendor/small", "openrouter/auto", "openrouter/free", "vendor/no-tools", "vendor/retiring"]);
const PRESETS = new Set(["my-agent-brain"]);

let mirrorServer = null;
let mirrorPort = 0;
let mirrorLog = []; // { url, auth }
let mirrorIgnoresToolsFilter = false;
let accountKeyBehavior = "ok"; // ok | 401
const oauthCodes = {};

const hitsFor = (pathname) => mirrorLog.filter((hit) => new URL(hit.url, "http://m.local").pathname === pathname);

before(async () => {
  mirrorServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mirror.local");
    mirrorLog.push({ url: req.url, auth: req.headers.authorization || "" });
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/openrouter.ai/api/v1/models") {
      let list = [...CATALOG];
      if (url.searchParams.get("supported_parameters") === "tools" && !mirrorIgnoresToolsFilter) {
        list = list.filter((m) => m.supported_parameters.includes("tools"));
      }
      const q = url.searchParams.get("q");
      if (q) list = list.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q.toLowerCase()));
      const sort = url.searchParams.get("sort");
      if (sort === "context-high-to-low") list.sort((a, b) => b.context_length - a.context_length);
      if (sort === "pricing-low-to-high") list.sort((a, b) => Number(a.pricing.prompt) - Number(b.pricing.prompt));
      return json(200, { data: list, total_count: list.length });
    }
    if (url.pathname === "/openrouter.ai/api/v1/models/user") {
      if (accountKeyBehavior === "401" || req.headers.authorization !== `Bearer ${VALID_KEY}`) return json(401, { error: "bad key" });
      return json(200, { data: CATALOG.filter((m) => ACCOUNT_IDS.has(m.id)) });
    }
    if (url.pathname.startsWith("/openrouter.ai/api/v1/model/")) {
      const wanted = decodeURIComponent(url.pathname.slice("/openrouter.ai/api/v1/model/".length));
      // Like the real endpoint: an alias or ":free" resolves to the base model.
      const found = CATALOG.find((m) => m.id === wanted) || CATALOG.find((m) => m.id === wanted.replace(/:free$/, ""));
      return found ? json(200, { data: found }) : json(404, { error: { message: "No such model" } });
    }
    if (url.pathname.startsWith("/openrouter.ai/api/v1/presets/")) {
      if (req.headers.authorization !== `Bearer ${VALID_KEY}`) return json(401, { error: "bad key" });
      return PRESETS.has(url.pathname.split("/").pop()) ? json(200, { data: { slug: "my-agent-brain" } }) : json(404, { error: "No such preset" });
    }
    // Sign-in: /auth sends the browser back with a code; /auth/keys trades it for the key.
    if (url.pathname === "/openrouter.ai/auth") {
      const code = `code${Object.keys(oauthCodes).length}${Date.now().toString(36)}`;
      oauthCodes[code] = { used: false };
      res.writeHead(302, { Location: `${url.searchParams.get("callback_url")}?code=${code}&state=${url.searchParams.get("state")}` });
      res.end();
      return;
    }
    if (url.pathname === "/openrouter.ai/api/v1/auth/keys" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const record = oauthCodes[body.code];
      if (!record || record.used) return json(403, { error: { message: "Invalid code" } });
      record.used = true;
      return json(200, { key: VALID_KEY });
    }
    if (url.pathname === "/openrouter.ai/api/v1/key") {
      return req.headers.authorization === `Bearer ${VALID_KEY}` ? json(200, { data: { label: "Agent OS", is_free_tier: false } }) : json(401, { error: "bad key" });
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

// ---- helpers -------------------------------------------------------------------------------

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

async function installShim(binDir, name, source, home) {
  const jsDir = path.join(home, ".fake-cli");
  await mkdir(jsDir, { recursive: true });
  const jsPath = path.join(jsDir, `${name}.mjs`);
  await writeFile(jsPath, source);
  const shim = path.join(binDir, name);
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`);
  await chmod(shim, 0o755);
}

async function recordLines(home, agent) {
  const text = await readFile(path.join(home, `.fake-${agent}-record.jsonl`), "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Only the calls that CHANGE something.
const setCalls = (lines) => lines.filter((l) => l.argv[0] === "config" && l.argv[1] === "set").map((l) => l.argv);

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

// A temp HOME (with the fake agents on a PATH of fake folder + system folders),
// a temp AGENT_OS_HOME, the mirror, and the setup router on a local port.
async function withModelEnv(fn, { hermes = true, openclaw = true, hermesConfig, openclawPrimary, gatewayRunning = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-models-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-models-runtime-"));
  const binDir = path.join(home, "fake-bin");
  await mkdir(binDir, { recursive: true });
  if (hermes) await installShim(binDir, "hermes", FAKE_HERMES_SOURCE, home);
  if (openclaw) await installShim(binDir, "openclaw", FAKE_OPENCLAW_SOURCE, home);
  const hermesStart = hermesConfig === undefined ? { "model.provider": "openrouter", "model.default": "vendor/old" } : hermesConfig;
  await writeFile(path.join(home, ".fake-hermes-config.json"), JSON.stringify(hermesStart));
  await writeFile(path.join(home, ".fake-openclaw-primary"), openclawPrimary === undefined ? "openrouter/vendor/old" : openclawPrimary);
  if (gatewayRunning) await writeFile(path.join(home, ".fake-openclaw-gateway-running"), "1");

  mirrorLog = [];
  mirrorIgnoresToolsFilter = false;
  accountKeyBehavior = "ok";
  for (const key of Object.keys(oauthCodes)) delete oauthCodes[key];
  const opened = [];
  const bodies = [];
  const app = express();
  app.use(express.json());
  app.use("/api/setup", createSetupRouter());
  app.use((error, _req, res, _next) => {
    res.status(error?.status || 500).json({ ok: false, error: error?.message || "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, urlPath, body) => {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const waitForJob = async (id, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = (await call("GET", `/api/setup/jobs/${id}`)).body;
      if (job && job.status !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`job ${id} did not finish within ${timeoutMs}ms`);
  };
  // Does what the person's browser and OpenRouter do, in process: a connected
  // sign-in whose key lives only in memory. Resolves its flow id.
  const connect = async () => {
    setServerPort(port);
    const { flowId, authUrl } = startFlow({ port });
    const start = consumeStart(new URL(authUrl).pathname.split("/").pop());
    assert.equal(start.status, 302);
    const location = (await fetch(start.location, { redirect: "manual" })).headers.get("location");
    const params = new URL(location).searchParams;
    const done = await handleCallback({ code: params.get("code"), state: params.get("state"), cookie: start.cookie });
    assert.equal(done.httpStatus, 200);
    return flowId;
  };

  try {
    await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirrorPort}`,
        // never the real Ollama (nothing here asks it, but nothing should be able to)
        AGENT_OS_OLLAMA_URL: `http://127.0.0.1:${mirrorPort}`,
        AGENT_OS_NO_BROWSER: "1",
        PATH: [binDir, ...SYSTEM_PATH_DIRS].join(path.delimiter),
        HERMES_HOME: undefined,
        HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
        HERMES_AGENT_OS_PUBLIC_MODE: undefined,
        DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_DEMO_PUBLIC: undefined
      },
      async () => {
        clearSystemCheckCache();
        clearDetectCaches();
        clearBrainCacheForTest();
        clearCatalogCacheForTest();
        resetSetupJobsForTest();
        resetOpenRouterFlows();
        setBrowserOpenerForTest((url) => {
          opened.push(url);
          return { opened: true };
        });
        await fn({ home, agentOsHome, base, port, call, waitForJob, connect, opened, bodies });
      }
    );
  } finally {
    resetOpenRouterFlows();
    resetSetupJobsForTest();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
  }
}

// =====================================================================
// 1. Mapping one catalog entry
// =====================================================================

test("mapCatalogModel(): fields, price labels (-1, :free, zero-priced without :free), Hermes fit, New, page link", () => {
  const byId = Object.fromEntries(CATALOG.map((raw) => [raw.id, mapCatalogModel(raw)]));

  const big = byId["vendor/big-agent"];
  assert.equal(big.name, "Big Agent");
  assert.equal(big.description, "A strong agentic model. It plans well.", "whitespace collapsed");
  assert.equal(big.contextLength, 1000000);
  assert.equal(big.maxCompletionTokens, 64000);
  assert.deepEqual(big.inputModalities, ["text", "image"]);
  assert.deepEqual(big.pricing, { promptPerM: 3, completionPerM: 15, label: "$3.00 per 1M in · $15.00 out" });
  assert.equal(big.free, false);
  assert.equal(big.rateLimitedFree, false);
  assert.equal(big.hermesOk, true);
  assert.equal(big.isNew, true, "created 5 days ago");
  assert.equal(big.pageUrl, "https://openrouter.ai/vendor/big-agent");
  assert.equal(big.expiresAt, null);

  const free = byId["vendor/mid:free"];
  assert.equal(free.pricing.label, "Free (rate-limited)");
  assert.equal(free.free, true);
  assert.equal(free.rateLimitedFree, true);
  assert.equal(free.isNew, false, "created 90 days ago");
  assert.equal(free.maxCompletionTokens, null);
  assert.equal(free.pageUrl, "https://openrouter.ai/vendor/mid", "the page link drops :free");

  const small = byId["vendor/small"];
  assert.equal(small.hermesOk, false, "32K is under Hermes's 64K");
  assert.equal(small.pricing.label, "$0.10 per 1M in · $0.40 out");

  // A router: "-1" is never shown as a negative price.
  const auto = byId["openrouter/auto"];
  assert.equal(auto.pricing.label, "Price varies (router)");
  assert.equal(auto.pricing.promptPerM, null);
  assert.equal(auto.free, false);
  assert.ok(!JSON.stringify(auto.pricing).includes("-1"));

  // Zero-priced WITHOUT the :free suffix is not hidden, and not "rate-limited".
  const router = byId["openrouter/free"];
  assert.equal(router.free, true);
  assert.equal(router.rateLimitedFree, false);
  assert.equal(router.pricing.label, "Free");

  assert.equal(byId["vendor/retiring"].expiresAt, "2026-12-01");
  assert.equal(byId["bad id with spaces"], null, "an id the apply route would refuse is never offered");

  // Exactly 64,000 works for Hermes; a tiny price keeps three decimals.
  assert.equal(mapCatalogModel({ id: "a/b", context_length: 64000 }).hermesOk, true);
  assert.equal(mapCatalogModel({ id: "a/b", context_length: 63999 }).hermesOk, false);
  assert.equal(priceLabel({ prompt: "0.000000005", completion: "0.00000002" }, "a/b"), "$0.005 per 1M in · $0.02 out");
  assert.equal(priceLabel({}, "a/b"), "Price not listed");
  assert.equal(priceLabel(undefined, "a/b"), "Price not listed");
  // One side free and the other paid is not "free".
  assert.equal(mapCatalogModel({ id: "a/b", pricing: { prompt: "0", completion: "0.000001" } }).free, false);
  // A long description is cut to 300 characters.
  assert.equal(mapCatalogModel({ id: "a/b", description: "x".repeat(500) }).description.length, 300);
});

// =====================================================================
// 2. Checking what comes in
// =====================================================================

test("parseModelId()/parsePresetSlug(): only author/model and lower-case slugs, never a flag or a path trick", () => {
  for (const good of ["vendor/big-agent", "vendor/mid:free", "openrouter/auto", "anthropic/claude-sonnet-4.6", "~vendor/latest", "@preset/x", "  vendor/big-agent  "]) {
    assert.ok(parseModelId(good), good);
  }
  for (const bad of ["", "-a/b", "--help", "vendor", "a/b/c", "a b/c", "a/b c", "a/b;rm -rf", "$(id)/x", "a/b|c", "../etc", "a/..", "./x", "/x", "x/", "https://openrouter.ai/a/b", `${"x".repeat(120)}/y`, 5, null, undefined, ["a/b"]]) {
    assert.equal(parseModelId(bad), null, String(bad));
  }
  assert.equal(parseModelId("  vendor/big-agent "), "vendor/big-agent", "trimmed");
  assert.equal(parseModelId(`${"x".repeat(60)}/${"y".repeat(59)}`), `${"x".repeat(60)}/${"y".repeat(59)}`, "120 characters is the limit");

  for (const good of ["my-agent-brain", "a", "0abc", "a".repeat(64)]) assert.equal(parsePresetSlug(good), good);
  for (const bad of ["", "My-Preset", "-x", "a_b", "a b", "a".repeat(65), "../x", "a/b", "@preset/x", 7, null]) {
    assert.equal(parsePresetSlug(bad), null, String(bad));
  }
  assert.equal(presetModelId("my-agent-brain"), "@preset/my-agent-brain");
  assert.equal(modelPageUrl("vendor/big-agent:free"), "https://openrouter.ai/vendor/big-agent");
});

test("parseCatalogQuery(): sort must be a documented one, q is capped and clean, paging is bounded", () => {
  assert.deepEqual(parseCatalogQuery({ tools: "1" }).value, { tools: true, free: "all", sort: "", q: "", offset: 0, limit: 50 });
  assert.deepEqual(
    parseCatalogQuery({ tools: "1", free: "only", sort: "agentic-high-to-low", q: "  claude ", offset: "50", limit: "25" }).value,
    { tools: true, free: "only", sort: "agentic-high-to-low", q: "claude", offset: 50, limit: 25 }
  );
  assert.equal(parseCatalogQuery({ tools: "0" }).value.tools, false);
  for (const sort of ["newest", "pricing-low-to-high", "context-high-to-low", "agentic-high-to-low", "most-popular"]) {
    assert.ok(parseCatalogQuery({ sort }).value, sort);
  }
  for (const bad of [
    { sort: "made-up" },
    { sort: "newest&limit=1000" },
    { sort: ["newest", "newest"] },
    { free: "yes" },
    { tools: "true" },
    { q: "x".repeat(101) },
    { q: "line\nbreak" },
    { q: ["a", "b"] },
    { offset: "-1" },
    { offset: "10001" },
    { limit: "0" },
    { limit: "101" },
    { limit: "ten" }
  ]) {
    assert.ok(parseCatalogQuery(bad).error, JSON.stringify(bad));
  }
  assert.equal(parseCatalogQuery({ q: "x".repeat(100) }).value.q.length, 100);
});

test("parseConfigText()/parseJsonOutput()/cleanCliText()/openclawOverrideWarnings(): plain reading of what the CLIs print", () => {
  assert.equal(parseConfigText('"vendor/big-agent"\n'), "vendor/big-agent");
  assert.equal(parseConfigText("vendor/big-agent"), "vendor/big-agent");
  assert.equal(parseConfigText("OpenClaw 9.9.9 (abc) — banner line\nopenrouter/vendor/x:free"), "openrouter/vendor/x:free", "the value is the last line");
  assert.equal(parseConfigText("\u001b[32mopenrouter\u001b[0m"), "openrouter");
  for (const none of ["", "null", "None", "unset", "agents.defaults.model.primary is not set", "<script>alert(1)</script>"]) {
    assert.equal(parseConfigText(none), null, none);
  }
  assert.deepEqual(parseJsonOutput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonOutput('OpenClaw 9.9.9 banner\n{\n  "a": 1\n}'), { a: 1 }, "a banner line before the JSON");
  assert.equal(parseJsonOutput("not json"), null);
  assert.equal(parseJsonOutput(""), null);

  assert.equal(cleanCliText("OpenClaw 2026.9.6 (eb377ac) — All your chats\n\u001b[31mError:\u001b[0m Unknown model \"x\".\n  Try again."), 'Error: Unknown model "x". Try again.');
  assert.equal(cleanCliText("a".repeat(500)).length, 240);
  assert.equal(cleanCliText(undefined), "");

  assert.deepEqual(hermesModelCommands("vendor/x"), [
    ["config", "set", "model.provider", "openrouter"],
    ["config", "set", "model.default", "vendor/x"]
  ]);
  assert.equal(openclawModelRef("vendor/x:free"), "openrouter/vendor/x:free");

  const ref = "openrouter/vendor/x";
  assert.deepEqual(openclawOverrideWarnings(undefined, undefined, ref), []);
  assert.deepEqual(openclawOverrideWarnings({ main: { name: "Main" } }, [], ref), [], "no model of its own, no list: nothing to say");
  const warnings = openclawOverrideWarnings({ scribe: { model: "openrouter/old/thing" }, plain: {} }, ["openrouter/other/x"], ref);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /"scribe" has its own model \(openrouter\/old\/thing\)/);
  assert.match(warnings[1], /modelPolicy\.allow.*openrouter\/vendor\/x is not on that list/);
  assert.deepEqual(openclawOverrideWarnings(null, [ref], ref), [], "on the allow-list: fine");
  // An odd agent name or model is never printed.
  assert.deepEqual(openclawOverrideWarnings({ "<b>evil</b>": { model: "x" } }, null, ref), []);
  assert.ok(!openclawOverrideWarnings({ ok: { model: "<script>" } }, null, ref)[0].includes("<script>"));
});

// =====================================================================
// 3. The catalog
// =====================================================================

test("listCatalog(): asks OpenRouter for tools + sort + q, keeps its order, filters free, pages, caches for 2 minutes", async () => {
  await withModelEnv(async () => {
    const all = await listCatalog({ tools: true, free: "all", sort: "context-high-to-low" });
    assert.equal(all.source, "public");
    assert.equal(all.error, undefined);
    // no-tools is not offered; the id with spaces is dropped; OpenRouter's order stands.
    const expected = CATALOG.filter((m) => m.supported_parameters.includes("tools") && !m.id.includes(" "))
      .sort((a, b) => b.context_length - a.context_length)
      .map((m) => m.id);
    assert.deepEqual(all.models.map((m) => m.id), expected);
    assert.equal(all.total, 6);
    assert.equal(all.hasMore, false);
    const upstream = hitsFor("/openrouter.ai/api/v1/models");
    assert.equal(upstream.length, 1);
    const params = new URL(upstream[0].url, "http://m.local").searchParams;
    assert.equal(params.get("supported_parameters"), "tools");
    assert.equal(params.get("sort"), "context-high-to-low");
    assert.equal(params.get("q"), null);
    assert.equal(upstream[0].auth, "", "the public list is asked for without any key");

    // Free only keeps the zero-priced ones, including a router without ":free".
    const onlyFree = await listCatalog({ tools: true, free: "only", sort: "context-high-to-low" });
    assert.deepEqual(onlyFree.models.map((m) => m.id), ["openrouter/free", "vendor/mid:free"]);
    assert.equal(onlyFree.total, 2);
    assert.equal(hitsFor("/openrouter.ai/api/v1/models").length, 1, "the same catalog is served from the 2-minute cache");

    // Paging works on the filtered list.
    const first = await listCatalog({ tools: true, sort: "context-high-to-low", offset: 0, limit: 4 });
    assert.equal(first.models.length, 4);
    assert.equal(first.hasMore, true);
    const second = await listCatalog({ tools: true, sort: "context-high-to-low", offset: 4, limit: 4 });
    assert.equal(second.models.length, 2);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.models, ...second.models].map((m) => m.id)).size, 6, "no overlap");

    // The search text goes upstream percent-encoded.
    const found = await listCatalog({ tools: true, q: "big agent & more" });
    assert.deepEqual(found.models, []);
    const searchHit = hitsFor("/openrouter.ai/api/v1/models").pop();
    assert.equal(new URL(searchHit.url, "http://m.local").searchParams.get("q"), "big agent & more");
    assert.ok(searchHit.url.includes("q=big%20agent%20%26%20more"), searchHit.url);
    assert.deepEqual((await listCatalog({ tools: true, q: "Big" })).models.map((m) => m.id), ["vendor/big-agent"]);

    // Not asking for tools lists the model without them too.
    const everything = await listCatalog({ tools: false });
    assert.ok(everything.models.some((m) => m.id === "vendor/no-tools"));
  });
});

test("listCatalog(): a model that doesn't list tools is never offered, even if OpenRouter's filter lets it through", async () => {
  await withModelEnv(async () => {
    mirrorIgnoresToolsFilter = true;
    const result = await listCatalog({ tools: true });
    assert.ok(!result.models.some((m) => m.id === "vendor/no-tools"));
  });
});

test("listCatalog(): an OpenRouter outage is a plain sentence, not a crash", async () => {
  await withModelEnv(async () => {
    await withEnv({ AGENT_OS_SETUP_MIRROR: "http://127.0.0.1:9" }, async () => {
      clearCatalogCacheForTest();
      const result = await listCatalog({ tools: true });
      assert.deepEqual(result.models, []);
      assert.match(result.error, /Couldn't reach OpenRouter/);
    });
  });
});

test("listCatalog(): with a connected key it keeps only the models THIS account may use; a refused key falls back to the public list", async () => {
  await withModelEnv(async () => {
    const withKey = await listCatalog({ tools: true, key: VALID_KEY });
    assert.equal(withKey.source, "account");
    assert.ok(!withKey.models.some((m) => m.id === "vendor/big-agent"), "blocked by the account's guardrails");
    assert.ok(!withKey.models.some((m) => m.id === "vendor/no-tools"), "tools are filtered by us, the account list has no such filter");
    assert.ok(withKey.models.some((m) => m.id === "vendor/mid:free"));
    const userHits = hitsFor("/openrouter.ai/api/v1/models/user");
    assert.equal(userHits.length, 1);
    assert.equal(userHits[0].auth, `Bearer ${VALID_KEY}`);
    assert.ok(!JSON.stringify(withKey).includes(VALID_KEY), "the key is never in the answer");

    accountKeyBehavior = "401";
    const refused = await listCatalog({ tools: true, key: VALID_KEY });
    assert.equal(refused.source, "public");
    assert.equal(refused.keyRejected, true);
    assert.ok(refused.models.some((m) => m.id === "vendor/big-agent"), "the public list again");
    assert.ok(!JSON.stringify(refused).includes(VALID_KEY));
  });
});

test("GET /openrouter/models: no settings = the old short free list; settings = the catalog; bad settings = 400 with a plain code", async () => {
  await withModelEnv(async ({ call, connect }) => {
    const legacy = await call("GET", "/api/setup/openrouter/models");
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.body.models));
    assert.ok("recommended" in legacy.body, "the Setup cards still get their short list and recommendation");
    assert.ok(legacy.body.models.every((m) => !("pricing" in m)));

    const catalog = await call("GET", "/api/setup/openrouter/models?tools=1&free=all&sort=agentic-high-to-low&limit=3");
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.models.length, 3);
    assert.equal(catalog.body.limit, 3);
    assert.ok(catalog.body.models[0].pricing.label);
    assert.equal(new URL(hitsFor("/openrouter.ai/api/v1/models").pop().url, "http://m.local").searchParams.get("sort"), "agentic-high-to-low");

    for (const query of ["sort=made-up", `q=${"x".repeat(101)}`, "free=maybe", "limit=1000", "offset=-5", "sort=a&sort=b"]) {
      const bad = await call("GET", `/api/setup/openrouter/models?tools=1&${query}`);
      assert.equal(bad.status, 400, query);
      assert.equal(bad.body.error, "invalid_catalog_query", query);
      assert.ok(bad.body.message);
    }
    assert.equal((await call("GET", "/api/setup/openrouter/models?flowId=not-a-flow")).body.error, "invalid_flow_id");

    // A connected sign-in narrows the list to the account's models.
    const flowId = await connect();
    const account = await call("GET", `/api/setup/openrouter/models?tools=1&flowId=${flowId}`);
    assert.equal(account.body.source, "account");
    assert.ok(!account.body.models.some((m) => m.id === "vendor/big-agent"));
    assert.ok(!JSON.stringify(account.body).includes(VALID_KEY));
    // An unknown (or used-up) sign-in is simply the public list.
    const unknown = await call("GET", `/api/setup/openrouter/models?tools=1&flowId=${"a".repeat(32)}`);
    assert.equal(unknown.body.source, "public");
  });
});

// =====================================================================
// 4. One model by id (the "paste a model ID" path)
// =====================================================================

test("GET /openrouter/models/lookup: details for a real id, ':free' kept, a plain 404, a 400 for a bad id", async () => {
  await withModelEnv(async ({ call }) => {
    const found = await call("GET", "/api/setup/openrouter/models/lookup?id=vendor/big-agent");
    assert.equal(found.status, 200);
    assert.equal(found.body.model.id, "vendor/big-agent");
    assert.equal(found.body.model.name, "Big Agent");
    assert.equal(found.body.model.pricing.label, "$3.00 per 1M in · $15.00 out");
    assert.equal(found.body.model.contextLength, 1000000);
    assert.equal(hitsFor("/openrouter.ai/api/v1/model/vendor/big-agent").length, 1, "asked through the singular endpoint");

    // ":free" is accepted, and the id asked for is the id applied.
    const free = await call("GET", `/api/setup/openrouter/models/lookup?id=${encodeURIComponent("vendor/mid:free")}`);
    assert.equal(free.status, 200);
    assert.equal(free.body.model.id, "vendor/mid:free");
    assert.equal(free.body.model.rateLimitedFree, true);
    const aliased = await call("GET", `/api/setup/openrouter/models/lookup?id=${encodeURIComponent("vendor/big-agent:free")}`);
    assert.equal(aliased.body.model.id, "vendor/big-agent:free", "the id the person chose");
    assert.equal(aliased.body.model.rateLimitedFree, false, "it costs money, whatever the suffix says");

    const missing = await call("GET", "/api/setup/openrouter/models/lookup?id=vendor/does-not-exist");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "model_not_found");
    assert.match(missing.body.message, /OpenRouter doesn't know that model/);

    const before = mirrorLog.length;
    for (const bad of ["", "vendor", "-x/y", "a/b/c", "../x", "a/b;rm", "a%20b/c", encodeURIComponent("a/..")]) {
      const res = await call("GET", `/api/setup/openrouter/models/lookup?id=${bad}`);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error, "invalid_model_id", bad);
    }
    assert.equal((await call("GET", "/api/setup/openrouter/models/lookup")).status, 400, "no id at all");
    assert.equal(mirrorLog.length, before, "a bad id never reaches OpenRouter");
  });
});

// =====================================================================
// 5. Opening OpenRouter's pages
// =====================================================================

test("open routes: only OpenRouter pages built here are opened; a bad model id is a 400 and opens nothing", async () => {
  await withModelEnv(async ({ call, opened }) => {
    assert.equal((await call("POST", "/api/setup/openrouter/presets/open", {})).status, 400, "confirm is required");
    assert.equal((await call("POST", "/api/setup/openrouter/models/open", {})).status, 400, "confirm is required");

    const presets = await call("POST", "/api/setup/openrouter/presets/open", { confirm: true });
    assert.deepEqual(presets.body, { opened: true, url: OPENROUTER_PRESETS_URL });
    const created = await call("POST", "/api/setup/openrouter/presets/open", { confirm: true, new: true });
    assert.equal(created.body.url, OPENROUTER_NEW_PRESET_URL);
    const browse = await call("POST", "/api/setup/openrouter/models/open", { confirm: true });
    assert.equal(browse.body.url, "https://openrouter.ai/models?supported_parameters=tools");
    const page = await call("POST", "/api/setup/openrouter/models/open", { confirm: true, id: "vendor/mid:free" });
    assert.equal(page.body.url, "https://openrouter.ai/vendor/mid");
    assert.deepEqual(opened, [
      "https://openrouter.ai/settings/presets",
      "https://openrouter.ai/settings/presets/new",
      "https://openrouter.ai/models?supported_parameters=tools",
      "https://openrouter.ai/vendor/mid"
    ]);

    opened.length = 0;
    for (const id of ["vendor/x;open -a Calculator", "https://evil.example/a/b", "../../etc", "-a/b", 5, null, ""]) {
      const res = await call("POST", "/api/setup/openrouter/models/open", { confirm: true, id });
      assert.equal(res.status, 400, String(id));
      assert.equal(res.body.error, "invalid_model_id");
    }
    assert.deepEqual(opened, [], "nothing was opened");
  });
});

test("open routes: where the browser can't be opened the address comes back as a link; outside local mode nothing is opened at all", async () => {
  await withModelEnv(async ({ call, opened }) => {
    setBrowserOpenerForTest(() => ({ opened: false, reason: "spawn_failed" }));
    const failed = await call("POST", "/api/setup/openrouter/presets/open", { confirm: true });
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.body, { opened: false, url: OPENROUTER_PRESETS_URL, reason: "spawn_failed" });

    setBrowserOpenerForTest((url) => {
      opened.push(url);
      return { opened: true };
    });
    await withEnv({ HERMES_AGENT_OS_PUBLIC_MODE: "1" }, async () => {
      const remote = await call("POST", "/api/setup/openrouter/models/open", { confirm: true });
      assert.deepEqual(remote.body, { opened: false, reason: "not_local", url: OPENROUTER_BROWSE_URL });
    });
    assert.deepEqual(opened, []);
  });
});

test("openSystemBrowser(): the new OpenRouter pages pass the allowlist; look-alike addresses don't", async () => {
  const child = () => {
    const emitter = new EventEmitter();
    emitter.unref = () => {};
    setImmediate(() => emitter.emit("spawn"));
    return emitter;
  };
  for (const url of [OPENROUTER_BROWSE_URL, OPENROUTER_PRESETS_URL, OPENROUTER_NEW_PRESET_URL, modelPageUrl("vendor/big-agent:free")]) {
    const calls = [];
    const result = await openSystemBrowser(url, {
      spawnFn: (command, argv, options) => {
        calls.push({ command, argv, options });
        return child();
      },
      platform: "darwin"
    });
    assert.deepEqual(result, { opened: true }, url);
    assert.deepEqual(calls[0].argv, [url], "ONE argument, never a shell string");
    assert.equal(calls[0].options.shell, false);
  }
  for (const bad of [
    "https://openrouter.ai.evil.example/models",
    "https://evil.example/https://openrouter.ai/models",
    "http://openrouter.ai/models",
    "https://openrouter.ai@evil.example/models",
    "https://openrouter.ai/models\n--evil"
  ]) {
    assert.deepEqual(await openSystemBrowser(bad, { spawnFn: () => child(), platform: "darwin" }), { opened: false, reason: "blocked_url" }, bad);
  }
});

// =====================================================================
// 6. Which model does each agent use now?
// =====================================================================

test("GET /agents/:id/model: reads Hermes and OpenClaw through their own config get; Local, presets and 'not set' are told apart", posixSkip, async () => {
  await withModelEnv(async ({ call, home }) => {
    const hermes = await call("GET", "/api/setup/agents/hermes/model");
    assert.equal(hermes.status, 200);
    assert.deepEqual(hermes.body, {
      agentId: "hermes",
      installed: true,
      provider: "openrouter",
      providerLabel: "OpenRouter",
      model: "vendor/old",
      isPreset: false,
      presetSlug: null
    });
    const openclaw = await call("GET", "/api/setup/agents/openclaw/model");
    assert.equal(openclaw.body.provider, "openrouter");
    assert.equal(openclaw.body.model, "vendor/old");

    // Local: Hermes's "custom" provider with the 64K copy Agent OS made; OpenClaw's "ollama/...".
    await writeFile(path.join(home, ".fake-hermes-config.json"), JSON.stringify({ "model.provider": "custom", "model.default": "agentos-qwen3-14b:64k" }));
    await writeFile(path.join(home, ".fake-openclaw-primary"), "ollama/agentos-qwen3-14b:64k");
    const localHermes = (await call("GET", "/api/setup/agents/hermes/model")).body;
    assert.equal(localHermes.providerLabel, "Local (Ollama)");
    assert.equal(localHermes.model, "agentos-qwen3-14b:64k");
    assert.equal((await call("GET", "/api/setup/agents/openclaw/model")).body.providerLabel, "Local (Ollama)");
    // A "custom" provider with some other model is just "custom", never called Local.
    await writeFile(path.join(home, ".fake-hermes-config.json"), JSON.stringify({ "model.provider": "custom", "model.default": "something-else" }));
    assert.equal((await call("GET", "/api/setup/agents/hermes/model")).body.providerLabel, "custom");

    // A preset, and an agent with no model at all.
    await writeFile(path.join(home, ".fake-hermes-config.json"), JSON.stringify({ "model.provider": "openrouter", "model.default": "@preset/my-agent-brain" }));
    const preset = (await call("GET", "/api/setup/agents/hermes/model")).body;
    assert.equal(preset.isPreset, true);
    assert.equal(preset.presetSlug, "my-agent-brain");
    await writeFile(path.join(home, ".fake-openclaw-primary"), "");
    const unset = (await call("GET", "/api/setup/agents/openclaw/model")).body;
    assert.equal(unset.model, null);
    assert.equal(unset.provider, null);

    assert.equal((await call("GET", "/api/setup/agents/codex/model")).status, 404);
  });

  // An agent that isn't installed says so, honestly.
  await withModelEnv(
    async ({ call }) => {
      const missing = await call("GET", "/api/setup/agents/openclaw/model");
      assert.equal(missing.status, 200);
      assert.equal(missing.body.installed, false);
      assert.equal(missing.body.model, null);
    },
    { openclaw: false }
  );
});

// =====================================================================
// 7. Changing the model: the exact commands per agent
// =====================================================================

test("apply to Hermes: provider openrouter, then model.default with NO openrouter/ prefix, then the hello check; the job and receipt say so", posixSkip, async () => {
  await withModelEnv(async ({ call, home, waitForJob, agentOsHome }) => {
    const started = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/big-agent", confirm: true });
    assert.equal(started.status, 200);
    assert.equal(started.body.kind, "model");
    assert.equal(started.body.agentId, "hermes");
    assert.deepEqual(started.body.steps.map((s) => s.id), ["hermes-model", "health"]);
    assert.deepEqual(started.body.previous, { provider: "openrouter", model: "vendor/old" });
    const job = await waitForJob(started.body.id);
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.scope, ["hermes"]);
    assert.deepEqual(job.targets, { hermes: { mode: "openrouter", model: "vendor/big-agent" }, openclaw: null });
    assert.equal(job.health.hermes.promptOk, true, "the hello check answered");

    const lines = await recordLines(home, "hermes");
    assert.deepEqual(setCalls(lines), [
      ["config", "set", "model.provider", "openrouter"],
      ["config", "set", "model.default", "vendor/big-agent"]
    ]);
    assert.ok(!lines.some((l) => l.argv.some((a) => /^openrouter\/vendor/.test(a))), "Hermes gets the plain id");
    assert.ok(!lines.some((l) => l.argv[0] === "auth"), "the agent already has its key; nothing is added");
    assert.ok(lines.some((l) => l.argv[0] === "chat"), "and it said hello");
    assert.equal(await readFile(path.join(home, ".fake-openclaw-primary"), "utf8"), "openrouter/vendor/old", "OpenClaw was not touched");
    assert.equal(setCalls(await recordLines(home, "openclaw")).length, 0);

    const read = (await call("GET", "/api/setup/agents/hermes/model")).body;
    assert.equal(read.model, "vendor/big-agent");

    const receipt = JSON.parse(await readFile(path.join(agentOsHome, "setup", "receipt.json"), "utf8"));
    const entry = receipt.find((e) => e.agentId === "hermes");
    assert.equal(entry.provider, "openrouter");
    assert.equal(entry.model, "vendor/big-agent");
    assert.match(entry.changes[0], /Changed the model to vendor\/big-agent \(it was vendor\/old\)/);

    // One of OpenRouter's own routers already starts with "openrouter/": it stays as it is.
    const router = await call("POST", "/api/setup/agents/hermes/model", { model: "openrouter/auto", confirm: true });
    assert.equal((await waitForJob(router.body.id)).status, "succeeded");
    assert.deepEqual(setCalls(await recordLines(home, "hermes")).slice(-1)[0], ["config", "set", "model.default", "openrouter/auto"]);
  });
});

test("apply to OpenClaw: the openrouter/ reference, a --dry-run first, then the same command for real; warns about overrides and pinned chats", posixSkip, async () => {
  await withModelEnv(
    async ({ call, home, waitForJob }) => {
      await writeFile(path.join(home, ".fake-openclaw-entries.json"), JSON.stringify({ scribe: { model: "openrouter/old/thing" }, main: { name: "Main" } }));
      await writeFile(path.join(home, ".fake-openclaw-allow.json"), JSON.stringify(["openrouter/other/x"]));
      const started = await call("POST", "/api/setup/agents/openclaw/model", { model: "vendor/mid:free", confirm: true });
      assert.equal(started.status, 200);
      const job = await waitForJob(started.body.id);
      assert.equal(job.status, "succeeded");
      assert.deepEqual(job.scope, ["openclaw"]);
      assert.equal(job.health.openclaw.promptOk, true);

      const sets = setCalls(await recordLines(home, "openclaw"));
      assert.deepEqual(sets, [
        ["config", "set", "agents.defaults.model.primary", "openrouter/vendor/mid:free", "--dry-run"],
        ["config", "set", "agents.defaults.model.primary", "openrouter/vendor/mid:free"]
      ]);
      assert.equal(await readFile(path.join(home, ".fake-openclaw-primary"), "utf8"), "openrouter/vendor/mid:free");
      assert.equal(sets.flat().filter((a) => a === "--dry-run").length, 1, "only the first try is a dry run");

      const step = job.steps.find((s) => s.id === "openclaw-model");
      assert.equal(step.warnings.length, 2);
      assert.ok(step.warnings.some((w) => /"scribe" has its own model/.test(w)));
      assert.ok(step.warnings.some((w) => /modelPolicy\.allow/.test(w)));
      assert.match(step.log.join("\n"), /\/model default/, "chats with a pinned model keep it");

      // The hello check ran on a conversation of its own (a pinned old one could answer instead).
      const hello = (await recordLines(home, "openclaw")).find((l) => l.argv[0] === "agent" && l.argv.includes("--message-file"));
      const sessionId = hello.argv[hello.argv.indexOf("--session-id") + 1];
      assert.match(sessionId, /^agentos-check-[a-f0-9]{8}$/);

      // Hermes was not touched, and a router keeps its own prefix inside the reference.
      assert.equal(setCalls(await recordLines(home, "hermes")).length, 0);
      const router = await call("POST", "/api/setup/agents/openclaw/model", { model: "openrouter/auto", confirm: true });
      assert.equal((await waitForJob(router.body.id)).status, "succeeded");
      assert.equal(setCalls(await recordLines(home, "openclaw")).slice(-1)[0][3], "openrouter/openrouter/auto");
    },
    { gatewayRunning: true }
  );
});

test("apply to OpenClaw: its strict refusal is shown plainly after the dry run, nothing is written, and Try again resumes the same job", posixSkip, async () => {
  await withModelEnv(async ({ call, home, waitForJob }) => {
    await writeFile(path.join(home, ".fake-openclaw-reject-all"), "1");
    const started = await call("POST", "/api/setup/agents/openclaw/model", { model: "vendor/mid:free", confirm: true });
    assert.equal(started.status, 200);
    const job = await waitForJob(started.body.id);
    assert.equal(job.status, "failed");
    const failed = job.steps.find((s) => s.status === "failed");
    assert.equal(failed.id, "openclaw-model");
    assert.match(failed.error, /^OpenClaw didn't accept vendor\/mid:free: Error: Unknown model "openrouter\/vendor\/mid:free"/);
    assert.deepEqual(setCalls(await recordLines(home, "openclaw")), [
      ["config", "set", "agents.defaults.model.primary", "openrouter/vendor/mid:free", "--dry-run"]
    ]);
    assert.equal(await readFile(path.join(home, ".fake-openclaw-primary"), "utf8"), "openrouter/vendor/old", "still the old model");
    assert.equal(job.health, undefined, "no hello check after a refusal");

    // Once OpenClaw would accept it, the same job resumes (no key is involved).
    await rm(path.join(home, ".fake-openclaw-reject-all"), { force: true });
    const retried = await call("POST", `/api/setup/jobs/${job.id}/retry`);
    assert.equal(retried.status, 200);
    const done = await waitForJob(job.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.health.openclaw.promptOk, true);
    assert.equal(await readFile(path.join(home, ".fake-openclaw-primary"), "utf8"), "openrouter/vendor/mid:free");
  });
});

test("a failed hello check is reported plainly (the job ran, the model is set, the agent did not answer)", posixSkip, async () => {
  await withModelEnv(async ({ call, home, waitForJob }) => {
    await writeFile(path.join(home, ".fake-hermes-chat-fail"), "1");
    const started = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/mid:free", confirm: true });
    const job = await waitForJob(started.body.id);
    assert.equal(job.status, "succeeded", "the commands worked");
    assert.equal(job.health.hermes.promptOk, false);
    assert.ok(job.health.hermes.hint, "a plain next step");
    assert.match(job.health.hermes.hint, /pick another model|Open its run/);
    assert.deepEqual(setCalls(await recordLines(home, "hermes")).slice(-1)[0], ["config", "set", "model.default", "vendor/mid:free"]);
  });
});

test("a Hermes config set that is refused fails the job with what Hermes said", posixSkip, async () => {
  await withModelEnv(async ({ call, home, waitForJob }) => {
    await writeFile(path.join(home, ".fake-hermes-set-fail"), "1");
    const started = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/mid:free", confirm: true });
    const job = await waitForJob(started.body.id);
    assert.equal(job.status, "failed");
    assert.match(job.steps[0].error, /^Hermes didn't accept vendor\/mid:free: error: the value was refused/);
  });
});

// =====================================================================
// 8. Refusals before anything runs
// =====================================================================

test("apply: Hermes refuses a model under 64K (with a plain reason); OpenClaw takes it; unknown models and bad ids are 400/404 and run nothing", posixSkip, async () => {
  await withModelEnv(async ({ call, home, waitForJob }) => {
    const small = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/small", confirm: true });
    assert.equal(small.status, 400);
    assert.equal(small.body.error, "model_too_small_for_hermes");
    assert.match(small.body.message, /at least 64K/);
    assert.equal(setCalls(await recordLines(home, "hermes")).length, 0);

    const forOpenclaw = await call("POST", "/api/setup/agents/openclaw/model", { model: "vendor/small", confirm: true });
    assert.equal(forOpenclaw.status, 200);
    assert.equal((await waitForJob(forOpenclaw.body.id)).status, "succeeded");

    const unknown = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/does-not-exist", confirm: true });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "model_not_found");

    const invalid = ["", "vendor", "-x/y", "--help", "a/b;rm -rf", "a b/c", "$(id)/x", "../x", "a/b/c", "https://openrouter.ai/a/b", `${"x".repeat(200)}/y`, 7, null, ["a/b"]];
    for (const model of invalid) {
      const res = await call("POST", "/api/setup/agents/hermes/model", { model, confirm: true });
      assert.equal(res.status, 400, JSON.stringify(model));
      assert.equal(res.body.error, "invalid_model_id", JSON.stringify(model));
    }
    assert.equal((await call("POST", "/api/setup/agents/hermes/model", { confirm: true })).status, 400, "no model at all");
    assert.equal((await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/mid:free" })).status, 400, "confirm is required");
    assert.equal((await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/mid:free", confirm: "yes" })).status, 400, "confirm must be exactly true");
    assert.equal((await call("POST", "/api/setup/agents/codex/model", { model: "vendor/mid:free", confirm: true })).status, 404, "only Hermes and OpenClaw");
    assert.equal(setCalls(await recordLines(home, "hermes")).length, 0, "nothing was ever changed");
  });
});

test("apply: an agent that isn't installed is a plain 409, not a crash", posixSkip, async () => {
  await withModelEnv(
    async ({ call }) => {
      const res = await call("POST", "/api/setup/agents/openclaw/model", { model: "vendor/mid:free", confirm: true });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, "agent_not_installed");
      assert.match(res.body.message, /OpenClaw isn't installed/);
    },
    { openclaw: false }
  );
});

// =====================================================================
// 9. Presets (beta)
// =====================================================================

test("preset: Hermes gets @preset/<name> through model.default; an unknown name (404 on openrouter.ai) is a plain error and runs nothing", posixSkip, async () => {
  await withModelEnv(async ({ call, home, waitForJob, connect }) => {
    const flowId = await connect();

    // A connected sign-in lets us ask OpenRouter first.
    const missing = await call("POST", "/api/setup/agents/hermes/preset", { slug: "no-such-preset", confirm: true, keySource: { flowId } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "preset_not_found");
    assert.match(missing.body.message, /no preset with that name/);
    assert.equal(hitsFor("/openrouter.ai/api/v1/presets/no-such-preset")[0].auth, `Bearer ${VALID_KEY}`);
    assert.equal(setCalls(await recordLines(home, "hermes")).length, 0);

    const started = await call("POST", "/api/setup/agents/hermes/preset", { slug: "my-agent-brain", confirm: true, keySource: { flowId } });
    assert.equal(started.status, 200);
    assert.equal(started.body.kind, "model", "Hermes is already on OpenRouter, so only its model changes");
    assert.equal(started.body.preset, "my-agent-brain");
    const job = await waitForJob(started.body.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.health.hermes.promptOk, true, "the hello test through the preset is what says yes");
    assert.deepEqual(setCalls(await recordLines(home, "hermes")), [
      ["config", "set", "model.provider", "openrouter"],
      ["config", "set", "model.default", "@preset/my-agent-brain"]
    ]);
    assert.equal(peekKey(flowId), VALID_KEY, "checking a preset didn't use the connection up");
    const read = (await call("GET", "/api/setup/agents/hermes/model")).body;
    assert.deepEqual([read.isPreset, read.presetSlug], [true, "my-agent-brain"]);

    for (const bad of ["", "My-Preset", "-x", "a_b", "a b", "a/b", "@preset/x", "a".repeat(65), 7, null]) {
      const res = await call("POST", "/api/setup/agents/hermes/preset", { slug: bad, confirm: true });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.error, "invalid_preset");
    }
    assert.equal((await call("POST", "/api/setup/agents/hermes/preset", { slug: "my-agent-brain" })).status, 400, "confirm is required");
    assert.equal((await call("POST", "/api/setup/agents/hermes/preset", { slug: "x", confirm: true, keySource: { flowId: "nope" } })).body.error, "invalid_flow_id");
  });
});

test("preset without a connected key: no existence check (OpenRouter can't be asked); the hello test decides", posixSkip, async () => {
  await withModelEnv(async ({ call, waitForJob, home }) => {
    await writeFile(path.join(home, ".fake-hermes-chat-fail"), "1");
    const started = await call("POST", "/api/setup/agents/hermes/preset", { slug: "whatever-name", confirm: true });
    assert.equal(started.status, 200);
    assert.equal(hitsFor("/openrouter.ai/api/v1/presets/whatever-name").length, 0);
    const job = await waitForJob(started.body.id);
    assert.equal(job.health.hermes.promptOk, false, "a name that doesn't work shows up as a failed hello, not a green tick");
  });
});

test("preset on OpenClaw: tries the strict dry run, falls back to `models set`, and says plainly when neither accepts it", posixSkip, async () => {
  await withModelEnv(async ({ call, home, waitForJob }) => {
    // OpenClaw's strict check refuses presets, but `models set` takes them.
    await writeFile(path.join(home, ".fake-openclaw-reject-presets"), "1");
    const started = await call("POST", "/api/setup/agents/openclaw/preset", { slug: "my-agent-brain", confirm: true });
    assert.equal(started.status, 200);
    const job = await waitForJob(started.body.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.health.openclaw.promptOk, true);
    const lines = await recordLines(home, "openclaw");
    assert.deepEqual(setCalls(lines), [["config", "set", "agents.defaults.model.primary", "openrouter/@preset/my-agent-brain", "--dry-run"]]);
    assert.ok(lines.some((l) => l.argv[0] === "models" && l.argv[1] === "set" && l.argv[2] === "openrouter/@preset/my-agent-brain"));
    assert.match(job.steps.find((s) => s.id === "openclaw-model").log.join("\n"), /config check refused the preset/);

    // Refused both ways: the plain "doesn't accept presets yet", and the old model is untouched.
    await writeFile(path.join(home, ".fake-openclaw-primary"), "openrouter/vendor/old");
    await writeFile(path.join(home, ".fake-openclaw-models-set-reject"), "1");
    const again = await call("POST", "/api/setup/agents/openclaw/preset", { slug: "my-agent-brain", confirm: true });
    const refused = await waitForJob(again.body.id);
    assert.equal(refused.status, "failed");
    assert.equal(refused.steps.find((s) => s.status === "failed").error, "OpenClaw doesn't accept OpenRouter presets yet. Use Change model to pick a model instead.");
    assert.equal(await readFile(path.join(home, ".fake-openclaw-primary"), "utf8"), "openrouter/vendor/old");

    // When OpenClaw accepts the preset in its normal strict way, no fallback is needed.
    await rm(path.join(home, ".fake-openclaw-reject-presets"), { force: true });
    await rm(path.join(home, ".fake-openclaw-models-set-reject"), { force: true });
    const direct = await call("POST", "/api/setup/agents/openclaw/preset", { slug: "my-agent-brain", confirm: true });
    assert.equal((await waitForJob(direct.body.id)).status, "succeeded");
    assert.deepEqual(setCalls(await recordLines(home, "openclaw")).slice(-2), [
      ["config", "set", "agents.defaults.model.primary", "openrouter/@preset/my-agent-brain", "--dry-run"],
      ["config", "set", "agents.defaults.model.primary", "openrouter/@preset/my-agent-brain"]
    ]);
  });
});

// =====================================================================
// 10. An agent that is not on OpenRouter yet needs the key (Local -> OpenRouter)
// =====================================================================

test("Local to OpenRouter needs a connected sign-in; with one the agent's own key is set too, and the key leaks nowhere", posixSkip, async () => {
  await withModelEnv(
    async ({ call, home, agentOsHome, waitForJob, connect, bodies }) => {
      // No connection: "Connect OpenRouter first" and nothing runs.
      const none = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/mid:free", confirm: true });
      assert.equal(none.status, 409);
      assert.equal(none.body.error, "connection_not_ready");
      assert.equal(none.body.message, "Connect OpenRouter first, then try again.");
      const bogus = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/mid:free", confirm: true, keySource: { flowId: "a".repeat(32) } });
      assert.equal(bogus.status, 409, "a flow that was never connected");
      assert.equal(setCalls(await recordLines(home, "hermes")).length, 0);

      // OpenClaw's brain job needs the person to accept its risk note first.
      const flowForOpenclaw = await connect();
      const noRisk = await call("POST", "/api/setup/agents/openclaw/model", { model: "vendor/mid:free", confirm: true, keySource: { flowId: flowForOpenclaw } });
      assert.equal(noRisk.status, 400);
      assert.equal(noRisk.body.error, "openclaw_risk_not_accepted");
      assert.equal(peekKey(flowForOpenclaw), VALID_KEY, "a refused request doesn't use the connection up");

      const flowId = await connect();
      const started = await call("POST", "/api/setup/agents/hermes/model", { model: "vendor/mid:free", confirm: true, keySource: { flowId } });
      assert.equal(started.status, 200);
      assert.equal(started.body.kind, "configure", "the full brain job: key, provider, model, hello");
      assert.deepEqual(started.body.scope, ["hermes"]);
      assert.equal(started.body.targets.hermes.model, "vendor/mid:free");
      assert.equal(started.body.targets.openclaw, null);
      const job = await waitForJob(started.body.id);
      assert.equal(job.status, "succeeded");
      assert.equal(job.health.hermes.promptOk, true);

      const lines = await recordLines(home, "hermes");
      assert.ok(lines.some((l) => l.stdinKey === VALID_KEY), "Hermes got the key on its private prompt");
      assert.ok(lines.every((l) => !l.argv.includes(VALID_KEY)), "never on a command line");
      assert.deepEqual(setCalls(lines).slice(-2), [
        ["config", "set", "model.provider", "openrouter"],
        ["config", "set", "model.default", "vendor/mid:free"]
      ]);
      assert.equal(peekKey(flowId), null, "the connection was used up");

      // The key appears nowhere: not in any answer, not in any file the app wrote.
      for (const body of bodies) assert.ok(!body.includes(VALID_KEY), "the key leaked into an API answer");
      for (const file of await walkFiles(agentOsHome)) {
        assert.ok(!(await readFile(file, "utf8").catch(() => "")).includes(VALID_KEY), `the key leaked into ${file}`);
      }
      assert.equal(inspectFlowForTest(flowId).key, null);
    },
    { hermesConfig: { "model.provider": "custom", "model.default": "agentos-qwen3-14b:64k" }, openclawPrimary: "ollama/agentos-qwen3-14b:64k" }
  );
});
