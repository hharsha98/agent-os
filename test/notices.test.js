// THIRD_PARTY_NOTICES.md must exist, have every section, and name every package that ships, with its
// current version. These tests read files only: no cargo, no network, nothing is run. The full
// regeneration check (`node scripts/build-notices.mjs --check`) needs cargo and runs in the desktop
// job of .github/workflows/ci.yml.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILD_ONLY, licenceProblem, shippedNpmPackages } from "../scripts/build-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const notices = await read("THIRD_PARTY_NOTICES.md");
const lock = JSON.parse(await read("package-lock.json"));
const pkg = JSON.parse(await read("package.json"));
const nodeVersion = (await read("scripts/fetch-node.mjs")).match(/NODE_VERSION = "([^"]+)"/)[1];

describe("THIRD_PARTY_NOTICES.md", () => {
  test("exists, uses LF line endings, and holds no absolute path or date", () => {
    assert.match(notices, /^# Third-party notices\n/);
    assert.ok(!notices.includes("\r"), "LF line endings only");
    assert.ok(!notices.includes(root), "no absolute path of the computer that wrote it");
    assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(notices.split("```")[0]), "no generated-on date in the introduction");
    assert.match(notices, /\[LICENSE\]\(LICENSE\)/, "points to Agent OS's own licence");
  });

  test("has every required section", () => {
    for (const heading of [
      "## Bundled programs",
      `### Node.js ${nodeVersion}`,
      "### node-pty, conpty.dll and OpenConsole.exe",
      "## Fonts",
      "## JavaScript packages",
      "## Rust crates"
    ]) {
      assert.ok(notices.includes(`\n${heading}\n`), `${heading} is missing`);
    }
    assert.match(notices, /Microsoft Corporation/, "node-pty's licence text, with the Microsoft notice for conpty.dll and OpenConsole.exe");
    assert.match(notices, /SIL OPEN FONT LICENSE Version 1\.1/i, "the font licence text");
  });

  test("names every shipped npm package with the version in package-lock.json", () => {
    const shipped = shippedNpmPackages(lock, pkg);
    assert.ok(shipped.length > 50, `${shipped.length} shipped packages looks too few`);
    for (const { name, version, key } of shipped) {
      assert.ok(!lock.packages[key].dev, `${name} is a dev package`);
      const listed = notices.includes(`\n- ${name} ${version}\n`) || notices.includes(`\n- ${name} ${version}:`);
      const intro = name === "node-pty" && notices.includes(`node-pty ${version} opens the terminals`);
      assert.ok(listed || intro, `${name} ${version} is not in THIRD_PARTY_NOTICES.md. Run node scripts/build-notices.mjs`);
    }
    for (const direct of ["express", "react", "react-dom", "ws", "yaml", "lucide-react", "@xterm/xterm", "@fontsource-variable/archivo"]) {
      assert.ok(shipped.some((entry) => entry.name === direct), `${direct} should count as shipped`);
    }
  });

  test("leaves out the build-only packages", async () => {
    for (const name of BUILD_ONLY) {
      assert.ok(!shippedNpmPackages(lock, pkg).some((entry) => entry.name === name));
      assert.ok(!notices.includes(`\n- ${name} `), `${name} is build-only`);
    }
    // vite.config.ts is the only file that imports it.
    assert.match(await read("vite.config.ts"), /@vitejs\/plugin-react/);
  });

  test("names the Rust crates the desktop shell asks for, with the Cargo.lock version", async () => {
    const toml = await read("desktop/src-tauri/Cargo.toml");
    const section = toml.match(/\n\[dependencies\]\r?\n([\s\S]*?)(?=\n\[|$)/)[1];
    const names = [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
    assert.ok(names.includes("tauri"), "found the [dependencies] list");
    const cargoLock = await read("desktop/src-tauri/Cargo.lock");
    for (const name of names) {
      const version = cargoLock.match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`))?.[1];
      assert.ok(version, `${name} is in Cargo.lock`);
      assert.ok(notices.includes(`\n- ${name} ${version}\n`) || notices.includes(`\n- ${name} ${version}:`), `${name} ${version} is not in THIRD_PARTY_NOTICES.md`);
    }
  });
});

describe("licence check", () => {
  test("accepts permissive licences, choices that include one, and MPL-2.0", () => {
    for (const ok of ["MIT", "ISC", "Apache-2.0", "MPL-2.0", "MIT OR Apache-2.0", "MIT/Apache-2.0", "(MIT OR GPL-3.0-or-later)", "Apache-2.0 OR LGPL-2.1-or-later OR MIT"]) {
      assert.equal(licenceProblem(ok), null, ok);
    }
  });

  test("refuses strong copyleft with no alternative, and no licence at all", () => {
    for (const bad of ["GPL-3.0", "AGPL-3.0-only", "LGPL-2.1+", "GPL-2.0 OR LGPL-3.0", "MIT AND GPL-3.0", "", undefined, "UNLICENSED", "SEE LICENSE IN LICENSE.txt"]) {
      assert.ok(licenceProblem(bad), `${bad} should be refused`);
    }
  });
});
