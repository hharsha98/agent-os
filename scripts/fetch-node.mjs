#!/usr/bin/env node
// Downloads the official Node.js runtime the desktop app ships with, checks
// it against the SHA-256 list nodejs.org publishes for that release, and
// unpacks only the `node` binary (plus its LICENSE) into
// desktop/src-tauri/resources/node/.
//
//   npm run desktop:fetch-node                          # this machine
//   npm run desktop:fetch-node -- --platform linux --arch x64
//   npm run desktop:fetch-node -- --platform darwin --arch x64 --out /some/dir
//
// --platform / --arch pick the TARGET (the machine the app will run on), which
// can differ from the machine running this script: the release workflow builds
// the Intel Mac app on an Apple-silicon runner. --out redirects the unpacked
// files (the release workflow does not need it; it is for trying a fetch
// without touching resources/).
//
// This is the app's OWN private Node. It is separate from the managed Node
// that Setup installs into ~/.agent-os/node for OpenClaw; do not merge them.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The one place the bundled Node version is pinned. Bump it on purpose:
// it must stay on the Node 24 LTS line (the server bundle targets node24).
export const NODE_VERSION = "24.21.0";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, "desktop", ".cache", "node");
const defaultOutDir = path.join(root, "desktop", "src-tauri", "resources", "node");

function parseArgs(argv) {
  const args = { platform: process.platform, arch: process.arch, out: defaultOutDir };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--platform") args.platform = argv[++i];
    else if (argv[i] === "--arch") args.arch = argv[++i];
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
  }
  return args;
}

// Maps process.platform / process.arch to the names nodejs.org uses.
function archiveInfo(platform, arch) {
  const osName = { darwin: "darwin", linux: "linux", win32: "win" }[platform];
  const cpu = { x64: "x64", arm64: "arm64" }[arch];
  if (!osName || !cpu) {
    throw new Error(`Unsupported target ${platform}/${arch}. Use darwin|linux|win32 with x64|arm64.`);
  }
  const base = `node-v${NODE_VERSION}-${osName}-${cpu}`;
  return { base, file: `${base}.${platform === "win32" ? "zip" : "tar.gz"}` };
}

// Follows redirects, rejects anything that is not a plain 200.
function download(url, destination) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(new URL(res.headers.location, url).toString(), destination).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
          return;
        }
        const file = createWriteStream(destination);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function main() {
  const { platform, arch, out: outDir } = parseArgs(process.argv.slice(2));
  const { base, file } = archiveInfo(platform, arch);
  const distUrl = `https://nodejs.org/dist/v${NODE_VERSION}`;
  await mkdir(cacheDir, { recursive: true });

  const archivePath = path.join(cacheDir, file);
  const sumsPath = path.join(cacheDir, `SHASUMS256-v${NODE_VERSION}.txt`);

  // The checksum list is always re-fetched: a stale cached copy must never
  // be the thing we trust.
  console.log(`Fetching checksums for Node v${NODE_VERSION}...`);
  await download(`${distUrl}/SHASUMS256.txt`, sumsPath);
  const expected = (await readFile(sumsPath, "utf8"))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === file)?.[0];
  if (!expected) throw new Error(`${file} is not listed in SHASUMS256.txt for v${NODE_VERSION}.`);

  if (!existsSync(archivePath) || (await sha256(archivePath)) !== expected) {
    console.log(`Downloading ${file}...`);
    await rm(archivePath, { force: true });
    await download(`${distUrl}/${file}`, archivePath);
  } else {
    console.log(`Using cached ${file}.`);
  }

  const actual = await sha256(archivePath);
  if (actual !== expected) {
    await rm(archivePath, { force: true });
    throw new Error(`SHA-256 mismatch for ${file}.\n  expected ${expected}\n  got      ${actual}\nThe download was deleted. Aborting.`);
  }
  console.log(`SHA-256 verified: ${actual}`);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-os-node-"));
  try {
    // How to unpack depends on the archive (.zip for a Windows target), and
    // on the machine running this script, not on the target: a Mac can
    // fetch the Windows zip.
    if (file.endsWith(".zip")) {
      if (process.platform === "win32") {
        // PowerShell ships with every supported Windows; no extra tools needed.
        execFileSync(
          "powershell",
          ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${scratch}' -Force`],
          { stdio: "inherit" }
        );
      } else {
        execFileSync("unzip", ["-q", archivePath, "-d", scratch], { stdio: "inherit" });
      }
    } else {
      execFileSync("tar", ["-xzf", archivePath, "-C", scratch], { stdio: "inherit" });
    }

    const unpacked = path.join(scratch, base);
    await rm(outDir, { recursive: true, force: true });
    if (platform === "win32") {
      await mkdir(outDir, { recursive: true });
      await copyFile(path.join(unpacked, "node.exe"), path.join(outDir, "node.exe"));
    } else {
      await mkdir(path.join(outDir, "bin"), { recursive: true });
      await copyFile(path.join(unpacked, "bin", "node"), path.join(outDir, "bin", "node"));
      await chmod(path.join(outDir, "bin", "node"), 0o755);
    }
    await copyFile(path.join(unpacked, "LICENSE"), path.join(outDir, "LICENSE"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const rel = path.relative(root, outDir);
  const shown = rel.startsWith("..") ? outDir : rel;
  console.log(`Node v${NODE_VERSION} (${platform}/${arch}) is ready in ${shown}/`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
