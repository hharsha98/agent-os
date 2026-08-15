#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareExport } from "../server/runtime/exporter.js";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

try {
  const manifest = await prepareExport({ sourceRoot: root, requestedBy: "cli" });
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  console.error(error.audit ? JSON.stringify(error.audit, null, 2) : error.message);
  process.exit(1);
}
