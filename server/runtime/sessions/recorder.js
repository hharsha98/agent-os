// Session recordings: what a session's terminal showed. Output only: the
// input stream is never recorded, but text the agent echoes on screen, typed
// or pasted, is part of that output and so is in the recording.
//
// Format: asciicast v2, one JSON header line ({ version: 2, width, height,
// timestamp }) and then one JSON event per line: [seconds, type, data]. Only
// three event types are ever written: "o" (output), "m" (a marker, such as
// "--- resumed ---") and "r" (the terminal was resized, "<cols>x<rows>").
// There is no function for input ("i"), so input can never be recorded.
//
// Each session keeps at most two segments in <AGENT_OS_HOME>/sessions/<id>/:
// screen.cast (newest) and screen.prev.cast (older). When screen.cast would
// pass the segment size (25 MB), it becomes screen.prev.cast (the older one is
// deleted, so the oldest output goes first) and a new screen.cast starts with
// an "[earlier output removed]" marker. Every segment's header keeps the
// recording's start time, so the two can be read as one. All files are 0600.
// A 1 GB cap across all recordings removes the oldest ended ones first.
import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ensurePrivateDir, readJson, runtimePaths } from "../store.js";
import { SESSION_ID_RE, sessionError } from "./errors.js";

export const CAST_FILE = "screen.cast";
export const PREV_CAST_FILE = "screen.prev.cast";
export const SEGMENT_BYTES = 26214400; // 25 MB per segment
export const RECORDING_CAP_BYTES = 1073741824; // 1 GB across all recordings
export const ROTATION_MARKER = "[earlier output removed]";
export const RESUME_MARKER = "--- resumed ---";

const HEADER_READ_BYTES = 64 * 1024;
const TAIL_SCAN_BYTES = 64 * 1024;
const CLOSE_LIMIT_MS = 2000; // inside the 7 s the shutdown gives the sessions
const UNKNOWN_SESSION = "That session doesn't exist anymore.";
const RECORDING_MISSING = "That recording doesn't exist anymore.";
const RECORDING_LIVE = "That session is still running. Stop it first, then delete its recording.";
const isWindows = process.platform === "win32";

let removedByCap = 0;
let capChain = Promise.resolve();

function round6(seconds) {
  return Math.round(seconds * 1e6) / 1e6;
}

function eventLine(seconds, type, data) {
  return `${JSON.stringify([round6(seconds), type, data])}\n`;
}

function toSize(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 1000 ? number : fallback;
}

async function chmodPrivate(file) {
  if (!isWindows) await fs.chmod(file, 0o600);
}

// The header of an existing segment, or null when there is none to trust.
async function readHeader(file) {
  let handle = null;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline === -1) return null;
    const header = JSON.parse(text.slice(0, newline));
    if (header?.version !== 2 || !Number.isFinite(header.timestamp)) return null;
    return { timestamp: header.timestamp, bytes: Buffer.byteLength(text.slice(0, newline + 1)) };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// A hard kill or a full disk can leave the last line half written. Cuts the
// file back to the end of its last whole line (never into the header), so the
// next event starts on a line of its own.
async function cutTornLine(file, headerBytes) {
  const handle = await fs.open(file, "r+");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(TAIL_SCAN_BYTES);
    let end = size;
    while (end > headerBytes) {
      const start = Math.max(headerBytes, end - TAIL_SCAN_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline !== -1) {
        end = start + newline + 1;
        break;
      }
      end = start;
    }
    if (end !== size) await handle.truncate(end);
  } finally {
    await handle.close().catch(() => {});
  }
}

