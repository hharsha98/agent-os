// Sessions, how each agent starts (spec "Launch profiles", "Resume per agent",
// "Session kinds", harness rules H1-H4, Security 2 and 3; planning decisions
// Q7-Q11). The profile snapshot tests check every agent's argv and environment
// with the SP3 expectations (no hook variables; --settings only with an
// OpenRouter or Local brain) and the SP4 expectations (a hook given: hook
// variables and --settings for Claude Code only), each with the fullscreen
// opt-in off and on; then the
// brains, resume, the update kind, folders, finding the binary, and the H3
// argv check. (The stored settings are tested in sessions-settings.test.js.)
// Nothing here starts an agent: profiles are built, never spawned. Every test
// uses a temp HOME, AGENT_OS_HOME and managed Node folder, a login shell that
// ends in W1's stand-in (FAKE_LOGIN_SHELL, ruling R15: no real shell and no
// startup file is ever read), and the file key store (never the Keychain).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildClaudeSettings, codexBrainArgs } from "../server/runtime/builders/brain-launch.js";
import { helperCommandLine, openRouterKeyHelper, setKeystoreForTest, storeOpenRouterKey } from "../server/runtime/secrets/keystore.js";
import { buildSessionClaudeSettings, claudeHookUrl } from "../server/runtime/sessions/claude-session.js";
import {
  OPENCLAW_FOLDER_HONOURED,
  OPENCLAW_SIGNIN_ACTION,
  SESSION_AGENTS,
  assertSessionArgvSafe,
  buildSessionProfile,
  cursorCreateChat
} from "../server/runtime/sessions/profiles.js";
import { writeSessionSettings } from "../server/runtime/sessions/settings.js";
import { FALLBACK_NOTICE, NESTED_MARKERS, getLoginShellEnv, resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { runtimePaths } from "../server/runtime/store.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const isWindows = process.platform === "win32";
const posixSkip = { skip: isWindows ? "fake login shell, shebang fakes and file modes are POSIX-only" : false };
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const KEY = "sk-or-v1-SESSIONTEST-secret-1234";
const VERSION = "9.9.9-test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Codex's three notification types (ruling R14: plan-mode-prompt is its questions and plan prompts).
const TUI = ["-c", "tui.notification_method=osc9", "-c", 'tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt"]', "-c", "tui.notification_condition=always"];
const BINARIES = { claude: "claude", codex: "codex", cursor: "agent", hermes: "hermes", openclaw: "openclaw" };
// The variables a session may add on top of the login-shell environment (H2),
// plus PWD (the session's folder, as a shell sets it after `cd`).
const ADDED = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "AGENT_OS_SESSION_ID", "PWD"];
const LOCAL_BRAIN = {
  mode: "local",
  model: "qwen3-coder:30b",
  local: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3-coder:30b-64k" }
};
const OPENROUTER_BRAIN = { mode: "openrouter", model: "anthropic/claude-sonnet-4.6" };

// What the person's environment holds before Agent OS touches it. Planted in
// this test process, so it reaches the fake login shell as a server's would.
const PLANTED = {
  AGENT_OS_TOKEN: "secret-session-token",
  AGENT_OS_STATIC_DIR: "/somewhere/dist",
  HERMES_AGENT_OS_ADMIN_TOKEN: "secret-admin-token",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  EDITOR: "vim",
  VISUAL: "code --wait",
  SSH_AUTH_SOCK: "/tmp/agent-os-test-ssh.sock",
  LC_TIME: "en_GB.UTF-8",
  HTTPS_PROXY: "http://proxy.test:3128",
  NO_PROXY: "localhost,127.0.0.1",
  ANTHROPIC_API_KEY: "sk-ant-test-not-real",
  OPENAI_API_KEY: "sk-test-not-real",
  CODEX_HOME: "/nonexistent/codex-home",
  XDG_CONFIG_HOME: "/nonexistent/xdg-config",
  TERM: "dumb",
  TERM_PROGRAM: "vscode",
  COLORTERM: "24bit",
  CLAUDE_CODE_NO_FLICKER: undefined,
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: undefined,
  CLAUDE_CONFIG_DIR: undefined,
  HERMES_HOME: undefined
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

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// A temp world with fake agent binaries (never run as a session, except that
// Cursor's is the fake agent, which answers `create-chat` the way the real one
// does: spike S6), a project folder, and a
// login shell that does what a person's startup files might do (print a
// banner, export variables, put a folder of its own first on PATH) and then
// hands over to W1's stand-in login shell, which runs Agent OS's command with
// /bin/sh and reads no startup file.
async function withProfileEnv(fn, { startupLines = [] } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-profiles-")));
  const ctx = {
    base,
    home: path.join(base, "home"),
    agentOsHome: path.join(base, "agent-os-home"),
    managedRoot: path.join(base, "managed"),
    bin: path.join(base, "bin"),
    loginOnly: path.join(base, "login-only-bin"),
    detected: {}
  };
  ctx.project = path.join(ctx.home, "projects", "app");
  for (const dir of [ctx.project, ctx.agentOsHome, ctx.managedRoot, ctx.bin, ctx.loginOnly]) await mkdir(dir, { recursive: true });
  for (const agentId of SESSION_AGENTS) {
    const file = path.join(ctx.bin, BINARIES[agentId]);
    await writeFile(file, "#!/bin/sh\necho 'fake agent: these tests never start it' >&2\nexit 1\n");
    await chmod(file, 0o755);
    ctx.detected[agentId] = { installed: true, path: file, version: "9.9.9", features: {} };
  }
  // Replaces the stand-in `agent` above: a new Cursor session asks it for a chat id.
  ctx.detected.cursor.path = (await makeFakeAgentBin(ctx.bin, { names: ["agent"] })).paths.agent;
  ctx.shell = path.join(base, "fake-login-shell");
  await writeFile(
    ctx.shell,
    [
      "#!/bin/sh",
      'echo "Good morning from a chatty startup file"',
      'export FROM_STARTUP_FILE="set in a startup file"',
      'export AGENT_OS_FROM_STARTUP="must never reach a session"',
      // A host-only name (F-S7a) that a startup file sets: the login shell
      // reports it, and sessions still remove it.
      'export CLAUDE_CODE_SESSION_ID="set in a startup file"',
      `PATH=${shQuote(ctx.loginOnly)}:"$PATH"`,
      "export PATH",
      ...startupLines,
      `exec ${shQuote(FAKE_LOGIN_SHELL)} "$@"`,
      ""
    ].join("\n")
  );
  await chmod(ctx.shell, 0o755);
  setKeystoreForTest();
  resetLoginShellEnvForTests();
  try {
    return await withEnv(
      {
        ...PLANTED,
        HOME: ctx.home,
        USERPROFILE: ctx.home,
        AGENT_OS_HOME: ctx.agentOsHome,
        HERMES_AGENT_OS_HOME: undefined,
        AGENT_OS_MANAGED_ROOT: ctx.managedRoot,
        AGENT_OS_KEYSTORE: "file",
        SHELL: ctx.shell,
        // The variables that point a shell at startup files (ruling R15).
        ZDOTDIR: undefined,
        ENV: undefined,
        BASH_ENV: undefined,
        // Set by the desktop app and by npm: either would hand the developer's
        // real PATH to the fake login shell (and to Q8's search for a binary).
        AGENT_OS_LAUNCH_PATH: undefined,
        npm_lifecycle_event: undefined,
        PATH: [ctx.bin, ...SYSTEM_PATH_DIRS].join(path.delimiter)
      },
      async () => {
        assert.equal(os.homedir(), ctx.home, "tests must never see the real home folder");
        return await fn(ctx);
      }
    );
  } finally {
    resetLoginShellEnvForTests();
    setKeystoreForTest();
    await rm(base, { recursive: true, force: true });
  }
}

function start(ctx, agentId, extra = {}) {
  return buildSessionProfile({
    agentId,
    folder: ctx.project,
    sessionId: crypto.randomUUID(),
    settings: { claudeFullscreen: false },
    detected: ctx.detected[agentId],
    brain: null,
    agentOsVersion: VERSION,
    ...extra
  });
}

// Security 2 and H1-H4 for one profile's environment against the login shell's.
// `hook` ({ url, token }) is the hook a Claude Code agent session gets from
// SP4; without it no hook variable may appear (SP3, and every other agent).
function assertSessionEnvironment(env, loginEnv, { sessionId, cwd, flicker, where, hook = null }) {
  assert.equal(env.TERM, "xterm-256color", where);
  assert.equal(env.COLORTERM, "truecolor", where);
  assert.equal(env.TERM_PROGRAM, "AgentOS", `${where}: never vscode`);
  assert.equal(env.TERM_PROGRAM_VERSION, VERSION, where);
  assert.equal(env.AGENT_OS_SESSION_ID, sessionId, where);
  assert.equal(env.PWD, cwd, where);
  assert.equal(env.CLAUDE_CODE_NO_FLICKER, flicker ? "1" : undefined, `${where}: NO_FLICKER only with the opt-in, Claude Code only`);
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined, `${where}: never the env scrub`);
  if (hook) {
    assert.equal(env.AGENT_OS_HOOK_URL, hook.url, `${where}: the literal hook URL of this session (SP4)`);
    assert.equal(env.AGENT_OS_HOOK_TOKEN, hook.token, `${where}: this run's hook token (SP4)`);
  } else {
    assert.equal(env.AGENT_OS_HOOK_URL, undefined, `${where}: no hook variables`);
    assert.equal(env.AGENT_OS_HOOK_TOKEN, undefined, `${where}: no hook variables`);
  }
  const hookNames = hook ? ["AGENT_OS_HOOK_URL", "AGENT_OS_HOOK_TOKEN"] : [];
  for (const key of Object.keys(env)) {
    if (key === "AGENT_OS_SESSION_ID" || hookNames.includes(key)) continue;
    assert.ok(!key.startsWith("AGENT_OS_") && !key.startsWith("HERMES_AGENT_OS_"), `${where}: ${key} is removed`);
  }
  for (const marker of NESTED_MARKERS) assert.equal(env[marker], undefined, `${where}: ${marker} is removed`);
  // H1: HOME and the agents' config folders as the person has them.
  assert.equal(env.HOME, loginEnv.HOME, where);
  assert.equal(env.CODEX_HOME, PLANTED.CODEX_HOME, where);
  assert.equal(env.XDG_CONFIG_HOME, PLANTED.XDG_CONFIG_HOME, where);
  for (const key of ["CLAUDE_CONFIG_DIR", "HERMES_HOME"]) assert.equal(env[key], undefined, `${where}: ${key} is never set`);
  assert.ok(!Object.keys(env).some((key) => key.startsWith("OPENCLAW_")), `${where}: no OpenClaw state variable is set`);
  // Everything else from the login shell passes through unchanged...
  for (const [key, value] of Object.entries(loginEnv)) {
    if (key.startsWith("AGENT_OS_") || key.startsWith("HERMES_AGENT_OS_") || NESTED_MARKERS.includes(key)) continue;
    if (ADDED.includes(key) || key === "CLAUDE_CODE_NO_FLICKER") continue;
    assert.equal(env[key], value, `${where}: ${key} passes through unchanged`);
  }
  // ...and nothing else is added.
  for (const key of Object.keys(env)) {
    if (key in loginEnv) continue;
    assert.ok(ADDED.includes(key) || hookNames.includes(key) || (flicker && key === "CLAUDE_CODE_NO_FLICKER"), `${where}: ${key} was added`);
  }
}

