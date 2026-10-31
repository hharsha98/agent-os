// The version check service (SP5, spec "Version check service", R37). It asks,
// read-only, whether each of the five agents has a newer version, at start and
// every 24 hours. A check that cannot get an answer is "failed" ("Couldn't
// check" on screen) and never blocks anything; one failing never affects the
// others.
//
//   Claude Code, Codex  the npm registry's dist-tag `latest`
//   OpenClaw            `openclaw update --dry-run --json` (its targetVersion)
//   Hermes              `hermes update --check` (it says only "up to date" or
//                       "update available", never a number)
//   Cursor              no check command is known (spike S6): "unknown"
//
// Installed versions come from each adapter's detect() (server/runtime/agents).
import { getAdapter } from "../agents/index.js";
import { resolveHermesHome } from "../agents/hermes.js";
import { runCommand } from "../safety.js";
import { compareVersions, parseDistTags, parseHermesCheck, parseOpenclawDryRun, versionNumber } from "./versions.js";

/**
 * @typedef {"up-to-date"|"available"|"unknown"|"failed"|"not-installed"} UpdateState
 * @typedef {Object} AgentUpdateStatus
 * @property {string} agentId
 * @property {string|null} installed - the installed version number ("2.1.309"), null when not installed or unreadable
 * @property {string|null} latest - the newest version number, null when there is none to show
 * @property {UpdateState} state
 * @property {string} checkedAt - ISO time of this check
 * @property {boolean} [restartsGateway] - OpenClaw only: updating it restarts its Gateway
 */

// The agents that are checked, in the order they are listed.
export const UPDATE_AGENT_IDS = Object.freeze(["claude", "codex", "cursor", "openclaw", "hermes"]);

const CHECK_LIMIT_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NPM_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_ENV = "AGENT_OS_TEST_NPM_REGISTRY";

// Test-only escape hatch (the same rule as AGENT_OS_SETUP_MIRROR in
// setup/recipes.js): a suite can point the registry at a local http server, and
// nothing else can move it. The override is parsed properly: plain http, the
// loopback address 127.0.0.1, no user name or password, and no path. Anything
// else is ignored with a warning, so a stray env var can never redirect a real
// check. (The value is not printed: it could hold a user name and password.)
export function npmRegistryBase() {
  const raw = process.env[REGISTRY_ENV];
  if (!raw) return NPM_REGISTRY;
  try {
    const url = new URL(raw);
    const plainPath = url.pathname === "/" || url.pathname === "";
    const ok =
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      plainPath &&
      !url.search &&
      !url.hash;
    if (ok) return url.origin;
  } catch {
    // not a URL: ignored below
  }
  console.warn(`Ignoring ${REGISTRY_ENV}: only a plain http://127.0.0.1:<port> override is honoured.`);
  return NPM_REGISTRY;
}

// --- the real things a check uses (a test injects its own) ---------------------------------------------

async function defaultFetchText(url, { signal } = {}) {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`The registry answered ${response.status}.`);
  return response.text();
}

// Argv only, never a shell. Resolves runCommand's { ok, stdout, stderr, code, ... }.
function defaultRunCli(command, args, { env, signal, timeoutMs } = {}) {
  return runCommand(command, args, timeoutMs, { env, signal });
}

// Always asks again (refresh), so a check after an update sees the new version.
function defaultDetect(agentId) {
  return getAdapter(agentId).detect({ refresh: true });
}

// runCommand reports a timeout or an abort as ok: false with code 0, so a failed
// run is never 0 here.
function exitCode(result) {
  if (result?.ok) return 0;
  return Number.isInteger(result?.code) && result.code !== 0 ? result.code : -1;
}

// Runs work(signal) with a time limit. When the time is up the signal is aborted
// (which stops a request or a child process that listens to it) and the check
// ends at once, whether or not work() ever notices.
async function within(limitMs, work) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("The check ran out of time."));
    }, limitMs);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// --- what each agent's answer means -----------------------------------------------------------------

// installed older than latest is an update; equal or newer (a beta ahead of the
// registry's latest) is not; a text with no version number cannot be compared.
function stateFor(installed, latest) {
  const order = compareVersions(installed, latest);
  if (order === null) return "unknown";
  return order < 0 ? "available" : "up-to-date";
}

function npmLookup(packageName) {
  return async ({ installed, fetchText, signal }) => {
    const url = `${npmRegistryBase()}/-/package/${packageName}/dist-tags`;
    const latest = parseDistTags(await fetchText(url, { signal }));
    if (!latest) throw new Error("The registry's answer holds no latest version.");
    return { latest, state: stateFor(installed, latest) };
  };
}

