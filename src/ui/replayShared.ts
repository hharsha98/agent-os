// Runs → Session recordings → one recording's replay (spec SP4 "Recordings in Runs"; Task U11): the pure logic.
// ReplayPlayer.tsx plays the recording (asciicast v2, as recorder.js writes it) in a read-only xterm. This file reads
// the cast, builds its timeline (the true wall-clock length, idle gaps over 30 s that playing skips and the timeline
// draws hatched, and the span whose output a rotation removed, marked "[earlier output removed]"), turns meta.json's
// markers into the moments, moves the playhead and lists the steps that draw the screen at a time. `import type` only,
// so test/sessions-replay-logic.test.js loads it straight from src/ (decision P14).
import type { SessionMarker } from "../types";

// ---------------------------------------------------------------------------
// Constants and words
// ---------------------------------------------------------------------------

// Spec: speed 1× / 10× / 30×. The prototype starts at 10× (runs.html, `speed = 10`).
export const REPLAY_SPEEDS = [1, 10, 30] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export const DEFAULT_SPEED: ReplaySpeed = 10;
// Spec: idle gaps over 30 s are skipped while playing.
export const IDLE_SKIP_S = 30;
// How often the playhead moves while playing (the prototype's 100 ms).
export const TICK_MS = 100;
// A moment's own output lands around its marker (the hook fires as the prompt or the question is drawn), so a click
// on a moment shows the screen one second after it (prototype: `pos = t + 1`).
export const MOMENT_LEAD_S = 1;
// recorder.js's ROTATION_MARKER (copied: this file imports nothing at run time; the test checks they agree).
export const ROTATION_MARKER = "[earlier output removed]";

// Spec words, word for word.
export const IDLE_WORDS = "Idle, skipped while playing";
export const REMOVED_WORDS = ROTATION_MARKER;
export const MOMENTS_TITLE = "Moments in this recording";
// recorder.js's own refusal (RECORDING_LIVE), shown next to the Delete button it switches off.
export const DELETE_WHILE_LIVE = "That session is still running. Stop it first, then delete its recording.";
// recorder.js's RECORDING_MISSING: a replay asked for a recording the list no longer has.
export const RECORDING_GONE = "That recording doesn't exist anymore.";
// NEW SENTENCE (Q32), each one.
export const REPLAY_CAPTION = "A replay plays back what was on screen. It never runs anything again.";
export const NO_MOMENTS = "No moments were marked in this recording.";
export const MOMENTS_UNREADABLE = "The moments of this recording couldn't be read.";
export const CAST_UNREADABLE = "This recording can't be played back: its file couldn't be read.";

export function speedLabel(speed: number): string {
  return `${speed}×`;
}

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

export type CastEventType = "o" | "m" | "r";
export type CastEvent = readonly [number, CastEventType, string];
export interface ParsedCast {
  width: number;
  height: number;
  // Whole seconds (Unix time) when the recording began. Event times count from it, across resumes and rotations.
  timestamp: number;
  // Never decreasing in time.
  events: CastEvent[];
}

const SIZE_MAX = 1000;

function cells(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= SIZE_MAX ? n : fallback;
}

// The recording as the route streams it: one header line, then one event per line. A line that does not read (the
// half-written last line of a live recording) or an event of another type is skipped; a time that goes back is held
// at the one before. null when the first line is not an asciicast v2 header.
export function parseCast(text: unknown): ParsedCast | null {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split("\n");
  let header: unknown;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) return null;
  const h = header as Record<string, unknown>;
  const timestamp = h.timestamp;
  if (h.version !== 2 || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const events: CastEvent[] = [];
  let last = 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    let event: unknown;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!Array.isArray(event) || event.length < 3) continue;
    const [at, type, data] = event as unknown[];
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || typeof data !== "string") continue;
    const kind: CastEventType | null = type === "o" ? "o" : type === "m" ? "m" : type === "r" ? "r" : null;
    if (!kind) continue;
    last = Math.max(last, at);
    events.push([last, kind, data]);
  }
  return { width: cells(h.width, 80), height: cells(h.height, 24), timestamp, events };
}

// "<cols>x<rows>" of a resize event, or null.
export function parseSize(data: string): { cols: number; rows: number } | null {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(data);
  if (!match) return null;
  const cols = cells(match[1], 0);
  const rows = cells(match[2], 0);
  return cols && rows ? { cols, rows } : null;
}

// ---------------------------------------------------------------------------
// Markers and moments
// ---------------------------------------------------------------------------

