// Provisions a Node runtime for OpenClaw without touching Homebrew, winget,
// or an admin password: if the system Node is already 24.16+/26.1+ we use
// it as-is, otherwise we download the OFFICIAL nodejs.org build, verify its
// published SHA-256, and unpack it into a fixed spot other code already
// knows about (safety.js's search dirs, agents/detect.js's fallback paths).
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { runCommand, which } from "../safety.js";
import { expandHome } from "../store.js";
import { applyMirror } from "./recipes.js";

const NODEJS_DIST_BASE = "https://nodejs.org/dist/latest-v24.x/";
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// Matches the exact rule the OpenClaw installer itself uses (read from
// install.sh on 2026-09-24): only 24.16.0+, 26.1.0+, or anything above 26.
export function parseNodeVersion(raw) {
  const match = String(raw || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function nodeSatisfiesOpenClaw(raw) {
  const version = parseNodeVersion(raw);
  if (!version) return false;
  if (version.major === 24) return version.minor >= 16;
  if (version.major === 26) return version.minor >= 1;
  return version.major > 26;
}

export function managedNodeRoot() {
  const override = process.env.AGENT_OS_MANAGED_ROOT;
  if (override) return expandHome(override);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "AgentOS");
  }
  return path.join(os.homedir(), ".agent-os");
}

function assetSuffix(platform, arch) {
  const archName = arch === "arm64" ? "arm64" : "x64";
  if (platform === "darwin") return { osName: "darwin", archName, ext: "tar.gz" };
  if (platform === "linux") return { osName: "linux", archName, ext: "tar.xz" };
  if (platform === "win32") return { osName: "win", archName, ext: "zip" };
  return null;
}

function findAsset(shasumsText, pattern) {
  for (const rawLine of shasumsText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [sha256, ...rest] = line.split(/\s+/);
    const filename = rest.join(" ");
    const match = filename.match(pattern);
    if (match) return { sha256, filename, version: match[1] };
  }
  return null;
}

async function downloadToFile(url, destPath, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function extractTar(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archivePath, "-C", destDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extraction failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

async function firstSubdirectory(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = entries.find((entry) => entry.isDirectory());
  return found ? path.join(dir, found.name) : null;
}

// If the system Node already satisfies OpenClaw, use it; otherwise download,
// verify, and unpack the official build. Progress is reported through
// onProgress so a job log can show it; signal lets a cancelled setup job
// abort the download (extraction, being local and fast, is left to finish).
export async function ensureManagedNode({ signal, onProgress = () => {} } = {}) {
  const systemNode = await which("node");
  if (systemNode) {
    const result = await runCommand(systemNode, ["--version"], 5000);
    const version = (result.stdout || result.stderr || "").trim();
    if (nodeSatisfiesOpenClaw(version)) {
      return { source: "system", version, binDir: path.dirname(systemNode) };
    }
  }

  const suffix = assetSuffix(process.platform, process.arch);
  if (!suffix) {
    throw new Error(`No managed Node build is available for ${process.platform}/${process.arch}.`);
  }

  const root = managedNodeRoot();
  const stagingRoot = path.join(root, "tmp");
  await fs.mkdir(stagingRoot, { recursive: true });

  const baseUrl = applyMirror(NODEJS_DIST_BASE);
  onProgress("Looking up the latest Node 24 release...");
  const shasumsRes = await fetch(new URL("SHASUMS256.txt", baseUrl), { signal });
  if (!shasumsRes.ok) throw new Error(`Could not read SHASUMS256.txt (HTTP ${shasumsRes.status}).`);
  const shasumsText = await shasumsRes.text();

  const extRe = suffix.ext.replace(".", "\\.");
  const pattern = new RegExp(`^node-v(\\d+\\.\\d+\\.\\d+)-${suffix.osName}-${suffix.archName}\\.${extRe}$`);
  const asset = findAsset(shasumsText, pattern);
  if (!asset) throw new Error(`No Node 24 build listed for ${process.platform}/${process.arch}.`);
  const version = `v${asset.version}`;

  onProgress(`Downloading Node 24 (${asset.filename}, ≈30 MB)...`);
  const fileUrl = new URL(asset.filename, baseUrl);
  const downloadPath = path.join(stagingRoot, asset.filename);
  await downloadToFile(fileUrl, downloadPath, signal);

  onProgress("Verifying checksum...");
  const actualSha256 = await sha256File(downloadPath);
  if (actualSha256 !== asset.sha256) {
    await fs.rm(downloadPath, { force: true });
    throw new Error("Downloaded Node build failed checksum verification; refusing to install it.");
  }

  const extractDir = await fs.mkdtemp(path.join(stagingRoot, "extract-"));
  await extractTar(downloadPath, extractDir);
  await fs.rm(downloadPath, { force: true });

  const innerDir = await firstSubdirectory(extractDir);
  if (!innerDir) {
    await fs.rm(extractDir, { recursive: true, force: true });
    throw new Error("The downloaded Node archive did not contain the expected folder.");
  }

  const versionedDir = path.join(root, `node-${version}`);
  await fs.rm(versionedDir, { recursive: true, force: true });
  await fs.rename(innerDir, versionedDir);
  await fs.rm(extractDir, { recursive: true, force: true });

  const finalDir = path.join(root, "node");
  await fs.rm(finalDir, { recursive: true, force: true });
  if (process.platform === "win32") {
    // Windows can hold the directory open (AV scan, Explorer) in ways that
    // make an in-place rename flaky; copy the verified bits instead.
    await fs.cp(versionedDir, finalDir, { recursive: true });
    await fs.rm(versionedDir, { recursive: true, force: true });
  } else {
    await fs.rename(versionedDir, finalDir);
  }

  onProgress("Extracted Node 24.");
  const binDir = process.platform === "win32" ? finalDir : path.join(finalDir, "bin");
  return { source: "managed", version, binDir };
}
