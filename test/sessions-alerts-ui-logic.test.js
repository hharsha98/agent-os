// SP4 Task U5: the alerts UI's pure logic. src/ui/alertsShared.ts (the top-bar badge, the Home strip, Safety's terminal
// questions, the browser message, the panel's alert lines, OpenClaw's cards and the desktop note) and the SP4 parts of
// src/ui/sessionsShared.ts (the panel's state line, the alert frame, the reset time), src/ui/sessionsPageShared.ts (the
// Live meter), src/ui/homeShared.ts (the Orbit's amber, its note and label, the lede, the agent rows) and
// src/ui/helpShared.ts (the alerts lane in words). Node strips the types itself (decision P14); every file keeps only
// `import type` imports apart from a sessionsShared.ts import written with its extension (the homeShared.ts pattern).
// No server and no browser: the pages are checked by .superpowers/ui-audit/probes/alerts.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as alerts from "../src/ui/alertsShared.ts";
import * as help from "../src/ui/helpShared.ts";
import * as home from "../src/ui/homeShared.ts";
import * as page from "../src/ui/sessionsPageShared.ts";
import * as ss from "../src/ui/sessionsShared.ts";
import * as shellToast from "../src/ui/shellToast.ts";

// 3 pm local time, so "today" and every reset time read the same in every time zone.
const NOW = new Date(2026, 9, 29, 15, 0, 0).getTime();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// A local clock time on this day (or `days` later), as the server sends it.
const at = (hours, minutes, days = 0) => new Date(2026, 9, 29 + days, hours, minutes, 0).toISOString();
const session = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", kind: "agent", agentId: "claude", agentLabel: "Claude Code",
  folder: "/Users/you/projects/my-app", folderName: "my-app", folderShown: true, branch: null, status: "live",
  stateSince: iso(60_000), startedAt: iso(760_000), endedAt: null, exitCode: null, signal: null, endedBy: null,
  dismissed: false, brain: { kind: "plan", label: "Plan" }, resume: { available: false, reason: null, fallback: false },
  nothingToResume: false, alerts: "basic", recordingBytes: 0, alert: null, idleBy: null, resetAt: null, trustNeeded: false,
  hooksOff: { alerts: null, meter: null }, meter: null, copyOf: null, handoff: null, ...over
});
const waiting = (text, over = {}) => session({ status: "waiting", alert: { kind: "waiting", text, at: iso(30_000) }, ...over });
const hermes = { agentId: "hermes", agentLabel: "Hermes", folderName: "notes" };
const claw = { agentId: "openclaw", agentLabel: "OpenClaw", folderShown: false };
const card = (over = {}) => ({ id: "ap-1", kind: "exec", summary: "npm test", createdAt: iso(20_000), expiresAt: iso(-600_000), sessionId: null, ...over });
const meter = {
  model: "Opus 4.7", contextPercent: 42.4, contextTokens: 84_000, plan: { usedPercent: 71, resetsAt: at(17, 30) },
  weekly: { usedPercent: 12, resetsAt: null }, costUsd: 1.234, at: iso(1000)
};
const installed = (id) => ({ id, label: id, homepage: "", docsUrl: "", license: "", detected: { installed: true, path: "", version: "1.0.0", features: {} } });

test("the badge counts agent sessions that wait for you; held, update and setup sessions are not counted (K22)", () => {
  const list = [
    waiting("Wants to use Bash", { id: "a" }),
    waiting("May need you", { id: "b", ...hermes }),
    session({ id: "c", status: "held", resetAt: at(17, 30) }),
    waiting("x", { id: "d", kind: "update" }),
    waiting("x", { id: "e", kind: "setup" }),
    session({ id: "f", status: "live" })
  ];
  assert.equal(alerts.waitingCount(list), 2);
  assert.equal(alerts.waitingCount([]), 0);
  assert.equal(alerts.waitingBadgeText(2), "Waiting for you (2)");
  assert.equal(alerts.waitingBadgeText(1), "Waiting for you (1)");
  assert.equal(alerts.waitingBadgeText(0), "", "no badge while nothing waits");
});

