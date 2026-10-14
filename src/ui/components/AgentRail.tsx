import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import type { BuilderBrains } from "../../buildersApi";
import type { AgentSummary } from "../../types";
import { AGENT_LABEL, AGENTS_ORDER, SERVICE_AGENT_SET } from "../agentsShared";
import { railStatus, railVersion } from "../agentsPageShared";
import { isBuilderId } from "../builderShared";
import BuilderBrainBadge from "./BuilderBrainBadge";
import StatusWord from "./StatusWord";

// The Agents page's rail, grouped Operators and Builders: each agent's name, installed version
// and a status word. On desktop (≥1100px, see agents.css) it is a column beside the detail; the
// same markup becomes a horizontal scrollable strip below that, driven entirely by CSS.
export default function AgentRail({
  agents,
  resolved,
  timedOut,
  failed,
  liveCountByAgent,
  brains = null,
  selectedId,
  onSelect,
  onRetry
}: {
  agents: AgentSummary[] | null;
  resolved: boolean;
  timedOut: boolean;
  failed: boolean;
  liveCountByAgent: Record<string, number>;
  // The coding agents' saved brains, shown as a small tag under each of them.
  brains?: BuilderBrains | null;
  selectedId: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  // Below 1100px the rail is a horizontal strip; keep the selected agent in
  // view (e.g. when arriving with ?agent=cursor) without scrolling the page.
  useEffect(() => {
    const selected = navRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    const nav = navRef.current;
    if (!selected || !nav || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = selected.offsetLeft - (nav.clientWidth - selected.offsetWidth) / 2;
  }, [selectedId]);

  // Nothing has loaded and the first load failed or timed out: say "—", never "not installed".
  const gaveUp = failed || timedOut;
  const groups = [
    { label: "Operators", blurb: "Always-on assistants", ids: AGENTS_ORDER.filter((id) => SERVICE_AGENT_SET.has(id)) },
    { label: "Builders", blurb: "Coding agents", ids: AGENTS_ORDER.filter((id) => !SERVICE_AGENT_SET.has(id)) }
  ];

  return (
    <nav className="os-agent-rail" aria-label="Agents" ref={navRef}>
      {groups.map((group) => (
        <div key={group.label} className="os-agent-rail__group">
          <div className="os-table__group" role="presentation">
            {group.label}
            <span>{group.blurb}</span>
          </div>
          {group.ids.map((id) => {
            const agent = agents ? agents.find((a) => a.id === id) : undefined;
            const selected = id === selectedId;
            const status = railStatus({ resolved, gaveUp, agent, live: liveCountByAgent[id] || 0 });
            const version = railVersion({ resolved, gaveUp, agent });
            const name = agent?.label || AGENT_LABEL[id];
            return (
              <button
                key={id}
                type="button"
                className={`os-agent-rail__item${selected ? " os-agent-rail__item--selected" : ""}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(id)}
              >
                <span className="os-agent-rail__name">
                  <span className="os-agent-rail__label" title={name}>
                    {name}
                  </span>
                  <span className="os-agent-rail__version os-mono" title={agent?.detected?.installed ? version : undefined}>
                    {version}
                  </span>
                </span>
                <StatusWord state={status.state} label={status.label} />
                {brains && isBuilderId(id) ? (
                  <span className="os-agent-rail__brain">
                    <BuilderBrainBadge agentId={id} brain={brains[id]} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
      {timedOut || (failed && !resolved) ? (
        <button type="button" className="os-btn os-btn--ghost os-agent-rail__retry" onClick={onRetry}>
          <RefreshCw size={12} aria-hidden="true" /> Retry
        </button>
      ) : null}
    </nav>
  );
}
