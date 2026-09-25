// One place that tears everything down: the scheduler loop, every tracked
// child process (module sessions, the builder supervisor), and the short-lived
// live-chat children, before the HTTP server closes. Reused by the signal
// handlers below and by tests that want to verify cleanup directly.
import { stopSchedulerLoop } from "./scheduler.js";
import { killAllTracked, killAllTrackedSync } from "./process-tree.js";
import { activeLiveChatChildren } from "./live-chat.js";

export async function shutdown({ server } = {}) {
  try {
    stopSchedulerLoop();
  } catch {
    // best effort
  }

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

export function installShutdownHandlers(server) {
  let triggered = false;
  const trigger = () => {
    if (triggered) return;
    triggered = true;
    const hardExit = setTimeout(() => process.exit(0), 3000);
    hardExit.unref?.();
    shutdown({ server }).finally(() => process.exit(0));
  };
  process.on("SIGTERM", trigger);
  process.on("SIGINT", trigger);
  if (process.platform === "win32") process.on("SIGBREAK", trigger);
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
