// Sessions: each agent's own terminal program, one tab per session (the prototype's sessions.html, in its SP3 form).
// The tabs run across the top (an ended one says so and can be dismissed), the terminal fills the middle, and the
// selected session's details sit on the right: folder, state, Live meter and Stop. The list is the one shared
// sessions poll (useSessionsList, decision Q30). The selected tab is in the address (?session=<id>), so leaving the
// page and coming back lands on the same tab. Only the selected session's terminal is attached; the others keep
// running in the engine and come back with their screen when picked. A session that ends while it is on screen
// keeps its terminal (and so its last screen, an agent's own error message for example) until another tab is picked;
// that terminal is told the session ended (`ended`), so it never tries to attach again (ruling R12).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Info, Plus, SquareTerminal } from "lucide-react";
import { navigateTo, queryParam } from "../nav";
import { dismissSession, resumeSession, sessionGotNoAnswer, stopSession } from "../sessionsApi";
import type { SessionSummary } from "../types";
import AgentConfirmModal from "../ui/components/AgentConfirmModal";
import Banner from "../ui/components/Banner";
import EmptyState from "../ui/components/EmptyState";
import PageHeader from "../ui/components/PageHeader";
import SessionSettingsMenu from "../ui/components/SessionSettingsMenu";
import SessionSidePanel from "../ui/components/SessionSidePanel";
import SessionTabs, { sessionTabDomId } from "../ui/components/SessionTabs";
import SessionTerminal from "../ui/components/SessionTerminal";
import StatusWord from "../ui/components/StatusWord";
import Toast from "../ui/components/Toast";
import { isDesktopApp } from "../ui/desktop";
import { openNewSession, takeFocusNextSession } from "../ui/newSession";
import {
  isAppShortcut,
  isMacPlatform,
  resumeConfirmCopy,
  sessionPanelLine,
  sessionTitle,
  shortcutHints,
  stopDialogCopy
} from "../ui/sessionsShared";
import {
  TERMINAL_PREFS_KEY,
  actionProblem,
  askingWhileTab,
  dismissErrorWhileEnded,
  isLookOnlyRefusal,
  isStopAnswer,
  newSessionHint,
  nextGenerations,
  parseTerminalPrefs,
  panelStopNote,
  pickSelected,
  pruneHidden,
  serializeTerminalPrefs,
  stableOrder,
  terminalKey,
  terminalTakesKeys,
  visibleTabs
} from "../ui/sessionsPageShared";
import type { Generations, StopNote, TerminalPrefs } from "../ui/sessionsPageShared";
import { useSessionsList } from "../ui/useSessionsList";
import "../ui/sessions.css";

// Stop, Resume and Dismiss carry their own time limits (sessionsApi.ts, SESSION_LIMITS_MS: 15 s for Stop, which
// waits on the agent's soft stop and the kill grace; 30 s for Resume, which waits on the login-shell environment).
// What computer this is, read the same way as the Shell and the terminal (isMacPlatform, Task U1).
const PLATFORM = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";
const IS_MAC = isMacPlatform(PLATFORM);
const PTY_WORDS = "Agent OS could not load its terminal module on this computer, so sessions can't start.";
const PANEL_ID = "os-sess-main";

type Asking = { session: SessionSummary; busy: boolean; error: string; toSafety: boolean };

// The terminal's own settings, kept in this browser; the defaults follow decision Q45 (sessionsPageShared.ts).
function readPrefs(desktop: boolean): TerminalPrefs {
  const platform = { platform: PLATFORM, desktop };
  try {
    return parseTerminalPrefs(window.localStorage.getItem(TERMINAL_PREFS_KEY), platform);
  } catch {
    return parseTerminalPrefs(null, platform);
  }
}

