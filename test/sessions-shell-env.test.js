// Sessions, the child environment (spec H2 and Security 2): reading the
// person's login-shell environment between random markers, the 10 s limit and
// the fallback with its notice, and exactly which variables a session's
// environment removes, sets and passes through. Nothing here starts an agent
// and no real login shell runs (decision Q1c): the "login shells" are small
// fake scripts in a temp folder and Task W1's stand-in, and HOME is always a
// temp folder.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FAKE_LOGIN_SHELL } from "./helpers/fake-agents.js";
import {
  FALLBACK_NOTICE,
  LOGIN_SHELL_TIMEOUT_MS,
  NESTED_MARKERS,
  excludeFromSessionEnv,
  getLoginShellEnv,
  resetExcludedForTests,
  resetLoginShellEnvForTests,
  resolveLoginShellEnv,
  sessionEnv
} from "../server/runtime/sessions/shell-env.js";

const isWindows = process.platform === "win32";
const posixSkip = { skip: isWindows ? "fake login shells are POSIX shell scripts" : false };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A temp HOME, a system-only PATH, no launch PATH from a desktop shell, no
// excluded names, and a folder for the fake shells. `npm test` is itself an
// npm script, so npm_lifecycle_event is cleared: every test here sees a server
// that no npm script started, unless it says otherwise.
async function withShellWorld(fn) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-shell-env-")));
  const home = path.join(base, "home");
  await mkdir(home, { recursive: true });
  resetLoginShellEnvForTests();
  resetExcludedForTests();
  try {
    return await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        PATH: SYSTEM_PATH_DIRS.join(path.delimiter),
        AGENT_OS_LAUNCH_PATH: undefined,
        npm_lifecycle_event: undefined,
        AGENT_OS_TOKEN: "secret-session-token",
        HERMES_AGENT_OS_ADMIN_TOKEN: "secret-admin-token",
        SESSIONS_TEST_PLANTED: "planted by the test"
      },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        return fn({ base, home });
      }
    );
  } finally {
    resetLoginShellEnvForTests();
    resetExcludedForTests();
    await rm(base, { recursive: true, force: true });
  }
}

// Writes a fake login shell: `body` runs first; "$last" is the command string
// Agent OS passed (its last argument). Every call records its arguments.
async function fakeShell(dir, name, body) {
  const file = path.join(dir, name);
  const record = path.join(dir, `${name}.args`);
  await writeFile(
    file,
    ["#!/bin/sh", `printf '%s\\n' "$@" >> "${record}"`, "for last; do :; done", body, ""].join("\n"),
    "utf8"
  );
  await chmod(file, 0o755);
  return { file, record };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// ---- reading the login shell ---------------------------------------------------------------

test("login shell (Review Focus 1): startup files that print junk don't confuse it; the environment is read between the markers", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const seenToken = path.join(base, "token-seen");
    const seenFlag = path.join(base, "flag-seen");
    const { file, record } = await fakeShell(
      base,
      "chatty-shell",
      [
        `printf '%s' "\${AGENT_OS_TOKEN-unset}" > "${seenToken}"`,
        `printf '%s' "\${AGENT_OS_RESOLVING_ENVIRONMENT-unset}" > "${seenFlag}"`,
        'echo "Good morning from a startup file"',
        `echo '{"PATH":"/printed/by/a/startup/file"}'`,
        'echo "warning: a plugin could not load" >&2',
        'printf "\\033[1;32mcoloured banner\\033[0m\\n"',
        'export FROM_STARTUP_FILE="set by .zprofile"',
        'export MULTI_LINE="first line',
        'second line = still the value"',
        '/bin/sh -c "$last"',
        'echo "bye from a logout file"'
      ].join("\n")
    );
    const result = await resolveLoginShellEnv({ shell: file });
    assert.equal(result.source, "login-shell");
    assert.equal(result.notice, null);
    assert.equal(result.env.FROM_STARTUP_FILE, "set by .zprofile", "what the startup files set is used");
    assert.equal(result.env.MULTI_LINE, "first line\nsecond line = still the value", "values with newlines and = survive (never parsed as env text)");
    assert.equal(result.env.SESSIONS_TEST_PLANTED, "planted by the test");
    assert.equal(result.env.PATH, SYSTEM_PATH_DIRS.join(path.delimiter));
    for (const key of ["PWD", "OLDPWD", "_", "AGENT_OS_RESOLVING_ENVIRONMENT", "AGENT_OS_TOKEN", "HERMES_AGENT_OS_ADMIN_TOKEN"]) {
      assert.equal(result.env[key], undefined, `${key} is not part of the person's environment`);
    }
    // Agent OS's token never reaches the person's startup files; the resolving flag does.
    assert.equal(await readFile(seenToken, "utf8"), "unset");
    assert.equal(await readFile(seenFlag, "utf8"), "1");
    // An interactive login shell runs the command: -i -l -c, then Node by its absolute path.
    const args = (await readFile(record, "utf8")).trimEnd().split("\n");
    assert.deepEqual(args.slice(0, 3), ["-i", "-l", "-c"]);
    assert.ok(args[3].startsWith(`'${process.execPath}' -e `), args[3]);
  });
});

