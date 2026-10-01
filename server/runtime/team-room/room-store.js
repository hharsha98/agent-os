// Disk storage for Team Rooms. One folder per room under <data dir>/teams/:
//
//   meta.json      the room's state (status, limits, turn count, cost)
//   events.jsonl   the transcript: one JSON event per line, with a seq number
//   notebook.md    the shared notebook the agents write to
//   decision.json  { proposals: [...], actions: [...] }
//   backups/       copies of files a room overwrote, so Undo can restore them
//
// Several things can touch one room at once (the turn loop, an HTTP request
// approving a proposal, an Undo), so every read-modify-write goes through a
// small per-room queue ("lock") and can never overwrite another's change.
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, runtimePaths, writeJson } from "../store.js";

export const ROOM_ID_PATTERN = /^room-\d{8}-\d{6}-[0-9a-f]{4}$/;
export const PROPOSAL_ID_PATTERN = /^P\d{1,4}$/;
export const ACTION_ID_PATTERN = /^A\d{1,4}$/;

// Anything that came from a CLI or from a file-system error may contain a
// real folder path (and with it, a user name). Before it is stored or sent to
// the browser, the home folder becomes "~" and the Agent OS data folder
// becomes a placeholder.
export function scrubPaths(text) {
  let out = String(text ?? "");
  const replacements = [
    // Home first: a data folder inside it then reads as ~/..., which is clearer.
    [os.homedir(), "~"],
    [runtimePaths().root, "<agent-os-data>"]
  ];
  for (const [dir, label] of replacements) {
    // Never replace something as short as "/" (it would mangle every path).
    if (typeof dir === "string" && dir.length >= 3) out = out.split(dir).join(label);
  }
  return out;
}

// An error the router turns straight into an HTTP reply: status + JSON body.
export function roomError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.body = { ok: false, error: code, message, ...extra };
  return error;
}

export function isValidRoomId(id) {
  return typeof id === "string" && ROOM_ID_PATTERN.test(id);
}

export function teamsDir() {
  return path.join(runtimePaths().root, "teams");
}

// Every path in this module goes through here, so an id that does not match
// the strict pattern can never reach the file system.
export function roomDir(roomId) {
  if (!isValidRoomId(roomId)) {
    throw roomError(404, "room_not_found", "Room not found.");
  }
  return path.join(teamsDir(), roomId);
}

export function backupsDir(roomId) {
  return path.join(roomDir(roomId), "backups");
}

// "room-20260102-030405-ab12" -> "20260102-030405-ab12": the one folder name
// under workspace/team/ that holds the files this room wrote.
export function roomShort(roomId) {
  return String(roomId).replace(/^room-/, "");
}

// ---- tiny per-key queue ----------------------------------------------------

const queues = new Map();

function withLock(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  // Keep the chain alive even if this task throws; the caller still sees the error.
  queues.set(
    key,
    next.catch(() => {})
  );
  return next;
}

// ---- rooms -----------------------------------------------------------------

function stamp(date) {
  const iso = date.toISOString(); // 2026-01-02T03:04:05.678Z
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

export async function createRoom({ task, limits }) {
  await fs.mkdir(teamsDir(), { recursive: true });
  const created = new Date();
  let id = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    id = `room-${stamp(created)}-${crypto.randomBytes(2).toString("hex")}`;
    try {
      await fs.mkdir(roomDir(id)); // not recursive: fails if the id is taken
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 19) throw error;
    }
  }
  const nowIso = created.toISOString();
  const meta = {
    id,
    task,
    status: "running",
    createdAt: nowIso,
    updatedAt: nowIso,
    endedAt: null,
    limits,
    turnsAllowed: limits.maxTurns,
    turnsDone: 0,
    clockStartedAt: nowIso,
    currentTurn: null,
    // null until a turn reports a cost; unknown costs are counted apart,
    // never added as 0 (see costUnknownTurns).
    costUsd: null,
    costKnownTurns: 0,
    costUnknownTurns: 0,
    endReason: null,
    folder: roomShort(id)
  };
  await writeJson(path.join(roomDir(id), "meta.json"), meta);
  await writeJson(path.join(roomDir(id), "decision.json"), { proposals: [], actions: [] });
  await fs.writeFile(path.join(roomDir(id), "notebook.md"), "", { mode: 0o600 });
  return meta;
}

export async function readRoom(roomId) {
  if (!isValidRoomId(roomId)) return null;
  return readJson(path.join(roomDir(roomId), "meta.json"), null);
}

