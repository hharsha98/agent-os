// R32 on the page's side (src/sessionKey.ts, src/eventStream.ts, src/apiBlob.ts): the page keeps the page key the login
// claim answers with, in its own storage, and sends it as x-agent-os-key with every request to its own /api/ (and as
// a WebSocket subprotocol); the cookie alone is not enough on the server. Driven with a fake fetch and a fake
// localStorage; nothing here talks to a server. The server's half is in test/security.test.js and
// test/sessions-ws.test.js.
//
// These .ts files import their neighbours without a file extension (the Vite way), so a resolve hook adds .ts first,
// as test/sessions-api.test.js does.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
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

const key = await import("../src/sessionKey.ts");
const stream = await import("../src/eventStream.ts");
const blob = await import("../src/apiBlob.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "ab".repeat(32);

// ---- fakes ----------------------------------------------------------------------------------------------------------

class FakeStorage {
  constructor({ throws = false } = {}) {
    this.items = new Map();
    this.throws = throws;
  }
  getItem(name) {
    if (this.throws) throw new Error("storage blocked");
    return this.items.has(name) ? this.items.get(name) : null;
  }
  setItem(name, value) {
    if (this.throws) throw new Error("storage blocked");
    this.items.set(name, String(value));
  }
  removeItem(name) {
    if (this.throws) throw new Error("storage blocked");
    this.items.delete(name);
  }
}

const real = { fetch: globalThis.fetch, localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage") };
let calls;

function useStorage(storage) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
}

// A fake fetch that records [input, init] and answers with `answer(input, init)`.
function fakeFetch(answer) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push([input, init]);
    return answer ? answer(input, init) : new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

const headerOf = (call, name) => new Headers(call[1]?.headers).get(name);

beforeEach(() => {
  useStorage(new FakeStorage());
  key.clearPageKey();
  fakeFetch();
});

afterEach(() => {
  key.clearPageKey();
  globalThis.fetch = real.fetch;
  if (real.localStorage) Object.defineProperty(globalThis, "localStorage", real.localStorage);
  else delete globalThis.localStorage;
});

// ---- the shared helper ----------------------------------------------------------------------------------------------

test("apiFetch adds x-agent-os-key when a key is stored, and keeps the caller's headers, method and body", async () => {
  key.storePageKey(KEY);
  await key.apiFetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Other": "1" }, body: "{}" });
  const [input, init] = calls[0];
  assert.equal(input, "/api/sessions");
  assert.equal(headerOf(calls[0], "x-agent-os-key"), KEY);
  assert.equal(headerOf(calls[0], "content-type"), "application/json");
  assert.equal(headerOf(calls[0], "x-other"), "1");
  assert.equal(init.method, "POST");
  assert.equal(init.body, "{}");

  // Headers given as a Headers object or as pairs are kept the same way.
  await key.apiFetch("/api/x", { headers: new Headers({ "X-A": "a" }) });
  assert.equal(headerOf(calls[1], "x-a"), "a");
  assert.equal(headerOf(calls[1], "x-agent-os-key"), KEY);
  await key.apiFetch("/api/x", { headers: [["X-B", "b"]] });
  assert.equal(headerOf(calls[2], "x-b"), "b");
  assert.equal(headerOf(calls[2], "x-agent-os-key"), KEY);
  // No headers given at all.
  await key.apiFetch("/api/x");
  assert.equal(headerOf(calls[3], "x-agent-os-key"), KEY);
});

test("apiFetch sends nothing extra when no key is stored: it is exactly fetch(input, init)", async () => {
  const init = { method: "GET", headers: { Accept: "application/json" } };
  await key.apiFetch("/api/sessions", init);
  assert.equal(calls[0][0], "/api/sessions");
  assert.equal(calls[0][1], init, "the very same init object, untouched");
  await key.apiFetch("/api/sessions");
  assert.equal(calls[1][1], undefined);
});

test("apiFetch gives the key only to the app's own /api/ addresses, never to another site or another path", async () => {
  key.storePageKey(KEY);
  for (const address of [
    "https://evil.example/api/sessions",
    "http://127.0.0.1:9999/api/sessions",
    "//evil.example/api/sessions",
    "/not-api/sessions",
    "/API/sessions",
    "api/sessions",
    "/apiary"
  ]) {
    calls.length = 0;
    await key.apiFetch(address, { headers: { A: "1" } });
    assert.equal(headerOf(calls[0], "x-agent-os-key"), null, `${address}: no key`);
  }
});

test("the key is never put in the address: the request address is exactly what the caller gave", async () => {
  key.storePageKey(KEY);
  await key.apiFetch("/api/sessions?x=1");
  assert.equal(calls[0][0], "/api/sessions?x=1");
  assert.equal(String(calls[0][0]).includes(KEY), false);
});

test("storePageKey keeps only a non-empty string; readPageKey reads it back from the page's own storage; clearPageKey forgets it", () => {
  for (const bad of [undefined, null, "", 0, 12, {}, [], true]) assert.equal(key.storePageKey(bad), false, String(bad));
  assert.equal(key.readPageKey(), "");
  assert.equal(key.storePageKey(KEY), true);
  assert.equal(key.readPageKey(), KEY);
  assert.equal(globalThis.localStorage.getItem("agentos.pageKey"), KEY, "kept in localStorage");
  // A reload: the memory copy is gone, the stored one stays.
  key.clearPageKey();
  globalThis.localStorage.setItem("agentos.pageKey", "from-before-the-reload");
  assert.equal(key.readPageKey(), "from-before-the-reload");
  key.clearPageKey();
  assert.equal(key.readPageKey(), "");
  assert.equal(globalThis.localStorage.getItem("agentos.pageKey"), null);
});

test("a browser that blocks storage still works for this page (the key stays in memory), and nothing throws", async () => {
  useStorage(new FakeStorage({ throws: true }));
  assert.equal(key.storePageKey(KEY), true);
  assert.equal(key.readPageKey(), KEY);
  await key.apiFetch("/api/sessions");
  assert.equal(headerOf(calls[0], "x-agent-os-key"), KEY);
  key.clearPageKey();
  assert.equal(key.readPageKey(), "");
  // No localStorage object at all.
  delete globalThis.localStorage;
  assert.equal(key.readPageKey(), "");
  assert.equal(key.storePageKey(KEY), true);
  assert.equal(key.readPageKey(), KEY);
});

test("pageKeyProtocols offers the key as the subprotocol agent-os-key.<key>, or nothing without a key", () => {
  assert.equal(key.pageKeyProtocols(), undefined);
  key.storePageKey(KEY);
  assert.deepEqual(key.pageKeyProtocols(), [`agent-os-key.${KEY}`]);
});

// ---- the login claim --------------------------------------------------------------------------------------------------

test("claimSession posts the token, keeps the page key the server answers with, and says whether the token was accepted", async () => {
  fakeFetch(() => new Response(JSON.stringify({ ok: true, pageKey: KEY }), { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.equal(await key.claimSession("the-launch-token"), true);
  const [input, init] = calls[0];
  assert.equal(input, "/api/session/claim");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { token: "the-launch-token" });
  assert.equal(init.credentials, "same-origin");
  assert.equal(key.readPageKey(), KEY, "the key is stored");
  assert.equal(globalThis.localStorage.getItem("agentos.pageKey"), KEY);
  assert.equal(String(input).includes("the-launch-token"), false, "the token is in the body, not the address");
});

test("claimSession with a refused token stores nothing; with a network failure it throws; an answer without a key makes none up", async () => {
  fakeFetch(() => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 }));
  assert.equal(await key.claimSession("wrong"), false);
  assert.equal(key.readPageKey(), "");

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(() => key.claimSession("x"), TypeError);
  assert.equal(key.readPageKey(), "");

  // An answer that is not JSON, or has no key (an older server): accepted, but no key is made up.
  fakeFetch(() => new Response("not json", { status: 200 }));
  assert.equal(await key.claimSession("x"), true);
  assert.equal(key.readPageKey(), "");
});

// ---- the event stream (replaces EventSource, which cannot send the header) ------------------------------------------

function collect(feed) {
  const seen = [];
  const parser = stream.createSseParser((name, data) => seen.push([name, data]));
  for (const piece of feed) parser.push(piece);
  return seen;
}

test("the event stream parser: named and unnamed messages, several data lines, comments, other line endings, any chunking", () => {
  const text = 'id: 1\nevent: text\ndata: {"a":1}\n\n: keep-alive\n\ndata: plain\n\nevent: end\ndata: {}\n\nevent: multi\ndata: one\ndata: two\n\n';
  const expected = [
    ["text", '{"a":1}'],
    ["message", "plain"],
    ["end", "{}"],
    ["multi", "one\ntwo"]
  ];
  assert.deepEqual(collect([text]), expected, "whole");
  assert.deepEqual(collect([...text]), expected, "one character at a time");
  assert.deepEqual(collect([text.replace(/\n/g, "\r\n")]), expected, "CRLF line ends");
  assert.deepEqual(collect([...text.replace(/\n/g, "\r\n")]), expected, "CRLF, one character at a time (a split \\r\\n)");
  // A final "\r" waits for the next piece (it might be half of "\r\n"), so a comment line follows to flush it.
  assert.deepEqual(collect([text.replace(/\n/g, "\r") + ":flush\r"]), expected, "bare CR line ends");
  // A message with no data is not delivered; a message cut off before its blank line waits.
  assert.deepEqual(collect(["event: ping\n\n"]), []);
  assert.deepEqual(collect(["event: text\ndata: x\n"]), []);
  // "data:" with no space, and an empty data line.
  assert.deepEqual(collect(["data:tight\n\ndata:\n\n"]), [["message", "tight"], ["message", ""]]);
  // Unknown fields (id, retry) are ignored.
  assert.deepEqual(collect(["retry: 5\nid: 9\nfoo: bar\ndata: x\n\n"]), [["message", "x"]]);
});

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("openEventStream reads with the page key header, reports open and each message, and an 'end' the caller closes on is not an error", async () => {
  key.storePageKey(KEY);
  fakeFetch(() => streamResponse(['event: text\ndata: {"n":1}\n\n', "event: end\ndata: {}\n\n"]));
  const log = [];
  const source = stream.openEventStream("/api/runs/r1/stream", {
    onOpen: () => log.push("open"),
    onEvent: (name, data) => {
      log.push(`${name}:${data}`);
      if (name === "end") source.close();
    },
    onError: () => log.push("error")
  });
  await settle();
  assert.deepEqual(log, ["open", 'text:{"n":1}', "end:{}"]);
  assert.equal(calls[0][0], "/api/runs/r1/stream");
  assert.equal(headerOf(calls[0], "x-agent-os-key"), KEY, "the page key goes in the header");
  assert.equal(headerOf(calls[0], "accept"), "text/event-stream");
  assert.equal(String(calls[0][0]).includes(KEY), false, "and never in the address");
});

test("openEventStream calls onError once when the server refuses, the network fails, or the stream ends unasked; and never after close()", async () => {
  const run = async (answer) => {
    fakeFetch(answer);
    const log = [];
    stream.openEventStream("/api/runs/r1/stream", {
      onOpen: () => log.push("open"),
      onEvent: (name) => log.push(name),
      onError: () => log.push("error")
    });
    await settle();
    return log;
  };
  assert.deepEqual(await run(() => new Response('{"error":"session_required"}', { status: 401 })), ["error"], "refused (a cookie without the key)");
  assert.deepEqual(await run(() => new Response("{}", { status: 404 })), ["error"], "not found");
  assert.deepEqual(await run(() => Promise.reject(new TypeError("Failed to fetch"))), ["error"], "network failure");
  assert.deepEqual(await run(() => streamResponse(["event: text\ndata: {}\n\n"])), ["open", "text", "error"], "ended without an end event");
  assert.deepEqual(await run(() => streamResponse([])), ["open", "error"], "an empty stream");

  // Closed by the caller before the answer arrives: no event, no error.
  fakeFetch(
    (_input, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => resolve(streamResponse(["data: late\n\n"])), 20);
      })
  );
  const log = [];
  const source = stream.openEventStream("/api/runs/r1/stream", { onOpen: () => log.push("open"), onEvent: () => log.push("event"), onError: () => log.push("error") });
  source.close();
  await settle(60);
  assert.deepEqual(log, [], "close() silences everything");
});

