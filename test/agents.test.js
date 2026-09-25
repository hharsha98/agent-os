// Agent adapters (Hermes, OpenClaw): binary/feature detection, plan
// building, output parsing, and the /api/agents HTTP surface in front of
// them. Pure adapter tests (buildRun/parseLine) run on every platform;
// anything that spawns a fake CLI is POSIX-only, matching the shebang-based
// fake CLIs used elsewhere in this suite (see test/runtime.test.js).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { containsBlockedFlag } from "../server/runtime/agent-flags.js";
import { ADAPTERS } from "../server/runtime/agents/index.js";
import { runningFromText, warningsFromText } from "../server/runtime/agents/hermes.js";
import { clearDetectCaches, resolveBinary } from "../server/runtime/agents/detect.js";

const isWindows = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { hermes, openclaw } = ADAPTERS;
const TOKEN = "test-agents-token-123";

// Fake CLI sources live inline (not as files under test/, which node --test
// would otherwise pick up and try to run as tests in their own right — see
// the writeFake()/inline-fake pattern already used by test/runs.test.js and
// test/runtime.test.js). Behaviour is driven by env vars/prompt content so
// one script can stand in for several versions and failure modes.
const FAKE_HERMES_SOURCE = `
import { readFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);

function print(text) {
  process.stdout.write(\`\${text}\\n\`);
}

if (args.includes("--version")) {
  print(process.env.FAKE_HERMES_VERSION || "hermes 0.20.6");
  process.exit(0);
}

if (args[0] === "chat" && args.includes("--help")) {
  const lines = [
    "Usage: hermes chat [options]",
    "  -q, --query QUERY",
    "  --query-file PATH",
    "  --oneshot",
    "  -Q, --quiet",
    "  --resume",
    "  --in DIR"
  ];
  if (process.env.FAKE_HERMES_STREAM_JSON === "1") {
    lines.push("  --format <text|stream-json>");
  }
  print(lines.join("\\n"));
  process.exit(0);
}

if (args[0] === "doctor") {
  if (process.env.FAKE_HERMES_DOCTOR_FAIL === "1") {
    print("No model provider is configured.\\nRun 'hermes setup' to fix this.");
    process.exit(1);
  }
  print("Everything looks good.");
  process.exit(0);
}

if (args[0] === "config" && args[1] === "get" && args[2] === "approvals.mode") {
  print(process.env.FAKE_HERMES_APPROVALS || "on");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "status") {
  print(process.env.FAKE_HERMES_GATEWAY_TEXT || "gateway is not running");
  process.exit(0);
}

if (args[0] === "gateway" && (args[1] === "start" || args[1] === "stop")) {
  print(\`gateway \${args[1]}ped\`);
  process.exit(0);
}

if (args[0] === "chat") {
  const fileIndex = args.indexOf("--query-file");
  const queryFile = fileIndex !== -1 ? args[fileIndex + 1] : "";
  const prompt = queryFile ? readFileSync(queryFile, "utf8") : "";
  if (process.env.FAKE_HERMES_RECORD_ARGV) {
    appendFileSync(process.env.FAKE_HERMES_RECORD_ARGV, \`\${JSON.stringify(args)}\\n\`);
  }
  if (process.env.FAKE_HERMES_SLEEP === "1" || prompt.trim() === "__SLEEP_FOREVER__") {
    setInterval(() => {}, 1000);
  } else if (args.includes("--format") && args.includes("stream-json")) {
    print(JSON.stringify({ type: "system", subtype: "init" }));
    print(JSON.stringify({ type: "text", text: \`echo: \${prompt.trim()}\` }));
    print(JSON.stringify({ type: "tool_use", name: "search", input: { query: "docs" } }));
    print(JSON.stringify({ type: "tool_result", output: "found 3 results" }));
    print(JSON.stringify({ type: "result", exit_code: 0, cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }));
    process.exit(0);
  } else {
    print(\`echo: \${prompt.trim()}\`);
    process.exit(0);
  }
} else {
  print(\`fake-hermes: unknown command \${JSON.stringify(args)}\`);
  process.exit(1);
}
`;

