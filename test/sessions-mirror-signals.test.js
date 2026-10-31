// Signals from the mirror (spec SP4 "Signals" and "Limit rule per agent";
// rulings R12-R15, R17 and R19; contract K2): what a BEL, an OSC 9, 99 or 777
// notification, Hermes's window title and the Claude Code and Codex limit
// texts on screen mean for each agent, and the two limit rules. Pure
// functions only: no terminal, no process, and no clock but the one each test
// gives. Times are built in this computer's own time zone, as the agents print
// them, so the tests pass in every zone.
import assert from "node:assert/strict";
import test from "node:test";
import { LIMIT_MESSAGE } from "../server/runtime/builders/limits.js";
import {
  CLAUDE_SCREEN_LIMIT,
  CODEX_LIMIT_CONFIRM_MS,
  CODEX_SCREEN_LIMIT,
  CODEX_WAITING_PREFIXES,
  LIMIT_CONFIRM_WINDOW_MS,
  LIMIT_SCAN_MS,
  classifyMirrorAlert,
  classifyTitle,
  codexLimitConfirmed,
  createClaudeLimitRule,
  matchScreenLimit,
  parseResetText
} from "../server/runtime/sessions/mirror-signals.js";
import { BASIC_ALERT_TEXT, cleanAlertText } from "../server/runtime/sessions/signals.js";

const AGENTS = ["claude", "codex", "cursor", "hermes", "openclaw"];
const local = (month, day, hour, minute) => new Date(2026, month - 1, day, hour, minute, 0, 0);
const iso = (date) => date.toISOString();
// Thursday 2026-10-29, 10:00 in this computer's time zone.
const NOW = local(10, 29, 10, 0).getTime();
const BASIC = { kind: "waiting", text: BASIC_ALERT_TEXT, source: "osc", sourceSeen: false };

test("constants: the Codex waiting prefixes, the 120 s window, the 5 s Codex confirmation, the 1 s screen read, and the hold sentences", () => {
  assert.deepEqual(CODEX_WAITING_PREFIXES, ["Approval requested: ", "Approval requested by ", "Codex wants to edit ", "Plan mode prompt: "]);
  assert.ok(Object.isFrozen(CODEX_WAITING_PREFIXES));
  assert.equal(LIMIT_CONFIRM_WINDOW_MS, 120000);
  assert.equal(CODEX_LIMIT_CONFIRM_MS, 5000);
  assert.equal(LIMIT_SCAN_MS, 1000);
  assert.equal(BASIC_ALERT_TEXT, "May need you");
  assert.equal(LIMIT_MESSAGE.claude, "Claude Code's plan limit was reached.");
  assert.equal(LIMIT_MESSAGE.codex, "Codex's plan limit was reached.");
  assert.ok(CLAUDE_SCREEN_LIMIT.test("You’ve hit your weekly limit · resets Mon 12:00am"));
  // R13a: the two lines Claude Code 2.1.292 prints that R13's pattern missed (the first is the SP3 fixture from a real limit).
  assert.ok(CLAUDE_SCREEN_LIMIT.test("You've hit your limit · resets 6:50pm (Europe/Berlin)"));
  assert.ok(CLAUDE_SCREEN_LIMIT.test("You’ve hit your limit · resets 6:50pm (Europe/Berlin)"));
  assert.ok(CLAUDE_SCREEN_LIMIT.test("You're out of usage credits · resets 6:50pm (Europe/Berlin)"));
  assert.ok(CLAUDE_SCREEN_LIMIT.test("You’re out of usage credits · resets 6:50pm (Europe/Berlin)"));
  assert.equal(CLAUDE_SCREEN_LIMIT.test("You've used 85% of your session limit · resets 3:45pm"), false, "the usage warning is not a limit");
  assert.ok(CODEX_SCREEN_LIMIT.test("You're out of credits."));
});

test("classifyMirrorAlert: a BEL is a basic waiting alert for every agent; an OSC 9;4 progress report and anything that is not an alert mean nothing", () => {
  for (const agentId of AGENTS) {
    assert.deepEqual(classifyMirrorAlert(agentId, "bel"), { kind: "waiting", text: BASIC_ALERT_TEXT, source: "bel", sourceSeen: false }, agentId);
    assert.equal(classifyMirrorAlert(agentId, "9;4;1;50"), null, `${agentId}: a progress report`);
    assert.equal(classifyMirrorAlert(agentId, "9;4;0;"), null, `${agentId}: progress cleared`);
  }
  for (const odd of [undefined, null, 9, "", "ding", "9", "0;a title", "8;;https://example.test"]) {
    assert.equal(classifyMirrorAlert("codex", odd), null, String(odd));
  }
});

