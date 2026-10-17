// Local models (Ollama): the plain verdict for each installed model, what to
// download for how much memory, "Choose for me", and the download job with
// real progress and Cancel. A fake Ollama on 127.0.0.1 stands in for the real
// one (AGENT_OS_OLLAMA_URL); a fake `ollama` binary is the only thing on PATH
// besides the system folders. No real agent or Ollama is ever started.
import assert from "node:assert/strict";
import express from "express";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import {
  LOCAL_CONTEXT_TOKENS,
  LOCAL_MODEL_TABLE,
  OLLAMA_MODEL_NAME_PATTERN,
  brainOptions,
  clearBrainCacheForTest,
  ensureLocalVariant,
  estimateLocalMemory,
  kvBytesPerToken,
  listLocalModels,
  localBrainSummary,
  localModelVerdict,
  localVariantName,
  ollamaModelInfo,
  parseParameterSize,
  pickRecommendedFreeModel,
  recommendedLocalModel
} from "../server/runtime/setup/brain.js";
import { cancelSetupJob, getSetupJob, resetSetupJobsForTest, retrySetupJob, startOllamaPull } from "../server/runtime/setup/jobs.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";
import { clearSystemCheckCache } from "../server/runtime/setup/system-check.js";

const isWindows = process.platform === "win32";
const posixSkip = { skip: isWindows ? "uses a shebang fake `ollama` binary (POSIX-only)" : false };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

// ---- a fake Ollama ------------------------------------------------------------

// qwen3-shaped numbers, as /api/show reports them. qwen3 14B: 40 layers, 8 KV
// heads, head size 128 -> 163,840 bytes of working memory per token.
function qwen3Info(layers, kvHeads, contextLength = 40960) {
  return {
    "general.architecture": "qwen3",
    "qwen3.block_count": layers,
    "qwen3.attention.head_count": 32,
    "qwen3.attention.head_count_kv": kvHeads,
    "qwen3.attention.key_length": 128,
    "qwen3.attention.value_length": 128,
    "qwen3.context_length": contextLength
  };
}

const INSTALLED = {
  "llama3.2:3b": { size: 2_000_000_000, details: { parameter_size: "3.2B" }, capabilities: ["completion", "tools"] },
  "qwen3:8b": { size: 5_200_000_000, details: { parameter_size: "8.2B" }, capabilities: ["completion", "tools"], model_info: qwen3Info(36, 8) },
  "gemma:7b": { size: 4_800_000_000, details: { parameter_size: "8.5B" }, capabilities: ["completion"] },
  "nomic-embed-text:latest": { size: 270_000_000, details: { parameter_size: "137M" }, capabilities: ["embedding"] },
  "old-ollama:7b": { size: 4_000_000_000, details: { parameter_size: "7.0B" } },
  "tiny:970m": { size: 600_000_000, details: { parameter_size: "970M" }, capabilities: ["completion", "tools"] }
};

let ollama = null;
let ollamaPort = 0;
let pullSeen = { closed: 0, bodies: [] };
// Settings-only copies the fake has been asked to make (POST /api/create),
// the requests it saw, and how it should behave.
let variants = {};
let createSeen = [];
let createBehavior = "ok"; // ok | fail | dropctx

