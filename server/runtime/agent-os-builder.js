import { runCodexApi } from "./codex-api.js";
import { saveWorkflow } from "./workflows.js";

const SUPPORTED_NODE_TYPES = new Set([
  "start",
  "agent",
  "mcp_tool",
  "transform",
  "if_else",
  "while_loop",
  "user_approval",
  "end"
]);

const WORKFLOW_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    runtime: { type: "string", enum: ["hermes", "openclaw"] },
    nodes: {
      type: "array",
      minItems: 3,
      maxItems: 14,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["start", "agent", "transform", "if_else", "user_approval", "end"] },
          label: { type: "string" },
          prompt: { type: "string" },
          trigger: { type: "string" },
          condition: { type: "string" },
          position: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" }
            },
            required: ["x", "y"],
            additionalProperties: false
          }
        },
        required: ["id", "type", "label", "prompt", "trigger", "condition", "position"],
        additionalProperties: false
      }
    },
    edges: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          source: { type: "string" },
          target: { type: "string" },
          label: { type: "string" }
        },
        required: ["id", "source", "target", "label"],
        additionalProperties: false
      }
    }
  },
  required: ["name", "description", "runtime", "nodes", "edges"],
  additionalProperties: false
};

function now() {
  return new Date().toISOString();
}

function slug(value, fallback = "workflow") {
  const clean = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || fallback;
}

function normalizeRuntime(value) {
  return value === "openclaw" ? "openclaw" : "hermes";
}

function normalizeType(value) {
  const type = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (SUPPORTED_NODE_TYPES.has(type)) return type;
  if (["trigger", "manual", "schedule", "webhook"].includes(type)) return "start";
  if (["action", "api", "http", "tool", "research", "think"].includes(type)) return "agent";
  if (["condition", "if", "decision"].includes(type)) return "if_else";
  if (["approval", "human_approval", "ask_me"].includes(type)) return "user_approval";
  if (["finish", "stop"].includes(type)) return "end";
  return "agent";
}

function normalizeNodes(inputNodes, prompt) {
  const source = Array.isArray(inputNodes) ? inputNodes : [];
  const seen = new Set();
  const nodes = source.slice(0, 14).map((raw, index) => {
    const type = normalizeType(raw?.type);
    let id = slug(raw?.id || raw?.label || `${type}-${index + 1}`, `${type}-${index + 1}`);
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const position = raw?.position && Number.isFinite(Number(raw.position.x)) && Number.isFinite(Number(raw.position.y))
      ? { x: Number(raw.position.x), y: Number(raw.position.y) }
      : { x: 70 + index * 260, y: 190 + (index % 2) * 130 };
    const node = {
      ...raw,
      id,
      type,
      label: String(raw?.label || (type === "start" ? "Start" : type === "end" ? "Finish" : `Step ${index + 1}`)).slice(0, 80),
      position
    };
    if (type === "agent" || type === "mcp_tool") {
      node.type = "agent";
      node.moduleId = "codex-api";
      node.dryRun = false;
      node.timeoutMs = Math.max(30000, Number(raw?.timeoutMs || 90000));
      node.prompt = String(raw?.prompt || raw?.instruction || `Complete this part of the workflow: ${prompt}`).slice(0, 5000);
    }
    if (type === "start") {
      const triggerText = `${raw?.trigger || ""} ${raw?.label || ""} ${prompt}`;
      node.trigger = /webhook/i.test(triggerText)
        ? "webhook"
        : /schedule|every |daily|weekly|morning|monday|hourly|cron/i.test(triggerText)
          ? "schedule"
          : "manual";
    }
    return node;
  });

  if (!nodes.some((node) => node.type === "start")) {
    nodes.unshift({ id: "start", type: "start", label: "Start", trigger: "manual", position: { x: 70, y: 255 } });
  }
  if (!nodes.some((node) => node.type === "agent")) {
    nodes.splice(Math.min(1, nodes.length), 0, {
      id: "codex-agent",
      type: "agent",
      label: "Codex reasoning step",
      moduleId: "codex-api",
      dryRun: false,
      timeoutMs: 90000,
      prompt: String(prompt).slice(0, 5000),
      position: { x: 330, y: 255 }
    });
  }
  if (!nodes.some((node) => node.type === "end")) {
    nodes.push({ id: "finish", type: "end", label: "Finish", position: { x: 70 + nodes.length * 260, y: 255 } });
  }

  return nodes.map((node, index) => ({
    ...node,
    position: node.position || { x: 70 + index * 260, y: 255 }
  }));
}

