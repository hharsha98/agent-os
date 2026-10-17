# SP1 Design System and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Agent OS the approved "Cobalt Instrument" look in everything the shell reaches. That covers tokens, fonts, the Orbit logo and app icon, the menu, the top bar with "Hold to stop all", and a Sessions placeholder page. It also fixes the flaky setup-retry test.

**Architecture:**
- **Colours, type, spacing and motion** live in one token file (`src/ui/tokens.css`). Its `--os-*` names stay, and their values become Cobalt, so every existing component recolours without being rewritten.
- **Shell structure** stays in `src/ui/Shell.tsx`. The menu gets the new order, the top bar gets the new controls, and new small pieces are separate components (`Logo`, `HoldToStopAll`, `Toast`) plus one helper (`stopAll.ts`).
- **Pages are not redesigned here** (that is SP2). They only inherit the new tokens.

**Tech Stack:** React 18 + TypeScript + Vite 6, plain CSS with custom properties, lucide-react 0.468 icons, Express server (Node 24) with `node --test`, Tauri 2 CLI for app icons.

**Spec:** `docs/superpowers/specs/2026-10-11-cobalt-redesign-and-real-terminals-design.md` (section "SP1 Design system and shell", plus D9, D11, D13). Visual source of truth: the prototype at `~/MediaStudio/runs/2026-10-10-agent-os-redesign/prototype/` (serve it with `python3 -m http.server 4610 --bind 127.0.0.1` from that folder; screenshots in `prototype/shots/`).

## Global Constraints

- **Token values:** exactly the spec's "Old name to new role" table and "New names to add" list (copied into Task 4). No other colours.
- **One accent:** cobalt `#3866EE` for the primary action, the live state and the focus ring only. Status is always an icon plus a word, never colour alone.
- **Motion:** 120–200 ms, `cubic-bezier(0.23,1,0.32,1)`, everything off under `prefers-reduced-motion`. The one exception is the 1.2 s fill of "Hold to stop all", which tracks the user's own hold.
- **Fonts:** Archivo (variable, `wdth` axis, headings at 87.5 % width) for the UI; JetBrains Mono for data only. Both are bundled (no network). Inter is removed.
- **Breakpoints (unchanged):**
  - off-canvas menu at ≤ 900 px;
  - 64 px icon rail from 901 to 1366 px (D13);
  - full 228 px sidebar at ≥ 1367 px.
- **Menu order (D9):** Home, Sessions, Agents, Runs, Team Room, Workspace, Setup, Safety; Labs collapsed. Chat moves into Labs as "Dry-run chat", unchanged inside.
- **Hold to stop all (D11):**
  - stops every run, with no second dialog;
  - then a result toast;
  - it never stops the Hermes background service or the OpenClaw Gateway;
  - `StopAllRunsModal` stays only behind ⌘K "Stop all runs".
- **Legacy CSS:** `src/styles.css`, `src/agent-os.css` and `src/phase2.css` are not edited or deleted (Labs pages use them).
- **Copy:** plain English. No em dash in visible text, except the lone "—" meaning "unknown"; "…" means loading.
- **Inventory behaviours that must keep working:**
  - ⌘K/Ctrl+K palette with its focus trap and focus restore;
  - Escape closes the menu or rail and returns focus;
  - `aria-current="page"` on nav items;
  - the rail tooltip `role="tooltip"`;
  - the `#os-get-started` focus target;
  - `data-density` on `<html>`;
  - the `localStorage` keys `agentos.density` and `agentos.labsOpen`;
  - 5 s status polling via `useInterval` (pauses while the tab is hidden);
  - modal titles `os-modal-title` / `os-setup-modal-title`;
  - no `position: fixed` control inside ModelPicker;
  - `.os-run-console__transcript` and the setup log stay the scroll containers;
  - window minimums 1024×640 (`test/release-config.test.js`).
- **Workers:**
  - never commit, push, tag or set `CI=true`;
  - never start a real agent (fakes only, temp `HOME`/`AGENT_OS_HOME`);
  - never read `.env` files or `~/.claude`, `~/.codex`, `~/.cursor`, `~/.openclaw` or `~/.hermes` credential files;
  - retry until the listed checks are green;
  - report anything that could not be done.
- **Installing packages needs the owner's OK first.** The orchestrator asks; Task 3 lists exactly what.

## Review Focus

These are the five things most likely to go wrong for a real user that no unit test covers. Each one has a scripted browser check in the task that owns the code (the audit harness from Task 2):

1. **Letting go early must stop nothing.** Releasing "Hold to stop all" before 1.2 s, or moving the pointer off it, or switching windows mid-hold, must stop nothing and leave every run running. (Task 7)
2. **One hold, one stop.** Holding Space or Enter on the focused button (the key repeats), or pressing again while it is already stopping, must stop runs once and show exactly one toast. (Task 7)
3. **An honest failure when Agent OS is unreachable.** If the hold completes while the server is down, the toast says plainly that it couldn't reach Agent OS. Nothing crashes, and no false "Stopped" message appears. (Task 7)
4. **Old bookmarks still work.** A link to `?page=chat` opens "Dry-run chat" inside Labs, with Labs expanded and the item marked current. `?page=sessions` opens the placeholder. (Task 6)
5. **The new font really loads.** Archivo is actually used (the bundled file and the family name match), not silently replaced by the system font. (Task 3)

---

### Task 1: Retry right after a setup job fails sees the final saved status

The flaky test `retrySetupJob(): a failed configure job can't be retried once its key is gone from memory` fails under load. The bug happens in this order:
1. the job's in-memory status becomes "failed" before its last save reaches the disk;
2. `retrySetupJob` reads the older saved copy, which still says "running";
3. so it does nothing, instead of asking for the key again.

**Files:**
- Modify: `server/runtime/setup/jobs.js` (add `JOB_SETTLE_TIMEOUT_MS` and `waitForJobToSettle` near `claimJobLock` at line 63; change `retrySetupJob` at line 618)
- Test: `test/setup-brain.test.js` (add a test right after the existing one at line 1083)

**Interfaces:**
- Consumes: `activeJobs` (Map id → `{ job, controller }`) and `runningJobId`, both module-level in `jobs.js`.
- Produces: no new exports. `retrySetupJob(id)` keeps its signature and rejects with `code: "key_required_for_retry"` for a failed configure job, even when called in the moment between the in-memory failure and the final save.

- [ ] **Step 1: Write the failing test.** Add this to `test/setup-brain.test.js` directly after the test that starts at line 1083. `getSetupJob`, `retrySetupJob`, `startConfigureJob`, `installFakeOpenclawShim`, `withTempSetupEnv`, `VALID_KEY` and `posixSkip` are already imported or defined in that file.

```js
test("retrySetupJob(): a retry the moment a configure job fails still asks for the key again", posixSkip, async () => {
  await withTempSetupEnv(async ({ home }) => {
    await installFakeOpenclawShim(home);
    await writeFile(path.join(home, ".fake-openclaw-onboard-fail"), "1");
    const job = await startConfigureJob({ mode: "openrouter", apiKey: VALID_KEY, model: "free/128k", acceptOpenClawRisk: true });
    // Watch the in-memory job as closely as the event loop allows and retry the
    // moment it stops running: before its final save has reached the disk.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const current = await getSetupJob(job.id);
      if (current && current.status !== "running") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(() => retrySetupJob(job.id), (error) => error.code === "key_required_for_retry");
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run it three times, because it is a timing test.

Run: `for i in 1 2 3; do env -u HERMES_HOME node --test --test-name-pattern="the moment a configure job fails" test/setup-brain.test.js 2>&1 | grep -E '^# (pass|fail)'; done`
Expected: `# fail 1` on at least two of the three runs ("Missing expected rejection."). If it never fails on this machine, report that, and keep the test anyway as a guard.

- [ ] **Step 3: Implement the fix.** In `server/runtime/setup/jobs.js`, add this right after `claimJobLock` (which ends at line 68):

