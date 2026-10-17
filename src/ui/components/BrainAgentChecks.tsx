// "Which agents get this brain": one checkbox per agent, shared by the
// OpenRouter and Local cards. An agent can only be ticked on one card at a
// time (the parent moves the tick), which is how Hermes can use OpenRouter
// while OpenClaw uses a local model.
import type { BrainAgentId } from "../../setupApi";
import type { BrainAgentLine } from "../brainShared";

export default function BrainAgentChecks({
  agents,
  assigned,
  onToggle,
  disabled = false,
  name
}: {
  agents: BrainAgentLine[];
  assigned: Set<BrainAgentId>;
  onToggle: (id: BrainAgentId, checked: boolean) => void;
  disabled?: boolean;
  name: string;
}) {
  return (
    <fieldset className="os-brain-checks" disabled={disabled}>
      <legend className="os-micro">Give it to</legend>
      <div className="os-brain-checks__row">
        {agents.map((agent) => (
          <label key={agent.id} className={`os-brain-check${agent.installed ? "" : " os-brain-check--off"}`}>
            <input
              type="checkbox"
              name={`${name}-${agent.id}`}
              checked={agent.installed && assigned.has(agent.id)}
              disabled={!agent.installed}
              onChange={(event) => onToggle(agent.id, event.target.checked)}
            />
            <span className="os-brain-check__label">{agent.label}</span>
            {!agent.installed ? (
              <span className="os-brain-check__note">not installed</span>
            ) : agent.configured ? (
              <span className="os-brain-check__note">already has a model</span>
            ) : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
