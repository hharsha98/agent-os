#!/usr/bin/env node
// Downloads the official Node.js runtime the desktop app ships with, checks
// it against a SHA-256 hash pinned in THIS file (NODE_SHA256, below), and
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
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The one place the bundled Node version is pinned. Bump it on purpose:
// it must stay on the Node 24 LTS line (the server bundle targets node24).
export const NODE_VERSION = "24.22.2";

// The SHA-256 of each Node archive this app may ship, copied from nodejs.org's SHASUMS256.txt for that
// release (and checked by hand against the GPG-signed SHASUMS256.txt.asc once). They live HERE, in the
// repository, on purpose: a list fetched from nodejs.org at build time would be replaced together with the
// file it describes. The names carry the version, so raising NODE_VERSION without adding the new hashes
// makes the fetch refuse to run instead of trusting nothing.
// To bump Node: change NODE_VERSION, then replace every line below with the same five archives of the new
// version, from https://nodejs.org/dist/v<version>/SHASUMS256.txt (check that file against SHASUMS256.txt.asc
// with gpg: the release keys are listed in https://github.com/nodejs/node#release-keys).
export const NODE_SHA256 = {
  "node-v24.22.2-linux-x64.tar.gz": "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
  "node-v24.22.2-darwin-arm64.tar.gz": "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
  "node-v24.22.2-darwin-x64.tar.gz": "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
  "node-v24.22.2-win-x64.zip": "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2",
  "node-v24.22.2-linux-arm64.tar.gz": "95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2",
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, "desktop", ".cache", "node");
const defaultOutDir = path.join(root, "desktop", "src-tauri", "resources", "node");

// The pinned hash for one archive, or an error that says how to add it.
export function pinnedSha256(file) {
  const hash = NODE_SHA256[file];
  if (!hash) {
    throw new Error(
      `No pinned SHA-256 for ${file}. Agent OS only downloads a Node archive whose hash is listed in NODE_SHA256 in ` +
        `scripts/fetch-node.mjs. When bumping NODE_VERSION, add the hash of every archive from ` +
        `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt (checked against its SHASUMS256.txt.asc signature).`
    );
  }
  return hash;
}

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
  // Before any download: a target with no pinned hash is refused.
  const expected = pinnedSha256(file);
  await mkdir(cacheDir, { recursive: true });

  const archivePath = path.join(cacheDir, file);

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
  console.log(`SHA-256 matches the hash pinned in scripts/fetch-node.mjs: ${actual}`);

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

// Only run when started from the command line, not when a test imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