// Applies `change(meta)` (mutating it, or returning a new object) under the
// room's lock and saves the result.
export function updateRoom(roomId, change) {
  return withLock(`${roomId}:meta`, async () => {
    const meta = await readRoom(roomId);
    if (!meta) return null;
    const result = (await change(meta)) || meta;
    result.updatedAt = new Date().toISOString();
    await writeJson(path.join(roomDir(roomId), "meta.json"), result);
    return result;
  });
}

export async function listRoomIds() {
  let entries;
  try {
    entries = await fs.readdir(teamsDir());
  } catch {
    return [];
  }
  // The id starts with a timestamp, so a plain sort is chronological.
  return entries.filter(isValidRoomId).sort().reverse();
}

export async function listRooms({ limit = 100 } = {}) {
  const ids = (await listRoomIds()).slice(0, limit);
  const rooms = [];
  for (const id of ids) {
    const meta = await readRoom(id);
    if (!meta) continue;
    const decision = await readDecision(id);
    rooms.push(summarizeRoom(meta, decision));
  }
  return rooms;
}

export function summarizeRoom(meta, decision) {
  const proposals = decision?.proposals || [];
  return {
    id: meta.id,
    task: meta.task,
    status: meta.status,
    createdAt: meta.createdAt,
    endedAt: meta.endedAt,
    endReason: meta.endReason,
    turnsDone: meta.turnsDone,
    turnsAllowed: meta.turnsAllowed,
    costUsd: meta.costUsd,
    costUnknownTurns: meta.costUnknownTurns,
    openProposals: proposals.filter((p) => p.status === "open").length,
    needsApproval: proposals.filter((p) => p.status === "needs_approval").length,
    actions: (decision?.actions || []).length
  };
}

// ---- decision.json (proposals + actions) ------------------------------------

export async function readDecision(roomId) {
  const decision = await readJson(path.join(roomDir(roomId), "decision.json"), null);
  return {
    proposals: Array.isArray(decision?.proposals) ? decision.proposals : [],
    actions: Array.isArray(decision?.actions) ? decision.actions : []
  };
}

// Read-modify-write under the lock. `change(decision)` may mutate it and may
// return a value, which is passed back to the caller.
export function updateDecision(roomId, change) {
  return withLock(`${roomId}:decision`, async () => {
    const decision = await readDecision(roomId);
    const value = await change(decision);
    await writeJson(path.join(roomDir(roomId), "decision.json"), decision);
    return value;
  });
}

// ---- notebook ----------------------------------------------------------------

export async function readNotebook(roomId) {
  try {
    return await fs.readFile(path.join(roomDir(roomId), "notebook.md"), "utf8");
  } catch {
    return "";
  }
}

export function appendNotebook(roomId, text) {
  return withLock(`${roomId}:notebook`, () =>
    fs.appendFile(path.join(roomDir(roomId), "notebook.md"), `${text}\n\n`, "utf8")
  );
}

// ---- transcript events -------------------------------------------------------

const nextSeqByRoom = new Map();
const subscribers = new Map();

function eventsFile(roomId) {
  return path.join(roomDir(roomId), "events.jsonl");
}

export async function readEvents(roomId, fromSeq = 0) {
  let raw;
  try {
    raw = await fs.readFile(eventsFile(roomId), "utf8");
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

// Appends one event to the transcript, then tells live subscribers (the SSE
// stream). Written to disk first, so anyone who sees an event live can also
// find it when they reconnect and replay.
export function appendEvent(roomId, partial) {
  return withLock(`${roomId}:events`, async () => {
    // Keyed by folder as well as id: a fresh data dir (as in tests) must not
    // inherit a counter from an older folder that happened to share an id.
    const key = `${teamsDir()}|${roomId}`;
    if (!nextSeqByRoom.has(key)) {
      const existing = await readEvents(roomId, 0);
      nextSeqByRoom.set(key, existing.length ? existing[existing.length - 1].seq + 1 : 0);
    }
    const seq = nextSeqByRoom.get(key);
    nextSeqByRoom.set(key, seq + 1);
    const event = { seq, t: new Date().toISOString(), ...partial };
    await fs.appendFile(eventsFile(roomId), `${JSON.stringify(event)}\n`, "utf8");
    for (const listener of subscribers.get(roomId) || []) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the room
      }
    }
    return event;
  });
}

export function subscribeRoom(roomId, listener) {
  if (!subscribers.has(roomId)) subscribers.set(roomId, new Set());
  subscribers.get(roomId).add(listener);
  return () => {
    const set = subscribers.get(roomId);
    if (!set) return;
    set.delete(listener);
    if (!set.size) subscribers.delete(roomId);
  };
}
