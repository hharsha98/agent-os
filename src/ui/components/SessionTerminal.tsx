// One session's real terminal (spec "Browser terminal"): xterm.js 6.1 shows what the agent's own program
// draws, and the person's keys go straight to it. The server keeps the session; this view only attaches
// (the snapshot first, then live output) and can be closed and opened again at any time (spec "Persistence").
// Only Agent OS's own shortcuts are kept from the agent (⌘K, ⌘T, ⌘1-9 on a Mac; Ctrl+Shift+K/T/1-9 elsewhere;
// isAppShortcut in sessionsShared.ts). The palette key is handled here; ⌘T and ⌘1-9 bubble on to the Sessions
// page's own key handler. Every other key, Ctrl+K and Ctrl+R included, reaches the agent.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import type { IClipboardProvider } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "../terminal.css";
import { openSessionSocket } from "../../sessionsApi";
import type { SessionSocket } from "../../sessionsApi";
import type { SessionSnapshot, SessionStateFrame } from "../../types";
import { isDesktopApp } from "../desktop";
import { togglePalette } from "../palette";
import { isAppShortcut, isMacPlatform, MAX_COLS, MAX_ROWS } from "../sessionsShared";
import {
  createUnsentNotice,
  INPUT_NOT_SENT_NOTICE,
  isAsciiOnly,
  isAutomaticReport,
  isOsc52Read,
  linkAllowed,
  RECONNECT_ATTEMPTS,
  reconnectDelay,
  restoreScreen,
  sameTheme,
  tabLeavesTerminal,
  terminalTheme,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK,
  unsentNoticeApplies,
  writeParsed
} from "../terminalShared";

const IS_MAC = isMacPlatform(typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "");
// The terminal measures its letters when it opens, so it waits (this long at most) for JetBrains Mono.
const FONT_WAIT_MS = 1500;

// The terminal's own words (planning decisions Q40 and Q45, "Terminal notices"). `linkNotCopied` is for the
// rare window that refuses the copy too. `inputNotSent` goes to the page only (as a toast), like the link words.
const WORDS = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  lost: "Lost the connection to this session.",
  reconnect: "Reconnect",
  linkCopied: "Link copied. Open it in your browser.",
  linkNotCopied: "Agent OS couldn't open or copy that link.",
  inputNotSent: INPUT_NOT_SENT_NOTICE
} as const;

export type TerminalConnection = "connecting" | "open" | "reconnecting" | "lost" | "ended";

export interface SessionTerminalProps {
  sessionId: string;
  // The terminal's accessible name, for example "Claude Code · my-app terminal".
  label: string;
  // The two browser-only settings; the page keeps them and their defaults (spec: they stay in the browser).
  kittyKeyboard: boolean;
  webgl: boolean;
  // Take the keys (become the writer) once the screen is restored, and whenever it is shown again.
  autoFocus?: boolean;
  // false while its tab is hidden: it does not fit or take the keys then. Default true.
  active?: boolean;
  // The page's latest session list says this session has ended: never attach again. The server refuses an
  // ended session's attach with a bare 403, which reaches onClose as 1006 with no reason, so only the page
  // can tell a refused try from a dropped connection (planning decision Q40).
  ended?: boolean;
  onState?: (state: SessionStateFrame) => void;
  // SP3 forwards the raw OSC 9 / 99 / 777 payload, or "bel"; SP4 turns them into alerts.
  onAlert?: (raw: string) => void;
  onConnection?: (connection: TerminalConnection) => void;
  // A sentence for the page to show (a link copied instead of opened: "Link copied. Open it in your browser.",
  // or typed text that was not sent while the terminal was reconnecting).
  onNotice?: (text: string) => void;
}

export interface SessionTerminalHandle {
  focus(): void;
  findNext(text: string): boolean;
  findPrevious(text: string): boolean;
  clearSearch(): void;
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

async function waitForFont(family: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.race([
    document.fonts.load(`${TERMINAL_FONT_SIZE}px ${family}`).then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => window.setTimeout(resolve, FONT_WAIT_MS))
  ]);
}

