// Safety's pure logic (src/ui/safetyShared.ts). Node strips the TypeScript types
// itself (decision P14), so the .ts file is imported directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as safety from "../src/ui/safetyShared.ts";
import { RISKY_STEP_HINT } from "../src/ui/newRun.ts";

test("the arming phrase is unchanged and must match exactly (spaces around it are ignored)", () => {
  assert.equal(safety.ARM_PHRASE, "ENABLE MACHINE CONTROL");
  assert.equal(safety.phraseMatches("ENABLE MACHINE CONTROL"), true);
  assert.equal(safety.phraseMatches("  ENABLE MACHINE CONTROL "), true);
  assert.equal(safety.phraseMatches("enable machine control"), false);
  assert.equal(safety.phraseMatches("ENABLE MACHINE"), false);
});

test("levelOf uses the server's level, or derives it from the two real flags", () => {
  assert.equal(safety.levelOf({ enabled: true, level: 2 }, null), 2);
  assert.equal(safety.levelOf({ enabled: false }, null), 0);
  assert.equal(safety.levelOf({ enabled: true }, { armed: false }), 1);
  assert.equal(safety.levelOf({ enabled: true }, { armed: true }), 2);
});

test("each level's foot line says what pressing it does", () => {
  assert.equal(safety.levelFoot(1, 1, ""), "Current");
  assert.equal(safety.levelFoot(0, 1, ""), "Applies at once");
  assert.equal(safety.levelFoot(1, 0, ""), "Asks you first");
  assert.equal(safety.levelFoot(2, 1, ""), "Off. Needs a typed phrase");
  assert.equal(safety.levelFoot(2, 2, "29:41"), "On. Turns off in 29:41");
  assert.equal(safety.levelFoot(1, null, ""), "…");
});

test("every level says what agents can do, ask about and cannot do, in plain words with no em dash", () => {
  for (const n of [0, 1, 2]) {
    const d = safety.LEVEL_DETAIL[n];
    for (const text of [d.can, d.asks, d.cannot, safety.LEVELS[n].blurb]) {
      assert.ok(text.length > 10, `level ${n}: "${text}"`);
      assert.ok(!text.includes("—"), `no em dash in "${text}"`);
    }
  }
  assert.match(safety.LEVEL_DETAIL[2].cannot, /30 minutes/);
});

test("the always-on safeguards are only true-today claims", () => {
  assert.deepEqual(safety.ALWAYS_ON.map((row) => row.title), [
    "No skip-permissions flags, ever",
    "New runs start in a Workspace folder",
    "Updater questions are never answered for you"
  ]);
  assert.ok(safety.ALWAYS_ON.every((row) => !/session|hand-off|worktree/i.test(row.detail)), "no SP3 to SP5 promises");
});

// ---- What the P26 lessons add: copy that stays true, and honest unknowns ----

test("Level 1 says the same sentence as the New run dialog about what it refuses (owner ruling C3-3)", () => {
  assert.ok(safety.LEVELS[1].blurb.includes(RISKY_STEP_HINT), safety.LEVELS[1].blurb);
  assert.ok(safety.LEVEL_DETAIL[1].asks.includes(RISKY_STEP_HINT), safety.LEVEL_DETAIL[1].asks);
  for (const text of [safety.LEVELS[1].blurb, safety.LEVEL_DETAIL[1].asks, safety.LEVEL_DETAIL[1].cannot]) {
    assert.doesNotMatch(text, /Held|asks or stops/, `the old idea is gone: "${text}"`);
  }
});

