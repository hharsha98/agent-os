#!/usr/bin/env node
// Writes SHA256SUMS.txt for ONE GitHub Release, after every installer has
// uploaded (it runs in the "updater-json" job of .github/workflows/release.yml,
// right after latest.json is written).
//
// It downloads every installer in the draft, hashes it, and uploads one file
// with a line per installer: "<64 hex characters>  <file name>". That is the
// format `sha256sum -c` and `shasum -a 256 -c` read, so a person can check a
// download against it (README.md, "Check your download").
//
// Left out on purpose: the .sig files (they belong to the updater), latest.json,
// and an older SHA256SUMS.txt (replaced, not hashed).
//
// It uses the release id and each asset's API url, like assemble-latest-json.mjs:
// a draft cannot be found by its tag. Environment (set by the workflow):
// GITHUB_TOKEN, GITHUB_REPOSITORY, RELEASE_ID, RELEASE_TAG. Never prints the token.
//
// test/write-checksums.test.js covers buildChecksums (the pure part).
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const CHECKSUMS_NAME = "SHA256SUMS.txt";

// True for the files that are hashed: installers, not signatures or the file lists.
export function isInstaller(name) {
  return !name.endsWith(".sig") && name !== "latest.json" && name !== CHECKSUMS_NAME;
}

// entries: [{ name, sha256 }]. Returns the text of SHA256SUMS.txt, sorted by name.
export function buildChecksums(entries) {
  if (entries.length === 0) throw new Error("There are no installers to list in SHA256SUMS.txt.");
  const lines = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => {
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${name} has no valid SHA-256 hash.`);
      if (/[\s]/.test(name)) throw new Error(`${name} has a space in its name, which SHA256SUMS.txt cannot hold.`);
      return `${sha256}  ${name}`;
    });
  return `${lines.join("\n")}\n`;
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
  const installers = release.assets.filter((asset) => isInstaller(asset.name));

  const entries = [];
  for (const asset of installers) {
    // One at a time: an installer is up to a few hundred MB, and this keeps memory flat.
    const response = await call(asset.url, { headers: { Accept: "application/octet-stream" } });
    const hash = createHash("sha256");
    for await (const chunk of response.body) hash.update(chunk);
    entries.push({ name: asset.name, sha256: hash.digest("hex") });
  }
  const text = buildChecksums(entries);

  // Replace any existing file (a re-run, or a leftover).
  for (const old of release.assets.filter((asset) => asset.name === CHECKSUMS_NAME)) {
    await call(`${api}/assets/${old.id}`, { method: "DELETE" });
  }
  await call(`https://uploads.github.com/repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}/assets?name=${CHECKSUMS_NAME}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Accept: "application/vnd.github+json" },
    body: text,
  });

  console.log(`Uploaded ${CHECKSUMS_NAME} for ${RELEASE_TAG}:`);
  process.stdout.write(text);
}

// Only run when started from the command line, not when a test imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
