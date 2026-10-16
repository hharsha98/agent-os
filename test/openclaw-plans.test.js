// OpenClaw's plan brains on the server (SP3 Task B1b; spec
// docs/superpowers/specs/2026-10-15-plan-brains-design.md sections 2, 3, 5 and 7,
// Safety 6): the pure rules, the readers with every fake shape, the three plan
// routes, both Applies (step order, the risk tick, the runtime check before
// `models set`, readiness 0/1/2, the put-back of the earlier model, and the
// hello skipped at Look only), the plan and label of OpenClaw's model answer,
// healthFixLine's plan lines, signInStatus's method, POST /api/setup/configure
// still refusing the plan modes, and a plan job that Agent OS quit during.
//
// Fakes only: the setup-brain OpenClaw fake and the builder Claude Code fake in
// a real-path temp HOME (test/helpers/openclaw-plan-env.js), W1's fakes for the
// other agent names, and a PATH of only those folders plus the system folders.
// Where a test removes the fake Claude Code, refuseSystemAgent first checks that
// no real one could be found instead. No server process and no session is
// started. Never a real agent.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ADAPTERS } from "../server/runtime/agents/index.js";
import { setExecutionGateStatus } from "../server/runtime/execution-gate.js";
import { getRunManager } from "../server/runtime/runs/run-manager.js";
import { runCommand } from "../server/runtime/safety.js";
import {
  HELLO_SKIPPED_AT_LOOK_ONLY,
  PLAN_JOB_STEPS,
  cancelSetupJob,
  getSetupJob,
  healthFixLine,
  resetSetupJobsForTest,
  retrySetupJob,
  startConfigureJob,
  startOpenclawPlanJob
} from "../server/runtime/setup/jobs.js";
import {
  CHATGPT_EXPIRING,
  CHATGPT_NOT_READY,
  CLAUDE_API_METHODS,
  CLAUDE_PLAN_METHODS,
  CURRENT_MODEL_NOT_RESTORABLE,
  CURRENT_MODEL_UNREADABLE,
  FABLE_NOTE,
  INVALID_PLAN_MODEL,
  MODEL_SETTINGS_UNREADABLE,
  OPENCLAW_PLANS,
  PLAN_FALLBACK_MODELS,
  PLAN_HEALTH_LINES,
  PLAN_JOB_INTERRUPTED,
  PLAN_MODE,
  PLAN_MODELS_AS_OF,
  PLAN_MODEL_NAMES,
  PLAN_NOT_READY_MESSAGE,
  PLAN_PROVIDER,
  PLAN_READ_TIMEOUT_MS,
  RUNTIME_CHECK_FAILED,
  TYPED_MODEL_RE,
  chatgptSignIn,
  claudeCliPinned,
  claudePlanReadiness,
  hasClaudeCliPin,
  isFableModel,
  noEarlierPrimary,
  openclawProviderLabel,
  parseAuthRows,
  planModelRows,
  planOfPrimary,
  readDidNotFinish,
  readinessOf
} from "../server/runtime/setup/openclaw-plan-rules.js";
import { readChatgptAuth, readOpenclawModelsConfig, resolvePlanModel } from "../server/runtime/setup/openclaw-plans.js";
import { readChatgptAuth as readChatgptAuthInModels, readOpenclawModelsConfig as readOpenclawModelsConfigInModels } from "../server/runtime/setup/models.js";
import { readReceipt } from "../server/runtime/setup/receipt.js";
import { signInStatus } from "../server/runtime/setup/signin.js";
import { readFakeAgentState, writeFakeAgentState } from "./helpers/fake-knobs.js";
import { FAKE_CLAUDE_CLI_PINS, FAKE_SECRET, installFakeOpenclawShim } from "./helpers/fake-openclaw.js";
import {
  CLAUDE_AUTH,
  agentEnvLog,
  listFiles,
  openclawRecord,
  readJsonLines,
  refuseSystemAgent,
  refuseSystemAgentFolders,
  siwcRow,
  waitForPlanJob,
  withEnv,
  withPlanEnv
} from "./helpers/openclaw-plan-env.js";

const posixSkip = { skip: process.platform === "win32" ? "the fake agents are POSIX shell shims" : false };
const CLI = Object.freeze({ agentRuntime: Object.freeze({ id: "claude-cli" }) });
const PLAN_VALUE_ERROR = { ok: false, error: 'plan must be "claude" or "chatgpt"' };
const API_BILLING = "Claude Code uses an API key or a cloud account, not your Claude plan, so OpenClaw would bill that instead.";

const apply = (call, plan, model, extra = {}) =>
  call("POST", "/api/setup/openclaw/plan", { plan, model, confirm: true, acceptOpenClawRisk: true, ...extra });
const argvLines = async (home) => (await openclawRecord(home)).map((line) => line.argv.join(" "));
const stepOf = (job, id) => job.steps.find((step) => step.id === id);

// A ChatGPT plan job as it sits in the jobs folder. `statuses` is one status per step of PLAN_JOB_STEPS.chatgpt
// (model, safe defaults, readiness, hello). The id carries its own time, the way real job ids do, so it sorts
// by when it started: `minutesAgo` before now.
function storedChatgptJob({ minutesAgo = 5, status = "running", statuses = ["succeeded", "running", "pending", "pending"], model = "gpt-6.1-sol", previousPrimary = "openrouter/vendor/old", plan = "chatgpt", errors = {} } = {}) {
  const startedMs = Date.now() - minutesAgo * 60 * 1000;
  const id = `job_${startedMs.toString(36)}_${(minutesAgo * 7919).toString(16).padStart(12, "0")}`;
  const stepIds = PLAN_JOB_STEPS[plan === "chatgpt" ? "chatgpt" : "claude"];
  return {
    id,
    kind: "configure",
    status,
    plan,
    mode: plan === "chatgpt" ? "chatgpt-plan" : "claude-plan",
    model,
    targets: { hermes: null, openclaw: { mode: plan === "chatgpt" ? "chatgpt-plan" : "claude-plan", model } },
    scope: ["openclaw"],
    steps: stepIds.map((stepId, index) => ({
      id: stepId,
      agentId: stepId === "services" || stepId === "health" ? null : "openclaw",
      action: "run",
      status: statuses[index] ?? "pending",
      runIds: [],
      error: errors[stepId] ?? null,
      log: [],
      warnings: []
    })),
    currentStepIndex: Math.max(0, statuses.findIndex((value) => value === "running")),
    startedAt: new Date(startedMs).toISOString(),
    endedAt: status === "running" ? null : new Date(startedMs + 1000).toISOString(),
    acceptOpenClawRisk: true,
    acceptOpenClawRiskAt: new Date(startedMs).toISOString(),
    previousPrimary,
    readiness: null
  };
}

async function putStoredJobs(agentOsHome, jobs) {
  const jobsDir = path.join(agentOsHome, "setup", "jobs");
  await rm(jobsDir, { recursive: true, force: true });
  await mkdir(jobsDir, { recursive: true });
  for (const job of jobs) await writeFile(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job));
  return jobsDir;
}

// =====================================================================
// 1. The pure rules (no fakes)
// =====================================================================