const FAKE_OPENCLAW_SOURCE = `
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

function print(text) {
  process.stdout.write(\`\${text}\\n\`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function recordArgv() {
  if (process.env.FAKE_OPENCLAW_RECORD_ARGV) {
    appendFileSync(process.env.FAKE_OPENCLAW_RECORD_ARGV, \`\${JSON.stringify(args)}\\n\`);
  }
}

if (args.includes("--version")) {
  print(process.env.FAKE_OPENCLAW_VERSION || "openclaw 1.0.0");
  process.exit(0);
}

if (args[0] === "agent" && args[1] === "exec" && args.includes("--help")) {
  print(["Usage: openclaw agent exec [message] [options]", "  --message-file PATH", "  --cwd DIR", "  --json"].join("\\n"));
  process.exit(0);
}

if (args[0] === "doctor" && args.includes("--json")) {
  if (process.env.FAKE_OPENCLAW_DOCTOR_FAIL === "1") {
    print(JSON.stringify({ ok: false, findings: [{ message: "no model provider configured" }] }));
  } else {
    print(JSON.stringify({ ok: true, findings: [] }));
  }
  process.exit(0);
}

if (args[0] === "status" && args.includes("--json")) {
  print(JSON.stringify({ ok: process.env.FAKE_OPENCLAW_STATUS_FAIL === "1" ? false : true }));
  process.exit(0);
}

if (args[0] === "config" && args[1] === "get" && args[2] === "tools.exec.mode") {
  print(process.env.FAKE_OPENCLAW_EXEC_MODE ?? "full");
  process.exit(0);
}

if (args[0] === "config" && args[1] === "set" && args[2] === "tools.exec.mode") {
  recordArgv();
  print(\`set tools.exec.mode=\${args[3]}\`);
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "status") {
  print(JSON.stringify({ running: process.env.FAKE_OPENCLAW_GATEWAY_RUNNING === "1" }));
  process.exit(0);
}

if (args[0] === "gateway" && (args[1] === "start" || args[1] === "stop")) {
  print(\`gateway \${args[1]}ped\`);
  process.exit(0);
}

if (args[0] === "agent" && args[1] === "exec") {
  recordArgv();
  const messageFileIndex = args.indexOf("--message-file");
  const prompt = messageFileIndex !== -1 && args[messageFileIndex + 1] === "-"
    ? await readStdin()
    : args[args.length - 1];
  print(JSON.stringify({ ok: true, status: "done", final: \`echo: \${String(prompt).trim()}\`, usage: { inputTokens: 8, outputTokens: 4 }, costUsd: 0.02, sessionId: "fake-session" }));
  process.exit(0);
}

if (args[0] === "agent" && args[1] === "-m") {
  recordArgv();
  const prompt = args[2] || "";
  print(JSON.stringify({ ok: true, status: "done", final: \`echo: \${prompt.trim()}\`, usage: { inputTokens: 3, outputTokens: 2 }, costUsd: 0.005 }));
  process.exit(0);
}

print(\`fake-openclaw: unknown command \${JSON.stringify(args)}\`);
process.exit(1);
`;

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

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-agents-home-"));
  try {
    return await withEnv({ AGENT_OS_HOME: home }, () => fn(home));
  } finally {
    await rm(home, { recursive: true, force: true });
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

// --- POSIX-only shim bin dir, shared by every test that spawns a fake CLI ---
// Both the .mjs source and the shim that execs it live under os.tmpdir(),
// well outside test/, so node --test never mistakes either for a test file.
let sourceDir = null;
let shimDir = null;
let hermesShim = null;
let openclawShim = null;

before(async () => {
  if (isWindows) return;
  sourceDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-agents-src-"));
  shimDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-agents-bin-"));

  const hermesSource = path.join(sourceDir, "fake-hermes.mjs");
  const openclawSource = path.join(sourceDir, "fake-openclaw.mjs");
  await writeFile(hermesSource, FAKE_HERMES_SOURCE);
  await writeFile(openclawSource, FAKE_OPENCLAW_SOURCE);

  hermesShim = path.join(shimDir, "hermes");
  openclawShim = path.join(shimDir, "openclaw");
  await writeFile(hermesShim, `#!/bin/sh\nexec "${process.execPath}" "${hermesSource}" "$@"\n`);
  await chmod(hermesShim, 0o755);
  await writeFile(openclawShim, `#!/bin/sh\nexec "${process.execPath}" "${openclawSource}" "$@"\n`);
  await chmod(openclawShim, 0o755);
});

after(async () => {
  if (shimDir) await rm(shimDir, { recursive: true, force: true });
  if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
});

// =====================================================================
// 1. detect(): feature flags come from --help text, not a hard-coded list
// =====================================================================

test(
  "hermes.detect(): --help text drives feature flags, and a version bump invalidates the cache",
  { skip: isWindows ? "spawns a shebang fake CLI via a PATH shim (POSIX-only)" : false },
  async () => {
    await withEnv(
      { PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}`, FAKE_HERMES_VERSION: undefined, FAKE_HERMES_STREAM_JSON: undefined },
      async () => {
        clearDetectCaches();
        const v20 = await hermes.detect({ refresh: true });
        assert.equal(v20.installed, true);
        assert.match(v20.version, /0\.20\.6/);
        assert.equal(v20.features.queryFile, true);
        assert.equal(v20.features.oneshot, true);
        assert.equal(v20.features.inDir, true);
        assert.equal(v20.features.streamJson, false);

        await withEnv({ FAKE_HERMES_VERSION: "hermes 0.21.5", FAKE_HERMES_STREAM_JSON: "1" }, async () => {
          const v21 = await hermes.detect({ refresh: true });
          assert.match(v21.version, /0\.21\.5/);
          assert.equal(v21.features.streamJson, true);
        });
      }
    );
  }
);

test(
  "openclaw.detect(): agentExec reflects the help command's exit code",
  { skip: isWindows ? "spawns a shebang fake CLI via a PATH shim (POSIX-only)" : false },
  async () => {
    await withEnv({ PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}` }, async () => {
      clearDetectCaches();
      const detected = await openclaw.detect({ refresh: true });
      assert.equal(detected.installed, true);
      assert.equal(detected.features.agentExec, true);
      assert.equal(detected.features.messageFile, true);
      assert.equal(detected.features.cwd, true);
      assert.equal(detected.features.json, true);
    });
  }
);

