// writeJson (server/runtime/store.js) writes a temp file and renames it over the target. On Windows the rename fails
// for a moment while another process has the target open (a reader, an antivirus scan), so there it is tried again for
// about a second; elsewhere those codes mean a real permission problem and the write fails at once. A write that fails
// leaves no temp file behind. CI on windows-latest lost session markers this way before the retry.
// fs.promises.rename is replaced for a test with one that fails first with the given codes, and process.platform is set
// for the Windows cases, so this runs the same on every machine.
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../server/runtime/store.js";

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "agent-os-write-json-"));
}

async function asPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// Each call to rename takes the next code from `codes` and fails with it; once they run out, the real rename runs.
function failingRename(codes) {
  const real = fsp.rename;
  const left = [...codes];
  let calls = 0;
  fsp.rename = async (...args) => {
    calls += 1;
    const code = left.shift();
    if (code) throw Object.assign(new Error(`rename failed: ${code}`), { code });
    return real(...args);
  };
  return {
    calls: () => calls,
    restore: () => {
      fsp.rename = real;
    }
  };
}

async function leftovers(dir) {
  return (await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

test("writeJson on Windows: a rename refused with EPERM, EBUSY or EACCES is tried again, and the write lands", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "meta.json");
  await fsp.writeFile(file, "{\"old\":true}\n");
  const rename = failingRename(["EPERM", "EBUSY", "EACCES"]);
  try {
    await asPlatform("win32", () => writeJson(file, { markers: [{ type: "prompt", at: "2026-10-31T05:16:29.000Z" }] }));
    assert.equal(rename.calls(), 4, "three refusals, then the rename that worked");
  } finally {
    rename.restore();
  }
  assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { markers: [{ type: "prompt", at: "2026-10-31T05:16:29.000Z" }] });
  assert.deepEqual(await leftovers(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("writeJson on Windows: a rename that keeps being refused fails after about a second, keeps the old file and leaves no temp file", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "meta.json");
  await fsp.writeFile(file, "{\"old\":true}\n");
  const rename = failingRename(Array(20).fill("EACCES"));
  const started = Date.now();
  try {
    await assert.rejects(asPlatform("win32", () => writeJson(file, { old: false })), { code: "EACCES" });
    assert.equal(rename.calls(), 11, "the first try and ten more");
  } finally {
    rename.restore();
  }
  assert.ok(Date.now() - started < 3000, "it gives up within a few seconds");
  assert.equal(await fsp.readFile(file, "utf8"), "{\"old\":true}\n");
  assert.deepEqual(await leftovers(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("writeJson: on macOS and Linux an EPERM rename fails at once, and any other error is never retried", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "meta.json");
  for (const [platform, code] of [["darwin", "EPERM"], ["linux", "EBUSY"], ["win32", "ENOENT"]]) {
    const rename = failingRename([code, code]);
    try {
      await assert.rejects(asPlatform(platform, () => writeJson(file, { platform })), { code }, `${platform} ${code}`);
      assert.equal(rename.calls(), 1, `${platform} ${code}: no second try`);
    } finally {
      rename.restore();
    }
    assert.deepEqual(await leftovers(dir), [], `${platform} ${code}: no temp file left`);
  }
  await fsp.rm(dir, { recursive: true, force: true });
});
