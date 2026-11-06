// Sessions, the folder policy (spec D12 and SP3 "Folder policy", planning
// decision Q12): which folders a session may start in, and the list of recent
// folders. Nothing here starts an agent or a session; every test uses a temp
// HOME, AGENT_OS_HOME and managed Node folder, never the real ones.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkSessionFolder, recentSessionFolders } from "../server/runtime/sessions/folders.js";

const isWindows = process.platform === "win32";
const posixSkip = { skip: isWindows ? "symlinks and POSIX paths" : false };
// macOS and Windows volumes usually ignore letter case; most Linux ones don't.
const CASE_INSENSITIVE_DISK = existsSync(os.tmpdir().toUpperCase());

const MESSAGE = {
  not_absolute: "Type the full path, starting with / (or a drive letter on Windows).",
  missing: "That folder doesn't exist.",
  unreadable: "Agent OS can't open that folder.",
  not_a_directory: "That is a file, not a folder.",
  is_home: "Your home folder itself can't be used. Pick a folder inside it.",
  outside_home: "Pick a folder inside your home folder.",
  inside_agent_os: "Agent OS's own folder can't be used."
};

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A temp world: HOME with a project, Agent OS's own folder inside HOME (as it
// is by default), the managed Node folder inside HOME, and a folder outside HOME.
async function withFolders(fn) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-folders-")));
  const home = path.join(base, "home");
  const agentOsHome = path.join(home, ".hermes-agent-os");
  const managedRoot = path.join(home, ".agent-os");
  const dirs = {
    base,
    home,
    agentOsHome,
    managedRoot,
    project: path.join(home, "projects", "app"),
    worktrees: path.join(agentOsHome, "worktrees"),
    worktree: path.join(agentOsHome, "worktrees", "app-copy"),
    workspace: path.join(agentOsHome, "workspace"),
    managedBin: path.join(managedRoot, "node", "bin"),
    outside: path.join(base, "outside", "real"),
    file: path.join(home, "notes.txt")
  };
  for (const dir of [dirs.project, dirs.worktree, dirs.workspace, dirs.managedBin, dirs.outside]) await mkdir(dir, { recursive: true });
  await writeFile(dirs.file, "hello\n");
  try {
    return await withEnv(
      { HOME: home, USERPROFILE: home, AGENT_OS_HOME: agentOsHome, HERMES_AGENT_OS_HOME: undefined, AGENT_OS_MANAGED_ROOT: managedRoot },
      async () => {
        assert.equal(os.homedir(), home, "tests must never see the real home folder");
        return fn(dirs);
      }
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function refused(result, code) {
  assert.deepEqual(result, { ok: false, code, message: MESSAGE[code] });
}

test("folder policy: a real folder inside HOME is accepted, as its real path and name", posixSkip, async () => {
  await withFolders(async ({ project }) => {
    assert.deepEqual(await checkSessionFolder(project), { ok: true, path: project, name: "app" });
    assert.deepEqual(await checkSessionFolder(`${project}/`), { ok: true, path: project, name: "app" }, "a trailing slash is fine");
    assert.deepEqual(await checkSessionFolder(`  ${project}  `), { ok: true, path: project, name: "app" }, "spaces around a typed path are ignored");
  });
});

test("folder policy: HOME itself is refused", posixSkip, async () => {
  await withFolders(async ({ home }) => {
    refused(await checkSessionFolder(home), "is_home");
  });
});

test("folder policy: Agent OS's own folder and everything in it are refused, except worktrees/", posixSkip, async () => {
  await withFolders(async ({ agentOsHome, workspace, worktrees, worktree }) => {
    refused(await checkSessionFolder(agentOsHome), "inside_agent_os");
    refused(await checkSessionFolder(workspace), "inside_agent_os");
    assert.equal((await checkSessionFolder(worktrees)).ok, true);
    assert.deepEqual(await checkSessionFolder(worktree), { ok: true, path: worktree, name: "app-copy" });
  });
});

test("folder policy: the managed Node folder is Agent OS's own folder too (Q12)", posixSkip, async () => {
  await withFolders(async ({ managedRoot, managedBin }) => {
    refused(await checkSessionFolder(managedRoot), "inside_agent_os");
    refused(await checkSessionFolder(managedBin), "inside_agent_os");
  });
});

test("folder policy: an upper-case spelling of AGENT_OS_HOME is still Agent OS's folder (macOS and Windows ignore case)", posixSkip, async () => {
  await withFolders(async ({ home, workspace }) => {
    const upper = path.join(home, ".HERMES-AGENT-OS");
    for (const platform of ["darwin", "win32"]) {
      refused(await checkSessionFolder(workspace, { agentOsHome: upper, platform }), "inside_agent_os");
    }
  });
});

test("folder policy: an upper-case spelling of HOME is still HOME (macOS and Windows ignore case)", posixSkip, async () => {
  await withFolders(async ({ home, project }) => {
    const upperHome = home.toUpperCase();
    for (const platform of ["darwin", "win32"]) {
      refused(await checkSessionFolder(home, { home: upperHome, platform }), "is_home");
      assert.equal((await checkSessionFolder(project, { home: upperHome, platform })).ok, true, "still inside HOME");
    }
  });
});

test(
  "folder policy: a typed upper-case path into Agent OS's folder is refused (disk that ignores case)",
  { skip: isWindows || !CASE_INSENSITIVE_DISK ? "needs a POSIX disk that ignores letter case" : false },
  async () => {
    await withFolders(async ({ home, workspace }) => {
      refused(await checkSessionFolder(path.join(home, ".HERMES-AGENT-OS", "workspace")), "inside_agent_os");
      refused(await checkSessionFolder(workspace.toUpperCase()), "inside_agent_os");
    });
  }
);

test(
  "folder policy: on a case-sensitive Linux disk an upper-case HOME spelling is another folder",
  { skip: isWindows || CASE_INSENSITIVE_DISK ? "needs a disk that keeps letter case apart" : false },
  async () => {
    await withFolders(async ({ home, project }) => {
      refused(await checkSessionFolder(project, { home: home.toUpperCase(), platform: "linux" }), "outside_home");
    });
  }
);

test("folder policy: a symlink that leads out of HOME, or into Agent OS's folder, is refused", posixSkip, async () => {
  await withFolders(async ({ home, outside, workspace, project }) => {
    const escape = path.join(home, "looks-local");
    const sneaky = path.join(home, "looks-like-a-project");
    const fine = path.join(home, "shortcut-to-app");
    await symlink(outside, escape);
    await symlink(workspace, sneaky);
    await symlink(project, fine);
    refused(await checkSessionFolder(escape), "outside_home");
    refused(await checkSessionFolder(sneaky), "inside_agent_os");
    assert.deepEqual(await checkSessionFolder(fine), { ok: true, path: project, name: "app" }, "a symlink inside HOME resolves to its real folder");
  });
});

test("folder policy: HOME reached through a symlink still counts as HOME", posixSkip, async () => {
  await withFolders(async ({ base, home, project }) => {
    const homeLink = path.join(base, "home-link");
    await symlink(home, homeLink);
    refused(await checkSessionFolder(home, { home: homeLink }), "is_home");
    assert.equal((await checkSessionFolder(project, { home: homeLink })).ok, true);
  });
});

test("folder policy: a file, a missing path, a relative path and empty input are refused", posixSkip, async () => {
  await withFolders(async ({ home, file, outside }) => {
    refused(await checkSessionFolder(file), "not_a_directory");
    refused(await checkSessionFolder(path.join(home, "no-such-folder")), "missing");
    refused(await checkSessionFolder(path.join(file, "below-a-file")), "missing");
    refused(await checkSessionFolder(outside), "outside_home");
    for (const input of ["projects/app", "~/projects/app", "", "   ", null, undefined, 42, `${home}/a\0b`]) {
      refused(await checkSessionFolder(input), "not_absolute");
    }
  });
});

// ---- recent folders ---------------------------------------------------------------------------

async function writeMeta(agentOsHome, id, meta) {
  const dir = path.join(agentOsHome, "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "meta.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
}

test("recent folders (Review Focus 4): newest first, one row per folder, each checked again, so a folder deleted or moved since is dropped; update and OpenClaw sessions are left out", posixSkip, async () => {
  await withFolders(async ({ home, agentOsHome, project, workspace }) => {
    const site = path.join(home, "projects", "site");
    const gone = path.join(home, "projects", "deleted-later");
    const moved = path.join(home, "projects", "moved-later");
    const checkout = path.join(home, ".hermes", "hermes-agent");
    for (const dir of [site, gone, moved, checkout]) await mkdir(dir, { recursive: true });
    await writeMeta(agentOsHome, "11111111-1111-4111-8111-111111111111", { kind: "agent", agentId: "claude", folder: project, folderShown: true, startedAt: "2026-10-10T10:00:00.000Z", endedAt: "2026-10-10T11:00:00.000Z" });
    await writeMeta(agentOsHome, "22222222-2222-4222-8222-222222222222", { kind: "agent", agentId: "codex", folder: site, folderShown: true, startedAt: "2026-10-12T09:00:00.000Z", endedAt: null });
    // Task S6's full shape: lastUsedAt is the latest start, resume or end.
    await writeMeta(agentOsHome, "33333333-3333-4333-8333-333333333333", {
      version: 1,
      id: "33333333-3333-4333-8333-333333333333",
      kind: "agent",
      agentId: "hermes",
      agentLabel: "Hermes",
      folder: project,
      folderName: "app",
      folderShown: true,
      branch: null,
      status: "exited",
      createdAt: "2026-10-13T08:00:00.000Z",
      startedAt: "2026-10-13T08:00:00.000Z",
      endedAt: "2026-10-13T08:30:00.000Z",
      exitCode: 0,
      signal: null,
      endedBy: null,
      dismissed: false,
      brain: null,
      agentSessionId: null,
      resumeMode: "fallback",
      resumes: 0,
      lastUsedAt: "2026-10-13T08:30:00.000Z"
    });
    await writeMeta(agentOsHome, "44444444-4444-4444-8444-444444444444", { kind: "agent", agentId: "cursor", folder: gone, folderShown: true, startedAt: "2026-10-14T08:00:00.000Z", endedAt: "2026-10-14T09:00:00.000Z" });
    await writeMeta(agentOsHome, "99999999-9999-4999-8999-999999999999", { kind: "agent", agentId: "codex", folder: moved, folderShown: true, startedAt: "2026-10-14T09:30:00.000Z", endedAt: "2026-10-14T09:45:00.000Z", lastUsedAt: "2026-10-14T09:45:00.000Z" });
    await writeMeta(agentOsHome, "55555555-5555-4555-8555-555555555555", { kind: "update", agentId: "hermes", folder: checkout, folderShown: true, startedAt: "2026-10-14T10:00:00.000Z", endedAt: "2026-10-14T10:05:00.000Z" });
    await writeMeta(agentOsHome, "66666666-6666-4666-8666-666666666666", { kind: "agent", agentId: "openclaw", folder: home, folderShown: false, startedAt: "2026-10-14T11:00:00.000Z", endedAt: null });
    await writeMeta(agentOsHome, "77777777-7777-4777-8777-777777777777", { kind: "agent", agentId: "claude", folder: workspace, folderShown: true, startedAt: "2026-10-14T12:00:00.000Z", endedAt: null });
    await writeMeta(agentOsHome, "88888888-8888-4888-8888-888888888888", "{ this is not json");
    await rm(gone, { recursive: true, force: true });
    await rename(moved, path.join(home, "projects", "moved-here"));

    assert.deepEqual(await recentSessionFolders(), [
      { path: project, name: "app", lastUsedAt: "2026-10-13T08:30:00.000Z" },
      { path: site, name: "site", lastUsedAt: "2026-10-12T09:00:00.000Z" }
    ]);
    assert.deepEqual(await recentSessionFolders({ limit: 1 }), [{ path: project, name: "app", lastUsedAt: "2026-10-13T08:30:00.000Z" }]);
  });
});

// Fix round 1: a folder that exists but the account can't enter or list used to
// pass (ok: true) and fail later, at spawn, with EACCES. Modes don't bind root
// and Windows has no POSIX modes.
test(
  "folder policy: a folder that exists but can't be opened is refused as missing with its own message, and recent folders stops offering it",
  { skip: isWindows || process.getuid?.() === 0 ? "needs POSIX file modes and a non-root account" : false },
  async () => {
    await withFolders(async ({ home, agentOsHome }) => {
      const locked = path.join(home, "projects", "locked");
      await mkdir(locked, { recursive: true });
      await writeMeta(agentOsHome, "11111111-1111-4111-8111-111111111111", { kind: "agent", folder: locked, folderShown: true, startedAt: "2026-10-12T09:00:00.000Z", endedAt: null });
      assert.deepEqual(await checkSessionFolder(locked), { ok: true, path: locked, name: "locked" }, "open, it passes");
      assert.deepEqual(await recentSessionFolders(), [{ path: locked, name: "locked", lastUsedAt: "2026-10-12T09:00:00.000Z" }]);
      try {
        // No access at all, listable but not enterable, enterable but not listable.
        for (const mode of [0o000, 0o400, 0o100]) {
          await chmod(locked, mode);
          assert.deepEqual(
            await checkSessionFolder(locked),
            { ok: false, code: "missing", message: MESSAGE.unreadable },
            `mode ${mode.toString(8).padStart(3, "0")}`
          );
          assert.deepEqual(await recentSessionFolders(), [], `mode ${mode.toString(8).padStart(3, "0")}: no longer offered`);
        }
      } finally {
        await chmod(locked, 0o755);
      }
      assert.equal((await checkSessionFolder(locked)).ok, true, "open again, it passes again");
    });
  }
);

test("recent folders: a row's time is the latest of startedAt, endedAt and lastUsedAt", posixSkip, async () => {
  await withFolders(async ({ home, agentOsHome, project }) => {
    const site = path.join(home, "projects", "site");
    await mkdir(site, { recursive: true });
    await writeMeta(agentOsHome, "11111111-1111-4111-8111-111111111111", { kind: "agent", folder: project, folderShown: true, startedAt: "2026-10-10T10:00:00.000Z", endedAt: "2026-10-10T11:00:00.000Z", lastUsedAt: "2026-10-14T07:00:00.000Z" });
    await writeMeta(agentOsHome, "22222222-2222-4222-8222-222222222222", { kind: "agent", folder: site, folderShown: true, startedAt: "2026-10-12T09:00:00.000Z", endedAt: null, lastUsedAt: null });
    assert.deepEqual(await recentSessionFolders(), [
      { path: project, name: "app", lastUsedAt: "2026-10-14T07:00:00.000Z" },
      { path: site, name: "site", lastUsedAt: "2026-10-12T09:00:00.000Z" }
    ]);
  });
});

test("recent folders: none yet is an empty list", posixSkip, async () => {
  await withFolders(async () => {
    assert.deepEqual(await recentSessionFolders(), []);
  });
});

test("recent folders (R25): a session in a separate copy gives back the project it copied, and a folder inside worktrees/ is never offered", posixSkip, async () => {
  await withFolders(async ({ agentOsHome, project, worktree }) => {
    const copy = path.join(agentOsHome, "worktrees", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await mkdir(copy, { recursive: true });
    await writeMeta(agentOsHome, "11111111-1111-4111-8111-111111111111", {
      kind: "agent",
      folder: copy,
      copyOf: project,
      folderShown: true,
      startedAt: "2026-10-14T09:00:00.000Z",
      endedAt: null
    });
    // A copy's path typed by hand (no copyOf): the folder policy allows it, recent folders never offer it.
    await writeMeta(agentOsHome, "22222222-2222-4222-8222-222222222222", {
      kind: "agent",
      folder: worktree,
      folderShown: true,
      startedAt: "2026-10-14T10:00:00.000Z",
      endedAt: null
    });
    assert.deepEqual(await recentSessionFolders(), [{ path: project, name: "app", lastUsedAt: "2026-10-14T09:00:00.000Z" }]);
  });
});

test("folder policy (X9 review M1): <AGENT_OS_HOME>/worktrees stays allowed when AGENT_OS_HOME is the managed Node folder, and nothing else in it is", posixSkip, async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-folders-m1-")));
  try {
    const root = path.join(home, ".agent-os");
    const copy = path.join(root, "worktrees", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const node = path.join(root, "node");
    await mkdir(copy, { recursive: true });
    await mkdir(node, { recursive: true });
    const options = { home, agentOsHome: root, managedRoot: root };
    assert.deepEqual(await checkSessionFolder(copy, options), { ok: true, path: copy, name: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    assert.equal((await checkSessionFolder(root, options)).code, "inside_agent_os", "Agent OS's own folder is still refused");
    assert.equal((await checkSessionFolder(node, options)).code, "inside_agent_os", "and so is the managed Node folder inside it");
    // A strange setup, a managed folder placed inside worktrees/ itself, stays refused.
    const odd = path.join(root, "worktrees", "managed-here");
    await mkdir(odd, { recursive: true });
    assert.equal((await checkSessionFolder(odd, { home, agentOsHome: root, managedRoot: path.join(root, "worktrees") })).code, "inside_agent_os");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
