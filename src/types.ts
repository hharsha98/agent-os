export type ModuleStatus =
  | "connected"
  | "ready_to_configure"
  | "missing_dependency"
  | "error"
  | "disabled"
  | string;

export interface RuntimeModule {
  id: string;
  label: string;
  category: string;
  type: string;
  status: ModuleStatus;
  capabilities: string[];
  configured: boolean;
  missing: string[];
  lastChecked: string;
  actions: string[];
  publicSummary: string;
  connection: string;
  version?: string | null;
	  profile?: string | null;
	  profileCount?: number;
	  onlineProfiles?: number;
	  activeProfile?: string | null;
	  profiles?: Array<{
	    id: string;
	    gatewayState: string;
	    activeAgents: number | null;
	    connectedPlatforms: number;
	    platformCount: number;
	    channels: number;
	    launchdLoaded: boolean;
	    launchdPid: number | null;
	    hasConfig: boolean;
	    hasEnv: boolean;
	  }>;
	  stats?: Record<string, unknown>;
  configKeys?: string[];
  installHint?: string;
  installCommand?: string;
  installMode?: string;
  docsUrl?: string;
	  taskProfiles?: Array<{
	    id: string;
	    label: string;
	    description: string;
	    prompt: string;
	    action?: string;
	    input?: Record<string, unknown>;
	  }>;
  [key: string]: unknown;
}

export interface ModuleRunExecution {
  runId: string;
  adapterId: string;
  moduleId: string;
  command: string;
  commandPreview?: string;
  configuredPath: boolean;
  argsCount: number;
  promptChars: number;
  timeoutMs: number;
  workspace: {
    configured: boolean;
    used: boolean;
  };
  workspacePolicy?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | string | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
}

export interface ModuleRunProof {
  runId: string;
  moduleId: string;
  moduleLabel: string;
  moduleType: string;
  status: string;
  mode: string;
  requestedAt: string;
  dryRun: boolean;
  execEnabled: boolean;
  explicitExecution: boolean;
  promptChars: number;
  action: string;
  nextStep: string;
  evidence: string[];
  handoff?: {
    memoryId: string;
    kanbanCardId: string;
    status: string;
  } | null;
  replay?: {
    available: boolean;
    reason: string;
    input: Record<string, unknown> | null;
  };
}

export interface ModuleRunResult {
  ok: boolean;
  mode: string;
  reply: string;
  plannedCommand?: string;
  plannedExecution?: Pick<ModuleRunExecution, "runId" | "adapterId" | "moduleId" | "command" | "commandPreview" | "configuredPath" | "argsCount" | "promptChars" | "timeoutMs" | "workspace" | "workspacePolicy"> | null;
  module?: RuntimeModule;
  execution?: ModuleRunExecution;
  provider?: string;
  model?: string | null;
  router?: RouterRunResult;
  hermes?: Record<string, unknown>;
  gateway?: Record<string, unknown>;
  voice?: {
    runId: string;
    transcript: string;
    command: string;
    plan: VoiceCommandPlan;
    actions: VoiceActionResult[];
    tools: VoiceControlStatus["tools"];
  };
  hermesTask?: {
    id: string | null;
    title: string | null;
    status: string | null;
    assignee: string | null;
    priority: number | null;
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    latestSummaryPresent: boolean;
    runCount: number;
    eventCount: number;
    latestRun: {
      id: string | number | null;
      profile: string | null;
      status: string | null;
      outcome: string | null;
      startedAt: string | null;
      endedAt: string | null;
    } | null;
  } | null;
  control?: {
    action: string;
    selectedProfile: string | null;
    launchLabel: string | null;
    command: string | null;
    executed: boolean;
    queue?: string | null;
    taskId?: string | null;
    taskStatus?: string | null;
  };
  proof?: ModuleRunProof;
  handoff?: ModuleRunProof["handoff"];
}

export interface VoiceControlStatus {
  id: "voice-control";
  label: string;
  status: string;
  configured: boolean;
  missing: string[];
  model: string;
  wakeWords: string[];
  tools: {
    osascript: boolean;
    open: boolean;
    screencapture: boolean;
    mdfind: boolean;
    cliclick: boolean;
    codex: boolean;
    codexGptPlanner: boolean;
    executionGate: boolean;
    executionGateSource: string;
    shellGate: boolean;
    accessibility: boolean;
    frontApp?: string | null;
    frontWindow?: string | null;
    model: string;
  };
  capabilities: string[];
  publicSummary: string;
}

export interface VoiceDesktopContext {
  ok: boolean;
  accessibility: boolean;
  frontApp: string | null;
  frontWindow: string | null;
  windowCount: number;
  uiElementCount: number;
  uiLabels: string[];
  error: string | null;
}

export interface VoiceCommandPlan {
  id: string;
  createdAt: string;
  source: string;
  wakeWordDetected: boolean;
  transcript: string;
  command: string;
  intent: string;
  summary: string;
  confidence: number;
  actions: Array<Record<string, unknown> & { type: string }>;
  warnings: string[];
}

export interface VoiceActionResult {
  type: string;
  ok: boolean;
  dryRun: boolean;
  summary: string;
  output: unknown;
  command: string | null;
  error: string | null;
}

export interface VoiceCommandResult {
  ok: boolean;
  runId: string;
  mode: string;
  reply: string;
  startedAt: string;
  completedAt: string;
  transcript: string;
  command: string;
  plan: VoiceCommandPlan;
  actions: VoiceActionResult[];
  tools: VoiceControlStatus["tools"];
  proof: ModuleRunProof;
}

