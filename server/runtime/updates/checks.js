// The version check service (SP5, spec "Version check service", R37). It asks,
// read-only, whether each of the five agents has a newer version, at start and
// every 24 hours. A check that cannot get an answer is "failed" ("Couldn't
// check" on screen) and never blocks anything; one failing never affects the
// others.
//
//   Codex               the npm registry's dist-tag `latest`
//   Claude Code         the dist-tag of the person's own update channel (R47): `stable` when their
//                       Claude settings.json says autoUpdatesChannel "stable" (`claude update` follows
//                       that tag), otherwise `latest`. Only that one key is read, and the file's text
//                       is passed to channelFromSettings and nowhere else.
//   OpenClaw            `openclaw update --dry-run --json` (its targetVersion)
//   Hermes              `hermes update --check`: "Selected release available: stable v0.22.7 (..)" gives
//                       a Latest (R48); the older wording ("Update available: 3 commits behind") gives
//                       none. A release that is not newer than the installed one, "This checkout is
//                       newer" and "Holding at this build" are all up to date: never a step back.
//   Cursor              no check command is known (spike S6): "unknown"
//
// Installed versions come from each adapter's detect() (server/runtime/agents).
//
// A first answer can be wrong just because five CLIs started at once on a cold machine (live check, 2026-11-05: a
// working Hermes read as "failed" and "no_checkout", and that would have stood for 24 hours). So a round that start()
// or the 24-hour timer began asks once more, retryMs (60 s) after it ended, the agents whose row is "failed" and
// Hermes when its folder check said no_checkout (R49). See createUpdateChecks.
//
// The Hermes clean check (hermes-clean.js, about nine git calls) is cached next to
// these checks and computed in the same rounds, so a page request reads the
// answer and never runs git. Only a person's click on Update asks it afresh.
import { promises as fs } from "node:fs";
import path from "node:path";
import { getAdapter } from "../agents/index.js";
import { resolveHermesHome } from "../agents/hermes.js";
import { runCommand } from "../safety.js";
import { claudeConfigDir } from "../sessions/claude-session.js";
import { checkSessionFolder } from "../sessions/folders.js";
import { isAgentUpdating } from "./activity.js";
import { hermesCleanCheck } from "./hermes-clean.js";
import {
  channelFromSettings,
  compareVersions,
  parseDistTags,
  parseHermesCheck,
  parseOpenclawDryRun,
  versionNumber
} from "./versions.js";

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

/**
 * The Hermes clean check's reasons (hermes-clean.js) plus one this file adds:
 * @typedef {import("./hermes-clean.js").HermesReason | "folder_refused"} HermesOfferReason
 * folder_refused: the checkout is clean but is not a folder a session may work in (the sessions folder
 * policy, D12), so no Update is offered. Its sentence: "Hermes's folder is outside the places Agent OS may work."
 */

// The agents that are checked, in the order they are listed.
export const UPDATE_AGENT_IDS = Object.freeze(["claude", "codex", "cursor", "openclaw", "hermes"]);

// May the version checks run at all? They reach the npm registry and run the agents' own CLIs, so they run
// only where a launcher asked for them: the desktop app (AGENT_OS_PACKAGED=1) or `npm run dev`
// (AGENT_OS_DEV_ORIGIN=1), or anywhere with AGENT_OS_UPDATE_CHECKS=1. AGENT_OS_UPDATE_CHECKS=0 switches them
// off even there. Every way in honours this (start, refresh, and so the refresh after an update): when it is
// false nothing is fetched and no agent is run, and what was found before is simply kept. A plain
// `node server/index.js` (and so every server a test starts) never checks.
export function updateChecksEnabled(env = process.env) {
  if (env.AGENT_OS_UPDATE_CHECKS === "1") return true;
  return (env.AGENT_OS_PACKAGED === "1" || env.AGENT_OS_DEV_ORIGIN === "1") && env.AGENT_OS_UPDATE_CHECKS !== "0";
}

const CHECK_LIMIT_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// How long after a round the agents that failed in it are asked once more (R49).
const RETRY_MS = 60 * 1000;
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

