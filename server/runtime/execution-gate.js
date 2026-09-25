import { isDemoPublic } from "./demo-public.js";
import { runtimePaths, readJson, writeJson } from "./store.js";

const CONFIG_FILE = "execution-gate.json";
const MACHINE_CONTROL_PHRASE = "ENABLE MACHINE CONTROL";
const DEFAULT_MACHINE_CONTROL_TTL_MS = 30 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

function configPath() {
  return `${runtimePaths().config}/${CONFIG_FILE}`;
}

// Level 2 ("machine control armed") lives only in this process's memory —
// never written to disk — so a restart (or a crash) always comes back up
// disarmed, and it also expires on its own after a while.
let machineControlState = { armed: false, expiresAt: null };

function machineControlTtlMs() {
  // The short override only works in tests, so a stray env var can never
  // shrink the real 30-minute window on a user's machine.
  if (process.env.NODE_ENV === "test") {
    const override = Number(process.env.AGENT_OS_MACHINE_CONTROL_TTL_MS);
    if (Number.isFinite(override) && override > 0) return override;
  }
  return DEFAULT_MACHINE_CONTROL_TTL_MS;
}

function pruneExpiredMachineControl() {
  if (machineControlState.armed && machineControlState.expiresAt && Date.now() >= Date.parse(machineControlState.expiresAt)) {
    machineControlState = { armed: false, expiresAt: null };
  }
}

export function getMachineControlStatus() {
  pruneExpiredMachineControl();
  const { armed, expiresAt } = machineControlState;
  const remainingMs = armed && expiresAt ? Math.max(0, Date.parse(expiresAt) - Date.now()) : 0;
  return { armed, expiresAt, supported: process.platform === "darwin", remainingMs };
}

function machineControlError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function setMachineControlStatus(input = {}) {
  if (input.enable === false) {
    machineControlState = { armed: false, expiresAt: null };
    return getMachineControlStatus();
  }
  if (input.enable !== true) {
    throw machineControlError(400, "enable must be true or false.");
  }
  if (!(await isExecutionEnabled())) {
    throw machineControlError(400, "Turn on the execution gate before arming machine control.");
  }
  if (process.platform !== "darwin") {
    throw machineControlError(400, "Machine control is only supported on macOS.");
  }
  if (input.confirm !== true) {
    throw machineControlError(400, "confirm must be true.");
  }
  const phrase = typeof input.phrase === "string" ? input.phrase.trim() : "";
  if (phrase !== MACHINE_CONTROL_PHRASE) {
    throw machineControlError(400, `Type the exact phrase "${MACHINE_CONTROL_PHRASE}" to arm machine control.`);
  }
  const expiresAt = new Date(Date.now() + machineControlTtlMs()).toISOString();
  machineControlState = { armed: true, expiresAt };
  return getMachineControlStatus();
}

// Level 2 requires both the execution gate on and machine control armed;
// this is the single check every gated voice action/route should call.
export async function isMachineControlActive() {
  if (!(await isExecutionEnabled())) return false;
  return getMachineControlStatus().armed;
}

function envEnabled() {
  return process.env.HERMES_AGENT_OS_ENABLE_EXEC === "1";
}

function publicStatus(config = {}) {
  const envLocked = envEnabled();
  const localEnabled = config.enabled === true;
  const enabled = envLocked || localEnabled;
  return {
    enabled,
    source: envLocked ? "env" : localEnabled ? "local-config" : "disabled",
    envLocked,
    localEnabled,
    dryRunDefault: !enabled,
    updatedAt: config.updatedAt || null,
    updatedBy: config.updatedBy || null,
    reason: config.reason || "",
    publicSummary: enabled
      ? envLocked
        ? "Trusted live execution is enabled by HERMES_AGENT_OS_ENABLE_EXEC=1."
        : "Trusted live execution is enabled from local Agent OS config."
      : "Trusted live execution is disabled. Dashboard actions prepare dry-run plans until enabled."
  };
}

export function applyDemoExecutionLock(status = {}, env = process.env) {
  if (!isDemoPublic(env)) return status;
  return {
    ...status,
    enabled: false,
    source: "demo-public-lock",
    envLocked: false,
    localEnabled: false,
    dryRunDefault: true,
    demoLocked: true,
    refused: status.refused === true,
    publicSummary: "Public demo locks live execution off. No host shell runs, even if HERMES_AGENT_OS_ENABLE_EXEC=1."
  };
}

export async function getExecutionGateStatus() {
  const config = await readJson(configPath(), {});
  const status = applyDemoExecutionLock(publicStatus(config || {}));
  const machineControl = getMachineControlStatus();
  const level = !status.enabled ? 0 : machineControl.armed ? 2 : 1;
  return { ...status, level, machineControl: { armed: machineControl.armed, expiresAt: machineControl.expiresAt } };
}

export async function isExecutionEnabled() {
  return (await getExecutionGateStatus()).enabled;
}

export async function setExecutionGateStatus(input = {}, { updatedBy = "local-admin" } = {}) {
  if (isDemoPublic()) {
    return applyDemoExecutionLock({
      enabled: false,
      source: "demo-public-lock",
      envLocked: false,
      localEnabled: false,
      dryRunDefault: true,
      updatedAt: now(),
      updatedBy: "demo-public-lock",
      reason: "Public demo refuses to enable host execution.",
      refused: true,
      publicSummary: ""
    });
  }
  const requestedEnabled = input.enabled === true || input.enabled === "true" || input.enabled === 1 || input.enabled === "1";
  const reason = String(input.reason || "").trim().slice(0, 240);
  const config = {
    enabled: requestedEnabled,
    updatedAt: now(),
    updatedBy,
    reason
  };
  // Turning the gate off also disarms level 2, so switching the gate back on
  // never silently brings machine control back.
  if (!requestedEnabled) machineControlState = { armed: false, expiresAt: null };
  await writeJson(configPath(), config);
  return publicStatus(config);
}
