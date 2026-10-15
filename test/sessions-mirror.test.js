// The session mirror: the server's headless copy of a session's screen.
// Snapshot and modes for reattach, the three standard terminal questions
// answered only while no writer is attached, raw alerts, counted output for
// the 20 s activity rule, and what counts as user input. No process runs here:
// the tests write terminal output straight into the mirror.
import assert from "node:assert/strict";
import test from "node:test";
import xtermHeadless from "@xterm/headless";
import { ALERT_RAW_LIMIT, COUNTED_CHECK_MS, createMirror, isUserInput } from "../server/runtime/sessions/mirror.js";

// @xterm/headless is a CommonJS bundle: its classes sit on the default export.
const { Terminal } = xtermHeadless;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_MODES = {
  altScreen: false,
  bracketedPaste: false,
  mouseTracking: "none",
  mouseEncoding: "default",
  focusReporting: false,
  cursorKeysApp: false,
  kittyFlags: 0
};

// Waits until everything written so far is on the mirror's screen and a
// counted-output check has had time to run.
async function settle(mirror) {
  await mirror.snapshot();
  await sleep(COUNTED_CHECK_MS * 2 + 100);
}

// Writes a snapshot into a fresh terminal of the same size, the way a browser
// terminal restores one, and reads the screen back.
async function replay(snapshot) {
  const term = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, logLevel: "off" });
  await new Promise((resolve) => term.write(snapshot.data, resolve));
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y += 1) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
  const result = { lines, cursor: [buffer.cursorX, buffer.cursorY], screen: buffer.type };
  term.dispose();
  return result;
}

test("a snapshot restores the screen, the cursor and the alternate screen in a fresh terminal", async () => {
  const mirror = createMirror({ cols: 40, rows: 10 });
  try {
    mirror.write("\x1b[1mbold\x1b[0m plain\r\nsecond line\r\n\x1b[32mgreen\x1b[0m");
    const normal = await mirror.snapshot();
    assert.equal(normal.cols, 40);
    assert.equal(normal.rows, 10);
    const restored = await replay(normal);
    assert.deepEqual(restored.lines.slice(0, 3), ["bold plain", "second line", "green"]);
    assert.deepEqual(restored.cursor, [5, 2]);
    assert.equal(restored.screen, "normal");

    mirror.write("\x1b[?1049h\x1b[Hin the alt screen");
    const alt = await mirror.snapshot();
    assert.equal(alt.modes.altScreen, true);
    const restoredAlt = await replay(alt);
    assert.equal(restoredAlt.screen, "alternate");
    assert.equal(restoredAlt.lines[0], "in the alt screen");
  } finally {
    mirror.dispose();
  }
});

test("a snapshot covers exactly the output written before it was asked for, never later output", async () => {
  const mirror = createMirror({ cols: 40, rows: 10 });
  try {
    mirror.write("first");
    const pending = mirror.snapshot();
    mirror.write("\r\nsecond"); // written after the request: goes to the window as live output instead
    const early = await replay(await pending);
    assert.deepEqual(early.lines.slice(0, 2), ["first", ""]);
    const later = await replay(await mirror.snapshot());
    assert.deepEqual(later.lines.slice(0, 2), ["first", "second"]);
  } finally {
    mirror.dispose();
  }
});

test("modes: bracketed paste, mouse tracking and encoding, focus reports, cursor keys and the alternate screen are tracked and cleared", async () => {
  const mirror = createMirror({ cols: 40, rows: 10 });
  try {
    assert.deepEqual((await mirror.snapshot()).modes, DEFAULT_MODES);

    mirror.write("\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?1h\x1b[?1049h");
    const on = await mirror.snapshot();
    assert.deepEqual(on.modes, {
      altScreen: true,
      bracketedPaste: true,
      mouseTracking: "drag",
      mouseEncoding: "sgr",
      focusReporting: true,
      cursorKeysApp: true,
      kittyFlags: 0
    });
    assert.ok(on.data.includes("\x1b[?2004h"), "the serialized screen carries bracketed paste itself");

    mirror.write("\x1b[?1016h");
    assert.equal((await mirror.snapshot()).modes.mouseEncoding, "sgr-pixels");
    mirror.write("\x1b[?1006l"); // xterm.js turns off either encoding with either reset
    assert.equal((await mirror.snapshot()).modes.mouseEncoding, "default");

    mirror.write("\x1b[?1006h\x1b[?2004l\x1b[?1002l\x1b[?1006l\x1b[?1004l\x1b[?1l\x1b[?1049l");
    assert.deepEqual((await mirror.snapshot()).modes, DEFAULT_MODES);
  } finally {
    mirror.dispose();
  }
});

