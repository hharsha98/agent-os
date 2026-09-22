<h1 align="center">Agent OS</h1>

<p align="center">
  <strong>A local command center for AI coding agents.</strong><br />
  Clone it. Run it on your machine. Dry-run by default. Execution stays off until you turn it on.
</p>

<p align="center">
  <a href="https://hharsha98.github.io/agent-os/"><img src="https://img.shields.io/badge/Static_gallery-open-ff7a2f?style=for-the-badge" alt="Open static gallery" /></a>
  <a href="#run-it-locally"><img src="https://img.shields.io/badge/Local_v1-clone_and_run-111318?style=for-the-badge" alt="Run locally" /></a>
  <img src="https://img.shields.io/badge/license-MIT-8f96a3?style=for-the-badge" alt="MIT license" />
</p>

<p align="center">
  <a href="https://hharsha98.github.io/agent-os/">Static gallery</a>
  ·
  <a href="docs/DEMO.md">Product tour</a>
  ·
  <a href="docs/V1.md">What v1 includes</a>
  ·
  <a href="SETUP-GUIDE.md">Setup guide</a>
</p>

---

## What this is

Agent OS is a **local-first dashboard** for agents that already live on a developer machine: Cursor Agent, Claude Code, Codex, and Hermes.

It is **not** a hosted multi-tenant cloud app. The github.io page is a **static gallery**, suitable later for an `os.` subdomain, not the running product.

| You see | What it means |
| --- | --- |
| Mission Control | Real CLI probes. A binary on PATH is not a connected chat session. |
| Unified Chat labeled **Dry run** / **API preview** / **chat not wired** | Safety is visible in the UI. Cursor is not faked. |
| Workspace sandbox | Preview is jailed to `~/.hermes-agent-os/workspace` and `exports`. |
| Machine Control with **Run command disabled** | Computer-control stays gated. |
| Honest **Not configured** tiles | Studio image/voice/music and missing keys stay missing. |

---

## Local v1 in one pass

1. Open **Mission Control**. Read CLI / dashboard chat / live-execution for each agent.
2. Open **Unified Chat**. Send a dry-run. Cursor stays unwired; Claude/Hermes plan; Codex can preview if a local key exists.
3. Keep `HERMES_AGENT_OS_ENABLE_EXEC=0` unless you later decide to enable live tools.

```mermaid
flowchart LR
  You["You in the browser"] --> UI["React dashboard"]
  UI --> API["Local Express APIs"]
  API --> Store["Sandbox folders"]
  API --> CLIs["agent / claude / hermes / codex"]
  API --> Gate{"Execution gate"}
  Gate -->|off by default| Dry["Dry-run plan only"]
  Gate -->|explicitly on later| Live["Native tools"]
```

**Stack:** React 18 + TypeScript + Vite on the front. Node / Express on the back. Tests with Node’s built-in test runner.

---

## Feature status (honest)

| Surface | State |
| --- | --- |
| Mission Control (default landing) | Live local CLI + chat-capability checks |
| Unified Chat | Dry-run for Claude / Hermes; Codex API preview when a key is saved; Cursor CLI detected, chat not routed |
| Workspace preview | Live, sandboxed; Loop briefings in `loop/` |
| Workflow studio / Agent Builder + AI APIs | Wired; Codex generation needs a local key; native runs gated |
| Goals / Kanban / Memory / Notebook / Journal / Loop | Live local stores |
| Capability map | Live/partial/missing checklist for this machine |
| Studio | Honest **Not configured / Parked** except local video tools when present |
| Machine Control | Status only — no send/run |
| OpenClaw | Detected if installed; not faked |
| Overnight Goal Mode | Optional; **execution stays off** by default |
| Hosted multi-tenant SaaS | **Not this product** |

---

## Run it locally

Needs **Node 18+**. This is a local app.

```bash
git clone https://github.com/hharsha98/agent-os.git
cd agent-os
cp .env.example .env
npm ci
npm run build
npm start
```

Open [http://127.0.0.1:8090](http://127.0.0.1:8090).

The server loads `.env` at startup and **does not override** variables already in the process environment. `.env` is optional if you only want the dry-run dashboard.

Hot reload while hacking:

```bash
npm run dev
```

That serves the Vite UI on [http://127.0.0.1:5173](http://127.0.0.1:5173) and proxies `/api` to port **8090** (or `PORT` from the process environment / `.env`).

Leave these **off** unless you later decide otherwise (already `0` in `.env.example`):

```bash
HERMES_AGENT_OS_ENABLE_EXEC=0
HERMES_AGENT_OS_ENABLE_INSTALL=0
HERMES_AGENT_OS_PUBLIC_MODE=0
```

`.env` is gitignored. Never commit API keys.

---

## Verify (no Docker required)

```bash
npm run build
env -u HERMES_HOME npm test
npm start   # in one terminal
npm run smoke:local
```

`smoke:local` hits health, Mission Control product status, Unified Chat dry-run plans, workspace, and the execution gate. **CI uses this native path only** — Docker is never required to verify or ship.

---

## Optional: Docker on your Mac

Only if you already have Docker Desktop and prefer a containerized dashboard process:

```bash
cp .env.example .env
docker compose up --build
```

Host port **8090**. Host-installed CLIs (`agent`, `claude`, `hermes`, `codex`) are **not** injected into the container. Prefer the native `npm start` path for demos that need CLI probes.


---

## Why the safety story matters

Most agent dashboards look impressive and then silently run shell. This one is built the other way around:

1. Show what is actually installed.
2. Let you plan in **dry-run**.
3. Keep computer-control, installs, and public mode behind explicit flags.
4. Preview generated files only inside a sandbox.

---

## Repo map

```text
src/                 Dashboard (Mission Control, Chat, Phase 2 pages)
server/              Express APIs, workspace sandbox, memory, goals
test/                Runtime + workspace + local-agent tests
scripts/local-smoke.js   Native smoke (no Docker)
docs/                Static gallery and product tour
.env.example         Safe defaults — copy to .env
```

---

<p align="center">
  <sub>Local-first · MIT · <a href="https://github.com/hharsha98/agent-os">hharsha98/agent-os</a></sub>
</p>
