// Safety's words and small rules, in one place so later work (sessions in SP3)
// changes them here. `import type` only (decision P14): test/safety-shared.test.js
// loads this file straight from src/ and Node strips the types.
//
// Every sentence here describes what Agent OS does TODAY (decision P26), and was
// checked against the server:
//   - the folder rule is resolveRunCwd in server/runtime/agents/routes.js;
//   - the flag rule is run-manager.js (blockedFlagError) and agent-flags.js;
//   - the gate is read when an agent run starts, before every Team Room turn and before Setup's (and the Agents
//     page's) hello check; it kills nothing already going, so a run keeps going until it ends or is stopped.
//     Setup's own installers, sign-in, services and config steps are not behind it (they never were), so the
//     words must not say "nothing can start";
//   - machine control gates Agent OS's own screen, mouse and keyboard actions
//     (server/runtime/voice-control.js), and shell commands there stay off unless
//     HERMES_VOICE_ALLOW_SHELL=1 and each one carries confirmShell.
import type { ExecutionGateStatus } from "../types";
import type { AgentDetail, MachineControlStatus } from "../setupApi";

export const ARM_PHRASE = "ENABLE MACHINE CONTROL";

export const LEVELS: Record<number, { label: string; blurb: string }> = {
  0: { label: "Look only", blurb: "Agents are found and past runs shown. Agent OS starts no new agent run or Team Room." },
  // The second sentence is the New run dialog's own (RISKY_STEP_HINT, owner ruling C3-3):
  // the two pages must say the same thing about a step a level does not allow.
  1: { label: "Run agents", blurb: "Runs start in a folder inside the Workspace (OpenClaw's Gateway uses its own). Anything this safety level does not allow is refused, not run." },
  2: { label: "Machine control", blurb: "Agent OS can also see the screen and use the mouse and keyboard on this Mac. Off until you turn it on." }
};

export const LEVEL_DETAIL: Record<number, { can: string; asks: string; cannot: string }> = {
  0: {
    can: "See which agents are installed and look at past runs.",
    asks:
      "Nothing, because no new agent run or Team Room can start. A Team Room that is already going stops before its next turn. Setup and the Agents page skip their hello check, but Setup's own install, sign-in, service and config steps still run when you press them. A run that is already going keeps going until it ends or you stop it.",
    cannot: "Start a new agent run or Team Room, or use machine control."
  },
  1: {
    can: "Run the agents you choose, each one started in a folder inside the Workspace (OpenClaw's Gateway uses its own folder).",
    asks: "You choose what runs and where. Anything this safety level does not allow is refused, not run.",
    cannot: "Use machine control, which needs Level 2, or start a run in a folder outside the Workspace."
  },
  2: {
    can: "Everything in Level 1, plus Agent OS can see the screen and use the mouse and keyboard in other apps. macOS only.",
    asks: "Shell commands stay off unless you switch them on separately, and each one still needs your confirmation.",
    cannot: "Stay on past 30 minutes. It also turns itself off when Agent OS restarts or you go back to Level 0."
  }
};

// The level the gate answer says, or null when the answer is not a valid shape. A malformed
// answer (nothing, a list, `{}`, a level that is not 0, 1 or 2, `enabled` that is not true or
// false) is UNKNOWN, never Look only: the page must not ring a level it was not told.
export function levelOf(
  gate: (Partial<Pick<ExecutionGateStatus, "enabled">> & { level?: unknown }) | null | undefined,
  machineControl: Partial<Pick<MachineControlStatus, "armed">> | null | undefined
): 0 | 1 | 2 | null {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
  const level = gate.level;
  if (level === 0 || level === 1 || level === 2) return level;
  // A level that is present but not 0, 1 or 2 cannot be trusted.
  if (level !== undefined && level !== null) return null;
  // Older servers don't send a level; derive it from the two real flags.
  if (typeof gate.enabled !== "boolean") return null;
  return gate.enabled ? (machineControl?.armed === true ? 2 : 1) : 0;
}

export const NOT_AVAILABLE_FOOT = "Not available on this computer.";
export const BUSY_WORD = "Changing…";
// The computer's own settings (the gate's `envLocked` flag, HERMES_AGENT_OS_ENABLE_EXEC=1) keep the
// gate on, so Agent OS cannot switch to Look only. The card says so before the person presses it,
// and a refusal says the same thing instead of the server's variable name.
export const ENV_LOCK_FOOT = "Locked by this computer's settings";
export const ENV_LOCK_WORDS = "This computer's settings keep agents allowed to run, so Agent OS cannot switch to Look only from here.";

export interface FootOptions {
  // false when machine control cannot run on this computer (not macOS).
  supported?: boolean;
  // the gate is locked on by the environment (gate.envLocked).
  envLocked?: boolean;
  // contact with Agent OS was lost: what is shown is the last state it reported.
  lastKnown?: boolean;
  // this card's change is on its way (the request or the re-check has not finished).
  changing?: boolean;
}