test("a full reset (RIS) clears every tracked mode", async () => {
  const mirror = createMirror({ cols: 40, rows: 10 });
  try {
    mirror.write("\x1b[?1006h\x1b[?2004h\x1b[?1000h\x1b[?1049h\x1b[>5u");
    const before = await mirror.snapshot();
    assert.equal(before.modes.kittyFlags, 5);
    assert.equal(before.modes.mouseEncoding, "sgr");
    mirror.write("\x1bc");
    assert.deepEqual((await mirror.snapshot()).modes, DEFAULT_MODES);
  } finally {
    mirror.dispose();
  }
});

test("kitty keyboard flags follow push, pop and set, per screen, exactly as xterm.js itself answers them", async () => {
  const replies = [];
  const mirror = createMirror({ cols: 40, rows: 10, onQueryReply: (reply) => replies.push(reply) });
  // Asks xterm.js for its flags (CSI ? u) and compares with what the mirror tracked.
  async function kittyNow() {
    replies.length = 0;
    mirror.write("\x1b[?u");
    const { modes } = await mirror.snapshot();
    return { tracked: modes.kittyFlags, xterm: replies.at(-1) };
  }
  const steps = [
    ["\x1b[>1u", 1, "push 1"],
    ["\x1b[>3u", 3, "push 3"],
    ["\x1b[<u", 1, "pop one"],
    ["\x1b[=4;2u", 5, "set bits"],
    ["\x1b[=1;3u", 4, "clear bits"],
    ["\x1b[=2u", 2, "replace"],
    ["\x1b[?1049h", 0, "the alternate screen has its own flags"],
    ["\x1b[>8u", 8, "push on the alternate screen"],
    ["\x1b[?1049l", 2, "back to the main screen's flags"],
    ["\x1b[?1049h", 8, "the alternate screen's flags were kept"],
    ["\x1b[?1049l\x1b[<5u", 0, "popping past the bottom leaves 0"]
  ];
  try {
    for (const [sequence, expected, why] of steps) {
      mirror.write(sequence);
      assert.deepEqual(await kittyNow(), { tracked: expected, xterm: `\x1b[?${expected}u` }, why);
    }
  } finally {
    mirror.dispose();
  }
});

test("a soft reset (DECSTR, CSI ! p) clears the kitty keyboard flags and both screens' stacks, as xterm.js does", async () => {
  const replies = [];
  const mirror = createMirror({ cols: 40, rows: 10, onQueryReply: (reply) => replies.push(reply) });
  async function kittyNow() {
    replies.length = 0;
    mirror.write("\x1b[?u");
    const { modes } = await mirror.snapshot();
    return { tracked: modes.kittyFlags, xterm: replies.at(-1) };
  }
  try {
    // Flags and a stack on the main screen, and flags kept for the alternate screen.
    mirror.write("\x1b[>5u\x1b[>7u\x1b[?1049h\x1b[>8u\x1b[?1049l");
    assert.deepEqual(await kittyNow(), { tracked: 7, xterm: "\x1b[?7u" });

    mirror.write("\x1b[!p");
    assert.deepEqual(await kittyNow(), { tracked: 0, xterm: "\x1b[?0u" }, "the flags are gone");
    mirror.write("\x1b[<u");
    assert.deepEqual(await kittyNow(), { tracked: 0, xterm: "\x1b[?0u" }, "so is the stack: a pop does not bring 5 back");
    mirror.write("\x1b[?1049h");
    assert.deepEqual(await kittyNow(), { tracked: 0, xterm: "\x1b[?0u" }, "and the alternate screen's flags");
    mirror.write("\x1b[?1049l");

    // Other modes the serializer reports are not touched by the tracking.
    mirror.write("\x1b[?1006h\x1b[>2u\x1b[!p");
    const after = await mirror.snapshot();
    assert.equal(after.modes.kittyFlags, 0);
    assert.equal(after.modes.mouseEncoding, "sgr", "a soft reset does not reset the mouse encoding in xterm.js either");
  } finally {
    mirror.dispose();
  }
});

