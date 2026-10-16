// The fake OpenClaw CLI of the Setup tests, moved here from test/setup-brain.test.js
// (SP3 Task B1b) so the plan-brains tests can install the same one. It is a
// helper, not a test file: the runner only runs test/*.test.js.
//
// Every call appends one JSON line to $HOME/.fake-openclaw-record.jsonl:
// { argv, OPENROUTER_API_KEY, home, setVars }, where `home` is the HOME it saw
// and `setVars` names which of XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME,
// HERMES_HOME and any OPENCLAW_* variable reached it (spec Safety 4).
//
// Knobs (contract "Fakes and knobs"): FAKE_X is read from the environment, else
// from the trimmed text of $HOME/.fake-knobs/FAKE_X, because the commands Agent
// OS runs through childEnv never see FAKE_* variables.
//   FAKE_AGENT_VERSION          the whole --version line (unset: "openclaw 9.9.9-test")
//   FAKE_OPENCLAW_MODELS_JSON   what `models list --provider <p> --json` prints ("fail": exit 1)
//   FAKE_OPENCLAW_AUTH_JSON     what `models auth list --provider openai --json` prints ("fail": exit 1);
//     unset: the 2026.10.4 answer, { agentDir, agentId, authStatePath, provider: "openai", profiles },
//     where profiles are the state's authRows ([] when signed out)
//   FAKE_OPENCLAW_AUTH_SHAPE    "legacy": with AUTH_JSON unset, answers the older bare array of the authRows instead
//   FAKE_OPENCLAW_STATUS_EXIT   the exit code of `models status --check --plain` (0, 1 or 2; unset 0)
//   FAKE_OPENCLAW_GET_PRIMARY         makes `config get agents.defaults.model.primary` misbehave
//   FAKE_OPENCLAW_GET_MODEL_SETTINGS  makes `config get agents.defaults.models` misbehave
//     both take "timeout" (the program ends killed by SIGTERM, which is the answer
//     runCommand gives for a timeout), "fail" (exit 1) or, for the model settings
//     only, "garbage" (exit 0 and text that isn't JSON); unset: the normal answer
//   FAKE_OPENCLAW_READ_DELAY_MS  milliseconds `config get agents.defaults.model.primary`,
//     `config get agents.defaults.models`, `models auth list` and `onboard --help` wait before they answer; each
//     then adds { argv, startedAt, endedAt } (epoch milliseconds) to $HOME/.fake-openclaw-timing.jsonl,
//     so a test can tell whether two reads overlapped (unset: no wait, no timing line)
//   FAKE_OPENCLAW_VANISH_AFTER  an argv prefix such as "gateway status": the first call that
//     starts with it answers as usual and, as it exits, deletes the program's launcher
//     (<home>/.npm-global/bin/openclaw), so the next call cannot run at all (runCommand's
//     answer for that has a word such as "ENOENT" as its code). Tests that use it call
//     refuseSystemAgentFolders("openclaw") first, because which() would then look in
//     /opt/homebrew/bin and /usr/local/bin. Put the launcher back with installFakeOpenclawShim.
// State: $HOME/.fake-agent-state.json = { primary, models, authRows } (`config get`
// reads it; `onboard` and `models set` write it; authRows are the profile rows
// `models auth list` prints, see fakeSiwcProfile in fake-knobs.js), and tools.exec.mode stays in
// $HOME/.fake-openclaw-exec-mode (missing means "full", empty means unset).
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// The models `onboard --auth-choice anthropic-cli` pins to the claude-cli
// runtime, as 2026.9.6 does for its own list (and no "anthropic/*" entry), so
// tests see both a pinned and an unpinned Claude model.
export const FAKE_CLAUDE_CLI_PINS = Object.freeze(["claude-opus-5-5", "claude-fable-5-1"]);
// Printed by `models status`, and carried by the auth rows tests write, so a
// test can prove the output never reaches a log, a file or an answer.
export const FAKE_SECRET = "SECRET-fake-0000";

