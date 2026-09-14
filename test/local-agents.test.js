import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyEnvValues, loadLocalEnv, parseEnvFile } from "../server/runtime/env.js";
import { RUNTIME_VERSION } from "../server/runtime/store.js";
import {
  buildAgentRecord,
  classifyChat,
  classifyStatus,
  getLocalAgentDashboardStatus,
  summarizeAgents
} from "../server/runtime/local-agents.js";

test("runtime version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(RUNTIME_VERSION, pkg.version);
  assert.equal(pkg.version, "0.3.0");
});

test("parseEnvFile ignores comments and does not require export", () => {
  const parsed = parseEnvFile(`
# comment
PORT=8090
export HERMES_AGENT_OS_ENABLE_EXEC=0
OPENAI_API_KEY="sk-test"
EMPTY=
`);
  assert.equal(parsed.PORT, "8090");
  assert.equal(parsed.HERMES_AGENT_OS_ENABLE_EXEC, "0");
  assert.equal(parsed.OPENAI_API_KEY, "sk-test");
  assert.equal(parsed.EMPTY, "");
});

test("OpenClaw CLI is not counted as Unified Chat ready", () => {
  const chat = classifyChat({ id: "openclaw", cliFound: true });
  assert.equal(chat.mode, "not_in_unified_chat");
  assert.equal(chat.routed, false);
  assert.equal(classifyStatus({ chat, cliFound: true }), "cli_present");
});

test("loadLocalEnv does not override empty existing env values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-env-"));
  try {
    await writeFile(path.join(dir, ".env"), "PORT=8090\nHERMES_AGENT_OS_ENABLE_EXEC=1\n");
    const env = { HERMES_AGENT_OS_ENABLE_EXEC: "0" };
    const result = loadLocalEnv({ root: dir, env });
    assert.equal(result.loaded, true);
    assert.equal(env.PORT, "8090");
    assert.equal(env.HERMES_AGENT_OS_ENABLE_EXEC, "0");
    assert.ok(result.skipped.includes("HERMES_AGENT_OS_ENABLE_EXEC"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyEnvValues does not fill empty existing keys", () => {
  const env = { HERMES_AGENT_OS_ENABLE_EXEC: "" };
  applyEnvValues({ HERMES_AGENT_OS_ENABLE_EXEC: "1", PORT: "8090" }, { env });
  assert.equal(env.HERMES_AGENT_OS_ENABLE_EXEC, "");
  assert.equal(env.PORT, "8090");
});

test("applyEnvValues can override when asked", () => {
  const env = { PORT: "4173" };
  applyEnvValues({ PORT: "8090" }, { env, override: true });
  assert.equal(env.PORT, "8090");
});

test("Cursor CLI on PATH is cli_present, never connected for dashboard chat", () => {
  const chat = classifyChat({ id: "cursor", cliFound: true });
  assert.equal(chat.mode, "not_wired");
  assert.equal(chat.routed, false);
  assert.equal(classifyStatus({ chat, cliFound: true }), "cli_present");
  const agent = buildAgentRecord({
    id: "cursor",
    name: "Cursor Agent",
    eyebrow: "IDE",
    cli: { found: true, command: "/Users/demo/.local/bin/agent", version: "agent 1.2.3" },
    chat
  });
  assert.equal(agent.status, "cli_present");
  assert.equal(agent.cli.command, "agent");
  assert.equal(agent.available, true);
  assert.match(agent.summary, /does not send Unified Chat/i);
  assert.doesNotMatch(JSON.stringify(agent), /OAuth was verified/);
  assert.doesNotMatch(agent.connection, /\/Users\//);
});

test("Claude without CLI stays not installed and is not marked connected", () => {
  const chat = classifyChat({ id: "claude", cliFound: false });
  assert.equal(chat.mode, "unavailable");
  assert.equal(classifyStatus({ chat, cliFound: false }), "not_installed");
});

test("Codex with a saved API key is preview, not a live connected agent", () => {
  const chat = classifyChat({ id: "codex", cliFound: false, codexApiConfigured: true });
  assert.equal(chat.mode, "preview");
  assert.equal(classifyStatus({ chat, cliFound: false, codexApiConfigured: true }), "preview");
});

test("getLocalAgentDashboardStatus uses injected probes and stays honest", async () => {
  const payload = await getLocalAgentDashboardStatus({
    probe: async (names) => {
      const command = names[0];
      if (command === "claude" || command === "hermes" || command === "openclaw") {
        return { found: true, command, version: `${command} 0.0.1` };
      }
      return { found: false, command, version: null };
    },
    codexApi: { configured: false, model: "gpt-5.3-codex" },
    executionGate: {
      enabled: false,
      source: "disabled",
      dryRunDefault: true,
      publicSummary: "Trusted live execution is disabled."
    },
    gateway: { ok: false, optional: true, url: "http://127.0.0.1:3001", summary: "Optional gateway is not running." }
  });

  assert.equal(payload.hosted, false);
  assert.equal(payload.edition, "local-v1");
  assert.equal(payload.executionGate.enabled, false);
  assert.equal(payload.summary.cliFound, 3);
  assert.equal(payload.summary.chatDryRun, 2);
  assert.equal(payload.summary.connected, 0);
  assert.equal(payload.summary.dashboardChatReady, 2);

  const cursor = payload.agents.find((agent) => agent.id === "cursor");
  const claude = payload.agents.find((agent) => agent.id === "claude");
  const openclaw = payload.agents.find((agent) => agent.id === "openclaw");
  assert.equal(cursor.status, "not_installed");
  assert.equal(claude.status, "dry_run");
  assert.equal(claude.chat.label, "Dry run");
  assert.ok(openclaw);
  assert.equal(openclaw.status, "cli_present");
  assert.equal(openclaw.chat.routed, false);
  assert.doesNotMatch(JSON.stringify(payload), /OAuth was verified from Hermes/);
  assert.doesNotMatch(JSON.stringify(payload), /4\/4/);

  const summary = summarizeAgents(payload.agents, payload.executionGate, payload.summary.gateway);
  assert.equal(summary.dashboardChatReady, 2);
  assert.equal(summary.dryRunDefault, true);
});
