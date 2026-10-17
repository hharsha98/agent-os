// The model picker, set up for Hermes and OpenClaw: the two as targets (each
// with what it uses now), Hermes's 64K rule as "Works with Hermes" / "Too small
// for Hermes" badges, and the apply that runs one server job per agent.
import { useMemo } from "react";
import ModelPicker from "./ModelPicker";
import type { AgentModelInfo, BrainAgentId, CatalogModel } from "../../setupApi";
import { agentApplier, buildAgentTargets } from "../agentModelChange";
import type { BrainAgentLine } from "../brainShared";
import type { ModelBadge } from "../modelPickerShared";

const BADGE_LABELS = { recommended: "Works with Hermes", experimental: "Too small for Hermes" };

export default function AgentModelPicker({
  agents,
  models,
  initialAgents,
  onClose,
  onChanged
}: {
  agents: BrainAgentLine[];
  // What each agent uses now (see useAgentModels).
  models: Partial<Record<BrainAgentId, AgentModelInfo | null>>;
  initialAgents?: BrainAgentId[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const targets = useMemo(() => buildAgentTargets(agents, models), [agents, models]);
  const apply = useMemo(() => agentApplier(agents), [agents]);
  const hermesInstalled = agents.some((agent) => agent.id === "hermes" && agent.installed);
  // The Hermes badge only means something when Hermes is there to be given a model.
  const recommend = useMemo(
    () => (hermesInstalled ? (model: CatalogModel): ModelBadge => (model.hermesOk ? "recommended" : "experimental") : undefined),
    [hermesInstalled]
  );

  return (
    <ModelPicker
      title="Change model"
      targets={targets}
      initialTargets={initialAgents}
      apply={apply}
      recommend={recommend}
      badgeLabels={BADGE_LABELS}
      onClose={onClose}
      onApplied={onChanged}
    />
  );
}
