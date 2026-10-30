// The one-job-at-a-time lock when a job has just ended (CI fix for the
// "ChatGPT plan Apply: a current model that can't be read" flake and the "a
// second job reuses it" flake). A job sets its final status in memory, then
// saves it to disk, and only then frees the lock. A poll answers from memory,
// so a person (or a test) sees "ended" while the lock is still held; a start in
// that moment used to be refused with job_already_running. Now such a start
// waits for the job to finish saving and then claims the lock, while a job that
// is still running is refused at once.
//
// Deterministic: the window is held open with the test-only persist hook of
// server/runtime/setup/jobs.js (setPersistHookForTest), not with sleeps. A
// check that something has NOT happened yet cannot flake: the lock stays held
// for as long as the save is held. Fakes only (test/helpers/openclaw-plan-env.js:
// the fake OpenClaw in a temp HOME); no real agent is ever started.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { retrySetupJob, setPersistHookForTest, startOpenclawPlanJob } from "../server/runtime/setup/jobs.js";
import { siwcRow, waitForPlanJob, withPlanEnv } from "./helpers/openclaw-plan-env.js";

const posixSkip = { skip: process.platform === "win32" ? "the fake agents are POSIX shell shims" : false };

// How long to look at a start that must still be waiting. The old code refused
// a start within a few milliseconds (an HTTP round trip at most), so this is
// plenty. It cannot make a test flaky: the lock stays held for as long as the
// save is held, however long that look takes. The 409 for a running job, on the
// other hand, must come back nowhere near the 5 s wait.
const LOOK_AT_WAITING_MS = 150;
const AT_ONCE_MS = 2000;

const PLAN_STATE = { primary: "openrouter/vendor/old", authRows: [siwcRow()] };
const apply = (call) =>
  call("POST", "/api/setup/openclaw/plan", { plan: "chatgpt", model: "gpt-6.1-sol", confirm: true, acceptOpenClawRisk: true });
const startDirect = () => startOpenclawPlanJob({ plan: "chatgpt", model: "gpt-6.1-sol", acceptOpenClawRisk: true });

const lookAtWaiting = () => new Promise((resolve) => setTimeout(resolve, LOOK_AT_WAITING_MS));

// A start that waits for a finishing job to save gives up after JOB_SETTLE_TIMEOUT_MS (5 s of the clock, in
// jobs.js) and is then refused. On a very busy machine a test can be held up for that long between "the starts
// are waiting" and "the save is let through", and then every waiting start is refused and none wins. With
// Date frozen (setTimeout stays real) the waiting start never runs out of time: it ends when the job is saved,
// which is the thing these tests are about. Not used by the test that measures how fast a refusal comes.
const freezeClock = (t) => t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

// Holds the first save that `matches(job, savesOfThisJob)` is true for, until
// release(). `arrived` resolves (with the job id) when that save is held, `log`
// has one entry per save asked for and a "released" marker, in order.
function holdSave(matches) {
  const log = [];
  let release = () => {};
  let arrive = () => {};
  const open = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    arrive = resolve;
  });
  let held = false;
  setPersistHookForTest(async (job) => {
    log.push({ id: job.id, status: job.status });
    if (held) return;
    if (!matches(job, log.filter((entry) => entry.id === job.id).length)) return;
    held = true;
    arrive(job.id);
    await open;
  });
  return {
    log,
    arrived,
    release: () => {
      log.push("released");
      release();
    }
  };
}

const jobFile = (agentOsHome, id) => path.join(agentOsHome, "setup", "jobs", `${id}.json`);
const storedJob = async (agentOsHome, id) => JSON.parse(await readFile(jobFile(agentOsHome, id), "utf8"));
const jobIds = async (agentOsHome) => (await readdir(path.join(agentOsHome, "setup", "jobs"))).map((name) => name.replace(/\.json$/, ""));

test("a start made while a job that has just ended is still saving waits for the save, then starts (200)", posixSkip, async (t) => {
  freezeClock(t);
  await withPlanEnv(
    async ({ call, agentOsHome }) => {
      const hold = holdSave((job) => job.status !== "running");
      const first = await apply(call);
      assert.equal(first.status, 200);
      const firstId = first.body.id;
      await hold.arrived;

      // The window: the job has ended as far as a poll can tell, the disk still has the older copy, the lock is held.
      const polled = await call("GET", `/api/setup/jobs/${firstId}`);
      assert.equal(polled.body.status, "succeeded", "a poll sees the job ended");
      assert.equal((await storedJob(agentOsHome, firstId)).status, "running", "its last save has not reached the disk");

      let answer = null;
      const second = apply(call).then((result) => {
        answer = result;
        return result;
      });
      await lookAtWaiting();
      assert.equal(answer, null, "the start waits; it is not refused with job_already_running");

      hold.release();
      const started = await second;
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.notEqual(started.body.id, firstId, "a new job");
      // The first job's final save landed before the new job was even asked to save.
      const releasedAt = hold.log.indexOf("released");
      const newJobFirstSave = hold.log.findIndex((entry) => entry !== "released" && entry.id === started.body.id);
      assert.ok(releasedAt >= 0 && newJobFirstSave > releasedAt, JSON.stringify(hold.log));
      const firstStored = await storedJob(agentOsHome, firstId);
      assert.deepEqual([firstStored.status, typeof firstStored.endedAt], ["succeeded", "string"]);
      assert.equal((await waitForPlanJob(started.body.id)).status, "succeeded");
    },
    { state: PLAN_STATE }
  );
});

