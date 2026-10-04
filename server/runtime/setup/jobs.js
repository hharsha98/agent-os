// The setup job runner: one "Set up everything" click becomes one job that
// runs its steps sequentially, each as a run-manager run so the existing
// /api/runs/:id/stream gives live progress for free. Job state is kept in
// memory (this process owns any job it starts) and mirrored to disk so a
// GET can read it back and a receipt can outlive the process.
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ADAPTERS } from "../agents/index.js";
import { clearDetectCaches } from "../agents/detect.js";
import { getRunManager } from "../runs/run-manager.js";
import { runCommand } from "../safety.js";
import { readJson, runtimePaths, writeJson } from "../store.js";
import { getInstallRecipe } from "./recipes.js";
import { ensureManagedNode } from "./managed-node.js";
import { buildSetupPlan } from "./plan.js";
import { clearSystemCheckCache, systemCheck } from "./system-check.js";
import { appendReceiptEntry } from "./receipt.js";
import {
  LOCAL_CONTEXT_TOKENS,
  OLLAMA_MODEL_NAME_PATTERN,
  clearLocalModelsCache,
  currentBrain,
  ensureLocalVariant,
  listLocalModels,
  localVariantName,
  ollamaBaseUrl,
  streamOllamaPull
} from "./brain.js";
import { takeKey } from "./openrouter-oauth.js";

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

// This process's view of "a job is running" -- the concurrency lock and the
// place cancel() finds the live AbortController for an in-process step.
const activeJobs = new Map(); // id -> { job, controller }
let runningJobId = null;

function jobError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The one-job-at-a-time lock is taken BEFORE a start function's first await.
// Checking the lock and only claiming it later (after awaits such as the
// system check) let two requests that arrive together both pass the check and
// both start a job. A placeholder claim stands in until the real job id
// replaces it (`runningJobId = id`), and it is released if setup throws.
function claimJobLock() {
  if (runningJobId) throw jobError("job_already_running", "A setup job is already running.");
  const claim = `pending_${crypto.randomBytes(6).toString("hex")}`;
  runningJobId = claim;
  return claim;
}

async function withJobLock(start) {
  const claim = claimJobLock();
  try {
    return await start();
  } finally {
    if (runningJobId === claim) runningJobId = null;
  }
}

function setupRoot() {
  return path.join(runtimePaths().root, "setup");
}
function jobsDir() {
  return path.join(setupRoot(), "jobs");
}
function downloadsDir() {
  return path.join(setupRoot(), "downloads");
}
function jobFile(id) {
  return path.join(jobsDir(), `${id}.json`);
}

