// Review M10: the files these writers create are private (0600) even if the folder around them is not. The store's root
// is 0700 in a normal install, so this only matters when the root could not be made private; the files must not depend on it.
// umask 0 here (this test file runs in its own process) so a missing mode shows as 0666 instead of being hidden by the 022.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendRunEventLine, runsDir } from "../server/runtime/runs/run-store.js";
import { appendEvent, appendNotebook, roomDir } from "../server/runtime/team-room/room-store.js";
import { writeFileNoFollow } from "../server/runtime/workspace.js";

const skip = process.platform === "win32" ? "file modes do not apply on Windows" : false;
const modeOf = async (file) => (await stat(file)).mode & 0o777;

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-modes-"));
  const before = { AGENT_OS_HOME: process.env.AGENT_OS_HOME, umask: process.umask(0) };
  process.env.AGENT_OS_HOME = home;
  try {
    await fn(home);
  } finally {
    process.umask(before.umask);
    if (before.AGENT_OS_HOME === undefined) delete process.env.AGENT_OS_HOME;
    else process.env.AGENT_OS_HOME = before.AGENT_OS_HOME;
    await rm(home, { recursive: true, force: true });
  }
}

test("a run's event log is created 0600", { skip }, async () => {
  await withHome(async () => {
    const dir = await runsDir();
    await appendRunEventLine(dir, "run-1", '{"seq":0}\n');
    assert.equal(await modeOf(path.join(dir, "run-1.jsonl")), 0o600);
  });
});

test("a Team Room's notebook and transcript are created 0600", { skip }, async () => {
  await withHome(async () => {
    const roomId = "room-20261107-120000-abcd";
    await mkdir(roomDir(roomId), { recursive: true });
    await appendNotebook(roomId, "a note");
    await appendEvent(roomId, { type: "note" });
    assert.equal(await modeOf(path.join(roomDir(roomId), "notebook.md")), 0o600);
    assert.equal(await modeOf(path.join(roomDir(roomId), "events.jsonl")), 0o600);
  });
});

test("a workspace note written by Agent OS is created 0600 (it lives inside the private Agent OS folder)", { skip }, async () => {
  await withHome(async (home) => {
    const file = path.join(home, "note.md");
    await writeFileNoFollow(file, "hello");
    assert.equal(await modeOf(file), 0o600);
  });
});

// Review S-M5: agent programs Agent OS starts only to read from or set up run in a private, empty folder of its own,
// `<AGENT_OS_HOME>/cli-cwd` (0700), never in the shared temp folder.
import { readdir } from "node:fs/promises";
import { cliCwd } from "../server/runtime/cli-cwd.js";
import hermes from "../server/runtime/agents/hermes.js";
import openclaw from "../server/runtime/agents/openclaw.js";

test("cliCwd(): a private empty folder inside the Agent OS folder, made again when it is missing", { skip }, async () => {
  await withHome(async (home) => {
    const dir = cliCwd();
    assert.equal(dir, path.join(home, "cli-cwd"));
    assert.equal(await modeOf(dir), 0o700);
    assert.deepEqual(await readdir(dir), []);
    assert.notEqual(path.resolve(dir), path.resolve(os.tmpdir()));
    await rm(dir, { recursive: true });
    assert.equal(cliCwd(), dir, "made again");
    assert.equal(await modeOf(dir), 0o700);
  });
});

test("the Hermes and OpenClaw service plans run in cliCwd(), not the shared temp folder", { skip }, async () => {
  await withHome(async () => {
    const detected = { installed: true, path: "/bin/true" };
    for (const plan of [hermes.service.start(detected), hermes.service.stop(detected), hermes.service.restart(detected), openclaw.service.start(detected)]) {
      assert.equal(plan.cwd, cliCwd());
      assert.notEqual(path.resolve(plan.cwd), path.resolve(os.tmpdir()));
    }
  });
});
