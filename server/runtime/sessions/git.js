// git for the changes panel and the separate copies (SP4): argv only, never
// a shell, always `git -C <folder>` first, then options that keep git from
// taking the index lock (--no-optional-locks) or running the person's file
// monitor (core.fsmonitor=false). Every call is cut at GIT_LIMIT_MS and gets
// the session's own environment without Agent OS's own variables, never the
// server's environment (which holds AGENT_OS_TOKEN). The commands that diff
// add --no-ext-diff and --no-textconv themselves (changes.js), so git never
// runs a diff tool or a text converter the person configured.
import { runCli } from "./soft-stop.js";

export const GIT_LIMIT_MS = 5000;
export const GIT_BASE_ARGS = Object.freeze(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"]);
// How much output one call keeps unless the caller asks for another limit.
const GIT_OUTPUT_CHARS = 1024 * 1024;
// git's error text, for a message that quotes it (Task X9's worktree_failed).
const GIT_STDERR_CHARS = 4096;
const GIT_OWN = new Set(["LC_ALL", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_NO_LAZY_FETCH", "GIT_ALLOW_PROTOCOL"]);
// Variables a person's shell may export that would send git to another
// repository whatever `-C` says (GIT_DIR, GIT_WORK_TREE, ...), or make it run
// something of theirs (a diff tool, a pager, a password helper, settings given
// in the environment). None of them reaches the changes panel's git calls (S2).
const GIT_DROPPED = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  // The old single-file form: `git config` reads only that file, so the list of
  // filters would be empty while status still reads the repository's own.
  "GIT_CONFIG",
  "GIT_ASKPASS"
]);
const GIT_CONFIG_ENTRY = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

// A copy of `baseEnv` for git: without Agent OS's own variables (AGENT_OS_*
// and HERMES_AGENT_OS_*, as sessionEnv drops them), without the variables
// above, never asking for a password (GIT_TERMINAL_PROMPT=0), never taking
// optional locks (GIT_OPTIONAL_LOCKS=0), and with plain messages (LC_ALL=C).
// It also stops git from ever reaching for a network (N1): a repository whose
// configuration names a "promisor" remote makes git fetch a missing object
// when a status or a diff needs it, and that fetch would run the command the
// repository's own settings give it (core.sshCommand, an ext:: address, a
// remote's uploadpack). GIT_NO_LAZY_FETCH=1 turns the fetch off, and
// GIT_ALLOW_PROTOCOL=none (no protocol has that name; an empty value can be
// dropped on Windows) allows no transport at all, whatever protocol.*.allow the
// repository says; the read then fails (a missing object) instead.
// Without a base it holds only those five: the server's own environment is
// never used.
//
// `config` is a list of [key, value] settings that git must use for this call
// (git 2.31 and newer reads them from GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n> and
// GIT_CONFIG_VALUE_<n>, which, unlike `-c name=value`, also takes a name that
// holds an "="). They are added after the person's own variables were removed.
export function gitEnv(baseEnv, config = []) {
  const source = baseEnv && typeof baseEnv === "object" && !Array.isArray(baseEnv) ? baseEnv : {};
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (name.startsWith("AGENT_OS_") || name.startsWith("HERMES_AGENT_OS_") || GIT_OWN.has(name)) continue;
    if (GIT_DROPPED.has(name) || GIT_CONFIG_ENTRY.test(name)) continue;
    env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_ALLOW_PROTOCOL = "none";
  env.LC_ALL = "C";
  const settings = Array.isArray(config)
    ? config.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string")
    : [];
  if (settings.length > 0) {
    env.GIT_CONFIG_COUNT = String(settings.length);
    settings.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }
  return env;
}

// One git call: { code, stdout, stderr, timedOut, ok }. `ok` means it was not
// cut and its exit code is one of `okCodes`. Never throws. `run` is runCli
// (injectable for tests); a cut call's process tree is killed by runCli.
// `config` is a list of [key, value] git settings for this call (see gitEnv).
export async function runGit(
  folder,
  args,
  { env, timeoutMs = GIT_LIMIT_MS, okCodes = [0], maxChars = GIT_OUTPUT_CHARS, run = runCli, config = [] } = {}
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  try {
    const result = await run("git", ["-C", String(folder), ...GIT_BASE_ARGS, ...args], {
      env: gitEnv(env, config),
      signal: controller.signal,
      maxChars,
      captureStderr: true
    });
    const code = Number.isInteger(result?.code) ? result.code : null;
    const cut = timedOut && result?.aborted === true;
    return {
      code,
      stdout: typeof result?.stdout === "string" ? result.stdout : "",
      stderr: typeof result?.stderr === "string" ? result.stderr.slice(0, GIT_STDERR_CHARS) : "",
      timedOut: cut,
      ok: !cut && code !== null && okCodes.includes(code)
    };
  } catch {
    return { code: null, stdout: "", stderr: "", timedOut: false, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// The top folder of the work tree that `folder` is in, or null (not in a work
// tree, git missing, or too slow).
export async function gitTopLevel(folder, { env, run = runGit } = {}) {
  const result = await run(folder, ["rev-parse", "--show-toplevel"], { env });
  const top = result?.ok && typeof result.stdout === "string" ? result.stdout.replace(/\r?\n$/, "") : "";
  return top || null;
}
