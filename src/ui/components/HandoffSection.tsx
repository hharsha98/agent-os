// The side panel's Hand-off section (spec "SP4 Session extras", Hand-off; Task X8). A Claude Code session offers "Send
// to Codex for review" and a Codex session "Send to Claude Code". The server types a note listing this session's
// changed files into a session of the other agent in the same folder (or the same separate copy), opening one there
// first when none can take it, and never presses Enter; the caption under the button says so. The page then shows
// that session with its terminal focused, so the person reads the note and presses Enter themselves. When nothing
// could take the text, it is shown here with a Copy button and the server's reason (HandoffCopyFallback). A session
// that text was handed to shows how that went: "…" while Agent OS waits for the agent, the caption and the typed text
// once it is in the agent's input line (Claude Code shows a long paste as a placeholder, so the text is here to read),
// or the text to copy when the agent never got ready (an ended session, a new one that ended first, keeps that copy).
// The Send button is the first thing in the section and says "…" while it waits, and the caption is shown once: the
// typed text follows it. The side panel bounds the Files changed list above, so Send stays on screen (sessions.css).
import { useEffect, useId, useRef, useState } from "react";
import { Send } from "lucide-react";
import { sendTo, sessionProblem } from "../../sessionsApi";
import type { SessionSummary } from "../../types";
import { HANDOFF_CAPTION, HANDOFF_TITLE, handoffStatus, sendOutcome, sendTargets } from "../handoffShared";
import type { SendTarget } from "../handoffShared";
import { canHandOver } from "../keepGoingShared";
import HandoffCopyFallback, { HandoffText } from "./HandoffCopyFallback";
import HandOverButton from "./HandOverButton";

export default function HandoffSection({ session, onOpenSession }: { session: SessionSummary; onOpenSession: (id: string) => void }) {
  const id = useId();
  const targets = sendTargets(session);
  const status = handoffStatus(session);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [copy, setCopy] = useState<{ text: string; reason: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function send(target: SendTarget) {
    setBusy(true);
    setProblem("");
    setCopy(null);
    try {
      const outcome = sendOutcome(await sendTo(session.id, target.to), target);
      if (!alive.current) return;
      if ("open" in outcome) onOpenSession(outcome.open);
      else if ("copy" in outcome) setCopy(outcome.copy);
      else setProblem(outcome.problem);
    } catch (error) {
      if (alive.current) setProblem(sessionProblem(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  // A running Cursor session has no send target, but it gets this section for "Hand to Claude Code or Codex" (Task X10).
  if (!targets.length && !status && !canHandOver(session)) return null;
  return (
    <section className="os-sess-panel__sec os-handoff" aria-label={HANDOFF_TITLE}>
      <div className="os-sess-panel__rh">{HANDOFF_TITLE}</div>
      {/* The Send button comes first, so it stays on screen whatever is listed above or handed to this session below. */}
      {targets.map((target) => (
        <button
          key={target.to}
          type="button"
          className="os-btn os-btn--secondary os-handoff__send"
          onClick={() => void send(target)}
          disabled={busy}
          aria-busy={busy}
          aria-describedby={`${id}-cap`}
        >
          <Send size={16} aria-hidden="true" />
          {busy ? `${target.label}…` : target.label}
        </button>
      ))}
      {targets.length ? (
        <p id={`${id}-cap`} className="os-handoff__cap">
          {HANDOFF_CAPTION}
        </p>
      ) : null}
      <HandOverButton session={session} />
      {status?.kind === "pending" ? (
        <p className="os-handoff__status" role="status" aria-busy="true">
          …
        </p>
      ) : null}
      {/* A live region that is in the page from the start, empty: when the typed text lands, its box is added here and read
          out once (a region that mounts with its words in it is often not read). No words are repeated for that: the
          caption stays the only line, and names the box (sweep A item 9). */}
      <div className="os-handoff__typed" role="status">
        {status?.kind === "typed" ? (
          targets.length ? (
            // The caption above already says it, so it is shown once: the typed text follows it, named by it.
            <HandoffText text={status.text} labelId={`${id}-cap`} />
          ) : (
            <>
              <p id={`${id}-typed`} className="os-handoff__status">
                {HANDOFF_CAPTION}
              </p>
              <HandoffText text={status.text} labelId={`${id}-typed`} />
            </>
          )
        ) : null}
      </div>
      {status?.kind === "copy" ? <HandoffCopyFallback text={status.text} reason={status.reason} /> : null}
      {problem ? (
        <p className="os-sess-panel__note" role="alert">
          {problem}
        </p>
      ) : null}
      {copy ? <HandoffCopyFallback text={copy.text} reason={copy.reason} /> : null}
    </section>
  );
}
