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
// Nothing happens on its own. When BOTH agents agree on a proposal it becomes a
// card for you to approve or reject. When the card is a file, the room also
// pauses ("Paused for your decision") and its time limit stops running until
// you decide. Only your Approve saves a file, into the room's own folder (and
// it can be undone).
import { promises as fs } from "node:fs";
import { getAdapter } from "../agents/index.js";
import { OPENCLAW_MODEL_PATTERN } from "../agents/openclaw.js";
import { makeRunDir, resolveRunCwd } from "../agents/routes.js";
import { isExecutionEnabled } from "../execution-gate.js";
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

// Shown when a cost cap is set, because Hermes may report no cost at all (its
// model can be a subscription), and the cap can only count what is reported.
export const COST_CAP_WARNING =
  "Hermes doesn't report cost (its model is a subscription or the version doesn't say); the cost cap only counts OpenClaw.";

// Two replies from the same agent with no usable tag: its model probably
// can't follow the room's reply format.
const NO_TAG_HINT_AFTER = 2;

// Returns the model name to pass to OpenClaw, "" for none, or throws a 400.
// It is passed as ONE argument (never through a shell), and may not start
// with "-" so it can never be read as a flag.
export function validateOpenclawModel(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || !OPENCLAW_MODEL_PATTERN.test(value.trim())) {
    throw roomError(
      400,
      "invalid_openclaw_model",
      "The OpenClaw model can only use letters, numbers and . _ : / - (up to 100 characters), for example ollama/phi4."
    );
  }
  return value.trim();
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (value == null || value === "" || !Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(max, Math.max(min, parsed)));
}

// Out-of-range numbers are pulled back into range rather than rejected, so a
// slider that overshoots still starts a sensible room.
export function normalizeLimits(raw, openclawModel = "") {
  const input = raw && typeof raw === "object" ? raw : {};
  const cost = Number(input.maxCostUsd);
  return {
    openclawModel: openclawModel || null,
    maxTurns: clampNumber(input.maxTurns, 2, 12, DEFAULT_LIMITS.maxTurns),
    maxMinutes: clampNumber(input.maxMinutes, 1, 30, DEFAULT_LIMITS.maxMinutes),
    maxCostUsd: input.maxCostUsd != null && Number.isFinite(cost) && cost > 0 ? cost : null
  };
}

function labelOf(agentId) {
  return getAdapter(agentId)?.label || agentId;
}

// What the person decided on the file card a room was paused on, for the agents
// that have not been told yet. `decideProposal` marks such a card with `toTell`
// (both agents); each agent's next prompt carries the decision once.
function decisionsToTell(decision, agentId) {
  return decision.proposals
    .filter((p) => p.userDecision && Array.isArray(p.toTell) && p.toTell.includes(agentId))
    .map((p) => ({ id: p.id, fileName: p.file?.name || "", decision: p.userDecision, saved: p.status === "applied" }));
}

