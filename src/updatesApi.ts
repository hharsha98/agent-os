// Agent updates (SP5): the saved version checks, "Check for updates" and the Update button. Every request goes through
// request() from ./api (which sends the page key through apiFetch) and has a time limit, so the page says so when
// Agent OS does not answer. The server side is server/runtime/updates/routes.js.
import { request } from "./api";
import { withTimeout } from "./ui/homeShared";

// "unknown" is Cursor's: no way to ask it for its latest version is known, so its own updater checks when the
// person presses Update.
export type UpdateState = "up-to-date" | "available" | "unknown" | "failed" | "not-installed";

export interface AgentUpdateStatus {
  agentId: string;
  // Version numbers only ("2.1.309"), or null when there is none to show.
  installed: string | null;
  latest: string | null;
  state: UpdateState;
  // When this check ended (ISO time).
  checkedAt: string;
  // OpenClaw only: updating it restarts its Gateway.
  restartsGateway?: boolean;
}

// Why Hermes is not an unchanged official copy, one code per finding (server/runtime/updates/hermes-clean.js),
// plus folder_refused (checks.js): the folder is outside the places Agent OS may work.
export interface HermesCleanAnswer {
  clean: boolean;
  reasons: string[];
}

export interface UpdatesResponse {
  agents: AgentUpdateStatus[];
  hermes: HermesCleanAnswer;
}

// What Update started: a Setup job (the four agents with a plain updater) or a terminal session (Hermes).
export type UpdateRun = { kind: "job"; id: string } | { kind: "session"; id: string };

// How long each request may take. The server's own check gives each agent up to 30 s (the five run side by side),
// and a Hermes update starts with its folder check and a login-shell environment read (up to 10 s).
export const UPDATE_LIMITS_MS = { read: 8000, refresh: 45000, start: 30000 } as const;

const UNREADABLE = "Agent OS gave an answer that could not be read.";

function readable(body: UpdatesResponse | null | undefined): UpdatesResponse {
  if (!body || !Array.isArray(body.agents) || !body.hermes || typeof body.hermes !== "object") throw new Error(UNREADABLE);
  return { agents: body.agents, hermes: { clean: body.hermes.clean === true, reasons: Array.isArray(body.hermes.reasons) ? body.hermes.reasons : [] } };
}

// What the checks last found. The server answers from memory: no check runs for this request.
export async function getUpdates(): Promise<UpdatesResponse> {
  return readable(await withTimeout(request<UpdatesResponse>("/api/updates"), UPDATE_LIMITS_MS.read));
}

// Checks all five agents (and Hermes's folder) again, then answers like getUpdates.
export async function refreshUpdates(): Promise<UpdatesResponse> {
  return readable(await withTimeout(request<UpdatesResponse>("/api/updates/refresh", { method: "POST", body: "{}" }), UPDATE_LIMITS_MS.refresh));
}

// Starts that agent's own updater. The person has confirmed, which is what `confirm: true` says to the server.
export async function startUpdate(agentId: string): Promise<UpdateRun> {
  const body = await withTimeout(
    request<{ kind?: string; jobId?: string; sessionId?: string }>(`/api/updates/${encodeURIComponent(agentId)}`, {
      method: "POST",
      body: JSON.stringify({ confirm: true })
    }),
    UPDATE_LIMITS_MS.start
  );
  if (body?.kind === "job" && typeof body.jobId === "string") return { kind: "job", id: body.jobId };
  if (body?.kind === "session" && typeof body.sessionId === "string") return { kind: "session", id: body.sessionId };
  throw new Error(UNREADABLE);
}

// The live `update` session of an agent (Hermes: the only one updated in a session), or null. The server is the one
// that knows: a session this page lost track of (the start timed out, another tab or another device started it) is
// found here, and only here, since the Sessions page does not list `update` sessions. `kind=all&live=1` lists the
// sessions running now, from the server's memory, update sessions included.
export async function findLiveUpdateSession(agentId: string): Promise<string | null> {
  const body = await withTimeout(
    request<{ sessions?: Array<{ id?: string; kind?: string; agentId?: string; status?: string }> }>("/api/sessions?kind=all&live=1"),
    UPDATE_LIMITS_MS.read
  );
  const found = Array.isArray(body?.sessions)
    ? body.sessions.find((s) => s?.kind === "update" && s.agentId === agentId && s.status !== "exited" && typeof s.id === "string" && s.id)
    : undefined;
  return found?.id ?? null;
}

// A job id is not a secret, so it may live in sessionStorage: coming back to an agent whose update job is still
// running (another agent picked and then this one again, or a reload) finds its console again. Only jobs are kept: a
// Hermes update session is looked up on the server (findLiveUpdateSession), which also finds the ones this tab never saw.
const RUN_STORAGE_KEY = (agentId: string) => `agentos.updates.run.${agentId}`;

export function rememberUpdateRun(agentId: string, run: UpdateRun | null) {
  try {
    if (run) sessionStorage.setItem(RUN_STORAGE_KEY(agentId), JSON.stringify(run));
    else sessionStorage.removeItem(RUN_STORAGE_KEY(agentId));
  } catch {
    // Storage can be blocked; the page just won't find the console again.
  }
}

export function recallUpdateRun(agentId: string): UpdateRun | null {
  try {
    const run = JSON.parse(sessionStorage.getItem(RUN_STORAGE_KEY(agentId)) || "null");
    if ((run?.kind === "job" || run?.kind === "session") && typeof run.id === "string" && run.id) return { kind: run.kind, id: run.id };
  } catch {
    // Storage blocked, or something else was kept under that name.
  }
  return null;
}
