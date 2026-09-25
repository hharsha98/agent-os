// Backend polish: clean run output (ANSI/CR stripping, parseLine "false"),
// short adapter versions, gateway-restart safety follow-ups, and machine
// control (execution gate level 2). Mirrors the structure of
// test/agents.test.js / test/coding-agents.test.js.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRunManager } from "../server/runtime/runs/run-manager.js";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import hermesAdapter from "../server/runtime/agents/hermes.js";
import {
  getExecutionGateStatus,
  getMachineControlStatus,
  setExecutionGateStatus,
  setMachineControlStatus
} from "../server/runtime/execution-gate.js";
import { runVoiceCommand } from "../server/runtime/voice-control.js";

const isWindows = process.platform === "win32";
const isDarwin = process.platform === "darwin";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-backend-polish-token-123";
const ARM_PHRASE = "ENABLE MACHINE CONTROL";

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

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempHome(fn) {
  return withTempDir("agent-os-backend-polish-home-", (home) => withEnv({ AGENT_OS_HOME: home }, () => fn(home)));
}

function waitFor(predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error("timed out waiting for condition");
  })();
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped", "timed_out", "interrupted"]);

function waitForTerminal(manager, id, timeoutMs = 15000) {
  return waitFor(
    async () => {
      const run = await manager.getRun(id);
      return run && TERMINAL_STATUSES.has(run.status) ? run : null;
    },
    { timeoutMs }
  );
}

// =====================================================================
// 1. run-manager: ANSI/CR stripping, and parseLine's "false" drops a line
// =====================================================================

test("run-manager: strips ANSI escapes and keeps only the text after the last \\r; parseLine returning false drops a line", async () => {
  await withTempDir("backend-polish-src-", async (dir) => {
    const scriptPath = path.join(dir, "fake-output.mjs");
    await writeFile(
      scriptPath,
      [
        'process.stdout.write("\\u001b[32mHello\\u001b[0m World\\n");',
        'process.stdout.write("progress: 10%\\rprogress: 100%\\n");',
        'process.stdout.write("DROP_ME\\n");',
        'process.stdout.write("KEEP_ME\\n");'
      ].join("\n")
    );
    const manager = createRunManager();
    const plan = {
      agentId: "fake",
      kind: "agent",
      title: "fake output",
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      timeoutMs: 10000,
      parseLine(line) {
        if (line === "DROP_ME") return false;
        if (line === "KEEP_ME") return [{ type: "text", text: "kept" }];
        return null;
      }
    };
    const started = await manager.startRun(plan);
    const finished = await waitForTerminal(manager, started.id);
    assert.equal(finished.status, "succeeded");
    const events = await manager.readEvents(started.id);
    const lineTexts = events.filter((e) => e.type === "line").map((e) => e.text);
    assert.ok(lineTexts.includes("Hello World"), `expected a cleaned "Hello World" line, got ${JSON.stringify(lineTexts)}`);
    assert.ok(lineTexts.includes("progress: 100%"), `expected only the text after the last \\r, got ${JSON.stringify(lineTexts)}`);
    assert.ok(!events.some((e) => e.text === "DROP_ME"), "DROP_ME must never be stored, in any form");
    assert.ok(events.some((e) => e.type === "text" && e.text === "kept"), "KEEP_ME's mapped event must still be stored");
  });
});

// =====================================================================
// 2. Short adapter versions: first line only, versionFull with ~ for $HOME
// =====================================================================

let hermesSourceDir = null;
let hermesShimDir = null;