test("resolveBinary(): returns '' (never throws) when nothing on PATH or in the fallbacks matches", async () => {
  await withEnv({ PATH: "/definitely/not/a/real/path" }, async () => {
    const found = await resolveBinary("definitely-not-a-real-binary-xyz", []);
    assert.equal(found, "");
  });
});

test("detect(): a missing binary never throws, and reports installed:false", async () => {
  // OpenClaw is not installed on the dev machine (unlike Hermes, whose real
  // binary at ~/.local/bin/hermes would otherwise be found via the fallback
  // paths regardless of PATH), so this is the adapter that can reliably
  // exercise the "not found anywhere" branch on this box.
  await withEnv({ PATH: "/definitely/not/a/real/path" }, async () => {
    clearDetectCaches();
    const detected = await openclaw.detect({ refresh: true });
    assert.equal(detected.installed, false);
    assert.equal(detected.path, "");
    assert.match(detected.error, /not found/);
  });
});

// =====================================================================
// 2 + 3. Hermes buildRun + parseLine (pure functions, run on every platform)
// =====================================================================

test("hermes.buildRun(): prompt goes to a query file, never argv; no blocked flags", async () => {
  await withTempHome(async () => {
    await withEnv({ HERMES_HOME: undefined }, async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        const detected = {
          installed: true,
          path: "/fake/hermes",
          version: "0.20.6",
          features: { queryFile: true, oneshot: true, quiet: true, inDir: false, streamJson: false }
        };
        const plan = await hermes.buildRun({ prompt: "hello there --dangerously-skip-permissions", cwd: "/some/project", detected, runDir });
        const queryFile = path.join(runDir, "query.txt");
        assert.deepEqual(plan.args, ["chat", "--oneshot", "-Q", "--query-file", queryFile]);
        assert.ok(!plan.args.some((arg) => arg.includes("hello there")));
        assert.ok(!plan.args.some((arg) => containsBlockedFlag(arg)));
        assert.equal(plan.cwd, runDir);
        assert.deepEqual(plan.env, {});
        assert.deepEqual(plan.redact, [queryFile]);

        const content = await readFile(queryFile, "utf8");
        assert.equal(content, "hello there --dangerously-skip-permissions");
        if (!isWindows) {
          const info = await stat(queryFile);
          assert.equal(info.mode & 0o777, 0o600);
        }

        await plan.onExit({});
        await assert.rejects(() => readFile(queryFile, "utf8"));
      });
    });
  });
});

