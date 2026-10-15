// The PTY host: an agent's own terminal program running in a real
// pseudo-terminal through node-pty. Argv only, exactly the environment and
// folder it is given, signals reported by name, flow control (pause/resume),
// and the pid tracked so quit and Hold to stop all reach it.
// Programs here are tiny Node scripts written to a temp folder, or W1's TUI
// fakes. No real agent ever runs.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { killAllTracked } from "../server/runtime/process-tree.js";
import {
  PTY_UNAVAILABLE_REASON,
  ptyAvailable,
  setPtyLoaderForTests,
  spawnPty
} from "../server/runtime/sessions/pty-host.js";
import { createMirror } from "../server/runtime/sessions/mirror.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const isWindows = process.platform === "win32";
const SKIP_POSIX = { skip: isWindows ? "PTY tests use POSIX shims and signals" : false };
const SAMPLE_UUID = "11111111-2222-4333-8444-555555555555";

const SLEEPER = "setInterval(() => {}, 1000);\n";
const ENV_PROBE = [
  "const info = {",
  "  marker: process.env.SESSION_MARKER ?? null,",
  "  token: process.env.AGENT_OS_TOKEN ?? null,",
  "  term: process.env.TERM ?? null,",
  "  cwd: process.cwd()",
  "};",
  "process.stdout.write('ENV ' + JSON.stringify(info) + '\\n');"
].join("\n");
const SIZE_PROBE = [
  "const report = () => process.stdout.write('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n');",
  "report();",
  "process.stdout.on('resize', report);",
  "setInterval(() => {}, 1000);"
].join("\n");
const TICKER = "setInterval(() => process.stdout.write('tick\\n'), 20);\n";
// Prints a line, then (after EXIT_AFTER_MS) its last words, and ends.
const LAST_WORDS = [
  "process.stdout.write('A\\n');",
  "setTimeout(() => {",
  "  process.stdout.write('END-MARKER\\n');",
  "  process.exit(0);",
  "}, Number(process.env.EXIT_AFTER_MS || 400));"
].join("\n");
// Asks the terminal two standard questions after a bell and an OSC 9
// notification, then reports what came back (or NO REPLY).
const QUERY_PROBE = [
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  "let got = '';",
  "process.stdin.on('data', (data) => { got += data.toString('latin1'); });",
  "process.stdout.write('ready\\r\\n');",
  "process.stdout.write('\\x07');",
  "process.stdout.write('\\x1b]9;from the agent\\x07');",
  "process.stdout.write('\\x1b[c\\x1b[6n');",
  "setTimeout(() => {",
  "  process.stdout.write('\\r\\nGOT ' + JSON.stringify(got || 'NO REPLY') + '\\r\\n');",
  "  process.exit(0);",
  "}, Number(process.env.PROBE_WAIT_MS || 1500));"
].join("\n");

