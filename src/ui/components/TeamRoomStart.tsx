// Team Room, no room selected: the task and limits form, who is in the room and
// what Agent OS does by itself, and the table of past rooms. Starting always
// goes through a confirm modal because it launches two real agents that may
// spend money on their own accounts.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bot, CheckCircle2, MessagesSquare, Play, RefreshCw, XCircle } from "lucide-react";
import { getExecutionGateStatus, listAgents, listTeamRooms, startTeamRoom } from "../../api";
import { navigateTo } from "../../nav";
import type { AgentSummary, ExecutionGateStatus, TeamRoomSummary } from "../../types";
import { withTimeout } from "../homeShared";
import { COST_CAP_NOTE, OPENCLAW_MODEL_PATTERN, agentLabel, agentMaker, roomStatusView, usd } from "../teamRoomShared";
import AgentConfirmModal from "./AgentConfirmModal";
import Banner from "./Banner";
import EmptyState from "./EmptyState";
import PageHeader from "./PageHeader";
import { TimeAgo } from "./RelativeTime";
import StatusWord from "./StatusWord";
import TeamRoomProblem, { problemFromError, type TeamProblem } from "./TeamRoomProblem";
import { useInterval } from "./useInterval";

const MAX_TASK = 4000;
// The agent check can be slow on a busy machine. Past this the read counts as
// failed (the same 15 s Home uses), so a hung read never piles polls on top of itself.
const AGENTS_TIMEOUT_MS = 15000;

const EXAMPLES = [
  { label: "Launch checklist", task: "Draft a one-page launch checklist for the blog-site and agree on one version." },
  { label: "Organise notes", task: "Compare two ways to organise my research notes and agree on one." },
  { label: "Short README", task: "Write a short README for the my-app project that a new person can follow." }
];

// Status, task, turns, cost, started.
const ROOM_COLUMNS = "minmax(150px, 200px) minmax(0, 1fr) 84px 84px 96px";