// ---- a temp AGENT_OS_HOME only (the argv check reads runtimePaths().sessions) ----

async function withRuntimeHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-os-session-settings-"));
  try {
    return await withEnv({ AGENT_OS_HOME: home, HERMES_AGENT_OS_HOME: undefined }, () => fn(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// =====================================================================
// 1. The profile snapshot (SP3)
// =====================================================================

test("profile snapshot (SP3): every agent's argv and environment, with the fullscreen opt-in off and on", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const login = await getLoginShellEnv();
    assert.equal(login.source, "login-shell");
    assert.equal(login.env.FROM_STARTUP_FILE, "set in a startup file", "the login shell's own settings are used");
    // The test world's PATH only: never the developer's own (AGENT_OS_LAUNCH_PATH, an npm script's folders).
    assert.deepEqual(login.env.PATH.split(path.delimiter), [ctx.loginOnly, ctx.bin, ...SYSTEM_PATH_DIRS], "the login shell started with the test PATH");
    assert.equal(login.env.AGENT_OS_TOKEN, undefined, "Agent OS's token never reaches the login shell");
    // PLANTED makes this server look as if Claude Code started it (F-S7a): the
    // host's names never reach the login shell, so only a startup file can put
    // one back, and sessions remove the host-only ones either way.
    assert.equal(login.env.CLAUDECODE, undefined, "a server started inside another agent does not hand its markers to the login shell");
    assert.equal(login.env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(login.env.CLAUDE_CODE_SESSION_ID, "set in a startup file", "a startup file's own value is reported, and sessions remove it");
    for (const claudeFullscreen of [false, true]) {
      for (const agentId of SESSION_AGENTS) {
        const sessionId = crypto.randomUUID();
        const where = `${agentId}, opt-in ${claudeFullscreen ? "on" : "off"}`;
        const profile = await start(ctx, agentId, { sessionId, settings: { claudeFullscreen } });
        assert.equal(profile.command, ctx.detected[agentId].path, `${where}: the detected binary, never a shell`);
        assert.equal(profile.settingsFile, null, `${where}: no --settings without an OpenRouter or Local brain`);
        assert.equal(profile.claude, null, `${where}: no hook, so no Claude hook details`);
        assert.deepEqual(profile.notes, [], where);
        const expected = {
          claude: { args: ["--session-id", profile.agentSessionId], cwd: ctx.project, softStop: "claude-bg", resumeMode: "id", folderShown: true },
          codex: { args: ["-C", ctx.project, ...TUI], cwd: ctx.project, softStop: null, resumeMode: "fallback", folderShown: true },
          cursor: { args: ["--resume", profile.agentSessionId, "--workspace", ctx.project], cwd: ctx.project, softStop: null, resumeMode: "id", folderShown: true },
          hermes: { args: ["--in", ctx.project], cwd: ctx.project, softStop: null, resumeMode: "fallback", folderShown: true },
          openclaw: { args: ["tui", "--session", `agentos-${sessionId}`], cwd: ctx.home, softStop: "openclaw-abort", resumeMode: "id", folderShown: false }
        }[agentId];
        assert.deepEqual(
          { args: profile.args, cwd: profile.cwd, softStop: profile.softStop, resumeMode: profile.resumeMode, folderShown: profile.folderShown },
          expected,
          where
        );
        if (agentId === "claude" || agentId === "cursor") {
          assert.match(profile.agentSessionId, UUID, `${where}: Claude gets its own --session-id uuid, Cursor the chat id create-chat printed (spike S6)`);
          assert.notEqual(profile.agentSessionId, sessionId, `${where}: separate from Agent OS's session id (Q39)`);
        } else if (agentId === "openclaw") {
          assert.equal(profile.agentSessionId, `agentos-${sessionId}`, where);
        } else {
          assert.equal(profile.agentSessionId, null, `${where}: no id source until its spike`);
        }
        assertSessionEnvironment(profile.env, login.env, {
          sessionId,
          cwd: expected.cwd,
          flicker: agentId === "claude" && claudeFullscreen,
          where
        });
      }
    }
  });
});

// =====================================================================
// 1b. The profile snapshot (SP4, Task X2a)
// =====================================================================

const HOOK_PORT = 43210;
const HOOK_TOKEN = "snapshot-hook-token-0123456789abcdefghijklmnopq";

test("profile snapshot (SP4): with a hook, only Claude Code gets the hook variables and --settings with the observe-only hooks; every other agent starts exactly as in SP3; the fullscreen opt-in off and on", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const login = await getLoginShellEnv();
    const hook = { port: HOOK_PORT, token: HOOK_TOKEN };
    const shape = (profile) => ({
      command: profile.command,
      args: profile.args.map((arg) => (arg === profile.agentSessionId ? "<id>" : arg)),
      cwd: profile.cwd,
      softStop: profile.softStop,
      resumeMode: profile.resumeMode,
      folderShown: profile.folderShown,
      settingsFile: profile.settingsFile,
      claude: profile.claude
    });
    for (const claudeFullscreen of [false, true]) {
      for (const agentId of SESSION_AGENTS) {
        const sessionId = crypto.randomUUID();
        const where = `${agentId}, opt-in ${claudeFullscreen ? "on" : "off"}, with a hook`;
        const flicker = agentId === "claude" && claudeFullscreen;
        const sp3 = await start(ctx, agentId, { sessionId, settings: { claudeFullscreen } });
        const sp4 = await start(ctx, agentId, { sessionId, settings: { claudeFullscreen }, hook });
        if (agentId !== "claude") {
          assert.deepEqual(shape(sp4), shape(sp3), `${where}: exactly its SP3 profile`);
          assert.equal(sp4.settingsFile, null, where);
          assert.equal(sp4.claude, null, where);
          assertSessionEnvironment(sp4.env, login.env, { sessionId, cwd: sp4.cwd, flicker, where });
          continue;
        }
        const file = path.join(ctx.agentOsHome, "sessions", sessionId, "claude-settings.json");
        const hookUrl = `http://127.0.0.1:${HOOK_PORT}/hooks/sessions/${sessionId}`;
        assert.deepEqual(sp4.args, ["--session-id", sp4.agentSessionId, "--settings", file], `${where}: --settings is always passed (H3, SP4)`);
        assert.equal(sp4.settingsFile, file);
        assert.deepEqual(sp4.claude, { hookUrl, hooksOff: { alerts: null, meter: null }, statusLineFrom: null });
        const text = await readFile(file, "utf8");
        assert.deepEqual(JSON.parse(text), buildSessionClaudeSettings({ hookUrl }), `${where}: only the observe-only hooks`);
        assert.ok(!text.includes(HOOK_TOKEN), `${where}: the token is never written into the file`);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
        assertSessionEnvironment(sp4.env, login.env, { sessionId, cwd: ctx.project, flicker, where, hook: { url: hookUrl, token: HOOK_TOKEN } });
      }
    }
  });
});

