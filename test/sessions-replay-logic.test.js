// Runs → Session recordings → Replay (spec SP4 "Recordings in Runs"; Task U11): the pure logic in
// src/ui/replayShared.ts (the cast read, the timeline with its true wall-clock length, its idle gaps and its removed
// span, the moments from meta.json's markers, the playhead, the steps that draw the screen, the words), the two new
// client requests in src/sessionsApi.ts (the recording as text with its own time limit, the markers), and the wiring
// the Runs page depends on. replayShared.ts has `import type` only, so Node loads it straight from src/ (decision
// P14). sessionsApi.ts imports its neighbours without a file extension (the Vite way), so a resolve hook adds .ts
// first, as test/sessions-api.test.js does. The page itself is checked by the replay probe of the UI audit.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import xtermHeadless from "@xterm/headless";
import { ROTATION_MARKER as RECORDER_ROTATION_MARKER } from "../server/runtime/sessions/recorder.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const extension of [".ts", ".tsx"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
});

const replay = await import("../src/ui/replayShared.ts");
const rec = await import("../src/ui/recordingsShared.ts");
const ss = await import("../src/ui/sessionsShared.ts");
const api = await import("../src/sessionsApi.ts");
const { ApiError } = await import("../src/api.ts");
// @xterm/headless is a CommonJS bundle: its classes sit on the default export.
const { Terminal: HeadlessTerminal } = xtermHeadless;

// A recording's header start (whole seconds, as recorder.js writes it) and times on its clock.
const T0 = 1_760_000_000;
const ID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
const iso = (seconds) => new Date((T0 + seconds) * 1000).toISOString();
const header = (over = {}) => ({ version: 2, width: 100, height: 24, timestamp: T0, ...over });
const castText = (events, head = header()) => `${[head, ...events].map((line) => JSON.stringify(line)).join("\n")}\n`;
const cast = (events, head) => replay.parseCast(castText(events, head));
const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

function screenLines(t) {
  const buffer = t.buffer.active;
  const lines = [];
  for (let y = 0; y < t.rows; y += 1) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
  return lines;
}

// The screen a straight play from the start to `index` gives, on a fresh headless terminal.
async function screenAt(c, index) {
  const t = new HeadlessTerminal({ cols: c.width, rows: c.height, logLevel: "off" });
  try {
    await replay.runReplaySteps(t, replay.replaySteps(c, 0, index));
    return { lines: screenLines(t), cols: t.cols, rows: t.rows };
  } finally {
    t.dispose();
  }
}

