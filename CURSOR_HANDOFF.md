# Cursor Agent Handoff — Agent OS Dashboard

## Purpose

This file is a safe handoff from Hermes Agent to Cursor Agent.

Goal: continue building Harsha's local Agent OS dashboard so it becomes closer to the public AgentOS guide / YouTube demo, while keeping the Mac safe and avoiding secret leaks.

**Important:** do not assume everything in this file is still true. First inspect the local codebase and re-run verification commands before editing.

---

## User context

Harsha is learning to code and wants plain-English explanations.

Working style:

- Explain what you will change, why, and trade-offs before editing files.
- Wait for Harsha's approval before applying code changes unless he explicitly says to proceed.
- Do not silently push to GitHub.
- Keep explanations beginner-friendly.
- Do not make Harsha feel dumb for asking "why".
- Prefer simple, surgical changes over large rewrites.

Safety preferences:

- Do not expose secrets, tokens, API keys, or raw auth URLs.
- Keep dangerous machine-control / shell execution disabled unless Harsha explicitly approves.
- Ask before installing OpenClaw, OpenClaude, standalone Codex CLI, or granting broader macOS permissions.

---

## Project path

Open this folder in Cursor:

```text
/Users/harsha/.hermes/agent-os-runtime/app
```

Main local dashboard URL:

```text
http://127.0.0.1:8090
```

FreeLLMAPI local gateway URL:

```text
http://127.0.0.1:3001
```

OpenAI-compatible gateway base URL:

```text
http://127.0.0.1:3001/v1
```

---

## Source reference

Harsha originally shared an AgentOS guide URL with a query token.

Use the public page, but do **not** store the raw tokenized URL in source files or commits.

Safe/redacted version:

```text
https://agentos.guide/system?mcp_token=[REDACTED]
```

Target idea from the public page / video:

- Mission Control dashboard
- Unified agent chat/router
- Workspace previews for generated files/assets
- Codex Goal Mode
- Kanban-style orchestration
- Memory / vault / self layer
- Notebook-style research assets
- Studio for voice/image/video/audio
- Machine-control / Jarvis-like control, but gated safely

---

## Current known state from Hermes handoff

Hermes previously reported the following. Re-verify before relying on it.

### Running services

- Agent OS runtime: expected at `http://127.0.0.1:8090`
- FreeLLMAPI gateway: expected at `http://127.0.0.1:3001`
- FreeLLMAPI previously printed: `Server running on http://0.0.0.0:3001`

### Connected agents/tools reported earlier

- Cursor Agent CLI installed at:

```text
~/.local/bin/agent
```

- Claude Code CLI installed and previously responded to a tiny `OK` probe.
- Hermes Agent installed and previously reported as working.
- Codex API path works through Agent OS / Hermes / FreeLLMAPI.
- Standalone `codex` CLI was **not** installed at last check.
- OpenClaw was **not** installed at last check.
- OpenClaude was **not** installed at last check.
- `cliclick` was **not** installed at last check.

### Important distinction

Codex is currently expected to work through the OpenAI-compatible gateway:

```text
http://127.0.0.1:3001/v1
```

But the separate terminal command:

```bash
codex
```

may not exist unless standalone Codex CLI is installed.

---

## Files likely touched by previous dashboard work

Inspect these first:

```text
server/index.js
src/AgentOSApp.tsx
src/api.ts
src/agent-os.css
```

Hermes previously claimed a Mission Control section was added showing local readiness for:

- Cursor Agent
- Claude Code
- Codex
- Hermes Agent

Do not trust this blindly — inspect and test.

---

## Existing backup location reported earlier

Hermes previously reported this backup path:

```text
/Users/harsha/.hermes/agent-os-runtime/backups/20260807-112713-dashboard-upgrade
```

Check whether it exists before using it.

---

## Verification commands

Run from:

```bash
cd /Users/harsha/.hermes/agent-os-runtime/app
```

### Check Agent OS health

```bash
curl -s http://127.0.0.1:8090/api/health
```

### Check local agents endpoint, if present

```bash
curl -s http://127.0.0.1:8090/api/local-agents
```

### Check FreeLLMAPI ping

```bash
curl -s http://127.0.0.1:3001/api/ping
```

### Check frontend/backend tests

```bash
npm run build
```

```bash
env -u HERMES_HOME npm test
```

Why `env -u HERMES_HOME` matters: some Agent OS tests create temporary Hermes homes. If the real `HERMES_HOME` leaks into tests, tests may inspect the real profile by accident.

---

## Transcript / video comparison status

Hermes attempted to fetch YouTube transcripts using transcript tooling. Captions appeared to exist, but subtitle download was blocked by YouTube rate limiting:

```text
HTTP Error 429: Too Many Requests
```

So the current feature comparison came from:

- public AgentOS page text
- screenshots on the public page
- visible page sections
- local Agent OS API/UI inspection
- partial/search-indexed video information

If Cursor continues the video comparison, use safe transcript tooling and do not bypass YouTube protections.

Potential tools:

- `yt-dlp`
- `youtube-transcript-api`

If installing packages, use an isolated environment or `uv`, not global pip.

---

## Gap analysis summary

Current local Agent OS is a working foundation, but not yet the full public/demo Agent OS.

### Good / partially working