// The small line under each level button: what pressing it does.
export function levelFoot(n: 0 | 1 | 2, current: 0 | 1 | 2 | null, countdown: string, opts: FootOptions = {}): string {
  if (current === null) return "…";
  if (opts.changing) return BUSY_WORD;
  if (n === current) {
    if (n !== 2) return "Current";
    return opts.lastKnown ? "On when last checked" : `On. Turns off in ${countdown}`;
  }
  if (n === 2) return opts.supported === false ? NOT_AVAILABLE_FOOT : "Off. Needs a typed phrase";
  if (n === 0 && opts.envLocked) return ENV_LOCK_FOOT;
  if (n === 1 && current === 0) return "Asks you first";
  return "Applies at once";
}

// What to say when Agent OS answered "turn Run agents off" and Run agents is still on.
export function lookOnlyRefusal(next: { envLocked?: boolean; publicSummary?: string } | null | undefined): string {
  if (next?.envLocked === true) return ENV_LOCK_WORDS;
  return next?.publicSummary || "Agent OS did not turn Run agents off.";
}

// The heading over the level meaning. With no level known it names none: "—" stands in for it.
export function levelHeading(level: 0 | 1 | 2 | null): string {
  return level === null ? "What Level — means" : `What Level ${level} · ${LEVELS[level].label} means`;
}

export const LEVEL_UNKNOWN_NOTE = "This page does not know the current level yet. What it allows will show here once Agent OS answers.";

export function phraseMatches(text: string): boolean {
  return text.trim() === ARM_PHRASE;
}

// The id of a level's button, so the page can put keyboard focus on the level it just changed to.
export function levelButtonId(n: 0 | 1 | 2): string {
  return `os-saf-level-${n}`;
}

// Machine control is on: the server says armed and gave a time to count down to. It is never
// shown at Look only (the gate is off) or while the level is not known yet. An armed flag at
// Level 1 is still shown: a warning that is too loud is safer than one that is missing.
export function machineOn(
  level: 0 | 1 | 2 | null,
  machineControl: Pick<MachineControlStatus, "armed" | "expiresAt"> | null
): boolean {
  return level !== null && level !== 0 && Boolean(machineControl?.armed && machineControl.expiresAt);
}

// Contact with Agent OS was lost while machine control was on. The page cannot know whether it is
// still on, so the banner is the last known state, with no ticking countdown.
export const MACHINE_LAST_KNOWN_TITLE = "Last known: machine control was on.";

export function machineLostWords(expiresLabel: string): string {
  const base = "Agent OS cannot be reached, so this page cannot tell whether it is still on.";
  return expiresLabel ? `${base} It was due to turn itself off at ${expiresLabel}.` : base;
}

// The warning over the per-agent checks, naming only the agents whose re-check failed.
export function staleWords(names: string[]): string {
  if (names.length === 0) return "";
  return `Agent OS could not re-check ${names.join(" and ")} just now. What this page shows for ${names.length === 1 ? "it" : "them"} is the last answer it got.`;
}

// The page lede. It does not promise to show what agents are asking: no request arrives on this
// page yet (Pending approvals says so).
export const PAGE_LEDE = "You decide how much agents may do. Pick a level, read what each safeguard does, and stop all agent work with one press and hold.";

// The note beside the level control. The gate and the folder rule apply to the runs the run manager
// starts, that is, runs you start from Agent OS.
export const LEVELS_QUIET = "One setting for every run you start from Agent OS";

// What to tell the person when a change to the level failed. A refusal Agent OS sent itself
// (`refusal`) is shown as it came. When Agent OS gave NO answer (`noAnswer` holds the words for
// that, from setupGroupShared.noAnswerWords) the request may still have been applied, so the
// words never say "nothing was changed"; the page re-checks the real level right after.
export function changeProblem(noAnswer: string | null, refusal: string): string {
  if (noAnswer !== null) return `${noAnswer} The change may not have gone through. Agent OS is checking the real level again.`;
  return refusal.trim() || "Agent OS did not make that change.";
}

// Both rules are enforced by the run manager, so they hold for runs started through Agent OS and
// say nothing about an agent that someone starts on their own in a terminal.
const RUNS_FROM_AGENT_OS = "Runs you start from Agent OS";

// Safeguards that hold at every level, today (decision D-D2-4).
export const ALWAYS_ON: Array<{ title: string; detail: string; who: string }> = [
  {
    title: "No skip-permissions flags, ever",
    detail:
      "Agent OS refuses to start a run with a launch option that skips an agent's permission questions, such as --dangerously-skip-permissions or --yolo. No setting changes this.",
    who: RUNS_FROM_AGENT_OS
  },
  {
    title: "New runs start in a Workspace folder",
    detail:
      "Agent OS refuses a start folder outside the Workspace, before the run starts. OpenClaw, when its Gateway is running, works in its own folder, and an agent that can run commands is not locked to its folder.",
    who: RUNS_FROM_AGENT_OS
  },
  {
    title: "Updater questions are never answered for you",
    // Setup starts an updater with no input and no yes flag (server/runtime/setup/recipes.js,
    // jobs.js). What an updater then does with no answer is its own; only the part Agent OS
    // controls is promised. Hermes has no update step in Setup at all (plan.js NO_UPDATE_STEP).
    detail:
      "Setup runs an agent's own updater with no yes flag and no typed answers, so a question it asks gets no answer from Agent OS. If an update fails, Setup shows the updater's own message.",
    who: "OpenClaw and the coding agents"
  }
];

