// Is this window the Agent OS desktop app (the Tauri shell) rather than a
// browser tab? The Rust shell opens the window with ?desktop=1, and the shell
// keeps that parameter (main.tsx removes only ?launch). window.__TAURI_INTERNALS__
// is the fallback marker. UpdateBanner.tsx keeps its own private copy of this check.
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("desktop") === "1") return true;
  return "__TAURI_INTERNALS__" in window;
}

// OPENER-START (Task B3). Step 9 replaces everything between these two markers
// when the owner has approved tauri-plugin-opener. Nothing else in the file changes.
export const OPENER_INSTALLED = false;

export async function revealInFinder(_absolutePath: string): Promise<void> {
  throw new Error("Show in Finder is not available in this build.");
}
// OPENER-END

// The Workspace page shows its "Show in Finder" button only when this is true:
// in the desktop app, and only when the opener is installed. In a browser tab
// there is no Finder to open, so the button is simply not drawn.
export function canRevealInFinder(): boolean {
  return OPENER_INSTALLED && isDesktopApp();
}
