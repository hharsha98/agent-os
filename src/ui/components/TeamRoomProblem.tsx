// A plain-English notice for the Team Room, shared by the start form, the room
// view and the decision cards. Each known server error code gets one sentence
// and, where there is one, a button that goes straight to the screen that
// fixes it. It is drawn with the page kit's Banner (alert for warn and danger).
import { TeamRoomError } from "../../api";
import { navigateTo } from "../../nav";
import { agentLabel, unreachableMessage } from "../teamRoomShared";
import Banner from "./Banner";

export interface TeamProblem {
  code: string;
  message: string;
  agent?: string;
  agents?: string[];
  roomId?: string | null;
}

// `recheck` says what the page reloads after a failure with no answer: "room" in
// an open room, "rooms" on the start page.
export function problemFromError(error: unknown, recheck: "room" | "rooms" = "room"): TeamProblem {
  if (error instanceof TeamRoomError) {
    return { code: error.code, message: error.message, agent: error.agent, agents: error.agents, roomId: error.roomId };
  }
  // fetch() itself failed or timed out: Agent OS gave no answer, so the page cannot
  // know whether the request went through. The caller re-checks (see unreachableMessage).
  return { code: "unreachable", message: unreachableMessage(recheck) };
}

// "start" = starting, stopping or continuing a room. "decision" = approving a file card.
export type ProblemWhere = "start" | "decision";

export default function TeamRoomProblem({
  problem,
  where = "start",
  onOpenRoom
}: {
  problem: TeamProblem;
  where?: ProblemWhere;
  onOpenRoom?: (id: string) => void;
}) {
  let tone: "info" | "warn" | "danger" = "danger";
  let body: string = problem.message || "Something went wrong.";
  let action: { label: string; run: () => void } | null = null;
  if (problem.code === "execution_gate_off") {
    tone = "warn";
    body =
      where === "decision"
        ? "Turn on the execution gate to let the room save files."
        : "Safety is on Look only, so agents can't run. Allow running agents in Safety, then come back.";
    action = { label: "Open Safety", run: () => navigateTo("safety") };
  } else if (problem.code === "agent_missing") {
    tone = "warn";
    body = `${agentLabel(problem.agent)} isn't installed, and a Team Room needs both Hermes Agent and OpenClaw.`;
    action = { label: "Open Setup", run: () => navigateTo("setup") };
  } else if (problem.code === "safeguards_off") {
    tone = "warn";
    const names = (problem.agents?.length ? problem.agents : [problem.agent || ""]).map((id) => agentLabel(id || undefined));
    body = `${names.join(" and ")} could run commands without asking. Turn its safeguard back on, then try again.`;
    action = { label: "Open Agents", run: () => navigateTo("agents", { agent: problem.agents?.[0] || problem.agent || "" }) };
  } else if (problem.code === "room_already_running") {
    tone = "warn";
    body = "Another Team Room is still running. Stop it or wait for it to finish before starting a new one.";
    const id = problem.roomId;
    if (id && onOpenRoom) action = { label: "Open the running room", run: () => onOpenRoom(id) };
  } else if (problem.code === "not_pending") {
    // Two windows, or a double click: the proposal was already decided.
    tone = "info";
    body = "That was already decided, maybe in another window. The card now shows the result.";
  }
  return (
    <Banner
      tone={tone}
      actions={
        action ? (
          <button type="button" className="os-btn os-btn--secondary" onClick={action.run}>
            {action.label}
          </button>
        ) : undefined
      }
    >
      {body}
    </Banner>
  );
}