test("hermes.buildRun(): --in only with inDir, --format stream-json only with streamJson, after the query flags", async () => {
  await withTempHome(async () => {
    await withEnv({ HERMES_HOME: undefined }, async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        const detected = {
          installed: true,
          path: "/fake/hermes",
          version: "0.21.5",
          features: { queryFile: true, oneshot: true, quiet: true, inDir: true, streamJson: true }
        };
        const plan = await hermes.buildRun({ prompt: "hi", cwd: "/some/project", detected, runDir });
        const queryFile = path.join(runDir, "query.txt");
        assert.deepEqual(plan.args, [
          "chat",
          "--oneshot",
          "-Q",
          "--query-file",
          queryFile,
          "--in",
          "/some/project",
          "--format",
          "stream-json"
        ]);
      });
    });
  });
});

test("hermes.buildRun(): HERMES_HOME is only passed through when configured, and gets redacted", async () => {
  await withTempHome(async () => {
    await withEnv({ HERMES_HOME: "/custom/hermes-home" }, async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        const detected = { installed: true, path: "/fake/hermes", version: "0.20.6", features: {} };
        const plan = await hermes.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir });
        assert.deepEqual(plan.env, { HERMES_HOME: "/custom/hermes-home" });
        assert.ok(plan.redact.includes("/custom/hermes-home"));
      });
    });
  });
});

test("hermes.parseLine(): plain mode wraps every line as text", () => {
  const events = hermes.parseLine("hello world", "stdout", { streamJson: false });
  assert.deepEqual(events, [{ type: "text", text: "hello world" }]);
});

test("hermes.parseLine(): stream-json maps text/tool_use/tool_result/result and aggregates usage", () => {
  const ctx = { streamJson: true };
  assert.deepEqual(hermes.parseLine(JSON.stringify({ type: "text", text: "hi" }), "stdout", ctx), [{ type: "text", text: "hi" }]);

  const toolEvents = hermes.parseLine(JSON.stringify({ type: "tool_use", name: "search", input: { query: "docs" } }), "stdout", ctx);
  assert.equal(toolEvents[0].type, "tool");
  assert.match(toolEvents[0].text, /search/);

  const longOutput = "x".repeat(600);
  const resultEvents = hermes.parseLine(JSON.stringify({ type: "tool_result", output: longOutput }), "stdout", ctx);
  assert.equal(resultEvents[0].type, "tool_result");
  assert.equal(resultEvents[0].text.length, 500);

  const finalEvents = hermes.parseLine(
    JSON.stringify({ type: "result", exit_code: 0, cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }),
    "stdout",
    ctx
  );
  assert.deepEqual(finalEvents[0], { type: "result", data: { exit_code: 0 } });
  assert.equal(finalEvents[1].type, "usage");
  assert.equal(finalEvents[1].costUsd, 0.01);
  assert.equal(finalEvents[1].inputTokens, 10);
  assert.equal(finalEvents[1].outputTokens, 5);
});

test("hermes.parseLine(): a non-JSON line in stream-json mode falls back to null (the run manager's {type:'line'})", () => {
  assert.equal(hermes.parseLine("not json at all", "stdout", { streamJson: true }), null);
});

// =====================================================================
// 4 + 5. OpenClaw buildRun + parseLine
// =====================================================================

function stubService(running) {
  return async () => ({ running, text: running ? "running" : "not running" });
}