export default function SessionsPage() {
  const list = useSessionsList();
  const { refresh } = list;
  const desktop = isDesktopApp();
  const body = list.source.state === "ok" ? list.source.data : null;
  const stale = list.source.state === "ok" && Boolean(list.source.stale);
  const sessions = useMemo<SessionSummary[]>(() => (body && Array.isArray(body.sessions) ? body.sessions : []), [body]);
  const orderRef = useRef<string[]>([]);
  const gensRef = useRef<Generations>({});
  const order = useMemo(() => (orderRef.current = stableOrder(orderRef.current, sessions)), [sessions]);
  const gens = useMemo(() => (gensRef.current = nextGenerations(gensRef.current, sessions)), [sessions]);
  // Tabs dismissed here, hidden at once while the request is on its way (and forgotten once the list shows one of
  // them running again, see the effect below: from then on the server's own dismissed flag decides).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());
  const tabs = useMemo(() => visibleTabs(sessions, order, hidden), [sessions, order, hidden]);
  const [wanted, setWanted] = useState(() => queryParam("session"));
  const selectedId = pickSelected(tabs, wanted);
  const selected = tabs.find((tab) => tab.id === selectedId) || null;
  // The tab asked for is not in the list yet (a session started a moment ago): no terminal takes the keys meanwhile.
  const wantedListed = tabs.some((tab) => tab.id === wanted);
  const key = selected ? terminalKey(selected.id, gens) : "";
  // The terminal key that was on screen while its session was open (see the comment at the top).
  const [liveShown, setLiveShown] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => readPrefs(desktop));
  const [focusTerminal, setFocusTerminal] = useState(() => takeFocusNextSession());
  // A sentence from the terminal itself, for example "Link copied. Open it in your browser." (ruling R25).
  const [terminalNote, setTerminalNote] = useState<{ id: number; text: string } | null>(null);
  const [stopping, setStopping] = useState<Asking | null>(null);
  // The server's own note from the last Stop pressed here, with the terminal key of the run it stopped.
  const [stopNote, setStopNote] = useState<StopNote | null>(null);
  const [resuming, setResuming] = useState<Asking | null>(null);
  // The words of a failed Dismiss, with the ended tab they are about (they go when that tab does, see below).
  const [pageError, setPageError] = useState<{ id: string; text: string } | null>(null);
  const alive = useRef(true);
  const askedFor = useRef("");
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastSeen = useRef<{ id: string; status: string } | null>(null);
  const focusAfterDismiss = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The address picks the tab: a link from Runs, Home or Agents, or the New session dialog after a start.
  useEffect(() => {
    function sync() {
      setWanted(queryParam("session"));
      if (takeFocusNextSession()) setFocusTerminal(true);
    }
    window.addEventListener("aos-navigate", sync);
    return () => window.removeEventListener("aos-navigate", sync);
  }, []);

  // A session the list does not hold yet (it started a moment ago): read the list again, once.
  useEffect(() => {
    if (!wanted || !body || sessions.some((session) => session.id === wanted) || askedFor.current === wanted) return;
    askedFor.current = wanted;
    refresh();
  }, [wanted, body, sessions, refresh]);

  // Another tab picked: whatever terminal was on screen goes. An open session puts its own up.
  useEffect(() => {
    setLiveShown(null);
  }, [selectedId]);
  useEffect(() => {
    if (selected && selected.status !== "exited") setLiveShown(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, selected?.status]);
  const showTerminal = selected !== null && (selected.status !== "exited" || liveShown === key);

  // When the selected session ends while you look at it, the Stop button goes; keyboard focus then goes to the
  // panel's title instead of falling to the page. A page opened on an ended tab does not move focus.
  useEffect(() => {
    const before = lastSeen.current;
    lastSeen.current = selected ? { id: selected.id, status: selected.status } : null;
    if (!selected || selected.status !== "exited" || !before || before.id !== selected.id || before.status === "exited") return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  // After Dismiss: focus goes to the tab that is selected now, or to New session when no tab is left.
  useEffect(() => {
    if (!focusAfterDismiss.current) return;
    focusAfterDismiss.current = false;
    const target = document.querySelector<HTMLElement>('.os-sess-tabs [role="tab"][aria-selected="true"]') || document.querySelector<HTMLElement>(".os-sess-empty-new");
    target?.focus();
  }, [tabs]);

  // Dismissed here and resumed in another window: the list shows it running again, so the local hiding is dropped.
  // Without this, the tab would vanish from this window the next time that session ends.
  useEffect(() => {
    setHidden((prev) => pruneHidden(prev, sessions));
  }, [sessions]);

  // A Stop or Resume question, and the words of a failed Dismiss, are about one session. When it leaves the tabs
  // (dismissed in another window, say) they go with it: otherwise the old question could come back over another
  // session later, and one press would act on a session that was put away. A question whose request is still on
  // its way stays; that request decides what happens next.
  useEffect(() => {
    setStopping((current) => askingWhileTab(current, tabs));
    setResuming((current) => askingWhileTab(current, tabs));
    setPageError((current) => dismissErrorWhileEnded(current, tabs));
  }, [tabs, stopping, resuming, pageError]);

  function select(id: string, focusIt = false) {
    setWanted(id);
    setFocusTerminal(focusIt);
    navigateTo("sessions", { session: id });
  }

  // ⌘T and ⌘1-9 (Ctrl+Shift+T and Ctrl+Shift+1-9 on Windows and Linux), in the desktop app only: a browser keeps
  // these keys for itself (spec, App shortcuts). The terminal lets them through to here.
  useEffect(() => {
    if (!desktop) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return;
      // A dialog or the palette has the keyboard: leave its keys alone.
      if (document.querySelector('[aria-modal="true"]')) return;
      // Events from inside a terminal are NOT skipped: the terminal (Task U2) lets ⌘T and ⌘1-9 through to here
      // untouched. The palette key is the terminal's and the Shell's own business.
      const shortcut = isAppShortcut(event, { isMac: IS_MAC, desktop: true });
      if (!shortcut || shortcut.action === "palette") return;
      event.preventDefault();
      if (shortcut.action === "new-session") {
        openNewSession();
        return;
      }
      const target = tabsRef.current[shortcut.index];
      if (!target) return;
      const fromTerminal = event.target instanceof Element && Boolean(event.target.closest(".xterm"));
      select(target.id, fromTerminal);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  const onTerminalState = useCallback(() => {
    if (alive.current) refresh();
  }, [refresh]);
  const onTerminalNotice = useCallback((text: string) => {
    if (alive.current && text) setTerminalNote({ id: Date.now(), text });
  }, []);

  function changePrefs(next: TerminalPrefs) {
    setPrefs(next);
    try {
      window.localStorage.setItem(TERMINAL_PREFS_KEY, serializeTerminalPrefs(next));
    } catch {
      // A locked-down webview: the setting lasts until the page reloads.
    }
  }

  async function confirmStop() {
    if (!stopping || stopping.busy) return;
    const { session } = stopping;
    // Ending does not raise the generation, so this is still the key while the stopped run stays on show.
    const stoppedKey = terminalKey(session.id, gens);
    setStopping({ session, busy: true, error: "", toSafety: false });
    try {
      const result = await stopSession(session.id);
      if (!alive.current) return;
      // An answer that is not what a Stop answers (`null`, say) is an answer that could not be read, like a body
      // that is not JSON (a SyntaxError, which sessionGotNoAnswer counts as an answer).
      if (!isStopAnswer(result)) throw new SyntaxError("Agent OS answered with something that is not a stop result.");
      // S7's answer carries its own note (S8 passes it through): OpenClaw's honest sentence until spike S5 brings
      // its Gateway abort, null once nothing is left running. The panel shows it instead of guessing.
      setStopNote({ key: stoppedKey, note: result.note ?? null });
      setStopping(null);
    } catch (error) {
      if (!alive.current) return;
      setStopping({ session, busy: false, error: actionProblem(error, "stop", sessionGotNoAnswer(error)), toSafety: false });
    } finally {
      if (alive.current) refresh();
    }
  }

  async function confirmResume() {
    if (!resuming || resuming.busy) return;
    const { session } = resuming;
    setResuming({ session, busy: true, error: "", toSafety: false });
    try {
      await resumeSession(session.id);
      if (!alive.current) return;
      setResuming(null);
      setFocusTerminal(true);
    } catch (error) {
      if (!alive.current) return;
      setResuming({ session, busy: false, error: actionProblem(error, "resume", sessionGotNoAnswer(error)), toSafety: isLookOnlyRefusal(error) });
    } finally {
      if (alive.current) refresh();
    }
  }

  async function dismiss(id: string) {
    setPageError(null);
    focusAfterDismiss.current = true;
    setHidden((prev) => new Set(prev).add(id));
    try {
      await dismissSession(id);
    } catch (error) {
      if (!alive.current) return;
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setPageError({ id, text: actionProblem(error, "dismiss", sessionGotNoAnswer(error)) });
    } finally {
      if (alive.current) refresh();
    }
  }

  const notice = body?.environmentNotice || "";
  const ptyProblem = body && body.pty && !body.pty.ok ? body.pty.reason || PTY_WORDS : "";
  const staleBanner = stale ? (
    <Banner tone="warn" title="Can't reach Agent OS">
      Showing what was last known. This page tries again every few seconds.
    </Banner>
  ) : null;
  const ptyBanner = ptyProblem ? (
    <Banner tone="warn" title="Sessions can't start on this computer">
      {ptyProblem}
    </Banner>
  ) : null;
  const noticeLine = notice ? (
    <p className="os-sess__notice">
      <Info size={15} aria-hidden="true" />
      {notice}
    </p>
  ) : null;

  if (!list.available) {
    return (
      <section className="os-sess" aria-labelledby="os-sessions-title">
        <div className="os-sess__pad">
          <PageHeader title="Sessions" titleId="os-sessions-title" />
          <EmptyState
            icon={SquareTerminal}
            title="Sessions aren't available here"
            body="Sessions run only when Agent OS runs on your own computer, not in the public demo or on a shared server."
          />
        </div>
      </section>
    );
  }

  if (!body) {
    return (
      <section className="os-sess" aria-labelledby="os-sessions-title">
        <div className="os-sess__pad">
          <PageHeader title="Sessions" titleId="os-sessions-title" />
          {list.source.state === "error" ? (
            <Banner
              tone="danger"
              title="Agent OS isn't responding"
              actions={
                <button type="button" className="os-btn os-btn--secondary" onClick={() => refresh()}>
                  Try again
                </button>
              }
            >
              The sessions can&apos;t be listed right now. This page tries again every few seconds.
            </Banner>
          ) : (
            <p className="os-sess__loading">
              <StatusWord state="loading" />
            </p>
          )}
        </div>
      </section>
    );
  }

  if (!selected) {
    return (
      <section className="os-sess" aria-labelledby="os-sessions-title">
        <div className="os-sess__pad">
          <PageHeader title="Sessions" titleId="os-sessions-title" />
          {staleBanner}
          {ptyBanner}
          {noticeLine}
          {pageError ? (
            <p className="os-sess__error" role="alert">
              {pageError.text}
            </p>
          ) : null}
          <EmptyState
            icon={SquareTerminal}
            title="No sessions yet"
            body="A session is an agent's own terminal, running in a folder you pick. It works the same as in Terminal."
            action={
              <div className="os-sess-empty__acts">
                <button type="button" className="os-btn os-btn--primary os-sess-empty-new" onClick={() => openNewSession()}>
                  <Plus size={17} aria-hidden="true" />
                  New session
                </button>
                <a
                  className="os-sess-empty__link"
                  href="?page=help"
                  onClick={(event) => {
                    event.preventDefault();
                    navigateTo("help");
                  }}
                >
                  How a session works
                </a>
              </div>
            }
          />
        </div>
      </section>
    );
  }

  const title = sessionTitle(selected);
  // Empty in a browser tab, which keeps ⌘T and ⌘1-9 for itself (spec, Browser mode).
  const hints = shortcutHints({ isMac: IS_MAC, desktop });
  const stopCopy = stopping ? stopDialogCopy(stopping.session) : null;
  const resumeCopy = resuming ? resumeConfirmCopy(resuming.session) : null;

  return (
    <section className="os-sess" aria-labelledby="os-sessions-title">
      <h1 id="os-sessions-title" className="os-visually-hidden">
        Sessions
      </h1>
      <div className="os-sess__bar">
        <SessionTabs
          tabs={tabs.map((session) => ({ id: session.id, title: sessionTitle(session), status: session.status, recordingBytes: session.recordingBytes }))}
          selectedId={selectedId}
          panelId={PANEL_ID}
          onSelect={(id) => select(id)}
          onDismiss={(id) => void dismiss(id)}
        />
        <button
          type="button"
          className="os-btn os-btn--ghost os-sess-new"
          aria-label="New session"
          title={newSessionHint({ isMac: IS_MAC, desktop })}
          onClick={() => openNewSession()}
        >
          <Plus size={17} aria-hidden="true" />
        </button>
        <span className="os-sess__spacer" />
        <SessionSettingsMenu prefs={prefs} onPrefs={changePrefs} />
      </div>
      <div className="os-sess__body">
        <div className="os-sess__main" role="tabpanel" id={PANEL_ID} aria-labelledby={sessionTabDomId(selected.id)}>
          {staleBanner}
          {selected.status === "exited" ? ptyBanner : null}
          {pageError ? <Banner tone="warn">{pageError.text}</Banner> : null}
          {noticeLine}
          {showTerminal ? (
            <div className="os-sess-term">
              <SessionTerminal
                key={key}
                sessionId={selected.id}
                label={`${title} terminal`}
                kittyKeyboard={prefs.kittyKeyboard}
                webgl={prefs.webgl}
                ended={selected.status === "exited"}
                autoFocus={terminalTakesKeys({ focusTerminal, wanted, selectedId, wantedListed })}
                onState={onTerminalState}
                onNotice={onTerminalNotice}
              />
            </div>
          ) : (
            <div className="os-sess-ended">
              <SquareTerminal size={22} aria-hidden="true" />
              <p className="os-sess-ended__title">This session has ended</p>
              <p className="os-sess-ended__body">{sessionPanelLine(selected, Date.now())}</p>
            </div>
          )}
          <p className="os-sess__cap">
            <SquareTerminal size={15} aria-hidden="true" />
            {selected.agentLabel}&apos;s own terminal program, with your own settings.
          </p>
        </div>
        <SessionSidePanel
          session={selected}
          note={panelStopNote(selected, key, stopNote)}
          hints={hints}
          headingRef={headingRef}
          onStop={() => setStopping({ session: selected, busy: false, error: "", toSafety: false })}
          onResume={() => setResuming({ session: selected, busy: false, error: "", toSafety: false })}
          onOpenRecording={() => navigateTo("runs", { tab: "recordings", highlight: selected.id })}
        />
      </div>

      {stopping && stopCopy ? (
        <AgentConfirmModal
          title={stopCopy.title}
          confirmLabel="Stop session"
          cancelLabel="Keep it running"
          danger
          busy={stopping.busy}
          onConfirm={() => void confirmStop()}
          onClose={() => {
            if (!stopping.busy) setStopping(null);
          }}
        >
          <p>{stopCopy.body}</p>
          {stopCopy.note ? <p>{stopCopy.note}</p> : null}
          {stopping.error ? (
            <p className="os-sess__error" role="alert">
              {stopping.error}
            </p>
          ) : null}
        </AgentConfirmModal>
      ) : null}

      {resuming && resumeCopy ? (
        <AgentConfirmModal
          title={resumeCopy.title}
          confirmLabel="Resume conversation"
          busy={resuming.busy}
          onConfirm={() => void confirmResume()}
          onClose={() => {
            if (!resuming.busy) setResuming(null);
          }}
        >
          <p>{resumeCopy.body}</p>
          {resumeCopy.warning ? <Banner tone="warn">{resumeCopy.warning}</Banner> : null}
          {resuming.error ? (
            <p className="os-sess__error" role="alert">
              {resuming.error}{" "}
              {resuming.toSafety ? (
                <button
                  type="button"
                  className="os-newrun__link"
                  onClick={() => {
                    setResuming(null);
                    navigateTo("safety");
                  }}
                >
                  Open Safety
                </button>
              ) : null}
            </p>
          ) : null}
        </AgentConfirmModal>
      ) : null}

      {terminalNote ? <Toast key={terminalNote.id} message={terminalNote.text} tone="neutral" onClose={() => setTerminalNote(null)} /> : null}
    </section>
  );
}
