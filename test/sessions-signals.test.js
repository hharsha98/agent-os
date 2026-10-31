// Signals (SP4, Task X1a): the one signal shape, the activity-state machine
// (the spec's "Session activity states" transition table, with K4 and K5), the
// alert text cleaner, the AGENT_OS_ALERT line (R21) and the recording marker
// shape (R23). Pure functions only: no manager, no timer, no process. The
// manager's use of them is tested in test/sessions-manager.test.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALERT_KINDS,
  ALERT_LINE_PREFIX,
  ALERT_TEXT_MAX,
  BASIC_ALERT_TEXT,
  HELD_CHECK_MS,
  MARKERS_MAX,
  SIGNAL_KINDS,
  SIGNAL_SOURCES,
  TURN_DONE_BACKSTOP_MS,
  activityAfter,
  alertLine,
  cleanAlertText,
  freshActivity,
  genericMirrorSignal,
  makeMarker,
  makeSignal,
  printAlertLine
} from "../server/runtime/sessions/signals.js";

const SID = "3f2c9a7e-1b4d-4c8e-9f00-0123456789ab";
const AT = "2026-10-29T10:05:00.000Z";
const EARLIER = "2026-10-29T10:00:00.000Z";
const RESET = "2026-10-29T13:00:00.000Z";
const LIMIT_TEXT = "Claude Code's plan limit was reached.";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const act = (over = {}) => ({ ...freshActivity(), ...over });
const sig = (kind, text = "", source = "hook") => ({ type: "signal", kind, text, source, at: AT });
const alertOf = (kind, text, source = "hook") => ({ kind, text, at: AT, source });
const WAIT = deepFreeze({ kind: "waiting", text: BASIC_ALERT_TEXT, at: EARLIER, source: "bel" });
const LIMIT = deepFreeze({ kind: "limit", text: LIMIT_TEXT, at: EARLIER, source: "hook" });
const IDLE_BASIC = deepFreeze(act({ status: "idle", idleBy: "timer" }));
const IDLE_DONE = deepFreeze(act({ status: "idle", idleBy: "turn_done", turnDone: true }));
const WAITING = deepFreeze(act({ status: "waiting", alert: WAIT }));
const HELD = deepFreeze(act({ status: "held", resetAt: RESET, alert: LIMIT }));

