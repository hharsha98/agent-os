import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  Database,
  Flag,
  GitBranch,
  GripVertical,
  Home,
  Layers3,
  Loader2,
  Menu,
  Play,
  PlugZap,
  Plus,
  RefreshCcw,
  Repeat2,
  Route,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  TestTube2,
  Trash2,
  UserCheck,
  WandSparkles,
  Webhook,
  Workflow as WorkflowIcon,
  Wrench,
  X,
  XCircle,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ApiGuidePage, { type ApiIntegration, type CodexApiStatus } from "./ApiGuidePage";

type AgentId = "openclaw" | "hermes";
type Page = "home" | "builder" | "apis" | AgentId;

interface RuntimeModule {
  id: string;
  label: string;
  status: string;
  configured: boolean;
  connection?: string;
  publicSummary?: string;
  version?: string | null;
  missing?: string[];
  installCommand?: string;
  installHint?: string;
  docsUrl?: string;
}

interface LocalAgentStatus {
  id: string;
  name: string;
  eyebrow: string;
  status: string;
  available: boolean;
  version?: string;
  model?: string;
  connection?: string;
  summary?: string;
}

interface WorkflowNode {
  id: string;
  type: string;
  label: string;
  prompt?: string;
  moduleId?: string;
  dryRun?: boolean;
  trigger?: string;
  position?: { x: number; y: number };
  [key: string]: unknown;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  [key: string]: unknown;
}

interface AgentWorkflow {
  id: string;
  name: string;
  description?: string;
  engine?: string;
  runtime?: "hermes" | "openclaw";
  draft?: boolean;
  starter?: boolean;
  category?: string;
  schedule?: string;
  tags?: string[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updatedAt?: string;
}

interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  runtime: "hermes" | "openclaw";
  draft: boolean;
  starter: boolean;
  category: string;
  schedule: string | null;
  trigger: string;
  tags: string[];
  nodeCount: number;
  edgeCount: number;
  branchCount: number;
  approvalCount: number;
  toolCount: number;
  nodeTypes: string[];
  runCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  updatedAt: string | null;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  status: string;
  nodeRuns: Array<{
    nodeId: string;
    status: string;
    message: string;
    output?: Record<string, unknown>;
  }>;
  events?: Array<{ id: string; type: string; status: string | null; message: string; nodeId: string | null }>;
}

interface ConnectionTemplate {
  id: string;
  label: string;
  fields: string[];
  notes: string;
  configuredFields: string[];
}

interface ExecutionGate {
  enabled: boolean;
  source: string;
  publicSummary: string;
}

interface AgentDefinition {
  id: AgentId;
  name: string;
  shortName: string;
  eyebrow: string;
  description: string;
  accent: string;
  hero: boolean;
  icon: typeof Bot;
}

const AGENTS: AgentDefinition[] = [
  {
    id: "openclaw",
    name: "OpenClaw",
    shortName: "OpenClaw",
    eyebrow: "AUTOMATION ENGINE",
    description: "Give an agent a goal and let it operate tools, browsers, and repeatable workflows.",
    accent: "orange",
    hero: true,
    icon: Bot
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    shortName: "Hermes",
    eyebrow: "AGENT RUNTIME",
    description: "A powerful local agent for research, tools, memory, and long-running work.",
    accent: "violet",
    hero: true,
    icon: Sparkles
  }
];

const TEMPLATES = [
  "Every morning, research trending AI reels and ask me to approve five content ideas.",
  "Monitor three competitor Instagram pages and summarize their best performing hooks.",
  "Research qualified leads, score them, and prepare a short outreach brief for approval.",
  "Turn one long video into a reel script, caption, carousel outline, and posting checklist."
];

const PALETTE = [
  { type: "agent", label: "Agent", description: "Think, research, or create", icon: Sparkles },
  { type: "if_else", label: "Condition", description: "Choose what happens next", icon: GitBranch },
  { type: "while_loop", label: "Bounded loop", description: "Repeat with a hard limit", icon: Repeat2 },
  { type: "mcp_tool", label: "Tool", description: "Call a connected capability", icon: Wrench },
  { type: "user_approval", label: "Ask me", description: "Pause for your approval", icon: UserCheck },
  { type: "transform", label: "Prepare data", description: "Format information", icon: Zap },
  { type: "end", label: "Finish", description: "Complete the workflow", icon: Flag }
];

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body as T;
}

function statusLabel(status = "") {
  if (status === "connected") return "Ready";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "waiting_for_approval") return "Waiting for you";
  if (status === "ready_to_configure") return "Connect";
  if (status === "missing_dependency") return "Install";
  return status.replace(/_/g, " ") || "Checking";
}

function finalNodeStatuses(run: WorkflowRun | null) {
  const statuses = new Map<string, string>();
  for (const nodeRun of run?.nodeRuns || []) statuses.set(nodeRun.nodeId, nodeRun.status);
  return statuses;
}

function nodePosition(node: WorkflowNode, index: number) {
  return node.position || { x: 70 + index * 250, y: 235 + (index % 2) * 115 };
}

function triggerLabel(trigger = "manual") {
  if (trigger === "schedule") return "Scheduled";
  if (trigger === "webhook") return "Webhook";
  return "Manual";
}

function WorkflowMiniGraph({ types }: { types: string[] }) {
  const visible = types.slice(0, 11);
  return (
    <div className="aos-mini-graph" aria-label={`${types.length} workflow nodes`}>
      {visible.map((type, index) => <span key={`${type}-${index}`} className={`type-${type}`} title={type.replace(/_/g, " ")} />)}
      {types.length > visible.length ? <i>+{types.length - visible.length}</i> : null}
    </div>
  );
}

function GraphOverview({ workflow, selectedNodeId }: { workflow: AgentWorkflow; selectedNodeId: string }) {
  const width = 248;
  const height = 108;
  const positioned = workflow.nodes.map((item, index) => ({ item, position: nodePosition(item, index) }));
  const minX = Math.min(...positioned.map(({ position }) => position.x));
  const minY = Math.min(...positioned.map(({ position }) => position.y));
  const maxX = Math.max(...positioned.map(({ position }) => position.x + 215));
  const maxY = Math.max(...positioned.map(({ position }) => position.y + 100));
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const scale = Math.min((width - 16) / graphWidth, (height - 16) / graphHeight);
  const offsetX = (width - graphWidth * scale) / 2;
  const offsetY = (height - graphHeight * scale) / 2;
  const points = new Map(positioned.map(({ item, position }) => [item.id, {
    x: offsetX + (position.x - minX) * scale,
    y: offsetY + (position.y - minY) * scale,
    width: Math.max(8, 215 * scale),
    height: Math.max(5, 100 * scale),
    type: item.type
  }]));
  return (
    <aside className="aos-graph-overview">
      <div><span>FULL GRAPH</span><strong>{workflow.nodes.length} nodes · {workflow.edges.length} links</strong></div>
      <svg viewBox={`0 0 ${width} ${height}`} aria-label="Full workflow topology">
        {workflow.edges.map((workflowEdge) => {
          const source = points.get(workflowEdge.source);
          const target = points.get(workflowEdge.target);
          if (!source || !target) return null;
          return <line key={workflowEdge.id} x1={source.x + source.width} y1={source.y + source.height / 2} x2={target.x} y2={target.y + target.height / 2} />;
        })}
        {positioned.map(({ item }) => {
          const point = points.get(item.id)!;
          return <rect key={item.id} className={`type-${item.type} ${selectedNodeId === item.id ? "selected" : ""}`} x={point.x} y={point.y} width={point.width} height={point.height} rx={Math.min(3, point.height / 2)} />;
        })}
      </svg>
      <p>Scroll the canvas for readable node details.</p>
    </aside>
  );
}

