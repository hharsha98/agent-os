// Runs → Session recordings → one recording's replay (spec SP4 "Recordings in Runs"; Task U11). The asciicast plays in
// a read-only xterm at 1×, 10× or 30×; the timeline shows the recording's moments (prompt, permission asked, files
// changed, from meta.json's markers), its idle gaps over 30 s (skipped while playing, drawn hatched) and its true
// wall-clock length, with the span whose output a rotation removed marked "[earlier output removed]". The header offers
// Resume conversation, or Open live session while the session runs, and Delete recording (off while it runs); the page
// (SessionRecordings.tsx) asks first in its dialogs. The terminal is only drawn into: it takes no keys, sends no
// replies anywhere and opens no links. The pure logic is in replayShared.ts, where test/sessions-replay-logic.test.js
// checks it; both reads carry their own time limits (sessionsApi.ts).
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleHelp, FileText, History, Info, Pause, Play, Send, SquareTerminal, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { fetchRecording, getMarkers, sessionProblem } from "../../sessionsApi";
import type { SessionSummary } from "../../types";
import { collapseHomePath } from "../agentsShared";
import { visibleText } from "../changesShared";
import { recordedAt } from "../recordingsShared";
import type { RecordingRow, RowAction } from "../recordingsShared";
import {
  CAST_UNREADABLE,
  DEFAULT_SPEED,
  DELETE_WHILE_LIVE,
  IDLE_WORDS,
  MOMENT_LEAD_S,
  MOMENT_WORDS,
  MOMENTS_TITLE,
  MOMENTS_UNREADABLE,
  NO_MOMENTS,
  REMOVED_WORDS,
  REPLAY_CAPTION,
  REPLAY_SPEEDS,
  TICK_MS,
  advance,
  buildTimeline,
  clockWords,
  createReplayDrawer,
  currentMoment,
  endedNote,
  endedSinceNote,
  eventIndexAt,
  fitFontSize,
  liveNote,
  momentName,
  parseCast,
  speedLabel,
  timelinePercent
} from "../replayShared";
import type { MomentType, ParsedCast, ReplayDrawer, ReplayMoment, ReplaySpeed, ReplayTimeline } from "../replayShared";
import { sessionTitle } from "../sessionsShared";
import { TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT, TERMINAL_SCROLLBACK, terminalTheme } from "../terminalShared";
import Banner from "./Banner";
import { TimeAgo } from "./RelativeTime";
import StatusWord from "./StatusWord";
import VisibleText from "./VisibleText";

const MOMENT_ICONS: Record<MomentType, LucideIcon> = { prompt: Send, permission: CircleHelp, files: FileText };

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

// The box's room for the terminal: its size less its padding (the spacing tokens change with the laptop density).
function innerSize(box: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(box);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return { width: box.clientWidth - (padX || 0), height: box.clientHeight - (padY || 0) };
}

type Loaded =
  | { state: "loading" }
  // `readLive`: the session was still running when the recording was read, so the replay covers only its first part,
  // however long ago the session has ended since (fix round 1, M-2).
  | { state: "ok"; cast: ParsedCast; timeline: ReplayTimeline; momentsRead: boolean; readLive: boolean }
  | { state: "error"; message: string };

// The timeline's hatched idle gaps and its removed span. Drawn again only when the recording changes.
const TrackMarks = memo(function TrackMarks({ timeline }: { timeline: ReplayTimeline }) {
  return (
    <>
      {timeline.segments.map((segment) =>
        segment.kind === "play" ? null : (
          <span
            key={`${segment.kind}-${segment.from}`}
            className={segment.kind === "idle" ? "os-replay__idle" : "os-replay__removed"}
            title={segment.kind === "idle" ? IDLE_WORDS : REMOVED_WORDS}
            style={{
              left: `${timelinePercent(segment.from, timeline.wallSeconds)}%`,
              width: `${timelinePercent(segment.to - segment.from, timeline.wallSeconds)}%`
            }}
          />
        )
      )}
    </>
  );
});