function clampInt(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function excerpt(text: string, max = 110) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function WhoRow({ id, agents, failed }: { id: "hermes" | "openclaw"; agents: AgentSummary[] | null; failed: boolean }) {
  const found = agents?.find((agent) => agent.id === id);
  let state: ReactNode;
  if (agents === null) state = failed ? "—" : "…";
  else if (!found) state = "—";
  else if (found.detected.installed) {
    state = (
      <>
        Installed{found.detected.version ? <> · <code className="os-mono">{found.detected.version}</code></> : null}
      </>
    );
  } else {
    state = (
      <>
        Not installed{" "}
        <button type="button" className="os-team__link" onClick={() => navigateTo("setup")}>
          Open Setup
        </button>
      </>
    );
  }
  return (
    <li>
      <Bot size={18} aria-hidden="true" />
      <div>
        <b>{agentLabel(id)}</b>
        <span className="os-team__sub">{agentMaker(id)}</span>
        <span className="os-team__sub">{state}</span>
      </div>
    </li>
  );
}

export default function TeamRoomStart({ onOpenRoom }: { onOpenRoom: (id: string) => void }) {
  const [rooms, setRooms] = useState<TeamRoomSummary[] | null>(null);
  const [roomsFailed, setRoomsFailed] = useState(false);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [gateFailed, setGateFailed] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [task, setTask] = useState("");
  const [turns, setTurns] = useState("6");
  const [minutes, setMinutes] = useState("10");
  const [cost, setCost] = useState("");
  const [openclawModel, setOpenclawModel] = useState("");
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
  // One agent read at a time: a poll that comes while the last one is still out is skipped.
  const agentsInFlight = useRef(false);
  async function loadAgents() {
    if (agentsInFlight.current) return;
    agentsInFlight.current = true;
    try {
      setAgents((await withTimeout(listAgents(), AGENTS_TIMEOUT_MS)).agents);
      setAgentsFailed(false);
    } catch {
      setAgentsFailed(true);
    } finally {
      agentsInFlight.current = false;
    }
  }
  useEffect(() => {
    void loadRooms();
    void loadGate();
    void loadAgents();
  }, []);
  useInterval(() => void loadRooms(), 5000);
  useInterval(() => void loadGate(), 15000);
  useInterval(() => void loadAgents(), 15000);

  const taskTrimmed = task.trim();
  const turnsValue = clampInt(turns, 2, 12);
  const minutesValue = clampInt(minutes, 1, 30);
  const costBlank = cost.trim() === "";
  const costValue = costBlank ? null : Number(cost);
  const costValid = costBlank || (Number.isFinite(costValue) && (costValue as number) > 0 && (costValue as number) <= 1000);
  const taskValid = taskTrimmed.length >= 1 && task.length <= MAX_TASK;
  const modelTrimmed = openclawModel.trim();
  const modelValid = modelTrimmed === "" || OPENCLAW_MODEL_PATTERN.test(modelTrimmed);
  const capSet = !costBlank && costValid;
  const formValid = taskValid && turnsValue !== null && minutesValue !== null && costValid && modelValid;
  const gateOff = gate !== null && (!gate.enabled || gate.level === 0);

  async function confirmStart() {
    if (!formValid || turnsValue === null || minutesValue === null) return;
    setStarting(true);
    setProblem(null);
    try {
      const room = await startTeamRoom({
        task: taskTrimmed,
        limits: { maxTurns: turnsValue, maxMinutes: minutesValue, maxCostUsd: costBlank ? null : (costValue as number) },
        ...(modelTrimmed ? { openclawModel: modelTrimmed } : {})
      });
      setConfirmOpen(false);
      onOpenRoom(room.id);
    } catch (error) {
      setConfirmOpen(false);
      const next = problemFromError(error, "rooms");
      setProblem(next);
      if (next.code === "execution_gate_off") void loadGate();
      // No answer at all: the room may have been started, so look at the list again.
      if (next.code === "unreachable") void loadRooms();
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="os-team__startpage">
      <PageHeader
        title="Team Room"
        titleId="os-team-title"
        lede="Hermes Agent and OpenClaw talk a task through, one message at a time. You set the limits, read along, and decide what gets saved."
      />

      {gateOff ? <TeamRoomProblem problem={{ code: "execution_gate_off", message: "" }} onOpenRoom={onOpenRoom} /> : null}
      {gateFailed && gate === null ? (
        <Banner tone="info">Couldn&apos;t check the Safety setting just now. Starting a room will tell you if it is blocking.</Banner>
      ) : null}
      {gateFailed && gate !== null ? (
        <Banner tone="warn">Couldn&apos;t re-check the safety setting just now. This is the last answer.</Banner>
      ) : null}
      {problem ? <TeamRoomProblem problem={problem} onOpenRoom={onOpenRoom} /> : null}

      <div className="os-team__start">
        <form
          className="os-team__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (formValid && !gateOff) setConfirmOpen(true);
          }}
        >
          <h2 className="os-team__h">The task</h2>
          <label className="os-field">
            <span className="os-field__label">What should the two of them work out together?</span>
            <textarea
              rows={4}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="For example: Compare two ways to organise my research notes and agree on one."
              aria-describedby="os-team-task-count"
            />
            <span
              id="os-team-task-count"
              className={`os-team__count os-mono${task.length > MAX_TASK ? " os-team__count--over" : ""}`}
            >
              {task.length.toLocaleString()} / {MAX_TASK.toLocaleString()}
            </span>
          </label>
          <div className="os-team__examples" role="group" aria-label="Example tasks">
            <span className="os-team__small">Or try one:</span>
            {EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                className="os-chip os-team__example"
                onClick={() => {
                  setTask(example.task);
                  document.querySelector<HTMLTextAreaElement>(".os-team__form textarea")?.focus();
                }}
              >
                {example.label}
              </button>
            ))}
          </div>

          <h2 className="os-team__h os-team__h--spaced">Limits</h2>
          <div className="os-team__limit-fields">
            <label className="os-field">
              <span className="os-field__label">Turns (2 to 12)</span>
              <input
                inputMode="numeric"
                value={turns}
                onChange={(event) => setTurns(event.target.value)}
                aria-invalid={turnsValue === null}
                aria-describedby="os-team-turns-hint"
              />
              <span id="os-team-turns-hint" className="os-team__hint">
                A turn is one message from one agent.
              </span>
            </label>
            <label className="os-field">
              <span className="os-field__label">Minutes (1 to 30)</span>
              <input
                inputMode="numeric"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                aria-invalid={minutesValue === null}
                aria-describedby="os-team-minutes-hint"
              />
              <span id="os-team-minutes-hint" className="os-team__hint">
                The room stops when time is up. Time spent waiting for you does not count.
              </span>
            </label>
            <label className="os-field">
              <span className="os-field__label">Cost cap in USD (optional)</span>
              <input
                inputMode="decimal"
                value={cost}
                placeholder="No cap"
                onChange={(event) => setCost(event.target.value)}
                aria-invalid={!costValid}
                aria-describedby="os-team-cost-hint"
              />
              <span id="os-team-cost-hint" className="os-team__hint">
                The room stops if the cost reaches this.
              </span>
            </label>
          </div>
          <p className="os-team__hint">The room stops at whichever limit comes first. Hermes Agent speaks first.</p>
          {capSet ? (
            <p className="os-team__protocol" role="note">
              {COST_CAP_NOTE}
            </p>
          ) : null}
          <label className="os-field os-team__model">
            <span className="os-field__label">OpenClaw model for this room (optional)</span>
            <input
              value={openclawModel}
              placeholder="OpenClaw's own setting"
              maxLength={100}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setOpenclawModel(event.target.value)}
              aria-invalid={!modelValid}
              aria-describedby="os-team-model-help"
            />
            <span id="os-team-model-help" className="os-team__hint">
              {modelValid
                ? "Leave empty to use OpenClaw's own setting. Example: ollama/phi4"
                : "Use only letters, numbers and . _ : / - (no spaces, and don't start with -). Example: ollama/phi4"}
            </span>
          </label>

          <div className="os-team__go">
            <button type="submit" className="os-btn os-btn--primary" disabled={!formValid || gateOff}>
              <Play size={16} aria-hidden="true" />
              Start room
            </button>
            <span className="os-team__hint">
              {!formValid && taskTrimmed.length > 0
                ? "Check the fields above: turns 2 to 12, minutes 1 to 30, cost above 0, and a plain model name."
                : "You can stop it at any time."}
            </span>
          </div>
        </form>

        <div className="os-team__aside">
          <h2 className="os-team__h">Who is in the room</h2>
          {agentsFailed && agents !== null ? (
            <Banner tone="warn">Couldn&apos;t re-check the agents just now. This is the last answer.</Banner>
          ) : null}
          <ul className="os-team__who">
            <WhoRow id="hermes" agents={agents} failed={agentsFailed} />
            <WhoRow id="openclaw" agents={agents} failed={agentsFailed} />
          </ul>
          <p className="os-team__hint">
            Each agent uses the brain you chose on{" "}
            <button type="button" className="os-team__link" onClick={() => navigateTo("agents")}>
              Agents
            </button>
            .
          </p>

          <h2 className="os-team__h os-team__h--spaced">What Agent OS does by itself</h2>
          <p className="os-team__lede-small">
            Agent OS asks both agents to only talk. Hermes is limited to talking when its version allows it, and OpenClaw must ask before it
            runs a command. Agent OS passes each message along, and it asks you before it saves anything.
          </p>
          <ul className="os-team__does">
            <li className="yes">
              <CheckCircle2 size={18} aria-hidden="true" />
              <div>
                <b>Saves a file you approve</b>
                <span className="os-team__sub">
                  Only <code>.md</code>, <code>.txt</code> or <code>.html</code>, only inside the Workspace sandbox, and only after both agents agree
                  and you press Approve.
                </span>
              </div>
            </li>
            <li className="yes">
              <CheckCircle2 size={18} aria-hidden="true" />
              <div>
                <b>Lets you Undo any save</b>
                <span className="os-team__sub">Undo puts the sandbox back as it was before.</span>
              </div>
            </li>
            <li className="no">
              <XCircle size={18} aria-hidden="true" />
              <div>Never runs commands or touches your project folders</div>
            </li>
            <li className="no">
              <XCircle size={18} aria-hidden="true" />
              <div>Never sends messages or emails for you</div>
            </li>
            <li className="no">
              <XCircle size={18} aria-hidden="true" />
              <div>Never goes past the turns or minutes you set. The cost cap only counts turns that report a cost.</div>
            </li>
          </ul>
        </div>
      </div>

      <section className="os-team__past" aria-labelledby="os-team-past">
        <h2 id="os-team-past" className="os-team__h">
          Past rooms
        </h2>
        {roomsFailed && rooms !== null ? <Banner tone="warn">Couldn&apos;t refresh your rooms just now. This is the last list Agent OS sent.</Banner> : null}
        {rooms === null && roomsFailed ? (
          <Banner
            tone="danger"
            actions={
              <button type="button" className="os-btn os-btn--secondary" onClick={() => void loadRooms()}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            }
          >
            Couldn&apos;t load your rooms. Agent OS isn&apos;t responding.
          </Banner>
        ) : rooms === null ? (
          <p className="os-team__hint" aria-live="polite">
            …
          </p>
        ) : rooms.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="No rooms yet" body="Write a task above and start your first one." />
        ) : (
          <div className="os-table os-team__rooms" role="table" aria-label="Past rooms" style={{ "--os-table-cols": ROOM_COLUMNS } as CSSProperties}>
            <div className="os-table__head" role="row">
              {["Status", "Task", "Turns", "Cost", "Started"].map((heading) => (
                <span key={heading} className="os-table__cell os-micro" role="columnheader">
                  {heading}
                </span>
              ))}
            </div>
            {rooms.map((room) => {
              const view = roomStatusView({ status: room.status, pausedFor: room.pausedFor });
              return (
                <div key={room.id} className="os-table__row os-team__room-row" role="row">
                  <div className="os-table__cell os-team__room-status" role="cell">
                    <StatusWord state={view.state} label={view.label} />
                    {room.status === "needs_you" && !room.pausedFor && room.needsApproval > 0 ? (
                      <span className="os-team__small">{room.needsApproval} waiting for your approval</span>
                    ) : null}
                  </div>
                  <div className="os-table__cell" role="cell">
                    <button type="button" className="os-team__room-open" onClick={() => onOpenRoom(room.id)}>
                      {excerpt(room.task)}
                    </button>
                  </div>
                  <div className="os-table__cell os-mono" role="cell" title="Turns used / turns allowed">
                    {room.turnsDone}/{room.turnsAllowed}
                  </div>
                  <div className="os-table__cell os-mono" role="cell" title={typeof room.costUsd === "number" ? undefined : "No turn reported a cost"}>
                    {usd(room.costUsd)}
                  </div>
                  <div className="os-table__cell os-team__small" role="cell">
                    <TimeAgo since={room.createdAt} />
                  </div>
                </div>
              );
            })}
          </div>
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
            <strong className="os-mono">{turnsValue}</strong> turns or <strong className="os-mono">{minutesValue}</strong> minutes.
          </p>
          <p>
            Each turn may cost money on those agents&apos; own model accounts.{" "}
            {costBlank ? "You have not set a cost cap." : `The room stops if known cost reaches $${costValue}.`}
          </p>
          {capSet ? <p>{COST_CAP_NOTE}</p> : null}
          {modelTrimmed ? (
            <p>
              OpenClaw will use <strong className="os-mono">{modelTrimmed}</strong> in this room.
            </p>
          ) : null}
          <p>The room asks you before it saves any file, and you can stop it at any time.</p>
        </AgentConfirmModal>
      ) : null}
    </div>
  );
}
