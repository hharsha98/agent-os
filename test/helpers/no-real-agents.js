// The no-real-agents watcher (spec SP3; planning decisions Q1, Q1a, Q1b).
// scripts/run-tests.mjs starts it around the whole suite. It polls `ps` and
// flags a process when all three hold:
//   (a) it was not running when the watcher started (the baseline),
//   (b) it descends from the test runner (pids once seen as descendants are
//       remembered after their parent exits), and
//   (c) the first or second word of its command is named like an agent CLI
//       (claude, codex, agent, cursor-agent, hermes, openclaw) and that file
//       really lives outside the fake folders (the temp folder, the repo's
//       test/ folder and .superpowers/ui-audit/fake-bin/), or it runs from a
//       real agent's own install folder (REAL_AGENT_PATHS), wherever that is:
//       a real agent can be installed under a temp HOME (an npx cache,
//       Setup's managed Node in a temp ~/.agent-os, a copied
//       ~/.local/share/claude/versions), and the temp folder is a fake folder.
// The owner's own agents (for example the Claude desktop app's `claude`
// processes) are never descendants of the runner, so they never count.
// This is a helper, not a test file: the runner only runs test/*.test.js,
// and importing this module has no side effects.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_NAMES = Object.freeze(["claude", "codex", "agent", "cursor-agent", "hermes", "openclaw"]);

