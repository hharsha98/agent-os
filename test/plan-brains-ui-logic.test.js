// Plan brains, the UI's side (Task B2; spec docs/superpowers/specs/2026-10-15-plan-brains-design.md): the words and
// pure rules of src/ui/planBrainsShared.ts, the plan mode and step labels of src/ui/brainShared.ts, the new client
// calls of src/setupApi.ts (driven with a fake fetch and a fake sessionStorage), and the client words that mirror the
// server's own: server/runtime/setup/openclaw-plan-rules.js is pure and is imported; the two version sentences of
// server/runtime/setup/openclaw-version.js are read as text, so this file loads nothing that touches the disk. The
// sign-in terminal's name is the setup session's own title (sessionTitle in src/ui/sessionsShared.ts, Task B1a).
// Nothing here talks to a server or starts anything; the cards themselves are checked by the plan-brains probe of
// the UI audit. setupApi.ts imports its neighbours without a file extension (the Vite way), which Node does not
// follow by itself, so this file first teaches Node that one rule (a resolve hook that adds .ts), as
// test/sessions-api.test.js does.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const extension of [".ts", ".tsx"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const shared = await import("../src/ui/planBrainsShared.ts");
const brain = await import("../src/ui/brainShared.ts");
const home = await import("../src/ui/homeShared.ts");
const group = await import("../src/ui/setupGroupShared.ts");
const sessions = await import("../src/ui/sessionsShared.ts");
const setupApi = await import("../src/setupApi.ts");
const rules = await import("../server/runtime/setup/openclaw-plan-rules.js");
const SPEC = read("docs/superpowers/specs/2026-10-15-plan-brains-design.md");

const plansOf = ({ version = {}, claude = {}, chatgpt = {} } = {}) => ({
  version: { have: "2026.9.7", need: "2026.9.7", newEnough: true, ...version },
  claude: { installed: true, status: "signed_in", method: "claude.ai", note: "", ...claude },
  chatgpt: { signedIn: false, sharing: null, readiness: null, ...chatgpt }
});
const listOf = (source, models) => ({ source, asOf: source === "fallback" ? "2026-10-15" : null, models });
const model = (id, available = true) => ({ id, name: id, note: null, available });
const apiError = (code, detail, status) => Object.assign(new Error(code), { name: "ApiError", detail, status });

test("every sentence the cards show is the spec's, word for word, in straight quotes and with no em dash", () => {
  const sentences = [
    shared.OPENCLAW_SECURITY_NOTICE,
    shared.PLAN_LABEL.claude,
    shared.PLAN_LABEL.chatgpt,
    shared.PLAN_NOTE.claude,
    shared.PLAN_NOTE.chatgpt,
    ...Object.values(shared.CLAUDE_PLAN_WORDS),
    ...Object.values(shared.CHATGPT_PLAN_WORDS),
    shared.FALLBACK_LIST_NOTE,
    shared.NOT_ON_PLAN_NOTE,
    shared.TYPED_MODEL_LABEL,
    shared.INVALID_PLAN_MODEL,
    ...shared.HERMES_PICKER_LINES,
    ...Object.values(shared.HERMES_TERMINAL_WORDS)
  ];
  assert.equal(sentences.length, 22);
  for (const sentence of sentences) {
    assert.ok(SPEC.includes(sentence), `the spec says this, word for word: ${sentence}`);
    assert.doesNotMatch(sentence, /\u2014/, "no em dash");
    assert.doesNotMatch(sentence, /[\u2018\u2019\u201c\u201d]/, "straight quotes, as in the spec");
  }
  assert.equal(shared.HERMES_PICKER_LINES.length, 2, "two quiet lines next to Choose in Hermes");
  assert.ok(SPEC.indexOf(shared.HERMES_PICKER_LINES[0]) < SPEC.indexOf(shared.HERMES_PICKER_LINES[1]), "in the spec's order");
  assert.deepEqual(shared.PLAN_LABEL, { claude: "Claude plan", chatgpt: "ChatGPT plan" });
  assert.equal(shared.TYPED_MODEL_LABEL, "Type a model name");
  assert.equal(shared.NOT_ON_PLAN_NOTE, "Not available on your plan in this OpenClaw yet");
  // The terminal's accessible name adds no words: it is the setup session's own title (contract copy, Task B1a).
  const setupSession = { kind: "setup", agentId: "openclaw", agentLabel: "OpenClaw", folderName: "someone", folderShown: false };
  assert.equal(shared.SIGNIN_TERMINAL_LABEL, sessions.sessionTitle(setupSession));
  assert.equal(shared.SIGNIN_TERMINAL_LABEL, "OpenClaw · ChatGPT sign-in");
});

