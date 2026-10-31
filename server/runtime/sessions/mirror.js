// The server's own copy of a session's screen (the "mirror"), kept with
// xterm.js's headless terminal at the same size as the PTY. It:
// - gives a window that attaches later the screen exactly as it is now
//   (snapshot: the serialized screen plus the modes the serializer leaves out);
// - answers the three standard terminal questions (DA1, cursor position,
//   kitty keyboard flags) while no window is the writer, so an agent never
//   waits forever for a reply after the window closes;
// - reports alerts raw (SP3): BEL, and OSC 9, 99 and 777 notifications;
// - reports window titles raw (SP4: OSC 0, 1 and 2, for Hermes's "⚠" marker);
// - says which modes are on at any moment, and tells a listener when one
//   changes (SP4: a hand-off waits for bracketed paste);
// - gives the visible screen as plain text (SP4: the Claude Code and Codex
//   limit texts and the typed summaries, the only screen reading);
// - tells the session manager when real work shows on screen ("counted
//   output"): text that changes above the bottom 6 rows, or a scroll, checked
//   at most every 250 ms. Status lines, input boxes and key hints live in the
//   bottom rows, so their redraws do not keep a session "live".
import xtermHeadless from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";
import unicode11Addon from "@xterm/addon-unicode11";

// These packages are CommonJS bundles: their classes sit on the default export.
const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;
const { Unicode11Addon } = unicode11Addon;

export const COUNTED_BOTTOM_ROWS = 6;
export const COUNTED_CHECK_MS = 250;
export const MIRROR_SCROLLBACK = 1000;
export const ALERT_RAW_LIMIT = 4096;

