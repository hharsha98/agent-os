// SP5 Task U1: the client side of agent updates. src/ui/updatesShared.ts is the pure half (which words, when Update is
// offered, the Hermes reasons and guide, the dot), src/updatesApi.ts the three requests and the remembered update.
// updatesShared.ts has `import type` only, so Node loads it straight from src/ (decision P14). updatesApi.ts imports its
// neighbours without a file extension (the Vite way), so a resolve hook adds .ts first, as
// test/sessions-replay-logic.test.js does. The page itself is checked by the updates probe of the UI audit.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getInstallRecipe } from "../server/runtime/setup/recipes.js";
import { versionNumber as serverVersionNumber } from "../server/runtime/updates/versions.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const extension of [".ts", ".tsx"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
});

const shared = await import("../src/ui/updatesShared.ts");
const api = await import("../src/updatesApi.ts");
const { ApiError } = await import("../src/api.ts");

const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const row = (agentId, state, over = {}) => ({
  agentId, installed: "2.1.309", latest: state === "available" ? "2.1.310" : "2.1.309", state, checkedAt: "2026-10-31T18:00:00.000Z", ...over
});
const answer = (agents, hermes = { clean: true, reasons: [] }) => ({ agents, hermes });

test("the command in the dialog is what the agent's own updater runs (the Setup recipes' updateArgs)", () => {
  // Cursor's program is `agent`; the others are called by their own name.
  const program = { claude: "claude", codex: "codex", cursor: "agent", openclaw: "openclaw", hermes: "hermes" };
  for (const [agentId, name] of Object.entries(program)) {
    const recipe = getInstallRecipe(agentId, "darwin", "arm64");
    assert.equal(shared.updateCommand(agentId), `${name} ${recipe.updateArgs.join(" ")}`, agentId);
  }
  // None of them answers a question for the person (global constraint H7): no --yes anywhere.
  for (const agentId of Object.keys(program)) assert.doesNotMatch(shared.updateCommand(agentId), /--yes|\s-y\b/);
});

test("the version number in an agent's version text is read the way the server reads it", () => {
  for (const text of ["2.1.309 (Claude Code)", "codex-cli 0.154.0", "Hermes Agent v0.22.5 (2026.10.1)", "2026.10.14-941492e", "9.9.9-fake", "agent", "", "7", null, undefined]) {
    assert.equal(shared.versionNumber(text), serverVersionNumber(text), String(text));
  }
  assert.equal(shared.versionNumber("Hermes Agent v0.22.5 (2026.10.1)"), "0.22.5");
});

test("Update is offered for an update that is available and for Cursor's unknown; never for the rest", () => {
  const clean = { clean: true, reasons: [] };
  assert.equal(shared.offersUpdate("claude", row("claude", "available"), clean), true);
  assert.equal(shared.offersUpdate("codex", row("codex", "available"), clean), true);
  assert.equal(shared.offersUpdate("openclaw", row("openclaw", "available"), clean), true);
  assert.equal(shared.offersUpdate("cursor", row("cursor", "available"), clean), true);
  assert.equal(shared.offersUpdate("cursor", row("cursor", "unknown", { latest: null }), clean), true, "Cursor's updater checks when it runs");
  for (const state of ["up-to-date", "failed", "not-installed", "unknown"]) {
    assert.equal(shared.offersUpdate("claude", row("claude", state), clean), false, `claude ${state}`);
  }
  assert.equal(shared.offersUpdate("hermes", row("hermes", "unknown"), clean), false, "only Cursor is offered an update it cannot check");
  assert.equal(shared.offersUpdate("claude", undefined, clean), false, "no row, no button (the checks are off)");
});

