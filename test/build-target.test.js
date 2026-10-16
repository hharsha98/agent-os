// The page's build target (vite.config.ts). Found in E2's live check with a real Claude Code: with Vite's default
// target (es2020), esbuild rewrites `x ||= {}`, and in xterm's DECRQM handler (`let r; (...)(r ||= {})`) the
// minified rewrite assigns to a name that does not exist. The first DECRQM query an agent sends (Claude Code asks
// "?2026$p" and "?1016$p" at start) then throws inside xterm's write loop, and the page's terminal never draws
// again. es2021 keeps `||=` as it is.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function viteTarget() {
  const config = readFileSync(path.join(root, "vite.config.ts"), "utf8");
  const match = config.match(/target:\s*\[([^\]]*)\]/);
  assert.ok(match, "vite.config.ts sets build.target as a list");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// xterm 6.1's InputHandler.requestMode, in the shape its published bundle has: a function-local enum object.
const XTERM_PATTERN =
  'export function requestMode(p){let r;(te=>(te[te.NOT_RECOGNIZED=0]="NOT_RECOGNIZED",te[te.SET=1]="SET"))(r||={});return p+1}';

function runMinified(target) {
  const code = esbuild.transformSync(XTERM_PATTERN, { target, minify: true, format: "esm" }).code;
  const body = code.replace(/export\s*\{\s*(\w+)\s+as\s+requestMode\s*\};?/, "return $1;");
  // ES modules run in strict mode, where assigning to an undeclared name throws.
  return new Function(`"use strict";${body}`)()(1);
}

test("the page builds for es2021 (and Vite's own browsers), so esbuild never rewrites xterm's `||=`", () => {
  const target = viteTarget();
  assert.ok(target.includes("es2021"), `build.target: ${target.join(", ")}`);
  assert.ok(!target.some((t) => /^es20(1\d|20)$/.test(t)), "no es2020 or older entry, which would bring the rewrite back");
  assert.equal(runMinified(target), 2, "xterm's pattern runs once built with this target");
  assert.throws(() => runMinified(["es2020", "chrome87", "edge88", "firefox78", "safari14"]), /is not defined/, "es2020 still shows the esbuild rewrite this guards against");
});

test("the built page holds no `void 0||(x={})` rewrite (only when dist/ has been built)", (t) => {
  const assets = path.join(root, "dist", "assets");
  if (!existsSync(assets)) {
    t.skip("dist/ is not built");
    return;
  }
  const bundles = readdirSync(assets).filter((name) => name.endsWith(".js"));
  const withXterm = bundles.filter((name) => readFileSync(path.join(assets, name), "utf8").includes("requestMode("));
  assert.ok(withXterm.length > 0, "one bundle holds xterm");
  for (const name of withXterm) {
    assert.doesNotMatch(readFileSync(path.join(assets, name), "utf8"), /void 0\|\|\([\w$]+=\{\}\)/, name);
  }
});