test("openclaw.buildRun(): stdin transport when messageFile is supported; prompt never on argv", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/openclaw", version: "1.0.0", features: { agentExec: true, messageFile: true, cwd: true } };
    const plan = await openclaw.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir, checkService: stubService(false) });
    assert.deepEqual(plan.args, ["agent", "exec", "--message-file", "-", "--json", "--cwd", "/proj"]);
    assert.equal(plan.stdin, "do the thing");
    assert.ok(!plan.args.some((arg) => arg.includes("do the thing")));
    assert.equal(plan.cwd, runDir);
  });
});

test("openclaw.buildRun(): the -- argv transport when messageFile is not supported", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/openclaw", version: "1.0.0", features: { agentExec: true, messageFile: false } };
    const plan = await openclaw.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir, checkService: stubService(false) });
    assert.deepEqual(plan.args, ["agent", "exec", "--json", "--", "do the thing"]);
    assert.equal(plan.stdin, undefined);
  });
});

test("openclaw.buildRun(): the gateway transport when the service reports running, regardless of agentExec", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/openclaw", version: "1.0.0", features: { agentExec: true, messageFile: true, cwd: true } };
    const plan = await openclaw.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir, checkService: stubService(true) });
    assert.deepEqual(plan.args, ["agent", "-m", "do the thing"]);
    assert.match(plan.title, /gateway/i);
  });
});

test("openclaw.buildRun(): the legacy -m transport when agent exec is not supported at all", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/openclaw", version: "0.5.0", features: { agentExec: false } };
    const plan = await openclaw.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir, checkService: stubService(false) });
    assert.deepEqual(plan.args, ["agent", "-m", "do the thing"]);
  });
});

test("openclaw.parseLine(): the JSON envelope gives a result event plus a usage event with costUsd", () => {
  const line = JSON.stringify({ ok: true, status: "done", final: "all done", usage: { inputTokens: 8, outputTokens: 4 }, costUsd: 0.02, sessionId: "s1" });
  const events = openclaw.parseLine(line);
  assert.deepEqual(events[0], { type: "result", text: "all done", data: { ok: true, status: "done" } });
  assert.equal(events[1].type, "usage");
  assert.equal(events[1].costUsd, 0.02);
  assert.equal(events[1].inputTokens, 8);
  assert.equal(events[1].outputTokens, 4);
});

test("openclaw.parseLine(): non-envelope JSON and non-JSON lines both fall back to null", () => {
  assert.equal(openclaw.parseLine("plain text output"), null);
  assert.equal(openclaw.parseLine(JSON.stringify({ hello: "world" })), null);
});

// =====================================================================
// 6 + 7. safetyStatus / configStatus against the fake CLIs directly
// =====================================================================

test(
  "openclaw.safetyStatus(): tools.exec.mode=full is permissive with an exec-ask action; ask is not",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    const detected = { installed: true, path: openclawShim, version: "1.0.0", features: {} };
    await withEnv({ FAKE_OPENCLAW_EXEC_MODE: "full" }, async () => {
      const status = await openclaw.safetyStatus(detected);
      assert.equal(status.permissive, true);
      assert.ok(status.actions.some((action) => action.id === "exec-ask"));
    });
    await withEnv({ FAKE_OPENCLAW_EXEC_MODE: "ask" }, async () => {
      const status = await openclaw.safetyStatus(detected);
      assert.equal(status.permissive, false);
    });
  }
);

test(
  "hermes.configStatus(): a doctor failure reports problems and a fix hint",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    const detected = { installed: true, path: hermesShim, version: "0.20.6", features: {} };
    await withEnv({ FAKE_HERMES_DOCTOR_FAIL: "1" }, async () => {
      const status = await hermes.configStatus(detected);
      assert.equal(status.ok, false);
      assert.ok(status.problems.length > 0);
      assert.match(status.fixHint, /hermes setup/);
    });
    await withEnv({ FAKE_HERMES_DOCTOR_FAIL: undefined }, async () => {
      const status = await hermes.configStatus(detected);
      assert.equal(status.ok, true);
    });
  }
);