const ALERT_OSC_IDS = [9, 99, 777];
const BEL_ALERT_GAP_MS = 250; // a flood of BEL bytes is one alert per this long
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
const KITTY_STACK_LIMIT = 16; // the same limit xterm.js uses
// Replies the mirror may send on the agent's behalf: DA1, the cursor position
// (plain and private form) and the kitty keyboard flags. xterm.js would also
// answer DA2, mode requests and more; those are dropped.
const STANDARD_REPLY = /^(?:\x1b\[\?[\d;]*c|\x1b\[\??\d+;\d+R|\x1b\[\?\d+u)$/;
const DEFAULT_MODES = Object.freeze({
  altScreen: false,
  bracketedPaste: false,
  mouseTracking: "none",
  mouseEncoding: "default",
  focusReporting: false,
  cursorKeysApp: false,
  kittyFlags: 0
});
const MODE_KEYS = Object.keys(DEFAULT_MODES);
// The window title (0, 2) and the icon name (1); Hermes sets 1 and 2 together.
const TITLE_OSC_IDS = [0, 1, 2];

function clampSize(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

// One numeric parameter of a CSI sequence (sub-parameters arrive as arrays).
function param(params, index, fallback) {
  const value = params[index];
  const number = Array.isArray(value) ? value[0] : value;
  return Number.isInteger(number) ? number : fallback;
}

function freshKitty() {
  return { flags: 0, mainFlags: 0, altFlags: 0, mainStack: [], altStack: [] };
}

function safeCall(listener, value) {
  try {
    listener(value);
  } catch (error) {
    console.error("Agent OS: a screen listener failed:", error);
  }
}

export function createMirror({ cols, rows, onQueryReply, onAlert, onTitle, now = Date.now } = {}) {
  const reply = typeof onQueryReply === "function" ? onQueryReply : () => {};
  const alert = typeof onAlert === "function" ? onAlert : () => {};
  const titled = typeof onTitle === "function" ? onTitle : () => {};
  const term = new Terminal({
    cols: clampSize(cols, 120, 2, 500),
    rows: clampSize(rows, 32, 1, 200),
    scrollback: MIRROR_SCROLLBACK,
    allowProposedApi: true, // term.unicode is a proposed API
    logLevel: "off",
    vtExtensions: { kittyKeyboard: true }
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  // Measure wide characters (emoji, CJK) the way the browser terminal does.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  let disposed = false;
  let writerAttached = false;
  let warnedBehind = false;
  let mouseEncoding = "default";
  let kitty = freshKitty();
  let finalModes = null;
  let finalSize = null;
  let dirty = false;
  let lastBelAt = null;
  let checkTimer = null;
  let lastCheckAt = now() - COUNTED_CHECK_MS;
  const disposables = [];
  const countedListeners = new Set();
  const modeListeners = new Set();
  // A mode sequence was seen; checked once xterm.js has read the write.
  let modesDirty = false;
  // Snapshots waiting for a chunk to be read: { target, resolve, finish }.
  const pendingSnapshots = new Set();
  // Every chunk written gets a number; parsedSeq is the newest one xterm.js
  // has read (its write callback ran).
  let writtenSeq = 0;
  let parsedSeq = 0;

  function currentModes() {
    const modes = term.modes;
    return {
      altScreen: term.buffer.active.type === "alternate",
      bracketedPaste: modes.bracketedPasteMode,
      mouseTracking: modes.mouseTrackingMode,
      mouseEncoding,
      focusReporting: modes.sendFocusMode,
      cursorKeysApp: modes.applicationCursorKeysMode,
      kittyFlags: kitty.flags
    };
  }

  // What a snapshot holds once the mirror is gone: no screen, the last size
  // and modes.
  function emptySnapshot() {
    const size = finalSize || { cols: term.cols, rows: term.rows };
    return { data: "", cols: size.cols, rows: size.rows, modes: { ...(finalModes || DEFAULT_MODES) } };
  }

  // The text above the bottom 6 rows of the visible screen, and where that
  // screen starts in the buffer (it moves when lines scroll away).
  function readScreen() {
    const buffer = term.buffer.active;
    const above = Math.max(0, term.rows - COUNTED_BOTTOM_ROWS);
    const lines = [];
    for (let y = 0; y < above; y += 1) {
      lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
    }
    return { screen: buffer.type, baseY: buffer.baseY, text: lines.join("\n") };
  }

  let baseline = readScreen();
  let lastModes = currentModes();

  function checkCounted() {
    checkTimer = null;
    if (disposed || !dirty) return;
    dirty = false;
    lastCheckAt = now();
    const current = readScreen();
    const scrolled = current.screen === baseline.screen && current.baseY !== baseline.baseY;
    const changed = current.text !== baseline.text;
    baseline = current;
    if (scrolled || changed) {
      for (const listener of [...countedListeners]) safeCall(listener);
    }
  }

  function markDirty() {
    if (disposed) return;
    dirty = true;
    if (checkTimer) return;
    const wait = Math.max(0, lastCheckAt + COUNTED_CHECK_MS - now());
    checkTimer = setTimeout(checkCounted, wait);
    checkTimer.unref?.();
  }

  function noteModes() {
    modesDirty = true;
  }

  // Runs once a write has been read, so the listener sees what xterm.js
  // applied; a change and its undo in one write are no change.
  function checkModes() {
    if (!modesDirty || disposed) return;
    modesDirty = false;
    const next = currentModes();
    if (MODE_KEYS.every((key) => next[key] === lastModes[key])) return;
    lastModes = next;
    for (const listener of [...modeListeners]) safeCall(listener, { ...next });
  }

  // Modes the serializer leaves out: the mouse encoding and the kitty keyboard
  // flags. Every handler returns false, so xterm.js still applies the
  // sequence itself; this copy follows xterm.js's own rules.
  function trackPrivateModes(params, on) {
    noteModes();
    for (let index = 0; index < params.length; index += 1) {
      const mode = param(params, index, -1);
      if (mode === 1006) mouseEncoding = on ? "sgr" : "default";
      else if (mode === 1016) mouseEncoding = on ? "sgr-pixels" : "default";
      else if (ALT_SCREEN_MODES.has(mode)) {
        // Each screen keeps its own kitty flags.
        if (on) {
          kitty.mainFlags = kitty.flags;
          kitty.flags = kitty.altFlags;
        } else {
          kitty.altFlags = kitty.flags;
          kitty.flags = kitty.mainFlags;
        }
      }
    }
    return false;
  }

  function kittyStack() {
    return term.buffer.active.type === "alternate" ? kitty.altStack : kitty.mainStack;
  }

  disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => trackPrivateModes(params, true)),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => trackPrivateModes(params, false)),
    // CSI = flags ; mode u: 1 replaces, 2 sets bits, 3 clears bits.
    term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      noteModes();
      const value = param(params, 0, 0);
      const how = params.length > 1 ? param(params, 1, 1) || 1 : 1;
      if (how === 1) kitty.flags = value;
      else if (how === 2) kitty.flags |= value;
      else if (how === 3) kitty.flags &= ~value;
      return false;
    }),
    // CSI > flags u: push the current flags, then use the new ones.
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      noteModes();
      const stack = kittyStack();
      if (stack.length >= KITTY_STACK_LIMIT) stack.shift();
      stack.push(kitty.flags);
      kitty.flags = param(params, 0, 0);
      return false;
    }),
    // CSI < count u: pop; an emptied stack means no flags.
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      noteModes();
      const count = Math.max(1, param(params, 0, 1) || 1);
      const stack = kittyStack();
      for (let index = 0; index < count && stack.length > 0; index += 1) kitty.flags = stack.pop();
      if (stack.length === 0) kitty.flags = 0;
      return false;
    }),
    // ESC c (RIS, full reset) clears every mode.
    term.parser.registerEscHandler({ final: "c" }, () => {
      noteModes();
      mouseEncoding = "default";
      kitty = freshKitty();
      return false;
    }),
    // CSI ! p (DECSTR, soft reset): xterm.js clears the kitty keyboard flags
    // and both stacks with it (and leaves the mouse encoding alone).
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      noteModes();
      kitty = freshKitty();
      return false;
    }),
    // xterm.js's own replies to terminal questions arrive here.
    term.onData((data) => {
      if (disposed || writerAttached) return;
      if (STANDARD_REPLY.test(data)) safeCall(reply, data);
    }),
    // At most one BEL alert per 250 ms: a program that prints thousands of
    // BEL bytes must not become thousands of frames for every window.
    term.onBell(() => {
      if (disposed) return;
      const at = now();
      const since = at - lastBelAt;
      if (lastBelAt !== null && since >= 0 && since < BEL_ALERT_GAP_MS) return;
      lastBelAt = at;
      safeCall(alert, "bel");
    }),
    ...ALERT_OSC_IDS.map((id) =>
      term.parser.registerOscHandler(id, (payload) => {
        // Raw: mirror-signals.js says what each one means for each agent
        // (SP4). OSC 9;4 progress reports are forwarded too and mean nothing there.
        if (!disposed) safeCall(alert, `${id};${payload}`.slice(0, ALERT_RAW_LIMIT));
        return true;
      })
    ),
    // Window titles, raw (SP4, ruling R17: Hermes marks a question with "⚠").
    // Returning false lets xterm.js set the title as it always does.
    ...TITLE_OSC_IDS.map((id) =>
      term.parser.registerOscHandler(id, (payload) => {
        if (!disposed) safeCall(titled, String(payload).slice(0, ALERT_RAW_LIMIT));
        return false;
      })
    ),
    term.onWriteParsed(() => {
      checkModes();
      markDirty();
    })
  );

  // A chunk's write callback. xterm.js's resize() reads its queue again from
  // the start, so a callback can run twice; only a newer number counts.
  function chunkRead(seq) {
    if (seq <= parsedSeq) return;
    parsedSeq = seq;
    for (const waiter of [...pendingSnapshots]) {
      if (waiter.target <= seq) waiter.finish();
    }
  }

  function write(chunk) {
    if (disposed || typeof chunk !== "string" || chunk.length === 0) return;
    const seq = writtenSeq + 1;
    try {
      term.write(chunk, () => chunkRead(seq));
      writtenSeq = seq;
    } catch (error) {
      // xterm.js refuses more than 50 MB waiting to be read. Keep the server
      // running; the screen catches up on the agent's next redraw.
      if (!warnedBehind) {
        warnedBehind = true;
        console.warn(`Agent OS: a session's screen copy fell behind (${error.message}).`);
      }
    }
  }

  function resize(nextCols, nextRows) {
    if (disposed) return;
    const width = clampSize(nextCols, 0, 2, 500);
    const height = clampSize(nextRows, 0, 1, 200);
    if (!width || !height || (width === term.cols && height === term.rows)) return;
    term.resize(width, height);
    // Text moved by the reflow is not output.
    baseline = readScreen();
  }

  // The screen as of every chunk written before this call. xterm.js reads
  // writes later, in order, and runs a chunk's callback right after reading
  // it and before reading the next one, so the screen serialized in the
  // callback of the newest chunk written before this call is an exact cut
  // (at once when every chunk has been read). Chunks written after this call
  // are not in it: the caller sends those to the window as live output.
  // There is no empty write to mark the cut: xterm.js 6.1's resize() stops
  // reading its queue at an empty chunk and throws the rest away, callbacks
  // and later output included, so a resize from the writer's window could
  // leave an attach waiting forever and lose output.
  function snapshot() {
    if (disposed) return Promise.resolve(emptySnapshot());
    return new Promise((resolve) => {
      const waiter = {
        target: writtenSeq,
        resolve,
        finish() {
          if (!pendingSnapshots.delete(waiter)) return;
          resolve(
            disposed
              ? emptySnapshot()
              : { data: serializer.serialize(), cols: term.cols, rows: term.rows, modes: currentModes() }
          );
        }
      };
      pendingSnapshots.add(waiter);
      if (parsedSeq >= waiter.target) waiter.finish();
    });
  }

  function setWriterAttached(value) {
    writerAttached = Boolean(value);
  }

  function onCountedOutput(listener) {
    if (typeof listener !== "function" || disposed) return () => {};
    countedListeners.add(listener);
    return () => {
      countedListeners.delete(listener);
    };
  }

  // A copy of the modes now (after dispose: the last ones).
  function modes() {
    if (disposed) return { ...(finalModes || DEFAULT_MODES) };
    return currentModes();
  }

  function onModeChange(listener) {
    if (typeof listener !== "function" || disposed) return () => {};
    modeListeners.add(listener);
    return () => {
      modeListeners.delete(listener);
    };
  }

  // Every row of the visible screen, right-trimmed, one line each (spec SP4:
  // read only for the Claude Code and Codex limit texts and the typed summaries).
  // translateToString(true) drops only empty cells, so spaces the program
  // wrote at a row's end are trimmed here.
  function screenText() {
    if (disposed) return "";
    const buffer = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      lines.push((buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "").trimEnd());
    }
    return lines.join("\n");
  }

  function dispose() {
    if (disposed) return;
    finalSize = { cols: term.cols, rows: term.rows };
    try {
      finalModes = currentModes();
    } catch {
      finalModes = { ...DEFAULT_MODES };
    }
    disposed = true;
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = null;
    countedListeners.clear();
    modeListeners.clear();
    for (const waiter of pendingSnapshots) waiter.resolve(emptySnapshot());
    pendingSnapshots.clear();
    for (const disposable of disposables) {
      try {
        disposable.dispose();
      } catch {
        // already gone
      }
    }
    try {
      term.dispose();
    } catch {
      // already gone
    }
  }

  return Object.freeze({ write, resize, snapshot, setWriterAttached, onCountedOutput, modes, onModeChange, screenText, dispose });
}

