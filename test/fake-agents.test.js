// The TUI-like fake agents every SP3 session test starts (spec "Testing":
// "fakes on PATH ... extended in SP3 with TUI-like behaviour"; planning
// decision Q2): test/fakes/tui-agent.mjs, reached through the shims that
// makeFakeAgentBin() writes. Most tests run them inside a real terminal
// (node-pty), the way Agent OS sessions run the real agents.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FAKE_AGENT_NAMES, FAKE_AGENT_SCRIPT, FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";
import { fakeSiwcProfile, readFakeAgentState, setFakeKnob } from "./helpers/fake-knobs.js";

const require = createRequire(import.meta.url);
const isWindows = process.platform === "win32";
const POSIX_ONLY = {
  skip: isWindows ? "the fake agents are #!/bin/sh shims (POSIX-only), like every fake CLI in this suite" : false
};
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
const ESC = "\x1b";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

async function withBin(options, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-fakes-"));
  try {
    const bin = await makeFakeAgentBin(path.join(dir, "bin"), options);
    return await fn(bin, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// SHELL is the stand-in login shell, as in every test (planning decision Q1c);
// the fake only records it.
function baseEnv(dir, extra = {}) {
  return { PATH: SYSTEM_PATH, HOME: dir, SHELL: FAKE_LOGIN_SHELL, TERM: "xterm-256color", ...extra };
}

// Runs a shim the way agent detection does: no terminal, stdin closed at once.
function runProbe(file, args, env, timeout = 5000) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env, timeout }, (error, stdout) => {
      resolve({ code: error ? (error.code ?? null) : 0, killed: Boolean(error?.killed), stdout: String(stdout) });
    });
    child.stdin?.end();
  });
}

// Like runProbe, for a fake that is meant to keep running: instead of a fixed
// window it polls the fake's log (every 50 ms, up to 5 s) until the fake has
// logged its "run" event (or the `event` given), lets it run a moment longer
// to prove it does not exit, then stops it. A fixed 800 ms window failed on a
// loaded Mac, where a fake needs 400 to 1100 ms from spawn to its first log line.
async function runUntilLogged(file, args, env, log, name, event = "run") {
  let child;
  const finished = new Promise((resolve) => {
    child = execFile(file, args, { env, timeout: 30000 }, (error, stdout) => {
      resolve({ code: error ? (error.code ?? null) : 0, killed: Boolean(error?.killed), stdout: String(stdout) });
    });
  });
  child.stdin?.end();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await readLog(log)).some((entry) => entry.event === event && entry.name === name)) break;
    await delay(50);
  }
  await delay(200);
  child.kill();
  return finished;
}

async function readLog(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Starts a shim in a real terminal and collects what it prints.
function startInPty(file, args, env, { cols = 80, rows = 24 } = {}) {
  const pty = require("node-pty");
  const term = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd: env.HOME, env });
  let output = "";
  let exitInfo = null;
  term.onData((data) => {
    output += data;
  });
  const exited = new Promise((resolve) =>
    term.onExit((info) => {
      exitInfo = info;
      resolve(info);
    })
  );
  return {
    term,
    exited,
    get output() {
      return output;
    },
    get exitInfo() {
      return exitInfo;
    },
    // Waits until the output after position `from` contains `pattern`.
    async waitFor(pattern, label, { from = 0, ms = 8000 } = {}) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const seen = output.slice(from);
        if (typeof pattern === "string" ? seen.includes(pattern) : pattern.test(seen)) return seen;
        await delay(20);
      }
      throw new Error(`timed out waiting for ${label}; last output: ${JSON.stringify(output.slice(-400))}`);
    },
    // Types text (Enter is "\r", as a terminal sends it) and waits for `expected`.
    async type(text, expected, label = text) {
      const from = output.length;
      term.write(text);
      return this.waitFor(expected, label, { from });
    },
    stop() {
      if (exitInfo) return;
      try {
        term.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };
}

