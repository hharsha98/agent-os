// The environment of the OpenClaw plan-brains tests (SP3 Task B1b): a real-path
// temp HOME and AGENT_OS_HOME; the fake OpenClaw (test/helpers/fake-openclaw.js)
// and the fake Claude Code (test/helpers/fake-builder-clis.js); W1's fakes for
// the four other agent names, so detection never finds a real one; a 127.0.0.1
// mirror, so the system check never reaches a real host; a PATH of only the fake
// folders plus /usr/bin:/bin:/usr/sbin:/sbin; none of the H1 variables (Safety 4
// checks that no command gets them); and the Setup router in process. Knobs are
// written as files (test/helpers/fake-knobs.js), because the commands Agent OS
// runs through childEnv never see FAKE_* variables. Where a test has no fake
// Claude Code or no fake OpenClaw, refuseSystemAgent stops it first if a real
// one sits in a folder which() always searches. No server process and no
// session is ever started here. This is a helper, not a test file.
import http from "node:http";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { clearDetectCaches } from "../../server/runtime/agents/detect.js";
import { setExecutionGateStatus } from "../../server/runtime/execution-gate.js";
import { getRunManager } from "../../server/runtime/runs/run-manager.js";
import { which } from "../../server/runtime/safety.js";
import { getSetupJob, resetSetupJobsForTest } from "../../server/runtime/setup/jobs.js";
import { createSetupRouter } from "../../server/runtime/setup/routes.js";
import { resetSignInForTest } from "../../server/runtime/setup/signin.js";
import { clearSystemCheckCache } from "../../server/runtime/setup/system-check.js";
import { makeFakeAgentBin } from "./fake-agents.js";
import { installFakeAgent, writeFakeAgentCli } from "./fake-builder-clis.js";
import { fakeSiwcProfile, setFakeKnob, writeFakeAgentState } from "./fake-knobs.js";
import { FAKE_SECRET, installFakeOpenclawShim } from "./fake-openclaw.js";
import { H1_ENV_NAMES } from "./plan-brains-safety.js";

// What `claude auth status` prints for each way Claude Code can be signed in
// (the FAKE_CLAUDE_AUTH_JSON knob). The e-mail and organisation are there so
// tests can prove they never come back.
export const CLAUDE_AUTH = Object.freeze({
  "claude.ai": JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", orgName: "Secret Org" }),
  oauth_token: JSON.stringify({ loggedIn: true, authMethod: "oauth_token", email: "someone@example.com" }),
  api_key: JSON.stringify({ loggedIn: true, authMethod: "api_key" }),
  api_key_helper: JSON.stringify({ loggedIn: true, authMethod: "api_key_helper" }),
  third_party: JSON.stringify({ loggedIn: true, authMethod: "third_party" }),
  no_method: JSON.stringify({ loggedIn: true }),
  signed_out: JSON.stringify({ loggedIn: false, authMethod: "none" })
});

// A signed-in Sign in with ChatGPT row as OpenClaw 2026.10.4 prints it (live
// check S-B3, see fakeSiwcProfile), plus a token value that must never come
// back (the real row has none). `extra` overrides or adds a field.
export function siwcRow(extra = {}) {
  return fakeSiwcProfile({ accessToken: FAKE_SECRET, ...extra });
}

// The older row shape (before 2026.10.4, or a future one): an explicit method
// and token sharing flag instead of the "token-sharing" id.
export function legacySiwcRow(extra = {}) {
  return { provider: "openai", method: "siwc", tokenSharing: true, email: "someone@example.com", accessToken: FAKE_SECRET, ...extra };
}

// which() (server/runtime/safety.js) always searches /opt/homebrew/bin and
// /usr/local/bin as well, whatever PATH says. So once a fake is missing or
// removed, a real claude or openclaw installed there would be found, and Agent
// OS would run it. Call this (inside withPlanEnv) before anything could look
// for that program. It only checks whether such a file can be run; it starts
// nothing.
export async function refuseSystemAgent(name) {
  if (await which(name)) {
    throw new Error(`a system ${name} is installed outside the fake folders; refusing to run this test`);
  }
}

// For a test that deletes the fake program while its other fake folders are
// still on the list (FAKE_OPENCLAW_VANISH_AFTER): which() would find the fake
// itself before then, so this looks only in the folders which() searches
// whatever HOME and PATH say (the system ones). It checks whether such a file
// can be run and starts nothing. Call it inside withPlanEnv, before the program
// can vanish.
export async function refuseSystemAgentFolders(name) {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    try {
      await access(path.join(dir, name), fsConstants.X_OK);
    } catch {
      continue;
    }
    throw new Error(`a system ${name} is installed in ${dir}; refusing to run this test`);
  }
}

