// SP5 Task V1: the version check service (server/runtime/updates/checks.js).
// A local http server stands in for the npm registry and the fake agent CLIs
// (test/fakes/tui-agent.mjs, through makeFakeAgentBin) stand in for the five
// agents, so no real network and no real agent is ever touched. The fake CLIs
// are POSIX shell shims, so the tests that start them skip on Windows.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { getAdapter } from "../server/runtime/agents/index.js";
import { configureConnection } from "../server/runtime/connections.js";
import {
  UPDATE_AGENT_IDS,
  checkAgent,
  createUpdateChecks,
  getUpdateChecks,
  hermesCleanForUpdate,
  npmRegistryBase,
  updateChecksEnabled
} from "../server/runtime/updates/checks.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

// The checks run only where a launcher turns them on (updateChecksEnabled), and `npm test` turns them off. These
// tests run them, always against fakes and a local registry, so they say so for this whole file.
process.env.AGENT_OS_UPDATE_CHECKS = "1";

const POSIX_ONLY = {
  skip: process.platform === "win32" ? "the fake agents are #!/bin/sh shims (POSIX-only), like every fake CLI in this suite" : false
};
// Fakes first, then only the operating system's own folders: the developer's normal PATH holds the REAL agents.
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const settle = () => new Promise((resolve) => setImmediate(resolve));

const CLAUDE_TAGS = "/-/package/@anthropic-ai/claude-code/dist-tags";
const CODEX_TAGS = "/-/package/@openai/codex/dist-tags";
// The registry's dist-tags for one package; `stable` adds the tag Claude Code's stable channel follows (R47).
const tags = (latest, stable) => ({ json: { latest, next: `${latest}-next`, ...(stable ? { stable } : {}) } });

const DRY_RUN_AVAILABLE = JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.9", restart: true, downgradeRisk: false });
const HERMES_BEHIND = "⚕ Update available: 3 commits behind origin/main.\nRun 'hermes update' to install.";

// The world the fakes start in: what each agent's --version prints, and the answers of the two agents
// that check themselves. A test overrides single entries (undefined removes one).
const WORLD = {
  FAKE_CLAUDE_VERSION: "2.1.309 (Claude Code)",
  FAKE_CODEX_VERSION: "codex-cli 0.154.0",
  FAKE_CURSOR_VERSION: "2026.10.14-941492e",
  FAKE_AGENT_VERSION: "OpenClaw 2026.10.4 (abcdef0)",
  FAKE_HERMES_VERSION: "Hermes Agent v0.22.5\nProject: /somewhere/hermes-agent",
  FAKE_OPENCLAW_UPDATE_DRY_RUN: `OpenClaw update check (dry run)\n${DRY_RUN_AVAILABLE}`,
  FAKE_HERMES_UPDATE_CHECK: HERMES_BEHIND
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

// A stand-in npm registry on 127.0.0.1. routes: { "<url path>": { json } | { status, body } | "hang" };
// a path with no route answers 404. requests lists every path that was asked for.
async function startRegistry(routes) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url];
    if (route === "hang") return; // never answers
    if (!route) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": "application/json" });
    res.end(route.body ?? JSON.stringify(route.json));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// Fake agents on PATH, a temp HOME (so no real agent under the real home is found), a local registry, and
// the WORLD knobs. ctx: { dir, home, log, registry, readLog() }.
async function withFakes({ routes = { [CLAUDE_TAGS]: tags("2.1.310"), [CODEX_TAGS]: tags("0.154.0") }, env = {} } = {}, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-updates-"));
  const registry = await startRegistry(routes);
  try {
    const bin = await makeFakeAgentBin(path.join(dir, "bin"));
    const home = path.join(dir, "home");
    await mkdir(home);
    const log = path.join(dir, "fake.log");
    const vars = {
      PATH: [bin.dir, ...SYSTEM_PATH_DIRS].join(path.delimiter),
      HOME: home,
      USERPROFILE: home,
      AGENT_OS_HOME: home,
      SHELL: FAKE_LOGIN_SHELL,
      HERMES_HOME: undefined,
      HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
      // Claude Code's update channel is read from settings.json in this folder, else in .claude under HOME (R47). A
      // developer's own CLAUDE_CONFIG_DIR must never send a test to their real settings, so it is cleared: the temp
      // HOME above is the only place a test's settings can be.
      CLAUDE_CONFIG_DIR: undefined,
      AGENT_OS_TEST_NPM_REGISTRY: registry.url,
      AGENT_OS_UPDATE_CHECKS: "1",
      FAKE_AGENT_LOG: log,
      ...WORLD,
      ...env
    };
    return await withEnv(vars, async () => {
      clearDetectCaches();
      const readLog = async () =>
        existsSync(log)
          ? (await readFile(log, "utf8"))
              .split("\n")
              .filter(Boolean)
              .map((entry) => JSON.parse(entry))
          : [];
      return fn({ dir, home, log, registry, readLog });
    });
  } finally {
    await registry.close();
    clearDetectCaches();
    await rm(dir, { recursive: true, force: true });
  }
}

const withoutTime = ({ checkedAt, ...rest }) => {
  assert.match(checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "checkedAt is an ISO time");
  return rest;
};

// ---- the fake CLIs and the local registry ------------------------------------------------------------

test("claude: installed 2.1.309, latest 2.1.310 is available; codex: equal is up to date; cursor: unknown, no number", POSIX_ONLY, async () => {
  await withFakes({}, async ({ registry }) => {
    assert.deepEqual(withoutTime(await checkAgent("claude")), {
      agentId: "claude",
      installed: "2.1.309",
      latest: "2.1.310",
      state: "available"
    });
    assert.deepEqual(withoutTime(await checkAgent("codex")), {
      agentId: "codex",
      installed: "0.154.0",
      latest: "0.154.0",
      state: "up-to-date"
    });
    assert.deepEqual(registry.requests, [CLAUDE_TAGS, CODEX_TAGS], "each package's dist-tags, nothing else");

    // Cursor has no check command (R37): nothing is asked of the registry, and no number is claimed.
    registry.requests.length = 0;
    assert.deepEqual(withoutTime(await checkAgent("cursor")), {
      agentId: "cursor",
      installed: "2026.10.14",
      latest: null,
      state: "unknown"
    });
    assert.deepEqual(registry.requests, []);
  });
});

test("claude: a newer installed version than the registry's latest (a beta) is up to date, not an update, and no older Latest is printed (R37)", POSIX_ONLY, async () => {
  await withFakes({ routes: { [CLAUDE_TAGS]: tags("2.1.300") } }, async () => {
    const status = await checkAgent("claude");
    assert.equal(status.state, "up-to-date");
    assert.equal(status.latest, null, "the page never shows a Latest that is older than Installed");
  });
});

test("npm agents: Installed newer than the tag is up to date with no Latest; equal keeps it; a version that cannot be compared stays as it was (SP5 E2 round 1)", POSIX_ONLY, async () => {
  // Claude Code on the stable channel, moved there from latest: Installed 2.1.318, stable 2.1.311.
  await withFakes({ routes: CLAUDE_BOTH_TAGS, env: { FAKE_CLAUDE_VERSION: "2.1.318 (Claude Code)" } }, async ({ home }) => {
    await writeClaudeSettings(path.join(home, ".claude"), SETTINGS_STABLE);
    assert.deepEqual(withoutTime(await checkAgent("claude")), { agentId: "claude", installed: "2.1.318", latest: null, state: "up-to-date" });
  });
  // Codex ahead of latest.
  await withFakes({ routes: { [CODEX_TAGS]: tags("0.155.0") }, env: { FAKE_CODEX_VERSION: "codex-cli 0.160.0" } }, async () => {
    assert.deepEqual(withoutTime(await checkAgent("codex")), { agentId: "codex", installed: "0.160.0", latest: null, state: "up-to-date" });
  });
  // Equal still shows its Latest (the number is the news that nothing is newer), on stable and on latest.
  await withFakes({ routes: CLAUDE_BOTH_TAGS, env: { FAKE_CLAUDE_VERSION: "2.1.311 (Claude Code)" } }, async ({ home }) => {
    await writeClaudeSettings(path.join(home, ".claude"), SETTINGS_STABLE);
    assert.deepEqual(withoutTime(await checkAgent("claude")), { agentId: "claude", installed: "2.1.311", latest: "2.1.311", state: "up-to-date" });
  });
  await withFakes({ routes: { [CODEX_TAGS]: tags("0.154.0") } }, async () => {
    assert.equal((await checkAgent("codex")).latest, "0.154.0");
  });
  // An installed version with no number cannot be compared: the registry's number and an "unknown" state, as before.
  const deps = {
    readClaudeSettings: async () => "",
    detect: async () => ({ installed: true, path: "/fake/claude", version: "development build" }),
    fetchText: async () => '{"latest":"2.1.318"}'
  };
  const unreadable = await checkAgent("claude", deps);
  assert.equal(unreadable.state, "unknown");
  assert.equal(unreadable.latest, "2.1.318");
});

