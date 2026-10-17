// Is this window the Agent OS desktop app (the Tauri shell) rather than a
// browser tab? The Rust shell opens the window with ?desktop=1, and the shell
// keeps that parameter (main.tsx removes only ?launch). window.__TAURI_INTERNALS__
// is the fallback marker. UpdateBanner.tsx keeps its own private copy of this check.
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("desktop") === "1") return true;
  return "__TAURI_INTERNALS__" in window;
}

// OPENER-START (Task B3). The owner approved tauri-plugin-opener.
export const OPENER_INSTALLED = true;

// Shows the file in Finder (Explorer on Windows, the file manager on Linux)
// with the file selected. Lazy import, like UpdateBanner: a plain browser
// tab never loads the Tauri packages.
export async function revealInFinder(absolutePath: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(absolutePath);
}
// OPENER-END

// The Workspace page shows its "Show in Finder" button only when this is true:
// in the desktop app, and only when the opener is installed. In a browser tab
// there is no Finder to open, so the button is simply not drawn.
export function canRevealInFinder(): boolean {
  return OPENER_INSTALLED && isDesktopApp();
}