test("login shell: the tests' stand-in login shell (FAKE_LOGIN_SHELL) is read as a login shell and keeps PATH exactly as given", posixSkip, async () => {
  await withShellWorld(async () => {
    const result = await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL });
    assert.equal(result.source, "login-shell");
    assert.equal(result.notice, null);
    assert.equal(result.env.PATH, process.env.PATH);
    assert.equal(result.env.SESSIONS_TEST_PLANTED, "planted by the test");
    assert.equal(result.env.AGENT_OS_TOKEN, undefined);
  });
});

test("login shell (Review Focus 1): a startup file that asks a question gets no input and no terminal, so it carries on and the environment is read", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const answered = path.join(base, "answered");
    const terminal = path.join(base, "terminal");
    const { file } = await fakeShell(
      base,
      "asking-shell",
      [
        // Like oh-my-zsh's "update now?" prompt: read one answer from input.
        "printf 'Update now? [Y/n] '",
        `if read answer; then printf 'answer:%s' "$answer" > "${answered}"; else printf 'end of input' > "${answered}"; fi`,
        // A startup step that reads everything it is given.
        "cat > /dev/null",
        // A prompt that insists on the terminal itself: there is none.
        `if (exec 3< /dev/tty) 2>/dev/null; then printf 'terminal' > "${terminal}"; else printf 'no terminal' > "${terminal}"; fi`,
        'export ASKED_FIRST="yes"',
        '/bin/sh -c "$last"'
      ].join("\n")
    );
    const started = Date.now();
    const result = await resolveLoginShellEnv({ shell: file, timeoutMs: 5000 });
    assert.equal(result.source, "login-shell", "the question did not stall it until the limit");
    assert.ok(Date.now() - started < 5000);
    assert.equal(result.env.ASKED_FIRST, "yes");
    assert.equal(await readFile(answered, "utf8"), "end of input", "Agent OS typed no answer");
    assert.equal(await readFile(terminal, "utf8"), "no terminal", "the shell has no terminal to wait on");
  });
});

test("login shell (Review Focus 1): the limit is 10 seconds, and a shell that hangs past it is killed and the fallback used", posixSkip, async () => {
  assert.equal(LOGIN_SHELL_TIMEOUT_MS, 10000);
  await withShellWorld(async ({ base }) => {
    const pidFile = path.join(base, "hang.pid");
    const { file } = await fakeShell(base, "hanging-shell", `echo $$ > "${pidFile}"\nexec sleep 30`);
    const started = Date.now();
    const result = await resolveLoginShellEnv({ shell: file, timeoutMs: 1500 });
    assert.ok(Date.now() - started < 6000, "gave up at the limit, not after the 30 s sleep");
    assert.equal(result.source, "fallback");
    assert.equal(result.notice, FALLBACK_NOTICE);
    assert.ok(await waitFor(() => existsSync(pidFile)), "the fake shell started");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(await waitFor(() => !isAlive(pid)), "the hanging shell was killed");
  });
});

