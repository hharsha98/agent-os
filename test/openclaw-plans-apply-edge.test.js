// OpenClaw's plan brains on the server, part 3 of 3 (SP4 sweep B: test/openclaw-plans.test.js took more than
// two minutes of its 180 s limit on its own, so its tests are spread over three files that `node --test` runs
// side by side; nothing in them changed): the ChatGPT Apply with a current model that cannot be read or put
// back, Safety 6, the hello's 90 s limit, Look only, the rule that the plan reads' output is never logged, a
// typed model name, a plan job that Agent OS quit during or whose runner failed outside a step, an Apply after
// an interrupted one, the two refusals outside the plan route, and the live shapes of check S-B3. Part 1 is
// test/openclaw-plans.test.js (the pure rules, the readers, the status and model routes), part 2 is
// test/openclaw-plans-apply.test.js (the plan route's refusals, both Applies, Cancel).
//
// Fakes only: the setup-brain OpenClaw fake and the builder Claude Code fake in
// a real-path temp HOME (test/helpers/openclaw-plan-env.js), W1's fakes for the
// other agent names, and a PATH of only those folders plus the system folders.
// Where a test removes the fake Claude Code, refuseSystemAgent first checks that
// no real one could be found instead. No server process and no session is
// started. Never a real agent.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { ADAPTERS } from "../server/runtime/agents/index.js";
import { setExecutionGateStatus } from "../server/runtime/execution-gate.js";
import { getRunManager } from "../server/runtime/runs/run-manager.js";
import { runCommand } from "../server/runtime/safety.js";
import {
  HELLO_SKIPPED_AT_LOOK_ONLY,
  PLAN_JOB_STEPS,
  getSetupJob,
  resetSetupJobsForTest,
  retrySetupJob,
  startConfigureJob
} from "../server/runtime/setup/jobs.js";
import {
  CHATGPT_NOT_READY,
  CURRENT_MODEL_NOT_RESTORABLE,
  CURRENT_MODEL_UNREADABLE,
  FABLE_NOTE,
  PLAN_JOB_INTERRUPTED,
  claudeCliPinned,
  hasClaudeCliPin,
  noEarlierPrimary,
  planModelRows
} from "../server/runtime/setup/openclaw-plan-rules.js";
import { readOpenclawModelsConfig, readPlanModels } from "../server/runtime/setup/openclaw-plans.js";
import { readReceipt } from "../server/runtime/setup/receipt.js";
import { readFakeAgentState, writeFakeAgentState } from "./helpers/fake-knobs.js";
import { FAKE_CLAUDE_CLI_PINS, FAKE_SECRET, installFakeOpenclawShim } from "./helpers/fake-openclaw.js";
import {
  agentEnvLog,
  listFiles,
  openclawRecord,
  refuseSystemAgentFolders,
  siwcRow,
  waitForPlanJob,
  withEnv,
  withPlanEnv
} from "./helpers/openclaw-plan-env.js";

const posixSkip = { skip: process.platform === "win32" ? "the fake agents are POSIX shell shims" : false };

const apply = (call, plan, model, extra = {}) =>
  call("POST", "/api/setup/openclaw/plan", { plan, model, confirm: true, acceptOpenClawRisk: true, ...extra });
const argvLines = async (home) => (await openclawRecord(home)).map((line) => line.argv.join(" "));
const stepOf = (job, id) => job.steps.find((step) => step.id === id);

// Runs the fake OpenClaw's own `onboard --auth-choice anthropic-cli`, the command the Claude Apply's first step runs,
// so the fake's state holds the claude-cli pins. As on the real 2026.10.4 (live check S-B3, 2026-10-16), its
// anthropic model list is empty until then and has rows afterwards.
async function runFakeClaudeOnboard(home) {
  const result = await runCommand(path.join(home, ".npm-global", "bin", "openclaw"), ["onboard", "--non-interactive", "--accept-risk", "--auth-choice", "anthropic-cli"], 10000);
  assert.equal(result.ok, true, result.stderr);
}

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

// The dated fallback model lists, the same table as in test/openclaw-plans.test.js (the live-shape test below
// checks the lists against it; it was declared there, between two tests, before the file was split).
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
      await knob("FAKE_OPENCLAW_STATUS_JSON", "openai-missing");
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

