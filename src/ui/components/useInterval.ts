import { useEffect, useRef } from "react";

// Polls `callback` every `delayMs`, paused while the document is hidden so
// background tabs never spend the user's battery or hammer the server.
// `delayMs === null` disables the interval entirely.
export function useInterval(callback: () => void, delayMs: number | null) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (delayMs === null) return;
    let id: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (id !== null) return;
      id = setInterval(() => savedCallback.current(), delayMs as number);
    }
    function stop() {
      if (id === null) return;
      clearInterval(id);
      id = null;
    }
    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [delayMs]);
}