test("openclaw: the dry run says an update is available and its Gateway restarts; the dry run is the only thing asked", POSIX_ONLY, async () => {
  await withFakes({}, async ({ readLog }) => {
    assert.deepEqual(withoutTime(await checkAgent("openclaw")), {
      agentId: "openclaw",
      installed: "2026.10.4",
      latest: "2026.10.9",
      state: "available",
      restartsGateway: true
    });
    const dryRuns = (await readLog()).filter((entry) => entry.event === "update-dry-run");
    assert.equal(dryRuns.length, 1);
    assert.deepEqual(dryRuns[0].argv, ["update", "--dry-run", "--json"], "argv only, and never --yes");
    assert.equal(dryRuns[0].name, "openclaw");
  });
});

test("openclaw: a dry run with downgradeRisk true counts as no update, even when its target number looks newer", POSIX_ONLY, async () => {
  // The same document as the "available" one, but flagged: only the flag can make this "up to date".
  const flagged = JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.9", restart: true, downgradeRisk: true });
  await withFakes({ env: { FAKE_OPENCLAW_UPDATE_DRY_RUN: flagged } }, async () => {
    // No "Latest" is claimed either: the page must never show a Latest that is older than Installed.
    assert.deepEqual(withoutTime(await checkAgent("openclaw")), {
      agentId: "openclaw",
      installed: "2026.10.4",
      latest: null,
      state: "up-to-date",
      restartsGateway: false
    });
  });
  // A target that really is older is no update either.
  const older = JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.1", restart: true, downgradeRisk: true });
  await withFakes({ env: { FAKE_OPENCLAW_UPDATE_DRY_RUN: older } }, async () => {
    const status = await checkAgent("openclaw");
    assert.equal(status.state, "up-to-date");
    assert.equal(status.latest, null, "an older target is never shown as Latest");
    assert.equal(status.restartsGateway, false);
  });
});

test("openclaw: the same version as its target is up to date; a failing or unreadable dry run is failed", POSIX_ONLY, async () => {
  const same = JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.4", restart: false, downgradeRisk: false });
  await withFakes({ env: { FAKE_OPENCLAW_UPDATE_DRY_RUN: same } }, async () => {
    const status = await checkAgent("openclaw");
    assert.equal(status.state, "up-to-date");
    assert.equal(status.restartsGateway, false);
  });
  await withFakes({ env: { FAKE_OPENCLAW_UPDATE_DRY_RUN: "fail" } }, async () => {
    const status = await checkAgent("openclaw");
    assert.equal(status.state, "failed");
    assert.equal(status.installed, "2026.10.4", "what is installed is still known");
    assert.equal(status.latest, null);
  });
  await withFakes({ env: { FAKE_OPENCLAW_UPDATE_DRY_RUN: "Error: update server unreachable" } }, async () => {
    assert.equal((await checkAgent("openclaw")).state, "failed", "no JSON in the output");
  });
  await withFakes({ env: { FAKE_OPENCLAW_UPDATE_DRY_RUN: '{"currentVersion":"2026.10.4"}' } }, async () => {
    const status = await checkAgent("openclaw");
    assert.equal(status.state, "unknown", "a dry run that names no target cannot be compared");
    assert.equal(status.latest, null);
  });
});

test("hermes: up to date and behind, read from `hermes update --check`; the older wording gives no version number, so none is claimed", POSIX_ONLY, async () => {
  await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: undefined } }, async ({ readLog }) => {
    assert.deepEqual(withoutTime(await checkAgent("hermes")), {
      agentId: "hermes",
      installed: "0.22.5",
      latest: null,
      state: "up-to-date"
    });
    const checks = (await readLog()).filter((entry) => entry.event === "update-check");
    assert.deepEqual(checks.map((entry) => entry.argv), [["update", "--check"]], "argv only: the check, nothing else");
  });
  await withFakes({}, async () => {
    assert.deepEqual(withoutTime(await checkAgent("hermes")), {
      agentId: "hermes",
      installed: "0.22.5",
      latest: null,
      state: "available"
    });
  });
  await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: "fail" } }, async () => {
    const status = await checkAgent("hermes");
    assert.equal(status.state, "failed", "exit 1: the check itself failed");
    assert.equal(status.installed, "0.22.5");
  });
  await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: "something Hermes never printed before" } }, async () => {
    assert.equal((await checkAgent("hermes")).state, "failed", "no verdict line: the check could not tell");
  });
});

test("hermes: the check runs with the HERMES_HOME that Agent OS is set up with (the stored one), and with none when none is set", POSIX_ONLY, async () => {
  await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: undefined } }, async ({ home, readLog }) => {
    await checkAgent("hermes");
    const [none] = (await readLog()).filter((entry) => entry.event === "update-check");
    assert.equal(none.env.HERMES_HOME, undefined, "nothing configured: the child inherits no HERMES_HOME");

    const profile = path.join(home, "hermes-profile");
    await configureConnection("hermes", { HERMES_HOME: profile });
    assert.equal(process.env.HERMES_HOME, undefined, "stored in Agent OS's own store, not in the environment");
    await checkAgent("hermes");
    const checks = (await readLog()).filter((entry) => entry.event === "update-check");
    assert.equal(checks.at(-1).env.HERMES_HOME, profile, "the same profile that chat runs and safety reads use");
  });
});

// ---- Hermes on a release channel (SP5 E2, R48) -----------------------------------------------------------

// What the real `hermes update --check` printed on the owner's Mac (exit 0), found by the live check.
const HERMES_RELEASE_AVAILABLE = [
  "→ Update channel: stable",
  "→ Selected release available: stable v0.22.7 (b200f5bc60e3)",
  "  Run `hermes update` to install it."
].join("\n");

test("hermes on a release channel: the selected release is Latest, and the row is an update", POSIX_ONLY, async () => {
  await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: HERMES_RELEASE_AVAILABLE } }, async () => {
    // Installed 0.22.5 (the WORLD's Hermes), selected release 0.22.7.
    assert.deepEqual(withoutTime(await checkAgent("hermes")), {
      agentId: "hermes",
      installed: "0.22.5",
      latest: "0.22.7",
      state: "available"
    });
  });
});

test("hermes: 'This checkout is newer', 'Holding at this build' and the up-to-date wordings are up to date, with no Latest and nothing to offer", POSIX_ONLY, async () => {
  // The first would move the copy BACK to the release; the second stays where it is. Neither may become an Update.
  const wordings = [
    "→ Update channel: stable\n→ This checkout is newer than the selected release: v0.22.5 is ahead of stable v0.22.4",
    "→ Update channel: stable\n→ Holding at this build: it was put here on purpose",
    "→ Update channel: stable\n✓ Up to date with the latest release (stable v0.22.5).",
    "→ Update channel: stable\n✓ No newer release: stable v0.22.5."
  ];
  for (const wording of wordings) {
    await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: wording } }, async () => {
      assert.deepEqual(
        withoutTime(await checkAgent("hermes")),
        { agentId: "hermes", installed: "0.22.5", latest: null, state: "up-to-date" },
        wording
      );
    });
  }
});

test("hermes: a selected release that is the installed version, or older, is up to date with no Latest (the page never offers a step back)", POSIX_ONLY, async () => {
  for (const selected of ["stable v0.22.5 (b200f5bc60e3)", "stable v0.22.3 (aaaaaaaaaaaa)", "stable v0.9.0"]) {
    await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: `→ Update channel: stable\n→ Selected release available: ${selected}` } }, async () => {
      assert.deepEqual(
        withoutTime(await checkAgent("hermes")),
        { agentId: "hermes", installed: "0.22.5", latest: null, state: "up-to-date" },
        selected
      );
    });
  }
});