before(async () => {
  ollama = http.createServer(async (req, res) => {
    const readBody = async () => {
      let text = "";
      for await (const chunk of req) text += chunk;
      return text ? JSON.parse(text) : {};
    };
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const copies = Object.entries(variants).map(([name, v]) => ({ name, model: name, size: INSTALLED[v.from]?.size || 0 }));
      res.end(JSON.stringify({ models: [...Object.entries(INSTALLED).map(([name, m]) => ({ name, model: name, size: m.size })), ...copies] }));
      return;
    }
    if (req.url === "/api/create" && req.method === "POST") {
      const body = await readBody();
      createSeen.push(body);
      if (createBehavior === "fail" || !INSTALLED[body.from]) {
        res.writeHead(createBehavior === "fail" ? 500 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: createBehavior === "fail" ? "disk is full" : `model '${body.from}' not found` }));
        return;
      }
      variants[body.model] = { from: body.from, num_ctx: createBehavior === "dropctx" ? null : body.parameters?.num_ctx ?? null };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success" }));
      return;
    }
    if (req.url === "/api/show" && req.method === "POST") {
      const { model } = await readBody();
      const copy = variants[model];
      if (copy) {
        const base = INSTALLED[copy.from];
        const { size: _baseSize, ...baseRest } = base;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...baseRest, parameters: copy.num_ctx ? `num_ctx                        ${copy.num_ctx}\nstop                           "<|im_end|>"` : 'stop                           "<|im_end|>"' }));
        return;
      }
      const info = INSTALLED[model];
      if (!info) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "model not found" }));
        return;
      }
      const { size: _size, ...rest } = info;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rest));
      return;
    }
    if (req.url === "/api/pull" && req.method === "POST") {
      const body = await readBody();
      pullSeen.bodies.push(body);
      res.on("close", () => {
        pullSeen.closed += 1;
      });
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const line = (obj) => res.write(`${JSON.stringify(obj)}\n`);
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      if (body.model === "missing:model") {
        line({ status: "pulling manifest" });
        line({ error: "pull model manifest: file does not exist" });
        res.end();
        return;
      }
      if (body.model === "stall:model") {
        line({ status: "pulling manifest" });
        line({ status: "pulling aaa", digest: "aaa", total: 1000, completed: 100 });
        return; // never finishes; the client has to hang up
      }
      if (body.model === "cut:model") {
        line({ status: "pulling aaa", digest: "aaa", total: 1000, completed: 500 });
        res.end(); // ends without "success"
        return;
      }
      line({ status: "pulling manifest" });
      line({ status: "pulling aaa", digest: "aaa", total: 800, completed: 0 });
      await pause(60);
      line({ status: "pulling aaa", digest: "aaa", total: 800, completed: 400 });
      line({ status: "pulling bbb", digest: "bbb", total: 200, completed: 0 });
      await pause(60);
      line({ status: "pulling aaa", digest: "aaa", total: 800, completed: 800 });
      line({ status: "pulling bbb", digest: "bbb", total: 200, completed: 200 });
      line({ status: "verifying sha256 digest" });
      line({ status: "success" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  ollamaPort = ollama.address().port;
});

after(async () => {
  ollama.closeAllConnections?.();
  await new Promise((resolve) => ollama.close(resolve));
});

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

// Temp HOME + AGENT_OS_HOME, the fake Ollama, and a fake `ollama` binary.
async function withOllamaEnv(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-ollama-home-"));
  const agentOsHome = await mkdtemp(path.join(os.tmpdir(), "agent-os-ollama-runtime-"));
  const binDir = path.join(home, "fake-bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "ollama"), `#!/bin/sh\necho "ollama version 0.0.0-test"\n`);
  await chmod(path.join(binDir, "ollama"), 0o755);
  pullSeen = { closed: 0, bodies: [] };
  variants = {};
  createSeen = [];
  createBehavior = "ok";
  try {
    await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
        AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${ollamaPort}`, // anything unknown there is a harmless 404
        PATH: [binDir, ...SYSTEM_PATH_DIRS].join(path.delimiter),
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
    resetSetupJobsForTest();
    await rm(home, { recursive: true, force: true });
    await rm(agentOsHome, { recursive: true, force: true });
  }
}

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting");
}

async function finishedJob(id) {
  return waitFor(async () => {
    const current = await getSetupJob(id);
    return current.status !== "running" ? current : null;
  });
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
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---- 1. verdicts -------------------------------------------------------------------

test("localModelVerdict(): 3B is 'too small', no tools is 'no tool support', 7B+ with tools is good", () => {
  const small = localModelVerdict({ capabilities: ["completion", "tools"], parameterBillions: 3.2 });
  assert.equal(small.id, "too_small");
  assert.equal(small.label, "Too small for agent work (under 7B), answers may be wrong");
  assert.equal(small.selectable, true);

  const noTools = localModelVerdict({ capabilities: ["completion"], parameterBillions: 8 });
  assert.equal(noTools.id, "no_tools");
  assert.equal(noTools.label, "No tool support");
  assert.equal(noTools.selectable, false);

  assert.deepEqual(localModelVerdict({ capabilities: ["completion", "tools"], parameterBillions: 8.2 }), {
    id: "good",
    label: "Good for agent work",
    selectable: true
  });
  assert.equal(localModelVerdict({ capabilities: ["tools"], parameterBillions: 7 }).id, "good", "exactly 7B is allowed");
  assert.equal(localModelVerdict({ capabilities: ["tools"], parameterBillions: 6.9 }).id, "too_small");

  // Honest when we can't tell: never "Good" on a guess.
  assert.equal(localModelVerdict({ capabilities: null, parameterBillions: 8 }).id, "unknown");
  assert.equal(localModelVerdict({ capabilities: ["tools"], parameterBillions: null }).id, "unknown");
  assert.equal(localModelVerdict({}).id, "unknown");
  assert.equal(localModelVerdict(undefined).id, "unknown");
});

test("parseParameterSize(): reads Ollama's size strings in billions", () => {
  assert.equal(parseParameterSize("8.2B"), 8.2);
  assert.equal(parseParameterSize("7B"), 7);
  assert.equal(parseParameterSize("970M"), 0.97);
  assert.equal(parseParameterSize("671B"), 671);
  assert.equal(parseParameterSize("1.5T"), 1500);
  assert.equal(parseParameterSize(""), null);
  assert.equal(parseParameterSize("big"), null);
  assert.equal(parseParameterSize(undefined), null);
});

// ---- 2. memory: the working-memory (KV cache) maths and the fit verdict --------------------

const GIB = 1024 ** 3;

test("kvBytesPerToken(): 2 bytes x layers x KV heads x (key + value length), from /api/show's model_info", () => {
  // The worked example: qwen3 14B = 40 layers, 8 KV heads, head size 128.
  assert.equal(kvBytesPerToken(qwen3Info(40, 8)), 163_840);
  assert.equal(Math.round((163_840 * 65_536) / 1e8) / 10, 10.7, "about 10.7 GB at 65,536 tokens");

  // Without key/value length the head size is embedding_length / head_count.
  const llama = {
    "general.architecture": "llama",
    "llama.block_count": 32,
    "llama.attention.head_count": 32,
    "llama.attention.head_count_kv": 8,
    "llama.embedding_length": 4096
  };
  assert.equal(kvBytesPerToken(llama), 2 * 32 * 8 * (128 + 128));

  // head_count_kv as a list, one entry per layer: added up, NOT times block_count.
  const perLayer = {
    "general.architecture": "hybrid",
    "hybrid.block_count": 4,
    "hybrid.attention.head_count_kv": [8, 8, 0, 2],
    "hybrid.attention.key_length": 64,
    "hybrid.attention.value_length": 64
  };
  assert.equal(kvBytesPerToken(perLayer), 2 * 18 * (64 + 64));
  assert.notEqual(kvBytesPerToken(perLayer), 2 * 4 * 8 * 128);

  // Key and value lengths may differ.
  assert.equal(
    kvBytesPerToken({ ...qwen3Info(10, 2), "qwen3.attention.key_length": 192, "qwen3.attention.value_length": 128 }),
    2 * 10 * 2 * (192 + 128)
  );

  // The architecture name can come from the key itself when general.architecture is absent.
  const { "general.architecture": _arch, ...noArch } = qwen3Info(40, 8);
  assert.equal(kvBytesPerToken(noArch), 163_840);

  // Anything missing -> null (never a guess).
  assert.equal(kvBytesPerToken(undefined), null);
  assert.equal(kvBytesPerToken(null), null);
  assert.equal(kvBytesPerToken("nope"), null);
  assert.equal(kvBytesPerToken({}), null);
  assert.equal(kvBytesPerToken({ "general.architecture": "x" }), null);
  const missing = (key) => {
    const copy = { ...qwen3Info(40, 8) };
    delete copy[key];
    return copy;
  };
  assert.equal(kvBytesPerToken(missing("qwen3.block_count")), null);
  assert.equal(kvBytesPerToken(missing("qwen3.attention.head_count_kv")), null);
  // key length gone AND no embedding_length to work the head size out from:
  assert.equal(kvBytesPerToken(missing("qwen3.attention.key_length")), null);
  assert.equal(kvBytesPerToken({ ...qwen3Info(40, 8), "qwen3.attention.head_count_kv": 0 }), null);
  assert.equal(kvBytesPerToken({ ...qwen3Info(40, 8), "qwen3.attention.head_count_kv": [8, "x"] }), null);
  assert.equal(kvBytesPerToken({ ...qwen3Info(40, 8), "qwen3.attention.head_count_kv": [] }), null);
});

test("estimateLocalMemory(): weights + KV cache at 64K + 0.5 GiB, and a fit verdict against this computer's memory", () => {
  const model = { sizeBytes: 9_300_000_000, modelInfo: qwen3Info(40, 8) }; // qwen3 14B
  const need = 9_300_000_000 + 163_840 * 65_536 + 0.5 * GIB;
  const estimate = estimateLocalMemory({ ...model, ramGb: 24 });
  assert.equal(estimate.memoryAt64kGb, Math.round((need / GIB) * 10) / 10);
  assert.equal(estimate.memoryAt64kGb, 19.2);
  assert.equal(estimate.fit, "tight", "about 80% of a 24 GB computer: the owner's point, it does not fit well");
  assert.equal(estimate.nativeContext, 40960);
  assert.equal(estimate.stretched, true, "trained for 40K, asked for 64K");
  assert.equal(estimate.kvBytesPerToken, 163_840);

  assert.equal(estimateLocalMemory({ ...model, ramGb: 64 }).fit, "comfortable");
  assert.equal(estimateLocalMemory({ ...model, ramGb: 32 }).fit, "comfortable");
  assert.equal(estimateLocalMemory({ ...model, ramGb: 16 }).fit, "too_big");

  // The thresholds: <= 60% comfortable, <= 80% tight, above that too_big.
  const ramFor = (share) => need / GIB / share;
  assert.equal(estimateLocalMemory({ ...model, ramGb: ramFor(0.6) * 1.001 }).fit, "comfortable");
  assert.equal(estimateLocalMemory({ ...model, ramGb: ramFor(0.6) * 0.999 }).fit, "tight");
  assert.equal(estimateLocalMemory({ ...model, ramGb: ramFor(0.8) * 1.001 }).fit, "tight");
  assert.equal(estimateLocalMemory({ ...model, ramGb: ramFor(0.8) * 0.999 }).fit, "too_big");

  // A model with a long native window is not "stretched".
  const roomy = estimateLocalMemory({ sizeBytes: 4_900_000_000, modelInfo: qwen3Info(32, 8, 131072), ramGb: 32 });
  assert.equal(roomy.stretched, false);
  assert.equal(roomy.nativeContext, 131072);

  // Missing facts -> "unknown", never a made-up number.
  const noInfo = estimateLocalMemory({ sizeBytes: 5e9, modelInfo: undefined, ramGb: 32 });
  assert.equal(noInfo.fit, "unknown");
  assert.equal(noInfo.memoryAt64kGb, null);
  assert.equal(estimateLocalMemory({ modelInfo: qwen3Info(40, 8), ramGb: 32 }).fit, "unknown", "no size");
  assert.equal(estimateLocalMemory({}).fit, "unknown");
  const noRam = estimateLocalMemory({ ...model });
  assert.equal(noRam.fit, "unknown", "no memory figure for this computer");
  assert.equal(noRam.memoryAt64kGb, 19.2, "but the need is still stated");
});

// ---- 3. what to download: honest suggestions only ---------------------------------------------

test("LOCAL_MODEL_TABLE: every row's numbers reproduce, has a native window of 64K or more, and is listed best first", () => {
  assert.deepEqual(LOCAL_MODEL_TABLE.map((row) => row.model), ["qwen3:30b", "gpt-oss:20b", "llama3.1:8b"]);
  for (const row of LOCAL_MODEL_TABLE) {
    assert.match(row.model, OLLAMA_MODEL_NAME_PATTERN);
    assert.ok(row.nativeContext >= LOCAL_CONTEXT_TOKENS, `${row.model}: a native window below 64K would be stretched`);
    const need = row.downloadGb * 1e9 + row.kvBytesPerToken * LOCAL_CONTEXT_TOKENS + 0.5 * GIB;
    assert.equal(row.memoryAt64kGb, Math.round((need / GIB) * 10) / 10, `${row.model}: memoryAt64kGb must follow from its own numbers`);
  }
  const needs = LOCAL_MODEL_TABLE.map((row) => row.memoryAt64kGb);
  assert.deepEqual(needs, [...needs].sort((a, b) => b - a), "best (and biggest) first");
});

test("recommendedLocalModel(): a row is suggested only when it needs <= 60% of this computer's memory", () => {
  for (const [ram, expected] of [
    [0, null],
    [8, null],
    [16, null],
    [21, null],
    [22, "llama3.1:8b"],
    [24, "llama3.1:8b"],
    [27, "llama3.1:8b"],
    [28, "gpt-oss:20b"],
    [32, "gpt-oss:20b"],
    [40, "gpt-oss:20b"],
    [41, "qwen3:30b"],
    [64, "qwen3:30b"]
  ]) {
    const row = recommendedLocalModel(ram);
    assert.equal(row ? row.model : null, expected, `${ram} GB`);
    if (row) assert.ok(row.memoryAt64kGb <= ram * 0.6, `${row.model} must fit within 60% of ${ram} GB`);
  }
  assert.equal(recommendedLocalModel(undefined), null);
  assert.equal(recommendedLocalModel("lots"), null);
});

// ---- 4. installed models --------------------------------------------------------------------

test("ollamaModelInfo()/listLocalModels(): size, verdict, memory estimate, best first; embedding models and our own copies left out", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const info = await ollamaModelInfo("qwen3:8b");
    assert.equal(info.parameterBillions, 8.2);
    assert.deepEqual(info.capabilities, ["completion", "tools"]);
    assert.equal(info.contextLength, 40960);
    assert.equal(kvBytesPerToken(info.modelInfo), 147_456, "the raw model_info numbers are kept for the estimate");
    assert.equal(await ollamaModelInfo("does-not-exist:1b"), null);
    assert.equal(await ollamaModelInfo(""), null);

    // One of our own 64K copies exists: it must not appear in the list.
    await ensureLocalVariant("qwen3:8b");
    assert.ok(variants["agentos-qwen3-8b:64k"]);

    const models = await listLocalModels({ ramGb: 24 }, { refresh: true });
    const names = models.map((m) => m.name);
    assert.ok(!names.includes("nomic-embed-text:latest"), "embedding models can't be given to an agent");
    assert.ok(!names.some((n) => n.startsWith("agentos-")), "Agent OS's own copies are an internal detail");
    const verdicts = Object.fromEntries(models.map((m) => [m.name, m.verdict.id]));
    assert.deepEqual(verdicts, {
      "qwen3:8b": "good",
      "old-ollama:7b": "unknown",
      "llama3.2:3b": "too_small",
      "tiny:970m": "too_small",
      "gemma:7b": "no_tools"
    });
    assert.equal(names[0], "qwen3:8b", "good models first");
    assert.equal(names.at(-1), "gemma:7b", "unusable models last");
    const qwen = models.find((m) => m.name === "qwen3:8b");
    assert.equal(qwen.sizeBytes, 5_200_000_000);
    assert.deepEqual(qwen.memory, {
      memoryAt64kGb: 14.3,
      fit: "comfortable",
      nativeContext: 40960,
      stretched: true,
      kvBytesPerToken: 147_456
    });
    assert.equal(models.find((m) => m.name === "llama3.2:3b").memory.fit, "unknown", "no model_info: no made-up number");
    assert.equal(models.find((m) => m.name === "llama3.2:3b").verdict.label, "Too small for agent work (under 7B), answers may be wrong");

    // The same facts judged against a smaller computer.
    assert.equal((await listLocalModels({ ramGb: 16 })).find((m) => m.name === "qwen3:8b").memory.fit, "too_big");
    assert.equal((await listLocalModels({ ramGb: 20 })).find((m) => m.name === "qwen3:8b").memory.fit, "tight");
  });
});

// ---- 5. ONE source of truth: the sentence and the list can't disagree --------------------------------

const checkWith = (ramGb, found = true) => ({ ramGb, ollama: { found } });
const RECOMMEND = "We recommend OpenRouter for both agents: strong models, no big download, free to start.";

test("brainOptions(): ALWAYS openrouter; the one sentence about Local is built from the same list the Local card shows", posixSkip, async () => {
  await withOllamaEnv(async () => {
    // A good model that fits comfortably.
    const fits = await brainOptions(checkWith(64));
    assert.equal(fits.recommendation, "openrouter");
    assert.equal(fits.reason, `${RECOMMEND} You could also run qwen3:8b locally; it fits this computer (about 14.3 GB).`);
    assert.equal(fits.localModel, "qwen3:8b");

    // None fits comfortably (too big): the honest number and this computer's memory.
    const tooBig = await brainOptions(checkWith(16));
    assert.equal(tooBig.recommendation, "openrouter");
    assert.equal(tooBig.reason, `${RECOMMEND} Running locally needs about 14.3 GB of memory for the 64K working memory agents need; this computer has 16 GB.`);
    assert.equal(tooBig.localModel, null);

    // Tight is not "fits": same honest sentence, never "it fits".
    const tight = await brainOptions(checkWith(20));
    assert.ok(!/it fits/.test(tight.reason));
    assert.match(tight.reason, /needs about 14\.3 GB .* this computer has 20 GB\.$/);

    // The sentence and the list agree, number for number.
    const list = await listLocalModels(checkWith(16));
    const smallest = Math.min(...list.filter((m) => m.verdict.id === "good").map((m) => m.memory.memoryAt64kGb));
    assert.ok(tooBig.reason.includes(`about ${smallest} GB`));

    // Ollama not installed: the generic sentence, and Local is still described as an option.
    const notInstalled = await brainOptions(checkWith(32, false));
    assert.equal(notInstalled.recommendation, "openrouter");
    assert.equal(notInstalled.reason, `${RECOMMEND} Running locally needs a model you have downloaded and enough memory for the 64K working memory agents need; this computer has 32 GB.`);
    assert.equal(notInstalled.options.find((o) => o.id === "ollama").available, false);
  });
  // Only a too-small model installed: no model to name, generic sentence.
  const saved = { ...INSTALLED };
  for (const key of Object.keys(INSTALLED)) if (key !== "llama3.2:3b") delete INSTALLED[key];
  try {
    await withOllamaEnv(async () => {
      const result = await brainOptions(checkWith(32));
      assert.equal(result.recommendation, "openrouter");
      assert.match(result.reason, /needs a model you have downloaded/);
      assert.equal(result.localModel, null);
    });
  } finally {
    Object.assign(INSTALLED, saved);
  }
});

test("the installed-model list is cached ~10 s and shared: brainOptions and localBrainSummary can never disagree; refresh re-reads", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const check = checkWith(64);
    const first = await localBrainSummary(check);
    assert.ok(first.models.some((m) => m.name === "qwen3:8b"));

    // A model appears in Ollama. Within the cache window NEITHER sees it...
    INSTALLED["llama3.1:8b"] = { size: 4_900_000_000, details: { parameter_size: "8.0B" }, capabilities: ["completion", "tools"], model_info: qwen3Info(32, 8, 131072) };
    try {
      const cachedSummary = await localBrainSummary(check);
      const cachedOptions = await brainOptions(check);
      assert.ok(!cachedSummary.models.some((m) => m.name === "llama3.1:8b"));
      assert.ok(!cachedOptions.reason.includes("llama3.1:8b"));

      // ...a refresh makes both see it, because they read the same list.
      const refreshed = await brainOptions(check, { refresh: true });
      const summaryAfter = await localBrainSummary(check);
      assert.ok(summaryAfter.models.some((m) => m.name === "llama3.1:8b"), "the shared cache was refreshed");
      const named = summaryAfter.models.find((m) => m.verdict.id === "good" && m.memory.fit === "comfortable");
      assert.ok(refreshed.reason.includes(named.name), "the sentence names a model that is in the list");
      assert.ok(refreshed.reason.includes(`about ${named.memory.memoryAt64kGb} GB`));
    } finally {
      delete INSTALLED["llama3.1:8b"];
    }
  });
});

test("localBrainSummary(): what to download is honest for THIS computer's memory", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const small = await localBrainSummary(checkWith(16));
    assert.equal(small.available, true);
    assert.equal(small.download, null);
    assert.match(small.downloadAdvice, /This computer has 16 GB of memory, too little to run a local agent model with the 64K working memory agents need/);
    assert.match(small.downloadAdvice, /llama3\.1:8b/);
    assert.match(small.downloadAdvice, /13\.1 GB/);
    assert.match(small.downloadAdvice, /Use OpenRouter instead/);

    const mid = await localBrainSummary(checkWith(24));
    assert.equal(mid.download.model, "llama3.1:8b");
    assert.equal(mid.download.downloadGb, 4.9);
    assert.equal(mid.download.memoryAt64kGb, 13.1);
    assert.equal(mid.download.nativeContext, 131072);
    assert.equal(mid.download.installed, false);
    assert.equal(mid.downloadAdvice, "");

    assert.equal((await localBrainSummary(checkWith(32))).download.model, "gpt-oss:20b");
    assert.equal((await localBrainSummary(checkWith(48))).download.model, "qwen3:30b");

    const missing = await localBrainSummary(checkWith(32, false));
    assert.equal(missing.available, false);
    assert.deepEqual(missing.models, []);
    assert.match(missing.reason, /isn't installed/);
  });
});

// ---- 6. the 64K copy ------------------------------------------------------------------------------------------

test("localVariantName(): 'agentos-<base with : and / as ->:64k'; null when the name wouldn't be accepted", () => {
  assert.equal(localVariantName("qwen3:14b"), "agentos-qwen3-14b:64k");
  assert.equal(localVariantName("hf.co/org/model:q4_k_m"), "agentos-hf.co-org-model-q4_k_m:64k");
  assert.equal(localVariantName("Qwen3:8B"), null, "capitals are not allowed by OLLAMA_MODEL_NAME_PATTERN");
  assert.equal(localVariantName("a b"), null);
  assert.equal(localVariantName("x".repeat(80)), null, "too long once agentos- and :64k are added");
  for (const base of ["qwen3:14b", "llama3.2:3b", "hf.co/org/m:q4"]) assert.match(localVariantName(base), OLLAMA_MODEL_NAME_PATTERN);
});

test("ensureLocalVariant(): sends the exact /api/create body once, reuses an existing copy, and fails in plain words", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const made = await ensureLocalVariant("qwen3:8b");
    assert.deepEqual(made, { name: "agentos-qwen3-8b:64k", created: true });
    assert.deepEqual(createSeen, [{ model: "agentos-qwen3-8b:64k", from: "qwen3:8b", parameters: { num_ctx: 65536 }, stream: false }]);
    // The copy reports the 64K setting, as the check after /api/create reads it.
    assert.equal((await ollamaModelInfo("agentos-qwen3-8b:64k")).numCtx, 65536);

    const again = await ensureLocalVariant("qwen3:8b");
    assert.deepEqual(again, { name: "agentos-qwen3-8b:64k", created: false });
    assert.equal(createSeen.length, 1, "an existing 64K copy is reused: no second create call");

    // A copy that exists but has the WRONG window is not trusted: it is made again.
    variants["agentos-gemma-7b:64k"] = { from: "gemma:7b", num_ctx: 4096 };
    assert.equal((await ensureLocalVariant("gemma:7b")).created, true);
    assert.equal(createSeen.length, 2);

    // Failures are plain sentences with a code.
    createBehavior = "fail";
    await assert.rejects(
      () => ensureLocalVariant("llama3.2:3b"),
      (e) => e.code === "local_prepare_failed" && /Ollama couldn't prepare llama3\.2:3b with 64K working memory \(disk is full\)/.test(e.message)
    );
    createBehavior = "dropctx";
    await assert.rejects(
      () => ensureLocalVariant("tiny:970m"),
      (e) => e.code === "local_prepare_failed" && /did not keep the 64K setting/.test(e.message)
    );
    createBehavior = "ok";
    await assert.rejects(
      () => ensureLocalVariant("not-installed:1b"),
      (e) => e.code === "local_prepare_failed" && /not-installed:1b/.test(e.message)
    );

    // A name that can't become a valid copy name: plain error, and Ollama is not even asked.
    const before = createSeen.length;
    await assert.rejects(
      () => ensureLocalVariant("Qwen3:8B"),
      (e) => e.code === "invalid_variant_name" && /Can't make a 64K copy of "Qwen3:8B"/.test(e.message) && /use OpenRouter/.test(e.message)
    );
    assert.equal(createSeen.length, before);
  });
});

// ---- 4. the OpenRouter "recommended" pick -------------------------------------------------------------

test("pickRecommendedFreeModel(): the biggest model by the size in its name, ties by context; null for none", () => {
  const model = (id, contextLength, name = id) => ({ id, name, contextLength });
  assert.equal(pickRecommendedFreeModel([]), null);
  assert.equal(pickRecommendedFreeModel(undefined), null);
  assert.equal(
    pickRecommendedFreeModel([
      model("tiny/mini-3b:free", 1_000_000),
      model("meta-llama/llama-3.3-70b-instruct:free", 131072),
      model("qwen/qwen3-coder-480b-a35b:free", 262144),
      model("google/gemma-3-27b-it:free", 131072)
    ]),
    "qwen/qwen3-coder-480b-a35b:free"
  );
  // "a35b" (the active part) must not beat a bigger total, and 1.5b is not 15b.
  assert.equal(pickRecommendedFreeModel([model("a/x-1.5b:free", 500000), model("b/y-12b:free", 70000)]), "b/y-12b:free");
  // No sizes in any name: the longest context wins; the first wins a full tie.
  assert.equal(pickRecommendedFreeModel([model("a/one:free", 64000), model("b/two:free", 200000)]), "b/two:free");
  assert.equal(pickRecommendedFreeModel([model("a/one:free", 64000), model("b/two:free", 64000)]), "a/one:free");
});

// ---- 5. the download job -----------------------------------------------------------------------------------

test("startOllamaPull(): real progress (bytes added up across layers), then success", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const job = await startOllamaPull({ model: "qwen3:14b" });
    assert.equal(job.kind, "pull");
    assert.equal(job.status, "running");
    const seen = [];
    const finished = await waitFor(async () => {
      const current = await getSetupJob(job.id);
      seen.push(current.pull ? { ...current.pull } : null);
      return current.status !== "running" ? current : null;
    });
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(pullSeen.bodies, [{ model: "qwen3:14b", stream: true }]);
    assert.equal(finished.pull.total, 1000);
    assert.equal(finished.pull.completed, 1000);
    assert.equal(finished.steps[0].status, "succeeded");
    // Progress only ever moves forward.
    const completed = seen.filter(Boolean).map((p) => p.completed);
    for (let i = 1; i < completed.length; i += 1) assert.ok(completed[i] >= completed[i - 1]);
    // The lock is released: another job can start.
    const next = await startOllamaPull({ model: "qwen3:8b" });
    assert.equal((await finishedJob(next.id)).status, "succeeded");
  });
});

test("startOllamaPull(): Cancel hangs up on Ollama and ends 'cancelled'; one download at a time", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const job = await startOllamaPull({ model: "stall:model" });
    await waitFor(async () => (await getSetupJob(job.id)).pull?.total === 1000);
    const mid = await getSetupJob(job.id);
    assert.equal(mid.pull.completed, 100);

    await assert.rejects(() => startOllamaPull({ model: "qwen3:8b" }), (e) => e.code === "job_already_running");

    const cancelled = await cancelSetupJob(job.id);
    assert.equal(cancelled.status, "cancelled");
    await waitFor(() => pullSeen.closed >= 1);
    const stored = await waitFor(async () => {
      const current = await getSetupJob(job.id);
      return current.endedAt ? current : null;
    });
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.steps[0].error, "Cancelled.");

    // Retrying a download starts it again (Ollama keeps the finished layers).
    const retried = await retrySetupJob(job.id);
    assert.equal(retried.kind, "pull");
    assert.equal(retried.model, "stall:model");
    await cancelSetupJob(retried.id);
  });
});

test("startOllamaPull(): an error from Ollama, or a cut-off download, ends 'failed' with a plain reason", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const missing = await startOllamaPull({ model: "missing:model" });
    const failed = await finishedJob(missing.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.steps[0].error, /Ollama said: pull model manifest: file does not exist/);

    const cut = await startOllamaPull({ model: "cut:model" });
    const stopped = await finishedJob(cut.id);
    assert.equal(stopped.status, "failed");
    assert.match(stopped.steps[0].error, /stopped before it finished/);
  });
  // Ollama not running at all.
  await withOllamaEnv(async () => {
    await withEnv({ AGENT_OS_OLLAMA_URL: "http://127.0.0.1:1" }, async () => {
      const job = await startOllamaPull({ model: "qwen3:8b" });
      const failed = await finishedJob(job.id);
      assert.equal(failed.status, "failed");
      assert.match(failed.steps[0].error, /Couldn't reach Ollama/);
    });
  });
});

test("startOllamaPull(): only plain model names are accepted", async () => {
  for (const bad of ["", "  ", "Qwen3:8B", "a b", "../x", "x/y", "x".repeat(81), "qwen3:8b; rm -rf ~", "qwen3\n:8b", undefined, 5, null]) {
    await assert.rejects(() => startOllamaPull({ model: bad }), (e) => e.code === "invalid_model", String(bad));
  }
  assert.match("qwen3:14b", OLLAMA_MODEL_NAME_PATTERN);
  assert.match("hf.co-model_1.2:q4_k_m", OLLAMA_MODEL_NAME_PATTERN);
});

// ---- 6. the routes -----------------------------------------------------------------------------------------------

test("routes: /ollama/models, and /ollama/pull needs confirm:true and a valid name", posixSkip, async () => {
  await withOllamaEnv(async () => {
    await withRouterApp(async (base) => {
      const summary = await (await fetch(`${base}/api/setup/ollama/models`)).json();
      assert.equal(summary.available, true);
      assert.ok(summary.models.some((m) => m.name === "qwen3:8b" && m.verdict.id === "good"));
      assert.ok(summary.memoryGb > 0);

      const post = (body) => fetch(`${base}/api/setup/ollama/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal((await post({ model: "qwen3:8b" })).status, 400, "no confirm");
      assert.equal((await post({ model: "qwen3:8b", confirm: "yes" })).status, 400, "confirm must be exactly true");
      assert.equal(pullSeen.bodies.length, 0, "nothing was downloaded without a confirm");
      const bad = await post({ model: "../../etc/passwd", confirm: true });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error, "invalid_model");

      const ok = await post({ model: "qwen3:8b", confirm: true });
      assert.equal(ok.status, 200);
      const job = await ok.json();
      assert.equal(job.kind, "pull");
      const second = await post({ model: "qwen3:14b", confirm: true });
      assert.equal(second.status, 409, "one download at a time");
      await waitFor(async () => (await (await fetch(`${base}/api/setup/jobs/${job.id}`)).json()).status === "succeeded");
    });
  });
});