test("no level word promises what the server does not do", () => {
  // Look only kills nothing that is already running: a run keeps going until it ends or the person stops it.
  assert.match(safety.LEVEL_DETAIL[0].asks, /run that is already going keeps going until it ends or you stop it/);
  // ...but it starts nothing (owner decision, 2026-10-14): a Team Room already going stops before its next
  // turn, and Setup and the Agents page skip their hello check (the "reply ready" test). The old words said
  // both still ran; they must not come back.
  assert.match(safety.LEVEL_DETAIL[0].asks, /^Nothing, because no new agent run, session or Team Room can start\./);
  assert.match(safety.LEVEL_DETAIL[0].asks, /Team Room that is already going stops before its next turn/);
  assert.match(safety.LEVEL_DETAIL[0].asks, /Setup and the Agents page skip their hello check/);
  assert.doesNotMatch(safety.LEVEL_DETAIL[0].asks, /brain check|still runs|run or Team Room that is already going keeps going/);
  // ...but Setup's own steps are NOT gated, and the words must not say "nothing can start" as if they were: the
  // installers, the sign-in login, the always-on services step and the config steps run when the person presses them.
  assert.match(safety.LEVEL_DETAIL[0].asks, /Setup's own install, sign-in, service and config steps still run when you press them/);
  assert.doesNotMatch(safety.LEVEL_DETAIL[0].asks, /nothing new can start/);
  // The blurb on the card and the cell in the table say the same thing about what starts.
  assert.match(safety.LEVELS[0].blurb, /starts no new agent run, session or Team Room/);
  assert.doesNotMatch(safety.LEVELS[0].blurb, /nothing can start|nothing new/i);
  for (const text of [safety.LEVELS[0].blurb, safety.LEVEL_DETAIL[0].cannot]) {
    assert.doesNotMatch(text, /No agent can start|Start an agent run or a Team Room/, text);
    assert.match(text, /new/i, text);
  }
  // Machine control is Agent OS's own screen, mouse and keyboard feature; shell commands stay off
  // unless switched on separately and each one needs a confirmation.
  assert.match(safety.LEVEL_DETAIL[2].asks, /shell command/i);
  assert.doesNotMatch(safety.LEVEL_DETAIL[2].can, /shell/i, "shell commands are off by default, so they are not a promise");
  assert.doesNotMatch(safety.LEVEL_DETAIL[1].cannot, /system settings|reach folders/i, "only what Agent OS enforces");
});

// SP3 (Task U4; the Safety words test of Review Focus 5, rulings R23 and R28): sessions start outside the Workspace,
// in a folder the person picks inside their home folder (server/runtime/sessions/folders.js), and Look only refuses a
// new or resumed session while an open one keeps running (manager.js, decision Q15). OpenClaw's terminal starts in the
// home folder itself until spike S5.
test("SP3: the level words say where sessions start, and that Look only starts none but stops none either", () => {
  assert.equal(safety.LEVELS[0].blurb, "Agents are found and past runs shown. Agent OS starts no new agent run, session or Team Room.");
  assert.match(safety.LEVEL_DETAIL[0].asks, / A session that is already open keeps running until you stop it\.$/);
  assert.equal(safety.LEVEL_DETAIL[0].cannot, "Start a new agent run, session or Team Room, or use machine control.");
  assert.equal(
    safety.LEVELS[1].blurb,
    `Runs start in a folder inside the Workspace (OpenClaw's Gateway uses its own). Sessions start in a folder you pick inside your home folder (OpenClaw picks its own for now). ${RISKY_STEP_HINT}`
  );
  assert.equal(
    safety.LEVEL_DETAIL[1].can,
    "Run the agents you choose: a run starts in a folder inside the Workspace (OpenClaw's Gateway uses its own folder), and a session, the agent's own terminal, starts in a folder you pick inside your home folder (OpenClaw picks its own for now), where the agent asks its own permissions as in Terminal."
  );
  assert.equal(
    safety.LEVEL_DETAIL[1].cannot,
    "Use machine control, which needs Level 2, start a run in a folder outside the Workspace, or start a session outside your home folder or in Agent OS's own folders."
  );
});

test("the Updater safeguard names only the agents Setup really updates (Hermes has no update step)", () => {
  const row = safety.ALWAYS_ON.find((r) => /Updater/.test(r.title));
  assert.doesNotMatch(row.who, /Hermes/);
  assert.match(row.who, /OpenClaw/);
  assert.doesNotMatch(row.detail, /stops and says so/, "what an updater does with no input is not promised");
});

test("machineOn: only a real expiry time counts, and never at Look only or while the level is unknown", () => {
  const mc = (over = {}) => ({ armed: true, expiresAt: "2030-01-01T00:00:00.000Z", ...over });
  assert.equal(safety.machineOn(2, mc()), true);
  assert.equal(safety.machineOn(1, mc()), true, "an armed flag is never hidden at Level 1");
  assert.equal(safety.machineOn(0, mc()), false);
  assert.equal(safety.machineOn(null, mc()), false);
  assert.equal(safety.machineOn(2, mc({ armed: false })), false);
  assert.equal(safety.machineOn(2, mc({ expiresAt: null })), false);
  assert.equal(safety.machineOn(2, null), false);
});

const detail = (over = {}) => ({
  detected: { installed: true, version: "1.0.0" },
  safety: { permissive: false, summary: "", actions: [] },
  ...over
});
const CHECKED = { hermes: true, openclaw: true };
const PENDING = { hermes: false, openclaw: false };
const missing = { detected: { installed: false, error: "hermes was not found on PATH." }, safety: { permissive: false, summary: "Hermes is not installed.", actions: [] } };
const broken = { detected: { installed: false, error: "spawn EACCES" }, safety: { permissive: false, summary: "", actions: [] } };

test("agent checks: Hermes on or off, from the real safety answer", () => {
  const on = safety.agentGuardRows(detail(), detail({ safety: { permissive: false, actions: [] } }), CHECKED);
  assert.deepEqual(on.map((r) => [r.key, r.state]), [["hermes-approvals", "on"], ["openclaw-exec", "on"], ["openclaw-cookies", "on"]]);
  const off = safety.agentGuardRows(detail({ safety: { permissive: true, actions: [] } }), detail({ safety: { permissive: true, actions: [{ id: "exec-ask" }, { id: "no-browser-cookies" }] } }), CHECKED);
  assert.deepEqual(off.map((r) => r.state), ["off", "off", "off"]);
  const mixed = safety.agentGuardRows(detail(), detail({ safety: { permissive: true, actions: [{ id: "no-browser-cookies" }] } }), CHECKED);
  assert.deepEqual(mixed.map((r) => r.state), ["on", "on", "off"]);
});

test("agent checks never claim a safeguard for an agent that is not there or could not be read", () => {
  const rows = safety.agentGuardRows(missing, broken, CHECKED);
  assert.deepEqual(rows.map((r) => [r.key, r.state]), [["hermes-approvals", "missing"], ["openclaw-exec", "unknown"]]);
  assert.match(rows[0].sub, /not installed/i);
  const failed = safety.agentGuardRows(null, null, CHECKED);
  assert.deepEqual(failed.map((r) => r.state), ["unknown", "unknown"]);
  const pending = safety.agentGuardRows(null, null, PENDING);
  assert.deepEqual(pending.map((r) => r.state), ["loading", "loading"]);
  for (const row of [...rows, ...failed, ...pending]) {
    assert.ok(!row.title.includes("—") && !row.sub.includes("—"), "no em dash in visible text");
  }
});

test("a slow agent never hides the other agent's row: each one is checked on its own", () => {
  const onlyHermes = safety.agentGuardRows(detail(), null, { hermes: true, openclaw: false });
  assert.deepEqual(onlyHermes.map((r) => [r.key, r.state]), [["hermes-approvals", "on"], ["openclaw-exec", "loading"]]);
  const onlyOpenclaw = safety.agentGuardRows(null, detail(), { hermes: false, openclaw: true });
  assert.deepEqual(onlyOpenclaw.map((r) => [r.key, r.state]), [["hermes-approvals", "loading"], ["openclaw-exec", "on"], ["openclaw-cookies", "on"]]);
  const hermesFailed = safety.agentGuardRows(null, null, { hermes: true, openclaw: false });
  assert.deepEqual(hermesFailed.map((r) => r.state), ["unknown", "loading"], "a failed read is unknown, a pending one is loading");
});

test("a row's spoken name says what it opens and what its state is", () => {
  const [row] = safety.agentGuardRows(detail({ safety: { permissive: true, actions: [] } }), null, CHECKED);
  const label = safety.guardRowLabel(row);
  assert.match(label, /Hermes asks before running commands/);
  assert.match(label, /Off/);
  assert.match(label, /Open Hermes on Agents/);
  assert.match(safety.guardRowLabel({ ...row, state: "unknown" }), /Status unknown/);
  assert.match(safety.guardRowLabel({ ...row, state: "loading" }), /Checking/);
  assert.match(safety.guardRowLabel({ ...row, state: "missing" }), /Not installed/);
});

test("a failed change never says nothing was changed when Agent OS gave no answer", () => {
  const dropped = safety.changeProblem("Agent OS did not answer.", "");
  assert.match(dropped, /may not have gone through/);
  assert.doesNotMatch(dropped, /nothing was changed|nothing changed/i);
  const slow = safety.changeProblem("Agent OS did not answer in time.", "");
  assert.match(slow, /^Agent OS did not answer in time\./);
  assert.match(slow, /may not have gone through/);
  // A refusal Agent OS sent itself is shown as it came.
  assert.equal(safety.changeProblem(null, "Turn on the execution gate before arming machine control."), "Turn on the execution gate before arming machine control.");
  assert.equal(safety.changeProblem(null, ""), "Agent OS did not make that change.");
});

test("no visible text in the always-on or level words has an em dash", () => {
  const all = [...safety.ALWAYS_ON.flatMap((r) => [r.title, r.detail, r.who]), ...Object.values(safety.LEVELS).flatMap((l) => [l.label, l.blurb])];
  for (const text of all) assert.ok(!text.includes("—"), text);
});

// ---- Fix round 1: states and words that must not say something untrue ----

test("levelOf: a gate answer that is not a valid shape is unknown (null), never Look only", () => {
  const odd = [null, undefined, "ok", 7, [], {}, { enabled: "true" }, { enabled: 1 }, { level: 7, enabled: true }, { level: "1", enabled: true }, { level: -1, enabled: false }, { level: 1.5, enabled: true }, { level: Number.NaN }];
  for (const gate of odd) assert.equal(safety.levelOf(gate, { armed: false }), null, `gate ${String(JSON.stringify(gate))}`);
  // A missing or null level still derives from the two real flags (older servers).
  assert.equal(safety.levelOf({ enabled: true, level: null }, { armed: false }), 1);
  assert.equal(safety.levelOf({ enabled: false, level: undefined }, null), 0);
  assert.equal(safety.levelOf({ enabled: true }, undefined), 1);
  // Only a real `true` arms; the server's own level wins.
  assert.equal(safety.levelOf({ enabled: true }, { armed: "yes" }), 1);
  assert.equal(safety.levelOf({ enabled: true, level: 1 }, "x"), 1);
});

test("each level foot tells the truth about what is possible on this computer", () => {
  // Machine control is not supported here (not macOS): no "typed phrase" promise, no lock.
  assert.equal(safety.levelFoot(2, 1, "", { supported: false }), "Not available on this computer.");
  assert.equal(safety.levelFoot(2, 1, "", { supported: true }), "Off. Needs a typed phrase");
  assert.equal(safety.levelFoot(2, null, "", { supported: false }), "…", "an unknown level claims nothing");
  // Look only is locked off by the computer's own settings: it does not promise "Applies at once".
  assert.equal(safety.levelFoot(0, 1, "", { envLocked: true }), safety.ENV_LOCK_FOOT);
  assert.equal(safety.levelFoot(0, 2, "", { envLocked: true }), safety.ENV_LOCK_FOOT);
  assert.equal(safety.levelFoot(0, 1, ""), "Applies at once");
  assert.equal(safety.levelFoot(1, 1, "", { envLocked: true }), "Current");
  // Contact lost: the machine-control foot stops counting down and says it is the last known state.
  const last = safety.levelFoot(2, 2, "29:41", { lastKnown: true });
  assert.equal(last, "On when last checked");
  assert.doesNotMatch(last, /\d\d:\d\d/);
  assert.equal(safety.levelFoot(2, 2, "29:41", {}), "On. Turns off in 29:41");
  // The pressed card shows that a change is on its way.
  assert.equal(safety.levelFoot(0, 1, "", { changing: true }), "Changing…");
  assert.equal(safety.levelFoot(1, 2, "05:00", { changing: true }), "Changing…");
  assert.equal(safety.levelFoot(0, null, "", { changing: true }), "…");
});

test("the environment lock is explained in plain words, on the card and in the refusal", () => {
  assert.equal(
    safety.ENV_LOCK_WORDS,
    "This computer's settings keep agents allowed to run, so Agent OS cannot switch to Look only from here."
  );
  assert.ok(!safety.ENV_LOCK_WORDS.includes("—") && !safety.ENV_LOCK_FOOT.includes("—"));
  const locked = { enabled: true, envLocked: true, publicSummary: "Trusted live execution is enabled by HERMES_AGENT_OS_ENABLE_EXEC=1." };
  assert.equal(safety.lookOnlyRefusal(locked), safety.ENV_LOCK_WORDS, "the refusal does not show a variable name");
  assert.equal(safety.lookOnlyRefusal({ enabled: true, envLocked: false, publicSummary: "Something else." }), "Something else.");
  assert.equal(safety.lookOnlyRefusal({ enabled: true }), "Agent OS did not turn Run agents off.");
  assert.equal(safety.lookOnlyRefusal(null), "Agent OS did not turn Run agents off.");
});

test("while the level is unknown the detail panel names no level and shows no level-specific words", () => {
  assert.equal(safety.levelHeading(1), "What Level 1 · Run agents means");
  assert.equal(safety.levelHeading(0), "What Level 0 · Look only means");
  assert.equal(safety.levelHeading(2), "What Level 2 · Machine control means");
  assert.equal(safety.levelHeading(null), "What Level — means");
  assert.ok(safety.LEVEL_UNKNOWN_NOTE.length > 20);
  assert.doesNotMatch(safety.LEVEL_UNKNOWN_NOTE, /Look only|Run agents|Machine control|Level [012]/);
  assert.ok(!safety.LEVEL_UNKNOWN_NOTE.includes("—"));
});

test("contact lost while machine control was on: the banner is the last known state, with no countdown", () => {
  assert.equal(safety.MACHINE_LAST_KNOWN_TITLE, "Last known: machine control was on.");
  const words = safety.machineLostWords("10:42");
  assert.match(words, /cannot be reached/);
  assert.match(words, /cannot tell whether it is still on/);
  assert.match(words, /due to turn itself off at 10:42/);
  assert.doesNotMatch(words, /\d\d:\d\d left|turns itself off in/);
  const noTime = safety.machineLostWords("");
  assert.doesNotMatch(noTime, /due to turn itself off/, "no time, no made-up time");
  assert.match(noTime, /cannot tell whether it is still on/);
});

test("the stale-checks warning names only the agents whose re-check failed", () => {
  assert.equal(safety.staleWords([]), "");
  const hermes = safety.staleWords(["Hermes"]);
  assert.match(hermes, /could not re-check Hermes just now/);
  assert.doesNotMatch(hermes, /OpenClaw/);
  const openclaw = safety.staleWords(["OpenClaw"]);
  assert.match(openclaw, /could not re-check OpenClaw just now/);
  assert.doesNotMatch(openclaw, /Hermes/);
  assert.match(safety.staleWords(["Hermes", "OpenClaw"]), /could not re-check Hermes and OpenClaw just now/);
});

test("the page lede does not promise to show what agents are asking (nothing arrives there yet)", () => {
  assert.doesNotMatch(safety.PAGE_LEDE, /asking|see what/i);
  assert.match(safety.PAGE_LEDE, /Pick a level/);
  assert.match(safety.PAGE_LEDE, /stop all agent work/);
  assert.ok(!safety.PAGE_LEDE.includes("—"));
});

test("the always-on rows only claim runs started from Agent OS (the run manager), not 'all five agents'", () => {
  for (const row of safety.ALWAYS_ON) assert.doesNotMatch(row.who, /all five agents/i, row.title);
  const flags = safety.ALWAYS_ON[0];
  const folder = safety.ALWAYS_ON[1];
  assert.match(flags.who, /start from Agent OS/);
  assert.match(folder.who, /start from Agent OS/);
  // Only the folder check is enforced; where the agent then works is its own (OpenClaw's Gateway, a shell).
  assert.ok(folder.detail.startsWith("Agent OS refuses a start folder outside the Workspace"), folder.detail);
  assert.match(folder.detail, /OpenClaw, when its Gateway is running, works in its own folder/);
  assert.match(folder.detail, /not locked to its folder/);
  assert.doesNotMatch(folder.title + folder.detail, /stay inside|works in a folder inside|every agent run/i);
  assert.doesNotMatch(safety.LEVELS_QUIET, /all five agents/i);
  assert.match(safety.LEVELS_QUIET, /start from Agent OS/);
});

test("a Hermes setting Agent OS could not read is unknown, never On", () => {
  const unreadable = detail({ safety: { permissive: false, summary: "Agent OS could not read Hermes's approvals setting.", actions: [], known: false } });
  const rows = safety.agentGuardRows(unreadable, null, CHECKED);
  assert.deepEqual(rows.map((r) => [r.key, r.state]), [["hermes-approvals", "unknown"], ["openclaw-exec", "unknown"]]);
  assert.match(rows[0].sub, /could not be read/i);
  assert.match(safety.guardRowLabel(rows[0]), /Status unknown/);
  assert.doesNotMatch(safety.guardRowLabel(rows[0]), /\bOn\b/);
  // known: true, or no `known` at all (older servers), reads as before.
  for (const known of [true, undefined]) {
    const [row] = safety.agentGuardRows(detail({ safety: { permissive: false, summary: "Hermes approvals are on.", actions: [], known } }), null, CHECKED);
    assert.equal(row.state, "on", `known: ${known}`);
  }
  const [off] = safety.agentGuardRows(detail({ safety: { permissive: true, summary: "", actions: [], known: true } }), null, CHECKED);
  assert.equal(off.state, "off");
});

test("Safety waits as long as the server can take for an agent's own checks: the shared Agents-page limit, not its own number", async () => {
  const { readFileSync } = await import("node:fs");
  const home = await import("../src/ui/homeShared.ts");
  // The server's worst case for GET /api/agents/:id is the version check (about 5 s) plus the doctor (30 s).
  assert.ok(home.AGENT_DETAIL_LIMIT_MS >= 35_000, "the shared limit is above the server's worst case");
  const page = readFileSync(new URL("../src/pages/SafetyPage.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{[^}]*\bAGENT_DETAIL_LIMIT_MS\b[^}]*\} from "\.\.\/ui\/homeShared"/, "the limit is imported, not copied");
  assert.match(page, /withTimeout\(getAgentDetail\(id\), AGENT_DETAIL_LIMIT_MS\)/, "the agent read uses it");
  assert.doesNotMatch(page, /GUARDS_TIMEOUT_MS/, "no second constant of its own");
  assert.doesNotMatch(page, /25\s?s\b|25000|25_000/, "no leftover 25 s limit or comment");
});
