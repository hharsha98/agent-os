// The "Get started" checklist: what a first-time person still has to do, worked
// out from what is REALLY on this computer, never from a manual tick.
//
//   GET /api/onboarding             -> { steps, counts, complete, hidden, facts }
//   GET /api/onboarding?refresh=1      the same, with the checks run again
//   PUT /api/onboarding { confirm: true, skipped?: string[], hidden?: boolean }
//     skipped  the steps the person chose to skip (the whole list, so it can also
//              be shortened); hidden  whether the card on Home is put away.
//     Answers like GET. Errors: 400 { error: "invalid_skipped" | "invalid_hidden" }
//
//   steps[]  { id, status: "done" | "todo" | "skipped" | "unavailable", detail }
//            `detail` is one plain sentence about the real state (never a number
//            that was not measured).
//   counts   { done, skipped, todo, total }  total counts the steps that can be done
//            at all, so the not-yet-available step never sits in the denominator.
//   facts    what is set up, for the calm finish screen: { installed, brains,
//            signedIn, firstRun } where firstRun is null until a run exists and
//            durationMs / costUsd are null when the run did not report them.
//
// How each step is judged (all of it through code the Setup and Home screens
// already use; nothing here starts an agent, an installer or a login):
//   install   the agents' cached detection (30 s)      adapter.detect()
//   brain     Hermes/OpenClaw "configured" (setup brain) or a saved builder brain
//   signin    each installed coding agent's own status command, cached for a minute
//   first-run a run of kind "agent" in the run store
// Only the choices (skipped, hidden) are stored: <AGENT_OS_HOME>/config/onboarding.json.
import express from "express";
import { ADAPTERS } from "./agents/index.js";
import { BUILDER_AGENT_IDS, loadBrains } from "./builders/brains.js";
import { getRunManager } from "./runs/run-manager.js";
import { currentBrain } from "./setup/brain.js";
import { CODING_AGENT_IDS, OPERATOR_AGENT_IDS } from "./setup/recipes.js";
import { signInStatus } from "./setup/signin.js";
import { readJson, runtimePaths, writeJson } from "./store.js";

const CONFIG_FILE = "onboarding.json";
// The checks spawn small commands (a doctor, a status), so they are remembered
// for a minute; the screen can still ask for a fresh look with ?refresh=1.
const FACTS_TTL_MS = 60 * 1000;

// The steps a person can skip. "agent-computer" is not available yet, so it has
// nothing to skip.
export const SKIPPABLE_STEP_IDS = ["install", "brain", "signin", "first-run"];