test("the Home strip: waiting first, the longest wait first, then held with its reset time; at most 3 rows", () => {
  const list = [
    session({ id: "held", status: "held", resetAt: at(17, 30) }),
    waiting("Wants to use Bash", { id: "new", alert: { kind: "waiting", text: "Wants to use Bash", at: iso(5_000) } }),
    waiting("", { id: "old", agentId: "codex", agentLabel: "Codex", folderName: "api", alert: { kind: "approval", text: "", at: iso(90_000) } }),
    session({ id: "held2", status: "held", resetAt: null, agentId: "codex", agentLabel: "Codex", folderName: "web" }),
    waiting("x", { id: "upd", kind: "update" }),
    session({ id: "idle", status: "idle" })
  ];
  assert.deepEqual(alerts.homeStripItems(list, NOW), [
    { id: "old", kind: "waiting", title: "Codex · api", text: "Waiting for you" },
    { id: "new", kind: "waiting", title: "Claude Code · my-app", text: "Wants to use Bash" },
    { id: "held", kind: "held", title: "Claude Code · my-app", text: "Plan ran out. Resets 5:30 pm." },
    { id: "held2", kind: "held", title: "Codex · web", text: "Plan ran out." }
  ]);
  assert.deepEqual(alerts.homeStripItems([], NOW), []);
  assert.equal(alerts.homeStripItems([session({ status: "held", resetAt: at(2, 21, 1) })], NOW)[0].text, "Plan ran out. Resets Oct 30, 2:21 am.");
  assert.equal(alerts.STRIP_MAX, 3);
  assert.equal(alerts.stripMore(0), "");
  assert.equal(alerts.stripMore(1), "1 more in Sessions.");
  assert.equal(alerts.stripMore(4), "4 more in Sessions.");
});

test("Safety's terminal questions: every waiting agent session except an OpenClaw one whose question is a card", () => {
  const list = [
    waiting("Wants to use Bash", { id: "claude" }),
    waiting("npm test", { id: "claw-card", ...claw, alert: { kind: "approval", text: "npm test", at: iso(10_000) } }),
    waiting("May need you", { id: "claw-bell", ...claw, alert: { kind: "waiting", text: "May need you", at: iso(5_000) } }),
    session({ id: "held", status: "held" })
  ];
  assert.deepEqual(alerts.terminalQuestions(list).map((item) => [item.id, item.title, item.text]), [
    ["claude", "Claude Code · my-app", "Wants to use Bash"],
    ["claw-bell", "OpenClaw · Set by OpenClaw", "May need you"]
  ]);
});

test("hooks switched off: one sentence per code (R9, K10), nothing for a code this version does not know", () => {
  assert.equal(alerts.hooksOffLine("all_hooks_disabled"), "Alerts and the Live meter are off for this session: your Claude settings turn off all hooks.");
  assert.equal(alerts.hooksOffLine("managed_hooks_only"), "Alerts and the Live meter are off for this session: your organization's Claude settings allow only its own hooks.");
  assert.equal(alerts.hooksOffLine("http_hook_urls"), "Alerts are off for this session: your Claude settings allow hooks to reach only the addresses they list.");
  assert.equal(alerts.hooksOffLine("http_hook_env_vars"), "Alerts are off for this session: your Claude settings don't let hooks use Agent OS's token.");
  assert.equal(alerts.hooksOffLine("managed_status_line"), "The Live meter is off for this session: your organization's Claude settings set the status line.");
  assert.equal(alerts.hooksOffLine("something_new"), "");
  assert.equal(alerts.hooksOffLine(null), "");
  assert.equal(alerts.hooksOffLine("toString"), "", "an inherited name is not a code");
});

