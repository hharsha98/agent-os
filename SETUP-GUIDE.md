# Agent OS Setup Guide

Agent OS is a **local-first** dashboard. You clone the repo, run it on your machine, and keep execution off until you turn it on. It is not a hosted SaaS product.

## Requirements

- Node.js 18 or newer (20+ recommended)
- npm
- Optional local CLIs: Cursor Agent (`agent`), Claude Code (`claude`), Hermes (`hermes`), Codex (`codex`), OpenClaw (`openclaw`)
- Optional OpenAI API key for Codex preview / workflow generation

macOS and Linux are the expected hosts. The supported install path is **Node + npm** (`npm ci` → `npm run build` → `npm start`). Docker Compose is optional for Mac users who already have Docker Desktop; it is never required for CI or verification on cloud VMs.

## Install and start

```bash
git clone https://github.com/hharsha98/agent-os.git
cd agent-os
cp .env.example .env
npm ci
npm run build
npm start
```

Open [http://127.0.0.1:8090](http://127.0.0.1:8090).

Verify:

- UI: [http://127.0.0.1:8090](http://127.0.0.1:8090) lands on **Mission Control**
- API: [http://127.0.0.1:8090/api/health](http://127.0.0.1:8090/api/health)
- Agents: [http://127.0.0.1:8090/api/local-agents](http://127.0.0.1:8090/api/local-agents)

The server loads `.env` at process start. Existing environment variables win over the file.

## First-run checklist

1. Mission Control should show each agent as **Not installed**, **CLI found · chat not wired**, **Dry run**, or **API preview** — never a fake “connected chat”.
2. Open **Unified Chat** and send a dry-run. Cursor returns an honest unwired notice.
3. Leave live execution off (`HERMES_AGENT_OS_ENABLE_EXEC=0`).

## Optional: Codex preview

1. Open **AI APIs**.
2. Save a user-owned OpenAI API key (stored only on the local server).
3. Unified Chat → Codex can then use the API preview. That is still not a live tool-using agent.

You can alternatively set:

```bash
OPENAI_API_KEY=your-key
AGENT_OS_CODEX_MODEL=gpt-5.3-codex
AGENT_OS_CODEX_REASONING_EFFORT=medium
AGENT_OS_OPENAI_BASE_URL=https://api.openai.com/v1
```

Without a key, the rest of the dashboard still runs.

## Optional native CLIs

These are **not** installed by Agent OS. Refresh Mission Control after you install any of them yourself.

```bash
# examples only — use each vendor’s current docs
# Cursor Agent CLI: agent
# Claude Code: claude
# Hermes: hermes
# OpenClaw:
npm install -g openclaw@latest
```

Installer execution inside the dashboard is separately gated:

```bash
HERMES_AGENT_OS_ENABLE_INSTALL=1
```

Keep that at `0` unless you trust an install recipe.

## Native workflow execution

Visual workflows can target Hermes or OpenClaw. Native execution requires:

```bash
HERMES_AGENT_OS_ENABLE_EXEC=1
```

Default local v1 keeps this off. Missing positions are easier to recover than duplicate live runs.

## Optional: Docker on your Mac

Skip this on Cursor cloud / CI — Docker is often unavailable there. Use native `npm start` instead.

If Docker Desktop is already running on your Mac:

```bash
cp .env.example .env
docker compose up --build
```

Compose publishes host port **8090** to the container (`PORT` inside the image is also 8090). Host-installed CLIs are not automatically available inside the image.

## Security

- Runtime state defaults to `~/.hermes-agent-os/`.
- Secret-bearing JSON files use owner-only permissions.
- API responses redact secret values and private paths.
- Do not distribute `.env`, the runtime store, or workflow runs.
- Public/VPS mode is optional and not the v1 product. If you enable it, set `HERMES_AGENT_OS_PUBLIC_MODE=1` and an admin token; it is still a single-operator guard, not multi-tenant accounts.

## Verification (native — no Docker)

```bash
npm run build
env -u HERMES_HOME npm test
npm start   # separate terminal
npm run smoke:local
```

Hiring-manager demo path (under 10 minutes): Mission Control → Unified Chat dry-run → Workspace sandbox → Machine Control checklist. Leave Labs extras for later.
