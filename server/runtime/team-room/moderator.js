// The Team Room moderator: runs a turn-based discussion between Hermes Agent
// and OpenClaw about one task.
//
// How it works, in plain words: the agents never talk to each other. Each turn
// is one ordinary headless run (the same kind you can start from the Agents
// page) through the run manager, so every turn also shows on the Runs page and
// can be stopped. The moderator writes each agent's prompt, reads the reply,
// and applies at most ONE tag from it: a note, a proposal, or an agreement.
// A reply is only ever data; nothing in it is run.
//
// Only one thing can happen on its own: when BOTH agents agree on a proposal
// to save a small text file, and the execution gate is on, the file is saved
// into the room's own folder (and can be undone). Everything else becomes a
// card for you to approve or reject.
import { promises as fs } from "node:fs";
import { getAdapter } from "../agents/index.js";
import { makeRunDir, resolveRunCwd } from "../agents/routes.js";
import { TERMINAL_RUN_STATUSES, getRunManager } from "../runs/run-manager.js";
import { applyFileProposal } from "./actions.js";
import { buildTurnPromptDetailed, parseReply } from "./protocol.js";
import {
  appendEvent,
  appendNotebook,
  createRoom,
  isValidRoomId,
  listRoomIds,
  readDecision,
  readEvents,
  readNotebook,
  readRoom,
  roomError,
  scrubPaths,
  updateDecision,
  updateRoom
} from "./room-store.js";

// Hermes always speaks first; turns then alternate.
const TURN_ORDER = ["hermes", "openclaw"];
const MAX_TURN_TEXT_CHARS = 8000;
const MAX_EXTRA_TURNS = 6;
const STOP_WAIT_MS = 10000;

export const DEFAULT_LIMITS = { maxTurns: 6, maxMinutes: 10, maxCostUsd: null };

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (value == null || value === "" || !Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(max, Math.max(min, parsed)));
}

// Out-of-range numbers are pulled back into range rather than rejected, so a
// slider that overshoots still starts a sensible room.
export function normalizeLimits(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const cost = Number(input.maxCostUsd);
  return {
    maxTurns: clampNumber(input.maxTurns, 2, 12, DEFAULT_LIMITS.maxTurns),
    maxMinutes: clampNumber(input.maxMinutes, 1, 30, DEFAULT_LIMITS.maxMinutes),
    maxCostUsd: input.maxCostUsd != null && Number.isFinite(cost) && cost > 0 ? cost : null
  };
}

function labelOf(agentId) {
  return getAdapter(agentId)?.label || agentId;
}

// ---------------------------------------------------------------------------
// Is it safe to start? (both agents installed, both safeguards on)
// ---------------------------------------------------------------------------

// Throws a roomError (409) naming the problem, or returns the detected agents.
// Safeguard fields used (both come from each adapter's safetyStatus()):
//   Hermes:   `permissive === true` means approvals are off (YOLO mode).
//   OpenClaw: an action with id "exec-ask" means tools.exec.mode is not "ask".
export async function checkAgentsReady() {
  const detected = {};
  for (const agentId of TURN_ORDER) {
    detected[agentId] = await getAdapter(agentId).detect({ refresh: true });
    if (!detected[agentId]?.installed) {
      throw roomError(
        409,
        "agent_missing",
        `${labelOf(agentId)} is not installed, and a Team Room needs both Hermes Agent and OpenClaw.`,
        { agent: agentId }
      );
    }
  }
  const [hermesSafety, openclawSafety] = await Promise.all([
    getAdapter("hermes").safetyStatus(detected.hermes),
    getAdapter("openclaw").safetyStatus(detected.openclaw)
  ]);
  const off = [];
  if (hermesSafety?.permissive) {
    off.push({ agent: "hermes", message: "Hermes Agent's approvals are off, so it could run commands without asking." });
  }
  if ((openclawSafety?.actions || []).some((action) => action.id === "exec-ask")) {
    off.push({ agent: "openclaw", message: "OpenClaw can run commands without asking (its exec mode is not 'ask')." });
  }
  if (off.length) {
    throw roomError(
      409,
      "safeguards_off",
      `${off.map((item) => item.message).join(" ")} Turn it on from the Agents page, then try again.`,
      { agents: off.map((item) => item.agent) }
    );
  }
  return detected;
}

