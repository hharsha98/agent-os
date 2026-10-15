// The browser terminal's pure rules (spec "Browser terminal"): the Cobalt colours read from the tokens, the
// modes a reattach puts back, which links may open, the OSC 52 rule and the reconnect pace. `import type`
// only, so test/terminal-shared.test.js loads this file straight from src/ (decision P14).
import type { ITheme } from "@xterm/xterm";
import type { SessionModes } from "../types";
import type { SessionCloseAdvice } from "./sessionsShared";

// JetBrains Mono at 13 px (spec), rows a little apart like the prototype's 13/20 terminal.
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.2;
export const TERMINAL_SCROLLBACK = 5000;

type ThemeKey = Exclude<keyof ITheme, "extendedAnsi">;

// Which token gives which part of the xterm theme (tokens.css, "Terminal ground and the 16 ANSI colours").
export const THEME_TOKENS: ReadonlyArray<readonly [ThemeKey, string]> = [
  ["background", "--os-term-bg"],
  ["foreground", "--os-term-fg"],
  ["cursor", "--os-term-cursor"],
  ["cursorAccent", "--os-term-bg"],
  ["selectionBackground", "--os-term-select"],
  ["black", "--os-ansi-0"],
  ["red", "--os-ansi-1"],
  ["green", "--os-ansi-2"],
  ["yellow", "--os-ansi-3"],
  ["blue", "--os-ansi-4"],
  ["magenta", "--os-ansi-5"],
  ["cyan", "--os-ansi-6"],
  ["white", "--os-ansi-7"],
  ["brightBlack", "--os-ansi-8"],
  ["brightRed", "--os-ansi-9"],
  ["brightGreen", "--os-ansi-10"],
  ["brightYellow", "--os-ansi-11"],
  ["brightBlue", "--os-ansi-12"],
  ["brightMagenta", "--os-ansi-13"],
  ["brightCyan", "--os-ansi-14"],
  ["brightWhite", "--os-ansi-15"]
];

// The Cobalt terminal theme (Q17). `read` returns a token's value (getComputedStyle in the page). A token
// that reads empty is left out, so xterm keeps its own colour rather than an empty one.
export function terminalTheme(read: (token: string) => string): ITheme {
  const theme: ITheme = {};
  for (const [key, token] of THEME_TOKENS) {
    const value = (read(token) || "").trim();
    if (value) theme[key] = value;
  }
  return theme;
}

export function sameTheme(a: ITheme, b: ITheme): boolean {
  return THEME_TOKENS.every(([key]) => a[key] === b[key]);
}

const TRACKING: Record<SessionModes["mouseTracking"], string> = {
  none: "",
  x10: "\x1b[?9h",
  vt200: "\x1b[?1000h",
  drag: "\x1b[?1002h",
  any: "\x1b[?1003h"
};
const ENCODING: Record<SessionModes["mouseEncoding"], string> = {
  default: "",
  sgr: "\x1b[?1006h",
  "sgr-pixels": "\x1b[?1016h"
};

// The modes a reattach writes into this window's terminal after the snapshot (spec: the mirror "tracks the
// modes the serializer omits … and re-sends them on reattach"). Setting a mode the snapshot already set does
// nothing, except the alternate screen: switching to it again would clear it, so that one is written only
// when the snapshot left the normal screen active. Kitty flags (CSI = flags ; 1 u, "set all") only while the
// kitty keyboard setting is on.
export function modeRestoreSequence(modes: SessionModes, { altActive, kitty }: { altActive: boolean; kitty: boolean }): string {
  let out = "";
  if (modes.altScreen && !altActive) out += "\x1b[?1049h";
  if (modes.cursorKeysApp) out += "\x1b[?1h";
  if (modes.bracketedPaste) out += "\x1b[?2004h";
  if (modes.focusReporting) out += "\x1b[?1004h";
  out += TRACKING[modes.mouseTracking] ?? "";
  out += ENCODING[modes.mouseEncoding] ?? "";
  if (kitty && Number.isInteger(modes.kittyFlags) && modes.kittyFlags > 0) out += `\x1b[=${modes.kittyFlags};1u`;
  return out;
}

const LINK_SCHEMES = new Set(["http:", "https:"]);