// Sequences a terminal sends by itself, never typed by a person. A frame
// made only of these (and of mouse-motion reports) is not user input.
const AUTOMATIC_REPLIES = [
  /\x1b\[\?[\d;]*c/y, // DA1 reply
  /\x1b\[>[\d;]*c/y, // DA2 reply
  /\x1bP!\|[0-9A-Fa-f]*\x1b\\/y, // DA3 reply
  // Cursor position report, plain and private form. The old keyboard
  // encoding also sends Ctrl or Shift+F3 as CSI 1;<n>R; with the kitty
  // keyboard on (the default) F3 is sent differently, so only that old key
  // is affected.
  /\x1b\[\??\d+;\d+R/y,
  /\x1b\[[03]n/y, // status report
  /\x1b\[\?\d+(?:;\d+)*n/y, // private status replies, such as the colour scheme
  /\x1b\[\?\d*u/y, // kitty keyboard flags
  /\x1b\[\??\d+;\d+\$y/y, // mode report (DECRPM)
  /\x1bP>\|[^\x1b]*\x1b\\/y, // terminal name and version (XTVERSION)
  /\x1bP[01]\$r[^\x1b]*\x1b\\/y, // setting report (DECRQSS)
  /\x1b\](?:4;\d+|1\d);rgb:[0-9A-Fa-f]+\/[0-9A-Fa-f]+\/[0-9A-Fa-f]+(?:\x07|\x1b\\)/y, // OSC colour replies
  /\x1b\[[IO]/y // focus in, focus out
];
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/y;
const X10_MOUSE = /\x1b\[M([\s\S])[\s\S][\s\S]/y;

// Bit 32 marks motion; 64 marks the wheel (which counts as input).
function isMouseMotion(button) {
  return (button & 32) === 32 && (button & 64) === 0;
}

function matchAt(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

export function isUserInput(data) {
  if (typeof data !== "string" || data.length === 0) return false;
  let index = 0;
  next: while (index < data.length) {
    for (const pattern of AUTOMATIC_REPLIES) {
      const match = matchAt(pattern, data, index);
      if (match) {
        index += match[0].length;
        continue next;
      }
    }
    const sgr = matchAt(SGR_MOUSE, data, index);
    if (sgr && isMouseMotion(Number(sgr[1]))) {
      index += sgr[0].length;
      continue;
    }
    const x10 = matchAt(X10_MOUSE, data, index);
    if (x10 && isMouseMotion(x10[1].charCodeAt(0) - 32)) {
      index += x10[0].length;
      continue;
    }
    return true; // a key, a paste, a click or the wheel
  }
  return false;
}
