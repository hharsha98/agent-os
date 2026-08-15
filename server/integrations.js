import { getConnections } from "./runtime/connections.js";
import { getModules, getOsStatus, modulesToLegacySnapshot, runModule, testModule } from "./runtime/modules.js";

export async function getIntegrationSnapshot() {
  const [status, modules] = await Promise.all([getOsStatus(), getModules()]);
  return modulesToLegacySnapshot(status, modules);
}

export async function testIntegration(id) {
  return testModule(id);
}

export async function dispatchAgentMessage(id, message) {
  return runModule(id, { message });
}

export async function connectionTemplates() {
  return getConnections();
}
