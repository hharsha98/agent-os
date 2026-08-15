import { promises as fs } from "node:fs";
import path from "node:path";
import { runCodexPreview } from "./codex-api.js";
import { getConfiguredValue, getStoredConnectionConfig } from "./connections.js";
import { getModule, runModule } from "./modules.js";
import { appendModuleLog } from "./module-logs.js";
import { runRouter } from "./router.js";
import { redactValue, sanitizeObject } from "./safety.js";
import { updateKanbanCards, upsertKanbanCard } from "./self-modules.js";
import { ensureRuntimeStore, readJson, runtimePaths, writeJson } from "./store.js";

const DEFAULT_WORKFLOW_ID = "blank-open-agent-builder";
const OBSOLETE_GENERATED_WORKFLOWS = new Set(["sample-lead-intake"]);
const REMOVED_DEMO_WORKFLOWS = new Set([
  "daily-reels-intelligence",
  "inbound-lead-qualification",
  "weekly-content-factory",
  "competitor-change-monitor",
  "support-triage-recovery",
  "release-readiness-control",
  "research-knowledge-base",
  "long-video-social-system"
]);

export const NODE_TYPES = [
  "start",
  "agent",
  "mcp_tool",
  "transform",
  "if_else",
  "while_loop",
  "user_approval",
  "end"
];

function now() {
  return new Date().toISOString();
}

function elapsedMs(startedAt, finishedAt) {
  return Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

function workflowFile(id) {
  return path.join(runtimePaths().workflows, `${id}.json`);
}

function runFile(workflowId, runId) {
  return path.join(runtimePaths().runs, workflowId, `${runId}.json`);
}

function runEvent(type, input = {}) {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    level: input.level || "info",
    nodeId: input.nodeId || null,
    edgeId: input.edgeId || null,
    branchId: input.branchId || null,
    parallelGroupId: input.parallelGroupId || null,
    status: input.status || null,
    message: input.message || "",
    details: sanitizeObject(input.details || {}),
    timestamp: now()
  };
}

function edgeSource(edge) {
  return String(edge.source || edge.sourceNodeId || edge.from || edge.fromNodeId || "").trim();
}

function edgeTarget(edge) {
  return String(edge.target || edge.targetNodeId || edge.to || edge.toNodeId || "").trim();
}

function edgeId(edge, index) {
  return String(edge.id || `${edgeSource(edge)}-${edgeTarget(edge)}-${index}`).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

function normalizeBranch(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function branchAliases(value) {
  const normalized = normalizeBranch(value);
  const aliases = new Set([normalized]);
  if (["true", "yes", "if", "pass", "passed", "hot", "loop", "continue"].includes(normalized)) {
    ["true", "yes", "if", "pass", "hot", "loop", "continue"].forEach((item) => aliases.add(item));
  }
  if (["false", "no", "else", "fail", "failed", "not-hot", "done", "exit", "low-fit"].includes(normalized)) {
    ["false", "no", "else", "fail", "not-hot", "done", "exit", "low-fit"].forEach((item) => aliases.add(item));
  }
  return aliases;
}

function edgeBranches(edge) {
  return [
    edge.branch,
    edge.condition,
    edge.label,
    edge.name,
    edge.sourceHandle,
    edge.handle,
    edge.route,
    edge.value
  ].map(normalizeBranch).filter(Boolean);
}

function implicitEdges(nodes = []) {
  const edges = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push({
      id: `implicit-${nodes[index].id}-${nodes[index + 1].id}`,
      source: nodes[index].id,
      target: nodes[index + 1].id,
      implicit: true
    });
  }
  return edges;
}

function buildGraph(workflow) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const implicitMode = !(Array.isArray(workflow.edges) && workflow.edges.length);
  const edges = implicitMode ? implicitEdges(nodes) : workflow.edges;
  const nodeMap = new Map(nodes.map((node) => [String(node.id), node]));
  const outgoing = new Map();
  const incoming = new Map();
  edges.forEach((edge, index) => {
    const source = edgeSource(edge);
    const target = edgeTarget(edge);
    if (!source || !target) return;
    const normalized = {
      ...edge,
      id: edgeId(edge, index),
      source,
      target
    };
    outgoing.set(source, [...(outgoing.get(source) || []), normalized]);
    incoming.set(target, [...(incoming.get(target) || []), normalized]);
  });
  const startNode =
    nodes.find((node) => node.type === "start") ||
    nodes.find((node) => !incoming.has(String(node.id))) ||
    nodes[0] ||
    null;
  return { nodes, edges, nodeMap, outgoing, incoming, startNode, implicitMode };
}

export function defaultWorkflow() {
  return {
    id: DEFAULT_WORKFLOW_ID,
    name: "Blank Agent OS Workflow",
    description: "Start visually or describe the workflow you want Codex API to build.",
    draft: true,
    source: "agent-os-native-builder",
    engine: "codex-api",
    runtime: "hermes",
    nodeTypes: NODE_TYPES,
    nodes: [
      { id: "start", type: "start", label: "Start" }
    ],
    edges: [],
    createdAt: now(),
    updatedAt: now()
  };
}