type MarkerFile = { path: string; added: number | null; removed: number | null };

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readFiles(value: unknown): MarkerFile[] {
  if (!Array.isArray(value)) return [];
  const files: MarkerFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const filePath = f.path;
    if (typeof filePath !== "string" || !filePath) continue;
    files.push({ path: filePath, added: count(f.added), removed: count(f.removed) });
  }
  return files;
}

// The markers route's answer ({ markers: [...] }) or a bare list, checked: an entry without a readable time or of a
// type the replay does not know is dropped. A prompt marker keeps no text even if one came (R23).
export function readMarkers(answer: unknown): SessionMarker[] {
  const list: unknown[] = Array.isArray(answer)
    ? answer
    : answer && typeof answer === "object" && Array.isArray((answer as { markers?: unknown }).markers)
      ? (answer as { markers: unknown[] }).markers
      : [];
  const out: SessionMarker[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const at = m.at;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) continue;
    if (m.type === "prompt") out.push({ at, type: "prompt" });
    else if (m.type === "permission") out.push({ at, type: "permission", text: typeof m.text === "string" ? m.text : "" });
    else if (m.type === "files") out.push({ at, type: "files", files: readFiles(m.files), more: count(m.more) ?? 0 });
  }
  return out;
}

export type MomentType = SessionMarker["type"];
export interface ReplayMoment {
  // Seconds on the recording's clock.
  t: number;
  type: MomentType;
  // The timeline key's word: "Prompt", "Permission asked", "Files changed".
  word: string;
  // "Prompt", "Permission asked: <text>", "Files changed: <n>".
  label: string;
  // The small line under the word: the question's text, or the files with +/− ("" for a prompt, R23).
  detail: string;
}

// NEW SENTENCE (Q32): the timeline key's words (the prototype's).
export const MOMENT_WORDS: Readonly<Record<MomentType, string>> = { prompt: "Prompt", permission: "Permission asked", files: "Files changed" };

// "<path> (+<added> −<removed>)", or the path alone when git gave no counts (a binary file).
export function fileWords(file: MarkerFile): string {
  return typeof file.added === "number" && typeof file.removed === "number" ? `${file.path} (+${file.added} −${file.removed})` : file.path;
}

function momentOf(marker: SessionMarker): Omit<ReplayMoment, "t"> {
  if (marker.type === "permission") {
    const text = marker.text.trim();
    return { type: "permission", word: MOMENT_WORDS.permission, label: text ? `${MOMENT_WORDS.permission}: ${text}` : MOMENT_WORDS.permission, detail: text };
  }
  if (marker.type === "files") {
    const shown = marker.files.map(fileWords).join(", ");
    const detail = marker.more > 0 ? `${shown ? `${shown}, and ` : ""}${marker.more} more` : shown;
    return { type: "files", word: MOMENT_WORDS.files, label: `${MOMENT_WORDS.files}: ${marker.files.length + marker.more}`, detail };
  }
  return { type: "prompt", word: MOMENT_WORDS.prompt, label: MOMENT_WORDS.prompt, detail: "" };
}

