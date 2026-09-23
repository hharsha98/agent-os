export type ChatMode = "not_wired" | "dry_run" | "preview" | "unavailable" | "not_in_unified_chat" | "demo" | "live" | "omniroute";

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
  simulated?: boolean;
  realSession?: boolean;
  badge?: string;
  hostCli?: { found: boolean; command: string; version: string | null };
  cli?: { found: boolean; command: string; version: string | null; simulated?: boolean; online?: boolean };
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
    simulated?: boolean;
    demoOnline?: number;
  };
  agents: LocalAgentRecord[];
};

export type ProductStatus = {
  ok: boolean;
  hosted: boolean;
  edition: string;
  demoPublic?: boolean;
  liveChat?: boolean;
  badge?: string | null;
  name: string;
  publicSummary: string;
  port: number;
  bind?: string;
  env: { loaded: boolean; publicMode: boolean; requireAuth: boolean; demoPublic?: boolean };
  executionGate: LocalAgentDashboard["executionGate"];
  agents: LocalAgentDashboard["summary"];
  firstRun: Array<{ id: string; label: string; done: boolean; detail: string }>;
};

export function cursorChatNotice(
  agent: LocalAgentRecord | undefined,
  options: { loaded: boolean; error?: string } = { loaded: false }
) {
  if (!options.loaded) {
    return {
      persist: false,
      badge: "Checking",
      text: "Still checking whether the Cursor CLI is on PATH. Nothing was marked connected."
    };
  }
  if (agent?.simulated || agent?.chat?.mode === "demo") {
    return {
      persist: true,
      badge: "Demo",
      text: "Cursor is simulated for this public demo. Your real Cursor session is not connected, and no CLI was started."
    };
  }
  if (!agent && options.error) {
    return {
      persist: false,
      badge: "Error",
      text: `Could not load agent status (${options.error}). Nothing was marked connected.`
    };
  }
  if (agent?.cli?.found || agent?.available) {
    return {
      persist: true,
      badge: chatLabel(agent),
      text: "Cursor Agent is installed on this machine, but dashboard chat routing is not wired. This is not a fake success."
    };
  }
  return {
    persist: true,
    badge: chatLabel(agent),
    text: "Cursor Agent CLI was not found. Install is not part of this page, and this is not marked connected."
  };
}

export function chatLabel(agent?: LocalAgentRecord | null) {
  if (agent?.chat?.label) return agent.chat.label;
  if (!agent) return "Checking";
  if (agent.id === "cursor") return agent.available ? "CLI found · chat not wired" : "Not installed";
  if (agent.status === "preview") return "API preview";
  if (agent.status === "dry_run") return "Dry run";
  if (agent.status === "cli_present") {
    return agent.id === "openclaw" ? "CLI found · not in Chat" : "CLI found · chat not wired";
  }
  if (agent.status === "not_installed" || agent.available === false) return "Not installed";
  return "Dry run";
}

export function statusTone(status = "") {
  if (status === "demo") return "demo";
  if (status === "dry_run" || status === "preview" || status === "cli_present") return "partial";
  if (status === "not_installed" || status === "unavailable" || status === "missing_dependency") return "missing";
  if (status === "connected" || status === "live" || status === "omniroute") return "live";
  return "partial";
}
