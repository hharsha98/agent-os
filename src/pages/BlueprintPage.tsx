import { useEffect, useState } from "react";
import { Layers3 } from "lucide-react";
import { getHealth, getLocalAgents, getMemoryState, getRouterStatus, getSelfModule, getVoiceControlStatus, getWorkspaceListing } from "../api";
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
        const [health, agents, memory, router, workspace, voice, goals] = await Promise.all([
          getHealth().catch(() => null),
          getLocalAgents().catch(() => []),
          getMemoryState().catch(() => null),
          getRouterStatus().catch(() => null),
          getWorkspaceListing().catch(() => null),
          getVoiceControlStatus().catch(() => null),
          getSelfModule("goals").catch(() => null)
        ]);
        const ready = agents.filter((agent) => agent.available).length;
        setLayers([
          {
            id: "1",
            name: "Foundation",
            video: "Your laptop. Everything runs locally. No cloud OS required.",
            here: health ? "This dashboard is up on your Mac." : "Dashboard health did not load.",
            state: health ? "live" : "missing"
          },
          {
            id: "2",
            name: "Memory",
            video: "Obsidian + Omi: one vault every agent reads before answering.",
            here: memory
              ? `Local Agent OS memory is on (${memory.summary.total} notes). Obsidian/Omi are not connected.`
              : "Memory API did not load.",
            state: memory ? "partial" : "missing"
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
            here: `${ready} local CLI(s) found. OpenClaw / OpenClaude stay missing until you approve installs.`,
            state: ready > 0 ? "partial" : "missing"
          },
          {
            id: "5",
            name: "Command",
            video: "One sidebar. Chat, goals, kanban. Without this you only have tools.",
            here: "This sidebar is the command center. Chat is dry-run. Goals do not run overnight.",
            state: "live"
          },
          {
            id: "6",
            name: "Production",
            video: "Goals, SEO, studio, notebook, workspace — work lands in one previewable home.",
            here: workspace
              ? `Workspace sandbox has ${workspace.summary.total} file(s). SEO and video studio are parked.`
              : "Workspace API did not load.",
            state: "partial"
          },
          {
            id: "7",
            name: "Loop",
            video: "Every output writes back to the vault so tomorrow starts smarter.",
            here: "Chat can save a reply into local memory. It does not sync to Obsidian.",
            state: "partial"
          }
        ]);
        setError("");
        void voice;
        void goals;
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
        The last layer in the video is the Loop. Most people skip it. Saving a chat reply into Memory is our local version. Overnight Goal Mode, Obsidian+Omi, NotebookLM audio, and Midjourney are not installed in this copy.
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
