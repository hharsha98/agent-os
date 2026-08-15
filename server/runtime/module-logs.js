import path from "node:path";
import { sanitizeObject } from "./safety.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";

const MAX_LOGS = 120;

function now() {
  return new Date().toISOString();
}

function safeId(id) {
  return String(id || "unknown").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

async function logPath(id) {
  await ensureRuntimeStore();
  return path.join(runtimePaths().logs, "modules", `${safeId(id)}.json`);
}

export async function appendModuleLog(id, { level = "info", message, details = {} } = {}) {
  const file = await logPath(id);
  const current = await readJson(file, { id, logs: [] });
  const entry = {
    timestamp: now(),
    level,
    message: String(message || "Module event"),
    details: sanitizeObject(details)
  };
  const logs = [entry, ...(Array.isArray(current.logs) ? current.logs : [])].slice(0, MAX_LOGS);
  await writeJson(file, { id, logs });
  return entry;
}

export async function readModuleLogs(id) {
  const file = await logPath(id);
  const current = await readJson(file, { id, logs: [] });
  return {
    id,
    logs: Array.isArray(current.logs) ? current.logs : []
  };
}

function publicRunFromLog(entry) {
  const details = entry && typeof entry.details === "object" ? entry.details : {};
  const proof = details.proof && typeof details.proof === "object" ? details.proof : null;
  if (!proof?.runId) return null;
  const execution = details.execution && typeof details.execution === "object" ? details.execution : null;
  const control = details.control && typeof details.control === "object" ? details.control : null;
  return sanitizeObject({
    runId: proof.runId,
    moduleId: proof.moduleId || "",
    moduleLabel: proof.moduleLabel || "",
    mode: proof.mode || details.mode || "",
    status: proof.status || details.status || "",
    action: proof.action || "",
    requestedAt: proof.requestedAt || entry.timestamp,
    loggedAt: entry.timestamp,
    dryRun: Boolean(proof.dryRun),
    execEnabled: Boolean(proof.execEnabled),
    explicitExecution: Boolean(proof.explicitExecution),
    promptChars: Number(proof.promptChars || 0),
    nextStep: proof.nextStep || "",
    evidence: Array.isArray(proof.evidence) ? proof.evidence : [],
    handoff: proof.handoff || null,
    replay: proof.replay || {
      available: false,
      reason: "This run was recorded before replay metadata was available.",
      input: null
    },
    proof,
    execution: execution
      ? {
          adapterId: execution.adapterId || "",
          exitCode: execution.exitCode ?? null,
          durationMs: execution.durationMs ?? null,
          stdoutBytes: execution.stdoutBytes ?? null,
          stderrBytes: execution.stderrBytes ?? null
        }
      : null,
    control: control
      ? {
          action: control.action || null,
          selectedProfile: control.selectedProfile || null,
          launchLabel: control.launchLabel || null,
          command: control.command || null,
          executed: Boolean(control.executed),
          queue: control.queue || null,
          taskId: control.taskId || null,
          taskStatus: control.taskStatus || null
        }
      : null
  });
}

export async function readModuleRuns(id, { limit = 20 } = {}) {
  const logs = await readModuleLogs(id);
  const seen = new Map();
  for (const entry of logs.logs) {
    const run = publicRunFromLog(entry);
    if (!run?.runId) continue;
    const current = seen.get(run.runId);
    if (!current || (!current.handoff && run.handoff) || (!current.control && run.control) || (!current.execution && run.execution)) {
      seen.set(run.runId, {
        ...current,
        ...run,
        evidence: run.evidence?.length ? run.evidence : current?.evidence || [],
        proof: run.proof || current?.proof || null,
        handoff: run.handoff || current?.handoff || null,
        control: run.control || current?.control || null,
        execution: run.execution || current?.execution || null
      });
    }
  }
  return {
    id,
    runs: Array.from(seen.values()).slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
  };
}
