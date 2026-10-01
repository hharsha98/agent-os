// A plain-English error banner for the Team Room, shared by the start form and
// the room view. Each known server error code gets one sentence and a link
// that goes straight to the screen where it gets fixed.
import { AlertTriangle } from "lucide-react";
import { TeamRoomError } from "../../api";
import { navigateTo } from "../../nav";
import { agentLabel } from "../teamRoomShared";

export interface TeamProblem {
  code: string;
  message: string;
  agent?: string;
  agents?: string[];
  roomId?: string | null;
}

export function problemFromError(error: unknown): TeamProblem {
  if (error instanceof TeamRoomError) {
    return { code: error.code, message: error.message, agent: error.agent, agents: error.agents, roomId: error.roomId };
  }
  return { code: "unknown", message: error instanceof Error ? error.message : "Couldn't reach Agent OS." };
}

export default function TeamRoomProblem({
  problem,
  onOpenRoom
}: {
  problem: TeamProblem;
  onOpenRoom?: (id: string) => void;
}) {
  let body: string;
  let action: { label: string; run: () => void } | null = null;
  if (problem.code === "execution_gate_off") {
    body = "Safety is on Look only, so agents can't run. Allow running agents in Safety, then come back.";
    action = { label: "Open Safety", run: () => navigateTo("safety") };
  } else if (problem.code === "agent_missing") {
    body = `${agentLabel(problem.agent)} isn't installed, and a Team Room needs both Hermes Agent and OpenClaw.`;
    action = { label: "Open Setup", run: () => navigateTo("setup") };
  } else if (problem.code === "safeguards_off") {
    const names = (problem.agents?.length ? problem.agents : [problem.agent || ""]).map((id) => agentLabel(id || undefined));
    body = `${names.join(" and ")} could run commands without asking. Turn its safeguard back on, then try again.`;
    action = { label: "Open Agents", run: () => navigateTo("agents", { agent: problem.agents?.[0] || problem.agent || "" }) };
  } else if (problem.code === "room_already_running") {
    body = "Another Team Room is still running. Stop it or wait for it to finish before starting a new one.";
    const id = problem.roomId;
    if (id && onOpenRoom) action = { label: "Open the running room", run: () => onOpenRoom(id) };
  } else {
    body = problem.message || "Something went wrong.";
  }
  return (
    <div className="os-team__problem" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <p>{body}</p>
      {action ? (
        <button type="button" className="os-btn os-btn--secondary" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