export interface ModuleLogEntry {
  timestamp: string;
  level: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ModuleLogs {
  id: string;
  logs: ModuleLogEntry[];
}

export interface ModuleRunHistoryItem {
  runId: string;
  moduleId: string;
  moduleLabel: string;
  mode: string;
  status: string;
  action: string;
  requestedAt: string;
  loggedAt: string;
  dryRun: boolean;
  execEnabled: boolean;
  explicitExecution: boolean;
  promptChars: number;
  nextStep: string;
  evidence: string[];
  handoff: ModuleRunProof["handoff"];
  replay: NonNullable<ModuleRunProof["replay"]>;
  proof: ModuleRunProof;
  execution: Pick<ModuleRunExecution, "adapterId" | "exitCode" | "durationMs" | "stdoutBytes" | "stderrBytes"> | null;
  control: ModuleRunResult["control"] | null;
}

export interface ModuleRuns {
  id: string;
  runs: ModuleRunHistoryItem[];
}

export interface AgentRunHistoryItem extends ModuleRunHistoryItem {
  moduleCategory: string;
  moduleType: string;
  moduleStatus: string;
  moduleConfigured: boolean;
}

export interface AgentRuns {
  id: "agent-runs";
  generatedAt: string;
  summary: {
    total: number;
    executed: number;
    dryRun: number;
    blocked: number;
    withMemory: number;
    withKanban: number;
    replayable: number;
  };
  runs: AgentRunHistoryItem[];
}

export interface ModuleSession {
  sessionId: string;
  moduleId: string;
  moduleLabel: string;
  status: string;
  mode: string;
  dryRun: boolean;
  execEnabled: boolean;
  explicitExecution: boolean;
  command: string;
  commandPreview?: string;
  adapterId: string;
  argsCount: number;
  promptChars: number;
  timeoutMs: number;
  pid: number | null;
  workspace: {
    configured: boolean;
    used: boolean;
  };
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  exitCode: number | string | null;
  signal: string | null;
  stopRequested: boolean;
  provider?: string | null;
  profile?: string | null;
  model?: string | null;
  messageCount?: number;
  lastMessageAt?: string | null;
  stdoutTail: string;
  stderrTail: string;
  outputTruncated: boolean;
  nextStep: string;
  evidence: string[];
}

export interface ModuleSessions {
  id: string;
  sessions: ModuleSession[];
}

export interface ModuleSessionResult {
  ok?: boolean;
  mode?: string;
  reply?: string;
  id?: string;
  session: ModuleSession | null;
}

export type Integration = RuntimeModule;

export interface OsStatus {
  ok: boolean;
  service: string;
  version: string;
  mode: string;
  runtimeFoundation: string;
  builderFoundation: string;
  generatedAt: string;
  host: string;
  store: Record<string, string>;
  publicUrl: string | null;
  githubRepo: string | null;
  moduleCount: number;
  connectedCount: number;
  elizaOS?: {
    ok: boolean;
    packageName: string;
    version: string | null;
    exports: string[];
    missingExports: string[];
    runtimeClass: string | null;
    source: string;
  };
}

export interface IntegrationSnapshot {
  generatedAt: string;
  host: string;
  mode: string;
  publicUrl: string | null;
  githubRepo: string | null;
  integrations: RuntimeModule[];
  directories: Array<{ label: string; path: string; exists: boolean }>;
  flow: string[];
  osStatus?: OsStatus;
}

export interface OsAuditItem {
  id: string;
  label: string;
  category: string;
  type: string;
  status: string;
  configured: boolean;
  missing: string[];
  severity: "ok" | "setup" | "action_required" | string;
  fix: string;
  docsUrl: string;
  actions: string[];
}

export interface OsAudit {
  generatedAt: string;
  summary: {
    total: number;
    ok: number;
    setup: number;
    actionRequired: number;
  };
  items: OsAuditItem[];
}

export interface KernelComponent {
  id: string;
  label: string;
  kind: string;
  status: "implemented" | "partial" | "config_required" | "action_required" | "disabled" | "error" | string;
  configured: boolean;
  missing: string[];
  capabilities: string[];
  evidence: string[];
  metrics: Record<string, unknown>;
  publicSummary: string;
  nextFix: string;
}

export interface KernelStatus {
  id: "hermes-kernel";
  label: string;
  status: string;
  generatedAt: string;
  summary: {
    total: number;
    implemented: number;
    partial: number;
    configRequired: number;
    actionRequired: number;
  };
  runtime: {
    service: string;
    version: string;
    mode: string;
    host: string;
    publicUrl: string | null;
    githubRepo: string | null;
    store: Record<string, string>;
  };
  invariants: Array<{
    id: string;
    label: string;
    status: string;
    evidence: string;
  }>;
  readiness: AgentOsReadiness;
  components: KernelComponent[];
}

export interface AgentOsReadinessRequirement {
  id: string;
  label: string;
  status: string;
  required: boolean;
  target: string | null;
  evidence: string;
  missing: string[];
  nextAction: string;
}

export interface AgentOsReadiness {
  id: "agent-os-readiness";
  label: string;
  status: "blocked" | "dry_run_ready" | "live_execution_ready" | string;
  generatedAt: string;
  score: number;
  summary: {
    required: number;
    readyRequired: number;
    blocked: number;
    connectedAgents: number;
    totalAgents: number;
	    connectedProviders: number;
	    configuredProviders: number;
	    totalProviders: number;
    dryRunDefault: boolean;
    schedulerJobs: number;
    activeMemories: number;
  };
  primaryBlocker: AgentOsReadinessRequirement | null;
  requirements: AgentOsReadinessRequirement[];
  optional: AgentOsReadinessRequirement[];
  executableTargets: {
    agents: Array<{ id: string; label: string; status: string }>;
    providers: Array<{ id: string; label: string; model: string }>;
  };
  publicSummary: string;
}

export interface Health {
  ok: boolean;
  service: string;
  version: string;
  mode: string;
  timestamp: string;
  bind?: string;
  port?: number;
  demoPublic?: boolean;
  liveChat?: boolean;
  badge?: string | null;
}

export interface LiveChatResult {
  ok: boolean;
  mode: string;
  transport: string;
  native: boolean;
  agentId: string;
  reply: string;
  model?: string | null;
}

export interface LiveMissionResult {
  ok: boolean;
  mode: string;
  dryRun?: boolean;
  hermes: LiveChatResult | null;
  openclaw: LiveChatResult | null;
  workspaceFile?: { relativePath?: string; name?: string; error?: string } | null;
}

export interface AdminSession {
  required: boolean;
  adminTokenConfigured: boolean;
  authenticated: boolean;
  mode: "local" | "public" | string;
}

export interface ExecutionGateStatus {
  enabled: boolean;
  source: "env" | "local-config" | "disabled" | string;
  envLocked: boolean;
  localEnabled: boolean;
  dryRunDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string;
  publicSummary: string;
  demoLocked?: boolean;
  refused?: boolean;
  // 0 = look only, 1 = run agents, 2 = machine control armed (see
  // server/runtime/execution-gate.js). Read defensively regardless.
  level?: number;
  machineControl?: {
    armed?: boolean;
    enabled?: boolean;
    expiresAt?: string | null;
    remainingMs?: number | null;
  } | null;
}

export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  detail: string;
  target: string | null;
}

export interface SetupState {
  version: number;
  mode: "local" | "vps" | "docker" | string;
  preferredProvider: string;
  completed: boolean;
  canComplete: boolean;
  firstWorkflowRunId: string | null;
  steps: SetupStep[];
  workflows: Array<{
    id: string;
    name: string;
    draft: boolean;
    nodeCount: number;
  }>;
  updatedAt: string | null;
}

export interface RouterProviderStatus {
  id: string;
  label: string;
  status: string;
  configured: boolean;
  missing: string[];
  model: string;
  endpoint: string;
  healthEndpoint?: string;
  publicSummary: string;
}

export interface ProviderRouterStatus {
  id: string;
  label: string;
  status: string;
  configured: boolean;
  fallbackOrder: string[];
  providers: RouterProviderStatus[];
  nextProvider: RouterProviderStatus | null;
  updatedAt: string | null;
  dryRunDefault: boolean;
}

export interface RouterRunResult {
  ok: boolean;
  mode: string;
  provider?: string;
  model?: string;
  message: string;
  status?: number;
  plannedRequest?: Record<string, unknown>;
  usage?: UsageSummary;
}

export interface ProviderHealthCheck {
  id: string;
  label: string;
  ok: boolean;
  status: "healthy" | "ready_to_configure" | "error" | string;
  configured: boolean;
  missing: string[];
  checkedAt: string;
  latencyMs: number;
  httpStatus: number | null;
  endpoint: string;
	  message: string;
	  modelCount?: number;
	  selectedModel?: string | null;
	  selectedModelAvailable?: boolean;
	}

export interface ProviderHealthState {
  id: "provider-router-health";
  checkedAt: string;
  summary: {
    total: number;
    healthy: number;
    setup: number;
    error: number;
  };
  checks: ProviderHealthCheck[];
}

export interface ProviderSetupField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder: string;
  help: string;
}

export interface ProviderSetupGuide {
  id: string;
  label: string;
  category: string;
  connectionId: string;
  moduleId: string;
  routerProvider: string | null;
  docsUrl: string;
  modelDefault: string | null;
  fields: ProviderSetupField[];
  configuredFields: string[];
  missing: string[];
  configured: boolean;
  status: string;
  helper: {
    id: string;
    label: string;
    modelField: string;
  } | null;
  publicSummary: string;
}

export interface ProviderSetupState {
  id: "provider-setup";
  generatedAt: string;
  summary: {
    total: number;
    configured: number;
    readyToConfigure: number;
    local: number;
    cloud: number;
    builder: number;
  };
  guides: ProviderSetupGuide[];
}

export interface ProviderSetupTestResult {
  ok: boolean;
  id: string;
  checkedAt: string;
  result: Record<string, unknown>;
}

export interface ProviderLocalDoctor {
  id: string;
  provider: string;
  status: string;
  generatedAt: string;
  installed: boolean;
  hostConfigured: boolean;
  serverReachable: boolean;
  host: string;
  model: string;
  modelCount: number;
  selectedModelAvailable: boolean;
  latencyMs: number;
  httpStatus: number | null;
  checks: Array<{
    id: string;
    label: string;
    status: string;
    detail: string;
  }>;
  commands: string[];
  nextAction: string;
  publicSummary: string;
}

export interface ProviderModelInventoryItem {
  name: string;
  model: string;
  displayName?: string;
  modifiedAt: string | null;
  digest: string | null;
  sizeBytes: number;
  sizeGb: number;
  sizeLabel: string;
  details: {
    family: string | null;
    families: string[];
    parameterSize: string | null;
    quantizationLevel: string | null;
    format: string | null;
  };
}

export interface ProviderModelInventory {
  id: string;
  provider: string;
  status: string;
  configured: boolean;
  missing: string[];
  generatedAt: string;
  host: string | null;
  endpoint?: string | null;
  modelDefault: string;
  selectedModelAvailable: boolean;
  modelCount: number;
  totalSizeBytes: number;
  totalSizeGb: number;
  models: ProviderModelInventoryItem[];
  latencyMs?: number;
  httpStatus?: number | null;
  error?: string;
  publicSummary: string;
}

export interface ProviderModelPrepareResult {
  ok: boolean;
  id: string;
  mode: string;
  model: string;
  command: string;
  message: string;
  result?: Record<string, unknown>;
}