// ---------------------------------------------------------------------------
// Reading a finished turn
// ---------------------------------------------------------------------------

// The agent's answer: the `result` event's text if it has any, else the
// `text` events joined, else the plain `line` events joined. Only the first
// kind that exists is used: when `result` or `text` events exist, `line`
// events (which can carry a tool's raw output) are never mixed in, so a tool
// cannot forge a protocol tag that way. Only stdout counts (stderr is log
// noise). The run manager has already stripped colour codes from every line.
//
// Known limitation: the plain-`line` fallback (used when an agent has no
// structured output, e.g. OpenClaw in gateway mode) can include tool output,
// and a forged tag in it could be read as the agent's reply. The damage is
// bounded (a tag can only add a note or a proposal, never run anything), but
// it is not prevented there.
export function finalTextFromEvents(events) {
  const out = events.filter((event) => event.stream !== "stderr");
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].type === "result" && typeof out[i].text === "string" && out[i].text.trim()) {
      return out[i].text.trim();
    }
  }
  const joined = (type) =>
    out
      .filter((event) => event.type === type && typeof event.text === "string")
      .map((event) => event.text)
      .join("\n")
      .trim();
  return joined("text") || joined("line");
}

// Only stdout is used (stderr is where stack traces and paths tend to live),
// and any real folder path is replaced before it is stored.
function failureDetail(meta, events) {
  if (meta?.error) return scrubPaths(String(meta.error));
  const tail = events
    .filter((event) => event.stream !== "stderr" && ["line", "text"].includes(event.type) && typeof event.text === "string" && event.text.trim())
    .slice(-3)
    .map((event) => event.text.trim())
    .join(" | ");
  return scrubPaths(tail.slice(-400));
}