function generateJobId() {
  return `job_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

async function persistJob(job) {
  await fs.mkdir(jobsDir(), { recursive: true });
  const { controllers: _ignored, ...serializable } = job;
  await writeJson(jobFile(job.id), serializable);
}

async function loadJob(id) {
  return readJson(jobFile(id), null);
}

function timestampedLog(step, text) {
  step.log = step.log || [];
  step.log.push(`${new Date().toISOString()} ${text}`);
}

// ---- installer download -----------------------------------------------

async function downloadInstaller(agentId, recipe) {
  const url = recipe.installerUrl;
  const isHttps = url.startsWith("https://");
  const isLocalMirror = url.startsWith("http://127.0.0.1:"); // test-only mirror
  if (!isHttps && !isLocalMirror) {
    throw jobError("download_failed", "Refused to download the installer from a non-HTTPS URL.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch {
    clearTimeout(timer);
    throw jobError("download_failed", "could not download the official installer (check your internet connection)");
  }
  clearTimeout(timer);
  if (!response.ok || !response.body) {
    throw jobError("download_failed", "could not download the official installer (check your internet connection)");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw jobError("download_failed", "the official installer response was larger than expected");
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  await fs.mkdir(downloadsDir(), { recursive: true });
  const ext = recipe.shell === "powershell" ? "ps1" : "sh";
  const filePath = path.join(downloadsDir(), `${agentId}-install.${ext}`);
  await fs.writeFile(filePath, buffer, { mode: 0o700 });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return { filePath, sha256 };
}

// ---- run helpers --------------------------------------------------------

function runnerCommandAndArgs(recipe, filePath, extraArgs) {
  if (recipe.shell === "powershell") {
    return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath, ...extraArgs] };
  }
  return { command: "/bin/bash", args: [filePath, ...extraArgs] };
}

function installerEnv(agentId, managedNodeBinDir) {
  const env = { NONINTERACTIVE: "1" };
  if (agentId === "openclaw") {
    env.OPENCLAW_NO_ONBOARD = "1";
    env.OPENCLAW_NO_PROMPT = "1";
  }
  if (managedNodeBinDir) {
    env.PATH = `${managedNodeBinDir}${path.delimiter}${process.env.PATH || ""}`;
  }
  return env;
}

function waitForRunEnd(manager, id) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      unsubscribe();
      resolve(await manager.getRun(id));
    };
    const unsubscribe = manager.subscribe(id, (event) => {
      if (event.type === "end") finish();
    });
    // Covers the run having already ended before subscribe() attached.
    manager.getRun(id).then((run) => {
      if (run && !["queued", "running"].includes(run.status)) finish();
    });
  });
}

async function runStdout(manager, id) {
  const events = await manager.readEvents(id, 0);
  return events
    .filter((event) => event.stream === "stdout")
    .map((event) => event.text || "")
    .join("\n");
}

function lastJsonLine(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning backwards for the last well-formed JSON line
    }
  }
  return null;
}

async function runInstallerOnce(agentId, recipe, filePath, args, managedNodeBinDir, step) {
  const manager = getRunManager();
  const { command, args: fullArgs } = runnerCommandAndArgs(recipe, filePath, args);
  const run = await manager.startRun({
    agentId,
    kind: "install",
    title: `${recipe.label} installer`,
    command,
    args: fullArgs,
    cwd: os.tmpdir(),
    env: installerEnv(agentId, managedNodeBinDir),
    timeoutMs: INSTALL_TIMEOUT_MS
  });
  step.runIds.push(run.id);
  const finalRun = await waitForRunEnd(manager, run.id);
  const stdout = await runStdout(manager, run.id);
  return { run: finalRun, stdout };
}

async function runPlainInstall(agentId, recipe, filePath, step, managedNodeBinDir) {
  const { run } = await runInstallerOnce(agentId, recipe, filePath, recipe.args, managedNodeBinDir, step);
  if (run.status === "timed_out") throw jobError("install_failed", "took longer than 30 minutes");
  if (run.status !== "succeeded") throw jobError("install_failed", "installer reported a failure; see the log");
}

// Hermes-only: --manifest, then one run per stage (each a real run-manager
// run, so the UI gets true per-stage progress). Returns true on success,
// false to signal "fall back to a single plain run" (manifest unreadable).
async function runHermesStaged(agentId, recipe, filePath, step, managedNodeBinDir) {
  const { run: manifestRun, stdout: manifestStdout } = await runInstallerOnce(
    agentId,
    recipe,
    filePath,
    recipe.manifestArgs,
    managedNodeBinDir,
    step
  );
  if (manifestRun.status !== "succeeded") return false;
  const manifest = lastJsonLine(manifestStdout);
  const stageNames = Array.isArray(manifest?.stages) ? manifest.stages.map((s) => s?.name).filter(Boolean) : [];
  if (!stageNames.length) return false;

  for (const name of stageNames) {
    const stageArgs = [recipe.stageFlag, name, ...recipe.stageArgs];
    const { run: stageRun, stdout: stageStdout } = await runInstallerOnce(
      agentId,
      recipe,
      filePath,
      stageArgs,
      managedNodeBinDir,
      step
    );
    const stageResult = lastJsonLine(stageStdout);
    timestampedLog(step, `stage ${name}: ${stageRun.status}${stageResult?.skipped ? " (skipped)" : ""}`);
    if (stageRun.status === "timed_out") throw jobError("install_failed", "took longer than 30 minutes");
    if (stageRun.status !== "succeeded" || stageResult?.ok === false) {
      throw jobError("install_failed", stageResult?.reason || "installer reported a failure; see the log");
    }
  }
  return true;
}

// ---- step execution -----------------------------------------------------

async function executeStep(job, step, check) {
  step.status = "running";
  await persistJob(job);

  if (step.action === "keep" || step.action === "skip-unsupported") {
    step.status = "succeeded";
    return;
  }

  if (step.action === "prereq-node") {
    const controller = new AbortController();
    const active = activeJobs.get(job.id);
    if (active) active.controller = controller;
    try {
      const result = await ensureManagedNode({
        signal: controller.signal,
        onProgress: (message) => {
          timestampedLog(step, message);
          persistJob(job).catch(() => {});
        }
      });
      job.managedNode = result;
      step.status = "succeeded";
    } finally {
      if (active) active.controller = null;
    }
    return;
  }

  const recipe = getInstallRecipe(step.agentId, check.os, check.arch);
  const adapter = ADAPTERS[step.agentId];

  if (step.action === "update") {
    const detected = await adapter.detect({ refresh: true });
    if (!detected.installed) {
      throw jobError("install_failed", `${recipe.label} is not installed; cannot update.`);
    }
    const manager = getRunManager();
    const run = await manager.startRun({
      agentId: step.agentId,
      kind: "install",
      title: `${recipe.label} update`,
      command: detected.path,
      args: recipe.updateArgs,
      cwd: os.tmpdir(),
      timeoutMs: INSTALL_TIMEOUT_MS
    });
    step.runIds.push(run.id);
    const finished = await waitForRunEnd(manager, run.id);
    if (finished.status === "timed_out") throw jobError("install_failed", "took longer than 30 minutes");
    if (finished.status !== "succeeded") throw jobError("install_failed", "installer reported a failure; see the log");
  } else if (step.action === "install") {
    const downloaded = await downloadInstaller(step.agentId, recipe);
    step.installerSha256 = downloaded.sha256;
    timestampedLog(step, `Downloaded installer (sha256 ${downloaded.sha256})`);
    await persistJob(job);

    const managedNodeBinDir = step.agentId === "openclaw" ? job.managedNode?.binDir : null;

    let staged = false;
    if (step.agentId === "hermes" && recipe.supportsStages) {
      staged = await runHermesStaged(step.agentId, recipe, downloaded.filePath, step, managedNodeBinDir);
    }
    if (!staged) {
      if (step.agentId === "hermes" && recipe.supportsStages) {
        timestampedLog(step, "Falling back to a single unattended run (manifest unavailable).");
      }
      await runPlainInstall(step.agentId, recipe, downloaded.filePath, step, managedNodeBinDir);
    }
  } else {
    return;
  }

  clearDetectCaches();
  clearSystemCheckCache();
  const redetected = await adapter.detect({ refresh: true });
  if (!redetected.installed) {
    throw jobError(
      "install_failed",
      `installer finished but ${recipe.label} was not found; open a new terminal or check the log`
    );
  }
  step.status = "succeeded";
  await appendReceiptEntry({
    agentId: step.agentId,
    action: step.action,
    version: redetected.version,
    sourceUrl: recipe.sourceUrl,
    installerSha256: step.installerSha256 || "",
    changes: recipe.changes
  });
}

async function runJobSteps(job, startIndex = 0) {
  activeJobs.set(job.id, { job, controller: null });
  try {
    const check = await systemCheck({ refresh: true });
    for (let i = startIndex; i < job.steps.length; i += 1) {
      const step = job.steps[i];
      if (step.status === "succeeded") continue;
      job.currentStepIndex = i;
      try {
        await executeStep(job, step, check);
      } catch (error) {
        step.status = "failed";
        step.error = error?.message || "Setup step failed.";
        job.status = job.cancelRequested ? "cancelled" : "failed";
        job.endedAt = new Date().toISOString();
        await persistJob(job);
        return;
      }
      await persistJob(job);
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.endedAt = new Date().toISOString();
        await persistJob(job);
        return;
      }
    }
    job.status = "succeeded";
    job.endedAt = new Date().toISOString();
    await persistJob(job);
  } finally {
    activeJobs.delete(job.id);
    if (runningJobId === job.id) runningJobId = null;
  }
}

// ---- public API -----------------------------------------------------

export function startSetupJob(options) {
  return withJobLock(() => startSetupJobLocked(options));
}

async function startSetupJobLocked({ steps = [], acceptOpenClawRisk = false } = {}) {
  const check = await systemCheck({ refresh: true });
  const plan = buildSetupPlan(check);
  const validById = new Map(plan.steps.map((s) => [s.id, s]));
  const requestedIds = Array.isArray(steps) ? steps.map(String) : [];
  // Only step ids that exist in a FRESHLY computed plan are honored; a
  // client-supplied installerUrl/args/path is never read at all.
  const selected = requestedIds.map((id) => validById.get(id)).filter(Boolean);

  if (!selected.length) throw jobError("no_valid_steps", "No valid setup steps were selected.");

  const needsOpenClawConsent = selected.some(
    (s) => s.agentId === "openclaw" && (s.action === "install" || s.action === "prereq-node")
  );
  if (needsOpenClawConsent && acceptOpenClawRisk !== true) {
    throw jobError("openclaw_risk_not_accepted", "OpenClaw install requires acceptOpenClawRisk:true.");
  }

  const id = generateJobId();
  const job = {
    id,
    kind: "install",
    status: "running",
    steps: selected.map((s) => ({
      id: s.id,
      agentId: s.agentId,
      action: s.action,
      status: "pending",
      runIds: [],
      error: null,
      log: []
    })),
    startedAt: new Date().toISOString(),
    endedAt: null,
    acceptOpenClawRisk: needsOpenClawConsent,
    acceptOpenClawRiskAt: needsOpenClawConsent ? new Date().toISOString() : null
  };
  await persistJob(job);
  runningJobId = id;
  runJobSteps(job).catch(() => {});
  return job;
}

export async function getSetupJob(id) {
  const active = activeJobs.get(id);
  if (active) return active.job;
  return loadJob(id);
}

export async function cancelSetupJob(id) {
  const active = activeJobs.get(id);
  const job = active ? active.job : await loadJob(id);
  if (!job) return null;
  if (job.status !== "running") return job;

  job.cancelRequested = true;
  if (active?.controller) active.controller.abort();

  const currentStep = job.steps[job.currentStepIndex ?? 0];
  const lastRunId = currentStep?.runIds?.[currentStep.runIds.length - 1];
  if (lastRunId) await getRunManager().stopRun(lastRunId);

  job.status = "cancelled";
  job.endedAt = new Date().toISOString();
  await persistJob(job);
  return job;
}

export async function retrySetupJob(id) {
  if (runningJobId && runningJobId !== id) {
    throw jobError("job_already_running", "A different setup job is already running.");
  }
  // Claim the lock before the first await (unless this very job holds it).
  const claim = runningJobId === id ? null : claimJobLock();
  try {
    return await retrySetupJobLocked(id);
  } finally {
    if (claim && runningJobId === claim) runningJobId = null;
  }
}

async function retrySetupJobLocked(id) {
  const stored = await loadJob(id);
  if (!stored) return null;
  if (stored.status === "running") return stored;

  // A download restarts from the top; Ollama keeps the layers it already has,
  // so it picks up where it left off.
  if (stored.kind === "pull") return startOllamaPullLocked(stored.model);

  const startIndex = stored.steps.findIndex((s) => s.status !== "succeeded");
  if (startIndex === -1) return stored; // nothing left to retry

  // A configure job's API key only ever lived in this module's call stack
  // (see startConfigureJob/runConfigureJobSteps below) and is gone the
  // moment that job reaches a terminal state -- there is nothing left in
  // memory to retry with, so the client must re-POST /configure with the key.
  if (stored.kind === "configure") {
    throw jobError("key_required_for_retry", "Retrying a configure job requires the API key again; POST /configure.");
  }

  stored.status = "running";
  stored.cancelRequested = false;
  stored.endedAt = null;
  stored.steps[startIndex].status = "pending";
  stored.steps[startIndex].error = null;
  await persistJob(stored);
  runningJobId = id;
  runJobSteps(stored, startIndex).catch(() => {});
  return stored;
}

// =========================================================================
// The brain/configure job: sets a model provider, safe defaults, always-on
// services, and a health check. Distinct step list from the install job
// above, but shares the same persistence, cancel, and single-job-at-a-time
// machinery (jobsDir()/persistJob()/activeJobs/runningJobId).
// =========================================================================

const CONFIGURE_RUN_TIMEOUT_MS = 60 * 1000;
const HELP_TIMEOUT_MS = 5000;
const CONFIG_GET_TIMEOUT_MS = 10 * 1000;
const HEALTH_PROMPT = "Reply with exactly: ready";

function agentInstalled(check, agentId) {
  return Boolean(check?.agents?.[agentId]?.detected?.installed);
}

function makeConfigureStep(id, agentId, action) {
  return { id, agentId, action, status: "pending", runIds: [], error: null, log: [], warnings: [] };
}

// Runs one plan to completion as part of a configure step, recording its run
// id on the step and throwing if it didn't succeed. Mirrors runInstallerOnce
// above but for the smaller, single-command configure/service plans.
async function runConfigureCommand(manager, plan, step, { optional = false } = {}) {
  const run = await manager.startRun(plan);
  step.runIds.push(run.id);
  const finished = await waitForRunEnd(manager, run.id);
  const stdout = await runStdout(manager, run.id);
  if (finished.status !== "succeeded" && !optional) {
    throw jobError("configure_failed", `${plan.title} failed; see the run log.`);
  }
  return { run: finished, stdout };
}

// How the OpenRouter key reaches Hermes (checked against `hermes auth add
// --help` and `hermes config set --help`, Hermes 0.x, 2026-10-03). Most
// private first:
//   1. `auth add` WITHOUT --api-key. The help says the key is then "prompted
//      securely". On macOS and Linux our child process has no terminal (spawn
//      detaches it into its own session), so that prompt reads one line from
//      standard input: the key travels through a private pipe and never shows
//      up in `ps`. This is the only place we depend on behaviour the help text
//      doesn't spell out, so if it fails for any reason we fall back to (2)
//      and say so in the step log. On WINDOWS this is skipped entirely: a
//      Windows console prompt reads the console, not standard input, so the
//      attempt would only hang until its timeout. Windows goes straight to (2).
//   2. `auth add --api-key <key>`: the key is a command-line argument, which
//      other programs on this computer can read for the second or two the
//      command runs. KNOWN LIMITATION: Hermes offers no env-variable or
//      stdin flag for this.
//   3. Older Hermes without --api-key: `config set OPENROUTER_API_KEY <key>`,
//      same limitation (the value is a positional argument).
const PROMPT_ATTEMPT_TIMEOUT_MS = 20 * 1000;

// Which of the three ways above applies: "config-set" (old Hermes, no
// --api-key), "api-key" (Windows: no private prompt), or "prompt-then-api-key".
export function hermesKeyStrategy({ platform = process.platform, authHelpText = "" } = {}) {
  if (!/--api-key\b/.test(String(authHelpText))) return "config-set";
  return platform === "win32" ? "api-key" : "prompt-then-api-key";
}

async function addHermesOpenRouterKey(run, step, ctx, authHelpText) {
  const redact = [ctx.apiKey];
  const strategy = hermesKeyStrategy({ authHelpText });
  if (strategy === "config-set") {
    timestampedLog(step, "hermes auth add --api-key is unavailable on this version; used config set OPENROUTER_API_KEY.");
    await run("hermes config set OPENROUTER_API_KEY", ["config", "set", "OPENROUTER_API_KEY", ctx.apiKey], { redact });
    return;
  }
  // --label also stops Hermes from asking for a label on a second prompt.
  const base = ["auth", "add", "openrouter", "--type", "api-key", ...(/--label\b/.test(authHelpText) ? ["--label", "Agent OS"] : [])];
  if (strategy === "api-key") {
    timestampedLog(
      step,
      "On Windows Hermes can't take the key through a private prompt, so it is passed with --api-key (briefly visible to other programs on this computer). Known limitation."
    );
    await run("hermes auth add openrouter", [...base, "--api-key", ctx.apiKey], { redact });
    return;
  }
  const prompted = await run("hermes auth add openrouter (private prompt)", base, {
    redact,
    stdin: `${ctx.apiKey}\n`,
    timeoutMs: PROMPT_ATTEMPT_TIMEOUT_MS,
    optional: true
  });
  if (prompted.run.status === "succeeded") {
    timestampedLog(step, "Hermes took the key from a private prompt, not from the command line.");
    return;
  }
  timestampedLog(
    step,
    "This Hermes version did not take the key from its private prompt; used --api-key instead (briefly visible to other programs on this computer)."
  );
  await run("hermes auth add openrouter", [...base, "--api-key", ctx.apiKey], { redact });
}

async function configureHermesBrain(step, check, ctx, manager) {
  const detected = check.agents.hermes.detected;
  const target = ctx.targets.hermes;
  const authHelp = await runCommand(detected.path, ["auth", "add", "--help"], HELP_TIMEOUT_MS);
  const authHelpText = `${authHelp.stdout}\n${authHelp.stderr}`;

  const run = (title, args, extra = {}) =>
    runConfigureCommand(
      manager,
      {
        agentId: "hermes",
        kind: "configure",
        title,
        command: detected.path,
        args,
        cwd: os.tmpdir(),
        redact: extra.redact || [],
        timeoutMs: extra.timeoutMs || CONFIGURE_RUN_TIMEOUT_MS,
        ...(typeof extra.stdin === "string" ? { stdin: extra.stdin } : {})
      },
      step,
      { optional: extra.optional === true }
    );

  if (target.mode === "openrouter") {
    await addHermesOpenRouterKey(run, step, ctx, authHelpText);
    await run("hermes config set model.provider", ["config", "set", "model.provider", "openrouter"]);
    await run("hermes config set model.default", ["config", "set", "model.default", target.model]);
  } else {
    // Hermes uses Ollama's OpenAI-style /v1 endpoint, which cannot ask for a
    // bigger context window per request. So it is pointed at the 64K COPY of
    // the model (see prepareLocalVariants), and told the same size, because
    // Hermes refuses models it believes have under 64K.
    const variant = ctx.variants[target.model];
    await run("hermes config set model.provider", ["config", "set", "model.provider", "custom"]);
    await run("hermes config set model.base_url", ["config", "set", "model.base_url", `${ollamaBaseUrl().replace("127.0.0.1", "localhost")}/v1`]);
    await run("hermes config set model.default", ["config", "set", "model.default", variant]);
    await run("hermes config set model.context_length", ["config", "set", "model.context_length", String(LOCAL_CONTEXT_TOKENS)]);
  }
}

async function configureOpenclawBrain(step, check, ctx, manager) {
  const detected = check.agents.openclaw.detected;
  const target = ctx.targets.openclaw;
  const help = await runCommand(detected.path, ["onboard", "--help"], HELP_TIMEOUT_MS);
  const helpText = `${help.stdout}\n${help.stderr}`;

  for (const flag of ["--non-interactive", "--accept-risk", "--auth-choice"]) {
    if (!helpText.includes(flag)) {
      throw jobError("configure_failed", `This OpenClaw version's "onboard" command has no ${flag} flag.`);
    }
  }

  // KNOWN LIMITATION: `openclaw onboard --help` (2026.9.6) offers the key
  // only as `--openrouter-api-key <key>`, so it is a command-line argument,
  // visible to other programs on this computer for the second or two the
  // command runs. There is no env-variable or stdin option, and
  // `--secret-input-mode ref` only stores a pointer to an env variable that
  // OpenClaw's background gateway would not have, so it can't be used here.
  // Ollama is reached at its native API (no /v1); OpenClaw's docs note that
  // the OpenAI-compatible /v1 path makes tool calling unreliable.
  const args = target.mode === "ollama"
    ? ["onboard", "--non-interactive", "--accept-risk", "--auth-choice", "ollama", "--custom-base-url", ollamaBaseUrl()]
    : ["onboard", "--non-interactive", "--accept-risk", "--auth-choice", "openrouter-api-key", "--openrouter-api-key", ctx.apiKey];
  for (const flag of ["--skip-health", "--skip-channels", "--skip-skills", "--skip-ui", "--install-daemon"]) {
    if (helpText.includes(flag)) {
      args.push(flag);
    } else {
      timestampedLog(step, `openclaw onboard --help does not list ${flag}; skipped.`);
    }
  }

  await runConfigureCommand(
    manager,
    {
      agentId: "openclaw",
      kind: "configure",
      title: "openclaw onboard",
      command: detected.path,
      args,
      cwd: os.tmpdir(),
      redact: target.mode === "openrouter" && ctx.apiKey ? [ctx.apiKey] : [],
      timeoutMs: CONFIGURE_RUN_TIMEOUT_MS
    },
    step
  );

  await runConfigureCommand(
    manager,
    {
      agentId: "openclaw",
      kind: "configure",
      title: "openclaw models set",
      command: detected.path,
      // A local model is the 64K copy (see prepareLocalVariants), so OpenClaw
      // gets the same working memory as Hermes.
      args: ["models", "set", target.mode === "ollama" ? `ollama/${ctx.variants[target.model]}` : `openrouter/${target.model}`],
      cwd: os.tmpdir(),
      timeoutMs: CONFIGURE_RUN_TIMEOUT_MS
    },
    step
  );
}

async function configureOpenclawSafeDefaults(job, step, check, manager) {
  const detected = check.agents.openclaw.detected;
  if (!detected?.installed) {
    return;
  }
  const current = await runCommand(detected.path, ["config", "get", "tools.exec.mode"], CONFIG_GET_TIMEOUT_MS);
  const value = String(current.stdout || "").trim().toLowerCase();
  // Never loosen a stricter setting: only "full" (the permissive default) or
  // an unset value gets tightened.
  if (!value || value === "full") {
    await runConfigureCommand(
      manager,
      {
        agentId: "openclaw",
        kind: "configure",
        title: "openclaw config set tools.exec.mode ask",
        command: detected.path,
        args: ["config", "set", "tools.exec.mode", "ask"],
        cwd: os.tmpdir(),
        timeoutMs: CONFIG_GET_TIMEOUT_MS
      },
      step
    );
    job.execModeChanged = { from: value || "full", to: "ask" };
  } else {
    timestampedLog(step, `tools.exec.mode is already "${value}"; left unchanged.`);
  }

  // Not enabled automatically: OpenClaw's Docker sandbox needs its own image
  // built first (scripts/sandbox-setup.sh), and with sandbox mode on but no
  // image every agent run fails. Seen on a real install; left as a user step.
  timestampedLog(
    step,
    check.tools?.docker?.running
      ? "Docker is available. OpenClaw's sandbox needs its image built first (see OpenClaw's sandboxing docs); left off."
      : "OpenClaw's sandbox needs Docker; left off."
  );
}

async function checkHermesSafeDefaults(step, check) {
  const detected = check.agents.hermes.detected;
  if (!detected?.installed) return;
  const result = await runCommand(detected.path, ["config", "get", "approvals.mode"], CONFIG_GET_TIMEOUT_MS);
  const value = String(result.stdout || "").trim().toLowerCase();
  if (value === "off") {
    step.warnings.push("Hermes approvals are off");
  }
}

// The agents this job is allowed to touch: both for the old request shape,
// only the ticked ones when the request named per-agent `targets`.
function jobScope(job) {
  return Array.isArray(job.scope) ? job.scope : ["hermes", "openclaw"];
}

async function ensureServices(job, step, check, manager) {
  for (const agentId of jobScope(job)) {
    const detected = check.agents[agentId].detected;
    if (!detected?.installed) continue;
    const adapter = ADAPTERS[agentId];
    const status = await adapter.service.status(detected);
    if (status.running) {
      timestampedLog(step, `${agentId}: gateway already running; left it alone.`);
      continue;
    }
    if (agentId === "hermes") {
      await runConfigureCommand(
        manager,
        {
          agentId,
          kind: "configure",
          title: "hermes gateway install",
          command: detected.path,
          args: ["gateway", "install"],
          cwd: os.tmpdir(),
          timeoutMs: CONFIGURE_RUN_TIMEOUT_MS
        },
        step
      );
    }
    await runConfigureCommand(manager, { ...adapter.service.start(detected), kind: "configure" }, step);
    job.servicesStarted = job.servicesStarted || [];
    job.servicesStarted.push(agentId);
    timestampedLog(step, `${agentId}: gateway started.`);
  }
}

// All output of a finished run (both streams), used ONLY to pick a plain-
// English fix line; it is never stored or returned.
async function runAllOutput(manager, id) {
  const events = await manager.readEvents(id, 0);
  return events.map((event) => event.text || "").join("\n");
}

// A short, plain next step for a failed "say hello" check. `target` is the
// brain we just gave that agent.
function healthFixLine(output, target, timedOut) {
  const text = String(output || "");
  if (/\b429\b|rate.?limit|too many requests|free-models-per-day|quota/i.test(text)) {
    return "OpenRouter's free limit was reached (50 requests a day until you add $10 of credit). Try again tomorrow, add credit, or use Local.";
  }
  if (/\b40[13]\b|unauthori[sz]ed|invalid.{0,12}(api )?key|no auth|authentication|credential/i.test(text)) {
    return "The agent didn't accept the key. Connect OpenRouter again and press the button again.";
  }
  if (/econnrefused|enotfound|fetch failed|network|could not resolve|connection (refused|error)/i.test(text)) {
    return target?.mode === "ollama"
      ? "Couldn't reach Ollama. Open the Ollama app and try again."
      : "Couldn't reach OpenRouter. Check your internet connection and try again.";
  }
  if (timedOut) {
    return "The agent didn't answer within a minute. Free models are sometimes busy; try again, or pick another model.";
  }
  if (target?.mode === "ollama") {
    return "This local model didn't answer properly. Try a bigger model, or use OpenRouter.";
  }
  return "The agent didn't reply as expected. Open its run on the Runs page for details, or pick another model.";
}

async function runHealthChecks(job, step, check, manager, ctx) {
  const health = {};
  const workDir = path.join(runtimePaths().root, "setup", "runs-work", "setup-check");
  await fs.mkdir(workDir, { recursive: true });
  for (const agentId of jobScope(job)) {
    const detected = check.agents[agentId].detected;
    if (!detected?.installed) continue;
    const adapter = ADAPTERS[agentId];
    const doctorStatus = await adapter.configStatus(detected);
    const entry = { doctorOk: Boolean(doctorStatus.ok), promptOk: false, replyPreview: "" };
    try {
      const plan = await adapter.buildRun({ prompt: HEALTH_PROMPT, cwd: workDir, detected, runDir: workDir });
      const run = await manager.startRun(plan);
      step.runIds.push(run.id);
      const finished = await waitForRunEnd(manager, run.id);
      const stdout = await runStdout(manager, run.id);
      entry.replyPreview = stdout.slice(0, 80);
      entry.promptOk = finished.status === "succeeded" && /ready/i.test(stdout);
      if (!entry.promptOk) {
        entry.error = finished.error || "The test prompt did not reply with \"ready\".";
        entry.hint = healthFixLine(await runAllOutput(manager, run.id), ctx.targets[agentId], finished.status === "timed_out");
      }
    } catch (error) {
      // A health check failing is a result, not a job failure: it must
      // never throw, so the job still finishes and the UI can show it red.
      entry.error = error?.message || "Health check failed.";
      entry.hint = healthFixLine("", ctx.targets[agentId], false);
    }
    health[agentId] = entry;
  }
  job.health = health;
}

// "Prepare <model> with 64K working memory": makes the settings-only copy of
// each chosen local model through Ollama's POST /api/create (no download, it
// shares the original's weights). Once per model per job, even when both
// agents use it; a copy that already has the 64K setting is reused.
async function prepareLocalVariants(job, step, ctx) {
  for (const base of Object.keys(job.localVariants || {})) {
    timestampedLog(step, `Prepare ${base} with 64K working memory`);
    await persistJob(job);
    const { name, created } = await ensureLocalVariant(base);
    ctx.variants[base] = name;
    timestampedLog(
      step,
      created
        ? `Created ${name}, a settings copy of ${base} (no extra download).`
        : `${name} already has 64K working memory; reused it.`
    );
    const fit = job.localFit?.[base];
    if (fit?.fit === "tight") {
      const warning = `${base} is a tight fit: it needs about ${fit.memoryAt64kGb} GB of memory at 64K and this computer has ${fit.ramGb} GB. Expect it to be slow when other apps are open.`;
      step.warnings.push(warning);
      timestampedLog(step, warning);
    } else if (fit?.fit === "too_big") {
      const warning = `${base} needs about ${fit.memoryAt64kGb} GB of memory at 64K and this computer has ${fit.ramGb} GB. You chose to use it anyway; it may be very slow or fail.`;
      step.warnings.push(warning);
      timestampedLog(step, warning);
    }
  }
}

async function executeConfigureStep(job, step, check, ctx, manager) {
  step.status = "running";
  await persistJob(job);

  if (step.action === "keep" || step.action === "skip-not-installed" || step.action === "skip-not-selected") {
    step.status = "succeeded";
    return;
  }

  switch (step.id) {
    case "local-prepare":
      await prepareLocalVariants(job, step, ctx);
      break;
    case "hermes-brain":
      await configureHermesBrain(step, check, ctx, manager);
      break;
    case "openclaw-brain":
      await configureOpenclawBrain(step, check, ctx, manager);
      break;
    case "openclaw-safe-defaults":
      await configureOpenclawSafeDefaults(job, step, check, manager);
      break;
    case "hermes-safe-defaults":
      await checkHermesSafeDefaults(step, check);
      break;
    case "services":
      await ensureServices(job, step, check, manager);
      break;
    case "health":
      await runHealthChecks(job, step, check, manager, ctx);
      break;
    default:
      break;
  }
  step.status = "succeeded";
}

async function appendConfigureReceipt(job, check) {
  for (const agentId of ["hermes", "openclaw"]) {
    const step = job.steps.find((s) => s.id === `${agentId}-brain`);
    if (!step || step.action !== "configure") continue;
    const target = job.targets?.[agentId] || { mode: job.mode, model: job.model };
    const changes = [`Set the model provider to ${target.mode}`, `Set the model to ${target.model}`];
    const variant = target.mode === "ollama" ? job.localVariants?.[target.model] : null;
    if (variant) {
      changes.push(
        `Added a settings copy named ${variant} to Ollama (no extra download). Remove it any time with \`ollama rm ${variant}\`.`,
        `Gave ${agentId === "hermes" ? "Hermes" : "OpenClaw"} that copy, which has 64K of working memory (num_ctx ${LOCAL_CONTEXT_TOKENS})`
      );
    }
    if (agentId === "openclaw" && job.execModeChanged) {
      changes.push(`tools.exec.mode: ${job.execModeChanged.from} -> ${job.execModeChanged.to}`);
    }
    if (agentId === "openclaw" && job.sandboxEnabled) changes.push("agents.defaults.sandbox.mode: all (Docker detected)");
    if (job.servicesStarted?.includes(agentId)) changes.push("Started the background gateway service");
    await appendReceiptEntry({
      agentId,
      action: "configure",
      version: check.agents[agentId].detected.version,
      provider: target.mode,
      model: target.model,
      changes
    });
  }
}

// Every run a configure job starts goes through this wrapper, which adds the
// key to the run's `redact` list. The key is not in most of those commands,
// but a run's recorded output is scrubbed of it regardless, so a tool that
// echoes its environment can't leak it into a log, an event or the screen.
function redactingManager(manager, ctx) {
  const secrets = ctx.apiKey ? [ctx.apiKey] : [];
  if (!secrets.length) return manager;
  return {
    ...manager,
    startRun: (plan) => manager.startRun({ ...plan, redact: [...(plan.redact || []), ...secrets] })
  };
}

async function runConfigureJobSteps(job, apiKey) {
  // apiKey lives only in this function's call stack (and whatever it calls
  // synchronously below) for the lifetime of this job -- never assigned onto
  // `job`, never passed to persistJob(), never logged.
  activeJobs.set(job.id, { job, controller: null });
  try {
    const check = await systemCheck({ refresh: true });
    const ctx = { apiKey, targets: job.targets, variants: {} };
    const manager = redactingManager(getRunManager(), ctx);
    for (let i = 0; i < job.steps.length; i += 1) {
      const step = job.steps[i];
      if (step.status === "succeeded") continue;
      job.currentStepIndex = i;
      try {
        await executeConfigureStep(job, step, check, ctx, manager);
      } catch (error) {
        step.status = "failed";
        step.error = error?.message || "Configure step failed.";
        job.status = job.cancelRequested ? "cancelled" : "failed";
        job.endedAt = new Date().toISOString();
        await persistJob(job);
        return;
      }
      await persistJob(job);
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.endedAt = new Date().toISOString();
        await persistJob(job);
        return;
      }
    }
    await appendConfigureReceipt(job, check);
    job.status = "succeeded";
    job.endedAt = new Date().toISOString();
    await persistJob(job);
  } finally {
    activeJobs.delete(job.id);
    if (runningJobId === job.id) runningJobId = null;
  }
}