// The text of the person's Claude settings.json: in CLAUDE_CONFIG_DIR when it is an absolute path, else in .claude under
// the home folder (claudeConfigDir, the same rule Claude's sessions use). It rejects when there is no such file or it
// cannot be read; the lookup counts that as no file. Only channelFromSettings ever sees the text (R47).
function defaultReadClaudeSettings() {
  return fs.readFile(path.join(claudeConfigDir({ env: process.env }), "settings.json"), "utf8");
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

// Which tag Claude Code's `claude update` follows (R47): the one the person's update channel names. A settings file that
// is missing, cannot be read or says anything but "stable" means "latest". The text goes to channelFromSettings and
// is dropped: it is not logged, returned or kept.
async function claudeUpdateTag(readClaudeSettings) {
  let text = "";
  try {
    text = await readClaudeSettings();
  } catch {
    // no file, or one that cannot be read: the same as no setting
  }
  return channelFromSettings(text);
}

// `followsChannel`: the tag is the person's channel (Claude Code), not always `latest` (Codex).
function npmLookup(packageName, { followsChannel = false } = {}) {
  return async ({ installed, fetchText, signal, readClaudeSettings }) => {
    const tag = followsChannel ? await claudeUpdateTag(readClaudeSettings) : "latest";
    const url = `${npmRegistryBase()}/-/package/${packageName}/dist-tags`;
    const latest = parseDistTags(await fetchText(url, { signal }), tag);
    if (!latest) throw new Error(`The registry's answer holds no ${tag} version.`);
    return { latest, state: stateFor(installed, latest) };
  };
}

async function openclawLookup({ detected, installed, runCli, signal, limitMs }) {
  const result = await runCli(detected.path, ["update", "--dry-run", "--json"], { signal, timeoutMs: limitMs });
  if (!result?.ok) throw new Error("The OpenClaw dry run failed.");
  const dryRun = parseOpenclawDryRun(result.stdout);
  if (!dryRun) throw new Error("The OpenClaw dry run printed no readable answer.");
  // A target that would go to an OLDER version is not an update (R37), and it is not a "Latest" to show
  // either: the page must never print a Latest that is older than what is installed.
  const state = dryRun.downgradeRisk ? "up-to-date" : stateFor(installed || dryRun.current, dryRun.target);
  // The Gateway warning belongs to an update the person can actually take.
  return {
    latest: dryRun.downgradeRisk ? null : dryRun.target,
    state,
    restartsGateway: state === "available" && dryRun.restartsGateway
  };
}

async function hermesLookup({ detected, installed, runCli, signal, limitMs }) {
  // Ask the Hermes profile that chat runs and the safety reads use: HERMES_HOME
  // from the server's own environment, else the stored connection value.
  const home = await resolveHermesHome();
  const env = home ? { ...process.env, HERMES_HOME: home } : process.env;
  const result = await runCli(detected.path, ["update", "--check"], { env, signal, timeoutMs: limitMs });
  const answer = parseHermesCheck({ code: exitCode(result), stdout: result?.stdout });
  if (!answer) throw new Error("Hermes's update check gave no readable answer.");
  // A release that is not newer than what is installed is no update (R48), and not a "Latest" to show either: the page
  // must never offer a step back or print a Latest that is older than Installed. With no number on either side nothing
  // can be compared, and the answer stands.
  if (answer.state === "available" && answer.latest) {
    const order = compareVersions(installed, answer.latest);
    if (order !== null && order >= 0) return { latest: null, state: "up-to-date" };
  }
  return { latest: answer.latest, state: answer.state };
}

const LOOKUPS = {
  claude: npmLookup("@anthropic-ai/claude-code", { followsChannel: true }),
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
//         readClaudeSettings() -> the text of the person's Claude settings.json (Claude Code's lookup only; it may
//           reject, which counts as no file);
//         limitMs (default 30 s) and now (a clock).
export async function checkAgent(
  agentId,
  {
    fetchText = defaultFetchText,
    runCli = defaultRunCli,
    detect = defaultDetect,
    readClaudeSettings = defaultReadClaudeSettings,
    limitMs = CHECK_LIMIT_MS,
    now = Date.now
  } = {}
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
      return status({
        installed,
        ...(await lookup({ detected, installed, fetchText, runCli, readClaudeSettings, signal, limitMs }))
      });
    });
  } catch {
    return status({ installed, state: "failed" });
  }
}

// --- the service: checks at start and every 24 hours ------------------------------------------------

// What the cache holds before the first Hermes clean check has ended: not clean, and no reason to show.
// Fails closed: Setup offers no Hermes update and the page shows nothing yet.
const NOT_CHECKED_YET = Object.freeze({ clean: false, checkout: null, reasons: Object.freeze([]) });