test("hermes: when the installed version has no number it cannot be compared, so the selected release stays an update", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-updates-home-"));
  try {
    await withEnv({ HERMES_HOME: undefined, AGENT_OS_HOME: home }, async () => {
      const status = await checkAgent("hermes", {
        readClaudeSettings: async () => "",
        detect: async () => ({ installed: true, path: "/fake/hermes", version: "Hermes Agent (development build)" }),
        runCli: async () => ({ ok: true, code: 0, stdout: "→ Selected release available: stable v0.22.7", stderr: "" })
      });
      assert.equal(status.state, "available");
      assert.equal(status.latest, "0.22.7");
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---- Claude Code follows its own update channel (SP5 E2, R47) -------------------------------------------------

const SETTINGS_STABLE = JSON.stringify({ autoUpdatesChannel: "stable" });
// On the owner's Mac on 2026-11-05: stable 2.1.311, latest 2.1.318.
const CLAUDE_BOTH_TAGS = { [CLAUDE_TAGS]: tags("2.1.318", "2.1.311"), [CODEX_TAGS]: tags("0.154.0") };

async function writeClaudeSettings(folder, text) {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "settings.json"), text);
}

test("claude on the stable channel: Latest is the stable tag, so a Claude Code that is on stable is up to date", POSIX_ONLY, async () => {
  // Installed 2.1.311 (stable), latest 2.1.318: `claude update` says it is up to date, and so does the row.
  await withFakes({ routes: CLAUDE_BOTH_TAGS, env: { FAKE_CLAUDE_VERSION: "2.1.311 (Claude Code)" } }, async ({ home, registry }) => {
    await writeClaudeSettings(path.join(home, ".claude"), SETTINGS_STABLE);
    assert.deepEqual(withoutTime(await checkAgent("claude")), {
      agentId: "claude",
      installed: "2.1.311",
      latest: "2.1.311",
      state: "up-to-date"
    });
    assert.deepEqual(registry.requests, [CLAUDE_TAGS], "the same dist-tags answer; only the tag read from it differs");
  });
  // Behind the stable tag: an update to the stable number, not to latest.
  await withFakes({ routes: CLAUDE_BOTH_TAGS }, async ({ home }) => {
    await writeClaudeSettings(path.join(home, ".claude"), SETTINGS_STABLE);
    const status = await checkAgent("claude");
    assert.equal(status.installed, "2.1.309");
    assert.equal(status.latest, "2.1.311");
    assert.equal(status.state, "available");
  });
});

test("claude: no settings file, an unreadable one, or any channel but stable reads the latest tag", POSIX_ONLY, async () => {
  await withFakes({ routes: CLAUDE_BOTH_TAGS }, async ({ home }) => {
    const folder = path.join(home, ".claude");
    const expectLatest = async (why) => {
      const status = await checkAgent("claude");
      assert.equal(status.latest, "2.1.318", why);
      assert.equal(status.state, "available", why);
    };
    await expectLatest("no file at all (the folder does not even exist)");
    await writeClaudeSettings(folder, "{ this is not json");
    await expectLatest("unreadable JSON");
    await writeClaudeSettings(folder, JSON.stringify({ autoUpdatesChannel: "latest" }));
    await expectLatest('autoUpdatesChannel "latest"');
    await writeClaudeSettings(folder, JSON.stringify({ autoUpdatesChannel: "beta" }));
    await expectLatest("another channel name");
    await writeClaudeSettings(folder, JSON.stringify({ theme: "dark" }));
    await expectLatest("no autoUpdatesChannel key");
    await writeClaudeSettings(folder, "[]");
    await expectLatest("JSON that is not an object");
    await rm(path.join(folder, "settings.json"));
    await mkdir(path.join(folder, "settings.json"));
    await expectLatest("settings.json that cannot be read as a file");
  });
});

test("claude: a pipe, or a file over 1 MB, at the settings path reads as no file, at once (SP5 E2 round 1: the repo's safe reader)", POSIX_ONLY, async () => {
  await withFakes({ routes: CLAUDE_BOTH_TAGS }, async ({ home }) => {
    const folder = path.join(home, ".claude");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "settings.json");

    // A named pipe: a plain readFile waits in one of Node's few file threads until somebody writes into it, and a few of
    // those stop every file call in the server. The read must answer "no file" and leave nothing waiting. The short limit
    // makes a blocked read show up as "failed" here instead of waiting out the real 30 s.
    execFileSync("/usr/bin/mkfifo", [file]);
    try {
      const started = Date.now();
      const status = await checkAgent("claude", { limitMs: 4000 });
      assert.equal(status.state, "available", "a pipe is no settings file: the latest tag was read");
      assert.equal(status.latest, "2.1.318");
      assert.ok(Date.now() - started < 3000, "and it did not wait for the pipe");
    } finally {
      try {
        // Frees a reader that a blocking open left waiting, so a failing run does not leave a thread stuck.
        closeSync(openSync(file, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
      } catch {
        // nobody is waiting: nothing to free
      }
      await rm(file, { force: true });
    }

    // A file over the reader's 1 MB limit is not read, whatever it says.
    await writeFile(file, JSON.stringify({ autoUpdatesChannel: "stable", padding: "x".repeat(1024 * 1024 + 16) }));
    assert.equal((await checkAgent("claude")).latest, "2.1.318", "too big: no file, so the latest tag");
    // Small enough, the same setting is read.
    await writeFile(file, JSON.stringify({ autoUpdatesChannel: "stable", padding: "x".repeat(1000) }));
    assert.equal((await checkAgent("claude")).latest, "2.1.311");
  });
});

test("claude: CLAUDE_CONFIG_DIR is the folder that is read (an absolute one), else .claude under the home folder", POSIX_ONLY, async () => {
  await withFakes({ routes: CLAUDE_BOTH_TAGS }, async ({ dir, home }) => {
    const custom = path.join(dir, "custom-claude");
    const empty = path.join(dir, "empty-claude");
    await writeClaudeSettings(custom, SETTINGS_STABLE);
    await mkdir(empty);
    await withEnv({ CLAUDE_CONFIG_DIR: custom }, async () => {
      assert.equal((await checkAgent("claude")).latest, "2.1.311", "the stable setting in the variable's folder is read");
    });

    // The home folder says stable too, but the variable points at a folder with no file: it does not fall back to ~/.claude.
    await writeClaudeSettings(path.join(home, ".claude"), SETTINGS_STABLE);
    await withEnv({ CLAUDE_CONFIG_DIR: empty }, async () => {
      assert.equal((await checkAgent("claude")).latest, "2.1.318");
    });
    // Without the variable, and with one that is not an absolute path (which Claude's session code ignores too), ~/.claude is read.
    assert.equal((await checkAgent("claude")).latest, "2.1.311");
    await withEnv({ CLAUDE_CONFIG_DIR: "relative-claude" }, async () => {
      assert.equal((await checkAgent("claude")).latest, "2.1.311");
    });
  });
});

test("codex always reads the latest tag, whatever Claude's settings say", POSIX_ONLY, async () => {
  const routes = { [CLAUDE_TAGS]: tags("2.1.318", "2.1.311"), [CODEX_TAGS]: tags("0.155.0", "0.150.0") };
  await withFakes({ routes }, async ({ home, registry }) => {
    await writeClaudeSettings(path.join(home, ".claude"), SETTINGS_STABLE);
    const status = await checkAgent("codex");
    assert.equal(status.latest, "0.155.0");
    assert.equal(status.state, "available");
    assert.deepEqual(registry.requests, [CODEX_TAGS]);
  });
  // Nor does anything but Claude Code read the settings at all.
  let reads = 0;
  const deps = {
    readClaudeSettings: async () => (reads += 1, SETTINGS_STABLE),
    detect: async (id) => ({ installed: true, path: `/fake/${id}`, version: "1.0.0" }),
    fetchText: async () => '{"latest":"1.0.1","stable":"1.0.0"}',
    runCli: async () => ({ ok: true, code: 0, stdout: "✓ Already up to date.", stderr: "" })
  };
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-updates-home-"));
  try {
    await withEnv({ HERMES_HOME: undefined, AGENT_OS_HOME: home }, async () => {
      for (const id of ["codex", "cursor", "openclaw", "hermes"]) await checkAgent(id, deps);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  assert.equal(reads, 0, "only Claude Code's lookup asks for the settings");
  assert.equal((await checkAgent("claude", deps)).latest, "1.0.0");
  assert.equal(reads, 1);
});

test("claude: a registry answer without the stable tag is failed ('Couldn't check') on the stable channel, like a missing latest", POSIX_ONLY, async () => {
  await withFakes({ routes: { [CLAUDE_TAGS]: tags("2.1.318") } }, async ({ home }) => {
    const folder = path.join(home, ".claude");
    await writeClaudeSettings(folder, SETTINGS_STABLE);
    const status = await checkAgent("claude");
    assert.equal(status.state, "failed");
    assert.equal(status.latest, null);
    assert.equal(status.installed, "2.1.309", "what is installed is still known");
    // The same answer is fine for someone on the latest channel.
    await writeClaudeSettings(folder, JSON.stringify({ autoUpdatesChannel: "latest" }));
    assert.equal((await checkAgent("claude")).latest, "2.1.318");
  });
  // And a registry that has only a stable tag is enough for someone on stable, and no use to someone on latest.
  await withFakes({ routes: { [CLAUDE_TAGS]: { json: { stable: "2.1.311" } } } }, async ({ home }) => {
    await writeClaudeSettings(path.join(home, ".claude"), SETTINGS_STABLE);
    assert.equal((await checkAgent("claude")).latest, "2.1.311");
    await writeClaudeSettings(path.join(home, ".claude"), "{}");
    assert.equal((await checkAgent("claude")).state, "failed");
  });
});

test("claude: the settings text goes only to the channel reader: it is not returned or printed, and a reader that fails counts as no file", async () => {
  const secret = "SECRET-MARKER-DO-NOT-KEEP";
  const text = JSON.stringify({ autoUpdatesChannel: "stable", apiKeyHelper: secret, env: { SOME_TOKEN: secret } });
  const deps = {
    detect: async () => ({ installed: true, path: "/fake/claude", version: "2.1.309 (Claude Code)" }),
    fetchText: async () => '{"latest":"2.1.318","stable":"2.1.311"}',
    runCli: async () => {
      throw new Error("Claude's lookup runs no program");
    }
  };
  const printed = [];
  const originals = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    originals[method] = console[method];
    console[method] = (...parts) => printed.push(parts.join(" "));
  }
  let status;
  try {
    status = await checkAgent("claude", { ...deps, readClaudeSettings: async () => text });
  } finally {
    Object.assign(console, originals);
  }
  assert.equal(status.latest, "2.1.311", "the stable setting was used");
  assert.ok(!JSON.stringify(status).includes(secret), "nothing from the file is in the answer");
  assert.deepEqual(printed, [], "and nothing was printed");

  const broken = await checkAgent("claude", {
    ...deps,
    readClaudeSettings: async () => {
      throw new Error("EACCES");
    }
  });
  assert.equal(broken.state, "available", "a reader that throws is not a failed check");
  assert.equal(broken.latest, "2.1.318", "no file: the latest tag");
});

// ---- failures stay apart ----------------------------------------------------------------------------

test("the registry answering 500 makes that agent failed and leaves the others as they are", POSIX_ONLY, async () => {
  await withFakes({ routes: { [CLAUDE_TAGS]: { status: 500, body: "server error" }, [CODEX_TAGS]: tags("0.155.0") } }, async () => {
    const checks = createUpdateChecks();
    const statuses = await checks.refresh();
    const byId = Object.fromEntries(statuses.map((status) => [status.agentId, status]));
    assert.deepEqual(Object.keys(byId), ["claude", "codex", "cursor", "openclaw", "hermes"]);
    assert.equal(byId.claude.state, "failed");
    assert.equal(byId.claude.installed, "2.1.309", "what is installed is still known");
    assert.equal(byId.claude.latest, null);
    assert.equal(byId.codex.state, "available");
    assert.equal(byId.cursor.state, "unknown");
    assert.equal(byId.openclaw.state, "available");
    assert.equal(byId.hermes.state, "available");
  });
});

test("a registry that is unreachable, answers something else, or never answers makes that agent failed", POSIX_ONLY, async () => {
  await withFakes({ routes: { [CLAUDE_TAGS]: { status: 200, body: "<html>Bad gateway</html>" }, [CODEX_TAGS]: "hang" } }, async ({ registry }) => {
    assert.equal((await checkAgent("claude")).state, "failed", "an answer that is not dist-tags");
    // An instant detect, so the only thing that can use the 400 ms is the registry that never answers.
    const detect = async () => ({ installed: true, path: "/fake/codex", version: "codex-cli 0.154.0" });
    const started = Date.now();
    assert.equal((await checkAgent("codex", { detect, limitMs: 400 })).state, "failed", "no answer within the limit");
    assert.ok(Date.now() - started < 5000, "the limit ended the wait");
    assert.ok(registry.requests.includes(CODEX_TAGS), "the registry was asked, and held the request");

    await registry.close();
    const refused = await checkAgent("claude");
    assert.equal(refused.state, "failed", "connection refused");
    assert.equal(refused.installed, "2.1.309");
  });
});

test("a CLI that hangs makes that agent failed after the limit, and the others are not held up", POSIX_ONLY, async () => {
  await withFakes({ env: { FAKE_HERMES_UPDATE_CHECK: "slow", FAKE_OPENCLAW_UPDATE_DRY_RUN: "slow" } }, async () => {
    // SP5 E1 (L14): this used to give all five agents the same 3 s and run the real detection of each inside it, so a loaded
    // machine that took 3 s to start a fake CLI turned "available" into "failed" by chance. Now only the two agents that are
    // MEANT to fail get the short limit (they are "failed" whether the limit ends the wait or their detection is slow), and
    // the three that must answer get a generous one. Their detection also takes longer than the short limit here, on purpose:
    // that is the loaded machine, and they must still be answered.
    const HANGING = new Set(["hermes", "openclaw"]);
    const slowDetect = async (id) => {
      if (!HANGING.has(id)) await new Promise((resolve) => setTimeout(resolve, 1500));
      return getAdapter(id).detect({ refresh: true });
    };
    const started = Date.now();
    const statuses = await Promise.all(
      UPDATE_AGENT_IDS.map((id) => checkAgent(id, { limitMs: HANGING.has(id) ? 1000 : 20000, detect: slowDetect }))
    );
    const byId = Object.fromEntries(statuses.map((status) => [status.agentId, status]));
    assert.equal(byId.hermes.state, "failed");
    assert.equal(byId.openclaw.state, "failed");
    assert.equal(byId.claude.state, "available");
    assert.equal(byId.codex.state, "up-to-date");
    assert.equal(byId.cursor.state, "unknown");
    assert.ok(Date.now() - started < 20000, "well before the fake's own 30 s");
  });
});

// ---- not installed, and the injected pieces ------------------------------------------------------------

test("an agent that is not installed is not-installed, with nothing asked of the registry or the agent", async () => {
  const calls = [];
  const deps = {
    detect: async () => ({ installed: false, path: "", version: "", features: {}, error: "not found" }),
    fetchText: async () => calls.push("fetch"),
    runCli: async () => calls.push("run"),
    now: () => Date.parse("2026-10-31T10:00:00Z")
  };
  for (const id of UPDATE_AGENT_IDS) {
    assert.deepEqual(await checkAgent(id, deps), {
      agentId: id,
      installed: null,
      latest: null,
      state: "not-installed",
      checkedAt: "2026-10-31T10:00:00.000Z"
    });
  }
  assert.deepEqual(calls, []);
});

test("checkAgent asks the registry for the right dist-tags and the agent for the right argv; a detect that fails is failed", async () => {
  const urls = [];
  const runs = [];
  const base = {
    // Nothing here may read the developer's real Claude settings (R47): no file, so the "latest" tag.
    readClaudeSettings: async () => "",
    detect: async (id) => ({ installed: true, path: `/fake/${id}`, version: id === "claude" ? "2.1.309 (Claude Code)" : "codex-cli 0.154.0" }),
    fetchText: async (url) => {
      urls.push(url);
      return '{"latest":"9.9.9"}';
    },
    runCli: async (command, args, options) => {
      runs.push({ command, args, hasSignal: Boolean(options.signal), timeoutMs: options.timeoutMs });
      return { ok: true, code: 0, stdout: "✓ Already up to date.", stderr: "" };
    }
  };
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-updates-home-"));
  try {
    await withEnv({ AGENT_OS_TEST_NPM_REGISTRY: undefined, HERMES_HOME: undefined, AGENT_OS_HOME: home }, async () => {
      await checkAgent("claude", base);
      await checkAgent("codex", base);
      await checkAgent("hermes", { ...base, limitMs: 1234 });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  assert.deepEqual(urls, [
    "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags",
    "https://registry.npmjs.org/-/package/@openai/codex/dist-tags"
  ]);
  assert.deepEqual(runs, [{ command: "/fake/hermes", args: ["update", "--check"], hasSignal: true, timeoutMs: 1234 }]);

  const broken = await checkAgent("claude", {
    ...base,
    detect: async () => {
      throw new Error("boom");
    }
  });
  assert.equal(broken.state, "failed");
  assert.equal(broken.installed, null);
  await assert.rejects(checkAgent("gemini", base), /unknown agent/);
});

test("the registry base is https://registry.npmjs.org; only AGENT_OS_TEST_NPM_REGISTRY, and only a plain http://127.0.0.1:<port>, replaces it", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    await withEnv({ AGENT_OS_TEST_NPM_REGISTRY: undefined }, () => assert.equal(npmRegistryBase(), "https://registry.npmjs.org"));
    await withEnv({ AGENT_OS_TEST_NPM_REGISTRY: "http://127.0.0.1:5555" }, () => assert.equal(npmRegistryBase(), "http://127.0.0.1:5555"));
    await withEnv({ AGENT_OS_TEST_NPM_REGISTRY: "http://127.0.0.1:5555/" }, () => assert.equal(npmRegistryBase(), "http://127.0.0.1:5555"));
    assert.deepEqual(warnings, []);
    const refused = [
      "https://evil.example",
      "http://evil.example:5555",
      "http://127.0.0.1:1@evil.example",
      "http://user:secret@127.0.0.1:5555",
      "http://127.0.0.1:5555/some/path",
      "https://127.0.0.1:5555",
      "not a url"
    ];
    for (const bad of refused) {
      await withEnv({ AGENT_OS_TEST_NPM_REGISTRY: bad }, () => assert.equal(npmRegistryBase(), "https://registry.npmjs.org", `ignored: ${bad}`));
    }
    assert.equal(warnings.length, refused.length, "each ignored value is warned about");
    assert.ok(warnings.every((line) => !line.includes("secret") && !line.includes("evil")), "the value itself is never printed");
  } finally {
    console.warn = originalWarn;
  }
});

// ---- the service ----------------------------------------------------------------------------------

const okStatus = (agentId) => ({ agentId, installed: "1.0.0", latest: "1.0.0", state: "up-to-date", checkedAt: "2026-10-31T00:00:00.000Z" });

test("list() before the first check returns [] without throwing; refresh() fills it in the agents' order", async () => {
  const calls = [];
  const checks = createUpdateChecks({
    check: async (id) => {
      calls.push(id);
      return okStatus(id);
    }
  });
  assert.deepEqual(checks.list(), []);
  const statuses = await checks.refresh();
  assert.deepEqual(statuses.map((status) => status.agentId), ["claude", "codex", "cursor", "openclaw", "hermes"]);
  assert.deepEqual(checks.list(), statuses);
  assert.deepEqual([...calls].sort(), [...UPDATE_AGENT_IDS].sort());

  // list() hands out copies: changing one never changes what the service holds.
  checks.list()[0].state = "failed";
  assert.equal(checks.list()[0].state, "up-to-date");
});

test("refresh(agentId) checks only that agent; an unknown id checks nothing; the five checks start together", async () => {
  const calls = [];
  const releases = [];
  const checks = createUpdateChecks({
    check: (id) => {
      calls.push(id);
      return new Promise((resolve) => releases.push(() => resolve(okStatus(id))));
    }
  });
  const all = checks.refresh();
  await settle();
  assert.equal(calls.length, 5, "all five started before any finished: they run in parallel");
  for (const release of releases) release();
  await all;

  calls.length = 0;
  releases.length = 0;
  const one = checks.refresh("codex");
  await settle();
  assert.deepEqual(calls, ["codex"]);
  releases[0]();
  assert.equal((await one).length, 5, "the answer is the whole list");

  calls.length = 0;
  assert.equal((await checks.refresh("gemini")).length, 5);
  assert.deepEqual(calls, []);
});

test("one check that throws never affects the others; its agent is failed, stamped with the injected clock", async () => {
  const seen = [];
  const now = () => Date.parse("2026-10-31T10:00:00Z");
  const checks = createUpdateChecks({
    now,
    check: async (id, options) => {
      seen.push(options.now);
      if (id === "codex") throw new Error("boom");
      return okStatus(id);
    }
  });
  const statuses = await checks.refresh();
  const byId = Object.fromEntries(statuses.map((status) => [status.agentId, status]));
  assert.deepEqual(byId.codex, { agentId: "codex", installed: null, latest: null, state: "failed", checkedAt: "2026-10-31T10:00:00.000Z" });
  assert.equal(byId.claude.state, "up-to-date");
  assert.equal(byId.hermes.state, "up-to-date");
  assert.ok(seen.every((fn) => fn === now), "the clock is handed to each check");
});

test("start() checks once at once and again after intervalMs; stop() ends it; a second start() adds no second timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls = [];
  const checks = createUpdateChecks({
    intervalMs: 1000,
    check: async (id) => {
      calls.push(id);
      return okStatus(id);
    }
  });
  checks.start();
  checks.start();
  await settle();
  assert.equal(calls.length, 5, "once at once, one per agent");
  assert.equal(checks.list().length, 5);

  t.mock.timers.tick(999);
  await settle();
  assert.equal(calls.length, 5, "not before the interval");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 10, "again after intervalMs");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls.length, 15);

  checks.stop();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls.length, 15, "nothing after stop()");
  checks.stop(); // stopping twice is harmless
});

test("the default interval is 24 hours", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let count = 0;
  const checks = createUpdateChecks({
    check: async (id) => {
      count += 1;
      return okStatus(id);
    }
  });
  checks.start();
  await settle();
  assert.equal(count, 5);
  t.mock.timers.tick(24 * 60 * 60 * 1000 - 1);
  await settle();
  assert.equal(count, 5);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(count, 10);
  checks.stop();
});

// ---- overlapping checks (SP5 V3, folded in from V1's review) --------------------------------------------

test("overlapping checks of one agent: the one that started last is kept, even when it finishes first", async () => {
  const releases = [];
  const checks = createUpdateChecks({
    check: (id) =>
      new Promise((resolve) => {
        const number = releases.length + 1;
        releases.push(() => resolve({ ...okStatus(id), latest: `answer-${number}` }));
      })
  });
  const slowFirst = checks.refresh("claude"); // starts first, finishes last
  await settle();
  // A plain refresh would share the first (SP5 E1, M2); the check an update asked for after it ended starts a new one
  // beside it, because the first began before the update ended and may hold the old version.
  const fastSecond = checks.refresh("claude", { afterChange: true }); // starts second, finishes first
  await settle();
  assert.equal(releases.length, 2);

  releases[1]();
  await fastSecond;
  assert.equal(checks.list()[0].latest, "answer-2");
  releases[0]();
  await slowFirst;
  assert.equal(checks.list()[0].latest, "answer-2", "the older check's answer arrived late and was dropped");

  // In order, the later check still replaces the earlier one.
  const again = checks.refresh("claude");
  await settle();
  releases[2]();
  await again;
  assert.equal(checks.list()[0].latest, "answer-3");
});

test("the sequence guard is per agent: a late answer for one agent never hides another agent's answer", async () => {
  const releases = {};
  const checks = createUpdateChecks({
    check: (id) => new Promise((resolve) => (releases[id] = () => resolve({ ...okStatus(id), latest: `latest-${id}` })))
  });
  const claude = checks.refresh("claude");
  const codex = checks.refresh("codex");
  await settle();
  releases.codex();
  await codex;
  releases.claude();
  await claude;
  assert.deepEqual(checks.list().map((status) => [status.agentId, status.latest]), [
    ["claude", "latest-claude"],
    ["codex", "latest-codex"]
  ]);
});

// ---- one check per agent at a time (SP5 E1, M2) ----------------------------------------------------------

test("two refreshes of one agent while its check runs share that one check: it runs once, and a later refresh starts a new one", async () => {
  const calls = [];
  const releases = {};
  const checks = createUpdateChecks({
    check: (id) => {
      calls.push(id);
      const number = calls.length;
      return new Promise((resolve) => (releases[id] = () => resolve({ ...okStatus(id), latest: `answer-${number}` })));
    }
  });
  const first = checks.refresh("claude");
  await settle();
  const second = checks.refresh("claude");
  const everyone = checks.refresh(); // claude is already being checked: the other four start, claude is shared
  await settle();
  assert.equal(calls.filter((id) => id === "claude").length, 1, "claude was checked once");
  assert.equal(calls.length, 5, "and each of the other four was started once");

  for (const id of UPDATE_AGENT_IDS) releases[id]();
  const answers = await Promise.all([first, second, everyone]);
  assert.ok(answers.every((list) => list.some((status) => status.agentId === "claude")), "each caller got an answer for claude");
  assert.equal(checks.list().find((status) => status.agentId === "claude").latest, "answer-1", "the one check's answer is the one kept");

  // Once it has ended nothing is shared any more: the next refresh checks again.
  const later = checks.refresh("claude");
  await settle();
  assert.equal(calls.filter((id) => id === "claude").length, 2);
  releases.claude();
  await later;
});

test("Hermes: overlapping refreshes share the clean check too, and a click's refreshHermesClean() still asks afresh", async () => {
  const cleanReleases = [];
  const checks = createUpdateChecks({
    check: async (id) => okStatus(id),
    cleanCheck: () => new Promise((resolve) => cleanReleases.push(() => resolve(CLEAN)))
  });
  const first = checks.refresh("hermes");
  await settle();
  const second = checks.refresh();
  await settle();
  assert.equal(cleanReleases.length, 1, "one clean check for the two rounds");
  const click = checks.refreshHermesClean(); // a person's Update click wants its own answer
  await settle();
  assert.equal(cleanReleases.length, 2, "the click is not shared with a background round");
  for (const release of cleanReleases) release();
  await Promise.all([first, second, click]);
  assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] });
});