test("the panel's alert lines: hooks off and why, the trust line, basic alerts for Hermes and Cursor (R9, R18)", () => {
  const lines = (over) => alerts.panelAlertLines(session(over));
  const TRUST = "Alerts start after you trust this folder in Claude";
  assert.equal(alerts.TRUST_LINE, TRUST);
  assert.deepEqual(lines({}), []);
  assert.deepEqual(lines({ trustNeeded: true }), [TRUST]);
  assert.deepEqual(lines({ trustNeeded: true, status: "idle" }), [TRUST]);
  assert.deepEqual(lines({ trustNeeded: true, status: "starting" }), [], "the line waits until the session is up");
  assert.deepEqual(lines({ trustNeeded: true, status: "exited" }), []);
  assert.deepEqual(
    lines({ trustNeeded: true, hooksOff: { alerts: "http_hook_urls", meter: null } }),
    ["Alerts are off for this session: your Claude settings allow hooks to reach only the addresses they list."],
    "with hooks off, trusting the folder would not bring alerts, so the trust line is not shown"
  );
  assert.deepEqual(
    lines({ hooksOff: { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" } }),
    ["Alerts and the Live meter are off for this session: your Claude settings turn off all hooks."],
    "one sentence when both are off for the same reason"
  );
  // Orchestrator ruling: with both switched off no hook or status post ever arrives, so trustNeeded stays true for good.
  // The reason lines show; "Alerts start after you trust this folder in Claude" would promise something that cannot happen.
  assert.deepEqual(
    lines({ trustNeeded: true, hooksOff: { alerts: "all_hooks_disabled", meter: "all_hooks_disabled" } }),
    ["Alerts and the Live meter are off for this session: your Claude settings turn off all hooks."],
    "both off and trustNeeded: the reason, never the trust line"
  );
  assert.deepEqual(
    lines({ trustNeeded: true, status: "idle", hooksOff: { alerts: "http_hook_env_vars", meter: "managed_status_line" } }),
    [
      "Alerts are off for this session: your Claude settings don't let hooks use Agent OS's token.",
      "The Live meter is off for this session: your organization's Claude settings set the status line."
    ],
    "both off for different reasons and trustNeeded: both reasons, no trust line"
  );
  assert.deepEqual(
    lines({ trustNeeded: true, hooksOff: { alerts: "a_code_from_a_newer_version", meter: null } }),
    [],
    "alerts are off for a reason this version has no words for: still no trust line"
  );
  assert.deepEqual(lines({ hooksOff: { alerts: "http_hook_env_vars", meter: "managed_status_line" } }), [
    "Alerts are off for this session: your Claude settings don't let hooks use Agent OS's token.",
    "The Live meter is off for this session: your organization's Claude settings set the status line."
  ]);
  assert.deepEqual(lines({ trustNeeded: true, hooksOff: { alerts: null, meter: "managed_status_line" } }), [
    "The Live meter is off for this session: your organization's Claude settings set the status line.",
    TRUST
  ]);
  assert.deepEqual(lines({ ...hermes, status: "live" }), [], "Hermes's live line already says its alerts are basic");
  assert.deepEqual(lines({ ...hermes, status: "idle" }), ["Alerts for Hermes are basic."]);
  assert.deepEqual(lines({ agentId: "cursor", agentLabel: "Cursor", status: "waiting" }), ["Alerts for Cursor are basic."]);
  assert.deepEqual(lines({ kind: "update", trustNeeded: true }), [], "update sessions never alert");
  assert.deepEqual(lines({ hooksOff: undefined, trustNeeded: undefined }), [], "a summary without the SP4 fields shows nothing");
});

test("the panel's state line, SP4 versions (spec, Session activity states; the prototype's info())", () => {
  const line = (over) => ss.sessionPanelLine(session(over), NOW);
  assert.equal(line({ status: "live", alerts: "full" }), "Working. Agent OS alerts you when it asks you something.");
  assert.equal(line({ status: "live", alerts: "basic" }), "Working. Alerts for Claude Code are basic.");
  assert.equal(line({ status: "live", alerts: "basic", agentId: "cursor", agentLabel: "Cursor" }), "Working. Alerts for Cursor are basic.");
  assert.equal(line({ status: "live", alerts: undefined }), "Working. Alerts for Claude Code are basic.", "a summary without the field is basic");
  // Fix round 1 (M3, orchestrator ruling): OpenClaw's approvals are alerts of their own (cards, polled every 3 s), so an
  // OpenClaw session says the full line even though its alerts are never "full"; Hermes and Cursor stay basic.
  assert.equal(line({ ...claw, status: "live", alerts: "basic" }), "Working. Agent OS alerts you when it asks you something.");
  assert.equal(line({ ...hermes, status: "live", alerts: "basic" }), "Working. Alerts for Hermes are basic.");
  assert.equal(line({ status: "waiting", alert: { kind: "waiting", text: "Wants to use Bash", at: iso(1000) } }), "The question is in the terminal. Agent OS never answers for you.");
  assert.equal(line({ ...claw, status: "waiting", alert: { kind: "approval", text: "npm test", at: iso(1000) } }), "The question is in the card below.");
  assert.equal(
    line({ ...claw, status: "waiting", alert: { kind: "waiting", text: "May need you", at: iso(1000) } }),
    "The question is in the terminal. Agent OS never answers for you.",
    "a bell from OpenClaw has no card"
  );
  assert.equal(line({ status: "idle", idleBy: "turn_done", stateSince: iso(26 * 60_000) }), "Ready for the next message.");
  assert.equal(line({ status: "idle", idleBy: "timer", stateSince: iso(26 * 60_000) }), "Idle for 26 m. Nothing is running.");
  assert.equal(line({ status: "idle", idleBy: null, stateSince: iso(26 * 60_000) }), "Idle for 26 m. Nothing is running.");
  assert.equal(line({ status: "held", resetAt: at(17, 30) }), "Plan limit reached. Resets 5:30 pm.");
  assert.equal(line({ status: "held", resetAt: at(2, 21, 1) }), "Plan limit reached. Resets Oct 30, 2:21 am.");
  assert.equal(line({ status: "held", resetAt: null }), "Plan limit reached.");
  assert.equal(line({ status: "held", resetAt: "not a time" }), "Plan limit reached.");
  assert.equal(ss.resetWords(at(14, 21), NOW), "2:21 pm");
  assert.equal(ss.resetWords(at(0, 5, 1), NOW), "Oct 30, 12:05 am");
  assert.equal(ss.resetWords(null, NOW), "");
  assert.equal(ss.resetWords("soon", NOW), "");
});

test("the alert frame replaces SP3's raw one; a frame of any other shape is ignored (K8)", () => {
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "alert", kind: "waiting", text: "Wants to use Bash" })), { t: "alert", kind: "waiting", text: "Wants to use Bash" });
  for (const kind of ["approval", "limit"]) assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "alert", kind, text: "x" })), { t: "alert", kind, text: "x" });
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "alert", kind: "resolved", text: "" })), { t: "alert", kind: "resolved", text: "" });
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "alert", kind: "resolved" })), { t: "alert", kind: "resolved", text: "" }, "missing text is empty");
  assert.deepEqual(ss.parseServerFrame(JSON.stringify({ t: "alert", kind: "waiting", text: 5 })), { t: "alert", kind: "waiting", text: "" });
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "alert", raw: "bel" })), null, "SP3's raw frame is gone");
  assert.equal(ss.parseServerFrame(JSON.stringify({ t: "alert", kind: "turn_done", text: "" })), null, "turn_done travels in the state frame");
});