test("The output of models auth list and models status (--json and the older --check) is never logged, saved or returned", posixSkip, async () => {
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
      const jobs = [];
      try {
        answers.push((await call("GET", "/api/setup/openclaw/plans")).text);
        answers.push((await call("GET", "/api/setup/agents/openclaw/model")).text);
        // Four Applies, one per way the readiness is read: the older `--check --plain` (exit 2, expiring), a status
        // answer that is not JSON, one that fails, and the normal `--json` read. Every one of them prints FAKE_SECRET
        // and the e-mail (the fake does that on purpose; the real output has neither).
        for (const [json, exit] of [["no-auth", "2"], ["garbage", null], ["fail", null], [null, null]]) {
          await knob("FAKE_OPENCLAW_STATUS_JSON", json);
          await knob("FAKE_OPENCLAW_STATUS_EXIT", exit);
          const started = await apply(call, "chatgpt", "gpt-6.1-sol");
          answers.push(started.text);
          const job = await waitForPlanJob(started.body.id);
          jobs.push(job);
          answers.push((await call("GET", `/api/setup/jobs/${job.id}`)).text);
          answers.push((await call("GET", "/api/setup/openclaw/plans")).text);
          answers.push((await call("GET", "/api/setup/agents/openclaw/model")).text);
        }
      } finally {
        Object.assign(console, originals);
      }
      assert.deepEqual(jobs.map((job) => [job.status, job.readiness]), [["succeeded", "expiring"], ["succeeded", "unknown"], ["succeeded", "unknown"], ["succeeded", "ready"]]);
      const files = await listFiles(agentOsHome);
      assert.ok(files.length > 0);
      for (const secret of [FAKE_SECRET, "someone@example.com", "accessToken", "this is not json"]) {
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
      await knob("FAKE_OPENCLAW_STATUS_JSON", "openai-missing"); // readiness fails, so the earlier model is put back
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

// Live check S-B3 on OpenClaw 2026.10.4 (2026-10-16) found that the fake printed three reads in shapes the real
// program never prints. Agent OS reads only each model row's key and name and each models-config entry's
// agentRuntime.id, so nothing went wrong for the person, but the tests built on the fake proved less. The values
// below are made up; the shapes are the live ones.
test("live shape from S-B3 (2026-10-16): model lists and models-config", posixSkip, async () => {
  await withPlanEnv(async ({ call, home }) => {
    const shim = path.join(home, ".npm-global", "bin", "openclaw");
    const read = async (...args) => {
      const result = await runCommand(shim, args, 10000);
      assert.equal(result.ok, true, result.stderr);
      return JSON.parse(result.stdout);
    };
    const list = (provider) => read("models", "list", "--provider", provider, "--json");
    // The live rows: openai has eight keys, anthropic seven (no contextTokens).
    const ROW_KEYS = {
      openai: ["available", "contextTokens", "contextWindow", "input", "key", "local", "name", "tags"],
      anthropic: ["available", "contextWindow", "input", "key", "local", "name", "tags"]
    };
    const assertLiveList = (answer, provider, expectedIds) => {
      assert.deepEqual(Object.keys(answer).sort(), ["count", "models"], `${provider}: only count and models`);
      assert.equal(answer.count, answer.models.length, `${provider}: count is the number of rows`);
      assert.deepEqual(answer.models.map((row) => row.key), expectedIds.map((id) => `${provider}/${id}`), provider);
      for (const row of answer.models) {
        assert.deepEqual(Object.keys(row).sort(), ROW_KEYS[provider], `${provider}: ${row.key} has its ${ROW_KEYS[provider].length} keys`);
        assert.deepEqual(
          [typeof row.contextWindow, row.input, row.local, row.available, typeof row.name],
          ["number", "text+image", false, true, "string"],
          row.key
        );
        if (provider === "openai") assert.equal(typeof row.contextTokens, "number", `${row.key} contextTokens`);
        assert.ok(Array.isArray(row.tags) && row.tags.every((tag) => typeof tag === "string" && tag !== ""), `${row.key}: tags is a list of words`);
      }
      // The live tags differ from row to row, so the rows are not all alike.
      assert.ok(new Set(answer.models.map((row) => JSON.stringify(row.tags))).size > 1, `${provider}: the rows' tags vary`);
    };
    const detected = await ADAPTERS.openclaw.detect({ refresh: true });

    // 1. The openai list: always rows, in the live shape.
    const openai = await list("openai");
    assertLiveList(openai, "openai", ["gpt-6.1-sol", "gpt-6-luna"]);
    assert.deepEqual(planModelRows(openai, "chatgpt"), [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }, { id: "gpt-6-luna", name: "GPT-6 Luna" }]);
    const chatgptModels = [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", note: null, available: true },
      { id: "gpt-6-luna", name: "GPT-6 Luna", note: null, available: true }
    ];
    const chatgptAnswer = { models: chatgptModels, source: "account", asOf: null };
    assert.deepEqual(await readPlanModels("chatgpt", { detected }), chatgptAnswer);
    assert.deepEqual((await call("GET", "/api/setup/openclaw/plan-models?plan=chatgpt")).body, chatgptAnswer);

    // 2. The anthropic list before OpenClaw's Claude onboard: empty, so the card shows Agent OS's fallback list.
    assert.deepEqual(await list("anthropic"), { count: 0, models: [] });
    assert.equal(planModelRows(await list("anthropic"), "claude"), null, "an empty list is not a list");
    const fallbackAnswer = { models: FALLBACK.claude, source: "fallback", asOf: "2026-10-15" };
    assert.deepEqual(await readPlanModels("claude", { detected }), fallbackAnswer);
    assert.deepEqual((await call("GET", "/api/setup/openclaw/plan-models?plan=claude")).body, fallbackAnswer);

    // 3. After the fake's onboard: rows of the anthropic shape (seven keys), and a models-config with one alias.
    await runFakeClaudeOnboard(home);
    const anthropic = await list("anthropic");
    assertLiveList(anthropic, "anthropic", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
    assert.deepEqual(planModelRows(anthropic, "claude"), [
      { id: "claude-opus-5-5", name: "Opus 5.5" },
      { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
      { id: "claude-fable-5-1", name: "Fable 5.1" }
    ]);
    const modelsConfig = await read("config", "get", "agents.defaults.models", "--json");
    assert.deepEqual(Object.keys(modelsConfig).sort(), ["anthropic/claude-fable-5-1", "anthropic/claude-opus-5-5"], "only the two pins have an entry");
    for (const [ref, entry] of Object.entries(modelsConfig)) {
      assert.deepEqual(Object.keys(entry).filter((key) => key !== "agentRuntime" && key !== "alias"), [], `${ref}: nothing but agentRuntime and alias`);
    }
    for (const id of FAKE_CLAUDE_CLI_PINS) assert.deepEqual(modelsConfig[`anthropic/${id}`].agentRuntime, { id: "claude-cli" }, id);
    assert.deepEqual(modelsConfig["anthropic/claude-opus-5-5"], { agentRuntime: { id: "claude-cli" }, alias: "opus" }, "the alias sits on a pinned entry, as every live alias does");
    assert.equal(Object.hasOwn(modelsConfig["anthropic/claude-fable-5-1"], "alias"), false, "the other pin has none");
    assert.equal(Object.hasOwn(modelsConfig, "anthropic/claude-sonnet-5-5"), false, "sonnet is not pinned, so it has no entry and no alias");
    assert.deepEqual(await readOpenclawModelsConfig(detected), modelsConfig, "Agent OS reads the same config");
    assert.equal(hasClaudeCliPin(modelsConfig), true);
    assert.deepEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"].map((id) => claudeCliPinned(modelsConfig, id)), [true, false, true], "the pins decide, not the alias");
    const claudeAnswer = {
      models: [
        { id: "claude-opus-5-5", name: "Opus 5.5", note: null, available: true },
        { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: null, available: false },
        { id: "claude-fable-5-1", name: "Fable 5.1", note: FABLE_NOTE, available: true }
      ],
      source: "account",
      asOf: null
    };
    assert.deepEqual(await readPlanModels("claude", { detected }), claudeAnswer);
    assert.deepEqual((await call("GET", "/api/setup/openclaw/plan-models?plan=claude")).body, claudeAnswer);
    assert.deepEqual(await readPlanModels("chatgpt", { detected }), chatgptAnswer, "the openai answer did not change");
  });
});