test("profiles (SP4): Claude Code with a hook and an OpenRouter or Local brain writes one file with the hooks and the brain keys, never the key or the token", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    await storeOpenRouterKey(KEY);
    const helper = await openRouterKeyHelper();
    for (const brain of [OPENROUTER_BRAIN, LOCAL_BRAIN]) {
      const sessionId = crypto.randomUUID();
      const profile = await start(ctx, "claude", { sessionId, brain, hook: { port: HOOK_PORT, token: HOOK_TOKEN } });
      const file = path.join(ctx.agentOsHome, "sessions", sessionId, "claude-settings.json");
      assert.deepEqual(profile.args, ["--session-id", profile.agentSessionId, "--settings", file], brain.mode);
      const written = JSON.parse(await readFile(file, "utf8"));
      const brainSettings = buildClaudeSettings(brain, brain.mode === "openrouter" ? helper : null, { forSession: true });
      assert.deepEqual(written, buildSessionClaudeSettings({ hookUrl: claudeHookUrl(HOOK_PORT, sessionId), brainSettings }), brain.mode);
      assert.deepEqual(Object.keys(written), brain.mode === "openrouter" ? ["hooks", "apiKeyHelper", "env"] : ["hooks", "env"]);
      assert.equal("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" in written.env, false);
      const text = JSON.stringify(written);
      assert.ok(!text.includes(KEY), "the key itself is never written");
      assert.ok(!text.includes(HOOK_TOKEN), "the hook token is never written");
    }
  });
});

test("profiles (SP4): a resume with a hook rewrites the settings file for the new port and token; the update and setup kinds never get a hook", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const sessionId = crypto.randomUUID();
    const claudeId = crypto.randomUUID();
    const file = path.join(ctx.agentOsHome, "sessions", sessionId, "claude-settings.json");
    await start(ctx, "claude", { sessionId, hook: { port: 43001, token: HOOK_TOKEN } });
    assert.equal(JSON.parse(await readFile(file, "utf8")).hooks.Stop[0].hooks[0].url, claudeHookUrl(43001, sessionId));
    const nextToken = `${HOOK_TOKEN}-next`;
    const resumed = await start(ctx, "claude", { sessionId, resume: { agentSessionId: claudeId }, hook: { port: 43002, token: nextToken } });
    assert.deepEqual(resumed.args, ["--resume", claudeId, "--settings", file]);
    assert.equal(resumed.env.AGENT_OS_HOOK_URL, claudeHookUrl(43002, sessionId));
    assert.equal(resumed.env.AGENT_OS_HOOK_TOKEN, nextToken);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), buildSessionClaudeSettings({ hookUrl: claudeHookUrl(43002, sessionId) }), "rewritten at every start and resume, never cached (R7)");

    const checkout = path.join(ctx.home, ".hermes", "hermes-agent");
    await mkdir(checkout, { recursive: true });
    const update = await start(ctx, "hermes", { kind: "update", folder: checkout, hook: { port: 43003, token: HOOK_TOKEN } });
    assert.deepEqual([update.args, update.settingsFile, update.claude], [["update"], null, null]);
    assert.equal(update.env.AGENT_OS_HOOK_URL, undefined);
    assert.equal(update.env.AGENT_OS_HOOK_TOKEN, undefined);
    const setup = await start(ctx, "openclaw", { kind: "setup", setupAction: OPENCLAW_SIGNIN_ACTION, hook: { port: 43004, token: HOOK_TOKEN } });
    assert.deepEqual([setup.settingsFile, setup.claude], [null, null]);
    assert.equal(setup.env.AGENT_OS_HOOK_URL, undefined);
    assert.equal(setup.env.AGENT_OS_HOOK_TOKEN, undefined);
  });
});

