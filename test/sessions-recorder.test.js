// Session recordings (asciicast v2): output only, never input; two segments of
// 25 MB with the oldest output dropped first; a marker when a resumed session
// continues; a 1 GB cap across all recordings that never touches a live one;
// and listing, streaming and deleting them. Everything is written to a temp
// AGENT_OS_HOME only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fsPromises, readdirSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SESSION_ID_RE, errorBody, isSessionId, sessionError } from "../server/runtime/sessions/errors.js";
import {
  CAST_FILE,
  PREV_CAST_FILE,
  RECORDING_CAP_BYTES,
  RESUME_MARKER,
  ROTATION_MARKER,
  SEGMENT_BYTES,
  createRecorder,
  deleteRecording,
  enforceRecordingCap,
  listRecordings,
  openRecording,
  recordingsRemovedByCap
} from "../server/runtime/sessions/recorder.js";

const isWindows = process.platform === "win32";
const START = 1_760_000_000_000; // a whole second, so event times come out exact

function makeClock(start = START) {
  let current = start;
  return {
    now: () => current,
    tick: (ms) => {
      current += ms;
    }
  };
}

async function withTempHome(fn) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-recorder-home-")));
  const previous = process.env.AGENT_OS_HOME;
  process.env.AGENT_OS_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_HOME;
    else process.env.AGENT_OS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

function sessionDir(home, id) {
  return path.join(home, "sessions", id);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readCast(file) {
  const text = await readFile(file, "utf8");
  assert.ok(text.endsWith("\n"), `${path.basename(file)}: every line ends with a newline`);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function collectLines(lines) {
  const out = [];
  for await (const line of lines) out.push(line);
  return out;
}

// Lets a test change the append handle the recorder opens for screen.cast (to
// make a write fail or stall after the recording started), then puts the real
// open back.
async function withAppendHandle(wrap, fn) {
  const realOpen = fsPromises.open;
  fsPromises.open = async (file, flags, ...rest) => {
    const handle = await realOpen.call(fsPromises, file, flags, ...rest);
    if (flags === "a" && path.basename(String(file)) === CAST_FILE) wrap(handle);
    return handle;
  };
  try {
    return await fn();
  } finally {
    fsPromises.open = realOpen;
  }
}

// A session folder the way S6 leaves it: meta.json, and optionally cast files.
async function makeSession(home, { meta = {}, cast = null, prev = null } = {}) {
  const id = crypto.randomUUID();
  const dir = sessionDir(home, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      kind: "agent",
      agentId: "claude",
      agentLabel: "Claude Code",
      folder: "/Users/you/projects/app",
      folderName: "app",
      folderShown: true,
      status: "exited",
      startedAt: "2026-10-14T09:00:00.000Z",
      endedAt: "2026-10-14T09:30:00.000Z",
      ...meta
    })
  );
  if (cast !== null) await writeFile(path.join(dir, CAST_FILE), cast);
  if (prev !== null) await writeFile(path.join(dir, PREV_CAST_FILE), prev);
  return id;
}

// 40 numbered chunks of about 330 bytes each into 4 KB segments: three
// rotations, so the first segment is gone and both files start with a marker.
async function recordChunks(dir) {
  const clock = makeClock();
  const recorder = createRecorder({ dir, cols: 80, rows: 24, segmentBytes: 4096, now: clock.now });
  for (let i = 0; i < 40; i += 1) {
    clock.tick(100);
    recorder.output(`chunk-${String(i).padStart(2, "0")} ${"x".repeat(300)}\r\n`);
  }
  await recorder.close();
}