test("Hermes is offered Update only from an unchanged official copy; otherwise the reasons and the guide take its place", () => {
  const dirty = { clean: false, reasons: ["dirty_tree"] };
  assert.equal(shared.offersUpdate("hermes", row("hermes", "available", { installed: null, latest: null }), { clean: true, reasons: [] }), true);
  assert.equal(shared.offersUpdate("hermes", row("hermes", "available"), dirty), false);
  assert.equal(shared.hermesBlocked("hermes", row("hermes", "available"), dirty), true);
  // Up to date, the explanation would only be noise; and the other agents never use the Hermes answer.
  assert.equal(shared.hermesBlocked("hermes", row("hermes", "up-to-date"), dirty), false);
  assert.equal(shared.hermesBlocked("claude", row("claude", "available"), dirty), false);
  assert.equal(shared.offersUpdate("claude", row("claude", "available"), dirty), true);
  // Before the first check ends the answer is "not clean, no reasons": still no button.
  assert.equal(shared.offersUpdate("hermes", row("hermes", "available"), { clean: false, reasons: [] }), false);
  assert.equal(shared.offersUpdate("hermes", row("hermes", "available"), undefined), false);
});

test("Hermes before its folder has been checked (not clean, no reason): one sentence, no reasons, no guide, no Update", () => {
  const unchecked = { clean: false, reasons: [] };
  const available = row("hermes", "available", { installed: null, latest: null });
  assert.equal(shared.HERMES_UNCHECKED_LINE, "Agent OS hasn't checked Hermes's folder yet.");
  assert.equal(shared.hermesUnchecked("hermes", available, unchecked), true);
  assert.equal(shared.hermesBlocked("hermes", available, unchecked), true, "still no Update");
  assert.equal(shared.offersUpdate("hermes", available, unchecked), false);
  assert.equal(shared.hermesUnchecked("hermes", available, { clean: false, reasons: ["dirty_tree"] }), false, "a reason is a changed copy");
  assert.equal(shared.hermesUnchecked("hermes", available, { clean: true, reasons: [] }), false);
  assert.equal(shared.hermesUnchecked("hermes", row("hermes", "up-to-date"), unchecked), false, "nothing to update, nothing to say");
  assert.equal(shared.hermesUnchecked("claude", row("claude", "available"), unchecked), false, "only Hermes");
});

test("the state words: Up to date, Update available, Couldn't check; Cursor's unknown has its own sentence", () => {
  assert.deepEqual(shared.stateWord("claude", row("claude", "up-to-date")), { tone: "ready", label: "Up to date" });
  assert.deepEqual(shared.stateWord("claude", row("claude", "available")), { tone: "waiting", label: "Update available" });
  assert.deepEqual(shared.stateWord("claude", row("claude", "failed", { latest: null })), { tone: "unknown", label: "Couldn't check" });
  assert.equal(shared.stateWord("cursor", row("cursor", "unknown", { latest: null })), null, "no word: the sentence says it");
  assert.equal(shared.isCursorUnknown("cursor", row("cursor", "unknown")), true);
  assert.equal(shared.isCursorUnknown("claude", row("claude", "unknown")), false);
  assert.deepEqual(shared.stateWord("claude", row("claude", "unknown")), { tone: "unknown", label: "Couldn't check" }, "any other unknown is a check that gave no answer");
  assert.equal(shared.stateWord("claude", row("claude", "not-installed", { installed: null, latest: null })), null);
  assert.equal(shared.stateWord("claude", undefined), null, "not checked yet: no word at all");
  assert.equal(shared.CURSOR_UNKNOWN_LINE, "Agent OS can't check Cursor's latest version. Its updater checks when you press Update.");
  // Latest and Checked are said only for a check that found an answer.
  assert.equal(shared.checkFoundAnswer(row("claude", "available")), true);
  assert.equal(shared.checkFoundAnswer(row("claude", "up-to-date")), true);
  for (const state of ["failed", "unknown", "not-installed"]) assert.equal(shared.checkFoundAnswer(row("claude", state)), false, state);
});

test("the Update dialog's words", () => {
  assert.equal(shared.updateTitle("Claude Code"), "Update Claude Code?");
  assert.equal(shared.openSessionsLine("2.1.309"), "Open sessions keep running on v2.1.309 until you restart them.");
  assert.equal(shared.dryRunLine("2026.9.7", "2026.10.1"), "Dry run: 2026.9.7 → 2026.10.1.");
  assert.equal(shared.GATEWAY_LINE, "Its Gateway restarts.");
});