```js
// How long a retry waits for a job that has just ended to finish saving.
const JOB_SETTLE_TIMEOUT_MS = 5000;

// A job that has just ended keeps its in-memory entry (and the job lock) until
// its final save has reached the disk. A retry in that moment would read the
// older saved copy, which still says "running", so wait for the entry to go.
async function waitForJobToSettle(id) {
  const deadline = Date.now() + JOB_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const active = activeJobs.get(id);
    if (!active || active.job.status === "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

Then change the start of `retrySetupJob` (line 618). It is currently:

```js
export async function retrySetupJob(id) {
  if (runningJobId && runningJobId !== id) {
    throw jobError("job_already_running", "A different setup job is already running.");
  }
```

Make it:

```js
export async function retrySetupJob(id) {
  // This job may have just ended and still be saving its final status.
  if (runningJobId === id) await waitForJobToSettle(id);
  if (runningJobId && runningJobId !== id) {
    throw jobError("job_already_running", "A different setup job is already running.");
  }
```

Leave the rest unchanged. The lock is still claimed synchronously right after the check, as the existing comment requires.

- [ ] **Step 4: Run the new test and its neighbour.**

Run: `for i in 1 2 3; do env -u HERMES_HOME node --test --test-name-pattern="retrySetupJob" test/setup-brain.test.js 2>&1 | grep -E '^# (pass|fail)'; done`
Expected: `# fail 0` on all three runs.

- [ ] **Step 5: Run the whole setup suite.**

Run: `env -u HERMES_HOME node --test test/setup-brain.test.js test/setup.test.js test/setup-builders.test.js 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Commit** (orchestrator, after review).

```bash
git add server/runtime/setup/jobs.js test/setup-brain.test.js
git commit -m "Setup: a retry right after a job fails waits for its final save"
```

---

### Task 2: Browser audit harness (scratch, not in the repo)

This project has no UI test runner. Every visual and behavioural check in SP1 runs through one scratch script: a throwaway server with fake agents and a headless Chrome. It lives in the session scratchpad. It must never be added to the repo.

**Files** (`<scratchpad>` = `/private/tmp/claude-501/-Users-harsha-agent-os--claude-worktrees-epic-vaughan-c2e6ef/99da1686-664c-4c07-82c4-11601dde2612/scratchpad`):
- Create: `<scratchpad>/sp1/audit.mjs`
- Create: `<scratchpad>/sp1/fake-bin/` (fake `claude`, `codex`, `agent`, `hermes`, `openclaw`)

**Interfaces:**
- Produces:
  - `node <scratchpad>/sp1/audit.mjs <mode>` where `<mode>` is `pages`, `fonts`, `deeplinks` or `hold`;
  - it prints one `PASS <name>` or `FAIL <name>: <why>` line per check, and exits non-zero if any check fails;
  - screenshots go to `<scratchpad>/sp1/shots/<mode>/<width>x<height>/<page>.png`.
- Consumes: the built app in `dist/` (run `npm run build` first), Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, and the existing `playwright-core` at `~/.npm/_npx/a80a913f4f8f2557/node_modules/playwright-core` (borrowed, nothing installed).

- [ ] **Step 1: Write the fake agent.** It is one script, linked under all five names. It answers `--version`, sleeps when started as a headless run (so a run stays "running"), and exits at once for anything else. Write `<scratchpad>/sp1/fake-bin/fake-agent`:

```sh
#!/bin/sh
# Harmless stand-in for an AI agent CLI (no network, no files).
for arg in "$@"; do
  case "$arg" in
    --version) echo "9.9.9-fake"; exit 0 ;;
    -p|--print|exec) sleep 300; exit 0 ;;
  esac
done
exit 0
```

Run: `cd <scratchpad>/sp1/fake-bin && chmod 755 fake-agent && for n in claude codex agent hermes openclaw; do ln -sf fake-agent "$n"; done && ./claude --version`
Expected: `9.9.9-fake`

- [ ] **Step 2: Write the harness.** Write `<scratchpad>/sp1/audit.mjs`:

```js
// SP1 audit harness: a throwaway Agent OS server (temp HOME, fake agents only)
// plus headless Chrome. Usage: node audit.mjs pages|fonts|deeplinks|hold
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "~/.npm/_npx/a80a913f4f8f2557/node_modules/playwright-core");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = "~/agent-os/.claude/worktrees/epic-vaughan-c2e6ef";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8791;
const TOKEN = "audit" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
const BASE = `http://127.0.0.1:${PORT}`;
const SIZES = [[1280, 720], [1470, 956], [1512, 982]];
const PAGES = ["fleet", "sessions", "agents", "runs", "team", "workspace", "setup", "safety", "chat", "mission"];
const mode = process.argv[2] || "pages";
let failures = 0;
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, why) => { failures += 1; console.log(`FAIL ${name}: ${why}`); };

