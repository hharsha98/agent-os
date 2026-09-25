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
import { readJson, runtimePaths, writeJson } from "../store.js";
import { getInstallRecipe } from "./recipes.js";
import { ensureManagedNode } from "./managed-node.js";
import { buildSetupPlan } from "./plan.js";
import { systemCheck } from "./system-check.js";
import { appendReceiptEntry } from "./receipt.js";

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

export async function startSetupJob({ steps = [], acceptOpenClawRisk = false } = {}) {
  if (runningJobId) throw jobError("job_already_running", "A setup job is already running.");

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
  const stored = await loadJob(id);
  if (!stored) return null;
  if (stored.status === "running") return stored;

  const startIndex = stored.steps.findIndex((s) => s.status !== "succeeded");
  if (startIndex === -1) return stored; // nothing left to retry

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

// Test-only: lets a suite reset the concurrency lock between cases without
// waiting for a job to naturally finish.
export function resetSetupJobsForTest() {
  activeJobs.clear();
  runningJobId = null;
}