export interface SchedulerJob {
  id: string;
  label: string;
  targetType: "workflow" | "self_module" | string;
  targetId: string;
  action: string;
  intervalMinutes: number;
  retryFailed: boolean;
  retryDelaySeconds: number;
  maxRetries: number;
  payload: Record<string, unknown>;
  requiresApproval: boolean;
  pendingApproval: boolean;
  approvalStatus: string | null;
  approvalRequestedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  approvalNote: string;
  approvalRequestCount: number;
  enabled: boolean;
  paused: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastHistoryId: string | null;
  runCount: number;
  failureCount: number;
  currentRetryCount: number;
  pendingRetry: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerHistoryItem {
  id: string;
  jobId: string;
  targetType: string;
  targetId: string;
  action: string;
  scheduled: boolean;
  manual: boolean;
  approvalRequired: boolean;
  approvalGate: string | null;
  startedAt: string;
  finishedAt: string;
  status: string;
  ok: boolean;
  runId: string | null;
  message: string;
  attempt: number;
  payloadKeys: string[];
}

export interface SchedulerState {
  id: string;
  status: string;
  enabled: boolean;
  pollMs: number;
  lock: {
    enabled: boolean;
    mode: string;
    lockFile: string;
    ownerId: string;
    ttlMs: number;
    held: boolean;
    heldByThisProcess: boolean;
    heldByAnotherProcess: boolean;
    stale: boolean;
    holderId: string | null;
    acquiredAt: string | null;
    heartbeatAt: string | null;
    expiresAt: string | null;
  };
  summary: {
    total: number;
    enabled: number;
    paused: number;
    pendingApproval: number;
    due: number;
    failed: number;
  };
  jobs: SchedulerJob[];
  history: SchedulerHistoryItem[];
  targets: {
    workflows: WorkflowSummary[];
    selfModules: Array<{ id: string; label: string; actions: string[] }>;
  };
}

export interface SchedulerRunResult {
  job: SchedulerJob;
  history: SchedulerHistoryItem;
  result: Record<string, unknown>;
}

export interface SchedulerTickResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  checkedAt: string;
  due: number;
  runs: SchedulerRunResult[];
  lock?: SchedulerState["lock"];
}

export interface UsageSummary {
  total: {
    units: number;
    estimatedCost: number;
    calls: number;
  };
  daily: {
    key: string;
    units: number;
    estimatedCost: number;
    limit: number;
    remaining: number | null;
    warning: boolean;
    overLimit: boolean;
  };
  monthly: {
    key: string;
    units: number;
    estimatedCost: number;
    limit: number;
    remaining: number | null;
    warning: boolean;
    overLimit: boolean;
  };
  byProvider: Record<string, { units: number; estimatedCost: number; calls: number }>;
  dailyByProvider: Record<string, { units: number; estimatedCost: number; calls: number }>;
  monthlyByProvider: Record<string, { units: number; estimatedCost: number; calls: number }>;
}

export interface UsageReconciliationComparison {
  provider: string;
  period: string;
  localEstimate: number;
  providerReported: number | null;
  delta: number | null;
  driftPercent: number | null;
}

export interface UsageReconciliationResult {
  providerId: string;
  provider: string;
  label: string;
  status: string;
  checkedAt: string;
  basis?: string;
  missing?: string[];
  docs?: string;
  error?: string;
  httpStatus?: number | null;
  latencyMs?: number;
  actual?: Record<string, string | number | boolean | null>;
  comparison?: UsageReconciliationComparison;
  publicSummary?: string;
}

export interface UsageReconciliationProvider {
  id: string;
  provider: string;
  label: string;
  kind: string;
  status: string;
  configured: boolean;
  missing: string[];
  basis: string;
  docs?: string | null;
  endpoint?: string;
  latest: UsageReconciliationResult | null;
  comparison: UsageReconciliationComparison | null;
  lastChecked?: string | null;
  publicSummary: string;
}

export interface UsageReconciliationState {
  id: "usage-reconciliation";
  providers: UsageReconciliationProvider[];
  history: UsageReconciliationResult[];
  updatedAt: string | null;
  summary: {
    total: number;
    connected: number;
    readyToConfigure: number;
    notChecked: number;
    unsupported: number;
    errors: number;
  };
}

export interface UsageBillingImportRecord {
  rowNumber: number;
  provider: string;
  model?: string;
  operation: string;
  createdAt: string;
  units: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  currency: string;
  invoiceId?: string;
  sourceId: string;
  requestId: string;
  notes?: string;
  duplicate: boolean;
  valid: boolean;
  errors: string[];
}

export interface UsageBillingImportPreview {
  id: "usage-billing-import";
  sourceName: string;
  mode: "preview" | "import";
  acceptedProviders: string[];
  summary: {
    rows: number;
    valid: number;
    invalid: number;
    duplicates: number;
    totalUnits: number;
    totalEstimatedCost: number;
  };
  records: UsageBillingImportRecord[];
}

export interface UsageBillingImportResult {
  ok: boolean;
  importId: string;
  preview: UsageBillingImportPreview;
  imported: SelfModuleItem[];
  skipped: UsageBillingImportRecord[];
  usage: UsageState;
}

export interface UsageState {
  id: "usage-credits";
  config: {
    dailyLimit: number;
    monthlyLimit: number;
    warningThreshold: number;
    updatedAt: string | null;
  };
  summary: UsageSummary;
  reconciliation: UsageReconciliationState;
  items: SelfModuleItem[];
  updatedAt: string | null;
}

export type MemoryType = "semantic" | "episodic" | "procedural" | string;
export type MemoryPrivacy = "private" | "shared" | "exportable" | string;

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  agentId: string;
  namespace: string;
  title: string;
  content: string;
  tags: string[];
  privacy: MemoryPrivacy;
  importance: number;
  source: string;
  metadata: Record<string, unknown>;
  archived: boolean;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  score?: number;
  lexicalScore?: number;
  vectorScore?: number;
}

export interface MemoryVectorState {
  enabled: boolean;
  provider: "disabled" | "local-hash" | "ollama" | "openai" | string;
  embedding?: {
    provider: "local-hash" | "ollama" | "openai" | string;
    model: string;
    dimensions: number;
  };
  model: string;
  dimensions: number;
  autoIndex: boolean;
  remote?: {
    type: "qdrant" | string;
    endpoint: string | null;
    collection: string | null;
    distance: string;
    hasApiKey: boolean;
  } | null;
  status: "connected" | "ready_to_configure" | "disabled" | string;
  configured: boolean;
  missing: string[];
  index: {
    memoryCount: number;
    vectorCount: number;
    stale: boolean;
    updatedAt: string | null;
  };
  updatedAt: string | null;
}

export interface MemorySummary {
  total: number;
  active: number;
  archived: number;
  exportable: number;
  byType: Record<string, number>;
  byAgent: Record<string, number>;
  byPrivacy: Record<string, number>;
}

export interface MemoryState {
  id: "memory";
  schemaVersion: number;
  memories: MemoryRecord[];
  summary: MemorySummary;
  vector: MemoryVectorState;
  updatedAt: string | null;
}

export interface MemorySearchResult {
  query: string;
  mode: "hybrid" | "lexical" | "vector" | string;
  vector: MemoryVectorState;
  filters: {
    type: string | null;
    agentId: string | null;
    namespace: string | null;
    privacy: string | null;
    includeArchived: boolean;
  };
  count: number;
  results: MemoryRecord[];
}

export interface MemoryContextHit {
  id: string;
  title: string;
  source: string;
  reason: string;
  excerpt: string;
}

export interface MemoryContext {
  ok: boolean;
  query: string;
  count: number;
  briefing: {
    id: string;
    title: string;
    updatedAt: string;
    excerpt: string;
  } | null;
  hits: MemoryContextHit[];
  promptBlock: string;
}

export interface MemoryVectorRebuildResult {
  ok: boolean;
  status: string;
  message?: string;
  indexed?: number;
  reused?: number;
  vector: MemoryVectorState;
}

export interface MemoryExport {
  schemaVersion: number;
  exportedAt: string;
  includePrivate: boolean;
  includeArchived: boolean;
  summary: MemorySummary;
  memories: MemoryRecord[];
}

export interface SkillRecord {
  id: string;
  label: string;
  version: string;
  latestVersion: string;
  updateAvailable: boolean;
  updateChannel: string;
  category: string;
  description: string;
  capabilities: string[];
  permissions: string[];
  requiredKeys: string[];
  requiredAnyKeys: string[][];
  optionalKeys: string[];
  dependencies: SkillDependency[];
  dependencyStatus: SkillDependencyStatus[];
  dependencySuggestions: SkillDependencySuggestion[];
  dependencyReady: boolean;
  availableUpdate: SkillAvailableUpdate | null;
  installed: boolean;
  enabled: boolean;
  status: string;
  configured: boolean;
  missing: string[];
  configuredFields: string[];
  installedAt: string | null;
  updatedAt: string | null;
  lastTestedAt: string | null;
  samplePrompt: string;
  releaseNotes: SkillReleaseNote[];
  exportSafe: boolean;
  source: "built_in" | "external" | string;
  signatureVerified: boolean;
  publisherFingerprint: string | null;
  publisherTrusted: boolean;
  publisherAllowed: boolean;
  publisherBlocked: boolean;
  publisherImportAllowed: boolean;
  publisherReputation: SkillPublisherReputation | null;
  importedAt: string | null;
  actions: string[];
}

export interface SkillDependency {
  id: string;
  version: string | null;
  optional: boolean;
  reason: string;
}