async function removeObsoleteGeneratedWorkflows() {
  for (const id of OBSOLETE_GENERATED_WORKFLOWS) {
    const filePath = workflowFile(id);
    const existing = await readJson(filePath, null);
    if (!existing) continue;
    const generatedByHermes =
      existing.name === "AI Lead Form Intake Automation" ||
      existing.description?.includes("lead scoring") ||
      existing.nodes?.some((node) => node.label === "CRM Duplicate Check");
    if (generatedByHermes) {
      await fs.rm(filePath, { force: true });
    }
  }

  for (const id of REMOVED_DEMO_WORKFLOWS) {
    const filePath = workflowFile(id);
    const existing = await readJson(filePath, null);
    const isPackagedDemo = existing?.starter === true || existing?.source === "agent-os-workflow-library";
    if (isPackagedDemo) {
      await fs.rm(filePath, { force: true });
      await fs.rm(path.join(runtimePaths().runs, id), { recursive: true, force: true });
    }
  }

  await fs.rm(path.join(runtimePaths().config, "workflow-library.json"), { force: true });
}

async function ensureDefaultWorkflow() {
  await ensureRuntimeStore();
  await removeObsoleteGeneratedWorkflows();
  const filePath = workflowFile(DEFAULT_WORKFLOW_ID);
  const existing = await readJson(filePath, null);
  let savedDefault;
  if (existing) {
    const needsMigration = existing.source?.includes("firecrawl-open-agent-builder") || existing.name === "Blank Open Agent Builder Workflow";
    savedDefault = needsMigration
      ? await writeJson(filePath, {
          ...existing,
          name: "Blank Agent OS Workflow",
          description: "Start visually or describe the workflow you want Codex API to build.",
          source: "agent-os-native-builder",
          engine: "codex-api",
          runtime: ["hermes", "openclaw"].includes(existing.runtime) ? existing.runtime : "hermes",
          updatedAt: now()
        })
      : existing;
  } else {
    savedDefault = await writeJson(filePath, defaultWorkflow());
  }
  return savedDefault;
}

async function getWorkflowRunSummary(id) {
  const dir = path.join(runtimePaths().runs, id);
  let entries = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    entries = [];
  }
  if (!entries.length) return { runCount: 0, lastRunStatus: null, lastRunAt: null };
  const latest = await readJson(path.join(dir, entries[0]), null);
  return {
    runCount: entries.length,
    lastRunStatus: latest?.status || null,
    lastRunAt: latest?.updatedAt || latest?.createdAt || null
  };
}

