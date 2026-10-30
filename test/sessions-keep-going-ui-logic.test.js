// Plan ran out, keep going (SP4, Task X10): the pure words and rules in src/ui/keepGoingShared.ts (the held
// session's banner, its confirm dialog, Wait for reset, Cursor's hand-over, the Runs page's Held wording), and
// where the page puts them. Node strips the TypeScript types itself (decision P14), so the .ts file is imported
// directly; it keeps only `import type` imports. No server, no browser: the page itself is checked by the
// keepgoing probe of the UI audit (.superpowers/ui-audit/probes/keepgoing.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as kg from "../src/ui/keepGoingShared.ts";
import * as page from "../src/ui/sessionsPageShared.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const held = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "agent",
  agentId: "claude",
  agentLabel: "Claude Code",
  status: "held",
  stateSince: "2026-10-29T10:00:00.000Z",
  ...over
});
const claudeInfo = (over = {}) => ({
  agentId: "claude",
  approach: "resume",
  available: true,
  reason: null,
  model: "~anthropic/claude-sonnet-latest",
  estimateUsd: 0.42,
  estimateTokens: 140000,
  estimateNote: "Claude reads the whole conversation again without the cache. This is what that first read costs; the new work costs extra.",
  warnings: ["Continuing re-reads the whole conversation at full price, with no cache discount."],
  needsKey: false,
  ...over
});
const codexInfo = (over = {}) => ({
  agentId: "codex",
  approach: "new",
  available: true,
  reason: null,
  model: "openai/gpt-5.6-codex",
  estimateUsd: 0.01,
  estimateTokens: 40,
  estimateNote: "This is what reading the summary costs; the new work costs extra.",
  warnings: ["Codex starts a new session with a summary; it can't pick up the old one on another provider."],
  needsKey: false,
  ...over
});

test("the banner shows only for a held Claude Code or Codex agent session (Cursor, Hermes and OpenClaw are never held)", () => {
  assert.equal(kg.showsLimitBanner(held()), true);
  assert.equal(kg.showsLimitBanner(held({ agentId: "codex", agentLabel: "Codex" })), true);
  for (const status of ["starting", "live", "waiting", "idle", "exited"]) assert.equal(kg.showsLimitBanner(held({ status })), false, status);
  for (const agentId of ["cursor", "hermes", "openclaw"]) assert.equal(kg.showsLimitBanner(held({ agentId })), false, agentId);
  for (const kind of ["update", "setup"]) assert.equal(kg.showsLimitBanner(held({ kind })), false, kind);
});

test("the banner's words: the limit sentence, Resets <time>. only when the time is known, the prototype's line, and the spec's two buttons", () => {
  assert.deepEqual(kg.limitBannerCopy(held(), "2:21 am"), {
    title: "Claude Code's plan limit was reached.",
    resets: "Resets 2:21 am.",
    sub: "Continues the same conversation. OpenRouter is pay-per-use."
  });
  assert.deepEqual(kg.limitBannerCopy(held({ agentId: "codex", agentLabel: "Codex" }), ""), {
    title: "Codex's plan limit was reached.",
    resets: null,
    sub: "OpenRouter is pay-per-use."
  });
  assert.equal(kg.KEEP_GOING_LABEL, "Keep going on OpenRouter");
  assert.equal(kg.WAIT_FOR_RESET_LABEL, "Wait for reset");
  assert.equal(kg.OPTIONS_LOADING, "Working out your options…");
  assert.equal(kg.OPTIONS_FAILED, "Couldn't work out the options.");
  assert.equal(kg.TRY_AGAIN_LABEL, "Try again");
});

test("Wait for reset: the session stays Held with its reset time and Agent OS sends nothing; it lasts for this hold only; Show my choices brings the buttons back", () => {
  assert.equal(kg.sessionWaitingText("2:21 am"), "Waiting for your plan to reset (about 2:21 am). The session stays Held and Agent OS sends nothing.");
  assert.equal(kg.sessionWaitingText(""), "Waiting for your plan to reset. The session stays Held and Agent OS sends nothing.");
  assert.equal(kg.waitKey(held()), kg.waitKey(held()));
  assert.notEqual(kg.waitKey(held()), kg.waitKey(held({ stateSince: "2026-10-29T12:00:00.000Z" })), "a new hold shows the choices again");
  assert.notEqual(kg.waitKey(held()), kg.waitKey(held({ id: "22222222-2222-4222-8222-222222222222" })));
  assert.equal(kg.SHOW_CHOICES_LABEL, "Show my choices");
});

