// "Remove separate copy" (spec SP4, Worktree offer: "Removing a worktree asks first and refuses when there are
// uncommitted changes"). Shown on an ended session's panel when the session ran in a separate copy that is still
// there. It asks first; the server refuses while any session still runs in the copy and while the copy has changes
// that aren't committed, and its sentence shows in the dialog. The copy's branch always stays. After a removal the
// button is gone, so the focus goes to `focusAfter` (the panel's heading).
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Trash2 } from "lucide-react";
import { removeWorktree, sessionProblem } from "../../sessionsApi";
import type { SessionSummary } from "../../types";
import { REMOVE_COPY_LABEL, removeCopyConfirm } from "../sessionsPageShared";
import { useSessionsList } from "../useSessionsList";
import AgentConfirmModal from "./AgentConfirmModal";

export default function RemoveCopyButton({ session, focusAfter }: { session: SessionSummary; focusAfter?: RefObject<HTMLElement> }) {
  const { refresh } = useSessionsList();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  const removed = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const words = removeCopyConfirm(session);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await removeWorktree(session.id);
      if (!alive.current) return;
      removed.current = true;
      setOpen(false);
      refresh();
      window.requestAnimationFrame(() => focusAfter?.current?.focus());
    } catch (error) {
      if (!alive.current) return;
      setProblem(sessionProblem(error));
      refresh();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="os-btn os-btn--secondary"
        onClick={() => {
          setProblem(null);
          setOpen(true);
        }}
      >
        <Trash2 size={16} aria-hidden="true" />
        {REMOVE_COPY_LABEL}
      </button>
      {open ? (
        <AgentConfirmModal
          title={words.title}
          confirmLabel={REMOVE_COPY_LABEL}
          danger
          busy={busy}
          giveFocusBack={() => !removed.current}
          onConfirm={() => void remove()}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          {words.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {problem ? (
            <p className="os-sess__error" role="alert">
              {problem}
            </p>
          ) : null}
        </AgentConfirmModal>
      ) : null}
    </>
  );
}
