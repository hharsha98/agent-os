// The Setup page's pure logic (src/ui/setupGroupShared.ts): what the person's Plan choices
// become after a re-check, the group button's words, who needs OpenClaw's consent, what
// the step rail and the footers may claim, and when the Ready step may say "ready".
// Node strips the TypeScript types itself (Node >= 22.18; CI runs 24), so the .ts files are
// imported directly. setupGroupShared.ts must keep only `import type` imports.
// No server, no browser: the page itself is checked by the Setup probe of the UI audit.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as shared from "../src/ui/setupGroupShared.ts";
import { HOME_AGENTS, withTimeout } from "../src/ui/homeShared.ts";

const { STEP } = shared;

// ---- fixtures -------------------------------------------------------------------
const step = (agentId, action, over = {}) => ({
  id: `${agentId}-${action}`, agentId, action, title: `${action} ${agentId}`, description: "", changes: [],
  passwordMoments: [], default: true, sourceUrl: "", commandPreview: null, ...over
});
const detected = (installed, over = {}) => ({ installed, path: "", version: installed ? "1.0.0" : "", features: {}, ...over });
const notFound = (bin) => detected(false, { error: `${bin} was not found on PATH.` });
const broken = (label) => detected(false, { error: `${label} detection failed.` });
const entry = (d, service = null) => ({ detected: d, service });
const checkOf = (agents, over = {}) => ({ at: "2026-10-14T10:00:00.000Z", os: "darwin", arch: "arm64", agents, ...over });
const allInstalled = () => ({
  hermes: entry(detected(true), { running: true }),
  openclaw: entry(detected(true), { running: true }),
  claude: entry(detected(true)),
  codex: entry(detected(true)),
  cursor: entry(detected(true))
});
const brainOf = (hermes, openclaw) => ({ current: { hermes: { configured: hermes, summary: "x" }, openclaw: { configured: openclaw, summary: "x" } } });
const safe = { safety: { permissive: false } };
const apiError = () => Object.assign(new Error("job_already_running"), { name: "ApiError" });

// ---- Plan choices ---------------------------------------------------------------

test("defaultSelections: keep what is installed, never an update; install what is missing", () => {
  const plan = {
    steps: [
      step("hermes", "keep"), step("hermes", "update"),
      step("openclaw", "install"), step("openclaw", "prereq-node"),
      step("claude", "keep"),
      step("codex", "skip-unsupported"),
      step("cursor", "install")
    ]
  };
  assert.deepEqual(shared.defaultSelections(plan), { hermes: "keep", openclaw: "install", claude: "keep", codex: "unsupported", cursor: "install" });
});

test("mergeSelections keeps a choice the new plan still offers", () => {
  const plan = { steps: [step("claude", "keep"), step("claude", "update"), step("cursor", "install"), step("hermes", "keep"), step("openclaw", "keep")] };
  const merged = shared.mergeSelections({ claude: "update", cursor: "skip" }, plan);
  assert.equal(merged.claude, "update", "Update is still on offer, so it stays chosen");
  assert.equal(merged.cursor, "skip", "a coding agent switched to Skip stays skipped");
  assert.equal(merged.hermes, "keep");
});

test("mergeSelections drops a choice that no longer exists", () => {
  // Hermes has no update step (Task B1) and Cursor was just installed: both fall back to the default.
  const plan = { steps: [step("hermes", "keep"), step("cursor", "keep"), step("cursor", "update"), step("claude", "keep"), step("openclaw", "keep")] };
  const merged = shared.mergeSelections({ hermes: "update", cursor: "install", claude: "skip" }, plan);
  assert.equal(merged.hermes, "keep");
  assert.equal(merged.cursor, "keep", "an install choice is gone once the agent is installed");
  assert.equal(merged.claude, "keep", "a skip is gone once the agent is installed");
});

test("mergeSelections starts from the defaults when there is nothing earlier", () => {
  const plan = { steps: [step("hermes", "install"), step("openclaw", "keep"), step("claude", "keep")] };
  assert.deepEqual(shared.mergeSelections({}, plan), shared.defaultSelections(plan));
});

