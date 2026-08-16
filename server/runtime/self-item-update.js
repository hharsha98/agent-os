import path from "node:path";
import { ensureRuntimeStore, readJson, writeJson } from "./store.js";
import { getSelfModuleState, isLocalSelfModule } from "./self-modules.js";

export async function updateSelfModuleItem(id, itemId, payload = {}) {
  if (!isLocalSelfModule(id)) {
    const error = new Error("self module not found");
    error.statusCode = 404;
    throw error;
  }
  const paths = await ensureRuntimeStore();
  const file = path.join(paths.memory, "self-modules", `${id}.json`);
  const current = await readJson(file, { items: [] });
  const items = Array.isArray(current.items) ? current.items : [];
  const index = items.findIndex((item) => item && item.id === itemId);
  if (index < 0) {
    const error = new Error("self module item not found");
    error.statusCode = 404;
    throw error;
  }
  const existing = items[index];
  const updatedAt = new Date().toISOString();
  const blocked = new Set(["id", "createdAt"]);
  const patch = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (!blocked.has(key) && value !== undefined) patch[key] = value;
  }
  items[index] = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt
  };
  await writeJson(file, { ...current, items, updatedAt });
  return getSelfModuleState(id);
}
