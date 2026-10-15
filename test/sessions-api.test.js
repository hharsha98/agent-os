// Sessions (SP3) client requests and the terminal's WebSocket client (src/sessionsApi.ts), driven with a fake
// global WebSocket, a fake fetch and a fake clock. Nothing here talks to a server or starts anything.
// sessionsApi.ts imports its neighbours without a file extension (the Vite way), which Node does not follow by
// itself, so this file teaches Node that one rule first (a resolve hook that adds .ts), then loads the real file.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const extension of [".ts", ".tsx"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
});

const api = await import("../src/sessionsApi.ts");
const { ApiError } = await import("../src/api.ts");
const ss = await import("../src/ui/sessionsShared.ts");

// ---------------------------------------------------------------------------
// Fakes: a WebSocket, fetch, window and a clock
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static made = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = [];
    FakeWebSocket.made.push(this);
  }
  send(text) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("the fake socket is not open");
    this.sent.push(JSON.parse(text));
  }
  // This side closes: the browser then reports the close at once (a real one reports it a moment later).
  close(code, reason) {
    this.closeCalls.push([code, reason]);
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
  }
  // The test plays the server.
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(frame) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  serverClose(code, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const realGlobals = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, window: globalThis.window };
const locked = [];
function installFakes({ signedIn = true } = {}) {
  FakeWebSocket.made = [];
  locked.length = 0;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = {
    location: { protocol: "http:", host: "127.0.0.1:8787" },
    dispatchEvent: (event) => locked.push(event.type)
  };
  globalThis.fetch = async (url) => {
    if (String(url) === "/api/session") return { ok: true, status: 200, json: async () => ({ authenticated: signedIn }) };
    throw new Error(`the fake fetch has no answer for ${url}`);
  };
}
function removeFakes() {
  globalThis.WebSocket = realGlobals.WebSocket;
  globalThis.fetch = realGlobals.fetch;
  if (realGlobals.window === undefined) delete globalThis.window;
  else globalThis.window = realGlobals.window;
}
function fakeFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? "GET" });
    return answer(String(url));
  };
  return calls;
}
const jsonAnswer = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  }
});

// A clock the test moves by hand, so a 15 s limit needs no real waiting.
function fakeClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map();
  let now = 0;
  let next = 1;
  globalThis.setTimeout = (callback, ms = 0) => {
    const id = next++;
    timers.set(id, { at: now + ms, callback });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };
  return {
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    waiting: () => timers.size,
    restore() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
    }
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const SID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = { t: "snapshot", data: "screen", cols: 80, rows: 24, modes: {} };

// Opens a socket with handlers that write into `log`. `over` replaces any handler.
function openSocket(over = {}) {
  const log = [];
  const handlers = {
    onSnapshot: (snap) => {
      log.push(`snapshot:${snap.data}`);
    },
    onOut: (d) => {
      log.push(`out:${d}`);
    },
    onState: (state) => {
      log.push(`state:${state.status}`);
    },
    onAlert: (raw) => {
      log.push(`alert:${raw}`);
    },
    onClose: (info) => {
      log.push(`close:${info.code}:${info.reason}:${info.hadSnapshot}:${info.advice}`);
    },
    ...over
  };
  const socket = api.openSessionSocket(SID, handlers);
  return { socket, ws: FakeWebSocket.made.at(-1), log };
}

// ---------------------------------------------------------------------------
// The terminal's WebSocket client
// ---------------------------------------------------------------------------

test("the socket goes to /api/sessions/:id/attach on this page's host, with no query string", () => {
  installFakes();
  try {
    const { ws } = openSocket();
    assert.equal(ws.url, `ws://127.0.0.1:8787/api/sessions/${SID}/attach`);
    globalThis.window.location.protocol = "https:";
    assert.equal(api.sessionSocketUrl("a b"), "wss://127.0.0.1:8787/api/sessions/a%20b/attach");
  } finally {
    removeFakes();
  }
});

test("frames before the snapshot are dropped; later frames wait until onSnapshot has settled, in order; a second snapshot is ignored", async () => {
  installFakes();
  try {
    const screen = deferred();
    const { ws, log } = openSocket({
      onSnapshot: (snap) => {
        log.push(`snapshot:${snap.data}`);
        return screen.promise;
      }
    });
    ws.open();
    ws.receive({ t: "out", seq: 5, d: "too-early" });
    ws.receive({ t: "state", status: "live" });
    ws.receive("not json");
    ws.receive(SNAPSHOT);
    ws.receive({ t: "out", seq: 5, d: "after" });
    ws.receive({ t: "state", status: "live" });
    ws.receive({ t: "alert", raw: "bel" });
    ws.receive({ ...SNAPSHOT, data: "second" });
    await flush();
    assert.deepEqual(log, ["snapshot:screen"], "the restored screen is still being drawn: nothing after it is delivered yet");
    screen.resolve();
    await flush();
    assert.deepEqual(log, ["snapshot:screen", "out:after", "state:live", "alert:bel"]);
  } finally {
    removeFakes();
  }
});

