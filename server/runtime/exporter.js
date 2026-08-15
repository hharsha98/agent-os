import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSampleSkillManifests } from "./skills.js";
import { defaultWorkflow } from "./workflows.js";
import { ensureRuntimeStore, runtimePaths, writeJson } from "./store.js";
import { forbiddenExportPatterns } from "./safety.js";

const EXCLUDED_NAMES = new Set([
  ".git",
  ".next",
  ".data",
  "node_modules",
  "dist",
  ".env",
  ".env.local",
  ".DS_Store",
  "tsconfig.tsbuildinfo"
]);

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function copyClean(src, dest) {
  const stat = await fs.stat(src);
  const name = path.basename(src);
  if (EXCLUDED_NAMES.has(name)) return;
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);
    for (const entry of entries) {
      await copyClean(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

async function scanFiles(root) {
  const files = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}

export async function auditExportDirectory(root) {
  const files = await scanFiles(root);
  const findings = [];
  const patterns = forbiddenExportPatterns();
  for (const file of files) {
    const relative = path.relative(root, file);
    if (/(png|jpg|jpeg|gif|webp|ico|zip|gz|lock)$/i.test(relative)) continue;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const rule of patterns) {
      if (rule.pattern.test(relative) || rule.pattern.test(text)) {
        findings.push({ file: relative, rule: rule.name });
      }
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    scannedFiles: files.length
  };
}

function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve) => {
    execFile("/usr/bin/zip", ["-r", "-X", zipPath, "."], { cwd: sourceDir, timeout: 60000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
        zipPath: !error ? zipPath : null
      });
    });
  });
}

export async function prepareExport({ sourceRoot, requestedBy = "local-admin" } = {}) {
  const paths = await ensureRuntimeStore();
  const exportId = `agent-os-export-${nowId()}`;
  const exportRoot = path.join(paths.exports, exportId);
  await fs.rm(exportRoot, { recursive: true, force: true });
  await copyClean(sourceRoot, exportRoot);

  await writeJson(path.join(exportRoot, "sample-data", "workflows", "blank-open-agent-builder.json"), {
    ...defaultWorkflow(),
    createdAt: "sample",
    updatedAt: "sample"
  });
  await writeJson(path.join(exportRoot, "sample-data", "skills", "catalog.json"), {
    note: "Export-safe sample skill manifests. Installed state, keys, logs, and private skill configuration are intentionally excluded.",
    skills: getSampleSkillManifests()
  });
  await writeJson(path.join(exportRoot, "sample-data", "README.json"), {
    note: "The package starts with one hidden blank builder workflow and no demonstration workflows. User configs, secrets, logs, local profiles, private skill configuration, and private workflow runs are intentionally excluded."
  });
  await writeJson(path.join(exportRoot, "EXPORT_MANIFEST.json"), {
    ok: true,
    exportId,
    package: "agent-os-runtime",
    note: "Clean local-first package with an empty user workspace. Configure your own API keys after install.",
    createdAt: new Date().toISOString()
  });

  const audit = await auditExportDirectory(exportRoot);
  if (!audit.ok) {
    const error = new Error("Export audit failed");
    error.status = 500;
    error.audit = audit;
    throw error;
  }

  const zipPath = path.join(paths.exports, `${exportId}.zip`);
  const zip = await zipDirectory(exportRoot, zipPath);
  const manifest = {
    ok: true,
    exportId,
    requestedBy,
    exportRoot,
    zipPath: zip.ok ? zipPath : null,
    zipCreated: zip.ok,
    audit,
    createdAt: new Date().toISOString()
  };
  return manifest;
}

export function assertAdminToken(req) {
  const expected = process.env.HERMES_AGENT_OS_ADMIN_TOKEN;
  if (!expected) {
    const error = new Error("Set HERMES_AGENT_OS_ADMIN_TOKEN before using export prepare.");
    error.status = 403;
    throw error;
  }
  const provided = req.get("x-hermes-admin-token") || req.body?.adminToken || req.query?.adminToken;
  if (provided !== expected) {
    const error = new Error("Invalid admin token.");
    error.status = 403;
    throw error;
  }
}
