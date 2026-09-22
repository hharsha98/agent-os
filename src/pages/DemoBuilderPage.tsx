import { Loader2, Play, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { getDemoBuilder, runDemoBuilder, saveDemoBuilder } from "../api";
import { DEMO_BADGE, type DemoBuilderRun, type DemoWorkflow, type DemoWorkflowNode } from "../demo";
import { HonestNote, PageFrame } from "./PageFrame";

export default function DemoBuilderPage() {
  const [workflow, setWorkflow] = useState<DemoWorkflow | null>(null);
  const [selectedId, setSelectedId] = useState("plan");
  const [goal, setGoal] = useState("Plan a public-demo morning desk without touching the host.");
  const [run, setRun] = useState<DemoBuilderRun | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    void getDemoBuilder()
      .then((data) => {
        setWorkflow(data.workflow);
        setSelectedId(data.workflow.nodes[1]?.id || data.workflow.nodes[0]?.id || "");
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Could not load the demo canvas.");
      });
  }, []);

  const selected = workflow?.nodes.find((node) => node.id === selectedId) || null;

  function patchNode(patch: Partial<DemoWorkflowNode>) {
    if (!workflow || !selected) return;
    setWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === selected.id ? { ...node, ...patch } : node)
    });
  }

  async function save() {
    if (!workflow) return;
    setBusy("save");
    try {
      const saved = await saveDemoBuilder({
        name: workflow.name,
        nodes: workflow.nodes.map((node) => ({ id: node.id, label: node.label, prompt: node.prompt }))
      });
      setWorkflow(saved.workflow);
      setNotice("Canvas saved in local workflow storage. Convex was not used.");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the canvas.");
    } finally {
      setBusy("");
    }
  }

  async function simulate() {
    if (!workflow) return;
    setBusy("run");
    try {
      if (goal.trim()) {
        await saveDemoBuilder({
          name: workflow.name,
          nodes: workflow.nodes.map((node) => ({ id: node.id, label: node.label, prompt: node.prompt }))
        });
      }
      const result = await runDemoBuilder(goal.trim() || workflow.name);
      setRun(result);
      setNotice(result.workspaceFile?.relativePath
        ? `Simulated run wrote ${result.workspaceFile.relativePath}. Host shell was not used.`
        : "Simulated run finished. Host shell was not used.");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not simulate the canvas.");
    } finally {
      setBusy("");
    }
  }

  return (
    <PageFrame
      kicker="AGENT BUILDER · PUBLIC DEMO"
      title="A local workflow canvas. No Convex, no Clerk."
      hint={`${DEMO_BADGE}. Edit labels, save, and simulate a run. Your real Claude is not connected, and nothing is executed on the host.`}
      actions={
        <>
          <button className="aos-secondary" onClick={() => void save()} disabled={!workflow || busy !== ""}>
            {busy === "save" ? <Loader2 className="aos-spin" size={16} /> : <Save size={16} />} Save canvas
          </button>
          <button className="aos-primary" onClick={() => void simulate()} disabled={!workflow || busy !== ""}>
            {busy === "run" ? <Loader2 className="aos-spin" size={16} /> : <Play size={16} />} Simulate run
          </button>
        </>
      }
    >
      <div className="aos-product-banner" role="status">
        <ShieldCheck size={18} />
        <div>
          <strong>{DEMO_BADGE}</strong>
          <p>This canvas is stored with the other local workflows. The upstream Firecrawl builder and its Convex project stay unused.</p>
        </div>
      </div>
      <HonestNote>
        The human-gate node is a simulated approval. Simulate run writes demo/latest-canvas.md and does not call a model provider.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      {notice ? <p className="aos-honest-note">{notice}</p> : null}
      {!workflow ? (
        <div className="aos-empty"><Loader2 className="aos-spin" size={20} /><strong>Loading demo canvas…</strong></div>
      ) : (
        <div className="aos-demo-builder">
          <div className="aos-demo-canvas" role="list">
            {workflow.nodes.map((node, index) => (
              <button
                key={node.id}
                role="listitem"
                className={`aos-demo-node type-${node.type} ${node.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(node.id)}
              >
                <span>{index + 1}</span>
                <strong>{node.label}</strong>
                <small>{node.type}</small>
              </button>
            ))}
          </div>
          <aside className="aos-demo-inspector">
            <label className="aos-field">
              <span>Workflow name</span>
              <input value={workflow.name} onChange={(event) => setWorkflow({ ...workflow, name: event.target.value })} />
            </label>
            <label className="aos-field">
              <span>Simulate with this goal</span>
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
            </label>
            {selected ? (
              <>
                <label className="aos-field">
                  <span>Node label</span>
                  <input value={selected.label} onChange={(event) => patchNode({ label: event.target.value })} />
                </label>
                <label className="aos-field">
                  <span>Node note</span>
                  <textarea value={selected.prompt || ""} onChange={(event) => patchNode({ prompt: event.target.value })} />
                </label>
              </>
            ) : null}
          </aside>
        </div>
      )}
      {run?.nodeRuns?.length ? (
        <ol className="aos-demo-steps aos-demo-run">
          {run.nodeRuns.map((step) => (
            <li key={step.nodeId}>
              <strong>{step.label}</strong>
              <small>{step.type} · {step.status} · not executed on host</small>
              <p>{step.detail}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </PageFrame>
  );
}
