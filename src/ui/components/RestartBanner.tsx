// One open session that still runs on an older version than the one installed (SP5, Restart session), drawn in the Agents
// page's Version block under the update (AgentUpdatePanel). An update never stops a session, so this is how the person hears
// about it and does it when they want: "Restart session" asks first (the panel's confirm), then stops the session and resumes
// it in the same tab. When the session could not be resumed, restarting would lose the conversation: the banner says so with
// the resume rule's own reason and has no button. When the server said nothing about it (an older server, the live-only list),
// there is no button and no sentence: nothing is offered on a guess. A restart that was refused shows the server's sentence
// inside the banner, which keeps its button to try again.
import { useId } from "react";
import type { SessionSummary } from "../../types";
import { sessionTitle } from "../sessionsShared";
import { RESTART_LABEL, restartTitle, restartUnavailableLine } from "../updatesShared";
import Banner from "./Banner";
import { TimeAgo } from "./RelativeTime";

export default function RestartBanner({
  session,
  newVersion,
  failure,
  busy,
  onRestart
}: {
  session: SessionSummary;
  // The installed version's number: the one the session would start again on.
  newVersion: string;
  // The sentence of a restart of this session that did not work, or "".
  failure: string;
  // A restart (of this or another session) is running: its button is off.
  busy: boolean;
  onRestart: () => void;
}) {
  const lineId = useId();
  const buttonId = useId();
  // The server says whether the session could be brought back (stop, then resume): the button only when it said yes, the
  // unavailable sentence only when it said no.
  const canRestart = session.restart?.available === true;
  const cannotRestart = session.restart?.available === false;
  return (
    <Banner
      tone="info"
      title={restartTitle(newVersion)}
      actions={
        canRestart ? (
          // Several banners can stand together, and two sessions can read alike (OpenClaw's folders are not shown), so the
          // button's name is its own words and then its session's line below the title, with when it started.
          <button
            id={buttonId}
            type="button"
            className="os-btn os-btn--secondary"
            disabled={busy}
            aria-labelledby={`${buttonId} ${lineId}`}
            onClick={onRestart}
          >
            {RESTART_LABEL}
          </button>
        ) : undefined
      }
    >
      <p id={lineId}>
        {sessionTitle(session)} · Started <TimeAgo since={session.startedAt} />
      </p>
      {cannotRestart ? <p>{restartUnavailableLine(session.restart?.reason)}</p> : null}
      {failure ? (
        <p className="os-launch__error" role="alert">
          {failure}
        </p>
      ) : null}
    </Banner>
  );
}
