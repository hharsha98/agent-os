// Team Room, one room selected: the page header (Stop or Continue), the task and
// the status, then the conversation on the left and, on the right, the decision
// cards, the limits and the notebook. The room is read from getTeamRoom and kept
// fresh by the live event stream: every new stream event triggers a (debounced)
// refetch, and a room that is running, paused or out of reach is also polled so
// a dropped stream can never leave the screen stale.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { TeamRoomError, continueTeamRoom, getTeamRoom, stopTeamRoom, useTeamRoomStream } from "../../api";
import type { TeamRoomDetail } from "../../types";
import {
  continueTurns,
  decisionKey,
  deriveTimeline,
  deriveTurns,
  mergeEvents,
  pauseState,
  plural,
  roomEndSentence,
  roomLede,
  roomSoFar,
  roomStatusView
} from "../teamRoomShared";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";
import PageHeader from "./PageHeader";
import StatusWord from "./StatusWord";
import { TeamRoomDecided, TeamRoomNeedsYou, type DecisionMemory } from "./TeamRoomDecision";
import TeamRoomLimits from "./TeamRoomLimits";
import TeamRoomProblem, { problemFromError, type ProblemWhere, type TeamProblem } from "./TeamRoomProblem";
import TeamRoomTimeline from "./TeamRoomTimeline";
import { ClampText } from "./TeamRoomTurn";
import { useInterval } from "./useInterval";

const CONTINUE_TURNS = 4;