test("planModelRows: an array or { models }, id from key or id, the plan's own prefix stripped, other providers and ids that aren't plain (an @profile among them) dropped, names from the list, then the table, then the id", () => {
  const claudeList = {
    models: [
      { key: "anthropic/claude-opus-5-5", name: "Opus 5.5", contextWindow: 200000, tags: ["default"] },
      { key: "anthropic/claude-new-9" },
      { id: "claude-fable-5-1" },
      { key: "openrouter/anthropic/claude-x", name: "Another provider" },
      { key: "openai/gpt-6-luna" },
      { key: "anthropic/CLAUDE-OPUS-5-5", name: "A second spelling" },
      { key: "anthropic/-flag" },
      { key: "anthropic/has space" },
      // "@..." names an OpenClaw auth profile, and a primary with one is never a plan.
      { key: "anthropic/claude-x@work" },
      "not a row",
      { name: "no id" }
    ]
  };
  assert.deepEqual(planModelRows(claudeList, "claude"), [
    { id: "claude-opus-5-5", name: "Opus 5.5" },
    { id: "claude-new-9", name: "claude-new-9" },
    { id: "claude-fable-5-1", name: "Fable 5.1" }
  ]);
  assert.deepEqual(planModelRows([{ key: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol" }, { id: "gpt-6-luna" }], "chatgpt"), [
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" }
  ]);
  for (const unreadable of [null, "text", 42, {}, { models: "x" }, [], { models: [] }, [{ key: "openai/gpt-6-luna" }]]) {
    assert.equal(planModelRows(unreadable, "claude"), null, JSON.stringify(unreadable));
  }
  assert.equal(planModelRows(claudeList, "hermes"), null);
});

test("claudeCliPinned and hasClaudeCliPin: the model's own runtime decides first, then anthropic/*", () => {
  const pinned = { "anthropic/claude-opus-5-5": CLI };
  const wildcard = { "anthropic/*": CLI };
  assert.equal(claudeCliPinned(pinned, "claude-opus-5-5"), true);
  assert.equal(claudeCliPinned(pinned, "claude-sonnet-5-5"), false, "no entry and no wildcard");
  assert.equal(claudeCliPinned(wildcard, "claude-sonnet-5-5"), true, "the wildcard pins a model with no entry");
  assert.equal(
    claudeCliPinned({ ...wildcard, "anthropic/claude-sonnet-5-5": { alias: "sonnet" } }, "claude-sonnet-5-5"),
    true,
    "an entry with no runtime of its own follows the wildcard"
  );
  assert.equal(
    claudeCliPinned({ ...wildcard, "anthropic/claude-sonnet-5-5": { agentRuntime: { id: "pi" } } }, "claude-sonnet-5-5"),
    false,
    "a model entry naming another runtime wins over the wildcard"
  );
  for (const config of [null, undefined, "x", [], 5]) assert.equal(claudeCliPinned(config, "claude-opus-5-5"), false);
  assert.equal(claudeCliPinned(pinned, ""), false);
  assert.equal(hasClaudeCliPin(pinned), true);
  assert.equal(hasClaudeCliPin(wildcard), true);
  assert.equal(hasClaudeCliPin({ "anthropic/claude-opus-5-5": { agentRuntime: { id: "pi" } } }), false);
  assert.equal(hasClaudeCliPin({}), false);
  assert.equal(hasClaudeCliPin(null), false);
});

test("claudePlanReadiness: every state Claude Code can be in", () => {
  const cases = [
    [{ installed: false, status: "unknown", method: null }, "not_installed"],
    [{ installed: true, status: "not_signed_in", method: null }, "not_signed_in"],
    [{ installed: true, status: "signed_in", method: "claude.ai" }, "ready"],
    [{ installed: true, status: "signed_in", method: "oauth_token" }, "ready"],
    [{ installed: true, status: "signed_in", method: "api_key" }, "api_billing"],
    [{ installed: true, status: "signed_in", method: "api_key_helper" }, "api_billing"],
    [{ installed: true, status: "signed_in", method: "third_party" }, "api_billing"],
    [{ installed: true, status: "signed_in", method: null }, "unknown_method"],
    [{ installed: true, status: "unknown", method: null }, "unknown_method"],
    [{ installed: true, status: "unknown", method: "claude.ai" }, "unknown_method"]
  ];
  for (const [input, expected] of cases) assert.equal(claudePlanReadiness(input), expected, JSON.stringify(input));
});

test("parseAuthRows and chatgptSignIn: method from method or type, sharing from tokenSharing, every other field dropped", () => {
  const rows = parseAuthRows([
    siwcRow(),
    { provider: "openai", type: "siwc", email: "someone@example.com" },
    { provider: "openai", method: "api_key", accessToken: FAKE_SECRET },
    { provider: "anthropic", method: "siwc" },
    "junk"
  ]);
  assert.deepEqual(rows, [
    { method: "siwc", sharing: true },
    { method: "siwc", sharing: null },
    { method: "api_key", sharing: null }
  ]);
  const kept = JSON.stringify(rows);
  assert.ok(!kept.includes("someone@example.com") && !kept.includes(FAKE_SECRET), "only each row's method and sharing are kept");
  assert.deepEqual(parseAuthRows({ profiles: [{ type: "siwc" }] }), [{ method: "siwc", sharing: null }], "a 2026.9.6 row carries only type");
  assert.deepEqual(parseAuthRows([]), []);
  for (const unreadable of [null, "x", {}, { profiles: "x" }, 3]) assert.equal(parseAuthRows(unreadable), null, JSON.stringify(unreadable));

  assert.deepEqual(chatgptSignIn(null), { signedIn: null, sharing: null });
  assert.deepEqual(chatgptSignIn([]), { signedIn: false, sharing: null });
  assert.deepEqual(chatgptSignIn([{ method: "api_key", sharing: null }]), { signedIn: false, sharing: null });
  assert.deepEqual(chatgptSignIn([{ method: "siwc", sharing: true }]), { signedIn: true, sharing: true });
  assert.deepEqual(chatgptSignIn([{ method: "siwc", sharing: false }]), { signedIn: true, sharing: false });
  assert.deepEqual(chatgptSignIn([{ method: "siwc", sharing: null }]), { signedIn: true, sharing: null });
  assert.deepEqual(chatgptSignIn([{ method: "siwc", sharing: false }, { method: "siwc", sharing: true }]), { signedIn: true, sharing: true });
});

test("readinessOf: exit 0 is ready, exit 2 is expiring, anything else (exit 1, a timeout, a missing program) is not ready", () => {
  assert.equal(readinessOf({ ok: true, code: 0, signal: null, stdout: "anything" }), "ready");
  assert.equal(readinessOf({ ok: false, code: 2, signal: null }), "expiring");
  assert.equal(readinessOf({ ok: false, code: 1, signal: null }), "not_ready");
  assert.equal(readinessOf({ ok: false, code: 0, signal: "SIGTERM" }), "not_ready", "runCommand's answer for a timeout");
  assert.equal(readinessOf({ ok: false, code: 2, signal: "SIGTERM" }), "not_ready");
  assert.equal(readinessOf({ ok: false, code: "ENOENT", signal: null }), "not_ready");
  assert.equal(readinessOf(null), "not_ready");
});

test("planOfPrimary and openclawProviderLabel: a plan label only when the runtime check or the sign-in confirms it", () => {
  const pinned = { "anthropic/claude-opus-5-5": CLI };
  assert.equal(planOfPrimary("anthropic/claude-opus-5-5", pinned, false), "claude");
  assert.equal(planOfPrimary("anthropic/claude-sonnet-5-5", pinned, true), null);
  assert.equal(planOfPrimary("anthropic/claude-opus-5-5@anthropic:claude-cli", pinned, false), null, "an @profile suffix is never a plan");
  assert.equal(planOfPrimary("openai/gpt-6.1-sol", null, true), "chatgpt");
  assert.equal(planOfPrimary("openai/gpt-6.1-sol", null, false), null);
  assert.equal(planOfPrimary("openai/gpt-6.1-sol", null, null), null);
  assert.equal(planOfPrimary("openai/gpt-6.1-sol@work", null, true), null);
  assert.equal(planOfPrimary("openrouter/anthropic/claude-opus-5-5", pinned, true), null);
  for (const primary of [null, "", "anthropic", "anthropic/", "/x"]) assert.equal(planOfPrimary(primary, pinned, true), null, String(primary));
  assert.equal(openclawProviderLabel("anthropic", "claude"), "Claude plan");
  assert.equal(openclawProviderLabel("anthropic", null), "Anthropic API key");
  assert.equal(openclawProviderLabel("openai", "chatgpt"), "ChatGPT plan");
  assert.equal(openclawProviderLabel("openai", null), "OpenAI");
  assert.equal(openclawProviderLabel("openrouter", null), null);
  assert.equal(openclawProviderLabel("ollama", "claude"), null);
  // The read that would confirm a plan failed: only the provider is named, never how it is billed.
  assert.equal(openclawProviderLabel("anthropic", null, false), "Anthropic");
  assert.equal(openclawProviderLabel("openai", null, false), "OpenAI");
  assert.equal(openclawProviderLabel("anthropic", null, true), "Anthropic API key", "a read that worked and shows no pin");
  assert.equal(openclawProviderLabel("anthropic", "claude", false), "Claude plan", "a confirmed plan always wins");
  assert.equal(openclawProviderLabel("openrouter", null, false), null);
});

test("readDidNotFinish: a timeout or a program that can't run did not finish; any plain exit did, so only those two count as 'unknown'", async () => {
  assert.equal(readDidNotFinish({ ok: true, code: 0, signal: null }), false);
  assert.equal(readDidNotFinish({ ok: false, code: 1, signal: null }), false, "a plain non-zero exit stays 'not set' until live check S-B3");
  assert.equal(readDidNotFinish({ ok: false, code: 2, signal: null }), false);
  assert.equal(readDidNotFinish({ ok: false, code: 0, signal: "SIGTERM" }), true, "runCommand's answer for a timeout");
  assert.equal(readDidNotFinish({ ok: false, code: "ENOENT", signal: null }), true);
  assert.equal(readDidNotFinish({ ok: false, code: "EACCES", signal: null }), true);
  // The same shapes from the real runCommand (a path that does not exist, Node itself with a short timeout, a plain exit 1): nothing here is an agent.
  const missing = await runCommand("/nonexistent-b1b/openclaw", ["--version"], 2000);
  assert.equal(readDidNotFinish(missing), true, JSON.stringify({ ok: missing.ok, code: missing.code, signal: missing.signal }));
  const slow = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 300);
  assert.equal(readDidNotFinish(slow), true, JSON.stringify({ ok: slow.ok, code: slow.code, signal: slow.signal }));
  const plain = await runCommand(process.execPath, ["-e", "process.exit(1)"], 5000);
  assert.equal(readDidNotFinish(plain), false, JSON.stringify({ ok: plain.ok, code: plain.code, signal: plain.signal }));
});

test("the plan rules' values and sentences are the spec's and the contract's, word for word", () => {
  assert.deepEqual(OPENCLAW_PLANS, ["claude", "chatgpt"]);
  assert.deepEqual(PLAN_PROVIDER, { claude: "anthropic", chatgpt: "openai" });
  assert.deepEqual(PLAN_MODE, { claude: "claude-plan", chatgpt: "chatgpt-plan" });
  assert.equal(PLAN_MODELS_AS_OF, "2026-10-15");
  assert.equal(PLAN_READ_TIMEOUT_MS, 15000);
  assert.deepEqual(PLAN_FALLBACK_MODELS, {
    claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
    chatgpt: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]
  });
  assert.deepEqual(PLAN_MODEL_NAMES, {
    "claude-opus-5-5": "Opus 5.5",
    "claude-sonnet-5-5": "Sonnet 5.5",
    "claude-haiku-5-5": "Haiku 5.5",
    "claude-fable-5-1": "Fable 5.1",
    "gpt-6.1-sol": "GPT-6.1 Sol",
    "gpt-6-sol": "GPT-6 Sol",
    "gpt-6-luna": "GPT-6 Luna"
  });
  assert.equal(TYPED_MODEL_RE.source, "^[a-z0-9][a-z0-9._:-]{0,99}$");
  assert.deepEqual(CLAUDE_PLAN_METHODS, ["claude.ai", "oauth_token"]);
  assert.deepEqual(CLAUDE_API_METHODS, ["api_key", "api_key_helper", "third_party"]);
  assert.equal(FABLE_NOTE, "Uses usage credits: on Pro from the first request, on Max after half your weekly limit.");
  assert.equal(isFableModel("claude-fable-5-1"), true);
  assert.equal(isFableModel("Claude-Fable-6"), true);
  assert.equal(isFableModel("claude-opus-5-5"), false);
  assert.deepEqual(PLAN_NOT_READY_MESSAGE, {
    openclaw_missing: "Install OpenClaw first.",
    not_installed: "Install Claude Code first.",
    not_signed_in: "Sign in to Claude Code first, then try again.",
    api_billing: API_BILLING,
    unknown_method: "Agent OS couldn't tell how Claude Code is signed in. Update Claude Code, then check again.",
    chatgpt_signed_out: "Sign in with ChatGPT first, then try again."
  });
  assert.equal(RUNTIME_CHECK_FAILED, "OpenClaw would use an Anthropic API key for this model, not your Claude plan.");
  assert.equal(CURRENT_MODEL_UNREADABLE, "Agent OS couldn't read OpenClaw's current model, so it changed nothing. Try again.");
  assert.equal(MODEL_SETTINGS_UNREADABLE, "Agent OS couldn't read OpenClaw's model settings, so it changed nothing. Try again.");
  assert.equal(
    CURRENT_MODEL_NOT_RESTORABLE,
    "OpenClaw's current model has a name Agent OS can't put back, so it changed nothing. Switch OpenClaw to another model first, then try again."
  );
  assert.ok(!CURRENT_MODEL_NOT_RESTORABLE.includes("couldn't read"), "the model WAS read, so the sentence must not say it wasn't");
  assert.notEqual(CURRENT_MODEL_NOT_RESTORABLE, CURRENT_MODEL_UNREADABLE);
  assert.equal(CHATGPT_EXPIRING, "Your ChatGPT sign-in expires soon. Sign in again.");
  assert.equal(CHATGPT_NOT_READY, "OpenClaw can't use your ChatGPT plan yet. Sign in again, and allow token sharing when ChatGPT asks.");
  assert.equal(INVALID_PLAN_MODEL, "That doesn't look like a model name.");
  assert.equal(PLAN_JOB_INTERRUPTED, "Agent OS quit before this finished. Apply the plan again.");
  assert.equal(noEarlierPrimary("openai/gpt-6.1-sol"), "OpenClaw had no model set before, so it keeps openai/gpt-6.1-sol.");
  assert.deepEqual(PLAN_HEALTH_LINES, {
    usageLimit: "Your plan's usage limit is used up. Try again after it resets.",
    signedOut: "OpenClaw isn't signed in to your plan anymore. Sign in again.",
    unreachable: { "claude-plan": "Couldn't reach Anthropic.", "chatgpt-plan": "Couldn't reach OpenAI." },
    timedOut: "The agent didn't answer within a minute. Try again."
  });
});

test("healthFixLine: every mode against every pattern; a plan mode never gets an OpenRouter or Ollama sentence", () => {
  const TODAY = {
    limit: "OpenRouter's free limit was reached (50 requests a day until you add $10 of credit). Try again tomorrow, add credit, or use Local.",
    key: "The agent didn't accept the key. Connect OpenRouter again and press the button again.",
    openrouterNetwork: "Couldn't reach OpenRouter. Check your internet connection and try again.",
    ollamaNetwork: "Couldn't reach Ollama. Open the Ollama app and try again.",
    timeout: "The agent didn't answer within a minute. Free models are sometimes busy; try again, or pick another model.",
    ollamaBad: "This local model didn't answer properly. Try a bigger model, or use OpenRouter.",
    last: "The agent didn't reply as expected. Open its run on the Runs page for details, or pick another model."
  };
  const PLAN = {
    usage: "Your plan's usage limit is used up. Try again after it resets.",
    signedOut: "OpenClaw isn't signed in to your plan anymore. Sign in again.",
    anthropic: "Couldn't reach Anthropic.",
    openai: "Couldn't reach OpenAI.",
    timeout: "The agent didn't answer within a minute. Try again."
  };
  // [the hello's output, timed out?, then the line for openrouter, ollama, claude-plan, chatgpt-plan]
  const rows = [
    ["Claude AI usage limit reached", false, TODAY.last, TODAY.ollamaBad, PLAN.usage, PLAN.usage],
    ["HTTP 429 Too Many Requests", false, TODAY.limit, TODAY.limit, PLAN.usage, PLAN.usage],
    ["Rate limit hit, slow down", false, TODAY.limit, TODAY.limit, PLAN.usage, PLAN.usage],
    ["quota exceeded for this account", false, TODAY.limit, TODAY.limit, PLAN.usage, PLAN.usage],
    ["Not logged in. Please run /login", false, TODAY.last, TODAY.ollamaBad, PLAN.signedOut, PLAN.signedOut],
    ["401 Unauthorized", false, TODAY.key, TODAY.key, PLAN.signedOut, PLAN.signedOut],
    ["Your session token expired", false, TODAY.last, TODAY.ollamaBad, PLAN.signedOut, PLAN.signedOut],
    ["TypeError: fetch failed (ECONNREFUSED)", false, TODAY.openrouterNetwork, TODAY.ollamaNetwork, PLAN.anthropic, PLAN.openai],
    ["getaddrinfo ENOTFOUND api.openai.com", false, TODAY.openrouterNetwork, TODAY.ollamaNetwork, PLAN.anthropic, PLAN.openai],
    ["", true, TODAY.timeout, TODAY.timeout, PLAN.timeout, PLAN.timeout],
    ["something unexpected", false, TODAY.last, TODAY.ollamaBad, TODAY.last, TODAY.last],
    // Today's other key and limit words: a plan mode falls through to the last
    // line (never "The agent didn't accept the key" or the free-limit sentence).
    ["403 Forbidden", false, TODAY.key, TODAY.key, TODAY.last, TODAY.last],
    ["invalid api key", false, TODAY.key, TODAY.key, TODAY.last, TODAY.last],
    ["Authentication failed", false, TODAY.key, TODAY.key, TODAY.last, TODAY.last],
    ["missing credential", false, TODAY.key, TODAY.key, TODAY.last, TODAY.last],
    ["Too many requests", false, TODAY.limit, TODAY.limit, TODAY.last, TODAY.last],
    ["free-models-per-day exceeded", false, TODAY.limit, TODAY.limit, TODAY.last, TODAY.last],
    // The plan-only words: a plan mode gets its own sentence, today's modes don't.
    ["weekly limit reached", false, TODAY.last, TODAY.ollamaBad, PLAN.usage, PLAN.usage],
    ["You are not signed in", false, TODAY.last, TODAY.ollamaBad, PLAN.signedOut, PLAN.signedOut],
    ["Request unauthorized", false, TODAY.key, TODAY.key, PLAN.signedOut, PLAN.signedOut]
  ];
  const modes = ["openrouter", "ollama", "claude-plan", "chatgpt-plan"];
  const todayOnly = new Set([TODAY.limit, TODAY.key, TODAY.openrouterNetwork, TODAY.ollamaNetwork, TODAY.timeout, TODAY.ollamaBad]);
  for (const [output, timedOut, ...expected] of rows) {
    modes.forEach((mode, index) => {
      const line = healthFixLine(output, { mode, model: "some-model" }, timedOut);
      assert.equal(line, expected[index], `${mode}: ${JSON.stringify(output)}${timedOut ? " (timed out)" : ""}`);
      if (mode.endsWith("-plan")) assert.ok(!todayOnly.has(line), `${mode} got an OpenRouter or Ollama sentence`);
    });
  }
  assert.equal(healthFixLine("something unexpected", undefined, false), TODAY.last, "no target keeps today's answer");
});