test("the browser message: once per session that newly needs you; nothing on the first read or for new words", () => {
  const before = [session({ id: "a" }), session({ id: "b", ...hermes })];
  assert.equal(alerts.alertToast(null, [waiting("Wants to use Bash", { id: "a" })]), null, "the first read is not news");
  assert.equal(alerts.alertToast(before, before), null);
  assert.equal(alerts.alertToast(before, [waiting("Wants to use Bash", { id: "a" }), before[1]]), "Claude Code · my-app is waiting for you. Wants to use Bash.");
  assert.equal(alerts.alertToast(before, [before[0], waiting("May need you", { id: "b", ...hermes })]), "Hermes · notes may need you.");
  assert.equal(alerts.alertToast(before, [waiting("", { id: "a" }), before[1]]), "Claude Code · my-app is waiting for you.");
  assert.equal(alerts.alertToast(before, [waiting("Waiting for you", { id: "a" }), before[1]]), "Claude Code · my-app is waiting for you.");
  assert.equal(alerts.alertToast(before, [waiting("Approval requested: npm test.", { id: "a" }), before[1]]), "Claude Code · my-app is waiting for you. Approval requested: npm test.");
  assert.equal(alerts.alertToast(before, [session({ id: "a", status: "held", resetAt: at(17, 30) }), before[1]]), "Plan ran out for Claude Code · my-app.");
  assert.equal(alerts.alertToast(before, [waiting("x", { id: "a" }), waiting("May need you", { id: "b", ...hermes })]), "2 sessions need you.");
  assert.equal(alerts.alertToast([waiting("Wants to use Bash", { id: "a" })], [waiting("Has a question for you", { id: "a" })]), null, "still waiting: no second message for new words");
  assert.equal(alerts.alertToast([], [waiting("Wants to use Bash", { id: "a" })]), "Claude Code · my-app is waiting for you. Wants to use Bash.", "a session that appears already waiting is news");
  assert.equal(alerts.alertToast([], [waiting("x", { id: "u", kind: "update" })]), null, "update sessions never alert");
});

test("the desktop note (K17): the desktop app only, until dismissed; macOS adds that it asks once", () => {
  assert.equal(alerts.NOTIFY_NOTE_KEY, "agentos.notifyNote.v1");
  assert.equal(
    alerts.notifyNote({ desktop: true, isMac: true, dismissed: false }),
    "Agent OS shows a notification when a session needs you and its window is hidden. macOS asks once whether to allow it."
  );
  assert.equal(alerts.notifyNote({ desktop: true, isMac: false, dismissed: false }), "Agent OS shows a notification when a session needs you and its window is hidden.");
  assert.equal(alerts.notifyNote({ desktop: true, isMac: true, dismissed: true }), null);
  assert.equal(alerts.notifyNote({ desktop: false, isMac: true, dismissed: false }), null, "a browser tab gets messages, not notifications");
});

test("OpenClaw cards: matched to their session or shown in every OpenClaw panel; the words for each kind and answer (R16)", () => {
  const cards = [card({ id: "mine", sessionId: "s1" }), card({ id: "other", sessionId: "s2" }), card({ id: "loose", sessionId: null })];
  assert.deepEqual(alerts.approvalsForSession(cards, "s1").map((c) => c.id), ["mine", "loose"]);
  assert.deepEqual(alerts.approvalsForSession(cards, "s3").map((c) => c.id), ["loose"]);
  assert.equal(alerts.approvalHeading(card()), "OpenClaw wants to run");
  assert.equal(alerts.approvalHeading(card({ kind: "plugin" })), "OpenClaw asks for approval");
  assert.equal(alerts.approvalHeading(card({ kind: "system-agent" })), "OpenClaw asks for approval");
  assert.deepEqual(alerts.approvalConfirm(card(), "allow-once"), { title: "Allow this once?", body: "OpenClaw runs npm test this one time. It asks again next time.", confirm: "Allow once" });
  assert.equal(alerts.approvalConfirm(card({ summary: "ls ." }), "allow-once").body, "OpenClaw runs ls . this one time. It asks again next time.", "a command is shown as it is");
  assert.equal(alerts.approvalConfirm(card({ summary: "" }), "allow-once").body, "OpenClaw runs it this one time. It asks again next time.");
  assert.equal(
    alerts.approvalConfirm(card({ kind: "plugin", summary: "Deploy: push the site." }), "allow-once").body,
    "OpenClaw goes ahead with this one time: Deploy: push the site. It asks again next time."
  );
  assert.deepEqual(alerts.approvalConfirm(card(), "deny"), { title: "Deny this?", body: "OpenClaw is told no.", confirm: "Deny" });
  assert.equal(alerts.approvalDoneHeading("allow-once"), "You allowed it once");
  assert.equal(alerts.approvalDoneHeading("deny"), "You said no");
  assert.equal(alerts.FROM_OPENCLAW, "from OpenClaw");
  assert.equal(alerts.APPROVAL_NO_ANSWER, "Agent OS hasn't answered. OpenClaw may have your answer already: the card goes once it has.");
});