const AGENT_NAME = { hermes: "Hermes", openclaw: "OpenClaw", claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
const nameOf = (id) => AGENT_NAME[id] || id;

function listNames(ids) {
  const names = ids.map(nameOf);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function onboardingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---- the person's choices (the only thing this file stores) ---------------------

function configPath() {
  return `${runtimePaths().config}/${CONFIG_FILE}`;
}

function cleanState(raw) {
  const given = raw && typeof raw === "object" ? raw : {};
  const skipped = Array.isArray(given.skipped) ? given.skipped.filter((id) => SKIPPABLE_STEP_IDS.includes(id)) : [];
  return { skipped: [...new Set(skipped)], hidden: given.hidden === true };
}

export async function loadOnboardingState() {
  return cleanState(await readJson(configPath(), null));
}

export async function saveOnboardingState(patch) {
  const current = await loadOnboardingState();
  const given = patch && typeof patch === "object" ? patch : {};
  const next = { ...current };
  if (given.skipped !== undefined) {
    if (!Array.isArray(given.skipped) || given.skipped.some((id) => !SKIPPABLE_STEP_IDS.includes(id))) {
      throw onboardingError("invalid_skipped", `Skipped steps can only be: ${SKIPPABLE_STEP_IDS.join(", ")}.`);
    }
    next.skipped = [...new Set(given.skipped)];
  }
  if (given.hidden !== undefined) {
    if (typeof given.hidden !== "boolean") throw onboardingError("invalid_hidden", "hidden is true or false.");
    next.hidden = given.hidden;
  }
  await writeJson(configPath(), next);
  return next;
}

// ---- what is really set up ------------------------------------------------------

async function detectedInstalled(agentId) {
  try {
    const detected = await ADAPTERS[agentId].detect();
    return { installed: Boolean(detected?.installed), detected };
  } catch {
    return { installed: false, detected: { installed: false } };
  }
}

// The first signed-in coding agent wins, so a person who is signed in to one
// does not pay for the other two checks. An agent that cannot say counts as
// "not signed in yet" (the sentence says it could not tell).
async function checkSignIn(installedCoding) {
  const signedIn = [];
  const notes = {};
  for (const agentId of installedCoding) {
    try {
      const result = await signInStatus(agentId);
      notes[agentId] = result.status;
      if (result.status === "signed_in") {
        signedIn.push(agentId);
        break;
      }
    } catch {
      notes[agentId] = "unknown";
    }
  }
  return { signedIn, notes };
}

async function builderBrainsSet() {
  try {
    const brains = await loadBrains();
    return BUILDER_AGENT_IDS.filter((id) => brains[id] && brains[id].mode !== "plan");
  } catch {
    return [];
  }
}

async function firstAgentRun() {
  try {
    const runs = await getRunManager().listRuns({ kind: "agent", limit: 1000 });
    // listRuns is newest first, so the oldest one is last.
    const run = runs[runs.length - 1];
    if (!run) return { count: 0, first: null };
    const started = Date.parse(run.startedAt || "");
    const ended = Date.parse(run.endedAt || "");
    return {
      count: runs.length,
      first: {
        id: run.id,
        agentId: run.agentId || null,
        status: run.status,
        durationMs: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null,
        costUsd: typeof run.usage?.costUsd === "number" ? run.usage.costUsd : null
      }
    };
  } catch {
    return { count: 0, first: null };
  }
}

async function computeFacts() {
  const found = {};
  for (const agentId of [...OPERATOR_AGENT_IDS, ...CODING_AGENT_IDS]) found[agentId] = await detectedInstalled(agentId);
  const installed = Object.keys(found).filter((id) => found[id].installed);
  const installedOperators = OPERATOR_AGENT_IDS.filter((id) => found[id].installed);
  const installedCoding = CODING_AGENT_IDS.filter((id) => found[id].installed);

  // Hermes and OpenClaw: their own "is a model set up" answer (nothing runs for an
  // agent that is not installed).
  let configured = [];
  if (installedOperators.length) {
    try {
      const brain = await currentBrain({
        agents: { hermes: { detected: found.hermes.detected }, openclaw: { detected: found.openclaw.detected } }
      });
      configured = OPERATOR_AGENT_IDS.filter((id) => brain[id]?.configured);
    } catch {
      configured = [];
    }
  }
  const builderBrains = await builderBrainsSet();
  const signIn = await checkSignIn(installedCoding);
  const runs = await firstAgentRun();

  return {
    installed,
    installedOperators,
    installedCoding,
    brains: [...configured, ...builderBrains],
    signedIn: signIn.signedIn,
    signInNotes: signIn.notes,
    runCount: runs.count,
    firstRun: runs.first
  };
}

let cachedFacts = null; // { at, value }
let pendingFacts = null; // the check in progress, shared by callers that arrive meanwhile

async function getFacts({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cachedFacts && now - cachedFacts.at < FACTS_TTL_MS) return cachedFacts.value;
  if (!pendingFacts) {
    pendingFacts = computeFacts()
      .then((value) => {
        cachedFacts = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        pendingFacts = null;
      });
  }
  return pendingFacts;
}

// ---- the checklist --------------------------------------------------------------

function installDetail(facts) {
  const { installedOperators, installedCoding } = facts;
  if (installedOperators.length && installedCoding.length) {
    return `${listNames([...installedOperators, ...installedCoding])} installed.`;
  }
  if (!installedOperators.length && !installedCoding.length) {
    return "Nothing installed yet. You need Hermes or OpenClaw, and Claude Code, Codex or Cursor.";
  }
  return installedOperators.length
    ? `${listNames(installedOperators)} installed. Still needed: Claude Code, Codex or Cursor.`
    : `${listNames(installedCoding)} installed. Still needed: Hermes or OpenClaw.`;
}

function brainDetail(facts) {
  if (facts.brains.length) return `${listNames(facts.brains)} ${facts.brains.length === 1 ? "has" : "have"} a brain set up.`;
  if (!facts.installedOperators.length) return "Install Hermes or OpenClaw first; they are the agents that need a brain.";
  return "Hermes and OpenClaw need a model to think with. Pick OpenRouter or a model on this computer.";
}

function signInDetail(facts) {
  if (facts.signedIn.length) return `${listNames(facts.signedIn)} is signed in.`;
  if (!facts.installedCoding.length) return "Install Claude Code, Codex or Cursor first, then sign in.";
  const unsure = facts.installedCoding.filter((id) => facts.signInNotes[id] === "unknown");
  if (unsure.length === facts.installedCoding.length) {
    return `Couldn't tell whether ${listNames(unsure)} ${unsure.length === 1 ? "is" : "are"} signed in.`;
  }
  return `${listNames(facts.installedCoding)} ${facts.installedCoding.length === 1 ? "is" : "are"} not signed in yet.`;
}

function firstRunDetail(facts) {
  if (facts.runCount > 0) return `${facts.runCount} task${facts.runCount === 1 ? "" : "s"} run so far.`;
  return "No task has run yet. A safe example only reads and describes.";
}

// The steps, in the order the person meets them. `state` is the stored choices.
export function buildSteps(facts, state) {
  const done = {
    install: facts.installedOperators.length > 0 && facts.installedCoding.length > 0,
    brain: facts.brains.length > 0,
    signin: facts.signedIn.length > 0,
    "first-run": facts.runCount > 0
  };
  const detail = {
    install: installDetail(facts),
    brain: brainDetail(facts),
    signin: signInDetail(facts),
    "first-run": firstRunDetail(facts)
  };
  const steps = SKIPPABLE_STEP_IDS.map((id) => ({
    id,
    // Done beats skipped: if the work got done after the person skipped it, say so.
    status: done[id] ? "done" : state.skipped.includes(id) ? "skipped" : "todo",
    detail: detail[id]
  }));
  steps.push({ id: "agent-computer", status: "unavailable", detail: "Coming in v0.5." });
  return steps;
}

export function countSteps(steps) {
  const countable = steps.filter((step) => step.status !== "unavailable");
  const done = countable.filter((step) => step.status === "done").length;
  const skipped = countable.filter((step) => step.status === "skipped").length;
  return { done, skipped, todo: countable.length - done - skipped, total: countable.length };
}

export async function getOnboarding({ refresh = false } = {}) {
  const [facts, state] = await Promise.all([getFacts({ refresh }), loadOnboardingState()]);
  const steps = buildSteps(facts, state);
  const counts = countSteps(steps);
  return {
    steps,
    counts,
    complete: counts.todo === 0,
    hidden: state.hidden,
    facts: {
      installed: facts.installed,
      brains: facts.brains,
      signedIn: facts.signedIn,
      firstRun: facts.firstRun
    }
  };
}

// Tests only: forget the remembered checks so the next call looks again.
export function resetOnboardingForTest() {
  cachedFacts = null;
  pendingFacts = null;
}

export function createOnboardingRouter() {
  // caseSensitive: "/" only; nothing else is served here.
  const router = express.Router({ caseSensitive: true });

  router.get("/", async (req, res, next) => {
    try {
      res.json(await getOnboarding({ refresh: req.query.refresh === "1" }));
    } catch (error) {
      next(error);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      await saveOnboardingState({ skipped: req.body.skipped, hidden: req.body.hidden });
      res.json(await getOnboarding());
    } catch (error) {
      if (error?.code === "invalid_skipped" || error?.code === "invalid_hidden") {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  return router;
}
