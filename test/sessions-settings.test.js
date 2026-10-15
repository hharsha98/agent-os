// Sessions, the stored session settings (spec "Browser terminal", H4) and the
// session form of Claude Code's settings file (planning decision Q9: no
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB for a session; headless runs keep it).
// Temp AGENT_OS_HOME only; nothing here starts anything.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildClaudeSettings } from "../server/runtime/builders/brain-launch.js";
import { readSessionSettings, writeSessionSettings } from "../server/runtime/sessions/settings.js";

const isWindows = process.platform === "win32";
const LOCAL_BRAIN = {
  mode: "local",
  model: "qwen3-coder:30b",
  local: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3-coder:30b-64k" }
};
const OPENROUTER_BRAIN = { mode: "openrouter", model: "anthropic/claude-sonnet-4.6" };

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

async function withRuntimeHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-session-settings-"));
  try {
    return await withEnv({ AGENT_OS_HOME: home, HERMES_AGENT_OS_HOME: undefined }, () => fn(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// =====================================================================
// 1. The stored session settings
// =====================================================================

test("session settings: the fullscreen opt-in is off by default, also when the file is missing or broken", async () => {
  await withRuntimeHome(async (home) => {
    assert.deepEqual(await readSessionSettings(), { claudeFullscreen: false });
    await mkdir(path.join(home, "config"), { recursive: true });
    for (const text of ["{ not json", '{"claudeFullscreen":"yes"}', "[true]", "null"]) {
      await writeFile(path.join(home, "config", "sessions.json"), text);
      assert.deepEqual(await readSessionSettings(), { claudeFullscreen: false }, text);
    }
  });
});

test("session settings: only claudeFullscreen, as true or false, is written; the file is private (0600)", async () => {
  await withRuntimeHome(async (home) => {
    const file = path.join(home, "config", "sessions.json");
    assert.deepEqual(await writeSessionSettings({ claudeFullscreen: true }), { claudeFullscreen: true });
    assert.deepEqual(await readSessionSettings(), { claudeFullscreen: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { claudeFullscreen: true });
    if (!isWindows) assert.equal((await stat(file)).mode & 0o777, 0o600);

    const refused = [
      {},
      null,
      [],
      "true",
      { claudeFullscreen: "true" },
      { claudeFullscreen: 1 },
      { claudeFullscreen: true, kittyKeyboard: false },
      { webgl: true },
      // What a JSON request body can hold: own keys named like prototype parts.
      JSON.parse('{"__proto__": {"claudeFullscreen": true}}'),
      JSON.parse('{"constructor": true}')
    ];
    for (const bad of refused) {
      await assert.rejects(
        () => writeSessionSettings(bad),
        (error) => error.status === 400 && error.code === "invalid_settings" && error.message === "Only the Claude Code fullscreen setting (on or off) can be changed here.",
        JSON.stringify(bad)
      );
    }
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { claudeFullscreen: true }, "a refused change writes nothing");
    assert.deepEqual(await writeSessionSettings({ claudeFullscreen: false }), { claudeFullscreen: false });
    assert.deepEqual(await readSessionSettings(), { claudeFullscreen: false });
  });
});

// =====================================================================
// 2. Claude's settings file in its session form (Q9)
// =====================================================================

test("buildClaudeSettings forSession leaves out the env scrub; headless runs keep it", () => {
  const helper = { backend: "file", command: "/usr/bin/true", args: ["print-key"] };
  for (const [brain, keyHelper] of [[LOCAL_BRAIN, null], [OPENROUTER_BRAIN, helper]]) {
    const headless = buildClaudeSettings(brain, keyHelper);
    const session = buildClaudeSettings(brain, keyHelper, { forSession: true });
    assert.equal(headless.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1", `${brain.mode}: headless unchanged`);
    assert.equal("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" in session.env, false, `${brain.mode}: no scrub for a session`);
    const { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: _scrub, ...rest } = headless.env;
    assert.deepEqual(session, { ...headless, env: rest }, `${brain.mode}: everything else is the same`);
  }
});