test("the mirror answers DA1, cursor position and kitty flags only while no writer is attached, and nothing else", async () => {
  const replies = [];
  const mirror = createMirror({ cols: 40, rows: 10, onQueryReply: (reply) => replies.push(reply) });
  try {
    // DA1, cursor position, DA2 (dropped), status (dropped), a kitty push, a kitty query.
    mirror.write("abc\x1b[c\x1b[6n\x1b[>c\x1b[5n\x1b[>3u\x1b[?u");
    await mirror.snapshot();
    assert.deepEqual(replies, ["\x1b[?1;2c", "\x1b[1;4R", "\x1b[?3u"]);

    mirror.setWriterAttached(true); // the writer's own browser terminal answers now
    mirror.write("\x1b[c\x1b[6n\x1b[?u");
    await mirror.snapshot();
    assert.equal(replies.length, 3, "no answer while a writer is attached");

    mirror.setWriterAttached(false);
    mirror.write("\x1b[c");
    await mirror.snapshot();
    assert.deepEqual(replies.slice(3), ["\x1b[?1;2c"]);
  } finally {
    mirror.dispose();
  }
});

test("alerts: BEL and OSC 9, 99 and 777 are forwarded raw; a title or a BEL that ends an OSC is not an alert", async () => {
  const alerts = [];
  const mirror = createMirror({ cols: 40, rows: 10, onAlert: (raw) => alerts.push(raw) });
  try {
    mirror.write("ding\x07");
    mirror.write("\x1b]9;Approval requested\x07");
    mirror.write("\x1b]9;Turn done\x1b\\");
    mirror.write("\x1b]777;notify;Codex;Waiting for you\x07");
    mirror.write("\x1b]99;i=1:d=0;Hello\x1b\\");
    mirror.write("\x1b]0;just a title\x07");
    mirror.write("\x1b]9;spl");
    mirror.write("it across writes\x07");
    mirror.write(`\x1b]9;${"x".repeat(10000)}\x07`);
    await mirror.snapshot();
    assert.deepEqual(alerts.slice(0, 6), [
      "bel",
      "9;Approval requested",
      "9;Turn done",
      "777;notify;Codex;Waiting for you",
      "99;i=1:d=0;Hello",
      "9;split across writes"
    ]);
    assert.equal(alerts.length, 7);
    assert.equal(alerts[6].length, ALERT_RAW_LIMIT, "a huge payload is cut to the limit");
    assert.ok(alerts[6].startsWith("9;xxx"));
  } finally {
    mirror.dispose();
  }
});

test("a flood of BEL bytes is one alert per 250 ms; OSC alerts are not held back by it", async () => {
  const alerts = [];
  let clock = 1000000;
  const mirror = createMirror({ cols: 40, rows: 10, onAlert: (raw) => alerts.push(raw), now: () => clock });
  try {
    mirror.write("\x07".repeat(10000));
    mirror.write("\x1b]9;one\x07\x07\x1b]9;two\x07");
    await mirror.snapshot();
    assert.deepEqual(alerts, ["bel", "9;one", "9;two"], "10,001 bells, one alert; both notifications");

    clock += 249;
    mirror.write("\x07");
    await mirror.snapshot();
    assert.equal(alerts.length, 3, "still inside the 250 ms");

    clock += 1;
    mirror.write("\x07\x07\x07");
    await mirror.snapshot();
    assert.deepEqual(alerts.slice(3), ["bel"], "250 ms after the last alert one bell is forwarded again");

    clock -= 5000; // a clock set back must not silence bells until it catches up
    mirror.write("\x07");
    await mirror.snapshot();
    assert.deepEqual(alerts.slice(4), ["bel"]);
  } finally {
    mirror.dispose();
  }
});

test("counted output: new text above the bottom 6 rows and scrolling count; the bottom rows, colours, cursor, titles, modes and identical redraws do not", async () => {
  const mirror = createMirror({ cols: 40, rows: 12 }); // rows 7 to 12 are the bottom 6
  let counted = 0;
  let stopped = 0;
  mirror.onCountedOutput(() => {
    counted += 1;
  });
  const off = mirror.onCountedOutput(() => {
    stopped += 1;
  });
  off();
  try {
    mirror.write("\x1b[2;1Hworking on step 1");
    await settle(mirror);
    assert.equal(counted, 1, "new text above the bottom 6 rows");

    mirror.write("\x1b[7;1Hstatus: 12%\x1b[12;1H> ");
    await settle(mirror);
    assert.equal(counted, 1, "a status line and an input box in the bottom 6 rows");

    mirror.write("\x1b[2;1Hworking on step 1");
    mirror.write("\x1b[2;1H\x1b[31mworking on step 1\x1b[0m");
    mirror.write("\x1b[4;9H\x1b]0;a new title\x07\x1b[?2004h\x1b[?25l");
    await settle(mirror);
    assert.equal(counted, 1, "identical redraws, a colour, the cursor, a title and modes");

    mirror.write("\x1b[12;1H\r\n\r\n");
    await settle(mirror);
    assert.equal(counted, 2, "scrolling the screen");
    assert.equal(stopped, 0, "an unsubscribed listener hears nothing");
  } finally {
    mirror.dispose();
  }
});