test("Hermes: one reason line per finding, in the order of the reviewed sentences; a code it does not know is left out", () => {
  assert.equal(shared.HERMES_BLOCKED_LINE, "Agent OS updates Hermes only from an unchanged official copy.");
  assert.deepEqual(shared.hermesReasonLines(["no_checkout", "no_official_remote", "refs_unreadable", "not_on_release_or_main", "local_commits", "dirty_tree", "custom_channel", "folder_refused"]), [
    "Agent OS can't find Hermes's folder.",
    "Its folder doesn't come from the official Hermes repository.",
    "Agent OS can't read the official repository's references in its folder.",
    "It isn't on an official release or main.",
    "It has commits that aren't in the official repository.",
    "It has changes that aren't saved in a commit.",
    "It follows a different update channel.",
    "Hermes's folder is outside the places Agent OS may work."
  ]);
  // The order is the sentences', not the order the codes arrived in.
  assert.deepEqual(shared.hermesReasonLines(["dirty_tree", "local_commits"]), ["It has commits that aren't in the official repository.", "It has changes that aren't saved in a commit."]);
  assert.deepEqual(shared.hermesReasonLines(["something_new", "dirty_tree"]), ["It has changes that aren't saved in a commit."]);
  assert.deepEqual(shared.hermesReasonLines([]), []);
  assert.deepEqual(shared.hermesReasonLines(undefined), []);
});

test("Hermes: the four-step guide and the update session's heading", () => {
  assert.equal(shared.HERMES_GUIDE_TITLE, "To update a changed copy safely:");
  assert.deepEqual(
    shared.HERMES_GUIDE_STEPS.map((step) => `${step.text} ${step.command}`),
    [
      "Keep your changes on your own branch: git switch -c my-hermes",
      "Follow main: hermes update --set-channel main",
      "Keep your branch in place when updating: hermes config set updates.parked_branch_strategy update_in_place",
      "Update: hermes update"
    ]
  );
  assert.equal(shared.HERMES_UPDATE_HEADING, "Hermes update. Type into it if Hermes asks you something.");
});

test("the dot: any agent with an update, and it leads to the first one in the Agents page's order", () => {
  const order = ["hermes", "openclaw", "claude", "codex", "cursor"];
  assert.equal(shared.anyUpdateAvailable(null), false);
  assert.equal(shared.anyUpdateAvailable(answer([])), false, "the checks are off: an empty list");
  assert.equal(shared.anyUpdateAvailable(answer([row("claude", "up-to-date"), row("codex", "failed"), row("cursor", "unknown")])), false);
  const some = answer([row("cursor", "available"), row("claude", "available"), row("codex", "up-to-date")]);
  assert.equal(shared.anyUpdateAvailable(some), true);
  assert.equal(shared.firstAvailableAgent(some, order), "claude");
  assert.equal(shared.firstAvailableAgent(answer([]), order), null);
  assert.equal(shared.firstAvailableAgent(null, order), null);
  // Hermes counts even when Agent OS will not update its changed copy.
  assert.equal(shared.anyUpdateAvailable(answer([row("hermes", "available")], { clean: false, reasons: ["dirty_tree"] })), true);
  assert.equal(shared.UPDATE_DOT_TIP, "An agent has an update");
  assert.equal(shared.statusOf(some, "codex")?.state, "up-to-date");
  assert.equal(shared.statusOf(some, "hermes"), undefined);
  assert.equal(shared.statusOf(null, "codex"), undefined);
});