// Only web links ever open from a terminal (decision Q45: `mailto:` text is not made a link).
export function linkAllowed(uri: string): boolean {
  try {
    return LINK_SCHEMES.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

// OSC 52 "<selection>;?" asks the terminal for the clipboard. Reading is refused (spec); writing is allowed.
export function isOsc52Read(data: string): boolean {
  const parts = data.split(";");
  return parts.length >= 2 && parts[1] === "?";
}

export function isAsciiOnly(data: string): boolean {
  return /^[\x00-\x7f]*$/.test(data);
}

// How many tries in a row a window makes before it says the connection is lost and offers Reconnect (Q40).
export const RECONNECT_ATTEMPTS = 5;

const RECONNECT_STEPS_MS = [500, 1000, 2000, 5000];
const WAIT_ADVICE_MS = 5000;

// How long to wait before the next try, after `attempt` failed tries in a row (0 before the first one):
// 0.5, 1, 2, 5 and 5 s (Q40). After the "wait" advice (attach_failed, or a message over 1 MB) the pace starts
// at 5 s instead.
export function reconnectDelay(attempt: number, advice?: SessionCloseAdvice): number {
  const step = Math.min(Math.max(0, Math.floor(attempt) || 0), RECONNECT_STEPS_MS.length - 1);
  const delay = RECONNECT_STEPS_MS[step];
  return advice === "wait" ? Math.max(delay, WAIT_ADVICE_MS) : delay;
}

// Typed text that could not be sent (the socket is connecting or closed) is never queued or replayed: a
// replay could land in a different prompt than the one it was typed for. The person is told once per
// disconnect instead, so a held-down key does not pile up notices (ledger, Task U2 ruling).
export const INPUT_NOT_SENT_NOTICE = "That wasn't sent: the terminal is reconnecting. Type it again when it's back.";

// What the terminal sends by itself, without the person typing, once a program has asked for it: focus in and
// out (mode 1004: ESC [ I and ESC [ O) and mouse reports for clicks, motion and the wheel (the X10 form, ESC [ M
// and three characters, which xterm hands over as a "binary" event; the SGR form ESC [ < button ; x ; y, then M
// or m; and its pixel twin, which has the same shape). When the connection is down these are dropped without the
// sentence above: the sentence is for typed or pasted text, and a click, a mouse move or the terminal losing
// focus (the Reconnect button takes it) must not use up the once-per-disconnect notice. Whole-chunk matches
// only: xterm sends each report as its own chunk, and typed text that merely starts like one is still text.
const FOCUS_REPORT = /^\x1b\[[IO]$/;
const MOUSE_REPORT = /^\x1b\[(?:M[\s\S]{3}|<\d+;\d+;\d+[Mm])$/;

export function isAutomaticReport(data: string): boolean {
  return FOCUS_REPORT.test(data) || MOUSE_REPORT.test(data);
}

// Whether the sentence above may be said right now. It is true only while a try is running or about to run:
// "reconnecting", or "open" (a socket that dropped just before its close arrived). It is never said in
// "connecting" (this window has never been connected, so nothing is "reconnecting"), never in "lost" (nothing
// retries until the person presses Reconnect, and the corner already says so) and never for "ended". And it is
// only about text typed here: `typing` is true while this terminal's own text box has the focus, so a window
// the person never typed in (a viewer) stays silent when its terminal answers a program's query.
export function unsentNoticeApplies(connection: string | null, typing: boolean): boolean {
  return typing && (connection === "reconnecting" || connection === "open");
}

// Tab and Shift+Tab: xterm swallows them and sends them to the agent. That is right only while the terminal is
// open. Otherwise nothing is listening, so the key goes back to the browser to move the focus as usual (a
// keyboard-only person must be able to leave the box and reach "Reconnect"). Any other modifier is the agent's.
export function tabLeavesTerminal(
  connection: string | null,
  event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }
): boolean {
  return event.key === "Tab" && connection !== "open" && !event.ctrlKey && !event.altKey && !event.metaKey;
}

export interface UnsentNotice {
  // `sent` is what the socket's input() answered. True when the person should be told now: the first input
  // that was not sent since the last snapshot. Input that was sent never starts or ends a round.
  report(sent: boolean): boolean;
  // The next snapshot arrived: the next disconnect is told again.
  reset(): void;
}

export function createUnsentNotice(): UnsentNotice {
  let told = false;
  return {
    report(sent: boolean): boolean {
      if (sent || told) return false;
      told = true;
      return true;
    },
    reset(): void {
      told = false;
    }
  };
}
