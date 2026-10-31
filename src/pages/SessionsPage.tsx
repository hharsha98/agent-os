// Sessions: each agent's own terminal program, one tab per session (the prototype's sessions.html, in its SP3 form).
// The tabs run across the top (an ended one says so and can be dismissed), the terminal fills the middle, and the
// selected session's details sit on the right: folder, state, Live meter and Stop. The list is the one shared
// sessions poll (useSessionsList, decision Q30). The selected tab is in the address (?session=<id>), so leaving the
// page and coming back lands on the same tab. Only the terminals on screen are attached; the others keep running in
// the engine and come back with their screen when picked. Split view (spec SP4, Split; Task U6) shows two sessions
// side by side, each pane with its own header and terminal: the selected tab is the focused pane and the side panel
// follows it, the same session is never in both panes (alignSplit), and split view is kept per window
// (sessionStorage). A session that ends while a pane shows it keeps its terminal (and so its last screen, an agent's
// own error message for example) until that pane shows another session; that terminal is told the session ended
// (`ended`), so it never tries to attach again (ruling R12).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Columns2, Info, Plus, SquareTerminal } from "lucide-react";
import { navigateTo, queryParam } from "../nav";
import { dismissSession, resumeSession, sessionGotNoAnswer, stopSession } from "../sessionsApi";
import type { SessionSummary } from "../types";
import AgentConfirmModal from "../ui/components/AgentConfirmModal";
import Banner from "../ui/components/Banner";
import EmptyState from "../ui/components/EmptyState";
import PageHeader from "../ui/components/PageHeader";
import SessionPaneHead from "../ui/components/SessionPaneHead";
import SessionSettingsMenu from "../ui/components/SessionSettingsMenu";
import SessionSidePanel from "../ui/components/SessionSidePanel";
import SessionLimitBanner from "../ui/components/SessionLimitBanner";
import SessionTabs, { sessionTabDomId } from "../ui/components/SessionTabs";
import SessionTerminal from "../ui/components/SessionTerminal";
import type { SessionTerminalHandle } from "../ui/components/SessionTerminal";
import SplitDivider from "../ui/components/SplitDivider";
import StatusWord from "../ui/components/StatusWord";
import { showShellToast } from "../ui/shellToast";
import { isDesktopApp } from "../ui/desktop";
import { openNewSession, takeFocusNextSession } from "../ui/newSession";
import { NOTIFY_NOTE_KEY, notifyNote } from "../ui/alertsShared";
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
import {
  SPLIT_GAP_PX,
  SPLIT_KEY,
  SPLIT_LABEL,
  alignSplit,
  canSplit,
  holdSelected,
  nextLiveShown,
  parseSplitState,
  serializeSplitState,
  splitButtonHint,
  splitKeys,
  toggleSplit,
  wantedStanding,
  withRatio
} from "../ui/splitShared";
import type { SplitState } from "../ui/splitShared";
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

