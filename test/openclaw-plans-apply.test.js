// OpenClaw's plan brains on the server, part 2 of 3 (SP4 sweep B: test/openclaw-plans.test.js took more than
// two minutes of its 180 s limit on its own, so its tests are spread over three files that `node --test` runs
// side by side; nothing in them changed): the plan route's refusals, both Applies with their steps in order,
// the runtime check, readiness, the put-back of the earlier model, the hello skipped at Look only, and Cancel
// at each stage. Part 1 is test/openclaw-plans.test.js (the pure rules, the readers, the status and model
// routes), part 3 is test/openclaw-plans-apply-edge.test.js (the unreadable current model, Safety 6, the logs,
// a plan job that Agent OS quit during, the live shapes).
//
// Fakes only: the setup-brain OpenClaw fake and the builder Claude Code fake in
// a real-path temp HOME (test/helpers/openclaw-plan-env.js), W1's fakes for the
// other agent names, and a PATH of only those folders plus the system folders.
// Where a test removes the fake Claude Code, refuseSystemAgent first checks that
// no real one could be found instead. No server process and no session is
// started. Never a real agent.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { setExecutionGateStatus } from "../server/runtime/execution-gate.js";
import { getRunManager } from "../server/runtime/runs/run-manager.js";
import { cancelSetupJob, getSetupJob, startOpenclawPlanJob } from "../server/runtime/setup/jobs.js";
import {
  CHATGPT_EXPIRING,
  CHATGPT_HELLO_FAILED,
  CHATGPT_HELLO_FAILED_PUT_BACK,
  CHATGPT_NOT_READY,
  CHATGPT_READINESS_UNKNOWN,
  CHATGPT_READINESS_UNKNOWN_LOOK_ONLY,
  MODEL_SETTINGS_UNREADABLE,
  RUNTIME_CHECK_FAILED,
  noEarlierPrimary
} from "../server/runtime/setup/openclaw-plan-rules.js";
import { readReceipt } from "../server/runtime/setup/receipt.js";
import { readFakeAgentState } from "./helpers/fake-knobs.js";
import { FAKE_CLAUDE_CLI_PINS } from "./helpers/fake-openclaw.js";
import {
  CLAUDE_AUTH,
  agentEnvLog,
  listFiles,
  openclawRecord,
  readJsonLines,
  refuseSystemAgent,
  siwcRow,
  waitForPlanJob,
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

    // The state holds the claude-cli pins (as after OpenClaw's Claude onboard), so the anthropic list has rows; with
    // an empty list (the fallback) a plain typed name like claude-new-9 would be accepted instead.
    for (const model of ["Bad Name!", "claude-new-9", "", "anthropic/../x"]) {
      const refused = await post({ ...good, model });
      assert.deepEqual([refused.status, refused.body], [400, { error: "invalid_model_id", message: "That doesn't look like a model name." }], model);
    }
    const lines = await argvLines(home);
    assert.ok(!lines.some((line) => line.startsWith("onboard") || line.startsWith("config set") || line.startsWith("models set")), "a refused model changes nothing");
    assert.deepEqual(await listFiles(path.join(agentOsHome, "setup", "jobs")), [], "no job was made");
  }, { state: { models: Object.fromEntries(FAKE_CLAUDE_CLI_PINS.map((id) => [`anthropic/${id}`, CLI])) } });
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