test("profiles (SP4): a malformed hook is a caller's bug and throws before anything is written", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const malformed = [
      { port: 0, token: HOOK_TOKEN },
      { port: 65536, token: HOOK_TOKEN },
      { port: "43210", token: HOOK_TOKEN },
      { port: 43.5, token: HOOK_TOKEN },
      { port: HOOK_PORT, token: "short" },
      { port: HOOK_PORT, token: `${HOOK_TOKEN} x` },
      { port: HOOK_PORT, token: `${HOOK_TOKEN}\n` },
      { port: HOOK_PORT },
      "43210",
      43210,
      true
    ];
    for (const hook of malformed) {
      for (const agentId of ["claude", "codex"]) {
        const sessionId = crypto.randomUUID();
        await assert.rejects(() => start(ctx, agentId, { sessionId, hook }), TypeError, `${agentId} ${JSON.stringify(hook)}`);
        await assert.rejects(() => stat(path.join(ctx.agentOsHome, "sessions", sessionId)), `${agentId}: nothing written`);
      }
    }
  });
});

test("profiles: the fullscreen opt-in is read from the stored settings at each launch (H4)", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    await writeSessionSettings({ claudeFullscreen: true });
    assert.equal((await start(ctx, "claude", { settings: undefined })).env.CLAUDE_CODE_NO_FLICKER, "1");
    assert.equal((await start(ctx, "codex", { settings: undefined })).env.CLAUDE_CODE_NO_FLICKER, undefined);
    await writeSessionSettings({ claudeFullscreen: false });
    assert.equal((await start(ctx, "claude", { settings: undefined })).env.CLAUDE_CODE_NO_FLICKER, undefined);
  });
});

test("profiles: the person's own CLAUDE_CODE_NO_FLICKER stays when the opt-in is off (H4: their setting decides)", posixSkip, async () => {
  await withProfileEnv(
    async (ctx) => {
      assert.equal((await start(ctx, "claude")).env.CLAUDE_CODE_NO_FLICKER, "1");
    },
    { startupLines: ["export CLAUDE_CODE_NO_FLICKER=1"] }
  );
});

test("profiles: when the login shell can't be read, the fallback environment is used and its notice is passed on", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    await withEnv({ SHELL: path.join(ctx.base, "no-such-shell") }, async () => {
      resetLoginShellEnvForTests();
      const profile = await start(ctx, "hermes");
      assert.deepEqual(profile.notes, [FALLBACK_NOTICE]);
      assert.deepEqual(profile.args, ["--in", ctx.project]);
      const parts = profile.env.PATH.split(path.delimiter);
      assert.deepEqual(parts.slice(-3), ["/usr/local/bin", "/opt/homebrew/bin", path.join(ctx.home, ".local", "bin")]);
      assert.equal(profile.env.AGENT_OS_TOKEN, undefined);
      assert.equal(profile.env.CLAUDECODE, undefined);
      assert.equal(profile.env.EDITOR, "vim");
    });
  });
});

// =====================================================================
// 2. Brains, resume, the update kind, folders, finding the binary
// =====================================================================

test("profiles: Claude Code on OpenRouter or Local gets --settings with its own private file, without the env scrub", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    await storeOpenRouterKey(KEY);
    const helper = await openRouterKeyHelper();
    for (const brain of [OPENROUTER_BRAIN, LOCAL_BRAIN]) {
      const sessionId = crypto.randomUUID();
      const profile = await start(ctx, "claude", { sessionId, brain });
      const file = path.join(ctx.agentOsHome, "sessions", sessionId, "claude-settings.json");
      assert.deepEqual(profile.args, ["--session-id", profile.agentSessionId, "--settings", file], brain.mode);
      assert.equal(profile.settingsFile, file);
      const written = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(written, buildClaudeSettings(brain, brain.mode === "openrouter" ? helper : null, { forSession: true }));
      assert.equal("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" in written.env, false);
      assert.ok(!JSON.stringify(written).includes(KEY), "the key itself is never written");
      if (brain.mode === "openrouter") assert.equal(written.apiKeyHelper, helperCommandLine(helper));
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
      assert.equal((await stat(runtimePaths().sessions)).mode & 0o777, 0o700);
      assert.equal(profile.env.ANTHROPIC_MODEL, (await getLoginShellEnv()).env.ANTHROPIC_MODEL, "the brain reaches Claude through the file, not the environment");
    }
    // A plan brain, even with a model, adds nothing (H3 allows no --model).
    const plan = await start(ctx, "claude", { brain: { mode: "plan", model: "opus" } });
    assert.deepEqual(plan.args, ["--session-id", plan.agentSessionId]);
  });
});

test("profiles: Claude Code on OpenRouter without a saved key refuses and writes nothing", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const sessionId = crypto.randomUUID();
    await assert.rejects(() => start(ctx, "claude", { sessionId, brain: OPENROUTER_BRAIN }), (error) => error.code === "openrouter_key_missing");
    await assert.rejects(() => stat(path.join(ctx.agentOsHome, "sessions", sessionId, "claude-settings.json")));
    await assert.rejects(() => stat(path.join(ctx.agentOsHome, "sessions", sessionId)), "not even the session's folder");
  });
});

test("profiles: the Claude settings file replaces an older, looser one with a 0600 file and leaves no temporary file", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const sessionId = crypto.randomUUID();
    const dir = path.join(ctx.agentOsHome, "sessions", sessionId);
    const file = path.join(dir, "claude-settings.json");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "{}\n");
    await chmod(file, 0o644);
    assert.equal((await stat(file)).mode & 0o777, 0o644, "the test starts with a world-readable file");
    const profile = await start(ctx, "claude", { sessionId, brain: LOCAL_BRAIN });
    assert.equal(profile.settingsFile, file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), buildClaudeSettings(LOCAL_BRAIN, null, { forSession: true }));
    assert.deepEqual(await readdir(dir), ["claude-settings.json"], "the temporary name was renamed into place");
  });
});

test("profiles: a command line that assertSessionArgvSafe refuses leaves no settings file or folder behind", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    // A relative AGENT_OS_HOME (pointing at the same temp folder) makes the
    // settings path relative, which the argv check refuses: the profile must
    // fail before it writes anything.
    const relativeHome = path.relative(process.cwd(), ctx.agentOsHome);
    assert.ok(!path.isAbsolute(relativeHome), "the test needs a relative path");
    await withEnv({ AGENT_OS_HOME: relativeHome }, async () => {
      await assert.rejects(
        () => start(ctx, "claude", { brain: LOCAL_BRAIN }),
        (error) => error.status === 500 && error.code === "unsafe_argv"
      );
    });
    assert.deepEqual(await readdir(ctx.agentOsHome), [], "nothing was created under the Agent OS folder");
  });
});

