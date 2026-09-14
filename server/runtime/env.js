import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function applyEnvValues(values, { override = false, env = process.env } = {}) {
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (!override && Object.hasOwn(env, key)) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { applied, skipped };
}

export function loadLocalEnv({
  root = DEFAULT_ROOT,
  filename = ".env",
  override = false,
  env = process.env
} = {}) {
  const filePath = path.resolve(root, filename);
  try {
    const parsed = parseEnvFile(readFileSync(filePath, "utf8"));
    const result = applyEnvValues(parsed, { override, env });
    return {
      ok: true,
      loaded: true,
      path: filePath,
      keys: Object.keys(parsed).length,
      ...result
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, loaded: false, path: filePath, keys: 0, applied: [], skipped: [] };
    }
    return {
      ok: false,
      loaded: false,
      path: filePath,
      keys: 0,
      applied: [],
      skipped: [],
      error: error?.message || "Could not read .env"
    };
  }
}
