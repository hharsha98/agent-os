// Shared binary/feature detection for agent adapters. Releases every few
// days, so features are read from --help/--version at runtime instead of
// being hard-coded per version.
import { access, constants as fsConstants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, which } from "../safety.js";
import { managedNodeRoot } from "../setup/managed-node.js";

const DETECT_TTL_MS = 30 * 1000;

// detect() results, per adapter id, refreshed every 30s or on demand.
const detectCache = new Map();
// Help-text feature flags, keyed by binary path + version so a CLI upgrade
// (a new version string) invalidates the entry without waiting out a TTL.
const featureCache = new Map();

async function isExecutableCandidate(candidate) {
  try {
    await access(candidate, process.platform === "win32" ? undefined : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && (await isExecutableCandidate(candidate))) return candidate;
  }
  return "";
}

// which() first (a freshly installed agent may already be on PATH), then a
// short list of absolute fallbacks for the common install locations.
export async function resolveBinary(command, fallbackPaths = []) {
  const onPath = await which(command);
  if (onPath) return onPath;
  return firstExisting(fallbackPaths);
}

export function hermesFallbackPaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local ? [path.join(local, "hermes", "bin", "hermes.exe"), path.join(local, "hermes", "hermes.exe")] : [];
  }
  return [path.join(home, ".local", "bin", "hermes"), "/usr/local/bin/hermes"];
}

export function openclawFallbackPaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "openclaw.cmd")] : [];
  }
  return [
    path.join(home, ".npm-global", "bin", "openclaw"),
    path.join(home, ".agent-os", "node", "bin", "openclaw")
  ];
}

// The coding agents' installers drop a launcher in these places, which are not
// on PATH until the person opens a new terminal -- so a fresh install is found
// by its absolute path instead.
export function claudeFallbackPaths() {
  const home = os.homedir();
  if (process.platform === "win32") return [path.join(home, ".local", "bin", "claude.exe")];
  return [path.join(home, ".local", "bin", "claude")];
}

// Codex is an npm package: it lands in the bin folder of whichever Node it was
// installed with -- Agent OS's own (the managed Node root, which tests move
// with AGENT_OS_MANAGED_ROOT) or a user-level npm folder.
export function codexFallbackPaths() {
  const home = os.homedir();
  const managed = path.join(managedNodeRoot(), "node");
  if (process.platform === "win32") {
    return [
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "codex.cmd")] : []),
      path.join(managed, "codex.cmd")
    ];
  }
  return [path.join(managed, "bin", "codex"), path.join(home, ".npm-global", "bin", "codex"), path.join(home, ".local", "bin", "codex")];
}

export function cursorFallbackPaths(command) {
  if (process.platform === "win32") return [];
  return [path.join(os.homedir(), ".local", "bin", command)];
}

export async function runVersion(binPath, timeoutMs = 5000) {
  if (!binPath) return "";
  const result = await runCommand(binPath, ["--version"], timeoutMs);
  return (result.stdout || result.stderr || "").trim();
}

// Some CLIs (Hermes) print several lines from --version, including an
// absolute install path; only the first line belongs in the short
// `version` shown everywhere, with the full text kept (home folder
// redacted) in `versionFull` for anyone who wants the rest.
export function splitVersion(text) {
  const raw = String(text ?? "");
  const home = os.homedir();
  const withTilde = home ? raw.split(home).join("~") : raw;
  const firstLine = raw.split(/\r?\n/)[0] || "";
  return {
    version: firstLine.trim().slice(0, 80),
    versionFull: withTilde.trim().slice(0, 1000)
  };
}

// Returns both the exit outcome and the combined text, since "the help
// succeeds" (OpenClaw's agentExec feature) needs the exit code, not just text.
export async function runHelp(binPath, args, timeoutMs = 5000) {
  if (!binPath) return { ok: false, text: "" };
  const result = await runCommand(binPath, args, timeoutMs);
  return { ok: result.ok, text: `${result.stdout || ""}\n${result.stderr || ""}` };
}

// A result with `helpFailed: true` (the --help call timed out or printed
// nothing) is returned but not remembered, so one slow start can't leave every
// feature switched off until the CLI is upgraded.
export async function cachedFeatures(key, compute) {
  if (featureCache.has(key)) return featureCache.get(key);
  const value = await compute();
  if (!value?.helpFailed) featureCache.set(key, value);
  return value;
}

export async function withDetectCache(adapterId, refresh, compute) {
  const now = Date.now();
  const hit = detectCache.get(adapterId);
  if (!refresh && hit && now - hit.at < DETECT_TTL_MS) return hit.value;
  const value = await compute();
  detectCache.set(adapterId, { at: now, value });
  return value;
}

// Test-only escape hatch: lets a suite swap fake CLIs between cases without
// waiting out the 30s window or the feature cache's lifetime.
export function clearDetectCaches() {
  detectCache.clear();
  featureCache.clear();
}
