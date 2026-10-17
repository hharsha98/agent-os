// Shutdown (spec SP3, "Persistence, quit and Stop"; planning decision Q4):
// the 8 second hard exit, the shutdown tasks other modules register (the
// terminal sessions, from S7), and the line the desktop shell writes to the
// server's stdin to quit gracefully on every OS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnTracked } from "../server/runtime/process-tree.js";
import {
  HARD_EXIT_MS,
  SHUTDOWN_TASK_LIMIT_MS,
  STDIN_SHUTDOWN_LINE,
  registerShutdownTask,
  shutdown
} from "../server/runtime/shutdown.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
// The only folders besides the fakes' own on a test server's PATH (R16).
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectLogs(child) {
  const ref = { text: "" };
  child.stdout?.on("data", (chunk) => {
    ref.text += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    ref.text += chunk;
  });
  return ref;
}

async function waitForReady(child, logsRef, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (/AGENT_OS_READY:\d+/.test(logsRef.text)) return;
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode}):\n${logsRef.text.slice(-2000)}`);
    await delay(100);
  }
  throw new Error(`server never printed AGENT_OS_READY:\n${logsRef.text.slice(-2000)}`);
}

// Resolves { code, signal } when the child exits, or null after ms.
function exitWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await exitWithin(child, 3000))) child.kill("SIGKILL");
}

// The real server with a temp home, set up as every test server that could
// start a session (R15, R16): W1's stand-in login shell, so neither the
// developer's own shell setup nor a real login sh (whose path_helper puts
// /usr/local/bin and /opt/homebrew/bin first) runs for the sessions'
// login-shell lookup; and on PATH the six fake agents, then the system
// folders only, so agent detection finds a fake before it searches
// /opt/homebrew/bin and /usr/local/bin. The shims are POSIX only.
async function startServer(home, extraEnv = {}) {
  const fakeBin = path.join(home, "fake-bin");
  if (!isWindows) await makeFakeAgentBin(fakeBin);
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      AGENT_OS_HOME: home,
      AGENT_OS_TOKEN: "t",
      HERMES_AGENT_OS_SCHEDULER: "0",
      HOME: home,
      USERPROFILE: home,
      SHELL: FAKE_LOGIN_SHELL,
      PATH: [...(isWindows ? [] : [fakeBin]), ...SYSTEM_PATH_DIRS].join(path.delimiter),
      AGENT_OS_STDIN_SHUTDOWN: undefined,
      ...extraEnv
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const logs = collectLogs(child);
  await waitForReady(child, logs);
  return { child, logs };
}

async function withTempHome(fn) {
  // Real path: on macOS os.tmpdir() sits behind a symlink (Global Constraints).
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-shutdown-")));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("shutdown tasks", () => {
  test("the hard exit is 8 seconds, and each shutdown task gets at most 7 seconds", () => {
    assert.equal(HARD_EXIT_MS, 8000);
    assert.equal(SHUTDOWN_TASK_LIMIT_MS, 7000);
    assert.equal(STDIN_SHUTDOWN_LINE, "AGENT_OS_SHUTDOWN");
  });

  test("registerShutdownTask refuses a missing name or a missing function", () => {
    assert.throws(() => registerShutdownTask("", () => {}), TypeError);
    assert.throws(() => registerShutdownTask("   ", () => {}), TypeError);
    assert.throws(() => registerShutdownTask("sessions", null), TypeError);
  });

  test("shutdown() runs every registered task, all at the same time", async () => {
    const ran = [];
    const slow = (name) => async () => {
      await delay(1000);
      ran.push(name);
    };
    const offA = registerShutdownTask("test-a", slow("a"));
    const offB = registerShutdownTask("test-b", slow("b"));
    try {
      const started = Date.now();
      await shutdown({});
      const elapsed = Date.now() - started;
      assert.deepEqual(ran.sort(), ["a", "b"]);
      assert.ok(elapsed >= 950, `took ${elapsed} ms`);
      assert.ok(elapsed < 1900, `took ${elapsed} ms, so the tasks ran one after the other`);
    } finally {
      offA();
      offB();
    }
  });

  test("a task that fails does not stop the others or the shutdown", async () => {
    let otherRan = false;
    const offA = registerShutdownTask("test-throws", () => {
      throw new Error("boom");
    });
    const offB = registerShutdownTask("test-rejects", async () => {
      throw new Error("boom again");
    });
    const offC = registerShutdownTask("test-fine", () => {
      otherRan = true;
    });
    try {
      await shutdown({});
      assert.equal(otherRan, true);
    } finally {
      offA();
      offB();
      offC();
    }
  });

  test("a task that never finishes is cut off at the limit", async () => {
    const off = registerShutdownTask("test-hangs", () => new Promise(() => {}));
    try {
      const started = Date.now();
      await shutdown({ taskLimitMs: 300 });
      assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
    } finally {
      off();
    }
  });

  test(
    "tasks run before the kill sweep, so they still see the processes they will stop",
    { skip: isWindows ? "process groups are POSIX-only" : false },
    async () => {
      const child = spawnTracked(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      let aliveWhenTaskRan = null;
      const off = registerShutdownTask("test-order", () => {
        aliveWhenTaskRan = isAlive(child.pid);
      });
      try {
        await shutdown({});
        assert.equal(aliveWhenTaskRan, true);
        assert.equal(isAlive(child.pid), false, "the kill sweep still ran afterwards");
      } finally {
        off();
      }
    }
  );

  test("registering the same name again replaces the task, and the returned function unregisters it", async () => {
    let first = 0;
    let second = 0;
    const offFirst = registerShutdownTask("test-same", () => {
      first += 1;
    });
    const offSecond = registerShutdownTask("test-same", () => {
      second += 1;
    });
    offFirst(); // stale: must not remove the newer task
    await shutdown({});
    assert.deepEqual([first, second], [0, 1]);
    offSecond();
    await shutdown({});
    assert.deepEqual([first, second], [0, 1]);
  });
});

describe("hard exit", () => {
  test(
    "the hard exit ends the process even when a shutdown task never finishes",
    { skip: isWindows ? "Windows has no SIGTERM handler to trigger" : false },
    async () => {
      await withTempHome(async (home) => {
        const script = path.join(home, "hang.mjs");
        const shutdownUrl = pathToFileURL(path.join(root, "server", "runtime", "shutdown.js")).href;
        await writeFile(
          script,
          [
            `import { installShutdownHandlers, registerShutdownTask } from ${JSON.stringify(shutdownUrl)};`,
            'registerShutdownTask("hangs", () => new Promise(() => {}));',
            "installShutdownHandlers(undefined, { hardExitMs: 1000, taskLimitMs: 60000 });",
            'console.log("READY");',
            "setInterval(() => {}, 1000);"
          ].join("\n")
        );
        const child = spawn(process.execPath, [script], {
          cwd: home,
          env: { ...process.env, AGENT_OS_HOME: home, HOME: home, USERPROFILE: home, AGENT_OS_STDIN_SHUTDOWN: undefined },
          stdio: ["ignore", "pipe", "pipe"]
        });
        const logs = collectLogs(child);
        try {
          await (async () => {
            const deadline = Date.now() + 10000;
            while (!logs.text.includes("READY")) {
              if (Date.now() > deadline) throw new Error(`no READY:\n${logs.text}`);
              await delay(50);
            }
          })();
          const started = Date.now();
          child.kill("SIGTERM");
          const exit = await exitWithin(child, 5000);
          const elapsed = Date.now() - started;
          assert.ok(exit, "the process did not exit");
          assert.equal(exit.code, 0);
          assert.ok(elapsed >= 900, `exited after ${elapsed} ms, before the hard exit`);
        } finally {
          await killChild(child);
        }
      });
    }
  );
});

describe("quit through stdin (the desktop shell, every OS)", () => {
  test("with AGENT_OS_STDIN_SHUTDOWN=1, the line AGENT_OS_SHUTDOWN shuts the server down", async () => {
    await withTempHome(async (home) => {
      const { child } = await startServer(home, { AGENT_OS_STDIN_SHUTDOWN: "1" });
      try {
        const started = Date.now();
        child.stdin.write(`${STDIN_SHUTDOWN_LINE}\n`);
        const exit = await exitWithin(child, HARD_EXIT_MS + 500);
        assert.ok(exit, "the server did not exit within the hard exit");
        assert.equal(exit.code, 0);
        assert.ok(Date.now() - started <= 3500, "an idle server has nothing to stop, so it exits quickly");
      } finally {
        await killChild(child);
      }
    });
  });

  test("end of input on stdin also shuts it down (the desktop shell is gone)", async () => {
    await withTempHome(async (home) => {
      const { child } = await startServer(home, { AGENT_OS_STDIN_SHUTDOWN: "1" });
      try {
        child.stdin.end();
        const exit = await exitWithin(child, HARD_EXIT_MS + 500);
        assert.ok(exit, "the server did not exit");
        assert.equal(exit.code, 0);
      } finally {
        await killChild(child);
      }
    });
  });

  test("the quit line still works with a Windows line ending and spaces around it", async () => {
    await withTempHome(async (home) => {
      const { child } = await startServer(home, { AGENT_OS_STDIN_SHUTDOWN: "1" });
      try {
        // An exact compare would miss this: the "\r" and the spaces belong to the line.
        child.stdin.write(`  ${STDIN_SHUTDOWN_LINE} \r\n`);
        const exit = await exitWithin(child, HARD_EXIT_MS + 500);
        assert.ok(exit, "the server did not exit on a padded quit line with a CRLF ending");
        assert.equal(exit.code, 0);
      } finally {
        await killChild(child);
      }
    });
  });

  test(
    "a stdin read error starts the graceful shutdown instead of crashing the server",
    { skip: isWindows ? "stdin pipes behave differently on Windows" : false },
    async () => {
      await withTempHome(async (home) => {
        const script = path.join(home, "stdin-error.mjs");
        const shutdownUrl = pathToFileURL(path.join(root, "server", "runtime", "shutdown.js")).href;
        await writeFile(
          script,
          [
            `import { installShutdownHandlers, registerShutdownTask } from ${JSON.stringify(shutdownUrl)};`,
            'registerShutdownTask("marks", () => { console.log("GRACEFUL_SHUTDOWN_RAN"); });',
            "installShutdownHandlers(undefined, { hardExitMs: 5000 });",
            'console.log("READY");',
            // What an EIO or ECONNRESET on the pipe looks like to readline.
            'setTimeout(() => process.stdin.destroy(new Error("simulated stdin failure")), 100);',
            "setInterval(() => {}, 1000);"
          ].join("\n")
        );
        const child = spawn(process.execPath, [script], {
          cwd: home,
          env: { ...process.env, AGENT_OS_HOME: home, HOME: home, USERPROFILE: home, AGENT_OS_STDIN_SHUTDOWN: "1" },
          stdio: ["pipe", "pipe", "pipe"]
        });
        const logs = collectLogs(child);
        try {
          const exit = await exitWithin(child, 4000);
          assert.ok(exit, `the process did not exit, so not even the hard exit ran:\n${logs.text}`);
          assert.equal(exit.code, 0, `it crashed instead of shutting down:\n${logs.text}`);
          assert.match(logs.text, /GRACEFUL_SHUTDOWN_RAN/, "the shutdown tasks did not run");
          assert.match(logs.text, /Reading stdin failed: simulated stdin failure/);
        } finally {
          await killChild(child);
        }
      });
    }
  );

  test("any other line is ignored", async () => {
    await withTempHome(async (home) => {
      const { child } = await startServer(home, { AGENT_OS_STDIN_SHUTDOWN: "1" });
      try {
        child.stdin.write("hello\nAGENT_OS_SHUTDOWN_PLEASE\n");
        assert.equal(await exitWithin(child, 1500), null, "the server stopped on a line that is not the quit line");
        child.stdin.write(`${STDIN_SHUTDOWN_LINE}\n`);
        assert.ok(await exitWithin(child, HARD_EXIT_MS + 500), "the quit line still works afterwards");
      } finally {
        await killChild(child);
      }
    });
  });

  test("without AGENT_OS_STDIN_SHUTDOWN, stdin is never read", async () => {
    await withTempHome(async (home) => {
      const { child } = await startServer(home);
      try {
        child.stdin.write(`${STDIN_SHUTDOWN_LINE}\n`);
        child.stdin.end();
        assert.equal(await exitWithin(child, 1500), null, "the server must keep running");
      } finally {
        await killChild(child);
      }
    });
  });
});
