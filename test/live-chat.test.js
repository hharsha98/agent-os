import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dispatchLiveChat, getLiveStatus, runLiveMission } from "../server/runtime/live-chat.js";
import { isLiveChatEnabled } from "../server/runtime/live-flags.js";
import { completeViaOmniRoute, publicOmniRouteStatus, resolveOmniRouteConfig } from "../server/runtime/omniroute.js";
import { runRouter } from "../server/runtime/router.js";
import { withRuntimeHome } from "../server/runtime/store.js";

async function withTempHome(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-os-live-"));
  try {
    return await withRuntimeHome(dir, () => fn(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("live chat flag stays off for a fresh clone and for the public gallery", () => {
  assert.equal(isLiveChatEnabled({}), false);
  assert.equal(isLiveChatEnabled({ AGENT_OS_LIVE_CHAT: "1", DEMO_PUBLIC: "1" }), false);
  assert.equal(isLiveChatEnabled({ HERMES_AGENT_OS_ENABLE_EXEC: "1", AGENT_OS_LIVE_CHAT: "0" }), false);
  assert.equal(isLiveChatEnabled({ AGENT_OS_LIVE_CHAT: "1" }), true);
});

test("OmniRoute public status omits the API key", async () => {
  await withTempHome(async () => {
    const env = {
      OMNIROUTE_BASE_URL: "https://omniroute.example.test/v1",
      OMNIROUTE_API_KEY: "super-secret-endpoint-key",
      OMNIROUTE_MODEL: "auto"
    };
    const config = await resolveOmniRouteConfig(env);
    const pub = publicOmniRouteStatus(config);
    assert.equal(pub.configured, true);
    assert.equal(pub.host, "omniroute.example.test");
    assert.equal(JSON.stringify(pub).includes("super-secret"), false);
  });
});

test("OmniRoute chat completion posts to /v1/chat/completions", async () => {
  await withTempHome(async () => {
    let seen = null;
    const env = {
      OMNIROUTE_BASE_URL: "http://omniroute.local/v1",
      OMNIROUTE_API_KEY: "endpoint-key",
      OMNIROUTE_MODEL: "auto"
    };
    const result = await completeViaOmniRoute({
      messages: [{ role: "user", content: "ping" }],
      fetchImpl: async (url, options) => {
        seen = { url, options };
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "pong" } }], model: "auto" })
        };
      }
    }, env);
    assert.equal(result.text, "pong");
    assert.equal(seen.url, "http://omniroute.local/v1/chat/completions");
    assert.equal(seen.options.headers.Authorization, "Bearer endpoint-key");
  });
});

test("gallery mode refuses live dispatch", async () => {
  const result = await dispatchLiveChat({
    agentId: "hermes",
    message: "hello",
    dryRun: false
  }, { env: { DEMO_PUBLIC: "1", AGENT_OS_LIVE_CHAT: "1" } });
  assert.equal(result.mode, "demo_locked");
  assert.doesNotMatch(result.reply, /Demo plan/);
});

test("dry-run live endpoint does not call a backend", async () => {
  let called = false;
  const result = await dispatchLiveChat({
    agentId: "hermes",
    message: "plan only",
    dryRun: true
  }, {
    env: { AGENT_OS_LIVE_CHAT: "1" },
    fetchImpl: async () => {
      called = true;
      throw new Error("should not fetch");
    }
  });
  assert.equal(called, false);
  assert.equal(result.mode, "dry_run");
  assert.match(result.reply, /Dry-run plan/);
});

test("Hermes live run uses oneshot query-file only when execution is enabled", async () => {
  await withTempHome(async () => {
    let args = [];
    const skipped = await dispatchLiveChat({
      agentId: "hermes",
      message: "hello hermes",
      dryRun: false
    }, {
      env: { AGENT_OS_LIVE_CHAT: "1", HERMES_AGENT_OS_ENABLE_EXEC: "0" },
      executionEnabled: async () => false,
      which: async () => "/usr/bin/hermes",
      runCommand: async () => {
        throw new Error("CLI should not run");
      },
      fetchImpl: async () => {
        throw Object.assign(new Error("missing"), { code: "OMNIROUTE_NOT_CONFIGURED" });
      }
    });
    assert.equal(skipped.mode, "unavailable");

    const ran = await dispatchLiveChat({
      agentId: "hermes",
      message: "hello hermes",
      dryRun: false
    }, {
      env: { AGENT_OS_LIVE_CHAT: "1", HERMES_AGENT_OS_ENABLE_EXEC: "1", HERMES_HOME: "/tmp/hermes-home" },
      executionEnabled: async () => true,
      which: async () => "/usr/bin/hermes",
      runCommand: async (_command, nextArgs) => {
        args = nextArgs;
        return { ok: true, stdout: "native hermes reply", stderr: "", code: 0 };
      }
    });
    assert.equal(ran.transport, "hermes-cli");
    assert.equal(ran.native, true);
    assert.deepEqual(args.slice(0, 4), ["chat", "--oneshot", "-Q", "--query-file"]);
    assert.match(ran.reply, /native hermes reply/);
  });
});

test("OpenClaw gateway chat sends a bearer token", async () => {
  let seen = null;
  const result = await dispatchLiveChat({
    agentId: "openclaw",
    message: "status",
    dryRun: false
  }, {
    env: {
      AGENT_OS_LIVE_CHAT: "1",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789/v1",
      OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      OPENCLAW_GATEWAY_MODEL: "openclaw/default"
    },
    executionEnabled: async () => false,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "gateway ok" } }] })
      };
    }
  });
  assert.equal(result.transport, "openclaw-gateway");
  assert.equal(result.native, true);
  assert.equal(seen.url, "http://127.0.0.1:18789/v1/chat/completions");
  assert.equal(seen.options.headers.Authorization, "Bearer gateway-token");
  assert.match(result.reply, /gateway ok/);
});

