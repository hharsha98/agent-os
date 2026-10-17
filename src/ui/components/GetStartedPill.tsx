// The small "Get started 3/4" pill in the shell header. It shows the same real
// count as the card on Home and brings the card back (and focuses it) when it
// was put away with "Hide for now". Gone once everything is done and hidden.
import { ListChecks } from "lucide-react";
import { revealGetStarted } from "../onboardingShared";
import { useOnboarding } from "./useOnboarding";

export default function GetStartedPill() {
  const { enabled, data, setHidden } = useOnboarding();
  if (!enabled || !data || (data.complete && data.hidden)) return null;

  const { counts } = data;
  const spoken = data.complete
    ? "Setup is done. Show the checklist."
    : `Get started: ${counts.done} of ${counts.total} done. ${data.hidden ? "Show" : "Go to"} the checklist.`;

  return (
    <button
      type="button"
      className="os-btn os-btn--secondary os-gs-pill"
      onClick={() => void revealGetStarted(setHidden, data.hidden)}
      aria-label={spoken}
      title={data.hidden ? "Show the Get started checklist" : "Go to the Get started checklist"}
    >
      <ListChecks size={14} aria-hidden="true" />
      {/* The words are the UI font; only the count is data, so only the count is mono. */}
      {data.complete ? (
        <span>Setup done</span>
      ) : (
        <span>
          Get started <span className="os-mono">{counts.done}/{counts.total}</span>
        </span>
      )}
    </button>
  );
}