test("a start made while a job is still running is refused 409 at once, with no wait", posixSkip, async () => {
  await withPlanEnv(
    async ({ call, agentOsHome }) => {
      // The second save of the job is its first one after the start: the job is mid-way and still "running".
      const hold = holdSave((job, saves) => job.status === "running" && saves === 2);
      const first = await apply(call);
      assert.equal(first.status, 200);
      await hold.arrived;
      assert.equal((await call("GET", `/api/setup/jobs/${first.body.id}`)).body.status, "running");

      const began = Date.now();
      const refused = await apply(call);
      assert.deepEqual([refused.status, refused.body.error], [409, "job_already_running"]);
      assert.ok(Date.now() - began < AT_ONCE_MS, "refused straight away, not after waiting for the job to settle");
      assert.deepEqual(await jobIds(agentOsHome), [first.body.id], "the refused start made no job");

      hold.release();
      assert.equal((await waitForPlanJob(first.body.id)).status, "succeeded");
    },
    { state: PLAN_STATE }
  );
});

test("two starts that both wait for the same finishing job: exactly one starts, the other is refused 409", posixSkip, async (t) => {
  freezeClock(t);
  await withPlanEnv(
    async ({ call, agentOsHome }) => {
      const hold = holdSave((job) => job.status !== "running");
      const first = await apply(call);
      assert.equal(first.status, 200);
      await hold.arrived;

      // Direct calls reach the lock before they return, so both are certainly waiting when the save is let through.
      const results = Promise.allSettled([startDirect(), startDirect()]);
      await lookAtWaiting();
      hold.release();
      const [a, b] = await results;
      const started = [a, b].filter((result) => result.status === "fulfilled");
      const refused = [a, b].filter((result) => result.status === "rejected");
      assert.equal(started.length, 1, "exactly one start wins the lock");
      assert.equal(refused.length, 1);
      assert.equal(refused[0].reason.code, "job_already_running");
      assert.equal(refused[0].reason.message, "A setup job is already running.", "the message is the one it always was");
      assert.equal((await waitForPlanJob(started[0].value.id)).status, "succeeded");
      assert.deepEqual((await jobIds(agentOsHome)).sort(), [first.body.id, started[0].value.id].sort(), "only one new job was made");
    },
    { state: PLAN_STATE }
  );
});

test("a retry made while a different job has just ended waits for its save; while it is running, it is refused", posixSkip, async (t) => {
  freezeClock(t);
  await withPlanEnv(
    async ({ call, agentOsHome }) => {
      // An earlier model-change job that failed; its one step needs no command, so a retry finishes on its own.
      const oldId = `job_${(Date.now() - 60000).toString(36)}_000000000001`;
      const startedAt = new Date(Date.now() - 60000).toISOString();
      const old = {
        id: oldId,
        kind: "model",
        status: "failed",
        agentId: "openclaw",
        steps: [{ id: "health", agentId: null, action: "keep", status: "failed", runIds: [], error: "It failed.", log: [], warnings: [] }],
        currentStepIndex: 0,
        startedAt,
        endedAt: startedAt
      };
      await mkdir(path.join(agentOsHome, "setup", "jobs"), { recursive: true });
      await writeFile(jobFile(agentOsHome, oldId), JSON.stringify(old));

      // Held while the other job is mid-way: running, so the retry is refused with today's sentence.
      const midway = holdSave((job, saves) => job.status === "running" && saves === 2);
      const running = await apply(call);
      assert.equal(running.status, 200);
      await midway.arrived;
      await assert.rejects(
        () => retrySetupJob(oldId),
        (error) => error.code === "job_already_running" && error.message === "A different setup job is already running."
      );
      midway.release();
      assert.equal((await waitForPlanJob(running.body.id)).status, "succeeded");

      // Held again, now at the other job's last save: ended as far as a poll can tell, so the retry waits.
      const last = holdSave((job) => job.status !== "running");
      const ending = await apply(call);
      assert.equal(ending.status, 200);
      await last.arrived;
      let answer = null;
      const retry = retrySetupJob(oldId).then((job) => {
        answer = job;
        return job;
      });
      await lookAtWaiting();
      assert.equal(answer, null, "the retry waits");
      last.release();
      const retried = await retry;
      assert.equal(retried.id, oldId);
      assert.equal((await storedJob(agentOsHome, ending.body.id)).status, "succeeded", "the other job's last save landed first");
      assert.equal((await waitForPlanJob(oldId)).status, "succeeded");
    },
    { state: PLAN_STATE }
  );
});