function argvRecord(output) {
  const match = output.match(/FAKE_ARGV (\{.*\})/);
  assert.ok(match, "the fake prints FAKE_ARGV first");
  return JSON.parse(match[1]);
}

function pgidOf(pid) {
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

test("makeFakeAgentBin writes one executable shim per agent name, all running test/fakes/tui-agent.mjs", POSIX_ONLY, async () => {
  assert.deepEqual([...FAKE_AGENT_NAMES], ["claude", "codex", "agent", "cursor-agent", "hermes", "openclaw"]);
  assert.ok(FAKE_AGENT_SCRIPT.endsWith(path.join("test", "fakes", "tui-agent.mjs")));
  assert.ok(existsSync(FAKE_AGENT_SCRIPT));
  await withBin({}, async (bin) => {
    assert.deepEqual(Object.keys(bin.paths), FAKE_AGENT_NAMES);
    for (const [name, file] of Object.entries(bin.paths)) {
      assert.equal((await stat(file)).mode & 0o777, 0o755, `${name} is executable`);
      const shim = readFileSync(file, "utf8");
      assert.ok(shim.startsWith("#!/bin/sh\n"));
      assert.ok(shim.includes(`FAKE_AGENT_NAME='${name}'`));
      assert.ok(shim.includes(FAKE_AGENT_SCRIPT));
    }
  });
  await assert.rejects(() => withBin({ mode: "yolo" }, async () => {}), /unknown fake agent mode "yolo"/);
});

test("makeFakeAgentBin replaces a link already at a shim's path instead of writing through it", POSIX_ONLY, async () => {
  // The UI audit harness's fake-bin/ holds links (claude -> fake-agent, codex
  // -> fake-agent, ...). Writing through them would turn every name into the
  // last shim written.
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-fakes-links-"));
  try {
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const shared = path.join(bin, "fake-agent");
    await writeFile(shared, "#!/bin/sh\necho old fake\n");
    await symlink("fake-agent", path.join(bin, "claude"));
    await symlink("fake-agent", path.join(bin, "codex"));
    const made = await makeFakeAgentBin(bin, { names: ["claude", "codex"] });
    assert.equal(readFileSync(shared, "utf8"), "#!/bin/sh\necho old fake\n", "the file the links pointed at is untouched");
    for (const name of ["claude", "codex"]) {
      assert.equal((await lstat(made.paths[name])).isSymbolicLink(), false, `${name} is a file of its own now`);
      assert.equal((await runProbe(made.paths[name], ["--version"], baseEnv(dir))).stdout.trim(), `${name} 9.9.9-fake`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("started without its shim, tui-agent.mjs explains itself and exits, so it can never hang a test run", () => {
  const text = execFileSync(process.execPath, [FAKE_AGENT_SCRIPT], { env: { PATH: SYSTEM_PATH }, encoding: "utf8", input: "" });
  assert.match(text, /fake agent for tests/);
});

test("detection probes answer at once without a terminal, and service controls are logged", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const log = path.join(dir, "fake.log");
    const env = baseEnv(dir, { FAKE_AGENT_LOG: log });
    assert.equal((await runProbe(bin.paths.claude, ["--version"], env)).stdout.trim(), "claude 9.9.9-fake");
    assert.equal((await runProbe(bin.paths.agent, ["-v"], env)).stdout.trim(), "agent 9.9.9-fake");
    assert.match((await runProbe(bin.paths.codex, ["exec", "--help"], env)).stdout, /^Usage: codex/);
    assert.deepEqual(JSON.parse((await runProbe(bin.paths.claude, ["auth", "status"], env)).stdout), { loggedIn: true });
    assert.equal((await runProbe(bin.paths.hermes, ["config", "get", "approvals.mode"], env)).stdout.trim(), "manual");
    assert.equal((await runProbe(bin.paths.openclaw, ["config", "get", "tools.exec.mode"], env)).stdout.trim(), "");
    assert.equal((await runProbe(bin.paths.hermes, ["gateway", "status"], env)).stdout.trim(), "gateway is not running");
    assert.deepEqual(JSON.parse((await runProbe(bin.paths.openclaw, ["gateway", "status", "--json"], env)).stdout), {
      running: false
    });
    const stopped = await runProbe(bin.paths.hermes, ["gateway", "stop"], env);
    assert.equal(stopped.code, 0);
    const entries = await readLog(log);
    assert.deepEqual(
      entries.filter((entry) => entry.event === "gateway").map((entry) => [entry.name, entry.args]),
      [["hermes", ["gateway", "stop"]]]
    );
  });
});

test("agent and cursor-agent answer create-chat with a fresh uuid (spike S6); FAKE_CURSOR_CREATE_CHAT makes it fail, print garbage, print a uuid and still exit 1, or stall; every call is logged", POSIX_ONLY, async () => {
  const UUID_LINE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  await withBin({}, async (bin, dir) => {
    const log = path.join(dir, "fake.log");
    const env = baseEnv(dir, { FAKE_AGENT_LOG: log });
    const ids = [];
    for (const name of ["agent", "cursor-agent"]) {
      const first = await runProbe(bin.paths[name], ["create-chat"], env);
      assert.equal(first.code, 0, name);
      assert.match(first.stdout.trim(), UUID_LINE, `${name}: one uuid, nothing else`);
      assert.equal(first.stdout.trim().split("\n").length, 1, name);
      ids.push(first.stdout.trim(), (await runProbe(bin.paths[name], ["create-chat"], env)).stdout.trim());
    }
    assert.equal(new Set(ids).size, 4, "a fresh id every time");

    const failed = await runProbe(bin.paths.agent, ["create-chat"], { ...env, FAKE_CURSOR_CREATE_CHAT: "fail" });
    assert.deepEqual([failed.code, failed.stdout], [1, ""], "fail: nothing printed, exit 1");
    const garbage = await runProbe(bin.paths.agent, ["create-chat"], { ...env, FAKE_CURSOR_CREATE_CHAT: "garbage" });
    assert.deepEqual([garbage.code, garbage.stdout.trim()], [0, "not-a-uuid"]);
    const uuidExit1 = await runProbe(bin.paths.agent, ["create-chat"], { ...env, FAKE_CURSOR_CREATE_CHAT: "uuid-exit1" });
    assert.equal(uuidExit1.code, 1, "uuid-exit1: exit 1 even though the answer is a good uuid");
    assert.match(uuidExit1.stdout.trim(), UUID_LINE, "uuid-exit1: a fresh uuid is printed");
    const slow = await runUntilLogged(bin.paths.agent, ["create-chat"], { ...env, FAKE_CURSOR_CREATE_CHAT: "slow" }, log, "agent", "create-chat");
    assert.deepEqual([slow.killed, slow.stdout], [true, ""], "slow: still waiting when the caller gives up");

    // Only the Cursor names answer it, and only as exactly `create-chat`.
    assert.doesNotMatch((await runProbe(bin.paths.claude, ["create-chat"], env)).stdout, /[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.doesNotMatch((await runProbe(bin.paths.agent, ["create-chat", "--extra"], env)).stdout.split("FAKE_ARGV")[0], /[0-9a-f]{8}-[0-9a-f]{4}-/);

    const calls = (await readLog(log)).filter((entry) => entry.event === "create-chat");
    assert.deepEqual(
      calls.map((entry) => [entry.name, entry.behaviour]),
      [["agent", "ok"], ["agent", "ok"], ["cursor-agent", "ok"], ["cursor-agent", "ok"], ["agent", "fail"], ["agent", "garbage"], ["agent", "uuid-exit1"], ["agent", "slow"]]
    );
    assert.deepEqual(calls.slice(0, 4).map((entry) => entry.id), ids, "the logged id is the printed one");
    assert.deepEqual([calls[4].id, calls[5].id], [null, null]);
    assert.equal(calls[6].id, uuidExit1.stdout.trim(), "uuid-exit1: the logged id is the printed one");
    assert.deepEqual(calls[0].argv, ["create-chat"]);
  });
});

test("claude agents --json prints FAKE_CLAUDE_AGENTS_JSON (default []), claude stop is logged, agents-hang never answers", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const log = path.join(dir, "fake.log");
    const env = baseEnv(dir, { FAKE_AGENT_LOG: log });
    assert.equal((await runProbe(bin.paths.claude, ["agents", "--json"], env)).stdout.trim(), "[]");
    const listed = JSON.stringify([{ id: "bg-1", pid: 42, kind: "background" }]);
    const custom = await runProbe(bin.paths.claude, ["agents", "--json"], { ...env, FAKE_CLAUDE_AGENTS_JSON: listed });
    assert.equal(custom.stdout.trim(), listed);
    assert.equal((await runProbe(bin.paths.claude, ["stop", "bg-1"], env)).stdout.trim(), "stopped bg-1");
    assert.deepEqual(
      (await readLog(log)).filter((entry) => entry.event === "stop").map((entry) => entry.id),
      ["bg-1"]
    );
    const hung = await runProbe(bin.paths.claude, ["agents", "--json"], { ...env, FAKE_AGENT_MODE: "agents-hang" }, 1000);
    assert.equal(hung.killed, true, "agents-hang must still be running after 1 s");
    assert.equal(hung.stdout, "");
  });
});

test("a headless run (-p, --print or exec) prints nothing and keeps running until it is stopped", POSIX_ONLY, async () => {
  // The Runs page starts these (never a session); the UI audit harness's
  // probes stop live runs, as they did with the harness's earlier fake.
  await withBin({}, async (bin, dir) => {
    const log = path.join(dir, "fake.log");
    const env = baseEnv(dir, { FAKE_AGENT_LOG: log });
    for (const [name, args] of [
      ["claude", ["-p", "--output-format", "text"]],
      ["agent", ["--print", "--output-format", "text"]],
      ["codex", ["exec", "--json", "-"]],
      ["openclaw", ["agent", "exec", "--message-file", "-", "--json"]]
    ]) {
      const run = await runUntilLogged(bin.paths[name], args, env, log, name);
      assert.equal(run.killed, true, `${name} ${args.join(" ")} must still be running once it has logged its run`);
      assert.equal(run.stdout, "");
    }
    assert.deepEqual(
      (await readLog(log)).filter((entry) => entry.event === "run").map((entry) => entry.name),
      ["claude", "agent", "codex", "openclaw"]
    );
  });
});

test("in a terminal it prints FAKE_ARGV (argv, folder, terminal, session variables, never secret values), then a prompt", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const session = startInPty(
      bin.paths.claude,
      ["--session-id", "11111111-2222-4333-8444-555555555555"],
      baseEnv(dir, {
        AGENT_OS_SESSION_ID: "abc",
        AGENT_OS_TOKEN: "do-not-print-me",
        ANTHROPIC_API_KEY: "do-not-print-me-either",
        TERM_PROGRAM: "AgentOS"
      })
    );
    try {
      await session.waitFor(/FAKE_ARGV .*\r[\s\S]*> /, "FAKE_ARGV and the prompt");
      const record = argvRecord(session.output);
      assert.equal(record.name, "claude");
      assert.equal(record.mode, "tui");
      assert.deepEqual(record.argv, ["--session-id", "11111111-2222-4333-8444-555555555555"]);
      assert.equal(record.isTTY, true);
      assert.equal(record.env.TERM, "xterm-256color");
      assert.equal(record.env.TERM_PROGRAM, "AgentOS");
      assert.equal(record.env.AGENT_OS_SESSION_ID, "abc");
      assert.equal(record.env.HOME, dir);
      assert.deepEqual(record.agentOsKeys, ["AGENT_OS_SESSION_ID", "AGENT_OS_TOKEN"]);
      assert.ok(record.secretKeys.includes("AGENT_OS_TOKEN"));
      assert.ok(record.secretKeys.includes("ANTHROPIC_API_KEY"));
      assert.equal(session.output.includes("do-not-print-me"), false, "secret values never reach the screen");
      assert.equal(record.cwd, realpathSync.native(dir), "it runs in the folder it was started in");
    } finally {
      session.stop();
    }
  });
});