// One pin per moment, on two lanes (prototype). Mouse shortcuts only: out of the tab order and hidden from assistive
// technology, because the moments list next to the player offers the same moments as buttons (a session keeps up to
// 500, decision K20). A path or an alert text in a name shows its hidden characters as tokens (visibleText, Task U7).
const Pins = memo(function Pins({
  moments,
  wallSeconds,
  current,
  onPick
}: {
  moments: ReplayMoment[];
  wallSeconds: number;
  current: number;
  onPick: (moment: ReplayMoment) => void;
}) {
  return (
    <>
      {moments.map((moment, i) => {
        const Icon = MOMENT_ICONS[moment.type];
        const lane = String(i % 2);
        const left = `${timelinePercent(moment.t, wallSeconds)}%`;
        return (
          <span key={`${moment.t}-${i}`}>
            <span className="os-replay__stem" data-lane={lane} style={{ left }} />
            <button
              type="button"
              className="os-replay__pin"
              data-kind={moment.type}
              data-lane={lane}
              style={{ left }}
              tabIndex={-1}
              aria-hidden="true"
              aria-current={i === current ? "true" : undefined}
              title={visibleText(momentName(moment))}
              onClick={() => onPick(moment)}
            >
              <Icon size={12} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </>
  );
});

// "Moments in this recording": the keyboard's way to the moments. The current one says aria-current; later ones are dim.
const MomentList = memo(function MomentList({
  moments,
  current,
  onPick
}: {
  moments: ReplayMoment[];
  current: number;
  onPick: (moment: ReplayMoment) => void;
}) {
  return (
    <div className="os-replay__moments">
      {moments.map((moment, i) => {
        const Icon = MOMENT_ICONS[moment.type];
        return (
          <button
            key={`${moment.t}-${i}`}
            type="button"
            className={`os-replay__moment${i > current ? " is-future" : ""}`}
            data-kind={moment.type}
            aria-current={i === current ? "true" : undefined}
            aria-label={visibleText(momentName(moment))}
            onClick={() => onPick(moment)}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="os-replay__what">
              {moment.word}
              {moment.detail ? (
                <small>
                  <VisibleText text={moment.detail} />
                </small>
              ) : null}
            </span>
            <span className="os-mono">{clockWords(moment.t)}</span>
          </button>
        );
      })}
    </div>
  );
});

export default function ReplayPlayer({
  row,
  session,
  action,
  live,
  onResume,
  onOpenLive,
  onDelete
}: {
  row: RecordingRow;
  session: SessionSummary | undefined;
  action: RowAction;
  live: boolean;
  onResume: () => void;
  onOpenLive: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const speedId = useId();
  const deleteWhyId = useId();
  const resumeWhyId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  // Draws the screen: one pass at a time towards the latest position asked for, never a line of redraws (fix round 1, I-1).
  const drawerRef = useRef<ReplayDrawer | null>(null);
  const posRef = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  // Read once per load: a session that ends while its replay is open keeps the timeline it was read with.
  const endAtRef = useRef<string | null>(null);
  endAtRef.current = live ? null : row.endedAt;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(DEFAULT_SPEED);
  const cast = loaded.state === "ok" ? loaded.cast : null;
  const timeline = loaded.state === "ok" ? loaded.timeline : null;

  // The replay takes the keyboard when it opens (the Replay button that opened it is gone).
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // The recording and its moments, read together. A replay that closes stops the download.
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoaded({ state: "loading" });
    setPlaying(false);
    void (async () => {
      const [castRead, markersRead] = await Promise.allSettled([fetchRecording(row.sessionId, { signal: controller.signal }), getMarkers(row.sessionId)]);
      if (!current) return;
      if (castRead.status === "rejected") {
        setLoaded({ state: "error", message: sessionProblem(castRead.reason) });
        return;
      }
      const parsed = parseCast(castRead.value);
      if (!parsed) {
        setLoaded({ state: "error", message: CAST_UNREADABLE });
        return;
      }
      const markers = markersRead.status === "fulfilled" ? markersRead.value : [];
      setLoaded({
        state: "ok",
        cast: parsed,
        // An ended session's timeline runs to its end; a live one's to what was recorded when the replay opened.
        timeline: buildTimeline(parsed, markers, { endAt: endAtRef.current }),
        momentsRead: markersRead.status === "fulfilled",
        readLive: liveRef.current
      });
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [row.sessionId, attempt]);

  // Asks for the screen at the events up to `at`. The drawer goes forward with only the new events and back with a clean
  // screen and everything again, in pieces, and keeps only the latest ask; a closed terminal draws nothing more.
  const draw = useCallback(
    (at: number) => {
      if (!cast) return;
      drawerRef.current?.seek(eventIndexAt(cast.events, at));
    },
    [cast]
  );

  const moveTo = useCallback(
    (at: number) => {
      if (!timeline) return;
      const next = Math.min(Math.max(at, 0), timeline.wallSeconds);
      posRef.current = next;
      setPos(next);
      draw(next);
    },
    [timeline, draw]
  );

  // The read-only terminal, at the recording's own size; its font shrinks (13 px down to 6 px) so the whole screen
  // fits the box. The DOM renderer only, no add-on that reaches out (links, clipboard), and no input handler at all.
  useEffect(() => {
    const host = hostRef.current;
    const box = boxRef.current;
    if (!cast || !timeline || !host || !box) return undefined;
    const t = new Terminal({
      cols: cast.width,
      rows: cast.height,
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: readToken("--os-font-mono").trim() || "monospace",
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: TERMINAL_SCROLLBACK,
      theme: terminalTheme(readToken),
      // An OSC 8 link in the recording opens nothing (xterm's own default would ask the browser, then open it).
      linkHandler: { activate: () => undefined, allowNonHttpProtocols: false }
    });
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = "11";
    t.open(host);
    // The keyboard goes past the terminal's own text box: nothing can be typed into a replay.
    t.textarea?.setAttribute("tabindex", "-1");
    termRef.current = t;
    const fit = () => {
      if (termRef.current !== t) return;
      const room = innerSize(box);
      const size = fitFontSize({ boxWidth: room.width, boxHeight: room.height, cols: t.cols, rows: t.rows, max: TERMINAL_FONT_SIZE, lineHeight: TERMINAL_LINE_HEIGHT });
      if (t.options.fontSize !== size) t.options.fontSize = size;
    };
    fitRef.current = fit;
    fit();
    const watch = new ResizeObserver(() => fit());
    watch.observe(box);
    // It opens at the first second still recorded, paused.
    const start = timeline.removedSeconds;
    posRef.current = start;
    setPos(start);
    const drawer = createReplayDrawer(t, cast, {
      stopped: () => termRef.current !== t,
      onResized: () => {
        if (termRef.current === t) fitRef.current?.();
      }
    });
    drawerRef.current = drawer;
    drawer.seek(eventIndexAt(cast.events, start));
    return () => {
      watch.disconnect();
      fitRef.current = null;
      drawerRef.current = null;
      termRef.current = null;
      t.dispose();
    };
  }, [cast, timeline]);

  // Playing: every TICK_MS the playhead moves by the time passed times the speed, through output only (idle gaps and
  // the removed span are jumped at once), and stops at the end. A hidden window does not race ahead.
  useEffect(() => {
    if (!playing || !timeline) return undefined;
    let last = performance.now();
    const id = window.setInterval(() => {
      const nowMs = performance.now();
      const passed = ((nowMs - last) / 1000) * speed;
      last = nowMs;
      if (document.hidden) return;
      const next = advance(timeline.segments, posRef.current, passed);
      moveTo(next);
      if (next >= timeline.wallSeconds) setPlaying(false);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, speed, timeline, moveTo]);

  function togglePlay() {
    if (!timeline) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // At the end, Play starts again from the first second still recorded.
    if (posRef.current >= timeline.wallSeconds) moveTo(timeline.removedSeconds);
    setPlaying(true);
  }

  // A moment: the screen one second after it (MOMENT_LEAD_S), where its own output has landed.
  const pick = useCallback((moment: ReplayMoment) => moveTo(moment.t + MOMENT_LEAD_S), [moveTo]);

  const title = sessionTitle(row);
  const agent = row.agentLabel || row.agentId || "Agent";
  const firstStart = recordedAt(row);
  const current = timeline ? currentMoment(timeline.moments, pos) : -1;
  // A replay read while its session ran covers only the first part for as long as it stays open (fix round 1, M-2).
  const readLive = loaded.state === "ok" && loaded.readLive;
  const notes: string[] = [];
  if (timeline) {
    if (live) notes.push(liveNote(timeline.wallSeconds));
    else if (readLive) notes.push(endedSinceNote(timeline.wallSeconds));
    if (!live && action.kind === "resume" && action.available) notes.push(endedNote(agent));
  }
  const rangeMax = timeline ? Math.max(1, Math.ceil(timeline.wallSeconds)) : 1;
  const hasIdle = timeline ? timeline.segments.some((segment) => segment.kind === "idle") : false;

  return (
    <section className="os-replay" aria-labelledby={titleId}>
      <header className="os-replay__head">
        <div className="os-replay__intro">
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className="os-replay__title os-trunc" title={visibleText(title)}>
            <VisibleText text={title} />
          </h2>
          <p className="os-replay__facts">
            {live ? <StatusWord state="live" label="Recording" /> : <StatusWord state="ready" label="Saved" />}
            <span className="os-replay__sep" aria-hidden="true" />
            {row.kind === "update" ? (
              <span>Agent update</span>
            ) : !row.folderShown ? (
              <span>Folder set by OpenClaw</span>
            ) : (
              <span>
                Folder{" "}
                <span className="os-mono">
                  <VisibleText text={collapseHomePath(row.folder) || "—"} />
                </span>
              </span>
            )}
            {session?.branch ? (
              <>
                <span className="os-replay__sep" aria-hidden="true" />
                <span>
                  Branch{" "}
                  <span className="os-mono">
                    <VisibleText text={session.branch} />
                  </span>
                </span>
              </>
            ) : null}
            <span className="os-replay__sep" aria-hidden="true" />
            <span>Recorded {firstStart ? <TimeAgo since={firstStart} /> : "—"}</span>
            <span className="os-replay__sep" aria-hidden="true" />
            <span>
              True length <span className="os-mono">{timeline ? clockWords(timeline.wallSeconds) : "…"}</span>
              {live || readLive ? " so far" : ""}
            </span>
          </p>
        </div>
        <div className="os-replay__acts">
          <div className="os-replay__btns">
            {action.kind === "open" ? (
              <button type="button" className="os-btn os-btn--primary" onClick={onOpenLive}>
                <SquareTerminal size={17} aria-hidden="true" />
                Open live session
              </button>
            ) : null}
            {action.kind === "resume" ? (
              <button
                type="button"
                className="os-btn os-btn--primary"
                disabled={!action.available || !session}
                aria-describedby={action.available ? undefined : resumeWhyId}
                onClick={onResume}
              >
                <History size={17} aria-hidden="true" />
                Resume conversation
              </button>
            ) : null}
            <button type="button" className="os-btn os-btn--ghost" disabled={live} aria-describedby={live ? deleteWhyId : undefined} onClick={onDelete}>
              <Trash2 size={16} aria-hidden="true" />
              Delete recording
            </button>
          </div>
          {action.kind === "resume" && !action.available ? (
            <p id={resumeWhyId} className="os-replay__why">
              {action.reason}
            </p>
          ) : null}
          {live ? (
            <p id={deleteWhyId} className="os-replay__why">
              {DELETE_WHILE_LIVE}
            </p>
          ) : null}
        </div>
      </header>

      {loaded.state === "loading" ? (
        <p className="os-replay__status">
          <StatusWord state="loading" />
        </p>
      ) : null}
      {loaded.state === "error" ? (
        <div className="os-replay__status">
          <Banner
            tone="danger"
            actions={
              <button type="button" className="os-btn os-btn--secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            }
          >
            {loaded.message}
          </Banner>
        </div>
      ) : null}

      {loaded.state === "ok" && timeline ? (
        <div className="os-replay__body">
          <div className="os-replay__main">
            <div className="os-replay__screen" ref={boxRef} role="region" aria-label="Replayed terminal screen" tabIndex={0}>
              <div className="os-replay__term" ref={hostRef} />
              {pos < timeline.removedSeconds ? <p className="os-replay__gone-note">{REMOVED_WORDS}</p> : null}
            </div>
            <p className="os-replay__cap">
              <SquareTerminal size={15} aria-hidden="true" />
              {REPLAY_CAPTION}
            </p>

            <div className="os-replay__ctl">
              <div className="os-replay__ctl-top">
                <button type="button" className="os-btn os-btn--secondary os-replay__play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>
                  {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
                </button>
                <p className="os-replay__clock">
                  <span className="os-replay__now os-mono">{clockWords(pos)}</span>
                  <span className="os-replay__of">
                    of <span className="os-mono">{clockWords(timeline.wallSeconds)}</span> true length
                  </span>
                </p>
                <div className="os-replay__speed">
                  <span id={speedId}>Speed</span>
                  <div className="os-replay__seg" role="group" aria-labelledby={speedId}>
                    {REPLAY_SPEEDS.map((choice) => (
                      <button key={choice} type="button" aria-pressed={speed === choice} onClick={() => setSpeed(choice)}>
                        {speedLabel(choice)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className={`os-replay__scrub${playing ? " is-playing" : ""}`}>
                <Pins moments={timeline.moments} wallSeconds={timeline.wallSeconds} current={current} onPick={pick} />
                <div className="os-replay__track">
                  <TrackMarks timeline={timeline} />
                  <span className="os-replay__fill" style={{ width: `${timelinePercent(pos, timeline.wallSeconds)}%` }} />
                </div>
                <input
                  className="os-replay__range"
                  type="range"
                  min={0}
                  max={rangeMax}
                  step={1}
                  value={Math.min(Math.floor(pos), rangeMax)}
                  aria-label="Replay position"
                  aria-valuetext={`${clockWords(pos)} of ${clockWords(timeline.wallSeconds)}`}
                  onChange={(event) => moveTo(Number(event.currentTarget.value))}
                />
              </div>
              <div className="os-replay__ends" aria-hidden="true">
                <span>0 s</span>
                <span>{clockWords(timeline.wallSeconds)}</span>
              </div>
              <div className="os-replay__legend" role="group" aria-label="Timeline key">
                <span>
                  <Send size={14} aria-hidden="true" />
                  {MOMENT_WORDS.prompt}
                </span>
                <span className="is-attn">
                  <CircleHelp size={14} aria-hidden="true" />
                  {MOMENT_WORDS.permission}
                </span>
                <span>
                  <FileText size={14} aria-hidden="true" />
                  {MOMENT_WORDS.files}
                </span>
                {hasIdle ? (
                  <span>
                    <i className="os-replay__hatch" aria-hidden="true" />
                    {IDLE_WORDS}
                  </span>
                ) : null}
                {timeline.removedSeconds > 0 ? (
                  <span>
                    <i className="os-replay__gone" aria-hidden="true" />
                    {REMOVED_WORDS}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <aside className="os-replay__side" aria-label={MOMENTS_TITLE}>
            <h3 className="os-replay__side-title">{MOMENTS_TITLE}</h3>
            {timeline.moments.length > 0 ? (
              <MomentList moments={timeline.moments} current={current} onPick={pick} />
            ) : (
              <p className="os-replay__empty">{loaded.momentsRead ? NO_MOMENTS : MOMENTS_UNREADABLE}</p>
            )}
            {notes.map((note) => (
              <p key={note} className="os-replay__note">
                <Info size={16} aria-hidden="true" />
                <span>{note}</span>
              </p>
            ))}
          </aside>
        </div>
      ) : null}
    </section>
  );
}
