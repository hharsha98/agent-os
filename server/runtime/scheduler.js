import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendModuleLog } from "./module-logs.js";
import { sanitizeObject } from "./safety.js";
import { createSelfModuleItem, isLocalSelfModule, localSelfModuleIds, runGoalLoop, updateKanbanCards, upsertKanbanCard } from "./self-modules.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";

const SCHEDULER_ID = "scheduler";
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_LOCK_TTL_MS = 120000;
const LOCK_FILE_NAME = "scheduler.lock.json";
const PARKED_PUBLIC_SELF_MODULE_IDS = new Set(["seo", "video"]);
const schedulerOwnerId = `${os.hostname()}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let schedulerTimer = null;

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function jobsPath() {
  return path.join(runtimePaths().config, "scheduler.jobs.json");
}

function historyPath(jobId) {
  return path.join(runtimePaths().runs, "scheduler", `${jobId}.json`);
}

function lockPath() {
  return path.join(runtimePaths().runs, "scheduler", LOCK_FILE_NAME);
}

function publicLockPath() {
  return `~/.hermes-agent-os/runs/scheduler/${LOCK_FILE_NAME}`;
}

function cleanId(value, fallbackPrefix = "job") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return cleaned || `${fallbackPrefix}-${Date.now()}`;
}

function cleanTargetType(value) {
  const type = String(value || "workflow").trim().toLowerCase();
  if (["workflow", "self_module"].includes(type)) return type;
  const error = new Error(`Unsupported scheduler target type: ${type}`);
  error.status = 400;
  throw error;
}

function cleanAction(value, targetType = "workflow") {
  const action = String(value || (targetType === "self_module" ? "create_item" : "run")).trim().toLowerCase();
  const allowed = targetType === "self_module"
    ? ["create_item", "goal_loop"]
    : ["run"];
  if (allowed.includes(action)) return action;
  const error = new Error(`Unsupported scheduler action: ${action}`);
  error.status = 400;
  throw error;
}

function numberAtLeast(value, fallback, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function addMs(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function schedulerLockEnabled() {
  return process.env.HERMES_AGENT_OS_SCHEDULER_LOCK !== "0";
}

function schedulerLockTtlMs() {
  return numberAtLeast(process.env.HERMES_AGENT_OS_SCHEDULER_LOCK_TTL_MS, DEFAULT_LOCK_TTL_MS, 1000);
}

function schedulerPollMs() {
  return numberAtLeast(process.env.HERMES_AGENT_OS_SCHEDULER_POLL_MS, 30000, 1000);
}

async function readSchedulerLock() {
  return readJson(lockPath(), null);
}

function lockTimestamp(lock) {
  return new Date(lock?.heartbeatAt || lock?.acquiredAt || 0).getTime();
}

function lockIsStale(lock, now = new Date()) {
  if (!lock?.ownerId) return true;
  const timestamp = lockTimestamp(lock);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return true;
  return now.getTime() - timestamp > schedulerLockTtlMs();
}

function publicLock(lock = null, now = new Date()) {
  const enabled = schedulerLockEnabled();
  const stale = Boolean(enabled && lock && lockIsStale(lock, now));
  const held = Boolean(enabled && lock?.ownerId && !stale);
  const heldByThisProcess = Boolean(held && lock.ownerId === schedulerOwnerId);
  return {
    enabled,
    mode: enabled ? "leader_lock" : "disabled",
    lockFile: publicLockPath(),
    ownerId: schedulerOwnerId,
    ttlMs: schedulerLockTtlMs(),
    held,
    heldByThisProcess,
    heldByAnotherProcess: Boolean(held && !heldByThisProcess),
    stale,
    holderId: lock?.ownerId || null,
    acquiredAt: lock?.acquiredAt || null,
    heartbeatAt: lock?.heartbeatAt || null,
    expiresAt: lock?.heartbeatAt ? addMs(lock.heartbeatAt, schedulerLockTtlMs()) : null
  };
}

export async function getSchedulerLockStatus() {
  await ensureRuntimeStore();
  return publicLock(await readSchedulerLock());
}

async function writeLockRecord(reason, now = new Date()) {
  const timestamp = nowIso(now);
  const lock = {
    schemaVersion: 1,
    ownerId: schedulerOwnerId,
    pid: process.pid,
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: addMs(timestamp, schedulerLockTtlMs()),
    reason: String(reason || "scheduler-tick").slice(0, 80)
  };
  await fs.mkdir(path.dirname(lockPath()), { recursive: true });
  await fs.writeFile(lockPath(), `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
  return lock;
}