// [what the spec says, from, event, the activity after]
const TABLE = [
  ["starting, first output of any kind: live", act(), { type: "output" }, act({ status: "live" })],
  ["idle, output: no change (output alone never wakes a session)", IDLE_BASIC, { type: "output" }, IDLE_BASIC],
  ["starting, counted output: live", act(), { type: "counted" }, act({ status: "live" })],
  ["basic idle, counted output: live", IDLE_BASIC, { type: "counted" }, act({ status: "live" })],
  ["turn-done idle, counted output: stays idle", IDLE_DONE, { type: "counted" }, IDLE_DONE],
  ["waiting, counted output: stays waiting", WAITING, { type: "counted" }, WAITING],
  ["held, counted output: stays held", HELD, { type: "counted" }, HELD],
  ["starting, user input: live", act(), { type: "input" }, act({ status: "live" })],
  ["turn-done idle, user input: live", IDLE_DONE, { type: "input" }, act({ status: "live", turnDone: true })],
  ["waiting, user input: live, the alert cleared", WAITING, { type: "input" }, act({ status: "live" })],
  ["held, user input: live, the alert and the reset time cleared", HELD, { type: "input" }, act({ status: "live" })],
  ["live, the idle timer: idle by timer", act({ status: "live" }), { type: "idle_timer" }, IDLE_BASIC],
  ["waiting, the idle timer: no change", WAITING, { type: "idle_timer" }, WAITING],
  ["live, turn_done: idle by turn_done, turn-done from now on", act({ status: "live" }), sig("turn_done"), IDLE_DONE],
  ["starting, turn_done: idle", act(), sig("turn_done"), IDLE_DONE],
  ["live, turn_done from an OSC 9 notification: idle by turn_done, turn-done from now on", act({ status: "live" }), sig("turn_done", "", "osc"), IDLE_DONE],
  ["live, turn_done from the Claude poller: idle by turn_done, but still basic (the poller is no first signal)", act({ status: "live" }), sig("turn_done", "", "poll"), act({ status: "idle", idleBy: "turn_done" })],
  ["waiting, turn_done: idle, the alert cleared (K4)", WAITING, sig("turn_done"), IDLE_DONE],
  ["idle by timer, turn_done: idle by turn_done", IDLE_BASIC, sig("turn_done"), IDLE_DONE],
  ["held, turn_done: stays held, turn-done from now on", HELD, sig("turn_done"), { ...HELD, turnDone: true }],
  [
    "live, waiting: waiting with the alert",
    act({ status: "live" }),
    sig("waiting", "Wants to use Bash"),
    act({ status: "waiting", alert: alertOf("waiting", "Wants to use Bash") })
  ],
  [
    "starting, waiting: waiting",
    act(),
    sig("waiting", BASIC_ALERT_TEXT, "bel"),
    act({ status: "waiting", alert: alertOf("waiting", BASIC_ALERT_TEXT, "bel") })
  ],
  [
    "idle, approval: waiting with the approval",
    IDLE_DONE,
    sig("approval", "exec: npm test", "openclaw"),
    act({ status: "waiting", turnDone: true, alert: alertOf("approval", "exec: npm test", "openclaw") })
  ],
  [
    "waiting, new text: the alert is replaced",
    WAITING,
    sig("waiting", "Has a question for you"),
    act({ status: "waiting", alert: alertOf("waiting", "Has a question for you") })
  ],
  ["waiting, the same alert again: it keeps the time it began", WAITING, sig("waiting", BASIC_ALERT_TEXT, "osc"), WAITING],
  [
    "waiting from a hook, a basic bell: the specific alert stays (same kind, text and time; M4)",
    act({ status: "waiting", alert: alertOf("waiting", "Wants to use Bash") }),
    sig("waiting", BASIC_ALERT_TEXT, "bel"),
    act({ status: "waiting", alert: alertOf("waiting", "Wants to use Bash") })
  ],
  [
    "waiting for an approval, a basic OSC 9: the approval stays (M4)",
    act({ status: "waiting", alert: alertOf("approval", "exec: npm test", "openclaw") }),
    sig("waiting", BASIC_ALERT_TEXT, "osc"),
    act({ status: "waiting", alert: alertOf("approval", "exec: npm test", "openclaw") })
  ],
  [
    "waiting for a Codex approval (its own OSC 9 words, source osc), a basic bell: Codex's words stay (A-M9)",
    act({ status: "waiting", alert: alertOf("waiting", "Approval requested: rm -rf build", "osc") }),
    sig("waiting", BASIC_ALERT_TEXT, "bel"),
    act({ status: "waiting", alert: alertOf("waiting", "Approval requested: rm -rf build", "osc") })
  ],
  [
    "waiting for a Codex approval (OSC 9), a basic OSC 99 or 777: Codex's words stay (A-M9)",
    act({ status: "waiting", alert: alertOf("waiting", "Approval requested: rm -rf build", "osc") }),
    sig("waiting", BASIC_ALERT_TEXT, "osc"),
    act({ status: "waiting", alert: alertOf("waiting", "Approval requested: rm -rf build", "osc") })
  ],
  [
    "waiting for a basic OSC 9, Codex's approval (OSC 9 with its own words): the specific words replace the basic ones",
    act({ status: "waiting", alert: alertOf("waiting", BASIC_ALERT_TEXT, "osc") }),
    sig("waiting", "Approval requested: rm -rf build", "osc"),
    act({ status: "waiting", alert: alertOf("waiting", "Approval requested: rm -rf build", "osc") })
  ],
  [
    "waiting for a basic bell, a specific approval: it replaces the basic alert (M4 only protects specific alerts)",
    WAITING,
    sig("approval", "exec: npm test", "openclaw"),
    act({ status: "waiting", alert: alertOf("approval", "exec: npm test", "openclaw") })
  ],
  ["held, waiting: stays held", HELD, sig("waiting", "Wants to use Bash"), HELD],
  [
    "held, held without a reset time: keeps the known reset time and the alert (M2)",
    HELD,
    { type: "held", resetAt: null, text: LIMIT_TEXT, source: "status", at: AT },
    HELD
  ],
  [
    "held, held with new text and no reset time: the alert is replaced, the known reset time stays (M2)",
    HELD,
    { type: "held", resetAt: null, text: "Usage limit reached", source: "text", at: AT },
    { ...HELD, alert: { kind: "limit", text: "Usage limit reached", at: AT, source: "text" } }
  ],
  ["waiting, resolved: live", WAITING, sig("resolved"), act({ status: "live" })],
  ["live, resolved: no change", act({ status: "live" }), sig("resolved"), act({ status: "live" })],
  ["live, the first source signal: turn-done", act({ status: "live" }), { type: "source_seen" }, act({ status: "live", turnDone: true })],
  ["turn-done idle, a new turn: live", IDLE_DONE, { type: "new_turn" }, act({ status: "live", turnDone: true })],
  ["waiting, a new turn: stays waiting (a subagent's tool hook)", WAITING, { type: "new_turn" }, WAITING],
  [
    "live, held: held with the limit alert and the reset time",
    act({ status: "live" }),
    { type: "held", resetAt: "2026-10-29T13:00:00Z", text: LIMIT_TEXT, source: "hook", at: AT },
    act({ status: "held", resetAt: RESET, alert: alertOf("limit", LIMIT_TEXT) })
  ],
  [
    "waiting, held: held, the limit replaces the question",
    WAITING,
    { type: "held", resetAt: null, text: LIMIT_TEXT, source: "text", at: AT },
    act({ status: "held", alert: alertOf("limit", LIMIT_TEXT, "text") })
  ],
  ["held, the reset time passed (held_cleared): idle", HELD, { type: "held_cleared" }, act({ status: "idle" })],
  ["live, held_cleared: no change", act({ status: "live" }), { type: "held_cleared" }, act({ status: "live" })],
  ["held, the process ends: exited, the alert and the reset time cleared", HELD, { type: "exit" }, act({ status: "exited" })],
  ["exited, user input: stays exited", act({ status: "exited" }), { type: "input" }, act({ status: "exited" })]
];