// Fix round 1: the exit listener that kills the resolver shell when Agent OS
// quits must outlive the markers, because the person's logout files may still be
// running (or hanging) in the shell's process group.
test("login shell (fix round 1): quitting Agent OS still kills a resolver shell that is busy with logout files after the markers; the listener goes when the shell is gone", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const exitListeners = () => process.listeners("exit");
    const before = exitListeners();

    // 1. The shell prints the markers, then "runs a logout file" for 2 s.
    const slow = path.join(base, "slow-logout.pid");
    const slowShell = await fakeShell(base, "slow-logout-shell", [`echo $$ > "${slow}"`, '/bin/sh -c "$last"', "sleep 2"].join("\n"));
    const result = await resolveLoginShellEnv({ shell: slowShell.file });
    assert.equal(result.source, "login-shell", "the markers were enough, the logout files were not waited for");
    const slowPid = Number((await readFile(slow, "utf8")).trim());
    assert.ok(isAlive(slowPid), "the shell is still running its logout files");
    assert.equal(exitListeners().length, before.length + 1, "the exit listener is still registered");
    assert.ok(await waitFor(() => !isAlive(slowPid), 6000), "the shell ended by itself");
    assert.ok(await waitFor(() => exitListeners().length === before.length), "its exit listener is removed once the shell is gone");

    // 2. The same, but Agent OS quits while the logout file hangs: the listener
    // kills the shell's own process group (called here, the process stays up).
    const hang = path.join(base, "hanging-logout.pid");
    const hangShell = await fakeShell(base, "hanging-logout-shell", [`echo $$ > "${hang}"`, '/bin/sh -c "$last"', "sleep 30"].join("\n"));
    try {
      assert.equal((await resolveLoginShellEnv({ shell: hangShell.file })).source, "login-shell");
      const hangPid = Number((await readFile(hang, "utf8")).trim());
      assert.ok(isAlive(hangPid), "the shell is hanging in its logout file");
      const added = exitListeners().filter((listener) => !before.includes(listener));
      assert.equal(added.length, 1, "one listener of this resolver shell");
      added[0]();
      assert.ok(await waitFor(() => !isAlive(hangPid)), "the quit killed the hanging shell");
      assert.ok(await waitFor(() => exitListeners().length === before.length), "and its listener is gone");
    } finally {
      // Only the fake this test started.
      const pid = Number((await readFile(hang, "utf8").catch(() => "")).trim());
      if (pid && isAlive(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

// Fix round 2: the exit listener is about the shell's process group, not about
// the output pipe. A helper that a startup file detaches (a daemon in a session
// of its own) can keep the pipe open for days; the listener must not wait for
// it, because once the shell's group is empty its number can belong to an
// unrelated process, and quitting would then kill that one.
const groupExists = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

async function pidFrom(file) {
  return Number((await readFile(file, "utf8").catch(() => "")).trim()) || 0;
}

// The fake writes its pid a moment after the markers may have arrived, so wait
// for it (up to `timeoutMs`); 0 when it never came.
async function pidWhenWritten(file, timeoutMs = 3000) {
  await waitFor(async () => (await pidFrom(file)) > 0, timeoutMs);
  return pidFrom(file);
}

// Only ever the pid a fake of this test started (read from its own pid file).
function killOnly(pid) {
  if (!pid || !isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

test("login shell (fix round 2): a detached helper that keeps the output open after the shell and its group are gone does not keep the exit listener (a recycled group number is never signalled)", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const exitListeners = () => process.listeners("exit");
    const before = exitListeners();
    const shellPidFile = path.join(base, "shell.pid");
    const helperPidFile = path.join(base, "helper.pid");
    // The shell prints the markers, starts a helper in a session of its own
    // (fork, the parent exits, the child calls setsid) that inherits the output
    // and sleeps, then exits.
    const { file } = await fakeShell(
      base,
      "detaching-shell",
      [
        `echo $$ > "${shellPidFile}"`,
        '/bin/sh -c "$last"',
        `perl -MPOSIX -e 'fork and exit; setsid(); open(F, ">", $ARGV[0]); print F $$; close F; sleep 8' "${helperPidFile}" &`,
        // Wait until the helper has written its pid, so the test can stop it.
        `i=0; while [ ! -s "${helperPidFile}" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`
      ].join("\n")
    );
    let helperPid = 0;
    try {
      const result = await resolveLoginShellEnv({ shell: file });
      assert.equal(result.source, "login-shell");
      const shellPid = await pidWhenWritten(shellPidFile);
      assert.ok(shellPid > 0, "the fake shell started");
      assert.ok(await waitFor(() => !groupExists(shellPid), 5000), "the shell and everything in its process group are gone");
      helperPid = await pidWhenWritten(helperPidFile);
      assert.ok(helperPid > 0 && isAlive(helperPid), "the detached helper is still alive and still holds the output open");
      assert.ok(await waitFor(() => exitListeners().length === before.length, 3000), "the exit listener is gone although the output is still open");
      assert.ok(isAlive(helperPid), "the helper outlived the listener, as in the real case");
    } finally {
      killOnly(helperPid || (await pidWhenWritten(helperPidFile, 1500)));
    }
  });
});

test("login shell (fix round 2): a job left in the shell's group after the shell ended keeps the listener, so quitting still kills it; the listener goes with the job", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const exitListeners = () => process.listeners("exit");
    const before = exitListeners();
    const shellPidFile = path.join(base, "shell.pid");
    const jobPidFile = path.join(base, "job.pid");
    // The shell prints the markers, leaves a job in its own group (it keeps the
    // output open) and exits.
    const { file } = await fakeShell(
      base,
      "job-leaving-shell",
      [`echo $$ > "${shellPidFile}"`, '/bin/sh -c "$last"', `sleep 30 &`, `echo $! > "${jobPidFile}"`].join("\n")
    );
    let jobPid = 0;
    try {
      assert.equal((await resolveLoginShellEnv({ shell: file })).source, "login-shell");
      const shellPid = await pidWhenWritten(shellPidFile);
      jobPid = await pidWhenWritten(jobPidFile);
      assert.ok(shellPid > 0 && jobPid > 0, "the fake shell and its job started");
      assert.ok(await waitFor(() => !isAlive(shellPid), 5000), "the shell itself has ended");
      assert.ok(isAlive(jobPid), "its job is still running");
      assert.equal(groupExists(shellPid), true, "so the shell's process group still exists");
      // Longer than the 1 s re-check: the listener is still there, not released
      // just because the shell ended.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const added = exitListeners().filter((listener) => !before.includes(listener));
      assert.equal(added.length, 1, "the listener stays while the group exists");
      added[0](); // Agent OS quits: the group, and so the job, is killed
      assert.ok(await waitFor(() => !isAlive(jobPid)), "quitting killed the job left behind");
      assert.ok(await waitFor(() => exitListeners().length === before.length, 3000), "the group is empty, so the listener is gone");
    } finally {
      killOnly(jobPid || (await pidWhenWritten(jobPidFile, 1500)));
    }
  });
});