test("PLAN_JOB_STEPS: the spec's order for both plans", () => {
  assert.deepEqual(PLAN_JOB_STEPS, {
    claude: ["openclaw-plan-onboard", "openclaw-safe-defaults", "openclaw-plan-runtime-check", "openclaw-plan-model", "services", "health"],
    chatgpt: ["openclaw-plan-model", "openclaw-safe-defaults", "openclaw-plan-readiness", "health"]
  });
});

// =====================================================================
// 2. signInStatus's method
// =====================================================================

test("signInStatus: method is Claude Code's authMethod word when Agent OS knows it, else null; always null for Codex, Cursor and a missing agent", posixSkip, async () => {
  await withPlanEnv(async ({ home, knob }) => {
    const NOTES = {
      "claude.ai": "Signed in with your Claude account.",
      oauth_token: "Signed in with a long-lived Claude sign-in token.",
      api_key: "Using an Anthropic API key.",
      api_key_helper: "Using an Anthropic API key.",
      third_party: "Using Claude through Amazon Bedrock, Google Cloud or Microsoft Foundry."
    };
    for (const [method, note] of Object.entries(NOTES)) {
      await knob("FAKE_CLAUDE_AUTH_JSON", CLAUDE_AUTH[method]);
      const status = await signInStatus("claude");
      assert.deepEqual([status.status, status.method, status.note], ["signed_in", method, note], method);
      assert.ok(!JSON.stringify(status).includes("someone@example.com") && !JSON.stringify(status).includes("Secret Org"));
    }
    await knob("FAKE_CLAUDE_AUTH_JSON", CLAUDE_AUTH.no_method);
    const older = await signInStatus("claude");
    assert.deepEqual([older.status, older.method, older.note], ["signed_in", null, "Signed in."], "an older Claude Code that can't say how");
    await knob("FAKE_CLAUDE_AUTH_JSON", JSON.stringify({ loggedIn: true, authMethod: "something_new" }));
    assert.equal((await signInStatus("claude")).method, null, "a word Agent OS doesn't know is never passed on");
    await knob("FAKE_CLAUDE_AUTH_JSON", CLAUDE_AUTH.signed_out);
    const out = await signInStatus("claude");
    assert.deepEqual([out.status, out.method], ["not_signed_in", null]);
    for (const id of ["codex", "cursor"]) assert.equal((await signInStatus(id)).method, null, id);
    await rm(path.join(home, ".local", "bin", "claude"));
    await refuseSystemAgent("claude");
    const missing = await signInStatus("claude");
    assert.deepEqual([missing.installed, missing.status, missing.method], [false, "unknown", null]);
  });
});

// =====================================================================
// 3. Plan status, the model lists and the model answer
// =====================================================================

test("The two plan reads live in one place: models.js, which readAgentModel uses, and openclaw-plans.js re-exports the same functions; no other module repeats their commands", async () => {
  assert.equal(readChatgptAuth, readChatgptAuthInModels);
  assert.equal(readOpenclawModelsConfig, readOpenclawModelsConfigInModels);
  const setupDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "server", "runtime", "setup");
  const authList = '["models", "auth", "list", "--provider", "openai", "--json"]';
  const modelSettings = '["config", "get", "agents.defaults.models", "--json"]';
  const found = { authList: [], modelSettings: [] };
  for (const name of (await readdir(setupDir)).filter((file) => file.endsWith(".js"))) {
    const code = await readFile(path.join(setupDir, name), "utf8");
    for (let at = code.indexOf(authList); at >= 0; at = code.indexOf(authList, at + 1)) found.authList.push(name);
    for (let at = code.indexOf(modelSettings); at >= 0; at = code.indexOf(modelSettings, at + 1)) found.modelSettings.push(name);
  }
  assert.deepEqual(found, { authList: ["models.js"], modelSettings: ["models.js"] });
});

test("GET /api/setup/openclaw/plans: OpenClaw's version is read afresh on every call, so an update shows at once (Review Focus 1)", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, knob }) => {
      const version = async () => (await call("GET", "/api/setup/openclaw/plans")).body.version;
      assert.deepEqual(await version(), { have: "2026.9.6", need: "2026.9.7", newEnough: false });
      await knob("FAKE_AGENT_VERSION", "OpenClaw 2026.9.7");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.deepEqual(await version(), { have: "2026.9.7", need: "2026.9.7", newEnough: true }, "no 30 s detect cache and no 60 s system check in the way");
      await knob("FAKE_AGENT_VERSION", "OpenClaw 2026.10.1");
      assert.deepEqual(await version(), { have: "2026.10.1", need: "2026.9.7", newEnough: true });
      await knob("FAKE_AGENT_VERSION", "OpenClaw unknown");
      assert.deepEqual(await version(), { have: null, need: "2026.9.7", newEnough: null });
      await knob("FAKE_AGENT_VERSION", null);
      assert.deepEqual(await version(), { have: "9.9.9", need: "2026.9.7", newEnough: false }, "the fake's own line, openclaw 9.9.9-test");
    },
    { version: "OpenClaw 2026.9.6 (eb377ac)" }
  );
});

test("GET /api/setup/openclaw/plans: every state Claude Code can be in, with its method and note, and nothing else about the account", posixSkip, async () => {
  await withPlanEnv(async ({ call, home, knob }) => {
    const claude = async () => {
      const answer = await call("GET", "/api/setup/openclaw/plans");
      assert.equal(answer.status, 200);
      assert.ok(!answer.text.includes("someone@example.com") && !answer.text.includes("Secret Org"), "no account details come back");
      return answer.body.claude;
    };
    const NOTES = {
      "claude.ai": "Signed in with your Claude account.",
      oauth_token: "Signed in with a long-lived Claude sign-in token.",
      api_key: "Using an Anthropic API key.",
      api_key_helper: "Using an Anthropic API key.",
      third_party: "Using Claude through Amazon Bedrock, Google Cloud or Microsoft Foundry."
    };
    for (const [method, note] of Object.entries(NOTES)) {
      await knob("FAKE_CLAUDE_AUTH_JSON", CLAUDE_AUTH[method]);
      assert.deepEqual(await claude(), { installed: true, status: "signed_in", method, note }, method);
    }
    await knob("FAKE_CLAUDE_AUTH_JSON", CLAUDE_AUTH.no_method);
    assert.deepEqual(await claude(), { installed: true, status: "signed_in", method: null, note: "Signed in." });
    await knob("FAKE_CLAUDE_AUTH_JSON", CLAUDE_AUTH.signed_out);
    assert.deepEqual(await claude(), { installed: true, status: "not_signed_in", method: null, note: "Not signed in to Claude Code yet." });
    await rm(path.join(home, ".local", "bin", "claude"));
    await refuseSystemAgent("claude");
    assert.deepEqual(await claude(), {
      installed: false,
      status: "unknown",
      method: null,
      note: "Claude Code isn't installed yet. Install it first, then sign in."
    });
  });
});

test("GET /api/setup/openclaw/plans: every sign-in list state, and readiness only while OpenClaw is on the ChatGPT plan", posixSkip, async () => {
  await withPlanEnv(async ({ call, home, knob }) => {
    const chatgpt = async () => (await call("GET", "/api/setup/openclaw/plans")).body.chatgpt;
    const setState = (authRows, primary = null) => writeFakeAgentState(home, { primary, models: null, authRows });
    await setState([]);
    assert.deepEqual(await chatgpt(), { signedIn: false, sharing: null, readiness: null }, "no profile");
    await setState([siwcRow()]);
    assert.deepEqual(await chatgpt(), { signedIn: true, sharing: true, readiness: null }, "signed in; OpenClaw is not on the ChatGPT plan");
    await setState([siwcRow({ tokenSharing: false })]);
    assert.deepEqual(await chatgpt(), { signedIn: true, sharing: false, readiness: null }, "signed in without token sharing");
    await setState([siwcRow({ tokenSharing: undefined })]);
    assert.deepEqual(await chatgpt(), { signedIn: true, sharing: null, readiness: null }, "no sharing field: unknown");
    await setState([{ provider: "openai", type: "api_key", email: "someone@example.com" }]);
    assert.deepEqual(await chatgpt(), { signedIn: false, sharing: null, readiness: null }, "an API key profile is not a ChatGPT sign-in");
    await knob("FAKE_OPENCLAW_AUTH_JSON", JSON.stringify({ profiles: [{ type: "siwc", email: "someone@example.com" }] }));
    assert.deepEqual(await chatgpt(), { signedIn: true, sharing: null, readiness: null }, "a 2026.9.6-style row carries only type");
    for (const unreadable of ["fail", "not json", JSON.stringify({ nothing: true })]) {
      await knob("FAKE_OPENCLAW_AUTH_JSON", unreadable);
      assert.deepEqual(await chatgpt(), { signedIn: null, sharing: null, readiness: null }, unreadable);
    }
    await knob("FAKE_OPENCLAW_AUTH_JSON", null);

    // On the ChatGPT plan: the readiness check runs, and only its exit code is used.
    await setState([siwcRow()], "openai/gpt-6.1-sol");
    for (const [exit, readiness] of [["0", "ready"], ["2", "expiring"], ["1", "not_ready"]]) {
      await knob("FAKE_OPENCLAW_STATUS_EXIT", exit);
      const answer = await call("GET", "/api/setup/openclaw/plans");
      assert.deepEqual(answer.body.chatgpt, { signedIn: true, sharing: true, readiness }, `models status exit ${exit}`);
      assert.ok(!answer.text.includes(FAKE_SECRET) && !answer.text.includes("someone@example.com"));
    }
    await setState([siwcRow()], "anthropic/claude-opus-5-5");
    assert.equal((await chatgpt()).readiness, null, "on another provider: no readiness read");
    const statusRuns = (await argvLines(home)).filter((line) => line.startsWith("models status"));
    assert.deepEqual(statusRuns, ["models status --check --plain", "models status --check --plain", "models status --check --plain"]);
  });
});

test("GET /api/setup/openclaw/plans: OpenClaw not installed", posixSkip, async () => {
  await withPlanEnv(
    async ({ call }) => {
      const answer = await call("GET", "/api/setup/openclaw/plans");
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body.version, { have: null, need: "2026.9.7", newEnough: null });
      assert.deepEqual(answer.body.chatgpt, { signedIn: null, sharing: null, readiness: null });
      assert.equal(answer.body.claude.status, "signed_in");
    },
    { openclaw: false }
  );
});

const FALLBACK = {
  claude: [
    { id: "claude-opus-5-5", name: "Opus 5.5", note: null, available: true },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: null, available: true },
    { id: "claude-haiku-5-5", name: "Haiku 5.5", note: null, available: true },
    { id: "claude-fable-5-1", name: "Fable 5.1", note: FABLE_NOTE, available: true }
  ],
  chatgpt: [
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", note: null, available: true },
    { id: "gpt-6-sol", name: "GPT-6 Sol", note: null, available: true },
    { id: "gpt-6-luna", name: "GPT-6 Luna", note: null, available: true }
  ]
};

test("GET /api/setup/openclaw/plan-models: the account's list, prefixes stripped, the Fable note, every model offered before any pin; a wrong plan is refused", posixSkip, async () => {
  await withPlanEnv(async ({ call }) => {
    const claude = await call("GET", "/api/setup/openclaw/plan-models?plan=claude");
    assert.equal(claude.status, 200);
    assert.deepEqual(claude.body, {
      models: [
        { id: "claude-opus-5-5", name: "Opus 5.5", note: null, available: true },
        { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: null, available: true },
        { id: "claude-fable-5-1", name: "Fable 5.1", note: FABLE_NOTE, available: true }
      ],
      source: "account",
      asOf: null
    });
    const chatgpt = await call("GET", "/api/setup/openclaw/plan-models?plan=chatgpt");
    assert.deepEqual(chatgpt.body, {
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", note: null, available: true },
        { id: "gpt-6-luna", name: "GPT-6 Luna", note: null, available: true }
      ],
      source: "account",
      asOf: null
    });
    for (const query of ["", "?plan=hermes", "?plan=Claude", "?plan=claude&plan=chatgpt"]) {
      const refused = await call("GET", `/api/setup/openclaw/plan-models${query}`);
      assert.deepEqual([refused.status, refused.body], [400, PLAN_VALUE_ERROR], query);
    }
  });
});