export function createRecorder({
  dir,
  cols,
  rows,
  segmentBytes = SEGMENT_BYTES,
  append = false,
  now = Date.now,
  onError
} = {}) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new TypeError("createRecorder needs the full path of the session's folder.");
  }
  const castPath = path.join(dir, CAST_FILE);
  const prevPath = path.join(dir, PREV_CAST_FILE);
  const limit = Number.isInteger(segmentBytes) && segmentBytes > 0 ? segmentBytes : SEGMENT_BYTES;
  const report =
    typeof onError === "function"
      ? onError
      : (error) => console.warn(`Agent OS: a session recording stopped: ${error.message}`);
  let width = toSize(cols, 80);
  let height = toSize(rows, 24);
  let startMs = Math.floor(now() / 1000) * 1000; // headers hold whole seconds
  let lastSeconds = 0;
  let handle = null;
  let segmentSize = 0;
  let segmentOutputs = 0;
  let queue = [];
  let flushing = null;
  let closed = false;
  let broken = false;
  let closing = null;

  function fail(error) {
    if (broken) return;
    broken = true;
    queue = [];
    try {
      report(error);
    } catch {
      // reporting must never throw into the session
    }
  }

  async function startSegment() {
    const header = `${JSON.stringify({ version: 2, width, height, timestamp: Math.floor(startMs / 1000) })}\n`;
    await fs.writeFile(castPath, header, { mode: 0o600 });
    await chmodPrivate(castPath);
    handle = await fs.open(castPath, "a");
    segmentSize = Buffer.byteLength(header);
    segmentOutputs = 0;
  }

  async function open() {
    try {
      await ensurePrivateDir(dir);
      const existing = append ? await readHeader(castPath) : null;
      if (existing) {
        // Resume: keep the timeline, write no second header.
        startMs = existing.timestamp * 1000;
        await chmodPrivate(castPath);
        await cutTornLine(castPath, existing.bytes);
        handle = await fs.open(castPath, "a");
        segmentSize = (await handle.stat()).size;
        segmentOutputs = segmentSize > existing.bytes ? 1 : 0;
      } else {
        const older = append ? await readHeader(prevPath) : null;
        if (older) startMs = older.timestamp * 1000;
        await startSegment();
      }
    } catch (error) {
      fail(error);
    }
  }
  const ready = open();

  async function rotate(seconds) {
    await handle.close();
    handle = null;
    await fs.rm(prevPath, { force: true }); // the oldest output goes first
    await fs.rename(castPath, prevPath);
    await startSegment();
    const marker = eventLine(seconds, "m", ROTATION_MARKER);
    await handle.appendFile(marker);
    segmentSize += Buffer.byteLength(marker);
  }

  async function writeBatch(batch) {
    let text = "";
    for (const item of batch) {
      const seconds = Math.max(lastSeconds, (item.at - startMs) / 1000);
      lastSeconds = seconds;
      if (item.type === "r") {
        width = item.cols;
        height = item.rows;
      }
      const line = eventLine(seconds, item.type, item.data);
      const bytes = Buffer.byteLength(line);
      if (item.type === "o" && segmentOutputs > 0 && segmentSize + bytes > limit) {
        if (text) {
          await handle.appendFile(text);
          text = "";
        }
        await rotate(seconds);
      }
      text += line;
      segmentSize += bytes;
      if (item.type === "o") segmentOutputs += 1;
    }
    if (text) await handle.appendFile(text);
  }

  async function drain() {
    await ready;
    try {
      while (queue.length > 0 && !broken) {
        const batch = queue;
        queue = [];
        await writeBatch(batch);
      }
    } catch (error) {
      fail(error);
    } finally {
      flushing = null;
    }
  }

  function enqueue(item) {
    if (closed || broken) return;
    queue.push(item);
    if (!flushing) flushing = drain();
  }

  async function finish() {
    await ready;
    while (flushing) await flushing;
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
    }
  }

  // A stalled disk must not hold the session (and the shutdown) for ever: after
  // CLOSE_LIMIT_MS the rest of the recording is given up and reported once.
  // The write that is still stuck ends, and closes the file, whenever the disk
  // answers; nothing more is written after that.
  async function closeWithinLimit() {
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(resolve, CLOSE_LIMIT_MS, "timeout");
    });
    const outcome = await Promise.race([finish().then(() => "done"), timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      fail(new Error("the last part of the recording could not be saved within 2 seconds"));
    }
  }

  if (append) {
    const at = now();
    enqueue({ at, type: "m", data: RESUME_MARKER });
    enqueue({ at, type: "r", data: `${width}x${height}`, cols: width, rows: height });
  }

  return Object.freeze({
    output(chunk) {
      if (typeof chunk !== "string" || chunk.length === 0) return;
      enqueue({ at: now(), type: "o", data: chunk });
    },
    marker(text) {
      const label = String(text ?? "").trim();
      if (label) enqueue({ at: now(), type: "m", data: label });
    },
    resize(nextCols, nextRows) {
      const newCols = toSize(nextCols, 0);
      const newRows = toSize(nextRows, 0);
      if (!newCols || !newRows) return;
      enqueue({ at: now(), type: "r", data: `${newCols}x${newRows}`, cols: newCols, rows: newRows });
    },
    close() {
      if (!closing) {
        closed = true;
        closing = closeWithinLimit();
      }
      return closing;
    }
  });
}

// Never build a path from an id that is not a session id (no "../").
function sessionDirFor(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw sessionError(404, "unknown_session", UNKNOWN_SESSION);
  }
  return path.join(runtimePaths().sessions, sessionId);
}

async function sizeOf(file) {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return null;
  }
}

// Both segments together, or null when the session has no recording file.
async function recordingBytes(dir) {
  const [cast, prev] = await Promise.all([sizeOf(path.join(dir, CAST_FILE)), sizeOf(path.join(dir, PREV_CAST_FILE))]);
  if (cast === null && prev === null) return null;
  return (cast ?? 0) + (prev ?? 0);
}

