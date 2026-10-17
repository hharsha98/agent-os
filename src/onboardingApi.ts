// API helpers and types for the "Get started" checklist. Every fetch goes
// through the shared request() from ./api, so a 401 session_required still
// fires "agentos:locked" like the rest of the app. The exact response shapes
// live in server/runtime/onboarding.js.
import { request } from "./api";

export type OnboardingStepId = "install" | "brain" | "signin" | "first-run" | "agent-computer";
// "unavailable" is a step that cannot be done yet (it never counts as todo).
export type OnboardingStatus = "done" | "todo" | "skipped" | "unavailable";

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStatus;
  // One plain sentence about the real state, written by the server.
  detail: string;
}

// The person's first task, for the finish screen. durationMs and costUsd are
// null when the run did not report them (shown as "—", never as 0).
export interface OnboardingFirstRun {
  id: string;
  agentId: string | null;
  status: string;
  durationMs: number | null;
  costUsd: number | null;
}

export interface Onboarding {
  steps: OnboardingStep[];
  // `total` counts the steps that can be done at all (not the unavailable one).
  counts: { done: number; skipped: number; todo: number; total: number };
  // Every step is done or skipped.
  complete: boolean;
  // The card on Home is put away (the header pill brings it back).
  hidden: boolean;
  facts: {
    installed: string[];
    brains: string[];
    signedIn: string[];
    firstRun: OnboardingFirstRun | null;
  };
}

export function getOnboarding(refresh = false) {
  return request<Onboarding>(`/api/onboarding${refresh ? "?refresh=1" : ""}`);
}

// `skipped` is the whole list of skipped steps; `hidden` the card's state.
export function saveOnboarding(patch: { skipped?: OnboardingStepId[]; hidden?: boolean }) {
  return request<Onboarding>("/api/onboarding", {
    method: "PUT",
    body: JSON.stringify({ ...patch, confirm: true })
  });
}