test("an answered card shows its answer, then leaves a few seconds after OpenClaw drops it", () => {
  const a = card({ id: "a" });
  const b = card({ id: "b", summary: "rm -rf build" });
  assert.deepEqual(alerts.approvalView([a, b], {}, NOW), [{ card: a, answered: null }, { card: b, answered: null }]);
  const answered = { a: { decision: "allow-once", at: NOW - 1000, card: a } };
  assert.deepEqual(alerts.approvalView([a, b], answered, NOW), [{ card: a, answered: "allow-once" }, { card: b, answered: null }]);
  assert.deepEqual(alerts.approvalView([b], answered, NOW), [{ card: b, answered: null }, { card: a, answered: "allow-once" }], "gone from OpenClaw's list: still shown as answered for a moment");
  assert.deepEqual(alerts.approvalView([b], answered, NOW - 1000 + alerts.ANSWER_SHOWN_MS), [{ card: b, answered: null }], "then it goes");
  assert.equal(alerts.ANSWER_SHOWN_MS, 6000);
});

test("fix round 1: an answered card is forgotten once OpenClaw dropped it and its answer showed long enough; a refusal stays on its card until it leaves", () => {
  const a = card({ id: "a" });
  const b = card({ id: "b" });
  const answered = { a: { decision: "allow-once", at: NOW - 1000, card: a }, b: { decision: "deny", at: NOW - 10_000, card: b } };
  assert.deepEqual(Object.keys(alerts.pruneAnswered(answered, [], NOW)), ["a"], "b is gone from the list and was shown long enough");
  assert.deepEqual(Object.keys(alerts.pruneAnswered(answered, [], NOW - 1000 + alerts.ANSWER_SHOWN_MS)), [], "a goes too, once its answer showed ANSWER_SHOWN_MS");
  assert.equal(alerts.pruneAnswered(answered, [b], NOW), answered, "b is still listed and a is young: nothing to drop, the same object (no render)");
  const none = {};
  assert.equal(alerts.pruneAnswered(none, [], NOW), none, "an empty map stays the same object, so the one-second clock can stop");
  const errors = { a: "OpenClaw didn't take that answer: approval expired", gone: "x" };
  assert.deepEqual(alerts.pruneCardErrors(errors, [a]), { a: "OpenClaw didn't take that answer: approval expired" }, "a refusal goes when its card leaves the list");
  const kept = { a: "x" };
  assert.equal(alerts.pruneCardErrors(kept, [a]), kept, "nothing left the list: the same object");
  assert.equal(alerts.APPROVALS_STALE, "Showing what was last known.", "the existing words for a list that could not be refreshed");
  // The plan row keeps its "· 5-hour limit" when its value is "—" (spec row name "Plan used · 5-hour limit").
  assert.equal(page.meterRowLabel({ id: "plan", label: "Plan used", dim: "5-hour limit", value: null }), "Plan used · 5-hour limit");
  assert.equal(page.meterRowLabel({ id: "model", label: "Model", value: null }), "Model");
  assert.equal(page.meterRowLabel({ id: "brain", label: "Brain", value: "Plan", dim: "your subscription" }), "Brain", "a figure shows its dim next to the value, not in the label");
});