test("profiles: Codex adds codexBrainArgs for OpenRouter and Local; Cursor never gets a model option", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    await storeOpenRouterKey(KEY);
    const helper = await openRouterKeyHelper();
    const routerBrain = { mode: "openrouter", model: "openai/gpt-5.2" };
    const localBrain = { ...LOCAL_BRAIN, local: { ...LOCAL_BRAIN.local, model: LOCAL_BRAIN.model } };
    const onRouter = await start(ctx, "codex", { brain: routerBrain });
    assert.deepEqual(onRouter.args, ["-C", ctx.project, ...TUI, ...codexBrainArgs(routerBrain, helper, { forSession: true })]);
    assert.ok(!onRouter.args.some((arg) => arg.includes("shell_environment_policy")), "a session leaves Codex's own environment scrub out (Q9b)");
    const onLocal = await start(ctx, "codex", { brain: localBrain });
    assert.deepEqual(onLocal.args, ["-C", ctx.project, ...TUI, "--oss", "--local-provider", "ollama", "-m", "qwen3-coder:30b", "-c", "model_context_window=65536"]);
    const cursor = await start(ctx, "cursor", { brain: { mode: "plan", model: "auto" } });
    assert.deepEqual(cursor.args, ["--resume", cursor.agentSessionId, "--workspace", ctx.project], "the chat id and the folder, no model option (H3)");
  });
});

test("profiles: Codex on OpenRouter without a saved key refuses with openrouter_key_missing, at start and on resume", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const brain = { mode: "openrouter", model: "openai/gpt-5.2" };
    for (const resume of [null, { agentSessionId: null }]) {
      await assert.rejects(() => start(ctx, "codex", { brain, resume }), (error) => error.code === "openrouter_key_missing", JSON.stringify(resume));
    }
  });
});

test("profiles: a Codex resume keeps the brain options (OpenRouter and Local)", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    await storeOpenRouterKey(KEY);
    const helper = await openRouterKeyHelper();
    const routerBrain = { mode: "openrouter", model: "openai/gpt-5.2" };
    const localBrain = { ...LOCAL_BRAIN, local: { ...LOCAL_BRAIN.local, model: LOCAL_BRAIN.model } };
    const onRouter = await start(ctx, "codex", { brain: routerBrain, resume: { agentSessionId: null } });
    assert.deepEqual(onRouter.args, ["resume", "--last", ...TUI, ...codexBrainArgs(routerBrain, helper, { forSession: true })]);
    assert.equal(onRouter.resumeMode, "fallback");
    const onLocal = await start(ctx, "codex", { brain: localBrain, resume: { agentSessionId: null } });
    assert.deepEqual(onLocal.args, ["resume", "--last", ...TUI, "--oss", "--local-provider", "ollama", "-m", "qwen3-coder:30b", "-c", "model_context_window=65536"]);
  });
});

test("codexBrainArgs: headless runs keep Codex's own environment scrub; a session leaves it out and the argv check refuses it (Q9b)", () => {
  const router = { mode: "openrouter", model: "openai/gpt-5.2" };
  const helper = { command: "/usr/bin/security", args: ["find-generic-password", "-w"] };
  const policy = "shell_environment_policy.ignore_default_excludes=false";
  const headless = codexBrainArgs(router, helper);
  const session = codexBrainArgs(router, helper, { forSession: true });
  const at = headless.indexOf(policy);
  assert.ok(at > 0 && headless[at - 1] === "-c", "headless (no option, or an empty one) still carries the item");
  assert.deepEqual(codexBrainArgs(router, helper, {}), headless);
  assert.equal(session.includes(policy), false);
  assert.deepEqual([...headless.slice(0, at - 1), ...headless.slice(at + 1)], session, "everything else is identical, and the key still comes through the auth command");
  const local = { ...LOCAL_BRAIN, local: { ...LOCAL_BRAIN.local, model: LOCAL_BRAIN.model } };
  assert.deepEqual(codexBrainArgs(local, null, { forSession: true }), codexBrainArgs(local, null), "Local has no such item either way");
  // A session's argv check allows the session form and refuses the item.
  const folder = path.resolve("/Users/someone/projects/app");
  assert.doesNotThrow(() => assertSessionArgvSafe("codex", ["-C", folder, ...TUI, ...session]));
  for (const extra of [headless, ["-c", policy]]) {
    assert.throws(
      () => assertSessionArgvSafe("codex", ["-C", folder, ...TUI, ...extra]),
      (error) => error.status === 500 && error.code === "unsafe_argv"
    );
  }
});

test("profiles: resume argv per agent (Claude and Cursor by their ids; Hermes and Codex by the fallback; OpenClaw by its key)", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const sessionId = crypto.randomUUID();
    const claudeId = crypto.randomUUID();
    const resume = (agentId, agentSessionId = null) => start(ctx, agentId, { sessionId, resume: { agentSessionId } });

    const claude = await resume("claude", claudeId);
    assert.deepEqual([claude.args, claude.agentSessionId, claude.resumeMode], [["--resume", claudeId], claudeId, "id"]);
    const codex = await resume("codex");
    assert.deepEqual([codex.args, codex.cwd, codex.resumeMode], [["resume", "--last", ...TUI], ctx.project, "fallback"]);
    // Cursor (spike S6): the chat id kept from the first start opens that chat; a session saved before create-chat has none and keeps the picker.
    const chatId = crypto.randomUUID();
    const cursor = await resume("cursor", chatId);
    assert.deepEqual([cursor.args, cursor.agentSessionId, cursor.resumeMode], [["--resume", chatId, "--workspace", ctx.project], chatId, "id"]);
    const cursorOlder = await resume("cursor");
    assert.deepEqual([cursorOlder.args, cursorOlder.agentSessionId, cursorOlder.resumeMode], [["--resume", "--workspace", ctx.project], null, "fallback"]);
    const hermes = await resume("hermes");
    assert.deepEqual([hermes.args, hermes.resumeMode], [["--resume", "latest", "--in", ctx.project], "fallback"]);
    const openclaw = await resume("openclaw", `agentos-${sessionId}`);
    assert.deepEqual([openclaw.args, openclaw.agentSessionId, openclaw.cwd], [["tui", "--session", `agentos-${sessionId}`], `agentos-${sessionId}`, ctx.home]);

    // Claude resumes with --settings under the same rule as at start.
    await storeOpenRouterKey(KEY);
    const withBrain = await start(ctx, "claude", { sessionId, resume: { agentSessionId: claudeId }, brain: OPENROUTER_BRAIN });
    assert.deepEqual(withBrain.args, ["--resume", claudeId, "--settings", path.join(ctx.agentOsHome, "sessions", sessionId, "claude-settings.json")]);

    for (const bad of [null, "", "not-a-uuid", "../../etc", [claudeId], { id: claudeId }, { toString: () => claudeId }]) {
      await assert.rejects(
        () => resume("claude", bad),
        (error) => error.status === 409 && error.code === "not_resumable" && error.message === "This Claude Code conversation can't be resumed.",
        String(bad)
      );
    }
  });
});

// ---- Cursor's exact chat id (spike S6) ----------------------------------------------------------
// A new Cursor session first runs `agent create-chat` (here the fake agent, which logs each call
// and answers as FAKE_CURSOR_CREATE_CHAT says) and opens on the id it prints, so Cursor's chat
// picker, which lists every project's chats, never opens.

// The fake's log file, inside the test HOME; the fake login shell exports it into every session.
const CHAT_LOG = 'export FAKE_AGENT_LOG="$HOME/fake-agent.log"';