// errors.js is S3's module (ruling R4); this test pins the parts the recorder
// relies on, and the answer the routes build from a recorder error.
test("sessionError (from S3) carries status, code, message and extra, errorBody is its answer, and SESSION_ID_RE accepts only randomUUID ids", () => {
  const error = sessionError(400, "folder_refused", "Your home folder itself can't be used. Pick a folder inside it.", {
    code: "is_home"
  });
  assert.ok(error instanceof Error);
  assert.equal(error.status, 400);
  assert.equal(error.code, "folder_refused");
  assert.equal(error.message, "Your home folder itself can't be used. Pick a folder inside it.");
  assert.deepEqual(error.extra, { code: "is_home" });
  assert.equal("body" in error, false, "one error shape: no .body");
  assert.deepEqual(errorBody(error), {
    error: "folder_refused",
    message: "Your home folder itself can't be used. Pick a folder inside it.",
    code: "is_home"
  });
  // A recorder error passes no extra, so its answer is exactly { error, message }.
  const missing = sessionError(404, "recording_missing", "That recording doesn't exist anymore.");
  assert.ok(missing instanceof Error);
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "recording_missing");
  assert.equal(missing.message, "That recording doesn't exist anymore.");
  assert.deepEqual(errorBody(missing), { error: "recording_missing", message: "That recording doesn't exist anymore." });

  const id = crypto.randomUUID();
  assert.ok(SESSION_ID_RE.test(id));
  assert.equal(isSessionId(id), true);
  for (const bad of [id.toUpperCase(), "../etc/passwd", "", "6ba7b810-9dad-11d1-80b4-00c04fd430c8", `${id}/..`, null, 42]) {
    assert.equal(isSessionId(bad), false, String(bad));
  }
});

test("a recording is asciicast v2 with output, marker and resize events only, in private files", async () => {
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    const clock = makeClock();
    const recorder = createRecorder({ dir, cols: 100, rows: 30, now: clock.now });
    assert.equal("input" in recorder, false, "there is no way to record input");
    clock.tick(500);
    recorder.output("hello\r\n");
    clock.tick(250);
    recorder.output("\x1b[31mred\x1b[0m");
    clock.tick(250);
    recorder.resize(90, 25);
    clock.tick(1000);
    recorder.marker("checkpoint");
    await recorder.close();

    const [header, ...events] = await readCast(path.join(dir, CAST_FILE));
    assert.deepEqual(header, { version: 2, width: 100, height: 30, timestamp: 1760000000 });
    assert.deepEqual(events, [
      [0.5, "o", "hello\r\n"],
      [0.75, "o", "\x1b[31mred\x1b[0m"],
      [1, "r", "90x25"],
      [2, "m", "checkpoint"]
    ]);
    if (!isWindows) {
      assert.equal((await stat(dir)).mode & 0o777, 0o700, "the session folder is private");
      assert.equal((await stat(path.join(dir, CAST_FILE))).mode & 0o777, 0o600, "the recording is private");
    }
  });
});

test("output after close is ignored, close returns the same promise, and empty or non-text output is skipped", async () => {
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    const clock = makeClock();
    const recorder = createRecorder({ dir, cols: 80, rows: 24, now: clock.now });
    clock.tick(100);
    recorder.output("");
    recorder.output(Buffer.from("not text"));
    recorder.output("kept");
    recorder.marker("   ");
    recorder.resize(0, 24);
    const closing = recorder.close();
    recorder.output("too late");
    assert.equal(recorder.close(), closing);
    await closing;
    const [, ...events] = await readCast(path.join(dir, CAST_FILE));
    assert.deepEqual(events, [[0.1, "o", "kept"]]);
  });
});

test("a recording that cannot be written reports once and never throws into the session", async () => {
  assert.throws(() => createRecorder({ dir: "relative/folder", cols: 80, rows: 24 }), TypeError);
  await withTempHome(async (home) => {
    const notAFolder = path.join(home, "a-file");
    await writeFile(notAFolder, "x");
    const errors = [];
    const recorder = createRecorder({ dir: notAFolder, cols: 80, rows: 24, onError: (error) => errors.push(error) });
    recorder.output("one");
    recorder.output("two");
    recorder.marker("three");
    await recorder.close();
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
  });
});

