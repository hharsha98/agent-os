import { useRef } from "react";
import type { KeyboardEvent } from "react";

// A row of tabs that switch a panel (WAI-ARIA tabs pattern, automatic
// activation). Arrow Left/Right move and select (wrapping round), Home and End
// jump to the first and last. Only the selected tab is a Tab-key stop; the Tab
// key then goes on into the panel. The page renders the panel itself:
//   <div {...tabPanelProps("runs", value)}>...</div>
// which gives it role="tabpanel", the id this tab points at with aria-controls,
// and aria-labelledby back to the tab.
export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  label: string;
  idPrefix: string;
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
}

export const tabDomId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
export const panelDomId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

export function tabPanelProps(idPrefix: string, id: string) {
  return { role: "tabpanel" as const, id: panelDomId(idPrefix, id), "aria-labelledby": tabDomId(idPrefix, id) };
}

export default function Tabs({ label, idPrefix, tabs, value, onChange }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);
  const hasValue = tabs.some((tab) => tab.id === value);
  // If `value` matches no tab, the first tab is still reachable with the Tab key.
  const tabStop = hasValue ? value : tabs[0]?.id;

  function select(index: number) {
    if (tabs.length === 0) return;
    const next = (index + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    // Leave Alt/Ctrl/Cmd + arrow to the browser (history, text jumps).
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight") select(index + 1);
    else if (event.key === "ArrowLeft") select(index - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(tabs.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <div ref={list} className="os-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={tabDomId(idPrefix, tab.id)}
          className="os-tab"
          aria-selected={hasValue && tab.id === value}
          aria-controls={panelDomId(idPrefix, tab.id)}
          tabIndex={tab.id === tabStop ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {tab.label}
          {typeof tab.count === "number" ? <span className="os-tab__count os-mono">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
