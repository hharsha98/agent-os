# Handoff — Contabo

## Live operator (use this for the public host)

The running problem is `agent-os-demo.service` with `DEMO_PUBLIC=1`. That mode never calls OmniRoute, Hermes, or OpenClaw.

Switch the host to the live unit:

1. Build `/opt/agent-os` (`npm ci && npm run build`).
2. Copy `deploy/live.env.example` to `/etc/agent-os/live.env` (`chmod 600`).
3. Set `OMNIROUTE_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `HERMES_AGENT_OS_ADMIN_TOKEN`, and `HERMES_HOME`.
4. Edit `deploy/agent-os-live.service` so `User=` / `Group=` are the account that owns Hermes and the OpenClaw gateway. Install it to `/etc/systemd/system/agent-os-live.service`.
5. `sudo systemctl disable --now agent-os-demo` and `sudo systemctl enable --now agent-os-live`.
6. Caddy stays `reverse_proxy 127.0.0.1:8090` for `agentos.169.58.185.43.sslip.io`.

Expect `GET /api/health` to report `"demoPublic": false` and `"liveChat": true`. `GET /api/live/status` reports OmniRoute and the gateway host, never the key. The UI asks for the admin token before chat runs.

OpenClaw chat completions are disabled in upstream defaults until `gateway.http.endpoints.chatCompletions.enabled` is true. Hermes tools run only when `hermes` is on PATH for that user and `HERMES_AGENT_OS_ENABLE_EXEC=1`.

Point Hermes's own model provider at OmniRoute if you want the Hermes process itself to use that gateway. Agent OS does not invent that key.

## Optional public gallery

Host a sandboxed walkthrough only when you explicitly want canned Demo seats. Visitors get Mission Control, Unified Chat, Workspace, a gated Machine Control preview, and a local workflow canvas. They do **not** get a shell, and the UI must not claim their Claude, Cursor, Codex, or Hermes is connected.

Badge everywhere: **Public demo · sandboxed**.

Example URL shape:

```text
https://agentos.169.58.185.43.sslip.io/
```

Replace the IP with the VPS address. [sslip.io](https://sslip.io) maps that name to the IP so Caddy can get a certificate without a custom domain.

## What this mode is

| Flag | Meaning |
| --- | --- |
| `DEMO_PUBLIC=1` | Simulated demo fleet, rich chat plans, timeline notes, seeded workspace, local canvas |
| `HERMES_AGENT_OS_PUBLIC_MODE=0` | Leave this **off** for an open demo. It is an admin lock, not the demo switch |
| `HERMES_AGENT_OS_ENABLE_EXEC=0` | Keep this off. Demo mode also **locks** the execution gate if it is set to `1` |
| `HOST=127.0.0.1` | Recommended behind Caddy on the same machine |
| `PORT=8090` | App port. Caddy proxies to it |

`DEMO_PUBLIC=1` refuses arbitrary machine commands, refuses install execution, and forces voice shell off. Workspace writes stay inside the sandbox (`.md`, `.txt`, `.html`).

The sandbox is **shared** by everyone who can open the URL. Do not paste secrets.

## One-time server setup

Needs Node 20+ (Node 18+ is enough to run).

```bash
sudo mkdir -p /opt/agent-os /var/lib/agent-os /etc/agent-os
sudo useradd --system --home /var/lib/agent-os --shell /usr/sbin/nologin agentos || true
sudo chown agentos:agentos /var/lib/agent-os
# copy this repo to /opt/agent-os (git clone or rsync). Do not copy a local .env with keys.
cd /opt/agent-os
sudo npm ci
sudo npm run build
sudo cp deploy/demo.env.example /etc/agent-os/demo.env
sudo cp deploy/agent-os-demo.service /etc/systemd/system/agent-os-demo.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-os-demo
```

Check:

```bash
curl -s http://127.0.0.1:8090/api/health
```

Expect `"demoPublic": true`, `"badge": "Public demo · sandboxed"`, and `"bind": "127.0.0.1"` when `HOST=127.0.0.1`.

From a checkout with dependencies installed:

```bash
BASE_URL=http://127.0.0.1:8090 npm run smoke:public
```

`npm run smoke:public` with no `BASE_URL` starts its own temporary server, so it does not need the systemd unit.

## Caddy

Install Caddy, then use `deploy/Caddyfile.example`. Point the site name at your IP’s sslip.io host and reload Caddy.

```caddyfile
agentos.169.58.185.43.sslip.io {
  reverse_proxy 127.0.0.1:8090
}
```

Open ports **80** and **443** on the VPS firewall for Caddy. Leave **8090** closed to the public internet when `HOST=127.0.0.1`.

If you must reach Node directly (no local proxy), unset `HOST` so the app binds `0.0.0.0` and open 8090. Prefer the proxy.

## Walkthrough to click before you call it live

1. `/` or `/?page=mission` — demo agents say **Demo**. Copy does not say your Claude is connected.
2. Chat — send a prompt, then **Run simulated timeline**.
3. Workspace — open `demo/latest-timeline.md`, write a note.
4. Machine Control — preview a canned scenario. **Run command** stays disabled.
5. Demo canvas — simulate a run. No Convex key.

## Explicitly out of scope

- Turning on `HERMES_AGENT_OS_ENABLE_EXEC` for this public URL
- Putting API keys in `/etc/agent-os/demo.env`
- Sharing one login across tenants (this is one sandbox)
- The vendored Firecrawl builder (it still wants Convex/Clerk). The demo canvas replaces it for the public walkthrough
