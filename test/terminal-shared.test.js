// The browser terminal's pure rules (src/ui/terminalShared.ts): the Cobalt theme from the tokens and its
// contrast (planning decision Q17), the modes a reattach puts back, which links may open (Q45), OSC 52 and the
// reconnect pace (Q40). Node strips the types itself (decision P14), so the .ts file is imported directly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import xtermHeadless from "@xterm/headless";
import * as term from "../src/ui/terminalShared.ts";

// @xterm/headless is a CommonJS bundle: its classes sit on the default export.
const { Terminal: HeadlessTerminal } = xtermHeadless;
const TOKENS = readFileSync(new URL("../src/ui/tokens.css", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TIMED_OUT = Symbol("timed out");
// The promise's value, or TIMED_OUT when it has not settled after `ms` (a hang fails the test instead of stalling it).
function within(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => TIMED_OUT)]);
}

// Every innermost CSS block, with its custom properties (a block inside @media is found too).
function blocks(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const vars = {};
    for (const decl of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[decl[1]] = decl[2].trim();
    out.push({ selector: match[1].trim(), vars });
  }
  return out;
}
function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `${hex} is a #rrggbb colour`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}
// WCAG 2 relative luminance and contrast ratio.
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const ALL_OFF = { altScreen: false, bracketedPaste: false, mouseTracking: "none", mouseEncoding: "default", focusReporting: false, cursorKeysApp: false, kittyFlags: 0 };

