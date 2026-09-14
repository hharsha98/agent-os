export type ChatMode = "not_wired" | "dry_run" | "preview" | "unavailable" | "not_in_unified_chat";

export type LocalAgentRecord = {
  id: string;
  name: string;
  eyebrow?: string;
  status: string;
  available: boolean;
  version?: string;
  model?: string;
  connection?: string;
  summary?: string;
  hint?: string;
  cli?: { found: boolean; command: string; version: string | null };
  chat?: { mode: ChatMode; routed: boolean; label: string; detail: string };
  liveExecution?: { allowed: boolean; label: string; detail: string };
  nextAction?: string;
};

export type LocalAgentDashboard = {
  ok: boolean;
  hosted: boolean;
  edition: string;
  generatedAt: string;
  executionGate: {
    enabled: boolean;
    source: string;
    dryRunDefault: boolean;
    publicSummary: string;
  };
  summary: {
    total: number;
    cliFound: number;
    chatDryRun: number;
    chatPreview: number;
    notWired: number;
    notInstalled: number;
    dashboardChatReady: number;
    connected: number;
    executionEnabled: boolean;
    dryRunDefault: boolean;
  };
  agents: LocalAgentRecord[];
};

export type ProductStatus = {
  ok: boolean;
  hosted: boolean;
  edition: string;
  name: string;
  publicSummary: string;
  port: number;
  env: { loaded: boolean; publicMode: boolean; requireAuth: boolean };
  executionGate: LocalAgentDashboard["executionGate"];
  agents: LocalAgentDashboard["summary"];
  firstRun: Array<{ id: string; label: string; done: boolean; detail: string }>;
};

export function chatLabel(agent?: LocalAgentRecord | null) {
  if (agent?.chat?.label) return agent.chat.label;
  if (!agent) return "Checking";
  if (agent.id === "cursor") return agent.available ? "CLI found · chat not wired" : "Not installed";
  if (agent.status === "preview") return "API preview";
  if (agent.status === "dry_run") return "Dry run";
  if (agent.status === "cli_present") return "CLI found · chat not wired";
  if (agent.status === "not_installed" || agent.available === false) return "Not installed";
  return "Dry run";
}

export function statusTone(status = "") {
  if (status === "dry_run" || status === "preview" || status === "cli_present") return "partial";
  if (status === "not_installed" || status === "unavailable" || status === "missing_dependency") return "missing";
  if (status === "connected") return "live";
  return "partial";
}
