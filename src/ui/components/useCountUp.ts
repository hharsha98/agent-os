import { useEffect, useRef, useState } from "react";

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// Counts up from 0 to `target` exactly once, the moment `target` stops being
// null (i.e. the real value has arrived) — never on later updates, so a
// refresh that changes the number just snaps to it. Reduced motion (or a
// later mount past the deadline) skips straight to the final value: this is
// a presentation of a true number, not a fabricated animation.
export function useCountUp(target: number | null, durationMs: number) {
  const [display, setDisplay] = useState<number | null>(target);
  const startedRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (target === null) return;
    // A hidden page never paints animation frames, so animating there would
    // leave a false in-between number on screen; show the true one instead.
    if (startedRef.current || reducedMotion || document.hidden) {
      startedRef.current = true;
      setDisplay(target);
      return;
    }
    startedRef.current = true;
    const start = performance.now();
    let raf = 0;
    function tick(now: number) {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * (target as number)));
      if (progress < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    // Safety net: if frames stop (window minimised mid-count, throttled
    // webview), a plain timer still lands the true value on time.
    const settle = setTimeout(() => {
      cancelAnimationFrame(raf);
      setDisplay(target);
    }, durationMs + 50);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return display;
}
