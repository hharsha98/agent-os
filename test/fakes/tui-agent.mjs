// A fake agent CLI that behaves like a terminal program (a TUI), for the SP3
// session tests (planning decision Q2). It is not a test file: `npm test`
// (scripts/run-tests.mjs) runs only test/*.test.js. Start it through the
// shims that makeFakeAgentBin() in test/helpers/fake-agents.js writes; each
// shim sets FAKE_AGENT_NAME to the agent it stands in for.
//
// Modes (FAKE_AGENT_MODE; the shim's mode unless the environment sets one):
//   tui                FAKE_ARGV line, then a "> " prompt; echoes typing; runs typed commands
//   setsid-grandchild  tui, plus a grandchild in its own session (spawn with
//                      detached: true, so libuv calls setsid; macOS has no setsid command)
//   ignore-term        tui, but SIGTERM is ignored (SIGKILL still ends it)
//   agents-hang        `claude agents --json` never answers
//   updater            asks "Update now? [y/N] ", prints "ANSWER <text>", exits 0 for y, 1 otherwise
//
// Quick answers (no terminal needed): --version, --help, auth status, login
// status, status, doctor, config get (approvals.mode prints "manual"),
// gateway ..., claude agents ..., claude stop <id>, and under the Cursor names
// (agent, cursor-agent) create-chat. A headless run (-p,
// --print or exec anywhere in argv, as the Runs page starts one; never a
// session argv) prints nothing and keeps running until it is stopped, like
// the UI audit harness's earlier fake-agent, whose probes stop live runs.
//
// Typed commands (each ends with Enter):
//   alt on|off   paste on|off   mouse on|off   focus on|off   keys app|normal   kitty on|off
//   bell   osc9 <text>   osc9st <text>   osc99 <text>   osc777 <text>   title <text>
//   ask (DA1 and DSR)   ask after <ms>   ask kitty   ask color
//   lines <n>   flood <KiB>   bottom <text>   ticker <ms> <count>   exit <code>
//   print <text>   prints <text> exactly as typed (spaces kept), then \r\n (SP4: limit texts)
//   anything else prints "you said: <text>"
// Replies to its questions (DA1, DSR, kitty flags, OSC 10/11 colour) and
// focus reports print "REPLY <json>"; a bracketed paste prints
// "PASTE <json>"; other escape sequences (arrows, mouse reports) print
// "KEY <json>". Ctrl+C exits with code 130. SIGTERM is logged, then ends the
// fake (mode ignore-term only logs it). SIGHUP is never handled, so the fake
// leaves when its terminal closes (the server tests rely on this).
//
// Environment:
//   FAKE_AGENT_LOG                       append one JSON line per event to this file
//                                        ({ name, pid, at, event, ... }; at is Date.now())
//   FAKE_AGENT_PIDFILE                   setsid-grandchild: write the grandchild's pid here
//   FAKE_AGENT_GRANDCHILD_IGNORE_TERM=1  the grandchild ignores SIGTERM
//   FAKE_AGENT_SNAPSHOT_ON_TERM          on SIGTERM, copy this file's text into the log entry;
//                                        a literal {AGENT_OS_SESSION_ID} in it becomes this
//                                        process's AGENT_OS_SESSION_ID (the quit test knows
//                                        the id only after the session starts)
//   FAKE_CLAUDE_AGENTS_JSON              what `claude agents --json` prints (default "[]")
//   FAKE_CURSOR_CREATE_CHAT              what `agent create-chat` does (spike S6): unset prints a fresh
//                                        crypto.randomUUID() and exits 0; "fail" prints nothing and exits 1;
//                                        "garbage" prints "not-a-uuid" and exits 0; "uuid-exit1" prints a fresh
//                                        uuid and still exits 1 (a good id must not count when the exit is bad);
//                                        "slow" waits 30 s before it answers like the default (a timeout test
//                                        must not wait for it).
//                                        Read like the knobs below. Every call is logged as a "create-chat"
//                                        record (the id it printed, or null) with the fields of a start record.
//   FAKE_AGENT_VERSION                   openclaw only: the whole line `--version` prints, verbatim
//                                        (unset: "openclaw 9.9.9-fake", which reads as older than 2026.9.7)
//
// Knobs (plan brains): FAKE_AGENT_VERSION is read from the environment, else from the trimmed
// text of $HOME/.fake-knobs/FAKE_AGENT_VERSION (test/helpers/fake-knobs.js writes it), because
// some callers hand an agent only an allow-listed environment that drops FAKE_* variables.
//
// OpenClaw's ChatGPT sign-in (plan brains, Task B1a): `openclaw models auth login --provider
// openai --method siwc`, chosen by its argv (no mode), needs a terminal: without one it prints
// "This command needs a terminal." and exits 1. In one it logs its start record and prints a
// sign-in link, a code and "Press Enter after you approve in your browser.", echoes typing, and
// on Enter adds a Sign in with ChatGPT profile row (the OpenClaw 2026.10.4 shape, made-up values)
// to authRows in $HOME/.fake-agent-state.json, prints "Signed in." and exits 0. Ctrl+C exits 130
// and saves nothing. Every start record names the OPENCLAW_* variables the fake was given
// (openclawKeys), for the Safety 4 tests.
//
// Probe records (plan brains): under the name openclaw, every quick answer (--version, --help,
// the status questions, the sign-in's no-terminal refusal) is logged first as { event: "probe",
// ... } with the fields of a start record, so the Safety 3 and 4 tests also see the argv and the
// environment of the commands agent detection runs. Other names log nothing for a quick answer.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const name = process.env.FAKE_AGENT_NAME || "";
const mode = process.env.FAKE_AGENT_MODE || "tui";
const args = process.argv.slice(2);
const ESC = "\x1b";
const BEL = "\x07";
// Never outlive a forgotten test by more than ten minutes.
const MAX_LIFETIME_MS = 10 * 60 * 1000;
// A headless run ends by itself after five minutes, as the earlier audit fake's did.
const HEADLESS_RUN_MS = 5 * 60 * 1000;

