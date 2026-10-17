// The two ways to pick a model, as two clear buttons, shown on each agent's
// Brain card and in Setup's brain step:
//   "Change model"              -> the in-app picker (search, filters, prices)
//   "Choose on OpenRouter ↗"    -> a small panel: browse OpenRouter and paste a
//                                  model ID, or use a preset (beta)
// Nothing changes until the person applies a model in one of them.
import { useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import AgentModelPicker from "./AgentModelPicker";
import OpenRouterWebsitePanel from "./OpenRouterWebsitePanel";
import type { AgentModelInfo, BrainAgentId } from "../../setupApi";
import type { BrainAgentLine } from "../brainShared";
import "../modelPicker.css";

type Mode = "none" | "picker" | "web";

export default function BrainModelActions({
  agents,
  models,
  initialAgents,
  onChanged,
  extraActions,
  onChangeModel
}: {
  agents: BrainAgentLine[];
  // What each agent uses now (see useAgentModels).
  models: Partial<Record<BrainAgentId, AgentModelInfo | null>>;
  // Ticked to start with (the Brain card of one agent ticks just that agent).
  initialAgents?: BrainAgentId[];
  // A model really was changed: the screen should read it again.
  onChanged: () => void;
  // More buttons for the same row (the Brain card's "Change brain").
  extraActions?: ReactNode;
  // When given, Change model calls this instead of opening the OpenRouter picker (OpenClaw on a plan brain: its
  // model list is on the plan card, spec 2026-10-15 section 6). Setup never passes it.
  onChangeModel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("none");
  if (!agents.some((agent) => agent.installed)) return extraActions ? <div className="os-mp-actions">{extraActions}</div> : null;

  return (
    <>
      <div className="os-mp-actions">
        <button
          type="button"
          className="os-btn os-btn--secondary"
          onClick={() => (onChangeModel ? onChangeModel() : setMode("picker"))}
          aria-haspopup={onChangeModel ? undefined : "dialog"}
        >
          Change model
        </button>
        <button
          type="button"
          className="os-btn os-btn--secondary"
          onClick={() => setMode((current) => (current === "web" ? "none" : "web"))}
          aria-expanded={mode === "web"}
        >
          Choose on OpenRouter <ExternalLink size={13} aria-hidden="true" />
        </button>
        {extraActions}
      </div>

      {mode === "picker" ? (
        <AgentModelPicker agents={agents} models={models} initialAgents={initialAgents} onClose={() => setMode("none")} onChanged={onChanged} />
      ) : null}
      {mode === "web" ? (
        <OpenRouterWebsitePanel agents={agents} models={models} initialAgents={initialAgents} onChanged={onChanged} onClose={() => setMode("none")} />
      ) : null}
    </>
  );
}