test("login shell (fix round 1): more than 4 MB of output before the markers is not read; the shell is killed and the fallback used", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const pidFile = path.join(base, "flood.pid");
    // Without the limit this would still end in the markers and read fine.
    const { file } = await fakeShell(base, "flooding-shell", [`echo $$ > "${pidFile}"`, "yes x | head -c 5000000", '/bin/sh -c "$last"', "sleep 30"].join("\n"));
    const started = Date.now();
    const result = await resolveLoginShellEnv({ shell: file });
    assert.ok(Date.now() - started < 8000, "gave up at the size limit, not at the 10 s limit");
    assert.equal(result.source, "fallback");
    assert.equal(result.notice, FALLBACK_NOTICE);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(await waitFor(() => !isAlive(pid)), "the flooding shell was killed");
  });
});

test("login shell: no markers, a failing shell, a missing shell or no PATH all give the fallback and its notice", posixSkip, async () => {
  await withShellWorld(async ({ base, home }) => {
    const noMarkers = await fakeShell(base, "no-markers", `echo '{"PATH":"/nope"}'`);
    const failing = await fakeShell(base, "failing", 'echo "broken startup file" >&2\nexit 3');
    const noPath = await fakeShell(base, "no-path", '/usr/bin/env -i /bin/sh -c "$last"');
    for (const shell of [noMarkers.file, failing.file, noPath.file, path.join(base, "no-such-shell"), "relative/sh", ""]) {
      const result = await resolveLoginShellEnv({ shell });
      assert.equal(result.source, "fallback", String(shell));
      assert.equal(result.notice, "Agent OS could not read your login shell's settings, so sessions use a basic environment.");
      // The server's own environment plus the usual install folders, each once.
      const parts = result.env.PATH.split(path.delimiter);
      assert.deepEqual(parts, [...SYSTEM_PATH_DIRS, "/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin")]);
      assert.equal(result.env.SESSIONS_TEST_PLANTED, "planted by the test");
      // Fix round 1: Agent OS's own variables are not part of any result.
      assert.equal(result.env.AGENT_OS_TOKEN, undefined, "the session token");
      assert.equal(result.env.HERMES_AGENT_OS_ADMIN_TOKEN, undefined, "the admin token");
      assert.deepEqual(Object.keys(result.env).filter((key) => /^(?:HERMES_)?AGENT_OS_/.test(key)), []);
    }
    // A folder already on PATH is not added twice.
    await withEnv({ PATH: ["/opt/homebrew/bin", ...SYSTEM_PATH_DIRS].join(path.delimiter) }, async () => {
      const result = await resolveLoginShellEnv({ shell: noMarkers.file });
      assert.equal(result.env.PATH.split(path.delimiter).filter((dir) => dir === "/opt/homebrew/bin").length, 1);
    });
  });
});

test("login shell: Windows has none, so the process environment is used as it is and no shell runs", async () => {
  await withShellWorld(async ({ base }) => {
    const { file, record } = await fakeShell(base, "never-run", '/bin/sh -c "$last"');
    // Agent OS's own variables (the desktop shell's launch PATH and port among
    // them, in any letter case on Windows) are not the person's environment.
    await withEnv({ AGENT_OS_LAUNCH_PATH: "/usr/bin:/bin", AGENT_OS_PORT: "8787", Agent_Os_Static_Dir: "/x", Hermes_Agent_Os_Home: "/y" }, async () => {
      const result = await resolveLoginShellEnv({ shell: file, platform: "win32" });
      assert.equal(result.source, "process");
      assert.equal(result.notice, null);
      const expected = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string" && !/^(?:HERMES_)?AGENT_OS_/i.test(key)) expected[key] = value;
      }
      assert.deepEqual(result.env, expected);
      assert.equal(result.env.SESSIONS_TEST_PLANTED, "planted by the test");
      for (const key of ["AGENT_OS_TOKEN", "HERMES_AGENT_OS_ADMIN_TOKEN", "AGENT_OS_LAUNCH_PATH", "AGENT_OS_PORT", "Agent_Os_Static_Dir", "Hermes_Agent_Os_Home"]) {
        assert.equal(result.env[key], undefined, key);
      }
      assert.equal(existsSync(record), false, "no shell was started");
    });
  });
});

