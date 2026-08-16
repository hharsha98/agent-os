import {
  Activity,
  Bot,
  BrainCircuit,
  Cable,
  ChevronRight,
  CircleDot,
  Clock,
  Code2,
  Command,
  Cpu,
  DatabaseZap,
  FileCode2,
  Gauge,
  Gem,
  Globe2,
  KanbanSquare,
  LayoutDashboard,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  NotebookTabs,
  PlugZap,
  Play,
  Radio,
  RefreshCcw,
  Rocket,
  Search,
  ServerCog,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Workflow,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  adminLogin,
  addMemory,
  allowSkillPublisher,
  builderReplayOverlayUrl,
  blockSkillPublisher,
  configureProviderSetup,
  configureMemoryVector,
  configureSkill,
  configureUsageBudget,
  configureRouter,
  configureConnection,
  createSelfModuleItem,
  exportMemory,
  getAdminSession,
  getBuilderBootstrap,
  getBuilderReplayOverlay,
  getBuilderStatus,
  getBuilderLogs,
  getConnections,
  getExecutionGateStatus,
  getHealth,
  getIntegrations,
  getAgentOsReadiness,
  getAgentRuns,
  getKernelStatus,
  getOllamaDoctor,
  getMemoryState,
  getModuleLogs,
  getModuleRuns,
  getModuleSession,
  getModuleSessions,
  getOsAudit,
  getProviderModelInventory,
  getProviderSetupState,
  getRouterHealth,
  getRouterStatus,
  getSchedulerState,
  getSetupState,
  getSelfModule,
  getSkillRegistry,
  getSkillPublishers,
  getUsageState,
  getVoiceDesktopContext,
  getVoiceControlStatus,
  getWorkflowEvents,
  getWorkflowReplay,
  getWorkflows,
  approveSchedulerJob,
  importUsageBilling,
  importSkillBundle,
  importMemory,
  installModule,
  installSkill,
  messageModuleSession,
  previewUsageBillingImport,
  recordUsageEvent,
  rebuildMemoryVectorIndex,
  removeSkillPublisherAllow,
  removeSkillPublisherBlock,
  runProviderRouter,
  runModuleAction,
  runBuilderSmokeTest,
  runGoalLoop,
  runUsageReconciliation,
  runVoiceCommand,
  runSchedulerJob,
  runSchedulerTick,
  runWorkflow,
  pauseSchedulerJob,
  prepareBuilderBootstrap,
  prepareSkillDependencies,
  prepareProviderModel,
  rejectSchedulerJob,
  resumeSchedulerJob,
  resumeWorkflow,
  saveSchedulerJob,
  sendAgentMessage,
  searchMemory,
  saveSetupState,
  startFirstSetupWorkflow,
  startBuilder,
  startModuleSession,
  stopModuleSession,
  stopBuilder,
  disableSkill,
  enableSkill,
  fetchSkillMarketplaceFeed,
  getSkillMarketplace,
  importMarketplaceSkill,
  testProviderSetup,
  testSkill,
  saveSkillMarketplaceFeed,
  testIntegration,
  trustSkillPublisher,
  untrustSkillPublisher,
  uninstallSkill,
  updateExecutionGate,
  updateSkill,
  updateSkillPublisherPolicy,
  updateSkillPublisherReputation,
  updateMemory
} from "./api";
import type {
  AdminSession,
  BuilderBootstrap,
  BuilderReplayOverlay,
  BuilderStatus,
  BuilderLogs,
  BuilderSmokeTest,
  ConnectionTemplate,
  ExecutionGateStatus,
  GoalLoopResult,
  Health,
  AgentOsReadiness,
  AgentRuns,
  Integration,
  IntegrationSnapshot,
  KernelStatus,
  MemorySearchResult,
  MemoryState,
  ModuleLogs,
  ModuleRunResult,
  ModuleRuns,
  ModuleSession,
  ModuleSessions,
  OsAudit,
  ProviderLocalDoctor,
  ProviderHealthState,
  ProviderModelInventory,
  ProviderSetupState,
  ProviderRouterStatus,
  RouterProviderStatus,
  RuntimeModule,
  RouterRunResult,
  SchedulerJob,
  SchedulerState,
  SetupState,
  SelfModuleItem,
  SelfModuleState,
  SkillMarketplaceState,
  SkillDependencySuggestion,
  SkillPublisher,
  SkillPublishersState,
  SkillRegistryState,
  UsageBillingImportPreview,
  UsageState,
  VoiceCommandResult,
  VoiceControlStatus,
  VoiceDesktopContext,
  WorkflowEvents,
  WorkflowReplay,
  WorkflowRun,
  WorkflowSummary
} from "./types";

const workspaceItems = [
  { id: "mission", label: "Mission Control", icon: LayoutDashboard },
  { id: "voice-control", label: "Voice Control", icon: Mic },
  { id: "setup", label: "Setup", icon: ShieldCheck },
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "provider-router", label: "Provider Router", icon: Cable },
  { id: "scheduler", label: "Scheduler", icon: Clock },
  { id: "memory", label: "Memory", icon: DatabaseZap },
  { id: "skill-registry", label: "Skills", icon: PlugZap },
  { id: "agent-builder", label: "Agent Builder", icon: Workflow }
];
const agentItems = [
  { id: "claude", label: "Claude Code", icon: TerminalSquare },
  { id: "openclaw", label: "OpenClaw", icon: Bot },
  { id: "openclaude", label: "OpenClaude", icon: Sparkles },
  { id: "hermes", label: "Hermes", icon: BrainCircuit },
  { id: "gemini", label: "Gemini", icon: Gem },
  { id: "codex", label: "Codex", icon: Code2 },
  { id: "voice-control", label: "Voice Control", icon: Mic },
  { id: "opencode", label: "OpenCode", icon: FileCode2 }
];
const providerItems = [
  { id: "provider-openai", label: "OpenAI", icon: Sparkles },
  { id: "provider-ollama", label: "Ollama", icon: Cpu },
  { id: "provider-openrouter", label: "OpenRouter", icon: Cable },
  { id: "provider-anthropic", label: "Anthropic", icon: BrainCircuit },
  { id: "provider-gemini", label: "Gemini API", icon: Gem },
  { id: "provider-minimax", label: "MiniMax", icon: Cpu }
];
const selfItems = [
  { id: "goals", label: "Goals", icon: CircleDot },
  { id: "notebook", label: "Notebook", icon: NotebookTabs },
  { id: "kanban", label: "Kanban", icon: KanbanSquare },
  { id: "usage-credits", label: "Usage Credits", icon: Gauge }
];

const allNavItems = [...workspaceItems, ...agentItems, ...providerItems, ...selfItems];
const localSelfModuleIds = new Set(["goals", "notebook", "kanban", "usage-credits", "seo", "video"]);
const hiddenDashboardModuleIds = new Set(["kernel"]);
const modelProviderModuleIds = new Set(["minimax", "provider-anthropic", "provider-openai", "provider-gemini", "provider-openrouter", "provider-ollama", "provider-minimax"]);
const providerSetupByModuleId: Record<string, string> = {
  minimax: "minimax",
  "provider-ollama": "ollama",
  "provider-openrouter": "openrouter",
  "provider-minimax": "minimax",
  "provider-openai": "openai",
  "provider-anthropic": "anthropic",
  "provider-gemini": "gemini"
};

const iconMap: Record<string, typeof Activity> = {
  claude: TerminalSquare,
  openclaw: Bot,
  openclaude: Sparkles,
  hermes: BrainCircuit,
  gemini: Gem,
  codex: Code2,
  "voice-control": Mic,
  opencode: FileCode2,
  minimax: Cpu,
  gateway: Radio,
  "firecrawl-builder": Workflow,
  goals: CircleDot,
  notebook: NotebookTabs,
  kanban: KanbanSquare,
  "usage-credits": Gauge,
  "provider-router": Cable,
  kernel: ServerCog,
  workflows: Workflow,
  scheduler: Clock,
  memory: DatabaseZap,
  "skill-registry": PlugZap,
  "elizaos-runtime": ServerCog,
  "provider-anthropic": BrainCircuit,
  "provider-openai": Sparkles,
  "provider-gemini": Gem,
  "provider-openrouter": Cable,
  "provider-ollama": Cpu,
  "provider-minimax": Cpu,
  "provider-firecrawl": Globe2,
  "provider-convex": DatabaseZap,
  "provider-clerk": ShieldCheck
};

function statusLabel(status: string) {
  if (status === "ready_to_connect") return "Ready";
  if (status === "ready_to_configure") return "Configure";
  if (status === "config_required") return "Configure";
  if (status === "missing_dependency") return "Missing";
  if (status === "healthy") return "Healthy";
  if (status === "implemented") return "Implemented";
  if (status === "partial") return "Partial";
  if (status === "action_required") return "Action";
  if (status === "waiting_for_approval") return "Approval";
  return status;
}

function statusClass(status: string) {
  if (status === "connected" || status === "healthy" || status === "implemented" || status === "completed") return "is-online";
  if (status === "ready_to_connect" || status === "ready_to_configure" || status === "config_required" || status === "partial" || status === "running" || status === "waiting_for_approval") return "is-ready";
  return "is-muted";
}

function currentSectionLabel(selected: string) {
  if (selected === "plugins") return "Plugins & Connections";
  return allNavItems.find((item) => item.id === selected)?.label || "Mission Control";
}

function isLocalSelfModuleId(id: string) {
  return localSelfModuleIds.has(id);
}

function isDashboardHiddenModule(id: string) {
  return hiddenDashboardModuleIds.has(id);
}

function visibleIntegrations(integrations: Integration[]) {
  return integrations.filter((item) => !isDashboardHiddenModule(item.id));
}

function useRuntime() {
  const [snapshot, setSnapshot] = useState<IntegrationSnapshot | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setError(null);
      const [healthData, integrationData] = await Promise.all([getHealth(), getIntegrations()]);
      setHealth(healthData);
      setSnapshot(integrationData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load backend");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 20000);
    return () => window.clearInterval(timer);
  }, []);

  return { snapshot, health, error, loading, refresh };
}

function Sidebar({
  selected,
  onSelect
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">H</div>
        <div>
          <strong>Hermes Agent Hub</strong>
          <span>v1.0 backend wired</span>
        </div>
      </div>

      <NavGroup title="Workspace" items={workspaceItems} selected={selected} onSelect={onSelect} />
      <NavGroup title="Agent orchestration" items={agentItems} selected={selected} onSelect={onSelect} />
      <NavGroup title="Model Providers" items={providerItems} selected={selected} onSelect={onSelect} />
      <NavGroup title="Self" items={selfItems} selected={selected} onSelect={onSelect} />

      <div className="gateway-pill">
        <Radio size={15} />
        <span>Gateway</span>
        <b>API backed</b>
      </div>
    </aside>
  );
}

function NavGroup({
  title,
  items,
  selected,
  onSelect
}: {
  title: string;
  items: Array<{ id: string; label: string; icon: typeof Activity }>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="nav-group">
      <p>{title}</p>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className={selected === item.id ? "nav-item active" : "nav-item"}
            key={item.id}
            onClick={() => onSelect(item.id)}
          >
            <Icon size={17} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </section>
  );
}

