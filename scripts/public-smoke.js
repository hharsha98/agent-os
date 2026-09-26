#!/usr/bin/env node
/**
 * Public demo smoke — no Docker.
 * Spawns Agent OS with DEMO_PUBLIC=1 unless BASE_URL is already a demo server.
 *
 *   npm run build
 *   npm run smoke:public
 *   BASE_URL=https://agentos.example npm run smoke:public
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = String(process.env.SMOKE_PORT || "18190");
const external = process.env.BASE_URL ? String(process.env.BASE_URL).replace(/\/$/, "") : "";

function client(base) {
  async function get(pathname) {
    const response = await fetch(`${base}${pathname}`);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  }

  async function post(pathname, body) {
    const response = await fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  }

  return { get, post };
}

async function waitForHealth(base, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // Process still booting.
    }
    if (child && child.exitCode != null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`public demo server did not become healthy at ${base}`);
}

async function assertDemo(base, { expectBind } = {}) {
  const { get, post } = client(base);
  const marker = `public-demo-smoke-${Date.now()}`;

  const health = await get("/api/health");
  assert.equal(health.status, 200, `health ${health.status}`);
  assert.equal(health.json?.ok, true);
  assert.equal(health.json?.demoPublic, true);
  assert.equal(health.json?.badge, "Public demo · sandboxed");
  if (expectBind) {
    assert.equal(health.json?.bind, expectBind);
  } else {
    assert.match(String(health.json?.bind || ""), /^[A-Za-z0-9_.:%-]+$/, "health bind");
  }
  assert.ok(health.json?.port);

  const ui = await get("/");
  assert.equal(ui.status, 200, `ui ${ui.status}`);
  const scripts = [...ui.text.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0, "built UI script missing — run npm run build");
  let bundleHasBadge = ui.text.includes("Public demo · sandboxed");
  for (const src of scripts) {
    const asset = await get(src.startsWith("http") ? src : src);
    if (asset.text.includes("Public demo · sandboxed")) bundleHasBadge = true;
  }
  assert.equal(bundleHasBadge, true, "built UI does not contain the public demo badge");

  const product = await get("/api/product/status");
  assert.equal(product.status, 200);
  assert.equal(product.json?.demoPublic, true);
  assert.equal(product.json?.edition, "public-demo");
  assert.equal(product.json?.hosted, false);
  assert.equal(product.json?.badge, "Public demo · sandboxed");
  assert.match(product.json?.publicSummary || "", /not connected/i);

  const agents = await get("/api/local-agents");
  assert.equal(agents.status, 200);
  assert.ok(agents.json?.agents?.length >= 4);
  for (const agent of agents.json.agents) {
    assert.equal(agent.simulated, true, agent.id);
    assert.equal(agent.realSession, false, agent.id);
    assert.equal(agent.status, "demo", agent.id);
    assert.equal(agent.chat?.mode, "demo", agent.id);
    assert.equal(agent.chat?.label, "Demo", agent.id);
    assert.match(agent.summary || "", /not connected/i);
    assert.doesNotMatch(JSON.stringify(agent), /is connected/i);
  }

  const chat = await post("/api/demo/chat", { agentId: "claude", message: marker });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json?.executedOnHost, false);
  assert.equal(chat.json?.badge, "Public demo · sandboxed");
  assert.match(chat.json?.reply || "", /### Steps/);
  assert.match(chat.json?.reply || "", /1\. /);
  assert.match(chat.json?.reply || "", /not connected/i);
  assert.match(chat.json?.reply || "", new RegExp(marker));

  const timeline = await post("/api/demo/timeline", { message: marker });
  assert.equal(timeline.status, 200, timeline.text);
  assert.equal(timeline.json?.executedOnHost, false);
  assert.ok(timeline.json?.steps?.length >= 4);
  assert.match(timeline.json?.workspaceFile?.id || "", /^workspace\/demo\//);
  const timelineFile = await get(`/api/workspace/file?id=${encodeURIComponent(timeline.json.workspaceFile.id)}`);
  assert.equal(timelineFile.status, 200);
  assert.match(timelineFile.json?.previewText || "", new RegExp(marker));

  const workspace = await get("/api/workspace");
  assert.equal(workspace.status, 200);
  const ids = (workspace.json?.files || []).map((file) => file.id);
  assert.ok(ids.includes("workspace/demo/briefing.md"));
  assert.ok(ids.includes("workspace/notes/start-here.md"));

  const note = await post("/api/workspace/files", {
    folder: "notes",
    name: "smoke-note.md",
    content: `# Smoke note\n\n${marker}\n`
  });
  assert.equal(note.status, 201, note.text);
  assert.match(note.json?.file?.id || "", /^workspace\/notes\/smoke-note\.md$/);

  const machine = await post("/api/demo/machine/preview", { scenario: "health-check" });
  assert.equal(machine.status, 200, machine.text);
  assert.equal(machine.json?.executedOnHost, false);
  assert.match(machine.json?.transcript || "", /not executed/i);

  const refused = await post("/api/demo/machine/preview", { command: "rm -rf /" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json?.executedOnHost, false);
  assert.doesNotMatch(refused.text, /rm -rf/);

  const builder = await get("/api/demo/builder");
  assert.equal(builder.status, 200, builder.text);
  assert.equal(builder.json?.convexRequired, false);
  assert.ok(builder.json?.workflow?.nodes?.length >= 4);
  assert.ok(builder.json.workflow.nodes.some((node) => node.type === "user_approval"));

  const canvas = await post("/api/demo/builder/run", { message: marker });
  assert.equal(canvas.status, 200, canvas.text);
  assert.equal(canvas.json?.executedOnHost, false);
  assert.ok(canvas.json?.nodeRuns?.some((step) => step.type === "user_approval"));

  const gate = await post("/api/admin/execution-gate", { enabled: true, reason: "smoke must not unlock shell", confirm: true });
  assert.equal(gate.status, 200, gate.text);
  assert.equal(gate.json?.enabled, false);
  assert.equal(gate.json?.demoLocked, true);

  const install = await post("/api/modules/claude/install", { execute: true });
  assert.equal(install.status, 200, install.text);
  assert.equal(install.json?.mode, "dry_run");
  assert.notEqual(install.json?.mode, "executed");

  const liveAttempt = await post("/api/modules/claude/run", { dryRun: false, message: marker });
  assert.equal(liveAttempt.status, 200, liveAttempt.text);
  assert.equal(liveAttempt.json?.mode, "dry_run");

  const voice = await get("/api/voice/status");
  assert.equal(voice.status, 200);
  assert.equal(voice.json?.tools?.executionGate, false);
  assert.equal(voice.json?.tools?.shellGate, false);

  console.log(`public-smoke ok · ${base}`);
  console.log("walkthrough: Mission Control → Chat timeline → Workspace note → gated machine preview → demo canvas");
}

async function main() {
  if (external) {
    await assertDemo(external);
    return;
  }

  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-public-smoke-"));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: port,
      HOST: "0.0.0.0",
      DEMO_PUBLIC: "1",
      HERMES_AGENT_OS_DEMO_PUBLIC: "1",
      HERMES_AGENT_OS_ENABLE_EXEC: "1",
      HERMES_AGENT_OS_ENABLE_INSTALL: "1",
      HERMES_VOICE_ALLOW_SHELL: "1",
      HERMES_AGENT_OS_PUBLIC_MODE: "0",
      HERMES_AGENT_OS_REQUIRE_AUTH: "0",
      HERMES_AGENT_OS_HOME: home,
      AGENT_OS_HOME: home,
      HERMES_HOME: path.join(home, "hermes-profile")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base, child);
    await assertDemo(base, { expectBind: "0.0.0.0" });
  } catch (error) {
    console.error(logs.slice(-4000));
    throw error;
  } finally {
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
    await rm(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("public-smoke failed");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
