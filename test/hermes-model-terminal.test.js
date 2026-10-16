// "Choose in Hermes" on the server (plan brains, Task B1c): the Terminal.app
// helper split out of the sign-in fallback (openCommandInTerminal in
// server/runtime/setup/signin.js), the launch of Hermes's own model picker
// (server/runtime/setup/hermes-model-terminal.js) and its route
// POST /api/setup/hermes/model-terminal (spec §4 and §7, Safety 2's Hermes part).
//
// No real Terminal window and no real agent, ever. The launch functions get an
// injected spawn function that starts nothing. The one route test that reaches
// the real spawn (macOS only) finds a fake `open` first on PATH, the way the
// sign-in route test in test/setup-builders.test.js does. Hermes and Claude
// Code are Task W1's fakes (test/helpers/fake-agents.js); HOME, AGENT_OS_HOME
// and the fake folder are real-path temp folders, and PATH is the fake folder
// plus the system folders. A fake logs a "start" record whenever something
// starts it as a program (not for --version or --help), so a `hermes model`
// run inside Agent OS would show up; the tests check there is none. Nothing in
// this file runs `hermes model` itself (spec Testing): the one control starts
// the fake with a neutral argv, `picker-control`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import {
  HERMES_MODEL_ARGS,
  HERMES_TERMINAL_NAME,
  openHermesModelTerminal
} from "../server/runtime/setup/hermes-model-terminal.js";
import { createSetupRouter } from "../server/runtime/setup/routes.js";
import { TERMINAL_OPEN_WAIT_MS, absoluteBinPath, openCommandInTerminal, openSignInInTerminal } from "../server/runtime/setup/signin.js";
import { FAKE_AGENT_NAMES, FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { refuseSystemAgent } from "./helpers/openclaw-plan-env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posixSkip = {
  skip: process.platform === "win32" ? "POSIX only: the fake agents are sh scripts and file modes are POSIX" : false
};
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const OPEN_OPTIONS = { stdio: "ignore", detached: true, shell: false };
const HOUR_MS = 60 * 60 * 1000;
const PICKER_FILE = /^hermes-model-[0-9a-f]{8}\.command$/;
const SIGNIN_FILE = /^claude-login-[0-9a-f]{8}\.command$/;
const CONFIRM_REQUIRED = { ok: false, error: "confirm must be true" };
const HERMES_NOT_INSTALLED = { error: "agent_not_installed", message: "Hermes isn't installed on this computer yet." };
const NOT_AVAILABLE = { error: "not_available" };
const LOCAL_MODE = {
  DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
  HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
  HERMES_AGENT_OS_PUBLIC_MODE: undefined
};
const NOT_LOCAL_MODES = [
  { DEMO_PUBLIC: "1" },
  { HERMES_AGENT_OS_DEMO_PUBLIC: "yes" },
  { HERMES_AGENT_OS_REQUIRE_AUTH: "1" },
  { HERMES_AGENT_OS_PUBLIC_MODE: "1" }
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

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

// A spawn function that starts nothing: it records the call, then says what
// the program did. "spawn": it started and ended cleanly (a real `open` exits 0
// as soon as Terminal has been asked). "exit1": it started and exited with
// code 1. "hang": it started and is still running (it ends only when a test
// calls `finish` on the child kept in `children`). "error": it could not start.
function fakeSpawn(outcome, calls, children = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    child.finish = (code = 0, signal = null) => child.emit("exit", code, signal);
    children.push(child);
    setImmediate(() => {
      if (outcome === "error") {
        child.emit("error", new Error("could not start"));
        return;
      }
      child.emit("spawn");
      if (outcome === "spawn") child.emit("exit", 0, null);
      else if (outcome === "exit1") child.emit("exit", 1, null);
    });
    return child;
  };
}

async function exists(file) {
  return stat(file).then(
    () => true,
    () => false
  );
}