test("a refresh after a job keeps a choice made meanwhile, and only what the job changed falls back", () => {
  // Before: Cursor was missing (Install chosen), Claude installed (the person has just picked Update).
  const before = { hermes: "keep", openclaw: "keep", claude: "update", codex: "unsupported", cursor: "install" };
  // After a job that installed Cursor (it failed later on another step): Cursor is installed now, Claude still offers Update.
  const plan = {
    steps: [
      step("hermes", "keep"), step("openclaw", "keep"), step("claude", "keep"), step("claude", "update"),
      step("codex", "skip-unsupported"), step("cursor", "keep"), step("cursor", "update")
    ]
  };
  const after = shared.mergeSelections(before, plan);
  assert.equal(after.claude, "update", "the person's Update is not reset to Keep by the refresh");
  assert.equal(after.cursor, "keep", "Install is gone because the job installed it, so it reads Keep");
  assert.notDeepEqual(after, shared.defaultSelections(plan), "it is not the plain defaults");
});

test("SetupPage: the refresh after a finished job merges the Plan choices; nothing resets them to the defaults", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/pages/SetupPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /setSelections\(defaultSelections\(/, "no place on the page replaces the choices with the defaults");
  const refresh = page.slice(page.indexOf("async function refreshServerState"), page.indexOf("useEffect(() => {\n    void loadAll();"));
  assert.match(refresh, /setSelections\(\(prev\) => mergeSelections\(prev, planRes\)\)/, "refreshServerState merges into what the person chose");
});

// ---- "Update in Setup": the asked agent starts at Update ---------------------------------

test("withAskedUpdate: an agent that offers both Keep and Update starts at Update", () => {
  const plan = { steps: [step("openclaw", "keep"), step("openclaw", "update"), step("hermes", "keep"), step("claude", "keep"), step("claude", "update")] };
  const before = { hermes: "keep", openclaw: "keep", claude: "keep" };
  const after = shared.withAskedUpdate(before, plan, "openclaw");
  assert.equal(after.openclaw, "update");
  assert.equal(after.claude, "keep", "another agent's selection is untouched");
  assert.equal(after.hermes, "keep");
  assert.equal(before.openclaw, "keep", "the old object is not changed in place");
});

test("withAskedUpdate: no update step for the agent (Hermes) leaves the selections as they were", () => {
  const plan = { steps: [step("hermes", "keep"), step("openclaw", "keep"), step("openclaw", "update")] };
  const before = { hermes: "keep", openclaw: "keep" };
  assert.equal(shared.withAskedUpdate(before, plan, "hermes"), before, "the very same object");
});

test("withAskedUpdate: an agent that is not installed (install step) is left alone", () => {
  const plan = { steps: [step("openclaw", "install"), step("openclaw", "prereq-node"), step("hermes", "keep")] };
  const before = { hermes: "keep", openclaw: "install" };
  assert.equal(shared.withAskedUpdate(before, plan, "openclaw"), before);
});

test("withAskedUpdate: an unknown agent name is ignored", () => {
  const plan = { steps: [step("openclaw", "keep"), step("openclaw", "update")] };
  const before = { openclaw: "keep" };
  for (const name of ["nobody", "", "__proto__"]) assert.equal(shared.withAskedUpdate(before, plan, name), before, `"${name}"`);
});

test("withAskedUpdate: already at Update returns the same object", () => {
  const plan = { steps: [step("openclaw", "keep"), step("openclaw", "update")] };
  const before = { openclaw: "update" };
  assert.equal(shared.withAskedUpdate(before, plan, "openclaw"), before);
});

test("withAskedUpdate: a later re-read of the same plan keeps the Update choice", () => {
  const plan = { steps: [step("hermes", "keep"), step("openclaw", "keep"), step("openclaw", "update"), step("claude", "keep")] };
  const chosen = shared.withAskedUpdate(shared.mergeSelections({}, plan), plan, "openclaw");
  assert.equal(chosen.openclaw, "update");
  assert.equal(shared.mergeSelections(chosen, plan).openclaw, "update", "mergeSelections keeps a choice the plan still offers");
});

