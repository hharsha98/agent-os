// Adapters for Claude Code, Codex and Cursor Agent: buildRun/parseLine pure
// unit tests (every platform), detect() against fake CLIs, a fake-CLI run
// through the run manager, and the /api/agents HTTP surface. Mirrors the
// structure of test/agents.test.js (Hermes/OpenClaw), but for these three.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { containsBlockedFlag } from "../server/runtime/agent-flags.js";
import { ADAPTERS } from "../server/runtime/agents/index.js";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { createRunManager } from "../server/runtime/runs/run-manager.js";

const isWindows = process.platform === "win32";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { claude, codex, cursor } = ADAPTERS;
const TOKEN = "test-coding-agents-token-123";

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
  return withTempDir("agent-os-coding-agents-home-", (home) => withEnv({ AGENT_OS_HOME: home }, () => fn(home)));
}

// =====================================================================
// Fake CLI sources (POSIX-only, inline like test/agents.test.js) so
// node --test never mistakes either the source or the shim for a test file.
// =====================================================================

const FAKE_CLAUDE_SOURCE = `
const args = process.argv.slice(2);

function print(text) {
  process.stdout.write(\`\${text}\\n\`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

if (args.includes("--version")) {
  print(process.env.FAKE_CLAUDE_VERSION || "2.1.281 (Claude Code)");
  process.exit(0);
}

if (args.length === 1 && args[0] === "--help") {
  print([
    "Usage: claude [options] [command] [prompt]",
    "  -p, --print                  Print response and exit",
    "  --output-format <format>     (choices: \\"text\\", \\"json\\", \\"stream-json\\")",
    "  --verbose                    Override verbose mode setting from config",
    "  --add-dir <directories...>   Additional directories to allow tool access to",
    "  --permission-mode <mode>     (choices: \\"acceptEdits\\", \\"auto\\", \\"bypassPermissions\\", \\"manual\\", \\"dontAsk\\", \\"plan\\")",
    "Commands:",
    "  auth                         Manage authentication"
  ].join("\\n"));
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  print(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== "0" }));
  process.exit(0);
}

if (args.includes("-p")) {
  const prompt = await readStdin();
  if (args.includes("stream-json")) {
    print(JSON.stringify({ type: "system", subtype: "init", model: "claude-test" }));
    print(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: \`echo: \${prompt.trim()}\` }, { type: "tool_use", name: "search", input: { query: "docs" } }] }
    }));
    print(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "found 3 results" }] } }));
    print(JSON.stringify({
      type: "result",
      is_error: false,
      num_turns: 2,
      result: "done",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 }
    }));
  } else {
    print(\`echo: \${prompt.trim()}\`);
  }
  process.exit(0);
} else {
  print(\`fake-claude: unknown command \${JSON.stringify(args)}\`);
  process.exit(1);
}
`;

const FAKE_CODEX_SOURCE = `
const args = process.argv.slice(2);

function print(text) {
  process.stdout.write(\`\${text}\\n\`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

if (args.includes("--version")) {
  print(process.env.FAKE_CODEX_VERSION || "codex-cli 0.154.0");
  process.exit(0);
}

if (args[0] === "exec" && args.includes("--help")) {
  print([
    "Run Codex non-interactively",
    "  --json                     Print events to stdout as JSONL",
    "  -s, --sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]",
    "  -C, --cd <DIR>",
    "  --skip-git-repo-check",
    "  --ephemeral",
    "  --color <COLOR>",
    "Arguments:",
    "  [PROMPT] If not provided as an argument (or if \\\`-\\\` is used), instructions are read from stdin."
  ].join("\\n"));
  process.exit(0);
}

if (args[0] === "--help") {
  print(["Codex CLI", "Commands:", "  login   Manage login", "  exec    Run Codex non-interactively"].join("\\n"));
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  print(process.env.FAKE_CODEX_LOGGED_IN === "0" ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(0);
}

if (args[0] === "exec") {
  const prompt = args.includes("-") ? await readStdin() : args[args.length - 1];
  print(JSON.stringify({ type: "thread.started", thread_id: "th_1" }));
  print(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: \`echo: \${String(prompt).trim()}\` } }));
  print(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: 0 } }));
  print(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }));
  process.exit(0);
} else {
  print(\`fake-codex: unknown command \${JSON.stringify(args)}\`);
  process.exit(1);
}
`;

