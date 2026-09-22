export const DEMO_BADGE = "Public demo · sandboxed";

export type DemoStep = {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  status: string;
  durationMs?: number;
};

export type DemoMachineScenario = {
  id: string;
  label: string;
  description: string;
};

export type DemoStatus = {
  ok: boolean;
  enabled: boolean;
  badge: string | null;
  simulated: boolean;
  executedOnHost: boolean;
  executionLocked: boolean;
  shellBlocked: boolean;
  convexRequired: boolean;
  realSession: boolean;
  scenarios: DemoMachineScenario[];
  walkthrough: string[];
};

export type DemoChatResult = {
  ok: boolean;
  simulated: boolean;
  executedOnHost: boolean;
  realSession: boolean;
  mode: string;
  badge: string;
  agentId: string;
  label: string;
  reply: string;
};

export type DemoTimelineResult = DemoChatResult & {
  focus: string;
  steps: DemoStep[];
  workspaceFile?: { id: string; relativePath: string } | null;
};

export type DemoMachinePreview = {
  ok: boolean;
  simulated: boolean;
  executedOnHost: boolean;
  badge: string;
  refused?: boolean;
  scenario?: string;
  label?: string;
  transcript?: string;
  note?: string;
  error?: string;
};

export type DemoWorkflowNode = {
  id: string;
  type: string;
  label: string;
  prompt?: string;
  position?: { x: number; y: number };
};

export type DemoWorkflow = {
  id: string;
  name: string;
  description?: string;
  nodes: DemoWorkflowNode[];
  edges: Array<{ id: string; source: string; target: string }>;
};

export type DemoBuilderResult = {
  ok: boolean;
  badge: string;
  simulated: boolean;
  executedOnHost: boolean;
  convexRequired: boolean;
  workflow: DemoWorkflow;
};

export type DemoBuilderRun = {
  ok: boolean;
  simulated: boolean;
  executedOnHost: boolean;
  badge: string;
  workflowId: string;
  nodeRuns: Array<{ nodeId: string; label: string; type: string; status: string; order: number; detail: string }>;
  workspaceFile?: { id: string; relativePath: string } | null;
};
