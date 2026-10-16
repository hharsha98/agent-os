// "Choose in Hermes" on Hermes's Brain card (spec 2026-10-15 section 4). Agent OS adds nothing of its own for
// Hermes's brain: this opens Hermes's own model picker (`hermes model`) in its own Terminal.app window (the server
// writes a one-line .command file and opens it with Terminal), or, on Windows and Linux, hands back the command to
// run. Nothing typed or shown there passes through Agent OS. Agent OS can't see that window close, so the card reads
// again when the person presses Refresh (onRefresh: the whole Brain card, so its status and summary follow the new
// model) and, model only, whenever this window gets focus (onWindowFocus, at most every 2 s: focus events come in
// bursts and the brain read is slow). The two quiet lines say, before anything opens, which of Hermes's own choices
// Anthropic and OpenAI don't allow for apps like Hermes.
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TerminalLaunch } from "../../setupApi";
import { friendlyError, openHermesModelTerminal } from "../../setupApi";
import { withTimeout } from "../homeShared";
import {
  HERMES_FOCUS_GAP_MS,
  HERMES_PICKER_LINES,
  PLAN_LIMITS_MS,
  UNREADABLE_WORDS,
  hermesLaunchWords,
  planProblem
} from "../planBrainsShared";
import SetupCommand from "./SetupCommand";
import StatusMark from "./StatusMark";

export default function ChooseInHermes({ onRefresh, onWindowFocus }: { onRefresh(): void; onWindowFocus(): void }) {
  const [launch, setLaunch] = useState<TerminalLaunch | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const alive = useRef(true);
  const lastRead = useRef(0);
  const latest = useRef(onRefresh);
  latest.current = onRefresh;
  const latestFocus = useRef(onWindowFocus);
  latestFocus.current = onWindowFocus;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    function onFocus() {
      const now = Date.now();
      if (now - lastRead.current < HERMES_FOCUS_GAP_MS) return;
      lastRead.current = now;
      latestFocus.current();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  async function choose() {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      const answer = await withTimeout(openHermesModelTerminal(), PLAN_LIMITS_MS.action);
      if (!alive.current) return;
      if (!answer || typeof answer.opened !== "boolean" || typeof answer.command !== "string") throw new Error(UNREADABLE_WORDS);
      setLaunch(answer);
    } catch (error) {
      if (alive.current) setProblem(planProblem(error, friendlyError));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function refresh() {
    lastRead.current = Date.now();
    latest.current();
  }

  return (
    <div className="os-hermes-pick">
      <div className="os-hermes-pick__lines">
        {HERMES_PICKER_LINES.map((line) => (
          <p key={line} className="os-hermes-pick__line">
            {line}
          </p>
        ))}
      </div>
      <div className="os-plan-card__row">
        <button type="button" className="os-btn os-btn--secondary" onClick={() => void choose()} disabled={busy}>
          Choose in Hermes
        </button>
        {launch ? (
          <button type="button" className="os-btn os-btn--ghost" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        ) : null}
      </div>
      {launch ? (
        <p className="os-hermes-pick__result" role="status">
          {hermesLaunchWords(launch)}
        </p>
      ) : null}
      {launch && !launch.opened ? <SetupCommand command={launch.command} label="Copy the command" /> : null}
      {problem ? (
        <p className="os-plan-card__error" role="alert">
          <StatusMark kind="error" /> {problem}
        </p>
      ) : null}
    </div>
  );
}
