// "Hold to stop all" and the palette's "Stop all agent work" (src/ui/stopAllShared.ts): which sessions,
// runs and Team Rooms are stopped, what is left alone on purpose (setup and service jobs, the Hermes
// service and the OpenClaw Gateway), the time limits, and the words for a stop that only timed out. The
// shared file has no imports but types, so Node loads it straight from src/. Almost every test passes in
// fake requests; the last one stops real fake-agent sessions through the real Stop route (in process).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import * as work from "../src/ui/agentWork.ts";
import * as stop from "../src/ui/stopAllShared.ts";
import { clearDetectCaches } from "../server/runtime/agents/detect.js";
import { setExecutionGateStatus } from "../server/runtime/execution-gate.js";
import { requireLocalMode } from "../server/runtime/local-session.js";
import { createSessionManager } from "../server/runtime/sessions/manager.js";
import { OPENCLAW_SIGNIN_ACTION } from "../server/runtime/sessions/profiles.js";
import { createSessionsRouter } from "../server/runtime/sessions/routes.js";
import { resetLoginShellEnvForTests } from "../server/runtime/sessions/shell-env.js";
import { FAKE_LOGIN_SHELL, makeFakeAgentBin } from "./helpers/fake-agents.js";

const run = (id, kind, status = "running") => ({ id, kind, status, title: `${kind} ${id}` });
const room = (id, status = "running") => ({ id, status, task: `task of ${id}` });
const LABEL = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", hermes: "Hermes", openclaw: "OpenClaw" };
// The fields of a SessionSummary (server/runtime/sessions/manager.js) the stop logic reads.
const session = (id, { kind = "agent", agentId = "claude", status = "live", folderName = "my-app" } = {}) => ({
  id,
  kind,
  agentId,
  agentLabel: LABEL[agentId],
  folderName,
  folderShown: agentId !== "openclaw",
  status
});