test("while an agent's update runs its check is skipped and its saved row is kept; the others are still checked, and it is checked again once the update ends", async () => {
  const updating = new Set();
  const calls = [];
  let cleanCalls = 0;
  const checks = createUpdateChecks({
    check: async (id) => {
      calls.push(id);
      return { ...okStatus(id), latest: `answer-${calls.length}` };
    },
    cleanCheck: async () => {
      cleanCalls += 1;
      return CLEAN;
    },
    isUpdating: (id) => updating.has(id)
  });
  await checks.refresh();
  const row = (id) => checks.list().find((status) => status.agentId === id);
  const claudeBefore = row("claude");
  const hermesBefore = row("hermes");
  assert.equal(cleanCalls, 1);

  calls.length = 0;
  updating.add("claude");
  updating.add("hermes");
  const answer = await checks.refresh();
  assert.deepEqual([...calls].sort(), ["codex", "cursor", "openclaw"], "the agents being updated are not checked");
  assert.equal(cleanCalls, 1, "and neither is Hermes's folder while Hermes updates");
  assert.deepEqual(answer.find((status) => status.agentId === "claude"), claudeBefore, "the cached row is kept");
  assert.deepEqual(row("hermes"), hermesBefore);

  calls.length = 0;
  await checks.refresh("claude");
  await checks.refresh("hermes");
  assert.deepEqual(calls, [], "asking for the agent by name does not check it either");

  updating.clear();
  await checks.refresh("claude");
  assert.deepEqual(calls, ["claude"], "the update ended: the next round checks it");
});

