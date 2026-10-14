// The Agents page's pure logic (src/ui/agentsPageShared.ts): which agent is selected, the words in the
// rail (status and version) and how many runs light each agent. Node strips the TypeScript types
// itself (Node >= 22.18; CI runs 24), so the .ts file is imported directly. agentsPageShared.ts must
// keep only `import type` imports. No server, no browser: the page itself is checked by the Agents
// probe of the UI audit.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as shared from "../src/ui/agentsPageShared.ts";

const ORDER = ["hermes", "openclaw", "claude", "codex", "cursor"];
const agent = (id, installed = true, version = "1.2.3") => ({
  id, label: id, homepage: "", docsUrl: "", license: "", detected: { installed, path: "", version: installed ? version : "", features: {} }
});
const run = (over = {}) => ({ id: "run_1", agentId: "claude", kind: "agent", status: "running", ...over });

test("live counts: queued and running agent work counts, Agent OS's own jobs never do", () => {
  const runs = [
    run({ id: "a", agentId: "claude", status: "running" }),
    run({ id: "b", agentId: "claude", status: "queued" }),
    run({ id: "c", agentId: "hermes", kind: "service", status: "running" }),
    run({ id: "d", agentId: "openclaw", kind: "install", status: "queued" }),
    run({ id: "e", agentId: "openclaw", kind: "configure", status: "running" }),
    run({ id: "f", agentId: "hermes", kind: "signin", status: "running" }),
    run({ id: "g", agentId: "hermes", kind: "pull", status: "running" }),
    run({ id: "h", agentId: "codex", status: "succeeded" }),
    run({ id: "i", agentId: "cursor", status: "failed" }),
    run({ id: "j", agentId: null, status: "running" }),
    run({ id: "k", agentId: "openclaw", kind: "team-turn", status: "running" }),
    run({ id: "l", agentId: "codex", kind: "something-new", status: "running" })
  ];
  assert.deepEqual(shared.liveCounts(runs), { claude: 2, openclaw: 1, codex: 1 });
});

test("live counts: an unknown list claims nothing", () => {
  assert.deepEqual(shared.liveCounts(null), {});
  assert.deepEqual(shared.liveCounts([]), {});
});

test("rail status: loading is loading, and a failed or timed-out first load is unknown (never 'not installed')", () => {
  assert.deepEqual(shared.railStatus({ resolved: false, gaveUp: false, agent: undefined, live: 0 }), { state: "loading" });
  assert.deepEqual(shared.railStatus({ resolved: false, gaveUp: true, agent: undefined, live: 0 }), { state: "unknown" });
});

test("rail status: not installed only when the list says so; an agent the list does not mention is unknown", () => {
  assert.deepEqual(shared.railStatus({ resolved: true, gaveUp: false, agent: agent("cursor", false), live: 0 }), { state: "idle", label: "Not installed" });
  assert.deepEqual(shared.railStatus({ resolved: true, gaveUp: false, agent: undefined, live: 0 }), { state: "unknown" });
});

test("rail status: Live (with a count past one) while it works, Installed otherwise", () => {
  assert.deepEqual(shared.railStatus({ resolved: true, gaveUp: false, agent: agent("claude"), live: 1 }), { state: "live", label: "Live" });
  assert.deepEqual(shared.railStatus({ resolved: true, gaveUp: false, agent: agent("claude"), live: 3 }), { state: "live", label: "Live ×3" });
  assert.deepEqual(shared.railStatus({ resolved: true, gaveUp: false, agent: agent("claude"), live: 0 }), { state: "ready", label: "Installed" });
  // A stale list (a later refresh failed) still describes the agents it last knew.
  assert.deepEqual(shared.railStatus({ resolved: true, gaveUp: true, agent: agent("claude"), live: 0 }), { state: "ready", label: "Installed" });
});

test("a missing agent is never reported as a live one", () => {
  assert.deepEqual(shared.railStatus({ resolved: true, gaveUp: false, agent: agent("cursor", false), live: 2 }), { state: "idle", label: "Not installed" });
});

test("rail version: '…' while loading, '—' when unknown, the version only for an installed agent", () => {
  assert.equal(shared.railVersion({ resolved: false, gaveUp: false, agent: undefined }), "…");
  assert.equal(shared.railVersion({ resolved: false, gaveUp: true, agent: undefined }), "—");
  assert.equal(shared.railVersion({ resolved: true, gaveUp: false, agent: agent("claude", true, "2.1.281") }), "2.1.281");
  assert.equal(shared.railVersion({ resolved: true, gaveUp: false, agent: agent("claude", true, "") }), "—");
  assert.equal(shared.railVersion({ resolved: true, gaveUp: false, agent: agent("cursor", false) }), "—");
  assert.equal(shared.railVersion({ resolved: true, gaveUp: false, agent: undefined }), "—");
});

test("install state: yes, no or unknown, never a guess", () => {
  assert.equal(shared.installState(agent("claude")), "installed");
  assert.equal(shared.installState(agent("cursor", false)), "missing");
  assert.equal(shared.installState(undefined), "unknown");
});

test("which agent is shown: the asked-for one, else the first installed, else the first", () => {
  const list = [agent("hermes", false), agent("openclaw", true), agent("claude"), agent("codex"), agent("cursor", false)];
  assert.equal(shared.pickAgentId("codex", list, ORDER), "codex");
  assert.equal(shared.pickAgentId("", list, ORDER), "openclaw");
  assert.equal(shared.pickAgentId("not-an-agent", list, ORDER), "openclaw");
  assert.equal(shared.pickAgentId("cursor", list, ORDER), "cursor", "a missing agent can still be opened to read how to install it");
  assert.equal(shared.pickAgentId("", null, ORDER), "hermes");
  assert.equal(shared.pickAgentId("not-an-agent", null, ORDER), "hermes");
  assert.equal(shared.pickAgentId("", [agent("hermes", false), agent("openclaw", false)], ORDER), "hermes");
});
