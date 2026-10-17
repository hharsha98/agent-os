// Giving Hermes and OpenClaw a model (or an OpenRouter preset) from the
// model picker: which targets there are, and how one is applied. The server
// does the work as a job; this polls it and turns the finished job into one
// honest line per agent -- worked and said hello, worked with the hello check skipped (Safety on Look only
// starts nothing), did not work, or stopped.
import type { AgentModelInfo, BrainAgentId, SetupJob } from "../setupApi";
import { applyAgentModel, applyAgentPreset, cancelSetupJob, friendlyError, getSetupJob } from "../setupApi";
import type { BrainAgentLine } from "./brainShared";
import { CONFIGURE_STEP_LABEL, formatContext } from "./brainShared";
import type { ApplyFn, ApplySubject, ApplyUpdate, ModelApplyResult, ModelTarget } from "./modelPickerShared";

const POLL_MS = 1000;
// A job that has only just finished can still hold the one-job-at-a-time lock
// for a moment: asking again a few times is better than showing "busy".
const BUSY_RETRIES = 6;
const BUSY_WAIT_MS = 500;

export const OPENCLAW_PINNED_NOTE = "Chats that already have a model pinned keep it until you send /model default in them.";
export const OPENCLAW_RISK_LABEL =
  "I understand OpenClaw can act on this computer. Agent OS will switch it to ask before running commands.";

// What each step of a model job is, in words (the job reports ids).
const STEP_LABEL: Record<string, string> = {
  ...CONFIGURE_STEP_LABEL,
  "hermes-model": "Set Hermes's model",
  "openclaw-model": "Set OpenClaw's model",
  health: "Say hello to the agent"
};

// "OpenRouter · vendor/model" / "Local (Ollama) · agentos-qwen3:64k" / "OpenRouter preset my-brain";
// null when the agent's model isn't known (or it has none).
export function describeAgentModel(info: AgentModelInfo | null | undefined) {
  if (!info || !info.installed || !info.model) return null;
  if (info.isPreset && info.presetSlug) return `OpenRouter preset ${info.presetSlug}`;
  return info.providerLabel ? `${info.providerLabel} · ${info.model}` : info.model;
}

// The targets the picker offers for Hermes and OpenClaw. `models` is what each
// agent uses now: an agent that is not on OpenRouter yet needs the OpenRouter
// connection first (it has to be given the key too).
export function buildAgentTargets(agents: BrainAgentLine[], models: Partial<Record<BrainAgentId, AgentModelInfo | null>>): ModelTarget[] {
  return agents.map((agent) => {
    const info = models[agent.id];
    const target: ModelTarget = { id: agent.id, label: agent.label, current: describeAgentModel(info) ?? undefined };
    if (!agent.installed) {
      target.disabled = true;
      target.reason = "not installed";
      return target;
    }
    if (agent.id === "hermes") {
      target.blockedFor = (model) =>
        model.hermesOk
          ? null
          : `Too small for Hermes: ${model.contextLength ? `${formatContext(model.contextLength)} of working memory` : "its size isn't listed"}, and Hermes needs at least 64K.`;
    }
    if (info && info.provider !== "openrouter") {
      target.needsConnection = true;
      target.connectNote = info.model
        ? `${agent.label} uses ${info.providerLabel || "another provider"} now. To move it to OpenRouter, Agent OS needs your OpenRouter connection.`
        : `${agent.label} has no model yet, so it needs your OpenRouter connection too.`;
    }
    if (agent.id === "openclaw") {
      target.ackLabel = OPENCLAW_RISK_LABEL;
      target.resultNote = OPENCLAW_PINNED_NOTE;
    }
    return target;
  });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function startChange(agentId: BrainAgentId, subject: ApplySubject, flowId: string | null, ack: boolean) {
  const extras = {
    ...(flowId ? { keySource: { flowId } } : {}),
    ...(agentId === "openclaw" && ack ? { acceptOpenClawRisk: true } : {})
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return subject.presetSlug
        ? await applyAgentPreset(agentId, { slug: subject.presetSlug, ...extras })
        : await applyAgentModel(agentId, { model: subject.model?.id || "", ...extras });
    } catch (error) {
      if (!(error instanceof Error && error.message === "job_already_running" && attempt < BUSY_RETRIES)) throw error;
      await sleep(BUSY_WAIT_MS);
    }
  }
}

