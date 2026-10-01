#!/usr/bin/env node
// Gets desktop/src-tauri/resources/ ready for `tauri build`:
//   resources/server  <- the esbuild server bundle + built UI (build/server)
//   resources/node    <- the app's own Node 24 runtime (scripts/fetch-node.mjs)
// Both folders are git-ignored; they are build output, not source.
// Called by the `desktop:prepare` / `desktop:build` scripts in package.json.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(root, "desktop", "src-tauri", "resources");

function run(command, args) {
  // shell:true so `npm` resolves to npm.cmd on Windows.
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`\n\`${command} ${args.join(" ")}\` failed. Fix that first, then run this again.`);
    process.exit(result.status ?? 1);
  }
}

async function main() {
  // Always rebuild the UI and server so the app never ships a stale bundle.
  run("npm", ["run", "build"]);
  run("npm", ["run", "build:server-bundle"]);

  const target = path.join(resources, "server");
  await rm(target, { recursive: true, force: true });
  await mkdir(resources, { recursive: true });
  await cp(path.join(root, "build", "server"), target, { recursive: true });
  console.log("Copied build/server -> desktop/src-tauri/resources/server");

  const nodeBinary = path.join(resources, "node", process.platform === "win32" ? "node.exe" : path.join("bin", "node"));
  if (!existsSync(nodeBinary)) {
    run("node", ["scripts/fetch-node.mjs"]);
  } else {
    console.log("Bundled Node already present (run `npm run desktop:fetch-node` to refresh it).");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
