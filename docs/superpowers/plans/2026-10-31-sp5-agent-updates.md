# SP5 Agent Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent OS checks each agent's version against its latest release, updates any agent with its own official updater from the Agents page or Setup (Hermes only from a clean checkout, in a real terminal), and offers "Restart session to use vX" for sessions still on the old version.

**Architecture:** A new `server/runtime/updates/` folder holds four parts:
- the version checks (npm dist-tags and each agent's own read-only check);
- the Hermes clean check (read-only git through SP4's safe `runGit`);
- one update service that every update path calls: Setup jobs for four agents, and an SP3 `update` session for Hermes;
- the routes.

Sessions record the agent version they started on, and a new restart route stops a session and resumes it. The Agents page, the footer dot and Setup read `/api/updates`.

**Tech Stack:** Node 24 ESM server (Express), React + TypeScript client (Vite), `node:test`, the existing fakes (`test/helpers/fake-agents.js`, `test/fakes/tui-agent.mjs`) and the UI audit harness probes (git-ignored).

**Spec:** `docs/superpowers/specs/2026-10-11-cobalt-redesign-and-real-terminals-design.md`, section "SP5 Agent updates", plus:
- H7;
- "Session kinds" (`update`);
- the Shell footer dot;
- the Agents and Setup page rows;
- spikes S5, S6 and S8.

**Branch:** `feat/sp5-agent-updates`, made from `feat/sp4-session-extras` at 745a7e0 (SP4 is still the open draft PR #12). Ledger: the plan's SDD workspace (`scripts/sdd-workspace`).

## Global Constraints

- H7: every update uses the agent's own official updater; nothing in Agent OS pins or downgrades an agent; Agent OS auto-update stays off; Claude Code's own auto-updater keeps the user's setting.
- No `updateArgs` contains `--yes`; no updater question is ever answered for the user (no stdin "ignore", no end-of-input).
- The Hermes clean check never runs `git fetch` and never writes to the checkout (SP4's `runGit`: hooks off, no optional locks, no network transport).
- Never re-run the Hermes installer on an existing install.
- An update never stops or restarts a running session or run; they keep the version they started with. A restart happens only on the person's click, after a confirm, and presses no keys.
- The `update` session: created only by the update service through `manager.createUpdateSession`; argv exactly `hermes update`; not gated by the safety level; at most one at a time; never resumed (SP3 "Session kinds").
- Network failures show "Couldn't check" and never block anything; checks run at start and every 24 h, read-only.
- No real network access and no real agent in tests (`no-real-agents` watcher; `env -u HERMES_HOME npm test`).
- Every new sentence a person sees is listed in "Sentences" below, word for word, and goes to the owner for review at E1 (rule R28).
- Shell: use `/usr/bin/grep` (the default grep is ugrep); macOS has no `timeout`; never set `CI=true`.

## Review Focus

1. **Noisy CLI output:** a check whose CLI prints a notice line before or after its answer (OpenClaw banners, Hermes update hints). The parser reads the answer, never the notice; anything unreadable is "failed", never "available". Test: V1 "parsers ignore notice lines".
2. **Odd version strings:** installed versions with suffixes ("2.1.309 (Claude Code)", "codex-cli 0.154.0", "2026.10.14-941492e"). They compare by the first dotted number, and when one side has none the state is "unknown". Test: V1 `compareVersions` table.
3. **Two updates at once:** two Update clicks, or Setup and Agents starting updates together. Only one update per agent runs; the second gets 409 "update_running". Test: V3 "a second update for the same agent is refused".
4. **Hermes in a different profile:** a profile with `HERMES_HOME` set, or a remote URL written as `git@github.com:NousResearch/hermes-agent` / `HTTPS://GitHub.com/nousresearch/hermes-agent.git/`. The checkout is found from `resolveHermesHome()`; URLs match ignoring case and an optional `.git` or trailing slash. Tests: V2 table rows.
5. **Restart that can't resume:** Restart session pressed while the session's resume is unavailable, or on an `update` session. It refuses with the reason and runs nothing. Test: V4 "restart refuses without resume".

---

## Facts read from the agents (2026-10-31, owner's Mac, help and code only)

| Agent | Installed version source | Latest check (read-only) | Update command (job unless noted) |
|---|---|---|---|
| Claude Code | `claude --version` → "2.1.309 (Claude Code)" | npm `GET <registry>/-/package/@anthropic-ai/claude-code/dist-tags` → `latest` | `claude update` (its help: "package-manager installs update through the package manager") |
| Codex | `codex --version` → "codex-cli 0.154.0" | npm dist-tags of `@openai/codex` → `latest` | `codex update` (exists in 0.154.0) |
| Cursor | `agent --version` → "2026.10.14-941492e" | none (no check command in its help) → "unknown" | `agent update` |
| OpenClaw | `openclaw --version` | `openclaw update --dry-run --json` → top-level `currentVersion`, `targetVersion`, `restart` (boolean), `downgradeRisk` | `openclaw update --json` (no `--yes`) |
| Hermes | `hermes --version` | `hermes update --check` (runs its own `git fetch`): prints "✓ Already up to date." or "⚕ Update available: N commits behind <ref>."; exit 1 or 2 = failed | `hermes update` in an `update` session, only when clean |

Hermes checkout on a normal install: `<hermes home>/hermes-agent`, detached at an annotated release tag (`v0.22.5`). It is not on `origin/main`: its release history is reachable only through `v*` tags. The channel record is `update.installs` in Hermes's config ("Config key not set" when default). `hermes config get` prints a missing key as a sentence starting "Config key not set".

## Rulings made while planning (recorded in the spec by Task D1)

- **R35:** the Hermes clean check's "official remote's refs" are `refs/remotes/<official>/*` **plus** release tags `refs/tags/v<digits>…`. HEAD is "on the official release or main ref" when it is `refs/heads/main`, or detached exactly at a `v*` tag, or equal to `refs/remotes/<official>/main`. "No commit outside" is `git rev-list --count HEAD --not --remotes=<official> --tags='v[0-9]*'` = 0.
  - **Why:** a normal Hermes install is detached at a release tag whose 6,288 commits are not on `origin/main`, so the spec's text would call every normal install "not clean".
  - **Cost if wrong:** a locally made `v*` tag on local commits would pass. That takes deliberate effort, and the working-tree and channel checks still apply.
- **R36:** "default channel" means `hermes config get update.installs` prints nothing usable (empty, `{}`, `null`, or "Config key not set…"). Anything else is not clean (fails closed).
- **R37:** Claude Code's latest is npm dist-tag `latest`, compared with the installed version. Codex's is `@openai/codex` `latest`. Cursor's is "unknown" until S6 finds a check. OpenClaw's is the dry run's `targetVersion`, and `downgradeRisk: true` counts as no update. Hermes reports "available" with no number.
- **R38:** Claude Code always updates with `claude update` (H7). It hands package-manager installs to the package manager itself; S8 checks a Homebrew install if the owner has one. Codex updates with `codex update`; when its binary lives under Agent OS's bundled Node (`<AGENT_OS bundled node prefix>`), that Node's `bin` goes first on PATH, so its npm is the one used (spec Codex row).
- **R39:** Cursor shows "unknown" and still offers Update, because `agent update` checks before it installs.
- **R40:** sessions record `agentVersion` (the adapter's detected `version` at start and at resume). The restart banner shows for a live `agent` session whose `agentVersion` differs from the agent's installed version now. Sessions with no recorded version (started before SP5) show nothing.
- **R41:** S5, S6 and S8 update the owner's real agents, so E2 asks first, once, for the whole set, and names each agent's from → to version.

## Sentences (NEW SENTENCE, owner review at E1)

Agents page, Version block:
- "Installed {v}" (unchanged), "Latest {v}"
- "Up to date"
- "Update available"
- "Couldn't check"
- "Agent OS can't check Cursor's latest version. Its updater checks when you press Update."
- "Checked {relative time}."
- Buttons: "Update", "Check again"

The Update confirm dialog:
- Title: "Update {agent}?"
- Body: "Runs {agent}'s own updater: {command}."
- Open sessions: "Open sessions keep running on the version they started with until you restart them." For OpenClaw: "Open sessions may stop working until you restart them." (R50)
- OpenClaw only: "Dry run: {current} → {target}." and "Its Gateway restarts, and the update can take several minutes." (R50)
- Setup's OpenClaw row with Update chosen, which has no dry-run answer: "Open sessions may stop working until you restart them. The update can take several minutes." (R50)
- Buttons: "Cancel", "Update"
- Setup's confirm when a refused start leaves nothing to run: title "Nothing to run", with the refusal's sentence and only its Cancel button. (R53)
- Setup's Cancel confirm while an update step runs, after its own sentence: "An update is running. Stopping it now can leave that agent half-updated." (R54)

Hermes:
- Clean and up to date, on Setup's row and in the 409 `hermes_up_to_date`: "Hermes is up to date." (R48)
- Not clean: "Agent OS updates Hermes only from an unchanged official copy." followed by one reason line per finding:
  - "Agent OS can't find Hermes's folder."
  - "Its folder doesn't come from the official Hermes repository."
  - "Agent OS can't read the official repository's references in its folder."
  - "It isn't on an official release or main."
  - "It has commits that aren't in the official repository."
  - "It has changes that aren't saved in a commit."
  - "It follows a different update channel."
- The 4-step guide (heading "To update a changed copy safely:"):
  1. "Keep your changes on your own branch: git switch -c my-hermes"
  2. "Follow main: hermes update --set-channel main"
  3. "Keep your branch in place when updating: hermes config set updates.parked_branch_strategy update_in_place"
  4. "Update: hermes update"
- Update session heading: "Hermes update. Type into it if Hermes asks you something." Once the session has ended: "Hermes update." (R56)

Restart banner and confirm (copy from the spec, word for word):
- "Restart session to use v{new}"
- "Restart {agent} in {folder}?"
- "The session closes and starts again on v{new}."
- Buttons: "Not now", "Restart session"
- When resume is unavailable: "This session can't be resumed, so restarting would lose it. {resume reason}"

Errors:
- 409 `update_running`: "{agent} is already updating."
- 409 `hermes_not_clean`: "Hermes's folder changed since the last check, so Agent OS didn't update it."

Footer dot tooltip: "An agent has an update".

## Order of work

D1 → V1 → V2 → V3 → V4 → U1 → U2 → E1 → E2. V1 and V2 share no files, but run them one after the other anyway (one implementer at a time).

---

### Task D1: Spec update: record R35–R41 (orchestrator)

**Files:** Modify `docs/superpowers/specs/2026-10-11-cobalt-redesign-and-real-terminals-design.md`:
- Appendix A3: one row each for R35–R41, in the table's existing format (ruling | where | why);
- the SP5 Hermes "clean" bullets: add "(release tags count as the official remote's refs, R35)".

- [ ] **Step 1:** Write the seven rows from "Rulings made while planning".
- [ ] **Step 2:** `env -u HERMES_HOME node --test test/sessions-changes-ui-logic.test.js` → `# fail 0`.
- [ ] **Step 3:** Commit: `git commit -m "Spec: SP5 planning rulings R35-R41"`.

### Task V1: Version checks

**Files:**
- Create: `server/runtime/updates/versions.js`, `server/runtime/updates/checks.js`
- Modify: `server/runtime/agents/hermes.js` (export `resolveHermesHome`)
- Test: `test/updates-versions.test.js`, `test/updates-checks.test.js`; fakes in `test/helpers/fake-agents.js` (answers below)

**Interfaces (produces):**
- `versions.js`:
  - `compareVersions(a: string, b: string): -1 | 0 | 1 | null`. It compares the first `\d+(\.\d+)+` run in each string, numerically and part by part; `null` when either string has none.
  - `parseDistTags(text: string): string | null` returns `latest`.
  - `parseOpenclawDryRun(stdout: string): { current: string|null, target: string|null, restartsGateway: boolean, downgradeRisk: boolean } | null`. It reads the last JSON object in stdout.
  - `parseHermesCheck({ code, stdout }): "up-to-date" | "available" | null`.
- `checks.js`:
  - `type UpdateState = "up-to-date" | "available" | "unknown" | "failed" | "not-installed"`;
  - `type AgentUpdateStatus = { agentId, installed: string|null, latest: string|null, state: UpdateState, checkedAt: string, restartsGateway?: boolean }`;
  - `checkAgent(agentId, { fetchText, runCli, detect }): Promise<AgentUpdateStatus>`;
  - `createUpdateChecks({ check = checkAgent, intervalMs = 24*60*60*1000, now = Date.now }) → { start(), stop(), list(): AgentUpdateStatus[], refresh(agentId?): Promise<AgentUpdateStatus[]> }`;
  - `getUpdateChecks()`, a module singleton.
- The npm registry base is `https://registry.npmjs.org`, replaceable only by `AGENT_OS_TEST_NPM_REGISTRY` (a test-only escape hatch, the same pattern as `server/runtime/setup/recipes.js` lines 7–50). Each check has a 30 s limit. Checks for the five agents run in parallel; one failing never affects the others.

- [ ] **Step 1: failing tests** (`test/updates-versions.test.js`):
  - `compareVersions` table:
    - ("2.1.309 (Claude Code)", "2.1.310") → -1;
    - ("codex-cli 0.154.0", "0.154.0") → 0;
    - ("2026.10.9", "2026.10.4") → 1;
    - ("v0.22.5", "0.22.5") → 0;
    - ("2026.10.14-941492e", "") → null;
    - ("abc", "1.0") → null.
  - "parsers ignore notice lines":
    - an OpenClaw dry run with a banner line before the JSON gives `{ current: "2026.10.4", target: "2026.10.9", restartsGateway: true, downgradeRisk: false }`;
    - Hermes "⚕ Update available: 3 commits behind origin/main.", followed by a "Run 'hermes update' to install." line, gives "available";
    - "✓ Already up to date." gives "up-to-date";
    - `code: 1` gives `null`.
- [ ] **Step 2:** run → fails (module missing).
- [ ] **Step 3:** implement `versions.js`.
- [ ] **Step 4: failing tests** (`test/updates-checks.test.js`), with a local HTTP server as the registry and fake CLIs:
  - claude: installed 2.1.309, latest 2.1.310 → "available";
  - codex: equal → "up-to-date";
  - cursor → "unknown", `latest: null`;
  - openclaw from the fake dry run → "available", `restartsGateway: true`;
  - a `downgradeRisk: true` dry run → "up-to-date";
  - hermes up to date and behind;
  - the registry answering 500 → that agent "failed", the others unaffected;
  - a CLI that hangs → "failed" after the limit (inject a short limit);
  - not installed → "not-installed";
  - `start()` checks once at once and again after `intervalMs` (fake timers);
  - `list()` before the first check returns `[]` without throwing.
- [ ] **Step 5:** implement `checks.js` (Hermes's check runs with `HERMES_HOME` from `resolveHermesHome()`, the same rule as E2-F3).
- [ ] **Step 6:** the two files and `test/agents.test.js` → `# fail 0`.
- [ ] **Step 7:** commit `SP5 V1: version checks (npm dist-tags, OpenClaw dry run, Hermes check)`.

### Task V2: Hermes clean check

**Files:**
- Create: `server/runtime/updates/hermes-clean.js`
- Test: `test/updates-hermes-clean.test.js` (temp git repos made by the test, no network)

**Interfaces:**
- **Consumes:** `runGit(folder, args, { env, okCodes })` (`server/runtime/sessions/git.js`) and `resolveHermesHome()` (V1).
- **Produces:**
  - `isOfficialHermesUrl(url: string): boolean`. It accepts `https://github.com/NousResearch/hermes-agent` and `git@github.com:NousResearch/hermes-agent`, ignoring case, with an optional `.git` and an optional trailing `/`, and also with `ssh://git@github.com/`. A URL with credentials (`https://user:tok@github.com/...`) still matches after the credentials are dropped. Nothing else matches.
  - `hermesCleanCheck({ home?, configGet }): Promise<{ clean: boolean, checkout: string|null, reasons: HermesReason[] }>`.
  - `HermesReason` is one of `no_checkout`, `no_official_remote`, `refs_unreadable`, `not_on_release_or_main`, `local_commits`, `dirty_tree`, `custom_channel`. Each maps to the sentence of the same order in "Sentences".
  - The checkout is `<home ?? resolveHermesHome() ?? ~/.hermes>/hermes-agent` and must contain `.git`. The official remote is any remote whose fetch URL matches. Every finding is collected, not only the first. Any git call that fails means not clean, with its reason.

- [ ] **Step 1: failing tests**, one row each:
  - an official clone on a `v*` tag → clean;
  - on `main` equal to `origin/main` → clean;
  - an official clone plus one local commit → `local_commits`;
  - a custom branch pushed to a fork remote, with no official remote → `no_official_remote`;
  - a clone of a fork only → `no_official_remote`;
  - a dirty tree (a modified file, an untracked file) → `dirty_tree`;
  - `update.installs` set → `custom_channel`;
  - detached at a non-`v` commit that is on origin → `not_on_release_or_main`;
  - no checkout folder → `no_checkout`;
  - the official remote's refs missing (remote configured, never fetched) → `refs_unreadable`;
  - URL variants for `isOfficialHermesUrl`, including credentials and letter case;
  - "never fetches": a spy `runGit` records no `fetch`, `pull`, `ls-remote` or `remote update` call.

  The test makes its repos with plain `git init`, `git commit` and `git tag -a`; the "official" remote is a local bare repo whose URL is rewritten with `url.<path>.insteadOf` so that it reads as the official URL. No network.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3:** implement. Use `git rev-list --count HEAD --not --remotes=<name> --tags='v[0-9]*'` (R35) and `git status --porcelain --untracked-files=normal`.
- [ ] **Step 4:** → `# fail 0`.
- [ ] **Step 5:** commit `SP5 V2: Hermes clean check (read-only, release tags count as official)`.

### Task V3: One update service: routes, Setup and Hermes update session

**Files:**
- Create: `server/runtime/updates/update-service.js`, `server/runtime/updates/routes.js`
- Modify:
  - `server/index.js` (mount `/api/updates` with `requireLocalMode`, next to `/api/sessions`; `getUpdateChecks().start()` after listen, stopped on shutdown);
  - `server/runtime/setup/plan.js` (remove `NO_UPDATE_STEP`; `buildSetupPlan(check, { agents, hermesClean = false })` offers `hermes-update` only when `hermesClean` is true, with `runsIn: "session"`);
  - `server/runtime/setup/jobs.js` (refuse a `hermes-update` step: it runs only as a session; the `codex update` PATH rule from R38; after any update step ends, clear the detect caches and `refresh(agentId)`);
  - `server/runtime/setup/routes.js` (`GET /plan` and `POST /jobs` pass `hermesClean` from `hermesCleanCheck()`).
- Test: `test/updates-service.test.js`; extend `test/setup.test.js`.

**Interfaces:**
- `startAgentUpdate(agentId, { manager }): Promise<{ kind: "job", jobId } | { kind: "session", sessionId }>`:
  - Hermes: re-runs `hermesCleanCheck()`. Not clean → error 409 `hermes_not_clean`. Clean → `manager.createUpdateSession({ agentId: "hermes", folder: checkout })`.
  - Others: `startSetupJob({ steps: [\`${agentId}-update\`] })`.
  - A running update job or `update` session for the same agent → 409 `update_running`.
- Routes:
  - `GET /api/updates` → `{ agents: AgentUpdateStatus[], hermes: { clean, reasons } }`;
  - `POST /api/updates/refresh` → the same shape after a refresh;
  - `POST /api/updates/:agentId` with `{ confirm: true }` → the start result. It requires confirm, as the safety route does. Unknown agent → 404.

- [ ] **Step 1: failing tests:**
  - an update for claude starts a job with exactly the step `claude-update`, and the fake records `claude update`;
  - openclaw's step argv is `update --json`;
  - no `updateArgs` contains `--yes` (keep the existing SP2 test green);
  - Hermes clean → an `update` session with argv exactly `["update"]` and cwd the checkout, and it accepts typed input: the fake updater (`tui-agent.mjs` mode `updater`) asks "Update now? [y/N] ", the test writes `y\r` through `manager.write`, and the fake prints "ANSWER y" and exits 0;
  - Hermes not clean → 409 `hermes_not_clean` and no session;
  - "a second update for the same agent is refused" → 409 `update_running`;
  - the Setup plan without `hermesClean` has no `hermes-update`; with it, `hermes-update` has `runsIn: "session"`;
  - `startSetupJob({ steps: ["hermes-update"] })` is refused;
  - codex under the bundled Node prefix runs with that `bin` first on PATH;
  - after a fake update ends, `list()` shows the new installed version;
  - an update while a fake session of that agent is live leaves the session's pid alive and its status unchanged.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `test/updates-*.test.js`, `test/setup.test.js` and `test/sessions-manager.test.js` → `# fail 0`.
- [ ] **Step 5:** commit `SP5 V3: one update service for Agents and Setup; Hermes updates in a session only when clean`.

### Task V4: Session versions and Restart session

**Files:**
- Modify:
  - `server/runtime/sessions/manager.js` (meta `agentVersion` at create and resume; `toSummary` adds it; new `restart(id)`);
  - `server/runtime/sessions/routes.js` (`POST /:id/restart`, same guards as Stop);
  - `src/types.ts` (`SessionSummary.agentVersion?: string | null`).
- Test: `test/sessions-restart.test.js`

**Interfaces:** `manager.restart(id): Promise<SessionSummary>` stops the session with the same sequence as Stop session, then calls the existing `resume(id)`. It writes nothing to the terminal. It throws 409 `resume_unavailable` (with the resume rule's own reason) before stopping anything when resume is unavailable, and 400 for an `update` session.

- [ ] **Step 1: failing tests:**
  - a new fake session's meta and summary carry `agentVersion` from the fake `--version`;
  - restart → the old pty exits, the same tab id resumes in the same folder with the agent's resume argv, and the fake recorded no input bytes;
  - "restart refuses without resume" → 409, and the session is still live;
  - restart of an `update` session → 400;
  - a session started before SP5 (meta without `agentVersion`) lists `agentVersion: null`.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** sessions tests → `# fail 0`.
- [ ] **Step 5:** commit `SP5 V4: sessions record their agent version; Restart session (stop, then resume, no keys)`.

### Task U1: Agents page Version block, Update, footer dot

**Files:**
- Create: `src/updatesApi.ts` (`getUpdates()`, `refreshUpdates()`, `startUpdate(agentId)` using `apiFetch` from `src/sessionKey.ts`)
- Modify:
  - `src/ui/components/AgentBay.tsx` (the Version block, around the `os-agent-version` section);
  - a new `src/ui/components/AgentUpdatePanel.tsx`;
  - `src/ui/Shell.tsx` (the footer dot in `.os-sidebar__footer`, linking to Agents);
  - CSS in the existing agents stylesheet, using existing tokens only.
- Probe: `.superpowers/ui-audit/probes/updates.mjs` (new; uses `tab.route` stubs like `agents.mjs`).

**Behaviour** (every sentence from "Sentences"):
- The Version block shows Installed and Latest, the state word and "Checked …", with "Check again" (`refreshUpdates`).
- "Update" shows for "available" and for Cursor's "unknown". It opens the confirm dialog, which lists open sessions of that agent and, for OpenClaw, the dry-run line and the Gateway line.
- After confirm:
  - a job: the existing job console (the one Setup uses, `role="log"`), polled until it ends, then refresh;
  - Hermes: the update session's terminal (the existing session terminal component and WebSocket) in place of the log, with its heading.
- Hermes not clean: no Update button; the reason lines and the 4-step guide instead.
- The footer dot shows when any agent is "available"; it has the tooltip and links to Agents. It is hidden in the public demo.

- [ ] **Step 1:** the probe with stubbed `/api/updates`: each state's words; Cursor's unknown sentence; the confirm dialog's lines (with and without open sessions, OpenClaw's two lines); the Hermes not-clean reasons and guide (no Update button); the footer dot on with one "available" and off with none; "Check again" posts refresh.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the probe passes; `agents.mjs`, `safety.mjs` and `sp3-pages.mjs` still pass; `npx tsc -b` exits 0; `npm run build` passes.
- [ ] **Step 5:** commit `SP5 U1: Agents Version block with checks and Update; footer update dot`.

### Task U2: Restart banners and Setup's Hermes step

**Files:**
- Modify: `src/ui/components/AgentUpdatePanel.tsx` (banners), `src/sessionsApi.ts` (`restartSession(id)`), the Setup update step component (the step list in `src/pages/SetupPage.tsx` or its step component)
- Probe: extend `updates.mjs`

**Behaviour:**
- For each live `agent` session of the agent whose `agentVersion` differs from the installed version, a banner shows "Restart session to use v{new}" with a "Restart session" button. It opens the confirm ("Restart {agent} in {folder}?", "The session closes and starts again on v{new}.", "Not now", "Restart session") and posts restart.
- When the session's resume is unavailable, the banner shows the unavailable sentence and no button.
- In Setup, the `hermes-update` step (present only when clean) starts the update through `startUpdate("hermes")` and embeds the session terminal, never a job log.

- [ ] **Step 1:** probe checks:
  - the banner for an older `agentVersion`;
  - none for an equal or null version;
  - the confirm's exact lines, with "Not now" closing it and posting nothing;
  - "Restart session" posting `/api/sessions/:id/restart`;
  - the unavailable sentence;
  - Setup's Hermes step showing the terminal heading.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** probes pass; `tsc` and build pass.
- [ ] **Step 5:** commit `SP5 U2: Restart session banners; Setup updates Hermes in a terminal`.

### Task E1: SP5 verification (orchestrator)

- [ ] Full suite: `env -u HERMES_HOME npm test 2>&1 | /usr/bin/grep -E '^# (tests|pass|fail|skipped)|^not ok|no-real-agents'` → `# fail 0`, `# skipped 4`, and the watcher line.
- [ ] Every probe passes (0 FAIL), including `updates.mjs`. `npx tsc -b` exits 0 and `npm run build` passes.
- [ ] A whole-branch review on the most capable model. Then one fix dispatch, if needed, and its re-review.
- [ ] The owner review of "Sentences" (one message, non-blocking).
- [ ] Batch the parked Minors from SP4 E2-F2/F3 (ledger) here too.

### Task E2: SP5 live checks on the owner's Mac (orchestrator; ask first, R41)

Ask once, naming each agent's current → latest version from `GET /api/updates`. Then run them in Agent OS, against a spike server like SP4's E2:
- **S5:** OpenClaw's Update. Record whether `openclaw update --json` asks a question without `--yes`. If it does, a follow-up moves OpenClaw to an `update` session like Hermes.
- **S6:** Cursor's Update (`agent update`), and whether any version check exists (`agent update --help`, `agent about`).
- **S8:** with a live session of that agent open, update it once per install method present:
  - Claude native;
  - Codex npm (Homebrew Node);
  - Cursor;
  - OpenClaw npm-global.

  Each time, record that the session process is untouched and the restart banner shows; then Restart session resumes with no keys pressed. A method that can't replace files under a running process is refused only while sessions are open (spec), via a follow-up.
- **Hermes:** the Version block shows "clean" on the owner's install. Update runs in the terminal only if the owner says yes; otherwise only the clean check is recorded.

Record the results in the spec's Appendix B ("SP5 spike results"). A difference from the fakes becomes a follow-up brief, as in SP4 E2 Step 15. Clean up afterwards: stop the spike server and run `cargo clean` if a build ran.