test("classifyMirrorAlert: Codex's OSC 9 is read by its text (R14): its four waiting starts mean waiting, any other text ends a turn, and both make it a turn-done session", () => {
  const waiting = [
    "Approval requested: npm test",
    "Approval requested by github",
    "Codex wants to edit src/app.ts",
    "Codex wants to edit 3 files",
    "Plan mode prompt: Which database?",
    "Plan mode prompt: 2 questions requested"
  ];
  for (const text of waiting) {
    assert.deepEqual(classifyMirrorAlert("codex", `9;${text}`), { kind: "waiting", text, source: "osc", sourceSeen: true }, text);
  }
  for (const text of ["Agent turn complete", "All 42 tests pass and the build is green.", "Approval requested", "approval requested: lower case is an answer"]) {
    assert.deepEqual(classifyMirrorAlert("codex", `9;${text}`), { kind: "turn_done", text, source: "osc", sourceSeen: true }, text);
  }
  // Codex's text is cleaned like every alert text: no control characters, at most 200 characters.
  const long = classifyMirrorAlert("codex", `9;Approval requested: ${"x".repeat(500)}\x1b[31m`);
  assert.equal(long.kind, "waiting");
  assert.equal([...long.text].length, 200);
  assert.equal(/[\x00-\x1f\x7f]/.test(long.text), false);
});

test("classifyMirrorAlert: OSC 9, 99 and 777 from Claude Code, Cursor, Hermes and OpenClaw, and Codex's OSC 99 and 777, are basic alerts that never make a session turn-done (R12, R19)", () => {
  for (const agentId of ["claude", "cursor", "hermes", "openclaw"]) {
    for (const raw of ["9;Approval requested: npm test", "9;Hermes: approval", "99;i=cursor:d=0;Cursor needs your input", "777;notify;Cursor;Cursor is waiting for you"]) {
      assert.deepEqual(classifyMirrorAlert(agentId, raw), BASIC, `${agentId} ${raw}`);
    }
  }
  for (const raw of ["99;;Done", "777;notify;Codex;Waiting"]) {
    assert.deepEqual(classifyMirrorAlert("codex", raw), BASIC, raw);
  }
});

test("classifyTitle: a Hermes title starting with ⚠ means waiting, and the marker gone resolves only a wait the title started (R17); other agents' titles mean nothing", () => {
  const waiting = { kind: "waiting", text: BASIC_ALERT_TEXT, source: "title" };
  const resolved = { kind: "resolved", text: "", source: "title" };
  for (const title of ["⚠ fix-tests · glm-5.3 · ~/app", "⚠️ fix-tests · glm-5.3 · ~/app", "  ⚠ fix-tests"]) {
    assert.deepEqual(classifyTitle("hermes", title, { waitingFromTitle: false }), waiting, title);
    assert.deepEqual(classifyTitle("hermes", title, { waitingFromTitle: true }), waiting, title);
  }
  assert.deepEqual(classifyTitle("hermes", "⚠ fix-tests"), waiting, "the option may be left out");
  for (const title of ["⏳ fix-tests · glm-5.3 · ~/app", "✓ fix-tests · glm-5.3 · ~/app", "Hermes", "", "fix ⚠ later"]) {
    assert.deepEqual(classifyTitle("hermes", title, { waitingFromTitle: true }), resolved, title);
    assert.equal(classifyTitle("hermes", title, { waitingFromTitle: false }), null, title);
  }
  for (const agentId of ["claude", "codex", "cursor", "openclaw"]) {
    assert.equal(classifyTitle(agentId, "⚠ fix-tests", { waitingFromTitle: false }), null, agentId);
    assert.equal(classifyTitle(agentId, "✓ done", { waitingFromTitle: true }), null, agentId);
  }
  assert.equal(classifyTitle("hermes", null, { waitingFromTitle: true }), null);
});

