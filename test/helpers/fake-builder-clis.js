// The fake coding-agent CLIs (Claude Code, Codex, Cursor) of the Setup tests,
// moved here from test/setup-builders.test.js (SP3 Task B1b) so the plan-brains
// tests can install the same fake Claude Code. One script plays all three
// agents (its first argument says which). It is a helper, not a test file.
//
// Every call is written to $HOME/.fake-agent-calls.log (plain text, as before)
// and, as one JSON line, to $HOME/.fake-agent-env.jsonl: { kind, args, home,
// setVars }, where `home` is the HOME it saw and `setVars` names which of
// XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, HERMES_HOME and any OPENCLAW_*
// variable reached it (spec Safety 4).
//
// Knob (contract "Fakes and knobs"; read from the environment, else from
// $HOME/.fake-knobs/FAKE_CLAUDE_AUTH_JSON, because signInStatus runs Claude Code
// through childEnv, which drops FAKE_* variables): FAKE_CLAUDE_AUTH_JSON is what
// `claude auth status` prints, verbatim; it exits 0 when that parses with
// loggedIn: true, else 1. Unset, the marker files below decide, as before.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const FAKE_AGENT_CLI_SOURCE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [kind, ...args] = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
const flag = (name) => existsSync(path.join(home, name));
const out = (t) => process.stdout.write(t + "\\n");
const err = (t) => process.stderr.write(t + "\\n");
try { appendFileSync(path.join(home, ".fake-agent-calls.log"), kind + " " + args.join(" ") + "\\n"); } catch {}
const H1_NAMES = ["XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME"];
const setVars = Object.keys(process.env).filter((key) => H1_NAMES.includes(key) || key.startsWith("OPENCLAW_")).sort();
try {
  appendFileSync(path.join(home, ".fake-agent-env.jsonl"), JSON.stringify({ kind, args, home: process.env.HOME || null, setVars }) + "\\n");
} catch {}
function knob(name) {
  if (process.env[name] !== undefined) return process.env[name];
  try { return readFileSync(path.join(home, ".fake-knobs", name), "utf8").trim(); } catch { return undefined; }
}

const VERSION = { claude: "2.1.900 (Claude Code)", codex: "codex-cli 0.200.0", cursor: "2026.10.99-test" };
const LOGIN_URL = {
  claude: "https://claude.ai/oauth/authorize?code_challenge=abc&state=xyz",
  codex: "https://auth.openai.com/oauth/authorize?state=xyz",
  cursor: "https://cursor.com/loginDeepControl?uuid=abc"
};
const signedIn = () => flag(".fake-signed-in-" + kind);

if (args[0] === "--version") {
  out(flag(".fake-updated-" + kind) ? "9.9.9-updated" : VERSION[kind]);
  process.exit(0);
}
if (args[0] === "--help") {
  if (kind === "claude") out("Usage: claude [options]\\nCommands:\\n  auth    Manage authentication\\n  update  Check for updates");
  if (kind === "codex") out("Usage: codex\\nCommands:\\n  login   Manage login\\n  update  Update Codex");
  if (kind === "cursor") out("Usage: agent\\nCommands:\\n  login  Authenticate with Cursor\\n  status|whoami [options]  View authentication status");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") { out("Usage: codex exec"); process.exit(0); }
if (args[0] === "update") {
  writeFileSync(path.join(home, ".fake-updated-" + kind), "1");
  out("updated");
  process.exit(0);
}

const isLogin = (kind === "claude" && args[0] === "auth" && args[1] === "login") || (kind !== "claude" && args[0] === "login" && args.length === 1);
const isStatus = (kind === "claude" && args[0] === "auth" && args[1] === "status") || (kind === "codex" && args[0] === "login" && args[1] === "status") || (kind === "cursor" && args[0] === "status");
if (isLogin) {
  if (flag(".fake-login-notty")) { err("Error: stdin is not a TTY. This command requires an interactive terminal."); process.exit(1); }
  if (flag(".fake-login-fail")) { err("login failed: the code was rejected"); process.exit(1); }
  out("Opening your browser. If it did not open, visit: " + LOGIN_URL[kind]);
  out("Or visit https://evil.example/phish?token=nope");
  out("a-very-long-opaque-string-that-looks-like-a-token-" + "x".repeat(40));
  if (flag(".fake-login-sleep")) { setInterval(() => {}, 1000); }
  else { writeFileSync(path.join(home, ".fake-signed-in-" + kind), "1"); out("Login successful"); process.exit(0); }
} else if (isStatus) {
  if (flag(".fake-status-broken")) { err("boom"); process.exit(2); }
  if (kind === "claude") {
    const authJson = knob("FAKE_CLAUDE_AUTH_JSON");
    if (authJson !== undefined) {
      let loggedIn = false;
      try { loggedIn = JSON.parse(authJson).loggedIn === true; } catch {}
      out(authJson);
      process.exit(loggedIn ? 0 : 1);
    }
    if (signedIn()) { out(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", orgName: "Secret Org" })); process.exit(0); }
    out(JSON.stringify({ loggedIn: false, authMethod: "none" })); process.exit(1);
  }
  if (kind === "codex") {
    if (signedIn()) { out("Logged in using ChatGPT"); process.exit(0); }
    err("Not logged in"); process.exit(1);
  }
  out(signedIn() ? "Logged in as someone@example.com" : "Not logged in");
  process.exit(0);
} else {
  out("fake-" + kind + ": " + JSON.stringify(args));
}
`;

// A launcher that runs the fake as `kind` with this Node.
export function shimText(jsPath, kind) {
  return `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" ${kind} "$@"\n`;
}

// Writes the fake into dir as fake-agent-cli.mjs and returns its path.
export async function writeFakeAgentCli(dir) {
  await mkdir(dir, { recursive: true });
  const jsPath = path.join(dir, "fake-agent-cli.mjs");
  await writeFile(jsPath, FAKE_AGENT_CLI_SOURCE);
  return jsPath;
}

// An agent that is "already installed": the launcher a real installer leaves
// in <home>/.local/bin (Cursor's two names, agent and cursor-agent).
export async function installFakeAgent(home, kind, jsPath) {
  const names = kind === "cursor" ? ["agent", "cursor-agent"] : [kind];
  const binDir = path.join(home, ".local", "bin");
  await mkdir(binDir, { recursive: true });
  for (const name of names) {
    await writeFile(path.join(binDir, name), shimText(jsPath, kind));
    await chmod(path.join(binDir, name), 0o755);
  }
}