test("a write that fails after the recording started reports once, keeps the header, and never throws into the session", async () => {
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    const errors = [];
    const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    await withAppendHandle(
      (handle) => {
        handle.appendFile = async () => {
          throw full;
        };
      },
      async () => {
        const recorder = createRecorder({ dir, cols: 80, rows: 24, onError: (error) => errors.push(error) });
        // The start worked (the header is there); the first write is what fails.
        recorder.output("one");
        recorder.marker("two");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(errors, [full], "reported once, with the real error");
        assert.doesNotThrow(() => {
          recorder.output("three");
          recorder.resize(100, 30);
          recorder.marker("four");
        });
        await recorder.close();
        recorder.output("five");
        assert.deepEqual(errors, [full], "later output is ignored without a second report");
      }
    );
    const [header, ...events] = await readCast(path.join(dir, CAST_FILE));
    assert.equal(header.version, 2);
    assert.deepEqual(events, [], "nothing after the failure was written");
  });
});

test("close gives up after 2 seconds when the disk is stalled, and says so once", async () => {
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    const errors = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await withAppendHandle(
      (handle) => {
        const realAppend = handle.appendFile.bind(handle);
        handle.appendFile = async (data) => {
          await gate; // the disk does not answer until the test lets it
          return realAppend(data);
        };
      },
      async () => {
        const recorder = createRecorder({ dir, cols: 80, rows: 24, onError: (error) => errors.push(error) });
        recorder.output("stuck");
        const started = performance.now();
        const closing = recorder.close();
        assert.equal(recorder.close(), closing, "still the same promise");
        await closing;
        const waited = performance.now() - started;
        assert.ok(waited >= 1800 && waited < 5000, `close waited ${Math.round(waited)} ms (about 2000)`);
        assert.equal(errors.length, 1, "the stalled write is reported once");
        assert.ok(errors[0] instanceof Error);
        release(); // let the stalled write finish so the test leaves no open file behind
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(errors.length, 1, "nothing more is reported when the disk wakes up");
      }
    );
  });
});

test("at the segment size the newer file becomes screen.prev.cast, the oldest output goes first, and each new segment starts with a marker", async () => {
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    await recordChunks(dir);
    const castPath = path.join(dir, CAST_FILE);
    const prevPath = path.join(dir, PREV_CAST_FILE);
    for (const file of [castPath, prevPath]) {
      const info = await stat(file);
      assert.ok(info.size <= 4096, `${path.basename(file)} stays within the segment size (${info.size} bytes)`);
      if (!isWindows) assert.equal(info.mode & 0o777, 0o600, `${path.basename(file)} is private`);
    }
    const newer = await readCast(castPath);
    const older = await readCast(prevPath);
    assert.deepEqual(newer[0], { version: 2, width: 80, height: 24, timestamp: 1760000000 });
    assert.deepEqual(older[0], newer[0], "every segment keeps the recording's start time");
    assert.deepEqual(newer[1].slice(1), ["m", ROTATION_MARKER]);
    assert.deepEqual(older[1].slice(1), ["m", ROTATION_MARKER], "after several rotations the older segment also follows removed output");
    assert.equal(ROTATION_MARKER, "[earlier output removed]");
    const all = JSON.stringify([...older, ...newer]);
    assert.equal(all.includes("chunk-00 "), false, "the oldest output was dropped");
    assert.ok(all.includes("chunk-39 "), "the newest output is kept");
  });
});

test("the default segment size is 25 MB, and rotation really happens there", async () => {
  assert.equal(SEGMENT_BYTES, 26214400);
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    const clock = makeClock();
    const recorder = createRecorder({ dir, cols: 80, rows: 24, now: clock.now });
    const megabyte = "x".repeat(1024 * 1024);
    for (let i = 0; i < 27; i += 1) {
      clock.tick(10);
      recorder.output(megabyte);
    }
    await recorder.close();
    const older = (await stat(path.join(dir, PREV_CAST_FILE))).size;
    const newer = (await stat(path.join(dir, CAST_FILE))).size;
    assert.ok(older <= SEGMENT_BYTES, `screen.prev.cast is ${older} bytes`);
    assert.ok(older > 20 * 1024 * 1024, "the first segment filled up before it rotated");
    assert.ok(newer < 4 * 1024 * 1024, `screen.cast is ${newer} bytes`);
  });
});