export interface SkillDependencyStatus extends SkillDependency {
  label: string;
  installed: boolean;
  enabled: boolean;
  installedVersion: string | null;
  status: string;
}

export interface SkillReleaseNote {
  version: string;
  title: string;
  date: string | null;
  channel: string;
  breaking: boolean;
  items: string[];
}

export interface SkillDependencySuggestion {
  id: string;
  dependencyId: string;
  dependencyLabel: string;
  requiredVersion: string | null;
  installedVersion: string | null;
  optional: boolean;
  currentStatus: string;
  reason: string;
  action:
    | "install_skill"
    | "enable_skill"
    | "update_skill"
    | "import_marketplace_skill"
    | "trust_and_import_marketplace_skill"
    | "blocked_by_policy"
    | "manual_update_bundle"
    | "import_signed_bundle"
    | string;
  label: string;
  command: string;
  autoInstallable: boolean;
  source: string;
  feedId?: string;
  publisherFingerprint?: string;
  targetVersion?: string;
  requiresTrust?: boolean;
  releaseNotes?: SkillReleaseNote[];
}

export interface SkillAvailableUpdate {
  feedId: string;
  version: string;
  updateChannel: string;
  publisherFingerprint: string;
  bundleHash: string;
  releaseNotes: SkillReleaseNote[];
}

export interface SkillPublisherReputation {
  score: number | null;
  tier: string;
  source: string;
  notes: string;
  updatedAt: string | null;
}

export interface SkillMarketplaceFeed {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  lastFetchedAt: string | null;
  lastStatus: string;
  lastError: string | null;
  itemCount: number;
}

export interface SkillMarketplaceItem {
  feedId: string;
  skillId: string;
  label: string;
  version: string;
  installedVersion: string | null;
  updateAvailable: boolean;
  updateChannel: string;
  category: string;
  description: string;
  capabilities: string[];
  permissions: string[];
  requiredKeys: string[];
  requiredAnyKeys: string[][];
  optionalKeys: string[];
  dependencies: SkillDependency[];
  dependencySuggestions: SkillDependencySuggestion[];
  releaseNotes: SkillReleaseNote[];
  exportSafe: boolean;
  bundleHash: string;
  publisherFingerprint: string;
  publisherTrusted: boolean;
  publisherAllowed: boolean;
  publisherBlocked: boolean;
  publisherImportAllowed: boolean;
  publisherReputation: SkillPublisherReputation;
  signatureVerified: boolean;
  imported: boolean;
  installed: boolean;
  fetchedAt: string | null;
  source: string;
}

export interface SkillTrustedPublisher {
  fingerprint: string;
  label: string;
  trustedAt: string | null;
  source: string;
  notes: string;
  allowed: boolean;
  blocked: boolean;
  importAllowed: boolean;
  reputation: SkillPublisherReputation;
}

export interface SkillPublisher {
  fingerprint: string;
  label: string;
  website: string;
  trusted: boolean;
  trustedAt: string | null;
  allowed: boolean;
  blocked: boolean;
  importAllowed: boolean;
  reputation: SkillPublisherReputation;
  source: string;
  feedItems: number;
  importedSkills: number;
  updatedAt: string | null;
}

export interface SkillPublisherPolicy {
  enforceAllowlist: boolean;
  allowedCount: number;
  blockedCount: number;
  updatedAt: string | null;
}

export interface SkillMarketplaceState {
  id: "skill-marketplace";
  schemaVersion: number;
  summary: {
    feeds: number;
    enabledFeeds: number;
    items: number;
    trustedPublishers: number;
    knownPublishers: number;
    allowedPublishers: number;
    blockedPublishers: number;
    importAllowedPublishers: number;
    trustedItems: number;
    allowlistedItems: number;
    blockedItems: number;
    updateItems: number;
    untrustedItems: number;
    importedItems: number;
  };
  policy: SkillPublisherPolicy;
  feeds: SkillMarketplaceFeed[];
  items: SkillMarketplaceItem[];
  publishers: SkillPublisher[];
  trustedPublishers: SkillTrustedPublisher[];
  updatedAt: string | null;
}

export interface SkillPublishersState {
  id: "skill-publishers";
  schemaVersion: number;
  policy: SkillPublisherPolicy;
  summary: {
    known: number;
    trusted: number;
    allowed: number;
    blocked: number;
    importAllowed: number;
  };
  publishers: SkillPublisher[];
  updatedAt: string | null;
}

export interface SkillRegistryState {
  id: "skill-registry";
  schemaVersion: number;
  summary: {
    total: number;
    installed: number;
    enabled: number;
    disabled: number;
    setup: number;
    available: number;
    external: number;
    signed: number;
    updates: number;
    trustedPublishers: number;
    untrustedExternal: number;
    marketplaceFeeds: number;
    marketplaceItems: number;
    marketplaceTrustedItems: number;
    marketplaceUpdateItems: number;
    knownPublishers: number;
    allowedPublishers: number;
    blockedPublishers: number;
    dependencyBlocked: number;
    dependencySuggestions: number;
    allowlistEnforced: boolean;
  };
  skills: SkillRecord[];
  updatedAt: string | null;
}

export interface SkillBundleImportResult {
  skill: SkillRecord | null;
  verification: {
    ok: boolean;
    algorithm: string;
    publicKeyFingerprint: string;
    bundleHash: string;
  };
}

export interface SkillTestResult {
  ok: boolean;
  id: string;
  status: string;
  message: string;
  details: SkillRecord | null;
}

export interface SkillDependencyPrepareResult {
  ok: boolean;
  id: "skill-dependency-prepare";
  skillId: string;
  generatedAt: string;
  mode: string;
  executeRequested: boolean;
  executed: boolean;
  dependencyReady: boolean;
  dependencyStatus: SkillDependencyStatus[];
  suggestions: SkillDependencySuggestion[];
  releaseNotes: SkillReleaseNote[];
  nextActions: Array<{
    action: string;
    label: string;
    command: string;
    autoInstallable: boolean;
  }>;
  message: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  draft: boolean;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string | null;
}

export interface WorkflowEvent {
  id: string;
  type: string;
  level: string;
  nodeId: string | null;
  edgeId: string | null;
  branchId?: string | null;
  parallelGroupId?: string | null;
  status: string | null;
  message: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: string;
  graph?: {
    mode: string;
    maxSteps: number;
    steps: number;
    waitingNodeId: string | null;
    waitingBranchId?: string | null;
    branchCount?: number;
    parallelGroups?: Array<{
      id: string;
      sourceNodeId: string;
      parentBranchId: string;
      branchIds: string[];
      edgeIds: string[];
      status: string;
      startedAt: string;
      completedAt: string | null;
    }>;
  };
  nodeRuns: Array<{
    nodeId: string;
    label: string;
    type: string;
    moduleId?: string | null;
    provider?: string | null;
    status: string;
    message: string;
    attempt?: number;
    retry?: boolean;
    output?: Record<string, unknown>;
    branchId?: string;
    parallelGroupId?: string | null;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    timestamp: string;
  }>;
  traversedEdges?: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    implicit: boolean;
    branchId?: string;
    parallelGroupId?: string | null;
    timestamp: string;
  }>;
  events?: WorkflowEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEvents {
  workflowId: string;
  runId: string;
  status: string;
  eventCount: number;
  events: WorkflowEvent[];
}

export interface WorkflowReplay {
  workflowId: string;
  runId: string;
  status: string;
  graphMode: string;
  generatedAt: string;
  summary: {
    nodes: number;
    nodeRuns: number;
    completedNodes: number;
    failedNodes: number;
    waitingNodes: number;
    readyToConfigureNodes: number;
    edges: number;
    traversedEdges: number;
    branches: number;
    parallelGroups: number;
    events: number;
  };
  nodes: Array<{
    id: string;
    label: string;
    type: string;
    status: string;
    attempts: number;
    branchIds: string[];
    parallelGroupIds: string[];
    message: string;
    durationMs: number;
    startedAt: string | null;
    finishedAt: string | null;
    depth: number;
    position: { x: number; y: number };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    implicit: boolean;
    status: string;
    traversals: number;
    branchIds: string[];
    parallelGroupIds: string[];
    traversedAt: string | null;
  }>;
  parallelGroups: NonNullable<WorkflowRun["graph"]>["parallelGroups"];
  waitingNodeId: string | null;
  waitingBranchId: string | null;
}

export interface BuilderStatus {
  id: string;
  label: string;
  source: string;
  upstream: string;
  upstreamCommit: string;
  packageName: string;
  packageVersion: string | null;
  url: string;
  proxiedUrl: string;
  sourcePresent: boolean;
  dependenciesInstalled: boolean;
  upstreamFilePresent: boolean;
  live: boolean;
  status: "missing_source" | "needs_install" | "stopped" | "running" | string;
  requiredConfig: string[];
  missingConfig: string[];
  readyToBoot: boolean;
  diagnostics: {
    required: Array<{ key: string; configured: boolean; requiredFor: string }>;
    optionalExecution: Array<{ key: string; configured: boolean; requiredFor: string }>;
    missingRequired: string[];
    firecrawlConfigured: boolean;
    llmConfigured: boolean;
  };
  supervisor: {
    state: string;
    pid: number | null;
    startedAt: string | null;
    stoppedAt: string | null;
    exitCode: number | null;
    signal: string | null;
    lastError: string | null;
    managed: boolean;
    logCount: number;
  };
  installCommand: string;
  startCommand: string;
  stopCommand: string;
  theme: string;
  resetPolicy: string;
}

