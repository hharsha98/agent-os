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
import { approvalsSafety, featuresFromHelp, runningFromText, warningsFromText } from "../server/runtime/agents/hermes.js";
import { eventsFromDocument, gatewayFeaturesFromHelp } from "../server/runtime/agents/openclaw.js";
import { clearDetectCaches, resolveBinary } from "../server/runtime/agents/detect.js";
import { createRunManager } from "../server/runtime/runs/run-manager.js";

// Fakes first, then only the operating system's own folders. The developer's
// normal PATH (e.g. ~/.local/bin, Homebrew) holds the REAL agent CLIs, which
// tests must never run, not even for --version. The shims call node by its
// absolute path, so node does not need to be on PATH.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

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
  if (process.env.FAKE_HERMES_REAL_HELP === "1") {
    // Taken from a real Hermes v0.21.5 usage line.
    lines.push("usage: hermes chat [-h] [-q QUERY] [-t TOOLSETS] [--format {text,stream-json}] [--in DIR]");
    lines.push("  -t TOOLSETS, --toolsets TOOLSETS");
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
  if (process.env.FAKE_HERMES_APPROVALS_FAIL === "1") {
    process.stderr.write("config store is locked\\n");
    process.exit(1);
  }
  if (process.env.FAKE_HERMES_APPROVALS_EMPTY === "1") process.exit(0);
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
  } else if (process.env.FAKE_HERMES_REAL_STREAM === "1" && args.includes("--format")) {
    // The three lines a real Hermes v0.21.5 printed (subscription model, so no cost).
    print(JSON.stringify({ type: "system", subtype: "init", model: "cursor-subscription", session_id: "20261003_092047_de1073", timestamp: 1791012047865 }));
    print(JSON.stringify({ type: "text", text: "OK", timestamp: 1791012052297 }));
    print(JSON.stringify({ type: "result", session_id: "20261003_092047_de1073", exit_code: 0, text: "OK", tokens: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 }, duration_ms: 4730, timestamp: 1791012052595 }));
    process.exit(0);
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
import { appendFileSync, readFileSync } from "node:fs";

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