test("login shell: names Agent OS put into its own environment (its own env file's keys, decision Q11a) reach neither the login shell, the fallback nor Windows", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    await withEnv(
      { SESSIONS_TEST_FROM_DOTENV: "loaded by Agent OS", SESSIONS_TEST_KEPT: "the person's own", Sessions_Test_Case: "another spelling" },
      async () => {
        excludeFromSessionEnv(["SESSIONS_TEST_FROM_DOTENV", "SESSIONS_TEST_CASE", 42, null]);

        const seen = path.join(base, "dotenv-seen");
        const passing = await fakeShell(
          base,
          "passing-shell",
          [`printf '%s' "\${SESSIONS_TEST_FROM_DOTENV-unset}" > "${seen}"`, '/bin/sh -c "$last"'].join("\n")
        );
        const loginShell = await resolveLoginShellEnv({ shell: passing.file });
        assert.equal(loginShell.source, "login-shell");
        assert.equal(loginShell.env.SESSIONS_TEST_FROM_DOTENV, undefined);
        assert.equal(loginShell.env.SESSIONS_TEST_KEPT, "the person's own");
        assert.equal(await readFile(seen, "utf8"), "unset", "the person's startup files never receive it");

        const noMarkers = await fakeShell(base, "no-markers", `echo '{"PATH":"/nope"}'`);
        const fallback = await resolveLoginShellEnv({ shell: noMarkers.file });
        assert.equal(fallback.source, "fallback");
        assert.equal(fallback.env.SESSIONS_TEST_FROM_DOTENV, undefined);
        assert.equal(fallback.env.SESSIONS_TEST_KEPT, "the person's own");
        assert.equal(fallback.env.Sessions_Test_Case, "another spelling", "names keep their letter case apart outside Windows");

        const windows = await resolveLoginShellEnv({ platform: "win32" });
        assert.equal(windows.source, "process");
        assert.equal(windows.env.SESSIONS_TEST_FROM_DOTENV, undefined);
        assert.equal(windows.env.SESSIONS_TEST_KEPT, "the person's own");
        assert.equal(windows.env.Sessions_Test_Case, undefined, "Windows names ignore letter case");

        // The same name set by the person's own startup file is theirs, so it
        // is kept (H2 removes only Agent OS's own variables).
        const own = await fakeShell(base, "own-shell", ['export SESSIONS_TEST_FROM_DOTENV="set in .zshrc"', '/bin/sh -c "$last"'].join("\n"));
        assert.equal((await resolveLoginShellEnv({ shell: own.file })).env.SESSIONS_TEST_FROM_DOTENV, "set in .zshrc");
      }
    );
  });
});

test("login shell: it starts with the PATH the app was started with (AGENT_OS_LAUNCH_PATH), not the folders the desktop shell added (H2, Q11a)", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    await withEnv({ PATH: "/opt/extra:/usr/bin:/bin", AGENT_OS_LAUNCH_PATH: "/usr/bin:/bin" }, async () => {
      const standIn = await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL });
      assert.equal(standIn.source, "login-shell");
      assert.equal(standIn.env.PATH, "/usr/bin:/bin");
      assert.equal(Object.hasOwn(standIn.env, "AGENT_OS_LAUNCH_PATH"), false, "an Agent OS name never reaches a session");

      // It is what the login shell starts with, not its answer: the person's
      // startup files still add to it.
      const seen = path.join(base, "path-seen");
      const own = await fakeShell(
        base,
        "path-shell",
        [`printf '%s' "$PATH" > "${seen}"`, 'export PATH="/from/zprofile:$PATH"', '/bin/sh -c "$last"'].join("\n")
      );
      const result = await resolveLoginShellEnv({ shell: own.file });
      assert.equal(await readFile(seen, "utf8"), "/usr/bin:/bin");
      assert.equal(result.env.PATH, "/from/zprofile:/usr/bin:/bin");
    });
    // Without it (npm start, the tests) the server's own PATH goes in, as before.
    for (const launchPath of [undefined, ""]) {
      await withEnv({ PATH: "/opt/extra:/usr/bin:/bin", AGENT_OS_LAUNCH_PATH: launchPath }, async () => {
        assert.equal((await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL })).env.PATH, "/opt/extra:/usr/bin:/bin", String(launchPath));
      });
    }
  });
});

