#!/usr/bin/env node
/**
 * Live-lane smoke — no Docker, no real provider keys.
 * Spawns Agent OS with DEMO_PUBLIC=0 and AGENT_OS_LIVE_CHAT=1.
 *
 *   npm run smoke:live
 *   BASE_URL=http://127.0.0.1:8090 npm run smoke:live
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = String(process.env.SMOKE_PORT || "18191");
const external = process.env.BASE_URL ? String(process.env.BASE_URL).replace(/\/$/, "") : "";

async function get(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

async function post(base, pathname, body) {
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
  return { status: response.status, json, text };
}

async function waitForHealth(base, child) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child && child.exitCode != null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const health = await get(base, "/api/health");
      if (health.status === 200 && health.json?.ok) return health;
    } catch {
      // retry until the listener is up
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("timed out waiting for /api/health");
}

async function assertLive(base) {
  const health = await get(base, "/api/health");
  assert.equal(health.status, 200, health.text);
  assert.equal(health.json?.demoPublic, false);
  assert.equal(health.json?.liveChat, true);

  const status = await get(base, "/api/live/status");
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json?.demoPublic, false);
  assert.equal(status.json?.liveChat, true);
  assert.equal(status.json?.omniroute?.apiKey, undefined);
  assert.equal(Object.hasOwn(status.json?.omniroute || {}, "apiKey"), false);

  const dry = await post(base, "/api/live/chat", {
    agentId: "hermes",
    dryRun: true,
    message: "Plan a live-lane smoke check."
  });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json?.mode, "dry_run");
  assert.match(String(dry.json?.reply || ""), /Dry-run plan/i);

  const live = await post(base, "/api/live/chat", {
    agentId: "hermes",
    dryRun: false,
    message: "Reply with a live transport, not a demo script."
  });
  assert.equal(live.status, 200, live.text);
  assert.notEqual(live.json?.mode, "demo");
  assert.doesNotMatch(String(live.json?.reply || ""), /Demo plan/);
  assert.ok(["unavailable", "executed", "error", "blocked"].includes(live.json?.mode), live.json?.mode);

  const mission = await post(base, "/api/live/mission", {
    dryRun: true,
    message: "Write a dry-run mission note for smoke."
  });
  assert.equal(mission.status, 200, mission.text);
  assert.equal(mission.json?.workspaceFile?.relativePath, "missions/latest.md");

  console.log(`live-smoke ok · ${base}`);
  console.log(`hermes live mode: ${live.json?.mode} transport: ${live.json?.transport}`);
}

async function main() {
  if (external) {
    await assertLive(external);
    return;
  }

  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-live-smoke-"));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: port,
      HOST: "127.0.0.1",
      DEMO_PUBLIC: "0",
      HERMES_AGENT_OS_DEMO_PUBLIC: "0",
      AGENT_OS_LIVE_CHAT: "1",
      HERMES_AGENT_OS_ENABLE_EXEC: "0",
      HERMES_AGENT_OS_ENABLE_INSTALL: "0",
      HERMES_AGENT_OS_PUBLIC_MODE: "0",
      HERMES_AGENT_OS_REQUIRE_AUTH: "0",
      HERMES_AGENT_OS_HOME: home,
      AGENT_OS_HOME: home,
      OMNIROUTE_BASE_URL: "",
      OMNIROUTE_API_KEY: "",
      OPENCLAW_GATEWAY_URL: "",
      OPENCLAW_GATEWAY_TOKEN: ""
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
    await assertLive(base);
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
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