// ---- The per-agent checks under the always-on rows (Hermes and OpenClaw) ----

// on / off: the check was read. missing: the agent is not on this Mac. unknown: it could not be
// read (a failed or slow request, or a detection that broke). loading: the first read is pending.
export type GuardState = "on" | "off" | "missing" | "unknown" | "loading";

export interface GuardRow {
  key: string;
  agentId: "hermes" | "openclaw";
  name: string;
  title: string;
  sub: string;
  state: GuardState;
}

// The same rule as setupGroupShared.agentFact, kept here so this file stays free of runtime
// imports: `installed: false` with a "was not found" error is simply not installed, and any
// other error means detection itself broke, which is unknown.
function installedState(detail: AgentDetail): "installed" | "missing" | "unknown" {
  const detected = detail.detected as { installed?: unknown; error?: string } | null | undefined;
  if (!detected || typeof detected.installed !== "boolean") return "unknown";
  if (detected.installed) return "installed";
  if (detected.error && !/was not found/i.test(detected.error)) return "unknown";
  return "missing";
}

function hasAction(detail: AgentDetail, actionId: string): boolean {
  return Boolean(detail.safety?.actions?.some((action) => action.id === actionId));
}

// One row when the agent cannot be read (and says why), the real rows when it can.
function unreadable(agentId: "hermes" | "openclaw", name: string, key: string, detail: AgentDetail | null, checked: boolean): GuardRow | null {
  const base = { key, agentId, name, title: `${name} safeguards` };
  if (!detail) {
    return checked
      ? { ...base, state: "unknown", sub: "Could not be read right now." }
      : { ...base, state: "loading", sub: "Checking…" };
  }
  const fact = installedState(detail);
  if (fact === "missing") return { ...base, state: "missing", sub: `${name} is not installed on this Mac.` };
  if (fact === "unknown") return { ...base, state: "unknown", sub: "Could not be read right now." };
  // The agent answered, but its safety setting could not be read (known: false): not On, not Off.
  if (detail.safety?.known === false) return { ...base, state: "unknown", sub: "Could not be read right now." };
  return null;
}

// Whether each agent's first read has finished (it may have failed). They are tracked one by one,
// so a slow agent never hides the other one's row behind "Checking…".
export interface GuardChecked {
  hermes: boolean;
  openclaw: boolean;
}

export function agentGuardRows(hermes: AgentDetail | null, openclaw: AgentDetail | null, checked: GuardChecked): GuardRow[] {
  const rows: GuardRow[] = [];
  const change = (name: string) => `Open ${name} on Agents to change it.`;

  const hermesOff = unreadable("hermes", "Hermes", "hermes-approvals", hermes, checked.hermes);
  if (hermesOff) rows.push(hermesOff);
  else if (hermes) {
    rows.push({
      key: "hermes-approvals",
      agentId: "hermes",
      name: "Hermes",
      title: "Hermes asks before running commands",
      sub: change("Hermes"),
      state: hermes.safety.permissive ? "off" : "on"
    });
  }

  const openclawOff = unreadable("openclaw", "OpenClaw", "openclaw-exec", openclaw, checked.openclaw);
  if (openclawOff) rows.push(openclawOff);
  else if (openclaw) {
    rows.push(
      {
        key: "openclaw-exec",
        agentId: "openclaw",
        name: "OpenClaw",
        title: "OpenClaw asks before running commands",
        sub: change("OpenClaw"),
        state: hasAction(openclaw, "exec-ask") ? "off" : "on"
      },
      {
        key: "openclaw-cookies",
        agentId: "openclaw",
        name: "OpenClaw",
        title: "OpenClaw cannot copy logins from your browser",
        sub: change("OpenClaw"),
        state: hasAction(openclaw, "no-browser-cookies") ? "off" : "on"
      }
    );
  }
  return rows;
}

const GUARD_WORDS: Record<GuardState, string> = {
  on: "On",
  off: "Off",
  missing: "Not installed",
  unknown: "Status unknown",
  loading: "Checking"
};

// A row is a button that opens the agent's page, and role="row" hides that from a screen reader,
// so its spoken name says what it is, how it stands and what pressing it opens.
export function guardRowLabel(row: GuardRow): string {
  return `${row.title}. ${GUARD_WORDS[row.state]}. Open ${row.name} on Agents.`;
}