test("the check an update asks for after it ended runs even while the agent still counts as updating and even beside an older check", async () => {
  // A failed update step is still "running" in the job list when its after-update check is asked for, and a periodic check that
  // began before the update may still be waiting for its answer: neither may hold the check back.
  let updating = false;
  const releases = [];
  const checks = createUpdateChecks({
    check: (id) =>
      new Promise((resolve) => {
        const number = releases.length + 1;
        releases.push(() => resolve({ ...okStatus(id), latest: `answer-${number}` }));
      }),
    isUpdating: () => updating
  });
  const periodic = checks.refresh("claude"); // began before the update
  await settle();
  updating = true;
  const afterUpdate = checks.refresh("claude", { afterChange: true });
  await settle();
  assert.equal(releases.length, 2, "a second check started although the first is still running and the agent is counted as updating");
  releases[1]();
  await afterUpdate;
  releases[0]();
  await periodic;
  assert.equal(checks.list()[0].latest, "answer-2", "the answer asked for after the update is the one kept");

  // A plain refresh is skipped meanwhile.
  await checks.refresh("claude");
  assert.equal(releases.length, 2);
});

test("an isUpdating that fails counts as not updating: the check still runs", async () => {
  const calls = [];
  const checks = createUpdateChecks({
    check: async (id) => (calls.push(id), okStatus(id)),
    isUpdating: () => {
      throw new Error("boom");
    }
  });
  await checks.refresh("codex");
  assert.deepEqual(calls, ["codex"]);
});

