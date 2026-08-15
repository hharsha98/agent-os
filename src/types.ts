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

export interface WorkspaceListing {
  ok: boolean;
  generatedAt: string;
  roots: Array<{
    id: string;
    label: string;
    publicPath: string;
    fileCount: number;
  }>;
  files: WorkspaceFile[];
  empty: boolean;
  summary: {
    total: number;
    shown: number;
  };
}

export interface WorkspaceFileDetail {
  ok: boolean;
  file: WorkspaceFile & { mime?: string };
  previewText: string;
  rawUrl: string;
}
