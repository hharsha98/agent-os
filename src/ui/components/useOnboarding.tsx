// One shared copy of the "Get started" checklist for the whole shell: the pill
// in the header and the card on Home read the same state, so they can never
// disagree about "3 of 4 done". The server does the real checking (and
// remembers its answer for a minute); this only asks again at moments that
// matter: when the app opens, when you come back from the browser (a sign-in),
// when you leave Setup or arrive on Home, and every 90 seconds while something
// is still to do.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { queryParam } from "../../nav";
import { getOnboarding, saveOnboarding } from "../../onboardingApi";
import type { Onboarding, OnboardingStepId } from "../../onboardingApi";
import { useInterval } from "./useInterval";

const POLL_MS = 90 * 1000;
// A look that skips the server's memory is never repeated more often than this.
const MIN_RECHECK_GAP_MS = 5000;
const FOCUS_RECHECK_GAP_MS = 20 * 1000;

export interface OnboardingState {
  // false in the public demo, where this computer's agents are not the point.
  enabled: boolean;
  data: Onboarding | null;
  // The checklist could not be read (the page shows nothing rather than guessing).
  failed: boolean;
  // A choice (skip, hide) that could not be saved, in plain English.
  saveError: string;
  recheck: () => Promise<void>;
  skip: (id: OnboardingStepId) => Promise<void>;
  unskip: (id: OnboardingStepId) => Promise<void>;
  setHidden: (hidden: boolean) => Promise<void>;
}

const OFF: OnboardingState = {
  enabled: false,
  data: null,
  failed: false,
  saveError: "",
  recheck: async () => undefined,
  skip: async () => undefined,
  unskip: async () => undefined,
  setHidden: async () => undefined
};

const OnboardingContext = createContext<OnboardingState>(OFF);

export function useOnboarding() {
  return useContext(OnboardingContext);
}

export function OnboardingProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [data, setData] = useState<Onboarding | null>(null);
  const [failed, setFailed] = useState(false);
  const [saveError, setSaveError] = useState("");
  const dataRef = useRef<Onboarding | null>(null);
  dataRef.current = data;
  const lastRecheckRef = useRef(0);

  const load = useCallback(
    async (fresh: boolean, bypassGap = false) => {
      if (!enabled) return;
      let askFresh = fresh;
      if (askFresh) {
        const now = Date.now();
        if (!bypassGap && now - lastRecheckRef.current < MIN_RECHECK_GAP_MS) askFresh = false;
        else lastRecheckRef.current = now;
      }
      try {
        setData(await getOnboarding(askFresh));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    [enabled]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Moments that matter (see the top of this file).
  useEffect(() => {
    if (!enabled) return undefined;
    let lastPage = queryParam("page") || "fleet";
    function onNavigate() {
      const nextPage = queryParam("page") || "fleet";
      const from = lastPage;
      lastPage = nextPage;
      if (nextPage === from) return;
      if (from === "setup") void load(true, true);
      else if (nextPage === "fleet") void load(true);
    }
    // Coming back to the window (e.g. from the browser after a sign-in) looks
    // again, but not more than once every 20 seconds: each look runs a few
    // small status commands.
    function onFocus() {
      if (Date.now() - lastRecheckRef.current >= FOCUS_RECHECK_GAP_MS) void load(true);
    }
    window.addEventListener("aos-navigate", onNavigate);
    window.addEventListener("popstate", onNavigate);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("aos-navigate", onNavigate);
      window.removeEventListener("popstate", onNavigate);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, load]);

  // Nothing left to do: stop asking.
  useInterval(() => void load(false), enabled && !data?.complete ? POLL_MS : null);

  const persist = useCallback(async (patch: Parameters<typeof saveOnboarding>[0]) => {
    setSaveError("");
    try {
      setData(await saveOnboarding(patch));
      setFailed(false);
    } catch {
      setSaveError("Couldn't save that. Try again.");
    }
  }, []);

  const skippedIds = useCallback(
    () => (dataRef.current ? dataRef.current.steps.filter((step) => step.status === "skipped").map((step) => step.id) : []),
    []
  );

  const value = useMemo<OnboardingState>(
    () =>
      enabled
        ? {
            enabled,
            data,
            failed,
            saveError,
            recheck: () => load(true, true),
            skip: (id) => persist({ skipped: [...new Set([...skippedIds(), id])] }),
            unskip: (id) => persist({ skipped: skippedIds().filter((other) => other !== id) }),
            setHidden: (hidden) => persist({ hidden })
          }
        : OFF,
    [enabled, data, failed, saveError, load, persist, skippedIds]
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}
