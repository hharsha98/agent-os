// Release wiring: the app version must match everywhere, and the release
// workflow must keep the settings that took three real releases to get right.
// YAML is checked with plain string matching on purpose (no extra dependency).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

async function versions(base = root) {
  const get = (relative) => readFile(path.join(base, relative), "utf8");
  const cargoToml = await get("desktop/src-tauri/Cargo.toml");
  const cargoLock = await get("desktop/src-tauri/Cargo.lock");
  const store = await get("server/runtime/store.js");
  const lock = JSON.parse(await get("package-lock.json"));
  return {
    "package.json": JSON.parse(await get("package.json")).version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages[""].version,
    "tauri.conf.json": JSON.parse(await get("desktop/src-tauri/tauri.conf.json")).version,
    "Cargo.toml": cargoToml.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)[1],
    "Cargo.lock": cargoLock.match(/name = "agent-os-desktop"\r?\nversion = "([^"]+)"/)[1],
    "store.js RUNTIME_VERSION": store.match(/export const RUNTIME_VERSION = "([^"]+)"/)[1],
  };
}

describe("app version", () => {
  test("is identical in package.json, tauri.conf.json and Cargo.toml (and the lock files)", async () => {
    const found = await versions();
    const distinct = new Set(Object.values(found));
    assert.equal(distinct.size, 1, `versions differ: ${JSON.stringify(found, null, 2)}`);
    assert.match([...distinct][0], /^\d+\.\d+\.\d+$/);
  });

  test("scripts/bump-version.mjs changes all of them together, and rejects a bad version", async () => {
    const copy = await mkdtemp(path.join(os.tmpdir(), "agent-os-bump-"));
    try {
      for (const file of [
        "package.json",
        "package-lock.json",
        "desktop/src-tauri/tauri.conf.json",
        "desktop/src-tauri/Cargo.toml",
        "desktop/src-tauri/Cargo.lock",
        "server/runtime/store.js",
      ]) {
        await mkdir(path.dirname(path.join(copy, file)), { recursive: true });
        await cp(path.join(root, file), path.join(copy, file));
      }
      const bump = (version) =>
        execFileSync(process.execPath, ["scripts/bump-version.mjs", version, "--root", copy], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      bump("9.8.7");
      const found = await versions(copy);
      assert.deepEqual([...new Set(Object.values(found))], ["9.8.7"], JSON.stringify(found));
      assert.throws(() => bump("not-a-version"));
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe("release workflow", async () => {
  const workflow = await read(".github/workflows/release.yml");
  // The text of one top-level job (from "  name:" to the next "  other-name:" or the end).
  const jobText = (name) => {
    const match = workflow.match(new RegExp(`\\n  ${name}:\\r?\\n([\\s\\S]*?)(?=\\r?\\n  [a-z][a-z-]*:\\r?\\n|$)`));
    assert.ok(match, `job ${name} not found`);
    return match[1];
  };

  test("can write the Release, runs every platform, and creates the release as a draft", () => {
    assert.match(workflow, /contents:\s*write/);
    assert.match(workflow, /fail-fast:\s*false/);
    assert.match(workflow, /tauri-apps\/tauri-action@v1/);
    assert.match(workflow, /tags:\s*\n\s*-\s*"v\*"/);
    assert.match(workflow, /workflow_dispatch:[\s\S]*?tag:[\s\S]*?required:\s*true/);
  });

  test("builds Windows as NSIS only, Linux on pinned ubuntu-22.04, and both Mac CPUs", () => {
    assert.match(workflow, /--bundles nsis/);
    assert.ok(!/--bundles[^\n]*msi/.test(workflow), "Windows must not build MSI");
    assert.match(workflow, /ubuntu-22\.04/);
    assert.ok(!/ubuntu-latest/.test(workflow), "Linux must stay pinned to 22.04");
    assert.match(workflow, /--target aarch64-apple-darwin/);
    assert.match(workflow, /--target x86_64-apple-darwin/);
    assert.match(workflow, /libwebkit2gtk-4\.1-dev/);
  });

  test("uses Node 24 and a plain `npm ci` with no CI=true on installs", () => {
    assert.match(workflow, /node-version:\s*"24"/);
    assert.match(workflow, /run:\s*npm ci\s*\n/);
  });

  test("create-release makes exactly one draft (not a prerelease) and reuses one that exists", () => {
    const create = jobText("create-release");
    assert.match(create, /contents:\s*write/);
    assert.match(create, /-F draft=true/);
    assert.match(create, /-F prerelease=false/);
    assert.match(create, /already published/);
    assert.match(create, /release_id=/);
    assert.match(create, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
    assert.ok(!/run:[^\n]*\$\{\{/.test(create), "no ${{ }} on a run: line (injection safety)");
    assert.ok(!/tauri-action/.test(create), "only create-release makes the release");
  });

  test("release builds wait for create-release and upload into its release without making latest.json", () => {
    const release = jobText("release");
    assert.match(release, /needs:\s*create-release\r?\n/);
    assert.match(release, /releaseId:\s*\$\{\{\s*needs\.create-release\.outputs\.release_id\s*\}\}/);
    assert.match(release, /uploadUpdaterJson:\s*false/);
    for (const input of ["tagName", "releaseName", "releaseBody", "releaseDraft"]) {
      assert.ok(!new RegExp(`${input}:`).test(release), `${input} would make tauri-action create its own release`);
    }
  });

  test("updater-json runs last, after the builds, and writes latest.json with the script", () => {
    const updater = jobText("updater-json");
    assert.match(updater, /needs:\s*\[\s*create-release\s*,\s*release\s*\]/);
    assert.match(updater, /contents:\s*write/);
    assert.match(updater, /node scripts\/assemble-latest-json\.mjs/);
    assert.match(updater, /RELEASE_ID:\s*\$\{\{\s*needs\.create-release\.outputs\.release_id\s*\}\}/);
    assert.match(updater, /RELEASE_TAG:/);
    assert.match(updater, /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  });

  test("sets CI: true only inside the tauri-action step", () => {
    const lines = workflow.split(/\r?\n/);
    const ciLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^\s*CI:\s*true\b/.test(line));
    assert.equal(ciLines.length, 1, "CI: true should appear exactly once");
    const actionStart = lines.findIndex((line) => /uses:\s*tauri-apps\/tauri-action/.test(line));
    assert.ok(actionStart >= 0);
    assert.ok(ciLines[0].index > actionStart, "CI: true must come after the tauri-action step starts");
    // ...and that step must be the last one of the release job (nothing after it can inherit CI).
    const release = jobText("release").split(/\r?\n/);
    const releaseAction = release.findIndex((line) => /uses:\s*tauri-apps\/tauri-action/.test(line));
    assert.ok(releaseAction >= 0, "the release job runs tauri-action");
    const stepsAfter = release.slice(releaseAction + 1).filter((line) => /^\s{6}-\s+name:/.test(line));
    assert.equal(stepsAfter.length, 0, "tauri-action must be the final step of the release job");
    assert.ok(!/CI=true/.test(workflow));
  });

  test("passes the updater key from secrets, never a literal key", () => {
    assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY\s*\}\}/);
    assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*\}\}/);
    assert.match(workflow, /releases\/latest\/download\/latest\.json/);
    assert.ok(!/dW50cnVzdGVkIGNvbW1lbnQ6[A-Za-z0-9+/=]{20,}/.test(workflow));
  });

  test("fetches the target's Node, then prepares without replacing it", () => {
    assert.match(workflow, /fetch-node\.mjs --platform \$\{\{ matrix\.node_platform \}\} --arch \$\{\{ matrix\.node_arch \}\}/);
    assert.match(workflow, /prepare-desktop\.mjs --skip-node/);
  });

  test("the files it reads exist, and the release notes lead with the unsigned warning", async () => {
    const pubkey = await read("desktop/updater-pubkey.txt");
    assert.ok(pubkey.trim().length > 0);
    const notes = await read(".github/release-notes.md");
    const opening = notes.split("\n").slice(0, 8).join("\n").toLowerCase();
    assert.match(opening, /unsigned/);
    assert.match(opening, /right-click/);
    assert.match(opening, /open anyway/);
    assert.match(opening, /smartscreen/);
    assert.match(opening, /chmod \+x/);
    assert.ok(!/@/.test(notes.replace(/mechaharsh@gmail\.com/g, "")), "the only email in the notes is mechaharsh@gmail.com");
  });
});
