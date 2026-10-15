// One place that tears everything down: the scheduler loop, every run, every
// task other modules registered with registerShutdownTask() (the terminal
// sessions, from SP3), every tracked child process and pid, and the
// short-lived live-chat children, before the HTTP server closes. Reused by
// the signal handlers and the desktop shell's stdin line below, and by tests
// that check cleanup directly.
import readline from "node:readline";
import { stopSchedulerLoop } from "./scheduler.js";
import { killAllTracked, killAllTrackedSync } from "./process-tree.js";
import { activeLiveChatChildren } from "./live-chat.js";
import { getRunManager } from "./runs/run-manager.js";

// A quit ends the process this long after it starts, whatever is still
// running (spec SP3, "Persistence, quit and Stop": 8 s, inside the desktop
// shell's 10 s QUIT_GRACE).
export const HARD_EXIT_MS = 8000;
// Each shutdown task gets at most this long, so one stuck task cannot hold the
// kill sweep and server.close() past the hard exit. The sessions task (S7)
// caps itself at the same 7 s.
export const SHUTDOWN_TASK_LIMIT_MS = 7000;
// The desktop shell writes this exact line to the server's stdin to quit
// gracefully on every OS (planning decision Q4).
export const STDIN_SHUTDOWN_LINE = "AGENT_OS_SHUTDOWN";

const shutdownTasks = new Map();

// Registers fn to run at shutdown, in parallel with the runs' own stop and
// with every other task, and BEFORE the kill sweep (so a task can record why
// its processes end before anything is killed). A second registration under
// the same name replaces the first. Returns a function that unregisters it.
export function registerShutdownTask(name, fn) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("registerShutdownTask needs a name");
  if (typeof fn !== "function") throw new TypeError("registerShutdownTask needs a function");
  shutdownTasks.set(name, fn);
  return () => {
    if (shutdownTasks.get(name) === fn) shutdownTasks.delete(name);
  };
}

function runGuarded(name, fn, limitMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // Not unref()'d: a stuck task must not keep shutdown waiting, but the
    // timer itself has to fire.
    const timer = setTimeout(() => {
      console.error(`Shutdown step "${name}" took longer than ${limitMs} ms; continuing without it.`);
      finish();
    }, limitMs);
    Promise.resolve()
      .then(() => fn())
      .catch((error) => console.error(`Shutdown step "${name}" failed: ${error?.message || error}`))
      .finally(finish);
  });
}

export async function shutdown({ server, taskLimitMs = SHUTDOWN_TASK_LIMIT_MS } = {}) {
  try {
    stopSchedulerLoop();
  } catch {
    // best effort
  }

  // Runs are marked "stopped" (so their metadata says why they ended) and
  // the registered tasks run, all in parallel and all before the raw kill
  // sweep below.
  await Promise.all([
    (async () => {
      try {
        await getRunManager().stopAll();
      } catch {
        // best effort
      }
    })(),
    ...[...shutdownTasks.entries()].map(([name, fn]) => runGuarded(name, fn, taskLimitMs))
  ]);

  await killAllTracked();

  for (const child of activeLiveChatChildren) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  activeLiveChatChildren.clear();

  if (server) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(finish);
      setTimeout(finish, 500).unref?.();
    });
  }
}

export function installShutdownHandlers(server, { hardExitMs = HARD_EXIT_MS, taskLimitMs = SHUTDOWN_TASK_LIMIT_MS } = {}) {
  let triggered = false;
  const trigger = () => {
    if (triggered) return;
    triggered = true;
    const hardExit = setTimeout(() => process.exit(0), hardExitMs);
    hardExit.unref?.();
    shutdown({ server, taskLimitMs }).finally(() => process.exit(0));
  };
  process.on("SIGTERM", trigger);
  process.on("SIGINT", trigger);
  if (process.platform === "win32") process.on("SIGBREAK", trigger);
  // The desktop shell (AGENT_OS_STDIN_SHUTDOWN=1, stdin piped) quits the
  // server by writing one line, the same on every OS; on Windows there is no
  // other graceful way. End of input means the shell itself is gone. Without
  // the variable, stdin is never read.
  if (process.env.AGENT_OS_STDIN_SHUTDOWN === "1") {
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    lines.on("line", (line) => {
      if (line.trim() === STDIN_SHUTDOWN_LINE) trigger();
    });
    lines.on("close", trigger);
    // A read error (EIO, ECONNRESET) is re-emitted by readline; with no
    // listener it would crash the server before shutdown() ran, so the sessions
    // would never record that Agent OS quit. Treat it like the shell going away.
    lines.on("error", (error) => {
      console.error(`Reading stdin failed: ${error?.message || error}`);
      trigger();
    });
  }
  // process.on("exit") handlers must be synchronous, so this is a
  // best-effort SIGKILL sweep in case the async shutdown() above never ran.
  process.on("exit", () => {
    killAllTrackedSync();
    for (const child of activeLiveChatChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}
