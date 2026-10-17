// Runs an agent's own terminal program inside a real pseudo-terminal (PTY)
// with node-pty, the way Terminal.app does: argv only (never a shell), the
// environment it is given (never the server's own, which holds
// AGENT_OS_TOKEN) and the folder it is given.
//
// node-pty is a native module, so it is loaded only when a session needs it.
// A server without it (the portable test, Docker) still starts and simply
// reports that sessions can't start.
import { access, constants as fsConstants, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trackPid, untrackPid } from "../process-tree.js";
import { sessionError } from "./errors.js";

export const PTY_UNAVAILABLE_REASON = "Agent OS could not load its terminal module on this computer.";

const DEFAULT_TRACKER = Object.freeze({ trackPid, untrackPid });
const EARLY_OUTPUT_LIMIT = 1024 * 1024; // characters kept until the first listener
const PROBE_TIMEOUT_MS = 5000;
const PROBE_RETRY_MS = 30000;
// While output is paused, how often to look for a program that has ended
// (node-pty gives a paused terminal only 200 ms after the end to be read).
const PAUSED_EXIT_CHECK_MS = 50;
const realLoader = () => import("node-pty");

let loader = realLoader;
let loading = null;
let availability = null;
let probeFailedAt = 0;

function loadNodePty() {
  if (!loading) {
    loading = Promise.resolve()
      .then(() => loader())
      .then((mod) => {
        // node-pty is CommonJS: spawn sits on the namespace or on `default`.
        const pty = typeof mod?.spawn === "function" ? mod : mod?.default;
        if (typeof pty?.spawn !== "function") throw new Error("node-pty has no spawn()");
        return { ok: true, pty };
      })
      .catch((error) => ({ ok: false, error }));
  }
  return loading;
}

// Tests only: replace how node-pty is loaded. null puts the real import back.
export function setPtyLoaderForTests(fn) {
  loader = typeof fn === "function" ? fn : realLoader;
  loading = null;
  availability = null;
  probeFailedAt = 0;
}

// The probe gets only what a program needs to start, never the server's
// secrets.
function probeEnv() {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  return env;
}

// Runs `node -e "process.exit(0)"` in a PTY, which proves the whole chain
// works (on macOS that includes node-pty's spawn-helper being executable).
function probe(pty) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = pty.spawn(process.execPath, ["-e", "process.exit(0)"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: os.tmpdir(),
        env: probeEnv(),
        encoding: "utf8"
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new Error("the terminal module did not answer in time"));
    }, PROBE_TIMEOUT_MS);
    child.onData(() => {}); // keep the output flowing so the exit is reported
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      releaseConptyAfterExit(child);
      resolve(exitCode);
    });
  });
}

async function checkAvailability() {
  const loaded = await loadNodePty();
  if (!loaded.ok) return { ok: false, reason: PTY_UNAVAILABLE_REASON };
  try {
    if ((await probe(loaded.pty)) === 0) return { ok: true, reason: null };
  } catch {
    // reported below
  }
  probeFailedAt = Date.now();
  return { ok: false, reason: PTY_UNAVAILABLE_REASON };
}

// { ok: true, reason: null } or { ok: false, reason }. A module that does not
// load stays unavailable; a failed probe is tried again after 30 s, because
// it may have been a passing problem (for example too many processes).
export function ptyAvailable() {
  if (availability && probeFailedAt && Date.now() - probeFailedAt > PROBE_RETRY_MS) {
    availability = null;
    probeFailedAt = 0;
  }
  if (!availability) availability = checkAvailability();
  return availability;
}

function ptyUnavailableError() {
  const error = new Error(PTY_UNAVAILABLE_REASON);
  error.code = "pty_unavailable";
  return error;
}

function toSize(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : fallback;
}

function stringEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") clean[key] = value;
  }
  return clean;
}

// node-pty reports the signal as a number (0 when there was none).
function signalName(signal) {
  if (typeof signal === "string" && signal) return signal;
  if (!Number.isInteger(signal) || signal <= 0) return null;
  for (const [name, value] of Object.entries(os.constants.signals)) {
    if (value === signal) return name;
  }
  return String(signal);
}

function safeCall(listener, value) {
  try {
    listener(value);
  } catch (error) {
    console.error("Agent OS: a terminal listener failed:", error);
  }
}

