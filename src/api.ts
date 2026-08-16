import type {
  BuilderBootstrap,
  BuilderBootstrapPrepareResult,
  BuilderReplayOverlay,
  BuilderStatus,
  BuilderLogs,
  BuilderSmokeTest,
  AdminSession,
  ConnectionsResponse,
  ExecutionGateStatus,
  GoalLoopResult,
  Health,
  InstallResult,
  AgentOsReadiness,
  AgentRuns,
  IntegrationSnapshot,
  KernelStatus,
  MemoryExport,
  MemoryVectorRebuildResult,
  MemorySearchResult,
  MemoryState,
  ModuleLogs,
  ModuleRunResult,
  ModuleRuns,
  ModuleSessionResult,
  ModuleSessions,
  OsAudit,
  OsStatus,
  ProviderLocalDoctor,
  ProviderHealthState,
  ProviderModelInventory,
  ProviderModelPrepareResult,
  ProviderRouterStatus,
  ProviderSetupState,
  ProviderSetupTestResult,
  RouterRunResult,
  RuntimeModule,
  SchedulerRunResult,
  SchedulerTickResult,
  SchedulerState,
  SeoAuditResult,
  SeoRankResult,
  SeoSearchResult,
  SetupState,
  SelfModuleState,
  SkillBundleImportResult,
  SkillDependencyPrepareResult,
  SkillMarketplaceState,
  SkillPublishersState,
  SkillRegistryState,
  SkillTestResult,
  UsageBillingImportPreview,
  UsageBillingImportResult,
  UsageReconciliationState,
  UsageState,
  VoiceCommandResult,
  VoiceControlStatus,
  VoiceDesktopContext,
  VideoJobResult,
  VideoWorkerStatus,
  WorkflowEvents,
  WorkflowReplay,
  WorkflowRun,
  WorkflowSummary,
  WorkspaceFileDetail,
  WorkspaceListing
} from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function getHealth() {
  return request<Health>("/api/health");
}

export async function getRuntimeSnapshot(): Promise<IntegrationSnapshot> {
  const [osStatus, moduleData] = await Promise.all([
    request<OsStatus>("/api/os/status"),
    request<{ modules: RuntimeModule[] }>("/api/modules")
  ]);
  return {
    generatedAt: osStatus.generatedAt,
    host: osStatus.host,
    mode: osStatus.mode,
    publicUrl: osStatus.publicUrl,
    githubRepo: osStatus.githubRepo,
    integrations: moduleData.modules,
    directories: Object.entries(osStatus.store || {}).map(([label, path]) => ({ label, path, exists: true })),
    flow: ["Firecrawl Builder", "Module Registry", "Model Routing", "Workflows", "Local Store", "Export Audit"],
    osStatus
  };
}

export function getIntegrations() {
  return getRuntimeSnapshot();
}

export function getOsAudit() {
  return request<OsAudit>("/api/os/audit");
}

export function getVoiceControlStatus() {
  return request<VoiceControlStatus>("/api/voice/status");
}

export function getVoiceDesktopContext(includeUiElements = true) {
  return request<VoiceDesktopContext>(`/api/voice/context?ui=${includeUiElements ? "1" : "0"}`);
}