test("it echoes typing, handles backspace, and answers typed commands with the terminal sequences the session tests need", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const session = startInPty(bin.paths.codex, ["-C", dir], baseEnv(dir));
    try {
      await session.waitFor("> ", "the prompt");
      await session.type("hello there\r", "you said: hello there");
      await session.type("helo\x7flo\r", "you said: hello");
      await session.type("paste on\r", `${ESC}[?2004h`);
      await session.type(`${ESC}[200~two words${ESC}[201~`, `PASTE ${JSON.stringify("two words")}`);
      await session.type("alt on\r", `${ESC}[?1049h`);
      await session.type("alt off\r", `${ESC}[?1049l`);
      await session.type("mouse on\r", `${ESC}[?1000h${ESC}[?1006h`);
      await session.type("focus on\r", `${ESC}[?1004h`);
      await session.type("keys app\r", `${ESC}[?1h`);
      await session.type("kitty on\r", `${ESC}[>1u`);
      await session.type("bell\r", "\x07");
      await session.type("osc9 Build finished\r", `${ESC}]9;Build finished\x07`);
      await session.type("osc9st Build finished\r", `${ESC}]9;Build finished${ESC}\\`);
      await session.type("osc99 Done\r", `${ESC}]99;;Done${ESC}\\`);
      await session.type("osc777 Done\r", `${ESC}]777;notify;Fake agent;Done\x07`);
      await session.type("title My task\r", `${ESC}]0;My task\x07`);
      await session.type("bottom status line\r", `${ESC}7${ESC}[24;1H${ESC}[2Kstatus line${ESC}8`);
      await session.type("lines 3\r", /line 1\r+\nline 2\r+\nline 3/);
      await session.type(`${ESC}[<0;10;5M`, `KEY ${JSON.stringify(`${ESC}[<0;10;5M`)}`);
    } finally {
      session.stop();
    }
  });
});