test("GET /api/setup/openclaw/plan-models: once claude-cli pins exist, an unpinned Claude model is not available; the wildcard makes every one available", posixSkip, async () => {
  await withPlanEnv(async ({ call, home }) => {
    const available = async (plan = "claude") =>
      (await call("GET", `/api/setup/openclaw/plan-models?plan=${plan}`)).body.models.map((model) => [model.id, model.available]);
    const pins = Object.fromEntries(FAKE_CLAUDE_CLI_PINS.map((id) => [`anthropic/${id}`, CLI]));
    await writeFakeAgentState(home, { primary: null, models: pins, authRows: [] });
    assert.deepEqual(await available(), [["claude-opus-5-5", true], ["claude-sonnet-5-5", false], ["claude-fable-5-1", true]]);
    await writeFakeAgentState(home, { primary: null, models: { ...pins, "anthropic/*": CLI }, authRows: [] });
    assert.deepEqual(await available(), [["claude-opus-5-5", true], ["claude-sonnet-5-5", true], ["claude-fable-5-1", true]]);
    await writeFakeAgentState(home, { primary: null, models: { "anthropic/*": CLI, "anthropic/claude-sonnet-5-5": { agentRuntime: { id: "pi" } } }, authRows: [] });
    assert.deepEqual(await available(), [["claude-opus-5-5", true], ["claude-sonnet-5-5", false], ["claude-fable-5-1", true]]);
    assert.deepEqual(await available("chatgpt"), [["gpt-6.1-sol", true], ["gpt-6-luna", true]], "available is only ever false for a Claude plan model");
    assert.deepEqual(await readOpenclawModelsConfig(await ADAPTERS.openclaw.detect({ refresh: true })), {
      "anthropic/*": CLI,
      "anthropic/claude-sonnet-5-5": { agentRuntime: { id: "pi" } }
    });
  });
});

test("GET /api/setup/openclaw/plan-models: every list shape the fake can print, and the dated fallback", posixSkip, async () => {
  await withPlanEnv(async ({ call, knob }) => {
    const models = async (plan = "claude") => (await call("GET", `/api/setup/openclaw/plan-models?plan=${plan}`)).body;
    await knob(
      "FAKE_OPENCLAW_MODELS_JSON",
      JSON.stringify([{ id: "claude-opus-5-5" }, { key: "anthropic/claude-new-9", extra: { deep: true } }, { key: "openrouter/anthropic/claude-x" }])
    );
    assert.deepEqual(
      await models(),
      {
        models: [
          { id: "claude-opus-5-5", name: "Opus 5.5", note: null, available: true },
          { id: "claude-new-9", name: "claude-new-9", note: null, available: true }
        ],
        source: "account",
        asOf: null
      },
      "a plain array; a row without a name shows the table's name or its raw id; another provider's row is dropped"
    );
    await knob("FAKE_OPENCLAW_MODELS_JSON", JSON.stringify({ models: [{ key: "openai/gpt-6.1-sol" }, { key: "openai/gpt-7-terra", name: "GPT-7 Terra" }] }));
    assert.deepEqual((await models("chatgpt")).models.map((model) => [model.id, model.name]), [["gpt-6.1-sol", "GPT-6.1 Sol"], ["gpt-7-terra", "GPT-7 Terra"]]);
    const unreadable = ["fail", "not json", JSON.stringify({ rows: [] }), JSON.stringify([]), JSON.stringify({ models: [] }), JSON.stringify([{ key: "openai/gpt-6-luna" }])];
    for (const shape of unreadable) {
      await knob("FAKE_OPENCLAW_MODELS_JSON", shape);
      assert.deepEqual(await models(), { models: FALLBACK.claude, source: "fallback", asOf: "2026-10-15" }, shape);
    }
    await knob("FAKE_OPENCLAW_MODELS_JSON", "fail");
    assert.deepEqual(await models("chatgpt"), { models: FALLBACK.chatgpt, source: "fallback", asOf: "2026-10-15" });
  });
});

test("GET /api/setup/openclaw/plan-models with OpenClaw not installed: the dated fallback list for each plan, every model available, and no command is run", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home }) => {
      for (const plan of OPENCLAW_PLANS) {
        const answer = await call("GET", `/api/setup/openclaw/plan-models?plan=${plan}`);
        assert.equal(answer.status, 200, plan);
        assert.deepEqual(
          answer.body,
          {
            models: PLAN_FALLBACK_MODELS[plan].map((id) => ({ id, name: PLAN_MODEL_NAMES[id], note: isFableModel(id) ? FABLE_NOTE : null, available: true })),
            source: "fallback",
            asOf: PLAN_MODELS_AS_OF
          },
          plan
        );
      }
      assert.equal((await call("GET", "/api/setup/openclaw/plan-models?plan=claude")).body.models.find((model) => model.id === "claude-fable-5-1").note, FABLE_NOTE);
      assert.deepEqual(await openclawRecord(home), [], "there was no OpenClaw to run a command");
    },
    { openclaw: false }
  );
});

test("resolvePlanModel: a listed name in any letter case gives the list's own id; a typed name is accepted only with the fallback; anything else is refused", posixSkip, async () => {
  await withPlanEnv(async ({ knob }) => {
    const detected = await ADAPTERS.openclaw.detect({ refresh: true });
    const refused = (error) => error?.code === "invalid_model_id" && error.message === "That doesn't look like a model name.";
    assert.equal(await resolvePlanModel("claude", "CLAUDE-OPUS-5-5", { detected }), "claude-opus-5-5");
    assert.equal(await resolvePlanModel("chatgpt", " gpt-6-luna ", { detected }), "gpt-6-luna");
    for (const name of ["claude-new-9", "anthropic/claude-opus-5-5", "gpt-6-luna", "", "   ", null, 42]) {
      await assert.rejects(() => resolvePlanModel("claude", name, { detected }), refused, `account list: ${String(name)}`);
    }
    await knob("FAKE_OPENCLAW_MODELS_JSON", "fail");
    assert.equal(await resolvePlanModel("claude", "Claude-Haiku-5-5", { detected }), "claude-haiku-5-5");
    assert.equal(await resolvePlanModel("claude", "claude-opus-6-0", { detected }), "claude-opus-6-0");
    assert.equal(await resolvePlanModel("claude", "anthropic/claude-opus-6-0", { detected }), "claude-opus-6-0", "the plan's own prefix is dropped");
    assert.equal(await resolvePlanModel("chatgpt", "openai/gpt-7.0-terra", { detected }), "gpt-7.0-terra");
    for (const name of ["Claude-Opus-6-0", "openai/claude-opus-6-0", "anthropic/x/y", "-flag", "has space", "a".repeat(101), "x;rm -rf ~"]) {
      await assert.rejects(() => resolvePlanModel("claude", name, { detected }), refused, `fallback list: ${name}`);
    }
    await assert.rejects(() => resolvePlanModel("hermes", "x", { detected }), TypeError);
  });
});

test("GET /api/setup/agents/openclaw/model: the plan and its label come from the runtime check; Hermes's answer has no plan", posixSkip, async () => {
  await withPlanEnv(async ({ call, home }) => {
    const cases = [
      ["pinned", { primary: "anthropic/claude-opus-5-5", models: { "anthropic/claude-opus-5-5": CLI }, authRows: [] }, "claude", "Claude plan"],
      ["not pinned (never Claude plan)", { primary: "anthropic/claude-sonnet-5-5", models: { "anthropic/claude-opus-5-5": CLI }, authRows: [] }, null, "Anthropic API key"],
      ["no per-model settings at all", { primary: "anthropic/claude-opus-5-5", models: null, authRows: [] }, null, "Anthropic API key"],
      ["pinned by the wildcard only", { primary: "anthropic/claude-sonnet-5-5", models: { "anthropic/*": CLI }, authRows: [] }, "claude", "Claude plan"],
      [
        "a model entry naming another runtime",
        { primary: "anthropic/claude-sonnet-5-5", models: { "anthropic/*": CLI, "anthropic/claude-sonnet-5-5": { agentRuntime: { id: "pi" } } }, authRows: [] },
        null,
        "Anthropic API key"
      ],
      [
        "an @profile suffix",
        { primary: "anthropic/claude-opus-5-5@anthropic:claude-cli", models: { "anthropic/claude-opus-5-5": CLI, "anthropic/*": CLI }, authRows: [] },
        null,
        "Anthropic API key"
      ],
      ["a ChatGPT sign-in", { primary: "openai/gpt-6.1-sol", models: null, authRows: [siwcRow()] }, "chatgpt", "ChatGPT plan"],
      ["an OpenAI API key only", { primary: "openai/gpt-6.1-sol", models: null, authRows: [{ provider: "openai", type: "api_key" }] }, null, "OpenAI"],
      ["OpenRouter keeps today's label", { primary: "openrouter/vendor/old", models: { "anthropic/*": CLI }, authRows: [siwcRow()] }, null, "OpenRouter"]
    ];
    for (const [why, state, plan, label] of cases) {
      await writeFakeAgentState(home, state);
      const answer = await call("GET", "/api/setup/agents/openclaw/model");
      assert.equal(answer.status, 200, why);
      assert.deepEqual([answer.body.plan, answer.body.providerLabel], [plan, label], why);
      assert.ok(!answer.text.includes("someone@example.com") && !answer.text.includes(FAKE_SECRET), why);
    }
    const hermes = (await call("GET", "/api/setup/agents/hermes/model")).body;
    assert.equal(hermes.installed, true);
    assert.equal("plan" in hermes, false, "Hermes's answer keeps its shape");
  });
  await withPlanEnv(
    async ({ call }) => {
      const missing = (await call("GET", "/api/setup/agents/openclaw/model")).body;
      assert.deepEqual([missing.installed, missing.plan, missing.providerLabel], [false, null, null]);
    },
    { openclaw: false }
  );
});

test("GET /api/setup/agents/openclaw/model: when the read that would confirm a plan fails, the label names only the provider; a read that worked and shows no plan keeps Anthropic API key / OpenAI", posixSkip, async () => {
  await withPlanEnv(async ({ call, home, knob }) => {
    const labelOf = async (why) => {
      const answer = await call("GET", "/api/setup/agents/openclaw/model");
      assert.equal(answer.status, 200, why);
      return [answer.body.plan, answer.body.providerLabel];
    };
    // An anthropic/ primary. The model settings can't be read three ways: timed out, failed, not JSON.
    await writeFakeAgentState(home, { primary: "anthropic/claude-sonnet-5-5", models: { "anthropic/claude-opus-5-5": CLI }, authRows: [] });
    for (const mode of ["timeout", "fail", "garbage"]) {
      await knob("FAKE_OPENCLAW_GET_MODEL_SETTINGS", mode);
      assert.deepEqual(await labelOf(mode), [null, "Anthropic"], `model settings: ${mode}`);
    }
    await knob("FAKE_OPENCLAW_GET_MODEL_SETTINGS", null);
    assert.deepEqual(await labelOf("read worked, model not pinned"), [null, "Anthropic API key"]);
    await writeFakeAgentState(home, { primary: "anthropic/claude-opus-5-5", models: { "anthropic/claude-opus-5-5": CLI }, authRows: [] });
    assert.deepEqual(await labelOf("read worked, model pinned"), ["claude", "Claude plan"]);

    // An openai/ primary. The sign-in list can't be read two ways: failed, not JSON.
    await writeFakeAgentState(home, { primary: "openai/gpt-6.1-sol", models: null, authRows: [{ provider: "openai", type: "api_key" }] });
    for (const shaped of ["fail", "this is not json {"]) {
      await knob("FAKE_OPENCLAW_AUTH_JSON", shaped);
      assert.deepEqual(await labelOf(shaped), [null, "OpenAI"], `sign-in list: ${shaped}`);
    }
    await knob("FAKE_OPENCLAW_AUTH_JSON", null);
    assert.deepEqual(await labelOf("read worked, no ChatGPT sign-in"), [null, "OpenAI"]);
    await writeFakeAgentState(home, { primary: "openai/gpt-6.1-sol", models: null, authRows: [siwcRow()] });
    assert.deepEqual(await labelOf("read worked, signed in with ChatGPT"), ["chatgpt", "ChatGPT plan"]);
  });
});

test("GET /api/setup/agents/openclaw/model starts the plan-confirming read beside the primary read, not after it, and waits only for the one it needs", posixSkip, async () => {
  await withPlanEnv(async ({ call, home, knob }) => {
    const timingFile = path.join(home, ".fake-openclaw-timing.jsonl");
    // Every one of these reads takes 1.5 s, and the fake notes when each one started and ended.
    await knob("FAKE_OPENCLAW_READ_DELAY_MS", "1500");
    const cases = [
      ["an anthropic/ model: the per-model settings", { primary: "anthropic/claude-opus-5-5", models: { "anthropic/claude-opus-5-5": CLI }, authRows: [] }, "config get agents.defaults.models --json", "claude", "Claude plan"],
      ["an openai/ model: the sign-in list", { primary: "openai/gpt-6.1-sol", models: null, authRows: [siwcRow()] }, "models auth list --provider openai --json", "chatgpt", "ChatGPT plan"]
    ];
    for (const [why, state, confirming, plan, label] of cases) {
      await writeFakeAgentState(home, state);
      await rm(timingFile, { force: true });
      const answer = await call("GET", "/api/setup/agents/openclaw/model");
      assert.equal(answer.status, 200, why);
      assert.deepEqual([answer.body.plan, answer.body.providerLabel], [plan, label], why);
      const timings = await readJsonLines(timingFile);
      const primary = timings.find((entry) => entry.argv.join(" ") === "config get agents.defaults.model.primary");
      const confirm = timings.find((entry) => entry.argv.join(" ") === confirming);
      assert.ok(primary && confirm, `${why}: both reads ran (${JSON.stringify(timings.map((entry) => entry.argv.join(" ")))})`);
      assert.ok(confirm.startedAt < primary.endedAt, `${why}: the confirming read started before the primary read had ended`);
    }
    // A model that needs no confirming read still answers with only the primary read waited for.
    await writeFakeAgentState(home, { primary: "openrouter/vendor/old", models: null, authRows: [] });
    const plain = await call("GET", "/api/setup/agents/openclaw/model");
    assert.deepEqual([plain.body.plan, plain.body.providerLabel, plain.body.model], [null, "OpenRouter", "vendor/old"]);
  });
});

