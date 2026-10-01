import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import "../updateBanner.css";

// Only the desktop app has an updater. The Rust shell opens the window with
// ?desktop=1; window.__TAURI_INTERNALS__ is the fallback marker.
function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("desktop") === "1") return true;
  return "__TAURI_INTERNALS__" in window;
}

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const LOG_PREFIX = "[agent-os updater]";

type Phase = "ready" | "installing" | "failed";

// A slim notice that appears only when a newer desktop build exists. It never
// installs or restarts on its own: running agents may be mid-task, so the
// user has to click "Install & restart".
export default function UpdateBanner() {
  const desktop = isDesktopApp();
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [notesOpen, setNotesOpen] = useState(false);
  const installingRef = useRef(false);

  const checkForUpdate = useCallback(async () => {
    if (installingRef.current) return;
    try {
      // Lazy import: the plain browser build never loads the Tauri packages.
      const { check } = await import("@tauri-apps/plugin-updater");
      const found = await check();
      if (found) setUpdate(found);
    } catch (error) {
      // Expected until the app has a signing key and an update feed; kept
      // out of the UI so it never nags, but visible in the console.
      console.warn(`${LOG_PREFIX} update check failed:`, error);
    }
  }, []);

  useEffect(() => {
    if (!desktop) return undefined;
    void checkForUpdate();
    const timer = window.setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [desktop, checkForUpdate]);

  async function install() {
    if (!update || installingRef.current) return;
    installingRef.current = true;
    setPhase("installing");
    try {
      await update.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      console.error(`${LOG_PREFIX} install failed:`, error);
      installingRef.current = false;
      setPhase("failed");
    }
  }

  if (!desktop || !update) return null;
  const notes = (update.body || "").trim();

  return (
    <div className="os-update" role="status" aria-live="polite">
      <div className="os-update__bar">
        <ArrowUpCircle size={16} className="os-update__icon" aria-hidden="true" />
        <span className="os-update__text">
          {phase === "failed"
            ? "The update didn't install. Nothing was changed; you can try again."
            : `Agent OS ${update.version} is ready to install`}
        </span>
        {notes ? (
          <button className="os-update__link" onClick={() => setNotesOpen((open) => !open)} aria-expanded={notesOpen}>
            What&apos;s new
          </button>
        ) : null}
        <button className="os-btn os-btn--primary os-update__action" onClick={() => void install()} disabled={phase === "installing"}>
          {phase === "installing" ? "Installing…" : phase === "failed" ? "Try again" : "Install & restart"}
        </button>
      </div>
      {notesOpen && notes ? <pre className="os-update__notes">{notes}</pre> : null}
    </div>
  );
}
