# Prompt For Claude Code Or Codex

Use this prompt with Claude Code, Codex, or another local coding agent after placing the Hermes Agent OS zip on the same machine.

```text
You are helping me install and verify Hermes Agent OS Runtime from a local zip package.

Zip file:
Hermes-Agent-OS-focused-agent-control-2026-07-07.zip

Goal:
Install it locally, configure safe first-run defaults, verify the backend/dashboard, and leave exact URLs, commands, and module readiness results.

Rules:
- Do not upload or expose API keys.
- Do not invent connected status. Verify with `/api/modules`, `/api/os/kernel`, `/api/os/audit`, `/api/setup`, `/api/setup/providers`, `/api/setup/providers/ollama/models`, `/api/router`, `/api/router/status`, `/api/router/health`, `/api/usage`, `/api/usage/import/preview`, `/api/usage/import`, `/api/usage/reconciliation`, `/api/scheduler`, `/api/memory`, `/api/skills`, `/api/skills/marketplace`, `/api/skills/publishers`, `/api/workflows`, workflow run replay endpoints, and `/api/builder/replay-overlay`.
- Keep execution disabled by default:
  HERMES_AGENT_OS_ENABLE_EXEC=0
  HERMES_AGENT_OS_ENABLE_INSTALL=0
  HERMES_AGENT_OS_SCHEDULER=1
  HERMES_AGENT_OS_SCHEDULER_POLL_MS=30000
- Do not overwrite an existing `.env` without backing it up.
- Do not expose Ollama publicly.
- Do not claim the real Agent Builder is executable unless Convex, Clerk, Firecrawl, and LLM keys are configured and `/api/builder/status` confirms it is live.

Tasks:

1. Locate the zip file, usually:
   ~/Desktop/Hermes-Agent-OS-focused-agent-control-2026-07-07.zip

2. Create an install folder:
   ~/Desktop/Hermes-Agent-OS

3. Unzip the package there.

4. Find the folder containing `package.json`; use that as the app root.

5. Inspect:
   - README.md
   - SETUP-GUIDE.md
   - AUDIT.md
   - .env.example
   - package.json

6. Install and verify:
   npm install
   npm test
   npm run build

7. Create `.env` from `.env.example` if missing. If `.env` exists, back it up first.

8. Set safe local defaults:
   PORT=4173
   HERMES_AGENT_OS_HOME=~/.hermes-agent-os
   HERMES_AGENT_OS_ENABLE_EXEC=0
   HERMES_AGENT_OS_ENABLE_INSTALL=0
   HERMES_AGENT_OS_SCHEDULER=1
   HERMES_AGENT_OS_SCHEDULER_POLL_MS=30000
   HERMES_AGENT_OS_PUBLIC_MODE=0
   HERMES_AGENT_OS_REQUIRE_AUTH=0
   HERMES_AGENT_OS_ADMIN_TOKEN=placeholder-admin-token
   HERMES_BUILDER_PORT=3100
   OLLAMA_HOST=http://127.0.0.1:11434
   HERMES_FFPROBE_PATH=
   HERMES_FFMPEG_PATH=
   HERMES_WHISPER_PATH=
   HERMES_VIDEO_STT_PROVIDER=auto
   HERMES_VIDEO_GROQ_STT_MODEL=whisper-large-v3-turbo
   HERMES_VIDEO_OPENAI_STT_MODEL=whisper-1
   HERMES_GROQ_STT_URL=
   HERMES_OPENAI_STT_URL=
   HERMES_VIDEO_STT_TIMEOUT_MS=600000
   HERMES_VIDEO_CLOUD_STT_MAX_MB=100
   HERMES_VIDEO_STT_LANGUAGE=
   HERMES_VIDEO_WHISPER_TIMEOUT_MS=600000
   HERMES_VIDEO_FFMPEG_TIMEOUT_MS=600000

9. Leave provider keys blank unless supplied:
   OPENROUTER_API_KEY=
   OPENROUTER_MANAGEMENT_KEY=
   MINIMAX_API_KEY=
   ANTHROPIC_API_KEY=
   OPENAI_API_KEY=
   OPENAI_ADMIN_KEY=
   GEMINI_API_KEY=
   FIRECRAWL_API_KEY=
   HERMES_FIRECRAWL_SCRAPE_URL=
   HERMES_FIRECRAWL_SEARCH_URL=
   NEXT_PUBLIC_CONVEX_URL=
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
   CLERK_SECRET_KEY=
   CLERK_JWT_ISSUER_DOMAIN=

10. Start the app:
    npm start

11. Verify:
    curl http://localhost:4173/api/health
    curl http://localhost:4173/api/os/kernel
    curl http://localhost:4173/api/modules
    curl http://localhost:4173/api/os/audit
    curl http://localhost:4173/api/setup
    curl http://localhost:4173/api/setup/providers
    curl http://localhost:4173/api/setup/providers/ollama/models
    curl http://localhost:4173/api/router
    curl http://localhost:4173/api/router/status
    curl http://localhost:4173/api/router/health
    curl http://localhost:4173/api/usage
    curl -X POST http://localhost:4173/api/usage/import/preview \
      -H 'Content-Type: application/json' \
      -d '{"provider":"anthropic","sourceName":"install smoke invoice","text":"date,provider,model,units,cost,currency,invoice_id,line_id\n2026-07-01,anthropic,claude-3-5-sonnet,1200,0.42,usd,inv_smoke,line_smoke"}'
    curl http://localhost:4173/api/usage/reconciliation
    curl http://localhost:4173/api/scheduler
    curl http://localhost:4173/api/memory
    curl http://localhost:4173/api/skills
    curl http://localhost:4173/api/skills/marketplace
    curl http://localhost:4173/api/skills/publishers
    curl -X POST http://localhost:4173/api/skills/memory-curator/dependencies/prepare
    curl http://localhost:4173/api/workflows
    curl http://localhost:4173/api/builder/status
    curl http://localhost:4173/api/builder/bootstrap
    curl -X POST http://localhost:4173/api/builder/bootstrap/prepare
    curl -X POST http://localhost:4173/api/builder/smoke-test
    curl http://localhost:4173/api/builder/logs

    Create a workflow run and replace `<run-id>` below with the returned id:
    curl -X POST http://localhost:4173/api/workflows/blank-open-agent-builder/run \
      -H 'Content-Type: application/json' \
      -d '{"trigger":"setup-check"}'
    curl 'http://localhost:4173/api/builder/replay-overlay?workflowId=blank-open-agent-builder&runId=<run-id>'

12. Open:
    http://localhost:4173

13. Confirm:
    - Setup page loads.
    - Setup provider guides load through `/api/setup/providers`, show configured field names only, expose the Ollama model pull helper as dry-run by default, and `/api/setup/providers/ollama/models` returns either real local model inventory or an honest setup/error state.
    - The dashboard does not show a Kernel page/card, and `/api/os/kernel` still proves runtime core, scheduler, memory, skill registry, router, workflow engine, usage ledger, builder adapter, and safety status as an internal API check.
    - Workflows page loads, can run the blank workflow, and returned runs include node attempts, traversed edges, graph mode, branch IDs, parallel group IDs when fan-out exists, replayable events, and replay graph data through `/api/workflows/:id/runs/:runId/replay`.
    - `/api/builder/replay-overlay?workflowId=blank-open-agent-builder&runId=<run-id>` returns sanitized overlay mode, DOM selectors, summary, node badges, and traversed edges with no local paths or secrets.
    - Agent Builder page loads, shows real upstream builder source, supervisor state, Convex/Clerk bootstrap checklist, smoke-test result, sanitized logs, and a replay overlay URL when a workflow run is selected.
    - Provider Router page loads.
    - Provider Router health page/API returns setup states until keys/endpoints are configured, then safe no-completion probe results.
    - Claude Code, Codex, OpenCode, and OpenClaw module runs stay dry-run unless `HERMES_AGENT_OS_ENABLE_EXEC=1` and the request sends `dryRun:false`.
    - Structured CLI adapter responses include adapter id, exit code, duration, byte counts, redacted stdout/stderr, and no raw local paths or token-like secrets.
    - Usage Credits page loads and `/api/usage` returns budget/ledger state.
    - Billing import preview works through `/api/usage/import/preview`, rejects unsafe text, and reports valid/invalid/duplicate rows without storing raw invoice text.
    - Billing reconciliation loads through `/api/usage/reconciliation`; OpenRouter and OpenAI sources require their optional billing/admin keys, while providers without supported billing APIs point to billing import/manual infrastructure records instead of fake API claims.
    - Scheduler page loads and `/api/scheduler` returns jobs, targets, action lists, approval summary, and `lock.mode: "leader_lock"` with no real home path.
    - Scheduler can create self-module jobs with `action:"goal_loop"` for Goals; approval-gated scheduled runs must pause as `waiting_approval`, create a Kanban approval card, and wait until `/api/scheduler/jobs/:id/approve`.
    - Memory page loads and `/api/memory` returns local memory summary plus vector state; `/api/memory/search?mode=hybrid` works without exposing raw vectors.
    - Memory vector config supports `provider:"qdrant"` for an optional remote Qdrant collection; Qdrant API keys stay write-only and public state only reports `hasApiKey`.
    - Skills page loads and `/api/skills` returns sample skills, signed external bundle counts, signed dependency status, marketplace update counts, publisher trust/allow/block counts, install/test/update state, and no raw configured secrets.
    - Skill marketplace loads through `/api/skills/marketplace`, supports saved feeds, fetched signed skills, trusted publishers, publisher reputation, signed dependency metadata, update channel state, allow/block policy state, and no raw feed secrets.
    - Skill publishers load through `/api/skills/publishers`, showing reputation, allowlist state, blocklist state, and import eligibility.
    - Workflows API returns only the hidden blank builder workflow on a fresh install; no demonstration workflows are seeded.
    - A workflow run returns node run status and stays dry-run unless execution is enabled.
    - Workflow `moduleId:"kanban"` tool nodes create source-linked Kanban task cards, and user approval nodes create/update Kanban approval cards.
    - Self modules are connected: Goals, Notebook, Kanban, Usage Credits.
    - Goals can create a local goal and run `/api/self/goals/:goalId/loop` through Provider Router in dry-run mode, producing next action/history and `goal_loop` usage without raw local paths or keys.
    - SEO and Video do not appear in the normal dashboard; they are parked backend modules for a later release.
    - Provider modules remain ready_to_configure until keys/endpoints are added.
    - CLI modules are connected only when the CLI/path exists.
    - OpenClaude remains missing/manual unless a real local compatible CLI path is configured.

14. If Docker is requested:
    docker compose up --build
    curl http://localhost:4173/api/health
    npm run smoke:docker

    In CI, use:
    HERMES_DOCKER_SMOKE_REQUIRED=1 npm run smoke:docker

15. Final response must include:
    - app root path
    - dashboard URL
    - health endpoint result
    - test/build result
    - setup status
    - guided provider setup status
    - Ollama model inventory status
    - kernel status
    - router status
    - provider health status
    - usage credits status
    - usage billing import status
    - usage billing reconciliation status
    - scheduler status and leader lock state
    - memory status
    - skill registry status, dependency suggestions, and release notes
    - workflow status
    - latest workflow event replay status
    - builder replay overlay status
    - builder supervisor status
    - builder bootstrap and smoke-test status
    - Docker smoke status when Docker was available
    - connected modules
    - modules needing configuration
    - `.env` path
    - next steps for Ollama, OpenRouter, MiniMax, and Firecrawl Builder
```