test(
  "openclaw.configStatus(): doctor --json ok:false with findings becomes problems",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    const detected = { installed: true, path: openclawShim, version: "1.0.0", features: {} };
    await withEnv({ FAKE_OPENCLAW_DOCTOR_FAIL: "1" }, async () => {
      const status = await openclaw.configStatus(detected);
      assert.equal(status.ok, false);
      assert.ok(status.problems.some((p) => p.includes("model provider")));
    });
  }
);

test(
  "hermes.safetyStatus(): approvals.mode=off is permissive (YOLO mode)",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    const detected = { installed: true, path: hermesShim, version: "0.20.6", features: {} };
    await withEnv({ FAKE_HERMES_APPROVALS: "off" }, async () => {
      const status = await hermes.safetyStatus(detected);
      assert.equal(status.permissive, true);
    });
    await withEnv({ FAKE_HERMES_APPROVALS: "on" }, async () => {
      const status = await hermes.safetyStatus(detected);
      assert.equal(status.permissive, false);
    });
  }
);

// =====================================================================
// 8 + 9. The /api/agents HTTP surface, against the real server
// =====================================================================

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
  child.stdout.on("data", (chunk) => {
    ref.text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    ref.text += chunk;
  });
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

function baseEnv(home, port, extra = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    AGENT_OS_HOME: home,
    AGENT_OS_TOKEN: TOKEN,
    HERMES_AGENT_OS_SCHEDULER: "0",
    PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}`
  };
  for (const key of ["HERMES_HOME", "DEMO_PUBLIC", "HERMES_AGENT_OS_PUBLIC_MODE", "HERMES_AGENT_OS_ENABLE_EXEC", "AGENT_OS_LIVE_CHAT"]) {
    if (!(key in extra)) delete env[key];
  }
  return { ...env, ...extra };
}

async function collectSse(response, isDone) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const blocks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const block = { id: null, event: null, data: null };
        for (const line of raw.split("\n")) {
          if (line.startsWith("id:")) block.id = line.slice(3).trim();
          else if (line.startsWith("event:")) block.event = line.slice(6).trim();
          else if (line.startsWith("data:")) block.data = (block.data || "") + line.slice(5).trim();
        }
        if (block.event === null && block.data === null) continue;
        blocks.push(block);
        if (isDone(blocks)) return blocks;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return blocks;
}

test(
  "agents routes: list, gate, confirm, folder sandbox, a real run + stream, stop, preview, unknown id",
  { skip: isWindows ? "spawns fake CLIs via PATH shims (POSIX-only)" : false },
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-agents-route-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawnServer(baseEnv(homeDir, port));
    const logs = collectLogs(child);
    const authed = { "x-agent-os-token": TOKEN };
    const authedJson = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };

    try {
      await waitForHealth(base, child, logs);

      // GET /api/agents lists both, hermes installed with its version parsed.
      const listRes = await fetch(`${base}/api/agents`, { headers: authed });
      assert.equal(listRes.status, 200);
      const listBody = await listRes.json();
      assert.deepEqual(listBody.agents.map((a) => a.id).sort(), ["hermes", "openclaw"]);
      const hermesEntry = listBody.agents.find((a) => a.id === "hermes");
      assert.equal(hermesEntry.detected.installed, true);
      assert.match(hermesEntry.detected.version, /0\.20\.6/);

      // unknown agent id -> 404
      const unknownRes = await fetch(`${base}/api/agents/not-a-real-agent`, { headers: authed });
      assert.equal(unknownRes.status, 404);

      // a run with the gate off -> 403
      const gateOffRes = await fetch(`${base}/api/agents/hermes/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "hello from the test", confirm: true })
      });
      assert.equal(gateOffRes.status, 403);
      assert.equal((await gateOffRes.json()).error, "execution_gate_off");

      // enable the gate
      const gateOnRes = await fetch(`${base}/api/admin/execution-gate`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ enabled: true, confirm: true })
      });
      assert.equal(gateOnRes.status, 200);

      // a run without confirm -> 400
      const noConfirmRes = await fetch(`${base}/api/agents/hermes/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "hello from the test" })
      });
      assert.equal(noConfirmRes.status, 400);

      // a folder outside the sandbox -> 403
      for (const folder of ["/tmp", ".."]) {
        const outsideRes = await fetch(`${base}/api/agents/hermes/runs`, {
          method: "POST",
          headers: authedJson,
          body: JSON.stringify({ prompt: "hello from the test", confirm: true, folder })
        });
        assert.equal(outsideRes.status, 403, `folder ${folder} should be rejected`);
        assert.equal((await outsideRes.json()).error, "folder_outside_sandbox");
      }

      // command/args/path in the body are simply ignored, not honored
      const ignoredRes = await fetch(`${base}/api/agents/hermes/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({
          prompt: "hello from the test",
          confirm: true,
          command: "/bin/sh",
          args: ["-c", "echo pwned"],
          path: "/bin/sh"
        })
      });
      assert.equal(ignoredRes.status, 200);
      const ignoredBody = await ignoredRes.json();
      assert.doesNotMatch(ignoredBody.commandPreview || "", /pwned/);
      await fetch(`${base}/api/runs/${ignoredBody.id}/stop`, { method: "POST", headers: authed });

      // preview spawns nothing
      const beforePreviewRuns = await (await fetch(`${base}/api/runs`, { headers: authed })).json();
      const previewRes = await fetch(`${base}/api/agents/hermes/runs/preview`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "just a preview" })
      });
      assert.equal(previewRes.status, 200);
      const previewBody = await previewRes.json();
      assert.match(previewBody.commandPreview, /hermes|query-file/);
      assert.equal(previewBody.gate.enabled, true);
      const afterPreviewRuns = await (await fetch(`${base}/api/runs`, { headers: authed })).json();
      assert.equal(afterPreviewRuns.runs.length, beforePreviewRuns.runs.length);

      // a valid run -> 200; stream until end; succeeded; the fake's output appears
      const runRes = await fetch(`${base}/api/agents/hermes/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "hello from the test", confirm: true })
      });
      assert.equal(runRes.status, 200);
      const runBody = await runRes.json();
      assert.equal(runBody.status, "running");

      const streamRes = await fetch(`${base}/api/runs/${runBody.id}/stream`, { headers: authed });
      assert.equal(streamRes.status, 200);
      const blocks = await collectSse(streamRes, (collected) => collected.some((b) => b.event === "end"));
      const endBlock = blocks.find((b) => b.event === "end");
      assert.equal(JSON.parse(endBlock.data).status, "succeeded");
      const texts = blocks.filter((b) => b.event === "text" || b.event === "line").map((b) => JSON.parse(b.data).text);
      assert.ok(texts.some((text) => String(text).includes("hello from the test")));

      // a fake that sleeps: start, then stop -> stopped
      const sleepRes = await fetch(`${base}/api/agents/hermes/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "__SLEEP_FOREVER__", confirm: true })
      });
      assert.equal(sleepRes.status, 200);
      const sleepBody = await sleepRes.json();
      const stopRes = await fetch(`${base}/api/runs/${sleepBody.id}/stop`, { method: "POST", headers: authed });
      assert.equal(stopRes.status, 200);
      assert.equal((await stopRes.json()).status, "stopped");
    } finally {
      await killChild(child);
      await rm(homeDir, { recursive: true, force: true });
    }
  }
);

test("hermes gateway status wording from v0.20 counts as running and surfaces warnings", () => {
  const supervised = [
    "Launchd plist: ~/Library/LaunchAgents/ai.hermes.gateway.plist",
    "⚠ Service definition is stale relative to the current Hermes install",
    "  Run: hermes gateway start",
    "✓ Gateway is supervised by launchd (PID 4242)"
  ].join("\n");
  assert.equal(runningFromText(supervised), true);
  assert.deepEqual(warningsFromText(supervised), ["Service definition is stale relative to the current Hermes install"]);
  assert.equal(runningFromText("✗ Gateway is not running"), false);
  assert.equal(runningFromText("Gateway service is not supervised"), false);
  assert.equal(runningFromText(""), false);
});