test("the client keeps the server's sentences, its typed-name rule and its provider names", () => {
  assert.equal(shared.CLAUDE_PLAN_WORDS.not_installed, rules.PLAN_NOT_READY_MESSAGE.not_installed);
  assert.equal(shared.CLAUDE_PLAN_WORDS.api_billing, rules.PLAN_NOT_READY_MESSAGE.api_billing);
  assert.equal(shared.CLAUDE_PLAN_WORDS.unknown_method, rules.PLAN_NOT_READY_MESSAGE.unknown_method);
  assert.equal(shared.CHATGPT_PLAN_WORDS.expiring, rules.CHATGPT_EXPIRING);
  assert.equal(shared.CHATGPT_PLAN_WORDS.not_ready, rules.CHATGPT_NOT_READY);
  assert.equal(shared.INVALID_PLAN_MODEL, rules.INVALID_PLAN_MODEL);
  assert.equal(shared.TYPED_MODEL_RE.source, rules.TYPED_MODEL_RE.source);
  assert.equal(shared.TYPED_MODEL_RE.flags, rules.TYPED_MODEL_RE.flags);
  assert.deepEqual(shared.PLAN_PROVIDER, rules.PLAN_PROVIDER);
  assert.deepEqual([...shared.CLAUDE_API_METHODS], [...rules.CLAUDE_API_METHODS]);
  const version = read("server/runtime/setup/openclaw-version.js");
  const constant = (name) => new RegExp(`export const ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(version)?.[1];
  assert.equal(constant("OPENCLAW_SIGNIN_MIN_VERSION"), "2026.9.7");
  assert.equal(shared.CHATGPT_PLAN_WORDS.too_old, constant("OPENCLAW_TOO_OLD_MESSAGE"));
  assert.equal(shared.CHATGPT_PLAN_WORDS.version_unknown, constant("OPENCLAW_VERSION_UNKNOWN_MESSAGE"));
});

test("claudePlanState is the server's claudePlanReadiness, for every status and sign-in method", () => {
  const methods = [null, ...rules.CLAUDE_PLAN_METHODS, ...rules.CLAUDE_API_METHODS, "something_else"];
  for (const installed of [true, false]) {
    for (const status of ["signed_in", "not_signed_in", "unknown"]) {
      for (const method of methods) {
        const claude = { installed, status, method, note: "" };
        assert.equal(shared.claudePlanState(claude), rules.claudePlanReadiness(claude), JSON.stringify(claude));
      }
    }
  }
  const state = (over) => shared.claudePlanState({ installed: true, status: "signed_in", method: "claude.ai", note: "", ...over });
  assert.equal(state({}), "ready");
  assert.equal(state({ method: "oauth_token" }), "ready", "Claude Code's own sign-in, used by the unmodified program");
  for (const method of ["api_key", "api_key_helper", "third_party"]) assert.equal(state({ method }), "api_billing", method);
  assert.equal(state({ method: null }), "unknown_method", "an older Claude Code that can't say how it is signed in");
  assert.equal(state({ status: "unknown" }), "unknown_method");
  assert.equal(state({ status: "not_signed_in", method: null }), "not_signed_in");
  assert.equal(state({ installed: false, status: "unknown", method: null }), "not_installed");
});

test("chatgptPlanState: the version first, then the sign-in, then token sharing", () => {
  assert.equal(shared.chatgptPlanState(plansOf({ version: { have: null, newEnough: null } })), "version_unknown");
  assert.equal(shared.chatgptPlanState(plansOf({ version: { have: "2026.9.6", newEnough: false } })), "too_old");
  assert.equal(
    shared.chatgptPlanState(plansOf({ version: { have: "2026.9.6", newEnough: false }, chatgpt: { signedIn: true, sharing: true } })),
    "too_old",
    "too old wins even with a saved sign-in: the server refuses the sign-in route too"
  );
  assert.equal(shared.chatgptPlanState(plansOf()), "signed_out");
  assert.equal(shared.chatgptPlanState(plansOf({ chatgpt: { signedIn: null } })), "signed_out", "a sign-in that could not be read counts as signed out");
  assert.equal(shared.chatgptPlanState(plansOf({ chatgpt: { signedIn: true, sharing: false } })), "no_sharing");
  assert.equal(shared.chatgptPlanState(plansOf({ chatgpt: { signedIn: true, sharing: null } })), "ready", "no sharing field: the Apply's readiness check still catches it");
  assert.equal(shared.chatgptPlanState(plansOf({ chatgpt: { signedIn: true, sharing: true, readiness: "expiring" } })), "ready");
});

test("typedModelProblem: the server's rule, with the plan's own prefix allowed and nothing else", () => {
  const serverAccepts = (text, plan) => {
    const trimmed = text.trim();
    const prefix = `${rules.PLAN_PROVIDER[plan]}/`;
    return rules.TYPED_MODEL_RE.test(trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed);
  };
  const table = [
    "claude-opus-5-5", "anthropic/claude-opus-5-5", "  claude-opus-5-5  ", "openai/gpt-6-sol", "gpt-6.1-sol",
    "openai/gpt-6.1-sol", "anthropic/gpt-6-sol", "Claude-Opus", "", "   ", "-x", "x y", "../etc", "a".repeat(100),
    "a".repeat(101), "model:tag_1", "anthropic/", "anthropic//x"
  ];
  for (const plan of ["claude", "chatgpt"]) {
    for (const text of table) {
      const problem = shared.typedModelProblem(text, plan);
      assert.equal(problem === null, serverAccepts(text, plan), `${plan}: ${JSON.stringify(text)}`);
      if (problem !== null) assert.equal(problem, "That doesn't look like a model name.");
    }
  }
  assert.equal(shared.typedModelProblem("anthropic/claude-opus-5-5", "claude"), null);
  assert.equal(shared.typedModelProblem("openai/gpt-6-sol", "claude"), "That doesn't look like a model name.", "another plan's provider is refused");
  assert.equal(shared.typedModelProblem("Claude-Opus", "claude"), "That doesn't look like a model name.", "capital letters are refused");
  assert.equal(shared.typedModelProblem("a".repeat(101), "chatgpt"), "That doesn't look like a model name.", "at most 100 characters");
});

test("planApplyModel: Apply needs a listed model that is available, or a well-formed typed name on the fallback list", () => {
  const account = listOf("account", [model("claude-opus-5-5"), model("claude-sonnet-5-5", false)]);
  const fallback = listOf("fallback", [model("claude-opus-5-5")]);
  const none = { model: null, problem: null };
  assert.deepEqual(shared.planApplyModel(account, null, "", "claude"), none, "nothing picked yet");
  assert.deepEqual(shared.planApplyModel(null, { kind: "listed", id: "claude-opus-5-5" }, "", "claude"), none, "no list yet");
  assert.deepEqual(shared.planApplyModel(account, { kind: "listed", id: "claude-opus-5-5" }, "", "claude"), { model: "claude-opus-5-5", problem: null });
  assert.deepEqual(shared.planApplyModel(account, { kind: "listed", id: "claude-sonnet-5-5" }, "", "claude"), none, "not available on the plan: no Apply");
  assert.deepEqual(shared.planApplyModel(account, { kind: "listed", id: "gone" }, "", "claude"), none, "a model the newest list no longer has");
  assert.deepEqual(shared.planApplyModel(account, { kind: "typed" }, "claude-next-6", "claude"), none, "a typed name only while the list is the fallback");
  assert.deepEqual(shared.planApplyModel(fallback, { kind: "typed" }, "  anthropic/claude-next-6 ", "claude"), { model: "anthropic/claude-next-6", problem: null }, "sent trimmed; the server strips the prefix");
  assert.deepEqual(shared.planApplyModel(fallback, { kind: "typed" }, "Bad Name!", "claude"), { model: null, problem: "That doesn't look like a model name." });
  assert.deepEqual(shared.planApplyModel(fallback, { kind: "typed" }, "   ", "claude"), none, "an empty field is not a problem yet");
  assert.deepEqual(shared.planApplyModel(fallback, { kind: "listed", id: "claude-opus-5-5" }, "Bad Name!", "claude"), { model: "claude-opus-5-5", problem: null }, "a picked model ignores the field");
});

test("Choose in Hermes and failed requests: the right sentence for each answer, the server's own first", () => {
  const words = shared.HERMES_TERMINAL_WORDS;
  assert.equal(shared.hermesLaunchWords({ opened: true, command: "/x/hermes model" }), words.opened);
  assert.equal(shared.hermesLaunchWords({ opened: false, reason: "copy", command: "/x/hermes model" }), words.copy);
  assert.equal(shared.hermesLaunchWords({ opened: false, reason: "spawn_failed", command: "/x/hermes model" }), words.spawn_failed);
  assert.equal(shared.hermesLaunchWords({ opened: false, command: "/x/hermes model" }), words.copy, "no reason: the copy words");

  const friendly = (error) => `friendly:${error.message}`;
  const invalid = apiError("invalid_model_id", "That doesn't look like a model name.", 400);
  assert.equal(shared.serverSentence(invalid), "That doesn't look like a model name.");
  assert.equal(shared.planProblem(invalid, friendly), "That doesn't look like a model name.", "never friendlyError's OpenRouter sentence for this code");
  assert.equal(shared.serverSentence(apiError("job_already_running", "", 409)), null);
  assert.equal(shared.planProblem(apiError("job_already_running", "", 409), friendly), "friendly:job_already_running");
  assert.equal(shared.serverSentence(new Error("plain")), null);
  assert.equal(shared.planProblem(new Error(group.TIMEOUT_WORDS), friendly), group.TIMEOUT_WORDS);
  assert.equal(shared.planProblem(new TypeError("Failed to fetch"), friendly), group.noAnswerWords(new TypeError("Failed to fetch")));
  assert.equal(shared.planProblem(new SyntaxError("Unexpected token <"), friendly), shared.UNREADABLE_WORDS);
  assert.equal(shared.planProblem(new Error(shared.UNREADABLE_WORDS), friendly), shared.UNREADABLE_WORDS);

  // The same sentences the rest of the app says.
  assert.equal(shared.TIMEOUT_WORDS, group.TIMEOUT_WORDS);
  assert.equal(shared.NO_ANSWER_WORDS, group.noAnswerWords(new TypeError("x")));
  assert.ok(read("src/ui/components/AgentBrainCard.tsx").includes(`"${shared.UNREADABLE_WORDS}"`));
  const panel = read("src/ui/components/SetupBrainPanel.tsx");
  assert.ok(panel.includes(shared.MAY_HAVE_APPLIED), "the Apply no-answer words are Setup's");
  assert.ok(panel.includes(shared.CANCEL_UNSURE), "the cancel no-answer words are Setup's");
});

test("time limits and polling: every request has one, and they match the brain screens'", () => {
  assert.equal(shared.PLAN_LIMITS_MS.plans, home.BRAIN_READ_LIMIT_MS);
  assert.equal(shared.PLAN_LIMITS_MS.models, home.MODEL_READ_LIMIT_MS);
  // Before the job exists the server reads the sign-in and the model list again inside the job lock (up to about
  // 48 s on a slow OpenClaw), so Apply waits as long as the brain read; a shorter limit would lose the job's id.
  assert.equal(shared.PLAN_LIMITS_MS.apply, home.BRAIN_READ_LIMIT_MS);
  assert.equal(shared.PLAN_LIMITS_MS.action, 20_000);
  assert.equal(shared.PLAN_LIMITS_MS.signInLookup, 10_000);
  assert.equal(shared.SIGNIN_POLL_MS, 5000, "the sign-in terminal asks every 5 s whether its session ended (spec section 1)");
  assert.equal(shared.SETUP_RUNNING_WAIT_MS, 15_000);
  assert.equal(shared.SETUP_RUNNING_POLL_MS, 1000);
  assert.equal(shared.PLANS_FOCUS_GAP_MS, 20_000);
  assert.equal(shared.HERMES_FOCUS_GAP_MS, 2000);
});

test("labels: the plan modes are named (never Local), and the plan job's steps have words", () => {
  assert.deepEqual(brain.BRAIN_MODE_LABEL, { openrouter: "OpenRouter", ollama: "Local", "claude-plan": "Claude plan", "chatgpt-plan": "ChatGPT plan" });
  const labels = {
    "openclaw-plan-onboard": "Connect OpenClaw to Claude Code",
    "openclaw-plan-runtime-check": "Check OpenClaw uses your Claude plan",
    "openclaw-plan-model": "Set OpenClaw's model",
    "openclaw-plan-readiness": "Check your ChatGPT sign-in"
  };
  const jobs = read("server/runtime/setup/jobs.js");
  for (const [id, words] of Object.entries(labels)) {
    assert.equal(brain.CONFIGURE_STEP_LABEL[id], words, id);
    assert.ok(jobs.includes(`"${id}"`), `the server's plan job has the step ${id}`);
  }
  assert.equal(brain.CONFIGURE_STEP_LABEL["openclaw-safe-defaults"], "OpenClaw safe defaults", "the older labels stay");
  assert.equal(brain.CONFIGURE_STEP_LABEL.health, "Say hello to each agent");
});