if (args[0] === "agent" && args.includes("--help") && args[1] !== "exec") {
  // Options listed by a real OpenClaw 2026.9.6 \`openclaw agent --help\`.
  print([
    "Usage: openclaw agent [options]",
    "  --session-id <id>   Use an explicit session id",
    "  --session-key <key>",
    "  --message-file <path>   Read the message from a file (max 4 MiB)",
    "  --json              Output result as JSON",
    "  --model <id>        Model override for this run",
    "  --thinking <level>",
    "  --timeout <seconds>",
    "  --local             Run the embedded agent"
  ].join("\\n"));
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

if (args[0] === "config" && args[1] === "get" && args[2] === "browser.allowSystemProfileImport") {
  // The real CLI prints a sentence, not a value, when a path is unset.
  print(process.env.FAKE_OPENCLAW_COOKIE_IMPORT ?? "Config path is valid but unset: browser.allowSystemProfileImport.");
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

if (args[0] === "agent" && args.includes("--session-id")) {
  recordArgv();
  const file = args[args.indexOf("--message-file") + 1];
  const message = readFileSync(file, "utf8");
  // Noise a real OpenClaw prints on stderr, then ONE pretty-printed document.
  process.stderr.write("(node:123) ExperimentalWarning: SQLite is an experimental feature\\n");
  process.stderr.write("openclaw: Retrying with the fallback model\\n");
  const reply = process.env.FAKE_OPENCLAW_REPLY || "echo: " + message.trim();
  print(JSON.stringify({
    runId: "5c46", status: process.env.FAKE_OPENCLAW_STATUS || "ok", summary: "completed",
    result: {
      payloads: [{ text: reply }],
      meta: {
        durationMs: 52982,
        agentMeta: {
          sessionId: args[args.indexOf("--session-id") + 1], provider: "ollama", model: args.includes("--model") ? args[args.indexOf("--model") + 1].split("/").pop() : "llama3.2:3b",
          usage: { input: 80530, output: 187, cost: { total: 0 } }, costUsd: 0
        },
        finalAssistantVisibleText: reply,
        toolSummary: { calls: 13, tools: ["message", "tool_call", "ask_user", "exec"], failures: 13 },
        stopReason: "stop"
      }
    }
  }, null, 2));
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
      { PATH: [shimDir, ...SYSTEM_PATH_DIRS].join(path.delimiter), FAKE_HERMES_VERSION: undefined, FAKE_HERMES_STREAM_JSON: undefined },
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
    await withEnv({ PATH: [shimDir, ...SYSTEM_PATH_DIRS].join(path.delimiter) }, async () => {
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
  // A temp HOME as well as an empty PATH: the fallback paths live under the
  // home directory, so a real install on the machine running the tests
  // would otherwise be found.
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-empty-home-"));
  try {
    await withEnv({ PATH: "/definitely/not/a/real/path", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home }, async () => {
      clearDetectCaches();
      const detected = await openclaw.detect({ refresh: true });
      assert.equal(detected.installed, false);
      assert.equal(detected.path, "");
      assert.match(detected.error, /not found/);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

test("openclaw.buildRun(): parseLine is attached to the --json exec plans only, not the gateway or legacy ones", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const base = { prompt: "do the thing", cwd: "/proj", runDir };
    const stdinPlan = await openclaw.buildRun({
      ...base,
      detected: { installed: true, path: "/fake/openclaw", features: { agentExec: true, messageFile: true, json: true } },
      checkService: stubService(false)
    });
    const argvPlan = await openclaw.buildRun({
      ...base,
      detected: { installed: true, path: "/fake/openclaw", features: { agentExec: true } },
      checkService: stubService(false)
    });
    const gatewayPlan = await openclaw.buildRun({
      ...base,
      detected: { installed: true, path: "/fake/openclaw", features: { agentExec: true } },
      checkService: stubService(true)
    });
    const legacyPlan = await openclaw.buildRun({
      ...base,
      detected: { installed: true, path: "/fake/openclaw", features: { agentExec: false } },
      checkService: stubService(false)
    });
    assert.equal(typeof stdinPlan.parseLine, "function");
    assert.equal(typeof argvPlan.parseLine, "function");
    // These two print plain text, so their lines stay ordinary `line` events.
    assert.equal(gatewayPlan.parseLine, undefined);
    assert.equal(legacyPlan.parseLine, undefined);
  });
});

test(
  "openclaw exec run: records a result event and usage.costUsd in the run log (the Runs page needs both)",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    await withTempHome(async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        const detected = {
          installed: true,
          path: openclawShim,
          version: "1.0.0",
          features: { agentExec: true, messageFile: true, cwd: true, json: true }
        };
        const plan = await openclaw.buildRun({ prompt: "hello from a run", cwd: runDir, detected, runDir, checkService: stubService(false) });
        const manager = createRunManager();
        const started = await manager.startRun(plan);
        const finished = await manager.waitForRun(started.id, { timeoutMs: 15000 });
        assert.equal(finished.status, "succeeded");
        assert.equal(finished.usage.costUsd, 0.02);
        assert.equal(finished.usage.inputTokens, 8);
        assert.equal(finished.usage.outputTokens, 4);
        const events = await manager.readEvents(started.id);
        const result = events.find((event) => event.type === "result");
        assert.ok(result, "the JSON envelope should have become a result event");
        assert.equal(result.text, "echo: hello from a run");
        assert.ok(events.some((event) => event.type === "usage" && event.costUsd === 0.02));
      });
    });
  }
);

// =====================================================================
// W12c. Real formats: Hermes stream-json + toolsets, OpenClaw gateway JSON
// =====================================================================

const REAL_HERMES_LINES = [
  { type: "system", subtype: "init", model: "cursor-subscription", session_id: "20261003_092047_de1073", timestamp: 1791012047865 },
  { type: "text", text: "OK", timestamp: 1791012052297 },
  {
    type: "result",
    session_id: "20261003_092047_de1073",
    exit_code: 0,
    text: "OK",
    tokens: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 4730,
    timestamp: 1791012052595
  }
].map((line) => JSON.stringify(line));

test("hermes featuresFromHelp(): the real v0.21.5 usage line turns on streamJson and toolsets", () => {
  const real = "usage: hermes chat [-h] [-q QUERY] [-t TOOLSETS] [--format {text,stream-json}] [--in DIR]";
  const features = featuresFromHelp(real);
  assert.equal(features.streamJson, true);
  assert.equal(features.toolsets, true);
  assert.equal(features.inDir, true);
  assert.equal(features.helpFailed, undefined);
});

test("hermes featuresFromHelp(): a wrapped help line still counts, and v0.20.6 (no --format) does not", () => {
  // argparse can wrap inside the hyphenated word, or between the flag and its choices.
  assert.equal(featuresFromHelp("  --format {text,stream-\n  json}\n").streamJson, true);
  assert.equal(featuresFromHelp("  --format\n      {text,stream-json}\n").streamJson, true);
  const old = featuresFromHelp("Usage: hermes chat\n  --query-file PATH\n  --oneshot\n  -Q, --quiet\n  --in DIR");
  assert.equal(old.streamJson, false);
  assert.equal(old.toolsets, false);
  // Mentioning stream-json somewhere without a --format flag is not enough.
  assert.equal(featuresFromHelp("see the stream-json docs").streamJson, false);
  // `-t TOOLSETS, --toolsets TOOLSETS` and the long form alone both count.
  assert.equal(featuresFromHelp("  -t TOOLSETS, --toolsets TOOLSETS").toolsets, true);
  assert.equal(featuresFromHelp("  --toolsets TOOLSETS").toolsets, true);
  // Empty help means the call failed: flagged so it is not cached.
  assert.equal(featuresFromHelp("").helpFailed, true);
});

test("hermes.parseLine(): the three real stream-json lines give system(model), text, result and token usage with NO cost", () => {
  const ctx = { streamJson: true };
  const [init, text, result] = REAL_HERMES_LINES.map((line) => hermes.parseLine(line, "stdout", ctx));
  assert.deepEqual(init, [{ type: "system", text: "Model: cursor-subscription", model: "cursor-subscription" }]);
  assert.deepEqual(text, [{ type: "text", text: "OK" }]);
  assert.deepEqual(result[0], { type: "result", text: "OK", data: { exit_code: 0, session_id: "20261003_092047_de1073" } });
  assert.deepEqual(result[1], { type: "usage", inputTokens: 0, outputTokens: 0 });
  assert.equal("costUsd" in result[1], false, "a subscription model reports no cost: it is unknown, not 0");

  // A future version that does send a cost is still read.
  const withCost = hermes.parseLine(JSON.stringify({ type: "result", exit_code: 0, text: "x", total_cost_usd: 0.03, tokens: { input: 5, output: 2 } }), "stdout", ctx);
  assert.equal(withCost[1].costUsd, 0.03);
  assert.equal(withCost[1].inputTokens, 5);
});

test("hermes.buildRun(): talkOnly adds -t todo when toolsets are supported, and warns when they are not", async () => {
  await withTempHome(async () => {
    await withEnv({ HERMES_HOME: undefined }, async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        const supported = {
          installed: true,
          path: "/fake/hermes",
          features: { queryFile: true, oneshot: true, quiet: true, inDir: true, streamJson: true, toolsets: true }
        };
        const talk = await hermes.buildRun({ prompt: "hi", cwd: "/proj", detected: supported, runDir, options: { talkOnly: true } });
        const queryFile = path.join(runDir, "query.txt");
        assert.deepEqual(talk.args, ["chat", "--oneshot", "-Q", "--query-file", queryFile, "--in", "/proj", "--format", "stream-json", "-t", "todo"]);
        for (const bad of ["terminal", "file", "code_execution", "browser", "computer_use"]) {
          assert.ok(!talk.args.includes(bad));
        }
        assert.equal(talk.notices, undefined);

        // Without talkOnly nothing changes.
        const normal = await hermes.buildRun({ prompt: "hi", cwd: "/proj", detected: supported, runDir });
        assert.ok(!normal.args.includes("-t"));

        const old = { installed: true, path: "/fake/hermes", features: { inDir: true } };
        const warned = await hermes.buildRun({ prompt: "hi", cwd: "/proj", detected: old, runDir, options: { talkOnly: true } });
        assert.ok(!warned.args.includes("-t"), "an unsupported flag is never passed");
        assert.deepEqual(warned.notices, ["This Hermes version can't limit its tools for this turn."]);
      });
    });
  });
});