test("parseCast: an asciicast v2 header and its events; a torn or odd line is skipped, a time never goes back, anything else is no cast", () => {
  const text =
    castText([[0.5, "o", "hello\r\n"], [1.25, "r", "90x30"], [1, "o", "late"], [2, "m", "--- resumed ---"], [3, "i", "typed"], [4, "o", 7], "junk", [5, "o", "end"]]) +
    '[6,"o","tor';
  assert.deepEqual(replay.parseCast(text), {
    width: 100,
    height: 24,
    timestamp: T0,
    events: [[0.5, "o", "hello\r\n"], [1.25, "r", "90x30"], [1.25, "o", "late"], [2, "m", "--- resumed ---"], [5, "o", "end"]]
  });
  for (const bad of [
    null,
    "",
    "not json\n",
    `${JSON.stringify({ version: 1, width: 80, height: 24, timestamp: T0 })}\n`,
    `${JSON.stringify({ version: 2, width: 80, height: 24 })}\n`,
    `${JSON.stringify([0, "o", "x"])}\n`
  ]) {
    assert.equal(replay.parseCast(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(replay.parseCast(castText([], header({ width: 5000, height: 0 }))), { width: 80, height: 24, timestamp: T0, events: [] }, "an odd size falls back to 80 × 24");
});

test("buildTimeline: the true wall-clock length runs to the session's end; gaps over 30 s without output are idle (exactly 30 s is not); a live recording ends at its last event", () => {
  const c = cast([[1, "o", "a"], [5, "o", "b"], [40, "o", "c"], [70, "o", "d"]]);
  const ended = replay.buildTimeline(c, [], { endAt: iso(150) });
  assert.equal(ended.wallSeconds, 150);
  assert.equal(ended.removedSeconds, 0);
  assert.deepEqual(ended.segments, [
    { from: 0, to: 5, kind: "play" },
    { from: 5, to: 40, kind: "idle" },
    { from: 40, to: 70, kind: "play" },
    { from: 70, to: 150, kind: "idle" }
  ]);
  assert.deepEqual(ended.moments, []);
  const live = replay.buildTimeline(c, []);
  assert.equal(live.wallSeconds, 70);
  assert.deepEqual(live.segments.at(-1), { from: 40, to: 70, kind: "play" });
  assert.equal(replay.buildTimeline(c, [], { endAt: iso(60) }).wallSeconds, 70, "an end before the last event (a clock change) never cuts output off");
  assert.equal(replay.buildTimeline(c, [], { endAt: "not a time" }).wallSeconds, 70);
  assert.deepEqual(replay.buildTimeline(c, [], { endAt: iso(150), idleSkipS: 40 }).segments, [
    { from: 0, to: 70, kind: "play" },
    { from: 70, to: 150, kind: "idle" }
  ]);
  assert.equal(replay.IDLE_SKIP_S, 30);
  assert.deepEqual(replay.buildTimeline(cast([]), []), { wallSeconds: 0, removedSeconds: 0, segments: [], moments: [] });
});

test("buildTimeline: output removed at a rotation is a span from 0 to the rotation marker, drawn but never played; a resize or a marker is not output", () => {
  const c = cast([[40, "m", "[earlier output removed]"], [40.5, "o", "kept"], [100, "r", "90x30"], [101, "o", "more"], [102, "m", "--- resumed ---"]]);
  const timeline = replay.buildTimeline(c, [], { endAt: iso(110) });
  assert.equal(timeline.removedSeconds, 40);
  assert.equal(timeline.wallSeconds, 110);
  assert.deepEqual(timeline.segments, [
    { from: 0, to: 40, kind: "removed" },
    { from: 40, to: 40.5, kind: "play" },
    { from: 40.5, to: 101, kind: "idle" },
    { from: 101, to: 110, kind: "play" }
  ]);
  assert.equal(replay.ROTATION_MARKER, RECORDER_ROTATION_MARKER, "the recorder's own marker");
  assert.equal(replay.REMOVED_WORDS, "[earlier output removed]");
});

test("moments: the markers on the recording's clock, sorted, with their words; a prompt keeps no text (R23); files show path and +/−; markers from before this recording began are left out; one after its end sits at the end", () => {
  const c = cast([[1, "o", "a"], [12, "o", "b"]]);
  const answer = {
    markers: [
      { at: iso(10), type: "files", files: [{ path: "src/app.ts", added: 12, removed: 3 }, { path: "logo.png", added: null, removed: null }], more: 2 },
      { at: iso(2), type: "prompt", text: "a prompt that must never show" },
      { at: iso(3), type: "permission", text: "Wants to use Bash" },
      { at: iso(-60), type: "permission", text: "from a deleted recording" },
      { at: iso(25), type: "permission", text: "Has a question for you" },
      { at: "yesterday", type: "prompt" },
      { at: iso(4), type: "shell" },
      "junk"
    ]
  };
  const { moments, wallSeconds } = replay.buildTimeline(c, answer, { endAt: iso(20) });
  assert.equal(wallSeconds, 20);
  assert.deepEqual(moments, [
    { t: 2, type: "prompt", word: "Prompt", label: "Prompt", detail: "" },
    { t: 3, type: "permission", word: "Permission asked", label: "Permission asked: Wants to use Bash", detail: "Wants to use Bash" },
    { t: 10, type: "files", word: "Files changed", label: "Files changed: 4", detail: "src/app.ts (+12 −3), logo.png, and 2 more" },
    { t: 20, type: "permission", word: "Permission asked", label: "Permission asked: Has a question for you", detail: "Has a question for you" }
  ]);
  assert.deepEqual(replay.buildTimeline(c, answer.markers, { endAt: iso(20) }).moments, moments, "a bare list is read the same way");
  assert.deepEqual(replay.readMarkers(null), []);
  assert.deepEqual(replay.readMarkers({ markers: "x" }), []);
  assert.deepEqual(replay.readMarkers([{ at: iso(2), type: "prompt", text: "secret" }]), [{ at: iso(2), type: "prompt" }]);
  assert.equal(replay.fileWords({ path: "a.md", added: 0, removed: 5 }), "a.md (+0 −5)");
  assert.equal(replay.fileWords({ path: "b.bin", added: null, removed: null }), "b.bin");
  assert.deepEqual(replay.MOMENT_WORDS, { prompt: "Prompt", permission: "Permission asked", files: "Files changed" });
  assert.equal(replay.momentName(moments[0]), "Prompt, 2 s");
  assert.equal(replay.momentName(moments[1]), "Permission asked: Wants to use Bash, 3 s");
  assert.equal(replay.momentName(moments[2]), "Files changed: 4, src/app.ts (+12 −3), logo.png, and 2 more, 10 s");
});

test("advance: playing moves through output at the speed given, jumps over idle gaps and the removed span at once, and stops at the end", () => {
  const { segments } = replay.buildTimeline(cast([[1, "o", "a"], [5, "o", "b"], [40, "o", "c"], [70, "o", "d"]]), [], { endAt: iso(150) });
  assert.equal(replay.advance(segments, 0, 2), 2);
  assert.equal(replay.advance(segments, 4, 2), 41, "one second of output, the idle gap skipped, then one more");
  assert.equal(replay.advance(segments, 10, 0), 40, "a playhead left inside an idle gap goes to its end");
  assert.equal(replay.advance(segments, 60, 100), 150, "the trailing idle gap is skipped to the end");
  assert.equal(replay.advance(segments, 150, 1), 150);
  assert.equal(replay.advance(segments, 3, -5), 3, "no time, no move");
  const removed = replay.buildTimeline(cast([[40, "m", "[earlier output removed]"], [41, "o", "x"]]), []).segments;
  assert.equal(replay.advance(removed, 0, 0.5), 40.5, "playing from the start begins where output is still recorded");
  // 30× for 0.1 s is 3 s of the recording: a two-minute idle gap costs nothing.
  const gap = replay.buildTimeline(cast([[40.5, "o", "a"], [45, "o", "b"], [165, "o", "c"], [170, "o", "d"]]), [], { endAt: iso(190) }).segments;
  assert.equal(replay.advance(gap, 44, 3), 167);
  assert.deepEqual(replay.REPLAY_SPEEDS, [1, 10, 30]);
  assert.equal(replay.DEFAULT_SPEED, 10);
  assert.deepEqual(replay.REPLAY_SPEEDS.map(replay.speedLabel), ["1×", "10×", "30×"]);
});

test("eventIndexAt and replaySteps: the events up to a time; forward steps join output and split at resizes; going back starts again from a clean screen at the recording's size", () => {
  const c = cast([[0.5, "o", "a"], [1, "o", "b"], [1.5, "r", "90x30"], [2, "o", "c"], [2.5, "m", "x"], [3, "r", "bad"], [4, "o", "d"]]);
  assert.deepEqual([0, 0.5, 1.49, 2.5, 99].map((at) => replay.eventIndexAt(c.events, at)), [0, 1, 2, 5, 7]);
  assert.deepEqual(replay.replaySteps(c, 0, 7), [{ kind: "write", data: "ab" }, { kind: "resize", cols: 90, rows: 30 }, { kind: "write", data: "cd" }]);
  assert.deepEqual(replay.replaySteps(c, 2, 4), [{ kind: "resize", cols: 90, rows: 30 }, { kind: "write", data: "c" }]);
  assert.deepEqual(replay.replaySteps(c, 5, 2), [{ kind: "reset" }, { kind: "resize", cols: 100, rows: 24 }, { kind: "write", data: "ab" }]);
  assert.deepEqual(replay.replaySteps(c, 3, 3), []);
  assert.deepEqual(replay.replaySteps(c, 0, 99), replay.replaySteps(c, 0, 7), "an index past the end means the end");
  assert.deepEqual(replay.parseSize("120x32"), { cols: 120, rows: 32 });
  for (const bad of ["0x24", "120x", "x", "5000x10", "12 x 3"]) assert.equal(replay.parseSize(bad), null, bad);
});

test("runReplaySteps on a real (headless) xterm: playing in pieces, seeking back and forth, gives the screen a straight play to that time gives; a stopped replay draws nothing more", async () => {
  const c = cast([
    [0.1, "o", "\x1b[31mred\x1b[0m line one\r\n"],
    [0.2, "o", "line two\r\n"],
    [0.3, "r", "60x10"],
    [0.4, "o", "line three\r\n"],
    [0.5, "o", "\x1b[2J\x1b[Hcleared\r\n"]
  ]);
  const t = new HeadlessTerminal({ cols: c.width, rows: c.height, logLevel: "off" });
  try {
    let shown = 0;
    for (const at of [0.15, 0.35, 0.1, 0.45, 1, 0]) {
      const index = replay.eventIndexAt(c.events, at);
      await replay.runReplaySteps(t, replay.replaySteps(c, shown, index));
      shown = index;
      assert.deepEqual({ lines: screenLines(t), cols: t.cols, rows: t.rows }, await screenAt(c, index), `at ${at} s`);
    }
  } finally {
    t.dispose();
  }
  const early = await screenAt(c, replay.eventIndexAt(c.events, 0.15));
  assert.equal(early.lines[0], "red line one");
  assert.equal(early.lines[1], "");
  const stopped = new HeadlessTerminal({ cols: 100, rows: 24, logLevel: "off" });
  try {
    await replay.runReplaySteps(stopped, replay.replaySteps(c, 0, 5), () => true);
    assert.ok(screenLines(stopped).every((line) => line === ""), "nothing was drawn");
    assert.equal(stopped.cols, 100, "and nothing was resized");
  } finally {
    stopped.dispose();
  }
});

test("clockWords, timelinePercent, currentMoment and fitFontSize", () => {
  assert.deepEqual([0, 59.9, 60, 190, 3725, NaN, -5].map(replay.clockWords), ["0 s", "59 s", "1 m 00 s", "3 m 10 s", "1 h 02 m 05 s", "0 s", "0 s"]);
  assert.equal(replay.timelinePercent(95, 190), 50);
  assert.equal(replay.timelinePercent(1, 0), 0);
  assert.equal(replay.timelinePercent(-1, 10), 0);
  assert.equal(replay.timelinePercent(20, 10), 100);
  const moments = [2, 3, 10].map((t) => ({ t, type: "prompt", word: "Prompt", label: "Prompt", detail: "" }));
  assert.deepEqual([1, 3, 9.9, 10, 100].map((pos) => replay.currentMoment(moments, pos)), [-1, 1, 1, 2, 2]);
  assert.equal(replay.currentMoment([], 5), -1);
  // JetBrains Mono's cell is 0.6 em wide and a row 1.2 em tall: the largest whole size up to 13 px that fits both ways.
  assert.equal(replay.fitFontSize({ boxWidth: 1000, boxHeight: 600, cols: 80, rows: 24 }), 13);
  assert.equal(replay.fitFontSize({ boxWidth: 640, boxHeight: 348, cols: 120, rows: 32 }), 8);
  assert.equal(replay.fitFontSize({ boxWidth: 1000, boxHeight: 100, cols: 80, rows: 24 }), 6, "never below 6 px (the box then scrolls inside itself)");
  assert.equal(replay.fitFontSize({ boxWidth: 0, boxHeight: 300, cols: 80, rows: 24 }), 13, "a box not laid out yet keeps the normal size");
  assert.equal(replay.REPLAY_FONT_MIN, 6);
  assert.equal(replay.CELL_WIDTH_EM, 0.6);
});

test("the words: spec sentences word for word, the prototype's Resume confirm with SP3's fallback warning, the Delete confirm, the side notes; no em dash, no promise", () => {
  assert.equal(replay.IDLE_WORDS, "Idle, skipped while playing");
  assert.equal(replay.MOMENTS_TITLE, "Moments in this recording");
  const plain = replay.replayResumeCopy({ agent: "Claude Code", folder: "~/projects/my-app", fallback: false });
  assert.deepEqual(plain, {
    title: "Resume this conversation?",
    body: [
      "Agent OS opens a new terminal in ~/projects/my-app and starts Claude Code with its own resume feature.",
      "Agent OS does not paste the old text back in and does not press Enter for you. The recording continues after a marker."
    ],
    warning: null,
    cancel: "Cancel",
    confirm: "Resume conversation"
  });
  const fallback = replay.replayResumeCopy({ agent: "Codex", folder: "~/projects/api", fallback: true });
  const sp3 = ss.resumeConfirmCopy({ kind: "agent", agentId: "codex", agentLabel: "Codex", folderName: "api", folderShown: true, resume: { available: true, reason: null, fallback: true } });
  assert.equal(fallback.warning, sp3.warning, "the same fallback warning as SP3's dialog");
  assert.ok(sp3.body.endsWith("The recording continues after a marker."), "the same last sentence as SP3's dialog");
  assert.equal(
    replay.replayResumeCopy({ agent: "OpenClaw", folder: null, fallback: false }).body[0],
    "Agent OS opens a new terminal and starts OpenClaw with its own resume feature."
  );
  assert.deepEqual(replay.deleteConfirmCopy({ kind: "agent", dismissed: false }), {
    title: "Delete this recording?",
    body: [
      "Agent OS deletes what this session's terminal showed, and its moments, from this computer. This can't be undone.",
      "The session's tab stays on the Sessions page, and so does its Resume conversation."
    ],
    confirm: "Delete recording"
  });
  assert.equal(
    replay.deleteConfirmCopy({ kind: "agent", dismissed: true }).body[1],
    "You dismissed this session's tab, so after this Agent OS no longer lists the session anywhere."
  );
  assert.equal(replay.deleteConfirmCopy({ kind: "update", dismissed: false }).body.length, 1);
  assert.equal(replay.liveNote(75), "Still recording. This replay covers the first 1 m 15 s. To see the rest, open the live session.");
  assert.equal(replay.endedNote("Hermes"), "Resume conversation starts Hermes again with its own resume feature. Agent OS does not copy the text.");
  // Fix round 1 (M-2): a replay read while its session ran says so once the session has ended.
  assert.equal(replay.endedSinceNote(75), "The session has ended since. This replay covers the first 1 m 15 s. Close it and open it again to see the rest.");
  const recorder = readFileSync(new URL("../server/runtime/sessions/recorder.js", import.meta.url), "utf8");
  assert.ok(recorder.includes(`"${replay.DELETE_WHILE_LIVE}"`), "the switched-off Delete says what the server says");
  assert.ok(recorder.includes(`"${replay.RECORDING_GONE}"`), "a replay whose recording is gone says what the server says");
  const all = [
    replay.IDLE_WORDS, replay.MOMENTS_TITLE, replay.REPLAY_CAPTION, replay.NO_MOMENTS, replay.MOMENTS_UNREADABLE, replay.CAST_UNREADABLE,
    ...Object.values(replay.MOMENT_WORDS), plain.title, ...plain.body,
    ...replay.deleteConfirmCopy({ kind: "agent", dismissed: true }).body, replay.liveNote(1), replay.endedNote("Codex"), replay.endedSinceNote(75)
  ].join("\n");
  assert.doesNotMatch(all, /—/, "no em dash");
  assert.doesNotMatch(all, /later update|coming soon|SP5/i, "no promise");
});

test("Delete: which refusals shut the dialog's button, and the words for a delete that failed or got no answer", () => {
  const refused = (code, detail = "") => new ApiError(code, detail, 409);
  for (const code of ["recording_live", "recording_missing", "unknown_session"]) assert.equal(replay.isFinalDeleteRefusal(refused(code)), true, code);
  for (const error of [refused("session_busy"), new Error("recording_live"), null, "recording_live"]) {
    assert.equal(replay.isFinalDeleteRefusal(error), false, String(error));
  }
  assert.equal(
    replay.deleteProblem(refused("recording_live", "That session is still running. Stop it first, then delete its recording."), false),
    "That session is still running. Stop it first, then delete its recording."
  );
  assert.equal(replay.deleteProblem(refused("internal_error"), false), "Agent OS couldn't delete this recording. Try again.");
  assert.equal(
    replay.deleteProblem(new Error("Agent OS did not answer in time."), true),
    "Agent OS didn't answer, so the recording may or may not be deleted. The list shows it only while it is still there."
  );
  assert.equal(
    replay.deleteProblem(new SyntaxError("Unexpected token"), false),
    "Agent OS answered, but the answer couldn't be read. The list shows the recording only while it is still there."
  );
});

test("fetchRecording: the recording as text, with its own time limit; a refusal is an ApiError with the server's sentence; a sign-out locks the app; a closed replay stops the download", async (t) => {
  const real = { fetch: globalThis.fetch, window: globalThis.window };
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  try {
    const text = castText([[0.5, "o", "hi"]]);
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => text,
        json: async () => {
          throw new SyntaxError("not JSON");
        }
      };
    };
    assert.equal(await api.fetchRecording(ID), text, "the asciicast text as it came, never read as JSON");
    assert.equal(calls[0].url, `/api/sessions/${ID}/recording`);
    assert.equal(calls[0].options.credentials, "same-origin");
    assert.ok(calls[0].options.signal instanceof AbortSignal);

    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "recording_missing", message: "That recording doesn't exist anymore." })
    });
    await assert.rejects(
      api.fetchRecording(ID),
      (error) => error instanceof ApiError && error.message === "recording_missing" && error.status === 404 && error.detail === "That recording doesn't exist anymore."
    );

    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({ error: "session_required" }) });
    await assert.rejects(api.fetchRecording(ID), (error) => error instanceof ApiError && error.status === 401);
    assert.deepEqual(events, ["agentos:locked"]);

    let aborted = 0;
    globalThis.fetch = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted += 1;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    const controller = new AbortController();
    const closing = api.fetchRecording(ID, { signal: controller.signal });
    controller.abort();
    await assert.rejects(closing, (error) => error.name === "AbortError", "a replay that closed is not a time-out");
    assert.equal(aborted, 1);

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const slow = api.fetchRecording(ID);
    t.mock.timers.tick(api.SESSION_LIMITS_MS.recording);
    await assert.rejects(slow, (error) => error.message === "Agent OS did not answer in time.");
    assert.equal(aborted, 2, "the download itself is stopped at the time limit");
    assert.equal(api.SESSION_LIMITS_MS.recording, 60000);
  } finally {
    globalThis.fetch = real.fetch;
    if (real.window === undefined) delete globalThis.window;
    else globalThis.window = real.window;
  }
});

