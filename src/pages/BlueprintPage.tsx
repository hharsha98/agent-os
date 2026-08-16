import { useEffect, useState } from "react";
import { Layers3 } from "lucide-react";
import { getHealth, getLocalAgents, getMemoryContext, getMemoryState, getRouterStatus, getSelfModule, getVoiceControlStatus, getWorkspaceListing } from "../api";
import { HonestNote, PageFrame } from "./PageFrame";

type LayerState = "live" | "partial" | "missing";

type Layer = {
  id: string;
  name: string;
  video: string;
  here: string;
  state: LayerState;
};

function label(state: LayerState) {
  if (state === "live") return "Live locally";
  if (state === "partial") return "Partial";
  return "Not in this copy";
}

export default function BlueprintPage() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const [health, agents, memory, router, workspace, voice, goals, kanban, vault] = await Promise.all([
          getHealth().catch(() => null),
          getLocalAgents().catch(() => []),
          getMemoryState().catch(() => null),
          getRouterStatus().catch(() => null),
          getWorkspaceListing().catch(() => null),
          getVoiceControlStatus().catch(() => null),
          getSelfModule("goals").catch(() => null),
          getSelfModule("kanban").catch(() => null),
          getMemoryContext({ limit: 6 }).catch(() => null)
        ]);
        const ready = agents.filter((agent) => agent.available).length;
        const loopFiles = (workspace?.files || []).filter((file) => file.relativePath.startsWith("loop/") || file.id.includes("/loop/")).length;
        const shellOff = !voice?.tools.shellGate;
        setLayers([
          {
            id: "1",
            name: "Foundation",
            video: "Your laptop. Everything runs locally. No cloud OS required.",
            here: health
              ? `This dashboard is up on your Mac. Voice shell stays ${shellOff ? "off" : "on"}.`
              : "Dashboard health did not load.",
            state: health ? "live" : "missing"
          },
          {
            id: "2",
            name: "Memory",
            video: "Obsidian + Omi: one vault every agent reads before answering.",
            here: memory && vault
              ? `Local vault is live (${memory.summary.total} notes). Chat, Brain, and Goals read it before answering. Latest briefing: ${vault.briefing?.title || "none yet"}. Obsidian/Omi are optional extras, not required.`
              : memory
                ? `Memory store loaded (${memory.summary.total} notes) but the read-before-answer API did not load.`
                : "Memory API did not load.",
            state: memory && vault ? "live" : memory ? "partial" : "missing"
          },
          {
            id: "3",
            name: "Brain",
            video: "Route hard jobs to Claude, cheap jobs to free models. Swap models without rebuilding.",
            here: router
              ? `Router status: ${router.status}. Next provider: ${router.nextProvider?.label || "none"}.`
              : "Router API did not load.",
            state: router?.configured ? "live" : "partial"
          },
          {
            id: "4",
            name: "Agents",
            video: "Hermes for long jobs, Claude Code for the repo, Open Claude for image/voice. Start with Hermes.",
            here: `${ready} local CLI(s) found. Chat reads Memory first. Claude/Hermes stay dry-run. Codex uses API preview when a key is saved. Cursor chat is not wired. OpenClaw / OpenClaude stay missing until you approve installs.`,
            state: ready > 0 ? "partial" : "missing"
          },
          {
            id: "5",
            name: "Command",
            video: "One sidebar. Chat, goals, kanban. Without this you only have tools.",
            here: `This sidebar is the command center. Chat is dry-run. ${goals?.summary.total ?? 0} saved goal(s). ${kanban?.summary.total ?? 0} Kanban card(s). Overnight Goal Mode is optional on the Goals page — it stays off until you enable the local execution gate.`,
            state: "live"
          },
          {
            id: "6",
            name: "Production",
            video: "Goals, SEO, studio, notebook, workspace — work lands in one previewable home.",
            here: workspace
              ? `Workspace sandbox has ${workspace.summary.total} file(s), ${loopFiles} in loop/. You can preview and write .md notes here. Goals, Notebook, Journal, Kanban, SEO, and Studio are live local APIs. Image/voice/music stay Not configured. Overnight Goal Mode is optional.`
              : "Workspace API did not load.",
            state: workspace ? "live" : "missing"
          },
          {
            id: "7",
            name: "Loop",
            video: "Every output writes back to the vault so tomorrow starts smarter.",
            here: vault
              ? `Chat auto-saves replies. Journal, Notebook, Goals, Kanban, Brain, Swarm, and Capture write back into Memory. Loop saves timestamped workspace/loop/*.md. Vault markdown can be written to workspace/vault. Overnight Goal Mode is optional via the Goals execution gate.`
              : "Loop write-back exists, but the read-back API did not load.",
            state: vault ? "live" : "partial"
          }
        ]);
        setError("");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load layer status.");
      }
    })();
  }, []);

  return (
    <PageFrame
      kicker="SEVEN LAYERS · FROM THE YOUTUBE BLUEPRINT"
      title="The video’s operating system, mapped onto this Mac."
      hint="Julian Goldie’s free video is a 7-layer blueprint, not a zip of his paid dashboard. This page shows what that blueprint means here — live, partial, or missing — with no fake connected states."
    >
      <HonestNote>
        The last layer in the video is the Loop. Most people skip it. Here, Chat reads yesterday’s briefing, writes replies back to Memory, and Loop saves a markdown file into workspace/loop. Overnight Goal Mode is optional. Obsidian+Omi hardware, NotebookLM audio, and Midjourney are not this copy.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-layer-grid">
        {(layers.length ? layers : []).map((layer) => (
          <article key={layer.id} className="aos-panel">
            <div className="aos-panel-head">
              <div>
                <span>LAYER {layer.id}</span>
                <h2>{layer.name}</h2>
              </div>
              <em className={`aos-layer-pill ${layer.state}`}>{label(layer.state)}</em>
            </div>
            <p><strong>In the video:</strong> {layer.video}</p>
            <p><strong>On this Mac:</strong> {layer.here}</p>
          </article>
        ))}
      </div>
      <p className="aos-honest-note">
        <Layers3 size={14} /> Source: public YouTube “How to Build Your Own Agent OS” plus agentos.guide. We did not copy the paid Boardroom zip.
      </p>
    </PageFrame>
  );
}