export default function TeamRoomView({ roomId, onBack }: { roomId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<TeamRoomDetail | null>(null);
  const [loadError, setLoadError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [stopOpen, setStopOpen] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<TeamProblem | null>(null);
  // Which request the notice is about, so "a room is already running" can be worded for it.
  const [problemWhere, setProblemWhere] = useState<ProblemWhere>("start");
  const [, forceTick] = useState(0);
  // What the page knows about each card, keyed by room plus proposal. It lives here
  // because a decided card moves to another list and remounts (see DecisionMemory).
  const [cardMemory, setCardMemory] = useState<Record<string, DecisionMemory>>({});
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  const remember = useCallback(
    (proposalId: string, patch: Partial<DecisionMemory>) => {
      const key = decisionKey(roomId, proposalId);
      setCardMemory((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    },
    [roomId]
  );

  const { events: liveEvents, status: streamStatus } = useTeamRoomStream(roomId, reconnectKey);

  const refresh = useCallback(async () => {
    const asked = roomId;
    try {
      const next = await getTeamRoom(asked);
      if (asked !== roomIdRef.current) return;
      setDetail(next);
      setLoadError(null);
    } catch (error) {
      if (asked !== roomIdRef.current) return;
      const notFound = error instanceof TeamRoomError && error.status === 404;
      setLoadError({ notFound, message: error instanceof TeamRoomError ? error.message : "Agent OS isn't responding." });
    }
  }, [roomId]);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setProblem(null);
    void refresh();
  }, [roomId, refresh]);

  // New stream events mean something changed (a turn, a proposal, an action):
  // refetch once the burst settles instead of once per event.
  const eventCount = liveEvents.length;
  useEffect(() => {
    if (eventCount === 0) return undefined;
    const id = setTimeout(() => void refresh(), 250);
    return () => clearTimeout(id);
  }, [eventCount, refresh]);
  useEffect(() => {
    if (streamStatus === "ended") void refresh();
  }, [streamStatus, refresh]);

  // "waiting" = a card still needs you. "carrying_on" = you decided it and the server
  // is still checking the agents before the room runs again (see pauseState).
  const pause = detail ? pauseState(detail.room, detail.proposals) : "none";
  const paused = pause !== "none";
  const running = detail?.room.status === "running";
  // A paused room is polled too: the decision may be made in another window.
  useInterval(() => void refresh(), running || paused || loadError !== null ? 3000 : null);
  // The clock reads Date.now() while the room runs, so a re-render every second
  // keeps it moving. A paused room does not tick: its clock is stopped.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // A room that runs again (Continue here, or a decision made in another window)
  // needs a fresh event stream: the old one ended when the room paused.
  const status = detail?.room.status ?? null;
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (status === "running" && lastStatus.current !== null && lastStatus.current !== "running") setReconnectKey((k) => k + 1);
    lastStatus.current = status;
  }, [status]);

  const events = useMemo(() => mergeEvents(detail?.events || [], liveEvents), [detail, liveEvents]);
  const timeline = useMemo(() => deriveTimeline(events, detail?.proposals || [], detail?.actions || []), [events, detail]);

  const backButton = (
    <button type="button" className="os-btn os-btn--ghost os-team__back" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden="true" /> All rooms
    </button>
  );

  if (loadError && !detail) {
    return (
      <div className="os-team__view">
        {backButton}
        <PageHeader title="Team Room" titleId="os-team-title" />
        <Banner
          tone={loadError.notFound ? "warn" : "danger"}
          actions={
            loadError.notFound ? undefined : (
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void refresh()}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            )
          }
        >
          {loadError.notFound ? "That room doesn't exist (it may have been removed)." : `Couldn't load this room. ${loadError.message}`}
        </Banner>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="os-team__view">
        {backButton}
        <PageHeader title="Team Room" titleId="os-team-title" />
        <p className="os-team__hint" aria-live="polite">
          Loading this room…
        </p>
      </div>
    );
  }

  const { room, proposals, actions, notebook } = detail;
  const statusView = roomStatusView(room, proposals);
  const isRunning = room.status === "running";
  const endSentence = roomEndSentence(room);
  const so = roomSoFar(deriveTurns(events), proposals, actions);
  const waiting = so.waitingFiles + so.waitingOther;
  const waitingText =
    so.waitingOther === 0
      ? `${plural(so.waitingFiles, "file")} ${so.waitingFiles === 1 ? "waits" : "wait"} for your decision.`
      : `${plural(waiting, "proposal")} ${waiting === 1 ? "waits" : "wait"} for your decision.`;
  // Plain-English notices from the server (a model that can't follow the reply
  // format). Server text, shown as text. The cost warning lives in the Limits panel.
  const notices = room.hints || [];

  async function doStop() {
    setBusy(true);
    setProblem(null);
    setProblemWhere("start");
    try {
      await stopTeamRoom(room.id);
      setStopOpen(false);
      void refresh();
    } catch (error) {
      setStopOpen(false);
      setProblem(problemFromError(error));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function doContinue() {
    setBusy(true);
    setProblem(null);
    setProblemWhere("continue");
    try {
      await continueTeamRoom(room.id, CONTINUE_TURNS);
      setContinueOpen(false);
      void refresh();
    } catch (error) {
      setContinueOpen(false);
      setProblem(problemFromError(error));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  // Scroll to the first card that waits for you and put the keyboard focus on it,
  // so the next Tab lands on Approve and not back at the top of the page. The scroll
  // is instant (no animation), so reduced motion needs no special case.
  function jumpToDecision() {
    const area = document.getElementById("os-team-decisions");
    if (!area) return;
    area.scrollIntoView({ behavior: "auto", block: "start" });
    area.querySelector<HTMLElement>(".os-team__decision")?.focus({ preventScroll: true });
  }

  const headerActions = isRunning ? (
    <button type="button" className="os-btn os-btn--danger" onClick={() => setStopOpen(true)}>
      <Square size={14} aria-hidden="true" /> Stop room
    </button>
  ) : room.status === "needs_you" && pause !== "carrying_on" ? (
    <button type="button" className={`os-btn ${pause === "waiting" ? "os-btn--secondary" : "os-btn--primary"}`} onClick={() => setContinueOpen(true)}>
      {pause === "waiting" ? `Continue without deciding (+${CONTINUE_TURNS} turns)` : `Continue (+${CONTINUE_TURNS} turns)`}
    </button>
  ) : undefined;

  return (
    <div className="os-team__view">
      {backButton}
      <PageHeader title="Team Room" titleId="os-team-title" lede={roomLede(room, proposals)} actions={headerActions} />

      <div className="os-team__bar">
        <div className="os-team__task">
          <span className="os-micro">Task</span>
          <ClampText text={room.task} className="os-team__task-text" />
        </div>
        <div className="os-team__bar-status" role="status">
          <StatusWord state={statusView.state} label={statusView.label} />
        </div>
      </div>

      {endSentence ? <p className="os-team__end">{endSentence}</p> : null}
      {waiting > 0 ? (
        <button type="button" className="os-team__link os-team__jump" onClick={jumpToDecision}>
          Jump to the decision
        </button>
      ) : null}
      {problem ? <TeamRoomProblem problem={problem} where={problemWhere} /> : null}
      {loadError ? <Banner tone="warn">Lost contact with Agent OS. This page shows the last thing it saw and keeps trying.</Banner> : null}
      {notices.map((notice) => (
        <Banner key={notice} tone="info">
          {notice}
        </Banner>
      ))}

      <div className="os-team__room">
        <div className="os-team__main">
          <TeamRoomTimeline items={timeline} running={isRunning} currentRunId={room.currentTurn?.runId || null} turnsAllowed={room.turnsAllowed} />
          <p className="os-team__sofar">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>
              <b>What Agent OS did so far.</b> Passed <b>{so.messages}</b> {so.messages === 1 ? "message" : "messages"} between the agents and
              saved <b>{plural(so.saved, "file")}</b>
              {so.saved > 0 ? (
                <>
                  : <code className="os-mono">{so.savedPaths.join(", ")}</code>
                </>
              ) : null}
              .{waiting > 0 ? <span className="os-team__wait"> {waitingText}</span> : null}
            </span>
          </p>
        </div>

        <aside className="os-team__side" aria-label="Decisions and limits">
          <TeamRoomNeedsYou
            room={room}
            proposals={proposals}
            actions={actions}
            onDecided={refresh}
            onChanged={refresh}
            memory={cardMemory}
            remember={remember}
          />
          <TeamRoomLimits room={room} proposals={proposals} nowMs={Date.now()} />
          <TeamRoomDecided
            room={room}
            proposals={proposals}
            actions={actions}
            onDecided={refresh}
            onChanged={refresh}
            memory={cardMemory}
            remember={remember}
          />
          {notebook.trim() ? (
            <section className="os-team__notebook" aria-labelledby="os-team-notebook-h">
              <h2 id="os-team-notebook-h" className="os-team__h">
                Notebook
              </h2>
              {/* notebook.md is markdown the server writes ("**Hermes Agent** (turn 1, ...)"). It is shown as plain text on purpose (agents wrote it), so the bold markers are dropped. */}
              <ClampText text={notebook.replace(/\*\*(.+?)\*\*/g, "$1")} className="os-team__notebook-text" />
            </section>
          ) : null}
        </aside>
      </div>

      {stopOpen ? (
        <AgentConfirmModal
          title="Stop this room?"
          confirmLabel="Stop room"
          danger
          busy={busy}
          onConfirm={() => void doStop()}
          onClose={() => (busy ? null : setStopOpen(false))}
        >
          <p>This stops the agent that is working right now. What was already said stays in the room. A file you already saved stays saved, and you can still undo it.</p>
        </AgentConfirmModal>
      ) : null}
      {continueOpen ? (
        <AgentConfirmModal
          title={continueTurns(room, CONTINUE_TURNS).title}
          confirmLabel="Continue"
          busy={busy}
          onConfirm={() => void doContinue()}
          onClose={() => (busy ? null : setContinueOpen(false))}
        >
          <p>{continueTurns(room, CONTINUE_TURNS).sentence}</p>
          {pause === "waiting" ? <p>The file waiting for you stays waiting, and you can still decide on it later.</p> : null}
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
