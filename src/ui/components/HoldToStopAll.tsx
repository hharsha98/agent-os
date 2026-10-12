import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { OctagonX } from "lucide-react";
import { stopEverything } from "../stopAll";
import type { StopAllResult } from "../stopAll";

const HOLD_MS = 1200;

export default function HoldToStopAll({ onResult }: { onResult: (result: StopAllResult) => void }) {
  const [holding, setHolding] = useState(false);
  const [stopping, setStopping] = useState(false);
  const timer = useRef<number | null>(null);
  const keyDown = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  function cancel() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    keyDown.current = false;
    setHolding(false);
  }

  function begin() {
    if (stopping || timer.current !== null) return;
    setHolding(true);
    timer.current = window.setTimeout(async () => {
      const viaKeyboard = keyDown.current;
      timer.current = null;
      setHolding(false);
      setStopping(true);
      try {
        onResult(await stopEverything());
      } finally {
        restoreFocus.current = viaKeyboard;
        setStopping(false);
      }
    }, HOLD_MS);
  }

  // The button is disabled while stopping, which drops keyboard focus to the
  // page. After a keyboard hold, put focus back so the person keeps their place.
  useEffect(() => {
    if (!stopping && restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [stopping]);

  // Switching windows mid-hold must not leave a hold running.
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat || keyDown.current) return;
    keyDown.current = true;
    begin();
  }

  function onKeyUp(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    cancel();
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`os-holdstop${holding ? " is-holding" : ""}`}
      disabled={stopping}
      aria-describedby="os-holdstop-hint"
      onPointerDown={(event) => {
        if (event.button === 0) begin();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onBlur={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onClick={(event) => event.preventDefault()}
    >
      <span className="os-holdstop__fill" aria-hidden="true" />
      <OctagonX size={15} aria-hidden="true" />
      <span className="os-holdstop__label">{stopping ? "Stopping…" : holding ? "Keep holding…" : "Hold to stop all"}</span>
      <span id="os-holdstop-hint" className="os-visually-hidden">
        Press and hold for about one second to stop every run. It does not stop the Hermes or OpenClaw background services.
      </span>
    </button>
  );
}
