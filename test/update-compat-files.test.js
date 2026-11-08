// These four files are the restart helper of 0.3.0 to 0.4.2; an old window asks for them after updating. Never delete or rebuild them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = (p) => new URL(`../${p}/assets/`, import.meta.url);
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const FILES = {
  "index-Cg_zlgkt.js": "c61152db17f1c9e7a84d8ea96792343ef1762af74464028b0b58a66ceb794224",
  "core-D2Ebf996.js": "fec42ee7940b387f7bbe765345c28ed00373df0278cc88bcf5fa824c4538f4ba",
  "index-C_bFS7M8.js": "f4733554bd03e26fa72d36eb9a5e7a0166d89ba302f3781b949e03f4cf121695",
  "core-CGO7t-ar.js": "cb228c87957b46c8387d126d504007ba434ec36a2e3d897863101fffaeb01ac3",
};

test("the four compat files exist in public/assets with the pinned bytes", () => {
  for (const [name, hash] of Object.entries(FILES)) {
    const file = new URL(name, dir("public"));
    assert.ok(existsSync(file), `${name} exists`);
    assert.equal(sha(file), hash, `${name} is byte-exact`);
  }
});

test("each restart chunk imports a file that is kept too", () => {
  for (const name of ["index-Cg_zlgkt.js", "index-C_bFS7M8.js"]) {
    const text = readFileSync(new URL(name, dir("public")), "utf8");
    const m = text.match(/from\s*"\.\/(core-[^"]+\.js)"/);
    assert.ok(m, `${name} imports a core file`);
    assert.ok(existsSync(new URL(m[1], dir("public"))), `${m[1]} exists in public/assets`);
  }
});

test("the build copies them into dist/assets unchanged", (t) => {
  if (!existsSync(new URL("../dist/", import.meta.url))) return t.skip("no dist/ yet");
  for (const name of Object.keys(FILES)) {
    const file = new URL(name, dir("dist"));
    assert.ok(existsSync(file), `${name} is in dist/assets`);
    assert.equal(sha(file), sha(new URL(name, dir("public"))), `${name} is identical in dist`);
  }
});