test(
  "hermes run with the real stream-json sample: result OK, model on the run, tokens but no costUsd, talk-only warning recorded",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    await withTempHome(async () => {
      await withEnv({ HERMES_HOME: undefined }, async () => {
        await withTempDir("agents-rundir-", async (runDir) => {
          const detected = {
            installed: true,
            path: hermesShim,
            features: { queryFile: true, oneshot: true, quiet: true, inDir: true, streamJson: true, toolsets: false }
          };
          const plan = await hermes.buildRun({ prompt: "say OK", cwd: runDir, detected, runDir, options: { talkOnly: true } });
          // A run's child only gets an allow-listed environment, plus plan.env: steer the fake through that.
          plan.env = { ...plan.env, FAKE_HERMES_REAL_STREAM: "1" };
          const manager = createRunManager();
          const started = await manager.startRun(plan);
          const finished = await manager.waitForRun(started.id, { timeoutMs: 15000 });
          assert.equal(finished.status, "succeeded");
          assert.equal(finished.model, "cursor-subscription");
          assert.equal(finished.usage.costUsd, undefined, "unknown cost stays unknown");
          assert.equal(finished.usage.inputTokens, 0);
          const events = await manager.readEvents(started.id);
          assert.equal(events.find((event) => event.type === "result").text, "OK");
          assert.ok(events.some((event) => event.type === "system" && /can't limit its tools/.test(event.text)));
        });
      });
    });
  }
);

test(
  "openclaw.detect(): `agent --help` options become sessionId / messageFileGateway / jsonGateway / modelOverride",
  { skip: isWindows ? "spawns a shebang fake CLI via a PATH shim (POSIX-only)" : false },
  async () => {
    await withEnv({ PATH: [shimDir, ...SYSTEM_PATH_DIRS].join(path.delimiter) }, async () => {
      clearDetectCaches();
      const detected = await openclaw.detect({ refresh: true });
      assert.equal(detected.features.sessionId, true);
      assert.equal(detected.features.messageFileGateway, true);
      assert.equal(detected.features.jsonGateway, true);
      assert.equal(detected.features.modelOverride, true);
    });
    assert.deepEqual(gatewayFeaturesFromHelp("Usage: openclaw agent\n  -m, --message <text>"), {
      sessionId: false,
      messageFileGateway: false,
      jsonGateway: false,
      modelOverride: false
    });
  }
);

const GATEWAY_FEATURES = { agentExec: true, messageFile: true, cwd: true, json: true, sessionId: true, messageFileGateway: true, jsonGateway: true, modelOverride: true };

test("openclaw.buildRun(): the gateway plan uses --session-id, --message-file and --json (+ --model), and the prompt never touches argv", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/openclaw", features: GATEWAY_FEATURES };
    const secret = "a long room prompt that must not be on argv";
    const plan = await openclaw.buildRun({
      prompt: secret,
      cwd: "/proj",
      detected,
      runDir,
      options: { sessionId: "agentos-room-room-20261003-092047-ab12", model: "ollama/phi4" },
      checkService: stubService(true)
    });
    const messageFile = path.join(runDir, "message.txt");
    assert.deepEqual(plan.args, [
      "agent",
      "--session-id",
      "agentos-room-room-20261003-092047-ab12",
      "--message-file",
      messageFile,
      "--json",
      "--model",
      "ollama/phi4"
    ]);
    assert.ok(!plan.args.some((arg) => arg.includes("long room prompt")));
    assert.equal(await readFile(messageFile, "utf8"), secret);
    if (!isWindows) assert.equal((await stat(messageFile)).mode & 0o777, 0o600);
    assert.equal(typeof plan.parseLine, "function");
    assert.equal(typeof plan.onOutputEnd, "function");
    await plan.onExit({});
    await assert.rejects(() => readFile(messageFile, "utf8"));

    // No options: the default session, no model flag.
    const plain = await openclaw.buildRun({ prompt: "x", cwd: "/proj", detected, runDir, checkService: stubService(true) });
    assert.deepEqual(plain.args.slice(0, 3), ["agent", "--session-id", "agentos-runs"]);
    assert.ok(!plain.args.includes("--model"));

    // A bad session id or model is never passed (a model may not look like a flag).
    const bad = await openclaw.buildRun({
      prompt: "x",
      cwd: "/proj",
      detected,
      runDir,
      options: { sessionId: "../../etc", model: "--yolo" },
      checkService: stubService(true)
    });
    assert.deepEqual(bad.args.slice(0, 3), ["agent", "--session-id", "agentos-runs"]);
    assert.ok(!bad.args.includes("--model") && !bad.args.includes("--yolo"));
    assert.match(bad.notices.join(" "), /switch models/);
  });
});