test("matchScreenLimit: Claude Code's limit lines (R13) are found with their reset time; the usage warning, the reset notice and other agents' screens are not", () => {
  const cases = [
    ["You've hit your session limit · resets 3:45pm", "3:45pm"],
    ["You’ve hit your weekly limit · resets Mon 12:00am", "Mon 12:00am"],
    ["You've hit your Opus limit · resets 3:45pm", "3:45pm"],
    ["You've hit your 5-hour limit · resets 11pm", "11pm"],
    // R13a: the generic line of the owner's five-hour limit (the SP3 fixture's exact text), and the credits line.
    ["You've hit your limit · resets 6:50pm (Europe/Berlin)", "6:50pm"],
    ["You're out of usage credits · resets 6:50pm (Europe/Berlin)", "6:50pm"],
    ["  ⎿  Usage limit reached · limit resets 3:45pm", "3:45pm"],
    ["Usage limit reached · continuing automatically at 3:45pm · esc to cancel", null]
  ];
  for (const [line, resetText] of cases) {
    const screen = `╭ Claude Code\n> fix the tests\n${line}\n\n? for shortcuts`;
    assert.deepEqual(matchScreenLimit("claude", screen), { line: cleanAlertText(line), resetText, count: 1 }, line);
  }
  for (const line of ["You've used 85% of your session limit · resets 3:45pm", "Usage limit reset · Continuing automatically", "Your usage limit has reset"]) {
    assert.equal(matchScreenLimit("claude", `> hi\n${line}\n`), null, line);
  }
  // The newest line is the lowest one.
  const two = "You've hit your session limit · resets 1:00pm\n> again\nYou've hit your weekly limit · resets Mon 12:00am";
  assert.equal(matchScreenLimit("claude", two).resetText, "Mon 12:00am");
  assert.equal(matchScreenLimit("claude", two).count, 2, "every limit line on the screen is counted");
  const screen = "You've hit your session limit · resets 3:45pm\nYou've hit your usage limit. Try again at 3:45 PM.";
  for (const agentId of ["cursor", "hermes", "openclaw"]) assert.equal(matchScreenLimit(agentId, screen), null, agentId);
  assert.equal(matchScreenLimit("claude", ""), null);
  assert.equal(matchScreenLimit("claude", null), null);
});

test("matchScreenLimit: Codex's limit texts (R15) are found, with the reset time from ' Try again at <time>.' or ' or try again at <time>.', also when Codex wraps the sentence onto the next lines", () => {
  const cases = [
    ["■ You've hit your usage limit. Try again at 3:45 PM.", "3:45 PM"],
    ["■ You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 30th, 2026 3:45 PM.", "Oct 30th, 2026 3:45 PM"],
    ["■ You hit your spend cap set in your workspace. Try again later.", null],
    ["■ Your workspace is out of credits. Try again at 9:05 AM.", "9:05 AM"],
    ["■ You're out of credits. Try again at 9:05 AM.", "9:05 AM"],
    ["■ Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.", null]
  ];
  for (const [line, resetText] of cases) {
    const screen = `› run the tests\n\n${line}\n\n› `;
    assert.deepEqual(matchScreenLimit("codex", screen), { line: cleanAlertText(line), resetText, count: 1 }, line);
  }
  const wrapped = [
    "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit",
    "  https://chatgpt.com/codex/settings/usage to purchase more credits or try again",
    "  at 3:45 PM.",
    "",
    "› "
  ].join("\n");
  assert.deepEqual(matchScreenLimit("codex", wrapped), { line: cleanAlertText(wrapped.split("\n")[0]), resetText: "3:45 PM", count: 1 });
  // Each agent's own words only.
  assert.equal(matchScreenLimit("codex", "You've hit your session limit · resets 3:45pm"), null);
  assert.equal(matchScreenLimit("claude", "You hit your spend cap set in your workspace."), null);
});

test("A-I2: matchScreenLimit for Codex counts only its own error row (the '■' row), not a search result, a diff line or a file view that quotes the sentence; the plain-text pattern still finds the sentence anywhere", () => {
  const quotes = [
    '• Ran rg -n "Usage limit reached" server',
    "  └ server/runtime/sessions/mirror-signals.js:36: /You’ve hit your usage limit|You hit your spend cap/;",
    '+  throw new Error("Your workspace is out of credits. Try again at 3:45 PM.");',
    "     // You’re out of credits",
    "- Usage limit reached",
    "You’ve hit your usage limit. Try again at 3:45 PM."
  ];
  for (const quote of quotes) assert.equal(matchScreenLimit("codex", `› search\n\n${quote}\n\n› `), null, quote);
  assert.equal(matchScreenLimit("codex", quotes.join("\n")), null);
  const own = "■ You’ve hit your usage limit. Try again at 3:45 PM.";
  assert.deepEqual(matchScreenLimit("codex", `${quotes.join("\n")}\n${own}\n\n› `), { line: cleanAlertText(own), resetText: "3:45 PM", count: 1 }, "only the error row is counted");
  assert.equal(matchScreenLimit("codex", `  ■ Usage limit reached. You've reached your usage limit.`)?.count, 1, "an indented row too");
  assert.equal(matchScreenLimit("codex", "■ something else went wrong"), null);
  for (const quote of quotes) assert.ok(CODEX_SCREEN_LIMIT.test(quote), `the plain-text pattern still finds: ${quote}`);
});