function normalizeEdges(inputEdges, nodes) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(inputEdges) ? inputEdges : [])
    .map((edge, index) => ({
      ...edge,
      id: slug(edge?.id || `${edge?.source}-${edge?.target}-${index}`, `edge-${index + 1}`),
      source: String(edge?.source || edge?.from || ""),
      target: String(edge?.target || edge?.to || ""),
      label: String(edge?.label || "").slice(0, 80)
    }))
    .filter((edge) => edge.source !== edge.target && nodeIds.has(edge.source) && nodeIds.has(edge.target));
  if (edges.length) return edges;
  return nodes.slice(0, -1).map((node, index) => ({
    id: `edge-${node.id}-${nodes[index + 1].id}`,
    source: node.id,
    target: nodes[index + 1].id,
    label: ""
  }));
}

export function normalizeWorkflow(raw, prompt, input = {}) {
  const nodes = normalizeNodes(raw?.nodes, prompt);
  const id = slug(input.id || raw?.id || raw?.name || `agent-${Date.now()}`, `agent-${Date.now()}`);
  return {
    ...raw,
    id,
    name: String(input.name || raw?.name || "New AI Agent").trim().slice(0, 100) || "New AI Agent",
    description: String(raw?.description || prompt).trim().slice(0, 700),
    runtime: normalizeRuntime(input.runtime || raw?.runtime),
    engine: "codex-api",
    draft: raw?.draft !== false,
    source: "agent-os-codex-api-builder",
    nodes,
    edges: normalizeEdges(raw?.edges, nodes),
    updatedAt: now()
  };
}

function workflowRequest(userPrompt, workflow = null, instruction = "", selectedNodeId = "", runtime = "hermes") {
  const editing = Boolean(workflow);
  return [
    editing ? "Update the existing Agent OS workflow." : "Create a new Agent OS workflow.",
    `Target runtime: ${normalizeRuntime(runtime || workflow?.runtime)}.`,
    "Use 3 to 8 understandable steps unless the request truly needs more.",
    "Include exactly one start node, at least one agent node, and one end node.",
    "Available node types are start, agent, transform, if_else, user_approval, and end.",
    "Use prompt for agent instructions, trigger for start configuration, and condition for decisions. Use empty strings for fields that do not apply.",
    "Arrange nodes left to right with readable x/y positions and connect every runnable step.",
    editing ? `Existing workflow: ${JSON.stringify(workflow).slice(0, 14000)}` : `User request: ${userPrompt}`,
    editing ? `Requested change: ${instruction}` : "",
    selectedNodeId ? `Selected node: ${selectedNodeId}. Focus there unless other graph changes are necessary.` : ""
  ].filter(Boolean).join("\n");
}

async function askCodex(prompt) {
  const result = await runCodexApi({
    system: "You are the workflow architect powering Agent OS. Produce a valid, safe, beginner-friendly workflow that exactly matches the supplied JSON schema.",
    prompt,
    schema: WORKFLOW_SCHEMA,
    schemaName: "agent_os_workflow",
    maxOutputTokens: 7000,
    timeoutMs: 120000
  });
  return { parsed: result.parsed, result };
}

export async function generateAgentWorkflow(input = {}) {
  const prompt = String(input.prompt || input.message || "").trim().slice(0, 8000);
  if (!prompt) {
    const error = new Error("Describe what you want the agent to do.");
    error.status = 400;
    throw error;
  }
  const runtime = normalizeRuntime(input.runtime);
  const codex = await askCodex(workflowRequest(prompt, null, "", "", runtime));
  const workflow = await saveWorkflow(normalizeWorkflow(codex.parsed, prompt, { ...input, runtime }));
  return {
    ok: true,
    poweredBy: "codex-api",
    generationMode: "codex-api",
    message: "Codex API created and validated the visual workflow.",
    workflow,
    proof: {
      responseId: codex.result.responseId,
      requestId: codex.result.requestId,
      model: codex.result.model,
      latencyMs: codex.result.latencyMs,
      usage: codex.result.usage
    }
  };
}

export async function refineAgentWorkflow(input = {}) {
  const workflow = input.workflow && typeof input.workflow === "object" ? input.workflow : null;
  const instruction = String(input.instruction || input.prompt || "").trim().slice(0, 5000);
  if (!workflow || !instruction) {
    const error = new Error("workflow and instruction are required");
    error.status = 400;
    throw error;
  }
  const runtime = normalizeRuntime(input.runtime || workflow.runtime);
  const codex = await askCodex(workflowRequest(
    workflow.description || workflow.name || "",
    workflow,
    instruction,
    input.selectedNodeId,
    runtime
  ));
  const normalized = normalizeWorkflow(codex.parsed, workflow.description || instruction, {
    id: workflow.id,
    name: codex.parsed?.name || workflow.name,
    runtime
  });
  const saved = await saveWorkflow(normalized);
  return {
    ok: true,
    poweredBy: "codex-api",
    generationMode: "codex-api",
    message: "Codex API updated the visual workflow.",
    workflow: saved,
    proof: {
      responseId: codex.result.responseId,
      requestId: codex.result.requestId,
      model: codex.result.model,
      latencyMs: codex.result.latencyMs,
      usage: codex.result.usage
    }
  };
}