test("all 16 ANSI colours and the terminal ink pass 4.5:1 on the terminal ground, in every theme that sets them (Q17)", () => {
  const all = blocks(TOKENS);
  const root = all.find((b) => b.selector === ":root" && b.vars["--os-term-bg"]);
  assert.ok(root, ":root sets --os-term-bg");
  const themes = all.filter((b) => Object.keys(b.vars).some((k) => k.startsWith("--os-term-") || k.startsWith("--os-ansi-")));
  assert.ok(themes.length >= 1);
  for (const theme of themes) {
    const value = (name) => theme.vars[name] ?? root.vars[name];
    const ground = value("--os-term-bg");
    for (const name of ["--os-term-fg", ...Array.from({ length: 16 }, (_, i) => `--os-ansi-${i}`)]) {
      const ratio = contrast(value(name), ground);
      assert.ok(ratio >= 4.5, `${theme.selector} ${name} ${value(name)} on ${ground} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the xterm theme takes every colour from the tokens (Q17)", () => {
  const named = term.terminalTheme((token) => token);
  assert.equal(named.background, "--os-term-bg");
  assert.equal(named.foreground, "--os-term-fg");
  assert.equal(named.cursor, "--os-term-cursor");
  assert.equal(named.cursorAccent, "--os-term-bg", "the letter under a block cursor is drawn in the ground colour");
  assert.equal(named.selectionBackground, "--os-term-select");
  const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  ansi.forEach((key, i) => assert.equal(named[key], `--os-ansi-${i}`, key));
  assert.deepEqual(term.terminalTheme(() => "   "), {}, "an empty token leaves xterm's own colour, never an empty string");
  const root = blocks(TOKENS).find((b) => b.selector === ":root" && b.vars["--os-term-bg"]).vars;
  const real = term.terminalTheme((token) => ` ${root[token] ?? ""} `);
  assert.equal(real.background, "#090b0f");
  assert.equal(real.black, "#6f798e");
  assert.equal(real.selectionBackground, "rgba(56, 102, 238, 0.4)", "values are trimmed");
  assert.equal(term.sameTheme(real, { ...real }), true);
  assert.equal(term.sameTheme(real, { ...real, red: "#ff0000" }), false);
});

test("a reattach puts back the modes the snapshot does not carry, in a fixed order", () => {
  assert.equal(term.modeRestoreSequence(ALL_OFF, { altActive: false, kitty: true }), "");
  const all = { altScreen: true, bracketedPaste: true, mouseTracking: "any", mouseEncoding: "sgr", focusReporting: true, cursorKeysApp: true, kittyFlags: 1 };
  assert.equal(term.modeRestoreSequence(all, { altActive: false, kitty: true }), "\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1004h\x1b[?1003h\x1b[?1006h\x1b[=1;1u");
  assert.equal(
    term.modeRestoreSequence(all, { altActive: true, kitty: true }),
    "\x1b[?1h\x1b[?2004h\x1b[?1004h\x1b[?1003h\x1b[?1006h\x1b[=1;1u",
    "already on the alternate screen: not switched again (that would clear it)"
  );
  assert.equal(
    term.modeRestoreSequence(all, { altActive: true, kitty: false }),
    "\x1b[?1h\x1b[?2004h\x1b[?1004h\x1b[?1003h\x1b[?1006h",
    "kitty flags only while the kitty keyboard setting is on"
  );
  const track = (mouseTracking) => term.modeRestoreSequence({ ...ALL_OFF, mouseTracking }, { altActive: false, kitty: true });
  assert.deepEqual(["x10", "vt200", "drag", "any"].map(track), ["\x1b[?9h", "\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h"]);
  const encode = (mouseEncoding) => term.modeRestoreSequence({ ...ALL_OFF, mouseEncoding }, { altActive: false, kitty: true });
  assert.deepEqual(["sgr", "sgr-pixels"].map(encode), ["\x1b[?1006h", "\x1b[?1016h"]);
  assert.equal(term.modeRestoreSequence({ ...ALL_OFF, kittyFlags: 31 }, { altActive: false, kitty: true }), "\x1b[=31;1u");
});

// The page's terminal with its fit landing in every gap. The Sessions page's first fit runs in an animation frame
// its ResizeObserver asks for when the terminal opens, and that frame can come after a write is queued and before
// xterm's own 0 ms timer reads it. A microtask always lands in that gap. The headless terminal shares the browser
// terminal's write queue (the same xterm.js commit, decision Q42).
function fitInEveryGap(t, cols, rows) {
  return {
    write(data, callback) {
      t.write(data, callback);
      queueMicrotask(() => t.resize(cols, rows));
    },
    resize: (c, r) => t.resize(c, r),
    get buffer() {
      return t.buffer;
    },
    get options() {
      return t.options;
    }
  };
}
function screenLines(t) {
  const buffer = t.buffer.active;
  const lines = [];
  for (let y = 0; y < t.rows; y += 1) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
  return lines;
}

test("xterm 6.1 forgets an empty write's callback when resize() runs before xterm reads it (why writeParsed never writes one)", async () => {
  const t = new HeadlessTerminal({ cols: 120, rows: 32, logLevel: "off" });
  try {
    let emptyDone = false;
    let textDone = false;
    t.write("", () => {
      emptyDone = true;
    });
    t.resize(101, 37);
    t.write("text", () => {
      textDone = true;
    });
    t.resize(100, 30);
    await sleep(50);
    assert.equal(textDone, true, "a write with text keeps its callback");
    assert.equal(emptyDone, false, "xterm now keeps an empty write's callback too: writeParsed's guard is harmless, but this note is out of date");
  } finally {
    t.dispose();
  }
});

test("a new session's empty snapshot is restored even when the page's first fit lands before xterm reads a write (blank-terminal fix)", async () => {
  const t = new HeadlessTerminal({ cols: 80, rows: 24, logLevel: "off", allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
  try {
    const page = fitInEveryGap(t, 101, 37);
    const restored = await within(term.restoreScreen(page, { data: "", cols: 120, rows: 32, modes: ALL_OFF }), 2000);
    assert.notEqual(restored, TIMED_OUT, "the restore finishes, so the terminal can say it is open and take the keys");
    const withModes = await within(term.restoreScreen(page, { data: "", cols: 120, rows: 32, modes: { ...ALL_OFF, bracketedPaste: true } }), 2000);
    assert.notEqual(withModes, TIMED_OUT, "an empty snapshot with modes to put back finishes too");
    assert.equal(t.modes.bracketedPasteMode, true);
    // Live output after the restore still lands, and an empty chunk never holds the queue.
    assert.notEqual(await within(term.writeParsed(page, ""), 2000), TIMED_OUT, "an empty write resolves at once");
    assert.notEqual(await within(term.writeParsed(page, "FAKE_ARGV"), 2000), TIMED_OUT);
    assert.equal(screenLines(t)[0], "FAKE_ARGV");
  } finally {
    t.dispose();
  }
});

test("a snapshot with text is drawn once, at its own size, with its modes, when a fit lands in every gap", async () => {
  const t = new HeadlessTerminal({ cols: 80, rows: 24, logLevel: "off", allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
  try {
    const sizes = [];
    const page = fitInEveryGap(t, 30, 8);
    const write = page.write;
    page.write = (data, callback) => {
      if (data === "hello\r\nworld") sizes.push([t.cols, t.rows]);
      write(data, callback);
    };
    const restored = await within(term.restoreScreen(page, { data: "hello\r\nworld", cols: 40, rows: 10, modes: { ...ALL_OFF, cursorKeysApp: true } }), 2000);
    assert.notEqual(restored, TIMED_OUT);
    assert.deepEqual(sizes, [[40, 10]], "the snapshot is written at the size it was taken (D-U2-7)");
    assert.deepEqual(screenLines(t).slice(0, 3), ["hello", "world", ""]);
    assert.equal(t.modes.applicationCursorKeysMode, true);
  } finally {
    t.dispose();
  }
});

test("only http and https links may open (Q45: mailto text is not a link)", () => {
  for (const ok of ["http://example.com", "https://example.com/a?b=c"]) assert.equal(term.linkAllowed(ok), true, ok);
  for (const no of ["mailto:someone@example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "vscode://file/x", "ssh://host", "not a url", ""]) {
    assert.equal(term.linkAllowed(no), false, no);
  }
});

test("OSC 52: a request to read the clipboard is recognised (so it is refused); a write is not", () => {
  assert.equal(term.isOsc52Read("c;?"), true);
  assert.equal(term.isOsc52Read("p;?"), true);
  assert.equal(term.isOsc52Read(";?"), true, "an empty selection still asks to read");
  assert.equal(term.isOsc52Read("c;aGVsbG8="), false);
  assert.equal(term.isOsc52Read("?"), false);
  assert.equal(term.isOsc52Read(""), false);
});

test("binary mouse reports pass only when they are plain ASCII", () => {
  assert.equal(term.isAsciiOnly("\x1b[M !!"), true);
  assert.equal(term.isAsciiOnly(""), true);
  assert.equal(term.isAsciiOnly("\x1b[Mÿ!!"), false);
});

test("reconnect: 0.5, 1, 2, 5 and 5 s, five tries, and the wait advice starts at 5 s (Q40)", () => {
  assert.equal(term.RECONNECT_ATTEMPTS, 5);
  const pace = Array.from({ length: term.RECONNECT_ATTEMPTS }, (_, n) => term.reconnectDelay(n));
  assert.deepEqual(pace, [500, 1000, 2000, 5000, 5000]);
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => term.reconnectDelay(n, "reattach")), [500, 1000, 2000, 5000, 5000], "a dropped connection or a refused attach");
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => term.reconnectDelay(n, "wait")), [5000, 5000, 5000, 5000, 5000], "attach_failed or a message over 1 MB: never at once");
  assert.equal(term.reconnectDelay(10), 5000);
  assert.equal(term.reconnectDelay(-1), 500);
  assert.equal(term.reconnectDelay(Number.NaN), 500);
});

test("typed text that could not be sent: the person is told once per disconnect, and the next snapshot starts over (ledger: Task U2 ruling)", () => {
  assert.equal(term.INPUT_NOT_SENT_NOTICE, "That wasn't sent: the terminal is reconnecting. Type it again when it's back.");
  const gate = term.createUnsentNotice();
  assert.equal(gate.report(true), false, "input that was sent says nothing");
  assert.equal(gate.report(true), false);
  assert.equal(gate.report(false), true, "the first input that was not sent says so");
  assert.equal(gate.report(false), false, "...but only once for this disconnect");
  assert.equal(gate.report(false), false);
  assert.equal(gate.report(true), false, "a send that works does not start a new round by itself");
  assert.equal(gate.report(false), false);
  gate.reset();
  assert.equal(gate.report(false), true, "the next snapshot arrived, so the next disconnect says it again");
  assert.equal(gate.report(false), false);
  gate.reset();
  gate.reset();
  assert.equal(gate.report(false), true, "resetting twice is the same as once");
  assert.equal(gate.report(false), false);
  // Each gate is its own: a second terminal's disconnect is not silenced by the first one's.
  assert.equal(term.createUnsentNotice().report(false), true);
});

test("focus and mouse reports are the terminal's own, not typed text: they never start the unsent sentence (fix round 1)", () => {
  // What xterm sends by itself when a program asked for it: focus in and out (mode 1004) and the three mouse
  // encodings (X10/default, SGR 1006, SGR-pixels 1016), for clicks, motion and the wheel.
  const reports = [
    "\x1b[I",
    "\x1b[O",
    "\x1b[M !!",
    "\x1b[M#*+",
    "\x1b[Mÿ!!",
    "\x1b[<0;12;5M",
    "\x1b[<0;12;5m",
    "\x1b[<35;120;45M",
    "\x1b[<64;1;1M",
    "\x1b[<0;1530;870M"
  ];
  for (const report of reports) assert.equal(term.isAutomaticReport(report), true, JSON.stringify(report));
  // Typed or pasted text is never one of them, even when it starts the same way.
  const typed = [
    "",
    "a",
    "ab",
    "I",
    "O",
    "\r",
    "\x1b",
    "\x1b[",
    "\x1b[A",
    "\x1bOA",
    "\x1b[3~",
    "\x1b[200~pasted\x1b[201~",
    "\x1b[Ix",
    "x\x1b[I",
    "\x1b[M!!",
    "\x1b[<0;1;1",
    "\x1b[<0;1;1Mx",
    "\x1b[<a;1;1M",
    "paste\x1b[<0;1;1M"
  ];
  for (const text of typed) assert.equal(term.isAutomaticReport(text), false, JSON.stringify(text));
  // The rule the terminal follows with it: a report that could not be sent does not use up the person's
  // once-per-disconnect sentence, so the first thing they really type still gets told.
  const gate = term.createUnsentNotice();
  const told = (data) => !term.isAutomaticReport(data) && gate.report(false);
  assert.equal(told("\x1b[O"), false);
  assert.equal(told("\x1b[<35;4;4M"), false);
  assert.equal(told("\x1b[I"), false);
  assert.equal(told("a"), true, "the first typed key is told");
  assert.equal(told("b"), false);
});

test("the unsent sentence is said only while reconnecting or open, only for text typed here (fix round 1, second pass)", () => {
  const at = (connection, typing = true) => term.unsentNoticeApplies(connection, typing);
  assert.equal(at("reconnecting"), true, "a try is running or about to run");
  assert.equal(at("open"), true, "a socket that dropped just before its close arrived, or one not yet the writer");
  assert.equal(at("connecting"), false, "the very first Connecting...: this window was never connected, so nothing is reconnecting");
  assert.equal(at("lost"), false, "nothing retries until the person presses Reconnect");
  assert.equal(at("ended"), false);
  assert.equal(at(null), false, "no state yet");
  assert.equal(at("reconnecting", false), false, "not typed here: a viewer's terminal answering a program's query stays silent");
  assert.equal(at("open", false), false);
  // With the once-per-disconnect gate, the way the terminal uses both: input that WAS sent never starts a round.
  const gate = term.createUnsentNotice();
  const tell = (connection, sent) => term.unsentNoticeApplies(connection, true) && gate.report(sent);
  assert.equal(tell("connecting", false), false, "silent while connecting, and it does not use up the round");
  assert.equal(tell("lost", false), false);
  assert.equal(tell("open", true), false, "sent: nothing to tell");
  assert.equal(tell("reconnecting", false), true, "the first unsent text while reconnecting is told");
  assert.equal(tell("reconnecting", false), false);
});

test("Tab and Shift+Tab leave the terminal while it is not open, so Reconnect can be reached (fix round 1, second pass)", () => {
  const key = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods });
  for (const state of ["connecting", "reconnecting", "lost", "ended", null]) {
    assert.equal(term.tabLeavesTerminal(state, key("Tab")), true, `Tab while ${state}`);
    assert.equal(term.tabLeavesTerminal(state, { ...key("Tab"), shiftKey: true }), true, `Shift+Tab while ${state}`);
  }
  assert.equal(term.tabLeavesTerminal("open", key("Tab")), false, "open: Tab is the agent's (completion, focus changes in its UI)");
  assert.equal(term.tabLeavesTerminal("open", { ...key("Tab"), shiftKey: true }), false);
  for (const mods of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.equal(term.tabLeavesTerminal("lost", key("Tab", mods)), false, `${JSON.stringify(mods)}+Tab is the agent's (or the system's) even then`);
  }
  for (const other of ["a", "Enter", "Escape", " ", "ArrowDown", "Shift"]) {
    assert.equal(term.tabLeavesTerminal("lost", key(other)), false, `${other} is not Tab`);
  }
});

test("wiring: the terminal uses the spec's options and words, leaves ⌘T/⌘1-9 to the page, refuses clipboard reads and follows the reconnect rule", () => {
  const src = readFileSync(new URL("../src/ui/components/SessionTerminal.tsx", import.meta.url), "utf8");
  for (const needle of [
    "allowProposedApi: true",
    "scrollOnEraseInDisplay: true",
    "vtExtensions: { kittyKeyboard",
    "fontSize: TERMINAL_FONT_SIZE",
    'unicode.activeVersion = "11"',
    "attachCustomKeyEventHandler",
    "togglePalette()",
    "registerOscHandler(52",
    "allowNonHttpProtocols: false",
    "onContextLoss",
    'info.advice === "ended"',
    'info.reason === "too_far_behind"',
    "latest.current.ended === true",
    "attempts >= RECONNECT_ATTEMPTS",
    "reconnectDelay(attempts, info.advice)",
    "say(WORDS.linkCopied)",
    "{WORDS.reconnect}",
    "@xterm/xterm/css/xterm.css",
    // Input that was not sent: told once per disconnect, never queued or replayed (ledger: Task U2 ruling).
    "unsentNotice.reset()",
    // Fix round 1: not for focus or mouse reports (the person typed nothing); the X10 mouse report arrives by
    // onBinary.
    "isAutomaticReport(data)",
    "sendInput(data, true)",
    // Fix round 1, second pass. The sentence's rule is unsentNoticeApplies (reconnecting or open, typed here) and
    // the gate gets what the socket answered; the sentence is one of WORDS (E1's copy review collects them).
    "inputNotSent: INPUT_NOT_SENT_NOTICE",
    "say(WORDS.inputNotSent)",
    "unsentNoticeApplies(shown, typing)",
    "unsentNotice.report(sent)",
    // Fix round 2: "typing here" needs the page to have the focus too. A background window whose box still holds
    // the focus inside its page is not where the person is typing, so it never announces unsent input.
    "const typing = document.hasFocus() && document.activeElement === term?.textarea",
    // Keys typed on a socket this window has not sent {t:"focus"} on are not sent (the server would drop them).
    "hasKeys = true",
    "(automatic || hasKeys)",
    // A background window must not take the writer role back after a reattach; a window brought to the front does.
    "document.hasFocus()",
    'window.addEventListener("focus", onWindowFocus)',
    'window.removeEventListener("focus", onWindowFocus)',
    // {t:"focus"} goes out before xterm's own focus-in report: the capture phase on the host.
    'host.addEventListener("focus", onFocus, true)',
    'host.removeEventListener("focus", onFocus, true)',
    // Tab leaves the box while it is not open, and the focus moves onto Reconnect when the connection is lost.
    "tabLeavesTerminal(shown, event)",
    "ref={reconnectRef}",
    "reconnectRef.current?.focus()",
    // A size over the protocol's limits is clamped before it is sent.
    "t.resize(Math.min(t.cols, MAX_COLS), Math.min(t.rows, MAX_ROWS))",
    // Blank-terminal fix: the reattach steps live in terminalShared.ts (tested above), and no fit runs while they
    // draw, so no resize lands between a queued restore write and its callback.
    "await restoreScreen(t, snapshot)",
    "if (restoring) return;",
    // An OSC 8 link shows its real address while hovered.
    "host.title = uri",
    'host.removeAttribute("title")',
    // The status line is always in the page, only its text changes.
    '<p className="os-term__notice-text" role="status">',
    "os-term__notice--empty",
    // The decided words (Q40, Q45).
    '"Connecting…"',
    '"Reconnecting…"',
    '"Lost the connection to this session."',
    'reconnect: "Reconnect"',
    '"Link copied. Open it in your browser."'
  ]) {
    assert.ok(src.includes(needle), `SessionTerminal.tsx has ${needle}`);
  }
  // The sentence's gate is called with what the socket answered; the component keeps no second `!sent` check.
  assert.doesNotMatch(src, /!sent\b/, "unsentNotice.report(sent) decides, not a separate !sent check");
  // Every write goes through writeParsed, which never queues an empty one (xterm 6.1 can lose its callback).
  assert.doesNotMatch(src, /\bt\.write\(/, "SessionTerminal writes only through writeParsed");
  // The page's callbacks are guarded inside report() and say(): a throw there must not stop the tries.
  assert.match(src, /const report = [\s\S]*?try \{\s*latest\.current\.onConnection\?\.\(next\);\s*\} catch/, "report() guards onConnection");
  assert.match(src, /const say = [\s\S]*?try \{\s*latest\.current\.onNotice\?\.\(text\);\s*\} catch/, "say() guards onNotice");
  // The status line is not inside a condition that inserts it already holding its text.
  assert.doesNotMatch(src, /\{notice \? \(\s*<div/, "the status line is always rendered");
  // xterm's own layers (scrollbar z-index 11, search highlights) stay under the notice.
  const css = readFileSync(new URL("../src/ui/terminal.css", import.meta.url), "utf8");
  assert.match(css, /\.os-term__screen\s*\{[^}]*isolation:\s*isolate/, "the screen is its own stacking context");
  assert.doesNotMatch(src, /stopPropagation/, "the app shortcuts bubble on to the page");
  assert.doesNotMatch(src, /localStorage/, "the page owns the browser-side settings");
  assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash in the terminal's words");
  assert.equal(term.TERMINAL_FONT_SIZE, 13);
});
