# Agent OS: Cobalt redesign and real agent terminals

Status: design approved by the owner, with visuals, on 2026-10-11. Revised the same day with owner decisions D10 to D14, the Harness fidelity rules H1 to H9, and fixes for all 36 review findings (each traced in Appendix A). Revised again after a consistency check: 20 gaps and 11 contradictions fixed (each traced in Appendix A2).
Visual source of truth: the clickable prototype (see "References"). Where this document differs from the prototype on purpose, it says so and names the decision.

## In plain words

Agent OS gets a new look ("Cobalt Instrument") and a new heart.

**The new heart is the Sessions page.** You work with Claude Code, Codex, Cursor, Hermes and OpenClaw inside Agent OS using each agent's real terminal program, unchanged. It is your own installed copy, started with your own sign-in, settings, plugins, mods, skills, MCP servers, hooks and status line, exactly as in Terminal. Your keys, slash commands and shortcuts keep working, and new features appear as soon as you update the agent.

Around that real terminal, Agent OS adds what a plain terminal cannot:
- an alert when any agent is waiting for you;
- tabs and side-by-side split;
- a panel of files changed, with one-click hand-off to another agent;
- "plan ran out, keep going on OpenRouter";
- recordings you can replay;
- sessions that keep running when the window closes (on macOS);
- one-click updates for every agent;
- a Stop that always ends the agent's terminal program and everything it started on this computer (OpenClaw's work runs in its separate Gateway, so there Stop also asks the Gateway to stop, and tells you honestly when it cannot confirm that the work ended);
- "Hold to stop all" for every session and run.

Nothing is ever answered for you, and no agent ever starts with its safety switched off. Agent OS adds only small, watch-only pieces to how an agent starts (H3). The only things it takes away are its own private settings and the markers that would make an agent think it runs inside another agent (H2). Where it has to take a setting's place, it hands back your own: its status line helper prints your own status line exactly as you have it (H6), and Codex's notification option is set so that Agent OS can see when Codex is waiting.

One honest limit: features that exist only in a vendor's desktop app or editor (for example the Claude desktop app's Code tab or the Cursor editor) are not part of a terminal program, so they are not in Agent OS.

## References

- Clickable prototype, the visual source of truth for every page and state:
  `~/MediaStudio/runs/2026-10-10-agent-os-redesign/prototype/`.
  - Serve it with `python3 -m http.server 4610 --bind 127.0.0.1` from that folder.
  - Screenshots are in `prototype/shots/`; conventions are in `prototype/CONVENTIONS.md`.
  - Tokens, icons, logo and sample data are in `prototype/shared/`.
- Concept boards (the direction choice): `~/MediaStudio/runs/2026-10-10-agent-os-redesign/{cobalt,tower,manual}/`.
- Research notes: the session scratchpad `research-terminals.md`. Its key facts are copied into this document where they matter.
- Prior plan: `~/.claude/plans/jaunty-floating-conway.md` (Parts A2/A3/A5 brains and install already built on this branch).
- Review inputs, both in the session scratchpad: the orchestrator's revision list `specs/spec-revisions.md` (decisions D10 to D14, H1 to H9 and technical resolutions C1 to C26) and the three-lens review `tasks/w4jbs0v9t.output` (36 findings). Appendix A maps every finding to the section that resolves it; Appendix A2 does the same for the later consistency check.

## Decisions (all approved by the owner)

| # | Decision |
|---|---|
| D1 | Direction **Cobalt Instrument**, dark only for now. |
| D2 | Logo **Orbit**: ring, five nodes, one lit and larger, ring cut around it. Refined version is in `prototype/shared/logo.svg`; app icon is `app-icon.svg`. |
| D3 | Each agent's **real interactive terminal** is the main view (not a chat UI, not ACP). |
| D4 | All four extras: waiting-for-you alerts, tabs + split, changes panel + hand-off, plan ran out keep going. (The prototype's guide, block 4, names a different four: hand-off, separate copy, plan ran out and the OpenClaw approval card. All of them are built, in SP4.) |
| D5 | Sessions keep running when the window closes; they end (after asking) when Agent OS quits; conversations resume later. On Windows and Linux this work adds no tray, so closing the window quits after asking (SP3, Desktop shell changes). |
| D6 | When a second agent opens a folder that already has a live session, Agent OS **offers** a separate copy (git worktree) on a new branch `agentos/<agent>-<n>`. |
| D7 | One-click update per agent CLI, through each agent's own official updater (H7). Hermes with local changes gets explanation only. |
| D8 | Terminals live **in the engine** (Node server): node-pty + invisible screen copy + WebSocket (approach A). |
| D9 | Menu: Home, Sessions (new; replaces Chat), Agents, Runs, Team Room, Workspace, Setup, Safety; Chat moves to Labs (in SP1). |
| D10 | **Team Room asks first.** Agreement between agents never writes a file. An agreed file proposal becomes "needs approval" and the room pauses: its status is the existing `needs_you`, shown as "Paused for your decision" while a proposal waits, and its time limit does not run. Approve writes the file (Undo stays available) and the room continues taking turns; Reject is reported to the agents and the room continues. The "agreed, then finish the room" early exit is removed: a room ends only at its limits, by Stop or on a failure, and ends `agreed` only when it reaches its limit with an approved file saved and nothing still open. This replaces the 2026-09-24 rule "agents may save low-risk files alone". Details: SP2, Team Room. |
| D11 | **Hold to stop all** stops every session and every run. When the 1.2 s hold completes, everything stops at once (the hold is the confirmation, no second dialog), then a result toast shows counts and failures. It does **not** stop the Hermes background service or the OpenClaw Gateway; each has its own Stop on Agents, and no UI copy may claim that the hold stops them. `StopAllRunsModal` stays only for the ⌘K "Stop all runs" action. |
| D12 | **Folder policy for sessions.** Any real directory under the user's HOME, never HOME itself, never AGENT_OS_HOME except `AGENT_OS_HOME/worktrees/`. Chosen with the native folder picker, from recent folders, or (browser mode) as a typed absolute path that the server validates. Sessions do not use the runs sandbox (`resolveRunCwd`); runs stay sandboxed as today. Inside that folder the agent asks its own permissions, exactly as in Terminal. Details: SP3, Folder policy. |
| D13 | **Icon rail kept** at ≤1366 px (W17, owner-approved). This deviates from the prototype pictures, which show the full 228 px sidebar at 1280 px. SP1 and SP2 comparisons at 1280 px are judged with the rail. |
| D14 | **Harness fidelity.** The owner's intent (condensed): "it should be the real Claude Code harness including all the Claude Code features ... Claude mods ... the real tools ... same with Codex, Cursor, Hermes and OpenClaw". The rules are in the next section. |

## Harness fidelity (hard rules)

These rules decide how every agent is started. Every launch profile, environment and setting in this document follows them, and tests check them (H3).

**H1 The user's own binary and config.**
- Run the user's installed binary (path from `server/runtime/agents/detect.js`) with the user's real HOME and config folders.
- Never set or override `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `HERMES_HOME`, or OpenClaw's state or profile variables. Tests use temp homes; the product never does.
- So everything the user has is loaded: login, settings, CLAUDE.md / AGENTS.md, plugins, mods, skills, MCP servers, their own hooks, statusLine, keybindings and themes.

**H2 Environment = the user's login-shell environment**, as Terminal.app gives it.
- Resolve it once at server start (VS Code's pattern): run `$SHELL -ilc` and print `env` between unique markers; 10 s timeout; cache the result. On failure, use the server's own environment plus the usual PATH additions, and show a quiet one-line notice on the Sessions page. On Windows there is no login shell, so the process environment is used as it is.
- Then remove ONLY:
  - Agent OS's own variables: `AGENT_OS_*` and `HERMES_AGENT_OS_*` (including `AGENT_OS_TOKEN` and `HERMES_AGENT_OS_ADMIN_TOKEN`), except the session variables set below;
  - nested-session markers: the names only a host agent sets for the programs it starts, which would make an agent think it runs inside another one or hand it the host's private channel. They are removed from every session, wherever the server runs: 25 Claude Code names (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, the host and session ids, the messaging socket and token, and the like) and 7 Cursor names (`CURSOR_AGENT`, `CURSOR_INVOKED_AS`, `CURSOR_ASKPASS_*`, and the like), found in spikes S6 and S7 and listed as `NESTED_MARKERS` in `server/runtime/sessions/shell-env.js`. A name a person might set in their own startup files (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CONFIG_DIR`, `CURSOR_RIPGREP_PATH`, ...) is not on the list. Codex's markers are not known yet (spike S3's check is still open), so a server started inside Codex hands its names on;
  - only when the Agent OS server itself runs inside Claude Code (its environment has `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION`) or Cursor (`CURSOR_AGENT`), for example started with `npm run desktop:dev` in that agent's terminal, or with macOS `open` from there: that host's own names from the marker list above and every other name starting with `CLAUDE` (Claude Code host) or `CURSOR_` (Cursor host) are left out of every environment Agent OS builds from the server's own (the login shell's input, the fallback and Windows), before anything is read from it; the server's own environment is not changed. A Dock launch or a plain Terminal is not nested, and nothing more is removed. The login shell is not given these names, so only the person's own startup files can put one back (one edge: a value set only with `launchctl setenv` is lost when the server is nested). On the fallback path and on Windows no startup file runs, so the family is dropped there too, except `CLAUDE_CONFIG_DIR` (H1: a Claude session must keep the person's account folder) and `CLAUDE_CODE_GIT_BASH_PATH` (Claude Code on Windows cannot find its Git Bash without it). The trade-off: a `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` that the person set only in the operating system's environment is lost there when the server is nested, but keeping the family would pass on settings such as `CLAUDE_CODE_SIMPLE`, which would start every session in `--bare` mode (H3).
- Then set, for every session: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=AgentOS`, `TERM_PROGRAM_VERSION` (the Agent OS version), `AGENT_OS_SESSION_ID`.
- From SP4, and for Claude Code sessions only, also set `AGENT_OS_HOOK_URL` and `AGENT_OS_HOOK_TOKEN`: Claude Code is the only agent that runs Agent OS hooks (SP4, Signals), so no other agent's environment carries a hook token, and in SP3 no session does.
- `CLAUDE_CODE_NO_FLICKER=1` is added only when the user turned on the H4 setting. Never fake `TERM_PROGRAM=vscode`.
- Do NOT set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`: it would strip credentials from the user's MCP servers and Bash tool, which changes the harness. The risk it would cover (the hook token is readable by the agent's tools) is handled by "Hook events are hints" (SP4). On an OpenRouter or Local brain, `buildClaudeSettings` puts this variable in the settings `env` block; sessions drop it from that block (headless runs keep it as today).
- Everything else the user has passes through unchanged, for example `SHELL`, `EDITOR`, `VISUAL`, `SSH_AUTH_SOCK`, `LANG` / `LC_*`, proxy variables and provider keys such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

**H3 Only additive launch options.**
- Allowed additions:
  - Claude Code: `--session-id`, and `--settings` with ONLY the observe-only hooks and the statusLine wrapper (from SP4), plus the brain keys (`apiKeyHelper` and `env` from `buildClaudeSettings`) when the user picked an OpenRouter or Local brain. `--settings` is passed only when the file has something to carry: in SP3 only with an OpenRouter or Local brain, from SP4 always;
  - Codex: `-C <folder>`, `-c tui.notification*` options only, plus `codexBrainArgs` when a non-Plan brain is chosen;
  - Cursor: `--workspace`, and its own `--resume <chat id>` when resuming and also at a new session's start (below); a new session first runs `agent create-chat` once (spike S6);
  - Hermes: `--in <folder>`;
  - OpenClaw: `--session <key>`;
  - for every agent, its own resume option when resuming (SP3, Resume per agent). A new Cursor session uses Cursor's `--resume <chat id>` too, with the id from `create-chat` (Launch profiles), so no new kind of option is added.
- Never: `--bare`, `--disable-slash-commands`, `--strict-mcp-config`, an `--mcp-config` that replaces the user's, `disableAllHooks`, any permission-bypass, yolo, dangerous, full-access or trust-bypass flag, `--accept-hooks`.
- Never a write to an agent's own config files (H1). This is why Hermes and Cursor get no Agent OS hooks: their hooks live in the user's own config (for Hermes, with consent stored in `~/.hermes/shell-hooks-allowlist.json`). An opt-in Hermes hook entry is a later improvement that needs the owner's approval first (SP4, Signals).
- A profile snapshot test asserts each agent's argv and environment against this list and H2, with separate expectations for SP3 (no hook variables; `--settings` only with an OpenRouter or Local brain) and SP4 (hook variables and `--settings` for Claude Code only), each with the H4 opt-in off and on.

**H4 No forced display mode.**
- Do not set `CLAUDE_CODE_NO_FLICKER` by default; the user's own Claude setting decides.
- Session settings (SP3) have an opt-in "Use Claude Code's fullscreen view in Agent OS (recommended)", off by default. The server stores it (SP3, Browser terminal) and `profiles.js` reads it at each launch, so it applies to sessions started or resumed after the change; open sessions keep how they started.
- Hermes starts with the user's configured interface: `hermes --in <folder>`, never a forced `--tui`.

**H5 Agent OS hooks never slow or change the agent.**
- The hook endpoint replies 204 at once (target under 50 ms) and does its work afterwards; the hook timeout is 3 s.
- If Agent OS is down, the hook fails fast and the agent continues unchanged.
- Hooks never return a decision.

**H6 The statusLine wrapper is transparent.**
- It runs the user's own statusLine command with the same stdin and prints its output byte for byte (claude-hud looks exactly the same).
- If the user has none, it prints nothing.
- It forwards a copy of the JSON to `POST /hooks/sessions/:id/status`.

**H7 Updates use each agent's own official updater** (SP5). New features (for example Claude Mods in Claude Code 2.1.287 and later) arrive through them. Nothing in Agent OS pins or downgrades an agent.