function deps(over = {}) {
  const calls = { stopRun: [], stopRoom: [], stopSession: [] };
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
      listSessions: async () => ({ sessions: [] }),
      // The Stop route answers the session's summary (plus `note`) after the Stop sequence.
      stopSession: async (id) => {
        calls.stopSession.push(id);
        return { id, status: "exited", endedBy: "stop", note: null };
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
    const { deps: d, calls } = deps({ listRuns: never, listRooms: never, listSessions: never });
    const result = await stop.stopEverythingWith(d);
    assert.equal(result.unreachable, true);
    assert.equal(calls.stopRun.length + calls.stopRoom.length + calls.stopSession.length, 0);
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
  const { deps: bad } = deps({
    listRuns: async () => ({ runs: "oops" }),
    listRooms: async () => ({ rooms: null }),
    listSessions: async () => ({ sessions: { id: "s1" } })
  });
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
  for (const name of ["listRuns", "stopRun", "listRooms", "isAgentWork", "listSessions", "stopSession"]) assert.equal(wrapped[name], base[name], name);
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

// ---- Q16: sessions of both kinds stop with the runs (design spec D11, "Hold to stop all") ----------

test("sessions of both kinds that have not ended are stopped with the agent runs; an ended session and a service job are left alone", async () => {
  const { deps: d, calls } = deps({
    listRuns: async () => ({ runs: [run("a1", "agent"), run("gw", "service")] }),
    listSessions: async () => ({
      sessions: [
        session("s-claude"),
        session("s-update", { kind: "update", agentId: "hermes", folderName: "hermes-agent" }),
        session("s-idle", { agentId: "codex", status: "idle" }),
        session("s-start", { agentId: "cursor", status: "starting" }),
        session("s-done", { status: "exited" })
      ]
    })
  });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(calls.stopSession.sort(), ["s-claude", "s-idle", "s-start", "s-update"]);
  assert.deepEqual(calls.stopRun, ["a1"], "the Hermes gateway job (a run of kind service) keeps running");
  assert.equal(result.sessions, 4);
  assert.equal(result.sessionsStopped, 4);
  assert.equal(result.sessionsChecked, true);
  assert.equal(result.found, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(stop.stopAllMessage(result), {
    message: "Stopped 4 sessions and 1 run. 1 setup or service job was left running. It is not agent work; manage it in Setup or Agents.",
    tone: "ok"
  });
});

test("a session in a state Agent OS has not heard of is stopped too: an emergency stop errs toward stopping", async () => {
  const { deps: d, calls } = deps({
    listSessions: async () => ({
      sessions: [session("w", { status: "waiting" }), session("h", { status: "held" }), session("m", { status: "mystery" }), { id: 7, status: "live" }, null]
    })
  });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(calls.stopSession.sort(), ["h", "m", "w"], "an entry with no usable id is skipped, never sent");
  assert.equal(result.sessions, 3);
});

test("the stop only ever uses the list and stop requests it is given (runs, rooms, sessions): no service control exists to call", async () => {
  const used = new Set();
  const { deps: base, calls } = deps({
    listRuns: async () => ({ runs: [run("gw", "service"), run("a1", "agent")] }),
    listSessions: async () => ({ sessions: [session("h1", { agentId: "hermes" }), session("o1", { agentId: "openclaw" })] })
  });
  const watched = new Proxy(base, {
    get(target, key) {
      used.add(String(key));
      return target[key];
    }
  });
  await stop.stopEverythingWith(watched);
  assert.deepEqual([...used].sort(), ["isAgentWork", "listRooms", "listRuns", "listSessions", "stopRun", "stopSession"]);
  assert.deepEqual(calls.stopRun, ["a1"]);
  assert.deepEqual(calls.stopSession.sort(), ["h1", "o1"]);
});

test("sessions and rooms start stopping together; runs follow the rooms and never wait for a slow session", async () => {
  const order = [];
  let finishSession = () => {};
  const { deps: d } = deps({
    listRuns: async () => ({ runs: [run("r1", "agent")] }),
    listRooms: async () => ({ rooms: [room("room-1")] }),
    listSessions: async () => ({ sessions: [session("s1")] }),
    stopSession: () => {
      order.push("session asked");
      return new Promise((resolve) => {
        finishSession = () => {
          order.push("session done");
          resolve({ id: "s1", status: "exited", endedBy: "stop", note: null });
        };
      });
    },
    stopRoom: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("room");
    },
    stopRun: async () => {
      order.push("run");
      setTimeout(() => finishSession(), 5);
    }
  });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(order, ["session asked", "room", "run", "session done"]);
  assert.equal(stop.stopAllMessage(result).message, "Stopped 1 session, 1 run and 1 Team Room.");
});

test("session stops that fail, time out or find the session already ended: each said in its own words", async () => {
  await withFastClock(async () => {
    const { deps: d } = deps({
      listSessions: async () => ({ sessions: [session("ok"), session("bad"), session("slow"), session("gone")] }),
      stopSession: async (id) => {
        if (id === "bad") throw new Error("refused");
        if (id === "slow") return never();
        if (id === "gone") return stop.SESSION_ALREADY_ENDED;
        return {};
      }
    });
    const result = await stop.stopEverythingWith(d);
    assert.deepEqual([result.sessionsStopped, result.sessionsFailed, result.sessionsTimedOut, result.sessionsAlreadyEnded, result.sessionsStillRunning], [1, 1, 1, 1, 0]);
    const text = stop.stopAllMessage(result);
    assert.equal(
      text.message,
      "Stopped 1 session. 1 session could not be stopped: check Sessions. Agent OS did not answer in time about 1 session, so it may still be running: check Sessions. 1 session had already ended."
    );
    assert.equal(text.tone, "warn");
  });
  // Only a session that had already ended: nothing to stop, in the same words as a room that had ended.
  const { deps: onlyGone } = deps({ listSessions: async () => ({ sessions: [session("gone")] }), stopSession: async () => stop.SESSION_ALREADY_ENDED });
  assert.deepEqual(stop.stopAllMessage(await stop.stopEverythingWith(onlyGone)), {
    message: "1 session had already ended, so there was nothing to stop.",
    tone: "neutral"
  });
  // A session and a room that had both already ended read as one sentence.
  const { deps: both } = deps({
    listSessions: async () => ({ sessions: [session("gone")] }),
    listRooms: async () => ({ rooms: [room("r-gone")] }),
    stopSession: async () => stop.SESSION_ALREADY_ENDED,
    stopRoom: async () => stop.ROOM_ALREADY_ENDED
  });
  assert.equal(stop.stopAllMessage(await stop.stopEverythingWith(both)).message, "1 session and 1 Team Room had already ended, so there was nothing to stop.");
});

test("a session list that cannot be read: runs and rooms are still stopped, and the toast never says 'nothing to stop'", async () => {
  await withFastClock(async () => {
    const { deps: d, calls } = deps({ listRuns: async () => ({ runs: [run("a", "agent")] }), listSessions: never });
    const result = await stop.stopEverythingWith(d);
    assert.deepEqual(calls.stopRun, ["a"]);
    assert.equal(result.sessionsChecked, false);
    assert.equal(result.unreachable, false);
    assert.deepEqual(stop.stopAllMessage(result), {
      message: "Stopped 1 run. Couldn't read the list of sessions, so no session was stopped. Check Sessions.",
      tone: "warn"
    });
  });
  await withFastClock(async () => {
    const { deps: d } = deps({ listSessions: never });
    const text = stop.stopAllMessage(await stop.stopEverythingWith(d));
    assert.equal(text.message, "No agent run was running. Couldn't read the list of sessions, so no session was stopped. Check Sessions.");
    assert.doesNotMatch(text.message, /nothing to stop|Nothing was running/);
    assert.equal(text.tone, "warn");
  });
  await withFastClock(async () => {
    const { deps: d, calls } = deps({ listRuns: never, listRooms: never, listSessions: never });
    const result = await stop.stopEverythingWith(d);
    assert.equal(calls.stopSession.length, 0);
    assert.deepEqual(stop.stopAllMessage(result), {
      message: "Couldn't reach Agent OS, so nothing was stopped. Try again, or stop each session on Sessions and each run on Runs.",
      tone: "danger"
    });
  });
  // A reply that is not a list is treated like no reply.
  const { deps: bad } = deps({ listSessions: async () => ({ sessions: "oops" }) });
  assert.equal((await stop.lookForStoppable(bad)).sessionsChecked, false);
});

test("an OpenClaw session that was stopped adds the honest note: OpenClaw may still finish the step it was on", async () => {
  const { deps: d } = deps({ listSessions: async () => ({ sessions: [session("oc", { agentId: "openclaw" }), session("cc")] }) });
  const result = await stop.stopEverythingWith(d);
  assert.equal(result.openClawStopped, 1);
  assert.deepEqual(stop.stopAllMessage(result), { message: "Stopped 2 sessions. OpenClaw may still be finishing its last step.", tone: "ok" });
  // No OpenClaw session stopped, no note: a failed OpenClaw stop is reported as a failure only.
  const { deps: failed } = deps({
    listSessions: async () => ({ sessions: [session("oc", { agentId: "openclaw" })] }),
    stopSession: async () => {
      throw new Error("refused");
    }
  });
  assert.doesNotMatch(stop.stopAllMessage(await stop.stopEverythingWith(failed)).message, /finishing its last step/);
});

test("withSessionAnswers: not_available means no session can run here; unknown_session, or an answer that says it ended by itself, is 'already ended'", async () => {
  // The refusal request() in src/api.ts throws: an ApiError whose message is the server's short code.
  const apiError = (code, status) => Object.assign(new Error(code), { name: "ApiError", status, detail: "" });

  // Sessions only exist when Agent OS runs on this computer (local mode); elsewhere the list answers not_available.
  const notHere = stop.withSessionAnswers(
    deps({
      listSessions: async () => {
        throw apiError("not_available", 404);
      }
    }).deps
  );
  const quiet = await stop.stopEverythingWith(notHere);
  assert.equal(quiet.sessionsChecked, true);
  assert.deepEqual(stop.stopAllMessage(quiet), { message: "Nothing was running, so there was nothing to stop.", tone: "neutral" });

  // Any other failure of the list still means the list could not be read.
  for (const thrown of [apiError("internal_error", 500), new Error("Failed to fetch"), null]) {
    const wrapped = stop.withSessionAnswers(
      deps({
        listSessions: async () => {
          throw thrown;
        }
      }).deps
    );
    assert.equal((await stop.stopEverythingWith(wrapped)).sessionsChecked, false, String(thrown));
  }

  const stopOne = (stopSession) =>
    stop.stopEverythingWith(stop.withSessionAnswers(deps({ listSessions: async () => ({ sessions: [session("s1")] }), stopSession }).deps));
  const counts = (result) => [result.sessionsStopped, result.sessionsAlreadyEnded, result.sessionsFailed];
  assert.deepEqual(counts(await stopOne(async () => ({ id: "s1", status: "exited", endedBy: "stop", note: null }))), [1, 0, 0], "stopped by this stop");
  assert.deepEqual(
    counts(await stopOne(async () => ({ id: "s1", status: "exited", endedBy: null, exitCode: 0, note: null }))),
    [0, 1, 0],
    "it had ended by itself"
  );
  assert.deepEqual(counts(await stopOne(async () => ({ id: "s1", status: "exited", endedBy: "quit", note: null }))), [0, 1, 0], "it ended when Agent OS quit");
  assert.deepEqual(
    counts(
      await stopOne(async () => {
        throw apiError("unknown_session", 404);
      })
    ),
    [0, 1, 0],
    "it is gone"
  );
  assert.deepEqual(
    counts(
      await stopOne(async () => {
        throw Object.assign(new Error("gone"), { code: "unknown_session" });
      })
    ),
    [0, 1, 0],
    "a refusal that carries `code` works too"
  );
  for (const thrown of [apiError("internal_error", 500), apiError("not_available", 404), new Error("Failed to fetch"), "a string", undefined]) {
    assert.deepEqual(
      counts(
        await stopOne(async () => {
          throw thrown;
        })
      ),
      [0, 0, 1],
      String(thrown)
    );
  }
  // An answer this logic does not recognise is a stop the server said yes to.
  assert.deepEqual(counts(await stopOne(async () => ({ ok: true }))), [1, 0, 0]);
});

test("withSessionAnswers changes nothing but the two session requests", () => {
  const base = deps().deps;
  const wrapped = stop.withSessionAnswers(base);
  for (const name of ["listRuns", "stopRun", "listRooms", "stopRoom", "isAgentWork"]) assert.equal(wrapped[name], base[name], name);
  assert.notEqual(wrapped.listSessions, base.listSessions);
  assert.notEqual(wrapped.stopSession, base.stopSession);
});

// Carry-forward from S7: the Stop route answers 409 session_busy for an ended session that is being
// resumed or dismissed right now. It is not a stop that failed; the session had ended.
test("withSessionAnswers: a 409 session_busy (an ended session being resumed or dismissed) is 'already ended', never a failure", async () => {
  const busyRefusal = () =>
    Object.assign(new Error("session_busy"), { name: "ApiError", status: 409, detail: "This session is already being changed. Try again in a moment." });
  const stopWith = (stopSession, sessions = [session("s1")]) =>
    stop.stopEverythingWith(stop.withSessionAnswers(deps({ listSessions: async () => ({ sessions }), stopSession }).deps));
  const counts = (result) => [result.sessionsStopped, result.sessionsAlreadyEnded, result.sessionsFailed];

  const only = await stopWith(async () => {
    throw busyRefusal();
  });
  assert.deepEqual(counts(only), [0, 1, 0]);
  assert.deepEqual(stop.stopAllMessage(only), { message: "1 session had already ended, so there was nothing to stop.", tone: "neutral" });

  // A refusal that carries `code` works too.
  const byCode = await stopWith(async () => {
    throw Object.assign(new Error("busy"), { code: "session_busy" });
  });
  assert.deepEqual(counts(byCode), [0, 1, 0]);

  // Next to a session that was really stopped: both are said, and the tone stays calm.
  const mixed = await stopWith(
    async (id) => {
      if (id === "busy") throw busyRefusal();
      return { id, status: "exited", endedBy: "stop", note: null };
    },
    [session("ok"), session("busy")]
  );
  assert.deepEqual(counts(mixed), [1, 1, 0]);
  assert.deepEqual(stop.stopAllMessage(mixed), { message: "Stopped 1 session. 1 session had already ended.", tone: "ok" });
});

// ---- fix round 1 (S10 review) --------------------------------------------------------------------

// A process stuck in uninterruptible I/O can survive the Stop sequence's SIGKILL: the Stop route then answers
// the session's summary with a status that is not "exited". That is not a session we stopped, and it is not a
// request that got no answer either: Agent OS did answer, and the session IS still running.
test("a Stop answer that says the session has not ended reads as 'still running after its Stop': never 'Stopped', and never 'did not answer in time'", async () => {
  const stopWith = (stopSession, sessions = [session("s1")]) =>
    stop.stopEverythingWith(stop.withSessionAnswers(deps({ listSessions: async () => ({ sessions }), stopSession }).deps));
  const counts = (result) => [result.sessionsStopped, result.sessionsStillRunning, result.sessionsTimedOut, result.sessionsAlreadyEnded, result.sessionsFailed];
  const exited = (id) => ({ id, status: "exited", endedBy: "stop", note: null });
  const stuck = (id, status = "live") => ({ id, status, endedBy: null, note: null });

  for (const status of ["live", "idle", "starting", "waiting", "held", "mystery"]) {
    const result = await stopWith(async (id) => stuck(id, status));
    assert.deepEqual(counts(result), [0, 1, 0, 0, 0], status);
    assert.equal(result.sessions, 1, status);
    assert.deepEqual(
      stop.stopAllMessage(result),
      { message: "Nothing was confirmed stopped. 1 session is still running after its Stop: check Sessions.", tone: "warn" },
      status
    );
    assert.doesNotMatch(stop.stopAllMessage(result).message, /did not answer|may still be running/, `${status}: Agent OS did answer, and the session is not 'maybe' running`);
  }

  // Next to a session that really stopped: each in its own words, and the tone is not calm.
  const mixed = await stopWith(async (id) => (id === "stuck" ? stuck(id) : exited(id)), [session("ok"), session("stuck")]);
  assert.deepEqual(counts(mixed), [1, 1, 0, 0, 0]);
  assert.deepEqual(stop.stopAllMessage(mixed), { message: "Stopped 1 session. 1 session is still running after its Stop: check Sessions.", tone: "warn" });

  // Two of them: the words agree in number.
  const two = await stopWith(async (id) => stuck(id), [session("a"), session("b")]);
  assert.deepEqual(counts(two), [0, 2, 0, 0, 0]);
  assert.equal(stop.stopAllMessage(two).message, "Nothing was confirmed stopped. 2 sessions are still running after their Stop: check Sessions.");

  // A request that really got no answer is still told as no answer, apart from one that answered "still running".
  await withFastClock(async () => {
    const both = await stopWith(async (id) => (id === "slow" ? never() : stuck(id)), [session("slow"), session("stuck")]);
    assert.deepEqual(counts(both), [0, 1, 1, 0, 0]);
    assert.deepEqual(stop.stopAllMessage(both), {
      message:
        "Nothing was confirmed stopped. Agent OS did not answer in time about 1 session, so it may still be running: check Sessions. 1 session is still running after its Stop: check Sessions.",
      tone: "warn"
    });
  });

  // With a session that had already ended, "nothing to stop" is not said: one is still running.
  const withEnded = await stopWith(async (id) => (id === "gone" ? stop.SESSION_ALREADY_ENDED : stuck(id)), [session("gone"), session("stuck")]);
  assert.deepEqual(counts(withEnded), [0, 1, 0, 1, 0]);
  assert.deepEqual(stop.stopAllMessage(withEnded), {
    message: "Nothing was confirmed stopped. 1 session is still running after its Stop: check Sessions. 1 session had already ended.",
    tone: "warn"
  });

  // An OpenClaw session that is still running is not one that was stopped, so no "last step" note.
  const stuckOpenClaw = await stopWith(async (id) => stuck(id), [session("oc", { agentId: "openclaw" })]);
  assert.equal(stuckOpenClaw.openClawStopped, 0);
  assert.equal(stuckOpenClaw.sessionsStillRunning, 1);
  assert.doesNotMatch(stop.stopAllMessage(stuckOpenClaw).message, /finishing its last step/);

  // An answer this logic does not recognise stays a stop the server said yes to.
  for (const answer of [{ ok: true }, {}, null, "ok", { status: 5 }, { id: "s1" }, { status: "exited", endedBy: "stop" }]) {
    assert.deepEqual(counts(await stopWith(async () => answer)), [1, 0, 0, 0, 0], JSON.stringify(answer));
  }

  // A result from before this field existed reads as no session still running.
  const older = await stopWith(async (id) => exited(id));
  delete older.sessionsStillRunning;
  assert.deepEqual(stop.stopAllMessage(older), { message: "Stopped 1 session.", tone: "ok" });
});

// The palette's dialog keeps open and says which sessions are still running (it looks again), as it does for
// a Stop that failed or timed out: so it must not count a still-running session as a clean stop.
test("the palette's dialog treats a session that is still running after its Stop like a Stop that failed: it stays open and says so", async () => {
  const { readFileSync } = await import("node:fs");
  const modal = readFileSync(new URL("../src/ui/components/StopAllRunsModal.tsx", import.meta.url), "utf8");
  const clean = modal.slice(modal.indexOf("const clean ="), modal.indexOf("if (clean)"));
  for (const field of ["failed", "timedOut", "roomsFailed", "roomsTimedOut", "sessionsFailed", "sessionsTimedOut", "sessionsStillRunning"]) {
    assert.match(clean, new RegExp(`result\\.${field}\\b`), `the dialog's 'clean' check counts ${field}`);
  }
});

// The hold needs only what is running, and a hung agent CLI (agent detection for Resume) must not delay it.
test("the stop lists live sessions only (live=1), never the ended ones", async () => {
  const { readFileSync } = await import("node:fs");
  const wiring = readFileSync(new URL("../src/ui/stopAll.ts", import.meta.url), "utf8");
  assert.match(wiring, /request<\{ sessions: StoppableSession\[\] \}>\("\/api\/sessions\?kind=all&live=1"\)/, "both kinds, live only");
  assert.doesNotMatch(wiring, /"\/api\/sessions\?kind=all"/, "no list of ended sessions");
});

test("session Stops run at most 4 at a time, so rooms and runs keep their connections and never wait behind a session", async () => {
  const asked = [];
  const letGo = [];
  let pending = 0;
  let mostPending = 0;
  const { deps: d, calls } = deps({
    listRuns: async () => ({ runs: [run("r1", "agent"), run("r2", "agent")] }),
    listRooms: async () => ({ rooms: [room("room-1")] }),
    listSessions: async () => ({ sessions: Array.from({ length: 8 }, (_, index) => session(`s${index}`)) }),
    stopSession: (id) => {
      asked.push(id);
      pending += 1;
      mostPending = Math.max(mostPending, pending);
      return new Promise((resolve) => {
        letGo.push(() => {
          pending -= 1;
          resolve({ id, status: "exited", endedBy: "stop", note: null });
        });
      });
    }
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const all = stop.stopEverythingWith(d);

  // The rooms and the runs are stopped while four session Stops are still waiting for their answers.
  for (let turn = 0; turn < 100 && calls.stopRun.length < 2; turn += 1) await settle();
  assert.deepEqual(calls.stopRoom, ["room-1"]);
  assert.deepEqual(calls.stopRun, ["r1", "r2"], "the runs did not wait behind the sessions");
  assert.deepEqual(asked, ["s0", "s1", "s2", "s3"], "four at once; the fifth waits for a free place");
  assert.equal(pending, 4);

  // As each one answers, the next waiting session is asked; never more than four are pending.
  for (let finished = 0; finished < 8; finished += 1) {
    for (let turn = 0; turn < 100 && letGo.length === 0; turn += 1) await settle();
    assert.ok(letGo.length > 0, `session Stop number ${finished + 1} was asked`);
    letGo.shift()();
  }
  const result = await all;
  assert.equal(mostPending, 4);
  assert.deepEqual([...asked].sort(), ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"], "each session got its own Stop, once");
  assert.equal(result.sessions, 8);
  assert.equal(result.sessionsStopped, 8);
  assert.equal(stop.stopAllMessage(result).message, "Stopped 8 sessions, 2 runs and 1 Team Room.");
});

test("one more look at the live sessions after the Stops: a session that was still starting when the hold looked is stopped too", async () => {
  const order = [];
  let looks = 0;
  const { deps: d, calls } = deps({
    listSessions: async () => {
      looks += 1;
      order.push(`look ${looks}`);
      // The second look also names the first session (already stopped, so still known) and an ended one.
      return {
        sessions:
          looks === 1
            ? [session("a")]
            : [session("a"), session("late", { status: "starting" }), session("late-oc", { agentId: "openclaw" }), session("old", { status: "exited" })]
      };
    },
    stopSession: async (id) => {
      order.push(`stop ${id}`);
      calls.stopSession.push(id);
      return { id, status: "exited", endedBy: "stop", note: null };
    }
  });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(order, ["look 1", "stop a", "look 2", "stop late", "stop late-oc"], "the second look comes after the first Stops, and 'a' is not stopped twice");
  assert.deepEqual([result.sessions, result.sessionsStopped, result.sessionsFailed, result.sessionsTimedOut, result.sessionsAlreadyEnded, result.sessionsStillRunning], [3, 3, 0, 0, 0, 0]);
  assert.equal(result.openClawStopped, 1, "a late OpenClaw session is counted too");
  assert.deepEqual(stop.stopAllMessage(result), { message: "Stopped 3 sessions. OpenClaw may still be finishing its last step.", tone: "ok" });

  // Nothing was running at the first look: the toast does not say so when a session turns up in the second.
  let secondLook = false;
  const { deps: none, calls: noneCalls } = deps({
    listSessions: async () => {
      const sessions = secondLook ? [session("starting-one", { status: "starting" })] : [];
      secondLook = true;
      return { sessions };
    }
  });
  const late = await stop.stopEverythingWith(none);
  assert.deepEqual(noneCalls.stopSession, ["starting-one"]);
  assert.deepEqual(stop.stopAllMessage(late), { message: "Stopped 1 session.", tone: "ok" });

  // A second look that cannot be read leaves what the first stopped as it was.
  await withFastClock(async () => {
    let reads = 0;
    const { deps: hung } = deps({ listSessions: () => (reads++ === 0 ? Promise.resolve({ sessions: [session("a")] }) : never()) });
    const kept = await stop.stopEverythingWith(hung);
    assert.equal(kept.sessionsChecked, true);
    assert.deepEqual([kept.sessions, kept.sessionsStopped], [1, 1]);
    assert.deepEqual(stop.stopAllMessage(kept), { message: "Stopped 1 session.", tone: "ok" });
  });

  // A first list that could not be read is not retried: it is said as before (the words were tested above).
  await withFastClock(async () => {
    let reads = 0;
    const { deps: unread } = deps({
      listSessions: () => {
        reads += 1;
        return never();
      }
    });
    const result2 = await stop.stopEverythingWith(unread);
    assert.equal(reads, 1);
    assert.equal(result2.sessionsChecked, false);
  });

  // A session that failed to stop is not asked again just because the second look still lists it.
  const { deps: stubborn, calls: stubbornCalls } = deps({
    listSessions: async () => ({ sessions: [session("stuck")] }),
    stopSession: async (id) => {
      stubbornCalls.stopSession.push(id);
      throw new Error("refused");
    }
  });
  const failed = await stop.stopEverythingWith(stubborn);
  assert.deepEqual(stubbornCalls.stopSession, ["stuck"]);
  assert.equal(failed.sessionsFailed, 1);

  // The same look-then-stop, with the option the hold sets, does look again.
  let optionLooks = 0;
  const { deps: option, calls: optionCalls } = deps({
    listSessions: async () => {
      optionLooks += 1;
      return { sessions: optionLooks === 1 ? [session("a")] : [session("a"), session("b")] };
    }
  });
  await stop.stopWhatWasFound(option, await stop.lookForStoppable(option), { lookAgainForSessions: true });
  assert.deepEqual(optionCalls.stopSession, ["a", "b"]);
});

// The palette's dialog names what it would stop ("Stop 1 session") and its yes must stop exactly that.
test("the palette's confirm stops only the sessions its dialog listed: a session that appeared after the look is left alone", async () => {
  let looks = 0;
  const { deps: palette, calls } = deps({
    listSessions: async () => {
      looks += 1;
      // The dialog looked once (only "a"); another window, or a New session that was still starting, adds "b".
      return { sessions: looks === 1 ? [session("a")] : [session("a"), session("b", { kind: "update", agentId: "hermes" })] };
    }
  });
  const look = await stop.lookForStoppable(palette);
  assert.deepEqual(look.sessions.map((s) => s.id), ["a"], "the dialog names what it saw");
  const result = await stop.stopWhatWasFound(palette, look);
  assert.deepEqual(calls.stopSession, ["a"], "only the listed session is stopped");
  assert.equal(looks, 1, "the sessions are not read again after the person says yes");
  assert.deepEqual([result.sessions, result.sessionsStopped], [1, 1]);
  assert.deepEqual(stop.stopAllMessage(result), { message: "Stopped 1 session.", tone: "ok" }, "the toast matches the dialog's count");
  // The same holds with a dialog that listed nothing: a session that turns up later is not stopped.
  let emptyLooks = 0;
  const { deps: emptyDialog, calls: emptyCalls } = deps({
    listSessions: async () => {
      emptyLooks += 1;
      return { sessions: emptyLooks === 1 ? [] : [session("late", { status: "starting" })] };
    }
  });
  await stop.stopWhatWasFound(emptyDialog, await stop.lookForStoppable(emptyDialog));
  assert.deepEqual(emptyCalls.stopSession, []);
  assert.equal(emptyLooks, 1);
});

test("the dialog's list wraps a long word (a folder name) inside the dialog instead of running out of it", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
  assert.match(read("../src/ui/components/StopAllRunsModal.tsx"), /<ul className="os-stopall__list">/);
  // shell.css is loaded with the whole window (DashboardRoot.tsx), so the rule is there whichever page is open.
  assert.match(read("../src/ui/shell.css"), /\.os-stopall__list li\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test("thingsWord names sessions first, then runs, then Team Rooms; the old two-number calls read as before", () => {
  assert.equal(stop.thingsWord(1, 0, 1), "1 session and 1 run");
  assert.equal(stop.thingsWord(0, 0, 2), "2 sessions");
  assert.equal(stop.thingsWord(0, 1, 2), "2 sessions and 1 Team Room");
  assert.equal(stop.thingsWord(2, 3, 4), "4 sessions, 2 runs and 3 Team Rooms");
  assert.equal(stop.thingsWord(2, 3), "2 runs and 3 Team Rooms");
  assert.equal(stop.thingsWord(0, 0), "0 runs");
});

test("sessionStopTitle names a session the way the Sessions page does", () => {
  assert.equal(stop.sessionStopTitle(session("a")), "Claude Code · my-app");
  assert.equal(stop.sessionStopTitle(session("b", { agentId: "openclaw" })), "OpenClaw · Set by OpenClaw");
  assert.equal(stop.sessionStopTitle(session("c", { kind: "update", agentId: "hermes" })), "Hermes update");
  assert.equal(stop.sessionStopTitle(session("d", { folderName: "" })), "Claude Code · —", "— means unknown");
  assert.equal(stop.sessionStopTitle({ id: "e", status: "live" }), "Agent · —");
});

test("the palette's look lists the sessions it would stop, before the person says yes", async () => {
  const { deps: d, calls } = deps({
    listSessions: async () => ({ sessions: [session("s1"), session("s2", { status: "exited" }), session("s3", { kind: "update", agentId: "hermes" })] })
  });
  const look = await stop.lookForStoppable(d);
  assert.deepEqual(look.sessions.map((s) => s.id), ["s1", "s3"]);
  assert.equal(look.sessionsChecked, true);
  assert.equal(calls.stopSession.length, 0, "looking stops nothing");
  const result = await stop.stopWhatWasFound(d, look);
  assert.deepEqual(calls.stopSession, ["s1", "s3"]);
  assert.equal(result.sessionsStopped, 2);
});

test("the palette's Stop all agent work and the hold share one code path (no second list, no unguarded requests, no service control)", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
  const modal = read("../src/ui/components/StopAllRunsModal.tsx");
  const wiring = read("../src/ui/stopAll.ts");
  const shared = read("../src/ui/stopAllShared.ts");
  const shell = read("../src/ui/Shell.tsx");
  assert.match(modal, /lookForWhatToStop/, "the dialog looks through stopAll.ts");
  assert.match(modal, /stopWhatWasLookedAt/, "the dialog stops through stopAll.ts");
  assert.match(modal, /look\?\.sessions/, "the dialog lists the sessions it found");
  assert.doesNotMatch(modal, /from "\.\.\/\.\.\/api"/, "the dialog makes no request of its own");
  assert.doesNotMatch(modal, /ACTIVE\s*=/, "the dialog keeps no list of statuses of its own");
  assert.match(wiring, /from "\.\/agentWork"/, "the agent-work rule comes from agentWork.ts");
  assert.match(wiring, /listTeamRooms/);
  assert.match(wiring, /stopTeamRoom/);
  assert.match(wiring, /"\/api\/sessions\?kind=all&live=1"/, "both kinds of session are listed, live ones only");
  assert.match(wiring, /\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/stop/, "each session goes through its own Stop");
  assert.match(wiring, /withSessionAnswers\(\s*withEndedRooms\(/);
  // Only the hold looks for a late session; the palette's confirm (stopWhatWasLookedAt) sets no option.
  assert.match(shared, /stopWhatWasFound\(deps, await lookForStoppable\(deps\), \{ lookAgainForSessions: true \}\)/, "the hold looks again");
  assert.doesNotMatch(wiring, /lookAgainForSessions/, "the palette's confirm does not look again");
  for (const [name, text] of [["stopAll.ts", wiring], ["stopAllShared.ts", shared], ["StopAllRunsModal.tsx", modal]]) {
    assert.doesNotMatch(text, /postAgentService|\/service\//, `${name} never calls a service control (D11)`);
  }
  assert.match(shell, /label: "Stop all agent work"/, "the palette item says what it stops");
  assert.doesNotMatch(shell, /"Stop all runs"/);
});

test("D11 words: every sentence that names the Hermes service or the OpenClaw Gateway says the stop does NOT stop it", async () => {
  const { readFileSync } = await import("node:fs");
  const flat = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/&apos;/g, "'").replace(/\s+/g, " ");
  const hold = flat("../src/ui/components/HoldToStopAll.tsx");
  const info = flat("../src/ui/components/SafetyStopInfo.tsx");
  for (const [name, text] of [["HoldToStopAll.tsx", hold], ["SafetyStopInfo.tsx", info]]) {
    const sentences = text.split(/(?<=\.)\s+/).filter((sentence) => /Hermes (or OpenClaw )?background service|OpenClaw Gateway/.test(sentence));
    assert.ok(sentences.length > 0, `${name} still says what it does not stop`);
    for (const sentence of sentences) assert.match(sentence, /does not stop/, `${name}: ${sentence}`);
    assert.match(text, /every session and every agent run/, `${name} says sessions are stopped`);
    assert.match(text, /Stop all agent work/, `${name} names the palette item by its new name`);
    assert.doesNotMatch(text, /Stop all runs/, `${name} no longer names the old item`);
  }
  // The two honest limits of a session's Stop, in the Help page's own words (ruling R24).
  assert.match(info, /A Claude Code background task moved with \/bg may keep running if Agent OS can't find it/);
  assert.match(info, /OpenClaw may still finish its last step after the terminal closes/);
});

// ---- end to end: real sessions of both kinds, stopped through the Stop route (in process) ---------
//
// The real session manager and the real sessions router (behind requireLocalMode, as server/index.js
// mounts it) on a real port, with W1's TUI-like fake agents on PATH, W1's stand-in login shell as SHELL
// and a temp HOME (H1: tests only; planning decision Q1c). The runs and rooms are fakes here (their own
// tests cover them), so this test is about the sessions: both kinds are found by GET
// /api/sessions?kind=all&live=1 (the live ones only; read before and after the Stops), each is stopped
// through POST /api/sessions/:id/stop, nothing but those two
// requests is ever made, and W1's gateway tripwire (FAKE_AGENT_LOG) shows that no session's Stop ran a
// Hermes or OpenClaw service control itself (design spec D11 and SP3 "done when").

const isWindows = process.platform === "win32";
const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

// The same answer rules as request() in src/api.ts: a refusal throws an ApiError whose message is the server's code.
async function httpJson(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(body?.error || `${response.status}`), { name: "ApiError", status: response.status, detail: body?.message || "" });
  }
  return body;
}

// The fakes' event log (W1): one JSON line per event, each with name, pid and at.
async function readFakeLog(file) {
  const text = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test(
  "end to end: the hold stops a real agent session, an OpenClaw session and a fake updater's update session through their Stop, with the runs, and never asks for a service control",
  { skip: isWindows ? "the fake agents are POSIX shims (the sessions engine's own tests cover Windows)" : false },
  async () => {
    // Real paths: on macOS os.tmpdir() sits behind a symlink, and the folder policy compares real paths.
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-stopall-home-")));
    const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-stopall-data-")));
    const bin = path.join(home, "fake-bin");
    const folder = path.join(home, "projects", "my-app");
    const logFile = path.join(home, "fake.log");
    try {
      await mkdir(folder, { recursive: true });
      // All six names in the TUI mode (planning decision Q1c), then the hermes shim again as the fake
      // updater, so the update session is an updater waiting at its question.
      await makeFakeAgentBin(bin);
      await makeFakeAgentBin(bin, { names: ["hermes"], mode: "updater" });
      await withEnv(
        {
          HOME: home,
          USERPROFILE: home,
          AGENT_OS_HOME: agentOsHome,
          HERMES_AGENT_OS_HOME: undefined,
          AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
          SHELL: FAKE_LOGIN_SHELL,
          PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
          HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
          // W1's tripwire: every fake (the sessions and any soft-stop CLI call) logs here. The login-shell
          // environment is read after resetLoginShellEnvForTests() below, so the sessions inherit it.
          FAKE_AGENT_LOG: logFile,
          FAKE_AGENT_MODE: undefined,
          HERMES_HOME: undefined,
          HERMES_AGENT_OS_ENABLE_EXEC: undefined,
          DEMO_PUBLIC: undefined,
          HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
          HERMES_AGENT_OS_PUBLIC_MODE: undefined,
          HERMES_AGENT_OS_REQUIRE_AUTH: undefined
        },
        async () => {
          assert.equal(os.homedir(), home, "tests must never see the real home folder");
          clearDetectCaches();
          resetLoginShellEnvForTests();
          await setExecutionGateStatus({ enabled: true, reason: "stop-all test" });
          const manager = createSessionManager();
          const requests = [];
          const app = express();
          app.use((req, _res, next) => {
            requests.push(`${req.method} ${req.originalUrl}`);
            next();
          });
          app.use(express.json());
          app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
          // A service control that must never be reached (D11).
          app.post("/api/agents/:id/service/:action", (_req, res) => res.status(500).json({ error: "service_control_called" }));
          app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
          const server = await new Promise((resolve) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
          });
          const base = `http://127.0.0.1:${server.address().port}`;
          const ids = [];
          try {
            const claude = await manager.create({ agentId: "claude", folder });
            // OpenClaw picks its own folder for now (OPENCLAW_FOLDER_HONOURED is false), so no folder is sent.
            const openclaw = await manager.create({ agentId: "openclaw", folder: null });
            const update = await manager.createUpdateSession({ agentId: "hermes", folder });
            assert.equal(update.kind, "update");
            ids.push(claude.id, openclaw.id, update.id);
            // Each fake terminal program has started (its first output takes it out of "starting") and keeps running.
            for (const id of ids) {
              await waitFor(async () => (await manager.get(id)).status !== "starting");
              assert.notEqual((await manager.get(id)).status, "exited", `${id} keeps running until it is stopped`);
            }

            const runsStopped = [];
            const result = await stop.stopEverythingWith(
              stop.withSessionAnswers({
                listRuns: async () => ({ runs: [run("a1", "agent"), run("gw", "service")] }),
                stopRun: async (id) => {
                  runsStopped.push(id);
                  return {};
                },
                listRooms: async () => ({ rooms: [] }),
                stopRoom: async () => ({}),
                // The same address as realStopAllDeps in src/ui/stopAll.ts: both kinds, the live ones only.
                listSessions: () => httpJson(`${base}/api/sessions?kind=all&live=1`),
                stopSession: (id) => httpJson(`${base}/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }),
                isAgentWork: work.isAgentWork
              })
            );

            assert.equal(result.sessionsChecked, true);
            assert.equal(result.sessions, 3, "both kinds are found: two agent sessions and the update session");
            assert.equal(result.sessionsStopped, 3);
            assert.equal(result.sessionsFailed + result.sessionsTimedOut + result.sessionsAlreadyEnded + result.sessionsStillRunning, 0);
            assert.equal(result.openClawStopped, 1);
            assert.deepEqual(runsStopped, ["a1"], "the agent run is stopped; the Hermes gateway job (a service run) is left alone");
            for (const id of ids) {
              const after = await manager.get(id);
              assert.equal(after.status, "exited", id);
              assert.equal(after.endedBy, "stop", id);
            }
            assert.deepEqual(stop.stopAllMessage(result), {
              message:
                "Stopped 3 sessions and 1 run. OpenClaw may still be finishing its last step. 1 setup or service job was left running. It is not agent work; manage it in Setup or Agents.",
              tone: "ok"
            });
            const others = requests.filter(
              (line) => line !== "GET /api/sessions?kind=all&live=1" && !/^POST \/api\/sessions\/[0-9a-f-]+\/stop$/.test(line)
            );
            assert.deepEqual(others, [], "only the sessions list and each session's Stop were requested");
            assert.equal(requests.filter((line) => line.startsWith("POST ")).length, 3, "one Stop per session");
            // One look before the Stops and one after them (a session that was still starting is stopped too).
            assert.equal(requests.filter((line) => line.startsWith("GET ")).length, 2, "the live list is read twice");

            const entries = await readFakeLog(logFile);
            // Each fake terminal program started as its session, and its own Stop ended it with SIGTERM.
            const started = entries.filter((entry) => entry.event === "start");
            assert.deepEqual(started.map((entry) => entry.name).sort(), ["claude", "hermes", "openclaw"]);
            const updater = started.find((entry) => entry.name === "hermes");
            assert.equal(updater.mode, "updater");
            assert.deepEqual(updater.argv, ["update"], "the update session runs the fake updater");
            for (const entry of started) {
              assert.ok(entries.some((other) => other.event === "sigterm" && other.pid === entry.pid), `${entry.name} was stopped with SIGTERM`);
            }
            // No HTTP request is not enough: a session's own Stop could run `hermes gateway stop` or
            // `openclaw gateway stop` itself. The OpenClaw soft stop makes no CLI call yet (Task S7, until
            // spike S5), so any "gateway" line in the fakes' log is a service control.
            assert.deepEqual(entries.filter((entry) => entry.event === "gateway"), [], "no session stop touched a Gateway or service");
          } finally {
            await manager.shutdownAll({ reason: "quit" });
            // The exit handler writes meta.json once the process has ended; wait for it, so nothing writes
            // into the temp folders after they are removed.
            for (const id of ids) {
              await waitFor(
                async () => {
                  try {
                    return JSON.parse(await readFile(path.join(agentOsHome, "sessions", id, "meta.json"), "utf8")).status === "exited";
                  } catch {
                    return false;
                  }
                },
                { timeoutMs: 5000 }
              ).catch(() => {});
            }
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
            resetLoginShellEnvForTests();
            clearDetectCaches();
          }
        }
      );
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(agentOsHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
);

// ---- plan brains (Task B1a): a setup session (OpenClaw's ChatGPT sign-in) ---------------------------

test("a setup session (OpenClaw's ChatGPT sign-in) is stopped like any session, never adds the OpenClaw note, and is named 'OpenClaw · ChatGPT sign-in'", async () => {
  const signIn = { ...session("su", { kind: "setup", agentId: "openclaw" }), folderName: "you" };
  assert.equal(stop.sessionStopTitle(signIn), "OpenClaw · ChatGPT sign-in");
  const { deps: d, calls } = deps({ listSessions: async () => ({ sessions: [signIn] }) });
  const result = await stop.stopEverythingWith(d);
  assert.deepEqual(calls.stopSession, ["su"]);
  assert.equal(result.sessionsStopped, 1);
  assert.equal(result.openClawStopped, 0, "a sign-in has no last step to finish");
  assert.deepEqual(stop.stopAllMessage(result), { message: "Stopped 1 session.", tone: "ok" });
  // Next to an OpenClaw agent session, the note is said for that one only.
  const { deps: both } = deps({ listSessions: async () => ({ sessions: [signIn, session("oc", { agentId: "openclaw" })] }) });
  const mixed = await stop.stopEverythingWith(both);
  assert.equal(mixed.openClawStopped, 1);
  assert.deepEqual(stop.stopAllMessage(mixed), { message: "Stopped 2 sessions. OpenClaw may still be finishing its last step.", tone: "ok" });
});

// Found in E1's walkthrough: the dialog said "OpenClaw may still finish its last step" for a lone sign-in while
// the result left it out. Both now ask the same question.
test("the palette's dialog brings the OpenClaw note for an OpenClaw agent session, never for a setup session (its ChatGPT sign-in)", async () => {
  const { readFileSync } = await import("node:fs");
  assert.equal(stop.bringsOpenClawNote({ agentId: "openclaw", kind: "setup" }), false, "a sign-in has no last step to finish");
  assert.equal(stop.bringsOpenClawNote({ agentId: "openclaw", kind: "agent" }), true);
  assert.equal(stop.bringsOpenClawNote({ agentId: "openclaw" }), true, "a session with no kind is an agent session");
  assert.equal(stop.bringsOpenClawNote({ agentId: "claude", kind: "agent" }), false);
  const modal = readFileSync(new URL("../src/ui/components/StopAllRunsModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /const openClawListed = sessions\.some\(bringsOpenClawNote\);/, "the dialog asks bringsOpenClawNote");
  assert.match(modal, /\{openClawListed \? <p>OpenClaw may still finish its last step after the terminal closes\.<\/p> : null\}/);
});

test(
  "end to end: Hold to stop all stops a real setup session (OpenClaw's ChatGPT sign-in) through its Stop, without the OpenClaw note; the palette's look names it 'OpenClaw · ChatGPT sign-in'",
  { skip: isWindows ? "the fake agents are POSIX shims (the sessions engine's own tests cover Windows)" : false },
  async () => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-stopall-setup-home-")));
    const agentOsHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-os-stopall-setup-data-")));
    const bin = path.join(home, "fake-bin");
    const logFile = path.join(home, "fake.log");
    try {
      await makeFakeAgentBin(bin);
      await withEnv(
        {
          HOME: home,
          USERPROFILE: home,
          AGENT_OS_HOME: agentOsHome,
          HERMES_AGENT_OS_HOME: undefined,
          AGENT_OS_MANAGED_ROOT: path.join(home, ".agent-os"),
          SHELL: FAKE_LOGIN_SHELL,
          PATH: [bin, ...SYSTEM_PATH_DIRS].join(path.delimiter),
          HERMES_AGENT_OS_EXECUTABLE_PATHS: undefined,
          FAKE_AGENT_LOG: logFile,
          FAKE_AGENT_MODE: undefined,
          HERMES_HOME: undefined,
          HERMES_AGENT_OS_ENABLE_EXEC: undefined,
          DEMO_PUBLIC: undefined,
          HERMES_AGENT_OS_DEMO_PUBLIC: undefined,
          HERMES_AGENT_OS_PUBLIC_MODE: undefined,
          HERMES_AGENT_OS_REQUIRE_AUTH: undefined
        },
        async () => {
          assert.equal(os.homedir(), home, "tests must never see the real home folder");
          clearDetectCaches();
          resetLoginShellEnvForTests();
          const manager = createSessionManager();
          const app = express();
          app.use(express.json());
          app.use("/api/sessions", requireLocalMode, createSessionsRouter({ manager }));
          app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
          const server = await new Promise((resolve) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
          });
          const base = `http://127.0.0.1:${server.address().port}`;
          try {
            // Made the way POST /api/setup/openclaw/signin-terminal makes it (that route is tested in
            // test/setup-session-kind.test.js); the manager finds the fake openclaw itself.
            const signIn = await manager.createSetupSession({ action: OPENCLAW_SIGNIN_ACTION });
            assert.equal(signIn.kind, "setup");
            await waitFor(async () => (await readFakeLog(logFile)).some((entry) => entry.event === "start" && entry.name === "openclaw"));
            const answers = stop.withSessionAnswers({
              listRuns: async () => ({ runs: [] }),
              stopRun: async () => ({}),
              listRooms: async () => ({ rooms: [] }),
              stopRoom: async () => ({}),
              // The same addresses as realStopAllDeps in src/ui/stopAll.ts.
              listSessions: () => httpJson(`${base}/api/sessions?kind=all&live=1`),
              stopSession: (id) => httpJson(`${base}/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }),
              isAgentWork: work.isAgentWork
            });
            // The palette's look: its dialog lists the sign-in by this title.
            const look = await stop.lookForStoppable(answers);
            assert.deepEqual(look.sessions.map((item) => stop.sessionStopTitle(item)), ["OpenClaw · ChatGPT sign-in"]);

            const result = await stop.stopEverythingWith(answers);
            assert.equal(result.sessions, 1);
            assert.equal(result.sessionsStopped, 1);
            assert.equal(result.sessionsFailed + result.sessionsTimedOut + result.sessionsAlreadyEnded + result.sessionsStillRunning, 0);
            assert.equal(result.openClawStopped, 0, "a sign-in has no last step to finish");
            assert.deepEqual(stop.stopAllMessage(result), { message: "Stopped 1 session.", tone: "ok" });
            assert.equal(manager.isLive(signIn.id), false);
            await assert.rejects(manager.get(signIn.id), (error) => error.status === 404 && error.code === "unknown_session");

            const entries = await readFakeLog(logFile);
            const started = entries.find((entry) => entry.event === "start" && entry.name === "openclaw");
            assert.deepEqual(started.argv, ["models", "auth", "login", "--provider", "openai", "--method", "siwc"]);
            assert.ok(entries.some((entry) => entry.event === "sigterm" && entry.pid === started.pid), "its Stop ended it with SIGTERM");
            assert.deepEqual(entries.filter((entry) => entry.event === "gateway"), [], "no Gateway or service command");
          } finally {
            await manager.shutdownAll({ reason: "quit" });
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
            resetLoginShellEnvForTests();
            clearDetectCaches();
          }
        }
      );
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(agentOsHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
);
