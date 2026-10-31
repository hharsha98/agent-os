// SP5 Task V1: the version check service (server/runtime/updates/checks.js).
// A local http server stands in for the npm registry and the fake agent CLIs
// (test/fakes/tui-agent.mjs, through makeFakeAgentBin) stand in for the five
// agents, so no real network and no real agent is ever touched. The fake CLIs
// are POSIX shell shims, so the tests that start them skip on Windows.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
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
const tags = (latest) => ({ json: { latest, next: `${latest}-next` } });

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

test("claude: a newer installed version than the registry's latest (a beta) is up to date, not an update", POSIX_ONLY, async () => {
  await withFakes({ routes: { [CLAUDE_TAGS]: tags("2.1.300") } }, async () => {
    const status = await checkAgent("claude");
    assert.equal(status.state, "up-to-date");
    assert.equal(status.latest, "2.1.300");
  });
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

test("hermes: up to date and behind, read from `hermes update --check`; no version number is claimed", POSIX_ONLY, async () => {
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
    const started = Date.now();
    const statuses = await Promise.all(UPDATE_AGENT_IDS.map((id) => checkAgent(id, { limitMs: 3000 })));
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
  const fastSecond = checks.refresh("claude"); // starts second, finishes first
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
  fresh.stop();
  checks.stop();

  // Enabled again, the same service works.
  await checks.refresh("codex");
  assert.equal(calls.filter((id) => id === "codex").length, 2);
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
  assert.deepEqual(Object.keys(first).sort(), ["hermesClean", "list", "refresh", "refreshHermesClean", "start", "stop"]);
});