function normalizeTarget(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || (raw.mode !== "openrouter" && raw.mode !== "ollama")) {
    throw jobError("invalid_mode", 'mode must be "openrouter" or "ollama".');
  }
  return { mode: raw.mode, model: typeof raw.model === "string" ? raw.model.trim() : "" };
}

// Two request shapes, one result:
//   old:  { mode, model, apiKey }                         -> both agents, same brain
//   new:  { targets: { hermes?: {mode, model}, openclaw?: {mode, model} } }
//         -> each ticked agent gets its own brain; an agent left out is not
//            touched at all (no brain, no safe-defaults, no hello check).
// The key comes from `apiKey` (the "paste a key" path) or from `keySource`
// ({ flowId } of a connected OpenRouter sign-in, used exactly once).
export function startConfigureJob(options) {
  return withJobLock(() => startConfigureJobLocked(options));
}

async function startConfigureJobLocked({
  mode,
  apiKey,
  keySource,
  model,
  targets,
  reconfigure = {},
  acceptOpenClawRisk = false,
  acceptLocalFit = false
} = {}) {
  const explicit = targets !== undefined && targets !== null;
  let resolved;
  if (explicit) {
    if (typeof targets !== "object") throw jobError("invalid_mode", "targets must be an object.");
    resolved = { hermes: normalizeTarget(targets.hermes), openclaw: normalizeTarget(targets.openclaw) };
    if (!resolved.hermes && !resolved.openclaw) {
      throw jobError("no_targets", "Pick at least one agent to give a brain to.");
    }
  } else {
    const shared = normalizeTarget({ mode, model });
    resolved = { hermes: shared, openclaw: shared };
  }

  const check = await systemCheck({ refresh: true });
  const brain = await currentBrain(check);
  const reconfigureFlags = reconfigure && typeof reconfigure === "object" ? reconfigure : {};

  // An agent that is installed AND (old shape: always | new shape: ticked).
  const inScope = (agentId) => agentInstalled(check, agentId) && Boolean(resolved[agentId]);
  // Naming an agent in `targets` IS the person's explicit choice to change
  // its brain, so it counts as reconfigure:true; the old shape still keeps
  // an agent that already works unless reconfigure says otherwise.
  const brainAction = (agentId) => {
    if (!agentInstalled(check, agentId)) return "skip-not-installed";
    if (!resolved[agentId]) return "keep";
    if (explicit) return "configure";
    return brain[agentId].configured && reconfigureFlags[agentId] !== true ? "keep" : "configure";
  };
  const hermesAction = brainAction("hermes");
  const openclawAction = brainAction("openclaw");
  const defaultsAction = (agentId) =>
    !agentInstalled(check, agentId) ? "skip-not-installed" : inScope(agentId) ? "run" : "skip-not-selected";

  if (openclawAction === "configure" && acceptOpenClawRisk !== true) {
    throw jobError("openclaw_risk_not_accepted", "OpenClaw brain configuration requires acceptOpenClawRisk:true.");
  }
  for (const [agentId, action] of [["hermes", hermesAction], ["openclaw", openclawAction]]) {
    if (action === "configure" && !resolved[agentId].model) {
      throw jobError("invalid_model", "Choose a model first.");
    }
  }

  // Local models: each one chosen gets a 64K "working memory" copy (made in
  // the local-prepare step). The server works out for ITSELF whether the model
  // fits this computer, never trusting the screen, and refuses a model that is
  // too big unless the person explicitly accepted that. This happens before any
  // command runs and before the OpenRouter key is touched.
  const localBases = [
    ...new Set(
      [["hermes", hermesAction], ["openclaw", openclawAction]]
        .filter(([agentId, action]) => action === "configure" && resolved[agentId].mode === "ollama")
        .map(([agentId]) => resolved[agentId].model)
    )
  ];
  const localVariants = {};
  const localFit = {};
  if (localBases.length) {
    const installed = await listLocalModels(check, { refresh: true });
    const ramGb = Math.round((Number(check?.ramGb) || 0) * 10) / 10;
    for (const base of localBases) {
      const variant = localVariantName(base);
      if (!variant) {
        throw jobError(
          "invalid_variant_name",
          `Can't make a 64K copy of "${base.slice(0, 60)}": its name has characters Agent OS can't use for the copy. Pick another model, or use OpenRouter.`
        );
      }
      localVariants[base] = variant;
      const row = installed.find((m) => m.name === base);
      if (row && row.memory.fit !== "unknown") {
        localFit[base] = { fit: row.memory.fit, memoryAt64kGb: row.memory.memoryAt64kGb, ramGb };
        if (row.memory.fit === "too_big" && acceptLocalFit !== true) {
          throw jobError(
            "local_model_too_big",
            `${base} needs about ${row.memory.memoryAt64kGb} GB of memory for the 64K working memory agents need, and this computer has ${ramGb} GB. Tick "Use it anyway" to try it; it may be very slow or fail.`
          );
        }
      }
    }
  }

  // Only now (nothing else can refuse the request any more) is the key taken
  // out of the sign-in. It stays in this function's call stack, never on `job`.
  const needsKey = [["hermes", hermesAction], ["openclaw", openclawAction]].some(
    ([agentId, action]) => action === "configure" && resolved[agentId].mode === "openrouter"
  );
  let key = typeof apiKey === "string" && apiKey.trim() ? apiKey : "";
  if (needsKey && !key) {
    if (keySource && typeof keySource === "object" && typeof keySource.flowId === "string") {
      key = takeKey(keySource.flowId) || "";
      if (!key) throw jobError("key_unavailable", "That OpenRouter connection is no longer available. Connect again.");
    } else {
      throw jobError("key_required", "An OpenRouter key is required.");
    }
  }

  const steps = [
    ...(localBases.length ? [makeConfigureStep("local-prepare", null, "run")] : []),
    makeConfigureStep("hermes-brain", "hermes", hermesAction),
    makeConfigureStep("openclaw-brain", "openclaw", openclawAction),
    makeConfigureStep("openclaw-safe-defaults", "openclaw", defaultsAction("openclaw")),
    makeConfigureStep("hermes-safe-defaults", "hermes", defaultsAction("hermes")),
    makeConfigureStep("services", null, "run"),
    makeConfigureStep("health", null, "run")
  ];

  const sameBrain =
    resolved.hermes &&
    resolved.openclaw &&
    resolved.hermes.mode === resolved.openclaw.mode &&
    resolved.hermes.model === resolved.openclaw.model;
  const only = resolved.hermes || resolved.openclaw;
  const id = generateJobId();
  const job = {
    id,
    kind: "configure",
    status: "running",
    // Kept for older clients: the shared brain, or "mixed" when they differ.
    mode: sameBrain || !(resolved.hermes && resolved.openclaw) ? only.mode : "mixed",
    model: sameBrain || !(resolved.hermes && resolved.openclaw) ? only.model || null : null,
    targets: { hermes: resolved.hermes, openclaw: resolved.openclaw },
    scope: ["hermes", "openclaw"].filter(inScope),
    // base model -> the 64K copy that agents are pointed at (ollama only)
    localVariants,
    localFit,
    acceptLocalFit: Object.values(localFit).some((f) => f.fit === "too_big") && acceptLocalFit === true,
    steps,
    startedAt: new Date().toISOString(),
    endedAt: null,
    acceptOpenClawRisk: openclawAction === "configure",
    acceptOpenClawRiskAt: openclawAction === "configure" ? new Date().toISOString() : null
  };
  await persistJob(job);
  runningJobId = id;
  runConfigureJobSteps(job, key).catch(() => {});
  return job;
}