test("a resumed session appends after a marker instead of a new header, on one timeline", async () => {
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    const clock = makeClock();
    const first = createRecorder({ dir, cols: 80, rows: 24, now: clock.now });
    clock.tick(1500);
    first.output("before\r\n");
    await first.close();

    clock.tick(60000);
    const second = createRecorder({ dir, cols: 100, rows: 30, append: true, now: clock.now });
    clock.tick(500);
    second.output("after\r\n");
    await second.close();

    const [header, ...events] = await readCast(path.join(dir, CAST_FILE));
    assert.deepEqual(header, { version: 2, width: 80, height: 24, timestamp: 1760000000 });
    assert.deepEqual(events, [
      [1.5, "o", "before\r\n"],
      [61.5, "m", RESUME_MARKER],
      [61.5, "r", "100x30"],
      [62, "o", "after\r\n"]
    ]);
    assert.equal(RESUME_MARKER, "--- resumed ---");
    if (!isWindows) assert.equal((await stat(path.join(dir, CAST_FILE))).mode & 0o777, 0o600);
  });
});

test("resuming a session whose recording was removed starts a new recording that still says it was resumed", async () => {
  await withTempHome(async (home) => {
    const dir = sessionDir(home, crypto.randomUUID());
    const clock = makeClock(START + 5000);
    const recorder = createRecorder({ dir, cols: 80, rows: 24, append: true, now: clock.now });
    clock.tick(250);
    recorder.output("fresh\r\n");
    await recorder.close();
    const [header, ...events] = await readCast(path.join(dir, CAST_FILE));
    assert.deepEqual(header, { version: 2, width: 80, height: 24, timestamp: 1760000005 });
    assert.deepEqual(events, [
      [0, "m", RESUME_MARKER],
      [0, "r", "80x24"],
      [0.25, "o", "fresh\r\n"]
    ]);
  });
});

test("a resume cuts a torn last line first, so every line of the recording is still valid JSON", async () => {
  const tails = {
    "a half line after whole events": Buffer.from('[9.5,"o","half a li'),
    "a half line longer than the scan block": Buffer.from(`[9.5,"o","${"y".repeat(200_000)}`),
    "a half line cut inside a multi-byte character": Buffer.concat([Buffer.from('[9.5,"o","caf'), Buffer.from([0xc3])]),
    "a half line straight after the header": Buffer.from('[0.1,"o","he'),
    "a clean file (nothing to cut)": Buffer.alloc(0)
  };
  for (const [name, tail] of Object.entries(tails)) {
    await withTempHome(async (home) => {
      const dir = sessionDir(home, crypto.randomUUID());
      const clock = makeClock();
      const first = createRecorder({ dir, cols: 80, rows: 24, now: clock.now });
      clock.tick(1500);
      if (!name.includes("straight after the header")) first.output("before\r\n");
      await first.close();
      await appendFile(path.join(dir, CAST_FILE), tail);

      clock.tick(60000);
      const second = createRecorder({ dir, cols: 80, rows: 24, append: true, now: clock.now });
      clock.tick(500);
      second.output("after\r\n");
      await second.close();

      const [header, ...events] = await readCast(path.join(dir, CAST_FILE)); // every line must parse
      assert.equal(header.version, 2, name);
      const wholeBefore = name.includes("straight after the header") ? [] : [[1.5, "o", "before\r\n"]];
      assert.deepEqual(
        events,
        [...wholeBefore, [61.5, "m", RESUME_MARKER], [61.5, "r", "80x24"], [62, "o", "after\r\n"]],
        `${name}: the torn line is gone and the resume marker starts a line of its own`
      );
      if (!isWindows) assert.equal((await stat(path.join(dir, CAST_FILE))).mode & 0o777, 0o600, name);
    });
  }
});