test("parseResetText: a clock time is today or, once past, tomorrow; a weekday is the next one; a full date is that day; anything else is unknown", () => {
  assert.equal(parseResetText("3:45pm", NOW), iso(local(10, 29, 15, 45)));
  assert.equal(parseResetText("3:45 PM", NOW), iso(local(10, 29, 15, 45)));
  assert.equal(parseResetText("11pm", NOW), iso(local(10, 29, 23, 0)));
  assert.equal(parseResetText("9:05 AM", NOW), iso(local(10, 30, 9, 5)), "already past today: tomorrow");
  assert.equal(parseResetText("10:00am", NOW), iso(local(10, 30, 10, 0)), "exactly now counts as past");
  assert.equal(parseResetText("12:00am", NOW), iso(local(10, 30, 0, 0)), "midnight");
  assert.equal(parseResetText("12:30pm", NOW), iso(local(10, 29, 12, 30)), "half past noon");
  assert.equal(parseResetText("Mon 12:00am", NOW), iso(local(11, 2, 0, 0)));
  assert.equal(parseResetText("Thu 9:00am", NOW), iso(local(11, 5, 9, 0)), "today's weekday, already past: next week");
  assert.equal(parseResetText("Thu 4:00pm", NOW), iso(local(10, 29, 16, 0)), "today's weekday, still ahead: today");
  assert.equal(parseResetText("Oct 30th, 2026 3:45 PM", NOW), iso(local(10, 30, 15, 45)));
  assert.equal(parseResetText("Nov 1st, 2026 8:00 AM", NOW), iso(local(11, 1, 8, 0)));
  for (const odd of [null, undefined, "", "later", "13:00pm", "3:75pm", "15:45", "Feb 30th, 2026 3:45 PM", "Xyz 3:45pm", 42]) {
    assert.equal(parseResetText(odd, NOW), null, String(odd));
  }
});

test("Claude limit rule (K2): one signal never holds; a limit hook and the limit text within 120 s do, and so does either one with the status line at 100 %", () => {
  let clock = NOW;
  const now = () => clock;
  const at1545 = iso(local(10, 29, 15, 45));
  const at1500 = iso(local(10, 29, 15, 0));

  let rule = createClaudeLimitRule({ now });
  assert.deepEqual(rule.add({ source: "hook" }), { held: false, resetAt: null, cleared: false });
  clock += 1000;
  assert.equal(rule.add({ source: "hook" }).held, false, "two hooks are not two different signals");
  rule = createClaudeLimitRule({ now });
  assert.equal(rule.add({ source: "text", text: "You've hit your session limit", resetAt: null }).held, false);
  assert.equal(rule.add({ source: "text", text: "again", resetAt: null }).held, false, "two texts are not either");
  rule = createClaudeLimitRule({ now });
  assert.equal(rule.add({ source: "status", atLimit: true, resetAt: at1500 }).held, false, "the status line alone is not a first signal");

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "hook" });
  clock += LIMIT_CONFIRM_WINDOW_MS;
  assert.deepEqual(rule.add({ source: "text", text: "x", resetAt: at1545 }), { held: true, resetAt: at1545, cleared: false });

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "text", text: "x", resetAt: null });
  clock += 5000;
  assert.deepEqual(rule.add({ source: "hook" }), { held: true, resetAt: null, cleared: false });

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "hook" });
  clock += LIMIT_CONFIRM_WINDOW_MS + 1;
  assert.equal(rule.add({ source: "text", text: "x", resetAt: null }).held, false, "more than 120 s apart");

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "status", atLimit: true, resetAt: at1500 });
  clock += 10 * 60 * 1000; // a level, not a moment: still at 100 % ten minutes later
  rule.add({ source: "text", text: "x", resetAt: at1545 });
  assert.deepEqual(rule.add({ source: "hook" }), { held: true, resetAt: at1500, cleared: false }, "the status line's reset time wins");
});

