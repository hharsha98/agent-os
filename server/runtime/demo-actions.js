import { saveWorkflow, getWorkflow } from "./workflows.js";
import { writeWorkspaceText } from "./workspace.js";
import {
  DEMO_BADGE,
  DEMO_WORKFLOW_ID,
  MACHINE_SCENARIOS,
  assertDemoEnabled,
  buildDemoChatReply,
  buildDemoTimeline,
  demoWorkflowTemplate,
  previewDemoMachine,
  simulateDemoWorkflow
} from "./demo-public.js";

function mergeWorkflow(current, input = {}) {
  const edits = new Map((Array.isArray(input.nodes) ? input.nodes : []).map((node) => [node.id, node]));
  const nodes = (current.nodes || []).map((node) => {
    const edit = edits.get(node.id);
    if (!edit) return node;
    const next = { ...node };
    if (edit.label != null) next.label = String(edit.label).slice(0, 80);
    if (edit.prompt != null) next.prompt = String(edit.prompt).slice(0, 2000);
    return next;
  });
  const name = input.name != null ? String(input.name).slice(0, 80) : current.name;
  return {
    ...current,
    name,
    nodes,
    edges: current.edges,
    source: "public-demo",
    engine: "public-demo-simulator"
  };
}

export async function runPublicDemoChat(input = {}, options = {}) {
  assertDemoEnabled(options);
  const message = String(input.message || input.prompt || "").trim();
  if (!message) {
    const error = new Error("message is required");
    error.status = 400;
    throw error;
  }
  return buildDemoChatReply({ agentId: input.agentId || input.agent || "claude", message });
}

export async function runPublicDemoTimeline(input = {}, options = {}) {
  assertDemoEnabled(options);
  const message = String(input.message || input.prompt || "").trim();
  if (!message) {
    const error = new Error("message is required");
    error.status = 400;
    throw error;
  }
  const plan = buildDemoTimeline({ message });
  const saved = await writeWorkspaceText({
    relativePath: plan.relativePath,
    content: plan.markdown
  });
  return {
    ...plan,
    workspaceFile: saved.file || null
  };
}

export async function runPublicDemoMachine(input = {}, options = {}) {
  assertDemoEnabled(options);
  const result = previewDemoMachine(input || {});
  if (!result.ok) {
    const error = new Error(result.error);
    error.status = result.status || 400;
    error.body = result;
    throw error;
  }
  return result;
}

export function publicDemoStatus(enabled) {
  return {
    ok: true,
    enabled: Boolean(enabled),
    badge: enabled ? DEMO_BADGE : null,
    simulated: Boolean(enabled),
    executedOnHost: false,
    executionLocked: Boolean(enabled),
    shellBlocked: true,
    convexRequired: false,
    realSession: false,
    scenarios: MACHINE_SCENARIOS,
    walkthrough: ["mission", "chat", "workspace", "machine", "builder"]
  };
}

export async function getPublicDemoBuilder(options = {}) {
  assertDemoEnabled(options);
  let workflow = await getWorkflow(DEMO_WORKFLOW_ID);
  if (!workflow) workflow = await saveWorkflow(demoWorkflowTemplate());
  return {
    ok: true,
    badge: DEMO_BADGE,
    simulated: true,
    executedOnHost: false,
    convexRequired: false,
    realSession: false,
    workflow
  };
}

export async function savePublicDemoBuilder(input = {}, options = {}) {
  assertDemoEnabled(options);
  const current = (await getWorkflow(DEMO_WORKFLOW_ID)) || demoWorkflowTemplate();
  const saved = await saveWorkflow(mergeWorkflow(current, input));
  return {
    ok: true,
    badge: DEMO_BADGE,
    simulated: true,
    executedOnHost: false,
    convexRequired: false,
    workflow: saved
  };
}

export async function runPublicDemoBuilder(input = {}, options = {}) {
  assertDemoEnabled(options);
  const workflow = (await getWorkflow(DEMO_WORKFLOW_ID)) || demoWorkflowTemplate();
  const sim = simulateDemoWorkflow(workflow, input.message || input.prompt || "");
  const saved = await writeWorkspaceText({
    relativePath: sim.relativePath,
    content: sim.markdown
  });
  return {
    ...sim,
    workspaceFile: saved.file || null
  };
}