function AppLogo() {
  return (
    <div className="aos-logo" aria-label="Agent OS">
      <div className="aos-logo-mark"><CircleDot size={22} /></div>
      <div><strong>Agent OS</strong><span>Local agent studio</span></div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`aos-status aos-status-${status}`}>{statusLabel(status)}</span>;
}

function Sidebar({ page, onNavigate, open, onClose, codexConfigured, presentationMode }: { page: Page; onNavigate: (page: Page) => void; open: boolean; onClose: () => void; codexConfigured: boolean; presentationMode: boolean }) {
  return (
    <aside className={`aos-sidebar ${open ? "is-open" : ""}`}>
      <div className="aos-sidebar-top">
        <AppLogo />
        <button className="aos-icon-button aos-mobile-close" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
      </div>
      <nav>
        <button className={page === "home" ? "active" : ""} onClick={() => onNavigate("home")}>
          <Home size={19} /><span>Home</span>
        </button>
        <button className={page === "builder" ? "active" : ""} onClick={() => onNavigate("builder")}>
          <WorkflowIcon size={19} /><span>Agent Builder</span>
        </button>
        <button className={page === "apis" ? "active" : ""} onClick={() => onNavigate("apis")}>
          <Database size={19} /><span>AI APIs</span>
        </button>
        <p>Agent orchestration</p>
        {AGENTS.map((agent) => {
          const Icon = agent.icon;
          return (
            <button key={agent.id} className={page === agent.id ? "active" : ""} onClick={() => onNavigate(agent.id)}>
              <Icon size={19} /><span>{agent.shortName}</span>{agent.hero ? <i>Hero</i> : null}
            </button>
          );
        })}
      </nav>
      <div className="aos-sidebar-foot">
        <span><span className={`aos-live-dot ${codexConfigured ? "" : "missing"}`} /> {codexConfigured ? "Codex API ready" : "Connect Codex API"}</span>
        <small>{presentationMode ? "Presentation mode · live calls protected" : "Keys stay server-side"}</small>
      </div>
    </aside>
  );
}

function Topbar({ title, onMenu, codexLive, presentationMode }: { title: string; onMenu: () => void; codexLive: boolean; presentationMode: boolean }) {
  return (
    <header className="aos-topbar">
      <button className="aos-icon-button aos-menu-button" onClick={onMenu}><Menu size={20} /></button>
      <div><span>AGENT OS</span><strong>{title}</strong></div>
      <div className={`aos-powered ${codexLive ? "live" : "setup"}`}>{codexLive ? <CheckCircle2 size={16} /> : <CircleDot size={16} />} {codexLive ? "Codex API ready" : "Connect Codex API"}{presentationMode ? <i>Presentation</i> : null}</div>
    </header>
  );
}

function localAgentIcon(id: string) {
  if (id === "cursor") return Terminal;
  if (id === "claude") return Bot;
  if (id === "codex") return Sparkles;
  return CircleDot;
}

