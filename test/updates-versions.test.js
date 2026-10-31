// SP5 Task V1: the pure helpers of the version checks (server/runtime/updates/
// versions.js). They compare version texts and read what an agent's own
// check printed; nothing here starts a process or touches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
  assert.equal(
    parseHermesCheck({
      code: 0,
      stdout: "⚕ Update available: 3 commits behind origin/main.\nRun 'hermes update' to install."
    }),
    "available"
  );
  assert.equal(parseHermesCheck({ code: 0, stdout: "✓ Already up to date." }), "up-to-date");
  assert.equal(parseHermesCheck({ code: 0, stdout: "note: a newer Hermes notice\n✓ Already up to date.\n" }), "up-to-date");
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
