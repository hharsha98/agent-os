// SP5 Task V1: the pure helpers of the version checks (server/runtime/updates/
// versions.js). They compare version texts and read what an agent's own
// check printed; nothing here starts a process or touches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelFromSettings,
  compareVersions,
  parseDistTags,
  parseHermesCheck,
  parseOpenclawDryRun,
  versionNumber
} from "../server/runtime/updates/versions.js";

test("compareVersions: compares the first dotted number of each text, part by part", () => {
  const rows = [
    ["2.1.309 (Claude Code)", "2.1.310", -1],
    ["codex-cli 0.154.0", "0.154.0", 0],
    ["2026.10.9", "2026.10.4", 1],
    ["v0.22.5", "0.22.5", 0],
    ["2026.10.14-941492e", "", null],
    ["abc", "1.0", null]
  ];
  for (const [a, b, expected] of rows) {
    assert.equal(compareVersions(a, b), expected, `compareVersions(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  }
});

test("compareVersions: parts are numbers (10 is above 9), a missing part is 0, and a text with no dotted number is null", () => {
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0", "1.0.1"), -1);
  assert.equal(compareVersions("2026.10.14-941492e", "2026.10.14"), 0, "a suffix after the number is ignored");
  assert.equal(compareVersions("7", "7"), null, "a lone integer is not a dotted number");
  assert.equal(compareVersions(undefined, "1.0"), null);
  assert.equal(compareVersions("1.0", null), null);
});

test("versionNumber: the first dotted number of a text, else null", () => {
  assert.equal(versionNumber("2.1.309 (Claude Code)"), "2.1.309");
  assert.equal(versionNumber("codex-cli 0.154.0"), "0.154.0");
  assert.equal(versionNumber("v0.22.5"), "0.22.5");
  assert.equal(versionNumber("2026.10.14-941492e"), "2026.10.14");
  assert.equal(versionNumber("unknown"), null);
  assert.equal(versionNumber(""), null);
  assert.equal(versionNumber(null), null);
});

test("parseDistTags: reads latest from the registry's dist-tags answer, else null", () => {
  assert.equal(parseDistTags('{"latest":"2.1.310","next":"2.2.0-beta.1"}'), "2.1.310");
  assert.equal(parseDistTags('{"next":"2.2.0-beta.1"}'), null, "no latest tag");
  assert.equal(parseDistTags('{"latest":""}'), null);
  assert.equal(parseDistTags('{"latest":42}'), null, "latest must be text");
  assert.equal(parseDistTags('{"latest":"soon"}'), null, "latest must hold a dotted number");
  assert.equal(parseDistTags("<html>Bad gateway</html>"), null);
  assert.equal(parseDistTags('["latest"]'), null);
  assert.equal(parseDistTags(""), null);
  assert.equal(parseDistTags(undefined), null);
});

test("parsers ignore notice lines", () => {
  // OpenClaw: a banner line before the JSON, and a notice after it.
  const dryRun = [
    "OpenClaw update check (dry run)",
    JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.9", restart: true, downgradeRisk: false }),
    "Nothing was changed."
  ].join("\n");
  assert.deepEqual(parseOpenclawDryRun(dryRun), {
    current: "2026.10.4",
    target: "2026.10.9",
    restartsGateway: true,
    downgradeRisk: false
  });

  // The same document printed over several lines (pretty JSON) still reads.
  const pretty = `banner {not json}\n${JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.9", restart: false, downgradeRisk: true }, null, 2)}\n`;
  assert.deepEqual(parseOpenclawDryRun(pretty), {
    current: "2026.10.4",
    target: "2026.10.9",
    restartsGateway: false,
    downgradeRisk: true
  });

  // Hermes: a notice after the verdict line.
  assert.deepEqual(
    parseHermesCheck({
      code: 0,
      stdout: "⚕ Update available: 3 commits behind origin/main.\nRun 'hermes update' to install."
    }),
    { state: "available", latest: null }
  );
  assert.deepEqual(parseHermesCheck({ code: 0, stdout: "✓ Already up to date." }), { state: "up-to-date", latest: null });
  assert.deepEqual(parseHermesCheck({ code: 0, stdout: "note: a newer Hermes notice\n✓ Already up to date.\n" }), {
    state: "up-to-date",
    latest: null
  });
  assert.equal(parseHermesCheck({ code: 1, stdout: "✓ Already up to date." }), null, "a failed exit is never an answer");
  assert.equal(parseHermesCheck({ code: 2, stdout: "⚕ Update available: 3 commits behind origin/main." }), null);
});

test("parseOpenclawDryRun: the last JSON object wins; anything that is not a dry-run answer is null", () => {
  const two = [
    JSON.stringify({ currentVersion: "1.0.0", targetVersion: "1.0.1", restart: false, downgradeRisk: false }),
    JSON.stringify({ currentVersion: "2026.10.4", targetVersion: "2026.10.9", restart: true, downgradeRisk: false })
  ].join("\n");
  assert.equal(parseOpenclawDryRun(two).target, "2026.10.9");

  // Missing or odd fields: a version that is not text becomes null, a flag counts only when it is exactly true.
  assert.deepEqual(parseOpenclawDryRun('{"currentVersion":"2026.10.4","restart":"yes"}'), {
    current: "2026.10.4",
    target: null,
    restartsGateway: false,
    downgradeRisk: false
  });
  // An object with no version in it is not a dry-run answer (an error document, say).
  assert.equal(parseOpenclawDryRun('{"targetVersion":9,"restart":true}'), null);
  assert.equal(parseOpenclawDryRun('{"error":"gateway not running"}'), null);

  assert.equal(parseOpenclawDryRun(""), null);
  assert.equal(parseOpenclawDryRun(undefined), null);
  assert.equal(parseOpenclawDryRun("openclaw: unknown option --dry-run"), null);
  assert.equal(parseOpenclawDryRun('["not","an","object"]'), null);
  assert.equal(parseOpenclawDryRun('{"broken": '), null);
});

test("parseHermesCheck: no recognised verdict is null (the check could not tell)", () => {
  assert.equal(parseHermesCheck({ code: 0, stdout: "" }), null);
  assert.equal(parseHermesCheck({ code: 0, stdout: "something else entirely" }), null);
  assert.equal(parseHermesCheck({ code: 0 }), null);
  assert.equal(parseHermesCheck({}), null);
  assert.equal(parseHermesCheck(undefined), null);
  assert.equal(parseHermesCheck({ code: null, stdout: "✓ Already up to date." }), null, "a missing exit code is not success");
  assert.equal(parseHermesCheck({ code: "ENOENT", stdout: "" }), null);
});

// ---- Hermes's release-channel wording (SP5 E2, R48) ---------------------------------------------------------

test("parseHermesCheck: each line Hermes prints on a release channel, and the older wording that still works", () => {
  const rows = [
    // [the line, state, latest]
    ["→ This checkout is newer than the selected release: v0.22.9 vs stable v0.22.7", "up-to-date", null],
    ["→ Holding at this build: it was pinned", "up-to-date", null],
    ["→ Selected release available: stable v0.22.7 (b200f5bc60e3)", "available", "0.22.7"],
    ["⚕ Update available: 3 commits behind origin/main.", "available", null],
    ["✓ Up to date with the latest release (stable v0.22.7).", "up-to-date", null],
    ["✓ No newer release: stable v0.22.7.", "up-to-date", null],
    ["✓ Already up to date.", "up-to-date", null]
  ];
  for (const [line, state, latest] of rows) {
    assert.deepEqual(parseHermesCheck({ code: 0, stdout: line }), { state, latest }, line);
  }
});

test("parseHermesCheck: the number comes from the rest of the 'Selected release available' line; none there still means available", () => {
  const read = (stdout) => parseHermesCheck({ code: 0, stdout });
  assert.deepEqual(read("Selected release available: stable v0.22.7 (b200f5bc60e3)"), { state: "available", latest: "0.22.7" });
  assert.deepEqual(read("→ Selected release available: 2026.5.1"), { state: "available", latest: "2026.5.1" });
  assert.deepEqual(read("→ selected RELEASE available: v1.2.3"), { state: "available", latest: "1.2.3" }, "any letter case");
  assert.deepEqual(read("→ Selected release available: nightly"), { state: "available", latest: null }, "a label with no number");
  assert.deepEqual(read("→ Selected release available:"), { state: "available", latest: null });
});

test("parseHermesCheck: the whole three-line output of a release channel", () => {
  const stdout = [
    "→ Update channel: stable",
    "→ Selected release available: stable v0.22.7 (b200f5bc60e3)",
    "  Run `hermes update` to install it."
  ].join("\n");
  assert.deepEqual(parseHermesCheck({ code: 0, stdout }), { state: "available", latest: "0.22.7" });
  assert.deepEqual(parseHermesCheck({ code: 0, stdout: `${stdout}\n` }), { state: "available", latest: "0.22.7" });
  assert.deepEqual(parseHermesCheck({ code: 0, stdout: stdout.replace(/\n/g, "\r\n") }), { state: "available", latest: "0.22.7" });
});

test("parseHermesCheck: the rows are tried in order, so a step back is never offered", () => {
  const read = (...lines) => parseHermesCheck({ code: 0, stdout: lines.join("\n") });
  // "This checkout is newer" beats an 'available' line anywhere in the output: hermes update would move it BACK.
  assert.deepEqual(read("→ Selected release available: stable v0.22.7", "→ This checkout is newer than the selected release: v0.22.9"), {
    state: "up-to-date",
    latest: null
  });
  assert.deepEqual(read("⚕ Update available: 3 commits behind origin/main.", "→ This checkout is newer than the selected release"), {
    state: "up-to-date",
    latest: null
  });
  // "Holding at this build" stays put, ahead of the lines below it in the table.
  assert.deepEqual(read("→ Holding at this build: pinned", "→ Selected release available: stable v0.22.7"), { state: "up-to-date", latest: null });
  assert.deepEqual(read("→ This checkout is newer than the selected release", "→ Holding at this build"), { state: "up-to-date", latest: null });
  // "Selected release available" is read before the older "Update available".
  assert.deepEqual(read("⚕ Update available: 3 commits behind origin/main.", "→ Selected release available: stable v0.22.7"), {
    state: "available",
    latest: "0.22.7"
  });
});

test("parseHermesCheck: a verdict counts only at the start of a line (past any symbol), and only on exit code 0", () => {
  // A notice in the middle of a line, or after other words, is not the answer.
  const notices = [
    "note: Selected release available: stable v9.9.9",
    "warning - This checkout is newer than the selected release",
    "see Holding at this build",
    "Run 'hermes update' when Update available appears"
  ];
  for (const stdout of notices) assert.equal(parseHermesCheck({ code: 0, stdout }), null, stdout);
  // A failed exit is never an answer, whatever the release wording says.
  for (const code of [1, 2, 127, -1, null, undefined, "ENOENT"]) {
    assert.equal(parseHermesCheck({ code, stdout: "→ Selected release available: stable v0.22.7" }), null, String(code));
    assert.equal(parseHermesCheck({ code, stdout: "→ This checkout is newer than the selected release" }), null, String(code));
  }
});

// ---- Claude Code's update channel (SP5 E2, R47) --------------------------------------------------------------

test("parseDistTags: reads the tag it is asked for ('latest' unless told otherwise), with the same rules", () => {
  const tags = '{"latest":"2.1.318","stable":"2.1.311","next":"2.2.0-beta.1"}';
  assert.equal(parseDistTags(tags), "2.1.318");
  assert.equal(parseDistTags(tags, "latest"), "2.1.318");
  assert.equal(parseDistTags(tags, "stable"), "2.1.311");
  assert.equal(parseDistTags('{"latest":"2.1.318"}', "stable"), null, "no stable tag");
  assert.equal(parseDistTags('{"stable":""}', "stable"), null);
  assert.equal(parseDistTags('{"stable":42}', "stable"), null, "the tag must be text");
  assert.equal(parseDistTags('{"stable":"soon"}', "stable"), null, "the tag must hold a dotted number");
  assert.equal(parseDistTags("<html>Bad gateway</html>", "stable"), null);
  assert.equal(parseDistTags('["stable"]', "stable"), null);
  assert.equal(parseDistTags(undefined, "stable"), null);
});

test("channelFromSettings: 'stable' only when autoUpdatesChannel is exactly \"stable\"; everything else is 'latest'", () => {
  assert.equal(channelFromSettings('{"autoUpdatesChannel":"stable"}'), "stable");
  assert.equal(channelFromSettings('{"theme":"dark","autoUpdatesChannel":"stable","env":{}}'), "stable", "other keys are not looked at");
  assert.equal(channelFromSettings('{"autoUpdatesChannel":"latest"}'), "latest");
  const others = [
    '{"autoUpdatesChannel":"Stable"}',
    '{"autoUpdatesChannel":" stable"}',
    '{"autoUpdatesChannel":"stable "}',
    '{"autoUpdatesChannel":"next"}',
    '{"autoUpdatesChannel":""}',
    '{"autoUpdatesChannel":true}',
    '{"autoUpdatesChannel":["stable"]}',
    '{"autoUpdatesChannel":null}',
    '{"channel":"stable"}',
    "{}",
    "[]",
    '["stable"]',
    '"stable"',
    "null",
    "7",
    "true",
    "{ not json",
    "",
    "   "
  ];
  for (const text of others) assert.equal(channelFromSettings(text), "latest", JSON.stringify(text));
  assert.equal(channelFromSettings(undefined), "latest", "no file");
  assert.equal(channelFromSettings(null), "latest");
});

// ---- SP5 release batch, item 6: a byte-order mark and colour codes ---------------------------------------------

test("channelFromSettings: one leading byte-order mark (some Windows editors write one) is stripped, so the stable setting still counts", () => {
  const BOM = "\uFEFF";
  assert.equal(channelFromSettings(`${BOM}{"autoUpdatesChannel":"stable"}`), "stable");
  assert.equal(channelFromSettings(`${BOM}{"theme":"dark","autoUpdatesChannel":"stable"}\n`), "stable");
  assert.equal(channelFromSettings(`${BOM}{"autoUpdatesChannel":"latest"}`), "latest");
  assert.equal(channelFromSettings(`${BOM}{ not json`), "latest", "a mark does not make bad JSON readable");
  assert.equal(channelFromSettings(BOM), "latest", "a mark alone is no file");
  // Only ONE leading mark: a second one, or one anywhere else, is still not JSON.
  assert.equal(channelFromSettings(`${BOM}${BOM}{"autoUpdatesChannel":"stable"}`), "latest");
  assert.equal(channelFromSettings(` ${BOM}{"autoUpdatesChannel":"stable"}`), "latest", "not at the start");
});

test("parseHermesCheck: terminal colour codes are ignored when matching, so a coloured answer still reads (and nothing raw is kept)", () => {
  const read = (...lines) => parseHermesCheck({ code: 0, stdout: lines.join("\n") });
  const GREEN = "\x1b[32m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  // A whole verdict line in colour, with its number.
  assert.deepEqual(read(`${GREEN}→ Selected release available: stable v0.22.7 (b200f5bc60e3)${RESET}`), { state: "available", latest: "0.22.7" });
  // The symbol coloured on its own, a bold word in the middle, a number coloured on its own.
  assert.deepEqual(read(`${GREEN}→${RESET} ${BOLD}Selected release${RESET} available: stable ${BOLD}v0.22.7${RESET} (b200f5bc60e3)`), {
    state: "available",
    latest: "0.22.7"
  });
  // The full three-line output with codes on every line.
  assert.deepEqual(
    read(`${BOLD}→ Update channel: stable${RESET}`, `${GREEN}→ Selected release available: stable v0.22.7 (b200f5bc60e3)${RESET}`, `  Run \`hermes update\` to install it.`),
    { state: "available", latest: "0.22.7" }
  );
  // "This checkout is newer" in colour still beats a plain "available" line (a step back must never be offered).
  assert.deepEqual(read(`${GREEN}→ This checkout is newer than the selected release: v0.22.9${RESET}`, "→ Selected release available: stable v0.22.7"), {
    state: "up-to-date",
    latest: null
  });
  assert.deepEqual(read(`${BOLD}→ Holding at this build: pinned${RESET}`), { state: "up-to-date", latest: null });
  // Older wording, coloured; and 256-colour and bright codes; and an OSC title sequence ended by BEL.
  assert.deepEqual(read(`\x1b[33m⚕\x1b[0m Update available: 3 commits behind origin/main.`), { state: "available", latest: null });
  assert.deepEqual(read(`\x1b[38;5;82m✓ Already up to date.\x1b[0m`), { state: "up-to-date", latest: null });
  assert.deepEqual(read(`\x1b]0;hermes\x07✓ No newer release: stable v0.22.7.`), { state: "up-to-date", latest: null });
  // Codes do not make a mid-line notice count: the verdict must still start the line.
  assert.equal(read(`note: ${GREEN}Selected release available: stable v9.9.9${RESET}`), null);
  assert.equal(read(`${GREEN}warning${RESET} - This checkout is newer than the selected release`), null);
  // A failed exit is still never an answer, coloured or not.
  assert.equal(parseHermesCheck({ code: 1, stdout: `${GREEN}→ Selected release available: stable v0.22.7${RESET}` }), null);
});