async function jsonLines(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function startedFakes(agentLog) {
  return (await jsonLines(agentLog)).filter((entry) => entry.event === "start");
}

// A real-path temp HOME and AGENT_OS_HOME; W1's six fake agents (Hermes left
// out with { hermes: false }) and a fake `open` in one folder; and a PATH of
// only that folder and the system folders, so nothing real can be found or
// opened. Local mode, the fake login shell, and no HERMES_HOME.
async function withLaunchEnv(fn, { hermes = true } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-hermes-picker-")));
  const home = path.join(base, "home");
  const agentOsHome = path.join(base, "agent-os");
  const fakeBin = path.join(base, "fake-bin");
  const agentLog = path.join(base, "fake-agents.jsonl");
  await mkdir(home, { recursive: true });
  await mkdir(agentOsHome, { recursive: true });
  await makeFakeAgentBin(fakeBin, { names: FAKE_AGENT_NAMES.filter((name) => hermes || name !== "hermes") });
  await writeFile(path.join(fakeBin, "open"), '#!/bin/sh\necho "$@" >> "$HOME/.fake-open-calls.log"\nexit 0\n');
  await chmod(path.join(fakeBin, "open"), 0o755);
  try {
    await withEnv(
      {
        ...LOCAL_MODE,
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        HERMES_AGENT_OS_HOME: undefined,
        HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
        HERMES_HOME: undefined,
        PATH: [fakeBin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
        SHELL: FAKE_LOGIN_SHELL,
        FAKE_AGENT_LOG: agentLog
      },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        clearDetectCaches();
        try {
          await fn({
            home,
            agentOsHome,
            fakeBin,
            agentLog,
            terminalDir: path.join(agentOsHome, "setup", "terminal"),
            openLog: path.join(home, ".fake-open-calls.log")
          });
        } finally {
          clearDetectCaches();
        }
      }
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// The real Setup router on a real port, with a session manager that records
// every property the router reads from it. The Hermes route must read none,
// so it can never start a session.
async function withSetupApp(fn) {
  const touched = [];
  const sessionManager = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        return () => {
          throw new Error(`the session manager was used (${String(property)})`);
        };
      }
    }
  );
  const app = express();
  app.use(express.json());
  app.use("/api/setup", createSetupRouter({ sessionManager }));
  app.use((error, _req, res, _next) => {
    res.status(error?.status || 500).json({ ok: false, error: error?.message || "Internal server error" });
  });
  touched.length = 0;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/setup/hermes/model-terminal`;
  const post = async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, json: await response.json() };
  };
  try {
    await fn({ post, touched });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The fake `open` runs detached, so its log line can land a moment after the
// answer. After the first line it waits a short moment (settleMs) and reads
// again, so a second `open` that follows the first would be caught too.
async function waitForOpenLine(openLog, { timeoutMs = 5000, settleMs = 250 } = {}) {
  const readLines = async () => (await readFile(openLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await readLines()).length) break;
    if (Date.now() > deadline) assert.fail("the fake open was never called");
    await delay(50);
  }
  await delay(settleMs);
  const lines = await readLines();
  assert.equal(lines.length, 1, "exactly one open call");
  return lines[0];
}

// Code with its comments taken out, the way the sign-in source scan in
// test/setup-builders.test.js reads it.
async function codeOf(...parts) {
  const source = await readFile(path.join(root, ...parts), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
}

// =====================================================================
// 1. openCommandInTerminal(): the Terminal.app helper (signin.js)
// =====================================================================

test("openCommandInTerminal(): on macOS, a <name>-<8 hex>.command file (0700) holding only the command line, opened with exactly `open -a Terminal <file>`", posixSkip, async () => {
  await withLaunchEnv(async ({ terminalDir }) => {
    const command = "'/opt/fake tools/bin/hermes' model";
    const calls = [];
    const result = await openCommandInTerminal("/opt/fake tools/bin/hermes", ["model"], {
      name: "hermes-model",
      platform: "darwin",
      spawnFn: fakeSpawn("spawn", calls)
    });
    assert.deepEqual(result, { opened: true, command });
    assert.equal(calls.length, 1);
    const file = calls[0].args[2];
    assert.deepEqual(calls[0], { command: "open", args: ["-a", "Terminal", file], options: OPEN_OPTIONS });
    assert.equal(path.dirname(file), terminalDir);
    assert.match(path.basename(file), PICKER_FILE);
    assert.equal(await readFile(file, "utf8"), `${command}\n`, "nothing but the one command line");
    assert.equal((await stat(file)).mode & 0o777, 0o700);
    assert.equal((await stat(terminalDir)).mode & 0o777, 0o700);

    // Every launch gets a file of its own.
    const again = [];
    await openCommandInTerminal("/opt/fake tools/bin/hermes", ["model"], {
      name: "hermes-model",
      platform: "darwin",
      spawnFn: fakeSpawn("spawn", again)
    });
    assert.notEqual(again[0].args[2], file);
    assert.deepEqual((await readdir(terminalDir)).sort(), [path.basename(file), path.basename(again[0].args[2])].sort());
  });
});

test("openCommandInTerminal(): when Terminal can't start, the answer is spawn_failed with the same command", posixSkip, async () => {
  await withLaunchEnv(async () => {
    const command = "/opt/fake/bin/hermes model";
    const failed = await openCommandInTerminal("/opt/fake/bin/hermes", ["model"], {
      name: "hermes-model",
      platform: "darwin",
      spawnFn: fakeSpawn("error", [])
    });
    assert.deepEqual(failed, { opened: false, reason: "spawn_failed", command });
    const thrown = await openCommandInTerminal("/opt/fake/bin/hermes", ["model"], {
      name: "hermes-model",
      platform: "darwin",
      spawnFn: () => {
        throw new Error("spawn EACCES");
      }
    });
    assert.deepEqual(thrown, { opened: false, reason: "spawn_failed", command });
  });
});

test("openCommandInTerminal(): Windows and Linux get the command back to copy; no file is written and nothing is spawned", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome }) => {
    const calls = [];
    const linux = await openCommandInTerminal("/home/a b/.local/bin/hermes", ["model"], {
      name: "hermes-model",
      platform: "linux",
      spawnFn: fakeSpawn("spawn", calls)
    });
    assert.deepEqual(linux, { opened: false, reason: "copy", command: "'/home/a b/.local/bin/hermes' model" });
    const windows = await openCommandInTerminal("C:\\Users\\a b\\hermes\\hermes.exe", ["model"], {
      name: "hermes-model",
      platform: "win32",
      spawnFn: fakeSpawn("spawn", calls)
    });
    assert.deepEqual(windows, { opened: false, reason: "copy", command: '"C:\\Users\\a b\\hermes\\hermes.exe" model' });
    assert.equal(calls.length, 0);
    assert.equal(await exists(path.join(agentOsHome, "setup")), false);
  });
});

test("openCommandInTerminal(): the name is only lower-case letters, digits and dashes, else a TypeError before anything is written or spawned", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome }) => {
    const calls = [];
    const bad = [undefined, null, 7, "", "Hermes", "hermes model", "../hermes", "hermes/model", "hermes.model", "hermes_model", "a".repeat(41)];
    for (const name of bad) {
      for (const platform of ["darwin", "linux"]) {
        await assert.rejects(
          openCommandInTerminal("/opt/fake/bin/hermes", ["model"], { name, platform, spawnFn: fakeSpawn("spawn", calls) }),
          TypeError,
          `name ${String(name)} on ${platform}`
        );
      }
    }
    assert.equal(calls.length, 0);
    assert.equal(await exists(path.join(agentOsHome, "setup")), false);
    for (const name of ["a", "a".repeat(40), "claude-login", "cursor-login", HERMES_TERMINAL_NAME]) {
      const answer = await openCommandInTerminal("/opt/fake/bin/hermes", ["model"], {
        name,
        platform: "linux",
        spawnFn: fakeSpawn("spawn", calls)
      });
      assert.equal(answer.reason, "copy", `name ${name}`);
    }
  });
});

test("openCommandInTerminal(): opened follows open's exit, not only its start: exit 1 is spawn_failed, a clean exit is opened, and still running after the wait counts as opened", posixSkip, async () => {
  await withLaunchEnv(async () => {
    const command = "/opt/fake/bin/hermes model";
    const launch = (spawnFn, extra = {}) =>
      openCommandInTerminal("/opt/fake/bin/hermes", ["model"], { name: "hermes-model", platform: "darwin", spawnFn, ...extra });

    assert.deepEqual(await launch(fakeSpawn("exit1", [])), { opened: false, reason: "spawn_failed", command });
    assert.deepEqual(await launch(fakeSpawn("spawn", [])), { opened: true, command });
    // Ended by a signal, so no exit code at all: not a clean exit either.
    const killed = (_command, _args, _options) => {
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => {
        child.emit("spawn");
        child.emit("exit", null, "SIGKILL");
      });
      return child;
    };
    assert.deepEqual(await launch(killed), { opened: false, reason: "spawn_failed", command });

    // Still running when the wait is over: Terminal was asked, so it counts as opened, and only after the wait.
    const startedAt = Date.now();
    assert.deepEqual(await launch(fakeSpawn("hang", []), { exitWaitMs: 150 }), { opened: true, command });
    assert.ok(Date.now() - startedAt >= 120, "it waited for open before calling it opened");

    // A non-zero exit that comes while it waits ends the wait at once.
    const children = [];
    const late = launch(fakeSpawn("hang", [], children), { exitWaitMs: 5000 });
    await waitUntil(() => children.length === 1, "the launch");
    setTimeout(() => children[0].finish(1), 40);
    const lateAt = Date.now();
    assert.deepEqual(await late, { opened: false, reason: "spawn_failed", command });
    assert.ok(Date.now() - lateAt < 3000, "it did not wait out the whole time");

    // The wait is 5 s unless a test says otherwise.
    assert.equal(TERMINAL_OPEN_WAIT_MS, 5000);
  });
});

test("openCommandInTerminal(): one launch at a time per name: a second call while one is in flight gets the same answer and opens no second window; another name is independent; a call after it ended launches again", posixSkip, async () => {
  await withLaunchEnv(async ({ terminalDir }) => {
    const command = "/opt/fake/bin/hermes model";
    const calls = [];
    const children = [];
    const secondCalls = [];
    const launch = (spawnFn, name = "hermes-model") =>
      openCommandInTerminal("/opt/fake/bin/hermes", ["model"], { name, platform: "darwin", spawnFn, exitWaitMs: 5000 });

    const first = launch(fakeSpawn("hang", calls, children));
    await waitUntil(() => children.length === 1, "the first launch to start Terminal");
    // A double click: the same name again while the first is still waiting for open.
    const second = launch(fakeSpawn("spawn", secondCalls));
    // Another name does not wait for it.
    const otherCalls = [];
    const other = await launch(fakeSpawn("spawn", otherCalls), "claude-login");
    assert.deepEqual(other, { opened: true, command });
    assert.equal(otherCalls.length, 1, "another name launches on its own");

    children[0].finish(0);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, { opened: true, command });
    assert.deepEqual(b, a, "the same answer");
    assert.equal(calls.length, 1);
    assert.equal(secondCalls.length, 0, "no second Terminal window");
    const files = (await readdir(terminalDir)).filter((name) => name.startsWith("hermes-model-"));
    assert.equal(files.length, 1, "no second file either");

    // Once it has ended, the same name launches again.
    const again = [];
    assert.deepEqual(await launch(fakeSpawn("spawn", again)), { opened: true, command });
    assert.equal(again.length, 1);
    // A launch that failed also frees the name.
    assert.deepEqual(await launch(fakeSpawn("exit1", [])), { opened: false, reason: "spawn_failed", command });
    const afterFailure = [];
    assert.deepEqual(await launch(fakeSpawn("spawn", afterFailure)), { opened: true, command });
    assert.equal(afterFailure.length, 1);
  });
});

test("openCommandInTerminal(): a binPath that is not a non-empty absolute path, or args that are not an array of strings, is a TypeError before anything is written or spawned", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome }) => {
    const calls = [];
    const badPaths = [undefined, null, 7, "", "hermes", "./hermes", "bin/hermes", "~/bin/hermes", ["/opt/fake/bin/hermes"], {}];
    const badArgs = [undefined, null, "model", ["model", 1], [null], [["model"]], ["model", undefined], { 0: "model", length: 1 }];
    for (const platform of ["darwin", "linux", "win32"]) {
      for (const binPath of [...badPaths, ...(platform === "win32" ? ["hermes.exe", "..\\hermes.exe"] : [])]) {
        await assert.rejects(
          openCommandInTerminal(binPath, ["model"], { name: "hermes-model", platform, spawnFn: fakeSpawn("spawn", calls) }),
          TypeError,
          `binPath ${String(binPath)} on ${platform}`
        );
      }
      for (const args of badArgs) {
        await assert.rejects(
          openCommandInTerminal("/opt/fake/bin/hermes", args, { name: "hermes-model", platform, spawnFn: fakeSpawn("spawn", calls) }),
          TypeError,
          `args ${JSON.stringify(args)} on ${platform}`
        );
      }
    }
    assert.equal(calls.length, 0);
    assert.equal(await exists(path.join(agentOsHome, "setup")), false, "nothing was written");

    // The plain cases still work: an empty list of arguments, and a Windows path on Windows.
    const linux = await openCommandInTerminal("/opt/fake/bin/hermes", [], { name: "hermes-model", platform: "linux", spawnFn: fakeSpawn("spawn", calls) });
    assert.deepEqual(linux, { opened: false, reason: "copy", command: "/opt/fake/bin/hermes" });
    const windows = await openCommandInTerminal("C:\\Users\\a b\\hermes\\hermes.exe", ["model"], {
      name: "hermes-model",
      platform: "win32",
      spawnFn: fakeSpawn("spawn", calls)
    });
    assert.equal(windows.reason, "copy");
  });
});

test("waitForOpenLine: a second open that follows the first one a moment later is caught", posixSkip, async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-open-line-")));
  try {
    const log = path.join(dir, "open.log");
    await writeFile(log, "-a Terminal /one.command\n");
    const second = delay(80).then(() => appendFile(log, "-a Terminal /two.command\n"));
    await assert.rejects(waitForOpenLine(log), /exactly one open call/);
    await second;
    // Control: one line with nothing after it passes.
    const calm = path.join(dir, "calm.log");
    await writeFile(calm, "-a Terminal /one.command\n");
    assert.equal(await waitForOpenLine(calm), "-a Terminal /one.command");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openCommandInTerminal(): .command files older than an hour are swept first, the picker's and the sign-in's alike", posixSkip, async () => {
  await withLaunchEnv(async ({ terminalDir }) => {
    await mkdir(terminalDir, { recursive: true });
    const old = new Date(Date.now() - 2 * HOUR_MS);
    for (const name of ["claude-login-00000000.command", "hermes-model-11111111.command", "notes.txt"]) {
      await writeFile(path.join(terminalDir, name), "x\n");
      await utimes(path.join(terminalDir, name), old, old);
    }
    await writeFile(path.join(terminalDir, "hermes-model-22222222.command"), "x\n");
    const calls = [];
    await openCommandInTerminal("/opt/fake/bin/hermes", ["model"], {
      name: "hermes-model",
      platform: "darwin",
      spawnFn: fakeSpawn("spawn", calls)
    });
    assert.deepEqual(
      (await readdir(terminalDir)).sort(),
      ["hermes-model-22222222.command", "notes.txt", path.basename(calls[0].args[2])].sort()
    );
  });
});

test("openSignInInTerminal(): the sign-in answers, file name and content are unchanged, and Hermes is still not a sign-in agent", posixSkip, async () => {
  await withLaunchEnv(async ({ fakeBin, terminalDir }) => {
    const command = `${path.join(fakeBin, "claude")} auth login`;
    const calls = [];
    const opened = await openSignInInTerminal("claude", { platform: "darwin", spawnFn: fakeSpawn("spawn", calls) });
    assert.deepEqual(opened, { opened: true, command });
    assert.equal(calls.length, 1);
    const file = calls[0].args[2];
    assert.deepEqual(calls[0], { command: "open", args: ["-a", "Terminal", file], options: OPEN_OPTIONS });
    assert.equal(path.dirname(file), terminalDir);
    assert.match(path.basename(file), SIGNIN_FILE);
    assert.equal(await readFile(file, "utf8"), `${command}\n`);
    assert.equal((await stat(file)).mode & 0o777, 0o700);

    const failed = await openSignInInTerminal("claude", { platform: "darwin", spawnFn: fakeSpawn("error", []) });
    assert.deepEqual(failed, { opened: false, reason: "spawn_failed", command });
    for (const platform of ["linux", "win32"]) {
      const copy = await openSignInInTerminal("claude", { platform, spawnFn: fakeSpawn("spawn", calls) });
      assert.deepEqual(copy, { opened: false, reason: "copy", command });
    }
    assert.equal(calls.length, 1, "the copy answers spawn nothing");
    await assert.rejects(
      openSignInInTerminal("hermes", { platform: "darwin", spawnFn: fakeSpawn("spawn", calls) }),
      (error) => error.code === "invalid_agent"
    );
  });
});

// =====================================================================
// 2. openHermesModelTerminal(): Hermes's own model picker
// =====================================================================

test("HERMES_MODEL_ARGS is exactly [\"model\"] and frozen; HERMES_TERMINAL_NAME is hermes-model", () => {
  assert.deepEqual(HERMES_MODEL_ARGS, ["model"]);
  assert.ok(Object.isFrozen(HERMES_MODEL_ARGS));
  assert.throws(() => HERMES_MODEL_ARGS.push("--yolo"), TypeError);
  assert.equal(HERMES_TERMINAL_NAME, "hermes-model");
});

test("openHermesModelTerminal(): opens `<detected hermes> model` in Terminal.app; `hermes model` never runs inside Agent OS and no session is made", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome, fakeBin, agentLog, terminalDir }) => {
    const hermes = path.join(fakeBin, "hermes");
    const calls = [];
    const result = await openHermesModelTerminal({ platform: "darwin", spawnFn: fakeSpawn("spawn", calls) });
    assert.deepEqual(result, { opened: true, command: `${hermes} model` });
    assert.equal(calls.length, 1, "exactly one program was asked for");
    const file = calls[0].args[2];
    assert.deepEqual(calls[0], { command: "open", args: ["-a", "Terminal", file], options: OPEN_OPTIONS });
    assert.equal(path.dirname(file), terminalDir);
    assert.match(path.basename(file), PICKER_FILE);
    assert.equal(await readFile(file, "utf8"), `${hermes} model\n`, "the file holds only <hermes path> model");
    assert.equal((await stat(file)).mode & 0o777, 0o700);
    // No PTY session: nothing started the fake as a program (detection's
    // --version and --help answers log nothing).
    assert.deepEqual(await startedFakes(agentLog), []);
    // No agent session either (an agent session would write this folder; a
    // setup session never does, so the start log above and the import check in
    // section 4 cover that kind).
    assert.equal(await exists(path.join(agentOsHome, "sessions")), false);

    // Control: a fake started as a program does log a start, so the check above can fail.
    spawnSync(hermes, ["picker-control"], { input: "", env: process.env, timeout: 10000 });
    assert.deepEqual(
      (await startedFakes(agentLog)).map((entry) => entry.argv),
      [["picker-control"]]
    );
  });
});

test("openHermesModelTerminal(): Hermes not installed is agent_not_installed with its sentence; a Hermes installed a moment later is found at once", posixSkip, async () => {
  await withLaunchEnv(
    async ({ agentOsHome, fakeBin }) => {
      // No fake hermes here, so detection would find and run a real one in a system folder: stop first.
      await refuseSystemAgent("hermes");
      const calls = [];
      await assert.rejects(openHermesModelTerminal({ platform: "darwin", spawnFn: fakeSpawn("spawn", calls) }), (error) => {
        assert.equal(error.code, "agent_not_installed");
        assert.equal(error.message, "Hermes isn't installed on this computer yet.");
        return true;
      });
      assert.equal(calls.length, 0);
      assert.equal(await exists(path.join(agentOsHome, "setup")), false);

      // Installed a moment later, well inside the 30 s detect cache: a fresh look finds it.
      await makeFakeAgentBin(fakeBin, { names: ["hermes"] });
      const result = await openHermesModelTerminal({ platform: "darwin", spawnFn: fakeSpawn("spawn", calls) });
      assert.deepEqual(result, { opened: true, command: `${path.join(fakeBin, "hermes")} model` });
      assert.equal(calls.length, 1);
    },
    { hermes: false }
  );
});

test("openHermesModelTerminal(): spawn_failed and the copy answer carry the same fixed command", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome, fakeBin }) => {
    const command = `${path.join(fakeBin, "hermes")} model`;
    const calls = [];
    for (const platform of ["linux", "win32"]) {
      const copy = await openHermesModelTerminal({ platform, spawnFn: fakeSpawn("spawn", calls) });
      assert.deepEqual(copy, { opened: false, reason: "copy", command });
    }
    assert.equal(calls.length, 0);
    assert.equal(await exists(path.join(agentOsHome, "setup")), false, "the copy answer writes no file");
    const failed = await openHermesModelTerminal({ platform: "darwin", spawnFn: fakeSpawn("error", calls) });
    assert.deepEqual(failed, { opened: false, reason: "spawn_failed", command });
  });
});

test("openHermesModelTerminal(): nothing a caller passes reaches the command, the file name or the argv", posixSkip, async () => {
  await withLaunchEnv(async ({ fakeBin }) => {
    const hermes = path.join(fakeBin, "hermes");
    const calls = [];
    const result = await openHermesModelTerminal({
      platform: "darwin",
      spawnFn: fakeSpawn("spawn", calls),
      name: "evil",
      args: ["--yolo"],
      command: "rm -rf ~",
      binPath: "/tmp/evil",
      path: "/tmp/evil"
    });
    assert.deepEqual(result, { opened: true, command: `${hermes} model` });
    const file = calls[0].args[2];
    assert.deepEqual(calls[0].args, ["-a", "Terminal", file]);
    assert.match(path.basename(file), PICKER_FILE);
    assert.equal(await readFile(file, "utf8"), `${hermes} model\n`);
  });
});

// =====================================================================
// 3. POST /api/setup/hermes/model-terminal
// =====================================================================

test("POST /api/setup/hermes/model-terminal: 200 { opened, command, reason? } with only the fixed command, whatever the request carries; no session", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome, fakeBin, agentLog, terminalDir, openLog }) => {
    const hermes = path.join(fakeBin, "hermes");
    await withSetupApp(async ({ post, touched }) => {
      if (process.platform === "darwin") {
        // The route uses the real spawn, so prove first that PATH finds the fake `open`.
        assert.equal(process.env.PATH.split(path.delimiter)[0], fakeBin);
        assert.ok((await stat(path.join(fakeBin, "open"))).mode & 0o100, "the fake open is executable");
      }
      const answer = await post({ confirm: true, command: "rm -rf ~", args: ["--yolo"], path: "/tmp/evil", name: "evil" });
      assert.equal(answer.status, 200);
      if (process.platform === "darwin") {
        assert.deepEqual(answer.json, { opened: true, command: `${hermes} model` });
        const line = await waitForOpenLine(openLog);
        assert.ok(line.startsWith("-a Terminal "), line);
        const file = line.slice("-a Terminal ".length);
        assert.equal(path.dirname(file), terminalDir);
        assert.match(path.basename(file), PICKER_FILE);
        assert.equal(await readFile(file, "utf8"), `${hermes} model\n`);
      } else {
        assert.deepEqual(answer.json, { opened: false, reason: "copy", command: `${hermes} model` });
        assert.equal(await exists(path.join(agentOsHome, "setup")), false);
      }
      assert.deepEqual(touched, [], "the route never reads the session manager");
    });
    assert.deepEqual(await startedFakes(agentLog), []);
    // (an agent session would write this folder; a setup session never does,
    // so the Proxy and the start log cover that kind)
    assert.equal(await exists(path.join(agentOsHome, "sessions")), false);
  });
});

test("POST /api/setup/hermes/model-terminal: when Terminal can't open the window, the answer is still 200 { opened: false, reason: spawn_failed, command }", { skip: process.platform === "darwin" ? false : "only macOS opens a Terminal window; elsewhere the command is handed back to copy" }, async () => {
  await withLaunchEnv(async ({ fakeBin, openLog }) => {
    const hermes = path.join(fakeBin, "hermes");
    // The fake `open` logs its call and then fails, the way `open` ends when it can't start Terminal.
    await writeFile(path.join(fakeBin, "open"), '#!/bin/sh\necho "$@" >> "$HOME/.fake-open-calls.log"\nexit 1\n');
    await chmod(path.join(fakeBin, "open"), 0o755);
    await withSetupApp(async ({ post, touched }) => {
      assert.equal(process.env.PATH.split(path.delimiter)[0], fakeBin, "PATH finds the fake open first");
      const answer = await post({ confirm: true });
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json, { opened: false, reason: "spawn_failed", command: `${hermes} model` });
      assert.ok((await waitForOpenLine(openLog)).startsWith("-a Terminal "), "the fake open was asked once");
      assert.deepEqual(touched, [], "the route never reads the session manager");
    });
  });
});

test("POST /api/setup/hermes/model-terminal: 400 without confirm: true, and nothing is launched", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome, openLog }) => {
    await withSetupApp(async ({ post, touched }) => {
      for (const body of [undefined, {}, { confirm: "true" }, { confirm: 1 }, { confirm: false }, { confirm: [true] }]) {
        const answer = await post(body);
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.deepEqual(answer.json, CONFIRM_REQUIRED);
      }
      assert.deepEqual(touched, []);
    });
    assert.equal(await exists(path.join(agentOsHome, "setup")), false);
    assert.equal(await exists(openLog), false);
  });
});

test("POST /api/setup/hermes/model-terminal: Hermes not installed is 400 agent_not_installed, written by the route (not mapJobError's 409)", posixSkip, async () => {
  await withLaunchEnv(
    async ({ agentOsHome, openLog }) => {
      // No fake hermes here, so detection would find and run a real one in a system folder: stop first.
      await refuseSystemAgent("hermes");
      await withSetupApp(async ({ post }) => {
        const answer = await post({ confirm: true });
        assert.equal(answer.status, 400);
        assert.deepEqual(answer.json, HERMES_NOT_INSTALLED);
      });
      assert.equal(await exists(path.join(agentOsHome, "setup")), false);
      assert.equal(await exists(openLog), false);
    },
    { hermes: false }
  );
});

test("POST /api/setup/hermes/model-terminal: 404 not_available outside local mode, before anything else", posixSkip, async () => {
  await withLaunchEnv(async ({ agentOsHome, openLog }) => {
    await withSetupApp(async ({ post }) => {
      for (const mode of NOT_LOCAL_MODES) {
        await withEnv({ ...LOCAL_MODE, ...mode }, async () => {
          for (const body of [{ confirm: true }, {}]) {
            const answer = await post(body);
            assert.equal(answer.status, 404, JSON.stringify(mode));
            assert.deepEqual(answer.json, NOT_AVAILABLE);
          }
        });
      }
    });
    assert.equal(await exists(path.join(agentOsHome, "setup")), false);
    assert.equal(await exists(openLog), false);
  });
});

// =====================================================================
// 4. The code itself (Safety 2: fixed commands only, never a session)
// =====================================================================

test("hermes-model-terminal.js reaches only the Hermes adapter, the Terminal helper and spawn: never a session, a PTY or a run", async () => {
  const code = await codeOf("server", "runtime", "setup", "hermes-model-terminal.js");
  const imports = [...code.matchAll(/^import [^;]*? from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ["../agents/index.js", "./signin.js", "node:child_process"]);
  for (const forbidden of [
    "sessions/",
    "node-pty",
    "getSessionManager",
    "createSetupSession",
    "startRun",
    "runCommand",
    "execFile",
    "readFile",
    "createReadStream",
    "openSync"
  ]) {
    assert.ok(!code.includes(forbidden), `hermes-model-terminal.js must not use ${forbidden}`);
  }
  assert.doesNotMatch(code, /\bspawn\(/, "it never starts a program itself");
});

test("openCommandInTerminal spawns only `open -a Terminal <file>`, and the route passes nothing from the request", async () => {
  const signin = await codeOf("server", "runtime", "setup", "signin.js");
  assert.equal((signin.match(/\bspawnFn\(/g) || []).length, 1, "one spawn call in signin.js");
  assert.ok(signin.includes('spawnFn("open", ["-a", "Terminal", file], { stdio: "ignore", detached: true, shell: false })'));
  const routes = await codeOf("server", "runtime", "setup", "routes.js");
  assert.ok(routes.includes('router.post("/hermes/model-terminal", requireLocalMode, async (req, res, next) => {'));
  assert.equal((routes.match(/openHermesModelTerminal\(/g) || []).length, 1);
  assert.ok(routes.includes("await openHermesModelTerminal()"), "called with no argument: nothing from the request");
});

test("absoluteBinPath: a relative detected path becomes absolute, so the Terminal launch never fails with a TypeError; absolute paths are kept", () => {
  assert.equal(absoluteBinPath("/usr/local/bin/hermes", "darwin"), "/usr/local/bin/hermes");
  assert.equal(absoluteBinPath("bin/hermes", "darwin"), path.posix.resolve("bin/hermes"));
  assert.ok(path.posix.isAbsolute(absoluteBinPath("./hermes", "linux")));
  assert.equal(absoluteBinPath("C:\\Tools\\hermes.exe", "win32"), "C:\\Tools\\hermes.exe");
  assert.ok(path.win32.isAbsolute(absoluteBinPath("tools\\hermes.exe", "win32")));
});
