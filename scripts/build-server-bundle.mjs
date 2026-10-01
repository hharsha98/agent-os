#!/usr/bin/env node
// Bundles server/index.js into one file the desktop app can run straight out
// of its resources folder, with no repo checkout and no `npm install` step.
// See server/runtime/env.js (AGENT_OS_ENV_FILE), server/index.js
// (AGENT_OS_STATIC_DIR), and server/runtime/builder-service.js
// (AGENT_OS_PACKAGED) for the env overrides that make the bundle behave the
// same as running from source once import.meta.url no longer points at a
// real checkout.
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const outDir = path.join(root, "build", "server");

async function main() {
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
    external: ["@elizaos/core"],
    banner: {
      js: 'import { createRequire as __agentOsCreateRequire } from "node:module"; const require = __agentOsCreateRequire(import.meta.url);'
    }
  });

  await cp(distDir, path.join(outDir, "web"), { recursive: true });

  const pkg = require(path.join(root, "package.json"));
  await writeFile(
    path.join(outDir, "bundle.json"),
    JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), node: ">=24" }, null, 2)
  );

  console.log(`Server bundle written to ${path.relative(root, outDir)}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