test("the new client calls: their routes, methods and bodies (confirm: true), and the plan job's own storage key", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await setupApi.getOpenclawPlans();
    await setupApi.getOpenclawPlanModels("chatgpt");
    await setupApi.applyOpenclawPlan({ plan: "claude", model: "claude-opus-5-5", acceptOpenClawRisk: true });
    await setupApi.startOpenclawSignInTerminal();
    await setupApi.getOpenclawSignInTerminal();
    await setupApi.openHermesModelTerminal();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [
    { url: "/api/setup/openclaw/plans", method: "GET", body: null },
    { url: "/api/setup/openclaw/plan-models?plan=chatgpt", method: "GET", body: null },
    { url: "/api/setup/openclaw/plan", method: "POST", body: { plan: "claude", model: "claude-opus-5-5", acceptOpenClawRisk: true, confirm: true } },
    { url: "/api/setup/openclaw/signin-terminal", method: "POST", body: { confirm: true } },
    { url: "/api/setup/openclaw/signin-terminal", method: "GET", body: null },
    { url: "/api/setup/hermes/model-terminal", method: "POST", body: { confirm: true } }
  ]);

  const store = new Map();
  const before = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) }
  });
  try {
    setupApi.rememberJobId("plan", "job_plan_1");
    assert.equal(store.get("agentos.setup.planJob"), "job_plan_1");
    assert.equal(setupApi.recallJobId("plan"), "job_plan_1");
    assert.equal(setupApi.recallJobId("configure"), null, "a plan job never takes the configure job's place (Setup never lands on it)");
    setupApi.rememberJobId("plan", null);
    assert.equal(store.has("agentos.setup.planJob"), false);
  } finally {
    if (before) Object.defineProperty(globalThis, "sessionStorage", before);
    else delete globalThis.sessionStorage;
  }
});