test("A-M2: the Model row falls back to the launch profile's model when the status line has none (OpenRouter, Local, a chosen Cursor model); the status line's own model wins; a plan brain with no model stays —", () => {
  const modelOf = (rows) => rows.find((r) => r.id === "model").value;
  const openrouter = { kind: "openrouter", label: "OpenRouter", model: "anthropic/claude-sonnet-4.5" };
  assert.equal(modelOf(page.meterRows(session({ brain: openrouter, meter: null }), NOW)), "anthropic/claude-sonnet-4.5", "no status line at all (Codex, Cursor)");
  assert.equal(modelOf(page.meterRows(session({ brain: openrouter, meter: { ...meter, model: null } }), NOW)), "anthropic/claude-sonnet-4.5");
  assert.equal(modelOf(page.meterRows(session({ brain: openrouter, meter: { ...meter, model: "  " } }), NOW)), "anthropic/claude-sonnet-4.5");
  assert.equal(modelOf(page.meterRows(session({ brain: openrouter, meter }), NOW)), "Opus 4.7", "the status line is the newer word");
  assert.equal(modelOf(page.meterRows(session({ brain: { kind: "local", label: "Local", model: "qwen3:8b" }, meter: null }), NOW)), "qwen3:8b");
  assert.equal(modelOf(page.meterRows(session({ brain: { kind: "plan", label: "Plan" }, meter: null }), NOW)), null);
  assert.equal(modelOf(page.meterRows(session({ brain: { kind: "plan", label: "Plan", model: "  " }, meter: null }), NOW)), null);
  assert.equal(modelOf(page.meterRows(session({ brain: null, meter: null }), NOW)), null);
  assert.equal(modelOf(page.meterRows(session({ status: "exited", endedAt: iso(160_000), brain: openrouter, meter }), NOW)), "anthropic/claude-sonnet-4.5", "an ended session shows the launch profile's model, not live figures");
});

test("the Live meter fills Model, Context used, Plan used and Cost so far from Claude's status line (spec Side panel, R11)", () => {
  const rows = page.meterRows(session({ meter }), NOW);
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.value]), [
    ["brain", "Brain", "Plan"], ["model", "Model", "Opus 4.7"], ["time", "Running for", "12 m 40 s"], ["context", "Context used", "42%"], ["plan", "Plan used", "71%"]
  ]);
  assert.deepEqual(rows[3].gauge, { percent: 42, tone: "accent" });
  assert.deepEqual(rows[4].gauge, { percent: 71, tone: "warn", detail: "Resets 5:30 pm" });
  assert.equal(rows[4].dim, "5-hour limit");
  const full = page.meterRows(session({ meter: { ...meter, contextPercent: 100, plan: { usedPercent: 100, resetsAt: null } } }), NOW);
  assert.deepEqual(full[3].gauge, { percent: 100, tone: "danger" });
  assert.deepEqual(full[4].gauge, { percent: 100, tone: "danger" }, "no reset words when the time is not known");
  assert.equal(page.meterRows(session({ meter: { ...meter, contextPercent: 69.6 } }), NOW)[3].gauge.tone, "warn", "70 % after rounding warns");
  const odd = page.meterRows(session({ meter: { ...meter, contextPercent: -5, model: "  " } }), NOW);
  assert.deepEqual([odd[1].value, odd[3].value, odd[3].gauge], [null, null, undefined], "a figure that is not a figure is —");
  // R11: OpenRouter and Local brains get no plan window from Claude, so Plan used is "—"; an OpenRouter brain's cost is
  // Claude's own estimate.
  const openrouter = page.meterRows(session({ brain: { kind: "openrouter", label: "OpenRouter" }, meter: { ...meter, plan: null } }), NOW);
  assert.deepEqual(openrouter.map((r) => [r.id, r.value]), [["brain", "OpenRouter"], ["model", "Opus 4.7"], ["time", "12 m 40 s"], ["context", "42%"], ["plan", null], ["cost", "$1.23 (estimate)"]]);
  const local = page.meterRows(session({ brain: { kind: "local", label: "Local" }, meter: { ...meter, plan: null } }), NOW);
  assert.deepEqual(local.map((r) => [r.id, r.value]), [["brain", "Local"], ["model", "Opus 4.7"], ["time", "12 m 40 s"], ["context", "42%"], ["plan", null]], "a Local brain: Plan used is —, and there is no cost row");
  assert.deepEqual(local.at(-1), { id: "plan", label: "Plan used", dim: "5-hour limit", value: null }, "the — row keeps its label and has no gauge");
  assert.equal(page.meterRows(session({ brain: { kind: "openrouter", label: "OpenRouter" }, meter: { ...meter, plan: null, costUsd: 0.003 } }), NOW).at(-1).value, "under $0.01 (estimate)");
  assert.equal(page.meterRows(session({ brain: { kind: "openrouter", label: "OpenRouter" }, meter: { ...meter, plan: null, costUsd: null } }), NOW).at(-1).value, null);
  const unknown = page.meterRows(session({ meter: { model: null, contextPercent: null, contextTokens: null, plan: null, weekly: null, costUsd: null, at: iso(1000) } }), NOW);
  assert.deepEqual(unknown.map((r) => [r.id, r.value]), [["brain", "Plan"], ["model", null], ["time", "12 m 40 s"], ["context", null], ["plan", null]]);
  assert.equal(unknown.some((r) => r.gauge), false);
  assert.deepEqual(page.meterRows(session({ status: "exited", endedAt: iso(160_000), meter }), NOW).map((r) => r.value), ["Plan", null, "10 m 00 s", null, null], "an ended session shows no live figures");
  assert.deepEqual(page.meterRows(session({ agentId: "hermes", brain: null, meter: null }), NOW).map((r) => r.id), ["brain", "model", "time", "context"], "no status line: most of the meter stays —");
  assert.deepEqual([69, 70, 99, 100].map(page.meterTone), ["accent", "warn", "warn", "danger"]);
  assert.equal(page.costWords(0), "$0.00");
  assert.equal(page.costWords(12.345), "$12.35");
});