function updateFromJob(job: SetupJob, targetId: string): ApplyUpdate {
  const running = job.steps.find((step) => step.status === "running") || job.steps.find((step) => step.status === "pending");
  return {
    targetId,
    stepsDone: job.steps.filter((step) => step.status === "succeeded").length,
    stepsTotal: job.steps.length,
    stepLabel: running ? STEP_LABEL[running.id] || running.id : "Finishing",
    startedAt: job.startedAt
  };
}

// The finished job, as one honest line for the agent.
function resultFromJob(job: SetupJob, agent: BrainAgentLine, subject: ApplySubject): ModelApplyResult {
  const targetId = agent.id;
  const warnings = job.steps.flatMap((step) => step.warnings || []);
  const wasUsing = job.previous?.model ? `It was using ${job.previous.model} before.` : "";
  const what = subject.presetSlug ? `your OpenRouter preset ${subject.presetSlug}` : subject.model?.name || subject.title;
  if (job.status === "cancelled") {
    return { targetId, ok: null, headline: `Stopped. ${agent.label} may or may not have changed.`, detail: "Anything already finished stays as it is.", warnings };
  }
  if (job.status === "failed") {
    const failed = job.steps.find((step) => step.status === "failed");
    return {
      targetId,
      ok: false,
      headline: `Couldn't switch ${agent.label} to ${what}.`,
      detail: [failed?.error || "A step failed.", wasUsing].filter(Boolean).join(" "),
      warnings
    };
  }
  const entry = job.health?.[agent.id];
  if (entry?.skipped) {
    // Safety is on Look only: the model was set, but the hello check was not run, so there is no tick to show.
    // `skipped` makes the panel draw a "not checked" mark instead of a tick. The server's own sentence says why.
    return {
      targetId,
      ok: true,
      skipped: true,
      changed: true,
      headline: subject.presetSlug ? `Following your OpenRouter preset ${subject.presetSlug}` : `${agent.label} now uses ${what}`,
      detail: entry.hint || "Skipped the hello check because Safety is on Look only. Allow running agents in Safety, then apply the brain again to check it.",
      warnings
    };
  }
  if (entry?.promptOk) {
    return {
      targetId,
      ok: true,
      changed: true,
      headline: subject.presetSlug ? `Following your OpenRouter preset ${subject.presetSlug}` : `${agent.label} now uses ${what}`,
      detail: "It said hello ✓",
      warnings
    };
  }
  return {
    targetId,
    ok: false,
    changed: true,
    headline: `${agent.label} was switched to ${what}, but it didn't answer.`,
    detail: [entry?.hint || "Open its run on the Runs page for details, or pick another model.", wasUsing].filter(Boolean).join(" "),
    warnings
  };
}

async function applyToOneAgent(
  agent: BrainAgentLine,
  subject: ApplySubject,
  flowId: string | null,
  ack: boolean,
  signal: AbortSignal,
  onUpdate: (update: ApplyUpdate) => void
): Promise<ModelApplyResult> {
  let job: SetupJob;
  try {
    onUpdate({ targetId: agent.id, stepsDone: 0, stepsTotal: 0, stepLabel: "Starting", startedAt: new Date().toISOString() });
    job = await startChange(agent.id, subject, flowId, ack);
  } catch (error) {
    return { targetId: agent.id, ok: false, headline: `Couldn't start the change for ${agent.label}.`, detail: friendlyError(error) };
  }
  let cancelSent = false;
  for (;;) {
    onUpdate(updateFromJob(job, agent.id));
    if (job.status !== "running") break;
    if (signal.aborted && !cancelSent) {
      cancelSent = true;
      await cancelSetupJob(job.id).catch(() => undefined);
    }
    await sleep(POLL_MS);
    try {
      job = await getSetupJob(job.id);
    } catch {
      // a transient poll failure; the next tick tries again
    }
  }
  return resultFromJob(job, agent, subject);
}

// The picker's "apply" for Hermes and OpenClaw: one job per ticked agent, one
// after the other (the server runs one setup job at a time).
export function agentApplier(agents: BrainAgentLine[]): ApplyFn {
  return async ({ subject, targetIds, flowId, ack, signal, onUpdate }) => {
    const results: ModelApplyResult[] = [];
    for (const targetId of targetIds) {
      const agent = agents.find((candidate) => candidate.id === targetId);
      if (!agent) continue;
      results.push(await applyToOneAgent(agent, subject, flowId, ack, signal, onUpdate));
      if (signal.aborted) break;
    }
    return results;
  };
}