test("it asks DA1, DSR and kitty flags, and prints the replies it receives (and focus reports)", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const session = startInPty(bin.paths.agent, ["--workspace", dir], baseEnv(dir));
    try {
      await session.waitFor("> ", "the prompt");
      await session.type("ask\r", `${ESC}[c${ESC}[6n`);
      await session.type(`${ESC}[?1;2c${ESC}[12;5R`, `REPLY ${JSON.stringify(`${ESC}[12;5R`)}`);
      assert.ok(session.output.includes(`REPLY ${JSON.stringify(`${ESC}[?1;2c`)}`));
      await session.type("ask kitty\r", `${ESC}[?u`);
      await session.type(`${ESC}[?1u`, `REPLY ${JSON.stringify(`${ESC}[?1u`)}`);
      await session.type(`${ESC}[I`, `REPLY ${JSON.stringify(`${ESC}[I`)}`);
    } finally {
      session.stop();
    }
  });
});

test("ask after <ms> asks DA1 and DSR only after the delay", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const session = startInPty(bin.paths.agent, ["--workspace", dir], baseEnv(dir));
    try {
      await session.waitFor("> ", "the prompt");
      const from = session.output.length;
      session.term.write("ask after 400\r");
      await delay(150);
      assert.equal(session.output.slice(from).includes(`${ESC}[c`), false, "not asked at once");
      await session.waitFor(`${ESC}[c${ESC}[6n`, "the delayed questions", { from });
    } finally {
      session.stop();
    }
  });
});