if (!name) {
  process.stdout.write(
    "tui-agent.mjs is a fake agent for tests. Start it through makeFakeAgentBin() in test/helpers/fake-agents.js.\n"
  );
  process.exit(0);
}

function out(text) {
  process.stdout.write(text);
}

function line(text) {
  out(`${text}\r\n`);
}

function log(entry) {
  const file = process.env.FAKE_AGENT_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ name, pid: process.pid, at: Date.now(), ...entry })}\n`);
  } catch {
    // the test reads what it can
  }
}

// The knob rule (plan brains): the environment first, else $HOME/.fake-knobs/<name>, trimmed.
function knob(knobName) {
  if (process.env[knobName] !== undefined) return process.env[knobName];
  if (!process.env.HOME) return undefined;
  try {
    return readFileSync(path.join(process.env.HOME, ".fake-knobs", knobName), "utf8").trim();
  } catch {
    return undefined;
  }
}

// A quick answer, then exit. Under the name `openclaw` it is logged first as a "probe" record
// with the fields of a "start" record (plan brains, Safety 3 and 4): agent detection runs
// `--version`, `agent exec --help` and `agent --help`, which never reach a terminal.
function answer(text, code = 0) {
  if (name === "openclaw") log({ event: "probe", ...argvRecord() });
  process.stdout.write(`${text}\n`, () => process.exit(code));
  return true;
}

function clampInt(text, min, max, fallback) {
  const value = Number.parseInt(String(text), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// Names only for anything secret-looking: values never reach the screen,
// the recording or the log.
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|_KEY$/i;
const HOST_KEY = /^(?:CLAUDE|CURSOR_|__CURSOR_)|^(?:AGENT_TRANSCRIPTS|GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE)$/;
const SHOWN_ENV = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "AGENT_OS_SESSION_ID",
  "CLAUDE_CODE_NO_FLICKER",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "HOME",
  "USERPROFILE",
  "SHELL",
  "EDITOR",
  "VISUAL",
  "SSH_AUTH_SOCK",
  "LANG",
  "LC_ALL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "HERMES_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_PROFILE",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_AGENT_DIR",
  "FAKE_AGENT_MODE"
];

function argvRecord() {
  const env = {};
  for (const key of SHOWN_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const keys = Object.keys(process.env).sort();
  return {
    name,
    mode,
    argv: args,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    env,
    agentOsKeys: keys.filter((key) => key.startsWith("AGENT_OS_") || key.startsWith("HERMES_AGENT_OS_")),
    // Names only: every OPENCLAW_* variable this program was given (plan brains, Safety 4).
    openclawKeys: keys.filter((key) => key.startsWith("OPENCLAW_")),
    // Names only (several hold secrets): every variable of a host agent, Claude
    // Code's CLAUDE* or Cursor's CURSOR_* and its three unprefixed names, that
    // reached this program. A session started from a server that runs inside a
    // host agent must show none of them (F-S7a).
    hostKeys: keys.filter((key) => HOST_KEY.test(key)),
    secretKeys: keys.filter((key) => SECRET_KEY.test(key))
  };
}

// Cursor's `agent create-chat` (spike S6): prints the id of a new, empty chat and exits, so a
// session can open Cursor straight on it with `--resume <id>` (no chat picker). FAKE_CURSOR_CREATE_CHAT
// picks the behaviour (see the header); the call is logged with the argv, folder and environment names
// it was given, which the profile tests read.
const SLOW_CREATE_CHAT_MS = 30 * 1000;

function createChat() {
  const behaviour = knob("FAKE_CURSOR_CREATE_CHAT") || "ok";
  const id = behaviour === "fail" || behaviour === "garbage" ? null : randomUUID();
  log({ event: "create-chat", behaviour, id, ...argvRecord() });
  if (behaviour === "fail") process.exit(1);
  if (behaviour === "garbage") return answer("not-a-uuid");
  if (behaviour === "uuid-exit1") return answer(id, 1);
  if (behaviour === "slow") {
    setTimeout(() => answer(id), SLOW_CREATE_CHAT_MS);
    return true;
  }
  return answer(id);
}

// The quick, non-interactive questions that agent detection and the Stop
// sequence ask. Each answers at once and exits, so nothing waits on a TUI.
// Returns true when it handled the command line.
function oneShot() {
  const joined = args.join(" ");
  if ((name === "agent" || name === "cursor-agent") && joined === "create-chat") return createChat();
  if (args.includes("--version") || joined === "-v") {
    // Only `openclaw` takes FAKE_AGENT_VERSION (plan brains: its ChatGPT sign-in needs 2026.9.7 or newer).
    const version = name === "openclaw" ? knob("FAKE_AGENT_VERSION") : undefined;
    return answer(version || `${name} 9.9.9-fake`);
  }
  if (args.includes("--help") || joined === "-h") {
    return answer(`Usage: ${name} [options]\n  --help     Show help\n  --version  Show version`);
  }
  if (joined === "auth status") return answer(JSON.stringify({ loggedIn: true }));
  if (joined === "login status") return answer("Logged in using ChatGPT");
  if (args[0] === "status") return answer(JSON.stringify({ status: "authenticated" }));
  if (args[0] === "doctor") return answer(args.includes("--json") ? "{}" : "ok");
  // Hermes's approvals setting reads as on ("manual"), as the earlier audit fake answered.
  if (args[0] === "config" && args[1] === "get") return answer(args[2] === "approvals.mode" ? "manual" : "");
  if (args[0] === "gateway") {
    if (args[1] === "status") {
      return answer(args.includes("--json") ? JSON.stringify({ running: false }) : "gateway is not running");
    }
    // Service controls: the Hold to stop all tests check that nothing calls these.
    log({ event: "gateway", args });
    return answer(`gateway ${args[1] || ""} done`);
  }
  if (name === "claude" && args[0] === "agents") {
    log({ event: "agents", args });
    if (mode === "agents-hang") {
      // Never answers; the Stop sequence's 2 s limit kills it. It still ends
      // itself after the lifetime cap, so a failed test cannot leave it behind.
      setTimeout(() => process.exit(0), MAX_LIFETIME_MS);
      return true;
    }
    return answer(process.env.FAKE_CLAUDE_AGENTS_JSON || "[]");
  }
  if (name === "claude" && args[0] === "stop") {
    log({ event: "stop", id: args[1] || null });
    return answer(`stopped ${args[1] || ""}`);
  }
  if (args.some((arg) => arg === "-p" || arg === "--print" || arg === "exec")) {
    // A headless run (never a session argv): no output, and it keeps running
    // until it is stopped (SIGTERM ends it at once).
    log({ event: "run", args });
    setTimeout(() => process.exit(0), HEADLESS_RUN_MS);
    return true;
  }
  return false;
}

// --- the terminal program ---------------------------------------------------

const REPLY_PATTERNS = [
  /^\x1b\[\?[\d;]*c/, // DA1 reply
  /^\x1b\[\d+;\d+R/, // DSR cursor position report
  /^\x1b\[\?\d*u/, // kitty keyboard flags reply
  /^\x1b\](?:10|11);[^\x07\x1b]*(?:\x07|\x1b\\)/, // OSC 10/11 colour reply
  /^\x1b\[[IO]/ // focus in / out report
];
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

let pending = "";
let typed = "";
let updaterWaiting = false;

function prompt() {
  out(`> ${typed}`);
}

function notice(text) {
  out(`\r\n${text}\r\n`);
  prompt();
}

// The length of one complete escape sequence at the start of s, or 0 when
// more bytes are needed.
function escapeLength(s) {
  if (s.length < 2) return 0;
  if (s[1] === "[") {
    for (let i = 2; i < s.length; i += 1) {
      const code = s.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
    }
    return 0;
  }
  if (s[1] === "]") {
    for (let i = 2; i < s.length; i += 1) {
      if (s[i] === BEL) return i + 1;
      if (s[i] === ESC && s[i + 1] === "\\") return i + 2;
    }
    return 0;
  }
  if (s[1] === "O") return s.length >= 3 ? 3 : 0;
  return 2;
}

function onInput(chunk) {
  pending += chunk;
  while (pending.length) {
    if (pending.startsWith(PASTE_START)) {
      const end = pending.indexOf(PASTE_END);
      if (end === -1) return;
      const text = pending.slice(PASTE_START.length, end);
      pending = pending.slice(end + PASTE_END.length);
      log({ event: "paste", text });
      notice(`PASTE ${JSON.stringify(text)}`);
      continue;
    }
    if (pending[0] === ESC) {
      const reply = REPLY_PATTERNS.map((pattern) => pending.match(pattern)).find(Boolean);
      if (reply) {
        pending = pending.slice(reply[0].length);
        log({ event: "reply", seq: reply[0] });
        notice(`REPLY ${JSON.stringify(reply[0])}`);
        continue;
      }
      const length = escapeLength(pending);
      if (!length) return;
      const key = pending.slice(0, length);
      pending = pending.slice(length);
      log({ event: "key", seq: key });
      notice(`KEY ${JSON.stringify(key)}`);
      continue;
    }
    const ch = pending[0];
    pending = pending.slice(1);
    if (ch === "\r" || ch === "\n") {
      const text = typed;
      typed = "";
      out("\r\n");
      handleLine(text);
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      if (typed) {
        typed = typed.slice(0, -1);
        out("\b \b");
      }
      continue;
    }
    if (ch === "\x03") {
      out("^C\r\n");
      process.exit(130);
    }
    typed += ch;
    out(ch);
  }
}

function handleLine(text) {
  log({ event: "line", text });
  if (updaterWaiting) {
    updaterWaiting = false;
    line(`ANSWER ${text}`);
    const yes = /^y(es)?$/i.test(text.trim());
    process.stdout.write("", () => process.exit(yes ? 0 : 1));
    return;
  }
  const [command = "", ...rest] = text.trim().split(/\s+/);
  const value = rest.join(" ");
  switch (command) {
    case "alt":
      out(value === "off" ? `${ESC}[?1049l` : `${ESC}[?1049h`);
      break;
    case "paste":
      out(value === "off" ? `${ESC}[?2004l` : `${ESC}[?2004h`);
      break;
    case "mouse":
      out(value === "off" ? `${ESC}[?1006l${ESC}[?1000l` : `${ESC}[?1000h${ESC}[?1006h`);
      break;
    case "focus":
      out(value === "off" ? `${ESC}[?1004l` : `${ESC}[?1004h`);
      break;
    case "keys":
      out(value === "normal" ? `${ESC}[?1l` : `${ESC}[?1h`);
      break;
    case "kitty":
      out(value === "off" ? `${ESC}[<u` : `${ESC}[>1u`);
      break;
    case "bell":
      out(BEL);
      break;
    case "osc9":
      out(`${ESC}]9;${value}${BEL}`);
      break;
    case "osc9st":
      out(`${ESC}]9;${value}${ESC}\\`);
      break;
    case "osc99":
      out(`${ESC}]99;;${value}${ESC}\\`);
      break;
    case "osc777":
      out(`${ESC}]777;notify;Fake agent;${value}${BEL}`);
      break;
    case "title":
      out(`${ESC}]0;${value}${BEL}`);
      break;
    case "print":
      // Exactly what follows "print " (spaces kept): the SP4 limit-text tests.
      line(text.replace(/^\s*print ?/, ""));
      break;
    case "ask":
      if (value === "kitty") out(`${ESC}[?u`);
      else if (value === "color") out(`${ESC}]11;?${BEL}`);
      else if (value.startsWith("after ")) {
        // DA1 and DSR later, so a test can close the writer's window first (S9: the mirror answers).
        setTimeout(() => out(`${ESC}[c${ESC}[6n`), clampInt(value.slice(6), 10, 60000, 1000));
      } else out(`${ESC}[c${ESC}[6n`);
      break;
    case "lines": {
      const count = clampInt(value, 1, 100000, 10);
      for (let i = 1; i <= count; i += 1) line(`line ${i}`);
      break;
    }
    case "flood": {
      // 16 rows of 64 bytes = 1 KiB.
      const kib = clampInt(value, 1, 65536, 64);
      const row = `${"x".repeat(62)}\r\n`;
      for (let i = 0; i < kib * 16; i += 1) out(row);
      line(`FLOOD DONE ${kib}`);
      break;
    }
    case "bottom": {
      // Redraw only the last row (a status line) and put the cursor back.
      const rows = process.stdout.rows || 24;
      out(`${ESC}7${ESC}[${rows};1H${ESC}[2K${value}${ESC}8`);
      return; // no new prompt: nothing above the bottom row changes
    }
    case "ticker": {
      const [every, times] = rest;
      const intervalMs = clampInt(every, 10, 60000, 100);
      const count = clampInt(times, 1, 100000, 10);
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        const rows = process.stdout.rows || 24;
        out(`${ESC}7${ESC}[${rows};1H${ESC}[2Ktick ${tick}${ESC}8`);
        if (tick >= count) clearInterval(timer);
      }, intervalMs);
      return;
    }
    case "exit": {
      const code = clampInt(value, 0, 255, 0);
      process.stdout.write("", () => process.exit(code));
      return;
    }
    case "":
      break;
    default:
      line(`you said: ${text}`);
  }
  prompt();
}

function startGrandchild() {
  const source = [
    'if (process.env.FAKE_AGENT_GRANDCHILD_IGNORE_TERM === "1") process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
    `setTimeout(() => process.exit(0), ${MAX_LIFETIME_MS});`
  ].join("\n");
  const grandchild = spawn(process.execPath, ["-e", source], { detached: true, stdio: "ignore" });
  grandchild.unref();
  const pidFile = process.env.FAKE_AGENT_PIDFILE;
  if (pidFile) writeFileSync(pidFile, String(grandchild.pid));
  log({ event: "grandchild", pid: grandchild.pid });
  line(`GRANDCHILD:${grandchild.pid}`);
}

function onTerm() {
  const entry = { event: "sigterm" };
  const snapshotFile = (process.env.FAKE_AGENT_SNAPSHOT_ON_TERM || "").replaceAll(
    "{AGENT_OS_SESSION_ID}",
    process.env.AGENT_OS_SESSION_ID || ""
  );
  if (snapshotFile) {
    try {
      entry.snapshot = readFileSync(snapshotFile, "utf8");
    } catch (error) {
      entry.snapshotError = error?.code || String(error);
    }
  }
  log(entry);
  if (mode === "ignore-term") return;
  // Die from the signal itself, so the parent sees "killed by SIGTERM".
  process.removeListener("SIGTERM", onTerm);
  process.kill(process.pid, "SIGTERM");
}

// --- OpenClaw's ChatGPT sign-in (plan brains) -------------------------------------------------------

const SIGNIN_ARGV = ["models", "auth", "login", "--provider", "openai", "--method", "siwc"];
const STATE_FILE = ".fake-agent-state.json";

function isSignIn() {
  return name === "openclaw" && args.length === SIGNIN_ARGV.length && args.every((arg, index) => arg === SIGNIN_ARGV[index]);
}

// $HOME/.fake-agent-state.json: { primary, models, authRows } (test/helpers/fake-knobs.js reads it).
function readState() {
  let value = null;
  try {
    value = JSON.parse(readFileSync(path.join(process.env.HOME || "", STATE_FILE), "utf8"));
  } catch {
    value = null;
  }
  const state = { primary: null, models: null, authRows: [], ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}) };
  if (!Array.isArray(state.authRows)) state.authRows = [];
  return state;
}

function signInProgram() {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    answer("This command needs a terminal.", 1);
    return;
  }
  process.on("SIGTERM", onTerm);
  setTimeout(() => process.exit(0), MAX_LIFETIME_MS).unref();
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  log({ event: "start", ...argvRecord() });
  line("Sign in with ChatGPT: https://auth.openai.com/fake-signin?state=agentos-test");
  line("Code: FAKE-1234");
  line("Press Enter after you approve in your browser.");
  let finished = false;
  process.stdin.on("data", (chunk) => {
    for (const ch of chunk) {
      if (finished) return;
      if (ch === "\x03") {
        finished = true;
        out("^C\r\n");
        process.exit(130);
      }
      if (ch === "\r" || ch === "\n") {
        finished = true;
        const state = readState();
        // Same row as fakeSiwcProfile() in test/helpers/fake-knobs.js (a test compares the two).
        state.authRows.push({
          id: "openai:token-sharing:agentos-test",
          provider: "openai",
          type: "oauth",
          label: "openai token sharing (ChatGPT, Beta)",
          email: "someone@example.com",
          displayName: "Sign in with ChatGPT (Beta)",
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
        writeFileSync(path.join(process.env.HOME || "", STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
        process.stdout.write("\r\nSigned in.\r\n", () => process.exit(0));
        return;
      }
      if (ch >= " ") out(ch); // echoes what is typed, as a terminal program does
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}

function startTui() {
  process.on("SIGTERM", onTerm);
  // No SIGHUP handler on purpose: when the terminal closes (for example the
  // server was killed with SIGKILL), Node's default action ends the fake.
  setTimeout(() => process.exit(0), MAX_LIFETIME_MS).unref();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  const record = argvRecord();
  log({ event: "start", ...record });
  line(`FAKE_ARGV ${JSON.stringify(record)}`);
  if (mode === "setsid-grandchild") startGrandchild();
  if (mode === "updater") {
    updaterWaiting = true;
    out("Update now? [y/N] ");
  } else {
    prompt();
  }
  process.stdin.on("data", onInput);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}

if (isSignIn()) signInProgram();
else if (!oneShot()) startTui();