export interface BuilderLogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  details: Record<string, unknown>;
}

export interface BuilderLogs {
  id: "firecrawl-builder-logs";
  logs: BuilderLogEntry[];
  supervisor: BuilderStatus["supervisor"];
}

export interface BuilderBootstrapStep {
  id: string;
  label: string;
  status: "done" | "ready" | "action_required" | "blocked" | "optional" | string;
  required: boolean;
  action: string;
  commandId?: string;
  connectionId?: string;
  keys?: string[];
}

export interface BuilderBootstrapCommand {
  id: string;
  label: string;
  command: string;
  mode: "manual" | "external_account" | "local_config" | "local_action" | string;
  target: string;
  fields?: string[];
}

export interface BuilderBootstrap {
  id: "firecrawl-builder-bootstrap";
  generatedAt: string;
  status: string;
  readyToBoot: boolean;
  live: boolean;
  executionReady: boolean;
  source: {
    path: string;
    upstream: string;
    commit: string;
    packageName: string;
    packageVersion: string | null;
  };
  requiredMissing: string[];
  executionMissing: string[];
  steps: BuilderBootstrapStep[];
  commands: BuilderBootstrapCommand[];
  envExample: Array<{ key: string; required: boolean; secret: boolean; source: string; value: string }>;
  nextAction: string;
}

export interface BuilderBootstrapPrepareResult {
  ok: boolean;
  id: "firecrawl-builder-bootstrap-prepare";
  generatedAt: string;
  mode: string;
  message: string;
  executed: boolean;
  commands: BuilderBootstrapCommand[];
  nextSteps: BuilderBootstrapStep[];
  bootstrap: BuilderBootstrap;
}

export interface BuilderSmokeCheck {
  id: string;
  label: string;
  required: boolean;
  status: "passed" | "failed" | "warning" | "skipped" | string;
  detail: string;
}

export interface BuilderSmokeTest {
  ok: boolean;
  id: "firecrawl-builder-smoke-test";
  generatedAt: string;
  status: "setup_required" | "ready_to_start" | "live" | string;
  live: boolean;
  readyToBoot: boolean;
  executionReady: boolean;
  checkedUrl: string;
  checks: BuilderSmokeCheck[];
  missingRequired: string[];
  requestedStart: boolean;
  message: string;
}

export interface BuilderReplayOverlay {
  id: "builder-replay-overlay";
  workflowId: string;
  runId: string;
  status: string;
  generatedAt: string;
  overlayMode: string;
  selectors: string[];
  summary: WorkflowReplay["summary"];
  replay: WorkflowReplay;
}

export interface ConnectionTemplate {
  id: string;
  label: string;
  fields: string[];
  notes: string;
  configuredFields: string[];
}

export interface ConnectionsResponse {
  templates: ConnectionTemplate[];
}

export interface InstallResult {
  ok: boolean;
  id: string;
  mode: "dry_run" | "manual" | "executed" | "not_found" | string;
  message: string;
  recipe?: {
    id: string;
    label: string;
    command: string;
    docsUrl: string;
    manager: string;
    executable?: string | null;
    safeAutoRun: boolean;
    note?: string;
  };
}

export interface SelfModuleItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status?: string;
  objective?: string;
  notes?: string;
  body?: string;
  tags?: string[];
  column?: string;
  provider?: string;
  model?: string;
  plan?: string[];
  nextAction?: string;
  loopCount?: number;
  lastRunAt?: string | null;
  lastRunId?: string | null;
  history?: GoalLoopRun[];
  operation?: string;
  mode?: string;
  dryRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  source?: string;
  sourceType?: string;
  sourceId?: string;
  priority?: string;
  assignee?: string;
  dueAt?: string | null;
  workflowId?: string;
  runId?: string;
  nodeId?: string;
  schedulerJobId?: string;
  approvalId?: string;
  approvalStatus?: string;
  approvalRequestedAt?: string | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  completedAt?: string | null;
  linkedModule?: string;
  linkedItemId?: string;
  requestId?: string;
  units?: number;
  estimatedCost?: number;
  url?: string;
  keyword?: string;
  auditCount?: number;
  lastAuditAt?: string | null;
  lastAuditId?: string | null;
  scrapeStatus?: string;
  score?: number | null;
  recommendations?: string[];
  discoveryCount?: number;
  rankCount?: number;
  lastDiscoveryAt?: string | null;
  lastDiscoveryId?: string | null;
  lastRankAt?: string | null;
  lastRankId?: string | null;
  searchStatus?: string;
  competitors?: SeoCompetitor[];
  rankSnapshots?: SeoRankSnapshot[];
  seoHistory?: SeoAuditRun[];
  discoveryHistory?: SeoSearchRun[];
  rankHistory?: SeoRankRun[];
  sourcePath?: string;
  workflow?: string;
  jobType?: string;
  captionProvider?: string;
  renderPreset?: string;
  outputName?: string;
  captionOutput?: string;
  renderedOutput?: string;
  lastOperation?: string;
  workerRunCount?: number;
  durationSeconds?: number | null;
  hasAudio?: boolean | null;
  hasVideo?: boolean | null;
  width?: number | null;
  height?: number | null;
  frameRate?: string;
  probe?: VideoProbe | null;
  captionPlan?: VideoPlan | null;
  renderPlan?: VideoPlan | null;
  videoHistory?: VideoJobRun[];
}

export interface GoalLoopRun {
  id: string;
  goalId: string;
  status: string;
  mode: string;
  provider?: string | null;
  model?: string | null;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  summary: string;
  plan: string[];
  nextAction: string;
  risks: string[];
  usage?: UsageSummary | null;
}

export interface SeoSearchRow {
  position: number;
  title: string;
  description: string;
  url: string;
  domain: string;
  category?: string;
  markdownChars?: number;
}

export interface SeoCompetitor {
  title: string;
  url: string;
  domain: string;
  description?: string;
  position?: number;
  discoveredAt?: string;
}

export interface SeoSearchRun {
  id: string;
  briefId: string;
  type: "competitor_discovery" | string;
  status: string;
  mode: string;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  query: string;
  keyword: string;
  endpoint: string;
  httpStatus?: number | null;
  latencyMs?: number;
  missing: string[];
  message: string;
  warning?: string;
  firecrawlId?: string;
  creditsUsed?: number;
  plannedRequest?: Record<string, unknown> | null;
  resultCount: number;
  results: SeoSearchRow[];
  competitors: SeoCompetitor[];
}

export interface SeoRankRow extends SeoSearchRow {
  isTarget: boolean;
  isKnownCompetitor: boolean;
}

export interface SeoRankSnapshot {
  id: string;
  query: string;
  keyword: string;
  capturedAt: string;
  status: string;
  targetDomain: string;
  targetPosition?: number | null;
  topResult?: SeoRankRow | null;
  competitors: SeoRankRow[];
  resultCount: number;
}

export interface SeoRankRun {
  id: string;
  briefId: string;
  type: "rank_snapshot" | string;
  status: string;
  mode: string;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  query: string;
  keyword: string;
  endpoint: string;
  httpStatus?: number | null;
  latencyMs?: number;
  missing: string[];
  message: string;
  warning?: string;
  firecrawlId?: string;
  creditsUsed?: number;
  plannedRequest?: Record<string, unknown> | null;
  snapshot: SeoRankSnapshot;
  results: SeoRankRow[];
}

export interface SeoAuditRun {
  id: string;
  briefId: string;
  status: string;
  mode: string;
  provider?: string | null;
  model?: string | null;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  url: string;
  keyword: string;
  scrape: {
    status: string;
    mode: string;
    endpoint: string;
    httpStatus?: number | null;
    latencyMs?: number;
    missing: string[];
    message: string;
    page?: {
      title?: string;
      description?: string;
      statusCode?: number | null;
      sourceUrl?: string;
      markdownChars?: number;
    } | null;
  };
  score?: number | null;
  summary: string;
  recommendations: string[];
  risks: string[];
  usage?: UsageSummary | null;
}

