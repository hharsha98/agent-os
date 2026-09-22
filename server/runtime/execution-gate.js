import { isDemoPublic } from "./demo-public.js";
import { runtimePaths, readJson, writeJson } from "./store.js";

const CONFIG_FILE = "execution-gate.json";

function now() {
  return new Date().toISOString();
}

function configPath() {
  return `${runtimePaths().config}/${CONFIG_FILE}`;
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
  return applyDemoExecutionLock(publicStatus(config || {}));
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
  await writeJson(configPath(), config);
  return publicStatus(config);
}
