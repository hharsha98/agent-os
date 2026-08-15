import { promises as fs } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";

export const RUNTIME_VERSION = "0.2.15";
const runtimeContext = new AsyncLocalStorage();

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function osRoot() {
  const scopedHome = runtimeContext.getStore()?.home;
  // Keep the legacy directory as the compatibility default for existing users,
  // while accepting the product-neutral variable for new Agent OS installs.
  return expandHome(scopedHome || process.env.AGENT_OS_HOME || process.env.HERMES_AGENT_OS_HOME) || path.join(os.homedir(), ".hermes-agent-os");
}

export function withRuntimeHome(home, fn) {
  return runtimeContext.run({ home }, fn);
}

export function runtimePaths() {
  const root = osRoot();
  return {
    root,
    config: path.join(root, "config"),
    workflows: path.join(root, "workflows"),
    runs: path.join(root, "runs"),
    logs: path.join(root, "logs"),
    memory: path.join(root, "memory"),
    exports: path.join(root, "exports"),
    workspace: path.join(root, "workspace")
  };
}

export async function ensureRuntimeStore() {
  const paths = runtimePaths();
  await Promise.all(Object.values(paths).map((dir) => fs.mkdir(dir, { recursive: true })));
  return paths;
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  return data;
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function publicRuntimePath(dirName) {
  return `~/.hermes-agent-os/${dirName}`;
}