async function createChatCalls(ctx) {
  let text = "";
  try {
    text = await readFile(path.join(ctx.home, "fake-agent.log"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "create-chat");
}

test("profiles: a new Cursor session runs `create-chat` once, in its folder with its environment and no terminal, and opens on the chat it prints (spike S6)", posixSkip, async () => {
  await withProfileEnv(
    async (ctx) => {
      const sessionId = crypto.randomUUID();
      const profile = await start(ctx, "cursor", { sessionId });
      const calls = await createChatCalls(ctx);
      assert.equal(calls.length, 1, "one create-chat call");
      const [call] = calls;
      assert.match(call.id, UUID);
      assert.deepEqual(profile.args, ["--resume", call.id, "--workspace", ctx.project]);
      assert.deepEqual([profile.agentSessionId, profile.resumeMode, profile.softStop, profile.cwd], [call.id, "id", null, ctx.project]);
      assert.deepEqual(profile.notes, [], "nothing to tell the person");
      // Exactly the one argument, in the session's folder, with the session's environment (H1, H2), not on a terminal.
      assert.deepEqual(call.argv, ["create-chat"]);
      assert.equal(call.cwd, ctx.project);
      assert.equal(call.isTTY, false);
      assert.equal(call.env.AGENT_OS_SESSION_ID, sessionId);
      assert.equal(call.env.TERM_PROGRAM, "AgentOS");
      assert.equal(call.env.HOME, ctx.home);
      assert.deepEqual(call.agentOsKeys, ["AGENT_OS_SESSION_ID"], "none of Agent OS's own variables (AGENT_OS_TOKEN, ...)");
      assert.deepEqual(call.hostKeys, [], "none of a host agent's variables (F-S7a)");
      assert.equal(call.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
      assert.equal(call.env.CLAUDE_CONFIG_DIR, undefined);
      assert.equal(call.env.HERMES_HOME, undefined);
      // Another session gets another chat.
      const second = await start(ctx, "cursor");
      assert.notEqual(second.agentSessionId, profile.agentSessionId);
      assert.equal((await createChatCalls(ctx)).length, 2);
    },
    { startupLines: [CHAT_LOG] }
  );
});

test("profiles: when `create-chat` fails or prints something else, a new Cursor session starts as before (the picker's fallback), silently (spike S6)", posixSkip, async () => {
  for (const behaviour of ["fail", "garbage"]) {
    await withProfileEnv(
      async (ctx) => {
        const profile = await start(ctx, "cursor");
        assert.deepEqual(
          { args: profile.args, agentSessionId: profile.agentSessionId, resumeMode: profile.resumeMode, cwd: profile.cwd, notes: profile.notes },
          { args: ["--workspace", ctx.project], agentSessionId: null, resumeMode: "fallback", cwd: ctx.project, notes: [] },
          behaviour
        );
        const calls = await createChatCalls(ctx);
        assert.deepEqual(calls.map((call) => call.behaviour), [behaviour], "it did ask once");
        // A later resume of that session has no id, so it keeps the picker's fallback too.
        const resumed = await start(ctx, "cursor", { resume: { agentSessionId: profile.agentSessionId } });
        assert.deepEqual([resumed.args, resumed.resumeMode], [["--resume", "--workspace", ctx.project], "fallback"], behaviour);
      },
      { startupLines: [CHAT_LOG, `export FAKE_CURSOR_CREATE_CHAT=${behaviour}`] }
    );
  }
});

test("profiles: a Cursor resume never asks for a new chat; an id opens that chat, anything that is not a uuid keeps the picker's fallback (spike S6)", posixSkip, async () => {
  await withProfileEnv(
    async (ctx) => {
      const chatId = crypto.randomUUID();
      const withId = await start(ctx, "cursor", { resume: { agentSessionId: chatId } });
      assert.deepEqual([withId.args, withId.agentSessionId, withId.resumeMode], [["--resume", chatId, "--workspace", ctx.project], chatId, "id"]);
      for (const bad of [null, undefined, "", "notauuid", "../../etc", "--workspace", [chatId], { id: chatId }, { toString: () => chatId }, 42]) {
        const profile = await start(ctx, "cursor", { resume: { agentSessionId: bad } });
        assert.deepEqual(
          [profile.args, profile.agentSessionId, profile.resumeMode],
          [["--resume", "--workspace", ctx.project], null, "fallback"],
          String(bad)
        );
      }
      assert.deepEqual(await createChatCalls(ctx), [], "resuming never creates a chat");
    },
    { startupLines: [CHAT_LOG] }
  );
});

test("cursorCreateChat answers the id Cursor prints, or null for any failure, and stops a call that outlives its limit (spike S6)", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const command = ctx.detected.cursor.path;
    const env = (extra = {}) => ({ PATH: SYSTEM_PATH_DIRS.join(path.delimiter), HOME: ctx.home, FAKE_AGENT_LOG: path.join(ctx.home, "fake-agent.log"), ...extra });
    const ask = (extra, options = {}) => cursorCreateChat(command, { cwd: ctx.project, env: env(extra), ...options });

    const id = await ask({});
    assert.match(id, UUID);
    assert.equal((await createChatCalls(ctx))[0].id, id, "the id is what the program printed, trimmed of its newline");
    assert.equal(await ask({ FAKE_CURSOR_CREATE_CHAT: "fail" }), null, "a non-zero exit");
    assert.equal(await ask({ FAKE_CURSOR_CREATE_CHAT: "garbage" }), null, "not a uuid");
    assert.equal(await ask({ FAKE_CURSOR_CREATE_CHAT: "uuid-exit1" }), null, "a good uuid, but the program exited 1");
    assert.equal(await cursorCreateChat(path.join(ctx.base, "no-such-agent"), { cwd: ctx.project, env: env() }), null, "a program that can't start");
    assert.equal(await cursorCreateChat(ctx.project, { cwd: ctx.project, env: env() }), null, "a folder is not a program");

    // A program that does not answer in time is stopped and left behind by nobody. The limit is long
    // enough for the fake to start and log (a loaded machine takes a second); the fake itself waits 30 s.
    const calls = (await createChatCalls(ctx)).length;
    const started = Date.now();
    assert.equal(await ask({ FAKE_CURSOR_CREATE_CHAT: "slow" }, { timeoutMs: 3000 }), null);
    assert.ok(Date.now() - started < 15000, "it gave up at its limit, not after the program's 30 s");
    const slow = (await createChatCalls(ctx)).slice(calls);
    assert.equal(slow.length, 1, "the slow program had started");
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5000;
    while (alive(slow[0].pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(slow[0].pid), false, "the timed-out program was killed");
  });
});

test("profiles: only an object resumes; false, 0, an empty string, true, a string or an array start fresh", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const claudeId = crypto.randomUUID();
    const expected = {
      codex: ["-C", ctx.project, ...TUI],
      hermes: ["--in", ctx.project]
    };
    for (const resume of [false, 0, "", true, 1, "latest", [], [{ agentSessionId: claudeId }]]) {
      const where = JSON.stringify(resume);
      for (const [agentId, args] of Object.entries(expected)) {
        assert.deepEqual((await start(ctx, agentId, { resume })).args, args, `${agentId} with resume ${where}`);
      }
      const claude = await start(ctx, "claude", { resume });
      assert.deepEqual(claude.args, ["--session-id", claude.agentSessionId], `claude with resume ${where}`);
      assert.match(claude.agentSessionId, UUID);
      // Cursor starts a new chat (create-chat), never the chat the odd value names.
      const cursor = await start(ctx, "cursor", { resume });
      assert.deepEqual(cursor.args, ["--resume", cursor.agentSessionId, "--workspace", ctx.project], `cursor with resume ${where}`);
      assert.match(cursor.agentSessionId, UUID);
      assert.notEqual(cursor.agentSessionId, claudeId);
    }
    // An object still resumes, with whatever it holds.
    assert.deepEqual((await start(ctx, "codex", { resume: {} })).args, ["resume", "--last", ...TUI]);
  });
});

