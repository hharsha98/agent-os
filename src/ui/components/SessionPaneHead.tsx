// One pane's header in split view (the prototype's .ss-phd; spec SP4, Split): the session's title, its branch and its
// state as icon and word. It is a button: pressing it, or clicking anywhere in the pane, makes this the focused pane,
// and the side panel shows its details. aria-pressed says which pane the panel follows. Enter or Space (the keyboard
// way in, since an open terminal keeps Tab for its agent) also hands the keyboard to this pane's terminal (`onEnter`).
import { SquareTerminal } from "lucide-react";
import type { SessionSummary } from "../../types";
import { sessionStateWord, sessionTitle } from "../sessionsShared";
import { paneHeadLabel } from "../splitShared";
import StatusWord from "./StatusWord";

export default function SessionPaneHead({
  session,
  focused,
  onPick,
  onEnter
}: {
  session: SessionSummary;
  focused: boolean;
  onPick: () => void;
  onEnter?: () => void;
}) {
  const title = sessionTitle(session);
  const word = sessionStateWord(session);
  return (
    <button
      type="button"
      className="os-sess-pane__head"
      aria-pressed={focused}
      aria-label={paneHeadLabel(title)}
      title={title}
      onClick={onPick}
      onKeyDown={(event) => {
        if (!onEnter || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "Enter" || event.key === " ") {
          // No click follows: a mouse click only shows the details, the keys also give the keyboard to the terminal.
          event.preventDefault();
          onEnter();
        }
      }}
      onKeyUp={(event) => {
        if (onEnter && event.key === " ") event.preventDefault();
      }}
    >
      <SquareTerminal size={16} aria-hidden="true" />
      <span className="os-sess-pane__title">{title}</span>
      {session.branch ? <code className="os-mono os-sess-pane__branch">{session.branch}</code> : null}
      <span className="os-sess-pane__state">
        <StatusWord state={word.state} label={word.label} />
      </span>
    </button>
  );
}
