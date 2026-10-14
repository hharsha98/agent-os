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

// ---- R1-3: a room that had already ended is counted apart, never as "stopped" ----------------

// What the real wiring hands the logic when the server answers room_not_running: the room ended by itself.
const ended = () => stop.ROOM_ALREADY_ENDED;

// The error a refused request throws (api.ts TeamRoomError): an Error with a `code`.
const refusal = (code, message = "refused") => Object.assign(new Error(message), { name: "TeamRoomError", code, status: 409 });

test("a room that had already ended by itself is counted apart: not 'Stopped 1 Team Room', and not a failure", async () => {
  const { deps: d, calls } = deps({
    listRooms: async () => ({ rooms: [room("gone")] }),
    stopRoom: async (id) => {
      calls.stopRoom.push(id);
      return ended();
    }
  });
  const result = await stop.stopEverythingWith(d);
  assert.equal(result.rooms, 1);
  assert.equal(result.roomsStopped, 0, "nothing was stopped by us");
  assert.equal(result.roomsAlreadyEnded, 1);
  assert.equal(result.roomsFailed + result.roomsTimedOut, 0);
  const text = stop.stopAllMessage(result);
  assert.equal(text.message, "1 Team Room had already ended, so there was nothing to stop.");
  assert.equal(text.tone, "neutral");
  assert.doesNotMatch(text.message, /Stopped/);
  assert.doesNotMatch(text.message, /could not be stopped|may still be running|Nothing was confirmed/);
});

test("one room stopped and one that had already ended: both are said, each in its own words", async () => {
  const { deps: d } = deps({
    listRuns: async () => ({ runs: [run("a1", "agent")] }),
    listRooms: async () => ({ rooms: [room("live"), room("gone"), room("gone-too")] }),
    stopRoom: async (id) => (id === "live" ? {} : ended())
  });
  const result = await stop.stopEverythingWith(d);
  assert.equal(result.rooms, 3);
  assert.equal(result.roomsStopped, 1);
  assert.equal(result.roomsAlreadyEnded, 2);
  const text = stop.stopAllMessage(result);
  assert.equal(text.message, "Stopped 1 run and 1 Team Room. 2 Team Rooms had already ended.");
  assert.equal(text.tone, "ok");
  // The singular reads naturally too.
  const one = stop.stopAllMessage({ ...result, roomsAlreadyEnded: 1, rooms: 2 });
  assert.match(one.message, /1 Team Room had already ended\./);
});

test("a room that had already ended does not hide a run that could not be stopped", async () => {
  const { deps: d } = deps({
    listRuns: async () => ({ runs: [run("bad", "agent")] }),
    listRooms: async () => ({ rooms: [room("gone")] }),
    stopRun: async () => {
      throw new Error("refused");
    },
    stopRoom: async () => ended()
  });
  const text = stop.stopAllMessage(await stop.stopEverythingWith(d));
  assert.equal(text.tone, "warn");
  assert.match(text.message, /^Nothing was confirmed stopped\. 1 run could not be stopped: check Runs\. 1 Team Room had already ended\.$/);
});

test("an older result with no roomsAlreadyEnded field still reads as before", () => {
  const text = stop.stopAllMessage({
    found: 0, stopped: 0, failed: 0, timedOut: 0, rooms: 1, roomsStopped: 1, roomsFailed: 0, roomsTimedOut: 0,
    skipped: 0, runsChecked: true, roomsChecked: true, unreachable: false, listTruncated: false
  });
  assert.deepEqual(text, { message: "Stopped 1 Team Room.", tone: "ok" });
});

// withEndedRooms is what the real wiring (stopAll.ts) wraps the requests in. It is behaviour, so it is run here.
test("withEndedRooms: the server's room_not_running becomes 'already ended'; every other refusal is still a failure", async () => {
  const wrapped = (stopRoom) => stop.withEndedRooms(deps({ stopRoom }).deps);
  const stopOne = (stopRoom) => stop.stopEverythingWith({ ...wrapped(stopRoom), listRooms: async () => ({ rooms: [room("r1")] }) });

  const gone = await stopOne(async () => {
    throw refusal("room_not_running", "That room is not running.");
  });
  assert.deepEqual([gone.roomsStopped, gone.roomsAlreadyEnded, gone.roomsFailed], [0, 1, 0]);
  assert.equal(stop.stopAllMessage(gone).message, "1 Team Room had already ended, so there was nothing to stop.");

  // Other answers from the server, and errors that are not the server's, are failures as before.
  for (const thrown of [refusal("room_not_found"), refusal("execution_gate_off"), refusal("internal_error"), new Error("Failed to fetch"), "a string", null, undefined, 42]) {
    const failed = await stopOne(async () => {
      throw thrown;
    });
    assert.deepEqual([failed.roomsStopped, failed.roomsAlreadyEnded, failed.roomsFailed], [0, 0, 1], String(thrown));
    assert.match(stop.stopAllMessage(failed).message, /1 Team Room could not be stopped/);
  }

  // A stop that worked is a stop, and its answer is passed through untouched.
  const worked = await stopOne(async () => ({ id: "r1", status: "stopped" }));
  assert.deepEqual([worked.roomsStopped, worked.roomsAlreadyEnded, worked.roomsFailed], [1, 0, 0]);
  const answer = await wrapped(async (id) => ({ id, status: "stopped" })).stopRoom("r9");
  assert.deepEqual(answer, { id: "r9", status: "stopped" });
});

