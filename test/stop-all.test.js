// "Hold to stop all" and the palette's "Stop all runs" (src/ui/stopAllShared.ts): which runs and
// Team Rooms are stopped, what is left alone on purpose, the time limits, and the words for a stop
// that only timed out. The shared file has no imports but types, so Node loads it straight from
// src/. The requests are fakes passed in; nothing here talks to a server.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as work from "../src/ui/agentWork.ts";
import * as stop from "../src/ui/stopAllShared.ts";

const run = (id, kind, status = "running") => ({ id, kind, status, title: `${kind} ${id}` });
const room = (id, status = "running") => ({ id, status, task: `task of ${id}` });

function deps(over = {}) {
  const calls = { stopRun: [], stopRoom: [] };
  return {
    calls,
    deps: {
      listRuns: async () => ({ runs: [] }),
      stopRun: async (id) => {
        calls.stopRun.push(id);
        return {};
      },
      listRooms: async () => ({ rooms: [] }),
      stopRoom: async (id) => {
        calls.stopRoom.push(id);
        return {};
      },
      isAgentWork: work.isAgentWork,
      ...over
    }
  };
}

// A request that never answers, to see the time limits work.
const never = () => new Promise(() => {});

async function withFastClock(fn) {
  const realSetTimeout = globalThis.setTimeout;
  // Time limits of 8 s and 15 s become 8 ms and 15 ms: same code path, no real waiting.
  globalThis.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, typeof ms === "number" && ms >= 1000 ? ms / 1000 : ms, ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("agent runs are stopped; service, install, configure, signin and pull jobs are left running", async () => {
  const { deps: d, calls } = deps({
    listRuns: async () => ({
      runs: [
        run("a1", "agent"),
        run("t1", "team-turn", "queued"),
        run("s1", "service"),
        run("i1", "install"),
        run("c1", "configure"),
        run("g1", "signin"),
        run("p1", "pull"),
        run("old", "agent", "succeeded")
      ]
    })
  });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(calls.stopRun.sort(), ["a1", "t1"]);
  assert.equal(result.found, 2);
  assert.equal(result.stopped, 2);
  assert.equal(result.skipped, 5);
  assert.equal(result.unreachable, false);
  const text = stop.stopAllMessage(result);
  assert.match(text.message, /Stopped 2 runs\./);
  assert.match(text.message, /5 setup or service jobs were left running/);
});

test("the palette's look lists exactly what the hold would stop (the same rule, one function)", async () => {
  const { deps: d } = deps({
    listRuns: async () => ({ runs: [run("a1", "agent"), run("i1", "install"), run("s1", "service")] }),
    listRooms: async () => ({ rooms: [room("r1"), room("r2", "needs_you"), room("r3", "stopped")] })
  });
  const look = await stop.lookForStoppable(d);
  assert.deepEqual(look.runs.map((r) => r.id), ["a1"]);
  assert.deepEqual(look.rooms.map((r) => r.id), ["r1"]);
  assert.equal(look.skipped, 2);
  assert.equal(look.runsChecked && look.roomsChecked, true);
});

test("a running Team Room is stopped even when it has no active run (between two turns)", async () => {
  const { deps: d, calls } = deps({
    listRuns: async () => ({ runs: [] }),
    listRooms: async () => ({ rooms: [room("room-1"), room("room-2", "agreed")] })
  });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(calls.stopRoom, ["room-1"]);
  assert.equal(result.found, 0);
  assert.equal(result.rooms, 1);
  assert.equal(result.roomsStopped, 1);
  const text = stop.stopAllMessage(result);
  assert.equal(text.tone, "ok");
  assert.match(text.message, /Stopped 1 Team Room\./);
  assert.doesNotMatch(text.message, /Nothing was running/);
});

test("rooms are stopped before runs, so a stopped turn cannot be followed by a next turn", async () => {
  const order = [];
  const { deps: d } = deps({
    listRuns: async () => ({ runs: [run("turn-run", "team-turn")] }),
    listRooms: async () => ({ rooms: [room("room-1")] }),
    stopRoom: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("room");
    },
    stopRun: async () => {
      order.push("run");
    }
  });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(order, ["room", "run"]);
  assert.match(stop.stopAllMessage(result).message, /Stopped 1 run and 1 Team Room\./);
});

test("a stop that timed out is reported as possibly still running, never as 'could not be stopped'", async () => {
  await withFastClock(async () => {
    const { deps: d } = deps({
      listRuns: async () => ({ runs: [run("slow", "agent"), run("good", "agent"), run("bad", "agent")] }),
      stopRun: async (id) => {
        if (id === "slow") return never();
        if (id === "bad") throw new Error("refused");
        return {};
      }
    });
    const result = await stop.stopEverythingWith(d);
    assert.equal(result.stopped, 1);
    assert.equal(result.timedOut, 1);
    assert.equal(result.failed, 1);
    const text = stop.stopAllMessage(result);
    assert.equal(text.tone, "warn");
    assert.match(text.message, /Stopped 1 run\./);
    assert.match(text.message, /1 run could not be stopped/, "an answered refusal is a failure");
    assert.match(text.message, /did not answer in time about 1 run, so it may still be running/);
  });
  // Only timeouts: no "could not be stopped" at all.
  const onlyTimeouts = stop.stopAllMessage({
    found: 2, stopped: 0, failed: 0, timedOut: 2, rooms: 0, roomsStopped: 0, roomsFailed: 0, roomsTimedOut: 0,
    skipped: 0, runsChecked: true, roomsChecked: true, unreachable: false, listTruncated: false
  });
  assert.doesNotMatch(onlyTimeouts.message, /could not be stopped/);
  assert.match(onlyTimeouts.message, /Nothing was confirmed stopped\./);
  assert.match(onlyTimeouts.message, /so they may still be running/);
  assert.equal(onlyTimeouts.tone, "warn");
});