test("the confirm dialog for Claude Code: the spec's title, points and buttons, the prototype's words, and continue.js's estimate, note and warnings", () => {
  const copy = kg.keepGoingDialogCopy(claudeInfo(), "Claude Code");
  assert.equal(copy.title, "Keep going on OpenRouter?");
  assert.equal(copy.lede, "Claude Code carries on with this same conversation, using your OpenRouter brain instead of your plan.");
  assert.deepEqual(copy.points.map((point) => point.label), ["Same conversation.", "Pay per use.", "Your call."]);
  assert.deepEqual(copy.points.map((point) => point.text), [
    "Claude Code keeps what it has read and written so far.",
    "OpenRouter charges for each message. About $0.42 just to get started.",
    "Nothing is switched until you press the button below."
  ]);
  assert.deepEqual([copy.confirm, copy.cancel], ["Keep going on OpenRouter", "Cancel"]);
  assert.equal(copy.model, "~anthropic/claude-sonnet-latest");
  assert.equal(copy.note, claudeInfo().estimateNote);
  assert.deepEqual(copy.warnings, claudeInfo().warnings);
  assert.equal(copy.stays, null);
  assert.equal(kg.estimateSentence({ estimateUsd: null }), "Agent OS couldn't estimate the cost.");
  assert.equal(kg.estimateSentence({ estimateUsd: 3 }), "About $3.00 just to get started.");
  assert.equal(kg.keepGoingDialogCopy(claudeInfo({ estimateUsd: null }), "Claude Code").points[1].text, "OpenRouter charges for each message. Agent OS couldn't estimate the cost.");
});

test("the confirm dialog for Codex says it is a new conversation from the summary, typed for you and not sent, and that the held session stays open", () => {
  const copy = kg.keepGoingDialogCopy(codexInfo(), "Codex");
  assert.equal(copy.title, "Keep going on OpenRouter?");
  assert.equal(copy.lede, "This starts a new Codex conversation from a summary of the last screen.");
  assert.deepEqual(copy.points.map((point) => point.label), ["Typed for you, not sent.", "Pay per use.", "Your call."]);
  assert.equal(copy.points[0].text, "You read the summary in the new session and press Enter yourself.");
  assert.equal(copy.points.some((point) => point.label === "Same conversation."), false);
  assert.equal(copy.stays, "This held Codex session stays open. Stop it when you no longer need it.");
  assert.deepEqual([copy.confirm, copy.cancel], ["Keep going on OpenRouter", "Cancel"]);
});

test("not available: the banner shows continue.js's reason, and the Agents → Brain link when the key or the model is the problem", () => {
  assert.equal(kg.BRAIN_LINK_LABEL, "Agents → Brain");
  assert.equal(kg.needsBrainLink(claudeInfo()), false);
  assert.equal(kg.needsBrainLink(claudeInfo({ available: false, needsKey: true, reason: 'Save your OpenRouter key first ("Remember my OpenRouter key").' })), true);
  assert.equal(kg.needsBrainLink(codexInfo({ available: false, model: null, reason: "Choose an OpenRouter model for Codex first (Agents, then Codex, then Brain)." })), true);
  assert.equal(kg.needsBrainLink(claudeInfo({ available: false, model: "openai/gpt-5.5", reason: "Continuing a Claude conversation only works with Claude models. Pick an Anthropic model for Claude Code on OpenRouter." })), true);
  assert.equal(kg.needsBrainLink(claudeInfo({ available: false, reason: "This session isn't using your plan, so there's no plan limit to get past." })), false);
  assert.equal(kg.needsBrainLink(claudeInfo({ available: false, reason: "This Claude Code conversation can't be resumed." })), false);
});

test("Runs: a Held run's Wait for reset says to press Keep going after the reset (the spec's words), and the old sentence and the prototype's 'then carry on' are gone", () => {
  assert.equal(
    kg.runWaitingText("2:21 am"),
    "Waiting for your plan to reset (about 2:21 am). This run stays Held and nothing carries on by itself: press Keep going after the reset."
  );
  assert.equal(kg.runWaitingText(""), "Waiting for your plan to reset. This run stays Held and nothing carries on by itself: press Keep going after the reset.");
  const banner = read("src/ui/components/RunLimitBanner.tsx");
  assert.match(banner, /const waitingText = runWaitingText\(reset\);/);
  assert.equal(banner.includes("After the reset, open this run again to see your choices."), false);
  assert.equal(/then carry on/i.test(banner), false);
});