test("withEndedRooms changes nothing but the room stop: the other requests are the very same functions", () => {
  const base = deps().deps;
  const wrapped = stop.withEndedRooms(base);
  for (const name of ["listRuns", "stopRun", "listRooms", "isAgentWork"]) assert.equal(wrapped[name], base[name], name);
  assert.notEqual(wrapped.stopRoom, base.stopRoom);
});

// ---- the toast never says 'nothing to stop' when part of the picture is unknown (P26) -----------

test("a room that had already ended, with the run list unreadable: what was checked and what was not, never 'nothing to stop'", async () => {
  await withFastClock(async () => {
    const { deps: d } = deps({ listRuns: never, listRooms: async () => ({ rooms: [room("gone")] }), stopRoom: async () => ended() });
    const result = await stop.stopEverythingWith(d);
    assert.equal(result.runsChecked, false);
    assert.equal(result.roomsAlreadyEnded, 1);
    const text = stop.stopAllMessage(result);
    assert.equal(text.message, "1 Team Room had already ended. Couldn't read the list of runs, so no run was stopped. Check Runs.");
    assert.doesNotMatch(text.message, /nothing to stop|Nothing was running/);
    assert.equal(text.tone, "warn");
  });
});

test("a room that had already ended, with a full run list: older runs were not checked, so never 'nothing to stop'", async () => {
  const many = Array.from({ length: stop.MAX_RUNS }, (_, i) => run(`old-${i}`, "agent", "succeeded"));
  const { deps: d } = deps({ listRuns: async () => ({ runs: many }), listRooms: async () => ({ rooms: [room("gone")] }), stopRoom: async () => ended() });
  const result = await stop.stopEverythingWith(d);
  assert.equal(result.listTruncated, true);
  const text = stop.stopAllMessage(result);
  assert.equal(text.message, "1 Team Room had already ended. Older runs were not checked.");
  assert.doesNotMatch(text.message, /nothing to stop/);
  assert.equal(text.tone, "warn");
});

