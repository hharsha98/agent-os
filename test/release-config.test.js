// Release wiring: the app version must match everywhere, and the release
// workflow must keep the settings that took three real releases to get right.
// YAML is checked with plain string matching on purpose (no extra dependency).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

async function versions(base = root) {
  const get = (relative) => readFile(path.join(base, relative), "utf8");
  const cargoToml = await get("desktop/src-tauri/Cargo.toml");
  const cargoLock = await get("desktop/src-tauri/Cargo.lock");
  const store = await get("server/runtime/store.js");
  const lock = JSON.parse(await get("package-lock.json"));
  return {
    "package.json": JSON.parse(await get("package.json")).version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages[""].version,
    "tauri.conf.json": JSON.parse(await get("desktop/src-tauri/tauri.conf.json")).version,
    "Cargo.toml": cargoToml.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)[1],
    "Cargo.lock": cargoLock.match(/name = "agent-os-desktop"\r?\nversion = "([^"]+)"/)[1],
    "store.js RUNTIME_VERSION": store.match(/export const RUNTIME_VERSION = "([^"]+)"/)[1],
  };
}

describe("app version", () => {
  test("is identical in package.json, tauri.conf.json and Cargo.toml (and the lock files)", async () => {
    const found = await versions();
    const distinct = new Set(Object.values(found));
    assert.equal(distinct.size, 1, `versions differ: ${JSON.stringify(found, null, 2)}`);
    assert.match([...distinct][0], /^\d+\.\d+\.\d+$/);
  });

  test("scripts/bump-version.mjs changes all of them together, and rejects a bad version", async () => {
    const copy = await mkdtemp(path.join(os.tmpdir(), "agent-os-bump-"));
    try {
      for (const file of [
        "package.json",
        "package-lock.json",
        "desktop/src-tauri/tauri.conf.json",
        "desktop/src-tauri/Cargo.toml",
        "desktop/src-tauri/Cargo.lock",
        "server/runtime/store.js",
      ]) {
        await mkdir(path.dirname(path.join(copy, file)), { recursive: true });
        await cp(path.join(root, file), path.join(copy, file));
      }
      const bump = (version) =>
        execFileSync(process.execPath, ["scripts/bump-version.mjs", version, "--root", copy], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      bump("9.8.7");
      const found = await versions(copy);
      assert.deepEqual([...new Set(Object.values(found))], ["9.8.7"], JSON.stringify(found));
      assert.throws(() => bump("not-a-version"));
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe("release workflow", async () => {
  const workflow = await read(".github/workflows/release.yml");
  // The text of one top-level job (from "  name:" to the next "  other-name:" or the end).
  const jobText = (name) => {
    const match = workflow.match(new RegExp(`\\n  ${name}:\\r?\\n([\\s\\S]*?)(?=\\r?\\n  [a-z][a-z-]*:\\r?\\n|$)`));
    assert.ok(match, `job ${name} not found`);
    return match[1];
  };

  test("can write the Release, runs every platform, and creates the release as a draft", () => {
    assert.match(workflow, /contents:\s*write/);
    assert.match(workflow, /fail-fast:\s*false/);
    assert.match(workflow, /tauri-apps\/tauri-action@v1/);
    assert.match(workflow, /tags:\s*\n\s*-\s*"v\*"/);
    assert.match(workflow, /workflow_dispatch:[\s\S]*?tag:[\s\S]*?required:\s*true/);
  });

  test("builds Windows as NSIS only, Linux on pinned ubuntu-22.04, and both Mac CPUs", () => {
    assert.match(workflow, /--bundles nsis/);
    assert.ok(!/--bundles[^\n]*msi/.test(workflow), "Windows must not build MSI");
    assert.match(workflow, /ubuntu-22\.04/);
    assert.ok(!/ubuntu-latest/.test(workflow), "Linux must stay pinned to 22.04");
    assert.match(workflow, /--target aarch64-apple-darwin/);
    assert.match(workflow, /--target x86_64-apple-darwin/);
    assert.match(workflow, /libwebkit2gtk-4\.1-dev/);
  });

  test("uses Node 24 and a plain `npm ci` with no CI=true on installs", () => {
    assert.match(workflow, /node-version:\s*"24"/);
    assert.match(workflow, /run:\s*npm ci\s*\n/);
  });

  test("create-release makes exactly one draft (not a prerelease) and reuses one that exists", () => {
    const create = jobText("create-release");
    assert.match(create, /contents:\s*write/);
    assert.match(create, /-F draft=true/);
    assert.match(create, /-F prerelease=false/);
    assert.match(create, /already published/);
    assert.match(create, /release_id=/);
    assert.match(create, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
    assert.ok(!/run:[^\n]*\$\{\{/.test(create), "no ${{ }} on a run: line (injection safety)");
    assert.ok(!/tauri-action/.test(create), "only create-release makes the release");
  });

  test("release builds wait for create-release and upload into its release without making latest.json", () => {
    const release = jobText("release");
    assert.match(release, /needs:\s*create-release\r?\n/);
    assert.match(release, /releaseId:\s*\$\{\{\s*needs\.create-release\.outputs\.release_id\s*\}\}/);
    assert.match(release, /uploadUpdaterJson:\s*false/);
    for (const input of ["tagName", "releaseName", "releaseBody", "releaseDraft"]) {
      assert.ok(!new RegExp(`${input}:`).test(release), `${input} would make tauri-action create its own release`);
    }
  });

  test("updater-json runs last, after the builds, and writes latest.json with the script", () => {
    const updater = jobText("updater-json");
    assert.match(updater, /needs:\s*\[\s*create-release\s*,\s*release\s*\]/);
    assert.match(updater, /contents:\s*write/);
    assert.match(updater, /node scripts\/assemble-latest-json\.mjs/);
    assert.match(updater, /RELEASE_ID:\s*\$\{\{\s*needs\.create-release\.outputs\.release_id\s*\}\}/);
    assert.match(updater, /RELEASE_TAG:/);
    assert.match(updater, /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  });

  test("sets CI: true only inside the tauri-action step", () => {
    const lines = workflow.split(/\r?\n/);
    const ciLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^\s*CI:\s*true\b/.test(line));
    assert.equal(ciLines.length, 1, "CI: true should appear exactly once");
    const actionStart = lines.findIndex((line) => /uses:\s*tauri-apps\/tauri-action/.test(line));
    assert.ok(actionStart >= 0);
    assert.ok(ciLines[0].index > actionStart, "CI: true must come after the tauri-action step starts");
    // ...and that step must be the last one of the release job (nothing after it can inherit CI).
    const release = jobText("release").split(/\r?\n/);
    const releaseAction = release.findIndex((line) => /uses:\s*tauri-apps\/tauri-action/.test(line));
    assert.ok(releaseAction >= 0, "the release job runs tauri-action");
    const stepsAfter = release.slice(releaseAction + 1).filter((line) => /^\s{6}-\s+name:/.test(line));
    assert.equal(stepsAfter.length, 0, "tauri-action must be the final step of the release job");
    assert.ok(!/CI=true/.test(workflow));
  });

  test("passes the updater key from secrets, never a literal key", () => {
    assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY\s*\}\}/);
    assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*\}\}/);
    assert.match(workflow, /releases\/latest\/download\/latest\.json/);
    assert.ok(!/dW50cnVzdGVkIGNvbW1lbnQ6[A-Za-z0-9+/=]{20,}/.test(workflow));
  });

  test("fetches the target's Node, then prepares without replacing it", () => {
    assert.match(workflow, /fetch-node\.mjs --platform \$\{\{ matrix\.node_platform \}\} --arch \$\{\{ matrix\.node_arch \}\}/);
    assert.match(workflow, /prepare-desktop\.mjs --skip-node/);
  });

  test("the files it reads exist, and the release notes lead with the unsigned warning", async () => {
    const pubkey = await read("desktop/updater-pubkey.txt");
    assert.ok(pubkey.trim().length > 0);
    const notes = await read(".github/release-notes.md");
    const opening = notes.split("\n").slice(0, 8).join("\n").toLowerCase();
    assert.match(opening, /unsigned/);
    assert.match(opening, /right-click/);
    assert.match(opening, /open anyway/);
    assert.match(opening, /smartscreen/);
    assert.match(opening, /chmod \+x/);
    assert.ok(!/@/.test(notes.replace(/mechaharsh@gmail\.com/g, "")), "the only email in the notes is mechaharsh@gmail.com");
  });
});

describe("desktop window", () => {
  test("cannot be made smaller than 1024x640 (the smallest the laptop layout is built for)", async () => {
    const conf = JSON.parse(await read("desktop/src-tauri/tauri.conf.json"));
    const main = conf.app.windows.find((window) => window.label === "main");
    assert.equal(main.minWidth, 1024);
    assert.equal(main.minHeight, 640);
    assert.ok(main.width >= main.minWidth && main.height >= main.minHeight, "the opening size is not below the minimum");
  });

  // The addresses the desktop app may open in the person's browser (owner decision, 2026-10-14: "Allow opening
  // links"). Tauri matches the WHOLE address against each entry with the Rust `glob` crate: `*` is any run of
  // characters (a "/" too) and `[0-9]` is one digit. Because of that:
  //   - every entry names one exact host and then "/", so `https://github.com.evil.example/`,
  //     `https://github.com@evil.example/` and `https://evil.example/github.com/` do not match;
  //   - there is no `*.host` entry: `https://*.openai.com/*` would also match `https://evil.example/x.openai.com/y`;
  //   - the loopback ports are exact (or digits only), so `http://127.0.0.1:1@evil.example/` does not match.
  // Widening this (a bare `*`, another scheme, `opener:default`, a wildcard host) must be a deliberate change to
  // this list, never a quiet one.
  const OPEN_URL_SCOPE = [
    // OpenRouter's own pages (the website panel, the model picker).
    { url: "https://openrouter.ai/*" },
    // Setup plan: the official source and terms links.
    { url: "https://github.com/*" },
    { url: "https://nodejs.org/*" },
    { url: "https://code.claude.com/*" },
    { url: "https://www.anthropic.com/*" },
    // Agents page: each agent's homepage and docs.
    { url: "https://hermes-agent.nousresearch.com/*" },
    { url: "https://openclaw.ai/*" },
    { url: "https://docs.openclaw.ai/*" },
    { url: "https://claude.com/*" },
    { url: "https://openai.com/*" },
    { url: "https://developers.openai.com/*" },
    { url: "https://cursor.com/*" },
    // Sign-in pages: the hosts server/runtime/setup/signin.js accepts (its apex names only), plus auth.openai.com,
    // the address Codex's login prints. Any other sign-in host falls back to "Copy the address".
    { url: "https://claude.ai/*" },
    { url: "https://anthropic.com/*" },
    { url: "https://chatgpt.com/*" },
    { url: "https://cursor.sh/*" },
    { url: "https://auth.openai.com/*" },
    // This Mac only: the Hermes dashboard and the OpenClaw Control UI (fixed default ports), and the one-time
    // OpenRouter sign-in page on Agent OS's own server (it picks a random 5-digit port at launch).
    { url: "http://127.0.0.1:9119/*" },
    { url: "http://127.0.0.1:18789/*" },
    { url: "http://localhost:[0-9][0-9][0-9][0-9][0-9]/oauth/openrouter/start/*" }
  ];

  // Just enough of the glob crate to check the entries above (and nothing more: any other glob
  // character in an entry fails the test, so a new kind of pattern has to be thought about here).
  function scopeMatches(pattern, address) {
    let source = "";
    for (let i = 0; i < pattern.length; ) {
      if (pattern[i] === "*") {
        source += "[\\s\\S]*";
        i += 1;
      } else if (pattern.startsWith("[0-9]", i)) {
        source += "[0-9]";
        i += 5;
      } else {
        assert.ok(!/[?[\]{}!]/.test(pattern[i]), `unexpected glob character ${pattern[i]} in ${pattern}`);
        source += pattern[i].replace(/[.+^$|()\\/]/g, "\\$&");
        i += 1;
      }
    }
    return new RegExp(`^${source}$`).test(address);
  }
  // OpenAddress.tsx hands the opener `new URL(href).href`, so a bare origin always ends in "/"; an address
  // that is not a valid URL is never handed over at all.
  function allowedByScope(href) {
    let address;
    try {
      address = new URL(href).href;
    } catch {
      return false;
    }
    return OPEN_URL_SCOPE.some((entry) => scopeMatches(entry.url, address));
  }

  test("grants exactly these permissions: the opener may show a file in Finder and open the app's known links", async () => {
    const capability = JSON.parse(await read("desktop/src-tauri/capabilities/default.json"));
    assert.deepEqual(capability.permissions, [
      "core:default",
      "updater:default",
      "process:allow-restart",
      { identifier: "opener:allow-open-url", allow: OPEN_URL_SCOPE },
      "opener:allow-reveal-item-in-dir"
    ]);
    assert.deepEqual(capability.windows, ["main"]);
    assert.deepEqual(capability.remote?.urls, ["http://127.0.0.1:*"]);
  });

  test("the open-url scope: only https and this Mac's own pages, one exact host per entry, never a bare wildcard", async () => {
    for (const { url } of OPEN_URL_SCOPE) {
      assert.match(url, /^(https:\/\/[a-z0-9.-]+\/\*|http:\/\/(127\.0\.0\.1:\d+\/\*|localhost:(\[0-9\]){5}\/oauth\/openrouter\/start\/\*))$/, url);
      assert.ok(!url.includes("://*") && !url.includes("*."), `no wildcard host: ${url}`);
    }
    assert.equal(new Set(OPEN_URL_SCOPE.map((entry) => entry.url)).size, OPEN_URL_SCOPE.length, "no duplicates");
    // The broad sets (open any address, open any path) are not granted, only open-url with the scope above.
    const capability = JSON.parse(await read("desktop/src-tauri/capabilities/default.json"));
    const names = capability.permissions.map((permission) => (typeof permission === "string" ? permission : permission.identifier));
    for (const widening of ["opener:default", "opener:allow-default-urls", "opener:allow-open-path"]) {
      assert.ok(!names.includes(widening), `${widening} must not be granted`);
    }
    assert.equal(names.filter((name) => name === "opener:allow-open-url").length, 1, "open-url is granted once, with its scope");
  });

  test("the open-url scope allows every address the app opens from its own data, and nothing that looks like one", async () => {
    const { ADAPTERS } = await import("../server/runtime/agents/index.js");
    const { getInstallRecipe, OPERATOR_AGENT_IDS, CODING_AGENT_IDS } = await import("../server/runtime/setup/recipes.js");
    const known = [
      // Agents page: dashboards (AgentBay.tsx), and each adapter's homepage and docs.
      "http://127.0.0.1:9119",
      "http://127.0.0.1:18789",
      ...Object.values(ADAPTERS).flatMap((adapter) => [adapter.homepage, adapter.docsUrl]),
      // Setup plan: source and terms links, and the Node.js source (server/runtime/setup/plan.js).
      "https://nodejs.org",
      ...[...OPERATOR_AGENT_IDS, ...CODING_AGENT_IDS].flatMap((id) => {
        const recipe = getInstallRecipe(id, "darwin", "arm64");
        return [recipe.sourceUrl, recipe.termsUrl];
      }),
      // OpenRouter: the pages the server offers, and the one-time sign-in page on this app's own server.
      "https://openrouter.ai/models?supported_parameters=tools",
      "https://openrouter.ai/settings/presets",
      "https://openrouter.ai/settings/presets/new",
      "https://openrouter.ai/vendor/some-model",
      `http://localhost:54321/oauth/openrouter/start/${"a1".repeat(32)}`,
      // Sign-in pages (the shapes the sign-in tests use).
      "https://claude.ai/oauth/authorize?code_challenge=abc&state=xyz",
      "https://auth.openai.com/oauth/authorize?state=xyz",
      "https://cursor.com/loginDeepControl?uuid=abc"
    ].filter(Boolean);
    for (const href of known) assert.ok(allowedByScope(href), `the scope should allow ${href}`);

    const refused = [
      "file:///etc/hosts",
      "mailto:someone@example.com",
      "javascript:alert(1)",
      "ftp://github.com/x",
      "http://github.com/x", // plain http to a website host
      "https://evil.example/",
      "https://evil.example/github.com/",
      "https://evil.example/x.openai.com/y",
      "https://evil.example/?https://github.com/x",
      "https://github.com.evil.example/",
      "https://github.com@evil.example/",
      "https://openrouter.ai@evil.example/",
      "https://openrouter.ai.evil.example/",
      "https://sub.openrouter.ai/", // a sub-host that is not listed
      "https://platform.openai.com/api-keys", // only the hosts above, not their neighbours
      "http://127.0.0.1:1@evil.example/",
      "http://127.0.0.1:9119@evil.example/",
      "http://127.0.0.1:9119.evil.example/",
      "http://127.0.0.1:9120/", // another port on this Mac
      "http://127.0.0.1:80/",
      "http://localhost:9119/", // the dashboard is listed by its 127.0.0.1 address only
      "http://localhost:54321/", // this server's other pages are not opened this way
      "http://localhost:54321/oauth/openrouter/callback",
      "http://localhost:5432/oauth/openrouter/start/abc", // not a 5-digit port
      "http://localhost:543210/oauth/openrouter/start/abc",
      "http://localhost:54321@evil.example/oauth/openrouter/start/abc",
      "http://localhost:5432a/oauth/openrouter/start/abc",
      "http://[::1]:9119/"
    ];
    for (const href of refused) assert.ok(!allowedByScope(href), `the scope must refuse ${href}`);
  });
});
