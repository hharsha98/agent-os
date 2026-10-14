import type { CSSProperties, MouseEvent } from "react";
import { navigateTo } from "../../nav";
import { describeBrain, isBuilderId, PLAN_OF } from "../builderShared";
import { agentLine, HOME_AGENTS, lastRunsByAgent, liveRunsByAgent, operatorBrain, type HomeAgentId } from "../homeShared";
import type { HomeData } from "../useHomeData";
import StatusWord from "./StatusWord";
import { useOnboarding } from "./useOnboarding";

const COLS = { "--os-table-cols": "140px minmax(0, 1fr) 170px" } as CSSProperties;

function Brain({ id, data, installed }: { id: HomeAgentId; data: HomeData; installed: boolean }) {
  const onboarding = useOnboarding();
  const checklistSaysBrain = Boolean(onboarding.data?.facts?.brains?.includes(id));
  if (!installed) return <span className="os-home-brain__t">—</span>;
  if (isBuilderId(id)) {
    // "…" while the read is under way; "—" once it failed or timed out (Home retries it).
    if (!data.brains) return <span className="os-home-brain__t">{data.brainsFailed ? "—" : "…"}</span>;
    const words = describeBrain(id, data.brains[id]);
    return (
      <>
        <span className="os-home-brain__t">{words.modeLabel}</span>
        {words.model ? (
          <code className="os-home-brain__model os-mono" title={words.fullModel || undefined}>{words.model}</code>
        ) : words.mode === "plan" ? (
          <span className="os-table__sub">Uses {PLAN_OF[id]}</span>
        ) : null}
      </>
    );
  }
  const brain = operatorBrain(data.models[id as "hermes" | "openclaw"]);
  if (brain.kind === "loading") return <span className="os-home-brain__t">…</span>;
  if (brain.kind === "unknown") return <span className="os-home-brain__t">—</span>;
  if (brain.kind === "none") {
    // The Get started checklist and this table read the brain from two different places. When the checklist says
    // this agent has a brain, this table must not say "Not set" next to it: the two disagree, so it is unknown.
    if (checklistSaysBrain) {
      return (
        <span className="os-home-brain__t" title="The setup check says this agent has a brain, but its model could not be read.">
          —
        </span>
      );
    }
    return <span className="os-home-brain__t">Not set</span>;
  }
  return (
    <>
      <span className="os-home-brain__t">{brain.label}</span>
      {brain.model ? <code className="os-home-brain__model os-mono">{brain.model}</code> : null}
    </>
  );
}

export default function HomeAgentTable({ data }: { data: HomeData }) {
  const list = data.agents.state === "ok" ? data.agents.data : [];
  const runs = data.runs.state === "ok" ? data.runs.data : [];
  const live = liveRunsByAgent(runs);
  const last = lastRunsByAgent(runs);
  const open = (event: MouseEvent, id: string) => {
    event.preventDefault();
    navigateTo("agents", { agent: id });
  };
  const group = (role: "operator" | "builder", title: string, blurb: string) => (
    <>
      <div className="os-table__group" role="presentation">
        {title}
        <span>{blurb}</span>
      </div>
      {HOME_AGENTS.filter((a) => a.role === role).map((a) => {
        const summary = list.find((x) => x.id === a.id);
        const line = agentLine({ agents: data.agents.state, runs: data.runs.state, summary, live: live[a.id], last: last[a.id], now: data.now });
        return (
          <a key={a.id} className="os-table__row os-home-agent" role="row" href={`?page=agents&agent=${a.id}`} onClick={(e) => open(e, a.id)}>
            <div className="os-table__cell" role="cell">
              <span className="os-table__title">{a.name}</span>
              <span className="os-table__sub">{a.maker}</span>
            </div>
            <div className="os-table__cell os-home-brain" role="cell">
              <Brain id={a.id} data={data} installed={Boolean(summary?.detected.installed)} />
            </div>
            <div className="os-table__cell" role="cell">
              <StatusWord state={line.state} label={line.label} />
              {line.where ? <span className="os-home-agent__where os-trunc" title={line.where}>{line.where}</span> : null}
            </div>
          </a>
        );
      })}
    </>
  );
  return (
    <div className="os-table os-home-agents" role="table" aria-label="Agents" style={COLS}>
      <div className="os-table__head" role="row">
        <span className="os-table__cell" role="columnheader">Agent</span>
        <span className="os-table__cell" role="columnheader">Brain</span>
        <span className="os-table__cell" role="columnheader">Status</span>
      </div>
      {group("operator", "Operators", "Always-on assistants")}
      {group("builder", "Builders", "Coding agents")}
    </div>
  );
}