function TopBar({
  sectionLabel,
  health,
  snapshot,
  loading,
  onRefresh
}: {
  sectionLabel: string;
  health: Health | null;
  snapshot: IntegrationSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="topbar">
      <div>
        <span>Workspace</span>
        <ChevronRight size={14} />
        <b>{sectionLabel}</b>
      </div>
      <div className="topbar-actions">
        <StatusPill label="MiniMax M3" active={Boolean(snapshot?.integrations.find((i) => i.id === "minimax" && i.status === "connected"))} />
        <StatusPill label="Hermes GW" active={Boolean(snapshot?.integrations.find((i) => i.id === "gateway" && i.status === "connected"))} />
        <StatusPill label={health?.mode || "backend"} active={Boolean(health?.ok)} />
        <button className="icon-button" onClick={onRefresh} aria-label="Refresh runtime">
          {loading ? <Loader2 className="spin" size={17} /> : <Activity size={17} />}
        </button>
      </div>
    </header>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return <span className={active ? "status-pill active" : "status-pill"}>{label}</span>;
}

function MissionControl({
  snapshot,
  error,
  onOpenAgent,
  onOpenPlugins,
  onOpenDrawer
}: {
  snapshot: IntegrationSnapshot | null;
  error: string | null;
  onOpenAgent: (id: string) => void;
  onOpenPlugins: () => void;
  onOpenDrawer: (integration: Integration) => void;
}) {
  const [kernel, setKernel] = useState<KernelStatus | null>(null);
  const [readiness, setReadiness] = useState<AgentOsReadiness | null>(null);
  const [agentRuns, setAgentRuns] = useState<AgentRuns | null>(null);
  const [kernelError, setKernelError] = useState<string | null>(null);
  const integrations = visibleIntegrations(snapshot?.integrations || []);
  const topCards = integrations.filter((item) =>
    ["claude", "openclaw", "openclaude", "hermes", "firecrawl-builder", "provider-router", "codex", "gateway", "elizaos-runtime"].includes(item.id)
  );
  const providers = integrations.filter((item) => item.category === "provider" && modelProviderModuleIds.has(item.id));
  const selfModules = integrations.filter((item) => item.category === "self");
  const setupItems = buildSetupChecklist(integrations);

  useEffect(() => {
    let canceled = false;
    Promise.all([getKernelStatus(), getAgentOsReadiness(), getAgentRuns(8)])
      .then(([data, readinessData, runData]) => {
        if (canceled) return;
        setKernel(data);
        setReadiness(readinessData);
        setAgentRuns(runData);
        setKernelError(null);
      })
      .catch((err) => {
        if (canceled) return;
        setKernel(null);
        setReadiness(null);
        setAgentRuns(null);
        setKernelError(err instanceof Error ? err.message : "Unable to load Agent OS loop");
      });
    return () => {
      canceled = true;
    };
  }, [snapshot?.generatedAt]);

  return (
    <main className="content">
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">
            <DatabaseZap size={16} />
            Self-hosted runtime
          </span>
          <h1>Hermes Mission Control</h1>
          <p>Local Agent OS dashboard for connecting CLIs, model providers, workflows, local memory, and usage tracking.</p>
          <div className="runtime-line">
            <b>LOCAL RUNTIME</b>
            <span>{snapshot?.osStatus?.runtimeFoundation || "Agent OS runtime"}</span>
            <span>{snapshot?.osStatus?.builderFoundation || "Firecrawl builder"}</span>
            <span>{snapshot?.osStatus?.moduleCount || integrations.length} modules</span>
          </div>
          {error ? <div className="error-banner">{error}</div> : null}
        </div>
        <div className="hero-actions">
          <button onClick={onOpenPlugins}>
            <Cable size={18} />
            Plugins & Connections
          </button>
          <button className="primary" onClick={() => onOpenAgent("provider-router")}>
            <PlugZap size={18} />
            Configure Routing
          </button>
        </div>
      </section>

      <section className="readiness-grid">
        <div className="readiness-panel">
          <span className="eyebrow">
            <ShieldCheck size={16} />
            Setup checklist
          </span>
          <div className="checklist">
            {setupItems.map((item) => (
              <button className="check-row" key={item.id} onClick={() => item.target ? onOpenAgent(item.target) : onOpenPlugins()}>
                <span className={item.done ? "check-dot done" : "check-dot"} />
                <div>
                  <b>{item.label}</b>
                  <small>{item.detail}</small>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="readiness-panel">
          <span className="eyebrow">
            <Gauge size={16} />
            Package mode
          </span>
          <div className="package-facts">
            <Metric label="Runtime" value={snapshot?.osStatus?.service || "hermes-agent-os-runtime"} />
            <Metric label="Store" value={snapshot?.osStatus?.store?.root || "~/.hermes-agent-os/"} />
            <Metric label="Connected" value={`${integrations.filter((item) => item.status === "connected").length}/${integrations.length || 0}`} />
            <Metric label="Export" value="clean package audit enabled" />
          </div>
        </div>
      </section>

      <AgentOsLoopPanel
        kernel={kernel}
        readiness={readiness || kernel?.readiness || null}
        agentRuns={agentRuns}
        integrations={integrations}
        error={kernelError}
        onOpen={onOpenAgent}
      />

      <section className="status-grid">
        {topCards.map((item) => (
          <HealthCard integration={item} key={item.id} onOpen={() => onOpenDrawer(item)} />
        ))}
      </section>

      <SectionHeading title="Agent orchestration" suffix="click to open control room" />
      <section className="agent-grid">
        {integrations
          .filter((item) => ["claude", "openclaw", "openclaude", "hermes", "gemini", "codex", "opencode"].includes(item.id))
          .map((item) => (
            <AgentCard integration={item} key={item.id} onOpen={() => onOpenAgent(item.id)} />
          ))}
      </section>

      <SectionHeading title="Model Providers" suffix="connect your own keys and local endpoints" />
      <section className="agent-grid">
        {providers
          .map((item) => (
            <AgentCard integration={item} key={item.id} onOpen={() => onOpenAgent(item.id)} />
          ))}
      </section>

      <SectionHeading title="Local Workspace" suffix="works without external API keys" />
      <section className="agent-grid">
        {selfModules.map((item) => (
          <AgentCard integration={item} key={item.id} onOpen={() => onOpenAgent(item.id)} />
        ))}
      </section>
    </main>
  );
}

function AgentOsLoopPanel({
  kernel,
  readiness,
  agentRuns,
  integrations,
  error,
  onOpen
}: {
  kernel: KernelStatus | null;
  readiness: AgentOsReadiness | null;
  agentRuns: AgentRuns | null;
  integrations: Integration[];
  error: string | null;
  onOpen: (id: string) => void;
}) {
  const steps = buildAgentOsLoop(kernel, integrations);
  const blocker = readiness?.primaryBlocker;
  return (
    <section className="os-loop-panel">
      <div className="os-loop-head">
        <div>
          <span className="eyebrow">
            <ServerCog size={16} />
            Agent OS loop
          </span>
          <h2>Control, run, remember, schedule</h2>
          <p>Each agent lane should move through this loop: configure a provider or CLI, run the agent, save proof to memory, create a handoff, and schedule the next action.</p>
        </div>
        <div className="os-loop-summary">
          <Metric label="Readiness" value={readiness ? `${readiness.score}%` : "loading"} />
          <Metric label="State" value={readiness ? readinessStatusLabel(readiness.status) : "checking"} />
          <Metric label="Implemented" value={String(kernel?.summary.implemented ?? 0)} />
          <Metric label="Configure" value={String(kernel?.summary.configRequired ?? 0)} />
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {readiness ? (
        <div className={readiness.status === "blocked" ? "readiness-truth blocked" : "readiness-truth"}>
          <div>
            <b>{readinessStatusLabel(readiness.status)}</b>
            <p>{readiness.publicSummary}</p>
          </div>
          <div className="readiness-truth-metrics">
            <Metric label="Agents" value={`${readiness.summary.connectedAgents}/${readiness.summary.totalAgents}`} />
            <Metric label="Healthy providers" value={`${readiness.summary.connectedProviders}/${readiness.summary.totalProviders}`} />
            <Metric label="Configured" value={String(readiness.summary.configuredProviders || 0)} />
            <Metric label="Mode" value={readiness.summary.dryRunDefault ? "dry-run" : "live"} />
          </div>
          {blocker ? (
            <button className="wide-action" onClick={() => blocker.target ? onOpen(blocker.target) : undefined}>
              Fix first gate: {blocker.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {readiness ? (
        <div className="readiness-gates">
          {readiness.requirements.map((item) => (
            <button className="readiness-gate" key={item.id} onClick={() => item.target ? onOpen(item.target) : undefined}>
              <span className={item.status === "ready" ? "check-dot done" : "check-dot"} />
              <div>
                <b>{item.label}</b>
                <small>{item.evidence}</small>
              </div>
              <span className={statusClass(item.status === "ready" ? "connected" : "ready_to_configure")}>
                {item.status === "ready" ? "Ready" : "Fix"}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <AgentRunsOverview agentRuns={agentRuns} onOpen={onOpen} />
      <div className="os-loop-grid">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <button className="os-loop-step" key={step.id} onClick={() => onOpen(step.target)}>
              <span className="os-step-index">{index + 1}</span>
              <Icon size={20} />
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
                <small>{step.metric}</small>
              </div>
              <span className={statusClass(step.status)}>{statusLabel(step.status)}</span>
            </button>
          );
        })}
      </div>
      <div className="os-invariants">
        {(kernel?.invariants || []).slice(0, 4).map((item) => (
          <span className={statusClass(item.status)} key={item.id}>{item.label}</span>
        ))}
      </div>
    </section>
  );
}

function AgentRunsOverview({ agentRuns, onOpen }: { agentRuns: AgentRuns | null; onOpen: (id: string) => void }) {
  return (
    <div className="agent-runs-overview">
      <div className="proof-header">
        <div>
          <b>Agent Runner proof</b>
          <p>Latest OS-wide runs with memory, Kanban, usage, logs, and replay status.</p>
        </div>
        <div className="agent-runs-summary">
          <Metric label="Runs" value={String(agentRuns?.summary.total ?? 0)} />
          <Metric label="Memory" value={String(agentRuns?.summary.withMemory ?? 0)} />
          <Metric label="Kanban" value={String(agentRuns?.summary.withKanban ?? 0)} />
          <Metric label="Replay" value={String(agentRuns?.summary.replayable ?? 0)} />
        </div>
      </div>
      <div className="agent-runs-list">
        {agentRuns?.runs.length ? agentRuns.runs.slice(0, 4).map((run) => (
          <button className="agent-run-row" key={`${run.moduleId}-${run.runId}`} onClick={() => onOpen(run.moduleId)}>
            <div>
              <b>{run.moduleLabel || run.moduleId}</b>
              <small>{run.action || "message"} / {run.mode} / {new Date(run.loggedAt || run.requestedAt).toLocaleTimeString()}</small>
            </div>
            <div className="run-chip-row">
              <small>{run.dryRun ? "dry run" : "executed"}</small>
              {run.handoff?.memoryId ? <small>memory</small> : null}
              {run.handoff?.kanbanCardId ? <small>kanban</small> : null}
              {run.replay?.available ? <small>replay</small> : null}
            </div>
            <span className={statusClass(run.handoff?.status || run.status || run.mode)}>{statusLabel(run.handoff?.status || run.status || run.mode)}</span>
          </button>
        )) : (
          <p>No Agent Runner proof yet. Open a control room and send a dry-run to create memory and Kanban proof.</p>
        )}
      </div>
    </div>
  );
}

function readinessStatusLabel(status: string) {
  if (status === "live_execution_ready") return "Live-ready";
  if (status === "dry_run_ready") return "Dry-run-ready";
  if (status === "blocked") return "Blocked";
  return statusLabel(status);
}

function buildAgentOsLoop(kernel: KernelStatus | null, integrations: Integration[]) {
  const components = new Map((kernel?.components || []).map((item) => [item.id, item]));
  const modules = new Map(integrations.map((item) => [item.id, item]));
  const component = (id: string) => components.get(id);
  const module = (id: string) => modules.get(id);
  const metric = (id: string, key: string, fallback = "0") => {
    const value = component(id)?.metrics?.[key];
    return value == null ? fallback : String(value);
  };
  const agentCount = integrations.filter((item) => item.category === "agent").length;
  const connectedAgents = integrations.filter((item) => item.category === "agent" && item.status === "connected").length;
  return [
    {
      id: "runtime-core",
      label: "Runtime core",
      target: "setup",
      icon: ServerCog,
      status: component("runtime-core")?.status || module("elizaos-runtime")?.status || "ready_to_configure",
      detail: component("runtime-core")?.publicSummary || "Load the local Agent OS runtime and setup mode.",
      metric: `modules ${metric("module-registry", "total", String(integrations.length))}`
    },
    {
      id: "provider-router",
      label: "Model routing",
      target: "provider-router",
      icon: Cable,
      status: component("provider-router")?.status || module("provider-router")?.status || "ready_to_configure",
      detail: component("provider-router")?.publicSummary || "Route prompts through user-owned cloud or local model providers.",
      metric: `configured providers ${metric("provider-router", "configuredProviders")}`
    },
    {
      id: "agent-control",
      label: "Agent control",
      target: "hermes",
      icon: BrainCircuit,
      status: connectedAgents ? "implemented" : "ready_to_configure",
      detail: "Open Hermes, Codex, Claude Code, OpenCode, OpenClaw, Gemini, or routing profiles and run from the dashboard.",
      metric: `${connectedAgents}/${agentCount} connected`
    },
    {
      id: "workflow-engine",
      label: "Workflow execution",
      target: "workflows",
      icon: Workflow,
      status: component("workflow-engine")?.status || module("workflows")?.status || "implemented",
      detail: component("workflow-engine")?.publicSummary || "Run graph workflows with approvals, retries, branches, and replay.",
      metric: `workflows ${metric("workflow-engine", "workflows")}`
    },
    {
      id: "memory",
      label: "Memory",
      target: "memory",
      icon: DatabaseZap,
      status: component("memory")?.status || module("memory")?.status || "implemented",
      detail: component("memory")?.publicSummary || "Store semantic, episodic, and procedural memory locally.",
      metric: `active ${metric("memory", "active")}`
    },
    {
      id: "kanban-handoffs",
      label: "Handoffs",
      target: "kanban",
      icon: KanbanSquare,
      status: component("kanban-handoffs")?.status || module("kanban")?.status || "implemented",
      detail: component("kanban-handoffs")?.publicSummary || "Create local task cards from agent runs, workflows, and approvals.",
      metric: `cards ${metric("kanban-handoffs", "total")}`
    },
    {
      id: "scheduler",
      label: "Scheduler",
      target: "scheduler",
      icon: Clock,
      status: component("scheduler")?.status || module("scheduler")?.status || "implemented",
      detail: component("scheduler")?.publicSummary || "Run workflows and goal loops on intervals with approval gates.",
      metric: `jobs ${metric("scheduler", "total")}`
    },
    {
      id: "skill-registry",
      label: "Skills",
      target: "skill-registry",
      icon: PlugZap,
      status: component("skill-registry")?.status || module("skill-registry")?.status || "implemented",
      detail: component("skill-registry")?.publicSummary || "Install, configure, test, and trust signed agent skills.",
      metric: `available ${metric("skill-registry", "total")}`
    }
  ];
}

function buildSetupChecklist(integrations: Integration[]) {
  const byId = new Map(integrations.map((item) => [item.id, item]));
  const hasAnyProvider = ["provider-openrouter", "provider-minimax", "provider-openai", "provider-anthropic", "provider-gemini", "provider-ollama"]
    .some((id) => byId.get(id)?.status === "connected");
  const localModulesReady = ["goals", "notebook", "kanban", "usage-credits"]
    .every((id) => byId.get(id)?.status === "connected");
  return [
    {
      id: "runtime",
      label: "Runtime API",
      detail: byId.get("elizaos-runtime")?.status === "connected" ? "elizaOS core is loadable" : "backend is waiting for runtime dependency",
      done: byId.get("elizaos-runtime")?.status === "connected",
      target: "elizaos-runtime"
    },
    {
      id: "providers",
      label: "Model provider",
      detail: hasAnyProvider ? "at least one model route is configured" : "connect OpenRouter, MiniMax, Ollama, OpenAI, Anthropic, or Gemini",
      done: hasAnyProvider,
      target: "provider-openrouter"
    },
    {
      id: "routing",
      label: "Agent routing",
      detail: byId.get("provider-router")?.status === "connected" ? "local/open provider routing configured" : "configure Provider Router with OpenRouter, Ollama, or MiniMax",
      done: byId.get("provider-router")?.status === "connected",
      target: "provider-router"
    },
    {
      id: "builder",
      label: "Open Agent Builder",
      detail: byId.get("firecrawl-builder")?.status === "connected" ? "Firecrawl execution configured" : "add Convex, Clerk, Firecrawl, and LLM keys before builder execution",
      done: byId.get("firecrawl-builder")?.status === "connected",
      target: "firecrawl-builder"
    },
    {
      id: "workspace",
      label: "Local workspace",
      detail: localModulesReady ? "Goals, Notebook, Kanban, and Credits are ready" : "local self modules are not all ready",
      done: localModulesReady,
      target: "goals"
    }
  ];
}

function HealthCard({ integration, onOpen }: { integration: Integration; onOpen: () => void }) {
  const Icon = iconMap[integration.id] || Activity;
  return (
    <button className="health-card" onClick={onOpen}>
      <div>
        <Icon size={18} />
        <strong>{integration.label}</strong>
      </div>
      <span className={statusClass(String(integration.status))}>{statusLabel(String(integration.status))}</span>
      <dl>
        <dt>{integration.type}</dt>
        <dd>{integration.version || integration.profile || integration.profileCount || integration.connection}</dd>
      </dl>
    </button>
  );
}

function AgentCard({ integration, onOpen }: { integration: Integration; onOpen: () => void }) {
  const Icon = iconMap[integration.id] || Bot;
  return (
    <article className="agent-card">
      <div className="agent-card-head">
        <div className="agent-icon">
          <Icon size={22} />
        </div>
        <div>
          <h3>{integration.label}</h3>
          <p>{integration.connection}</p>
        </div>
        <span className={statusClass(String(integration.status))}>{statusLabel(String(integration.status))}</span>
      </div>
      <div className="metric-row">
        <Metric label="Category" value={integration.category || integration.type} />
        <Metric label="Configured" value={integration.configured ? "yes" : "needs setup"} />
        <Metric label="Missing" value={integration.missing?.length ? integration.missing.join(", ") : "none"} />
      </div>
      <button className="wide-action" onClick={onOpen}>
        Open control room
      </button>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b title={value}>{value}</b>
    </div>
  );
}

function SectionHeading({ title, suffix }: { title: string; suffix?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {suffix ? <span>{suffix}</span> : null}
    </div>
  );
}

function VoiceControlPage({ onOpenAgent }: { onOpenAgent: (id: string) => void }) {
  const [status, setStatus] = useState<VoiceControlStatus | null>(null);
  const [transcript, setTranscript] = useState("Hermes, open Chrome");
  const [result, setResult] = useState<VoiceCommandResult | null>(null);
  const [commandHistory, setCommandHistory] = useState<VoiceCommandResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [lastHeard, setLastHeard] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [recognizer, setRecognizer] = useState<unknown>(null);
  const [desktopContext, setDesktopContext] = useState<VoiceDesktopContext | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const recognizerRef = useRef<{ stop?: () => void; start?: () => void; abort?: () => void } | null>(null);
  const handsFreeRef = useRef(false);
  const busyRef = useRef(false);
  const dryRunRef = useRef(true);
  const lastAutoCommandRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    dryRunRef.current = dryRun;
  }, [dryRun]);

  async function refreshStatus() {
    try {
      const next = await getVoiceControlStatus();
      setStatus(next);
      setDesktopContext({
        ok: Boolean(next.tools.accessibility),
        accessibility: Boolean(next.tools.accessibility),
        frontApp: next.tools.frontApp || null,
        frontWindow: next.tools.frontWindow || null,
        windowCount: 0,
        uiElementCount: 0,
        uiLabels: [],
        error: null
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load voice control status");
    }
  }

  async function inspectDesktopContext() {
    setContextBusy(true);
    setError(null);
    try {
      setDesktopContext(await getVoiceDesktopContext(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to inspect desktop context");
    } finally {
      setContextBusy(false);
    }
  }

  useEffect(() => {
    refreshStatus();
    return () => {
      handsFreeRef.current = false;
      recognizerRef.current?.abort?.();
      recognizerRef.current?.stop?.();
    };
  }, []);

  function speechRecognitionConstructor() {
    return (window as unknown as {
      SpeechRecognition?: new () => {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onresult: ((event: unknown) => void) | null;
        onerror: ((event: unknown) => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
        abort?: () => void;
      };
      webkitSpeechRecognition?: new () => {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onresult: ((event: unknown) => void) | null;
        onerror: ((event: unknown) => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
        abort?: () => void;
      };
    }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
  }

  function extractRecognition(event: unknown) {
    const results = (event as { results?: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }).results;
    if (!results) return { text: "", finalText: "" };
    const parts = Array.from(results).map((item) => ({
      text: item?.[0]?.transcript || "",
      isFinal: Boolean(item?.isFinal)
    }));
    return {
      text: parts.map((item) => item.text).join(" ").trim(),
      finalText: parts.filter((item) => item.isFinal).map((item) => item.text).join(" ").trim()
    };
  }

  function startsWithWakeWord(value: string) {
    const lower = value.trim().toLowerCase();
    return ["hermes", "hey hermes", "ok hermes", "okay hermes"].some((wake) =>
      lower === wake || lower.startsWith(`${wake} `) || lower.startsWith(`${wake},`)
    );
  }

  async function submitVoiceCommand(commandText: string) {
    const clean = commandText.trim();
    if (!clean || busyRef.current) return;
    const nowMs = Date.now();
    if (lastAutoCommandRef.current.text === clean && nowMs - lastAutoCommandRef.current.at < 2500) return;
    lastAutoCommandRef.current = { text: clean, at: nowMs };
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      const next = await runVoiceCommand({ transcript: clean, dryRun: dryRunRef.current, useModel: true });
      setTranscript(clean);
      setResult(next);
      setCommandHistory((current) => [next, ...current].slice(0, 8));
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Voice command failed");
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }

  function startListening(nextHandsFree = false) {
    const SpeechRecognitionCtor = speechRecognitionConstructor();
    if (!SpeechRecognitionCtor) {
      setError("This browser does not expose native speech recognition. Type the command and run it from this panel.");
      return;
    }
    recognizerRef.current?.abort?.();
    recognizerRef.current?.stop?.();
    const next = new SpeechRecognitionCtor();
    next.continuous = nextHandsFree;
    next.interimResults = true;
    next.lang = "en-US";
    next.onresult = (event: unknown) => {
      const { text, finalText } = extractRecognition(event);
      if (!text) return;
      if (nextHandsFree) {
        setLastHeard(text);
        if (finalText && startsWithWakeWord(finalText)) {
          void submitVoiceCommand(finalText);
        }
      } else {
        setTranscript(text);
      }
    };
    next.onerror = (event: unknown) => {
      setError(`Speech recognition failed: ${String((event as { error?: string }).error || "unknown error")}`);
      setListening(false);
      setHandsFree(false);
      handsFreeRef.current = false;
    };
    next.onend = () => {
      setListening(false);
      if (handsFreeRef.current) {
        window.setTimeout(() => {
          if (handsFreeRef.current) startListening(true);
        }, 350);
      }
    };
    setRecognizer(next);
    recognizerRef.current = next;
    setError(null);
    setListening(true);
    setHandsFree(nextHandsFree);
    handsFreeRef.current = nextHandsFree;
    next.start();
  }

  function stopListening() {
    handsFreeRef.current = false;
    setHandsFree(false);
    recognizerRef.current?.abort?.();
    recognizerRef.current?.stop?.();
    setListening(false);
  }

  async function runCommand() {
    await submitVoiceCommand(transcript);
  }

  const sampleCommands = [
    "Hermes, open Chrome",
    "Hermes, search web for AI automation news",
    "Hermes, open downloads folder",
    "Hermes, create folder called Client Notes in downloads",
    "Hermes, move selected files to trash",
    "Hermes, what do you see",
    "Hermes, find on page pricing",
    "Hermes, open a new tab and search local automation",
    "Hermes, go back",
    "Hermes, open Chrome then search Hermes automation",
    "Hermes, minimize this window",
    "Hermes, make this window full screen",
    "Hermes, show desktop",
    "Hermes, quit Chrome",
    "Hermes, hide Safari",
    "Hermes, run workflow blank open agent builder",
    "Hermes, ask Codex to inspect the current project",
    "Hermes, paste \"Draft the reply now\"",
    "Hermes, scroll down",
    "Hermes, take a screenshot",
    "Hermes, find file called invoice"
  ];
  const tools = status?.tools;

  return (
    <main className="content two-column">
      <section className="control-room voice-room">
        <div className="control-header">
          <span className="eyebrow">
            <Mic size={16} />
            Voice Control
          </span>
          <h1>Hermes voice-controlled computer agent</h1>
          <p>Speak or type a command. Hermes strips the wake word, plans the desktop action, and executes macOS/browser/file controls only when the local execution gate is enabled.</p>
        </div>

        <section className="voice-command-panel">
          <div className="voice-toolbar">
            <button className={listening && !handsFree ? "wide-action danger" : "wide-action primary"} onClick={listening && !handsFree ? stopListening : () => startListening(false)} disabled={handsFree}>
              {listening ? <MicOff size={18} /> : <Mic size={18} />}
              {listening && !handsFree ? "Stop listening" : "Listen once"}
            </button>
            <button className={handsFree ? "wide-action danger" : "wide-action"} onClick={handsFree ? stopListening : () => startListening(true)}>
              {handsFree ? <MicOff size={18} /> : <Mic size={18} />}
              {handsFree ? "Stop hands-free" : "Hands-free"}
            </button>
            <button className="wide-action" onClick={runCommand} disabled={busy || !transcript.trim()}>
              {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              {dryRun ? "Plan command" : "Run command"}
            </button>
            <label className="toggle-row">
              <input type="checkbox" checked={!dryRun} onChange={(event) => setDryRun(!event.target.checked)} />
              <span>Live execution</span>
            </label>
          </div>

          <div className={handsFree ? "handsfree-status active" : "handsfree-status"}>
            <span>{handsFree ? "Listening for wake word" : "Hands-free paused"}</span>
            <b>{lastHeard || "Say: Hermes, what do you see"}</b>
          </div>

          <textarea
            className="voice-transcript"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="Hermes, open Chrome"
          />

          <div className="quick-command-grid">
            {sampleCommands.map((item) => (
              <button key={item} onClick={() => setTranscript(item)}>
                {item}
              </button>
            ))}
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
          {result ? (
            <div className="voice-result">
              <div className="proof-header">
                <div>
                  <b>{result.reply}</b>
                  <p>{result.plan.summary}</p>
                </div>
                <div className="agent-runs-summary">
                  <Metric label="Mode" value={result.mode} />
                  <Metric label="Planner" value={result.plan.source} />
                  <Metric label="Intent" value={result.plan.intent} />
                  <Metric label="Actions" value={String(result.actions.length)} />
                </div>
              </div>
              {result.plan.warnings.length ? (
                <div className="error-banner muted">
                  {result.plan.warnings.join(" ")}
                </div>
              ) : null}
              <div className="voice-action-list">
                {result.actions.map((action, index) => (
                  <article className="workflow-event" key={`${action.type}-${index}`}>
                    <span className={action.ok ? "is-online" : "is-muted"}>{action.type}</span>
                    <div>
                      <strong>{action.summary || action.type}</strong>
                      <small>{action.command || "no command preview"}</small>
                      {action.error ? <p>{action.error}</p> : null}
                      {action.output ? <code className="session-output detail">{typeof action.output === "string" ? action.output : JSON.stringify(action.output, null, 2)}</code> : null}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {commandHistory.length ? (
            <div className="voice-history">
              <b>Recent voice commands</b>
              {commandHistory.map((item) => (
                <button key={item.runId} onClick={() => setResult(item)}>
                  <span>{item.plan.intent}</span>
                  <small>{item.command}</small>
                  <em>{item.mode}</em>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </section>

      <aside className="side-panel">
        <h3>Voice readiness</h3>
        <Metric label="Status" value={status ? statusLabel(status.status) : "checking"} />
        <Metric label="Model" value={status?.model || "not loaded"} />
        <Metric label="Execution" value={tools?.executionGate ? "enabled" : "dry-run gate"} />
        <Metric label="Gate source" value={tools?.executionGateSource || "disabled"} />
        <Metric label="Codex GPT" value={tools?.codexGptPlanner ? "configured" : "missing key"} />
        <Metric label="Accessibility" value={tools?.accessibility ? "available" : "needs permission"} />
        <Metric label="Click tool" value={tools?.cliclick ? "available" : "install cliclick"} />
        <div className="tool-chip-grid">
          {tools ? Object.entries(tools).filter(([, value]) => typeof value === "boolean").map(([key, value]) => (
            <span className={value ? "is-online" : "is-muted"} key={key}>{key}</span>
          )) : null}
        </div>
        <div className="side-note">
          <b>Current gates</b>
          <p>Dry-run is always safe and creates the action plan.</p>
          <p>Live execution requires the trusted execution gate plus the Live execution toggle.</p>
          <p>Typing, clicking, and screenshots also need macOS Accessibility or Screen Recording permission for the runtime app.</p>
          <p>Workflow and module commands use the local Agent OS runners when live execution is enabled.</p>
        </div>
        <div className="side-note">
          <b>Desktop context</b>
          <p>{desktopContext?.frontApp || "No front app detected"}{desktopContext?.frontWindow ? ` / ${desktopContext.frontWindow}` : ""}</p>
          <p>{desktopContext?.accessibility ? `${desktopContext.uiElementCount || 0} visible UI elements inspected.` : desktopContext?.error || "Accessibility context is not available yet."}</p>
          {desktopContext?.uiLabels?.length ? (
            <div className="context-labels">
              {desktopContext.uiLabels.slice(0, 16).map((item) => <span key={item}>{item}</span>)}
            </div>
          ) : null}
          <button className="wide-action" onClick={inspectDesktopContext} disabled={contextBusy}>
            {contextBusy ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
            Inspect visible UI
          </button>
        </div>
        <button className="wide-action" onClick={() => onOpenAgent("codex")}>
          <Code2 size={18} />
          Open Codex lane
        </button>
      </aside>
    </main>
  );
}

function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState("blank-open-agent-builder");
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [events, setEvents] = useState<WorkflowEvents | null>(null);
  const [replay, setReplay] = useState<WorkflowReplay | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function refresh() {
    const data = await getWorkflows();
    setWorkflows(data.workflows);
    if (!selectedId && data.workflows[0]) setSelectedId(data.workflows[0].id);
  }

  useEffect(() => {
    refresh().catch((err) => setResult(err instanceof Error ? err.message : "Unable to load workflows"));
  }, []);

  async function loadEvents(nextRun: WorkflowRun) {
    const [eventReplay, graphReplay] = await Promise.all([
      getWorkflowEvents(nextRun.workflowId, nextRun.id),
      getWorkflowReplay(nextRun.workflowId, nextRun.id)
    ]);
    setEvents(eventReplay);
    setReplay(graphReplay);
  }

  async function runSelected() {
    setBusy(true);
    setResult(null);
    try {
      const nextRun = await runWorkflow(selectedId);
      setRun(nextRun);
      await loadEvents(nextRun);
      setResult(`Run ${nextRun.id} finished with ${nextRun.status}.`);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Workflow run failed");
    } finally {
      setBusy(false);
    }
  }

  async function resumeSelectedRun() {
    if (!run) return;
    setBusy(true);
    setResult(null);
    try {
      const resumed = await resumeWorkflow(run.workflowId, run.id, { approved: true });
      setRun(resumed);
      await loadEvents(resumed);
      setResult(`Run ${resumed.id} resumed with ${resumed.status}.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Workflow resume failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedId);

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <Workflow size={16} />
            Workflow Engine
          </span>
          <h1>Graph workflow runs</h1>
          <p>Run Open Agent Builder-compatible graphs through Hermes OS with edge traversal, branch routing, loop guards, approvals, and replayable run events.</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Workflow catalog</b>
            <div className="audit-list">
              {workflows.map((workflow) => (
                <button
                  className={workflow.id === selectedId ? "audit-row active" : "audit-row"}
                  key={workflow.id}
                  onClick={() => setSelectedId(workflow.id)}
                >
                  <div>
                    <strong>{workflow.name}</strong>
                    <span>{workflow.description || workflow.id}</span>
                  </div>
                  <span className="is-ready">{workflow.nodeCount} nodes / {workflow.edgeCount || 0} edges</span>
                </button>
              ))}
              {!workflows.length ? <p>No workflows saved yet.</p> : null}
            </div>
            <button className="wide-action" onClick={runSelected} disabled={busy || !selectedId}>
              {busy ? <Loader2 className="spin" size={18} /> : <Workflow size={18} />}
              Run selected workflow
            </button>
            {run?.status === "waiting_for_approval" ? (
              <button className="wide-action" onClick={resumeSelectedRun} disabled={busy}>
                {busy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
                Approve and resume run
              </button>
            ) : null}
            {result ? <div className="test-result">{result}</div> : null}
          </div>

          <div className="setup-row">
            <b>Replay graph</b>
            {replay ? (
              <div className="workflow-replay">
                <div className="metric-row compact">
                  <Metric label="Mode" value={replay.graphMode} />
                  <Metric label="Nodes" value={`${replay.summary.completedNodes}/${replay.summary.nodes}`} />
                  <Metric label="Edges" value={`${replay.summary.traversedEdges}/${replay.summary.edges}`} />
                  <Metric label="Groups" value={String(replay.summary.parallelGroups)} />
                </div>
                <div className="replay-map" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.max(...replay.nodes.map((node) => node.depth), 0) + 1)}, minmax(160px, 1fr))` }}>
                  {replay.nodes.map((node) => (
                    <article
                      className={`replay-node ${statusClass(node.status)}`}
                      key={node.id}
                      style={{ gridColumn: node.depth + 1 }}
                    >
                      <strong>{node.label}</strong>
                      <span>{[node.type, node.status, `${node.attempts} attempts`].join(" / ")}</span>
                      {node.branchIds.length || node.parallelGroupIds.length ? (
                        <small>{[...node.branchIds, ...node.parallelGroupIds].join(" / ")}</small>
                      ) : null}
                    </article>
                  ))}
                </div>
                <div className="replay-edge-list">
                  {replay.edges.map((edge) => (
                    <span className={edge.status === "traversed" ? "is-ready" : "is-muted"} key={edge.id}>
                      {`${edge.source} -> ${edge.target}${edge.label ? ` (${edge.label})` : ""}${edge.parallelGroupIds.length ? ` / ${edge.parallelGroupIds.join(", ")}` : ""}`}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p>Run a workflow to render the node and edge replay map.</p>
            )}
          </div>

          <div className="setup-row">
            <b>Run timeline</b>
            {run ? (
              <div className="workflow-run-panel">
                <div className="metric-row compact">
                  <Metric label="Run" value={run.id} />
                  <Metric label="Status" value={statusLabel(run.status)} />
                  <Metric label="Graph" value={run.graph?.mode || "legacy"} />
                </div>
                <div className="workflow-events">
                  {(events?.events || run.events || []).map((event) => (
                    <article className="workflow-event" key={event.id}>
                      <span className={statusClass(event.status || event.level)}>{event.type}</span>
                      <div>
                        <strong>{event.message}</strong>
                        <small>{[event.nodeId, event.edgeId, event.branchId, event.parallelGroupId, event.timestamp].filter(Boolean).join(" / ")}</small>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <p>Run a workflow to see replayable graph events.</p>
            )}
          </div>

          <div className="setup-row">
            <b>Node attempts</b>
            <div className="local-list">
              {run?.nodeRuns.length ? run.nodeRuns.map((nodeRun, index) => (
                <article className="local-item" key={`${nodeRun.nodeId}-${nodeRun.attempt}-${index}`}>
                  <strong>{nodeRun.label}</strong>
                  <span>{[nodeRun.type, nodeRun.status, `attempt ${nodeRun.attempt || 1}`, nodeRun.branchId, nodeRun.parallelGroupId].filter(Boolean).join(" / ")}</span>
                  <p>{nodeRun.message}</p>
                </article>
              )) : <p>No node attempts yet.</p>}
            </div>
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Workflow status</h3>
        <Metric label="Selected" value={selectedWorkflow?.id || "none"} />
        <Metric label="Nodes" value={String(selectedWorkflow?.nodeCount || 0)} />
        <Metric label="Edges" value={String(selectedWorkflow?.edgeCount || 0)} />
        <Metric label="Last run" value={run?.id || "none"} />
        <Metric label="Events" value={String(events?.eventCount || run?.events?.length || 0)} />
        <Metric label="Traversed" value={String(run?.traversedEdges?.length || 0)} />
        <Metric label="Branches" value={String(replay?.summary.branches || run?.graph?.branchCount || 0)} />
        <Metric label="Parallel groups" value={String(replay?.summary.parallelGroups || run?.graph?.parallelGroups?.length || 0)} />
        <div className="side-note">
          <b>Engine guarantees</b>
          <p>Edges drive execution when present; node order becomes implicit edges only for old workflows.</p>
          <p>Branch labels, source handles, and default edges are honored.</p>
          <p>Non-routing nodes fan out through parallel branches when several outgoing edges exist.</p>
          <p>Looping stops at the run max-step guard.</p>
        </div>
      </aside>
    </main>
  );
}

function PluginsPage({
  snapshot,
  onOpenDrawer
}: {
  snapshot: IntegrationSnapshot | null;
  onOpenDrawer: (integration: Integration) => void;
}) {
  const integrations = visibleIntegrations(snapshot?.integrations || []);
  const flow = snapshot?.flow || [];
  const [audit, setAudit] = useState<OsAudit | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    getOsAudit()
      .then((data) => {
        setAudit(data);
        setAuditError(null);
      })
      .catch((err) => {
        setAudit(null);
        setAuditError(err instanceof Error ? err.message : "Unable to load OS audit");
      });
  }, [snapshot?.generatedAt]);

  return (
    <main className="content">
      <section className="hero-panel compact">
        <div className="hero-copy">
          <span className="eyebrow">
            <PlugZap size={16} />
            Plugins & Connections
          </span>
          <h1>Connect every agent lane</h1>
          <p>Local CLIs, Hermes gateway profiles, model providers, browser control, and deployment signals in one connected hub.</p>
        </div>
      </section>

      <section className="flow-panel">
        {flow.map((step, index) => (
          <div className="flow-step" key={`${step}-${index}`}>
            <span>{index + 1}</span>
            <b>{step}</b>
          </div>
        ))}
      </section>

      <ToolAuditPanel audit={audit} error={auditError} integrations={integrations} onOpenDrawer={onOpenDrawer} />

      <section className="plugin-grid">
        {integrations.map((item) => (
          <PluginCard integration={item} key={item.id} onOpen={() => onOpenDrawer(item)} />
        ))}
      </section>
    </main>
  );
}

function ToolAuditPanel({
  audit,
  error,
  integrations,
  onOpenDrawer
}: {
  audit: OsAudit | null;
  error: string | null;
  integrations: Integration[];
  onOpenDrawer: (integration: Integration) => void;
}) {
  const byId = new Map(integrations.map((item) => [item.id, item]));
  const needsWork = audit?.items.filter((item) => item.severity !== "ok").slice(0, 12) || [];
  return (
    <section className="audit-panel">
      <div className="audit-head">
        <span className="eyebrow">
          <ShieldCheck size={16} />
          OS tool audit
        </span>
        {audit ? (
          <div className="audit-summary">
            <Metric label="Ready" value={String(audit.summary.ok)} />
            <Metric label="Setup" value={String(audit.summary.setup)} />
            <Metric label="Action" value={String(audit.summary.actionRequired)} />
          </div>
        ) : null}
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="audit-list">
        {needsWork.length ? needsWork.map((item) => {
          const integration = byId.get(item.id);
          return (
            <article className="audit-row" key={item.id}>
              <div>
                <b>{item.label}</b>
                <span className={statusClass(item.status)}>{statusLabel(item.status)}</span>
                <p>{item.fix}</p>
              </div>
              {integration ? (
                <button onClick={() => onOpenDrawer(integration)}>
                  Inspect
                </button>
              ) : null}
            </article>
          );
        }) : (
          <p className="audit-empty">Every registered module is connected or locally ready.</p>
        )}
      </div>
    </section>
  );
}

function AgentBuilderPage() {
  const [status, setStatus] = useState<BuilderStatus | null>(null);
  const [bootstrap, setBootstrap] = useState<BuilderBootstrap | null>(null);
  const [smoke, setSmoke] = useState<BuilderSmokeTest | null>(null);
  const [logs, setLogs] = useState<BuilderLogs | null>(null);
  const [overlayWorkflowId, setOverlayWorkflowId] = useState("blank-open-agent-builder");
  const [overlayRunId, setOverlayRunId] = useState("");
  const [overlay, setOverlay] = useState<BuilderReplayOverlay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function refreshBuilder() {
    try {
      setError(null);
      const [statusData, logData, bootstrapData] = await Promise.all([getBuilderStatus(), getBuilderLogs(), getBuilderBootstrap()]);
      setStatus(statusData);
      setLogs(logData);
      setBootstrap(bootstrapData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load builder status");
    } finally {
      setLoading(false);
    }
  }

  async function prepareBootstrap() {
    setBusy(true);
    setResult(null);
    try {
      const output = await prepareBuilderBootstrap();
      setBootstrap(output.bootstrap);
      setResult(output.message);
      await refreshBuilder();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Builder bootstrap prepare failed");
      await refreshBuilder();
    } finally {
      setBusy(false);
    }
  }

  async function runSmoke() {
    setBusy(true);
    setResult(null);
    try {
      const output = await runBuilderSmokeTest();
      setSmoke(output);
      setResult(output.message);
      await refreshBuilder();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Builder smoke test failed");
      await refreshBuilder();
    } finally {
      setBusy(false);
    }
  }

  async function validateOverlay() {
    if (!overlayWorkflowId.trim() || !overlayRunId.trim()) {
      setResult("Enter a workflow id and run id before loading a replay overlay.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const output = await getBuilderReplayOverlay(overlayWorkflowId.trim(), overlayRunId.trim());
      setOverlay(output);
      setResult(`Replay overlay loaded: ${output.summary.completedNodes}/${output.summary.nodes} nodes, ${output.summary.traversedEdges}/${output.summary.edges} edges.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Replay overlay load failed");
    } finally {
      setBusy(false);
    }
  }

  async function runWorkflowOverlay() {
    const workflowId = overlayWorkflowId.trim() || "blank-open-agent-builder";
    setBusy(true);
    setResult(null);
    try {
      const nextRun = await runWorkflow(workflowId);
      setOverlayWorkflowId(nextRun.workflowId);
      setOverlayRunId(nextRun.id);
      const output = await getBuilderReplayOverlay(nextRun.workflowId, nextRun.id);
      setOverlay(output);
      setResult(`Workflow run ${nextRun.id} created and linked to the builder overlay.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Workflow overlay run failed");
    } finally {
      setBusy(false);
    }
  }

  function clearOverlay() {
    setOverlayRunId("");
    setOverlay(null);
    setResult("Replay overlay cleared.");
  }

  async function startSupervisor() {
    setBusy(true);
    setResult(null);
    try {
      const output = await startBuilder();
      setStatus(output);
      setResult(`Builder supervisor ${output.supervisor.state}.`);
      await refreshBuilder();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Builder supervisor start failed");
      await refreshBuilder();
    } finally {
      setBusy(false);
    }
  }

  async function stopSupervisor() {
    setBusy(true);
    setResult(null);
    try {
      const output = await stopBuilder();
      setStatus(output);
      setResult(`Builder supervisor ${output.supervisor.state}.`);
      await refreshBuilder();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Builder supervisor stop failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshBuilder();
  }, []);

  const activeBuilderSrc = status?.live && overlayWorkflowId.trim() && overlayRunId.trim()
    ? builderReplayOverlayUrl(overlayWorkflowId.trim(), overlayRunId.trim())
    : status?.proxiedUrl || "/agent-builder-source/?view=builder";

  return (
    <main className="original-builder-page">
      {status?.live ? (
        <section className="original-builder-frame-shell">
          <iframe
            title="Original Agent Builder"
            src={activeBuilderSrc}
            className="original-builder-frame"
          />
        </section>
      ) : (
        <section className="builder-status-panel">
          <span className="eyebrow">
            <Workflow size={16} />
            Real Agent Builder
          </span>
          <h1>Open Agent Builder is reset to upstream source</h1>
          <p>
            Hermes now uses the vendored Firecrawl Open Agent Builder with only an isolated purple theme layer.
            The previous custom lead-intake workflow and mock builder canvas are no longer used here.
          </p>
          {error ? <div className="error-banner">{error}</div> : null}
          <BuilderSupervisorPanel
            status={status}
            bootstrap={bootstrap}
            smoke={smoke}
            logs={logs}
            overlayWorkflowId={overlayWorkflowId}
            overlayRunId={overlayRunId}
            overlay={overlay}
            loading={loading}
            busy={busy}
            result={result}
            onRefresh={refreshBuilder}
            onPrepare={prepareBootstrap}
            onSmoke={runSmoke}
            onOverlayWorkflowChange={setOverlayWorkflowId}
            onOverlayRunChange={setOverlayRunId}
            onValidateOverlay={validateOverlay}
            onRunWorkflowOverlay={runWorkflowOverlay}
            onClearOverlay={clearOverlay}
            onStart={startSupervisor}
            onStop={stopSupervisor}
          />
        </section>
      )}
      {status?.live ? (
        <section className="builder-status-panel floating">
          <BuilderSupervisorPanel
            status={status}
            bootstrap={bootstrap}
            smoke={smoke}
            logs={logs}
            overlayWorkflowId={overlayWorkflowId}
            overlayRunId={overlayRunId}
            overlay={overlay}
            loading={loading}
            busy={busy}
            result={result}
            onRefresh={refreshBuilder}
            onPrepare={prepareBootstrap}
            onSmoke={runSmoke}
            onOverlayWorkflowChange={setOverlayWorkflowId}
            onOverlayRunChange={setOverlayRunId}
            onValidateOverlay={validateOverlay}
            onRunWorkflowOverlay={runWorkflowOverlay}
            onClearOverlay={clearOverlay}
            onStart={startSupervisor}
            onStop={stopSupervisor}
          />
        </section>
      ) : null}
    </main>
  );
}

function BuilderSupervisorPanel({
  status,
  bootstrap,
  smoke,
  logs,
  overlayWorkflowId,
  overlayRunId,
  overlay,
  loading,
  busy,
  result,
  onRefresh,
  onPrepare,
  onSmoke,
  onOverlayWorkflowChange,
  onOverlayRunChange,
  onValidateOverlay,
  onRunWorkflowOverlay,
  onClearOverlay,
  onStart,
  onStop
}: {
  status: BuilderStatus | null;
  bootstrap: BuilderBootstrap | null;
  smoke: BuilderSmokeTest | null;
  logs: BuilderLogs | null;
  overlayWorkflowId: string;
  overlayRunId: string;
  overlay: BuilderReplayOverlay | null;
  loading: boolean;
  busy: boolean;
  result: string | null;
  onRefresh: () => void;
  onPrepare: () => void;
  onSmoke: () => void;
  onOverlayWorkflowChange: (value: string) => void;
  onOverlayRunChange: (value: string) => void;
  onValidateOverlay: () => void;
  onRunWorkflowOverlay: () => void;
  onClearOverlay: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const required = status?.diagnostics.required || [];
  const optional = status?.diagnostics.optionalExecution || [];
  const formatStatus = (value: string) => value.split("_").join(" ");
  return (
    <>
      <div className="builder-status-grid">
        <Metric label="Status" value={loading ? "checking" : status?.status || "unknown"} />
        <Metric label="Supervisor" value={status?.supervisor.state || "stopped"} />
        <Metric label="Live" value={status?.live ? "yes" : "no"} />
        <Metric label="Ready" value={status?.readyToBoot ? "yes" : "no"} />
        <Metric label="Source" value={status?.source || "vendor/open-agent-builder"} />
        <Metric label="Upstream" value={status?.upstreamCommit?.slice(0, 12) || "unverified"} />
        <Metric label="Deps" value={status?.dependenciesInstalled ? "installed" : "missing"} />
        <Metric label="Theme" value={status?.theme || "Hermes purple"} />
      </div>
      <div className="builder-status-actions">
        <button onClick={onRefresh} disabled={busy}>
          {loading ? <Loader2 className="spin" size={17} /> : <Activity size={17} />}
          Refresh
        </button>
        <button onClick={onPrepare} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <TerminalSquare size={17} />}
          Prepare bootstrap
        </button>
        <button onClick={onSmoke} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <ShieldCheck size={17} />}
          Smoke test
        </button>
        <button onClick={onStart} disabled={busy || status?.supervisor.state === "running" || status?.status === "running"}>
          {busy ? <Loader2 className="spin" size={17} /> : <Rocket size={17} />}
          Start builder
        </button>
        <button onClick={onStop} disabled={busy || !["running", "starting", "stopping"].includes(status?.supervisor.state || "")}>
          <X size={17} />
          Stop builder
        </button>
        <a href="/agent-builder-source/?view=builder" target="_blank" rel="noreferrer">
          Open proxied builder
        </a>
      </div>
      {result ? <div className="test-result">{result}</div> : null}
      <div className="builder-diagnostics">
        <div>
          <b>Boot requirements</b>
          {required.map((item) => (
            <span className={item.configured ? "diag-ok" : "diag-missing"} key={item.key}>
              {item.key}: {item.configured ? "configured" : "missing"}
            </span>
          ))}
        </div>
        <div>
          <b>Execution keys</b>
          {optional.map((item) => (
            <span className={item.configured ? "diag-ok" : "diag-missing"} key={item.key}>
              {item.key}: {item.configured ? "configured" : "optional"}
            </span>
          ))}
        </div>
      </div>
      <div className="builder-diagnostics">
        <div>
          <b>Bootstrap checklist</b>
          {bootstrap?.steps.length ? bootstrap.steps.map((step) => (
            <span className={step.status === "done" || step.status === "ready" ? "diag-ok" : step.required ? "diag-missing" : "diag-optional"} key={step.id}>
              {step.label}: {formatStatus(step.status)}
            </span>
          )) : <span className="diag-missing">Bootstrap status not loaded</span>}
        </div>
        <div>
          <b>Smoke result</b>
          {smoke ? (
            <>
              <span className={smoke.ok ? "diag-ok" : "diag-missing"}>{formatStatus(smoke.status)}</span>
              <span className={smoke.executionReady ? "diag-ok" : "diag-optional"}>
                Execution keys: {smoke.executionReady ? "ready" : "optional keys missing"}
              </span>
              {smoke.checks.slice(0, 5).map((check) => (
                <span className={check.status === "passed" ? "diag-ok" : check.status === "failed" ? "diag-missing" : "diag-optional"} key={check.id}>
                  {check.label}: {check.status}
                </span>
              ))}
            </>
          ) : (
            <span className="diag-optional">Run smoke test to verify source, dependencies, credentials, and proxy readiness.</span>
          )}
        </div>
      </div>
      <div className="builder-diagnostics">
        <div>
          <b>Replay overlay</b>
          <label>
            <span>Workflow ID</span>
            <input value={overlayWorkflowId} onChange={(event) => onOverlayWorkflowChange(event.target.value)} />
          </label>
          <label>
            <span>Run ID</span>
            <input value={overlayRunId} onChange={(event) => onOverlayRunChange(event.target.value)} placeholder="run-..." />
          </label>
          <span className={overlay ? "diag-ok" : "diag-optional"}>
            {overlay ? `${overlay.summary.completedNodes}/${overlay.summary.nodes} nodes replayed` : "Run or paste a workflow run to enable the upstream overlay"}
          </span>
        </div>
        <div>
          <b>Overlay actions</b>
          <span className="diag-optional">The overlay is injected into the proxied upstream builder and anchors badges to matching real builder nodes when available.</span>
          <div className="builder-status-actions compact">
            <button onClick={onRunWorkflowOverlay} disabled={busy || !overlayWorkflowId.trim()}>
              <Workflow size={17} />
              Run and overlay
            </button>
            <button onClick={onValidateOverlay} disabled={busy || !overlayWorkflowId.trim() || !overlayRunId.trim()}>
              <Activity size={17} />
              Load overlay
            </button>
            <button onClick={onClearOverlay} disabled={busy || !overlayRunId.trim()}>
              <X size={17} />
              Clear overlay
            </button>
          </div>
          {overlay ? (
            <>
              <span className="diag-ok">Mode: {overlay.overlayMode}</span>
              <span className="diag-ok">Edges: {overlay.summary.traversedEdges}/{overlay.summary.edges}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="command-stack">
        <label>
          Install dependencies
          <code>{status?.installCommand || "npm run builder:install"}</code>
        </label>
        <label>
          Manual start command
          <code>{status?.startCommand || "npm run builder:start"}</code>
        </label>
        <label>
          Next bootstrap action
          <code>{bootstrap?.nextAction || "Load /api/builder/bootstrap"}</code>
        </label>
        <label>
          Smoke test endpoint
          <code>POST /api/builder/smoke-test</code>
        </label>
        <label>
          Replay overlay URL
          <code>{overlayWorkflowId && overlayRunId ? builderReplayOverlayUrl(overlayWorkflowId, overlayRunId) : "/agent-builder-source/?view=builder&hermesReplay=1"}</code>
        </label>
      </div>
      <div className="builder-log-list">
        <b>Supervisor logs</b>
        {logs?.logs.length ? logs.logs.slice(0, 8).map((entry) => (
          <article key={entry.id}>
            <span className={entry.level === "error" ? "is-muted" : entry.level === "warn" ? "is-ready" : "is-online"}>{entry.level}</span>
            <p>{entry.message}</p>
            <small>{entry.timestamp}</small>
          </article>
        )) : <p>No supervisor logs yet.</p>}
      </div>
    </>
  );
}

function AdminSessionPanel({
  session,
  onLogin
}: {
  session: AdminSession | null;
  onLogin: () => void;
}) {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function login() {
    if (!token.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      await adminLogin(token.trim());
      setToken("");
      setResult("Admin session unlocked.");
      onLogin();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Admin login failed");
    } finally {
      setBusy(false);
    }
  }

  if (!session?.required) {
    return (
      <div className="setup-row">
        <b>Admin safety</b>
        <p>Local mode is active. Public-mode write routes stay locked when auth is enabled.</p>
      </div>
    );
  }

  return (
    <div className="setup-row">
      <b>Admin safety</b>
      <p>{session.authenticated ? "Admin session active for setup and configuration." : "Public mode is locked. Enter the admin token to configure this install."}</p>
      {!session.authenticated ? (
        <div className="composer inline">
          <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="HERMES_AGENT_OS_ADMIN_TOKEN" type="password" />
          <button onClick={login} disabled={busy || !token.trim()}>
            {busy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
            Unlock
          </button>
        </div>
      ) : null}
      {result ? <div className="test-result">{result}</div> : null}
    </div>
  );
}

function SetupPage({ onOpenTarget }: { onOpenTarget: (id: string) => void }) {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [providerSetup, setProviderSetup] = useState<ProviderSetupState | null>(null);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [executionGate, setExecutionGate] = useState<ExecutionGateStatus | null>(null);
  const [mode, setMode] = useState("local");
  const [preferredProvider, setPreferredProvider] = useState("ollama");
  const [selectedGuide, setSelectedGuide] = useState("ollama");
  const [providerFields, setProviderFields] = useState<Record<string, string>>({});
  const [providerModel, setProviderModel] = useState("");
  const [executionGateReason, setExecutionGateReason] = useState("");
  const [ollamaInventory, setOllamaInventory] = useState<ProviderModelInventory | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const sessionData = await getAdminSession();
    setSession(sessionData);
    const [setupData, providerSetupData, gateData] = await Promise.all([getSetupState(), getProviderSetupState(), getExecutionGateStatus()]);
    setSetup(setupData);
    setProviderSetup(providerSetupData);
    setExecutionGate(gateData);
    setMode(setupData.mode);
    setPreferredProvider(setupData.preferredProvider);
    setSelectedGuide((current) => {
      if (providerSetupData.guides.some((guide) => guide.id === current)) return current;
      if (providerSetupData.guides.some((guide) => guide.id === setupData.preferredProvider)) return setupData.preferredProvider;
      return providerSetupData.guides[0]?.id || "ollama";
    });
  }

  useEffect(() => {
    refresh().catch((err) => {
      setResult(err instanceof Error ? err.message : "Unable to load setup state");
    });
  }, []);

  async function save(completed = false) {
    setBusy(true);
    setResult(null);
    try {
      const next = await saveSetupState({ mode, preferredProvider, completed });
      setSetup(next);
      setResult(completed && next.completed ? "Setup marked complete." : "Setup preferences saved.");
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Setup save failed");
    } finally {
      setBusy(false);
    }
  }

  async function startWorkflow() {
    setBusy(true);
    setResult(null);
    try {
      const next = await startFirstSetupWorkflow();
      setSetup(next.setup);
      setResult(`Starter workflow run created: ${next.run.id}`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Starter workflow failed");
    } finally {
      setBusy(false);
    }
  }

  const currentGuide = useMemo(
    () => providerSetup?.guides.find((guide) => guide.id === selectedGuide) || providerSetup?.guides[0] || null,
    [providerSetup, selectedGuide]
  );

  function chooseGuide(id: string) {
    const guide = providerSetup?.guides.find((item) => item.id === id);
    setSelectedGuide(id);
    setPreferredProvider(id);
    setProviderFields({});
    setProviderModel(guide?.modelDefault || "");
    setOllamaInventory(null);
  }

  function updateProviderField(key: string, value: string) {
    setProviderFields((current) => ({ ...current, [key]: value }));
  }

  async function saveProviderGuide() {
    if (!currentGuide) return;
    setBusy(true);
    setResult(null);
    try {
      await configureProviderSetup(currentGuide.id, {
        fields: providerFields,
        model: providerModel || undefined
      });
      await saveSetupState({ mode, preferredProvider: currentGuide.id, completed: false });
      setProviderFields({});
      await refresh();
      setResult(`${currentGuide.label} setup saved.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Provider setup save failed");
    } finally {
      setBusy(false);
    }
  }

  async function testCurrentProvider() {
    if (!currentGuide) return;
    setBusy(true);
    setResult(null);
    try {
      const output = await testProviderSetup(currentGuide.id);
      await refresh();
      setResult(output.ok ? `${currentGuide.label} test passed.` : `${currentGuide.label} still needs setup.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Provider setup test failed");
    } finally {
      setBusy(false);
    }
  }

  async function prepareCurrentModel() {
    if (!currentGuide) return;
    setBusy(true);
    setResult(null);
    try {
      const output = await prepareProviderModel(currentGuide.id, { model: providerModel || currentGuide.modelDefault || undefined });
      setResult(output.message);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Model helper failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleExecutionGate(enabled: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const output = await updateExecutionGate({
        enabled,
        reason: executionGateReason || (enabled ? "Enabled from setup dashboard." : "Disabled from setup dashboard.")
      });
      setExecutionGate(output);
      setExecutionGateReason("");
      setResult(output.publicSummary);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Execution gate update failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadOllamaInventory() {
    setBusy(true);
    setResult(null);
    try {
      const output = await getProviderModelInventory("ollama");
      setOllamaInventory(output);
      if (output.status === "connected") {
        setResult(`Ollama inventory loaded: ${output.modelCount} model${output.modelCount === 1 ? "" : "s"}.`);
      } else {
        setResult(output.publicSummary);
      }
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Ollama inventory failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <ShieldCheck size={16} />
            First-run setup
          </span>
          <h1>Prepare this Agent OS</h1>
          <p>Runtime, provider routing, public-mode safety, and the starter workflow are checked from the backend.</p>
        </div>

        <section className="setup-panel">
          <AdminSessionPanel session={session} onLogin={() => refresh().catch(() => undefined)} />
          <div className="setup-row execution-gate-row">
            <b>Trusted execution gate</b>
            <p>{executionGate?.publicSummary || "Loading execution gate state..."}</p>
            <div className="metric-row compact">
              <Metric label="Gate" value={executionGate?.enabled ? "enabled" : "disabled"} />
              <Metric label="Source" value={executionGate?.source || "loading"} />
              <Metric label="Default" value={executionGate?.dryRunDefault ? "dry-run" : "live allowed"} />
              <Metric label="Updated" value={executionGate?.updatedAt ? new Date(executionGate.updatedAt).toLocaleString() : "never"} />
            </div>
            <div className="config-grid">
              <label className="is-wide">
                <span>Change reason</span>
                <input
                  value={executionGateReason}
                  onChange={(event) => setExecutionGateReason(event.target.value)}
                  placeholder="Why live execution should be enabled or disabled on this machine"
                />
              </label>
            </div>
            <div className="button-row">
              <button className="wide-action" onClick={() => toggleExecutionGate(true)} disabled={busy || executionGate?.enabled}>
                {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                Enable trusted execution
              </button>
              <button className="wide-action" onClick={() => toggleExecutionGate(false)} disabled={busy || !executionGate?.enabled || executionGate?.envLocked}>
                {busy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
                Return to dry-run
              </button>
            </div>
            {executionGate?.envLocked ? (
              <div className="test-result">Environment lock is active. Remove `HERMES_AGENT_OS_ENABLE_EXEC=1` and restart the server to force dry-run mode.</div>
            ) : null}
          </div>
          <div className="setup-row">
            <b>Install mode</b>
            <div className="segmented-row">
              {["local", "vps", "docker"].map((item) => (
                <button className={mode === item ? "segment active" : "segment"} key={item} onClick={() => setMode(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="setup-row">
            <b>Preferred provider</b>
            <div className="config-grid">
              <label>
                <span>Provider</span>
                <select value={selectedGuide} onChange={(event) => chooseGuide(event.target.value)}>
                  {providerSetup?.guides.map((guide) => (
                    <option value={guide.id} key={guide.id}>{guide.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="wide-action" onClick={() => save(false)} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
              Save setup
            </button>
          </div>
          <div className="setup-row">
            <b>Guided provider setup</b>
            {currentGuide ? (
              <>
                <p>{currentGuide.publicSummary}</p>
                <div className="config-grid">
                  {currentGuide.fields.map((field) => (
                    <label key={field.key} className={currentGuide.fields.length === 1 ? "is-wide" : ""}>
                      <span>{field.label}{field.required ? " *" : ""}</span>
                      <input
                        type={field.secret ? "password" : "text"}
                        value={providerFields[field.key] || ""}
                        onChange={(event) => updateProviderField(field.key, event.target.value)}
                        placeholder={currentGuide.configuredFields.includes(field.key) ? "configured" : field.placeholder}
                      />
                    </label>
                  ))}
                  {currentGuide.routerProvider ? (
                    <label className="is-wide">
                      <span>Default model</span>
                      <input value={providerModel || currentGuide.modelDefault || ""} onChange={(event) => setProviderModel(event.target.value)} />
                    </label>
                  ) : null}
                </div>
                <div className="button-row">
                  <button className="wide-action" onClick={saveProviderGuide} disabled={busy}>
                    {busy ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
                    Save provider
                  </button>
                  <button className="wide-action" onClick={testCurrentProvider} disabled={busy}>
                    Test provider
                  </button>
                  {currentGuide.helper ? (
                    <button className="wide-action" onClick={prepareCurrentModel} disabled={busy}>
                      Prepare model pull
                    </button>
                  ) : null}
                  {currentGuide.id === "ollama" ? (
                    <button className="wide-action" onClick={loadOllamaInventory} disabled={busy}>
                      Load model inventory
                    </button>
                  ) : null}
                </div>
                {currentGuide.id === "ollama" && ollamaInventory ? (
                  <div className="local-list">
                    <article className="local-item">
                      <strong>Ollama inventory</strong>
                      <span>{statusLabel(ollamaInventory.status)} / {ollamaInventory.modelCount} models / {ollamaInventory.totalSizeGb} GB</span>
                      <p>{ollamaInventory.publicSummary}</p>
                      <p>Default model: {ollamaInventory.modelDefault} / Installed: {ollamaInventory.selectedModelAvailable ? "yes" : "no"}</p>
                    </article>
                    {ollamaInventory.models.slice(0, 8).map((model) => (
                      <article className="local-item" key={model.name}>
                        <strong>{model.name}</strong>
                        <span>{model.sizeLabel} / {model.details.parameterSize || "unknown size"} / {model.details.quantizationLevel || "unknown quant"}</span>
                        <p>{[model.details.family, model.details.format, model.modifiedAt].filter(Boolean).join(" / ")}</p>
                      </article>
                    ))}
                  </div>
                ) : null}
                <div className="test-result">
                  <b>{statusLabel(currentGuide.status)}</b>
                  <p>{currentGuide.missing.length ? `Missing: ${currentGuide.missing.join(", ")}` : "Required fields are configured."}</p>
                </div>
              </>
            ) : <p>Provider guides are loading.</p>}
          </div>
          <div className="setup-row">
            <b>Readiness</b>
            <div className="checklist">
              {setup?.steps.map((stepItem) => (
                <button className="check-row" key={stepItem.id} onClick={() => stepItem.target ? onOpenTarget(stepItem.target) : undefined}>
                  <span className={stepItem.done ? "check-dot done" : "check-dot"} />
                  <div>
                    <b>{stepItem.label}</b>
                    <small>{stepItem.detail}</small>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="setup-row">
            <b>Starter workflow</b>
            <p>{setup?.firstWorkflowRunId ? `Last starter run: ${setup.firstWorkflowRunId}` : "Run the clean blank workflow once to prove local workflow storage and run history."}</p>
            <button className="wide-action" onClick={startWorkflow} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Workflow size={18} />}
              Start first workflow
            </button>
            <button className="wide-action" onClick={() => save(true)} disabled={busy || !setup?.canComplete}>
              {busy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
              Mark setup complete
            </button>
            {result ? <div className="test-result">{result}</div> : null}
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Setup state</h3>
        <Metric label="Mode" value={setup?.mode || mode} />
        <Metric label="Provider" value={setup?.preferredProvider || preferredProvider} />
        <Metric label="Complete" value={setup?.completed ? "yes" : "not yet"} />
        <Metric label="Can complete" value={setup?.canComplete ? "yes" : "waiting"} />
        <Metric label="Provider guides" value={`${providerSetup?.summary.configured || 0}/${providerSetup?.summary.total || 0}`} />
        <Metric label="Workflows" value={String(setup?.workflows.length || 0)} />
      </aside>
    </main>
  );
}

function RouterProviderRow({ provider }: { provider: RouterProviderStatus }) {
  return (
    <article className="audit-row">
      <div>
        <b>{provider.label}</b>
        <span className={statusClass(provider.status)}>{statusLabel(provider.status)}</span>
        <p>{provider.publicSummary}</p>
      </div>
      <small>{provider.model}</small>
    </article>
  );
}

function ProviderRouterPage({ onOpenPlugins }: { onOpenPlugins: () => void }) {
  const [router, setRouter] = useState<ProviderRouterStatus | null>(null);
  const [providerSetup, setProviderSetup] = useState<ProviderSetupState | null>(null);
  const [health, setHealth] = useState<ProviderHealthState | null>(null);
  const [inventory, setInventory] = useState<ProviderModelInventory | null>(null);
  const [ollamaDoctor, setOllamaDoctor] = useState<ProviderLocalDoctor | null>(null);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("");
  const [setupProvider, setSetupProvider] = useState("ollama");
  const [setupFields, setSetupFields] = useState<Record<string, string>>({});
  const [setupModel, setSetupModel] = useState("");
  const [fallbackOrder, setFallbackOrder] = useState("");
  const [runResult, setRunResult] = useState<RouterRunResult | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [status, setup] = await Promise.all([getRouterStatus(), getProviderSetupState()]);
    setRouter(status);
    setProviderSetup(setup);
    setFallbackOrder(status.fallbackOrder.join(", "));
    if (!provider && status.nextProvider?.id) setProvider(status.nextProvider.id);
    setSetupProvider((current) => setup.guides.some((guide) => guide.id === current) ? current : setup.guides[0]?.id || "ollama");
  }

  useEffect(() => {
    refresh().catch((err) => setResult(err instanceof Error ? err.message : "Unable to load router"));
  }, []);

  async function saveRouter() {
    setBusy(true);
    setResult(null);
    try {
      const next = await configureRouter({
        fallbackOrder: fallbackOrder.split(",").map((item) => item.trim()).filter(Boolean)
      });
      setRouter(next);
      setResult("Fallback order saved.");
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Router save failed");
    } finally {
      setBusy(false);
    }
  }

  async function runDry() {
    if (!prompt.trim()) return;
    setBusy(true);
    setRunResult(null);
    setResult(null);
    try {
      const output = await runProviderRouter({ prompt, provider: provider || undefined, dryRun: true });
      setRunResult(output);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Router run failed");
    } finally {
      setBusy(false);
    }
  }

  async function checkHealth(selectedOnly = false) {
    setBusy(true);
    setResult(null);
    try {
      const output = await getRouterHealth(selectedOnly ? provider || undefined : undefined);
      setHealth(output);
      setResult(`Checked ${output.summary.total} provider${output.summary.total === 1 ? "" : "s"}: ${output.summary.healthy} healthy, ${output.summary.setup} setup, ${output.summary.error} error.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Provider health check failed");
    } finally {
      setBusy(false);
    }
  }

  const currentGuide = useMemo(
    () => providerSetup?.guides.find((guide) => guide.id === setupProvider) || providerSetup?.guides[0] || null,
    [providerSetup, setupProvider]
  );

  function chooseSetupProvider(id: string) {
    const guide = providerSetup?.guides.find((item) => item.id === id);
    setSetupProvider(id);
    setSetupFields({});
    setSetupModel(guide?.modelDefault || "");
    setInventory(null);
    if (guide?.routerProvider) setProvider(guide.routerProvider);
  }

  function updateSetupField(key: string, value: string) {
    setSetupFields((current) => ({ ...current, [key]: value }));
  }

  async function saveProviderSetupFromRouter() {
    if (!currentGuide) return;
    setBusy(true);
    setResult(null);
    try {
      await configureProviderSetup(currentGuide.id, {
        fields: setupFields,
        model: setupModel || undefined
      });
      setSetupFields({});
      await refresh();
      setResult(`${currentGuide.label} setup saved.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Provider setup save failed");
    } finally {
      setBusy(false);
    }
  }

  async function testProviderSetupFromRouter() {
    if (!currentGuide) return;
    setBusy(true);
    setResult(null);
    try {
      const output = await testProviderSetup(currentGuide.id);
      await refresh();
      setResult(output.ok ? `${currentGuide.label} test passed.` : `${currentGuide.label} still needs setup.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Provider setup test failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadProviderInventoryFromRouter() {
    if (!currentGuide?.routerProvider) return;
    setBusy(true);
    setResult(null);
    try {
      const output = await getProviderModelInventory(currentGuide.id);
      setInventory(output);
      setSetupModel(output.modelDefault || output.models[0]?.name || setupModel);
      setResult(output.publicSummary);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Model inventory failed");
    } finally {
      setBusy(false);
    }
  }

  async function prepareOllamaFromRouter() {
    if (!currentGuide) return;
    setBusy(true);
    setResult(null);
    try {
      const output = await prepareProviderModel(currentGuide.id, { model: setupModel || currentGuide.modelDefault || undefined });
      setResult(output.message);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Model helper failed");
    } finally {
      setBusy(false);
    }
  }

	  async function diagnoseOllamaFromRouter() {
	    setBusy(true);
	    setResult(null);
	    try {
	      const output = await getOllamaDoctor();
	      setOllamaDoctor(output);
	      setResult(output.nextAction);
	    } catch (err) {
	      setResult(err instanceof Error ? err.message : "Ollama doctor failed");
	    } finally {
	      setBusy(false);
	    }
	  }

	  async function saveOllamaDoctorHost() {
	    if (!ollamaDoctor?.host) return;
	    setBusy(true);
	    setResult(null);
	    try {
	      await configureProviderSetup("ollama", {
	        fields: { OLLAMA_HOST: ollamaDoctor.host },
	        model: setupModel || ollamaDoctor.model || currentGuide?.modelDefault || undefined
	      });
	      setSetupFields({});
	      await refresh();
	      const nextDoctor = await getOllamaDoctor();
	      setOllamaDoctor(nextDoctor);
	      setResult(`Saved OLLAMA_HOST=${ollamaDoctor.host}. ${nextDoctor.nextAction}`);
	    } catch (err) {
	      setResult(err instanceof Error ? err.message : "Saving Ollama host failed");
	    } finally {
	      setBusy(false);
	    }
	  }

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <Cable size={16} />
            Provider Router
          </span>
          <h1>One dispatch lane for models</h1>
          <p>Routes prompts through configured user-owned providers with a safe dry-run default.</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Fallback order</b>
            <div className="config-grid">
              <label className="is-wide">
                <span>Providers</span>
                <input value={fallbackOrder} onChange={(event) => setFallbackOrder(event.target.value)} placeholder="ollama, openrouter, minimax" />
              </label>
            </div>
            <button className="wide-action" onClick={saveRouter} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
              Save fallback order
            </button>
          </div>
          <div className="setup-row">
            <b>Dry dispatch</b>
            <div className="config-grid">
              <label>
                <span>Provider</span>
                <input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder={router?.nextProvider?.id || "auto"} />
              </label>
              <label className="is-wide">
                <span>Prompt</span>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Test the router without spending credits" />
              </label>
            </div>
            <button className="wide-action" onClick={runDry} disabled={busy || !prompt.trim()}>
              {busy ? <Loader2 className="spin" size={18} /> : <MessageSquare size={18} />}
              Dry run router
            </button>
            {runResult ? (
              <div className="test-result">
                <b>{runResult.mode}</b>
                <p>{runResult.message}</p>
              </div>
            ) : null}
            {runResult?.plannedRequest ? <ProviderCallPlan plan={runResult.plannedRequest} /> : null}
            {result ? <div className="test-result">{result}</div> : null}
          </div>
          <div className="setup-row">
            <b>Connect provider</b>
            <div className="config-grid">
              <label>
                <span>Provider</span>
                <select value={setupProvider} onChange={(event) => chooseSetupProvider(event.target.value)}>
                  {(providerSetup?.guides || []).filter((guide) => guide.routerProvider).map((guide) => (
                    <option key={guide.id} value={guide.id}>{guide.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Model</span>
                <input value={setupModel} onChange={(event) => setSetupModel(event.target.value)} placeholder={currentGuide?.modelDefault || "model"} />
              </label>
              {currentGuide?.fields.map((field) => (
                <label className={field.secret ? "" : "is-wide"} key={field.key}>
                  <span>{field.label}{field.required ? " *" : ""}</span>
                  <input
                    type={field.secret ? "password" : "text"}
                    value={setupFields[field.key] || ""}
                    onChange={(event) => updateSetupField(field.key, event.target.value)}
                    placeholder={currentGuide.configuredFields.includes(field.key) ? "configured" : field.placeholder}
                  />
                  <small>{field.help}</small>
                </label>
              ))}
            </div>
            <div className="button-row">
              <button className="wide-action" onClick={saveProviderSetupFromRouter} disabled={busy || !currentGuide}>
                {busy ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
                Save provider
              </button>
              <button className="wide-action" onClick={testProviderSetupFromRouter} disabled={busy || !currentGuide}>
                Test provider
              </button>
              <button className="wide-action" onClick={loadProviderInventoryFromRouter} disabled={busy || !currentGuide?.routerProvider}>
                Load models
              </button>
              {currentGuide?.id === "ollama" ? (
                <>
                  <button className="wide-action" onClick={diagnoseOllamaFromRouter} disabled={busy}>
                    Diagnose Ollama
                  </button>
                  <button className="wide-action" onClick={prepareOllamaFromRouter} disabled={busy}>
                    Prepare model pull
                  </button>
                </>
              ) : null}
            </div>
            {currentGuide ? (
              <div className="test-result">
                <b>{currentGuide.label}: {statusLabel(currentGuide.status)}</b>
                <p>{currentGuide.configured ? "Required fields are configured." : `Missing ${currentGuide.missing.join(", ") || "required fields"}.`}</p>
              </div>
            ) : null}
            {inventory ? (
              <div className="test-result">
                <b>{inventory.provider}: {statusLabel(inventory.status)}</b>
                <p>{inventory.publicSummary}</p>
                <small>{inventory.modelCount} model{inventory.modelCount === 1 ? "" : "s"} / selected {inventory.selectedModelAvailable ? "available" : "not confirmed"}</small>
              </div>
            ) : null}
            {ollamaDoctor && currentGuide?.id === "ollama" ? (
              <div className="provider-doctor">
                <div className="proof-header">
                  <b>Ollama bootstrap doctor</b>
                  <span className={statusClass(ollamaDoctor.status)}>{statusLabel(ollamaDoctor.status)}</span>
                </div>
                <p>{ollamaDoctor.publicSummary}</p>
                <div className="doctor-grid">
                  {ollamaDoctor.checks.map((check) => (
                    <article key={check.id}>
                      <b>{check.label}</b>
                      <span className={statusClass(check.status)}>{statusLabel(check.status)}</span>
                      <small>{check.detail}</small>
                    </article>
                  ))}
                </div>
	                <div className="command-stack">
	                  <b>Next action</b>
	                  <code>{ollamaDoctor.nextAction}</code>
	                  {ollamaDoctor.commands.map((command) => <code key={command}>{command}</code>)}
	                </div>
	                <button className="wide-action" onClick={saveOllamaDoctorHost} disabled={busy || !ollamaDoctor.host}>
	                  Save default Ollama host
	                </button>
	              </div>
	            ) : null}
          </div>
          <div className="setup-row">
            <b>Providers</b>
            <div className="audit-list">
              {router?.providers.map((item) => <RouterProviderRow provider={item} key={item.id} />)}
            </div>
            <div className="button-row">
              <button className="wide-action" onClick={() => checkHealth(false)} disabled={busy}>
                {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                Check all health
              </button>
              <button className="wide-action" onClick={() => checkHealth(true)} disabled={busy || !provider.trim()}>
                Check selected
              </button>
            </div>
          </div>
          <div className="setup-row">
            <b>Health results</b>
            <div className="audit-list">
              {health?.checks.length ? health.checks.map((check) => (
                <article className="audit-row" key={check.id}>
                  <div>
                    <b>{check.label}</b>
                    <span className={statusClass(check.status)}>{statusLabel(check.status)}</span>
                    <p>{check.message}</p>
                  </div>
	                  <small>{[
	                    check.httpStatus ? `HTTP ${check.httpStatus}` : "",
	                    `${check.latencyMs}ms`,
	                    check.modelCount != null ? `${check.modelCount} models` : "",
	                    check.selectedModel ? `${check.selectedModel} ${check.selectedModelAvailable ? "available" : "missing"}` : ""
	                  ].filter(Boolean).join(" / ") || check.endpoint}</small>
                </article>
              )) : <p>No health checks run yet.</p>}
            </div>
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Router status</h3>
        <Metric label="Status" value={statusLabel(router?.status || "loading")} />
        <Metric label="Next" value={router?.nextProvider?.label || "none"} />
        <Metric label="Dry run" value={router?.dryRunDefault ? "default" : "exec enabled"} />
        <Metric label="Configured" value={String(router?.providers.filter((item) => item.configured).length || 0)} />
        <Metric label="Healthy" value={health ? String(health.summary.healthy) : "not checked"} />
        <Metric label="Needs setup" value={health ? String(health.summary.setup) : "not checked"} />
        <button className="wide-action" onClick={onOpenPlugins}>
          Open provider cards
        </button>
      </aside>
    </main>
  );
}

function SchedulerJobRow({
  job,
  focused,
  onRun,
  onPause,
  onResume,
  onApprove,
  onReject
}: {
  job: SchedulerJob;
  focused?: boolean;
  onRun: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const status = job.pendingApproval ? "waiting_approval" : job.paused ? "disabled" : job.lastStatus || "connected";
  return (
    <article className={focused ? "audit-row is-focused" : "audit-row"}>
      <div>
        <b>{job.label}</b>
        <span className={statusClass(status)}>
          {job.pendingApproval ? "Waiting approval" : job.paused ? "Paused" : job.lastStatus || "Scheduled"}
        </span>
        <p>
          {job.targetType} / {job.targetId} / {job.action || "run"} / every {job.intervalMinutes} min / next {new Date(job.nextRunAt).toLocaleString()}
        </p>
        {job.requiresApproval ? <small>Approval gate enabled{job.approvalRequestedAt ? ` / requested ${new Date(job.approvalRequestedAt).toLocaleString()}` : ""}</small> : null}
      </div>
      <div className="row-actions">
        <button onClick={() => onRun(job.id)}>Run</button>
        {job.pendingApproval ? (
          <>
            <button onClick={() => onApprove(job.id)}>Approve</button>
            <button onClick={() => onReject(job.id)}>Reject</button>
          </>
        ) : null}
        {job.paused ? <button onClick={() => onResume(job.id)}>Resume</button> : <button onClick={() => onPause(job.id)}>Pause</button>}
      </div>
    </article>
  );
}

function SchedulerPage({ focusId }: { focusId?: string | null }) {
  const [scheduler, setScheduler] = useState<SchedulerState | null>(null);
  const [label, setLabel] = useState("Scheduled workflow");
  const [targetType, setTargetType] = useState("workflow");
  const [targetId, setTargetId] = useState("blank-open-agent-builder");
  const [action, setAction] = useState("run");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState("15");
  const [retryDelaySeconds, setRetryDelaySeconds] = useState("60");
  const [maxRetries, setMaxRetries] = useState("3");
  const [payloadText, setPayloadText] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const data = await getSchedulerState();
    setScheduler(data);
    if (!targetId) {
      setTargetId(data.targets.workflows[0]?.id || data.targets.selfModules[0]?.id || "");
    }
  }

  useEffect(() => {
    refresh().catch((err) => setResult(err instanceof Error ? err.message : "Unable to load scheduler"));
  }, []);

  function selectedTargets() {
    if (targetType === "self_module") return scheduler?.targets.selfModules || [];
    return scheduler?.targets.workflows || [];
  }

  const actionOptions = useMemo(() => {
    if (targetType !== "self_module") return ["run"];
    return scheduler?.targets.selfModules.find((target) => target.id === targetId)?.actions || ["create_item"];
  }, [scheduler, targetId, targetType]);

  useEffect(() => {
    const targets = selectedTargets();
    if (targets.length && !targets.find((target) => target.id === targetId)) {
      setTargetId(targets[0].id);
    }
  }, [scheduler, targetId, targetType]);

  useEffect(() => {
    if (!actionOptions.includes(action)) setAction(actionOptions[0] || "run");
  }, [action, actionOptions]);

  async function createJob() {
    setBusy(true);
    setResult(null);
    try {
      let payload: Record<string, unknown> = {};
      if (payloadText.trim()) payload = JSON.parse(payloadText);
      const job = await saveSchedulerJob({
        label,
        targetType,
        targetId,
        action,
        intervalMinutes: Number(intervalMinutes || 15),
        retryDelaySeconds: Number(retryDelaySeconds || 60),
        maxRetries: Number(maxRetries || 3),
        requiresApproval,
        payload,
        nextRunAt: new Date().toISOString()
      });
      setResult(`Scheduler job saved: ${job.id}`);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Scheduler job save failed");
    } finally {
      setBusy(false);
    }
  }

  async function runJob(id: string) {
    setBusy(true);
    setResult(null);
    try {
      const output = await runSchedulerJob(id);
      setResult(`${output.job.label}: ${output.history.status}`);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Scheduler run failed");
    } finally {
      setBusy(false);
    }
  }

  async function pauseJob(id: string) {
    await pauseSchedulerJob(id);
    await refresh();
  }

  async function resumeJob(id: string) {
    await resumeSchedulerJob(id);
    await refresh();
  }

  async function approveJob(id: string) {
    await approveSchedulerJob(id, "Approved from Hermes scheduler.");
    await refresh();
  }

  async function rejectJob(id: string) {
    await rejectSchedulerJob(id, "Rejected from Hermes scheduler.");
    await refresh();
  }

  async function tick() {
    setBusy(true);
    setResult(null);
    try {
      const output = await runSchedulerTick();
      setResult(output.skipped
        ? `Scheduler tick skipped: ${output.reason || "leader lock held"}.`
        : `Scheduler tick checked ${output.due} due job${output.due === 1 ? "" : "s"}.`);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Scheduler tick failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <Clock size={16} />
            Scheduler
          </span>
          <h1>Run OS work on a clock</h1>
          <p>Schedule workflows and local module tasks with retry, pause/resume, run history, and a VPS-safe leader lock.</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Create job</b>
            <div className="config-grid">
              <label>
                <span>Label</span>
                <input value={label} onChange={(event) => setLabel(event.target.value)} />
              </label>
              <label>
                <span>Target type</span>
                <select value={targetType} onChange={(event) => setTargetType(event.target.value)}>
                  <option value="workflow">workflow</option>
                  <option value="self_module">self_module</option>
                </select>
              </label>
              <label>
                <span>Target</span>
                <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                  {selectedTargets().map((target) => (
                    <option value={target.id} key={target.id}>{target.id}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Action</span>
                <select value={action} onChange={(event) => setAction(event.target.value)}>
                  {actionOptions.map((item) => (
                    <option value={item} key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Interval minutes</span>
                <input value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} inputMode="numeric" />
              </label>
              <label>
                <span>Retry delay seconds</span>
                <input value={retryDelaySeconds} onChange={(event) => setRetryDelaySeconds(event.target.value)} inputMode="numeric" />
              </label>
              <label>
                <span>Max retries</span>
                <input value={maxRetries} onChange={(event) => setMaxRetries(event.target.value)} inputMode="numeric" />
              </label>
              <label className="inline-check">
                <input type="checkbox" checked={requiresApproval} onChange={(event) => setRequiresApproval(event.target.checked)} />
                <span>Require approval before scheduled runs</span>
              </label>
              <label className="is-wide">
                <span>Payload JSON</span>
                <textarea value={payloadText} onChange={(event) => setPayloadText(event.target.value)} />
              </label>
            </div>
            <button className="wide-action" onClick={createJob} disabled={busy || !targetId.trim()}>
              {busy ? <Loader2 className="spin" size={18} /> : <Clock size={18} />}
              Save scheduled job
            </button>
          </div>

          <div className="setup-row">
            <b>Jobs</b>
            <div className="audit-list">
              {scheduler?.jobs.length ? scheduler.jobs.map((job) => (
                <SchedulerJobRow
                  job={job}
                  key={job.id}
                  focused={job.id === focusId}
                  onRun={runJob}
                  onPause={pauseJob}
                  onResume={resumeJob}
                  onApprove={approveJob}
                  onReject={rejectJob}
                />
              )) : <p>No scheduler jobs yet.</p>}
            </div>
            <button className="wide-action" onClick={tick} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Activity size={18} />}
              Tick due jobs
            </button>
            {result ? <div className="test-result">{result}</div> : null}
          </div>

          <div className="setup-row">
            <b>Recent run history</b>
            <div className="audit-list">
              {scheduler?.history?.length ? scheduler.history.slice(0, 10).map((item) => (
                <article className="audit-row" key={item.id}>
                  <div>
                    <b>{item.jobId}</b>
                    <span className={statusClass(item.status)}>{statusLabel(item.status)}</span>
                    <p>
                      {item.targetType} / {item.targetId} / {item.action} / {item.manual ? "manual" : "scheduled"} / attempt {item.attempt}
                    </p>
                    {item.message ? <small>{item.message}</small> : null}
                  </div>
                  <small>{item.finishedAt ? new Date(item.finishedAt).toLocaleString() : new Date(item.startedAt).toLocaleString()}</small>
                </article>
              )) : <p>No scheduler run history yet. Run a job or tick due jobs to create proof.</p>}
            </div>
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Scheduler status</h3>
        <Metric label="Status" value={scheduler?.status || "loading"} />
        <Metric label="Poll" value={`${scheduler?.pollMs || 0} ms`} />
        <Metric label="Leader lock" value={scheduler?.lock?.enabled ? "enabled" : "disabled"} />
        <Metric
          label="Lock state"
          value={scheduler?.lock?.heldByThisProcess
            ? "this process"
            : scheduler?.lock?.heldByAnotherProcess
              ? "another process"
              : scheduler?.lock?.stale
                ? "stale"
                : "free"}
        />
        <Metric label="Lock TTL" value={`${scheduler?.lock?.ttlMs || 0} ms`} />
        <Metric label="Jobs" value={String(scheduler?.summary.total || 0)} />
        <Metric label="Due" value={String(scheduler?.summary.due || 0)} />
        <Metric label="Pending approval" value={String(scheduler?.summary.pendingApproval || 0)} />
        <Metric label="Paused" value={String(scheduler?.summary.paused || 0)} />
        <Metric label="Failed" value={String(scheduler?.summary.failed || 0)} />
        <div className="setup-note">
          <b>Lock file</b>
          <code>{scheduler?.lock?.lockFile || "~/.hermes-agent-os/runs/scheduler/scheduler.lock.json"}</code>
        </div>
      </aside>
    </main>
  );
}

function MemoryPage({ focusId }: { focusId?: string | null }) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [searchResult, setSearchResult] = useState<MemorySearchResult | null>(null);
  const [form, setForm] = useState({
    title: "",
    type: "semantic",
    agentId: "global",
    namespace: "default",
    privacy: "private",
    importance: "0.5",
    tags: "",
    content: ""
  });
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState("hybrid");
  const [filterType, setFilterType] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [vectorProvider, setVectorProvider] = useState("local-hash");
  const [vectorEmbeddingProvider, setVectorEmbeddingProvider] = useState("local-hash");
  const [vectorModel, setVectorModel] = useState("local-hash-v1");
  const [vectorDimensions, setVectorDimensions] = useState("96");
  const [vectorEndpoint, setVectorEndpoint] = useState("");
  const [vectorCollection, setVectorCollection] = useState("hermes_memory");
  const [vectorApiKey, setVectorApiKey] = useState("");
  const [vectorEnabled, setVectorEnabled] = useState(true);
  const [importText, setImportText] = useState("");
  const [exportText, setExportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function refresh() {
    const data = await getMemoryState();
    setState(data);
    setVectorProvider(data.vector.provider);
    setVectorEmbeddingProvider(data.vector.embedding?.provider || (data.vector.provider === "qdrant" ? "local-hash" : data.vector.provider));
    setVectorModel(data.vector.model);
    setVectorDimensions(String(data.vector.dimensions || 96));
    setVectorEndpoint(data.vector.remote?.endpoint || "");
    setVectorCollection(data.vector.remote?.collection || "hermes_memory");
    setVectorApiKey("");
    setVectorEnabled(data.vector.enabled);
  }

  useEffect(() => {
    refresh().catch((err) => setResult(err instanceof Error ? err.message : "Unable to load memory"));
  }, []);

  function updateForm(field: string, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveMemory() {
    setBusy(true);
    setResult(null);
    try {
      const payload = {
        ...form,
        importance: Number(form.importance || 0.5),
        tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      };
      const output = await addMemory(payload);
      setState(output.state);
      setForm((current) => ({ ...current, title: "", tags: "", content: "" }));
      setResult(`Saved memory ${output.memory.id}.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Memory save failed");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    setBusy(true);
    setResult(null);
    try {
      const output = await searchMemory({
        query,
        mode: searchMode,
        type: filterType,
        agentId: filterAgent,
        limit: 12
      });
      setSearchResult(output);
      setResult(`Found ${output.count} memor${output.count === 1 ? "y" : "ies"} with ${output.mode} search.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Memory search failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveVectorConfig() {
    setBusy(true);
    setResult(null);
    try {
      const output = await configureMemoryVector({
        enabled: vectorEnabled,
        provider: vectorProvider,
        embeddingProvider: vectorEmbeddingProvider,
        model: vectorModel,
        dimensions: Number(vectorDimensions || 96),
        endpoint: vectorEndpoint,
        collection: vectorCollection,
        apiKey: vectorApiKey || undefined
      });
      setState(output);
      setSearchResult(null);
      setResult(`Memory vector config saved: ${output.vector.provider} / ${output.vector.status}.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Vector config save failed");
    } finally {
      setBusy(false);
    }
  }

  async function rebuildVectors() {
    setBusy(true);
    setResult(null);
    try {
      const output = await rebuildMemoryVectorIndex(true);
      await refresh();
      setSearchResult(null);
      setResult(output.ok
        ? `Vector index rebuilt: ${output.indexed || 0} indexed, ${output.reused || 0} reused.`
        : output.message || "Vector index is not configured.");
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Vector rebuild failed");
    } finally {
      setBusy(false);
    }
  }

  async function exportSafeMemory() {
    setBusy(true);
    setResult(null);
    try {
      const output = await exportMemory({ includePrivate: false, includeArchived: false });
      setExportText(JSON.stringify(output, null, 2));
      setResult(`Export prepared with ${output.memories.length} non-private memor${output.memories.length === 1 ? "y" : "ies"}.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Memory export failed");
    } finally {
      setBusy(false);
    }
  }

  async function importFromText() {
    setBusy(true);
    setResult(null);
    try {
      const payload = JSON.parse(importText);
      const output = await importMemory({ memories: Array.isArray(payload) ? payload : payload.memories || [] });
      setState(output.state);
      setResult(`Imported ${output.imported}; skipped ${output.skipped}.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Memory import failed");
    } finally {
      setBusy(false);
    }
  }

  async function patchMemory(id: string, patch: Record<string, unknown>) {
    const output = await updateMemory(id, patch);
    setState(output.state);
  }

  const visibleMemories = useMemo(() => {
    const base = searchResult?.results || state?.memories.slice(0, 12) || [];
    if (!focusId || base.some((memory) => memory.id === focusId)) return base;
    const focused = state?.memories.find((memory) => memory.id === focusId);
    return focused ? [focused, ...base].slice(0, 12) : base;
  }, [focusId, searchResult, state]);

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <DatabaseZap size={16} />
            Memory
          </span>
          <h1>Agent memory</h1>
          <p>Store semantic facts, episodic run history, and procedural playbooks with per-agent scopes and export-safe privacy controls.</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Create memory</b>
            <div className="config-grid">
              <label>
                <span>Title</span>
                <input value={form.title} onChange={(event) => updateForm("title", event.target.value)} />
              </label>
              <label>
                <span>Type</span>
                <select value={form.type} onChange={(event) => updateForm("type", event.target.value)}>
                  <option value="semantic">Semantic</option>
                  <option value="episodic">Episodic</option>
                  <option value="procedural">Procedural</option>
                </select>
              </label>
              <label>
                <span>Agent</span>
                <input value={form.agentId} onChange={(event) => updateForm("agentId", event.target.value)} />
              </label>
              <label>
                <span>Namespace</span>
                <input value={form.namespace} onChange={(event) => updateForm("namespace", event.target.value)} />
              </label>
              <label>
                <span>Privacy</span>
                <select value={form.privacy} onChange={(event) => updateForm("privacy", event.target.value)}>
                  <option value="private">Private</option>
                  <option value="shared">Shared</option>
                  <option value="exportable">Exportable</option>
                </select>
              </label>
              <label>
                <span>Importance</span>
                <input value={form.importance} onChange={(event) => updateForm("importance", event.target.value)} inputMode="decimal" />
              </label>
              <label className="is-wide">
                <span>Tags</span>
                <input value={form.tags} onChange={(event) => updateForm("tags", event.target.value)} placeholder="routing, setup, customer" />
              </label>
              <label className="is-wide">
                <span>Content</span>
                <textarea value={form.content} onChange={(event) => updateForm("content", event.target.value)} />
              </label>
            </div>
            <button className="wide-action" onClick={saveMemory} disabled={busy || !form.content.trim()}>
              {busy ? <Loader2 className="spin" size={18} /> : <DatabaseZap size={18} />}
              Save memory
            </button>
          </div>

          <div className="setup-row">
            <b>Retrieve memory</b>
            <div className="config-grid">
              <label>
                <span>Search</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="what should the agent remember?" />
              </label>
              <label>
                <span>Mode</span>
                <select value={searchMode} onChange={(event) => setSearchMode(event.target.value)}>
                  <option value="hybrid">Hybrid</option>
                  <option value="vector">Vector</option>
                  <option value="lexical">Lexical</option>
                </select>
              </label>
              <label>
                <span>Type filter</span>
                <select value={filterType} onChange={(event) => setFilterType(event.target.value)}>
                  <option value="">Any</option>
                  <option value="semantic">Semantic</option>
                  <option value="episodic">Episodic</option>
                  <option value="procedural">Procedural</option>
                </select>
              </label>
              <label>
                <span>Agent filter</span>
                <input value={filterAgent} onChange={(event) => setFilterAgent(event.target.value)} placeholder="global" />
              </label>
            </div>
            <button className="wide-action" onClick={runSearch} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
              Search memory
            </button>
          </div>

          <div className="setup-row">
            <b>Vector memory</b>
            <p>Local hash vectors work without keys. Ollama/OpenAI embeddings and Qdrant remote memory stay ready-to-configure until their provider settings are connected.</p>
            <div className="config-grid">
              <label>
                <span>Enabled</span>
                <select value={vectorEnabled ? "1" : "0"} onChange={(event) => setVectorEnabled(event.target.value === "1")}>
                  <option value="1">Enabled</option>
                  <option value="0">Disabled</option>
                </select>
              </label>
              <label>
                <span>Provider</span>
                <select value={vectorProvider} onChange={(event) => {
                  const provider = event.target.value;
                  setVectorProvider(provider);
                  const embeddingProvider = provider === "qdrant" ? "local-hash" : provider;
                  setVectorEmbeddingProvider(embeddingProvider);
                  setVectorModel(embeddingProvider === "ollama" ? "nomic-embed-text" : embeddingProvider === "openai" ? "text-embedding-3-small" : "local-hash-v1");
                }}>
                  <option value="local-hash">Local hash</option>
                  <option value="ollama">Ollama embeddings</option>
                  <option value="openai">OpenAI embeddings</option>
                  <option value="qdrant">Qdrant remote index</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              {vectorProvider === "qdrant" ? (
                <label>
                  <span>Embedding provider</span>
                  <select value={vectorEmbeddingProvider} onChange={(event) => {
                    const provider = event.target.value;
                    setVectorEmbeddingProvider(provider);
                    setVectorModel(provider === "ollama" ? "nomic-embed-text" : provider === "openai" ? "text-embedding-3-small" : "local-hash-v1");
                  }}>
                    <option value="local-hash">Local hash</option>
                    <option value="ollama">Ollama</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </label>
              ) : null}
              <label>
                <span>Model</span>
                <input value={vectorModel} onChange={(event) => setVectorModel(event.target.value)} />
              </label>
              <label>
                <span>Dimensions</span>
                <input value={vectorDimensions} onChange={(event) => setVectorDimensions(event.target.value)} inputMode="numeric" />
              </label>
              {vectorProvider === "qdrant" ? (
                <>
                  <label>
                    <span>Qdrant endpoint</span>
                    <input value={vectorEndpoint} onChange={(event) => setVectorEndpoint(event.target.value)} placeholder="http://localhost:6333" />
                  </label>
                  <label>
                    <span>Collection</span>
                    <input value={vectorCollection} onChange={(event) => setVectorCollection(event.target.value)} />
                  </label>
                  <label className="is-wide">
                    <span>API key</span>
                    <input value={vectorApiKey} onChange={(event) => setVectorApiKey(event.target.value)} placeholder={state?.vector.remote?.hasApiKey ? "configured; leave blank to keep" : "optional"} />
                  </label>
                </>
              ) : null}
            </div>
            <div className="button-row">
              <button className="wide-action" onClick={saveVectorConfig} disabled={busy}>
                Save vector config
              </button>
              <button className="wide-action" onClick={rebuildVectors} disabled={busy}>
                Rebuild vector index
              </button>
            </div>
            {state?.vector.missing.length ? <p>Missing: {state.vector.missing.join(", ")}</p> : null}
          </div>

          <div className="setup-row">
            <b>Memory records</b>
            <div className="local-list">
              {visibleMemories.length ? visibleMemories.map((memory) => (
                <article className={memory.id === focusId ? "local-item is-focused" : "local-item"} key={memory.id}>
                  <strong>{memory.title}</strong>
                  <span>{[memory.type, memory.agentId, memory.namespace, memory.privacy, memory.archived ? "archived" : ""].filter(Boolean).join(" / ")}</span>
                  {typeof memory.score === "number" ? <span>Score: {memory.score} / vector {memory.vectorScore || 0} / lexical {memory.lexicalScore || 0}</span> : null}
                  <p>{memory.content}</p>
                  <div className="mini-actions">
                    <select value={memory.privacy} onChange={(event) => patchMemory(memory.id, { privacy: event.target.value })}>
                      <option value="private">Private</option>
                      <option value="shared">Shared</option>
                      <option value="exportable">Exportable</option>
                    </select>
                    <button onClick={() => patchMemory(memory.id, { archived: !memory.archived })}>{memory.archived ? "Restore" : "Archive"}</button>
                  </div>
                </article>
              )) : <p>No memories stored yet.</p>}
            </div>
            {result ? <div className="test-result">{result}</div> : null}
          </div>

          <div className="setup-row">
            <b>Import / export</b>
            <div className="config-grid">
              <label className="is-wide">
                <span>Import JSON</span>
                <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder='{"memories":[...]}' />
              </label>
              <label className="is-wide">
                <span>Redacted export</span>
                <textarea value={exportText} onChange={(event) => setExportText(event.target.value)} />
              </label>
            </div>
            <div className="button-row">
              <button className="wide-action" onClick={importFromText} disabled={busy || !importText.trim()}>
                Import memory
              </button>
              <button className="wide-action" onClick={exportSafeMemory} disabled={busy}>
                Export safe memory
              </button>
            </div>
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Memory status</h3>
        <Metric label="Total" value={String(state?.summary.total || 0)} />
        <Metric label="Active" value={String(state?.summary.active || 0)} />
        <Metric label="Archived" value={String(state?.summary.archived || 0)} />
        <Metric label="Exportable" value={String(state?.summary.exportable || 0)} />
        <Metric label="Semantic" value={String(state?.summary.byType.semantic || 0)} />
        <Metric label="Episodic" value={String(state?.summary.byType.episodic || 0)} />
        <Metric label="Procedural" value={String(state?.summary.byType.procedural || 0)} />
        <Metric label="Vector" value={state?.vector.status || "loading"} />
        <Metric label="Provider" value={state?.vector.provider || "loading"} />
        <Metric label="Indexed" value={`${state?.vector.index.vectorCount || 0}/${state?.vector.index.memoryCount || 0}`} />
        <Metric label="Index stale" value={state?.vector.index.stale ? "yes" : "no"} />
        <Metric label="Updated" value={state?.updatedAt ? new Date(state.updatedAt).toLocaleString() : "not yet"} />
      </aside>
    </main>
  );
}

function SkillRegistryPage() {
  const [registry, setRegistry] = useState<SkillRegistryState | null>(null);
  const [marketplace, setMarketplace] = useState<SkillMarketplaceState | null>(null);
  const [publishers, setPublishers] = useState<SkillPublishersState | null>(null);
  const [fields, setFields] = useState<Record<string, Record<string, string>>>({});
  const [publisherDrafts, setPublisherDrafts] = useState<Record<string, { label: string; website: string; score: string; tier: string; notes: string }>>({});
  const [bundleText, setBundleText] = useState("");
  const [feedLabel, setFeedLabel] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function refresh() {
    const [registryData, marketplaceData, publisherData] = await Promise.all([
      getSkillRegistry(),
      getSkillMarketplace(),
      getSkillPublishers()
    ]);
    setRegistry(registryData);
    setMarketplace(marketplaceData);
    setPublishers(publisherData);
  }

  useEffect(() => {
    refresh().catch((err) => setResult(err instanceof Error ? err.message : "Unable to load skills"));
  }, []);

  function updateField(skillId: string, key: string, value: string) {
    setFields((current) => ({
      ...current,
      [skillId]: {
        ...(current[skillId] || {}),
        [key]: value
      }
    }));
  }

  function publisherDraft(publisher: SkillPublisher) {
    return publisherDrafts[publisher.fingerprint] || {
      label: publisher.label || "",
      website: publisher.website || "",
      score: publisher.reputation.score == null ? "" : String(publisher.reputation.score),
      tier: publisher.reputation.tier || "unknown",
      notes: publisher.reputation.notes || ""
    };
  }

  function updatePublisherDraft(fingerprint: string, key: "label" | "website" | "score" | "tier" | "notes", value: string) {
    const publisher = publishers?.publishers.find((item) => item.fingerprint === fingerprint);
    const base = {
      label: publisher?.label || "",
      website: publisher?.website || "",
      score: publisher?.reputation.score == null ? "" : String(publisher.reputation.score),
      tier: publisher?.reputation.tier || "unknown",
      notes: publisher?.reputation.notes || ""
    };
    setPublisherDrafts((current) => ({
      ...current,
      [fingerprint]: {
        ...base,
        ...current[fingerprint],
        [key]: value
      }
    }));
  }

  async function importBundle() {
    setBusyId("import");
    setResult(null);
    try {
      const payload = JSON.parse(bundleText);
      const imported = await importSkillBundle(payload);
      setResult(`Imported ${imported.skill?.label || "skill"} with ${imported.verification.algorithm} signature ${imported.verification.publicKeyFingerprint.slice(0, 12)}...`);
      setBundleText("");
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Skill bundle import failed");
    } finally {
      setBusyId(null);
    }
  }

  async function saveFeed() {
    setBusyId("feed-save");
    setResult(null);
    try {
      const next = await saveSkillMarketplaceFeed({ label: feedLabel, url: feedUrl });
      setMarketplace(next);
      setResult(`Saved marketplace feed${feedLabel.trim() ? ` ${feedLabel.trim()}` : ""}.`);
      setFeedLabel("");
      setFeedUrl("");
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Marketplace feed save failed");
    } finally {
      setBusyId(null);
    }
  }

  async function fetchFeed(feedId: string) {
    setBusyId(`feed-fetch-${feedId}`);
    setResult(null);
    try {
      const fetched = await fetchSkillMarketplaceFeed(feedId);
      setMarketplace(fetched.marketplace);
      setResult(`Fetched ${fetched.imported.length} signed skill${fetched.imported.length === 1 ? "" : "s"} from ${fetched.feed.label}; rejected ${fetched.rejected.length}.`);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Marketplace feed fetch failed");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleTrust(fingerprint: string, trusted: boolean) {
    setBusyId(`trust-${fingerprint}`);
    setResult(null);
    try {
      const next = trusted
        ? await untrustSkillPublisher(fingerprint)
        : await trustSkillPublisher(fingerprint, { label: "Marketplace publisher", source: "skill-registry-ui" });
      setMarketplace(next);
      setResult(trusted ? "Publisher trust removed." : "Publisher trusted.");
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Publisher trust update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function togglePublisherPolicy(enforceAllowlist: boolean) {
    setBusyId("publisher-policy");
    setResult(null);
    try {
      const next = await updateSkillPublisherPolicy({ enforceAllowlist });
      setMarketplace(next);
      setResult(enforceAllowlist ? "Publisher allowlist enforcement enabled." : "Publisher allowlist enforcement disabled.");
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Publisher policy update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function savePublisherReputation(publisher: SkillPublisher) {
    setBusyId(`publisher-reputation-${publisher.fingerprint}`);
    setResult(null);
    try {
      const draft = publisherDraft(publisher);
      const score = draft.score.trim() ? Number(draft.score) : null;
      const next = await updateSkillPublisherReputation(publisher.fingerprint, {
        label: draft.label,
        website: draft.website,
        score,
        tier: draft.tier,
        notes: draft.notes,
        source: "skill-registry-ui"
      });
      setPublishers(next);
      setResult(`Saved publisher reputation for ${draft.label || publisher.fingerprint.slice(0, 12)}.`);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Publisher reputation update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function togglePublisherAllow(publisher: SkillPublisher) {
    setBusyId(`publisher-allow-${publisher.fingerprint}`);
    setResult(null);
    try {
      const draft = publisherDraft(publisher);
      const next = publisher.allowed
        ? await removeSkillPublisherAllow(publisher.fingerprint)
        : await allowSkillPublisher(publisher.fingerprint, { label: draft.label || publisher.label, notes: draft.notes });
      setPublishers(next);
      setResult(publisher.allowed ? "Publisher removed from allowlist." : "Publisher added to allowlist.");
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Publisher allowlist update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function togglePublisherBlock(publisher: SkillPublisher) {
    setBusyId(`publisher-block-${publisher.fingerprint}`);
    setResult(null);
    try {
      const draft = publisherDraft(publisher);
      const next = publisher.blocked
        ? await removeSkillPublisherBlock(publisher.fingerprint)
        : await blockSkillPublisher(publisher.fingerprint, { reason: draft.notes || "Manual block" });
      setPublishers(next);
      setResult(publisher.blocked ? "Publisher block removed." : "Publisher blocked.");
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Publisher block update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function importMarketplaceItem(feedId: string, skillId: string, trustPublisher = false) {
    setBusyId(`marketplace-import-${feedId}-${skillId}`);
    setResult(null);
    try {
      const imported = await importMarketplaceSkill(feedId, skillId, { trustPublisher });
      setMarketplace(imported.marketplace);
      setResult(`Imported ${imported.skill?.label || skillId} from marketplace.`);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Marketplace skill import failed");
    } finally {
      setBusyId(null);
    }
  }

  async function runSkillAction(skillId: string, action: "install" | "enable" | "disable" | "test" | "configure" | "update" | "uninstall" | "remove-bundle") {
    setBusyId(skillId);
    setResult(null);
    try {
      if (action === "install") {
        const skill = await installSkill(skillId);
        setResult(`Installed ${skill.label}.`);
      }
      if (action === "enable") {
        const skill = await enableSkill(skillId);
        setResult(`Enabled ${skill.label}.`);
      }
      if (action === "disable") {
        const skill = await disableSkill(skillId);
        setResult(`Disabled ${skill.label}.`);
      }
      if (action === "configure") {
        const skill = await configureSkill(skillId, fields[skillId] || {});
        setResult(`Configured ${skill.configuredFields.length} field${skill.configuredFields.length === 1 ? "" : "s"} for ${skill.label}.`);
        setFields((current) => ({ ...current, [skillId]: {} }));
      }
      if (action === "update") {
        const updated = await updateSkill(skillId);
        setMarketplace(updated.marketplace);
        setResult(`Updated ${updated.skill?.label || skillId} to ${updated.skill?.version || "latest"}.`);
      }
      if (action === "test") {
        const test = await testSkill(skillId);
        setResult(test.message);
      }
      if (action === "uninstall") {
        const skill = await uninstallSkill(skillId);
        setResult(skill ? `Uninstalled ${skill.label}.` : `Uninstalled ${skillId}.`);
      }
      if (action === "remove-bundle") {
        await uninstallSkill(skillId, true);
        setResult(`Removed external skill bundle ${skillId}.`);
      }
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Skill action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function prepareDependencies(skillId: string) {
    setBusyId(`deps-prepare-${skillId}`);
    setResult(null);
    try {
      const prepared = await prepareSkillDependencies(skillId);
      setResult(prepared.message);
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Dependency prepare failed");
    } finally {
      setBusyId(null);
    }
  }

  async function runDependencySuggestion(skillId: string, suggestion: SkillDependencySuggestion) {
    const busyKey = `dep-${skillId}-${suggestion.dependencyId}-${suggestion.action}`;
    setBusyId(busyKey);
    setResult(null);
    try {
      if (suggestion.action === "install_skill") {
        const skill = await installSkill(suggestion.dependencyId);
        setResult(`Installed dependency ${skill.label}.`);
      } else if (suggestion.action === "enable_skill") {
        const skill = await enableSkill(suggestion.dependencyId);
        setResult(`Enabled dependency ${skill.label}.`);
      } else if (suggestion.action === "update_skill") {
        const updated = await updateSkill(suggestion.dependencyId);
        setMarketplace(updated.marketplace);
        setResult(`Updated dependency ${updated.skill?.label || suggestion.dependencyId}.`);
      } else if (suggestion.action === "import_marketplace_skill" || suggestion.action === "trust_and_import_marketplace_skill") {
        if (!suggestion.feedId) throw new Error("Missing marketplace feed for dependency import.");
        const imported = await importMarketplaceSkill(suggestion.feedId, suggestion.dependencyId, {
          trustPublisher: suggestion.action === "trust_and_import_marketplace_skill"
        });
        setMarketplace(imported.marketplace);
        setResult(`Imported dependency ${imported.skill?.label || suggestion.dependencyId}.`);
      } else {
        setResult(`${suggestion.label}: ${suggestion.command || "manual action required"}`);
      }
      await refresh();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Dependency action failed");
    } finally {
      setBusyId(null);
    }
  }

  function configKeys(skill: SkillRegistryState["skills"][number]) {
    return Array.from(new Set([
      ...skill.requiredKeys,
      ...skill.requiredAnyKeys.flat(),
      ...skill.optionalKeys
    ]));
  }

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <PlugZap size={16} />
            Skill Registry
          </span>
          <h1>Install OS skills</h1>
          <p>Enable export-safe skills, import signed bundles, configure required user-owned keys, test readiness, and keep logs per skill.</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Import signed bundle</b>
            <p>Paste a `hermes.skill.bundle` JSON envelope signed with Ed25519. Imported bundles add data-only skills to the local catalog; they do not execute arbitrary code.</p>
            <textarea
              value={bundleText}
              onChange={(event) => setBundleText(event.target.value)}
              placeholder='{"kind":"hermes.skill.bundle","schemaVersion":1,"manifest":{...},"signature":{"algorithm":"ed25519","publicKey":"...","value":"..."}}'
            />
            <button className="wide-action" onClick={importBundle} disabled={busyId === "import" || !bundleText.trim()}>
              {busyId === "import" ? <Loader2 className="spin" size={18} /> : <PlugZap size={18} />}
              Import signed skill bundle
            </button>
          </div>

          <div className="setup-row">
            <b>Marketplace feeds</b>
            <p>Add remote `hermes.skill.feed` URLs that publish signed skill bundles. Feed URLs are redacted in public API responses.</p>
            <div className="config-grid">
              <label>
                <span>Feed label</span>
                <input
                  value={feedLabel}
                  onChange={(event) => setFeedLabel(event.target.value)}
                  placeholder="Hermes community skills"
                />
              </label>
              <label>
                <span>Feed URL</span>
                <input
                  value={feedUrl}
                  onChange={(event) => setFeedUrl(event.target.value)}
                  placeholder="https://example.com/hermes-skills.json"
                />
              </label>
            </div>
            <button className="wide-action" onClick={saveFeed} disabled={busyId === "feed-save" || !feedUrl.trim()}>
              {busyId === "feed-save" ? <Loader2 className="spin" size={18} /> : <PlugZap size={18} />}
              Save marketplace feed
            </button>
            <div className="local-list">
              {marketplace?.feeds.map((feed) => (
                <article className="local-item" key={feed.id}>
                  <strong>{feed.label}</strong>
                  <span>{[feed.id, feed.enabled ? "enabled" : "disabled", feed.lastStatus, `${feed.itemCount} skills`].filter(Boolean).join(" / ")}</span>
                  <p>{feed.url}</p>
                  {feed.lastError ? <span>Last error: {feed.lastError}</span> : null}
                  <div className="mini-actions">
                    <button onClick={() => fetchFeed(feed.id)} disabled={busyId === `feed-fetch-${feed.id}`}>
                      {busyId === `feed-fetch-${feed.id}` ? "Fetching..." : "Fetch signed skills"}
                    </button>
                  </div>
                </article>
              )) || <p>No marketplace feeds saved yet.</p>}
            </div>
          </div>

          <div className="setup-row">
            <b>Marketplace skills</b>
            <p>Skills fetched from feeds stay uninstalled until the publisher is trusted and passes the current allow/block policy.</p>
            <div className="local-list">
              {marketplace?.items.map((item) => (
                <article className="local-item" key={`${item.feedId}-${item.skillId}`}>
                  <strong>{item.label}</strong>
                  <span>{[
                    item.version,
                    item.updateChannel ? `channel ${item.updateChannel}` : "",
                    item.category,
                    item.publisherTrusted ? "trusted publisher" : "untrusted publisher",
                    item.updateAvailable ? `update from ${item.installedVersion}` : "",
                    item.publisherAllowed ? "allowed" : "",
                    item.publisherBlocked ? "blocked" : "",
                    item.publisherImportAllowed ? "policy import ok" : "policy blocked",
                    item.publisherReputation?.tier ? `reputation ${item.publisherReputation.tier}${item.publisherReputation.score == null ? "" : ` ${item.publisherReputation.score}`}` : "",
                    item.imported ? "imported" : "not imported",
                    item.signatureVerified ? "signed" : ""
                  ].filter(Boolean).join(" / ")}</span>
                  <p>{item.description}</p>
                  <p>{item.capabilities.join(", ") || "No capabilities declared."}</p>
                  {item.dependencies.length ? <p>Dependencies: {item.dependencies.map((dependency) => `${dependency.id}${dependency.version ? ` >= ${dependency.version}` : ""}${dependency.optional ? " optional" : ""}`).join(", ")}</p> : null}
                  {item.dependencySuggestions.length ? (
                    <div className="builder-log-list">
                      <b>Dependency suggestions</b>
                      {item.dependencySuggestions.map((suggestion) => (
                        <article key={suggestion.id}>
                          <span className={suggestion.autoInstallable ? "is-online" : "is-ready"}>{suggestion.action}</span>
                          <p>{suggestion.label}</p>
                          <small>{suggestion.command || "manual"}</small>
                          {suggestion.autoInstallable ? (
                            <button onClick={() => runDependencySuggestion(item.skillId, suggestion)} disabled={busyId === `dep-${item.skillId}-${suggestion.dependencyId}-${suggestion.action}`}>
                              Apply
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {item.releaseNotes.length ? (
                    <div className="builder-log-list">
                      <b>Release notes</b>
                      {item.releaseNotes.slice(0, 2).map((note) => (
                        <article key={`${item.skillId}-${note.version}-${note.title}`}>
                          <span className={note.breaking ? "is-ready" : "is-online"}>{note.version}</span>
                          <p>{note.title}: {note.items.join(" ")}</p>
                          <small>{note.channel}</small>
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {item.permissions.length ? <p>Permissions: {item.permissions.join(", ")}</p> : null}
                  <span>Publisher: {item.publisherFingerprint.slice(0, 16)}...</span>
                  <div className="mini-actions">
                    <button onClick={() => toggleTrust(item.publisherFingerprint, item.publisherTrusted)} disabled={busyId === `trust-${item.publisherFingerprint}`}>
                      {item.publisherTrusted ? "Untrust publisher" : "Trust publisher"}
                    </button>
                    <button onClick={() => importMarketplaceItem(item.feedId, item.skillId, false)} disabled={busyId === `marketplace-import-${item.feedId}-${item.skillId}` || !item.publisherTrusted || !item.publisherImportAllowed || item.imported}>
                      Import
                    </button>
                    <button onClick={() => importMarketplaceItem(item.feedId, item.skillId, true)} disabled={busyId === `marketplace-import-${item.feedId}-${item.skillId}` || item.publisherTrusted || !item.publisherImportAllowed || item.imported}>
                      Trust and import
                    </button>
                  </div>
                </article>
              )) || <p>No marketplace skills fetched yet.</p>}
            </div>
          </div>

          <div className="setup-row">
            <b>Publisher policy</b>
            <p>Review signed skill publishers, assign reputation, and enforce an optional allowlist before marketplace import.</p>
            <div className="mini-actions">
              <button onClick={() => togglePublisherPolicy(false)} disabled={busyId === "publisher-policy" || !publishers?.policy.enforceAllowlist}>
                Discovery mode
              </button>
              <button onClick={() => togglePublisherPolicy(true)} disabled={busyId === "publisher-policy" || Boolean(publishers?.policy.enforceAllowlist)}>
                Enforce allowlist
              </button>
            </div>
            <div className="local-list">
              {publishers?.publishers.map((publisher) => {
                const draft = publisherDraft(publisher);
                return (
                  <article className="local-item" key={publisher.fingerprint}>
                    <strong>{publisher.label}</strong>
                    <span>{[
                      publisher.trusted ? "trusted" : "untrusted",
                      publisher.allowed ? "allowed" : "not allowed",
                      publisher.blocked ? "blocked" : "",
                      publisher.importAllowed ? "import allowed" : "import blocked",
                      `${publisher.reputation.tier}${publisher.reputation.score == null ? "" : ` ${publisher.reputation.score}`}`,
                      `${publisher.feedItems} feed skills`,
                      `${publisher.importedSkills} imported`
                    ].filter(Boolean).join(" / ")}</span>
                    <p>{publisher.fingerprint}</p>
                    <div className="config-grid">
                      <label>
                        <span>Label</span>
                        <input
                          value={draft.label}
                          onChange={(event) => updatePublisherDraft(publisher.fingerprint, "label", event.target.value)}
                          placeholder="Publisher name"
                        />
                      </label>
                      <label>
                        <span>Website</span>
                        <input
                          value={draft.website}
                          onChange={(event) => updatePublisherDraft(publisher.fingerprint, "website", event.target.value)}
                          placeholder="https://publisher.example"
                        />
                      </label>
                      <label>
                        <span>Score</span>
                        <input
                          value={draft.score}
                          onChange={(event) => updatePublisherDraft(publisher.fingerprint, "score", event.target.value)}
                          placeholder="0-100"
                          inputMode="numeric"
                        />
                      </label>
                      <label>
                        <span>Tier</span>
                        <select
                          value={draft.tier}
                          onChange={(event) => updatePublisherDraft(publisher.fingerprint, "tier", event.target.value)}
                        >
                          <option value="unknown">unknown</option>
                          <option value="verified">verified</option>
                          <option value="trusted">trusted</option>
                          <option value="neutral">neutral</option>
                          <option value="caution">caution</option>
                          <option value="blocked">blocked</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      <span>Notes</span>
                      <textarea
                        value={draft.notes}
                        onChange={(event) => updatePublisherDraft(publisher.fingerprint, "notes", event.target.value)}
                        placeholder="Review notes"
                      />
                    </label>
                    <div className="mini-actions">
                      <button onClick={() => savePublisherReputation(publisher)} disabled={busyId === `publisher-reputation-${publisher.fingerprint}`}>
                        Save reputation
                      </button>
                      <button onClick={() => togglePublisherAllow(publisher)} disabled={busyId === `publisher-allow-${publisher.fingerprint}`}>
                        {publisher.allowed ? "Remove allow" : "Allow publisher"}
                      </button>
                      <button onClick={() => togglePublisherBlock(publisher)} disabled={busyId === `publisher-block-${publisher.fingerprint}`}>
                        {publisher.blocked ? "Remove block" : "Block publisher"}
                      </button>
                    </div>
                  </article>
                );
              }) || <p>No marketplace publishers discovered yet.</p>}
            </div>
          </div>

          <div className="setup-row">
            <b>Catalog</b>
            <div className="local-list">
              {registry?.skills.map((skill) => (
                <article className="local-item" key={skill.id}>
                  <strong>{skill.label}</strong>
                  <span>{[skill.version, skill.latestVersion !== skill.version ? `latest ${skill.latestVersion}` : "", skill.updateChannel ? `channel ${skill.updateChannel}` : "", skill.category, skill.status, skill.source, skill.signatureVerified ? "signed" : "", skill.updateAvailable ? "update available" : "", skill.dependencyReady ? "" : "dependencies needed", skill.exportSafe ? "export-safe" : ""].filter(Boolean).join(" / ")}</span>
                  <p>{skill.description}</p>
                  <p>{skill.capabilities.join(", ")}</p>
                  {skill.dependencies.length ? <p>Dependencies: {skill.dependencyStatus.map((dependency) => `${dependency.id}${dependency.version ? ` >= ${dependency.version}` : ""} (${dependency.status})`).join(", ")}</p> : null}
                  {skill.dependencySuggestions.length ? (
                    <div className="builder-log-list">
                      <b>Dependency install plan</b>
                      {skill.dependencySuggestions.map((suggestion) => (
                        <article key={suggestion.id}>
                          <span className={suggestion.autoInstallable ? "is-online" : "is-ready"}>{suggestion.action}</span>
                          <p>{suggestion.label}</p>
                          <small>{suggestion.command || "manual"}</small>
                          {suggestion.autoInstallable ? (
                            <button onClick={() => runDependencySuggestion(skill.id, suggestion)} disabled={busyId === `dep-${skill.id}-${suggestion.dependencyId}-${suggestion.action}`}>
                              Apply
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {skill.availableUpdate ? <p>Update source: {skill.availableUpdate.feedId} / {skill.availableUpdate.updateChannel} / {skill.availableUpdate.publisherFingerprint.slice(0, 16)}...</p> : null}
                  {skill.availableUpdate?.releaseNotes.length ? (
                    <div className="builder-log-list">
                      <b>Update release notes</b>
                      {skill.availableUpdate.releaseNotes.slice(0, 2).map((note) => (
                        <article key={`${skill.id}-update-${note.version}-${note.title}`}>
                          <span className={note.breaking ? "is-ready" : "is-online"}>{note.version}</span>
                          <p>{note.title}: {note.items.join(" ")}</p>
                          <small>{note.channel}</small>
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {skill.releaseNotes.length ? (
                    <div className="builder-log-list">
                      <b>Release notes</b>
                      {skill.releaseNotes.slice(0, 2).map((note) => (
                        <article key={`${skill.id}-${note.version}-${note.title}`}>
                          <span className={note.breaking ? "is-ready" : "is-online"}>{note.version}</span>
                          <p>{note.title}: {note.items.join(" ")}</p>
                          <small>{note.channel}</small>
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {skill.permissions.length ? <p>Permissions: {skill.permissions.join(", ")}</p> : null}
                  {skill.publisherFingerprint ? <span>Publisher: {skill.publisherFingerprint.slice(0, 16)}... / {skill.publisherTrusted ? "trusted" : "untrusted"}</span> : null}
                  {skill.missing.length ? <span>Missing: {skill.missing.join(", ")}</span> : null}
                  {skill.installed ? (
                    <div className="config-grid">
                      {configKeys(skill).map((key) => (
                        <label key={key}>
                          <span>{key}</span>
                          <input
                            value={fields[skill.id]?.[key] || ""}
                            onChange={(event) => updateField(skill.id, key, event.target.value)}
                            placeholder={skill.configuredFields.includes(key) ? "configured" : "paste value"}
                            type={key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET") ? "password" : "text"}
                          />
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <div className="mini-actions">
                    {!skill.installed ? (
                      <button onClick={() => runSkillAction(skill.id, "install")} disabled={busyId === skill.id}>
                        Install
                      </button>
                    ) : (
                      <>
                        <button onClick={() => runSkillAction(skill.id, "configure")} disabled={busyId === skill.id}>
                          Save config
                        </button>
                        <button onClick={() => runSkillAction(skill.id, skill.enabled ? "disable" : "enable")} disabled={busyId === skill.id}>
                          {skill.enabled ? "Disable" : "Enable"}
                        </button>
                        <button onClick={() => runSkillAction(skill.id, "test")} disabled={busyId === skill.id}>
                          Test
                        </button>
                        {skill.updateAvailable ? (
                          <button onClick={() => runSkillAction(skill.id, "update")} disabled={busyId === skill.id}>
                            Update
                          </button>
                        ) : null}
                        {skill.dependencySuggestions.length ? (
                          <button onClick={() => prepareDependencies(skill.id)} disabled={busyId === `deps-prepare-${skill.id}`}>
                            Prepare deps
                          </button>
                        ) : null}
                        <button onClick={() => runSkillAction(skill.id, "uninstall")} disabled={busyId === skill.id}>
                          Uninstall
                        </button>
                      </>
                    )}
                    {skill.source === "external" ? (
                      <button onClick={() => runSkillAction(skill.id, "remove-bundle")} disabled={busyId === skill.id}>
                        Remove bundle
                      </button>
                    ) : null}
                  </div>
                </article>
              )) || <p>No skills registered yet.</p>}
            </div>
            {result ? <div className="test-result">{result}</div> : null}
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Skill status</h3>
        <Metric label="Catalog" value={String(registry?.summary.total || 0)} />
        <Metric label="Installed" value={String(registry?.summary.installed || 0)} />
        <Metric label="Enabled" value={String(registry?.summary.enabled || 0)} />
        <Metric label="Setup needed" value={String(registry?.summary.setup || 0)} />
        <Metric label="Disabled" value={String(registry?.summary.disabled || 0)} />
        <Metric label="Available" value={String(registry?.summary.available || 0)} />
        <Metric label="External" value={String(registry?.summary.external || 0)} />
        <Metric label="Signed" value={String(registry?.summary.signed || 0)} />
        <Metric label="Trusted publishers" value={String(registry?.summary.trustedPublishers || 0)} />
        <Metric label="Known publishers" value={String(publishers?.summary.known || registry?.summary.knownPublishers || 0)} />
        <Metric label="Allowed publishers" value={String(publishers?.summary.allowed || registry?.summary.allowedPublishers || 0)} />
        <Metric label="Blocked publishers" value={String(publishers?.summary.blocked || registry?.summary.blockedPublishers || 0)} />
        <Metric label="Allowlist mode" value={publishers?.policy.enforceAllowlist || registry?.summary.allowlistEnforced ? "enforced" : "discovery"} />
        <Metric label="Untrusted external" value={String(registry?.summary.untrustedExternal || 0)} />
        <Metric label="Feeds" value={String(marketplace?.summary.feeds || registry?.summary.marketplaceFeeds || 0)} />
        <Metric label="Feed skills" value={String(marketplace?.summary.items || registry?.summary.marketplaceItems || 0)} />
        <Metric label="Trusted feed skills" value={String(marketplace?.summary.trustedItems || registry?.summary.marketplaceTrustedItems || 0)} />
        <Metric label="Blocked feed skills" value={String(marketplace?.summary.blockedItems || 0)} />
        <Metric label="Feed updates" value={String(marketplace?.summary.updateItems || registry?.summary.marketplaceUpdateItems || 0)} />
        <Metric label="Dependency blocks" value={String(registry?.summary.dependencyBlocked || 0)} />
        <Metric label="Dependency suggestions" value={String(registry?.summary.dependencySuggestions || 0)} />
        <Metric label="Updates" value={String(registry?.summary.updates || 0)} />
        <Metric label="Updated" value={registry?.updatedAt ? new Date(registry.updatedAt).toLocaleString() : "not yet"} />
      </aside>
    </main>
  );
}

function PluginCard({ integration, onOpen }: { integration: Integration; onOpen: () => void }) {
  const Icon = iconMap[integration.id] || Link2;
  return (
    <article className="plugin-card">
      <div className="plugin-title">
        <Icon size={20} />
        <div>
          <strong>{integration.label}</strong>
          <span>{integration.type}</span>
        </div>
        <em className={statusClass(String(integration.status))}>{statusLabel(String(integration.status))}</em>
      </div>
      <p>{integration.connection}</p>
      <div className="plugin-actions">
        <button onClick={onOpen}>Connect</button>
        <button onClick={onOpen}>Test</button>
        <button onClick={onOpen}>Logs</button>
      </div>
    </article>
  );
}

function ControlRoom({
  id,
  snapshot,
  onOpenPlugins,
  onOpenTarget,
  onSnapshotRefresh,
  focusId
}: {
  id: string;
  snapshot: IntegrationSnapshot | null;
  onOpenPlugins: () => void;
  onOpenTarget: (id: string, focusId?: string | null) => void;
  onSnapshotRefresh: () => Promise<void> | void;
  focusId?: string | null;
}) {
  const integration = useMemo(() => {
    return snapshot?.integrations.find((item) => item.id === id) || null;
  }, [id, snapshot]);
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
	  const [lastRun, setLastRun] = useState<ModuleRunResult | null>(null);
	  const [moduleLogs, setModuleLogs] = useState<ModuleLogs | null>(null);
	  const [moduleRuns, setModuleRuns] = useState<ModuleRuns | null>(null);
	  const [moduleSessions, setModuleSessions] = useState<ModuleSessions | null>(null);
	  const [selectedSession, setSelectedSession] = useState<ModuleSession | null>(null);
  const [executeCli, setExecuteCli] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<string | null>(null);
  const [template, setTemplate] = useState<ConnectionTemplate | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [modelInventory, setModelInventory] = useState<ProviderModelInventory | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealthState | null>(null);
	  const [selectedModel, setSelectedModel] = useState("");
	  const [selectedHermesProfile, setSelectedHermesProfile] = useState("");
	  const [modelResult, setModelResult] = useState<string | null>(null);
  const [providerHealthResult, setProviderHealthResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [providerHealthBusy, setProviderHealthBusy] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const providerSetupId = integration ? providerSetupByModuleId[integration.id] || "" : "";
  const canRequestExecution = Boolean(
    integration?.actions?.includes("run") &&
    ["cli", "provider", "local_runtime", "gateway", "model_router"].includes(String(integration.type || ""))
  );
  const canUseSessions = Boolean(integration?.actions?.includes("sessions"));
  const sessionKind = integration?.id === "hermes" ? "hermes" : integration?.type === "cli" ? "cli" : "provider";
  const isCliAgent = integration?.type === "cli";
	  const isProviderControl = Boolean(
	    providerSetupId ||
	    integration?.id === "provider-router" ||
	    (integration?.type === "routing" && (integration.actions?.includes("run") || integration.actions?.includes("sessions")))
	  );
	  const taskProfiles = integration?.taskProfiles || [];
	  const hermesProfiles = integration?.id === "hermes" && Array.isArray(integration.profiles) ? integration.profiles : [];
	  const activeHermesProfile = String(integration?.activeProfile || integration?.stats?.activeProfile || "");
	  const selectedHermesProfileInfo = hermesProfiles.find((profile) => profile.id === selectedHermesProfile) || null;

  useEffect(() => {
    getConnections()
      .then((data) => {
        const found = data.templates.find((item) => item.id === id) || null;
        setTemplate(found);
        setFields({});
      })
      .catch(() => {
        setTemplate(null);
        setFields({});
      });
  }, [id]);

  async function refreshModuleLogs(target = id) {
    try {
      const [logs, runs, sessions] = await Promise.all([
        getModuleLogs(target),
        getModuleRuns(target),
        getModuleSessions(target)
      ]);
      setModuleLogs(logs);
      setModuleRuns(runs);
      setModuleSessions(sessions);
    } catch {
      setModuleLogs(null);
      setModuleRuns(null);
      setModuleSessions(null);
    }
  }

  useEffect(() => {
    setReply(null);
    setLastRun(null);
    setModelInventory(null);
    setProviderHealth(null);
	    setSelectedModel("");
	    if (integration?.id === "hermes") {
	      const profiles = Array.isArray(integration.profiles) ? integration.profiles : [];
	      const active = String(integration.activeProfile || integration.stats?.activeProfile || "");
	      setSelectedHermesProfile(profiles.some((profile) => profile.id === active) ? active : profiles[0]?.id || "");
	    } else {
	      setSelectedHermesProfile("");
	    }
	    setModelResult(null);
	    setProviderHealthResult(null);
	    setExecuteCli(false);
	    setModuleSessions(null);
	    setSelectedSession(null);
	    refreshModuleLogs(id);
		  }, [id, integration?.id]);

  function inspectRun(run: ModuleRuns["runs"][number]) {
    setLastRun({
      ok: true,
      mode: run.mode,
      reply: `Loaded saved proof for ${run.runId}.`,
      proof: run.proof,
      control: run.control || undefined,
      handoff: run.handoff
    });
    setReply(`Loaded saved proof for ${run.moduleLabel || integration?.label || run.moduleId}.`);
  }

  async function runAgain(run: ModuleRuns["runs"][number]) {
    if (!run.replay?.available || !run.replay.input) {
      setReply(run.replay?.reason || "This run needs fresh input before it can run again.");
      return;
    }
    setBusy(true);
    try {
      const targetId = run.moduleId || integration!.id;
      const result = await runModuleAction(targetId, run.replay.input);
      setLastRun(result);
      setReply(result.reply);
      await refreshModuleLogs(targetId);
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Run again failed");
    } finally {
      setBusy(false);
    }
  }

  async function runControlAction(payload: Record<string, unknown>, targetId = integration?.id || id) {
    setBusy(true);
    try {
      const result = await runModuleAction(targetId, payload);
      setLastRun(result);
      setReply(result.reply);
      await refreshModuleLogs(targetId);
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Control action failed");
    } finally {
      setBusy(false);
    }
  }

  async function scheduleAgentFollowUp() {
    const proof = lastRun?.proof || moduleRuns?.runs[0]?.proof || null;
    const handoff = lastRun?.handoff || proof?.handoff || moduleRuns?.runs[0]?.handoff || null;
    setBusy(true);
    try {
      const job = await saveSchedulerJob({
        label: `Follow up ${integration?.label || id}`,
        targetType: "self_module",
        targetId: "kanban",
        action: "create_item",
        intervalMinutes: 60,
        retryDelaySeconds: 60,
        maxRetries: 2,
        requiresApproval: true,
        payload: {
          title: `Follow up ${integration?.label || id}`,
          status: "planned",
          column: "todo",
          priority: "normal",
          notes: [
            proof?.nextStep || "Review the latest agent run and decide the next action.",
            proof?.runId ? `Run: ${proof.runId}` : "",
            handoff?.memoryId ? `Memory: ${handoff.memoryId}` : "",
            handoff?.kanbanCardId ? `Original Kanban: ${handoff.kanbanCardId}` : ""
          ].filter(Boolean).join("\n")
        },
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      });
      setReply(`Scheduled follow-up job ${job.id}. It will create a Kanban card after approval.`);
      onOpenTarget("scheduler", job.id);
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Follow-up scheduling failed");
    } finally {
      setBusy(false);
    }
  }

  if (!integration) {
    return (
      <main className="content">
        <EmptyPanel title="Connector ready" body="This workspace is wired. Pick another agent or open plugin connections." />
      </main>
    );
  }

  if (integration.id === "usage-credits") {
    return <UsageCreditsControl integration={integration} onOpenPlugins={onOpenPlugins} />;
  }

  if (isLocalSelfModuleId(integration.id)) {
    return <SelfModuleControl integration={integration} onOpenPlugins={onOpenPlugins} focusId={focusId} />;
  }

  async function send() {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const targetId = integration!.id;
	      const result = await sendAgentMessage(targetId, message, {
	        dryRun: canRequestExecution && executeCli ? false : true,
	        provider: providerSetupId || undefined,
	        profile: integration!.id === "hermes" ? selectedHermesProfile || undefined : undefined
	      });
      setLastRun(result);
      const execution = result.execution
        ? `\n\nAdapter: ${result.execution.adapterId}\nExit: ${result.execution.exitCode ?? "none"}\nDuration: ${result.execution.durationMs}ms\nStdout bytes: ${result.execution.stdoutBytes}\nStderr bytes: ${result.execution.stderrBytes}`
        : "";
      setReply(`${result.reply}${execution}`);
      await refreshModuleLogs(targetId);
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Dispatch failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveConfiguration() {
    const cleaned = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value.trim() !== "")
    );
    if (!Object.keys(cleaned).length) {
      setTestResult("Add at least one value before saving configuration.");
      return;
    }
    setSaving(true);
    setTestResult(null);
    try {
      const result = await configureConnection(integration!.id, cleaned);
      setTestResult(`Saved local configuration fields: ${result.configuredFields.join(", ")}`);
      setFields({});
      await onSnapshotRefresh();
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "Configuration save failed");
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setTestResult(null);
    try {
      const data = await testIntegration(integration!.id);
      setTestResult(data.message);
      await onSnapshotRefresh();
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadModelInventory() {
    if (!providerSetupId) return;
    setModelBusy(true);
    setModelResult(null);
    try {
      const inventory = await getProviderModelInventory(providerSetupId);
      setModelInventory(inventory);
      setSelectedModel(inventory.modelDefault || inventory.models[0]?.name || "");
      setModelResult(inventory.publicSummary);
      await onSnapshotRefresh();
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setModelResult(err instanceof Error ? err.message : "Model inventory failed");
    } finally {
      setModelBusy(false);
    }
  }

  async function checkProviderCardHealth() {
    if (!providerSetupId) return;
    setProviderHealthBusy(true);
    setProviderHealthResult(null);
    try {
      const health = await getRouterHealth(providerSetupId);
      setProviderHealth(health);
      const check = health.checks[0];
      setProviderHealthResult(check
        ? `${check.label}: ${statusLabel(check.status)}${check.modelCount != null ? `, ${check.modelCount} model${check.modelCount === 1 ? "" : "s"}` : ""}`
        : "No provider health check returned.");
      await onSnapshotRefresh();
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setProviderHealthResult(err instanceof Error ? err.message : "Provider health check failed");
    } finally {
      setProviderHealthBusy(false);
    }
  }

  async function saveProviderModel() {
    if (!providerSetupId || !selectedModel.trim()) return;
    setModelBusy(true);
    setModelResult(null);
    try {
      await configureProviderSetup(providerSetupId, { model: selectedModel.trim() });
      const inventory = await getProviderModelInventory(providerSetupId);
      setModelInventory(inventory);
      setModelResult(`Selected model saved: ${selectedModel.trim()}`);
      await onSnapshotRefresh();
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setModelResult(err instanceof Error ? err.message : "Model save failed");
    } finally {
      setModelBusy(false);
    }
  }

  async function refreshHermesTask() {
    const taskId = lastRun?.control?.taskId;
    if (!taskId) return;
    setBusy(true);
    try {
      const result = await runModuleAction("hermes", {
	        action: "task_status",
	        taskId,
	        profile: lastRun?.control?.selectedProfile || selectedHermesProfile || undefined,
	        recordHandoff: false
      });
      setLastRun(result);
      setReply(result.reply);
      await refreshModuleLogs("hermes");
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Task refresh failed");
    } finally {
      setBusy(false);
    }
  }

  async function controlHermesTask(action: string) {
    const taskId = lastRun?.control?.taskId;
    if (!taskId) return;
    setBusy(true);
    try {
      const result = await runModuleAction("hermes", {
	        action,
	        taskId,
	        profile: lastRun?.control?.selectedProfile || selectedHermesProfile || undefined,
	        dryRun: executeCli ? false : true,
        reason: "Dashboard control"
      });
      setLastRun(result);
      setReply(result.reply);
      await refreshModuleLogs("hermes");
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Task control failed");
    } finally {
      setBusy(false);
    }
  }

  function runGatewayAction(action: string, extra: Record<string, unknown> = {}) {
    return runControlAction({
      action,
      dryRun: executeCli ? false : true,
      ...extra
    }, "gateway");
  }

	  function runHermesAction(action: string, extra: Record<string, unknown> = {}) {
	    return runControlAction({
	      action,
	      dryRun: executeCli ? false : true,
	      profile: selectedHermesProfile || undefined,
	      ...extra
	    }, "hermes");
	  }

  function runPromptControl(defaultMessage: string) {
    const text = message.trim() || defaultMessage;
    return runControlAction({
      message: text,
      dryRun: canRequestExecution && executeCli ? false : true,
      provider: providerSetupId || undefined
    }, integration!.id);
  }

  function loadTaskProfile(profile: NonNullable<RuntimeModule["taskProfiles"]>[number]) {
    setMessage(profile.prompt);
    setReply(`Loaded ${profile.label}. Edit the prompt or run it from this control room.`);
  }

	  function runTaskProfile(profile: NonNullable<RuntimeModule["taskProfiles"]>[number]) {
	    return runControlAction({
	      ...(profile.input || {}),
	      ...(profile.action ? { action: profile.action } : {}),
	      message: message.trim() || profile.prompt,
	      taskProfile: profile.id,
	      dryRun: canRequestExecution && executeCli ? false : true,
	      provider: providerSetupId || undefined,
	      profile: integration!.id === "hermes" ? selectedHermesProfile || undefined : undefined
	    }, integration!.id);
	  }

  async function startAgentSession() {
    if (!canUseSessions) return;
    setSessionBusy(true);
    try {
      const result = await startModuleSession(integration!.id, {
        message: message.trim() || undefined,
        dryRun: executeCli ? false : true,
        provider: providerSetupId || undefined,
        profile: integration!.id === "hermes" ? selectedHermesProfile || undefined : undefined
      });
      setReply(result.reply || `Session ${result.session?.status || "updated"}.`);
      setSelectedSession(result.session || null);
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Session start failed");
    } finally {
      setSessionBusy(false);
    }
  }

  async function stopAgentSession(sessionId: string) {
    setSessionBusy(true);
    try {
      const result = await stopModuleSession(integration!.id, sessionId);
      setReply(result.session ? `Session ${result.session.sessionId} is ${result.session.status}.` : "Session stop requested.");
      setSelectedSession(result.session || selectedSession);
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Session stop failed");
    } finally {
      setSessionBusy(false);
    }
  }

  async function sendSessionMessage(sessionId: string) {
    if (!message.trim()) {
      setReply("Type a message before sending it into this session.");
      return;
    }
    setSessionBusy(true);
    try {
      const result = await messageModuleSession(integration!.id, sessionId, {
        message: message.trim(),
        dryRun: executeCli ? false : true,
        provider: providerSetupId || undefined,
        profile: integration!.id === "hermes" ? selectedHermesProfile || selectedSession?.profile || undefined : undefined
      });
      setReply(result.reply || `Session ${result.session?.sessionId || sessionId} updated.`);
      setSelectedSession(result.session || selectedSession);
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Session message failed");
    } finally {
      setSessionBusy(false);
    }
  }

  async function inspectAgentSession(sessionId: string) {
    setSessionBusy(true);
    try {
      const result = await getModuleSession(integration!.id, sessionId);
      setSelectedSession(result.session);
      setReply(result.session ? `Loaded session ${result.session.sessionId}.` : "Session not found.");
    } catch (err) {
      setReply(err instanceof Error ? err.message : "Session inspect failed");
    } finally {
      setSessionBusy(false);
    }
  }

  async function prepareModuleInstall() {
    setInstalling(true);
    setInstallResult(null);
    try {
      const result = await installModule(integration!.id, false);
      setInstallResult(result.message);
      await refreshModuleLogs(integration!.id);
    } catch (err) {
      setInstallResult(err instanceof Error ? err.message : "Install preparation failed");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <Command size={16} />
            Control room
          </span>
          <h1>{integration.label}</h1>
          <p>{integration.connection}</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Install</b>
            <p>{integration.installHint || "Install the local tool or configure a path/API key below."}</p>
            {integration.installCommand ? <code>{integration.installCommand}</code> : null}
            {integration.docsUrl ? (
              <a href={integration.docsUrl} target="_blank" rel="noreferrer">Open docs</a>
            ) : null}
            {integration.actions?.includes("install") || integration.installCommand ? (
              <button className="wide-action" onClick={prepareModuleInstall} disabled={installing}>
                {installing ? <Loader2 className="spin" size={18} /> : <Rocket size={18} />}
                Prepare install
              </button>
            ) : null}
            {installResult ? <div className="test-result">{installResult}</div> : null}
          </div>

          <div className="setup-row">
            <b>Connect</b>
            <p>{template?.notes || "Save local configuration for this module. Secret values are redacted by the backend."}</p>
            <div className="config-grid">
              {(template?.fields || integration.configKeys || []).map((field) => (
                <label key={field}>
                  <span>{field}</span>
                  <input
                    value={fields[field] || ""}
                    onChange={(event) => setFields((current) => ({ ...current, [field]: event.target.value }))}
                    placeholder={template?.configuredFields?.includes(field) ? "configured" : "paste value or local path"}
                    type={field.includes("KEY") || field.includes("TOKEN") ? "password" : "text"}
                  />
                </label>
              ))}
            </div>
            <button className="wide-action" onClick={saveConfiguration} disabled={saving}>
              {saving ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
              Save local config
            </button>
          </div>
        </section>

        {providerSetupId ? (
          <section className="setup-panel">
            <div className="setup-row">
              <b>Models</b>
              <p>Load the provider model list, choose the model this card should use, and keep runs pinned to this provider.</p>
              <div className="model-picker-row">
                <button className="wide-action" onClick={checkProviderCardHealth} disabled={providerHealthBusy}>
                  {providerHealthBusy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                  Check health
                </button>
                <button className="wide-action" onClick={loadModelInventory} disabled={modelBusy}>
                  {modelBusy ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
                  Load models
                </button>
                <select
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                  disabled={!modelInventory?.models.length || modelBusy}
                >
                  {modelInventory?.models.length ? modelInventory.models.slice(0, 200).map((model) => (
                    <option key={model.name} value={model.name}>
                      {model.displayName || model.name}
                    </option>
                  )) : (
                    <option value="">No model list loaded</option>
                  )}
                </select>
                <button className="wide-action" onClick={saveProviderModel} disabled={modelBusy || !selectedModel.trim()}>
                  {modelBusy ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
                  Save model
                </button>
              </div>
              {modelInventory ? (
                <div className="metric-row compact">
                  <Metric label="Inventory" value={statusLabel(modelInventory.status)} />
                  <Metric label="Models" value={String(modelInventory.modelCount)} />
                  <Metric label="Selected" value={modelInventory.modelDefault} />
                  <Metric label="Available" value={modelInventory.selectedModelAvailable ? "yes" : "no"} />
                </div>
              ) : null}
              {providerHealth?.checks[0] ? (
                <div className="metric-row compact">
                  <Metric label="Health" value={statusLabel(providerHealth.checks[0].status)} />
                  <Metric label="HTTP" value={providerHealth.checks[0].httpStatus ? String(providerHealth.checks[0].httpStatus) : "none"} />
                  <Metric label="Models" value={providerHealth.checks[0].modelCount != null ? String(providerHealth.checks[0].modelCount) : "unknown"} />
                  <Metric label="Endpoint" value={providerHealth.checks[0].endpoint || "not configured"} />
                </div>
              ) : null}
              {modelResult ? <div className="test-result">{modelResult}</div> : null}
              {providerHealthResult ? <div className="test-result">{providerHealthResult}</div> : null}
            </div>
          </section>
        ) : null}

        {isProviderControl ? (
          <section className="setup-panel">
            <div className="setup-row">
              <b>Provider controls</b>
              <p>Run a routed prompt, open a local conversation session, and verify model/provider readiness from this card.</p>
              <div className="quick-control-grid">
                {providerSetupId ? (
                  <button className="wide-action" onClick={checkProviderCardHealth} disabled={providerHealthBusy || busy}>
                    {providerHealthBusy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                    Check provider
                  </button>
                ) : null}
                {providerSetupId ? (
                  <button className="wide-action" onClick={loadModelInventory} disabled={modelBusy || busy}>
                    {modelBusy ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
                    Load models
                  </button>
                ) : null}
                {integration.actions?.includes("run") ? (
                  <button className="wide-action" onClick={() => runPromptControl(`Run a short ${integration.label} Agent OS health check.`)} disabled={busy}>
                    {busy ? <Loader2 className="spin" size={18} /> : <MessageSquare size={18} />}
                    {executeCli ? "Run prompt" : "Dry-run prompt"}
                  </button>
                ) : null}
                {canUseSessions ? (
                  <button className="wide-action" onClick={startAgentSession} disabled={sessionBusy || busy}>
                    {sessionBusy ? <Loader2 className="spin" size={18} /> : <MessageSquare size={18} />}
                    {executeCli ? "Open live session" : "Open dry-run session"}
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {isCliAgent ? (
          <section className="setup-panel">
            <div className="setup-row">
              <b>Local agent controls</b>
              <p>Verify the CLI, prepare or start a process session, and dispatch a dashboard task through the structured local adapter.</p>
              <div className="quick-control-grid">
                <button className="wide-action" onClick={runTest} disabled={busy}>
                  {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                  Test CLI
                </button>
                {integration.actions?.includes("install") || integration.installCommand ? (
                  <button className="wide-action" onClick={prepareModuleInstall} disabled={installing || busy}>
                    {installing ? <Loader2 className="spin" size={18} /> : <Rocket size={18} />}
                    Prepare install
                  </button>
                ) : null}
                {canUseSessions ? (
                  <button className="wide-action" onClick={startAgentSession} disabled={sessionBusy || busy}>
                    {sessionBusy ? <Loader2 className="spin" size={18} /> : <TerminalSquare size={18} />}
                    {executeCli ? "Start CLI session" : "Prepare session"}
                  </button>
                ) : null}
                {integration.actions?.includes("run") ? (
                  <button className="wide-action" onClick={() => runPromptControl(`Run a short ${integration.label} local agent health check.`)} disabled={busy}>
                    {busy ? <Loader2 className="spin" size={18} /> : <Command size={18} />}
                    {executeCli ? "Run task" : "Dry-run task"}
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {integration.id === "gateway" ? (
          <section className="setup-panel">
            <div className="setup-row">
              <b>Gateway controls</b>
              <p>Inspect real Hermes profile channels, prepare restart commands, and run gated channel smoke tests.</p>
              <div className="quick-control-grid">
                <button className="wide-action" onClick={() => runGatewayAction("status")} disabled={busy}>
                  {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                  Inspect status
                </button>
                <button className="wide-action" onClick={() => runGatewayAction("channel_status", { platform: "telegram" })} disabled={busy}>
                  <Radio size={18} />
                  Telegram channel
                </button>
                <button className="wide-action" onClick={() => runGatewayAction("test_telegram")} disabled={busy}>
                  <MessageSquare size={18} />
                  Test Telegram
                </button>
                <button className="wide-action danger-lite" onClick={() => runGatewayAction("restart_gateway")} disabled={busy}>
                  <RefreshCcw size={18} />
                  Restart gateway
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {integration.id === "hermes" ? (
          <section className="setup-panel">
	            <div className="setup-row">
	              <b>Hermes runtime controls</b>
	              <p>Inspect local Hermes profiles, prepare gateway restarts, or create a Hermes Kanban task from the message box.</p>
	              {hermesProfiles.length ? (
	                <>
	                  <div className="config-grid">
	                    <label>
	                      <span>Profile</span>
	                      <select value={selectedHermesProfile} onChange={(event) => setSelectedHermesProfile(event.target.value)}>
	                        {hermesProfiles.map((profile) => (
	                          <option key={profile.id} value={profile.id}>
	                            {profile.id}{profile.id === activeHermesProfile ? " (active)" : ""}
	                          </option>
	                        ))}
	                      </select>
	                    </label>
	                  </div>
	                  {selectedHermesProfileInfo ? (
	                    <div className="metric-row compact">
	                      <Metric label="Gateway" value={selectedHermesProfileInfo.gatewayState} />
	                      <Metric label="Platforms" value={`${selectedHermesProfileInfo.connectedPlatforms}/${selectedHermesProfileInfo.platformCount}`} />
	                      <Metric label="Channels" value={String(selectedHermesProfileInfo.channels)} />
	                      <Metric label="Launchd" value={selectedHermesProfileInfo.launchdLoaded ? "loaded" : "not loaded"} />
	                    </div>
	                  ) : null}
	                </>
	              ) : null}
	              <div className="quick-control-grid">
                <button className="wide-action" onClick={() => runHermesAction("status")} disabled={busy}>
                  {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                  Inspect profiles
                </button>
                <button className="wide-action danger-lite" onClick={() => runHermesAction("restart_gateway")} disabled={busy}>
                  <RefreshCcw size={18} />
                  Restart gateway
                </button>
                <button className="wide-action" onClick={() => runHermesAction("task", { message })} disabled={busy || !message.trim()}>
                  <KanbanSquare size={18} />
                  Create Hermes task
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {taskProfiles.length ? (
          <section className="setup-panel">
            <div className="setup-row">
              <b>Task profiles</b>
              <p>Start from a real module profile instead of a blank prompt. Runs still use the same dry-run and execution gates.</p>
              <div className="profile-template-grid">
                {taskProfiles.map((profile) => (
                  <article key={profile.id} className="profile-template-card">
                    <strong>{profile.label}</strong>
                    <p>{profile.description}</p>
                    <div className="run-actions">
                      <button className="tiny-action" onClick={() => loadTaskProfile(profile)}>
                        Load
                      </button>
                      {integration.actions?.includes("run") ? (
                        <button className="tiny-action" onClick={() => runTaskProfile(profile)} disabled={busy}>
                          {executeCli ? "Run" : "Dry run"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <div className="composer">
          <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message ${integration.label}...`} />
          <button onClick={send} disabled={busy || !message.trim()}>
            {busy ? <Loader2 className="spin" size={18} /> : <MessageSquare size={18} />}
            {canRequestExecution && executeCli ? "Run" : "Dry run"}
          </button>
        </div>
        {canRequestExecution ? (
          <label className="inline-check">
            <input type="checkbox" checked={executeCli} onChange={(event) => setExecuteCli(event.target.checked)} />
            Execute real run when server allows it
          </label>
        ) : null}
        {canUseSessions ? (
          <section className="session-panel">
            <div className="proof-header">
              <div>
                <b>Agent sessions</b>
                <p>{sessionKind === "cli"
                  ? "Start, inspect, and stop a local CLI process from this control room."
                  : sessionKind === "hermes"
                    ? "Open a Hermes profile lane, dispatch tasks, and inspect profile-bound proof from this dashboard."
                    : "Open a provider conversation, send routed messages, and inspect sanitized response tails."}</p>
              </div>
              <button onClick={() => refreshModuleLogs(integration.id)} disabled={sessionBusy}>
                <RefreshCcw size={14} />
              </button>
            </div>
            <button className="wide-action" onClick={startAgentSession} disabled={sessionBusy}>
              {sessionBusy ? <Loader2 className="spin" size={18} /> : sessionKind === "cli" ? <TerminalSquare size={18} /> : <MessageSquare size={18} />}
              {sessionKind === "cli"
                ? executeCli ? "Start real session" : "Prepare session"
                : sessionKind === "hermes"
                  ? "Open Hermes profile session"
                  : executeCli ? "Open live provider session" : "Open dry-run provider session"}
            </button>
            {moduleSessions?.sessions.length ? (
              <div className="session-list">
                {moduleSessions.sessions.slice(0, 4).map((session) => (
                  <article key={session.sessionId}>
	                    <div className="proof-header">
	                      <div>
	                        <span>{session.status} / {session.mode}</span>
	                        <b>{session.sessionId}</b>
	                      </div>
	                      <div className="run-actions">
	                        <button className="tiny-action" onClick={() => inspectAgentSession(session.sessionId)} disabled={sessionBusy}>
	                          Inspect
	                        </button>
	                        {sessionKind !== "cli" ? (
	                          <button className="tiny-action" onClick={() => sendSessionMessage(session.sessionId)} disabled={sessionBusy || !message.trim()}>
	                            <MessageSquare size={14} />
	                            Send here
	                          </button>
	                        ) : ["running", "stopping"].includes(session.status) ? (
	                          <button className="tiny-action" onClick={() => stopAgentSession(session.sessionId)} disabled={sessionBusy}>
	                            <X size={14} />
	                            Stop
	                          </button>
	                        ) : null}
	                      </div>
	                    </div>
                    <div className="metric-row compact">
                      <Metric label="PID" value={session.pid ? String(session.pid) : "none"} />
                      <Metric label={sessionKind === "cli" ? "Args" : "Messages"} value={sessionKind === "cli" ? String(session.argsCount) : String(session.messageCount || 0)} />
                      <Metric label="Prompt" value={`${session.promptChars} chars`} />
                      <Metric label={sessionKind === "cli" ? "Exit" : sessionKind === "hermes" ? "Profile" : "Provider"} value={sessionKind === "cli" ? session.exitCode == null ? "none" : String(session.exitCode) : sessionKind === "hermes" ? session.profile || "none" : session.provider || "router"} />
                    </div>
                    {session.stdoutTail ? <code className="session-output">{session.stdoutTail.slice(-500)}</code> : null}
                    {session.stderrTail ? <code className="session-output error">{session.stderrTail.slice(-500)}</code> : null}
                    {session.commandPreview ? <code className="session-output">{session.commandPreview}</code> : null}
                    {session.nextStep ? <p>{session.nextStep}</p> : null}
                  </article>
                ))}
	              </div>
	            ) : <p>No sessions yet. Prepare one first, then enable execution when the server gate is on.</p>}
	            {selectedSession ? (
	              <div className="session-detail-panel">
	                <div className="proof-header">
	                  <div>
	                    <b>Session detail</b>
	                    <p>{selectedSession.sessionId}</p>
	                  </div>
	                  <span>{selectedSession.status}</span>
	                </div>
	                <div className="metric-row compact">
	                  <Metric label="Mode" value={selectedSession.mode} />
	                  <Metric label="PID" value={selectedSession.pid ? String(selectedSession.pid) : "none"} />
	                  <Metric label={sessionKind === "cli" ? "Args" : "Messages"} value={sessionKind === "cli" ? String(selectedSession.argsCount) : String(selectedSession.messageCount || 0)} />
	                  <Metric label="Prompt" value={`${selectedSession.promptChars} chars`} />
	                  <Metric label={sessionKind === "cli" ? "Exit" : sessionKind === "hermes" ? "Profile" : "Provider"} value={sessionKind === "cli" ? selectedSession.exitCode == null ? "none" : String(selectedSession.exitCode) : sessionKind === "hermes" ? selectedSession.profile || "none" : selectedSession.provider || "router"} />
	                  <Metric label="Updated" value={selectedSession.updatedAt ? new Date(selectedSession.updatedAt).toLocaleTimeString() : "not yet"} />
	                </div>
	                <div className="run-actions">
	                  <button className="tiny-action" onClick={() => inspectAgentSession(selectedSession.sessionId)} disabled={sessionBusy}>
	                    Refresh detail
	                  </button>
	                  {sessionKind !== "cli" ? (
	                    <button className="tiny-action" onClick={() => sendSessionMessage(selectedSession.sessionId)} disabled={sessionBusy || !message.trim()}>
	                      Send message
	                    </button>
	                  ) : ["running", "stopping"].includes(selectedSession.status) ? (
	                    <button className="tiny-action" onClick={() => stopAgentSession(selectedSession.sessionId)} disabled={sessionBusy}>
	                      Stop session
	                    </button>
	                  ) : null}
	                </div>
	                {selectedSession.commandPreview ? (
	                  <>
	                    <b>Command preview</b>
	                    <code className="session-output detail">{selectedSession.commandPreview}</code>
	                  </>
	                ) : null}
	                {selectedSession.stdoutTail ? (
	                  <>
	                    <b>Output</b>
	                    <code className="session-output detail">{selectedSession.stdoutTail}</code>
	                  </>
	                ) : null}
	                {selectedSession.stderrTail ? (
	                  <>
	                    <b>Errors</b>
	                    <code className="session-output detail error">{selectedSession.stderrTail}</code>
	                  </>
	                ) : null}
	                {selectedSession.evidence?.length ? (
	                  <ul className="proof-list">
	                    {selectedSession.evidence.map((item) => <li key={item}>{item}</li>)}
	                  </ul>
	                ) : null}
	                {selectedSession.nextStep ? <p>{selectedSession.nextStep}</p> : null}
	              </div>
	            ) : null}
	          </section>
	        ) : null}
        {reply ? (
          <div className="test-result">
            <b>Run result</b>
            <p>{reply}</p>
          </div>
        ) : null}
        <AgentLifecyclePanel
          integration={integration}
          lastRun={lastRun}
          moduleRuns={moduleRuns}
          moduleSessions={moduleSessions}
          selectedSession={selectedSession}
          moduleLogs={moduleLogs}
          busy={busy || sessionBusy}
          onInspectRun={inspectRun}
          onRunAgain={runAgain}
          onInspectSession={inspectAgentSession}
          onOpenTarget={onOpenTarget}
          onScheduleFollowUp={scheduleAgentFollowUp}
        />
        {lastRun?.plannedExecution ? (
          <div className="proof-panel">
            <div className="proof-header">
              <b>CLI execution plan</b>
              <span>{lastRun.plannedExecution.command}</span>
            </div>
            <div className="metric-row compact">
              <Metric label="Command" value={lastRun.plannedExecution.commandPreview || lastRun.plannedExecution.command} />
              <Metric label="Args" value={String(lastRun.plannedExecution.argsCount)} />
              <Metric label="Timeout" value={`${lastRun.plannedExecution.timeoutMs}ms`} />
              <Metric label="Workspace" value={lastRun.plannedExecution.workspace.used ? "policy cwd" : lastRun.plannedExecution.workspace.configured ? "policy set" : "none"} />
            </div>
            {lastRun.plannedExecution.workspacePolicy ? <p>{lastRun.plannedExecution.workspacePolicy}</p> : null}
          </div>
        ) : null}
        {lastRun?.router?.plannedRequest ? <ProviderCallPlan plan={lastRun.router.plannedRequest} /> : null}
        {lastRun?.proof ? (
          <div className="proof-panel">
            <div className="proof-header">
              <b>Agent run proof</b>
              <span>{lastRun.proof.mode}</span>
            </div>
            <div className="metric-row compact">
              <Metric label="Run ID" value={lastRun.proof.runId} />
              <Metric label="Dry run" value={lastRun.proof.dryRun ? "yes" : "no"} />
              <Metric label="Exec gate" value={lastRun.proof.execEnabled ? "enabled" : "disabled"} />
              <Metric label="Prompt" value={`${lastRun.proof.promptChars} chars`} />
            </div>
            {lastRun.proof.handoff ? (
              <div className="handoff-grid">
                <Metric label="OS status" value={lastRun.proof.handoff.status} />
                <Metric label="Memory" value={lastRun.proof.handoff.memoryId} />
                <Metric label="Kanban" value={lastRun.proof.handoff.kanbanCardId} />
              </div>
            ) : null}
            {lastRun.control ? (
              <div className="handoff-grid">
                <Metric label="Action" value={lastRun.control.action} />
                <Metric label="Profile" value={lastRun.control.selectedProfile || "none"} />
                <Metric label="Launchd" value={lastRun.control.launchLabel || "none"} />
                {lastRun.control.queue ? <Metric label="Queue" value={lastRun.control.queue} /> : null}
                {lastRun.control.taskId ? <Metric label="Hermes task" value={lastRun.control.taskId} /> : null}
                {lastRun.control.taskStatus ? <Metric label="Task status" value={lastRun.control.taskStatus} /> : null}
                {lastRun.control.command ? <code className="control-command">{lastRun.control.command}</code> : null}
                {integration.id === "hermes" && lastRun.control.taskId ? (
                  <button className="wide-action" onClick={refreshHermesTask} disabled={busy}>
                    {busy ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
                    Refresh Hermes task
                  </button>
                ) : null}
                {integration.id === "hermes" && lastRun.control.taskId ? (
                  <div className="task-op-grid">
                    <button className="tiny-action" onClick={() => controlHermesTask("task_reclaim")} disabled={busy}>Stop claim</button>
                    <button className="tiny-action" onClick={() => controlHermesTask("task_block")} disabled={busy}>Block</button>
                    <button className="tiny-action" onClick={() => controlHermesTask("task_unblock")} disabled={busy}>Unblock</button>
                    <button className="tiny-action" onClick={() => controlHermesTask("task_promote")} disabled={busy}>Promote</button>
                    <button className="tiny-action" onClick={() => controlHermesTask("task_complete")} disabled={busy}>Complete</button>
                    <button className="tiny-action" onClick={() => controlHermesTask("task_reassign")} disabled={busy}>Reassign</button>
                    <button className="tiny-action" onClick={() => controlHermesTask("task_archive")} disabled={busy}>Archive</button>
                    <button className="tiny-action" onClick={() => controlHermesTask("task_runs")} disabled={busy}>Runs</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {lastRun.hermesTask ? (
              <div className="handoff-grid">
                <Metric label="Task title" value={lastRun.hermesTask.title || "untitled"} />
                <Metric label="Assignee" value={lastRun.hermesTask.assignee || "none"} />
                <Metric label="Runs" value={String(lastRun.hermesTask.runCount)} />
                <Metric label="Events" value={String(lastRun.hermesTask.eventCount)} />
                {lastRun.hermesTask.latestRun ? <Metric label="Latest run" value={lastRun.hermesTask.latestRun.status || "unknown"} /> : null}
              </div>
            ) : null}
            {lastRun.gateway ? (
              <div className="handoff-grid">
                <Metric label="Profiles" value={String((lastRun.gateway.profileCount as number | undefined) ?? "unknown")} />
                <Metric label="Running" value={String((lastRun.gateway.runningProfiles as number | undefined) ?? "unknown")} />
                <Metric label="Platforms" value={String((lastRun.gateway.connectedPlatforms as number | undefined) ?? "unknown")} />
                {typeof lastRun.gateway.selectedProfile === "object" && lastRun.gateway.selectedProfile ? (
                  <Metric label="Selected" value={String((lastRun.gateway.selectedProfile as Record<string, unknown>).id || "none")} />
                ) : null}
                {typeof lastRun.gateway.channel === "object" && lastRun.gateway.channel ? (
                  <Metric label="Channel" value={`${String((lastRun.gateway.channel as Record<string, unknown>).id || "unknown")} / ${String((lastRun.gateway.channel as Record<string, unknown>).state || "unknown")}`} />
                ) : null}
                {typeof lastRun.gateway.telegram === "object" && lastRun.gateway.telegram ? (
                  <Metric label="Telegram bot" value={String((lastRun.gateway.telegram as Record<string, unknown>).username || (lastRun.gateway.telegram as Record<string, unknown>).httpStatus || "checked")} />
                ) : null}
              </div>
            ) : null}
            {lastRun.proof.nextStep ? <p>{lastRun.proof.nextStep}</p> : null}
            {lastRun.proof.evidence?.length ? (
              <ul className="proof-list">
                {lastRun.proof.evidence.map((item) => <li key={item}>{item}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      <aside className="side-panel">
        <h3>Connector status</h3>
        <RuntimeCockpit
          integration={integration}
          lastRun={lastRun}
          moduleRuns={moduleRuns}
          moduleSessions={moduleSessions}
          moduleLogs={moduleLogs}
        />
        <Metric label="Status" value={statusLabel(String(integration.status))} />
        <Metric label="Category" value={integration.category || integration.type} />
        <Metric label="Configured" value={integration.configured ? "yes" : "needs setup"} />
        <Metric label="Capabilities" value={integration.capabilities?.join(", ") || "registered"} />
        <Metric label="Config fields" value={(template?.configuredFields?.length ? template.configuredFields : integration.configKeys || []).join(", ") || "none"} />
        <button className="wide-action" onClick={runTest} disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
          Test connection
        </button>
        {testResult ? <div className="test-result">{testResult}</div> : null}
        <button className="wide-action" onClick={onOpenPlugins}>
          Open plugin matrix
        </button>
        <div className="module-log-panel">
          <div className="proof-header">
            <b>Recent runs</b>
            <button onClick={() => refreshModuleLogs(integration.id)}>
              <RefreshCcw size={14} />
            </button>
          </div>
          {moduleRuns?.runs.length ? moduleRuns.runs.slice(0, 5).map((run) => (
            <article key={run.runId}>
              <span>{run.mode} / {new Date(run.loggedAt || run.requestedAt).toLocaleTimeString()}</span>
              <b>{run.action || "message"} · {run.runId}</b>
              <div className="run-chip-row">
                <small>{run.dryRun ? "dry run" : "executed"}</small>
                {run.handoff ? <small>{run.handoff.status}</small> : null}
                {run.control?.taskId ? <small>task {run.control.taskId}</small> : null}
                {run.execution?.exitCode != null ? <small>exit {run.execution.exitCode}</small> : null}
              </div>
              <div className="run-actions">
                <button className="tiny-action" onClick={() => inspectRun(run)}>Inspect proof</button>
                <button className="tiny-action" onClick={() => runAgain(run)} disabled={busy || !run.replay?.available}>
                  Run again
                </button>
              </div>
              {!run.replay?.available ? <p>{run.replay?.reason || "Fresh input required before replay."}</p> : null}
            </article>
          )) : <p>No agent runs recorded yet. Send a dry-run or real run to create proof.</p>}
        </div>
        <div className="module-log-panel">
          <div className="proof-header">
            <b>Recent logs</b>
            <button onClick={() => refreshModuleLogs(integration.id)}>
              <RefreshCcw size={14} />
            </button>
          </div>
          {moduleLogs?.logs.length ? moduleLogs.logs.slice(0, 6).map((entry) => (
            <article key={`${entry.timestamp}-${entry.message}`}>
              <span>{entry.level} / {new Date(entry.timestamp).toLocaleTimeString()}</span>
              <b>{entry.message}</b>
              {Object.keys(entry.details || {}).length ? (
                <code>{JSON.stringify(entry.details).slice(0, 220)}</code>
              ) : null}
            </article>
          )) : <p>No local events recorded yet. Run a test or dry-run to create proof.</p>}
        </div>
      </aside>
    </main>
  );
}

function ProviderCallPlan({ plan }: { plan: Record<string, unknown> }) {
  const value = (key: string, fallback = "n/a") => {
    const item = plan[key];
    return item == null || item === "" ? fallback : String(item);
  };
  return (
    <div className="proof-panel provider-call-plan">
      <div className="proof-header">
        <b>Provider call plan</b>
        <span>{value("dryRun") === "true" ? "dry run" : value("executionGate")}</span>
      </div>
      <div className="metric-row compact">
        <Metric label="Provider" value={value("provider")} />
        <Metric label="Model" value={value("model")} />
        <Metric label="Method" value={value("method")} />
        <Metric label="Prompt" value={`${value("promptLength", "0")} chars`} />
        <Metric label="Tokens" value={value("estimatedTokens")} />
        <Metric label="Cost" value={value("estimatedCost")} />
      </div>
      <div className="cockpit-proof">
        <strong>Endpoint</strong>
        <p>{value("endpoint")}</p>
      </div>
      <div className="cockpit-proof">
        <strong>Auth and gate</strong>
        <p>{value("accessMode", value("credentialMode", value("authMode", value("auth"))))} / execution gate {value("executionGate")}</p>
      </div>
      {value("missing", "") ? (
        <div className="cockpit-proof">
          <strong>Missing setup</strong>
          <p>{Array.isArray(plan.missing) ? plan.missing.join(", ") : value("missing")}</p>
        </div>
      ) : null}
      <p>{value("nextStep")}</p>
    </div>
  );
}

function RuntimeCockpit({
  integration,
  lastRun,
  moduleRuns,
  moduleSessions,
  moduleLogs
}: {
  integration: Integration;
  lastRun: ModuleRunResult | null;
  moduleRuns: ModuleRuns | null;
  moduleSessions: ModuleSessions | null;
  moduleLogs: ModuleLogs | null;
}) {
  const latestRun = moduleRuns?.runs[0] || null;
  const proof = lastRun?.proof || latestRun?.proof || null;
  const latestSession = moduleSessions?.sessions[0] || null;
  const latestLog = moduleLogs?.logs[0] || null;
  const configured = Boolean(integration.configured);
  const readyForLive = configured && String(integration.status) === "connected";
  const missing = integration.missing?.length ? integration.missing.join(", ") : "none";
  const runCount = moduleRuns?.runs.length || 0;
  const sessionCount = moduleSessions?.sessions.length || 0;
  const logCount = moduleLogs?.logs.length || 0;
  const hasProof = Boolean(proof?.handoff?.memoryId || proof?.handoff?.kanbanCardId || latestRun);
  const liveGate = proof
    ? proof.execEnabled
      ? proof.explicitExecution
        ? proof.dryRun
          ? "enabled, dry-run request"
          : "enabled, live request"
        : "enabled, not requested"
      : "disabled"
    : latestSession
      ? latestSession.execEnabled
        ? latestSession.explicitExecution
          ? "enabled, session requested"
          : "enabled, session prepared"
        : "disabled"
      : "unknown";
  const primaryNextStep = proof?.nextStep || latestRun?.nextStep || latestSession?.nextStep || integration.installHint || "Run a dashboard action to create proof.";
  const cockpitStatus = readyForLive
    ? hasProof
      ? "operational"
      : "ready"
    : configured
      ? "setup-check"
      : "needs-setup";

  return (
    <section className="runtime-cockpit">
      <div className="proof-header">
        <div>
          <b>Runtime cockpit</b>
          <p>Shows whether this card can actually run, what proof exists, and what is still missing.</p>
        </div>
        <span className={statusClass(readyForLive ? "connected" : String(integration.status))}>
          {cockpitStatus}
        </span>
      </div>
      <div className="cockpit-grid">
        <Metric label="Runtime" value={readyForLive ? "ready" : statusLabel(String(integration.status))} />
        <Metric label="Exec gate" value={liveGate} />
        <Metric label="Runs" value={String(runCount)} />
        <Metric label="Sessions" value={String(sessionCount)} />
        <Metric label="Logs" value={String(logCount)} />
        <Metric label="Proof" value={hasProof ? "recorded" : "missing"} />
      </div>
      <div className="cockpit-proof">
        <strong>{hasProof ? "Latest proof" : "Missing proof"}</strong>
        <p>
          {hasProof
            ? `${proof?.runId || latestRun?.runId || "latest run"}: ${proof?.mode || latestRun?.mode || "recorded"}${proof?.handoff?.kanbanCardId ? `, Kanban ${proof.handoff.kanbanCardId}` : ""}${proof?.handoff?.memoryId ? `, Memory ${proof.handoff.memoryId}` : ""}`
            : configured
              ? "Run a prompt, session, Hermes task, or provider health check to record proof."
              : `Configure ${missing} before this card can feel like a real control surface.`}
        </p>
      </div>
      <div className="cockpit-proof">
        <strong>Next required action</strong>
        <p>{primaryNextStep}</p>
      </div>
      {latestLog ? (
        <div className="cockpit-proof">
          <strong>Latest event</strong>
          <p>{latestLog.level}: {latestLog.message}</p>
        </div>
      ) : null}
    </section>
  );
}

function AgentLifecyclePanel({
  integration,
  lastRun,
  moduleRuns,
  moduleSessions,
  selectedSession,
  moduleLogs,
  busy,
  onInspectRun,
  onRunAgain,
  onInspectSession,
  onOpenTarget,
  onScheduleFollowUp
}: {
  integration: Integration;
  lastRun: ModuleRunResult | null;
  moduleRuns: ModuleRuns | null;
  moduleSessions: ModuleSessions | null;
  selectedSession: ModuleSession | null;
  moduleLogs: ModuleLogs | null;
  busy: boolean;
  onInspectRun: (run: ModuleRuns["runs"][number]) => void;
  onRunAgain: (run: ModuleRuns["runs"][number]) => void;
  onInspectSession: (sessionId: string) => void;
  onOpenTarget: (id: string, focusId?: string | null) => void;
  onScheduleFollowUp: () => void;
}) {
  const latestStoredRun = moduleRuns?.runs[0] || null;
  const activeSession = selectedSession || moduleSessions?.sessions[0] || null;
  const latestLog = moduleLogs?.logs[0] || null;
  const proof = lastRun?.proof || latestStoredRun?.proof || null;
  const handoff = lastRun?.handoff || proof?.handoff || latestStoredRun?.handoff || null;
  const control = lastRun?.control || latestStoredRun?.control || null;
  const execution = lastRun?.execution || latestStoredRun?.execution || null;
  const timeline = [
    {
      id: "connection",
      label: "Connection",
      status: integration.status,
      detail: integration.configured
        ? `${integration.label} is configured for ${integration.category || integration.type}.`
        : `Configure ${integration.missing?.join(", ") || "local credentials or CLI path"} before live execution.`,
      meta: integration.configured ? "ready" : "setup needed"
    },
    {
      id: "request",
      label: "Run request",
      status: proof?.status || latestStoredRun?.status || "ready_to_configure",
      detail: proof
        ? `${proof.action || "message"} run ${proof.runId} captured as ${proof.mode}.`
        : latestStoredRun
          ? `${latestStoredRun.action || "message"} run ${latestStoredRun.runId} is saved in run history.`
          : "Send a dry-run or enabled run to create proof.",
      meta: proof ? `${proof.promptChars} prompt chars` : "no proof yet"
    },
    {
      id: "adapter",
      label: "Tool or model call",
      status: execution ? "completed" : activeSession ? activeSession.status : proof?.mode || "ready_to_configure",
      detail: execution
        ? `${execution.adapterId} finished with exit ${execution.exitCode ?? "none"} in ${execution.durationMs}ms.`
        : activeSession
          ? `${activeSession.moduleLabel} session ${activeSession.sessionId} is ${activeSession.status}.`
          : lastRun?.provider
            ? `${lastRun.provider}${lastRun.model ? ` / ${lastRun.model}` : ""} was selected.`
            : "Open a session or run a task to see the called adapter/provider.",
      meta: execution ? `${execution.stdoutBytes} stdout bytes` : activeSession ? `${activeSession.mode}` : "waiting"
    },
    {
      id: "memory",
      label: "Memory",
      status: handoff?.memoryId ? "completed" : "ready_to_configure",
      detail: handoff?.memoryId
        ? `Run proof saved to local memory ${handoff.memoryId}.`
        : "Agent run memory appears after a dashboard run creates handoff proof.",
      meta: handoff?.memoryId || "not recorded"
    },
    {
      id: "handoff",
      label: "Kanban handoff",
      status: handoff?.status || control?.taskStatus || "ready_to_configure",
      detail: handoff?.kanbanCardId
        ? `Kanban card ${handoff.kanbanCardId} tracks this agent run.`
        : control?.taskId
          ? `Hermes task ${control.taskId} is ${control.taskStatus || "tracked"}.`
          : "Handoff card appears when the run records a task or approval.",
      meta: handoff?.kanbanCardId || control?.taskId || "not created"
    },
    {
      id: "follow-up",
      label: "Next action",
      status: proof?.replay?.available ? "implemented" : proof ? "partial" : "ready_to_configure",
      detail: proof?.nextStep || latestStoredRun?.nextStep || activeSession?.nextStep || "No next action recorded yet.",
      meta: proof?.replay?.available ? "replay ready" : latestStoredRun?.replay?.available ? "history replay ready" : "manual follow-up"
    },
    {
      id: "logs",
      label: "Audit log",
      status: latestLog ? latestLog.level : "ready_to_configure",
      detail: latestLog ? latestLog.message : "Run a test, session, or task to create an audit log event.",
      meta: latestLog ? new Date(latestLog.timestamp).toLocaleTimeString() : "no events"
    }
  ];

  return (
    <section className="lifecycle-panel">
      <div className="proof-header">
        <div>
          <b>Agent lifecycle</b>
          <p>One view of the local loop: connection, run, adapter call, memory, handoff, next action, and logs.</p>
        </div>
        <span>{proof?.mode || activeSession?.mode || statusLabel(String(integration.status))}</span>
      </div>
      <div className="lifecycle-timeline">
        {timeline.map((item) => (
          <article className="lifecycle-step" key={item.id}>
            <span className={statusClass(String(item.status))}>{statusLabel(String(item.status))}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
              <small>{item.meta}</small>
            </div>
          </article>
        ))}
      </div>
      <div className="run-actions">
        {handoff?.memoryId ? (
          <button className="tiny-action" onClick={() => onOpenTarget("memory", handoff.memoryId)} disabled={busy}>
            Open memory
          </button>
        ) : null}
        {handoff?.kanbanCardId || control?.taskId ? (
          <button className="tiny-action" onClick={() => onOpenTarget("kanban", handoff?.kanbanCardId || control?.taskId || null)} disabled={busy}>
            Open Kanban
          </button>
        ) : null}
        {latestStoredRun ? (
          <button className="tiny-action" onClick={() => onInspectRun(latestStoredRun)} disabled={busy}>
            Inspect latest proof
          </button>
        ) : null}
        {latestStoredRun?.replay?.available ? (
          <button className="tiny-action" onClick={() => onRunAgain(latestStoredRun)} disabled={busy}>
            Run latest again
          </button>
        ) : null}
        {activeSession ? (
          <button className="tiny-action" onClick={() => onInspectSession(activeSession.sessionId)} disabled={busy}>
            Inspect latest session
          </button>
        ) : null}
        <button className="tiny-action" onClick={onScheduleFollowUp} disabled={busy}>
          Schedule follow-up
        </button>
        <button className="tiny-action" onClick={() => onOpenTarget("scheduler")} disabled={busy}>
          Open Scheduler
        </button>
      </div>
    </section>
  );
}

function defaultSelfForm(id: string): Record<string, string> {
  if (id === "usage-credits") return { title: "", provider: "", units: "", estimatedCost: "" };
  if (id === "kanban") return { title: "", column: "todo", status: "open", priority: "normal", notes: "" };
  if (id === "notebook") return { title: "", body: "" };
  return { title: "", status: "open", notes: "" };
}

function itemDetail(item: SelfModuleItem) {
  const parts = [
    item.status,
    item.column,
    item.priority,
    item.approvalStatus,
    item.sourceType,
    item.provider,
    item.keyword,
    item.workflow,
    item.captionProvider,
    item.renderPreset,
    item.url,
    item.sourcePath,
    item.loopCount != null ? `${item.loopCount} loop${item.loopCount === 1 ? "" : "s"}` : "",
    item.auditCount != null ? `${item.auditCount} audit${item.auditCount === 1 ? "" : "s"}` : "",
    item.discoveryCount != null ? `${item.discoveryCount} discover${item.discoveryCount === 1 ? "y" : "ies"}` : "",
    item.rankCount != null ? `${item.rankCount} rank${item.rankCount === 1 ? "" : "s"}` : "",
    item.scrapeStatus,
    item.searchStatus,
    item.units != null ? `${item.units} units` : "",
    item.estimatedCost != null ? `$${Number(item.estimatedCost).toFixed(4)}` : ""
  ].filter(Boolean);
  return parts.join(" / ") || "local item";
}

function UsageCreditsControl({
  integration,
  onOpenPlugins
}: {
  integration: Integration;
  onOpenPlugins: () => void;
}) {
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [dailyLimit, setDailyLimit] = useState("");
  const [monthlyLimit, setMonthlyLimit] = useState("");
  const [warningThreshold, setWarningThreshold] = useState("0.8");
  const [manualProvider, setManualProvider] = useState("manual");
  const [manualUnits, setManualUnits] = useState("");
  const [manualCost, setManualCost] = useState("");
  const [reconcileProvider, setReconcileProvider] = useState("all");
  const [billingProvider, setBillingProvider] = useState("anthropic");
  const [billingSourceName, setBillingSourceName] = useState("provider invoice export");
  const [billingText, setBillingText] = useState("date,provider,model,units,cost,currency,invoice_id,description\n2026-07-01,anthropic,claude-3-5-sonnet,12000,0.42,usd,inv_sample,Imported provider invoice line");
  const [billingPreview, setBillingPreview] = useState<UsageBillingImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function refresh() {
    const data = await getUsageState();
    setUsage(data);
    setDailyLimit(data.config.dailyLimit ? String(data.config.dailyLimit) : "");
    setMonthlyLimit(data.config.monthlyLimit ? String(data.config.monthlyLimit) : "");
    setWarningThreshold(String(data.config.warningThreshold || 0.8));
  }

  useEffect(() => {
    refresh().catch((err) => setResult(err instanceof Error ? err.message : "Unable to load usage credits"));
  }, []);

  async function saveBudget() {
    setBusy(true);
    setResult(null);
    try {
      const next = await configureUsageBudget({
        dailyLimit: Number(dailyLimit || 0),
        monthlyLimit: Number(monthlyLimit || 0),
        warningThreshold: Number(warningThreshold || 0.8)
      });
      setUsage(next);
      setResult("Usage budget saved.");
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Budget save failed");
    } finally {
      setBusy(false);
    }
  }

  async function addManualRecord() {
    setBusy(true);
    setResult(null);
    try {
      await recordUsageEvent({
        provider: manualProvider,
        units: Number(manualUnits || 0),
        estimatedCost: Number(manualCost || 0),
        operation: "manual",
        mode: "manual",
        status: "recorded",
        title: `Manual ${manualProvider} usage`
      });
      setManualUnits("");
      setManualCost("");
      await refresh();
      setResult("Manual usage record saved.");
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Manual usage save failed");
    } finally {
      setBusy(false);
    }
  }

  async function runReconciliation() {
    setBusy(true);
    setResult(null);
    try {
      const output = await runUsageReconciliation({ provider: reconcileProvider });
      await refresh();
      const completed = output.results.filter((item) => item.status === "connected").length;
      const setup = output.results.filter((item) => item.status === "ready_to_configure").length;
      const unsupported = output.results.filter((item) => item.status === "unsupported").length;
      const errors = output.results.filter((item) => item.status === "error").length;
      setResult(`Billing reconciliation checked ${output.results.length} source${output.results.length === 1 ? "" : "s"}: ${completed} connected, ${setup} setup, ${unsupported} unsupported, ${errors} error.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Billing reconciliation failed");
    } finally {
      setBusy(false);
    }
  }

  async function previewBillingImport() {
    setBusy(true);
    setResult(null);
    try {
      const output = await previewUsageBillingImport({
        provider: billingProvider,
        sourceName: billingSourceName,
        text: billingText
      });
      setBillingPreview(output);
      setResult(`Billing import preview: ${output.summary.valid} valid, ${output.summary.invalid} invalid, ${output.summary.duplicates} duplicate.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Billing import preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function importBillingRows() {
    setBusy(true);
    setResult(null);
    try {
      const output = await importUsageBilling({
        provider: billingProvider,
        sourceName: billingSourceName,
        text: billingText
      });
      setUsage(output.usage);
      setBillingPreview(output.preview);
      setResult(`Imported ${output.imported.length} billing row${output.imported.length === 1 ? "" : "s"}; skipped ${output.skipped.length}.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Billing import failed");
    } finally {
      setBusy(false);
    }
  }

  const dailyStatus = usage?.summary.daily;
  const monthlyStatus = usage?.summary.monthly;
  const reconciliationProviders = usage?.reconciliation.providers || [];

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <Gauge size={16} />
            Usage Credits
          </span>
          <h1>Track provider spend</h1>
          <p>Provider Router records usage automatically. Budgets can warn or block real executions before they spend credits.</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Budget limits</b>
            <div className="config-grid">
              <label>
                <span>Daily limit USD</span>
                <input value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} inputMode="decimal" placeholder="0 disables" />
              </label>
              <label>
                <span>Monthly limit USD</span>
                <input value={monthlyLimit} onChange={(event) => setMonthlyLimit(event.target.value)} inputMode="decimal" placeholder="0 disables" />
              </label>
              <label>
                <span>Warning threshold</span>
                <input value={warningThreshold} onChange={(event) => setWarningThreshold(event.target.value)} inputMode="decimal" />
              </label>
            </div>
            <button className="wide-action" onClick={saveBudget} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
              Save budget
            </button>
          </div>

          <div className="setup-row">
            <b>Manual usage record</b>
            <div className="config-grid">
              <label>
                <span>Provider</span>
                <input value={manualProvider} onChange={(event) => setManualProvider(event.target.value)} />
              </label>
              <label>
                <span>Units</span>
                <input value={manualUnits} onChange={(event) => setManualUnits(event.target.value)} inputMode="decimal" />
              </label>
              <label>
                <span>Estimated cost</span>
                <input value={manualCost} onChange={(event) => setManualCost(event.target.value)} inputMode="decimal" />
              </label>
            </div>
            <button className="wide-action" onClick={addManualRecord} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
              Add record
            </button>
            {result ? <div className="test-result">{result}</div> : null}
          </div>

          <div className="setup-row">
            <b>Provider billing reconciliation</b>
            <p>Reconcile local estimates with provider-reported billing where a supported API exists. Missing keys and unsupported providers are reported honestly.</p>
            <div className="config-grid">
              <label>
                <span>Source</span>
                <select value={reconcileProvider} onChange={(event) => setReconcileProvider(event.target.value)}>
                  <option value="all">All reconciliation sources</option>
                  {reconciliationProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Last update</span>
                <input readOnly value={usage?.reconciliation.updatedAt || "not checked"} />
              </label>
            </div>
            <button className="wide-action" onClick={runReconciliation} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
              Reconcile billing
            </button>
            <div className="local-list">
              {reconciliationProviders.map((provider) => {
                const comparison = provider.comparison;
                const reported = comparison?.providerReported == null ? "n/a" : `$${Number(comparison.providerReported).toFixed(4)}`;
                const local = comparison?.localEstimate == null ? "n/a" : `$${Number(comparison.localEstimate).toFixed(4)}`;
                const delta = comparison?.delta == null ? "n/a" : `$${Number(comparison.delta).toFixed(4)}`;
                return (
                  <article className="local-item" key={provider.id}>
                    <strong>{provider.label}</strong>
                    <span>{statusLabel(provider.status)} / {provider.basis}</span>
                    <p>{provider.publicSummary}</p>
                    {provider.missing?.length ? <p>Missing: {provider.missing.join(", ")}</p> : null}
                    {comparison ? <p>Provider: {reported} / Local: {local} / Delta: {delta}</p> : null}
                  </article>
                );
              })}
            </div>
          </div>

          <div className="setup-row">
            <b>Billing import</b>
            <p>Import CSV or JSON invoice exports for providers without a supported billing API. Preview rejects unsafe text, invalid currencies, and duplicates before writing to the ledger.</p>
            <div className="config-grid">
              <label>
                <span>Default provider</span>
                <select value={billingProvider} onChange={(event) => setBillingProvider(event.target.value)}>
                  {["anthropic", "gemini", "minimax", "firecrawl", "openai", "openrouter", "ollama", "manual"].map((provider) => (
                    <option key={provider} value={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Source name</span>
                <input value={billingSourceName} onChange={(event) => setBillingSourceName(event.target.value)} />
              </label>
              <label className="is-wide">
                <span>CSV / JSON export</span>
                <textarea value={billingText} onChange={(event) => setBillingText(event.target.value)} rows={6} />
              </label>
            </div>
            <div className="action-row">
              <button className="wide-action" onClick={previewBillingImport} disabled={busy}>
                {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                Preview import
              </button>
              <button className="wide-action" onClick={importBillingRows} disabled={busy || !billingPreview?.summary.valid}>
                {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                Import valid rows
              </button>
            </div>
            {billingPreview ? (
              <div className="local-list">
                <article className="local-item">
                  <strong>{billingPreview.sourceName}</strong>
                  <span>{billingPreview.summary.valid} valid / {billingPreview.summary.invalid} invalid / {billingPreview.summary.duplicates} duplicates</span>
                  <p>{billingPreview.summary.totalUnits} units / ${Number(billingPreview.summary.totalEstimatedCost || 0).toFixed(4)}</p>
                </article>
                {billingPreview.records.slice(0, 6).map((record) => (
                  <article className="local-item" key={`${record.rowNumber}-${record.requestId}`}>
                    <strong>{record.provider} row {record.rowNumber}</strong>
                    <span>{record.valid ? "ready" : record.errors.join(", ")}</span>
                    <p>{record.model || "no model"} / {record.units} units / ${Number(record.estimatedCost || 0).toFixed(4)}</p>
                  </article>
                ))}
              </div>
            ) : null}
          </div>

          <div className="setup-row">
            <b>Ledger</b>
            <div className="local-list">
              {usage?.items.length ? usage.items.slice(0, 16).map((item) => (
                <article className="local-item" key={item.id}>
                  <strong>{item.title}</strong>
                  <span>{itemDetail(item)}</span>
                  {item.model || item.operation ? <p>{[item.operation, item.model, item.mode].filter(Boolean).join(" / ")}</p> : null}
                </article>
              )) : <p>No usage records yet. Router dry-runs and executions will appear here.</p>}
            </div>
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Budget status</h3>
        <Metric label="Status" value={statusLabel(String(integration.status))} />
        <Metric label="Calls" value={String(usage?.summary.total.calls || 0)} />
        <Metric label="Units" value={String(usage?.summary.total.units || 0)} />
        <Metric label="Total spend" value={`$${Number(usage?.summary.total.estimatedCost || 0).toFixed(4)}`} />
        <Metric label="Today" value={`$${Number(dailyStatus?.estimatedCost || 0).toFixed(4)}${dailyStatus?.limit ? ` / $${dailyStatus.limit}` : ""}`} />
        <Metric label="Month" value={`$${Number(monthlyStatus?.estimatedCost || 0).toFixed(4)}${monthlyStatus?.limit ? ` / $${monthlyStatus.limit}` : ""}`} />
        <Metric label="Daily warning" value={dailyStatus?.warning ? "yes" : "no"} />
        <Metric label="Monthly warning" value={monthlyStatus?.warning ? "yes" : "no"} />
        <Metric label="Billing checks" value={String(usage?.reconciliation.summary.connected || 0)} />
        <Metric label="Needs billing setup" value={String(usage?.reconciliation.summary.readyToConfigure || 0)} />
        <button className="wide-action" onClick={onOpenPlugins}>
          Open provider cards
        </button>
      </aside>
    </main>
  );
}

function SelfModuleControl({
  integration,
  onOpenPlugins,
  focusId
}: {
  integration: Integration;
  onOpenPlugins: () => void;
  focusId?: string | null;
}) {
  const [state, setState] = useState<SelfModuleState | null>(null);
  const [form, setForm] = useState<Record<string, string>>(() => defaultSelfForm(integration.id));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [goalLoopResult, setGoalLoopResult] = useState<GoalLoopResult | null>(null);
  const [goalLoopProvider, setGoalLoopProvider] = useState("");
  const [goalLoopContext, setGoalLoopContext] = useState("");
  const [executeGoalLoop, setExecuteGoalLoop] = useState(false);
  const visibleItems = useMemo(() => {
    const base = state?.items.slice(0, 12) || [];
    if (!focusId || base.some((item) => item.id === focusId)) return base;
    const focused = state?.items.find((item) => item.id === focusId);
    return focused ? [focused, ...base].slice(0, 12) : base;
  }, [focusId, state]);

  useEffect(() => {
    setState(null);
    setForm(defaultSelfForm(integration.id));
    setResult(null);
    setGoalLoopResult(null);
    setGoalLoopProvider("");
    setGoalLoopContext("");
    setExecuteGoalLoop(false);
    getSelfModule(integration.id)
      .then(setState)
      .catch((err) => setResult(err instanceof Error ? err.message : "Unable to load local module"));
  }, [integration.id]);

  function updateField(field: string, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function createItem() {
    setBusy(true);
    setResult(null);
    try {
      const payload: Record<string, string | number> = { ...form };
      if (integration.id === "usage-credits") {
        payload.units = Number(form.units || 0);
        payload.estimatedCost = Number(form.estimatedCost || 0);
      }
      const next = await createSelfModuleItem(integration.id, payload);
      setState(next);
      setForm(defaultSelfForm(integration.id));
      setResult(`Saved ${next.itemName}.`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function runGoalPlanner(goalId: string) {
    setBusy(true);
    setResult(null);
    setGoalLoopResult(null);
    try {
      const output = await runGoalLoop(goalId, {
        provider: goalLoopProvider || undefined,
        context: goalLoopContext || undefined,
        dryRun: !executeGoalLoop
      });
      setState(output.state);
      setGoalLoopResult(output);
      setResult(output.ok
        ? `Goal loop ${output.run.status} through ${output.run.provider || "provider router"}.`
        : output.router.message || "Goal loop needs provider configuration.");
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Goal loop failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content two-column">
      <section className="control-room">
        <div className="control-header">
          <span className="eyebrow">
            <Command size={16} />
            Local module
          </span>
          <h1>{integration.label}</h1>
          <p>{integration.publicSummary}</p>
        </div>

        <section className="setup-panel">
          <div className="setup-row">
            <b>Create {state?.itemName || "item"}</b>
            <div className="config-grid">
              <label>
                <span>Title</span>
                <input
                  value={form.title || ""}
                  onChange={(event) => updateField("title", event.target.value)}
                  placeholder={`${integration.label} title`}
                />
              </label>
              {integration.id === "goals" ? (
                <label>
                  <span>Status</span>
                  <input value={form.status || ""} onChange={(event) => updateField("status", event.target.value)} />
                </label>
              ) : null}
              {integration.id === "kanban" ? (
                <>
                  <label>
                    <span>Column</span>
                    <input value={form.column || ""} onChange={(event) => updateField("column", event.target.value)} />
                  </label>
                  <label>
                    <span>Status</span>
                    <input value={form.status || ""} onChange={(event) => updateField("status", event.target.value)} />
                  </label>
                  <label>
                    <span>Priority</span>
                    <input value={form.priority || ""} onChange={(event) => updateField("priority", event.target.value)} />
                  </label>
                </>
              ) : null}
              {integration.id === "usage-credits" ? (
                <>
                  <label>
                    <span>Provider</span>
                    <input value={form.provider || ""} onChange={(event) => updateField("provider", event.target.value)} placeholder="openai" />
                  </label>
                  <label>
                    <span>Units</span>
                    <input value={form.units || ""} onChange={(event) => updateField("units", event.target.value)} inputMode="decimal" />
                  </label>
                  <label>
                    <span>Estimated cost</span>
                    <input value={form.estimatedCost || ""} onChange={(event) => updateField("estimatedCost", event.target.value)} inputMode="decimal" />
                  </label>
                </>
              ) : null}
              {integration.id !== "usage-credits" ? (
                <label className="is-wide">
                  <span>{integration.id === "notebook" ? "Body" : "Notes"}</span>
                  <textarea
                    value={form.body || form.notes || ""}
                    onChange={(event) => updateField(integration.id === "notebook" ? "body" : "notes", event.target.value)}
                    placeholder="Local private text"
                  />
                </label>
              ) : null}
            </div>
            <button className="wide-action" onClick={createItem} disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Settings size={18} />}
              Save local {state?.itemName || "item"}
            </button>
            {result ? <div className="test-result">{result}</div> : null}
          </div>

          {integration.id === "goals" ? (
            <div className="setup-row">
              <b>Provider-router goal loop</b>
              <p>Plans one step through the Provider Router. Dry-run is the default; execution still requires the server run gate.</p>
              <div className="config-grid">
                <label>
                  <span>Provider override</span>
                  <input value={goalLoopProvider} onChange={(event) => setGoalLoopProvider(event.target.value)} placeholder="openrouter, ollama, minimax..." />
                </label>
                <label>
                  <span>Mode</span>
                  <input readOnly value={executeGoalLoop ? "execute when server allows" : "dry-run"} />
                </label>
                <label className="is-wide">
                  <span>Loop context</span>
                  <textarea value={goalLoopContext} onChange={(event) => setGoalLoopContext(event.target.value)} placeholder="Optional current evidence, blocker, or instruction for the next loop." />
                </label>
              </div>
              <label className="inline-check">
                <input type="checkbox" checked={executeGoalLoop} onChange={(event) => setExecuteGoalLoop(event.target.checked)} />
                Execute provider call when the trusted execution gate is enabled
              </label>
              {goalLoopResult ? (
                <article className="local-item">
                  <strong>{goalLoopResult.run.status}</strong>
                  <span>{goalLoopResult.run.mode} / {goalLoopResult.run.provider || "no provider"} / {goalLoopResult.run.model || "model pending"}</span>
                  <p>{goalLoopResult.run.nextAction || goalLoopResult.router.message}</p>
                </article>
              ) : null}
            </div>
          ) : null}

          <div className="setup-row">
            <b>Local records</b>
            <div className="local-list">
              {visibleItems.length ? (
                visibleItems.map((item) => (
                  <article key={item.id} className={item.id === focusId ? "local-item is-focused" : "local-item"}>
                    <strong>{item.title}</strong>
                    <span>{itemDetail(item)}</span>
                    {item.body || item.notes ? <p>{item.body || item.notes}</p> : null}
                    {integration.id === "kanban" && (item.workflowId || item.schedulerJobId) ? (
                      <p>{item.workflowId ? `Workflow ${item.workflowId}` : ""}{item.runId ? ` / run ${item.runId}` : ""}{item.schedulerJobId ? `Scheduler ${item.schedulerJobId}` : ""}</p>
                    ) : null}
                    {integration.id === "goals" && item.nextAction ? <p>Next: {item.nextAction}</p> : null}
                    {integration.id === "goals" && item.plan?.length ? (
                      <ul className="compact-list">
                        {item.plan.slice(0, 5).map((step, index) => <li key={`${item.id}-plan-${index}`}>{step}</li>)}
                      </ul>
                    ) : null}
                    {integration.id === "goals" ? (
                      <div className="mini-actions">
                        <button onClick={() => runGoalPlanner(item.id)} disabled={busy}>
                          {busy ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                          Run goal loop
                        </button>
                        {item.lastRunAt ? <span>{new Date(item.lastRunAt).toLocaleString()}</span> : null}
                      </div>
                    ) : null}
                  </article>
                ))
              ) : (
                <p>No local records yet.</p>
              )}
            </div>
          </div>
        </section>
      </section>

      <aside className="side-panel">
        <h3>Local status</h3>
        <Metric label="Status" value={statusLabel(String(integration.status))} />
        <Metric label="Items" value={String(state?.summary.total ?? 0)} />
        <Metric label="Updated" value={state?.updatedAt ? new Date(state.updatedAt).toLocaleString() : "not yet"} />
        {integration.id === "goals" ? (
          <>
            <Metric label="Active goals" value={String(state?.summary.goals?.active ?? 0)} />
            <Metric label="Loop runs" value={String(state?.summary.goals?.loopRuns ?? 0)} />
            <Metric label="Last loop" value={state?.summary.goals?.lastRunAt ? new Date(state.summary.goals.lastRunAt).toLocaleString() : "not yet"} />
          </>
        ) : null}
        {integration.id === "kanban" ? (
          <>
            <Metric label="Pending approvals" value={String(state?.summary.kanban?.pendingApprovals ?? 0)} />
            <Metric label="Workflow cards" value={String(state?.summary.kanban?.workflowCards ?? 0)} />
            <Metric label="Scheduler cards" value={String(state?.summary.kanban?.schedulerCards ?? 0)} />
          </>
        ) : null}
        {integration.id === "usage-credits" ? (
          <>
            <Metric label="Units" value={String(state?.summary.usage.units ?? 0)} />
            <Metric label="Estimated spend" value={`$${Number(state?.summary.usage.estimatedCost || 0).toFixed(4)}`} />
          </>
        ) : null}
        <Metric label="Capabilities" value={integration.capabilities?.join(", ") || "local app"} />
        <button className="wide-action" onClick={onOpenPlugins}>
          Open plugin matrix
        </button>
      </aside>
    </main>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="hero-panel">
      <div className="hero-copy">
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
    </section>
  );
}

function Drawer({
  integration,
  onClose
}: {
  integration: Integration | null;
  onClose: () => void;
}) {
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!integration) return null;

  async function runTest() {
    setBusy(true);
    setResult(null);
    try {
      const data = await testIntegration(integration!.id);
      setResult(data.message);
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <button className="drawer-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <span className="eyebrow">
          <ShieldCheck size={16} />
          Connection detail
        </span>
        <h2>{integration.label}</h2>
        <p>{integration.connection}</p>
        <div className="drawer-stack">
          <Metric label="Status" value={statusLabel(String(integration.status))} />
          <Metric label="Category" value={integration.category || integration.type} />
          <Metric label="Configured" value={integration.configured ? "yes" : "needs setup"} />
          <Metric label="Missing" value={integration.missing?.length ? integration.missing.join(", ") : "none"} />
        </div>
        <button className="wide-action" onClick={runTest} disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
          Test connection
        </button>
        {result ? <div className="test-result">{result}</div> : null}
      </aside>
    </div>
  );
}

export default function App() {
  const { snapshot, health, error, loading, refresh } = useRuntime();
  const [selected, setSelected] = useState("mission");
  const [focus, setFocus] = useState<{ section: string; id: string | null } | null>(null);
  const [drawer, setDrawer] = useState<Integration | null>(null);
  const sectionLabel = currentSectionLabel(selected);
  const selectedModule = Boolean(snapshot?.integrations.some((item) => item.id === selected && !isDashboardHiddenModule(item.id)));
  function openTarget(id: string, focusId: string | null = null) {
    setSelected(id);
    setFocus(focusId ? { section: id, id: focusId } : null);
  }

  return (
    <div className="app-shell">
      <Sidebar selected={selected} onSelect={(id) => openTarget(id)} />
      <section className="workspace">
        <TopBar sectionLabel={sectionLabel} health={health} snapshot={snapshot} loading={loading} onRefresh={refresh} />
        {selected === "mission" ? (
          <MissionControl
            snapshot={snapshot}
            error={error}
            onOpenAgent={(id) => openTarget(id)}
            onOpenPlugins={() => openTarget("plugins")}
            onOpenDrawer={setDrawer}
          />
        ) : selected === "plugins" ? (
          <PluginsPage snapshot={snapshot} onOpenDrawer={setDrawer} />
        ) : selected === "setup" ? (
          <SetupPage onOpenTarget={(id) => openTarget(id)} />
        ) : selected === "voice-control" ? (
          <VoiceControlPage onOpenAgent={(id) => openTarget(id)} />
        ) : selected === "workflows" ? (
          <WorkflowsPage />
        ) : selected === "provider-router" ? (
          <ProviderRouterPage onOpenPlugins={() => setSelected("plugins")} />
        ) : selected === "scheduler" ? (
          <SchedulerPage focusId={focus?.section === "scheduler" ? focus.id : null} />
        ) : selected === "memory" ? (
          <MemoryPage focusId={focus?.section === "memory" ? focus.id : null} />
        ) : selected === "skill-registry" ? (
          <SkillRegistryPage />
        ) : selected === "agent-builder" ? (
          <AgentBuilderPage />
        ) : selectedModule || agentItems.some((item) => item.id === selected) || providerItems.some((item) => item.id === selected) || selfItems.some((item) => item.id === selected) ? (
          <ControlRoom
            id={selected}
            snapshot={snapshot}
            onOpenPlugins={() => openTarget("plugins")}
            onOpenTarget={openTarget}
            onSnapshotRefresh={refresh}
            focusId={focus?.section === selected ? focus.id : null}
          />
        ) : (
          <main className="content">
            <EmptyPanel title="Workspace module wired" body={`${selected} is part of the hub shell and ready for the next workflow panel.`} />
          </main>
        )}
      </section>
      <Drawer integration={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
