import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addMemory } from "../server/runtime/memory.js";
import { getMemoryContext } from "../server/runtime/memory-context.js";

async function withTempRuntime(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-memory-context-"));
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

test("memory context includes the latest briefing and matching notes", async () => {
  await withTempRuntime(async () => {
    await addMemory({
      title: "Loop briefing 2026-08-16",
      content: "Open goal: keep exec off. Next action: review dry-run.",
      source: "loop-desk",
      tags: ["loop", "briefing"],
      type: "episodic",
      privacy: "private",
      agentId: "loop"
    });
    await addMemory({
      title: "Claude loop 2026-08-16",
      content: "You: What should I ship?\n\nDry run: save a briefing first.",
      source: "chat-loop",
      tags: ["loop", "claude"],
      type: "episodic",
      privacy: "private",
      agentId: "claude"
    });
    const empty = await getMemoryContext({ query: "", limit: 6 });
    assert.equal(empty.briefing.title, "Loop briefing 2026-08-16");
    assert.match(empty.promptBlock, /Local Agent OS memory/);
    const searched = await getMemoryContext({ query: "exec off", limit: 6 });
    assert.ok(searched.hits.some((item) => item.reason === "search" || item.reason === "latest-briefing"));
    assert.match(searched.promptBlock, /exec off/i);
  });
});