export interface SelfModuleState {
  id: string;
  label: string;
  itemName: string;
  items: SelfModuleItem[];
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byColumn: Record<string, number>;
    goals?: {
      loopRuns: number;
      active: number;
      lastRunAt: string | null;
    };
    seo?: {
      auditRuns: number;
      discoveryRuns?: number;
      rankRuns?: number;
      competitors?: number;
      ready: number;
      lastRunAt: string | null;
    };
    kanban?: {
      pendingApprovals: number;
      workflowCards: number;
      schedulerCards: number;
      completed: number;
    };
    video?: {
      workerRuns: number;
      queued: number;
      running: number;
      ready: number;
      completed: number;
      canceled: number;
      lastRunAt: string | null;
    };
    usage: {
      units: number;
      estimatedCost: number;
    };
  };
  updatedAt: string | null;
}

export interface GoalLoopResult {
  ok: boolean;
  mode: string;
  goal: SelfModuleItem;
  run: GoalLoopRun;
  router: RouterRunResult;
  state: SelfModuleState;
}

export interface SeoAuditResult {
  ok: boolean;
  mode: string;
  brief: SelfModuleItem;
  run: SeoAuditRun;
  router: RouterRunResult;
  state: SelfModuleState;
}

export interface SeoSearchResult {
  ok: boolean;
  mode: string;
  brief: SelfModuleItem;
  run: SeoSearchRun;
  state: SelfModuleState;
}

export interface SeoRankResult {
  ok: boolean;
  mode: string;
  brief: SelfModuleItem;
  run: SeoRankRun;
  state: SelfModuleState;
}

export interface VideoToolStatus {
  id: string;
  available: boolean;
  configured: boolean;
  command: string;
  configuredByEnv: boolean;
  version: string | null;
}

export interface VideoSttProviderStatus {
  id: string;
  label: string;
  status: string;
  configured: boolean;
  missing: string[];
  model: string;
  endpoint: string;
  publicSummary: string;
}

export interface VideoWorkerStatus {
  id: "video-worker";
  status: string;
  configured: boolean;
  missing: string[];
  execEnabled: boolean;
  tools: {
    ffprobe: VideoToolStatus;
    ffmpeg: VideoToolStatus;
    whisper: VideoToolStatus;
  };
  stt?: {
    preferred: string;
    defaultProvider: string | null;
    configured: boolean;
    providers: VideoSttProviderStatus[];
    missing: string[];
  };
  capabilities: string[];
  publicSummary: string;
}

export interface VideoProbe {
  durationSeconds: number | null;
  formatName: string;
  sizeBytes: number | null;
  bitRate: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  hasSubtitles: boolean;
  videoStreams: number;
  audioStreams: number;
  subtitleStreams: number;
  width: number | null;
  height: number | null;
  frameRate: string;
  videoCodec: string;
  audioCodecs: string[];
}

export interface VideoPlan {
  requested: boolean;
  status: string;
  provider?: string;
  resolvedProvider?: string | null;
  fallbackOrder?: string[];
  stt?: VideoWorkerStatus["stt"];
  preset?: string;
  presetLabel?: string;
  availablePresets?: Array<{
    id: string;
    label: string;
    summary: string;
    transcode: boolean;
    commandTemplate: string;
  }>;
  missing: string[];
  outputFormat: string;
  commandTemplate: string;
  publicSummary: string;
}

export interface VideoCommandResult {
  name: string;
  ok: boolean;
  status: string;
  code: number | string | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  output: string | null;
  progressSamples?: VideoProgressSample[];
  provider?: string;
  model?: string;
  preset?: string;
}

export interface VideoProgressSample {
  at: string;
  command: string;
  stream: string;
  source: string;
  percent: number;
  runProgress: number;
  text: string;
  seconds?: number;
}

export interface VideoProgressDetails {
  stage: string;
  currentCommand: string | null;
  commandProgress: number | null;
  samples: VideoProgressSample[];
}

export interface VideoJobRun {
  id: string;
  jobId: string;
  status: string;
  mode: string;
  operation: string;
  dryRun: boolean;
  queuedAt?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  progress?: number;
  progressDetails?: VideoProgressDetails;
  cancelRequested?: boolean;
  source: {
    path: string;
    exists: boolean;
  };
  probeStatus: string;
  message: string;
  probe: VideoProbe | null;
  captionPlan: VideoPlan | null;
  renderPlan: VideoPlan | null;
  output: {
    directory: string;
    manifest: string | null;
    captions: string | null;
    renderedVideo: string | null;
  };
  commands: VideoCommandResult[];
  worker: {
    status: string;
    missing: string[];
    tools: VideoWorkerStatus["tools"];
  };
}

export interface VideoJobResult {
  ok: boolean;
  queued?: boolean;
  mode: string;
  job: SelfModuleItem;
  run: VideoJobRun;
  worker: VideoWorkerStatus;
  state: SelfModuleState;
}

export type WorkspaceFileKind = "html" | "image" | "audio" | "video" | "pdf" | "text" | "other";

export interface WorkspaceFile {
  id: string;
  name: string;
  relativePath: string;
  root: "workspace" | "exports" | string;
  kind: WorkspaceFileKind | string;
  size: number;
  updatedAt: string;
  publicPath: string;
}

// Who saved a listed file (server/runtime/workspace.js, "Saved by"). Undo this
// save is offered only for kind "team-room": that is the only kind that carries
// roomId and actionId.
export interface WorkspaceSavedBy {
  kind: "you" | "agent-os" | "team-room" | "unknown";
  // "You", "Agent OS", the agent's name for a Team Room save, or "—" when unknown.
  label: string;
  // When it was saved (ISO time). Absent for "agent-os" and for an "unknown"
  // file with nothing on record ("—"); present for "Changed outside Agent OS" and
  // for "Team Room (can't check for later changes)" (a save with nothing to compare the file with).
  at?: string;
  roomId?: string;
  actionId?: string;
}

// A file as GET /api/workspace lists it. The one-file detail
// (GET /api/workspace/file) is a plain WorkspaceFile and carries no savedBy.
export interface WorkspaceListedFile extends WorkspaceFile {
  savedBy: WorkspaceSavedBy;
}

export interface WorkspaceListing {
  ok: boolean;
  generatedAt: string;
  roots: Array<{
    id: string;
    label: string;
    publicPath: string;
    // The real folder on this machine (used by Show in Finder). null on the public demo.
    absolutePath?: string | null;
    fileCount: number;
  }>;
  files: WorkspaceListedFile[];
  empty: boolean;
  summary: {
    total: number;
    shown: number;
    // Files a Team Room saved, counted over every file, not only the shown ones.
    savedByAgents: number;
  };
}

export interface WorkspaceFileDetail {
  ok: boolean;
  file: WorkspaceFile & { mime?: string };
  previewText: string;
  rawUrl: string;
}

// Agent adapter surface (Fleet page): detection facts for one of the five
// agent CLIs, and the always-on gateway status for the two that have one.
export interface AgentDetected {
  installed: boolean;
  path: string;
  version: string;
  // The full --version text with the user's home directory already
  // collapsed to "~" server-side (see detect.js splitVersion); optional
  // because a not-installed agent's detect() result omits it.
  versionFull?: string;
  features: Record<string, unknown>;
  error?: string;
}

// Agents screen ("the hangar"): the single-agent detail bay's data, mirroring
// GET /api/agents/:id exactly (server/runtime/agents/routes.js).
export interface AgentConfigStatus {
  ok: boolean;
  summary: string;
  problems: string[];
  fixHint?: string;
  // Calm advisory lines (e.g. OpenClaw's loopback-gateway note): informational,
  // never rendered as a warning.
  notes?: string[];
}

export interface AgentSafetyAction {
  id: string;
  label: string;
  description?: string;
}

export interface AgentSafetyStatus {
  permissive: boolean;
  summary: string;
  actions: AgentSafetyAction[];
  // false when Agent OS could not read the setting (the read failed, timed out or printed
  // nothing): `permissive` is then not a finding and screens show "—". Absent from older servers.
  known?: boolean;
}

export interface AgentDetail {
  detected: AgentDetected;
  config: AgentConfigStatus;
  safety: AgentSafetyStatus;
  service: AgentServiceStatus | null;
}

export interface AgentRunPreview {
  commandPreview: string;
  cwd: string;
  transport: string;
  // Which brain this run would use; null for agents that have no brain choice.
  brain?: RunBrainInfo | null;
  gate: { enabled: boolean };
}

// POST /api/agents/:id/safety/:actionId's response: the config-set run, plus
// a best-effort gateway-restart run when the setting needed one to apply.
export interface AgentSafetyActionResult {
  run: RunMeta;
  followUp: RunMeta | null;
}

export interface AgentSummary {
  id: string;
  label: string;
  homepage: string;
  docsUrl: string;
  license: string;
  detected: AgentDetected;
}

export interface AgentListResponse {
  agents: AgentSummary[];
}

export interface AgentServiceStatus {
  running: boolean;
  text: string;
  warnings?: string[];
}

// Run surface (Fleet page + future Runs page): mirrors run-manager.js's
// meta object exactly, including which fields report cost (some agents
// don't, and that must render as "—", never "$0.00").
export interface RunUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  // How big the conversation was at the last answer (Claude Code).
  lastInputTokens?: number;
}