test("Cursor's hand-over: only for a running Cursor agent session; the spec's button, a confirm with Claude Code or Codex, and what each answer opens or shows", () => {
  const cursor = (over = {}) => held({ agentId: "cursor", agentLabel: "Cursor", status: "live", ...over });
  for (const status of ["starting", "live", "waiting", "idle"]) assert.equal(kg.canHandOver(cursor({ status })), true, status);
  assert.equal(kg.canHandOver(cursor({ status: "exited" })), false);
  assert.equal(kg.canHandOver(held({ status: "live" })), false);
  assert.equal(kg.canHandOver(cursor({ kind: "update" })), false);
  assert.equal(kg.HAND_OVER_LABEL, "Hand to Claude Code or Codex");
  assert.equal(kg.HAND_OVER_TITLE, "Hand to Claude Code or Codex?");
  assert.equal(kg.HAND_OVER_CONFIRM, "Hand over");
  assert.equal(
    kg.HAND_OVER_BODY,
    "Agent OS types a summary of Cursor's last screen into the agent you pick, in this folder: an open session there when it can take typed text, otherwise a new one. It is typed for you, not sent."
  );
  assert.deepEqual(kg.HAND_OVER_TARGETS.map((target) => [target.id, target.label]), [["claude", "Claude Code"], ["codex", "Codex"]]);

  const id = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(kg.handOverOutcome({ result: "typed", targetId: id, text: "x", reason: null }), { open: id, copy: null });
  assert.deepEqual(kg.handOverOutcome({ result: "opening", targetId: id, text: "x", reason: null }), { open: id, copy: null });
  assert.deepEqual(kg.handOverOutcome({ result: "copy", targetId: null, text: "Picking up", reason: "Codex wasn't ready." }), {
    open: null,
    copy: { text: "Picking up", reason: "Codex wasn't ready." }
  });
  assert.deepEqual(kg.handOverOutcome(null), { open: null, copy: null });
  assert.deepEqual(kg.handOverOutcome({ result: "typed", targetId: null }), { open: null, copy: null });
  assert.equal(kg.keptGoingTarget({ result: "opening", targetId: id }, "own-id"), id);
  assert.equal(kg.keptGoingTarget(null, "own-id"), "own-id");
  assert.equal(kg.keptGoingTarget({ result: "resumed", targetId: "" }, "own-id"), "own-id");
});