test("profiles: the update kind is exactly `hermes update` in the checked folder, for Hermes only", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const checkout = path.join(ctx.home, ".hermes", "hermes-agent");
    await mkdir(checkout, { recursive: true });
    const sessionId = crypto.randomUUID();
    const update = await start(ctx, "hermes", { kind: "update", folder: checkout, sessionId, settings: { claudeFullscreen: true } });
    assert.deepEqual(
      { args: update.args, cwd: update.cwd, softStop: update.softStop, resumeMode: update.resumeMode, agentSessionId: update.agentSessionId, settingsFile: update.settingsFile },
      { args: ["update"], cwd: checkout, softStop: null, resumeMode: null, agentSessionId: null, settingsFile: null }
    );
    assert.equal(update.env.AGENT_OS_SESSION_ID, sessionId);
    assert.equal(update.env.CLAUDE_CODE_NO_FLICKER, undefined);
    const resumed = await start(ctx, "hermes", { kind: "update", folder: checkout, resume: { agentSessionId: null } });
    assert.deepEqual(resumed.args, ["update"], "an update session is never resumed");
    for (const agentId of ["claude", "codex", "cursor", "openclaw"]) {
      await assert.rejects(
        () => start(ctx, agentId, { kind: "update", folder: checkout }),
        (error) => error.status === 400 && error.code === "update_not_available" && error.message === "Only Hermes is updated in a session.",
        agentId
      );
    }
    await assert.rejects(() => start(ctx, "hermes", { kind: "update", folder: ctx.home }), (error) => error.code === "folder_refused");
  });
});

test("profiles: OpenClaw starts in HOME and shows no folder while OPENCLAW_FOLDER_HONOURED is false (spike S5)", posixSkip, async () => {
  assert.equal(OPENCLAW_FOLDER_HONOURED, false);
  await withProfileEnv(async (ctx) => {
    for (const folder of [ctx.project, undefined, null, "not even a path"]) {
      const profile = await start(ctx, "openclaw", { folder });
      assert.equal(profile.cwd, ctx.home);
      assert.equal(profile.folderShown, false);
      assert.equal(profile.env.PWD, ctx.home);
    }
  });
});

test("profiles: a folder outside the policy is refused with its own code and sentence", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const cases = [
      [ctx.home, "is_home", "Your home folder itself can't be used. Pick a folder inside it."],
      [ctx.agentOsHome, "inside_agent_os", "Agent OS's own folder can't be used."],
      [ctx.bin, "outside_home", "Pick a folder inside your home folder."],
      ["projects/app", "not_absolute", "Type the full path, starting with / (or a drive letter on Windows)."],
      [path.join(ctx.home, "missing"), "missing", "That folder doesn't exist."]
    ];
    for (const [folder, folderCode, message] of cases) {
      await assert.rejects(
        () => start(ctx, "codex", { folder }),
        (error) => error.status === 400 && error.code === "folder_refused" && error.extra.code === folderCode && error.message === message,
        folder
      );
    }
    // The profile's folder is the real path (symlinks resolved).
    const link = path.join(ctx.home, "app-link");
    await symlink(ctx.project, link);
    assert.equal((await start(ctx, "hermes", { folder: link })).cwd, ctx.project);
  });
});

test("profiles: when detection finds nothing, the login shell's PATH is searched once more (Q8)", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const notFound = { installed: false, path: "", version: "", features: {} };
    // Only the login shell's own PATH folder holds them now.
    await rm(path.join(ctx.bin, "agent"));
    await rm(path.join(ctx.bin, "hermes"));
    const cursorAgent = path.join(ctx.loginOnly, "cursor-agent");
    await writeFile(cursorAgent, "#!/bin/sh\nexit 1\n");
    await chmod(cursorAgent, 0o755);
    assert.equal((await start(ctx, "cursor", { detected: notFound })).command, cursorAgent);
    await assert.rejects(
      () => start(ctx, "hermes", { detected: notFound }),
      (error) =>
        error.status === 409 &&
        error.code === "agent_not_installed" &&
        error.message === "Hermes isn't installed, or Agent OS can't find it. Install it in Setup, then try again."
    );
  });
});

test("profiles: a node CLI in Agent OS's managed Node folder runs on the Node beside it; others keep the login PATH (Q7)", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    const login = await getLoginShellEnv();
    const nodeCli = async (dir, name) => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "node"), "#!/bin/sh\nexit 1\n");
      await chmod(path.join(dir, "node"), 0o755);
      const file = path.join(dir, name);
      await writeFile(file, "#!/usr/bin/env node\nprocess.exit(1);\n");
      await chmod(file, 0o755);
      return { installed: true, path: file, version: "9.9.9", features: {} };
    };
    const managedBin = path.join(ctx.managedRoot, "node", "bin");
    const managed = await start(ctx, "openclaw", { detected: await nodeCli(managedBin, "openclaw") });
    assert.deepEqual(managed.env.PATH.split(path.delimiter), [managedBin, ...login.env.PATH.split(path.delimiter)]);
    const elsewhere = await start(ctx, "codex", { detected: await nodeCli(path.join(ctx.base, "nvm", "bin"), "codex") });
    assert.equal(elsewhere.env.PATH, login.env.PATH);
  });
});

test("profiles: an unknown agent (prototype names too), a malformed session id or an unknown kind is refused", posixSkip, async () => {
  await withProfileEnv(async (ctx) => {
    for (const agentId of ["gemini", "constructor", "__proto__", "toString", "hasOwnProperty", "", undefined]) {
      await assert.rejects(
        () => start(ctx, agentId, { detected: undefined }),
        (error) => error.status === 400 && error.code === "unknown_agent" && error.message === "Agent OS can't start a session for that agent.",
        String(agentId)
      );
    }
    // Only a string passes: an array or object that prints as a uuid does not.
    const id = crypto.randomUUID();
    for (const sessionId of ["", "../../x", "ABC", "123e4567-e89b-12d3-a456-426614174000", [id], { id }, { toString: () => id }, 42, null, undefined]) {
      await assert.rejects(() => start(ctx, "codex", { sessionId }), (error) => error.status === 404 && error.code === "unknown_session", String(sessionId));
    }
    await assert.rejects(() => start(ctx, "codex", { kind: "shell" }), (error) => error.status === 400 && error.code === "unknown_kind");
  });
});

// =====================================================================
// 3. The H3 argv check
// =====================================================================