async function startServer() {
  const home = await mkdtemp(path.join(os.tmpdir(), "sp1-audit-"));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: REPO,
    env: {
      HOME: home, USERPROFILE: home, AGENT_OS_HOME: path.join(home, ".agent-os"),
      PATH: [path.join(HERE, "fake-bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
      PORT: String(PORT), AGENT_OS_TOKEN: TOKEN, HERMES_AGENT_OS_ENABLE_EXEC: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return { child, home }; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { "Content-Type": "application/json", "x-agent-os-token": TOKEN }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function openPage(browser, width, height, page) {
  const context = await browser.newContext({ viewport: { width, height } });
  const tab = await context.newPage();
  const errors = [];
  tab.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  tab.on("pageerror", (e) => errors.push(String(e)));
  await tab.goto(`${BASE}/?launch=${TOKEN}`);
  await tab.goto(`${BASE}/?page=${page}`);
  await tab.waitForTimeout(1200);
  return { context, tab, errors };
}

async function shot(tab, sub, width, height, name) {
  const dir = path.join(HERE, "shots", sub, `${width}x${height}`);
  await mkdir(dir, { recursive: true });
  await tab.screenshot({ path: path.join(dir, `${name}.png`) });
}

const { child, home } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME });
try {
  if (mode === "pages") {
    for (const [w, h] of SIZES) for (const page of PAGES) {
      const { context, tab, errors } = await openPage(browser, w, h, page);
      const sideways = await tab.evaluate(() => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth);
      sideways ? fail(`${page}@${w}`, "sideways scroll") : pass(`${page}@${w} no sideways scroll`);
      errors.length ? fail(`${page}@${w} console`, errors.join(" | ").slice(0, 300)) : pass(`${page}@${w} console clean`);
      await shot(tab, "pages", w, h, page);
      await context.close();
    }
  }
  // Later tasks add the "fonts", "deeplinks" and "hold" blocks here.
} finally {
  await browser.close();
  child.kill("SIGTERM");
  await rm(home, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
```

- [ ] **Step 3: Take the "before" baseline.**

Run: `cd ~/agent-os/.claude/worktrees/epic-vaughan-c2e6ef && npm run build >/dev/null && node <scratchpad>/sp1/audit.mjs pages | grep -c PASS; ls <scratchpad>/sp1/shots/pages/1470x956 | wc -l`
Expected:
- a PASS count is printed;
- 10 screenshots per size;
- any FAIL lines are recorded in the report as "existing before SP1" (for example `sessions` does not exist yet), and not fixed in this task.

- [ ] **Step 4: Check that no real agent ran.** The harness uses fakes on PATH only.

Run: `ps -axo command | grep -E "\.local/bin/(claude|codex|agent|hermes)|\.agent-os/node/bin/openclaw" | grep -v grep | grep -c sp1-audit`
Expected: `0`

No commit: this task only creates scratch files outside the repo.

---

### Task 3: Fonts: Archivo in, Inter out (needs the owner's OK to install)

**Files:**
- Modify: `package.json` / `package-lock.json` (via npm)
- Modify: `src/ui/fonts.ts`
- Modify: `<scratchpad>/sp1/audit.mjs` (add the `fonts` block)

**Interfaces:**
- Produces: the font family name `"Archivo Variable"` (used by `--os-font-ui` in Task 4), with the `wdth` axis available for `font-stretch: 87.5%`.

- [ ] **Step 1: The orchestrator asks the owner first.**
  - **Ask:** "Install `@fontsource-variable/archivo` (the Archivo font files, about 300 KB, OFL licence) and remove `@fontsource-variable/inter`?"
  - **Stop here until the owner says yes.**

- [ ] **Step 2: Install with an exact version, and uninstall Inter.**

Run: `cd ~/agent-os/.claude/worktrees/epic-vaughan-c2e6ef && npm install --save-exact @fontsource-variable/archivo && npm uninstall @fontsource-variable/inter && ls node_modules/@fontsource-variable/archivo/`
Expected:
- `package.json` lists `"@fontsource-variable/archivo": "<exact version>"` and no longer lists Inter;
- the folder contains `index.css`, and ideally `wdth.css`.

- [ ] **Step 3: Update `src/ui/fonts.ts`.** Replace the whole file with:

```ts
// Bundled variable fonts so the desktop app renders correctly offline:
// no network font request ever happens. Both are OFL-licensed.
// Archivo with its width axis (headings use font-stretch: 87.5%).
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/jetbrains-mono";
```

If `wdth.css` is missing in Step 2's listing, use `import "@fontsource-variable/archivo";` instead, and report that headings cannot use the narrower width.

- [ ] **Step 4: Add the font check to the harness.** In `audit.mjs`, add this block where the comment says later blocks go:

```js
  if (mode === "fonts") {
    const { context, tab } = await openPage(browser, 1470, 956, "fleet");
    const loaded = await tab.evaluate(async () => { await document.fonts.ready; return document.fonts.check('600 16px "Archivo Variable"'); });
    loaded ? pass("Archivo Variable loaded") : fail("Archivo", "font not loaded");
    const family = await tab.evaluate(() => getComputedStyle(document.querySelector(".os-nav__item")).fontFamily);
    /Archivo Variable/.test(family) ? pass("nav uses Archivo") : fail("nav font", family);
    await context.close();
  }
```

- [ ] **Step 5: Build and run the font check.** It fails until Task 4 points `--os-font-ui` at Archivo.

Run: `npm run build >/dev/null && node <scratchpad>/sp1/audit.mjs fonts`
Expected:
- now: `PASS Archivo Variable loaded` (the font file is bundled) and `FAIL nav font` (the token still says Inter);
- after Task 4: both PASS.

- [ ] **Step 6: Commit** together with Task 4 (orchestrator, after review), so the app is never committed without a working UI font.

---

### Task 4: Cobalt tokens and the removed-token sweep

**Files:**
- Modify: `src/ui/tokens.css` (whole file)
- Modify (replace references to removed tokens): `src/ui/modelPicker.css:272`, `src/ui/brain.css:303`, `src/ui/safety.css:33` (comment), `src/ui/agents.css:440-441`, `src/ui/palette.css:21-23`, `src/ui/updateBanner.css:30-34`, `src/ui/builders.css:342`, `src/ui/onboarding.css:32`, `src/ui/runs.css:482-483`, `src/ui/teamRoom.css:371`, `src/ui/setup.css:354` and `:518-519`, `src/ui/base.css:186`, `src/pages/FleetPage.tsx:43` (comment)

**Interfaces:**
- Produces: every `--os-*` token in the new `tokens.css` below. Later tasks use `--os-side-w`, `--os-topbar-h`, `--os-accent-hover`, `--os-accent-press`, `--os-accent-line`, `--os-disabled`, the `--os-*-wash` / `--os-*-line` status pairs, `--os-fs-15/17/26/34` and `--os-sp-48/64`.
- Removed tokens (must have zero references afterwards): `--os-glow`, `--os-glass-bg`, `--os-glass-blur`, `--os-dur-deliberate`, `--os-ease-pulse`, `--os-ease-inout`.

- [ ] **Step 1: Write the check that fails first.**

Run: `cd ~/agent-os/.claude/worktrees/epic-vaughan-c2e6ef && grep -rn -e "--os-glow" -e "--os-glass-bg" -e "--os-glass-blur" -e "--os-dur-deliberate" -e "--os-ease-pulse" -e "--os-ease-inout" src | wc -l`
Expected: a number above 0 (today 21).

- [ ] **Step 2: Replace `src/ui/tokens.css` with the Cobalt values.** Notes on this file:
  - The elevations keep a 1 px hairline ring, so existing panels keep their edges until SP2 redraws them (a deliberate SP1 bridge).
  - The decorative glows and noise grain are removed.
  - The compact-density block gains the two new spacing steps.

```css
/* Design tokens: "Cobalt Instrument" (design spec, SP1). Every token is
   prefixed --os- so it never collides with the legacy --line/--text/--panel
   variables in styles.css / agent-os.css, which keep their own values for the
   Labs pages that still use them. Values come from section 1 (TOKENS) of the
   approved prototype's cobalt.css; contrast is measured on the canvas. */
:root {
  color-scheme: dark;

  /* Grounds */
  --os-bg-0: #0c0e12; /* canvas */
  --os-bg-1: #0f1217; /* menu ground */
  --os-surface-1: #13161c;
  --os-surface-2: #1a1e26;
  --os-surface-3: #212631;
  --os-line-1: #262b35; /* dividers, decoration only */
  --os-line-2: #333a47; /* stronger dividers, button edge */
  --os-line-3: #5a6475; /* input and segment borders, 3:1 or more on canvas */

  /* Ink */
  --os-text-1: #e6e9ef; /* 15.9:1 */
  --os-text-2: #9aa3b2; /* 7.6:1 */
  --os-text-3: #7f8899; /* 5.4:1 (4.2:1 on surface-3: avoid there) */
  --os-unknown: #7f8899;
  --os-disabled: #6a7282;

  /* The one accent: cobalt */
  --os-accent: #3866ee;
  --os-accent-hover: #3e6cf2;
  --os-accent-press: #2d58d8;
  --os-accent-strong: #7da0ff; /* small cobalt text on dark, 7.7:1 */
  --os-accent-soft: rgba(56, 102, 238, 0.12);
  --os-accent-line: rgba(125, 160, 255, 0.38);
  --os-accent-ink: #ffffff; /* text on cobalt, 4.9:1 */

  /* Status: always an icon plus a word, never colour alone */
  --os-ok: #5fbf8f;
  --os-ok-wash: rgba(95, 191, 143, 0.07);
  --os-ok-line: rgba(95, 191, 143, 0.34);
  --os-warn: #e3b04b;
  --os-warn-wash: rgba(227, 176, 75, 0.07);
  --os-warn-line: rgba(227, 176, 75, 0.34);
  --os-danger: #e5675f;
  --os-danger-wash: rgba(229, 103, 95, 0.08);
  --os-danger-line: rgba(229, 103, 95, 0.4);

  /* Type */
  --os-font-ui: "Archivo Variable", system-ui, -apple-system, "Helvetica Neue", sans-serif;
  --os-font-mono: "JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace;
  --os-fs-11: 11px;
  --os-fs-12: 12px;
  --os-fs-13: 13px;
  --os-fs-14: 14px;
  --os-fs-15: 15px;
  --os-fs-16: 16px;
  --os-fs-17: 17px;
  --os-fs-20: 20px;
  --os-fs-24: 24px;
  --os-fs-26: 26px;
  --os-fs-32: 32px;
  --os-fs-34: 34px;
  --os-fs-44: 44px;
  --os-fs-64: 64px;
  --os-lh-display: 1.15;
  --os-lh-body: 1.55;

  /* Space (4px base). Values unchanged; 48 and 64 are new. */
  --os-sp-1: 4px;
  --os-sp-2: 8px;
  --os-sp-3: 12px;
  --os-sp-4: 16px;
  --os-sp-5: 20px;
  --os-sp-6: 24px;
  --os-sp-7: 32px;
  --os-sp-8: 40px;
  --os-sp-9: 56px;
  --os-sp-10: 72px;
  --os-sp-48: 48px;
  --os-sp-64: 64px;

  /* Radius (unchanged) */
  --os-r-sm: 6px;
  --os-r-md: 10px;
  --os-r-lg: 14px;
  --os-r-xl: 20px;
  --os-r-pill: 999px;

  /* Three elevations: neutral shadows, never coloured. The trailing 1px ring
     keeps today's panels outlined until SP2 redraws them with hairlines. */
  --os-e1: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 1px 2px rgba(3, 6, 14, 0.55), 0 0 0 1px var(--os-line-1);
  --os-e2: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 1px 2px rgba(3, 6, 14, 0.6), 0 8px 16px -8px rgba(3, 6, 14, 0.75), 0 0 0 1px var(--os-line-2);
  --os-e3: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 2px 4px rgba(3, 6, 14, 0.5), 0 22px 40px -14px rgba(3, 6, 14, 0.9), 0 0 0 1px var(--os-line-2);

  /* Motion: 120-200ms for UI */
  --os-dur-instant: 120ms;
  --os-dur-quick: 140ms;
  --os-dur-base: 200ms;
  --os-dur-slow: 200ms;
  --os-ease-out: cubic-bezier(0.23, 1, 0.32, 1);

  /* Layout */
  --os-side-w: 228px;
  --os-topbar-h: 56px;

  /* Terminal ground and the 16 ANSI colours (each measured against the ground) */
  --os-term-bg: #090b0f;
  --os-term-fg: #e6e9ef;
  --os-term-cursor: #e6e9ef;
  --os-term-select: rgba(56, 102, 238, 0.4);
  --os-ansi-0: #6f798e;
  --os-ansi-1: #e5675f;
  --os-ansi-2: #5fbf8f;
  --os-ansi-3: #e3b04b;
  --os-ansi-4: #7da0ff;
  --os-ansi-5: #c79bf0;
  --os-ansi-6: #4fc6d6;
  --os-ansi-7: #c5ccd8;
  --os-ansi-8: #8993a5;
  --os-ansi-9: #ff8f87;
  --os-ansi-10: #86ddb0;
  --os-ansi-11: #f1cb72;
  --os-ansi-12: #a5beff;
  --os-ansi-13: #e0b8f7;
  --os-ansi-14: #7fddeb;
  --os-ansi-15: #f4f6fa;
}

/* The app ground. No decorative glows and no noise grain (the approved
   design has neither). */
.os-shell {
  position: relative;
  background: var(--os-bg-0);
  isolation: isolate;
}

/* Compact density (the palette): every spacing token about a fifth tighter,
   plus the two controls that set their own height. Remembered per viewer
   (see ui/density.ts). Colours, type sizes and motion never change. */
:root[data-density="compact"] {
  --os-sp-1: 3px;
  --os-sp-2: 6px;
  --os-sp-3: 10px;
  --os-sp-4: 13px;
  --os-sp-5: 16px;
  --os-sp-6: 19px;
  --os-sp-7: 26px;
  --os-sp-8: 32px;
  --os-sp-9: 45px;
  --os-sp-10: 58px;
  --os-sp-48: 38px;
  --os-sp-64: 51px;
}
:root[data-density="compact"] .os-nav__item {
  min-height: 32px;
}
:root[data-density="compact"] .os-btn {
  min-height: 28px;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 3: Replace every reference to a removed token.** Exact edits:

| Where | Before | After |
|---|---|---|
| `modelPicker.css:272`, `brain.css:303`, `builders.css:342`, `teamRoom.css:371`, `setup.css:354` | `box-shadow: var(--os-glow);` | `box-shadow: var(--os-e2), 0 0 0 1px var(--os-accent-line);` |
| `updateBanner.css:34` | `box-shadow: var(--os-e2), var(--os-glow);` | `box-shadow: var(--os-e3);` |
| `updateBanner.css:30`, `agents.css:440`, `palette.css:21`, `runs.css:482`, `setup.css:518` | `background: var(--os-glass-bg);` | `background: var(--os-surface-2);` |
| `updateBanner.css:31-32`, `agents.css:441`, `palette.css:22-23`, `runs.css:483`, `setup.css:519` | every `backdrop-filter: var(--os-glass-blur);` and `-webkit-backdrop-filter: var(--os-glass-blur);` line | delete the line |
| `onboarding.css:32` | `var(--os-dur-deliberate)` | `var(--os-dur-base)` |
| `base.css:186` | `var(--os-ease-pulse)` | `var(--os-ease-out)` |
| `safety.css:33` (comment) | `(the brief's --os-glow, tinted per` | `(an accent hairline, tinted per` |
| `FleetPage.tsx:43` (comment) | `// --os-dur-deliberate` | `// count-up length; Home is rebuilt in SP2` |

- [ ] **Step 4: Run the sweep check again.**

Run: `grep -rn -e "--os-glow" -e "--os-glass-bg" -e "--os-glass-blur" -e "--os-dur-deliberate" -e "--os-ease-pulse" -e "--os-ease-inout" src | wc -l`
Expected: `0`

- [ ] **Step 5: Type check, build, and run the font check.**

Run: `npx tsc -b && npm run build >/dev/null && echo BUILD-OK && node <scratchpad>/sp1/audit.mjs fonts`
Expected: `BUILD-OK`, then `PASS Archivo Variable loaded` and `PASS nav uses Archivo`.

- [ ] **Step 6: Run the pages audit and compare.**

Run: `node <scratchpad>/sp1/audit.mjs pages | grep FAIL`
Expected:
- no FAIL that wasn't in the Task 2 baseline;
- the screenshots show the Cobalt colours (aluminium dark, cobalt accent) instead of teal.

- [ ] **Step 7: Commit** (orchestrator, after review; includes Task 3).

```bash
git add package.json package-lock.json src/ui/fonts.ts src/ui/tokens.css src/ui/*.css src/pages/FleetPage.tsx
git commit -m "Design system: Cobalt tokens and Archivo font, glows and Inter removed"
```

---

### Task 5: Orbit logo, app icon, favicon and the app version constant

**Files:**
- Create: `src/ui/Logo.tsx`
- Create: `public/favicon.svg` (Vite copies `public/` into `dist/`)
- Create: `src/vite-env.d.ts`
- Modify: `vite.config.ts` (define `__APP_VERSION__`)
- Modify: `index.html` (favicon, theme colour, title)
- Modify: `src/LockedScreen.tsx:44`
- Modify: `desktop/loading/index.html` (the `.mark` style at lines 44-56 and the element at line 96)
- Replace: `desktop/icon-source.svg`; regenerate `desktop/src-tauri/icons/*`

**Interfaces:**
- Produces:
  - `export default function Logo(props: { size?: number; title?: string; className?: string }): JSX.Element`. It is decorative (aria-hidden) unless `title` is given. It draws in `currentColor`, with the lit node in `var(--os-accent)`.
  - The global constant `__APP_VERSION__: string` (from `package.json`), used by Task 6's footer.

- [ ] **Step 1: Create `src/ui/Logo.tsx`.**

```tsx
import { useId } from "react";

// The Agent OS "Orbit" mark (design spec D2): a ring with five agents on it,
// the lit one in cobalt and the ring cut around it. Drawn from the approved
// prototype's shared/logo.svg on a 24-unit grid. Decorative unless a title is
// given. The mask id is unique per instance so two marks never share one.
interface LogoProps {
  size?: number;
  title?: string;
  className?: string;
}

export default function Logo({ size = 24, title, className }: LogoProps) {
  const maskId = `aos-cut-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <g transform="translate(-0.9 0)">
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="#fff" />
          <circle cx="19.99" cy="9.4" r="4" fill="#000" />
        </mask>
        <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.8" mask={`url(#${maskId})`} />
        <circle cx="12" cy="3.6" r="1.85" fill="currentColor" />
        <circle cx="16.94" cy="18.8" r="1.85" fill="currentColor" />
        <circle cx="7.06" cy="18.8" r="1.85" fill="currentColor" />
        <circle cx="4.01" cy="9.4" r="1.85" fill="currentColor" />
        <circle cx="19.99" cy="9.4" r="3" fill="var(--os-accent)" />
      </g>
    </svg>
  );
}
```

- [ ] **Step 2: Add the app version constant.** In `vite.config.ts`, add at the top:

```ts
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
```

In the returned config object, add `define: { __APP_VERSION__: JSON.stringify(pkg.version) },` next to `plugins`. Then create `src/vite-env.d.ts`:

```ts
// The app version, injected from package.json by vite.config.ts.
declare const __APP_VERSION__: string;
```

- [ ] **Step 3: Favicon and page head.**
  - Copy the prototype mark into `public/favicon.svg` with: `mkdir -p public && cp ~/MediaStudio/runs/2026-10-10-agent-os-redesign/prototype/shared/logo.svg public/favicon.svg`.
  - In `index.html`:
    - set `<meta name="theme-color" content="#0c0e12" />`;
    - set `<title>Agent OS</title>`;
    - add `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` after the viewport meta.

- [ ] **Step 4: Replace the "A" marks.**
  - **`src/LockedScreen.tsx` line 44:** replace `<div className="os-logo-mark">A</div>` with `<Logo size={40} title="Agent OS" />`, and add `import Logo from "./ui/Logo";`.
  - **`desktop/loading/index.html`** (this page loads before the app, so it is static SVG):
    - replace the element at line 96 with:

```html
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(-0.9 0)"><mask id="aos-cut" maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28"><rect x="-2" y="-2" width="28" height="28" fill="#fff"/><circle cx="19.99" cy="9.4" r="4" fill="#000"/></mask><circle cx="12" cy="12" r="8.4" fill="none" stroke="#E6E9EF" stroke-width="1.8" mask="url(#aos-cut)"/><circle cx="12" cy="3.6" r="1.85" fill="#E6E9EF"/><circle cx="16.94" cy="18.8" r="1.85" fill="#E6E9EF"/><circle cx="7.06" cy="18.8" r="1.85" fill="#E6E9EF"/><circle cx="4.01" cy="9.4" r="1.85" fill="#E6E9EF"/><circle cx="19.99" cy="9.4" r="3" fill="#3866EE"/></g></svg>
```

    - replace the whole `.mark { ... }` rule (lines 44-56) with:

```css
      .mark {
        width: 48px;
        height: 48px;
        display: block;
      }
```

    - in the same file, change any teal colour (`#5ce1ff`, `#8aebff`) to `#3866EE`, and the page background to `#0C0E12`.

- [ ] **Step 5: The app icon.**
  - Copy the icon source: `cp ~/MediaStudio/runs/2026-10-10-agent-os-redesign/prototype/shared/app-icon.svg desktop/icon-source.svg`.
  - Regenerate the icons: `cd desktop && npx tauri icon icon-source.svg && cd ..`.
  - Run `git status --short desktop/src-tauri/icons`. Delete any newly created **untracked** folders, such as `android/` or `ios/` (they were not tracked before). Keep only the tracked files that were updated.

Expected: modified `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, `icon.png` and the `Square*`/`StoreLogo` PNGs; no new tracked folders.

- [ ] **Step 6: Check.**

Run: `npx tsc -b && npm run build >/dev/null && ls dist/favicon.svg && env -u HERMES_HOME node --test test/release-config.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `dist/favicon.svg`, `# fail 0`.

- [ ] **Step 7: Commit** (orchestrator, after review).

```bash
git add src/ui/Logo.tsx src/vite-env.d.ts vite.config.ts public/favicon.svg index.html src/LockedScreen.tsx desktop/loading/index.html desktop/icon-source.svg desktop/src-tauri/icons
git commit -m "Brand: Orbit logo, app icon and favicon replace the A mark"
```

---

### Task 6: Menu: new order, Sessions placeholder, Chat in Labs, Setup progress, footer

**Files:**
- Create: `src/pages/SessionsPage.tsx`
- Modify: `src/DashboardRoot.tsx` (the `ShellPage` union at line 41, `ALL_PAGES` at line 70, the routing at line 254)
- Modify: `src/ui/Shell.tsx` (imports, `NavItem`, `coreItems`/`labsItems` at lines 147-183, the logo block at lines 399-405, nav rendering at lines 423-435, the Labs toggle at lines 437-448, the safety footer at lines 467-478)
- Modify: `src/ui/shell.css` (placeholder styles)
- Modify: `<scratchpad>/sp1/audit.mjs` (add the `deeplinks` block)

**Interfaces:**
- Consumes: `Logo` and `__APP_VERSION__` (Task 5), and `useOnboarding().data?.counts.{done,total}` (existing).
- Produces:
  - page id `"sessions"`;
  - `export default function SessionsPage(): JSX.Element`;
  - `NavItem` gains `meta?: string` (short trailing text, for example "4 of 4") and `metaLabel?: string` (its spoken form).

- [ ] **Step 1: Write the failing deep-link checks.** Add to `audit.mjs`:

```js
  if (mode === "deeplinks") {
    for (const [w, h] of [[1470, 956], [1280, 720]]) {
      const chat = await openPage(browser, w, h, "chat");
      const current = await chat.tab.evaluate(() => document.querySelector('.os-nav__item[aria-current="page"]')?.textContent?.trim() || "");
      const labs = await chat.tab.evaluate(() => document.querySelector(".os-nav__labs-toggle")?.getAttribute("aria-expanded"));
      current.includes("Dry-run chat") && labs === "true" ? pass(`?page=chat@${w}`) : fail(`?page=chat@${w}`, `current="${current}" labs=${labs}`);
      await chat.context.close();
      const sessions = await openPage(browser, w, h, "sessions");
      const heading = await sessions.tab.evaluate(() => document.querySelector("h1")?.textContent || "");
      heading.includes("Sessions") ? pass(`?page=sessions@${w}`) : fail(`?page=sessions@${w}`, `h1="${heading}"`);
      const order = await sessions.tab.evaluate(() => [...document.querySelectorAll(".os-nav > .os-nav__item .os-nav__label:first-of-type")].map((n) => n.textContent.trim()).join(","));
      order === "Home,Sessions,Agents,Runs,Team Room,Workspace,Setup,Safety" ? pass(`menu order@${w}`) : fail(`menu order@${w}`, order);
      await sessions.context.close();
    }
  }
```

Run: `npm run build >/dev/null && node <scratchpad>/sp1/audit.mjs deeplinks`
Expected: FAIL lines (Chat is still in Core, and there is no Sessions page yet).

- [ ] **Step 2: Create `src/pages/SessionsPage.tsx`** (a designed placeholder with no sample data).

```tsx
import { SquareTerminal } from "lucide-react";
import { navigateTo } from "../nav";

// Sessions arrive in SP3: each agent's own real terminal inside Agent OS.
// Until then this page says honestly what is coming and where to go today.
export default function SessionsPage() {
  return (
    <section className="aos-phase-page os-sessions-soon" aria-labelledby="os-sessions-title">
      <h1 id="os-sessions-title">Sessions</h1>
      <p className="os-sessions-soon__lead">Work with your agents in their own real terminal, right here.</p>
      <div className="os-sessions-soon__body">
        <SquareTerminal size={20} aria-hidden="true" />
        <div>
          <p>
            Soon you will open Claude Code, Codex, Cursor, Hermes and OpenClaw on this page, each in its real terminal with your own
            settings, and Agent OS will tell you when one is waiting for you.
          </p>
          <p>Until then, you can start a background run from Runs.</p>
          <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("runs")}>
            Open Runs
          </button>
        </div>
      </div>
    </section>
  );
}
```

Add the styles to the end of `src/ui/shell.css`:

```css
/* Sessions placeholder (SP1; replaced by the real Sessions page in SP3) */
.os-sessions-soon {
  max-width: 720px;
}
.os-sessions-soon h1 {
  font-size: var(--os-fs-34);
  font-stretch: 87.5%;
  letter-spacing: -0.02em;
  margin: 0 0 var(--os-sp-2);
}
.os-sessions-soon__lead {
  color: var(--os-text-2);
  font-size: var(--os-fs-15);
  margin: 0 0 var(--os-sp-7);
}
.os-sessions-soon__body {
  display: flex;
  gap: var(--os-sp-4);
  align-items: flex-start;
  border-top: 1px solid var(--os-line-1);
  padding-top: var(--os-sp-6);
  color: var(--os-text-2);
}
.os-sessions-soon__body p {
  margin: 0 0 var(--os-sp-3);
  max-width: 62ch;
}
```

- [ ] **Step 3: Route the page.** In `src/DashboardRoot.tsx`:
  - add `| "sessions"` to the `ShellPage` union;
  - add `"sessions",` to `ALL_PAGES`;
  - add `import SessionsPage from "./pages/SessionsPage";` with the other page imports;
  - in the routing chain, after the `page === "fleet" ? (<FleetPage />)` branch, add `: page === "sessions" ? (<SessionsPage />)`.
  - The existing `page === "chat"` route stays as it is.

- [ ] **Step 4: Change the menu in `src/ui/Shell.tsx`.**
  - **Lucide imports:** add `Check`, `SlidersHorizontal` and `SquareTerminal`. `Bot`, `Home`, `ShieldCheck`, `Activity`, `Users`, `FolderOpen`, `MessageSquare` and `Monitor` are already imported. Remove `LayoutDashboard` and `Boxes` only if nothing else in the file uses them. Keep `Wand2`, which the palette's "Open Setup" item uses.
  - **`NavItem`:** add `meta?: string;` and `metaLabel?: string;`.
  - **`coreItems` becomes:**

```ts
  const onboardingCounts = onboarding.data?.counts;
  const coreItems: NavItem[] = useMemo(
    () => [
      { id: "fleet", label: "Home", icon: Home },
      { id: "sessions", label: "Sessions", icon: SquareTerminal },
      { id: "agents", label: "Agents", icon: Bot },
      { id: "runs", label: "Runs", icon: Activity },
      { id: "team", label: "Team Room", icon: Users },
      { id: "workspace", label: "Workspace", icon: FolderOpen },
      {
        id: "setup",
        label: "Setup",
        icon: SlidersHorizontal,
        meta: onboardingCounts ? `${onboardingCounts.done} of ${onboardingCounts.total}` : undefined,
        metaLabel: onboardingCounts ? `${onboardingCounts.done} of ${onboardingCounts.total} steps done` : undefined
      },
      { id: "safety", label: "Safety", icon: ShieldCheck }
    ],
    [onboardingCounts]
  );
```

  - **`labsItems`:** gets `{ id: "chat", label: "Dry-run chat", icon: MessageSquare },` as its first entry.
  - **Core nav buttons** (lines 424-435): render the meta after the label, and include it in the accessible name:

```tsx
          {coreItems.map((item, index) => (
            <button
              key={item.id}
              ref={index === 0 ? firstNavRef : undefined}
              className={`os-nav__item${isActive(item.id) ? " is-active" : ""}`}
              aria-current={isActive(item.id) ? "page" : undefined}
              aria-label={item.metaLabel ? `${item.label}, ${item.metaLabel}` : undefined}
              onClick={() => go(item.id)}
              {...tipHandlers(item.label)}
            >
              <item.icon size={16} aria-hidden="true" /> <span className="os-nav__label">{item.label}</span>
              {item.meta ? (
                <span className="os-nav__meta os-nav__label" aria-hidden="true">
                  {onboardingCounts && onboardingCounts.done === onboardingCounts.total ? <Check size={12} aria-hidden="true" /> : null}
                  {item.meta}
                </span>
              ) : null}
            </button>
          ))}
```

  - **The "Core" section label** (`<p className="os-micro os-nav__section">Core</p>`) is removed; the prototype has no label above the core items.
  - **Labs toggle** (lines 437-448): keep its behaviour, `aria-expanded` and `aria-label`. Remove the `<span className="os-chip os-chip--experimental ...">Experimental</span>`, so it reads "Labs" with the chevron, as in the prototype.
  - **The logo block (lines 399-405)** becomes:

```tsx
        <div className="os-logo">
          <Logo size={24} className="os-logo__mark" />
          <strong className="os-logo__text os-nav__label">Agent OS</strong>
        </div>
```

  - **Machine label.** Next to `SHORTCUT_LABEL`, add:

```ts
// What to call this computer in the menu footer.
const PLATFORM = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";
const MACHINE_LABEL = /mac/i.test(PLATFORM) ? "On this Mac" : /win/i.test(PLATFORM) ? "On this PC" : "On this computer";
```

  - **Footer.** Replace the safety footer button (lines 467-478) with a quiet machine/version footer, because the safety level moves to the top bar in Task 7:

```tsx
        <div className="os-sidebar__footer" title={demoPublic ? "Public demo" : `Agent OS ${__APP_VERSION__}`}>
          <Monitor size={14} aria-hidden="true" />
          <span className="os-nav__label">{demoPublic ? "Public demo" : MACHINE_LABEL}</span>
          <span className="os-nav__label os-mono os-sidebar__version">v{__APP_VERSION__}</span>
        </div>
```

  - Add `import Logo from "./Logo";`.
  - Keep `safetyLevelMark` and `safetyLevelLabel`: Task 7 uses `safetyLevelLabel` in the top bar. If TypeScript reports `safetyLevelMark` as unused after this task, leave it until Task 7 decides.

- [ ] **Step 5: Run the deep-link checks, the type check and the build.**

Run: `npx tsc -b && npm run build >/dev/null && node <scratchpad>/sp1/audit.mjs deeplinks`
Expected: `PASS ?page=chat@1470`, `PASS ?page=chat@1280`, `PASS ?page=sessions@...` and `PASS menu order@...`, with no FAIL.

- [ ] **Step 6: Commit** (orchestrator, after review).

```bash
git add src/pages/SessionsPage.tsx src/DashboardRoot.tsx src/ui/Shell.tsx src/ui/shell.css
git commit -m "Menu: Sessions placeholder, Chat moves to Labs, Setup progress, machine footer"
```

---

### Task 7: Top bar and "Hold to stop all"

**Files:**
- Create: `src/ui/stopAll.ts`
- Create: `src/ui/components/HoldToStopAll.tsx`
- Create: `src/ui/components/Toast.tsx`
- Modify: `src/ui/Shell.tsx` (the status bar at lines 338-396; `useStatusStrip` at lines 496-549)
- Modify: `src/ui/shell.css` (top bar, hold button and toast styles)
- Modify: `src/ui/base.css` (`.os-visually-hidden`, only if missing)
- Modify: `<scratchpad>/sp1/audit.mjs` (add the `hold` block)

**Interfaces:**
- Consumes: `listRuns({ limit })` and `stopRun(id)` from `src/api.ts` (existing; used today by `StopAllRunsModal`), and `safetyLevelLabel(level)` (existing, in `Shell.tsx`).
- Produces:
  - `export interface StopAllResult { found: number; stopped: number; failed: number; unreachable: boolean }`;
  - `export async function stopEverything(): Promise<StopAllResult>` (SP3 adds sessions inside this same function);
  - `export function stopAllMessage(result: StopAllResult): { message: string; tone: "ok" | "warn" | "danger" | "neutral" }`, exported from `stopAll.ts`;
  - `export default function HoldToStopAll(props: { onResult: (result: StopAllResult) => void }): JSX.Element`;
  - `export default function Toast(props: { message: string; tone: "ok" | "warn" | "danger" | "neutral"; onClose: () => void }): JSX.Element`.

- [ ] **Step 1: Write the failing hold checks.** Add to `audit.mjs`. It starts fake runs through the API (the fake `claude` sleeps for `-p`), holds the button, and checks the run status. Before writing it, check the run-start response shape with `grep -n "res.status(20\|res.json(" server/runtime/agents/routes.js | sed -n 1,20p` and adjust `startFakeRun` if the id is not at `run.id` or `id`.

```js
  async function startFakeRun() {
    const r = await api("POST", "/api/agents/claude/runs", { prompt: "audit: wait", confirm: true });
    if (r.status >= 300) throw new Error(`run start failed ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json.run?.id || r.json.id;
  }
  async function runStatus(id) {
    const r = await api("GET", `/api/runs/${id}`);
    return r.json.run?.status || r.json.status;
  }
  async function waitStatus(id, want, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (want.includes(await runStatus(id))) return true; await new Promise((r) => setTimeout(r, 200)); }
    return false;
  }
  async function closeToasts(tab) {
    for (const b of await tab.locator(".os-toast__close").all()) await b.click().catch(() => {});
  }
  if (mode === "hold") {
    const { context, tab } = await openPage(browser, 1470, 956, "fleet");
    const button = tab.getByRole("button", { name: /hold to stop all/i });
    // 1. Letting go early stops nothing.
    const early = await startFakeRun();
    await (await waitStatus(early, ["running"]));
    await button.hover(); await tab.mouse.down(); await tab.waitForTimeout(500); await tab.mouse.up();
    await tab.waitForTimeout(1500);
    (await runStatus(early)) === "running" ? pass("early release stops nothing") : fail("early release", await runStatus(early));
    // 2. Moving off the button mid-hold stops nothing.
    await button.hover(); await tab.mouse.down(); await tab.waitForTimeout(400); await tab.mouse.move(10, 400); await tab.waitForTimeout(1200); await tab.mouse.up();
    (await runStatus(early)) === "running" ? pass("leaving the button stops nothing") : fail("leave mid-hold", await runStatus(early));
    // 3. A full hold stops it, with one toast and no dialog.
    await button.hover(); await tab.mouse.down(); await tab.waitForTimeout(1500); await tab.mouse.up();
    (await waitStatus(early, ["stopped", "cancelled", "failed"])) ? pass("full hold stops the run") : fail("full hold", await runStatus(early));
    const dialogs = await tab.locator('[role="dialog"]').count();
    dialogs === 0 ? pass("no second dialog") : fail("dialog", `${dialogs} dialog(s) open`);
    const toast1 = await tab.locator(".os-toast").allTextContents();
    toast1.length === 1 && /Stopped 1 run/.test(toast1[0]) ? pass("one result toast") : fail("toast", JSON.stringify(toast1));
    // 4. A keyboard hold with key repeat stops once.
    await closeToasts(tab);
    const kb = await startFakeRun();
    await waitStatus(kb, ["running"]);
    await button.focus(); await tab.keyboard.down(" ");
    for (let i = 0; i < 15; i += 1) { await tab.waitForTimeout(100); await tab.keyboard.down(" "); }
    await tab.keyboard.up(" ");
    (await waitStatus(kb, ["stopped", "cancelled", "failed"])) ? pass("keyboard hold stops") : fail("keyboard hold", await runStatus(kb));
    await tab.waitForTimeout(800);
    const toast2 = await tab.locator(".os-toast").allTextContents();
    toast2.length === 1 ? pass("key repeat gives one toast") : fail("key repeat", JSON.stringify(toast2));
    // 5. Nothing running: an honest message.
    await closeToasts(tab);
    await button.hover(); await tab.mouse.down(); await tab.waitForTimeout(1500); await tab.mouse.up(); await tab.waitForTimeout(800);
    /Nothing was running/.test((await tab.locator(".os-toast").allTextContents()).join(" ")) ? pass("nothing running message") : fail("nothing running", "no message");
    // 6. Server unreachable: an honest failure.
    await closeToasts(tab);
    child.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 1500));
    await button.hover(); await tab.mouse.down(); await tab.waitForTimeout(1500); await tab.mouse.up(); await tab.waitForTimeout(1500);
    const toast3 = (await tab.locator(".os-toast").allTextContents()).join(" ");
    /Couldn't reach Agent OS/.test(toast3) && !/Stopped/.test(toast3) ? pass("unreachable is honest") : fail("unreachable", toast3);
    await context.close();
  }