test("the three requests: the saved answer, Check for updates, and Update (with confirm: true); each has a time limit", async () => {
  const real = globalThis.fetch;
  try {
    const calls = [];
    const reply = (body) => async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET", body: options?.body ?? null });
      return { ok: true, status: 200, statusText: "OK", json: async () => body };
    };
    const good = answer([row("claude", "available")], { clean: false, reasons: ["dirty_tree"] });

    globalThis.fetch = reply(good);
    assert.deepEqual(await api.getUpdates(), good);
    assert.deepEqual(await api.refreshUpdates(), good);
    globalThis.fetch = reply({ kind: "job", jobId: "job-1" });
    assert.deepEqual(await api.startUpdate("claude"), { kind: "job", id: "job-1" });
    globalThis.fetch = reply({ kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" });
    assert.deepEqual(await api.startUpdate("hermes"), { kind: "session", id: "11111111-1111-4111-8111-111111111111" });
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url} ${call.body ?? ""}`.trim()),
      ["GET /api/updates", "POST /api/updates/refresh {}", 'POST /api/updates/claude {"confirm":true}', 'POST /api/updates/hermes {"confirm":true}']
    );

    // An answer without its parts is "could not be read", never a half page.
    globalThis.fetch = reply({ agents: "nope" });
    await assert.rejects(api.getUpdates(), /could not be read/);
    globalThis.fetch = reply({ kind: "other" });
    await assert.rejects(api.startUpdate("claude"), /could not be read/);
    globalThis.fetch = reply({ agents: [] });
    await assert.rejects(api.getUpdates(), /could not be read/);
    // A hermes part without its fields reads as "not clean, no reasons", the safe side.
    globalThis.fetch = reply({ agents: [], hermes: {} });
    assert.deepEqual(await api.getUpdates(), { agents: [], hermes: { clean: false, reasons: [] } });

    // A refusal keeps the server's code and its sentence (409 update_running / hermes_not_clean).
    globalThis.fetch = async () => ({
      ok: false, status: 409, statusText: "Conflict",
      json: async () => ({ error: "update_running", message: "Hermes is already updating." })
    });
    await assert.rejects(api.startUpdate("hermes"), (error) => error instanceof ApiError && error.message === "update_running" && error.detail === "Hermes is already updating." && error.status === 409);

    assert.deepEqual(api.UPDATE_LIMITS_MS, { read: 8000, refresh: 45000, start: 30000 });
  } finally {
    globalThis.fetch = real;
  }
});

test("a live Hermes update session is found on the server (kind=all&live=1), whoever started it; only a live update session of that agent counts", async () => {
  const real = globalThis.fetch;
  try {
    const calls = [];
    const sessions = (list) => async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ sessions: list, environmentNotice: null, pty: { ok: true, reason: null }, maxLive: 8 }) };
    };
    const live = { id: "7c1d2e3f-4a5b-4c6d-8e7f-0123456789ab", kind: "update", agentId: "hermes", status: "live" };
    globalThis.fetch = sessions([{ id: "a", kind: "agent", agentId: "hermes", status: "live" }, live]);
    assert.equal(await api.findLiveUpdateSession("hermes"), live.id);
    assert.deepEqual(calls, ["/api/sessions?kind=all&live=1"], "the list that includes update sessions, live ones only");
    globalThis.fetch = sessions([{ ...live, status: "starting" }]);
    assert.equal(await api.findLiveUpdateSession("hermes"), live.id, "a session still starting is live");
    for (const list of [[], [{ ...live, status: "exited" }], [{ ...live, kind: "agent" }], [{ ...live, kind: "setup" }], [{ ...live, agentId: "openclaw" }], [{ ...live, id: "" }], [null]]) {
      globalThis.fetch = sessions(list);
      assert.equal(await api.findLiveUpdateSession("hermes"), null, JSON.stringify(list));
    }
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });
    assert.equal(await api.findLiveUpdateSession("hermes"), null, "an answer without a list finds nothing");
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({ error: "not_available" }) });
    await assert.rejects(api.findLiveUpdateSession("hermes"), (error) => error instanceof ApiError && error.status === 404, "where sessions do not exist the caller hears of it");
  } finally {
    globalThis.fetch = real;
  }
});

test("a running update's id is remembered for the tab and forgotten when it ends; storage that fails or holds rubbish is ignored", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  try {
    const store = new Map();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
    });
    assert.equal(api.recallUpdateRun("hermes"), null);
    api.rememberUpdateRun("hermes", { kind: "session", id: "abc" });
    api.rememberUpdateRun("claude", { kind: "job", id: "job-9" });
    assert.deepEqual(api.recallUpdateRun("hermes"), { kind: "session", id: "abc" });
    assert.deepEqual(api.recallUpdateRun("claude"), { kind: "job", id: "job-9" });
    api.rememberUpdateRun("hermes", null);
    assert.equal(api.recallUpdateRun("hermes"), null);
    assert.deepEqual(api.recallUpdateRun("claude"), { kind: "job", id: "job-9" }, "each agent keeps its own");

    for (const rubbish of ["not json", "null", "{}", '{"kind":"other","id":"x"}', '{"kind":"job","id":""}', '{"kind":"job","id":5}']) {
      store.set("agentos.updates.run.codex", rubbish);
      assert.equal(api.recallUpdateRun("codex"), null, rubbish);
    }

    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } }
    });
    assert.equal(api.recallUpdateRun("claude"), null);
    assert.doesNotThrow(() => api.rememberUpdateRun("claude", { kind: "job", id: "j" }));
    assert.doesNotThrow(() => api.rememberUpdateRun("claude", null));
  } finally {
    if (real) Object.defineProperty(globalThis, "sessionStorage", real);
    else delete globalThis.sessionStorage;
  }
});

test("wiring: the Version block holds the panel (keyed by agent); the dot is off in the demo; an update's terminal has no way to stop it", () => {
  const bay = source("ui/components/AgentBay.tsx");
  assert.match(bay, /<AgentUpdatePanel key=\{agentId\} /, "one panel per agent, so a console never carries over to the next agent");
  assert.ok(bay.indexOf("<AgentUpdatePanel") > bay.indexOf("Installed <span"), "under the Installed line");

  const shell = source("ui/Shell.tsx");
  assert.match(shell, /<UpdatesProvider enabled=\{!props\.demoPublic && \(props\.demoKnown \?\? true\)\}>/, "the demo asks the server nothing about updates, not even before it knows it is one");
  const root = source("DashboardRoot.tsx");
  assert.match(root, /demoKnown=\{demoKnown\}/, "the root tells the shell when the product status has answered");
  assert.equal(root.split("setDemoKnown(true)").length - 1, 2, "whether it answered or failed");
  assert.match(shell, /const updateDot = !demoPublic && anyUpdateAvailable\(updates\.data\)/);
  assert.match(shell, /aria-label=\{UPDATE_DOT_TIP\}/);
  assert.match(shell, /navigateTo\("agents", updateAgent \? \{ agent: updateAgent \} : \{\}\)/, "the dot opens Agents");

  const terminal = source("ui/components/AgentUpdateTerminal.tsx").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(terminal, /stopSession|Close/, "hermes update is never stopped half way from here");
  const panel = source("ui/components/AgentUpdatePanel.tsx").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(panel, /stopSession|resumeSession|--yes/, "an update never stops or resumes a session, and answers nothing for the person");
  assert.match(panel, /confirm\(\)/, "Update goes through the dialog's confirm");
  assert.equal(panel.split("startUpdate(").length - 1, 1, "and startUpdate is called once, inside it");
  assert.ok(panel.indexOf("startUpdate(") > panel.indexOf("async function confirm"), "inside confirm");

  // The update console has no Cancel (fix round 1): it is Setup's panel with no onCancel, which then draws no button and no question.
  assert.doesNotMatch(panel, /cancelSetupJob|onCancel/, "the update console never cancels an agent's own updater");
  const setupPanel = source("ui/components/SetupInstallPanel.tsx");
  assert.match(setupPanel, /onCancel\?: \(\) => void;/, "onCancel is optional");
  assert.match(setupPanel, /job\.status === "running" && onCancel \?/, "no onCancel, no Cancel button");
  assert.match(setupPanel, /confirmingCancel && onCancel \?/, "and no question");
  for (const file of ["pages/SetupPage.tsx", "ui/components/SetupBrainPanel.tsx", "ui/components/BrainPlanCard.tsx"]) {
    assert.match(source(file), /onCancel=\{/, `${file} keeps its Cancel`);
  }
  // Hermes's two headings are h4s under the Version h3; the dialog's error is an alert like the panel's others.
  assert.match(panel, /<h4 id="os-agent-update-guide"/);
  assert.match(panel, /<h4 className="os-agent-update__run-title">/);
  assert.match(panel, /<p className="os-launch__error" role="alert">\s*\{startError\}/);
  assert.match(panel, /Check for updates\s*<\/button>/, "the Version block's button reads Check for updates");
  assert.doesNotMatch(panel, />\s*Check again\s*</, "and the page header's Check again is the only one with that name");
  // The orphaned update is looked for on mount and after a 409 update_running, on the server.
  assert.equal(panel.split("findLiveUpdateSession(").length - 1, 2, "once on mount, once after update_running");
  assert.match(panel, /error\.message === "update_running"/);
});

// ---- SP5 Task U2: Restart session banners ------------------------------------------------------------------------

test("Restart session: the banner, its confirm and the unavailable sentence are the reviewed words", () => {
  assert.equal(shared.restartTitle("2.1.310"), "Restart session to use v2.1.310");
  assert.equal(shared.RESTART_LABEL, "Restart session");
  assert.equal(shared.RESTART_NOT_NOW, "Not now");
  assert.equal(shared.restartDialogTitle("Claude Code", "my-app"), "Restart Claude Code in my-app?");
  // A session whose folder is not shown (OpenClaw picks its own) has no place to name: "Restart {agent}?" and nothing else.
  assert.equal(shared.restartDialogTitle("OpenClaw", null), "Restart OpenClaw?");
  assert.equal(shared.restartDialogTitle("OpenClaw", ""), "Restart OpenClaw?");
  assert.equal(shared.restartDialogBody("2.1.310"), "The session closes and starts again on v2.1.310.");
  assert.equal(
    shared.restartUnavailableLine("Another session in this folder is running."),
    "This session can't be resumed, so restarting would lose it. Another session in this folder is running."
  );
  // No resume reason to add: the first sentence stands alone, with no trailing space.
  assert.equal(shared.restartUnavailableLine(null), "This session can't be resumed, so restarting would lose it.");
  assert.equal(shared.restartUnavailableLine(""), "This session can't be resumed, so restarting would lose it.");
});

test("Restart session: a session needs a banner only when both versions can be read and they differ (the first dotted number)", () => {
  const session = (id, agentVersion) => ({ id, agentVersion });
  const ids = (sessions, installed) => shared.sessionsToRestart(sessions, installed).map((s) => s.id);

  assert.deepEqual(ids([session("old", "2.1.308"), session("same", "2.1.309")], "2.1.309"), ["old"]);
  // The agent's own line is compared by its number, the way the installed line is: words around it do not count.
  assert.deepEqual(ids([session("a", "2.1.309 (Claude Code)"), session("b", "Hermes Agent v0.22.4")], "2.1.309"), ["b"], "a number against a number");
  assert.deepEqual(ids([session("c", "Hermes Agent v0.22.5")], "0.22.5"), [], "the same number in other words");
  assert.deepEqual(ids([session("n", "2.1.309 (Claude Code)")], "claude 2.1.309"), [], "and the installed side may carry words too");
  // Newer counts as different too: a session can be on a version the saved check has not seen yet.
  assert.deepEqual(ids([session("newer", "2.1.311")], "2.1.310"), ["newer"]);
  // Anything unreadable on either side: no banner, never a guess.
  assert.deepEqual(ids([session("null", null), session("undef", undefined), session("words", "preview build"), session("empty", "")], "2.1.309"), []);
  for (const installed of [null, undefined, "", "unknown"]) assert.deepEqual(ids([session("x", "2.1.308")], installed), [], `installed ${JSON.stringify(installed)}`);
  assert.deepEqual(ids([], "2.1.309"), []);
});

test("Restart session: the installed version is the freshly detected one; the saved check's only when that cannot be read", () => {
  // The Version block's Installed line is the detection. The saved check can be a day old: an auto-updater, brew or npm
  // changes the version outside Agent OS, and a banner built on the old number would be false.
  assert.equal(shared.installedVersionNumber("claude 2.1.309", "2.1.200"), "2.1.309", "detected wins over the row");
  assert.equal(shared.installedVersionNumber("2.1.309 (Claude Code)", null), "2.1.309", "and stands without a row");
  assert.equal(shared.installedVersionNumber("no version printed", "2.1.200"), "2.1.200", "unreadable: the row");
  assert.equal(shared.installedVersionNumber("", "2.1.200"), "2.1.200");
  assert.equal(shared.installedVersionNumber(null, "2.1.200"), "2.1.200");
  assert.equal(shared.installedVersionNumber(undefined, undefined), null);
  assert.equal(shared.installedVersionNumber("none", "none"), null);
});

test("Restart session: the panel wires banners to the open sessions of its agent, one confirm, one restart request", () => {
  const panel = source("ui/components/AgentUpdatePanel.tsx").replace(/\/\/.*$/gm, "");
  assert.match(panel, /sessionsToRestart\(openHere, /, "banners come from this agent's open sessions");
  // One installed number for the banner, its confirm and the Update dialog's open-sessions line, detection first.
  assert.match(panel, /installedVersionNumber\(installedVersion, status\?\.installed\)/, "the detected version first, the row second");
  assert.match(panel, /const oldVersion = installedNumber \?\? ""/, "the Update dialog says the same number as the banner");
  assert.doesNotMatch(panel, /status\?\.installed \|\| versionNumber/, "the old row-first order is gone");
  // The place in the confirm's title: none when the folder is not shown.
  assert.match(panel, /session\.folderShown === false/, "a hidden folder is not named");
  assert.doesNotMatch(panel, /panelFolder/, "and the field label 'Set by OpenClaw' is never taken for a place");
  assert.equal(panel.split("restartSession(").length - 1, 1, "restartSession is called once, inside the confirm");
  assert.ok(panel.indexOf("restartSession(") > panel.indexOf("async function restart"), "inside restart()");
  assert.match(panel, /cancelLabel=\{RESTART_NOT_NOW\}/, "the dialog's closing button reads Not now");
  assert.match(panel, /confirmLabel=\{RESTART_LABEL\}/);
  // The request posts no keys: the API wrapper sends the restart route and nothing else.
  const api = source("sessionsApi.ts");
  assert.match(api, /export function restartSession\(sessionId: string\)[^}]*sessionPath\(sessionId, "\/restart"\), postJson\(\)/, "POST /api/sessions/:id/restart with an empty body");
  // The button is drawn only when the server said the session can be resumed (restart.available === true); the unavailable
  // sentence only when it said it cannot. A missing or null `restart` (an older server, a live-only list) draws neither.
  const banner = source("ui/components/RestartBanner.tsx").replace(/\/\/.*$/gm, "");
  assert.match(banner, /restartUnavailableLine\(/);
  assert.match(banner, /const canRestart = session\.restart\?\.available === true;/);
  assert.match(banner, /const cannotRestart = session\.restart\?\.available === false;/);
  assert.match(banner, /canRestart \? \(/, "a button only when it can");
  assert.match(banner, /cannotRestart \? <p>/, "the unavailable sentence only when it cannot");
  // Several banners can stand together: the button's name carries its session's own line.
  assert.match(banner, /aria-labelledby=\{`\$\{buttonId\} \$\{lineId\}`\}/);
  assert.match(panel, /<RestartBanner/);
  // The block the keys fall back to has a name.
  assert.match(panel, /role="group"[^>]*aria-labelledby="os-agent-version-title"|aria-labelledby="os-agent-version-title"[^>]*role="group"/);
});
