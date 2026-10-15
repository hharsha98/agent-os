#!/usr/bin/env node
// Gets desktop/src-tauri/resources/ ready for `tauri build`:
//   resources/server  <- the esbuild server bundle + built UI (build/server), with
//                        node-pty's prebuilt binary for the target computer
//   resources/node    <- the app's own Node 24 runtime (scripts/fetch-node.mjs)
// Both folders are git-ignored; they are build output, not source.
// Called by the `desktop:prepare` / `desktop:build` scripts in package.json.
//
//   node scripts/prepare-desktop.mjs
//   node scripts/prepare-desktop.mjs --skip-node --platform darwin --arch x64
//
// --platform / --arch name the TARGET computer (default: this one), with the
// same names as scripts/fetch-node.mjs. They pick node-pty's prebuilt binary
// for the server bundle, and the Node to fetch when --skip-node is not given.
// --skip-node never fetches Node. The release workflow fetches the TARGET's
// Node first (the Intel Mac app is built on an Apple-silicon runner), and
// this script must not swap the host's Node in over it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTargetArgs } from "./node-pty-bundle.mjs";

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
  const target = parseTargetArgs(process.argv.slice(2));

  // Always rebuild the UI and server so the app never ships a stale bundle.
  run("npm", ["run", "build"]);
  run("npm", ["run", "build:server-bundle", "--", "--platform", target.platform, "--arch", target.arch]);

  // Before the --skip-node check below: the release workflow always passes
  // --skip-node, and the server bundle (with node-pty for the target) must
  // reach resources/ in every build.
  const server = path.join(resources, "server");
  await rm(server, { recursive: true, force: true });
  await mkdir(resources, { recursive: true });
  await cp(path.join(root, "build", "server"), server, { recursive: true });
  console.log(`Copied build/server -> desktop/src-tauri/resources/server (node-pty for ${target.platform}-${target.arch})`);

  if (process.argv.includes("--skip-node")) {
    console.log("--skip-node: leaving resources/node exactly as it is.");
    return;
  }
  const nodeBinary = path.join(resources, "node", target.platform === "win32" ? "node.exe" : path.join("bin", "node"));
  if (!existsSync(nodeBinary)) {
    run("node", ["scripts/fetch-node.mjs", "--platform", target.platform, "--arch", target.arch]);
  } else {
    console.log("Bundled Node already present (run `npm run desktop:fetch-node` to refresh it).");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