// Links open in the person's browser: a new tab in browser mode; in the desktop app through the opener, which
// only opens the addresses Agent OS lists (desktop/src-tauri/capabilities/default.json, the scope the owner
// approved). An address outside that list is refused by the opener, so it is copied instead, and the page is
// handed the sentence that says so (decision Q45). Only http and https ever open.
async function openLink(uri: string, say: (text: string) => void): Promise<void> {
  if (!linkAllowed(uri)) return;
  if (!isDesktopApp()) {
    window.open(uri, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(new URL(uri).href);
  } catch {
    try {
      await navigator.clipboard.writeText(uri);
      say(WORDS.linkCopied);
    } catch {
      say(WORDS.linkNotCopied);
    }
  }
}

// OSC 52: a program may put text on the clipboard; reading it is refused (spec). Read requests never get
// this far: the guard registered after the addon swallows them first (see below).
const CLIPBOARD: IClipboardProvider = {
  readText: () => "",
  async writeText(_selection: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The window would not allow it: nothing is copied.
    }
  }
};

const SessionTerminal = forwardRef<SessionTerminalHandle, SessionTerminalProps>(function SessionTerminal(props, ref) {
  const { sessionId, label, kittyKeyboard, webgl, autoFocus = false, active = true, ended = false } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  // The Reconnect button, so a person at the keyboard is moved onto it when the connection is lost.
  const reconnectRef = useRef<HTMLButtonElement>(null);
  const rendererRef = useRef<((wantWebgl: boolean) => void) | null>(null);
  // Set while the terminal is mounted: the Reconnect button, and the page saying the session has ended.
  const actionsRef = useRef<{ reconnect(): void; pageSaysEnded(): void } | null>(null);
  // The newest props, for callbacks that live as long as the terminal (a new callback never reconnects).
  const latest = useRef(props);
  latest.current = props;
  const [connection, setConnection] = useState<TerminalConnection>("connecting");

  useImperativeHandle(
    ref,
    () => ({
      focus: () => termRef.current?.focus(),
      findNext: (text: string) => searchRef.current?.findNext(text) ?? false,
      findPrevious: (text: string) => searchRef.current?.findPrevious(text) ?? false,
      clearSearch: () => searchRef.current?.clearDecorations()
    }),
    []
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let term: Terminal | null = null;
    let socket: SessionSocket | null = null;
    // The session has ended (an exited state frame, a session_ended close, or the page's `ended`): this
    // window keeps its last screen and never attaches again.
    let sessionEnded = false;
    // Tries in a row that ended without a screen, since the last snapshot (Q40: at most RECONNECT_ATTEMPTS).
    let attempts = 0;
    let firstTry = true;
    let shown: TerminalConnection | null = null;
    let retryTimer: number | null = null;
    let frame = 0;
    let webglAddon: WebglAddon | null = null;
    const cleanups: Array<() => void> = [];
    // Typed text is never queued or replayed (a replay could land in another prompt); when it cannot be sent
    // the person is told once per disconnect, and the next snapshot starts a new round.
    const unsentNotice = createUnsentNotice();
    // Per socket: this window has sent {t:"focus"} on the current socket, so it is (or is about to be) the
    // writer. Until then the server drops its keys without a word, so they are not sent and count as unsent.
    let hasKeys = false;

    // The page's callbacks may throw; that must never stop the tries (U1 guards onState and onAlert the same way).
    const report = (next: TerminalConnection) => {
      if (disposed || shown === next) return;
      shown = next;
      setConnection(next);
      try {
        latest.current.onConnection?.(next);
      } catch {
        // The page's callback failed; the terminal carries on.
      }
    };
    // The page shows these sentences (the Sessions page as a toast), so the terminal never shows them twice.
    const say = (text: string) => {
      if (disposed) return;
      try {
        latest.current.onNotice?.(text);
      } catch {
        // The page's callback failed; the terminal carries on.
      }
    };
    // This window takes the keys on its current socket: it becomes the writer and its size follows.
    const takeKeys = () => {
      if (!socket) return;
      hasKeys = true;
      socket.focus();
    };
    const cancelRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const finish = () => {
      cancelRetry();
      sessionEnded = true;
      report("ended");
    };
    // Keys, paste and the terminal's own replies all go through here. No socket (between tries), a socket that
    // is not open, and a socket this window has not yet taken the keys on all count as not sent. The person is
    // told (once per disconnect, by unsentNotice) only when the sentence is true and about something they typed
    // here: unsentNoticeApplies (reconnecting or open, with this terminal's text box focused AND this page
    // having the focus: a background window whose box merely still holds the focus inside its page is not where
    // they are typing, and its terminal's automatic query replies must not be announced), not for an ended
    // session (nothing to reconnect to), and not for a focus or mouse report (they typed nothing; a report is
    // still sent whenever the socket is open). `automatic` is true for the X10 mouse form, which arrives by
    // onBinary.
    const sendInput = (data: string, automatic: boolean = isAutomaticReport(data)) => {
      const sent = socket !== null && (automatic || hasKeys) ? socket.input(data) : false;
      if (automatic || sessionEnded) return;
      const typing = document.hasFocus() && document.activeElement === term?.textarea;
      if (unsentNoticeApplies(shown, typing) && unsentNotice.report(sent)) say(WORDS.inputNotSent);
    };

    void (async () => {
      const fontFamily = readToken("--os-font-mono").trim() || "monospace";
      await waitForFont(fontFamily);
      if (disposed) return;

      const options: ITerminalOptions = {
        allowProposedApi: true,
        fontFamily,
        fontSize: TERMINAL_FONT_SIZE,
        lineHeight: TERMINAL_LINE_HEIGHT,
        scrollback: TERMINAL_SCROLLBACK,
        scrollOnEraseInDisplay: true,
        theme: terminalTheme(readToken),
        vtExtensions: { kittyKeyboard: latest.current.kittyKeyboard },
        // OSC 8 links: only http and https are shown as links (xterm's own rule while allowNonHttpProtocols
        // is false), and openLink checks the scheme again. An OSC 8 link hides its target behind its text, so
        // while the pointer is on one, the real address is the terminal box's tooltip (title).
        linkHandler: {
          activate: (_event, uri) => void openLink(uri, say),
          hover: (_event, uri) => {
            if (linkAllowed(uri)) host.title = uri;
          },
          leave: () => host.removeAttribute("title"),
          allowNonHttpProtocols: false
        }
      };
      const t = new Terminal(options);
      term = t;
      termRef.current = t;

      const fit = new FitAddon();
      const search = new SearchAddon();
      t.loadAddon(fit);
      t.loadAddon(search);
      t.loadAddon(new Unicode11Addon());
      t.unicode.activeVersion = "11";
      // Plain-text links: the addon's own pattern needs "//" after the scheme, so `mailto:` text is never a
      // link (Q45); openLink lets only http and https through.
      t.loadAddon(new WebLinksAddon((_event, uri) => void openLink(uri, say)));
      t.loadAddon(new ClipboardAddon(undefined, CLIPBOARD));
      // Registered after the clipboard addon, so xterm asks it first ("The most recently added handler is
      // tried first", xterm.d.ts registerOscHandler): a READ request is answered with nothing at all, and a
      // write goes on to the addon.
      t.parser.registerOscHandler(52, (data) => isOsc52Read(data));
      searchRef.current = search;

      // Agent OS's own shortcuts never reach the agent; everything else does (spec, App shortcuts). xterm calls
      // this for keydown, keypress and keyup, and returning false keeps the key from the agent. The palette
      // key is handled here (the Shell ignores keys typed in a terminal). ⌘T and ⌘1-9 are left untouched (not
      // prevented, not stopped), so they bubble on to the Sessions page's window handler. There is no
      // Ctrl+Shift+C/V in SP3 (Q45): the spec's key list sends every other key to the agent. The one other
      // exception: while the terminal is not open, Tab and Shift+Tab are left to the browser, so the focus
      // can leave the box (xterm would swallow them) and a keyboard-only person can reach Reconnect.
      t.attachCustomKeyEventHandler((event) => {
        if (tabLeavesTerminal(shown, event)) return false;
        const shortcut = isAppShortcut(event, { isMac: IS_MAC, desktop: isDesktopApp() });
        if (!shortcut) return true;
        if (event.type === "keydown" && shortcut.action === "palette") {
          event.preventDefault();
          togglePalette();
        }
        return false;
      });

      t.onData((data) => sendInput(data));
      // Only the X10 mouse form produces bytes above 127, which the text protocol cannot carry unchanged:
      // those few reports are dropped rather than sent wrong. It is a mouse report, never typed text, so it
      // never starts the "That wasn't sent" sentence.
      t.onBinary((data) => {
        if (isAsciiOnly(data)) sendInput(data, true);
      });

      t.open(host);

      // Taking the keys makes this window the writer for its session ({t:"focus"}, then its size). This listens
      // in the capture phase on the host, so it runs before xterm's own listener on its text box: the server hears
      // {t:"focus"} before the focus-in report (ESC [ I) that listener sends to a program using focus reporting,
      // and so the report is not dropped as coming from a window that is not yet the writer.
      const onFocus = (event: FocusEvent) => {
        if (event.target === t.textarea) takeKeys();
      };
      host.addEventListener("focus", onFocus, true);
      cleanups.push(() => host.removeEventListener("focus", onFocus, true));
      // A window brought back to the front takes the keys when this box still has the focus, even where the
      // webview does not fire the box's own focus event again.
      const onWindowFocus = () => {
        if (document.activeElement === t.textarea) takeKeys();
      };
      window.addEventListener("focus", onWindowFocus);
      cleanups.push(() => window.removeEventListener("focus", onWindowFocus));

      // True while a reattach is drawing: a fit then waits, and the reattach fits once at its end, so no resize
      // lands between a queued restore write and its callback. Reattaches never overlap: the next socket opens only
      // after this one's close, which waits for its restore.
      let restoring = false;
      const fitNow = () => {
        frame = 0;
        if (restoring) return;
        if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        // A box larger than the protocol allows (an ultra-wide or very tall monitor): keep the screen at the
        // limit, so the size sent below is the size drawn (the socket refuses a size over the limit).
        if (t.cols > MAX_COLS || t.rows > MAX_ROWS) t.resize(Math.min(t.cols, MAX_COLS), Math.min(t.rows, MAX_ROWS));
        socket?.resize(t.cols, t.rows);
      };
      fitRef.current = () => {
        if (!frame) frame = window.requestAnimationFrame(fitNow);
      };
      const sizeWatch = new ResizeObserver(() => fitRef.current?.());
      sizeWatch.observe(host);
      cleanups.push(() => {
        sizeWatch.disconnect();
        if (frame) window.cancelAnimationFrame(frame);
        fitRef.current = null;
      });

      // Q17: read the tokens again when the page's theme could have changed.
      let theme: ITheme = options.theme ?? {};
      const themeWatch = new MutationObserver(() => {
        const next = terminalTheme(readToken);
        if (!sameTheme(next, theme)) {
          theme = next;
          t.options.theme = next;
        }
      });
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
      cleanups.push(() => themeWatch.disconnect());

      // The renderer: the page's setting decides (its default follows Q45); back to the DOM renderer if the
      // WebGL context is lost (it stays there until the setting is switched off and on).
      rendererRef.current = (wantWebgl: boolean) => {
        if (wantWebgl && !webglAddon) {
          try {
            const addon = new WebglAddon();
            addon.onContextLoss(() => {
              addon.dispose();
              if (webglAddon === addon) webglAddon = null;
            });
            t.loadAddon(addon);
            webglAddon = addon;
          } catch {
            // No WebGL here: the DOM renderer stays.
            webglAddon = null;
          }
        } else if (!wantWebgl && webglAddon) {
          webglAddon.dispose();
          webglAddon = null;
        }
      };
      rendererRef.current(latest.current.webgl);

      // Reattach (spec "Persistence"): the reset, the snapshot at the size it was taken and the modes it does not
      // carry (restoreScreen in terminalShared.ts), then this window's own size (D-U2-7). Never resize or fit
      // inside a write callback (here, in onOut, or anywhere else); restoreScreen says why.
      const restore = async (snapshot: SessionSnapshot) => {
        restoring = true;
        try {
          await restoreScreen(t, snapshot);
        } finally {
          restoring = false;
        }
        fitNow();
      };

      const connect = () => {
        if (disposed || sessionEnded) return;
        // The page's session list says the session has ended: the server would refuse the attach (Q40).
        if (latest.current.ended === true) {
          finish();
          return;
        }
        report(firstTry ? "connecting" : "reconnecting");
        firstTry = false;
        hasKeys = false;
        socket = openSessionSocket(sessionId, {
          onSnapshot: async (snapshot) => {
            if (disposed) return;
            attempts = 0;
            // A snapshot is back: the next disconnect tells the person again.
            unsentNotice.reset();
            await restore(snapshot);
            if (disposed) return;
            report("open");
            // Take the keys back after a reattach, or take them now when asked to. Only a window that really has
            // the focus takes them back: a background window whose box merely still holds the focus inside its
            // page must not take the writer role from the window the person is typing in. (Asked to take them
            // now, the box's own focus event does it, once this window has the focus; the window's focus event
            // above covers a window that gets the focus later.)
            if (document.activeElement === t.textarea) {
              if (document.hasFocus()) takeKeys();
            } else if (latest.current.active !== false && latest.current.autoFocus) t.focus();
          },
          onOut: (data) => (disposed ? Promise.resolve() : writeParsed(t, data)),
          onState: (state) => {
            if (state.status === "exited") sessionEnded = true;
            latest.current.onState?.(state);
          },
          onAlert: (raw) => latest.current.onAlert?.(raw),
          onClose: (info) => {
            socket = null;
            hasKeys = false;
            if (disposed) return;
            // An ended session has nothing to attach to: keep its last screen (an exited state frame, the
            // session_ended close, or the page's list saying so).
            if (sessionEnded || info.advice === "ended" || latest.current.ended === true) {
              finish();
              return;
            }
            // Too far behind: attach again at once for a fresh snapshot (spec, Back-pressure).
            if (info.reason === "too_far_behind") {
              attempts = 0;
              connect();
              return;
            }
            // A refused attach, a dropped connection (1006), Agent OS restarting or attach_failed: try again
            // at a slowing pace while the page still says the session is live, then stop and offer Reconnect.
            if (attempts >= RECONNECT_ATTEMPTS) {
              report("lost");
              return;
            }
            const wait = reconnectDelay(attempts, info.advice);
            attempts += 1;
            report("reconnecting");
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              connect();
            }, wait);
          }
        });
      };

      actionsRef.current = {
        // "Reconnect" after the last try: a fresh round of tries, and the keys go back to this terminal.
        reconnect: () => {
          if (disposed || socket || sessionEnded) return;
          cancelRetry();
          attempts = 0;
          connect();
          if (!sessionEnded) t.focus();
        },
        // The page's list now says the session has ended. An open socket hears it from the server itself
        // (the exited state frame, then the session_ended close); between tries, stop trying now.
        pageSaysEnded: () => {
          if (disposed || socket) return;
          finish();
        }
      };
      connect();
    })();

    return () => {
      disposed = true;
      cancelRetry();
      socket?.close();
      socket = null;
      for (const cleanup of cleanups) cleanup();
      actionsRef.current = null;
      rendererRef.current = null;
      searchRef.current = null;
      termRef.current = null;
      term?.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.vtExtensions = { kittyKeyboard };
  }, [kittyKeyboard]);

  useEffect(() => {
    rendererRef.current?.(webgl);
  }, [webgl]);

  useEffect(() => {
    if (ended) actionsRef.current?.pageSaysEnded();
  }, [ended]);

  // Shown again (its tab selected): fit the box, and take the keys when asked to.
  useEffect(() => {
    if (!active) return;
    fitRef.current?.();
    if (autoFocus) termRef.current?.focus();
  }, [active, autoFocus]);

  // Lost: nothing retries until the person presses Reconnect. If they are typing in the box, xterm would keep
  // the focus (and the keys), so the focus moves onto the button, where Tab, Enter and Space work as usual.
  // Pressing it gives the keys back to the terminal (D-U2-12).
  useEffect(() => {
    if (connection !== "lost") return;
    const t = termRef.current;
    if (t && document.activeElement === t.textarea) reconnectRef.current?.focus();
  }, [connection]);

  const lost = connection === "lost";
  const notice =
    connection === "connecting" ? WORDS.connecting : connection === "reconnecting" ? WORDS.reconnecting : lost ? WORDS.lost : null;

  // The status line is always in the page (empty when there is nothing to say) and only its text changes, so a
  // screen reader announces the change; a status region that arrives already holding its text is often missed.
  // The pill around it is drawn only while there is something to say. The button is outside the status line.
  return (
    <div className="os-term" role="group" aria-label={label} data-connection={connection}>
      <div className="os-term__screen" ref={hostRef} />
      <div className={notice ? (lost ? "os-term__notice os-term__notice--lost" : "os-term__notice") : "os-term__notice os-term__notice--empty"}>
        <p className="os-term__notice-text" role="status">
          {notice ?? ""}
        </p>
        {lost ? (
          <button type="button" className="os-btn os-btn--secondary" ref={reconnectRef} onClick={() => actionsRef.current?.reconnect()}>
            {WORDS.reconnect}
          </button>
        ) : null}
      </div>
    </div>
  );
});

export default SessionTerminal;