const FAKE_CURSOR_SOURCE = `
const args = process.argv.slice(2);

function print(text) {
  process.stdout.write(\`\${text}\\n\`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

if (args.includes("--version") || args.includes("-v")) {
  print(process.env.FAKE_CURSOR_VERSION || "2026.09.23-test");
  process.exit(0);
}

if (args.includes("--help")) {
  print([
    "Usage: agent [options] [command] [prompt...]",
    "  -p, --print                  Print responses to console",
    "  --output-format <format>     text | json | stream-json",
    "  --workspace <path-or-name>   Workspace directory or saved workspace name to use",
    "  --trust                      Trust the current workspace without prompting",
    "  -f, --force                  Force allow commands unless explicitly denied",
    "  --yolo                       Alias for --force (Run Everything)",
    "Commands:",
    "  status|whoami [options]      View authentication status"
  ].join("\\n"));
  process.exit(0);
}

if (args[0] === "status") {
  const authed = process.env.FAKE_CURSOR_AUTH !== "0";
  print(JSON.stringify({ status: authed ? "authenticated" : "unauthenticated", isAuthenticated: authed }));
  process.exit(0);
}

if (args.includes("-p")) {
  const dashIndex = args.indexOf("--");
  const prompt = dashIndex !== -1 ? args[dashIndex + 1] : await readStdin();
  if (args.includes("stream-json")) {
    print(JSON.stringify({ type: "system", subtype: "init", model: "cursor-test" }));
    print(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: \`echo: \${String(prompt).trim()}\` }] } }));
    print(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "file.txt" } } } }));
    print(JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      tool_call: { readToolCall: { args: { path: "file.txt" }, result: { success: { totalLines: 3 } } } }
    }));
    print(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
  } else {
    print(\`echo: \${String(prompt).trim()}\`);
  }
  process.exit(0);
} else {
  print(\`fake-cursor: unknown command \${JSON.stringify(args)}\`);
  process.exit(1);
}
`;

let sourceDir = null;
let shimDir = null;
let claudeShim = null;
let codexShim = null;
let cursorShim = null;