// ---- one more try after a failed first answer (SP5 E2, R49) -------------------------------------------------

// The retry timer is a setTimeout and the 24-hour round a setInterval; both are mocked so a test ticks the clock instead of waiting.
const MOCK_CLOCK = { apis: ["setInterval", "setTimeout"] };
const NO_CHECKOUT = { clean: false, checkout: null, reasons: ["no_checkout"] };

// A service whose check answers from `script`: { agentId: [state, state, ...] }, one state per time that agent is asked, the last
// one repeating (an agent with no entry is always up to date). `calls` lists every agent asked, in order.
function scriptedChecks(script = {}, options = {}) {
  const calls = [];
  const checks = createUpdateChecks({
    intervalMs: 1_000_000,
    retryMs: 100,
    check: async (id) => {
      calls.push(id);
      const states = script[id] ?? ["up-to-date"];
      const asked = calls.filter((call) => call === id).length;
      return { ...okStatus(id), state: states[Math.min(asked - 1, states.length - 1)] };
    },
    ...options
  });
  return { checks, calls };
}
const askedOf = (calls, id) => calls.filter((call) => call === id).length;

test("a failed first answer is asked again once, retryMs later, and the better answer replaces it", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ hermes: ["failed", "up-to-date"] });
  checks.start();
  await settle();
  assert.equal(calls.length, 5);
  assert.equal(checks.list().find((row) => row.agentId === "hermes").state, "failed", "the first answer stands for now");

  t.mock.timers.tick(99);
  await settle();
  assert.equal(calls.length, 5, "not before retryMs");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 6);
  assert.equal(calls[5], "hermes");
  assert.equal(checks.list().find((row) => row.agentId === "hermes").state, "up-to-date", "corrected");
  checks.stop();
});

test("only the agents whose rows failed are asked again", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ claude: ["failed", "up-to-date"], openclaw: ["failed", "up-to-date"], codex: ["unknown"] });
  checks.start();
  await settle();
  assert.equal(calls.length, 5);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(calls.slice(5).sort(), ["claude", "openclaw"], "not the ones that answered, 'unknown' included");
  assert.equal(checks.list().filter((row) => row.state === "failed").length, 0);
  checks.stop();
});

test("when nothing failed there is no retry at all (unknown and not-installed rows are answers, not failures)", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ cursor: ["unknown"], codex: ["not-installed"], claude: ["available"] });
  checks.start();
  await settle();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls.length, 5);
  checks.stop();
});

test("an agent that fails twice is asked exactly twice until the next interval; the retry schedules no retry of its own", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ codex: ["failed"] });
  checks.start();
  await settle();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(askedOf(calls, "codex"), 2, "the first answer and the one retry");
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(askedOf(calls, "codex"), 2, "no third try");

  // The next 24-hour round (here 1,000,000 ms) is a round like the first: it asks, and a failure then has its own retry.
  t.mock.timers.tick(1_000_000 - 100 - 10_000);
  await settle();
  assert.equal(askedOf(calls, "codex"), 3);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(askedOf(calls, "codex"), 4);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(askedOf(calls, "codex"), 4);
  checks.stop();
});

test("stop() before the retry timer fires means no retry; start() works again afterwards", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ codex: ["failed"] });
  checks.start();
  await settle();
  checks.stop();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls.length, 5, "the retry timer was cleared");

  checks.start();
  await settle();
  assert.equal(calls.length, 10, "a new start is a new round");
  t.mock.timers.tick(100);
  await settle();
  assert.equal(askedOf(calls, "codex"), 3, "and has its own retry");
  checks.stop();
});

test("a Hermes whose folder check said no_checkout is asked again, and only Hermes", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const answers = [NO_CHECKOUT, CLEAN];
  let cleanCalls = 0;
  const { checks, calls } = scriptedChecks({}, { cleanCheck: async () => answers[Math.min(cleanCalls++, answers.length - 1)] });
  checks.start();
  await settle();
  assert.equal(calls.length, 5);
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: ["no_checkout"] });
  assert.equal(checks.list().find((row) => row.agentId === "hermes").state, "up-to-date", "its row is no failure; the folder check is what is wrong");

  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(calls.slice(5), ["hermes"]);
  assert.equal(cleanCalls, 2);
  assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] }, "the second answer replaced the first");
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(cleanCalls, 2, "and a good answer is the end of it");
  checks.stop();
});

test("a Hermes that is not installed is no reason to ask again, whatever its folder check said", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  for (const answer of [NO_CHECKOUT, DIRTY]) {
    let cleanCalls = 0;
    const { checks, calls } = scriptedChecks({ hermes: ["not-installed"] }, { cleanCheck: async () => (cleanCalls++, answer) });
    checks.start();
    await settle();
    t.mock.timers.tick(10_000);
    await settle();
    assert.equal(calls.length, 5);
    assert.equal(cleanCalls, 1, JSON.stringify(answer.reasons));
    checks.stop();
  }
});

// ---- the retry covers every not-clean Hermes answer (SP5 E2 round 1, Minor 4) -----------------------------------
// A cold `hermes config get` cut by its time limit reads as custom_channel, and slow git calls read as other reasons: with a
// good version row nothing would be asked again, and a wrong reason would stand for 24 hours.

test("a custom_channel answer from a cold start is asked again, and the clean answer replaces it", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const wrong = { clean: false, checkout: "/home/me/.hermes/hermes-agent", reasons: ["custom_channel"] };
  const answers = [wrong, CLEAN];
  let cleanCalls = 0;
  const { checks, calls } = scriptedChecks({}, { cleanCheck: async () => answers[Math.min(cleanCalls++, answers.length - 1)] });
  checks.start();
  await settle();
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: ["custom_channel"] });
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(calls.slice(5), ["hermes"], "only Hermes is asked again");
  assert.equal(cleanCalls, 2);
  assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] });
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(cleanCalls, 2, "and a clean answer is the end of it");
  checks.stop();
});

test("a copy that stays not clean is asked exactly once more, until the next interval", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  let cleanCalls = 0;
  const { checks, calls } = scriptedChecks({}, { cleanCheck: async () => (cleanCalls++, DIRTY) });
  checks.start();
  await settle();
  assert.equal(cleanCalls, 1);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(cleanCalls, 2, "one extra read-only check");
  assert.deepEqual(calls.slice(5), ["hermes"]);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(cleanCalls, 2, "the retry schedules no retry");
  // The next interval's round is a round like the first.
  t.mock.timers.tick(1_000_000 - 100 - 10_000);
  await settle();
  assert.equal(cleanCalls, 3);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(cleanCalls, 4);
  checks.stop();
});

test("with no clean check given nothing extra is asked for Hermes (its answer stays 'not checked yet')", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({});
  checks.start();
  await settle();
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: [] });
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls.length, 5);
  checks.stop();
});