**H8 Honest limit.** Agent OS hosts each vendor's TERMINAL program. Features that exist only in a vendor's desktop app or IDE (the Claude desktop app's Code tab, Svg mods, the Codex desktop app, the Cursor IDE) are not part of a terminal and so are not in Agent OS. The UI says this once, on the Agents page, under "What works here" (added in SP3).

**H9 Fidelity spike S0** (on the owner's Mac, ask first; a gate for "SP3 done"). In an Agent OS session, check that each item works the same as in Terminal.app:
- Claude Code:
  - slash commands, including /help /model /mcp /plugins /hooks /resume /agents /mods (if present after updating);
  - the user's MCP servers connect;
  - skills and plugins load;
  - mods (after updating to 2.1.287 or later);
  - the user's own hooks fire;
  - claude-hud shows;
  - CLAUDE.md is loaded;
  - native permission prompts;
  - Shift+Enter or Ctrl+J;
  - mouse;
  - copy and paste;
  - /bg.
- Codex: /model, approvals, MCP, resume.
- Cursor: basic flow and models.
- Hermes: chat, tools, its own hooks.
- OpenClaw: tui, approvals.
- Record the results in Appendix B when the spike runs.
- The other spikes (S1 to S8) are listed with their gates in "Testing and verification". Each sub-project's "done when" names every spike gated on it. Until a spike has run, the code uses the safe default written next to the feature it decides (for example OpenClaw hides Folder, and Stop falls back to killing the TUI with the honest message).

## Goals and non-goals

**Goals:**
1. A first-time viewer does not see "AI-generated template" anywhere in the 8 core pages.
2. A user of any of the five agents can open a session and use it exactly like their own terminal, with their own installed agent and everything it loads (Harness fidelity). For Claude Code that means typing, slash commands, Esc, Shift+Enter or Ctrl+J, permission prompts, `/resume`, MCP servers, skills, plugins, mods, their own hooks and their statusLine.
3. Every alert comes from a real signal the agent sends. When an agent has no reliable signal, it is labelled "basic".
4. Stop always ends the agent's terminal process and every process it started on this computer. Where an agent's work continues in a separate service (the OpenClaw Gateway), Stop asks that service to abort, and says so honestly when it cannot confirm the work ended (SP3, Stop sequence).

**Non-goals for this work:**
- a light theme;
- the Agent Computer (v0.5);
- the full Approvals Inbox and Jev triage (v0.6);
- automatic merge of worktrees;
- auto-approving anything;
- ACP views;
- features that exist only in vendors' desktop apps or IDEs (H8);
- an automatic continue of held runs when a plan resets;
- a tray icon on Windows and Linux;
- Windows/Linux UI polish beyond "works and doesn't overflow" (macOS is the primary target; Windows and Linux must build, start sessions and stop them).

## Build order (five sub-projects)

Each sub-project gets its own implementation plan and its own local commits. Earlier parts must not depend on later ones: wherever an earlier part shows something a later part fills, it shows a designed placeholder, listed under "Placeholders until later" in that part.

1. **SP1 Design system and shell**: tokens, fonts, logo and icons, shell (menu, top bar, footer), palette, state components, the Sessions placeholder page, and Chat moved to Labs. At the end the app looks new everywhere the shell reaches, and every page still works.
2. **SP2 Core pages**: Home (Orbit), Agents, Runs (bays, New run, recordings tab placeholder), Team Room (with the D10 server change), Workspace (ported off the legacy system, with provenance), Setup, Safety (levels + pending approvals).
3. **SP3 Sessions engine and page**: the no-real-agents watcher first; real terminals for all five agents under the Harness fidelity rules; folder policy; persistence and reattach; desktop shell changes; recording; Stop; security; Home's New session; the "How it works" help page. Gates: fidelity spike S0 and the SP3 parts of spikes S2 to S7 (Testing and verification).
4. **SP4 Session extras**: signals per agent, alerts everywhere, split, changes panel + hand-off, worktree offer, plan ran out keep going, OpenClaw approvals, recording replay.
5. **SP5 Agent updates**: version checks, one update service for Setup and Agents, the restart banner, Hermes protection, UI on Agents. SP5 depends on SP3, because the Hermes update runs in a real session terminal.

The README update (paused v0.4.0 step 2) comes after SP5, with new screenshots.

---

## SP1 Design system and shell

**Tokens.**
- Copy only section 1 (TOKENS) of `prototype/shared/cobalt.css` into `src/ui/tokens.css`. The rest of cobalt.css (components) is not copied; components are rebuilt in React/CSS in SP1 and SP2.
- Keep the existing `--os-*` names where a role already has one, so components keep working; only the values change. Add `--os-*` names for roles that have none.
- Every reference to a removed token is replaced in the same commit.

Old name to new role (values from cobalt.css):

| Existing name | Cobalt role | New value |
|---|---|---|
| `--os-bg-0` | canvas | #0C0E12 |
| `--os-bg-1` | side (menu ground) | #0F1217 |
| `--os-surface-1` | surface-1 | #13161C |
| `--os-surface-2` | surface-2 | #1A1E26 |
| `--os-surface-3` | surface-3 | #212631 |
| `--os-line-1` | hair (dividers) | #262B35 |
| `--os-line-2` | hair-2 (stronger dividers, button edge) | #333A47 |
| `--os-line-3` | edge (input and segment borders, ≥ 3:1) | #5A6475 |
| `--os-text-1` | ink | #E6E9EF |
| `--os-text-2` | ink-soft | #9AA3B2 |
| `--os-text-3` | ink-faint | #7F8899 |
| `--os-unknown` | ink-faint | #7F8899 |
| `--os-accent` | accent (cobalt) | #3866EE |
| `--os-accent-strong` | accent-text (small cobalt text) | #7DA0FF |
| `--os-accent-soft` | accent-wash | rgba(56,102,238,.12) |
| `--os-accent-ink` | accent-ink | #FFFFFF |
| `--os-ok` | ready | #5FBF8F |
| `--os-warn` | attention | #E3B04B |
| `--os-danger` | failed | #E5675F |
| `--os-font-ui` | ui | "Archivo Variable", system-ui, sans-serif |
| `--os-font-mono` | mono | unchanged ("JetBrains Mono Variable") |
| `--os-r-sm` / `--os-r-md` / `--os-r-lg` | r1 / r2 / r3 | 6 / 10 / 14 px (unchanged) |
| `--os-r-xl`, `--os-r-pill` | no Cobalt role | unchanged |
| `--os-e1` / `--os-e2` / `--os-e3` | e1 / e2 / e3 | the cobalt.css values (neutral shadows, never coloured) |
| `--os-ease-out` | ease | cubic-bezier(0.23,1,0.32,1) |
| `--os-dur-quick` | UI motion | 140 ms (unchanged) |
| `--os-dur-base` | UI motion | 200 ms (was 220 ms) |
| `--os-dur-slow` | clamped | 200 ms (was 360 ms) |
| `--os-dur-instant` | clamped | 120 ms (was 80 ms; no references outside tokens.css) |

Removed, with every reference replaced in the same commit:
- `--os-glow` (modelPicker, brain, safety, updateBanner, builders, teamRoom and setup CSS): use the focus ring or `--os-e2`;
- `--os-glass-bg` and `--os-glass-blur` (palette, updateBanner, agents, runs and setup CSS): use `--os-surface-2` with `--os-e3`, no blur;
- `--os-dur-deliberate` (`onboarding.css`, `src/pages/FleetPage.tsx`): use `--os-dur-base`;
- `--os-ease-pulse` (`base.css`): use `--os-ease-out`;
- `--os-ease-inout` (no references outside tokens.css).

New names to add:
- `--os-disabled` #6A7282;
- `--os-accent-hover` #3E6CF2, `--os-accent-press` #2D58D8, `--os-accent-line` rgba(125,160,255,.38);
- status washes and lines: `--os-ok-wash` / `--os-ok-line`, `--os-warn-wash` / `--os-warn-line`, `--os-danger-wash` / `--os-danger-line`, with the cobalt.css ready, attention and failed wash and line values;
- the type sizes the prototype uses and the scale lacks: `--os-fs-15`, `--os-fs-17`, `--os-fs-26`, `--os-fs-34`;
- spacing: `--os-sp-48` (48 px) and `--os-sp-64` (64 px), with compact-density values about a fifth smaller (38 and 51 px), like the others;
- layout: `--os-side-w` 228 px, `--os-topbar-h` 56 px;
- terminal: `--os-term-bg`, `--os-term-fg`, `--os-term-cursor`, `--os-term-select`, and `--os-ansi-0` to `--os-ansi-15`.

Spacing: keep every `--os-sp-N` value unchanged (4, 8, 12, 16, 20, 24, 32, 40, 56, 72 px) and its compact-density value. The prototype's numerals mean different sizes, so convert when building from it:

| Prototype | Agent OS |
|---|---|
| `--sp-1` to `--sp-6` (4 to 24 px) | `--os-sp-1` to `--os-sp-6` |
| `--sp-8` (32 px) | `--os-sp-7` |
| `--sp-10` (40 px) | `--os-sp-8` |
| `--sp-12` (48 px) | `--os-sp-48` (new) |
| `--sp-16` (64 px) | `--os-sp-64` (new) |

House rules:
- Status is always shown as an icon plus a word.
- Spacing uses the 4 px scale; there are three elevations.
- Motion: 120–200 ms for UI, `cubic-bezier(0.23,1,0.32,1)`, everything off under `prefers-reduced-motion`.
- Remove the teal accent, the decorative glows (`.os-shell::before`) and the noise grain (`.os-shell::after`); the prototype has neither.

**Fonts.**
- Archivo (variable, with the `wdth` axis; headings at 87.5 % width) for the UI; JetBrains Mono for data and terminals only.
- Bundle them with `@fontsource-variable/archivo` (new dependency) and the existing `@fontsource-variable/jetbrains-mono`.
- Remove `@fontsource-variable/inter`, and update `src/ui/fonts.ts`.

**Logo and icons.**
- `src/ui/Logo.tsx` renders the Orbit mark from `prototype/shared/logo.svg`. It replaces the "A" mark: `.os-logo-mark` in `src/ui/Shell.tsx` and `src/LockedScreen.tsx`, and `.mark` in `desktop/loading/index.html` (inline SVG there, because that page loads before the app).
- `desktop/icon-source.svg` comes from `prototype/shared/app-icon.svg`; regenerate the icons with `npx tauri icon desktop/icon-source.svg`.
- Add a favicon link in `index.html`.

**Shell** (`src/ui/Shell.tsx`, `src/ui/shell.css`). Match the prototype, except for the icon rail (D13):
- **Menu:** the core order from D9, Setup "n of 4", collapsed Labs (Chat moves there in SP1 as "Dry-run chat", unchanged inside), and a footer "On this Mac · vX".
- **Top bar:** ⌘K search, safety level, "Waiting for you (n)" badge (hidden at 0), and "Hold to stop all" (D11). When the 1.2 s hold completes, Agent OS stops every run (and, from SP3, every session) at once with no second dialog, then shows a result toast with counts and any failures. `StopAllRunsModal` stays only behind the ⌘K "Stop all runs" action.
- Keep the 64 px icon rail from 901 to 1366 px (D13), the off-canvas menu at ≤900 px, density, the palette, and every existing aria and keyboard behaviour listed in the inventory below.

**Placeholders until later (SP1):**
- The Sessions menu item opens a designed placeholder page built in SP1 (no sample data); the menu's sessions count stays hidden until SP3.
- The "Waiting for you" badge stays hidden (n = 0) until SP4.
- The footer's update dot (an agent has an update; it links to Agents) stays hidden until SP5.

**Legacy CSS.** `styles.css`, `agent-os.css` and `phase2.css` stay for Labs only.
- Hidden dependency: `agent-os.css` reads `var(--line)` from `styles.css :root`.
- Core pages must not use `aos-*` classes after SP2.
- Do not delete legacy files in this work.

**Inventory constraints (do not break these).** From the frontend audit:
- ⌘K / Ctrl+K palette with its focus trap and focus restore (SP3 narrows the key to ⌘K on macOS and Ctrl+K elsewhere; inside a terminal only the app shortcuts in SP3 apply, and in browser mode the shortcuts a browser keeps for itself are not offered, SP3 App shortcuts);
- Escape closes the menu or rail and returns focus;
- `aria-current` on nav items;
- the rail tooltip `role="tooltip"`;
- `#os-get-started` focus target;
- `data-density` on `<html>`;
- `localStorage` keys `agentos.density` and `agentos.labsOpen`;
- 5 s status polling with `useInterval`, which pauses when the tab is hidden;
- modals labelled by `os-modal-title` / `os-setup-modal-title`;
- the ModelPicker focus filter relies on `offsetParent`, so no `position: fixed` controls inside it;
- `.os-run-console__transcript` and the setup log stay the scroll containers;
- the `test/release-config.test.js` window minimums 1024×640.

**SP1 done when:**
- `npm run build` and `npx tsc -b` are green and the full test suite passes;
- screenshots at 1280×720, 1470×956 and 1512×982 show the new shell on every page with no sideways scroll (the icon rail at 1280 px; the full 228 px sidebar at 1470 and 1512 px, D13);
- no reference to a removed token remains (a grep check);
- contrast is measured: body ≥ 4.5:1, controls ≥ 3:1;
- the keyboard path is verified;
- Hold to stop all stops fake runs with no dialog and shows the result toast.

## SP2 Core pages

Build each page to match its prototype page and states. Use real data from the existing APIs, never the prototype's sample data.
- "—" means unknown and "…" means loading.
- Empty, error and offline states are designed, not left blank.

| Page | Built from | Notes |
|---|---|---|
| Home (`FleetPage`) | `index.html` | Orbit hero: a connector is lit only while that agent has a session or run that is live (working); amber means waiting; idle, held and exited stay dim (activity states, SP3). Waiting-for-you strip, agent table (brain, status, last activity), recent activity. The primary "New session" button stays hidden until SP3, which makes it create sessions (dialog with agent and folder; the worktree offer comes in SP4). Replaces the 5/5 · 0/2 metric row. The Get started card stays until setup is complete. |
| Agents | `agents.html` | Rail grouped Operators / Builders (no letter tiles); version block (installed version only until SP5 adds checks and Update); brain card (existing `BuilderBrainCard` / `AgentBrainCard` restyled); safeguards; background service; links to the agents' own dashboards. The current launch panel is removed (runs start from Runs). Safeguard copy follows D11: the prototype's "or with Hold to stop all at the top" for the Hermes service and the OpenClaw Gateway becomes "Hold to stop all does not stop it". |
| Runs | `runs.html` | Board with bays: **Active**, whose empty state "No runs in the air" has a primary "New run" button. It opens the New run dialog (Task, Agent, Folder inside the Workspace sandbox, and the safety-level hint "A risky step ends the run as Held instead of going ahead") on the existing run launch API (`POST /api/agents/:id/runs`, with its non-empty prompt and confirm rules). The ⌘K "New run…" action opens this dialog (today it goes to Agents). **Held** (plan limit; "Keep going on OpenRouter" uses the existing `server/runtime/builders/continue.js`; "Wait for reset" keeps the run Held with "press Keep going after the reset", and there is no automatic continue). **Landed**. The second tab is Session recordings (filled in SP3 and SP4). Draw the strip's coloured tab as a shape, not a left border. |
| Team Room | `team-room.html` | Start form + room view (turn timeline, "Needs you: save this file?" card, limits, status "Paused for your decision" while a proposal waits). The D10 server change is described below the table. |
| Workspace | `workspace.html` | Port off `PageFrame`/`aos-*` onto the new system, on the same `/api/workspace` endpoints and the sandboxed preview iframe, plus: provenance per file ("Saved by" from the team-room actions log; "You" for files from `POST /api/workspace/files`; "Agent OS" for the seed), added to `listWorkspaceFiles` in `server/runtime/workspace.js`; a "Saved by agents" filter chip and the "n saved by agents" count; "Undo this save" on agent-saved files, which finds the room action for that path and calls the existing `POST /api/team-rooms/:id/actions/:aid/undo`; "Show in Finder" through the Tauri opener's reveal (hidden in browser mode; `tauri-plugin-opener` if needed, ask first); "Copy path". |
| Setup | `setup.html` | Step rail + panel; same jobs and endpoints; keep `role="log"` scroll-follow. Two safety changes come forward from SP5 now: (1) `--yes` is removed from the Hermes and OpenClaw `updateArgs` in `server/runtime/setup/recipes.js`, so no updater question is answered for the user (an update job's stdin stays empty, as today, so a question gets end of input, never an automatic yes; spike S5 checks whether OpenClaw asks any); (2) `server/runtime/setup/plan.js` no longer offers the Hermes update step at all, until SP5 brings the Hermes clean check. Its update steps move onto the one update service in SP5. |
| Safety | `safety.html` | One three-level control; arming phrase "ENABLE MACHINE CONTROL" and the 1 s countdown unchanged; safeguards table; Pending approvals (OpenClaw cards come in SP4; Codex and Claude waiting rows link to Sessions); the Hold to stop all section says it stops every session and every run, not the Hermes service or the OpenClaw Gateway (D11). The "How stopping works" link is added in SP3 with the help page. |

**Team Room server change (D10)** in `server/runtime/team-room/moderator.js` and `routes.js`:
1. **Agreement.** In `resolveAgreement`, an agreed file proposal always becomes `needs_approval` ("Both agents agree. Waiting for your approval.") and nothing is written, whether the execution gate is on or off. Agreed decision proposals (not files) keep today's behaviour: a "needs approval" card, and the room does not pause for them.
2. **Pause.** After that turn, the room's loop ends with the existing status `needs_you`, a new meta.json field `pausedFor` (the proposal id) and the reason "Paused for your decision: <agent>'s file <name> needs your approval." The UI shows "Paused for your decision" whenever `pausedFor` is set, and the plain `needs_you` wording otherwise. No new status value is added.
3. **The clock stops while paused.** When the room pauses, the time used so far is stored in a new meta.json field `clockUsedMs`. A resume after a decision continues the clock from it, so the pause never uses the room's time limit. Continue keeps today's rule (it restarts the clock).
4. **Decision.** `POST /api/team-rooms/:id/proposals/:pid` with approve or reject:
   - Approve writes the file through the existing `applyFileProposal` (Undo stays available). With the execution gate off it returns the existing 403 `execution_gate_off` ("Turn on the execution gate to let the room save files."); the proposal stays `needs_approval` and the room stays paused.
   - Reject is always recorded; nothing is written.
   - When the decided proposal is the one in `pausedFor`, the server clears `pausedFor` and resumes the room with the turns it has left (no extra turns, no Continue click), and the next turn's prompt tells the agents the decision. The room resumes only when Continue could (execution gate on, no other room running); otherwise the decision is recorded and the room stays `needs_you` with Continue offered.
   - A decision on a proposal the room is not paused on (the room ended, or Continue was used) works as today and never pauses or resumes the room.
5. **Continue.** `continueRoom` accepts a paused room, because its status is `needs_you`. It adds the extra turns, clears `pausedFor` and resumes; the proposal stays `needs_approval`, and its card can still be decided later.
6. **End.** The early exit "Both agents agreed and the file was saved" is removed. A room ends only through the existing paths: its turn or time limit, the cost cap, Stop, or a failure. At its turn or time limit it ends `agreed` when at least one file proposal was approved and saved and no proposal is open or `needs_approval`; otherwise it ends `needs_you` as today (Continue adds turns). Rooms stored as `agreed` before this change keep that status.

**Placeholders until later (SP2):**
- Home's waiting strip and Safety's waiting rows show their designed empty state until SP4.
- Home's "New session" and the Agents header's "Open session" / "New session" stay hidden until SP3.
- Runs' Session recordings tab shows a designed empty state until SP3.

**SP2 done when:**
- each page matches its prototype state screenshots side by side (reviewed by eye; at 1280 px judged with the icon rail, D13);
- moderator and route tests show that:
  - agreement alone never writes a file, with the execution gate on or off;
  - the room pauses as `needs_you` with `pausedFor` set, and its clock does not run while paused;
  - Approve writes the file and resumes the room; Reject writes nothing and resumes it; both are reported to the agents in the next turn;
  - Approve with the gate off returns 403 `execution_gate_off`, the proposal stays `needs_approval` and the room stays paused;
  - Continue accepts a paused room;
  - the room ends `agreed` only at its limit with an approved file saved and nothing open, and `needs_you` otherwise;
- the existing tests in `test/team-room.test.js` that expect saving on agreement or an early `agreed` end are rewritten for D10 (they fail as written): "room: Hermes proposes a file, OpenClaw agrees" (line 549), "security: a proposed file name cannot escape the room folder" (line 629), "security: with the gate off at agreement time" (line 704, its reason text changes), "files: a 7,000-character proposal" (line 1053), "security: a link planted where the file goes is refused" (line 1083, the write now happens on Approve), "security: Undo refuses when the file has been swapped for a link" (line 1110), "undo: restores the previous content" (line 1166), "routes: start, list, detail, SSE replay, decision cards" (line 1378, the room now pauses at the file proposal) and "end to end: the real server runs a Hermes + OpenClaw room" (lines 1550 to 1625);
- the Setup tests show that no `updateArgs` contains `--yes` and that the Setup plan offers no Hermes update step;
- a check (grep over `src/`) finds no UI copy that says Hold to stop all stops the Hermes service or the OpenClaw Gateway (D11);
- a workspace test covers provenance ("You", "Agent OS", Team Room) and Undo this save;
- the New run dialog starts a fake run through the existing API;
- the SP1 checks pass again.

## SP3 Sessions engine and page

**First task:** build `test/helpers/no-real-agents.js`. It polls `ps` during the test run and fails the test if a real `claude`, `codex`, `agent`, `hermes` or `openclaw` binary from outside the fakes folder starts. Every SP3 to SP5 test runs under it.

### Components (new: `server/runtime/sessions/`)

| File | Job |
|---|---|
| `shell-env.js` | The H2 environment: resolves the login-shell environment once at server start and caches it; removes and sets exactly the H2 variables. |
| `profiles.js` | Per-agent launch profile: command path (from `server/runtime/agents/detect.js`), argv (no shell; only H3 additions), environment (H2, plus the H4 opt-in read from the stored session settings at each launch), resume argv and session id source, Stop sequence. Also builds the `update` session kind (Session kinds). |
| `folders.js` | The folder policy (D12) and `GET /api/sessions/folders`. |
| `pty-host.js` | Wraps `node-pty` (exact pin `1.2.0-beta.14`): spawn, write, resize, exit. Registers each PTY's pid with the new `trackPid(pid, onExit)` / `untrackPid(pid)` in `server/runtime/process-tree.js`, so `killProcessTree` / `killAllTracked` include sessions. (`spawnTracked` wraps `child_process.spawn` only, so it cannot be used for node-pty.) |
| `mirror.js` | `@xterm/headless` terminal per session, same cols/rows; feeds every output chunk; `@xterm/addon-serialize` for reattach. Tracks the modes the serializer omits (the `modes` object below, including kitty keyboard flags, SGR-1006 mouse and DECSET ?2004 bracketed paste) and re-sends them on reattach. **Answers terminal queries only while no writer is attached** (see the protocol). Registers OSC 9 / 99 / 777 and BEL handlers (synchronous) and forwards them raw in SP3. |
| `recorder.js` | asciicast v2 recording per session in `<AGENT_OS_HOME>/sessions/<id>/`: **output events only, never input**. Two rotating segments of 25 MB each (`screen.cast` and the older `screen.prev.cast`); the oldest output is dropped first and an "[earlier output removed]" marker is written. A total cap of 1 GB across all recordings: the oldest ended recordings are deleted first, with a note in Runs. A resumed session appends to the same recording after a marker. `meta.json` holds kind, agent, folder, branch, times, exit, agent session id, whether its ended tab was dismissed, and (SP4) timeline markers. All files 0600. |
| `manager.js` | Create, list, get, attach, detach, write, resize, stop, resume, dismiss, quit-check. Limit 8 live `agent` sessions. An `agent` session is created only at safety level ≥ 1. Derives the activity state. Persists `meta.json`; on server start, marks any session still recorded as running as "ended (Agent OS quit)" with Resume available. |
| `ws.js` | WebSocket endpoint `/api/sessions/:id/attach` with the `ws` package (new dependency) and its own upgrade check (Security 1). |
| `routes.js` | REST: `GET /api/sessions` (with each session's kind and activity state), `POST /api/sessions` (agent sessions only), `GET /api/sessions/folders`, `GET` and `PUT /api/sessions/settings` (the stored session settings), `POST /api/sessions/quit-check`, `GET /api/sessions/:id`, `POST /api/sessions/:id/stop`, `POST /api/sessions/:id/resume`, `POST /api/sessions/:id/dismiss` (hides an ended tab), `GET /api/sessions/:id/recording`, `DELETE /api/sessions/:id/recording`, `GET /api/recordings`. The fixed paths are registered before `/:id`. |
| `hooks.js` (SP4) | `POST /hooks/sessions/:id` and `POST /hooks/sessions/:id/status` (SP4, Signals; used by Claude Code sessions only). |

Existing files that change in SP3: `server/runtime/process-tree.js` (Stop sequence), `server/runtime/shutdown.js` (hard exit 8 s; sessions in the shutdown path), `server/runtime/store.js` (folder modes), `server/index.js` (routes and `server.on('upgrade')`), `vite.config.ts` (`ws: true`), `package.json` (the `dev` script sets `AGENT_OS_DEV_ORIGIN=1`), `desktop/src-tauri/src/main.rs` and `desktop/src-tauri/capabilities/default.json` (Desktop shell changes), `src/ui/Shell.tsx` (palette key, Hold to stop all includes sessions), `src/pages/FleetPage.tsx` (New session), plus the new Sessions page.

### Session kinds

Every session has a `kind`, stored in meta.json and returned by `GET /api/sessions`.
- **`agent`** (the default): an agent's interactive terminal. Everything in SP3 to SP5 describes this kind unless it says otherwise.
- **`update`**: an agent updater that may ask questions (SP5 uses it for `hermes update`). It differs from `agent` sessions as follows:
  - Created only by the update service through `manager.js`, never by `POST /api/sessions` or the New session dialog.
  - argv: the detected `hermes` path with exactly `update` (no `--yes`, no other option, no H3 additions). Environment: H2, with `AGENT_OS_SESSION_ID` and never the hook variables. Working folder: the Hermes checkout that the clean check examined; it must pass the folder policy, otherwise no Update is offered.
  - Not gated by the safety level (Setup's update jobs are not gated today) and not counted toward the 8 live sessions; at most one `update` session runs at a time.
  - Not shown as a Sessions tab, in Home Orbit, in the menu's sessions count or in the waiting badge. Agents and Setup embed its terminal (the same browser terminal and WebSocket protocol) in place of the update log (SP5).
  - Recorded like any session (output only) and listed in Session recordings as "<agent> update".
  - Stopped by Stop (with the usual confirm), by Hold to stop all and by quitting Agent OS (the quit question names it). It is never resumed.
- Test (SP3): a fake updater started as an `update` session asks a question and receives the answer typed into its terminal; it is absent from the tabs, Orbit and the sessions count; Hold to stop all stops it.

### Folder policy (D12)

- **Allowed:** any real directory under the user's HOME. Never HOME itself. Never AGENT_OS_HOME or anything inside it, except `AGENT_OS_HOME/worktrees/`.
- Canonicalise with `fs.realpath.native` before checking (it returns the on-disk letter case on macOS and Windows; the plain JavaScript `fs.realpath` does not), so a symlink cannot escape (the resolved path must pass the rule). The folder must exist and be a directory.
- On macOS and Windows, where volumes usually ignore letter case, every comparison with HOME and AGENT_OS_HOME ignores letter case too, so `~/.HERMES-AGENT-OS/x` is still inside AGENT_OS_HOME. (The 0.3.2 security fix was exactly such a letter-case bypass.)
- **Chosen via:**
  - the native folder picker (`tauri-plugin-dialog`, new dependency, ask first);
  - recent folders from `GET /api/sessions/folders` (recent session folders from meta.json; the Agent OS workspace is not offered, because it is inside AGENT_OS_HOME, D12);
  - in browser mode, a typed absolute path that the server validates (a browser picker cannot return an absolute path).
- Sessions do NOT use `resolveRunCwd` (`server/runtime/agents/routes.js`). Runs stay sandboxed inside the workspace, as today.
- Inside the folder, the agent asks its own permissions exactly as in Terminal (H1).
- Tests: HOME refused; AGENT_OS_HOME refused except `worktrees/`; an upper-case variant of AGENT_OS_HOME and of HOME refused (with the case-insensitive comparison used on macOS and Windows); a symlink that escapes refused; a file refused; a missing path refused; a real folder under HOME accepted.

### Launch profiles (H3: additions only; never a skip-permission or bypass flag)

| Agent | Start | Notes |
|---|---|---|
| Claude Code | `claude --session-id <uuid>` in the chosen folder, plus `--settings <file>` when the file has something to carry (H3) | The settings file (`<AGENT_OS_HOME>/sessions/<id>/claude-settings.json`, 0600) carries only the observe-only hooks and the statusLine wrapper (both from SP4) and, for OpenRouter/Local brains, the brain keys from the existing `buildClaudeSettings` (without `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, H2). In SP3, `--settings` is passed only with an OpenRouter or Local brain and the file holds only the brain keys; from SP4 it is always passed. Reuse `assertSafeClaudeSettings`. `CLAUDE_CODE_NO_FLICKER=1` only with the H4 opt-in. |
| Codex | `codex -C <folder>` plus `-c tui.notification_method=osc9 -c 'tui.notifications=["agent-turn-complete","approval-requested"]' -c tui.notification_condition=always` | Keep the alternate screen (never `--no-alt-screen`). OpenRouter/Local via the existing `codexBrainArgs`. |
| Cursor | first `agent create-chat` (spike S6), run once in the chosen folder with the session's environment, 10 s limit; when it exits 0 and prints one v4 uuid: `agent --resume <chatId> --workspace <folder>`; on failure, garbage, exit 1 or no answer within the limit: `agent --workspace <folder>` as before | The chat id is kept as the session's id, so Resume reopens that chat (Resume per agent). `--resume` is Cursor's own resume option, so no new kind of option is added (H3). `create-chat` runs without a shell: on Windows, where Cursor's launcher can be a `.cmd` file, it fails and the start falls back. No model option is added (H3): the user picks models inside Cursor's own terminal, as in Terminal. The existing "Plan models only" rule applies to Cursor runs and the brain selector only, not to sessions. |
| Hermes | `hermes --in <folder>` | The user's configured interface (H4), never a forced `--tui`. Kill the whole process group (Python + Node). Never `--accept-hooks`, never `--yolo`. |
| OpenClaw | `openclaw tui --session agentos-<sessionId>`, spawned with the chosen folder as its working directory | Never `openclaw chat` / `terminal` (local mode needs exclusive state). Launch without `--url` / `--token`. The existing adapter ignores the chosen folder when the Gateway runs, so spike S5 (an SP3 gate) checks whether OpenClaw's work honours the folder. **Safe default until S5 has run, and the result if it does not:** the New session dialog hides Folder (and, from SP4, the separate-copy offer) for OpenClaw; the TUI then starts in the user's HOME, the one exception to the folder policy, because no folder is offered or claimed (the panel's folder reads "Set by OpenClaw"); its approval cards leave out the folder; and this is recorded as a deviation from the prototype. If S5 finds that a folder or workspace option is needed, adding it changes H3 and needs the owner's approval. |

### Resume per agent

| Agent | Session id or key | Resume command |
|---|---|---|
| Claude Code | the uuid Agent OS sets with `--session-id` | `claude --resume <uuid>`, plus `--settings <file>` under the same rule as at start |
| OpenClaw | key `agentos-<sessionId>`, set with `--session` | the same start command |
| Hermes | id from its session list (spike S4; Agent OS adds no Hermes hooks, H3) | `hermes -r <id> --in <folder>`. Until S4 confirms the id, the fallback is `hermes --resume latest --in <folder>`, used only under the rules below. |
| Codex | id captured at start (spike S3) | `codex resume <id>` in the same folder, with the same `-c` options. Until S3 confirms the id, the fallback is `codex resume --last`, used only under the rules below. |
| Cursor | chat id from `agent create-chat` at the session's start (spike S6) | `agent --resume <chatId> --workspace <folder>`. For a session that has no id (saved before this, or `create-chat` failed at its start), the fallback is `agent --resume --workspace <folder>`, which opens Cursor's chat picker (it lists the person's chats from every project); it is used only under the rules below. |

- **Fallback rules** (Hermes and Codex, until their spike confirms the id source, and a Cursor session that has no chat id):
  - Resume is disabled, with a written reason, when more than one ended session of that agent shares the folder, or while another session of that agent is live in that folder.
  - A conversation the user started outside Agent OS (for example in Terminal) in the same folder cannot be detected. So the confirm dialog of a fallback resume adds a warning: "This resumes the most recent <agent> conversation in this folder, which may be one you started outside Agent OS."
- Resume keeps the same Agent OS session id and tab, starts a new process, and appends to the same recording after a marker.
- SP3 builds and tests the resume API and ships the "Resume conversation" button on ended tabs and in Runs → Session recordings (Page layout), with the prototype's confirm (`runs.html`). SP4 adds the same button to the replay header, and SP5's Restart session uses the same rules.
- **Claude Code with nothing saved:** Claude Code saves a conversation only once something is sent (and deletes old ones itself), so `claude --resume <uuid>` for a session in which nothing was sent prints "No conversation found with session ID: <uuid>" and exits 1 at once (spike S7). When a resumed Claude run ends that way on its own (looked for in the first 16 KB of its output; not after Stop or a quit), the session is marked as having nothing to resume, its exited line says so (Session activity states), and Resume is disabled with the written reason "Claude Code has nothing saved for this conversation, so there is nothing to resume. Start a new session in this folder."
- Spikes S2 (Claude), S3 (Codex), S4 (Hermes id source) and S6 (Cursor chat id) are SP3 gates; a fallback above applies unless its spike found a better source. They ran on 2026-10-16 (Appendix B): S6 gave Cursor its chat id from `create-chat`; S3 and S4 found no id Agent OS can read at the start, so those fallbacks stay.

### Session activity states

`starting | live | waiting | idle | held | exited`, carried in `{t:"state"}` and in `GET /api/sessions`.

| State | Meaning |
|---|---|
| starting | the process is spawned, no output yet |
| live | the agent is working |
| waiting | the agent asks the user something (SP4) |
| idle | the turn is done, nothing runs |
| held | the plan limit was reached, with the reset time when known (SP4) |
| exited | the process ended (exit code and signal) |

Terms used by the transitions:
- **User input:** an `in` frame from the writer that is not only automatic replies. Frames made up entirely of terminal query replies (DA, DSR cursor position, kitty `CSI ? … u`, OSC colour replies), focus reports (`CSI I` / `CSI O`) or mouse-motion reports do not count; keystrokes, paste, clicks and the wheel do. Agent OS's own hand-off writes (SP4) are not user input.
- **Counted output:** output that changes the text of the mirror's screen (characters, not colours or the cursor) above its bottom 6 rows, or scrolls it. Output that changes only the bottom 6 rows (status lines such as claude-hud, an input box, footers, key hints) or nothing visible (cursor moves, title or mode changes, identical redraws) is not counted. The mirror checks this at most every 250 ms.
- **Turn-done session:** a session that has a turn_done source and has delivered its first signal (a hook event or an OSC 9 notification): Claude Code (its Stop hook) and Codex (OSC 9 agent-turn-complete), from SP4. Before its first signal (for example before the user trusts the folder in Claude), and for Hermes, Cursor and OpenClaw, which have no turn_done source, a session is **basic** and uses the 20 s rule. In SP3 every session is basic.

| From | To | When |
|---|---|---|
| starting | live | the first output of any kind, or user input |
| live | idle | turn-done session: a turn_done signal. Basic session: 20 s without counted output |
| idle | live | turn-done session: user input, or a hook that shows a new turn (Claude's UserPromptSubmit or PostToolUse(Edit\|Write)); never output alone. Basic session: counted output, or user input |
| starting, live, idle | waiting | a waiting or approval signal (SP4) |
| waiting | live | a resolved signal, or user input |
| any but exited | held | a limit confirmed by that agent's limit rule (SP4, "Limit rule per agent") |
| held | idle | the reset time passes, or Claude's statusLine `rate_limits` falls below 100 % |
| held | live | user input |
| any | exited | the process ends |

- Output alone (a redraw) never clears waiting or held, and never takes a turn-done session out of idle.
- If the user's own Claude auto-resume restarts work after a reset, the session leaves held when the reset time passes and becomes live on Claude's next prompt or tool hook.
- Home Orbit: lit only while live; amber for waiting; idle, held and exited stay dim.
- Tab markers: "Waiting for you" (waiting) and "Plan ran out" (held).
- The side panel's one-line text per state (waiting, idle and held follow the prototype's `info()` in `sessions.html`):
  - starting: "Starting <agent>…"
  - live: "Working. Agent OS alerts you when it asks you something." (SP3, before alerts exist: "Working."; for a basic session in SP4: "Working. Alerts for <agent> are basic.")
  - waiting: "The question is in the terminal. Agent OS never answers for you." (OpenClaw: "The question is in the card below.")
  - idle: "Idle for <time>. Nothing is running." or, right after a turn_done signal, "Ready for the next message."
  - held: "Plan limit reached. Resets <time>." (when the reset time is unknown: "Plan limit reached.")
  - exited (each line is followed by "The recording is in Runs."): exit code 0 "Ended normally."; another exit code "Ended with exit code <n>."; after the user's Stop "Stopped by you."; after a quit "Ended when Agent OS quit."; a Claude Code resume that found nothing saved (it printed that nothing was found and exited non-zero; see Resume per agent) "Claude Code found nothing saved for this conversation, so it couldn't be resumed." (instead of the exit code line); any other signal "Ended by signal <name>." (for example SIGKILL).
  - Before the user trusts the folder in Claude (SP4): "Alerts start after you trust this folder in Claude".

### WebSocket protocol (JSON text frames, one message per frame)

Each open socket on `/api/sessions/:id/attach` is one **attachment**. Any number of windows may attach to view; exactly one attachment is the **writer**.

- **Client to server:**
  - `{t:"focus"}` when this terminal gains focus: makes this attachment the writer (the previous writer becomes a viewer). The client sends `{t:"resize"}` right after it.
  - `{t:"in", d:"<utf8>"}` keystrokes, paste and the terminal's own automatic replies to terminal queries. Accepted only from the writer; dropped from viewers. At most 64 KB per frame.
  - `{t:"resize", cols, rows}` debounced at 50 ms. Applied only from the writer. cols 2–500, rows 1–200; anything else is ignored.
  - `{t:"ack", seq}` flow control: the `seq` this client has processed. Sent at least every 64 KB received.
- **Server to client:**
  - `{t:"snapshot", data, cols, rows, modes}` first, on attach, where `modes` = `{altScreen, bracketedPaste, mouseTracking, mouseEncoding, focusReporting, cursorKeysApp, kittyFlags}`;
  - `{t:"out", seq, d}` output, where `seq` is the cumulative UTF-8 byte count of all `d` sent to this attachment, counted from 0 after its snapshot;
  - `{t:"state", status, exitCode, signal, endedBy, resetAt}`, where status is an activity state; exitCode, signal and endedBy come only with exited (endedBy is `"stop"` or `"quit"` when Agent OS ended the session, otherwise null; the exited panel line uses it), resetAt only with held (when known);
  - `{t:"alert", raw}` in SP3 (the raw OSC payload, or `"bel"`). SP4 replaces it with `{t:"alert", kind, text}`.
- **Terminal queries:** exactly one emulator answers them. While a writer is attached, only the writer's browser terminal answers (its replies arrive as `in`; viewers' replies are dropped). While no writer is attached (window closed, D5), the mirror answers the standard queries (DA1, DSR cursor position, kitty `CSI ? u`), and it stops as soon as a writer attaches.
- **Back-pressure:** lag per attachment = bytes sent minus its last acked `seq`. Pause reading the PTY only when **every** open attachment lags more than 512 KB; resume when any one catches up. Never pause with zero attachments (the mirror and recorder keep draining). A closed attachment leaves the count at once. An attachment more than 4 MB behind is closed with a reason, and its client reattaches with a fresh snapshot.
- **Limits:** `ws` `maxPayload` 1 MB; an `in` frame over 64 KB is refused.

### Browser terminal (Sessions page)

- `@xterm/xterm` exact pin `6.1.0-beta.304`, with addons fit, unicode11, search, web-links (link schemes http, https, mailto only) and clipboard (OSC 52 write allowed, **read refused**).
- Options: `vtExtensions.kittyKeyboard` on by default, with a setting to turn it off for IME users; `scrollOnEraseInDisplay: true`; `allowProposedApi: true`.
- **Renderer:** DOM by default on macOS (WebGL glyph corruption reported in WKWebView/Tauri); WebGL as a setting, with a context-loss fallback to DOM.
- **Theme:** the Cobalt terminal theme (all 16 ANSI colours pass 4.5:1 on the terminal ground) from the `--os-term-*` and `--os-ansi-*` tokens. JetBrains Mono at 13 px.
- **Session settings:** a small settings menu in the Sessions page header holds the three terminal settings: kitty keyboard, WebGL renderer, and "Use Claude Code's fullscreen view in Agent OS (recommended)" (H4, off by default). The prototype has no settings menu; it is built from Cobalt components.
  - Kitty keyboard and WebGL only change the browser terminal, so they stay in the browser (`localStorage`).
  - The fullscreen opt-in changes how Claude Code starts, so the server stores it in `<AGENT_OS_HOME>/config/sessions.json` (`claudeFullscreen`, false by default; 0600), read and written through `GET` / `PUT /api/sessions/settings`. `profiles.js` reads it at each launch, so it applies to sessions started or resumed afterwards; the menu says "Applies to new sessions". The profile snapshot test covers it off and on.

**App shortcuts (precedence).**
- While a terminal has focus, only these keys are intercepted, through xterm's `attachCustomKeyEventHandler`: ⌘K, ⌘T, ⌘1–9 and ⌘\ on macOS; Ctrl+Shift+K/T/1–9/\ elsewhere. ⌘\ (split) arrives with SP4.
- Everything else goes to the PTY, including Ctrl+K and Ctrl+R.
- The Shell's palette handler (`src/ui/Shell.tsx`) uses `metaKey` on macOS and `ctrlKey` only elsewhere, and is skipped when the event comes from inside `.xterm`.
- There is no ⌘W. A live tab has no close control: a session ends with Stop. Only an ended tab can be dismissed (Page layout).
- The native menu stops stealing keys on Windows and Linux (Desktop shell changes).
- **Browser mode:** a browser keeps some shortcuts for itself and the page never sees them: ⌘T and ⌘1–9 on macOS, and Ctrl+T, Ctrl+1–9 and Ctrl+Shift+T elsewhere. In browser mode those shortcuts are not offered: the panel footer hides their hints, and New session and switching tabs stay reachable by the New session button, by clicking a tab and through the palette. The palette key (⌘K / Ctrl+K outside a terminal) works in both modes. The full list above applies in the desktop app.

**Page layout** matches `prototype/sessions.html`:
- Tabs with status markers; the terminal fills the rest; the side panel is 336 px wide (304 px at ≤1320 px).
- ⌘T (desktop app) or the New session button opens the New session dialog.
- **Ended sessions:** when a session exits, its tab turns into "Ended · open recording" and stays until dismissed with its "Dismiss" control (×). Dismissing only hides the tab (`POST /api/sessions/:id/dismiss`, stored in meta.json); the recording and Resume stay in Runs. Tabs of sessions ended by an Agent OS quit come back after a restart until dismissed. Selecting an ended tab shows the side panel in the exited state with two buttons:
  - "Resume conversation" (Resume per agent; disabled with the written reason when its rules say so);
  - "Open recording", which opens Runs → Session recordings with that row highlighted.
- Empty state (no sessions): New session, and a link "How a session works" to the help page.
- Split view comes in SP4 (SP3 ships tabs).

**Side panel** (sections in prototype order):

| Section | Field | Source | Ships in |
|---|---|---|---|
| Header | folder, and branch (or "Separate copy of <folder> (a git worktree)") | meta.json, git | SP3 (copies: SP4) |
| Header | agent, status and the one-line text for the state | profile, activity state | SP3 |
| Live meter | Brain | launch profile | SP3 |
| Live meter | Model | launch profile; Claude's statusLine when present | SP4 |
| Live meter | Running for | meta.json start time | SP3 |
| Live meter | Context used | Claude's statusLine (context %) | SP4 |
| Live meter | Plan used · 5-hour limit (plan brains) | Claude's statusLine `rate_limits` | SP4 |
| Live meter | Cost so far (OpenRouter brains) | Claude's statusLine cost | SP4 |
| Files changed | files with +/− | changes panel | SP4 |
| Hand-off | the typed hand-off note | hand-off | SP4 |
| Footer | Recorded, Stop session, shortcut hints | | SP3 |

- Every Live meter row is shown from SP3. Any field with no source, including the rows whose source arrives in SP4, shows "—", and the Live meter shows the hint "— means unknown". For agents without a statusLine, most of the meter stays "—".
- Meters warn at ≥ 70 % and are critical at 100 %, with the reset time ("Resets 2:21 am").

### Persistence, quit and Stop

- **Closing the window:**
  - macOS: the window hides and sessions keep running. A Dock click (`RunEvent::Reopen`) or the app menu shows it again.
  - Windows and Linux: closing the window quits Agent OS (no tray in this work), so it follows the quit steps below, including the question when sessions are live.
  - Browser mode: closing the tab only detaches; the server keeps running.
- **Reopening** attaches every live session, and the snapshot restores the screen and modes.
- **Quitting Agent OS** (⌘Q or the Quit menu item, Exit, closing the window on Windows/Linux, or a termination signal to the app):
  1. the desktop shell prevents the exit and tells the UI through a Tauri event;
  2. the UI calls `POST /api/sessions/quit-check` (the live sessions and their names) and, if any session is live, asks first, naming them; Cancel keeps everything running;
  3. on Quit, the server writes "ended (Agent OS quit)" into every live session's meta.json **before any kill**, stops all sessions in parallel (Stop sequence below), and shuts down;
  4. their records stay, with Resume.
  - If no window is loaded to ask, the quit continues from step 3.
  - The server on its own (`npm start`, then SIGTERM or SIGINT) has no UI to ask: steps 3 and 4.
  - Timing: the server's hard exit rises from 3 s to 8 s (`server/runtime/shutdown.js`), and Tauri's `QUIT_GRACE` from 5 s to 10 s (`main.rs`). The budget inside the 8 s: all sessions stop in parallel; each session's soft stop (step 1 below, every CLI call it makes included) has a hard 2 s timeout; then the 3 s kill grace. Worst case about 5 to 6 s, even when an agent's CLI hangs.
- **Stop sequence per session** (it never writes into the PTY; Stop, Hold to stop all and quit all use it):
  1. the agent's own soft stop, with a hard 2 s timeout for the whole step: when it runs out, the CLI calls it started are killed and the sequence moves on to step 2.
     - OpenClaw: abort the session's Gateway work through OpenClaw's CLI or Gateway RPC (`sessions.abort` / `chat.abort`; the exact argv comes from spike S5, an SP3 gate). Until S5 has run, or if the abort is not available or times out, kill the TUI and say honestly: "Stopped the terminal. OpenClaw may still be finishing its last step."
     - Claude Code: check `claude agents --json` for this session's id or pid with kind background (it moved to Claude's own background with `/bg`); if found, run `claude stop <id>`.
     - The other agents and `update` sessions have no soft stop.
  2. then `killProcessTree(pid, { graceMs: 3000 })`;
  3. Windows uses the existing tree kill.
- **process-tree.js changes:** add `trackPid(pid, onExit)` / `untrackPid(pid)` (used by `pty-host.js`). `killProcessTree` takes a list of descendants (a ppid walk) **before** signalling, signals the process group and every descendant, then sends SIGKILL to survivors after the grace period. This catches tools that call `setsid` or `setpgid`.
- **Stop session** in the UI asks first, with the prototype's dialog (`sessions.html`, `stopDialog()`): title "Stop <agent> · <folder>?", "This ends <agent> in this tab. The recording stays in Runs.", buttons "Keep it running" and "Stop session".
- **Hold to stop all** (D11): stops all sessions (both kinds) and all runs at once (no dialog), then one result toast with counts and failures. It does not stop the Hermes service or the OpenClaw Gateway: it never calls their service controls (`adapter.service`, `POST /api/agents/:id/service/:action`).

### Desktop shell changes (`desktop/src-tauri/src/main.rs`)

- **macOS:** `WindowEvent::CloseRequested` calls `api.prevent_close()` and hides the window (today it calls `kill_server`). `RunEvent::Reopen` and the app menu show it again.
- **Windows/Linux:** closing the window means quit, with the confirm when sessions are live (no tray in this work).
- **Quit** (⌘Q, Exit, signal): prevent the exit, emit an event the UI listens to, and run `kill_server` only after the UI's answer (or at once when no window is loaded). The exact plumbing (event name, how the UI confirms, the capability permission it needs) is fixed in the SP3 plan; it is the riskiest part of D5 and is listed under Risks.
- Raise `QUIT_GRACE` to 10 s (the server's hard exit is 8 s).
- Add `tauri-plugin-notification` (crate, `@tauri-apps/plugin-notification`, and `notification:default` under the `remote` capability) for SP4's desktop notifications. In browser mode, in-app toasts only.
  - **The Rust shell raises the notifications, not the page,** so they arrive while the window is hidden (D5), when the hidden page may be throttled or suspended. When started by the shell (`AGENT_OS_PACKAGED=1`), the server prints one line per alert on stdout, `AGENT_OS_ALERT:<json>` (session id, agent, kind and the short alert text only). The shell already reads the server's stdout for `AGENT_OS_READY:<port>`; it shows the notification when the window is hidden or not focused.
  - The page uses `@tauri-apps/plugin-notification` only to ask for permission once, with an explanation.
- Add `tauri-plugin-dialog` for the folder picker (D12).
- On Windows and Linux, remove or rebind the View menu's `CmdOrCtrl+R` reload and the accelerators of the predefined Edit items (undo, redo, cut, copy, paste, select all), so Ctrl+R, Ctrl+Z, Ctrl+C, Ctrl+V and Ctrl+A reach the agent. macOS keeps them on ⌘.
- Update the description in `capabilities/default.json`: the UI now uses Tauri IPC for quit, notifications and the folder picker.

### Security (must hold; each item gets a test)

1. **WebSocket upgrade:** its own check in `server.on('upgrade')`. Express middleware does not run on upgrades, and `originCheckMiddleware` is NOT reused (it lets GET and missing-Origin requests through and compares only the hostname, so any local port would pass).
   - Host allowlisted (`parseHostHeader` / `isAllowedHost`) and carrying the real bound port;
   - Origin required and exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`; the Vite dev origin (`http://127.0.0.1:5173` or `http://localhost:5173`) is accepted only when `AGENT_OS_DEV_ORIGIN=1` is set (by the `dev` script in `package.json`), and that flag is ignored when `NODE_ENV=production` or `AGENT_OS_PACKAGED=1`;
   - the session cookie, compared with `timingSafeEqual`;
   - the path checked lower-cased;
   - no query-string tokens;
   - on any failure: write 403 and destroy the socket;
   - every session REST and WebSocket route, and `/hooks/sessions/*`, is refused unless Agent OS runs in local mode (not demo-public, not the public `HERMES_AGENT_OS_REQUIRE_AUTH=1` mode);
   - the Vite `/api` proxy in `vite.config.ts` gets `ws: true`.
   - Tests: a cross-port localhost Origin, a missing Origin, a foreign Origin, an upper-case path, no cookie, a wrong cookie, an unknown session id, demo-public mode; the Vite dev origin refused by default, accepted with `AGENT_OS_DEV_ORIGIN=1`, and refused with the flag when `AGENT_OS_PACKAGED=1`.
2. **Child environment:** exactly H2 (the login-shell environment, minus Agent OS's own variables and the nested-session markers, plus the listed additions). Tests: each removed variable is absent; user variables (for example `SHELL`, `EDITOR`, `SSH_AUTH_SOCK`, `LC_*`, proxy variables, provider keys) pass through unchanged; `HOME` and the agents' config variables are never set or changed (H1); `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is never set, and `CLAUDE_CODE_NO_FLICKER` only with the opt-in; `TERM_PROGRAM` is never `vscode`.
3. **Argv only, never a shell;** the folder passes the folder policy (D12); agent paths come from detection only; argv contains only the H3 additions (the profile snapshot test).
4. **The per-session hook token** (SP4, Claude Code sessions only) is random, scoped to one session id, and only able to post events for that session. It is never the main session token, and it dies with the session. It sits in the agent's environment, so the agent's own tools can read it; that is why hook events are only hints (SP4). No other agent's environment carries one, and in SP3 no session does.
5. **Files on disk:** `AGENT_OS_HOME`, `sessions/` and `worktrees/` are 0700, with a chmod when they already exist (today `store.js` creates folders with the default mode). Recordings, meta.json, the per-session settings file and helper scripts are 0600. Recordings hold output only, never input. They never leave the computer and can be deleted (the route ships in SP3, the Delete control in SP4). A test checks the modes.
6. **No auto-answers anywhere:** hooks observe only (204, no decision, H5). The only bytes ever written into a PTY are:
   - the writer's input (keystrokes, paste, and its terminal's automatic replies to terminal queries);
   - the mirror's replies to the standard terminal queries while no writer is attached (terminal protocol replies, never an answer to a question meant for the user);
   - the explicit hand-off text (SP4: the hand-off and the typed summaries of Codex keep going and Cursor's hand-over), only under the SP4 write rules and never followed by Enter.
   - There is no other exception: Stop never types into the PTY.

### Also in SP3

- **Home's "New session"** appears and creates sessions: dialog with agent and folder (folder policy); the worktree offer arrives in SP4. The Agents header's "Open session" / "New session" appear too, and the menu's sessions count is shown.
- **Agents page "What works here"** (H8): one short note saying that Agent OS hosts each agent's terminal program, with everything it loads, and that desktop-app-only or IDE-only features are not included.
- **Help page "How it works"** (`prototype/how-it-works.html`), not in the menu, linked from Safety ("How stopping works", added now) and from the Sessions empty state. On Windows and Linux, its "close the window" part says that closing the window quits after asking.
- **Runs, Session recordings tab** lists recordings from `GET /api/recordings`. A live one shows "Open live session". An ended one shows "Resume conversation" (Resume per agent) and the note "Replay arrives in a later update" until SP4; "Open recording" from an ended tab lands here with that row highlighted.

### Placeholders until later (SP3)

- SP3 forwards raw OSC/BEL as `{t:"alert", raw}`; SP4 maps them to kinds and shows alerts.
- The activity state has no waiting or held yet, and every session is basic (the 20 s rule).
- The side panel shows every Live meter row; the rows whose source arrives in SP4 show "—" with the hint "— means unknown".
- Split, the changes panel, hand-off, the worktree offer, the replay player and Delete recording arrive in SP4. Until then an ended session's recording row says "Replay arrives in a later update" and still offers Resume conversation.

**SP3 done when:**
- `test/helpers/no-real-agents.js` exists and the whole suite runs under it;
- fake-agent PTY tests pass (fakes on PATH behave like TUIs: echo, prompt, bell, OSC 9, DECSET ?2004, terminal queries, exit codes);
- the profile snapshot test passes for all five agents with the SP3 expectations (H2, H3, H4: no hook variables, `--settings` only with an OpenRouter or Local brain, the fullscreen opt-in off and on), and the login-shell environment test covers markers, the 10 s timeout and the fallback;
- the folder policy tests (including the upper-case variants) and the folder mode tests pass;
- the WebSocket auth tests in Security 1 pass, including the dev origin with and without `AGENT_OS_DEV_ORIGIN=1`;
- protocol tests pass: writer by `{t:"focus"}`, viewer input dropped, only the writer's resize applied, `seq`/ack counting, pause only when every attachment lags, never pause with zero attachments, the frame and size limits, the mirror answering queries only with no writer;
- activity state tests pass: query replies, focus reports and mouse motion are not user input; redraws confined to the bottom 6 rows do not keep a session live; idle after 20 s;
- reattach restores the screen and modes;
- Stop kills child trees, including a fake agent whose grandchild calls `setsid`;
- the quit path writes "ended (Agent OS quit)" before any kill and finishes inside the 8 s hard exit, also with a fake `claude` CLI that hangs on `claude agents --json` (the 2 s soft-stop timeout);
- Hold to stop all stops fake sessions (both kinds) and fake runs together, with one result toast and no dialog, and never calls the Hermes or OpenClaw service controls (their fake services keep running);
- the `update` session kind test passes (Session kinds);
- ended tabs: "Resume conversation" and "Open recording" work, Dismiss hides the tab and is kept across a restart;
- recording tests: output only, rotation at 25 MB, the 1 GB total cap, the list and delete routes, append after Resume;
- the Resume rules hold (fallback resume disabled with a reason when the folder is shared by ended sessions or a live session of that agent, and the outside-Agent-OS warning shown);
- the desktop shell builds on all three OSes in CI;
- live checks on the owner's Mac (ask first): **S0** (fidelity, H9); **S2** (Claude resume ids); **S3** (Codex id and markers); **S4** (Hermes interface and id source); **S5** (OpenClaw folder and Gateway abort); **S6** (Cursor markers and chat id); **S7** (reattach after closing the window, and ⌘Q with a live session shows the question and Cancel keeps everything running).

## SP4 Session extras

**Signals.** Normalised into `{sessionId, kind: waiting|turn_done|limit|approval|resolved, text, at}`. They drive the activity states (waiting, idle, held) and the alerts. SP4 replaces SP3's `{t:"alert", raw}` with `{t:"alert", kind, text}`.

| Agent | Source | Notes |
|---|---|---|
| Claude Code | HTTP hooks in the per-session settings file to `POST /hooks/sessions/:id` with `Authorization: Bearer $AGENT_OS_HOOK_TOKEN` (`allowedEnvVars`), timeout 3 s | PermissionRequest and Elicitation mean waiting; Stop means turn_done; StopFailure (rate_limit, billing_error) means limit (a hint, confirmed only under "Limit rule per agent"); UserPromptSubmit gives the recording's prompt marker and, with PostToolUse(Edit\|Write), shows a new turn (activity states); PostToolUse(Edit\|Write) refreshes the changes panel; SessionStart/SessionEnd may re-link the agent session id (only under the hint rules below). The hook returns 204 and no decision (H5). **statusLine wrapper** (H6): forwards the JSON (model, context %, rate_limits, cost) to `POST /hooks/sessions/:id/status`, which feeds the Live meter and the limit's second signal, then prints the user's own statusLine output unchanged (the owner uses claude-hud). Until the user trusts the folder inside Claude, show "Alerts start after you trust this folder in Claude". Fallback: OSC 9 / 99 / 777 or BEL on the mirror, and `claude agents --json` polling every 10 s. |
| Codex | OSC 9 notifications (enabled in the launch profile) seen by the mirror | approval-requested means waiting; agent-turn-complete means turn_done. The usage-limit text in the mirror ("You've hit your usage limit") means limit (confirmed under "Limit rule per agent"), and is the only screen reading, labelled in code. |
| Hermes | BEL / OSC on the mirror (spike S4 checks what Hermes sends when it asks for approval) | Labelled "basic alerts"; idle by the 20 s rule; never held. **No Agent OS hooks:** Hermes's shell hooks are declared in the user's own Hermes config, with consent stored in `~/.hermes/shell-hooks-allowlist.json`, so adding ours would change the user's config (H1, H3). Never `--accept-hooks`. A later, opt-in "Richer Hermes alerts" could add one entry per event (`on_human_input_request`, `on_human_input_resolved`, `on_session_end`) pointing at one stable helper, `<AGENT_OS_HOME>/hooks/hermes-hook`, which reads `AGENT_OS_SESSION_ID` and the hook variables from its environment and does nothing when they are absent (Hermes in Terminal is unaffected). It needs the owner's approval before it is built; S4 checks that Hermes asks consent for it only once. |
| OpenClaw | `openclaw approvals pending --json` polled every 3 s while an OpenClaw session is open | Shown as an approval card (session panel + Safety page); Allow once / Deny call `openclaw approvals resolve <id> allow-once\|deny` **only on the user's click**. The card names the folder only if S5 confirms that OpenClaw honours it. The Gateway operator WebSocket is a later improvement. |
| Cursor | BEL / OSC on the mirror | Labelled "basic alerts"; idle by the 20 s rule; never held (no limit signal). Its stop hook is not used: it would need a write to the user's Cursor config (H1, H3), the same rule as Hermes. |

OSC 7501 is not used: no emulator answers its probe, so it would never fire.

**Hook events are hints.** The hook token sits in the agent's environment (H2), so a command the agent runs could post a forged event. Therefore:
- a session re-link is accepted only to a UUID whose transcript exists under `~/.claude/projects/<this session's folder, encoded as Claude encodes it>/`;
- a limit from a hook never shows the banner on its own (Limit rule per agent, below);
- every banner action needs the user's click plus a confirm dialog;
- so the worst a forged event can do is show a misleading banner, never take an action;
- hook bodies over 256 KB are refused.

**Limit rule per agent** (what makes a session held and shows "Plan ran out"):
- **Claude Code:** a limit signal (the StopFailure hook with rate_limit or billing_error, or the mirror's limit text) confirmed by a second, different signal: statusLine `rate_limits` at or above 100 %, or the other of the two first signals.
- **Codex:** it has no hook, so the mirror's usage-limit text is the limit signal. It is confirmed by a second observation: an OSC 9 agent-turn-complete right after the text, or the text still on screen 5 s later with the Codex process alive and no counted output since.
- **Cursor, Hermes and OpenClaw:** no limit signal, so their sessions are never held. Cursor's "Hand to Claude Code or Codex" is offered manually only (Plan ran out, below).
- Any action that follows still needs the user's click and a confirm dialog.

**Hook endpoints** (`server/runtime/sessions/hooks.js`):
- `POST /hooks/sessions/:id` (events) and `POST /hooks/sessions/:id/status` (statusLine JSON);
- they sit outside the cookie-gated `/api/` prefix, so each request must carry `Authorization: Bearer <that session's hook token>` (timing-safe compare); the Host allowlist still applies; refused outside local mode;
- JSON body limit 256 KB, parsed before the global 2 MB JSON parser;
- reply 204 at once (target under 50 ms), then process; never a decision (H5).

**Helper scripts** (the statusLine wrapper, the only helper in this work) are written to `<AGENT_OS_HOME>/sessions/<id>/` (0600) and run with the bundled node's absolute path, because the packaged app cannot rely on `node` being on PATH. The statusLine wrapper finds the user's own statusLine command in their Claude settings files (local project, project, user, in Claude's order) at session start.

**Alerts UI:**
- tab marker ("Waiting for you", "Plan ran out"), Home strip, top-bar badge count, Safety Pending approvals;
- a desktop notification only when the Agent OS window is hidden or not focused. The Rust shell raises it from the server's `AGENT_OS_ALERT:<json>` stdout line (SP3, Desktop shell changes; `server/index.js` prints the line), so it also arrives while the window is closed and the sessions keep running (D5). The permission is requested once, with an explanation. In browser mode, an in-app toast only.
- Alerts clear when the agent resolves (signal) or there is user input in that session (SP3, Session activity states).

**Split.** Two panes side by side, each with its own header; drag the divider; the panel follows the focused pane. One terminal per pane, with no duplicate attach of the same session in both panes. The ⌘\ hint is added to the panel footer.

**Changes panel:**
- `git status --porcelain=v2` and `git diff --numstat` in the session folder, every 3 s while the session is running, and immediately on Claude's PostToolUse(Edit|Write) hooks;
- click a file for a read-only diff;
- each change is also stored as a "files changed" recording marker;
- not a git folder: "Changes appear when this folder is a git project".

**Hand-off:**
- "Send to Codex for review" (and "Send to Claude Code") targets a session of the other agent in the same folder (or worktree).
- **Write rules:** Agent OS writes only when the target's mirror shows DECSET ?2004 (bracketed paste) on AND the target is not waiting or in an approval. An open target that fails either rule is not used: a new session of that agent opens instead, and the text is written once it shows ?2004. If that never happens, the text is shown with a Copy button.
- The body has every C0 and C1 control character and ESC removed, except `\n`, and is wrapped in the paste markers. It is **never followed by Enter**.
- Caption: "Typed for you, not sent".
- The same rules apply to every typed summary (Codex keep going, Cursor's hand-over).

**Worktree offer:**
- When a live session already uses the chosen folder, the New session dialog offers "Separate copy (new branch agentos/<agent>-<n>)" (recommended) or "Same folder".
- One branch scheme everywhere: `agentos/<agent>-<n>`, where `<agent>` is claude, codex, cursor, hermes or openclaw and `<n>` is the smallest number not yet used for that agent in the repository. The Home dialog's text follows it (the prototype's Home dialog shows `agentos/<agent>-<folder>`; this spec uses the Sessions page's `agentos/codex-1` form).
- Separate copy runs `git worktree add <AGENT_OS_HOME>/worktrees/<id> -b agentos/<agent>-<n>` (0700; allowed by D12). Not a git project: only Same folder.
- OpenClaw gets the offer only if S5 confirms that it honours the folder.
- The panel shows the branch ("Separate copy of <folder> (a git worktree)").
- Removing a worktree asks first and refuses when there are uncommitted changes.

**Plan ran out, keep going** (shown for a held session, that is a limit confirmed under "Limit rule per agent"):
- **Claude Code:** banner with "Keep going on OpenRouter" and "Wait for reset".
  - Keep going first opens the prototype's confirm dialog (`sessions.html`, `keepGoingDialog()`): title "Keep going on OpenRouter?", the points "Same conversation", "Pay per use" and "Your call", buttons "Cancel" and "Keep going on OpenRouter". Only after that:
    1. Stop the session;
    2. `claude --resume <uuid>` with the OpenRouter brain (the existing apiKeyHelper settings; the key comes from the Keychain helper, never env or argv);
    3. same tab, same conversation.
  - Anthropic models only (the `server/runtime/builders/continue.js` rule: a Claude conversation continues only on an `anthropic/` model). Reuse continue.js's option and estimate logic.
  - Needs a saved OpenRouter key; otherwise link to Agents → Brain.
- **Codex:** a provider change cannot resume a Codex conversation, so it reuses continue.js's approach: a new Codex session on the OpenRouter brain (`codexBrainArgs`), with a written summary typed into it under the hand-off write rules and not sent. Its confirm dialog says that this is a new conversation that starts from the summary.
- **Cursor:** it has no limit signal, so there is no banner. "Hand to Claude Code or Codex" is offered manually only, as a button in the Cursor session's Hand-off section, available at any time (for example when Cursor itself says the plan ran out). After a confirm it opens a session there with a typed summary (hand-off write rules, not sent).
- **Wait for reset:** the session stays Held and shows the reset time; Agent OS sends nothing. (If the user turned on Claude Code's own auto-resume, that still happens inside the real harness.) Runs stay Held with "press Keep going after the reset"; there is no automatic continue for runs in this work, and the prototype's run toast ("then carry on") is reworded to match.

**Recordings in Runs:**
- the list of session recordings (from SP3's `GET /api/recordings`);
- replay player: asciicast playback in an xterm instance, with:
  - speed 1× / 10× / 30×;
  - a timeline with markers and a "Moments in this recording" list;
  - idle gaps over 30 s skipped while playing and drawn hatched as "Idle, skipped while playing";
  - the true wall-clock length, including removed output, marked "[earlier output removed]";
- timeline markers, stored in meta.json:
  - prompt (Claude's UserPromptSubmit hook only; the other agents have none);
  - permission asked (waiting or approval signals, with their text);
  - files changed (path and +/−, from the changes panel);
- "Resume conversation" in the replay header: the same button that SP3 ships on ended tabs and recording rows, with the prototype's confirm (`runs.html`: "Resume this conversation?"; Agent OS opens a new terminal in the folder and starts the agent with its own resume, does not paste the old text back in and does not press Enter; buttons "Cancel" and "Resume conversation"). It follows the SP3 Resume rules (same Agent OS id and tab, and the fallback warning).
- The SP3 note "Replay arrives in a later update" is removed.
- A recording whose session is still live shows "Open live session" instead of Resume.
- Delete recording: a button in the replay header with a confirm dialog, disabled while the session is live.

**SP4 done when:**
- the hook endpoint tests pass: bad token, wrong session, a body over 256 KB, a 204 reply within 50 ms with no decision, refusal outside local mode;
- the hint rules hold: a re-link to a UUID without a transcript is refused; one limit signal alone never shows the banner, for Claude (hook only) and for Codex (limit text without the second observation);
- the profile snapshot test passes with the SP4 expectations (hook variables and `--settings` for Claude Code only; no other agent gets a hook token);
- the statusLine wrapper test passes: the user's command output is reproduced byte for byte, and nothing is printed when there is none;
- fake-agent OSC/BEL tests produce alerts and the right activity states, including the transition table: a turn-done session stays idle through redraws and status line refreshes and leaves idle only on user input or a new-turn hook; held clears after the reset time or on user input;
- with the window hidden, an alert makes the server print its `AGENT_OS_ALERT:` line (automated), and the Rust shell shows the notification (live check under S7);
- the OpenClaw approval flow passes with a fake CLI (resolve only on click);
- hand-off tests: no `\r`, no ESC inside the body, no write while the target is waiting or before ?2004;
- the worktree offer works with a temp git repo, with branch names `agentos/<agent>-<n>`;
- fake agents produce the recording markers;
- live checks on the owner's Mac (ask first): **S1** (a real Claude permission prompt raises an alert, with claude-hud unchanged); **S2** (keep going on the OpenRouter brain); **S4** (what Hermes sends when it asks for approval, for its basic alerts); **S5** (OpenClaw approvals pending and resolve); **S7** (an alert reaches the owner as a notification while the window is hidden).

## SP5 Agent updates

**Version check service** (`server/runtime/updates/`):
- **When:** at start and every 24 h. Read-only.
- **Installed versions** come from `server/runtime/agents/detect.js`.
- **Latest:**
  - npm registry dist-tags for `@anthropic-ai/claude-code` and `@openai/codex`;
  - `openclaw update --dry-run --json`;
  - Cursor: the agent's own check if one exists (spike S6), otherwise "unknown" and no number;
  - Hermes: `hermes update --check`.
- Network failures show "Couldn't check" and never block anything.
- The footer's update dot (SP1) now shows when any agent has an update.

**One update service for Setup and Agents.** Every update path, the Agents page and the Setup plan (`server/runtime/setup/plan.js`, which offers an update step for every installed agent), goes through the same service:
- `--yes` is already gone from the Hermes and OpenClaw `updateArgs` in `server/runtime/setup/recipes.js` (SP2), so no updater question is answered for the user;
- the Setup plan offers the Hermes update step again (SP2 hid it), now only through the Hermes clean check below;
- jobs keep using `server/runtime/setup/jobs.js` (a visible log, cancel, retry), except updaters that may ask questions: those run in a real session terminal (below).

| Agent | Update command (each agent's official updater, H7) | Notes |
|---|---|---|
| Claude Code | `claude update`, or Homebrew's own upgrade when installed via Homebrew | Then the restart banner for its open sessions. |
| Codex | `codex update` | If installed by Agent OS via the bundled npm, use that npm. |
| Cursor | its official updater (spike S6 confirms the command) | |
| OpenClaw | "Dry run first", then `openclaw update --json` (no `--yes`) | Warns that its Gateway restarts. If S5 shows it asks questions without `--yes`, it runs in a session terminal like Hermes. |
| Hermes | see below | |

**Updates and open sessions:**
- An update may run while sessions of that agent are open, as the prototype shows. It never stops or restarts them; they keep the version they started with. Runs of that agent are treated the same way: they keep running on their version.
- Afterwards Agents shows "Restart session to use vX" with a Restart session button for each such session. The button opens the prototype's confirm dialog (`agents.html`: "Restart <agent> in <folder>?", "The session closes and starts again on vX.", buttons "Not now" and "Restart session"), then stops the session and resumes it in the same folder with the agent's own resume (SP3 Resume rules), pressing no keys. When Resume is unavailable for that session, the banner says why. Never automatic.
- The same rule applies to the Setup update path.
- If spike S8 shows that an install method cannot replace files under a running process, only that method is refused while sessions are open; the UI says why, and it is flagged to the owner as a deviation from the prototype.

**Hermes:**
- Read-only check of its checkout. It counts as **clean** ONLY when all of these hold:
  - HEAD is on the official release or main ref;
  - no commit exists that is not contained in the official remote (compared with that remote's refs, not `@{upstream}`);
  - the working tree is clean;
  - the channel and branch settings are the defaults.
- **The official remote** is any configured remote whose fetch URL is the official repository, `https://github.com/NousResearch/hermes-agent` or `git@github.com:NousResearch/hermes-agent` (with or without `.git`, letter case ignored), whatever the remote's name. The source URL in `server/runtime/setup/recipes.js` is the reference.
- **Fails closed:** the checkout cannot be found or read, no remote points at the official repository (for example a clone of a fork only), or the official remote's refs cannot be read: not clean, explanation only.
- **No fetch:** the check never runs `git fetch`; it compares with the remote-tracking refs as they are on disk. Stale refs can only make a commit look "not contained", so they err on the not-clean side.
- **Clean:** the Update runs in a real SP3 PTY session of kind `update` (SP3, Session kinds), shown in place of the update log on Agents (and Setup), that the user can type into, so Hermes's own prompts reach the user. Never stdin "ignore" or end-of-input.
- **Otherwise:** no Update button; an explanation plus the safe 4-step guide from the prototype (branch, `--set-channel main`, `updates.parked_branch_strategy update_in_place`, update).
- **Never re-run the Hermes installer on an existing install.**

Nothing in Agent OS pins or downgrades an agent (H7). Agent OS auto-update stays off; Claude Code's own auto-updater keeps the user's setting.

**SP5 done when:**
- fake version endpoints and fake CLIs cover: up to date, update available, failed check, the update job log;
- Hermes clean vs not clean with temp git repos: a custom branch pushed to a fork, commits outside the official remote, a dirty tree, a non-default channel, no official remote at all, and a clone of a fork only (both not clean);
- the Setup plan never offers a Hermes update on a checkout with local commits, and no `updateArgs` contains `--yes` (still true from SP2);
- an update during a running session leaves the session process untouched and shows the restart banner;
- Restart session asks first, then stops and resumes with no keys pressed;
- the Hermes update runs in an `update` session terminal that accepts input;
- live checks on the owner's Mac (ask first): **S5** (whether `openclaw update --json` asks questions without `--yes`); **S6** (Cursor's update command and version check); **S8** (an update during a live session, per install method);
- no real network access in tests.

---

## Testing and verification (all sub-projects)

- **Full suite:** `env -u HERMES_HOME npm test`; from SP3 on, under the no-real-agents watcher (`test/helpers/no-real-agents.js`); zero real agent processes.
- **Fakes on PATH** for all five CLIs, extended in SP3 with TUI-like behaviour (echo, prompt, bell, OSC 9, DECSET ?2004, terminal queries, a grandchild that calls `setsid`, exit codes).
- **Temp homes:** temp `HOME` / `USERPROFILE` / `AGENT_OS_HOME` in tests only; the product never sets them (H1).
- **Profile snapshot tests** for every agent's argv and environment (H2, H3, H4), with separate SP3 and SP4 expectations and the fullscreen opt-in off and on.
- `npm run build` + `npx tsc -b`; the desktop shell builds in CI on all three OSes.
- **Screenshot audit** at 1280×720, 1470×956 and 1512×982:
  - no sideways scroll;
  - side-by-side comparison with the prototype screenshots (with the icon rail at 1280 px, which is ≤1366 px; the full sidebar at 1470 and 1512 px; D13);
  - console clean;
  - keyboard path;
  - reduced motion;
  - measured contrast.
- **The orchestrator verifies every worker's result independently before each local commit.**
- **Live spikes on the owner's Mac** (ask first each time). A spike that gates several sub-projects is split by part; every "done when" list names each part gated on it. Until a part has run, the safe default written next to the feature applies (H9).

| Spike | What it checks | Gate for |
|---|---|---|
| S0 | Harness fidelity: every H9 item works the same as in Terminal.app; results go into Appendix B. | SP3 done |
| S1 | Claude Code: Shift+Enter with kitty on; a permission prompt; hooks fire after trust and merge with the user's own hooks; the statusLine wrapper keeps claude-hud byte for byte, and with no user statusLine the screen looks the same as without the wrapper; nested-session markers. | SP4 done |
| S2 | `--session-id` with an existing id and Claude resume by uuid (SP3 done); resume on the OpenRouter brain (SP4 done). | SP3 done, SP4 done |
| S3 | Codex: session id captured at start and resume by id; OSC 9 notifications reach the mirror; nested-session markers. | SP3 done |
| S4 | Hermes: the user's configured interface with `--in`, and the session id source and `-r <id>` (SP3 done); what Hermes sends (BEL or OSC) when it asks for approval, for its basic alerts, and whether a stable hook command needs consent only once, for the later opt-in (SP4 done). | SP3 done, SP4 done |
| S5 | OpenClaw: TUI, whether the folder is honoured, and the Gateway abort argv for Stop (SP3 done); approvals pending and resolve (SP4 done); whether `update --json` asks questions without `--yes` (SP5 done). | SP3 done, SP4 done, SP5 done |
| S6 | Cursor: TUI, nested-session markers and the chat id for resume (SP3 done); its update command and version check (SP5 done). | SP3 done, SP5 done |
| S7 | Reattach after closing the window (mouse and keys still correct), and ⌘Q with a live session shows the question while Cancel keeps everything running (SP3 done); an alert reaches the owner as a notification while the window is hidden (SP4 done). | SP3 done, SP4 done |
| S8 | An update during a live session, per install method (npm global, Homebrew, native installer): the session keeps working. | SP5 done |

## Dependencies and packaging (ask the owner before installing)

- **Add:**
  - `node-pty@1.2.0-beta.14` (exact);
  - `ws` (latest stable, exact);
  - `@xterm/xterm@6.1.0-beta.304` and the matching beta addons (fit, unicode11, search, web-links, clipboard, serialize, webgl), all exact;
  - `@xterm/headless` matching;
  - `@fontsource-variable/archivo`;
  - `tauri-plugin-notification` (Rust crate + `@tauri-apps/plugin-notification` + `notification:default` under the `remote` capability);
  - `tauri-plugin-dialog` (Rust crate + `@tauri-apps/plugin-dialog` + its folder-open permission) for the folder picker;
  - `tauri-plugin-opener`, if needed for "Show in Finder" (Rust crate + `@tauri-apps/plugin-opener` + its reveal permission).
- **Remove:** `@fontsource-variable/inter`.
- **Packaging** (`scripts/build-server-bundle.mjs`, `scripts/prepare-desktop.mjs`):
  - mark `node-pty` as esbuild `external`;
  - `prepare-desktop.mjs` gains `--platform` / `--arch`, passed from `matrix.node_platform` / `matrix.node_arch` in `.github/workflows/release.yml` (the Intel Mac app is cross-built on an Apple Silicon runner, so `process.arch` would be wrong);
  - copy `node_modules/node-pty/{lib,package.json,prebuilds/<platform>-<arch>}` beside the server bundle;
  - `chmod 755` `spawn-helper`, and verify the file mode and the Mach-O/ELF architecture (`file` / `lipo -archs`) instead of running it;
  - fail the build if that prebuild is missing;
  - CI builds on all three OSes must still pass.
- **Future Developer ID notarization** must sign `node`, `pty.node` and `spawn-helper` under `Contents/Resources` explicitly. Not part of this work; recorded here.

## Risks and open questions

- **xterm.js 6.1 is a beta.** We pin an exact build that VS Code uses; IME issues with the kitty keyboard are mitigated by a setting.
- **node-pty 1.2 is a beta.** We pin beta.14 (beta.15 has a Windows regression).
- **No forced fullscreen (H4).** Claude Code's default renderer may show known xterm.js scroll bugs; the opt-in setting is the fix offered.
- **Login-shell environment (H2)** can be slow or fail for unusual shell setups; the 10 s timeout, the fallback and the notice cover it.
- **Claude hooks** run only after folder trust, and statusLine is a single key (hence the wrapper). Hook merge with the user's own hooks is checked in S1.
- **The hook token is readable by the agent's tools** (no env scrub, H2). Handled by treating hook events as hints; the worst case is a misleading banner.
- **Hermes alerts are basic** in this work, because Agent OS does not write Hermes hook entries into the user's config (H1, H3; decided in this revision, so nothing waits on S4 before SP4 starts). The later opt-in needs the owner's approval, and S4 checks that a stable helper path gets consent only once (Hermes stores consent per event and command).
- **Quit plumbing in Tauri (D5)** is the part of D5 most likely to fail. ⌘Q is the predefined Quit item (`PredefinedMenuItem::quit` in `build_menu`, `main.rs`), which may end the app before `RunEvent::ExitRequested` can prevent the exit, so the SP3 plan may need a custom Quit item that emits the event instead. The event name, how the UI confirms and the capability permission it needs are fixed in the SP3 plan, and S7 checks on the owner's Mac that ⌘Q with a live session asks first and that Cancel keeps everything running.
- **OpenClaw:** killing its TUI may not stop Gateway work, so its soft stop (the Gateway abort) comes first, within the 2 s soft-stop limit, and Stop reports honestly when it cannot confirm. Exec approvals depend on `openclaw approvals` output staying stable. Whether OpenClaw honours the chosen folder is open until S5 (an SP3 gate); until then Folder is hidden for OpenClaw.
- **Cursor** has the weakest signals (BEL / OSC only, no hooks, no limit signal) and an unconfirmed update command and resume id.
- **Updates under running processes:** some install methods may not replace files safely while a session runs (S8).
- **Windows and Linux** have no tray in this work, so closing the window quits (after asking).
- **Team Room behaviour change (D10)** affects existing rooms: agreement no longer saves on its own, rooms pause for a decision, and nine existing tests in `test/team-room.test.js` must be rewritten (SP2 done when).
- **The 20 s rule and counted output** are heuristics for basic sessions: an agent that redraws above the bottom 6 rows while idle can look live, and one that works silently for 20 s can look idle. That is why such sessions and their alerts are labelled "basic" (Goal 3).
- **Research gaps** (fact-checking was cut off by usage limits): Codex app-server attach, Cursor hooks detail, competitor UX. The spikes above cover what matters.

---

## Appendix A: Review resolutions

One line per review finding. "Decision" names the owner decision (D), harness rule (H) or orchestrator resolution (C, from `specs/spec-revisions.md`) that settles it.

| # | Lens | Severity | Problem (short) | Resolved in | Decision |
|---|---|---|---|---|---|
| 1 | fidelity | high | Spec refused updates during a running session; the prototype allows them with a restart banner | SP5 "Updates and open sessions"; SP5 done when; spike S8 | C1 |
| 2 | fidelity | high | Team Room "same API" saves on agreement while the UI says it waits | D10; SP2 "Team Room server change (D10)" (pause as `needs_you` + `pausedFor`, clock stops, gate-off Approve, Continue, end condition); SP2 done when (new tests and the nine rewritten ones) | D10 |
| 3 | fidelity | high | Status list lacked idle and held; Orbit would light idle sessions | SP3 "Session activity states" (transition table, user input, counted output, turn-done sessions, all six panel lines); SP4 "Limit rule per agent"; WebSocket `state`; SP2 Home row | C2 |
| 4 | fidelity | medium | Hold to stop all opened a second dialog; service scope unclear | D11; SP1 Shell top bar; SP3 Persistence, quit and Stop; SP2 Agents and Safety rows; SP2 done when (copy check); SP3 done when (sessions, runs, services untouched) | D11 |
| 5 | fidelity | medium | No designed place to start a run; New session could not make a run | SP2 Runs row (New run) and Home row; SP3 "Also in SP3" | C3 |
| 6 | fidelity | medium | Icon rail at 1280 px differs from the prototype | D13; SP1 Shell; SP1/SP2 done when; Testing | D13 |
| 7 | fidelity | medium | OpenClaw launch had no folder; folder and copy offer unclear | SP3 Launch profiles (OpenClaw row, safe default until S5); SP4 Worktree offer and Signals; spike S5 (an SP3 gate for the folder) | H3, finding's fix |
| 8 | fidelity | medium | Side panel sections and Live meter missing; width wrong | SP3 "Side panel" (every row from SP3, "—" until its source arrives); SP4 Signals (statusLine target) | C4 |
| 9 | fidelity | medium | Replay markers, speed, Moments list and idle skipping missing | SP4 Recordings in Runs; SP4 done when; SP3 Page layout (ended sessions lead to Runs, with Resume, before the player exists) | C5 |
| 10 | fidelity | medium | Workspace provenance, filter, Undo and Show in Finder not in the API | SP2 Workspace row; Dependencies (opener) | C6 |
| 11 | fidelity | medium | Confirm dialogs and "Wait for reset" undefined | SP3 Stop session; SP4 Plan ran out and Recordings; SP5 Restart; SP2 Runs row | C7 |
| 12 | fidelity | low | ⌘W, Delete control, grain, branch names, How it works page, D4 wording | SP3 App shortcuts and Page layout (no ⌘W; only ended tabs can be dismissed); SP4 Recordings (Delete); SP1 House rules (grain removed); D6 and SP4 Worktree offer; SP3 "Also in SP3" (help page); D4 note | C8, C5 |
| 13 | codebase_safety | high | Closing the window kills the server; no notification plugin | SP3 Desktop shell changes (notifications raised by the Rust shell from `AGENT_OS_ALERT` lines); Persistence, quit and Stop; SP4 Alerts UI; Dependencies; S7 | C9 |
| 14 | codebase_safety | high | WebSocket Origin check weak; dev proxy lacks `ws` | SP3 Security 1 (dev origin only with `AGENT_OS_DEV_ORIGIN=1`, with tests) | C10 |
| 15 | codebase_safety | high | Setup updates Hermes/OpenClaw with `--yes` and no checks | SP2 Setup row (`--yes` removed and the Hermes step hidden from SP2); SP2 done when; SP5 "One update service"; SP5 done when | C11, C1 |
| 16 | codebase_safety | high | Hermes clean check used `@{upstream}`; jobs.js has no PTY | SP5 Hermes (official remote by URL, fails closed, no fetch); SP3 Session kinds (`update`); Build order (SP5 depends on SP3) | C12 |
| 17 | codebase_safety | high | pty-host cannot use `spawnTracked`; group-only kill; quit timing | SP3 Components (`pty-host.js`); process-tree.js changes; quit timing budget (2 s soft-stop limit, 3 s grace) | C13, C9 |
| 18 | codebase_safety | medium | Hand-off could answer prompts or inject control bytes | SP4 Hand-off write rules; SP4 done when; Security 6 | C15 |
| 19 | codebase_safety | medium | OpenClaw soft stop typed `/stop` into the PTY | SP3 Stop sequence; Security 6 | C16 |
| 20 | codebase_safety | medium | Terminal queries with zero or many viewers; no focus message; OSC 7501 dead | SP3 WebSocket protocol (terminal queries, `focus`); `mirror.js`; SP4 Signals | C17 |
| 21 | codebase_safety | medium | Codex `--last` may resume the wrong conversation; keep-going provider rules | SP3 Resume per agent (fallback rules for Hermes, Codex and Cursor, outside-Agent-OS warning); SP4 Plan ran out and Limit rule per agent | C19, C20 |
| 22 | codebase_safety | medium | node-pty prebuild architecture wrong for the Intel cross-build | Dependencies and packaging | C21 |
| 23 | codebase_safety | medium | Hook token readable by agent tools; forged events | SP4 "Hook events are hints"; SP3 Security 4; H2 (no env scrub; hook variables for Claude Code only, from SP4) | C14, H2 |
| 24 | codebase_safety | low | Folder modes not set; input might be recorded | SP3 Security 5; `recorder.js` (output only) | C22, C5 |
| 25 | ambiguity | high | Window close, quit question and timings impossible today | SP3 Persistence, quit and Stop; Desktop shell changes; D5; Risks (Tauri quit plumbing); S7 | C9 |
| 26 | ambiguity | high | No folder policy or folder chooser | D12; SP3 Folder policy (`fs.realpath.native`, letter case ignored on macOS and Windows); Security 3; Dependencies (dialog) | D12 |
| 27 | ambiguity | high | WebSocket upgrade rule contradictory; dev origin | SP3 Security 1 (named dev flag and its tests) | C10 |
| 28 | ambiguity | high | Protocol underspecified (focus, `seq`, viewers, limits, field names) | SP3 WebSocket protocol | C17, C18 |
| 29 | ambiguity | high | OpenClaw `/stop` vs Security 6; `/bg` detection; Goal 4 honesty | SP3 Stop sequence; Goal 4; Security 6; "In plain words" (the Stop promise matches Goal 4) | C16 |
| 30 | ambiguity | medium | Earlier sub-projects depended on later ones | Build order; "Placeholders until later" in SP1, SP2 and SP3; "Also in SP3"; H9 and the spikes table (safe defaults until a spike runs) | C23, C3 |
| 31 | ambiguity | medium | Resume ids undefined; wrong conversation possible | SP3 Resume per agent; Spikes table (S2, S3, and the id parts of S4 and S6 gate SP3) | C19 |
| 32 | ambiguity | medium | Recording deletion, privacy and caps undefined | SP3 `recorder.js` and `routes.js`; Security 5; SP4 Recordings | C5 |
| 33 | ambiguity | medium | Child environment allowlist unspecified | H2 (SP3 and SP4 variables apart); H3 (snapshot expectations per sub-project); SP3 Security 2 | H2 |
| 34 | ambiguity | medium | Shortcut precedence; native menu accelerators steal keys | SP3 App shortcuts (including browser mode); Desktop shell changes; SP1 inventory | C24, C9, C8 |
| 35 | ambiguity | medium | No token mapping; scale collision; removed tokens | SP1 Tokens | C25 |
| 36 | ambiguity | medium | Missing pieces: notification plugin, watcher, PTY updates, helper scripts, body limit | Dependencies; SP3 first task; SP3 Session kinds; SP5 Hermes; SP4 Hook endpoints and Helper scripts (the statusLine wrapper only; no Hermes helper) | C26, C9, C12 |

## Appendix A2: Consistency check resolutions

One line per gap (G) and contradiction (X) found by the consistency check of the revised spec, plus three inconsistencies found while fixing them (E).

| # | Problem (short) | Resolved in |
|---|---|---|
| G1 | D10 left the room's end, the "Paused" status value, Approve with the gate off, the clock while paused and the failing tests undefined | D10; SP2 "Team Room server change (D10)"; SP2 done when (nine tests listed for rewrite) |
| G2 | Output could flip an idle turn-done session back to live; how held clears was unstated | SP3 Session activity states (user input, counted output, turn-done sessions, transition table) |
| G3 | In SP3 an ended tab led nowhere and Resume had no button | SP3 Page layout (Ended sessions); Resume per agent; "Also in SP3" (Runs); SP3 placeholders; SP4 Recordings |
| G4 | The `update` session kind used by SP5 was never defined | SP3 Session kinds; `profiles.js`, `manager.js` and `routes.js` rows; SP5 Hermes |
| G5 | Spike gates did not match when their results are needed; done-when lists missed spikes | H9; Testing spikes table (split by part); SP3, SP4 and SP5 done when; OpenClaw launch row (safe default) |
| G6 | Codex and Cursor had no defined second signal, so keep going could never trigger | SP4 "Limit rule per agent"; Plan ran out (Cursor manual only); activity transitions (held) |
| G7 | No time budget for the soft stops inside the 8 s hard exit | SP3 Persistence, quit and Stop (2 s soft-stop limit, then 3 s grace); SP3 done when (hanging CLI test) |
| G8 | Hermes hooks would need a write to the user's Hermes config | H3 (no config writes); SP4 Signals Hermes row (basic alerts; opt-in later, owner approval first); Resume per agent (Hermes id); Risks; S4 |
| G9 | Nobody raised the notification while the window is hidden | SP3 Desktop shell changes (Rust shell, `AGENT_OS_ALERT` lines); SP4 Alerts UI; SP4 done when; S7 |
| G10 | The dev origin flag was unnamed and untested | SP3 Security 1 (`AGENT_OS_DEV_ORIGIN=1`, tests); existing files changed in SP3 (`package.json`) |
| G11 | Where the fullscreen opt-in is stored and when it applies | H4; SP3 Browser terminal (Session settings); `routes.js` (`/api/sessions/settings`); snapshot tests |
| G12 | "Official NousResearch remote" undefined; missing remote and stale refs | SP5 Hermes (official remote by URL, fails closed, no fetch); SP5 done when |
| G13 | `hermes update --yes` stayed on offer in Setup until SP5 | SP2 Setup row; SP2 done when; SP5 "One update service" |
| G14 | No test that Hold to stop all stops sessions and leaves the services running | SP3 Persistence, quit and Stop; SP3 done when; SP2 done when (copy check) |
| G15 | SP3 snapshot expectations for `--settings` and hook variables unclear | H2; H3; Launch profiles (Claude row); Resume per agent; SP3 and SP4 done when; Security 4 |
| G16 | Folder checks ignored letter case on macOS and Windows | SP3 Folder policy (`fs.realpath.native`, case-insensitive comparison, tests) |
| G17 | Panel lines for starting, live and exited were left to the plan | SP3 Session activity states (all six lines, exit wording) |
| G18 | Only Codex's fallback resume was guarded against a live session; outside conversations | SP3 Resume per agent (fallback rules, warning) |
| G19 | The Tauri quit plumbing had no Risks entry or check | Risks (Quit plumbing in Tauri); Desktop shell changes; SP3 done when; S7 |
| G20 | Browser mode cannot receive ⌘T, ⌘1–9 or Ctrl+Shift+T | SP3 App shortcuts (Browser mode); SP1 inventory |
| X1 | SP1 done when judged 1470 px "with the rail" | SP1 done when; Testing (screenshot audit) |
| X2 | "One Stop that always works" promised more than Goal 4 | In plain words |
| X3 | "Never removes or replaces anything" ignored H2, H6 and the Codex options | In plain words |
| X4 | Cursor "Plan models only" in a real terminal | SP3 Launch profiles (Cursor row) |
| X5 | General second-signal rule versus Codex and Cursor | SP4 Limit rule per agent; activity transitions |
| X6 | "No tab close" versus "until dismissed" | SP3 App shortcuts; Page layout (Dismiss for ended tabs only) |
| X7 | "—" hint versus hiding SP4 meter rows in SP3 | SP3 Side panel; SP3 placeholders |
| X8 | Hook token in every environment from SP3 | H2; Security 4; Launch profiles |
| X9 | Hermes helper decision, S4, S5 and S6 gated later than their results are used | Spikes table; H2 (markers default); SP4 Signals (Hermes decided now); Risks |
| X10 | Quit plumbing claimed to be under Risks but was not | Risks (Quit plumbing in Tauri) |
| X11 | ⌘T and ⌘1–9 promised in browser mode | SP3 App shortcuts (Browser mode) |
| E1 | The spec named `/api/team-room`; the routes are mounted at `/api/team-rooms` (`server/index.js`) | SP2 Workspace row; SP2 Team Room server change |
| E2 | Recent folders offered the Agent OS workspace, which D12 refuses (it is inside AGENT_OS_HOME) | SP3 Folder policy (recent folders) |
| E3 | Cursor's stop hook would need a write to the user's Cursor config (same issue as G8); "Running for" was hidden although its source exists in SP3 | SP4 Signals (Cursor row); S6; SP3 Side panel (Running for in SP3) |

## Appendix B: Fidelity spike S0 results

To be filled in after spike S0 runs on the owner's Mac (H9). "Same as Terminal.app" is yes, no or partly; any "no" needs a note and a follow-up.

| Agent | Item | Same as Terminal.app | Notes | Date |
|---|---|---|---|---|
| Claude Code | Slash commands (/help /model /mcp /plugins /hooks /resume /agents /mods) | | | |
| Claude Code | The user's MCP servers connect | | | |
| Claude Code | Skills and plugins load | | | |
| Claude Code | Mods (2.1.287 or later) | | | |
| Claude Code | The user's own hooks fire | | | |
| Claude Code | claude-hud shows | | | |
| Claude Code | CLAUDE.md is loaded | | | |
| Claude Code | Native permission prompts | | | |
| Claude Code | Shift+Enter or Ctrl+J | | | |
| Claude Code | Mouse | | | |
| Claude Code | Copy and paste | | | |
| Claude Code | /bg | | | |
| Codex | /model | | | |
| Codex | Approvals | | | |
| Codex | MCP | | | |
| Codex | Resume | | | |
| Cursor | Basic flow | | | |
| Cursor | Models | | | |
| Hermes | Chat | | | |
| Hermes | Tools | | | |
| Hermes | Its own hooks | | | |
| OpenClaw | tui | | | |
| OpenClaw | Approvals | | | |

Other spike results, from the live checks on the owner's Mac (2026-10-16). Only what each check found; a check that could not run says so.

- **S0** (partly): the user's plugins, `CLAUDE.md` / `AGENTS.md` and hooks load in a Claude Code session as in Terminal (the claude-hud status line, a start-up note, the hook count and the update notice show). The table above stays open: the items that need a signed-in Claude Code were not run.
- **S2:** Claude Code starts with `--session-id <uuid>` and the id is saved. Resuming a session in which nothing was sent exits 1 with "No conversation found with session ID" (handled, see Resume per agent). The message-and-resume half waits for a signed-in Claude Code (none was signed in), and no prompt was sent.
- **S3:** Codex starts in the chosen folder and shows its session id only on screen, so Codex resume stays the `--last` fallback, which brought the conversation back. The notification (OSC 9) and nested-marker checks did not run: no turn succeeded.
- **S4:** `hermes --in <folder>` opens the person's configured interface. Hermes prints its session id in its exit text and in `hermes sessions list`; resume stays the `--resume latest` fallback, which brought the conversation back. What Hermes sends when it asks for approval was not checked.
- **S5:** OpenClaw's TUI starts with `--session agentos-<sessionId>` and connects to the Gateway; Esc inside the TUI aborts a running Gateway step, and OpenClaw's help lists no abort subcommand. Whether its work honours the chosen folder is inconclusive (the model never answered), so Folder stays hidden and Stop keeps its honest message.
- **S6:** Cursor's TUI starts with `--workspace <folder>` after its own folder-trust question. The names only Cursor sets for its programs are the 7 Cursor entries of `NESTED_MARKERS` (`CURSOR_RIPGREP_PATH` is harmless and is left alone). A bare `--resume` opens Cursor's chat picker; `agent create-chat` prints a new chat id and `agent --resume <chatId> --workspace <folder>` opens that chat directly, which is what a new Cursor session now does (H3, Launch profiles).
- **S7:** in the built desktop app, ⌘Q with a live session asks first, and Keep running leaves the app and the session running; Quit ends the session, and when the app is opened again its tab reads "Ended when Agent OS quit." with Resume. Closing the window keeps the session running, and a Dock click shows it again. Quit from the Dock menu or the app switcher ends the app without the question and ends the sessions the same way. A server started from inside Claude Code passed that host's names on to every session; the nested-host rule in H2 answers it.