test("SetupPage applies the asked Update on the first landing and on a link followed while on Setup", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/pages/SetupPage.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("../src/ui/components/BrainPlanCard.tsx", import.meta.url), "utf8");
  const load = page.slice(page.indexOf("async function loadAll"), page.indexOf("async function refreshServerState"));
  assert.match(load, /if \(landing === STEP\.plan\) chooseAskedUpdate\(planRes\.value\)/, "the first landing, only when it ends on the Plan step");
  const listener = page.slice(page.indexOf('window.addEventListener("aos-navigate"') - 600, page.indexOf('window.addEventListener("aos-navigate"'));
  assert.match(listener, /if \(asked === STEP\.plan\) chooseAskedUpdate\(planRef\.current\)/, "a link followed while already on Setup");
  assert.match(card, /navigateTo\("setup", \{ step: "plan", agent: "openclaw" \}\)\}\s*>\s*Update in Setup/, "Update in Setup names OpenClaw");
  assert.match(card, /navigateTo\("setup", \{ step: "plan" \}\)\}\s*>\s*Install in Setup/, "Install in Setup is unchanged");
});

// ---- the first landing ---------------------------------------------------------------------

test("canLandYet: a step named in the address needs only the plan, never the brain options", () => {
  // The brain read is still running, failed or timed out: all three mean brainOk is false.
  assert.equal(shared.canLandYet({ asked: STEP.plan, planOk: true, brainOk: false }), true);
  assert.equal(shared.canLandYet({ asked: STEP.signin, planOk: true, brainOk: true }), true);
  assert.equal(shared.canLandYet({ asked: STEP.check, planOk: true, brainOk: false }), true, "step 0 (Check) is a step too, not 'no step'");
});

test("canLandYet: with no step in the address the automatic choice waits for the brain options", () => {
  assert.equal(shared.canLandYet({ asked: null, planOk: true, brainOk: false }), false);
  assert.equal(shared.canLandYet({ asked: null, planOk: true, brainOk: true }), true);
});

test("canLandYet: nothing lands without the plan", () => {
  for (const asked of [null, STEP.plan]) for (const brainOk of [false, true]) {
    assert.equal(shared.canLandYet({ asked, planOk: false, brainOk }), false, `asked ${asked}, brainOk ${brainOk}`);
  }
});

test("landingStep: the order is a restored job, then a person who moved, then the address, then the automatic choice", () => {
  assert.equal(shared.landingStep({ asked: STEP.plan, restored: STEP.install, moved: false, auto: STEP.brain }), STEP.install, "a running or failed job wins over the address");
  assert.equal(shared.landingStep({ asked: STEP.plan, restored: STEP.install, moved: true, auto: null }), STEP.install, "...and over a person who moved (as before)");
  assert.equal(shared.landingStep({ asked: STEP.plan, restored: null, moved: true, auto: null }), null, "a person who already moved is not moved");
  assert.equal(shared.landingStep({ asked: STEP.plan, restored: null, moved: false, auto: null }), STEP.plan, "the address lands even though the brain options are not in");
  assert.equal(shared.landingStep({ asked: STEP.check, restored: null, moved: false, auto: STEP.ready }), STEP.check, "the address wins over the automatic choice, Check included");
  assert.equal(shared.landingStep({ asked: null, restored: null, moved: false, auto: STEP.brain }), STEP.brain, "no step in the address: the automatic choice");
  assert.equal(shared.landingStep({ asked: null, restored: null, moved: false, auto: null }), null, "nothing to go on: stay");
});