test("constants: the kinds, sources and limits the SP4 contract names", () => {
  assert.deepEqual(SIGNAL_KINDS, ["waiting", "turn_done", "limit", "approval", "resolved"]);
  assert.deepEqual(ALERT_KINDS, ["waiting", "approval", "limit"]);
  assert.deepEqual(SIGNAL_SOURCES, ["hook", "status", "poll", "osc", "bel", "title", "text", "openclaw"]);
  for (const list of [SIGNAL_KINDS, ALERT_KINDS, SIGNAL_SOURCES]) assert.equal(Object.isFrozen(list), true);
  assert.equal(ALERT_TEXT_MAX, 200);
  assert.equal(BASIC_ALERT_TEXT, "May need you");
  assert.equal(TURN_DONE_BACKSTOP_MS, 120000);
  assert.equal(HELD_CHECK_MS, 60000);
  assert.equal(MARKERS_MAX, 500);
  assert.equal(ALERT_LINE_PREFIX, "AGENT_OS_ALERT:");
});

test("cleanAlertText: control characters go, tabs and newlines become spaces, runs of spaces collapse, and a text cut to 200 code points ends in an ellipsis (199 and the sign)", () => {
  assert.equal(cleanAlertText("  Wants\tto\nuse \u001b[31mBash\u0007  "), "Wants to use [31mBash");
  assert.equal(cleanAlertText("a\u0085b\u009bc\u007fd"), "abcd", "C1 and DEL go");
  assert.equal(cleanAlertText("one\r\ntwo"), "one two");
  assert.equal(cleanAlertText(null), "");
  assert.equal(cleanAlertText(undefined), "");
  assert.equal(cleanAlertText(42), "42");
  assert.equal(cleanAlertText("x".repeat(250)), `${"x".repeat(199)}…`, "a cut text keeps 199 code points and the sign");
  assert.equal(cleanAlertText("x".repeat(200)), "x".repeat(200), "exactly 200 fits: nothing is cut, no sign");
  assert.equal(cleanAlertText("x".repeat(201)), `${"x".repeat(199)}…`, "201 is cut");
  assert.equal(cleanAlertText("abcdef", 3), "ab…");
  assert.equal(cleanAlertText("abc", 3), "abc");
  assert.equal(cleanAlertText("abcdef", 1), "…");
  assert.equal(cleanAlertText("abcdef", 0), "", "no room for even the sign");
  const faces = cleanAlertText("😀".repeat(201));
  assert.equal(Array.from(faces).length, 200, "cut by code points: 200 at most, the sign included");
  assert.equal(faces, `${"😀".repeat(199)}…`, "no character is split");
  assert.equal(faces.endsWith("…"), true);
  // The sign is counted: the cleaned text is cut after cleaning, so control characters and runs of spaces do not use it up.
  assert.equal(cleanAlertText(`${"x".repeat(150)}${"\u0007".repeat(40)}${"x".repeat(50)}`), "x".repeat(200), "raw length 240, cleaned length 200: not cut");
});