// Where the real agents install themselves. A process whose command contains
// one of these, or whose first or second word really lives in one (through
// links), counts even inside an allowed root.
export const REAL_AGENT_PATHS = Object.freeze([
  Object.freeze({ name: "claude", pattern: /node_modules\/@anthropic-ai\/claude-code\// }),
  Object.freeze({ name: "claude", pattern: /\.local\/share\/claude\/versions\// }),
  Object.freeze({ name: "codex", pattern: /node_modules\/@openai\/codex\// }),
  Object.freeze({ name: "openclaw", pattern: /node_modules\/openclaw\// }),
  Object.freeze({ name: "hermes", pattern: /\/hermes-agent\/venv\/bin\/hermes\b/ }),
  Object.freeze({ name: "cursor-agent", pattern: /\.local\/share\/cursor-agent\/versions\// })
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// macOS and Windows volumes usually ignore letter case.
const foldCase = process.platform === "darwin" || process.platform === "win32";

export function defaultAllowedRoots() {
  return [os.tmpdir(), path.join(repoRoot, "test"), path.join(repoRoot, ".superpowers", "ui-audit", "fake-bin")];
}

// `ps -A -ww -o pid=,ppid=,command=` text -> [{ pid, ppid, command }].
export function parsePsRows(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trimEnd() });
  }
  return rows;
}

// One `ps` snapshot of every process, or null when ps could not run.
export function readPsRows() {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-ww", "-o", "pid=,ppid=,command="],
      { maxBuffer: 32 * 1024 * 1024, timeout: 5000 },
      (error, stdout) => resolve(error ? null : parsePsRows(stdout))
    );
  });
}

function realOrResolved(file) {
  const resolved = path.resolve(file);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved; // gone already: judge the path as written
  }
}

function insideRoot(file, root) {
  const a = foldCase ? file.toLowerCase() : file;
  const b = foldCase ? root.toLowerCase() : root;
  const rel = path.relative(b, a);
  return rel !== "" && rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel);
}

function rootForms(allowedRoots) {
  const forms = new Set();
  for (const root of allowedRoots) {
    const resolved = path.resolve(root);
    forms.add(resolved);
    try {
      forms.add(realpathSync.native(resolved));
    } catch {
      // a root that does not exist only matches paths as written
    }
  }
  return [...forms];
}

// True when the command word names a file whose real location is inside one
// of the allowed roots. A bare name such as "claude" (no folder) was found on
// a PATH we cannot see, so it can never be proved to be a fake.
export function isAllowedBinary(token, allowedRoots = defaultAllowedRoots()) {
  if (!token.includes("/") && !token.includes("\\")) return false;
  const file = realOrResolved(token);
  return rootForms(allowedRoots).some((root) => insideRoot(file, root));
}

// The first REAL_AGENT_PATHS rule that a word of the command matches as
// written, or that the real path of its first or second word matches (ps
// shows a link's path, for example ~/.local/bin/claude, not the versions
// folder it points into). Returns { name, binary } or null.
function realInstallMatch(tokens, rules) {
  if (!rules.length) return null;
  const linked = tokens
    .slice(0, 2)
    .filter((token) => token.includes("/"))
    .map((token) => ({ token, real: realOrResolved(token) }));
  for (const rule of rules) {
    const written = tokens.find((token) => rule.pattern.test(token));
    if (written) return { name: rule.name, binary: written };
    const behindLink = linked.find((item) => rule.pattern.test(item.real));
    if (behindLink) return { name: rule.name, binary: behindLink.token };
  }
  return null;
}

function testFileFor(pid, byPid, seenDescendants) {
  const visited = new Set();
  let current = pid;
  while (current && !visited.has(current)) {
    visited.add(current);
    const command = byPid.get(current)?.command ?? seenDescendants.get(current)?.command ?? "";
    const tokens = command.split(/\s+/);
    // The per-file runner process carries one test file and no bare --test.
    if (!tokens.includes("--test")) {
      const file = tokens.find((token) => /\.test\.m?js$/.test(token));
      if (file) return file;
    }
    current = seenDescendants.get(current)?.ppid ?? byPid.get(current)?.ppid;
  }
  return null;
}

// The pid of the test runner being watched. It must be a real process of our
// own: pid 1 (or 0, or a missing number) would make every process on the
// machine a "descendant", the owner's own claude included, and the pid of our
// parent would do the same for everything that parent started.
function isRunnerPid(rootPid) {
  return Number.isInteger(rootPid) && rootPid > 1 && rootPid !== process.ppid;
}

// rows: one ps snapshot. baseline: Map<pid, command> (or a Set of pids) taken
// when the watcher started. seenDescendants: Map<pid, { ppid, command }>,
// updated in place so later calls still know processes whose parent exited.
// Returns [{ pid, ppid, name, binary, command, testFile }].
export function findViolations(
  rows,
  { baseline = new Map(), rootPid, seenDescendants = new Map(), allowedRoots = defaultAllowedRoots(), names = AGENT_NAMES } = {}
) {
  if (!isRunnerPid(rootPid)) return []; // nothing can be proved to descend from "the runner"
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }

  const descendants = new Set();
  const queue = [rootPid];
  // A remembered descendant still counts after its parent exited, but only
  // while it runs the same command: a pid the system reused for someone
  // else's process (for example the owner's own claude) does not.
  for (const [pid, known] of seenDescendants) {
    const row = byPid.get(pid);
    if (row && pid !== rootPid && row.command === known.command) {
      descendants.add(pid);
      queue.push(pid);
    }
  }
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(parent) || []) {
      if (child === rootPid || descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }
  for (const pid of descendants) {
    const row = byPid.get(pid);
    const known = seenDescendants.get(pid);
    // Keep the first parent: it is the one that started the process.
    seenDescendants.set(pid, { ppid: known ? known.ppid : row.ppid, command: row.command });
  }

  const nameSet = new Set(names.map((name) => name.toLowerCase()));
  const pathRules = REAL_AGENT_PATHS.filter((rule) => nameSet.has(rule.name));
  const violations = [];
  for (const pid of descendants) {
    const row = byPid.get(pid);
    const before = baseline instanceof Map ? baseline.get(pid) : baseline.has(pid) ? row.command : undefined;
    if (before === row.command) continue;
    const tokens = row.command.split(/\s+/).filter(Boolean);
    const named = tokens.slice(0, 2).find((token) => nameSet.has(path.basename(token).toLowerCase()));
    // Named like an agent and outside the fake folders; otherwise, a real
    // agent's own install folder, wherever it is.
    const found =
      named && !isAllowedBinary(named, allowedRoots)
        ? { name: path.basename(named).toLowerCase(), binary: named }
        : realInstallMatch(tokens, pathRules);
    if (!found) continue;
    violations.push({
      pid,
      ppid: row.ppid,
      name: found.name,
      binary: found.binary,
      command: row.command,
      testFile: testFileFor(pid, byPid, seenDescendants)
    });
  }
  return violations;
}

// What the watcher really did about a violation (`violation.stopped`, set by
// startWatcher before it reports): "sigterm" (it sent SIGTERM), "gone" (the
// process had already ended), "failed" (the signal could not be sent) or "no"
// (kill was off). The run-tests.mjs line says exactly this.
const STOPPED_SENTENCE = Object.freeze({
  sigterm: "Sent it SIGTERM.",
  gone: "It had already ended by then.",
  failed: "Could not stop it, so it may still be running.",
  no: "Did not stop it."
});

// The line scripts/run-tests.mjs prints for one violation. `where` is the
// test file it came from, already shortened for the screen.
export function violationLine(violation, where) {
  const what = STOPPED_SENTENCE[violation?.stopped] ?? STOPPED_SENTENCE.no;
  return (
    `no-real-agents watcher: a real "${violation.name}" started during the tests ` +
    `(pid ${violation.pid}, ${violation.binary}, from ${where}). ${what}`
  );
}

// "1 check" or "3 checks".
export function checksPhrase(count) {
  return `${count} ${count === 1 ? "check" : "checks"}`;
}

// Polls ps every intervalMs. Resolves once the baseline is taken, so start
// the tests only after it resolves. Each violation is reported once to
// onViolation and, unless kill is false, sent SIGTERM (`killProcess` is for
// tests: it replaces process.kill).
// stop() takes one last snapshot (tried up to three times when ps fails) and
// resolves { checks, failedChecks, finalCheckOk, violations }: checks counts
// the ps runs that worked, failedChecks the ones that did not, and
// finalCheckOk says whether the last snapshot, taken after the tests ended,
// worked. readRows is for tests: it replaces readPsRows.
export async function startWatcher({
  rootPid = process.pid,
  intervalMs = 200,
  onViolation = () => {},
  allowedRoots = defaultAllowedRoots(),
  names = AGENT_NAMES,
  kill = true,
  killProcess = (pid, signal) => process.kill(pid, signal),
  readRows = readPsRows
} = {}) {
  if (!isRunnerPid(rootPid)) throw new Error("startWatcher needs the pid of the test runner it watches");
  if (process.platform === "win32") throw new Error("no-real-agents watcher: not available on Windows");
  const first = await readRows();
  if (!first) throw new Error("no-real-agents watcher: could not run ps");
  const baseline = new Map(first.map((row) => [row.pid, row.command]));
  const seenDescendants = new Map();
  const reported = new Set();
  const violations = [];
  let checks = 0;
  let failedChecks = 0;
  let finalCheckOk = false;
  let running = null;
  let stopping = null;

  // True when ps ran. A run that failed is counted, never skipped silently.
  async function poll() {
    let rows = null;
    try {
      rows = await readRows();
    } catch {
      // treated like a ps that could not run
    }
    if (!rows) {
      failedChecks += 1;
      return false;
    }
    checks += 1;
    for (const violation of findViolations(rows, { baseline, rootPid, seenDescendants, allowedRoots, names })) {
      const key = `${violation.pid}\n${violation.command}`;
      if (reported.has(key)) continue;
      reported.add(key);
      let stopped = "no";
      if (kill) {
        try {
          killProcess(violation.pid, "SIGTERM");
          stopped = "sigterm";
        } catch (error) {
          // ESRCH: it ended before the signal. Anything else: it could not be signalled.
          stopped = error?.code === "ESRCH" ? "gone" : "failed";
        }
      }
      violation.stopped = stopped;
      violations.push(violation);
      try {
        onViolation(violation);
      } catch {
        // a reporting failure must not stop the watcher
      }
    }
    return true;
  }

  const timer = setInterval(() => {
    if (running || stopping) return;
    running = poll().finally(() => {
      running = null;
    });
  }, intervalMs);

  return {
    stop() {
      if (!stopping) {
        stopping = (async () => {
          clearInterval(timer);
          if (running) await running;
          // The last look, after the tests ended, is the one that must work.
          for (let attempt = 0; attempt < 3 && !finalCheckOk; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100));
            finalCheckOk = await poll();
          }
          return { checks, failedChecks, finalCheckOk, violations: [...violations] };
        })();
      }
      return stopping;
    }
  };
}
