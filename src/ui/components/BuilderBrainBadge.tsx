// "Plan" / "OpenRouter · claude-sonnet-4.6" / "Local · qwen3:14b": the one small
// tag that says which brain a coding agent (or one of its runs) uses. It is used
// wherever a coding agent is shown: the Agents rail and page, Home, the Runs list
// and each run. The whole model id is one hover away.
import type { BuilderId } from "../../buildersApi";
import { describeBrain } from "../builderShared";
import "../builders.css";

export default function BuilderBrainBadge({
  agentId,
  brain,
  label = "Brain"
}: {
  agentId: BuilderId;
  brain: { mode: string; model: string | null } | null | undefined;
  // Spoken to a screen reader before the tag ("Brain: Plan").
  label?: string;
}) {
  if (!brain) return null;
  const words = describeBrain(agentId, brain);
  const title = words.fullModel ? `${words.modeLabel} · ${words.fullModel}` : words.modeLabel;
  return (
    <span className={`os-bb-tag os-bb-tag--${words.mode}`} title={title}>
      <span className="os-bb-hidden">{label}: </span>
      <span className="os-bb-tag__mode">{words.modeLabel}</span>
      {words.model ? <span className="os-bb-tag__model os-mono">{words.model}</span> : null}
    </span>
  );
}