```

Run: `npm run build >/dev/null && node <scratchpad>/sp1/audit.mjs hold`
Expected: FAIL (there is no "Hold to stop all" button yet).

- [ ] **Step 2: Create `src/ui/stopAll.ts`.**

```ts
import { listRuns, stopRun } from "../api";

// What "Hold to stop all" stops (design spec D11): every run that is queued or
// running. From SP3 it also stops every session, inside this same function.
// It never touches the Hermes background service or the OpenClaw Gateway.
const ACTIVE = new Set(["queued", "running"]);

export interface StopAllResult {
  found: number;
  stopped: number;
  failed: number;
  unreachable: boolean;
}

export async function stopEverything(): Promise<StopAllResult> {
  let runs;
  try {
    ({ runs } = await listRuns({ limit: 100 }));
  } catch {
    return { found: 0, stopped: 0, failed: 0, unreachable: true };
  }
  const live = runs.filter((run) => ACTIVE.has(run.status));
  const results = await Promise.allSettled(live.map((run) => stopRun(run.id)));
  const failed = results.filter((result) => result.status === "rejected").length;
  return { found: live.length, stopped: live.length - failed, failed, unreachable: false };
}

export function stopAllMessage(result: StopAllResult): { message: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (result.unreachable) {
    return { message: "Couldn't reach Agent OS, so nothing was stopped. Try again, or stop each run on Runs.", tone: "danger" };
  }
  if (result.found === 0) return { message: "Nothing was running, so there was nothing to stop.", tone: "neutral" };
  const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
  if (result.failed === 0) return { message: `Stopped ${runs(result.stopped)}.`, tone: "ok" };
  return { message: `Stopped ${result.stopped} of ${runs(result.found)}. ${result.failed} could not be stopped: check Runs.`, tone: "warn" };
}
```

- [ ] **Step 3: Create `src/ui/components/Toast.tsx`.**

```tsx
import { useEffect } from "react";
import { CheckCircle2, CircleAlert, Info, X, XCircle } from "lucide-react";