test("getMarkers: GET /api/sessions/:id/markers with its own time limit; a refusal is an ApiError", async () => {
  const real = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET" });
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ markers: [{ at: iso(2), type: "prompt" }] }) };
    };
    assert.deepEqual(await api.getMarkers(ID), { markers: [{ at: iso(2), type: "prompt" }] });
    assert.deepEqual(calls, [{ url: `/api/sessions/${ID}/markers`, method: "GET" }]);
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "unknown_session", message: "That session doesn't exist anymore." })
    });
    await assert.rejects(api.getMarkers(ID), (error) => error instanceof ApiError && error.message === "unknown_session");
    assert.equal(api.SESSION_LIMITS_MS.markers, 10000);
  } finally {
    globalThis.fetch = real;
  }
});

test("Runs wiring: the SP3 replay note is gone everywhere; ?replay= is kept; every row opens its replay; Delete is a danger confirm, off while the session runs; the replay terminal sends nothing and opens nothing", () => {
  assert.equal("REPLAY_LATER" in rec, false);
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  for (const file of readdirSync(srcRoot, { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(String(file))) continue;
    assert.doesNotMatch(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), /Replay arrives in a later update/, String(file));
  }
  assert.match(source("nav.ts"), /"highlight", "replay"\]/, "navigateTo keeps ?replay=");
  assert.match(source("pages/RunsPage.tsx"), /queryParam\("replay"\)/);
  const page = source("ui/components/SessionRecordings.tsx");
  assert.match(page, /navigateTo\("runs", \{ tab: "recordings", replay: row\.sessionId \}\)/, "every row opens its replay");
  assert.match(page, /title=\{deleteCopy\.title\}[\s\S]{0,400}?danger/, "Delete asks first, as a danger action");
  assert.equal(page.split("deleteRecording(").length - 1, 1, "the only delete call is the confirmed one");
  assert.ok(page.indexOf("deleteRecording(") > page.indexOf("async function confirmDelete"), "and it sits inside confirmDelete");
  const player = source("ui/components/ReplayPlayer.tsx");
  assert.match(player, /disabled=\{live\}/, "Delete recording is off while the session runs");
  assert.match(player, /disableStdin: true/);
  assert.match(player, /activate: \(\) => undefined/, "an OSC 8 link in a recording opens nothing");
  for (const forbidden of ["onData", "onBinary", "WebLinksAddon", "ClipboardAddon", "WebglAddon", "window.confirm", "localStorage"]) {
    assert.equal(player.includes(forbidden), false, `the replay terminal has no ${forbidden}`);
  }
});