export function runVoiceCommand(payload: { transcript?: string; message?: string; prompt?: string; dryRun?: boolean; useModel?: boolean }) {
  return request<VoiceCommandResult>("/api/voice/command", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getKernelStatus() {
  return request<KernelStatus>("/api/os/kernel");
}

export function getAgentOsReadiness() {
  return request<AgentOsReadiness>("/api/os/readiness");
}

export function getAdminSession() {
  return request<AdminSession>("/api/admin/session");
}

export function adminLogin(adminToken: string) {
  return request<{ ok: boolean; session: AdminSession }>("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ adminToken })
  });
}

export function adminLogout() {
  return request<{ ok: boolean }>("/api/admin/logout", {
    method: "POST",
    body: "{}"
  });
}

export function getExecutionGateStatus() {
  return request<ExecutionGateStatus>("/api/execution-gate");
}

export function updateExecutionGate(payload: { enabled: boolean; reason?: string }) {
  return request<ExecutionGateStatus>("/api/admin/execution-gate", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getSetupState() {
  return request<SetupState>("/api/setup");
}

export function saveSetupState(payload: Pick<SetupState, "mode" | "preferredProvider"> & { completed?: boolean }) {
  return request<SetupState>("/api/setup", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function startFirstSetupWorkflow() {
  return request<{ setup: SetupState; run: WorkflowRun }>("/api/setup/start-first-workflow", {
    method: "POST",
    body: "{}"
  });
}

export function getProviderSetupState() {
  return request<ProviderSetupState>("/api/setup/providers");
}

export function configureProviderSetup(id: string, payload: { fields?: Record<string, string>; model?: string }) {
  return request<{ ok: boolean; guide: ProviderSetupState["guides"][number] }>(`/api/setup/providers/${id}/configure`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function testProviderSetup(id: string) {
  return request<ProviderSetupTestResult>(`/api/setup/providers/${id}/test`, {
    method: "POST",
    body: "{}"
  });
}

export function getOllamaDoctor() {
  return request<ProviderLocalDoctor>("/api/setup/providers/ollama/doctor");
}

export function getProviderModelInventory(id: string) {
  return request<ProviderModelInventory>(`/api/setup/providers/${id}/models`);
}

export function prepareProviderModel(id: string, payload: { model?: string; execute?: boolean }) {
  return request<ProviderModelPrepareResult>(`/api/setup/providers/${id}/pull-model`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getRouterStatus() {
  return request<ProviderRouterStatus>("/api/router/status");
}

export function configureRouter(payload: { fallbackOrder?: string[]; models?: Record<string, string> }) {
  return request<ProviderRouterStatus>("/api/router/configure", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runProviderRouter(payload: { prompt: string; provider?: string; dryRun?: boolean }) {
  return request<RouterRunResult>("/api/router/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getRouterHealth(provider?: string) {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  return request<ProviderHealthState>(`/api/router/health${query}`);
}

export function getUsageState() {
  return request<UsageState>("/api/usage");
}

export function getUsageReconciliation() {
  return request<UsageReconciliationState>("/api/usage/reconciliation");
}

export function configureUsageBudget(payload: { dailyLimit?: number; monthlyLimit?: number; warningThreshold?: number }) {
  return request<UsageState>("/api/usage/budget", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function recordUsageEvent(payload: Record<string, string | number | boolean>) {
  return request<{ item: UsageState["items"][number]; usage: UsageState }>("/api/usage/record", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function previewUsageBillingImport(payload: Record<string, string | number | boolean>) {
  return request<UsageBillingImportPreview>("/api/usage/import/preview", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function importUsageBilling(payload: Record<string, string | number | boolean>) {
  return request<UsageBillingImportResult>("/api/usage/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runUsageReconciliation(payload: { provider?: string }) {
  return request<{ ok: boolean; checkedAt: string; results: UsageReconciliationState["history"]; reconciliation: UsageReconciliationState }>("/api/usage/reconciliation/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getSchedulerState() {
  return request<SchedulerState>("/api/scheduler");
}

export function saveSchedulerJob(payload: Record<string, unknown>) {
  return request<SchedulerState["jobs"][number]>("/api/scheduler/jobs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runSchedulerJob(id: string, payload: Record<string, unknown> = {}) {
  return request<SchedulerRunResult>(`/api/scheduler/jobs/${id}/run`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function pauseSchedulerJob(id: string) {
  return request<SchedulerState["jobs"][number]>(`/api/scheduler/jobs/${id}/pause`, {
    method: "POST",
    body: "{}"
  });
}

export function resumeSchedulerJob(id: string) {
  return request<SchedulerState["jobs"][number]>(`/api/scheduler/jobs/${id}/resume`, {
    method: "POST",
    body: "{}"
  });
}

export function approveSchedulerJob(id: string, note = "") {
  return request<SchedulerState["jobs"][number]>(`/api/scheduler/jobs/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ note })
  });
}

export function rejectSchedulerJob(id: string, note = "") {
  return request<SchedulerState["jobs"][number]>(`/api/scheduler/jobs/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ note })
  });
}

export function runSchedulerTick() {
  return request<SchedulerTickResult>("/api/scheduler/tick", {
    method: "POST",
    body: "{}"
  });
}

export function getMemoryState() {
  return request<MemoryState>("/api/memory");
}

export function getWorkspaceListing(params: { query?: string; kind?: string } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request<WorkspaceListing>(`/api/workspace${suffix}`);
}

export function getWorkspaceFileDetail(id: string) {
  return request<WorkspaceFileDetail>(`/api/workspace/file?id=${encodeURIComponent(id)}`);
}

export function writeWorkspaceFile(payload: { content: string; name?: string; folder?: string; relativePath?: string }) {
  return request<WorkspaceFileDetail>("/api/workspace/files", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getLocalAgents() {
  const data = await request<{
    agents: Array<{
      id: string;
      name: string;
      status: string;
      available: boolean;
      version?: string;
      summary?: string;
    }>;
  }>("/api/local-agents");
  return data.agents || [];
}

export function addMemory(payload: Record<string, unknown>) {
  return request<{ memory: MemoryState["memories"][number]; state: MemoryState }>("/api/memory/items", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateMemory(id: string, payload: Record<string, unknown>) {
  return request<{ memory: MemoryState["memories"][number]; state: MemoryState }>(`/api/memory/items/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function searchMemory(params: { query?: string; mode?: string; type?: string; agentId?: string; namespace?: string; privacy?: string; includeArchived?: boolean; limit?: number }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "" && value !== false) query.set(key, String(value));
  }
  return request<MemorySearchResult>(`/api/memory/search?${query.toString()}`);
}

export function configureMemoryVector(payload: Record<string, unknown>) {
  return request<MemoryState>("/api/memory/vector/config", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function rebuildMemoryVectorIndex(force = false) {
  return request<MemoryVectorRebuildResult>("/api/memory/vector/rebuild", {
    method: "POST",
    body: JSON.stringify({ force })
  });
}

export function exportMemory(payload: { includePrivate?: boolean; includeArchived?: boolean } = {}) {
  return request<MemoryExport>("/api/memory/export", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function importMemory(payload: { memories: unknown[] }) {
  return request<{ imported: number; skipped: number; state: MemoryState }>("/api/memory/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getSkillRegistry() {
  return request<SkillRegistryState>("/api/skills");
}

export function importSkillBundle(payload: Record<string, unknown>) {
  return request<SkillBundleImportResult>("/api/skills/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getSkillMarketplace() {
  return request<SkillMarketplaceState>("/api/skills/marketplace");
}

export function getSkillPublishers() {
  return request<SkillPublishersState>("/api/skills/publishers");
}

export function updateSkillPublisherPolicy(payload: { enforceAllowlist: boolean }) {
  return request<SkillMarketplaceState>("/api/skills/publishers/policy", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateSkillPublisherReputation(
  fingerprint: string,
  payload: {
    label?: string;
    website?: string;
    score?: number | null;
    tier?: string;
    source?: string;
    reputationSource?: string;
    notes?: string;
  }
) {
  return request<SkillPublishersState>(`/api/skills/publishers/${fingerprint}/reputation`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function allowSkillPublisher(fingerprint: string, payload: { label?: string; notes?: string } = {}) {
  return request<SkillPublishersState>(`/api/skills/publishers/${fingerprint}/allow`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function removeSkillPublisherAllow(fingerprint: string) {
  return request<SkillPublishersState>(`/api/skills/publishers/${fingerprint}/allow/remove`, {
    method: "POST",
    body: "{}"
  });
}

export function blockSkillPublisher(fingerprint: string, payload: { reason?: string; notes?: string } = {}) {
  return request<SkillPublishersState>(`/api/skills/publishers/${fingerprint}/block`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function removeSkillPublisherBlock(fingerprint: string) {
  return request<SkillPublishersState>(`/api/skills/publishers/${fingerprint}/block/remove`, {
    method: "POST",
    body: "{}"
  });
}

export function saveSkillMarketplaceFeed(payload: { id?: string; label?: string; url: string; enabled?: boolean }) {
  return request<SkillMarketplaceState>("/api/skills/marketplace/feeds", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function fetchSkillMarketplaceFeed(id: string) {
  return request<{ ok: boolean; feed: SkillMarketplaceState["feeds"][number]; imported: SkillMarketplaceState["items"]; rejected: Array<{ reason: string }>; marketplace: SkillMarketplaceState }>(`/api/skills/marketplace/feeds/${id}/fetch`, {
    method: "POST",
    body: "{}"
  });
}

export function importMarketplaceSkill(feedId: string, skillId: string, payload: { trustPublisher?: boolean; publisherLabel?: string } = {}) {
  return request<SkillBundleImportResult & { marketplace: SkillMarketplaceState }>(`/api/skills/marketplace/feeds/${feedId}/import/${skillId}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function trustSkillPublisher(fingerprint: string, payload: { label?: string; notes?: string; source?: string } = {}) {
  return request<SkillMarketplaceState>(`/api/skills/trust/${fingerprint}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function untrustSkillPublisher(fingerprint: string) {
  return request<SkillMarketplaceState>(`/api/skills/trust/${fingerprint}/remove`, {
    method: "POST",
    body: "{}"
  });
}

export function installSkill(id: string, payload: { allowMissingDependencies?: boolean } = {}) {
  return request<SkillRegistryState["skills"][number]>(`/api/skills/${id}/install`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function prepareSkillDependencies(id: string, payload: { execute?: boolean } = {}) {
  return request<SkillDependencyPrepareResult>(`/api/skills/${id}/dependencies/prepare`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function configureSkill(id: string, fields: Record<string, string>) {
  return request<SkillRegistryState["skills"][number]>(`/api/skills/${id}/configure`, {
    method: "POST",
    body: JSON.stringify({ fields })
  });
}

export function updateSkill(id: string, payload: { trustPublisher?: boolean; publisherLabel?: string; allowMissingDependencies?: boolean } = {}) {
  return request<SkillBundleImportResult & { marketplace: SkillMarketplaceState }>(`/api/skills/${id}/update`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function enableSkill(id: string) {
  return request<SkillRegistryState["skills"][number]>(`/api/skills/${id}/enable`, {
    method: "POST",
    body: "{}"
  });
}

export function disableSkill(id: string) {
  return request<SkillRegistryState["skills"][number]>(`/api/skills/${id}/disable`, {
    method: "POST",
    body: "{}"
  });
}

export function uninstallSkill(id: string, removeBundle = false) {
  return request<SkillRegistryState["skills"][number] | null>(`/api/skills/${id}/uninstall`, {
    method: "POST",
    body: JSON.stringify({ removeBundle })
  });
}

export function testSkill(id: string) {
  return request<SkillTestResult>(`/api/skills/${id}/test`, {
    method: "POST",
    body: "{}"
  });
}

export function testIntegration(id: string) {
  return request<{ ok: boolean; message: string; details: unknown }>(`/api/modules/${id}/test`, {
    method: "POST",
    body: "{}"
  });
}

export function sendAgentMessage(id: string, message: string, options: { dryRun?: boolean; provider?: string; profile?: string } = {}) {
  return request<ModuleRunResult>(
    `/api/modules/${id}/run`,
    {
      method: "POST",
      body: JSON.stringify({ message, ...options })
    }
  );
}

export function runModuleAction(id: string, payload: Record<string, unknown> = {}) {
  return request<ModuleRunResult>(
    `/api/modules/${id}/run`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}

export function getModuleLogs(id: string) {
  return request<ModuleLogs>(`/api/modules/${id}/logs`);
}

export function getModuleRuns(id: string) {
  return request<ModuleRuns>(`/api/modules/${id}/runs`);
}

export function getAgentRuns(limit = 30) {
  return request<AgentRuns>(`/api/agent-runs?limit=${encodeURIComponent(String(limit))}`);
}

export function getModuleSessions(id: string) {
  return request<ModuleSessions>(`/api/modules/${id}/sessions`);
}

export function getModuleSession(id: string, sessionId: string) {
  return request<ModuleSessionResult>(`/api/modules/${id}/sessions/${sessionId}`);
}

export function startModuleSession(id: string, payload: { message?: string; prompt?: string; dryRun?: boolean; timeoutMs?: number; provider?: string; profile?: string } = {}) {
  return request<ModuleSessionResult>(`/api/modules/${id}/sessions`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function stopModuleSession(id: string, sessionId: string) {
  return request<ModuleSessionResult>(`/api/modules/${id}/sessions/${sessionId}/stop`, {
    method: "POST",
    body: "{}"
  });
}

export function messageModuleSession(id: string, sessionId: string, payload: { message?: string; prompt?: string; dryRun?: boolean; provider?: string; profile?: string } = {}) {
  return request<ModuleSessionResult>(`/api/modules/${id}/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getWorkflows() {
  return request<{ workflows: WorkflowSummary[] }>("/api/workflows");
}

export function runWorkflow(id: string) {
  return request<WorkflowRun>(`/api/workflows/${id}/run`, {
    method: "POST",
    body: JSON.stringify({ trigger: "dashboard" })
  });
}

export function getWorkflowEvents(id: string, runId: string) {
  return request<WorkflowEvents>(`/api/workflows/${id}/runs/${runId}/events`);
}

export function getWorkflowReplay(id: string, runId: string) {
  return request<WorkflowReplay>(`/api/workflows/${id}/runs/${runId}/replay`);
}

export function resumeWorkflow(id: string, runId: string, payload: Record<string, unknown> = {}) {
  return request<WorkflowRun>(`/api/workflows/${id}/runs/${runId}/resume`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getBuilderStatus() {
  return request<BuilderStatus>("/api/builder/status");
}

export function getBuilderBootstrap() {
  return request<BuilderBootstrap>("/api/builder/bootstrap");
}

export function prepareBuilderBootstrap(payload: Record<string, unknown> = {}) {
  return request<BuilderBootstrapPrepareResult>("/api/builder/bootstrap/prepare", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runBuilderSmokeTest(payload: Record<string, unknown> = {}) {
  return request<BuilderSmokeTest>("/api/builder/smoke-test", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getBuilderReplayOverlay(workflowId: string, runId: string) {
  const params = new URLSearchParams({ workflowId, runId });
  return request<BuilderReplayOverlay>(`/api/builder/replay-overlay?${params.toString()}`);
}

export function builderReplayOverlayUrl(workflowId: string, runId: string) {
  const params = new URLSearchParams({
    view: "builder",
    hermesReplay: "1",
    hermesWorkflowId: workflowId,
    hermesRunId: runId
  });
  return `/agent-builder-source/?${params.toString()}`;
}

export function startBuilder() {
  return request<BuilderStatus>("/api/builder/start", {
    method: "POST",
    body: "{}"
  });
}

export function stopBuilder() {
  return request<BuilderStatus>("/api/builder/stop", {
    method: "POST",
    body: "{}"
  });
}

export function getBuilderLogs() {
  return request<BuilderLogs>("/api/builder/logs");
}

export function getConnections() {
  return request<ConnectionsResponse>("/api/connections");
}

export function configureConnection(id: string, fields: Record<string, string>) {
  return request<{ ok: boolean; id: string; configuredFields: string[]; details: unknown }>(
    `/api/connections/${id}/configure`,
    {
      method: "POST",
      body: JSON.stringify({ fields })
    }
  );
}

export function installModule(id: string, execute = false) {
  return request<InstallResult>(`/api/modules/${id}/install`, {
    method: "POST",
    body: JSON.stringify({ execute })
  });
}

export function getSelfModule(id: string) {
  return request<SelfModuleState>(`/api/self/${id}`);
}

export function createSelfModuleItem(id: string, payload: Record<string, string | number | string[]>) {
  return request<SelfModuleState>(`/api/self/${id}/items`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runGoalLoop(goalId: string, payload: { provider?: string; dryRun?: boolean; context?: string } = {}) {
  return request<GoalLoopResult>(`/api/self/goals/${goalId}/loop`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runSeoAudit(briefId: string, payload: { provider?: string; dryRun?: boolean; context?: string; timeoutMs?: number } = {}) {
  return request<SeoAuditResult>(`/api/self/seo/${briefId}/audit`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runSeoDiscovery(briefId: string, payload: { query?: string; keyword?: string; dryRun?: boolean; limit?: number; country?: string; location?: string; timeoutMs?: number } = {}) {
  return request<SeoSearchResult>(`/api/self/seo/${briefId}/discover`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runSeoRankSnapshot(briefId: string, payload: { query?: string; keyword?: string; dryRun?: boolean; limit?: number; country?: string; location?: string; timeoutMs?: number } = {}) {
  return request<SeoRankResult>(`/api/self/seo/${briefId}/rank`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getVideoWorkerStatus() {
  return request<VideoWorkerStatus>("/api/self/video/worker");
}

export function runVideoJob(jobId: string, payload: { dryRun?: boolean; operation?: string; captionProvider?: string; renderPreset?: string } = {}) {
  return request<VideoJobResult>(`/api/self/video/${jobId}/run`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function queueVideoJob(jobId: string, payload: { dryRun?: boolean; operation?: string; captionProvider?: string; renderPreset?: string } = {}) {
  return request<VideoJobResult>(`/api/self/video/${jobId}/queue`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getVideoRun(runId: string) {
  return request<VideoJobResult>(`/api/self/video/runs/${runId}`);
}

export function cancelVideoRun(runId: string) {
  return request<VideoJobResult>(`/api/self/video/runs/${runId}/cancel`, {
    method: "POST"
  });
}

export function videoRunDownloadUrl(runId: string, fileName: string) {
  return `/api/self/video/runs/${encodeURIComponent(runId)}/download/${encodeURIComponent(fileName)}`;
}
