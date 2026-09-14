import { useEffect, useState } from "react";
import { Layers3 } from "lucide-react";
import { getHealth, getLocalAgents, getMemoryContext, getMemoryState, getRouterStatus, getSelfModule, getVoiceControlStatus, getWorkspaceListing } from "../api";
import { HonestNote, PageFrame } from "./PageFrame";

type LayerState = "live" | "partial" | "missing";

type Layer = {
  id: string;
  name: string;
  intent: string;
  here: string;
  state: LayerState;
};

function label(state: LayerState) {
  if (state === "live") return "Live locally";
  if (state === "partial") return "Partial";
  return "Missing here";
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
            intent: "The dashboard runs on your machine. No cloud OS required.",
            here: health
              ? `Runtime is up. Voice shell stays ${shellOff ? "off" : "on"}.`
              : "Dashboard health did not load.",
            state: health ? "live" : "missing"
          },
          {
            id: "2",
            name: "Memory",
            intent: "One local vault agents can read before answering.",
            here: memory && vault
              ? `Local vault is live (${memory.summary.total} notes). Chat, Brain, and Goals can read it. Latest briefing: ${vault.briefing?.title || "none yet"}. Obsidian/Omi are optional extras.`
              : memory
                ? `Memory store loaded (${memory.summary.total} notes) but the read-before-answer API did not load.`
                : "Memory API did not load.",
            state: memory && vault ? "live" : memory ? "partial" : "missing"
          },
          {
            id: "3",
            name: "Brain",
            intent: "Route jobs through configured providers. Missing keys stay missing.",
            here: router
              ? `Router status: ${router.status}. Next provider: ${router.nextProvider?.label || "none"}.`
              : "Router API did not load.",
            state: router?.configured ? "live" : "partial"
          },
          {
            id: "4",
            name: "Agents",
            intent: "Detect real CLIs. Do not paint fake connected chat.",
            here: `${ready} local CLI(s) found. Chat reads Memory first. Claude/Hermes stay dry-run. Codex uses API preview when a key is saved. Cursor chat is not wired. OpenClaw stays missing until you install it.`,
            state: ready > 0 ? "partial" : "missing"
          },
          {
            id: "5",
            name: "Command",
            intent: "One sidebar for chat, goals, and boards.",
            here: `Mission Control is the default landing. Chat is dry-run. ${goals?.summary.total ?? 0} saved goal(s). ${kanban?.summary.total ?? 0} Kanban card(s). Overnight Goal Mode stays off until you enable the local execution gate.`,
            state: "live"
          },
          {
            id: "6",
            name: "Production",
            intent: "Work lands in a sandboxed workspace you can preview.",
            here: workspace
              ? `Workspace sandbox has ${workspace.summary.total} file(s), ${loopFiles} in loop/. Goals, Notebook, Journal, Kanban, SEO, and Studio are local APIs. Image/voice/music stay Not configured.`
              : "Workspace API did not load.",
            state: workspace ? "live" : "missing"
          },
          {
            id: "7",
            name: "Loop",
            intent: "Useful output can write back to Memory and workspace/loop.",
            here: vault
              ? `Chat can save replies. Journal, Notebook, Goals, Kanban, Brain, Swarm, and Capture write back into Memory. Loop saves timestamped workspace/loop/*.md.`
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
      kicker="CAPABILITY MAP · LOCAL V1"
      title="What this local checkout actually does."
      hint="Seven layers, mapped onto this machine: live, partial, or missing. Nothing here is a hosted Agent OS."
    >
      <HonestNote>
        Chat can read a Loop briefing and write replies back to Memory. Overnight Goal Mode is optional. Obsidian, NotebookLM audio, and Midjourney are not part of this local v1.
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
            <p><strong>Intent:</strong> {layer.intent}</p>
            <p><strong>On this machine:</strong> {layer.here}</p>
          </article>
        ))}
      </div>
      <p className="aos-honest-note">
        <Layers3 size={14} /> This map is a local product checklist, not a clone of anyone’s paid dashboard.
      </p>
    </PageFrame>
  );
}