test("cleanAlertText: every invisible reordering character goes (the bidi embeddings, overrides and isolates, the two direction marks and the Arabic letter mark), and nothing a word or an emoji needs", () => {
  const reordering = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
  for (const code of reordering) {
    const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    assert.equal(cleanAlertText(`rm${String.fromCodePoint(code)} -rf build`), "rm -rf build", hex);
  }
  assert.equal(cleanAlertText(`${String.fromCodePoint(...reordering)}ok${String.fromCodePoint(...reordering)}`), "ok", "all twelve together");
  assert.equal(cleanAlertText("run \u202Etxt.sh\u202C now"), "run txt.sh now", "a right-to-left override can't make a name read backwards");
  assert.equal(cleanAlertText("a \u200E \u200F b"), "a b", "the spaces around a removed character still collapse");
  // Neighbours that stay: the zero width joiner an emoji family needs, and a plain Arabic letter.
  assert.equal(cleanAlertText("👨\u200D👩\u200D👧"), "👨\u200D👩\u200D👧");
  assert.equal(cleanAlertText("ال"), "ال");
});

test("makeSignal: a frozen signal with cleaned text and an ISO time; resetAt only for a limit; a caller's bug is a TypeError", () => {
  const signal = makeSignal({ sessionId: SID, kind: "waiting", text: " Wants to use\nBash ", source: "hook", at: "2026-10-29T10:00:00Z" });
  assert.deepEqual(signal, { sessionId: SID, kind: "waiting", text: "Wants to use Bash", at: EARLIER, source: "hook", resetAt: null });
  assert.equal(Object.isFrozen(signal), true);
  assert.equal(makeSignal({ sessionId: SID, kind: "limit", source: "text", resetAt: "2026-10-29T13:00:00Z" }).resetAt, RESET);
  assert.equal(makeSignal({ sessionId: SID, kind: "limit", source: "text", resetAt: "soon" }).resetAt, null);
  assert.equal(makeSignal({ sessionId: SID, kind: "waiting", source: "bel", resetAt: RESET }).resetAt, null, "only a limit has a reset time");
  const fresh = makeSignal({ sessionId: SID, kind: "resolved", source: "title" });
  assert.ok(Math.abs(Date.parse(fresh.at) - Date.now()) < 5000, "the time defaults to now");
  assert.equal(fresh.text, "");
  for (const bad of [
    { kind: "waiting", source: "hook" },
    { sessionId: "", kind: "waiting", source: "hook" },
    { sessionId: SID, kind: "done", source: "hook" },
    { sessionId: SID, kind: "waiting", source: "email" },
    { sessionId: SID, kind: "waiting", source: "hook", at: "yesterday" }
  ]) {
    assert.throws(() => makeSignal(bad), TypeError, JSON.stringify(bad));
  }
});

test("genericMirrorSignal: BEL and OSC 9, 99 and 777 are a basic 'May need you' (R19); an OSC 9;4 progress report and anything else are not alerts", () => {
  assert.deepEqual(genericMirrorSignal("bel"), { kind: "waiting", text: BASIC_ALERT_TEXT, source: "bel" });
  for (const raw of ["9;Build finished", "99;i=1;Done", "777;notify;Codex;Turn complete"]) {
    assert.deepEqual(genericMirrorSignal(raw), { kind: "waiting", text: BASIC_ALERT_TEXT, source: "osc" }, raw);
  }
  for (const raw of ["9;4;1;50", "9;4", "0;a title", "", undefined, null, 9]) {
    assert.equal(genericMirrorSignal(raw), null, String(raw));
  }
});

test("freshActivity: starting, basic, no alert; an unknown state is a TypeError", () => {
  assert.deepEqual(freshActivity(), { status: "starting", turnDone: false, idleBy: null, resetAt: null, alert: null });
  assert.equal(freshActivity("live").status, "live");
  assert.throws(() => freshActivity("busy"), TypeError);
});

