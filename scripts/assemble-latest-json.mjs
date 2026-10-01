#!/usr/bin/env node
// Writes the auto-updater's `latest.json` for ONE GitHub Release, once, after
// every platform build has uploaded its installers.
//
// Why a separate step: when each of the four build jobs wrote latest.json
// itself, they raced each other and the last writer could erase the others.
// Now the build jobs only upload installers and `.sig` files (the signatures),
// and the "updater-json" job in .github/workflows/release.yml runs this script
// at the end. It refuses to upload a latest.json that is missing a computer.
//
// It uses each asset's API url (api.github.com/.../releases/assets/<id>), not
// the browser download link: a draft's browser link contains "untagged-..."
// and changes when the release is published, but the API url does not.
//
// Environment (set by the workflow): GITHUB_TOKEN, GITHUB_REPOSITORY,
// RELEASE_ID, RELEASE_TAG. Nothing here ever prints the token.
//
//   RELEASE_ID=123 RELEASE_TAG=v0.4.0 GITHUB_REPOSITORY=owner/repo \
//     GITHUB_TOKEN=... node scripts/assemble-latest-json.mjs
//
// test/assemble-latest-json.test.js covers buildLatestJson (the pure part).
import { fileURLToPath } from "node:url";

// Installer file-name ending -> the platform keys the updater looks up.
// (These are the exact keys tauri-action wrote for v0.3.0.)
const INSTALLERS = [
  { suffix: "_aarch64.app.tar.gz", keys: ["darwin-aarch64", "darwin-aarch64-app"] },
  { suffix: "_x64.app.tar.gz", keys: ["darwin-x86_64", "darwin-x86_64-app"] },
  { suffix: "_amd64.AppImage", keys: ["linux-x86_64", "linux-x86_64-appimage"] },
  { suffix: "_amd64.deb", keys: ["linux-x86_64-deb"] },
  { suffix: "_x64-setup.exe", keys: ["windows-x86_64", "windows-x86_64-nsis"] },
];

// The four computers an update must work for. Missing any one is an error.
const REQUIRED = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

// Builds the latest.json object. Pure: no network, no clock unless pubDate is omitted.
//   assets:     GitHub's asset list for the release ({ name, url, ... })
//   signatures: { "<installer name>.sig": "<signature text>" }
export function buildLatestJson({ version, notes, pubDate, assets, signatures }) {
  const platforms = {};
  for (const asset of assets) {
    const installer = INSTALLERS.find((entry) => asset.name.endsWith(entry.suffix));
    if (!installer) continue; // .dmg, .sig files, an old latest.json, ...
    const signature = signatures[`${asset.name}.sig`];
    if (!signature || !signature.trim()) {
      throw new Error(`${asset.name} has no matching ${asset.name}.sig signature, so it cannot be offered as an update.`);
    }
    for (const key of installer.keys) platforms[key] = { signature: signature.trim(), url: asset.url };
  }
  const missing = REQUIRED.filter((key) => !platforms[key]);
  if (missing.length > 0) {
    throw new Error(`Cannot write latest.json: no installer found for ${missing.join(", ")}.`);
  }
  return {
    version,
    notes: notes ?? "",
    pub_date: pubDate ?? new Date().toISOString(),
    platforms,
  };
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, RELEASE_ID, RELEASE_TAG } = process.env;
  for (const [name, value] of Object.entries({ GITHUB_TOKEN, GITHUB_REPOSITORY, RELEASE_ID, RELEASE_TAG })) {
    if (!value) throw new Error(`${name} is not set.`);
  }
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-os-release",
  };
  const call = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    if (!response.ok) {
      throw new Error(`${options.method || "GET"} ${url.replace(/\?.*/, "")} failed: ${response.status} ${response.statusText}`);
    }
    return response;
  };

  const release = await (await call(`${api}/${RELEASE_ID}`, { headers: { Accept: "application/vnd.github+json" } })).json();
  const assets = release.assets;
  const sigAssets = assets.filter((asset) => asset.name.endsWith(".sig"));

  // No signatures at all means the updater was switched off for this build.
  if (sigAssets.length === 0) {
    console.log("No .sig files on this release, so the updater was off. Not writing latest.json.");
    return;
  }

  const signatures = {};
  for (const asset of sigAssets) {
    const response = await call(asset.url, { headers: { Accept: "application/octet-stream" } });
    signatures[asset.name] = await response.text();
  }

  const latest = buildLatestJson({
    version: RELEASE_TAG.replace(/^v/, ""),
    notes: release.body ?? "",
    assets,
    signatures,
  });

  // Replace any existing latest.json (a re-run, or a leftover).
  for (const old of assets.filter((asset) => asset.name === "latest.json")) {
    await call(`${api}/assets/${old.id}`, { method: "DELETE" });
  }
  await call(`https://uploads.github.com/repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}/assets?name=latest.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/vnd.github+json" },
    body: JSON.stringify(latest, null, 2),
  });

  console.log(`Uploaded latest.json for ${RELEASE_TAG} (version ${latest.version}):`);
  for (const [key, entry] of Object.entries(latest.platforms)) {
    console.log(`  ${key} -> ${assets.find((asset) => asset.url === entry.url)?.name}`);
  }
}

// Only run when started from the command line, not when a test imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