test("openRecording streams one header, the older segment, then the newer one without its rotation marker", async () => {
  await withTempHome(async (home) => {
    const id = crypto.randomUUID();
    await recordChunks(sessionDir(home, id));
    const lines = await collectLines((await openRecording(id)).lines);
    for (const line of lines) assert.ok(line.endsWith("\n"));
    const entries = lines.map((line) => JSON.parse(line));
    assert.deepEqual(entries[0], { version: 2, width: 80, height: 24, timestamp: 1760000000 });
    assert.equal(entries.filter((entry) => !Array.isArray(entry)).length, 1, "one header");
    const events = entries.slice(1);
    assert.deepEqual(events[0].slice(1), ["m", ROTATION_MARKER], "the stream starts by saying earlier output was removed");
    assert.equal(events.filter((event) => event[1] === "m").length, 1, "the newer segment's own marker is left out");
    const numbers = events.filter((event) => event[1] === "o").map((event) => Number(event[2].slice(6, 8)));
    assert.ok(numbers[0] > 0, "the oldest output is gone");
    assert.equal(numbers.at(-1), 39);
    numbers.forEach((number, index) => {
      if (index > 0) assert.equal(number, numbers[index - 1] + 1, "nothing missing or repeated between the segments");
    });
    events.forEach((event, index) => {
      if (index > 0) assert.ok(event[0] >= events[index - 1][0], "times never go back");
    });
  });
});

test("openRecording leaves out a line still being written, and answers 404 for odd ids, unknown sessions and missing recordings", async () => {
  await withTempHome(async (home) => {
    const id = crypto.randomUUID();
    const dir = sessionDir(home, id);
    const clock = makeClock();
    const recorder = createRecorder({ dir, cols: 80, rows: 24, now: clock.now });
    clock.tick(100);
    recorder.output("whole line\r\n");
    await recorder.close();
    await appendFile(path.join(dir, CAST_FILE), '[9.5,"o","half a li');
    const lines = await collectLines((await openRecording(id)).lines);
    assert.equal(lines.length, 2, "the header and the one complete event");
    assert.deepEqual(JSON.parse(lines[1]), [0.1, "o", "whole line\r\n"]);

    await assert.rejects(
      () => openRecording("../../etc"),
      (error) => error.status === 404 && error.code === "unknown_session"
    );
    await assert.rejects(
      () => openRecording(crypto.randomUUID()),
      (error) => error.status === 404 && error.code === "unknown_session"
    );
    const noFiles = await makeSession(home);
    await assert.rejects(
      () => openRecording(noFiles),
      (error) => error.status === 404 && error.code === "recording_missing" && error.message === "That recording doesn't exist anymore."
    );
  });
});

test("openRecording reads the files it opened, so a rotation or a delete during the download skips nothing", async () => {
  await withTempHome(async (home) => {
    const id = crypto.randomUUID();
    const dir = sessionDir(home, id);
    await recordChunks(dir);
    const expected = await collectLines((await openRecording(id)).lines);

    // A live session rotates between the first read and the second one.
    const iterator = (await openRecording(id)).lines[Symbol.asyncIterator]();
    const received = [(await iterator.next()).value];
    await rm(path.join(dir, PREV_CAST_FILE));
    await rename(path.join(dir, CAST_FILE), path.join(dir, PREV_CAST_FILE));
    await writeFile(
      path.join(dir, CAST_FILE),
      `${expected[0]}${JSON.stringify([9.9, "m", ROTATION_MARKER])}\n${JSON.stringify([10, "o", "after the rotation\r\n"])}\n`
    );
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) received.push(step.value);
    assert.deepEqual(received, expected, "the stream is the recording as it was when the download began");

    // The same when the recording is deleted while it is being sent.
    const expectedNow = await collectLines((await openRecording(id)).lines);
    const second = await openRecording(id);
    await rm(path.join(dir, PREV_CAST_FILE));
    await rm(path.join(dir, CAST_FILE));
    assert.deepEqual(await collectLines(second.lines), expectedNow, "the opened files can still be read to the end");
  });
});

test("openRecording lets go of its files when the stream ends, is abandoned part way, or was never started", async (t) => {
  let openFiles;
  try {
    openFiles = () => readdirSync("/dev/fd").length;
    openFiles();
  } catch {
    t.skip("this system does not list open files in /dev/fd");
    return;
  }
  await withTempHome(async (home) => {
    const id = crypto.randomUUID();
    await recordChunks(sessionDir(home, id));
    const baseline = openFiles();

    const finished = await openRecording(id);
    assert.equal(openFiles() - baseline, 2, "both segments are open from the start");
    await collectLines(finished.lines);
    assert.equal(openFiles(), baseline, "closed when the stream ends");

    const abandoned = (await openRecording(id)).lines;
    await abandoned.next();
    await abandoned.return();
    assert.equal(openFiles(), baseline, "closed when the reader stops early");

    const neverStarted = (await openRecording(id)).lines;
    assert.equal(openFiles() - baseline, 2);
    await neverStarted.return();
    assert.equal(openFiles(), baseline, "closed even if nobody read a line");
  });
});

