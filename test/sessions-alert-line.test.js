// The AGENT_OS_ALERT line (SP4, Task X1a; spec "Desktop shell changes" and
// "SP4 done when", R21, K7): a server the desktop shell started
// (AGENT_OS_PACKAGED=1) prints one line on stdout each time a session's alert
// starts, and the Rust shell (Task X4) turns it into a notification while the
// window is hidden. One real server/index.js with W1's fake agents in a temp
// HOME, started with a minimal environment like the Dock's (nothing from the
// test runner, so no host agent's variables); never a real agent. The other
// half (no line without AGENT_OS_PACKAGED) is in test/sessions-ws.test.js.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { cookieNameFor } from "../server/runtime/local-session.js";
import { ALERT_LINE_PREFIX, BASIC_ALERT_TEXT } from "../server/runtime/sessions/signals.js";
import { FAKE_AGENT_NAMES, FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_POSIX = process.platform === "win32" ? "POSIX only: W1's fake agents and stand-in login shell are sh scripts" : false;
const SKIP_WINDOWS_PIPE =
  process.platform === "win32" ? "POSIX only: a closed pipe is reported as EPIPE; Windows words it differently" : false;
const TOKEN = "test-token-alert-line";
// Node's own folder is left out on purpose: it can hold real agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(25);
  }
}

// The server as the desktop shell starts it: AGENT_OS_PACKAGED=1 and a port
// the system picks (AGENT_OS_PORT=0), read back from the AGENT_OS_READY line.
async function startPackagedServer(home) {
  const env = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    PATH: [path.join(home, "fake-bin"), ...SYSTEM_PATH_DIRS].join(path.delimiter),
    SHELL: FAKE_LOGIN_SHELL,
    HOST: "127.0.0.1",
    AGENT_OS_PORT: "0",
    AGENT_OS_PACKAGED: "1",
    AGENT_OS_HOME: path.join(home, ".hermes-agent-os"),
    AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
    AGENT_OS_TOKEN: TOKEN,
    HERMES_AGENT_OS_SCHEDULER: "0"
  };
  const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    out.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    out.stderr += chunk;
  });
  try {
    const ready = await waitFor(
      () => {
        if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode}):\n${out.stderr.slice(-2000)}`);
        return /AGENT_OS_READY:(\d+)/.exec(out.stdout);
      },
      20000,
      "the server to start"
    );
    return { child, out, port: Number(ready[1]) };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

// SIGTERM, then up to 10 s (the server's own hard exit is 8 s), then SIGKILL.
async function stopServer(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited;
  clearTimeout(timer);
}

async function api(port, method, url, body) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

// One window on the session: it acks every output frame and keeps the screen text.
function attach(port, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/attach`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: `${cookieNameFor(port)}=${encodeURIComponent(TOKEN)}` },
      handshakeTimeout: 5000
    });
    const client = { ws, screen: "", send: (value) => ws.send(JSON.stringify(value)) };
    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame.t === "snapshot") client.screen += frame.data;
      if (frame.t === "out") {
        client.screen += frame.d;
        client.send({ t: "ack", seq: frame.seq });
      }
    });
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