test("openclaw.buildRun(): -m stays only for versions without --message-file, with a warning notice", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const old = { installed: true, path: "/fake/openclaw", features: { agentExec: true, sessionId: true } };
    const plan = await openclaw.buildRun({ prompt: "do it", cwd: "/proj", detected: old, runDir, checkService: stubService(true) });
    assert.deepEqual(plan.args, ["agent", "-m", "do it"]);
    assert.match(plan.notices[0], /can't read the prompt from a file/);
    // A version WITH the option never falls back, even if it lacks --session-id.
    const noSession = { installed: true, path: "/fake/openclaw", features: { messageFileGateway: true } };
    const file = await openclaw.buildRun({ prompt: "do it", cwd: "/proj", detected: noSession, runDir, checkService: stubService(true) });
    assert.ok(!file.args.includes("-m") && !file.args.includes("do it"));
    assert.ok(!file.args.includes("--session-id"));
    assert.match(file.notices[0], /separate conversation/);
  });
});

// A trimmed copy of a real OpenClaw 2026.9.6 `agent --json` document (field paths kept).
const REAL_OPENCLAW_DOC = {
  runId: "5c46",
  status: "ok",
  summary: "completed",
  result: {
    payloads: [{ text: "First part." }, { text: "NOTE: second part." }],
    meta: {
      durationMs: 52982,
      agentMeta: {
        sessionId: "agentos-format-probe",
        provider: "ollama",
        model: "llama3.2:3b",
        usage: { input: 80530, output: 187, cost: { total: 0 } },
        costUsd: 0
      },
      finalAssistantVisibleText: "First part. NOTE: second part.",
      toolSummary: { calls: 13, tools: ["message", "tool_call", "ask_user", "exec"], failures: 13 },
      stopReason: "stop"
    }
  }
};