// Removes the recording files only. meta.json stays, so the ended tab and
// Resume keep working; a resume then starts a new recording.
// Both files are unlinked in the same turn (no wait between them), so a Resume
// cannot slip in between the two. A file that is already gone is fine; any
// other failure is thrown after both were tried. Returns whether any file went.
async function removeCastFiles(dir) {
  const results = await Promise.allSettled([CAST_FILE, PREV_CAST_FILE].map((name) => fs.unlink(path.join(dir, name))));
  let removed = false;
  let failure = null;
  for (const result of results) {
    if (result.status === "fulfilled") removed = true;
    else if (result.reason?.code !== "ENOENT") failure ??= result.reason;
  }
  if (failure) throw failure;
  return removed;
}

async function readMeta(dir) {
  const meta = await readJson(path.join(dir, "meta.json"), null);
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : null;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// The session manager knows best (isLive); without it, meta.json decides.
function liveFor(sessionId, meta, isLive) {
  if (typeof isLive === "function") return Boolean(isLive(sessionId));
  return meta.status !== "exited" && !meta.endedAt;
}

// Asked again right before a removal: the answer can change while the caller
// waited (a Resume between the decision and the removal). With the manager's
// isLive the answer is immediate; without one, meta.json is read again.
async function isEndedNow(sessionId, dir, isLive) {
  if (typeof isLive === "function") return !isLive(sessionId);
  const meta = await readMeta(dir);
  return meta === null || !liveFor(sessionId, meta);
}

// When the recording itself began, as an ISO time, or null when no header can be read. A resume does not change it
// (the recorder keeps the first header and appends on the same timeline), unlike meta.startedAt, which a resume
// resets to the latest start. Both segments keep the recording's start, so the newest one is read first.
async function recordingStart(dir) {
  const header = (await readHeader(path.join(dir, CAST_FILE))) ?? (await readHeader(path.join(dir, PREV_CAST_FILE)));
  return header ? new Date(header.timestamp * 1000).toISOString() : null;
}

// `firstStartedAt` is additive: startedAt keeps meaning "the latest start" (the sort order and the Sessions list use
// it), and Runs shows firstStartedAt as Recorded and measures Length from it.
function summary(sessionId, meta, bytes, live, firstStartedAt) {
  const folder = text(meta.folder);
  return {
    sessionId,
    kind: meta.kind === "update" ? "update" : "agent",
    agentId: text(meta.agentId),
    agentLabel: text(meta.agentLabel) || text(meta.agentId),
    folder,
    folderName: text(meta.folderName) || (folder ? path.basename(folder) : ""),
    folderShown: meta.folderShown !== false,
    // A session that ran in a separate copy (R25): the project it copied, kept in meta.json after the copy was removed,
    // and the copy's branch. `folder` is then the copy's own folder, which is not where the person works.
    copyOf: text(meta.copyOf) || null,
    branch: text(meta.branch) || null,
    startedAt: meta.startedAt,
    firstStartedAt,
    endedAt: text(meta.endedAt) || null,
    bytes,
    live
  };
}

export async function listRecordings({ isLive } = {}) {
  const root = runtimePaths().sessions;
  let names;
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const recordings = [];
  for (const name of names) {
    if (!SESSION_ID_RE.test(name)) continue;
    const dir = path.join(root, name);
    const meta = await readMeta(dir);
    // Every meta.json the manager writes has its start time; without one it
    // is not a session Agent OS knows how to show.
    if (!meta || !text(meta.startedAt)) continue;
    const bytes = await recordingBytes(dir);
    if (bytes === null) continue;
    // Only a resumed session can differ (meta.resumes above 0): the others skip the extra read.
    const first = Number(meta.resumes) > 0 ? await recordingStart(dir) : null;
    recordings.push(summary(name, meta, bytes, liveFor(name, meta, isLive), first ?? meta.startedAt));
  }
  recordings.sort((a, b) => compareText(b.startedAt, a.startedAt) || compareText(a.sessionId, b.sessionId));
  return recordings;
}

function endKey(recording) {
  return recording.endedAt || recording.startedAt;
}

async function applyRecordingCap({ capBytes = RECORDING_CAP_BYTES, isLive } = {}) {
  const cap = Number.isFinite(capBytes) && capBytes >= 0 ? capBytes : RECORDING_CAP_BYTES;
  const recordings = await listRecordings({ isLive });
  let total = recordings.reduce((sum, recording) => sum + recording.bytes, 0);
  const deleted = [];
  if (total <= cap) return { deleted };
  const ended = recordings
    .filter((recording) => !recording.live)
    .sort((a, b) => compareText(endKey(a), endKey(b)) || compareText(a.sessionId, b.sessionId));
  const root = runtimePaths().sessions;
  for (const recording of ended) {
    if (total <= cap) break;
    const dir = path.join(root, recording.sessionId);
    if (!(await isEndedNow(recording.sessionId, dir, isLive))) continue; // it started again
    try {
      if (await removeCastFiles(dir)) {
        total -= recording.bytes;
        deleted.push(recording.sessionId);
      }
    } catch {
      // This folder can't be cleaned up (permissions, a file in use): leave it,
      // count only what really went, and carry on with the next one.
      total -= recording.bytes - ((await recordingBytes(dir)) ?? 0);
    }
  }
  removedByCap += deleted.length;
  return { deleted };
}

// Runs one at a time: two sessions that end together do not both delete.
export function enforceRecordingCap(options = {}) {
  const run = () => applyRecordingCap(options);
  const result = capChain.then(run, run);
  capChain = result.then(
    () => {},
    () => {}
  );
  return result;
}

// How many recordings the 1 GB cap removed since this server started. The
// Session recordings tab shows "Older recordings were removed to stay under
// 1 GB." while this is above 0.
export function recordingsRemovedByCap() {
  return removedByCap;
}

export async function deleteRecording(sessionId, { isLive } = {}) {
  const dir = sessionDirFor(sessionId);
  const meta = await readMeta(dir);
  if (!meta) throw sessionError(404, "unknown_session", UNKNOWN_SESSION);
  if (liveFor(sessionId, meta, isLive)) throw sessionError(409, "recording_live", RECORDING_LIVE);
  if (!(await isEndedNow(sessionId, dir, isLive))) throw sessionError(409, "recording_live", RECORDING_LIVE);
  if (!(await removeCastFiles(dir))) throw sessionError(404, "recording_missing", RECORDING_MISSING);
  return { ok: true };
}

// A segment file, opened once and read through that handle until the stream
// ends: if the live session rotates or the recording is deleted meanwhile, this
// file still reads as it was, so no segment is skipped. null when there is no
// such file. `size` is its size at that moment.
async function openSegment(file) {
  let handle = null;
  try {
    handle = await fs.open(file, "r");
    return { handle, size: (await handle.stat()).size };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

function closeSegments(...segments) {
  return Promise.all(segments.map((segment) => segment?.handle.close().catch(() => {})));
}

// Complete lines of a segment as it was when it was opened, each ending with
// "\n". A last line without its newline is still being written, so it is left
// out.
async function* fileLines(segment) {
  if (!segment || !segment.size) return;
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES);
  let rest = "";
  let position = 0;
  while (position < segment.size) {
    const wanted = Math.min(buffer.length, segment.size - position);
    const { bytesRead } = await segment.handle.read(buffer, 0, wanted, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    rest += decoder.write(buffer.subarray(0, bytesRead));
    let start = 0;
    let newline = rest.indexOf("\n", start);
    while (newline !== -1) {
      yield rest.slice(start, newline + 1);
      start = newline + 1;
      newline = rest.indexOf("\n", start);
    }
    rest = rest.slice(start);
  }
}

function isRotationMarker(line) {
  try {
    const event = JSON.parse(line);
    return Array.isArray(event) && event[1] === "m" && event[2] === ROTATION_MARKER;
  } catch {
    return false;
  }
}

// One header, the older segment's events, then the newer segment's events.
// The newer segment's leading rotation marker is left out: the removed output
// came before the older segment, so the only true place for that marker is
// the very start (where the older segment's own marker already is).
async function* recordingLines(cast, prev) {
  try {
    let headerSent = false;
    for await (const line of fileLines(prev)) {
      headerSent = true;
      yield line;
    }
    let index = 0;
    for await (const line of fileLines(cast)) {
      index += 1;
      if (index === 1) {
        if (!headerSent) yield line;
        headerSent = true;
        continue;
      }
      if (index === 2 && prev && isRotationMarker(line)) continue;
      yield line;
    }
  } finally {
    await closeSegments(cast, prev);
  }
}

// For GET /api/sessions/:id/recording (Q26): checks before anything is sent,
// then streams the recording as one asciicast v2 file. Both files are opened
// here, at the start, and closed when the stream ends, fails or is dropped
// (return(), even before the first line was read).
export async function openRecording(sessionId) {
  const dir = sessionDirFor(sessionId);
  // The newer file first: a rotation between the two opens can then only show
  // the same file twice, never leave a hole.
  const cast = await openSegment(path.join(dir, CAST_FILE));
  const prev = await openSegment(path.join(dir, PREV_CAST_FILE));
  if (cast === null && prev === null) {
    if (!(await readMeta(dir))) throw sessionError(404, "unknown_session", UNKNOWN_SESSION);
    throw sessionError(404, "recording_missing", RECORDING_MISSING);
  }
  const lines = recordingLines(cast, prev);
  const stop = lines.return.bind(lines);
  lines.return = async (value) => {
    try {
      return await stop(value);
    } finally {
      await closeSegments(cast, prev);
    }
  };
  return { lines };
}