// =========================================================================
// Downloading a local model (Ollama). Same machinery as the other jobs --
// one at a time, saved to disk, cancelable -- with one step and real byte
// counts instead of a guess.
// =========================================================================

const PULL_PERSIST_EVERY_MS = 2000;

async function runPullJob(job) {
  const controller = new AbortController();
  activeJobs.set(job.id, { job, controller });
  const step = job.steps[0];
  let lastPersist = 0;
  // Saves go one after another, so a slow progress save can never land AFTER
  // (and overwrite) the final one.
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(() => persistJob(job)).catch(() => {});
    return saving;
  };
  let finalStatus = "failed";
  try {
    await streamOllamaPull(job.model, {
      signal: controller.signal,
      onProgress: (progress) => {
        job.pull = progress;
        const now = Date.now();
        if (now - lastPersist >= PULL_PERSIST_EVERY_MS) {
          lastPersist = now;
          void save();
        }
      }
    });
    step.status = "succeeded";
    finalStatus = "succeeded";
    clearSystemCheckCache();
    clearLocalModelsCache(); // the new model must show up in the list straight away
  } catch (error) {
    step.status = "failed";
    if (job.cancelRequested || controller.signal.aborted) {
      step.error = "Cancelled.";
      finalStatus = "cancelled";
    } else {
      step.error = error?.message || "The download failed.";
    }
  }
  // Write the final state to disk first, THEN make it visible and free the
  // one-job-at-a-time lock in the same breath: whoever sees "succeeded" can
  // start the next job straight away without a spurious "already running".
  job.endedAt = new Date().toISOString();
  await saving; // any progress save still in flight lands first
  await persistJob({ ...job, status: finalStatus }).catch(() => {});
  job.status = finalStatus;
  activeJobs.delete(job.id);
  if (runningJobId === job.id) runningJobId = null;
}

