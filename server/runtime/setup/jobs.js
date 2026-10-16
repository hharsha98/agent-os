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
import { hermesApprovalsAreOff } from "../agents/hermes.js";
import { clearDetectCaches } from "../agents/detect.js";
import { isExecutionEnabled } from "../execution-gate.js";
import { getRunManager } from "../runs/run-manager.js";
import { runCommand, which } from "../safety.js";
import { readJson, runtimePaths, writeJson } from "../store.js";
import { agentGroup, getInstallRecipe } from "./recipes.js";
import { ensureManagedNode, nodeSatisfiesCodex, npmLaunch } from "./managed-node.js";
import { ALL_PLAN_AGENT_IDS, buildSetupPlan, setupOffersUpdate } from "./plan.js";
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
import {
  MODEL_ID_PATTERN,
  OPENCLAW_MODEL_PATH,
  cleanCliText,
  hermesModelCommands,
  openclawModelRef,
  openclawOverrideWarnings,
  configTextIsUnset,
  parseConfigText,
  parseJsonOutput,
  readAgentModel
} from "./models.js";
import {
  CHATGPT_EXPIRING,
  CHATGPT_NOT_READY,
  CURRENT_MODEL_NOT_RESTORABLE,
  CURRENT_MODEL_UNREADABLE,
  MODEL_SETTINGS_UNREADABLE,
  OPENCLAW_PLANS,
  PLAN_HEALTH_LINES,
  PLAN_JOB_INTERRUPTED,
  PLAN_MODE,
  PLAN_NOT_READY_MESSAGE,
  PLAN_PROVIDER,
  PLAN_READ_TIMEOUT_MS,
  RUNTIME_CHECK_FAILED,
  claudeCliPinned,
  claudePlanReadiness,
  noEarlierPrimary,
  readDidNotFinish
} from "./openclaw-plan-rules.js";
import { readChatgptAuth, readChatgptReadiness, readOpenclawModelsConfig, resolvePlanModel } from "./openclaw-plans.js";
import { takeKey } from "./openrouter-oauth.js";
import { signInStatus } from "./signin.js";

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

// How long a retry waits for a job that has just ended to finish saving.
const JOB_SETTLE_TIMEOUT_MS = 5000;

