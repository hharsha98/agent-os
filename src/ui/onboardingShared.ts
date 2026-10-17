// Small shared facts for the "Get started" checklist: the card on Home, the
// pill in the header and the ⌘K palette all say and do the same thing.
import { navigateTo, queryParam } from "../nav";
import type { Onboarding, OnboardingFirstRun, OnboardingStepId } from "../onboardingApi";
import { AGENT_LABEL } from "./agentsShared";

// The one prompt the checklist offers as a first task. It only asks an agent to
// look and describe (the New run dialog never allows edits). The checklist never
// starts it: the person presses Start run.
export const SAFE_EXAMPLE_PROMPT = "List the files in this folder and describe what this project does in 3 sentences.";

export const STEP_TITLE: Record<OnboardingStepId, string> = {
  install: "Install your agents",
  brain: "Give your agents a brain",
  signin: "Sign in to your coding agents",
  "first-run": "Run your first task",
  "agent-computer": "Agent Computer"
};

export const STEP_BUTTON: Partial<Record<OnboardingStepId, string>> = {
  install: "Open Setup",
  brain: "Choose a brain",
  signin: "Sign in",
  "first-run": "Try a safe example"
};

// One line shown before a step that needs a sign-in, money, or a look at a
// prompt. (The install step's line comes from the real plan: its size, and
// whether a password is asked for.)
export const STEP_NOTE: Partial<Record<OnboardingStepId, string>> = {
  brain: "Free OpenRouter models cost nothing. Paid ones are billed per use.",
  signin: "This opens your browser. Each coding agent needs its own account or plan.",
  "first-run": "The example only asks the agent to look and describe. Edits stay off."
};

const CODING = ["claude", "codex", "cursor"];

export function agentName(id: string) {
  return AGENT_LABEL[id] || id;
}

export function agentNames(ids: string[]) {
  return ids.map(agentName).join(", ");
}

// The agent the safe example is offered for: one that is signed in, else an
// installed coding agent, else any installed agent. null when nothing is installed.
export function exampleAgentId(facts: Onboarding["facts"]): string | null {
  return facts.signedIn[0] || facts.installed.find((id) => CODING.includes(id)) || facts.installed[0] || null;
}

// Where a step's button leads. The first-run step opens the New run dialog (on Runs)
// with the example typed in, and stops there.
export function openStep(id: OnboardingStepId, facts: Onboarding["facts"]) {
  if (id === "install") navigateTo("setup", { step: "plan" });
  else if (id === "brain") navigateTo("setup", { step: "brain" });
  else if (id === "signin") navigateTo("setup", { step: "signin" });
  else if (id === "first-run") {
    const agentId = exampleAgentId(facts);
    if (agentId) navigateTo("runs", { agent: agentId, example: "safe" });
  }
}

// Brings the checklist back (the header pill and the ⌘K palette use this):
// un-hides it, goes to Home, and puts keyboard focus on the card.
export async function revealGetStarted(setHidden: (hidden: boolean) => Promise<void>, wasHidden: boolean) {
  if (wasHidden) await setHidden(false);
  if ((queryParam("page") || "fleet") !== "fleet") navigateTo("fleet");
  // The card appears a moment later; look for it for about a second.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const card = document.getElementById("os-get-started");
    if (card) {
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: "nearest" });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// "38s", "1m 12s"; "—" when the run did not report a duration.
export function durationText(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// "$0.04"; "—" when the run did not report a cost (never "$0.00").
export function costText(costUsd: number | null | undefined) {
  return typeof costUsd === "number" && Number.isFinite(costUsd) ? `$${costUsd.toFixed(2)}` : "—";
}

export function firstRunText(run: OnboardingFirstRun | null) {
  if (!run) return "—";
  return `${run.agentId ? agentName(run.agentId) : "An agent"} · ${durationText(run.durationMs)} · ${costText(run.costUsd)}`;
}
