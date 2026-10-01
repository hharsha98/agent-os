// Disk persistence for run manager state: one <id>.json (metadata, written
// atomically) plus one <id>.jsonl (append-only event log) per run, in their
// own folder so they never collide with the workflow-run store.
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "../store.js";

export async function runsDir() {
  await ensureRuntimeStore();
  const dir = path.join(runtimePaths().root, "agent-runs");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function metaFile(dir, id) {
  return path.join(dir, `${id}.json`);
}

export function eventsFile(dir, id) {
  return path.join(dir, `${id}.jsonl`);
}

export async function writeRunMeta(dir, meta) {
  return writeJson(metaFile(dir, meta.id), meta);
}

export async function readRunMeta(dir, id) {
  return readJson(metaFile(dir, id), null);
}

export async function appendRunEventLine(dir, id, line) {
  await fs.appendFile(eventsFile(dir, id), line);
}

export async function readRunEvents(dir, id, fromSeq = 0) {
  let raw;
  try {
    raw = await fs.readFile(eventsFile(dir, id), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && event.seq >= fromSeq);
}

export async function countRunEvents(dir, id) {
  return (await readRunEvents(dir, id, 0)).length;
}

export async function listRunIds(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => name.slice(0, -".json".length));
}
