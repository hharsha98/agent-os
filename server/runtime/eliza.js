import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedStatus = null;

export async function getElizaStatus() {
  if (cachedStatus) return cachedStatus;
  try {
    const manifest = require("@elizaos/core/package.json");
    const core = await import("@elizaos/core");
    const requiredExports = ["AgentRuntime", "Service", "ModelType", "MemoryType", "composePrompt"];
    const missingExports = requiredExports.filter((name) => !core[name]);
    cachedStatus = {
      ok: missingExports.length === 0,
      packageName: manifest.name,
      version: manifest.version,
      description: manifest.description,
      exports: requiredExports.filter((name) => Boolean(core[name])),
      missingExports,
      runtimeClass: typeof core.AgentRuntime === "function" ? "AgentRuntime" : null,
      source: "@elizaos/core"
    };
  } catch (error) {
    cachedStatus = {
      ok: false,
      packageName: "@elizaos/core",
      version: null,
      description: null,
      exports: [],
      missingExports: ["@elizaos/core"],
      runtimeClass: null,
      source: "@elizaos/core",
      error: error instanceof Error ? error.message : "Unable to load elizaOS core"
    };
  }
  return cachedStatus;
}
