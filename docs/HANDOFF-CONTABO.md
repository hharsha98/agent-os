# Contabo public site — retired

The public Caddy site for Agent OS on that VPS was removed. Do not treat any old hostname as a product URL, and do not put a new public reverse proxy in front of this app.

Agent OS is a local install. Clone the repo and run it on the machine that has the agents. Open [http://127.0.0.1:8090](http://127.0.0.1:8090).

A private loopback process on a machine you administer may remain. Reach it with an SSH tunnel. If you ever terminate TLS in front of it, require an admin token. Steps and the unit files: [HOSTING.md](HOSTING.md).

`DEMO_PUBLIC=1` is an optional local screenshot gallery. It is not a public host. The live operator lane (`AGENT_OS_LIVE_CHAT=1`, gallery off) is for the owner of that machine.

**AgentOps Studio** remains the hosted ops product. This repository is not a multi-tenant Live app.

Product form: [FULL-PRODUCT-PLAN.md](FULL-PRODUCT-PLAN.md).
