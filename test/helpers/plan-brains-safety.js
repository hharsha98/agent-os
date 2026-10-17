// Shared checks for the plan-brains Safety items (spec
// docs/superpowers/specs/2026-10-15-plan-brains-design.md, "Safety"), used by
// test/plan-brains-safety.test.js and the other plan-brains tests. A helper,
// not a test file: the runner (scripts/run-tests.mjs) only runs test/*.test.js.
//   Safety 1: the file-access spy (moved verbatim from test/setup-builders.test.js,
//             which imports it from here) and the one agent file Agent OS may touch;
//   Safety 3: the argv rules for every fake's argv log, and the source scan;
//   Safety 4: the variables Agent OS never sets or overrides (H1).
import fs, { promises as fsp } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This checkout (test/helpers/ is two folders below it).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- Safety 1 ---------------------------------------------------------------

export const FORBIDDEN_PATH = /(^|[\\/])(\.claude|\.codex|\.cursor|\.hermes|\.openclaw)([\\/]|$)|auth\.json|(^|[\\/])\.env($|\.)/;

// Records the first argument (the path) of the file-system calls these modules
// could use to look at a file, then puts everything back.
export function spyOnFileAccess(seen) {
  const undo = [];
  const wrap = (target, name) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function spied(...args) {
      const first = args[0];
      if (typeof first === "string" || first instanceof URL || Buffer.isBuffer(first)) seen.push(String(first));
      return original.apply(this, args);
    };
    undo.push(() => {
      target[name] = original;
    });
  };
  for (const name of ["readFile", "open", "access", "stat", "lstat", "readdir", "opendir", "realpath", "readlink", "copyFile", "cp", "writeFile", "mkdir", "rm"]) {
    wrap(fsp, name);
  }
  for (const name of ["readFileSync", "openSync", "existsSync", "statSync", "lstatSync", "readdirSync", "accessSync", "createReadStream"]) {
    wrap(fs, name);
  }
  syncBuiltinESMExports();
  return () => {
    undo.forEach((restore) => restore());
    syncBuiltinESMExports();
  };
}

// What a Safety 1 test asserts is empty: the spy's records that point at an agent file
// (FORBIDDEN_PATH), except the `allowed` paths. Agent OS's own files are not agent files, and
// node loads some of them lazily inside the spied window (express's body parser, node-pty). But
// this checkout can itself sit under a `.claude` folder (a Claude Code worktree is
// <repo>/.claude/worktrees/<name>), which FORBIDDEN_PATH matches on its own. So a path inside the
// checkout is judged by its part below the checkout only: <checkout>/node_modules/x passes,
// <checkout>/.env and every path outside the checkout are judged as they are.
export function agentFileAccess(seen, { allowed = [] } = {}) {
  return seen.filter((recorded) => {
    if (allowed.includes(recorded)) return false;
    const file = recorded.startsWith("file://") ? fileURLToPath(recorded) : recorded;
    const below = file.startsWith(REPO_ROOT + path.sep) ? file.slice(REPO_ROOT.length) : file;
    return FORBIDDEN_PATH.test(below);
  });
}

// The one agent file Agent OS may touch (spec Safety 1): brain.js checks that
// ~/.openclaw/openclaw.json exists and reads nothing from it. FORBIDDEN_PATH
// matches it, so a test leaves out exactly this path and no other.
export function allowedAgentFile(home) {
  return path.join(home, ".openclaw", "openclaw.json");
}

// ---- Safety 3 ---------------------------------------------------------------

// Never run or offered by Agent OS (spec "Terms basis" and Safety 3), and
// --probe, so `models status` never calls a model (plan-brains contract).
export const FORBIDDEN_ARGV = Object.freeze([
  "setup-token",
  "paste-token",
  "--token",
  "--method oauth",
  "--device-code",
  "--dangerously-skip-permissions",
  "--yolo",
  "--probe"
]);

// A word on its own ("--token", also "--token=x"), or a flag and its value
// ("--method oauth", also "--method=oauth").
function hasWord(argv, word) {
  const [flag, value] = word.split(" ");
  if (value === undefined) return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  return argv.some((arg, index) => (arg === flag && argv[index + 1] === value) || arg === `${flag}=${value}`);
}

// Safety 3 over argv lists, each the arguments after the program as the fakes
// log them. One sentence per problem ([] when there is none): a forbidden word,
// --accept-risk anywhere but on `onboard`, --accept-risk without the risk
// tick, or an entry that is not a list of strings.
export function argvProblems(argvLists, { riskTicked = false } = {}) {
  const problems = [];
  for (const argv of argvLists) {
    if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
      problems.push(`not an argv list: ${JSON.stringify(argv)}`);
      continue;
    }
    const shown = argv.join(" ");
    for (const word of FORBIDDEN_ARGV) {
      if (hasWord(argv, word)) problems.push(`${word} in: ${shown}`);
    }
    if (hasWord(argv, "--accept-risk")) {
      if (argv[0] !== "onboard") problems.push(`--accept-risk outside onboard in: ${shown}`);
      else if (riskTicked !== true) problems.push(`--accept-risk without the risk tick in: ${shown}`);
    }
  }
  return problems;
}

// Safety 3 over a server module's source, comments stripped (the same rule as
// the scan of signin.js in test/setup-builders.test.js): none of FORBIDDEN_ARGV,
// as a string, as a flag and its value in an argv list ("--method", "oauth"),
// or as flag=value.
export function sourceProblems(text) {
  const code = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
  const problems = [];
  for (const word of FORBIDDEN_ARGV) {
    const [flag, value] = word.split(" ");
    const found = value === undefined ? code.includes(flag) : new RegExp(flag + "[\"'`\\s,=]+[\"'`]?" + value + "\\b").test(code);
    if (found) problems.push(word);
  }
  return problems;
}

// ---- Safety 4 ---------------------------------------------------------------

// The variables Agent OS never sets or overrides for anything this feature runs
// (spec Safety 4, H1). HOME and USERPROFILE are not in the list: a test checks
// that they reach a fake unchanged instead.
export const H1_ENV_NAMES = Object.freeze([
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_PROFILE",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_AGENT_DIR"
]);

// `env`, plus every H1 name and every OPENCLAW_* variable this process has set
// to undefined: ready for a test's withEnv() (undefined removes a variable) or
// a child's env (spawn leaves undefined values out). A Safety 4 test starts
// from here, so any of them that reaches a fake was set by Agent OS.
export function withoutH1Env(env = {}) {
  const cleared = {};
  for (const name of H1_ENV_NAMES) cleared[name] = undefined;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OPENCLAW_")) cleared[name] = undefined;
  }
  return { ...cleared, ...env };
}