before(async () => {
  if (isWindows) return;
  sourceDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-coding-agents-src-"));
  shimDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-coding-agents-bin-"));

  const claudeSource = path.join(sourceDir, "fake-claude.mjs");
  const codexSource = path.join(sourceDir, "fake-codex.mjs");
  const cursorSource = path.join(sourceDir, "fake-cursor.mjs");
  await writeFile(claudeSource, FAKE_CLAUDE_SOURCE);
  await writeFile(codexSource, FAKE_CODEX_SOURCE);
  await writeFile(cursorSource, FAKE_CURSOR_SOURCE);

  claudeShim = path.join(shimDir, "claude");
  codexShim = path.join(shimDir, "codex");
  cursorShim = path.join(shimDir, "agent");
  for (const [shim, source] of [
    [claudeShim, claudeSource],
    [codexShim, codexSource],
    [cursorShim, cursorSource]
  ]) {
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`);
    await chmod(shim, 0o755);
  }
});

after(async () => {
  if (shimDir) await rm(shimDir, { recursive: true, force: true });
  if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
});

// =====================================================================
// 1. Pure unit tests: buildRun (every platform, hand-made `detected`)
// =====================================================================

const FULL_CLAUDE_FEATURES = {
  print: true,
  streamJson: true,
  verbose: true,
  permissionMode: true,
  addDir: true,
  permissionModes: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
  authStatus: true
};

test("claude.buildRun(): stream-json + verbose + dontAsk + add-dir when every feature exists; prompt only on stdin", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/claude", version: "2.1.281", features: FULL_CLAUDE_FEATURES };
    const plan = await claude.buildRun({ prompt: "do the thing --dangerously-skip-permissions", cwd: "/some/project", detected, runDir });
    assert.deepEqual(plan.args, [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--add-dir",
      "/some/project"
    ]);
    assert.equal(plan.cwd, runDir);
    assert.equal(plan.stdin, "do the thing --dangerously-skip-permissions");
    assert.ok(!plan.args.some((arg) => arg.includes("do the thing")));
    assert.ok(!plan.args.some((arg) => containsBlockedFlag(arg)));
  });
});

test("claude.buildRun(): allowEdits picks acceptEdits over dontAsk when both are listed", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/claude", version: "2.1.281", features: FULL_CLAUDE_FEATURES };
    const plan = await claude.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir, options: { allowEdits: true } });
    assert.ok(plan.args.includes("--permission-mode"));
    assert.equal(plan.args[plan.args.indexOf("--permission-mode") + 1], "acceptEdits");
  });
});

test("claude.buildRun(): falls back to text output and drops permission-mode/add-dir when features are missing", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/claude", version: "2.0.0", features: {} };
    const plan = await claude.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir });
    assert.deepEqual(plan.args, ["-p", "--output-format", "text"]);
  });
});

test("claude.buildRun(): no blocked flags for any feature/allowEdits combination", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const featureSets = [{}, FULL_CLAUDE_FEATURES, { ...FULL_CLAUDE_FEATURES, streamJson: false }];
    for (const features of featureSets) {
      for (const allowEdits of [true, false]) {
        const detected = { installed: true, path: "/fake/claude", version: "x", features };
        const plan = await claude.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir, options: { allowEdits } });
        assert.ok(!plan.args.some((arg) => containsBlockedFlag(arg)));
      }
    }
  });
});

const FULL_CODEX_FEATURES = {
  json: true,
  sandbox: true,
  cd: true,
  skipGitRepoCheck: true,
  ephemeral: true,
  stdinDash: true,
  loginStatus: true
};

test("codex.buildRun(): every flag included, read-only sandbox by default, prompt only on stdin via '-'", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/codex", version: "0.154.0", features: FULL_CODEX_FEATURES };
    const plan = await codex.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir });
    assert.deepEqual(plan.args, [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "-C",
      "/proj",
      "-"
    ]);
    assert.equal(plan.stdin, "do the thing");
    assert.equal(plan.cwd, runDir);
    assert.ok(!plan.args.some((arg) => arg.includes("do the thing")));
  });
});

test("codex.buildRun(): allowEdits switches to workspace-write", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/codex", version: "0.154.0", features: FULL_CODEX_FEATURES };
    const plan = await codex.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir, options: { allowEdits: true } });
    assert.ok(plan.args.includes("workspace-write"));
    assert.ok(!plan.args.includes("read-only"));
  });
});

test("codex.buildRun(): drops unsupported flags and falls back to the '--' argv transport when stdinDash is unsupported", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/codex", version: "0.1.0", features: { stdinDash: false } };
    const plan = await codex.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir });
    assert.deepEqual(plan.args, ["exec", "--color", "never", "--", "do the thing"]);
    assert.equal(plan.stdin, undefined);
  });
});

test("codex.buildRun(): no blocked flags for any feature/allowEdits combination", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    for (const features of [{}, FULL_CODEX_FEATURES, { ...FULL_CODEX_FEATURES, stdinDash: false }]) {
      for (const allowEdits of [true, false]) {
        const detected = { installed: true, path: "/fake/codex", version: "x", features };
        const plan = await codex.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir, options: { allowEdits } });
        assert.ok(!plan.args.some((arg) => containsBlockedFlag(arg)));
      }
    }
  });
});

const FULL_CURSOR_FEATURES = {
  print: true,
  streamJson: true,
  workspace: true,
  trust: true,
  stdinPrompt: false,
  statusCommand: true
};

test("cursor.buildRun(): print + stream-json + workspace + trust; prompt as argv after '--' since stdin isn't documented", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/agent", version: "2026.09.23", features: FULL_CURSOR_FEATURES };
    const plan = await cursor.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir });
    assert.deepEqual(plan.args, ["-p", "--output-format", "stream-json", "--workspace", "/proj", "--trust", "--", "do the thing"]);
    assert.equal(plan.stdin, undefined);
    assert.equal(plan.cwd, runDir);
  });
});

test("cursor.buildRun(): uses stdin instead of argv when a future CLI documents it", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/agent", version: "future", features: { ...FULL_CURSOR_FEATURES, stdinPrompt: true } };
    const plan = await cursor.buildRun({ prompt: "do the thing", cwd: "/proj", detected, runDir });
    assert.equal(plan.stdin, "do the thing");
    assert.ok(!plan.args.some((arg) => arg.includes("do the thing")));
  });
});

test("cursor.buildRun(): allowEdits:true is rejected with allow_edits_not_supported", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    const detected = { installed: true, path: "/fake/agent", version: "2026.09.23", features: FULL_CURSOR_FEATURES };
    await assert.rejects(
      () => cursor.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir, options: { allowEdits: true } }),
      (error) => {
        assert.equal(error.code, "allow_edits_not_supported");
        assert.match(error.message, /Cursor only proposes changes/);
        return true;
      }
    );
  });
});

test("cursor.buildRun(): no blocked flags for any feature combination (allowEdits is never true here)", async () => {
  await withTempDir("agents-rundir-", async (runDir) => {
    for (const features of [{}, FULL_CURSOR_FEATURES, { ...FULL_CURSOR_FEATURES, stdinPrompt: true }]) {
      const detected = { installed: true, path: "/fake/agent", version: "x", features };
      const plan = await cursor.buildRun({ prompt: "hi", cwd: "/proj", detected, runDir });
      assert.ok(!plan.args.some((arg) => containsBlockedFlag(arg)));
    }
  });
});

// =====================================================================
// 2. Pure unit tests: parseLine fixtures per adapter
// =====================================================================

test("claude.parseLine(): system/init, assistant text+tool_use, user tool_result, result+usage, unknown, non-JSON", () => {
  assert.deepEqual(claude.parseLine(JSON.stringify({ type: "system", subtype: "init", model: "claude-x" })), [
    { type: "system", text: "session started (model claude-x)" }
  ]);

  const assistantEvents = claude.parseLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "search", input: { query: "docs" } }] }
    })
  );
  assert.deepEqual(assistantEvents[0], { type: "text", text: "hi" });
  assert.equal(assistantEvents[1].type, "tool");
  assert.match(assistantEvents[1].text, /search/);

  const longContent = "x".repeat(600);
  const toolResultEvents = claude.parseLine(
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: longContent }] } })
  );
  assert.equal(toolResultEvents[0].type, "tool_result");
  assert.equal(toolResultEvents[0].text.length, 500);

  const resultEvents = claude.parseLine(
    JSON.stringify({ type: "result", is_error: false, num_turns: 3, result: "done", total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } })
  );
  assert.deepEqual(resultEvents[0], { type: "result", text: "done", data: { is_error: false, num_turns: 3 } });
  assert.deepEqual(resultEvents[1], { type: "usage", costUsd: 0.02, inputTokens: 10, outputTokens: 5 });

  assert.equal(claude.parseLine(JSON.stringify({ type: "not_a_real_type" })), null);
  assert.equal(claude.parseLine("not json at all"), null);
});

test("codex.parseLine(): thread.started, agent_message, command_execution, file_change, turn.completed, error, unknown, non-JSON", () => {
  assert.deepEqual(codex.parseLine(JSON.stringify({ type: "thread.started", thread_id: "th_1" })), [
    { type: "system", text: "session started (thread th_1)" }
  ]);
  assert.deepEqual(codex.parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } })), [
    { type: "text", text: "hi" }
  ]);
  assert.deepEqual(
    codex.parseLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls -la", exit_code: 0 } })),
    [{ type: "tool", text: "$ ls -la (exit 0)" }]
  );
  assert.deepEqual(codex.parseLine(JSON.stringify({ type: "item.completed", item: { type: "file_change", paths: ["a.js", "b.js"] } })), [
    { type: "tool", text: "changed a.js, b.js" }
  ]);
  const usageEvents = codex.parseLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 24, output_tokens: 12 } }));
  assert.deepEqual(usageEvents, [{ type: "usage", inputTokens: 24, outputTokens: 12 }]);
  assert.equal("costUsd" in usageEvents[0], false);
  assert.deepEqual(codex.parseLine(JSON.stringify({ type: "error", message: "boom" })), [{ type: "error", text: "boom" }]);
  assert.equal(codex.parseLine(JSON.stringify({ type: "turn.started" })), null);
  assert.equal(codex.parseLine("not json"), null);
});

test("cursor.parseLine(): system/init, assistant text, tool_call started/completed, result, unknown JSON, non-JSON", () => {
  assert.deepEqual(cursor.parseLine(JSON.stringify({ type: "system", subtype: "init", model: "cursor-x" })), [
    { type: "system", text: "session started (model cursor-x)" }
  ]);
  assert.deepEqual(cursor.parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })), [
    { type: "text", text: "hi" }
  ]);
  const startedEvents = cursor.parseLine(
    JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "f.txt" } } } })
  );
  assert.equal(startedEvents[0].type, "tool");
  assert.match(startedEvents[0].text, /readTool|read/);
  const completedEvents = cursor.parseLine(
    JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { readToolCall: { args: { path: "f.txt" }, result: { success: { totalLines: 1 } } } } })
  );
  assert.equal(completedEvents[0].type, "tool_result");
  assert.deepEqual(cursor.parseLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })), [
    { type: "result", text: "done", data: { is_error: false } }
  ]);
  const line = JSON.stringify({ type: "some_future_event", foo: "bar" });
  assert.deepEqual(cursor.parseLine(line), [{ type: "line", text: line }]);
  assert.equal(cursor.parseLine("not json at all"), null);
});

// =====================================================================
// 3. Fake-CLI tests: detect() parses --help text into features
// =====================================================================

test(
  "claude.detect(): --help text drives feature flags including permission modes and auth status",
  { skip: isWindows ? "spawns a shebang fake CLI via a PATH shim (POSIX-only)" : false },
  async () => {
    await withEnv({ PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}` }, async () => {
      clearDetectCaches();
      const detected = await claude.detect({ refresh: true });
      assert.equal(detected.installed, true);
      assert.match(detected.version, /2\.1\.281/);
      assert.equal(detected.features.streamJson, true);
      assert.equal(detected.features.verbose, true);
      assert.equal(detected.features.addDir, true);
      assert.equal(detected.features.authStatus, true);
      assert.deepEqual(detected.features.permissionModes, ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
    });
  }
);