// check(agentId, { now }) is checkAgent unless a test passes its own.
// cleanCheck() is the Hermes clean check (V2's hermesCleanCheck) -> { clean, checkout, reasons }. The shared
// service passes it; without one the Hermes answer stays "not clean" and no git is ever run.
// isUpdating(agentId) says whether that agent's update is running now (the shared service reads the update
// registry, updates/activity.js); a round that would check such an agent skips it and keeps the row it has.
//
// One round per agent at a time (SP5 E1, M2): a refresh of an agent whose round is already running shares that
// round instead of starting a second, so a periodic round, the page's "Check for updates" and the check after an
// update never run the same agent's CLI (or Hermes's nine git calls) side by side.
//
// The one exception is the check an update (or an install) asks for when it has ended: refresh(agentId, { afterChange:
// true }) always starts a new round, even beside a running one and even while the agent is still counted as updating
// (a failed update step is still "running" in the job list when this is asked for). A round that began before the
// change may hold the old version, and the answer it gives must not be the one that is kept.
//
// Two answers can overlap that way: a periodic check that began before an update ended can finish AFTER the check
// the update asked for, and its old answer would put "update available" back. So every check takes a number
// when it starts, and its answer is kept only when no check that started later has already been kept.
//
// One more try (R49): when a round that start() or the 24-hour timer began has ended, the agents whose row is "failed",
// and Hermes when its clean check said no_checkout (its row is not "not-installed"), are asked again once, retryMs
// later (a single unref'd timer). Five CLIs starting at once on a cold machine can time out or read nothing although
// they are fine, and that answer would otherwise stand for 24 hours. A retry schedules no further retry, and neither
// does a person's "Check for updates" or the check after an update: they call refresh() directly. The retry is an
// ordinary refresh(agentId), so an agent that is updating by then is skipped, as in any round.
//
// stop() (the server is shutting down) ends the timer and from then on no round starts at all, until start() is
// called again: a check must not begin while the agents' own processes are being stopped. It clears a pending retry too.
export function createUpdateChecks({
  check = checkAgent,
  cleanCheck = null,
  isUpdating = () => false,
  intervalMs = DAY_MS,
  retryMs = RETRY_MS,
  now = Date.now
} = {}) {
  const statuses = new Map();
  const started = new Map(); // agentId -> the number the newest check took
  const kept = new Map(); // agentId -> the number of the check whose answer is stored
  const rounds = new Map(); // agentId -> the round (its check, and for Hermes its clean check) that is running now
  let timer = null;
  let retryTimer = null;
  let stopped = false;

  async function checkOne(agentId) {
    const number = (started.get(agentId) ?? 0) + 1;
    started.set(agentId, number);
    let status;
    try {
      status = await check(agentId, { now });
    } catch {
      // checkAgent never throws; a replacement might. One agent's trouble stays its own.
      status = { agentId, installed: null, latest: null, state: "failed", checkedAt: new Date(now()).toISOString() };
    }
    if (number > (kept.get(agentId) ?? 0)) {
      kept.set(agentId, number);
      statuses.set(agentId, status);
    }
  }

  // The latest status of each agent that has been checked, in the agents' order.
  // Empty before the first check. Copies, so a caller cannot change what is held.
  function list() {
    return UPDATE_AGENT_IDS.filter((id) => statuses.has(id)).map((id) => ({ ...statuses.get(id) }));
  }

  // --- Hermes: is its checkout an unchanged official copy? (the answer GET /api/updates and the Setup plan read) ---

  let cleanAnswer = NOT_CHECKED_YET;
  let cleanStarted = 0;
  let cleanKept = 0;

  // What a page request reads: no git is run here. { clean, reasons }, copies.
  function hermesClean() {
    return { clean: cleanAnswer.clean, reasons: [...cleanAnswer.reasons] };
  }

  // Runs the clean check now, stores the answer (when no later check has been stored) and resolves this run's
  // own answer, { clean, checkout, reasons }: POST /api/updates/hermes uses the checkout it names. A check that
  // throws is "not clean" (fails closed).
  async function refreshHermesClean() {
    if (!cleanCheck) return { ...NOT_CHECKED_YET, reasons: [] };
    const number = (cleanStarted += 1);
    let answer;
    try {
      const result = await cleanCheck();
      answer = {
        clean: result?.clean === true,
        checkout: typeof result?.checkout === "string" ? result.checkout : null,
        reasons: Array.isArray(result?.reasons) ? [...result.reasons] : []
      };
    } catch {
      answer = { clean: false, checkout: null, reasons: [] };
    }
    if (number > cleanKept) {
      cleanKept = number;
      cleanAnswer = answer;
    }
    return { ...answer, reasons: [...answer.reasons] };
  }

  // An isUpdating that fails says nothing is updating: a check is never held back by its own helper.
  function updating(agentId) {
    try {
      return isUpdating(agentId) === true;
    } catch {
      return false;
    }
  }

  // One agent's round: its version check and, for Hermes, the clean check next to it. `fresh` starts a new round even
  // when one is running (see above); otherwise the running one is shared.
  function round(agentId, { fresh }) {
    const running = rounds.get(agentId);
    if (running && !fresh) return running;
    const mine = Promise.all([checkOne(agentId), ...(agentId === "hermes" ? [refreshHermesClean()] : [])])
      .then(() => undefined)
      .finally(() => {
        if (rounds.get(agentId) === mine) rounds.delete(agentId);
      });
    rounds.set(agentId, mine);
    return mine;
  }

  // Checks one agent, or all five at the same time, and answers with the whole list. The Hermes clean answer
  // is computed in the same round when Hermes is among them. An id that is not one of the five checks nothing.
  // Nothing is checked, and the list is as it is, where the checks are not enabled (updateChecksEnabled) and after
  // stop(); an agent whose update is running is left out and keeps its saved row (unless afterChange, above).
  async function refresh(agentId, { afterChange = false } = {}) {
    if (stopped || !updateChecksEnabled()) return list();
    const ids = (agentId == null ? UPDATE_AGENT_IDS : UPDATE_AGENT_IDS.filter((id) => id === agentId)).filter(
      (id) => afterChange || !updating(id)
    );
    await Promise.all(ids.map((id) => round(id, { fresh: afterChange })));
    return list();
  }

  // The agents a finished round should ask again (R49): every row that failed, and Hermes when its clean check could not
  // find the checkout (that answer is the cold-start one, and it is cached as well) unless Hermes is not installed.
  function agentsToAskAgain() {
    const ids = list()
      .filter((row) => row.state === "failed")
      .map((row) => row.agentId);
    const hermes = statuses.get("hermes");
    if (hermes && hermes.state !== "not-installed" && cleanAnswer.reasons.includes("no_checkout") && !ids.includes("hermes")) {
      ids.push("hermes");
    }
    return ids;
  }

  function scheduleRetry() {
    if (stopped || !updateChecksEnabled()) return;
    const ids = agentsToAskAgain();
    if (!ids.length) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      for (const id of ids) void refresh(id);
    }, retryMs);
    retryTimer.unref?.(); // like the interval: a retry alone never keeps the server running
  }

  // A round that start() or the 24-hour timer began: all five agents, then the one retry.
  async function scheduledRound() {
    await refresh();
    scheduleRetry();
  }

  // Checks once at once, then again every intervalMs. Starting twice does nothing, and neither does starting
  // where the checks are not enabled.
  function start() {
    if (timer || !updateChecksEnabled()) return;
    stopped = false;
    void scheduledRound();
    timer = setInterval(() => void scheduledRound(), intervalMs);
    timer.unref?.(); // the timer alone never keeps the server running
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  // True from stop() until start(): the update service's session poll asks it, so a server that is quitting starts nothing.
  function isStopped() {
    return stopped;
  }

  return { start, stop, isStopped, list, refresh, hermesClean, refreshHermesClean };
}