test("listRecordings lists every session that has a recording, newest first, with its size and whether it is live", async () => {
  await withTempHome(async (home) => {
    assert.deepEqual(await listRecordings(), [], "no sessions folder yet");
    const live = await makeSession(home, {
      meta: { status: "live", startedAt: "2026-10-14T10:00:00.000Z", endedAt: null },
      cast: "x".repeat(100)
    });
    const ended = await makeSession(home, {
      meta: {
        agentId: "codex",
        agentLabel: "Codex",
        folder: "/Users/you/projects/api",
        folderName: "api",
        startedAt: "2026-10-14T09:00:00.000Z",
        endedAt: "2026-10-14T09:30:00.000Z"
      },
      cast: "x".repeat(50),
      prev: "x".repeat(70)
    });
    const update = await makeSession(home, {
      meta: {
        kind: "update",
        agentId: "hermes",
        agentLabel: "Hermes",
        folder: "/Users/you/hermes-agent",
        folderName: "hermes-agent",
        startedAt: "2026-10-14T11:00:00.000Z",
        endedAt: "2026-10-14T11:05:00.000Z"
      },
      cast: "x".repeat(10)
    });
    await makeSession(home, { meta: { startedAt: "2026-10-14T12:00:00.000Z" } }); // no recording files
    await makeSession(home, { meta: { startedAt: null }, cast: "x" }); // not a meta.json S6 wrote
    const broken = crypto.randomUUID();
    await mkdir(sessionDir(home, broken), { recursive: true });
    await writeFile(path.join(sessionDir(home, broken), "meta.json"), "{ not json");
    await writeFile(path.join(sessionDir(home, broken), CAST_FILE), "x");
    await mkdir(sessionDir(home, "not-a-session"), { recursive: true });
    await writeFile(path.join(sessionDir(home, "not-a-session"), CAST_FILE), "x");

    assert.deepEqual(await listRecordings(), [
      {
        sessionId: update,
        kind: "update",
        agentId: "hermes",
        agentLabel: "Hermes",
        folder: "/Users/you/hermes-agent",
        folderName: "hermes-agent",
        folderShown: true,
        startedAt: "2026-10-14T11:00:00.000Z",
        endedAt: "2026-10-14T11:05:00.000Z",
        bytes: 10,
        live: false
      },
      {
        sessionId: live,
        kind: "agent",
        agentId: "claude",
        agentLabel: "Claude Code",
        folder: "/Users/you/projects/app",
        folderName: "app",
        folderShown: true,
        startedAt: "2026-10-14T10:00:00.000Z",
        endedAt: null,
        bytes: 100,
        live: true
      },
      {
        sessionId: ended,
        kind: "agent",
        agentId: "codex",
        agentLabel: "Codex",
        folder: "/Users/you/projects/api",
        folderName: "api",
        folderShown: true,
        startedAt: "2026-10-14T09:00:00.000Z",
        endedAt: "2026-10-14T09:30:00.000Z",
        bytes: 120,
        live: false
      }
    ]);

    // The session manager knows best which sessions are live right now.
    const fromManager = await listRecordings({ isLive: (id) => id === ended });
    assert.deepEqual(
      fromManager.map((recording) => [recording.sessionId, recording.live]),
      [
        [update, false],
        [live, false],
        [ended, true]
      ]
    );
  });
});