- Local dashboard foundation
- Agent Builder foundation
- FreeLLMAPI gateway
- Cursor Agent CLI availability
- Claude CLI availability
- Hermes Agent availability
- Codex via FreeLLMAPI/OpenAI-compatible path
- Basic memory/backend concepts
- Basic goals/backend concepts
- Basic Kanban/backend concepts
- Scheduler backend exists

### Missing or incomplete compared with public/demo target

- Full demo-style sidebar/pages
- Workspace asset browser with previews
- Unified chat/router UI for Cursor / Claude / Codex / Hermes
- True Codex Goal Mode UI with timeline, scratch directory, files, commands, and logs
- Full Kanban board with real jobs/cards
- Memory/vault UI and Obsidian/OMI-like loop
- NotebookLM-style integration/assets/audio overviews
- Studio tab for image/video/audio/voice assets
- Voice/machine-control setup screen
- Permission checker for Accessibility / Screen Recording / Microphone / Automation / Full Disk Access
- OpenClaw integration
- OpenClaude integration
- Gemini/OpenCode/other demo agents
- Standalone Codex CLI
- `cliclick` helper for macOS click/type automation
- Provider-router cleanup; earlier health reportedly complained about missing Ollama model `llama3.1`

---

## Recommended next task for Cursor Agent

### Phase 2 — safe dashboard/functionality upgrade

Build visible demo-style pages without enabling dangerous local control yet.

Add or improve pages for:

1. **Workspace**
   - list generated files/assets
   - preview HTML/images/audio/video/PDF where possible
   - search/filter assets

2. **Unified Chat**
   - choose Cursor / Claude / Codex / Hermes
   - send a message
   - show agent response/history
   - clearly display whether it is a real call or placeholder

3. **Goals / Codex Goal Mode**
   - goal list
   - run timeline shell
   - commands/files/messages panels
   - disabled state if standalone Codex CLI is missing

4. **Kanban**
   - To Do / Doing / Done lanes
   - connect to existing backend if available
   - empty-state guidance

5. **Memory / Vault**
   - show memory status/counts
   - show configured vector provider
   - do not expose sensitive memory contents without clear UI

6. **Notebook**
   - show notebook items if backend exists
   - empty-state for NotebookLM-style future integration

7. **Studio**
   - UI shell for media generation/assets
   - mark integrations as missing unless verified

8. **Machine Control**
   - permission status dashboard
   - show missing tools like `cliclick`
   - show macOS permissions needed
   - keep execution disabled by default

---

## Safety gates — do not change without approval

Keep these disabled unless Harsha explicitly approves:

```text
HERMES_AGENT_OS_ENABLE_EXEC=0
HERMES_AGENT_OS_ENABLE_INSTALL=0
HERMES_AGENT_OS_PUBLIC_MODE=0
HERMES_VOICE_ALLOW_SHELL=0
```

Do not silently enable:

- shell execution
- full disk access
- screen recording
- accessibility control
- unattended browser/account actions
- background daemons with broad permissions

If machine control is requested, ask Harsha first and explain:

- what will be installed
- what permission is needed
- why it is needed
- what risk it adds
- how to disable it later

---

## macOS permission clarification

macOS permissions are per-app/process, not global.

If Harsha gave permission to Terminal, that does not always grant permission to:

- Hermes Desktop
- Node.js
- Python
- Cursor
- VS Code terminal
- a background Agent OS process

For machine control, the likely permissions are:

- Accessibility — click/type/window control
- Screen Recording — screenshots/visual inspection
- Microphone — voice input
- Automation — controlling Chrome/Finder/System Events
- Full Disk Access — only if truly needed

Cursor should not try to grant these silently. It can open settings or explain steps, but Harsha must click Allow / enter password.

---

## Suggested first prompt to Cursor Agent

Harsha can paste this into Cursor Agent:

```text
Read CURSOR_HANDOFF.md fully. Then inspect this codebase and verify what is actually implemented.

Goal: continue Phase 2 of my local Agent OS dashboard so it becomes closer to the public AgentOS guide/video, but keep it safe.

First, do not edit files. Give me a plain-English plan for:
- Workspace previews
- Unified Chat for Cursor / Claude / Codex / Hermes
- Goals / Codex Goal Mode
- Kanban
- Memory/Vault
- Notebook
- Studio
- Machine Control permission status

Do not enable dangerous execution, shell access, macOS computer-control permissions, or install OpenClaw/OpenClaude/standalone Codex without my explicit approval. Do not print or store secrets/tokens.
```

---

## If edits are approved later

Before editing:

1. Create a timestamped backup of files you touch.
2. Make small, surgical commits/changes.
3. Run build/tests.
4. Verify in browser.
5. Explain what changed in plain English.

Suggested backup directory pattern:

```text
/Users/harsha/.hermes/agent-os-runtime/backups/YYYYMMDD-HHMMSS-cursor-phase2
```

---

## Done definition for Phase 2

Phase 2 is done when:

- dashboard loads at `http://127.0.0.1:8090`
- sidebar has all major demo-style pages
- each page shows real local status or honest "not configured" state
- no fake connected states
- no secrets printed
- dangerous actions remain gated
- `npm run build` passes
- `env -u HERMES_HOME npm test` passes, or failures are clearly explained
- Harsha can visually inspect the dashboard and understand what works vs what is missing
