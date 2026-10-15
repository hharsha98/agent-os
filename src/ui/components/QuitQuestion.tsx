// The quit question (desktop app only; spec "Quitting Agent OS", planning decision Q6). Instead of quitting
// at once, the Rust shell tells this window "agentos://quit-requested". The window asks Agent OS which
// sessions are running (both kinds) and either answers "quit" straight away, when nothing would be lost, or
// shows this question, tells the shell "agentos://quit-shown", and then sends the person's answer as
// "agentos://quit-answer" { quit }. If no window says quit-shown within 2 s, the shell quits on its own.
// The Tauri event module is imported lazily, so a browser tab never loads it.
import { useCallback, useEffect, useState } from "react";
import { quitCheckOrNone } from "../../sessionsApi";
import { isDesktopApp } from "../desktop";
import { createQuitRounds, QUIT_ANSWER_EVENT, QUIT_REQUESTED_EVENT, QUIT_SHOWN_EVENT, quitQuestionCopy, runQuitFlow } from "../sessionsShared";
import type { QuitView } from "../sessionsShared";
import AgentConfirmModal from "./AgentConfirmModal";

async function tellShell(event: string, payload?: unknown): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event, payload);
  } catch {
    // Not inside the desktop shell after all (a browser tab with ?desktop=1): there is nobody to tell.
  }
}

export interface DesktopQuit {
  view: QuitView | null;
  keepRunning: () => void;
  quit: () => void;
}

export function useDesktopQuit(): DesktopQuit {
  const [view, setView] = useState<QuitView | null>(null);
  // One round per request from the shell: open from the request until an answer is sent (a second request in
  // between changes nothing), and a check that arrives late for an answered round can neither draw nor answer
  // the next question (createQuitRounds).
  const [rounds] = useState(createQuitRounds);

  const answer = useCallback(
    (quit: boolean) => {
      rounds.end();
      setView(null);
      void tellShell(QUIT_ANSWER_EVENT, { quit });
    },
    [rounds]
  );

  useEffect(() => {
    if (!isDesktopApp()) return undefined;
    let unlisten: (() => void) | null = null;
    let gone = false;
    function onQuitRequested() {
      const round = rounds.begin();
      if (round === null) return;
      void runQuitFlow(
        rounds.guard(round, {
          // Where sessions do not exist (404 not_available) nothing runs: that is "none", not "couldn't check".
          check: () => quitCheckOrNone(),
          show: setView,
          shown: () => void tellShell(QUIT_SHOWN_EVENT),
          answer
        })
      );
    }
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen(QUIT_REQUESTED_EVENT, onQuitRequested))
      .then((stop) => {
        if (gone) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Not inside the desktop shell after all: nothing will ask.
      });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [answer, rounds]);

  return { view, keepRunning: () => answer(false), quit: () => answer(true) };
}

// `quitLabel` names the button that ends the sessions: "Quit" by default, "Install & restart" from the update
// banner (its restart quits Agent OS too, and the shell cannot ask on that path; see UpdateBanner.tsx).
export default function QuitQuestion({
  view,
  onKeepRunning,
  onQuit,
  quitLabel
}: {
  view: QuitView;
  onKeepRunning: () => void;
  onQuit: () => void;
  quitLabel?: string;
}) {
  const copy = quitQuestionCopy(view);
  // Focus starts on Keep running (the first button), so Enter never quits by accident; Escape keeps running.
  return (
    <AgentConfirmModal
      title={copy.title}
      cancelLabel={copy.keep}
      confirmLabel={quitLabel ?? copy.quit}
      onConfirm={onQuit}
      onClose={onKeepRunning}
      danger
      closeOnBackdrop={false}
    >
      <p aria-live="polite">{copy.body}</p>
    </AgentConfirmModal>
  );
}