export async function withEnv(vars, fn) {
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

async function startRouter() {
  const app = express();
  app.use(express.json());
  app.use("/api/setup", createSetupRouter());
  app.use((error, _req, res, _next) => {
    res.status(error?.status || 500).json({ ok: false, error: error?.message || "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // { status, body (parsed JSON or null), text (the raw answer) }
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Runs fn({ home, agentOsHome, call, knob }) in a fresh plan-brains environment.
//   openclaw  install the fake OpenClaw (default true)
//   claude    a key of CLAUDE_AUTH (the fake Claude Code answers with it), null
//             (installed, today's marker files: signed out), or "missing"
//   version   the FAKE_AGENT_VERSION knob, or null for the fake's own line
//   state     written to $HOME/.fake-agent-state.json ({ primary, models, authRows })
//   execMode  written to $HOME/.fake-openclaw-exec-mode ("" means unset; leave
//             it out for no file, which the fake reads as "full")
export async function withPlanEnv(
  fn,
  { openclaw = true, claude = "claude.ai", version = "OpenClaw 2026.9.7", state = null, execMode } = {}
) {
  if (process.platform === "win32") throw new Error("withPlanEnv: the fakes are POSIX shell shims; skip this test on Windows");
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-plan-home-")));
  const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-plan-runtime-")));
  const fakeBin = path.join(home, ".local", "bin");
  const mirror = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => mirror.listen(0, "127.0.0.1", resolve));
  try {
    await makeFakeAgentBin(fakeBin, { names: ["codex", "agent", "cursor-agent", "hermes"] });
    if (claude !== "missing") await installFakeAgent(home, "claude", await writeFakeAgentCli(path.join(home, ".fake-cli")));
    if (openclaw) await installFakeOpenclawShim(home);
    if (typeof claude === "string" && Object.hasOwn(CLAUDE_AUTH, claude)) await setFakeKnob(home, "FAKE_CLAUDE_AUTH_JSON", CLAUDE_AUTH[claude]);
    if (typeof version === "string") await setFakeKnob(home, "FAKE_AGENT_VERSION", version);
    if (state) await writeFakeAgentState(home, { primary: null, models: null, authRows: [], ...state });
    if (typeof execMode === "string") await writeFile(path.join(home, ".fake-openclaw-exec-mode"), execMode);
    const cleared = Object.fromEntries(
      [...H1_ENV_NAMES, ...Object.keys(process.env).filter((key) => key.startsWith("OPENCLAW_") || key.startsWith("FAKE_"))]
        .filter((name) => name !== "HOME" && name !== "USERPROFILE")
        .map((name) => [name, undefined])
    );
    await withEnv(
      {
        ...cleared,
        HOME: home,
        USERPROFILE: home,
        AGENT_OS_HOME: agentOsHome,
        AGENT_OS_MANAGED_ROOT: path.join(agentOsHome, "managed"),
        AGENT_OS_SETUP_MIRROR: `http://127.0.0.1:${mirror.address().port}`,
        PATH: [fakeBin, path.join(home, ".npm-global", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
        HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
        DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
        HERMES_AGENT_OS_REQUIRE_AUTH: undefined,
        HERMES_AGENT_OS_PUBLIC_MODE: undefined
      },
      async () => {
        if (os.homedir() !== home) throw new Error("withPlanEnv: the tests must never see the real home folder");
        // No fake for this program here, so nothing else may answer to its name.
        if (claude === "missing") await refuseSystemAgent("claude");
        if (!openclaw) await refuseSystemAgent("openclaw");
        clearSystemCheckCache();
        clearDetectCaches();
        resetSetupJobsForTest();
        resetSignInForTest();
        await setExecutionGateStatus({ enabled: true, reason: "plan brains test" });
        const router = await startRouter();
        try {
          await fn({ home, agentOsHome, call: router.call, knob: (name, value) => setFakeKnob(home, name, value) });
        } finally {
          // Even when an assertion fails half way, no fake run is left behind.
          await getRunManager().stopAll();
          await router.close();
        }
      }
    );
  } finally {
    await new Promise((resolve) => mirror.close(resolve));
    // A fake read the server started but did not wait for may still write its line into HOME while it is removed
    // (ENOTEMPTY); rm tries again a few times.
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(agentOsHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export async function waitForPlanJob(id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getSetupJob(id);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`plan job ${id} did not finish within ${timeoutMs} ms`);
}

export async function readJsonLines(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Every call the fake OpenClaw saw: { argv, OPENROUTER_API_KEY, home, setVars }.
export function openclawRecord(home) {
  return readJsonLines(path.join(home, ".fake-openclaw-record.jsonl"));
}

// Every call the fake Claude Code (and the other builder fakes) saw: { kind, args, home, setVars }.
export function agentEnvLog(home) {
  return readJsonLines(path.join(home, ".fake-agent-env.jsonl"));
}

// Every file under dir, as absolute paths.
export async function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}