// A job that has just ended keeps its in-memory entry (and the job lock) until
// its final save has reached the disk. A retry in that moment would read the
// older saved copy, which still says "running", so wait for the entry to go.
async function waitForJobToSettle(id) {
  const deadline = Date.now() + JOB_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const active = activeJobs.get(id);
    if (!active || active.job.status === "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

// ---- the coding agents' live log and plain failure reasons ---------------------
// Hermes and OpenClaw keep their installer's output in the run only; for Claude
// Code, Codex and Cursor the installer's lines are copied into the step's log as
// they arrive, so the Install screen shows what is really happening. An update
// step does the same for every agent: the updater's own words (a question it
// asked, a warning) are the reason the update stopped, so the person sees them.

const MAX_STEP_LOG_LINES = 400;
const MAX_LOG_LINE_CHARS = 300;

const isCodingAgent = (agentId) => agentGroup(agentId) === "coding";
const showsRunOutput = (agentId, action) => isCodingAgent(agentId) || action === "update";

// Copies a run's output lines into step.log (the run manager already removed
// colour codes and secrets). Events seen twice -- once while catching up, once
// live -- are skipped by their sequence number. Returns a function that stops it.
async function mirrorRunOutput(manager, runId, step) {
  const seen = new Set();
  const add = (event) => {
    if (event?.type !== "line" || typeof event.text !== "string" || !event.text.trim()) return;
    if (seen.has(event.seq)) return;
    seen.add(event.seq);
    timestampedLog(step, event.text.trim().slice(0, MAX_LOG_LINE_CHARS));
    if (step.log.length > MAX_STEP_LOG_LINES) step.log.splice(0, step.log.length - MAX_STEP_LOG_LINES);
  };
  const unsubscribe = manager.subscribe(runId, add);
  for (const event of await manager.readEvents(runId, 0)) add(event);
  return unsubscribe;
}

async function waitForInstallRun(manager, runId, step, agentId) {
  const stop = showsRunOutput(agentId, step.action) ? await mirrorRunOutput(manager, runId, step) : () => {};
  try {
    return await waitForRunEnd(manager, runId);
  } finally {
    stop();
  }
}

// The plain-English reason an installer stopped, from the last lines it printed.
// For the coding agents and for any update step; the older install recipes keep
// their short generic reason.
async function describeInstallFailure(manager, runId, label, agentId, action) {
  const generic = "installer reported a failure; see the log";
  if (!showsRunOutput(agentId, action)) return generic;
  const events = await manager.readEvents(runId, 0);
  const lines = events.filter((e) => e.type === "line" && typeof e.text === "string" && e.text.trim()).map((e) => e.text.trim());
  const tail = lines.slice(-12).join("\n");
  const known = [
    [/do not run this installer with sudo/i, `${label} must not be installed with sudo; Agent OS runs it as you`],
    [
      /could not resolve host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network is unreachable|failed to connect|download failed|curl: \(\d+\)/i,
      `could not download ${label}; check your internet connection and try again`
    ],
    [/checksum/i, `the ${label} download failed its checksum check, so nothing was installed`],
    [/EACCES|EPERM|permission denied/i, `a folder ${label} needs could not be written to (permission denied)`],
    [/ENOSPC|no space left/i, "the disk is full"]
  ].find(([pattern]) => pattern.test(tail));
  if (known) return known[1];
  const last = lines[lines.length - 1];
  return last ? `${generic}. Last line: ${last.slice(0, 160)}` : generic;
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
  const finalRun = await waitForInstallRun(manager, run.id, step, agentId);
  const stdout = await runStdout(manager, run.id);
  return { run: finalRun, stdout };
}

async function runPlainInstall(agentId, recipe, filePath, step, managedNodeBinDir) {
  const { run } = await runInstallerOnce(agentId, recipe, filePath, recipe.args, managedNodeBinDir, step);
  if (run.status === "timed_out") throw jobError("install_failed", "took longer than 30 minutes");
  if (run.status !== "succeeded") {
    throw jobError("install_failed", await describeInstallFailure(getRunManager(), run.id, recipe.label, agentId));
  }
}

// Where npm puts a global install when told to use a folder of the person's
// own (never a system folder, so no admin password): next to Agent OS's own
// Node when that is the one in use, otherwise the usual user-level npm folder.
function npmPrefixFor(node) {
  if (node.source === "managed") return process.platform === "win32" ? node.binDir : path.dirname(node.binDir);
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm")
    : path.join(os.homedir(), ".npm-global");
}

// The Node Codex will be installed with: the one the job's own "Set up a Node 24
// runtime" step produced, or -- when the plan saw no need for that step -- the
// Node 22+ already on this computer.
async function nodeForNpmInstall(job, agentId) {
  const prepared = job.steps.find((s) => s.agentId === agentId && s.action === "prereq-node")?.managedNode;
  if (prepared?.binDir) return prepared;
  const found = await which("node");
  if (found) {
    const result = await runCommand(found, ["--version"], 5000);
    const version = (result.stdout || result.stderr || "").trim();
    if (nodeSatisfiesCodex(version)) return { source: "system", version, binDir: path.dirname(found) };
  }
  throw jobError("install_failed", "Codex needs Node 22 or newer, and none was found. Run Setup's plan again to add one.");
}

// Codex: `npm install -g @openai/codex --prefix <your folder>`, run through the
// npm that came with a Node 22+ (Agent OS's own when it had to fetch one).
async function runNpmInstall(job, step, recipe) {
  const node = await nodeForNpmInstall(job, step.agentId);
  const prefix = npmPrefixFor(node);
  const { command, args: leading } = npmLaunch(node.binDir);
  timestampedLog(step, `Installing ${recipe.npmPackage} into ${prefix.replace(os.homedir(), "~")} with Node ${node.version}`);
  await persistJob(job);

  const manager = getRunManager();
  const run = await manager.startRun({
    agentId: step.agentId,
    kind: "install",
    title: `${recipe.label} installer`,
    command,
    args: [...leading, "install", "-g", recipe.npmPackage, "--prefix", prefix],
    cwd: os.tmpdir(),
    env: {
      ...installerEnv(step.agentId, node.binDir),
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_AUDIT: "false"
    },
    timeoutMs: INSTALL_TIMEOUT_MS
  });
  step.runIds.push(run.id);
  const finished = await waitForInstallRun(manager, run.id, step, step.agentId);
  if (finished.status === "timed_out") throw jobError("install_failed", "took longer than 30 minutes");
  if (finished.status !== "succeeded") {
    throw jobError("install_failed", await describeInstallFailure(manager, run.id, recipe.label, step.agentId));
  }
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
        // Each agent judges the Node by its own rule (OpenClaw 24.16+, Codex 22+).
        ...(step.agentId === "codex" ? { accepts: nodeSatisfiesCodex } : {}),
        onProgress: (message) => {
          timestampedLog(step, message);
          persistJob(job).catch(() => {});
        }
      });
      step.managedNode = result;
      if (step.agentId === "openclaw") job.managedNode = result;
      step.status = "succeeded";
    } finally {
      if (active) active.controller = null;
    }
    return;
  }

  const recipe = getInstallRecipe(step.agentId, check.os, check.arch);
  const adapter = ADAPTERS[step.agentId];

  // Belt and braces for "never reinstall over an existing install": the plan
  // only offers an install for an agent that was not found, but the person (or
  // an earlier try of this very job) may have put it there since. Looked at
  // again right before anything is downloaded; only an Update ever replaces it.
  if (step.action === "install" && isCodingAgent(step.agentId)) {
    const existing = await adapter.detect({ refresh: true });
    if (existing.installed) {
      timestampedLog(step, `${recipe.label}${existing.version ? ` ${existing.version}` : ""} is already installed; kept as it is.`);
      step.status = "succeeded";
      return;
    }
  }

  // Hermes is never installed over an existing copy. Retry resumes a stored job,
  // so look again first. Fail in plain words instead of claiming success: a
  // half-finished earlier try can leave a copy that only looks installed.
  if (step.action === "install" && step.agentId === "hermes") {
    const existing = await adapter.detect({ refresh: true });
    if (existing.installed) {
      throw jobError(
        "install_failed",
        "Hermes is already installed, so Agent OS did not run its installer again. Nothing was changed. Press Check again to see it."
      );
    }
  }

  if (step.action === "update") {
    // A job saved before an agent's update was withdrawn can still hold that
    // step, and Retry resumes the stored steps. Refuse it before anything is
    // detected or started, so the updater never runs.
    if (!setupOffersUpdate(step.agentId)) {
      throw jobError("install_failed", "Agent OS no longer updates Hermes from Setup, so this step was not run. Nothing was changed.");
    }
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
    const finished = await waitForInstallRun(manager, run.id, step, step.agentId);
    if (finished.status === "timed_out") throw jobError("install_failed", "took longer than 30 minutes");
    if (finished.status !== "succeeded") {
      throw jobError("install_failed", await describeInstallFailure(manager, run.id, recipe.label, step.agentId, step.action));
    }
  } else if (step.action === "install" && recipe.npmPackage) {
    await runNpmInstall(job, step, recipe);
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
  // Every group's steps are valid here; the screen sends one group per click.
  const plan = buildSetupPlan(check, { agents: ALL_PLAN_AGENT_IDS });
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
  const stored = await loadJob(id);
  // A plan job saved as "running" that this process isn't running: Agent OS
  // quit while it ran (a plan job is in activeJobs before its first save).
  if (stored?.plan && stored.status === "running") return markPlanJobInterrupted(stored);
  return stored;
}