test("a list that never answers ends in the time limit, and is told apart from 'nothing running'", async () => {
  await withFastClock(async () => {
    const { deps: d, calls } = deps({ listRuns: never, listRooms: never });
    const result = await stop.stopEverythingWith(d);
    assert.equal(result.unreachable, true);
    assert.equal(calls.stopRun.length + calls.stopRoom.length, 0);
    const text = stop.stopAllMessage(result);
    assert.equal(text.tone, "danger");
    assert.match(text.message, /nothing was stopped/);
    assert.doesNotMatch(text.message, /Nothing was running/);
  });
  await withFastClock(async () => {
    // Runs answer, rooms do not: the runs are stopped, and the message says a room may carry on.
    const { deps: d, calls } = deps({ listRuns: async () => ({ runs: [run("a", "agent")] }), listRooms: never });
    const result = await stop.stopEverythingWith(d);
    assert.deepEqual(calls.stopRun, ["a"]);
    assert.equal(result.unreachable, false);
    assert.equal(result.roomsChecked, false);
    const text = stop.stopAllMessage(result);
    assert.equal(text.tone, "warn");
    assert.match(text.message, /Couldn't read the list of Team Rooms/);
    assert.match(text.message, /Stopped 1 run\./);
  });
  await withFastClock(async () => {
    // Runs never answer, rooms answer with nothing: nothing was stopped, and the message says which list it could not read.
    const { deps: d } = deps({ listRuns: never, listRooms: async () => ({ rooms: [] }) });
    const result = await stop.stopEverythingWith(d);
    assert.equal(result.unreachable, false);
    assert.equal(result.runsChecked, false);
    const text = stop.stopAllMessage(result);
    assert.equal(text.tone, "warn");
    assert.equal(text.message, "Couldn't read the list of runs, so no run was stopped. Check Runs.");
    assert.doesNotMatch(text.message, /Nothing was running|nothing to stop/);
  });
  await withFastClock(async () => {
    // Runs answer with nothing, rooms never answer: no run was running, and a room between turns may still carry on.
    const { deps: d } = deps({ listRooms: never });
    const text = stop.stopAllMessage(await stop.stopEverythingWith(d));
    assert.equal(text.tone, "warn");
    assert.match(text.message, /^No agent run was running\. Couldn't read the list of Team Rooms/);
  });
  // A reply that is not a list counts as no reply.
  const { deps: bad } = deps({ listRuns: async () => ({ runs: "oops" }), listRooms: async () => ({ rooms: null }) });
  assert.equal((await stop.stopEverythingWith(bad)).unreachable, true);
});

test("a full run list is never reported as 'nothing was running'", async () => {
  const many = Array.from({ length: stop.MAX_RUNS }, (_, i) => run(`old-${i}`, "agent", "succeeded"));
  const { deps: d } = deps({ listRuns: async () => ({ runs: many }) });
  const result = await stop.stopEverythingWith(d);
  assert.equal(result.listTruncated, true);
  const text = stop.stopAllMessage(result);
  assert.equal(text.tone, "warn");
  assert.match(text.message, /newest 1000 runs/);
  assert.doesNotMatch(text.message, /^Nothing was running/);
});

test("nothing running reads as nothing to stop, and thingsWord reads naturally", async () => {
  const { deps: d } = deps();
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(stop.stopAllMessage(result), { message: "Nothing was running, so there was nothing to stop.", tone: "neutral" });
  assert.equal(stop.thingsWord(1, 0), "1 run");
  assert.equal(stop.thingsWord(2, 0), "2 runs");
  assert.equal(stop.thingsWord(0, 1), "1 Team Room");
  assert.equal(stop.thingsWord(2, 3), "2 runs and 3 Team Rooms");
});

test("the palette's Stop all runs and the hold share one code path (no second list, no unguarded requests)", async () => {
  const { readFileSync } = await import("node:fs");
  const modal = readFileSync(new URL("../src/ui/components/StopAllRunsModal.tsx", import.meta.url), "utf8");
  const wiring = readFileSync(new URL("../src/ui/stopAll.ts", import.meta.url), "utf8");
  assert.match(modal, /lookForWhatToStop/, "the dialog looks through stopAll.ts");
  assert.match(modal, /stopWhatWasLookedAt/, "the dialog stops through stopAll.ts");
  assert.doesNotMatch(modal, /from "\.\.\/\.\.\/api"/, "the dialog makes no request of its own");
  assert.doesNotMatch(modal, /ACTIVE\s*=/, "the dialog keeps no list of statuses of its own");
  assert.match(wiring, /from "\.\/agentWork"/, "the agent-work rule comes from agentWork.ts");
  assert.match(wiring, /listTeamRooms/);
  assert.match(wiring, /stopTeamRoom/);
});
