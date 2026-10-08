import { useCallback, useEffect, useState } from "react";
import type { BuilderBrains, OpenRouterKeyStatus } from "../../buildersApi";
import { BRAINS_CHANGED_EVENT, KEY_CHANGED_EVENT, getBuilderBrains, getOpenRouterKeyStatus } from "../../buildersApi";

// The coding agents' saved brains (and what each mode offers), read from the
// server. Every screen that shows or changes a brain uses this, and they all
// re-read when one of them saves (BRAINS_CHANGED_EVENT). `failed` is true when
// the settings could not be read: a screen then simply leaves the brain out
// rather than guessing.
export function useBuilderBrains() {
  const [brains, setBrains] = useState<BuilderBrains | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      setBrains(await getBuilderBrains());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    window.addEventListener(BRAINS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(BRAINS_CHANGED_EVENT, reload);
  }, [reload]);

  return { brains, failed, reload };
}

// Whether the OpenRouter key is remembered for the coding agents (never the key itself).
export function useOpenRouterKey() {
  const [status, setStatus] = useState<OpenRouterKeyStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStatus(await getOpenRouterKeyStatus());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    window.addEventListener(KEY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(KEY_CHANGED_EVENT, reload);
  }, [reload]);

  return { status, failed, reload };
}