// Which brain paid for a Claude Code / Codex / Cursor run.
export interface RunBrainInfo {
  mode: "plan" | "openrouter" | "local" | string;
  model: string | null;
}

// Set on a coding agent's run that stopped because its PLAN ran out.
export interface RunLimit {
  kind: string;
  message: string;
  resetsAt?: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timed_out"
  | "interrupted"
  | string;

export interface RunMeta {
  id: string;
  agentId: string | null;
  kind: string;
  title: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | string | null;
  signal: string | null;
  pid: number | null;
  cwd: string;
  commandPreview: string;
  truncated: boolean;
  usage: RunUsage;
  error: string | null;
  // Coding agents only (absent on older runs and on Hermes / OpenClaw runs).
  brain?: RunBrainInfo | null;
  // The model the agent itself reported using.
  model?: string;
  limit?: RunLimit;
  // The plan was close to its limit (not stopped yet).
  nearLimit?: boolean;
  continuedFrom?: string;
  continuedBy?: string;
  // What the run was started for. `line` is the task's first line (up to 140 characters); older runs have no `line`.
  task?: { cwd?: string; allowEdits?: boolean; line?: string };
}

export interface RunListResponse {
  runs: RunMeta[];
}

export interface RunStreamEvent {
  seq: number;
  t: string;
  stream?: string;
  type: string;
  text?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Team Room: a moderated discussion between Hermes Agent and OpenClaw.
// Mirrors server/runtime/team-room/*.
// ---------------------------------------------------------------------------

export type TeamRoomStatus =
  | "running"
  | "needs_you" // hit the turn or time limit; you can continue
  | "agreed"
  | "cost_cap"
  | "stopped"
  | "failed"
  | "interrupted"
  | string;

export interface TeamRoomLimits {
  maxTurns: number;
  maxMinutes: number;
  maxCostUsd: number | null;
  // Model OpenClaw uses for this room (for example "ollama/phi4"); null means
  // OpenClaw's own setting.
  openclawModel?: string | null;
}

export interface TeamRoom {
  id: string;
  task: string;
  status: TeamRoomStatus;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  limits: TeamRoomLimits;
  turnsAllowed: number;
  turnsDone: number;
  clockStartedAt: string;
  currentTurn: { turn: number; agentId: "hermes" | "openclaw"; runId: string } | null;
  // null until a turn reports a cost; turns that report none are counted in
  // costUnknownTurns and are never added up as 0.
  costUsd: number | null;
  costKnownTurns: number;
  costUnknownTurns: number;
  // The same facts for display: the cost that was reported, and how many turns
  // reported none (never counted as $0). Missing on rooms saved by older versions.
  cost?: { knownUsd: number; unknownTurns: number };
  // Set when a cost cap is on but some turns report no cost, so the cap can't see them.
  costWarning?: string | null;
  // Plain-English hints (for example "this model didn't follow the reply format").
  hints?: string[];
  endReason: string | null;
  folder: string;
  // Set while the room is paused for one of your decisions (D10): the id of the
  // file proposal it waits on, for example "P1". null or missing otherwise.
  pausedFor?: string | null;
  // Time the room had used when it paused, in milliseconds. A paused room's clock
  // is stopped at this value, and the server keeps it across a restart. null
  // (or missing) whenever the room is not paused.
  clockUsedMs?: number | null;
}

// What starting a room returns: the room, plus any heads-ups for the start screen.
export interface StartTeamRoomResponse extends TeamRoom {
  warnings?: string[];
}

export interface TeamRoomSummary {
  id: string;
  task: string;
  status: TeamRoomStatus;
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
  turnsDone: number;
  turnsAllowed: number;
  costUsd: number | null;
  costUnknownTurns: number;
  cost?: { knownUsd: number; unknownTurns: number };
  openProposals: number;
  needsApproval: number;
  actions: number;
  // Same meaning as on TeamRoom: the proposal a paused room waits on.
  pausedFor?: string | null;
}

export interface TeamRoomListResponse {
  rooms: TeamRoomSummary[];
  // The room the server holds its one active slot for, or null when none. It can read "needs_you" on
  // disk while the server is about to resume it (a decision was just made), so Hold to stop all stops it
  // too. Absent on an older server.
  activeRoomId?: string | null;
}

export type TeamProposalStatus =
  | "open"
  | "agreed"
  | "disputed"
  | "needs_approval" // waiting for you (a card)
  | "approved"
  | "rejected"
  | "applied" // a file proposal that was saved
  | "refused" // a file write the server refused (see the action's failReason)
  | string;

export interface TeamProposal {
  id: string; // "P1", "P2", ...
  by: "hermes" | "openclaw";
  byLabel: string;
  kind: "decision" | "file";
  summary: string;
  file?: { name: string; content: string };
  status: TeamProposalStatus;
  statusReason?: string;
  turn: number;
  createdAt: string;
  agreedBy?: string;
  agreedAt?: string;
  disputedBy?: string;
  disputeReason?: string;
  actionId?: string;
  userDecision?: "approve" | "reject";
  decidedAt?: string;
}

export interface TeamAction {
  id: string; // "A1", ...
  proposalId: string;
  kind: "file_write";
  path: string; // relative to the workspace, e.g. team/<room>/plan.md
  created: boolean;
  updated: boolean;
  backup: string | null;
  at: string;
  undone: boolean;
  undoneAt: string | null;
  // A write the server refused (for example the target is a symlink):
  // nothing was saved, so there is nothing to undo.
  failed?: boolean;
  failReason?: string;
}

export type TeamRoomEventType =
  | "room_started"
  | "turn_started"
  | "turn_ended"
  | "note"
  | "proposal"
  | "agreement"
  | "disagreement"
  | "proposal_status"
  | "proposal_decided"
  | "protocol_note"
  | "room_hint"
  | "action"
  | "action_undone"
  | "limits_extended"
  | "status";

export interface TeamParsedReply {
  kind: "note" | "propose" | "propose_file" | "agree" | "disagree" | "none";
  text?: string;
  summary?: string;
  proposalId?: string;
  reason?: string;
  problem?: string;
  file?: { name: string; content: string };
}

export interface TeamRoomEvent {
  seq: number;
  t: string;
  type: TeamRoomEventType;
  turn?: number;
  agentId?: "hermes" | "openclaw";
  runId?: string;
  status?: string;
  reason?: string | null;
  text?: string;
  // null = this turn reported no cost (unknown); 0 = it reported a real zero.
  costUsd?: number | null;
  // The model the agent used for this turn, when it said so (for example "ollama/llama3.2:3b").
  model?: string | null;
  // Tool calls the agent reported trying, when it said so.
  toolSummary?: { calls: number; failures: number } | null;
  parsed?: TeamParsedReply;
  proposal?: TeamProposal;
  proposalId?: string;
  actionId?: string;
  decision?: string;
  message?: string;
  path?: string;
  [key: string]: unknown;
}

export interface TeamRoomDetail {
  room: TeamRoom;
  proposals: TeamProposal[];
  actions: TeamAction[];
  notebook: string;
  events: TeamRoomEvent[];
}

export interface StartTeamRoomInput {
  task: string;
  limits?: Partial<Pick<TeamRoomLimits, "maxTurns" | "maxMinutes" | "maxCostUsd">>;
  // Optional model for OpenClaw in this room, for example "ollama/phi4".
  openclawModel?: string;
}

export interface TeamProposalDecisionResult {
  proposal: TeamProposal;
  action: TeamAction | null;
  // true when this decision ended the pause the room was in and the room carried on.
  resumed?: boolean;
}

// ---------------------------------------------------------------------------
// Sessions (SP3): an agent's own terminal, kept by server/runtime/sessions/. These mirror manager.js's
// SessionSummary, routes.js's answers and ws.js's frames (spec "SP3 Sessions engine and page"; the SP3
// contract). Frames are read defensively by src/ui/sessionsShared.ts (parseServerFrame).
// ---------------------------------------------------------------------------

// "setup": OpenClaw's ChatGPT sign-in in a brain card (plan-brains spec §1). The server lists it only with
// ?kind=all and leaves it out of the quit check, so the Sessions page, Home, the menu's count and the quit
// question never see one; Hold to stop all does.
export type SessionKind = "agent" | "update" | "setup";

// SP4's signals bring "waiting" (a question or an approval) and "held" (the plan ran out).
export type SessionStatus = "starting" | "live" | "waiting" | "idle" | "held" | "exited";

// "stop" or "quit" when Agent OS ended the session, otherwise null.
export type SessionEndedBy = "stop" | "quit" | null;

// SP4 (Task U5 adds these; the server fills them from Task X1a on): every session's alert state travels in GET
// /api/sessions as well as on the WebSocket (ruling R22), so a tab that is not attached still shows its marker.
export type SignalKind = "waiting" | "turn_done" | "limit" | "approval" | "resolved";
export type AlertKind = "waiting" | "approval" | "limit";

export interface SessionAlert {
  kind: AlertKind;
  // The server's cleaned short text (at most 200 characters): "Wants to use Bash", "May need you", OpenClaw's summary.
  text: string;
  at: string;
}

// Why Claude Code's own settings keep Agent OS's hooks or status line out of this session (ruling R9, K10).
export type HooksOffCode = "managed_hooks_only" | "all_hooks_disabled" | "http_hook_urls" | "http_hook_env_vars" | "managed_status_line";

// What Claude Code's own status line reports (Task X2b), for the Live meter.
export interface SessionMeter {
  model: string | null;
  // 0-100.
  contextPercent: number | null;
  contextTokens: number | null;
  // rate_limits.five_hour and .seven_day; absent on OpenRouter and Local brains (R11).
  plan: { usedPercent: number; resetsAt: string | null } | null;
  weekly: { usedPercent: number; resetsAt: string | null } | null;
  // Claude's own estimate at list prices (R11).
  costUsd: number | null;
  at: string;
}

// A hand-off typed into this session (Task X8), kept in the server's memory only.
export interface SessionHandoff {
  state: "pending" | "typed" | "copy";
  text: string;
  fromId: string | null;
  at: string;
}

// One of OpenClaw's pending approvals (Task X3). It never names a folder: OpenClaw's list has none (R16). `sessionId` is
// the Agent OS session it came from, or null when OpenClaw did not say (then it shows in every OpenClaw panel, K11).
export interface ApprovalCard {
  id: string;
  kind: "exec" | "plugin" | "system-agent";
  summary: string;
  createdAt: string;
  expiresAt: string;
  sessionId: string | null;
}

export interface ApprovalListResponse {
  approvals: ApprovalCard[];
  // The server's sentence while OpenClaw's approvals can't be read, else null.
  error: string | null;
}

// The only two answers Agent OS ever sends to OpenClaw (R16).
export type ApprovalDecision = "allow-once" | "deny";

// A moment in a session's recording (meta.json): a prompt (label only, R23), a permission asked, files changed.
export type SessionMarker =
  | { at: string; type: "prompt" }
  | { at: string; type: "permission"; text: string }
  | { at: string; type: "files"; files: Array<{ path: string; added: number | null; removed: number | null }>; more: number };

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  agentId: string;
  // The short name: "Claude Code", "Codex", "Cursor", "Hermes", "OpenClaw".
  agentLabel: string;
  folder: string;
  folderName: string;
  // false for OpenClaw until spike S5: it picks its own folder, so none is shown or claimed.
  folderShown: boolean;
  branch: string | null;
  status: SessionStatus;
  // When the current status began (ISO time), for "Idle for <time>".
  stateSince: string;
  startedAt: string;
  endedAt: string | null;
  // null when a signal ended the process.
  exitCode: number | null;
  signal: string | null;
  endedBy: SessionEndedBy;
  dismissed: boolean;
  brain: { kind: "plan" | "openrouter" | "local"; label: string } | null;
  resume: { available: boolean; reason: string | null; fallback: boolean };
  // true when Claude Code's resume found no saved conversation (nothing was ever sent in the session, or Claude
  // deleted an old transcript itself): there is nothing to resume. A server that doesn't send it means false.
  nothingToResume: boolean;
  // "full" once a turn-done session's first signal arrived (Claude Code's hooks, Codex's notifications); otherwise
  // "basic" (the 20 s rule; Hermes, Cursor and OpenClaw always).
  alerts: "full" | "basic";
  recordingBytes: number;
  // SP4: what the session waits for, or null.
  alert: SessionAlert | null;
  // How idle began: "turn_done" reads "Ready for the next message." (K21).
  idleBy: "turn_done" | "timer" | null;
  // Held only: when the plan resets, when known.
  resetAt: string | null;
  // A Claude Code session whose first hook event or status post has not arrived (the folder is not trusted yet).
  trustNeeded: boolean;
  hooksOff: { alerts: HooksOffCode | null; meter: HooksOffCode | null };
  meter: SessionMeter | null;
  // The original folder of a separate copy (Task X9), else null.
  copyOf: string | null;
  handoff: SessionHandoff | null;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  // The quiet one-line notice when the login-shell environment could not be read (H2), else null.
  environmentNotice: string | null;
  pty: { ok: boolean; reason: string | null };
  maxLive: number;
}

// POST /api/sessions/:id/stop: the session (unchanged when it had already ended), plus Stop's note: OpenClaw's
// honest "Stopped the terminal. OpenClaw may still be finishing its last step." when only its terminal could be
// stopped, otherwise null.
export interface StopSessionResult extends SessionSummary {
  note: string | null;
}

// POST /api/sessions/:id/send (SP4 Hand-off): "typed" (written into an open session of the other agent, never sent),
// "opening" (a new session of that agent started; the text is typed once it is ready, and that session's own
// `handoff` shows how it went), or "copy" (nothing could take it: `text` goes in a box with a Copy button and `reason`
// says why).
export interface HandoffResult {
  result: "typed" | "opening" | "copy";
  targetId: string | null;
  text: string;
  reason: string | null;
}

export interface SessionSettings {
  claudeFullscreen: boolean;
}

export interface SessionFolder {
  path: string;
  name: string;
  lastUsedAt: string;
}

export interface SessionFolderList {
  folders: SessionFolder[];
}

// POST /api/sessions/folder-check (SP4 worktree offer): the live sessions that already use a folder, whether it is a
// git project, and the branch a separate copy would get for the agent asked about (agentos/<agent>-<n>; null when
// the folder isn't a git project or that agent can't use a copy).
export interface FolderCheck {
  path: string;
  name: string;
  git: boolean;
  branch: string | null;
  inUse: Array<{ id: string; agentLabel: string; title: string }>;
}

export interface QuitCheckItem {
  id: string;
  title: string;
  // An update session is never resumed, so the quit question promises a resume only when none is listed.
  kind: SessionKind;
}

export interface QuitCheckResponse {
  live: QuitCheckItem[];
}

export interface RecordingSummary {
  sessionId: string;
  // Update rows read "<agent> update" (spec, Session kinds).
  kind: SessionKind;
  agentId: string;
  agentLabel: string;
  folder: string;
  folderName: string;
  // false for OpenClaw until spike S5: its row reads "OpenClaw · Set by OpenClaw", never a folder it may not use.
  folderShown: boolean;
  startedAt: string;
  endedAt: string | null;
  bytes: number;
  live: boolean;
}

export interface RecordingListResponse {
  recordings: RecordingSummary[];
  // How many recordings were removed to stay under 1 GB since the server started (Q38).
  removedByCap: number;
}

// Files changed (SP4): GET /api/sessions/:id/changes and /changes/diff (server/runtime/sessions/changes.js, Task X7),
// shown by the side panel's Files changed section (Task U7). Paths are relative to the repository's top level, which
// may be above the session's folder (contract K12).
export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "other";
  // Lines added and removed; null when git can't count them (a binary file, or a new file too big to count).
  added: number | null;
  removed: number | null;
  // Where a renamed file came from.
  oldPath?: string;
}