export async function startOllamaPull({ model } = {}) {
  const name = typeof model === "string" ? model.trim() : "";
  if (!OLLAMA_MODEL_NAME_PATTERN.test(name)) {
    throw jobError("invalid_model", "That doesn't look like a valid Ollama model name.");
  }
  // A download the person just cancelled needs a moment to hang up; starting
  // the next one straight away should wait for that, not fail.
  const deadline = Date.now() + 2000;
  while (runningJobId && activeJobs.get(runningJobId)?.job.cancelRequested && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return withJobLock(() => startOllamaPullLocked(name));
}

async function startOllamaPullLocked(name) {
  const id = generateJobId();
  const job = {
    id,
    kind: "pull",
    status: "running",
    model: name,
    pull: { status: "starting", completed: 0, total: 0 },
    steps: [{ id: "ollama-pull", agentId: null, action: "pull", status: "running", runIds: [], error: null, log: [] }],
    startedAt: new Date().toISOString(),
    endedAt: null
  };
  await persistJob(job);
  runningJobId = id;
  runPullJob(job).catch(() => {});
  return job;
}

// Test-only: lets a suite reset the concurrency lock between cases without
// waiting for a job to naturally finish.
export function resetSetupJobsForTest() {
  activeJobs.clear();
  runningJobId = null;
}