test("where the page puts them: the banner inside each pane above its terminal (U6's renderPane), the hand-over button in X8's Hand-off section", () => {
  const page = read("src/pages/SessionsPage.tsx");
  const pane = page.indexOf("function renderPane(");
  const mount = page.indexOf("<SessionLimitBanner session={session} />");
  assert.ok(pane > 0 && mount > pane, "drawn inside renderPane, for that pane's session");
  assert.equal(page.split("<SessionLimitBanner").length - 1, 1, "once");
  assert.ok(mount < page.indexOf("{showIt ? (", pane), "above the terminal");
  assert.match(read("src/ui/components/HandoffSection.tsx"), /<HandOverButton session=\{/);
  assert.match(read("src/ui/components/HandOverButton.tsx"), /canHandOver\(/);
  assert.match(read("src/ui/components/SessionLimitBanner.tsx"), /showsLimitBanner\(/);
});

test("copy rules: no em dash in any sentence here, and no browser confirm, alert or prompt in the three components", () => {
  const sentences = [
    kg.KEEP_GOING_LABEL, kg.WAIT_FOR_RESET_LABEL, kg.SHOW_CHOICES_LABEL, kg.BRAIN_LINK_LABEL, kg.OPTIONS_LOADING, kg.OPTIONS_FAILED,
    kg.TRY_AGAIN_LABEL, kg.SHOW_NEW_SESSION_LABEL, kg.openedSessionLine("Codex"), kg.HAND_OVER_LABEL, kg.HAND_OVER_TITLE, kg.HAND_OVER_CONFIRM, kg.HAND_OVER_BODY, kg.CODEX_NEW_CONVERSATION,
    kg.sessionWaitingText("2:21 am"), kg.runWaitingText("2:21 am"), kg.estimateSentence({ estimateUsd: null }),
    ...Object.values(kg.limitBannerCopy(held(), "2:21 am")).filter(Boolean),
    ...[kg.keepGoingDialogCopy(claudeInfo(), "Claude Code"), kg.keepGoingDialogCopy(codexInfo(), "Codex")].flatMap((copy) => [
      copy.title, copy.lede, copy.stays || "", ...copy.points.flatMap((point) => [point.label, point.text])
    ])
  ];
  for (const sentence of sentences) assert.equal(sentence.includes("—"), false, sentence);
  const components = ["SessionLimitBanner", "KeepGoingDialog", "HandOverButton"].map((name) => read(`src/ui/components/${name}.tsx`)).join("\n");
  assert.equal(/window\.(confirm|alert|prompt)\(|\b(confirm|alert|prompt)\(\s*["'`]/.test(components), false);
});

// ---- fix round 1 (review of Task X10) ---------------------------------------------------------------------

test("M2: a keep going whose list never showed the ended state still gets a fresh terminal: a new run under the same id (its startedAt changed) bumps the generation once; ending still keeps the last screen", () => {
  const run = (n) => `2026-10-29T1${n}:00:00.000Z`;
  let gens = page.nextGenerations({}, [{ id: "s", status: "held", startedAt: run(0) }]);
  assert.equal(page.terminalKey("s", gens), "s:0");
  // The list read after the stop lands after the resume began: never "exited", but a new run.
  gens = page.nextGenerations(gens, [{ id: "s", status: "starting", startedAt: run(1) }]);
  assert.equal(page.terminalKey("s", gens), "s:1");
  gens = page.nextGenerations(gens, [{ id: "s", status: "live", startedAt: run(1) }]);
  assert.equal(page.terminalKey("s", gens), "s:1", "the same run keeps its terminal");
  // The usual path still counts once: exited, then a new run.
  gens = page.nextGenerations(gens, [{ id: "s", status: "exited", startedAt: run(1) }]);
  assert.equal(page.terminalKey("s", gens), "s:1", "ending keeps the last screen");
  gens = page.nextGenerations(gens, [{ id: "s", status: "starting", startedAt: run(2) }]);
  assert.equal(page.terminalKey("s", gens), "s:2", "exited, then a new run: one step, not two");
  // A session list without start times (the old shape) behaves as before.
  assert.deepEqual(page.nextGenerations({}, [{ id: "t", status: "live" }]), { t: { status: "live", gen: 0 } });
});

test("I1 and M5: the banner stays while Keep going works or has failed, and the page remembers the one session a hold opened", () => {
  assert.equal(kg.keepGoingStaysOnScreen(true, false, ""), true);
  assert.equal(kg.keepGoingStaysOnScreen(false, false, ""), false);
  assert.equal(kg.keepGoingStaysOnScreen(false, true, ""), true, "the stop already made it not held, the request still runs");
  assert.equal(kg.keepGoingStaysOnScreen(false, false, "That session is still running, so there is nothing to resume."), true, "a failed resume says why");
  assert.equal(kg.openedFor("a:1"), null);
  kg.rememberOpened("a:1", "id-1");
  assert.equal(kg.openedFor("a:1"), "id-1");
  assert.equal(kg.openedFor("a:2"), null, "another hold");
  assert.equal(kg.openedSessionLine("Codex"), "A new Codex session was opened on OpenRouter.");
  assert.equal(kg.SHOW_NEW_SESSION_LABEL, "Show the new session");
});

test("how the components use them: the banner keeps its dialog and its failure after the stop (I1), shows the opened session instead of Keep going (M5), moves the focus (M7); the hand-over resets when the session ends (M4); the dialog body scrolls (M8)", () => {
  const banner = read("src/ui/components/SessionLimitBanner.tsx");
  assert.match(banner, /keepGoingStaysOnScreen\(shown, busy, failure\)/);
  assert.match(banner, /if \(acting\.current\) return;/, "the hold's reset waits for the request");
  assert.match(banner, /\{failure && !shown \?/, "the failure banner outlives the hold");
  assert.match(banner, /asking && info\?\.available && \(shown \|\| busy\)/, "the dialog stays while the request runs");
  assert.match(banner, /openedId !== null \?/, "M5");
  assert.match(banner, /nextFocus\.current = "show"/, "M7: Wait for reset focuses Show my choices");
  assert.match(read("src/ui/components/HandOverButton.tsx"), /\[session\.id, handable\]/, "M4");
  assert.match(read("src/ui/sessions.css"), /\.os-keepgoing__scroll \{[^}]*max-height: calc\(100vh[^}]*overflow-y: auto/, "M8");
  assert.match(read("src/ui/components/KeepGoingDialog.tsx"), /className="os-keepgoing__scroll"/);
});