test("configured OmniRoute answers when the native CLI is absent", async () => {
  await withTempHome(async () => {
    const result = await dispatchLiveChat({
      agentId: "claude",
      message: "say ready",
      dryRun: false
    }, {
      env: {
        AGENT_OS_LIVE_CHAT: "1",
        OMNIROUTE_BASE_URL: "http://omniroute.local/v1",
        OMNIROUTE_API_KEY: "endpoint-key"
      },
      executionEnabled: async () => true,
      which: async () => "",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ready via omni" } }], model: "auto" })
      })
    });
    assert.equal(result.transport, "omniroute");
    assert.equal(result.native, false);
    assert.match(result.reply, /ready via omni/);
  });
});

test("live status and mission note stay free of secrets", async () => {
  await withTempHome(async () => {
    const env = {
      AGENT_OS_LIVE_CHAT: "1",
      OMNIROUTE_BASE_URL: "https://omniroute.example.test/v1",
      OMNIROUTE_API_KEY: "do-not-leak",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789/v1"
    };
    const status = await getLiveStatus(env, { which: async () => "" });
    assert.equal(status.liveChat, true);
    assert.equal(status.demoPublic, false);
    assert.equal(status.omniroute.configured, true);
    assert.equal(JSON.stringify(status).includes("do-not-leak"), false);

    const mission = await runLiveMission({ message: "status please", dryRun: true }, { env });
    assert.equal(mission.mode, "dry_run");
    assert.equal(mission.workspaceFile.relativePath, "missions/latest.md");
    assert.match(mission.hermes.reply, /Dry-run plan/);
  });
});

test("native prompts stay positional and child env drops API keys", async () => {
  await withTempHome(async () => {
    let seen = null;
    const result = await dispatchLiveChat({
      agentId: "codex",
      message: "--dangerously-bypass-approvals-and-sandbox",
      dryRun: false
    }, {
      env: {
        AGENT_OS_LIVE_CHAT: "1",
        HERMES_AGENT_OS_ENABLE_EXEC: "1",
        OMNIROUTE_API_KEY: "leak-me-please",
        PATH: "/usr/bin",
        HOME: "/tmp/operator"
      },
      executionEnabled: async () => true,
      which: async () => "/usr/bin/codex",
      runCommand: async (_command, args, _timeout, options) => {
        seen = { args, env: options.env };
        return { ok: true, stdout: "echo leak-me-please", stderr: "", code: 0 };
      }
    });
    assert.equal(seen.args.at(-2), "--");
    assert.equal(seen.args.at(-1), "--dangerously-bypass-approvals-and-sandbox");
    assert.equal(seen.env.OMNIROUTE_API_KEY, undefined);
    assert.equal(seen.env.PATH, "/usr/bin");
    assert.equal(result.reply.includes("leak-me-please"), false);
    assert.match(result.reply, /configured/);
  });
});

test("OpenClaw falls through only when the gateway was never reached", async () => {
  await withTempHome(async () => {
    let cliRan = false;
    const reset = await dispatchLiveChat({
      agentId: "openclaw",
      message: "once",
      dryRun: false
    }, {
      env: {
        AGENT_OS_LIVE_CHAT: "1",
        OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789/v1",
        OMNIROUTE_BASE_URL: "http://omniroute.local/v1",
        OMNIROUTE_API_KEY: "endpoint-key"
      },
      executionEnabled: async () => true,
      which: async () => "/usr/bin/openclaw",
      runCommand: async () => {
        cliRan = true;
        return { ok: true, stdout: "cli", stderr: "", code: 0 };
      },
      fetchImpl: async () => {
        throw Object.assign(new Error("socket reset"), { cause: { code: "ECONNRESET" } });
      }
    });
    assert.equal(cliRan, false);
    assert.equal(reset.transport, "openclaw-gateway");
    assert.equal(reset.mode, "error");

    const refused = await dispatchLiveChat({
      agentId: "openclaw",
      message: "fallback",
      dryRun: false
    }, {
      env: {
        AGENT_OS_LIVE_CHAT: "1",
        OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789/v1",
        OMNIROUTE_BASE_URL: "http://omniroute.local/v1",
        OMNIROUTE_API_KEY: "endpoint-key"
      },
      executionEnabled: async () => false,
      fetchImpl: async (url) => {
        if (String(url).includes("18789")) {
          throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "omni fallback" } }], model: "auto" })
        };
      }
    });
    assert.equal(refused.transport, "omniroute");
    assert.match(refused.reply, /omni fallback/);
  });
});

test("provider router can execute OmniRoute on the live lane without the execution gate", async () => {
  await withTempHome(async () => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "from-omni" } }], model: "auto" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const previous = {
      AGENT_OS_LIVE_CHAT: process.env.AGENT_OS_LIVE_CHAT,
      DEMO_PUBLIC: process.env.DEMO_PUBLIC,
      HERMES_AGENT_OS_ENABLE_EXEC: process.env.HERMES_AGENT_OS_ENABLE_EXEC,
      OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
      OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
      OMNIROUTE_MODEL: process.env.OMNIROUTE_MODEL
    };
    process.env.AGENT_OS_LIVE_CHAT = "1";
    process.env.DEMO_PUBLIC = "0";
    process.env.HERMES_AGENT_OS_ENABLE_EXEC = "0";
    process.env.OMNIROUTE_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.OMNIROUTE_MODEL = "auto";
    try {
      const result = await runRouter({ prompt: "hi", provider: "omniroute", dryRun: false, source: "live-test" });
      assert.equal(result.mode, "executed");
      assert.equal(result.provider, "omniroute");
      assert.match(result.message, /from-omni/);
    } finally {
      server.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