function MissionControlPanel({ localAgents, modules, codexLive, onRefresh, onOpenApis }: { localAgents: LocalAgentStatus[]; modules: RuntimeModule[]; codexLive: boolean; onRefresh: () => void; onOpenApis: () => void }) {
  const moduleReady = modules.filter((module) => module.status === "connected").length;
  const connected = localAgents.filter((agent) => agent.status === "connected").length;
  const visibleAgents = localAgents.length ? localAgents : [
    { id: "cursor", name: "Cursor Agent", eyebrow: "IDE CODING AGENT", status: "checking", available: false, summary: "Checking local Cursor Agent CLI…" },
    { id: "claude", name: "Claude Code", eyebrow: "ANTHROPIC CODING AGENT", status: "checking", available: false, summary: "Checking local Claude Code CLI…" },
    { id: "codex", name: "Codex", eyebrow: "GOAL + WORKFLOW BRAIN", status: codexLive ? "connected" : "checking", available: codexLive, summary: "Checking Agent OS Codex route…" },
    { id: "hermes", name: "Hermes Agent", eyebrow: "LOCAL TOOL + MEMORY AGENT", status: "checking", available: false, summary: "Checking Hermes CLI and profile…" }
  ];

  return (
    <section className="aos-section aos-mission-section">
      <div className="aos-mission-shell">
        <div className="aos-mission-head">
          <div>
            <span>MISSION CONTROL · ONE DASHBOARD</span>
            <h2>Cursor, Claude, Codex, and Hermes are wired into your Agent OS.</h2>
            <p>Live local checks from the Agent OS server. Secrets stay server-side; this only shows readiness, model route, and connection path.</p>
          </div>
          <div className="aos-mission-score">
            <strong>{connected || (codexLive ? 1 : 0)}/{visibleAgents.length}</strong>
            <span>agents ready</span>
            <button className="aos-text-button" onClick={onRefresh}><RefreshCcw size={15} /> Refresh</button>
          </div>
        </div>

        <div className="aos-mission-grid">
          {visibleAgents.map((agent) => {
            const Icon = localAgentIcon(agent.id);
            return (
              <article className={`aos-local-agent-card agent-${agent.id} ${agent.status}`} key={agent.id}>
                <div className="aos-local-agent-top">
                  <span>{agent.eyebrow}</span>
                  <StatusPill status={agent.status || "checking"} />
                </div>
                <div className="aos-local-agent-main">
                  <div className="aos-local-agent-icon"><Icon size={23} /></div>
                  <div><h3>{agent.name}</h3><p>{agent.summary}</p></div>
                </div>
                <dl className="aos-local-agent-details">
                  <div><dt>Version</dt><dd>{agent.version || "Checking"}</dd></div>
                  <div><dt>Model route</dt><dd>{agent.model || "Local default"}</dd></div>
                  <div><dt>Connection</dt><dd>{agent.connection || "Local CLI/API"}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>

        <div className="aos-mission-footer">
          <span><CheckCircle2 size={16} /> Codex API: {codexLive ? "connected to the local OpenAI-compatible gateway" : "needs setup"}</span>
          <span><WorkflowIcon size={16} /> Agent OS modules ready: {moduleReady}/{modules.length || 2}</span>
          <button className="aos-secondary" onClick={onOpenApis}><Settings2 size={16} /> API settings</button>
        </div>
      </div>
    </section>
  );
}

function HomePage({
  modules,
  localAgents,
  workflows,
  busy,
  onGenerate,
  onOpenAgent,
  onOpenWorkflow,
  onRefresh,
  codexLive,
  presentationMode,
  onOpenApis,
  onOpenBlankWorkflow
}: {
  modules: RuntimeModule[];
  localAgents: LocalAgentStatus[];
  workflows: WorkflowSummary[];
  busy: boolean;
  onGenerate: (prompt: string) => void;
  onOpenAgent: (id: AgentId) => void;
  onOpenWorkflow: (id: string) => void;
  onRefresh: () => void;
  codexLive: boolean;
  presentationMode: boolean;
  onOpenApis: () => void;
  onOpenBlankWorkflow: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const moduleById = useMemo(() => new Map(modules.map((module) => [module.id, module])), [modules]);
  const visibleWorkflows = useMemo(() => workflows.filter((workflow) => workflow.id !== "blank-open-agent-builder"), [workflows]);
  const workflowMetrics = useMemo(() => ({
    nodes: visibleWorkflows.reduce((total, workflow) => total + workflow.nodeCount, 0),
    automated: visibleWorkflows.filter((workflow) => workflow.trigger !== "manual").length,
    approvals: visibleWorkflows.reduce((total, workflow) => total + workflow.approvalCount, 0)
  }), [visibleWorkflows]);
  function submit() {
    if (prompt.trim() && !busy) onGenerate(prompt.trim());
  }
  return (
    <main className="aos-page aos-home">
      <section className="aos-hero">
        <div className="aos-hero-orb aos-hero-orb-one" />
        <div className="aos-hero-orb aos-hero-orb-two" />
        <div className="aos-hero-copy">
          <span className="aos-kicker"><Sparkles size={15} /> BUILD WITH OPENCLAW + HERMES</span>
          <h1>Describe it.<br /><em>See it. Run it.</em></h1>
          <p>Build a working AI agent with a prompt, understand every step visually, and test it before you switch it on.</p>
        </div>
        <div className="aos-prompt-card">
          <div className="aos-prompt-label"><WandSparkles size={18} /><span>What do you want your agent to do?</span></div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
            }}
            placeholder="Example: Every morning, research trending AI reels, prepare five ideas, and ask me to approve them."
          />
          <div className="aos-prompt-actions">
            <span>⌘ + Enter to build</span>
            <button className="aos-primary" disabled={!prompt.trim() || busy || !codexLive} onClick={submit}>
              {busy ? <Loader2 className="aos-spin" size={18} /> : <Sparkles size={18} />}
              {busy ? "Codex is building…" : codexLive ? "Build my agent" : "Connect API first"}
            </button>
          </div>
        </div>
        <div className="aos-template-row">
          {TEMPLATES.map((template, index) => (
            <button key={template} onClick={() => setPrompt(template)}><span>0{index + 1}</span>{template}</button>
          ))}
        </div>
        {!codexLive ? <div className="aos-enable-codex"><ShieldCheck size={20} /><div><strong>Connect Codex API to power Agent OS</strong><span>Add your OpenAI API key once; it stays on the local server and powers workflow generation, edits, and previews.</span></div><button className="aos-primary" onClick={onOpenApis}><PlugZap size={16} /> Connect API</button></div> : <div className="aos-enable-codex is-ready"><CheckCircle2 size={20} /><div><strong>Codex API is connected</strong><span>{presentationMode ? "Presentation mode uses your real saved workflow library; add a key when you want live Codex calls." : "Prompt-to-workflow and safe previews are ready. Choose Hermes or OpenClaw as the runtime in the builder."}</span></div><button className="aos-secondary" onClick={onOpenApis}><Settings2 size={16} /> API settings</button></div>}
      </section>

      <MissionControlPanel localAgents={localAgents} modules={modules} codexLive={codexLive} onRefresh={onRefresh} onOpenApis={onOpenApis} />

      <section className="aos-section aos-workflow-section">
        <div className="aos-section-head">
          <div><span>WORKFLOW OPERATIONS</span><h2>Your day-to-day agent systems</h2><p>Saved graphs with real routes, approvals, retry policies, loops, tool calls, and runtime ownership.</p></div>
          <button className="aos-secondary" onClick={onOpenBlankWorkflow}>
            <Plus size={17} /> Open blank builder
          </button>
        </div>
        {visibleWorkflows.length ? <>
          <div className="aos-ops-strip">
            <div><WorkflowIcon size={18} /><span><strong>{visibleWorkflows.length}</strong><small>saved workflows</small></span></div>
            <div><Layers3 size={18} /><span><strong>{workflowMetrics.nodes}</strong><small>configured nodes</small></span></div>
            <div><Clock3 size={18} /><span><strong>{workflowMetrics.automated}</strong><small>automatic triggers</small></span></div>
            <div><UserCheck size={18} /><span><strong>{workflowMetrics.approvals}</strong><small>human checkpoints</small></span></div>
          </div>
          <div className="aos-workflow-grid">
            {visibleWorkflows.map((workflow) => {
              const runtime = moduleById.get(workflow.runtime);
              const runtimeReady = runtime?.status === "connected";
              const TriggerIcon = workflow.trigger === "schedule" ? Clock3 : workflow.trigger === "webhook" ? Webhook : Play;
              const state = workflow.lastRunStatus
                ? statusLabel(workflow.lastRunStatus)
                : workflow.draft
                  ? "Draft"
                  : runtimeReady
                    ? "Native ready"
                    : `Connect ${workflow.runtime === "openclaw" ? "OpenClaw" : "Hermes"}`;
              return (
                <button className="aos-workflow-card" key={workflow.id} onClick={() => onOpenWorkflow(workflow.id)}>
                  <span className="aos-workflow-card-head">
                    <span className="aos-workflow-icon"><WorkflowIcon size={20} /></span>
                    <span><small>{workflow.category}</small><em className={`runtime-${workflow.runtime}`}>{workflow.runtime}</em></span>
                  </span>
                  <strong>{workflow.name}</strong>
                  <p>{workflow.description || `${workflow.nodeCount} visual steps`}</p>
                  <WorkflowMiniGraph types={workflow.nodeTypes} />
                  <span className="aos-workflow-meta">
                    <span title={workflow.schedule || triggerLabel(workflow.trigger)}><TriggerIcon size={13} /> {workflow.schedule || triggerLabel(workflow.trigger)}</span>
                    <span><Layers3 size={13} /> {workflow.nodeCount} nodes</span>
                    <span><Route size={13} /> {workflow.branchCount} routes</span>
                    <span><UserCheck size={13} /> {workflow.approvalCount} approvals</span>
                  </span>
                  <span className="aos-workflow-card-foot">
                    <span className={`aos-workflow-state ${workflow.lastRunStatus || (runtimeReady ? "ready" : "setup")}`}><i /> {state}</span>
                    <span>{workflow.runCount ? `${workflow.runCount} recorded run${workflow.runCount === 1 ? "" : "s"}` : "Open graph"} <ChevronRight size={15} /></span>
                  </span>
                </button>
              );
            })}
          </div>
        </> : <div className="aos-empty"><WorkflowIcon size={28} /><strong>No agents built yet</strong><p>Start with a blank canvas, add steps manually, or connect Codex API and describe the workflow you want.</p><button className="aos-primary" onClick={onOpenBlankWorkflow}><Plus size={17} /> Open blank builder</button></div>}
      </section>

      <section className="aos-section aos-runtime-section">
        <div className="aos-section-head">
          <div><span>YOUR RUNTIMES</span><h2>Choose how your agent works</h2></div>
          <button className="aos-text-button" onClick={onRefresh}><RefreshCcw size={16} /> Refresh status</button>
        </div>
        <div className="aos-agent-grid aos-agent-grid-hero">
          {AGENTS.filter((agent) => agent.hero).map((agent) => {
            const module = moduleById.get(agent.id);
            const Icon = agent.icon;
            return (
              <button className={`aos-agent-card aos-agent-${agent.accent}`} key={agent.id} onClick={() => onOpenAgent(agent.id)}>
                <div className="aos-agent-card-top"><span>{agent.eyebrow}</span><StatusPill status={module?.status || "checking"} /></div>
                <div className="aos-agent-icon"><Icon size={30} /></div>
                <h3>{agent.name}</h3>
                <p>{agent.description}</p>
                <div className="aos-card-link">Open control room <ChevronRight size={17} /></div>
              </button>
            );
          })}
        </div>
        <div className="aos-agent-grid aos-agent-grid-secondary">
          {AGENTS.filter((agent) => !agent.hero).map((agent) => {
            const module = moduleById.get(agent.id);
            const Icon = agent.icon;
            return (
              <button className={`aos-agent-card aos-agent-${agent.accent}`} key={agent.id} onClick={() => onOpenAgent(agent.id)}>
                <div className="aos-agent-icon small"><Icon size={24} /></div>
                <div><span>{agent.eyebrow}</span><h3>{agent.name}</h3><p>{agent.description}</p></div>
                <StatusPill status={module?.status || "checking"} />
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function AgentPage({
  agent,
  module,
  connection,
  codexConfigured,
  codexOperational,
  presentationMode,
  onBack,
  onChanged,
  onBuild,
  onOpenApis
}: {
  agent: AgentDefinition;
  module?: RuntimeModule;
  connection?: ConnectionTemplate;
  codexConfigured: boolean;
  codexOperational: boolean;
  presentationMode: boolean;
  onBack: () => void;
  onChanged: () => void;
  onBuild: (prompt: string) => void;
  onOpenApis: () => void;
}) {
  const Icon = agent.icon;
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState<"run" | "test" | "install" | "save" | "">("");
  const [fields, setFields] = useState<Record<string, string>>({});

  async function test() {
    setBusy("test");
    try {
      const response = await api<{ message: string }>(`/api/modules/${agent.id}/test`, { method: "POST", body: "{}" });
      setResult(response.message);
      onChanged();
    } catch (error) { setResult(error instanceof Error ? error.message : "Test failed"); }
    finally { setBusy(""); }
  }

  async function install() {
    setBusy("install");
    try {
      const response = await api<{ message: string; command?: string }>(`/api/modules/${agent.id}/install`, { method: "POST", body: JSON.stringify({ execute: true }) });
      setResult(response.message || response.command || "Install prepared.");
      onChanged();
    } catch (error) { setResult(error instanceof Error ? error.message : "Install failed"); }
    finally { setBusy(""); }
  }

  async function saveConnection() {
    if (!connection) return;
    setBusy("save");
    try {
      const response = await api<{ configuredFields: string[] }>(`/api/connections/${connection.id}/configure`, {
        method: "POST",
        body: JSON.stringify({ fields })
      });
      setResult(`Saved ${response.configuredFields.length} local connection field${response.configuredFields.length === 1 ? "" : "s"}.`);
      setFields({});
      onChanged();
    } catch (error) { setResult(error instanceof Error ? error.message : "Connection failed"); }
    finally { setBusy(""); }
  }

  async function runPreview() {
    if (!message.trim()) return;
    if (presentationMode && !codexOperational) {
      setResult("Presentation mode is showing the connected experience. Add your OpenAI API key for a live Codex response.");
      return;
    }
    setBusy("run");
    setResult("");
    try {
      const runtime = agent.id === "openclaw" ? "openclaw" : "hermes";
      const response = await api<{ ok: boolean; reply: string; mode: string }>("/api/agent-os/codex/preview", {
        method: "POST",
        body: JSON.stringify({ message, runtime })
      });
      setResult(response.reply || `Codex API finished in ${response.mode} mode.`);
    } catch (error) { setResult(error instanceof Error ? error.message : "Codex run failed"); }
    finally { setBusy(""); }
  }

  return (
    <main className={`aos-page aos-agent-page aos-agent-${agent.accent}`}>
      <button className="aos-back" onClick={onBack}><ArrowLeft size={17} /> Back home</button>
      <section className="aos-agent-hero">
        <div className="aos-agent-icon jumbo"><Icon size={42} /></div>
        <div className="aos-agent-title"><span>{agent.eyebrow}</span><h1>{agent.name}</h1><p>{agent.description}</p></div>
        <div className="aos-agent-health"><StatusPill status={module?.status || "checking"} /><small>{module?.version || "Checking local runtime"}</small></div>
      </section>
      <div className="aos-preview-banner"><Sparkles size={18} /><div><strong>Safe preview: powered by Codex API</strong><span>Codex shows what {agent.shortName} would do without running native tools. Turn it into a workflow when the result looks right.</span></div></div>
      <div className="aos-agent-columns">
        <section className="aos-panel aos-run-panel">
          <div className="aos-panel-head"><div><span>TRY IT NOW</span><h2>Give {agent.shortName} a task</h2></div><Terminal size={22} /></div>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Ask ${agent.shortName} to research, plan, build, or explain something…`} />
          <div className="aos-inline-actions">
            <button className="aos-primary" disabled={codexConfigured ? !message.trim() || Boolean(busy) : false} onClick={codexConfigured ? runPreview : onOpenApis}>
              {busy === "run" ? <Loader2 className="aos-spin" size={17} /> : codexConfigured ? <Play size={17} /> : <PlugZap size={17} />} {codexConfigured ? "Preview with Codex" : "Connect Codex API"}
            </button>
            <button className="aos-secondary" disabled={!message.trim() || !codexConfigured} onClick={() => onBuild(message)}><WorkflowIcon size={17} /> Turn into workflow</button>
          </div>
          {result ? <pre className="aos-terminal-output">{result}</pre> : <div className="aos-terminal-placeholder"><Activity size={22} /><span>The live response will appear here.</span></div>}
        </section>

        <aside className="aos-agent-side">
          <section className="aos-panel">
            <div className="aos-panel-head"><div><span>LOCAL RUNTIME</span><h2>Installation</h2></div><ShieldCheck size={21} /></div>
            <dl className="aos-detail-list">
              <div><dt>Status</dt><dd>{statusLabel(module?.status)}</dd></div>
              <div><dt>Configured</dt><dd>{module?.configured ? "Yes" : "Not yet"}</dd></div>
              <div><dt>Missing</dt><dd>{module?.missing?.join(", ") || "Nothing"}</dd></div>
            </dl>
            {module?.publicSummary ? <p className="aos-panel-copy aos-install-summary">{module.publicSummary}</p> : null}
            {!module?.configured && module?.installCommand ? <code className="aos-install-command">{module.installCommand}</code> : null}
            <div className="aos-inline-actions">
              <button className="aos-secondary" disabled={Boolean(busy)} onClick={test}>{busy === "test" ? <Loader2 className="aos-spin" size={16} /> : <TestTube2 size={16} />} Test</button>
              {!module?.configured ? <button className="aos-secondary" disabled={Boolean(busy)} onClick={install}>{busy === "install" ? <Loader2 className="aos-spin" size={16} /> : <Plus size={16} />} Install</button> : null}
              {module?.docsUrl ? <a className="aos-doc-link" href={module.docsUrl} target="_blank" rel="noreferrer">Official guide <ChevronRight size={14} /></a> : null}
            </div>
          </section>

          <section className="aos-panel">
            <div className="aos-panel-head"><div><span>CONNECTIONS</span><h2>Models and API</h2></div><Settings2 size={21} /></div>
            <p className="aos-panel-copy">{connection?.notes || "This agent uses its local account connection."}</p>
            {connection?.fields.map((field) => (
              <label className="aos-field" key={field}>
                <span>{field.replace(/_/g, " ")}{connection.configuredFields.includes(field) ? <i><Check size={12} /> Saved</i> : null}</span>
                <input
                  type={/KEY|TOKEN|SECRET|PASSWORD/.test(field) ? "password" : "text"}
                  value={fields[field] || ""}
                  onChange={(event) => setFields((current) => ({ ...current, [field]: event.target.value }))}
                  placeholder={connection.configuredFields.includes(field) ? "Already configured — enter to replace" : `Enter ${field}`}
                />
              </label>
            ))}
            {connection?.fields.length ? <button className="aos-secondary aos-wide" disabled={!Object.values(fields).some((value) => value.trim()) || Boolean(busy)} onClick={saveConnection}>{busy === "save" ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save connection</button> : null}
          </section>
        </aside>
      </div>
    </main>
  );
}

function BuilderPage({
  workflow,
  run,
  busy,
  notice,
  nativeEnabled,
  codexConfigured,
  onBack,
  onChange,
  onSave,
  onRun,
  onApprove,
  onRefine,
  onDelete,
  onDuplicate,
  onOpenApis
}: {
  workflow: AgentWorkflow;
  run: WorkflowRun | null;
  busy: string;
  notice: string;
  nativeEnabled: boolean;
  codexConfigured: boolean;
  onBack: () => void;
  onChange: (workflow: AgentWorkflow) => void;
  onSave: () => void;
  onRun: (mode: "preview" | "native") => void;
  onApprove: () => void;
  onRefine: (instruction: string, selectedNodeId: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onOpenApis: () => void;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState(workflow.nodes.find((node) => node.type === "agent")?.id || workflow.nodes[0]?.id || "");
  const [instruction, setInstruction] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(true);
  const statuses = useMemo(() => finalNodeStatuses(run), [run]);
  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId) || null;
  const nodeMap = useMemo(() => new Map(workflow.nodes.map((node, index) => [node.id, { node, position: nodePosition(node, index) }])), [workflow.nodes]);
  const canvasBounds = useMemo(() => {
    const positions = workflow.nodes.map((node, index) => nodePosition(node, index));
    return {
      minWidth: Math.max(1600, ...positions.map((position) => position.x + 330)),
      minHeight: Math.max(900, ...positions.map((position) => position.y + 220))
    };
  }, [workflow.nodes]);

  function updateNode(patch: Partial<WorkflowNode>) {
    onChange({ ...workflow, nodes: workflow.nodes.map((node) => node.id === selectedNodeId ? { ...node, ...patch } : node) });
  }

  function addNode(type: string, label: string) {
    const id = `${type}-${Date.now().toString(36)}`;
    const endIndex = workflow.nodes.findIndex((node) => node.type === "end");
    const insertAt = endIndex >= 0 ? endIndex : workflow.nodes.length;
    const anchor = selectedNode?.type === "end" ? workflow.nodes[Math.max(0, insertAt - 1)] : selectedNode;
    const anchorIndex = anchor ? workflow.nodes.findIndex((node) => node.id === anchor.id) : insertAt - 1;
    const anchorPosition = anchor ? nodePosition(anchor, Math.max(0, anchorIndex)) : { x: 80, y: 240 };
    const next: WorkflowNode = {
      id,
      type,
      label,
      position: { x: anchorPosition.x + 260, y: anchorPosition.y + (anchorIndex % 2 ? -120 : 120) },
      ...(type === "agent" ? { moduleId: "codex-api", maxRetries: 2, timeoutMs: 90000, prompt: "Describe what this agent should do." } : {}),
      ...(type === "if_else" ? { field: "result", operator: "equals", value: true, condition: "Describe the decision rule", defaultBranch: "false" } : {}),
      ...(type === "while_loop" ? { maxIterations: 3, condition: "Repeat with a hard limit" } : {}),
      ...(type === "mcp_tool" ? { moduleId: "memory", tool: "add" } : {})
    };
    const nodes = [...workflow.nodes];
    nodes.splice(insertAt, 0, next);
    let edges = [...workflow.edges];
    if (anchor) {
      const outgoing = edges.filter((edge) => edge.source === anchor.id);
      if (outgoing.length === 1) {
        const original = outgoing[0];
        edges = edges.filter((edge) => edge.id !== original.id);
        edges.push(
          { ...original, id: `edge-${anchor.id}-${id}`, target: id },
          { id: `edge-${id}-${original.target}`, source: id, target: original.target }
        );
      } else if (!outgoing.length) {
        edges.push({ id: `edge-${anchor.id}-${id}`, source: anchor.id, target: id });
      }
    }
    onChange({ ...workflow, nodes, edges });
    setSelectedNodeId(id);
  }

  function removeSelected() {
    if (!selectedNode || ["start", "end"].includes(selectedNode.type)) return;
    const nodes = workflow.nodes.filter((node) => node.id !== selectedNode.id);
    const incoming = workflow.edges.filter((edge) => edge.target === selectedNode.id);
    const outgoing = workflow.edges.filter((edge) => edge.source === selectedNode.id);
    const edges = workflow.edges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id);
    if (incoming.length === 1 && outgoing.length === 1 && incoming[0].source !== outgoing[0].target) {
      edges.push({ ...incoming[0], id: `edge-${incoming[0].source}-${outgoing[0].target}`, target: outgoing[0].target });
    }
    onChange({ ...workflow, nodes, edges });
    setSelectedNodeId(incoming[0]?.source || nodes[0]?.id || "");
  }

  function beginDrag(event: React.PointerEvent<HTMLButtonElement>, node: WorkflowNode, index: number) {
    if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    const original = nodePosition(node, index);
    const move = (moveEvent: PointerEvent) => {
      const position = { x: Math.max(20, original.x + moveEvent.clientX - start.x), y: Math.max(90, original.y + moveEvent.clientY - start.y) };
      onChange({
        ...workflow,
        nodes: workflow.nodes.map((item) => item.id === node.id ? { ...item, position } : item)
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <main className="aos-builder">
      <header className="aos-builder-header">
        <div className="aos-builder-left">
          <button className="aos-icon-button" onClick={onBack}><ArrowLeft size={19} /></button>
          <div className="aos-mini-logo"><CircleDot size={18} /><span>Agent OS</span></div>
          <span className="aos-divider" />
          <input value={workflow.name} onChange={(event) => onChange({ ...workflow, name: event.target.value })} />
          <button className={`aos-engine-badge ${codexConfigured ? "" : "missing"}`} onClick={onOpenApis}><Sparkles size={14} /> {codexConfigured ? "Codex API" : "Connect Codex API"}</button>
          <label className="aos-runtime-select"><span>RUN WITH</span><select value={workflow.runtime || "hermes"} onChange={(event) => onChange({ ...workflow, runtime: event.target.value as "hermes" | "openclaw" })}><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option></select></label>
        </div>
        <div className="aos-builder-actions">
          <button className="aos-icon-button" onClick={onDuplicate} title="Duplicate"><Copy size={17} /></button>
          <button className="aos-icon-button danger" onClick={onDelete} title="Delete"><Trash2 size={17} /></button>
          <button className="aos-secondary" disabled={Boolean(busy)} onClick={onSave}>{busy === "saving" ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save</button>
          {run?.status === "waiting_for_approval" ? <button className="aos-approve" disabled={Boolean(busy)} onClick={onApprove}>{busy === "approving" ? <Loader2 className="aos-spin" size={16} /> : <UserCheck size={16} />} Approve & continue</button> : null}
          <button className="aos-secondary" disabled={Boolean(busy) || !codexConfigured} onClick={() => onRun("preview")}>{busy === "running-preview" ? <Loader2 className="aos-spin" size={16} /> : <TestTube2 size={16} />} Codex preview</button>
          <button className="aos-primary" disabled={Boolean(busy)} onClick={() => onRun("native")}>{busy === "running-native" || busy === "enabling-native" ? <Loader2 className="aos-spin" size={16} /> : nativeEnabled ? <Play size={16} /> : <ShieldCheck size={16} />} {nativeEnabled ? "Run" : "Enable & run"} {workflow.runtime === "openclaw" ? "OpenClaw" : "Hermes"}</button>
        </div>
      </header>

      <div className="aos-builder-body">
        <aside className={`aos-palette ${paletteOpen ? "" : "collapsed"}`}>
          <button className="aos-palette-toggle" onClick={() => setPaletteOpen((value) => !value)}><Plus size={17} /><span>Add a step</span></button>
          {paletteOpen ? <>
            <p>DRAG & DROP STEPS</p>
            {PALETTE.map((item) => {
              const Icon = item.icon;
              return <button className="aos-palette-item" key={item.type} onClick={() => addNode(item.type, item.label)}><Icon size={18} /><span><strong>{item.label}</strong><small>{item.description}</small></span><Plus size={15} /></button>;
            })}
            <div className="aos-palette-tip"><Sparkles size={17} /><span>Prefer prompting? Tell Codex what to add below.</span></div>
          </> : null}
        </aside>

        <section className="aos-canvas-wrap">
          <div className="aos-canvas-grid" style={canvasBounds} />
          <div className="aos-canvas-status">
            <span className={`aos-run-light ${run?.status || "idle"}`} />
            {busy.startsWith("running") ? `${busy === "running-native" ? (workflow.runtime === "openclaw" ? "OpenClaw" : "Hermes") : "Codex API"} is executing this workflow…` : run ? `Last run: ${statusLabel(run.status)}` : "Ready to test"}
            <i />
            <span>{workflow.nodes.length} nodes · {workflow.edges.length} connections</span>
          </div>
          <GraphOverview workflow={workflow} selectedNodeId={selectedNodeId} />
          <svg className="aos-edge-layer" width="100%" height="100%" style={canvasBounds}>
            <defs><marker id="aos-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
            {workflow.edges.map((edge) => {
              const source = nodeMap.get(edge.source);
              const target = nodeMap.get(edge.target);
              if (!source || !target) return null;
              const x1 = source.position.x + 215;
              const y1 = source.position.y + 50;
              const x2 = target.position.x;
              const y2 = target.position.y + 50;
              const curve = Math.max(50, Math.abs(x2 - x1) / 2);
              const label = String(edge.label || edge.branch || edge.condition || "");
              return <g key={edge.id}>
                <path className={statuses.has(edge.target) ? "traversed" : ""} d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`} markerEnd="url(#aos-arrow)" />
                {label ? <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>{label}</text> : null}
              </g>;
            })}
          </svg>
          <div className="aos-node-layer" style={canvasBounds}>
            {workflow.nodes.map((node, index) => {
              const position = nodePosition(node, index);
              const status = statuses.get(node.id) || (busy.startsWith("running") ? "queued" : "idle");
              const palette = PALETTE.find((item) => item.type === node.type);
              const Icon = node.type === "start" ? CircleDot : palette?.icon || Sparkles;
              return (
                <button
                  key={node.id}
                  className={`aos-node ${selectedNodeId === node.id ? "selected" : ""} status-${status}`}
                  style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
                  onPointerDown={(event) => beginDrag(event, node, index)}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <span className="aos-node-grip"><GripVertical size={15} /></span>
                  <span className="aos-node-icon"><Icon size={20} /></span>
                  <span className="aos-node-copy"><small>{node.type.replace(/_/g, " ")}</small><strong>{node.label}</strong>{node.type === "agent" && node.maxRetries ? <em>{Number(node.maxRetries) + 1} attempts max</em> : node.type === "while_loop" ? <em>{Number(node.maxIterations || 0)} iterations max</em> : node.type === "mcp_tool" ? <em>{String(node.moduleId || "tool")}</em> : null}</span>
                  <span className="aos-node-state">{status === "completed" ? <CheckCircle2 size={16} /> : status === "failed" ? <XCircle size={16} /> : status === "queued" ? <Loader2 className="aos-spin" size={16} /> : <ChevronRight size={16} />}</span>
                </button>
              );
            })}
          </div>
          <div className="aos-canvas-footer">
            <div className="aos-refine-bar"><WandSparkles size={18} /><input value={instruction} disabled={!codexConfigured} onChange={(event) => setInstruction(event.target.value)} placeholder={!codexConfigured ? "Connect Codex API to build or edit by prompting…" : workflow.nodes.length <= 1 ? "Describe the complete workflow you want Codex to build…" : selectedNode ? `Tell Codex how to change “${selectedNode.label}”…` : "Tell Codex how to change this workflow…"} onKeyDown={(event) => { if (event.key === "Enter" && instruction.trim()) { onRefine(instruction, selectedNodeId); setInstruction(""); } }} /><button disabled={!instruction.trim() || Boolean(busy) || !codexConfigured} onClick={() => { onRefine(instruction, selectedNodeId); setInstruction(""); }}>{busy === "refining" ? <Loader2 className="aos-spin" size={17} /> : <Sparkles size={17} />} Apply</button></div>
            {notice ? <span className="aos-builder-notice">{notice}</span> : null}
          </div>
        </section>

        <aside className="aos-inspector">
          <div className="aos-inspector-head"><span>STEP SETTINGS</span>{selectedNode && !["start", "end"].includes(selectedNode.type) ? <button className="aos-icon-button danger" onClick={removeSelected}><Trash2 size={16} /></button> : null}</div>
          {selectedNode ? <>
            <div className="aos-selected-type"><span className="aos-node-icon"><Sparkles size={19} /></span><div><small>{selectedNode.type.replace(/_/g, " ")}</small><strong>{selectedNode.label}</strong></div></div>
            <label className="aos-field"><span>Step name</span><input value={selectedNode.label} onChange={(event) => updateNode({ label: event.target.value })} /></label>
            {selectedNode.type === "start" ? <>
              <label className="aos-field"><span>Trigger</span><select value={selectedNode.trigger || "manual"} onChange={(event) => updateNode({ trigger: event.target.value })}><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="webhook">Webhook</option></select></label>
              {selectedNode.trigger === "schedule" ? <label className="aos-field"><span>Cron schedule</span><input value={String(selectedNode.cron || "")} onChange={(event) => updateNode({ cron: event.target.value })} placeholder="0 9 * * 1" /></label> : null}
              {selectedNode.trigger === "webhook" ? <label className="aos-field"><span>Webhook endpoint</span><input value={String(selectedNode.endpoint || "")} onChange={(event) => updateNode({ endpoint: event.target.value })} placeholder="/hooks/workflow" /></label> : null}
            </> : null}
            {selectedNode.type === "agent" ? <>
              <label className="aos-field"><span>Intelligence</span><select value="codex-api" disabled><option value="codex-api">Codex API</option></select></label>
              <label className="aos-field"><span>Execution runtime</span><select value={workflow.runtime || "hermes"} disabled><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option></select></label>
              <label className="aos-field"><span>What should this agent do?</span><textarea value={selectedNode.prompt || ""} onChange={(event) => updateNode({ prompt: event.target.value, moduleId: "codex-api", dryRun: false, timeoutMs: 90000 })} /></label>
              <div className="aos-field-row"><label className="aos-field"><span>Retries</span><input type="number" min="0" max="5" value={Number(selectedNode.maxRetries || 0)} onChange={(event) => updateNode({ maxRetries: Number(event.target.value) })} /></label><label className="aos-field"><span>Timeout (ms)</span><input type="number" min="1000" max="300000" value={Number(selectedNode.timeoutMs || 90000)} onChange={(event) => updateNode({ timeoutMs: Number(event.target.value) })} /></label></div>
            </> : null}
            {selectedNode.type === "if_else" ? <>
              <label className="aos-field"><span>Decision rule</span><textarea value={String(selectedNode.condition || "")} onChange={(event) => updateNode({ condition: event.target.value })} placeholder="Describe the condition…" /></label>
              <div className="aos-field-row"><label className="aos-field"><span>Input field</span><input value={String(selectedNode.field || "")} onChange={(event) => updateNode({ field: event.target.value })} /></label><label className="aos-field"><span>Operator</span><select value={String(selectedNode.operator || "equals")} onChange={(event) => updateNode({ operator: event.target.value })}><option value="equals">Equals</option><option value="gte">≥</option><option value="lte">≤</option><option value="truthy">Truthy</option><option value="includes">Includes</option></select></label></div>
            </> : null}
            {selectedNode.type === "while_loop" ? <><label className="aos-field"><span>Loop rule</span><textarea value={String(selectedNode.condition || "")} onChange={(event) => updateNode({ condition: event.target.value })} /></label><label className="aos-field"><span>Maximum iterations</span><input type="number" min="0" max="25" value={Number(selectedNode.maxIterations || 0)} onChange={(event) => updateNode({ maxIterations: Number(event.target.value) })} /></label><div className="aos-info-box"><Repeat2 size={17} /><span>The runtime stops this loop at the configured hard limit, even if the task is unfinished.</span></div></> : null}
            {selectedNode.type === "mcp_tool" ? <><label className="aos-field"><span>Connected module</span><input value={String(selectedNode.moduleId || "")} onChange={(event) => updateNode({ moduleId: event.target.value })} /></label><label className="aos-field"><span>Tool or action</span><input value={String(selectedNode.tool || "")} onChange={(event) => updateNode({ tool: event.target.value })} /></label><div className="aos-info-box"><Wrench size={17} /><span>Tool execution uses the selected local Agent OS module and its own connection checks.</span></div></> : null}
            {selectedNode.type === "transform" ? <label className="aos-field"><span>Data mapping</span><textarea value={String(selectedNode.mapping || "")} onChange={(event) => updateNode({ mapping: event.target.value })} placeholder="Describe the input-to-output mapping…" /></label> : null}
            {selectedNode.type === "user_approval" ? <div className="aos-info-box"><UserCheck size={17} /><span>The run pauses here until you approve it.</span></div> : null}
            <div className="aos-node-connections"><span>GRAPH CONNECTIONS</span><strong>{workflow.edges.filter((edge) => edge.target === selectedNode.id).length} in · {workflow.edges.filter((edge) => edge.source === selectedNode.id).length} out</strong></div>
            {run ? <div className="aos-run-detail"><span>LAST RUN</span><strong>{statusLabel(statuses.get(selectedNode.id) || "not run")}</strong><p>{[...(run.nodeRuns || [])].reverse().find((item) => item.nodeId === selectedNode.id)?.message || "This step has not produced output yet."}</p></div> : null}
          </> : <div className="aos-empty small"><Settings2 size={24} /><p>Select a step to edit it.</p></div>}
        </aside>
      </div>
    </main>
  );
}

export default function AgentOSApp() {
  const [page, setPage] = useState<Page>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [modules, setModules] = useState<RuntimeModule[]>([]);
  const [localAgents, setLocalAgents] = useState<LocalAgentStatus[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionTemplate[]>([]);
  const [codex, setCodex] = useState<CodexApiStatus>({ configured: false, status: "setup_required", model: "gpt-5.3-codex", baseUrl: "https://api.openai.com/v1", reasoningEffort: "medium", timeoutMs: 90000, keySource: "missing", publicSummary: "Add an OpenAI API key to power Agent OS." });
  const [apiIntegrations, setApiIntegrations] = useState<ApiIntegration[]>([]);
  const [executionGate, setExecutionGate] = useState<ExecutionGate>({ enabled: false, source: "checking", publicSummary: "Native execution is disabled." });
  const [workflow, setWorkflow] = useState<AgentWorkflow | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const codexPresentation = Boolean(codex.presentationMode && !codex.configured);
  const codexDisplayReady = codex.configured || codexPresentation;

  async function refresh() {
    try {
      const [moduleData, localAgentData, workflowData, connectionData, codexData, integrationData, gateData] = await Promise.all([
        api<{ modules: RuntimeModule[] }>("/api/modules"),
        api<{ agents: LocalAgentStatus[] }>("/api/local-agents"),
        api<{ workflows: WorkflowSummary[] }>("/api/workflows"),
        api<{ templates: ConnectionTemplate[] }>("/api/connections"),
        api<CodexApiStatus>("/api/agent-os/codex/status"),
        api<{ integrations: ApiIntegration[] }>("/api/agent-os/api-integrations"),
        api<ExecutionGate>("/api/execution-gate")
      ]);
      setModules(moduleData.modules);
      setLocalAgents(localAgentData.agents || []);
      setWorkflows(workflowData.workflows);
      setConnections(connectionData.templates);
      setCodex(codexData);
      setApiIntegrations(integrationData.integrations);
      setExecutionGate(gateData);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Agent OS runtime is unavailable.");
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const workflowId = params.get("workflow");
    const requestedPage = params.get("page");
    if (workflowId) {
      void openWorkflow(workflowId);
      return;
    }
    if (requestedPage === "builder") {
      void openWorkflow("blank-open-agent-builder");
      return;
    }
    if (["home", "apis", "openclaw", "hermes"].includes(requestedPage || "")) {
      setPage(requestedPage as Page);
    }
  }, []);

  function navigate(next: Page) {
    if (next === "builder") {
      setMenuOpen(false);
      if (workflow) setPage("builder");
      else void openWorkflow(workflows.find((item) => item.id !== "blank-open-agent-builder")?.id || "blank-open-agent-builder");
      return;
    }
    setPage(next);
    setMenuOpen(false);
    setRun(null);
  }

  async function generate(prompt: string) {
    if (!codex.configured) {
      if (codexPresentation) {
        await openWorkflow("blank-open-agent-builder");
        setNotice("Presentation mode opened the blank builder. Add your API key for live prompt generation.");
        return;
      }
      setPage("apis");
      setError("Connect and test Codex API before building a workflow.");
      return;
    }
    setBusy("generating");
    setNotice("Codex API is turning your idea into a visual workflow…");
    try {
      const response = await api<{ workflow: AgentWorkflow; generationMode: string; message: string; warning?: string }>("/api/agent-os/workflows/generate", {
        method: "POST",
        body: JSON.stringify({ prompt, runtime: "hermes" })
      });
      setWorkflow(response.workflow);
      setRun(null);
      setNotice(response.generationMode === "codex-api" ? "Built and validated by Codex API." : `${response.message} ${response.warning || ""}`.trim());
      setPage("builder");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create workflow.");
    } finally { setBusy(""); }
  }

  async function openWorkflow(id: string) {
    setBusy("loading");
    try {
      const saved = await api<AgentWorkflow>(`/api/workflows/${id}`);
      setWorkflow(saved);
      setRun(null);
      setNotice("Workflow loaded.");
      setPage("builder");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Workflow could not be loaded."); }
    finally { setBusy(""); }
  }

  function prepareWorkflowForSave(current: AgentWorkflow) {
    if (current.id !== "blank-open-agent-builder") {
      return { workflow: current, create: false };
    }
    const editedName = current.name.trim();
    const hasUserWork = current.nodes.length > 1 || (editedName && editedName !== "Blank Agent OS Workflow");
    if (!hasUserWork) {
      return { workflow: current, create: false };
    }
    return {
      workflow: {
        ...current,
        id: `workflow-${Date.now().toString(36)}`,
        name: editedName && editedName !== "Blank Agent OS Workflow" ? editedName : "Untitled Workflow",
        description: current.description || "Created from the blank Agent OS builder.",
        draft: true,
        starter: false
      },
      create: true
    };
  }

  async function saveCurrent() {
    if (!workflow) return;
    setBusy("saving");
    try {
      const prepared = prepareWorkflowForSave(workflow);
      const saved = await api<AgentWorkflow>(prepared.create ? "/api/workflows" : `/api/workflows/${prepared.workflow.id}`, {
        method: prepared.create ? "POST" : "PUT",
        body: JSON.stringify(prepared.workflow)
      });
      setWorkflow(saved);
      setNotice(prepared.create ? "Created and saved locally." : "Saved locally.");
      await refresh();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Save failed."); }
    finally { setBusy(""); }
  }

  async function runCurrent(mode: "preview" | "native") {
    if (!workflow) return;
    if (mode === "preview" && codexPresentation) {
      setNotice("Presentation mode: this workflow is ready to preview. Add your API key to make the live Codex request.");
      return;
    }
    if (mode === "native" && !executionGate.enabled) {
      const runtime = workflow.runtime === "openclaw" ? "OpenClaw" : "Hermes";
      if (!window.confirm(`Enable trusted local execution and run this workflow with ${runtime}? Native tools may access the configured workspace and services.`)) return;
      setBusy("enabling-native");
      try {
        const next = await api<ExecutionGate>("/api/admin/execution-gate", {
          method: "POST",
          body: JSON.stringify({ enabled: true, reason: `Enabled from Agent OS native ${runtime} run` })
        });
        setExecutionGate(next);
      } catch (caught) {
        setNotice(caught instanceof Error ? caught.message : "Could not enable trusted native execution.");
        setBusy("");
        return;
      }
    }
    setBusy(mode === "native" ? "running-native" : "running-preview");
    setNotice(mode === "native" ? `${workflow.runtime === "openclaw" ? "OpenClaw" : "Hermes"} is executing the workflow…` : "Codex API is safely previewing the workflow…");
    setRun(null);
    try {
      const prepared = prepareWorkflowForSave(workflow);
      const saved = await api<AgentWorkflow>(prepared.create ? "/api/workflows" : `/api/workflows/${prepared.workflow.id}`, {
        method: prepared.create ? "POST" : "PUT",
        body: JSON.stringify(prepared.workflow)
      });
      setWorkflow(saved);
      const result = await api<WorkflowRun>(`/api/workflows/${saved.id}/run`, {
        method: "POST",
        body: JSON.stringify({ trigger: "agent-os-test", executionMode: mode })
      });
      setRun(result);
      setNotice(result.status === "completed" ? `${mode === "native" ? "Native" : "Preview"} run completed successfully.` : `${mode === "native" ? "Native" : "Preview"} run stopped: ${statusLabel(result.status)}.`);
      await refresh();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Run failed."); }
    finally { setBusy(""); }
  }

  async function approveCurrent() {
    if (!workflow || !run || run.status !== "waiting_for_approval") return;
    setBusy("approving");
    setNotice("Approval received. Continuing the workflow…");
    try {
      const result = await api<WorkflowRun>(`/api/workflows/${workflow.id}/runs/${run.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ approved: true })
      });
      setRun(result);
      setNotice(result.status === "completed" ? "Approved and completed successfully." : `Workflow continued: ${statusLabel(result.status)}.`);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Approval failed."); }
    finally { setBusy(""); }
  }

  async function refine(instruction: string, selectedNodeId: string) {
    if (!workflow || !instruction.trim()) return;
    if (codexPresentation) {
      setNotice("Presentation mode: visual editing is ready. Add your API key to apply prompt-based Codex changes.");
      return;
    }
    setBusy("refining");
    setNotice("Codex is updating the workflow…");
    try {
      const response = await api<{ ok: boolean; workflow: AgentWorkflow; message: string }>("/api/agent-os/workflows/refine", {
        method: "POST",
        body: JSON.stringify({ workflow, instruction, selectedNodeId, runtime: workflow.runtime || "hermes" })
      });
      if (!response.ok) throw new Error(response.message);
      setWorkflow(response.workflow);
      setRun(null);
      setNotice("Codex applied the requested change.");
      await refresh();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Codex could not update the workflow."); }
    finally { setBusy(""); }
  }

  async function deleteCurrent() {
    if (!workflow || workflow.id === "blank-open-agent-builder") return;
    if (!window.confirm(`Delete “${workflow.name}”?`)) return;
    setBusy("deleting");
    try {
      await api(`/api/workflows/${workflow.id}`, { method: "DELETE" });
      setWorkflow(null);
      setRun(null);
      setPage("home");
      await refresh();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Delete failed."); }
    finally { setBusy(""); }
  }

  async function duplicateCurrent() {
    if (!workflow) return;
    const copy = { ...workflow, id: `${workflow.id}-copy-${Date.now().toString(36)}`, name: `${workflow.name} Copy` };
    setBusy("saving");
    try {
      const saved = await api<AgentWorkflow>("/api/workflows", { method: "POST", body: JSON.stringify(copy) });
      setWorkflow(saved);
      setRun(null);
      setNotice("Workflow duplicated.");
      await refresh();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Duplicate failed."); }
    finally { setBusy(""); }
  }

  const selectedAgent = AGENTS.find((agent) => agent.id === page);
  const title = page === "home" ? "Mission control" : page === "builder" ? "Visual builder" : page === "apis" ? "AI APIs" : selectedAgent?.name || "Agent OS";

  return (
    <div className="aos-root">
      {page !== "builder" ? <Sidebar page={page} onNavigate={navigate} open={menuOpen} onClose={() => setMenuOpen(false)} codexConfigured={codexDisplayReady} presentationMode={codexPresentation} /> : null}
      <section className={page === "builder" ? "aos-main aos-main-builder" : "aos-main"}>
        {page !== "builder" ? <Topbar title={title} onMenu={() => setMenuOpen(true)} codexLive={codexDisplayReady} presentationMode={codexPresentation} /> : null}
        {error ? <div className="aos-global-error"><XCircle size={18} /><span>{error}</span><button onClick={refresh}>Retry</button></div> : null}
        {page === "home" ? <HomePage modules={modules} localAgents={localAgents} workflows={workflows} busy={busy === "generating"} onGenerate={generate} onOpenAgent={navigate} onOpenWorkflow={openWorkflow} onRefresh={refresh} codexLive={codexDisplayReady} presentationMode={codexPresentation} onOpenApis={() => navigate("apis")} onOpenBlankWorkflow={() => openWorkflow("blank-open-agent-builder")} /> : null}
        {page === "apis" ? <ApiGuidePage codex={codex} integrations={apiIntegrations} onChanged={refresh} /> : null}
        {selectedAgent ? <AgentPage agent={selectedAgent} module={modules.find((module) => module.id === selectedAgent.id)} connection={connections.find((connection) => connection.id === selectedAgent.id)} codexConfigured={codexDisplayReady} codexOperational={codex.configured} presentationMode={codexPresentation} onBack={() => navigate("home")} onChanged={refresh} onBuild={generate} onOpenApis={() => navigate("apis")} /> : null}
        {page === "builder" && workflow ? <BuilderPage workflow={workflow} run={run} busy={busy} notice={notice} nativeEnabled={executionGate.enabled} codexConfigured={codexDisplayReady} onBack={() => navigate("home")} onChange={setWorkflow} onSave={saveCurrent} onRun={runCurrent} onApprove={approveCurrent} onRefine={refine} onDelete={deleteCurrent} onDuplicate={duplicateCurrent} onOpenApis={() => navigate("apis")} /> : null}
        {busy === "loading" ? <div className="aos-full-loader"><Loader2 className="aos-spin" size={32} /><span>Opening workflow…</span></div> : null}
      </section>
      {menuOpen ? <button className="aos-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