export const FAKE_OPENCLAW_CLI_SOURCE = `
import { existsSync, writeFileSync, appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
function print(t) { process.stdout.write(t + "\\n"); }
const H1_NAMES = ["XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME"];
const setVars = Object.keys(process.env).filter((key) => H1_NAMES.includes(key) || key.startsWith("OPENCLAW_")).sort();
try {
  appendFileSync(
    path.join(home, ".fake-openclaw-record.jsonl"),
    JSON.stringify({ argv: args, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || null, home: process.env.HOME || null, setVars }) + "\\n"
  );
} catch {}

function knob(name) {
  if (process.env[name] !== undefined) return process.env[name];
  try { return readFileSync(path.join(home, ".fake-knobs", name), "utf8").trim(); } catch { return undefined; }
}
const startedAt = Date.now();
const readDelayMs = Number(knob("FAKE_OPENCLAW_READ_DELAY_MS") ?? "0") || 0;
async function slowRead() {
  if (!readDelayMs) return;
  await new Promise((resolve) => setTimeout(resolve, readDelayMs));
  try {
    appendFileSync(path.join(home, ".fake-openclaw-timing.jsonl"), JSON.stringify({ argv: args, startedAt, endedAt: Date.now() }) + "\\n");
  } catch {}
}
const vanishAfter = knob("FAKE_OPENCLAW_VANISH_AFTER");
if (vanishAfter && args.join(" ").startsWith(vanishAfter)) {
  process.on("exit", () => { try { unlinkSync(path.join(home, ".npm-global", "bin", "openclaw")); } catch {} });
}
const PINS = ${JSON.stringify(FAKE_CLAUDE_CLI_PINS)};
const SECRET = ${JSON.stringify(FAKE_SECRET)};
const stateFile = path.join(home, ".fake-agent-state.json");
function readState() {
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, "utf8")) || {}; } catch {}
  return {
    primary: typeof state.primary === "string" ? state.primary : null,
    models: state.models && typeof state.models === "object" && !Array.isArray(state.models) ? state.models : null,
    authRows: Array.isArray(state.authRows) ? state.authRows : []
  };
}
function writeState(state) { writeFileSync(stateFile, JSON.stringify(state)); }
const DEFAULT_MODELS = {
  anthropic: [["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-fable-5-1", "Fable 5.1"]],
  openai: [["gpt-6.1-sol", "GPT-6.1 Sol"], ["gpt-6-luna", "GPT-6 Luna"]]
};

const openclawDir = path.join(home, ".openclaw");
const configFile = path.join(openclawDir, "openclaw.json");
const execModeFile = path.join(home, ".fake-openclaw-exec-mode");
const runningMarker = path.join(home, ".fake-openclaw-gateway-running");

if (args.includes("--version")) { print(knob("FAKE_AGENT_VERSION") ?? "openclaw 9.9.9-test"); process.exit(0); }

if (args[0] === "onboard" && args.includes("--help")) {
  await slowRead();
  print(
    "Usage: openclaw onboard [--non-interactive] [--accept-risk] [--auth-choice CHOICE]\\n" +
    "  --openrouter-api-key KEY --custom-base-url URL\\n" +
    "  --skip-health --skip-channels --skip-skills --skip-ui --install-daemon --skip-daemon"
  );
  process.exit(0);
}
if (args[0] === "onboard") {
  if (existsSync(path.join(home, ".fake-openclaw-onboard-fail"))) {
    process.stderr.write("simulated onboard failure\\n");
    process.exit(1);
  }
  if (!args.includes("--non-interactive") || !args.includes("--accept-risk") || !args.includes("--auth-choice")) {
    process.stderr.write("missing required flags\\n");
    process.exit(1);
  }
  mkdirSync(openclawDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify({ onboarded: true }));
  if (args.includes("--install-daemon")) writeFileSync(runningMarker, "1");
  if (args[args.indexOf("--auth-choice") + 1] === "anthropic-cli") {
    const state = readState();
    const models = { ...(state.models || {}) };
    for (const id of PINS) models["anthropic/" + id] = { agentRuntime: { id: "claude-cli" } };
    writeState({ ...state, models });
  }
  print(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "models" && args[1] === "set") {
  writeState({ ...readState(), primary: args[2] || null });
  print("ok");
  process.exit(0);
}
if (args[0] === "models" && args[1] === "list") {
  const provider = args[args.indexOf("--provider") + 1];
  const shaped = knob("FAKE_OPENCLAW_MODELS_JSON");
  if (shaped === "fail") { process.stderr.write("simulated models list failure\\n"); process.exit(1); }
  if (shaped !== undefined) { print(shaped); process.exit(0); }
  const rows = (DEFAULT_MODELS[provider] || []).map(([id, name]) => ({ key: provider + "/" + id, name }));
  print(JSON.stringify({ models: rows }));
  process.exit(0);
}
if (args[0] === "models" && args[1] === "auth" && args[2] === "list") {
  await slowRead();
  const shaped = knob("FAKE_OPENCLAW_AUTH_JSON");
  if (shaped === "fail") { process.stderr.write("simulated auth list failure\\n"); process.exit(1); }
  if (shaped !== undefined) { print(shaped); process.exit(0); }
  const profiles = readState().authRows;
  if (knob("FAKE_OPENCLAW_AUTH_SHAPE") === "legacy") { print(JSON.stringify(profiles)); process.exit(0); }
  const agentDir = path.join(openclawDir, "agents", "main", "agent");
  print(JSON.stringify({ agentDir, agentId: "main", authStatePath: path.join(agentDir, "auth-state.json"), provider: "openai", profiles }));
  process.exit(0);
}
if (args[0] === "models" && args[1] === "status") {
  print("openai:default token " + SECRET + " checked");
  const code = Number(knob("FAKE_OPENCLAW_STATUS_EXIT") ?? "0");
  process.exit(code === 1 || code === 2 ? code : 0);
}

if (args[0] === "agent" && args[1] === "exec" && args.includes("--help")) {
  print("Usage\\n --message-file PATH\\n --cwd DIR\\n --json");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "exec") {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch {}
  if (existsSync(path.join(home, ".fake-openclaw-agent-fail"))) {
    process.stderr.write("simulated agent failure\\n");
    process.exit(2);
  }
  print(JSON.stringify({ ok: true, final: "ready: " + input.slice(0, 20) }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "-m") {
  if (existsSync(path.join(home, ".fake-openclaw-agent-fail"))) {
    process.stderr.write("simulated agent failure\\n");
    process.exit(2);
  }
  print(JSON.stringify({ ok: true, final: "ready" }));
  process.exit(0);
}
if (args[0] === "doctor") {
  const ok = existsSync(configFile);
  print(JSON.stringify({ ok, findings: ok ? [] : [{ message: "not onboarded" }] }));
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get") {
  if (args[2] === "tools.exec.mode") {
    let value = "full";
    try { value = readFileSync(execModeFile, "utf8").trim(); } catch {}
    print(value);
    process.exit(0);
  }
  if (args[2] === "agents.defaults.model.primary") {
    await slowRead();
    const bad = knob("FAKE_OPENCLAW_GET_PRIMARY");
    if (bad === "timeout") { process.kill(process.pid, "SIGTERM"); await new Promise(() => setInterval(() => {}, 1000)); }
    if (bad === "fail") { process.stderr.write("simulated config get failure\\n"); process.exit(1); }
    print(readState().primary || "");
    process.exit(0);
  }
  if (args[2] === "agents.defaults.models") {
    await slowRead();
    const bad = knob("FAKE_OPENCLAW_GET_MODEL_SETTINGS");
    if (bad === "timeout") { process.kill(process.pid, "SIGTERM"); await new Promise(() => setInterval(() => {}, 1000)); }
    if (bad === "fail") { process.stderr.write("simulated config get failure\\n"); process.exit(1); }
    if (bad === "garbage") { print("this is not json {"); process.exit(0); }
    const models = readState().models;
    print(models ? JSON.stringify(models) : "");
    process.exit(0);
  }
  print("");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") {
  if (args[2] === "tools.exec.mode") writeFileSync(execModeFile, args[3]);
  print("ok");
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "status") {
  print(JSON.stringify({ running: existsSync(runningMarker) }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "start") {
  writeFileSync(runningMarker, "1");
  print("ok");
  process.exit(0);
}
print("fake-openclaw: " + JSON.stringify(args));
process.exit(0);
`;

// Puts the fake at <home>/.npm-global/bin/openclaw, where detection's fallback
// folders (and which()) find it. Same signature as before the move.
export async function installFakeOpenclawShim(home) {
  const jsDir = path.join(home, ".fake-cli");
  await mkdir(jsDir, { recursive: true });
  const jsPath = path.join(jsDir, "openclaw.mjs");
  await writeFile(jsPath, FAKE_OPENCLAW_CLI_SOURCE);
  const binDir = path.join(home, ".npm-global", "bin");
  await mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, "openclaw");
  await writeFile(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`);
  await chmod(shimPath, 0o755);
}