async function withTempDir(fn) {
  // realpath: on macOS os.tmpdir() is a symlink, and a program's cwd is the real path.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-pty-")));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The system folders of every test that runs a fake agent: never Homebrew's
// or /usr/local, where a real agent could live.
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// A small, explicit environment. SHELL is the suite's stand-in login shell
// (the only SHELL a test uses), so nothing ever runs the developer's own
// shell setup.
function ptyEnv(home, extra = {}) {
  return { PATH: SYSTEM_PATH, HOME: home, SHELL: FAKE_LOGIN_SHELL, TERM: "xterm-256color", LANG: "en_US.UTF-8", ...extra };
}

async function writeScript(dir, name, source) {
  const file = path.join(dir, name);
  await writeFile(file, source, "utf8");
  return file;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20, what = "the condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function collect(handle) {
  const out = { text: "" };
  handle.onData((chunk) => {
    out.text += chunk;
  });
  return out;
}

// Resolves with the exit info, or null when the program has not ended in time.
function exitOf(handle, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
    handle.onExit((info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A stand-in for node-pty, for tests that must decide exactly what the
// "terminal" sends, or see exactly what reaches it. Nothing runs. Its pid is
// made up, so a test using it always passes NO_TRACKING (a made-up pid must
// never reach the real process tracker, which signals pids).
const NO_TRACKING = { trackPid() {}, untrackPid() {} };
function makeFakePty() {
  const seen = { options: null, resizes: [] };
  const dataListeners = [];
  const child = {
    pid: 4242424,
    onData(listener) {
      dataListeners.push(listener);
      return { dispose() {} };
    },
    onExit() {
      return { dispose() {} };
    },
    write() {},
    resize(cols, rows) {
      seen.resizes.push([cols, rows]);
    },
    kill() {},
    pause() {},
    resume() {}
  };
  return {
    seen,
    emit(chunk) {
      for (const listener of dataListeners) listener(chunk);
    },
    module: {
      spawn(_file, _args, options) {
        seen.options = options;
        return child;
      }
    }
  };
}

test("spawnPty refuses a program without its full path, odd arguments, a relative folder, or no explicit environment", async () => {
  await assert.rejects(() => spawnPty({ command: "claude", args: [], cwd: os.tmpdir(), env: {} }), TypeError);
  await assert.rejects(() => spawnPty({ command: process.execPath, args: ["ok", 3], cwd: os.tmpdir(), env: {} }), TypeError);
  await assert.rejects(() => spawnPty({ command: process.execPath, args: [], cwd: "relative/folder", env: {} }), TypeError);
  await assert.rejects(
    () => spawnPty({ command: process.execPath, args: [], cwd: os.tmpdir() }),
    /never passes on the server's own/
  );
});

test("when node-pty cannot load, ptyAvailable says so in plain words and spawnPty refuses with pty_unavailable", async () => {
  setPtyLoaderForTests(async () => {
    throw new Error("Cannot find package 'node-pty'");
  });
  try {
    assert.equal(PTY_UNAVAILABLE_REASON, "Agent OS could not load its terminal module on this computer.");
    assert.deepEqual(await ptyAvailable(), { ok: false, reason: PTY_UNAVAILABLE_REASON });
    await assert.rejects(
      () => spawnPty({ command: process.execPath, args: [], cwd: os.tmpdir(), env: {} }),
      (error) => error.code === "pty_unavailable" && error.message === PTY_UNAVAILABLE_REASON
    );
  } finally {
    setPtyLoaderForTests(null);
  }
});

test("when node-pty loads but cannot start a program, ptyAvailable says no and spawnPty reports spawn_failed", async () => {
  const broken = {
    spawn() {
      throw new Error("posix_spawnp failed.");
    }
  };
  setPtyLoaderForTests(async () => broken);
  try {
    assert.deepEqual(await ptyAvailable(), { ok: false, reason: PTY_UNAVAILABLE_REASON });
    await assert.rejects(
      () => spawnPty({ command: process.execPath, args: [], cwd: os.tmpdir(), env: {} }),
      (error) => error.code === "spawn_failed" && /posix_spawnp failed/.test(error.message)
    );
  } finally {
    setPtyLoaderForTests(null);
  }
});

// node-pty's spawn-helper (macOS, Linux) exits 1 without a word when the
// program or the folder is bad, so pty-host checks both first and says so.
const SPAWN_FAILED_SENTENCE = (name) =>
  `Agent OS couldn't start ${name}. Check that it is installed and that the folder still exists.`;
const isSpawnFailed = (name) => (error) =>
  error.code === "spawn_failed" && error.status === 500 && error.message === SPAWN_FAILED_SENTENCE(name);

test("a program that does not exist is a spawn_failed with a plain sentence, not a silent exit 1", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => spawnPty({ command: path.join(dir, "no-such-agent"), args: [], cwd: dir, env: ptyEnv(dir) }),
      isSpawnFailed("no-such-agent")
    );
  });
});

test("a file that is not executable, or a folder instead of a program, is a spawn_failed", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const plain = await writeScript(dir, "plain-agent", "#!/bin/sh\nexit 0\n");
    await chmod(plain, 0o644);
    await assert.rejects(() => spawnPty({ command: plain, args: [], cwd: dir, env: ptyEnv(dir) }), isSpawnFailed("plain-agent"));
    await mkdir(path.join(dir, "folder-agent"));
    await assert.rejects(
      () => spawnPty({ command: path.join(dir, "folder-agent"), args: [], cwd: dir, env: ptyEnv(dir) }),
      isSpawnFailed("folder-agent")
    );
  });
});

test("a folder that was removed after the folder check, or is a file, is a spawn_failed", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const gone = path.join(dir, "removed-folder");
    await mkdir(gone);
    await rm(gone, { recursive: true });
    await assert.rejects(
      () => spawnPty({ command: process.execPath, args: [], cwd: gone, env: ptyEnv(dir) }),
      isSpawnFailed(path.basename(process.execPath))
    );
    const file = await writeScript(dir, "not-a-folder.txt", "x");
    await assert.rejects(
      () => spawnPty({ command: process.execPath, args: [], cwd: file, env: ptyEnv(dir) }),
      isSpawnFailed(path.basename(process.execPath))
    );
  });
});

test("ptyAvailable says yes when node-pty loads and runs a test program", SKIP_POSIX, async () => {
  assert.deepEqual(await ptyAvailable(), { ok: true, reason: null });
});