test("SetupPage: loadAll puts each read on screen when it arrives and lands through the two helpers", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/pages/SetupPage.tsx", import.meta.url), "utf8");
  const load = page.slice(page.indexOf("async function loadAll"), page.indexOf("async function refreshServerState"));
  assert.doesNotMatch(load, /Promise\.allSettled\(\[\s*withTimeout\(getSetupPlan/, "the plan, brain and agents reads are not one allSettled that waits for the slowest");
  assert.match(load, /const planRes = await planRead/, "the plan is awaited on its own");
  assert.match(load, /canLandYet\(/);
  assert.match(load, /landingStep\(/);
  assert.match(load, /await Promise\.all\(\[brainShown, agentsShown\]\)/, "loadAll still ends only when every answer is on screen (Check again waits for it)");
  assert.match(load, /withTimeout\(getBrainOptions\(refresh\), BRAIN_READ_LIMIT_MS\)/, "the brain read keeps its own limit");
});

// ---- words for a request that got no answer ----------------------------------------

test("gotNoAnswer: only a refusal Agent OS sent itself (an ApiError) is an answer", () => {
  assert.equal(shared.gotNoAnswer(new TypeError("Failed to fetch")), true);
  assert.equal(shared.gotNoAnswer(new Error("Agent OS did not answer in time.")), true);
  assert.equal(shared.gotNoAnswer("a string"), true);
  assert.equal(shared.gotNoAnswer(apiError()), false);
});

test("readProblem never claims more than the page knows", () => {
  assert.equal(shared.readProblem(new TypeError("Failed to fetch"), "the setup plan"), "Agent OS did not answer in time, so the setup plan could not be read.");
  assert.equal(shared.readProblem(apiError(), "what is installed"), "Agent OS could not read what is installed.");
  for (const text of [shared.readProblem(new Error("x"), "a"), shared.readProblem(apiError(), "a")]) assert.doesNotMatch(text, /nothing was changed/i);
});

test("noAnswerWords: the time limit has its own sentence, a dropped connection never shows the browser's words", async () => {
  // The sentence must be exactly what withTimeout (homeShared.ts) rejects with.
  const timedOut = await withTimeout(new Promise(() => {}), 5).catch((e) => e);
  assert.equal(timedOut.message, shared.TIMEOUT_WORDS);
  assert.equal(shared.noAnswerWords(timedOut), "Agent OS did not answer in time.");
  assert.equal(shared.noAnswerWords(new TypeError("Failed to fetch")), "Agent OS did not answer.");
  assert.equal(shared.noAnswerWords(new TypeError("Load failed")), "Agent OS did not answer.");
  assert.equal(shared.noAnswerWords(undefined), "Agent OS did not answer.");
});

// ---- the group button ---------------------------------------------------------------

test("groupAction: no work, no button; only updates say Update; any install says Install", () => {
  assert.equal(shared.groupAction("coding", []), undefined);
  assert.equal(shared.groupAction("operators", []), undefined);
  assert.equal(shared.groupAction("coding", [step("claude", "update")]), "Update coding agents");
  assert.equal(shared.groupAction("coding", [step("claude", "update"), step("cursor", "install")]), "Install coding agents");
  assert.equal(shared.groupAction("coding", [step("cursor", "prereq-node")]), "Install coding agents");
  assert.equal(shared.groupAction("operators", [step("openclaw", "update")]), "Update OpenClaw");
  assert.equal(shared.groupAction("operators", [step("openclaw", "update"), step("hermes", "update")]), "Update OpenClaw + Hermes Agent");
  assert.equal(shared.groupAction("operators", [step("hermes", "install")]), "Set up Hermes + OpenClaw");
});

test("needsOpenClawConsent comes from the steps that would run", () => {
  assert.equal(shared.needsOpenClawConsent([]), false, "no OpenClaw steps (its installer is unreachable): no consent to wait for");
  assert.equal(shared.needsOpenClawConsent([step("hermes", "install")]), false, "installing Hermes alone needs no OpenClaw consent");
  assert.equal(shared.needsOpenClawConsent([step("openclaw", "install")]), true);
  assert.equal(shared.needsOpenClawConsent([step("openclaw", "prereq-node"), step("openclaw", "install")]), true);
  assert.equal(shared.needsOpenClawConsent([step("openclaw", "prereq-node")]), true);
  assert.equal(shared.needsOpenClawConsent([step("openclaw", "update")]), false);
  assert.equal(shared.needsOpenClawConsent([step("hermes", "install"), step("openclaw", "install")]), true);
});

test("reaskNote: the real outcome replaces 'may not have gone through'", () => {
  assert.equal(shared.reaskNote("cancel", "cancelled"), "", "it was cancelled: nothing to warn about");
  assert.equal(shared.reaskNote("cancel", "succeeded"), "");
  assert.match(shared.reaskNote("cancel", "running"), /cancel did not go through.*still running/);
  assert.equal(shared.reaskNote("retry", "running"), "", "the retry started");
  assert.equal(shared.reaskNote("retry", "succeeded"), "");
  assert.match(shared.reaskNote("retry", "failed"), /retry did not go through/);
  assert.doesNotMatch(shared.reaskNote("retry", "failed"), /may not/);
});

// ---- what the check says about the agents ----------------------------------------------

test("agentFact: not on the computer is missing; a broken detection or a missing answer is unknown", () => {
  assert.equal(shared.agentFact(detected(true)), "installed");
  assert.equal(shared.agentFact(notFound("hermes")), "missing");
  assert.equal(shared.agentFact(detected(false)), "missing", "installed:false with no error is simply not there");
  assert.equal(shared.agentFact(broken("Hermes")), "unknown");
  assert.equal(shared.agentFact(undefined), "unknown");
  assert.equal(shared.agentFact(null), "unknown");
  assert.equal(shared.agentFact({}), "unknown", "installed is not a boolean");
});

test("agentTally and checkSummary: the count says what could not be told", () => {
  assert.equal(shared.agentTally(null), null);
  assert.equal(shared.agentTally({}), null);
  assert.equal(shared.checkSummary(null), undefined, "no agents in the answer: no count");
  assert.equal(shared.checkSummary(checkOf(undefined)), undefined);
  assert.equal(shared.checkSummary(checkOf(allInstalled())), "Done · 5 of 5 agents found");
  const some = { ...allInstalled(), hermes: entry(notFound("hermes")), codex: entry(notFound("codex")) };
  assert.equal(shared.checkSummary(checkOf(some)), "Done · 3 of 5 agents found", "not installed is known, so no 'unknown'");
  const unsure = { ...allInstalled(), hermes: entry(broken("Hermes")) };
  assert.equal(shared.checkSummary(checkOf(unsure)), "Done · 4 of 5 found, 1 unknown");
  const missingEntry = allInstalled();
  delete missingEntry.cursor;
  assert.deepEqual(shared.agentTally(checkOf(missingEntry)), { found: 4, missing: 0, unknown: 1, total: 5 });
});

// ---- the footers ---------------------------------------------------------------------

test("checkFooterNote: 'Nothing ... was changed' only before Setup has run anything", () => {
  const base = { checkError: false, hasCheck: true, jobUnknown: false, installSteps: null, brainJob: false };
  assert.equal(shared.checkFooterNote(base), "Nothing on this computer was changed.");
  assert.equal(shared.checkFooterNote({ ...base, checkError: true }), "The check did not finish.");
  assert.equal(shared.checkFooterNote({ ...base, hasCheck: false }), "Reading what is installed.");
  assert.equal(shared.checkFooterNote({ ...base, installSteps: 3 }), "Earlier in this session Setup ran 3 steps.");
  assert.equal(shared.checkFooterNote({ ...base, installSteps: 1 }), "Earlier in this session Setup ran 1 step.");
  assert.equal(shared.checkFooterNote({ ...base, brainJob: true }), "Earlier in this session Setup worked on an AI brain.");
  assert.equal(shared.checkFooterNote({ ...base, installSteps: 2, brainJob: true }), "Earlier in this session Setup ran 2 steps and worked on an AI brain.");
  assert.equal(shared.checkFooterNote({ ...base, jobUnknown: true }), "", "an install it could not ask about: no claim either way");
  for (const o of [{ installSteps: 3 }, { brainJob: true }, { jobUnknown: true }]) {
    assert.doesNotMatch(shared.checkFooterNote({ ...base, ...o }), /was changed/);
  }
});

test("brainFooterNote: 'not installed' only when the check said so", () => {
  const base = { running: false, hasBrain: true, brainError: false, operators: ["missing", "missing"], brainOk: true };
  assert.equal(shared.brainFooterNote({ ...base, running: true }), "Giving your agents a brain…");
  assert.equal(shared.brainFooterNote({ ...base, hasBrain: false }), "Reading the brain options.");
  assert.match(shared.brainFooterNote({ ...base, hasBrain: false, brainError: true }), /did not load/);
  assert.equal(shared.brainFooterNote(base), "Hermes and OpenClaw are not installed, so there is no brain to set.");
  // The check did not report the agents (or a detection broke): the footer does not guess.
  assert.equal(shared.brainFooterNote({ ...base, operators: ["unknown", "unknown"] }), "Agent OS could not tell whether Hermes and OpenClaw are installed.");
  assert.equal(shared.brainFooterNote({ ...base, operators: ["missing", "unknown"] }), "Agent OS could not tell whether Hermes and OpenClaw are installed.");
  assert.equal(shared.brainFooterNote({ ...base, operators: ["installed", "unknown"], brainOk: true }), "Every installed agent has a brain.");
  assert.equal(shared.brainFooterNote({ ...base, operators: ["installed", "missing"], brainOk: false }), "Pick a brain above, or skip for now.");
});

// ---- the step rail -------------------------------------------------------------------------

const facts = (over = {}) => ({
  stepIndex: STEP.ready,
  check: checkOf(allInstalled()),
  planLoaded: true,
  installJob: null,
  jobUnknown: false,
  brainLoaded: true,
  brainStatus: "idle",
  operators: [{ fact: "installed", configured: true }, { fact: "installed", configured: true }],
  coding: { installed: true, unknown: false },
  signIn: { signedIn: 3, installed: 3, unchecked: 0 },
  readyProblems: null,
  skipped: [],
  ...over
});
const rail = (index, over) => shared.railStep(index, facts(over));

test("railStep: the step on screen is current, later ones are not reached", () => {
  assert.deepEqual(rail(STEP.plan, { stepIndex: STEP.plan }), { state: "current" });
  assert.deepEqual(rail(STEP.signin, { stepIndex: STEP.plan }), { state: "not-reached" });
});

test("railStep: a step with its evidence is Done and says what it found", () => {
  assert.deepEqual(rail(STEP.check), { state: "done", summary: "Done · 5 of 5 agents found" });
  assert.deepEqual(rail(STEP.plan), { state: "done", summary: "Done · no install run" });
  assert.deepEqual(rail(STEP.install), { state: "done", summary: "Done · nothing to install" });
  assert.deepEqual(rail(STEP.brain), { state: "done", summary: "Done · 2 of 2 have a brain" });
  assert.deepEqual(rail(STEP.signin), { state: "done", summary: "Done · 3 of 3 signed in" });
  const job = { status: "succeeded", steps: [{ status: "succeeded" }, { status: "succeeded" }] };
  assert.deepEqual(rail(STEP.plan, { installJob: job }), { state: "done", summary: "Done · 2 steps chosen" });
  assert.deepEqual(rail(STEP.install, { installJob: job }), { state: "done", summary: "Done · 2 of 2 steps" });
});

test("railStep: a step the page never saw data for is Skipped or Not checked, never a green Done", () => {
  // AI brain, brain options never loaded: reached by Skip for now, or by a link straight to a later step.
  assert.deepEqual(rail(STEP.brain, { brainLoaded: false, skipped: [STEP.brain] }), { state: "partial", summary: "Skipped" });
  assert.deepEqual(rail(STEP.brain, { brainLoaded: false }), { state: "partial", summary: "Not checked" });
  // Sign in never opened (or still loading): no summary came back.
  assert.deepEqual(rail(STEP.signin, { signIn: null }), { state: "partial", summary: "Not checked" });
  // The plan could not be loaded and the person skipped it.
  assert.deepEqual(rail(STEP.plan, { planLoaded: false, skipped: [STEP.plan] }), { state: "partial", summary: "Skipped" });
  assert.deepEqual(rail(STEP.plan, { planLoaded: false }), { state: "partial", summary: "Not checked" });
  // An earlier install the page could not ask about.
  assert.deepEqual(rail(STEP.install, { jobUnknown: true }), { state: "partial", summary: "Not checked" });
  // No check at all.
  assert.deepEqual(rail(STEP.check, { check: null }), { state: "partial", summary: "Not checked" });
  // Not needed is a claim too: it needs the check to have said the agents are not there.
  const unknownOps = [{ fact: "unknown", configured: false }, { fact: "unknown", configured: false }];
  assert.deepEqual(rail(STEP.brain, { operators: unknownOps }), { state: "partial", summary: "Not checked" });
  assert.deepEqual(rail(STEP.signin, { coding: { installed: false, unknown: true } }), { state: "partial", summary: "Not checked" });
  const missingOps = [{ fact: "missing", configured: false }, { fact: "missing", configured: false }];
  assert.deepEqual(rail(STEP.brain, { operators: missingOps }), { state: "done", summary: "Done · not needed" });
  assert.deepEqual(rail(STEP.signin, { coding: { installed: false, unknown: false } }), { state: "done", summary: "Done · not needed" });
  // Skipping the plan with work on offer, when no install ran, is a skip; once an install ran it is Done.
  assert.deepEqual(rail(STEP.plan, { skipped: [STEP.plan] }), { state: "partial", summary: "Skipped" });
});

test("railStep: part of the job left is Not finished, with the count", () => {
  const half = [{ fact: "installed", configured: true }, { fact: "installed", configured: false }];
  assert.deepEqual(rail(STEP.brain, { operators: half }), { state: "partial", summary: "Not finished · 1 of 2 have a brain" });
  assert.deepEqual(rail(STEP.signin, { signIn: { signedIn: 1, installed: 3, unchecked: 0 } }), { state: "partial", summary: "Not finished · 1 of 3 signed in" });
  assert.deepEqual(rail(STEP.signin, { signIn: { signedIn: 2, installed: 2, unchecked: 1 } }), { state: "partial", summary: "Not finished · 2 of 2 signed in · 1 not checked" });
  assert.deepEqual(rail(STEP.install, { installJob: { status: "running", steps: [{ status: "running" }] } }), { state: "partial", summary: "Still running" });
});

test("railStep: a failed or cancelled install and a failed brain job are failed wherever the person is", () => {
  const failed = { status: "failed", steps: [{ status: "succeeded" }, { status: "failed" }, { status: "pending" }] };
  assert.deepEqual(rail(STEP.install, { installJob: failed, stepIndex: STEP.install }), { state: "failed", summary: "Failed · 1 of 3 steps done" });
  assert.deepEqual(rail(STEP.install, { installJob: { ...failed, status: "cancelled" } }), { state: "failed", summary: "Cancelled · 1 of 3 steps done" });
  assert.deepEqual(rail(STEP.brain, { brainStatus: "failed" }), { state: "failed", summary: "Failed · try again" });
});

test("railStep: Ready is done only when the final check found nothing to fix", () => {
  assert.deepEqual(rail(STEP.ready, { readyProblems: 0 }), { state: "done", summary: "Done · all set" });
  assert.deepEqual(rail(STEP.ready, { readyProblems: 2 }), { state: "current", summary: "2 things left to fix" });
  assert.deepEqual(rail(STEP.ready, { readyProblems: 1 }), { state: "current", summary: "1 thing left to fix" });
  assert.deepEqual(rail(STEP.ready, { readyProblems: null }), { state: "current", summary: undefined }, "unknown: no count, no 'all set'");
});

// ---- the Ready step ---------------------------------------------------------------------------

test("readyVerdict: everything in place is ready", () => {
  const v = shared.readyVerdict(checkOf(allInstalled()), brainOf(true, true), { hermes: safe, openclaw: safe }, false);
  assert.equal(v.problems, 0);
  assert.equal(v.unknown, 0);
  assert.equal(v.ready, true);
  assert.equal(v.railCount, 0);
});

test("readyVerdict: an installed agent with a row that cannot be read is unknown, never ready", () => {
  // The agent's own detail could not be fetched: "Safe defaults applied" is "—".
  const noDetail = shared.readyVerdict(checkOf(allInstalled()), brainOf(true, true), { hermes: safe, openclaw: null }, false);
  assert.equal(noDetail.unknown, 1);
  assert.equal(noDetail.problems, 0);
  assert.equal(noDetail.ready, false, "a dash is not 'in place'");
  assert.equal(noDetail.unsure, true);
  assert.equal(noDetail.partial, true);
  assert.equal(noDetail.railCount, null, "the rail gets no count and so no 'all set'");
  assert.equal(noDetail.agents[1].safeDefaults, null);
  // The brain options did not report this agent.
  const noBrain = shared.readyVerdict(checkOf(allInstalled()), { current: { hermes: { configured: true } } }, { hermes: safe, openclaw: safe }, false);
  assert.equal(noBrain.unknown, 1);
  assert.equal(noBrain.ready, false);
  assert.equal(noBrain.railCount, null);
  // Two rows unknown on one agent count twice.
  assert.equal(shared.readyVerdict(checkOf(allInstalled()), null, { hermes: null, openclaw: safe }, false).unknown, 3);
});

test("readyVerdict: an approvals setting Agent OS could not read is unknown ('—'), never 'safe defaults applied'", () => {
  const unread = { safety: { permissive: false, known: false } };
  const v = shared.readyVerdict(checkOf(allInstalled()), brainOf(true, true), { hermes: unread, openclaw: safe }, false);
  assert.equal(v.agents[0].safeDefaults, null);
  assert.equal(v.unknown, 1);
  assert.equal(v.problems, 0);
  assert.equal(v.ready, false, "a dash is not 'in place'");
  // `known: true`, or no `known` at all (older servers), reads as before.
  for (const known of [true, undefined]) {
    const read = shared.readyVerdict(checkOf(allInstalled()), brainOf(true, true), { hermes: { safety: { permissive: false, known } }, openclaw: safe }, false);
    assert.equal(read.agents[0].safeDefaults, true, `known: ${known}`);
    assert.equal(read.ready, true);
  }
  // The row's words follow the same rule.
  assert.equal(shared.safeDefaultsWords(true, unread), "—");
  assert.equal(shared.safeDefaultsWords(true, { safety: { permissive: false, known: true } }), "Permissive mode is off");
  assert.equal(shared.safeDefaultsWords(true, { safety: { permissive: true } }), "Permissive mode is on");
  assert.equal(shared.safeDefaultsWords(true, null), "—");
  assert.equal(shared.safeDefaultsWords(false, safe), "—");
});

test("readyVerdict: a missing agent is a problem to fix; an agent that could not be told is unknown", () => {
  const missing = shared.readyVerdict(checkOf({ ...allInstalled(), hermes: entry(notFound("hermes")), openclaw: entry(notFound("openclaw")) }), brainOf(false, false), {}, false);
  assert.equal(missing.problems, 2);
  assert.equal(missing.unknown, 0);
  assert.equal(missing.ready, false);
  assert.equal(missing.railCount, 2);
  const brokenHermes = shared.readyVerdict(checkOf({ ...allInstalled(), hermes: entry(broken("Hermes")) }), brainOf(true, true), { openclaw: safe }, false);
  assert.equal(brokenHermes.unknown, 1);
  assert.equal(brokenHermes.problems, 0);
  assert.equal(brokenHermes.ready, false);
});

test("readyVerdict: problems are counted row by row; Hermes on an Intel Mac counts for nothing", () => {
  const rows = shared.readyVerdict(
    checkOf({ ...allInstalled(), openclaw: entry(detected(true), { running: false }) }),
    brainOf(true, false),
    { hermes: { safety: { permissive: true } }, openclaw: safe },
    false
  );
  assert.equal(rows.problems, 3, "Hermes: permissive mode; OpenClaw: no brain and gateway stopped");
  const intel = shared.readyVerdict(checkOf({ ...allInstalled(), hermes: entry(notFound("hermes")) }, { isIntelMac: true }), brainOf(false, true), { openclaw: safe }, false);
  assert.equal(intel.agents[0].unsupported, true);
  assert.equal(intel.problems, 0);
  assert.equal(intel.ready, true);
});

test("readyVerdict: a failed re-load, or a partial answer from the server, is not ready", () => {
  const args = [checkOf(allInstalled()), brainOf(true, true), { hermes: safe, openclaw: safe }];
  const failedLoad = shared.readyVerdict(...args, true);
  assert.equal(failedLoad.ready, false);
  assert.equal(failedLoad.railCount, null);
  assert.equal(shared.readyVerdict(checkOf(allInstalled(), { error: "system check failed" }), brainOf(true, true), { hermes: safe, openclaw: safe }, false).ready, false);
  const noAgents = shared.readyVerdict(checkOf(undefined), brainOf(true, true), {}, false);
  assert.equal(noAgents.ready, false);
  assert.equal(noAgents.partial, true);
});

// ---- Final review fixes ------------------------------------------------------

test("Setup, Agents and Home call the five agents by the same names", () => {
  // Home's list is the one the Agents page also shows (the server's own labels).
  for (const agent of HOME_AGENTS) assert.equal(shared.AGENT_NAMES[agent.id], agent.name, agent.id);
  assert.deepEqual(Object.keys(shared.AGENT_NAMES).sort(), HOME_AGENTS.map((a) => a.id).sort());
  assert.equal(shared.AGENT_NAMES.codex, "Codex CLI");
  assert.equal(shared.AGENT_NAMES.cursor, "Cursor Agent");
});