function excerpt(task) {
  const oneLine = String(task).replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}...` : oneLine;
}

// ---------------------------------------------------------------------------
// The moderator
// ---------------------------------------------------------------------------

// `runManager` and `now` can be swapped in tests (a fake clock makes the
// wall-clock limit testable without waiting a real minute).
export function createModerator({
  runManager,
  now = Date.now,
  // A turn's run is cut off after its own timeout; waiting stops a little
  // later, so a run that never reports back cannot hang the room forever.
  minTurnTimeoutMs = 60 * 1000,
  turnGraceMs = 60 * 1000
} = {}) {
  const manager = () => runManager || getRunManager();
  // Only one room can run at a time; this is that room's in-memory state.
  let active = null;

  function newState(roomId) {
    const state = { roomId, stopRequested: false, currentRunId: null, clockStart: now() };
    state.done = new Promise((resolve) => {
      state.resolveDone = resolve;
    });
    return state;
  }

  function alreadyRunning() {
    return roomError(409, "room_already_running", "Another Team Room is still running. Stop it or wait for it to finish.", {
      roomId: active?.roomId || null
    });
  }

  // Ends the room: frees the "one active room" slot first (so a client that
  // reacts to the status event can immediately continue), then records it.
  async function finish(state, status, reason) {
    if (active === state) active = null;
    await updateRoom(state.roomId, (meta) => {
      meta.status = status;
      meta.endReason = scrubPaths(reason);
      meta.endedAt = new Date().toISOString();
      meta.currentTurn = null;
    });
    await appendEvent(state.roomId, { type: "status", status, reason: scrubPaths(reason) });
  }

  async function protocolNote(roomId, turn, agentId, message) {
    await appendEvent(roomId, { type: "protocol_note", turn, agentId, message: scrubPaths(message) });
  }

  async function setProposalStatus(roomId, proposalId, status, reason) {
    await updateDecision(roomId, (decision) => {
      const proposal = decision.proposals.find((p) => p.id === proposalId);
      if (proposal) {
        proposal.status = status;
        if (reason) proposal.statusReason = reason;
      }
    });
    await appendEvent(roomId, { type: "proposal_status", proposalId, status, reason: reason || null });
  }

  // Both agents agree. A file proposal is saved on the spot if (and only if)
  // the execution gate is on; everything else waits for the user.
  async function resolveAgreement(roomId, turn, agentId, proposal) {
    if (proposal.kind === "file") {
      try {
        // A refused write (a link in the way) is recorded and noted by
        // applyFileProposal itself; there is nothing more to do here.
        await applyFileProposal(roomId, proposal.id);
        return;
      } catch (error) {
        if (error?.code === "execution_gate_off") {
          await setProposalStatus(
            roomId,
            proposal.id,
            "needs_approval",
            "Both agents agree, but the execution gate is off, so nothing was saved."
          );
          return;
        }
        await protocolNote(roomId, turn, agentId, `The file could not be saved: ${error?.message || "unknown error"}.`);
        await setProposalStatus(roomId, proposal.id, "needs_approval", "Both agents agree, but saving the file failed.");
        return;
      }
    }
    await setProposalStatus(roomId, proposal.id, "needs_approval", "Both agents agree. Waiting for your approval.");
  }

  // Applies the one tag found in a reply. Never runs anything an agent wrote.
  async function applyReply(roomId, agentId, turn, parsed, shownFileIds) {
    const label = labelOf(agentId);

    if (parsed.kind === "note") {
      const time = new Date().toISOString().slice(11, 19);
      await appendNotebook(roomId, `**${label}** (turn ${turn}, ${time} UTC): ${parsed.text}`);
      await appendEvent(roomId, { type: "note", turn, agentId, text: parsed.text });
      return;
    }

    if (parsed.kind === "propose" || parsed.kind === "propose_file") {
      const proposal = await updateDecision(roomId, (decision) => {
        const created = {
          id: `P${decision.proposals.length + 1}`,
          by: agentId,
          byLabel: label,
          kind: parsed.kind === "propose_file" ? "file" : "decision",
          summary: parsed.summary,
          ...(parsed.kind === "propose_file" ? { file: parsed.file } : {}),
          status: "open",
          turn,
          createdAt: new Date().toISOString()
        };
        decision.proposals.push(created);
        return created;
      });
      await appendEvent(roomId, { type: "proposal", turn, agentId, proposal });
      return;
    }

    if (parsed.kind === "agree") {
      const outcome = await updateDecision(roomId, (decision) => {
        const proposal = decision.proposals.find((p) => p.id === parsed.proposalId);
        if (!proposal) return { problem: `${label} agreed with ${parsed.proposalId}, which does not exist.` };
        // Agreement must come from the OTHER agent, and only while it is open.
        if (proposal.by === agentId) return { problem: `${label} cannot agree with its own proposal ${proposal.id}.` };
        if (proposal.status !== "open") return { problem: `${proposal.id} is not open (it is ${proposal.status}).` };
        // Agreeing means agreeing to what you read: a file whose full content
        // was not in this agent's prompt cannot be agreed.
        if (proposal.kind === "file" && !shownFileIds.has(proposal.id)) {
          return { problem: `${label} agreed with ${proposal.id}, but its full content was not shown to ${label}.` };
        }
        proposal.status = "agreed";
        proposal.agreedBy = agentId;
        proposal.agreedAt = new Date().toISOString();
        return { proposal: { ...proposal } };
      });
      if (outcome.problem) {
        await protocolNote(roomId, turn, agentId, `${outcome.problem} Ignored.`);
        return;
      }
      await appendEvent(roomId, {
        type: "agreement",
        turn,
        agentId,
        proposalId: outcome.proposal.id,
        proposedBy: outcome.proposal.by
      });
      await resolveAgreement(roomId, turn, agentId, outcome.proposal);
      return;
    }

    if (parsed.kind === "disagree") {
      const outcome = await updateDecision(roomId, (decision) => {
        const proposal = decision.proposals.find((p) => p.id === parsed.proposalId);
        if (!proposal) return { problem: `${label} disagreed with ${parsed.proposalId}, which does not exist.` };
        if (proposal.status !== "open") return { problem: `${proposal.id} is not open (it is ${proposal.status}).` };
        proposal.status = "disputed";
        proposal.disputedBy = agentId;
        proposal.disputeReason = parsed.reason || "";
        return { proposal: { ...proposal } };
      });
      if (outcome.problem) {
        await protocolNote(roomId, turn, agentId, `${outcome.problem} Ignored.`);
        return;
      }
      await appendEvent(roomId, {
        type: "disagreement",
        turn,
        agentId,
        proposalId: parsed.proposalId,
        reason: parsed.reason || ""
      });
      return;
    }

    await protocolNote(
      roomId,
      turn,
      agentId,
      parsed.problem
        ? `${parsed.problem} The reply was kept in the transcript only.`
        : "The reply had no valid tag, so it was kept in the transcript only."
    );
  }

  function limitReached(room, state) {
    const { maxMinutes, maxCostUsd } = room.limits;
    if (maxCostUsd != null && room.costUsd != null && room.costUsd >= maxCostUsd) {
      return {
        status: "cost_cap",
        reason: `The cost cap of $${maxCostUsd} was reached (about $${room.costUsd.toFixed(4)} spent).`
      };
    }
    if (room.turnsDone >= room.turnsAllowed) {
      return {
        status: "needs_you",
        reason: `Reached the limit of ${room.turnsAllowed} turns. You can let it continue for a few more.`
      };
    }
    if (now() - state.clockStart >= maxMinutes * 60 * 1000) {
      return {
        status: "needs_you",
        reason: `Reached the ${maxMinutes}-minute time limit. You can let it continue for a few more turns.`
      };
    }
    return null;
  }

  // One turn: build the prompt, run the agent as a normal run, record the
  // result. Returns what the loop needs to decide what comes next.
  async function playTurn(state, room, turn, agentId, detected) {
    const { roomId } = state;
    const adapter = getAdapter(agentId);
    const otherId = TURN_ORDER.find((id) => id !== agentId);

    const [decision, notebook, events] = await Promise.all([readDecision(roomId), readNotebook(roomId), readEvents(roomId)]);
    const transcript = events
      .filter((event) => event.type === "turn_ended")
      .map((event) => ({ turn: event.turn, agentLabel: labelOf(event.agentId), text: event.text || "" }));
    const { prompt, shownFileProposalIds } = buildTurnPromptDetailed({
      agentLabel: adapter.label,
      otherLabel: labelOf(otherId),
      task: room.task,
      notebook,
      transcript,
      openProposals: decision.proposals.filter((p) => p.status === "open"),
      turnNumber: turn,
      maxTurns: room.turnsAllowed
    });

    const shownFileIds = new Set(shownFileProposalIds);
    const cwd = await resolveRunCwd(agentId, `team/${roomId}`);
    const runDir = await makeRunDir(agentId);
    let run;
    let turnTimeoutMs = minTurnTimeoutMs;
    try {
      const built = await adapter.buildRun({ prompt, cwd, detected: detected[agentId], runDir, options: {} });
      // A turn never needs to outlive the room's wall clock by much.
      const remainingMs = room.limits.maxMinutes * 60 * 1000 - (now() - state.clockStart);
      const planned = built.timeoutMs || 30 * 60 * 1000;
      const originalOnExit = built.onExit;
      const plan = {
        ...built,
        kind: "team-turn",
        title: `Team room: ${excerpt(room.task)} (turn ${turn})`,
        timeoutMs: Math.max(minTurnTimeoutMs, Math.min(planned, remainingMs + 60 * 1000)),
        async onExit(meta) {
          await originalOnExit?.(meta);
          await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
        }
      };
      run = await manager().startRun(plan);
      turnTimeoutMs = plan.timeoutMs;
    } catch (error) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    state.currentRunId = run.id;
    await updateRoom(roomId, (meta) => {
      meta.currentTurn = { turn, agentId, runId: run.id };
    });
    await appendEvent(roomId, { type: "turn_started", turn, agentId, runId: run.id });
    // Stop was pressed while this run was still starting.
    if (state.stopRequested) await manager().stopRun(run.id);

    let finalMeta = await manager().waitForRun(run.id, { timeoutMs: turnTimeoutMs + turnGraceMs });
    // Still not finished long after its own timeout: stop it so the room can
    // end with a clear reason instead of hanging.
    let hung = false;
    if (!TERMINAL_RUN_STATUSES.has(finalMeta?.status)) {
      hung = true;
      finalMeta = (await manager().stopRun(run.id)) || finalMeta;
    }
    state.currentRunId = null;
    const runEvents = await manager().readEvents(run.id);
    const text = scrubPaths(finalTextFromEvents(runEvents));
    const parsed = parseReply(text);
    const costUsd = typeof finalMeta.usage?.costUsd === "number" ? finalMeta.usage.costUsd : null;

    await appendEvent(roomId, {
      type: "turn_ended",
      turn,
      agentId,
      runId: run.id,
      status: hung ? "timed_out" : finalMeta.status,
      text: text.slice(0, MAX_TURN_TEXT_CHARS),
      costUsd,
      parsed
    });
    await updateRoom(roomId, (meta) => {
      meta.turnsDone = turn;
      meta.currentTurn = null;
      if (costUsd != null) {
        meta.costUsd = (meta.costUsd || 0) + costUsd;
        meta.costKnownTurns += 1;
      } else {
        meta.costUnknownTurns += 1;
      }
    });
    return { meta: finalMeta, runEvents, parsed, hung, shownFileIds };
  }

  async function runRoom(state, detected) {
    const { roomId } = state;
    try {
      for (;;) {
        if (state.stopRequested) {
          await finish(state, "stopped", "Stopped by you.");
          return;
        }
        const room = await readRoom(roomId);
        const limit = limitReached(room, state);
        if (limit) {
          await finish(state, limit.status, limit.reason);
          return;
        }

        const turn = room.turnsDone + 1;
        const agentId = TURN_ORDER[(turn - 1) % TURN_ORDER.length];
        const result = await playTurn(state, room, turn, agentId, detected);
        const status = result.meta.status;

        if (result.hung) {
          await finish(
            state,
            "failed",
            `${labelOf(agentId)}'s turn ${turn} did not finish in time and was stopped.`
          );
          return;
        }

        if (state.stopRequested || status === "stopped") {
          await finish(state, "stopped", "Stopped by you.");
          return;
        }
        if (status !== "succeeded") {
          if (status === "timed_out" && now() - state.clockStart >= room.limits.maxMinutes * 60 * 1000) {
            await finish(state, "needs_you", `Ran out of the ${room.limits.maxMinutes}-minute time limit during turn ${turn}.`);
            return;
          }
          const detail = failureDetail(result.meta, result.runEvents);
          await finish(
            state,
            "failed",
            `${labelOf(agentId)}'s turn ${turn} ${status.replace("_", " ")}${detail ? `: ${detail}` : "."}`
          );
          return;
        }

        await applyReply(roomId, agentId, turn, result.parsed, result.shownFileIds);

        // Done early: a file was saved and nothing is still waiting for agreement.
        const decision = await readDecision(roomId);
        const savedAFile = decision.actions.some((a) => a.kind === "file_write" && !a.failed);
        if (savedAFile && !decision.proposals.some((p) => p.status === "open")) {
          await finish(state, "agreed", "Both agents agreed and the file was saved.");
          return;
        }
      }
    } catch (error) {
      await finish(state, "failed", error?.message || "The room hit an unexpected error.").catch(() => {});
    } finally {
      if (active === state) active = null;
      state.resolveDone();
    }
  }

  // ---- public API ------------------------------------------------------------

  // Returns { room, done }: the new room right away, and a promise that
  // settles when the room finishes (the HTTP route ignores it; tests await it).
  async function startRoom({ task, limits }) {
    if (active) throw alreadyRunning();
    // Claim the slot before any await, so two starts cannot both get through.
    const state = newState(null);
    active = state;
    let room;
    let detected;
    try {
      detected = await checkAgentsReady();
      room = await createRoom({ task, limits: normalizeLimits(limits) });
    } catch (error) {
      active = null;
      throw error;
    }
    state.roomId = room.id;
    await appendEvent(room.id, { type: "room_started", task: room.task, limits: room.limits });
    await appendEvent(room.id, { type: "status", status: "running", reason: "Room started." });
    runRoom(state, detected);
    return { room, done: state.done };
  }

  async function continueRoom(roomId, extraTurns) {
    const extra = Number(extraTurns);
    if (!Number.isInteger(extra) || extra < 1 || extra > MAX_EXTRA_TURNS) {
      throw roomError(400, "invalid_extra_turns", `extraTurns must be a whole number from 1 to ${MAX_EXTRA_TURNS}.`);
    }
    const existing = await readRoom(roomId);
    if (!existing) throw roomError(404, "room_not_found", "Room not found.");
    if (active) throw alreadyRunning();
    if (existing.status !== "needs_you") {
      throw roomError(409, "not_continuable", "Only a room that is waiting for you (needs_you) can continue.");
    }
    const state = newState(roomId);
    active = state;
    let detected;
    let room;
    try {
      detected = await checkAgentsReady();
      room = await updateRoom(roomId, (meta) => {
        meta.turnsAllowed += extra;
        meta.status = "running";
        meta.endedAt = null;
        meta.endReason = null;
        meta.clockStartedAt = new Date().toISOString();
      });
    } catch (error) {
      active = null;
      throw error;
    }
    await appendEvent(roomId, { type: "limits_extended", extraTurns: extra, turnsAllowed: room.turnsAllowed });
    await appendEvent(roomId, {
      type: "status",
      status: "running",
      reason: `Continuing for ${extra} more turn${extra === 1 ? "" : "s"}.`
    });
    runRoom(state, detected);
    return { room, done: state.done };
  }

  async function stopRoom(roomId) {
    if (!isValidRoomId(roomId) || !(await readRoom(roomId))) throw roomError(404, "room_not_found", "Room not found.");
    if (!active || active.roomId !== roomId) {
      throw roomError(409, "room_not_running", "That room is not running.");
    }
    const state = active;
    state.stopRequested = true;
    if (state.currentRunId) await manager().stopRun(state.currentRunId);
    let timer;
    await Promise.race([
      state.done,
      new Promise((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      })
    ]).finally(() => clearTimeout(timer));
    return readRoom(roomId);
  }

  function activeRoomId() {
    return active?.roomId || null;
  }

  return { startRoom, continueRoom, stopRoom, activeRoomId };
}

let defaultModerator = null;

export function getModerator() {
  if (!defaultModerator) defaultModerator = createModerator();
  return defaultModerator;
}

// Called once at server start (next to the run manager's recoverStaleRuns):
// a room still marked "running" on disk belonged to a process that is gone.
export async function recoverStaleRooms() {
  for (const roomId of await listRoomIds()) {
    const room = await readRoom(roomId);
    if (!room || room.status !== "running") continue;
    await updateRoom(roomId, (meta) => {
      meta.status = "interrupted";
      meta.endedAt = new Date().toISOString();
      meta.endReason = "Agent OS restarted while this room was running.";
      meta.currentTurn = null;
    });
    await appendEvent(roomId, {
      type: "status",
      status: "interrupted",
      reason: "Agent OS restarted while this room was running."
    });
  }
}
