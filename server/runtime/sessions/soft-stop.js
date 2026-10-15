// The agent's own soft stop: step 1 of the Stop sequence (spec "Persistence,
// quit and Stop"). It never writes into the session's terminal. The whole step
// has a hard limit of 2 s: when it runs out, every CLI call it started is
// killed and the Stop sequence moves on to killing the process tree.
//
// - Claude Code: `claude agents --json`; when this session is listed there as
//   a background session (moved to Claude's own background with /bg), then
//   `claude stop <id>`.
// - OpenClaw: until spike S5 confirms the Gateway abort command, no CLI call,
//   and the honest note below.
// - Every other agent, and every update session: no soft stop.
//
// Each CLI call gets the session's own environment and folder (decision Q11),
// never the server's own environment, which holds AGENT_OS_TOKEN.
import { killProcessTree, spawnTracked } from "../process-tree.js";

export const SOFT_STOP_LIMIT_MS = 2000;
export const OPENCLAW_STOP_NOTE = "Stopped the terminal. OpenClaw may still be finishing its last step.";
const MAX_CLI_OUTPUT_CHARS = 1024 * 1024;
const CLI_KILL_GRACE_MS = 500;
// After the program has exited: how long its last bytes get to arrive.
const CLI_FLUSH_MS = 50;
// What may be passed back to `claude stop`: an id, never anything that could
// read as an option.
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Finds this session in `claude agents --json` output: an entry of kind
// "background" whose session id or pid is this session's. The live fidelity
// spike (S0, the /bg item) records the real shape; anything this does not
// recognise means "not found", and Stop goes on to kill the terminal.
export function findBackgroundAgent(text, { agentSessionId = null, pid = null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.agents)
      ? parsed.agents
      : Array.isArray(parsed?.sessions)
        ? parsed.sessions
        : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (String(entry.kind ?? entry.type ?? "").toLowerCase() !== "background") continue;
    const ids = [entry.id, entry.sessionId, entry.session_id].filter((value) => typeof value === "string" && value);
    const sameSession = Boolean(agentSessionId) && ids.includes(agentSessionId);
    const samePid = Number.isInteger(pid) && pid > 0 && Number(entry.pid) === pid;
    if (!sameSession && !samePid) continue;
    return ids.find((value) => SAFE_AGENT_ID.test(value)) || null;
  }
  return null;
}

// Runs one CLI call (argv only, never a shell, no input) with exactly the
// environment it is handed. Never rejects: { ok, code, aborted, stdout }.
// When `signal` aborts, the call's whole process tree is killed, unless the
// call has already been seen exiting (its pid may belong to another process by
// then). The call is answered when the program EXITS (with the output
// collected so far, after a short tick for the last bytes to arrive), not only
// when its output closes: a helper the program left behind can hold the output
// open long after the program itself is gone. `spawn` is injectable for tests.
export function runCli(command, args, { env, cwd, signal, onSpawn, spawn = spawnTracked } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, code: null, aborted: true, stdout: "" });
      return;
    }
    let child;
    try {
      child = spawn(command, args, { cwd, env: env || {}, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve({ ok: false, code: null, aborted: false, stdout: "" });
      return;
    }
    let stdout = "";
    let settled = false;
    let exited = false;
    let flushTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(flushTimer);
      signal?.removeEventListener("abort", onAbort);
      // Let go of the output pipe: a helper that still holds the other end
      // must not keep this server's side open.
      child.stdout?.destroy();
      resolve(result);
    };
    function onAbort() {
      if (child.pid && !exited) killProcessTree(child.pid, { graceMs: CLI_KILL_GRACE_MS }).catch(() => {});
      finish({ ok: false, code: null, aborted: true, stdout });
    }
    // First, so that an 'error' (also one that comes later) is always handled.
    child.on("error", () => finish({ ok: false, code: null, aborted: false, stdout }));
    // Out of file handles (EMFILE, ENFILE): node reports the failure with an
    // 'error' event and makes no output stream at all.
    if (!child.stdout) {
      finish({ ok: false, code: null, aborted: false, stdout: "" });
      return;
    }
    if (child.pid) onSpawn?.(child.pid);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_CLI_OUTPUT_CHARS) stdout += chunk;
    });
    child.once("exit", (code) => {
      exited = true;
      if (settled) return;
      flushTimer = setTimeout(() => finish({ ok: code === 0, code, aborted: false, stdout }), CLI_FLUSH_MS);
    });
    child.once("close", (code) => finish({ ok: code === 0, code, aborted: false, stdout }));
  });
}

export async function runSoftStop({
  softStop,
  command,
  env,
  cwd,
  agentSessionId = null,
  pid = null,
  limitMs = SOFT_STOP_LIMIT_MS,
  run = runCli,
  onSpawn
} = {}) {
  if (softStop === "openclaw-abort") return { outcome: "terminal-only", note: OPENCLAW_STOP_NOTE };
  if (softStop !== "claude-bg" || !command) return { outcome: "none", note: null };

  const controller = new AbortController();
  const timedOut = new Promise((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({ outcome: "timeout", note: null }), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), limitMs);
  const options = { env, cwd, signal: controller.signal, onSpawn };
  const work = (async () => {
    const listed = await run(command, ["agents", "--json"], options);
    if (controller.signal.aborted) return { outcome: "timeout", note: null };
    const backgroundId = findBackgroundAgent(listed?.stdout, { agentSessionId, pid });
    if (!backgroundId) return { outcome: "none", note: null };
    const stopped = await run(command, ["stop", backgroundId], options);
    if (controller.signal.aborted) return { outcome: "timeout", note: null };
    return { outcome: stopped?.ok ? "stopped-background" : "failed", note: null };
  })().catch(() => ({ outcome: "failed", note: null }));
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}
