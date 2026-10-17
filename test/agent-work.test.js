// What counts as agent work (src/ui/agentWork.ts). The list of Agent OS's own jobs exists in three
// places: agentWork.ts (used by "Hold to stop all"), and one copy each in homeShared.ts and
// agentsPageShared.ts. Those two are loaded straight from src/ by Node in the logic tests, and Node
// cannot follow an import written without a file extension, so they cannot import agentWork.ts.
// This test fails if the copies drift apart, so Home, Agents and Hold to stop all always agree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as work from "../src/ui/agentWork.ts";
import * as agents from "../src/ui/agentsPageShared.ts";
import * as home from "../src/ui/homeShared.ts";

const source = (file) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
const run = (kind, over = {}) => ({ id: "run_1", agentId: "claude", kind, status: "running", ...over });

// The kinds written in `const NOT_AGENT_WORK = new Set([...])` of a source file.
function kindsIn(file) {
  const match = source(file).match(/const NOT_AGENT_WORK = new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, `${file} has a NOT_AGENT_WORK list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

test("the shared list is the five setup and service kinds", () => {
  assert.deepEqual([...work.NOT_AGENT_WORK].sort(), ["configure", "install", "pull", "service", "signin"]);
  for (const kind of work.NOT_AGENT_WORK) assert.equal(work.isAgentWork({ kind }), false, kind);
  for (const kind of ["agent", "team-turn", "", "something-new"]) assert.equal(work.isAgentWork({ kind }), true, `kind "${kind}" is agent work`);
  assert.equal(work.isAgentWork({}), true, "a missing kind is agent work: an emergency stop errs toward stopping");
});

test("Home and Agents keep the same list as agentWork.ts (written out, so a drift is caught)", () => {
  const shared = [...work.NOT_AGENT_WORK].sort();
  assert.deepEqual(kindsIn("homeShared.ts"), shared, "homeShared.ts");
  assert.deepEqual(kindsIn("agentsPageShared.ts"), shared, "agentsPageShared.ts");
});

test("Home and Agents decide the same as agentWork.ts for every kind", () => {
  const kinds = [...work.NOT_AGENT_WORK, "agent", "team-turn", "", "something-new"];
  for (const kind of kinds) {
    const expected = work.isAgentWork({ kind });
    assert.equal(home.isAgentWork(run(kind)), expected, `Home, kind "${kind}"`);
    const counted = agents.liveCounts([run(kind)]).claude || 0;
    assert.equal(counted, expected ? 1 : 0, `Agents, kind "${kind}"`);
  }
});

test("Hold to stop all uses agentWork.ts and keeps no list of its own", () => {
  const text = source("stopAll.ts");
  assert.match(text, /from "\.\/agentWork"/, "stopAll.ts imports agentWork");
  assert.doesNotMatch(text, /NOT_AGENT_WORK\s*=/, "stopAll.ts does not define its own list");
});
