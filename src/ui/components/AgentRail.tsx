import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import type { AgentSummary } from "../../types";
import { AGENT_LABEL, AGENT_MONOGRAM, AGENT_ROLE, AGENTS_ORDER, agentStatusWord } from "../agentsShared";
import StatusMark from "./StatusMark";

// The hangar's left rail on desktop (≥1100px, see agents.css); the same
// markup becomes a horizontal scrollable segmented selector below that
// breakpoint — one list, two layouts, driven entirely by CSS.
export default function AgentRail({
  agents,
  resolved,
  timedOut,
  failed,
  liveCountByAgent,
  selectedId,
  onSelect,
  onRetry
}: {
  agents: AgentSummary[] | null;
  resolved: boolean;
  timedOut: boolean;
  failed: boolean;
  liveCountByAgent: Record<string, number>;
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

  return (
    <nav className="os-agent-rail" aria-label="Agents" ref={navRef}>
      {AGENTS_ORDER.map((id) => {
        const agent = agents ? agents.find((a) => a.id === id) : undefined;
        const { mark, word } = agentStatusWord(agent?.detected.installed, resolved, timedOut, failed, liveCountByAgent[id] || 0);
        const selected = id === selectedId;
        return (
          <button
            key={id}
            type="button"
            className={`os-agent-rail__item${selected ? " os-agent-rail__item--selected" : ""}`}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(id)}
          >
            <span className="os-agent-rail__accent" aria-hidden="true" />
            <span className="os-agent-rail__mono os-mono">{AGENT_MONOGRAM[id]}</span>
            <span className="os-agent-rail__text">
              <strong>{agent?.label || AGENT_LABEL[id]}</strong>
              <span className="os-agent-rail__role">{AGENT_ROLE[id]}</span>
            </span>
            <span className="os-agent-rail__status">
              <StatusMark kind={mark} label={word} />
            </span>
          </button>
        );
      })}
      {timedOut || (failed && !resolved) ? (
        <button type="button" className="os-btn os-btn--ghost os-agent-rail__retry" onClick={onRetry}>
          <RefreshCw size={12} /> Retry
        </button>
      ) : null}
    </nav>
  );
}