// What `npm start` or `npm run dev` adds to the server's environment (checked
// with npm 10): its own lower-case npm_* variables, INIT_CWD, NODE, COLOR,
// EDITOR=vi when the person has no EDITOR or VISUAL, and, in front of PATH,
// node_modules/.bin of the project folder and of every folder above it, then
// npm's own node-gyp-bin.
function npmStart(base) {
  const project = path.join(base, "agent-os");
  return {
    pathEntries: [
      path.join(project, "node_modules", ".bin"),
      path.join(base, "node_modules", ".bin"),
      path.join(path.parse(base).root, "node_modules", ".bin"),
      path.join(base, "npm", "node_modules", "@npmcli", "run-script", "lib", "node-gyp-bin")
    ],
    vars: {
      npm_lifecycle_event: "start",
      npm_lifecycle_script: "node server/index.js",
      npm_package_json: path.join(project, "package.json"),
      npm_package_name: "agent-os-runtime",
      npm_config_prefix: "/x",
      npm_config_cache: path.join(base, "home", ".npm"),
      npm_execpath: "/x/lib/node_modules/npm/bin/npm-cli.js",
      INIT_CWD: "/y",
      NODE: process.execPath,
      COLOR: "1"
    }
  };
}

// npm's own names are lower case. Only those are counted: an upper-case name
// such as a developer's own NPM_TOKEN may be in the test process, and it is
// the person's, so it passes through.
const npmNames = (env) => Object.keys(env).filter((key) => key.startsWith("npm_"));

test("login shell: when an npm script started Agent OS (npm start, npm run dev), what npm added reaches neither the login shell, the fallback nor Windows (H2, Q11a)", posixSkip, async () => {
  await withShellWorld(async ({ base, home }) => {
    const npm = npmStart(base);
    const npmPath = [...npm.pathEntries, ...SYSTEM_PATH_DIRS].join(path.delimiter);
    const personOwn = "/Users/someone/.npm-global";
    await withEnv({ ...npm.vars, PATH: npmPath, EDITOR: "vi", VISUAL: undefined, NPM_CONFIG_PREFIX: personOwn }, async () => {
      const result = await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL });
      assert.equal(result.source, "login-shell");
      assert.deepEqual(npmNames(result.env), [], "npm's own variables are gone");
      assert.equal(result.env.NPM_CONFIG_PREFIX, personOwn, "the person's own npm setting stays (npm's names are lower case)");
      for (const key of ["INIT_CWD", "NODE", "COLOR", "EDITOR"]) assert.equal(result.env[key], undefined, `${key} was npm's`);
      assert.equal(result.env.PATH, SYSTEM_PATH_DIRS.join(path.delimiter), "npm's folders are gone, the rest keeps its order");
      assert.equal(result.env.SESSIONS_TEST_PLANTED, "planted by the test");

      // An EDITOR copied from VISUAL is npm's too; VISUAL itself is the person's.
      await withEnv({ EDITOR: "code --wait", VISUAL: "code --wait" }, async () => {
        const copied = await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL });
        assert.equal(copied.env.EDITOR, undefined);
        assert.equal(copied.env.VISUAL, "code --wait");
      });

      // Fix round 1: npm fills in EDITOR || VISUAL || "vi". A person's own
      // EDITOR=vi next to a VISUAL of something else is not that fill-in, so it
      // is kept (in the login shell and in the fallback); VISUAL is theirs too.
      await withEnv({ EDITOR: "vi", VISUAL: "code" }, async () => {
        const own = await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL });
        assert.equal(own.source, "login-shell");
        assert.equal(own.env.EDITOR, "vi");
        assert.equal(own.env.VISUAL, "code");
        const noMarkers = await fakeShell(base, "no-markers-editor", `echo '{"PATH":"/nope"}'`);
        const fallback = await resolveLoginShellEnv({ shell: noMarkers.file });
        assert.equal(fallback.source, "fallback");
        assert.equal(fallback.env.EDITOR, "vi");
        assert.equal(fallback.env.VISUAL, "code");
      });

      // `npm run desktop:dev`: the PATH the app was started with carries npm's folders too.
      await withEnv({ AGENT_OS_LAUNCH_PATH: [npm.pathEntries[0], "/usr/bin", "/bin"].join(path.delimiter) }, async () => {
        assert.equal((await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL })).env.PATH, "/usr/bin:/bin");
      });

      // An EDITOR the person has passes through npm unchanged, so it is kept,
      // also in the fallback, where no startup file sets it again.
      await withEnv({ EDITOR: "nano" }, async () => {
        const noMarkers = await fakeShell(base, "no-markers", `echo '{"PATH":"/nope"}'`);
        const fallback = await resolveLoginShellEnv({ shell: noMarkers.file });
        assert.equal(fallback.source, "fallback");
        assert.equal(fallback.env.EDITOR, "nano");
        assert.deepEqual(npmNames(fallback.env), []);
        assert.equal(fallback.env.NPM_CONFIG_PREFIX, personOwn);
        for (const key of ["INIT_CWD", "NODE", "COLOR"]) assert.equal(fallback.env[key], undefined, key);
        assert.deepEqual(fallback.env.PATH.split(path.delimiter), [...SYSTEM_PATH_DIRS, "/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin")]);
      });

      // Windows: npm fills in notepad.exe, and names ignore letter case.
      await withEnv({ SYSTEMROOT: "C:\\Windows", EDITOR: "C:\\Windows\\notepad.exe" }, async () => {
        const windows = await resolveLoginShellEnv({ platform: "win32" });
        assert.equal(windows.source, "process");
        const npmAnyCase = Object.keys(windows.env).filter((key) => key.toLowerCase().startsWith("npm_"));
        assert.deepEqual(npmAnyCase, [], "Windows names ignore letter case, so NPM_CONFIG_PREFIX counts as npm's too");
        for (const key of ["INIT_CWD", "NODE", "COLOR", "EDITOR"]) assert.equal(windows.env[key], undefined, key);
        assert.equal(windows.env.PATH, SYSTEM_PATH_DIRS.join(path.delimiter));
      });

      // Windows too: with a VISUAL set, notepad.exe is not npm's fill-in, so the person's own EDITOR stays.
      await withEnv({ SYSTEMROOT: "C:\\Windows", EDITOR: "C:\\Windows\\notepad.exe", VISUAL: "code" }, async () => {
        const windows = await resolveLoginShellEnv({ platform: "win32" });
        assert.equal(windows.env.EDITOR, "C:\\Windows\\notepad.exe");
      });
    });
  });
});