test("exit <n> ends the fake with that exit code", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const session = startInPty(bin.paths.hermes, ["--in", dir], baseEnv(dir));
    try {
      await session.waitFor("> ", "the prompt");
      session.term.write("exit 3\r");
      const info = await session.exited;
      assert.equal(info.exitCode, 3);
    } finally {
      session.stop();
    }
  });
});

test("mode setsid-grandchild starts a grandchild in its own process group and writes its pid", POSIX_ONLY, async () => {
  await withBin({ mode: "setsid-grandchild" }, async (bin, dir) => {
    const pidFile = path.join(dir, "grandchild.pid");
    const session = startInPty(bin.paths.openclaw, ["tui", "--session", "agentos-x"], baseEnv(dir, { FAKE_AGENT_PIDFILE: pidFile }));
    let grandchild = null;
    try {
      const seen = await session.waitFor(/GRANDCHILD:(\d+)/, "the grandchild pid");
      grandchild = Number(seen.match(/GRANDCHILD:(\d+)/)[1]);
      assert.equal(Number(readFileSync(pidFile, "utf8")), grandchild);
      assert.equal(argvRecord(session.output).mode, "setsid-grandchild");
      assert.notEqual(pgidOf(grandchild), pgidOf(session.term.pid), "the grandchild left the fake's process group");
    } finally {
      session.stop();
      if (grandchild) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

test("mode updater (set through the environment) asks a question and prints the typed answer", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const session = startInPty(bin.paths.hermes, ["update"], baseEnv(dir, { FAKE_AGENT_MODE: "updater" }));
    try {
      await session.waitFor("Update now? [y/N] ", "the question");
      assert.deepEqual(argvRecord(session.output).argv, ["update"]);
      await session.type("y\r", "ANSWER y");
      assert.equal((await session.exited).exitCode, 0);
    } finally {
      session.stop();
    }
  });
});

test("SIGTERM is logged with a snapshot of the session's file, then ends the fake by that signal; mode ignore-term survives it", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const log = path.join(dir, "fake.log");
    // Task S8's quit test learns the session id only after the session starts,
    // so it names the file with a placeholder that the fake fills in from its
    // own AGENT_OS_SESSION_ID.
    const sessionId = "11111111-2222-4333-8444-555555555555";
    await mkdir(path.join(dir, "sessions", sessionId), { recursive: true });
    await writeFile(path.join(dir, "sessions", sessionId, "meta.json"), JSON.stringify({ status: "exited", endedBy: "quit" }));
    const snapshotOnTerm = path.join(dir, "sessions", "{AGENT_OS_SESSION_ID}", "meta.json");

    const plain = startInPty(
      bin.paths.claude,
      [],
      baseEnv(dir, { FAKE_AGENT_LOG: log, FAKE_AGENT_SNAPSHOT_ON_TERM: snapshotOnTerm, AGENT_OS_SESSION_ID: sessionId })
    );
    try {
      await plain.waitFor("> ", "the prompt");
      const before = Date.now();
      process.kill(plain.term.pid, "SIGTERM");
      assert.equal((await plain.exited).signal, os.constants.signals.SIGTERM);
      const entries = await readLog(log);
      const entry = entries.find((item) => item.event === "sigterm" && item.pid === plain.term.pid);
      assert.equal(entry.snapshotError, undefined);
      assert.deepEqual(JSON.parse(entry.snapshot), { status: "exited", endedBy: "quit" });
      assert.equal(entry.name, "claude");
      assert.ok(entry.at >= before, "every entry carries its time, so a test can put events in order");
      assert.ok(entries.some((item) => item.event === "start" && item.pid === plain.term.pid), "the start is logged too");
    } finally {
      plain.stop();
    }

    const stubborn = startInPty(
      bin.paths.claude,
      [],
      baseEnv(dir, { FAKE_AGENT_LOG: log, FAKE_AGENT_MODE: "ignore-term", FAKE_AGENT_SNAPSHOT_ON_TERM: path.join(dir, "missing.json") })
    );
    try {
      await stubborn.waitFor("> ", "the prompt");
      process.kill(stubborn.term.pid, "SIGTERM");
      await delay(500);
      assert.equal(stubborn.exitInfo, null, "ignore-term must survive SIGTERM");
      const entry = (await readLog(log)).find((item) => item.event === "sigterm" && item.pid === stubborn.term.pid);
      assert.equal(entry.snapshotError, "ENOENT", "a file that cannot be read is named by its error code");
      process.kill(stubborn.term.pid, "SIGKILL");
      assert.equal((await stubborn.exited).signal, os.constants.signals.SIGKILL);
    } finally {
      stubborn.stop();
    }
  });
});

