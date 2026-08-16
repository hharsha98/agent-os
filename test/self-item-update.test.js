import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSelfModuleItem } from "../server/runtime/self-modules.js";
import { updateSelfModuleItem } from "../server/runtime/self-item-update.js";

async function withTempRuntime(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-self-item-"));
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

test("kanban cards can move columns without changing id", async () => {
  await withTempRuntime(async () => {
    const created = await createSelfModuleItem("kanban", {
      title: "Review dry-run",
      column: "todo",
      status: "open"
    });
    const card = created.items[0];
    assert.equal(card.column, "todo");
    const moved = await updateSelfModuleItem("kanban", card.id, { column: "doing", status: "open" });
    const next = moved.items.find((item) => item.id === card.id);
    assert.ok(next);
    assert.equal(next.column, "doing");
    assert.equal(next.id, card.id);
    assert.equal(next.createdAt, card.createdAt);
  });
});

test("unknown self-module item returns 404 statusCode", async () => {
  await withTempRuntime(async () => {
    await createSelfModuleItem("goals", { title: "Keep exec off", status: "open" });
    await assert.rejects(
      () => updateSelfModuleItem("goals", "missing-id", { status: "done" }),
      (error) => error.statusCode === 404
    );
  });
});