// node-pty's spawn-helper (macOS, Linux) exits 1 without a word when the
// program is missing or not executable, or the folder is gone, so the session
// would start and end at once with no reason. Check both first.
async function canStart(command, cwd) {
  try {
    if (!(await stat(command)).isFile()) return false;
    await access(command, fsConstants.X_OK);
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}

// On Windows, when the program in a terminal ends by itself, node-pty closes
// its side but keeps the ConPTY handle and the thread that read the output
// (only its kill() lets them go), so every ended session would leave them
// behind and keep the process alive. Calling kill() once after the end frees
// them, as VS Code does; on macOS and Linux there is nothing to free.
export function releaseConptyAfterExit(child, platform = process.platform) {
  if (platform !== "win32") return false;
  setImmediate(() => {
    try {
      child.kill();
    } catch {
      // already released
    }
  });
  return true;
}

// Signal 0 sends nothing: it only asks whether the process (our own child)
// still exists. ESRCH means it is gone.
function processIsGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

export async function spawnPty({ command, args = [], cwd, env, cols = 120, rows = 32, tracker = DEFAULT_TRACKER } = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) {
    throw new TypeError("spawnPty needs the full path of the program to run.");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("spawnPty needs its arguments as a list of strings.");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError("spawnPty needs the full path of the folder to start in.");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    // Without an env, node-pty would pass on process.env, which holds AGENT_OS_TOKEN.
    throw new TypeError("spawnPty needs an explicit environment; it never passes on the server's own.");
  }
  const loaded = await loadNodePty();
  if (!loaded.ok) throw ptyUnavailableError();
  if (!(await canStart(command, cwd))) {
    throw sessionError(
      500,
      "spawn_failed",
      `Agent OS couldn't start ${path.basename(command)}. Check that it is installed and that the folder still exists.`
    );
  }

  const childEnv = stringEnv(env);
  let child;
  try {
    child = loaded.pty.spawn(command, [...args], {
      name: childEnv.TERM || "xterm-256color",
      cols: toSize(cols, 120, 500),
      rows: toSize(rows, 32, 200),
      cwd,
      env: childEnv,
      encoding: "utf8"
    });
  } catch (error) {
    throw sessionError(500, "spawn_failed", `Could not start ${path.basename(command)}: ${error?.message || error}`);
  }

  const pid = child.pid;
  const dataListeners = new Set();
  const exitListeners = new Set();
  let early = [];
  let earlyChars = 0;
  let earlyFull = false;
  let exitInfo = null;
  let pauseWatch = null;
  let ended = false; // the program is gone, though node-pty has not said so yet

  child.onData((chunk) => {
    if (dataListeners.size > 0) {
      for (const listener of [...dataListeners]) safeCall(listener, chunk);
      return;
    }
    if (!early || earlyFull) return;
    const room = EARLY_OUTPUT_LIMIT - earlyChars;
    if (chunk.length <= room) {
      early.push(chunk);
      earlyChars += chunk.length;
      return;
    }
    // Keep the first 1 MB in one piece: cut the chunk that crosses the limit
    // (never in the middle of an emoji) and drop everything after it, so the
    // first listener never gets output with a hole in it.
    let end = room;
    const lastCode = end > 0 ? chunk.charCodeAt(end - 1) : 0;
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
    if (end > 0) early.push(chunk.slice(0, end));
    earlyFull = true;
  });

  function stopPauseWatch() {
    if (pauseWatch) clearInterval(pauseWatch);
    pauseWatch = null;
  }

  // The first listener also receives what arrived before it (in order, just
  // after this call returns). Later listeners get only new output.
  function onData(listener) {
    if (typeof listener !== "function") return () => {};
    dataListeners.add(listener);
    if (early) {
      const kept = early;
      early = null;
      if (kept.length) {
        queueMicrotask(() => {
          for (const chunk of kept) safeCall(listener, chunk);
        });
      }
    }
    return () => {
      dataListeners.delete(listener);
    };
  }

  // A listener added after the end is still told, once.
  function onExit(listener) {
    if (typeof listener !== "function") return () => {};
    if (exitInfo) {
      const info = exitInfo;
      queueMicrotask(() => safeCall(listener, info));
      return () => {};
    }
    exitListeners.add(listener);
    return () => {
      exitListeners.delete(listener);
    };
  }

  child.onExit(({ exitCode, signal }) => {
    stopPauseWatch();
    const name = signalName(signal);
    exitInfo = Object.freeze({
      exitCode: name ? null : Number.isInteger(exitCode) ? exitCode : null,
      signal: name
    });
    try {
      tracker.untrackPid(pid);
    } catch (error) {
      console.error("Agent OS: could not untrack a terminal program:", error);
    }
    const listeners = [...exitListeners];
    exitListeners.clear();
    for (const listener of listeners) safeCall(listener, exitInfo);
    releaseConptyAfterExit(child);
  });

  const handle = Object.freeze({
    pid,
    write(data) {
      if (exitInfo || typeof data !== "string" || data.length === 0) return;
      try {
        child.write(data);
      } catch {
        // the program is ending
      }
    },
    resize(nextCols, nextRows) {
      const width = toSize(nextCols, 0, 500);
      const height = toSize(nextRows, 0, 200);
      if (exitInfo || !width || !height) return;
      try {
        child.resize(width, height);
      } catch {
        // the program is ending
      }
    },
    kill(signal = "SIGTERM") {
      if (exitInfo) return;
      try {
        // node-pty throws when a signal is named on Windows.
        if (process.platform === "win32") child.kill();
        else child.kill(signal);
      } catch {
        // already gone
      }
    },
    pause() {
      // After the program is gone its last output must be read, so a pause
      // no longer holds anything back.
      if (exitInfo || ended) return;
      try {
        child.pause();
      } catch {
        // the program is ending
        return;
      }
      // node-pty reports the end (and destroys the terminal 200 ms later)
      // without reading what is still waiting while paused, and a resume
      // after that does nothing. So watch for the end and resume at once:
      // the rest of the output is then read before the terminal is destroyed.
      if (!pauseWatch) {
        pauseWatch = setInterval(() => {
          if (!processIsGone(pid)) return;
          ended = true;
          stopPauseWatch();
          try {
            child.resume();
          } catch {
            // already gone
          }
        }, PAUSED_EXIT_CHECK_MS);
        pauseWatch.unref?.();
      }
    },
    resume() {
      stopPauseWatch();
      if (exitInfo) return;
      try {
        child.resume();
      } catch {
        // the program is ending
      }
    },
    onData,
    onExit
  });

  try {
    // Quit and Hold to stop all (killAllTracked) reach this program from now on.
    tracker.trackPid(pid, onExit);
  } catch (error) {
    console.error("Agent OS: could not track a terminal program:", error);
  }
  return handle;
}