test("login shell: when no npm script started Agent OS, the same names are the person's and pass through", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const npm = npmStart(base);
    const vars = { ...npm.vars };
    delete vars.npm_lifecycle_event;
    const npmPath = [...npm.pathEntries, ...SYSTEM_PATH_DIRS].join(path.delimiter);
    await withEnv({ ...vars, PATH: npmPath, EDITOR: "vi", VISUAL: undefined }, async () => {
      const result = await resolveLoginShellEnv({ shell: FAKE_LOGIN_SHELL });
      assert.equal(result.source, "login-shell");
      assert.equal(result.env.EDITOR, "vi");
      for (const [key, value] of Object.entries(vars)) assert.equal(result.env[key], value, key);
      assert.equal(result.env.PATH, npmPath);
    });
  });
});

test("getLoginShellEnv resolves once per server: the same promise every call", posixSkip, async () => {
  await withShellWorld(async ({ base }) => {
    const { file, record } = await fakeShell(base, "counted-shell", '/bin/sh -c "$last"');
    await withEnv({ SHELL: file }, async () => {
      const first = getLoginShellEnv();
      const second = getLoginShellEnv();
      assert.equal(first, second);
      assert.equal((await first).source, "login-shell");
      await getLoginShellEnv();
      const calls = () => readFile(record, "utf8").then((text) => text.split("\n").filter((line) => line === "-i").length);
      assert.equal(await calls(), 1, "the shell ran once");
      resetLoginShellEnvForTests();
      assert.notEqual(getLoginShellEnv(), first);
      await getLoginShellEnv();
      assert.equal(await calls(), 2);
    });
  });
});

// ---- what a session's environment holds (Security 2) ----------------------------------------

const PERSON = {
  PATH: "/Users/someone/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  HOME: "/Users/someone",
  SHELL: "/opt/homebrew/bin/fish",
  EDITOR: "vim",
  VISUAL: "code --wait",
  SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.x/Listeners",
  LANG: "en_GB.UTF-8",
  LC_ALL: "en_GB.UTF-8",
  LC_CTYPE: "UTF-8",
  HTTPS_PROXY: "http://proxy.example:3128",
  https_proxy: "http://proxy.example:3128",
  NO_PROXY: "localhost,127.0.0.1",
  ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
  OPENAI_API_KEY: "sk-not-a-real-key",
  CODEX_HOME: "/Users/someone/.codex-work",
  XDG_CONFIG_HOME: "/Users/someone/.config",
  HERMES_HOME: "/Users/someone/.hermes-work",
  CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
  OPENCLAW_STATE_DIR: "/Users/someone/.openclaw-state",
  OPENCLAW_PROFILE: "work"
};
const AGENT_OS_OWN = {
  AGENT_OS_TOKEN: "secret-session-token",
  AGENT_OS_STATIC_DIR: "/Applications/Agent OS.app/Contents/Resources/dist",
  AGENT_OS_PACKAGED: "1",
  AGENT_OS_SESSION_ID: "an-older-session",
  HERMES_AGENT_OS_ADMIN_TOKEN: "secret-admin-token",
  HERMES_AGENT_OS_HOME: "/Users/someone/.hermes-agent-os",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  TERM: "dumb",
  TERM_PROGRAM: "vscode",
  TERM_PROGRAM_VERSION: "1.99.0",
  COLORTERM: "24bit"
};