test(
  "a TUI fake agent runs in a real terminal: its argv arrives, typed text echoes, and its exit code comes back",
  SKIP_POSIX,
  async () => {
    await withTempDir(async (dir) => {
      const binDir = path.join(dir, "bin");
      await mkdir(binDir, { recursive: true });
      // All six fake agent names, and the fake folder first on PATH.
      await makeFakeAgentBin(binDir);
      const handle = await spawnPty({
        command: path.join(binDir, "claude"),
        args: ["--session-id", SAMPLE_UUID],
        cwd: dir,
        env: ptyEnv(dir, { PATH: `${binDir}:${SYSTEM_PATH}` }),
        cols: 100,
        rows: 30
      });
      try {
        const out = collect(handle);
        const exit = exitOf(handle);
        await waitFor(() => out.text.includes("FAKE_ARGV") && out.text.includes("> "), {
          what: "the fake's start line and prompt"
        });
        assert.ok(out.text.includes(JSON.stringify("--session-id")), "the fake saw --session-id");
        assert.ok(out.text.includes(JSON.stringify(SAMPLE_UUID)), "the fake saw the session id");
        handle.write("hello there\r");
        await waitFor(() => out.text.includes("hello there"), { what: "the echo" });
        handle.write("exit 3\r");
        assert.deepEqual(await exit, { exitCode: 3, signal: null });
      } finally {
        handle.kill("SIGKILL");
      }
    });
  }
);

test("the program gets exactly the environment and folder it is given, never the server's own", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "env-probe.mjs", ENV_PROBE);
    const previous = process.env.AGENT_OS_TOKEN;
    process.env.AGENT_OS_TOKEN = "must-not-leak";
    let handle = null;
    try {
      handle = await spawnPty({
        command: process.execPath,
        args: [script],
        cwd: dir,
        env: ptyEnv(dir, { SESSION_MARKER: "m-1" })
      });
      const out = collect(handle);
      const line = await waitFor(() => out.text.match(/ENV (\{.*\})/), { what: "the environment report" });
      assert.deepEqual(JSON.parse(line[1]), { marker: "m-1", token: null, term: "xterm-256color", cwd: dir });
      assert.equal((await exitOf(handle))?.exitCode, 0);
    } finally {
      handle?.kill("SIGKILL");
      if (previous === undefined) delete process.env.AGENT_OS_TOKEN;
      else process.env.AGENT_OS_TOKEN = previous;
    }
  });
});

test("output that arrives before anyone listens is kept for the first listener", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "env-probe.mjs", ENV_PROBE);
    const handle = await spawnPty({ command: process.execPath, args: [script], cwd: dir, env: ptyEnv(dir) });
    try {
      // The program prints and ends while nobody listens to its output yet.
      assert.equal((await exitOf(handle))?.exitCode, 0);
      const out = collect(handle);
      await waitFor(() => out.text.includes("ENV {"), { what: "the kept output" });
    } finally {
      handle.kill("SIGKILL");
    }
  });
});

test("early output is kept as the first 1 MB in one piece: a chunk over the limit is cut, and nothing after it sneaks in", async () => {
  const LIMIT = 1024 * 1024;
  const fake = makeFakePty();
  setPtyLoaderForTests(async () => fake.module);
  try {
    const handle = await spawnPty({ command: process.execPath, args: [], cwd: os.tmpdir(), env: {}, tracker: NO_TRACKING });
    // Three chunks before anyone listens: the second crosses 1 MB, the third would fit by itself.
    const everything = "a".repeat(900000) + "b".repeat(200000) + "c".repeat(10000);
    fake.emit("a".repeat(900000));
    fake.emit("b".repeat(200000));
    fake.emit("c".repeat(10000));
    let got = "";
    handle.onData((chunk) => {
      got += chunk;
    });
    await sleep(20);
    assert.ok(got.length >= 900000 && got.length <= LIMIT, `kept ${got.length} characters`);
    assert.equal(got, everything.slice(0, got.length), "what was kept is the start of the output, with no hole");
    assert.ok(!got.includes("c"), "the later, smaller chunk was dropped, not stitched on after a gap");
    fake.emit("live");
    assert.ok(got.endsWith("live"), "output after the first listener arrives live");

    // The cut never splits an emoji (a surrogate pair) in half.
    const second = makeFakePty();
    setPtyLoaderForTests(async () => second.module);
    const other = await spawnPty({ command: process.execPath, args: [], cwd: os.tmpdir(), env: {}, tracker: NO_TRACKING });
    second.emit("a".repeat(LIMIT - 1));
    second.emit("\u{1F600}"); // two UTF-16 units; only one would fit
    let kept = "";
    other.onData((chunk) => {
      kept += chunk;
    });
    await sleep(20);
    assert.equal(kept, "a".repeat(LIMIT - 1));
  } finally {
    setPtyLoaderForTests(null);
  }
});