test(
  "codex.detect(): --help text drives feature flags including stdinDash and loginStatus",
  { skip: isWindows ? "spawns a shebang fake CLI via a PATH shim (POSIX-only)" : false },
  async () => {
    await withEnv({ PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}` }, async () => {
      clearDetectCaches();
      const detected = await codex.detect({ refresh: true });
      assert.equal(detected.installed, true);
      assert.match(detected.version, /0\.154\.0/);
      assert.equal(detected.features.json, true);
      assert.equal(detected.features.sandbox, true);
      assert.equal(detected.features.cd, true);
      assert.equal(detected.features.skipGitRepoCheck, true);
      assert.equal(detected.features.ephemeral, true);
      assert.equal(detected.features.stdinDash, true);
      assert.equal(detected.features.loginStatus, true);
    });
  }
);

test(
  "cursor.detect(): --help text drives feature flags; stdinPrompt stays false (undocumented)",
  { skip: isWindows ? "spawns a shebang fake CLI via a PATH shim (POSIX-only)" : false },
  async () => {
    await withEnv({ PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}` }, async () => {
      clearDetectCaches();
      const detected = await cursor.detect({ refresh: true });
      assert.equal(detected.installed, true);
      assert.match(detected.version, /2026\.09\.23/);
      assert.equal(detected.features.print, true);
      assert.equal(detected.features.streamJson, true);
      assert.equal(detected.features.workspace, true);
      assert.equal(detected.features.trust, true);
      assert.equal(detected.features.stdinPrompt, false);
      assert.equal(detected.features.statusCommand, true);
    });
  }
);