// A short result message at the bottom of the window. Announced politely to
// screen readers, closes itself after 8 seconds, or with its close button.
const ICONS = { ok: CheckCircle2, warn: CircleAlert, danger: XCircle, neutral: Info } as const;

interface ToastProps {
  message: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  onClose: () => void;
}

export default function Toast({ message, tone, onClose }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 8000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  const Icon = ICONS[tone];
  return (
    <div className={`os-toast os-toast--${tone}`} role="status" aria-live="polite">
      <Icon size={16} aria-hidden="true" />
      <span className="os-toast__text">{message}</span>
      <button type="button" className="os-toast__close" aria-label="Close message" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/ui/components/HoldToStopAll.tsx`.** The hold is the confirmation. A pointer or key must stay down for 1.2 s; letting go, leaving the button, losing focus or the window losing focus cancels it; key repeats are ignored; while stopping, the button is disabled so it cannot fire twice.

```tsx
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { OctagonX } from "lucide-react";
import { stopEverything } from "../stopAll";
import type { StopAllResult } from "../stopAll";

const HOLD_MS = 1200;

export default function HoldToStopAll({ onResult }: { onResult: (result: StopAllResult) => void }) {
  const [holding, setHolding] = useState(false);
  const [stopping, setStopping] = useState(false);
  const timer = useRef<number | null>(null);
  const keyDown = useRef(false);

  function cancel() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    keyDown.current = false;
    setHolding(false);
  }

  function begin() {
    if (stopping || timer.current !== null) return;
    setHolding(true);
    timer.current = window.setTimeout(async () => {
      timer.current = null;
      setHolding(false);
      setStopping(true);
      try {
        onResult(await stopEverything());
      } finally {
        setStopping(false);
      }
    }, HOLD_MS);
  }

  // Switching windows mid-hold must not leave a hold running.
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat || keyDown.current) return;
    keyDown.current = true;
    begin();
  }

  function onKeyUp(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    cancel();
  }

  return (
    <button
      type="button"
      className={`os-holdstop${holding ? " is-holding" : ""}`}
      disabled={stopping}
      aria-describedby="os-holdstop-hint"
      onPointerDown={(event) => {
        if (event.button === 0) begin();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onBlur={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onClick={(event) => event.preventDefault()}
    >
      <span className="os-holdstop__fill" aria-hidden="true" />
      <OctagonX size={15} aria-hidden="true" />
      <span className="os-holdstop__label">{stopping ? "Stopping…" : holding ? "Keep holding…" : "Hold to stop all"}</span>
      <span id="os-holdstop-hint" className="os-visually-hidden">
        Press and hold for about one second to stop every run. It does not stop the Hermes or OpenClaw background services.
      </span>
    </button>
  );
}
```

- [ ] **Step 5: Rebuild the top bar in `src/ui/Shell.tsx`.**
  - Replace the contents of `<div className="os-statusbar">` with, in this order:
    1. the menu button (unchanged);
    2. the search trigger (unchanged markup and aria, with the class `os-btn os-btn--ghost os-palette-trigger os-palette-trigger--field`);
    3. `<span className="os-statusbar__spacer" />`;
    4. `<GetStartedPill />`;
    5. the safety level;
    6. `{/* SP4: "Waiting for you (n)" badge, hidden while n = 0 */}`;
    7. `<HoldToStopAll onResult={(result) => setToast(stopAllMessage(result))} />`.
  - The safety level is:

```tsx
          <button type="button" className="os-statusbar__level" onClick={() => go("safety")} title={status.safetyHint || "Open Safety"}>
            <ShieldCheck size={15} aria-hidden="true" />
            <span>
              {status.level === null ? (
                status.safetyLabel
              ) : (
                <>
                  <b>Level {status.level}</b> · {safetyLevelLabel(status.level)}
                </>
              )}
            </span>
          </button>
```

  - Remove from the top bar the density group (density stays in the ⌘K palette, whose two items already exist), the Gateways segment and the Live runs segment.
  - Remove `safetyLevelMark` if nothing uses it any more.
  - State and render:
    - add `const [toast, setToast] = useState<{ message: string; tone: "ok" | "warn" | "danger" | "neutral" } | null>(null);`;
    - render `{toast ? <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} /> : null}` next to `<UpdateBanner />`.
    - Import `HoldToStopAll` from `./components/HoldToStopAll`, `Toast` from `./components/Toast`, and `{ stopAllMessage }` from `./stopAll`.
  - **`useStatusStrip`:** remove the gateway and live-run polling and their state (`gatewaysRunning`, `gatewaysLoaded`, `liveRuns`, `liveRunsLoaded`, and the `getAgentService` / `listRuns` calls in `refresh`), since nothing shows them now. Keep the safety part and the 5 s `useInterval`. Remove `getAgentService` and `listRuns` from the `../api` import if nothing else in the file uses them.
  - The palette's "Stop all runs" item stays as it is (it opens `StopAllRunsModal`).
  - If `src/ui/base.css` has no visually-hidden utility, add:

```css
.os-visually-hidden {
  position: absolute !important;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

- [ ] **Step 6: Styles** in `src/ui/shell.css`, following `prototype/shared/cobalt.css` section 4 (top bar, lines 135-220) and section 12 (toast, lines 411-452):
  - **Hold button:** a danger ghost button (`var(--os-danger)` text, `1px solid var(--os-danger-line)` border, `--os-r-sm` radius), `position: relative; overflow: hidden`. Its `.os-holdstop__fill` is `position: absolute; inset: 0; transform: scaleX(0); transform-origin: left; background: var(--os-danger-wash);`. While `.is-holding` it moves to `scaleX(1)` with `transition: transform 1200ms linear`, and back to `scaleX(0)` with `transition: transform 120ms var(--os-ease-out)`. Under `prefers-reduced-motion`, the global reset makes this instant, and the "Keep holding…" label carries the meaning.
  - **Toast:** `position: fixed; left: 50%; bottom: var(--os-sp-6); transform: translateX(-50%);` with `--os-surface-2` and `box-shadow: var(--os-e3)`, `--os-r-md` radius, and max-width 520 px. Its icon takes the tone colour (`--os-ok`, `--os-warn`, `--os-danger`, `--os-text-2`), with the words in `--os-text-1`.
  - **Top bar:** height `var(--os-topbar-h)` above 1366 px (keep the existing laptop rule's 48 px in the rail range). `.os-statusbar__spacer { flex: 1; }`. `.os-statusbar__level` is a ghost button in `--os-text-2`, with the level number in `--os-text-1`.

- [ ] **Step 7: Run the hold checks, the type check and the build.**

Run: `npx tsc -b && npm run build >/dev/null && node <scratchpad>/sp1/audit.mjs hold`
Expected: PASS for all of:
- `early release stops nothing`;
- `leaving the button stops nothing`;
- `full hold stops the run`;
- `no second dialog`;
- `one result toast`;
- `keyboard hold stops`;
- `key repeat gives one toast`;
- `nothing running message`;
- `unreachable is honest`.

No FAIL.

- [ ] **Step 8: Commit** (orchestrator, after review).

```bash
git add src/ui/stopAll.ts src/ui/components/HoldToStopAll.tsx src/ui/components/Toast.tsx src/ui/Shell.tsx src/ui/shell.css src/ui/base.css
git commit -m "Top bar: search, safety level and Hold to stop all with a result toast"
```

---

### Task 8: The shell and shared components in the Cobalt style

This task ports the look, not new behaviour. The source is the prototype's CSS; the target is the app's existing class names.

**Files:**
- Modify: `src/ui/shell.css` (sidebar, logo, nav, Labs toggle, rail, footer, top bar, palette trigger)
- Modify: `src/ui/base.css` (buttons, fields, chips, focus ring, panel, readout, micro text)
- Modify: `src/ui/palette.css` (the ⌘K palette in Cobalt)
- Modify: `src/ui/laptop.css` only where a value fights the new shell (keep every breakpoint)

**Interfaces:**
- Consumes: the tokens from Task 4, the markup from Tasks 5 to 7.
- Produces: no new class names, except those already introduced in Tasks 6 and 7 (`.os-nav__meta`, `.os-sidebar__footer`, `.os-sidebar__version`, `.os-statusbar__spacer`, `.os-statusbar__level`, `.os-palette-trigger--field`, `.os-holdstop*`, `.os-toast*`, `.os-sessions-soon*`), and `.os-logo__mark`.

- [ ] **Step 1: Read the sources.** Read `prototype/shared/cobalt.css`:
  - sections 2 BASE (lines 92-114), 3 TYPE (115-134), 4 APP SHELL (135-220), 5 BUTTONS (221-263), 6 FIELDS (264-309), 7 CHIPS/STATUS (310-340), 12 DIALOG/TOAST/PALETTE (411-452) and 15 MOTION OFF (492-503);
  - plus `prototype/shared/shell.js` (the menu and top bar markup);
  - plus the screenshots `prototype/shots/home.png` and `prototype/shots/sessions--normal.png`.

- [ ] **Step 2: Port the values onto the app's classes,** translating variable names with this table (from the spec):

| Prototype | App |
|---|---|
| `--canvas` | `--os-bg-0` |
| `--side` | `--os-bg-1` |
| `--surface-1/2/3` | `--os-surface-1/2/3` |
| `--hair` | `--os-line-1` |
| `--hair-2` | `--os-line-2` |
| `--edge` | `--os-line-3` |
| `--ink` | `--os-text-1` |
| `--ink-soft` | `--os-text-2` |
| `--ink-faint` | `--os-text-3` |
| `--disabled` | `--os-disabled` |
| `--accent` | `--os-accent` |
| `--accent-hover` / `-press` / `-line` | `--os-accent-hover` / `-press` / `-line` |
| `--accent-text` | `--os-accent-strong` |
| `--accent-wash` | `--os-accent-soft` |
| `--accent-ink` | `--os-accent-ink` |
| `--ready` / `--attention` / `--failed` (+ `-wash`, `-line`) | `--os-ok` / `--os-warn` / `--os-danger` (+ `-wash`, `-line`) |
| `--ui` | `--os-font-ui` |
| `--mono` | `--os-font-mono` |
| `--t-xs` / `sm` / `base` / `md` / `lg` / `xl` / `2xl` / `3xl` | `--os-fs-12` / `13` / `14` / `15` / `17` / `20` / `26` / `34` |
| `--sp-1` … `--sp-6` | `--os-sp-1` … `--os-sp-6` |
| `--sp-8` | `--os-sp-7` |
| `--sp-10` | `--os-sp-8` |
| `--sp-12` | `--os-sp-48` |
| `--sp-16` | `--os-sp-64` |
| `--r1` / `--r2` / `--r3` | `--os-r-sm` / `--os-r-md` / `--os-r-lg` |
| `--e1` / `--e2` / `--e3` | `--os-e1` / `--os-e2` / `--os-e3` |
| `--ease` | `--os-ease-out` |
| `--side-w` | `--os-side-w` |
| `--topbar-h` | `--os-topbar-h` |

Rules for the port:
- **Sidebar:**
  - **Background, width, logo:** `--os-bg-1` background and `--os-side-w` width above 1366 px. `.os-logo__mark` is 24 px in `--os-text-1`, and "Agent OS" is `--os-fs-17`, weight 600.
  - **Nav item states:** 34 px tall, with a 16 px icon and `--os-fs-14` text in `--os-text-2`. Hover goes to `--os-text-1` on `--os-surface-1`. The active item is `--os-surface-2` with `--os-text-1`; there is no coloured left border thicker than 1 px.
  - **`.os-nav__meta`, footer and old mark:** `.os-nav__meta` sits at the right (`margin-left: auto`) in `--os-fs-12` `--os-text-3`. `.os-sidebar__footer` sits at the bottom with a 1 px `--os-line-1` top border, in `--os-fs-12` `--os-text-2`. Remove the old `.os-logo-mark` rules.
- **Rail range (901-1366 px):** keep the existing behaviour and the 64 px width. Restyle the colours only.
- **Buttons:**
  - **Kinds:** `.os-btn--primary` is `--os-accent` with `--os-accent-ink` text; hover `--os-accent-hover`; press `--os-accent-press` plus `transform: translateY(1px)`. `.os-btn--secondary` is `--os-surface-2` with a `--os-line-2` border; `.os-btn--ghost` is transparent. `.os-btn--danger` has `--os-danger` text and a `--os-danger-line` border.
  - **Disabled:** calm, never broken-looking. `--os-disabled` text, `--os-surface-1` background and a `--os-line-1` border, with no opacity on the label.
- **Focus ring everywhere** (`.os-shell :focus-visible`): `outline: 2px solid var(--os-accent-strong); outline-offset: 2px;`.
- **Headings and body:** `h1`/`h2` inside `.os-shell` get `font-stretch: 87.5%` and `letter-spacing: -0.02em`. Body text is weight 400 and at least `--os-fs-13`.
- **Palette** (`palette.css`): `--os-surface-2` with `--os-e3`, `--os-line-2` hairlines between groups, and the selected row `--os-surface-3` with `--os-text-1`.
- **Do not edit** `src/styles.css`, `src/agent-os.css` or `src/phase2.css`.

- [ ] **Step 3: Check.**

Run: `npx tsc -b && npm run build >/dev/null && node <scratchpad>/sp1/audit.mjs pages | grep FAIL; node <scratchpad>/sp1/audit.mjs deeplinks | grep -c FAIL; node <scratchpad>/sp1/audit.mjs hold | grep -c FAIL`
Expected:
- no FAIL from `pages` beyond the Task 2 baseline;
- `0` and `0` for the other two.

Then open `<scratchpad>/sp1/shots/pages/1470x956/fleet.png` and `.../sessions.png` next to `prototype/shots/home.png`. The menu, logo, top bar and type should match the prototype; page contents are SP2. At 1280 px the menu is the icon rail (D13).

- [ ] **Step 4: Commit** (orchestrator, after review).

```bash
git add src/ui/shell.css src/ui/base.css src/ui/palette.css src/ui/laptop.css
git commit -m "Shell: Cobalt menu, top bar, buttons, fields and focus ring"
```

---

### Task 9: SP1 verification (orchestrator)

**Files:** none changed. If a check fails, the fix goes back to the task that owns it.

- [ ] **Step 1: Full suite under the real-agent watcher.** Start the watcher in the background:

```bash
S=/private/tmp/claude-501/-Users-harsha-agent-os--claude-worktrees-epic-vaughan-c2e6ef/99da1686-664c-4c07-82c4-11601dde2612/scratchpad; rm -f $S/stop-watch-sp1 $S/ps-watch-sp1.log; touch $S/ps-watch-sp1.log; while [ ! -f $S/stop-watch-sp1 ]; do ps -axo pid,ppid,command | grep -E "\.hermes/hermes-agent/venv/bin/hermes|/\.agent-os/node/bin/openclaw|/Users/[^/]+/\.local/bin/(hermes|codex|agent|claude)" | grep -v -E "grep|\.hermes/tools/python|input-format stream-json" >> $S/ps-watch-sp1.log; sleep 0.5; done
```

Then run the suite:

```bash
cd ~/agent-os/.claude/worktrees/epic-vaughan-c2e6ef && env -u HERMES_HOME npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)'
```

Expected:
- `# fail 0`;
- after `touch $S/stop-watch-sp1`, any line in `ps-watch-sp1.log` belongs to a process whose parent is not the test runner (for example the owner's own live server, identified as on 2026-10-10).

- [ ] **Step 2: Build and type check.**

Run: `npx tsc -b && npm run build 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 3: The removed-token sweep.**

Run: `grep -rn -e "--os-glow" -e "--os-glass-bg" -e "--os-glass-blur" -e "--os-dur-deliberate" -e "--os-ease-pulse" -e "--os-ease-inout" src | wc -l`
Expected: `0`

- [ ] **Step 4: All harness modes.**

Run: `for m in pages fonts deeplinks hold; do node <scratchpad>/sp1/audit.mjs $m | grep -E "^FAIL"; done; echo DONE`
Expected: `DONE` with no FAIL lines (or only Task 2 baseline items, each explained).

- [ ] **Step 5: Look at the screenshots.**
  - Read the PNGs for `fleet`, `sessions`, `agents`, `runs`, `setup`, `safety`, `chat` and `mission` at each size.
  - At 1470 and 1512 px the full labelled sidebar shows; at 1280 px, the icon rail.
  - Check: the Orbit logo appears, the type is Archivo, cobalt is the only accent, there are no glows or grain, and the Labs pages still render with their legacy styles.

- [ ] **Step 6: Measure contrast** in the harness page context (a one-off evaluate). Measure:
  - `--os-text-1`, `--os-text-2` and `--os-text-3` on `--os-bg-0`, which must be ≥ 4.5:1;
  - `--os-accent-ink` on `--os-accent`, which must be ≥ 4.5:1;
  - `--os-line-3` on `--os-bg-0`, which must be ≥ 3:1;
  - the disabled button text on its background, reported but not a gate.

- [ ] **Step 7: Keyboard path** (in the browser pane against a throwaway server):
  1. Tab from the top: the menu items, Labs, search, Level, then Hold to stop all. Focus is visible on each.
  2. ⌘K opens the palette; Escape closes it and returns focus.
  3. In the rail range, the expand toggle opens and Escape closes it.
  4. Holding Space on "Hold to stop all" works.

- [ ] **Step 8: Report to the owner.** Include:
  - screenshots (SendUserFile): Home and Sessions at 1470 px, Home at 1280 px with the rail, and the toast;
  - the test numbers and every deliberate difference from today: the D13 rail; the density switch moving into ⌘K; the gateway and live-run counters leaving the top bar; the "Experimental" chip leaving Labs.

The local commits from Tasks 1 and 3 to 8 are in place. Nothing is pushed.
