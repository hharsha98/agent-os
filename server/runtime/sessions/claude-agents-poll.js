// Claude Code's own list of its sessions, `claude agents --json`, as the fallback signal source
// (spec SP4 Signals, Claude Code row: "Fallback: ... `claude agents --json` polling every 10 s";
// rulings R12 and K19). It backs up Claude's hooks when they are kept out, not trusted yet, or
// silent (Esc sends no Stop hook). One poller serves every live Claude Code session together:
//   - one call at a time, the next CLAUDE_AGENTS_POLL_MS after the last one ended, and only while
//     at least one Claude Code agent session is live (the manager's onLiveChange wakes it again);
//   - each call is argv only (runCli, never a shell), with the command, folder and environment of
//     a live Claude Code session minus Agent OS's own variables (never the server's environment,
//     which holds AGENT_OS_TOKEN), and is cut at CLAUDE_AGENTS_CALL_LIMIT_MS;
//   - the answer is read for each session's status and then dropped. Its signals are hints
//     (source "poll"): waiting raises "Waiting for you", busy shows a new turn (or ends a waiting
//     this poller raised), idle ends a live turn.
// Spike S1 checks that the call never starts Claude's supervisor. If it would, CLAUDE_AGENTS_POLL_ON
// becomes false and nothing here runs (OSC and BEL on the mirror stay on for every agent).
import { cleanAlertText } from "./signals.js";
import { runCli as defaultRunCli } from "./soft-stop.js";

export const CLAUDE_AGENTS_POLL_ON = true;
export const CLAUDE_AGENTS_POLL_MS = 10000;
export const CLAUDE_AGENTS_CALL_LIMIT_MS = 5000;

// The spec's own words for a session that waits (K19).
const POLL_WAITING_TEXT = "Waiting for you";
const STATUSES = new Set(["waiting", "busy", "idle"]);
const WAITING_FOR_MAX = 60;
// A waiting or idle answer is dropped for a session the person typed into from this long before the
// call started: the answer can be older than their reply (the rule of Claude's backup Notification
// hook, K6 and BACKUP_WAITING_QUIET_MS in hooks.js).
const INPUT_QUIET_MS = 3000;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The list `claude agents --json` prints: an array (agent-view docs), or one inside { sessions }
// or { agents }, as findBackgroundAgent in soft-stop.js also accepts. Interactive sessions only:
// a background task (/bg) of the same conversation is not the terminal.
function entriesOf(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sessions) ? parsed.sessions : Array.isArray(parsed?.agents) ? parsed.agents : [];
  return list.filter((entry) => isPlainObject(entry) && entry.kind !== "background" && STATUSES.has(entry.status));
}

function sameSession(entry, session) {
  const id = typeof session.agentSessionId === "string" ? session.agentSessionId.toLowerCase() : "";
  if (id && typeof entry.sessionId === "string" && entry.sessionId.toLowerCase() === id) return true;
  return Number.isInteger(session.pid) && session.pid > 0 && Number(entry.pid) === session.pid;
}

export function mapClaudeAgents(text, sessions) {
  const entries = entriesOf(text);
  const out = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const entry = entries.find((candidate) => sameSession(candidate, session));
    if (!entry) continue;
    const waitingFor = entry.status === "waiting" && typeof entry.waitingFor === "string" ? cleanAlertText(entry.waitingFor, WAITING_FOR_MAX) : "";
    out.push({ id: session.id, status: entry.status, waitingFor: waitingFor || null });
  }
  return out;
}

// The session's own environment without Agent OS's own names: the hook address, token and
// session id belong to one session, and this call is for all of them.
function callEnv(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key]) => !key.startsWith("AGENT_OS_")));
}

export function createClaudeAgentsPoller({
  manager,
  runCli = defaultRunCli,
  intervalMs = CLAUDE_AGENTS_POLL_MS,
  limitMs = CLAUDE_AGENTS_CALL_LIMIT_MS,
  enabled = CLAUDE_AGENTS_POLL_ON
} = {}) {
  if (!enabled) return { stop() {} };
  let stopped = false;
  let timer = null;
  let polling = false;
  let inFlight = null;

  const liveClaude = () => manager.liveAgentSessions("claude").filter((session) => session.status !== "exited");

  function schedule() {
    if (stopped || polling || timer || liveClaude().length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void pollOnce();
    }, intervalMs);
    timer.unref?.();
  }

  // K19, for each session the answer names (the table in Task X2b's Interfaces).
  function apply(results, sessions, startedAt) {
    for (const { id, status } of results) {
      const session = sessions.find((candidate) => candidate.id === id);
      if (!session) continue;
      const ownWaiting = session.status === "waiting" && session.alert?.source === "poll";
      // The answer can be older than the person's last reply: a waiting or an idle computed before
      // they typed must not undo it. (0 or null means no input yet.)
      const typedRecently = Number.isFinite(session.lastInputAt) && session.lastInputAt >= startedAt - INPUT_QUIET_MS;
      if (status === "waiting") {
        // Never over a waiting already shown (its words are better), never on a held session, and
        // never just after the person typed there.
        if (session.status === "waiting" || session.status === "held" || typedRecently) continue;
        manager.applySignal(id, { kind: "waiting", text: POLL_WAITING_TEXT, source: "poll" });
      } else if (status === "busy") {
        if (ownWaiting) manager.applySignal(id, { kind: "resolved", source: "poll" });
        else manager.markNewTurn(id);
      } else if ((session.status === "live" || ownWaiting) && !typedRecently) {
        manager.applySignal(id, { kind: "turn_done", source: "poll" });
      }
    }
  }

  async function pollOnce() {
    if (stopped) return;
    const first = liveClaude()[0];
    if (!first?.profile?.command) {
      schedule();
      return;
    }
    polling = true;
    const startedAt = Date.now();
    const limit = new AbortController();
    inFlight = limit;
    const cut = setTimeout(() => limit.abort(), limitMs);
    try {
      const result = await runCli(first.profile.command, ["agents", "--json"], {
        env: callEnv(first.profile.env),
        cwd: first.profile.cwd,
        signal: limit.signal
      });
      if (!stopped && result?.ok) {
        const sessions = liveClaude();
        apply(mapClaudeAgents(result.stdout, sessions), sessions, startedAt);
      }
    } catch {
      // runCli never rejects; an injected one that does loses only this poll
    } finally {
      clearTimeout(cut);
      inFlight = null;
      polling = false;
      schedule();
    }
  }

  const unsubscribe = manager.onLiveChange(() => schedule());
  schedule();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      inFlight?.abort();
      unsubscribe?.();
    }
  };
}