// =====================================================================
// 4. POST /api/setup/openclaw/plan and the plan jobs
// =====================================================================

test("POST /api/setup/openclaw/plan refuses before anything runs: confirm, the plan value, the risk tick; a model that isn't one is refused before any change", posixSkip, async () => {
  await withPlanEnv(async ({ call, home, agentOsHome }) => {
    const post = (body) => call("POST", "/api/setup/openclaw/plan", body);
    const good = { plan: "claude", model: "claude-opus-5-5", confirm: true, acceptOpenClawRisk: true };
    const noConfirm = await post({ ...good, confirm: undefined });
    assert.deepEqual([noConfirm.status, noConfirm.body], [400, { ok: false, error: "confirm must be true" }]);
    for (const plan of [undefined, "hermes", "CLAUDE", ["claude"], 1]) {
      const refused = await post({ ...good, plan });
      assert.deepEqual([refused.status, refused.body], [400, PLAN_VALUE_ERROR], JSON.stringify(plan));
    }
    for (const tick of [undefined, false, "true", 1]) {
      const refused = await post({ ...good, acceptOpenClawRisk: tick });
      assert.deepEqual([refused.status, refused.body], [400, { error: "openclaw_risk_not_accepted" }], JSON.stringify(tick));
    }
    assert.deepEqual(await openclawRecord(home), [], "no OpenClaw command ran");
    assert.deepEqual(await agentEnvLog(home), [], "no Claude Code command ran");
    await assert.rejects(() => startOpenclawPlanJob({ plan: "claude", model: "claude-opus-5-5" }), (error) => error.code === "openclaw_risk_not_accepted");
    await assert.rejects(() => startOpenclawPlanJob({ plan: "hermes", model: "x", acceptOpenClawRisk: true }), TypeError);

    for (const model of ["Bad Name!", "claude-new-9", "", "anthropic/../x"]) {
      const refused = await post({ ...good, model });
      assert.deepEqual([refused.status, refused.body], [400, { error: "invalid_model_id", message: "That doesn't look like a model name." }], model);
    }
    const lines = await argvLines(home);
    assert.ok(!lines.some((line) => line.startsWith("onboard") || line.startsWith("config set") || line.startsWith("models set")), "a refused model changes nothing");
    assert.deepEqual(await listFiles(path.join(agentOsHome, "setup", "jobs")), [], "no job was made");
  });
});

test("POST plan reads Claude Code's sign-in again inside the job lock: switched to an API key, signed out or removed after the card's read gets 409 plan_not_ready, and no onboard runs (Review Focus 3)", posixSkip, async () => {
  await withPlanEnv(async ({ call, home, agentOsHome, knob }) => {
    assert.equal((await call("GET", "/api/setup/openclaw/plans")).body.claude.method, "claude.ai", "the card's read: on the plan");
    const cases = [
      [CLAUDE_AUTH.api_key, API_BILLING],
      [CLAUDE_AUTH.api_key_helper, API_BILLING],
      [CLAUDE_AUTH.third_party, API_BILLING],
      [CLAUDE_AUTH.signed_out, "Sign in to Claude Code first, then try again."],
      [CLAUDE_AUTH.no_method, "Agent OS couldn't tell how Claude Code is signed in. Update Claude Code, then check again."]
    ];
    for (const [auth, message] of cases) {
      await knob("FAKE_CLAUDE_AUTH_JSON", auth);
      const refused = await apply(call, "claude", "claude-opus-5-5");
      assert.deepEqual([refused.status, refused.body], [409, { error: "plan_not_ready", message }], auth);
    }
    await rm(path.join(home, ".local", "bin", "claude"));
    await refuseSystemAgent("claude");
    const missing = await apply(call, "claude", "claude-opus-5-5");
    assert.deepEqual([missing.status, missing.body], [409, { error: "plan_not_ready", message: "Install Claude Code first." }]);
    const lines = await argvLines(home);
    assert.ok(!lines.some((line) => line.startsWith("onboard")), "no onboard ran");
    assert.ok(!lines.some((line) => line.startsWith("models list")), "the model list is read only after the sign-in check passes");
    assert.deepEqual(await listFiles(path.join(agentOsHome, "setup", "jobs")), []);
  });
});

test("POST plan: no ChatGPT sign-in and no OpenClaw are plan_not_ready; a running job answers 409 before anything is read", posixSkip, async () => {
  const signedOut = { error: "plan_not_ready", message: "Sign in with ChatGPT first, then try again." };
  await withPlanEnv(
    async ({ call, home, knob }) => {
      const refused = await apply(call, "chatgpt", "gpt-6.1-sol");
      assert.deepEqual([refused.status, refused.body], [409, signedOut], "no ChatGPT profile");
      await knob("FAKE_OPENCLAW_AUTH_JSON", "fail");
      const unreadable = await apply(call, "chatgpt", "gpt-6.1-sol");
      assert.deepEqual([unreadable.status, unreadable.body], [409, signedOut], "a sign-in list that can't be read is not a sign-in");
      assert.ok(!(await argvLines(home)).some((line) => line.startsWith("models set")));
    },
    { state: { authRows: [{ provider: "openai", type: "api_key" }] } }
  );
  await withPlanEnv(
    async ({ call }) => {
      for (const plan of ["claude", "chatgpt"]) {
        const refused = await apply(call, plan, "some-model");
        assert.deepEqual([refused.status, refused.body], [409, { error: "plan_not_ready", message: "Install OpenClaw first." }], plan);
      }
    },
    { openclaw: false }
  );
  await withPlanEnv(async ({ call, home }) => {
    // The first job's runs are held until the second request has its answer.
    const manager = getRunManager();
    const original = manager.startRun;
    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    manager.startRun = async (plan) => {
      await held;
      return original.call(manager, plan);
    };
    let first;
    try {
      first = await apply(call, "claude", "claude-opus-5-5");
      assert.equal(first.status, 200);
      const statusReads = async () => (await agentEnvLog(home)).filter((line) => line.args.join(" ") === "auth status").length;
      const before = await statusReads();
      const second = await apply(call, "claude", "claude-opus-5-5");
      assert.deepEqual([second.status, second.body], [409, { error: "job_already_running" }]);
      assert.equal(await statusReads(), before, "the second request read nothing");
    } finally {
      manager.startRun = original;
      release();
    }
    assert.equal((await waitForPlanJob(first.body.id)).status, "succeeded");
  });
});

test("Claude plan Apply: onboard with anthropic-cli, safe defaults, the runtime check, models set, services, the hello; the receipt and the plan label", posixSkip, async () => {
  await withPlanEnv(async ({ call, home, agentOsHome }) => {
    const started = await apply(call, "claude", "Claude-Opus-5-5");
    assert.equal(started.status, 200);
    const job = started.body;
    assert.equal(job.status, "running");
    assert.deepEqual(
      {
        kind: job.kind,
        plan: job.plan,
        mode: job.mode,
        model: job.model,
        targets: job.targets,
        scope: job.scope,
        acceptOpenClawRisk: job.acceptOpenClawRisk,
        previousPrimary: job.previousPrimary,
        readiness: job.readiness
      },
      {
        kind: "configure",
        plan: "claude",
        mode: "claude-plan",
        model: "claude-opus-5-5",
        targets: { hermes: null, openclaw: { mode: "claude-plan", model: "claude-opus-5-5" } },
        scope: ["openclaw"],
        acceptOpenClawRisk: true,
        previousPrimary: null,
        readiness: null
      },
      "the list's own spelling of the model"
    );
    assert.equal(typeof job.acceptOpenClawRiskAt, "string");
    assert.deepEqual(job.steps.map((step) => [step.id, step.agentId]), [
      ["openclaw-plan-onboard", "openclaw"],
      ["openclaw-safe-defaults", "openclaw"],
      ["openclaw-plan-runtime-check", "openclaw"],
      ["openclaw-plan-model", "openclaw"],
      ["services", null],
      ["health", null]
    ]);
    const done = await waitForPlanJob(job.id);
    assert.equal(done.status, "succeeded", JSON.stringify(done.steps.map((step) => [step.id, step.status, step.error])));
    assert.deepEqual(done.execModeChanged, { from: "full", to: "ask" });
    assert.ok(done.health?.openclaw, "the hello ran");

    const lines = await argvLines(home);
    const onboard = "onboard --non-interactive --accept-risk --auth-choice anthropic-cli --skip-health --skip-channels --skip-skills --skip-ui --install-daemon";
    assert.deepEqual(lines.filter((line) => line.startsWith("onboard") && line !== "onboard --help"), [onboard], "onboard with anthropic-cli and today's optional flags");
    const at = (line) => lines.indexOf(line);
    assert.ok(at("onboard --help") < at(onboard), "the flags are checked against onboard --help first");
    assert.ok(at(onboard) < at("config set tools.exec.mode ask"), "safe defaults right after onboard");
    const runtimeCheck = lines.lastIndexOf("config get agents.defaults.models --json");
    assert.ok(at("config set tools.exec.mode ask") < runtimeCheck, "the runtime check after safe defaults");
    assert.ok(runtimeCheck < at("models set anthropic/claude-opus-5-5"), "the runtime check before models set");
    assert.ok(at("models set anthropic/claude-opus-5-5") < lines.lastIndexOf("doctor --json"), "the hello last");
    assert.equal((await readFakeAgentState(home)).primary, "anthropic/claude-opus-5-5");

    const receipt = await readReceipt();
    assert.equal(receipt.length, 1);
    assert.deepEqual(
      [receipt[0].agentId, receipt[0].action, receipt[0].version, receipt[0].provider, receipt[0].model],
      ["openclaw", "configure", "OpenClaw 2026.9.7", "claude-plan", "claude-opus-5-5"]
    );
    assert.deepEqual(receipt[0].changes, ["Set the model provider to claude-plan", "Set the model to claude-opus-5-5", "tools.exec.mode: full -> ask"]);

    const model = (await call("GET", "/api/setup/agents/openclaw/model")).body;
    assert.deepEqual([model.provider, model.model, model.plan, model.providerLabel], ["anthropic", "claude-opus-5-5", "claude", "Claude plan"]);
    const saved = JSON.parse(await readFile(path.join(agentOsHome, "setup", "jobs", `${job.id}.json`), "utf8"));
    assert.equal(saved.status, "succeeded");
  });
});

test("Claude plan Apply stopped by the runtime check: OpenClaw keeps its old model, and tools.exec.mode is still tightened (Safety 6)", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home }) => {
      const started = await apply(call, "claude", "claude-sonnet-5-5");
      assert.equal(started.status, 200, "before any pin exists every model is offered");
      const done = await waitForPlanJob(started.body.id);
      assert.equal(done.status, "failed");
      const check = stepOf(done, "openclaw-plan-runtime-check");
      assert.deepEqual([check.status, check.error], ["failed", "OpenClaw would use an Anthropic API key for this model, not your Claude plan."]);
      assert.deepEqual(done.steps.slice(3).map((step) => step.status), ["pending", "pending", "pending"]);
      const lines = await argvLines(home);
      assert.ok(!lines.some((line) => line.startsWith("models set")), "OpenClaw is never pointed at a model that would bill an API key");
      assert.ok(lines.includes("config set tools.exec.mode ask"));
      assert.equal(await readFile(path.join(home, ".fake-openclaw-exec-mode"), "utf8"), "ask");
      assert.equal((await readFakeAgentState(home)).primary, "openrouter/vendor/old", "the old model stays");
      const list = await call("GET", "/api/setup/openclaw/plan-models?plan=claude");
      assert.equal(list.body.models.find((model) => model.id === "claude-sonnet-5-5").available, false, "now that pins exist, the list says so");
      assert.deepEqual(await readReceipt(), [], "a stopped job writes no receipt");
    },
    { state: { primary: "openrouter/vendor/old" } }
  );
});