before(async () => {
  if (isWindows) return;
  hermesSourceDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-backend-polish-src-"));
  hermesShimDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-backend-polish-bin-"));
  const source = path.join(hermesSourceDir, "fake-hermes-multiline.mjs");
  await writeFile(
    source,
    [
      "const args = process.argv.slice(2);",
      'function print(text) { process.stdout.write(`${text}\\n`); }',
      'if (args.includes("--version")) {',
      "  print([",
      '    "hermes 0.20.6",',
      '    `installed at ${process.env.HOME || ""}/.local/bin/hermes`,',
      '    "build 2026-09-01"',
      '  ].join("\\n"));',
      "  process.exit(0);",
      "}",
      'if (args[0] === "chat" && args.includes("--help")) {',
      '  print(["Usage: hermes chat [options]", "  --query-file PATH", "  --oneshot", "  -Q, --quiet", "  --in DIR"].join("\\n"));',
      "  process.exit(0);",
      "}",
      "process.exit(1);"
    ].join("\n")
  );
  const shim = path.join(hermesShimDir, "hermes");
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`);
  await chmod(shim, 0o755);
});

after(async () => {
  if (hermesShimDir) await rm(hermesShimDir, { recursive: true, force: true });
  if (hermesSourceDir) await rm(hermesSourceDir, { recursive: true, force: true });
});

test(
  "hermes.detect(): version is the first line only; versionFull keeps the rest with $HOME replaced by ~",
  { skip: isWindows ? "spawns a shebang fake CLI via a PATH shim (POSIX-only)" : false },
  async () => {
    await withEnv({ PATH: `${hermesShimDir}${path.delimiter}${process.env.PATH || ""}` }, async () => {
      clearDetectCaches();
      const detected = await hermesAdapter.detect({ refresh: true });
      assert.equal(detected.installed, true);
      assert.equal(detected.version, "hermes 0.20.6");
      assert.ok(detected.version.length <= 80);
      assert.ok(!detected.version.includes("installed at"), "the install path line must not leak into `version`");
      assert.match(detected.versionFull, /^hermes 0\.20\.6/);
      assert.match(detected.versionFull, /installed at ~\/\.local\/bin\/hermes/);
      assert.ok(!detected.versionFull.includes(os.homedir()), "versionFull must not contain the raw home directory");
      assert.ok(detected.versionFull.length <= 1000);
    });
  }
);

// =====================================================================
// 3. Machine control (execution gate level 2): arm/disarm/expiry, in-process
// =====================================================================

test("machine control: arming requires the execution gate on, the exact phrase, and (only on darwin) succeeds", async () => {
  await withTempHome(async () => {
    // gate off -> refused with a plain reason, never even checking the phrase
    await setExecutionGateStatus({ enabled: false });
    await assert.rejects(
      () => setMachineControlStatus({ enable: true, phrase: ARM_PHRASE, confirm: true }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /execution gate/i);
        return true;
      }
    );

    // gate on, wrong phrase -> 400 (case-sensitive/trimmed exact match required)
    await setExecutionGateStatus({ enabled: true });
    await assert.rejects(
      () => setMachineControlStatus({ enable: true, phrase: "enable machine control", confirm: true }),
      (error) => {
        assert.equal(error.status, 400);
        return true;
      }
    );

    if (!isDarwin) {
      await assert.rejects(
        () => setMachineControlStatus({ enable: true, phrase: ARM_PHRASE, confirm: true }),
        (error) => {
          assert.equal(error.status, 400);
          assert.match(error.message, /macOS/i);
          return true;
        }
      );
      assert.equal(getMachineControlStatus().armed, false);
      return; // arm-success is only exercised on darwin
    }

    // trimmed phrase still matches exactly (case-sensitive, whitespace-trimmed)
    const armed = await setMachineControlStatus({ enable: true, phrase: `  ${ARM_PHRASE}  `, confirm: true });
    assert.equal(armed.armed, true);
    assert.ok(armed.expiresAt);
    assert.equal(armed.supported, true);
    assert.equal(getMachineControlStatus().armed, true);

    const gateStatus = await getExecutionGateStatus();
    assert.equal(gateStatus.level, 2);
    assert.equal(gateStatus.machineControl.armed, true);

    // disarm works any time, with no gate/phrase requirement
    const disarmed = await setMachineControlStatus({ enable: false });
    assert.equal(disarmed.armed, false);
    assert.equal((await getExecutionGateStatus()).level, 1);
  });
});

test(
  "machine control: expires automatically after its TTL, using the test-only override",
  { skip: !isDarwin ? "arming requires darwin" : false },
  async () => {
    await withTempHome(async () => {
      await setExecutionGateStatus({ enabled: true });
      await withEnv({ NODE_ENV: "test", AGENT_OS_MACHINE_CONTROL_TTL_MS: "60" }, async () => {
        const armed = await setMachineControlStatus({ enable: true, phrase: ARM_PHRASE, confirm: true });
        assert.equal(armed.armed, true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(getMachineControlStatus().armed, false);
      });
    });
  }
);

test(
  "machine control: the TTL override is ignored unless NODE_ENV==='test' (stays close to the real 30-minute default)",
  { skip: !isDarwin ? "arming requires darwin" : false },
  async () => {
    await withTempHome(async () => {
      await setExecutionGateStatus({ enabled: true });
      await withEnv({ NODE_ENV: undefined, AGENT_OS_MACHINE_CONTROL_TTL_MS: "60" }, async () => {
        const armed = await setMachineControlStatus({ enable: true, phrase: ARM_PHRASE, confirm: true });
        assert.ok(armed.remainingMs > 25 * 60 * 1000, `expected close to the 30-minute default, got ${armed.remainingMs}ms`);
        await setMachineControlStatus({ enable: false });
      });
    });
  }
);

// =====================================================================
// 4. Voice control: a shell_command action without confirmShell is refused
//    (in-process: stubs the Codex GPT planner's fetch call, never spawns a
//    real shell and never arms machine control against the real desktop
//    beyond flipping this process's own in-memory flag).
// =====================================================================

test(
  "voice-control: a shell_command action is refused without confirmShell:true, even with machine control armed",
  { skip: !isDarwin ? "arming machine control requires darwin" : false },
  async () => {
    await withTempHome(async () => {
      await setExecutionGateStatus({ enabled: true });
      await setMachineControlStatus({ enable: true, phrase: ARM_PHRASE, confirm: true });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "shell_test",
                  summary: "Run a harmless shell command.",
                  confidence: 0.9,
                  actions: [{ type: "shell_command", command: "echo hi" }],
                  warnings: []
                })
              }
            }
          ]
        })
      });
      try {
        await withEnv({ OPENAI_API_KEY: "test-key-not-real", HERMES_VOICE_ALLOW_SHELL: "1" }, async () => {
          const result = await runVoiceCommand({ transcript: "run a shell command", dryRun: false });
          assert.equal(result.mode, "executed");
          const shellResult = result.actions.find((a) => a.type === "shell_command");
          assert.ok(shellResult, "expected a shell_command action result");
          assert.equal(shellResult.ok, false);
          assert.match(shellResult.error, /confirmShell/);
        });
      } finally {
        globalThis.fetch = originalFetch;
        await setMachineControlStatus({ enable: false });
      }
    });
  }
);

test("voice-control: reading the screen needs level 2, and a dry run never reads it", async () => {
  await withTempHome(async () => {
    await setExecutionGateStatus({ enabled: true });
    await setMachineControlStatus({ enable: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "inspect",
              summary: "Look at the screen.",
              confidence: 0.9,
              actions: [{ type: "inspect_context" }, { type: "screenshot" }],
              warnings: []
            })
          }
        }]
      })
    });
    try {
      await withEnv({ OPENAI_API_KEY: "test-key-not-real" }, async () => {
        const live = await runVoiceCommand({ transcript: "look at my screen", dryRun: false });
        for (const type of ["inspect_context", "screenshot"]) {
          const action = live.actions.find((a) => a.type === type);
          assert.ok(action, `expected a ${type} result`);
          assert.equal(action.ok, false);
          assert.equal(action.error, "machine_control_off");
        }
        const preview = await runVoiceCommand({ transcript: "look at my screen", dryRun: true });
        const inspect = preview.actions.find((a) => a.type === "inspect_context");
        assert.ok(inspect, "expected an inspect_context preview");
        assert.equal(inspect.output, null, "a dry run must not read the screen");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test(
  "machine control: turning the execution gate off disarms it",
  { skip: !isDarwin ? "arming machine control requires darwin" : false },
  async () => {
    await withTempHome(async () => {
      await setExecutionGateStatus({ enabled: true });
      await setMachineControlStatus({ enable: true, phrase: ARM_PHRASE, confirm: true });
      assert.equal(getMachineControlStatus().armed, true);
      await setExecutionGateStatus({ enabled: false });
      await setExecutionGateStatus({ enabled: true });
      assert.equal(getMachineControlStatus().armed, false);
      assert.equal((await getExecutionGateStatus()).level, 1);
    });
  }
);

// =====================================================================
// 5. HTTP surface: GET/POST /api/admin/machine-control, GET /api/voice/context
//    gated to level 2 (osascript mocked), and a safety action's
//    restartsGateway follow-up run.
// =====================================================================

const FAKE_OPENCLAW_SOURCE = `
const args = process.argv.slice(2);

function print(text) {
  process.stdout.write(\`\${text}\\n\`);
}

if (args.includes("--version")) {
  print("openclaw 1.0.0");
  process.exit(0);
}

if (args[0] === "agent" && args[1] === "exec" && args.includes("--help")) {
  print(["Usage: openclaw agent exec [message] [options]", "  --message-file PATH", "  --cwd DIR", "  --json"].join("\\n"));
  process.exit(0);
}

if (args[0] === "config" && args[1] === "set") {
  print(\`set \${args[2]}=\${args[3]}\`);
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "status") {
  const { readFileSync } = await import("node:fs");
  let running = false;
  try {
    running = JSON.parse(readFileSync(process.env.FAKE_OPENCLAW_GATEWAY_STATE_FILE, "utf8")).running === true;
  } catch {}
  print(JSON.stringify({ running }));
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "restart") {
  print("gateway restarted");
  process.exit(0);
}

print(\`fake-openclaw: unknown command \${JSON.stringify(args)}\`);
process.exit(1);
`;

const FAKE_OSASCRIPT_SOURCE = `
const args = process.argv.slice(2);
function print(text) {
  process.stdout.write(\`\${text}\\n\`);
}
if (args[0] === "-e") {
  print(["frontApp:FakeApp", "frontWindow:Fake Window", "windowCount:1", "uiElementCount:0", "uiLabels:"].join("\\n"));
  process.exit(0);
}
process.exit(1);
`;

let httpSourceDir = null;
let httpShimDir = null;
let gatewayStateFile = null;

before(async () => {
  if (isWindows) return;
  httpSourceDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-backend-polish-http-src-"));
  httpShimDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-backend-polish-http-bin-"));
  gatewayStateFile = path.join(httpSourceDir, "gateway-state.json");
  await writeFile(gatewayStateFile, JSON.stringify({ running: false }));

  const openclawSource = path.join(httpSourceDir, "fake-openclaw.mjs");
  const osascriptSource = path.join(httpSourceDir, "fake-osascript.mjs");
  await writeFile(openclawSource, FAKE_OPENCLAW_SOURCE);
  await writeFile(osascriptSource, FAKE_OSASCRIPT_SOURCE);

  const openclawShim = path.join(httpShimDir, "openclaw");
  const osascriptShim = path.join(httpShimDir, "osascript");
  await writeFile(openclawShim, `#!/bin/sh\nexec "${process.execPath}" "${openclawSource}" "$@"\n`);
  await chmod(openclawShim, 0o755);
  await writeFile(osascriptShim, `#!/bin/sh\nexec "${process.execPath}" "${osascriptSource}" "$@"\n`);
  await chmod(osascriptShim, 0o755);
});

after(async () => {
  if (httpShimDir) await rm(httpShimDir, { recursive: true, force: true });
  if (httpSourceDir) await rm(httpSourceDir, { recursive: true, force: true });
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function spawnServer(env) {
  return spawn(process.execPath, ["server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
}

function collectLogs(child) {
  const ref = { text: "" };
  child.stdout.on("data", (chunk) => { ref.text += chunk; });
  child.stderr.on("data", (chunk) => { ref.text += chunk; });
  return ref;
}

async function waitForHealth(base, child, logsRef) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logsRef.text.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy at ${base}:\n${logsRef.text.slice(-2000)}`);
}

async function killChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function baseEnv(home, port) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    AGENT_OS_HOME: home,
    AGENT_OS_TOKEN: TOKEN,
    HERMES_AGENT_OS_SCHEDULER: "0",
    FAKE_OPENCLAW_GATEWAY_STATE_FILE: gatewayStateFile,
    PATH: `${httpShimDir}${path.delimiter}${process.env.PATH || ""}`
  };
  for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT"]) {
    delete env[key];
  }
  return env;
}

test(
  "HTTP: machine-control API contract, voice/context gated to level 2, and a safety action's restartsGateway follow-up",
  { skip: isWindows ? "spawns fake CLIs via PATH shims (POSIX-only)" : false },
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-backend-polish-route-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawnServer(baseEnv(homeDir, port));
    const logs = collectLogs(child);
    const authed = { "x-agent-os-token": TOKEN };
    const authedJson = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };

    try {
      await waitForHealth(base, child, logs);

      // GET /api/admin/machine-control before anything is armed.
      const initialStatus = await (await fetch(`${base}/api/admin/machine-control`, { headers: authed })).json();
      assert.equal(initialStatus.armed, false);
      assert.equal(initialStatus.supported, isDarwin);

      // GET /api/voice/context with the gate off -> 403 machine_control_off (level 0).
      const contextGateOff = await fetch(`${base}/api/voice/context`, { headers: authed });
      assert.equal(contextGateOff.status, 403);
      assert.equal((await contextGateOff.json()).error, "machine_control_off");

      // Enable the execution gate (level 1).
      await fetch(`${base}/api/admin/execution-gate`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ enabled: true, confirm: true })
      });
      const level1Gate = await (await fetch(`${base}/api/execution-gate`, { headers: authed })).json();
      assert.equal(level1Gate.level, 1);

      // GET /api/voice/context still needs level 2, not just the gate.
      const contextLevel1 = await fetch(`${base}/api/voice/context`, { headers: authed });
      assert.equal(contextLevel1.status, 403);
      assert.equal((await contextLevel1.json()).error, "machine_control_off");

      // Arming with the wrong phrase -> 400.
      const wrongPhraseRes = await fetch(`${base}/api/admin/machine-control`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ enable: true, phrase: "not the phrase", confirm: true })
      });
      assert.equal(wrongPhraseRes.status, 400);

      if (!isDarwin) {
        const nonDarwinRes = await fetch(`${base}/api/admin/machine-control`, {
          method: "POST",
          headers: authedJson,
          body: JSON.stringify({ enable: true, phrase: ARM_PHRASE, confirm: true })
        });
        assert.equal(nonDarwinRes.status, 400);
        return; // arm-success and the level-2 checks below are darwin-only
      }

      // Arm with the correct phrase -> armed:true, expiresAt set.
      const armRes = await fetch(`${base}/api/admin/machine-control`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ enable: true, phrase: ARM_PHRASE, confirm: true })
      });
      assert.equal(armRes.status, 200);
      const armBody = await armRes.json();
      assert.equal(armBody.armed, true);
      assert.ok(armBody.expiresAt);

      const level2Gate = await (await fetch(`${base}/api/execution-gate`, { headers: authed })).json();
      assert.equal(level2Gate.level, 2);
      assert.equal(level2Gate.machineControl.armed, true);

      // GET /api/voice/context now succeeds, and only ever talks to the
      // fake osascript shim above -- never the real desktop.
      const contextLevel2 = await fetch(`${base}/api/voice/context`, { headers: authed });
      assert.equal(contextLevel2.status, 200);
      const contextBody = await contextLevel2.json();
      assert.equal(contextBody.frontApp, "FakeApp");

      // Safety action with restartsGateway:false (exec-ask) never restarts.
      const execAskRes = await fetch(`${base}/api/agents/openclaw/safety/exec-ask`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(execAskRes.status, 200);
      const execAskBody = await execAskRes.json();
      assert.equal(execAskBody.run.status, "succeeded");
      assert.equal(execAskBody.followUp, null);

      // Safety action with restartsGateway:true (no-browser-cookies) does not
      // restart when the fake gateway reports it isn't running.
      await writeFile(gatewayStateFile, JSON.stringify({ running: false }));
      const noRestartRes = await fetch(`${base}/api/agents/openclaw/safety/no-browser-cookies`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(noRestartRes.status, 200);
      const noRestartBody = await noRestartRes.json();
      assert.equal(noRestartBody.run.status, "succeeded");
      assert.equal(noRestartBody.followUp, null);

      // ...but does restart when the fake gateway reports it is running.
      await writeFile(gatewayStateFile, JSON.stringify({ running: true }));
      const restartRes = await fetch(`${base}/api/agents/openclaw/safety/no-browser-cookies`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(restartRes.status, 200);
      const restartBody = await restartRes.json();
      assert.equal(restartBody.run.status, "succeeded");
      assert.ok(restartBody.followUp, "expected a follow-up restart run when the gateway is running");
      assert.match(restartBody.followUp.commandPreview, /gateway restart/);

      // Restart is now allowed as a plain service action too (start/stop/restart).
      const serviceRestartRes = await fetch(`${base}/api/agents/openclaw/service/restart`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(serviceRestartRes.status, 200);

      // Disarm works at any time.
      const disarmRes = await fetch(`${base}/api/admin/machine-control`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ enable: false })
      });
      assert.equal(disarmRes.status, 200);
      assert.equal((await disarmRes.json()).armed, false);
      const level1Again = await (await fetch(`${base}/api/execution-gate`, { headers: authed })).json();
      assert.equal(level1Again.level, 1);
    } finally {
      await killChild(child);
      await rm(homeDir, { recursive: true, force: true });
    }
  }
);