test("openclaw eventsFromDocument(): result, model, tool summary and a real $0 cost, from the document's field paths", () => {
  const events = eventsFromDocument(REAL_OPENCLAW_DOC);
  assert.deepEqual(events[0], { type: "system", text: "Model: ollama/llama3.2:3b", model: "ollama/llama3.2:3b" });
  assert.deepEqual(events[1], {
    type: "system",
    text: "OpenClaw tried 13 tool calls; 13 failed.",
    data: { toolCalls: 13, toolFailures: 13 }
  });
  const result = events.find((event) => event.type === "result");
  assert.equal(result.text, "First part.\n\nNOTE: second part.");
  assert.deepEqual(result.data, { ok: true, status: "ok" });
  const usage = events.find((event) => event.type === "usage");
  assert.equal(usage.costUsd, 0, "a real 0 stays 0 (known and free)");
  assert.equal(usage.inputTokens, 80530);
  assert.equal(usage.outputTokens, 187);

  // No payloads: the final visible text is used. No cost field: unknown.
  const fallback = eventsFromDocument({ status: "ok", result: { payloads: [], meta: { finalAssistantVisibleText: "only this", agentMeta: { provider: "p", model: "m" } } } });
  assert.equal(fallback.find((event) => event.type === "result").text, "only this");
  assert.equal(fallback.find((event) => event.type === "usage"), undefined);

  // A status other than ok adds an error event.
  const failed = eventsFromDocument({ status: "error", summary: "model unavailable", result: {} });
  assert.ok(failed.some((event) => event.type === "error" && /error/.test(event.text)));
  assert.equal(failed.find((event) => event.type === "result").data.ok, false);
});

test("openclaw gateway plan: many stdout lines are collected and parsed once at the end; stderr noise stays stderr", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/openclaw", features: GATEWAY_FEATURES };
    const plan = await openclaw.buildRun({ prompt: "x", cwd: "/proj", detected, runDir, checkService: stubService(true) });
    const lines = JSON.stringify(REAL_OPENCLAW_DOC, null, 2).split("\n");
    assert.ok(lines.length > 10);
    for (const line of lines) assert.equal(plan.parseLine(line, "stdout"), false, "stdout lines are held back, not logged raw");
    assert.equal(plan.parseLine("(node:1) ExperimentalWarning: SQLite is experimental", "stderr"), null);
    const events = await plan.onOutputEnd();
    assert.equal(events.find((event) => event.type === "result").text, "First part.\n\nNOTE: second part.");
    assert.deepEqual(await plan.onOutputEnd(), null, "nothing is emitted twice");

    // Not JSON at all: the printed lines are kept as plain lines instead of being lost.
    const broken = await openclaw.buildRun({ prompt: "x", cwd: "/proj", detected, runDir, checkService: stubService(true) });
    broken.parseLine("something went wrong", "stdout");
    assert.deepEqual(await broken.onOutputEnd(), [{ type: "line", text: "something went wrong" }]);
  });
});