// The counterpart of the test above: there the read WORKED and showed no claude-cli pin (so an API key
// would be billed, RUNTIME_CHECK_FAILED). Here the read itself did not work, which Agent OS must not
// present as a billing fact.
test("Claude plan Apply: when OpenClaw's model settings can't be read (timed out, failed, not JSON), the runtime check stops before models set with its own sentence, not the API-key one", posixSkip, async () => {
  for (const mode of ["timeout", "fail", "garbage"]) {
    await withPlanEnv(
      async ({ call, home, knob }) => {
        await knob("FAKE_OPENCLAW_GET_MODEL_SETTINGS", mode);
        const started = await apply(call, "claude", "claude-opus-5-5");
        assert.equal(started.status, 200, mode);
        const done = await waitForPlanJob(started.body.id);
        const check = stepOf(done, "openclaw-plan-runtime-check");
        assert.deepEqual([done.status, check.status, check.error], ["failed", "failed", MODEL_SETTINGS_UNREADABLE], mode);
        assert.notEqual(check.error, RUNTIME_CHECK_FAILED, mode);
        assert.deepEqual(done.steps.slice(3).map((step) => step.status), ["pending", "pending", "pending"], mode);
        const lines = await argvLines(home);
        assert.ok(lines.includes("config get agents.defaults.models --json"), `${mode}: the settings were asked for`);
        assert.ok(!lines.some((line) => line.startsWith("models set")), `${mode}: OpenClaw is not pointed at anything`);
        assert.equal((await readFakeAgentState(home)).primary, "openrouter/vendor/old", `${mode}: the old model stays`);
        assert.deepEqual(await readReceipt(), [], `${mode}: a stopped job writes no receipt`);
      },
      { state: { primary: "openrouter/vendor/old" } }
    );
  }
});

test("ChatGPT plan Apply: models set, safe defaults, readiness (exit 0 ready, exit 2 expiring with its warning), the hello", posixSkip, async () => {
  for (const [exit, readiness] of [["0", "ready"], ["2", "expiring"]]) {
    await withPlanEnv(
      async ({ call, home, knob }) => {
        await knob("FAKE_OPENCLAW_STATUS_EXIT", exit);
        const started = await apply(call, "chatgpt", "gpt-6.1-sol");
        assert.equal(started.status, 200);
        assert.deepEqual(started.body.steps.map((step) => [step.id, step.agentId]), [
          ["openclaw-plan-model", "openclaw"],
          ["openclaw-safe-defaults", "openclaw"],
          ["openclaw-plan-readiness", "openclaw"],
          ["health", null]
        ]);
        const done = await waitForPlanJob(started.body.id);
        assert.equal(done.status, "succeeded", `exit ${exit}`);
        assert.deepEqual([done.readiness, done.previousPrimary], [readiness, "openrouter/vendor/old"]);
        assert.deepEqual(stepOf(done, "openclaw-plan-readiness").warnings, readiness === "expiring" ? [CHATGPT_EXPIRING] : []);
        const lines = await argvLines(home);
        const order = ["config get agents.defaults.model.primary", "models set openai/gpt-6.1-sol", "config set tools.exec.mode ask", "models status --check --plain"];
        const positions = order.map((line) => lines.indexOf(line));
        assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), JSON.stringify(positions));
        assert.ok(positions[3] < lines.lastIndexOf("doctor --json"), "the hello after readiness");
        assert.deepEqual(lines.filter((line) => line.startsWith("models status")), ["models status --check --plain"]);
        const model = (await call("GET", "/api/setup/agents/openclaw/model")).body;
        assert.deepEqual([model.model, model.plan, model.providerLabel], ["gpt-6.1-sol", "chatgpt", "ChatGPT plan"]);
        const receipt = await readReceipt();
        assert.deepEqual(
          receipt.map((entry) => [entry.provider, entry.model, entry.changes.slice(0, 2)]),
          [["chatgpt-plan", "gpt-6.1-sol", ["Set the model provider to chatgpt-plan", "Set the model to gpt-6.1-sol"]]]
        );
      },
      { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
    );
  }
});

test("ChatGPT plan Apply stopped at readiness puts the earlier model back; with no earlier model, OpenClaw keeps the new one and the job says so", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_EXIT", "1");
      const started = await apply(call, "chatgpt", "gpt-6-luna");
      assert.equal(started.status, 200, "signed in without token sharing is still a sign-in; readiness catches it");
      const done = await waitForPlanJob(started.body.id);
      const step = stepOf(done, "openclaw-plan-readiness");
      assert.deepEqual([done.status, done.readiness, step.status, step.error, step.warnings], ["failed", "not_ready", "failed", CHATGPT_NOT_READY, []]);
      assert.equal(step.runIds.length, 1, "the put-back is a run of its own on the readiness step");
      assert.equal(stepOf(done, "health").status, "pending", "no hello on a plan OpenClaw can't use");
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6-luna", "models set openrouter/vendor/old"]);
      assert.equal((await readFakeAgentState(home)).primary, "openrouter/vendor/old");
      assert.deepEqual(await readReceipt(), []);
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow({ tokenSharing: false })] } }
  );
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_EXIT", "1");
      const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
      const step = stepOf(done, "openclaw-plan-readiness");
      assert.deepEqual(
        [done.status, done.previousPrimary, step.error, step.warnings],
        ["failed", null, CHATGPT_NOT_READY, ["OpenClaw had no model set before, so it keeps openai/gpt-6.1-sol."]]
      );
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol"]);
      assert.equal((await readFakeAgentState(home)).primary, "openai/gpt-6.1-sol");
    },
    { state: { primary: null, authRows: [siwcRow()] } }
  );
});

// How long a test waits after a cancel to be sure nothing starts late.
const AFTER_CANCEL_MS = 1200;
// What a cancelled Apply must never have run (onboard --help only reads).
const CHANGING_CALL = /^(models set|onboard --non-interactive|config set)/;

// Waits until the fake OpenClaw has seen one more call that starts with `prefix` than `seen`.
async function waitForAnotherCall(home, prefix, seen) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if ((await argvLines(home)).filter((line) => line.startsWith(prefix)).length > seen) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the fake OpenClaw never saw another "${prefix}"`);
}
const callsStarting = async (home, prefix) => (await argvLines(home)).filter((line) => line.startsWith(prefix)).length;

test("Cancel during a plan Apply's system check: the first step never runs (no onboard, no models set), for both plans", posixSkip, async () => {
  for (const [plan, model] of [["claude", "claude-opus-5-5"], ["chatgpt", "gpt-6.1-sol"]]) {
    await withPlanEnv(
      async ({ home }) => {
        // In process, so the cancel lands while the job is still in its system check.
        const job = await startOpenclawPlanJob({ plan, model, acceptOpenClawRisk: true });
        const cancelled = await cancelSetupJob(job.id);
        assert.equal(cancelled.status, "cancelled", plan);
        await new Promise((resolve) => setTimeout(resolve, AFTER_CANCEL_MS));
        const lines = await argvLines(home);
        assert.deepEqual(lines.filter((line) => CHANGING_CALL.test(line)), [], `${plan}: nothing was changed`);
        assert.ok(!lines.includes("config get agents.defaults.model.primary"), `${plan}: not even the earlier model was read`);
        assert.ok(!lines.includes("onboard --help"), `${plan}: no first step at all`);
        const done = await waitForPlanJob(job.id);
        assert.deepEqual([done.status, done.steps.map((step) => step.status)], ["cancelled", done.steps.map(() => "pending")], plan);
        assert.equal((await readFakeAgentState(home)).primary, "openrouter/vendor/old", `${plan}: OpenClaw keeps its model`);
        assert.deepEqual(await readReceipt(), [], `${plan}: a cancelled job writes no receipt`);
      },
      { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
    );
  }
});

test("Cancel during the ChatGPT Apply's read of the earlier model: models set never runs, and Cancel answers only after the read has ended", posixSkip, async () => {
  await withPlanEnv(
    async ({ home, knob }) => {
      await knob("FAKE_OPENCLAW_READ_DELAY_MS", "1500");
      const timingFile = path.join(home, ".fake-openclaw-timing.jsonl");
      const job = await startOpenclawPlanJob({ plan: "chatgpt", model: "gpt-6.1-sol", acceptOpenClawRisk: true });
      const reads = await callsStarting(home, "config get agents.defaults.model.primary");
      await waitForAnotherCall(home, "config get agents.defaults.model.primary", reads);
      const answer = cancelSetupJob(job.id);
      // While the read runs, a poll (the card's, every second) still sees the job running: only the settled job
      // reads cancelled, so the card never re-reads the model before the step has ended.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await getSetupJob(job.id)).status, "running", "a poll during Cancel's wait sees the job still running");
      const cancelled = await answer;
      assert.equal(cancelled.status, "cancelled");
      // The slow read had finished (the fake notes that as it ends) by the time Cancel answered.
      const timings = await readJsonLines(timingFile);
      assert.ok(timings.some((entry) => entry.argv.join(" ") === "config get agents.defaults.model.primary" && entry.endedAt <= Date.now()), JSON.stringify(timings));
      await new Promise((resolve) => setTimeout(resolve, AFTER_CANCEL_MS));
      assert.deepEqual((await argvLines(home)).filter((line) => CHANGING_CALL.test(line)), [], "no models set after the cancel");
      assert.equal((await readFakeAgentState(home)).primary, "openrouter/vendor/old");
      const done = await waitForPlanJob(job.id);
      assert.equal(done.status, "cancelled");
      assert.deepEqual(done.steps.map((step) => step.status), ["failed", "pending", "pending", "pending"]);
      assert.equal(stepOf(done, "openclaw-plan-model").error, "Cancelled.");
      assert.deepEqual(await readReceipt(), []);
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

test("Cancel during the Claude plan Apply's onboard --help: onboard never runs", posixSkip, async () => {
  await withPlanEnv(
    async ({ home, knob }) => {
      await knob("FAKE_OPENCLAW_READ_DELAY_MS", "1500");
      const job = await startOpenclawPlanJob({ plan: "claude", model: "claude-opus-5-5", acceptOpenClawRisk: true });
      const helps = await callsStarting(home, "onboard --help");
      await waitForAnotherCall(home, "onboard --help", helps);
      assert.equal((await cancelSetupJob(job.id)).status, "cancelled");
      await new Promise((resolve) => setTimeout(resolve, AFTER_CANCEL_MS));
      const lines = await argvLines(home);
      assert.deepEqual(lines.filter((line) => CHANGING_CALL.test(line)), [], "onboard and models set never ran");
      const done = await waitForPlanJob(job.id);
      assert.deepEqual([done.status, stepOf(done, "openclaw-plan-onboard").status, stepOf(done, "openclaw-plan-onboard").error], ["cancelled", "failed", "Cancelled."]);
      assert.deepEqual(done.steps.slice(1).map((step) => step.status), ["pending", "pending", "pending", "pending", "pending"]);
      assert.deepEqual(await readReceipt(), []);
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

test("ChatGPT plan Apply: a current model that can't be read (timed out, can't run) or can't be put back (not a plain model name) stops it before models set with nothing changed, each with its own sentence; a plain failed read still counts as no earlier model", posixSkip, async () => {
  // A model name that is parseable (a space, or 121-200 characters) but is not one Agent OS puts back on a command line.
  const spaced = "openrouter/vendor/old model";
  const tooLong = `openrouter/${"a".repeat(139)}`;
  const cases = [
    // [why, FAKE_OPENCLAW_GET_PRIMARY, the vanish knob, primary, the sentence]
    ["the read timed out", "timeout", null, "openrouter/vendor/old", CURRENT_MODEL_UNREADABLE],
    ["the program could not run for the read", null, "gateway status", "openrouter/vendor/old", CURRENT_MODEL_UNREADABLE],
    ["the name has a space", null, null, spaced, CURRENT_MODEL_NOT_RESTORABLE],
    ["the name is 150 characters long", null, null, tooLong, CURRENT_MODEL_NOT_RESTORABLE],
    // Set, but with a character the config reader drops (it is not "no model set").
    ["the name has a plus sign", null, null, "custom/qwen3+coder", CURRENT_MODEL_NOT_RESTORABLE],
    ["the name has an accented letter", null, null, "custom/modèle", CURRENT_MODEL_NOT_RESTORABLE]
  ];
  for (const [why, mode, vanish, primary, sentence] of cases) {
    await withPlanEnv(
      async ({ call, home, knob }) => {
        // Once the launcher is gone, which() also looks in /opt/homebrew/bin and /usr/local/bin.
        if (vanish) await refuseSystemAgentFolders("openclaw");
        if (mode) await knob("FAKE_OPENCLAW_GET_PRIMARY", mode);
        if (vanish) await knob("FAKE_OPENCLAW_VANISH_AFTER", vanish);
        const started = await apply(call, "chatgpt", "gpt-6.1-sol");
        assert.equal(started.status, 200, why);
        const done = await waitForPlanJob(started.body.id);
        const step = stepOf(done, "openclaw-plan-model");
        assert.deepEqual([done.status, step.status, step.error, step.warnings, done.previousPrimary], ["failed", "failed", sentence, [], null], why);
        assert.notEqual(step.warnings[0], noEarlierPrimary("openai/gpt-6.1-sol"), why);
        assert.deepEqual(done.steps.slice(1).map((entry) => entry.status), ["pending", "pending", "pending"], why);
        const lines = await argvLines(home);
        if (vanish) {
          assert.ok(!lines.includes("config get agents.defaults.model.primary"), `${why}: the program was gone, so the read never ran`);
          await knob("FAKE_OPENCLAW_VANISH_AFTER", null);
          await installFakeOpenclawShim(home);
        } else {
          assert.ok(lines.includes("config get agents.defaults.model.primary"), `${why}: the current model was asked for`);
        }
        assert.ok(!lines.some((line) => line.startsWith("models set")), `${why}: no models set`);
        assert.ok(!lines.includes("config set tools.exec.mode ask"), `${why}: nothing changed, not even the safe defaults`);
        assert.equal((await readFakeAgentState(home)).primary, primary, `${why}: the model stays`);
        assert.deepEqual(await readReceipt(), [], `${why}: a stopped job writes no receipt`);
        if (mode) await knob("FAKE_OPENCLAW_GET_PRIMARY", null);
        if (sentence === CURRENT_MODEL_NOT_RESTORABLE) {
          // Reading was fine, so trying again changes nothing: only switching OpenClaw to another model does.
          const same = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
          assert.deepEqual([same.status, stepOf(same, "openclaw-plan-model").error], ["failed", CURRENT_MODEL_NOT_RESTORABLE], `${why}: Apply again stops the same way`);
          await writeFakeAgentState(home, { primary: "openrouter/vendor/old", models: null, authRows: [siwcRow()] });
        }
        const again = await apply(call, "chatgpt", "gpt-6.1-sol");
        assert.equal(again.status, 200, `${why}: Apply again`);
        const second = await waitForPlanJob(again.body.id);
        assert.deepEqual([second.status, second.previousPrimary], ["succeeded", "openrouter/vendor/old"], why);
      },
      { state: { primary, authRows: [siwcRow()] } }
    );
  }

  // A plain non-zero exit is kept as "no model set" until live check S-B3: the earlier behaviour.
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_GET_PRIMARY", "fail");
      await knob("FAKE_OPENCLAW_STATUS_EXIT", "1");
      const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
      const step = stepOf(done, "openclaw-plan-readiness");
      assert.deepEqual(
        [done.status, done.previousPrimary, step.error, step.warnings],
        ["failed", null, CHATGPT_NOT_READY, [noEarlierPrimary("openai/gpt-6.1-sol")]]
      );
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol"]);
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

test("Safety 6: both plans tighten tools.exec.mode from full and from unset, and leave ask as it is", posixSkip, async () => {
  for (const plan of ["claude", "chatgpt"]) {
    for (const [execMode, why] of [["full", "full"], ["", "unset"], ["ask", "already ask"]]) {
      await withPlanEnv(
        async ({ call, home }) => {
          const done = await waitForPlanJob((await apply(call, plan, plan === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol")).body.id);
          assert.equal(done.status, "succeeded", `${plan}, ${why}`);
          const sets = (await argvLines(home)).filter((line) => line.startsWith("config set tools.exec.mode"));
          if (execMode === "ask") {
            assert.deepEqual(sets, [], `${plan}: ask is left as it is`);
            assert.equal(done.execModeChanged, undefined);
          } else {
            assert.deepEqual(sets, ["config set tools.exec.mode ask"], `${plan}, ${why}`);
            assert.deepEqual(done.execModeChanged, { from: "full", to: "ask" }, `${plan}, ${why}`);
          }
          assert.equal(await readFile(path.join(home, ".fake-openclaw-exec-mode"), "utf8"), "ask", `${plan}, ${why}`);
        },
        { execMode, state: { authRows: [siwcRow()] } }
      );
    }
  }
});

test("A plan job's hello is held to 90 s, like a model change's; models auth list and models status never go through the run manager", posixSkip, async () => {
  await withPlanEnv(
    async ({ call }) => {
      const manager = getRunManager();
      const original = manager.startRun;
      const plans = [];
      manager.startRun = (plan) => {
        plans.push(plan);
        return original.call(manager, plan);
      };
      try {
        for (const [plan, model] of [["claude", "claude-opus-5-5"], ["chatgpt", "gpt-6.1-sol"]]) {
          const done = await waitForPlanJob((await apply(call, plan, model)).body.id);
          assert.equal(done.status, "succeeded", plan);
        }
      } finally {
        manager.startRun = original;
      }
      const hellos = plans.filter((plan) => plan.kind === "agent");
      assert.equal(hellos.length, 2, "one hello per job");
      for (const hello of hellos) assert.ok(hello.timeoutMs <= 90000, `hello limit ${hello.timeoutMs} ms`);
      for (const plan of plans) {
        assert.ok(!(plan.args[0] === "models" && ["auth", "status", "list"].includes(plan.args[1])), `went through the run manager: ${plan.args.join(" ")}`);
      }
    },
    { state: { authRows: [siwcRow()] } }
  );
});

test("Look only: both plans are still applied, but the hello is skipped with today's sentence and no agent run starts (spec section 2, step 6)", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home }) => {
      await setExecutionGateStatus({ enabled: false, reason: "look only" });
      const manager = getRunManager();
      const original = manager.startRun;
      const plans = [];
      manager.startRun = (plan) => {
        plans.push(plan);
        return original.call(manager, plan);
      };
      try {
        for (const [plan, model] of [["claude", "claude-opus-5-5"], ["chatgpt", "gpt-6.1-sol"]]) {
          const done = await waitForPlanJob((await apply(call, plan, model)).body.id);
          assert.equal(done.status, "succeeded", `${plan}: a skipped hello is not a failure`);
          assert.equal(done.health?.openclaw?.skipped, true, plan);
          assert.equal(done.health.openclaw.hint, HELLO_SKIPPED_AT_LOOK_ONLY, plan);
          assert.equal(done.health.openclaw.promptOk, false, `${plan}: nothing answered, so it is never a tick`);
          const health = stepOf(done, "health");
          assert.deepEqual([health.status, health.runIds], ["succeeded", []], plan);
          assert.ok(health.log.some((line) => line.endsWith(` ${HELLO_SKIPPED_AT_LOOK_ONLY}`)), `${plan}: ${health.log.join(" | ")}`);
        }
      } finally {
        manager.startRun = original;
      }
      assert.deepEqual(plans.filter((plan) => plan.kind === "agent").map((plan) => plan.args.join(" ")), [], "no agent run reached the run manager");
      const lines = await argvLines(home);
      assert.ok(lines.includes("models set anthropic/claude-opus-5-5") && lines.includes("models set openai/gpt-6.1-sol"), "both plans were applied");
      assert.ok(!lines.some((line) => (line.startsWith("agent") || line.startsWith("doctor")) && !line.includes("--help")), "nothing was asked to reply");
    },
    { state: { authRows: [siwcRow()] } }
  );
});

test("The output of models auth list and models status is never logged, saved or returned", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, agentOsHome, knob }) => {
      const printed = [];
      const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
      for (const name of Object.keys(originals)) {
        console[name] = (...args) => {
          printed.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
        };
      }
      const answers = [];
      let job;
      try {
        answers.push((await call("GET", "/api/setup/openclaw/plans")).text);
        answers.push((await call("GET", "/api/setup/agents/openclaw/model")).text);
        await knob("FAKE_OPENCLAW_STATUS_EXIT", "2");
        const started = await apply(call, "chatgpt", "gpt-6.1-sol");
        answers.push(started.text);
        job = await waitForPlanJob(started.body.id);
        answers.push((await call("GET", `/api/setup/jobs/${job.id}`)).text);
        answers.push((await call("GET", "/api/setup/openclaw/plans")).text);
        answers.push((await call("GET", "/api/setup/agents/openclaw/model")).text);
      } finally {
        Object.assign(console, originals);
      }
      assert.equal(job.status, "succeeded");
      const files = await listFiles(agentOsHome);
      assert.ok(files.length > 0);
      for (const secret of [FAKE_SECRET, "someone@example.com", "accessToken"]) {
        for (const answer of answers) assert.ok(!answer.includes(secret), `${secret} in an answer`);
        assert.ok(!printed.some((line) => line.includes(secret)), `${secret} in the server's log`);
        for (const file of files) {
          assert.ok(!(await readFile(file, "utf8")).includes(secret), `${secret} in ${path.relative(agentOsHome, file)}`);
        }
      }
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

