# Agent OS Setup Guide

Agent OS is a local-first studio for creating visual AI-agent workflows with Codex API and running them through Hermes or OpenClaw. It starts with an empty user workspace and ships without demonstration workflows, API keys, private workflows, local profiles, logs, or dependency folders.

## Requirements

- Node.js 20 or newer
- npm
- macOS or Linux for native Hermes/OpenClaw execution
- A user-owned OpenAI API key for Codex-powered generation and previews

## Install and start

```bash
unzip Agent-OS-*.zip -d Agent-OS
cd Agent-OS
npm ci
npm run check
npm test
PORT=8090 npm start
```

Open [http://localhost:8090](http://localhost:8090). Verify the runtime at [http://localhost:8090/api/health](http://localhost:8090/api/health).

## Connect the Codex intelligence layer

1. Open **AI APIs** in Agent OS.
2. Enter your OpenAI API key.
3. Keep `gpt-5.3-codex`, or select another Responses API-compatible Codex model.
4. Choose a reasoning effort.
5. Click **Save & test**.

The key is saved only in the local server-side runtime store and is never returned to the browser. You can alternatively set:

```bash
OPENAI_API_KEY=your-key
AGENT_OS_CODEX_MODEL=gpt-5.3-codex
AGENT_OS_CODEX_REASONING_EFFORT=medium
AGENT_OS_OPENAI_BASE_URL=https://api.openai.com/v1
AGENT_OS_CODEX_TIMEOUT_MS=90000
```

Without a key, Agent OS remains usable for inspecting and editing saved workflows, but Codex generation and preview buttons stay locked instead of returning fake results.

## Install native runtimes

OpenClaw:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Hermes:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup
```

Use the OpenClaw or Hermes page inside Agent OS to test detection and configure runtime-specific connection fields. Use Provider Router to connect user-owned OpenRouter/MiniMax credentials or a local Ollama runtime.

## Build and run workflows

1. Describe an agent on Home, or open Agent Builder.
2. Build the workflow by prompting, adding steps, or dragging nodes on the canvas.
3. Select Hermes or OpenClaw under **Run with**.
4. Use **Codex preview** for a reasoning-only test.
5. Review each node, branch, approval gate, retry limit, and loop limit.
6. Use **Run Hermes/OpenClaw** only when you trust the workflow and local runtime configuration.
7. Approval nodes pause execution until **Approve & continue** is selected.

Native execution is protected by a local gate. It can be enabled persistently with:

```bash
HERMES_AGENT_OS_ENABLE_EXEC=1
```

Installer execution is separately protected by:

```bash
HERMES_AGENT_OS_ENABLE_INSTALL=1
```

## Connect additional AI sources

The **AI APIs** page contains project-specific install, start, configuration, authentication, model, base-URL, caveat, and health-test guidance for OmniRoute, CLIProxyAPI, Free LLM Gateway, GPT4Free, New API, Pollinations, Ollama, LocalAI, llama.cpp, and the Awesome Free LLM APIs reference directory.

Local gateways should remain bound to localhost unless you deliberately add authentication, TLS, and network controls.

## Security and private state

- Runtime state defaults to `~/.hermes-agent-os/`.
- Secret-bearing JSON files use owner-only permissions.
- API responses, logs, workflow proof, and exports redact secret values and private paths.
- Do not distribute your `.env`, runtime store, Hermes profiles, workflow runs, or installed dependency folders.
- For a public/VPS deployment, enable authentication and use HTTPS.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

Docker exposes the configured host port and persists Agent OS state in a volume. Host-installed native CLIs are not automatically available inside the container.

## Verification

```bash
npm run check
npm test
```

The test suite covers Codex structured workflow generation, missing-key safeguards, secret redaction, API integration guides, graph execution, retries, branches, loops, approvals, native OpenClaw invocation, Hermes controls, and clean exports.