// =====================================================================
// 4. Fake-CLI tests: a real run through the run manager, output + status
// =====================================================================

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped", "timed_out", "interrupted"]);

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

function waitForTerminal(manager, id, timeoutMs = 15000) {
  return waitFor(
    async () => {
      const run = await manager.getRun(id);
      return run && TERMINAL_STATUSES.has(run.status) ? run : null;
    },
    { timeoutMs }
  );
}

test(
  "claude: a fake-CLI run through the run manager streams parsed text and succeeds",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    await withTempHome(async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        await withTempDir("agents-proj-", async (projectDir) => {
          const detected = { installed: true, path: claudeShim, version: "2.1.281", features: FULL_CLAUDE_FEATURES };
          const manager = createRunManager();
          const plan = await claude.buildRun({ prompt: "hello from claude", cwd: projectDir, detected, runDir });
          const started = await manager.startRun(plan);
          const finished = await waitForTerminal(manager, started.id);
          assert.equal(finished.status, "succeeded");
          const events = await manager.readEvents(started.id);
          assert.ok(events.some((e) => e.type === "text" && e.text.includes("hello from claude")));
        });
      });
    });
  }
);

test(
  "codex: a fake-CLI run through the run manager streams parsed text and succeeds",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    await withTempHome(async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        await withTempDir("agents-proj-", async (projectDir) => {
          const detected = { installed: true, path: codexShim, version: "0.154.0", features: FULL_CODEX_FEATURES };
          const manager = createRunManager();
          const plan = await codex.buildRun({ prompt: "hello from codex", cwd: projectDir, detected, runDir });
          const started = await manager.startRun(plan);
          const finished = await waitForTerminal(manager, started.id);
          assert.equal(finished.status, "succeeded");
          const events = await manager.readEvents(started.id);
          assert.ok(events.some((e) => e.type === "text" && e.text.includes("hello from codex")));
        });
      });
    });
  }
);

