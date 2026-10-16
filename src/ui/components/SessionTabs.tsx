// The Sessions page's tab strip (the prototype's .ss-tabs): one tab per session, a terminal icon and the session's
// title. An ended tab reads "<title> · Ended · open recording" and has a Dismiss control (×) beside it; an open tab
// has no close control, because a session ends with Stop (spec, App shortcuts). WAI-ARIA tabs with automatic
// activation: Left/Right/Home/End move and select, and Delete on an ended tab dismisses it. The × is for the mouse
// only: a tab list may hold only tabs (aria-required-children), so the × is hidden from assistive technology and
// out of the Tab order, and the keyboard way is Delete, which an ended tab says as its description. The kit's Tabs
// has no marker or close slot, so this strip is its own component in the same look.
import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { CircleHelp, CirclePause, SquareTerminal, X } from "lucide-react";
import { DISMISS_KEY_HINT, dismissLabel, tabLabel, tabMarker } from "../sessionsPageShared";

export interface SessionTabItem {
  id: string;
  title: string;
  status: string;
}

export const sessionTabDomId = (id: string) => `os-sess-tab-${id}`;
const dismissHintDomId = (id: string) => `os-sess-tab-hint-${id}`;

export default function SessionTabs({
  tabs,
  selectedId,
  panelId,
  onSelect,
  onDismiss
}: {
  tabs: SessionTabItem[];
  selectedId: string;
  panelId: string;
  onSelect: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // The selected tab is always in view, also when ⌘1-9 picked one that was scrolled out of sight.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    // Leave Alt/Ctrl/Cmd + a key to the app shortcuts and the browser.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Delete" && tabs[index].status === "exited") {
      event.preventDefault();
      onDismiss(tabs[index].id);
      return;
    }
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    document.getElementById(sessionTabDomId(tabs[next].id))?.focus();
  }

  return (
    <div ref={listRef} className="os-sess-tabs" role="tablist" aria-label="Sessions">
      {tabs.map((tab, index) => {
        const selected = tab.id === selectedId;
        const ended = tab.status === "exited";
        const label = tabLabel(tab.title, tab.status);
        const marker = tabMarker(tab.status);
        return (
          <div key={tab.id} className={`os-sess-tab${selected ? " is-selected" : ""}${ended ? " is-ended" : ""}`} role="presentation">
            <button
              type="button"
              role="tab"
              id={sessionTabDomId(tab.id)}
              className="os-sess-tab__btn"
              aria-selected={selected}
              aria-controls={panelId}
              aria-describedby={ended ? dismissHintDomId(tab.id) : undefined}
              tabIndex={selected ? 0 : -1}
              title={label}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <SquareTerminal size={16} aria-hidden="true" />
              <span className="os-sess-tab__label">{label}</span>
              {marker ? (
                <span className="os-sess-tab__mark">
                  {marker.kind === "waiting" ? <CircleHelp size={15} aria-hidden="true" /> : <CirclePause size={15} aria-hidden="true" />}
                  {marker.word}
                </span>
              ) : null}
            </button>
            {ended ? (
              <>
                {/* Hidden text that only names the tab's keyboard way (aria-describedby may point at hidden text). */}
                <span id={dismissHintDomId(tab.id)} hidden>
                  {DISMISS_KEY_HINT}
                </span>
                <button
                  type="button"
                  className="os-sess-tab__dismiss"
                  aria-label={dismissLabel(tab.title)}
                  aria-hidden="true"
                  title="Dismiss"
                  tabIndex={-1}
                  onClick={() => onDismiss(tab.id)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
