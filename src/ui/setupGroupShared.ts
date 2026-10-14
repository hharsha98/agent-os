// Small shared facts for the Setup Assistant's two groups, so the Plan screen,
// the confirm dialog and the progress screen all say the same thing.
import type { AgentDetail, BrainOptionsResponse, SetupPlan, SetupPlanStep, SystemCheck } from "../setupApi";

export const OPERATOR_IDS = ["hermes", "openclaw"] as const;
export const CODING_IDS = ["claude", "codex", "cursor"] as const;

// The names every page uses for the five agents (the same words as the Agents page, which shows the server's
// own labels, and as Home's HOME_AGENTS in homeShared.ts). test/home-shared.test.js fails if the two lists
// drift apart: Node cannot follow an extensionless import, so this file keeps its own copy.
export const AGENT_NAMES: Record<string, string> = {
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor Agent"
};

export function formatSize(mb: number) {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.max(10, Math.round(mb / 10) * 10)} MB`;
}

export function formatMinutes(range: [number, number]) {
  const [low, high] = range;
  return low === high ? `${low} min` : `${low}–${high} min`;
}

// Adds up the "about" figures of the steps that would run. `complete` is false
// when a step had no figure, so the screen never shows a partial sum as a total.
export function totalsOf(steps: SetupPlanStep[]) {
  let mb = 0;
  let low = 0;
  let high = 0;
  let complete = steps.length > 0;
  for (const step of steps) {
    if (typeof step.approxMb !== "number" || !step.approxMinutes) {
      complete = false;
      continue;
    }
    mb += step.approxMb;
    low += step.approxMinutes[0];
    high += step.approxMinutes[1];
  }
  return { mb, minutes: [low, high] as [number, number], complete };
}

// What the person chose for one agent on the Plan step. "skip" is a coding agent
// switched to Skip: nothing is done for it.
export type PlanSelection = "keep" | "update" | "install" | "unsupported" | "skip";

// True when a failed request got NO answer from Agent OS at all: the network
// dropped, or withTimeout (homeShared.ts) gave up. A refusal Agent OS sent
// itself is an ApiError (api.ts), so it is told apart by name, which keeps this
// file free of runtime imports. The page cannot know whether the server saw such
// a request, so its words never say "nothing was changed" for it.
export function gotNoAnswer(error: unknown): boolean {
  return !(error instanceof Error && error.name === "ApiError");
}

// What a check answer says about ONE agent:
//   installed  the program is there;
//   missing    it is simply not on this computer (the normal state of a new computer);
//   unknown    the check did not report it, or finding out failed, which is not the same as missing.
// Every agent's detect() (server/runtime/agents/*.js) answers `installed: false` with an `error`
// that says "<name> was not found on PATH..." when the program is not there, so that error alone
// does not make the answer unknown. Any other error means the detection itself broke.
export type AgentFact = "installed" | "missing" | "unknown";

export function agentFact(detected: { installed?: unknown; error?: string } | null | undefined): AgentFact {
  if (!detected || typeof detected.installed !== "boolean") return "unknown";
  if (detected.installed) return "installed";
  if (detected.error && !/was not found/i.test(detected.error)) return "unknown";
  return "missing";
}

// ---- the page's pure logic ------------------------------------------------------
// Everything below is plain functions of plain data, so node can test it without a
// browser (test/setup-page-logic.test.js). Keep this file free of runtime imports.

export const ALL_AGENT_IDS = [...OPERATOR_IDS, ...CODING_IDS];

// The six steps by position. The page and the rail both count from here.
export const STEP = { check: 0, plan: 1, install: 2, brain: 3, signin: 4, ready: 5 } as const;

export type GroupId = "operators" | "coding";

export function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

// What each agent should do by default: never an update, never a reinstall.
export function defaultSelections(plan: Pick<SetupPlan, "steps">) {
  const defaults: Record<string, PlanSelection> = {};
  for (const agentId of ALL_AGENT_IDS) {
    const steps = plan.steps.filter((s) => s.agentId === agentId);
    if (steps.some((s) => s.action === "skip-unsupported")) defaults[agentId] = "unsupported";
    else if (steps.some((s) => s.action === "keep")) defaults[agentId] = "keep";
    else defaults[agentId] = "install";
  }
  return defaults;
}

// A re-check must not throw away what the person already chose on the Plan step:
// each earlier choice is kept while the new plan still offers it, and only a choice
// that no longer exists falls back to the default.
export function mergeSelections(prev: Record<string, PlanSelection>, plan: Pick<SetupPlan, "steps">) {
  const next = defaultSelections(plan);
  for (const agentId of ALL_AGENT_IDS) {
    const steps = plan.steps.filter((s) => s.agentId === agentId);
    const has = (action: string) => steps.some((s) => s.action === action);
    const was = prev[agentId];
    const installable = !has("keep") && !has("skip-unsupported") && (has("install") || has("prereq-node"));
    const stillOffered =
      (was === "keep" && has("keep")) ||
      (was === "update" && has("keep") && has("update")) ||
      ((was === "install" || was === "skip") && installable);
    if (stillOffered) next[agentId] = was;
  }
  return next;
}

// Why a read failed, in words that do not claim more than the page knows. A read
// changes nothing, but a read that got no answer is simply "no answer".
export function readProblem(error: unknown, what: string) {
  return gotNoAnswer(error)
    ? `Agent OS did not answer in time, so ${what} could not be read.`
    : `Agent OS could not read ${what}.`;
}

// The words for a request that got no answer. The time limit (withTimeout in
// homeShared.ts) has its own sentence; anything else that dropped the connection
// is the browser's raw "Failed to fetch" / "Load failed", which a person cannot use.
export const TIMEOUT_WORDS = "Agent OS did not answer in time.";
export function noAnswerWords(error: unknown): string {
  return error instanceof Error && error.message === TIMEOUT_WORDS ? TIMEOUT_WORDS : "Agent OS did not answer.";
}

// The group's button: what pressing it will do, from the steps its choices run.
// No work, no button. Only updates say "Update", so the button never promises an install.
export function groupAction(group: GroupId, work: SetupPlanStep[]): string | undefined {
  if (!work.length) return undefined;
  const installs = work.some((s) => s.action === "install" || s.action === "prereq-node");
  if (group === "coding") return installs ? "Install coding agents" : "Update coding agents";
  if (installs) return "Set up Hermes + OpenClaw";
  const names = Array.from(new Set(work.map((s) => AGENT_NAMES[s.agentId] || s.agentId)));
  return `Update ${names.join(" + ")}`;
}

// OpenClaw's consent box is only drawn when OpenClaw would really be installed, so
// the need for it comes from the steps that would run, not from the row's choice:
// when its installer site is unreachable the plan has no OpenClaw steps, no box is
// shown, and nothing may wait for a tick nobody can give.
export function needsOpenClawConsent(steps: Pick<SetupPlanStep, "agentId" | "action">[]): boolean {
  return steps.some((s) => s.agentId === "openclaw" && (s.action === "install" || s.action === "prereq-node"));
}

// After a cancel or retry that got no answer, the page asks the job once more. This is
// what to say once that answer is in: nothing when things went the way the person
// asked (the Install step shows it), and the plain outcome when they did not.
export function reaskNote(kind: "cancel" | "retry", status: string): string {
  if (kind === "cancel") return status === "running" ? "The cancel did not go through. The install is still running." : "";
  return status === "running" || status === "succeeded"
    ? ""
    : "The retry did not go through. The install is still stopped. Press Retry to try again.";
}

// ---- what the check says about the five agents ---------------------------------------

type CheckLike = Pick<SystemCheck, "agents"> | null | undefined;

// How many of the five agents were found, how many are known not to be there, and how
// many the check could not tell. null when the check did not report agents at all.
export function agentTally(check: CheckLike) {
  if (!check?.agents) return null;
  const tally = { found: 0, missing: 0, unknown: 0, total: ALL_AGENT_IDS.length };
  for (const id of ALL_AGENT_IDS) {
    const fact = agentFact(check.agents[id]?.detected);
    if (fact === "installed") tally.found += 1;
    else if (fact === "missing") tally.missing += 1;
    else tally.unknown += 1;
  }
  return tally;
}

// "Done · 3 of 5 agents found", or "Done · 3 of 5 found, 1 unknown" when some could not be told.
export function checkSummary(check: CheckLike): string | undefined {
  const t = agentTally(check);
  if (!t) return undefined;
  return t.unknown > 0 ? `Done · ${t.found} of ${t.total} found, ${t.unknown} unknown` : `Done · ${t.found} of ${t.total} agents found`;
}

// The Check footer. "Nothing on this computer was changed." is only true before Setup
// has run anything in this session; after a job it says what ran, or says nothing.
export function checkFooterNote(o: {
  checkError: boolean;
  hasCheck: boolean;
  // An earlier install exists but the page could not ask about it.
  jobUnknown: boolean;
  // How many steps the install job has (null = no install job).
  installSteps: number | null;
  // The AI brain step has started or finished a job.
  brainJob: boolean;
}): string {
  if (o.checkError) return "The check did not finish.";
  if (!o.hasCheck) return "Reading what is installed.";
  if (o.jobUnknown) return "";
  const ran: string[] = [];
  if (o.installSteps !== null) ran.push(`ran ${plural(o.installSteps, "step")}`);
  if (o.brainJob) ran.push("worked on an AI brain");
  if (ran.length) return `Earlier in this session Setup ${ran.join(" and ")}.`;
  return "Nothing on this computer was changed.";
}

// The AI brain footer, from what the page knows.
export function brainFooterNote(o: {
  running: boolean;
  hasBrain: boolean;
  brainError: boolean;
  // The facts for Hermes and OpenClaw, in that order.
  operators: AgentFact[];
  brainOk: boolean;
}): string {
  if (o.running) return "Giving your agents a brain…";
  if (!o.hasBrain) {
    return o.brainError ? "The brain options did not load. You can skip for now and set a brain later." : "Reading the brain options.";
  }
  if (!o.operators.some((f) => f === "installed")) {
    return o.operators.every((f) => f === "missing")
      ? "Hermes and OpenClaw are not installed, so there is no brain to set."
      : "Agent OS could not tell whether Hermes and OpenClaw are installed.";
  }
  return o.brainOk ? "Every installed agent has a brain." : "Pick a brain above, or skip for now.";
}

// ---- the step rail -------------------------------------------------------------------
// One state and one line per step, from what the page KNOWS. A step that was passed
// without the page ever seeing its data is "Skipped" (the person pressed Skip) or "Not
// checked", never a green Done: Done needs evidence.

export type RailState = "done" | "current" | "not-reached" | "failed" | "partial";

export interface RailFacts {
  stepIndex: number;
  check: CheckLike;
  planLoaded: boolean;
  installJob: { status: string; steps: { status: string }[] } | null;
  jobUnknown: boolean;
  brainLoaded: boolean;
  brainStatus: string;
  // Hermes and OpenClaw: what the check says, and whether the brain options say it has a brain.
  operators: { fact: AgentFact; configured: boolean }[];
  // Coding agents: is one installed (counting what the install job just did), and could one not be told.
  coding: { installed: boolean; unknown: boolean };
  signIn: { signedIn: number; installed: number; unchecked: number } | null;
  readyProblems: number | null;
  // Steps the person left with a Skip button.
  skipped: readonly number[];
}

export function railStep(index: number, f: RailFacts): { state: RailState; summary?: string } {
  const job = f.installJob;
  const noEvidence = (): { state: RailState; summary: string } => ({
    state: "partial",
    summary: f.skipped.includes(index) ? "Skipped" : "Not checked"
  });

  if (index === STEP.install && job && (job.status === "failed" || job.status === "cancelled")) {
    const finished = job.steps.filter((s) => s.status === "succeeded").length;
    const word = job.status === "failed" ? "Failed" : "Cancelled";
    return { state: "failed", summary: `${word} · ${finished} of ${job.steps.length} steps done` };
  }
  if (index === STEP.brain && f.brainStatus === "failed") return { state: "failed", summary: "Failed · try again" };
  if (index === STEP.ready && index === f.stepIndex) {
    // Ready is done only when the final check found nothing left to fix.
    if (f.readyProblems === 0) return { state: "done", summary: "Done · all set" };
    return { state: "current", summary: f.readyProblems ? `${plural(f.readyProblems, "thing")} left to fix` : undefined };
  }
  if (index === f.stepIndex) return { state: "current" };
  if (index > f.stepIndex) return { state: "not-reached" };

  // From here on the step was passed.
  if (index === STEP.check) {
    return f.check ? { state: "done", summary: checkSummary(f.check) } : noEvidence();
  }
  if (index === STEP.plan) {
    if (!f.planLoaded) return noEvidence();
    if (job) return { state: "done", summary: `Done · ${plural(job.steps.length, "step")} chosen` };
    if (f.jobUnknown) return { state: "done" };
    return f.skipped.includes(index) ? noEvidence() : { state: "done", summary: "Done · no install run" };
  }
  if (index === STEP.install) {
    if (job) {
      if (job.status === "succeeded") return { state: "done", summary: `Done · ${job.steps.length} of ${job.steps.length} steps` };
      return { state: "partial", summary: "Still running" };
    }
    return f.jobUnknown ? noEvidence() : { state: "done", summary: "Done · nothing to install" };
  }
  if (index === STEP.brain) {
    if (!f.brainLoaded) return noEvidence();
    const installed = f.operators.filter((o) => o.fact === "installed");
    if (!installed.length) {
      return f.operators.every((o) => o.fact === "missing") ? { state: "done", summary: "Done · not needed" } : noEvidence();
    }
    const set = installed.filter((o) => o.configured).length;
    const partial = set < installed.length;
    return { state: partial ? "partial" : "done", summary: `${partial ? "Not finished" : "Done"} · ${set} of ${installed.length} have a brain` };
  }
  if (index === STEP.signin) {
    if (!f.coding.installed) return f.coding.unknown ? noEvidence() : { state: "done", summary: "Done · not needed" };
    const s = f.signIn;
    if (!s) return noEvidence();
    if (s.installed === 0 && s.unchecked === 0) return { state: "done", summary: "Done · not needed" };
    const partial = (s.installed > 0 && s.signedIn < s.installed) || s.unchecked > 0;
    const unchecked = s.unchecked > 0 ? ` · ${s.unchecked} not checked` : "";
    return { state: partial ? "partial" : "done", summary: `${partial ? "Not finished" : "Done"} · ${s.signedIn} of ${s.installed} signed in${unchecked}` };
  }
  return { state: "done" };
}

// ---- the Ready step -------------------------------------------------------------------

export interface ReadyAgentState {
  agentId: "hermes" | "openclaw";
  // Hermes on an Intel Mac: not set up here, so it counts for nothing either way.
  unsupported: boolean;
  fact: AgentFact;
  installed: boolean;
  // true = in place, false = needs attention, null = not known (shown as "—").
  configured: boolean | null;
  serviceRunning: boolean | null;
  safeDefaults: boolean | null;
  problems: number;
  unknown: number;
}

// The words under "Safe defaults applied": "—" when the agent's detail was not read, or when its
// approvals setting could not be read (known: false), never a claim about a setting nobody saw.
export function safeDefaultsWords(installed: boolean, detail: { safety?: { permissive?: boolean; known?: boolean } } | null | undefined): string {
  if (!installed || !detail?.safety || detail.safety.known === false) return "—";
  return detail.safety.permissive ? "Permissive mode is on" : "Permissive mode is off";
}

// What the final check knows about each always-on agent, and what it does not. A row
// whose state is unknown (null) on an agent that IS installed counts as unknown, so
// the headline never says "ready" over a dash.
export function readyVerdict(
  check: SystemCheck,
  brain: BrainOptionsResponse | null,
  details: Record<string, AgentDetail | null>,
  // The last load failed; what is on screen is from an earlier one.
  hadProblem: boolean
) {
  const agents: ReadyAgentState[] = (["hermes", "openclaw"] as const).map((agentId) => {
    const entry = check.agents?.[agentId];
    const unsupported = agentId === "hermes" && Boolean(check.isIntelMac);
    const fact = agentFact(entry?.detected);
    const installed = fact === "installed";
    const configured = brain?.current?.[agentId]?.configured ?? null;
    const serviceRunning = installed ? Boolean(entry?.service?.running) : null;
    const detail = details[agentId];
    const safeDefaults = installed ? (detail?.safety && detail.safety.known !== false ? !detail.safety.permissive : null) : null;
    let problems = 0;
    let unknown = 0;
    if (!unsupported) {
      // An agent that is simply not installed ("hermes was not found on PATH.") IS known, and is a
      // problem to fix. Only an answer that was not given, or a detection that itself broke, is not.
      if (fact === "unknown") unknown = 1;
      else if (!installed) problems = 1;
      else {
        const rows = [configured, serviceRunning, safeDefaults];
        problems = rows.filter((v) => v === false).length;
        unknown = rows.filter((v) => v === null).length;
      }
    }
    return { agentId, unsupported, fact, installed, configured, serviceRunning, safeDefaults, problems, unknown };
  });
  const problems = agents.reduce((n, a) => n + a.problems, 0);
  const unknown = agents.reduce((n, a) => n + a.unknown, 0);
  // The server answered, but part of the check failed on its side, or some row could not be read.
  const partial = Boolean(check.error || !check.agents || unknown > 0);
  const unsure = hadProblem || partial || unknown > 0;
  return {
    agents,
    problems,
    unknown,
    partial,
    unsure,
    ready: problems === 0 && !unsure,
    // The number for the step rail: null when it cannot be trusted.
    railCount: unsure ? null : problems
  };
}