// A moment's accessible name: "<label>, <time>"; a files moment also names its files.
export function momentName(moment: ReplayMoment): string {
  return [moment.label, moment.type === "files" ? moment.detail : "", clockWords(moment.t)].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export type SegmentKind = "play" | "idle" | "removed";
export interface TimelineSegment {
  from: number;
  to: number;
  kind: SegmentKind;
}
export interface ReplayTimeline {
  // The true wall-clock length, in seconds from the recording's start.
  wallSeconds: number;
  // Where output is still recorded from (0 when nothing was removed).
  removedSeconds: number;
  // From 0 to wallSeconds, end to end, neighbours of the same kind joined.
  segments: TimelineSegment[];
  // Sorted by time.
  moments: ReplayMoment[];
}

// `endAt` is an ended session's end (ISO): its timeline runs to it, as the row's Length does. A live recording ends at
// its last event. Idle is a stretch longer than `idleSkipS` with no output (resize and marker events are not output);
// removed is 0 to the rotation marker, which the route keeps only at the start of what is still recorded. A marker
// before 0 belongs to an earlier recording of the same session (deleted, or removed by the 1 GB cap, before a Resume
// started this one) and is left out; one after the end sits at the end.
export function buildTimeline(
  cast: ParsedCast,
  markers: unknown,
  { idleSkipS = IDLE_SKIP_S, endAt = null }: { idleSkipS?: number; endAt?: string | null } = {}
): ReplayTimeline {
  const startMs = cast.timestamp * 1000;
  const events = cast.events;
  const lastEvent = events.length ? events[events.length - 1][0] : 0;
  const endMs = typeof endAt === "string" ? Date.parse(endAt) : NaN;
  const wallSeconds = Math.max(0, lastEvent, Number.isFinite(endMs) ? (endMs - startMs) / 1000 : 0);
  let removedSeconds = 0;
  for (const [t, type, data] of events) {
    if (type === "m" && data === ROTATION_MARKER) {
      removedSeconds = t;
      break;
    }
  }
  const segments: TimelineSegment[] = [];
  const push = (from: number, to: number, kind: SegmentKind) => {
    if (!(to > from)) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.kind === kind && prev.to === from) prev.to = to;
    else segments.push({ from, to, kind });
  };
  const gapKind = (gap: number): SegmentKind => (gap > idleSkipS ? "idle" : "play");
  push(0, removedSeconds, "removed");
  let at = removedSeconds;
  for (const [t, type] of events) {
    if (type !== "o" || t < removedSeconds) continue;
    push(at, t, gapKind(t - at));
    at = t;
  }
  push(at, wallSeconds, gapKind(wallSeconds - at));
  const moments: ReplayMoment[] = [];
  for (const marker of readMarkers(markers)) {
    const t = (Date.parse(marker.at) - startMs) / 1000;
    if (!(t >= 0)) continue;
    moments.push({ t: Math.min(t, wallSeconds), ...momentOf(marker) });
  }
  moments.sort((a, b) => a.t - b.t);
  return { wallSeconds, removedSeconds, segments, moments };
}

// The playhead after `seconds` of the recording have played from `pos`: play segments use the time up, idle and
// removed ones are jumped at once (spec: idle gaps are skipped while playing). Stops at the end.
export function advance(segments: readonly TimelineSegment[], pos: number, seconds: number): number {
  let at = Number.isFinite(pos) ? Math.max(0, pos) : 0;
  let left = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  for (const segment of segments) {
    if (segment.to <= at) continue;
    if (segment.kind !== "play") {
      at = segment.to;
      continue;
    }
    const from = Math.max(at, segment.from);
    const room = segment.to - from;
    if (left <= room) return from + left;
    left -= room;
    at = segment.to;
  }
  return at;
}

// How many events have happened by `pos` (times are never decreasing, so a binary search).
export function eventIndexAt(events: readonly CastEvent[], pos: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid][0] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Drawing the screen
// ---------------------------------------------------------------------------

export type ReplayStep = { kind: "reset" } | { kind: "resize"; cols: number; rows: number } | { kind: "write"; data: string };

// The most one write step holds (UTF-16 units, about 256 KB). xterm parses one write in one go without letting the page
// do anything else, so a redraw of tens of MB must reach it in pieces: each piece is parsed in its own turn of the
// event loop (runReplaySteps waits for each), and the page stays usable between them (Task U11, fix round 1, I-1).
export const WRITE_PIECE_MAX = 256 * 1024;

