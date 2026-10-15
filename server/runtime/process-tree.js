// Spawns children we can reliably clean up, and kills whole process trees
// (not just the immediate child) so a quit or restart never leaves an agent
// CLI or a supervised process running in the background.
//
// Two kinds of tracked process:
// - children started here with spawnTracked() (runs, the builder supervisor,
//   module sessions);
// - pids started elsewhere and registered with trackPid() (the terminal
//   sessions' PTYs: node-pty starts them, so there is no ChildProcess).
// killProcessTree() lists a process's descendants with `ps` BEFORE it sends
// any signal, so a grandchild that left the process group (setsid/setpgid)
// is still found and stopped (spec SP3, process-tree.js changes; Q3). On
// Linux without `ps` (the Docker image has no procps) it reads /proc instead.
//
// Safety: a pid that is not an integer above 1, or that is this process's own,
// is never tracked, listed or signalled. Pid 1 (and -1, 0) would reach every
// process the owner has; the server's own pid would stop the server itself.
import { execFile, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";
const trackedChildren = new Set();
// pid -> the entry object trackPid() made. The identity check keeps a late
// exit notice from removing a newer registration of a reused pid.
const trackedPids = new Map();
// The targets of every killProcessTree() call that has signalled them and not
// yet seen them gone: one array per call, emptied as targets exit. The exit
// sweep SIGKILLs these too, because a descendant that survived SIGTERM is no
// longer reachable through a tracked leader once that leader has exited.
const inFlightKills = new Set();
const PS_ARGS = ["-A", "-o", "pid=,ppid="];
// macOS: the absolute path, so a PATH without /bin (one a launcher built) cannot
// turn the setsid-proof walk into a group-only kill. Elsewhere the PATH lookup
// stays (Linux without procps falls back to /proc, which needs no command).
const PS_COMMAND = process.platform === "darwin" ? "/bin/ps" : "ps";
const PS_TIMEOUT_MS = 2000;
const PS_SYNC_TIMEOUT_MS = 500;
const PROC_DIR = "/proc";
const NUMERIC = /^\d+$/;

// Only a real process may be tracked or signalled: an integer above 1 that is
// not this server. Pid 1, 0 and the negatives address whole groups or every
// process the user may signal (kill(-1)); 1.5, NaN and undefined are mistakes.
function isSignalablePid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

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

// Registers a process this module did not start (a PTY from node-pty), so
// killAllTracked() and killAllTrackedSync() include it. onExit, when given,
// subscribes to its exit, for example (listener) => pty.onExit(() => listener()):
// the pid is then untracked by itself when the process ends.
export function trackPid(pid, onExit) {
  if (!isSignalablePid(pid)) return;
  const entry = { pid };
  trackedPids.set(pid, entry);
  if (typeof onExit !== "function") return;
  try {
    onExit(() => {
      if (trackedPids.get(pid) === entry) trackedPids.delete(pid);
    });
  } catch {
    // The owner calls untrackPid() itself when the process exits.
  }
}

export function untrackPid(pid) {
  trackedPids.delete(pid);
}

export function listTrackedPids() {
  return [...trackedPids.keys()];
}

// `ps -A -o pid=,ppid=` text -> every pid below `pid`, at any depth.
export function descendantsFromPsOutput(text, pid) {
  const children = new Map();
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    const child = Number(match[1]);
    const parent = Number(match[2]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    const current = queue.shift();
    for (const child of children.get(current) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

// One /proc/<pid>/stat line -> { pid, ppid }, or null when it is not one.
// The 2nd field is the command name in parentheses, and it may itself hold
// spaces and ")" (a program can name itself anything), so the fields after
// it are counted from the LAST ")": first the state, then the ppid.
export function parseProcStat(text) {
  const source = String(text ?? "");
  const open = source.indexOf("(");
  const close = source.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = source.slice(0, open).trim();
  const [, ppid] = source.slice(close + 1).trim().split(/\s+/);
  if (!NUMERIC.test(pid) || !NUMERIC.test(ppid || "")) return null;
  return { pid: Number(pid), ppid: Number(ppid) };
}

function procLine(statText) {
  const row = parseProcStat(statText);
  return row ? `${row.pid} ${row.ppid}` : null;
}

// Linux without `ps`: the same "pid ppid" lines `ps -A -o pid=,ppid=` prints,
// built from /proc/<n>/stat. "" anywhere else or when /proc cannot be read.
// One file at a time: a few hundred tiny in-memory reads, never hundreds of
// open files at once.
async function procPsText() {
  if (!isLinux) return "";
  let names;
  try {
    names = await readdir(PROC_DIR);
  } catch {
    return "";
  }
  const lines = [];
  for (const name of names) {
    if (!NUMERIC.test(name)) continue;
    try {
      const line = procLine(await readFile(`${PROC_DIR}/${name}/stat`, "utf8"));
      if (line) lines.push(line);
    } catch {
      // the process ended between the listing and the read
    }
  }
  return lines.join("\n");
}

// The same, synchronously, for the process.on("exit") sweep.
function procPsTextSync() {
  if (!isLinux) return "";
  let names;
  try {
    names = readdirSync(PROC_DIR);
  } catch {
    return "";
  }
  const lines = [];
  for (const name of names) {
    if (!NUMERIC.test(name)) continue;
    try {
      const line = procLine(readFileSync(`${PROC_DIR}/${name}/stat`, "utf8"));
      if (line) lines.push(line);
    } catch {
      // the process ended between the listing and the read
    }
  }
  return lines.join("\n");
}

// One `ps` run (argv only, at most 2 s). When `ps` cannot run (the Docker
// image node:20-bookworm-slim has no procps), Linux reads /proc instead.
// Windows keeps using taskkill /T, so it returns []. Only when neither `ps`
// nor /proc can be read is the result [], and killProcessTree() then signals
// the process group only.
export async function listDescendants(pid) {
  if (isWindows || !isSignalablePid(pid)) return [];
  const psText = await new Promise((resolve) => {
    execFile(PS_COMMAND, PS_ARGS, { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
  return descendantsFromPsOutput(psText ?? (await procPsText()), pid);
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

// Signals the process group led by pid, or pid alone when it leads none.
// Returns false when neither exists.
function signalTree(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export async function killProcessTree(pid, { graceMs = 1500 } = {}) {
  if (!isSignalablePid(pid)) return;
  if (isWindows) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  // List first: once the leader dies, its children are handed to init and
  // the parent-pid walk can no longer find them.
  const descendants = (await listDescendants(pid)).filter(isSignalablePid);
  const leaderSignalled = signalTree(pid, "SIGTERM");
  for (const child of descendants) signalTree(child, "SIGTERM");
  // The targets still running; each one leaves the list as soon as it is gone.
  const targets = [pid, ...descendants];
  const stillRunning = () => {
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      if (!isAlive(targets[index])) targets.splice(index, 1);
    }
    return targets.length > 0;
  };
  if (!leaderSignalled && !stillRunning()) return;
  // From here until they are gone, the exit sweep knows these targets even
  // when the leader is no longer tracked (see inFlightKills).
  inFlightKills.add(targets);
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      inFlightKills.delete(targets);
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    };
    // Deliberately not unref()'d: callers await this promise, and an unref'd
    // timer can let Node decide the event loop is empty and exit before it
    // fires, abandoning the still-pending promise.
    const poll = setInterval(() => {
      if (!stillRunning()) finish();
    }, 50);
    const timer = setTimeout(() => {
      for (const target of targets) {
        if (isAlive(target)) signalTree(target, "SIGKILL");
      }
      // SIGKILL delivery is asynchronous; keep polling so callers can rely on
      // "resolved" meaning "gone", but never wait more than another second.
      setTimeout(finish, 1000);
    }, graceMs);
  });
}

// Used by shutdown() to clean up every tracked child and pid in one pass.
export async function killAllTracked({ graceMs = 1500 } = {}) {
  const children = [...trackedChildren];
  const pids = [...trackedPids.keys()];
  await Promise.allSettled([
    ...children.map((child) => (child.pid ? killProcessTree(child.pid, { graceMs }) : Promise.resolve())),
    ...pids.map((pid) => killProcessTree(pid, { graceMs }))
  ]);
  for (const child of children) trackedChildren.delete(child);
  for (const pid of pids) trackedPids.delete(pid);
}

// The Windows exit sweep's one command line: taskkill /T /F /PID a /PID b ...
export function taskkillArgs(pids) {
  return ["/T", "/F", ...pids.flatMap((pid) => ["/PID", String(pid)])];
}

// Synchronous last resort for the `process.on("exit")` handler, where async
// work cannot run. Best effort: one ps snapshot (on Linux without ps, one
// /proc snapshot), then a single SIGKILL to every tracked group and every
// descendant, and to every target a killProcessTree() call had signalled and
// not yet seen gone; no wait for exit. With nothing tracked and nothing in
// flight it does nothing, and starts no process.
export function killAllTrackedSync() {
  const leaders = [
    ...new Set([...[...trackedChildren].map((child) => child.pid), ...trackedPids.keys()].filter(isSignalablePid))
  ];
  if (isWindows) {
    if (!leaders.length) return;
    // One taskkill with one time limit for all of them, not one per pid.
    try {
      spawnSync("taskkill", taskkillArgs(leaders), { timeout: 2000, windowsHide: true });
    } catch {
      // nothing more we can do synchronously
    }
    return;
  }
  const inFlight = new Set();
  for (const targets of inFlightKills) {
    for (const target of targets) if (isSignalablePid(target)) inFlight.add(target);
  }
  if (!leaders.length && !inFlight.size) return;
  const victims = new Set([...leaders, ...inFlight]);
  if (leaders.length) {
    let psText = null;
    try {
      const result = spawnSync(PS_COMMAND, PS_ARGS, { encoding: "utf8", timeout: PS_SYNC_TIMEOUT_MS });
      psText = result.error || result.status !== 0 ? null : result.stdout || "";
    } catch {
      psText = null;
    }
    if (psText === null) psText = procPsTextSync();
    // Every tree is listed before anything is signalled.
    for (const leader of leaders) {
      for (const child of descendantsFromPsOutput(psText, leader)) {
        if (isSignalablePid(child)) victims.add(child);
      }
    }
  }
  for (const victim of victims) signalTree(victim, "SIGKILL");
}
