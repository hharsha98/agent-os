import path from "node:path";
import { getModules } from "./modules.js";
import { listWorkflows, runWorkflow } from "./workflows.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";

const SETUP_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function setupPath() {
  return path.join(runtimePaths().config, "setup.json");
}

function defaultSetup() {
  return {
    version: SETUP_VERSION,
    mode: "local",
    preferredProvider: "ollama",
    completed: false,
    firstWorkflowRunId: null,
    updatedAt: null
  };
}

function providerReady(modules) {
  return [
    "provider-openrouter",
    "provider-ollama",
    "provider-minimax",
    "provider-openai",
    "provider-anthropic",
    "provider-gemini"
  ].some((id) => modules.find((module) => module.id === id)?.status === "connected");
}

function step(id, label, done, detail, target = null) {
  return { id, label, done: Boolean(done), detail, target };
}

export async function getSetupState() {
  await ensureRuntimeStore();
  const stored = { ...defaultSetup(), ...(await readJson(setupPath(), {})) };
  const modules = await getModules();
  const byId = new Map(modules.map((module) => [module.id, module]));
  const workflows = await listWorkflows();
  const steps = [
    step(
      "runtime",
      "Runtime check",
      byId.get("elizaos-runtime")?.status === "connected",
      byId.get("elizaos-runtime")?.status === "connected"
        ? "elizaOS core is loadable."
        : "Install runtime dependencies before continuing.",
      "elizaos-runtime"
    ),
    step(
      "deployment",
      "Choose install mode",
      ["local", "vps", "docker"].includes(stored.mode),
      `Selected mode: ${stored.mode}.`,
      "setup"
    ),
    step(
      "provider",
      "Connect a model provider",
      providerReady(modules),
      providerReady(modules)
        ? "At least one provider route is configured."
        : "Connect Ollama, OpenRouter, MiniMax, OpenAI, Anthropic, or Gemini.",
      "provider-router"
    ),
    step(
      "routing",
      "Configure provider routing",
      byId.get("provider-router")?.status === "connected",
      byId.get("provider-router")?.status === "connected"
        ? "Provider Router is backed by a healthy user-owned/local provider."
        : "Configure OpenRouter, Ollama, or MiniMax for model routing.",
      "provider-router"
    ),
    step(
      "builder",
      "Configure Agent Builder execution",
      byId.get("firecrawl-builder")?.status === "connected",
      byId.get("firecrawl-builder")?.status === "connected"
        ? "Firecrawl builder auth, storage, and execution keys are configured."
        : "Add Convex, Clerk, Firecrawl, and LLM keys before builder execution.",
      "firecrawl-builder"
    ),
    step(
      "first-workflow",
      "Start first workflow",
      Boolean(stored.firstWorkflowRunId),
      stored.firstWorkflowRunId
        ? "A starter workflow has been run."
        : workflows.length
          ? "Run the blank starter workflow or create one in Agent Builder."
          : "Create a workflow before running.",
      "agent-builder"
    )
  ];
  const requiredSteps = steps.filter((item) => item.id !== "builder");
  const canComplete = requiredSteps.every((item) => item.done);
  return {
    ...stored,
    completed: Boolean(stored.completed && canComplete),
    canComplete,
    steps,
    workflows: workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      draft: workflow.draft,
      nodeCount: workflow.nodeCount
    })),
    updatedAt: stored.updatedAt
  };
}

export async function saveSetupState(input = {}) {
  await ensureRuntimeStore();
  const current = await getSetupState();
  const mode = ["local", "vps", "docker"].includes(input.mode) ? input.mode : current.mode;
  const preferredProvider = String(input.preferredProvider || current.preferredProvider || "ollama")
    .trim()
    .replace(/[^a-z0-9_-]/gi, "")
    .toLowerCase() || "ollama";
  const next = {
    version: SETUP_VERSION,
    mode,
    preferredProvider,
    completed: Boolean(input.completed && current.canComplete),
    firstWorkflowRunId: current.firstWorkflowRunId,
    updatedAt: now()
  };
  await writeJson(setupPath(), next);
  return getSetupState();
}

export async function startFirstSetupWorkflow() {
  const state = await getSetupState();
  const workflow = state.workflows.find((item) => item.id === "blank-open-agent-builder") || state.workflows[0];
  if (!workflow) {
    const error = new Error("No workflow is available to run.");
    error.status = 400;
    throw error;
  }
  const run = await runWorkflow(workflow.id, { trigger: "first-run-setup" });
  const current = await readJson(setupPath(), defaultSetup());
  await writeJson(setupPath(), {
    ...defaultSetup(),
    ...current,
    firstWorkflowRunId: run.id,
    updatedAt: now()
  });
  return {
    setup: await getSetupState(),
    run
  };
}