// From a screen showing the first `from` events to one showing the first `to`. Forward: the new output, joined, split
// where the recording was resized and into pieces of at most WRITE_PIECE_MAX. Back: a full reset at the recording's
// first size, then everything again.
export function replaySteps(cast: ParsedCast, from: number, to: number): ReplayStep[] {
  const end = Math.max(0, Math.min(to, cast.events.length));
  let start = Math.max(0, Math.min(from, cast.events.length));
  const steps: ReplayStep[] = [];
  if (end < start) {
    steps.push({ kind: "reset" }, { kind: "resize", cols: cast.width, rows: cast.height });
    start = 0;
  }
  let text = "";
  // Writes out every full piece (and, with `all`, the rest); a piece never ends between the two halves of a character.
  const flush = (all: boolean) => {
    while (text.length >= WRITE_PIECE_MAX || (all && text.length > 0)) {
      let cut = Math.min(WRITE_PIECE_MAX, text.length);
      const last = text.charCodeAt(cut - 1);
      if (cut < text.length && cut > 1 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
      steps.push({ kind: "write", data: text.slice(0, cut) });
      text = text.slice(cut);
    }
  };
  for (let i = start; i < end; i += 1) {
    const [, type, data] = cast.events[i];
    if (type === "o") {
      text += data;
      if (text.length >= WRITE_PIECE_MAX) flush(false);
    } else if (type === "r") {
      const size = parseSize(data);
      if (size) {
        flush(true);
        steps.push({ kind: "resize", cols: size.cols, rows: size.rows });
      }
    }
  }
  flush(true);
  return steps;
}

// The parts of an xterm terminal the replay drives: the page's Terminal, or @xterm/headless's in the tests.
export interface ReplayTerminal {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
}

// Draws the steps in order. Each write waits until xterm has read it, and a resize happens only between writes, never
// inside a write callback (terminalShared.ts restoreScreen says why); an empty write is never sent (writeParsed says
// why). `stopped()` is asked before each step: a replay that closed, or one that wants a different screen, draws
// nothing more. Answers whether every step ran.
export async function runReplaySteps(t: ReplayTerminal, steps: readonly ReplayStep[], stopped: () => boolean = () => false): Promise<boolean> {
  for (const step of steps) {
    if (stopped()) return false;
    if (step.kind === "resize") {
      t.resize(step.cols, step.rows);
      continue;
    }
    const data = step.kind === "reset" ? "\x1bc" : step.data;
    if (data) await new Promise<void>((resolve) => t.write(data, resolve));
  }
  return true;
}

export interface ReplayDrawer {
  // Asks for the screen after the first `index` events. Only the latest ask matters: the drawer never keeps a line of
  // them, so a person holding an arrow key on "Replay position" cannot queue up redraws.
  seek(index: number): void;
  // Settles once the screen shows the latest ask (or the drawing was stopped).
  idle(): Promise<void>;
}

// Draws a recording onto `t`, one pass at a time (Task U11, fix round 1, I-1). A pass works from what is really on
// screen to the latest ask, in pieces (replaySteps). Asks made together become one pass (the pass starts a turn of the
// event loop later). A forward ask changes nothing about a pass already running: it carries on, then goes on to the
// new ask. An ask for an earlier screen than the one the pass is drawing stops it at the next piece: the screen then
// holds an unknown part, so the next pass starts from a reset. `stopped()` is true once the terminal is gone.
// `onResized` runs after a pass that changed the terminal's size (the page refits its font).
export function createReplayDrawer(
  t: ReplayTerminal,
  cast: ParsedCast,
  { stopped = () => false, onResized }: { stopped?: () => boolean; onResized?: () => void } = {}
): ReplayDrawer {
  let shown = 0;
  let dirty = false;
  let target = 0;
  let running: Promise<void> | null = null;

  async function pass(): Promise<void> {
    try {
      await Promise.resolve();
      while (!stopped() && (dirty || shown !== target)) {
        const goal = target;
        const steps: ReplayStep[] = dirty
          ? [{ kind: "reset" }, { kind: "resize", cols: cast.width, rows: cast.height }, ...replaySteps(cast, 0, goal)]
          : replaySteps(cast, shown, goal);
        const resized = steps.some((step) => step.kind !== "write");
        const done = await runReplaySteps(t, steps, () => stopped() || target < goal);
        if (done) {
          shown = goal;
          dirty = false;
        } else {
          dirty = true;
        }
        if (resized) onResized?.();
      }
    } finally {
      running = null;
    }
  }

  return {
    seek(index: number) {
      target = Math.max(0, Math.min(Math.floor(index) || 0, cast.events.length));
      if (!running) running = pass().catch(() => undefined);
    },
    idle: () => running ?? Promise.resolve()
  };
}

// JetBrains Mono's cell is 0.6 em wide; xterm's row is lineHeight em tall.
export const CELL_WIDTH_EM = 0.6;
export const REPLAY_FONT_MIN = 6;

// The largest whole font size up to `max` at which the recording's columns and rows fit the box, never below 6 px
// (a very wide recording then scrolls inside its box, never the page). A box not laid out yet keeps `max`.
export function fitFontSize({
  boxWidth,
  boxHeight,
  cols,
  rows,
  max = 13,
  lineHeight = 1.2
}: {
  boxWidth: number;
  boxHeight: number;
  cols: number;
  rows: number;
  max?: number;
  lineHeight?: number;
}): number {
  if (!(boxWidth > 0) || !(boxHeight > 0) || !(cols > 0) || !(rows > 0)) return max;
  const fits = Math.min(boxWidth / (cols * CELL_WIDTH_EM), boxHeight / (rows * lineHeight));
  return Math.max(REPLAY_FONT_MIN, Math.min(max, Math.floor(fits)));
}

// ---------------------------------------------------------------------------
// Small helpers for the page
// ---------------------------------------------------------------------------

export function timelinePercent(t: number, wallSeconds: number): number {
  if (!(wallSeconds > 0) || !Number.isFinite(t)) return 0;
  return Math.min(100, Math.max(0, (t / wallSeconds) * 100));
}

// The index of the last moment at or before the playhead, or -1.
export function currentMoment(moments: readonly ReplayMoment[], pos: number): number {
  let current = -1;
  for (let i = 0; i < moments.length; i += 1) {
    if (moments[i].t <= pos) current = i;
    else break;
  }
  return current;
}

const pad = (n: number) => String(n).padStart(2, "0");

// "12 s", "4 m 16 s", "1 h 02 m 05 s" (the prototype's clock words, with hours for long recordings).
export function clockWords(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${pad(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} m ${pad(s % 60)} s`;
}

// ---------------------------------------------------------------------------
// The dialogs and notes
// ---------------------------------------------------------------------------

export interface ReplayResumeCopy {
  title: string;
  body: string[];
  warning: string | null;
  cancel: string;
  confirm: string;
}

// The replay header's Resume confirm (spec: the prototype's, runs.html "Resume this conversation?"), with SP3's
// fallback warning and its last sentence (sessionsShared.ts resumeConfirmCopy). `folder` is null where Agent OS does not
// show one (OpenClaw).
export function replayResumeCopy({ agent, folder, fallback }: { agent: string; folder: string | null; fallback: boolean }): ReplayResumeCopy {
  const where = folder ? ` in ${folder}` : "";
  return {
    title: "Resume this conversation?",
    body: [
      `Agent OS opens a new terminal${where} and starts ${agent} with its own resume feature.`,
      "Agent OS does not paste the old text back in and does not press Enter for you. The recording continues after a marker."
    ],
    warning: fallback ? `This resumes the most recent ${agent} conversation in this folder, which may be one you started outside Agent OS.` : null,
    cancel: "Cancel",
    confirm: "Resume conversation"
  };
}

// The Delete recording confirm. After a delete, Runs no longer lists the session (it has no recording), so a session
// whose tab was dismissed is then shown nowhere; the words say so.
export function deleteConfirmCopy({ kind, dismissed }: { kind: "agent" | "update"; dismissed: boolean }): { title: string; body: string[]; confirm: string } {
  const body = ["Agent OS deletes what this session's terminal showed, and its moments, from this computer. This can't be undone."];
  if (kind === "agent") {
    body.push(
      dismissed
        ? "You dismissed this session's tab, so after this Agent OS no longer lists the session anywhere."
        : "The session's tab stays on the Sessions page, and so does its Resume conversation."
    );
  }
  return { title: "Delete this recording?", body, confirm: "Delete recording" };
}

// NEW SENTENCE (Q32): the coverage note for a replay read while its session ran, once the session has ended.
export function endedSinceNote(seconds: number): string {
  return `The session has ended since. This replay covers the first ${clockWords(seconds)}. Close it and open it again to see the rest.`;
}

export function liveNote(seconds: number): string {
  return `Still recording. This replay covers the first ${clockWords(seconds)}. To see the rest, open the live session.`;
}

export function endedNote(agent: string): string {
  return `Resume conversation starts ${agent} again with its own resume feature. Agent OS does not copy the text.`;
}

const FINAL_DELETE_REFUSALS = new Set(["recording_live", "recording_missing", "unknown_session"]);

// A Delete the server refused in a way another try cannot change as things stand: the dialog then shuts its Delete
// button and keeps the server's sentence. An Error is Agent OS's own answer when it is named "ApiError" (src/api.ts).
export function isFinalDeleteRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === "ApiError" && FINAL_DELETE_REFUSALS.has(error.message);
}

// The words for a Delete that did not work: the server's own sentence, or what is known when no readable answer came
// (it may have happened; the list, read again, shows the truth).
export function deleteProblem(error: unknown, gotNoAnswer: boolean): string {
  if (error instanceof Error && error.name === "ApiError") {
    const detail = String((error as Error & { detail?: unknown }).detail || "").trim();
    return detail || "Agent OS couldn't delete this recording. Try again.";
  }
  return gotNoAnswer
    ? "Agent OS didn't answer, so the recording may or may not be deleted. The list shows it only while it is still there."
    : "Agent OS answered, but the answer couldn't be read. The list shows the recording only while it is still there.";
}
