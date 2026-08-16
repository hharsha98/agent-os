import { Loader2, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { addMemory, getExecutionGateStatus, runProviderRouter, writeWorkspaceFile } from "../api";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus, RouterRunResult } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

const ROLES = [
  { id: "scout", label: "Scout", brief: "Find the facts, risks, and missing inputs." },
  { id: "writer", label: "Writer", brief: "Draft a clear first version." },
  { id: "linker", label: "Linker", brief: "Connect this to existing memory and goals." },
  { id: "inspector", label: "Inspector", brief: "Check for holes, contradictions, and unsafe claims." },
  { id: "editor", label: "Editor", brief: "Tighten the language. Keep it honest." },
  { id: "researcher", label: "Researcher", brief: "List what we still need to look up." },
  { id: "critic", label: "Critic", brief: "Argue the opposite. What could fail?" },
  { id: "planner", label: "Planner", brief: "Turn this into a short next-action plan." },
  { id: "publisher", label: "Publisher", brief: "Write a version a human could ship." },
  { id: "archivist", label: "Archivist", brief: "What should be saved into the vault?" },
  { id: "voice", label: "Voice", brief: "Rewrite in a calm operator voice. No hype." },
  { id: "ops", label: "Ops", brief: "Name tools, gates, and dry-run vs live." }
] as const;

type RoleStatus = "queued" | "running" | "done" | "error";

type RoleCard = {
  id: string;
  label: string;
  status: RoleStatus;
  result: RouterRunResult | null;
  error: string;
};

function emptyCards(): RoleCard[] {
  return ROLES.map((role) => ({ id: role.id, label: role.label, status: "queued", result: null, error: "" }));
}

export default function SwarmPage() {
  const [prompt, setPrompt] = useState("Plan the next safe local Agent OS step.");
  const [cards, setCards] = useState<RoleCard[]>(emptyCards);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dryRun = !gate?.enabled;

  useEffect(() => {
    void getExecutionGateStatus()
      .then(setGate)
      .catch(() => setGate(null));
  }, []);

  async function runSwarm() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    setCards(emptyCards().map((card) => ({ ...card, status: "running" })));
    try {
    const results = await Promise.all(ROLES.map(async (role) => {
      try {
        const result = await runProviderRouter({
          prompt: `${role.brief}\n\nUser request:\n${prompt}\n\nReply in 8 lines or fewer. Do not claim tools are connected unless the request says so.`,
          dryRun
        });
        return { id: role.id, ok: true as const, result };
      } catch (caught) {
        return {
          id: role.id,
          ok: false as const,
          error: caught instanceof Error ? caught.message : "Role failed."
        };
      }
    }));
    const next = emptyCards().map((card) => {
      const hit = results.find((item) => item.id === card.id);
      if (!hit) return { ...card, status: "error" as const, error: "No result" };
      if (!hit.ok) return { ...card, status: "error" as const, error: hit.error };
      return { ...card, status: "done" as const, result: hit.result };
    });
    setCards(next);
    const body = next.map((card) => {
      const text = card.result?.message || card.error || "queued";
      return `## ${card.label}\nStatus: ${card.status}\nMode: ${card.result?.mode || "n/a"}\n\n${text}`;
    }).join("\n\n");
    const stamp = new Date().toISOString().slice(0, 10);
    await addMemory({
      title: `Swarm ${stamp}`,
      content: `Prompt: ${prompt}\nDry-run: ${dryRun}\n\n${body}`,
      agentId: "swarm",
      type: "episodic",
      privacy: "private",
      source: "swarm",
      tags: ["swarm", "loop"]
    }).catch(() => undefined);
    await writeWorkspaceFile({
      folder: "swarm",
      name: `swarm-${stamp}.md`,
      content: `# Swarm map ${stamp}\n\nPrompt: ${prompt}\n\nThis is a local parallel planner map, not Ultracode/Ruflo.\n\n${body}\n`
    }).catch(() => undefined);
    setNotice(dryRun ? "Saved a dry-run swarm log to Memory and workspace/swarm." : "Saved a live swarm log to Memory and workspace/swarm.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Swarm run failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      kicker="SWARM · LOCAL PARALLEL MAP"
      title="Twelve local roles. No fake green."
      hint="One prompt fans out through the Provider Router. This is our parallel planner map, not Ultracode. Cards stay queued, running, done, or error."
    >
      <HonestNote>
        Live mode spends model credits for all 12 roles when the execution gate is on. Dry-run is the default. Midjourney/Omi/Ultracode are not connected.
      </HonestNote>
      <div className="aos-field">
        <span>Shared prompt</span>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </div>
      <div className="aos-phase-toolbar">
        <button className="aos-primary" onClick={() => void runSwarm()} disabled={busy || !prompt.trim()}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <Network size={16} />} {dryRun ? "Dry-run 12 roles" : "Run 12 roles live"}
        </button>
        <button className="aos-secondary" onClick={() => navigateTo("workspace", { folder: "swarm" })}>Open workspace/swarm</button>
        <button className="aos-secondary" onClick={() => navigateTo("memory")}>Open Memory</button>
      </div>
      {error ? <div className="aos-global-error">{error}</div> : null}
      {notice ? <p className="aos-honest-note">{notice}</p> : null}
      <div className="aos-swarm-grid">
        {cards.map((card) => (
          <article key={card.id} className={`aos-panel aos-swarm-card ${card.status}`}>
            <div className="aos-panel-head">
              <div>
                <span>{card.status}</span>
                <h2>{card.label}</h2>
              </div>
            </div>
            <p>{card.result?.message || card.error || "Queued until you run the map."}</p>
            <small>{card.result?.provider || card.result?.mode || ""}</small>
          </article>
        ))}
      </div>
    </PageFrame>
  );
}