test("Home: a waiting session turns its agent's line amber; the note, the label, the lede and the row say so", () => {
  const sessions = [
    session({ id: "a", agentId: "codex", status: "waiting" }),
    session({ id: "b", agentId: "codex", status: "live" }),
    session({ id: "c", agentId: "claude", status: "live" }),
    session({ id: "d", agentId: "hermes", status: "held" }),
    session({ id: "e", agentId: "cursor", kind: "update", status: "waiting" })
  ];
  const states = home.orbitStates([], sessions);
  assert.deepEqual(states, { codex: "waiting", claude: "live" }, "waiting wins over live; held stays dim; an update session is never shown");
  // Fix round 1 (M10): only an agent session can turn a line amber; a setup session that is live still lights it, as in SP3.
  assert.deepEqual(home.orbitStates([], [session({ agentId: "codex", kind: "setup", status: "waiting" })]), {}, "a setup session never turns a line amber");
  assert.deepEqual(home.orbitStates([], [session({ agentId: "codex", kind: "setup", status: "live" })]), { codex: "live" });
  assert.equal(home.orbitNote(states), "A line lights only while that agent works. Amber means it needs you.");
  assert.equal(home.orbitNote({ claude: "live" }), "A line lights only while that agent works.");
  assert.equal(home.orbitLabel(states, true), "Agent OS at the centre with five agents around it. Waiting for you: Codex CLI. Working now: Claude Code.");
  assert.equal(home.orbitLabel({ codex: "waiting" }, true), "Agent OS at the centre with five agents around it. Waiting for you: Codex CLI.");
  assert.equal(home.orbitLabel(states, false), "Agent OS at the centre with five agents around it. What each agent is doing is not known right now.");
  const agents = { state: "ok", data: [] };
  assert.equal(home.homeLede({ agents, states, runsKnown: true }), "Codex CLI is waiting for you. Claude Code is working.");
  assert.equal(home.homeLede({ agents, states: { codex: "waiting", hermes: "waiting" }, runsKnown: false }), "Hermes Agent and Codex CLI are waiting for you.");
  const codex = installed("codex");
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: codex, session: session({ agentId: "codex", status: "waiting" }), now: NOW }), { state: "waiting", where: "Session in my-app" });
  assert.deepEqual(home.agentLine({ agents: "ok", runs: "ok", summary: codex, session: session({ agentId: "codex", status: "held" }), now: NOW }), { state: "held", where: "Session in my-app" });
});

test("Help: the alerts lane in words is true where Agent OS runs and promises no hand-off yet", () => {
  assert.equal(help.ALERTS_TITLE, "Alerts, in words");
  const flat = (desktop) => help.alertWords({ desktop }).map((parts) => parts.map((part) => part.text).join(""));
  assert.deepEqual(flat(true), [
    "The agent raises its own signal when it needs you: a hook, a notification, a bell or an approval request, depending on the agent.",
    "Agent OS turns it into an alert: an amber tab marker, the Home strip, the top-bar badge and, when its window is hidden or not in front, a desktop notification.",
    "Nothing answers for you. You open the session and press the key yourself, or choose Allow once or Deny on an OpenClaw card.",
    "Alerts for Hermes and Cursor are basic: Agent OS hears only a bell or a sign in the title, which may also mean the agent finished."
  ]);
  assert.equal(flat(false)[1], "Agent OS turns it into an alert: an amber tab marker, the Home strip, the top-bar badge and a message at the bottom of this page.");
  assert.doesNotMatch(flat(false).join("\n"), /desktop notification/, "a browser tab gets no desktop notification");
  for (const text of [...flat(true), ...flat(false)]) {
    assert.doesNotMatch(text, /—/, "no em dash");
    assert.doesNotMatch(text, /hand-off|send to codex|review guide/i, "the hand-off is Task X8's");
  }
});

