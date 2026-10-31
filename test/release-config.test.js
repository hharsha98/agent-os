// Release wiring: the app version must match everywhere, and the release
// workflow must keep the settings that took three real releases to get right.
// YAML is checked with plain string matching on purpose (no extra dependency).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

  test("grants exactly these permissions: the opener may show a file in Finder and open the app's known links, and the folder picker may open", async () => {
    const capability = JSON.parse(await read("desktop/src-tauri/capabilities/default.json"));
    assert.deepEqual(capability.permissions, [
      "core:default",
      "updater:default",
      "process:allow-restart",
      { identifier: "opener:allow-open-url", allow: OPEN_URL_SCOPE },
      "opener:allow-reveal-item-in-dir",
      // The New session dialog's "Choose folder…": the system's open dialog only (not message, save or dialog:default).
      "dialog:allow-open"
    ]);
    assert.deepEqual(capability.windows, ["main"]);
    assert.deepEqual(capability.remote?.urls, ["http://127.0.0.1:*"]);
    // The description says what the page may do through Tauri, including the quit question and the folder picker.
    assert.match(capability.description, /agentos:\/\/quit-requested/);
    assert.match(capability.description, /dialog:allow-open/);
    assert.doesNotMatch(capability.description, /never through Tauri IPC/);
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

describe("desktop folder picker (tauri-plugin-dialog)", () => {
  test("the dialog plugin is on both sides: the Rust crate, its registration, and the page's package on the same 2.8 line", async () => {
    const cargoToml = await read("desktop/src-tauri/Cargo.toml");
    assert.match(cargoToml, /^tauri-plugin-dialog = "2"$/m);
    const main = await read("desktop/src-tauri/src/main.rs");
    assert.match(main, /\.plugin\(tauri_plugin_dialog::init\(\)\)/);
    const pkg = JSON.parse(await read("package.json"));
    assert.equal(pkg.dependencies["@tauri-apps/plugin-dialog"], "2.8.3", "exact pin, no range");
    // The quit question's events (@tauri-apps/api/event, Task U1), at the version already in package-lock.json (Q6).
    assert.equal(pkg.dependencies["@tauri-apps/api"], "2.12.1", "exact pin");
    const lock = await read("desktop/src-tauri/Cargo.lock");
    const locked = lock.match(/name = "tauri-plugin-dialog"\r?\nversion = "([^"]+)"/);
    assert.ok(locked, "Cargo.lock has tauri-plugin-dialog: run cargo build in desktop/src-tauri");
    assert.match(locked[1], /^2\.8\./, "the Rust half stays on the same 2.8 line as the page's package");
  });
});

describe("desktop notifications (tauri-plugin-notification, SP4 rulings R20 and R21)", async () => {
  const main = await read("desktop/src-tauri/src/main.rs");
  // The text of main.rs from one marker to the next one after it; both must be there, in this order.
  const between = (from, to) => {
    const start = main.indexOf(from);
    const end = main.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `main.rs has ${from} and, after it, ${to}`);
    return main.slice(start, end);
  };

  test("the plugin is a Rust crate only: pinned exactly, registered, locked at 2.7.0, and no page package", async () => {
    const cargoToml = await read("desktop/src-tauri/Cargo.toml");
    assert.match(cargoToml, /^tauri-plugin-notification = "=2\.7\.0"$/m, "an exact pin (R20), not a range");
    assert.match(main, /\.plugin\(tauri_plugin_notification::init\(\)\)/);
    const lock = await read("desktop/src-tauri/Cargo.lock");
    const locked = lock.match(/name = "tauri-plugin-notification"\r?\nversion = "([^"]+)"/);
    assert.ok(locked, "Cargo.lock has tauri-plugin-notification: run cargo build in desktop/src-tauri");
    assert.equal(locked[1], "2.7.0");
    const pkg = JSON.parse(await read("package.json"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      assert.equal(pkg[field]?.["@tauri-apps/plugin-notification"], undefined, `no @tauri-apps/plugin-notification in ${field}: the page never sends notifications`);
    }
    const npmLock = JSON.parse(await read("package-lock.json"));
    assert.equal(npmLock.packages["node_modules/@tauri-apps/plugin-notification"], undefined, "not in package-lock.json either");
  });

  test("the page gets no notification permission and never uses notifications itself", async () => {
    const capability = JSON.parse(await read("desktop/src-tauri/capabilities/default.json"));
    const names = capability.permissions.map((permission) => (typeof permission === "string" ? permission : permission.identifier));
    assert.deepEqual(names.filter((name) => name.startsWith("notification:")), [], "no notification:* permission for the remote page (R20)");
    assert.doesNotMatch(capability.description, /notification/i, "the description claims no notification IPC for the page");
    // In the desktop window the plugin's init script replaces window.Notification, and without a permission every call
    // there is refused; in a browser tab the page shows its own toast. So no page code uses either.
    const files = (await readdir(path.join(root, "src"), { recursive: true })).filter((file) => /\.(tsx?|jsx?|mjs|html)$/.test(file));
    assert.ok(files.length > 50, `the scan sees the page code (${files.length} files)`);
    for (const file of files) {
      const text = await readFile(path.join(root, "src", file), "utf8");
      assert.doesNotMatch(text, /@tauri-apps\/plugin-notification|\bnew Notification\(|\bNotification\.requestPermission\b|\bwindow\.Notification\b/, file);
    }
  });

  test("the shell reads the server's output as bytes, so a line that is not UTF-8 never stops it (R21)", () => {
    const reader = between("fn read_lines_lossy<", "fn watch_server(");
    assert.match(reader, /read_until\(b'\\n', &mut buf\)/);
    assert.match(reader, /String::from_utf8_lossy\(&buf\)/);
    const watch = between("fn watch_server(", "fn notify_alert(");
    assert.match(watch, /read_lines_lossy\(BufReader::new\(stdout\), /);
    assert.match(watch, /read_lines_lossy\(BufReader::new\(stderr\), /);
    assert.doesNotMatch(watch, /\.lines\(\)/, "BufRead::lines() stops at the first line that is not UTF-8, and then nothing drains the pipe");
  });

  test("an alert line raises a notification only when the window is hidden or not focused, and a click shows the window", () => {
    assert.match(main, /const ALERT_LINE_PREFIX: &str = "AGENT_OS_ALERT:";/);
    assert.match(main, /fn should_notify\(visible: bool, focused: bool\) -> bool \{\s*!visible \|\| !focused\s*\}/);
    const watch = between("fn watch_server(", "fn notify_alert(");
    assert.match(watch, /parse_alert_line\(line\)/);
    // The window check runs on the main thread, so the reader never waits on the window.
    assert.match(watch, /run_on_main_thread\(move \|\| notify_alert\(&handle, &note\)\)/);
    const notify = between("fn notify_alert(", "fn listen_for_notification_clicks(");
    assert.match(notify, /is_visible\(\)/);
    assert.match(notify, /is_focused\(\)/);
    assert.match(notify, /if !should_notify\(visible, focused\) \{\s*return;\s*\}/);
    assert.match(notify, /\.notification\(\)\.builder\(\)\.title\(title\)/);
    const clicks = between("fn listen_for_notification_clicks(", "fn show_error(");
    assert.match(clicks, /\.on_action\(/);
    assert.match(clicks, /notification_click_shows_window\(performed\.action_id\(\)\)/);
    assert.match(clicks, /show_main_window\(&handle\)/);
    // The plugin reports clicks only on notifications shown after a handler exists, so it is set before the server starts.
    const setup = between(".setup(|app| {", ".on_page_load(");
    const listen = setup.indexOf("listen_for_notification_clicks(app);");
    assert.ok(listen >= 0 && listen < setup.indexOf("start_server(app, &window);"), "the click handler is registered before start_server");
    assert.doesNotMatch(main, /invoke_handler|#\[tauri::command\]/, "still no custom command");
  });

  test("the shell and the server agree on the alert line", async () => {
    const { ALERT_LINE_PREFIX, alertLine } = await import("../server/runtime/sessions/signals.js");
    assert.ok(main.includes(`const ALERT_LINE_PREFIX: &str = "${ALERT_LINE_PREFIX}";`), "one prefix on both sides");
    // The two lines the Rust tests parse (main.rs, mod alert_tests) are exactly what the server prints.
    const id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
    const lines = [
      alertLine({ sessionId: id, agent: "Claude Code", kind: "waiting", text: "Wants to use Bash" }),
      alertLine({ sessionId: id, agent: "Codex", kind: "approval", text: 'Approval requested: run "npm test" in café' })
    ];
    assert.equal(lines[0], String.raw`AGENT_OS_ALERT:{"sessionId":"3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b","agent":"Claude Code","kind":"waiting","text":"Wants to use Bash"}`);
    for (const line of lines) assert.ok(main.includes(`r#"${line}"#`), `main.rs's Rust tests parse ${line}`);
  });
});

describe("desktop quit plumbing (the page and the shell must agree on these names)", async () => {
  const main = await read("desktop/src-tauri/src/main.rs");

  test("the quit question travels as three events, with no custom command", () => {
    assert.match(main, /const QUIT_REQUESTED_EVENT: &str = "agentos:\/\/quit-requested";/);
    assert.match(main, /const QUIT_SHOWN_EVENT: &str = "agentos:\/\/quit-shown";/);
    assert.match(main, /const QUIT_ANSWER_EVENT: &str = "agentos:\/\/quit-answer";/);
    assert.match(main, /const QUIT_SHOWN_WAIT: Duration = Duration::from_secs\(2\);/);
    assert.doesNotMatch(main, /invoke_handler|#\[tauri::command\]/, "a remote window cannot call a custom command without an AppManifest");
  });

  test("Quit is a custom menu item (⌘Q on macOS only), and the predefined Quit item is gone", () => {
    assert.match(main, /const QUIT_MENU_ID: &str = "agentos-quit";/);
    assert.match(main, /const SHOW_MENU_ID: &str = "agentos-show";/);
    assert.match(main, /"Quit Agent OS"/);
    assert.match(main, /"Show Agent OS"/);
    assert.doesNotMatch(main, /PredefinedMenuItem::quit/, "the predefined Quit ends the app before anything can ask");
    // Every accelerator is set inside a macOS-only line: Windows and Linux menus take no keys from the terminal.
    const accelerators = [...main.matchAll(/\.accelerator\(/g)].length;
    const macOnly = [...main.matchAll(/#\[cfg\(target_os = "macos"\)\]\s*let \w+ = \w+\.accelerator\(/g)].length;
    assert.ok(accelerators > 0 && accelerators === macOnly, `${accelerators} accelerators, ${macOnly} of them macOS-only`);
  });

  test("the server gets its port as AGENT_OS_PORT, is asked to quit through its stdin, and gets 10 s before it is forced", () => {
    const start = main.indexOf("fn spawn_server(");
    const end = main.indexOf("fn parse_ready_line(");
    assert.ok(start >= 0 && end > start, "fn spawn_server comes right before fn parse_ready_line");
    const spawnServer = main.slice(start, end);
    // The server's environment reaches every session through the login shell minus the AGENT_OS_ names,
    // so an un-prefixed PORT=0 would make an agent's own dev server bind a random port.
    assert.match(spawnServer, /\.env\("AGENT_OS_PORT", "0"\)/);
    assert.doesNotMatch(spawnServer, /\.env\("PORT"/);
    // The PATH the app was started with, for the login shell (H2): not the one server_path_env extends.
    assert.match(spawnServer, /\.env\("AGENT_OS_LAUNCH_PATH"/);
    assert.match(spawnServer, /\.env\("AGENT_OS_STDIN_SHUTDOWN", "1"\)/);
    assert.match(spawnServer, /\.stdin\(Stdio::piped\(\)\)/);
    assert.doesNotMatch(spawnServer, /Stdio::null\(\)/, "the server's stdin is never closed at start");
    assert.match(main, /const SHUTDOWN_LINE: &str = "AGENT_OS_SHUTDOWN\\n";/);
    assert.match(main, /const QUIT_GRACE: Duration = Duration::from_secs\(10\);/);
  });

  test("closing the window hides it on macOS and asks to quit elsewhere; Reopen shows it again", () => {
    assert.match(main, /api\.prevent_close\(\)/);
    assert.match(main, /RunEvent::Reopen/);
    assert.match(main, /api\.prevent_exit\(\)/);
    assert.match(main, /RESTART_EXIT_CODE/, "an approved update restart is let through");
  });

  test("the close branch really hides the window on macOS and really asks to quit elsewhere", () => {
    const start = main.indexOf(".on_window_event(");
    const end = main.indexOf(".build(context)");
    assert.ok(start >= 0 && end > start, ".on_window_event comes right before .build(context)");
    const closeBranch = main.slice(start, end);
    assert.match(closeBranch, /CloseRequested \{ api, \.\. \}/);
    // macOS: the close only hides the window (sessions keep running); without window.hide() the red button would do nothing.
    assert.match(closeBranch, /#\[cfg\(target_os = "macos"\)\]\s*\{\s*let _ = window\.hide\(\);\s*\}/);
    // Windows and Linux: closing the window is a quit request, and it must not hide the window there.
    assert.match(closeBranch, /#\[cfg\(not\(target_os = "macos"\)\)\]\s*request_quit\(window\.app_handle\(\)\);/);
  });

  test("a page that starts loading again drops an open quit question", () => {
    const start = main.indexOf(".on_page_load(");
    const end = main.indexOf(".on_window_event(");
    assert.ok(start >= 0 && end > start, ".on_page_load comes right before .on_window_event");
    const hook = main.slice(start, end);
    assert.match(hook, /PageLoadEvent::Started/);
    assert.match(hook, /flow\.page_gone\(\)/);
  });

  test("a quit request while a question is open or a quit is under way brings the window back", () => {
    assert.match(main, /ShowAgain,/, "QuitStep has its own step for this");
    const start = main.indexOf("fn request_quit(");
    const end = main.indexOf("fn ask_page(");
    assert.ok(start >= 0 && end > start, "fn request_quit comes right before fn ask_page");
    assert.match(main.slice(start, end), /QuitStep::ShowAgain => show_main_window\(app\),/);
  });
});

describe("page code never opens the browser's own dialogs", () => {
  // tauri-plugin-dialog's init script replaces window.confirm, window.alert and window.prompt in every page the
  // desktop window loads. The replacements return a Promise, so `if (!window.confirm(...)) return;` never stops
  // anything (a Promise is always truthy). The page asks with its own in-page dialogs (AgentConfirmModal, SetupModal).
  const NAMES = ["confirm", "alert", "prompt"];

  function findDialogCalls(text) {
    const code = text
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    const found = [];
    // window.confirm(...), globalThis.alert(...), self?.prompt(...), window["confirm"](...)
    const qualified = /\b(?:window|globalThis|self)\s*(?:\?\.\s*|\.\s*|\[\s*["'`])(confirm|alert|prompt)\b/g;
    for (const match of code.matchAll(qualified)) found.push(`window.${match[1]}`);
    // A bare confirm(...) is the same property of window, unless the file declares its own function of that name.
    for (const name of NAMES) {
      const declared = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`).test(code);
      const bare = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
      if (!declared) for (const match of code.matchAll(bare)) found.push(`${name}()`);
    }
    return found;
  }

  async function sourceFiles(dir) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
      else if (/\.(tsx?|jsx?|mjs|html)$/.test(entry.name)) files.push(full);
    }
    return files;
  }

  test("the scan sees window.confirm, window.alert, window.prompt and bare calls, and leaves comments and local functions alone", () => {
    assert.deepEqual(findDialogCalls("if (!window.confirm(`Delete?`)) return;"), ["window.confirm"]);
    assert.deepEqual(findDialogCalls("window.alert('x'); globalThis.prompt('y');"), ["window.alert", "window.prompt"]);
    assert.deepEqual(findDialogCalls("if (!confirm('sure?')) return;"), ["confirm()"]);
    assert.deepEqual(findDialogCalls("// window.confirm is replaced by the dialog plugin\n * alert(1)"), []);
    assert.deepEqual(findDialogCalls("async function confirm() {}\nonConfirm={() => void confirm()}"), []);
    assert.deepEqual(findDialogCalls("onConfirm(); setPrompt(1); const prompt = 1;"), []);
  });

  test("no file under src/ calls window.confirm, window.alert or window.prompt", async () => {
    const files = await sourceFiles(path.join(root, "src"));
    assert.ok(files.length > 20, `the scan found ${files.length} files under src/`);
    const offenders = [];
    for (const file of files) {
      const calls = findDialogCalls(await readFile(file, "utf8"));
      if (calls.length) offenders.push(`${path.relative(root, file)}: ${calls.join(", ")}`);
    }
    assert.deepEqual(offenders, [], "use AgentConfirmModal (in-page) instead: the desktop window's dialog plugin makes these return a Promise");
  });
});

describe("desktop packaging and the desktop CI job", async () => {
  const release = await read(".github/workflows/release.yml");
  const ci = await read(".github/workflows/ci.yml");
  // The text of one top-level job in a workflow (from "  name:" to the next "  other-name:" or the end).
  const jobOf = (text, name) => {
    const match = text.match(new RegExp(`\\n  ${name}:\\r?\\n([\\s\\S]*?)(?=\\r?\\n  [a-z][a-z-]*:\\r?\\n|$)`));
    assert.ok(match, `job ${name} not found`);
    return match[1];
  };

  test("each release installer gets a server bundle with node-pty for its own computer", () => {
    assert.match(
      release,
      /run: node scripts\/prepare-desktop\.mjs --skip-node --platform \$\{\{ matrix\.node_platform \}\} --arch \$\{\{ matrix\.node_arch \}\}/
    );
  });

  test("CI builds the desktop shell and runs its unit tests on Linux, macOS and Windows", () => {
    const desktop = jobOf(ci, "desktop");
    for (const runner of ["ubuntu-22\\.04", "macos-14", "windows-latest"]) assert.match(desktop, new RegExp(runner));
    assert.match(desktop, /fail-fast:\s*false/);
    assert.match(desktop, /libwebkit2gtk-4\.1-dev/);
    assert.match(desktop, /run:\s*npm ci\s*\n/);
    assert.match(desktop, /prepare-desktop\.mjs --skip-node/);
    assert.match(desktop, /mkdir -p desktop\/src-tauri\/resources\/node/);
    assert.match(desktop, /working-directory:\s*desktop\/src-tauri\s*\n\s*run:\s*cargo build --locked/);
    assert.match(desktop, /working-directory:\s*desktop\/src-tauri\s*\n\s*run:\s*cargo test --locked/);
    assert.ok(!/CI:\s*true|CI=true/.test(ci), "ci.yml never sets CI=true");
    // It runs third-party actions (rust-toolchain, rust-cache): a moved tag must not get a write-capable token.
    assert.match(desktop, /(^|\n) {4}permissions:\s*\n {6}contents:\s*read\s*(\n|$)/, "the desktop job declares contents: read");
  });

  // The README checks, written once. A Windows checkout (the CI test job runs on windows-latest and the repo has
  // no .gitattributes) has CRLF line endings, so the text is put back to LF before the sentence is looked for.
  const checkReadme = (text) => {
    const readme = text.replace(/\r\n/g, "\n");
    const heading = "### Terminals (node-pty)";
    const terminals = readme.indexOf(heading);
    const testedOn = readme.indexOf("\n## Tested on");
    assert.ok(terminals > 0 && testedOn > terminals, "the Terminals part comes before Tested on");
    const part = readme.slice(terminals + heading.length, testedOn);
    assert.ok(!/^#/m.test(part), "Terminals is the last part before Tested on");
    assert.ok(!part.includes("Day-to-day development"), "development steps are not under Terminals");
    const development = readme.indexOf("Day-to-day development");
    assert.ok(development > 0 && development < terminals, "development steps stay above Terminals");
    assert.ok(readme.includes("`cd desktop && npx tauri build --target x86_64-apple-darwin` (not\n`npm run desktop:build`, which prepares for this computer again)."));
  };

  test("the desktop README ends with the Terminals part, keeps development steps above it, and says how to build after a cross-CPU prepare", async () => {
    checkReadme(await read("desktop/README.md"));
  });

  test("the README checks also pass on a Windows (CRLF) checkout of the README", async () => {
    const lf = (await read("desktop/README.md")).replace(/\r\n/g, "\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    assert.ok(crlf.includes("(not\r\n`npm run desktop:build`"), "the copy really has Windows line endings inside the wrapped sentence");
    checkReadme(crlf);
  });
});