test("assertSessionArgvSafe accepts exactly the H3 shapes, and folders whose names look like flags", async () => {
  await withRuntimeHome(async () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const folder = path.resolve("/Users/someone/projects/app");
    const settings = path.join(runtimePaths().sessions, uuid, "claude-settings.json");
    const accepted = [
      ["claude", ["--session-id", uuid]],
      ["claude", ["--session-id", uuid, "--settings", settings]],
      ["claude", ["--resume", uuid, "--settings", settings]],
      ["codex", ["-C", folder, ...TUI]],
      ["codex", ["resume", "--last", ...TUI]],
      ["codex", ["-C", folder, ...TUI, "--oss", "--local-provider", "ollama", "-m", "qwen3-coder:30b", "-c", "model_context_window=65536"]],
      ["codex", ["-C", folder, ...TUI, ...codexBrainArgs({ mode: "openrouter", model: "openai/gpt-5.2" }, { command: "/usr/bin/security", args: ["find-generic-password", "-w"] }, { forSession: true })]],
      ["cursor", ["--workspace", folder]],
      ["cursor", ["--resume", "--workspace", folder]],
      ["cursor", ["--resume", uuid, "--workspace", folder]],
      ["hermes", ["--in", folder]],
      ["hermes", ["--resume", "latest", "--in", folder]],
      ["hermes", ["update"]],
      ["openclaw", ["tui", "--session", `agentos-${uuid}`]]
    ];
    for (const odd of ["--force-demo", "bypassPermissions", "dangerously-fun", "-f"]) {
      const weird = path.resolve(`/Users/someone/${odd}`);
      accepted.push(["codex", ["-C", weird, ...TUI]], ["cursor", ["--workspace", weird]], ["cursor", ["--resume", uuid, "--workspace", weird]], ["hermes", ["--in", weird]]);
    }
    for (const [agentId, args] of accepted) assert.doesNotThrow(() => assertSessionArgvSafe(agentId, args), `${agentId} ${args.join(" ")}`);
  });
});

test("assertSessionArgvSafe refuses anything outside H3: bypass, yolo, trust, MCP and hook options, extra flags", async () => {
  await withRuntimeHome(async () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const folder = path.resolve("/Users/someone/projects/app");
    const refused = [
      ["claude", ["--session-id", uuid, "--dangerously-skip-permissions"]],
      ["claude", ["--session-id", uuid, "--allow-dangerously-skip-permissions"]],
      ["claude", ["--session-id", uuid, "--permission-mode", "bypassPermissions"]],
      ["claude", ["--session-id", uuid, "--bare"]],
      ["claude", ["--session-id", uuid, "--disable-slash-commands"]],
      ["claude", ["--session-id", uuid, "--strict-mcp-config"]],
      ["claude", ["--session-id", uuid, "--mcp-config", "/tmp/mcp.json"]],
      ["claude", ["--session-id", uuid, "--model", "opus"]],
      ["claude", ["--session-id", uuid, "--settings", "/tmp/other-settings.json"]],
      ["claude", ["--session-id", "not-a-uuid"]],
      ["claude", []],
      ["codex", ["-C", folder, "--dangerously-bypass-approvals-and-sandbox"]],
      ["codex", ["-C", folder, "--yolo"]],
      ["codex", ["-C", folder, "--no-alt-screen"]],
      ["codex", ["-C", folder, "--full-auto"]],
      ["codex", ["-C", folder, "-c", 'sandbox_mode="danger-full-access"']],
      ["codex", ["-C", folder, "-c", 'approval_policy="never"']],
      ["codex", ["-C", folder, ...TUI, "-c", "shell_environment_policy.ignore_default_excludes=false"]],
      ["codex", ["-C", "relative/folder", ...TUI]],
      // R14: exactly the three notification types; SP3's two-type list, a wider list and "all" are refused.
      ["codex", ["-C", folder, "-c", "tui.notification_method=osc9", "-c", 'tui.notifications=["agent-turn-complete","approval-requested"]', "-c", "tui.notification_condition=always"]],
      ["codex", ["-C", folder, "-c", "tui.notification_method=osc9", "-c", 'tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","user-input-requested"]', "-c", "tui.notification_condition=always"]],
      ["codex", ["-C", folder, "-c", "tui.notification_method=osc9", "-c", "tui.notifications=true", "-c", "tui.notification_condition=always"]],
      ["codex", ["exec", "-C", folder]],
      ["cursor", ["--workspace", folder, "--force"]],
      ["cursor", ["--workspace", folder, "-f"]],
      ["cursor", ["--workspace", folder, "--trust"]],
      ["cursor", ["--workspace", folder, "--yolo"]],
      ["cursor", ["--workspace", folder, "--model", "auto"]],
      // Spike S6: the chat id must be a uuid, and nothing else may ride along with it.
      ["cursor", ["--resume", "notauuid", "--workspace", folder]],
      ["cursor", ["--resume", "--", "--workspace", folder]],
      ["cursor", ["--resume", uuid]],
      ["cursor", ["--resume", uuid, "--workspace"]],
      ["cursor", ["--resume", uuid, "--workspace", "relative/folder"]],
      ["cursor", ["--resume", uuid, uuid, "--workspace", folder]],
      ["cursor", [uuid, "--workspace", folder]],
      ["cursor", ["--workspace", folder, "--resume", uuid]],
      ["cursor", ["--resume", uuid, "--workspace", folder, "--force"]],
      ["cursor", ["--resume", uuid, "--workspace", folder, "-f"]],
      ["cursor", ["--resume", uuid, "--workspace", folder, "--yolo"]],
      ["cursor", ["--resume", uuid, "--workspace", folder, "--trust"]],
      ["cursor", ["--resume", uuid, "--workspace", folder, "--model", "auto"]],
      ["cursor", ["create-chat"]],
      ["hermes", ["--in", folder, "--tui"]],
      ["hermes", ["--in", folder, "--accept-hooks"]],
      ["hermes", ["--in", folder, "--yolo"]],
      ["hermes", ["update", "--yes"]],
      ["openclaw", ["tui", "--session", "agentos-runs"]],
      ["openclaw", ["chat"]],
      ["openclaw", ["tui", "--session", `agentos-${uuid}`, "--url", "ws://127.0.0.1:1"]],
      ["gemini", ["--help"]],
      ["codex", "-C /tmp"],
      // Prototype names are never agents (ruling R6): no shape is found for them.
      ["constructor", ["--session-id", uuid]],
      ["__proto__", ["--session-id", uuid]],
      ["toString", ["tui", "--session", `agentos-${uuid}`]],
      ["hasOwnProperty", ["--workspace", folder]]
    ];
    for (const [agentId, args] of refused) {
      assert.throws(
        () => assertSessionArgvSafe(agentId, args),
        (error) => error.status === 500 && error.code === "unsafe_argv" && /never adds\.$/.test(error.message),
        `${agentId} ${JSON.stringify(args)}`
      );
    }
    // The sentence names the agent by its short name, or "this agent".
    assert.throws(
      () => assertSessionArgvSafe("cursor", ["--workspace", folder, "--force"]),
      (error) => error.message === "Agent OS stopped Cursor from starting: its command line had an option Agent OS never adds."
    );
    for (const agentId of ["gemini", "constructor", "__proto__", "toString"]) {
      assert.throws(
        () => assertSessionArgvSafe(agentId, ["--session-id", uuid]),
        (error) => error.message === "Agent OS stopped this agent from starting: its command line had an option Agent OS never adds.",
        agentId
      );
    }
  });
});