// ---- blobs for things that cannot send a header ------------------------------------------------------------------------

test("fetchApiBlob sends the page key and throws on a refusal, so an <img>/<iframe> never shows an error page", async () => {
  key.storePageKey(KEY);
  fakeFetch(() => new Response("png bytes", { status: 200, headers: { "Content-Type": "image/png" } }));
  const file = await blob.fetchApiBlob("/api/workspace/raw?id=a");
  assert.equal(headerOf(calls[0], "x-agent-os-key"), KEY);
  assert.equal(file.type, "image/png", "the file's type is kept");
  assert.equal(await file.text(), "png bytes");
  fakeFetch(() => new Response('{"error":"session_required"}', { status: 401 }));
  await assert.rejects(() => blob.fetchApiBlob("/api/workspace/raw?id=a"), /401/);
});

test("R33: only inert types become a blob: address; an SVG becomes a data: address; every other type gets none", () => {
  const kind = blob.previewAddressKind;
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm", "application/pdf"]) {
    assert.equal(kind(type), "blob", type);
  }
  // Case and parameters do not change the answer.
  assert.equal(kind("IMAGE/PNG"), "blob");
  assert.equal(kind("application/pdf; charset=binary"), "blob");
  assert.equal(kind("Video/MP4"), "blob");
  assert.equal(kind("image/svg+xml"), "data");
  assert.equal(kind("image/svg+xml; charset=utf-8"), "data");
  assert.equal(kind("IMAGE/SVG+XML"), "data");
  assert.equal(kind(" image/svg+xml ;charset=utf-8"), "data");
  // Anything that can run a script, or that is not a known inert type, never gets an address.
  for (const type of [
    "text/html",
    "text/html; charset=utf-8",
    "TEXT/HTML",
    "application/xhtml+xml",
    "text/xml",
    "application/xml",
    "text/plain",
    "text/javascript",
    "application/javascript",
    "application/octet-stream",
    "image/bmp",
    "image/x-icon",
    "audio/",
    "video",
    "image/png+xml",
    "",
    undefined,
    null
  ]) {
    assert.equal(kind(type), "none", JSON.stringify(type));
  }
});