test(
  "openclaw gateway run (fake CLI): reply, model, tool summary and cost 0 are recorded; the room's session id and model reach argv",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    await withTempHome(async (home) => {
      await withTempDir("agents-rundir-", async (runDir) => {
        const argvFile = path.join(home, "argv.jsonl");
        {
          const detected = { installed: true, path: openclawShim, features: GATEWAY_FEATURES };
          const plan = await openclaw.buildRun({
            prompt: "hello gateway",
            cwd: runDir,
            detected,
            runDir,
            options: { sessionId: "agentos-room-r1", model: "ollama/phi4" },
            checkService: stubService(true)
          });
          plan.env = { ...plan.env, FAKE_OPENCLAW_RECORD_ARGV: argvFile };
          const manager = createRunManager();
          const started = await manager.startRun(plan);
          const finished = await manager.waitForRun(started.id, { timeoutMs: 15000 });
          assert.equal(finished.status, "succeeded");
          assert.equal(finished.model, "ollama/phi4");
          assert.equal(finished.usage.costUsd, 0);
          assert.equal(finished.usage.inputTokens, 80530);
          const events = await manager.readEvents(started.id);
          assert.equal(events.find((event) => event.type === "result").text, "echo: hello gateway");
          assert.ok(events.some((event) => event.type === "system" && /13 tool calls; 13 failed/.test(event.text)));
          // The 30-odd JSON lines are not logged raw; the stderr noise is, as stderr lines.
          assert.ok(!events.some((event) => event.stream === "stdout" && event.type === "line"));
          assert.ok(events.some((event) => event.stream === "stderr" && event.type === "line" && /ExperimentalWarning/.test(event.text)));
          assert.ok(!events.some((event) => event.type === "text"));

          const argv = JSON.parse((await readFile(argvFile, "utf8")).trim().split("\n")[0]);
          assert.deepEqual(argv.slice(0, 3), ["agent", "--session-id", "agentos-room-r1"]);
          assert.equal(argv[argv.indexOf("--model") + 1], "ollama/phi4");
          assert.ok(!argv.includes("hello gateway"));
        }
      });
    });
  }
);

// =====================================================================
// 6 + 7. safetyStatus / configStatus against the fake CLIs directly
// =====================================================================

test(
  "openclaw.safetyStatus(): tools.exec.mode=full is permissive with an exec-ask action; ask is not",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    const detected = { installed: true, path: openclawShim, version: "1.0.0", features: {} };
    await withEnv({ FAKE_OPENCLAW_EXEC_MODE: "full", FAKE_OPENCLAW_COOKIE_IMPORT: undefined }, async () => {
      const status = await openclaw.safetyStatus(detected);
      assert.equal(status.permissive, true);
      assert.ok(status.actions.some((action) => action.id === "exec-ask"));
      // Unset cookie import means the permissive upstream default.
      assert.ok(status.actions.some((action) => action.id === "no-browser-cookies"));
    });
    await withEnv({ FAKE_OPENCLAW_EXEC_MODE: "ask", FAKE_OPENCLAW_COOKIE_IMPORT: "false" }, async () => {
      const status = await openclaw.safetyStatus(detected);
      assert.equal(status.permissive, false);
      assert.deepEqual(status.actions, []);
    });
    const cookiePlan = openclaw.safetyAction("no-browser-cookies", detected);
    assert.deepEqual(cookiePlan.args, ["config", "set", "browser.allowSystemProfileImport", "false"]);
    assert.equal(openclaw.safetyAction("not-a-real-action", detected), null);
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

test(
  "hermes.safetyStatus(): a setting it could not read is known: false, never 'approvals are on' (fake CLI)",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    const detected = { installed: true, path: hermesShim, version: "0.20.6", features: {} };
    const clean = { FAKE_HERMES_APPROVALS: undefined, FAKE_HERMES_APPROVALS_FAIL: undefined, FAKE_HERMES_APPROVALS_EMPTY: undefined };
    // Read fine: "manual" (a real mode) is on, and the answer is known (true, or the field absent).
    await withEnv({ ...clean, FAKE_HERMES_APPROVALS: "manual" }, async () => {
      const status = await hermes.safetyStatus(detected);
      assert.equal(status.permissive, false);
      assert.notEqual(status.known, false);
      assert.match(status.summary, /approvals are on/);
      assert.deepEqual(status.actions, []);
    });
    // "off" stays off, and is a known answer.
    await withEnv({ ...clean, FAKE_HERMES_APPROVALS: "off" }, async () => {
      const status = await hermes.safetyStatus(detected);
      assert.equal(status.permissive, true);
      assert.notEqual(status.known, false);
      assert.match(status.summary, /YOLO/);
    });
    // The read failed (the CLI exited with an error): not known, and the old fields still hold.
    await withEnv({ ...clean, FAKE_HERMES_APPROVALS_FAIL: "1" }, async () => {
      const status = await hermes.safetyStatus(detected);
      assert.equal(status.known, false);
      assert.equal(status.permissive, false);
      assert.deepEqual(status.actions, []);
      assert.doesNotMatch(status.summary, /approvals are on/i);
    });
    // The CLI printed nothing at all: not known.
    await withEnv({ ...clean, FAKE_HERMES_APPROVALS_EMPTY: "1" }, async () => {
      const status = await hermes.safetyStatus(detected);
      assert.equal(status.known, false);
      assert.doesNotMatch(status.summary, /approvals are on/i);
    });
    // The program could not even start: not known.
    const gone = await hermes.safetyStatus({ installed: true, path: path.join(os.tmpdir(), "agent-os-no-such-hermes"), version: "0.20.6", features: {} });
    assert.equal(gone.known, false);
    assert.doesNotMatch(gone.summary, /approvals are on/i);
  }
);