export interface ChangesResult {
  // false: the folder is not inside a git project; null: the server has not read git yet.
  git: boolean | null;
  // At most 200 files (CHANGES_MAX_FILES); `total` counts them all.
  files: ChangedFile[];
  total: number;
  // When git was read (ISO time); null before the first read.
  at: string | null;
}

export interface DiffResult {
  path: string;
  // The file's `git diff` as plain text (no colour); when `cut` is true, only its first 256 KB (DIFF_MAX_BYTES).
  diff: string;
  binary: boolean;
  cut: boolean;
}

// The terminal modes a snapshot carries (mirror.js), put back on reattach (spec, Browser terminal).
export type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncodingMode = "default" | "sgr" | "sgr-pixels";

export interface SessionModes {
  altScreen: boolean;
  bracketedPaste: boolean;
  mouseTracking: MouseTrackingMode;
  mouseEncoding: MouseEncodingMode;
  focusReporting: boolean;
  cursorKeysApp: boolean;
  kittyFlags: number;
}

export interface SessionSnapshot {
  data: string;
  cols: number;
  rows: number;
  modes: SessionModes;
}

export interface SessionStateFrame {
  status: SessionStatus;
  exitCode: number | null;
  signal: string | null;
  endedBy: SessionEndedBy;
  resetAt: string | null;
}

// Server to client, one JSON message per frame (ws.js).
export type SessionServerFrame =
  | ({ t: "snapshot" } & SessionSnapshot)
  | { t: "out"; seq: number; d: string }
  | ({ t: "state" } & SessionStateFrame)
  | { t: "alert"; kind: AlertKind | "resolved"; text: string };

// Client to server.
export type SessionClientFrame =
  | { t: "focus" }
  | { t: "in"; d: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "ack"; seq: number };
