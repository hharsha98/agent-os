import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import { quitCheckOrNone } from "../../sessionsApi";
import { installQuestion } from "../sessionsShared";
import type { QuitView } from "../sessionsShared";
import QuitQuestion from "./QuitQuestion";
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

// "checking": asking Agent OS which sessions run, before anything is downloaded.
type Phase = "ready" | "checking" | "installing" | "failed";

// A slim notice that appears only when a newer desktop build exists. It never
// installs or restarts on its own: running agents may be mid-task, so the
// user has to click "Install & restart". That restart quits Agent OS and ends
// every session, and the shell cannot ask first on this path (an approved
// restart leaves with RESTART_EXIT_CODE, which the shell's quit question cannot
// hold; see desktop/src-tauri/src/main.rs). So the banner asks first, with the
// same quit question, whenever a session runs or Agent OS does not answer.
export default function UpdateBanner() {
  const desktop = isDesktopApp();
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [notesOpen, setNotesOpen] = useState(false);
  // The quit question while it asks before the restart, otherwise null.
  const [ask, setAsk] = useState<QuitView | null>(null);
  const installingRef = useRef(false);
  // The banner as it was before the question ("ready", or "failed" after a failed install), so Keep running
  // puts back exactly that and a failed install is not forgotten.
  const phaseBefore = useRef<Phase>("ready");

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

  // Downloads, installs and relaunches. Reached only when nothing runs, or from the question's "Install & restart".
  async function installNow() {
    if (!update) return;
    setAsk(null);
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

  async function install() {
    if (!update || installingRef.current) return;
    installingRef.current = true;
    phaseBefore.current = phase === "failed" ? "failed" : "ready";
    setPhase("checking");
    // Every live session of both kinds, with its title (POST /api/sessions/quit-check, with its time limit).
    // Where sessions do not exist the answer is "none running", not "couldn't check".
    const check = await quitCheckOrNone().catch(() => null);
    // Sessions running, or no readable answer: ask first (and say so when it could not check). Nothing
    // running: nothing would be lost, so install at once, as before.
    const question = installQuestion(check);
    if (question) {
      setPhase(phaseBefore.current);
      setAsk(question);
      return;
    }
    await installNow();
  }

  // Keep running: nothing was downloaded or restarted, and the banner is back as it was (also after a failed
  // install: "The update didn't install" stays).
  function keepRunning() {
    setAsk(null);
    installingRef.current = false;
    setPhase(phaseBefore.current);
  }

  if (!desktop || !update) return null;
  const notes = (update.body || "").trim();

  return (
    <>
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
          {/* aria-disabled, not disabled: a button that turns disabled while it has focus drops the keyboard to the
              page, and the question could not give focus back to it. install() ignores a press while it works. */}
          <button
            className="os-btn os-btn--primary os-update__action"
            onClick={() => void install()}
            aria-disabled={phase === "checking" || phase === "installing" || ask !== null ? true : undefined}
          >
            {phase === "checking" ? "Checking…" : phase === "installing" ? "Installing…" : phase === "failed" ? "Try again" : "Install & restart"}
          </button>
        </div>
        {notesOpen && notes ? <pre className="os-update__notes">{notes}</pre> : null}
      </div>
      {/* Outside .os-update: that wrapper ignores the pointer and is its own layer (updateBanner.css), so a
          dialog inside it could not be clicked or sit above the page. */}
      {ask ? <QuitQuestion view={ask} quitLabel="Install & restart" onKeepRunning={keepRunning} onQuit={() => void installNow()} /> : null}
    </>
  );
}