// The clean check as the Agents page and the Setup plan use it: hermesCleanCheck, plus the sessions folder
// policy on the checkout it examined. An update runs in a terminal session whose folder is that checkout
// (SP3 "Session kinds"), and it must pass the policy, otherwise no Update is offered: a checkout the policy
// refuses is not clean, with the reason folder_refused after the others. `check` and `checkFolder` are
// for tests.
export async function hermesCleanForUpdate({ check = hermesCleanCheck, checkFolder = checkSessionFolder } = {}) {
  const result = await check();
  if (typeof result?.checkout !== "string") return result;
  let allowed = false;
  try {
    allowed = (await checkFolder(result.checkout))?.ok === true;
  } catch {
    allowed = false; // a folder that can't be judged is not allowed
  }
  if (allowed) return result;
  return { ...result, clean: false, reasons: [...(result.reasons ?? []), "folder_refused"] };
}

let shared = null;

// The one service for the whole server. Its Hermes clean check is hermesCleanForUpdate, so what the page,
// the Setup plan and the Update click see already has the folder policy applied.
export function getUpdateChecks() {
  shared ??= createUpdateChecks({ cleanCheck: () => hermesCleanForUpdate(), isUpdating: isAgentUpdating });
  return shared;
}

// Test-only: stops the shared service and drops it, so the next getUpdateChecks() builds a new one
// (in the style of resetSetupJobsForTest in setup/jobs.js).
export function resetUpdateChecksForTest() {
  shared?.stop();
  shared = null;
}