test("a clean Hermes answer, and a Hermes whose round was skipped, schedule no retry for the folder check", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  let cleanCalls = 0;
  const good = scriptedChecks({}, { cleanCheck: async () => (cleanCalls++, CLEAN) });
  good.checks.start();
  await settle();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(good.calls.length, 5);
  assert.equal(cleanCalls, 1);
  good.checks.stop();

  // Hermes is updating during the round: it is skipped, has no row and no answer, so there is nothing to ask again.
  let skippedClean = 0;
  const skipped = scriptedChecks({}, { cleanCheck: async () => (skippedClean++, DIRTY), isUpdating: (id) => id === "hermes" });
  skipped.checks.start();
  await settle();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(skipped.calls.length, 4);
  assert.equal(skippedClean, 0);
  skipped.checks.stop();
});

test("an agent that is updating when the retry fires is skipped, and keeps its saved row", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const updating = new Set();
  const { checks, calls } = scriptedChecks({ codex: ["failed", "up-to-date"], claude: ["failed", "up-to-date"] }, { isUpdating: (id) => updating.has(id) });
  checks.start();
  await settle();
  updating.add("codex"); // its update began after the first answer
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(calls.slice(5), ["claude"], "codex is skipped, claude is asked");
  const rows = Object.fromEntries(checks.list().map((row) => [row.agentId, row.state]));
  assert.equal(rows.codex, "failed", "the saved row is kept");
  assert.equal(rows.claude, "up-to-date");
  checks.stop();
});

test("a person's check and the check after an update schedule no retry", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ codex: ["failed"] }, { cleanCheck: async () => NO_CHECKOUT });
  await checks.refresh();
  await checks.refresh("codex");
  await checks.refresh("codex", { afterChange: true });
  await checks.refresh("hermes");
  const before = calls.length;
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls.length, before, "nothing was asked again by itself");
  checks.stop();
});

test("the default wait before the retry is 60 seconds", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ codex: ["failed", "up-to-date"] }, { retryMs: undefined });
  checks.start();
  await settle();
  t.mock.timers.tick(59_999);
  await settle();
  assert.equal(calls.length, 5);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(askedOf(calls, "codex"), 2);
  checks.stop();
});

test("the 24-hour timer's round retries its failures too", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const { checks, calls } = scriptedChecks({ claude: ["up-to-date", "failed", "up-to-date"] }, { intervalMs: 5000 });
  checks.start();
  await settle();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(calls.length, 5, "round one went well: nothing to retry");
  t.mock.timers.tick(4900);
  await settle();
  assert.equal(askedOf(calls, "claude"), 2, "the interval's round");
  t.mock.timers.tick(100);
  await settle();
  assert.equal(askedOf(calls, "claude"), 3, "and its retry");
  assert.equal(checks.list().find((row) => row.agentId === "claude").state, "up-to-date");
  checks.stop();
});

test("a round that ends after the checks were switched off schedules no retry", async (t) => {
  t.mock.timers.enable(MOCK_CLOCK);
  const calls = [];
  const releases = [];
  const checks = createUpdateChecks({
    intervalMs: 1_000_000,
    retryMs: 100,
    check: (id) =>
      new Promise((resolve) => {
        calls.push(id);
        releases.push(() => resolve({ ...okStatus(id), state: "failed" }));
      })
  });
  checks.start();
  await settle();
  assert.equal(calls.length, 5);
  await withEnv({ AGENT_OS_UPDATE_CHECKS: "0", AGENT_OS_PACKAGED: undefined, AGENT_OS_DEV_ORIGIN: undefined }, async () => {
    for (const release of releases) release();
    await settle();
    t.mock.timers.tick(10_000);
    await settle();
  });
  assert.equal(calls.length, 5, "all five failed, and none was asked again");
  checks.stop();
});

test("the retry timer never keeps the server running: a process with a failed check and a 30-second retry ends at once", POSIX_ONLY, async () => {
  const source = `
    process.env.AGENT_OS_UPDATE_CHECKS = "1";
    const { createUpdateChecks } = await import(${JSON.stringify(new URL("../server/runtime/updates/checks.js", import.meta.url).href)});
    const failed = (agentId) => ({ agentId, installed: null, latest: null, state: "failed", checkedAt: new Date().toISOString() });
    const checks = createUpdateChecks({ retryMs: 30000, check: async (id) => failed(id) });
    checks.start();
    await checks.refresh();
    console.log("round-ended");
  `;
  const started = Date.now();
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("exit", () => resolve(out));
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
  });
  assert.match(output, /round-ended/);
  assert.ok(Date.now() - started < 15_000, "the process left long before the 30 s retry");
});

// ---- no check during shutdown (SP5 E1, L35) ---------------------------------------------------------------

test("after stop() no check starts: refresh(), the refresh an update asks for and the timer do nothing; start() works again", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls = [];
  let cleanCalls = 0;
  const checks = createUpdateChecks({
    intervalMs: 1000,
    check: async (id) => {
      calls.push(id);
      return okStatus(id);
    },
    cleanCheck: async () => {
      cleanCalls += 1;
      return CLEAN;
    }
  });
  assert.equal(checks.isStopped(), false);
  checks.start();
  await settle();
  assert.equal(calls.length, 5);
  const before = checks.list();

  checks.stop();
  assert.equal(checks.isStopped(), true);
  assert.deepEqual(await checks.refresh(), before, "the list as it was");
  assert.deepEqual(await checks.refresh("claude"), before);
  assert.deepEqual(await checks.refresh("hermes", { afterChange: true }), before, "also the check an update asks for");
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls.length, 5, "nothing was checked after stop()");
  assert.equal(cleanCalls, 1);

  // A person's click on Update is not a background check and still asks its own question (the server is not quitting for it).
  assert.deepEqual(await checks.refreshHermesClean(), CLEAN);

  checks.start();
  await settle();
  assert.equal(checks.isStopped(), false, "starting again lifts it");
  assert.equal(calls.length, 10);
  checks.stop();
});

// ---- the Hermes clean answer, cached next to the version checks -----------------------------------------

const CLEAN = { clean: true, checkout: "/home/me/.hermes/hermes-agent", reasons: [] };
const DIRTY = { clean: false, checkout: "/home/me/.hermes/hermes-agent", reasons: ["dirty_tree", "custom_channel"] };

test("hermesClean(): not clean, with no reasons, until a check has run; with no cleanCheck it stays that way and runs nothing", async () => {
  const checks = createUpdateChecks({ check: async (id) => okStatus(id) });
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: [] });
  await checks.refresh();
  await checks.refresh("hermes");
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: [] });
  assert.deepEqual(await checks.refreshHermesClean(), { clean: false, checkout: null, reasons: [] });
});

test("hermesClean(): refresh() and refresh('hermes') compute it with the version checks; another agent's refresh does not", async () => {
  const answers = [CLEAN, DIRTY, CLEAN];
  let calls = 0;
  const checks = createUpdateChecks({
    check: async (id) => okStatus(id),
    cleanCheck: async () => answers[calls++]
  });
  await checks.refresh("claude");
  assert.equal(calls, 0, "claude's refresh leaves the Hermes answer alone");
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: [] });

  await checks.refresh();
  assert.equal(calls, 1);
  assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] }, "the cache holds the answer without the checkout path");

  await checks.refresh("hermes");
  assert.equal(calls, 2);
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: ["dirty_tree", "custom_channel"] });

  await checks.refresh("gemini"); // an unknown agent checks nothing
  assert.equal(calls, 2);

  // The cache hands out copies.
  checks.hermesClean().reasons.push("x");
  assert.deepEqual(checks.hermesClean().reasons, ["dirty_tree", "custom_channel"]);
});

test("refreshHermesClean() answers with the fresh check including the checkout, and stores it", async () => {
  const checks = createUpdateChecks({ check: async (id) => okStatus(id), cleanCheck: async () => CLEAN });
  assert.deepEqual(await checks.refreshHermesClean(), CLEAN);
  assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] });
});

test("a clean check that throws is not clean (fails closed), and keeps the others going", async () => {
  const checks = createUpdateChecks({
    check: async (id) => okStatus(id),
    cleanCheck: async () => {
      throw new Error("boom");
    }
  });
  const statuses = await checks.refresh();
  assert.equal(statuses.length, 5);
  assert.deepEqual(checks.hermesClean(), { clean: false, reasons: [] });
  assert.deepEqual(await checks.refreshHermesClean(), { clean: false, checkout: null, reasons: [] });
});

test("overlapping clean checks: the one that started last is kept", async () => {
  const releases = [];
  const checks = createUpdateChecks({
    check: async (id) => okStatus(id),
    cleanCheck: () => new Promise((resolve) => releases.push(resolve))
  });
  const first = checks.refreshHermesClean();
  await settle();
  const second = checks.refreshHermesClean();
  await settle();
  releases[1](CLEAN);
  await second;
  releases[0](DIRTY);
  await first;
  assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] }, "the older answer was dropped");
});

