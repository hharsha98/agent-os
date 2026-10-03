#!/usr/bin/env node
// Sets the app version in every place that has to agree, in one go:
//   package.json, package-lock.json            (npm)
//   desktop/src-tauri/tauri.conf.json          (the version shown on the installer)
//   desktop/src-tauri/Cargo.toml + Cargo.lock  (the Rust shell)
//   server/runtime/store.js                    (RUNTIME_VERSION, shown by the server)
// test/release-config.test.js fails if these ever drift apart.
//
//   node scripts/bump-version.mjs 0.4.0
//
// It edits only the version text, so the rest of each file keeps its exact
// formatting. It does not commit or tag; see "Releasing" in desktop/README.md.
// (--root <dir> points it at a copy of the repo; the tests use that.)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const root =
  rootFlag >= 0
    ? path.resolve(argv.splice(rootFlag, 2)[1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = argv[0];

if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("Usage: node scripts/bump-version.mjs <x.y.z>   (for example 0.4.0)");
  process.exit(1);
}

// Replaces the first match of `pattern` (which must capture a prefix in $1 and
// a suffix in $2 around the version). Fails loudly if the file has no match,
// so a changed file layout cannot silently skip a bump.
async function edit(relativePath, pattern, label) {
  const file = path.join(root, relativePath);
  const before = await readFile(file, "utf8");
  if (!pattern.test(before)) throw new Error(`${relativePath}: could not find ${label}.`);
  await writeFile(file, before.replace(pattern, `$1${version}$2`));
  console.log(`${relativePath}: ${label} -> ${version}`);
}

try {
  await edit("package.json", /^(\{[\s\S]*?"version":\s*")[^"]+(")/, "version");
  await edit("package-lock.json", /^(\{[\s\S]*?"version":\s*")[^"]+(")/, "top-level version");
  await edit("package-lock.json", /("packages":\s*\{\s*"":\s*\{[\s\S]*?"version":\s*")[^"]+(")/, 'packages[""] version');
  await edit("desktop/src-tauri/tauri.conf.json", /^(\{[\s\S]*?"version":\s*")[^"]+(")/, "version");
  await edit("desktop/src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, "[package] version");
  await edit("server/runtime/store.js", /(export const RUNTIME_VERSION = ")[^"]+(")/, "RUNTIME_VERSION");
  await edit("desktop/src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "agent-os-desktop"\r?\nversion = ")[^"]+(")/, "agent-os-desktop version");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log(`\nAll set to ${version}. Next: review the diff, commit, then tag v${version}.`);