export async function listWorkflows() {
  await ensureDefaultWorkflow();
  const paths = runtimePaths();
  let entries = [];
  try {
    entries = await fs.readdir(paths.workflows, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const workflows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const workflow = await readJson(path.join(paths.workflows, entry.name), null);
    if (workflow) {
      const startNode = workflow.nodes?.find((node) => node.type === "start");
      const nodeTypes = (workflow.nodes || []).map((node) => node.type);
      const runSummary = await getWorkflowRunSummary(workflow.id);
      workflows.push({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        runtime: workflow.runtime || "hermes",
        draft: Boolean(workflow.draft),
        starter: Boolean(workflow.starter),
        category: workflow.category || "Custom workflow",
        schedule: workflow.schedule || startNode?.schedule || startNode?.cron || null,
        trigger: startNode?.trigger || "manual",
        tags: Array.isArray(workflow.tags) ? workflow.tags.slice(0, 6) : [],
        sortOrder: Number(workflow.sortOrder || 9999),
        nodeCount: workflow.nodes?.length || 0,
        edgeCount: workflow.edges?.length || 0,
        branchCount: nodeTypes.filter((type) => ["if_else", "while_loop"].includes(type)).length,
        approvalCount: nodeTypes.filter((type) => type === "user_approval").length,
        toolCount: nodeTypes.filter((type) => type === "mcp_tool").length,
        nodeTypes,
        ...runSummary,
        updatedAt: workflow.updatedAt || workflow.createdAt || null
      });
    }
  }
  return workflows.sort((a, b) => {
    if (a.id === DEFAULT_WORKFLOW_ID) return 1;
    if (b.id === DEFAULT_WORKFLOW_ID) return -1;
    if (a.starter && b.starter) return a.sortOrder - b.sortOrder;
    if (a.starter !== b.starter) return a.starter ? 1 : -1;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

export async function getWorkflow(id) {
  await ensureDefaultWorkflow();
  return readJson(workflowFile(id), null);
}

export async function deleteWorkflow(id) {
  await ensureRuntimeStore();
  if (id === DEFAULT_WORKFLOW_ID) {
    const error = new Error("The starter workflow cannot be deleted.");
    error.status = 400;
    throw error;
  }
  const existing = await getWorkflow(id);
  if (!existing) {
    const error = new Error(`Workflow not found: ${id}`);
    error.status = 404;
    throw error;
  }
  await fs.rm(workflowFile(id), { force: true });
  await fs.rm(path.join(runtimePaths().runs, id), { recursive: true, force: true });
  return { ok: true, id };
}

export async function saveWorkflow(workflow) {
  await ensureRuntimeStore();
  const id = String(workflow.id || `workflow-${Date.now()}`).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const invalid = nodes.find((node) => !NODE_TYPES.includes(node.type));
  if (invalid) {
    const error = new Error(`Unsupported node type: ${invalid.type}`);
    error.status = 400;
    throw error;
  }
  const current = await readJson(workflowFile(id), null);
  const next = {
    ...current,
    ...workflow,
    id,
    source: workflow.source || current?.source || "agent-os-native-builder",
    engine: workflow.engine || current?.engine || "codex-api",
    runtime: ["hermes", "openclaw"].includes(workflow.runtime) ? workflow.runtime : current?.runtime || "hermes",
    nodeTypes: NODE_TYPES,
    createdAt: current?.createdAt || now(),
    updatedAt: now()
  };
  return writeJson(workflowFile(id), next);
}

export async function runWorkflow(id, input = {}) {
  const workflow = await getWorkflow(id);
  if (!workflow) {
    const error = new Error(`Workflow not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const run = await executeWorkflowRun(workflow, input);
  await writeJson(runFile(workflow.id, run.id), run);
  await appendModuleLog("workflows", {
    message: "Workflow run created",
    details: {
      workflowId: workflow.id,
      runId: run.id,
      status: run.status,
      nodeRuns: run.nodeRuns.length
    }
  });
  return run;
}

function nodePrompt(node, input = {}) {
  return String(
    node.prompt ||
    node.message ||
    input.prompt ||
    input.message ||
    input.trigger ||
    `Run workflow node ${node.label || node.id}`
  ).slice(0, 12000);
}

function nodeStatusFromModuleResult(result) {
  if (!result) return "failed";
  if (result.ok === false) return result.mode === "ready_to_configure" ? "ready_to_configure" : "failed";
  return result.mode === "missing_dependency" ? "missing_dependency" : "completed";
}

function shouldRetryNode(status) {
  return ["failed", "error"].includes(status);
}

async function executeAgentNode(node, input = {}, context = {}) {
  const provider = node.provider || input.provider;
  const workflowRuntime = ["hermes", "openclaw"].includes(context.workflowRuntime) ? context.workflowRuntime : "hermes";
  const hasExplicitExecutionMode = ["native", "preview"].includes(input.executionMode);
  const executionMode = input.executionMode === "native" ? "native" : "preview";
  const moduleId = executionMode === "native"
    ? (node.nativeModuleId || workflowRuntime)
    : (node.moduleId || "codex-api");
  if (!moduleId) {
    return {
      status: "completed",
      message: `${node.label || node.id} has no module target; treated as design-only agent node.`,
      output: { mode: "design_only" }
    };
  }

  const prompt = nodePrompt(node, input);
  let result;
  if (moduleId === "codex-api") {
    result = await runCodexPreview({
      message: prompt,
      runtime: workflowRuntime,
      timeoutMs: node.timeoutMs || input.timeoutMs
    });
  } else {
    const module = await getModule(moduleId);
    if (!module) {
      return {
        status: "failed",
        message: `No module registered for ${moduleId}.`,
        output: { moduleId }
      };
    }
    if (module.status !== "connected" && moduleId !== "provider-router") {
      return {
        status: module.status,
        message: `${node.label || node.id} is waiting for ${moduleId} configuration.`,
        output: { moduleId, missing: module.missing || [] }
      };
    }
    result = moduleId === "provider-router"
      ? await runRouter({ prompt, provider, dryRun: node.dryRun ?? input.dryRun })
      : await runModule(moduleId, {
        ...input,
        prompt,
        message: prompt,
        dryRun: hasExplicitExecutionMode
          ? executionMode !== "native"
          : (node.dryRun ?? input.dryRun ?? true),
        workflowNative: executionMode === "native",
        workflowId: context.workflowId,
        runId: context.runId,
        timeoutMs: node.timeoutMs || input.timeoutMs,
        recordHandoff: false
      });
  }
  const status = executionMode === "native" && result.mode === "dry_run"
    ? "ready_to_configure"
    : nodeStatusFromModuleResult(result);
  return {
    status,
    message: result.message || result.reply || `${node.label || node.id} ${status}.`,
    output: {
      mode: result.mode,
      provider: result.provider,
      model: result.model,
      moduleId,
      runtime: workflowRuntime,
      executionMode,
      reply: String(result.reply || result.message || "").slice(0, 12000),
      usage: result.usage,
      latencyMs: result.latencyMs
    }
  };
}

async function executeToolNode(node, input = {}, context = {}) {
  const stored = await getStoredConnectionConfig();
  const firecrawlReady = Boolean(getConfiguredValue(stored, "firecrawl-builder", "FIRECRAWL_API_KEY"));
  if (node.moduleId === "firecrawl-builder" && !firecrawlReady) {
    return {
      status: "ready_to_configure",
      message: "Firecrawl execution needs FIRECRAWL_API_KEY. Design mode remains available.",
      output: { moduleId: node.moduleId, missing: ["FIRECRAWL_API_KEY"] }
    };
  }
  if (!node.moduleId) {
    return {
      status: "completed",
      message: `${node.label || node.id} has no module target; treated as design-only tool node.`,
      output: { mode: "design_only" }
    };
  }
  const module = await getModule(node.moduleId);
  if (!module) {
    return {
      status: "failed",
      message: `No module registered for ${node.moduleId}.`,
      output: { moduleId: node.moduleId }
    };
  }
  if (module.status !== "connected") {
    return {
      status: module.status,
      message: `${node.label || node.id} is waiting for ${node.moduleId} configuration.`,
      output: { moduleId: node.moduleId, missing: module.missing || [] }
    };
  }
  const prompt = nodePrompt(node, input);
  const result = await runModule(node.moduleId, {
    ...input,
    prompt,
    message: prompt,
    tool: node.tool || node.name,
    title: node.title,
    column: node.column,
    status: node.status,
    notes: node.notes,
    priority: node.priority,
    assignee: node.assignee,
    dueAt: node.dueAt,
    sourceType: node.sourceType,
    sourceId: node.sourceId,
    linkedModule: node.linkedModule,
    linkedItemId: node.linkedItemId,
    workflowId: context.workflowId,
    runId: context.runId,
    nodeId: node.id,
    node
  });
  const status = nodeStatusFromModuleResult(result);
  return {
    status,
    message: result.message || result.reply || `${node.label || node.id} ${status}.`,
    output: {
      mode: result.mode,
      moduleId: node.moduleId
    }
  };
}

function valueAtPath(source, key) {
  if (!key) return undefined;
  return String(key).split(".").reduce((current, part) => current?.[part], source);
}

function compareValue(actual, operator, expected) {
  const op = String(operator || "truthy").toLowerCase();
  if (op === "truthy") return Boolean(actual);
  if (op === "falsy") return !actual;
  if (op === "equals" || op === "eq" || op === "==") return String(actual) === String(expected);
  if (op === "not_equals" || op === "neq" || op === "!=") return String(actual) !== String(expected);
  if (op === "includes") return String(actual || "").includes(String(expected || ""));
  if (op === "gt" || op === ">") return Number(actual) > Number(expected);
  if (op === "gte" || op === ">=") return Number(actual) >= Number(expected);
  if (op === "lt" || op === "<") return Number(actual) < Number(expected);
  if (op === "lte" || op === "<=") return Number(actual) <= Number(expected);
  return Boolean(actual);
}

function conditionBranch(node, input = {}) {
  const explicitBranch = input.branches?.[node.id] ?? input.branchMap?.[node.id] ?? node.branch ?? node.defaultBranch;
  if (explicitBranch != null) return normalizeBranch(explicitBranch);
  if (input.conditions && Object.hasOwn(input.conditions, node.id)) {
    return input.conditions[node.id] ? "true" : "false";
  }
  const field = node.field || node.inputKey || node.left;
  if (field) {
    const actual = valueAtPath(input, field);
    return compareValue(actual, node.operator, node.value ?? node.expected) ? "true" : "false";
  }
  if (typeof node.condition === "boolean") return node.condition ? "true" : "false";
  return normalizeBranch(node.condition || "true");
}

function loopBranch(node, input = {}, context = {}) {
  const loopCounts = context.loopCounts || {};
  const current = loopCounts[node.id] || 0;
  const inputLimit = input.loopIterations?.[node.id] ?? input.loopLimits?.[node.id];
  const maxIterations = Math.max(0, Number(node.maxIterations ?? inputLimit ?? 0));
  if (current < maxIterations) {
    loopCounts[node.id] = current + 1;
    return { branch: "loop", iteration: current + 1, maxIterations };
  }
  return { branch: "done", iteration: current, maxIterations };
}

async function executeNode(node, input = {}, context = {}) {
  if (node.type === "start" || node.type === "end") {
    return { status: "completed", message: `${node.label || node.id} completed.`, output: {} };
  }
  if (node.type === "transform") {
    return { status: "completed", message: `${node.label || node.id} transform completed.`, output: { mode: "transform", inputKeys: Object.keys(input || {}) } };
  }
  if (node.type === "if_else") {
    const branch = conditionBranch(node, input);
    return { status: "completed", message: `${node.label || node.id} routed to ${branch}.`, output: { mode: node.type, branch } };
  }
  if (node.type === "while_loop") {
    const loop = loopBranch(node, input, context);
    return {
      status: "completed",
      message: `${node.label || node.id} ${loop.branch === "loop" ? `iteration ${loop.iteration}` : "completed"}.`,
      output: { mode: node.type, ...loop }
    };
  }
  if (node.type === "user_approval") {
    const approved = Boolean(input.approvals?.[node.id] || input.approved === true || context.resumeApprovedNodeId === node.id);
    const sourceId = ["workflow_approval", context.workflowId, context.runId, node.id].filter(Boolean).join(":");
    if (approved) {
      const updated = await updateKanbanCards({
        sourceType: "workflow_approval",
        workflowId: context.workflowId,
        runId: context.runId,
        nodeId: node.id
      }, {
        column: node.approvedColumn || "done",
        status: "approved",
        approvalStatus: "approved",
        approvedAt: now(),
        completedAt: now(),
        notes: node.approvedNotes || `Approved workflow node ${node.label || node.id}.`
      });
      return {
        status: "completed",
        message: "Human approval received.",
        output: {
          approved: true,
          kanbanUpdated: updated.count
        }
      };
    }
    const card = await upsertKanbanCard({
      title: node.kanbanTitle || node.title || `Approve workflow: ${node.label || node.id}`,
      column: node.kanbanColumn || "review",
      status: "waiting_approval",
      notes: node.notes || `Workflow ${context.workflowId || "unknown"} run ${context.runId || "unknown"} is paused at ${node.label || node.id}.`,
      priority: node.priority || "normal",
      sourceType: "workflow_approval",
      sourceId,
      workflowId: context.workflowId,
      runId: context.runId,
      nodeId: node.id,
      approvalId: sourceId,
      approvalStatus: "pending",
      approvalRequestedAt: now()
    }, {
      sourceType: "workflow_approval",
      workflowId: context.workflowId,
      runId: context.runId,
      nodeId: node.id
    });
    return {
      status: "waiting_for_approval",
      message: "Workflow paused for human approval.",
      output: {
        approved: false,
        kanbanCardId: card.card.id
      }
    };
  }
  if (node.type === "agent") return executeAgentNode(node, input, context);
  if (node.type === "mcp_tool") return executeToolNode(node, input, context);
  return { status: "completed", message: `${node.label || node.id} completed.`, output: {} };
}

async function executeNodeWithRetries(node, input = {}, context = {}) {
  const maxRetries = Math.max(0, Number(node.maxRetries ?? input.maxNodeRetries ?? 0));
  const attempts = [];
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const startedAt = now();
    const result = await executeNode(node, input, context);
    const finishedAt = now();
    const record = {
      nodeId: node.id,
      label: node.label || node.id,
      type: node.type,
      moduleId: node.moduleId || null,
      provider: node.provider || null,
      status: result.status,
      message: result.message,
      attempt,
      retry: attempt > 1,
      output: result.output || {},
      startedAt,
      finishedAt,
      durationMs: elapsedMs(startedAt, finishedAt),
      timestamp: finishedAt
    };
    attempts.push(record);
    if (!shouldRetryNode(result.status) || attempt > maxRetries) break;
  }
  return attempts;
}

function terminalStatus(currentStatus, nodeStatus) {
  if (currentStatus === "failed") return currentStatus;
  if (nodeStatus === "failed" || nodeStatus === "error") return "failed";
  if (currentStatus === "waiting_for_approval") return currentStatus;
  if (nodeStatus === "waiting_for_approval") return "waiting_for_approval";
  if (currentStatus === "ready_to_configure") return currentStatus;
  if (["ready_to_configure", "missing_dependency", "disabled"].includes(nodeStatus)) return "ready_to_configure";
  return currentStatus;
}

function selectNextEdge(node, outgoingEdges = [], finalAttempt = null) {
  if (!outgoingEdges.length) return null;
  if (outgoingEdges.length === 1) return outgoingEdges[0];
  const branch = finalAttempt?.output?.branch || finalAttempt?.status;
  const aliases = branchAliases(branch);
  const matched = outgoingEdges.find((edge) =>
    edgeBranches(edge).some((candidate) => aliases.has(candidate))
  );
  if (matched) return matched;
  const defaultEdge = outgoingEdges.find((edge) =>
    edge.default === true ||
    edge.isDefault === true ||
    edgeBranches(edge).some((candidate) => ["default", "else", "fallback"].includes(candidate))
  );
  return defaultEdge || outgoingEdges[0];
}

function isRoutingNode(node) {
  return ["if_else", "while_loop"].includes(node.type);
}

function selectNextEdges(node, outgoingEdges = [], finalAttempt = null, input = {}) {
  if (!outgoingEdges.length) return [];
  if (outgoingEdges.length === 1) return [outgoingEdges[0]];
  if (isRoutingNode(node) || node.parallel === false || input.parallelBranches === false) {
    return [selectNextEdge(node, outgoingEdges, finalAttempt)].filter(Boolean);
  }
  return outgoingEdges;
}

function aggregateStatuses(statuses = []) {
  if (statuses.some((status) => status === "failed" || status === "error")) return "failed";
  if (statuses.some((status) => status === "waiting_for_approval")) return "waiting_for_approval";
  if (statuses.some((status) => ["ready_to_configure", "missing_dependency", "disabled"].includes(status))) {
    return "ready_to_configure";
  }
  return "completed";
}

function appendEvent(run, type, input) {
  const event = runEvent(type, input);
  run.events.push(event);
  return event;
}

async function executeWorkflowRun(workflow, input = {}, existingRun = null) {
  const graph = buildGraph(workflow);
  const run = {
    id: existingRun?.id || `run-${Date.now()}`,
    workflowId: workflow.id,
    status: "running",
    input,
    nodeRuns: existingRun?.nodeRuns ? [...existingRun.nodeRuns] : [],
    events: existingRun?.events ? [...existingRun.events] : [],
    traversedEdges: existingRun?.traversedEdges ? [...existingRun.traversedEdges] : [],
    graph: {
      mode: graph.implicitMode ? "implicit_order" : "edge_traversal",
      maxSteps: Math.max(1, Math.min(500, Number(input.maxSteps || workflow.maxSteps || 100))),
      steps: existingRun?.graph?.steps || 0,
      waitingNodeId: null,
      waitingBranchId: null,
      branchCount: existingRun?.graph?.branchCount || 0,
      parallelGroups: existingRun?.graph?.parallelGroups ? [...existingRun.graph.parallelGroups] : []
    },
    createdAt: existingRun?.createdAt || now(),
    updatedAt: now()
  };
  appendEvent(run, existingRun ? "run_resumed" : "run_started", {
    status: "running",
    message: existingRun ? `Workflow ${workflow.id} resumed.` : `Workflow ${workflow.id} started.`,
    details: { workflowId: workflow.id, graphMode: run.graph.mode }
  });

  const context = {
    resumeApprovedNodeId: null,
    loopCounts: {},
    workflowId: workflow.id,
    runId: run.id,
    workflowRuntime: ["hermes", "openclaw"].includes(workflow.runtime) ? workflow.runtime : "hermes",
    executionMode: input.executionMode === "native" ? "native" : "preview"
  };
  let currentNodeId = graph.startNode?.id || null;
  let parallelGroupSequence = run.graph.parallelGroups.length;

  if (existingRun) {
    const waiting = [...existingRun.nodeRuns].reverse().find((nodeRun) => nodeRun.status === "waiting_for_approval");
    context.resumeApprovedNodeId = waiting?.nodeId || null;
    currentNodeId = context.resumeApprovedNodeId || currentNodeId;
  }

  if (!currentNodeId) {
    run.status = "failed";
    appendEvent(run, "run_failed", {
      level: "error",
      status: "failed",
      message: "Workflow has no runnable nodes.",
      details: { workflowId: workflow.id }
    });
    run.updatedAt = now();
    return run;
  }

  function nextBranchId(parentBranchId = null) {
    run.graph.branchCount += 1;
    return parentBranchId ? `${parentBranchId}.${run.graph.branchCount}` : `branch-${run.graph.branchCount}`;
  }

  function recordEdgeTraversal(edge, node, finalAttempt, branchId, parallelGroupId = null) {
    run.traversedEdges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label || edge.branch || edge.condition || edge.sourceHandle || "",
      implicit: Boolean(edge.implicit),
      branchId,
      parallelGroupId,
      timestamp: now()
    });
    appendEvent(run, "edge_traversed", {
      edgeId: edge.id,
      nodeId: node.id,
      branchId,
      parallelGroupId,
      status: "completed",
      message: `${edge.source} -> ${edge.target}`,
      details: {
        branch: finalAttempt.output?.branch || null,
        label: edge.label || edge.branch || edge.condition || edge.sourceHandle || "",
        implicit: Boolean(edge.implicit)
      }
    });
  }

  async function executeBranch(startNodeId, branchId, parentParallelGroupId = null) {
    let branchNodeId = startNodeId;
    let branchStatus = "completed";

    while (branchNodeId && run.graph.steps < run.graph.maxSteps) {
      const node = graph.nodeMap.get(String(branchNodeId));
      if (!node) {
        appendEvent(run, "node_missing", {
          level: "error",
          nodeId: branchNodeId,
          branchId,
          parallelGroupId: parentParallelGroupId,
          status: "failed",
          message: `Node not found: ${branchNodeId}.`
        });
        return "failed";
      }

      run.graph.steps += 1;
      appendEvent(run, "node_started", {
        nodeId: node.id,
        branchId,
        parallelGroupId: parentParallelGroupId,
        status: "running",
        message: `${node.label || node.id} started.`,
        details: { type: node.type, step: run.graph.steps }
      });
      const attempts = await executeNodeWithRetries(node, input, context);
      const annotatedAttempts = attempts.map((attempt) => ({
        ...attempt,
        branchId,
        parallelGroupId: parentParallelGroupId
      }));
      run.nodeRuns.push(...annotatedAttempts);
      const finalAttempt = annotatedAttempts[annotatedAttempts.length - 1];
      appendEvent(run, finalAttempt.status === "completed" ? "node_completed" : "node_stopped", {
        level: finalAttempt.status === "completed" ? "info" : "warn",
        nodeId: node.id,
        branchId,
        parallelGroupId: parentParallelGroupId,
        status: finalAttempt.status,
        message: finalAttempt.message,
        details: {
          attempt: finalAttempt.attempt,
          retry: finalAttempt.retry,
          output: finalAttempt.output
        }
      });

      branchStatus = terminalStatus(branchStatus, finalAttempt.status);
      if (branchStatus === "waiting_for_approval") {
        run.graph.waitingNodeId = node.id;
        run.graph.waitingBranchId = branchId;
        appendEvent(run, "run_paused", {
          level: "warn",
          nodeId: node.id,
          branchId,
          parallelGroupId: parentParallelGroupId,
          status: branchStatus,
          message: `Workflow paused at ${node.label || node.id}.`
        });
        return branchStatus;
      }
      if (branchStatus !== "completed") return branchStatus;
      if (node.type === "end") return branchStatus;

      const nextEdges = selectNextEdges(node, graph.outgoing.get(String(node.id)) || [], finalAttempt, input);
      if (!nextEdges.length) return branchStatus;

      if (nextEdges.length === 1) {
        recordEdgeTraversal(nextEdges[0], node, finalAttempt, branchId, parentParallelGroupId);
        branchNodeId = nextEdges[0].target;
        continue;
      }

      parallelGroupSequence += 1;
      const parallelGroupId = `pg-${parallelGroupSequence}`;
      const childBranches = nextEdges.map((edge) => ({
        edge,
        branchId: nextBranchId(branchId)
      }));
      const groupRecord = {
        id: parallelGroupId,
        sourceNodeId: node.id,
        parentBranchId: branchId,
        branchIds: childBranches.map((branch) => branch.branchId),
        edgeIds: childBranches.map((branch) => branch.edge.id),
        status: "running",
        startedAt: now(),
        completedAt: null
      };
      run.graph.mode = "parallel_edge_traversal";
      run.graph.parallelGroups.push(groupRecord);
      appendEvent(run, "parallel_group_started", {
        nodeId: node.id,
        branchId,
        parallelGroupId,
        status: "running",
        message: `${node.label || node.id} started ${childBranches.length} parallel branches.`,
        details: {
          branchIds: groupRecord.branchIds,
          edgeIds: groupRecord.edgeIds
        }
      });

      childBranches.forEach((child) => recordEdgeTraversal(child.edge, node, finalAttempt, child.branchId, parallelGroupId));
      const childStatuses = await Promise.all(
        childBranches.map((child) => executeBranch(child.edge.target, child.branchId, parallelGroupId))
      );
      const groupStatus = aggregateStatuses(childStatuses);
      groupRecord.status = groupStatus;
      groupRecord.completedAt = now();
      appendEvent(run, "parallel_group_completed", {
        nodeId: node.id,
        branchId,
        parallelGroupId,
        status: groupStatus,
        level: groupStatus === "completed" ? "info" : "warn",
        message: `${node.label || node.id} parallel branches finished with ${groupStatus}.`,
        details: {
          branchStatuses: childBranches.map((child, index) => ({
            branchId: child.branchId,
            edgeId: child.edge.id,
            status: childStatuses[index]
          }))
        }
      });
      return groupStatus;
    }

    return branchStatus;
  }

  const status = await executeBranch(
    currentNodeId,
    existingRun?.graph?.waitingBranchId || nextBranchId(),
    null
  );

  if (run.graph.steps >= run.graph.maxSteps && status === "completed") {
    run.status = "failed";
    appendEvent(run, "loop_guard_triggered", {
      level: "error",
      status: run.status,
      message: `Workflow stopped after ${run.graph.maxSteps} graph steps.`,
      details: { maxSteps: run.graph.maxSteps }
    });
  } else {
    run.status = status;
  }

  appendEvent(run, run.status === "completed" ? "run_completed" : run.status === "failed" ? "run_failed" : "run_stopped", {
    level: run.status === "completed" ? "info" : "warn",
    status: run.status,
    message: `Workflow ${workflow.id} finished with ${run.status}.`,
    details: {
      nodeRuns: run.nodeRuns.length,
      traversedEdges: run.traversedEdges.length,
      steps: run.graph.steps,
      parallelGroups: run.graph.parallelGroups.length
    }
  });
  run.updatedAt = now();
  return run;
}

export async function resumeWorkflowRun(workflowId, runId, input = {}) {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    const error = new Error(`Workflow not found: ${workflowId}`);
    error.status = 404;
    throw error;
  }
  const existing = await getWorkflowRun(workflowId, runId);
  if (!existing) {
    const error = new Error(`Run not found: ${runId}`);
    error.status = 404;
    throw error;
  }
  if (existing.status !== "waiting_for_approval") {
    const error = new Error(`Workflow run is not waiting for approval: ${existing.status}`);
    error.status = 400;
    throw error;
  }
  const run = await executeWorkflowRun(workflow, { ...existing.input, ...input, approved: true }, existing);
  await writeJson(runFile(workflow.id, run.id), run);
  await appendModuleLog("workflows", {
    message: "Workflow run resumed",
    details: {
      workflowId,
      runId,
      status: run.status,
      nodeRuns: run.nodeRuns.length
    }
  });
  return run;
}

export async function getWorkflowRun(workflowId, runId) {
  return readJson(runFile(workflowId, runId), null);
}

export async function getWorkflowRunEvents(workflowId, runId) {
  const run = await getWorkflowRun(workflowId, runId);
  if (!run) return null;
  return {
    workflowId,
    runId,
    status: run.status,
    eventCount: run.events?.length || 0,
    events: run.events || []
  };
}

function nodePosition(node, depth, index) {
  const raw = node.position || node.data?.position || {};
  const x = Number.isFinite(Number(raw.x)) ? Number(raw.x) : depth * 260;
  const y = Number.isFinite(Number(raw.y)) ? Number(raw.y) : index * 112;
  return { x, y };
}

function publicReplayText(key, value) {
  return String(redactValue(key, value ?? ""));
}

function replayLayout(graph) {
  const depthByNode = new Map();
  const seen = new Set();
  const queue = graph.startNode ? [{ id: String(graph.startNode.id), depth: 0 }] : [];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    depthByNode.set(current.id, Math.min(current.depth, depthByNode.get(current.id) ?? current.depth));
    for (const edge of graph.outgoing.get(current.id) || []) {
      if (!seen.has(edge.target)) queue.push({ id: edge.target, depth: current.depth + 1 });
    }
  }
  const depthCounts = new Map();
  return new Map(graph.nodes.map((node) => {
    const id = String(node.id);
    const depth = depthByNode.get(id) ?? 0;
    const index = depthCounts.get(depth) || 0;
    depthCounts.set(depth, index + 1);
    return [id, { depth, index, position: nodePosition(node, depth, index) }];
  }));
}

function finalStatusForNode(nodeRuns = []) {
  if (!nodeRuns.length) return "not_run";
  const statuses = nodeRuns.map((item) => item.status);
  if (statuses.includes("failed") || statuses.includes("error")) return "failed";
  if (statuses.includes("waiting_for_approval")) return "waiting_for_approval";
  if (statuses.some((status) => ["ready_to_configure", "missing_dependency", "disabled"].includes(status))) {
    return "ready_to_configure";
  }
  return statuses.at(-1) || "not_run";
}

export async function getWorkflowRunReplay(workflowId, runId) {
  const [workflow, run] = await Promise.all([
    getWorkflow(workflowId),
    getWorkflowRun(workflowId, runId)
  ]);
  if (!workflow || !run) return null;

  const graph = buildGraph(workflow);
  const layout = replayLayout(graph);
  const nodeRunsById = new Map();
  for (const nodeRun of run.nodeRuns || []) {
    nodeRunsById.set(nodeRun.nodeId, [...(nodeRunsById.get(nodeRun.nodeId) || []), nodeRun]);
  }
  const traversedByEdgeId = new Map();
  for (const edge of run.traversedEdges || []) {
    traversedByEdgeId.set(edge.id, [...(traversedByEdgeId.get(edge.id) || []), edge]);
  }

  const nodes = graph.nodes.map((node) => {
    const attempts = nodeRunsById.get(String(node.id)) || [];
    const final = attempts.at(-1) || null;
    const layoutItem = layout.get(String(node.id)) || { depth: 0, index: 0, position: nodePosition(node, 0, 0) };
    return {
      id: publicReplayText("nodeId", node.id),
      label: publicReplayText("label", node.label || node.name || node.id),
      type: publicReplayText("type", node.type),
      status: finalStatusForNode(attempts),
      attempts: attempts.length,
      branchIds: Array.from(new Set(attempts.map((attempt) => attempt.branchId).filter(Boolean))).map((id) => publicReplayText("branchId", id)),
      parallelGroupIds: Array.from(new Set(attempts.map((attempt) => attempt.parallelGroupId).filter(Boolean))).map((id) => publicReplayText("parallelGroupId", id)),
      message: publicReplayText("message", final?.message || ""),
      durationMs: attempts.reduce((sum, attempt) => sum + Number(attempt.durationMs || 0), 0),
      startedAt: attempts[0]?.startedAt || null,
      finishedAt: final?.finishedAt || null,
      depth: layoutItem.depth,
      position: layoutItem.position
    };
  });

  const edges = graph.edges
    .map((edge, index) => {
      const normalized = {
        ...edge,
        id: edgeId(edge, index),
        source: edgeSource(edge),
        target: edgeTarget(edge)
      };
      return normalized.source && normalized.target ? normalized : null;
    })
    .filter(Boolean)
    .map((edge) => {
      const traversals = traversedByEdgeId.get(edge.id) || [];
      return {
        id: publicReplayText("edgeId", edge.id),
        source: publicReplayText("source", edge.source),
        target: publicReplayText("target", edge.target),
        label: publicReplayText("label", edge.label || edge.branch || edge.condition || edge.sourceHandle || ""),
        implicit: Boolean(edge.implicit),
        status: traversals.length ? "traversed" : "not_traversed",
        traversals: traversals.length,
        branchIds: Array.from(new Set(traversals.map((item) => item.branchId).filter(Boolean))).map((id) => publicReplayText("branchId", id)),
        parallelGroupIds: Array.from(new Set(traversals.map((item) => item.parallelGroupId).filter(Boolean))).map((id) => publicReplayText("parallelGroupId", id)),
        traversedAt: traversals.at(-1)?.timestamp || null
      };
    });

  const summary = {
    nodes: nodes.length,
    nodeRuns: run.nodeRuns?.length || 0,
    completedNodes: nodes.filter((node) => node.status === "completed").length,
    failedNodes: nodes.filter((node) => node.status === "failed").length,
    waitingNodes: nodes.filter((node) => node.status === "waiting_for_approval").length,
    readyToConfigureNodes: nodes.filter((node) => node.status === "ready_to_configure").length,
    edges: edges.length,
    traversedEdges: edges.filter((edge) => edge.status === "traversed").length,
    branches: run.graph?.branchCount || 0,
    parallelGroups: run.graph?.parallelGroups?.length || 0,
    events: run.events?.length || 0
  };

  return {
    workflowId: publicReplayText("workflowId", workflowId),
    runId: publicReplayText("runId", runId),
    status: publicReplayText("status", run.status),
    graphMode: publicReplayText("graphMode", run.graph?.mode || "legacy"),
    generatedAt: now(),
    summary,
    nodes,
    edges,
    parallelGroups: (run.graph?.parallelGroups || []).map((group) => ({
      id: publicReplayText("parallelGroupId", group.id),
      sourceNodeId: publicReplayText("sourceNodeId", group.sourceNodeId),
      parentBranchId: publicReplayText("parentBranchId", group.parentBranchId),
      branchIds: (group.branchIds || []).map((id) => publicReplayText("branchId", id)),
      edgeIds: (group.edgeIds || []).map((id) => publicReplayText("edgeId", id)),
      status: publicReplayText("status", group.status),
      startedAt: group.startedAt || null,
      completedAt: group.completedAt || null
    })),
    waitingNodeId: run.graph?.waitingNodeId ? publicReplayText("waitingNodeId", run.graph.waitingNodeId) : null,
    waitingBranchId: run.graph?.waitingBranchId ? publicReplayText("waitingBranchId", run.graph.waitingBranchId) : null
  };
}