test("counted output is checked at most every 250 ms", async () => {
  const mirror = createMirror({ cols: 40, rows: 12 });
  let counted = 0;
  mirror.onCountedOutput(() => {
    counted += 1;
  });
  try {
    const started = Date.now();
    for (let step = 0; Date.now() - started < 1000; step += 1) {
      mirror.write(`\x1b[2;1Hstep ${step}   `);
      await sleep(10);
    }
    await settle(mirror);
    assert.ok(counted >= 2, `expected counted output, got ${counted}`);
    assert.ok(counted <= 6, `expected at most one count per 250 ms over about 1.3 s, got ${counted}`);
  } finally {
    mirror.dispose();
  }
});

test("resize changes the mirror's size, ignores impossible sizes, and its reflow is not counted as output", async () => {
  const mirror = createMirror({ cols: 40, rows: 12 });
  let counted = 0;
  mirror.onCountedOutput(() => {
    counted += 1;
  });
  try {
    mirror.write("\x1b[2;1Ha line that is long enough to wrap when narrow");
    await settle(mirror);
    assert.equal(counted, 1);
    mirror.resize(20, 12);
    mirror.write("\x1b[12;1Hstatus");
    await settle(mirror);
    assert.equal(counted, 1, "the text moved by the resize is not output");
    mirror.resize(0, 12);
    mirror.resize(600, 12);
    mirror.resize(30.5, 12);
    mirror.resize(30, 0);
    const snap = await mirror.snapshot();
    assert.deepEqual([snap.cols, snap.rows], [20, 12]);
  } finally {
    mirror.dispose();
  }
});

test("dispose answers a snapshot still waiting, and later calls do nothing", async () => {
  const mirror = createMirror({ cols: 40, rows: 10 });
  mirror.write("bye");
  const pending = mirror.snapshot();
  mirror.dispose();
  const snap = await pending;
  assert.equal(typeof snap.data, "string");
  assert.deepEqual([snap.cols, snap.rows], [40, 10]);
  mirror.write("ignored");
  mirror.resize(80, 24);
  mirror.setWriterAttached(true);
  mirror.dispose();
  assert.equal((await mirror.snapshot()).data, "");
});

test("isUserInput: replies, focus reports and mouse motion are not user input; keys, paste, clicks and the wheel are", () => {
  const motion = (button) => "\x1b[M" + String.fromCharCode(32 + button, 32 + 10, 32 + 5);
  const notInput = [
    "",
    "\x1b[?1;2c", // DA1 reply
    "\x1b[>0;276;0c", // DA2 reply
    "\x1b[12;40R", // cursor position
    "\x1b[?12;40R", // cursor position, private form
    "\x1b[0n", // status report
    "\x1b[?997;1n", // colour scheme report
    "\x1b[?5u", // kitty keyboard flags
    "\x1b[?2004;1$y", // mode report
    "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\", // background colour reply
    "\x1b]10;rgb:ffff/ffff/ffff\x07", // foreground colour reply
    "\x1b]4;1;rgb:cdcd/0000/0000\x07", // palette colour reply
    "\x1bP>|xterm.js(6.1.0)\x1b\\", // terminal name and version
    "\x1b[I", // focus in
    "\x1b[O", // focus out
    "\x1b[<35;10;5M", // mouse moved, no button
    "\x1b[<32;10;5M", // mouse moved with the left button held
    motion(35), // mouse moved, default encoding
    "\x1b[O\x1b[?1;2c\x1b[<35;1;1M\x1b[3;7R" // several in one frame
  ];
  const input = [
    "a",
    "hello\r",
    "\r",
    "\x03", // Ctrl+C
    "\x1b", // Escape
    "\x1b[A", // arrow up
    "\x1b[3~", // Delete
    "\x1b[13;2u", // Shift+Enter with the kitty keyboard
    "\x1b[97u", // "a" with the kitty keyboard
    "\x1b[200~pasted text\x1b[201~",
    "\x1b[<0;10;5M", // click
    "\x1b[<0;10;5m", // release
    "\x1b[<64;10;5M", // wheel up
    "\x1b[<65;10;5M", // wheel down
    motion(0), // click, default encoding
    "\x1b[Ix", // a focus report, then a key
    "\x1b[?1;2cq" // a reply, then a key
  ];
  for (const frame of notInput) assert.equal(isUserInput(frame), false, JSON.stringify(frame));
  for (const frame of input) assert.equal(isUserInput(frame), true, JSON.stringify(frame));
  assert.equal(isUserInput(undefined), false);
});