test("routes: configure with a local model allows 'too small' (the screen warns) but refuses 'no tool support' and models that aren't pulled", posixSkip, async () => {
  await withOllamaEnv(async () => {
    await withRouterApp(async (base) => {
      const configure = (model) =>
        fetch(`${base}/api/setup/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true, targets: { hermes: { mode: "ollama", model } } })
        });
      const noTools = await configure("gemma:7b");
      assert.equal(noTools.status, 400);
      assert.match((await noTools.json()).error, /no tool support/);
      const notPulled = await configure("llama3.1:70b");
      assert.equal(notPulled.status, 400);
      assert.match((await notPulled.json()).error, /already be pulled/);
      const tooSmall = await configure("llama3.2:3b");
      assert.equal(tooSmall.status, 200, "the person may still choose it");
      const job = await tooSmall.json();
      assert.equal(job.targets.hermes.model, "llama3.2:3b");
      assert.equal(job.targets.openclaw, null);
      await waitFor(async () => (await (await fetch(`${base}/api/setup/jobs/${job.id}`)).json()).status !== "running");
    });
  });
});

// ---- 7. the one-job-at-a-time lock ---------------------------------------------------------------------------

test("job lock: starts that arrive at the same moment give exactly one job; the rest get job_already_running", posixSkip, async () => {
  await withOllamaEnv(async () => {
    const results = await Promise.allSettled([
      startOllamaPull({ model: "qwen3:8b" }),
      startOllamaPull({ model: "qwen3:14b" }),
      startOllamaPull({ model: "gemma:7b" }),
      startOllamaPull({ model: "llama3.2:3b" })
    ]);
    const started = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(started.length, 1, "exactly one job may start");
    assert.equal(refused.length, 3);
    for (const r of refused) assert.equal(r.reason.code, "job_already_running");
    assert.equal((await finishedJob(started[0].value.id)).status, "succeeded");
    // ...and the lock is free again afterwards.
    const next = await startOllamaPull({ model: "qwen3:8b" });
    assert.equal((await finishedJob(next.id)).status, "succeeded");
  });
});