// Answered, and saved, as failed with a plain sentence, so the card stops
// waiting and offers Apply again (Review Focus 5). Plan jobs only: every other
// job keeps today's answer.
async function markPlanJobInterrupted(job) {
  return failPlanJob(job, PLAN_JOB_INTERRUPTED);
}

// Ends a plan job with `message` on the step that did not finish, and saves
// it. The sentence goes on the one saved as running, else the first one not
// succeeded. currentStepIndex can still point at a step that succeeded
// (runConfigureJobSteps saves step i as succeeded before step i + 1 as
// running), so it is only the fallback for a job whose every step succeeded
// (Agent OS quit, or the receipt could not be saved, after the last step).
// Used for a job Agent OS quit during (PLAN_JOB_INTERRUPTED) and for a job
// whose runner failed outside any step (that error's own message), so the
// second is never read back as the first.
async function failPlanJob(job, message, status = "failed") {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  let current = steps.findIndex((step) => step.status === "running");
  if (current < 0) current = steps.findIndex((step) => step.status !== "succeeded");
  if (current < 0) {
    current = Number.isInteger(job.currentStepIndex) && steps[job.currentStepIndex] ? job.currentStepIndex : steps.length - 1;
  }
  const step = steps[current];
  if (step) {
    step.status = "failed";
    step.error = message;
  }
  job.status = status;
  job.endedAt = job.endedAt || new Date().toISOString();
  await persistJob(job).catch(() => {});
  return job;
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

  // A plan job answers once the step in progress has settled, so the card's
  // re-read of OpenClaw's model sees the final state. Until then the job still
  // reads "running" (the card's poll must not take it as ended early); its
  // runner writes "cancelled" itself when it stops. A run was stopped above;
  // what is left is a read that can't be stopped (at most PLAN_READ_TIMEOUT_MS).
  if (job.plan && active) {
    const deadline = Date.now() + PLAN_CANCEL_SETTLE_MS;
    while (activeJobs.has(id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (job.status !== "running") return job;
  }
  job.status = "cancelled";
  job.endedAt = new Date().toISOString();
  await persistJob(job);
  return job;
}

export async function retrySetupJob(id) {
  // This job may have just ended and still be saving its final status.
  if (runningJobId === id) await waitForJobToSettle(id);
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
  if (stored.plan && stored.status === "running" && !activeJobs.has(id)) await markPlanJobInterrupted(stored);
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
  // A model change needs no key (the agent already has it), so it can resume.
  if (stored.kind === "model") runConfigureJobSteps(stored, "").catch(() => {});
  else runJobSteps(stored, startIndex).catch(() => {});
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
const HERMES_AUTH_HELP_TIMEOUT_MS = 15 * 1000;
const CONFIG_GET_TIMEOUT_MS = 10 * 1000;
// How long Cancel on a plan job waits for the step in progress to settle: a
// little more than the longest read that can't be stopped (the readiness
// check, PLAN_READ_TIMEOUT_MS), and under the card's 20 s limit for the answer.
const PLAN_CANCEL_SETTLE_MS = PLAN_READ_TIMEOUT_MS + 2 * 1000;
const HEALTH_PROMPT = "Reply with exactly: ready";
// The "hello" after a model change may take at most this long (a busy free
// model can be slow; the screen then says so instead of waiting for half an hour).
const MODEL_HEALTH_TIMEOUT_MS = 90 * 1000;

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
// Hermes itself is broken when its own `auth add --help` crashes (a Python
// traceback) or answers nothing at all. Say so plainly instead of trying an
// older way to store the key, which would only fail with a confusing error.
export function hermesHelpProblem({ ok = true, stdout = "", stderr = "" } = {}) {
  const text = `${stdout}\n${stderr}`;
  if (/Traceback \(most recent call last\)/.test(text)) {
    const last = text.trim().split(/\r?\n/).filter((line) => line.trim()).pop() || "";
    return `Hermes isn't working: its own command crashed (${last.trim().slice(0, 160)}). Repair Hermes, then try again.`;
  }
  if (!ok && !text.trim()) {
    return "Hermes didn't answer: its own help command failed or timed out. Check that Hermes starts, then try again.";
  }
  return null;
}

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
  // A cold Hermes (a Python start) can take several seconds to print help.
  const authHelp = await runCommand(detected.path, ["auth", "add", "--help"], HERMES_AUTH_HELP_TIMEOUT_MS);
  const problem = hermesHelpProblem(authHelp);
  if (problem) throw jobError("configure_failed", problem);
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

// `openclaw onboard`'s arguments, each flag checked against this OpenClaw's own
// `onboard --help` first: the three it can't work without stop the step, and
// the optional ones are added only when listed (a log line names any skipped).
// `authArgs` is --auth-choice and what that choice needs. One copy for the
// OpenRouter and Local brains and the Claude plan.
async function onboardArgs(step, detected, authArgs) {
  const help = await runCommand(detected.path, ["onboard", "--help"], HELP_TIMEOUT_MS);
  const helpText = `${help.stdout}\n${help.stderr}`;
  for (const flag of ["--non-interactive", "--accept-risk", "--auth-choice"]) {
    if (!helpText.includes(flag)) {
      throw jobError("configure_failed", `This OpenClaw version's "onboard" command has no ${flag} flag.`);
    }
  }
  const args = ["onboard", "--non-interactive", "--accept-risk", ...authArgs];
  for (const flag of ["--skip-health", "--skip-channels", "--skip-skills", "--skip-ui", "--install-daemon"]) {
    if (helpText.includes(flag)) {
      args.push(flag);
    } else {
      timestampedLog(step, `openclaw onboard --help does not list ${flag}; skipped.`);
    }
  }
  return args;
}

async function configureOpenclawBrain(step, check, ctx, manager) {
  const detected = check.agents.openclaw.detected;
  const target = ctx.targets.openclaw;

  // KNOWN LIMITATION: `openclaw onboard --help` (2026.9.6) offers the key
  // only as `--openrouter-api-key <key>`, so it is a command-line argument,
  // visible to other programs on this computer for the second or two the
  // command runs. There is no env-variable or stdin option, and
  // `--secret-input-mode ref` only stores a pointer to an env variable that
  // OpenClaw's background gateway would not have, so it can't be used here.
  // Ollama is reached at its native API (no /v1); OpenClaw's docs note that
  // the OpenAI-compatible /v1 path makes tool calling unreliable.
  const args = await onboardArgs(
    step,
    detected,
    target.mode === "ollama"
      ? ["--auth-choice", "ollama", "--custom-base-url", ollamaBaseUrl()]
      : ["--auth-choice", "openrouter-api-key", "--openrouter-api-key", ctx.apiKey]
  );

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

// Exported for tests. Uses the same off-spellings rule as the Safety screen.
export async function checkHermesSafeDefaults(step, check) {
  const detected = check.agents.hermes.detected;
  if (!detected?.installed) return;
  const result = await runCommand(detected.path, ["config", "get", "approvals.mode"], CONFIG_GET_TIMEOUT_MS);
  if (hermesApprovalsAreOff(result.stdout)) {
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

// Today's network pattern and last sentence, shared by every brain.
const HEALTH_NETWORK_RE = /econnrefused|enotfound|fetch failed|network|could not resolve|connection (refused|error)/i;
const HEALTH_LAST_LINE = "The agent didn't reply as expected. Open its run on the Runs page for details, or pick another model.";

// A short, plain next step for a failed "say hello" check. `target` is the
// brain we just gave that agent. A plan brain (claude-plan, chatgpt-plan) has
// its own lines and never gets an OpenRouter or Ollama sentence (spec
// 2026-10-15, section 5); openrouter and ollama keep today's order and words.
export function healthFixLine(output, target, timedOut) {
  const text = String(output || "");
  const mode = target?.mode;
  if (mode === "claude-plan" || mode === "chatgpt-plan") {
    if (/usage limit|limit reached|rate.?limit|\b429\b|quota/i.test(text)) return PLAN_HEALTH_LINES.usageLimit;
    if (/not (logged|signed) in|\/login|\b401\b|unauthori[sz]ed|expired/i.test(text)) return PLAN_HEALTH_LINES.signedOut;
    if (HEALTH_NETWORK_RE.test(text)) return PLAN_HEALTH_LINES.unreachable[mode];
    if (timedOut) return PLAN_HEALTH_LINES.timedOut;
    return HEALTH_LAST_LINE;
  }
  if (/\b429\b|rate.?limit|too many requests|free-models-per-day|quota/i.test(text)) {
    return "OpenRouter's free limit was reached (50 requests a day until you add $10 of credit). Try again tomorrow, add credit, or use Local.";
  }
  if (/\b40[13]\b|unauthori[sz]ed|invalid.{0,12}(api )?key|no auth|authentication|credential/i.test(text)) {
    return "The agent didn't accept the key. Connect OpenRouter again and press the button again.";
  }
  if (HEALTH_NETWORK_RE.test(text)) {
    return mode === "ollama"
      ? "Couldn't reach Ollama. Open the Ollama app and try again."
      : "Couldn't reach OpenRouter. Check your internet connection and try again.";
  }
  if (timedOut) {
    return "The agent didn't answer within a minute. Free models are sometimes busy; try again, or pick another model.";
  }
  if (mode === "ollama") {
    return "This local model didn't answer properly. Try a bigger model, or use OpenRouter.";
  }
  return HEALTH_LAST_LINE;
}

// Safety on Look only (the execution gate off) starts nothing. The hello check starts the agent (it asks it to
// reply "ready", after running its own doctor command), so at Look only it is skipped and the job says so.
// Writing the model setting is not part of this and keeps its own behaviour. No control runs the check by itself
// afterwards: the person allows running agents in Safety and applies the brain again, so the sentence says that.
// src/ui/agentModelChange.ts keeps a copy for a job that comes back without this hint; test/setup-models.test.js
// checks the two are word for word the same.
export const HELLO_SKIPPED_AT_LOOK_ONLY =
  "Skipped the hello check because Safety is on Look only. Allow running agents in Safety, then apply the brain again to check it.";

async function runHealthChecks(job, step, check, manager, ctx) {
  const health = {};
  if (!(await isExecutionEnabled())) {
    timestampedLog(step, HELLO_SKIPPED_AT_LOOK_ONLY);
    for (const agentId of jobScope(job)) {
      if (!check.agents[agentId].detected?.installed) continue;
      // Not a failure and never a tick: nothing was asked, so there is no answer to judge. `doctorOk` is
      // null for the same reason (the doctor command was not run either).
      health[agentId] = { skipped: true, doctorOk: null, promptOk: false, replyPreview: "", hint: HELLO_SKIPPED_AT_LOOK_ONLY };
    }
    job.health = health;
    return;
  }
  const workDir = path.join(runtimePaths().root, "setup", "runs-work", "setup-check");
  await fs.mkdir(workDir, { recursive: true });
  // After a model change the "hello" must prove the NEW model works, and must
  // not hang for long: OpenClaw gets a conversation of its own (an old one
  // could still be pinned to the previous model) and every agent a short limit.
  // A plan brain is a model change too, so a stuck hello never holds the job
  // lock for half an hour.
  const afterModelChange = job.kind === "model" || Boolean(job.plan);
  for (const agentId of jobScope(job)) {
    const detected = check.agents[agentId].detected;
    if (!detected?.installed) continue;
    const adapter = ADAPTERS[agentId];
    const doctorStatus = await adapter.configStatus(detected);
    const entry = { doctorOk: Boolean(doctorStatus.ok), promptOk: false, replyPreview: "" };
    try {
      const options = afterModelChange && agentId === "openclaw" ? { sessionId: `agentos-check-${crypto.randomBytes(4).toString("hex")}` } : undefined;
      const plan = await adapter.buildRun({ prompt: HEALTH_PROMPT, cwd: workDir, detected, runDir: workDir, ...(options ? { options } : {}) });
      const run = await manager.startRun(
        afterModelChange ? { ...plan, timeoutMs: Math.min(plan.timeoutMs || MODEL_HEALTH_TIMEOUT_MS, MODEL_HEALTH_TIMEOUT_MS) } : plan
      );
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

// ---- changing ONE agent's model (the model picker and OpenRouter presets) ----------
// The agent already has its OpenRouter key, so only the model is set; the job
// then says hello to the agent to prove the new model answers (skipped at Look only).

// Runs one `config set` / `models set`. Resolves { ok, why }, where `why` is
// what the program said, short and plain, when it refused.
async function runModelSetCommand(manager, step, plan) {
  const { run } = await runConfigureCommand(manager, plan, step, { optional: true });
  if (run.status === "succeeded") return { ok: true, why: "" };
  // What the program itself printed (its error text first), not the run's own
  // "Started ..." / "Exited with code" lines.
  const events = await manager.readEvents(step.runIds[step.runIds.length - 1], 0).catch(() => []);
  const printed = (stream) => events.filter((event) => event.stream === stream).map((event) => event.text || "").join("\n");
  return { ok: false, why: cleanCliText(printed("stderr") || printed("stdout")) };
}

// How the read-back warnings end. They used to always point at the hello test, but at Look only that test is
// skipped (see runHealthChecks), so the sentence must not promise it then.
async function whatItReallyUses() {
  return (await isExecutionEnabled())
    ? "The hello test below shows what it really uses."
    : "Safety is on Look only, so no hello test runs to show what it really uses.";
}

async function setHermesModel(job, step, check, ctx, manager) {
  const detected = check.agents.hermes.detected;
  const target = ctx.targets.hermes;
  for (const args of hermesModelCommands(target.model)) {
    const result = await runModelSetCommand(manager, step, {
      agentId: "hermes",
      kind: "configure",
      title: `hermes config set ${args[2]}`,
      command: detected.path,
      args,
      cwd: os.tmpdir(),
      timeoutMs: CONFIGURE_RUN_TIMEOUT_MS
    });
    if (!result.ok) throw jobError("configure_failed", `Hermes didn't accept ${target.model}${result.why ? `: ${result.why}` : "."}`);
  }
  // Hermes doesn't check what it is given, so read it back: a value that did
  // not stick is worth saying out loud.
  const back = await readAgentModel("hermes", detected);
  if (back.known === false) {
    const warning = `Agent OS could not read Hermes's model back to check it. ${await whatItReallyUses()}`;
    step.warnings.push(warning);
    timestampedLog(step, warning);
  } else if (back.model !== target.model) {
    const warning = `Hermes reports its model as ${back.model || "not set"}, not ${target.model}. ${await whatItReallyUses()}`;
    step.warnings.push(warning);
    timestampedLog(step, warning);
  }
}

// What `config get` printed for a whole section (JSON), or null.
async function readOpenclawSection(detected, key) {
  const result = await runCommand(detected.path, ["config", "get", key], CONFIG_GET_TIMEOUT_MS);
  return result.ok ? parseJsonOutput(result.stdout) : null;
}

// Says so when OpenClaw has a setting that would keep it from using the new
// default (an agent with its own model, an allow-list). Never fails the job.
async function warnAboutOpenclawOverrides(step, detected, ref) {
  try {
    const [entries, allow] = await Promise.all([
      readOpenclawSection(detected, "agents.entries"),
      readOpenclawSection(detected, "modelPolicy.allow")
    ]);
    for (const warning of openclawOverrideWarnings(entries, allow, ref)) {
      step.warnings.push(warning);
      timestampedLog(step, warning);
    }
  } catch {
    timestampedLog(step, "Couldn't check whether an OpenClaw agent has its own model.");
  }
}

async function setOpenclawModel(job, step, check, ctx, manager) {
  const detected = check.agents.openclaw.detected;
  const target = ctx.targets.openclaw;
  const ref = openclawModelRef(target.model);
  const set = (title, args) =>
    runModelSetCommand(manager, step, { agentId: "openclaw", kind: "configure", title, command: detected.path, args, cwd: os.tmpdir(), timeoutMs: CONFIGURE_RUN_TIMEOUT_MS });
  const refused = (why) => jobError("configure_failed", `OpenClaw didn't accept ${target.model}${why ? `: ${why}` : "."}`);

  // OpenClaw is strict: it refuses a model it doesn't know. Ask first with
  // --dry-run (nothing is written), so a refusal reads clearly.
  const dryRun = await set(`openclaw config set ${OPENCLAW_MODEL_PATH} (dry run)`, ["config", "set", OPENCLAW_MODEL_PATH, ref, "--dry-run"]);
  if (dryRun.ok) {
    const real = await set(`openclaw config set ${OPENCLAW_MODEL_PATH}`, ["config", "set", OPENCLAW_MODEL_PATH, ref]);
    if (!real.ok) throw refused(real.why);
  } else if (!job.preset) {
    throw refused(dryRun.why);
  } else {
    // A preset ("@preset/<name>") is not a model OpenClaw knows, so its strict
    // check may refuse it; `models set` is the other way to give OpenClaw a model.
    timestampedLog(step, `OpenClaw's config check refused the preset${dryRun.why ? ` (${dryRun.why})` : ""}; trying "openclaw models set".`);
    const fallback = await set("openclaw models set", ["models", "set", ref]);
    if (!fallback.ok) {
      throw jobError("configure_failed", "OpenClaw doesn't accept OpenRouter presets yet. Use Change model to pick a model instead.");
    }
    timestampedLog(step, "openclaw models set took the preset.");
  }
  await warnAboutOpenclawOverrides(step, detected, ref);
  timestampedLog(step, "Chats that already have a model pinned keep it until you send /model default in them.");
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
    case "hermes-model":
      await setHermesModel(job, step, check, ctx, manager);
      break;
    case "openclaw-model":
      await setOpenclawModel(job, step, check, ctx, manager);
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
    case "openclaw-plan-onboard":
      await onboardOpenclawForClaudePlan(job, step, check, manager);
      break;
    case "openclaw-plan-runtime-check":
      await checkClaudePlanRuntime(job, check);
      break;
    case "openclaw-plan-model":
      await setOpenclawPlanModel(job, step, check, manager);
      break;
    case "openclaw-plan-readiness":
      await checkChatgptPlanReadiness(job, step, check, manager);
      break;
    default:
      break;
  }
  step.status = "succeeded";
}

async function appendConfigureReceipt(job, check) {
  if (job.plan) {
    const changes = [`Set the model provider to ${job.mode}`, `Set the model to ${job.model}`];
    if (job.execModeChanged) changes.push(`tools.exec.mode: ${job.execModeChanged.from} -> ${job.execModeChanged.to}`);
    if (job.servicesStarted?.includes("openclaw")) changes.push("Started the background gateway service");
    await appendReceiptEntry({
      agentId: "openclaw",
      action: "configure",
      version: check.agents.openclaw.detected.version,
      provider: job.mode,
      model: job.model,
      changes
    });
    return;
  }
  if (job.kind === "model") {
    const target = job.targets?.[job.agentId];
    if (!target) return;
    await appendReceiptEntry({
      agentId: job.agentId,
      action: "configure",
      version: check.agents[job.agentId].detected.version,
      provider: "openrouter",
      model: target.model,
      changes: [
        `Changed the model to ${target.model}${job.previous?.model ? ` (it was ${job.previous.model})` : ""}`,
        ...(job.preset ? [`Follows your OpenRouter preset ${job.preset}; change it on openrouter.ai and the agent follows`] : [])
      ]
    });
    return;
  }
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
      // Cancel pressed before this step started (the first pass is right after
      // the system check): it and the steps after it stay pending, and never run.
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.endedAt = new Date().toISOString();
        await persistJob(job);
        return;
      }
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
  } catch (error) {
    // The runner failed outside any step (the system check, a save, the
    // receipt). A plan job still running is ended here with this error's own
    // message and saved, so a later read never takes it for a job Agent OS
    // quit during (getSetupJob). Any other job keeps today's behaviour.
    if (!job.plan || job.status !== "running") throw error;
    await failPlanJob(job, error?.message || "Configure step failed.", job.cancelRequested ? "cancelled" : "failed");
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
// Changing ONE agent's model (the model picker, or an OpenRouter preset).
// Same machinery as the configure job: one at a time, saved to disk,
// cancelable, and a "say hello" check at the end. No key is involved: the
// agent already has one, so only its model setting is changed.
// =========================================================================

export function startModelJob(options) {
  return withJobLock(() => startModelJobLocked(options));
}

// `model` is what the agent is given: an OpenRouter model id, or
// "@preset/<name>" together with `presetSlug`. `previous` is what it used
// before ({ provider, model }), shown on screen if the new one doesn't work.
async function startModelJobLocked({ agentId, model, presetSlug = null, previous = null } = {}) {
  if (agentId !== "hermes" && agentId !== "openclaw") {
    throw jobError("invalid_agent", "Only Hermes and OpenClaw have a model to change.");
  }
  const chosen = typeof model === "string" ? model.trim() : "";
  if (!chosen) throw jobError("invalid_model", "Choose a model first.");
  const check = await systemCheck({});
  if (!agentInstalled(check, agentId)) throw jobError("agent_not_installed", `${ADAPTERS[agentId].label} isn't installed.`);

  const target = { mode: "openrouter", model: chosen };
  const id = generateJobId();
  const job = {
    id,
    kind: "model",
    status: "running",
    mode: "openrouter",
    model: chosen,
    agentId,
    preset: presetSlug || null,
    previous: previous ? { provider: previous.provider || null, model: previous.model || null } : null,
    targets: { hermes: agentId === "hermes" ? target : null, openclaw: agentId === "openclaw" ? target : null },
    scope: [agentId],
    steps: [makeConfigureStep(`${agentId}-model`, agentId, "run"), makeConfigureStep("health", null, "run")],
    startedAt: new Date().toISOString(),
    endedAt: null
  };
  await persistJob(job);
  runningJobId = id;
  runConfigureJobSteps(job, "").catch(() => {});
  return job;
}

// =========================================================================
// OpenClaw's plan brains (docs/superpowers/specs/2026-10-15-plan-brains-design.md,
// sections 2 and 3). The Claude plan points OpenClaw at the person's own
// signed-in Claude Code (OpenClaw's claude-cli runtime runs the unmodified
// `claude` program); the ChatGPT plan uses the Sign in with ChatGPT the person
// already did in the card. No key or token is ever passed. Started only by
// POST /api/setup/openclaw/plan: POST /api/setup/configure and normalizeTarget
// keep refusing these modes. Same machinery as the other jobs: one at a time,
// saved to disk, cancelable, a hello check at the end.
// =========================================================================

// What a plan step says when Cancel stopped it before its command ran.
const PLAN_CANCELLED = "Cancelled.";

export const PLAN_JOB_STEPS = Object.freeze({
  claude: Object.freeze([
    "openclaw-plan-onboard",
    "openclaw-safe-defaults",
    "openclaw-plan-runtime-check",
    "openclaw-plan-model",
    "services",
    "health"
  ]),
  chatgpt: Object.freeze(["openclaw-plan-model", "openclaw-safe-defaults", "openclaw-plan-readiness", "health"])
});

function planNotReady(reason) {
  return jobError("plan_not_ready", PLAN_NOT_READY_MESSAGE[reason]);
}

// The OpenClaw a plan step works on (installed when the job started).
function planOpenclaw(check) {
  const detected = check.agents.openclaw.detected;
  if (!detected?.installed) throw jobError("configure_failed", PLAN_NOT_READY_MESSAGE.openclaw_missing);
  return detected;
}

export async function startOpenclawPlanJob({ plan, model, acceptOpenClawRisk } = {}) {
  // The risk tick comes first: without it nothing runs and nothing is read.
  if (acceptOpenClawRisk !== true) {
    throw jobError("openclaw_risk_not_accepted", "OpenClaw brain configuration requires acceptOpenClawRisk:true.");
  }
  if (!OPENCLAW_PLANS.includes(plan)) throw new TypeError('plan must be "claude" or "chatgpt"');
  return withJobLock(() => startOpenclawPlanJobLocked({ plan, model }));
}

async function startOpenclawPlanJobLocked({ plan, model }) {
  const detected = await ADAPTERS.openclaw.detect({ refresh: true });
  if (!detected?.installed) throw planNotReady("openclaw_missing");
  // Read again here, never trusted from the card: Claude Code may have been
  // signed out, or switched to an API key, since the card last looked.
  if (plan === "claude") {
    const readiness = claudePlanReadiness(await signInStatus("claude"));
    if (readiness !== "ready") throw planNotReady(readiness);
  } else if ((await readChatgptAuth(detected)).signedIn !== true) {
    throw planNotReady("chatgpt_signed_out");
  }
  const modelId = await resolvePlanModel(plan, model, { detected });
  const mode = PLAN_MODE[plan];
  const id = generateJobId();
  const now = new Date().toISOString();
  const job = {
    id,
    kind: "configure",
    status: "running",
    plan,
    mode,
    model: modelId,
    targets: { hermes: null, openclaw: { mode, model: modelId } },
    scope: ["openclaw"],
    steps: PLAN_JOB_STEPS[plan].map((stepId) =>
      makeConfigureStep(stepId, stepId === "services" || stepId === "health" ? null : "openclaw", "run")
    ),
    currentStepIndex: 0,
    startedAt: now,
    endedAt: null,
    acceptOpenClawRisk: true,
    acceptOpenClawRiskAt: now,
    previousPrimary: null,
    readiness: null
  };
  // In activeJobs before its first save, so a read in between never takes it
  // for a job that Agent OS quit during (getSetupJob).
  activeJobs.set(id, { job, controller: null });
  try {
    await persistJob(job);
  } catch (error) {
    activeJobs.delete(id);
    throw error;
  }
  runningJobId = id;
  runConfigureJobSteps(job, "").catch(() => {});
  return job;
}

// Claude plan, step 1: `openclaw onboard ... --auth-choice anthropic-cli`, which
// points OpenClaw at the signed-in Claude Code on this computer, with today's
// flag checks.
async function onboardOpenclawForClaudePlan(job, step, check, manager) {
  const detected = planOpenclaw(check);
  const args = await onboardArgs(step, detected, ["--auth-choice", "anthropic-cli"]);
  if (job.cancelRequested) throw jobError("cancelled", PLAN_CANCELLED);
  await runConfigureCommand(
    manager,
    { agentId: "openclaw", kind: "configure", title: "openclaw onboard", command: detected.path, args, cwd: os.tmpdir(), timeoutMs: CONFIGURE_RUN_TIMEOUT_MS },
    step
  );
}

// Claude plan, step 3, before `models set`: OpenClaw must run this model
// through Claude Code (claude-cli on anthropic/<model>, or on anthropic/* when
// the model has no runtime of its own). Otherwise it would bill an Anthropic
// API key, so the job stops here and OpenClaw keeps its old model.
async function checkClaudePlanRuntime(job, check) {
  const config = await readOpenclawModelsConfig(planOpenclaw(check));
  // null: the read failed or its answer couldn't be parsed. That is not "no
  // pin", and Agent OS must not say an API key would be billed. Nothing has
  // changed yet, so Apply can safely be tried again.
  if (config === null) throw jobError("configure_failed", MODEL_SETTINGS_UNREADABLE);
  if (!claudeCliPinned(config, job.model)) throw jobError("configure_failed", RUNTIME_CHECK_FAILED);
}

// How many of the newest saved jobs are looked through for an earlier ChatGPT plan job.
const EARLIER_JOBS_LOOKED_AT = 50;

// The newest saved ChatGPT plan job other than `exceptId`, or null. Job ids
// start with the time they were made (generateJobId), so by name is by age.
async function newestChatgptPlanJob(exceptId) {
  let names;
  try {
    names = (await fs.readdir(jobsDir())).filter((name) => name.startsWith("job_") && name.endsWith(".json"));
  } catch {
    return null;
  }
  names.sort().reverse();
  for (const name of names.slice(0, EARLIER_JOBS_LOOKED_AT)) {
    const id = name.slice(0, -".json".length);
    if (id === exceptId) continue;
    const job = await loadJob(id);
    if (job && job.kind === "configure" && job.plan === "chatgpt") return job;
  }
  return null;
}

// Did this earlier ChatGPT plan job leave OpenClaw on its model? It did when it
// ended badly (failed, cancelled, or saved as running with nothing in this
// process running it, which is what a quit leaves) after `models set` was
// reached: the model step ran or finished, or it was the step Agent OS quit in.
// A cancel can stop `models set` itself, after it had already taken, so a
// cancelled job whose model step failed with a `models set` run counts too.
function leftItsModelSet(job) {
  const endedBadly = job.status === "failed" || job.status === "cancelled" || (job.status === "running" && !activeJobs.has(job.id));
  const modelStep = Array.isArray(job.steps) ? job.steps.find((step) => step.id === "openclaw-plan-model") : null;
  if (!endedBadly || !modelStep) return false;
  if (modelStep.status === "succeeded" || modelStep.status === "running") return true;
  if (modelStep.status !== "failed") return false;
  return modelStep.error === PLAN_JOB_INTERRUPTED || (job.status === "cancelled" && modelStep.runIds?.length > 0);
}

// The model a ChatGPT Apply records as the earlier one (the one a failed
// readiness check puts back). Normally that is OpenClaw's current model. But
// when the newest earlier ChatGPT job was interrupted, or failed after `models
// set`, and OpenClaw is still on that job's own openai/<model>, the current
// model is the half-applied one, not the person's: this Apply reuses the
// earlier job's own record of what OpenClaw had before it (which may be none).
// A saved record that is not a plain model reference is never reused.
async function earlierPrimaryOfApply(job, primary) {
  if (typeof primary !== "string") return primary;
  const earlier = await newestChatgptPlanJob(job.id);
  if (!earlier || primary !== `openai/${earlier.model}` || !leftItsModelSet(earlier)) return primary;
  const before = earlier.previousPrimary;
  if (before === null || (typeof before === "string" && MODEL_ID_PATTERN.test(before))) return before;
  return primary;
}

// `openclaw models set <provider>/<model>`. For the ChatGPT plan the current
// model is read first, so a failed readiness check can put it back.
async function setOpenclawPlanModel(job, step, check, manager) {
  const detected = planOpenclaw(check);
  if (job.plan === "chatgpt") {
    const current = await runCommand(detected.path, ["config", "get", OPENCLAW_MODEL_PATH], CONFIG_GET_TIMEOUT_MS);
    // A read that timed out or couldn't run says nothing about the current
    // model: "couldn't read it", and trying again can work. A plain non-zero
    // exit still counts as "no model set" until live check S-B3 shows what
    // OpenClaw prints for that.
    if (readDidNotFinish(current)) throw jobError("configure_failed", CURRENT_MODEL_UNREADABLE);
    const primary = current.ok ? parseConfigText(current.stdout) : null;
    // Only a plain model reference ever goes back onto a command line. A model
    // that was read but isn't one can't be put back, so it is not "none" either:
    // stop before `models set`, with nothing changed. This is a different
    // sentence from the one above, because trying again can't help until the
    // person switches OpenClaw to another model.
    if (primary && !MODEL_ID_PATTERN.test(primary)) throw jobError("configure_failed", CURRENT_MODEL_NOT_RESTORABLE);
    // Set, but dropped by the config reader for its characters (a "+", an
    // accented letter): that is a model Agent OS can't put back, not "none".
    if (current.ok && primary === null && !configTextIsUnset(current.stdout)) {
      throw jobError("configure_failed", CURRENT_MODEL_NOT_RESTORABLE);
    }
    job.previousPrimary = await earlierPrimaryOfApply(job, primary);
    await persistJob(job);
  }
  // Cancel pressed during the read above: `models set` must not run.
  if (job.cancelRequested) throw jobError("cancelled", PLAN_CANCELLED);
  await runConfigureCommand(
    manager,
    {
      agentId: "openclaw",
      kind: "configure",
      title: "openclaw models set",
      command: detected.path,
      args: ["models", "set", `${PLAN_PROVIDER[job.plan]}/${job.model}`],
      cwd: os.tmpdir(),
      timeoutMs: CONFIGURE_RUN_TIMEOUT_MS
    },
    step
  );
}

// ChatGPT plan, step 3: can OpenClaw use the plan? Exit code only
// (readChatgptReadiness). Expiring soon: a warning, and the job goes on. Not
// ready: the earlier model is put back (or, when there was none, the job's last
// line says OpenClaw keeps the new one) and the job stops.
async function checkChatgptPlanReadiness(job, step, check, manager) {
  const detected = planOpenclaw(check);
  const readiness = await readChatgptReadiness(detected);
  job.readiness = readiness;
  if (readiness === "ready") return;
  if (readiness === "expiring") {
    step.warnings.push(CHATGPT_EXPIRING);
    return;
  }
  if (job.previousPrimary) {
    const back = await runConfigureCommand(
      manager,
      {
        agentId: "openclaw",
        kind: "configure",
        title: "openclaw models set",
        command: detected.path,
        args: ["models", "set", job.previousPrimary],
        cwd: os.tmpdir(),
        timeoutMs: CONFIGURE_RUN_TIMEOUT_MS
      },
      step,
      { optional: true }
    );
    if (back.run.status !== "succeeded") step.warnings.push("openclaw models set failed; see the run log.");
  } else {
    step.warnings.push(noEarlierPrimary(`openai/${job.model}`));
  }
  throw jobError("configure_failed", CHATGPT_NOT_READY);
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
