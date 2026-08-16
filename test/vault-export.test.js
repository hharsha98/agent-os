import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addMemory } from "../server/runtime/memory.js";
import { exportVaultMarkdown } from "../server/runtime/vault-export.js";

async function withTempRuntime(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-vault-"));
  const previous = process.env.HERMES_AGENT_OS_HOME;
  process.env.HERMES_AGENT_OS_HOME = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HERMES_AGENT_OS_HOME;
    else process.env.HERMES_AGENT_OS_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("vault export writes PARA markdown without claiming Obsidian is connected", async () => {
  await withTempRuntime(async (root) => {
    await addMemory({
      title: "Loop briefing 2026-08-16",
      content: "Keep exec off unless the gate is on.",
      source: "loop-desk",
      tags: ["loop", "briefing"],
      type: "episodic",
      privacy: "private",
      agentId: "loop"
    });
    await addMemory({
      title: "Capture inbox note",
      content: "Pasted transcript only.",
      source: "capture",
      tags: ["capture"],
      type: "episodic",
      privacy: "private",
      agentId: "journal"
    });
    const result = await exportVaultMarkdown();
    assert.equal(result.ok, true);
    assert.equal(result.folder, "vault");
    assert.match(result.publicSummary, /Obsidian is not connected/);
    const briefing = path.join(root, "workspace", "vault", "inbox", "latest-briefing.md");
    const capture = await fs.readdir(path.join(root, "workspace", "vault", "inbox"));
    const areas = await fs.readdir(path.join(root, "workspace", "vault", "areas"));
    assert.equal(await fs.access(briefing).then(() => true), true);
    assert.ok(capture.some((name) => name.includes("capture") || name.includes("latest-briefing")));
    assert.ok(areas.length >= 1 || capture.length >= 1);
    assert.ok(result.count >= 2);
  });
});