test("a size that is not allowed never reaches node-pty; the allowed ones do", async () => {
  const fake = makeFakePty();
  setPtyLoaderForTests(async () => fake.module);
  try {
    const handle = await spawnPty({ command: process.execPath, args: [], cwd: os.tmpdir(), env: {}, tracker: NO_TRACKING });
    for (const [cols, rows] of [[0, 25], [90, 0], [-3, 25], [90.5, 25], [90, 25.5], [501, 25], [90, 201], [NaN, 25], [90, undefined]]) {
      handle.resize(cols, rows);
    }
    assert.deepEqual(fake.seen.resizes, [], "none of the impossible sizes was passed on");
    handle.resize(500, 200);
    handle.resize(1, 1);
    handle.resize(90, 25);
    assert.deepEqual(fake.seen.resizes, [[500, 200], [1, 1], [90, 25]]);
  } finally {
    setPtyLoaderForTests(null);
  }
});

test("resize reaches the program, and an impossible size is ignored", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "size-probe.mjs", SIZE_PROBE);
    const handle = await spawnPty({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: ptyEnv(dir),
      cols: 100,
      rows: 30
    });
    try {
      const out = collect(handle);
      await waitFor(() => out.text.includes("SIZE 100x30"), { what: "the first size" });
      handle.resize(90, 25);
      await waitFor(() => out.text.includes("SIZE 90x25"), { what: "the new size" });
      // Each of these would change the program's size if it got through
      // (a fractional size is rounded down by the system), so the program
      // would print a new SIZE line. They are ignored, and never thrown.
      for (const [cols, rows] of [[0, 25], [100.5, 25], [90, 30.5], [600, 25], [90, 201]]) handle.resize(cols, rows);
      await sleep(300); // time for a wrong size change to reach the program
      handle.resize(91, 26);
      await waitFor(() => out.text.includes("SIZE 91x26"), { what: "the size after the ignored ones" });
      assert.deepEqual(
        out.text.match(/SIZE \d+x\d+/g),
        ["SIZE 100x30", "SIZE 90x25", "SIZE 91x26"],
        "the program only ever saw the sizes that were allowed"
      );
    } finally {
      handle.kill("SIGKILL");
    }
  });
});

test("kill reports the signal by name, and a listener added after the end still hears about it", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "sleeper.mjs", SLEEPER);
    const first = await spawnPty({ command: process.execPath, args: [script], cwd: dir, env: ptyEnv(dir) });
    const second = await spawnPty({ command: process.execPath, args: [script], cwd: dir, env: ptyEnv(dir) });
    try {
      const firstExit = exitOf(first);
      first.kill(); // SIGTERM by default
      assert.deepEqual(await firstExit, { exitCode: null, signal: "SIGTERM" });

      const secondExit = exitOf(second);
      second.kill("SIGKILL");
      assert.deepEqual(await secondExit, { exitCode: null, signal: "SIGKILL" });
      assert.deepEqual(await exitOf(second), { exitCode: null, signal: "SIGKILL" }, "a listener added after the end");

      // Everything is a quiet no-op after the end.
      second.write("ignored");
      second.resize(80, 24);
      second.pause();
      second.resume();
      second.kill("SIGKILL");
    } finally {
      first.kill("SIGKILL");
      second.kill("SIGKILL");
    }
  });
});

test("pause stops the program's output until resume", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "ticker.mjs", TICKER);
    const handle = await spawnPty({ command: process.execPath, args: [script], cwd: dir, env: ptyEnv(dir) });
    try {
      let chunks = 0;
      handle.onData(() => {
        chunks += 1;
      });
      await waitFor(() => chunks > 0, { what: "the first tick" });
      handle.pause();
      await sleep(200); // let anything already on its way arrive
      const frozen = chunks;
      await sleep(400);
      assert.equal(chunks, frozen, "no output arrives while paused");
      handle.resume();
      await waitFor(() => chunks > frozen, { what: "output after resume" });
    } finally {
      handle.kill("SIGKILL");
    }
  });
});