test("ChatGPT plan Apply: models set, safe defaults, readiness (models status --json says ready; an older OpenClaw's --check exit 0 ready, exit 2 expiring with its warning), the hello", posixSkip, async () => {
  const JSON_RUN = "models status --json";
  const CHECK_RUN = "models status --check --plain";
  for (const [why, json, exit, readiness, runs] of [
    ["models status --json (the sign-in renews itself)", null, null, "ready", [JSON_RUN]],
    ["models status --json, the sign-in expired an hour after its last use (OpenClaw renews it on use; no false alarm)", "openai-expired", null, "ready", [JSON_RUN]],
    ["an older OpenClaw, --check exit 0", "no-auth", "0", "ready", [JSON_RUN, CHECK_RUN]],
    ["an older OpenClaw, --check exit 2", "no-auth", "2", "expiring", [JSON_RUN, CHECK_RUN]]
  ]) {
    await withPlanEnv(
      async ({ call, home, knob }) => {
        await knob("FAKE_OPENCLAW_STATUS_JSON", json);
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
        assert.equal(done.status, "succeeded", why);
        assert.deepEqual([done.readiness, done.previousPrimary], [readiness, "openrouter/vendor/old"], why);
        assert.deepEqual(stepOf(done, "openclaw-plan-readiness").warnings, readiness === "expiring" ? [CHATGPT_EXPIRING] : [], why);
        const lines = await argvLines(home);
        const order = ["config get agents.defaults.model.primary", "models set openai/gpt-6.1-sol", "config set tools.exec.mode ask", JSON_RUN];
        const positions = order.map((line) => lines.indexOf(line));
        assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), `${why}: ${JSON.stringify(positions)}`);
        assert.ok(positions[3] < lines.lastIndexOf("doctor --json"), "the hello after readiness");
        assert.deepEqual(lines.filter((line) => line.startsWith("models status")), runs, why);
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

// Live check S-B3 (2026-10-16): after the Claude plan's onboard, `models status --check` exited 1 because OpenClaw's
// utility model was an anthropic one on the claude-cli runtime ("indeterminate"), although the ChatGPT sign-in was fine.
// The readiness now looks at the openai provider alone, so that setup, and a codex route reading "unavailable", go on.
test("ChatGPT plan Apply: another provider's trouble (the Claude plan's utility model, the codex runtime route) does not stop it", posixSkip, async () => {
  for (const json of ["claude-cli-indeterminate", "codex-unavailable"]) {
    await withPlanEnv(
      async ({ call, home, knob }) => {
        await knob("FAKE_OPENCLAW_STATUS_JSON", json);
        const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
        assert.equal(done.status, "succeeded", json);
        assert.deepEqual([done.readiness, stepOf(done, "openclaw-plan-readiness").warnings], ["ready", []], json);
        assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol"], `${json}: nothing put back`);
        assert.equal((await readFakeAgentState(home)).primary, "openai/gpt-6.1-sol");
        // The fake's whole-setup `--check` exits 1 for the first of these (as the real 2026.10.4 did in live check S-B3),
        // so this test fails if the readiness read ever goes back to it.
        assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models status")), ["models status --json"], `${json}: never --check`);
      },
      { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
    );
  }
});

test("ChatGPT plan Apply stopped at readiness puts the earlier model back; with no earlier model, OpenClaw keeps the new one and the job says so", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, knob }) => {
      const started = await apply(call, "chatgpt", "gpt-6-luna");
      assert.equal(started.status, 200, "signed in without token sharing is still a sign-in; readiness catches it (the fake shows it as an oauth profile of another kind)");
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
      await knob("FAKE_OPENCLAW_STATUS_JSON", "openai-missing");
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

test("ChatGPT plan Apply stopped at readiness on an older OpenClaw (no auth block, --check exit 1) puts the earlier model back too", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_JSON", "no-auth");
      await knob("FAKE_OPENCLAW_STATUS_EXIT", "1");
      const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6-luna")).body.id);
      const step = stepOf(done, "openclaw-plan-readiness");
      assert.deepEqual([done.status, done.readiness, step.error, step.warnings], ["failed", "not_ready", CHATGPT_NOT_READY, []]);
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6-luna", "models set openrouter/vendor/old"]);
      assert.equal((await readFakeAgentState(home)).primary, "openrouter/vendor/old");
      assert.equal(stepOf(done, "health").status, "pending", "no hello");
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

// Live check S-B3 (2026-10-16): `--check` once took longer than the 15 s read limit, and an internet drop made a token-sharing
// refresh fail. A read that gives no usable answer stops nothing: the hello check shows whether the plan works.
test("ChatGPT plan Apply, readiness unknown (the status read is unreadable or fails): its warning, the model stays, and the job goes on to the hello", posixSkip, async () => {
  for (const json of ["garbage", "fail"]) {
    await withPlanEnv(
      async ({ call, home, knob }) => {
        await knob("FAKE_OPENCLAW_STATUS_JSON", json);
        const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
        assert.equal(done.status, "succeeded", json);
        assert.deepEqual([done.readiness, done.previousPrimary], ["unknown", "openrouter/vendor/old"], json);
        const readiness = stepOf(done, "openclaw-plan-readiness");
        assert.deepEqual([readiness.status, readiness.error, readiness.warnings, readiness.runIds], ["succeeded", null, [CHATGPT_READINESS_UNKNOWN], []], json);
        assert.equal(done.health.openclaw.promptOk, true, `${json}: the hello ran and answered`);
        const lines = await argvLines(home);
        assert.deepEqual(lines.filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol"], `${json}: nothing put back`);
        assert.deepEqual(lines.filter((line) => line.startsWith("models status")), ["models status --json"], `${json}: no fallback to --check after an unreadable answer`);
        assert.ok(lines.indexOf("models status --json") < lines.lastIndexOf("doctor --json"), `${json}: the hello came after`);
        assert.equal((await readFakeAgentState(home)).primary, "openai/gpt-6.1-sol");
        assert.deepEqual(stepOf(done, "health").warnings, []);
        const receipt = await readReceipt();
        assert.deepEqual(receipt.map((entry) => [entry.provider, entry.model]), [["chatgpt-plan", "gpt-6.1-sol"]], `${json}: the model stays, so the receipt says so`);
      },
      { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
    );
  }
});

// The job must not end "set up" for a plan OpenClaw is no longer on (BrainResult would say "Set up, but not every agent
// answered" beside a ChatGPT line while OpenClaw is back on the earlier model): it ends failed, like a readiness that says
// not ready, with a sentence that says what happened.
test("ChatGPT plan Apply, readiness unknown and then the hello fails: the earlier model is put back and the job fails on the hello step saying so; with none, the job says OpenClaw keeps the new one", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_JSON", "garbage");
      await writeFile(path.join(home, ".fake-openclaw-agent-fail"), "");
      const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
      assert.deepEqual([done.status, done.readiness, done.health.openclaw.promptOk], ["failed", "unknown", false]);
      assert.deepEqual(stepOf(done, "openclaw-plan-readiness").warnings, [CHATGPT_READINESS_UNKNOWN]);
      const health = stepOf(done, "health");
      assert.deepEqual([health.status, health.error], ["failed", CHATGPT_HELLO_FAILED_PUT_BACK], "the result's alert says the earlier model is back");
      assert.equal(health.runIds.length, 2, "the hello, then the put-back as a run of its own");
      assert.deepEqual(health.warnings, []);
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol", "models set openrouter/vendor/old"]);
      assert.equal((await readFakeAgentState(home)).primary, "openrouter/vendor/old", "OpenClaw is not left on a ChatGPT model it can't use");
      assert.deepEqual(await readReceipt(), [], "a failed job writes no receipt, as for a readiness that says not ready");
      const model = (await call("GET", "/api/setup/agents/openclaw/model")).body;
      assert.notEqual(model.plan, "chatgpt");
      // What the person reads is saved with the job.
      const saved = await getSetupJob(done.id);
      assert.deepEqual([saved.status, stepOf(saved, "health").error], ["failed", CHATGPT_HELLO_FAILED_PUT_BACK]);
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_JSON", "fail");
      await writeFile(path.join(home, ".fake-openclaw-agent-fail"), "");
      const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
      assert.deepEqual([done.status, done.readiness, done.previousPrimary, done.health.openclaw.promptOk], ["failed", "unknown", null, false]);
      const health = stepOf(done, "health");
      assert.deepEqual(
        [health.status, health.error, health.warnings],
        ["failed", CHATGPT_HELLO_FAILED, [noEarlierPrimary("openai/gpt-6.1-sol")]],
        "no claim that a model was put back, and the job's last line says OpenClaw keeps the new one"
      );
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol"]);
      assert.equal((await readFakeAgentState(home)).primary, "openai/gpt-6.1-sol");
      assert.deepEqual(await readReceipt(), []);
    },
    { state: { primary: null, authRows: [siwcRow()] } }
  );
  // The hello failing after a readiness that DID answer is today's behaviour: nothing is put back, and the job is a result.
  await withPlanEnv(
    async ({ call, home }) => {
      await writeFile(path.join(home, ".fake-openclaw-agent-fail"), "");
      const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
      assert.deepEqual([done.status, done.readiness, done.health.openclaw.promptOk], ["succeeded", "ready", false]);
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol"]);
      assert.equal((await readFakeAgentState(home)).primary, "openai/gpt-6.1-sol");
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});

test("ChatGPT plan Apply, readiness unknown at Look only: the hello is skipped, nothing failed, so nothing is put back, and the warning does not promise a hello check", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, home, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_JSON", "garbage");
      await setExecutionGateStatus({ enabled: false, reason: "look only" });
      const done = await waitForPlanJob((await apply(call, "chatgpt", "gpt-6.1-sol")).body.id);
      assert.deepEqual([done.status, done.readiness, done.health.openclaw.skipped], ["succeeded", "unknown", true]);
      assert.deepEqual(stepOf(done, "openclaw-plan-readiness").warnings, [CHATGPT_READINESS_UNKNOWN_LOOK_ONLY]);
      assert.notEqual(CHATGPT_READINESS_UNKNOWN_LOOK_ONLY, CHATGPT_READINESS_UNKNOWN);
      assert.deepEqual((await argvLines(home)).filter((line) => line.startsWith("models set")), ["models set openai/gpt-6.1-sol"]);
      assert.equal((await readFakeAgentState(home)).primary, "openai/gpt-6.1-sol");
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
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

// putBackAfterFailedHello puts the earlier model back only when the hello failed because of the plan. A hello that ended
// because the person pressed Cancel did not, and a cancelled job leaves everything finished as it is: the Apply's model
// stays, and no second models set runs. (Every other hello-failure test makes the hello fail on its own.)
test("Cancel during the ChatGPT Apply's hello, after a readiness that gave no answer: the earlier model is not put back, and the job ends cancelled with the Apply's one models set", posixSkip, async () => {
  await withPlanEnv(
    async ({ home, knob }) => {
      await knob("FAKE_OPENCLAW_STATUS_JSON", "garbage");
      await knob("FAKE_OPENCLAW_AGENT_HANG", "1");
      const job = await startOpenclawPlanJob({ plan: "chatgpt", model: "gpt-6.1-sol", acceptOpenClawRisk: true });
      // The hello is the one `agent exec` that reads a message (--message-file); the fake never answers it.
      await waitForAnotherCall(home, "agent exec --message-file", 0);
      assert.equal((await cancelSetupJob(job.id)).status, "cancelled");
      await new Promise((resolve) => setTimeout(resolve, AFTER_CANCEL_MS));
      const done = await waitForPlanJob(job.id);
      assert.deepEqual([done.status, done.readiness, done.previousPrimary], ["cancelled", "unknown", "openrouter/vendor/old"]);
      assert.deepEqual(
        (await argvLines(home)).filter((line) => line.startsWith("models set")),
        ["models set openai/gpt-6.1-sol"],
        "only the Apply's own models set: nothing put the earlier model back after Cancel"
      );
      assert.equal((await readFakeAgentState(home)).primary, "openai/gpt-6.1-sol", "left as the Apply finished it");
      assert.notEqual(stepOf(done, "health").error, CHATGPT_HELLO_FAILED_PUT_BACK);
      assert.equal(stepOf(done, "health").runIds.length, 1, "the hello only: no put-back run");
      assert.deepEqual(await readReceipt(), [], "a cancelled job writes no receipt");
    },
    { state: { primary: "openrouter/vendor/old", authRows: [siwcRow()] } }
  );
});