test("wiring: every request of the new cards has a time limit, Hermes never gets a session, the cards keep and log nothing, and the labels and hides are in place", () => {
  const names = "getOpenclawPlans|getOpenclawPlanModels|applyOpenclawPlan|startOpenclawSignInTerminal|getOpenclawSignInTerminal|openHermesModelTerminal|getSetupJob|cancelSetupJob";
  for (const file of ["src/ui/components/BrainPlanCard.tsx", "src/ui/components/ChooseInHermes.tsx"]) {
    const text = read(file);
    const all = text.match(new RegExp(`\\b(${names})\\(`, "g"))?.length ?? 0;
    const timed = text.match(new RegExp(`withTimeout\\(\\s*(${names})\\(`, "g"))?.length ?? 0;
    assert.ok(all > 0 && all === timed, `${file}: ${timed} of ${all} requests have a time limit`);
  }
  const card = read("src/ui/components/BrainPlanCard.tsx");
  const term = read("src/ui/components/PlanSignInTerminal.tsx");
  const hermes = read("src/ui/components/ChooseInHermes.tsx");
  // Hermes's picker runs in Terminal.app only: no session and no terminal here (spec section 4, Safety 2).
  assert.doesNotMatch(hermes, /sessionsApi|SessionTerminal|createSession|signin-terminal/);
  // Nothing typed or shown in the sign-in is kept or logged by the page (Safety 1 and 5): no console, no storage
  // writes; the terminal reads only its two display settings, and the card keeps its job id through rememberJobId.
  for (const text of [card, term, hermes]) {
    assert.doesNotMatch(text, /console\./);
    assert.doesNotMatch(text, /setItem\(|indexedDB|document\.cookie/);
  }
  assert.deepEqual(term.match(/localStorage\.[a-zA-Z]+\(/g), ["localStorage.getItem("]);
  assert.doesNotMatch(card, /localStorage|sessionStorage/);
  // Apply has the long limit (amendment A); the terminal keeps Tab while connected, so Close comes before it.
  assert.match(card, /withTimeout\(applyOpenclawPlan\(\{[^}]*\}\), PLAN_LIMITS_MS\.apply\)/);
  const closeAt = term.indexOf("void close()");
  assert.ok(closeAt > 0 && closeAt < term.indexOf("<SessionTerminal"), "the Close button comes before the terminal");
  // BrainResult: exported, and its label line names the mode from one table, never "Local" for a plan.
  const panel = read("src/ui/components/SetupBrainPanel.tsx");
  assert.match(panel, /export function BrainResult\(/);
  assert.match(panel, /BRAIN_MODE_LABEL\[target\.mode\]/);
  assert.doesNotMatch(panel, /target\.mode === "openrouter" \? "OpenRouter" : "Local"/);
  assert.match(panel, /showPlanCard = true/);
  // The Agents page: the plan names on the receipt line, Change model on a plan, no second plan card in Change brain.
  const agents = read("src/ui/components/AgentBrainCard.tsx");
  assert.match(agents, /"claude-plan": "Claude plan"/);
  assert.match(agents, /"chatgpt-plan": "ChatGPT plan"/);
  assert.match(agents, /showPlanCard=\{false\}/);
  assert.match(agents, /onChangeModel=/);
  assert.match(read("src/ui/components/BrainModelActions.tsx"), /onChangeModel \? onChangeModel\(\) : setMode\("picker"\)/);
});

test("wiring: the two Task B1a carry-forwards (a Close that got 404 stops what it finds; a refused first attach asks the session at once)", () => {
  const card = read("src/ui/components/BrainPlanCard.tsx");
  const term = read("src/ui/components/PlanSignInTerminal.tsx");
  // (a) The terminal tells the card when Close's stop answered 404, and the card then stops the sign-in it finds
  // running instead of only showing it. Without a 404 it still never stops (or shows again) the session just closed.
  assert.match(term, /gone = true;/);
  assert.match(term, /latest\.current\.onClose\(gone\)/);
  assert.match(card, /onClose=\{\(gone\) => closedSignIn\(signin\.id, gone === true\)\}/);
  assert.match(card, /if \(gone\) \{\s*try \{\s*await stopSession\(session\.id\);/);
  assert.match(card, /else if \(session\.id === closedId\) \{\s*return;/);
  // (b) A terminal that has never been open and fails its first try asks the session at once, so a sign-in that
  // already ended closes the panel (a 404 is an end) before the 5 s tick, with no new sentence.
  assert.match(term, /else if \(\(connection === "reconnecting" \|\| connection === "lost"\) && !opened\.current\) void latestAsk\.current\(\);/);
  assert.match(term, /else if \(connection === "open"\) opened\.current = true;/);
});

test("Brain card after Choose in Hermes (fix round 1): the mark follows the live model, and 'Last set by Agent OS' only sits beside the model Agent OS set", () => {
  // (2a) The status mark and its label come from the agent's own model answer whenever it names a model, even while
  // the health check's answer (configured) is still the old one. An answer with no model, or none at all, keeps the
  // older words.
  const ok = { kind: "ok", label: "has a model" };
  assert.deepEqual(brain.brainMark(false, { model: "vendor/chosen" }), ok, "needs a model + a live model: has a model");
  assert.deepEqual(brain.brainMark(true, { model: "vendor/chosen" }), ok);
  assert.deepEqual(brain.brainMark(true, { model: null }), ok, "configured and the lookup named nothing: the status stands");
  assert.deepEqual(brain.brainMark(true, null), ok);
  assert.deepEqual(brain.brainMark(false, { model: null }), { kind: "warn", label: "needs a model" }, "the lookup answered with no model");
  assert.deepEqual(brain.brainMark(false, null), { kind: "warn", label: "model not known" }, "a failed lookup is not 'no model'");
  assert.deepEqual(brain.brainMark(false, undefined), { kind: "warn", label: "model not known" }, "not answered yet is not 'no model'");

  // (2b) The receipt line fits the live model only when it is the model Agent OS set: as is (OpenRouter, the plans),
  // or, for a local model, the 64K copy Agent OS made of it. A model the agent does not name contradicts nothing.
  const openrouter = { provider: "openrouter", model: "vendor/old" };
  assert.equal(brain.receiptFitsModel(openrouter, "vendor/old"), true);
  assert.equal(brain.receiptFitsModel(openrouter, "vendor/picked-in-hermes"), false, "a model chosen in Hermes is not the one Agent OS set");
  assert.equal(brain.receiptFitsModel(openrouter, null), true);
  assert.equal(brain.receiptFitsModel(openrouter, undefined), true);
  assert.equal(brain.receiptFitsModel(openrouter, ""), true);
  const local = { provider: "ollama", model: "qwen3:14b" };
  assert.equal(brain.receiptFitsModel(local, brain.variantNameFor("qwen3:14b")), true, "the agent holds Agent OS's 64K copy of the local model");
  assert.equal(brain.receiptFitsModel(local, brain.variantNameFor("llama3:8b")), false, "...but not another model's copy");
  assert.equal(brain.receiptFitsModel(local, "qwen3:14b"), true);
  assert.equal(brain.receiptFitsModel({ provider: "openrouter", model: "qwen3:14b" }, brain.variantNameFor("qwen3:14b")), false, "only a local receipt has a copy");
  assert.equal(brain.receiptFitsModel({ provider: "claude-plan", model: "claude-opus-5-5" }, "claude-opus-5-5"), true);
  assert.equal(brain.receiptFitsModel({ provider: "claude-plan", model: "claude-opus-5-5" }, "claude-sonnet-5-5"), false);

  // Wiring: the card uses both rules, and only Refresh runs the full reload (window focus stays model-only).
  const agents = read("src/ui/components/AgentBrainCard.tsx");
  assert.match(agents, /brainMark\(Boolean\(current\?\.configured\), live\)/);
  assert.match(agents, /<StatusMark kind=\{mark\.kind\} label=\{mark\.label\} \/>/);
  assert.match(agents, /receiptFitsModel\(receipt, live\?\.model\)/);
  assert.match(agents, /<ChooseInHermes onRefresh=\{onModelChanged\} onWindowFocus=\{\(\) => void reloadModels\(\)\} \/>/);
  const hermes = read("src/ui/components/ChooseInHermes.tsx");
  assert.match(hermes, /latestFocus\.current\(\);/);
  assert.match(hermes, /function refresh\(\) \{\s*lastRead\.current = Date\.now\(\);\s*latest\.current\(\);/, "the Refresh button runs onRefresh");
});

test("Brain card while the receipt is read again (fix round 2): 'set up outside Agent OS' is not said until that read settles", () => {
  const agents = read("src/ui/components/AgentBrainCard.tsx");
  // load() says it is reading before its first await, and clears it only when the newest read settles: a read that was
  // overtaken by a newer one, or that ends after the card is gone, clears nothing (the newer read is still running).
  assert.match(agents, /const \[receiptReading, setReceiptReading\] = useState\(false\);/);
  assert.match(agents, /const mine = \(newest\.current \+= 1\);\s*setReceiptReading\(true\);/);
  assert.match(agents, /\} finally \{\s*(?:\/\/[^\n]*\s*)*if \(alive\.current && mine === newest\.current\) setReceiptReading\(false\);\s*\}/);
  // In the sub-line, the "reading" answer sits right after "Last set by Agent OS" and before every sentence that
  // concludes the model was set outside Agent OS (or that the record could not be read). It shows the health check's
  // own summary, and only when that check agrees there is a model: a stale "needs a model" never sits beside one.
  const at = (needle) => agents.indexOf(needle);
  assert.ok(at("setByAgentOs ? (") > 0, "the Last set by Agent OS branch");
  assert.ok(at("receiptReading ? (") > at("setByAgentOs ? ("), "reading comes after the receipt that fits");
  assert.ok(at("receiptReading ? (") < at("receiptUnknown ? ("), "...and before the record-unreadable sentences");
  assert.ok(at("receiptReading ? (") < at("it was set up outside Agent OS"), "...and before every 'set up outside Agent OS'");
  assert.match(agents, /receiptReading \? \(\s*(?:\/\/[^\n]*\s*)*current\.configured \? current\.summary : null\s*\) : receiptUnknown \? \(/);
});