test("an ack goes out once 64 KB are processed, and only after onOut has settled", async () => {
  installFakes();
  try {
    const drawn = deferred();
    const { ws } = openSocket({ onOut: (d) => (d === "big" ? drawn.promise : undefined) });
    ws.open();
    ws.receive(SNAPSHOT);
    ws.receive({ t: "out", seq: 10_000, d: "small" });
    await flush();
    assert.deepEqual(ws.sent, [], "no ack before 64 KB");
    ws.receive({ t: "out", seq: 70_000, d: "big" });
    await flush();
    assert.deepEqual(ws.sent, [], "the bytes are not on screen yet, so they are not acknowledged");
    drawn.resolve();
    await flush();
    assert.deepEqual(ws.sent, [{ t: "ack", seq: 70_000 }], "acknowledged once drawn, with the seq reached");
    ws.receive({ t: "out", seq: 80_000, d: "more" });
    await flush();
    assert.equal(ws.sent.length, 1, "the next ack waits for another 64 KB");
  } finally {
    removeFakes();
  }
});

test("an onOut that fails gives no ack and no unhandled rejection; a throwing onState, onAlert or onClose is also contained", async () => {
  installFakes();
  const unhandled = [];
  const watch = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", watch);
  try {
    const boom = () => {
      throw new Error("handler failed");
    };
    const { ws } = openSocket({ onOut: boom, onState: boom, onAlert: boom, onClose: boom });
    ws.open();
    ws.receive(SNAPSHOT);
    ws.receive({ t: "out", seq: 70_000, d: "x" });
    ws.receive({ t: "state", status: "exited" });
    ws.receive({ t: "alert", raw: "bel" });
    ws.serverClose(4001, "session_ended");
    await flush();
    assert.deepEqual(ws.sent, [], "nothing was drawn, so nothing is acknowledged");
    assert.deepEqual(unhandled, [], "a handler that throws is not an unhandled rejection");
  } finally {
    process.off("unhandledRejection", watch);
    removeFakes();
  }
});

test("after the server closes the socket, the reason word decides the advice (4000, 4001, 4004 and 1009)", async () => {
  const cases = [
    [4000, "too_far_behind", "reattach"],
    [4001, "session_ended", "ended"],
    [4004, "attach_failed", "wait"],
    [1009, "", "wait"],
    [1006, "", "reattach"],
    [4001, "too_far_behind", "reattach"]
  ];
  for (const [code, reason, advice] of cases) {
    installFakes();
    try {
      const { ws, log } = openSocket();
      ws.open();
      ws.receive(SNAPSHOT);
      ws.serverClose(code, reason);
      await flush();
      assert.deepEqual(log, ["snapshot:screen", `close:${code}:${reason}:true:${advice}`], `${code} "${reason}"`);
    } finally {
      removeFakes();
    }
  }
});

test("onClose says whether a snapshot arrived, and a close before one checks that the person is still signed in", async () => {
  installFakes({ signedIn: true });
  try {
    const { ws, log } = openSocket();
    ws.serverClose(1006, "");
    await flush();
    assert.deepEqual(log, ["close:1006::false:reattach"]);
    assert.deepEqual(locked, [], "still signed in: the page is not locked");
  } finally {
    removeFakes();
  }
  installFakes({ signedIn: false });
  try {
    const { ws } = openSocket();
    ws.serverClose(1008, "refused");
    await flush();
    assert.deepEqual(locked, ["agentos:locked"], "signed out: the page is told");
  } finally {
    removeFakes();
  }
});

test("onClose comes after the screen and the frames before it: a session that exits while the snapshot is still drawing", async () => {
  installFakes();
  try {
    const screen = deferred();
    const { ws, log } = openSocket({
      onSnapshot: (snap) => {
        log.push(`snapshot:${snap.data}`);
        return screen.promise;
      }
    });
    ws.open();
    ws.receive(SNAPSHOT);
    ws.receive({ t: "out", seq: 4, d: "last" });
    ws.receive({ t: "state", status: "exited", exitCode: 0 });
    ws.serverClose(4001, "session_ended");
    await flush();
    assert.deepEqual(log, ["snapshot:screen"], "the close waits for the screen, like every other frame");
    screen.resolve();
    await flush();
    assert.deepEqual(log, ["snapshot:screen", "out:last", "state:exited", "close:4001:session_ended:true:ended"], "once, and last");
  } finally {
    removeFakes();
  }
});

