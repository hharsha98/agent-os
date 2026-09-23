# Full product plan — local-first Agent OS

Agent OS is a **local-first operator OS**. The product you ship is a clone-and-run Node app on the machine that already has the agents. A desktop shell is not part of this release.

Hosted multi-tenant Live is out of scope. **AgentOps Studio** remains the hosted ops product. This repository does not replace it and does not publish a public Live URL.

The earlier public Contabo Caddy site was removed. Do not bring that hostname back as a product URL. A private loopback process for the owner (`127.0.0.1:8090`, or the same port on a VPS reached by SSH) may remain. That process is an operator console, not a marketing demo.

## Product form

| Surface | What it is |
| --- | --- |
| Clone / `npm start` | Primary distribution. Binds `127.0.0.1:8090`. Dry-run until the owner turns a gate on. |
| [github.io static gallery](https://hharsha98.github.io/agent-os/) | Marketing screenshots. Not a runtime. |
| `DEMO_PUBLIC=1` | Optional local gallery for screenshots. Simulated agents, execution locked. Not a public host. |
| Live operator lane (`AGENT_OS_LIVE_CHAT=1`, gallery off) | Text and, only if execution is on, native CLIs — for the owner of that machine. |
| Private VPS | Optional. Bind loopback. Reach it with an SSH tunnel. If anything reverse-proxies it, require auth. See [HOSTING.md](HOSTING.md). |
| Public Internet Live | Out of scope. |

Defaults in `.env.example` stay safe: execution off, install off, public mode off, gallery off, live chat off, `HOST=127.0.0.1`.

The sections below describe the live operator lane that already exists in this repo. They are implementation notes for that lane on one machine. They are not a plan to host Agent OS for strangers.

This is not multi-tenant SaaS. There is no billing, no Cloudflare card flow, and no invented provider keys.

## 1. What the repo did before the live lane

This table is the snapshot from before the live operator lane. Sections 2–7 are that lane, and it is in the repo now. Distribution is the product-form table above.

| Layer | Reality |
| --- | --- |
| UI | React dashboard in `src/DashboardRoot.tsx`. Landing is Mission Control. Unified Chat, Hermes, and OpenClaw are separate pages. |
| API | Express in `server/index.js`. Module runs go through `runModule` in `server/runtime/modules.js`. |
| Chat | `src/pages/ChatPage.tsx` always sends `dryRun: true`, except Codex which may call `/api/agent-os/codex/preview`. Cursor is an honest “not wired” notice. OpenClaw is not in the composer. |
| Hermes click | `src/pages/HermesPage.tsx` is a status desk. `runHermesControl` treats a message as a **Kanban create**, and only after `HERMES_AGENT_OS_ENABLE_EXEC=1` and `dryRun: false`. |
| OpenClaw click | `src/pages/OpenClawPage.tsx` shows PATH detection. The install button is disabled. Live CLI args already exist (`openclaw agent --message …`) but only behind the execution gate. |
| OmniRoute | Catalog entry in `server/runtime/api-integrations.js`. Save + `GET {base}/models` test. **No chat completion path** uses it. |
| Provider router | `server/runtime/router.js` knows Ollama, OpenRouter, MiniMax, OpenAI, Anthropic, Gemini. OmniRoute is not a provider. Execution still needs the execution gate. |
| Public demo | `DEMO_PUBLIC=1` (`server/runtime/demo-public.js`) rewrites the fleet as simulated **Demo** seats. `applyDemoExecutionLock` forces the execution gate off even if `HERMES_AGENT_OS_ENABLE_EXEC=1`. Chat calls `/api/demo/chat` and `/api/demo/timeline`. |
| Private units | `deploy/agent-os-live.service` is an optional loopback operator unit. `deploy/agent-os-demo.service` is an optional local screenshot gallery (`DEMO_PUBLIC=1`). Neither is a public product URL. The gallery user does not own `~/.hermes` or the OpenClaw gateway. |
| Auth | `HERMES_AGENT_OS_REQUIRE_AUTH=1` or `HERMES_AGENT_OS_PUBLIC_MODE=1` requires `HERMES_AGENT_OS_ADMIN_TOKEN`. Login exists (`/api/admin/login`) but the v1 shell does not prompt for it. |

## 2. Target architecture

```text
Browser (Mission Control, Unified Chat, Hermes, OpenClaw)
        |
        v
Express  -- DEMO_PUBLIC=1 --> canned gallery (unchanged contract)
        |
        +-- dry-run toggle ON --> existing dry-run plans (no tools)
        |
        +-- live chat lane (AGENT_OS_LIVE_CHAT=1, demo off)
                |
                +-- Hermes seat
                |     1. hermes chat --oneshot -Q --query-file   (only if ENABLE_EXEC=1 and CLI exists)
                |     2. OmniRoute POST /v1/chat/completions     (labeled, not native tools)
                |
                +-- OpenClaw seat
                |     1. Gateway POST {OPENCLAW_GATEWAY_URL}/chat/completions
                |     2. openclaw agent --message                (only if ENABLE_EXEC=1 and CLI exists)
                |     3. OmniRoute fallback, labeled
                |
                +-- Claude / Codex / Cursor seats
                      1. native CLI print/exec mode only if ENABLE_EXEC=1 and that binary exists
                      2. OmniRoute seat completion, labeled
                      3. Codex API preview only when an OpenAI key exists and OmniRoute is not configured

Mission run (one operator action)
        hermes seat + openclaw seat, then write workspace/missions/latest.md
```

Two gates stay separate:

| Gate | Env | What it unlocks | What it does not unlock |
| --- | --- | --- | --- |
| Gallery | `DEMO_PUBLIC=1` | Simulated fleet, timeline note, canvas | Host CLIs, OmniRoute, gateway |
| Live chat | `AGENT_OS_LIVE_CHAT=1` | OmniRoute chat completions and OpenClaw gateway HTTP | Arbitrary shell, installs, Machine Control run |
| Host execution | `HERMES_AGENT_OS_ENABLE_EXEC=1` | Known agent CLIs (Hermes oneshot, OpenClaw agent, Claude `-p`, Codex `exec` read-only, Cursor print) and existing Kanban/gateway controls | A free-form shell box |

`AGENT_OS_LIVE_CHAT=0` forces the live lane off even if the execution gate is on. Default in `.env.example` stays `0`, so a fresh clone remains dry-run. A private operator file may set the live lane to `1` on that machine only. It does not publish a URL. `deploy/live.env.example` leaves execution off until the owner turns it on.

Machine Control stays a checklist. This plan does not add a public “run any command” button.

## 3. Gaps this change closes

1. Do not ship Agent OS as a public Live site. `DEMO_PUBLIC=1` is a local screenshot switch, not production.
2. Unified Chat Send must be able to call a real transport, with an explicit dry-run toggle.
3. Hermes and OpenClaw pages need a message box that uses the same dispatcher as chat.
4. Mission Control cards should open the matching desk and show transport truth (CLI, gateway, OmniRoute), not a Demo badge, when the gallery flag is off.
5. LLM calls from the live lane go through OmniRoute’s OpenAI-compatible API. Keys stay in env or the local connection store.
6. A live status endpoint and smoke script prove the wiring without requiring the real VPS in CI.
7. Docs tell the operator which user the systemd unit must run as so `hermes` and `openclaw-gateway` are visible.

## 4. OmniRoute integration

Required env (never commit values):

| Variable | Role |
| --- | --- |
| `OMNIROUTE_BASE_URL` | OpenAI-compatible base, including `/v1`. Example shape: `http://127.0.0.1:20128/v1` on the same machine. |
| `OMNIROUTE_API_KEY` | Endpoint key from the OmniRoute dashboard. Sent only as `Authorization: Bearer` from the server. |
| `OMNIROUTE_MODEL` | Optional. Default `auto`. |

Resolution order: process env, then the saved AI API profile `ai-source-omniroute` (`BASE_URL`, `API_KEY`, `MODEL`). Env wins.

Calls:

- Health: `GET {base}/models`
- Chat: `POST {base}/chat/completions` with `{ model, messages }`

The provider router gains an `omniroute` provider at the front of the fallback list. It is “connected” only when a base URL and key resolve. Router execution of that provider is allowed when the execution gate is on **or** the live-chat lane is on, and the request sets `dryRun: false`. Other providers keep the execution-gate rule.

Public status returns host, model, and `configured`. It never returns the key.

## 5. Hermes wiring

Native command (argv, no shell), prompt written to a mode `0600` file under the runtime store:

```text
hermes chat --oneshot -Q --query-file <file>
```

Optional `HERMES_CHAT_TOOLSETS` is appended as `--toolsets` when set. `HERMES_HOME` (default `~/.hermes`) and `HERMES_CLI_PATH` are honored. Timeout: `HERMES_CHAT_TIMEOUT_MS` (default 120000).

This matches current Hermes CLI behavior: `--oneshot` / `-Q` answers and exits. A bare `hermes chat` would wait on a TTY and must not be used.

Native Hermes is a real tool-using process **only** when `HERMES_AGENT_OS_ENABLE_EXEC=1`. Hermes’s own model provider is whatever that profile is configured to use. To send Hermes’s own upstream calls through OmniRoute, point the Hermes profile at OmniRoute’s OpenAI-compatible endpoint (operator step, documented, not automated with a guessed key).

If the CLI is missing or the execution gate is off, and OmniRoute is configured, the seat still answers via OmniRoute and the response says `transport: "omniroute"` and `native: false`.

Kanban dispatch, gateway restart, and task controls stay on their existing endpoints. Chat does not create a Kanban card as a side effect.

## 6. OpenClaw wiring

Gateway HTTP (preferred when `openclaw-gateway` already runs on the same machine):

| Variable | Role |
| --- | --- |
| `OPENCLAW_GATEWAY_URL` | Base including `/v1`. Loopback example: `http://127.0.0.1:18789/v1` |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token (`OPENCLAW_GATEWAY_TOKEN` / gateway auth token). Omit only if the gateway auth mode is `none` on loopback. |
| `OPENCLAW_GATEWAY_MODEL` | Default `openclaw/default` |

`POST {base}/chat/completions` with `Authorization: Bearer <token>` when a token is set. The OpenClaw chat-completions endpoint is **disabled in upstream defaults** until `gateway.http.endpoints.chatCompletions.enabled` is true. A 404 or 405, or a connection that never reached the gateway (refused or DNS), falls through. A timeout, reset, or other response stays an error so the same prompt is not sent to a second executor.

CLI fallback, only with the execution gate. The message is one argv (`--message=<text>`) so a prompt that starts with `-` is not parsed as a flag:

```text
openclaw agent --message=<text> --thinking high
```

Same OmniRoute labeled fallback as Hermes when neither gateway nor CLI can run.

OpenClaw joins Unified Chat.

## 7. Cursor, Claude, Codex

| Seat | Native (needs CLI + `HERMES_AGENT_OS_ENABLE_EXEC=1`) | Otherwise |
| --- | --- | --- |
| Claude | `claude --output-format text -p -- <message>` | OmniRoute seat, or the existing dry-run plan |
| Codex | `codex exec --ephemeral --skip-git-repo-check --sandbox read-only --color never -- <message>` | OmniRoute chat completions; if OmniRoute is unset and an OpenAI key exists, the existing Codex API preview |
| Cursor | `agent -p -- <message>` (override with `CURSOR_CLI_ARGS` using `{{message}}`; `--` is inserted before the prompt) | OmniRoute seat, or the honest not-wired notice when live chat is off |

Native Cursor/Claude/Codex runs can change a workspace. They stay behind the execution gate. Live chat without that gate still gets an OmniRoute answer and says the native CLI did not run.

## 8. Auth and safety

- Gallery mode keeps the execution lock. Live routes refuse to run while `DEMO_PUBLIC=1`.
- Prompts are passed as argv or a private query file, never through a shell string. Positional prompts sit after `--`.
- Native CLI children get a short environment (PATH, HOME, and `HERMES_HOME` for Hermes) and a temp working directory. Configured API keys are stripped from replies before they leave the process.
- Replies and logs go through existing redaction. Status payloads omit secrets and absolute home paths where the current public APIs already do.
- Machine Control does not gain a shell runner.
- Installer execution stays behind `HERMES_AGENT_OS_ENABLE_INSTALL`.
- The private operator example sets `HERMES_AGENT_OS_REQUIRE_AUTH=1` and leaves `HERMES_AGENT_OS_ADMIN_TOKEN` empty in git. The owner fills the token on that machine.
- The v1 shell shows a token login when `/api/admin/session` says auth is required and the cookie is missing.
- Bind `HOST=127.0.0.1`. Do not publish port 8090. Remote personal use is an SSH tunnel. See `docs/HOSTING.md`.
- The workspace on a shared process is one sandbox. Do not paste upstream provider secrets into notes.

## 9. Private operator host

The primary install is still `npm start` on the laptop. A systemd unit is optional, for a machine the owner already administers.

`deploy/agent-os-demo.service` is only the local screenshot gallery. `deploy/agent-os-live.service` plus `deploy/live.env.example` are the private operator lane:

- `HOST=127.0.0.1`
- `DEMO_PUBLIC=0`
- `HERMES_AGENT_OS_PUBLIC_MODE=0`
- `AGENT_OS_LIVE_CHAT=1` so the owner can use OmniRoute and the gateway
- `HERMES_AGENT_OS_ENABLE_EXEC=0` until the owner explicitly wants native CLIs
- `HERMES_AGENT_OS_ENABLE_INSTALL=0`
- `HERMES_AGENT_OS_REQUIRE_AUTH=1`
- OmniRoute and OpenClaw gateway variables as placeholders, no public product host
- `HERMES_HOME` pointing at the real profile directory
- `User=` / `Group=` = the Unix account that already runs Hermes and OpenClaw (often the human operator, not `agentos` with a nologin home)

Do not publish port 8090. Do not put a public reverse proxy in front of this app. Remote use is an SSH tunnel; auth is required if a proxy is ever added. See `docs/HOSTING.md`. OmniRoute stays its own process. This repo does not reinstall OmniRoute or OpenClaw.

Installing that unit is an owner step: secrets go in `/etc/agent-os/live.env` (mode `0600`), then `curl` `/api/health` and `/api/live/status` on loopback. This repository does not open a public site.

## 10. UI contract

- Mission Control: when `demoPublic` is false, copy describes live vs dry-run. Cards link to Chat (with the agent selected), Hermes, or OpenClaw. A live-mission action calls `POST /api/live/mission`.
- Unified Chat: dry-run checkbox. Default checked when live chat is off; unchecked when `AGENT_OS_LIVE_CHAT=1`. Send uses `POST /api/live/chat` for a live turn and the existing module dry-run for a dry turn. Badges show the transport (`Hermes CLI`, `OpenClaw gateway`, `OmniRoute`, `Dry run`), not “Demo”, unless gallery mode is on.
- Hermes and OpenClaw pages: status plus a composer that hits the same live endpoint with `agentId` fixed.
- Gallery screens stay as they are when `DEMO_PUBLIC=1`.

## 11. Acceptance tests

Automated in this repo (no VPS, no real keys):

- OmniRoute config resolution and public redaction.
- `DEMO_PUBLIC=1` makes live dispatch refuse and keeps the execution lock.
- Dry-run module replies for Claude and Hermes still match `smoke:local`.
- Live dispatch with a fake `fetch` returns `transport: "omniroute"` and the model text.
- OpenClaw gateway request uses Bearer auth and `/chat/completions` when the URL is set.
- Hermes argv is `chat --oneshot -Q --query-file` and is skipped when the execution gate is off.
- `npm run smoke:local` still passes against a default server.
- `npm run smoke:public` still passes for the gallery.
- `npm run smoke:live` boots with `AGENT_OS_LIVE_CHAT=1` and `DEMO_PUBLIC=0`, asserts `/api/live/status`, and asserts a live chat without a key is `unavailable` (not a Demo plan).

Manual on the owner's machine after a private env is installed:

- `/api/health` has `demoPublic: false` and `bind` of `127.0.0.1` when `HOST=127.0.0.1`.
- `/api/live/status` shows OmniRoute configured and the gateway URL host.
- Unified Chat Hermes and OpenClaw return a non-canned reply.
- A mission writes `missions/latest.md` in the sandbox.

## 12. Phased checklist (this branch)

1. **Plan** — this file, committed before product code.
2. **Live lane** — `server/runtime/omniroute.js`, `server/runtime/live-chat.js`, routes `/api/live/status`, `/api/live/chat`, `/api/live/mission`, router provider.
3. **UI** — Chat toggle and OpenClaw seat, Hermes/OpenClaw composers, Mission Control links and mission action, admin login wall when auth is required.
4. **Deploy + docs** — local README, `docs/HOSTING.md`, private `deploy/live.env.example`. No public product URL.
5. **Verification** — unit tests, `smoke:local`, `smoke:public`, `smoke:live`, TypeScript build.

## 13. Honest leftovers

| Works via OmniRoute once `OMNIROUTE_BASE_URL` + `OMNIROUTE_API_KEY` are set | Still needs a machine-local CLI or daemon |
| --- | --- |
| Chat and mission text for every seat, labeled OmniRoute | Hermes tools, skills, Kanban, gateway restart (`hermes` + `HERMES_HOME` + execution gate) |
| Provider-router runs that select `omniroute` | OpenClaw tools and browser (`openclaw-gateway` with chat completions enabled, or the `openclaw` CLI) |
| Codex-style answers without an OpenAI key | Cursor file edits (`agent` CLI + execution gate) |
| | Claude Code repo edits (`claude` CLI + execution gate) |
| | Codex sandbox exec (`codex` CLI + execution gate) |
| | Studio image/voice/music, Firecrawl builder (Convex/Clerk), SEO/video providers |
| | Restarting a private systemd unit (owner) |

Parked on purpose: payments, multi-tenant accounts, a public Live URL, a desktop shell, Cloudflare, and a public shell.

## 14. Distribution decision

Recorded after the live lane shipped:

- Primary distribution is clone and run: Node 18+, `npm ci`, `npm run build`, `npm start`, [http://127.0.0.1:8090](http://127.0.0.1:8090).
- A desktop shell waits until a local Node install is not enough.
- github.io stays a static gallery.
- `DEMO_PUBLIC=1` stays an optional local simulation for screenshots.
- The live operator lane is for the owner of the machine: localhost, or a private VPS behind SSH. Auth is required if that process is ever reverse-proxied.
- Public multi-tenant Live, including the removed Contabo Caddy site, is not the product.
- AgentOps Studio remains the hosted ops product.
