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

test("every sentence the spec gives the cards is shown word for word, in straight quotes and with no em dash (the Hermes sign-in helper's own sentences are pinned apart, further down)", () => {
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
    await setupApi.openHermesAuthTerminal();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [
    { url: "/api/setup/openclaw/plans", method: "GET", body: null },
    { url: "/api/setup/openclaw/plan-models?plan=chatgpt", method: "GET", body: null },
    { url: "/api/setup/openclaw/plan", method: "POST", body: { plan: "claude", model: "claude-opus-5-5", acceptOpenClawRisk: true, confirm: true } },
    { url: "/api/setup/openclaw/signin-terminal", method: "POST", body: { confirm: true } },
    { url: "/api/setup/openclaw/signin-terminal", method: "GET", body: null },
    { url: "/api/setup/hermes/model-terminal", method: "POST", body: { confirm: true } },
    { url: "/api/setup/hermes/auth-terminal", method: "POST", body: { confirm: true } }
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
  const names = "getOpenclawPlans|getOpenclawPlanModels|applyOpenclawPlan|startOpenclawSignInTerminal|getOpenclawSignInTerminal|openHermesModelTerminal|openHermesAuthTerminal|getSetupJob|cancelSetupJob";
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
  // (a) The terminal tells the card when Close's stop answered 404. The card closes the panel and reads the plans, then
  // asks the pure rule (signInAfterClose, tested above) what to do with the live sign-in the GET finds: stop it (only
  // the session just closed, after a 404), show it (another window's, or one whose stop failed), or leave it.
  assert.match(term, /gone = true;/);
  assert.match(term, /latest\.current\.onClose\(gone\)/);
  assert.match(card, /onClose=\{\(gone\) => closedSignIn\(signin\.id, gone === true\)\}/);
  assert.match(card, /signinOver\(\);\s*withTimeout\(getOpenclawSignInTerminal\(\), PLAN_LIMITS_MS\.signInLookup\)/, "the panel closes and the plans are read before the look");
  assert.match(card, /const next = signInAfterClose\(closedId, gone, answer\?\.session\);\s*const stopId = next\.stop;/);
  assert.match(card, /if \(stopId\) \{\s*try \{\s*await stopSession\(stopId\);\s*return;/);
  assert.match(card, /const showId = stopId \?\? next\.show;\s*if \(showId && alive\.current\) setSignin\(\(current\) => current \?\? \{ id: showId, fresh: false \}\);/);
  assert.doesNotMatch(card, /if \(gone\) \{\s*try/, "the old rule (stop whatever is found after a 404) is gone");
  // (b) A terminal that has never been open and fails its first try asks the session at once (asksSessionAtOnce), so a
  // sign-in that already ended closes the panel (a 404 is an end: signInSessionEnded) before the 5 s tick, with no new sentence.
  assert.match(term, /else if \(asksSessionAtOnce\(connection, opened\.current\)\) void latestAsk\.current\(\);/);
  assert.match(term, /opened\.current = true;/);
  assert.match(term, /if \(alive\.current && signInSessionEnded\(summary, false\)\) setEnded\(true\);/);
  assert.match(term, /if \(alive\.current && signInSessionEnded\(null, isGone\(error\)\)\) setEnded\(true\);/);
});

test("wiring: the sweep's small fixes are in place in the cards (C2 comment, C3, C4, C5, C6, C7, C8)", () => {
  const card = read("src/ui/components/BrainPlanCard.tsx");
  const term = read("src/ui/components/PlanSignInTerminal.tsx");
  const agents = read("src/ui/components/AgentBrainCard.tsx");
  const hook = read("src/ui/components/useAgentModels.ts");
  // C2: Close's comment no longer says a 404 means the session ended AND that it can be a sign-in still before its spawn.
  assert.doesNotMatch(term, /so a 404 here means it ended/);
  assert.match(term, /usually means the session already ended/);
  assert.match(term, /still before its spawn/);
  assert.match(term, /another window's/);
  // C3: a Sign in that timed out looks for the running sign-in just as one that got 409 does.
  assert.match(card, /const wait = signInLookupWait\(error\);\s*if \(wait !== null\) \{\s*const found = await findSignInSession\(wait\);/);
  assert.doesNotMatch(card, /running \? SETUP_RUNNING_WAIT_MS : 0/);
  // C4: Change model opens the plan's list only while the plan card is on screen; otherwise the OpenRouter picker.
  assert.match(agents, /const planCardShown = agentId === "openclaw" && localMode && installedSeen && !planCardOff;/);
  assert.match(agents, /onChangeModel=\{livePlan && planCardShown \? \(\) => planCard\.current\?\.showModels\(livePlan\) : undefined\}/);
  assert.match(agents, /<BrainPlanCard ref=\{planCard\} where="agents" currentPlan=\{livePlan\} onChanged=\{onModelChanged\} onAvailable=\{\(available\) => setPlanCardOff\(!available\)\} \/>/);
  assert.match(card, /const hidden = plans\.state === "off";\s*useEffect\(\(\) => \{\s*latestOnAvailable\.current\?\.\(!hidden\);\s*\}, \[hidden\]\);/);
  // C5: the poll's answer and Cancel's answer both go through takeJob, which asks takeJobAnswer.
  assert.match(card, /const kind = takeJobAnswer\(settledJob\.current, next\);/);
  assert.equal(card.match(/takeJob\(next\);/g)?.length, 2, "the poll and Cancel");
  assert.equal(card.match(/setJob\(next\)/g)?.length, 1, "no answer about the job is taken without the rule: the one setJob(next) is inside takeJob");
  // C6: the terminal says once that it took the keys; the card then clears `fresh`, so a remount never takes them again.
  assert.match(term, /if \(latest\.current\.autoFocus && !focused\.current\) \{\s*focused\.current = true;\s*latest\.current\.onFocused\?\.\(\);/);
  assert.match(card, /onFocused=\{\(\) =>\s*setSignin\(\(current\) => \(current && current\.id === signin\.id && current\.fresh \? \{ \.\.\.current, fresh: false \} : current\)\)/);
  // C7: window focus on Hermes's card reads Hermes's model only; the hook reads one agent when asked, and never throws away another agent's read.
  assert.match(agents, /<ChooseInHermes onRefresh=\{onModelChanged\} onWindowFocus=\{\(\) => void reloadModels\("hermes"\)\} \/>/);
  assert.match(hook, /reload = useCallback\(\s*async \(only\?: BrainAgentId\)/);
  assert.match(hook, /mergeModelReads\(previous, answers, asked, only === undefined\)/);
  // C8: the terminal's notice line clears when the terminal is connected again.
  assert.match(term, /else if \(connection === "open"\) \{\s*opened\.current = true;\s*(?:\/\/[^\n]*\s*)*setNotice\(""\);/);
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
  assert.match(agents, /<ChooseInHermes onRefresh=\{onModelChanged\} onWindowFocus=\{\(\) => void reloadModels\("hermes"\)\} \/>/);
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

// ---- Minor sweep, Group C: the brain screens' small fixes --------------------------------------------------------

const live = (id) => ({ id, status: "live" });
const exited = (id) => ({ id, status: "exited" });

test("signInAfterClose: after a Close, the sign-in the GET finds is stopped only when it is the one just closed (sweep C1, C9)", () => {
  const after = shared.signInAfterClose;
  const nothing = { stop: null, show: null };
  // Close stopped it cleanly: the session just closed is never shown again (its stop may still be finishing); a
  // different one (another window's) is never stopped, it is shown.
  assert.deepEqual(after("a", false, live("a")), nothing);
  assert.deepEqual(after("a", false, live("b")), { stop: null, show: "b" });
  // Close got 404: a sign-in still before its spawn answers that too, so the same id is stopped (it is live now).
  assert.deepEqual(after("a", true, live("a")), { stop: "a", show: null });
  // ...but a different id after a 404 is another window's sign-in: left running, and shown, never stopped.
  assert.deepEqual(after("a", true, live("b")), { stop: null, show: "b" });
  // Nothing live, an ended session, or an answer that is not a session: nothing to stop or show.
  for (const gone of [false, true]) {
    for (const found of [null, undefined, exited("a"), exited("b"), {}, { id: "", status: "live" }]) {
      assert.deepEqual(after("a", gone, found), nothing, `${gone} ${JSON.stringify(found)}`);
    }
  }
});

test("asksSessionAtOnce and signInSessionEnded: a terminal that never opened and fails its first try asks at once; 404 or exited is an end (Task B1a carry-forward)", () => {
  for (const connection of ["reconnecting", "lost"]) {
    assert.equal(shared.asksSessionAtOnce(connection, false), true, `${connection}, never open`);
    assert.equal(shared.asksSessionAtOnce(connection, true), false, `${connection}, was open: the 5 s tick asks`);
  }
  for (const connection of ["connecting", "open", "ended"]) {
    for (const opened of [false, true]) assert.equal(shared.asksSessionAtOnce(connection, opened), false, `${connection} ${opened}`);
  }
  assert.equal(shared.signInSessionEnded({ status: "exited" }, false), true);
  assert.equal(shared.signInSessionEnded({ status: "live" }, false), false);
  assert.equal(shared.signInSessionEnded(null, false), false, "an answer that is not a session is not an end");
  assert.equal(shared.signInSessionEnded(undefined, true), true, "a 404 is how a setup session answers once it ended");
  assert.equal(shared.signInSessionEnded({ status: "live" }, true), true);
});

test("signInLookupWait: a Sign in that got 409 setup_running, or no answer at all, looks for the running sign-in for up to 15 s (sweep C3)", () => {
  assert.equal(shared.signInLookupWait(apiError("setup_running", "", 409)), shared.SETUP_RUNNING_WAIT_MS);
  assert.equal(shared.signInLookupWait(new Error(shared.TIMEOUT_WORDS)), shared.SETUP_RUNNING_WAIT_MS, "a start that timed out may still have started it");
  assert.equal(shared.signInLookupWait(new TypeError("Failed to fetch")), shared.SETUP_RUNNING_WAIT_MS, "a start whose answer never came");
  assert.equal(shared.SETUP_RUNNING_WAIT_MS, 15_000);
  // A refusal with its own sentence says it at once: there is no sign-in to find.
  for (const code of ["openclaw_too_old", "openclaw_version_unknown", "pty_unavailable", "invalid_request"]) {
    assert.equal(shared.signInLookupWait(apiError(code, "words", 409)), null, code);
  }
});

test("takeJobAnswer: once a job reached a final state on this card, no later answer for it counts, so the job's end is handled once (sweep C5)", () => {
  const take = shared.takeJobAnswer;
  assert.equal(take(null, { id: "j1", status: "running" }), "running");
  for (const status of ["succeeded", "failed", "cancelled"]) assert.equal(take(null, { id: "j1", status }), "final", status);
  // Cancel answered "cancelled" first; the poll's answer that was already on its way is dropped (and the reverse).
  for (const status of ["running", "succeeded", "failed", "cancelled"]) assert.equal(take("j1", { id: "j1", status }), "ignore", `after final: ${status}`);
  // Another job's end does not block a new job.
  assert.equal(take("j1", { id: "j2", status: "running" }), "running");
  assert.equal(take("j1", { id: "j2", status: "succeeded" }), "final");
});

test("mergeModelReads: a read of one agent leaves the other agent's answer alone; a whole read drops agents no longer asked about (sweep C7)", () => {
  const merge = brain.mergeModelReads;
  const a = { model: "a" };
  const b = { model: "b" };
  const c = { model: "c" };
  const d = { model: "d" };
  const before = { hermes: a, openclaw: b };
  assert.deepEqual(merge(before, [["hermes", c]], ["hermes"], false), { hermes: c, openclaw: b }, "Hermes only");
  assert.deepEqual(merge(before, [["openclaw", d]], ["openclaw"], false), { hermes: a, openclaw: d }, "OpenClaw only");
  assert.deepEqual(merge(before, [["hermes", c], ["openclaw", d]], ["hermes", "openclaw"], true), { hermes: c, openclaw: d }, "both");
  assert.deepEqual(merge(before, [["hermes", c]], ["hermes"], true), { hermes: c }, "OpenClaw is not installed any more: dropped");
  assert.deepEqual(merge(before, [["hermes", c]], ["hermes", "openclaw"], true), { hermes: c, openclaw: b }, "a newer read of OpenClaw is on its way: its older answer stays");
  assert.deepEqual(merge(before, [["hermes", null]], ["hermes"], false), { hermes: null, openclaw: b }, "a failed read is null, not 'no model'");
  assert.deepEqual(before, { hermes: a, openclaw: b }, "the old map is not changed");
});

test("the fallback row's radio and its text field have different accessible names, and Apply's name keeps its visible state (sweep C10, C11)", () => {
  assert.equal(shared.TYPED_MODEL_LABEL, "Type a model name", "the field keeps the spec's words");
  assert.notEqual(shared.TYPED_MODEL_CHOICE_LABEL, shared.TYPED_MODEL_LABEL);
  assert.doesNotMatch(shared.TYPED_MODEL_CHOICE_LABEL, /—/, "no em dash");
  assert.doesNotMatch(shared.TYPED_MODEL_CHOICE_LABEL, /[‘’“”]/, "straight quotes");
  const card = read("src/ui/components/BrainPlanCard.tsx");
  assert.equal(card.match(/aria-label=\{TYPED_MODEL_LABEL\}/g)?.length, 1, "one control is named Type a model name (the text field)");
  assert.equal(card.match(/aria-label=\{TYPED_MODEL_CHOICE_LABEL\}/g)?.length, 1, "the radio has its own name");
  assert.match(card, /type="radio"[^>]*\n[^<]*value=""\n\s*aria-label=\{TYPED_MODEL_CHOICE_LABEL\}/, "...and it is the radio's");
  // Apply: no aria-label that replaces what is on the button; the plan's name is added after the visible word, so the
  // name is "Apply · Claude plan" or "Starting… · Claude plan".
  assert.doesNotMatch(card, /aria-label=\{`Apply/);
  assert.match(card, /\{busy === plan \? "Starting…" : "Apply"\}\s*<span className="os-visually-hidden"> · \{PLAN_LABEL\[plan\]\}<\/span>/);
});

// ---- "Sign in again" on a plan job that stopped at its ChatGPT sign-in check ----------------------------------------

// A plan job as the card gets it: one step per id, the ones before `failed` done, `failed` failed (with `error` as its
// sentence), the rest waiting.
const READINESS_STEP = "openclaw-plan-readiness";
const CHATGPT_STEPS = ["openclaw-plan-model", "openclaw-safe-defaults", READINESS_STEP, "health"];
function planJob({ plan = "chatgpt", status = "failed", ids = CHATGPT_STEPS, failed = READINESS_STEP, error = rules.CHATGPT_NOT_READY } = {}) {
  const failedAt = ids.indexOf(failed);
  return {
    id: "job_x",
    kind: "configure",
    status,
    plan,
    steps: ids.map((id, index) => ({
      id,
      status: failedAt === -1 ? "succeeded" : index < failedAt ? "succeeded" : index === failedAt ? "failed" : "pending",
      error: index === failedAt ? error : null
    }))
  };
}

test("offersSignInAgain: only a failed ChatGPT plan job whose failed step is the sign-in check offers 'Sign in again' (full truth table)", () => {
  const offers = shared.offersSignInAgain;
  // The one case that offers it.
  assert.equal(offers(planJob()), true);
  // Another plan, whatever step failed: the Claude plan has no ChatGPT sign-in, and a job with no plan is not a plan job.
  for (const plan of ["claude", "other", "", undefined, null]) assert.equal(offers({ ...planJob(), plan }), false, `plan ${String(plan)}`);
  // Another failed step: the model, the safe defaults, the hello check, and steps of other jobs.
  for (const failed of ["openclaw-plan-model", "openclaw-safe-defaults", "health", "openclaw-plan-runtime-check", "services"]) {
    assert.equal(offers(planJob({ ids: [...CHATGPT_STEPS, "services", "openclaw-plan-runtime-check"], failed })), false, `failed at ${failed}`);
  }
  // Not failed: still running, finished well, or cancelled (even with the check's step marked failed).
  for (const status of ["running", "succeeded", "cancelled", "", undefined]) assert.equal(offers({ ...planJob(), status }), false, `status ${String(status)}`);
  // The right step with another sentence: Agent OS quitting during the sign-in check fails that same step, and its
  // sentence tells the person to apply the plan again, so "Sign in again" would sit beside words that say otherwise.
  assert.equal(offers(planJob({ error: rules.PLAN_JOB_INTERRUPTED })), false, "Agent OS quit during the check");
  for (const error of [null, "", "A setup step failed.", `${rules.CHATGPT_NOT_READY} `]) {
    assert.equal(offers(planJob({ error })), false, `error ${JSON.stringify(error)}`);
  }
  const noError = planJob();
  delete noError.steps[2].error;
  assert.equal(offers(noError), false, "a failed step with no error field");
  assert.equal(offers(planJob({ error: shared.CHATGPT_PLAN_WORDS.not_ready })), true, "the client's mirror of the server's sentence");
  // A failed job with no failed step names no step to sign in again for.
  assert.equal(offers(planJob({ failed: "nothing" })), false);
  // The failed step is the first one (the one BrainResult shows the error of): the check failing after another step did is not it.
  const twoFailed = planJob({ failed: "openclaw-plan-model" });
  twoFailed.steps[2].status = "failed";
  assert.equal(offers(twoFailed), false);
  // No job, or something that is not one.
  for (const nothing of [null, undefined, {}, { plan: "chatgpt", status: "failed" }, { plan: "chatgpt", status: "failed", steps: null }, { plan: "chatgpt", status: "failed", steps: "x" }, { plan: "chatgpt", status: "failed", steps: [] }]) {
    assert.equal(offers(nothing), false, JSON.stringify(nothing));
  }
  // The step name is the server's own (the ChatGPT plan job's steps) and has a label.
  assert.match(read("server/runtime/setup/jobs.js"), /chatgpt: Object\.freeze\(\[[^\]]*"openclaw-plan-readiness"/);
  assert.equal(brain.CONFIGURE_STEP_LABEL[READINESS_STEP], "Check your ChatGPT sign-in");
});

test("wiring: 'Sign in again' is drawn only through offersSignInAgain and starts the card's one sign-in (startSignIn), then leaves the result like Back", () => {
  const card = read("src/ui/components/BrainPlanCard.tsx");
  const panel = read("src/ui/components/SetupBrainPanel.tsx");
  // The rule is imported from the shared file, used once, and is the only thing that decides whether the button shows.
  assert.match(card, /offersSignInAgain,\s*\n\s*planApplyModel,/);
  assert.equal(card.match(/offersSignInAgain\(/g)?.length, 1, "one use");
  assert.match(card, /extraAction=\{\s*info && offersSignInAgain\(job\) \? \(/);
  // The button: exactly that label, secondary, disabled like the other sign-in button (locked), "Starting…" while starting.
  assert.equal(card.match(/: "Sign in again"\}/g)?.length, 1, "one label, drawn once");
  assert.match(
    card,
    /<button type="button" className="os-btn os-btn--secondary" onClick=\{\(\) => void signInAgain\(\)\} disabled=\{locked\}>\s*\{busy === "signin" \? "Starting…" : "Sign in again"\}\s*<\/button>/
  );
  // No second sign-in path: the card still starts a sign-in in exactly one place, and the button reaches it only through
  // signInAgain, which leaves the result the way Back does and only if that result is still the one shown.
  assert.equal(card.match(/startOpenclawSignInTerminal\(\)/g)?.length, 1, "one start call");
  assert.equal(card.match(/await startSignIn\(\)/g)?.length, 1);
  assert.equal(card.match(/void startSignIn\(\)/g)?.length, 1, "Sign in with ChatGPT");
  assert.match(
    card,
    /async function signInAgain\(\) \{\s*if \(busy !== null \|\| !job\) return;\s*const resultId = job\.id;\s*await startSignIn\(\);\s*if \(!alive\.current \|\| shownJob\.current\?\.id !== resultId\) return;\s*keepKeysInCard\(\);\s*leaveResult\(\);\s*\}/
  );
  // Back to the plans is the state clearing plus the title's focus; "Sign in again" waits for a start that can take
  // many seconds, so it clears the same state but moves the keys only when they are still in the card or nowhere (P26).
  assert.match(card, /function leaveResult\(\) \{\s*rememberJobId\("plan", null\);\s*setJob\(null\);\s*setJobError\(""\);\s*setErrors\(\{\}\);\s*setRiskAccepted\(false\);\s*\}/);
  assert.match(card, /function backToPlans\(\) \{\s*leaveResult\(\);\s*\/\/ The result's buttons are gone: keep the keyboard on the card\.\s*cardTitle\.current\?\.focus\(\);\s*\}/);
  assert.equal(card.match(/leaveResult\(\);/g)?.length, 2, "backToPlans and signInAgain only");
  assert.equal(card.match(/cardTitle\.current\?\.focus\(\)/g)?.length, 2, "keepKeysInCard and backToPlans only: signInAgain never focuses by itself");
  assert.match(card, /shownJob\.current = job;/);
  // BrainResult only draws what it is given, first in its actions row, and nobody else passes anything.
  assert.match(panel, /extraAction\?: ReactNode;/);
  assert.match(panel, /<div className="os-brain-result__actions">\s*\{extraAction\}/);
  assert.equal(panel.match(/extraAction=/g)?.length ?? 0, 0, "Setup's own result passes none");
});

// ---- "Add a sign-in in Hermes": Hermes's own credential helper (`hermes auth`), beside "Choose in Hermes" ----------

test("Add a sign-in in Hermes: the owner's sentence word for word, one sentence per launch answer, and the picker's sentences untouched", () => {
  const words = shared.HERMES_AUTH_TERMINAL_WORDS;
  assert.equal(words.opened, "Terminal opened with Hermes's sign-in helper. Add your sign-in there, then press Refresh.");
  assert.deepEqual(Object.keys(words), ["opened", "copy", "spawn_failed"]);
  const command = "/x/hermes auth";
  assert.equal(shared.hermesAuthLaunchWords({ opened: true, command }), words.opened);
  assert.equal(shared.hermesAuthLaunchWords({ opened: false, reason: "copy", command }), words.copy);
  assert.equal(shared.hermesAuthLaunchWords({ opened: false, reason: "spawn_failed", command }), words.spawn_failed);
  assert.equal(shared.hermesAuthLaunchWords({ opened: false, command }), words.copy, "no reason: the copy words");
  // Plain English, sentence case, straight quotes, no em dash, and each one ends by saying what to do next.
  for (const sentence of Object.values(words)) {
    assert.doesNotMatch(sentence, /\u2014/, "no em dash");
    assert.doesNotMatch(sentence, /[\u2018\u2019\u201c\u201d]/, "straight quotes");
    assert.ok(sentence.endsWith("then press Refresh."), sentence);
    assert.doesNotMatch(sentence, /model/i, "it is about a sign-in, not a model");
  }
  assert.match(words.spawn_failed, /^Terminal didn't open\. Run this command in your own terminal, /);
  // The picker's three sentences (the spec's own set) and their count are exactly as before.
  assert.deepEqual(shared.HERMES_TERMINAL_WORDS, {
    opened: "Terminal opened with Hermes's model picker. Choose there, then press Refresh.",
    copy: "Run this command in your own terminal, choose a model, then press Refresh.",
    spawn_failed: "Terminal didn't open. Run this command in your own terminal, choose a model, then press Refresh."
  });
  assert.equal(shared.hermesLaunchWords({ opened: true, command }), shared.HERMES_TERMINAL_WORDS.opened, "the picker still says its own sentence");
});

test("Add a sign-in in Hermes: a failed press drops the other helper's copy-the-command answer and nothing else", () => {
  const answer = (opened) => ({ opened, command: "/x/hermes", ...(opened ? {} : { reason: "copy" }) });
  const model = (opened) => ({ which: "model", answer: answer(opened) });
  const auth = (opened) => ({ which: "auth", answer: answer(opened) });
  // Linux: the picker showed its command to copy; the sign-in press then failed. That command must go.
  assert.equal(shared.launchAfterFailure(model(false), "auth"), null);
  assert.equal(shared.launchAfterFailure(auth(false), "model"), null);
  // The other helper's window did open: that sentence is still true, so it stays (with Refresh).
  const opened = model(true);
  assert.equal(shared.launchAfterFailure(opened, "auth"), opened);
  // The same helper failing again keeps its own earlier answer, as before.
  const own = model(false);
  assert.equal(shared.launchAfterFailure(own, "model"), own);
  // Nothing on screen: nothing to keep.
  assert.equal(shared.launchAfterFailure(null, "auth"), null);
});

test("wiring: 'Add a sign-in in Hermes' is a second secondary button beside 'Choose in Hermes', through the same launcher, busy flag, time limit and error path", () => {
  const hermes = read("src/ui/components/ChooseInHermes.tsx");
  // Exactly one of each label, drawn as button text.
  assert.equal(hermes.match(/>\s*Choose in Hermes\s*</g)?.length, 1);
  assert.equal(hermes.match(/>\s*Add a sign-in in Hermes\s*</g)?.length, 1);
  // Each button: secondary, its own request inside the time limit, disabled by the one busy flag.
  const button = (which, call, label) =>
    new RegExp(
      `<button\\s+type="button"\\s+className="os-btn os-btn--secondary"\\s+onClick=\\{\\(\\) => void open\\("${which}", \\(\\) => withTimeout\\(${call}\\(\\), PLAN_LIMITS_MS\\.action\\)\\)\\}\\s+disabled=\\{busy\\}\\s*>\\s*${label}\\s*</button>`
    );
  assert.match(hermes, button("model", "openHermesModelTerminal", "Choose in Hermes"));
  assert.match(hermes, button("auth", "openHermesAuthTerminal", "Add a sign-in in Hermes"));
  // In the row, in this order: Choose in Hermes, Add a sign-in in Hermes, then Refresh (only after something opened).
  const at = (needle) => hermes.indexOf(needle);
  assert.ok(at("Choose in Hermes\n") > 0 && at("Choose in Hermes\n") < at("Add a sign-in in Hermes\n"));
  assert.ok(at("Add a sign-in in Hermes\n") < at("{launch ? (\n          <button"), "Refresh follows both buttons");
  // The two caution lines stay above both buttons, drawn from the same two sentences.
  assert.ok(at("HERMES_PICKER_LINES.map(") > 0 && at("HERMES_PICKER_LINES.map(") < at("Choose in Hermes\n"));
  assert.equal(hermes.match(/HERMES_PICKER_LINES/g)?.length, 2, "imported once, drawn once");
  // One launcher and one busy flag for both: a second press waits, and the busy state always ends.
  assert.equal(hermes.match(/async function open\(/g)?.length, 1, "one launcher");
  assert.equal(hermes.match(/setBusy\(true\)/g)?.length, 1);
  assert.match(hermes, /async function open\(which: HermesHelper, send: \(\) => Promise<TerminalLaunch>\) \{\s*if \(busy\) return;/);
  assert.match(hermes, /\} finally \{\s*if \(alive\.current\) setBusy\(false\);\s*\}/);
  // Errors take the one path that both use, and an unreadable answer is refused the same way.
  assert.equal(hermes.match(/planProblem\(error, friendlyError\)/g)?.length, 1);
  assert.match(hermes, /typeof answer\.opened !== "boolean" \|\| typeof answer\.command !== "string"\) throw new Error\(UNREADABLE_WORDS\)/);
  // The status line follows the last answer's own helper: its sentence, and the command to copy when nothing opened.
  assert.match(hermes, /\{launch\.which === "auth" \? hermesAuthLaunchWords\(launch\.answer\) : hermesLaunchWords\(launch\.answer\)\}/);
  assert.match(hermes, /\{launch && !launch\.answer\.opened \? <SetupCommand command=\{launch\.answer\.command\} label="Copy the command" \/> : null\}/);
  assert.match(hermes, /setLaunch\(\{ which, answer \}\);/);
  // A failed press goes through launchAfterFailure (its rule is checked in the test above).
  assert.equal(hermes.match(/launchAfterFailure\(previous, which\)/g)?.length, 1);
  assert.match(hermes, /\} catch \(error\) \{\s*if \(alive\.current\) \{\s*setProblem\(planProblem\(error, friendlyError\)\);\s*setLaunch\(\(previous\) => launchAfterFailure\(previous, which\)\);/);
  // Refresh and the re-read on window focus are the ones from before: nothing about them depends on which helper opened.
  assert.match(hermes, /latestFocus\.current\(\);/);
  assert.match(hermes, /function refresh\(\) \{\s*lastRead\.current = Date\.now\(\);\s*latest\.current\(\);/);
  // The new request is the client's own call, never a session, a terminal or a request of the component's own.
  assert.equal(hermes.match(/\bopenHermesAuthTerminal\b/g)?.length, 2, "imported once, called once");
  assert.doesNotMatch(hermes, /\bfetch\(|sessionsApi|SessionTerminal|createSession|signin-terminal/);
  // The answer words are the shared ones; the sentence is not written out a second time in the component.
  assert.doesNotMatch(hermes, /Add your sign-in there|Terminal opened with/);
});
