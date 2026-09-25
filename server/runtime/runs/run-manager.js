// The engine behind every agent run: spawns a validated plan, streams and
// stores its output, and stops the whole process tree cleanly. This module
// never accepts a raw command from HTTP — routes.js only lists/reads/stops.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { containsBlockedFlag } from "../agent-flags.js";
import { childEnv } from "../live-chat.js";
import { killProcessTree, spawnTracked } from "../process-tree.js";
import { redactText, withSiblingNodePath } from "../safety.js";
import {
  appendRunEventLine,
  countRunEvents,
  listRunIds,
  readRunEvents,
  readRunMeta,
  runsDir,
  writeRunMeta
} from "./run-store.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(["queued", "running"]);

function invalidPlanError(message) {
  const error = new Error(message);
  error.code = "invalid_plan";
  return error;
}

function generateRunId() {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}

function clampTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, parsed);
}

// Every plan.redact string of length 6+ is treated as a secret; shorter
// strings are too likely to appear in ordinary output.
function redactSecrets(text, redact = []) {
  let out = String(text ?? "");
  for (const secret of redact) {
    if (typeof secret === "string" && secret.length >= 6) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function quoteArg(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

// Exported so routes that only preview a plan (never spawning it) can show
// the same redacted string the run itself would record.
export function buildCommandPreview(plan) {
  const raw = [plan.command, ...plan.args].map(quoteArg).join(" ");
  return redactSecrets(redactText(raw, plan.redact || []), plan.redact || []);
}

async function validatePlan(plan) {
  if (!plan || typeof plan !== "object") throw invalidPlanError("A run plan is required.");
  if (!path.isAbsolute(String(plan.command || ""))) {
    throw invalidPlanError("plan.command must be an absolute path.");
  }
  if (!Array.isArray(plan.args) || !plan.args.every((arg) => typeof arg === "string")) {
    throw invalidPlanError("plan.args must be an array of strings.");
  }
  if (!plan.cwd || typeof plan.cwd !== "string") {
    throw invalidPlanError("plan.cwd is required.");
  }
  let stat;
  try {
    stat = await fs.stat(plan.cwd);
  } catch {
    throw invalidPlanError("plan.cwd does not exist.");
  }
  if (!stat.isDirectory()) throw invalidPlanError("plan.cwd must be a directory.");
}

function blockedFlagError() {
  const error = new Error("Refused: the run arguments contain a blocked flag.");
  error.code = "blocked_flag";
  return error;
}

// A bare "-f" is too generic for the shared substring list in agent-flags.js
// (it would match unrelated flags on other CLIs), but for Cursor Agent's
// binaries it specifically means "force allow commands unless explicitly
// denied" - the same bypass "--force" already blocks. Checked as an exact
// argument, and only for these two binaries, so nothing else is affected.
const FORCE_BYPASS_BINARIES = new Set(["agent", "cursor-agent"]);

function hasCursorForceFlag(plan) {
  if (!FORCE_BYPASS_BINARIES.has(path.basename(String(plan.command || "")))) return false;
  return plan.args.some((arg) => arg === "-f" || arg === "--force");
}

function tooManyRunsError() {
  const error = new Error("Too many runs are already active.");
  error.code = "too_many_runs";
  return error;
}

export function createRunManager({ maxConcurrent = 4, maxOutputBytes = 5 * 1024 * 1024 } = {}) {
  // In-memory state for runs this process owns; disk is the source of truth
  // for everything else (other processes' runs, runs from before a restart).
  const runs = new Map();

  function countActive() {
    let count = 0;
    for (const state of runs.values()) {
      if (ACTIVE_STATUSES.has(state.meta.status)) count += 1;
    }
    return count;
  }

  // Chains every write for a given run onto one promise so concurrent
  // stdout/stderr chunks can never interleave seq numbers or jsonl writes.
  function enqueue(state, task) {
    state.queue = state.queue.then(task, task);
    return state.queue;
  }

  function broadcast(state, event) {
    for (const listener of state.subscribers) {
      try {
        listener(event);
      } catch {
        // a bad subscriber must not break the run
      }
    }
  }

  async function persistMeta(state) {
    await writeRunMeta(state.dir, state.meta);
  }

  async function appendEvent(state, partial) {
    return enqueue(state, async () => {
      if (state.truncated) return null;
      const event = { seq: state.nextSeq, t: new Date().toISOString(), ...partial };
      state.nextSeq += 1;
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      if (state.storedBytes + bytes > maxOutputBytes) {
        state.truncated = true;
        state.meta.truncated = true;
        const notice = {
          seq: state.nextSeq,
          t: new Date().toISOString(),
          stream: "system",
          type: "system",
          text: "Output limit reached; further output for this run is not stored."
        };
        state.nextSeq += 1;
        const noticeLine = `${JSON.stringify(notice)}\n`;
        await appendRunEventLine(state.dir, state.meta.id, noticeLine);
        state.storedBytes += Buffer.byteLength(noticeLine);
        broadcast(state, notice);
        return notice;
      }
      await appendRunEventLine(state.dir, state.meta.id, line);
      state.storedBytes += bytes;
      broadcast(state, event);
      return event;
    });
  }

  function accumulateUsage(state, evt) {
    if (evt?.type !== "usage") return;
    const usage = state.meta.usage || (state.meta.usage = {});
    if (typeof evt.costUsd === "number") usage.costUsd = (usage.costUsd || 0) + evt.costUsd;
    if (typeof evt.inputTokens === "number") usage.inputTokens = (usage.inputTokens || 0) + evt.inputTokens;
    if (typeof evt.outputTokens === "number") usage.outputTokens = (usage.outputTokens || 0) + evt.outputTokens;
  }

  async function processLine(state, plan, rawLine, stream) {
    const redacted = redactSecrets(rawLine, plan.redact || []);
    const parsed = typeof plan.parseLine === "function" ? plan.parseLine(redacted, stream) : null;
    const events = Array.isArray(parsed) && parsed.length ? parsed : [{ type: "line", text: redacted }];
    for (const evt of events) {
      accumulateUsage(state, evt);
      await appendEvent(state, { stream, ...evt });
    }
  }

  // Buffers partial lines per stream so a chunk boundary mid-line never
  // splits an event; whatever remains unterminated is flushed on exit.
  function attachOutputHandlers(state, plan, child) {
    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout?.on("data", (chunk) => {
      const text = stdoutBuf + chunk.toString("utf8");
      const lines = text.split("\n");
      stdoutBuf = lines.pop();
      for (const line of lines) processLine(state, plan, line, "stdout").catch(() => {});
    });
    child.stderr?.on("data", (chunk) => {
      const text = stderrBuf + chunk.toString("utf8");
      const lines = text.split("\n");
      stderrBuf = lines.pop();
      for (const line of lines) processLine(state, plan, line, "stderr").catch(() => {});
    });

    return {
      async flush() {
        if (stdoutBuf) await processLine(state, plan, stdoutBuf, "stdout");
        if (stderrBuf) await processLine(state, plan, stderrBuf, "stderr");
      }
    };
  }

  async function finishRun(state, { status, exitCode = null, signal = null, error = null }) {
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = null;
    }
    // Write the exit event before flipping the status: anyone who sees a
    // terminal status can then rely on the log being complete.
    await appendEvent(state, { stream: "system", type: "system", text: `Exited with code ${exitCode}` });
    state.meta.status = status;
    state.meta.exitCode = exitCode;
    state.meta.signal = signal;
    state.meta.endedAt = new Date().toISOString();
    if (error) state.meta.error = error;
    await enqueue(state, () => persistMeta(state));
    await enqueue(state, () => {
      broadcast(state, { type: "end", status: state.meta.status });
    });
    // Best-effort plan cleanup (e.g. an adapter deleting its query file).
    // Never allowed to throw: cleanup failing must not affect run status.
    if (typeof state.plan?.onExit === "function") {
      try {
        await state.plan.onExit(state.meta);
      } catch {
        // cleanup is best-effort only
      }
    }
  }

  async function startRun(plan) {
    await validatePlan(plan);
    if (countActive() >= maxConcurrent) throw tooManyRunsError();
    if (plan.args.some((arg) => containsBlockedFlag(arg))) throw blockedFlagError();
    if (hasCursorForceFlag(plan)) throw blockedFlagError();

    const dir = await runsDir();
    const id = generateRunId();
    const commandPreview = buildCommandPreview(plan);
    const meta = {
      id,
      agentId: plan.agentId || null,
      kind: plan.kind || "agent",
      title: plan.title || "",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
      pid: null,
      cwd: plan.cwd,
      commandPreview,
      truncated: false,
      usage: {},
      error: null
    };
    const state = {
      meta,
      dir,
      plan,
      subscribers: new Set(),
      nextSeq: 0,
      storedBytes: 0,
      truncated: false,
      child: null,
      timeoutHandle: null,
      queue: Promise.resolve()
    };
    // Resolves once the exit has been fully recorded, so stop() can mean
    // "stopped and logged" rather than "signal sent".
    state.done = new Promise((resolve) => {
      state.markDone = resolve;
    });
    runs.set(id, state);
    await persistMeta(state);

    const env = withSiblingNodePath(plan.command, childEnv(process.env, plan.env || {}));
    const stdinMode = typeof plan.stdin === "string" ? "pipe" : "ignore";

    let child;
    try {
      child = spawnTracked(plan.command, plan.args, {
        cwd: plan.cwd,
        env,
        stdio: [stdinMode, "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      await finishRun(state, { status: "failed", error: error?.message || "Failed to start the process." });
      return { ...state.meta };
    }

    state.child = child;
    meta.pid = child.pid;
    meta.status = "running";
    meta.startedAt = new Date().toISOString();
    // Everything up to the listeners below must stay synchronous: a fast
    // process can exit while we await disk writes, and "close" fires only
    // once, so a listener attached after an await can miss it and leave the
    // run "running" forever. Queue the writes now (keeping "Started" first
    // in the log) and await them only after the listeners are attached.
    const startWrites = Promise.all([
      enqueue(state, () => persistMeta(state)),
      appendEvent(state, { stream: "system", type: "system", text: `Started ${commandPreview}` })
    ]);

    const output = attachOutputHandlers(state, plan, child);

    // Only flag the timeout here; the status flips to "timed_out" in the close
    // handler, once the process tree is really gone and output is flushed.
    state.timeoutHandle = setTimeout(() => {
      state.timedOut = true;
      appendEvent(state, { stream: "system", type: "system", text: "Run timed out." }).catch(() => {});
      killProcessTree(child.pid).catch(() => {});
    }, clampTimeoutMs(plan.timeoutMs));

    // Node emits "error" (not a thrown exception) for failures like a
    // missing executable; "close" may never follow in that case, so both
    // paths finish the run, guarded so only the first one settles it.
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      output.flush().catch(() => {});
      finishRun(state, { status: "failed", error: error?.message || "Process error." })
        .catch(() => {})
        .finally(() => state.markDone());
    });

    // An event-listener's returned promise is never awaited by Node, so any
    // rejection here (e.g. the run folder was removed) would be an unhandled
    // rejection that can crash the server. Storage failures are contained and
    // subscribers are still told the run ended.
    child.once("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      try {
        await output.flush();
      } catch {
        // output storage is best-effort once the process has exited
      }
      const status = state.timedOut
        ? "timed_out"
        : state.meta.status === "stopped"
          ? "stopped"
          : code === 0
            ? "succeeded"
            : "failed";
      try {
        await finishRun(state, { status, exitCode: code, signal });
      } catch {
        state.meta.status = status;
        broadcast(state, { type: "end", status });
      } finally {
        state.markDone();
      }
    });

    if (stdinMode === "pipe") {
      child.stdin.on("error", () => {
        // the child may exit before reading its input; that is not our error
      });
      child.stdin.write(plan.stdin);
      child.stdin.end();
    }

    await startWrites.catch(() => {});

    return { ...meta };
  }

  async function stopRun(id) {
    const state = runs.get(id);
    if (!state) {
      const dir = await runsDir();
      return readRunMeta(dir, id);
    }
    if (!ACTIVE_STATUSES.has(state.meta.status)) {
      return { ...state.meta };
    }
    state.meta.status = "stopped";
    await appendEvent(state, { stream: "system", type: "system", text: "Stop requested." });
    await enqueue(state, () => persistMeta(state));
    if (state.child?.pid) await killProcessTree(state.child.pid);
    await waitUntilDone(state);
    return { ...state.meta };
  }

  // Bounded: a process that somehow never reports "close" must not hang stop().
  function waitUntilDone(state, timeoutMs = 3000) {
    let timer;
    return Promise.race([
      state.done,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })
    ]).finally(() => clearTimeout(timer));
  }

  async function getRun(id) {
    const state = runs.get(id);
    if (state) return { ...state.meta };
    const dir = await runsDir();
    return readRunMeta(dir, id);
  }

  async function listRuns({ limit = 100, agentId, kind } = {}) {
    const dir = await runsDir();
    const ids = await listRunIds(dir);
    const metas = [];
    for (const runId of ids) {
      const state = runs.get(runId);
      const meta = state ? state.meta : await readRunMeta(dir, runId);
      if (meta) metas.push(meta);
    }
    const filtered = metas.filter(
      (meta) => (!agentId || meta.agentId === agentId) && (!kind || meta.kind === kind)
    );
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const cappedLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return filtered.slice(0, cappedLimit);
  }

  async function readEvents(id, fromSeq = 0) {
    const state = runs.get(id);
    const dir = state ? state.dir : await runsDir();
    return readRunEvents(dir, id, fromSeq);
  }

  function subscribe(id, onEvent) {
    const state = runs.get(id);
    if (!state) return () => {};
    state.subscribers.add(onEvent);
    return () => state.subscribers.delete(onEvent);
  }

  async function recoverStaleRuns() {
    const dir = await runsDir();
    const ids = await listRunIds(dir);
    for (const id of ids) {
      if (runs.has(id)) continue; // owned by this process already
      const meta = await readRunMeta(dir, id);
      if (!meta || !ACTIVE_STATUSES.has(meta.status)) continue;
      meta.status = "interrupted";
      meta.endedAt = meta.endedAt || new Date().toISOString();
      await writeRunMeta(dir, meta);
      const seq = await countRunEvents(dir, id);
      const event = {
        seq,
        t: new Date().toISOString(),
        stream: "system",
        type: "system",
        text: "Run marked interrupted after a server restart."
      };
      await appendRunEventLine(dir, id, `${JSON.stringify(event)}\n`);
    }
  }

  async function stopAll() {
    const active = [...runs.values()].filter((state) => ACTIVE_STATUSES.has(state.meta.status));
    await Promise.all(
      active.map(async (state) => {
        state.meta.status = "stopped";
        await appendEvent(state, { stream: "system", type: "system", text: "Agent OS is shutting down." });
        await enqueue(state, () => persistMeta(state));
        if (state.child?.pid) await killProcessTree(state.child.pid);
        await waitUntilDone(state);
      })
    );
  }

  return {
    startRun,
    stopRun,
    getRun,
    listRuns,
    readEvents,
    subscribe,
    recoverStaleRuns,
    stopAll
  };
}

let defaultManager = null;

export function getRunManager() {
  if (!defaultManager) defaultManager = createRunManager();
  return defaultManager;
}