// ---- nothing in the page goes around the helper ------------------------------------------------------------------------

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the page's own source: every call to its server goes through apiFetch, the claim goes through claimSession, and the key is kept in one place", () => {
  const files = sourceFiles(path.join(root, "src"));
  const rel = (file) => path.relative(root, file).split(path.sep).join("/");
  const rawFetch = [];
  const eventSources = [];
  const sockets = [];
  const storageUsers = [];
  const keyInAddress = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (/(^|[^.\w])fetch\s*\(/.test(code)) rawFetch.push(rel(file));
    if (/new\s+EventSource\s*\(/.test(code)) eventSources.push(rel(file));
    if (/new\s+WebSocket\s*\(/.test(code)) sockets.push(rel(file));
    if (/agentos\.pageKey/.test(code)) storageUsers.push(rel(file));
    if (/[?&](key|pageKey|page_key|agent-os-key)=/i.test(code)) keyInAddress.push(rel(file));
  }
  // The only bare fetch calls: the helper itself, and the login claim it also owns.
  assert.deepEqual(rawFetch, ["src/sessionKey.ts"], "no page code calls fetch() directly; use apiFetch");
  assert.deepEqual(eventSources, [], "EventSource cannot send the header; use openEventStream");
  assert.deepEqual(sockets, ["src/sessionsApi.ts"], "the one WebSocket is the terminal's");
  assert.deepEqual(storageUsers, ["src/sessionKey.ts"], "the key's storage name appears in one place");
  assert.deepEqual(keyInAddress, [], "the key is never put in an address");

  const sessionsApi = readFileSync(path.join(root, "src/sessionsApi.ts"), "utf8");
  assert.match(sessionsApi, /pageKeyProtocols\(\)/, "the terminal's WebSocket offers the key as a subprotocol");
  assert.match(sessionsApi, /apiFetch\(sessionPath\(sessionId, "\/recording"\)/);
  for (const file of ["src/main.tsx", "src/LockedScreen.tsx"]) {
    assert.match(readFileSync(path.join(root, file), "utf8"), /claimSession\(/, `${file} claims through claimSession`);
  }
  // Every wrapper that used fetch() before now uses the helper.
  for (const file of ["src/api.ts", "src/AgentOSApp.tsx", "src/ApiGuidePage.tsx", "src/eventStream.ts", "src/apiBlob.ts"]) {
    assert.match(readFileSync(path.join(root, file), "utf8"), /apiFetch\(/, `${file} uses apiFetch`);
  }
  // Things that cannot send a header are not pointed straight at a gated address.
  const preview = readFileSync(path.join(root, "src/ui/components/WorkspacePreview.tsx"), "utf8");
  assert.doesNotMatch(stripComments(preview), /src=\{rawUrl\}/, "the preview shows a blob: address, not the gated raw address");
});

test("R33: a downloaded copy is re-typed as opaque bytes, and the locked HTML preview draws the text with srcDoc, never an address", () => {
  const code = stripComments(readFileSync(path.join(root, "src/apiBlob.ts"), "utf8"));
  assert.match(code, /new Blob\(\[blob\], \{ type: "application\/octet-stream" \}\)/, "saveApiFile re-types the blob before making its address");
  const preview = stripComments(readFileSync(path.join(root, "src/ui/components/WorkspacePreview.tsx"), "utf8"));
  const frame = preview.match(/<iframe[^>]*sandbox=""[^>]*\/>/);
  assert.ok(frame, "the locked HTML frame is there");
  assert.match(frame[0], /srcDoc=/);
  assert.doesNotMatch(frame[0], /\ssrc=/, "the locked frame has no src");
});