test("close() from this side closes the socket, never calls onClose, and later frames change nothing", async () => {
  installFakes();
  try {
    const { socket, ws, log } = openSocket();
    ws.open();
    ws.receive(SNAPSHOT);
    await flush();
    socket.close();
    ws.receive({ t: "out", seq: 3, d: "late" });
    await flush();
    assert.deepEqual(ws.closeCalls, [[1000, "closed"]]);
    assert.deepEqual(log, ["snapshot:screen"]);
    // A close that is still waiting for the screen is dropped too.
    const screen = deferred();
    const second = openSocket({ onSnapshot: () => screen.promise });
    second.ws.open();
    second.ws.receive(SNAPSHOT);
    second.ws.serverClose(4001, "session_ended");
    second.socket.close();
    screen.resolve();
    await flush();
    assert.deepEqual(second.log, [], "this side closed first, so onClose never comes");
  } finally {
    removeFakes();
  }
});

test("no snapshot within 15 s: the socket is closed and onClose says attach_failed, advising to wait (once)", async () => {
  installFakes();
  const clock = fakeClock();
  try {
    assert.equal(ss.SNAPSHOT_WAIT_MS, 15_000);
    const { ws, log } = openSocket();
    ws.open();
    clock.tick(14_999);
    await flush();
    assert.deepEqual(log, [], "not yet");
    assert.deepEqual(ws.closeCalls, []);
    clock.tick(1);
    await flush();
    assert.deepEqual(log, [`close:${ss.ATTACH_FAILED_CODE}:attach_failed:false:wait`]);
    assert.equal(ss.ATTACH_FAILED_CODE, 4004, "S9's number for attach_failed");
    assert.equal(ws.closeCalls.length, 1, "closed once");
    assert.equal(clock.waiting(), 0, "no timer is left behind");
    ws.receive(SNAPSHOT);
    ws.serverClose(1006, "");
    await flush();
    assert.deepEqual(log, [`close:${ss.ATTACH_FAILED_CODE}:attach_failed:false:wait`], "the close that follows our own close is not reported again");
  } finally {
    clock.restore();
    removeFakes();
  }
});

test("the 15 s limit is cancelled by the snapshot, by a close, and by close() from this side", async () => {
  installFakes();
  const clock = fakeClock();
  try {
    const a = openSocket();
    a.ws.open();
    clock.tick(5000);
    a.ws.receive(SNAPSHOT);
    assert.equal(clock.waiting(), 0, "the snapshot clears the limit");
    clock.tick(60_000);
    await flush();
    assert.deepEqual(a.log, ["snapshot:screen"]);
    assert.deepEqual(a.ws.closeCalls, []);

    const b = openSocket();
    b.ws.serverClose(1006, "");
    await flush(); // the check that the person is still signed in has its own 5 s limit, cleared once it answers
    assert.equal(clock.waiting(), 0, "a close clears the limit");
    clock.tick(60_000);
    await flush();
    assert.deepEqual(b.log, ["close:1006::false:reattach"]);
    assert.deepEqual(b.ws.closeCalls, []);

    const c = openSocket();
    c.socket.close();
    assert.equal(clock.waiting(), 0, "close() clears the limit");
    clock.tick(60_000);
    await flush();
    assert.deepEqual(c.log, []);
  } finally {
    clock.restore();
    removeFakes();
  }
});

test("input() says whether every chunk was sent: false while connecting, after a close, and after close(); a big paste is chunked", () => {
  installFakes();
  try {
    const { socket, ws } = openSocket();
    assert.equal(socket.input("typed while connecting"), false, "the socket is not open: the text did not go");
    assert.deepEqual(ws.sent, []);
    ws.open();
    assert.equal(socket.input("hi\r"), true);
    assert.deepEqual(ws.sent, [{ t: "in", d: "hi\r" }]);
    ws.sent.length = 0;
    assert.equal(socket.input("x".repeat(200_000)), true);
    assert.equal(ws.sent.length, 4);
    assert.equal(ws.sent.map((frame) => frame.d).join("").length, 200_000, "all of it went");
    for (const frame of ws.sent) assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= ss.MAX_IN_FRAME_BYTES);
    assert.equal(socket.input(""), true, "nothing to send, nothing lost");
    ws.sent.length = 0;
    ws.serverClose(1006, "");
    assert.equal(socket.input("after the close"), false);
    assert.deepEqual(ws.sent, []);

    const second = openSocket();
    second.ws.open();
    second.socket.close();
    assert.equal(second.socket.input("after close()"), false);
  } finally {
    removeFakes();
  }
});

