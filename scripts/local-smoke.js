#!/usr/bin/env node
/**
 * Local v1 smoke — hiring-manager path in under a minute after `npm start`.
 * Usage: node scripts/local-smoke.js
 * Optional: BASE_URL=http://127.0.0.1:8090 node scripts/local-smoke.js
 */
import assert from "node:assert/strict";

const base = String(process.env.BASE_URL || "http://127.0.0.1:8090").replace(/\/$/, "");

async function get(path) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  return { ok: response.ok, status: response.status, json };
}

async function main() {
  const health = await get("/api/health");
  assert.equal(health.status, 200, `health ${health.status}`);
  assert.equal(health.json?.ok, true);

  const ui = await get("/");
  assert.equal(ui.status, 200, `ui ${ui.status}`);
  assert.match(ui.text, /Agent OS/i);

  const product = await get("/api/product/status");
  assert.equal(product.status, 200);
  assert.equal(product.json?.hosted, false);
  assert.equal(product.json?.edition, "local-v1");
  assert.ok(Array.isArray(product.json?.firstRun));

  const agents = await get("/api/local-agents");
  assert.equal(agents.status, 200);
  assert.ok(Array.isArray(agents.json?.agents));
  assert.ok(agents.json.agents.length >= 4);

  const dryRun = await post("/api/modules/claude/run", {
    dryRun: true,
    message: "Plan a README section on local v1 smoke."
  });
  assert.equal(dryRun.status, 200);
  assert.equal(dryRun.json?.mode, "dry_run");
  assert.match(String(dryRun.json?.reply || ""), /Dry-run plan/i);
  assert.match(String(dryRun.json?.reply || ""), /dryRun:false/);

  const hermes = await post("/api/modules/hermes/run", {
    dryRun: true,
    message: "Draft a local research plan that does not call tools yet."
  });
  assert.equal(hermes.status, 200);
  assert.match(String(hermes.json?.reply || ""), /Dry-run plan/i);

  const workspace = await get("/api/workspace");
  assert.equal(workspace.status, 200);
  assert.equal(workspace.json?.ok, true);

  const gate = await get("/api/execution-gate");
  assert.equal(gate.status, 200);
  assert.equal(gate.json?.enabled, false);

  console.log(`local-smoke ok · ${base}`);
  console.log("paths: / → Mission Control · Unified Chat dry-run · Workspace · Machine Control");
}

main().catch((error) => {
  console.error(`local-smoke failed against ${base}`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
