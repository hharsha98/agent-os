# Product tour

The [static gallery](https://hharsha98.github.io/agent-os/) is a walkthrough, not the running app. Clone the repo to use Mission Control and Unified Chat on your machine.

## 1. Mission Control (default landing)

The dashboard probes **Cursor, Claude, Codex, Hermes, and OpenClaw** on PATH.

Scores are **CLIs found**, not “4/4 agents connected”. Dashboard chat is a separate column: dry-run, API preview, or not wired.

## 2. Unified Chat

One composer, four agents. Labels are the product:

- **Dry run** — plan only, no live tools
- **API preview** — Codex with a local key; still not a tool-using run
- **CLI found · chat not wired** — Cursor is installed, routing is not faked
- Session history stays in the tab — not a cloud inbox

## 3. Workspace sandbox

Generated HTML/images/audio/video would land here. Listing cannot walk `../` out of `~/.hermes-agent-os/workspace` and `exports`. HTML preview uses a sandboxed iframe.

## 4. Machine Control

This page is a **permission checklist**, not a remote-control panel. `Run command` is disabled. Execution gate and voice-shell gate stay off in the default config.

## 5. Everything else

| Page | Honest empty / parked state |
| --- | --- |
| Goals | Dry-run loop only — no overnight execution claim |
| Kanban | Real local board, empty until you add cards |
| Memory | Counts first; content after search/open |
| Studio | Image / ElevenLabs-style voice / music **not** connected |

## Run the real app

```bash
git clone https://github.com/hharsha98/agent-os.git
cd agent-os
cp .env.example .env
npm ci && npm run build && npm start
```

Then open http://127.0.0.1:8090
