// Sessions, files on disk (spec Security 5): Agent OS's own folder, sessions/
// and worktrees/ are private (0700), also when they already existed with the
// default mode. Temp AGENT_OS_HOME only; nothing here starts anything.
import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensurePrivateDir, ensureRuntimeStore, runtimePaths } from "../server/runtime/store.js";

const isWindows = process.platform === "win32";
const modeSkip = { skip: isWindows ? "Windows has no POSIX file modes" : false };

async function withRuntimeHome(fn) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-os-store-"));
  const root = path.join(base, "agent-os-home");
  const previous = { AGENT_OS_HOME: process.env.AGENT_OS_HOME, HERMES_AGENT_OS_HOME: process.env.HERMES_AGENT_OS_HOME };
  process.env.AGENT_OS_HOME = root;
  delete process.env.HERMES_AGENT_OS_HOME;
  try {
    return await fn({ base, root });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
}

const modeOf = async (dir) => (await stat(dir)).mode & 0o777;

test("runtimePaths names the sessions and worktrees folders", async () => {
  await withRuntimeHome(async ({ root }) => {
    const paths = runtimePaths();
    assert.equal(paths.sessions, path.join(root, "sessions"));
    assert.equal(paths.worktrees, path.join(root, "worktrees"));
  });
});

test("ensureRuntimeStore makes Agent OS's folder, sessions/ and worktrees/ private (0700), new or already there", modeSkip, async () => {
  await withRuntimeHome(async ({ root }) => {
    // An older install: the root and sessions/ exist with the default mode.
    await mkdir(path.join(root, "sessions"), { recursive: true });
    await chmod(root, 0o755);
    await chmod(path.join(root, "sessions"), 0o755);

    const paths = await ensureRuntimeStore();
    assert.equal(await modeOf(paths.root), 0o700);
    assert.equal(await modeOf(paths.sessions), 0o700);
    assert.equal(await modeOf(paths.worktrees), 0o700);
    for (const name of ["config", "workflows", "runs", "logs", "memory", "exports", "workspace"]) {
      assert.ok((await stat(paths[name])).isDirectory(), `${name} still exists`);
    }
  });
});

test("ensureRuntimeStore carries on when the root, sessions/ or worktrees/ can't be made private (another account owns it), warning once per folder and never throwing", modeSkip, async (t) => {
  await withRuntimeHome(async ({ root }) => {
    // The chmod of one folder fails as it does for a folder another account
    // owns; every other chmod is the real one.
    const realChmod = fsPromises.chmod;
    let failOn = path.resolve(root);
    let failCode = "EPERM";
    t.mock.method(fsPromises, "chmod", async (target, mode) => {
      if (path.resolve(String(target)) === failOn) {
        throw Object.assign(new Error(`${failCode}: operation not permitted, chmod '${target}'`), { code: failCode });
      }
      return realChmod(target, mode);
    });
    const warn = t.mock.method(console, "warn", () => {});
    const warned = () => warn.mock.calls.map((call) => call.arguments[0]);
    const message = (dir) => `Agent OS could not make its folder private (0700): ${dir}`;

    // The root.
    const paths = await ensureRuntimeStore();
    await ensureRuntimeStore();
    assert.deepEqual(warned(), [message(root)], "warned once, not on every call");
    assert.equal(await modeOf(paths.sessions), 0o700);
    assert.equal(await modeOf(paths.worktrees), 0o700);
    for (const dir of Object.values(paths)) assert.ok((await stat(dir)).isDirectory(), dir);

    failCode = "EACCES";
    await ensureRuntimeStore();
    assert.deepEqual(warned(), [message(root)], "EACCES on the root is tolerated the same way");

    // Fix round 1: sessions/ and worktrees/ are forgiven too, with the same
    // warning (once per folder). ensureRuntimeStore() is shared by runs,
    // workflows and config writes, which must not fail over a sessions folder.
    for (const folder of [paths.sessions, paths.worktrees]) {
      await realChmod(folder, 0o755); // a folder that can't be tightened stays as it was
      failOn = path.resolve(folder);
      for (const code of ["EPERM", "EACCES"]) {
        failCode = code;
        const again = await ensureRuntimeStore();
        await ensureRuntimeStore();
        assert.deepEqual(again, paths, `${code} on ${path.basename(folder)}: the store is still made`);
      }
      assert.equal(await modeOf(folder), 0o755, `${path.basename(folder)}: the refused chmod changed nothing`);
      assert.equal(warned().filter((text) => text === message(folder)).length, 1, `${path.basename(folder)}: warned once`);
      await realChmod(folder, 0o700);
    }
    assert.deepEqual(warned(), [message(root), message(paths.sessions), message(paths.worktrees)]);

    // Any other failure still stops the store, on every one of the three.
    failCode = "EIO";
    for (const folder of [root, paths.sessions, paths.worktrees]) {
      failOn = path.resolve(folder);
      await assert.rejects(ensureRuntimeStore(), { code: "EIO" }, folder);
    }
    assert.equal(warned().length, 3, "no warning for an error that is not tolerated");
  });
});

test("ensureRuntimeStore makes every folder on Windows too", async () => {
  await withRuntimeHome(async () => {
    const paths = await ensureRuntimeStore();
    for (const dir of Object.values(paths)) assert.ok((await stat(dir)).isDirectory(), dir);
  });
});

test("ensurePrivateDir makes nested folders 0700 and tightens one that already exists", modeSkip, async () => {
  await withRuntimeHome(async ({ base }) => {
    const fresh = path.join(base, "a", "b", "c");
    assert.equal(await ensurePrivateDir(fresh), fresh);
    assert.equal(await modeOf(fresh), 0o700);
    const older = path.join(base, "older");
    await mkdir(older, { mode: 0o755 });
    await chmod(older, 0o755);
    await ensurePrivateDir(older);
    assert.equal(await modeOf(older), 0o700);
  });
});
