// A small "Connect OpenRouter" control for the model picker's Apply step (the
// Setup card has its own, bigger one). It runs the same one-click sign-in:
// the server opens the person's browser and keeps the key in memory; this only
// ever holds a flow id and a status, never the key. The parent owns the flow
// id, so it can use the connection and forget it afterwards.
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import RelativeTime from "./RelativeTime";
import RememberKeyTick from "./RememberKeyTick";
import StatusMark from "./StatusMark";
import { useInterval } from "./useInterval";
import OpenAddress from "./OpenAddress";
import type { OpenRouterConnectState } from "../../setupApi";
import { cancelOpenRouterConnect, friendlyError, getOpenRouterConnect, startOpenRouterConnect } from "../../setupApi";

const POLL_MS = 1500;
// OpenRouter's one-time codes expire after 10 minutes, so waiting longer can never succeed.
const WAIT_LIMIT_MS = 10 * 60 * 1000;

type Phase = "idle" | "starting" | "waiting" | "connected" | "failed";

export default function OpenRouterConnectInline({
  flowId,
  onFlowChange,
  disabled = false,
  rememberTick = false
}: {
  flowId: string | null;
  onFlowChange: (flowId: string | null) => void;
  disabled?: boolean;
  // Offer "Remember for coding agents" (off by default) once connected.
  rememberTick?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(flowId ? "connected" : "idle");
  const [message, setMessage] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [opened, setOpened] = useState(true);
  const [startedAt, setStartedAt] = useState(0);
  const [copied, setCopied] = useState(false);
  // The id of the sign-in being waited for. A ref, so a slow answer from an
  // OLD sign-in can never overwrite a newer one.
  const waitingRef = useRef<string | null>(null);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  // The parent used the connection up (or dropped it): back to the button.
  useEffect(() => {
    if (flowId === null && phaseRef.current === "connected") setPhase("idle");
  }, [flowId]);

  // Leaving while a sign-in is still waiting frees its slot on the server.
  useEffect(() => {
    return () => {
      if (waitingRef.current && phaseRef.current === "waiting") void cancelOpenRouterConnect(waitingRef.current).catch(() => undefined);
    };
  }, []);

  async function connect() {
    setPhase("starting");
    setMessage("");
    try {
      const started = await startOpenRouterConnect();
      waitingRef.current = started.flowId;
      setAuthUrl(started.authUrl);
      setOpened(started.opened);
      setStartedAt(Date.now());
      setPhase("waiting");
    } catch (error) {
      waitingRef.current = null;
      setMessage(friendlyError(error, "Couldn't start the sign-in. Please try again."));
      setPhase("failed");
    }
  }

  function apply(id: string, state: OpenRouterConnectState) {
    if (state.status === "waiting") return;
    waitingRef.current = null;
    if (state.status === "connected") {
      setPhase("connected");
      onFlowChange(id);
      return;
    }
    setMessage(state.error || "The sign-in didn't finish. Try again.");
    setPhase("failed");
  }

  useInterval(
    async () => {
      const id = waitingRef.current;
      if (!id) return;
      if (Date.now() - startedAt > WAIT_LIMIT_MS) {
        waitingRef.current = null;
        setMessage("Timed out after 10 minutes without an answer from OpenRouter. Try again.");
        setPhase("failed");
        void cancelOpenRouterConnect(id).catch(() => undefined);
        return;
      }
      try {
        const state = await getOpenRouterConnect(id);
        if (waitingRef.current === id) apply(id, state);
      } catch (error) {
        // The server forgot the sign-in (or restarted): it is over. Any other error is a blip.
        if (waitingRef.current === id && error instanceof Error && /not found/i.test(error.message)) {
          waitingRef.current = null;
          setMessage("That sign-in expired. Try again.");
          setPhase("failed");
        }
      }
    },
    phase === "waiting" ? POLL_MS : null
  );

  async function stopWaiting() {
    const id = waitingRef.current;
    waitingRef.current = null;
    setMessage("You stopped the sign-in. Nothing was connected.");
    setPhase("failed");
    if (id) await cancelOpenRouterConnect(id).catch(() => undefined);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied; the visible link still works.
    }
  }

  if (phase === "connected") {
    return (
      <>
        <p className="os-mp-connect__ok" role="status">
          <StatusMark kind="ok" label="connected" /> OpenRouter connected ✓
        </p>
        {rememberTick ? <RememberKeyTick flowId={flowId} /> : null}
      </>
    );
  }

  if (phase === "waiting") {
    return (
      <div className="os-mp-connect">
        <p className="os-mp-connect__waiting" role="status">
          <StatusMark kind="live" />
          <span>
            Waiting for you to press Authorize in your browser · <RelativeTime since={startedAt} live /> elapsed
          </span>
        </p>
        <p className="os-mp-hint">
          {opened ? "Your browser should have opened OpenRouter's sign-in page." : "We couldn't open your browser by ourselves."}{" "}
          <OpenAddress href={authUrl} copyLabel="Copy the sign-in page address">
            Didn&apos;t open? Open the sign-in page <ExternalLink size={12} aria-hidden="true" />
          </OpenAddress>
        </p>
        <div className="os-mp-row-actions">
          <button type="button" className="os-btn os-btn--ghost" onClick={() => void stopWaiting()}>
            Cancel
          </button>
          {/* Some app windows don't open links themselves; copying always works. */}
          <button type="button" className="os-mp-link" onClick={() => void copyLink()}>
            {copied ? "Link copied" : "Copy the sign-in link"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="os-mp-connect">
      {phase === "failed" ? (
        <p className="os-mp-error" role="alert">
          <StatusMark kind="error" /> {message}
        </p>
      ) : null}
      <div className="os-mp-row-actions">
        <button type="button" className="os-btn os-btn--primary" onClick={() => void connect()} disabled={disabled || phase === "starting"}>
          {phase === "starting" ? "Opening your browser…" : phase === "failed" ? "Try again: Connect OpenRouter" : "Connect OpenRouter"}
        </button>
      </div>
    </div>
  );
}
