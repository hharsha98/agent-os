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

export async function getExecutionGateStatus() {
  const config = await readJson(configPath(), {});
  return publicStatus(config || {});
}

export async function isExecutionEnabled() {
  return (await getExecutionGateStatus()).enabled;
}

export async function setExecutionGateStatus(input = {}, { updatedBy = "local-admin" } = {}) {
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
