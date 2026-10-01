// Team Room, one room selected: header with real limits, the two-column
// conversation, and the notebook / proposals / files-saved panels. The room
// is read from getTeamRoom and kept fresh by the live event stream: every new
// stream event triggers a (debounced) refetch, and a running room is also
// polled so a dropped stream can never leave the screen stale.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { TeamRoomError, continueTeamRoom, getTeamRoom, stopTeamRoom, useTeamRoomStream } from "../../api";
import type { TeamRoomDetail } from "../../types";
import {
  clockEnd,
  deriveTurns,
  mergeEvents,
  minutesLabel,
  roomEndSentence,
  roomStatusMark,
  roomStatusWord,
  usd
} from "../teamRoomShared";
import AgentConfirmModal from "./AgentConfirmModal";
import SegmentMeter from "./SegmentMeter";
import StatusMark from "./StatusMark";
import { ActionsPanel, NotebookPanel, ProposalsPanel } from "./TeamRoomPanels";
import TeamRoomProblem, { problemFromError, type TeamProblem } from "./TeamRoomProblem";
import TeamRoomTurn, { ClampText } from "./TeamRoomTurn";
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

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
      setLoadError({ notFound, message: error instanceof Error ? error.message : "Couldn't load this room." });
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

  const running = detail?.room.status === "running";
  useInterval(() => void refresh(), running ? 3000 : null);
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const events = useMemo(() => mergeEvents(detail?.events || [], liveEvents), [detail, liveEvents]);
  const turns = useMemo(() => deriveTurns(events), [events]);

  if (loadError && !detail) {
    return (
      <div className="os-team__problem" role="alert">
        <AlertTriangle size={16} aria-hidden="true" />
        <p>{loadError.notFound ? "That room doesn't exist (it may have been removed)." : `Couldn't load this room. ${loadError.message}`}</p>
        {loadError.notFound ? null : (
          <button type="button" className="os-btn os-btn--secondary" onClick={() => void refresh()}>
            <RefreshCw size={14} /> Retry
          </button>
        )}
        <button type="button" className="os-btn os-btn--ghost" onClick={onBack}>
          All rooms
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="os-team__view">
        <button type="button" className="os-btn os-btn--ghost os-team__back" onClick={onBack}>
          <ArrowLeft size={14} /> All rooms
        </button>
        <div className="os-panel" aria-live="polite">
          …
        </div>
      </div>
    );
  }

  const { room, proposals, actions, notebook } = detail;
  const isRunning = room.status === "running";
  const endSentence = roomEndSentence(room);
  const elapsedMs = Math.max(0, clockEnd(room, nowMs) - new Date(room.clockStartedAt).getTime());
  const maxMs = room.limits.maxMinutes * 60_000;
  const elapsedKnown = Number.isFinite(elapsedMs);
  const turnSegments = Array.from({ length: Math.max(room.turnsAllowed, 1) }, (_, i) =>
    i < room.turnsDone ? ("ok" as const) : ("unknown" as const)
  );
  const waitingForYou = proposals.filter((p) => p.status === "needs_approval").length;
  const currentRunId = room.currentTurn?.runId || null;
  const costCap = room.limits.maxCostUsd;

  async function doStop() {
    setBusy(true);
    setProblem(null);
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
    try {
      await continueTeamRoom(room.id, CONTINUE_TURNS);
      setContinueOpen(false);
      // The old stream ended with needs_you; open a fresh one.
      setReconnectKey((k) => k + 1);
      void refresh();
    } catch (error) {
      setContinueOpen(false);
      setProblem(problemFromError(error));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="os-team__view">
      <button type="button" className="os-btn os-btn--ghost os-team__back" onClick={onBack}>
        <ArrowLeft size={14} /> All rooms
      </button>

      <header className="os-panel os-team__head">
        <div className="os-team__head-top">
          <span className={`os-team__status os-team__status--${room.status}`}>
            <StatusMark kind={roomStatusMark(room.status)} label={roomStatusWord(room.status)} />
            {roomStatusWord(room.status)}
          </span>
          <div className="os-team__head-actions">
            {isRunning ? (
              <button type="button" className="os-btn os-btn--danger" onClick={() => setStopOpen(true)}>
                Stop
              </button>
            ) : null}
            {room.status === "needs_you" ? (
              <button type="button" className="os-btn os-btn--primary" onClick={() => setContinueOpen(true)}>
                Continue (+{CONTINUE_TURNS} turns)
              </button>
            ) : null}
          </div>
        </div>

        <ClampText text={room.task} className="os-team__task" />

        {endSentence ? <p className="os-team__end">{endSentence}</p> : null}
        {waitingForYou > 0 ? (
          <p className="os-team__end">
            {waitingForYou} proposal{waitingForYou === 1 ? " is" : "s are"} waiting for your approval.{" "}
            <button
              type="button"
              className="os-team__link"
              onClick={() =>
                document.getElementById("os-team-proposals-panel")?.scrollIntoView({ behavior: "auto", block: "start" })
              }
            >
              Jump to proposals
            </button>
          </p>
        ) : null}
        {problem ? <TeamRoomProblem problem={problem} /> : null}

        <dl className="os-team__limits-bar">
          <div className="os-team__limit">
            <dt className="os-micro">Turns</dt>
            <dd>
              <SegmentMeter
                segments={turnSegments}
                label={`${room.turnsDone} of ${room.turnsAllowed} turns used`}
              />
              <span className="os-mono">
                {room.turnsDone}/{room.turnsAllowed}
              </span>
            </dd>
          </div>
          <div className="os-team__limit">
            <dt className="os-micro">Time</dt>
            <dd>
              <span className="os-mono">
                {elapsedKnown ? minutesLabel(elapsedMs) : "—"} of {room.limits.maxMinutes}m
              </span>
              <span
                className="os-team__timebar"
                role="img"
                aria-label={`${minutesLabel(elapsedMs)} of ${room.limits.maxMinutes} minutes used`}
              >
                <span style={{ width: `${Math.min(100, (elapsedMs / maxMs) * 100)}%` }} />
              </span>
            </dd>
          </div>
          <div className="os-team__limit">
            <dt className="os-micro">Cost</dt>
            <dd>
              <span
                className="os-mono"
                title={room.costUsd === null ? "no turn has reported a cost yet" : undefined}
              >
                {usd(room.costUsd)}
              </span>
              {typeof costCap === "number" ? <span className="os-team__muted">cap ${costCap}</span> : null}
              {room.costUnknownTurns > 0 ? (
                <span className="os-team__muted">
                  {room.costUnknownTurns} turn{room.costUnknownTurns === 1 ? "" : "s"} didn&apos;t report cost
                </span>
              ) : null}
            </dd>
          </div>
        </dl>
      </header>

      <div className="os-team__grid">
        <section className="os-team__convo" aria-label="Conversation">
          <div className="os-team__colheads" aria-hidden="true">
            <span className="os-micro">Hermes Agent</span>
            <span className="os-micro">OpenClaw</span>
          </div>
          {turns.length === 0 ? (
            <p className="os-panel os-team__muted" aria-live="polite">
              {isRunning ? "Waiting for the first turn…" : "No turns were recorded for this room."}
            </p>
          ) : (
            <div className="os-team__turns">
              {(["hermes", "openclaw"] as const).map((agentId) => (
                <div key={agentId} className="os-team__col">
                  {turns
                    .filter((turn) => turn.agentId === agentId)
                    .map((turn) => (
                      <TeamRoomTurn
                        key={turn.turn}
                        turn={turn}
                        live={isRunning && !turn.ended && currentRunId === turn.runId}
                      />
                    ))}
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="os-team__panels">
          <ProposalsPanel roomId={room.id} proposals={proposals} onChanged={() => void refresh()} />
          <ActionsPanel roomId={room.id} actions={actions} onChanged={() => void refresh()} />
          <NotebookPanel notebook={notebook} />
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
          <p>This stops the agent that is working right now. What was already said stays in the room.</p>
        </AgentConfirmModal>
      ) : null}
      {continueOpen ? (
        <AgentConfirmModal
          title={`Continue for ${CONTINUE_TURNS} more turns?`}
          confirmLabel="Continue"
          busy={busy}
          onConfirm={() => void doContinue()}
          onClose={() => (busy ? null : setContinueOpen(false))}
        >
          <p>This starts the real agents again for up to {CONTINUE_TURNS} more turns. Each turn may cost money on their own model accounts.</p>
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