async function markDecisionsTold(roomId, agentId, told) {
  if (!told.length) return;
  const ids = new Set(told.map((item) => item.id));
  await updateDecision(roomId, (decision) => {
    for (const proposal of decision.proposals) {
      if (ids.has(proposal.id) && Array.isArray(proposal.toTell)) {
        proposal.toTell = proposal.toTell.filter((id) => id !== agentId);
      }
    }
  });
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

// What a finished run says about itself: the model it used (a `system` event
// or the run's meta) and a tool-call summary, if the agent reported one.
// Both are short facts, not agent prose, so they are safe to show as is.
export function runFactsFromEvents(meta, events) {
  let model = typeof meta?.model === "string" && meta.model ? meta.model : null;
  let toolSummary = null;
  for (const event of events) {
    if (event.type !== "system" || event.stream === "stderr") continue;
    if (!model && typeof event.model === "string" && event.model) model = event.model;
    const calls = event.data?.toolCalls;
    if (typeof calls === "number") {
      toolSummary = { calls, failures: Number(event.data.toolFailures) || 0 };
    }
  }
  // A model name is plain letters, digits and . _ : / @ + - ; anything else is dropped.
  const cleaned = model ? scrubPaths(model).replace(/[^\w.:/@+ -]/g, "").trim().slice(0, 120) : "";
  return { model: cleaned || null, toolSummary };
}

function noTagHint(agentId, model) {
  const label = labelOf(agentId);
  const named = model ? `${label}'s model (${model})` : `${label}'s model`;
  const fix =
    agentId === "openclaw"
      ? "Choose a larger model for OpenClaw when starting a room, or set up an OpenRouter key in Setup."
      : "Choose a larger model in Hermes's own settings, or set up an OpenRouter key in Setup.";
  return `${named} didn't follow the room's reply format. Small local models often can't. ${fix}`;
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

  // `clockUsedMs` is the time a paused room had already used: the clock then
  // carries on from there, so the wait for a decision never counts.
  function newState(roomId, clockUsedMs = 0) {
    const state = { roomId, stopRequested: false, currentRunId: null, clockStart: now() - clockUsedMs };
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
  // `pausedFor` (a proposal id) and `clockUsedMs` are only given when the room
  // pauses for a decision; every other ending clears them.
  async function finish(state, status, reason, { pausedFor = null, clockUsedMs = null } = {}) {
    if (active === state) active = null;
    await updateRoom(state.roomId, (meta) => {
      meta.status = status;
      meta.endReason = scrubPaths(reason);
      meta.endedAt = new Date().toISOString();
      meta.currentTurn = null;
      meta.pausedFor = pausedFor;
      meta.clockUsedMs = clockUsedMs;
    });
    await appendEvent(state.roomId, {
      type: "status",
      status,
      reason: scrubPaths(reason),
      ...(pausedFor ? { pausedFor } : {})
    });
  }

  // The room waits for the person to decide on an agreed file. The status is
  // the existing needs_you; `pausedFor` says why, and `clockUsedMs` keeps the
  // time used so far, so the wait never counts against the time limit.
  async function pauseRoom(state, pause) {
    const used = Math.max(0, Math.round(now() - state.clockStart));
    await finish(
      state,
      "needs_you",
      `Paused for your decision: ${pause.byLabel}'s file ${pause.fileName} needs your approval.`,
      { pausedFor: pause.proposalId, clockUsedMs: used }
    );
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

  // Both agents agree. Nothing is ever written here, whether the execution gate
  // is on or off: the proposal becomes a card for you ("needs approval"). For a
  // file the caller also pauses the room, so this returns what to pause for;
  // a decision proposal returns null and the room keeps taking turns.
  async function resolveAgreement(roomId, proposal) {
    await setProposalStatus(roomId, proposal.id, "needs_approval", "Both agents agree. Waiting for your approval.");
    if (proposal.kind !== "file") return null;
    return { proposalId: proposal.id, fileName: proposal.file?.name || "", byLabel: proposal.byLabel || labelOf(proposal.by) };
  }

  // Applies the one tag found in a reply. Never runs anything an agent wrote.
  // Returns what the room must pause for (an agreed file proposal), or null.
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
      return resolveAgreement(roomId, outcome.proposal);
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

  // The room only ends "agreed" when at least one file you approved is saved
  // (and not undone) and no proposal is still open or waiting for you.
  function approvedFileSavedAndNothingOpen(decision) {
    const saved = decision.actions.some((a) => a.kind === "file_write" && !a.failed && !a.undone);
    const waiting = decision.proposals.some((p) => p.status === "open" || p.status === "needs_approval");
    return saved && !waiting;
  }

  function limitReached(room, state, decision) {
    const { maxMinutes, maxCostUsd } = room.limits;
    if (maxCostUsd != null && room.costUsd != null && room.costUsd >= maxCostUsd) {
      return {
        status: "cost_cap",
        reason: `The cost cap of $${maxCostUsd} was reached (about $${room.costUsd.toFixed(4)} spent).`
      };
    }
    const saved = approvedFileSavedAndNothingOpen(decision);
    if (room.turnsDone >= room.turnsAllowed) {
      return saved
        ? {
            status: "agreed",
            reason: `Reached the limit of ${room.turnsAllowed} turns with your approved file saved and nothing left open.`
          }
        : {
            status: "needs_you",
            reason: `Reached the limit of ${room.turnsAllowed} turns. You can let it continue for a few more.`
          };
    }
    if (now() - state.clockStart >= maxMinutes * 60 * 1000) {
      return saved
        ? {
            status: "agreed",
            reason: `Reached the ${maxMinutes}-minute time limit with your approved file saved and nothing left open.`
          }
        : {
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
    const toldNow = decisionsToTell(decision, agentId);
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
      userDecisions: toldNow,
      turnNumber: turn,
      maxTurns: room.turnsAllowed
    });

    const shownFileIds = new Set(shownFileProposalIds);
    const cwd = await resolveRunCwd(agentId, `team/${roomId}`);
    const runDir = await makeRunDir(agentId);
    let run;
    let turnTimeoutMs = minTurnTimeoutMs;
    try {
      // Each agent is held to talking: Hermes gets only a harmless toolset, and
      // OpenClaw gets this room's own conversation (never your main one).
      const turnOptions =
        agentId === "hermes"
          ? { talkOnly: true }
          : { sessionId: `agentos-room-${roomId}`, ...(room.limits.openclawModel ? { model: room.limits.openclawModel } : {}) };
      const built = await adapter.buildRun({ prompt, cwd, detected: detected[agentId], runDir, options: turnOptions });
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
    await markDecisionsTold(roomId, agentId, toldNow);
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
    // null = the agent reported no cost (unknown); 0 = it reported a real zero.
    const costUsd = typeof finalMeta.usage?.costUsd === "number" ? finalMeta.usage.costUsd : null;
    const { model, toolSummary } = runFactsFromEvents(finalMeta, runEvents);
    const succeeded = !hung && finalMeta.status === "succeeded";

    await appendEvent(roomId, {
      type: "turn_ended",
      turn,
      agentId,
      runId: run.id,
      status: hung ? "timed_out" : finalMeta.status,
      text: text.slice(0, MAX_TURN_TEXT_CHARS),
      costUsd,
      model,
      toolSummary,
      parsed
    });
    let hint = null;
    await updateRoom(roomId, (meta) => {
      meta.turnsDone = turn;
      meta.currentTurn = null;
      if (costUsd != null) {
        meta.costUsd = (meta.costUsd || 0) + costUsd;
        meta.costKnownTurns += 1;
      } else {
        meta.costUnknownTurns += 1;
      }
      meta.cost = { knownUsd: meta.costUsd || 0, unknownTurns: meta.costUnknownTurns };
      // The cap can only count what agents report; say so when it matters.
      meta.costWarning = meta.limits.maxCostUsd != null && meta.costUnknownTurns > 0 ? COST_CAP_WARNING : null;
      if (succeeded && parsed.kind === "none") {
        meta.noTagTurns = { ...(meta.noTagTurns || {}), [agentId]: ((meta.noTagTurns || {})[agentId] || 0) + 1 };
        if (meta.noTagTurns[agentId] === NO_TAG_HINT_AFTER) {
          hint = noTagHint(agentId, model);
          meta.hints = [...(meta.hints || []), hint];
        }
      }
    });
    if (hint) await appendEvent(roomId, { type: "room_hint", agentId, message: hint });
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
        const limit = limitReached(room, state, await readDecision(roomId));
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
            const ran = `Ran out of the ${room.limits.maxMinutes}-minute time limit during turn ${turn}`;
            if (approvedFileSavedAndNothingOpen(await readDecision(roomId))) {
              await finish(state, "agreed", `${ran}, with your approved file saved and nothing left open.`);
            } else {
              await finish(state, "needs_you", `${ran}.`);
            }
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

        // An agreed file proposal pauses the room for your decision. There is
        // no other early exit: the room ends at its limits, by Stop, or on a failure.
        const pause = await applyReply(roomId, agentId, turn, result.parsed, result.shownFileIds);
        if (pause) {
          await pauseRoom(state, pause);
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
  async function startRoom({ task, limits, openclawModel }) {
    const model = validateOpenclawModel(openclawModel);
    if (active) throw alreadyRunning();
    // Claim the slot before any await, so two starts cannot both get through.
    const state = newState(null);
    active = state;
    let room;
    let detected;
    try {
      detected = await checkAgentsReady();
      room = await createRoom({ task, limits: normalizeLimits(limits, model) });
    } catch (error) {
      active = null;
      throw error;
    }
    state.roomId = room.id;
    await appendEvent(room.id, { type: "room_started", task: room.task, limits: room.limits });
    await appendEvent(room.id, { type: "status", status: "running", reason: "Room started." });
    runRoom(state, detected);
    // `warnings` is for the start response only (it is not stored): a cost
    // cap needs a heads-up, because Hermes may not report any cost.
    const warnings = room.limits.maxCostUsd != null ? [COST_CAP_WARNING] : [];
    return { room, done: state.done, warnings };
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
        // Continue also ends a pause: the proposal stays "needs approval" and
        // its card can still be decided later. The clock restarts (new state).
        meta.pausedFor = null;
        meta.clockUsedMs = null;
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
      reason: `Continuing for ${extra} more turn${extra === 1 ? "" : "s"}.${
        existing.pausedFor ? ` ${existing.pausedFor} still waits for your decision.` : ""
      }`
    });
    runRoom(state, detected);
    return { room, done: state.done };
  }

  // ---- deciding on a card ----------------------------------------------------

  // Decisions on one room are handled one at a time, so a double click (or two
  // windows) cannot write the file twice or resume the room twice: the second
  // request waits, then sees the proposal is already decided and gets a 409.
  const decisionChains = new Map();

  function oneDecisionAtATime(roomId, task) {
    const previous = decisionChains.get(roomId) || Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => {});
    decisionChains.set(roomId, tail);
    tail.then(() => {
      if (decisionChains.get(roomId) === tail) decisionChains.delete(roomId);
    });
    return next;
  }

  // The room is paused on a card that was just decided, but cannot carry on
  // (gate off, another room running, an agent not ready). The decision stays
  // recorded; the pause ends and the room waits for Continue.
  async function releasePause(roomId, proposalId, reason) {
    let released = false;
    await updateRoom(roomId, (meta) => {
      if (meta.status === "needs_you" && meta.pausedFor === proposalId) {
        meta.pausedFor = null;
        meta.clockUsedMs = null;
        meta.endReason = scrubPaths(reason);
        released = true;
      }
    });
    if (released) await appendEvent(roomId, { type: "status", status: "needs_you", reason: scrubPaths(reason) });
    return released;
  }

  // Carries a paused room on with the turns it has left (no extra turns), once
  // its card is decided. Only when Continue could: the execution gate is on,
  // no other room runs and both agents are ready. Returns true when it resumed.
  async function resumeAfterDecision(roomId, proposalId) {
    if (!(await isExecutionEnabled())) {
      await releasePause(
        roomId,
        proposalId,
        "Your decision is saved. Turn on the execution gate, then press Continue to let the room carry on."
      );
      return false;
    }
    // Check and claim the "one active room" slot with no await in between.
    // If it is THIS room, Continue got there first and will end the pause itself.
    if (active?.roomId === roomId) return false;
    if (active) {
      await releasePause(
        roomId,
        proposalId,
        "Your decision is saved. Another Team Room is running; press Continue when it has finished."
      );
      return false;
    }
    const state = newState(roomId);
    active = state;
    let detected;
    let room = null;
    let transitioned = false;
    try {
      detected = await checkAgentsReady();
      room = await updateRoom(roomId, (meta) => {
        // Something else already ended the pause; then there is nothing to resume.
        if (meta.status !== "needs_you" || meta.pausedFor !== proposalId) return meta;
        state.clockStart = now() - (meta.clockUsedMs || 0);
        meta.status = "running";
        meta.pausedFor = null;
        meta.clockUsedMs = null;
        meta.endedAt = null;
        meta.endReason = null;
        // Rewind the shown start by the time already used, so the page's clock
        // (now - clockStartedAt) and the server's limit (state.clockStart) agree.
        meta.clockStartedAt = new Date(state.clockStart).toISOString();
        transitioned = true;
        return meta;
      });
    } catch (error) {
      if (active === state) active = null;
      await releasePause(
        roomId,
        proposalId,
        `Your decision is saved, but the room could not carry on: ${error?.message || "an agent is not ready"}`
      );
      return false;
    }
    if (!transitioned) {
      if (active === state) active = null;
      return false;
    }
    const left = Math.max(0, room.turnsAllowed - room.turnsDone);
    await appendEvent(roomId, {
      type: "status",
      status: "running",
      reason:
        left > 0
          ? `Your decision is saved. Continuing with the ${left} turn${left === 1 ? "" : "s"} that ${left === 1 ? "is" : "are"} left.`
          : "Your decision is saved. No turns are left, so the room wraps up."
    });
    runRoom(state, detected);
    return true;
  }

  // Approve or reject a decision card. Returns { proposal, action, resumed, room }.
  // Approving a file writes it through applyFileProposal (403 execution_gate_off
  // when the gate is off, and then nothing changes). Deciding the card a room is
  // paused on also ends the pause and, when it can, resumes the room.
  async function decideProposal(roomId, proposalId, choice) {
    if (choice !== "approve" && choice !== "reject") {
      throw roomError(400, "invalid_decision", "decision must be approve or reject");
    }
    return oneDecisionAtATime(roomId, async () => {
      const room = await readRoom(roomId);
      if (!room) throw roomError(404, "room_not_found", "Room not found.");
      const before = (await readDecision(roomId)).proposals.find((p) => p.id === proposalId);
      if (!before) throw roomError(404, "proposal_not_found", "Proposal not found.");
      if (before.status !== "needs_approval") {
        const decided = ["approved", "rejected", "applied", "refused"].includes(before.status);
        throw roomError(
          409,
          "not_pending",
          decided
            ? `That proposal was already decided (it is ${before.status}).`
            : `That proposal is ${before.status}, so it is not waiting for your decision.`,
          { status: before.status }
        );
      }
      const pausedOnThis = room.status === "needs_you" && room.pausedFor === proposalId;

      let action = null;
      if (choice === "approve" && before.kind === "file") {
        action = await applyFileProposal(roomId, proposalId);
      }
      const proposal = await updateDecision(roomId, (decision) => {
        const found = decision.proposals.find((p) => p.id === proposalId);
        if (!found) throw roomError(404, "proposal_not_found", "Proposal not found.");
        if (!action) {
          if (found.status !== "needs_approval") {
            throw roomError(409, "not_pending", `That proposal is ${found.status}, so it is not waiting for your decision.`);
          }
          found.status = choice === "approve" ? "approved" : "rejected";
        }
        found.userDecision = choice;
        found.decidedAt = new Date().toISOString();
        // The agents hear about a decision that ended a pause, once each.
        if (pausedOnThis) found.toTell = [...TURN_ORDER];
        return { ...found };
      });
      await appendEvent(roomId, { type: "proposal_decided", proposalId, decision: choice, status: proposal.status });
      const resumed = pausedOnThis ? await resumeAfterDecision(roomId, proposalId) : false;
      return { proposal, action, resumed, room: await readRoom(roomId) };
    });
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

  return { startRoom, continueRoom, decideProposal, stopRoom, activeRoomId };
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
    if (!room) continue;
    if (room.status === "needs_you" && room.pausedFor) {
      // A room paused for a decision stays paused across a restart. Only when
      // the card was decided just before the app stopped (the decision was
      // saved but the pause was not cleared yet) is the pause over.
      const proposal = (await readDecision(roomId)).proposals.find((p) => p.id === room.pausedFor);
      if (!proposal || proposal.status !== "needs_approval") {
        const reason = "Your decision is saved. Press Continue to let the room carry on.";
        await updateRoom(roomId, (meta) => {
          meta.pausedFor = null;
          meta.clockUsedMs = null;
          meta.endReason = reason;
        });
        await appendEvent(roomId, { type: "status", status: "needs_you", reason });
      }
      continue;
    }
    if (room.status !== "running") continue;
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