test("activityAfter: every row of the spec's transition table (with K4), and it never changes the activity it is given", () => {
  for (const [label, from, event, expected] of TABLE) {
    const frozen = deepFreeze(from);
    const next = activityAfter(frozen, event);
    assert.deepEqual(next, expected, label);
    assert.notEqual(next, frozen, `${label}: a new object`);
  }
  assert.deepEqual(activityAfter(undefined, { type: "output" }), act({ status: "live" }), "no activity yet counts as starting");
});

test("activityAfter: a turn-done session stays idle through redraws and status line refreshes and leaves idle only on user input or a new-turn hook (spec SP4 done when)", () => {
  let activity = activityAfter(act({ status: "live" }), { type: "source_seen" });
  activity = activityAfter(activity, sig("turn_done"));
  assert.deepEqual(activity, IDLE_DONE);
  for (let i = 0; i < 50; i += 1) {
    activity = activityAfter(activity, { type: "output" }); // a redraw, a status line refresh
    activity = activityAfter(activity, { type: "counted" }); // even one the mirror counted
  }
  assert.deepEqual(activity, IDLE_DONE, "redraws and status line refreshes never wake it");
  assert.equal(activityAfter(activity, { type: "input" }).status, "live");
  assert.equal(activityAfter(activity, { type: "new_turn" }).status, "live");
  assert.equal(activityAfter(IDLE_BASIC, { type: "counted" }).status, "live", "a basic session still wakes on counted output");
});

test("A-I1: the poller's idle (source poll) ends a turn but never makes a session turn-done: it stays basic, counted output wakes it, and only a hook or an OSC 9 turn_done switches the turn-done rules on", () => {
  for (const source of ["poll", "status", "bel", "title", "text", "openclaw"]) {
    const idle = activityAfter(act({ status: "live" }), sig("turn_done", "", source));
    assert.deepEqual(idle, act({ status: "idle", idleBy: "turn_done" }), source);
    assert.equal(activityAfter(idle, { type: "counted" }).status, "live", `${source}: a basic session wakes on counted output`);
  }
  // Once a hook has spoken, the session is turn-done and a later poll idle changes nothing about that.
  const fromHook = activityAfter(act({ status: "live" }), sig("turn_done", "", "hook"));
  assert.equal(fromHook.turnDone, true);
  const live = activityAfter(fromHook, { type: "input" });
  assert.equal(activityAfter(live, sig("turn_done", "", "poll")).turnDone, true, "turn-done stays");
});

test("activityAfter: held stays held through output, signals and new turns, and clears only on user input or held_cleared", () => {
  for (const event of [
    { type: "output" },
    { type: "counted" },
    { type: "idle_timer" },
    { type: "new_turn" },
    { type: "source_seen" },
    sig("turn_done"),
    sig("waiting", "Wants to use Bash"),
    sig("approval", "exec: npm test", "openclaw"),
    sig("resolved")
  ]) {
    const next = activityAfter(HELD, event);
    assert.equal(next.status, "held", JSON.stringify(event));
    assert.deepEqual(next.alert, LIMIT, JSON.stringify(event));
    assert.equal(next.resetAt, RESET, JSON.stringify(event));
  }
  assert.deepEqual(activityAfter(HELD, { type: "input" }), act({ status: "live" }));
  assert.deepEqual(activityAfter(HELD, { type: "held_cleared" }), act({ status: "idle" }));
  const later = activityAfter(HELD, { type: "held", resetAt: "2026-10-29T15:00:00.000Z", text: LIMIT_TEXT, source: "status", at: AT });
  assert.deepEqual(later, { ...HELD, resetAt: "2026-10-29T15:00:00.000Z" }, "a later reset time keeps the alert and its first time");
});

test("activityAfter: an unknown event, an unknown source and a limit signal are TypeErrors (a limit goes through the limit rule)", () => {
  assert.throws(() => activityAfter(act(), { type: "bogus" }), TypeError);
  assert.throws(() => activityAfter(act(), undefined), TypeError);
  assert.throws(() => activityAfter(act({ status: "live" }), sig("limit", LIMIT_TEXT)), TypeError);
  assert.throws(() => activityAfter(act({ status: "live" }), sig("waiting", "x", "email")), TypeError);
  assert.throws(() => activityAfter(act({ status: "live" }), { type: "held", text: LIMIT_TEXT, source: "email", at: AT }), TypeError);
});

