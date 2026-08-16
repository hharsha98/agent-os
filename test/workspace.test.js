import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listWorkspaceFiles, resolveWorkspaceFile, writeWorkspaceText } from "../server/runtime/workspace.js";

async function withTempRuntime(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-workspace-"));
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

test("workspace listing starts empty and stays inside sandbox folders", async () => {
  await withTempRuntime(async () => {
    const listing = await listWorkspaceFiles();
    const workspaceRoot = listing.roots.find((item) => item.id === "workspace");
    assert.equal(listing.files.length, 0);
    assert.equal(listing.empty, true);
    assert.ok(workspaceRoot);
    assert.match(workspaceRoot.publicPath, /workspace$/);
  });
});

test("workspace listing includes a file written to the sandbox", async () => {
  await withTempRuntime(async (root) => {
    const filePath = path.join(root, "workspace", "hello.txt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "hello");
    const listing = await listWorkspaceFiles();
    assert.equal(listing.files.length, 1);
    assert.equal(listing.files[0].name, "hello.txt");
    assert.equal(listing.files[0].id, "workspace/hello.txt");
    assert.ok(!listing.files[0].publicPath.includes(os.homedir()));
  });
});

test("workspace file ids reject path travel", async () => {
  await withTempRuntime(async () => {
    await assert.rejects(() => resolveWorkspaceFile("../etc/passwd"), /file must be inside workspace or exports|file path is not allowed|outside/i);
    await assert.rejects(() => resolveWorkspaceFile("workspace/../../etc/passwd"), /file must be inside workspace or exports|file path is not allowed|outside/i);
  });
});

test("workspace write saves markdown inside the sandbox and rejects path travel", async () => {
  await withTempRuntime(async () => {
    const saved = await writeWorkspaceText({
      folder: "loop",
      name: "2026-08-16.md",
      content: "# morning briefing\n"
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.file.id, "workspace/loop/2026-08-16.md");
    assert.match(saved.previewText, /morning briefing/);
    const listing = await listWorkspaceFiles({ query: "2026-08-16" });
    assert.equal(listing.files[0].id, "workspace/loop/2026-08-16.md");
    await assert.rejects(
      () => writeWorkspaceText({ relativePath: "../secret.md", content: "nope" }),
      /not allowed|outside|inside/i
    );
    await assert.rejects(
      () => writeWorkspaceText({ name: "run.sh", content: "echo hi" }),
      /only \.md/i
    );
  });
});
