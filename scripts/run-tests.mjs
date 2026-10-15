// `npm test`: runs every test/*.test.js file with `node --test` under the
// no-real-agents watcher (spec SP3; planning decisions Q1, Q1a). Arguments
// are passed on: flags (anything starting with "-") go before the files,
// and file paths replace the default list. For example:
//   npm test -- test/portable.test.js
//   npm test -- --test-name-pattern="shutdown" test/portable.test.js
// The run fails (exit 1) when a real agent CLI started during it, even if
// every test passed. Windows has no `ps`, so there the tests run unwatched.
// The tests never read the owner's shell setup: SHELL is the stand-in login
// shell, and ZDOTDIR, ENV and BASH_ENV are removed (planning decision Q1c).
// HERMES_AGENT_OS_EXECUTABLE_PATHS is removed too, so detection never finds
// the owner's real agents ahead of a test's fake folder.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_LOGIN_SHELL } from "../test/helpers/fake-agents.js";
import { startWatcher } from "../test/helpers/no-real-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extra = process.argv.slice(2);
const flags = extra.filter((arg) => arg.startsWith("-"));
const named = extra.filter((arg) => !arg.startsWith("-")).map((file) => path.resolve(file));
const files = named.length
  ? named
  : readdirSync(path.join(root, "test"))
      .filter((name) => name.endsWith(".test.js"))
      .sort()
      .map((name) => path.join(root, "test", name));

function shownPath(file) {
  if (!file) return "an unknown test file";
  const relative = path.relative(root, file);
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative;
}

function violationLine(violation) {
  const where = shownPath(violation.testFile);
  return (
    `no-real-agents watcher: a real "${violation.name}" started during the tests ` +
    `(pid ${violation.pid}, ${violation.binary}, from ${where}). Sent it SIGTERM.`
  );
}

let watcher = null;
if (process.platform === "win32") {
  console.log("no-real-agents watcher: not available on Windows");
} else {
  try {
    watcher = await startWatcher({ rootPid: process.pid, onViolation: (violation) => console.error(violationLine(violation)) });
  } catch (error) {
    console.error(`${error.message}. The tests did not run.`);
    process.exit(1);
  }
}

// From Task S8 on, every server a test starts in local mode reads its login
// shell ($SHELL -i -l -c). The owner's real shell would run their startup
// files, and a real login sh (macOS path_helper) puts /usr/local/bin and
// /opt/homebrew/bin ahead of a test's fake folder. Tests that start
// server/index.js also set SHELL: FAKE_LOGIN_SHELL themselves, so a single
// file run with node --test is safe too. The variables that point shells at
// startup files go, and so does detection's extra folders
// (HERMES_AGENT_OS_EXECUTABLE_PATHS), which are searched before PATH: set to
// the owner's real agent folders, they would put a real agent ahead of a
// test's fake folder (server/runtime/safety.js executableSearchDirs).
// AGENT_OS_STDIN_SHUTDOWN goes too: with it set to 1 in a developer's shell,
// every test server started with stdin "ignore" would read end-of-input at
// once and quit (the tests that want the stdin quit line set it themselves).
// So does AGENT_OS_PORT: the server reads it before PORT, so one exported in a
// developer's shell would move every test server that passes PORT.
const testEnv = { ...process.env };
for (const key of [
  "ZDOTDIR",
  "ENV",
  "BASH_ENV",
  "HERMES_AGENT_OS_EXECUTABLE_PATHS",
  "AGENT_OS_STDIN_SHUTDOWN",
  "AGENT_OS_PORT"
]) {
  delete testEnv[key];
}
if (process.platform !== "win32") testEnv.SHELL = FAKE_LOGIN_SHELL;

const child = spawn(process.execPath, ["--test", "--test-timeout=180000", ...flags, ...files], {
  cwd: root,
  env: testEnv,
  stdio: "inherit"
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(`Could not start node --test: ${error.message}`);
  process.exit(1);
});
child.once("exit", async (code, signal) => {
  let exitCode = signal ? 1 : (code ?? 1);
  if (watcher) {
    const { checks, failedChecks, finalCheckOk, violations } = await watcher.stop();
    if (violations.length) {
      console.error(
        `no-real-agents watcher: ${violations.length} real agent process(es) started during the tests, so the run fails.`
      );
      exitCode = 1;
    }
    if (!finalCheckOk || checks === 0) {
      // ps failed for the last look (or every look): "no real agent started"
      // would be a claim nobody checked.
      console.error("no-real-agents watcher: could not check for real agents (ps failed), so this run is not proven clean.");
      exitCode = 1;
    } else if (!violations.length) {
      const failed = failedChecks ? `, ${failedChecks} could not run ps` : "";
      console.log(`no-real-agents watcher: no real agent started (${checks} checks${failed})`);
    }
  }
  // Not process.exit(): on a pipe (npm test | tail) it can cut off the line
  // just printed, and Task E1 and later tasks grep for it. Setting the exit
  // code and letting the process end lets the output flush first. The timer
  // is only a safety net for a handle that would keep the process alive; it
  // does not keep it alive itself.
  process.exitCode = exitCode;
  setTimeout(() => process.exit(process.exitCode), 2000).unref();
});