test("the stand-in login shell runs the command with the PATH it was given and reads no startup file", POSIX_ONLY, async () => {
  assert.ok(FAKE_LOGIN_SHELL.endsWith(path.join("test", "fakes", "login-shell.sh")));
  assert.equal((await stat(FAKE_LOGIN_SHELL)).mode & 0o777, 0o755, "it is executable");
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-login-shell-"));
  try {
    // Startup files that would change PATH and leave a mark if any shell read them.
    const mark = path.join(dir, "startup-ran");
    const startup = `touch ${shQuote(mark)}\nPATH=/opt/homebrew/bin:/usr/local/bin:$PATH\nexport PATH\n`;
    for (const file of [".profile", ".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", "env.sh"]) {
      await writeFile(path.join(dir, file), startup);
    }
    const given = [path.join(dir, "bin"), SYSTEM_PATH].join(path.delimiter);
    // shell-env.js's form (Task S2): -i -l -c '<node> -e <script>'.
    const command = `${shQuote(process.execPath)} -e ${shQuote("process.stdout.write(JSON.stringify({ PATH: process.env.PATH }))")}`;
    const stdout = execFileSync(FAKE_LOGIN_SHELL, ["-i", "-l", "-c", command], {
      env: { PATH: given, HOME: dir, ZDOTDIR: dir, ENV: path.join(dir, "env.sh"), BASH_ENV: path.join(dir, "env.sh") },
      encoding: "utf8"
    });
    assert.deepEqual(JSON.parse(stdout), { PATH: given });
    assert.equal(existsSync(mark), false, "no startup file ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- plan brains (Task B1a): the version knob and OpenClaw's ChatGPT sign-in ----------------------

test("FAKE_AGENT_VERSION sets openclaw's whole --version line, from the environment or else $HOME/.fake-knobs; other names and the default are unchanged", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const version = async (file, extra = {}) => (await runProbe(file, ["--version"], baseEnv(dir, extra))).stdout.trim();
    assert.equal(await version(bin.paths.openclaw), "openclaw 9.9.9-fake", "unset: today's line, which reads as older than 2026.9.7");
    for (const text of ["OpenClaw 2026.9.6 (eb377ac)", "OpenClaw 2026.9.7", "OpenClaw 2026.10.1", "OpenClaw unknown"]) {
      assert.equal(await version(bin.paths.openclaw, { FAKE_AGENT_VERSION: text }), text);
    }
    assert.equal(await version(bin.paths.claude, { FAKE_AGENT_VERSION: "OpenClaw 2026.9.7" }), "claude 9.9.9-fake", "only the openclaw name takes it");
    // The knob file, for callers that hand the fake an allow-listed environment without FAKE_* variables.
    await setFakeKnob(dir, "FAKE_AGENT_VERSION", "OpenClaw 2026.9.7\n");
    assert.equal(await version(bin.paths.openclaw), "OpenClaw 2026.9.7", "read from $HOME/.fake-knobs, trimmed");
    assert.equal(await version(bin.paths.openclaw, { FAKE_AGENT_VERSION: "OpenClaw 2026.10.1" }), "OpenClaw 2026.10.1", "the environment wins");
    await setFakeKnob(dir, "FAKE_AGENT_VERSION", null);
    assert.equal(await version(bin.paths.openclaw), "openclaw 9.9.9-fake", "null removes the knob");
    await assert.rejects(setFakeKnob(dir, "NOT_A_KNOB", "x"), /not a FAKE_\* knob name/);
  });
});

test("openclaw's ChatGPT sign-in, chosen by its argv: refuses without a terminal; in one it shows a link and a code, saves a siwc row on Enter, says Signed in. and exits 0; Ctrl+C saves nothing; its start record lists every OPENCLAW_* name; every quick answer of openclaw is logged as a probe record", POSIX_ONLY, async () => {
  await withBin({}, async (bin, dir) => {
    const log = path.join(dir, "fake.log");
    const signIn = ["models", "auth", "login", "--provider", "openai", "--method", "siwc"];
    const env = baseEnv(dir, { FAKE_AGENT_LOG: log });

    const noTerminal = await runProbe(bin.paths.openclaw, signIn, env);
    assert.equal(noTerminal.code, 1);
    assert.equal(noTerminal.stdout.trim(), "This command needs a terminal.");
    assert.deepEqual((await readFakeAgentState(dir)).authRows, [], "nothing saved without a terminal");

    // Every quick answer of `openclaw` is logged first as a "probe" record (the start record's fields), so the
    // Safety tests also see the commands detection runs; no other name logs one.
    await runProbe(bin.paths.openclaw, ["--version"], { ...env, OPENCLAW_PROFILE: "work" });
    await runProbe(bin.paths.claude, ["--version"], env);
    const probes = (await readLog(log)).filter((entry) => entry.event === "probe");
    assert.deepEqual(
      probes.map((entry) => [entry.name, entry.argv, entry.isTTY]),
      [
        ["openclaw", signIn, false],
        ["openclaw", ["--version"], false]
      ]
    );
    assert.equal(probes[1].env.HOME, dir);
    assert.equal(probes[1].env.OPENCLAW_PROFILE, "work");
    assert.deepEqual(probes[1].openclawKeys, ["OPENCLAW_PROFILE"]);

    const session = startInPty(bin.paths.openclaw, signIn, { ...env, OPENCLAW_PROFILE: "work", OPENCLAW_SOMETHING_ELSE: "x" });
    try {
      await session.waitFor("Press Enter after you approve in your browser.", "the sign-in's three lines");
      assert.match(session.output, /Sign in with ChatGPT: https:\/\/auth\.openai\.com\/fake-signin\?state=agentos-test/);
      assert.match(session.output, /Code: FAKE-1234/);
      assert.doesNotMatch(session.output, /FAKE_ARGV/, "only the sign-in's own lines are shown");
      const start = (await readLog(log)).find((entry) => entry.event === "start" && entry.pid === session.term.pid);
      assert.deepEqual(start.argv, signIn);
      assert.equal(start.isTTY, true);
      assert.equal(start.env.HOME, dir);
      assert.equal(start.env.OPENCLAW_PROFILE, "work", "OpenClaw's state and profile variables are recorded");
      assert.deepEqual(start.openclawKeys, ["OPENCLAW_PROFILE", "OPENCLAW_SOMETHING_ELSE"], "names only, every OPENCLAW_* one");
      await session.type("approved\r", "Signed in.");
      assert.equal((await session.exited).exitCode, 0);
    } finally {
      session.stop();
    }
    assert.deepEqual((await readFakeAgentState(dir)).authRows, [fakeSiwcProfile()], "the OpenClaw 2026.10.4 profile row, and no more");

    const cancelled = startInPty(bin.paths.openclaw, signIn, env);
    try {
      await cancelled.waitFor("Press Enter after you approve in your browser.", "the sign-in's lines");
      cancelled.term.write("\x03");
      assert.equal((await cancelled.exited).exitCode, 130);
    } finally {
      cancelled.stop();
    }
    assert.equal((await readFakeAgentState(dir)).authRows.length, 1, "Ctrl+C saves nothing");

    // Any other argv, or another name, is the TUI as before.
    for (const [file, args] of [
      [bin.paths.openclaw, ["models", "auth", "login", "--provider", "anthropic"]],
      [bin.paths.claude, signIn]
    ]) {
      const other = startInPty(file, args, env);
      try {
        await other.waitFor(/FAKE_ARGV .*\r[\s\S]*> /, `the TUI for ${path.basename(file)} ${args.join(" ")}`);
      } finally {
        other.stop();
      }
    }
  });
});