test("sessionEnv: removes only Agent OS's variables and the nested-session markers; sets exactly the terminal variables", () => {
  const env = sessionEnv({ ...PERSON, ...AGENT_OS_OWN }, { sessionId: "6f0c2c1e-2f4b-4b8e-9d55-0d3f2a4b5c6d", agentOsVersion: "0.4.0", agentId: "codex" });
  assert.deepEqual(env, {
    ...PERSON,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "AgentOS",
    TERM_PROGRAM_VERSION: "0.4.0",
    AGENT_OS_SESSION_ID: "6f0c2c1e-2f4b-4b8e-9d55-0d3f2a4b5c6d"
  });
  assert.deepEqual(NESTED_MARKERS, ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
});

test("sessionEnv: CLAUDE_CODE_NO_FLICKER only for Claude Code with the opt-in; never the env scrub, never TERM_PROGRAM=vscode", () => {
  for (const agentId of ["claude", "codex", "cursor", "hermes", "openclaw"]) {
    for (const claudeFullscreen of [false, true]) {
      const env = sessionEnv({ ...PERSON, ...AGENT_OS_OWN }, { sessionId: "s", agentOsVersion: "0.4.0", claudeFullscreen, agentId });
      const where = `${agentId}, opt-in ${claudeFullscreen}`;
      assert.equal(env.CLAUDE_CODE_NO_FLICKER, agentId === "claude" && claudeFullscreen ? "1" : undefined, where);
      assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined, where);
      assert.equal(env.TERM_PROGRAM, "AgentOS", where);
      assert.equal(env.HOME, PERSON.HOME, where);
      assert.equal(env.AGENT_OS_HOOK_URL, undefined, `${where}: no hook variables in SP3`);
      assert.equal(env.AGENT_OS_HOOK_TOKEN, undefined, `${where}: no hook variables in SP3`);
    }
  }
  // The person's own setting decides when the opt-in is off (H4).
  const own = sessionEnv({ ...PERSON, CLAUDE_CODE_NO_FLICKER: "1" }, { sessionId: "s", agentId: "claude", claudeFullscreen: false });
  assert.equal(own.CLAUDE_CODE_NO_FLICKER, "1");
});

test("sessionEnv (fix round 1): a missing session id or a base environment that is not an object is a caller's bug and throws", () => {
  for (const sessionId of [undefined, null, "", 42, {}, ["s"]]) {
    assert.throws(() => sessionEnv(PERSON, { sessionId, agentId: "codex" }), TypeError, `sessionId ${JSON.stringify(sessionId)}`);
  }
  assert.throws(() => sessionEnv(PERSON), TypeError, "no options at all");
  assert.throws(() => sessionEnv(PERSON, {}), TypeError, "no session id");
  for (const baseEnv of [undefined, null, "PATH=/usr/bin", 42, true, ["PATH=/usr/bin"]]) {
    assert.throws(() => sessionEnv(baseEnv, { sessionId: "s", agentId: "codex" }), TypeError, `baseEnv ${JSON.stringify(baseEnv)}`);
  }
  // An empty environment is still an object: a bare but valid base.
  assert.equal(sessionEnv({}, { sessionId: "s" }).AGENT_OS_SESSION_ID, "s");
});

test("sessionEnv: on Windows, variable names ignore letter case", () => {
  const env = sessionEnv(
    { Path: "C:\\Windows", Agent_Os_Token: "secret", hermes_agent_os_home: "x", ClaudeCode: "1", Term_Program: "vscode", USERPROFILE: "C:\\Users\\someone" },
    { sessionId: "s", agentOsVersion: "0.4.0", agentId: "codex", platform: "win32" }
  );
  assert.deepEqual(env, {
    Path: "C:\\Windows",
    USERPROFILE: "C:\\Users\\someone",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "AgentOS",
    TERM_PROGRAM_VERSION: "0.4.0",
    AGENT_OS_SESSION_ID: "s"
  });
});