test("A typed model name, accepted while the list is the fallback, is applied under its own name", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_MODELS_JSON", "fail");
      const refused = await apply(call, "chatgpt", "GPT 7!");
      assert.deepEqual([refused.status, refused.body], [400, { error: "invalid_model_id", message: "That doesn't look like a model name." }]);
      const started = await apply(call, "chatgpt", "openai/gpt-7.0-terra");
      assert.deepEqual([started.status, started.body.model], [200, "gpt-7.0-terra"]);
      assert.equal((await waitForPlanJob(started.body.id)).status, "succeeded");
      assert.ok((await argvLines(home)).includes("models set openai/gpt-7.0-terra"));
    },
    { state: { authRows: [siwcRow()] } }
  );
});

test("A plan job left running by a quit is answered and saved as failed on the step that never finished; retry stays refused; Apply runs every step again (Review Focus 5)", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, agentOsHome }) => {
      const jobsDir = path.join(agentOsHome, "setup", "jobs");
      await mkdir(jobsDir, { recursive: true });
      const storedPlanJob = (id, { statuses = ["succeeded", "running", "pending", "pending", "pending", "pending"], currentStepIndex = 1 } = {}) => ({
        id,
        kind: "configure",
        status: "running",
        plan: "claude",
        mode: "claude-plan",
        model: "claude-opus-5-5",
        targets: { hermes: null, openclaw: { mode: "claude-plan", model: "claude-opus-5-5" } },
        scope: ["openclaw"],
        steps: PLAN_JOB_STEPS.claude.map((stepId, index) => ({
          id: stepId,
          agentId: stepId === "services" || stepId === "health" ? null : "openclaw",
          action: "run",
          status: statuses[index],
          runIds: [],
          error: null,
          log: [],
          warnings: []
        })),
        currentStepIndex,
        startedAt: "2026-10-16T09:00:00.000Z",
        endedAt: null,
        acceptOpenClawRisk: true,
        acceptOpenClawRiskAt: "2026-10-16T09:00:00.000Z",
        previousPrimary: null,
        readiness: null
      });
      const id = "job_test_quit_plan";
      await writeFile(path.join(jobsDir, `${id}.json`), JSON.stringify(storedPlanJob(id)));
      const answered = await call("GET", `/api/setup/jobs/${id}`);
      assert.equal(answered.status, 200);
      assert.equal(answered.body.status, "failed", "the card never spins forever");
      assert.deepEqual(answered.body.steps.map((step) => step.status), ["succeeded", "failed", "pending", "pending", "pending", "pending"]);
      assert.equal(answered.body.steps[1].error, "Agent OS quit before this finished. Apply the plan again.");
      assert.equal(typeof answered.body.endedAt, "string");
      const saved = JSON.parse(await readFile(path.join(jobsDir, `${id}.json`), "utf8"));
      assert.deepEqual([saved.status, saved.steps[1].error], ["failed", PLAN_JOB_INTERRUPTED], "the failed answer is saved");
      const retry = await call("POST", `/api/setup/jobs/${id}/retry`, {});
      assert.deepEqual([retry.status, retry.body], [409, { error: "key_required_for_retry" }], "the way back is Apply again");
      // A stale plan job that nothing has read yet is refused by retry too.
      await writeFile(path.join(jobsDir, "job_test_quit_plan_2.json"), JSON.stringify(storedPlanJob("job_test_quit_plan_2")));
      await assert.rejects(() => retrySetupJob("job_test_quit_plan_2"), (error) => error.code === "key_required_for_retry");
      // Quit between saving step 2 as succeeded and saving step 3 as running:
      // currentStepIndex still points at the step that succeeded, so the first
      // step that never finished is the one marked, never the one that succeeded.
      const between = "job_test_quit_between_steps";
      await writeFile(
        path.join(jobsDir, `${between}.json`),
        JSON.stringify(storedPlanJob(between, { statuses: ["succeeded", "succeeded", "pending", "pending", "pending", "pending"], currentStepIndex: 1 }))
      );
      const betweenAnswer = await getSetupJob(between);
      assert.equal(betweenAnswer.status, "failed");
      assert.deepEqual(betweenAnswer.steps.map((step) => step.status), ["succeeded", "succeeded", "failed", "pending", "pending", "pending"]);
      assert.deepEqual([betweenAnswer.steps[1].error, betweenAnswer.steps[2].error], [null, PLAN_JOB_INTERRUPTED]);
      // Another kind of job keeps today's answer.
      await writeFile(
        path.join(jobsDir, "job_test_other_running.json"),
        JSON.stringify({ id: "job_test_other_running", kind: "configure", status: "running", mode: "openrouter", model: "vendor/x", steps: [], startedAt: "2026-10-16T09:00:00.000Z", endedAt: null })
      );
      assert.equal((await getSetupJob("job_test_other_running")).status, "running");

      const done = await waitForPlanJob((await apply(call, "claude", "claude-opus-5-5")).body.id);
      assert.equal(done.status, "succeeded");
      assert.deepEqual(done.steps.map((step) => step.status), ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
      assert.ok((await argvLines(home)).includes("config set tools.exec.mode ask"), "safe defaults ran again");
    },
    { execMode: "full" }
  );
});