test("a program's last words are not lost when it ends while the output is paused", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "last-words.mjs", LAST_WORDS);
    const handle = await spawnPty({ command: process.execPath, args: [script], cwd: dir, env: ptyEnv(dir) });
    try {
      const out = collect(handle);
      const exit = exitOf(handle);
      await waitFor(() => out.text.includes("A\r\n"), { what: "the first line" });
      handle.pause(); // the window fell behind; the program then prints END-MARKER and ends
      const info = await exit;
      assert.deepEqual(info, { exitCode: 0, signal: null });
      assert.ok(out.text.includes("END-MARKER"), `the last output arrived before the end was reported, got ${JSON.stringify(out.text)}`);
      // Flow control after the end stays a quiet no-op.
      handle.resume();
      handle.pause();
    } finally {
      handle.kill("SIGKILL");
    }
  });
});

test("the pid is tracked at the start (with an onExit subscription) and untracked at the end", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "sleeper.mjs", SLEEPER);
    const calls = [];
    let trackedOnExit = null;
    const tracker = {
      trackPid: (pid, onExit) => {
        trackedOnExit = onExit;
        calls.push(["track", pid]);
      },
      untrackPid: (pid) => calls.push(["untrack", pid])
    };
    const handle = await spawnPty({ command: process.execPath, args: [script], cwd: dir, env: ptyEnv(dir), tracker });
    try {
      assert.deepEqual(calls, [["track", handle.pid]]);
      assert.equal(typeof trackedOnExit, "function");
      const heard = [];
      trackedOnExit((info) => heard.push(info));
      const exit = exitOf(handle);
      handle.kill("SIGKILL");
      assert.deepEqual(await exit, { exitCode: null, signal: "SIGKILL" });
      assert.deepEqual(calls, [["track", handle.pid], ["untrack", handle.pid]]);
      assert.deepEqual(heard, [{ exitCode: null, signal: "SIGKILL" }]);
    } finally {
      handle.kill("SIGKILL");
    }
  });
});

test("killAllTracked (quit and Hold to stop all) reaches a PTY program too", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const script = await writeScript(dir, "sleeper.mjs", SLEEPER);
    const handle = await spawnPty({ command: process.execPath, args: [script], cwd: dir, env: ptyEnv(dir) });
    try {
      const exit = exitOf(handle);
      await killAllTracked({ graceMs: 500 });
      const info = await exit;
      assert.ok(info, "the program ended");
      assert.ok(["SIGTERM", "SIGKILL"].includes(info.signal), `ended by ${info.signal}`);
      assert.equal(isAlive(handle.pid), false);
    } finally {
      handle.kill("SIGKILL");
    }
  });
});

// The wiring S6 does for every session: PTY output into the mirror, the
// mirror's replies back into the PTY.
async function runQueryProbe(dir, { writerAttached, waitMs }) {
  const script = await writeScript(dir, "ask.mjs", QUERY_PROBE);
  const alerts = [];
  let handle = null;
  const mirror = createMirror({
    cols: 80,
    rows: 24,
    onQueryReply: (reply) => handle?.write(reply),
    onAlert: (raw) => alerts.push(raw)
  });
  mirror.setWriterAttached(writerAttached);
  try {
    handle = await spawnPty({
      command: process.execPath,
      args: [script],
      cwd: dir,
      env: ptyEnv(dir, { PROBE_WAIT_MS: String(waitMs) }),
      cols: 80,
      rows: 24
    });
    const out = { text: "" };
    handle.onData((chunk) => {
      out.text += chunk;
      mirror.write(chunk);
    });
    const exit = exitOf(handle);
    const match = await waitFor(() => out.text.match(/GOT ("[^"]*")/), { what: "the probe's report" });
    assert.equal((await exit)?.exitCode, 0);
    await mirror.snapshot(); // everything the probe printed has been read
    return { got: JSON.parse(match[1]), alerts };
  } finally {
    handle?.kill("SIGKILL");
    mirror.dispose();
  }
}

test(
  "through a real terminal, the mirror answers a program's DA1 and cursor question while no writer is attached, and forwards its alerts",
  SKIP_POSIX,
  async () => {
    await withTempDir(async (dir) => {
      const { got, alerts } = await runQueryProbe(dir, { writerAttached: false, waitMs: 1500 });
      assert.match(got, /^\x1b\[\?1;2c\x1b\[\d+;\d+R$/);
      assert.deepEqual(alerts, ["bel", "9;from the agent"]);
    });
  }
);

test("through a real terminal, the mirror stays quiet while a writer is attached", SKIP_POSIX, async () => {
  await withTempDir(async (dir) => {
    const { got, alerts } = await runQueryProbe(dir, { writerAttached: true, waitMs: 800 });
    assert.equal(got, "NO REPLY");
    assert.deepEqual(alerts, ["bel", "9;from the agent"], "alerts do not depend on the writer");
  });
});