async function acquireSchedulerLock({ reason = "scheduler-tick", now = new Date() } = {}) {
  if (!schedulerLockEnabled()) {
    return { acquired: true, disabled: true, lock: publicLock(null, now) };
  }

  await ensureRuntimeStore();
  try {
    const lock = await writeLockRecord(reason, now);
    return { acquired: true, disabled: false, lock: publicLock(lock, now) };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = await readSchedulerLock();
  if (lockIsStale(existing, now)) {
    await fs.unlink(lockPath()).catch(() => undefined);
    try {
      const lock = await writeLockRecord(reason, now);
      await appendModuleLog(SCHEDULER_ID, {
        level: "warn",
        message: "Scheduler leader lock recovered from stale holder",
        details: {
          previousHolderId: existing?.ownerId || null,
          lockFile: publicLockPath(),
          ttlMs: schedulerLockTtlMs()
        }
      });
      return { acquired: true, disabled: false, recovered: true, lock: publicLock(lock, now) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  return {
    acquired: false,
    disabled: false,
    reason: "leader_lock_held",
    lock: publicLock(await readSchedulerLock(), now)
  };
}

async function heartbeatSchedulerLock() {
  if (!schedulerLockEnabled()) return;
  const existing = await readSchedulerLock();
  if (existing?.ownerId !== schedulerOwnerId) return;
  const heartbeatAt = nowIso();
  await writeJson(lockPath(), {
    ...existing,
    heartbeatAt,
    expiresAt: addMs(heartbeatAt, schedulerLockTtlMs())
  });
}

async function releaseSchedulerLock() {
  if (!schedulerLockEnabled()) return;
  const existing = await readSchedulerLock();
  if (existing?.ownerId === schedulerOwnerId) {
    await fs.unlink(lockPath()).catch(() => undefined);
  }
}

async function withSchedulerLeaderLock(work, options = {}) {
  const acquired = await acquireSchedulerLock(options);
  if (!acquired.acquired) return { skipped: true, lock: acquired.lock, reason: acquired.reason };

  const heartbeatMs = Math.max(1000, Math.floor(schedulerLockTtlMs() / 3));
  const heartbeatTimer = acquired.disabled
    ? null
    : setInterval(() => {
      heartbeatSchedulerLock().catch((error) => {
        appendModuleLog(SCHEDULER_ID, {
          level: "warn",
          message: "Scheduler leader lock heartbeat failed",
          details: { error: error.message, lockFile: publicLockPath() }
        }).catch(() => undefined);
      });
    }, heartbeatMs);
  heartbeatTimer?.unref?.();

  try {
    const result = await work(acquired.lock);
    return { ...result, lock: acquired.lock };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await releaseSchedulerLock();
  }
}

async function readJobs() {
  await ensureRuntimeStore();
  const data = await readJson(jobsPath(), { jobs: [] });
  return Array.isArray(data?.jobs) ? data.jobs : [];
}

async function writeJobs(jobs) {
  await ensureRuntimeStore();
  await writeJson(jobsPath(), { jobs });
  return jobs;
}

async function readHistory(jobId) {
  return readJson(historyPath(jobId), []);
}

async function writeHistory(jobId, history) {
  return writeJson(historyPath(jobId), history.slice(0, 200));
}

function summarizeJobs(jobs, now = new Date()) {
  const current = new Date(now).getTime();
  return {
    total: jobs.length,
    enabled: jobs.filter((job) => job.enabled).length,
    paused: jobs.filter((job) => job.paused).length,
    pendingApproval: jobs.filter((job) => job.pendingApproval).length,
    due: jobs.filter((job) => job.enabled && !job.paused && !job.pendingApproval && new Date(job.nextRunAt || 0).getTime() <= current).length,
    failed: jobs.filter((job) => job.lastStatus && job.lastStatus !== "completed").length
  };
}

function publicJob(job) {
  return {
    ...job,
    payload: sanitizeObject(job.payload || {})
  };
}

async function schedulerTargets() {
  const { listWorkflows } = await import("./workflows.js");
  return {
    workflows: await listWorkflows(),
    selfModules: localSelfModuleIds()
      .filter((id) => !PARKED_PUBLIC_SELF_MODULE_IDS.has(id))
      .map((id) => ({
        id,
        label: id.replace(/-/g, " "),
        actions: id === "goals" ? ["create_item", "goal_loop"] : ["create_item"]
      }))
  };
}

export async function getSchedulerState() {
  const jobs = await readJobs();
  const lock = await getSchedulerLockStatus();
  const historyGroups = await Promise.all(jobs.map(async (job) => readHistory(job.id)));
  const history = historyGroups
    .flat()
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
    .slice(0, 25);
  return {
    id: SCHEDULER_ID,
    status: "connected",
    enabled: process.env.HERMES_AGENT_OS_SCHEDULER !== "0",
    pollMs: schedulerPollMs(),
    lock,
    summary: summarizeJobs(jobs),
    jobs: jobs.map(publicJob),
    history,
    targets: await schedulerTargets()
  };
}

export async function getSchedulerOverview() {
  const state = await getSchedulerState();
  return {
    status: state.enabled ? "connected" : "disabled",
    enabled: state.enabled,
    pollMs: state.pollMs,
    lock: state.lock,
    summary: state.summary
  };
}

export async function getSchedulerJob(id) {
  const clean = cleanId(id);
  return (await readJobs()).find((job) => job.id === clean) || null;
}

function normalizeJob(input = {}, current = null, now = new Date()) {
  const targetType = cleanTargetType(input.targetType || current?.targetType);
  const targetId = cleanId(input.targetId || current?.targetId, targetType);
  if (targetType === "self_module" && !isLocalSelfModule(targetId)) {
    const error = new Error(`Unsupported self module target: ${targetId}`);
    error.status = 400;
    throw error;
  }
  if (targetType === "self_module" && PARKED_PUBLIC_SELF_MODULE_IDS.has(targetId)) {
    const error = new Error(`Self module target is parked for this release: ${targetId}`);
    error.status = 400;
    throw error;
  }
  const id = cleanId(input.id || current?.id || `${targetType}-${targetId}-${Date.now()}`);
  const action = cleanAction(input.action || current?.action, targetType);
  if (targetType === "self_module" && action === "goal_loop" && targetId !== "goals") {
    const error = new Error("goal_loop scheduler action requires targetId goals");
    error.status = 400;
    throw error;
  }
  const intervalMinutes = numberAtLeast(input.intervalMinutes ?? current?.intervalMinutes, DEFAULT_INTERVAL_MINUTES, 1);
  const retryDelaySeconds = numberAtLeast(input.retryDelaySeconds ?? current?.retryDelaySeconds, DEFAULT_RETRY_DELAY_SECONDS, 1);
  const maxRetries = numberAtLeast(input.maxRetries ?? current?.maxRetries, DEFAULT_MAX_RETRIES, 0);
  const createdAt = current?.createdAt || nowIso(now);
  const nextRunAt = input.nextRunAt || current?.nextRunAt || nowIso(now);
  return {
    id,
    label: String(input.label || current?.label || `${targetType} ${targetId}`).trim(),
    targetType,
    targetId,
    action,
    intervalMinutes,
    retryFailed: input.retryFailed == null ? current?.retryFailed ?? true : Boolean(input.retryFailed),
    retryDelaySeconds,
    maxRetries,
    payload: input.payload && typeof input.payload === "object" ? input.payload : current?.payload || {},
    requiresApproval: input.requiresApproval == null ? current?.requiresApproval ?? false : Boolean(input.requiresApproval),
    pendingApproval: input.pendingApproval == null ? current?.pendingApproval ?? false : Boolean(input.pendingApproval),
    approvalStatus: input.approvalStatus || current?.approvalStatus || null,
    approvalRequestedAt: input.approvalRequestedAt || current?.approvalRequestedAt || null,
    approvedAt: input.approvedAt || current?.approvedAt || null,
    rejectedAt: input.rejectedAt || current?.rejectedAt || null,
    approvalNote: input.approvalNote || current?.approvalNote || "",
    approvalRequestCount: current?.approvalRequestCount || 0,
    enabled: input.enabled == null ? current?.enabled ?? true : Boolean(input.enabled),
    paused: input.paused == null ? current?.paused ?? false : Boolean(input.paused),
    nextRunAt,
    lastRunAt: current?.lastRunAt || null,
    lastStatus: current?.lastStatus || null,
    lastHistoryId: current?.lastHistoryId || null,
    runCount: current?.runCount || 0,
    failureCount: current?.failureCount || 0,
    currentRetryCount: current?.currentRetryCount || 0,
    pendingRetry: current?.pendingRetry || false,
    createdAt,
    updatedAt: nowIso(now)
  };
}

export async function saveSchedulerJob(input = {}) {
  const jobs = await readJobs();
  const id = cleanId(input.id || "");
  const index = id ? jobs.findIndex((job) => job.id === id) : -1;
  const current = index >= 0 ? jobs[index] : null;
  const next = normalizeJob(input, current);
  if (index >= 0) jobs[index] = next;
  else jobs.push(next);
  await writeJobs(jobs);
  await appendModuleLog(SCHEDULER_ID, {
    message: current ? "Scheduler job updated" : "Scheduler job created",
    details: { jobId: next.id, targetType: next.targetType, targetId: next.targetId, action: next.action }
  });
  return publicJob(next);
}

export async function updateSchedulerJob(id, input = {}) {
  const current = await getSchedulerJob(id);
  if (!current) {
    const error = new Error(`Scheduler job not found: ${id}`);
    error.status = 404;
    throw error;
  }
  return saveSchedulerJob({ ...input, id: current.id });
}

export async function pauseSchedulerJob(id) {
  return updateSchedulerJob(id, { paused: true });
}

export async function resumeSchedulerJob(id) {
  return updateSchedulerJob(id, { paused: false });
}

export async function approveSchedulerJob(id, input = {}) {
  const current = await getSchedulerJob(id);
  if (!current) {
    const error = new Error(`Scheduler job not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const updated = await updateSchedulerJob(id, {
    pendingApproval: false,
    approvalStatus: "approved",
    approvedAt: nowIso(input.now || new Date()),
    rejectedAt: null,
    approvalNote: input.note || "",
    nextRunAt: input.nextRunAt || nowIso(input.now || new Date())
  });
  await updateKanbanCards({
    sourceType: "scheduler_approval",
    schedulerJobId: current.id
  }, {
    column: "done",
    status: "approved",
    approvalStatus: "approved",
    approvedAt: input.now || new Date(),
    completedAt: input.now || new Date(),
    notes: input.note || `Scheduler job ${current.id} approved.`
  });
  return updated;
}

export async function rejectSchedulerJob(id, input = {}) {
  const current = await getSchedulerJob(id);
  if (!current) {
    const error = new Error(`Scheduler job not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const rejectedAt = nowIso(input.now || new Date());
  const updated = await updateSchedulerJob(id, {
    pendingApproval: false,
    approvalStatus: "rejected",
    approvedAt: null,
    rejectedAt,
    approvalNote: input.note || "",
    nextRunAt: input.nextRunAt || addMs(rejectedAt, current.intervalMinutes * 60 * 1000)
  });
  await updateKanbanCards({
    sourceType: "scheduler_approval",
    schedulerJobId: current.id
  }, {
    column: "blocked",
    status: "rejected",
    approvalStatus: "rejected",
    rejectedAt,
    notes: input.note || `Scheduler job ${current.id} rejected.`
  });
  return updated;
}

function selfModulePayload(job) {
  return {
    title: job.payload?.title || `Scheduled ${job.targetId} task`,
    notes: job.payload?.notes || `Created by scheduler job ${job.id}.`,
    status: job.payload?.status,
    column: job.payload?.column,
    url: job.payload?.url,
    keyword: job.payload?.keyword,
    sourcePath: job.payload?.sourcePath,
    workflow: job.payload?.workflow,
    provider: job.payload?.provider,
    units: job.payload?.units,
    estimatedCost: job.payload?.estimatedCost
  };
}

async function executeSchedulerJob(job, input = {}) {
  if (job.targetType === "workflow") {
    const { runWorkflow } = await import("./workflows.js");
    const run = await runWorkflow(job.targetId, {
      trigger: "scheduler",
      jobId: job.id,
      ...(job.payload || {}),
      ...(input || {})
    });
    return {
      ok: run.status === "completed",
      status: run.status,
      runId: run.id,
      message: `Workflow ${job.targetId} finished with ${run.status}.`
    };
  }

  if (job.targetType === "self_module") {
    if (PARKED_PUBLIC_SELF_MODULE_IDS.has(job.targetId)) {
      return {
        ok: false,
        status: "disabled",
        action: job.action || "create_item",
        message: `${job.targetId} is parked for this release.`
      };
    }
    if (job.action === "goal_loop") {
      const goalId = job.payload?.goalId || job.payload?.itemId;
      if (!goalId) {
        return {
          ok: false,
          status: "ready_to_configure",
          action: job.action,
          message: "goal_loop scheduler action requires payload.goalId."
        };
      }
      const result = await runGoalLoop(goalId, {
        ...(job.payload || {}),
        ...(input || {}),
        requestId: input.requestId || `scheduler:${job.id}:${goalId}`
      });
      return {
        ok: result.ok,
        status: result.ok ? "completed" : result.run.status,
        action: job.action,
        runId: result.run.id,
        message: result.ok
          ? `Goal loop ${result.run.status} for ${goalId}.`
          : result.router.message || result.run.nextAction || "Goal loop needs configuration.",
        result
      };
    }
    const state = await createSelfModuleItem(job.targetId, selfModulePayload(job));
    return {
      ok: true,
      status: "completed",
      action: job.action || "create_item",
      itemCount: state.items.length,
      message: `${job.targetId} scheduled task saved.`
    };
  }

  return {
    ok: false,
    status: "failed",
    message: `Unsupported scheduler target type: ${job.targetType}.`
  };
}

async function recordSchedulerRun(job, result, options = {}) {
  const startedAt = options.startedAt || nowIso();
  const finishedAt = nowIso(options.now || new Date());
  const historyId = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const history = await readHistory(job.id);
  const record = {
    id: historyId,
    jobId: job.id,
    targetType: job.targetType,
    targetId: job.targetId,
    action: job.action || "run",
    scheduled: Boolean(options.scheduled),
    manual: Boolean(options.manual),
    approvalRequired: Boolean(job.requiresApproval),
    approvalGate: result.approvalGate || null,
    startedAt,
    finishedAt,
    status: result.status || (result.ok ? "completed" : "failed"),
    ok: Boolean(result.ok),
    runId: result.runId || null,
    message: result.message || "",
    attempt: job.currentRetryCount + 1,
    payloadKeys: Object.keys(job.payload || {})
  };
  await writeHistory(job.id, [record, ...history]);
  await appendModuleLog(SCHEDULER_ID, {
    level: record.ok ? "info" : "warn",
    message: record.ok ? "Scheduler job completed" : "Scheduler job needs retry or attention",
    details: {
      jobId: job.id,
      historyId,
      status: record.status,
      targetType: job.targetType,
      targetId: job.targetId,
      action: record.action,
      approvalGate: record.approvalGate
    }
  });
  return record;
}

function nextJobState(job, record, now = new Date()) {
  const currentIso = nowIso(now);
  if (record.status === "waiting_approval") {
    return {
      ...job,
      pendingApproval: true,
      approvalStatus: "pending",
      approvalRequestedAt: currentIso,
      lastRunAt: currentIso,
      lastStatus: record.status,
      lastHistoryId: record.id,
      approvalRequestCount: Number(job.approvalRequestCount || 0) + 1,
      updatedAt: currentIso
    };
  }
  const failed = record.status !== "completed";
  const canRetry = failed && job.retryFailed && job.currentRetryCount < job.maxRetries;
  const retryCount = canRetry ? job.currentRetryCount + 1 : failed ? job.currentRetryCount : 0;
  const nextRunAt = canRetry
    ? addMs(currentIso, job.retryDelaySeconds * 1000)
    : addMs(currentIso, job.intervalMinutes * 60 * 1000);
  return {
    ...job,
    nextRunAt,
    lastRunAt: currentIso,
    lastStatus: record.status,
    lastHistoryId: record.id,
    runCount: job.runCount + 1,
    failureCount: failed ? job.failureCount + 1 : job.failureCount,
    currentRetryCount: retryCount,
    pendingRetry: canRetry,
    pendingApproval: false,
    approvalStatus: null,
    approvalRequestedAt: null,
    updatedAt: currentIso
  };
}

export async function runSchedulerJob(id, input = {}) {
  const jobs = await readJobs();
  const index = jobs.findIndex((job) => job.id === cleanId(id));
  if (index === -1) {
    const error = new Error(`Scheduler job not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const startedAt = nowIso(input.now || new Date());
  const job = jobs[index];
  if (job.requiresApproval && input.scheduled && job.approvalStatus !== "approved") {
    const result = {
      ok: true,
      status: "waiting_approval",
      action: job.action || "run",
      approvalGate: "pending",
      message: `Scheduler job ${job.id} is waiting for admin approval.`
    };
    const card = await upsertKanbanCard({
      title: `Approve scheduler: ${job.label || job.id}`,
      column: "review",
      status: "waiting_approval",
      notes: `${result.message} Target: ${job.targetType}/${job.targetId}/${job.action || "run"}.`,
      priority: job.payload?.priority || "normal",
      sourceType: "scheduler_approval",
      sourceId: `scheduler_approval:${job.id}`,
      schedulerJobId: job.id,
      approvalId: `scheduler_approval:${job.id}`,
      approvalStatus: "pending",
      approvalRequestedAt: input.now || new Date(),
      linkedModule: job.targetType === "self_module" ? job.targetId : "workflows",
      linkedItemId: job.targetType === "workflow" ? job.targetId : job.payload?.itemId || job.payload?.goalId || job.payload?.briefId || ""
    }, {
      sourceType: "scheduler_approval",
      schedulerJobId: job.id
    });
    result.kanbanCardId = card.card.id;
    const record = await recordSchedulerRun(job, result, {
      manual: false,
      scheduled: true,
      startedAt,
      now: input.now
    });
    jobs[index] = nextJobState(job, record, input.now || new Date());
    await writeJobs(jobs);
    return {
      job: publicJob(jobs[index]),
      history: record,
      result: sanitizeObject(result)
    };
  }
  const result = await executeSchedulerJob(jobs[index], input.payload || {});
  const record = await recordSchedulerRun(jobs[index], result, {
    manual: input.manual !== false,
    scheduled: Boolean(input.scheduled),
    startedAt,
    now: input.now
  });
  jobs[index] = nextJobState(jobs[index], record, input.now || new Date());
  await writeJobs(jobs);
  return {
    job: publicJob(jobs[index]),
    history: record,
    result: sanitizeObject(result)
  };
}

export async function getSchedulerHistory(id) {
  const job = await getSchedulerJob(id);
  if (!job) {
    const error = new Error(`Scheduler job not found: ${id}`);
    error.status = 404;
    throw error;
  }
  return {
    job: publicJob(job),
    history: await readHistory(job.id)
  };
}

export async function runSchedulerTick(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  return withSchedulerLeaderLock(async () => {
    const limit = numberAtLeast(options.limit, 25, 1);
    const jobs = await readJobs();
  const due = jobs
      .filter((job) => job.enabled && !job.paused && !job.pendingApproval && new Date(job.nextRunAt || 0).getTime() <= now.getTime())
      .slice(0, limit);
    const runs = [];
    for (const job of due) {
      await heartbeatSchedulerLock();
      runs.push(await runSchedulerJob(job.id, { manual: false, scheduled: true, now }));
    }
    return {
      ok: true,
      skipped: false,
      checkedAt: nowIso(now),
      due: due.length,
      runs
    };
  }, {
    reason: options.reason || "scheduler-tick",
    now
  }).then((result) => {
    if (!result.skipped) return result;
    return {
      ok: true,
      skipped: true,
      reason: result.reason,
      checkedAt: nowIso(now),
      due: 0,
      runs: [],
      lock: result.lock
    };
  });
}

export function startSchedulerLoop() {
  if (schedulerTimer || process.env.HERMES_AGENT_OS_SCHEDULER === "0") return schedulerTimer;
  const pollMs = schedulerPollMs();
  schedulerTimer = setInterval(() => {
    runSchedulerTick().catch((error) => {
      appendModuleLog(SCHEDULER_ID, {
        level: "error",
        message: "Scheduler tick failed",
        details: { error: error.message }
      }).catch(() => undefined);
    });
  }, pollMs);
  schedulerTimer.unref?.();
  return schedulerTimer;
}

export function stopSchedulerLoop() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