test("start() computes the Hermes clean answer once at once and again every interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const checks = createUpdateChecks({
    intervalMs: 1000,
    check: async (id) => okStatus(id),
    cleanCheck: async () => (++calls === 1 ? DIRTY : CLEAN)
  });
  checks.start();
  await settle();
  assert.equal(calls, 1);
  assert.equal(checks.hermesClean().clean, false);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls, 2);
  assert.equal(checks.hermesClean().clean, true);
  checks.stop();
});

// ---- where the checks may run (SP5 V3, fix round 1) -----------------------------------------------------

test("updateChecksEnabled(): AGENT_OS_UPDATE_CHECKS=1 turns the checks on; the desktop app and npm run dev do unless it is 0; nothing else does", () => {
  const on = [
    { AGENT_OS_UPDATE_CHECKS: "1" },
    { AGENT_OS_UPDATE_CHECKS: "1", AGENT_OS_PACKAGED: "0" },
    { AGENT_OS_PACKAGED: "1" },
    { AGENT_OS_DEV_ORIGIN: "1" },
    { AGENT_OS_PACKAGED: "1", AGENT_OS_DEV_ORIGIN: "1" },
    { AGENT_OS_PACKAGED: "1", AGENT_OS_UPDATE_CHECKS: "yes" }
  ];
  const off = [
    {},
    { AGENT_OS_UPDATE_CHECKS: "0" },
    { AGENT_OS_UPDATE_CHECKS: "true" },
    { AGENT_OS_UPDATE_CHECKS: "yes" },
    { AGENT_OS_PACKAGED: "0" },
    { AGENT_OS_PACKAGED: "true" },
    { AGENT_OS_DEV_ORIGIN: "true" },
    { AGENT_OS_PACKAGED: "1", AGENT_OS_UPDATE_CHECKS: "0" },
    { AGENT_OS_DEV_ORIGIN: "1", AGENT_OS_UPDATE_CHECKS: "0" },
    { NODE_ENV: "development", PATH: "/usr/bin" }
  ];
  for (const env of on) assert.equal(updateChecksEnabled(env), true, JSON.stringify(env));
  for (const env of off) assert.equal(updateChecksEnabled(env), false, JSON.stringify(env));
});

test("updateChecksEnabled() reads the process environment when it is given none", async () => {
  await withEnv({ AGENT_OS_UPDATE_CHECKS: undefined, AGENT_OS_PACKAGED: undefined, AGENT_OS_DEV_ORIGIN: undefined }, () => {
    assert.equal(updateChecksEnabled(), false);
  });
  await withEnv({ AGENT_OS_UPDATE_CHECKS: undefined, AGENT_OS_PACKAGED: undefined, AGENT_OS_DEV_ORIGIN: "1" }, () => {
    assert.equal(updateChecksEnabled(), true);
  });
});

test("checks that are not enabled do nothing: no check, no clean check, no timer; the list and the Hermes answer stay as they were", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls = [];
  let cleanCalls = 0;
  const checks = createUpdateChecks({
    intervalMs: 1000,
    check: async (id) => {
      calls.push(id);
      return okStatus(id);
    },
    cleanCheck: async () => {
      cleanCalls += 1;
      return CLEAN;
    }
  });
  // Enabled (this file's setting): the round runs and fills the list.
  await checks.refresh();
  const before = checks.list();
  assert.equal(before.length, 5);
  assert.equal(cleanCalls, 1);
  assert.equal(calls.length, 5);

  await withEnv({ AGENT_OS_UPDATE_CHECKS: "0", AGENT_OS_PACKAGED: undefined, AGENT_OS_DEV_ORIGIN: undefined }, async () => {
    assert.deepEqual(await checks.refresh(), before, "the list as it was");
    assert.deepEqual(await checks.refresh("claude"), before);
    assert.deepEqual(checks.hermesClean(), { clean: true, reasons: [] }, "and so is the Hermes answer");
    checks.start();
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(calls.length, 5, "no check ran, not at start and not on the interval");
    assert.equal(cleanCalls, 1);
  });

  // A server that was not enabled at start keeps no timer: turning it on later starts nothing by itself.
  const fresh = createUpdateChecks({ intervalMs: 1000, check: async (id) => (calls.push(`fresh-${id}`), okStatus(id)) });
  await withEnv({ AGENT_OS_UPDATE_CHECKS: undefined, AGENT_OS_PACKAGED: undefined, AGENT_OS_DEV_ORIGIN: undefined }, async () => {
    fresh.start();
    await settle();
  });
  t.mock.timers.tick(5000);
  await settle();
  assert.ok(!calls.some((call) => String(call).startsWith("fresh-")), "start() while not enabled set no timer");
  assert.deepEqual(fresh.list(), []);

  // Enabled again, the same service works.
  await checks.refresh("codex");
  assert.equal(calls.filter((id) => id === "codex").length, 2);

  // (Stopped last: since SP5 E1 a stopped service starts no check at all.)
  fresh.stop();
  checks.stop();
});

test("a click is not a background check: refreshHermesClean() asks the clean check even where the checks are not enabled", async () => {
  let cleanCalls = 0;
  const checks = createUpdateChecks({
    check: async (id) => okStatus(id),
    cleanCheck: async () => {
      cleanCalls += 1;
      return CLEAN;
    }
  });
  await withEnv({ AGENT_OS_UPDATE_CHECKS: "0", AGENT_OS_PACKAGED: undefined, AGENT_OS_DEV_ORIGIN: undefined }, async () => {
    assert.deepEqual(await checks.refreshHermesClean(), CLEAN);
  });
  assert.equal(cleanCalls, 1);
});

// ---- the folder policy on the checkout (SP5 V3, fix round 1) ---------------------------------------------

test("hermesCleanForUpdate(): a clean checkout in an allowed folder stays clean; outside the home folder, inside Agent OS's own folder or the home folder itself it is folder_refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-os-offer-folder-"));
  try {
    const dir = await realpath(root);
    const home = path.join(dir, "home");
    const agentOsHome = path.join(dir, "agent-os-data");
    const allowed = path.join(home, ".hermes", "hermes-agent");
    const outside = path.join(dir, "elsewhere", "hermes-agent");
    const insideAgentOs = path.join(agentOsHome, "inner");
    for (const folder of [allowed, outside, insideAgentOs]) await mkdir(folder, { recursive: true });
    await withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
        HERMES_AGENT_OS_HOME: undefined
      },
      async () => {
        const at = (checkout, extra = {}) => hermesCleanForUpdate({ check: async () => ({ clean: true, checkout, reasons: [], ...extra }) });
        assert.deepEqual(await at(allowed), { clean: true, checkout: allowed, reasons: [] });
        for (const refused of [outside, insideAgentOs, home, path.join(dir, "does-not-exist")]) {
          assert.deepEqual(await at(refused), { clean: false, checkout: refused, reasons: ["folder_refused"] }, refused);
        }
        // Another finding stays first; the folder is named after the others.
        const dirty = await hermesCleanForUpdate({ check: async () => ({ clean: false, checkout: outside, reasons: ["dirty_tree"] }) });
        assert.deepEqual(dirty, { clean: false, checkout: outside, reasons: ["dirty_tree", "folder_refused"] });
        // With no checkout there is no folder to judge: the answer is passed on as it is.
        const none = { clean: false, checkout: null, reasons: ["no_checkout"] };
        assert.deepEqual(await hermesCleanForUpdate({ check: async () => none }), none);
        // A policy that can't answer counts as a refusal.
        const broken = await hermesCleanForUpdate({
          check: async () => ({ clean: true, checkout: allowed, reasons: [] }),
          checkFolder: async () => {
            throw new Error("boom");
          }
        });
        assert.deepEqual(broken, { clean: false, checkout: allowed, reasons: ["folder_refused"] });
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shared service applies the folder policy: a clean copy outside the places Agent OS may work is cached as not clean, folder_refused", async () => {
  // The shared service's clean check is hermesCleanForUpdate wrapped around hermesCleanCheck; here the same
  // wrapper is given a clean answer for a folder the policy refuses, and read back through a service.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-offer-service-")));
  try {
    const home = path.join(root, "home");
    const outside = path.join(root, "elsewhere");
    await mkdir(home, { recursive: true });
    await mkdir(outside, { recursive: true });
    await withEnv({ HOME: home, USERPROFILE: home, AGENT_OS_HOME: path.join(root, "data"), AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os") }, async () => {
      const checks = createUpdateChecks({
        check: async (id) => okStatus(id),
        cleanCheck: () => hermesCleanForUpdate({ check: async () => ({ clean: true, checkout: outside, reasons: [] }) })
      });
      await checks.refresh("hermes");
      assert.deepEqual(checks.hermesClean(), { clean: false, reasons: ["folder_refused"] });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getUpdateChecks() is one service for the whole server", () => {
  const first = getUpdateChecks();
  assert.equal(getUpdateChecks(), first);
  assert.deepEqual(Object.keys(first).sort(), ["hermesClean", "isStopped", "list", "refresh", "refreshHermesClean", "start", "stop"]);
});