// Orchestrator ruling for Task U11 (replay safety): a recording is data, never a command. An OSC 52 clipboard write, a
// title change (OSC 0, 1, 2) and an OSC 8 link in a recording draw nothing outside the player's own screen: the
// replay terminal loads no clipboard or links add-on, listens to no title change, and the page names a path or an alert
// text only through U7's visible-text helper, so a hidden reordering character shows as a token.
test("replay safety: an OSC 52 clipboard write, a title change and a link in a recording only draw into the player's own screen; hidden characters in moments show as tokens", async () => {
  const c = cast([
    [0.1, "o", "before\r\n"],
    [0.2, "o", "\x1b]52;c;aGVsbG8gY2xpcGJvYXJk\x07"],
    [0.3, "o", "\x1b]0;stolen title\x07\x1b]1;stolen icon\x07\x1b]2;stolen window\x1b\\"],
    [0.4, "o", "\x1b]8;;https://example.invalid/clicked\x07link-text\x1b]8;;\x07\r\n"],
    [0.5, "o", "after\r\n"]
  ]);
  const titles = [];
  const t = new HeadlessTerminal({ cols: c.width, rows: c.height, logLevel: "off" });
  t.onTitleChange((title) => titles.push(title));
  try {
    await replay.runReplaySteps(t, replay.replaySteps(c, 0, replay.eventIndexAt(c.events, 1)));
    const lines = screenLines(t);
    assert.deepEqual(lines.slice(0, 4), ["before", "link-text", "after", ""], "the sequences leave no text on the screen");
    assert.doesNotMatch(lines.join("\n"), /aGVsbG8|stolen|example\.invalid/);
    // The title only ever changes inside the terminal object; the player listens for none of it (checked below).
    assert.ok(titles.length > 0, "the sequences really were read by the terminal");
  } finally {
    t.dispose();
  }
  const player = source("ui/components/ReplayPlayer.tsx");
  for (const forbidden of ["onTitleChange", "registerOscHandler", "navigator.clipboard", "document.title", "window.open", "href="]) {
    assert.equal(player.includes(forbidden), false, `the replay page has no ${forbidden}`);
  }
  assert.match(player, /visibleText\(momentName\(moment\)\)/, "a pin's and a moment's name show hidden characters as tokens");
  assert.match(player, /<VisibleText text=\{moment\.detail\} \/>/, "and so does a moment's path or alert text");
  assert.match(player, /<VisibleText text=\{collapseHomePath\(recordingFolder\(row\)\)/, "and the folder in the header (the project, for a separate copy: E1 A-M3)");
  assert.match(player, /<VisibleText text=\{branch\} \/>/, "and the branch in the header");
  assert.match(player, /<VisibleText text=\{title\} \/>/, "and the replay's title");
  assert.match(source("ui/components/SessionRecordings.tsx"), /<VisibleText text=\{line\} \/>/, "and the Resume dialog's folder (fix round 1, M-3)");
  assert.match(player, /aria-label="Replayed terminal screen" tabIndex=\{0\}/, "the box that scrolls can take the keyboard (M-4)");
});

// Fix round 1 (I-1): xterm parses one write without letting the page do anything else, so a redraw of tens of MB must
// reach it in pieces, and a person holding an arrow key must never queue up redraws.
test("replaySteps: no write step is longer than the piece limit; the pieces join to the same output, split only at resizes and never inside a surrogate pair", () => {
  const max = replay.WRITE_PIECE_MAX;
  assert.equal(max, 262144);
  const plain = "a".repeat(max * 2 + 1000);
  const pair = "\u{1F600}";
  const odd = `x${pair.repeat(max / 2 + 3)}`;
  const c = cast([[0.1, "o", plain], [0.2, "r", "90x30"], [0.3, "o", "b"], [0.4, "o", odd]]);
  const steps = replay.replaySteps(c, 0, 4);
  for (const step of steps) {
    if (step.kind === "write") {
      assert.ok(step.data.length > 0 && step.data.length <= max, `a write of ${step.data.length} units`);
      const last = step.data.charCodeAt(step.data.length - 1);
      assert.equal(last >= 0xd800 && last <= 0xdbff, false, "a piece never ends between the halves of a character");
    }
  }
  const resizeAt = steps.findIndex((step) => step.kind === "resize");
  const text = (list) => list.map((step) => step.data).join("");
  assert.deepEqual(steps[resizeAt], { kind: "resize", cols: 90, rows: 30 });
  assert.equal(steps.slice(0, resizeAt).every((step) => step.kind === "write"), true);
  assert.equal(text(steps.slice(0, resizeAt)), plain, "everything before the resize, in order");
  assert.equal(text(steps.slice(resizeAt + 1)), `b${odd}`, "everything after it, in order");
  assert.ok(steps.slice(0, resizeAt).length >= 3, "a long output is several steps");
  // Going back keeps the same limit.
  const back = replay.replaySteps(c, 4, 1);
  assert.deepEqual(back.slice(0, 2), [{ kind: "reset" }, { kind: "resize", cols: 100, rows: 24 }]);
  assert.ok(back.every((step) => step.kind !== "write" || step.data.length <= max));
});

// A recording of about 2.4 MB: 40 events of about 60 KB, each ending in its own marker line.
function bigCast(count = 40) {
  const events = [];
  for (let i = 0; i < count; i += 1) events.push([i * 0.1, "o", `${`${"x".repeat(98)}\r\n`.repeat(600)}marker-${i}\r\n`]);
  return cast(events);
}

// A terminal that counts what it is given (resets are the "\x1bc" writes), in front of a real headless one.
function countingTerminal(t) {
  const log = { resets: 0, chars: 0, writes: 0 };
  return {
    log,
    term: {
      write(data, callback) {
        log.writes += 1;
        log.chars += data.length;
        if (data === "\x1bc") log.resets += 1;
        t.write(data, callback);
      },
      resize(cols, rows) {
        t.resize(cols, rows);
      }
    }
  };
}

test("createReplayDrawer: 50 seeks back in a row make one pass with one reset and end on the screen one seek to the last gives", async () => {
  const c = bigCast(60);
  const t = new HeadlessTerminal({ cols: c.width, rows: c.height, logLevel: "off" });
  try {
    const { log, term } = countingTerminal(t);
    const drawer = replay.createReplayDrawer(term, c);
    drawer.seek(c.events.length);
    await drawer.idle();
    assert.equal(log.resets, 0, "going forward needs no reset");
    assert.ok(screenLines(t).some((line) => line.startsWith("marker-59")));
    log.resets = 0;
    log.chars = 0;
    for (let index = 50; index >= 1; index -= 1) drawer.seek(index);
    await drawer.idle();
    assert.equal(log.resets, 1, "one reset, not fifty");
    assert.ok(log.chars < 1.2 * c.events.slice(0, 1).reduce((sum, event) => sum + event[2].length, 0) + 10, "and only the first event drawn again");
    assert.deepEqual({ lines: screenLines(t), cols: t.cols, rows: t.rows }, await screenAt(c, 1));
    // Going on forward from there is still exact.
    drawer.seek(30);
    await drawer.idle();
    assert.deepEqual({ lines: screenLines(t), cols: t.cols, rows: t.rows }, await screenAt(c, 30));
    drawer.seek(30);
    drawer.seek(c.events.length);
    await drawer.idle();
    assert.deepEqual({ lines: screenLines(t), cols: t.cols, rows: t.rows }, await screenAt(c, c.events.length));
  } finally {
    t.dispose();
  }
});

test("createReplayDrawer: a seek back while a redraw runs stops it at the next piece and starts again from a reset; a seek forward lets it carry on; a closed terminal draws nothing more", async () => {
  const c = bigCast();
  const written = [];
  const pending = [];
  const fake = {
    write(data, callback) {
      written.push(data);
      pending.push(callback);
    },
    resize() {}
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Lets the fake terminal "read" what it was given, one piece at a time, until the drawer is idle.
  async function drain(drawer) {
    let finished = false;
    void drawer.idle().then(() => {
      finished = true;
    });
    for (let guard = 0; guard < 2000 && !finished; guard += 1) {
      await tick();
      pending.shift()?.();
    }
    assert.equal(finished, true, "the drawer settled");
  }
  const drawer = replay.createReplayDrawer(fake, c);
  drawer.seek(20);
  await tick();
  for (let i = 0; i < 3; i += 1) {
    pending.shift()();
    await tick();
  }
  assert.ok(written.length >= 3 && written.length < 10, `still in the middle of the first pass (${written.length} pieces given so far)`);
  drawer.seek(40);
  await drain(drawer);
  // Forward during a pass: nothing is cut short and nothing is reset.
  assert.equal(written.includes("\x1bc"), false, "a seek forward never resets");
  const full = c.events.reduce((sum, event) => sum + event[2].length, 0);
  assert.equal(written.join("").length, full, "every event drawn once");

  // Now back, during the pass drawing the way forward again.
  written.length = 0;
  pending.length = 0;
  const second = replay.createReplayDrawer(fake, c);
  second.seek(c.events.length);
  await tick();
  for (let i = 0; i < 3; i += 1) {
    pending.shift()();
    await tick();
  }
  const given = written.length;
  second.seek(5);
  second.seek(3);
  await drain(second);
  const after = written.slice(given);
  // The piece in flight when the seek came is the last one of the old pass; then one reset, then the first 3 events only.
  const resetAt = after.indexOf("\x1bc");
  assert.ok(resetAt >= 0 && resetAt <= 1, `the reset follows at once (position ${resetAt})`);
  assert.equal(after.filter((data) => data === "\x1bc").length, 1, "once");
  const redrawn = after.slice(resetAt + 1).join("");
  assert.equal(redrawn.length, c.events.slice(0, 3).reduce((sum, event) => sum + event[2].length, 0), "and then only what the last seek asked for");

  // A terminal that is gone is not written to.
  let gone = false;
  const closed = replay.createReplayDrawer(fake, c, { stopped: () => gone });
  written.length = 0;
  pending.length = 0;
  closed.seek(10);
  gone = true;
  await tick();
  await closed.idle();
  assert.equal(written.length, 0, "nothing drawn once stopped");
});