test("hermes approvalsSafety(): success, off, failure, timeout and empty output (no CLI, so the timeout is instant)", () => {
  const ok = (stdout) => ({ ok: true, stdout, stderr: "", code: 0, signal: null, aborted: false });
  const on = approvalsSafety(ok("manual"));
  assert.equal(on.permissive, false);
  assert.notEqual(on.known, false);
  assert.match(on.summary, /approvals are on/);
  assert.equal(approvalsSafety(ok("MANUAL\n")).permissive, false, "case and spaces do not matter");
  const off = approvalsSafety(ok(" Off "));
  assert.equal(off.permissive, true);
  assert.notEqual(off.known, false);
  // A timeout is execFile's kill: not ok, no output, a signal (code is reported as 0).
  const timedOut = approvalsSafety({ ok: false, stdout: "", stderr: "", code: 0, signal: "SIGTERM", aborted: false });
  // An error exit, a program that would not start, an abort and empty output.
  const failed = approvalsSafety({ ok: false, stdout: "", stderr: "boom", code: 1, signal: null, aborted: false });
  const spawnError = approvalsSafety({ ok: false, stdout: "", stderr: "", code: "ENOENT", signal: null, aborted: false });
  const aborted = approvalsSafety({ ok: false, stdout: "", stderr: "", code: 0, signal: null, aborted: true });
  const empty = approvalsSafety(ok(""));
  const blank = approvalsSafety(ok("  \n"));
  const missing = approvalsSafety(undefined);
  for (const [name, status] of Object.entries({ timedOut, failed, spawnError, aborted, empty, blank, missing })) {
    assert.equal(status.known, false, name);
    assert.equal(status.permissive, false, `${name}: the old field is unchanged`);
    assert.deepEqual(status.actions, [], name);
    assert.doesNotMatch(status.summary, /approvals are on/i, name);
    assert.match(status.summary, /could not read/i, name);
  }
  // Partial output from a read that then failed is not trusted as "on".
  assert.equal(approvalsSafety({ ok: false, stdout: "manual", stderr: "", code: 1, signal: null, aborted: false }).known, false);
  // But an "off" that was printed is never hidden: a warning that is too loud is safer than a missing one.
  assert.equal(approvalsSafety({ ok: false, stdout: "off", stderr: "", code: 1, signal: null, aborted: false }).permissive, true);
});

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
    PATH: [shimDir, ...SYSTEM_PATH_DIRS].join(path.delimiter),
    // Detection also looks in folders under HOME (~/.local/bin, ...), where
    // the developer's real agents live. Point HOME at the temp folder.
    HOME: home,
    USERPROFILE: home
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
      assert.deepEqual(listBody.agents.map((a) => a.id).sort(), ["claude", "codex", "cursor", "hermes", "openclaw"]);
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
