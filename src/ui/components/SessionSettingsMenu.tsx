// "Terminal settings" in the Sessions page's tab bar: a small menu with the three terminal settings (spec, Browser
// terminal; the prototype has no menu, so it is built from the kit: a ghost button, a raised panel, check boxes).
// Kitty keyboard and Faster drawing change only this browser's terminal, so the page keeps them in this browser.
// The Claude Code fullscreen view changes how Claude Code starts, so Agent OS keeps it (GET/PUT
// /api/sessions/settings) and it applies to sessions started or resumed afterwards. Arrow keys move, Enter or Space
// toggles, Escape (or a click outside) closes, and focus goes back to the button.
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, Settings2 } from "lucide-react";
// Both calls carry their own time limit (sessionsApi.ts, SESSION_LIMITS_MS.settings).
import { getSessionSettings, putSessionSettings } from "../../sessionsApi";
import type { TerminalPrefs } from "../sessionsPageShared";

type Phase = "loading" | "ready" | "saving" | "failed";

function Box({ checked, phase }: { checked: boolean; phase?: Phase }) {
  return (
    <span className="os-sess-settings__box" aria-hidden="true">
      {phase === "loading" ? "…" : phase === "failed" ? "—" : checked ? <Check size={13} /> : null}
    </span>
  );
}

export default function SessionSettingsMenu({ prefs, onPrefs }: { prefs: TerminalPrefs; onPrefs: (next: TerminalPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  // The newest read or write wins: an older answer never lands over a newer one.
  const newest = useRef(0);
  const menuId = useId();
  const noteId = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function load(after = "") {
    const mine = ++newest.current;
    setPhase("loading");
    setMessage("");
    try {
      const settings = await getSessionSettings();
      if (!alive.current || mine !== newest.current) return;
      setFullscreen(Boolean(settings.claudeFullscreen));
      setPhase("ready");
      setMessage(after);
    } catch {
      if (!alive.current || mine !== newest.current) return;
      setFullscreen(null);
      setPhase("failed");
      setMessage("Couldn't read this setting. Close the menu and open it again to try again.");
    }
  }

  function openMenu() {
    setOpen(true);
    void load();
  }
  function closeMenu(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  // Focus goes into the menu when it opens.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
  }, [open]);

  // A press outside closes it, without taking focus back: the person is busy with something else.
  useEffect(() => {
    if (!open) return undefined;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function toggleFullscreen() {
    if (phase !== "ready" || fullscreen === null) return;
    const next = !fullscreen;
    const mine = ++newest.current;
    setPhase("saving");
    setFullscreen(next);
    setMessage("");
    try {
      const saved = await putSessionSettings({ claudeFullscreen: next });
      if (!alive.current || mine !== newest.current) return;
      setFullscreen(Boolean(saved.claudeFullscreen));
      setPhase("ready");
    } catch {
      if (!alive.current || mine !== newest.current) return;
      // A refusal or no answer: read back what Agent OS really kept, and say so.
      void load("Agent OS didn't confirm the change. The box shows what it has kept.");
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') || []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      // preventDefault marks the key as used: the Shell's window handler then leaves an expanded sidebar alone
      // (it skips a key that is already defaultPrevented), and the event still reaches every other listener.
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="os-sess-settings">
      <button
        ref={buttonRef}
        type="button"
        className="os-btn os-btn--ghost os-sess-settings__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu(false) : openMenu())}
      >
        <Settings2 size={16} aria-hidden="true" />
        Terminal settings
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="os-sess-settings__menu" role="menu" aria-label="Terminal settings" onKeyDown={onMenuKeyDown}>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.kittyKeyboard}
            tabIndex={-1}
            className="os-sess-settings__item"
            onClick={() => onPrefs({ ...prefs, kittyKeyboard: !prefs.kittyKeyboard })}
          >
            <Box checked={prefs.kittyKeyboard} />
            <span>Kitty keyboard (turn off if typing in your language misbehaves)</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.webgl}
            tabIndex={-1}
            className="os-sess-settings__item"
            onClick={() => onPrefs({ ...prefs, webgl: !prefs.webgl })}
          >
            <Box checked={prefs.webgl} />
            <span>Faster drawing (WebGL)</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={fullscreen === true}
            aria-disabled={phase !== "ready" ? true : undefined}
            aria-describedby={noteId}
            tabIndex={-1}
            className="os-sess-settings__item"
            onClick={() => void toggleFullscreen()}
          >
            <Box checked={fullscreen === true} phase={phase === "saving" ? undefined : phase} />
            <span>
              Use Claude Code&apos;s fullscreen view in Agent OS (recommended)
              <span id={noteId} className="os-sess-settings__note">
                Applies to new sessions
              </span>
            </span>
          </button>
          {message ? (
            <p className="os-sess-settings__msg" role="status">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
