# Hermes Agent OS Real Control Plan

This plan narrows Hermes Agent OS around one believable localhost experience: a user opens the dashboard, clicks an agent, connects the real local/API dependency, runs a task, and sees proof through logs, files, memory, Kanban, and workflow replay.

## Product Focus

Current visible focus:

- Agent control rooms: Hermes Agent, Claude Code, Codex, Gemini, OpenCode, OpenClaw, OpenClaude, and local/open routing.
- Model providers: OpenAI, Anthropic, Gemini, OpenRouter, Ollama, MiniMax, and Firecrawl where required by the builder.
- Core OS modules: Goals, Notebook, Kanban, Memory, Scheduler, Skill Registry, Usage Credits, Provider Router, Workflows, and real Open Agent Builder.

Parked for later:

- SEO dashboard surface.
- Video dashboard surface.
- Hermes Kernel dashboard surface.

The SEO and Video backend modules can remain in the codebase as future modules, but they should not appear in the normal dashboard until the core agent loop feels real. Hermes Kernel should remain an internal diagnostic API only, not a normal dashboard module.

## Localhost User Flow

1. User runs `npm start` and opens `http://localhost:4173`.
2. Setup shows only the dependencies needed for the core loop: one model route, one controllable agent, memory, Kanban, and workflow runner.
3. User clicks an agent card, for example `Hermes`, `OpenAI`, `Codex`, or `Claude Code`.
4. The control room shows real dependency state, configuration fields, install/test actions, run controls, logs, and recent artifacts.
5. User sends a task.
6. The backend runs in dry-run by default; real execution requires the explicit server gate and request toggle.
7. Every run writes an OS event: run log, memory note, optional Kanban task, usage record, and workflow replay entry.
8. The dashboard shows the proof instead of a fake online badge.

## Agent Control Room Contract

Every visible agent/provider card must support the same minimum contract:

- `status`: connected, ready_to_configure, missing_dependency, error, disabled.
- `configure`: save local/API config without returning secrets.
- `test`: perform a real version, health, or model-list check.
- `run`: dry-run first, execute only with `HERMES_AGENT_OS_ENABLE_EXEC=1` and `dryRun:false`.
- `logs`: show recent sanitized stdout/stderr/API events.
- `proof`: show concrete artifacts produced by the run.

If a module cannot satisfy this contract, it should be hidden or marked as planned, not presented as a working OS control.

## Hermes Agent Desktop Control

Goal: clicking `Hermes` should control the local Hermes Agent installation from the dashboard.

Required backend adapter:

- Detect Hermes CLI/app/profile state.
- List local profiles without leaking paths or secret values.
- Start/stop/restart gateway where the local install allows it.
- Show gateway state, active profile, channel counts, platform connection state, launchd labels, and recent safe logs.
- Run safe channel smoke tests such as Telegram `getMe` without leaking profile env values.
- Send a task/message into Hermes through the real local Hermes interface.
- Store each result as a run event, memory item, and optional Kanban task.

Acceptance evidence:

- `GET /api/modules/hermes` reports real local readiness.
- `POST /api/modules/hermes/test` validates the local install.
- `POST /api/modules/hermes/run` inspects real profile gateway state and prepares a launchd gateway restart by dry-run.
- `POST /api/modules/gateway/run` inspects channel/platform state, prepares gateway restarts, and can run a gated Telegram `getMe` smoke test.
- Gated restart execution requires `HERMES_AGENT_OS_ENABLE_EXEC=1` and `dryRun:false`.
- Dashboard shows the same status as the local Hermes runtime, not a hardcoded badge.

## OpenAI / Provider Control

Goal: clicking `OpenAI` should fully control the user's OpenAI connection from the dashboard.

Required backend adapter:

- Configure `OPENAI_API_KEY`, optional `OPENAI_ADMIN_KEY`, and default model.
- Test via model-list or supported low-risk health endpoint.
- Run provider-router dry-runs and gated completions.
- Track usage estimates and supported billing reconciliation.
- Expose recent sanitized request metadata and errors.
- Force provider-card runs to the clicked provider, so `provider-openai` never silently falls back to OpenRouter/Ollama when OpenAI is missing.
- Record direct provider runs into Agent Runner proof, Memory, and Kanban handoff artifacts.

Acceptance evidence:

- Missing key shows `ready_to_configure`.
- Valid key shows `connected` after a real health check.
- A task run records usage, logs, memory, and optional Kanban output.
- Missing-key runs still create blocked proof with a Memory and Kanban next-action card.

## CLI Agent Control

Goal: Claude Code, Codex, Gemini CLI, OpenCode, OpenClaw, and OpenClaude behave like controllable local tools, not labels.

Required backend adapter:

- Detect binary/path and version.
- Save CLI path, args template, workspace, and timeout.
- Block workspace escapes.
- Dry-run commands by default.
- Execute only when the server gate and request gate are both enabled.
- Redact stdout/stderr before returning to the UI.
- Write every run to logs, memory, usage, and optional Kanban.

Acceptance evidence:

- Each CLI card can prove missing, configured, or connected from the local machine.
- Each run returns command, exit code, duration, stdout/stderr byte counts, and redacted output.
- Failed commands remain useful by creating a clear log and next action.

## Core Agent Loop

This is the real Agent OS loop to implement before adding more modules:

```text
Goal
  -> select agent/provider/tool
  -> run dry-run plan
  -> user approves execution
  -> execute real adapter
  -> write log + memory + usage
  -> create/update Kanban task
  -> expose replay/proof in dashboard
```

The dashboard should optimize around this loop. New modules should only be added after they plug into this loop.

## Implementation Order

1. Hide low-priority dashboard modules: SEO and Video, and keep Hermes Kernel internal-only.
2. Add an `Agent Runner` record type that stores run status, prompt, target module, dry-run/execute mode, output summary, log ids, memory ids, and Kanban ids.
3. Make all agent/provider control rooms use `Agent Runner` for task execution. Direct CLI/provider runs now return proof and write Memory/Kanban handoffs; deeper Hermes desktop actions remain.
4. Upgrade `Hermes` and `Hermes Gateway` from profile detection to real desktop/gateway control where local Hermes exposes safe commands. Profile/gateway inspection, Gateway channel status, dry-run launchd restart, gated Telegram smoke tests, gated Hermes Kanban task creation, read-only task status refresh, and Hermes task controls are implemented. Remaining depth: richer profile action UI plus channel message-send controls and worker retry/decompose/log follow-up.
5. Upgrade provider control from config/test to run, usage, billing, logs, health, model selection, and provider conversation sessions. Provider-card run/proof, supported billing reconciliation, provider-specific health checks, model inventory, model picker, dashboard execution opt-in, private local transcript state, and sanitized provider session responses are implemented for OpenAI/OpenRouter/MiniMax/Anthropic/Gemini/Ollama; live-key smoke remains dependent on user-owned keys.
6. Add controllable process sessions for local CLI agents. Claude Code/Codex/Gemini/OpenCode/OpenClaw/OpenClaude-compatible CLIs now share a session supervisor with dry-run preparation, gated real start, persisted status, redacted output tails, and dashboard stop control.
7. Add a proof panel to every control room: latest runs, logs, memory writes, files, and Kanban tasks. Initial proof panel is implemented for direct agent/provider runs and CLI sessions.
8. Revisit parked modules only after the core loop is credible.