test("the message function alone: ended rooms plus an unread list never claim 'nothing to stop'; with both lists read they do", () => {
  const base = {
    found: 0, stopped: 0, failed: 0, timedOut: 0, rooms: 2, roomsStopped: 0, roomsFailed: 0, roomsTimedOut: 0, roomsAlreadyEnded: 2,
    skipped: 0, runsChecked: true, roomsChecked: true, unreachable: false, listTruncated: false
  };
  assert.deepEqual(stop.stopAllMessage(base), { message: "2 Team Rooms had already ended, so there was nothing to stop.", tone: "neutral" });
  const runsUnread = stop.stopAllMessage({ ...base, runsChecked: false });
  assert.equal(runsUnread.message, "2 Team Rooms had already ended. Couldn't read the list of runs, so no run was stopped. Check Runs.");
  const roomsUnread = stop.stopAllMessage({ ...base, roomsChecked: false });
  assert.doesNotMatch(roomsUnread.message, /nothing to stop/);
  assert.match(roomsUnread.message, /Couldn't read the list of Team Rooms/);
  assert.equal(stop.stopAllMessage({ ...base, listTruncated: true }).message, "2 Team Rooms had already ended. Older runs were not checked.");
  // Plus a skipped setup job: still only what is true.
  assert.equal(
    stop.stopAllMessage({ ...base, skipped: 1 }).message,
    "2 Team Rooms had already ended, so there was nothing to stop. 1 setup or service job was left running. It is not agent work; manage it in Setup or Agents."
  );
});

// ---- R1-4: a room that is about to resume is not missed ---------------------------------------
//
// A room whose decision was just made reads "needs_you" on disk while the server already holds its one
// active slot and is checking its agents before it marks the room running. The room list now carries that
// room's id (activeRoomId), and Hold stops it. Nothing is read a second time, so a stop never waits on an
// extra request.

// A room list that counts how often it is read.
function roomList(answer) {
  let reads = 0;
  return { reads: () => reads, listRooms: async () => (reads++, answer) };
}

test("the room the server names as active is stopped even though it reads needs_you (it is about to resume)", async () => {
  const list = roomList({ rooms: [room("resuming", "needs_you"), room("old", "agreed"), room("waiting", "needs_you")], activeRoomId: "resuming" });
  const { deps: d, calls } = deps({ listRuns: async () => ({ runs: [run("a1", "agent")] }), listRooms: list.listRooms });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(calls.stopRoom, ["resuming"], "only the active room: a paused room nobody holds is left alone");
  assert.deepEqual(calls.stopRun, ["a1"]);
  assert.equal(list.reads(), 1, "the room list is read once: a stop never waits on an extra read");
  assert.equal(result.rooms, 1);
  assert.equal(result.roomsStopped, 1);
  assert.equal(stop.stopAllMessage(result).message, "Stopped 1 run and 1 Team Room.");
});

test("it also catches the room when nothing else was running, and a running room that is also active is stopped once", async () => {
  const alone = deps({ listRooms: roomList({ rooms: [room("resuming", "needs_you")], activeRoomId: "resuming" }).listRooms });
  const first = await stop.stopEverythingWith(alone.deps);
  assert.deepEqual(alone.calls.stopRoom, ["resuming"]);
  assert.equal(stop.stopAllMessage(first).message, "Stopped 1 Team Room.");

  const both = deps({ listRooms: roomList({ rooms: [room("busy"), room("other", "agreed")], activeRoomId: "busy" }).listRooms });
  const second = await stop.stopEverythingWith(both.deps);
  assert.deepEqual(both.calls.stopRoom, ["busy"], "once, not twice");
  assert.equal(second.rooms, 1);
});

test("an active room the list did not show (the list is capped) is still stopped", async () => {
  const { deps: d, calls } = deps({ listRooms: async () => ({ rooms: [room("newer", "agreed")], activeRoomId: "older-but-active" }) });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(calls.stopRoom, ["older-but-active"]);
  assert.equal(result.roomsStopped, 1);
});

test("no active room (null, missing, empty, or not a text): nothing extra is stopped, and the message is unchanged", async () => {
  for (const activeRoomId of [null, undefined, "", 7, {}, []]) {
    const list = roomList({ rooms: [room("old", "agreed"), room("waiting", "needs_you")], ...(activeRoomId === undefined ? {} : { activeRoomId }) });
    const { deps: d, calls } = deps({ listRooms: list.listRooms });
    const result = await stop.stopEverythingWith(d);
    assert.equal(calls.stopRoom.length, 0, JSON.stringify(activeRoomId));
    assert.equal(list.reads(), 1, JSON.stringify(activeRoomId));
    assert.deepEqual(stop.stopAllMessage(result), { message: "Nothing was running, so there was nothing to stop.", tone: "neutral" }, JSON.stringify(activeRoomId));
  }
});

test("an active room named in an answer that is not a list is ignored (the rooms could not be checked)", async () => {
  const { deps: d, calls } = deps({ listRooms: async () => ({ rooms: null, activeRoomId: "r1" }) });
  const look = await stop.lookForStoppable(d);
  assert.equal(look.roomsChecked, false);
  assert.deepEqual(look.rooms, []);
  assert.equal((await stop.stopWhatWasFound(d, look)).rooms, 0);
  assert.equal(calls.stopRoom.length, 0);
});

test("the active room that ended before the stop reached it reads 'already ended', in R1-3's words", async () => {
  const { deps: base } = deps({
    listRooms: async () => ({ rooms: [room("resuming", "needs_you")], activeRoomId: "resuming" }),
    stopRoom: async () => {
      throw refusal("room_not_running", "That room is not running.");
    }
  });
  const result = await stop.stopEverythingWith(stop.withEndedRooms(base));
  assert.equal(result.roomsAlreadyEnded, 1);
  assert.equal(stop.stopAllMessage(result).message, "1 Team Room had already ended, so there was nothing to stop.");
});

test("the palette's look lists the active room, and stopping it does not read the rooms again", async () => {
  const list = roomList({ rooms: [room("resuming", "needs_you")], activeRoomId: "resuming" });
  const { deps: d, calls } = deps({ listRooms: list.listRooms });
  const look = await stop.lookForStoppable(d);
  assert.deepEqual(look.rooms.map((r) => r.id), ["resuming"], "the dialog names it before the person says yes");
  const result = await stop.stopWhatWasFound(d, look);
  assert.deepEqual(calls.stopRoom, ["resuming"]);
  assert.equal(result.roomsStopped, 1);
  assert.equal(list.reads(), 1, "one read in all: the look");
});

test("a room list that hangs or fails leaves no active room to stop, and the run side still works", async () => {
  await withFastClock(async () => {
    const { deps: d, calls } = deps({ listRuns: async () => ({ runs: [run("a", "agent")] }), listRooms: never });
    const result = await stop.stopEverythingWith(d);
    assert.deepEqual(calls.stopRun, ["a"]);
    assert.equal(result.roomsChecked, false);
    assert.equal(calls.stopRoom.length, 0);
  });
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
