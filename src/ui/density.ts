// "Comfortable" or "Compact" spacing, remembered per viewer. Compact tightens
// every spacing token by about a fifth (see tokens.css, [data-density="compact"]).
// The choice lives in this browser only (localStorage, which can throw in a
// locked-down webview, so every access is wrapped); it never reaches the server.
import { useEffect, useState } from "react";

export type Density = "comfortable" | "compact";

const DENSITY_STORAGE_KEY = "agentos.density";
const DENSITY_EVENT = "aos-density";

export function readDensity(): Density {
  try {
    return window.localStorage.getItem(DENSITY_STORAGE_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function applyDensity(density: Density) {
  document.documentElement.dataset.density = density;
}

export function setDensity(density: Density) {
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Losing the preference is harmless; it still applies until the page closes.
  }
  applyDensity(density);
  window.dispatchEvent(new Event(DENSITY_EVENT));
}

// The header switch and the ⌘K palette both change it, so both read it here.
export function useDensity(): Density {
  const [density, setCurrent] = useState<Density>(readDensity);
  useEffect(() => {
    function sync() {
      setCurrent(readDensity());
    }
    window.addEventListener(DENSITY_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(DENSITY_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return density;
}

// Applied as soon as this file is loaded, before the first render, so a
// remembered "Compact" never flashes as "Comfortable".
if (typeof document !== "undefined") applyDensity(readDensity());
