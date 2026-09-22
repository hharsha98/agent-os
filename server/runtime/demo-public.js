/**
 * Public demo mode (DEMO_PUBLIC=1).
 * Simulated agents and canned machine transcripts only.
 * This module does not spawn processes or import the execution gate.
 */

export const DEMO_BADGE = "Public demo · sandboxed";
export const DEMO_WORKFLOW_ID = "public-demo-canvas";

const REAL_NAME = {
  cursor: "Cursor",
  claude: "Claude",
  codex: "Codex",
  hermes: "Hermes",
  openclaw: "OpenClaw"
};

export function isDemoPublic(env = process.env) {
  const value = String(env.DEMO_PUBLIC || env.HERMES_AGENT_OS_DEMO_PUBLIC || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function publicFocus(message) {
  let text = String(message || "").replace(/\s+/g, " ").trim();
  text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
  text = text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  text = text.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]");
  if (!text) return "walk a stranger through Mission Control, Chat, and the sandbox";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function notConnectedLine(id) {
  const name = REAL_NAME[id] || "agent";
  return `Your real ${name} is not connected.`;
}

export function applyDemoPresentation(dashboard = {}) {
  const agents = (dashboard.agents || []).map((agent) => {
    const id = agent.id;
    const routed = id !== "openclaw";
    return {
      ...agent,
      status: "demo",
      simulated: true,
      realSession: false,
      badge: "Demo",
      available: true,
      hostCli: agent.cli || { found: false, command: id, version: null },
      connection: "Simulated demo agent",
      summary: `${agent.name || id} is simulated for the public demo. ${notConnectedLine(id)}`,
      hint: "Public demo data. No host CLI is driven from this card.",
      cli: {
        found: false,
        simulated: true,
        online: true,
        command: "demo",
        version: "simulated"
      },
      chat: {
        mode: "demo",
        routed,
        label: "Demo",
        detail: `Simulated public-demo agent. ${notConnectedLine(id)}`
      },
      liveExecution: {
        allowed: false,
        label: "Locked",
        detail: "Public demo does not run host commands."
      },
      nextAction: routed
        ? "Open Unified Chat and run a simulated multi-agent timeline."
        : "Open the demo workflow canvas. OpenClaw stays simulated."
    };
  });
  const summary = dashboard.summary || {};
  return {
    ...dashboard,
    hosted: false,
    edition: "public-demo",
    demoPublic: true,
    badge: DEMO_BADGE,
    summary: {
      ...summary,
      simulated: true,
      demoOnline: agents.length,
      dashboardChatReady: agents.filter((agent) => agent.chat?.routed).length,
      executionEnabled: false,
      dryRunDefault: true
    },
    agents
  };
}

const VOICES = {
  cursor: {
    label: "Cursor Agent",
    steps(focus) {
      return [
        `Frame “${focus}” as a file-touch list inside the sandbox only.`,
        "Name the modules a coding agent would open: Mission Control, Chat, Workspace.",
        "Draft the smallest note to add under workspace/notes — do not edit the host repo.",
        "List checks a human would run later (smoke:public). This demo does not run them on a shell.",
        "Hand the sketch to the Claude demo seat for a review pass, then stop."
      ];
    }
  },
  claude: {
    label: "Claude Code",
    steps(focus) {
      return [
        `Restate the goal in one sentence: ${focus}.`,
        "Separate what the public demo can show (plans, notes, a canvas) from what it must not do (host shell).",
        "Review the plan for honesty: every agent stays labeled Demo.",
        "Propose a workspace note the visitor can save and re-open.",
        "End with a verification line: execution gate stays locked."
      ];
    }
  },
  codex: {
    label: "Codex",
    steps(focus) {
      return [
        `Turn “${focus}” into a five-node canvas: prompt → plan → gate → note → done.`,
        "Keep the canvas in local workflow storage. Convex and Clerk stay unused.",
        "Mark the human gate as simulated approval, not a live tool call.",
        "Point the last node at workspace/demo/latest-canvas.md.",
        "Refuse any step that would spawn a CLI."
      ];
    }
  },
  hermes: {
    label: "Hermes Agent",
    steps(focus) {
      return [
        `File an episodic note for “${focus}” in the shared demo sandbox.`,
        "Recall the seeded briefing in workspace/demo/briefing.md.",
        "Sequence the other demo seats: Cursor sketch, Claude review, Codex canvas.",
        "Record that memory on this server is the demo store, not the visitor’s laptop.",
        "Leave gateway restart, Kanban dispatch, and shell off."
      ];
    }
  }
};

export function buildDemoChatReply({ agentId = "claude", message = "" } = {}) {
  const id = VOICES[agentId] ? agentId : "claude";
  const voice = VOICES[id];
  const focus = publicFocus(message);
  const steps = voice.steps(focus);
  const lines = [
    `## Demo plan · ${voice.label}`,
    "",
    `**${DEMO_BADGE}**`,
    "",
    `This is a simulated ${voice.label} reply. ${notConnectedLine(id)}`,
    "",
    `Goal: ${focus}`,
    "",
    "### Steps",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "### What did not happen",
    "- No CLI was started.",
    "- No provider API key was required.",
    "- Live execution stays locked on a public demo.",
    "",
    "Run the simulated timeline to watch the demo fleet hand this goal across seats, then open Workspace to read the note."
  ];
  return {
    ok: true,
    simulated: true,
    executedOnHost: false,
    realSession: false,
    mode: "demo",
    badge: DEMO_BADGE,
    agentId: id,
    label: voice.label,
    reply: lines.join("\n")
  };
}

export function buildDemoTimeline({ message = "" } = {}) {
  const focus = publicFocus(message);
  const steps = [
    {
      id: "dispatch",
      agentId: "mission",
      title: "Mission Control dispatches the demo fleet",
      detail: `Seats are simulated and labeled Demo. Goal received: ${focus}`,
      status: "simulated",
      durationMs: 380
    },
    {
      id: "cursor",
      agentId: "cursor",
      title: "Cursor demo sketches the touch list",
      detail: "Files stay inside the sandbox: demo/briefing.md, notes/, and the canvas. No editor session is attached.",
      status: "simulated",
      durationMs: 640
    },
    {
      id: "claude",
      agentId: "claude",
      title: "Claude demo reviews the plan",
      detail: "Review checks the badge, the locked execution gate, and that the reply does not claim a real Claude login.",
      status: "simulated",
      durationMs: 720
    },
    {
      id: "codex",
      agentId: "codex",
      title: "Codex demo sequences the workflow",
      detail: "Canvas order: prompt → plan → human gate → sandbox note → done. Convex is not contacted.",
      status: "simulated",
      durationMs: 690
    },
    {
      id: "hermes",
      agentId: "hermes",
      title: "Hermes demo files the handoff",
      detail: "The handoff is a markdown note in the shared sandbox, not a gateway run.",
      status: "simulated",
      durationMs: 540
    },
    {
      id: "workspace",
      agentId: "workspace",
      title: "Workspace records the timeline",
      detail: "Wrote demo/latest-timeline.md. Nothing ran on the host shell.",
      status: "simulated",
      durationMs: 260
    }
  ];
  const lines = [
    `# Demo timeline`,
    "",
    `**${DEMO_BADGE}**`,
    "",
    `Goal: ${focus}`,
    "",
    "Simulated multi-agent handoff. Your real Claude, Cursor, Codex, and Hermes are not connected.",
    "",
    ...steps.map((step, index) => `${index + 1}. **${step.title}** (${step.agentId}) — ${step.detail}`),
    "",
    "executedOnHost: false"
  ];
  return {
    ok: true,
    simulated: true,
    executedOnHost: false,
    realSession: false,
    mode: "demo",
    badge: DEMO_BADGE,
    focus,
    steps,
    markdown: lines.join("\n"),
    relativePath: "demo/latest-timeline.md"
  };
}

export const MACHINE_SCENARIOS = [
  {
    id: "health-check",
    label: "Preview health check",
    description: "What a gated local operator would see when checking the process."
  },
  {
    id: "workspace-list",
    label: "Preview sandbox listing",
    description: "What listing the demo workspace folder would print."
  },
  {
    id: "gate-status",
    label: "Preview execution gate",
    description: "What the lock looks like before any live command."
  }
];

const TRANSCRIPTS = {
  "health-check": [
    "$ # simulated — not executed",
    "$ curl -s http://127.0.0.1:8090/api/health",
    "{ \"ok\": true, \"demoPublic\": true, \"badge\": \"Public demo · sandboxed\" }",
    "exit 0 · canned transcript · host shell was not spawned"
  ].join("\n"),
  "workspace-list": [
    "$ # simulated — not executed",
    "$ ls workspace/demo workspace/notes",
    "briefing.md",
    "walkthrough.md",
    "latest-timeline.md",
    "start-here.md",
    "exit 0 · canned transcript · host shell was not spawned"
  ].join("\n"),
  "gate-status": [
    "$ # simulated — not executed",
    "$ agent-os execution-gate status",
    "enabled: false",
    "source: demo-public-lock",
    "shell: blocked",
    "Public demo locks live execution off.",
    "exit 0 · canned transcript · host shell was not spawned"
  ].join("\n")
};

export function previewDemoMachine(input = {}) {
  const base = {
    simulated: true,
    executedOnHost: false,
    realSession: false,
    badge: DEMO_BADGE
  };
  if (input.command || input.shell || input.argv || input.cmd) {
    return {
      ...base,
      ok: false,
      status: 400,
      refused: true,
      error: "Public demo does not run host shell. Choose a canned scenario."
    };
  }
  const id = String(input.scenario || "").trim();
  const scenario = MACHINE_SCENARIOS.find((item) => item.id === id);
  if (!scenario) {
    return {
      ...base,
      ok: false,
      status: 400,
      refused: true,
      error: "Unknown scenario. Public demo only previews the canned list.",
      scenarios: MACHINE_SCENARIOS
    };
  }
  return {
    ...base,
    ok: true,
    status: 200,
    refused: false,
    scenario: scenario.id,
    label: scenario.label,
    transcript: TRANSCRIPTS[scenario.id],
    note: "This transcript is canned. Nothing was executed on the host."
  };
}

export function demoWorkflowTemplate() {
  return {
    id: DEMO_WORKFLOW_ID,
    name: "Public demo · morning desk",
    description: "Local canvas for the public demo. No Convex, no Clerk, no host shell.",
    runtime: "hermes",
    draft: false,
    category: "Public demo",
    source: "public-demo",
    engine: "public-demo-simulator",
    tags: ["demo", "sandboxed"],
    nodes: [
      {
        id: "start",
        type: "start",
        label: "Visitor prompt",
        trigger: "manual",
        prompt: "A stranger opens the public demo.",
        position: { x: 40, y: 120 }
      },
      {
        id: "plan",
        type: "agent",
        label: "Claude demo plan",
        prompt: "Draft a sandboxed multi-step plan. Do not call tools.",
        position: { x: 280, y: 120 }
      },
      {
        id: "gate",
        type: "user_approval",
        label: "Human gate",
        prompt: "Simulated approval. Live execution stays locked.",
        position: { x: 520, y: 120 }
      },
      {
        id: "note",
        type: "transform",
        label: "Write sandbox note",
        prompt: "Record the result in workspace/demo/latest-canvas.md.",
        position: { x: 760, y: 120 }
      },
      {
        id: "end",
        type: "end",
        label: "Done · simulated",
        prompt: "Stop. No CLI.",
        position: { x: 1000, y: 120 }
      }
    ],
    edges: [
      { id: "e1", source: "start", target: "plan" },
      { id: "e2", source: "plan", target: "gate" },
      { id: "e3", source: "gate", target: "note" },
      { id: "e4", source: "note", target: "end" }
    ]
  };
}

export function simulateDemoWorkflow(workflow = demoWorkflowTemplate(), message = "") {
  const focus = publicFocus(message || workflow.nodes?.find((node) => node.type === "start")?.prompt || "");
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const nodeRuns = nodes.map((node, index) => ({
    nodeId: node.id,
    label: node.label || node.id,
    type: node.type,
    status: "simulated",
    order: index + 1,
    detail: node.type === "user_approval"
      ? "Simulated approval. The public demo did not unlock host execution."
      : node.type === "transform"
        ? "Recorded a sandbox note. No shell."
        : `Simulated ${node.type} step for: ${focus}`
  }));
  const lines = [
    `# Demo canvas run`,
    "",
    `**${DEMO_BADGE}**`,
    "",
    `Workflow: ${workflow.name || DEMO_WORKFLOW_ID}`,
    `Goal: ${focus}`,
    "",
    "Your real Claude is not connected. Convex was not used.",
    "",
    ...nodeRuns.map((run) => `${run.order}. **${run.label}** (${run.type}) — ${run.detail}`),
    "",
    "executedOnHost: false"
  ];
  return {
    ok: true,
    simulated: true,
    executedOnHost: false,
    realSession: false,
    mode: "demo",
    badge: DEMO_BADGE,
    workflowId: workflow.id || DEMO_WORKFLOW_ID,
    focus,
    nodeRuns,
    markdown: lines.join("\n"),
    relativePath: "demo/latest-canvas.md"
  };
}

export function demoWorkspaceFiles() {
  return [
    {
      relativePath: "demo/briefing.md",
      content: `# Public demo briefing

**${DEMO_BADGE}**

This server is a shared sandbox for a hosted walkthrough. It is not your laptop, and your real Claude, Cursor, Codex, and Hermes are not connected.

## Walkthrough

1. Mission Control shows demo agents labeled **Demo**.
2. Unified Chat returns a multi-step plan and a simulated fleet timeline.
3. This folder holds the notes those steps write.
4. Machine Control only previews canned transcripts.
5. Agent Builder is a local canvas. Convex and Clerk are not required.

Do not paste secrets here. Other visitors can open the same sandbox.
`
    },
    {
      relativePath: "demo/walkthrough.md",
      content: `# How the demo stays honest

- Badge on every surface: **${DEMO_BADGE}**
- \`DEMO_PUBLIC=1\` turns on simulated agents.
- \`HERMES_AGENT_OS_ENABLE_EXEC\` cannot unlock a shell while that flag is on.
- Workspace writes allow \`.md\`, \`.txt\`, and \`.html\` inside this sandbox only.

Open Chat, run the simulated timeline, then come back — \`demo/latest-timeline.md\` is the proof.
`
    },
    {
      relativePath: "notes/start-here.md",
      content: `# Start here

Write your own note from the Workspace page. It stays in this sandbox.

Suggested first note: what you want the demo fleet to plan, then run that prompt in Unified Chat.
`
    }
  ];
}

export function demoDisabledError() {
  const error = new Error("Public demo mode is off. Set DEMO_PUBLIC=1 to enable the sandboxed demo.");
  error.status = 404;
  return error;
}

export function assertDemoEnabled(options = {}, env = process.env) {
  if (options.demo === true || isDemoPublic(env)) return;
  throw demoDisabledError();
}
