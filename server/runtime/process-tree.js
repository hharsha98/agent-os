// Spawns children we can reliably clean up, and kills whole process trees
// (not just the immediate child) so a quit or restart never leaves an agent
// CLI or a supervised process running in the background.
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const trackedChildren = new Set();

// POSIX: `detached` makes the child the leader of its own process group, so a
// signal to the negative pid reaches it and anything it spawns. Windows has
// no process groups; `taskkill /T` walks the tree instead.
export function spawnTracked(command, args = [], options = {}) {
  const spawnOptions = { ...options };
  if (!isWindows) spawnOptions.detached = true;
  const child = spawn(command, args, spawnOptions);
  trackedChildren.add(child);
  child.once("exit", () => trackedChildren.delete(child));
  return child;
}

// Checks the whole process group, not just the leader: an agent can exit
// quickly while a grandchild that ignores SIGTERM keeps running.
function isAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export function killProcessTree(pid, { graceMs = 1500 } = {}) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }
    if (isWindows) {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        resolve();
        return;
      }
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    };
    // Deliberately not unref()'d: callers await this promise, and an unref'd
    // timer can let Node decide the event loop is empty and exit before it
    // fires, abandoning the still-pending promise.
    const poll = setInterval(() => {
      if (!isAlive(pid)) finish();
    }, 50);
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      // SIGKILL delivery is asynchronous; keep polling so callers can rely on
      // "resolved" meaning "gone", but never wait more than another second.
      setTimeout(finish, 1000);
    }, graceMs);
  });
}

// Used by shutdown() to clean up every session/builder child in one pass.
export async function killAllTracked({ graceMs = 1500 } = {}) {
  const children = [...trackedChildren];
  await Promise.allSettled(
    children.map((child) => (child.pid ? killProcessTree(child.pid, { graceMs }) : Promise.resolve()))
  );
  for (const child of children) trackedChildren.delete(child);
}

// Synchronous last resort for the `process.on("exit")` handler, where async
// work cannot run. Best effort: a single SIGKILL, no wait for exit.
export function killAllTrackedSync() {
  for (const child of trackedChildren) {
    try {
      if (isWindows) child.kill();
      else if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // nothing more we can do synchronously
      }
    }
  }
}