test(
  "a server the desktop shell started prints one AGENT_OS_ALERT line on stdout each time a session's alert starts: the session id, the agent's short name, the kind and the short text as one JSON line, and nothing else",
  { skip: SKIP_POSIX },
  async () => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-alert-line-")));
    await mkdir(path.join(home, "project"), { recursive: true });
    await makeFakeAgentBin(path.join(home, "fake-bin"), { names: FAKE_AGENT_NAMES });
    let server = null;
    let client = null;
    let id = null;
    try {
      server = await startPackagedServer(home);
      const { port, out } = server;
      const gate = await api(port, "POST", "/api/admin/execution-gate", { enabled: true, confirm: true });
      assert.equal(gate.status, 200, gate.text);
      const created = await api(port, "POST", "/api/sessions", { agentId: "claude", folder: path.join(home, "project") });
      assert.equal(created.status, 201, created.text);
      id = created.json.id;
      client = await attach(port, id);
      await waitFor(() => client.screen.includes("FAKE_ARGV"), 10000, "the fake agent's first line");
      client.send({ t: "focus" });
      const alertLines = () => out.stdout.split("\n").filter((line) => line.includes(ALERT_LINE_PREFIX));
      assert.deepEqual(alertLines(), [], "no line before the first alert");

      client.send({ t: "in", d: "bell\r" });
      await waitFor(() => alertLines().length === 1, 10000, "the first AGENT_OS_ALERT line");
      const [line] = alertLines();
      assert.ok(line.startsWith(ALERT_LINE_PREFIX), "the line starts with the prefix, so the shell finds it");
      const payload = JSON.parse(line.slice(ALERT_LINE_PREFIX.length));
      assert.deepEqual(Object.keys(payload), ["sessionId", "agent", "kind", "text"]);
      assert.deepEqual(payload, { sessionId: id, agent: "Claude Code", kind: "waiting", text: BASIC_ALERT_TEXT });
      assert.equal(line.includes(home), false, "no folder or path in the line");

      // The mirror passes at most one bell per 250 ms. Typing clears the alert
      // (no line); the next bell starts a new alert, which prints a new line.
      await delay(300);
      client.send({ t: "in", d: "bell\r" });
      await waitFor(() => alertLines().length === 2, 10000, "the second AGENT_OS_ALERT line");
      assert.equal(alertLines()[1], line);
      const listed = await api(port, "GET", "/api/sessions?live=1");
      assert.equal(listed.json.sessions.find((session) => session.id === id).status, "waiting");
      assert.equal(out.stderr.includes(ALERT_LINE_PREFIX), false, "the line goes to stdout only");
    } finally {
      client?.ws.close();
      if (server && id) await api(server.port, "POST", `/api/sessions/${id}/stop`, {}).catch(() => {});
      if (server) await stopServer(server.child);
      await rm(home, { recursive: true, force: true });
    }
  }
);

// Fix round 1 (I1): a stream never throws for a closed pipe; it reports EPIPE
// later as an 'error' event on process.stdout, and an event nobody listens to
// ends the process. So the default writer of printAlertLine must listen. A
// try/catch around the write cannot catch this, which is why it is tested in a
// child process: the real printAlertLine, a real closed pipe, and a check that
// the process is still there afterwards. The child only runs node.
test(
  "printAlertLine's default writer survives a closed stdout: when the shell that read the server's output is gone, the process goes on",
  { skip: SKIP_WINDOWS_PIPE },
  async () => {
    const signalsUrl = pathToFileURL(path.join(root, "server/runtime/sessions/signals.js")).href;
    const childCode = [
      `import { printAlertLine } from ${JSON.stringify(signalsUrl)};`,
      "const payload = { sessionId: 'x', agent: 'Codex', kind: 'waiting', text: 'May need you' };",
      "setTimeout(() => {",
      "  printAlertLine(payload);",
      "  printAlertLine(payload);",
      // The error event for a closed pipe arrives after the write: give it time.
      "  setTimeout(() => {",
      "    process.stderr.write('alive\\n');",
      "    process.exit(0);",
      "  }, 300);",
      "}, 200);"
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      cwd: root,
      env: { LANG: "en_US.UTF-8", TMPDIR: os.tmpdir() },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.destroy(); // the reader is gone before the child writes its first line
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const exitCode = await new Promise((resolve) => child.once("close", (code, signal) => resolve(code ?? signal)));
    clearTimeout(killer);
    assert.equal(exitCode, 0, `the child must survive the closed pipe:\n${stderr.slice(-2000)}`);
    assert.match(stderr, /alive/);
    assert.doesNotMatch(stderr, /EPIPE/, "no unhandled error event");
  }
);