test("the 1 GB cap removes the oldest ended recordings first, never a live one, and one cap run at a time", async () => {
  assert.equal(RECORDING_CAP_BYTES, 1073741824);
  await withTempHome(async (home) => {
    const oldest = await makeSession(home, {
      meta: { startedAt: "2026-10-14T08:00:00.000Z", endedAt: "2026-10-14T08:10:00.000Z" },
      cast: "a".repeat(400)
    });
    const newer = await makeSession(home, {
      meta: { startedAt: "2026-10-14T09:00:00.000Z", endedAt: "2026-10-14T09:10:00.000Z" },
      cast: "b".repeat(300),
      prev: "b".repeat(100)
    });
    const live = await makeSession(home, {
      meta: { status: "live", startedAt: "2026-10-14T07:00:00.000Z", endedAt: null },
      cast: "c".repeat(400)
    });
    const before = recordingsRemovedByCap();

    assert.deepEqual(await enforceRecordingCap(), { deleted: [] }, "1 200 bytes are far under 1 GB");

    const [first, second] = await Promise.all([
      enforceRecordingCap({ capBytes: 900 }),
      enforceRecordingCap({ capBytes: 900 })
    ]);
    assert.deepEqual(first, { deleted: [oldest] });
    assert.deepEqual(second, { deleted: [] }, "the second run sees the first one's result");
    assert.equal(await exists(path.join(sessionDir(home, oldest), CAST_FILE)), false);
    assert.ok(await exists(path.join(sessionDir(home, oldest), "meta.json")), "the session itself stays");

    assert.deepEqual(
      await enforceRecordingCap({ capBytes: 100, isLive: (id) => id === newer || id === live }),
      { deleted: [] },
      "what the manager says is live is never removed"
    );
    assert.deepEqual(await enforceRecordingCap({ capBytes: 100 }), { deleted: [newer] });
    assert.equal(await exists(path.join(sessionDir(home, newer), PREV_CAST_FILE)), false, "both segments go");
    assert.deepEqual(
      (await listRecordings()).map((recording) => recording.sessionId),
      [live],
      "the live recording stays, even over the cap"
    );
    assert.equal(recordingsRemovedByCap() - before, 2);
  });
});

test("the cap goes by when a session ended, not when it started", async () => {
  await withTempHome(async (home) => {
    // Started first but ended last, so it is the NEWER recording.
    const longRunning = await makeSession(home, {
      meta: { startedAt: "2026-10-14T08:00:00.000Z", endedAt: "2026-10-14T12:00:00.000Z" },
      cast: "a".repeat(400)
    });
    // Started later but ended first, so it is the OLDER recording.
    const quick = await makeSession(home, {
      meta: { startedAt: "2026-10-14T09:00:00.000Z", endedAt: "2026-10-14T09:10:00.000Z" },
      cast: "b".repeat(300)
    });
    assert.deepEqual(await enforceRecordingCap({ capBytes: 450 }), { deleted: [quick] }, "700 bytes down to 450: the one that ended first goes");
    assert.ok(await exists(path.join(sessionDir(home, longRunning), CAST_FILE)));
    assert.equal(await exists(path.join(sessionDir(home, quick), CAST_FILE)), false);
  });
});

test("one recording that cannot be removed does not stop the cap: it is skipped, and only real removals are counted", async () => {
  await withTempHome(async (home) => {
    // screen.cast is a folder here, which no unlink can remove (on any system, whoever runs the test).
    const stuck = await makeSession(home, {
      meta: { startedAt: "2026-10-14T07:00:00.000Z", endedAt: "2026-10-14T07:10:00.000Z" }
    });
    await mkdir(path.join(sessionDir(home, stuck), CAST_FILE));
    const older = await makeSession(home, {
      meta: { startedAt: "2026-10-14T08:00:00.000Z", endedAt: "2026-10-14T08:10:00.000Z" },
      cast: "a".repeat(300)
    });
    const newer = await makeSession(home, {
      meta: { startedAt: "2026-10-14T09:00:00.000Z", endedAt: "2026-10-14T09:10:00.000Z" },
      cast: "b".repeat(300)
    });
    const before = recordingsRemovedByCap();

    const result = await enforceRecordingCap({ capBytes: 0 });
    assert.deepEqual(result, { deleted: [older, newer] }, "the stuck one is skipped, the others are still cleared, in order");
    assert.equal(recordingsRemovedByCap() - before, 2, "only what was really removed is counted");
    assert.equal(await exists(path.join(sessionDir(home, older), CAST_FILE)), false);
    assert.equal(await exists(path.join(sessionDir(home, newer), CAST_FILE)), false);
    assert.ok(await exists(path.join(sessionDir(home, stuck), CAST_FILE)), "the stuck one is still there");
    assert.ok(await exists(path.join(sessionDir(home, stuck), "meta.json")));
  });
});