test("Claude limit rule: the status line below 100 % clears a hold it confirmed, never one the hook and the text confirmed alone; reset() uses up the first signals and keeps the status level", () => {
  let clock = NOW;
  const now = () => clock;
  let rule = createClaudeLimitRule({ now });
  rule.add({ source: "hook" });
  assert.equal(rule.add({ source: "status", atLimit: true, resetAt: null }).held, true);
  assert.deepEqual(rule.add({ source: "status", atLimit: false }), { held: false, resetAt: null, cleared: true });
  assert.equal(rule.add({ source: "status", atLimit: false }).cleared, false, "only once");

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "hook" });
  assert.equal(rule.add({ source: "text", text: "x", resetAt: null }).held, true);
  assert.deepEqual(
    rule.add({ source: "status", atLimit: false }),
    { held: true, resetAt: null, cleared: false },
    "an Opus or Sonnet limit never pushes the plan windows to 100 %, so a status line below 100 % says nothing"
  );
  assert.equal(rule.add({ source: "status", atLimit: true, resetAt: null }).held, true);
  assert.equal(rule.add({ source: "status", atLimit: false }).cleared, true, "once the status line reported the limit, its clearing ends the hold");

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "hook" });
  rule.add({ source: "text", text: "x", resetAt: null });
  rule.reset();
  clock += 1000;
  assert.equal(rule.add({ source: "hook" }).held, false, "after reset() the old text no longer counts");

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "status", atLimit: true, resetAt: null });
  rule.reset();
  assert.equal(rule.add({ source: "hook" }).held, true, "the status level is what the status line last said, so reset() keeps it");

  for (const odd of [null, undefined, {}, { source: "poll" }, { source: "osc" }]) {
    assert.deepEqual(createClaudeLimitRule({ now }).add(odd), { held: false, resetAt: null, cleared: false }, JSON.stringify(odd));
  }
});

test("matchScreenLimit (M3): the count is how many limit lines the screen shows, so a second identical line under the first can be told from the first alone", () => {
  const line = "You’ve hit your limit · resets 6:50pm (Europe/Berlin)";
  assert.equal(matchScreenLimit("claude", `> fix the tests\n${line}\n\n? for shortcuts`).count, 1);
  const twice = matchScreenLimit("claude", `${line}\n> try again\n${line}\n\n? for shortcuts`);
  assert.equal(twice.count, 2);
  assert.deepEqual([twice.line, twice.resetText], [cleanAlertText(line), "6:50pm"], "the newest (lowest) line still gives the line and the reset time");
  const codex = "■ You’ve hit your usage limit. Try again at 3:45 PM.";
  assert.equal(matchScreenLimit("codex", `${codex}\n› retry\n${codex}\n› `).count, 2);
  assert.equal(matchScreenLimit("claude", "> nothing here\n"), null, "no limit line: no match, so no count");
});

test("Claude limit rule (M4): a status level stops counting at the reset time it reported, so a stale report never holds a session; a level without a reset time stays", () => {
  let clock = NOW;
  const now = () => clock;
  const at1500 = iso(local(10, 29, 15, 0));
  const at0900 = iso(local(10, 29, 9, 0));

  let rule = createClaudeLimitRule({ now });
  assert.equal(rule.add({ source: "status", atLimit: true, resetAt: at1500 }).held, false);
  clock = local(10, 29, 14, 59).getTime();
  assert.equal(rule.add({ source: "hook" }).held, true, "one minute before the reset time the level still confirms a first signal");

  rule = createClaudeLimitRule({ now });
  clock = NOW;
  rule.add({ source: "status", atLimit: true, resetAt: at1500 });
  clock = local(10, 29, 15, 0).getTime();
  assert.equal(rule.add({ source: "hook" }).held, false, "at the reset time the window is open again");
  assert.deepEqual(rule.add({ source: "text", text: "x", resetAt: null }), { held: true, resetAt: null, cleared: false }, "a hook and a text still make a pair");

  rule = createClaudeLimitRule({ now });
  clock = NOW;
  rule.add({ source: "hook" });
  assert.equal(rule.add({ source: "status", atLimit: true, resetAt: at0900 }).held, false, "a report that already carries a past reset time is no limit");

  rule = createClaudeLimitRule({ now });
  rule.add({ source: "status", atLimit: true, resetAt: null });
  clock += 24 * 60 * 60 * 1000;
  assert.equal(rule.add({ source: "hook" }).held, true, "a level with no reset time stays until the status line says otherwise");
});

test("Codex limit rule (R15): only the text still on screen, the process alive and no counted output since", () => {
  for (const stillOnScreen of [true, false]) {
    for (const alive of [true, false]) {
      for (const countedSince of [true, false]) {
        assert.equal(
          codexLimitConfirmed({ stillOnScreen, alive, countedSince }),
          stillOnScreen && alive && !countedSince,
          JSON.stringify({ stillOnScreen, alive, countedSince })
        );
      }
    }
  }
});
