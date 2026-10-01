// scripts/assemble-latest-json.mjs: the pure part that turns a release's file
// list into the updater's latest.json. No network is used here.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildLatestJson } from "../scripts/assemble-latest-json.mjs";

const base = "https://api.github.com/repos/owner/repo/releases/assets";
const installerNames = [
  "Agent.OS_0.3.0_aarch64.app.tar.gz",
  "Agent.OS_0.3.0_x64.app.tar.gz",
  "Agent.OS_0.3.0_amd64.AppImage",
  "Agent.OS_0.3.0_amd64.deb",
  "Agent.OS_0.3.0_x64-setup.exe",
];

// The shape of the v0.3.0 release: installers, a .sig for each, two .dmg, and a latest.json.
function release0_3_0({ without = [], unsigned = [] } = {}) {
  const names = [
    ...installerNames.filter((name) => !without.includes(name)),
    ...installerNames.filter((name) => !without.includes(name) && !unsigned.includes(name)).map((name) => `${name}.sig`),
    "Agent.OS_0.3.0_aarch64.dmg",
    "Agent.OS_0.3.0_x64.dmg",
    "latest.json",
  ];
  const assets = names.map((name, index) => ({ name, url: `${base}/${1000 + index}` }));
  const signatures = Object.fromEntries(names.filter((name) => name.endsWith(".sig")).map((name) => [name, `fake-signature-for-${name}\n`]));
  return { assets, signatures };
}

const build = (parts) => buildLatestJson({ version: "0.3.0", notes: "Notes", pubDate: "2026-01-01T00:00:00.000Z", ...parts });
const urlOf = (assets, name) => assets.find((asset) => asset.name === name).url;

describe("buildLatestJson", () => {
  test("golden case: the v0.3.0 files give exactly the nine platform keys", () => {
    const { assets, signatures } = release0_3_0();
    const result = build({ assets, signatures });
    assert.equal(result.version, "0.3.0");
    assert.equal(result.notes, "Notes");
    assert.equal(result.pub_date, "2026-01-01T00:00:00.000Z");
    const expected = {
      "darwin-aarch64": "Agent.OS_0.3.0_aarch64.app.tar.gz",
      "darwin-aarch64-app": "Agent.OS_0.3.0_aarch64.app.tar.gz",
      "darwin-x86_64": "Agent.OS_0.3.0_x64.app.tar.gz",
      "darwin-x86_64-app": "Agent.OS_0.3.0_x64.app.tar.gz",
      "linux-x86_64": "Agent.OS_0.3.0_amd64.AppImage",
      "linux-x86_64-appimage": "Agent.OS_0.3.0_amd64.AppImage",
      "linux-x86_64-deb": "Agent.OS_0.3.0_amd64.deb",
      "windows-x86_64": "Agent.OS_0.3.0_x64-setup.exe",
      "windows-x86_64-nsis": "Agent.OS_0.3.0_x64-setup.exe",
    };
    assert.deepEqual(Object.keys(result.platforms).sort(), Object.keys(expected).sort());
    for (const [key, name] of Object.entries(expected)) {
      assert.deepEqual(result.platforms[key], { signature: `fake-signature-for-${name}.sig`, url: urlOf(assets, name) }, key);
      assert.match(result.platforms[key].url, /api\.github\.com\/.*\/releases\/assets\/\d+$/);
    }
  });

  test("a missing Windows installer is an error that names windows", () => {
    const { assets, signatures } = release0_3_0({ without: ["Agent.OS_0.3.0_x64-setup.exe"] });
    assert.throws(() => build({ assets, signatures }), /windows-x86_64/);
  });

  test("an installer without its .sig is an error that names the file", () => {
    const { assets, signatures } = release0_3_0({ unsigned: ["Agent.OS_0.3.0_amd64.deb"] });
    assert.throws(() => build({ assets, signatures }), /Agent\.OS_0\.3\.0_amd64\.deb/);
  });

  test("ignores .dmg files and an existing latest.json", () => {
    const { assets, signatures } = release0_3_0();
    const result = build({ assets, signatures });
    const urls = new Set(Object.values(result.platforms).map((entry) => entry.url));
    for (const ignored of ["Agent.OS_0.3.0_aarch64.dmg", "Agent.OS_0.3.0_x64.dmg", "latest.json"]) {
      assert.ok(!urls.has(urlOf(assets, ignored)), `${ignored} must not appear`);
    }
    assert.equal(Object.keys(result.platforms).length, 9);
  });
});
