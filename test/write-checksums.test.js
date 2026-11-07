// scripts/write-checksums.mjs: the pure part that turns a release's installers into SHA256SUMS.txt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { buildChecksums, isInstaller } from "../scripts/write-checksums.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

describe("SHA256SUMS.txt", () => {
  test("has one 'hash, two spaces, name' line per installer, sorted, ending in a newline (sha256sum -c format)", () => {
    const text = buildChecksums([
      { name: "b.dmg", sha256: sha("b") },
      { name: "a.deb", sha256: sha("a") },
    ]);
    assert.equal(text, `${sha("a")}  a.deb\n${sha("b")}  b.dmg\n`);
  });

  test("refuses an empty list, a bad hash and a name with a space", () => {
    assert.throws(() => buildChecksums([]), /no installers/);
    assert.throws(() => buildChecksums([{ name: "a.deb", sha256: "xyz" }]), /valid SHA-256/);
    assert.throws(() => buildChecksums([{ name: "a b.deb", sha256: sha("a") }]), /space/);
  });

  test("lists installers only: no signatures, latest.json or an older checksum file", () => {
    const names = [
      "Agent.OS_0.4.1_aarch64.dmg",
      "Agent.OS_0.4.1_x64-setup.exe",
      "Agent.OS_0.4.1_aarch64.app.tar.gz",
      "Agent.OS_0.4.1_aarch64.app.tar.gz.sig",
      "latest.json",
      "SHA256SUMS.txt",
    ];
    assert.deepEqual(names.filter(isInstaller), [
      "Agent.OS_0.4.1_aarch64.dmg",
      "Agent.OS_0.4.1_x64-setup.exe",
      "Agent.OS_0.4.1_aarch64.app.tar.gz",
    ]);
  });
});
