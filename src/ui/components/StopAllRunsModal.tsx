// "Stop all runs" from the ⌘K palette. It is the keyboard way to do what "Hold to stop all" does, so it
// follows the same rule (ruling R14): agent work only, never the Hermes or OpenClaw background service
// and never Agent OS's own setup jobs, and the same time limits (src/ui/stopAllShared.ts). It looks at
// what is really running first, says what it would stop, and only stops once the person confirms.
import { useEffect, useRef, useState } from "react";
import type { StopAllResult, StopLook } from "../stopAll";
import { lookForWhatToStop, stopAllMessage, stopWhatWasLookedAt, thingsWord } from "../stopAll";
import AgentConfirmModal from "./AgentConfirmModal";

const SHOWN_TITLES = 5;

export default function StopAllRunsModal({
  onClose,
  onDone
}: {
  onClose: () => void;
  // Called with the result when everything was stopped, so the window can say so (the same toast as the hold).
  onDone?: (result: StopAllResult) => void;
}) {
  // null = still looking.
  const [look, setLook] = useState<StopLook | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  async function lookAgain() {
    const next = await lookForWhatToStop();
    if (alive.current) setLook(next);
    return next;
  }

  useEffect(() => {
    alive.current = true;
    void lookAgain();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runs = look?.runs ?? [];
  const rooms = look?.rooms ?? [];
  const count = runs.length + rooms.length;

  async function confirm() {
    if (!look || count === 0) return;
    setBusy(true);
    setNotice("");
    const result = await stopWhatWasLookedAt(look);
    if (!alive.current) return;
    setBusy(false);
    const clean = result.failed + result.timedOut + result.roomsFailed + result.roomsTimedOut === 0;
    if (clean) {
      if (onDone) onDone(result);
      onClose();
      return;
    }
    // Some did not stop, or did not answer in time. Say which, and look again at what is still going.
    setNotice(stopAllMessage(result).message);
    await lookAgain();
  }

  const unreadAll = look !== null && !look.runsChecked && !look.roomsChecked;
  const unreadRuns = look !== null && !look.runsChecked && look.roomsChecked;
  const unreadRooms = look !== null && look.runsChecked && !look.roomsChecked;
  const titles = [
    ...rooms.map((room) => ({ key: room.id, text: `Team Room: ${room.task || room.id}` })),
    ...runs.map((run) => ({ key: run.id, text: run.title || run.id }))
  ];

  return (
    <AgentConfirmModal
      title="Stop all runs?"
      confirmLabel={count > 0 ? `Stop ${thingsWord(runs.length, rooms.length)}` : "Stop all runs"}
      confirmDisabled={look === null || count === 0}
      busy={busy}
      danger
      onConfirm={() => void confirm()}
      onClose={() => (busy ? null : onClose())}
    >
      {look === null ? <p role="status">Looking at what is running…</p> : null}
      {unreadAll ? (
        <p className="os-launch__error" role="alert">
          Couldn&apos;t read what is running. Agent OS did not answer in time. Close this and try again, or stop each run on Runs.
        </p>
      ) : null}
      {unreadRuns ? (
        <p className="os-launch__error" role="alert">
          Couldn&apos;t read the list of runs, so only Team Rooms are listed. Check Runs.
        </p>
      ) : null}
      {unreadRooms ? (
        <p className="os-launch__error" role="alert">
          Couldn&apos;t read the list of Team Rooms, so a room that is between two turns is not listed and may still carry on. Check Team Room.
        </p>
      ) : null}
      {look && count === 0 && !unreadAll && !notice ? (
        <p>
          {look.skipped > 0
            ? "No agent work is running right now."
            : look.listTruncated
              ? "None of the newest runs are running."
              : "Nothing is running right now."}
        </p>
      ) : null}
      {look && count > 0 ? (
        <>
          <p>
            This stops {thingsWord(runs.length, rooms.length)} that {count === 1 ? "is" : "are"} running now. Anything an agent already did stays done.
          </p>
          <ul>
            {titles.slice(0, SHOWN_TITLES).map((item) => (
              <li key={item.key}>{item.text}</li>
            ))}
            {count > SHOWN_TITLES ? <li>and {count - SHOWN_TITLES} more</li> : null}
          </ul>
        </>
      ) : null}
      {look && look.skipped > 0 ? (
        <p>
          {look.skipped === 1
            ? "1 setup or service job is left running. It is not agent work; manage it in Setup or Agents."
            : `${look.skipped} setup or service jobs are left running. They are not agent work; manage them in Setup or Agents.`}
        </p>
      ) : null}
      {look && look.listTruncated ? <p>The list was full, so older runs were not checked.</p> : null}
      {notice ? (
        <p className="os-launch__error" role="alert">
          {notice}
        </p>
      ) : null}
    </AgentConfirmModal>
  );
}