test("alertLine: one JSON line, keys in order, text cleaned and cut to 200 code points (R21)", () => {
  assert.equal(
    alertLine({ sessionId: SID, agent: "Codex", kind: "approval", text: "  Approval requested:\tnpm   test " }),
    `AGENT_OS_ALERT:{"sessionId":"${SID}","agent":"Codex","kind":"approval","text":"Approval requested: npm test"}`
  );
  const long = alertLine({ sessionId: SID, agent: "Claude Code", kind: "waiting", text: `Wants to use\nBash\u0007${"x".repeat(300)}` });
  assert.equal(long.includes("\n"), false, "one line");
  assert.ok(long.startsWith(ALERT_LINE_PREFIX));
  const payload = JSON.parse(long.slice(ALERT_LINE_PREFIX.length));
  assert.deepEqual(Object.keys(payload), ["sessionId", "agent", "kind", "text"]);
  assert.equal(payload.text, `${`Wants to use Bash${"x".repeat(300)}`.slice(0, 199)}…`, "cut at 199 and the sign (the line carries the same text as the tab and the toast)");
  const faces = JSON.parse(alertLine({ sessionId: SID, agent: "Hermes", kind: "waiting", text: "😀".repeat(250) }).slice(ALERT_LINE_PREFIX.length));
  assert.equal(faces.text, `${"😀".repeat(199)}…`);
});

test("printAlertLine: writes the line and one newline for waiting, approval and limit only, and never throws", () => {
  const written = [];
  const write = (line) => written.push(line);
  for (const kind of ["waiting", "approval", "limit"]) {
    printAlertLine({ sessionId: SID, agent: "OpenClaw", kind, text: "exec: npm test" }, write);
  }
  for (const payload of [{ sessionId: SID, agent: "Codex", kind: "turn_done", text: "" }, { kind: "resolved" }, null, undefined]) {
    printAlertLine(payload, write);
  }
  assert.deepEqual(written, [
    `AGENT_OS_ALERT:{"sessionId":"${SID}","agent":"OpenClaw","kind":"waiting","text":"exec: npm test"}\n`,
    `AGENT_OS_ALERT:{"sessionId":"${SID}","agent":"OpenClaw","kind":"approval","text":"exec: npm test"}\n`,
    `AGENT_OS_ALERT:{"sessionId":"${SID}","agent":"OpenClaw","kind":"limit","text":"exec: npm test"}\n`
  ]);
  assert.doesNotThrow(() =>
    printAlertLine({ sessionId: SID, agent: "Codex", kind: "waiting", text: "x" }, () => {
      throw new Error("EPIPE");
    })
  );
});

test("makeMarker: prompt markers are label only (R23), permission text is cleaned, files are checked, anything else is null", () => {
  assert.deepEqual(makeMarker({ type: "prompt", at: AT, text: "my secret prompt" }), { at: AT, type: "prompt" });
  assert.deepEqual(makeMarker({ type: "permission", at: AT, text: "Wants to use\nBash" }), { at: AT, type: "permission", text: "Wants to use Bash" });
  assert.deepEqual(
    makeMarker({
      type: "files",
      at: AT,
      files: [
        { path: "src/a.js", added: 3, removed: 1 },
        { path: "img.png", added: null, removed: null },
        { path: "" },
        null,
        { path: "b\u0007.js", added: -1, removed: 2.5 }
      ],
      more: 4
    }),
    {
      at: AT,
      type: "files",
      files: [
        { path: "src/a.js", added: 3, removed: 1 },
        { path: "img.png", added: null, removed: null },
        { path: "b.js", added: null, removed: null }
      ],
      more: 4
    }
  );
  assert.deepEqual(makeMarker({ type: "files", at: AT }), { at: AT, type: "files", files: [], more: 0 });
  for (const bad of [{ type: "shell", at: AT }, null, "prompt", {}]) assert.equal(makeMarker(bad), null, JSON.stringify(bad));
  const fresh = makeMarker({ type: "prompt" });
  assert.ok(Math.abs(Date.parse(fresh.at) - Date.now()) < 5000, "the time defaults to now");
});