test("the cap asks again whether a session is live right before removing its recording", async () => {
  await withTempHome(async (home) => {
    const resumed = await makeSession(home, {
      meta: { startedAt: "2026-10-14T08:00:00.000Z", endedAt: "2026-10-14T08:10:00.000Z" },
      cast: "a".repeat(300)
    });
    const stillEnded = await makeSession(home, {
      meta: { startedAt: "2026-10-14T09:00:00.000Z", endedAt: "2026-10-14T09:10:00.000Z" },
      cast: "b".repeat(300)
    });
    // The first answer (while the cap decides) is "ended"; by the time it removes, Resume has started the session.
    const asked = new Map();
    const isLive = (id) => {
      asked.set(id, (asked.get(id) ?? 0) + 1);
      return id === resumed && asked.get(id) >= 2;
    };
    assert.deepEqual(await enforceRecordingCap({ capBytes: 0, isLive }), { deleted: [stillEnded] });
    assert.ok(await exists(path.join(sessionDir(home, resumed), CAST_FILE)), "the session that started again keeps its recording");
    assert.ok(asked.get(resumed) >= 2, "it was asked a second time");
  });
});

test("deleteRecording removes an ended session's recording files only, and refuses live, unknown and odd ids", async () => {
  await withTempHome(async (home) => {
    const live = await makeSession(home, { meta: { status: "live", endedAt: null }, cast: "x" });
    const ended = await makeSession(home, { cast: "x", prev: "y" });

    await assert.rejects(
      () => deleteRecording("../../etc"),
      (error) => error.status === 404 && error.code === "unknown_session" && error.message === "That session doesn't exist anymore."
    );
    await assert.rejects(
      () => deleteRecording(crypto.randomUUID()),
      (error) => error.status === 404 && error.code === "unknown_session"
    );
    await assert.rejects(
      () => deleteRecording(live),
      (error) =>
        error.status === 409 &&
        error.code === "recording_live" &&
        error.message === "That session is still running. Stop it first, then delete its recording."
    );
    assert.ok(await exists(path.join(sessionDir(home, live), CAST_FILE)), "a live recording is kept");
    await assert.rejects(
      () => deleteRecording(ended, { isLive: (id) => id === ended }),
      (error) => error.status === 409 && error.code === "recording_live"
    );

    assert.deepEqual(await deleteRecording(ended), { ok: true });
    assert.equal(await exists(path.join(sessionDir(home, ended), CAST_FILE)), false);
    assert.equal(await exists(path.join(sessionDir(home, ended), PREV_CAST_FILE)), false);
    assert.ok(await exists(path.join(sessionDir(home, ended), "meta.json")), "the session itself stays (ended tab, Resume)");
    await assert.rejects(
      () => deleteRecording(ended),
      (error) => error.status === 404 && error.code === "recording_missing" && error.message === "That recording doesn't exist anymore."
    );
  });
});

test("deleteRecording asks again whether the session is live right before removing, so a Resume in between keeps the recording", async () => {
  await withTempHome(async (home) => {
    const ended = await makeSession(home, { cast: "x", prev: "y" });
    let asked = 0;
    // "Ended" when deleteRecording first looks; "live" again by the time it would remove.
    const isLive = () => {
      asked += 1;
      return asked >= 2;
    };
    await assert.rejects(
      () => deleteRecording(ended, { isLive }),
      (error) => error.status === 409 && error.code === "recording_live"
    );
    assert.equal(asked, 2);
    assert.ok(await exists(path.join(sessionDir(home, ended), CAST_FILE)), "the recording is kept");
    assert.ok(await exists(path.join(sessionDir(home, ended), PREV_CAST_FILE)), "both segments are kept");
  });
});