test("An interrupted ChatGPT plan job is read back as failed on the step that never finished, with the quit sentence, and saved that way", posixSkip, async () => {
  await withPlanEnv(async ({ call, agentOsHome }) => {
    // Agent OS quit while the safe defaults ran: the model step had succeeded.
    const duringDefaults = storedChatgptJob({ minutesAgo: 9, statuses: ["succeeded", "running", "pending", "pending"] });
    // Agent OS quit during `models set` itself: the model step was the one running.
    const duringModel = storedChatgptJob({ minutesAgo: 8, statuses: ["running", "pending", "pending", "pending"] });
    // Agent OS quit between saving one step as succeeded and the next as running.
    const between = storedChatgptJob({ minutesAgo: 7, statuses: ["succeeded", "succeeded", "pending", "pending"] });
    const jobsDir = await putStoredJobs(agentOsHome, [duringDefaults, duringModel, between]);

    const first = await call("GET", `/api/setup/jobs/${duringDefaults.id}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "failed", "the card never spins forever");
    assert.deepEqual(first.body.steps.map((step) => step.id), [...PLAN_JOB_STEPS.chatgpt]);
    assert.deepEqual(first.body.steps.map((step) => step.status), ["succeeded", "failed", "pending", "pending"]);
    assert.deepEqual(first.body.steps.map((step) => step.error), [null, PLAN_JOB_INTERRUPTED, null, null]);
    assert.equal(first.body.previousPrimary, "openrouter/vendor/old", "what the job recorded is kept");
    assert.equal(typeof first.body.endedAt, "string");
    const saved = JSON.parse(await readFile(path.join(jobsDir, `${duringDefaults.id}.json`), "utf8"));
    assert.deepEqual([saved.status, saved.steps[1].error], ["failed", PLAN_JOB_INTERRUPTED], "the failed answer is saved");
    // Read again, it is the same answer (now from the saved copy).
    assert.deepEqual((await call("GET", `/api/setup/jobs/${duringDefaults.id}`)).body, first.body);

    const model = await getSetupJob(duringModel.id);
    assert.deepEqual(model.steps.map((step) => step.status), ["failed", "pending", "pending", "pending"]);
    assert.equal(model.steps[0].error, PLAN_JOB_INTERRUPTED);
    const betweenAnswer = await getSetupJob(between.id);
    assert.deepEqual(betweenAnswer.steps.map((step) => step.status), ["succeeded", "succeeded", "failed", "pending"]);
    assert.deepEqual(betweenAnswer.steps.map((step) => step.error), [null, null, PLAN_JOB_INTERRUPTED, null]);

    const retry = await call("POST", `/api/setup/jobs/${duringDefaults.id}/retry`, {});
    assert.deepEqual([retry.status, retry.body], [409, { error: "key_required_for_retry" }], "the way back is Apply again");
  });
});

test("A plan job whose runner fails outside a step (the receipt can't be saved) is saved as failed with its own error, never as 'Agent OS quit'; a stored running job that no runner owns still gets the quit sentence", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, agentOsHome }) => {
      // The receipt's file is a folder, so adding to the receipt fails once every step has run.
      await mkdir(path.join(agentOsHome, "setup", "receipt.json"), { recursive: true });
      const started = await apply(call, "chatgpt", "gpt-6.1-sol");
      assert.equal(started.status, 200);
      const done = await waitForPlanJob(started.body.id);
      assert.equal(done.status, "failed");
      const errors = done.steps.map((step) => step.error).filter(Boolean);
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.notEqual(errors[0], PLAN_JOB_INTERRUPTED, "Agent OS did not quit: it ran and the receipt failed");
      assert.ok(!errors[0].includes("quit"), errors[0]);
      assert.equal(done.steps.find((step) => step.error).status, "failed");
      assert.equal(typeof done.endedAt, "string");

      // Saved that way: once nothing in this process owns the job any more, a read still gives the same answer.
      const jobFile = path.join(agentOsHome, "setup", "jobs", `${started.body.id}.json`);
      const deadline = Date.now() + 5000;
      let saved = JSON.parse(await readFile(jobFile, "utf8"));
      while (saved.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        saved = JSON.parse(await readFile(jobFile, "utf8"));
      }
      assert.equal(saved.status, "failed", "the failure reached the disk");
      resetSetupJobsForTest();
      const later = await call("GET", `/api/setup/jobs/${started.body.id}`);
      assert.equal(later.status, 200);
      assert.deepEqual(later.body.steps.map((step) => step.error).filter(Boolean), errors, "a later read says the same thing");
      assert.equal(later.body.status, "failed");

      // The lock is free again, and Apply works once the receipt can be saved.
      await rm(path.join(agentOsHome, "setup", "receipt.json"), { recursive: true, force: true });
      const again = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
      assert.equal(again.status, "succeeded");

      // A stored running job with no runner in this process is still "Agent OS quit".
      const orphan = storedChatgptJob({ minutesAgo: 1, statuses: ["succeeded", "running", "pending", "pending"] });
      await writeFile(path.join(agentOsHome, "setup", "jobs", `${orphan.id}.json`), JSON.stringify(orphan));
      const orphanAnswer = await getSetupJob(orphan.id);
      assert.deepEqual([orphanAnswer.status, orphanAnswer.steps[1].error], ["failed", PLAN_JOB_INTERRUPTED]);
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

test("ChatGPT plan Apply after an interrupted or failed Apply: the half-applied openai model is never recorded as the earlier model, and the earlier Apply's own earlier model is put back", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, agentOsHome, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_EXIT", "1"); // readiness fails, so the earlier model is put back
      const HALF = "openai/gpt-6.1-sol";
      // Runs one Apply of gpt-6-luna with these jobs stored and this primary; answers what it recorded and put back.
      const applyWith = async (why, jobs, { primary = HALF } = {}) => {
        await putStoredJobs(agentOsHome, jobs);
        await writeFakeAgentState(home, { primary, models: null, authRows: [siwcRow()] });
        const before = (await argvLines(home)).length;
        const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6-luna")).body.id);
        assert.equal(done.status, "failed", `${why}: readiness stops it`);
        const sets = (await argvLines(home)).slice(before).filter((line) => line.startsWith("models set"));
        return { previousPrimary: done.previousPrimary, sets, primaryAfter: (await readFakeAgentState(home)).primary, step: stepOf(done, "openclaw-plan-readiness") };
      };

      // 1. Agent OS quit after `models set openai/gpt-6.1-sol`: the job is still saved as running.
      const quit = await applyWith("quit", [storedChatgptJob({ statuses: ["succeeded", "running", "pending", "pending"] })]);
      assert.equal(quit.previousPrimary, "openrouter/vendor/old", "the interrupted job's earlier model, not the half-applied one");
      assert.deepEqual(quit.sets, ["models set openai/gpt-6-luna", "models set openrouter/vendor/old"]);
      assert.equal(quit.primaryAfter, "openrouter/vendor/old");

      // 2. The same job after a read already saved it as failed with the quit sentence.
      const marked = storedChatgptJob({ statuses: ["succeeded", "failed", "pending", "pending"], status: "failed", errors: { "openclaw-safe-defaults": PLAN_JOB_INTERRUPTED } });
      assert.equal((await applyWith("marked", [marked])).previousPrimary, "openrouter/vendor/old");

      // 3. It failed after `models set` (a later step stopped it, and the put-back did not happen).
      const failed = await applyWith("failed after models set", [
        storedChatgptJob({ statuses: ["succeeded", "succeeded", "failed", "pending"], status: "failed", errors: { "openclaw-plan-readiness": CHATGPT_NOT_READY } })
      ]);
      assert.equal(failed.previousPrimary, "openrouter/vendor/old");
      assert.equal(failed.primaryAfter, "openrouter/vendor/old");

      // 4. The interrupted job had no earlier model: that is what is recorded, and OpenClaw keeps the new one.
      const none = await applyWith("no earlier model", [storedChatgptJob({ previousPrimary: null })]);
      assert.equal(none.previousPrimary, null);
      assert.deepEqual(none.sets, ["models set openai/gpt-6-luna"]);
      assert.deepEqual(none.step.warnings, [noEarlierPrimary("openai/gpt-6-luna")]);

      // 5. Only the newest ChatGPT job counts: a newer one that succeeded ends the question.
      const newerOk = await applyWith("a newer job succeeded", [
        storedChatgptJob({ minutesAgo: 9 }),
        storedChatgptJob({ minutesAgo: 3, status: "succeeded", statuses: ["succeeded", "succeeded", "succeeded", "succeeded"] })
      ]);
      assert.equal(newerOk.previousPrimary, HALF, "that is the model OpenClaw had before this Apply");
      assert.deepEqual(newerOk.sets, ["models set openai/gpt-6-luna", `models set ${HALF}`]);

      // 6. A model that is not the interrupted job's own openai model is just what OpenClaw has.
      const other = await applyWith("another model", [storedChatgptJob()], { primary: "openrouter/vendor/new" });
      assert.equal(other.previousPrimary, "openrouter/vendor/new");

      // 7. A Claude plan job, or an interrupted job that never reached `models set`, is not asked.
      assert.equal((await applyWith("a Claude plan job", [storedChatgptJob({ plan: "claude", statuses: ["succeeded", "running"] })])).previousPrimary, HALF);
      assert.equal(
        (await applyWith("stopped before models set", [storedChatgptJob({ statuses: ["failed", "pending", "pending", "pending"], status: "failed", errors: { "openclaw-plan-model": CURRENT_MODEL_UNREADABLE } })])).previousPrimary,
        HALF
      );

      // 8. A saved earlier model that is not a plain model reference is never put on a command line.
      const tampered = await applyWith("not a plain reference", [storedChatgptJob({ previousPrimary: "--probe" })]);
      assert.equal(tampered.previousPrimary, HALF);
      assert.ok(!tampered.sets.some((line) => line.includes("--probe")), "nothing odd was run");

      // 9. A cancelled job counts like one that failed, once its `models set` was reached: the model step finished,
      // or its run was the one Cancel stopped. A job cancelled before `models set` ran changed nothing.
      const cancelledAfter = await applyWith("cancelled after models set", [
        storedChatgptJob({ statuses: ["succeeded", "failed", "pending", "pending"], status: "cancelled", errors: { "openclaw-safe-defaults": "Cancelled." } })
      ]);
      assert.equal(cancelledAfter.previousPrimary, "openrouter/vendor/old", "the cancelled job's earlier model, not the half-applied one");
      assert.equal(cancelledAfter.primaryAfter, "openrouter/vendor/old");
      const stoppedRun = storedChatgptJob({ statuses: ["failed", "pending", "pending", "pending"], status: "cancelled", errors: { "openclaw-plan-model": "openclaw models set failed; see the run log." } });
      stoppedRun.steps[0].runIds = ["run_stopped_by_cancel"];
      assert.equal((await applyWith("cancel stopped models set", [stoppedRun])).previousPrimary, "openrouter/vendor/old");
      const beforeRun = storedChatgptJob({ statuses: ["failed", "pending", "pending", "pending"], status: "cancelled", errors: { "openclaw-plan-model": "Cancelled." } });
      assert.equal((await applyWith("cancelled before models set", [beforeRun])).previousPrimary, HALF);
      assert.equal((await applyWith("cancelled at the first step", [storedChatgptJob({ statuses: ["pending", "pending", "pending", "pending"], status: "cancelled" })])).previousPrimary, HALF);
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

test("POST /api/setup/configure and startConfigureJob still refuse claude-plan and chatgpt-plan", posixSkip, async () => {
  await withPlanEnv(async ({ call, home }) => {
    const modeError = { ok: false, error: 'mode must be "openrouter" or "ollama"' };
    for (const mode of ["claude-plan", "chatgpt-plan"]) {
      const viaTargets = await call("POST", "/api/setup/configure", { confirm: true, targets: { openclaw: { mode, model: "claude-opus-5-5" } }, acceptOpenClawRisk: true });
      assert.deepEqual([viaTargets.status, viaTargets.body], [400, modeError], mode);
      const viaMode = await call("POST", "/api/setup/configure", { confirm: true, mode, model: "gpt-6.1-sol", acceptOpenClawRisk: true });
      assert.deepEqual([viaMode.status, viaMode.body], [400, modeError], mode);
      await assert.rejects(
        () => startConfigureJob({ targets: { openclaw: { mode, model: "x" } }, acceptOpenClawRisk: true }),
        (error) => error.code === "invalid_mode",
        mode
      );
    }
    assert.deepEqual(await openclawRecord(home), [], "nothing ran");
  });
});

test("Every plan route answers 404 not_available outside local mode, and runs nothing", posixSkip, async () => {
  for (const vars of [{ DEMO_PUBLIC: "1" }, { HERMES_AGENT_OS_REQUIRE_AUTH: "1" }, { HERMES_AGENT_OS_PUBLIC_MODE: "1" }]) {
    await withPlanEnv(async ({ call, home }) => {
      await withEnv(vars, async () => {
        const routes = [
          ["GET", "/api/setup/openclaw/plans"],
          ["GET", "/api/setup/openclaw/plan-models?plan=claude"],
          ["POST", "/api/setup/openclaw/plan", { plan: "claude", model: "claude-opus-5-5", confirm: true, acceptOpenClawRisk: true }]
        ];
        for (const [method, url, body] of routes) {
          const refused = await call(method, url, body);
          assert.deepEqual([refused.status, refused.body], [404, { error: "not_available" }], `${JSON.stringify(vars)} ${method} ${url}`);
        }
      });
      assert.deepEqual(await openclawRecord(home), []);
      assert.deepEqual(await agentEnvLog(home), []);
    });
  }
});
