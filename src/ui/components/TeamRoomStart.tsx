// Team Room, no room selected: what a room is, the start form, and the list
// of past rooms. Starting always goes through a confirm modal because it
// launches two real agents that may spend money on their own accounts.
import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getExecutionGateStatus, listTeamRooms, startTeamRoom } from "../../api";
import type { ExecutionGateStatus, TeamRoomSummary } from "../../types";
import { roomStatusMark, roomStatusWord, usd } from "../teamRoomShared";
import AgentConfirmModal from "./AgentConfirmModal";
import { TimeAgo } from "./RelativeTime";
import StatusMark from "./StatusMark";
import TeamRoomProblem, { problemFromError, type TeamProblem } from "./TeamRoomProblem";
import { useInterval } from "./useInterval";

const MAX_TASK = 4000;

function clampInt(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function excerpt(text: string, max = 110) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function TeamRoomStart({ onOpenRoom }: { onOpenRoom: (id: string) => void }) {
  const [rooms, setRooms] = useState<TeamRoomSummary[] | null>(null);
  const [roomsFailed, setRoomsFailed] = useState(false);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [gateFailed, setGateFailed] = useState(false);
  const [task, setTask] = useState("");
  const [turns, setTurns] = useState("6");
  const [minutes, setMinutes] = useState("10");
  const [cost, setCost] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<TeamProblem | null>(null);

  async function loadRooms() {
    try {
      const { rooms: list } = await listTeamRooms();
      setRooms(list);
      setRoomsFailed(false);
    } catch {
      setRoomsFailed(true);
    }
  }
  async function loadGate() {
    try {
      setGate(await getExecutionGateStatus());
      setGateFailed(false);
    } catch {
      setGateFailed(true);
    }
  }
  useEffect(() => {
    void loadRooms();
    void loadGate();
  }, []);
  useInterval(() => void loadRooms(), 5000);
  useInterval(() => void loadGate(), 15000);

  const taskTrimmed = task.trim();
  const turnsValue = clampInt(turns, 2, 12);
  const minutesValue = clampInt(minutes, 1, 30);
  const costBlank = cost.trim() === "";
  const costValue = costBlank ? null : Number(cost);
  const costValid = costBlank || (Number.isFinite(costValue) && (costValue as number) > 0 && (costValue as number) <= 1000);
  const taskValid = taskTrimmed.length >= 1 && task.length <= MAX_TASK;
  const formValid = taskValid && turnsValue !== null && minutesValue !== null && costValid;
  const gateOff = gate !== null && (!gate.enabled || gate.level === 0);

  async function confirmStart() {
    if (!formValid || turnsValue === null || minutesValue === null) return;
    setStarting(true);
    setProblem(null);
    try {
      const room = await startTeamRoom({
        task: taskTrimmed,
        limits: { maxTurns: turnsValue, maxMinutes: minutesValue, maxCostUsd: costBlank ? null : (costValue as number) }
      });
      setConfirmOpen(false);
      onOpenRoom(room.id);
    } catch (error) {
      setConfirmOpen(false);
      const next = problemFromError(error);
      setProblem(next);
      if (next.code === "execution_gate_off") void loadGate();
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="os-team__start">
      <section className="os-panel os-team__explainer" aria-labelledby="os-team-how">
        <h2 id="os-team-how" className="os-team__h2">
          How a Team Room works
        </h2>
        <p>
          Hermes and OpenClaw discuss your task in turns. They can write notes, propose decisions and agree with each
          other. Agent OS only does one thing by itself: when both agree on a .md, .txt or .html file, it saves that file
          in the sandbox folder, and you can Undo it. Everything else waits for you.
        </p>
      </section>

      {gateOff ? (
        <TeamRoomProblem problem={{ code: "execution_gate_off", message: "" }} onOpenRoom={onOpenRoom} />
      ) : null}
      {gateFailed && gate === null ? (
        <p className="os-team__hint">Couldn&apos;t check the Safety setting just now. Starting a room will tell you if it is blocking.</p>
      ) : null}
      {problem ? <TeamRoomProblem problem={problem} onOpenRoom={onOpenRoom} /> : null}

      <form
        className="os-panel os-team__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (formValid && !gateOff) setConfirmOpen(true);
        }}
      >
        <h2 className="os-team__h2">Start a room</h2>
        <label className="os-field">
          <span className="os-field__label">Task for the two agents</span>
          <textarea
            rows={5}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="For example: Plan a README for this project and write it down as a .md file."
            aria-describedby="os-team-task-count"
          />
          <span
            id="os-team-task-count"
            className={`os-team__count os-mono${task.length > MAX_TASK ? " os-team__count--over" : ""}`}
          >
            {task.length.toLocaleString()} / {MAX_TASK.toLocaleString()}
          </span>
        </label>
        <div className="os-team__limits">
          <label className="os-field">
            <span className="os-field__label">Turns (2–12)</span>
            <input
              inputMode="numeric"
              value={turns}
              onChange={(event) => setTurns(event.target.value)}
              aria-invalid={turnsValue === null}
            />
          </label>
          <label className="os-field">
            <span className="os-field__label">Minutes (1–30)</span>
            <input
              inputMode="numeric"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              aria-invalid={minutesValue === null}
            />
          </label>
          <label className="os-field">
            <span className="os-field__label">Cost cap in USD (optional)</span>
            <input
              inputMode="decimal"
              value={cost}
              placeholder="No cap"
              onChange={(event) => setCost(event.target.value)}
              aria-invalid={!costValid}
            />
          </label>
        </div>
        <div className="os-team__actions">
          <button type="submit" className="os-btn os-btn--primary" disabled={!formValid || gateOff}>
            Start room
          </button>
          {!formValid && taskTrimmed.length > 0 ? (
            <span className="os-team__hint">Check the limits above: turns 2–12, minutes 1–30, cost above 0.</span>
          ) : null}
        </div>
      </form>

      <section className="os-panel os-team__list" aria-labelledby="os-team-past">
        <h2 id="os-team-past" className="os-team__h2">
          Past rooms
        </h2>
        {rooms === null && roomsFailed ? (
          <div className="os-team__problem" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <p>Couldn&apos;t load your rooms. Agent OS isn&apos;t responding.</p>
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void loadRooms()}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        ) : rooms === null ? (
          <p className="os-team__hint" aria-live="polite">
            …
          </p>
        ) : rooms.length === 0 ? (
          <p className="os-team__hint">No rooms yet. Write a task above and start your first one.</p>
        ) : (
          <ul className="os-team__rooms">
            {rooms.map((room) => (
              <li key={room.id}>
                <button type="button" className="os-team__room-row" onClick={() => onOpenRoom(room.id)}>
                  <span className="os-team__room-status">
                    <StatusMark kind={roomStatusMark(room.status)} label={roomStatusWord(room.status)} />
                    {roomStatusWord(room.status)}
                  </span>
                  <span className="os-team__room-task">{excerpt(room.task)}</span>
                  <span className="os-mono os-team__room-turns" title="turns used / turns allowed">
                    {room.turnsDone}/{room.turnsAllowed} turns
                  </span>
                  <span className="os-mono os-team__room-cost" title={typeof room.costUsd === "number" ? undefined : "no turn reported a cost"}>
                    {usd(room.costUsd)}
                  </span>
                  <span className="os-team__room-age">
                    <TimeAgo since={room.createdAt} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmOpen ? (
        <AgentConfirmModal
          title="Start this Team Room?"
          confirmLabel="Start room"
          busy={starting}
          onConfirm={() => void confirmStart()}
          onClose={() => (starting ? null : setConfirmOpen(false))}
        >
          <p>
            This starts real Hermes Agent and OpenClaw runs on this computer, for up to{" "}
            <strong className="os-mono">{turnsValue}</strong> turns or <strong className="os-mono">{minutesValue}</strong>{" "}
            minutes.
          </p>
          <p>
            Each turn may cost money on those agents&apos; own model accounts.{" "}
            {costBlank ? "You have not set a cost cap." : `The room stops if known cost reaches $${costValue}.`}
          </p>
          <p>You can stop the room at any time.</p>
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
