#!/usr/bin/env node
// Bundles server/index.js into one file the desktop app can run straight out
// of its resources folder, with no repo checkout and no `npm install` step.
// See server/runtime/env.js (AGENT_OS_ENV_FILE), server/index.js
// (AGENT_OS_STATIC_DIR), and server/runtime/builder-service.js
// (AGENT_OS_PACKAGED) for the env overrides that make the bundle behave the
// same as running from source once import.meta.url no longer points at a
// real checkout.
//
//   node scripts/build-server-bundle.mjs                               # for this computer
//   node scripts/build-server-bundle.mjs --platform darwin --arch x64  # for another one
//
// --platform / --arch name the computer the app will run on (the same names as
// scripts/fetch-node.mjs). They choose which of node-pty's prebuilt binaries is
// copied next to the bundle (scripts/node-pty-bundle.mjs): the release workflow
// builds the Intel Mac app on an Apple-silicon runner.
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyNodePty, parseTargetArgs } from "./node-pty-bundle.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const outDir = path.join(root, "build", "server");

// The `ws` package tries to load two optional speed-ups, bufferutil and utf-8-validate, inside a
// try/catch and falls back to plain JavaScript when they are missing. They are not installed, and
// kept external their require() would search every folder above the installed app and load a native
// module found there. So both resolve to a small module inside the bundle that throws, which ws
// catches. (Do not set WS_NO_BUFFER_UTIL: ws then skips the lookup, but the bundle should not
// depend on an environment variable.)
const absentOptionalModules = {
  name: "absent-optional-modules",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (args) => ({ path: args.path, namespace: "agent-os-absent" }));
    esbuild.onLoad({ filter: /.*/, namespace: "agent-os-absent" }, () => ({ contents: 'throw new Error("not bundled");', loader: "js" }));
  }
};

async function main() {
  const target = parseTargetArgs(process.argv.slice(2));

  if (!existsSync(distDir)) {
    console.error(
      "dist/ is missing. Run `npm run build` first, then retry `npm run build:server-bundle`."
    );
    process.exit(1);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [path.join(root, "server", "index.js")],
    outfile: path.join(outDir, "server.mjs"),
    platform: "node",
    format: "esm",
    target: "node24",
    bundle: true,
    logLevel: "info",
    // @elizaos/core is optional (server/runtime/eliza.js already lazy-loads
    // it in a try/catch); the desktop app ships without it.
    // node-pty is a native module, so it cannot go inside server.mjs: it is
    // copied next to the bundle below, and server/runtime/sessions/pty-host.js
    // imports it on first use (a server without it still boots).
    // ws's optional bufferutil and utf-8-validate are not external: see
    // absentOptionalModules above.
    external: ["@elizaos/core", "node-pty"],
    plugins: [absentOptionalModules],
    banner: {
      js: 'import { createRequire as __agentOsCreateRequire } from "node:module"; const require = __agentOsCreateRequire(import.meta.url);'
    }
  });

  await cp(distDir, path.join(outDir, "web"), { recursive: true });

  // The small script that prints a saved OpenRouter key to Claude Code and
  // Codex (server/runtime/secrets/keystore.js looks for it next to the bundle).
  await cp(path.join(root, "server", "runtime", "secrets", "print-key.mjs"), path.join(outDir, "print-key.mjs"));

  // node-pty for the target computer, where Node looks for it from server.mjs:
  // ./node_modules/node-pty. Stops the build if the target has no prebuilt binary.
  const pty = await copyNodePty({
    from: path.join(root, "node_modules", "node-pty"),
    to: path.join(outDir, "node_modules", "node-pty"),
    platform: target.platform,
    arch: target.arch
  });
  console.log(`node-pty ${pty.prebuild} copied to ${path.relative(root, outDir)}/node_modules/node-pty (${pty.files.length} files)`);

  const pkg = require(path.join(root, "package.json"));
  await writeFile(
    path.join(outDir, "bundle.json"),
    JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), node: ">=24", target: pty.prebuild }, null, 2)
  );

  console.log(`Server bundle written to ${path.relative(root, outDir)}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