// Split view is kept per window (this browser tab, or this desktop window): sessionStorage survives a reload and
// leaving the page, and a second window starts with one terminal (Task U6). A locked-down webview keeps it until the
// page reloads.
function readSplit(): SplitState {
  try {
    return parseSplitState(window.sessionStorage.getItem(SPLIT_KEY));
  } catch {
    return parseSplitState(null);
  }
}
function writeSplit(state: SplitState) {
  try {
    window.sessionStorage.setItem(SPLIT_KEY, serializeSplitState(state));
  } catch {
    // A locked-down webview: split view lasts until the page reloads.
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
  // Split view, kept per window (readSplit); `aligned` below is that state made true to the tabs.
  const [split, setSplit] = useState<SplitState>(readSplit);
  // A divider drag is on: split view is kept in sessionStorage when it ends, not on every pointer move.
  const [dragging, setDragging] = useState(false);
  // How the tab asked for stands against the list: a tab, "pending" (a session started a moment ago; the list does not
  // know it yet) or "gone" (the list knows it but it is put away: dismissed here or in another window).
  const standing = wantedStanding(wanted, tabs, sessions);
  // While the tab asked for is pending the page shows another tab, but split view keeps its pair on screen: the focused
  // pane's session stands in as the selected tab (holdSelected) instead of the first tab, which could be neither pane.
  const selectedId = standing === "pending" ? holdSelected(split, tabs, pickSelected(tabs, wanted)) : pickSelected(tabs, wanted);
  const selected = tabs.find((tab) => tab.id === selectedId) || null;
  // The tab asked for is not in the list yet (a session started a moment ago): no terminal takes the keys meanwhile.
  const wantedListed = standing === "tab";
  const key = selected ? terminalKey(selected.id, gens) : "";
  // The terminal keys a pane showed while their session was open (see the comment at the top and nextLiveShown).
  const [liveShown, setLiveShown] = useState<ReadonlySet<string>>(() => new Set<string>());
  // `aligned` is split view made true to the tabs and the selected tab (alignSplit): the selected tab is the focused
  // pane, a pane whose session left the tabs gets another one (a dismissed tab counts as left: it is in the list, so it
  // is settled, not pending), and the same session is never in both panes. Only a tab the list has not shown yet holds
  // alignment back, so split view waits for it instead of moving the focus there and back.
  const aligned = body && standing !== "pending" ? alignSplit(split, tabs, selectedId) : split;
  const splitPanes =
    aligned.on && aligned.panes && aligned.panes.includes(selectedId)
      ? aligned.panes.map((id) => tabs.find((tab) => tab.id === id)).filter((tab): tab is SessionSummary => Boolean(tab))
      : [];
  const splitOn = splitPanes.length === 2;
  // What the panes show: the two sessions of split view, or the selected one.
  const paneSessions: SessionSummary[] = splitOn ? splitPanes : selected ? [selected] : [];
  const otherPaneId = splitOn ? (splitPanes.find((session) => session.id !== selectedId)?.id ?? "") : "";
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => readPrefs(desktop));
  const [focusTerminal, setFocusTerminal] = useState(() => takeFocusNextSession());
  const [stopping, setStopping] = useState<Asking | null>(null);
  // The server's own note from the last Stop pressed here, with the terminal key of the run it stopped.
  const [stopNote, setStopNote] = useState<StopNote | null>(null);
  const [resuming, setResuming] = useState<Asking | null>(null);
  // The words of a failed Dismiss, with the ended tab they are about (they go when that tab does, see below).
  const [pageError, setPageError] = useState<{ id: string; text: string } | null>(null);
  // The desktop app's one-time note about notifications (K17), until "Got it" (kept in this browser; a webview that
  // refuses storage shows it again after a reload, which is harmless).
  const [notifyDismissed, setNotifyDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(NOTIFY_NOTE_KEY) === "1";
    } catch {
      return false;
    }
  });
  function dismissNotifyNote() {
    // The button removes itself, so the keys would fall to the page: give them to the terminal that is open, else to the
    // panel's title (the same fallback as when a session ends under you).
    if (terminalRef.current && selected && selected.status !== "exited") terminalRef.current.focus();
    else headingRef.current?.focus({ preventScroll: true });
    setNotifyDismissed(true);
    try {
      window.localStorage.setItem(NOTIFY_NOTE_KEY, "1");
    } catch {
      // A locked-down webview: the note stays hidden until the page reloads.
    }
  }
  const alive = useRef(true);
  const askedFor = useRef("");
  // The list the page held when it asked for a session the list did not know: a later list is the answer to that ask.
  const askedBody = useRef<unknown>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  // The panes' box, which the divider measures.
  const panesRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The open terminal's own focus(), the one its autoFocus uses.
  const terminalRef = useRef<SessionTerminalHandle>(null);
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
    askedBody.current = body;
    refresh();
  }, [wanted, body, sessions, refresh]);

  // The address names a tab that is not one: the list knows it but it is put away (dismissed here or in another window,
  // or not an agent session), or the list was read again after the page asked for it and still does not know it. The
  // page and the address then point at the tab shown, so the address stops naming a dead tab and split view settles on
  // the tabs there are. A tab being dismissed here keeps the address until the server says it is dismissed, so a failed
  // Dismiss puts the tab back as it was.
  useEffect(() => {
    if (!body || !wanted || wantedListed) return;
    const entry = sessions.find((session) => session.id === wanted);
    const settled = entry
      ? !hidden.has(wanted) || Boolean(entry.dismissed)
      : askedFor.current === wanted && askedBody.current !== null && askedBody.current !== body;
    if (!settled) return;
    setWanted(selectedId);
    // A keyboard hand-over that was still waiting (Enter on a pane, ⌘1-9, Resume) is dropped with the old address: once
    // the address names a tab that is open, the terminal would take the keys from wherever they went (sweep A item 7).
    setFocusTerminal(false);
    navigateTo("sessions", selectedId ? { session: selectedId } : {});
  }, [body, wanted, wantedListed, sessions, hidden, selectedId]);

  // A pane's terminal stays while that pane shows its session, also once the session has ended; a pane that shows
  // another session drops it, and an open session puts its own up (nextLiveShown).
  const shownPanes = paneSessions.map((session) => ({ key: terminalKey(session.id, gens), status: session.status }));
  const shownSignature = shownPanes.map((pane) => `${pane.key}=${pane.status}`).join(" ");
  useEffect(() => {
    setLiveShown((prev) => nextLiveShown(prev, shownPanes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSignature]);

  // Split view is stored once it is aligned (alignSplit answers with the very same object when nothing changes, so
  // this settles after one render), and kept in this window.
  useEffect(() => {
    if (aligned !== split) setSplit(aligned);
  }, [aligned, split]);
  useEffect(() => {
    if (!dragging) writeSplit(split);
  }, [split, dragging]);

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

  // A pointer press or the keyboard focus in a pane makes it the focused pane, and the side panel follows it (spec,
  // Split). The keyboard stays where the person put it.
  function focusPane(id: string) {
    if (id !== selectedId) select(id);
  }

  // The keyboard way into a pane (Enter or Space on its header, or on the selected tab in split view): an open terminal
  // keeps Tab for its agent, so this is how a keyboard-only person reaches either terminal. The pane that is not
  // focused becomes the focused pane and its terminal takes the keys when it is shown; the focused one takes them now.
  function enterPane(id: string) {
    if (id === selectedId) terminalRef.current?.focus();
    else select(id, true);
  }

  // The Split view button and ⌘\ (toggleSplit): off puts the selected tab on the left and the next open tab on the
  // right; on goes back to the focused pane alone. With one tab nothing happens (the button can't be pressed then).
  function toggleSplitView() {
    setSplit((current) => toggleSplit(current, tabsRef.current, selectedRef.current));
  }

  // ⌘T, ⌘1-9 and ⌘\ (Ctrl+Shift+T, Ctrl+Shift+1-9 and Ctrl+Shift+\ on Windows and Linux), in the desktop app only: a
  // browser keeps ⌘T and ⌘1-9 for itself (spec, App shortcuts), and split view has its button there. The terminal
  // lets these keys through to here.
  useEffect(() => {
    if (!desktop) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return;
      // A dialog or the palette has the keyboard: leave its keys alone.
      if (document.querySelector('[aria-modal="true"]')) return;
      // Events from inside a terminal are NOT skipped: the terminal (Task U2) lets ⌘T, ⌘1-9 and ⌘\ through to here
      // untouched. The palette key is the terminal's and the Shell's own business.
      const shortcut = isAppShortcut(event, { isMac: IS_MAC, desktop: true });
      if (!shortcut || shortcut.action === "palette") return;
      event.preventDefault();
      if (shortcut.action === "new-session") {
        openNewSession();
        return;
      }
      if (shortcut.action === "split") {
        toggleSplitView();
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
  // A sentence from the terminal itself, for example "Link copied. Open it in your browser." (ruling R25). It goes into the
  // shell's one toast slot, so it never sits on top of a message the shell is showing (sweep A item 6, U5 review M7).
  const onTerminalNotice = useCallback((text: string) => {
    if (alive.current && text) showShellToast(text);
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
  const notifyText = notifyNote({ desktop, isMac: IS_MAC, dismissed: notifyDismissed });
  const notifyLine = notifyText ? (
    <p className="os-sess__notice os-sess__notify">
      <Info size={15} aria-hidden="true" />
      <span>{notifyText}</span>
      <button type="button" className="os-btn os-btn--ghost os-sess__notify-ok" onClick={dismissNotifyNote}>
        Got it
      </button>
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

  // Empty in a browser tab, which keeps ⌘T and ⌘1-9 for itself (spec, Browser mode).
  const hints = shortcutHints({ isMac: IS_MAC, desktop });
  const stopCopy = stopping ? stopDialogCopy(stopping.session) : null;
  const resumeCopy = resuming ? resumeConfirmCopy(resuming.session) : null;
  // Only the focused pane's terminal may take the keyboard by itself, and only when the page asked for that.
  const takesKeys = terminalTakesKeys({ focusTerminal, wanted, selectedId, wantedListed });

  // One pane: in split view its own header (press it, or click anywhere in the pane, to see its details), then the
  // session's terminal, or the ended view, and the caption. A pane is keyed by its terminal key, so turning split view
  // on or off, or moving the focus, never reattaches a terminal that stays on screen.
  function renderPane(session: SessionSummary) {
    const paneKey = terminalKey(session.id, gens);
    const focused = session.id === selectedId;
    const paneTitle = sessionTitle(session);
    const showIt = session.status !== "exited" || liveShown.has(paneKey);
    return (
      <section
        key={paneKey}
        className={splitOn && focused ? "os-sess-pane is-focus" : "os-sess-pane"}
        aria-label={splitOn ? paneTitle : undefined}
        data-session={session.id}
        onFocusCapture={() => focusPane(session.id)}
        onPointerDown={() => focusPane(session.id)}
      >
        {splitOn ? (
          <SessionPaneHead session={session} focused={focused} onPick={() => focusPane(session.id)} onEnter={() => enterPane(session.id)} />
        ) : null}
        <SessionLimitBanner session={session} />
        {showIt ? (
          <div className="os-sess-term">
            <SessionTerminal
              ref={focused ? terminalRef : undefined}
              key={paneKey}
              sessionId={session.id}
              label={`${paneTitle} terminal`}
              kittyKeyboard={prefs.kittyKeyboard}
              webgl={prefs.webgl}
              ended={session.status === "exited"}
              autoFocus={focused && takesKeys}
              sizesItself={splitOn}
              onState={onTerminalState}
              onAlert={onTerminalState}
              onNotice={onTerminalNotice}
            />
          </div>
        ) : (
          <div className="os-sess-ended">
            <SquareTerminal size={22} aria-hidden="true" />
            <p className="os-sess-ended__title">This session has ended</p>
            <p className="os-sess-ended__body">{sessionPanelLine(session, Date.now())}</p>
          </div>
        )}
        <p className="os-sess__cap">
          <SquareTerminal size={15} aria-hidden="true" />
          {session.agentLabel}&apos;s own terminal program, with your own settings.
        </p>
      </section>
    );
  }

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
          alsoShownId={otherPaneId}
          onEnterSelected={splitOn ? enterPane : undefined}
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
        <span className="os-sess__vsep" aria-hidden="true" />
        <button
          type="button"
          className="os-btn os-btn--ghost os-sess-splitbtn"
          aria-label={SPLIT_LABEL}
          aria-pressed={splitOn}
          title={splitButtonHint({ isMac: IS_MAC, desktop, possible: splitOn || canSplit(tabs) })}
          disabled={!splitOn && !canSplit(tabs)}
          onClick={toggleSplitView}
        >
          <Columns2 size={16} aria-hidden="true" />
          <span className="os-sess-splitbtn__label">{SPLIT_LABEL}</span>
          {desktop ? <kbd className="os-kbd os-sess-splitbtn__kbd">{splitKeys(IS_MAC)}</kbd> : null}
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
          {notifyLine}
          <div
            ref={panesRef}
            className={splitOn ? "os-sess-panes os-sess-panes--split" : "os-sess-panes"}
            style={
              splitOn
                ? ({ "--os-split": `calc((100% - ${SPLIT_GAP_PX}px) * ${aligned.ratio})` } as CSSProperties)
                : undefined
            }
          >
            {/* The divider comes first in the page (CSS order puts it between the panes), so Tab from the tab strip reaches
                it before any terminal: an open terminal keeps Tab for its agent. */}
            {paneSessions.flatMap((session, slot) =>
              splitOn && slot === 0
                ? [
                    <SplitDivider
                      key="split-divider"
                      ratio={aligned.ratio}
                      containerRef={panesRef}
                      onRatio={(ratio) => setSplit((current) => withRatio(current, ratio))}
                      onDragChange={setDragging}
                    />,
                    renderPane(session)
                  ]
                : [renderPane(session)]
            )}
          </div>
        </div>
        <SessionSidePanel
          session={selected}
          note={panelStopNote(selected, key, stopNote)}
          hints={hints}
          headingRef={headingRef}
          onStop={() => setStopping({ session: selected, busy: false, error: "", toSafety: false })}
          onResume={() => setResuming({ session: selected, busy: false, error: "", toSafety: false })}
          onOpenRecording={() => navigateTo("runs", { tab: "recordings", highlight: selected.id })}
          onOpenSession={(id) => {
            refresh();
            select(id, true);
          }}
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
    </section>
  );
}
