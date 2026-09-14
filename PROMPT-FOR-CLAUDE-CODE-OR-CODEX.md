# Prompt For Claude Code Or Codex

Paste this into a local coding agent after cloning Agent OS.

```text
You are helping me install and verify Agent OS as a local-first dashboard.

Source:
git clone https://github.com/hharsha98/agent-os.git

If a zip is present instead, use the folder that contains package.json. Do not invent a hosted SaaS install.

Goal:
Install locally, keep dry-run defaults, verify Mission Control + Unified Chat + APIs, and report exact URLs.

Rules:
- Do not upload or expose API keys.
- Do not invent connected chat status. A CLI on PATH is not dashboard chat.
- Verify `/api/health`, `/api/local-agents`, `/api/product/status`, `/api/execution-gate`.
- Keep execution disabled:
  HERMES_AGENT_OS_ENABLE_EXEC=0
  HERMES_AGENT_OS_ENABLE_INSTALL=0
  HERMES_AGENT_OS_PUBLIC_MODE=0
- Do not overwrite an existing `.env` without backing it up.
- Default URL after `npm start` is http://127.0.0.1:8090
- Do not claim Agent Builder is live unless Convex, Clerk, Firecrawl, and LLM keys are configured.

Tasks:
1. Open the repo root (package.json present).
2. Read README.md, SETUP-GUIDE.md, docs/V1.md, .env.example.
3. npm ci && npm run build && env -u HERMES_HOME npm test
4. Copy .env.example to .env if missing.
5. npm start
6. curl http://127.0.0.1:8090/api/health
   curl http://127.0.0.1:8090/api/local-agents
   curl http://127.0.0.1:8090/api/product/status
   curl http://127.0.0.1:8090/api/execution-gate
7. Confirm Mission Control is the default UI and Unified Chat labels dry-run / not wired / API preview honestly.
8. Optional Docker: docker compose up --build (host port 8090). Host CLIs are not inside the container.

Final response must include:
- app root
- dashboard URL
- health + local-agents summary (cliFound, chatDryRun, notWired — not a fake connected count)
- test/build result
- execution gate state
- next optional step (save a Codex key, or install a CLI)
```
