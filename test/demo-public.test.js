import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runPublicDemoBuilder,
  runPublicDemoChat,
  runPublicDemoMachine,
  runPublicDemoTimeline
} from "../server/runtime/demo-actions.js";
import {
  DEMO_BADGE,
  applyDemoPresentation,
  assertDemoEnabled,
  buildDemoChatReply,
  demoWorkflowTemplate,
  isDemoPublic,
  previewDemoMachine,
  simulateDemoWorkflow
} from "../server/runtime/demo-public.js";
import { applyDemoExecutionLock } from "../server/runtime/execution-gate.js";
import { withRuntimeHome } from "../server/runtime/store.js";
import { listWorkspaceFiles } from "../server/runtime/workspace.js";

test("DEMO_PUBLIC accepts 1 and the Hermes alias", () => {
  assert.equal(isDemoPublic({ DEMO_PUBLIC: "1" }), true);
  assert.equal(isDemoPublic({ HERMES_AGENT_OS_DEMO_PUBLIC: "true" }), true);
  assert.equal(isDemoPublic({ DEMO_PUBLIC: "0" }), false);
  assert.equal(isDemoPublic({}), false);
});

test("demo presentation labels every seat Demo and does not claim a real session", () => {
  const presented = applyDemoPresentation({
    hosted: false,
    edition: "local-v1",
    summary: { total: 1, cliFound: 0, notInstalled: 1 },
    agents: [
      {
        id: "claude",
        name: "Claude Code",
        cli: { found: false, command: "claude", version: null },
        chat: { mode: "unavailable", label: "Not installed", routed: false, detail: "missing" },
        status: "not_installed"
      }
    ]
  });
  const agent = presented.agents[0];
  assert.equal(presented.badge, DEMO_BADGE);
  assert.equal(agent.status, "demo");
  assert.equal(agent.simulated, true);
  assert.equal(agent.realSession, false);
  assert.equal(agent.chat.label, "Demo");
  assert.equal(agent.chat.mode, "demo");
  assert.equal(agent.cli.found, false);
  assert.match(agent.summary, /not connected/i);
  assert.doesNotMatch(JSON.stringify(agent), /is connected/i);
  assert.equal(presented.summary.executionEnabled, false);
});

test("demo chat plan is multi-step and honest", () => {
  const reply = buildDemoChatReply({ agentId: "claude", message: "public-demo-smoke-marker" });
  assert.equal(reply.executedOnHost, false);
  assert.equal(reply.badge, DEMO_BADGE);
  assert.match(reply.reply, /### Steps/);
  assert.match(reply.reply, /1\. /);
  assert.match(reply.reply, /2\. /);
  assert.match(reply.reply, /3\. /);
  assert.match(reply.reply, /public-demo-smoke-marker/);
  assert.match(reply.reply, /not connected/i);
});

test("machine preview refuses arbitrary commands and does not echo them", () => {
  const refused = previewDemoMachine({ command: "rm -rf /" });
  assert.equal(refused.ok, false);
  assert.equal(refused.executedOnHost, false);
  assert.equal(refused.refused, true);
  assert.doesNotMatch(JSON.stringify(refused), /rm -rf/);
  const preview = previewDemoMachine({ scenario: "gate-status" });
  assert.equal(preview.ok, true);
  assert.equal(preview.executedOnHost, false);
  assert.match(preview.transcript, /not executed/i);
});

test("public demo locks the execution gate even when env execution is on", () => {
  const locked = applyDemoExecutionLock({
    enabled: true,
    source: "env",
    envLocked: true,
    localEnabled: false,
    dryRunDefault: false,
    publicSummary: "on"
  }, { DEMO_PUBLIC: "1" });
  assert.equal(locked.enabled, false);
  assert.equal(locked.demoLocked, true);
  assert.equal(locked.source, "demo-public-lock");
  assert.match(locked.publicSummary, /Public demo locks live execution/);
  const unchanged = applyDemoExecutionLock({ enabled: true, source: "env" }, {});
  assert.equal(unchanged.enabled, true);
});

test("demo routes stay off unless the flag or an explicit test override is set", () => {
  assert.throws(() => assertDemoEnabled({}, { DEMO_PUBLIC: "0" }), /DEMO_PUBLIC=1/);
  assert.doesNotThrow(() => assertDemoEnabled({ demo: true }, { DEMO_PUBLIC: "0" }));
});

test("demo workspace seeds briefing files without touching the one-time welcome marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-demo-ws-"));
  try {
    await withRuntimeHome(root, async () => {
      const listing = await listWorkspaceFiles({ demoPublic: true });
      const ids = listing.files.map((file) => file.id);
      assert.ok(ids.includes("workspace/inbox/welcome.md"));
      assert.ok(ids.includes("workspace/demo/briefing.md"));
      assert.ok(ids.includes("workspace/demo/walkthrough.md"));
      assert.ok(ids.includes("workspace/notes/start-here.md"));
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("simulated timeline and canvas write sandbox notes and do not claim host execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-demo-run-"));
  try {
    await withRuntimeHome(root, async () => {
      const chat = await runPublicDemoChat({ agentId: "cursor", message: "timeline marker" }, { demo: true });
      assert.equal(chat.realSession, false);
      assert.match(chat.reply, /not connected/i);
      const timeline = await runPublicDemoTimeline({ message: "timeline marker" }, { demo: true });
      assert.equal(timeline.executedOnHost, false);
      assert.ok(timeline.steps.length >= 4);
      assert.equal(timeline.workspaceFile.relativePath, "demo/latest-timeline.md");
      const note = await fs.readFile(path.join(root, "workspace", "demo", "latest-timeline.md"), "utf8");
      assert.match(note, /timeline marker/);
      assert.match(note, /executedOnHost: false/);
      const canvas = await runPublicDemoBuilder({ message: "canvas marker" }, { demo: true });
      assert.equal(canvas.executedOnHost, false);
      assert.ok(canvas.nodeRuns.some((step) => step.type === "user_approval"));
      assert.equal(canvas.workspaceFile.relativePath, "demo/latest-canvas.md");
      const sim = simulateDemoWorkflow(demoWorkflowTemplate(), "canvas marker");
      assert.equal(sim.executedOnHost, false);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("machine action refuses a shell string when the test override is on", async () => {
  await assert.rejects(
    () => runPublicDemoMachine({ command: "id" }, { demo: true }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.body.executedOnHost, false);
      assert.doesNotMatch(JSON.stringify(error.body), /"id"/);
      return true;
    }
  );
});