test(
  "cursor: a fake-CLI run through the run manager streams parsed text and succeeds",
  { skip: isWindows ? "spawns a shebang fake CLI (POSIX-only)" : false },
  async () => {
    await withTempHome(async () => {
      await withTempDir("agents-rundir-", async (runDir) => {
        await withTempDir("agents-proj-", async (projectDir) => {
          const detected = { installed: true, path: cursorShim, version: "2026.09.23", features: FULL_CURSOR_FEATURES };
          const manager = createRunManager();
          const plan = await cursor.buildRun({ prompt: "hello from cursor", cwd: projectDir, detected, runDir });
          const started = await manager.startRun(plan);
          const finished = await waitForTerminal(manager, started.id);
          assert.equal(finished.status, "succeeded");
          const events = await manager.readEvents(started.id);
          assert.ok(events.some((e) => e.type === "text" && e.text.includes("hello from cursor")));
        });
      });
    });
  }
);

// =====================================================================
// 5. The /api/agents HTTP surface, against the real server + fakes
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

async function waitForRunTerminal(base, headers, id, timeoutMs = 15000) {
  return waitFor(
    async () => {
      const response = await fetch(`${base}/api/runs/${id}`, { headers });
      const body = await response.json();
      return TERMINAL_STATUSES.has(body.status) ? body : null;
    },
    { timeoutMs }
  );
}

test(
  "agents routes: lists all 5 adapters; Cursor allowEdits:true -> 400; Codex allowEdits toggles the sandbox flag",
  { skip: isWindows ? "spawns fake CLIs via PATH shims (POSIX-only)" : false },
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-os-coding-agents-route-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawnServer(baseEnv(homeDir, port));
    const logs = collectLogs(child);
    const authed = { "x-agent-os-token": TOKEN };
    const authedJson = { "Content-Type": "application/json", "x-agent-os-token": TOKEN };

    try {
      await waitForHealth(base, child, logs);

      const listRes = await fetch(`${base}/api/agents`, { headers: authed });
      assert.equal(listRes.status, 200);
      const listBody = await listRes.json();
      assert.deepEqual(listBody.agents.map((a) => a.id).sort(), ["claude", "codex", "cursor", "hermes", "openclaw"]);
      const claudeEntry = listBody.agents.find((a) => a.id === "claude");
      assert.equal(claudeEntry.detected.installed, true);

      const gateOnRes = await fetch(`${base}/api/admin/execution-gate`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ enabled: true, confirm: true })
      });
      assert.equal(gateOnRes.status, 200);

      // Cursor rejects allowEdits:true before ever spawning anything.
      const cursorRes = await fetch(`${base}/api/agents/cursor/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "hello", confirm: true, options: { allowEdits: true } })
      });
      assert.equal(cursorRes.status, 400);
      assert.equal((await cursorRes.json()).error, "allow_edits_not_supported");

      // Codex without allowEdits -> read-only sandbox. commandPreview is
      // built directly from the same plan.args the fake CLI is spawned
      // with (see buildCommandPreview in run-manager.js), so it's a
      // faithful record of what the fake actually saw on its argv.
      const codexRes = await fetch(`${base}/api/agents/codex/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "hello from codex readonly", confirm: true })
      });
      assert.equal(codexRes.status, 200);
      const codexBody = await codexRes.json();
      assert.match(codexBody.commandPreview, /--sandbox read-only/);
      await waitForRunTerminal(base, authed, codexBody.id);

      // Codex with allowEdits:true -> workspace-write sandbox.
      const codexEditRes = await fetch(`${base}/api/agents/codex/runs`, {
        method: "POST",
        headers: authedJson,
        body: JSON.stringify({ prompt: "hello from codex edits", confirm: true, options: { allowEdits: true } })
      });
      assert.equal(codexEditRes.status, 200);
      const codexEditBody = await codexEditRes.json();
      assert.match(codexEditBody.commandPreview, /--sandbox workspace-write/);
      await waitForRunTerminal(base, authed, codexEditBody.id);
    } finally {
      await killChild(child);
      await rm(homeDir, { recursive: true, force: true });
    }
  }
);
