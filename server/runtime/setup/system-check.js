// Read-only inventory of this computer for the Setup Assistant: what's
// installed, how much room there is, and whether the official install hosts
// are reachable. Every probe is timeout-guarded and wrapped so one flaky
// check (a slow DNS lookup, a tool with no --version) can never make the
// whole report throw.
import { promises as fs } from "node:fs";
import os from "node:os";
import { ADAPTERS } from "../agents/index.js";
import { runCommand, which } from "../safety.js";
import { nodeSatisfiesOpenClaw } from "./managed-node.js";

const CACHE_TTL_MS = 60 * 1000;
const NETWORK_HOSTS = [
  "hermes-agent.nousresearch.com",
  "openclaw.ai",
  "nodejs.org",
  "openrouter.ai",
  "ollama.com",
  "github.com"
];
const NETWORK_TIMEOUT_MS = 5000;

let cached = null; // { at, value }

async function safeCall(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function probeTool(command, versionArgs = ["--version"]) {
  const found = await which(command);
  if (!found) return { found: false, path: "", version: "" };
  const result = await runCommand(found, versionArgs, 5000);
  return { found: true, path: found, version: (result.stdout || result.stderr || "").trim() };
}

async function probeHost(host) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const url = `https://${host}/`;
    try {
      await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    } catch {
      // Some hosts reject HEAD; a tiny ranged GET is still a fair
      // reachability probe without pulling a full page down.
      await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: controller.signal, redirect: "follow" });
    }
    return { host, ok: true, ms: Date.now() - start };
  } catch {
    return { host, ok: false, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function macOsVersion() {
  const result = await runCommand("sw_vers", ["-productVersion"], 3000);
  return result.ok ? result.stdout.trim() : "";
}

async function xcodeCltInstalled() {
  const result = await runCommand("xcode-select", ["-p"], 5000);
  return result.ok;
}

async function linuxDistro() {
  if (process.platform !== "linux") return null;
  const raw = await fs.readFile("/etc/os-release", "utf8");
  const values = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return { id: values.ID || "", idLike: values.ID_LIKE || "", versionId: values.VERSION_ID || "" };
}

async function dockerRunning(dockerPath) {
  if (!dockerPath) return false;
  const result = await runCommand(dockerPath, ["info"], 5000);
  return result.ok;
}

async function freeDiskGb() {
  if (typeof fs.statfs !== "function") return null;
  const stats = await fs.statfs(os.homedir());
  return (stats.bsize * stats.bavail) / 1024 ** 3;
}

async function agentReport(adapter) {
  const detected = await safeCall(
    () => adapter.detect({ refresh: true }),
    { installed: false, path: "", version: "", features: {}, error: "detect failed" }
  );
  const service = adapter.service
    ? await safeCall(() => adapter.service.status(detected), { running: false, text: "" })
    : null;
  return { detected, service };
}

async function computeSystemCheck() {
  const platform = process.platform;
  const arch = process.arch;
  const isMac = platform === "darwin";
  const isIntelMac = isMac && arch === "x64";

  const emptyTool = { found: false, path: "", version: "" };

  const [osVersion, git, node, python3, uv, docker, brew, xcodeClt, distro, hermes, openclaw, ollama, network] =
    await Promise.all([
      isMac ? safeCall(macOsVersion, "") : Promise.resolve(os.release()),
      safeCall(() => probeTool("git"), emptyTool),
      safeCall(() => probeTool("node"), emptyTool),
      safeCall(() => probeTool("python3"), emptyTool),
      safeCall(() => probeTool("uv"), emptyTool),
      safeCall(() => probeTool("docker"), emptyTool),
      isMac ? safeCall(() => probeTool("brew"), emptyTool) : Promise.resolve(null),
      isMac ? safeCall(xcodeCltInstalled, false) : Promise.resolve(null),
      safeCall(linuxDistro, null),
      safeCall(() => agentReport(ADAPTERS.hermes), { detected: { installed: false }, service: null }),
      safeCall(() => agentReport(ADAPTERS.openclaw), { detected: { installed: false }, service: null }),
      safeCall(() => probeTool("ollama"), emptyTool),
      Promise.all(NETWORK_HOSTS.map((host) => probeHost(host)))
    ]);

  docker.running = await safeCall(() => dockerRunning(docker.path), false);

  return {
    at: new Date().toISOString(),
    os: platform,
    arch,
    osVersion,
    isIntelMac,
    ramGb: os.totalmem() / 1024 ** 3,
    freeDiskGb: await safeCall(freeDiskGb, null),
    tools: {
      git,
      node: { ...node, nodeOkForOpenClaw: node.found ? nodeSatisfiesOpenClaw(node.version) : false },
      python3,
      uv,
      docker,
      brew,
      xcodeCltInstalled: xcodeClt
    },
    linuxDistro: distro,
    agents: { hermes, openclaw },
    ollama,
    network
  };
}

export async function systemCheck({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await safeCall(computeSystemCheck, {
    at: new Date().toISOString(),
    os: process.platform,
    arch: process.arch,
    error: "system check failed; some fields may be missing"
  });
  cached = { at: now, value };
  return value;
}

// Test-only: forces the next systemCheck() to recompute instead of serving
// the 60s cache.
export function clearSystemCheckCache() {
  cached = null;
}