test("the SP3 placeholders this task replaces are gone, and alertsShared.ts keeps to type imports and one sessionsShared import", () => {
  const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(read("ui/Shell.tsx"), /SP4: "Waiting for you \(n\)" badge/);
  assert.doesNotMatch(read("ui/components/WaitingStrip.tsx"), /Nothing reports waiting until SP4/);
  assert.doesNotMatch(read("ui/components/SafetyApprovals.tsx"), /No approval requests arrive here yet/);
  assert.doesNotMatch(read("ui/homeShared.ts"), /SP4 brings the sentence/);
  assert.doesNotMatch(read("ui/sessionsPageShared.ts"), /so they are null today/);
  assert.doesNotMatch(read("ui/sessionsShared.ts"), /return "Working\.";/);
  const imports = [...read("ui/alertsShared.ts").matchAll(/^import (type )?[^;]*? from "([^"]+)";$/gm)].map((m) => `${m[1] ? "type " : ""}${m[2]}`);
  assert.deepEqual(imports, ["type ../types", "./sessionsShared.ts"]);
  assert.doesNotMatch(read("ui/components/ApprovalCard.tsx"), /window\.confirm|allow-always/, "only Allow once and Deny, through Agent OS's own dialog (R16)");
});

test("showShellToast: a page asks the shell's one toast slot for its message, so the Sessions page draws no toast of its own and two never overlap (sweep A item 6, U5 review M7)", () => {
  const heard = [];
  const target = new EventTarget();
  const had = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = target;
  try {
    target.addEventListener(shellToast.SHELL_TOAST_EVENT, (event) => heard.push(event.detail));
    shellToast.showShellToast("Link copied. Open it in your browser.");
    shellToast.showShellToast("Needs a look", "warn");
  } finally {
    if (had) Object.defineProperty(globalThis, "window", had);
    else delete globalThis.window;
  }
  assert.deepEqual(heard, [
    { message: "Link copied. Open it in your browser.", tone: "neutral" },
    { message: "Needs a look", tone: "warn" }
  ]);
  const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const sessionsPage = read("pages/SessionsPage.tsx");
  assert.doesNotMatch(sessionsPage, /<Toast\b|terminalNote|components\/Toast/, "the page's terminal sentence goes through the shell, not a Toast of its own");
  assert.match(sessionsPage, /showShellToast\(text\)/);
  assert.match(read("ui/Shell.tsx"), /addEventListener\(SHELL_TOAST_EVENT, onShellToast\)/, "the shell listens and draws it in its own slot");
  assert.doesNotMatch(read("ui/shellToast.ts"), /^import /m, "no imports: Node loads the file as it is");
});

test("slotMessage (sweep A fix round 1): a message that stays until closed keeps the shell's one slot, a page note waits for it and shows when it is closed", () => {
  const m = (id, tone, message = `m${id}`) => ({ id, tone, message });
  assert.deepEqual(["ok", "neutral", "warn", "danger"].map((tone) => shellToast.staysUntilClosed(tone)), [false, false, true, true], "the same rule as components/Toast.tsx");
  assert.equal(shellToast.slotMessage(null, null), null);
  const note = m(9, "neutral", "Link copied. Open it in your browser.");
  assert.equal(shellToast.slotMessage(null, note), note, "nothing else on screen: the note shows");
  assert.equal(shellToast.slotMessage(m(1, "ok"), null)?.id, 1);
  // A stop-all failure, or a browser tab's "needs you" message, is never replaced by a plain note, however new it is.
  for (const tone of ["danger", "warn"]) {
    const sticky = m(5, tone);
    assert.equal(shellToast.slotMessage(sticky, note), sticky, `a ${tone} message stays`);
    assert.equal(shellToast.slotMessage(sticky, m(99, "ok")), sticky, `a newer ok note does not replace a ${tone} one`);
    assert.equal(shellToast.slotMessage(sticky, m(100, "danger")), sticky, "nor does another sticky one: the first stays until closed");
  }
  // Once it has been closed the pending note shows.
  assert.equal(shellToast.slotMessage(null, note), note);
  // Plain news: the newer message shows; a note that stays until closed itself takes the slot from plain news.
  assert.equal(shellToast.slotMessage(m(5, "ok"), m(9, "neutral"))?.id, 9);
  assert.equal(shellToast.slotMessage(m(9, "ok"), m(5, "neutral"))?.id, 9);
  assert.equal(shellToast.slotMessage(m(9, "ok"), m(5, "warn"))?.id, 5);
  // The shell wires it: the page's event only sets the pending note, and the slot comes from slotMessage.
  const shell = readFileSync(new URL("../src/ui/Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /const inSlot = slotMessage\(shellOwn, shellPage\);/);
  assert.match(shell, /function onShellToast[\s\S]*?setPageNote\(\{ id: Date\.now\(\)[\s\S]*?addEventListener\(SHELL_TOAST_EVENT, onShellToast\)/, "a page's note only becomes the pending page note");
  assert.doesNotMatch(shell.slice(shell.indexOf("function onShellToast"), shell.indexOf("addEventListener(SHELL_TOAST_EVENT")), /setToast\(/, "and never overwrites the shell's own toast");
  assert.match(shell, /\{inSlot \? <Toast key=\{inSlot\.key\}/);
});
