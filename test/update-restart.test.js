// The update banner must load its restart helper BEFORE installing: installing replaces the page's own files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/ui/components/UpdateBanner.tsx", import.meta.url), "utf8");
const start = src.indexOf("async function installNow()");
const end = src.indexOf("async function install()");
const body = src.slice(start, end);
const IMPORT = 'import("@tauri-apps/plugin-process")';

test("installNow loads the restart helper before it installs, never after", () => {
  assert.ok(start >= 0 && end > start, "installNow found");
  const imp = body.indexOf(IMPORT);
  const dl = body.indexOf("downloadAndInstall(");
  assert.ok(imp >= 0 && dl >= 0, "both calls are in installNow");
  assert.ok(imp < dl, "the import comes first");
  assert.equal(body.indexOf(IMPORT, dl), -1, "no import after downloadAndInstall");
});

test("the installed and failed texts and the Restart now label are present", () => {
  assert.ok(src.includes("is installed. Quit Agent OS and open it again to finish."));
  assert.ok(src.includes("Restart now"));
  assert.ok(src.includes("The update didn't install. Nothing was changed; you can try again."));
});

test("a second press after an install restarts without downloading again", () => {
  const guard = body.indexOf("installedRef.current");
  assert.ok(guard >= 0 && guard < body.indexOf("downloadAndInstall("), "the guard comes before the download");
  assert.match(body, /installedRef\.current = true;/);
});

test("Keep running remembers both failed and installed", () => {
  assert.match(src, /phaseBefore\.current = phase === "failed" \|\| phase === "installed" \? phase : "ready";/);
});