async function openclawLookup({ detected, installed, runCli, signal, limitMs }) {
  const result = await runCli(detected.path, ["update", "--dry-run", "--json"], { signal, timeoutMs: limitMs });
  if (!result?.ok) throw new Error("The OpenClaw dry run failed.");
  const dryRun = parseOpenclawDryRun(result.stdout);
  if (!dryRun) throw new Error("The OpenClaw dry run printed no readable answer.");
  // A target that would go to an OLDER version is not an update (R37).
  const state = dryRun.downgradeRisk ? "up-to-date" : stateFor(installed || dryRun.current, dryRun.target);
  // The Gateway warning belongs to an update the person can actually take.
  return { latest: dryRun.target, state, restartsGateway: state === "available" && dryRun.restartsGateway };
}

async function hermesLookup({ detected, runCli, signal, limitMs }) {
  // Ask the Hermes profile that chat runs and the safety reads use: HERMES_HOME
  // from the server's own environment, else the stored connection value.
  const home = await resolveHermesHome();
  const env = home ? { ...process.env, HERMES_HOME: home } : process.env;
  const result = await runCli(detected.path, ["update", "--check"], { env, signal, timeoutMs: limitMs });
  const state = parseHermesCheck({ code: exitCode(result), stdout: result?.stdout });
  if (!state) throw new Error("Hermes's update check gave no readable answer.");
  return { latest: null, state };
}

const LOOKUPS = {
  claude: npmLookup("@anthropic-ai/claude-code"),
  codex: npmLookup("@openai/codex"),
  // Cursor's help lists no check command (R37): its updater checks when the person presses Update.
  cursor: async () => ({ latest: null, state: "unknown" }),
  openclaw: openclawLookup,
  hermes: hermesLookup
};

// Checks one agent and always answers with a status (only an unknown agent id
// is a mistake and rejects). Any trouble, a registry that answers 500, a CLI
// that hangs or prints nothing readable, or the 30 s limit, is state "failed",
// with what is installed still shown when it was read.
//   deps: fetchText(url, { signal }) -> body text, throws on a bad answer;
//         runCli(path, args, { env, signal, timeoutMs }) -> { ok, code, stdout, stderr };
//         detect(agentId) -> the adapter's detect() result;
//         limitMs (default 30 s) and now (a clock).
export async function checkAgent(
  agentId,
  { fetchText = defaultFetchText, runCli = defaultRunCli, detect = defaultDetect, limitMs = CHECK_LIMIT_MS, now = Date.now } = {}
) {
  const lookup = LOOKUPS[agentId];
  if (!lookup) throw new TypeError(`checkAgent: unknown agent "${agentId}"`);
  const status = (fields) => ({
    agentId,
    installed: null,
    latest: null,
    state: "failed",
    checkedAt: new Date(now()).toISOString(),
    ...fields
  });
  let installed = null;
  try {
    return await within(limitMs, async (signal) => {
      const detected = await detect(agentId);
      if (!detected?.installed) return status({ state: "not-installed" });
      installed = versionNumber(detected.version) ?? (String(detected.version ?? "").trim() || null);
      return status({ installed, ...(await lookup({ detected, installed, fetchText, runCli, signal, limitMs })) });
    });
  } catch {
    return status({ installed, state: "failed" });
  }
}

// --- the service: checks at start and every 24 hours ------------------------------------------------

// check(agentId, { now }) is checkAgent unless a test passes its own.
export function createUpdateChecks({ check = checkAgent, intervalMs = DAY_MS, now = Date.now } = {}) {
  const statuses = new Map();
  let timer = null;

  async function checkOne(agentId) {
    let status;
    try {
      status = await check(agentId, { now });
    } catch {
      // checkAgent never throws; a replacement might. One agent's trouble stays its own.
      status = { agentId, installed: null, latest: null, state: "failed", checkedAt: new Date(now()).toISOString() };
    }
    statuses.set(agentId, status);
  }

  // The latest status of each agent that has been checked, in the agents' order.
  // Empty before the first check. Copies, so a caller cannot change what is held.
  function list() {
    return UPDATE_AGENT_IDS.filter((id) => statuses.has(id)).map((id) => ({ ...statuses.get(id) }));
  }

  // Checks one agent, or all five at the same time, and answers with the whole list.
  // An id that is not one of the five checks nothing.
  async function refresh(agentId) {
    const ids = agentId == null ? UPDATE_AGENT_IDS : UPDATE_AGENT_IDS.filter((id) => id === agentId);
    await Promise.all(ids.map(checkOne));
    return list();
  }

  // Checks once at once, then again every intervalMs. Starting twice does nothing.
  function start() {
    if (timer) return;
    void refresh();
    timer = setInterval(() => void refresh(), intervalMs);
    timer.unref?.(); // the timer alone never keeps the server running
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, list, refresh };
}

let shared = null;

// The one service for the whole server.
export function getUpdateChecks() {
  shared ??= createUpdateChecks();
  return shared;
}
