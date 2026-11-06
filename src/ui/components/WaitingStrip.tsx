// The "Waiting for you" strip above Home's heading (the prototype's index.html strip): one row for each agent session
// that waits for you, the longest wait first, then each one whose plan ran out, at most STRIP_MAX rows, each with Open
// session. It reads the shared sessions list, so it agrees with the tab markers, the top-bar badge and the Orbit (ruling
// R22). Nothing shows while nothing needs you, or while the list could not be refreshed (Home's own banner says so then).
import { ArrowRight, CircleHelp, CirclePause } from "lucide-react";
import { navigateTo } from "../../nav";
import { STRIP_MAX, homeStripItems, stripMore } from "../alertsShared";
import { useSessionsList } from "../useSessionsList";
import "../alerts.css";

export default function WaitingStrip() {
  const { source } = useSessionsList();
  const items = homeStripItems(source.state === "ok" && !source.stale ? source.data.sessions : []);
  if (items.length === 0) return null;
  const shown = items.slice(0, STRIP_MAX);
  const more = stripMore(items.length - shown.length);
  return (
    <section className="os-strip" aria-label="Waiting for you">
      {shown.map((item) => (
        <div key={item.id} className={`os-strip__row os-strip__row--${item.kind}`} role="group" aria-label={item.title}>
          {item.kind === "waiting" ? <CircleHelp size={20} aria-hidden="true" /> : <CirclePause size={20} aria-hidden="true" />}
          <p className="os-strip__text">
            <b className="os-trunc">{item.title}</b>
            <span className="os-strip__sep" aria-hidden="true">
              ·
            </span>
            <span className="os-strip__what">{item.text}</span>
            {item.kind === "waiting" ? (
              <>
                <span className="os-strip__sep" aria-hidden="true">
                  ·
                </span>
                <span className="os-strip__quiet">Agent OS never answers for you.</span>
              </>
            ) : null}
          </p>
          <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("sessions", { session: item.id })}>
            Open session
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      {more ? <p className="os-strip__more">{more}</p> : null}
    </section>
  );
}