test("focus() before the socket is open is sent when it opens, and the size follows it once", () => {
  installFakes();
  const clock = fakeClock();
  try {
    const { socket, ws } = openSocket();
    socket.focus();
    socket.resize(100, 30);
    ws.open();
    clock.tick(ss.RESIZE_DEBOUNCE_MS);
    assert.deepEqual(ws.sent, [{ t: "focus" }, { t: "resize", cols: 100, rows: 30 }]);
    ws.sent.length = 0;
    socket.resize(100, 30);
    clock.tick(200);
    assert.deepEqual(ws.sent, [], "the same size is not sent twice");
    socket.resize(1, 30);
    socket.resize(100, 999);
    clock.tick(200);
    assert.deepEqual(ws.sent, [], "sizes out of range are never sent");
  } finally {
    clock.restore();
    removeFakes();
  }
});

// ---------------------------------------------------------------------------
// Requests: words for a problem, and the quit check where sessions do not exist
// ---------------------------------------------------------------------------

test("sessionProblem and sessionGotNoAnswer: an unreadable answer is not 'couldn't reach Agent OS'", async () => {
  const UNREADABLE = "Agent OS gave an answer that could not be read.";
  const busy = new ApiError("session_busy", "This session is already being changed. Try again in a moment.", 409);
  assert.equal(api.sessionProblem(busy), "This session is already being changed. Try again in a moment.");
  assert.equal(api.sessionProblem(new ApiError("500 Server Error", "", 500)), "Agent OS couldn't do that. Try again.");
  assert.equal(api.sessionGotNoAnswer(busy), false, "an answer came");

  const timeout = new Error("Agent OS did not answer in time.");
  assert.equal(api.sessionProblem(timeout), "Agent OS did not answer in time.");
  assert.equal(api.sessionGotNoAnswer(timeout), true, "no answer: it may still have happened");
  const offline = new TypeError("Failed to fetch");
  assert.equal(api.sessionProblem(offline), "Couldn't reach Agent OS.");
  assert.equal(api.sessionGotNoAnswer(offline), true);

  // An answer came but could not be read: the words say so, and it is not "no answer".
  for (const unreadable of [new Error(UNREADABLE), new SyntaxError("Unexpected end of JSON input")]) {
    assert.equal(api.sessionProblem(unreadable), UNREADABLE);
    assert.equal(api.sessionGotNoAnswer(unreadable), false);
  }

  // The real paths into it: a 200 without a sessions array, and a 200 that is not JSON.
  try {
    fakeFetch(() => jsonAnswer(200, { environmentNotice: null }));
    const wrongShape = await api.listSessions().catch((error) => error);
    assert.ok(wrongShape instanceof Error);
    assert.equal(api.sessionProblem(wrongShape), UNREADABLE);
    assert.equal(api.sessionGotNoAnswer(wrongShape), false);
    fakeFetch(() => jsonAnswer(200, new SyntaxError("Unexpected token < in JSON")));
    const notJson = await api.listSessions().catch((error) => error);
    assert.equal(api.sessionProblem(notJson), UNREADABLE);
    assert.equal(api.sessionGotNoAnswer(notJson), false);
  } finally {
    removeFakes();
  }
});

test("quitCheckOrNone: where sessions do not exist (404 not_available) nothing can be running; every other failure still fails", async () => {
  try {
    const calls = fakeFetch(() => jsonAnswer(404, { error: "not_available", message: "Sessions are not available here." }));
    assert.deepEqual(await api.quitCheckOrNone(), { live: [] });
    assert.deepEqual(calls, [{ url: "/api/sessions/quit-check", method: "POST" }]);

    const live = [{ id: "a", title: "Claude Code · my-app", kind: "agent" }];
    fakeFetch(() => jsonAnswer(200, { live }));
    assert.deepEqual(await api.quitCheckOrNone(), { live }, "a real answer passes through");

    fakeFetch(() => jsonAnswer(404, { error: "no_such_route" }));
    await assert.rejects(api.quitCheckOrNone(), (error) => error instanceof ApiError && error.status === 404, "another 404 is not 'none running'");
    fakeFetch(() => jsonAnswer(500, { error: "boom" }));
    await assert.rejects(api.quitCheckOrNone(), (error) => error instanceof ApiError && error.status === 500);
    fakeFetch(() => jsonAnswer(403, { error: "not_available" }));
    await assert.rejects(api.quitCheckOrNone(), (error) => error instanceof ApiError && error.status === 403, "only a 404 means sessions do not exist");
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(api.quitCheckOrNone(), TypeError, "no answer is still 'could not check'");
  } finally {
    removeFakes();
  }
});
